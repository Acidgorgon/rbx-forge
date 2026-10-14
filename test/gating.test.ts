// Lab gating: frame signatures (PNG decode, downscale, dHash, diff), the code gates (skip the critic,
// plateau / target, retry routes), the compose retry loop, cost-per-kept accounting, the learned
// decision models (training, calibration, serialisation, the activation rule, the primitives), and
// the GatingService end to end (shadow / on / off, labels from outcomes, models overriding the
// heuristic only once active, principle-weight shadow, run cost attribution, persistence), plus the
// refine-loop hook and the IPC wrappers.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { decodePng } from '../src/main/services/gating/png.ts'
import { dHash, framesDiff, frameSig, hamming, thumbDiff, type RawImage } from '../src/shared/gating/frames.ts'
import { classifyFailure, criticSkipVerdict, estimateCriticTokens, imageTokens, legacyRetry, MAX_REPAIRS, plateauVerdict, retryVerdict, skippedCritique } from '../src/shared/gating/gates.ts'
import { ComposeGaveUp, composeWithGate } from '../src/shared/gating/compose.ts'
import type { LabGate } from '../src/shared/gating/hooks.ts'
import { chargeRun, costRows, formatUsd, markKept } from '../src/shared/gating/costs.ts'
import { normalizeGatingSettings, type GateDecision, type GatingSettings } from '../src/shared/gating/types.ts'
import { applyPlatt, calibrationError, fitPlatt, fitSoftmax, fitStandardizer, predictProba, standardize } from '../src/shared/decide/logistic.ts'
import { choice, isActive, MODEL_VERSION, parseModelFile, score, trainDecisionModel, yesNo, type Example } from '../src/shared/decide/model.ts'
import { criticSkipFeatures, plateauFeatures, retryFeatures, textFeatures } from '../src/shared/decide/features.ts'
import { GatingService } from '../src/main/services/gating/service.ts'
import { createGatingWiring, resultEntryId } from '../src/main/services/gating/wire.ts'
import { PrincipleService } from '../src/main/services/principles/service.ts'
import { refineLoop } from '../src/shared/vfx/critique.ts'
import { VfxService } from '../src/main/services/vfx/service.ts'
import { effectFromSpec } from '../src/shared/vfx/spec.ts'
import type { VfxCritique } from '../src/shared/vfx/types.ts'

// ------------------------------------------------------------------ helpers

const CRC = (() => {
  const t: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t.push(c >>> 0)
  }
  return t
})()
function crc32(b: Buffer): number {
  let c = 0xffffffff
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length)
  const tb = Buffer.concat([Buffer.from(type, 'ascii'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(tb))
  return Buffer.concat([len, tb, crc])
}
// RGBA PNG from a pixel function; rows use filters 0..4 in turn so the decoder's unfiltering is hit.
function png(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = w * 4
  const rows: Buffer[] = []
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const raw = Buffer.alloc(stride)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y)
      raw.set([r, g, b, 255], x * 4)
    }
    const f = y % 5
    const out = Buffer.alloc(stride + 1)
    out[0] = f
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? raw[i - 4] : 0
      const b = prev[i]
      const c = i >= 4 ? prev[i - 4] : 0
      const p = a + b - c
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pr
      out[i + 1] = (raw[i] - pred) & 255
    }
    rows.push(out)
    prev = raw
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
}
const blob = (cx: number, r = 10) => png(64, 48, (x, y) => ((x - cx) ** 2 + (y - 24) ** 2 < r * r ? [250, 120, 255] : [8, 8, 10]))

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forge-gating-'))
}

function service(dir: string, s: Partial<GatingSettings> = {}, clock = { t: 1_000 }) {
  let settings = normalizeGatingSettings(s)
  const svc = new GatingService({ dir, settings: () => settings, now: () => clock.t++ })
  return { svc, set: (p: Partial<GatingSettings>) => (settings = normalizeGatingSettings({ ...settings, ...p })) }
}

// ------------------------------------------------------------------ frames

test('decodePng reads RGBA with every filter type and rejects what it does not support', () => {
  const img = decodePng(png(7, 6, (x, y) => [x * 30, y * 40, 200]))!
  assert.equal(img.width, 7)
  assert.equal(img.height, 6)
  assert.equal(img.channels, 4)
  for (let y = 0; y < 6; y++) for (let x = 0; x < 7; x++) assert.deepEqual([...img.data.subarray((y * 7 + x) * 4, (y * 7 + x) * 4 + 3)], [x * 30, y * 40, 200])
  assert.equal(decodePng(Buffer.from('not a png at all, definitely not')), null)
  const bad = png(4, 4, () => [0, 0, 0])
  bad[24] = 16 // bit depth 16
  assert.equal(decodePng(bad), null)
})

test('frame signatures: identical frames diff 0, a moved blob diffs clearly, dHash distance follows', () => {
  const a = frameSig(decodePng(blob(20))!)
  const b = frameSig(decodePng(blob(20))!)
  const moved = frameSig(decodePng(blob(44))!)
  const nudged = frameSig(decodePng(blob(21))!)
  assert.equal(thumbDiff(a.thumb, b.thumb), 0)
  assert.equal(hamming(a.hash, b.hash), 0)
  assert.ok(thumbDiff(a.thumb, moved.thumb) > 0.045)
  assert.ok(hamming(a.hash, moved.hash) > 4)
  assert.ok(thumbDiff(a.thumb, nudged.thumb) < thumbDiff(a.thumb, moved.thumb))
  assert.equal(dHash(decodePng(blob(20))!).length, 16)
  assert.deepEqual(framesDiff([a, a], [b, b]), { comparable: true, diff: 0, hash: 0 })
  assert.equal(framesDiff([a, a], [b, moved]).comparable, true)
  assert.ok(framesDiff([a, a], [b, moved]).diff > 0.045)
  assert.equal(framesDiff([a], [b, b]).comparable, false)
  assert.equal(framesDiff(null, [b]).comparable, false)
  assert.equal(framesDiff([a], [null]).comparable, false)
  const grey: RawImage = { width: 2, height: 2, channels: 1, data: new Uint8Array([0, 255, 0, 255]) }
  assert.equal(frameSig(grey).thumb.length, 32 * 24)
})

