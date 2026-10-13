// Video references: beat detection, flashes, segmentation, palette, glow, motion and the animation
// timeline on synthetic frame sequences; the prompt assembly (vision summary, compose block, critic
// match); the style hints; and the library round trip through RefService (VFX and Animation Lab
// stores, compose with a pinned reference, critique with the match score).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeFrames, animPhases, beatFractions, colorDistance, detectFlashes, detectPeaks, extractPalette, frameBloom, keyFrameIndices, measureFrames, motionSummary, motionTimeline, paletteMatch, segmentIndices, sheetIndices, sheetLayout, stageFractions, timingMatch, toGrid } from '../src/shared/videoref/analyze.ts'
import { blendMatch, parseMatch, parseRefVision, refComposeBlock, refCritiqueBlock, refVisionPrompt, sanitizeAnalysis, videoHintNote, videoHints } from '../src/shared/videoref/prompt.ts'
import type { RgbaFrame, VideoRef } from '../src/shared/videoref/types.ts'

// ------------------------------------------------------------------ synthetic frames

type Rgb = [number, number, number]
function blank(w: number, h: number, bg: Rgb = [8, 8, 12]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) d.set([...bg, 255], i * 4)
  return d
}
// A disc of colour c (radius r) with an optional soft halo of `halo` pixels.
function disc(d: Uint8ClampedArray, w: number, h: number, cx: number, cy: number, r: number, c: Rgb, halo = 0): void {
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dist = Math.hypot(x - cx, y - cy)
      let a = dist <= r ? 1 : halo > 0 && dist <= r + halo ? 1 - (dist - r) / halo : 0
      if (a <= 0) continue
      if (dist > r) a *= 0.75
      const i = (y * w + x) * 4
      for (let k = 0; k < 3; k++) d[i + k] = Math.max(d[i + k], Math.round(c[k] * a))
    }
}
const frame = (t: number, w: number, h: number, data: Uint8ClampedArray): RgbaFrame => ({ t, width: w, height: h, data })

// A fireball: a small orb charges at the left (frames 0-9), flies right (10-13), a white flash
// (14), an orange burst (15-17) that fades (18-29). 24 fps, 96 x 54.
function fireball(): RgbaFrame[] {
  const W = 96
  const H = 54
  const out: RgbaFrame[] = []
  for (let i = 0; i < 30; i++) {
    const d = blank(W, H)
    if (i < 10) disc(d, W, H, 14, 27, 3 + i * 0.15 + (i % 2) * 0.3, [255, 140, 40], 2)
    else if (i < 14) disc(d, W, H, 14 + (i - 9) * 14, 27, 5, [255, 170, 60], 3)
    else if (i === 14) d.fill(250)
    else {
      const k = i - 15
      const fade = Math.max(0.05, 1 - k / 14)
      disc(d, W, H, 72, 27, 8 + k * 1.5, [Math.round(255 * fade), Math.round(110 * fade), Math.round(20 * fade)], 4)
    }
    out.push(frame(i / 24, W, H, d))
  }
  return out
}

test('detectPeaks finds energy peaks with a minimum gap', () => {
  const times = Array.from({ length: 40 }, (_, i) => i / 20)
  const e = times.map((_, i) => (i === 8 ? 0.5 : i === 9 ? 0.4 : i === 25 ? 0.8 : 0.02))
  const p = detectPeaks(times, e)
  assert.equal(p.length, 2)
  assert.ok(Math.abs(p[0].t - 0.4) < 0.06)
  assert.equal(p[1].t, 1.25)
  assert.equal(p[1].strength, 1)
  assert.deepEqual(detectPeaks(times, times.map(() => 0)), [])
})

