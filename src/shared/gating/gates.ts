// The code gates that run before a big-model call in the Labs' refine / critique / compose loops.
// Each returns a verdict: the outcome, whether code is sure (outside a grey zone), a short reason and
// an estimate of the big-model tokens the outcome saves. Unsure cases go to the decision model when
// one is configured (services/gating), else the conservative default (the old behaviour) wins.
// Pure and deterministic (test/gating.test.ts).

import type { FramesDiff } from './frames.ts'

export interface Verdict<O extends string> {
  outcome: O
  sure: boolean
  reason: string
  tokensSaved: number
}

// ------------------------------------------------------------------ token estimates

// Anthropic bills an image at about width * height / 750 tokens
// (https://platform.claude.com/docs/en/build-with-claude/vision#evaluate-image-size).
export function imageTokens(width: number, height: number): number {
  return Math.ceil((Math.max(1, width) * Math.max(1, height)) / 750)
}

// One vision critique: frames (+ reference images), the prompt (rubric, parameters, references,
// principles: ~9k characters in practice) and a JSON answer of ~600 tokens.
export function estimateCriticTokens(o: { images: number; width?: number; height?: number; promptChars?: number }): number {
  return Math.max(0, o.images) * imageTokens(o.width ?? 512, o.height ?? 384) + Math.ceil((o.promptChars ?? 9000) / 4) + 600
}

// One compose / repair call: the prompt plus a whole script in the answer (~1.8k tokens).
export function estimateComposeTokens(promptChars = 8000): number {
  return Math.ceil(promptChars / 4) + 1800
}

// ------------------------------------------------------------------ skip the critic

export const CRITIC_SKIP = {
  // Thumbnail difference at or below this (and hash distance at or below HASH) = unchanged.
  sureSkip: 0.012,
  hash: 4,
  // At or above this (or hash distance above HASH_CHANGED) = clearly changed.
  sureCritique: 0.045,
  hashChanged: 12
}

export function criticSkipVerdict(d: FramesDiff, ctx: { hasPrevious: boolean; criticTokens: number }): Verdict<'skip' | 'critique'> {
  const pct = `${(d.diff * 100).toFixed(1)}%`
  if (!ctx.hasPrevious) return { outcome: 'critique', sure: true, reason: 'first round', tokensSaved: 0 }
  if (!d.comparable) return { outcome: 'critique', sure: true, reason: 'frames not comparable', tokensSaved: 0 }
  if (d.diff <= CRITIC_SKIP.sureSkip && d.hash <= CRITIC_SKIP.hash) return { outcome: 'skip', sure: true, reason: `frames unchanged (diff ${pct}, hash ${d.hash}/64)`, tokensSaved: ctx.criticTokens }
  if (d.diff >= CRITIC_SKIP.sureCritique || d.hash > CRITIC_SKIP.hashChanged) return { outcome: 'critique', sure: true, reason: `frames changed (diff ${pct}, hash ${d.hash}/64)`, tokensSaved: 0 }
  return { outcome: 'critique', sure: false, reason: `small change (diff ${pct}, hash ${d.hash}/64)`, tokensSaved: 0 }
}

// ------------------------------------------------------------------ plateau / target met

export const PLATEAU = {
  // A round that gains less than this is flat.
  minGain: 0.25,
  // "Near the target": within this of the threshold.
  near: 0.6
}

// scores: overall score per round so far (oldest first). remaining: rounds the loop would still run.
export function plateauVerdict(scores: number[], ctx: { threshold: number; remaining: number; criticTokens: number }): Verdict<'stop' | 'continue'> {
  const n = scores.length
  const last = scores[n - 1] ?? 0
  const saved = Math.max(0, ctx.remaining) * ctx.criticTokens
  if (!n || ctx.remaining <= 0) return { outcome: 'continue', sure: true, reason: 'last round anyway', tokensSaved: 0 }
  if (last >= ctx.threshold) return { outcome: 'stop', sure: true, reason: `target met (${last.toFixed(1)} >= ${ctx.threshold})`, tokensSaved: saved }
  if (n >= 3) {
    const g1 = scores[n - 2] - scores[n - 3]
    const g2 = last - scores[n - 2]
    if (g1 < 0 && g2 < 0) return { outcome: 'stop', sure: true, reason: `getting worse two rounds running (${scores.slice(-3).map((s) => s.toFixed(1)).join(' > ')})`, tokensSaved: saved }
    if (Math.abs(g1) < PLATEAU.minGain && Math.abs(g2) < PLATEAU.minGain) return { outcome: 'stop', sure: true, reason: `plateau (${scores.slice(-3).map((s) => s.toFixed(1)).join(' > ')})`, tokensSaved: saved }
  }
  if (n >= 2) {
    const g = last - scores[n - 2]
    if (g < PLATEAU.minGain && last >= ctx.threshold - PLATEAU.near) return { outcome: 'continue', sure: false, reason: `near target and flat (${scores[n - 2].toFixed(1)} > ${last.toFixed(1)}, target ${ctx.threshold})`, tokensSaved: 0 }
  }
  return { outcome: 'continue', sure: true, reason: `improving (${scores.slice(-2).map((s) => s.toFixed(1)).join(' > ')})`, tokensSaved: 0 }
}