// ------------------------------------------------------------------ gates

test('critic-skip gate: first round and changed frames critique, unchanged skip, the grey zone is unsure', () => {
  const tokens = estimateCriticTokens({ images: 5 })
  assert.equal(imageTokens(512, 384), 263)
  assert.ok(tokens > 2000 && tokens < 5000)
  assert.equal(criticSkipVerdict({ comparable: true, diff: 0, hash: 0 }, { hasPrevious: false, criticTokens: tokens }).outcome, 'critique')
  assert.equal(criticSkipVerdict({ comparable: false, diff: 1, hash: 64 }, { hasPrevious: true, criticTokens: tokens }).outcome, 'critique')
  const same = criticSkipVerdict({ comparable: true, diff: 0.004, hash: 1 }, { hasPrevious: true, criticTokens: tokens })
  assert.deepEqual([same.outcome, same.sure, same.tokensSaved], ['skip', true, tokens])
  const changed = criticSkipVerdict({ comparable: true, diff: 0.08, hash: 20 }, { hasPrevious: true, criticTokens: tokens })
  assert.deepEqual([changed.outcome, changed.sure, changed.tokensSaved], ['critique', true, 0])
  const grey = criticSkipVerdict({ comparable: true, diff: 0.02, hash: 6 }, { hasPrevious: true, criticTokens: tokens })
  assert.deepEqual([grey.outcome, grey.sure], ['critique', false])
  // Low pixel diff but the hash moved a lot (a shape flipped): critique.
  assert.equal(criticSkipVerdict({ comparable: true, diff: 0.01, hash: 20 }, { hasPrevious: true, criticTokens: tokens }).outcome, 'critique')
})

test('plateau gate: target met, two flat rounds, two worse rounds stop; improving continues; near-target flat is unsure', () => {
  const ctx = { threshold: 7.5, remaining: 2, criticTokens: 1000 }
  assert.equal(plateauVerdict([7.6], ctx).outcome, 'stop')
  const flat = plateauVerdict([6.8, 6.9, 6.9], ctx)
  assert.deepEqual([flat.outcome, flat.sure, flat.tokensSaved], ['stop', true, 2000])
  assert.match(flat.reason, /plateau/)
  assert.equal(plateauVerdict([7, 6.5, 6.1], ctx).outcome, 'stop')
  assert.equal(plateauVerdict([5, 6.2], ctx).outcome, 'continue')
  assert.equal(plateauVerdict([5, 6.2], ctx).sure, true)
  const near = plateauVerdict([7.1, 7.2], ctx)
  assert.deepEqual([near.outcome, near.sure], ['continue', false])
  assert.equal(plateauVerdict([6, 6], { ...ctx, remaining: 0 }).outcome, 'continue')
})

test('retry gate: typed reasons, bounded repairs, legacy behaviour kept for comparison', () => {
  assert.equal(classifyFailure('Lune timed out after 20 s'), 'timeout')
  assert.equal(classifyFailure('Timeline scripts run in Lune, which is not available: not found'), 'runtime-missing')
  assert.equal(classifyFailure('no script in the answer'), 'no-script')
  assert.equal(classifyFailure('Unexpected token } in JSON at position 3'), 'parse')
  assert.equal(classifyFailure('HTTP 529 overloaded'), 'model-error')
  assert.equal(classifyFailure("attempt to index nil with 'Emit' (line 14)"), 'script-error')
  assert.equal(legacyRetry('script-error', 0), 'retry')
  assert.equal(legacyRetry('script-error', 1), 'give-up')
  assert.equal(legacyRetry('no-script', 0), 'give-up')
  const T = 3000
  assert.equal(retryVerdict({ kind: 'script-error', repairs: 0 }, T).outcome, 'retry')
  const second = retryVerdict({ kind: 'script-error', repairs: 1 }, T)
  assert.deepEqual([second.outcome, second.sure], ['retry', false])
  assert.equal(retryVerdict({ kind: 'script-error', repairs: MAX_REPAIRS }, T).outcome, 'give-up')
  assert.equal(retryVerdict({ kind: 'script-error', repairs: 1, sameAsLast: true }, T).outcome, 'give-up')
  assert.equal(retryVerdict({ kind: 'no-script', repairs: 0 }, T).outcome, 'rephrase')
  assert.equal(retryVerdict({ kind: 'parse', repairs: 1 }, T).outcome, 'give-up')
  const timeout = retryVerdict({ kind: 'timeout', repairs: 0 }, T)
  assert.deepEqual([timeout.outcome, timeout.tokensSaved], ['give-up', 0])
  // A script error that would have been repaired, given up: the repair's tokens are saved.
  assert.equal(retryVerdict({ kind: 'script-error', repairs: 0, sameAsLast: true }, T).tokensSaved, T)
})

