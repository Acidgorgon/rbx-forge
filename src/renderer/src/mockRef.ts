// Browser-preview mock of RefApi, layered over the VFX and Animation Lab mocks: video references
// are kept here and merged into vfxList / animList (and their get / file / update / rate / delete),
// compose with { reference } pins the result, and iterations of pinned results get the numbers-only
// match main computes without a vision model. One generated sample (a canvas-drawn fireball, no
// media files) is seeded so the pages show a reference without importing one.
import type { AnimApi, AnimEntry, HarnessEvents, RefApi, RefEntry, RefLab, RefSaveInput, VfxApi, VfxEntry, VideoRef } from '@shared/types'
import { analyzeFrames } from '@shared/videoref/analyze'
import { describeAnalysis, glowText, motionText } from '@shared/videoref/prompt'
import { animNumericMatch, vfxNumericMatch } from '@shared/videoref/match'
import type { RgbaFrame } from '@shared/videoref/types'
import { contactSheet } from './pages/videoref/decode'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A fireball drawn on a canvas: charge at the left, fly right, white flash, orange burst, fade.
function sampleFrames(): RgbaFrame[] {
  const W = 256
  const H = 144
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d', { willReadFrequently: true })!
  const orb = (x: number, y: number, r: number, core: string, glow: string) => {
    const grd = g.createRadialGradient(x, y, 0, x, y, r * 2.4)
    grd.addColorStop(0, '#ffffff')
    grd.addColorStop(0.25, core)
    grd.addColorStop(0.6, glow)
    grd.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = grd
    g.beginPath()
    g.arc(x, y, r * 2.4, 0, Math.PI * 2)
    g.fill()
  }
  const out: RgbaFrame[] = []
  for (let i = 0; i < 36; i++) {
    g.fillStyle = '#0b0b10'
    g.fillRect(0, 0, W, H)
    if (i < 14) orb(40, 72, 6 + i * 0.5 + (i % 2), '#ffb347', 'rgba(255,90,30,0.55)')
    else if (i < 18) orb(40 + (i - 13) * 34, 72, 11, '#ffc061', 'rgba(255,110,40,0.6)')
    else if (i === 18) (g.fillStyle = '#fff6e8'), g.fillRect(0, 0, W, H)
    else {
      const k = i - 19
      const a = Math.max(0, 1 - k / 16)
      orb(190, 72, 16 + k * 2.5, `rgba(255,150,50,${a})`, `rgba(220,60,20,${a * 0.6})`)
      g.strokeStyle = `rgba(255,220,160,${a})`
      g.lineWidth = 2
      g.beginPath()
      g.arc(190, 72, 20 + k * 5, 0, Math.PI * 2)
      g.stroke()
    }
    out.push({ t: Math.round((i / 24) * 1000) / 1000, width: W, height: H, data: g.getImageData(0, 0, W, H).data })
  }
  return out
}

function frameUrl(f: RgbaFrame): string {
  const c = document.createElement('canvas')
  c.width = f.width
  c.height = f.height
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(f.data), f.width, f.height), 0, 0)
  return c.toDataURL('image/png')
}