// ------------------------------------------------------------------ retry route for a failed compose

export type FailureKind = 'no-script' | 'parse' | 'script-error' | 'timeout' | 'runtime-missing' | 'model-error'
export type RetryOutcome = 'retry' | 'rephrase' | 'give-up'
export const RETRY_OUTCOMES: readonly RetryOutcome[] = ['retry', 'rephrase', 'give-up']
// At most this many extra model calls per compose.
export const MAX_REPAIRS = 2

export const FAILURE_INFO: Record<FailureKind, string> = {
  'no-script': 'the answer had no script / JSON',
  parse: 'the answer did not parse',
  'script-error': 'the script failed when recorded',
  timeout: 'the run timed out',
  'runtime-missing': 'Lune or the runtime is missing',
  'model-error': 'the model call failed'
}

// Typed reason from an error message (the services' messages and Lune's).
export function classifyFailure(message: string): FailureKind {
  const m = message.toLowerCase()
  if (/timed? ?out|timeout|etimedout|aborted/.test(m)) return 'timeout'
  if (/lune.*(not available|missing|not found)|runtime (scripts )?(are )?missing|enoent/.test(m)) return 'runtime-missing'
  if (/no (script|json|code)|did not answer with|empty answer|no lua/.test(m)) return 'no-script'
  if (/json|unexpected token|unterminated|parse/.test(m)) return 'parse'
  if (/\b(4\d\d|5\d\d)\b|rate limit|overloaded|not set up|unauthori[sz]ed|credit|network|fetch failed|econn/.test(m)) return 'model-error'
  return 'script-error'
}

// What the labs did before the gates: one repair round for a recorded script error, else give up.
export function legacyRetry(kind: FailureKind, repairs: number): RetryOutcome {
  return kind === 'script-error' && repairs < 1 ? 'retry' : 'give-up'
}

// repairs: extra calls already made for this compose. sameAsLast: the error repeats the previous one.
export function retryVerdict(f: { kind: FailureKind; repairs: number; sameAsLast?: boolean }, composeTokens: number): Verdict<RetryOutcome> {
  const giveUp = (reason: string, sure = true): Verdict<RetryOutcome> => ({ outcome: 'give-up', sure, reason, tokensSaved: legacyRetry(f.kind, f.repairs) === 'give-up' ? 0 : composeTokens })
  if (f.kind === 'timeout' || f.kind === 'runtime-missing' || f.kind === 'model-error') return giveUp(`${FAILURE_INFO[f.kind]}; a repair will not help`)
  if (f.repairs >= MAX_REPAIRS) return giveUp(`${MAX_REPAIRS} repairs already`)
  if (f.sameAsLast) return giveUp('same error after a repair')
  if (f.kind === 'no-script' || f.kind === 'parse') {
    return f.repairs === 0 ? { outcome: 'rephrase', sure: true, reason: `${FAILURE_INFO[f.kind]}: ask again with the format spelled out`, tokensSaved: 0 } : giveUp(`${FAILURE_INFO[f.kind]} again`)
  }
  if (f.repairs === 0) return { outcome: 'retry', sure: true, reason: 'script error: one repair with the error and line', tokensSaved: 0 }
  return { outcome: 'retry', sure: false, reason: 'second script error: repair, rephrase or give up?', tokensSaved: 0 }
}

// The prompt suffix for a "rephrase" (format reminder instead of the failed answer).
export function rephraseNote(kind: 'script' | 'json'): string {
  return kind === 'script'
    ? 'Your previous answer had no usable script. Answer with exactly one ```lua code block holding the whole script and nothing else.'
    : 'Your previous answer was not valid JSON. Answer with one JSON object only: no prose, no code fences.'
}

// The critique a skipped round reuses: the previous scores, a note, and no changes (applying the
// same changes again would not move frames that did not move), so the loop ends as "no changes".
export function skippedCritique<C extends { summary: string; changes: unknown[] }>(previous: C, reason?: string): C {
  return { ...previous, summary: `Critic skipped (${reason ?? 'frames unchanged'}): scores carried over. ${previous.summary}`.slice(0, 600), changes: [] }
}