test('skippedCritique carries the scores over with no changes', () => {
  const prev = { overall: 6.2, summary: 'Core too dim.', changes: [{ node: 'Core' }] }
  const s = skippedCritique(prev, 'frames unchanged (diff 0.3%)')
  assert.equal(s.overall, 6.2)
  assert.equal(s.changes.length, 0)
  assert.match(s.summary, /^Critic skipped \(frames unchanged/)
})

// ------------------------------------------------------------------ compose loop

function fakeGate(outcomes: ('retry' | 'rephrase' | 'give-up')[]): LabGate & { calls: unknown[]; results: [string, boolean][] } {
  const calls: unknown[] = []
  const results: [string, boolean][] = []
  return {
    calls,
    results,
    async beforeCritique() {
      return { skip: false }
    },
    async afterCritique() {
      return { stop: false }
    },
    async retry(i) {
      calls.push(i)
      return { outcome: outcomes.shift() ?? 'give-up', ticket: `t${calls.length}` }
    },
    retryResult(t, ok) {
      results.push([t, ok])
    },
    endRun() {}
  }
}

test('composeWithGate: legacy without a gate, gate-routed retry / rephrase / give-up, labels the outcome', async () => {
  const asks: string[] = []
  const answers = ['bad', 'bad', 'good']
  const base = {
    lab: 'vfx' as const,
    ask: async () => (asks.push('ask'), answers.shift()!),
    check: async (raw: string) => (raw === 'good' ? { ok: true as const, value: 42 } : { ok: false as const, kind: 'script-error' as const, message: 'boom line 3' }),
    repair: async () => (asks.push('repair'), answers.shift()!),
    rephrase: async () => (asks.push('rephrase'), answers.shift()!)
  }
  // No gate: one repair, then give up (v0.5).
  await assert.rejects(() => composeWithGate(base), (e: unknown) => e instanceof ComposeGaveUp && e.repairs === 1)
  assert.deepEqual(asks, ['ask', 'repair'])
  // Gate: retry, then rephrase -> success; results labelled false then true.
  asks.length = 0
  answers.length = 0
  answers.push('bad', 'bad', 'good')
  const gate = fakeGate(['retry', 'rephrase'])
  const r = await composeWithGate({ ...base, gate })
  assert.equal(r.value, 42)
  assert.equal(r.repairs, 2)
  assert.deepEqual(asks, ['ask', 'repair', 'rephrase'])
  assert.deepEqual(gate.results, [['t1', false], ['t2', true]])
  // Hard bound even when the gate keeps saying retry.
  answers.length = 0
  answers.push('bad', 'bad', 'bad', 'bad')
  await assert.rejects(() => composeWithGate({ ...base, gate: fakeGate(['retry', 'retry', 'retry', 'retry']) }), ComposeGaveUp)
  // A lab-specific legacy rule reaches the gate.
  answers.length = 0
  answers.push('bad')
  const g2 = fakeGate(['give-up'])
  await assert.rejects(() => composeWithGate({ ...base, gate: g2, legacy: () => 'give-up' }))
  assert.equal((g2.calls[0] as { legacy: string }).legacy, 'give-up')
})

// ------------------------------------------------------------------ cost accounting

test('cost per kept: spend over kept results, per tier, unpriced calls counted, kept toggles', () => {
  let runs = chargeRun([], 'vfx', 'a', 'default', { input: 3000, output: 1500, costUsd: 0.05 }, 1)
  runs = chargeRun(runs, 'vfx', 'a', 'critic', { input: 5000, output: 600, costUsd: 0.08 }, 2)
  runs = chargeRun(runs, 'vfx', 'a', 'critic', { input: 5000, output: 600, costUsd: 0.08 }, 3)
  runs = chargeRun(runs, 'vfx', 'b', 'default', { input: 3000, output: 1500, costUsd: 0.05 }, 4)
  runs = chargeRun(runs, 'vfx', 'b', 'cheap', { input: 800, output: 100 }, 5)
  runs = chargeRun(runs, 'anim', 'c', 'critic', { input: 4000, output: 500, costUsd: 0.06 }, 6)
  let rows = costRows(runs)
  const vfx = rows.find((r) => r.lab === 'vfx')!
  assert.equal(vfx.runs, 2)
  assert.equal(vfx.kept, 0)
  assert.equal(vfx.costPerKept, null)
  assert.equal(vfx.unpriced, 1)
  runs = markKept(runs, 'vfx', 'a', true, 7)
  rows = costRows(runs)
  const v2 = rows.find((r) => r.lab === 'vfx')!
  assert.equal(v2.kept, 1)
  // Everything the lab spent (both runs) over one kept result.
  assert.equal(v2.costPerKept, 0.26)
  assert.equal(v2.tiers.critic!.costPerKept, 0.16)
  assert.equal(v2.tiers.critic!.calls, 2)
  assert.equal(v2.tokensPerKept, 3000 + 1500 + 2 * 5600 + 4500 + 900)
  runs = markKept(runs, 'vfx', 'a', false, 8)
  assert.equal(costRows(runs).find((r) => r.lab === 'vfx')!.kept, 0)
  // Kept with no model calls (an example) still counts.
  runs = markKept(runs, 'ability', 'x', true, 9)
  assert.equal(costRows(runs).find((r) => r.lab === 'ability')!.kept, 1)
  const ds: GateDecision[] = [
    { id: '1', at: 1, lab: 'vfx', gate: 'critic-skip', mode: 'on', inputs: '', outcome: 'skipped critic', acted: true, by: 'code', tokensSaved: 2300 },
    { id: '2', at: 2, lab: 'vfx', gate: 'plateau', mode: 'shadow', inputs: '', outcome: 'would stop', acted: false, by: 'code', tokensSaved: 4600 }
  ]
  const r3 = costRows(runs, ds).find((r) => r.lab === 'vfx')!
  assert.deepEqual([r3.saved, r3.wouldSave, r3.decisions], [2300, 4600, 2])
  assert.equal(formatUsd(null), '—')
  assert.equal(formatUsd(0.004), '$0.0040')
  assert.equal(formatUsd(1.234), '$1.23')
})

// ------------------------------------------------------------------ decision models

function lcg(seed: number): () => number {
  let x = seed
  return () => (x = (x * 16807) % 2147483647) / 2147483647
}

test('logistic regression learns a separable rule and softmax handles three classes', () => {
  const r = lcg(3)
  const X: number[][] = []
  const y: number[] = []
  for (let i = 0; i < 200; i++) {
    const a = r() * 4 - 2
    const b = r() * 4 - 2
    X.push([a, b])
    y.push(a + b > 0 ? 1 : 0)
  }
  const s = fitStandardizer(X)
  const m = fitSoftmax(X.map((x) => standardize(s, x)), y, 2)
  const acc = X.filter((x, i) => (predictProba(m, standardize(s, x))[1] >= 0.5 ? 1 : 0) === y[i]).length / X.length
  assert.ok(acc > 0.95, `accuracy ${acc}`)
  // Three classes by region.
  const y3 = X.map(([a]) => (a < -0.7 ? 0 : a < 0.7 ? 1 : 2))
  const m3 = fitSoftmax(X.map((x) => standardize(s, x)), y3, 3, { iterations: 800 })
  const acc3 = X.filter((x, i) => {
    const p = predictProba(m3, standardize(s, x))
    return p.indexOf(Math.max(...p)) === y3[i]
  }).length / X.length
  assert.ok(acc3 > 0.85, `3-class accuracy ${acc3}`)
})

test('calibration: Platt scaling fixes over-confident scores and the ECE of the model is small', () => {
  const r = lcg(11)
  const ps: number[] = []
  const labels: number[] = []
  for (let i = 0; i < 2000; i++) {
    const trueP = r()
    labels.push(r() < trueP ? 1 : 0)
    // Over-confident scores: pushed toward 0 / 1.
    const z = Math.log(trueP / (1 - trueP + 1e-9) + 1e-9) * 3
    ps.push(1 / (1 + Math.exp(-z)))
  }
  const before = calibrationError(ps, labels)
  const platt = fitPlatt(ps, labels, 600)
  const after = calibrationError(ps.map((p) => applyPlatt(p, platt)), labels)
  assert.ok(after < before, `ECE ${before.toFixed(3)} -> ${after.toFixed(3)}`)
  assert.ok(after < 0.05, `ECE after ${after}`)
  // A model trained on noisy labels predicts probabilities that match the frequencies.
  const ex: Example[] = []
  for (let i = 0; i < 600; i++) {
    const d = r()
    ex.push({ id: `e${i}`, at: i, features: { d }, heuristic: d > 0.5 ? 1 : 0, label: r() < d ? 1 : 0 })
  }
  const m = trainDecisionModel('t', ['no', 'yes'], ex, 1)!
  const ece = calibrationError(ex.map((e) => yesNo(m, e.features)), ex.map((e) => e.label!))
  assert.ok(ece < 0.06, `model ECE ${ece}`)
})

function exampleSet(n: number, opts: { heuristicGood?: boolean } = {}): Example[] {
  const r = lcg(5)
  return Array.from({ length: n }, (_, i) => {
    const diff = r() * 0.1
    const label = diff > 0.03 ? 1 : 0
    // The heuristic uses a worse cut (0.045) unless told to be perfect.
    return { id: `x${i}`, at: i, features: { diff, noise: r() }, heuristic: opts.heuristicGood ? label : diff > 0.06 ? 1 : 0, label }
  })
}

test('decision model: holdout comparison, activation rule, serialisation round trip, primitives', () => {
  assert.equal(trainDecisionModel('critic-skip', ['no', 'yes'], exampleSet(8), 1), null)
  const oneClass = exampleSet(40).map((e) => ({ ...e, label: 1 }))
  assert.equal(trainDecisionModel('critic-skip', ['no', 'yes'], oneClass, 1), null)
  const m = trainDecisionModel('critic-skip', ['no', 'yes'], exampleSet(80), 1)!
  assert.equal(m.version, MODEL_VERSION)
  assert.equal(m.n, 80)
  assert.equal(m.holdout.n, 16)
  assert.ok(m.holdout.modelAcc > m.holdout.heuristicAcc, `${m.holdout.modelAcc} vs ${m.holdout.heuristicAcc}`)
  assert.equal(isActive(m, 50), true)
  // Not enough examples for the bar.
  assert.equal(isActive(m, 100), false)
  // A perfect heuristic is never beaten: the model stays off.
  const tie = trainDecisionModel('critic-skip', ['no', 'yes'], exampleSet(80, { heuristicGood: true }), 1)!
  assert.equal(isActive(tie, 50), false)
  assert.equal(isActive(null, 50), false)
  // JSON round trip; a wrong version or shape is rejected.
  const back = parseModelFile(JSON.parse(JSON.stringify(m)))!
  assert.ok(back)
  assert.equal(yesNo(back, { diff: 0.09, noise: 0.5 }), yesNo(m, { diff: 0.09, noise: 0.5 }))
  assert.ok(yesNo(m, { diff: 0.09, noise: 0.5 }) > 0.8)
  assert.ok(yesNo(m, { diff: 0.001, noise: 0.5 }) < 0.2)
  assert.equal(parseModelFile({ ...m, version: 99 }), null)
  assert.equal(parseModelFile({ ...m, model: { W: [[1]], b: [0, 0] } }), null)
  assert.equal(parseModelFile(null), null)
  assert.ok(JSON.stringify(m).length < 4000)
  // Choice and score over three ordered levels.
  const lv: Example[] = Array.from({ length: 90 }, (_, i) => ({ id: `l${i}`, at: i, features: { v: (i % 30) / 10 }, heuristic: 1, label: i % 30 < 10 ? 0 : i % 30 < 20 ? 1 : 2 }))
  const m3 = trainDecisionModel('levels', ['low', 'mid', 'high'], lv, 1)!
  assert.equal(choice(m3, { v: 2.8 }).choice, 'high')
  assert.equal(choice(m3, { v: 0.1 }).choice, 'low')
  assert.ok(score(m3, { v: 2.8 }) > score(m3, { v: 1.5 }))
  assert.ok(score(m3, { v: 1.5 }) > score(m3, { v: 0.1 }))
})

test('features: numeric gate inputs and keyword features for critique text and errors', () => {
  const f = criticSkipFeatures({ lab: 'anim', diff: 0.02, hash: 6, comparable: true, iteration: 3, prevScore: 6.5, prevGain: 0.4, changes: 3, threshold: 7.5, heuristicSkip: false })
  assert.equal(f.lab_anim, 1)
  assert.equal(f.hash, 6 / 64)
  const t = textFeatures('Polished and reads well; only a minor tweak to the sparks, which pop off.', 's')
  assert.deepEqual([t.s_done, t.s_minor >= 2, t.s_problem], [2, true, 1])
  const p = plateauFeatures({ lab: 'vfx', scores: [6, 6.1, 6.2], threshold: 7.5, remaining: 1, changes: 2, summary: 'Strong.' })
  assert.equal(p.flat_rounds, 2)
  assert.equal(p.sum_done, 1)
  const r = retryFeatures({ lab: 'vfx', kind: 'script-error', repairs: 1, sameAsLast: false, message: "attempt to index nil with 'Emit' (line 14)" })
  assert.deepEqual([r.k_script, r.has_line, r.nil_index], [1, 1, 1])
})

// ------------------------------------------------------------------ GatingService

const crit = (lab: 'vfx' | 'anim', entryId: string, iteration: number, frames: Buffer[], previousScore: number | null) => ({ lab, entryId, iteration, frames, previousScore, changes: 2, threshold: 7.5 })

test('service shadow mode: logs "would skip", does not skip, labels the example from the next score', async () => {
  const dir = await tmp()
  const { svc } = service(dir)
  assert.equal((await svc.beforeCritique(crit('vfx', 'e1', 1, [blob(20), blob(30)], null))).skip, false)
  await svc.afterCritique({ lab: 'vfx', entryId: 'e1', iteration: 1, score: 6, threshold: 7.5, remaining: 3, changes: 2 })
  const r = await svc.beforeCritique(crit('vfx', 'e1', 2, [blob(20), blob(30)], 6))
  assert.equal(r.skip, false)
  await svc.afterCritique({ lab: 'vfx', entryId: 'e1', iteration: 2, score: 6.05, threshold: 7.5, remaining: 2, changes: 2 })
  const v = await svc.view({ lab: 'vfx' })
  const skip = v.decisions.find((d) => d.gate === 'critic-skip')!
  assert.equal(skip.outcome, 'would skip critic')
  assert.equal(skip.acted, false)
  assert.equal(skip.mode, 'shadow')
  assert.ok(skip.tokensSaved > 2000)
  assert.equal(v.costs.find((c) => c.lab === 'vfx')!.wouldSave, skip.tokensSaved + v.decisions.filter((d) => d.gate === 'plateau').reduce((s, d) => s + d.tokensSaved, 0))
  await svc.flush()
  const ex = JSON.parse(await readFile(join(dir, 'examples-critic-skip.json'), 'utf8')) as Example[]
  assert.equal(ex.length, 1)
  // The critique moved the score by 0.05: it did not matter (label 0); the heuristic said skip (0).
  assert.deepEqual([ex[0].label, ex[0].heuristic], [0, 0])
  const pl = JSON.parse(await readFile(join(dir, 'examples-plateau.json'), 'utf8')) as Example[]
  assert.equal(pl[0].label, 0)
  assert.equal(v.models.find((m) => m.type === 'critic-skip')!.state, 'learning')
})

test('service on: skips the critic and stops on a plateau; off: nothing logged', async () => {
  const { svc } = service(await tmp(), { gates: 'on' })
  await svc.beforeCritique(crit('anim', 'e2', 1, [blob(10)], null))
  await svc.afterCritique({ lab: 'anim', entryId: 'e2', iteration: 1, score: 6.8, threshold: 7.5, remaining: 3, changes: 2 })
  assert.equal((await svc.beforeCritique(crit('anim', 'e2', 2, [blob(44)], 6.8))).skip, false)
  await svc.afterCritique({ lab: 'anim', entryId: 'e2', iteration: 2, score: 6.9, threshold: 7.5, remaining: 2, changes: 2 })
  assert.equal((await svc.beforeCritique(crit('anim', 'e2', 3, [blob(20)], 6.9))).skip, false)
  const stop = await svc.afterCritique({ lab: 'anim', entryId: 'e2', iteration: 3, score: 6.95, threshold: 7.5, remaining: 1, changes: 2 })
  assert.equal(stop.stop, true)
  const skip = await svc.beforeCritique(crit('anim', 'e2', 4, [blob(20)], 6.95))
  assert.equal(skip.skip, true)
  const v = await svc.view({ entryId: 'e2' })
  assert.ok(v.decisions.some((d) => d.outcome === 'skipped critic' && d.acted))
  assert.ok(v.decisions.some((d) => d.outcome === 'stopped early' && d.acted))
  assert.ok(v.costs.find((c) => c.lab === 'anim')!.saved > 0)
  svc.endRun('anim', 'e2')

  const off = service(await tmp(), { gates: 'off' }).svc
  await off.beforeCritique(crit('vfx', 'e3', 1, [blob(20)], null))
  assert.equal((await off.beforeCritique(crit('vfx', 'e3', 2, [blob(20)], 6))).skip, false)
  assert.equal((await off.retry({ lab: 'vfx', message: 'no script in the answer', repairs: 0 })).outcome, 'give-up')
  assert.equal((await off.view()).decisions.length, 0)
})

test('service retry: shadow keeps the v0.5 route and logs the gate, on takes the gate route', async () => {
  const sh = service(await tmp()).svc
  const a = await sh.retry({ lab: 'vfx', message: 'no script in the answer', repairs: 0, kind: 'no-script' })
  assert.equal(a.outcome, 'give-up')
  const d = (await sh.view()).decisions[0]
  assert.equal(d.outcome, 'would rephrase (did give-up)')
  assert.equal(d.acted, false)
  const { svc: on } = service(await tmp(), { gates: 'on' })
  const b = await on.retry({ lab: 'anim', message: 'no script in the answer', repairs: 0, kind: 'no-script' })
  assert.equal(b.outcome, 'rephrase')
  assert.ok(b.ticket)
  on.retryResult(b.ticket, true)
  // A recorded "script error" that is really a Lune timeout is not repaired when on.
  const c = await on.retry({ lab: 'anim', message: 'Lune timed out after 20000 ms', repairs: 0, kind: 'script-error' })
  assert.equal(c.outcome, 'give-up')
  assert.equal((await on.view()).decisions[0].tokensSaved > 0, true)
  await on.flush()
})

test('service decision models: learn in shadow, override only when active and models are on, else heuristic', async () => {
  const dir = await tmp()
  const clock = { t: 10_000 }
  const { svc, set } = service(dir, { gates: 'on', models: 'shadow', minExamples: 20 }, clock)
  // Teach it: every critique after a small change still mattered (the heuristic would skip those).
  for (let k = 0; k < 40; k++) {
    const id = `m${k}`
    await svc.beforeCritique(crit('vfx', id, 1, [blob(20)], null))
    await svc.afterCritique({ lab: 'vfx', entryId: id, iteration: 1, score: 5, threshold: 9, remaining: 3, changes: 2 })
    // Alternate: unchanged frames that still moved the score, and changed frames that did not.
    const same = k % 2 === 0
    const r = await svc.beforeCritique(crit('vfx', id, 2, [same ? blob(20) : blob(44)], 5))
    if (r.skip) continue
    await svc.afterCritique({ lab: 'vfx', entryId: id, iteration: 2, score: same ? 6 : 5.05, threshold: 9, remaining: 2, changes: 2 })
    svc.endRun('vfx', id)
  }
  // In gates-on mode the heuristic skipped the unchanged ones, so only the changed rounds labelled.
  let st = (await svc.view()).models.find((m) => m.type === 'critic-skip')!
  assert.equal(st.state, 'learning')
  // Shadow gates: every critique runs and labels.
  set({ gates: 'shadow' })
  for (let k = 0; k < 60; k++) {
    const id = `s${k}`
    await svc.beforeCritique(crit('vfx', id, 1, [blob(20)], null))
    await svc.afterCritique({ lab: 'vfx', entryId: id, iteration: 1, score: 5, threshold: 9, remaining: 3, changes: 2 })
    const same = k % 2 === 0
    await svc.beforeCritique(crit('vfx', id, 2, [same ? blob(20) : blob(44)], 5))
    await svc.afterCritique({ lab: 'vfx', entryId: id, iteration: 2, score: same ? 6 : 5.05, threshold: 9, remaining: 2, changes: 2 })
    svc.endRun('vfx', id)
  }
  await svc.retrain()
  st = (await svc.view()).models.find((m) => m.type === 'critic-skip')!
  assert.equal(st.state, 'active', JSON.stringify(st))
  assert.ok(st.modelAcc! > st.heuristicAcc!)
  // Models shadow: the heuristic still decides, the model's view is logged.
  set({ gates: 'on', models: 'shadow' })
  await svc.beforeCritique(crit('vfx', 'q1', 1, [blob(20)], null))
  await svc.afterCritique({ lab: 'vfx', entryId: 'q1', iteration: 1, score: 5, threshold: 9, remaining: 3, changes: 2 })
  const h = await svc.beforeCritique(crit('vfx', 'q1', 2, [blob(20)], 5))
  assert.equal(h.skip, true)
  let d = (await svc.view({ entryId: 'q1' })).decisions.find((x) => x.gate === 'critic-skip')!
  assert.equal(d.by, 'code')
  assert.equal(d.modelSays, 'critique')
  // Models on + active: the model overrides (this critique is worth it).
  set({ models: 'on' })
  await svc.beforeCritique(crit('vfx', 'q2', 1, [blob(20)], null))
  await svc.afterCritique({ lab: 'vfx', entryId: 'q2', iteration: 1, score: 5, threshold: 9, remaining: 3, changes: 2 })
  const m = await svc.beforeCritique(crit('vfx', 'q2', 2, [blob(20)], 5))
  assert.equal(m.skip, false)
  d = (await svc.view({ entryId: 'q2' })).decisions.find((x) => x.gate === 'critic-skip')!
  assert.equal(d.by, 'model')
  // Raise the bar above the labelled count: back to the heuristic (fallback).
  set({ minExamples: 1000 })
  await svc.beforeCritique(crit('vfx', 'q3', 1, [blob(20)], null))
  await svc.afterCritique({ lab: 'vfx', entryId: 'q3', iteration: 1, score: 5, threshold: 9, remaining: 3, changes: 2 })
  assert.equal((await svc.beforeCritique(crit('vfx', 'q3', 2, [blob(20)], 5))).skip, true)
  // The model persists and is reloaded by a fresh service.
  await svc.flush()
  const again = service(dir, { gates: 'on', models: 'on', minExamples: 20 }).svc
  assert.equal((await again.view()).models.find((x) => x.type === 'critic-skip')!.state, 'active')
  // A corrupt model file is ignored (heuristic decides).
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(dir, 'model-critic-skip.json'), '{"version":1,"garbage":true}')
  const fresh = service(dir, { gates: 'on', models: 'on', minExamples: 20 }).svc
  await fresh.beforeCritique(crit('vfx', 'q4', 1, [blob(20)], null))
  await fresh.afterCritique({ lab: 'vfx', entryId: 'q4', iteration: 1, score: 5, threshold: 9, remaining: 3, changes: 2 })
  assert.equal((await fresh.beforeCritique(crit('vfx', 'q4', 2, [blob(20)], 5))).skip, true)
})

