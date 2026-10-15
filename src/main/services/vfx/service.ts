// VFX Lab service: the reference library (import, tags, search), learning (recipes saved as memory
// skills), effect creation (spec -> .rbxmx + Luau module in the project), offscreen rendering, and
// the render / critique / refine loop with ratings feeding back into memory.
//
// Nothing here is model fine-tuning: the library is the training data, retrieval picks the closest
// references and recipes, and a vision model critiques rendered frames against them.
// No electron imports: rendering (capture), the vision model and Rojo come in as functions.

import type { LabTier } from '../../../shared/labModels.ts'
import type { LabGate } from '../../../shared/gating/hooks.ts'
import { rephraseNote, skippedCritique } from '../../../shared/gating/gates.ts'
import { ComposeGaveUp, composeWithGate, type AttemptResult } from '../../../shared/gating/compose.ts'
import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { allNodes, describeEffect, effectFromNodes, effectStats, emitAttributes, importNotes, IMPORT_VERSION, perfWarnings, type PerfWarning } from '../../../shared/vfx/analyze.ts'
import { findVfxPacks, splitEffects, type EffectGroup } from '../../../shared/vfx/split.ts'
import { autoTagGroups, baseName, changedGroups, flatTags, groupsFromTags, isGenericName, nameFromTags, normalizeGroups, retagGroups, tagGroupsOf, TAG_GROUP_ORDER, uniqueName, type NameSet, type TagGroup, type TagGroups } from '../../../shared/vfx/tags.ts'
import { effectHash } from '../../../shared/vfx/fingerprint.ts'
import { CRITIC_SYSTEM, critiquePrompt, DEFAULT_MAX_ITERATIONS, DEFAULT_THRESHOLD, heuristicCritique, parseCritique, refineLoop, stageFrameTimes, type RefineResult } from '../../../shared/vfx/critique.ts'
import { CHOREOGRAPHY_GUIDE, draftScript, kitReference, TIMELINE_API } from '../../../shared/vfx/choreo.ts'
import { compileTimeline, finishRun } from '../../../shared/vfx/compile.ts'
import { findExample, VFX_EXAMPLES, CHARGE_SLASH } from '../../../shared/vfx/examples.ts'
import { RECORDED } from '../../../shared/vfx/examples.recorded.ts'
import { FORGEFX_SOURCE, isOwnRuntime, RUNTIME_MODULE } from '../../../shared/vfx/runtime.ts'
import { timelineSummary } from '../../../shared/vfx/timeline.ts'
import { promptTags } from '../../../shared/vfx/draft.ts'
import { luauModule, needsRuntime, timelineModule } from '../../../shared/vfx/luau.ts'
import { readRbxmx, writeRbxmx } from '../../../shared/vfx/rbxmx.ts'
import { centreEffect } from '../../../shared/vfx/placement.ts'
import { extractRecipe, extractRecipes, RECIPE_PREFIX, recipeMatches, recipeSkill } from '../../../shared/vfx/recipes.ts'
import { applyChanges, compactEffect, effectFromSpec, safeName, shortTitle, SpecError, type VfxSpec } from '../../../shared/vfx/spec.ts'
import type { VfxNameFromTagsResult } from '../../../shared/vfxTypes.ts'
import type { VfxChange, VfxCritique, VfxEffect, VfxEntry, VfxImportResult, VfxIteration, VfxLabStatus, VfxPick, VfxRecipe, VfxRefineOptions, VfxRefineProgress, VfxScope, VfxScriptResult } from '../../../shared/vfx/types.ts'
import { alignBaseToStage, baseColors, baseLayerLines, composeBase, draftCandidate, enrichSpec, finishEffect, finishScriptRemix, ground, groundingLines, libraryScript, pickByCode, richnessNotes, scratchCandidate, scratchNote, scriptedBase, singleCandidates, tweakRecorded, tweakScript, type Candidate, type Grounding, type ScriptBase } from '../../../shared/vfx/ground.ts'
import { asksSimpler, guardLayerEdits, richness, richnessLine, richTargetOf, tooSimple } from '../../../shared/vfx/richness.ts'
import { emptyFeedback, feedbackBoost, nearestEffects, normalizeFeedback, recordFeedback, REMIX_MIN_SCORE, type VfxFeedback } from '../../../shared/vfx/retrieve.ts'
import { texRef } from '../../../shared/vfx/tex/textures.ts'
import { studioFramesNote } from '../../../shared/studio/frames.ts'
import { entryId, PROJECT_VFX_DIR, safeFileName, VfxLibraryError, VfxStore } from './library.ts'
import { PROCEDURAL_GUIDE, isTexRef, type ExportPlan } from '../../../shared/vfx/tex/textures.ts'
import { loadPinnedRef, type PinnedRef } from '../videoref/refs.ts'
import { blendMatch, parseMatch, REF_MATCH_TEXT } from '../../../shared/videoref/prompt.ts'
import { criticBrief, restatementBlock } from '../../../shared/restate/prompt.ts'
import { normalizeRestatement, type Restatement } from '../../../shared/restate/types.ts'
import { vfxNumericMatch } from '../../../shared/videoref/match.ts'
import { luneExtract, luneTimeline, type LuneRun } from './lune.ts'
import { principleIds, scoresForRating, vfxCriticPrinciples, withVfxPrinciples } from '../../../shared/principles/attach.ts'
import { principlePlan } from '../../../shared/principles/select.ts'
import { vfxPrincipleChecks } from '../../../shared/principles/vfxChecks.ts'
import type { PrincipleHooks, PrincipleWeights } from '../../../shared/principles/types.ts'

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
  // Whether a vision call could reach a model at all (a provider is set up). False: the critic is
  // not asked and no frames are rendered for it. Absent: assumed true when `vision` is set.
  visionReady?: () => Promise<boolean>
  memory?: MemoryLike
  rojo?: { running(): boolean; start(): Promise<void> }
  fetch?: typeof fetch
  emit?: (event: 'vfx:changed' | 'vfx:progress', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  now?: () => number
  // Custom textures (textures/service.ts): forgetex:// previews, gen-ref materialisation on save,
  // the rbxassetid swap when effects are written to the project, and the list for prompts.
  textures?: VfxTextureHooks
  // Principle priorities: the user's learned weights (critique, compose plan) and the rating log.
  principles?: PrincipleHooks
  // Lab gating (services/gating): skip the critic, early stop, retry routes. Optional.
  gate?: LabGate
  // Roblox Studio connected through the Forge Bridge (status for Import from Studio).
  studioConnected?: () => boolean
  // Setting "Name effects from tags" (NAME_FROM_TAGS_SETTING): imports are named from their tags
  // ("Lightning Impact") instead of their Studio / file name. Absent: off.
  nameFromTags?: { get(): boolean; set?(on: boolean): void }
  // Each refine iteration's effect as it is rendered (and again with its score): Live in Studio.
  onDraft?: (entryId: string, iteration: number, effect: VfxEffect, score?: number) => void
}

export interface VfxTextureHooks {
  resolve(ref: string): Promise<string | null>
  prepareEffect(effect: VfxEffect, scope?: VfxScope, opts?: { reuse?: boolean }): Promise<VfxEffect>
  exportEffect(effect: VfxEffect): Promise<ExportPlan>
  promptList(limit?: number): Promise<string[]>
  // Draft layer roles -> library textures under the texture policy (reuse first).
  roleTextures?(): Promise<Record<string, string>>
  // The texture library (Make counts its textures as reuse).
  list?(): Promise<{ id: string; rating?: 'up' | 'down'; roblox?: { uri?: string } }[]>
}

// Place files (.rbxl / .rbxlx): the VFX packs in Workspace / ReplicatedStorage / ServerStorage.
const PLACE_EXT = new Set(['.rbxl', '.rbxlx'])
const MODEL_EXT = new Set(['.rbxm', '.rbxmx', ...PLACE_EXT])
const MEDIA_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' }
const MAX_IMPORT_FILES = 400
const MAX_FILE_BYTES = 60 * 1024 * 1024
const MAX_PLACE_BYTES = 400 * 1024 * 1024
// Model files up to this size are kept with the entry (re-import); place files never are.
const KEEP_FILE_BYTES = 20 * 1024 * 1024
export const VFX_SRC_DIR = 'src/shared/VFX'
const FRAME_SIZE = { width: 512, height: 384 }

export class VfxError extends Error {}

// The setting key of "Name effects from tags" (default on).
export const NAME_FROM_TAGS_SETTING = 'vfx.nameFromTags'

// The effect's own name for an entry name: the original when it keeps it ("Particles (2)" as it
// was), else an identifier ("Lightning Impact (2)" -> "LightningImpact2"; the Luau module, the
// project folder and the Studio instance use it). Layers inside are never renamed.
export function effectNameFor(name: string, sourceName?: string): string {
  return sourceName !== undefined && name === sourceName ? sourceName : safeName(name)
}

// The tag-based name of an import, or null when its tags give none (or the same as its original
// name, "Slash (2)" with kind slash).
export function tagNameBase(groups: TagGroups, source: string): string | null {
  const base = nameFromTags(groups, '')
  return base && base.toLowerCase() !== baseName(source).toLowerCase() ? base : null
}

// Tag fields of an entry from its effect: auto groups (with evidence), merged with tags given by
// the caller (spec / compose), and with the groups the user edited on `prev` kept as they are.
// authoritative: groups where the given tags replace the auto ones when there are any (Make: "an ice
// slash" remixed from a fire slash is ice, whatever its colours still say to the auto-tagger).
export function tagFields(effect: VfxEffect, hint: string, given: string[] = [], prev?: Pick<VfxEntry, 'tags' | 'tagGroups' | 'userTagGroups'> | null, authoritative: TagGroup[] = []): Pick<VfxEntry, 'tags' | 'tagGroups' | 'autoTagInfo' | 'userTagGroups'> {
  const { groups: auto, auto: info } = autoTagGroups(effect, hint)
  const g = groupsFromTags(given)
  const pick = (k: 'kind' | 'element') => (authoritative.includes(k) && g[k].length ? g[k] : [...new Set([...g[k], ...auto[k]])])
  const merged: TagGroups = { kind: pick('kind'), element: pick('element'), timing: g.timing.length ? g.timing : auto.timing, custom: g.custom }
  const user = prev?.userTagGroups ?? []
  const final = prev && user.length ? retagGroups(tagGroupsOf(prev), merged, user) : merged
  return { tags: flatTags(final), tagGroups: final, autoTagInfo: info, ...(user.length ? { userTagGroups: user } : {}) }
}

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
  .replace('${TEXTURES}', `${PROCEDURAL_GUIDE} Reuse first: the request lists the user's texture library by kind and the texture policy. For each particle, beam and trail layer, pass texture = "forgetex://<id>" from that list when a library texture fits the layer's kind (imported and liked ones first). Only when none fits (and the policy allows it) ask for a procedural one by shape with texture = "forgetex://gen/<type>" (a ring that should be a ring, smoke that should be a puff, a crack, a slash crescent).`)
  .replace('${EXAMPLE}', CHARGE_SLASH)

const EMPTY_BASE = (name: string): VfxEffect => ({ name, roots: [], cues: [], duration: 2 })

