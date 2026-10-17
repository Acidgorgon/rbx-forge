// Maps the `codex exec --json` event stream to chat updates. No electron imports.
//
// Event shapes (codex-rs/exec/src/exec_events.rs, Oct 2026):
//   {"type":"thread.started","thread_id":"<uuid>"}
//   {"type":"turn.started"}
//   {"type":"turn.completed","usage":{"input_tokens","cached_input_tokens","output_tokens","reasoning_output_tokens"}}
//   {"type":"turn.failed","error":{"message"}}
//   {"type":"item.started"|"item.updated"|"item.completed","item":{"id","type",...}}
//   {"type":"error","message"}
// Item types: agent_message {text}, reasoning {text}, command_execution {command, aggregated_output,
// exit_code, status in_progress|completed|failed|declined}, file_change {changes:[{path, kind
// add|delete|update}], status}, mcp_tool_call {server, tool, arguments, result, error, status},
// collab_tool_call {tool, status}, web_search {query}, todo_list {items:[{text, completed}]},
// error {message}. Unknown types are ignored, so newer CLIs keep working.
//
// The CLI reports its own non-fatal warnings as `error` items (and some as top-level `error` or
// `warning` events): "Codex is ignoring 1 unrecognized configuration setting … config.toml …". They
// are about the user's Codex setup, not the answer, so they become `warning` updates, which the
// service logs instead of showing in the chat (service.ts). Fatal errors stay `error`.

import { isAbsolute, relative } from 'node:path'

export interface CodexUsage {
  input: number
  cachedInput: number
  output: number
}

export type CodexUpdate =
  | { kind: 'thread'; threadId: string }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'tool'; key: string; name: string; input: string; text: string; done: boolean; error?: boolean }
  | { kind: 'notice'; key: string; text: string }
  | { kind: 'warning'; text: string }
  | { kind: 'usage'; usage: CodexUsage }
  | { kind: 'error'; message: string }

const PREVIEW = 1500

function preview(text: string): string {
  const t = text.replace(/\s+$/, '')
  return t.length > PREVIEW ? `${t.slice(0, PREVIEW)}\n…` : t
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function short(v: unknown, max = 160): string {
  let s: string
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v ?? {})
  } catch {
    s = ''
  }
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

// A CLI notice about the user's Codex config or setup that does not stop the run.
// Narrow on purpose: a config file that fails to parse is fatal and must still be shown.
const WARNING_RE = /unrecognized configuration setting|\bis ignoring\b|\bis ignored\b|\bdeprecated (config|configuration|setting|option|flag|key)/i

export function isCodexWarning(message: string): boolean {
  return WARNING_RE.test(message.trim())
}

// A chat notice that only carries a Codex CLI config warning: "Codex: Codex is ignoring 1
// unrecognized configuration setting ..." (how older Forge versions posted them), optionally after a
// speaker label or "Error: ". Such lines belong in the output log, not in a transcript.
export function isCodexWarningNotice(text: string): boolean {
  const t = text.trim()
  if (!/codex|config/i.test(t)) return false
  const inner = t.replace(/^(?:[^:\n]{1,60}: )?(?:Error: )?/, '')
  return isCodexWarning(inner) || isCodexWarning(t)
}

// The reason of a failed image_gen call: a message, or the plan's image limit (with its reset).
export function imageFailureText(f: unknown): string {
  if (!f) return ''
  if (typeof f === 'string') return f
  if (typeof f !== 'object') return ''
  const o = f as Record<string, any>
  if (typeof o.message === 'string' && o.message) return o.message
  const limit = o.usage_limit_exceeded ?? o.UsageLimitExceeded ?? o.usageLimitExceeded ?? (/usage_?limit/i.test(String(o.type ?? o.kind ?? '')) ? o : null)
  if (limit && typeof limit === 'object') {
    const at = Number(limit.resets_at ?? limit.resetsAt)
    const when = Number.isFinite(at) && at > 0 ? ` (resets ${new Date(at * 1000).toLocaleString()})` : ''
    return `the ChatGPT plan's image generation limit is reached${when}`
  }
  return short(o, 300)
}

export class CodexEventMapper {
  // Paths in file changes are shown relative to this root.
  private root: string | undefined
  threadId: string | null = null
  // Final agent message of the run (the answer of a one-shot call).
  lastMessage = ''
  failed: string | null = null
  // Image files the image tool reported (newer CLIs put a saved path on the item).
  readonly savedImages: string[] = []
  usage: CodexUsage = { input: 0, cachedInput: 0, output: 0 }

  constructor(root?: string) {
    this.root = root
  }

  // One stdout line. Non-JSON lines (warnings some CLIs print) are ignored.
  line(raw: string): CodexUpdate[] {
    const t = raw.trim()
    if (!t || t[0] !== '{') return []
    let e: any
    try {
      e = JSON.parse(t)
    } catch {
      return []
    }
    return this.event(e)
  }