test('service costs: a run charges per tier, compose charges wait for the entry id, kept marks it', async () => {
  const dir = await tmp()
  const { svc } = service(dir)
  await svc.withRun('vfx', undefined, async () => {
    await svc.charge('default', { input: 3000, output: 1500, costUsd: 0.05 })
    svc.attach('fx1')
    // Background work started inside the run is still charged to it.
    await new Promise((r) => setTimeout(r, 5))
    await svc.charge('critic', { input: 5000, output: 600, costUsd: 0.08 })
  })
  // Outside a run: ignored.
  await svc.charge('critic', { input: 1, output: 1, costUsd: 1 })
  await new Promise((r) => setTimeout(r, 5))
  let row = (await svc.view()).costs.find((c) => c.lab === 'vfx')!
  assert.equal(row.runs, 1)
  assert.equal(row.costUsd, 0.13)
  await svc.kept('vfx', 'fx1', true)
  row = (await svc.view()).costs.find((c) => c.lab === 'vfx')!
  assert.equal(row.costPerKept, 0.13)
  await svc.flush()
  const reload = service(dir).svc
  assert.equal((await reload.view()).costs.find((c) => c.lab === 'vfx')!.kept, 1)
  await reload.reset()
  assert.equal((await reload.view()).costs.find((c) => c.lab === 'vfx')!.runs, 0)
})

