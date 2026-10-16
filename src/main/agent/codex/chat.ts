// Prompts and sandbox for chat turns (and group-chat calls) on Codex. No electron imports.

import type { ChatMode } from '../../../shared/chatModes.ts'
import { isReadOnlyMode } from '../../../shared/chatModes.ts'
import { modeNote } from '../modes.ts'
import type { ChatMessage } from '@shared/types'
import type { CodexSandbox } from './args.ts'
import type { CodexUpdate } from './events.ts'

// Ask / Plan: read-only (Codex can read and search, never write). Edit / Auto: workspace-write, the
// safest sandbox that still lets Codex edit the project: writes only inside the project root (plus
// temp), no network for commands, and `codex exec` never asks for approval. danger-full-access is
// never used.
export function codexSandboxFor(mode: ChatMode): CodexSandbox {
  return isReadOnlyMode(mode) ? 'read-only' : 'workspace-write'
}

// The project part of Forge's system prompt (layout and conventions), without the tool advice that
// only applies to Forge's own gentree tools.
export function projectBrief(basePrompt: string): string {
  const cut = basePrompt.indexOf('Working rules:')
  return (cut > 0 ? basePrompt.slice(0, cut) : basePrompt).trim()
}

export const CODEX_RULES = `Working rules (you are Codex, running inside RBX Forge on the user's project):
- Never edit Packages/ (Wally) or generated files (src/shared/events/client.luau and server.luau come from events.blink).
- Keep edits minimal and in the existing style. Scripts are Luau (.luau).
- Roblox Studio is not reachable from here; Studio-only instances (marked * in Forge) are not in the repo.
- Be concise in replies.`

export interface CodexPromptInput {
  text: string
  mode: ChatMode
  // Project rules block (.forge aiRules, AGENTS.md, memory).
  rules: string
  // First turn of a Codex thread: include the brief and the earlier transcript.
  fresh: boolean
  transcript: string
  basePrompt: string
}

export function codexPrompt(i: CodexPromptInput): string {
  const note = modeNote(i.mode, false).trim()
  if (!i.fresh) return note ? `${note}\n\n${i.text}` : i.text
  const parts = [projectBrief(i.basePrompt), CODEX_RULES]
  if (i.rules.trim()) parts.push(i.rules.trim())
  if (note) parts.push(note)
  if (i.transcript.trim()) parts.push(`Earlier in this conversation:\n${i.transcript.trim()}`)
  parts.push(`New message:\n${i.text}`)
  return parts.join('\n\n')
}

// `codex exec resume` with a thread id the CLI no longer has.
export function staleThread(error: string): boolean {
  return /(session|thread|conversation|rollout)[^.]*(not found|no such|does not exist|missing)|no (saved )?(session|thread|rollout)/i.test(error)
}

// A Codex text / tool / notice update as a chat message (the same id while it streams).
export function codexMessage(u: CodexUpdate, idOf: (key: string) => string): ChatMessage | null {
  if (u.kind === 'text') return { id: idOf(u.key), role: 'assistant', text: u.text, at: Date.now(), agentId: 'main' }
  if (u.kind === 'tool') return { id: idOf(u.key), role: 'tool', text: u.text, tool: { name: u.name, input: u.input }, at: Date.now(), agentId: 'main' }
  if (u.kind === 'notice') return { id: idOf(u.key), role: 'system', text: u.text, at: Date.now(), agentId: 'main' }
  return null
}

// ---- group chat: Codex as a guest (or the host talking in a roundtable / consult)

// Group calls always run in the CLI's read-only sandbox, whatever the chat mode: guests never edit,
// and the host only edits in its own turns.
export const CODEX_GROUP_SANDBOX: CodexSandbox = 'read-only'

const READ_PROJECT = 'You run in a read-only sandbox in the project folder. You may read and search the project with read-only commands (rg, ls, cat, git diff, git log) when a fact matters. Never edit files, and do not run builds, installs or anything that writes.'
const NO_PROJECT = 'You run in an empty scratch folder: the user turned off project file access for guests. Do not look for project files or run commands; answer from the context given.'

// Prompt of one group call on Codex. A fresh thread gets the participant's system prompt; a
// resumed one already has it. The file-access line comes every time (guest tools can be switched
// between calls).
export function codexGroupPrompt(i: { system: string; prompt: string; fresh: boolean; projectFiles: boolean }): string {
  const access = i.projectFiles ? READ_PROJECT : NO_PROJECT
  return [i.fresh ? i.system.trim() : '', access, i.prompt.trim()].filter(Boolean).join('\n\n')
}
