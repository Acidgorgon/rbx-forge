// Browser-preview mock of ThumbsApi: references, style profiles, bases and variations drawn on a
// canvas (blocky avatars, a big threat, outlined text), measured with the real shared code
// (shared/thumbs stats, checks, style aggregation, taste, CTR), fake generation / critique / refine,
// fake upload and experience thumbnail.
import type { HarnessEvents, SmallSizeReport, Thumb, ThumbBase, ThumbCritique, ThumbGenerateInput, ThumbImageStats, ThumbRef, ThumbsApi, ThumbSettings, ThumbStatus, ThumbStyleProfile, UiAsset, UiAssetKind, UiGenerateInput } from '@shared/types'
import { analyzeAsk, buildSections, isUiKind, lintSections, normalizeSections, splitNames, uiGenSize, uiPrompt, UI_KINDS } from '@shared/thumbs/builder'
import { generationPrompt } from '@shared/thumbs/prompt'
import { blendCritique, codeCritique, learnUiKit, pickBestUi, sliceCenter, uiAssetStats, uiChecks } from '@shared/thumbs/uiart'
import { imageStats, smallSizeReport } from '@shared/thumbs/stats'
import { codeOverall, thumbChecks } from '@shared/thumbs/checks'
import { aggregateProfile, cardFromStats, profileSummary } from '@shared/thumbs/style'
import { learnTaste, pickBest, tasteSamples, tasteView } from '@shared/thumbs/taste'
import { normalizeCtr } from '@shared/thumbs/ctr'
import { genSizeFor } from '@shared/thumbs/size'
import { DEFAULT_THUMB_SETTINGS, THUMB_MODELS } from '@shared/thumbs/types'
import type { Rgba } from '@shared/vfx/tex/image'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Look {
  bg: [string, string]
  hero: string
  threat?: string
  text?: string
  textColor?: string
  rim?: string
  scene?: boolean
  muddy?: boolean
}

// Draws a stylised Roblox-ish thumbnail on a 640x360 canvas.
function draw(look: Look, w = 640, h = 360): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(w * 0.5, h * 0.45, 20, w * 0.5, h * 0.5, w * 0.7)
  grad.addColorStop(0, look.bg[0])
  grad.addColorStop(1, look.bg[1])
  g.fillStyle = grad
  g.fillRect(0, 0, w, h)
  if (look.scene) {
    // A blocky map: floor, buildings, trees.
    g.fillStyle = look.muddy ? '#6f7a64' : '#3c8d3a'
    g.fillRect(0, h * 0.68, w, h * 0.32)
    for (let i = 0; i < 9; i++) {
      g.fillStyle = ['#8d8d8d', '#a0522d', '#5b6f8c', '#c9b27c'][i % 4]
      const bw = 40 + ((i * 37) % 50)
      const bh = 50 + ((i * 53) % 110)
      g.fillRect(i * 74 - 10, h * 0.68 - bh, bw, bh)
    }
  }
  if (look.threat) {
    // A huge shape looming behind the hero (shark fin / monster head).
    g.fillStyle = look.threat
    g.beginPath()
    g.moveTo(w * 0.52, h * 0.95)
    g.quadraticCurveTo(w * 0.7, h * 0.05, w * 0.98, h * 0.15)
    g.quadraticCurveTo(w * 0.9, h * 0.55, w * 0.98, h * 0.95)
    g.closePath()
    g.fill()
    g.fillStyle = '#fff'
    for (let i = 0; i < 6; i++) {
      g.beginPath()
      g.moveTo(w * (0.62 + i * 0.05), h * 0.62)
      g.lineTo(w * (0.645 + i * 0.05), h * 0.72)
      g.lineTo(w * (0.67 + i * 0.05), h * 0.62)
      g.fill()
    }
  }
  // The avatar: head, torso, arms, with an outline and a rim light.
  const ax = look.scene ? w * 0.42 : w * 0.3
  const s = look.scene ? 0.45 : 1
  const part = (x: number, y: number, pw: number, ph: number, fill: string) => {
    g.fillStyle = '#000'
    g.fillRect(x - 4 * s, y - 4 * s, pw + 8 * s, ph + 8 * s)
    g.fillStyle = fill
    g.fillRect(x, y, pw, ph)
    if (look.rim) {
      g.fillStyle = look.rim
      g.fillRect(x + pw - 6 * s, y, 6 * s, ph)
    }
  }
  part(ax - 60 * s, h * 0.55, 120 * s, 150 * s, look.hero)
  part(ax - 100 * s, h * 0.57, 36 * s, 120 * s, '#f2c94c')
  part(ax + 64 * s, h * 0.57, 36 * s, 120 * s, '#f2c94c')
  part(ax - 52 * s, h * 0.55 - 104 * s, 104 * s, 96 * s, '#f2c94c')
  // Shocked face.
  g.fillStyle = '#111'
  g.fillRect(ax - 30 * s, h * 0.55 - 78 * s, 16 * s, 22 * s)
  g.fillRect(ax + 14 * s, h * 0.55 - 78 * s, 16 * s, 22 * s)
  g.beginPath()
  g.ellipse(ax, h * 0.55 - 34 * s, 14 * s, 16 * s, 0, 0, Math.PI * 2)
  g.fill()
  if (look.text) {
    g.font = `900 ${look.text.length > 12 ? 44 : 64}px Impact, "Arial Black", sans-serif`
    g.textAlign = 'center'
    g.lineJoin = 'round'
    g.lineWidth = 12
    g.strokeStyle = '#000'
    g.strokeText(look.text, w * 0.5, h * 0.2)
    g.fillStyle = look.textColor ?? '#fff'
    g.fillText(look.text, w * 0.5, h * 0.2)
  }
  if (look.muddy) {
    g.fillStyle = 'rgba(120,120,120,0.45)'
    g.fillRect(0, 0, w, h)
  }
  return c
}

