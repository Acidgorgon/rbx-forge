// Chat slash commands: the built-in set (Claude Code's commands mapped onto Forge), parsing, and
// custom commands from markdown files (.forge/commands/*.md in the project, userData/commands/*.md
// for the person), with $ARGUMENTS / $1..$9 like Claude Code's custom slash commands.
// Pure: shared by main (handlers) and the renderer (typeahead).

import type { ChatMode } from './chatModes.ts'

// ui: the renderer handles it alone; main: ChatManager / command handlers; prompt: becomes a message.
export type CommandKind = 'ui' | 'main' | 'prompt'

export interface ChatCommandInfo {
  name: string
  description: string
  // Shown after the name in the menu ("<instructions>").
  args?: string
  kind: CommandKind
  // Custom commands: where the file lives.
  source?: 'builtin' | 'project' | 'user'
  path?: string
}

export const BUILTIN_COMMANDS: ChatCommandInfo[] = [
  { name: 'help', description: 'list commands', kind: 'main' },
  { name: 'new', description: 'new thread', kind: 'ui' },
  { name: 'clear', description: 'clear this conversation (start fresh, same chat)', kind: 'main' },
  { name: 'compact', description: 'summarize the conversation and continue from the summary', args: '[focus]', kind: 'main' },
  { name: 'ask', description: 'send one message in Ask mode (read-only)', args: '<question>', kind: 'prompt' },
  { name: 'plan', description: 'send one message in Plan mode (plan card, nothing written)', args: '<request>', kind: 'prompt' },
  { name: 'model', description: 'switch model / provider for this chat', args: '[provider/model]', kind: 'main' },
  { name: 'effort', description: 'set reasoning effort', args: '[auto|low|medium|high|xhigh|max]', kind: 'main' },
  { name: 'cost', description: 'tokens and cost of this session (and Labs cost per kept)', kind: 'main' },
  { name: 'context', description: 'what is in the context window', kind: 'main' },
  { name: 'memory', description: 'open Memory, or add a note', args: '[note]', kind: 'main' },
  { name: 'init', description: 'write project notes to .forge/AGENTS.md (merges, never overwrites)', kind: 'main' },
  { name: 'review', description: 'review the current git diff', args: '[focus]', kind: 'main' },
  { name: 'resume', description: 'pick a past chat', args: '[title]', kind: 'main' },
  { name: 'rewind', description: 'restore files + conversation to before a turn', kind: 'main' },
  { name: 'todos', description: "the agent's task list", kind: 'main' },
  { name: 'permissions', description: 'which tools run, ask or are blocked in this mode', kind: 'main' },
  { name: 'export', description: 'save this chat as markdown', kind: 'main' },
  { name: 'restate', description: 'restate the goal first, then wait for a yes', args: '<request>', kind: 'prompt' },
  { name: 'team', description: 'run the request as a team (orchestrator)', args: '<request>', kind: 'ui' },
  { name: 'roundtable', description: 'group chat: models take turns on a topic', args: '<topic>', kind: 'ui' },
  { name: 'agents', description: 'play-test in Studio with test agents', args: '[scenario]', kind: 'ui' },
  { name: 'tests', description: 'run the Lune tests', kind: 'ui' },
  { name: 'lint', description: 'run selene + StyLua', kind: 'ui' },
  { name: 'sync', description: 'sync with collaborators', kind: 'ui' }
]

export function isBuiltin(name: string): boolean {
  return BUILTIN_COMMANDS.some((c) => c.name === name)
}

// "/name rest of line" -> { name, args }; null when the text is not a command. Names are
// letters, digits, '-', '_' and ':' (namespaced custom commands, e.g. /frontend:test).
export function parseSlash(text: string): { name: string; args: string } | null {
  const m = /^\/([A-Za-z][\w:-]*)(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim())
  if (!m) return null
  return { name: m[1].toLowerCase(), args: (m[2] ?? '').trim() }
}

