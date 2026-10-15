// Group chat v2 types: converging consults (Conclusion card), guest patch proposals, cross-check
// reviews, the per-chat Board, consult limits, and the IPC methods for them.
// Engine: src/main/agent/group/*; pure helpers: src/shared/group/*.

import type { ProviderId } from '../types.ts'

// Who said something (a participant's display name and model).
export interface GroupVoice {
  label: string
  provider: ProviderId
  model: string
}

// One position in a consult, attributed.
export interface ConclusionPoint {
  text: string
  // Labels of the models that hold it (empty = both / unattributed).
  by?: string[]
}

// What one model looked at during the consult (tool calls, files read).
export interface ConclusionChecks {
  label: string
  checked: string[]
}

export type ConfidenceLevel = 'high' | 'medium' | 'low'

// The Conclusion card the host posts after "ask <model> ... and report back".
export interface ConclusionData {
  question: string
  answer: string
  agreed: ConclusionPoint[]
  disagreed: ConclusionPoint[]
  confidence: ConfidenceLevel
  confidenceWhy?: string
  checks: ConclusionChecks[]
  // The models in the consult: host first.
  participants: GroupVoice[]
  // Exchanges used (one = guest reply + host reply) and the cap.
  turns: number
  maxTurns: number
  // Why the loop ended.
  ended: 'agreed' | 'cap' | 'budget' | 'stopped' | 'error'
  tokens: number
  costUsd?: number
}

// A unified diff a guest proposed in its reply. Only the host (or the user's Apply) writes it.
export interface PatchFile {
  path: string
  added: number
  removed: number
  // New file (--- /dev/null) or deletion (+++ /dev/null).
  created?: boolean
  deleted?: boolean
}

export interface PatchProposal {
  diff: string
  files: PatchFile[]
  by: GroupVoice
  state: 'proposed' | 'applied' | 'merging' | 'failed' | 'dismissed'
  // Why apply failed, or what was applied.
  detail?: string
}

export type ReviewSeverity = 'blocking' | 'note'

export interface ReviewFinding {
  severity: ReviewSeverity
  text: string
  file?: string
  line?: number
}

// Cross-check review of the host's multi-file edit by a guest from another provider.
export interface ReviewData {
  reviewer: GroupVoice
  files: string[]
  verdict: 'approve' | 'changes'
  findings: ReviewFinding[]
  // 'pending' = the host is addressing blocking findings; 'addressed' = it ran its fix turn.
  state: 'reviewed' | 'pending' | 'addressed' | 'skipped'
  detail?: string
}

export type BoardKind = 'decision' | 'question' | 'conclusion'

export interface BoardItem {
  id: string
  kind: BoardKind
  text: string
  at: number
  // Where it came from (a Conclusion or plan card message), when auto-filled.
  source?: { messageId: string; card: 'conclusion' | 'plan' }
  // Set when the user wrote or edited it (auto-fill never overwrites it).
  edited?: boolean
  // Open questions the user ticked off.
  done?: boolean
}

// Group chat settings (setting key "groupChat").
export interface GroupSettings {
  // Exchanges (guest reply + host reply) before the host must conclude.
  consultTurns: number
  // Per-consult caps: the loop stops and the host concludes with what it has.
  consultMaxTokens: number
  consultMaxUsd: number
  // Second-opinion review of the host's multi-file edits.
  crossCheck: boolean
  // "provider/model" of the reviewer; empty = the first guest (or ready model) from another provider.
  crossCheckModel: string
  // A cross-check only runs when the host's turn touched at least this many files.
  crossCheckMinFiles: number
}

export const GROUP_SETTINGS_DEFAULTS: GroupSettings = {
  consultTurns: 3,
  consultMaxTokens: 120_000,
  consultMaxUsd: 0.75,
  crossCheck: false,
  crossCheckModel: '',
  crossCheckMinFiles: 2
}

export interface GroupApi {
  getGroupSettings(): Promise<GroupSettings>
  setGroupSettings(next: Partial<GroupSettings>): Promise<GroupSettings>
  // Applies a guest's patch proposal (the host's write path); returns the updated card message.
  applyPatchProposal(sessionId: string, messageId: string): Promise<void>
  // Hands the proposal to the host, which merges it in its own turn.
  mergePatchProposal(sessionId: string, messageId: string): Promise<void>
  dismissPatchProposal(sessionId: string, messageId: string): Promise<void>
  // Replaces the chat's board (user edits); auto-filled items keep their source.
  saveBoard(sessionId: string, items: BoardItem[]): Promise<BoardItem[]>
}