test('detectFlashes finds a one-frame brightness spike and merges neighbours', () => {
  const times = Array.from({ length: 20 }, (_, i) => i / 24)
  const b = times.map((_, i) => (i === 10 ? 0.7 : i === 11 ? 0.5 : 0.06))
  const f = detectFlashes(times, b)
  assert.equal(f.length, 1)
  assert.equal(f[0], Math.round((10 / 24) * 1000) / 1000)
  assert.deepEqual(detectFlashes(times, times.map(() => 0.3)), [])
})

test('segmentation: anticipation, release, impact, dissipate around the strongest moment', () => {
  const energy = [0, 0.01, 0.01, 0.02, 0.01, 0.02, 0.02, 0.15, 0.3, 0.45, 0.9, 0.6, 0.3, 0.12, 0.08, 0.05, 0.03, 0.02, 0.01, 0.01]
  const bright = energy.map((_, i) => (i === 10 ? 0.8 : 0.1))
  const segs = segmentIndices(energy, bright, [10])
  assert.deepEqual(segs.map((s) => s.label), ['anticipation', 'release', 'impact', 'dissipate'])
  const impact = segs.find((s) => s.label === 'impact')!
  assert.ok(impact.from === 10, `impact starts on the flash (${impact.from})`)
  const ant = segs[0]
  assert.ok(ant.to >= 6 && ant.to <= 8, `anticipation ends before the energy rises (${ant.to})`)
  // Contiguous and covering every frame.
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].from, segs[i - 1].to)
  assert.equal(segs[segs.length - 1].to, energy.length)
  // A still clip is one beat.
  assert.deepEqual(segmentIndices([0, 0, 0, 0], [0.1, 0.1, 0.1, 0.1]).map((s) => s.label), ['impact'])
})

test('analyzeFrames on a synthetic fireball: beats, flash, palette, glow, motion, key frames', () => {
  const frames = fireball()
  const a = analyzeFrames(frames)
  assert.equal(a.frames.length, 30)
  assert.ok(Math.abs(a.duration - 30 / 24) < 0.01)
  assert.ok(Math.abs(a.fps - 24) < 0.1)
  assert.equal(a.flashes.length, 1)
  assert.ok(Math.abs(a.flashes[0] - 14 / 24) < 0.01)
  const labels = a.segments.map((s) => s.label)
  assert.deepEqual(labels, ['anticipation', 'release', 'impact', 'dissipate'])
  const impact = a.segments.find((s) => s.label === 'impact')!
  assert.ok(impact.start <= a.flashes[0] && impact.end > a.flashes[0])
  const ant = a.segments[0]
  assert.ok(ant.end > 0.25 && ant.end <= 14 / 24, `anticipation covers the charge (${ant.end})`)
  // Orange dominates the palette; the flash adds white.
  const orange = a.palette.find((p) => colorDistance(p.hex, '#ff8c28') < 0.25)
  assert.ok(orange, `orange in ${JSON.stringify(a.palette)}`)
  // Motion: the orb travels right before the burst.
  assert.equal(a.motion.direction, 'right')
  assert.ok(a.motion.peakCoverage > 0.3, 'the flash frame changes the whole screen')
  // Key frames: one per beat, in order, inside their beats.
  assert.ok(a.keyFrames.length >= 4)
  for (const k of a.keyFrames.filter((x) => x.label !== 'flash')) {
    const s = a.segments.find((x) => x.label === k.label)!
    assert.ok(k.t >= s.start && k.t < s.end, `${k.label} key frame inside its beat`)
  }
  // Fractions sum to 1.
  const fr = beatFractions(a)
  assert.ok(Math.abs(fr.anticipation + fr.release + fr.impact + fr.dissipate - 1) < 0.01)
})

