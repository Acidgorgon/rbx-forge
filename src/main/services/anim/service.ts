// Animation Lab service: the clip library (import .rbxm / .rbxmx KeyframeSequences and .bvh motion
// capture, retargeted to R15; tags, ratings, notes, "avoid" examples), learning (style profiles per
// move type from pure stats, saved as memory skills), generation (timeline scripts recorded by Lune
// and compiled to keyframes), the render / critique / refine loop, and export to the project (a
// KeyframeSequence .rbxmx plus a Luau module) with an optional Open Cloud upload.
//
// Nothing here is model training: the library is the data, style.ts measures it, retrieval by tag
// picks the references, and models (per Labs tier: cheap / default / critic) draft, tag and critique.
// No electron imports: capture, models, memory and the Open Cloud key come in as functions.

import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import type { AnimClipRef } from '../../../shared/anim/types.ts'
import type { AnimCheckReport, AnimClip, AnimCritique, AnimEntry, AnimExportResult, AnimImportResult, AnimIteration, AnimLabStatus, AnimRefineOptions, AnimRefineProgress, AnimScope, AnimScriptResult, AnimStyle, AnimStyleProfile, AnimUploadResult, LearnedPose, RigType } from '../../../shared/anim/model.ts'
import type { AnimCoverage, AnimImportOptions, AnimImportPreview } from '../../../shared/animTypes.ts'
import type { LabTier } from '../../../shared/labModels.ts'
import { bvhToClip, BvhError, parseBvh } from '../../../shared/anim/bvh.ts'
import { clipFromSequence, readKeyframeSequencesXml, writeKeyframeSequenceXml, type RawSequence } from '../../../shared/anim/rbxmx.ts'
import { clipSummary, finishAnimRun, compileAnim, type AnimRecordResult } from '../../../shared/anim/compile.ts'
import { measureClip } from '../../../shared/anim/measure.ts'
import { runChecks } from '../../../shared/anim/checks.ts'
import { allProfiles, autoTags, buildProfile, buildStyle, coverage, MOVE_TAGS, profileFor, profileSkill, profileText, promptTags } from '../../../shared/anim/style.ts'
import { animCriticSystem, ANIM_DEFAULT_MAX_ITERATIONS, ANIM_DEFAULT_THRESHOLD, animCritiquePrompt, animRefineLoop, beatFrameTimes, heuristicAnimCritique, parseAnimCritique } from '../../../shared/anim/critique.ts'
import { ANIM_API, ANIM_API_R6, ANIM_GUIDE, archetypeFor, draftAnimScript, kitReferenceText } from '../../../shared/anim/draft.ts'
import { ANIM_EXAMPLES, animExample } from '../../../shared/anim/examples.ts'
import { ANIM_RECORDED } from '../../../shared/anim/examples.recorded.ts'
import { ANIM_SEQUENCE_FILE, ANIM_SRC_DIR, animLuauModule, animModuleName } from '../../../shared/anim/luau.ts'
import { clipRig, poseCFrames } from '../../../shared/anim/sample.ts'
import { convertClip, RIG_CONVERT_WARNING } from '../../../shared/anim/convert.ts'
import { uploadAnimationAsset } from '../art/robloxAssets.ts'
import { animEntryId, AnimStore, PROJECT_ANIM_DIR } from './library.ts'
import { luneAnimExtract, luneAnimTimeline } from './lune.ts'
import type { LuneRun } from '../vfx/lune.ts'

export interface ImagePayload {
  mime: string
  base64: string
}

export type ModelFn = (system: string, prompt: string, images: ImagePayload[]) => Promise<string>

export interface MemoryLike {
  remember(input: { scope: 'user' | 'project'; kind?: 'memory' | 'skill'; type?: 'user' | 'project' | 'feedback' | 'reference'; name: string; description: string; body: string }, source?: 'agent' | 'reflection' | 'style' | 'user'): Promise<{ entry: { name: string } }>
}

export interface AnimCaptureRequest {
  clip: AnimClip
  times: number[]
  width: number
  height: number
  // A library clip drawn as a ghost next to the dummy.
  reference?: AnimClip
}

export interface AnimServiceDeps {
  // userData/anim (the user library is <userDir>/library, the style profile <userDir>/style.json).
  userDir: string
  projectRoot: () => string | null
  lune: () => Promise<{ path: string; version?: string } | { error: string }>
  runtimeDir: () => string | null
  luneRun?: LuneRun
  capture?: (req: AnimCaptureRequest) => Promise<Buffer[]>
  // A model for a Labs tier (cheap / default / critic); null when no model is set up.
  model?: (tier: LabTier) => ModelFn | null
  memory?: MemoryLike
  openCloud?: { key(): Promise<string | null>; creator(): { userId?: number; groupId?: number } }
  fetch?: typeof fetch
  emit?: (event: 'anim:changed' | 'anim:progress', payload: unknown) => void
  // App-wide default rig (used without a project, and as the default for new projects).
  defaultRig?: { get(): RigType; set(rig: RigType): void }
  log?: (text: string, stream?: 'info' | 'stderr') => void
  now?: () => number
}

const ANIM_EXT = new Set(['.rbxm', '.rbxmx', '.bvh'])
const MAX_IMPORT_FILES = 300
const MAX_FILE_BYTES = 40 * 1024 * 1024
const FRAME_SIZE = { width: 480, height: 400 }

export class AnimError extends Error {}

// System prompt for anim_compose (the default tier writes the timeline script).
export const ANIM_COMPOSE_SYSTEM = `You are a senior game animator. You make R15 Roblox animations for the RBX Forge Animation Lab by writing a Luau timeline script with the pose kit; Forge records it into keyframes (a KeyframeSequence).
Answer with exactly one \`\`\`lua code block holding the whole script (return function(a) ... end), no prose outside it. Name the clip on the first line: -- Name: <PascalCase>

${ANIM_API}

${kitReferenceText()}

${ANIM_GUIDE}`

// The compose prompt for a rig (R6 adds how the API behaves on R6 and the R6 versions of the kit).
export function animComposeSystem(rig: RigType = 'R15'): string {
  if (rig !== 'R6') return ANIM_COMPOSE_SYSTEM
  return `${ANIM_COMPOSE_SYSTEM.replace('You make R15 Roblox animations', 'You make R6 Roblox animations')}\n\n${ANIM_API_R6}\n\n${kitReferenceText('R6').split('\n\n').pop()}`
}

export const RIG_SETTINGS_FILE = 'settings.json'

