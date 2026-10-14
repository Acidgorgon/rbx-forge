// Thumbnail Lab: image stats, the 16:9 crop / resize, small-size report and code checks, style cards
// and profile aggregation, prompt assembly with the no-copy guard, the critic parser, CTR and taste,
// the thumbnail principles, the gating hooks, and the service end to end with a fake OpenAI, a fake
// vision model and a fake Open Cloud (generate, critique, pick-best, refine, rate, CTR, upload,
// experience thumbnail).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blank, type Rgba } from '../src/shared/vfx/tex/image.ts'
import { coverCrop, cropRgba, focalContrast, fromHex, imageStats, legibility, palette, smallSizeReport, toThumbnail, PAGE_DARK, PAGE_LIGHT, popAgainst } from '../src/shared/thumbs/stats.ts'
import { codeOverall, thumbChecks } from '../src/shared/thumbs/checks.ts'
import { aggregateProfile, cardFromStats, mergePalettes, parseStyleCard, profileSummary, scrubNames } from '../src/shared/thumbs/style.ts'
import { COPY_RULE, copyGuard, copyGuardFlags, criticPrompt, forbiddenTerms, generationPrompt, parseCritique, refinePrompt, scrubBrief, textCheck } from '../src/shared/thumbs/prompt.ts'
import { ctrLabels, ctrTotals, CtrError, formatCtr, normalizeCtr, wilson } from '../src/shared/thumbs/ctr.ts'
import { learnTaste, pickBest, rankScore, tasteLines, tasteSamples } from '../src/shared/thumbs/taste.ts'
import { batchOf, genSizeFor, thumbId, THUMB_RE } from '../src/shared/thumbs/size.ts'
import { THUMB_PRINCIPLES } from '../src/shared/principles/thumbCatalog.ts'
import { ALL_PRINCIPLES, principlesFor } from '../src/shared/principles/catalog.ts'
import { selectPrinciples } from '../src/shared/principles/select.ts'
import { restateSystem } from '../src/shared/restate/prompt.ts'
import { LAB_HANDLERS } from '../src/main/services/gating/wire.ts'
import { decodePng, encodePng } from '../src/main/services/vfx/textures/png.ts'
import { ThumbService } from '../src/main/services/thumbs/service.ts'
import { experienceThumbUrl, multipartFile } from '../src/main/services/thumbs/experience.ts'
import type { ArtFetch } from '../src/main/services/art/openaiImages.ts'
import type { Thumb, ThumbImageStats, SmallSizeReport } from '../src/shared/thumbs/types.ts'

const tmp = (p: string) => mkdtemp(join(tmpdir(), `forge-thumbs-${p}-`))

function fill(w: number, h: number, c: [number, number, number]): Rgba {
  const img = blank(w, h)
  for (let i = 0; i < w * h; i++) img.data.set([c[0], c[1], c[2], 255], i * 4)
  return img
}

function rect(img: Rgba, x0: number, y0: number, w: number, h: number, c: [number, number, number]): Rgba {
  for (let y = y0; y < Math.min(img.height, y0 + h); y++) for (let x = x0; x < Math.min(img.width, x0 + w); x++) img.data.set([c[0], c[1], c[2], 255], (y * img.width + x) * 4)
  return img
}

// A bold "poster": dark backdrop, a big saturated subject with a black outline in the middle,
// thick white bars as "text" in the top third.
function poster(w = 640, h = 360): Rgba {
  const img = fill(w, h, [20, 30, 90])
  rect(img, Math.round(w * 0.36), Math.round(h * 0.3), Math.round(w * 0.28), Math.round(h * 0.55), [0, 0, 0])
  rect(img, Math.round(w * 0.38), Math.round(h * 0.33), Math.round(w * 0.24), Math.round(h * 0.49), [255, 140, 0])
  for (let k = 0; k < 3; k++) rect(img, Math.round(w * (0.12 + k * 0.26)), Math.round(h * 0.06), Math.round(w * 0.2), Math.round(h * 0.14), [255, 255, 255])
  return img
}

// A busy, low-contrast "scene": thin 1px grey stripes everywhere.
function mush(w = 640, h = 360): Rgba {
  const img = fill(w, h, [120, 120, 120])
  for (let x = 0; x < w; x += 4) rect(img, x, 0, 1, h, [135, 135, 135])
  for (let y = 0; y < h; y += 5) rect(img, 0, y, w, 1, [108, 108, 108])
  return img
}

// ------------------------------------------------------------------ crop / resize

test('coverCrop: centred 16:9 crop from the generation sizes', () => {
  assert.deepEqual(coverCrop(1536, 1024), { x: 0, y: 80, width: 1536, height: 864 })
  assert.deepEqual(coverCrop(1920, 1088), { x: 0, y: 4, width: 1920, height: 1080 })
  assert.deepEqual(coverCrop(1024, 1024), { x: 0, y: 224, width: 1024, height: 576 })
  // Too wide: crop the sides.
  assert.deepEqual(coverCrop(3000, 1000), { x: 611, y: 0, width: 1778, height: 1000 })
})

