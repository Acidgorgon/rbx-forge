// Shared pieces for building Agent SDK queries: settings, the system prompt, Studio MCP config,
// and mapping SDK messages to ChatMessages.

import { randomUUID } from 'node:crypto'
import type { McpStdioServerConfig, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatMessage } from '@shared/types'
import type { HarnessContext } from '../context.ts'
import { bundledClaudeExecutable } from '../services/sdkBinary.ts'
import { extractImageMarkers, imageMarker } from './chatImages.ts'
import { classifyAuthError, isAuthError } from '../accounts/authErrors.ts'
import { modelLabel } from '../../shared/modelResolve.ts'

export const DEFAULT_MODEL = 'claude-opus-5-5'
export const STUDIO_SERVER = 'studio'

// The query function, injectable for tests. Defaults to the SDK's query(), loaded lazily.
// A prompt with images uses the SDK's streaming input (an iterable of SDKUserMessage).
export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>

export const sdkQuery: QueryFn = (params) => {
  // Lazy import keeps the SDK out of module load for code paths that never query.
  const iter = async function* () {
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    yield* query(params)
  }
  return iter()
}

// Packaged builds: the SDK's CLI binary is unpacked outside app.asar (see services/sdkBinary.ts).
export function executableOption(): Pick<Options, 'pathToClaudeCodeExecutable'> {
  const exe = bundledClaudeExecutable()
  return exe ? { pathToClaudeCodeExecutable: exe } : {}
}

export interface StudioMcpSetting {
  command: string
  args: string[]
}

export function model(ctx: HarnessContext): string {
  return ctx.getSetting<string>('model', DEFAULT_MODEL) || DEFAULT_MODEL
}

// Roblox Studio's MCP server (external stdio process), when the user configured one.
export function studioMcp(ctx: HarnessContext): McpStdioServerConfig | null {
  const s = ctx.getSetting<StudioMcpSetting | null>('studioMcp', null)
  if (!s || typeof s.command !== 'string' || !s.command.trim()) return null
  return { type: 'stdio', command: s.command, args: Array.isArray(s.args) ? s.args : [] }
}

// Allow rules for every tool of an MCP server. Claude Code permission rules accept the bare
// server name ("mcp__server") as "all tools from this server"; the SDK docs also list
// "mcp__server__*" as a server-level spec, so both are given.
export function allowServer(server: string): string[] {
  return [`mcp__${server}`, `mcp__${server}__*`]
}

export const SYSTEM_PROMPT = `You are the coding assistant inside the GenTree dev harness for a Roblox game built with Rojo.

Project layout (Rojo, see default.project.json):
- src/shared -> ReplicatedStorage.Shared; src/server -> ServerScriptService.Server; src/client -> StarterPlayer.StarterPlayerScripts.Client; src/ServerStorage -> ServerStorage. Packages/ -> ReplicatedStorage.Packages (Wally; never edit).
- Features: src/shared/Features/<Name> holds the shared config for a feature. src/server/Features/<Name> is its server Service. src/client/Client/Controllers/<Name>Controller is its client Controller. Creating the shared folder (new_feature) makes the ./dev watcher scaffold the Service and Controller; deleting it removes them. Server-only Features live only in src/server/Features.
- ModuleLoader requires every Service/Controller, calls module:Init(janitor) on all, then module:Start() on all. Put cross-module wiring in Start, not Init.
- Networking uses Blink: events are declared in events.blink at the repo root; ./dev regenerates src/shared/events/client.luau and server.luau from it, so edit events.blink, never those generated files.
- Scripts are Luau (.luau). *.server.luau = Script, *.client.luau = LocalScript, others = ModuleScript; init.luau makes the folder the script.

Working rules:
- Prefer the gentree tools (mcp__gentree__*); they are cheaper than generic file tools. Orient with project_map (or project_overview); locate code with find_symbol / search_code (explorer_tree / find_instance for instances); read only the line ranges you need with read_script from/to; edit_script for small changes, write_script for new files.
- Networking: blink_events lists events, add_blink_event adds one (compile-checked), blink_check validates events.blink. Packages: wally_search / wally_info, add_wally_package. Rename a feature only with rename_feature (it moves the shared, server and client parts together).
- Test logic headless first: run_tests (Lune, seconds, no Studio) after changing a module, create_spec for untested modules.
- For questions about how the game is doing (players, retention, revenue, acquisition), call analytics_overview first, then drill down with analytics_series / acquisition_report.
- Users paste Roblox paths like game.ReplicatedStorage.Assets.Sword or game:GetService("Workspace").Map; resolve them with find_instance or explorer_tree. Nodes marked * exist only in Studio (assets, models, sounds, GUIs), not in the repo.
- Never edit Packages/ or generated files. Keep edits minimal and in the existing style.
- Studio edits sync back into the repo via studio-sync; conflicts are listed by studio_conflicts.
- If mcp__studio__* tools are available they act on the live Roblox Studio (run Luau, play tests).
- A message may end with [Confirmed restatement ...]: Forge restated a big request and the user approved (or corrected) that reading. Treat it as the agreed goal, problem and assumptions; do not restate it again, start the work.
- Big multi-file features (a new system with server, client, UI and data parts): suggest the user run /team <request>. Team mode is a separate run where a lead plans the work and specialist agents build the parts in parallel, with its own progress board; it suits large builds, while a focused change is faster right here.
- In a group chat, the other models (guests) are read-only advisers the user invited; they comment and critique, you own the project and make the edits.
- Be concise in replies.`