test('principle weights: shadow logs the would-be change and keeps the critics neutral; on applies', async () => {
  const { svc, set } = service(await tmp())
  const p = new PrincipleService({ dir: await tmp(), gate: svc })
  await p.record({ lab: 'anim', entryId: 'a1', name: 'Punch', rating: 'down', scores: { arcs: 3, anticipation: 8, timing: 7 }, notes: 'floaty' })
  assert.deepEqual(await p.weights(), {})
  assert.ok(Object.keys((await p.profile()).weights).length > 0)
  const d = (await svc.view()).decisions.find((x) => x.gate === 'principle-weights')!
  assert.equal(d.outcome, 'would apply')
  assert.match(d.inputs, /arcs 1\.00→/)
  set({ gates: 'on' })
  assert.ok(Object.keys(await p.weights()).length > 0)
  // Off = the v0.5 behaviour (applied, not logged).
  set({ gates: 'off' })
  assert.ok(Object.keys(await p.weights()).length > 0)
  // Without a gate the service behaves as before.
  const plain = new PrincipleService({ dir: await tmp() })
  await plain.record({ lab: 'vfx', entryId: 'v1', rating: 'down', scores: { 'fx-timing': 3, 'fx-contrast': 8 } })
  assert.ok(Object.keys(await plain.weights()).length > 0)
})

