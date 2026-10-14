// Slash command handlers (Claude Code's set mapped onto Forge). ChatManager.command() calls
// run(); every handler works on the chat through CommandHost, so tests drive them with a real
// ChatManager over a fake context. Output is posted in the chat as a command message (role system,
// `command` set: shown as a box, never sent to a model) and returned to the renderer, together
// with an action for things only the UI can do (open a page, show a picker).

import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import type { ChatMessage, ChatSession, EffortChoice, GroupUsage, ModelChoice, ProviderId } from '@shared/types'
import type { HarnessContext } from '../../context.ts'
import { BUILTIN_COMMANDS, commandInfo, expandCommand, isBuiltin, type ChatCommandInfo, type ChatCommandResult, type CustomCommand } from '../../../shared/chatCommands.ts'
import { CHAT_MODES, isReadOnlyMode, modeLabel, type ChatMode, type CheckpointInfo, type RewindWhat } from '../../../shared/chatModes.ts'
import { isEffortChoice } from '../../../shared/modelCaps.ts'
import { isProviderId } from '../providers.ts'
import { resolveModel } from '../../../shared/modelResolve.ts'
import { estimateTokens, formatTokens } from '../budget/tokens.ts'
import { SUMMARY_INSTRUCTIONS } from '../budget/compact.ts'
import { Checkpoints } from '../checkpoints.ts'
import { classifyTool, formatTodos, READ_BUILTINS, type ModeChat, type ToolCatalog } from '../modes.ts'
import { loadCustomCommands } from './custom.ts'
import { extractNotes, INIT_PROMPT, mergeNotes, NOTES_FILE } from './notes.ts'

export interface CmdChat extends ModeChat {
  title: string
  createdAt: number
  provider?: ProviderId
  model?: string
  effort?: string
  sdkSessionId?: string
  oaiHistory?: unknown[]
  usage?: GroupUsage[]
}

export interface GatingCostRow {
  lab: string
  runs: number
  kept: number
  costUsd: number
  costPerKept: number | null
  saved: number
}

export interface CommandHost {
  ctx: HarnessContext
  find(id: string): CmdChat | undefined
  push(chat: CmdChat, m: ChatMessage): void
  updated(chat: CmdChat): void
  list(): ChatSession[]
  choice(chat: CmdChat): ModelChoice
  busy(id: string): boolean
  send(id: string, text: string, opts: { mode?: ChatMode; display?: string }): Promise<void>
  setModel(id: string, provider: ProviderId, model: string): void
  setEffort(id: string, effort: EffortChoice): void
  models(): Promise<ModelChoice[]>
  // Session usage from the meter ledger (tokens + USD), when there is a meter.
  meterTotals?(id: string): { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; requests: number } | null
  dayCost?(): number
  gating?(): Promise<GatingCostRow[] | null>
  // System prompt + rules/memory block of the chat agent (for /context).
  systemPrompt(chat: CmdChat, mode: ChatMode): Promise<{ base: string; rules: string }>
  tools(mode: ChatMode): { names: string[]; schemaTokens: number; catalog: ToolCatalog }
  allowBash(): boolean
  remember?(note: string): Promise<unknown>
  oneShot?(system: string, prompt: string): Promise<string>
  userCommandsDir?: string
  onTurnEnd(chatId: string, fn: (chat: CmdChat, fromIndex: number) => Promise<void> | void): void
  checkpoints?(root: string): Checkpoints
  gitDiff?(root: string): Promise<string>
}

const MAX_DIFF_CHARS = 60_000