function rgba(c: HTMLCanvasElement): Rgba {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height)
  return { width: c.width, height: c.height, data: d.data }
}

function scaled(c: HTMLCanvasElement, w: number, h: number): string {
  const s = document.createElement('canvas')
  s.width = w
  s.height = h
  const g = s.getContext('2d')!
  g.imageSmoothingQuality = 'high'
  g.drawImage(c, 0, 0, w, h)
  return s.toDataURL('image/png')
}

const files = new Map<string, { image: string; s256?: string; s160?: string }>()
let refs: ThumbRef[] = []
let profiles: ThumbStyleProfile[] = []
let bases: ThumbBase[] = []
let thumbs: Thumb[] = []
let settings: ThumbSettings = { ...DEFAULT_THUMB_SETTINGS }
let universeId: number | undefined
const t0 = Date.UTC(2026, 9, 14, 9, 0)
let seq = 0
const id = (p: string) => `${p}-${(++seq).toString(36)}${Math.random().toString(16).slice(2, 6)}`

function measure(c: HTMLCanvasElement): { stats: ThumbImageStats; report: SmallSizeReport } {
  const img = rgba(c)
  const stats = { ...imageStats(img), width: 1920, height: 1080 }
  return { stats, report: smallSizeReport(img, stats).report }
}

function critiqueFor(stats: ThumbImageStats, report: SmallSizeReport, o: { flagged?: boolean; words?: number; summary?: string } = {}): ThumbCritique {
  const code = thumbChecks(stats, report)
  const critic = [
    { id: 'th-emotion', score: 8, note: 'shocked face reads at a glance', source: 'critic' as const },
    { id: 'th-text', score: (o.words ?? 2) <= 3 ? 10 : 6, note: `${o.words ?? 2} words of text`, source: 'critic' as const, ...((o.words ?? 2) > 3 ? { fix: 'Cut the text to 3 words or fewer' } : {}) },
    { id: 'th-honest', score: o.flagged ? 3 : 9, note: o.flagged ? 'copy guard: a logo in the corner looks like another game' : 'map and avatars match the Studio screenshots', source: 'critic' as const, ...(o.flagged ? { fix: 'Remove the borrowed logo' } : {}) }
  ]
  const principles = [...code.map((c) => ({ ...c, source: 'code' as const })), ...critic]
  const overall = Math.round(Math.min(o.flagged ? 5 : 10, (codeOverall(code) + 8) / 2) * 10) / 10
  const focus = principles.filter((p) => p.score < 8).sort((a, b) => a.score - b.score).slice(0, 3).map((p) => p.id)
  return {
    at: Date.now(),
    overall,
    summary: o.summary ?? (o.flagged ? 'Strong subject, but the corner logo looks borrowed from another game.' : 'Clear subject and threat; the text could be thicker for phones.'),
    principles,
    focus,
    changes: [...(o.flagged ? ['Remove anything that looks taken from another game (characters, logos, title text)'] : []), ...principles.filter((p) => p.fix).map((p) => p.fix!)].slice(0, 4),
    copyFlags: o.flagged ? ['a logo in the top-right corner resembles another game'] : [],
    by: 'critic'
  }
}

const LOOKS: Look[] = [
  { bg: ['#ff7a18', '#3a0b5e'], hero: '#2f80ed', threat: '#4a5a6a', text: 'ESCAPE!', rim: '#fff6b0' },
  { bg: ['#16c79a', '#062a3a'], hero: '#eb5757', threat: '#1d3c34', text: 'SHARK!', textColor: '#ffe14d', rim: '#c8fff0' },
  { bg: ['#f2994a', '#5b1a0e'], hero: '#9b51e0', threat: '#222', text: '1000 STUDS', rim: '#ffd' },
  { bg: ['#7a8a9a', '#4b5560'], hero: '#8899aa', scene: true, muddy: true, text: 'SHARK ESCAPE SIMULATOR UPDATE 5' }
]

function addThumb(batchId: string, k: number, look: Look, extra: Partial<Thumb> & { flagged?: boolean; words?: number } = {}): Thumb {
  const c = draw(look)
  const { stats, report } = measure(c)
  const tid = `${batchId}-${k}`
  files.set(tid, { image: c.toDataURL('image/png'), s256: scaled(c, 256, 144), s160: scaled(c, 160, 90) })
  const { flagged, words, ...rest } = extra
  const t: Thumb = {
    id: tid,
    batchId,
    scope: 'project',
    name: `player escaping a giant shark ${k}`,
    brief: 'player escaping a giant shark, shocked face',
    profileId: profiles[0]?.id,
    baseIds: bases.slice(0, 1).map((b) => b.id),
    round: 0,
    prompt: 'A Roblox experience thumbnail, 16:9 landscape, for the game "Shark Escape". …',
    model: settings.model,
    genSize: genSizeFor(settings.model),
    quality: settings.quality,
    costUsd: 0.041,
    file: 'image.png',
    small: { s256: 's256.png', s160: 's160.png' },
    stats,
    report,
    critique: critiqueFor(stats, report, { flagged, words }),
    ctr: [],
    createdAt: t0 + k * 1000,
    updatedAt: t0 + k * 1000,
    ...rest
  }
  thumbs.push(t)
  return t
}