// Appended to SYSTEM_PROMPT on OpenAI-compatible providers, where tools have bare names.
export const OPENAI_TOOLS_NOTE = `
On this provider the gentree tools are named without the mcp__gentree__ prefix (project_overview, read_script, edit_script, ...). There are no generic file tools, no shell and no Studio tools.`

// Short, one-line summary of a tool call's input for the UI.
export function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    let s = typeof v === 'string' ? v : JSON.stringify(v)
    if (s === undefined) continue
    s = s.replace(/\s+/g, ' ')
    if (s.length > 60) s = s.slice(0, 57) + '...'
    parts.push(`${k}=${s}`)
    if (parts.join(' ').length > 160) break
  }
  return parts.join(' ').slice(0, 200)
}

// Strips the mcp__server__ prefix for display.
export function displayToolName(name: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name)
  return m ? (m[1] === 'gentree' ? m[2] : `${m[1]}:${m[2]}`) : name
}

function msg(agentId: string, role: ChatMessage['role'], text: string, tool?: ChatMessage['tool']): ChatMessage {
  return { id: randomUUID(), role, text, at: Date.now(), agentId, ...(tool ? { tool } : {}) }
}

const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task'])
const SUMMARY_CAP = 4000

// The text a subagent returned, without the CLI's bookkeeping trailer (<usage>, agentId lines).
export function subagentSummary(content: unknown): string {
  const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.map((c: any) => (c?.type === 'text' ? String(c.text ?? '') : '')) : []
  let text = parts.join('\n')
  text = text.replace(/<usage>[\s\S]*?(<\/usage>|$)/g, '').replace(/^agentId: .*$/gm, '')
  text = text.replace(/\n{3,}/g, '\n\n').trim()
  return text.length > SUMMARY_CAP ? text.slice(0, SUMMARY_CAP - 3).trimEnd() + '...' : text
}

// One chip per subagent for a query: created from the Agent tool_use, updated in place (same
// message id) while the subagent calls tools, and given the subagent's summary when it returns.
// The subagent's own messages (parent_tool_use_id set) never become chat messages themselves.
export class SubagentChips {
  private chips = new Map<string, { msg: ChatMessage; desc: string; tools: number }>()

  start(toolUseId: string, input: Record<string, unknown>, agentId: string): ChatMessage {
    const type = typeof input.subagent_type === 'string' && input.subagent_type.trim() ? input.subagent_type.trim() : 'general'
    const desc = typeof input.description === 'string' && input.description.trim() ? input.description.trim().replace(/\s+/g, ' ').slice(0, 120) : summarizeInput({ prompt: input.prompt })
    const name = `agent:${type}`
    const chip = msg(agentId, 'tool', '', { name, input: desc })
    this.chips.set(toolUseId, { msg: chip, desc, tools: 0 })
    return chip
  }

  // A subagent's tool calls: the chip shows how many so far.
  progress(parentId: string, calls: number): ChatMessage | null {
    const c = this.chips.get(parentId)
    if (!c || !calls) return null
    c.tools += calls
    c.msg = { ...c.msg, tool: { name: c.msg.tool!.name, input: `${c.desc} · ${c.tools} tool call${c.tools === 1 ? '' : 's'}` } }
    return c.msg
  }

  finish(toolUseId: string, content: unknown, isError: boolean): ChatMessage | null {
    const c = this.chips.get(toolUseId)
    if (!c) return null
    this.chips.delete(toolUseId)
    const summary = subagentSummary(content)
    c.msg = { ...c.msg, text: isError ? `Error: ${summary || 'subagent failed'}` : summary || 'Done (no summary).' }
    return c.msg
  }
}

