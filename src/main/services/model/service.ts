// Model Lab service: the per-project library of block models, the AI build script (prompt + reference
// images -> a BlockyKit script, repaired until it builds), the headless Lune preview build, the critic
// loop (preview snapshots + references -> "compare and fix" -> revised script) and "Build in Studio"
// through the Forge Bridge. Labs are visuals only: the script builds Parts; a guard copies an existing
// guard's gameplay pieces with kit:wireGuard. No electron imports: the model, the offscreen capture,
// Lune and the bridge come in as functions.

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { CRITIC_VIEWS, VIEW_LABELS, type ModelView } from '../../../shared/model/frame.ts'
import { guardPath, MODEL_PLUGIN_VERSION, modelJob, parseBuiltLog } from '../../../shared/model/job.ts'
import { composePrompt, criticPrompt, extractScript, MAX_SCRIPT_CHARS, modelName, parseCritic, repairPrompt, systemPrompt, TEMPLATE_INFO } from '../../../shared/model/prompt.ts'
import {
  MODEL_MAX_ROUNDS,
  MODEL_SETTINGS_DEFAULTS,
  MODEL_TEMPLATE_IDS,
  type ModelBuild,
  type ModelCriticRound,
  type ModelEntry,
  type ModelGenerateOptions,
  type ModelGenerateResult,
  type ModelGuardLink,
  type ModelPart,
  type ModelPhase,
  type ModelSettings,
  type ModelStatus,
  type ModelStudioResult,
  type ModelTemplateId
} from '../../../shared/model/types.ts'
import { newJobId, type BridgeEvent, type BridgeJob } from '../../../shared/studio/protocol.ts'
import type { LabTier } from '../../../shared/labModels.ts'
import { BridgeError, type RunOptions } from '../studio/bridge.ts'
import type { LuneRun } from '../vfx/lune.ts'
import { findModelAssets, luneModelBuild, readKit, readTemplate, type ModelAssets } from './lune.ts'
import { modelId, ModelStore, PROJECT_MODEL_DIR } from './store.ts'

export interface ImagePayload {
  mime: string
  base64: string
}
export type ModelFn = (system: string, prompt: string, images: ImagePayload[]) => Promise<string>

export interface ModelCaptureRequest {
  parts: ModelPart[]
  views: ModelView[]
  width: number
  height: number
}

export interface ModelBridge {
  connected(): boolean
  studio(): { pluginVersion?: number; place?: string } | null
  busy(): BridgeJob | null
  run(job: BridgeJob, handler: (ev: BridgeEvent, at: number) => unknown, opts?: RunOptions): Promise<void>
}

export interface ModelServiceDeps {
  // userData/models (the library when no project is open is <userDir>/library).
  userDir: string
  projectRoot: () => string | null
  lune: () => Promise<{ path: string; version?: string } | { error: string }>
  assets?: () => ModelAssets | null
  luneRun?: LuneRun
  model?: (tier: LabTier) => ModelFn | null
  // Whether a model call could reach a provider at all. Absent: assumed true when `model` is set.
  modelReady?: () => Promise<boolean>
  capture?: (req: ModelCaptureRequest) => Promise<Buffer[]>
  bridge?: () => ModelBridge | null
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  emit?: (event: 'model:changed' | 'model:progress', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  now?: () => number
}

export class ModelServiceError extends Error {}

export const SETTING_CRITIC = 'modelLab.critic'
export const SETTING_ROUNDS = 'modelLab.rounds'
const FRAME_SIZE = { width: 640, height: 480 }
const MAX_REFS = 4
const MAX_REF_BYTES = 8 * 1024 * 1024
const REPAIRS = 2
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

// "data:image/png;base64,..." -> { mime, base64, ext }.
export function decodeDataUrl(url: string): { mime: string; base64: string; ext: string } | null {
  const m = /^data:(image\/(png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(url ?? '').trim())
  if (!m) return null
  const base64 = m[3].replace(/\s+/g, '')
  if (Math.floor((base64.length * 3) / 4) > MAX_REF_BYTES) return null
  const ext = m[2].toLowerCase() === 'jpeg' ? 'jpg' : m[2].toLowerCase()
  return { mime: m[1].toLowerCase(), base64, ext }
}

const hash = (...parts: string[]) => createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 16)

export class ModelService {
  private deps: ModelServiceDeps
  private now: () => number
  private store: { root: string | null; store: ModelStore } | null = null