test('palette extraction: two colour regions on black', () => {
  const W = 40
  const H = 20
  const d = blank(W, H, [0, 0, 0])
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      if (x < 12) d.set([30, 90, 255], i)
      else if (x > 28) d.set([255, 60, 200], i)
    }
  const p = extractPalette([toGrid(frame(0, W, H, d))], 4)
  assert.ok(p.length >= 2 && p.length <= 4)
  assert.ok(p.some((c) => colorDistance(c.hex, '#1e5aff') < 0.08), JSON.stringify(p))
  assert.ok(p.some((c) => colorDistance(c.hex, '#ff3cc8') < 0.08), JSON.stringify(p))
  assert.ok(!p.some((c) => c.hex === '#000000'), 'black background left out')
  assert.ok(Math.abs(p.reduce((a, c) => a + c.share, 0) - 1) < 0.05)
})

test('glow: a soft halo reads as bloom, a hard edge does not', () => {
  const W = 64
  const H = 64
  const soft = blank(W, H, [0, 0, 0])
  disc(soft, W, H, 32, 32, 6, [255, 255, 255], 10)
  const hard = blank(W, H, [0, 0, 0])
  disc(hard, W, H, 32, 32, 6, [255, 255, 255], 0)
  const s = frameBloom(toGrid(frame(0, W, H, soft)))!
  const h = frameBloom(toGrid(frame(0, W, H, hard)))!
  assert.ok(s.bloom > 0.5, `soft ${s.bloom}`)
  assert.ok(h.bloom < 0.2, `hard ${h.bloom}`)
  assert.equal(frameBloom(toGrid(frame(0, W, H, blank(W, H)))), null)
})

test('motion: travel direction and an expanding ring', () => {
  const W = 80
  const H = 45
  const up: RgbaFrame[] = Array.from({ length: 12 }, (_, i) => {
    const d = blank(W, H)
    disc(d, W, H, 40, 38 - i * 3, 4, [200, 220, 255])
    return frame(i / 24, W, H, d)
  })
  assert.equal(motionSummary(measureFrames(up), W / H).direction, 'up')
  const ring: RgbaFrame[] = Array.from({ length: 12 }, (_, i) => {
    const d = blank(W, H)
    const r = 3 + i * 2
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) if (Math.abs(Math.hypot(x - 40, y - 22) - r) < 1.2) d.set([120, 255, 160, 255], (y * W + x) * 4)
    return frame(i / 24, W, H, d)
  })
  const m = motionSummary(measureFrames(ring), W / H)
  assert.equal(m.direction, 'outward')
  assert.ok(m.travel < 0.06)
  assert.equal(motionSummary(measureFrames([frame(0, W, H, blank(W, H)), frame(0.1, W, H, blank(W, H))])).direction, 'still')
})

test('animation timeline: holds versus fast motion', () => {
  const times = Array.from({ length: 24 }, (_, i) => i / 24)
  // hold, a fast swing, a hold on the hit, a slow recovery.
  const e = times.map((_, i) => (i < 6 ? 0.001 : i < 10 ? 0.2 : i < 15 ? 0.001 : 0.05))
  const tl = motionTimeline(times, e, 1)
  assert.deepEqual(tl.map((s) => s.kind), ['hold', 'fast', 'hold', 'move'])
  assert.equal(tl[0].start, 0)
  assert.equal(tl[tl.length - 1].end, 1)
  // A one-frame dip inside fast motion is not a hold.
  const e2 = times.map((_, i) => (i === 12 ? 0.001 : 0.2))
  assert.ok(!motionTimeline(times, e2, 1).some((s) => s.kind === 'hold'))
  const ph = animPhases({ segments: [{ label: 'anticipation', start: 0, end: 0.3, peak: 0.2, energy: 0.1, palette: [] }, { label: 'release', start: 0.3, end: 0.4, peak: 0.35, energy: 1, palette: [] }, { label: 'impact', start: 0.4, end: 0.5, peak: 0.45, energy: 0.8, palette: [] }, { label: 'dissipate', start: 0.5, end: 1, peak: 0.6, energy: 0.2, palette: [] }], timeline: tl })
  assert.equal(ph.anticipation, 0.3)
  assert.equal(ph.action, 0.2)
  assert.equal(ph.recovery, 0.5)
  assert.ok(ph.holds > 0.4)
})