test('cropRgba copies the rows of the rectangle; toThumbnail lands on 1920x1080, opaque', () => {
  const img = fill(8, 6, [0, 0, 0])
  rect(img, 2, 1, 3, 2, [255, 0, 0])
  const c = cropRgba(img, { x: 2, y: 1, width: 3, height: 2 })
  assert.equal(c.width, 3)
  assert.equal(c.height, 2)
  for (let i = 0; i < 6; i++) assert.deepEqual([...c.data.subarray(i * 4, i * 4 + 4)], [255, 0, 0, 255])
  const t = toThumbnail(poster(384, 256))
  assert.equal(t.width, 1920)
  assert.equal(t.height, 1080)
  for (let i = 3; i < t.data.length; i += 4 * 997) assert.equal(t.data[i], 255)
  // The 16:9 crop of a 3:2 image drops 20-row bands at the top and bottom.
  const banded = fill(384, 256, [0, 0, 255])
  rect(banded, 0, 0, 384, 20, [255, 0, 0])
  const tb = toThumbnail(banded)
  assert.deepEqual([...tb.data.subarray(0, 3)], [0, 0, 255])
})

// ------------------------------------------------------------------ stats

test('imageStats: flat grey vs saturated poster', () => {
  const grey = imageStats(fill(320, 180, [128, 128, 128]))
  assert.equal(grey.saturation, 0)
  assert.equal(grey.vivid, 0)
  assert.equal(grey.contrast, 0)
  assert.equal(grey.edgeDensity, 0)
  assert.equal(grey.colorfulness, 0)
  assert.equal(grey.palette.length, 1)
  assert.equal(grey.palette[0].hex, '#808080')
  const p = imageStats(poster())
  assert.ok(p.saturation > 0.4, `saturation ${p.saturation}`)
  assert.ok(p.vivid > 0.3)
  assert.ok(p.contrast > 0.15, `contrast ${p.contrast}`)
  assert.ok(p.colorfulness > 0.3, `colourfulness ${p.colorfulness}`)
  assert.ok(p.edgeDensity > 0 && p.edgeDensity < 0.2)
  assert.ok(p.centerFocus > 1, `centre focus ${p.centerFocus}`)
  // Deterministic.
  assert.deepEqual(imageStats(poster()), p)
})

test('palette: dominant colours first, near colours merged', () => {
  const img = fill(200, 100, [10, 20, 200])
  rect(img, 0, 0, 60, 100, [230, 30, 30])
  rect(img, 60, 0, 10, 100, [235, 35, 25])
  const pal = palette(img)
  assert.equal(pal.length, 2)
  assert.ok(fromHex(pal[0].hex)![2] > 150, 'blue is the most common')
  assert.ok(fromHex(pal[1].hex)![0] > 200)
  assert.ok(Math.abs(pal[0].share + pal[1].share - 1) < 0.02)
  assert.ok(pal[1].share > 0.3, 'the two reds merged')
})

test('small sizes: bold poster reads at 160x90, thin stripes do not; focal contrast and competition', () => {
  const bold = smallSizeReport(poster(1920, 1080))
  const thin = smallSizeReport(mush(1920, 1080))
  assert.equal(bold.s160.width, 160)
  assert.equal(bold.s160.height, 90)
  assert.equal(bold.s256.width, 256)
  assert.ok(bold.report.legibility160 > 6, `bold ${bold.report.legibility160}`)
  assert.ok(thin.report.legibility160 < 2, `thin ${thin.report.legibility160}`)
  assert.ok(bold.report.focal160 > thin.report.focal160)
  assert.ok(legibility(fill(160, 90, [90, 90, 90])) === 0)
  // Two equal blobs far apart compete; one blob does not.
  const one = rect(fill(256, 144, [30, 30, 30]), 100, 50, 50, 40, [255, 220, 0])
  const two = rect(rect(fill(256, 144, [30, 30, 30]), 10, 50, 50, 40, [255, 220, 0]), 196, 50, 50, 40, [255, 220, 0])
  assert.equal(focalContrast(one).competing, false)
  assert.equal(focalContrast(two).competing, true)
  assert.ok(focalContrast(one).score > focalContrast(two).score)
  // A near-black frame sinks into the dark page, a near-white one into the light page.
  const dark = imageStats(fill(160, 90, [26, 28, 32]))
  assert.ok(popAgainst(fill(160, 90, [26, 28, 32]), PAGE_DARK, dark.colorfulness) < 0.05)
  assert.ok(popAgainst(fill(160, 90, [26, 28, 32]), PAGE_LIGHT, dark.colorfulness) > 0.5)
})

test('code checks: the poster beats the mush on every measured principle', () => {
  const run = (img: Rgba) => {
    const s = imageStats(img)
    return thumbChecks(s, smallSizeReport(img, s).report)
  }
  const good = run(poster(960, 540))
  const bad = run(mush(960, 540))
  assert.deepEqual(good.map((c) => c.id), ['th-readable', 'th-focal', 'th-contrast', 'th-pop', 'th-safe-area'])
  for (const c of good) assert.ok(c.score >= 0 && c.score <= 10)
  for (const id of ['th-readable', 'th-contrast', 'th-pop']) {
    const g = good.find((c) => c.id === id)!.score
    const b = bad.find((c) => c.id === id)!.score
    assert.ok(g > b, `${id}: ${g} vs ${b}`)
  }
  assert.ok(bad.find((c) => c.id === 'th-readable')!.fix)
  assert.ok(codeOverall(good) > codeOverall(bad))
  // Text in the bottom strip is flagged by the safe-area check.
  const bottom = fill(960, 540, [20, 30, 90])
  rect(bottom, 100, 470, 760, 60, [255, 255, 255])
  const s = imageStats(bottom)
  const safe = thumbChecks(s, smallSizeReport(bottom, s).report).find((c) => c.id === 'th-safe-area')!
  assert.ok(safe.score < 7, `safe ${safe.score}`)
})

// ------------------------------------------------------------------ principles