  constructor(deps: ModelServiceDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  // ------------------------------------------------------------ library

  library(): ModelStore {
    const root = this.deps.projectRoot()
    if (!this.store || this.store.root !== root) {
      const dir = root ? join(root, ...PROJECT_MODEL_DIR.split('/'), 'library') : join(this.deps.userDir, 'library')
      this.store = { root, store: new ModelStore(dir) }
    }
    return this.store.store
  }

  private changed(id?: string): void {
    this.deps.emit?.('model:changed', { at: this.now(), ...(id ? { id } : {}) })
  }

  private progress(phase: ModelPhase, message: string, extra: { id?: string; run?: string; round?: number } = {}): void {
    this.deps.emit?.('model:progress', { phase, message, at: this.now(), ...extra })
  }

  list(): Promise<ModelEntry[]> {
    return this.library().list()
  }

  async get(id: string): Promise<ModelEntry> {
    const e = await this.library().read(String(id ?? ''))
    if (!e) throw new ModelServiceError(`no model "${id}"`)
    return e
  }

  settings(): ModelSettings {
    const rounds = Number(this.deps.settings.get<number>(SETTING_ROUNDS, MODEL_SETTINGS_DEFAULTS.rounds))
    return {
      critic: this.deps.settings.get<boolean>(SETTING_CRITIC, MODEL_SETTINGS_DEFAULTS.critic) !== false,
      rounds: Number.isFinite(rounds) ? Math.max(0, Math.min(MODEL_MAX_ROUNDS, Math.round(rounds))) : MODEL_SETTINGS_DEFAULTS.rounds
    }
  }

  setSettings(patch: Partial<ModelSettings>): ModelSettings {
    if (patch && typeof patch.critic === 'boolean') this.deps.settings.set(SETTING_CRITIC, patch.critic)
    if (patch && patch.rounds !== undefined && Number.isFinite(Number(patch.rounds))) this.deps.settings.set(SETTING_ROUNDS, Math.max(0, Math.min(MODEL_MAX_ROUNDS, Math.round(Number(patch.rounds)))))
    return this.settings()
  }

  private assets(): ModelAssets {
    const a = (this.deps.assets ?? (() => findModelAssets()))()
    if (!a) throw new ModelServiceError('the Model Lab files (BlockyKit.luau, model_build.luau) are missing from this install')
    return a
  }

  async kitSource(): Promise<string> {
    return readKit(this.assets())
  }

  async templateScript(id: ModelTemplateId): Promise<string> {
    if (!MODEL_TEMPLATE_IDS.includes(id)) throw new ModelServiceError(`no template "${id}"`)
    return readTemplate(this.assets(), id)
  }

  private studioState(): ModelStatus['studio'] {
    const b = this.deps.bridge?.() ?? null
    if (!b) return { connected: false, canBuild: false, message: 'The Forge Bridge is not available' }
    const info = b.studio()
    if (!b.connected()) return { connected: false, canBuild: false, message: 'Studio is not connected: open your place in Studio with the Forge Bridge plugin on' }
    const v = info?.pluginVersion ?? 0
    const base = { connected: true, ...(info?.place ? { place: info.place } : {}), ...(v ? { pluginVersion: v } : {}) }
    if (v < MODEL_PLUGIN_VERSION) return { ...base, canBuild: false, message: `Studio runs Forge Bridge v${v || '?'}; restart Studio to load v${MODEL_PLUGIN_VERSION}, which can build models` }
    return { ...base, canBuild: true, message: info?.place ? `Builds in ${info.place}` : 'Studio is connected' }
  }

  async status(): Promise<ModelStatus> {
    const lune = await this.deps.lune().catch((e) => ({ error: (e as Error).message }))
    const ready = this.deps.model ? ((await this.deps.modelReady?.().catch(() => false)) ?? true) : false
    return {
      projectRoot: this.deps.projectRoot(),
      libraryDir: this.library().dir,
      lune: 'path' in lune ? { available: true, ...(lune.version ? { version: lune.version } : {}) } : { available: false, hint: lune.error },
      vision: ready && !!this.deps.model?.('critic'),
      render: !!this.deps.capture,
      studio: this.studioState(),
      settings: this.settings(),
      entries: (await this.list()).length
    }
  }

  // ------------------------------------------------------------ preview builds

  async run(script: string, opts: { name?: string } = {}): Promise<ModelBuild> {
    const text = String(script ?? '')
    if (!text.trim()) return { ok: false, parts: [], prints: [], warnings: [], error: { message: 'the script is empty' } }
    if (text.length > MAX_SCRIPT_CHARS) return { ok: false, parts: [], prints: [], warnings: [], error: { message: `the script is ${text.length.toLocaleString('en-US')} characters; keep it under ${MAX_SCRIPT_CHARS.toLocaleString('en-US')} (loops instead of repeated lines)` } }
    const lune = await this.deps.lune().catch((e) => ({ error: (e as Error).message }))
    if (!('path' in lune)) return { ok: false, parts: [], prints: [], warnings: [], error: { message: `The preview needs Lune. ${lune.error}` } }
    return luneModelBuild(text, { lune: lune.path, assets: this.assets(), name: opts.name, run: this.deps.luneRun })
  }

  private async cacheKey(script: string): Promise<string> {
    return hash(script, await this.kitSource().catch(() => ''))
  }

  private async saveBuild(id: string, script: string, build: ModelBuild): Promise<void> {
    if (!build.ok) return
    await this.library().writeFile(id, 'build.json', JSON.stringify({ key: await this.cacheKey(script), build }))
  }

  async load(id: string): Promise<{ entry: ModelEntry; build: ModelBuild }> {
    const entry = await this.get(id)
    const key = await this.cacheKey(entry.script)
    try {
      const cached = JSON.parse((await this.library().readFile(entry.id, 'build.json')).toString('utf8')) as { key?: string; build?: ModelBuild }
      if (cached.key === key && cached.build?.ok) return { entry, build: cached.build }
    } catch {
      // no cache yet
    }
    const build = await this.run(entry.script, { name: entry.name })
    if (build.ok) await this.saveBuild(entry.id, entry.script, build)
    return { entry, build }
  }

  private withBuild(entry: ModelEntry, build: ModelBuild): ModelEntry {
    const out: ModelEntry = { ...entry }
    if (build.ok) {
      out.parts = build.parts.length
      if (build.stats) out.stats = build.stats
      delete out.error
    } else out.error = build.error ? `${build.error.line ? `line ${build.error.line}: ` : ''}${build.error.message}` : 'the build failed'
    return out
  }

  private async put(entry: ModelEntry, build?: ModelBuild): Promise<ModelEntry> {
    const saved = await this.library().save(entry)
    if (build) await this.saveBuild(entry.id, entry.script, build)
    this.changed(entry.id)
    return saved
  }

  // ------------------------------------------------------------ entries

  async fromTemplate(template: ModelTemplateId, opts: { name?: string; prompt?: string } = {}): Promise<{ entry: ModelEntry; build: ModelBuild }> {
    const t = MODEL_TEMPLATE_IDS.includes(template) ? template : 'creature'
    const script = await this.templateScript(t)
    const name = opts.name?.trim() || `${TEMPLATE_INFO[t].label} ${new Date(this.now()).toISOString().slice(5, 16).replace('T', ' ')}`
    const build = await this.run(script, { name })
    const now = this.now()
    const entry = this.withBuild({ id: modelId(name), name, prompt: opts.prompt?.trim() || TEMPLATE_INFO[t].prompt, template: t, script, parts: 0, refs: [], origin: 'template', createdAt: now, updatedAt: now }, build)
    return { entry: await this.put(entry, build), build }
  }

  async save(id: string, patch: { script?: string; name?: string; prompt?: string; template?: ModelTemplateId; guard?: ModelGuardLink | null }): Promise<{ entry: ModelEntry; build: ModelBuild }> {
    const entry = await this.get(id)
    const next: ModelEntry = { ...entry, updatedAt: this.now() }
    if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim().slice(0, 80)
    if (typeof patch.prompt === 'string') next.prompt = patch.prompt.slice(0, 2000)
    if (patch.template && MODEL_TEMPLATE_IDS.includes(patch.template)) next.template = patch.template
    if (patch.guard === null) delete next.guard
    else if (patch.guard && typeof patch.guard.path === 'string') next.guard = { path: patch.guard.path.trim().slice(0, 300), areaId: String(patch.guard.areaId ?? '').trim().slice(0, 80) }
    let build: ModelBuild
    if (typeof patch.script === 'string' && patch.script !== entry.script) {
      next.script = patch.script
      next.origin = 'edit'
      build = await this.run(next.script, { name: next.name })
      return { entry: await this.put(this.withBuild(next, build), build), build }
    }
    const loaded = await this.load(entry.id)
    build = loaded.build
    return { entry: await this.put(next), build }
  }

  async rename(id: string, name: string): Promise<ModelEntry> {
    const n = String(name ?? '').trim()
    if (!n) throw new ModelServiceError('give the model a name')
    const entry = await this.get(id)
    return this.put({ ...entry, name: n.slice(0, 80), updatedAt: this.now() })
  }

  async remove(id: string): Promise<boolean> {
    const ok = await this.library().remove(String(id ?? ''))
    if (ok) this.changed(id)
    return ok
  }

  async file(id: string, file: string): Promise<string | null> {
    try {
      const buf = await this.library().readFile(String(id), String(file))
      const ext = String(file).split('.').pop()?.toLowerCase() ?? 'png'
      return `data:${IMAGE_MIME[ext] ?? 'application/octet-stream'};base64,${buf.toString('base64')}`
    } catch {
      return null
    }
  }

  async saveThumb(id: string, url: string): Promise<ModelEntry> {
    const entry = await this.get(id)
    const img = decodeDataUrl(url)
    if (!img) throw new ModelServiceError('the thumbnail is not a PNG / JPEG data URL')
    await this.library().writeFile(entry.id, 'thumb.png', Buffer.from(img.base64, 'base64'))
    // The thumbnail does not count as an edit (no updatedAt bump, no re-sort).
    const saved = await this.library().save({ ...entry, thumb: 'thumb.png', thumbStamp: entry.updatedAt })
    this.changed(entry.id)
    return saved
  }

  private async refImages(entry: ModelEntry): Promise<ImagePayload[]> {
    const out: ImagePayload[] = []
    for (const f of entry.refs.slice(0, MAX_REFS)) {
      const buf = await this.library().readFile(entry.id, f).catch(() => null)
      if (!buf) continue
      const ext = f.split('.').pop()?.toLowerCase() ?? 'png'
      out.push({ mime: IMAGE_MIME[ext] ?? 'image/png', base64: buf.toString('base64') })
    }
    return out
  }

  // ------------------------------------------------------------ AI

  private async modelReady(): Promise<boolean> {
    if (!this.deps.model) return false
    return (await this.deps.modelReady?.().catch(() => false)) ?? true
  }

  // Asks for a script and repairs it (up to REPAIRS more calls) until it builds.
  private async writeScript(ask: ModelFn, system: string, base: string, images: ImagePayload[], name: string, tag: { id?: string; run?: string; round?: number }): Promise<{ script: string; build: ModelBuild; raw: string }> {
    let raw = await ask(system, base, images)
    let lastProblem = ''
    for (let attempt = 0; attempt <= REPAIRS; attempt++) {
      const script = extractScript(raw)
      let problem: string
      if (!script) problem = 'there was no ```lua script in the answer'
      else if (script.length > MAX_SCRIPT_CHARS) problem = `the script is ${script.length.toLocaleString('en-US')} characters; keep it under ${MAX_SCRIPT_CHARS.toLocaleString('en-US')} with loops and helper functions`
      else {
        this.progress('building', attempt ? `Building the repaired script (${attempt})` : 'Building the preview', tag)
        const build = await this.run(script, { name })
        if (build.ok) return { script, build, raw }
        const e = build.error
        const where = e?.line ? ` (line ${e.line}: ${script.split('\n')[e.line - 1]?.trim().slice(0, 160) ?? ''})` : ''
        problem = `${e?.message ?? 'the build failed'}${where}`
        // Without Lune nothing can be checked: keep the script as it is.
        if (/needs Lune/.test(e?.message ?? '')) return { script, build, raw }
      }
      lastProblem = problem
      if (attempt === REPAIRS) break
      this.progress('repairing', `Fixing the script: ${problem.slice(0, 140)}`, tag)
      raw = await ask(system, repairPrompt(base, script ?? raw, problem), images)
    }
    throw new ModelServiceError(`the model's script did not build (${lastProblem})`)
  }

  private async criticRounds(entry: ModelEntry, build: ModelBuild, opts: { rounds: number; run?: string; first?: number }): Promise<{ entry: ModelEntry; build: ModelBuild; notes: string[] }> {
    const critic = this.deps.model?.('critic')
    const notes: string[] = []
    if (!critic || !this.deps.capture || !build.ok || !build.parts.length) return { entry, build, notes }
    const system = systemPrompt({ kitSource: await this.kitSource(), template: entry.template })
    const refs = await this.refImages(entry)
    let cur = { entry, build }
    const start = opts.first ?? (entry.critic?.length ?? 0) + 1
    for (let i = 0; i < opts.rounds; i++) {
      const round = start + i
      const tag = { id: entry.id, run: opts.run, round }
      this.progress('capturing', `Round ${round}: snapshotting the preview`, tag)
      let frames: Buffer[]
      try {
        frames = await this.deps.capture({ parts: cur.build.parts, views: CRITIC_VIEWS, ...FRAME_SIZE })
      } catch (e) {
        notes.push(`the critic was skipped: the preview could not be captured (${(e as Error).message})`)
        break
      }
      const files: string[] = []
      for (let k = 0; k < frames.length && k < CRITIC_VIEWS.length; k++) {
        const f = `frames/r${round}-${CRITIC_VIEWS[k]}.png`
        await this.library().writeFile(entry.id, f, frames[k])
        files.push(f)
      }
      const images = [...frames.map((b) => ({ mime: 'image/png', base64: b.toString('base64') })), ...refs]
      const prompt = criticPrompt({ prompt: cur.entry.prompt, template: cur.entry.template, views: CRITIC_VIEWS.slice(0, frames.length).map((v) => VIEW_LABELS[v]), refs: refs.length, script: cur.entry.script, build: cur.build, round, rounds: start + opts.rounds - 1 })
      this.progress('critic', `Round ${round}: comparing with the request${refs.length ? ' and the references' : ''}`, tag)
      const rec: ModelCriticRound = { round, at: this.now(), summary: '', changed: false, frames: files }
      try {
        const raw = await critic(system, prompt, images)
        const parsed = parseCritic(raw)
        rec.summary = parsed.summary
        if (parsed.noChange || !parsed.script) {
          if (!parsed.noChange) rec.error = 'the critic answered without a script'
        } else {
          this.progress('revising', `Round ${round}: building the revision`, tag)
          const revised = await this.writeScript(async (s, p, im) => (p === prompt ? raw : critic(s, p, im)), system, prompt, images, cur.entry.name, tag)
          if (revised.build.ok) {
            rec.changed = true
            rec.parts = revised.build.parts.length
            cur = { entry: this.withBuild({ ...cur.entry, script: revised.script, updatedAt: this.now() }, revised.build), build: revised.build }
          }
        }
      } catch (e) {
        rec.error = (e as Error).message.slice(0, 300)
        notes.push(`critic round ${round}: ${rec.error}`)
      }
      cur.entry = { ...cur.entry, critic: [...(cur.entry.critic ?? []), rec].slice(-12), updatedAt: this.now() }
      cur.entry = await this.put(cur.entry, cur.build)
      if (!rec.changed) break
    }
    return { ...cur, notes }
  }

  async generate(prompt: string, opts: ModelGenerateOptions = {}): Promise<ModelGenerateResult> {
    const text = String(prompt ?? '').trim()
    const existing = opts.id ? await this.get(opts.id) : null
    if (text.length < 2 && !existing) throw new ModelServiceError('Describe the model, e.g. "a spiky shark guard" or "pig egg".')
    const template: ModelTemplateId = opts.template && MODEL_TEMPLATE_IDS.includes(opts.template) ? opts.template : (existing?.template ?? 'creature')
    const tag = { id: existing?.id, run: opts.run }
    const name = opts.name?.trim() || existing?.name || modelName(text, TEMPLATE_INFO[template].label)
    const now = this.now()
    const id = existing?.id ?? modelId(name)
    // References: new data URLs are stored with the entry; a revision keeps the entry's own.
    const refFiles = [...(existing?.refs ?? [])]
    const newRefs = (opts.refs ?? []).map(decodeDataUrl).filter((r): r is NonNullable<typeof r> => !!r)
    if ((opts.refs ?? []).length && !newRefs.length) throw new ModelServiceError('the reference images must be PNG, JPEG, WebP or GIF (up to 8 MB each)')
    if (newRefs.length) {
      refFiles.length = 0
      for (const f of existing?.refs ?? []) await this.library().removeFile(id, f).catch(() => undefined)
      for (const [i, r] of newRefs.slice(0, MAX_REFS).entries()) {
        const f = `refs/ref-${i + 1}-${hash(r.base64).slice(0, 6)}.${r.ext}`
        await this.library().writeFile(id, f, Buffer.from(r.base64, 'base64'))
        refFiles.push(f)
      }
    }
    let entry: ModelEntry = existing
      ? { ...existing, prompt: text || existing.prompt, template, refs: refFiles, updatedAt: now }
      : { id, name, prompt: text, template, script: '', parts: 0, refs: refFiles, origin: 'ai', createdAt: now, updatedAt: now }
    const images = await this.refImages(entry)
    const notes: string[] = []
    let source: ModelGenerateResult['source'] = 'model'
    let script = ''
    let build: ModelBuild | null = null
    const ask = (await this.modelReady()) ? this.deps.model?.('default') : null
    if (ask) {
      this.progress('writing', `Writing the build script${images.length ? ` from ${images.length} reference${images.length === 1 ? '' : 's'}` : ''}`, tag)
      try {
        const system = systemPrompt({ kitSource: await this.kitSource(), template, templateScript: await this.templateScript(template) })
        const r = await this.writeScript(ask, system, composePrompt({ prompt: entry.prompt, template, refs: images.length, current: existing?.script }), images, name, tag)
        script = r.script
        build = r.build
        delete entry.modelError
      } catch (e) {
        const message = (e as Error).message
        this.deps.log?.(`model lab: ${message}`, 'stderr')
        entry.modelError = message.slice(0, 400)
        notes.push(`The AI script was not usable (${message.slice(0, 200)}); ${existing ? 'the model is unchanged' : `started from the ${TEMPLATE_INFO[template].label} template`}.`)
      }
    } else notes.push(`No AI model is set up (Settings > Providers); started from the ${TEMPLATE_INFO[template].label} template.`)
    if (!build) {
      source = 'template'
      script = existing?.script || (await this.templateScript(template))
      this.progress('building', 'Building the preview', tag)
      build = await this.run(script, { name })
    }
    entry = this.withBuild({ ...entry, script, origin: source === 'model' ? 'ai' : existing ? existing.origin : 'template' }, build)
    this.progress('saving', 'Saving', { ...tag, id })
    entry = await this.put(entry, build)
    const settings = this.settings()
    const critic = opts.critic ?? settings.critic
    const rounds = Math.max(0, Math.min(MODEL_MAX_ROUNDS, Math.round(opts.rounds ?? settings.rounds)))
    if (critic && rounds > 0 && source === 'model' && build.ok) {
      const r = await this.criticRounds(entry, build, { rounds, run: opts.run })
      entry = r.entry
      build = r.build
      notes.push(...r.notes)
    }
    this.progress('done', build.ok ? `${build.parts.length} parts` : `The build failed: ${entry.error ?? ''}`, { ...tag, id })
    return { entry, build, source, notes }
  }

  // One critic round on a saved model.
  async critique(id: string, opts: { run?: string } = {}): Promise<ModelGenerateResult> {
    const { entry, build } = await this.load(id)
    if (!build.ok) throw new ModelServiceError(`fix the build first: ${build.error?.message ?? 'it failed'}`)
    if (!(await this.modelReady())) throw new ModelServiceError('No AI model is set up (Settings > Providers)')
    if (!this.deps.capture) throw new ModelServiceError('the preview cannot be captured here')
    const r = await this.criticRounds(entry, build, { rounds: 1, run: opts.run })
    this.progress('done', `${r.build.parts.length} parts`, { id, run: opts.run })
    return { entry: r.entry, build: r.build, source: 'model', notes: r.notes }
  }

  // ------------------------------------------------------------ Studio

  async buildInStudio(id: string, opts: { guard?: ModelGuardLink | null } = {}): Promise<ModelStudioResult> {
    let entry = await this.get(id)
    const bridge = this.deps.bridge?.() ?? null
    const state = this.studioState()
    if (!bridge || !state.canBuild) throw new ModelServiceError(state.message)
    if (bridge.busy()) throw new ModelServiceError('A Studio check is running; build again when it finishes')
    if (opts.guard !== undefined) {
      entry = (await this.save(entry.id, { guard: opts.guard })).entry
    }
    const guard = entry.guard?.path ? entry.guard : null
    const job = modelJob({ id: newJobId(), name: entry.name, kit: await this.kitSource(), script: entry.script, guard: guard ? guardPath(guard.path) : undefined, areaId: guard?.areaId || undefined })
    this.progress('studio', `Building ${entry.name} in Studio`, { id: entry.id })
    let built: ReturnType<typeof parseBuiltLog> = null
    try {
      await bridge.run(
        job,
        (ev) => {
          if (ev.type === 'log') built = parseBuiltLog(ev.message) ?? built
          return {}
        },
        { acceptTimeoutMs: 12_000, timeoutMs: 90_000 }
      )
    } catch (e) {
      if (e instanceof BridgeError && e.code === 'plugin-error') throw new ModelServiceError(e.message.replace(/^Studio: /, ''))
      if (e instanceof BridgeError && e.code === 'busy') throw new ModelServiceError('A Studio check is running; build again when it finishes')
      throw e
    }
    const b = built as ReturnType<typeof parseBuiltLog>
    const result: ModelStudioResult = { name: b?.name ?? job.name, parts: b?.parts ?? 0, path: b?.path ?? `Workspace.${job.name}`, ...(state.place ? { place: state.place } : {}) }
    this.deps.log?.(`model lab: built ${result.path} (${result.parts} parts) in Studio`)
    return result
  }
}