function seed(): void {
  if (refs.length) return
  const refLooks: (Look & { name: string; game: string })[] = [
    { name: 'pet-tycoon-thumb', game: 'Pet Tycoon X', bg: ['#ffd23f', '#ee4266'], hero: '#3bceac', threat: '#540d6e', text: 'NEW PETS', rim: '#fff' },
    { name: 'obby-king', game: 'Obby King', bg: ['#00f5d4', '#00bbf9'], hero: '#f15bb5', text: 'HARD!', textColor: '#fee440', rim: '#fff' },
    { name: 'horror-night', game: 'Night Shift 3', bg: ['#3a0ca3', '#10002b'], hero: '#f72585', threat: '#000', text: 'RUN', rim: '#4cc9f0' },
    { name: 'race-blitz', game: 'Race Blitz', bg: ['#ff006e', '#3a0ca3'], hero: '#ffbe0b', text: 'FAST', rim: '#fff' }
  ]
  for (const [i, l] of refLooks.entries()) {
    const c = draw(l)
    const stats = imageStats(rgba(c))
    const rid = `ref-${l.name}-${i}a1b2`
    files.set(rid, { image: c.toDataURL('image/png') })
    const card = { ...cardFromStats(stats), framing: 'close-up' as const, outline: true, rimLight: i !== 1, glow: i === 2, saturation: i === 2 ? ('vivid' as const) : ('neon' as const), text: { present: true, words: 1 + (i % 2), size: 'huge' as const, placement: 'top third', font: 'chunky sans with a thick black outline' }, emotion: ['excitement', 'shock', 'fear', 'excitement'][i], focalContrast: 8 + (i % 2), clutter: 2 + (i % 3), notes: 'one big face, one big threat, two words' }
    refs.push({ id: rid, scope: 'user', name: l.name, game: l.game, source: i === 3 ? 'url' : 'file', ...(i === 3 ? { url: 'https://example.com/race-blitz.png' } : {}), file: 'image.png', width: 1920, height: 1080, stats, card, analyzedAt: t0, tags: [], createdAt: t0 - i * 60_000, updatedAt: t0 })
  }
  const agg = aggregateProfile(refs)
  profiles.push({ id: 'style-big-faces-a1b2c3', scope: 'user', name: 'Big faces, loud colour', refIds: refs.map((r) => r.id), card: agg.card, stats: agg.stats, summary: profileSummary(agg.card, agg.stats), createdAt: t0, updatedAt: t0 })
  for (const [i, l] of ([{ bg: ['#87ceeb', '#5aa0c8'], hero: '#2f80ed', scene: true }, { bg: ['#1d3557', '#0b132b'], hero: '#e63946', scene: true, threat: '#457b9d' }] as Look[]).entries()) {
    const c = draw(l)
    const bid = `base-studio-${i}c3d4`
    files.set(bid, { image: c.toDataURL('image/png') })
    bases.push({ id: bid, scope: 'project', name: i ? 'Studio 101522' : 'harbour spawn', source: i ? 'studio' : 'file', file: 'image.png', width: 1920, height: 1080, createdAt: t0 - i * 1000 })
  }
  // An earlier batch with an uploaded, rated thumbnail and CTR rows.
  const old = 'tb-mg1old0a1b'
  addThumb(old, 1, { bg: ['#ff9f1c', '#2ec4b6'], hero: '#e71d36', threat: '#011627', text: 'SHARK!', rim: '#fff' }, { rating: 'up', ship: true, createdAt: t0 - 86_400_000 * 6, roblox: { assetId: '18273645', uri: 'rbxassetid://18273645', uploadedAt: t0 - 86_400_000 * 5, moderation: 'Approved' }, ctr: [{ at: t0 - 86_400_000 * 2, period: 'Oct 7-13', impressions: 48210, clicks: 2314 }] })
  addThumb(old, 2, { bg: ['#6c757d', '#343a40'], hero: '#adb5bd', scene: true, text: 'SHARK ESCAPE' }, { rating: 'down', createdAt: t0 - 86_400_000 * 6, roblox: { assetId: '18273650', uri: 'rbxassetid://18273650', uploadedAt: t0 - 86_400_000 * 5, moderation: 'Approved' }, ctr: [{ at: t0 - 86_400_000 * 2, period: 'Oct 7-13', impressions: 45102, clicks: 1128 }] })
  // The current batch of four.
  const batch = 'tb-mg2cur0c3d'
  for (const [i, l] of LOOKS.entries()) addThumb(batch, i + 1, l, { flagged: i === 2, words: i === 3 ? 5 : 2 })
}

// ------------------------------------------------------------------ UI art (canvas-drawn)

