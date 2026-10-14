// IPC types for "Restate first" (main/agent/restate.ts). HarnessApi extends RestateApi.

import type { RestateKind, RestateLab, RestateSettings, Restatement } from './restate/types.ts'

export type * from './restate/types.ts'

export interface RestateBriefResult {
  // The card to show; absent when skipped.
  restatement?: Restatement
  reason?: string
  // Why there is no card (the setting, a simple brief, no model).
  skipped?: string
}

export interface RestateConfirmInput {
  kind: RestateKind
  request: string
  draft: Restatement
  // The person's edit; the draft when they said yes as is.
  confirmed?: Restatement
}

export interface RestateConfirmResult {
  confirmed: Restatement
  edited: boolean
  // Edited enough to keep as a correction (and a memory note).
  substantial: boolean
  noted: boolean
}

export interface RestateApi {
  getRestateSettings(): Promise<RestateSettings>
  setRestateSettings(patch: Partial<RestateSettings>): Promise<RestateSettings>
  // Labs: restate a brief before compose (cheap tier). force: the card even for a simple brief.
  restateBrief(lab: RestateLab, brief: string, opts?: { force?: boolean }): Promise<RestateBriefResult>
  // Labs: the person said yes (maybe after an edit); substantial edits become a memory note.
  restateConfirm(input: RestateConfirmInput): Promise<RestateConfirmResult>
  // Chat: confirm a restatement card (edited: the person's edit) and run the request.
  confirmChatRestate(sessionId: string, messageId: string, edited?: Restatement): Promise<void>
}