test('thumbnail principles: catalogue, domain, selection, restate wording', () => {
  assert.deepEqual(THUMB_PRINCIPLES.map((p) => p.id), ['th-readable', 'th-focal', 'th-contrast', 'th-text', 'th-emotion', 'th-pop', 'th-honest', 'th-safe-area'])
  for (const p of THUMB_PRINCIPLES) assert.equal(p.domain, 'thumb')
  assert.equal(principlesFor('thumb').length, 8)
  assert.ok(ALL_PRINCIPLES.some((p) => p.id === 'th-honest'))
  assert.equal(new Set(ALL_PRINCIPLES.map((p) => p.id)).size, ALL_PRINCIPLES.length, 'ids unique')
  const picked = selectPrinciples('thumbs', 'shark chase')
  assert.equal(picked.length, 8)
  assert.ok(picked.every((p) => p.domain === 'thumb'))
  assert.equal(picked[0].id, 'th-readable')
  // The user's weight moves a principle up.
  assert.equal(selectPrinciples('thumbs', 'x', { weights: { 'th-safe-area': 3 } })[0].id, 'th-safe-area')
  assert.match(restateSystem('thumbs'), /thumbnail/)
})

// ------------------------------------------------------------------ style

test('parseStyleCard: normalises, scrubs quoted text and names', () => {
  const card = parseStyleCard(
    '```json\n{"composition":"Blox Hero left third, boss right","framing":"CLOSE-UP","palette":["#FF8800","nope","#00aaff"],"saturation":"very vivid","outline":true,"rimLight":"true","glow":false,"text":{"present":true,"words":2,"size":"huge","placement":"top third","font":"chunky \\"BLOX\\" outlined sans"},"emotion":"shock","focalContrast":12,"clutter":"3","notes":"Reads like Blox Hero"}\n```',
    ['Blox Hero']
  )!
  assert.equal(card.framing, 'close-up')
  assert.deepEqual(card.palette, ['#ff8800', '#00aaff'])
  assert.equal(card.saturation, 'vivid')
  assert.equal(card.rimLight, true)
  assert.equal(card.focalContrast, 10)
  assert.equal(card.clutter, 3)
  assert.equal(card.text.words, 2)
  assert.equal(card.text.size, 'huge')
  assert.doesNotMatch(card.composition + card.notes + card.text.font, /blox/i)
  assert.equal(parseStyleCard('no json here'), null)
  assert.equal(scrubNames('the "SHARK" text'), 'the text text')
  const none = parseStyleCard({ text: { present: false } })!
  assert.equal(none.text.size, 'none')
  assert.equal(none.text.words, 0)
})

const stat = (o: Partial<ThumbImageStats> = {}): ThumbImageStats => ({ width: 1920, height: 1080, palette: [{ hex: '#ff8800', share: 0.5 }, { hex: '#102060', share: 0.5 }], saturation: 0.5, vivid: 0.3, luma: 0.4, contrast: 0.2, colorfulness: 0.5, edgeDensity: 0.1, centerFocus: 1.3, ...o })

test('aggregateProfile + profileSummary: modes, shares, palette merge, no free text', () => {
  const mk = (o: Partial<ReturnType<typeof cardFromStats>>) => ({ stats: stat(), card: { ...cardFromStats(stat()), ...o } })
  const refs = [
    mk({ framing: 'close-up', outline: true, rimLight: true, glow: true, saturation: 'vivid', palette: ['#ff8800', '#0044ff'], text: { present: true, words: 2, size: 'huge', placement: 'top third', font: 'chunky outlined' }, emotion: 'shock', focalContrast: 9, clutter: 2, composition: 'subject centred, threat behind' }),
    mk({ framing: 'close-up', outline: true, rimLight: false, glow: true, saturation: 'vivid', palette: ['#ff9010'], text: { present: true, words: 4, size: 'large', placement: 'top third', font: 'chunky outlined' }, emotion: 'shock, fear', focalContrast: 8, clutter: 3 }),
    mk({ framing: 'scene', outline: false, rimLight: false, glow: false, saturation: 'neon', palette: ['#00ff66'], text: { present: false, words: 0, size: 'none', placement: '', font: '' }, emotion: 'joy', focalContrast: 6, clutter: 6 })
  ]
  const { card, stats } = aggregateProfile(refs)
  assert.deepEqual(card.framing, { mode: 'close-up', share: 0.67 })
  assert.equal(card.saturation, 'vivid')
  assert.equal(card.outline, 0.67)
  assert.equal(card.rimLight, 0.33)
  assert.equal(card.text.share, 0.67)
  assert.equal(card.text.words, 3)
  assert.equal(card.text.placement, 'top third')
  assert.equal(card.emotions[0], 'shock')
  assert.equal(card.focalContrast, 7.7)
  assert.ok(card.palette.length >= 3 && card.palette.length <= 6)
  assert.equal(stats.contrast, 0.2)
  const summary = profileSummary(card, stats)
  assert.match(summary, /close-up framing/)
  assert.match(summary, /thick outline/)
  assert.match(summary, /glow/)
  assert.doesNotMatch(summary, /rim light/)
  assert.match(summary, /3 big words of huge text at the top third/)
  // Unanalysed references fall back to the stats-only card.
  assert.equal(aggregateProfile([{ stats: stat({ vivid: 0.5 }) }]).card.saturation, 'neon')
  assert.deepEqual(mergePalettes([[{ hex: '#ff0000', share: 0.6 }], [{ hex: '#fa0505', share: 0.4 }, { hex: '#0000ff', share: 0.1 }]]), ['#fd0202', '#0000ff'])
})

// ------------------------------------------------------------------ prompt + no-copy guard