let uiAssets: UiAsset[] = []
const UI_HUES = ['#2ec4b6', '#ff9f1c', '#e71d36', '#8338ec', '#3a86ff', '#06d6a0']

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath()
  g.moveTo(x + r, y)
  g.arcTo(x + w, y, x + w, y + h, r)
  g.arcTo(x + w, y + h, x, y + h, r)
  g.arcTo(x, y + h, x, y, r)
  g.arcTo(x, y, x + w, y, r)
  g.closePath()
}

// Draws one UI asset: transparent canvas (opaque for HUD mockups), outline, top-lit fill.
function drawUi(kind: UiAssetKind, hue: string, k: number, label?: string): HTMLCanvasElement {
  const c = document.createElement('canvas')
  const [w, h] = kind === 'button' ? [480, 176] : kind === 'panel' ? [400, 320] : kind === 'hud' ? [640, 360] : [256, 256]
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  const fill = (y0: number, y1: number) => {
    const gr = g.createLinearGradient(0, y0, 0, y1)
    gr.addColorStop(0, '#ffffff')
    gr.addColorStop(0.12, hue)
    gr.addColorStop(1, hue)
    return gr
  }
  if (kind === 'button' || kind === 'panel') {
    const r = kind === 'button' ? 36 + (k % 3) * 10 : 28
    roundRect(g, 12, 12, w - 24, h - 24, r)
    g.fillStyle = '#16161e'
    g.fill()
    roundRect(g, 22, 22, w - 44, h - 44, r - 10)
    g.fillStyle = fill(22, h - 22)
    g.fill()
    g.fillStyle = 'rgba(0,0,0,.22)'
    g.fillRect(22 + r, h - 40, w - 44 - 2 * r, 14)
    if (kind === 'panel') {
      g.fillStyle = 'rgba(255,255,255,.18)'
      g.fillRect(40, 70, w - 80, h - 120)
    }
    if (label) {
      g.font = `900 ${Math.round(h * 0.36)}px system-ui, sans-serif`
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.lineWidth = 10
      g.strokeStyle = '#16161e'
      g.strokeText(label, w / 2, h / 2)
      g.fillStyle = '#fff'
      g.fillText(label, w / 2, h / 2)
    }
  } else if (kind === 'hud') {
    const bg = g.createLinearGradient(0, 0, 0, h)
    bg.addColorStop(0, '#87c5ff')
    bg.addColorStop(1, '#3c8d3a')
    g.fillStyle = bg
    g.fillRect(0, 0, w, h)
    g.filter = 'blur(2px)'
    for (let i = 0; i < 7; i++) (g.fillStyle = ['#8d8d8d', '#a0522d', '#5b6f8c'][i % 3]), g.fillRect(i * 96, h * 0.55 - (i % 3) * 30, 70, 120)
    g.filter = 'none'
    for (const [x, y] of [[16, 46], [16, 86]]) (roundRect(g, x, y, 150, 30, 15), (g.fillStyle = '#16161e'), g.fill(), roundRect(g, x + 3, y + 3, 144, 24, 12), (g.fillStyle = hue), g.fill())
    for (let i = 0; i < 5; i++) (roundRect(g, w / 2 - 150 + i * 62, h - 66, 54, 54, 12), (g.fillStyle = '#16161e'), g.fill(), roundRect(g, w / 2 - 146 + i * 62, h - 62, 46, 46, 9), (g.fillStyle = i === 0 ? hue : '#3a3a48'), g.fill())
    g.fillStyle = '#fff'
    g.font = '700 16px system-ui'
    g.fillText('1,250', 50, 67)
  } else {
    // A gem / coin / heart-ish object, centred with padding.
    const cx = w / 2
    const cy = h / 2
    const rad = 82 + (k % 2) * 10
    g.beginPath()
    if (k % 3 === 1) {
      g.moveTo(cx, cy - rad)
      g.lineTo(cx + rad, cy - rad * 0.2)
      g.lineTo(cx, cy + rad)
      g.lineTo(cx - rad, cy - rad * 0.2)
      g.closePath()
    } else g.arc(cx, cy, rad, 0, Math.PI * 2)
    g.lineWidth = 16
    g.strokeStyle = '#16161e'
    g.stroke()
    g.fillStyle = fill(cy - rad, cy + rad)
    g.fill()
    g.fillStyle = 'rgba(255,255,255,.55)'
    g.beginPath()
    g.ellipse(cx - rad * 0.35, cy - rad * 0.4, rad * 0.22, rad * 0.12, -0.6, 0, Math.PI * 2)
    g.fill()
  }
  return c
}