// Make from the closest real effect: the model edits a copy instead of drafting from scratch.
export const REMIX_SYSTEM = `You adapt a real Roblox VFX from the user's own library to a new request for the RBX Forge VFX Lab. The starting effect is already recoloured and resized for the request; keep what makes it look like the user's work (its structure, textures, flipbooks, timing). Answer with JSON only, no prose:
{"name":"PascalCase","description":"one sentence","changes":[{"node":"<layer name from the parameters>","prop":"<Roblox property>","value":...,"why":"short"}]}
At most 10 changes, only what the request needs that the effect does not do yet (a colour accent, more or fewer sparks, a longer dissipate, a bigger ring, a slower flipbook...). Use only layer names (the "name" field) and properties that exist in the parameters; values in the same JSON shapes (sequences [[t, v], ...], colour sequences [[t, "#hex"], ...], ranges [min, max]); bursts with prop "emit" and [{"at": seconds, "count": n}]; the length of one play with node "$effect" prop "duration". Keep every layer: the user's effects are layered on purpose, so a layer that does not fit (lightning bolts in an ice slash) is recoloured, retextured with one of the user's textures or retimed, never hidden or emptied (only when the request asks for something simpler). Adding detail is welcome; removing it is not. Texture: only ids already in the effect or listed as the user's textures; never invent asset ids. An empty changes list is right when it already fits the request.`

// Picking between variations.
const PICK_SYSTEM = 'You are a senior Roblox VFX artist choosing between variations of one effect from preview frames (dark background, a grey R15 dummy for scale). Answer with JSON only.'

// Variation hints: one model call per variation (Make and compose).
export const VARIATION_HINTS = ['', 'Variation B: punchier and tighter: a faster peak, shorter lifetimes, a hotter core, sharper secondary layers (keep every layer).', 'Variation C: bigger and more showy: a larger silhouette, more secondary detail (sparks, debris, a ring), a longer dissipate.']

export function clampVariations(n: unknown): number {
  const v = Math.floor(Number(n))
  return Number.isFinite(v) ? Math.max(1, Math.min(VARIATION_HINTS.length, v)) : 1
}

// Tag groups the request names (they win over what the auto-tagger reads off a remixed copy).
function authoritative(g: Grounding): TagGroup[] {
  return (['kind', 'element'] as const).filter((k) => g.req.groups[k].length > 0)
}