const REFS = [
  { name: 'blox-fruits-thumb-3', game: 'Blox Fruits' },
  { name: 'Pet Simulator 99', game: '' },
  { name: 'image', game: 'Tower Defense Simulator' },
  { name: 'ref 2' }
]

test('forbiddenTerms: game and reference names, distinctive words only', () => {
  const f = forbiddenTerms(REFS)
  assert.ok(f.includes('blox fruits'))
  assert.ok(f.includes('blox') && f.includes('fruits'))
  assert.ok(f.includes('blox fruits thumb 3'))
  assert.ok(f.includes('pet simulator 99'))
  assert.ok(!f.includes('pet') && !f.includes('simulator') && !f.includes('tower defense simulator'), 'genre words stay usable')
  assert.ok(!f.includes('image') && !f.includes('ref 2'))
  assert.deepEqual(copyGuard('A shark like in BLOX FRUITS', f), ['blox fruits'])
  assert.deepEqual(copyGuard('bloxy fruitsalad', f), [])
  // The advertised game itself is allowed.
  assert.deepEqual(copyGuard('Blox Fruits sea beast', f, ['Blox Fruits Sea Edition']), [])
})

test('generationPrompt: brief + style + bases, no reference names, copy rule, text rule', () => {
  const f = forbiddenTerms(REFS)
  const { prompt, removed } = generationPrompt({ brief: 'player escaping a giant shark like Blox Fruits, shocked face, Pet Simulator 99 style', style: 'close-up framing; vivid saturation', bases: 2, styleRefs: 2, gameName: 'Shark Escape', taste: ['prefers more saturated colour'] }, f)
  assert.deepEqual(removed.sort(), ['blox fruits', 'pet simulator 99'])
  assert.doesNotMatch(prompt, /\bblox|fruits|pet simulator/i)
  assert.match(prompt, /the game "Shark Escape"/)
  assert.match(prompt, /attached 2 screenshots of the real game/)
  assert.match(prompt, /The last 2 attached images are style references/)
  assert.match(prompt, /player escaping a giant shark/)
  assert.match(prompt, /Style: close-up framing; vivid saturation\./)
  assert.match(prompt, /at most 3 large words/)
  assert.match(prompt, /bottom 15%/)
  assert.match(prompt, /prefers more saturated colour/)
  assert.ok(prompt.includes(COPY_RULE))
  const none = generationPrompt({ brief: 'boss fight', bases: 0 }).prompt
  assert.match(none, /Show only what the game really contains/)
  assert.doesNotMatch(none, /attached images are style references/)
  assert.equal(scrubBrief('a big boss, similar to Blox Fruits.', f).text, 'a big boss.')
  const confirmed = generationPrompt({ brief: 'x', bases: 0, restatement: { goal: 'A scary chase', problem: 'low CTR', assumptions: [] } }).prompt
  assert.match(confirmed, /Goal: A scary chase/)
  const r = refinePrompt({ brief: 'x', bases: 1, changes: ['Bigger text', 'Remove the Blox Fruits logo'], note: 'make the shark bigger' }, f).prompt
  assert.match(r, /^Revise the first attached image/)
  assert.match(r, /- make the shark bigger\n- Bigger text\n- Remove the logo/)
  assert.match(r, /other attached images are screenshots/)
})

test('critic: prompt lists the principles with measurements; parser, copy flags, text check', () => {
  const p = criticPrompt({ brief: 'shark chase', bases: 1, ids: ['th-readable', 'th-honest'], measured: [{ id: 'th-readable', score: 4.2, note: 'thin text' }], weights: { 'th-honest': 2 } })
  assert.match(p, /th-readable: .* Measured: 4\.2 \(thin text\)/)
  assert.match(p, /th-honest \[user weight x2\.0\]/)
  assert.match(p, /copyFlags/)
  const c = parseCritique('Here: {"overall": 7.46, "summary": "Strong subject", "textWords": 5, "changes": ["Cut the text", {"change": "Bigger shark"}], "copyFlags": ["none"], "principles": []}')!
  assert.equal(c.overall, 7.5)
  assert.deepEqual(c.changes, ['Cut the text', 'Bigger shark'])
  assert.deepEqual(c.copyFlags, [])
  assert.equal(c.textWords, 5)
  assert.equal(parseCritique('nothing'), null)
  const f = forbiddenTerms(REFS)
  assert.deepEqual(copyGuardFlags({ summary: 'looks like the Blox Fruits logo top left', changes: [], copyFlags: ['a mascot from another game'] }, f), ['a mascot from another game', 'mentions "blox fruits" from a style reference'])
  assert.equal(textCheck(3)!.score, 10)
  assert.equal(textCheck(6)!.score, 4)
  assert.ok(textCheck(6)!.fix)
  assert.equal(textCheck(null), null)
})

// ------------------------------------------------------------------ CTR + taste