export function gitDiffText(root: string): Promise<string> {
  const git = (args: string[]) =>
    new Promise<string>((resolve) => execFile('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, out) => resolve(err ? '' : String(out))))
  return Promise.all([git(['diff', 'HEAD', '--no-color', '--no-ext-diff']), git(['ls-files', '--others', '--exclude-standard'])]).then(([diff, untracked]) => {
    const extra = untracked.trim() ? `\n\nUntracked files:\n${untracked.trim()}` : ''
    return (diff + extra).trim()
  })
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'chat'
}

const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`)

// Visible conversation as plain text (tool calls as one-line notes), for /compact and /export.
export function conversationText(messages: ChatMessage[], opts: { tools?: boolean } = {}): string {
  const out: string[] = []
  for (const m of messages) {
    if (m.command || m.diff || m.role === 'system') continue
    if (m.role === 'tool') {
      if (opts.tools !== false) out.push(`(tool ${m.tool?.name ?? ''} ${m.tool?.input ?? ''})`.trim())
      continue
    }
    const who = m.role === 'user' ? 'User' : m.speaker ? m.speaker.label : 'Assistant'
    if (m.text.trim()) out.push(`${who}: ${m.text.trim()}`)
  }
  return out.join('\n\n')
}

export function exportMarkdown(chat: CmdChat, choice: ModelChoice): string {
  const lines = [`# ${chat.title}`, '', `Exported from RBX Forge · ${choice.provider}/${choice.model} · ${new Date(chat.createdAt).toISOString().slice(0, 16).replace('T', ' ')}`, '']
  for (const m of chat.messages) {
    if (m.command) continue
    if (m.role === 'user') lines.push(`## You${m.mode ? ` (${modeLabel(m.mode)})` : ''}`, '', m.text, '')
    else if (m.role === 'tool') lines.push(`> tool: \`${m.tool?.name ?? ''}\` ${m.tool?.input ?? ''}`, '')
    else if (m.role === 'system') lines.push(`> ${m.text.replace(/\n/g, '\n> ')}`, '')
    else if (m.diff) lines.push(`> ${m.diff.tool} ${m.diff.path || m.diff.action || ''}: ${m.diff.state} (+${m.diff.added} −${m.diff.removed})`, '')
    else lines.push(`## ${m.speaker?.label ?? 'Assistant'}${m.planMode ? ' (plan)' : ''}`, '', m.text, '')
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

export class ChatCommands {
  private host: CommandHost

  constructor(host: CommandHost) {
    this.host = host
  }

  async list(): Promise<ChatCommandInfo[]> {
    const custom = await this.custom()
    return [...BUILTIN_COMMANDS.map((c) => ({ ...c, source: 'builtin' as const })), ...custom.map(commandInfo)]
  }

  custom(): Promise<CustomCommand[]> {
    return loadCustomCommands(this.host.ctx.project()?.root ?? null, this.host.userCommandsDir).catch(() => [])
  }

  // Posts the command line and its output in the chat.
  private say(chat: CmdChat, name: string, args: string, text: string): void {
    this.host.push(chat, { id: randomUUID(), role: 'system', text, at: Date.now(), agentId: 'main', command: `/${name}${args ? ` ${args}` : ''}` })
  }

  async run(id: string, rawName: string, args = ''): Promise<ChatCommandResult> {
    const chat = this.host.find(id)
    if (!chat) throw new Error(`unknown chat ${id}`)
    const name = String(rawName ?? '').replace(/^\//, '').toLowerCase()
    args = String(args ?? '').trim()
    const reply = (text: string, extra: Omit<ChatCommandResult, 'text'> = {}): ChatCommandResult => {
      this.say(chat, name, args, text)
      return { text, ...extra }
    }
    const busyGuard = () => {
      if (this.host.busy(id)) throw new Error('the chat is busy; stop it first')
    }
    switch (name) {
      case 'help':
        return reply(await this.help())
      case 'clear': {
        busyGuard()
        chat.messages.length = 0
        chat.sdkSessionId = undefined
        chat.oaiHistory = undefined
        chat.todos = undefined
        chat.seed = ''
        this.host.updated(chat)
        this.say(chat, name, args, 'Conversation cleared. The next message starts fresh (files are unchanged; /rewind still has the checkpoints).')
        return { text: 'cleared', action: { kind: 'selectChat', id } }
      }
      case 'compact':
        busyGuard()
        return reply(await this.compact(chat, args))
      case 'ask':
      case 'plan': {
        if (!args) return reply(`Add the message after /${name}, e.g. /${name} ${name === 'ask' ? 'how does ModuleLoader start services?' : 'add a daily reward system'}.`)
        busyGuard()
        await this.host.send(id, args, { mode: name })
        return { started: true }
      }
      case 'model':
        return this.model(chat, args, reply)
      case 'effort': {
        if (!args) return reply(`Effort: ${chat.effort ?? 'auto'}. Use /effort auto|low|medium|high|xhigh|max.`)
        const e = args.toLowerCase()
        if (!isEffortChoice(e)) return reply(`Unknown effort "${args}". Use auto, low, medium, high, xhigh or max.`)
        this.host.setEffort(id, e)
        return reply(`Effort set to ${e} for this chat.`)
      }
      case 'cost':
        return reply(await this.cost(chat))
      case 'context':
        return reply(await this.context(chat))
      case 'memory': {
        if (!args) return { action: { kind: 'openPage', page: 'memory' } }
        if (!this.host.remember) return reply('Memory is not available.')
        await this.host.remember(args)
        return reply(`Saved to project memory: “${args.slice(0, 120)}”`)
      }
      case 'init':
        busyGuard()
        return this.init(chat, reply)
      case 'review':
        busyGuard()
        return this.review(chat, args, reply)
      case 'resume': {
        const others = this.host.list().filter((c) => c.id !== id)
        if (args) {
          const q = args.toLowerCase()
          const hit = others.find((c) => c.title.toLowerCase() === q) ?? others.find((c) => c.title.toLowerCase().includes(q))
          if (hit) return { action: { kind: 'selectChat', id: hit.id } }
        }
        return { action: { kind: 'pickChat', chats: others.slice(0, 40).map((c) => ({ id: c.id, title: c.title, model: c.model, ...(c.lastAt ? { lastAt: c.lastAt } : {}) })) } }
      }
      case 'rewind': {
        const list = (chat.checkpoints ?? []).slice().reverse()
        if (!list.length) return reply('No checkpoints in this chat yet. One is taken before each turn that can edit files (Edit and Auto-accept modes).')
        return { action: { kind: 'pickCheckpoint', checkpoints: list.map((c) => ({ id: c.id, label: c.label, at: c.at })) } }
      }
      case 'todos':
        return reply(formatTodos(chat.todos))
      case 'permissions':
        return reply(this.permissions(chat))
      case 'export':
        return reply(await this.export(chat))
      case 'new':
        return { action: { kind: 'newChat' } }
    }
    // Custom commands.
    const custom = (await this.custom()).find((c) => c.name === name)
    if (custom) {
      busyGuard()
      await this.host.send(id, expandCommand(custom.body, args), { ...(custom.mode ? { mode: custom.mode } : {}), display: `/${name}${args ? ` ${args}` : ''}` })
      return { started: true }
    }
    if (isBuiltin(name)) return reply(`/${name} runs in the composer.`)
    return reply(`Unknown command /${name}. Type /help for the list.`)
  }

  private async help(): Promise<string> {
    const custom = await this.custom()
    const row = (c: ChatCommandInfo) => `- \`/${c.name}${c.args ? ` ${c.args}` : ''}\` ${c.description}`
    const modes = CHAT_MODES.map((m) => `- **${m.label}**: ${m.hint}`).join('\n')
    let out = `**Modes** (Shift+Tab cycles)\n${modes}\n\n**Commands**\n${BUILTIN_COMMANDS.map(row).join('\n')}`
    out += custom.length
      ? `\n\n**Custom commands**\n${custom.map((c) => row(commandInfo(c)) + ` _(${c.source})_`).join('\n')}`
      : `\n\nCustom commands: add markdown files to \`.forge/commands/\` (project) or the user commands folder; \`$ARGUMENTS\` is replaced by what you type after the command.`
    return out
  }

  private async model(chat: CmdChat, args: string, reply: (t: string, e?: Omit<ChatCommandResult, 'text'>) => ChatCommandResult): Promise<ChatCommandResult> {
    const cur = this.host.choice(chat)
    if (!args) return { text: `${cur.provider}/${cur.model}`, action: { kind: 'pickModel' } }
    const all = await this.host.models()
    const slash = args.indexOf('/')
    let pick: ModelChoice | undefined
    if (slash > 0) {
      const p = args.slice(0, slash) as ProviderId
      const m = args.slice(slash + 1)
      pick = all.find((c) => c.provider === p && c.model === m) ?? (isProviderId(p) && m.trim() ? { provider: p, model: m.trim() } : undefined)
    }
    if (!pick) {
      const r = resolveModel(args, all, cur)
      if (r.kind === 'ambiguous') return reply(`Which one? ${r.options.slice(0, 6).map((o) => `\`${o.provider}/${o.model}\``).join(', ')}`)
      if (r.kind === 'ok') pick = r.choice
    }
    if (!pick) return reply(`No model matches “${args}”. Use /model with no arguments to pick one.`, { action: { kind: 'pickModel' } })
    this.host.setModel(chat.id, pick.provider, pick.model)
    return reply(`Model: ${pick.provider}/${pick.model} for this chat.`)
  }

  private async compact(chat: CmdChat, focus: string): Promise<string> {
    const text = conversationText(chat.messages)
    if (!text.trim()) return 'Nothing to compact yet.'
    if (!this.host.oneShot) return 'Compaction needs a model; set one up in Settings.'
    const before = estimateTokens(text)
    const summary = (await this.host.oneShot(SUMMARY_INSTRUCTIONS + (focus ? `\nFocus on: ${focus}` : ''), text)).trim()
    if (!summary) return 'The summary came back empty; nothing changed.'
    const after = estimateTokens(summary)
    chat.seed = `Summary of the conversation so far (compacted with /compact):\n${summary}`
    chat.sdkSessionId = undefined
    chat.oaiHistory = undefined
    this.host.updated(chat)
    return `Compacted: ~${formatTokens(before)} → ~${formatTokens(after)} tokens (saved ~${formatTokens(Math.max(0, before - after))}). The next message continues from this summary:\n\n${summary}`
  }

  private async cost(chat: CmdChat): Promise<string> {
    const lines: string[] = ['**This chat**']
    const t = this.host.meterTotals?.(chat.id)
    if (t && t.requests) {
      lines.push(`- ${t.requests} requests · input ${formatTokens(t.input)} · output ${formatTokens(t.output)} · cache read ${formatTokens(t.cacheRead)} · cache write ${formatTokens(t.cacheWrite)}`, `- cost ${usd(t.costUsd)}`)
    }
    for (const r of chat.usage ?? []) lines.push(`- ${r.label}: ${formatTokens(r.input)} in / ${formatTokens(r.output)} out over ${r.calls} call${r.calls === 1 ? '' : 's'}`)
    if (lines.length === 1) lines.push('- no usage yet')
    const day = this.host.dayCost?.()
    if (day !== undefined) lines.push('', `**Today** ${usd(day)}`)
    const gating = await this.host.gating?.().catch(() => null)
    if (gating?.length) {
      lines.push('', '**Labs (gating: cost per kept result)**')
      for (const g of gating) lines.push(`- ${g.lab}: ${g.runs} runs, ${g.kept} kept, ${usd(g.costUsd)}${g.costPerKept !== null ? ` · ${usd(g.costPerKept)} per kept` : ''}${g.saved ? ` · gates saved ~${formatTokens(g.saved)} tokens` : ''}`)
    }
    return lines.join('\n')
  }

  private async context(chat: CmdChat): Promise<string> {
    const mode = chat.mode ?? 'edit'
    const { base, rules } = await this.host.systemPrompt(chat, mode)
    const tools = this.host.tools(mode)
    const conv = conversationText(chat.messages)
    const images = chat.messages.reduce((n, m) => n + (m.images?.length ?? 0), 0)
    const rows: [string, number][] = [
      ['System prompt', estimateTokens(base)],
      ['Project rules + memory', estimateTokens(rules)],
      [`Tools (${tools.names.length})`, tools.schemaTokens],
      [chat.seed ? 'Compacted summary' : 'Conversation', estimateTokens(chat.seed ?? '') + (chat.seed !== undefined ? 0 : estimateTokens(conv))]
    ]
    const total = rows.reduce((n, r) => n + r[1], 0)
    const c = this.host.choice(chat)
    const out = [`**Context** · ${c.provider}/${c.model} · ${modeLabel(mode)} mode · ~${formatTokens(total)} tokens (estimate)`, '']
    for (const [label, n] of rows) out.push(`- ${label}: ~${formatTokens(n)} (${total ? Math.round((100 * n) / total) : 0}%)`)
    if (images) out.push(`- Images: ${images} attached (counted by the provider)`)
    if (chat.sdkSessionId) out.push('', 'Claude keeps the full session (tool results included) on its side; /compact shrinks it.')
    out.push('', `Tools: ${tools.names.join(', ')}`)
    return out.join('\n')
  }

  private permissions(chat: CmdChat): string {
    const mode = chat.mode ?? 'edit'
    const tools = this.host.tools('auto')
    const allow: string[] = []
    const approve: string[] = []
    const deny: string[] = []
    for (const n of [...READ_BUILTINS, 'Edit', 'Write', ...tools.names.map((x) => `mcp__gentree__${x}`), 'mcp__studio__*', ...(this.host.allowBash() ? ['Bash'] : [])]) {
      const v = classifyTool(mode, n, tools.catalog)
      const bare = n.replace(/^mcp__gentree__/, '')
      const label = bare === 'mcp__studio__*' ? 'Studio tools' : `\`${bare}\``
      ;(v === 'allow' ? allow : v === 'approve' ? approve : deny).push(label)
    }
    const out = [`**${modeLabel(mode)}** mode`, '', `**Runs without asking:** ${allow.join(', ') || '—'}`]
    if (!isReadOnlyMode(mode)) out.push('', `**Asks you first:** ${approve.length ? approve.join(', ') : mode === 'auto' ? 'nothing (auto-accept)' : '—'}`)
    out.push('', `**Blocked:** ${deny.length ? deny.join(', ') : '—'}${this.host.allowBash() ? '' : ', Bash (off in Settings)'}`)
    out.push('', 'Always: edits stay inside the project, never Packages/ (Wally); run_in_terminal asks in the terminal panel.')
    return out.join('\n')
  }

  private async export(chat: CmdChat): Promise<string> {
    const md = exportMarkdown(chat, this.host.choice(chat))
    const path = `.forge/exports/${slug(chat.title)}-${new Date().toISOString().slice(0, 10)}.md`
    if (!this.host.ctx.project()) return md
    await this.host.ctx.writeFile(path, md)
    return `Saved \`${path}\` (${md.split('\n').length} lines).`
  }

  private async init(chat: CmdChat, reply: (t: string, e?: Omit<ChatCommandResult, 'text'>) => ChatCommandResult): Promise<ChatCommandResult> {
    if (!this.host.ctx.project()) return reply('Open a project first.')
    this.say(chat, 'init', '', `Investigating the project (read-only), then writing ${NOTES_FILE}. An existing file is merged, never overwritten; the root AGENTS.md is not touched.`)
    this.host.onTurnEnd(chat.id, async (c, from) => {
      const answer = [...c.messages.slice(from)].reverse().find((m) => m.role === 'assistant' && !m.diff && !m.planMode && m.text.trim())?.text ?? ''
      const notes = extractNotes(answer)
      if (!notes) return this.say(c, 'init', '', 'No notes came back; nothing was written.')
      const existing = await this.host.ctx.readFile(NOTES_FILE).catch(() => null)
      const { text, added } = mergeNotes(existing, notes)
      if (existing !== null && text === existing) return this.say(c, 'init', '', `${NOTES_FILE} already has all of it; nothing changed.`)
      await this.host.ctx.writeFile(NOTES_FILE, text)
      this.say(c, 'init', '', existing === null ? `Wrote ${NOTES_FILE}. Forge adds it to every agent's instructions.` : `Merged ${added} new line${added === 1 ? '' : 's'} into ${NOTES_FILE} (existing notes kept as they were).`)
    })
    await this.host.send(chat.id, INIT_PROMPT, { mode: 'ask', display: '/init' })
    return { started: true }
  }

  private async review(chat: CmdChat, focus: string, reply: (t: string, e?: Omit<ChatCommandResult, 'text'>) => ChatCommandResult): Promise<ChatCommandResult> {
    const root = this.host.ctx.project()?.root
    if (!root) return reply('Open a project first.')
    let diff = await (this.host.gitDiff ?? gitDiffText)(root)
    if (!diff.trim()) return reply('No uncommitted changes to review.')
    if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS) + `\n…[diff truncated; ${diff.length - MAX_DIFF_CHARS} more chars: read the files for the rest]`
    const prompt = `Review the current uncommitted changes of this Roblox (Luau, Rojo) project${focus ? `, focusing on: ${focus}` : ''}. Look for bugs, Luau pitfalls (nil access, yields in the wrong place, client/server trust), missed cases and anything against the project rules. Read surrounding code when needed. List findings by severity with file:line, then a one-line verdict. Do not change files.\n\n\`\`\`diff\n${diff}\n\`\`\``
    await this.host.send(chat.id, prompt, { mode: 'ask', display: `/review${focus ? ` ${focus}` : ''}` })
    return { started: true }
  }

  // ---- checkpoints (/rewind)

  // Taken before a turn that may edit. Failures (no git) are logged, never block the turn.
  async checkpoint(chat: CmdChat, userMessage: ChatMessage | undefined): Promise<void> {
    const root = this.host.ctx.project()?.root
    if (!root || !userMessage || !this.host.checkpoints) return
    // One per user message (a cross-check fix turn reuses the message's checkpoint).
    if (chat.checkpoints?.some((c) => c.messageId === userMessage.id)) return
    try {
      const cps = this.host.checkpoints(root)
      const commit = await cps.create(`before: ${userMessage.text.slice(0, 80)}`)
      const list = (chat.checkpoints ??= [])
      list.push({ id: randomUUID(), at: Date.now(), messageId: userMessage.id, label: userMessage.text.replace(/\s+/g, ' ').slice(0, 80) || '(message)', commit })
      // Older ones fall off the list; their snapshots are dropped from the shadow repo too.
      if (list.length > 50) await cps.drop(list.splice(0, list.length - 50).map((c) => c.commit)).catch(() => undefined)
    } catch (e) {
      this.host.ctx.log({ service: 'agent', stream: 'stderr', text: `checkpoint skipped: ${(e as Error).message}` })
    }
  }

  async rewind(id: string, checkpointId: string, what: RewindWhat = 'both'): Promise<{ files: string[]; removed: number }> {
    const chat = this.host.find(id)
    if (!chat) throw new Error(`unknown chat ${id}`)
    if (this.host.busy(id)) throw new Error('the chat is busy; stop it first')
    const cps = chat.checkpoints ?? []
    const cp: CheckpointInfo | undefined = cps.find((c) => c.id === checkpointId)
    if (!cp) throw new Error('checkpoint not found')
    let files: string[] = []
    if (what !== 'chat') {
      const root = this.host.ctx.project()?.root
      if (!root || !this.host.checkpoints) throw new Error('no project open')
      files = (await this.host.checkpoints(root).restore(cp.commit)).files
    }
    let removed = 0
    if (what !== 'files') {
      const at = chat.messages.findIndex((m) => m.id === cp.messageId)
      if (at >= 0) {
        removed = chat.messages.length - at
        chat.messages.splice(at)
      }
      // Checkpoints after this one belong to removed turns.
      chat.checkpoints = cps.filter((c) => c.at < cp.at)
      const root = this.host.ctx.project()?.root
      const gone = cps.filter((c) => c.at >= cp.at).map((c) => c.commit)
      if (root && this.host.checkpoints && gone.length) await this.host.checkpoints(root).drop(gone).catch(() => undefined)
      chat.sdkSessionId = undefined
      chat.oaiHistory = undefined
      const transcript = conversationText(chat.messages, { tools: false })
      chat.seed = transcript ? `Earlier in this conversation:\n${transcript.slice(-12_000)}` : ''
    }
    const parts = [what !== 'chat' ? `${files.length} file${files.length === 1 ? '' : 's'} restored` : '', what !== 'files' ? `conversation rewound (${removed} message${removed === 1 ? '' : 's'} removed)` : ''].filter(Boolean)
    this.say(chat, 'rewind', '', `Rewound to before “${cp.label}”: ${parts.join(', ')}.${files.length ? `\n\n${files.slice(0, 30).map((f) => `- ${f}`).join('\n')}` : ''}`)
    this.host.updated(chat)
    return { files, removed }
  }
}