export function refMock(emit: Emit, vfx: VfxApi, anim: AnimApi): VfxApi & AnimApi & RefApi {
  const vrefs: VfxEntry[] = []
  const arefs: AnimEntry[] = []
  const files = new Map<string, string>()
  let seq = 0
  const changed = (lab: RefLab) => (lab === 'vfx' ? emit('vfx:changed', { at: Date.now() }) : emit('anim:changed', { at: Date.now() }))
  const all = () => [...vrefs.map((e) => ({ lab: 'vfx' as const, e })), ...arefs.map((e) => ({ lab: 'anim' as const, e }))]
  const findRef = (id: string) => all().find((x) => x.e.id === id) ?? null
  const toRef = (lab: RefLab, e: VfxEntry | AnimEntry): RefEntry => ({ id: e.id, lab, scope: e.scope, name: e.name, description: e.description, tags: e.tags, notes: e.notes ?? '', ...(e.rating ? { rating: e.rating } : {}), ...(e.quality ? { quality: e.quality } : {}), createdAt: e.createdAt, updatedAt: e.updatedAt, thumbs: e.thumbs, video: e.video! })

  function save(input: RefSaveInput): RefEntry {
    const lab: RefLab = input.lab === 'anim' ? 'anim' : 'vfx'
    const id = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ref'}-v${(seq++).toString(36)}`
    files.set(`${id}/ref/sheet.png`, input.sheet)
    const keyFrames = input.keyFrames.map((k, i) => {
      const file = `ref/key-${i + 1}-${k.label}.png`
      files.set(`${id}/${file}`, k.png)
      return { t: k.t, label: k.label, index: k.index, file }
    })
    const video: VideoRef = { lab, source: { ...input.source }, trim: input.trim, ...(input.crop ? { crop: input.crop } : {}), analysis: { ...input.analysis, keyFrames }, sheet: 'ref/sheet.png' }
    const now = Date.now()
    const thumb = keyFrames.find((k) => k.label === 'impact')?.file ?? 'ref/sheet.png'
    const base = { id, scope: input.scope ?? 'user', kind: 'media' as const, name: input.name, description: describeAnalysis(video.analysis, lab), tags: [...new Set([...(input.tags ?? []), 'video'])], notes: input.notes ?? '', createdAt: now, updatedAt: now, origin: input.source.name, thumbs: [thumb, 'ref/sheet.png'], quality: 'reference' as const, video }
    if (lab === 'vfx') vrefs.unshift(base)
    else arefs.unshift({ ...base, clip: { name: input.name, duration: video.analysis.duration, looped: false, priority: 'Action', tracks: {}, markers: [], beats: video.analysis.segments.map((s) => ({ at: s.start, label: s.label })) } })
    changed(lab)
    const e = (lab === 'vfx' ? vrefs[0] : arefs[0]) as VfxEntry | AnimEntry
    if (input.describe !== false) void describe(id).catch(() => undefined)
    return toRef(lab, e)
  }

  async function describe(id: string): Promise<RefEntry> {
    const hit = findRef(id)
    if (!hit) throw new Error(`no video reference "${id}"`)
    emit('ref:progress', { id, phase: 'describe' })
    await delay(1200)
    const a = hit.e.video!.analysis
    const col = a.palette[0]?.hex ?? 'bright'
    const summary =
      hit.lab === 'vfx'
        ? `Browser preview (no vision model): a ${col} effect that ${motionText(a).split(';')[0]}, ${a.segments.map((s) => s.label).join(' → ')}${a.flashes.length ? ' with a one-frame flash on impact' : ''}.`
        : `Browser preview (no vision model): a move with ${a.segments.map((s) => s.label).join(' → ')}; ${a.timeline.filter((s) => s.kind === 'hold').length} holds.`
    hit.e.video = {
      ...hit.e.video!,
      vision:
        hit.lab === 'vfx'
          ? { summary, effect: 'charged orb burst', layers: [{ name: 'core', shape: 'orb', color: 'white-hot centre', timing: 'anticipation, release' }, { name: 'glow', shape: 'soft halo', color: col, motion: 'grows while charging' }, { name: 'ring', shape: 'expanding ring', color: 'pale orange', timing: 'impact, dissipate' }], shapes: ['orb', 'ring', 'burst'], motion: motionText(a), colors: glowText(a), roblox: 'Core and glow ParticleEmitters (LightEmission 1), a Beam or fast emitter for the flight, a ring mesh tween on impact, a PointLight Brightness spike for the flash.', model: 'mock', at: Date.now() }
          : { summary, poses: a.segments.map((s) => ({ beat: s.label, pose: s.label === 'anticipation' ? 'weight back, arm coiled behind the head' : s.label === 'impact' ? 'arm fully extended, front knee bent' : s.label === 'release' ? 'hips turn first, arm whips forward' : 'settles back to guard' })), timing: 'snappy release after a long hold', model: 'mock', at: Date.now() }
    }
    hit.e.description = `${summary} ${describeAnalysis(a, hit.lab)}`
    hit.e.updatedAt = Date.now()
    changed(hit.lab)
    emit('ref:progress', { id, phase: 'done', message: summary })
    return toRef(hit.lab, hit.e)
  }

  // The generated sample, once (VFX Lab).
  let seeded = false
  const seed = () => {
    if (seeded || typeof document === 'undefined') return
    seeded = true
    try {
      const frames = sampleFrames()
      const analysis = analyzeFrames(frames, { duration: frames.length / 24 })
      const r = save({
        lab: 'vfx',
        name: 'Sample fireball',
        tags: ['fire', 'projectile'],
        notes: 'Generated canvas animation (no real footage).',
        source: { name: 'sample-fireball.webm', mime: 'video/webm', bytes: 0, width: 256, height: 144, duration: 1.5 },
        trim: { start: 0, end: 1.5 },
        analysis,
        sheet: contactSheet(frames, analysis),
        keyFrames: analysis.keyFrames.map((k) => ({ t: k.t, label: k.label, index: k.index, png: frameUrl(frames[k.index]) })),
        describe: false
      })
      void describe(r.id)
    } catch {
      // no canvas (tests): no sample
    }
  }

  // Pinned results get the numbers-only match on their iterations (what main does without a model).
  const withMatch = <T extends VfxEntry | AnimEntry>(e: T): T => {
    if (!e.refId || !e.iterations?.length) return e
    const ref = findRef(e.refId)?.e.video
    if (!ref) return e
    for (const it of e.iterations) {
      if (!it.critique || it.critique.match != null) continue
      const m = 'effect' in it ? vfxNumericMatch(it.effect, ref) : animNumericMatch((it as { clip: AnimEntry['clip'] }).clip, ref)
      it.critique.match = m.match
      it.critique.matchNotes = m.notes
    }
    return e
  }

  return {
    ...vfx,
    ...anim,
    async vfxList() {
      seed()
      return [...vrefs, ...(await vfx.vfxList()).map(withMatch)]
    },
    async vfxGet(id) {
      return vrefs.find((e) => e.id === id) ?? withMatch(await vfx.vfxGet(id))
    },
    async vfxFile(id, file) {
      return files.get(`${id}/${file}`) ?? vfx.vfxFile(id, file)
    },
    async vfxUpdate(id, patch) {
      const e = vrefs.find((x) => x.id === id)
      if (!e) return vfx.vfxUpdate(id, patch)
      Object.assign(e, patch, { updatedAt: Date.now() })
      changed('vfx')
      return e
    },
    async vfxRate(id, rating) {
      const e = vrefs.find((x) => x.id === id)
      if (!e) return vfx.vfxRate(id, rating)
      e.rating = rating ?? undefined
      changed('vfx')
      return e
    },
    async vfxDelete(id) {
      const i = vrefs.findIndex((x) => x.id === id)
      if (i < 0) return vfx.vfxDelete(id)
      vrefs.splice(i, 1)
      changed('vfx')
      return true
    },
    async vfxStatus() {
      const s = await vfx.vfxStatus()
      return { ...s, entries: { ...s.entries, user: s.entries.user + vrefs.length } }
    },
    async vfxCompose(request, opts) {
      const r = await vfx.vfxCompose(request, opts)
      if (opts?.reference && r.entry) {
        r.entry.refId = opts.reference
        const ref = findRef(opts.reference)
        if (ref) r.entry.tags = [...new Set([...r.entry.tags, ...ref.e.tags.filter((t) => t !== 'video')])]
      }
      return r
    },
    async animList() {
      return [...arefs, ...(await anim.animList()).map(withMatch)]
    },
    async animGet(id) {
      return arefs.find((e) => e.id === id) ?? withMatch(await anim.animGet(id))
    },
    async animFile(id, file) {
      return files.get(`${id}/${file}`) ?? anim.animFile(id, file)
    },
    async animUpdate(id, patch) {
      const e = arefs.find((x) => x.id === id)
      if (!e) return anim.animUpdate(id, patch)
      Object.assign(e, patch, { updatedAt: Date.now() })
      changed('anim')
      return e
    },
    async animRate(id, rating) {
      const e = arefs.find((x) => x.id === id)
      if (!e) return anim.animRate(id, rating)
      e.rating = rating ?? undefined
      changed('anim')
      return e
    },
    async animDelete(id) {
      const i = arefs.findIndex((x) => x.id === id)
      if (i < 0) return anim.animDelete(id)
      arefs.splice(i, 1)
      changed('anim')
      return true
    },
    async animCompose(request, opts) {
      const r = await anim.animCompose(request, opts)
      if (opts?.reference && r.entry) r.entry.refId = opts.reference
      return r
    },
    async refSave(input) {
      await delay(300)
      return save(input)
    },
    async refList(lab) {
      seed()
      return all()
        .filter((x) => !lab || x.lab === lab)
        .map((x) => toRef(x.lab, x.e))
    },
    async refGet(id) {
      const hit = findRef(id)
      if (!hit) throw new Error(`no video reference "${id}"`)
      return toRef(hit.lab, hit.e)
    },
    refDescribe: describe,
    async refFile(id, file) {
      return files.get(`${id}/${file}`) ?? null
    },
    async refDecodeSource() {
      return null
    }
  }
}