test('CTR: validation, totals, Wilson interval, labels need two thumbnails and enough data', () => {
  assert.deepEqual(normalizeCtr({ impressions: '1000', clicks: 42, period: ' week 1 ' }, 5), { at: 5, impressions: 1000, clicks: 42, period: 'week 1' })
  assert.throws(() => normalizeCtr({ impressions: 10, clicks: 11 }, 0), CtrError)
  assert.throws(() => normalizeCtr({ impressions: 0, clicks: 0 }, 0), CtrError)
  assert.throws(() => normalizeCtr({ impressions: 10.5, clicks: 1 }, 0), CtrError)
  assert.throws(() => normalizeCtr({ impressions: 10, clicks: -1 }, 0), CtrError)
  assert.deepEqual(ctrTotals([{ at: 0, impressions: 1000, clicks: 50 }, { at: 1, impressions: 3000, clicks: 70 }]), { impressions: 4000, clicks: 120, ctr: 0.03 })
  assert.equal(ctrTotals([]).ctr, null)
  const w = wilson(50, 1000)
  assert.ok(w.low < 0.05 && w.high > 0.05 && w.low > 0.035 && w.high < 0.067)
  assert.equal(formatCtr(0.0345), '3.45%')
  assert.equal(formatCtr(null), '–')
  const rows = [
    { id: 'a', ctr: [{ at: 0, impressions: 20000, clicks: 1400 }] },
    { id: 'b', ctr: [{ at: 0, impressions: 20000, clicks: 800 }] },
    { id: 'c', ctr: [{ at: 0, impressions: 20000, clicks: 1000 }] },
    { id: 'thin', ctr: [{ at: 0, impressions: 50, clicks: 25 }] }
  ]
  const labels = ctrLabels(rows)
  assert.deepEqual(labels.map((l) => [l.id, l.label]), [['a', 1], ['b', -1]])
  assert.ok(labels[0].weight > 2 && labels[0].weight <= 4)
  assert.deepEqual(ctrLabels(rows.slice(0, 1)), [])
})

const rep = (o: Partial<SmallSizeReport> = {}): SmallSizeReport => ({ legibility256: 7, legibility160: 6, focal256: 6, focal160: 6, detailKept: 0.8, bottomLoad: 0.3, popDark: 0.5, popLight: 0.5, ...o })
const thumb = (id: string, o: Partial<Thumb> = {}): Thumb => ({ id, batchId: batchOf(id), scope: 'project', name: id, brief: 'b', baseIds: [], round: 0, prompt: '', model: 'm', genSize: '1920x1088', quality: 'high', costUsd: 0, file: 'image.png', small: { s256: 's256.png', s160: 's160.png' }, stats: stat(), report: rep(), ctr: [], createdAt: 0, updatedAt: 0, ...o })

test('taste: liked vivid vs disliked grey; CTR outweighs; pick-best skips copy-flagged', () => {
  const vivid = { stats: stat({ saturation: 0.8, colorfulness: 0.8 }) }
  const grey = { stats: stat({ saturation: 0.1, colorfulness: 0.1 }) }
  const thumbs = [thumb('tb-aaaa1-1', { ...vivid, rating: 'up' }), thumb('tb-aaaa1-2', { ...grey, rating: 'down' }), thumb('tb-aaaa1-3', { ...vivid, ship: true })]
  const taste = learnTaste(tasteSamples(thumbs))
  assert.equal(taste.samples, 3)
  assert.ok(taste.weights.saturation > 0.3, JSON.stringify(taste.weights))
  assert.ok(taste.weights.colorfulness > 0.3)
  assert.equal(taste.weights.contrast, undefined, 'unchanged features stay neutral')
  assert.deepEqual(tasteLines(taste, 2), ['prefers more saturated colour', 'prefers more colourful palettes'])
  // CTR samples carry weight and are counted.
  const withCtr = [...thumbs, thumb('tb-aaaa1-4', { ...grey, ctr: [{ at: 0, impressions: 50000, clicks: 5000 }] }), thumb('tb-aaaa1-5', { ...vivid, ctr: [{ at: 0, impressions: 50000, clicks: 1000 }] })]
  const t2 = learnTaste(tasteSamples(withCtr))
  assert.equal(t2.ctrSamples, 2)
  assert.ok(t2.weights.saturation < taste.weights.saturation, 'real clicks pull the other way')
  // Pick best: critique + taste, copy flags drop out.
  const crit = (overall: number, flags: string[] = []) => ({ at: 0, overall, summary: '', principles: [], focus: [], changes: [], copyFlags: flags, by: 'critic' as const })
  const a = thumb('tb-bbbb1-1', { ...grey, critique: crit(7) })
  const b = thumb('tb-bbbb1-2', { ...vivid, critique: crit(7) })
  const c = thumb('tb-bbbb1-3', { ...vivid, critique: crit(9.5, ['logo from another game']) })
  assert.equal(pickBest([a, b, c], taste), 'tb-bbbb1-2')
  assert.ok(rankScore(c, taste) < rankScore(a, taste))
  assert.equal(pickBest([], taste), undefined)
})

test('ids and gating hooks: variations share their batch; rating marks the batch kept', () => {
  assert.equal(genSizeFor('gpt-image-2.5-sunburst'), '1920x1088')
  assert.equal(genSizeFor('gpt-image-2'), '1920x1088')
  assert.equal(genSizeFor('gpt-image-1-mini'), '1536x1024')
  assert.equal(thumbId('tb-abcd12', 3), 'tb-abcd12-3')
  assert.equal(batchOf('tb-abcd12-3'), 'tb-abcd12')
  assert.match('tb-abcd12-3', THUMB_RE)
  const h = LAB_HANDLERS.thumbs
  assert.deepEqual(h.kept.thumbRate(['tb-abcd12-3', 'up']), { id: 'tb-abcd12', kept: true })
  assert.deepEqual(h.kept.thumbRate(['tb-abcd12-3', 'down']), { id: 'tb-abcd12', kept: false })
  assert.equal(h.kept.thumbRate(['tb-abcd12-3', null]), null)
  assert.deepEqual(h.kept.thumbShip(['tb-abcd12-2', true]), { id: 'tb-abcd12', kept: true })
  assert.equal(h.runs.thumbGenerate, 'result')
})

// ------------------------------------------------------------------ service (fake HTTP + models)