  event(e: any): CodexUpdate[] {
    if (!e || typeof e !== 'object') return []
    switch (e.type) {
      case 'thread.started':
        if (typeof e.thread_id === 'string' && e.thread_id) {
          this.threadId = e.thread_id
          return [{ kind: 'thread', threadId: e.thread_id }]
        }
        return []
      case 'turn.completed': {
        const u = e.usage ?? {}
        const usage = { input: num(u.input_tokens), cachedInput: num(u.cached_input_tokens), output: num(u.output_tokens) + num(u.reasoning_output_tokens) }
        this.usage = { input: this.usage.input + usage.input, cachedInput: this.usage.cachedInput + usage.cachedInput, output: this.usage.output + usage.output }
        return [{ kind: 'usage', usage }]
      }
      case 'turn.failed': {
        const message = str(e.error?.message) || 'Codex turn failed'
        this.failed = message
        return [{ kind: 'error', message }]
      }
      case 'warning':
        return str(e.message) ? [{ kind: 'warning', text: str(e.message) }] : []
      case 'error': {
        const message = str(e.message) || 'Codex error'
        // A reconnect notice ("Reconnecting... 1/5") is not the end of the run.
        if (/^reconnecting/i.test(message)) return [{ kind: 'notice', key: 'reconnect', text: message }]
        if (isCodexWarning(message)) return [{ kind: 'warning', text: message }]
        this.failed = message
        return [{ kind: 'error', message }]
      }
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        return this.item(e.item, e.type === 'item.completed')
      default:
        return []
    }
  }

  private rel(p: string): string {
    if (!this.root || !isAbsolute(p)) return p.replace(/\\/g, '/')
    const r = relative(this.root, p)
    return (r && !r.startsWith('..') && !isAbsolute(r) ? r : p).replace(/\\/g, '/')
  }

  private item(item: any, completed: boolean): CodexUpdate[] {
    if (!item || typeof item !== 'object') return []
    const key = typeof item.id === 'string' && item.id ? item.id : `item-${Math.random().toString(36).slice(2)}`
    const status = str(item.status)
    const done = completed || ['completed', 'failed', 'declined'].includes(status)
    const failed = status === 'failed' || status === 'declined'
    for (const p of [item.saved_path, item.savedPath]) if (typeof p === 'string' && p && !this.savedImages.includes(p)) this.savedImages.push(p)
    switch (item.type) {
      case 'agent_message': {
        const text = str(item.text)
        if (!text.trim()) return []
        if (completed) this.lastMessage = text
        return [{ kind: 'text', key, text }]
      }
      case 'reasoning':
        return []
      case 'command_execution': {
        const out = str(item.aggregated_output)
        const code = typeof item.exit_code === 'number' ? item.exit_code : null
        let text = done ? preview(out) || (failed ? '' : '(no output)') : ''
        if (done && status === 'declined') text = 'Declined by the sandbox policy.'
        else if (done && failed) text = `Error: exit ${code ?? '?'}${out.trim() ? `\n${preview(out)}` : ''}`
        return [{ kind: 'tool', key, name: 'shell', input: short(item.command, 200), text, done, ...(failed ? { error: true } : {}) }]
      }
      case 'file_change': {
        const changes = Array.isArray(item.changes) ? item.changes : []
        const list = changes.map((c: any) => `${str(c?.kind) || 'update'} ${this.rel(str(c?.path))}`)
        const text = done ? (failed ? `Error: the patch failed\n${list.join('\n')}` : list.join('\n')) : ''
        return [{ kind: 'tool', key, name: 'apply_patch', input: short(list.join(', '), 200), text, done, ...(failed ? { error: true } : {}) }]
      }
      case 'mcp_tool_call': {
        const err = str(item.error?.message)
        let text = ''
        if (done && err) text = `Error: ${err}`
        else if (done) {
          const content = Array.isArray(item.result?.content) ? item.result.content : []
          text = preview(content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).filter(Boolean).join('\n')) || 'done'
        }
        return [{ kind: 'tool', key, name: `${str(item.server) || 'mcp'}.${str(item.tool) || 'tool'}`, input: short(item.arguments), text, done, ...(err || failed ? { error: true } : {}) }]
      }
      case 'web_search':
        return [{ kind: 'tool', key, name: 'web_search', input: short(item.query), text: done ? 'done' : '', done }]
      case 'collab_tool_call':
        return [{ kind: 'tool', key, name: str(item.tool) || 'agent', input: short(item.prompt ?? ''), text: done ? (failed ? 'Error: failed' : 'done') : '', done, ...(failed ? { error: true } : {}) }]
      // Not in today's `codex exec --json` (the images are found on disk, generated.ts); newer CLIs
      // or the app-server shape may send it. A failed call shows the CLI's own reason.
      case 'image_generation': {
        const err = imageFailureText(item.failure ?? item.error) || (failed ? 'image generation failed' : '')
        const text = done ? (err ? `Error: ${err}` : item.saved_path || item.savedPath ? `saved ${str(item.saved_path ?? item.savedPath)}` : 'image generated') : ''
        return [{ kind: 'tool', key, name: 'image_gen', input: short(item.revised_prompt ?? item.revisedPrompt ?? ''), text, done, ...(err ? { error: true } : {}) }]
      }
      case 'todo_list': {
        const items = Array.isArray(item.items) ? item.items : []
        if (!items.length) return []
        return [{ kind: 'notice', key, text: items.map((t: any) => `${t?.completed ? '[x]' : '[ ]'} ${str(t?.text)}`).join('\n') }]
      }
      // Error items never end the run (turn.failed / error do): CLI warnings, logged not shown.
      case 'error': {
        const message = str(item.message)
        return message ? [{ kind: 'warning', text: message }] : []
      }
      default:
        return []
    }
  }
}

// Splits a byte stream into lines (CRLF tolerant), keeping the unfinished tail.
export class LineSplitter {
  private buf = ''
  push(chunk: string): string[] {
    this.buf += chunk
    const parts = this.buf.split(/\r?\n/)
    this.buf = parts.pop() ?? ''
    return parts
  }
  end(): string[] {
    const rest = this.buf
    this.buf = ''
    return rest ? [rest] : []
  }
}
