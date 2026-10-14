// Prompts and sandbox for chat turns on Codex. No electron imports.

import type { ChatMode } from '../../../shared/chatModes.ts'
import { isReadOnlyMode } from '../../../shared/chatModes.ts'
import { modeNote } from '../modes.ts'
import type { CodexSandbox } from './args.ts'

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