function settingsStore(init: Record<string, unknown> = {}) {
  const m = new Map(Object.entries(init))
  return { get: <T>(k: string, f: T) => (m.has(k) ? (m.get(k) as T) : f), set: (k: string, v: unknown) => void m.set(k, v), m }
}

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: string | Uint8Array | undefined
}

function fakeHttp(opts: { variants?: Rgba[] } = {}) {
  const calls: Call[] = []
  const variants = opts.variants ?? [poster(384, 256), mush(384, 256), poster(384, 256), mush(384, 256)]
  const json = (status: number, body: unknown) => ({ status, ok: status < 300, headers: { get: () => null }, text: async () => JSON.stringify(body) })
  const fetch: ArtFetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body })
    if (url.endsWith('/images/generations') || url.endsWith('/images/edits')) {
      const req = JSON.parse(String(init?.body))
      return json(200, { data: Array.from({ length: req.n }, (_, i) => ({ b64_json: encodePng(variants[i % variants.length]).toString('base64') })) })
    }
    if (url === 'https://apis.roblox.com/assets/v1/assets') return json(200, { path: 'operations/op-1', operationId: 'op-1', done: true, response: { assetId: '98765', moderationResult: { moderationState: 'Approved' } } })
    if (url.includes('/assets/v1/operations/')) return json(200, { path: 'operations/op-1', done: true, response: { assetId: '98765' } })
    if (url.includes('/legacy-game-internationalization/')) return json(200, { mediaAssetId: '555' })
    if (url.startsWith('https://example.com/')) {
      const png = encodePng(poster(320, 180))
      return { status: 200, ok: true, headers: { get: (n: string) => (n === 'content-type' ? 'image/png' : null) }, text: async () => png.toString('binary'), arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) } as never
    }
    return json(404, { error: 'unknown' })
  }
  return { fetch, calls }
}

const STYLE = JSON.stringify({ composition: 'subject centred', framing: 'close-up', palette: ['#ff8800'], saturation: 'vivid', outline: true, rimLight: true, glow: false, text: { present: true, words: 2, size: 'huge', placement: 'top third', font: 'chunky outlined' }, emotion: 'shock', focalContrast: 8, clutter: 2, notes: 'big face' })

function makeService(dir: string, root: string, opts: { cap?: number; vision?: boolean; model?: string } = {}) {
  const http = fakeHttp()
  const visionCalls: { system: string; prompt: string; images: number }[] = []
  const records: { lab: string; entryId: string; rating: string; scores: Record<string, number> }[] = []
  const memory: { name: string; body: string }[] = []
  const events: { event: string; payload: any }[] = []
  let charged = 0
  let critiques = 0
  const settings = settingsStore(opts.model ? { 'thumbs.settings': { model: opts.model } } : {})
  const svc = new ThumbService({
    userDir: join(dir, 'user'),
    projectRoot: () => root,
    gameName: () => 'Shark Escape',
    settings,
    openAiKey: async () => 'sk-test',
    imageSettings: () => ({ model: 'x', quality: 'high', dailyCapUsd: opts.cap ?? 50 }),
    artSpentToday: async () => 0,
    robloxKey: async () => 'rbx-key',
    creator: () => ({ userId: 7 }),
    vision:
      opts.vision === false
        ? () => null
        : (tier) => async (system, prompt, images) => {
            visionCalls.push({ system, prompt, images: images.length })
            if (system.includes('STYLE')) return STYLE
            critiques++
            // The second variation of every batch "copies" a logo.
            const flagged = critiques % 4 === 2
            return JSON.stringify({ overall: 6 + (critiques % 3), summary: tier, textWords: 2, changes: ['Make the shark bigger'], copyFlags: flagged ? ['a logo from another game top left'] : [], principles: [{ id: 'th-emotion', score: 7, note: 'shocked face', fix: 'bigger eyes' }, { id: 'th-honest', score: 9, note: 'matches the screenshots' }] })
          },
    principles: { weights: async () => ({}), record: async (fb) => void records.push(fb), forget: async () => undefined },
    chargeImage: (usd) => (charged += usd),
    memory: { remember: async (m) => void memory.push({ name: m.name, body: m.body }) },
    fetch: http.fetch,
    sleep: async () => undefined,
    emit: (event, payload) => events.push({ event, payload })
  })
  return { svc, http, visionCalls, records, memory, events, settings, charged: () => charged }
}

test('service: references (file, URL, paste) -> style cards -> profile; bases', async () => {
  const dir = await tmp('refs')
  const root = await tmp('proj')
  const { svc, http, visionCalls } = makeService(dir, root)
  const file = join(dir, 'blox-hero.png')
  await writeFile(file, encodePng(poster(400, 225)))
  const r = await svc.addRefs({ paths: [file, join(dir, 'missing.png')], urls: ['https://example.com/thumbs/Speed%20Run%204.png', 'ftp://nope'], dataUrls: [`data:image/png;base64,${encodePng(mush(64, 36)).toString('base64')}`], game: 'Blox Hero' })
  assert.equal(r.added.length, 3)
  assert.deepEqual(r.skipped.map((s) => s.reason), ['file not found', 'only http(s) links'])
  assert.equal(r.added[1].name, 'Speed Run 4')
  assert.equal(r.added[1].source, 'url')
  assert.ok(http.calls.some((c) => c.url.startsWith('https://example.com/')))
  assert.equal(r.added[0].scope, 'user', 'references default to the user library')
  // Background analysis: wait for the cards.
  for (let i = 0; i < 50 && (await svc.refs()).some((x) => !x.card); i++) await new Promise((res) => setTimeout(res, 10))
  const refs = await svc.refs()
  assert.ok(refs.every((x) => x.card?.framing === 'close-up'))
  assert.ok(visionCalls.every((c) => c.images === 1))
  const profile = await svc.saveProfile({ name: 'Big faces', refIds: refs.map((x) => x.id) })
  assert.equal(profile.card.framing.mode, 'close-up')
  assert.match(profile.summary, /thick outline/)
  assert.doesNotMatch(profile.summary, /blox hero/i)
  await assert.rejects(svc.saveProfile({ name: 'x', refIds: [] }), /at least one reference/)
  const base = join(dir, 'shot.png')
  await writeFile(base, encodePng(poster(800, 600)))
  const bases = await svc.addBases([base])
  assert.equal(bases[0].scope, 'project')
  assert.equal(bases[0].width, 800)
  await assert.rejects(svc.captureStudio(), /desktop app/)
})