// Maps one SDK message to zero or more ChatMessages. Subagent traffic (parent_tool_use_id set)
// only updates that subagent's chip (`subs`); without `subs` it is skipped.
// opts.model: the model the turn ran on (named when the account cannot use it).
export function toChatMessages(m: SDKMessage, agentId: string, subs?: SubagentChips, opts: { model?: string } = {}): ChatMessage[] {
  if (m.type === 'assistant') {
    if (m.parent_tool_use_id) {
      const calls = (m.message.content as any[]).filter((b) => b?.type === 'tool_use').length
      const chip = subs?.progress(m.parent_tool_use_id, calls)
      return chip ? [chip] : []
    }
    const out: ChatMessage[] = []
    if (m.error) out.push(msg(agentId, 'system', errorText(m.error, m.message?.content as unknown, opts.model)))
    const text: string[] = []
    for (const block of m.message.content as any[]) {
      if (block.type === 'text' && block.text?.trim()) text.push(block.text)
      else if (block.type === 'tool_use') {
        if (text.length) out.push(msg(agentId, 'assistant', text.splice(0).join('\n')))
        if (subs && SUBAGENT_TOOL_NAMES.has(block.name) && block.id) {
          out.push(subs.start(block.id, (block.input ?? {}) as Record<string, unknown>, agentId))
          continue
        }
        const name = displayToolName(block.name)
        out.push(msg(agentId, 'tool', name, { name, input: summarizeInput(block.input) }))
      }
    }
    if (text.length && !m.error) out.push(msg(agentId, 'assistant', text.join('\n')))
    return out
  }
  // Tool results are not shown, except images a tool produced (forge-image markers).
  if (m.type === 'user' && !m.parent_tool_use_id && Array.isArray((m.message as any)?.content)) {
    const ids: { id: string; name?: string }[] = []
    const chips: ChatMessage[] = []
    for (const block of (m.message as any).content as any[]) {
      if (block?.type !== 'tool_result') continue
      const chip = subs?.finish(block.tool_use_id, block.content, block.is_error === true)
      if (chip) {
        chips.push(chip)
        continue
      }
      const parts = typeof block.content === 'string' ? [block.content] : Array.isArray(block.content) ? block.content.map((c: any) => (c?.type === 'text' ? c.text : '')) : []
      for (const t of parts) for (const x of extractImageMarkers(String(t ?? '')).ids) if (!ids.some((y) => y.id === x.id)) ids.push(x)
    }
    return [...chips, ...(ids.length ? [msg(agentId, 'assistant', ids.map((x) => imageMarker(x)).join('\n'))] : [])]
  }
  if (m.type === 'result' && (m.is_error || m.subtype !== 'success')) {
    const detail = m.subtype === 'success' ? m.result : m.errors?.join('; ') || m.subtype
    // The assistant message already carried a friendly auth error; don't repeat the raw one.
    if (isAuthError(String(detail ?? ''))) return []
    // A 403 on this model without the CLI's auth wording: say so instead of the raw error.
    if (classifyAuthError(String(detail ?? ''), (m as { api_error_status?: unknown }).api_error_status) === 'rejected') return [msg(agentId, 'system', modelRejectedHelp(opts.model))]
    return [msg(agentId, 'system', `Error: ${detail}`)]
  }
  if (m.type === 'auth_status' && m.error) return [msg(agentId, 'system', `Auth: ${m.error}`)]
  return []
}

export const AUTH_HELP = 'Claude sign-in failed or expired. Open Settings > Accounts and click Sign in with Claude (or use an API key there).'

export { isAuthError }

// A 403 on one model (classifyAuthError 'rejected'): the account cannot use it, the sign-in is fine.
export function modelRejectedHelp(model?: string): string {
  const name = model?.trim() ? (/^claude-/.test(model.trim()) ? `${modelLabel(model.trim())} (${model.trim()})` : model.trim()) : 'this model'
  return `Your account can't use ${name}. Pick another model in the model menu.`
}

// The chat message for an Anthropic auth-shaped error, or null when it is not one: a per-model
// 403 names the model; a real auth failure (401, expired / revoked sign-in) gets the sign-in help.
export function authHelpFor(text: string, model?: string, status?: unknown): string | null {
  const kind = classifyAuthError(text, status)
  if (kind === 'rejected') return modelRejectedHelp(model)
  if (kind === 'auth' && isAuthError(text)) return AUTH_HELP
  return null
}

// Both texts above, for "already shown" checks.
export function isAuthHelp(text: string): boolean {
  return text === AUTH_HELP || /^Your account can't use .+\. Pick another model in the model menu\.$/.test(text)
}

// content: the assistant message's blocks (the CLI puts the API error text there).
function errorText(code: string, content?: unknown, model?: string): string {
  switch (code) {
    case 'authentication_failed': {
      const text = Array.isArray(content) ? content.map((c: any) => (c?.type === 'text' ? String(c.text ?? '') : '')).join(' ') : ''
      return classifyAuthError(text) === 'rejected' ? modelRejectedHelp(model) : AUTH_HELP
    }
    case 'billing_error':
      return 'Billing error on the Anthropic account.'
    case 'rate_limit':
      return 'Rate limited; try again shortly.'
    case 'model_not_found':
      return 'Model not found; check the "model" setting.'
    default:
      return `API error: ${code}`
  }
}

export function systemMessage(agentId: string, text: string): ChatMessage {
  return msg(agentId, 'system', text)
}

export function userMessage(agentId: string, text: string): ChatMessage {
  return msg(agentId, 'user', text)
}