test('key frames, contact sheet indices and layout', () => {
  const energy = [0, 0.1, 0.1, 0.5, 1, 0.4, 0.1, 0.05]
  const k = keyFrameIndices([{ label: 'anticipation', from: 0, to: 3 }, { label: 'release', from: 3, to: 4 }, { label: 'impact', from: 4, to: 6 }, { label: 'dissipate', from: 6, to: 8 }], energy, [4])
  assert.deepEqual(k.map((x) => x.label), ['anticipation', 'release', 'impact', 'dissipate'])
  assert.deepEqual(k.map((x) => x.index), [2, 3, 4, 6])
  const idx = sheetIndices(60, [7, 33], 12)
  assert.equal(idx.length, 12)
  assert.ok(idx.includes(7) && idx.includes(33) && idx[0] === 0 && idx[idx.length - 1] === 59)
  assert.deepEqual(sheetIndices(5, [], 12), [0, 1, 2, 3, 4])
  const l = sheetLayout(12, 320, 180)
  assert.equal(l.cols, 4)
  assert.equal(l.rows, 3)
  assert.equal(l.cellW, 283)
  assert.equal(l.cellH, 159)
  assert.ok(l.width <= 1152)
  assert.equal(sheetLayout(3, 200, 100).cellW, 200)
})

test('match scores: timing fractions and palette', () => {
  const ref = { anticipation: 0.4, release: 0.1, impact: 0.15, dissipate: 0.35 }
  assert.equal(timingMatch(ref, ref), 10)
  assert.ok(timingMatch(ref, { anticipation: 0, release: 0, impact: 1, dissipate: 0 }) < 3)
  const st = stageFractions([{ at: 0, label: 'charge' }, { at: 0.4, label: 'release' }, { at: 0.5, label: 'impact' }, { at: 0.65, label: 'dissipate' }], 1)!
  assert.ok(timingMatch(ref, st) > 9)
  assert.equal(stageFractions([], 1), null)
  const pal = [{ hex: '#ff8800', share: 0.6 }, { hex: '#ffffff', share: 0.4 }]
  assert.ok(paletteMatch(pal, ['#ff8a05', '#fefefe']) > 9)
  assert.ok(paletteMatch(pal, ['#0022ff']) < 4)
})

// ------------------------------------------------------------------ prompts

function sampleRef(lab: 'vfx' | 'anim' = 'vfx'): VideoRef {
  const analysis = analyzeFrames(fireball())
  return { lab, source: { name: 'fireball.webm', mime: 'video/webm', bytes: 1234, width: 96, height: 54, duration: 2 }, trim: { start: 0.2, end: 1.45 }, analysis, sheet: 'ref/sheet.png' }
}