test('service: generate -> edits call at 1920x1088 with bases + style refs, 1920x1080 variations, critique, pick-best, cost', async () => {
  const dir = await tmp('gen')
  const root = await tmp('proj')
  const { svc, http, visionCalls, events, charged } = makeService(dir, root)
  const shot = join(dir, 'shot.png')
  await writeFile(shot, encodePng(poster(800, 450)))
  const [base] = await svc.addBases([shot])
  const { added } = await svc.addRefs({ dataUrls: [`data:image/png;base64,${encodePng(poster(160, 90)).toString('base64')}`, `data:image/png;base64,${encodePng(poster(160, 90)).toString('base64')}`, `data:image/png;base64,${encodePng(poster(160, 90)).toString('base64')}`], game: 'Blox Hero' })
  const profile = await svc.saveProfile({ name: 'Big faces', refIds: added.map((a) => a.id) })
  const est = await svc.estimate({ brief: 'x', profileId: profile.id, baseIds: [base.id] })
  assert.equal(est.n, 4)
  assert.equal(est.genSize, '1920x1088')
  assert.equal(est.model, 'gpt-image-2.5-sunburst')
  assert.equal(est.overCap, false)
  const out = await svc.generate({ brief: 'player escaping a giant shark like Blox Hero, shocked face', profileId: profile.id, baseIds: [base.id] })
  const call = http.calls.find((c) => c.url === 'https://api.openai.com/v1/images/edits')!
  assert.ok(call, 'an edit call (base images attached)')
  const req = JSON.parse(String(call.body))
  assert.equal(req.model, 'gpt-image-2.5-sunburst')
  assert.equal(req.size, '1920x1088')
  assert.equal(req.n, 4)
  assert.equal(req.images.length, 3, 'one base + two style references')
  assert.doesNotMatch(req.prompt, /blox hero/i, 'reference game names never reach the image model')
  assert.match(req.prompt, /Shark Escape/)
  assert.equal(call.headers.authorization, 'Bearer sk-test')
  assert.equal(out.thumbs.length, 4)
  assert.match(out.id, /^tb-/)
  for (const t of out.thumbs) {
    assert.equal(t.batchId, out.id)
    assert.equal(batchOf(t.id), out.id)
    assert.equal(t.stats.width, 1920)
    assert.equal(t.stats.height, 1080)
    assert.equal(t.critique?.by, 'critic')
    const img = decodePng(Buffer.from((await svc.file('thumb', t.id))!.split(',')[1], 'base64'))
    assert.deepEqual([img.width, img.height], [1920, 1080])
    const s160 = decodePng(Buffer.from((await svc.file('thumb', t.id, 's160'))!.split(',')[1], 'base64'))
    assert.deepEqual([s160.width, s160.height], [160, 90])
  }
  // The flagged variation is capped and never the pick.
  const flagged = out.thumbs.find((t) => t.critique!.copyFlags.length)!
  assert.ok(flagged)
  assert.ok(flagged.critique!.overall <= 5)
  assert.ok(flagged.critique!.principles.find((p) => p.id === 'th-honest')!.score <= 3)
  assert.ok(out.bestId && out.bestId !== flagged.id)
  // The critic saw the thumbnail + the base screenshot, with measured principles.
  const critic = visionCalls.filter((c) => c.system.includes('art director'))
  assert.equal(critic.length, 4)
  assert.equal(critic[0].images, 2)
  assert.match(critic[0].prompt, /Measured: /)
  const p = out.thumbs[0].critique!.principles
  assert.ok(p.find((x) => x.id === 'th-readable')!.source === 'code')
  assert.ok(p.find((x) => x.id === 'th-emotion')!.source === 'critic')
  assert.equal(p.find((x) => x.id === 'th-text')!.score, 10)
  // Cost: charged once to the lab run, and written on the variations.
  assert.ok(Math.abs(charged() - est.totalUsd) < 1e-9)
  assert.ok(Math.abs(out.thumbs.reduce((s, t) => s + t.costUsd, 0) - est.totalUsd) < 0.001)
  assert.ok(events.some((e) => e.event === 'thumbs:progress' && e.payload.done))
  assert.equal((await svc.status()).counts.thumbs, 4)
})

