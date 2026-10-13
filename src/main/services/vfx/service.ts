// VFX Lab service: the reference library (import, tags, search), learning (recipes saved as memory
// skills), effect creation (spec -> .rbxmx + Luau module in the project), offscreen rendering, and
// the render / critique / refine loop with ratings feeding back into memory.
//
// Nothing here is model fine-tuning: the library is the training data, retrieval picks the closest
// references and recipes, and a vision model critiques rendered frames against them.
// No electron imports: rendering (capture), the vision model and Rojo come in as functions.

import type { LabTier } from '../../../shared/labModels.ts'
import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { allNodes, autoTags, describeEffect, effectFromNodes, effectStats, perfWarnings, type PerfWarning } from '../../../shared/vfx/analyze.ts'
import { CRITIC_SYSTEM, critiquePrompt, DEFAULT_MAX_ITERATIONS, DEFAULT_THRESHOLD, heuristicCritique, parseCritique, refineLoop, stageFrameTimes, type RefineResult } from '../../../shared/vfx/critique.ts'
import { CHOREOGRAPHY_GUIDE, draftScript, kitReference, TIMELINE_API } from '../../../shared/vfx/choreo.ts'
import { compileTimeline, finishRun } from '../../../shared/vfx/compile.ts'
import { findExample, VFX_EXAMPLES, CHARGE_SLASH } from '../../../shared/vfx/examples.ts'
import { RECORDED } from '../../../shared/vfx/examples.recorded.ts'
import { FORGEFX_SOURCE, isOwnRuntime, RUNTIME_MODULE } from '../../../shared/vfx/runtime.ts'
import { timelineSummary } from '../../../shared/vfx/timeline.ts'
import { draftSpec, libraryTextures, promptTags } from '../../../shared/vfx/draft.ts'
import { luauModule, needsRuntime, timelineModule } from '../../../shared/vfx/luau.ts'
import { readRbxmx, writeRbxmx } from '../../../shared/vfx/rbxmx.ts'
import { extractRecipe, extractRecipes, RECIPE_PREFIX, recipeSkill } from '../../../shared/vfx/recipes.ts'
import { compactEffect, effectFromSpec, safeName, SpecError, type VfxSpec } from '../../../shared/vfx/spec.ts'
import type { VfxCritique, VfxEffect, VfxEntry, VfxImportResult, VfxIteration, VfxLabStatus, VfxRecipe, VfxRefineOptions, VfxRefineProgress, VfxScope, VfxScriptResult } from '../../../shared/vfx/types.ts'
import { studioFramesNote } from '../../../shared/studio/frames.ts'
import { entryId, PROJECT_VFX_DIR, safeFileName, VfxLibraryError, VfxStore } from './library.ts'
import { PROCEDURAL_GUIDE, isTexRef, type ExportPlan } from '../../../shared/vfx/tex/textures.ts'
import { luneExtract, luneTimeline, type LuneRun } from './lune.ts'

export interface ImagePayload {
  mime: string
  base64: string
}

export type VisionFn = (system: string, prompt: string, images: ImagePayload[]) => Promise<string>

export interface MemoryLike {
  remember(input: { scope: 'user' | 'project'; kind?: 'memory' | 'skill'; type?: 'user' | 'project' | 'feedback' | 'reference'; name: string; description: string; body: string }, source?: 'agent' | 'reflection' | 'style' | 'user'): Promise<{ entry: { name: string } }>
}

export interface CaptureRequest {
  effect: VfxEffect
  times: number[]
  width: number
  height: number
  background?: 'dark' | 'grey'
}

