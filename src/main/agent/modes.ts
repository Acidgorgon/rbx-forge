// Chat modes in main: tool gating per mode (Ask / Plan never write), the SDK options of each mode,
// the edit approval flow (diff cards, Accept / Reject per hunk), plan capture (plan cards) and the
// agent's task list (/todos). ChatManager calls into ChatModes at a few points; everything else
// lives here. No Electron imports (tested directly).
//
// SDK facts (node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts, v0.3.296):
//   PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'
//   "'plan' - Planning mode, no execution of tools"; "'acceptEdits' - Auto-accept file edit operations".
//   Options.planModeInstructions replaces the plan-mode workflow body (the CLI keeps its read-only
//   preamble and the ExitPlanMode footer); ExitPlanModeInput (sdk-tools.d.ts) carries the plan.
//   Options.disallowedTools removes tools from the model's context; PreToolUse hooks may return
//   permissionDecision 'deny', which applies in every permission mode.

import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { AgentDefinition, CanUseTool, HookCallbackMatcher, Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { ChatMessage } from '@shared/types'
import type { HarnessContext } from '../context.ts'
import { applyHunks, diffCard, isReadOnlyMode, PLAN_FORMAT, planCard, type ChatMode, type ChatTodo, type CheckpointInfo, type DiffCardData, type PlanCardData } from '../../shared/chatModes.ts'
import { defineTool, type GentreeTool, type ToolResult } from './tools.ts'
import { summarizeInput, SYSTEM_PROMPT } from './sdk.ts'
import { withRules } from './projectRules.ts'

export const READ_BUILTINS = ['Read', 'Glob', 'Grep'] as const
export const EDIT_BUILTINS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const
export const SHELL_BUILTINS = ['Bash'] as const
// Change only the chat's own state: allowed in every mode.
export const CHAT_STATE_TOOLS = ['update_todos'] as const
// Ask the user themselves before running (terminal confirm), so no second approval card.
export const SELF_CONFIRMING_TOOLS = ['run_in_terminal'] as const

// The Agent SDK's built-in subagent tool: 'Agent' (sdk-tools.d.ts AgentInput); the CLI still
// accepts its older name 'Task' as an alias, so both are gated the same way.
export const SUBAGENT_TOOLS = ['Agent', 'Task'] as const
// Named subagents that only read; the only ones Ask / Plan may start.
export const READ_SUBAGENTS = ['explorer', 'reviewer'] as const

const GENTREE = 'gentree'

// Fields ChatManager's stored chat carries for modes (StoredChat extends this).
export interface ModeChatFields {
  mode?: ChatMode
  // Next turn starts a fresh SDK session / history seeded with this text ('' = nothing): set by
  // /clear, /compact and /rewind.
  seed?: string
  todos?: ChatTodo[]
  checkpoints?: CheckpointInfo[]
}

export interface ModeChat extends ModeChatFields {
  id: string
  messages: ChatMessage[]
}

// Splits "mcp__server__tool" into server and bare name ("Edit" -> { bare: 'Edit' }).
export function splitToolName(name: string): { server?: string; bare: string } {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? { server: m[1], bare: m[2] } : { bare: name }
}

// The read-safe tool names for gating: gentree read tools + chat-state tools + group host tools.
export interface ToolCatalog {
  read: Set<string>
}

export function toolCatalog(readTools: { name: string }[], extraSafe: string[] = []): ToolCatalog {
  return { read: new Set([...readTools.map((t) => t.name), ...CHAT_STATE_TOOLS, ...extraSafe]) }
}

export type ToolVerdict = 'allow' | 'approve' | 'deny'

// What a mode does with a tool call. Read modes allow only known read tools (deny by default: an
// unknown or new tool can never write in Ask / Plan). Edit asks for everything that is not a read
// tool; Auto allows (project bounds are still checked by chatPermissions and the hook).
export function classifyTool(mode: ChatMode, name: string, catalog: ToolCatalog): ToolVerdict {
  const { server, bare } = splitToolName(name)
  const isRead = server === undefined ? (READ_BUILTINS as readonly string[]).includes(bare) : server === GENTREE && catalog.read.has(bare)
  const bareRead = server === undefined && catalog.read.has(bare) && !(EDIT_BUILTINS as readonly string[]).includes(bare) && bare !== 'Bash'
  if (isRead || bareRead) return 'allow'
  if (isReadOnlyMode(mode)) return mode === 'plan' && name === 'ExitPlanMode' ? 'allow' : 'deny'
  if (mode === 'auto') return 'allow'
  if ((SELF_CONFIRMING_TOOLS as readonly string[]).includes(bare) && (server === undefined || server === GENTREE)) return 'allow'
  return 'approve'
}

export function denyMessage(mode: ChatMode, name: string): string {
  const bare = splitToolName(name).bare
  if (mode === 'plan') return `Writes are not allowed in Plan mode: ${bare} is not available. Read and search only, then present the plan.`
  return `Writes are not allowed in Ask mode; switch to Edit or Auto to change files. (${bare} is not available.)`
}

// OpenAI-compatible loop: a read mode leaves write tools out of the request, but a model may still
// call one. A known tool the mode removed (or a built-in edit) gets denyMessage instead of the bare
// "unknown tool"; a name nobody knows stays unknown.
export function refuseRemovedTool(mode: ChatMode, known: Iterable<string>): (name: string) => string | undefined {
  if (!isReadOnlyMode(mode)) return () => undefined
  const names = new Set(known)
  return (name) => {
    const { bare } = splitToolName(name)
    return names.has(bare) || (EDIT_BUILTINS as readonly string[]).includes(bare) || bare === 'Bash' ? denyMessage(mode, bare) : undefined
  }
}

export function isSubagentTool(name: string): boolean {
  return (SUBAGENT_TOOLS as readonly string[]).includes(name)
}

// Why a subagent call is refused in this mode, or undefined when it may start. Subagents inherit
// the chat's gating (canUseTool, the PreToolUse guard, bounds), so the call itself only needs:
// no isolation (worktree / remote would leave the project), and read-only agents in Ask / Plan.
export function subagentDenial(mode: ChatMode, input: Record<string, unknown>): string | undefined {
  if (input.isolation !== undefined) return 'Subagents run in this project with the chat\'s own permissions; call Agent again without isolation.'
  if (!isReadOnlyMode(mode)) return undefined
  const type = typeof input.subagent_type === 'string' ? input.subagent_type : ''
  if ((READ_SUBAGENTS as readonly string[]).includes(type)) return undefined
  return `In ${mode === 'plan' ? 'Plan' : 'Ask'} mode only the read-only subagents (${READ_SUBAGENTS.join(', ')}) can run; set subagent_type to one of them.`
}

const SUBAGENT_NOTE_EDIT =
  '\n\n# Subagents\nYou can start subagents with the Agent tool (subagent_type explorer: read-only search; builder: implements one scoped change; reviewer: read-only review). Several Agent calls in one message run in parallel: use them for independent work (e.g. explore three systems at once, or build parts that touch different files), not for one small edit. Give each a self-contained prompt (files, goal, constraints); they do not see this conversation. Their edits go through the same approvals and project bounds as yours. Summarize what they found or changed.'
const SUBAGENT_NOTE_READ =
  '\n\n# Subagents\nYou can start read-only subagents with the Agent tool (subagent_type explorer: search the codebase; reviewer: review code). Several Agent calls in one message run in parallel; give each a self-contained question. They cannot change anything in this mode either.'

// System prompt note per mode (appended after the rules block, so the cached prefix stays).
// `sdk`: the Anthropic Agent SDK path, which also has subagents.
export function modeNote(mode: ChatMode, sdk: boolean): string {
  if (mode === 'ask') return '\n\n# Mode: Ask\nRead-only. Answer the question; read and search as needed. You cannot change files or run commands in this mode, so do not offer edits as done.' + (sdk ? SUBAGENT_NOTE_READ : '')
  if (mode === 'plan') {
    return sdk
      ? '\n\n# Mode: Plan\nRead-only investigation, then a plan for the user to approve.' + SUBAGENT_NOTE_READ
      : `\n\n# Mode: Plan\nInvestigate read-only (you cannot change anything in this mode), then reply with a plan for the user to approve; do not start the work.\n${PLAN_FORMAT}`
  }
  return sdk ? SUBAGENT_NOTE_EDIT : ''
}

// Named subagents for the SDK (Options.agents). Read-only ones get an explicit read tool list;
// the builder inherits the chat's tools (and so its approvals) but cannot start more subagents.
// Each prompt carries the project layout and the project's own rules (AGENTS.md, aiRules), since
// a subagent does not see the chat's system prompt.
export function chatSubagents(mode: ChatMode, readServerTools: string[], rules = ''): Record<string, AgentDefinition> {
  const base = withRules(SYSTEM_PROMPT, rules)
  const read = [...READ_BUILTINS, ...readServerTools.filter((n) => !(CHAT_STATE_TOOLS as readonly string[]).includes(n)).map((n) => `mcp__${GENTREE}__${n}`)]
  const agents: Record<string, AgentDefinition> = {
    explorer: {
      description: 'Read-only codebase search: where something lives, how a system works, which files a change would touch. Returns paths, line ranges and a short summary. Start several in parallel for independent questions.',
      tools: read,
      disallowedTools: [...SUBAGENT_TOOLS],
      prompt: `You are an explorer subagent: search and read only, never change anything. Answer the question you were given with file paths, line ranges and a concise summary of what you found. Read only the ranges you need.\n\n${base}`
    },
    reviewer: {
      description: 'Read-only review of a change or a set of files: bugs, broken Feature / Rojo / Blink wiring, and violations of the project rules (AGENTS.md, aiRules). Returns findings with file:line, most severe first.',
      tools: read,
      disallowedTools: [...SUBAGENT_TOOLS],
      prompt: `You are a reviewer subagent: read only, never change anything. Review what you were pointed at for real bugs, wiring mistakes (Init/Start order, Blink events, Rojo paths) and violations of the project instructions below. Report findings as file:line with a one-line fix each, most severe first; say plainly when you found nothing.\n\n${base}`
    }
  }
  if (!isReadOnlyMode(mode)) {
    agents.builder = {
      description: 'Implements one scoped change (a feature part, or files no other running builder touches). Give it the exact files, the goal and the constraints. Its edits go through the same approvals and project bounds as yours.',
      disallowedTools: [...SUBAGENT_TOOLS],
      prompt: `You are a builder subagent: implement exactly the change you were given, in the existing style, and nothing else. Stay inside the files you were assigned; other builders may be editing other files at the same time. Follow the project instructions below strictly (they override your habits, e.g. a "no comments in game scripts" rule). When done, reply with the files you changed and one line each on what changed.\n\n${base}`
    }
  }
  return agents
}

// Plan-mode workflow body for the SDK (Options.planModeInstructions).
export const PLAN_MODE_INSTRUCTIONS = `Investigate the GenTree project with the read-only tools (project_map, find_symbol, search_code, read_script). Do not change anything. When you understand the change, call ExitPlanMode with the plan.\n${PLAN_FORMAT}`

// ---------------------------------------------------------------- SDK options per mode

export interface SdkModeInput {
  mode: ChatMode
  catalog: ToolCatalog
  // Every gentree tool name the server exposes (read + write), for explicit allow / deny lists.
  serverTools: string[]
  allowBash: boolean
  studio: boolean
  // Project bounds (chatPermissions).
  bounds: CanUseTool
  // Edit mode: asks the person (diff card) and resolves allow / deny.
  approve: (name: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<PermissionResult>
  // Plan mode: the agent called ExitPlanMode with this plan.
  onPlan: (plan: string) => void
  // Project rules block (projectRules.ts), carried into the subagents' prompts.
  rules?: string
}

export function sdkModeOptions(o: SdkModeInput): Pick<Options, 'permissionMode' | 'tools' | 'allowedTools' | 'disallowedTools' | 'canUseTool' | 'hooks' | 'planModeInstructions' | 'agents'> {
  const { mode, catalog } = o
  const ro = isReadOnlyMode(mode)
  const writeServer = o.serverTools.filter((n) => !catalog.read.has(n))
  const readServer = o.serverTools.filter((n) => catalog.read.has(n))
  const mcp = (n: string) => `mcp__${GENTREE}__${n}`
  // 'Agent' (subagents) in every mode: read modes only get the read-only agents (subagentDenial).
  const tools: string[] = ro ? [...READ_BUILTINS, 'Agent', ...(mode === 'plan' ? ['ExitPlanMode'] : [])] : [...READ_BUILTINS, 'Edit', 'Write', 'Agent', ...(o.allowBash ? ['Bash'] : [])]
  const allowedTools =
    mode === 'auto'
      ? [`mcp__${GENTREE}`, `mcp__${GENTREE}__*`, ...READ_BUILTINS, ...(o.studio ? ['mcp__studio', 'mcp__studio__*'] : [])]
      : [...readServer.map(mcp), ...READ_BUILTINS, ...(mode === 'edit' ? SELF_CONFIRMING_TOOLS.map(mcp) : [])]
  const disallowedTools = ro ? [...EDIT_BUILTINS, ...SHELL_BUILTINS, ...writeServer.map(mcp), 'mcp__studio', 'NotebookEdit'] : undefined

  const canUseTool: CanUseTool = async (name, input, opts) => {
    if (name === 'ExitPlanMode') {
      if (mode !== 'plan') return { behavior: 'deny', message: 'Not in plan mode.' }
      const plan = typeof input.plan === 'string' ? input.plan : ''
      if (plan.trim()) o.onPlan(plan)
      return { behavior: 'deny', message: 'Forge showed your plan to the user as a card (Approve & run / Edit plan / Keep planning). Stop here and wait; do not repeat the plan.' }
    }
    // Starting a subagent needs no card: each tool call it makes comes back through here.
    if (isSubagentTool(name)) {
      const why = subagentDenial(mode, input)
      return why ? { behavior: 'deny', message: why } : { behavior: 'allow', updatedInput: input }
    }
    const verdict = classifyTool(mode, name, catalog)
    if (verdict === 'deny') return { behavior: 'deny', message: denyMessage(mode, name) }
    // Built-in file tools and Bash: project bounds / allowBash first.
    if (!splitToolName(name).server) {
      const b = await o.bounds(name, input, opts)
      if (b?.behavior === 'deny') return b
    }
    if (verdict === 'approve') return o.approve(name, input, opts.signal)
    return { behavior: 'allow', updatedInput: input }
  }

  // Hard guard in every mode (hooks run whatever the permission mode decides): read modes deny
  // anything that is not a read tool; built-in edits stay inside the project and out of Packages/.
  const guard: HookCallbackMatcher = {
    hooks: [
      async (hi) => {
        if (hi.hook_event_name !== 'PreToolUse') return {}
        const name = hi.tool_name
        const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason } })
        if (isSubagentTool(name)) {
          const why = subagentDenial(mode, (hi.tool_input ?? {}) as Record<string, unknown>)
          return why ? deny(why) : {}
        }
        if (ro && classifyTool(mode, name, catalog) === 'deny') return deny(denyMessage(mode, name))
        if ((EDIT_BUILTINS as readonly string[]).includes(name)) {
          const b = await o.bounds(name, (hi.tool_input ?? {}) as Record<string, unknown>, { signal: new AbortController().signal } as any)
          if (b?.behavior === 'deny') return deny(b.message)
        }
        return {}
      }
    ]
  }

  return {
    permissionMode: mode === 'plan' ? 'plan' : mode === 'auto' ? 'acceptEdits' : 'default',
    ...(mode === 'plan' ? { planModeInstructions: PLAN_MODE_INSTRUCTIONS } : {}),
    tools,
    allowedTools,
    ...(disallowedTools ? { disallowedTools } : {}),
    canUseTool,
    hooks: { PreToolUse: [guard] },
    agents: chatSubagents(mode, readServer, o.rules)
  }
}

