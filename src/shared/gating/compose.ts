// The compose / repair loop shared by the VFX Lab, Animation Lab and Ability Composer: ask the
// model, check the answer in code, and on a failure let the retry gate decide (retry with the error,
// rephrase with the format spelled out, or give up) instead of always asking the model again. With
// no gate (or gates off / shadow) the v0.5 behaviour holds: one repair for a script error, else give
// up. Bounded: at most MAX_REPAIRS extra calls. Pure control flow (test/gating.test.ts).

import { classifyFailure, legacyRetry, MAX_REPAIRS, type FailureKind, type RetryOutcome } from './gates.ts'
import type { LabGate } from './hooks.ts'
import type { LabId } from './types.ts'

export type AttemptResult<T> = { ok: true; value: T } | { ok: false; kind?: FailureKind; message: string }

export class ComposeGaveUp extends Error {
  kind: FailureKind
  repairs: number
  constructor(kind: FailureKind, message: string, repairs: number) {
    super(message)
    this.kind = kind
    this.repairs = repairs
  }
}

export async function composeWithGate<T>(o: {
  lab: LabId
  gate?: LabGate
  ask: () => Promise<string>
  check: (raw: string) => Promise<AttemptResult<T>>
  repair: (raw: string, message: string) => Promise<string>
  rephrase: () => Promise<string>
  // The lab's behaviour before the gates (default legacyRetry: one repair for a script error).
  legacy?: (kind: FailureKind, repairs: number) => RetryOutcome
}): Promise<{ value: T; repairs: number }> {
  let raw = await o.ask()
  let repairs = 0
  let last: string | undefined
  let ticket = ''
  for (;;) {
    const r = await o.check(raw)
    if (ticket) o.gate?.retryResult(ticket, r.ok)
    if (r.ok) return { value: r.value, repairs }
    const kind = r.kind ?? classifyFailure(r.message)
    const legacy = (o.legacy ?? legacyRetry)(kind, repairs)
    const d = o.gate ? await o.gate.retry({ lab: o.lab, message: r.message, repairs, lastMessage: last, kind, legacy }) : { outcome: legacy, ticket: '' }
    if (d.outcome === 'give-up' || repairs >= MAX_REPAIRS) throw new ComposeGaveUp(kind, r.message, repairs)
    ticket = d.ticket
    last = r.message
    repairs++
    raw = d.outcome === 'rephrase' ? await o.rephrase() : await o.repair(raw, r.message)
  }
}