function addUi(batchId: string, k: number, kind: UiAssetKind, ask: string, extra: Partial<UiAsset> = {}): UiAsset {
  const label = analyzeAsk(ask).quoted[0]
  const c = drawUi(kind, UI_HUES[(k + ask.length) % UI_HUES.length], k, label)
  const img = rgba(c)
  const stats = uiAssetStats(img)
  const slice = kind === 'button' || kind === 'panel' ? (sliceCenter(img) ?? undefined) : undefined
  const checks = uiChecks({ kind, img, stats, background: UI_KINDS[kind].transparent ? 'transparent' : 'opaque', fill: 0.86, slice })
  const now = Date.now()
  const sections = buildSections({ ask, mode: kind, gameName: 'Shark Escape', names: kind === 'icon-set' ? splitNames(ask) : undefined, size: uiGenSize(kind, settings.model) })
  const a: UiAsset = { id: `${batchId}-${k}`, batchId, scope: 'project', kind, name: `${ask.slice(0, 40)} ${k}`, ask, prompt: uiPrompt(sections, { kind, gameName: 'Shark Escape' }), sections, model: settings.model, genSize: uiGenSize(kind, settings.model), quality: settings.quality, costUsd: 0.04, transparent: UI_KINDS[kind].transparent, file: 'image.png', width: img.width, height: img.height, stats, ...(slice ? { slice } : {}), checks, critique: codeCritique(checks, now), refIds: [], createdAt: now + k, updatedAt: now, ...extra }
  files.set(a.id, { image: c.toDataURL('image/png') })
  uiAssets = [a, ...uiAssets.filter((x) => x.id !== a.id)]
  return a
}

let uiSeeded = false
function seedUi(): void {
  if (uiSeeded) return
  uiSeeded = true
  const b = 'ua-mg2seed0a1'
  addUi(b, 1, 'button', 'a teal PLAY button, glossy', { keep: true, pinned: true, look: { stroke: 'thick dark outline', corners: 'rounded corners', shading: 'top-lit glossy gradient', typography: 'chunky rounded sans' }, createdAt: t0 - 3_600_000 })
  addUi(b, 2, 'button', 'a teal PLAY button, glossy', { rating: 'up', createdAt: t0 - 3_500_000 })
}

function status(): ThumbStatus {
  const genSize = genSizeFor(settings.model)
  const per = settings.model.startsWith('gpt-image-1-mini') ? 0.015 : settings.quality === 'low' ? 0.009 : settings.quality === 'medium' ? 0.019 : 0.077
  return {
    project: true,
    openaiKey: true,
    robloxKey: true,
    creator: true,
    vision: true,
    studio: { connected: true, message: 'Connected to Shark Escape · recording "Shark Escape - Roblox Studio".' },
    model: settings.model,
    quality: settings.quality,
    genSize,
    perImageUsd: per,
    spentTodayUsd: Math.round(thumbs.filter((t) => t.createdAt >= t0).reduce((s, t) => s + t.costUsd, 0) * 1000) / 1000,
    dailyCapUsd: 5,
    counts: { refs: refs.length, profiles: profiles.length, bases: bases.length, thumbs: thumbs.length, ui: uiAssets.length },
    settings,
    models: [...THUMB_MODELS],
    ...(universeId ? { universeId } : {})
  }
}