test('service: refine, rate / ship / CTR teach taste + principles, upload, experience thumbnail', async () => {
  const dir = await tmp('refine')
  const root = await tmp('proj')
  const { svc, http, records, memory } = makeService(dir, root)
  const out = await svc.generate({ brief: 'boss fight', n: 2 })
  assert.ok(http.calls.some((c) => c.url.endsWith('/images/generations')), 'no bases: a generations call')
  const first = out.thumbs[0]
  const refined = await svc.refine(first.id, { note: 'make the boss bigger', rounds: 2, threshold: 10 })
  assert.equal(refined.id, out.id)
  assert.equal(refined.thumbs.length, 2)
  assert.equal(refined.thumbs[0].parentId, first.id)
  assert.equal(refined.thumbs[0].round, 1)
  assert.equal(refined.thumbs[1].parentId, refined.thumbs[0].id)
  assert.equal(refined.thumbs[1].id, `${out.id}-4`)
  const edit = JSON.parse(String(http.calls.filter((c) => c.url.endsWith('/images/edits'))[0].body))
  assert.equal(edit.n, 1)
  assert.equal(edit.images.length, 1)
  assert.match(edit.prompt, /- make the boss bigger\n- Make the shark bigger/)

  const up = await svc.rate(first.id, 'up')
  assert.equal(up.rating, 'up')
  assert.equal(records.at(-1)!.lab, 'thumbs')
  assert.equal(records.at(-1)!.rating, 'up')
  assert.ok(Object.keys(records.at(-1)!.scores).includes('th-readable'))
  assert.ok(memory.some((m) => m.name === 'thumbnail-taste'))
  await svc.ship(out.thumbs[1].id, true)
  await svc.rate(out.thumbs[1].id, 'down')
  // CTR: the stronger label overrides the opinion in the principle feedback.
  await svc.addCtr(first.id, { impressions: 20000, clicks: 400 })
  const t = await svc.addCtr(out.thumbs[1].id, { impressions: 20000, clicks: 1600, period: 'week 1' })
  assert.equal(t.ctr.length, 1)
  assert.equal(t.ctr[0].period, 'week 1')
  const lastFor = (id: string) => records.filter((r) => r.entryId === id).at(-1)!
  assert.equal(lastFor(first.id).rating, 'down', 'low CTR beats the thumbs up')
  assert.equal(lastFor(out.thumbs[1].id).rating, 'up')
  await assert.rejects(svc.addCtr(first.id, { impressions: 10, clicks: 20 }), /cannot be more/)
  const removed = await svc.removeCtr(out.thumbs[1].id, 0)
  assert.equal(removed.ctr.length, 0)
  const taste = await svc.tasteView()
  assert.ok(taste.samples >= 3)

  const uploaded = await svc.upload(first.id)
  assert.equal(uploaded.roblox?.assetId, '98765')
  assert.equal(uploaded.roblox?.uri, 'rbxassetid://98765')
  const asset = http.calls.find((c) => c.url === 'https://apis.roblox.com/assets/v1/assets')!
  assert.equal(asset.headers['x-api-key'], 'rbx-key')
  assert.match(Buffer.from(asset.body as Uint8Array).toString('latin1'), /"assetType":"Image"/)

  await assert.rejects(svc.setExperience(first.id, { universeId: 0 }), /universe id/)
  const exp = await svc.setExperience(first.id, { universeId: 4242 })
  assert.equal(exp.experience?.mediaAssetId, '555')
  const ec = http.calls.find((c) => c.url.includes('legacy-game-internationalization'))!
  assert.equal(ec.url, experienceThumbUrl(4242, 'en'))
  assert.equal(ec.headers['x-api-key'], 'rbx-key')
  assert.match(ec.headers['content-type'], /^multipart\/form-data; boundary=/)
  assert.match(Buffer.from(ec.body as Uint8Array).toString('latin1'), /name="request\.files"; filename=".*\.png"\r\nContent-Type: image\/png/)
  assert.equal((await svc.status()).universeId, 4242)
  assert.equal(await svc.remove(out.thumbs[0].id), true)
  assert.equal(await svc.remove(out.thumbs[0].id), false)
})

test('service: budget cap, cheap model size, no vision falls back to code critique', async () => {
  const dir = await tmp('cap')
  const root = await tmp('proj')
  const capped = makeService(dir, root, { cap: 0.01 })
  await assert.rejects(capped.svc.generate({ brief: 'boss' }), /today's image budget/)
  assert.equal(capped.http.calls.length, 0)
  await assert.rejects(capped.svc.generate({ brief: '  ' }), /Describe the thumbnail/)

  const mini = makeService(await tmp('mini'), await tmp('proj'), { model: 'gpt-image-1-mini', vision: false })
  const st = await mini.svc.setSettings({ n: 99, quality: 'max' })
  assert.equal(st.settings.n, 10)
  assert.equal(st.settings.quality, 'high', 'max needs a 2.5 model')
  const out = await mini.svc.generate({ brief: 'boss', n: 2 })
  const req = JSON.parse(String(mini.http.calls[0].body))
  assert.equal(req.size, '1536x1024')
  assert.equal(req.model, 'gpt-image-1-mini')
  assert.equal(out.thumbs[0].stats.width, 1920)
  assert.equal(out.thumbs[0].critique?.by, 'code')
  assert.ok(out.bestId)
  assert.equal(mini.visionCalls.length, 0)
})

test('experience upload: multipart body and URL', () => {
  const m = multipartFile('request.files', 'a.png', 'image/png', Buffer.from('PNGDATA'))
  const text = m.body.toString('latin1')
  const boundary = m.contentType.split('boundary=')[1]
  assert.ok(text.startsWith(`--${boundary}\r\n`))
  assert.ok(text.endsWith(`\r\n--${boundary}--\r\n`))
  assert.match(text, /\r\n\r\nPNGDATA\r\n/)
  assert.equal(experienceThumbUrl(1, 'pt-br'), 'https://apis.roblox.com/legacy-game-internationalization/v1/game-thumbnails/games/1/language-codes/pt-br/image')
})
