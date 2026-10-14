// What the lab services see of the gating service (main/services/gating). Types only, so the lab
// services stay testable with a fake (or with no gate at all: every hook is optional and the
// services fall back to their v0.5 behaviour).

import type { FailureKind, RetryOutcome } from './gates.ts'
import type { LabId } from './types.ts'

export interface LabGate {
  // Before a vision critique (previousFrames: the last critique's frames when this run has none in
  // memory, e.g. the Ability Composer's one-shot critique). skip: reuse the previous critique (only when gates are on).
  beforeCritique(i: { lab: LabId; entryId: string; iteration: number; frames: Uint8Array[]; previousScore: number | null; changes: number; threshold: number; previousFrames?: Uint8Array[] }): Promise<{ skip: boolean; reason?: string }>
  // After a critique that ran. stop: end the loop now (only when gates are on).
  afterCritique(i: { lab: LabId; entryId: string; iteration: number; score: number; threshold: number; remaining: number; changes: number; summary?: string }): Promise<{ stop: boolean; reason?: string }>
  // A compose / parse failed. outcome is what to do now (the v0.5 behaviour unless gates are on).
  retry(i: { lab: LabId; entryId?: string; message: string; repairs: number; lastMessage?: string; kind?: FailureKind; legacy?: RetryOutcome }): Promise<{ outcome: RetryOutcome; ticket: string }>
  // Whether the repair / rephrase that followed worked (labels the decision model's example).
  retryResult(ticket: string, ok: boolean): void
  // A refine run finished (drops the per-run frame signatures).
  endRun(lab: LabId, entryId: string): void
}