// ------------------------------------------------------------------ loop hook + IPC wrappers

test('refineLoop: shouldStop ends the loop as "plateau" and is not asked on the last round', async () => {
  const fx = effectFromSpec({ name: 'T', layers: [{ name: 'Core', class: 'ParticleEmitter', props: { Rate: 10 } }] })
  const crit = (overall: number): VfxCritique => ({ scores: { readability: overall, layering: overall, timing: overall, color: overall, silhouette: overall, performance: overall }, overall, summary: '', changes: [{ node: 'Core', prop: 'Rate', value: 10 + overall }], references: [] })
  const asked: number[] = []
  const r = await refineLoop(fx, { render: async (_e, n) => [`f${n}`], critique: async (_e, _f, n) => crit(5 + n * 0.1), shouldStop: async (_c, n) => (asked.push(n), n === 2) }, { maxIterations: 5, threshold: 9 })
  assert.equal(r.stop, 'plateau')
  assert.equal(r.iterations.length, 2)
  const last: number[] = []
  await refineLoop(fx, { render: async (_e, n) => [`f${n}`], critique: async (_e, _f, n) => crit(5 + n), shouldStop: async (_c, n) => (last.push(n), false) }, { maxIterations: 2, threshold: 9 })
  assert.deepEqual(last, [1])
})