// Typeahead: commands whose name starts with the typed prefix (then those containing it).
export function matchCommands(all: ChatCommandInfo[], typed: string, limit = 12): ChatCommandInfo[] {
  const q = typed.replace(/^\//, '').toLowerCase()
  const starts = all.filter((c) => c.name.startsWith(q))
  const contains = q ? all.filter((c) => !c.name.startsWith(q) && c.name.includes(q)) : []
  return [...starts, ...contains].slice(0, limit)
}

// ---------------------------------------------------------------- custom commands

export interface CustomCommand {
  name: string
  description: string
  argumentHint?: string
  // Mode the command's message is sent in (frontmatter "mode"), e.g. a review command in ask.
  mode?: ChatMode
  model?: string
  body: string
  source: 'project' | 'user'
  path: string
}

// Frontmatter (--- key: value ---) + body. Unknown keys are ignored; allowed-tools is accepted for
// Claude Code compatibility, and mapped onto a mode: no write tool listed -> ask.
export function parseCustomCommand(fileName: string, text: string, source: 'project' | 'user', path = fileName): CustomCommand | null {
  const base = fileName.replace(/\\/g, '/').replace(/\.md$/i, '')
  // Subfolders namespace the command: frontend/test.md -> frontend:test.
  const name = base.split('/').filter(Boolean).join(':').toLowerCase()
  if (!/^[a-z][\w:-]*$/.test(name)) return null
  let body = String(text ?? '').replace(/\r\n/g, '\n')
  const meta: Record<string, string> = {}
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body)
  if (fm) {
    body = body.slice(fm[0].length)
    for (const line of fm[1].split('\n')) {
      const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  body = body.trim()
  if (!body) return null
  const firstLine = body.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').trim() ?? ''
  const cmd: CustomCommand = { name, description: (meta.description || firstLine).slice(0, 120), body, source, path }
  if (meta['argument-hint']) cmd.argumentHint = meta['argument-hint']
  if (meta.model) cmd.model = meta.model
  const mode = meta.mode?.toLowerCase()
  if (mode === 'ask' || mode === 'plan' || mode === 'edit' || mode === 'auto') cmd.mode = mode
  else if (meta['allowed-tools'] !== undefined && !/\b(Edit|Write|MultiEdit|Bash|write_script|edit_script)\b/.test(meta['allowed-tools'])) cmd.mode = 'ask'
  return cmd
}

// Splits arguments like a shell would, for $1..$9 (quotes group words).
export function splitArgs(args: string): string[] {
  const out: string[] = []
  for (const m of String(args ?? '').matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

// $ARGUMENTS -> the whole argument string; $1..$9 -> positional. A template without $ARGUMENTS
// gets the arguments appended (so "/fix the shop" still carries "the shop").
export function expandCommand(body: string, args: string): string {
  const pos = splitArgs(args)
  let used = false
  let out = body.replace(/\$ARGUMENTS\b/g, () => ((used = true), args))
  out = out.replace(/\$([1-9])\b/g, (_, d: string) => ((used = true), pos[Number(d) - 1] ?? ''))
  if (!used && args.trim()) out += `\n\n${args.trim()}`
  return out.trim()
}

// Project commands win over user commands with the same name; built-ins win over both.
export function mergeCommands(project: CustomCommand[], user: CustomCommand[]): CustomCommand[] {
  const out = new Map<string, CustomCommand>()
  for (const c of [...user, ...project]) if (!isBuiltin(c.name)) out.set(c.name, c)
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function commandInfo(c: CustomCommand): ChatCommandInfo {
  return { name: c.name, description: c.description, ...(c.argumentHint ? { args: c.argumentHint } : {}), kind: 'prompt', source: c.source, path: c.path }
}

// ---------------------------------------------------------------- results

// What a command handler returns to the renderer. text is shown in the chat (and saved there);
// action asks the renderer to do something only it can (open a page, show a picker).
export type CommandAction =
  | { kind: 'openPage'; page: 'memory' | 'settings' }
  | { kind: 'pickChat'; chats: { id: string; title: string; lastAt?: number; model: string }[] }
  | { kind: 'pickModel' }
  | { kind: 'pickCheckpoint'; checkpoints: { id: string; label: string; at: number }[] }
  | { kind: 'selectChat'; id: string }
  | { kind: 'newChat' }
  | { kind: 'send'; text: string; mode?: ChatMode }
  | { kind: 'mode'; mode: ChatMode }

export interface ChatCommandResult {
  text?: string
  action?: CommandAction
  // The command started a turn (busy events follow).
  started?: boolean
}