export function extractAnimScript(raw: string): string | null {
  const fence = /```(?:lua|luau)?\s*\n([\s\S]*?)```/i.exec(raw)
  const code = (fence ? fence[1] : raw.slice(Math.max(0, raw.indexOf('return function')))).trim()
  return /return\s+function\s*\(/.test(code) ? code + '\n' : null
}

export function animScriptName(script: string, request: string): string {
  const m = /^\s*--\s*Name:\s*([A-Za-z][\w ]{0,40})/m.exec(script.split('\n').slice(0, 3).join('\n'))
  const raw = m?.[1] ?? request.replace(/\b(make|a|an|the|animation|anim|please|with|and|of|that|for)\b/gi, ' ')
  return animModuleName(raw.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('')).slice(0, 40) || 'Animation'
}

const describeClip = (clip: AnimClip, s = measureClip(clip)) =>
  `${clip.looped ? 'Looped ' : ''}${clipRig(clip)} ${s.duration.toFixed(2)} s clip, ${Object.keys(clip.tracks).length} joints, ${s.keys} keys; anticipation ${s.anticipation.toFixed(2)} s, action ${s.action.toFixed(2)} s, recovery ${s.recovery.toFixed(2)} s${clip.markers.length ? `; markers ${clip.markers.map((m) => `${m.name} @ ${m.t.toFixed(2)}`).join(', ')}` : ''}.`

const usable = (e: AnimEntry) => e.quality !== 'avoid' && e.rating !== 'down'

export class AnimService {
  readonly user: AnimStore
  private deps: AnimServiceDeps
  private projectStore: { root: string; store: AnimStore } | null = null
  private running = new Map<string, { cancelled: boolean }>()
  private now: () => number
  private styleCache: AnimStyle | null = null

  constructor(deps: AnimServiceDeps) {
    this.deps = deps
    this.user = new AnimStore('user', join(deps.userDir, 'library'))
    this.now = deps.now ?? Date.now
  }

  get userLibraryDir(): string {
    return this.user.dir
  }

  project(): AnimStore | null {
    const root = this.deps.projectRoot()
    if (!root) return null
    if (this.projectStore?.root !== root) this.projectStore = { root, store: new AnimStore('project', join(root, ...PROJECT_ANIM_DIR.split('/'), 'library')) }
    return this.projectStore.store
  }

  store(scope: AnimScope): AnimStore {
    if (scope === 'user') return this.user
    const p = this.project()
    if (!p) throw new AnimError('Open a project to use the project library (or import into your user library).')
    return p
  }

  private changed(): void {
    this.deps.emit?.('anim:changed', { at: this.now() })
  }

  private model(tier: LabTier): ModelFn | null {
    return this.deps.model?.(tier) ?? null
  }

  // ------------------------------------------------------------ library

  async list(): Promise<AnimEntry[]> {
    const p = this.project()
    return [...(p ? await p.list() : []), ...(await this.user.list())]
  }

  async find(id: string): Promise<{ entry: AnimEntry; store: AnimStore } | null> {
    for (const s of [this.project(), this.user]) {
      if (!s) continue
      const e = await s.read(id).catch(() => null)
      if (e) return { entry: e, store: s }
    }
    return null
  }

  async get(id: string): Promise<AnimEntry> {
    const hit = await this.find(String(id))
    if (!hit) throw new AnimError(`no animation "${id}"`)
    return hit.entry
  }

  async status(): Promise<AnimLabStatus> {
    const lune = await this.deps.lune().catch((e) => ({ error: (e as Error).message }))
    const p = this.project()
    const key = await this.deps.openCloud?.key().catch(() => null)
    const creator = this.deps.openCloud?.creator()
    return {
      projectRoot: this.deps.projectRoot(),
      lune: 'error' in lune ? { available: false, hint: lune.error } : { available: true, ...(lune.version ? { version: lune.version } : {}) },
      vision: !!this.model('critic'),
      upload: !!key && !!(creator?.userId || creator?.groupId),
      entries: { user: (await this.user.list()).length, project: p ? (await p.list()).length : 0 },
      profiles: allProfiles(await this.style()).filter((p) => p.tag !== '*').length,
      rig: await this.rig()
    }
  }

  // ------------------------------------------------------------ rig (R15 / R6)

  private rigFile(): string | null {
    const root = this.deps.projectRoot()
    return root ? join(root, ...PROJECT_ANIM_DIR.split('/'), RIG_SETTINGS_FILE) : null
  }

  // The rig new clips use: the project's setting (.forge/anim/settings.json, committed with the game),
  // else the app default, else R15.
  async rig(): Promise<RigType> {
    const f = this.rigFile()
    if (f) {
      try {
        const v = (JSON.parse(await readFile(f, 'utf8')) as { rig?: unknown }).rig
        if (v === 'R6' || v === 'R15') return v
      } catch {
        // no project setting yet
      }
    }
    const d = this.deps.defaultRig?.get()
    return d === 'R6' ? 'R6' : 'R15'
  }

  async setRig(rig: RigType): Promise<RigType> {
    const r: RigType = rig === 'R6' ? 'R6' : 'R15'
    const f = this.rigFile()
    if (f) {
      let prev: Record<string, unknown> = {}
      try {
        prev = JSON.parse(await readFile(f, 'utf8')) as Record<string, unknown>
      } catch {
        prev = {}
      }
      await mkdir(join(f, '..'), { recursive: true })
      await writeFile(f, JSON.stringify({ ...prev, rig: r }, null, 2) + '\n', 'utf8')
    }
    this.deps.defaultRig?.set(r)
    this.changed()
    return r
  }

  private async rigFor(rig: unknown): Promise<RigType> {
    return rig === 'R6' || rig === 'R15' ? rig : this.rig()
  }

  // Converts a clip between R15 and R6 (in place, or as a new entry with copy). R15 -> R6 loses the
  // waist / elbow / wrist / knee / ankle bends (RIG_CONVERT_WARNING); R6 -> R15 is lossless. Script
  // clips keep their script (it re-records on the new rig).
  async convert(id: string, to: RigType, opts: { copy?: boolean } = {}): Promise<{ entry: AnimEntry; warning: string }> {
    const hit = await this.find(id)
    if (!hit) throw new AnimError(`no animation "${id}"`)
    const target: RigType = to === 'R6' ? 'R6' : 'R15'
    const from = clipRig(hit.entry.clip)
    if (from === target) return { entry: hit.entry, warning: `already ${target}` }
    if (this.running.has(hit.entry.id)) throw new AnimError('this clip is being refined; cancel the refinement first')
    const clip = convertClip(hit.entry.clip, target)
    const note = `Converted from ${from} to ${target}.`
    const warning = RIG_CONVERT_WARNING[target]
    if (opts.copy) {
      const name = `${hit.entry.name}${target}`.slice(0, 80)
      const copy = { ...clip, name: `${clip.name}${target}`.slice(0, 60) }
      const now = this.now()
      const entry: AnimEntry = {
        ...hit.entry,
        id: animEntryId(name),
        kind: hit.entry.kind,
        name,
        clip: copy,
        stats: measureClip(copy),
        notes: [hit.entry.notes, note].filter(Boolean).join(' '),
        createdAt: now,
        updatedAt: now,
        thumbs: [],
        iterations: []
      }
      delete entry.written
      delete entry.roblox
      const saved = await hit.store.save(entry)
      await this.relearn().catch(() => undefined)
      this.changed()
      return { entry: saved, warning }
    }
    // An uploaded asset was the old rig: drop the id so the module does not play the wrong animation.
    const e: AnimEntry = { ...hit.entry, clip, stats: measureClip(clip), notes: [hit.entry.notes, note].filter(Boolean).join(' '), iterations: [], updatedAt: this.now() }
    delete e.roblox
    let saved = await hit.store.save(e)
    if (saved.written && this.deps.projectRoot()) saved = await this.writeProjectFiles(saved).catch(() => saved)
    await this.relearn().catch(() => undefined)
    this.changed()
    return { entry: saved, warning }
  }

  // Ranked retrieval: tags first (the request's move types), then names / descriptions / notes.
  // "Avoid" clips are left out unless asked for; liked clips rank higher.
  async search(query: string, opts: { limit?: number; includeAvoid?: boolean; tags?: string[] } = {}): Promise<AnimEntry[]> {
    const all = (await this.list()).filter((e) => opts.includeAvoid || usable(e))
    const tags = new Set([...(opts.tags ?? []), ...promptTags(query)])
    const words = query.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length > 1)
    if (!words.length && !tags.size) return all.slice(0, opts.limit ?? 50)
    const scored = all
      .map((e) => {
        let s = 0
        for (const t of e.tags) if (tags.has(t)) s += 6
        const name = e.name.toLowerCase()
        for (const w of words) {
          if (e.tags.includes(w)) s += 3
          if (name.includes(w)) s += 3
          if (e.description.toLowerCase().includes(w)) s += 1
          if (e.notes.toLowerCase().includes(w)) s += 1
        }
        if (e.rating === 'up' || e.quality === 'good' || e.quality === 'reference') s *= 1.3
        return { e, s }
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || b.e.updatedAt - a.e.updatedAt)
    return scored.slice(0, opts.limit ?? 50).map((x) => x.e)
  }

  async update(id: string, patch: { name?: string; description?: string; tags?: string[]; notes?: string; quality?: AnimEntry['quality'] | null; reference?: string | null; clip?: AnimClip }): Promise<AnimEntry> {
    const hit = await this.find(id)
    if (!hit) throw new AnimError(`no animation "${id}"`)
    const e: AnimEntry = { ...hit.entry, updatedAt: this.now() }
    if (typeof patch.name === 'string' && patch.name.trim()) e.name = patch.name.trim().slice(0, 80)
    if (typeof patch.description === 'string') e.description = patch.description.slice(0, 2000)
    if (typeof patch.notes === 'string') e.notes = patch.notes.slice(0, 2000)
    if (Array.isArray(patch.tags)) e.tags = cleanTags(patch.tags)
    if (patch.quality === null) delete e.quality
    else if (patch.quality === 'avoid' || patch.quality === 'good' || patch.quality === 'reference') e.quality = patch.quality
    if (patch.reference === null) delete e.reference
    else if (typeof patch.reference === 'string') e.reference = patch.reference
    if (patch.clip) {
      e.clip = patch.clip
      e.stats = measureClip(patch.clip)
    }
    const saved = await hit.store.save(e)
    if (patch.clip && saved.written) await this.writeProjectFiles(saved).catch((err) => this.deps.log?.(`anim: write back failed: ${(err as Error).message}`, 'stderr'))
    if (patch.tags || patch.quality !== undefined) await this.relearn().catch(() => undefined)
    this.changed()
    return saved
  }

  async remove(id: string): Promise<boolean> {
    const hit = await this.find(id)
    if (!hit) return false
    const ok = await hit.store.remove(id)
    this.styleCache = null
    this.changed()
    return ok
  }

  async file(id: string, file: string): Promise<string | null> {
    const hit = await this.find(id)
    if (!hit) return null
    try {
      const bytes = await hit.store.readFile(id, file)
      const mime = file.endsWith('.png') ? 'image/png' : 'application/octet-stream'
      return `data:${mime};base64,${bytes.toString('base64')}`
    } catch {
      return null
    }
  }

  async saveThumb(id: string, dataUrl: string): Promise<AnimEntry> {
    const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl))
    if (!m) throw new AnimError('expected a PNG data URL')
    const hit = await this.find(id)
    if (!hit) throw new AnimError(`no animation "${id}"`)
    const bytes = Buffer.from(m[1], 'base64')
    if (bytes.length > 4 * 1024 * 1024) throw new AnimError('thumbnail too large')
    await hit.store.writeFile(id, 'thumbs/preview.png', bytes)
    const e = await hit.store.save({ ...hit.entry, thumbs: ['thumbs/preview.png', ...hit.entry.thumbs.filter((t) => t !== 'thumbs/preview.png')].slice(0, 6) })
    this.changed()
    return e
  }

  async checks(id: string): Promise<AnimCheckReport> {
    const e = await this.get(id)
    return runChecks(e.clip, profileFor(await this.style(), e.tags, clipRig(e.clip)))
  }

  // ------------------------------------------------------------ contract (Ability Composer)

  async listAnimClips(): Promise<AnimClipRef[]> {
    return (await this.list())
      .filter((e) => e.quality !== 'avoid')
      .map((e) => ({ id: e.id, name: e.name, duration: e.clip.duration, looped: e.clip.looped, markers: e.clip.markers.map((m) => ({ name: m.name, t: m.t })), scope: e.scope, rig: clipRig(e.clip) }))
  }

  private poseCache = new Map<string, { at: number; updatedAt: number; clip: AnimClip }>()

  async getAnimPose(id: string, t: number): Promise<Record<string, number[]> | null> {
    const key = String(id ?? '')
    let c = this.poseCache.get(key)
    if (!c || this.now() - c.at > 2000) {
      const hit = await this.find(key)
      if (!hit) {
        this.poseCache.delete(key)
        return null
      }
      c = { at: this.now(), updatedAt: hit.entry.updatedAt, clip: hit.entry.clip }
      this.poseCache.set(key, c)
    }
    return poseCFrames(c.clip, Number(t) || 0)
  }

  // ------------------------------------------------------------ import

  private async expand(paths: string[]): Promise<string[]> {
    const out: string[] = []
    const walk = async (p: string, depth: number) => {
      if (out.length >= MAX_IMPORT_FILES || depth > 8) return
      let s
      try {
        s = await stat(p)
      } catch {
        return
      }
      if (s.isDirectory()) {
        const names = (await readdir(p).catch(() => [] as string[])).sort()
        for (const n of names) if (!n.startsWith('.')) await walk(join(p, n), depth + 1)
      } else if (s.isFile() && s.size <= MAX_FILE_BYTES && ANIM_EXT.has(extname(p).toLowerCase())) out.push(p)
    }
    for (const p of paths) await walk(resolve(String(p)), 0)
    return out
  }

  // Files -> clips (one per KeyframeSequence; .rbxm needs Lune, .rbxmx and .bvh are parsed here).
  private async readClips(files: string[], convert?: RigType): Promise<{ file: string; clips: { clip: AnimClip; note?: string }[]; error?: string }[]> {
    const out: { file: string; clips: { clip: AnimClip; note?: string }[]; error?: string }[] = []
    const binary: string[] = []
    for (const f of files) {
      const ext = extname(f).toLowerCase()
      const base = basename(f, extname(f))
      try {
        if (ext === '.bvh') {
          const r = bvhToClip(parseBvh(await readFile(f, 'utf8')), { name: base })
          const clip = convert === 'R6' ? convertClip(r.clip, 'R6') : r.clip
          const notes = [r.unmapped.length ? `unmapped bones: ${r.unmapped.slice(0, 8).join(', ')}` : '', convert === 'R6' ? 'BVH retargeted to R15, then converted to R6' : ''].filter(Boolean).join('; ')
          out.push({ file: f, clips: [{ clip, note: notes || undefined }] })
        } else if (ext === '.rbxmx') {
          out.push({ file: f, clips: this.fromSequences(readKeyframeSequencesXml(await readFile(f, 'utf8')), base, convert) })
        } else binary.push(f)
      } catch (e) {
        out.push({ file: f, clips: [], error: e instanceof BvhError ? `BVH: ${e.message}` : (e as Error).message })
      }
    }
    if (binary.length) {
      const lune = await this.deps.lune().catch((e) => ({ error: (e as Error).message }))
      const runtimeDir = this.deps.runtimeDir()
      if ('error' in lune || !runtimeDir) {
        for (const f of binary) out.push({ file: f, clips: [], error: `binary .rbxm needs Lune to read (${'error' in lune ? lune.error : 'runtime scripts missing'}); save as .rbxmx in Studio to import without it` })
      } else {
        for (const r of await luneAnimExtract(binary, { lune: lune.path, runtimeDir, run: this.deps.luneRun })) {
          if (r.error) out.push({ file: r.file, clips: [], error: r.error })
          else out.push({ file: r.file, clips: this.fromSequences(r.sequences ?? [], basename(r.file, extname(r.file)), convert) })
        }
      }
    }
    return out
  }

  // R6 sequences stay R6 (native Motor6D tracks) unless the import asks for a rig; R15 sequences
  // convert to R6 only when asked.
  private fromSequences(seqs: RawSequence[], fileBase: string, convert?: RigType): { clip: AnimClip; note?: string }[] {
    return seqs
      .filter((s) => s.keyframes.length)
      .map((s, i) => {
        const name = s.name && s.name !== 'KeyframeSequence' && s.name !== 'Animation' ? s.name : seqs.length > 1 ? `${fileBase}${i + 1}` : fileBase
        const { clip: raw, info } = clipFromSequence(s, { source: 'rbxm', name, keepR6: convert !== 'R15' })
        const clip = convert && convert !== clipRig(raw) ? convertClip(raw, convert) : raw
        const rigNote = info.rig === 'R6' ? (clipRig(clip) === 'R6' ? 'R6 clip (kept as R6)' : 'R6 clip retargeted to R15') : clipRig(clip) === 'R6' ? 'R15 clip converted to R6 (elbow / knee / waist bends collapsed)' : ''
        const notes = [rigNote, info.unmapped.length ? `unmapped parts: ${info.unmapped.slice(0, 8).join(', ')}` : ''].filter(Boolean).join('; ')
        return { clip, ...(notes ? { note: notes } : {}) }
      })
  }

  // Tag suggestions for the import dialog (nothing is saved).
  async previewImport(paths: string[]): Promise<AnimImportPreview[]> {
    const files = await this.expand(paths)
    const out: AnimImportPreview[] = []
    for (const r of await this.readClips(files)) {
      if (r.error || !r.clips.length) {
        out.push({ file: r.file, name: basename(r.file), duration: 0, looped: false, markers: 0, suggestedTags: [], error: r.error ?? 'no KeyframeSequence in the file' })
        continue
      }
      for (const { clip } of r.clips) out.push({ file: r.file, name: clip.name, duration: clip.duration, looped: clip.looped, markers: clip.markers.length, suggestedTags: autoTags(clip, basename(r.file)), rig: clipRig(clip) })
    }
    return out
  }

  async import(paths: string[], scope: AnimScope = 'user', opts: AnimImportOptions = {}): Promise<AnimImportResult> {
    const store = this.store(scope)
    const files = await this.expand(paths)
    const added: AnimEntry[] = []
    const skipped: { file: string; reason: string }[] = []
    if (!files.length) return { added, skipped: paths.map((p) => ({ file: String(p), reason: 'no .rbxm, .rbxmx or .bvh files' })) }
    const given = opts.tags?.length ? cleanTags(opts.tags) : null
    for (const r of await this.readClips(files, opts.convert)) {
      if (r.error) {
        skipped.push({ file: r.file, reason: r.error })
        continue
      }
      if (!r.clips.length) {
        skipped.push({ file: r.file, reason: 'no KeyframeSequence in the file' })
        continue
      }
      const bytes = await readFile(r.file).catch(() => null)
      for (const { clip, note } of r.clips) {
        const stats = measureClip(clip)
        const now = this.now()
        const entry: AnimEntry = {
          id: animEntryId(clip.name),
          scope,
          kind: 'imported',
          name: clip.name,
          description: describeClip(clip, stats),
          tags: given ?? autoTags(clip, basename(r.file)),
          notes: note ?? '',
          createdAt: now,
          updatedAt: now,
          origin: basename(r.file),
          clip,
          thumbs: [],
          stats,
          ...(opts.quality ? { quality: opts.quality } : {}),
          ...(opts.quality === 'avoid' ? { rating: 'down' as const } : {})
        }
        if (bytes && bytes.length < 8 * 1024 * 1024) await store.writeFile(entry.id, `media/${basename(r.file).replace(/[^\w.-]+/g, '_')}`, bytes)
        added.push(await store.save(entry))
      }
    }
    // Cheap tier: better tags (unless the user set them) and a one-line style note per clip.
    if (added.length) await this.summarizeImports(added, !given).catch((e) => this.deps.log?.(`anim: import summary: ${(e as Error).message}`, 'stderr'))
    if (added.length) await this.relearn().catch((e) => this.deps.log?.(`anim: relearn: ${(e as Error).message}`, 'stderr'))
    this.changed()
    return { added: await Promise.all(added.map(async (e) => (await this.find(e.id))?.entry ?? e)), skipped }
  }

  private async summarizeImports(entries: AnimEntry[], retag: boolean): Promise<void> {
    const cheap = this.model('cheap')
    if (!cheap) return
    const known = Object.keys(MOVE_TAGS)
    const lines = entries.slice(0, 30).map((e, i) => `${i + 1}. "${e.name}" (file ${e.origin}): ${e.description} Suggested tags: ${e.tags.join(', ') || 'none'}.`)
    const raw = await cheap(
      'You label imported Roblox R15 animation clips for an animation library. Answer with JSON only.',
      `Clips:\n${lines.join('\n')}\n\nFor each clip give tags (only from: ${known.join(', ')}) and one short style note (what makes its motion read: timing, weight, poses). JSON: [{"i":1,"tags":["attack"],"note":"..."}]`,
      []
    )
    const m = /\[[\s\S]*\]/.exec(raw)
    if (!m) return
    const rows = JSON.parse(m[0]) as { i?: number; tags?: unknown; note?: unknown }[]
    for (const row of rows) {
      const e = entries[Number(row.i) - 1]
      if (!e) continue
      const hit = await this.find(e.id)
      if (!hit) continue
      const tags = retag && Array.isArray(row.tags) ? cleanTags([...hit.entry.tags, ...row.tags.map(String).filter((t) => known.includes(t))]) : hit.entry.tags
      const note = typeof row.note === 'string' ? row.note.slice(0, 300) : ''
      await hit.store.save({ ...hit.entry, tags, description: note ? `${hit.entry.description} ${note}` : hit.entry.description })
    }
  }

  // ------------------------------------------------------------ learning

  private styleFile(): string {
    return join(this.deps.userDir, 'style.json')
  }

  async style(): Promise<AnimStyle | null> {
    if (this.styleCache) return this.styleCache
    try {
      this.styleCache = JSON.parse(await readFile(this.styleFile(), 'utf8')) as AnimStyle
      return this.styleCache
    } catch {
      return null
    }
  }

  async coverage(): Promise<AnimCoverage> {
    return coverage(await this.list())
  }

  // Style profiles from the whole library (pure stats), saved to style.json and as memory skills.
  async learn(): Promise<{ style: AnimStyle; saved: string[]; errors: string[] }> {
    const entries = await this.list()
    const style = buildStyle(entries, this.now())
    await this.writeStyle(style)
    const saved: string[] = []
    const errors: string[] = []
    if (this.deps.memory) {
      for (const p of allProfiles(style)) {
        if (!p.samples) continue
        const examples = entries
          .filter((e) => (p.tag === '*' || e.tags.includes(p.tag)) && usable(e) && clipRig(e.clip) === (p.rig ?? 'R15'))
          .slice(0, 4)
          .map((e) => `${e.name} (${e.scope} library ${e.id}): ${e.description}`.slice(0, 220))
        const skill = profileSkill(p, examples)
        try {
          saved.push((await this.deps.memory.remember({ scope: 'user', kind: 'skill', ...skill }, 'style')).entry.name)
        } catch (e) {
          errors.push(`${skill.name}: ${(e as Error).message}`)
        }
      }
    }
    this.changed()
    return { style, saved, errors }
  }

  private async writeStyle(style: AnimStyle): Promise<void> {
    await mkdir(this.deps.userDir, { recursive: true })
    await writeFile(this.styleFile(), JSON.stringify(style), 'utf8')
    this.styleCache = style
  }

  // Re-measures the profiles (cheap, no model, no memory writes).
  private async relearn(): Promise<void> {
    await this.writeStyle(buildStyle(await this.list(), this.now()))
  }

  // ------------------------------------------------------------ rating

  // Up: liked (a positive reference; generated clips become examples). Down: "avoid" (never a
  // reference; feeds the avoid notes in the drafter and the critic). Null clears.
  async rate(id: string, rating: 'up' | 'down' | null): Promise<AnimEntry> {
    const hit = await this.find(id)
    if (!hit) throw new AnimError(`no animation "${id}"`)
    const e: AnimEntry = { ...hit.entry, updatedAt: this.now() }
    if (rating) e.rating = rating
    else delete e.rating
    if (rating === 'down') e.quality = 'avoid'
    else if (rating === 'up') e.quality = e.kind === 'generated' ? 'good' : e.quality === 'avoid' ? undefined : e.quality
    else if (e.quality === 'avoid' || (e.kind === 'generated' && e.quality === 'good')) delete e.quality
    if (!e.quality) delete e.quality
    const saved = await hit.store.save(e)
    await this.relearn().catch(() => undefined)
    if (this.deps.memory && rating) {
      const style = await this.style()
      for (const tag of saved.tags.slice(0, 3)) {
        const p = (clipRig(saved.clip) === 'R6' ? style?.r6?.profiles : style?.profiles)?.find((x) => x.tag === tag)
        if (p?.samples) await this.deps.memory.remember({ scope: 'user', kind: 'skill', ...profileSkill(p) }, 'style').catch(() => undefined)
      }
      if (rating === 'up' && saved.clip.script) await this.saveExampleSkill(saved).catch((err) => this.deps.log?.(`anim: example skill: ${(err as Error).message}`, 'stderr'))
      if (rating === 'down') await this.saveAvoidNotes(saved).catch((err) => this.deps.log?.(`anim: avoid note: ${(err as Error).message}`, 'stderr'))
      void this.reflect(saved, rating).catch((err) => this.deps.log?.(`anim: reflection: ${(err as Error).message}`, 'stderr'))
    }
    this.changed()
    return saved
  }

  private async saveExampleSkill(e: AnimEntry): Promise<void> {
    const critic = e.iterations?.[e.iterations.length - 1]?.critique
    const beats = (e.clip.beats ?? []).map((b) => `${b.label} @ ${b.at.toFixed(2)} s`).join(', ')
    const body = [
      `An R15 animation the user liked in the Animation Lab: "${e.origin}" (${e.clip.duration.toFixed(2)} s; tags ${e.tags.join(', ')}).`,
      beats ? `Beats: ${beats}.` : '',
      e.clip.markers.length ? `Markers: ${e.clip.markers.map((m) => `${m.name} @ ${m.t.toFixed(2)} s`).join(', ')}.` : '',
      critic ? `Critic (${critic.overall}/10): ${critic.summary.slice(0, 300)}` : '',
      'To make something similar: anim_compose with this script as the starting point (anim_set_script), then anim_critique.',
      '```lua',
      e.clip.script!.slice(0, 6000),
      '```'
    ].filter(Boolean).join('\n')
    await this.deps.memory!.remember({ scope: 'user', kind: 'skill', name: `anim-example-${e.name}`.slice(0, 60), description: `Liked R15 animation script: ${e.description}`.slice(0, 200), body: body.slice(0, 7900) }, 'user')
  }

  private async saveAvoidNotes(e: AnimEntry): Promise<void> {
    const bad = (await this.list()).filter((x) => !usable(x))
    for (const tag of e.tags.slice(0, 3)) {
      const list = bad.filter((x) => x.tags.includes(tag))
      if (!list.length) continue
      const body = [
        `R15 animations the user marked as bad for "${tag}" (thumbs down / avoid in the Animation Lab). Never use them as references; do not repeat these choices:`,
        ...list.slice(0, 10).map((x) => {
          const last = x.iterations?.[x.iterations.length - 1]?.critique
          return `- ${x.name}: ${(x.notes || x.description).slice(0, 160)}${last ? ` (critic: ${last.summary.slice(0, 160)})` : ''}`
        })
      ].join('\n')
      await this.deps.memory!.remember({ scope: 'user', kind: 'memory', type: 'feedback', name: `anim-avoid-${tag}`, description: `Disliked ${tag} animations: what to avoid when animating ${tag} moves`, body: body.slice(0, 2900) }, 'user')
    }
  }

  // Cheap tier: one short lesson from a rating (what to keep or avoid next time) into memory.
  private async reflect(e: AnimEntry, rating: 'up' | 'down'): Promise<void> {
    const cheap = this.model('cheap')
    if (!cheap || !this.deps.memory) return
    const critic = e.iterations?.[e.iterations.length - 1]?.critique
    const raw = await cheap(
      'You distil animation feedback into short, reusable lessons for an animator. Plain text, at most 3 bullet points, no preamble.',
      [`The user gave thumbs ${rating} to this R15 animation: "${e.name}" (${e.tags.join(', ')}).`, e.description, e.notes ? `User notes: ${e.notes}` : '', critic ? `Last critique: ${critic.summary}` : '', clipSummary(e.clip, 20), `What should the animator ${rating === 'up' ? 'keep doing' : 'avoid'} for ${e.tags[0] ?? 'this kind of'} moves?`].filter(Boolean).join('\n'),
      []
    )
    const text = raw.trim().slice(0, 1200)
    if (!text) return
    await this.deps.memory.remember({ scope: 'user', kind: 'memory', type: 'feedback', name: `anim-lesson-${e.tags[0] ?? 'general'}-${rating}`, description: `Animation Lab lesson from a thumbs ${rating} on ${e.tags[0] ?? 'a'} clip`, body: `From "${e.name}":\n${text}` }, 'reflection')
  }

  // ------------------------------------------------------------ scripts

  private async lunePaths(): Promise<{ lune: string; runtimeDir: string }> {
    const lune = await this.deps.lune().catch((e) => ({ error: (e as Error).message }))
    if ('error' in lune) throw new AnimError(`Animation scripts run in Lune, which is not available: ${lune.error}`)
    const runtimeDir = this.deps.runtimeDir()
    if (!runtimeDir) throw new AnimError('The Lune runtime scripts are missing from this install (resources/lune).')
    return { lune: lune.path, runtimeDir }
  }

  private async learnedPoses(): Promise<LearnedPose[]> {
    const style = await this.style()
    return allProfiles(style).flatMap((p) => p.poses)
  }

  async recordScript(script: string, opts: { name?: string; patches?: AnimClip['patches']; rig?: RigType } = {}): Promise<AnimScriptResult> {
    const text = String(script ?? '')
    if (!text.trim()) return { ok: false, error: { message: 'the script is empty' }, prints: [], warnings: [], summary: '' }
    if (text.length > 60_000) return { ok: false, error: { message: 'the script is too long (60 KB max)' }, prints: [], warnings: [], summary: '' }
    const rec: AnimRecordResult = await luneAnimTimeline(text, { ...(await this.lunePaths()), run: this.deps.luneRun })
    const run = finishAnimRun(rec, text, { name: opts.name, learned: await this.learnedPoses(), patches: opts.patches, rig: await this.rigFor(opts.rig) })
    if (!run.ok || !run.clip) return { ok: false, ...(run.error ? { error: run.error } : {}), prints: run.prints, warnings: run.warnings, summary: '' }
    const checks = runChecks(run.clip, profileFor(await this.style(), promptTags(run.clip.name), clipRig(run.clip)))
    return { ok: true, prints: run.prints, warnings: run.warnings, summary: clipSummary(run.clip), clip: run.clip, checks }
  }

  // Saves a clip as a generated entry (new, or replacing an entry's clip) and writes it into the project.
  async saveClip(clip: AnimClip, opts: { id?: string; prompt?: string; description?: string; tags?: string[]; scope?: AnimScope } = {}): Promise<AnimEntry> {
    const prev = opts.id ? await this.find(opts.id) : null
    const store = prev?.store ?? this.store(opts.scope ?? 'user')
    const now = this.now()
    const stats = measureClip(clip)
    const entry: AnimEntry = {
      ...(prev?.entry ?? {}),
      id: prev?.entry.id ?? animEntryId(clip.name),
      scope: store.scope,
      kind: prev?.entry.kind ?? 'generated',
      name: prev?.entry.name ?? clip.name,
      description: opts.description ?? prev?.entry.description ?? `${opts.prompt ?? clip.name}. ${describeClip(clip, stats)}`.slice(0, 600),
      tags: opts.tags ? cleanTags(opts.tags) : prev?.entry.tags ?? cleanTags([...promptTags(opts.prompt ?? clip.name), ...autoTags(clip)]),
      notes: prev?.entry.notes ?? '',
      createdAt: prev?.entry.createdAt ?? now,
      updatedAt: now,
      origin: opts.prompt ?? prev?.entry.origin ?? clip.name,
      clip,
      thumbs: prev?.entry.thumbs ?? [],
      stats
    }
    let saved = await store.save(entry)
    if (saved.written) saved = await this.writeProjectFiles(saved).catch(() => saved)
    this.changed()
    return saved
  }

  // The rig: an existing clip keeps its rig, else opts.rig, else the project's.
  async runScript(script: string, opts: { id?: string; save?: boolean; prompt?: string; rig?: RigType } = {}): Promise<AnimScriptResult> {
    const hit = opts.id ? await this.find(opts.id) : null
    if (opts.id && !hit) throw new AnimError(`no animation "${opts.id}"`)
    const rig = hit ? clipRig(hit.entry.clip) : await this.rigFor(opts.rig)
    const r = await this.recordScript(script, { name: hit?.entry.clip.name ?? animScriptName(script, opts.prompt ?? 'Animation'), rig })
    if (!r.ok || !opts.save || !r.clip) return r
    if (hit && this.running.has(hit.entry.id)) throw new AnimError('this clip is being refined; cancel the refinement first')
    const entry = await this.saveClip(r.clip, { id: hit?.entry.id, prompt: hit ? undefined : opts.prompt ?? r.clip.name })
    return { ...r, entry }
  }

  // Liked references with scripts for the request's tags (few-shot), never "avoid" clips.
  // Same-rig clips first (an R6 request learns from R6 references, then R15 ones).
  async references(tags: string[], text: string, exclude?: string, rig?: RigType): Promise<AnimEntry[]> {
    const hits = (await this.search(text, { tags, limit: 10 })).filter((e) => e.id !== exclude)
    if (rig) hits.sort((a, b) => Number(clipRig(b.clip) === rig) - Number(clipRig(a.clip) === rig))
    return hits.slice(0, 3)
  }

  private avoidNotes(tags: string[], entries: AnimEntry[]): string[] {
    return entries
      .filter((e) => !usable(e) && e.tags.some((t) => tags.includes(t)))
      .slice(0, 5)
      .map((e) => `${e.name}: ${(e.notes || e.description).slice(0, 140)}`)
  }

  // Request -> clip: the default tier writes the script (learned profile, references by tag, avoid
  // notes, a matching example; one repair round), else the built-in draft for the request's
  // archetype in the learned timing. Saved as a new entry; refined in the background when frames
  // can be rendered (refine: false skips).
  async compose(request: string, opts: AnimRefineOptions & { wait?: boolean; refine?: boolean; script?: string; scope?: AnimScope; rig?: RigType } = {}): Promise<AnimScriptResult & { refined?: Promise<unknown> }> {
    const text = String(request ?? '').trim()
    if (text.length < 3) throw new AnimError('Describe the move, e.g. "a heavy overhead punch with a long windup".')
    const rig = await this.rigFor(opts.rig)
    const tags = promptTags(text)
    const style = await this.style()
    const profile = profileFor(style, tags, rig)
    let source: AnimScriptResult['source'] = 'draft'
    let result: AnimScriptResult | null = null
    let script = opts.script?.trim() ? opts.script : ''
    const writer = this.model('default')
    if (!script && writer) {
      const all = await this.list()
      const refs = await this.references(tags, text, undefined, rig)
      const scripted = refs.find((e) => e.clip.script && clipRig(e.clip) === rig) ?? refs.find((e) => e.clip.script)
      const forRig = ANIM_EXAMPLES.filter((x) => (x.rig ?? 'R15') === rig)
      const ex = forRig.find((x) => archetypeFor(x.name + ' ' + x.tags.join(' ')) === archetypeFor(text)) ?? forRig[0] ?? ANIM_EXAMPLES[0]
      const avoid = this.avoidNotes(tags, all)
      const lines = [
        `Make: ${text}`,
        `Rig: ${rig}${rig === 'R6' ? ' (start the script with a:rig("R6"); no waist, elbows, wrists, knees or ankles)' : ''}`,
        profile ? profileText(profile) : 'No learned style for this move type yet: use strong anticipation, a fast action and a settling recovery.',
        ...refs.filter((e) => e !== scripted).map((e) => `Library reference "${e.name}" (${e.tags.join(', ')}): ${e.description.slice(0, 300)}`),
        scripted ? `The user liked this related clip ("${scripted.origin}"); reuse what fits:\n\`\`\`lua\n${scripted.clip.script!.slice(0, 4000)}\n\`\`\`` : `An example script (${ex.name}):\n\`\`\`lua\n${ex.script}\`\`\``,
        avoid.length ? `The user marked these as bad; do not repeat them: ${avoid.join(' | ')}` : ''
      ].filter(Boolean)
      try {
        const system = animComposeSystem(rig)
        let raw = await writer(system, lines.join('\n\n'), [])
        for (let attempt = 0; attempt < 2; attempt++) {
          const s = extractAnimScript(raw)
          if (!s) throw new Error('no script in the answer')
          const r = await this.recordScript(s, { name: animScriptName(s, text), rig })
          if (r.ok) {
            script = s
            result = r
            source = 'model'
            break
          }
          if (attempt === 1) throw new Error(r.error?.message ?? 'the script failed')
          const where = r.error?.line ? ` (line ${r.error.line}: ${s.split('\n')[r.error.line - 1]?.trim() ?? ''})` : ''
          raw = await writer(system, `${lines.join('\n\n')}\n\nYour script:\n\`\`\`lua\n${s}\`\`\`\nfailed: ${r.error?.message}${where}\nFix it and answer with the whole corrected script.`, [])
        }
      } catch (e) {
        this.deps.log?.(`anim: composed script unusable (${(e as Error).message}); using the built-in draft`, 'stderr')
      }
    }
    if (!result) {
      if (!script) script = draftAnimScript(text, profile, rig)
      else source = 'model'
      result = await this.recordScript(script, { name: animScriptName(script, text), rig })
      if (!result.ok && opts.script) return { ...result, source }
      if (!result.ok) throw new AnimError(`could not record the draft script: ${result.error?.message}`)
    }
    const entry = await this.saveClip(result.clip!, { prompt: text, tags: [...new Set([...tags, ...autoTags(result.clip!)])], scope: opts.scope })
    await this.ensureGuideSkill()
    const out: AnimScriptResult & { refined?: Promise<unknown> } = { ...result, entry, source }
    if (opts.refine !== false && this.deps.capture) {
      const refined = this.refine(entry.id, opts).catch((e) => this.deps.log?.(`anim: refine failed: ${(e as Error).message}`, 'stderr'))
      if (opts.wait) await refined
      out.refined = refined
    }
    return out
  }

  private guideSaved = false
  private async ensureGuideSkill(): Promise<void> {
    if (this.guideSaved || !this.deps.memory) return
    this.guideSaved = true
    const body = `${ANIM_GUIDE}\n\n## Timeline API\n${ANIM_API}\n\nCall anim_kit for the pose kit, anim_compose to draft a clip in one step, anim_set_script / anim_run_script to iterate on a script (errors come back with line numbers), anim_critique to render the key beats and refine.`
    await this.deps.memory.remember({ scope: 'user', kind: 'skill', name: 'anim-timeline', description: 'How to make R15 Roblox animations with Animation Lab timeline scripts (anticipation, action, recovery, markers, IK, overlap)', body: body.slice(0, 7900) }, 'agent').catch((e) => {
      this.guideSaved = false
      this.deps.log?.(`anim: guide skill: ${(e as Error).message}`, 'stderr')
    })
  }

  examples(): { key: string; name: string; description: string; tags: string[]; rig: RigType }[] {
    return ANIM_EXAMPLES.map(({ key, name, description, tags, rig }) => ({ key, name, description, tags, rig: rig ?? 'R15' }))
  }

  // Adds a built-in example to the library from its recorded ops (no Lune needed).
  async addExample(key: string): Promise<AnimEntry> {
    const ex = animExample(key)
    if (!ex) throw new AnimError(`no built-in example "${key}" (examples: ${ANIM_EXAMPLES.map((e) => e.key).join(', ')})`)
    const origin = `example:${ex.key}`
    const prev = (await this.list()).find((e) => e.origin === origin)
    if (prev) return prev
    const { clip } = compileAnim(ANIM_RECORDED[ex.key] ?? [], ex.script, { name: ex.name, learned: [], rig: ex.rig ?? 'R15' })
    const entry = await this.saveClip(clip, { prompt: origin, description: ex.description, tags: [...ex.tags, 'example'] })
    await this.relearn().catch(() => undefined)
    return entry
  }

  // ------------------------------------------------------------ render + critique + refine

  canRender(): boolean {
    return !!this.deps.capture
  }

  private async referenceClip(e: AnimEntry): Promise<AnimClip | undefined> {
    if (!e.reference) return undefined
    return (await this.find(e.reference))?.entry.clip
  }

  async renderClip(clip: AnimClip, times: number[], reference?: AnimClip): Promise<Buffer[]> {
    if (!this.deps.capture) throw new AnimError('Rendering needs the desktop app (offscreen WebGL capture).')
    return this.deps.capture({ clip, times, ...FRAME_SIZE, ...(reference ? { reference } : {}) })
  }

  async critique(entry: AnimEntry, clip: AnimClip, frames: Buffer[], times: number[], iteration: number, previous: AnimCritique | null): Promise<AnimCritique> {
    const style = await this.style()
    const rig = clipRig(clip)
    const profile: AnimStyleProfile | null = profileFor(style, entry.tags, rig)
    const checks = runChecks(clip, profile)
    const refs = await this.references(entry.tags, entry.origin, entry.id, rig)
    const refNames = refs.map((r) => r.name)
    const critic = this.model('critic')
    if (!critic || !frames.length) return heuristicAnimCritique(clip, checks, profile, refNames)
    const prompt = animCritiquePrompt({ request: entry.origin, clip, frameTimes: times, checks, profile, references: refs.map((r) => ({ name: r.name, description: r.description })), iteration, previous })
    try {
      const raw = await critic(animCriticSystem(rig), prompt, frames.map((f) => ({ mime: 'image/png', base64: f.toString('base64') })))
      return parseAnimCritique(raw, checks, refNames)
    } catch (e) {
      this.deps.log?.(`anim: vision critique unavailable (${(e as Error).message}); using the numbers-only check`, 'stderr')
      return heuristicAnimCritique(clip, checks, profile, refNames)
    }
  }

  cancel(id: string): void {
    const r = this.running.get(id)
    if (r) r.cancelled = true
  }

  isRefining(id: string): boolean {
    return this.running.has(id)
  }

  private progress(p: AnimRefineProgress): void {
    this.deps.emit?.('anim:progress', p)
  }

  // Render the key beats -> critique (critic tier, or the numbers) -> apply changes, until the score
  // passes the threshold. Without a renderer the numbers-only critic still runs (no frames).
  async refine(id: string, opts: AnimRefineOptions = {}): Promise<{ entry: AnimEntry; stop: string; score: number }> {
    const hit = await this.find(id)
    if (!hit) throw new AnimError(`no animation "${id}"`)
    if (this.running.has(id)) throw new AnimError('already refining this clip')
    const token = { cancelled: false }
    this.running.set(id, token)
    const base = hit.entry.iterations?.length ?? 0
    const reference = await this.referenceClip(hit.entry)
    const pngs = new Map<number, Buffer[]>()
    try {
      const result = await animRefineLoop(
        hit.entry.clip,
        {
          render: async (clip, n) => {
            this.progress({ entryId: id, iteration: base + n, phase: 'render' })
            const times = beatFrameTimes(clip, Math.max(2, Math.min(8, opts.frames ?? 6)))
            if (!this.deps.capture) return { frames: [], times }
            const frames = await this.renderClip(clip, times, reference)
            pngs.set(n, frames)
            const files: string[] = []
            for (const [i, png] of frames.entries()) {
              const f = `frames/iter-${base + n}-${i + 1}.png`
              await hit.store.writeFile(id, f, png)
              files.push(f)
            }
            return { frames: files, times }
          },
          critique: async (clip, _files, times, n, previous) => {
            this.progress({ entryId: id, iteration: base + n, phase: 'critique' })
            const current = (await hit.store.read(id)) ?? hit.entry
            return this.critique(current, clip, pngs.get(n) ?? [], times, base + n, previous)
          },
          onIteration: async (it) => {
            const current = (await hit.store.read(id)) ?? hit.entry
            const iteration: AnimIteration = { n: base + it.n, at: this.now(), clip: it.clip, frames: it.frames, times: it.times, critique: it.critique }
            await hit.store.save({ ...current, iterations: [...(current.iterations ?? []), iteration].slice(-8), updatedAt: this.now() })
            this.progress({ entryId: id, iteration: base + it.n, phase: 'adjust', score: it.critique.overall, message: it.critique.summary })
            this.changed()
          },
          cancelled: () => token.cancelled
        },
        { maxIterations: opts.maxIterations ?? ANIM_DEFAULT_MAX_ITERATIONS, threshold: opts.threshold ?? ANIM_DEFAULT_THRESHOLD }
      )
      const current = (await hit.store.read(id)) ?? hit.entry
      const bestFrames = result.best.frames
      let entry = await hit.store.save({
        ...current,
        clip: result.best.clip,
        stats: measureClip(result.best.clip),
        thumbs: bestFrames.length ? [bestFrames[Math.min(bestFrames.length - 1, 2)], ...current.thumbs.filter((t) => !t.startsWith('frames/'))].slice(0, 6) : current.thumbs,
        updatedAt: this.now()
      })
      if (entry.written) entry = await this.writeProjectFiles(entry)
      this.progress({ entryId: id, iteration: base + result.iterations.length, phase: 'done', score: result.best.critique.overall, message: `stopped: ${result.stop}` })
      this.changed()
      return { entry, stop: result.stop, score: result.best.critique.overall }
    } catch (e) {
      this.progress({ entryId: id, iteration: base, phase: 'error', message: (e as Error).message })
      throw e
    } finally {
      this.running.delete(id)
    }
  }

  // ------------------------------------------------------------ export + upload

  // src/shared/Animations/<Name>/init.luau + Sequence.rbxmx (Rojo: a ModuleScript with the
  // KeyframeSequence as its child "Sequence").
  async writeProjectFiles(entry: AnimEntry): Promise<AnimEntry> {
    const root = this.deps.projectRoot()
    if (!root) throw new AnimError('Open the game project first: export writes into src/shared/Animations.')
    const hit = await this.find(entry.id)
    const store = hit?.store ?? this.user
    const name = animModuleName(entry.clip.name || entry.name)
    let dir = entry.written ? entry.written.module.replace(/\/init\.luau$/, '') : `${ANIM_SRC_DIR}/${name}`
    if (!entry.written) for (let i = 2; await exists(join(root, dir)); i++) dir = `${ANIM_SRC_DIR}/${name}${i}`
    const abs = resolve(root, dir)
    if (!abs.startsWith(resolve(root) + sep)) throw new AnimError('animation path escapes the project')
    await mkdir(abs, { recursive: true })
    await writeFile(join(abs, 'init.luau'), animLuauModule(entry.clip, { description: entry.description.slice(0, 300), assetId: entry.roblox?.assetId }), 'utf8')
    await writeFile(join(abs, ANIM_SEQUENCE_FILE), writeKeyframeSequenceXml(entry.clip), 'utf8')
    const written = { module: `${dir}/init.luau`, model: `${dir}/${ANIM_SEQUENCE_FILE}` }
    if (entry.written?.module === written.module) return entry
    return store.save({ ...entry, written })
  }

  async export(id: string): Promise<AnimExportResult> {
    const entry = await this.writeProjectFiles(await this.get(id))
    this.changed()
    const folder = entry.written!.module.replace(/\/init\.luau$/, '').split('/').pop()!
    const instancePath = `game.ReplicatedStorage.Shared.Animations.${folder}`
    return { module: entry.written!.module, model: entry.written!.model, instancePath, command: `require(${instancePath}).play(game.Players.LocalPlayer.Character)` }
  }

  // Open Cloud Assets API, assetType Animation (see art/robloxAssets.ts for the cited docs).
  async upload(id: string): Promise<AnimUploadResult> {
    const hit = await this.find(id)
    if (!hit) throw new AnimError(`no animation "${id}"`)
    const key = await this.deps.openCloud?.key()
    if (!key) throw new AnimError('No Open Cloud API key with asset:read + asset:write. Add one on the Art page (it is kept in the encrypted secret store).')
    const creator = this.deps.openCloud?.creator() ?? {}
    if (!creator.userId && !creator.groupId) throw new AnimError('Set the Roblox creator (user ID or group ID) on the Art page first.')
    const name = animModuleName(hit.entry.name)
    const result = await uploadAnimationAsset({
      apiKey: key,
      bytes: new Uint8Array(Buffer.from(writeKeyframeSequenceXml(hit.entry.clip), 'utf8')),
      fileName: `${name}.rbxmx`,
      displayName: name,
      description: hit.entry.description.slice(0, 900),
      creator,
      ...(this.deps.fetch ? { fetch: this.deps.fetch as never } : {})
    })
    let entry = await hit.store.save({ ...hit.entry, roblox: { assetId: result.assetId, uploadedAt: this.now() }, updatedAt: this.now() })
    if (entry.written && this.deps.projectRoot()) entry = await this.writeProjectFiles(entry)
    this.changed()
    return { assetId: result.assetId, uri: result.uri, ...(entry.written ? { module: entry.written.module } : {}) }
  }

  dispose(): void {
    for (const t of this.running.values()) t.cancelled = true
  }
}

export function cleanTags(tags: unknown[]): string[] {
  return [...new Set(tags.map((t) => String(t).toLowerCase().trim().replace(/[^a-z0-9 -]/g, '').slice(0, 24)).filter(Boolean))].slice(0, 16)
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false
  )
}

export { buildProfile }