test('gating wiring: settings round trip, compose runs attach the entry, ratings and exports mark kept', async () => {
  const store = new Map<string, unknown>()
  const w = createGatingWiring({ userDataDir: await tmp(), settings: { get: (k, f) => (store.has(k) ? (store.get(k) as never) : f), set: (k, v) => void store.set(k, v) }, emit: () => {} })
  assert.deepEqual(await w.handlers.labGatingSet({ gates: 'on', models: 'bogus' }), { gates: 'on', models: 'shadow', minExamples: 50 })
  assert.equal(((await w.handlers.labGatingView()) as { settings: GatingSettings }).settings.gates, 'on')
  const hs = w.wrap('anim', {
    animCompose: async () => {
      await w.service.charge('default', { input: 100, output: 50, costUsd: 0.01 })
      return { ok: true, entry: { id: 'clip1' } }
    },
    animExport: async (id: string) => ({ id }),
    animRate: async () => ({})
  })
  await hs.animCompose('a punch')
  await new Promise((r) => setTimeout(r, 5))
  await hs.animExport('clip1')
  let row = ((await w.handlers.labGatingView()) as { costs: { lab: string; kept: number; costPerKept: number | null }[] }).costs.find((c) => c.lab === 'anim')!
  assert.deepEqual([row.kept, row.costPerKept], [1, 0.01])
  await hs.animRate('clip1', 'down')
  row = ((await w.handlers.labGatingView()) as { costs: { lab: string; kept: number; costPerKept: number | null }[] }).costs.find((c) => c.lab === 'anim')!
  assert.equal(row.kept, 0)
  assert.equal(resultEntryId({ entry: { id: 'x' } }), 'x')
  assert.equal(resultEntryId({ id: 'y' }), 'y')
  assert.equal(resultEntryId(null), null)
  await w.service.flush()
})