export function thumbsMock(emit: Emit): ThumbsApi {
  const changed = () => emit('thumbs:changed', { at: Date.now() })
  const find = (tid: string) => {
    const t = thumbs.find((x) => x.id === tid)
    if (!t) throw new Error(`no thumbnail "${tid}"`)
    return t
  }
  const put = (t: Thumb) => {
    thumbs = thumbs.map((x) => (x.id === t.id ? t : x))
    changed()
    return t
  }
  const putUi = (uid: string, fn: (a: UiAsset) => UiAsset) => {
    const a = uiAssets.find((x) => x.id === uid)
    if (!a) throw new Error(`no UI asset "${uid}"`)
    const next = { ...fn(a), updatedAt: Date.now() }
    uiAssets = uiAssets.map((x) => (x.id === uid ? next : x))
    changed()
    return next
  }
  return {
    async thumbStatus() {
      seed()
      return status()
    },
    async thumbSetSettings(patch) {
      const { universeId: u, ...rest } = patch
      settings = { ...settings, ...rest, n: Math.max(1, Math.min(10, Math.floor(Number(rest.n ?? settings.n)))) }
      if (u !== undefined) universeId = u ?? undefined
      return status()
    },
    async thumbRefs() {
      seed()
      return [...refs]
    },
    async thumbAddRefs(input, scope) {
      await delay(300)
      const added: ThumbRef[] = []
      const n = (input.paths?.length ?? 0) + (input.urls?.length ?? 0) + (input.dataUrls?.length ?? 0)
      for (let i = 0; i < n; i++) {
        const c = draw({ bg: ['#06d6a0', '#118ab2'], hero: '#ef476f', text: 'WOW', rim: '#fff' })
        const stats = imageStats(rgba(c))
        const r: ThumbRef = { id: id('ref'), scope: scope ?? 'user', name: input.urls?.[i]?.split('/').pop()?.replace(/\.\w+$/, '') ?? `pasted ${i + 1}`, ...(input.game ? { game: input.game } : {}), source: input.urls?.length ? 'url' : input.dataUrls?.length ? 'paste' : 'file', file: 'image.png', width: 1920, height: 1080, stats, tags: [], createdAt: Date.now(), updatedAt: Date.now() }
        files.set(r.id, { image: c.toDataURL('image/png') })
        refs.unshift(r)
        added.push(r)
      }
      changed()
      setTimeout(() => {
        refs = refs.map((r) => (added.some((a) => a.id === r.id) ? { ...r, card: { ...cardFromStats(r.stats), emotion: 'surprise', text: { present: true, words: 1, size: 'huge', placement: 'top third', font: 'chunky outlined' } }, analyzedAt: Date.now() } : r))
        changed()
      }, 900)
      return { added, skipped: [] }
    },
    async thumbChooseImages() {
      return ['/Users/acid/Pictures/thumbs/popular-1.png']
    },
    async thumbAnalyzeRef(rid) {
      await delay(500)
      refs = refs.map((r) => (r.id === rid ? { ...r, card: r.card ?? cardFromStats(r.stats), analyzedAt: Date.now() } : r))
      changed()
      return refs.find((r) => r.id === rid)!
    },
    async thumbUpdateRef(rid, patch) {
      refs = refs.map((r) => (r.id === rid ? { ...r, ...patch, updatedAt: Date.now() } : r))
      changed()
      return refs.find((r) => r.id === rid)!
    },
    async thumbDeleteRef(rid) {
      refs = refs.filter((r) => r.id !== rid)
      changed()
      return true
    },
    async thumbProfiles() {
      seed()
      return [...profiles]
    },
    async thumbSaveProfile(input) {
      const picked = refs.filter((r) => input.refIds.includes(r.id))
      if (!picked.length) throw new Error('Pick at least one reference for the profile')
      const agg = aggregateProfile(picked)
      const prev = profiles.find((p) => p.id === input.id)
      const p: ThumbStyleProfile = { id: prev?.id ?? id('style'), scope: input.scope ?? 'user', name: input.name, refIds: picked.map((r) => r.id), card: agg.card, stats: agg.stats, summary: profileSummary(agg.card, agg.stats), createdAt: prev?.createdAt ?? Date.now(), updatedAt: Date.now() }
      profiles = [p, ...profiles.filter((x) => x.id !== p.id)]
      changed()
      return p
    },
    async thumbDeleteProfile(pid) {
      profiles = profiles.filter((p) => p.id !== pid)
      changed()
      return true
    },
    async thumbBases() {
      seed()
      return [...bases]
    },
    async thumbAddBases(paths, scope) {
      const out = paths.map((p, i) => {
        const c = draw({ bg: ['#a8dadc', '#457b9d'], hero: '#e63946', scene: true })
        const b: ThumbBase = { id: id('base'), scope: scope ?? 'project', name: p.split(/[\\/]/).pop()!.replace(/\.\w+$/, '') || `shot ${i}`, source: 'file', file: 'image.png', width: 1920, height: 1080, createdAt: Date.now() }
        files.set(b.id, { image: c.toDataURL('image/png') })
        return b
      })
      bases = [...out, ...bases]
      changed()
      return out
    },
    async thumbCaptureStudio(name) {
      await delay(700)
      const c = draw({ bg: ['#89c2d9', '#2a6f97'], hero: '#f4a261', scene: true, threat: '#264653' })
      const b: ThumbBase = { id: id('base'), scope: 'project', name: name || `Studio ${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`, source: 'studio', file: 'image.png', width: 1920, height: 1080, createdAt: Date.now() }
      files.set(b.id, { image: c.toDataURL('image/png') })
      bases = [b, ...bases]
      changed()
      return b
    },
    async thumbDeleteBase(bid) {
      bases = bases.filter((b) => b.id !== bid)
      changed()
      return true
    },
    async thumbEstimate(input: ThumbGenerateInput) {
      const s = status()
      const n = Math.max(1, Math.min(10, input.n ?? settings.n))
      const total = Math.round((s.perImageUsd * n + (input.baseIds?.length ?? 0) * 0.008) * 1000) / 1000
      return { n, model: s.model, quality: input.quality ?? s.quality, genSize: s.genSize, perImageUsd: s.perImageUsd, totalUsd: total, spentTodayUsd: s.spentTodayUsd, dailyCapUsd: 5, overCap: s.spentTodayUsd + total > 5 }
    },
    async thumbGenerate(input) {
      const batchId = `tb-${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`
      const n = Math.max(1, Math.min(10, input.n ?? settings.n))
      emit('thumbs:progress', { batchId, stage: 'generating', detail: `${n} × ${genSizeFor(settings.model)} ${input.quality ?? settings.quality}` })
      await delay(1400)
      const made: Thumb[] = []
      for (let i = 0; i < n; i++) made.push(addThumb(batchId, i + 1, { ...LOOKS[i % LOOKS.length], text: LOOKS[i % 3].text }, { brief: input.brief, name: `${input.brief.slice(0, 40)} ${i + 1}`, createdAt: Date.now() + i, updatedAt: Date.now(), profileId: input.profileId, baseIds: input.baseIds ?? [], flagged: i === 2 }))
      emit('thumbs:progress', { batchId, stage: 'critique', detail: `${n} variations` })
      await delay(600)
      const bestId = pickBest(made, learnTaste(tasteSamples(thumbs)))
      emit('thumbs:progress', { batchId, stage: 'done', done: true })
      changed()
      return { id: batchId, thumbs: made, ...(bestId ? { bestId } : {}) }
    },
    async thumbCritique(tid) {
      await delay(500)
      const t = find(tid)
      return { id: t.batchId, thumb: put({ ...t, critique: critiqueFor(t.stats, t.report), updatedAt: Date.now() }) }
    },
    async thumbRefine(tid, opts) {
      const t = find(tid)
      emit('thumbs:progress', { batchId: t.batchId, stage: 'refining', detail: 'round 1/1' })
      await delay(1200)
      const k = Math.max(...thumbs.filter((x) => x.batchId === t.batchId).map((x) => Number(x.id.split('-').pop()))) + 1
      const made = addThumb(t.batchId, k, { ...LOOKS[0], text: 'ESCAPE!', rim: '#ffffff' }, { brief: t.brief, parentId: t.id, round: t.round + 1, createdAt: Date.now(), updatedAt: Date.now(), name: `${t.brief.slice(0, 40)} ${k}` })
      made.critique = { ...made.critique!, overall: Math.min(10, (t.critique?.overall ?? 7) + 0.8), summary: opts?.note ? `Applied: ${opts.note}` : 'Bigger subject and thicker text; reads better at 160 px.' }
      emit('thumbs:progress', { batchId: t.batchId, stage: 'done', done: true })
      changed()
      return { id: t.batchId, thumbs: [made] }
    },
    async thumbList() {
      seed()
      return [...thumbs].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    },
    async thumbRate(tid, rating) {
      const t = { ...find(tid) }
      if (rating) t.rating = rating
      else delete t.rating
      return put(t)
    },
    async thumbShip(tid, ship) {
      return put({ ...find(tid), ship })
    },
    async thumbNotes(tid, notes) {
      return put({ ...find(tid), notes })
    },
    async thumbDelete(tid) {
      thumbs = thumbs.filter((t) => t.id !== tid)
      changed()
      return true
    },
    async thumbAddCtr(tid, rec) {
      const t = find(tid)
      return put({ ...t, ctr: [...t.ctr, normalizeCtr(rec, Date.now())] })
    },
    async thumbRemoveCtr(tid, index) {
      const t = find(tid)
      return put({ ...t, ctr: t.ctr.filter((_, i) => i !== index) })
    },
    async thumbUpload(tid) {
      await delay(900)
      const asset = String(18300000 + Math.floor(Math.random() * 99999))
      return put({ ...find(tid), roblox: { assetId: asset, uri: `rbxassetid://${asset}`, uploadedAt: Date.now(), moderation: 'Reviewing' } })
    },
    async thumbSetExperience(tid, opts) {
      await delay(700)
      if (!opts.universeId) throw new Error("Enter the experience's universe id")
      universeId = opts.universeId
      return put({ ...find(tid), experience: { universeId: opts.universeId, mediaAssetId: String(Date.now()).slice(-9), at: Date.now(), languageCode: opts.languageCode ?? 'en' } })
    },
    async thumbTaste() {
      return tasteView(learnTaste(tasteSamples(thumbs)))
    },
    async thumbUseAsRef(tid) {
      const t = find(tid)
      const r: ThumbRef = { id: id('ref'), scope: 'user', name: `kept ${t.brief.slice(0, 40)}`, source: 'file', file: 'image.png', width: 1920, height: 1080, stats: t.stats, tags: ['own'], card: cardFromStats(t.stats), analyzedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() }
      files.set(r.id, { image: files.get(tid)?.image ?? '' })
      refs.unshift(r)
      changed()
      return r
    },
    async thumbBuildPrompt(input) {
      seedUi()
      await delay(input.model ? 700 : 80)
      const mode = isUiKind(input.mode) ? input.mode : 'thumbnail'
      const profile = profiles.find((p) => p.id === input.profileId)
      const kit = learnUiKit(uiAssets, { kind: mode === 'thumbnail' ? undefined : mode })
      const names = mode === 'icon-set' ? (input.names?.length ? input.names : splitNames(input.ask)) : undefined
      const sections = buildSections({ ask: input.ask, mode, gameName: 'Shark Escape', profile, kit: kit.samples ? kit : null, names, size: mode === 'thumbnail' ? undefined : uiGenSize(mode, settings.model) })
      if (input.model) for (const s of sections) if (s.key === 'lighting') Object.assign(s, { text: `${s.text} Add a crisp specular streak and a soft bounce light from below.`, source: 'model' })
      const prompt = mode === 'thumbnail' ? generationPrompt({ brief: input.ask, bases: input.baseIds?.length ?? 0, gameName: 'Shark Escape', sections }).prompt : uiPrompt(sections, { kind: mode, gameName: 'Shark Escape', icon: names?.[0], kitRefs: Math.min(2, kit.refIds.length) })
      const notes = [...(profile ? [`Style profile "${profile.name}" is in the composition, camera, palette and text sections.`] : []), ...(mode !== 'thumbnail' && kit.samples ? [`Your UI kit (${kit.samples} kept) is attached: ${kit.lines.slice(0, 3).join(', ')}.`] : [])]
      return { mode, sections, prompt, notes, warnings: lintSections(sections, mode, names), by: input.model ? 'model' : 'rules', ...(names ? { names } : {}) }
    },
    async thumbUiEstimate(input: UiGenerateInput) {
      const kind = isUiKind(input.kind) ? input.kind : 'button'
      const n = Math.max(1, Math.min(10, input.n ?? UI_KINDS[kind].n)) + (kind === 'icon-set' ? Math.max(0, (input.names?.length ? input.names : splitNames(input.ask)).length - 1) : 0)
      const per = status().perImageUsd
      const spent = status().spentTodayUsd
      return { n, model: settings.model, quality: input.quality ?? settings.quality, genSize: uiGenSize(kind, settings.model, input.shape), perImageUsd: per, totalUsd: Math.round(per * n * 1000) / 1000, spentTodayUsd: spent, dailyCapUsd: 5, overCap: spent + per * n > 5 }
    },
    async thumbUiGenerate(input) {
      seedUi()
      const kind = isUiKind(input.kind) ? input.kind : 'button'
      const names = kind === 'icon-set' ? (input.names?.length ? input.names : splitNames(input.ask)) : []
      if (kind === 'icon-set' && names.length < 2) throw new Error('Name at least two icons for a set, e.g. "coin, gem, heart, key".')
      const batchId = `ua-${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`
      const n = Math.max(1, Math.min(10, input.n ?? UI_KINDS[kind].n))
      emit('thumbs:progress', { batchId, stage: 'generating', detail: `${n} × ${UI_KINDS[kind].label.toLowerCase()}` })
      await delay(1100)
      const sections = normalizeSections(input.sections)
      const made: UiAsset[] = []
      for (let i = 0; i < n; i++) made.push(addUi(batchId, i + 1, kind, input.ask, { ...(sections ? { sections } : {}), ...(kind === 'icon-set' ? { name: `${names[0]} ${i + 1}`, setName: input.ask.slice(0, 60), setIndex: 0 } : {}) }))
      emit('thumbs:progress', { batchId, stage: 'critique', detail: `${n} candidates` })
      await delay(500)
      const ranked = made.map((a, i) => ({ ...a, critique: blendCritique({ overall: 6 + ((i * 7) % 4), scores: { brief: 8, readability: 7 + (i % 3), consistency: 7, clean: 8 }, summary: i % 2 ? 'Reads well at 48 px; outline could be thicker.' : 'Bold silhouette, clean edges, matches the kit.', changes: ['Thicker outline'] }, a.checks, Date.now()), look: { stroke: 'thick dark outline', corners: 'rounded corners', shading: 'top-lit glossy gradient', typography: 'chunky rounded sans' } }))
      uiAssets = uiAssets.map((a) => ranked.find((r) => r.id === a.id) ?? a)
      const bestId = pickBestUi(ranked)
      let set: string[] | undefined
      if (kind === 'icon-set' && bestId) {
        set = [bestId]
        for (const [i, name] of names.slice(1).entries()) {
          emit('thumbs:progress', { batchId, stage: 'set', detail: `${i + 2}/${names.length}: ${name}` })
          await delay(250)
          const a = addUi(batchId, n + i + 1, kind, input.ask, { name, setName: input.ask.slice(0, 60), setIndex: i + 1, refIds: [bestId] })
          set.push(a.id)
        }
      }
      emit('thumbs:progress', { batchId, stage: 'done', done: true })
      changed()
      return { id: batchId, assets: uiAssets.filter((a) => a.batchId === batchId), ...(bestId ? { bestId } : {}), ...(set ? { set } : {}), notes: [] }
    },
    async thumbUiList() {
      seedUi()
      return [...uiAssets].sort((a, b) => b.createdAt - a.createdAt)
    },
    async thumbUiRate(uid, rating) {
      return putUi(uid, (a) => {
        const n = { ...a }
        if (rating) n.rating = rating
        else delete n.rating
        return n
      })
    },
    async thumbUiKeep(uid, keep) {
      return putUi(uid, (a) => ({ ...a, keep }))
    },
    async thumbUiPin(uid, pinned) {
      return putUi(uid, (a) => ({ ...a, pinned }))
    },
    async thumbUiCritique(uid) {
      await delay(600)
      const a = putUi(uid, (x) => ({ ...x, critique: blendCritique({ overall: 8, scores: { brief: 8, readability: 8, consistency: 8, clean: 9 }, summary: 'Critic tier: clean shape, the bevel reads at phone size.', changes: [] }, x.checks, Date.now()) }))
      return { id: a.batchId, asset: a }
    },
    async thumbUiDelete(uid) {
      uiAssets = uiAssets.filter((a) => a.id !== uid)
      changed()
      return true
    },
    async thumbUiKit() {
      seedUi()
      return learnUiKit(uiAssets)
    },
    async thumbUiExport(uid) {
      await delay(300)
      const a = putUi(uid, (x) => ({ ...x, exportedTo: `art/ui/${x.kind === 'icon-set' ? 'icons' : `${x.kind}s`}/${x.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png` }))
      return { path: a.exportedTo!, luau: `image.Image = "rbxassetid://0"${a.slice ? `\nimage.ScaleType = Enum.ScaleType.Slice\nimage.SliceCenter = Rect.new(${a.slice.x0}, ${a.slice.y0}, ${a.slice.x1}, ${a.slice.y1})` : ''}` }
    },
    async thumbUiUpload(uid) {
      await delay(800)
      const asset = String(18400000 + Math.floor(Math.random() * 99999))
      return putUi(uid, (x) => ({ ...x, roblox: { assetId: asset, uri: `rbxassetid://${asset}`, uploadedAt: Date.now(), moderation: 'Reviewing' } }))
    },
    async thumbFile(kind, fid, which) {
      seed()
      seedUi()
      const f = files.get(fid)
      if (!f) return null
      return which && which !== 'image' ? (f[which] ?? f.image) : f.image
    }
  }
}