// ---------------------------------------------------------------- OpenAI-compatible loop

// Tool list for one turn: read modes keep only read tools; Edit wraps every other tool in the
// approval flow; Auto passes them through.
export function gateOpenAiTools(
  mode: ChatMode,
  tools: GentreeTool<any>[],
  catalog: ToolCatalog,
  approve: (name: string, input: Record<string, unknown>) => Promise<{ run: true } | { run: false; result: ToolResult }>
): GentreeTool<any>[] {
  const out: GentreeTool<any>[] = []
  for (const t of tools) {
    const v = classifyTool(mode, `mcp__${GENTREE}__${t.name}`, catalog)
    if (v === 'deny') continue
    if (v === 'allow') {
      out.push(t)
      continue
    }
    out.push({
      ...t,
      handler: async (args: any, extra: unknown) => {
        const d = await approve(t.name, args ?? {})
        return d.run ? t.handler(args, extra) : d.result
      }
    })
  }
  return out
}

// ---------------------------------------------------------------- edit proposals

export interface EditProposal {
  path: string
  before: string | null
  after: string
}

function relPath(root: string, file: string): string | null {
  const abs = isAbsolute(file) ? file : resolve(root, file)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

function replaceOnce(text: string, oldS: string, newS: string, all = false): string | null {
  if (!oldS) return null
  if (all) return text.split(oldS).join(newS)
  const i = text.indexOf(oldS)
  if (i < 0) return null
  return text.slice(0, i) + newS + text.slice(i + oldS.length)
}

// What a file tool would write: the before / after of the file, or null when it is not a file edit
// (or cannot be worked out, e.g. old_string not found: the tool itself will report that).
export async function proposeEdit(name: string, input: Record<string, unknown>, root: string, read: (rel: string) => Promise<string>): Promise<EditProposal | null> {
  const bare = splitToolName(name).bare
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  const file = bare === 'write_script' || bare === 'edit_script' ? str('path') : str('file_path')
  if (!file) return null
  const path = bare === 'write_script' || bare === 'edit_script' ? file.trim().replace(/\\/g, '/').replace(/^\.\//, '') : relPath(root, file)
  if (!path) return null
  const before = await read(path).catch(() => null)
  if (bare === 'Write' || bare === 'write_script') {
    const after = str('content') ?? str('contents')
    return after === undefined ? null : { path, before, after }
  }
  if (before === null) return null
  if (bare === 'Edit' || bare === 'edit_script') {
    const after = replaceOnce(before, str('old_string') ?? '', str('new_string') ?? '', input.replace_all === true)
    return after === null ? null : { path, before, after }
  }
  if (bare === 'MultiEdit' && Array.isArray(input.edits)) {
    let after: string | null = before
    for (const e of input.edits as Record<string, unknown>[]) {
      after = after === null ? null : replaceOnce(after, String(e?.old_string ?? ''), String(e?.new_string ?? ''), e?.replace_all === true)
    }
    return after === null ? null : { path, before, after }
  }
  return null
}

// ---------------------------------------------------------------- todos tool

export function todoTool(get: () => ModeChat | null, changed: (chat: ModeChat) => void): GentreeTool<any> {
  return defineTool(
    'update_todos',
    'Keep a short task list for multi-step work (the user sees it with /todos). Send the whole list each time; mark one item in_progress while you work on it and done when finished.',
    { todos: z.array(z.object({ text: z.string().min(1).max(200), state: z.enum(['pending', 'in_progress', 'done']) })).max(30) },
    async (args) => {
      const chat = get()
      if (!chat) return { content: [{ type: 'text', text: 'no chat' }], isError: true }
      chat.todos = args.todos.map((t: ChatTodo) => ({ text: t.text, state: t.state }))
      changed(chat)
      const done = chat.todos.filter((t) => t.state === 'done').length
      return { content: [{ type: 'text', text: `todos: ${done}/${chat.todos.length} done` }] }
    }
  )
}

export function formatTodos(todos: ChatTodo[] | undefined): string {
  if (!todos?.length) return 'No tasks yet. The agent keeps a task list here for multi-step work.'
  const mark = { pending: '[ ]', in_progress: '[~]', done: '[x]' } as const
  return todos.map((t) => `- ${mark[t.state]} ${t.text}`).join('\n')
}

// ---------------------------------------------------------------- runtime

export type ReviewDecision = { accept: boolean; hunks?: number[]; note?: string }

export interface ModeHost {
  ctx: HarnessContext
  find(id: string): ModeChat | undefined
  push(chat: ModeChat, m: ChatMessage): void
}

// Per-ChatManager state: edits waiting for a decision and plans captured during a turn.
export class ChatModes {
  private host: ModeHost
  private waiting = new Map<string, { chatId: string; resolve: (d: ReviewDecision) => void }>()
  private plans = new Map<string, string>()

  constructor(host: ModeHost) {
    this.host = host
  }

  // Cards left pending by a previous run (app closed mid-approval) are expired.
  expireStale(chats: ModeChat[]): void {
    for (const c of chats) for (const m of c.messages) if (m.diff?.state === 'pending') m.diff = { ...m.diff, state: 'expired' }
  }

  // The turn ended while cards still waited (the query stopped or crashed without aborting them):
  // they are expired and their waiters get "stopped", so nothing applies a late Accept.
  expireWaiting(chatId: string): void {
    for (const [id, w] of [...this.waiting]) {
      if (w.chatId !== chatId) continue
      this.waiting.delete(id)
      const chat = this.host.find(chatId)
      const m = chat?.messages.find((x) => x.id === id)
      if (chat && m?.diff?.state === 'pending') this.host.push(chat, { ...m, diff: { ...m.diff, state: 'expired' } })
      w.resolve({ accept: false, note: 'stopped' })
    }
  }

  pendingReviews(chatId: string): number {
    return [...this.waiting.values()].filter((w) => w.chatId === chatId).length
  }

  // Posts a diff card (or an action card) and waits for the person.
  async review(chat: ModeChat, name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<{ decision: ReviewDecision; card: DiffCardData; proposal: EditProposal | null }> {
    const root = this.host.ctx.project()?.root ?? ''
    const proposal = await proposeEdit(name, input, root, (p) => this.host.ctx.readFile(p))
    const bare = splitToolName(name).bare
    const card: DiffCardData = proposal ? diffCard(proposal.path, bare, proposal.before, proposal.after) : { path: '', tool: bare, action: summarizeInput(input), hunks: [], added: 0, removed: 0, state: 'pending' }
    const id = randomUUID()
    const text = proposal ? `${bare} ${proposal.path} (+${card.added} −${card.removed})` : `${bare} ${card.action ?? ''}`
    const msg: ChatMessage = { id, role: 'assistant', text, at: Date.now(), agentId: 'main', diff: card }
    this.host.push(chat, msg)
    const decision = await new Promise<ReviewDecision>((resolve) => {
      if (signal?.aborted) return resolve({ accept: false, note: 'stopped' })
      this.waiting.set(id, { chatId: chat.id, resolve })
      signal?.addEventListener('abort', () => this.decide(chat.id, id, { accept: false, note: 'stopped' }).catch(() => undefined), { once: true })
    })
    return { decision, card, proposal }
  }

  // The person's answer to a diff card.
  async decide(chatId: string, messageId: string, d: ReviewDecision): Promise<void> {
    const w = this.waiting.get(messageId)
    const chat = this.host.find(chatId)
    const m = chat?.messages.find((x) => x.id === messageId)
    if (!w || !chat || !m?.diff) throw new Error('that change is no longer waiting')
    this.waiting.delete(messageId)
    const ids = m.diff.hunks.map((h) => h.id)
    const accepted = d.accept ? (Array.isArray(d.hunks) && !m.diff.whole ? d.hunks.filter((h) => ids.includes(h)) : ids) : []
    const state = !d.accept || (!accepted.length && ids.length) ? 'rejected' : accepted.length === ids.length ? 'accepted' : 'partial'
    this.host.push(chat, { ...m, diff: { ...m.diff, state, ...(state === 'partial' ? { accepted } : {}) } })
    w.resolve({ ...d, accept: state !== 'rejected', hunks: accepted })
  }

  // SDK canUseTool approval: allow as is, deny, or apply the accepted hunks here and tell the model.
  async approveSdk(chat: ModeChat, name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<PermissionResult> {
    const r = await this.review(chat, name, input, signal)
    return this.outcome<PermissionResult>(r, () => ({ behavior: 'allow', updatedInput: input }), (message) => ({ behavior: 'deny', message }))
  }

  // OpenAI loop: run the tool, or return the result for a rejected / partly applied change.
  async approveOpenAi(chat: ModeChat, name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<{ run: true } | { run: false; result: ToolResult }> {
    const r = await this.review(chat, name, input, signal)
    return this.outcome<{ run: true } | { run: false; result: ToolResult }>(
      r,
      () => ({ run: true as const }),
      (message, partial) => ({ run: false as const, result: { content: [{ type: 'text' as const, text: message }], ...(partial ? {} : { isError: true }) } })
    )
  }

  private async outcome<T>(r: { decision: ReviewDecision; card: DiffCardData; proposal: EditProposal | null }, allow: () => T, deny: (message: string, partial?: boolean) => T): Promise<T> {
    const { decision, card, proposal } = r
    const note = decision.note && decision.note !== 'stopped' ? ` They said: ${decision.note}` : ''
    if (!decision.accept) return deny(decision.note === 'stopped' ? 'The user stopped the turn.' : `The user rejected this change.${note} Do not retry it unchanged; ask or try a different approach.`)
    const all = card.hunks.map((h) => h.id)
    const hunks = decision.hunks ?? all
    if (!proposal || hunks.length === all.length) return allow()
    // Partial: write the accepted hunks ourselves (works for every file tool and provider).
    const merged = applyHunks(proposal.before ?? '', card.hunks, hunks)
    await this.host.ctx.writeFile(proposal.path, merged)
    return deny(`The user accepted ${hunks.length} of ${all.length} hunks of this change to ${proposal.path} (hunks ${hunks.join(', ')}); Forge applied those and rejected the rest. The file on disk now has the accepted version: read it again before editing it further.${note}`, true)
  }

  // ---- plan mode

  capturePlan(chatId: string, plan: string): void {
    this.plans.set(chatId, plan)
  }

  // After a Plan-mode turn: the plan card (from ExitPlanMode, else the turn's last answer).
  finishPlanTurn(chat: ModeChat, fromIndex: number): ChatMessage | null {
    const captured = this.plans.get(chat.id)
    this.plans.delete(chat.id)
    let text = captured ?? ''
    if (!text.trim()) {
      for (let i = chat.messages.length - 1; i >= fromIndex; i--) {
        const m = chat.messages[i]
        if (m.role === 'assistant' && !m.planMode && !m.diff && m.agentId === 'main' && m.text.trim()) {
          text = m.text
          break
        }
      }
    }
    if (!text.trim()) return null
    for (const m of chat.messages) if (m.planMode?.state === 'pending') this.host.push(chat, { ...m, planMode: { ...m.planMode, state: 'superseded' } })
    const card: PlanCardData = planCard(text)
    const msg: ChatMessage = { id: randomUUID(), role: 'assistant', text: card.text, at: Date.now(), agentId: 'main', planMode: card, mode: 'plan' }
    this.host.push(chat, msg)
    return msg
  }
}