export interface VfxServiceDeps {
  // userData/vfx (the user library is <userDir>/library).
  userDir: string
  projectRoot: () => string | null
  lune: () => Promise<{ path: string; version?: string } | { error: string }>
  runtimeDir: () => string | null
  luneRun?: LuneRun
  capture?: (req: CaptureRequest) => Promise<Buffer[]>
  // Per-task tier (shared/labModels.ts): 'critic' for frame critique, 'default' for drafting/compose.
  vision?: (tier?: LabTier) => VisionFn | null
  memory?: MemoryLike
  rojo?: { running(): boolean; start(): Promise<void> }
  fetch?: typeof fetch
  emit?: (event: 'vfx:changed' | 'vfx:progress', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  now?: () => number
  // Custom textures (textures/service.ts): forgetex:// previews, gen-ref materialisation on save,
  // the rbxassetid swap when effects are written to the project, and the list for prompts.
  textures?: VfxTextureHooks
}

export interface VfxTextureHooks {
  resolve(ref: string): Promise<string | null>
  prepareEffect(effect: VfxEffect, scope?: VfxScope): Promise<VfxEffect>
  exportEffect(effect: VfxEffect): Promise<ExportPlan>
  promptList(limit?: number): Promise<string[]>
}

const MODEL_EXT = new Set(['.rbxm', '.rbxmx'])
const MEDIA_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' }
const MAX_IMPORT_FILES = 400
const MAX_FILE_BYTES = 60 * 1024 * 1024
export const VFX_SRC_DIR = 'src/shared/VFX'
const FRAME_SIZE = { width: 512, height: 384 }

export class VfxError extends Error {}

export function frameTimes(duration: number, n: number): number[] {
  // Denser early on: bursts peak in the first third of a play.
  return Array.from({ length: n }, (_, i) => Math.round(duration * Math.pow((i + 0.5) / n, 1.5) * 1000) / 1000)
}

const DRAFT_SYSTEM = `You write Roblox VFX as a JSON spec for the RBX Forge VFX Lab. Answer with JSON only, no prose.
Spec: {"name","description","tags":[...],"duration":seconds,"motion":"static|swing|orbit|dash|rise","anchor":[x,y,z] (studs from the dummy's feet; it faces -Z),
"layers":[{"name","class":"ParticleEmitter|Beam|Trail|PointLight|SpotLight|Highlight","props":{Roblox property: value},"emit":[{"at":s,"count":n}],"enable":[[from,to]],"shape":{"size":[x,y,z]},"width":studs (Trail),"from":[x,y,z],"to":[x,y,z] (Beam)}]}
Values: numbers; ranges [min,max]; vectors [x,y,z]; NumberSequence [[t,v],[t,v,envelope]]; ColorSequence ["#hex",...] or [[t,"#hex"],...]; enums by item name ("Top", "VelocityParallel", "Grid4x4", "OneShot"); Texture "rbxassetid://<id>" or "forgetex://...".
${PROCEDURAL_GUIDE}
Good Roblox VFX are layered (bright additive core, soft glow, fast sparks with VelocityParallel + Squash, low-LightEmission smoke, a ring), sizes swell fast then decay, transparency fades to 1, bursts are emitters with emit cues, and stay under ~400 live particles.`

// System prompt for vfx_compose: the model writes a whole multi-stage effect as a timeline script.
export const COMPOSE_SYSTEM = `You are a senior Roblox VFX artist. You choreograph multi-stage effects for the RBX Forge VFX Lab by writing a Luau timeline script that spawns building blocks from the kit and tweens them over time.
Answer with exactly one \`\`\`lua code block holding the whole script (return function(fx) ... end), no prose outside it. Name the effect on the first line as a comment: -- Name: <PascalCase>
${'$'}{API}

${'$'}{GUIDE}

${'$'}{TEXTURES}

A complete example (a charge-and-slash):
\`\`\`lua
${'$'}{EXAMPLE}\`\`\``
  .replace('${API}', kitReference())
  .replace('${GUIDE}', CHOREOGRAPHY_GUIDE)
  .replace('${TEXTURES}', `${PROCEDURAL_GUIDE} When none of the built-in textures fits a layer (a ring that should be a ring, smoke that should be a puff, a crack, a slash crescent), pass texture = "forgetex://gen/<type>" in the spawn options; prefer the user's liked library textures when they fit.`)
  .replace('${EXAMPLE}', CHARGE_SLASH)

const EMPTY_BASE = (name: string): VfxEffect => ({ name, roots: [], cues: [], duration: 2 })

// The script in a model answer: the first lua / luau fence, else the text from "return function".
export function extractScript(raw: string): string | null {
  const fence = /```(?:lua|luau)?\s*\n([\s\S]*?)```/i.exec(raw)
  const code = (fence ? fence[1] : raw.slice(Math.max(0, raw.indexOf('return function')))).trim()
  return /return\s+function\s*\(/.test(code) ? code + '\n' : null
}

// "-- Name: HollowPurple" on the first lines of a script, else a name from the request.
export function scriptName(script: string, request: string): string {
  const m = /^\s*--\s*Name:\s*([A-Za-z][\w ]{0,40})/m.exec(script.split('\n').slice(0, 3).join('\n'))
  return safeName(m?.[1] ?? request.replace(/\b(make|a|an|the|effect|vfx|please|with|and|of)\b/gi, ' ')).slice(0, 40) || 'Sequence'
}

export class VfxService {
  readonly user: VfxStore
  private deps: VfxServiceDeps
  private projectStore: { root: string; store: VfxStore } | null = null
  private running = new Map<string, { cancelled: boolean }>()
  private textureCache = new Map<string, Promise<string | null>>()
  private now: () => number

  constructor(deps: VfxServiceDeps) {
    this.deps = deps
    this.user = new VfxStore('user', join(deps.userDir, 'library'))
    this.now = deps.now ?? Date.now
  }

  get userLibraryDir(): string {
    return this.user.dir
  }

  project(): VfxStore | null {
    const root = this.deps.projectRoot()
    if (!root) return null
    if (this.projectStore?.root !== root) this.projectStore = { root, store: new VfxStore('project', join(root, ...PROJECT_VFX_DIR.split('/'), 'library')) }
    return this.projectStore.store
  }

  store(scope: VfxScope): VfxStore {
    if (scope === 'user') return this.user
    const p = this.project()
    if (!p) throw new VfxError('Open a project to use the project library (or import into your user library).')
    return p
  }

  private changed(): void {
    this.deps.emit?.('vfx:changed', { at: this.now() })
  }

  // ------------------------------------------------------------ library

  async list(): Promise<VfxEntry[]> {
    const p = this.project()
    return [...(p ? await p.list() : []), ...(await this.user.list())]
  }

  async find(id: string): Promise<{ entry: VfxEntry; store: VfxStore } | null> {
    for (const s of [this.project(), this.user]) {
      if (!s) continue
      const e = await s.read(id).catch(() => null)
      if (e) return { entry: e, store: s }
    }
    return null
  }

  async get(id: string): Promise<VfxEntry> {
    const hit = await this.find(String(id))
    if (!hit) throw new VfxError(`no VFX entry "${id}"`)
    return hit.entry
  }

  async status(): Promise<VfxLabStatus> {
    const lune = await this.deps.lune().catch((e) => ({ error: (e as Error).message }))
    const p = this.project()
    return {
      projectRoot: this.deps.projectRoot(),
      lune: 'error' in lune ? { available: false, hint: lune.error } : { available: true, ...(lune.version ? { version: lune.version } : {}) },
      vision: !!this.deps.vision?.(),
      rojo: this.deps.rojo?.running() ?? false,
      entries: { user: (await this.user.list()).length, project: p ? (await p.list()).length : 0 },
      recipes: (await this.recipes()).length
    }
  }

  // Ranked search over names, tags, descriptions and layer names.
  async search(query: string, opts: { limit?: number; includeAvoid?: boolean } = {}): Promise<VfxEntry[]> {
    const all = (await this.list()).filter((e) => opts.includeAvoid || e.quality !== 'avoid')
    const words = query.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length > 1)
    if (!words.length) return all.slice(0, opts.limit ?? 50)
    const scored = all
      .map((e) => {
        const layers = e.effect ? allNodes(e.effect.roots).map((n) => n.name.toLowerCase()).join(' ') : ''
        const name = e.name.toLowerCase()
        let s = 0
        for (const w of words) {
          if (e.tags.includes(w)) s += 4
          if (name.includes(w)) s += 3
          if (e.description.toLowerCase().includes(w)) s += 1
          if (layers.includes(w)) s += 1
        }
        if (e.quality === 'good' || e.rating === 'up') s *= 1.2
        if (e.kind === 'media') s *= 0.8
        return { e, s }
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || b.e.updatedAt - a.e.updatedAt)
    return scored.slice(0, opts.limit ?? 50).map((x) => x.e)
  }

  async update(id: string, patch: { name?: string; description?: string; tags?: string[]; effect?: VfxEffect }): Promise<VfxEntry> {
    const hit = await this.find(id)
    if (!hit) throw new VfxError(`no VFX entry "${id}"`)
    const e: VfxEntry = { ...hit.entry, updatedAt: this.now() }
    if (typeof patch.name === 'string' && patch.name.trim()) e.name = patch.name.trim().slice(0, 80)
    if (typeof patch.description === 'string') e.description = patch.description.slice(0, 2000)
    if (Array.isArray(patch.tags)) e.tags = [...new Set(patch.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean))].slice(0, 16)
    if (patch.effect) {
      e.effect = await this.prepareTextures(patch.effect, hit.store.scope)
      e.stats = effectStats(e.effect)
    }
    const saved = await hit.store.save(e)
    // Live edits of a generated effect write back to its Luau module and .rbxmx.
    if (patch.effect && saved.written) await this.writeProjectFiles(saved).catch((err) => this.deps.log?.(`vfx: write back failed: ${(err as Error).message}`, 'stderr'))
    this.changed()
    return saved
  }

  async remove(id: string): Promise<boolean> {
    const hit = await this.find(id)
    if (!hit) return false
    const ok = await hit.store.remove(id)
    this.changed()
    return ok
  }

  // A file of an entry (thumb, frame, media) as a data URL for the renderer.
  async file(id: string, file: string): Promise<string | null> {
    const hit = await this.find(id)
    if (!hit) return null
    try {
      const bytes = await hit.store.readFile(id, file)
      const mime = MEDIA_MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
      return `data:${mime};base64,${bytes.toString('base64')}`
    } catch {
      return null
    }
  }

  async saveThumb(id: string, dataUrl: string): Promise<VfxEntry> {
    const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl))
    if (!m) throw new VfxError('expected a PNG data URL')
    const hit = await this.find(id)
    if (!hit) throw new VfxError(`no VFX entry "${id}"`)
    const bytes = Buffer.from(m[1], 'base64')
    if (bytes.length > 4 * 1024 * 1024) throw new VfxError('thumbnail too large')
    await hit.store.writeFile(id, 'thumbs/preview.png', bytes)
    const e = await hit.store.save({ ...hit.entry, thumbs: ['thumbs/preview.png', ...hit.entry.thumbs.filter((t) => t !== 'thumbs/preview.png')].slice(0, 6) })
    this.changed()
    return e
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
      } else if (s.isFile() && s.size <= MAX_FILE_BYTES) {
        const ext = extname(p).toLowerCase()
        if (MODEL_EXT.has(ext) || MEDIA_MIME[ext]) out.push(p)
      }
    }
    for (const p of paths) await walk(resolve(String(p)), 0)
    return out
  }

  async import(paths: string[], scope: VfxScope = 'user'): Promise<VfxImportResult> {
    const store = this.store(scope)
    const files = await this.expand(Array.isArray(paths) ? paths : [])
    const result: VfxImportResult = { added: [], skipped: [] }
    if (!files.length) return result
    const models = files.filter((f) => MODEL_EXT.has(extname(f).toLowerCase()))
    const media = files.filter((f) => !MODEL_EXT.has(extname(f).toLowerCase()))
    const extracted = new Map<string, { roots?: import('../../../shared/vfx/types.ts').VfxNode[]; error?: string }>()
    if (models.length) {
      const lune = await this.deps.lune().catch((e) => ({ error: (e as Error).message }))
      const runtime = this.deps.runtimeDir()
      if (!('error' in lune) && runtime) {
        for (const r of await luneExtract(models, { lune: lune.path, runtimeDir: runtime, run: this.deps.luneRun })) extracted.set(r.file, r)
      }
      for (const f of models) {
        const prev = extracted.get(f)
        if (prev?.roots) continue
        if (extname(f).toLowerCase() === '.rbxmx') {
          try {
            extracted.set(f, { roots: readRbxmx(await readFile(f, 'utf8')) })
          } catch (e) {
            extracted.set(f, { error: `could not read the XML: ${(e as Error).message}` })
          }
        } else if (!prev) {
          extracted.set(f, { error: `binary .rbxm needs Lune (${'error' in lune ? lune.error : 'runtime missing'})` })
        }
      }
    }
    for (const f of models) {
      const r = extracted.get(f)
      if (!r?.roots) {
        result.skipped.push({ file: f, reason: r?.error ?? 'unreadable' })
        continue
      }
      const groups = splitEffects(r.roots)
      if (!groups.length) {
        result.skipped.push({ file: f, reason: 'no ParticleEmitter, Beam, Trail or light found' })
        continue
      }
      for (const g of groups) {
        const name = groups.length > 1 ? g.name : basename(f, extname(f))
        const effect = effectFromNodes(name, g.nodes)
        const id = entryId(name)
        const now = this.now()
        const entry: VfxEntry = {
          id,
          scope,
          kind: 'model',
          name,
          description: describeEffect(effect),
          tags: autoTags(effect, basename(f)),
          createdAt: now,
          updatedAt: now,
          origin: basename(f),
          effect,
          stats: effectStats(effect),
          thumbs: [],
          quality: 'reference'
        }
        const bytes = await readFile(f)
        if (bytes.length < 20 * 1024 * 1024) await store.writeFile(id, `media/${safeFileName(basename(f))}`, bytes)
        result.added.push(await store.save(entry))
      }
    }
    for (const f of media) {
      const ext = extname(f).toLowerCase()
      const name = basename(f, ext)
      const id = entryId(name)
      const file = `media/${safeFileName(basename(f))}`
      await store.writeFile(id, file, await readFile(f))
      const tags = autoTags({ name, roots: [], cues: [], duration: 1 }, name).filter((t) => !['impact', 'aura'].includes(t))
      const now = this.now()
      const isImage = MEDIA_MIME[ext].startsWith('image/')
      result.added.push(
        await store.save({
          id,
          scope,
          kind: 'media',
          name,
          description: `Visual reference (${MEDIA_MIME[ext]}) for critique.`,
          tags,
          createdAt: now,
          updatedAt: now,
          origin: basename(f),
          media: [{ file, mime: MEDIA_MIME[ext] }],
          thumbs: isImage ? [file] : [],
          quality: 'reference'
        })
      )
    }
    this.changed()
    return result
  }

  // ------------------------------------------------------------ learn

  private recipesFile(): string {
    return join(this.deps.userDir, 'recipes.json')
  }

  async recipes(): Promise<VfxRecipe[]> {
    try {
      const r = JSON.parse(await readFile(this.recipesFile(), 'utf8'))
      return Array.isArray(r) ? r : []
    } catch {
      return []
    }
  }

  // Library -> recipes -> memory skills (vfx-recipe-<tag>) through the memory layer.
  async learn(): Promise<{ recipes: VfxRecipe[]; saved: string[]; errors: string[] }> {
    const entries = await this.list()
    const recipes = extractRecipes(entries)
    await mkdir(this.deps.userDir, { recursive: true })
    await writeFile(this.recipesFile(), JSON.stringify(recipes, null, 1), 'utf8')
    const saved: string[] = []
    const errors: string[] = []
    if (this.deps.memory) {
      for (const r of recipes) {
        const examples = entries
          .filter((e) => e.tags.includes(r.tag) && e.quality !== 'avoid' && e.effect)
          .slice(0, 4)
          .map((e) => `${e.name} (${e.scope} library ${e.id}): ${e.description}`.slice(0, 220))
        const skill = recipeSkill(r, examples)
        try {
          const res = await this.deps.memory.remember({ scope: 'user', kind: 'skill', ...skill }, 'agent')
          saved.push(res.entry.name)
        } catch (e) {
          errors.push(`${skill.name}: ${(e as Error).message}`)
        }
      }
    }
    this.changed()
    return { recipes, saved, errors }
  }

  async recipeFor(tags: string[]): Promise<VfxRecipe | null> {
    const recipes = await this.recipes()
    for (const t of tags) {
      const hit = recipes.find((r) => r.tag === t)
      if (hit) return hit
    }
    // Not learned yet: compute on the fly from the library.
    const entries = await this.list()
    for (const t of tags) {
      const r = extractRecipe(t, entries)
      if (r) return r
    }
    return null
  }

  // ------------------------------------------------------------ rating

  async rate(id: string, rating: 'up' | 'down' | null): Promise<VfxEntry> {
    const hit = await this.find(id)
    if (!hit) throw new VfxError(`no VFX entry "${id}"`)
    const e: VfxEntry = { ...hit.entry, updatedAt: this.now() }
    if (rating) e.rating = rating
    else delete e.rating
    if (e.kind === 'generated') e.quality = rating === 'up' ? 'good' : rating === 'down' ? 'avoid' : undefined
    if (!e.quality) delete e.quality
    const saved = await hit.store.save(e)
    if (rating === 'up' && this.deps.memory && saved.effect?.script) await this.saveSequenceSkill(saved).catch((err) => this.deps.log?.(`vfx: sequence skill: ${(err as Error).message}`, 'stderr'))
    if (rating === 'down' && this.deps.memory) await this.saveAvoidNotes(saved).catch((err) => this.deps.log?.(`vfx: avoid note: ${(err as Error).message}`, 'stderr'))
    // Liked or disliked results change the recipes for their tags.
    if (rating && this.deps.memory && saved.effect) await this.relearn(saved.tags).catch(() => undefined)
    this.changed()
    return saved
  }

  // A liked scripted effect becomes a skill: the request, its beats and the script, so the assistant
  // can reuse the choreography for similar requests.
  private async saveSequenceSkill(e: VfxEntry): Promise<void> {
    const fx = e.effect!
    const stages = (fx.stages ?? []).map((s) => `${s.label} @ ${s.at.toFixed(2)} s`).join(', ')
    const critic = e.iterations?.[e.iterations.length - 1]?.critique
    const body = [
      `A multi-stage VFX the user liked in the VFX Lab: "${e.origin}" (${fx.duration.toFixed(2)} s; tags ${e.tags.join(', ')}).`,
      stages ? `Beats: ${stages}.` : '',
      critic ? `Critic (${critic.overall}/10): ${critic.summary.slice(0, 300)}` : '',
      'To make something similar: vfx_compose with this script as the starting point, or vfx_set_script on a new entry, then vfx_refine.',
      '```lua',
      fx.script!.slice(0, 6000),
      '```'
    ].filter(Boolean).join('\n')
    await this.deps.memory!.remember({ scope: 'user', kind: 'skill', name: `vfx-sequence-${e.name}`.slice(0, 60), description: `Liked multi-stage VFX timeline: ${e.description}`.slice(0, 200), body: body.slice(0, 7900) }, 'user')
  }

  private async saveAvoidNotes(e: VfxEntry): Promise<void> {
    const all = (await this.list()).filter((x) => x.quality === 'avoid')
    for (const tag of e.tags.slice(0, 3)) {
      const bad = all.filter((x) => x.tags.includes(tag))
      if (!bad.length) continue
      const body = [
        `VFX results the user disliked for "${tag}" (thumbs down in the VFX Lab). Do not repeat these choices:`,
        ...bad.slice(0, 10).map((x) => {
          const last = x.iterations?.[x.iterations.length - 1]?.critique
          return `- ${x.name}: ${x.description.slice(0, 160)}${last ? ` (critic: ${last.summary.slice(0, 160)})` : ''}`
        })
      ].join('\n')
      await this.deps.memory!.remember({ scope: 'user', kind: 'memory', type: 'feedback', name: `vfx-avoid-${tag}`, description: `Disliked ${tag} VFX results: what to avoid when making ${tag} effects`, body: body.slice(0, 2900) }, 'user')
    }
  }

  private async relearn(tags: string[]): Promise<void> {
    const entries = await this.list()
    const recipes = await this.recipes()
    for (const t of tags) {
      const r = extractRecipe(t, entries)
      if (!r) continue
      const i = recipes.findIndex((x) => x.tag === t)
      if (i >= 0) recipes[i] = r
      else recipes.push(r)
      await this.deps.memory!.remember({ scope: 'user', kind: 'skill', ...recipeSkill(r) }, 'agent')
    }
    await mkdir(this.deps.userDir, { recursive: true })
    await writeFile(this.recipesFile(), JSON.stringify(recipes, null, 1), 'utf8')
  }

  // ------------------------------------------------------------ create

  async references(tags: string[], text: string, exclude?: string): Promise<VfxEntry[]> {
    const hits = await this.search([...tags, text].join(' '), { limit: 8 })
    return hits.filter((e) => e.id !== exclude && e.effect).slice(0, 3)
  }

  // Creates (or replaces, with `id`) a generated entry from a spec and writes it into the project.
  async create(spec: VfxSpec, opts: { id?: string; prompt?: string } = {}): Promise<{ entry: VfxEntry; warnings: PerfWarning[] }> {
    return this.saveEffect(effectFromSpec(spec), { ...opts, description: spec.description, tags: spec.tags })
  }

  // Saves an effect as a generated entry (new, or replacing `id`) and writes it into the project.
  async saveEffect(raw: VfxEffect, opts: { id?: string; prompt?: string; description?: string; tags?: string[] } = {}): Promise<{ entry: VfxEntry; warnings: PerfWarning[] }> {
    const spec = { name: raw.name, description: opts.description, tags: opts.tags }
    const prev = opts.id ? await this.find(opts.id) : null
    if (opts.id && !prev) throw new VfxError(`no VFX entry "${opts.id}"`)
    const store = prev?.store ?? this.project() ?? this.user
    const effect = await this.prepareTextures(raw, store.scope)
    const now = this.now()
    const tags = [...new Set([...(spec.tags ?? []).map((t) => String(t).toLowerCase()), ...autoTags(effect, opts.prompt ?? '')])].slice(0, 10)
    const entry: VfxEntry = {
      ...(prev?.entry ?? { createdAt: now, thumbs: [], iterations: [] }),
      id: prev?.entry.id ?? entryId(effect.name),
      scope: store.scope,
      kind: 'generated',
      name: effect.name,
      description: spec.description?.slice(0, 600) || (prev && effect.script ? prev.entry.description : '') || describeEffect(effect),
      tags,
      updatedAt: now,
      origin: opts.prompt ?? prev?.entry.origin ?? effect.name,
      effect,
      stats: effectStats(effect)
    } as VfxEntry
    let saved = await store.save(entry)
    if (this.deps.projectRoot()) saved = await this.writeProjectFiles(saved)
    this.changed()
    return { entry: saved, warnings: perfWarnings(effect) }
  }

  // src/shared/VFX/<Name>/init.luau + Effect.rbxmx (Rojo: a ModuleScript with the model as child).
  async writeProjectFiles(entry: VfxEntry): Promise<VfxEntry> {
    const root = this.deps.projectRoot()
    if (!root || !entry.effect) return entry
    const hit = await this.find(entry.id)
    const store = hit?.store ?? this.user
    let dir = entry.written ? entry.written.module.replace(/\/init\.luau$/, '') : `${VFX_SRC_DIR}/${entry.effect.name}`
    if (!entry.written) {
      // Do not overwrite an effect folder another entry (or a person) owns.
      for (let i = 2; await exists(join(root, dir)); i++) dir = `${VFX_SRC_DIR}/${entry.effect.name}${i}`
    }
    const abs = resolve(root, dir)
    if (!abs.startsWith(resolve(root) + sep)) throw new VfxError('effect path escapes the project')
    await mkdir(abs, { recursive: true })
    // Custom textures: forgetex:// -> rbxassetid:// (uploaded) or a built-in fallback (not yet).
    const fx = await this.exportTextures(entry.effect)
    await writeFile(join(abs, 'init.luau'), luauModule(fx, { description: entry.description }), 'utf8')
    await writeFile(join(abs, 'Effect.rbxmx'), writeRbxmx(fx.roots), 'utf8')
    const timelineFile = join(abs, 'Timeline.luau')
    if (fx.script) await writeFile(timelineFile, timelineModule(fx.script), 'utf8')
    else if (await exists(timelineFile)) await writeFile(timelineFile, '-- No timeline script (the effect plays its compiled cues).\nreturn nil\n', 'utf8')
    if (needsRuntime(fx)) await this.writeRuntime(root)
    const written = { module: `${dir}/init.luau`, model: `${dir}/Effect.rbxmx` }
    if (entry.written?.module === written.module) return entry
    return store.save({ ...entry, written })
  }

  private async prepareTextures(effect: VfxEffect, scope?: VfxScope): Promise<VfxEffect> {
    if (!this.deps.textures) return effect
    return this.deps.textures.prepareEffect(effect, scope).catch((e) => {
      this.deps.log?.(`vfx: textures: ${(e as Error).message}`, 'stderr')
      return effect
    })
  }

  // The effect with custom texture references swapped for what Roblox can load.
  async exportTextures(effect: VfxEffect): Promise<VfxEffect> {
    if (!this.deps.textures) return effect
    const plan = await this.deps.textures.exportEffect(effect)
    for (const f of plan.fallbacks) this.deps.log?.(`vfx: ${f.ref} ${f.reason}; wrote ${f.to} instead (upload it in the VFX Lab textures tab)`, 'info')
    return plan.effect
  }

  // src/shared/VFX/ForgeFX.luau, the runtime scripted effects require. Rewritten when it is ours (starts
  // with the runtime header), left alone when someone replaced it with their own.
  private async writeRuntime(root: string): Promise<void> {
    const file = join(root, ...VFX_SRC_DIR.split('/'), `${RUNTIME_MODULE}.luau`)
    const cur = await readFile(file, 'utf8').catch(() => null)
    if (cur !== null && !isOwnRuntime(cur)) return
    if (cur === FORGEFX_SOURCE) return
    await mkdir(join(root, ...VFX_SRC_DIR.split('/')), { recursive: true })
    await writeFile(file, FORGEFX_SOURCE, 'utf8')
  }

  // ------------------------------------------------------------ render

  canRender(): boolean {
    return !!this.deps.capture
  }

  async renderEffect(effect: VfxEffect, n = 4, background: 'dark' | 'grey' = 'dark'): Promise<{ times: number[]; frames: Buffer[] }> {
    if (!this.deps.capture) throw new VfxError('Rendering needs the desktop app (offscreen WebGL capture).')
    const count = Math.max(1, Math.min(12, Math.floor(n)))
    // Sequences: one frame inside each stage so every beat gets rendered (and critiqued).
    const staged = effect.stages?.length ? stageFrameTimes(effect, Math.max(count, Math.min(8, effect.stages.length))) : []
    const times = staged.length ? staged : frameTimes(effect.duration, count)
    const frames = await this.deps.capture({ effect, times, ...FRAME_SIZE, background })
    return { times, frames }
  }

  // Renders an entry and stores the frames; returns their file names inside the entry.
  async render(id: string, n = 4, prefix = 'render'): Promise<{ entry: VfxEntry; files: string[]; abs: string[]; times: number[] }> {
    const hit = await this.find(id)
    if (!hit) throw new VfxError(`no VFX entry "${id}"`)
    if (!hit.entry.effect) throw new VfxError(`"${hit.entry.name}" is a media reference; there is nothing to render`)
    const { times, frames } = await this.renderEffect(hit.entry.effect, n)
    const files: string[] = []
    const abs: string[] = []
    for (const [i, png] of frames.entries()) {
      const f = `frames/${prefix}-${i + 1}.png`
      abs.push(await hit.store.writeFile(id, f, png))
      files.push(f)
    }
    const thumb = files[Math.min(files.length - 1, Math.floor(files.length / 3))]
    const entry = await hit.store.save({ ...hit.entry, thumbs: [thumb, ...hit.entry.thumbs.filter((t) => t !== thumb && !t.startsWith('frames/'))].slice(0, 6), updatedAt: this.now() })
    this.changed()
    return { entry, files, abs, times }
  }

  // ------------------------------------------------------------ critique + refine

  private async referenceImages(refs: VfxEntry[], tags: string[]): Promise<ImagePayload[]> {
    const out: ImagePayload[] = []
    const media = (await this.list()).filter((e) => e.kind === 'media' && e.media?.some((m) => m.mime === 'image/png' || m.mime === 'image/jpeg' || m.mime === 'image/webp') && e.tags.some((t) => tags.includes(t)))
    for (const e of [...refs, ...media]) {
      if (out.length >= 2) break
      const files = e.kind === 'media' ? (e.media ?? []).filter((m) => m.mime !== 'image/gif' && m.mime.startsWith('image/')).map((m) => m.file) : e.thumbs.filter((t) => t.endsWith('.png'))
      const f = files[0]
      if (!f) continue
      const hit = await this.find(e.id)
      const bytes = await hit?.store.readFile(e.id, f).catch(() => null)
      if (bytes && bytes.length < 4 * 1024 * 1024) out.push({ mime: MEDIA_MIME[extname(f).toLowerCase()] ?? 'image/png', base64: bytes.toString('base64') })
    }
    return out
  }

  async critique(entry: VfxEntry, effect: VfxEffect, frames: Buffer[], times: number[], iteration: number, previous: VfxCritique | null): Promise<VfxCritique> {
    const tags = entry.tags
    const refs = await this.references(tags, entry.origin, entry.id)
    const recipe = await this.recipeFor(tags)
    const refNames = refs.map((r) => r.name)
    const vision = this.deps.vision?.('critic')
    if (!vision) return heuristicCritique(effect, recipe, refNames)
    const prompt = critiquePrompt({ prompt: entry.origin, effect, frameTimes: times, references: refs.map((r) => ({ name: r.name, description: r.description, effect: r.effect })), recipe, iteration, previous })
    const images: ImagePayload[] = [...frames.map((f) => ({ mime: 'image/png', base64: f.toString('base64') })), ...(await this.referenceImages(refs, tags))]
    try {
      const raw = await vision(CRITIC_SYSTEM, prompt + studioFramesNote(frames) + (images.length > frames.length ? `\nThe last ${images.length - frames.length} image(s) are reference effects from the library.` : ''), images)
      return parseCritique(raw, effect, refNames)
    } catch (e) {
      this.deps.log?.(`vfx: vision critique unavailable (${(e as Error).message}); using the numbers-only check`, 'stderr')
      return heuristicCritique(effect, recipe, refNames)
    }
  }

  cancel(id: string): void {
    const r = this.running.get(id)
    if (r) r.cancelled = true
  }

  isRefining(id: string): boolean {
    return this.running.has(id)
  }

  private progress(p: VfxRefineProgress): void {
    this.deps.emit?.('vfx:progress', p)
  }

  // Render -> critique -> adjust, up to maxIterations or until the score reaches the threshold.
  async refine(id: string, opts: VfxRefineOptions = {}): Promise<RefineResult & { entry: VfxEntry }> {
    const hit = await this.find(id)
    if (!hit) throw new VfxError(`no VFX entry "${id}"`)
    if (!hit.entry.effect) throw new VfxError('nothing to refine (media reference)')
    if (this.running.has(id)) throw new VfxError('already refining this effect')
    const token = { cancelled: false }
    this.running.set(id, token)
    const stages = hit.entry.effect.stages?.length ?? 0
    const nFrames = Math.max(2, Math.min(8, opts.frames ?? (stages ? Math.min(6, stages) : 4)))
    const base = hit.entry.iterations?.length ?? 0
    const timesByIt = new Map<number, number[]>()
    const pngs = new Map<number, Buffer[]>()
    try {
      const result = await refineLoop(
        hit.entry.effect,
        {
          render: async (effect, n) => {
            this.progress({ entryId: id, iteration: base + n, phase: 'render' })
            const { times, frames } = await this.renderEffect(effect, nFrames)
            timesByIt.set(n, times)
            pngs.set(n, frames)
            const files: string[] = []
            for (const [i, png] of frames.entries()) {
              const f = `frames/iter-${base + n}-${i + 1}.png`
              await hit.store.writeFile(id, f, png)
              files.push(f)
            }
            return files
          },
          critique: async (effect, _files, n, previous) => {
            this.progress({ entryId: id, iteration: base + n, phase: 'critique' })
            const current = (await hit.store.read(id)) ?? hit.entry
            return this.critique(current, effect, pngs.get(n) ?? [], timesByIt.get(n) ?? [], base + n, previous)
          },
          onIteration: async (it) => {
            const current = (await hit.store.read(id)) ?? hit.entry
            const iteration: VfxIteration = { n: base + it.n, at: this.now(), effect: it.effect, frames: it.frames, critique: it.critique }
            await hit.store.save({ ...current, iterations: [...(current.iterations ?? []), iteration].slice(-20), updatedAt: this.now() })
            this.progress({ entryId: id, iteration: base + it.n, phase: 'adjust', score: it.critique.overall, message: it.critique.summary })
            this.changed()
          },
          cancelled: () => token.cancelled
        },
        { maxIterations: opts.maxIterations ?? DEFAULT_MAX_ITERATIONS, threshold: opts.threshold ?? DEFAULT_THRESHOLD }
      )
      // Keep the best iteration as the effect.
      const current = (await hit.store.read(id)) ?? hit.entry
      const bestFrames = result.best.frames
      const bestEffect = await this.prepareTextures(result.best.effect, hit.store.scope)
      let entry = await hit.store.save({
        ...current,
        effect: bestEffect,
        stats: effectStats(bestEffect),
        thumbs: [bestFrames[Math.min(bestFrames.length - 1, 1)] ?? bestFrames[0], ...current.thumbs.filter((t) => !t.startsWith('frames/'))].filter(Boolean).slice(0, 6),
        updatedAt: this.now()
      })
      if (entry.written || this.deps.projectRoot()) entry = await this.writeProjectFiles(entry)
      this.progress({ entryId: id, iteration: base + result.iterations.length, phase: 'done', score: result.best.critique.overall, message: `stopped: ${result.stop}` })
      this.changed()
      return { ...result, entry }
    } catch (e) {
      this.progress({ entryId: id, iteration: base, phase: 'error', message: (e as Error).message })
      throw e
    } finally {
      this.running.delete(id)
    }
  }

  // First spec for a prompt: the default model when available (recipe + references in the prompt),
  // else the deterministic draft (shared/vfx/draft.ts).
  async draft(prompt: string): Promise<{ spec: VfxSpec; source: 'model' | 'draft' }> {
    const tags = promptTags(prompt)
    const recipe = await this.recipeFor(tags.length ? tags : prompt.toLowerCase().split(/\W+/))
    const entries = await this.list()
    const fallback = draftSpec(prompt, { recipe, textures: libraryTextures(entries) })
    const vision = this.deps.vision?.('default')
    if (!vision) return { spec: fallback, source: 'draft' }
    const refs = await this.references(tags, prompt)
    const lines = [
      `Make: ${prompt}`,
      recipe ? `Learned recipe "${recipe.tag}": ${JSON.stringify({ layers: recipe.layers, ranges: recipe.ranges, notes: recipe.notes, avoid: recipe.avoid }).slice(0, 4000)}` : 'No learned recipe for this type yet.',
      ...refs.map((r) => `Reference "${r.name}": ${JSON.stringify(compactEffect(r.effect!)).slice(0, 2500)}`),
      `Library textures by role (use these ids; never invent asset ids): ${JSON.stringify(libraryTextures(entries))}`,
      ...(await this.textureLines()),
      `A starting draft you may improve: ${JSON.stringify(fallback)}`
    ]
    try {
      const raw = await vision(DRAFT_SYSTEM, lines.join('\n\n'), [])
      const m = /\{[\s\S]*\}/.exec(raw.replace(/```(?:json)?/g, ''))
      if (!m) throw new Error('no JSON in the answer')
      const spec = JSON.parse(m[0]) as VfxSpec
      effectFromSpec(spec)
      return { spec, source: 'model' }
    } catch (e) {
      this.deps.log?.(`vfx: model draft unusable (${(e as Error).message}); using the built-in draft`, 'stderr')
      return { spec: fallback, source: 'draft' }
    }
  }

  // "Make a ___ effect": draft, create, then refine in the background. Returns the new entry.
  async make(prompt: string, opts: VfxRefineOptions & { wait?: boolean } = {}): Promise<{ entry: VfxEntry; refined?: Promise<unknown> }> {
    const text = String(prompt ?? '').trim()
    if (text.length < 3) throw new VfxError('Describe the effect, e.g. "a fire slash with embers".')
    const { spec } = await this.draft(text)
    const { entry } = await this.create(spec, { prompt: text })
    if (!this.deps.capture) return { entry }
    const refined = this.refine(entry.id, opts).catch((e) => this.deps.log?.(`vfx: refine failed: ${(e as Error).message}`, 'stderr'))
    if (opts.wait) await refined
    return { entry, refined }
  }

  // ------------------------------------------------------------ scripted sequences

  private async lunePaths(): Promise<{ lune: string; runtimeDir: string }> {
    const lune = await this.deps.lune().catch((e) => ({ error: (e as Error).message }))
    if ('error' in lune) throw new VfxError(`Timeline scripts run in Lune, which is not available: ${lune.error}`)
    const runtimeDir = this.deps.runtimeDir()
    if (!runtimeDir) throw new VfxError('The Lune runtime scripts are missing from this install (resources/lune).')
    return { lune: lune.path, runtimeDir }
  }

  // Records a timeline script with Lune and compiles it onto `base` (kit rigs replaced, the rest kept).
  async recordScript(script: string, base: VfxEffect): Promise<VfxScriptResult> {
    const text = String(script ?? '')
    if (!text.trim()) return { ok: false, error: { message: 'the script is empty' }, prints: [], warnings: [], summary: '' }
    if (text.length > 60_000) return { ok: false, error: { message: 'the script is too long (60 KB max)' }, prints: [], warnings: [], summary: '' }
    const paths = await this.lunePaths()
    const rec = await luneTimeline(text, { ...paths, run: this.deps.luneRun })
    const run = finishRun(base, text, rec)
    return { ok: run.ok, ...(run.error ? { error: run.error } : {}), prints: run.prints, warnings: run.warnings, summary: run.effect ? timelineSummary(run.effect) : '', ...(run.effect ? { effect: run.effect } : {}) }
  }

  // Runs a timeline script against an entry (or a blank effect). save: store the result on the entry
  // (or as a new entry when there is no id) and write it into the project.
  async runScript(script: string, opts: { id?: string; save?: boolean; prompt?: string } = {}): Promise<VfxScriptResult> {
    const hit = opts.id ? await this.find(opts.id) : null
    if (opts.id && !hit) throw new VfxError(`no VFX entry "${opts.id}"`)
    if (hit && !hit.entry.effect) throw new VfxError(`"${hit.entry.name}" is a media reference; it has no effect to script`)
    const base = hit?.entry.effect ?? EMPTY_BASE(scriptName(script, opts.prompt ?? 'Sequence'))
    const r = await this.recordScript(script, base)
    if (!r.ok || !opts.save || !r.effect) return r
    if (hit && this.running.has(hit.entry.id)) throw new VfxError('this effect is being refined; cancel the refinement first')
    const { entry } = await this.saveEffect(r.effect, { id: hit?.entry.id, prompt: hit ? undefined : opts.prompt ?? r.effect.name })
    return { ...r, entry }
  }

  // One step from a request to a scripted multi-stage effect: the model writes the timeline script
  // with the kit (one repair round on errors), else the built-in draft for the request's archetype.
  // Saved as a new entry; refined in the background when frames can be rendered (refine: false skips).
  async compose(request: string, opts: VfxRefineOptions & { wait?: boolean; refine?: boolean; script?: string } = {}): Promise<VfxScriptResult & { refined?: Promise<unknown> }> {
    const text = String(request ?? '').trim()
    if (text.length < 3) throw new VfxError('Describe the effect, e.g. "a fireball that charges, flies forward and explodes".')
    let source: VfxScriptResult['source'] = 'draft'
    let result: VfxScriptResult | null = null
    let script = opts.script?.trim() ? opts.script : ''
    const vision = this.deps.vision?.('default')
    if (!script && vision) {
      const tags = promptTags(text)
      const liked = (await this.list()).filter((e) => e.rating === 'up' && e.effect?.script && e.tags.some((t) => tags.includes(t))).slice(0, 1)
      const avoid = (await this.list()).filter((e) => e.quality === 'avoid' && e.effect?.script && e.tags.some((t) => tags.includes(t))).slice(0, 3)
      const lines = [
        `Make: ${text}`,
        ...liked.map((e) => `The user liked this related sequence ("${e.origin}"); reuse what fits:\n\`\`\`lua\n${e.effect!.script!.slice(0, 4000)}\n\`\`\``),
        ...(avoid.length ? [`The user disliked: ${avoid.map((e) => `${e.name} (${e.description.slice(0, 120)})`).join(' | ')}`] : []),
        ...(await this.textureLines())
      ]
      try {
        let raw = await vision(COMPOSE_SYSTEM, lines.join('\n\n'), [])
        for (let attempt = 0; attempt < 2; attempt++) {
          const s = extractScript(raw)
          if (!s) throw new Error('no script in the answer')
          const r = await this.recordScript(s, EMPTY_BASE(scriptName(s, text)))
          if (r.ok) {
            script = s
            result = r
            source = 'model'
            break
          }
          if (attempt === 1) throw new Error(r.error?.message ?? 'the script failed')
          const where = r.error?.line ? ` (line ${r.error.line}: ${s.split('\n')[r.error.line - 1]?.trim() ?? ''})` : ''
          raw = await vision(COMPOSE_SYSTEM, `${lines.join('\n\n')}\n\nYour script:\n\`\`\`lua\n${s}\`\`\`\nfailed: ${r.error?.message}${where}\nFix it and answer with the whole corrected script.`, [])
        }
      } catch (e) {
        this.deps.log?.(`vfx: composed script unusable (${(e as Error).message}); using the built-in draft`, 'stderr')
      }
    }
    if (!result) {
      if (!script) script = draftScript(text)
      else source = 'model'
      result = await this.recordScript(script, EMPTY_BASE(scriptName(script, text)))
      if (!result.ok && opts.script) return { ...result, source }
      if (!result.ok) {
        // The built-in draft always records; this only happens when Lune itself fails.
        throw new VfxError(`could not record the draft timeline: ${result.error?.message}`)
      }
    }
    const tags = [...new Set([...promptTags(text), 'sequence'])]
    const { entry } = await this.saveEffect(result.effect!, { prompt: text, tags, description: `${text.slice(0, 300)} (${(result.effect!.stages ?? []).map((s) => s.label).join(' > ')})` })
    await this.ensureChoreographySkill()
    const out: VfxScriptResult & { refined?: Promise<unknown> } = { ...result, entry, source }
    if (opts.refine !== false && this.deps.capture) {
      const refined = this.refine(entry.id, opts).catch((e) => this.deps.log?.(`vfx: refine failed: ${(e as Error).message}`, 'stderr'))
      if (opts.wait) await refined
      out.refined = refined
    }
    return out
  }

  // The choreography guide as a memory skill, so the assistant finds it from any chat (once per run).
  private choreoSaved = false
  private async ensureChoreographySkill(): Promise<void> {
    if (this.choreoSaved || !this.deps.memory) return
    this.choreoSaved = true
    const body = `${CHOREOGRAPHY_GUIDE}\n\n## Timeline API\n${TIMELINE_API}\n\nCall vfx_kit for the kit reference, vfx_compose to draft an effect and its script in one step, vfx_run_script to iterate on a script (errors come back with line numbers), vfx_refine to render and critique the stages.`
    await this.deps.memory.remember({ scope: 'user', kind: 'skill', name: 'vfx-choreography', description: 'How to choreograph multi-stage Roblox VFX (anticipation, charge, release, impact, dissipate) with timeline scripts and the kit', body: body.slice(0, 7900) }, 'agent').catch((e) => {
      this.choreoSaved = false
      this.deps.log?.(`vfx: choreography skill: ${(e as Error).message}`, 'stderr')
    })
  }

  // Built-in scripted examples (Hollow Purple, charge-and-slash, ground slam).
  examples(): { key: string; name: string; description: string; tags: string[] }[] {
    return VFX_EXAMPLES.map(({ key, name, description, tags }) => ({ key, name, description, tags }))
  }

  // Adds a built-in example to the library (from its recorded timeline; no Lune needed). Reuses the
  // entry when it was added before.
  async addExample(key: string): Promise<VfxEntry> {
    const ex = findExample(key)
    if (!ex) throw new VfxError(`no built-in example "${key}" (examples: ${VFX_EXAMPLES.map((e) => e.key).join(', ')})`)
    const origin = `example:${ex.key}`
    const prev = (await this.list()).find((e) => e.origin === origin && e.kind === 'generated')
    if (prev) return prev
    const { effect } = compileTimeline(EMPTY_BASE(ex.name), RECORDED[ex.key] ?? [], ex.script)
    const { entry } = await this.saveEffect(effect, { prompt: origin, description: ex.description, tags: [...ex.tags, 'sequence', 'example'] })
    return entry
  }

  // ------------------------------------------------------------ textures

  private async textureLines(): Promise<string[]> {
    const list = (await this.deps.textures?.promptList(10).catch(() => [])) ?? []
    return list.length ? [`Custom textures in the user's library (forgetex:// refs; liked ones first):\n${list.join('\n')}`] : []
  }

  // rbxassetid:// -> PNG data URL via the public thumbnails API (no auth); a local file path (Art
  // page images, project-relative or absolute) -> its bytes. null = use a placeholder.
  resolveTexture(ref: string): Promise<string | null> {
    const key = String(ref ?? '').trim()
    if (!key) return Promise.resolve(null)
    // Custom textures: always read fresh (the library file can change); gen refs cache themselves.
    if (isTexRef(key)) return this.deps.textures ? this.deps.textures.resolve(key).catch(() => null) : Promise.resolve(null)
    let p = this.textureCache.get(key)
    if (!p) {
      p = this.loadTexture(key).catch(() => null)
      this.textureCache.set(key, p)
      void p.then((v) => {
        if (v === null) setTimeout(() => this.textureCache.delete(key), 60_000).unref?.()
      })
    }
    return p
  }

  private async loadTexture(ref: string): Promise<string | null> {
    const id = /^(?:rbxassetid:\/\/|https?:\/\/www\.roblox\.com\/asset\/?\?id=)(\d+)$/i.exec(ref)?.[1] ?? (/^\d+$/.test(ref) ? ref : null)
    if (id) {
      const cacheFile = join(this.deps.userDir, 'textures', `${id}.png`)
      const cached = await readFile(cacheFile).catch(() => null)
      if (cached) return `data:image/png;base64,${cached.toString('base64')}`
      const f = this.deps.fetch ?? fetch
      // GET thumbnails.roblox.com/v1/assets (Roblox legacy Thumbnails API, auth: none).
      const meta = await f(`https://thumbnails.roblox.com/v1/assets?assetIds=${id}&returnPolicy=PlaceHolder&size=420x420&format=Png&isCircular=false`)
      if (!meta.ok) return null
      const json = (await meta.json()) as { data?: { state?: string; imageUrl?: string }[] }
      const url = json.data?.[0]?.state === 'Completed' ? json.data[0].imageUrl : null
      if (!url || !/^https:\/\/[\w.-]+\.rbxcdn\.com\//.test(url)) return null
      const img = await f(url)
      if (!img.ok) return null
      const bytes = Buffer.from(await img.arrayBuffer())
      if (bytes.length > 8 * 1024 * 1024 || bytes[0] !== 0x89) return null
      await mkdir(join(this.deps.userDir, 'textures'), { recursive: true })
      await writeFile(cacheFile, bytes)
      return `data:image/png;base64,${bytes.toString('base64')}`
    }
    if (/^rbxasset:\/\//i.test(ref) || /^https?:/i.test(ref)) return null
    // Local image file (e.g. art/concepts/... from the Art page).
    const root = this.deps.projectRoot()
    const path = isAbsolute(ref) ? ref : root ? resolve(root, ref) : null
    if (!path) return null
    const ext = extname(path).toLowerCase()
    const mime = MEDIA_MIME[ext]
    if (!mime || !mime.startsWith('image/')) return null
    const s = await stat(path).catch(() => null)
    if (!s?.isFile() || s.size > 8 * 1024 * 1024) return null
    return `data:${mime};base64,${(await readFile(path)).toString('base64')}`
  }

  // ------------------------------------------------------------ Studio

  // Writes the effect into the project (Rojo syncs src/shared into ReplicatedStorage.Shared), makes
  // sure Rojo is serving, and returns the command-bar line that plays it in front of the camera.
  async testInStudio(id: string): Promise<{ module: string; rojo: 'running' | 'started' | 'unavailable'; command: string; instancePath: string }> {
    if (!this.deps.projectRoot()) throw new VfxError('Open the game project first: Test in Studio writes the effect into src/shared/VFX and Rojo syncs it.')
    let entry = await this.get(id)
    if (!entry.effect) throw new VfxError('media references cannot be sent to Studio')
    if (entry.kind !== 'generated' || !entry.written) {
      // Imported references are copied in as generated effects so Studio gets a module too.
      const hit = await this.find(id)
      entry = await this.writeProjectFiles({ ...entry, kind: entry.kind === 'media' ? 'model' : entry.kind })
      if (hit) entry = (await hit.store.read(id)) ?? entry
    }
    let rojo: 'running' | 'started' | 'unavailable' = 'unavailable'
    if (this.deps.rojo) {
      if (this.deps.rojo.running()) rojo = 'running'
      else {
        await this.deps.rojo.start().then(
          () => (rojo = 'started'),
          () => undefined
        )
      }
    }
    const folder = entry.written!.module.replace(/\/init\.luau$/, '').split('/').pop()!
    const instancePath = `game.ReplicatedStorage.Shared.VFX.${folder}`
    const command = `require(${instancePath}).play(workspace.CurrentCamera.CFrame * CFrame.new(0, -2, -14))`
    return { module: entry.written!.module, rojo, command, instancePath }
  }

  dispose(): void {
    for (const t of this.running.values()) t.cancelled = true
  }
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false
  )
}

// One effect per file, or one per child when the file is a pack (a Folder / Model of several
// effects, or several top-level effects).
export function splitEffects(roots: import('../../../shared/vfx/types.ts').VfxNode[]): { name: string; nodes: import('../../../shared/vfx/types.ts').VfxNode[] }[] {
  const hasVfx = (n: import('../../../shared/vfx/types.ts').VfxNode) => allNodes([n]).some((x) => ['ParticleEmitter', 'Beam', 'Trail', 'PointLight', 'SpotLight', 'SurfaceLight', 'Highlight'].includes(x.className))
  const withVfx = roots.filter(hasVfx)
  if (withVfx.length > 1) return withVfx.map((n) => ({ name: n.name, nodes: [n] }))
  if (withVfx.length === 1) {
    const only = withVfx[0]
    const kids = only.children.filter(hasVfx)
    if ((only.className === 'Folder' || only.className === 'Model') && kids.length > 1 && kids.every((k) => k.className === 'Model' || k.className === 'Folder')) {
      return kids.map((k) => ({ name: k.name, nodes: [k] }))
    }
    return [{ name: only.name, nodes: [only] }]
  }
  return []
}

export { relative, VfxLibraryError, SpecError, RECIPE_PREFIX }