// ------------------------------------------------------------------ lab service integration


test('VFX Lab refine with gates: unchanged frames skip the critic when on, still run in shadow', async () => {
  const spec = { name: 'GateSlash', tags: ['slash'], layers: [{ name: 'Core', class: 'ParticleEmitter' as const, props: { Rate: 20, LightEmission: 0.2 } }] }
  const frame = blob(20)
  const run = async (gates: 'on' | 'shadow') => {
    const { svc: gate } = service(await tmp(), { gates })
    let shots = 0
    const vision = async () => {
      shots++
      return JSON.stringify({ scores: { readability: 5, layering: 5, timing: 5, color: 5, silhouette: 5, performance: 10 }, summary: 'Core too dim.', changes: [{ node: 'Core', prop: 'LightEmission', value: 0.2 + shots * 0.1 }] })
    }
    const lab = new VfxService({ userDir: await tmp(), projectRoot: () => null, lune: async () => ({ error: 'x' }), runtimeDir: () => null, capture: async (req) => req.times.map(() => frame), vision: () => vision, gate })
    const { entry } = await lab.create(spec)
    const r = await lab.refine(entry.id, { maxIterations: 4, threshold: 9, frames: 2 })
    return { r, shots, view: await gate.view({ entryId: entry.id }) }
  }
  const on = await run('on')
  assert.equal(on.shots, 1)
  assert.equal(on.r.stop, 'no-changes')
  assert.match(on.r.iterations[1].critique.summary, /^Critic skipped/)
  assert.ok(on.view.decisions.some((d) => d.gate === 'critic-skip' && d.acted))
  const shadow = await run('shadow')
  assert.ok(shadow.shots >= 3, `shadow ran ${shadow.shots} critiques`)
  assert.ok(shadow.view.decisions.some((d) => d.outcome === 'would skip critic' && !d.acted))
})

test('service decision models keep retraining once the example log is full (MAX_EXAMPLES)', async () => {
  const { writeFile, mkdir } = await import('node:fs/promises')
  const { MAX_EXAMPLES, RETRAIN_EVERY } = await import('../src/main/services/gating/service.ts')
  const dir = await tmp()
  await mkdir(dir, { recursive: true })
  const full: Example[] = Array.from({ length: MAX_EXAMPLES }, (_, i) => ({ id: `x-old-${i}`, at: i, features: { repairs: i % 2, sameAsLast: (i >> 1) % 2 }, heuristic: 1, label: i % 2 }))
  const model = trainDecisionModel('retry', ['no', 'yes'], full, 5)!
  await writeFile(join(dir, 'examples-retry.json'), JSON.stringify(full))
  await writeFile(join(dir, 'model-retry.json'), JSON.stringify(model))
  const { svc } = service(dir, { gates: 'on' }, { t: 1_000_000 })
  for (let k = 0; k < RETRAIN_EVERY; k++) {
    const r = await svc.retry({ lab: 'vfx', entryId: `e${k}`, message: 'parse error: unexpected token', repairs: 0, kind: 'parse' })
    assert.ok(r.ticket)
    svc.retryResult(r.ticket, k % 2 === 0)
    await new Promise((res) => setTimeout(res, 5))
  }
  await svc.flush()
  const st = (await svc.view()).models.find((m) => m.type === 'retry')!
  assert.ok(st.trainedAt! > 5, `retrained (trainedAt ${st.trainedAt})`)
})