// The first JSON object in a model answer (fenced or not).
function jsonObject(raw: string): Record<string, unknown> {
  const m = /\{[\s\S]*\}/.exec(raw.replace(/```(?:json)?/g, ''))
  if (!m) throw new Error('no JSON in the answer')
  const v = JSON.parse(m[0])
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('the answer is not a JSON object')
  return v as Record<string, unknown>
}

function asChanges(raw: unknown): VfxChange[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && typeof (c as { node?: unknown }).node === 'string' && typeof (c as { prop?: unknown }).prop === 'string' && (c as { value?: unknown }).value !== undefined)
    .slice(0, 12)
    .map((c) => ({ node: String(c.node), prop: String(c.prop), value: c.value, ...(c.why ? { why: String(c.why).slice(0, 200) } : {}) }))
}

// The script in a model answer: the first lua / luau fence, else the text from "return function".
export function extractScript(raw: string): string | null {
  const fence = /```(?:lua|luau)?\s*\n([\s\S]*?)```/i.exec(raw)
  const code = (fence ? fence[1] : raw.slice(Math.max(0, raw.indexOf('return function')))).trim()
  return /return\s+function\s*\(/.test(code) ? code + '\n' : null
}

// "-- Name: HollowPurple" on the first lines of a script, else a name from the request.
export function scriptName(script: string, request: string): string {
  const m = /^\s*--\s*Name:\s*([A-Za-z][\w ]{0,40})/m.exec(script.split('\n').slice(0, 3).join('\n'))
  return (m ? safeName(m[1]).slice(0, 40) : shortTitle(request, 'Sequence')) || 'Sequence'
}

// The note on an entry the model did not draft, with the actual error.
export function draftedWithout(error: string): string {
  return `Drafted without a model because: ${error.replace(/\s+/g, ' ').trim().slice(0, 500)}`
}

// Why Make drafted (or compose used only kit rigs) instead of copying one of the user's effects
// (shown with the entry).
export function noBaseNote(g: Grounding, what = 'drafted from the built-in archetype'): string {
  const m = g.matches[0]
  if (!m) return `${what}: nothing in your library is close to this request`
  const why = g.req.groups.kind.length && !m.kindMatch ? `is not tagged ${g.req.groups.kind.join(' / ')}` : `is not close enough (match ${m.score} of ${REMIX_MIN_SCORE})`
  return `${what}: your closest "${m.entry.name.slice(0, 40)}" ${why}; name it in the request or tag its kind to start from it`
}

// A numbers-only critique after the vision call failed: say so (with the error) instead of
// "no vision model", which reads as if none were set up.
export function visionFailed(c: VfxCritique, error: string): VfxCritique {
  const why = error.replace(/\s+/g, ' ').trim().slice(0, 300)
  return { ...c, summary: c.summary.replace(/^Numbers-only check \(no vision model/, `Numbers-only check (the vision model call failed: ${why}`) }
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

  notifyChanged(): void {
    this.changed()
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
      studio: this.deps.studioConnected?.() ?? false,
      rojo: this.deps.rojo?.running() ?? false,
      entries: { user: (await this.user.list()).length, project: p ? (await p.list()).length : 0 },
      recipes: (await this.recipes()).length,
      nameFromTags: this.namesFromTags()
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
        const name = `${e.name} ${e.sourceName ?? ''}`.toLowerCase()
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

  async update(id: string, patch: { name?: string; description?: string; tags?: string[]; tagGroups?: Partial<Record<TagGroup, string[]>>; notes?: string; effect?: VfxEffect }): Promise<VfxEntry> {
    const hit = await this.find(id)
    if (!hit) throw new VfxError(`no VFX entry "${id}"`)
    const e: VfxEntry = { ...hit.entry, updatedAt: this.now() }
    if (typeof patch.name === 'string' && patch.name.trim() && patch.name.trim().slice(0, 80) !== e.name) {
      // A rename is the user's ("Name from tags" on many entries leaves it); an imported model keeps
      // its original name as sourceName; back to the original name is not a rename.
      const name = patch.name.trim().slice(0, 80)
      if (e.kind === 'model' && e.sourceName === undefined) e.sourceName = e.name
      if (name === e.sourceName) {
        delete e.sourceName
        delete e.nameFrom
      } else e.nameFrom = 'user'
      e.name = name
      if (e.effect) e.effect = { ...e.effect, name: effectNameFor(name, hit.entry.sourceName ?? (e.kind === 'model' ? hit.entry.name : undefined)) }
    }
    if (typeof patch.description === 'string') e.description = patch.description.slice(0, 2000)
    // Tag edits are the user's: the groups they change are kept on re-tag.
    if (Array.isArray(patch.tags) || (patch.tagGroups && typeof patch.tagGroups === 'object')) {
      const before = tagGroupsOf(e)
      const after = patch.tagGroups && typeof patch.tagGroups === 'object' ? normalizeGroups({ ...before, ...patch.tagGroups }) : groupsFromTags((patch.tags ?? []).map(String))
      const changed = changedGroups(before, after)
      e.tagGroups = after
      e.tags = flatTags(after)
      if (changed.length) e.userTagGroups = [...new Set([...(e.userTagGroups ?? []), ...changed])].filter((k) => TAG_GROUP_ORDER.includes(k))
    }
    if (typeof patch.notes === 'string') e.notes = patch.notes.slice(0, 2000)
    if (patch.effect) {
      // The effect's name follows the entry (the editor may still hold the one from before a rename).
      const name = e.effect?.name
      e.effect = await this.prepareTextures(patch.effect, hit.store.scope)
      if (name && e.effect.name !== name) e.effect = { ...e.effect, name }
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

  async expand(paths: string[]): Promise<string[]> {
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
      } else if (s.isFile()) {
        const ext = extname(p).toLowerCase()
        if (s.size > (PLACE_EXT.has(ext) ? MAX_PLACE_BYTES : MAX_FILE_BYTES)) return
        if (MODEL_EXT.has(ext) || MEDIA_MIME[ext]) out.push(p)
      }
    }
    for (const p of paths) await walk(resolve(String(p)), 0)
    return out
  }

  // .rbxm / .rbxmx -> instance trees (Lune; .rbxmx also without Lune). Place files -> their VFX
  // packs (place: true; each root is a pack folder).
  async extractModels(models: string[]): Promise<Map<string, { roots?: import('../../../shared/vfx/types.ts').VfxNode[]; error?: string; place?: boolean; packs?: string[] }>> {
    const extracted = new Map<string, { roots?: import('../../../shared/vfx/types.ts').VfxNode[]; error?: string; place?: boolean; packs?: string[] }>()
    if (!models.length) return extracted
    const lune = await this.deps.lune().catch((e) => ({ error: (e as Error).message }))
    const runtime = this.deps.runtimeDir()
    if (!('error' in lune) && runtime) {
      for (const r of await luneExtract(models, { lune: lune.path, runtimeDir: runtime, run: this.deps.luneRun })) extracted.set(r.file, r)
    }
    for (const f of models) {
      const prev = extracted.get(f)
      if (prev?.roots) continue
      if (extname(f).toLowerCase() === '.rbxlx') {
        try {
          const packs = findVfxPacks(readRbxmx(await readFile(f, 'utf8')))
          extracted.set(f, { roots: packs.map((p) => p.node), place: true, packs: packs.map((p) => p.path.join('.')) })
        } catch (e) {
          extracted.set(f, { error: `could not read the XML: ${(e as Error).message}` })
        }
      } else if (extname(f).toLowerCase() === '.rbxmx') {
        try {
          extracted.set(f, { roots: readRbxmx(await readFile(f, 'utf8')) })
        } catch (e) {
          extracted.set(f, { error: `could not read the XML: ${(e as Error).message}` })
        }
      } else if (!prev) {
        extracted.set(f, { error: `binary ${extname(f).toLowerCase()} needs Lune to be read (${'error' in lune ? lune.error : 'the Lune runtime scripts are missing'}); install Lune (Settings > Tests) or save it as ${extname(f).toLowerCase() === '.rbxl' ? '.rbxlx' : '.rbxmx'} in Studio` })
      }
    }
    return extracted
  }

  // Setting "Name effects from tags".
  namesFromTags(): boolean {
    return this.deps.nameFromTags?.get() ?? false
  }

  setNamesFromTags(on: boolean): boolean {
    this.deps.nameFromTags?.set?.(!!on)
    return this.namesFromTags()
  }

  // Lower-case names of every entry (both libraries): tag names get " (2)", " (3)" against them.
  async usedNames(): Promise<Set<string>> {
    return new Set((await this.list()).map((e) => e.name.toLowerCase()))
  }

  // One imported effect -> a library entry ('model'). `file` is the model file kept with it (re-import).
  // g.name is the effect's own name (file / Studio). The entry is named from its tags when
  // `fromTags` (undefined: the setting), else `name` (the user's, from the import review) or g.name;
  // `used` holds the names taken so far (tag names are made unique against it).
  async addEffect(store: VfxStore, g: EffectGroup, opts: { origin: string; tagHint?: string; file?: { name: string; bytes: Buffer | string } | null; tags?: string[]; name?: string; fromTags?: boolean; used?: NameSet }): Promise<{ entry: VfxEntry; notes: string[] }> {
    const given = opts.name?.trim().slice(0, 80) || undefined
    const userName = opts.fromTags !== true && given && given !== g.name ? given : undefined
    // A name the user typed is evidence for the tags too (as the effect's name).
    let effect = effectFromNodes(userName ?? g.name, g.nodes)
    const notes = importNotes(g.nodes, effect, emitAttributes(effect.roots))
    const tags = tagFields(effect, `${userName ? `${userName} ` : ''}${g.name} ${opts.tagHint ?? ''}`, opts.tags ?? [])
    let name = userName ?? g.name
    let naming: Pick<VfxEntry, 'sourceName' | 'nameFrom'> = userName ? { sourceName: g.name, nameFrom: 'user' } : {}
    const base = !userName && (opts.fromTags ?? this.namesFromTags()) ? tagNameBase(tags.tagGroups!, g.name) : null
    if (base) {
      name = uniqueName(base, opts.used ?? (await this.usedNames()))
      naming = { sourceName: g.name, nameFrom: 'tags' }
      effect = { ...effect, name: effectNameFor(name) }
    } else opts.used?.add(name.toLowerCase())
    const id = entryId(name)
    const now = this.now()
    const entry: VfxEntry = {
      id,
      scope: store.scope,
      kind: 'model',
      name,
      ...naming,
      description: describeEffect(effect),
      ...tags,
      createdAt: now,
      updatedAt: now,
      origin: opts.origin,
      effect,
      stats: effectStats(effect),
      thumbs: [],
      quality: 'reference',
      importVersion: IMPORT_VERSION,
      ...(notes.length ? { importNotes: notes } : {})
    }
    if (opts.file) await store.writeFile(id, `media/${safeFileName(opts.file.name)}`, typeof opts.file.bytes === 'string' ? Buffer.from(opts.file.bytes, 'utf8') : opts.file.bytes)
    return { entry: await store.save(entry), notes }
  }

  // Rebuilds an imported model entry from the model file stored with it (entries imported by an
  // older Forge miss parts, meshes and script tweens). Keeps id, name, tags, rating and notes;
  // drops the old thumbnail so the preview takes a new one.
  async reimport(id: string): Promise<VfxEntry> {
    const hit = await this.find(id)
    if (!hit) throw new VfxError(`no VFX entry "${id}"`)
    const e = hit.entry
    if (e.kind !== 'model') throw new VfxError('Only imported models can be re-imported.')
    const mediaDir = join(hit.store.entryDir(id), 'media')
    const files = (await readdir(mediaDir).catch(() => [] as string[])).filter((f) => MODEL_EXT.has(extname(f).toLowerCase()))
    if (!files.length) throw new VfxError('The original model file is not stored with this entry (files over 20 MB are not kept): import the .rbxm / .rbxmx again.')
    const file = join(mediaDir, files.find((f) => basename(f, extname(f)) === basename(e.origin, extname(e.origin))) ?? files[0])
    const r = (await this.extractModels([file])).get(file)
    if (!r?.roots) throw new VfxError(`Could not read ${basename(file)}: ${r?.error ?? 'unreadable'}`)
    const groups = splitEffects(r.roots)
    // Entries named from their tags (or renamed) find their effect by its original name.
    const own = e.sourceName ?? e.name
    const g = groups.find((x) => x.name === own) ?? (groups.length === 1 ? groups[0] : null)
    if (!g) throw new VfxError(groups.length ? `The model file holds ${groups.length} effects and none is named "${own}".` : 'No effect found in the stored model file.')
    const effect = effectFromNodes(e.sourceName !== undefined ? (e.effect?.name ?? e.name) : e.name, g.nodes)
    const notes = importNotes(g.nodes, effect, emitAttributes(effect.roots))
    const next: VfxEntry = { ...e, effect, stats: effectStats(effect), description: describeEffect(effect), importVersion: IMPORT_VERSION, updatedAt: this.now(), thumbs: [] }
    if (notes.length) next.importNotes = notes
    else delete next.importNotes
    const saved = await hit.store.save(next)
    this.changed()
    return saved
  }

  // Files and folders -> library entries. Effects already in the library (same content hash, same
  // scope) or repeated in this import are skipped and listed in `duplicates` unless `force`.
  async import(paths: string[], scope: VfxScope = 'user', opts: { force?: boolean } = {}): Promise<VfxImportResult> {
    const store = this.store(scope)
    const known = opts.force ? new Map<string, VfxEntry>() : await this.hashIndex(scope)
    const seen = new Map<string, string>()
    const files = await this.expand(Array.isArray(paths) ? paths : [])
    const result: VfxImportResult = { added: [], skipped: [] }
    if (!files.length) return result
    const models = files.filter((f) => MODEL_EXT.has(extname(f).toLowerCase()))
    const media = files.filter((f) => !MODEL_EXT.has(extname(f).toLowerCase()))
    const extracted = await this.extractModels(models)
    const used = await this.usedNames()
    for (const f of models) {
      const r = extracted.get(f)
      if (!r?.roots) {
        result.skipped.push({ file: f, reason: r?.error ?? 'unreadable' })
        continue
      }
      const groups = r.place ? splitEffects(r.roots, { packs: true }) : splitEffects(r.roots)
      if (!groups.length) {
        result.skipped.push({ file: f, reason: r.place ? `no VFX folder found (a Folder with ${3}+ effects in ${'Workspace, ReplicatedStorage or ServerStorage'})` : 'no ParticleEmitter, Beam, Trail, light or visible part found' })
        continue
      }
      const bytes = r.place ? null : await readFile(f)
      const keep = bytes && bytes.length < KEEP_FILE_BYTES ? { name: basename(f), bytes } : null
      for (const g of groups) {
        const name = groups.length > 1 || r.place ? g.name : basename(f, extname(f))
        if (!opts.force) {
          const hash = effectHash(effectFromNodes(name, g.nodes))
          const of = known.get(hash)?.name ?? seen.get(hash)
          if (of) {
            ;(result.duplicates ??= []).push({ file: f, name, of })
            continue
          }
          seen.set(hash, name)
        }
        const { entry, notes } = await this.addEffect(store, { ...g, name }, { origin: basename(f), tagHint: basename(f), file: keep, used })
        if (notes.length) (result.notes ??= []).push({ file: f, notes })
        result.added.push(entry)
      }
      if (r.place && r.packs?.length) (result.notes ??= []).push({ file: f, notes: [`VFX folders read: ${r.packs.slice(0, 6).join(', ')}${r.packs.length > 6 ? ` and ${r.packs.length - 6} more` : ''}`] })
    }
    for (const f of media) {
      const ext = extname(f).toLowerCase()
      const name = basename(f, ext)
      const id = entryId(name)
      const file = `media/${safeFileName(basename(f))}`
      await store.writeFile(id, file, await readFile(f))
      const named = autoTagGroups({ name, roots: [], cues: [], duration: 1 }, name).groups
      const tagGroups: TagGroups = { ...named, timing: [] }
      const tags = flatTags(tagGroups)
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
          tagGroups,
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

  // ------------------------------------------------------------ duplicates, trash, re-tag

  private hashes = new Map<string, { at: number; hash: string | null }>()

  // The content hash of an entry's effect (fingerprint.ts); null for media entries.
  entryHash(e: VfxEntry): string | null {
    if (!e.effect) return null
    const key = `${e.scope}:${e.id}`
    const c = this.hashes.get(key)
    if (c && c.at === e.updatedAt) return c.hash
    const hash = effectHash(e.effect)
    this.hashes.set(key, { at: e.updatedAt, hash })
    return hash
  }

  // hash -> the oldest entry with it, in one scope (or both).
  async hashIndex(scope?: VfxScope): Promise<Map<string, VfxEntry>> {
    const out = new Map<string, VfxEntry>()
    const entries = scope ? await this.store(scope).list().catch(() => [] as VfxEntry[]) : await this.list()
    for (const e of [...entries].sort((a, b) => a.createdAt - b.createdAt)) {
      const h = this.entryHash(e)
      if (h && !out.has(h)) out.set(h, e)
    }
    return out
  }

  // Groups of entries with the same effect (same scope), oldest first: keep [0], the rest are extras.
  async duplicates(): Promise<{ hash: string; scope: VfxScope; entries: VfxEntry[] }[]> {
    const by = new Map<string, VfxEntry[]>()
    for (const e of await this.list()) {
      const h = this.entryHash(e)
      if (!h) continue
      const k = `${e.scope}:${h}`
      by.set(k, [...(by.get(k) ?? []), e])
    }
    return [...by.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([k, list]) => {
        // Keep a rated / liked one first, then the oldest.
        const sorted = [...list].sort((a, b) => Number(b.rating === 'up') - Number(a.rating === 'up') || a.createdAt - b.createdAt)
        return { hash: k.slice(k.indexOf(':') + 1), scope: list[0].scope, entries: sorted }
      })
      .sort((a, b) => b.entries.length - a.entries.length)
  }

  // Moves entries to the library trash (both scopes); Undo with restore(batch). The trash is emptied
  // at the next start (purgeTrash).
  async trash(ids: string[]): Promise<{ batch: string; removed: string[] }> {
    const batch = `t${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const removed: string[] = []
    const want = new Set(ids.map(String))
    for (const s of [this.project(), this.user]) {
      if (!s) continue
      const mine = (await s.list()).filter((e) => want.has(e.id)).map((e) => e.id)
      if (mine.length) removed.push(...(await s.trash(mine, batch)))
    }
    if (removed.length) this.changed()
    return { batch, removed }
  }

  async restore(batch: string): Promise<{ restored: string[] }> {
    const restored: string[] = []
    for (const s of [this.project(), this.user]) if (s) restored.push(...(await s.restore(String(batch))))
    if (restored.length) this.changed()
    return { restored }
  }

  // Every entry of one scope to the trash.
  async clear(scope: VfxScope): Promise<{ batch: string; removed: string[] }> {
    const ids = (await this.store(scope).list()).map((e) => e.id)
    return this.trash(ids)
  }

  async purgeTrash(): Promise<void> {
    for (const s of [this.project(), this.user]) if (s) await s.purgeTrash().catch(() => undefined)
  }

  // Recomputes the auto-tags of every entry with an effect; groups the user edited (and custom
  // tags) stay as they are. Entries named from their tags are named again from the new tags (with the
  // setting on), unless the user renamed them or edited their kind / element / custom tags (then only
  // "Name from tags" renames them).
  async retag(): Promise<{ changed: number; total: number; renamed?: number }> {
    let changed = 0
    let total = 0
    let renamed = 0
    const rename = this.namesFromTags()
    const used = rename ? nameCounter(await this.list()) : null
    for (const s of [this.project(), this.user]) {
      if (!s) continue
      for (const e of await s.list()) {
        if (!e.effect) continue
        total++
        // A name given from the tags is no evidence for them: the original name is.
        const byTags = e.nameFrom === 'tags'
        const own = byTags ? (e.sourceName ?? e.effect.name) : e.name
        const t = tagFields(byTags ? { ...e.effect, name: own } : e.effect, `${own} ${e.kind === 'model' ? e.origin : ''}`, [], { tags: e.tags, tagGroups: tagGroupsOf(e), userTagGroups: e.userTagGroups ?? [] })
        // Keep the sequence timing of composed effects and custom tags of older entries.
        const groups: TagGroups = { ...t.tagGroups!, custom: tagGroupsOf(e).custom }
        if (e.effect.script && !groups.timing.includes('sequence') && !(e.userTagGroups ?? []).includes('timing')) groups.timing = ['sequence']
        const tags = flatTags(groups)
        if (tags.join('|') === e.tags.join('|') && JSON.stringify(e.tagGroups ?? null) === JSON.stringify(groups)) continue
        const next: VfxEntry = { ...e, tags, tagGroups: groups, autoTagInfo: t.autoTagInfo }
        const base = byTags && used && !(e.userTagGroups ?? []).some((k) => k !== 'timing') ? nameFromTags(groups, '') : ''
        if (base && baseName(e.name).toLowerCase() !== base.toLowerCase()) {
          used!.delete(e.name.toLowerCase())
          next.name = uniqueName(base, used!)
          next.effect = { ...e.effect, name: effectNameFor(next.name) }
          renamed++
        }
        await s.save(next)
        changed++
      }
    }
    if (changed) this.changed()
    return { changed, total, ...(renamed ? { renamed } : {}) }
  }

  // "Name from tags": entries named from their tags ("Lightning Impact"), the original name kept as
  // sourceName. ids: those entries (null: every imported model). Names someone chose on purpose
  // (renamed by the user; made effects and built-in examples, "Hollow Purple") are left (kept)
  // unless they are generic ("Particles", "Effect3") or force; names get " (2)", " (3)" against the
  // rest of the library. Layers inside the effect keep their names (scripts find them by name); the
  // effect's own name follows the entry.
  async renameFromTags(ids: string[] | null, opts: { force?: boolean } = {}): Promise<VfxNameFromTagsResult> {
    const all = await this.list()
    const used = nameCounter(all)
    const want = ids ? new Set(ids.map(String)) : null
    const targets = all.filter((e) => e.effect && (want ? want.has(e.id) : e.kind === 'model'))
    const out: VfxNameFromTagsResult = { renamed: [], kept: 0, unchanged: 0, noTags: 0, total: targets.length }
    for (const e of targets) {
      if (!opts.force && (e.nameFrom === 'user' || e.kind !== 'model') && !isGenericName(e.name)) {
        out.kept++
        continue
      }
      const base = nameFromTags(tagGroupsOf(e), '')
      if (!base) {
        out.noTags++
        continue
      }
      if (baseName(e.name).toLowerCase() === base.toLowerCase()) {
        out.unchanged++
        continue
      }
      used.delete(e.name.toLowerCase())
      const name = uniqueName(base, used)
      const next: VfxEntry = { ...e, name, nameFrom: 'tags', sourceName: e.sourceName ?? e.name, effect: { ...e.effect!, name: effectNameFor(name) } }
      out.renamed.push(await this.store(e.scope).save(next))
    }
    if (out.renamed.length) this.changed()
    return out
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
    const fb = await this.feedback()
    const recipes = extractRecipes(entries, 1, { boost: (e) => feedbackBoost(fb, e.id) })
    await mkdir(this.deps.userDir, { recursive: true })
    await writeFile(this.recipesFile(), JSON.stringify(recipes, null, 1), 'utf8')
    const saved: string[] = []
    const errors: string[] = []
    if (this.deps.memory) {
      for (const r of recipes) {
        const examples = entries
          .filter((e) => recipeMatches(e, r.tag) && e.quality !== 'avoid' && e.effect)
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
    // The most specific first: KIND+ELEMENT pairs ("slash+fire"), then the tags.
    const g = groupsFromTags(tags)
    tags = [...g.kind.flatMap((k) => g.element.map((el) => `${k}+${el}`)), ...tags]
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
    const prevRating = hit.entry.rating ?? null
    if (rating) e.rating = rating
    else delete e.rating
    if (e.kind === 'generated') e.quality = rating === 'up' ? 'good' : rating === 'down' ? 'avoid' : undefined
    if (!e.quality) delete e.quality
    const saved = await hit.store.save(e)
    // The effects it was made from: liked results make them better starting points, disliked worse.
    if (saved.basedOn?.length && prevRating !== (rating ?? null)) await this.saveFeedback(recordFeedback(await this.feedback(), saved.basedOn, rating, prevRating)).catch((err) => this.deps.log?.(`vfx: feedback: ${(err as Error).message}`, 'stderr'))
    await this.recordPrinciples(saved, rating).catch((err) => this.deps.log?.(`vfx: principle feedback: ${(err as Error).message}`, 'stderr'))
    if (rating === 'up' && this.deps.memory && saved.effect?.script) await this.saveSequenceSkill(saved).catch((err) => this.deps.log?.(`vfx: sequence skill: ${(err as Error).message}`, 'stderr'))
    if (rating === 'down' && this.deps.memory) await this.saveAvoidNotes(saved).catch((err) => this.deps.log?.(`vfx: avoid note: ${(err as Error).message}`, 'stderr'))
    // Liked or disliked results change the recipes for their tags.
    if (rating && this.deps.memory && saved.effect) await this.relearn(saved.tags).catch(() => undefined)
    this.changed()
    return saved
  }

  // Ratings teach the principle weights: the rated effect's per-principle scores (its last critique,
  // else the code checks) and the user's notes.
  private async recordPrinciples(e: VfxEntry, rating: 'up' | 'down' | null): Promise<void> {
    const p = this.deps.principles
    if (!p || !e.effect) return
    if (!rating) return void (await p.forget?.('vfx', e.id))
    const last = e.iterations?.[e.iterations.length - 1]?.critique
    const ids = principleIds('vfx', e.origin || e.description)
    const scores = scoresForRating(last?.principles, () => vfxPrincipleChecks(e.effect!).filter((c) => ids.includes(c.id)))
    await p.record({ lab: 'vfx', entryId: e.id, name: e.name, rating, scores, ...(e.notes ? { notes: e.notes } : {}) })
  }

  private async principleWeights(): Promise<PrincipleWeights> {
    return (await this.deps.principles?.weights().catch(() => ({}))) ?? {}
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
    const fb = await this.feedback()
    for (const t of tags) {
      const r = extractRecipe(t, entries, { boost: (e) => feedbackBoost(fb, e.id) })
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

  // The closest library effects for a request (retrieve.ts: kind, element, colours, words, ratings
  // and remix feedback), else the word search.
  async references(tags: string[], text: string, exclude?: string): Promise<VfxEntry[]> {
    const entries = await this.list()
    const near = nearestEffects(`${text} ${tags.join(' ')}`, entries, { exclude, limit: 3, feedback: await this.feedback() }).map((m) => m.entry)
    if (near.length) return near
    const hits = await this.search([...tags, text].join(' '), { limit: 8 })
    return hits.filter((e) => e.id !== exclude && e.effect).slice(0, 3)
  }

  // ------------------------------------------------------------ feedback (which bases remix well)

  private feedbackFile(): string {
    return join(this.deps.userDir, 'feedback.json')
  }

  async feedback(): Promise<VfxFeedback> {
    try {
      return normalizeFeedback(JSON.parse(await readFile(this.feedbackFile(), 'utf8')))
    } catch {
      return emptyFeedback()
    }
  }

  private async saveFeedback(fb: VfxFeedback): Promise<void> {
    await mkdir(this.deps.userDir, { recursive: true })
    await writeFile(this.feedbackFile(), JSON.stringify(fb, null, 1), 'utf8')
  }

  // Request + library -> grounding (closest effects, learned recipe, real textures by role).
  async groundFor(text: string, exclude?: string): Promise<Grounding> {
    const [entries, recipes, feedback] = await Promise.all([this.list(), this.recipes(), this.feedback()])
    const libraryRoles = (await this.deps.textures?.roleTextures?.().catch(() => ({}))) ?? {}
    const lib = (await this.deps.textures?.list?.().catch(() => [])) ?? []
    const libraryRefs = lib.filter((t) => t.rating !== 'down').flatMap((t) => [texRef(t.id), ...(t.roblox?.uri ? [t.roblox.uri] : [])])
    return ground(text, { entries, recipes, feedback, libraryRoles, libraryRefs }, { exclude })
  }

  // Creates (or replaces, with `id`) a generated entry from a spec and writes it into the project.
  async create(spec: VfxSpec, opts: { id?: string; prompt?: string; modelNote?: string } = {}): Promise<{ entry: VfxEntry; warnings: PerfWarning[] }> {
    return this.saveEffect(effectFromSpec(spec), { ...opts, description: spec.description, tags: spec.tags })
  }

  // Saves an effect as a generated entry (new, or replacing `id`) and writes it into the project.
  // Writes src/shared/VFX/<Name> too, except for built-in examples (writeProject: false, and later
  // saves of an example not written yet): those reach the project only through Export / Add to game.
  // modelNote: why the model did not draft it ("Drafted without a model because: ..."); a later save
  // without one clears it.
  async saveEffect(raw: VfxEffect, opts: { id?: string; prompt?: string; description?: string; tags?: string[]; refId?: string; restatement?: Restatement; writeProject?: boolean; reuseTextures?: boolean; modelNote?: string; basedOn?: string[]; makeNotes?: string[]; pick?: VfxPick; authoritativeTags?: TagGroup[] } = {}): Promise<{ entry: VfxEntry; warnings: PerfWarning[] }> {
    const spec = { name: raw.name, description: opts.description, tags: opts.tags }
    const prev = opts.id ? await this.find(opts.id) : null
    if (opts.id && !prev) throw new VfxError(`no VFX entry "${opts.id}"`)
    const store = prev?.store ?? this.project() ?? this.user
    // Composed / drafted / scripted effects: the texture policy applies (reuse library textures);
    // built-in examples keep their textures.
    const effect = await this.prepareTextures(raw, store.scope, opts.reuseTextures ?? opts.writeProject !== false)
    const now = this.now()
    const tagInfo = tagFields(effect, opts.prompt ?? '', (spec.tags ?? []).map((t) => String(t).toLowerCase()), prev?.entry, opts.authoritativeTags)
    const entry: VfxEntry = {
      ...(prev?.entry ?? { createdAt: now, thumbs: [], iterations: [] }),
      id: prev?.entry.id ?? entryId(effect.name),
      scope: store.scope,
      kind: 'generated',
      name: effect.name,
      description: spec.description?.slice(0, 600) || (prev && effect.script ? prev.entry.description : '') || describeEffect(effect),
      ...tagInfo,
      updatedAt: now,
      origin: opts.prompt ?? prev?.entry.origin ?? effect.name,
      effect,
      stats: effectStats(effect),
      ...(opts.refId ? { refId: opts.refId } : {}),
      ...(opts.restatement ? { restatement: opts.restatement } : {}),
      ...(opts.basedOn?.length ? { basedOn: opts.basedOn.slice(0, 6) } : {}),
      ...(opts.makeNotes?.length ? { makeNotes: opts.makeNotes.slice(0, 8).map((n) => n.slice(0, 200)) } : {}),
      ...(opts.pick ? { pick: opts.pick } : {})
    } as VfxEntry
    if (opts.modelNote) entry.modelNote = opts.modelNote.slice(0, 600)
    else delete entry.modelNote
    let saved = await store.save(entry)
    const unwrittenExample = !!prev && !prev.entry.written && String(prev.entry.origin ?? '').startsWith('example:')
    if (this.deps.projectRoot() && opts.writeProject !== false && !unwrittenExample) saved = await this.writeProjectFiles(saved)
    this.changed()
    return { entry: saved, warnings: perfWarnings(effect) }
  }

  // src/shared/VFX/<Name>/init.luau + Effect.rbxmx (Rojo: a ModuleScript with the model as child).
  async writeProjectFiles(entry: VfxEntry): Promise<VfxEntry> {
    const root = this.deps.projectRoot()
    if (!root || !entry.effect) return entry
    let dir = entry.written ? entry.written.module.replace(/\/init\.luau$/, '') : `${VFX_SRC_DIR}/${entry.effect.name}`
    if (!entry.written) {
      // Do not overwrite an effect folder another entry (or a person) owns.
      for (let i = 2; await exists(join(root, dir)); i++) dir = `${VFX_SRC_DIR}/${entry.effect.name}${i}`
    }
    for (const f of await this.exportFiles(entry, dir)) {
      const abs = resolve(root, f.path)
      if (!abs.startsWith(resolve(root) + sep)) throw new VfxError('effect path escapes the project')
      const cur = await readFile(abs, 'utf8').catch(() => null)
      if (f.onlyIfExists && cur === null) continue
      if (cur !== null && f.owned && !f.owned(cur)) continue
      if (cur === f.content) continue
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, f.content, 'utf8')
    }
    return this.markWritten(entry, dir)
  }

  // Records where an effect lives in the project (later edits write back there).
  async markWritten(entry: VfxEntry, dir: string): Promise<VfxEntry> {
    const written = { module: `${dir}/init.luau`, model: `${dir}/Effect.rbxmx` }
    if (entry.written?.module === written.module) return entry
    const hit = await this.find(entry.id)
    return (hit?.store ?? this.user).save({ ...entry, written })
  }

  // The files an effect writes when it lives in `dir` (repo-relative): the module, its model, the
  // timeline script and the shared ForgeFX runtime next to the effect folders. One exporter for
  // writeProjectFiles and "Add to game". owned: overwrite an existing file only when it says yes;
  // onlyIfExists: only rewrite a file that is already there.
  async exportFiles(entry: VfxEntry, dir: string): Promise<{ path: string; content: string; role: string; owned?: (current: string) => boolean; onlyIfExists?: boolean }[]> {
    if (!entry.effect) throw new VfxError(`"${entry.name}" is a media reference; there is nothing to export`)
    // Custom textures: forgetex:// -> rbxassetid:// (uploaded) or a built-in fallback (not yet).
    // Centred like the preview (placement.ts): the template and the module play the effect with
    // its anchor at the target, also when it was imported with its place's world positions.
    const fx = centreEffect(await this.exportTextures(entry.effect))
    const out: { path: string; content: string; role: string; owned?: (current: string) => boolean; onlyIfExists?: boolean }[] = [
      { path: `${dir}/init.luau`, content: luauModule(fx, { description: entry.description }), role: 'effect module' },
      { path: `${dir}/Effect.rbxmx`, content: writeRbxmx(fx.roots), role: 'effect model' }
    ]
    if (fx.script) out.push({ path: `${dir}/Timeline.luau`, content: timelineModule(fx.script), role: 'timeline script' })
    else out.push({ path: `${dir}/Timeline.luau`, content: '-- No timeline script (the effect plays its compiled cues).\nreturn nil\n', role: 'timeline script', onlyIfExists: true })
    // ForgeFX: rewritten when it is ours (starts with the runtime header), left alone when someone
    // replaced it with their own.
    const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''
    if (needsRuntime(fx)) out.push({ path: `${parent ? parent + '/' : ''}${RUNTIME_MODULE}.luau`, content: FORGEFX_SOURCE, role: 'ForgeFX runtime', owned: isOwnRuntime })
    return out
  }

  private async prepareTextures(effect: VfxEffect, scope?: VfxScope, reuse = false): Promise<VfxEffect> {
    if (!this.deps.textures) return effect
    return this.deps.textures.prepareEffect(effect, scope, { reuse }).catch((e) => {
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

  // A video reference in this library ("make it like this"): prompt block, critic block, key frames.
  async pinnedRef(id: string): Promise<PinnedRef> {
    const hit = await this.find(String(id ?? ''))
    if (!hit) throw new VfxError(`no video reference "${id}" in the VFX library`)
    return loadPinnedRef(hit.entry, (f) => hit.store.readFile(hit.entry.id, f))
  }

  // With a pinned reference, the critic's (or the numbers-only) match is blended into the score.
  private withMatch(c: VfxCritique, effect: VfxEffect, pinned: PinnedRef, raw?: string): VfxCritique {
    const fromCritic = raw ? parseMatch(raw) : null
    const numeric = vfxNumericMatch(effect, pinned.video)
    const match = fromCritic?.match ?? numeric.match
    return { ...c, overall: blendMatch(c.overall, match), match, matchNotes: fromCritic?.notes ?? numeric.notes }
  }

  // model: false skips the vision model (the numbers-only check), e.g. when none is set up.
  async critique(entry: VfxEntry, effect: VfxEffect, frames: Buffer[], times: number[], iteration: number, previous: VfxCritique | null, opts: { model?: boolean } = {}): Promise<VfxCritique> {
    const tags = entry.tags
    const refs = await this.references(tags, entry.origin, entry.id)
    const recipe = await this.recipeFor(tags)
    const refNames = refs.map((r) => r.name)
    const pinned = entry.refId ? await this.pinnedRef(entry.refId).catch(() => null) : null
    const vision = opts.model === false ? undefined : this.deps.vision?.('critic')
    const weights = await this.principleWeights()
    const request = criticBrief(entry.origin || entry.description, entry.restatement)
    // Richness against the user's closest effects; critic changes that would hide a layer are not
    // applied (a critic that "cleans up" a ten-layer copy to three), unless the request asks for less.
    const target = richTargetOf(refs.map((r) => ({ name: r.name, effect: r.effect })))
    const keepLayers = (c: VfxCritique): VfxCritique => {
      const g = guardLayerEdits(effect, c.changes, `${entry.origin} ${entry.restatement ? JSON.stringify(entry.restatement) : ''}`)
      if (!g.dropped.length) return c
      return { ...c, changes: g.kept, summary: `${c.summary} (Kept ${g.dropped.length} layer${g.dropped.length === 1 ? '' : 's'} the critic wanted to hide: ${[...new Set(g.dropped.map((x) => x.node))].slice(0, 4).join(', ')}.)`.trim().slice(0, 700) }
    }
    const principled = (c: VfxCritique, raw?: string) => keepLayers(withVfxPrinciples(c, effect, { request, raw, weights }))
    if (!vision) {
      const c = principled(heuristicCritique(effect, recipe, refNames))
      return pinned ? this.withMatch(c, effect, pinned) : c
    }
    const rich = target && !asksSimpler(entry.origin ?? '') ? `\n\nRichness: ${richnessLine(effect, target)}. Score layering against the user's own effects, not a generic 3-6 layers; never propose hiding or emptying a layer (emit [], Enabled false, Transparency 1, Size 0); fix a layer that does not fit instead.${tooSimple(effect, target) ? ' This effect is sparser than theirs: layering at most 6.' : ''}` : ''
    const prompt = `${critiquePrompt({ prompt: criticBrief(entry.origin, entry.restatement), effect, frameTimes: times, references: refs.map((r) => ({ name: r.name, description: r.description, effect: r.effect })), recipe, iteration, previous })}${rich}\n\n${vfxCriticPrinciples(effect, request, { weights, focus: previous?.focus })}`
    // Pinned reference: its key frames follow the rendered frames (compared side by side).
    const extra = pinned ? pinned.images : await this.referenceImages(refs, tags)
    const images: ImagePayload[] = [...frames.map((f) => ({ mime: 'image/png', base64: f.toString('base64') })), ...extra]
    const note = pinned ? `\n\n${pinned.critique}` : images.length > frames.length ? `\nThe last ${images.length - frames.length} image(s) are reference effects from the library.` : ''
    try {
      const raw = await vision(pinned ? `${CRITIC_SYSTEM}\n${REF_MATCH_TEXT}` : CRITIC_SYSTEM, prompt + studioFramesNote(frames) + note, images)
      const c = principled(parseCritique(raw, effect, refNames), raw)
      return pinned ? this.withMatch(c, effect, pinned, raw) : c
    } catch (e) {
      this.deps.log?.(`vfx: vision critique unavailable (${(e as Error).message}); using the numbers-only check`, 'stderr')
      const c = visionFailed(principled(heuristicCritique(effect, recipe, refNames)), (e as Error).message)
      return pinned ? this.withMatch(c, effect, pinned) : c
    }
  }

  // A critic model that can be asked: set (vision) and its provider set up (visionReady).
  async criticReady(): Promise<boolean> {
    if (!this.deps.vision?.('critic')) return false
    return this.deps.visionReady ? this.deps.visionReady().catch(() => true) : true
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
    const threshold = opts.threshold ?? DEFAULT_THRESHOLD
    const maxIt = Math.max(1, Math.min(10, Math.floor(opts.maxIterations ?? DEFAULT_MAX_ITERATIONS)))
    const stopAfter = new Map<number, boolean>()
    // No model to ask: the numbers-only check reads the effect, not frames, so none are rendered
    // (each render loads the preview in an offscreen window, seconds of CPU and GPU per iteration).
    let critic = false
    try {
      critic = await this.criticReady()
      const result = await refineLoop(
        hit.entry.effect,
        {
          render: async (effect, n) => {
            this.progress({ entryId: id, iteration: base + n, phase: 'render' })
            this.deps.onDraft?.(id, base + n, effect)
            if (!critic) return []
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
            const gate = this.deps.gate
            const g = gate && critic ? await gate.beforeCritique({ lab: 'vfx', entryId: id, iteration: base + n, frames: pngs.get(n) ?? [], previousScore: previous?.overall ?? null, changes: previous?.changes.length ?? 0, threshold }) : null
            if (g?.skip && previous) return skippedCritique(previous, g.reason)
            const current = (await hit.store.read(id)) ?? hit.entry
            const c = await this.critique(current, effect, pngs.get(n) ?? [], timesByIt.get(n) ?? [], base + n, previous, { model: critic })
            if (gate) stopAfter.set(n, (await gate.afterCritique({ lab: 'vfx', entryId: id, iteration: base + n, score: c.overall, threshold, remaining: maxIt - n, changes: c.changes.length, summary: c.summary })).stop)
            return c
          },
          shouldStop: async (_c, n) => stopAfter.get(n) ?? false,
          onIteration: async (it) => {
            const current = (await hit.store.read(id)) ?? hit.entry
            const iteration: VfxIteration = { n: base + it.n, at: this.now(), effect: it.effect, frames: it.frames, critique: it.critique }
            await hit.store.save({ ...current, iterations: [...(current.iterations ?? []), iteration].slice(-20), updatedAt: this.now() })
            this.progress({ entryId: id, iteration: base + it.n, phase: 'adjust', score: it.critique.overall, message: it.critique.summary })
            this.deps.onDraft?.(id, base + it.n, it.effect, it.critique.overall)
            this.changed()
          },
          cancelled: () => token.cancelled
        },
        { maxIterations: opts.maxIterations ?? DEFAULT_MAX_ITERATIONS, threshold: opts.threshold ?? DEFAULT_THRESHOLD }
      )
      // Keep the best iteration as the effect.
      const current = (await hit.store.read(id)) ?? hit.entry
      const bestFrames = result.best.frames
      const bestEffect = await this.prepareTextures(result.best.effect, hit.store.scope, true)
      let entry = await hit.store.save({
        ...current,
        effect: bestEffect,
        stats: effectStats(bestEffect),
        // (No frames rendered: the thumbnails stay as they were.)
        thumbs: bestFrames.length ? [bestFrames[Math.min(bestFrames.length - 1, 1)] ?? bestFrames[0], ...current.thumbs.filter((t) => !t.startsWith('frames/'))].filter(Boolean).slice(0, 6) : current.thumbs,
        updatedAt: this.now()
      })
      if (entry.written || (this.deps.projectRoot() && !String(entry.origin ?? '').startsWith('example:'))) entry = await this.writeProjectFiles(entry)
      this.progress({ entryId: id, iteration: base + result.iterations.length, phase: 'done', score: result.best.critique.overall, message: `stopped: ${result.stop}` })
      this.changed()
      return { ...result, entry }
    } catch (e) {
      this.progress({ entryId: id, iteration: base, phase: 'error', message: (e as Error).message })
      throw e
    } finally {
      this.running.delete(id)
      this.deps.gate?.endRun('vfx', id)
    }
  }

  // Make (single): candidates from the closest effects in the library (remixes) or the archetype
  // draft, all finished against the library (real textures, learned ranges). With a model, one model
  // edit of each candidate (or a grounded draft) per variation; when every model answer fails, the
  // code candidates are used and the error is kept for the entry's note.
  // fromScratch: no remix candidates; the grounded draft only (the library stays a style guide).
  async makeCandidates(text: string, variations = 1, opts: { fromScratch?: boolean; g?: Grounding } = {}): Promise<{ cands: Candidate[]; g: Grounding; source: 'model' | 'draft'; modelError?: string }> {
    const n = clampVariations(variations)
    const g = opts.g ?? (await this.groundFor(text))
    const base = opts.fromScratch ? [scratchCandidate(text, g)] : singleCandidates(text, g, n)
    const vision = this.deps.vision?.('default')
    if (!vision) return { cands: base, g, source: 'draft' }
    const textures = await this.textureLines()
    const runs = await Promise.allSettled(Array.from({ length: n }, (_, i) => this.modelCandidate(text, g, base[Math.min(i, base.length - 1)], VARIATION_HINTS[i] ?? '', vision, textures)))
    const cands = runs.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    const failed = runs.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) this.deps.log?.(`vfx: model draft unusable (${(failed.reason as Error)?.message}); ${cands.length ? 'using the other variations' : 'using the built-in draft'}`, 'stderr')
    if (!cands.length) return { cands: base, g, source: 'draft', modelError: (failed?.reason as Error)?.message ?? 'no answer' }
    return { cands, g, source: 'model' }
  }

  // One model answer: edits to a remix of a library effect, or a whole spec from the grounded draft.
  private async modelCandidate(text: string, g: Grounding, start: Candidate, hint: string, vision: VisionFn, textures: string[]): Promise<Candidate> {
    const grounding = groundingLines(g)
    if (start.how === 'remix') {
      const baseName = g.matches.find((m) => m.entry.id === start.basedOn[0])?.entry.name ?? 'library effect'
      const lines = [
        `Make: ${text}`,
        hint,
        `Starting effect: a copy of the user's "${baseName}" (${start.notes.join('; ')}). Its parameters (edit these; "name" is the layer key):\n${JSON.stringify(compactEffect(start.effect, { keys: true })).slice(0, 24000)}`,
        ...grounding,
        ...textures
      ].filter(Boolean)
      const raw = await vision(REMIX_SYSTEM, lines.join('\n\n'), [])
      const data = jsonObject(raw) as { name?: unknown; description?: unknown; changes?: unknown }
      let effect = start.effect
      let applied = 0
      let rejected = 0
      // Edits that would hide a layer of the user's effect are not applied (small models "simplify"
      // a ten-layer copy down to two), unless the request asks for something simpler.
      const guard = guardLayerEdits(start.effect, asChanges(data.changes), text)
      for (const ch of guard.kept) {
        try {
          effect = applyChanges(effect, [ch])
          applied++
        } catch (e) {
          if (!(e instanceof SpecError)) throw e
          rejected++
        }
      }
      if (typeof data.name === 'string' && safeName(data.name)) effect = { ...effect, name: safeName(data.name).slice(0, 40) }
      const f = finishEffect(effect, g)
      const kept = guard.dropped.length ? `; kept the ${guard.dropped.length} layer${guard.dropped.length === 1 ? '' : 's'} it tried to hide (${[...new Set(guard.dropped.map((c) => c.node))].slice(0, 4).join(', ')})` : ''
      return { effect: f.effect, basedOn: start.basedOn, how: 'model-remix', notes: [...start.notes, `${applied} model edit${applied === 1 ? '' : 's'}${rejected ? ` (${rejected} did not apply)` : ''}${kept}`, ...f.notes], ...(typeof data.description === 'string' ? { description: data.description.slice(0, 600) } : {}) }
    }
    const fallback = start.spec ?? draftCandidate(text, g).spec!
    const lines = [
      `Make: ${text}`,
      hint,
      g.recipe ? `Learned recipe "${g.recipe.tag}": ${JSON.stringify({ layers: g.recipe.layers, notes: g.recipe.notes, avoid: g.recipe.avoid }).slice(0, 3000)}` : 'No learned recipe for this type yet.',
      ...grounding,
      ...textures,
      `A starting draft you may improve: ${JSON.stringify(fallback)}`
    ].filter(Boolean)
    const raw = await vision(DRAFT_SYSTEM, lines.join('\n\n'), [])
    const answer = jsonObject(raw) as unknown as VfxSpec
    // A spec much sparser than the user's effects gets the starting draft's missing layers back.
    const { spec, added } = enrichSpec(answer, fallback, g, text)
    const f = finishEffect(effectFromSpec(spec), g)
    const notes = [...(added.length ? [`the model's draft had ${answer.layers?.length ?? 0} layer${answer.layers?.length === 1 ? '' : 's'}; added ${added.join(', ')} from the starting draft to match your library's layering`] : []), ...f.notes]
    return { effect: f.effect, basedOn: start.basedOn, how: 'model-draft', notes, spec, ...(typeof spec.description === 'string' ? { description: spec.description } : {}), ...(Array.isArray(spec.tags) ? { tags: spec.tags.map(String) } : {}) }
  }

  // Several variations -> one: the critic looks at two frames of each and picks (when frames can be
  // rendered and a critic model is set), else the code checks pick (library fit + principles).
  // modelFailed: the model just failed to answer, so the critic is not asked (rendering the frames
  // for it would only slow the fallback down).
  async pickCandidate(cands: Candidate[], g: Grounding, text: string, opts: { modelFailed?: boolean } = {}): Promise<{ index: number; pick?: VfxPick }> {
    if (cands.length < 2) return { index: 0 }
    const code = pickByCode(cands, g)
    const scores = code.scores.map((x) => x.total)
    const critic = opts.modelFailed ? null : await this.criticPick(cands, text, g).catch((e) => {
      this.deps.log?.(`vfx: critic pick unavailable (${(e as Error).message}); picking by the code checks`, 'stderr')
      return null
    })
    // The critic's pick stands unless it is much sparser than the user's effects while another
    // variation is not (a small critic model likes the cleanest frame).
    if (critic && !(tooSimple(cands[critic.index].effect, g.target, text) && cands.some((c) => !tooSimple(c.effect, g.target, text)))) return { index: critic.index, pick: { of: cands.length, chosen: critic.index, by: 'critic', why: critic.why, scores } }
    const best = code.scores[code.index]
    const overruled = critic ? `; the critic's ${String.fromCharCode(65 + critic.index)} was much sparser than your library` : ''
    return { index: code.index, pick: { of: cands.length, chosen: code.index, by: 'code', why: `best library fit ${best.total}/10 (realism ${Math.round(best.realism * 100)}%, textures reused ${Math.round(best.textureReuse * 100)}%, timing ${Math.round(best.timing * 100)}%${g.target ? `, richness ${Math.round(best.richness * 100)}%` : ''})${overruled}`, scores } }
  }

  private async criticPick(cands: Candidate[], text: string, g?: Grounding): Promise<{ index: number; why: string } | null> {
    const vision = this.deps.vision?.('critic')
    if (!vision || !this.deps.capture || !(await this.criticReady())) return null
    const images: ImagePayload[] = []
    for (const c of cands) {
      const { frames } = await this.renderEffect(c.effect, 2)
      for (const f of frames.slice(0, 2)) images.push({ mime: 'image/png', base64: f.toString('base64') })
    }
    const letters = cands.map((_, i) => String.fromCharCode(65 + i))
    const prompt = `Request: ${text}\n${cands.length} variations of the effect, 2 frames each, in order: ${letters.map((l, i) => `images ${i * 2 + 1}-${i * 2 + 2} = ${l}`).join(', ')}.\nLayers per variation: ${cands.map((c, i) => `${letters[i]} ${richness(c.effect).layers}`).join(', ')}${g?.target && !asksSimpler(text) ? `; the user's own closest effects have about ${g.target.layers} layers with staggered bursts, so a sparse variation is a step down for them` : ''}.
Pick the one a senior Roblox VFX artist would ship for this request (readability, layering, timing, colour, silhouette). Answer JSON only: {"pick":"${letters[0]}","why":"one sentence"}`
    const raw = await vision(PICK_SYSTEM, prompt, images)
    const m = /"pick"\s*:\s*"?([A-Z])/i.exec(raw)
    const index = m ? letters.indexOf(m[1].toUpperCase()) : -1
    if (index < 0) throw new Error('the critic did not name a variation')
    const why = /"why"\s*:\s*"([^"]{0,300})/.exec(raw)?.[1] ?? 'the critic preferred it'
    return { index, why }
  }

  // "Make a ___ effect": grounded candidates (remix the closest effect, or draft), pick one, create,
  // then refine in the background. Returns the new entry.
  async make(prompt: string, opts: VfxRefineOptions & { wait?: boolean } = {}): Promise<{ entry: VfxEntry; refined?: Promise<unknown> }> {
    const text = String(prompt ?? '').trim()
    if (text.length < 3) throw new VfxError('Describe the effect, e.g. "a fire slash with embers".')
    const scratch = !!opts.fromScratch
    const g0 = await this.groundFor(text)
    // The closest effect is a scripted one (Hollow Purple's orbs that converge and merge): its look
    // lives in its timeline script, which a single burst of layers cannot hold, so Make builds on the
    // script (the sequence path) instead of drafting a lookalike.
    if (!scratch && scriptedBase(text, g0)) {
      const r = await this.compose(text, { ...opts, fromMake: true })
      if (!r.entry) throw new VfxError(r.error?.message ?? 'could not build on the scripted effect')
      return { entry: r.entry, ...(r.refined ? { refined: r.refined } : {}) }
    }
    const { cands, g, modelError } = await this.makeCandidates(text, opts.variations ?? 1, { fromScratch: scratch, g: g0 })
    const { index, pick } = await this.pickCandidate(cands, g, text, { modelFailed: !!modelError })
    const c = cands[index]
    const base = c.basedOn[0] && c.how.endsWith('remix') ? g.matches.find((m) => m.entry.id === c.basedOn[0])?.entry : undefined
    const description = c.description ?? (base ? `${text} (remixed from your "${base.name}")` : scratch ? `From scratch: "${text}"` : `Draft for "${text}"`)
    const { entry } = await this.saveEffect(c.effect, {
      prompt: text,
      description,
      tags: [...new Set([...g.tags, ...(c.tags ?? [])])],
      basedOn: scratch ? [] : c.basedOn,
      makeNotes: [...(scratch ? [scratchNote(g)] : base ? [] : [noBaseNote(g)]), ...c.notes, ...richnessNotes(c.effect, g, text)],
      ...(pick ? { pick } : {}),
      authoritativeTags: authoritative(g),
      ...(modelError ? { modelNote: draftedWithout(modelError) } : {})
    })
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

  // Built on a scripted library effect (scriptedBase): with a model and a request that asks for
  // changes, the model edits the user's own script (only what the request asks for; the stages,
  // spawns, colours and textures stay). A request that is just the effect's name, no model, or an
  // edit that never records: the script as written (with the request's colour / size written into
  // it), re-recorded on the whole effect; the stored recording when the script cannot be re-run.
  private async remixScript(text: string, g: Grounding, sb: ScriptBase, o: { vision?: VisionFn; restatement?: Restatement; pinned: PinnedRef | null; variations?: number }): Promise<{ result: VfxScriptResult; notes: string[]; source: 'model' | 'library'; modelError?: string; pick?: VfxPick }> {
    const original = sb.effect
    const layers = richness(original).layers
    const stages = (original.stages ?? []).map((s) => s.label).join(' > ')
    const baseNote = `built on your scripted "${sb.name}" (its timeline script${stages ? `: ${stages}` : ''}; ${layers} layers)`
    const record = async (script: string, name: string): Promise<VfxScriptResult> => {
      try {
        return await this.recordScript(script, { ...original, name })
      } catch (e) {
        return { ok: false, error: { message: (e as Error).message }, prints: [], warnings: [], summary: '' }
      }
    }
    // The script as written (+ the request's colour / size): the faithful copy and the fallback.
    const asWritten = async (why: string | null): Promise<Candidate & { r: VfxScriptResult }> => {
      const t = tweakScript(sb)
      const name = sb.asIs ? safeName(original.name || sb.name) || 'Sequence' : scriptName(t.script, text)
      const notes = [baseNote]
      let r = await record(t.script, name)
      if (r.ok && r.effect) {
        if (sb.asIs) notes.push(`a faithful copy: the request names your "${sb.name}" without changes, so its script was re-recorded as written`)
        notes.push(...t.notes)
        if (!sb.asIs && !t.notes.length) notes.push(`its script as written (${why ?? 'no model'} to apply "${sb.extra.join(' ').slice(0, 60)}")`)
      } else {
        // No Lune (or the script no longer records): the recording stored with the effect.
        const e = { ...tweakRecorded(sb), name }
        notes.push(`the recorded copy (the script could not be re-run: ${(r.error?.message ?? 'unknown error').slice(0, 120)})`)
        if (sb.hue !== null || sb.scale !== 1) notes.push('colour / size applied to the recorded layers; re-running the script restores its own')
        r = { ok: true, prints: [], warnings: [], summary: timelineSummary(e), effect: e }
      }
      const f = finishScriptRemix(r.effect!, original, g)
      return { effect: f.effect, basedOn: [sb.match.entry.id], how: 'script', notes: [...notes, ...f.notes], r: { ...r, effect: f.effect } }
    }
    let modelError: string | undefined
    if (o.vision && !sb.asIs) {
      const vision = o.vision
      const lines = [
        `Make: ${text}`,
        restatementBlock(o.restatement),
        `Start from the user's own scripted effect "${sb.name}"${sb.match.entry.description ? ` (${sb.match.entry.description.slice(0, 300)})` : ''}. It is their work and the request builds on it. Its timeline script:\n\`\`\`lua\n${(original.script ?? '').slice(0, 24000)}\`\`\``,
        `Edit this script for the request and answer with the whole edited script. Apply only the changes the request asks for ("${sb.extra.join(' ').slice(0, 200)}") and keep everything else as written: its stages and their timing (the choreography), every spawn with its name, position, colour and size, every tween, and every texture id exactly as it is (never replace a real texture id with a placeholder or a new id). Add layers only for what the request asks that the script does not do yet. Put the name on the first line: -- Name: <PascalCase>.`,
        ...(await this.textureLines()),
        ...(o.pinned ? [o.pinned.compose] : [])
      ].filter(Boolean)
      try {
        const images = o.pinned?.images ?? []
        const prompt = lines.join('\n\n')
        const one = (hint: string) => {
          const p = hint ? `${prompt}\n\n${hint}` : prompt
          return composeWithGate({
            lab: 'vfx',
            gate: this.deps.gate,
            ask: () => vision(COMPOSE_SYSTEM, p, images),
            check: async (raw): Promise<AttemptResult<{ s: string; r: VfxScriptResult }>> => {
              const s = extractScript(raw)
              if (!s) return { ok: false, kind: 'no-script', message: 'no script in the answer' }
              const r = await record(s, scriptName(s, text))
              if (r.ok) return { ok: true, value: { s, r } }
              const where = r.error?.line ? ` (line ${r.error.line}: ${s.split('\n')[r.error.line - 1]?.trim() ?? ''})` : ''
              return { ok: false, kind: 'script-error', message: `${r.error?.message ?? 'the script failed'}${where}` }
            },
            repair: (raw, message) => vision(COMPOSE_SYSTEM, `${p}\n\nYour script:\n\`\`\`lua\n${extractScript(raw) ?? raw.slice(0, 4000)}\`\`\`\nfailed: ${message}\nFix it and answer with the whole corrected script.`, images),
            rephrase: () => vision(COMPOSE_SYSTEM, `${p}\n\n${rephraseNote('script')}`, images)
          })
        }
        const runs = await Promise.allSettled(VARIATION_HINTS.slice(0, clampVariations(o.variations)).map((h) => one(h)))
        const ok = runs.flatMap((r) => (r.status === 'fulfilled' ? [r.value.value] : []))
        if (!ok.length) throw (runs.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason ?? new Error('no script'))
        const cands: (Candidate & { r: VfxScriptResult })[] = ok.map((v) => {
          const f = finishScriptRemix(v.r.effect!, original, g)
          const kept = richness(f.effect).layers
          return { effect: f.effect, basedOn: [sb.match.entry.id], how: 'model-script', notes: [baseNote, `the model edited its script for the request (${kept} layers; yours has ${layers})`, ...f.notes], r: { ...v.r, effect: f.effect } }
        })
        // Every edit lost much of the user's layering (a model that rewrote it from scratch): the
        // script as written joins the candidates, so the pick can keep the user's effect.
        if (!asksSimpler(text) && cands.every((c) => richness(c.effect).layers < 0.6 * layers)) cands.push(await asWritten('the model\'s edits were much sparser than your effect, so nothing'))
        const chosen = await this.pickCandidate(cands, g, text)
        const c = cands[chosen.index]
        return { result: c.r, notes: c.notes, source: c.how === 'script' ? 'library' : 'model', ...(chosen.pick ? { pick: chosen.pick } : {}) }
      } catch (e) {
        this.deps.log?.(`vfx: script edit unusable (${(e as Error).message}); using the script as written`, 'stderr')
        modelError = e instanceof ComposeGaveUp ? `the model's script did not run (${e.message})` : (e as Error).message
      }
    }
    const c = await asWritten(modelError ? 'the model\'s edit did not run, so nothing' : null)
    return { result: c.r, notes: c.notes, source: 'library', ...(modelError ? { modelError } : {}) }
  }

  // One step from a request to a scripted multi-stage effect: the model writes the timeline script
  // with the kit (one repair round on errors), else the built-in draft for the request's archetype.
  // Saved as a new entry; refined in the background when frames can be rendered (refine: false skips).
  // reference: the id of a video reference in this library; its beats, palette, vision summary and key
  // frames go into the prompt, and the result keeps it pinned (the critic scores the match).
  // A closest effect that is itself scripted (scriptedBase) is built on through its script
  // (remixScript). fromScratch: no library copy, no script reuse; the library is a style guide only.
  // fromMake: Make (single) handed a scripted match over (noted on the entry).
  async compose(request: string, opts: VfxRefineOptions & { wait?: boolean; refine?: boolean; script?: string; reference?: string; restatement?: Restatement; fromMake?: boolean } = {}): Promise<VfxScriptResult & { refined?: Promise<unknown> }> {
    const restatement = normalizeRestatement(opts.restatement) ?? undefined
    const pinned = opts.reference ? await this.pinnedRef(opts.reference) : null
    const text = String(request ?? '').trim() || (pinned ? `an effect like the reference video ${pinned.name}` : '')
    if (text.length < 3) throw new VfxError('Describe the effect, e.g. "a fireball that charges, flies forward and explodes".')
    let source: VfxScriptResult['source'] = 'draft'
    let modelError: string | undefined
    let result: VfxScriptResult | null = null
    let script = opts.script?.trim() ? opts.script : ''
    const vision = this.deps.vision?.('default')
    // Grounding in the user's library (closest effects, learned ranges, real textures by role); a
    // script passed in by the caller is used as written.
    const g = script ? null : await this.groundFor(text).catch((e) => (this.deps.log?.(`vfx: grounding: ${(e as Error).message}`, 'stderr'), null))
    // Built on a copy of the closest library effect (when one is close enough): the script adds the
    // choreography (anticipation, accents, dissipate) and the copy is the payoff on "impact", so the
    // sequence keeps the user's layering instead of a few kit rigs.
    const scratch = !!opts.fromScratch
    const sb = g && !scratch ? scriptedBase(text, g) : null
    const libBase = g && !scratch && !sb ? composeBase(text, g) : null
    const libName = libBase ? g!.matches.find((m) => m.entry.id === libBase.basedOn[0])?.entry.name ?? 'library effect' : ''
    const baseFor = (name: string): VfxEffect => (libBase ? { ...libBase.effect, name } : EMPTY_BASE(name))
    const settle = (e: VfxEffect): VfxEffect => (libBase ? alignBaseToStage(e).effect : e)
    let finished: { effect: VfxEffect; notes: string[] } | null = null
    let pick: VfxPick | undefined
    if (sb && g) {
      const out = await this.remixScript(text, g, sb, { vision: vision ?? undefined, restatement, pinned, variations: opts.variations })
      result = out.result
      script = result.effect!.script ?? ''
      finished = { effect: result.effect!, notes: [...(opts.fromMake ? [`Make (single): your "${sb.name}" is a scripted sequence, so this was built on its script`] : []), ...out.notes] }
      source = out.source
      modelError = out.modelError
      pick = out.pick
    }
    if (!result && !script && vision) {
      const tags = promptTags(text)
      const liked = (await this.list()).filter((e) => e.rating === 'up' && e.effect?.script && e.tags.some((t) => tags.includes(t))).slice(0, 1)
      const avoid = (await this.list()).filter((e) => e.quality === 'avoid' && e.effect?.script && e.tags.some((t) => tags.includes(t))).slice(0, 3)
      const lines = [
        `Make: ${text}`,
        restatementBlock(restatement),
        ...liked.map((e) =>
          scratch
            ? `The user liked a related sequence ("${e.origin}", stages ${(e.effect!.stages ?? []).map((s) => s.label).join(' > ')}); match its pacing and energy in a script of your own (do not copy it).`
            : `The user liked this related sequence ("${e.origin}"); reuse what fits:\n\`\`\`lua\n${e.effect!.script!.slice(0, 4000)}\n\`\`\``
        ),
        ...(scratch ? ['From scratch: build every layer yourself with kit rigs. The user\'s library below is a style guide only (scale, timing, colour treatment, layering, texture ids); do not rebuild or copy any of their effects.'] : []),
        ...(avoid.length ? [`The user disliked: ${avoid.map((e) => `${e.name} (${e.description.slice(0, 120)})`).join(' | ')}`] : []),
        ...(libBase
          ? [
              `The effect already holds a copy of the user's "${libName}" (${libBase.notes.join('; ')}). It plays as one burst at the effect's root when your script reaches fx:stage("impact"); its layers (you may fx:emit / fx:enable / fx:tween them by these names, never spawn a rig with one of these names):\n${baseLayerLines(libBase.effect).slice(0, 24).map((l) => `- ${l}`).join('\n')}\nWrite the choreography around it: an anticipation / charge before fx:stage("impact"), accents that support it (a light spike, extra sparks or a ground ring), then fx:stage("dissipate"). Keep the impact at the root (no fx:forward for it) and do not rebuild its layers with kit rigs.`
            ]
          : []),
        ...(g ? groundingLines(g, { script: true }) : []),
        ...(await this.textureLines()),
        ...(pinned ? [pinned.compose] : []),
        principlePlan('vfx', text, { weights: await this.principleWeights() })
      ].filter(Boolean)
      try {
        const images = pinned?.images ?? []
        const base = lines.join('\n\n')
        const one = (hint: string) => {
          const prompt = hint ? `${base}\n\n${hint}` : base
          return composeWithGate({
            lab: 'vfx',
            gate: this.deps.gate,
            ask: () => vision(COMPOSE_SYSTEM, prompt, images),
            check: async (raw): Promise<AttemptResult<{ s: string; r: VfxScriptResult }>> => {
              const s = extractScript(raw)
              if (!s) return { ok: false, kind: 'no-script', message: 'no script in the answer' }
              const r = await this.recordScript(s, baseFor(scriptName(s, text)))
              if (r.ok) return { ok: true, value: { s, r } }
              const where = r.error?.line ? ` (line ${r.error.line}: ${s.split('\n')[r.error.line - 1]?.trim() ?? ''})` : ''
              return { ok: false, kind: 'script-error', message: `${r.error?.message ?? 'the script failed'}${where}` }
            },
            repair: (raw, message) => vision(COMPOSE_SYSTEM, `${prompt}\n\nYour script:\n\`\`\`lua\n${extractScript(raw) ?? raw.slice(0, 4000)}\`\`\`\nfailed: ${message}\nFix it and answer with the whole corrected script.`, images),
            rephrase: () => vision(COMPOSE_SYSTEM, `${prompt}\n\n${rephraseNote('script')}`, images)
          })
        }
        // Variations: one script per hint; every one that records is finished against the library
        // and the critic (or the code checks) keeps one.
        const n = clampVariations(opts.variations)
        const runs = await Promise.allSettled(VARIATION_HINTS.slice(0, n).map((h) => one(h)))
        const ok = runs.flatMap((r) => (r.status === 'fulfilled' ? [r.value.value] : []))
        if (!ok.length) throw (runs.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason ?? new Error('no script'))
        const cands: (Candidate & { s: string; r: VfxScriptResult })[] = ok.map((v) => {
          const e = settle(v.r.effect!)
          const f = g ? finishEffect(e, g) : { effect: e, notes: [] }
          return { effect: f.effect, basedOn: libBase ? [...libBase.basedOn, ...(g?.near ?? []).filter((id) => id !== libBase.basedOn[0])] : g?.near ?? [], how: 'model-script', notes: [...(libBase?.notes ?? []), ...f.notes], s: v.s, r: v.r }
        })
        // Nothing in the library to build on and every script came out much sparser than the
        // user's effects (a small model's shockwave + flash): the built-in draft for the request's
        // archetype joins the candidates, so the pick can prefer a fuller sequence.
        if (g && !libBase && cands.every((c) => tooSimple(c.effect, g.target, text))) {
          const ds = draftScript(text)
          const dr = await this.recordScript(ds, EMPTY_BASE(scriptName(ds, text))).catch(() => null)
          if (dr?.ok && dr.effect) {
            const f = finishEffect(dr.effect, g)
            cands.push({ effect: f.effect, basedOn: g.near, how: 'script', notes: ['the built-in draft sequence (the model\'s scripts were much sparser than your library)', ...f.notes], s: ds, r: dr })
          }
        }
        const chosen = g ? await this.pickCandidate(cands, g, text) : { index: 0 }
        const c = cands[chosen.index]
        pick = chosen.pick
        script = c.s
        result = { ...c.r, effect: c.effect }
        finished = { effect: c.effect, notes: c.notes }
        source = c.how === 'script' ? 'draft' : 'model'
      } catch (e) {
        this.deps.log?.(`vfx: composed script unusable (${(e as Error).message}); using the built-in draft`, 'stderr')
        modelError = e instanceof ComposeGaveUp ? `the model's script did not run (${e.message})` : (e as Error).message
      }
    }
    if (!result) {
      const own = !script
      // No model script: the built-in choreography around the library copy, else the archetype draft.
      if (own) script = libBase ? libraryScript(text, libName, baseColors(libBase.effect)) : draftScript(text)
      else source = 'model'
      result = await this.recordScript(script, own ? baseFor(scriptName(script, text)) : EMPTY_BASE(scriptName(script, text)))
      if (!result.ok && opts.script) return { ...result, source }
      if (!result.ok) {
        // The built-in draft always records; this only happens when Lune itself fails.
        throw new VfxError(`could not record the draft timeline: ${result.error?.message}`)
      }
      if (g && result.effect && !opts.script) {
        const f = finishEffect(own ? settle(result.effect) : result.effect, g)
        finished = { effect: f.effect, notes: [...(own && libBase ? libBase.notes : []), ...f.notes] }
        result = { ...result, effect: finished.effect }
      }
    }
    const composeNotes = g && !opts.script ? [...(scratch ? [scratchNote(g)] : libBase || sb ? [] : [noBaseNote(g, 'composed from kit rigs')]), ...(finished?.notes ?? []), ...richnessNotes(result.effect!, g, text)] : finished?.notes ?? []
    const refTags = pinned ? ((await this.find(pinned.id))?.entry.tags ?? []).filter((t) => t !== 'video') : []
    const tags = [...new Set([...promptTags(text), ...(g?.tags ?? []), ...refTags, ...(sb ? sb.match.entry.tags.filter((t) => t !== 'example') : []), 'sequence'])]
    const modelNote = (source === 'draft' || source === 'library') && modelError ? draftedWithout(modelError) : undefined
    const stagesText = (result.effect!.stages ?? []).map((s) => s.label).join(' > ')
    const basedOn = !g || opts.script ? null : scratch ? [] : sb ? [sb.match.entry.id, ...g.near.filter((id) => id !== sb.match.entry.id)] : libBase ? [...libBase.basedOn, ...g.near.filter((id) => id !== libBase.basedOn[0])] : g.near
    const { entry } = await this.saveEffect(result.effect!, {
      prompt: text,
      tags,
      description: sb ? `${text.slice(0, 300)} (built on your "${sb.name}": ${stagesText})` : `${text.slice(0, 300)} (${stagesText})`,
      ...(pinned ? { refId: pinned.id } : {}),
      ...(restatement ? { restatement } : {}),
      ...(modelNote ? { modelNote } : {}),
      ...(basedOn ? { basedOn } : {}),
      ...(composeNotes.length ? { makeNotes: composeNotes } : {}),
      ...(pick ? { pick } : {}),
      // Built on a scripted effect: its textures stay as the user set them (no library swaps).
      ...(sb ? { reuseTextures: false } : {})
    })
    await this.ensureChoreographySkill()
    const out: VfxScriptResult & { refined?: Promise<unknown> } = { ...result, entry, source, ...(modelError && source === 'draft' ? { modelError } : {}) }
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
  // entry when it was added before. Library only: no files in the project until Export / Add to game.
  async addExample(key: string): Promise<VfxEntry> {
    const ex = findExample(key)
    if (!ex) throw new VfxError(`no built-in example "${key}" (examples: ${VFX_EXAMPLES.map((e) => e.key).join(', ')})`)
    const origin = `example:${ex.key}`
    const prev = (await this.list()).find((e) => e.origin === origin && e.kind === 'generated')
    if (prev) return prev
    const { effect } = compileTimeline(EMPTY_BASE(ex.name), RECORDED[ex.key] ?? [], ex.script)
    const { entry } = await this.saveEffect(effect, { prompt: origin, description: ex.description, tags: [...ex.tags, 'sequence', 'example'], writeProject: false })
    return entry
  }

  // ------------------------------------------------------------ textures

  private async textureLines(): Promise<string[]> {
    const list = (await this.deps.textures?.promptList(40).catch(() => [])) ?? []
    return list.length ? [list.join('\n')] : []
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

// Lower-case names in use, counted (several entries can share one): uniqueName checks and adds,
// delete frees one use.
function nameCounter(entries: VfxEntry[]): NameSet & { delete(name: string): void } {
  const n = new Map<string, number>()
  const add = (k: string) => n.set(k, (n.get(k) ?? 0) + 1)
  for (const e of entries) add(e.name.toLowerCase())
  return {
    has: (k) => (n.get(k) ?? 0) > 0,
    add,
    delete: (k) => {
      const c = n.get(k) ?? 0
      if (c > 1) n.set(k, c - 1)
      else n.delete(k)
    }
  }
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false
  )
}

export { relative, VfxLibraryError, SpecError, RECIPE_PREFIX, splitEffects }