test('prompt assembly: vision request, compose block, critic match', () => {
  const ref = sampleRef()
  const vp = refVisionPrompt(ref, 'Fireball', ['anticipation', 'impact'])
  assert.match(vp, /contact sheet/)
  assert.match(vp, /2 = anticipation, 3 = impact/)
  assert.match(vp, /Palette: #/)
  ref.vision = parseRefVision('```json\n{"summary":"An orange orb charges, flies right and bursts.","effect":"fireball","layers":[{"name":"core","shape":"orb","color":"white-orange"},{"name":"sparks"}],"shapes":["orb","burst"],"roblox":"ParticleEmitter core with LightEmission 1"}\n```', 5)
  assert.equal(ref.vision.layers?.length, 2)
  assert.equal(ref.vision.at, 5)
  const block = refComposeBlock(ref, 'Fireball', { keyLabels: ['anticipation', 'release', 'impact', 'dissipate'], notes: 'keep the flash short' })
  assert.match(block, /pinned reference video "Fireball"/)
  assert.match(block, /anticipation 0\.00-/)
  assert.match(block, /fx:stage/)
  assert.match(block, /Palette overall: #/)
  assert.match(block, /Flash frames at/)
  assert.match(block, /Vision summary: An orange orb/)
  assert.match(block, /Layers: core \(orb\), white-orange; sparks/)
  assert.match(block, /keep the flash short/)
  assert.match(block, /attached images are the reference's key frames in order: anticipation, release, impact, dissipate/)
  const anim = refComposeBlock({ ...ref, lab: 'anim', vision: parseRefVision('{"summary":"A big wind-up punch.","poses":[{"beat":"anticipation","pose":"coiled back, fist by the ear"}],"timing":"snappy"}') }, 'Punch')
  assert.match(anim, /As animation timing: anticipation/)
  assert.match(anim, /Holds versus fast motion/)
  assert.match(anim, /Poses per beat: anticipation: coiled back/)
  assert.doesNotMatch(anim, /fx:stage/)
  const crit = refCritiqueBlock(ref, 'Fireball', ['impact'])
  assert.match(crit, /Pinned reference "Fireball"/)
  assert.deepEqual(parseMatch('{"scores":{},"match":7.46,"matchNotes":"burst too small"}'), { match: 7.5, notes: 'burst too small' })
  assert.equal(parseMatch('{"scores":{}}'), null)
  assert.equal(parseMatch('no json'), null)
  assert.equal(blendMatch(8, 4), 6.6)
  // Prose without JSON still becomes a summary.
  assert.equal(parseRefVision('A blue slash.').summary, 'A blue slash.')
  assert.throws(() => parseRefVision('  '))
})

test('style hints: timing and palette from usable video references only', () => {
  const ref = sampleRef()
  const entries = [
    { tags: ['fire'], video: ref },
    { tags: ['fire'], video: ref, quality: 'avoid' },
    { tags: ['ice'], video: ref },
    { tags: ['fire'] }
  ]
  const h = videoHints('fire', entries)!
  assert.equal(h.samples, 1)
  assert.ok(h.beats.anticipation > 0.2)
  assert.ok(h.palette.length >= 1)
  assert.match(videoHintNote(h, 'vfx'), /From 1 video reference \(timing and palette only\)/)
  assert.match(videoHintNote(h, 'anim'), /timing only, not poses/)
  assert.equal(videoHints('slash', entries), null)
  assert.equal(videoHints('*', entries)!.samples, 2)
})

test('sanitizeAnalysis bounds renderer data', () => {
  const a = sampleRef().analysis
  const clean = sanitizeAnalysis(JSON.parse(JSON.stringify(a)))
  assert.deepEqual(clean.segments.map((s) => s.label), a.segments.map((s) => s.label))
  assert.equal(clean.palette.length, a.palette.length)
  const junk = sanitizeAnalysis({ duration: 2, segments: [{ label: 'bogus' }, { label: 'impact', start: -5, end: 99 }], palette: [{ hex: 'red' }, { hex: '#AABBCC', share: 3 }], motion: { direction: 'sideways' }, glow: { level: 'max' } })
  assert.deepEqual(junk.segments.map((s) => [s.label, s.start, s.end]), [['impact', 0, 2]])
  assert.deepEqual(junk.palette, [{ hex: '#aabbcc', share: 1 }])
  assert.equal(junk.motion.direction, 'still')
  assert.equal(junk.glow.level, 'none')
  assert.throws(() => sanitizeAnalysis({ duration: 0 }))
  assert.throws(() => sanitizeAnalysis(null))
})

// ------------------------------------------------------------------ library round trip

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function saveInput(lab: 'vfx' | 'anim', name: string, tags: string[] = []) {
  const analysis = analyzeFrames(fireball())
  return {
    lab,
    name,
    tags,
    notes: 'the burst is the money shot',
    source: { name: `${name}.webm`, mime: 'video/webm', bytes: 4, width: 96, height: 54, duration: 2 },
    sourceData: new Uint8Array([26, 69, 223, 163]),
    trim: { start: 0.25, end: 1.5 },
    analysis,
    sheet: PNG,
    keyFrames: analysis.keyFrames.map((k) => ({ t: k.t, label: k.label, index: k.index, png: PNG })),
    describe: false
  }
}

async function services(root: string, model?: (tier: string) => ((system: string, prompt: string, images: { mime: string; base64: string }[]) => Promise<string>) | null) {
  const { VfxService } = await import('../src/main/services/vfx/service.ts')
  const { AnimService } = await import('../src/main/services/anim/service.ts')
  const { RefService } = await import('../src/main/services/videoref/service.ts')
  const lune = async () => ({ error: 'no lune in tests' })
  const vfx = new VfxService({ userDir: join(root, 'vfx'), projectRoot: () => null, lune, runtimeDir: () => null, vision: model as never, now: () => 1000 })
  const anim = new AnimService({ userDir: join(root, 'anim'), projectRoot: () => null, lune, runtimeDir: () => null, model: model as never, now: () => 1000 })
  const events: string[] = []
  const refs = new RefService({ vfx, anim, model: model as never, emit: (e) => void events.push(e), now: () => 2000 })
  return { vfx, anim, refs, events }
}

test('library round trip: a VFX video reference is a media entry with files, analysis and notes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'videoref-'))
  try {
    const { vfx, refs, events } = await services(root)
    const saved = await refs.save(saveInput('vfx', 'Purple Burst', ['Magic']))
    assert.equal(saved.lab, 'vfx')
    assert.ok(saved.tags.includes('magic') && saved.tags.includes('video'))
    assert.deepEqual(events, ['vfx:changed'])
    const e = await vfx.get(saved.id)
    assert.equal(e.kind, 'media')
    assert.equal(e.notes, 'the burst is the money shot')
    assert.equal(e.video?.sheet, 'ref/sheet.png')
    assert.equal(e.video?.analysis.keyFrames.length, saved.video.analysis.keyFrames.length)
    assert.ok(e.video?.analysis.keyFrames.every((k) => k.file?.startsWith('ref/key-')))
    assert.deepEqual(e.media, [{ file: 'media/Purple_Burst.webm', mime: 'video/webm' }])
    assert.equal(e.video?.trim.start, 0.25)
    assert.match(e.description, /Video reference, 1\.25 s: anticipation > release > impact > dissipate/)
    assert.match((await refs.file(saved.id, 'ref/sheet.png'))!, /^data:image\/png;base64,/)
    assert.equal(await refs.file(saved.id, '../../escape.png'), null)
    // Lists, gets, survives a fresh service (on disk), and the lab APIs edit it.
    assert.deepEqual((await refs.list('vfx')).map((r) => r.id), [saved.id])
    assert.deepEqual(await refs.list('anim'), [])
    const again = await (await services(root)).refs.get(saved.id)
    assert.deepEqual(again.video.analysis.segments, e.video!.analysis.segments)
    await vfx.update(saved.id, { notes: 'shorter flash', tags: ['magic', 'video', 'burst'] })
    await vfx.rate(saved.id, 'up')
    const edited = await refs.get(saved.id)
    assert.equal(edited.notes, 'shorter flash')
    assert.equal(edited.rating, 'up')
    // Media entries cannot be rendered or sent to Studio.
    await assert.rejects(() => vfx.render(saved.id), /media reference/)
    await assert.rejects(() => refs.get('nope'), /no video reference/)
    await assert.rejects(() => refs.save({ ...saveInput('vfx', 'x'), sheet: 'data:image/jpeg;base64,AAAA' }), /PNG/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('library round trip: Animation Lab video reference is kept out of clips, feeds timing only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'videoref-anim-'))
  try {
    const { anim, refs } = await services(root)
    const ex = await anim.addExample('sign-push')
    const ref = await refs.save(saveInput('anim', 'Anime Punch', [...ex.tags.filter((t) => t !== 'example')]))
    const e = await anim.get(ref.id)
    assert.equal(e.kind, 'media')
    assert.equal(Object.keys(e.clip.tracks).length, 0)
    assert.deepEqual(e.clip.beats?.map((b) => b.label), ['anticipation', 'release', 'impact', 'dissipate'])
    assert.ok(!(await anim.listAnimClips()).some((c) => c.id === ref.id), 'not an Ability Composer clip')
    assert.ok(!(await anim.coverage()).tags.some((t) => t.clips > 1), 'not counted as a clip')
    await assert.rejects(() => anim.checks(ref.id), /video reference/)
    await assert.rejects(() => anim.refine(ref.id), /video reference/)
    await assert.rejects(() => anim.convert(ref.id, 'R6'), /video reference/)
    const { style } = await anim.learn()
    const tag = ex.tags.find((t) => t !== 'example' && style.profiles.some((p) => p.tag === t))!
    const p = style.profiles.find((x) => x.tag === tag)!
    assert.equal(p.samples, 1, 'the video is not a clip sample')
    assert.equal(p.video?.samples, 1)
    assert.ok(p.notes.some((n) => /From 1 video reference \(timing only, not poses\)/.test(n)))
    assert.deepEqual((await refs.list('anim')).map((r) => r.id), [ref.id])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('VFX recipes take timing and palette from tagged video references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'videoref-recipe-'))
  try {
    const { vfx, refs } = await services(root)
    const ex = await vfx.addExample('charge-slash')
    const tag = ex.tags.find((t) => !['sequence', 'example'].includes(t))!
    await refs.save(saveInput('vfx', 'Ref Slash', [tag]))
    const { recipes } = await vfx.learn()
    const r = recipes.find((x) => x.tag === tag)!
    assert.equal(r.samples, 1)
    assert.equal(r.video?.samples, 1)
    assert.ok(r.video!.palette.length > 0)
    assert.ok(r.notes.some((n) => n.startsWith('From 1 video reference (timing and palette only)')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('vision summary, compose with a pinned reference, and the critic match', async () => {
  const root = await mkdtemp(join(tmpdir(), 'videoref-model-'))
  const calls: { tier: string; system: string; prompt: string; images: number }[] = []
  const model = (tier: string) => async (system: string, prompt: string, images: { mime: string; base64: string }[]) => {
    calls.push({ tier, system, prompt, images: images.length })
    if (/breaking down a reference clip/.test(system)) return '{"summary":"A violet orb charges and bursts.","effect":"orb burst","layers":[{"name":"core","color":"white"}],"poses":[{"beat":"impact","pose":"arm fully extended"}]}'
    if (/senior Roblox VFX artist reviewing/.test(system) || /senior animator reviewing/.test(system)) return '{"scores":{"readability":8,"layering":8,"timing":8,"color":8,"silhouette":8,"performance":8,"weight":8,"arcs":8,"appeal":8,"cleanliness":8},"summary":"ok","changes":[],"match":4,"matchNotes":"the burst is too small"}'
    return 'no script here'
  }
  try {
    const { vfx, anim, refs } = await services(root, model)
    const saved = await refs.save(saveInput('vfx', 'Violet Orb'))
    const described = await refs.describe(saved.id)
    assert.equal(described.video.vision?.summary, 'A violet orb charges and bursts.')
    assert.match(described.description, /^A violet orb charges and bursts\./)
    const vcall = calls.find((c) => /breaking down/.test(c.system))!
    assert.equal(vcall.tier, 'critic')
    assert.equal(vcall.images, 1 + Math.min(4, saved.video.analysis.keyFrames.length), 'contact sheet + key frames')
    // Compose: the reference block and key frames reach the drafting model (Lune is missing, so the
    // compose itself fails after drafting).
    calls.length = 0
    await assert.rejects(() => vfx.compose('make it like this', { reference: saved.id, refine: false }), /Lune/)
    const ccall = calls.find((c) => c.tier === 'default')!
    assert.match(ccall.prompt, /pinned reference video "Violet Orb"/)
    assert.match(ccall.prompt, /Vision summary: A violet orb charges and bursts\./)
    assert.equal(ccall.images, Math.min(4, saved.video.analysis.keyFrames.length))
    await assert.rejects(() => vfx.compose('x x x', { reference: 'missing-ref' }), /no video reference/)
    // Critique of a result pinned to the reference: key frames after the rendered frames, match blended.
    const made = await vfx.addExample('charge-slash')
    const pinnedEntry = { ...made, refId: saved.id }
    calls.length = 0
    const c = await vfx.critique(pinnedEntry, made.effect!, [Buffer.from('frame')], [0.2], 1, null)
    assert.equal(c.match, 4)
    assert.equal(c.matchNotes, 'the burst is too small')
    assert.ok(c.overall < 8 && c.overall > 4, `blended ${c.overall}`)
    const crit = calls.find((x) => x.tier === 'critic')!
    assert.equal(crit.images, 1 + Math.min(4, saved.video.analysis.keyFrames.length))
    assert.match(crit.system, /reference video is pinned/)
    assert.match(crit.prompt, /Pinned reference "Violet Orb"/)
    // No vision model: the numbers-only match still scores it.
    const plain = await services(root)
    const h = await plain.vfx.critique(pinnedEntry, made.effect!, [], [], 1, null)
    assert.ok(typeof h.match === 'number' && h.match >= 0 && h.match <= 10)
    assert.match(h.matchNotes!, /Numbers-only match/)
    // Animation Lab: same flow.
    const aref = await refs.save(saveInput('anim', 'Punch Ref'))
    const clip = await anim.addExample('dash-punch')
    calls.length = 0
    const ac = await anim.critique({ ...clip, refId: aref.id }, clip.clip, [Buffer.from('f')], [0.3], 1, null)
    assert.equal(ac.match, 4)
    assert.equal(calls[0].images, 1 + Math.min(4, aref.video.analysis.keyFrames.length))
    await assert.rejects(() => anim.compose('like this', { reference: aref.id, refine: false }), /Lune/)
    assert.ok(calls.some((x) => x.tier === 'default' && /As animation timing/.test(x.prompt)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ref tools: list, get and import errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'videoref-tools-'))
  try {
    const { refs } = await services(root)
    const { refTools, REF_READ_TOOLS, REF_WRITE_TOOLS } = await import('../src/main/services/videoref/tools.ts')
    const t = refTools(refs)
    assert.deepEqual(t.read.map((x) => x.name), [...REF_READ_TOOLS])
    assert.deepEqual(t.write.map((x) => x.name), [...REF_WRITE_TOOLS])
    const tool = (n: string) => [...t.read, ...t.write].find((x) => x.name === n)!
    assert.match((await tool('ref_list').handler({}, null)).content[0].text, /No video references yet/)
    const saved = await refs.save(saveInput('vfx', 'Blue Wave'))
    assert.match((await tool('ref_list').handler({ query: 'blue' }, null)).content[0].text, new RegExp(saved.id))
    const got = (await tool('ref_get').handler({ id: saved.id }, null)).content[0].text
    assert.match(got, /beats: anticipation 0\.00-/)
    assert.match(got, /palette: #/)
    assert.match(got, /vfx_compose with reference/)
    const bad = await tool('ref_import').handler({ path: join(root, 'clip.avi') }, null)
    assert.ok(bad.isError)
    assert.match(bad.content[0].text, /unsupported file type/)
    const missing = await tool('ref_import').handler({ path: join(root, 'nope.mp4') }, null)
    assert.match(missing.content[0].text, /no such file/)
    // Decode tokens only serve registered files.
    assert.equal(await refs.sourceForToken('bogus'), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
