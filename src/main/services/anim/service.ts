// Animation Lab service: the clip library (import .rbxm / .rbxmx KeyframeSequences and .bvh motion
// capture, retargeted to R15; tags, ratings, notes, "avoid" examples), learning (style profiles per
// move type from pure stats, saved as memory skills), generation (timeline scripts recorded by Lune
// and compiled to keyframes), the render / critique / refine loop, and export to the project (a
// KeyframeSequence .rbxmx plus a Luau module) with an optional Open Cloud upload.
//
// Nothing here is model training: the library is the data, style.ts measures it, retrieval by tag
// picks the references, and models (per Labs tier: cheap / default / critic) draft, tag and critique.
// No electron imports: capture, models, memory and the Open Cloud key come in as functions.

import { studioFramesNote } from '../../../shared/studio/frames.ts'
import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import type { AnimClipRef } from '../../../shared/anim/types.ts'
import type { AnimCheckReport, AnimClip, AnimCritique, AnimEntry, AnimExportResult, AnimImportResult, AnimIteration, AnimIterationScore, AnimLabStatus, AnimRefineOptions, AnimRefineProgress, AnimScope, AnimScriptResult, AnimStyle, AnimStyleProfile, AnimUploadResult, LearnedPose, RigType } from '../../../shared/anim/model.ts'
import type { AnimCoverage, AnimImportOptions, AnimImportPreview, AnimMoveSets, AnimRetagResult } from '../../../shared/animTypes.ts'
import type { LabTier } from '../../../shared/labModels.ts'
import type { LabGate } from '../../../shared/gating/hooks.ts'
import { rephraseNote, skippedCritique } from '../../../shared/gating/gates.ts'
import { ComposeGaveUp, composeWithGate, type AttemptResult } from '../../../shared/gating/compose.ts'
import { bvhToClip, BvhError, parseBvh } from '../../../shared/anim/bvh.ts'
import { clipFromSequence, readKeyframeSequencesXml, writeKeyframeSequenceXml, type RawSequence } from '../../../shared/anim/rbxmx.ts'
import { clipSummary, finishAnimRun, compileAnim, type AnimRecordResult } from '../../../shared/anim/compile.ts'
import { measureClip } from '../../../shared/anim/measure.ts'
import { runChecks } from '../../../shared/anim/checks.ts'
import { allProfiles, buildProfile, buildStyle, coverage, profileFor, profileSkill, profileText } from '../../../shared/anim/style.ts'
import { allKnownTags, coverageOptions, entryText, heuristicRetag, mergeRetag, moveSetDef, moveSetGuide, MOVE_SETS, normalizeCustomTag, normalizeMoveSetSettings, resolveMoveSet, setAutoTags, setPromptTags, type CustomMoveTag, type MoveSetSettings, type ResolvedMoveSet } from '../../../shared/anim/movesets.ts'
import { animCriticSystem, ANIM_DEFAULT_MAX_ITERATIONS, ANIM_DEFAULT_THRESHOLD, animCritiquePrompt, animRefineLoop, beatFrameTimes, heuristicAnimCritique, parseAnimCritique, withMustFix } from '../../../shared/anim/critique.ts'
import { ANIM_API, ANIM_API_R6, ANIM_GUIDE, archetypeFor, draftAnimScript, kitReferenceText } from '../../../shared/anim/draft.ts'
import { ANIM_EXAMPLES, animExample } from '../../../shared/anim/examples.ts'
import { ANIM_RECORDED } from '../../../shared/anim/examples.recorded.ts'
import { ANIM_SEQUENCE_FILE, ANIM_SRC_DIR, animLuauModule, animModuleName } from '../../../shared/anim/luau.ts'
import { clipRig, poseCFrames } from '../../../shared/anim/sample.ts'
import { convertClip, RIG_CONVERT_WARNING } from '../../../shared/anim/convert.ts'
import { uploadAnimationAsset } from '../art/robloxAssets.ts'
import { animEntryId, AnimStore, PROJECT_ANIM_DIR } from './library.ts'
import { luneAnimExtract, luneAnimTimeline } from './lune.ts'
import { loadPinnedRef, type PinnedRef } from '../videoref/refs.ts'
import { blendMatch, parseMatch, REF_MATCH_TEXT } from '../../../shared/videoref/prompt.ts'
import { animNumericMatch } from '../../../shared/videoref/match.ts'
import type { LuneRun } from '../vfx/lune.ts'
import { animCriticPrinciples, principleIds, scoresForRating, withAnimPrinciples } from '../../../shared/principles/attach.ts'
import { animPrincipleChecks } from '../../../shared/principles/animChecks.ts'
import { principlePlan } from '../../../shared/principles/select.ts'
import type { PrincipleHooks, PrincipleWeights } from '../../../shared/principles/types.ts'
import { criticBrief, restatementBlock } from '../../../shared/restate/prompt.ts'
import { normalizeRestatement, type Restatement } from '../../../shared/restate/types.ts'
import { adjustRemixOps, applyRemix, describeRemixOp, dominantSide, heuristicRemixPlan, libraryScore, normalizeRemixPlan, parseRemixPlan, remixCandidates, remixPlanPrompt, REMIX_SYSTEM, type RemixCandidate, type RemixOp, type RemixOrigin } from '../../../shared/anim/remix.ts'
import type { AnimRemixMode, AnimRemixOptions } from '../../../shared/animTypes.ts'
import { intentText, motionIntent, type MotionIntent } from '../../../shared/anim/intent.ts'
import { bestIteration, clampCriticWeight, DEFAULT_CRITIC_WEIGHT, guardedApply, iterationScore, type QualityContext } from '../../../shared/anim/quality.ts'
import { DIGEST_NOTE, keyframeDigest } from '../../../shared/anim/digest.ts'

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
  // Principle priorities: the user's learned weights (critique, compose plan) and the rating log.
  principles?: PrincipleHooks
  // Lab gating (services/gating): skip the critic, early stop, retry routes. Optional.
  gate?: LabGate
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
// Video references (kind 'media') live in the library but have no keys.
const isClip = (e: AnimEntry) => e.kind !== 'media'
function needClip(e: AnimEntry): AnimEntry {
  if (!isClip(e)) throw new AnimError(`"${e.name}" is a video reference (no keys); use "Make it like this" (anim_compose with reference) to animate from it`)
  return e
}

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

  // ------------------------------------------------------------ move sets (Combat / Football / ...)

  // The project's settings.json (next to the rig), else <userDir>/settings.json without a project.
  private settingsFile(): string {
    return this.rigFile() ?? join(this.deps.userDir, RIG_SETTINGS_FILE)
  }

  private async readSettings(): Promise<Record<string, unknown>> {
    try {
      const v = JSON.parse(await readFile(this.settingsFile(), 'utf8')) as unknown
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  private async moveSetSettings(): Promise<MoveSetSettings> {
    return normalizeMoveSetSettings((await this.readSettings()).moveSet)
  }

  private async writeMoveSetSettings(next: MoveSetSettings): Promise<void> {
    const f = this.settingsFile()
    const prev = await this.readSettings()
    await mkdir(join(f, '..'), { recursive: true })
    await writeFile(f, JSON.stringify({ ...prev, moveSet: normalizeMoveSetSettings(next) }, null, 2) + '\n', 'utf8')
    this.styleCache = null
  }

  // The active move set with the project's custom move types.
  async moveSet(): Promise<ResolvedMoveSet> {
    return resolveMoveSet(await this.moveSetSettings())
  }

  async moveSets(): Promise<AnimMoveSets> {
    return { active: await this.moveSet(), sets: MOVE_SETS.map(({ id, name, description }) => ({ id, name, description })) }
  }

  // Switching keeps every clip's tags; "Re-tag library" (retag) applies the new set.
  async setMoveSet(id: string): Promise<ResolvedMoveSet> {
    const cur = await this.moveSetSettings()
    await this.writeMoveSetSettings({ ...cur, set: moveSetDef(id).id })
    this.changed()
    return this.moveSet()
  }

  async addMoveTag(input: CustomMoveTag | string): Promise<ResolvedMoveSet> {
    const tag = normalizeCustomTag(input)
    if (!tag) throw new AnimError('Name the move type (letters, numbers, spaces or dashes).')
    const cur = await this.moveSetSettings()
    const set = moveSetDef(cur.set)
    if (set.tags.some((t) => t.tag === tag.tag)) throw new AnimError(`${set.name} already has "${tag.tag}"`)
    const list = (cur.custom[set.id] ?? []).filter((c) => c.tag !== tag.tag)
    await this.writeMoveSetSettings({ ...cur, custom: { ...cur.custom, [set.id]: [...list, tag] } })
    this.changed()
    return this.moveSet()
  }

  async removeMoveTag(tag: string): Promise<ResolvedMoveSet> {
    const cur = await this.moveSetSettings()
    const list = cur.custom[cur.set] ?? []
    await this.writeMoveSetSettings({ ...cur, custom: { ...cur.custom, [cur.set]: list.filter((c) => c.tag !== String(tag ?? '').toLowerCase().trim()) } })
    this.changed()
    return this.moveSet()
  }

  // Move-type tags for a request or a clip name under the active set.
  async tagsFor(text: string): Promise<string[]> {
    return setPromptTags(text, await this.moveSet())
  }

  // Re-tags the library with the active set: the cheap model reads names, notes and descriptions
  // when one is set up, else the keyword heuristic (name, file / request, notes). A clip that gets a
  // tag of the set loses other sets' built-in tags (custom tags, "example" and "video" stay); clips
  // nothing matches keep their tags.
  async retag(opts: { model?: boolean } = {}): Promise<AnimRetagResult> {
    const set = await this.moveSet()
    const all = await this.list()
    let found: Map<string, string[]> | null = null
    const cheap = opts.model === false ? null : this.model('cheap')
    if (cheap && all.length) {
      try {
        found = new Map()
        const known = set.tags.map((t) => t.tag)
        for (let i = 0; i < all.length; i += 30) {
          const batch = all.slice(i, i + 30)
          const lines = batch.map((e, n) => `${n + 1}. "${e.name}" (${e.origin ?? ''})${e.notes ? ` notes: ${e.notes.slice(0, 200)}` : ''} ${e.description.slice(0, 240)}`)
          const raw = await cheap(
            `You sort Roblox character animation clips into the move types of a ${set.name.toLowerCase()} game. Answer with JSON only.`,
            `Move types:\n${moveSetGuide(set)}\n\nClips:\n${lines.join('\n')}\n\nFor each clip give the move types that fit (only from the list; an empty list when none fits). JSON: [{"i":1,"tags":["${known[0]}"]}]`,
            []
          )
          const m = /\[[\s\S]*\]/.exec(raw)
          if (!m) throw new Error('no JSON in the answer')
          for (const row of JSON.parse(m[0]) as { i?: number; tags?: unknown }[]) {
            const e = batch[Number(row.i) - 1]
            if (e && Array.isArray(row.tags)) found.set(e.id, cleanTags(row.tags).filter((t) => known.includes(t)))
          }
        }
      } catch (e) {
        this.deps.log?.(`anim: model re-tag failed (${(e as Error).message}); using the keyword heuristic`, 'stderr')
        found = null
      }
    }
    const changes = found
      ? all
          .map((e) => {
            const words = setPromptTags(entryText(e), set)
            const after = mergeRetag(e.tags, [...new Set([...(found!.get(e.id) ?? []), ...words])], set)
            return { id: e.id, before: e.tags, after }
          })
          .filter((c) => c.after.join('|') !== c.before.join('|'))
      : heuristicRetag(all, set)
    for (const c of changes) {
      const hit = await this.find(c.id)
      if (hit) await hit.store.save({ ...hit.entry, tags: c.after })
    }
    if (changes.length) await this.relearn().catch(() => undefined)
    this.changed()
    return { set: set.id, source: found ? 'model' : 'heuristic', total: all.length, changed: changes.length, changes: changes.slice(0, 200) }
  }

  // Converts a clip between R15 and R6 (in place, or as a new entry with copy). R15 -> R6 loses the
  // waist / elbow / wrist / knee / ankle bends (RIG_CONVERT_WARNING); R6 -> R15 is lossless. Script
  // clips keep their script (it re-records on the new rig).
  async convert(id: string, to: RigType, opts: { copy?: boolean } = {}): Promise<{ entry: AnimEntry; warning: string }> {
    const hit = await this.find(id)
    if (!hit) throw new AnimError(`no animation "${id}"`)
    needClip(hit.entry)
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
    const tags = new Set([...(opts.tags ?? []), ...(await this.tagsFor(query))])
    const words = query.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length > 1)
    if (!words.length && !tags.size) return all.slice(0, opts.limit ?? 50)
    const scored = all
      .map((e) => ({ e, s: libraryScore(e, words, tags) }))
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
    const e = needClip(await this.get(id))
    const ctx = await this.qualityContext(e)
    return runChecks(e.clip, ctx.profile ?? null, { intent: ctx.intent })
  }

  // ------------------------------------------------------------ quality (intent, priors, calibration)

  // The nearest real clips of a request's move: imported clips of its move type first, then ones the
  // user liked; never "avoid" clips, video references or the clip itself.
  private realRefs(all: AnimEntry[], request: string, tags: string[], set: ResolvedMoveSet, rig: RigType, exclude?: string): AnimEntry[] {
    const cands = remixCandidates(all, `${request} ${tags.join(' ')}`, set, { rig, limit: 12, exclude })
    const byId = new Map(all.map((e) => [e.id, e]))
    const liked = (e: AnimEntry) => e.rating === 'up' || e.quality === 'good' || e.quality === 'reference'
    const real = cands.map((c) => byId.get(c.id)!).filter((e) => e && e.kind === 'imported')
    const good = cands.map((c) => byId.get(c.id)!).filter((e) => e && e.kind !== 'imported' && liked(e))
    return [...real, ...good].slice(0, 3)
  }

  // What a clip is judged by: the motion intent (lead limb from the request's words, else the nearest
  // real clips), the move type's profile with its learned priors, and the learned critic weight.
  // Imported clips are judged by their tags only (their own side is right by definition).
  async qualityContext(e: Pick<AnimEntry, 'id' | 'kind' | 'origin' | 'tags' | 'clip'> | { request: string; tags: string[]; rig: RigType; exclude?: string }): Promise<QualityContext & { refs: AnimEntry[]; tags: string[]; request: string }> {
    const generated = 'request' in e || e.kind === 'generated'
    const request = 'request' in e ? e.request : e.kind === 'generated' ? e.origin : ''
    const tags = e.tags
    const rig = 'request' in e ? e.rig : clipRig(e.clip)
    const exclude = 'request' in e ? e.exclude : e.id
    const refs = generated ? this.realRefs(await this.list(), request, tags, await this.moveSet(), rig, exclude) : []
    const intent: MotionIntent = motionIntent(request, tags, refs.map((r) => r.clip))
    return { intent, profile: profileFor(await this.style(), tags, rig), criticWeight: await this.criticWeight(), refs, tags, request }
  }

  private calibrationFile(): string {
    return join(this.deps.userDir, 'calibration.json')
  }

  private async readCalibration(): Promise<{ criticWeight: number; events: { at: number; kind: string; delta: number; entry: string }[] }> {
    try {
      const v = JSON.parse(await readFile(this.calibrationFile(), 'utf8')) as { criticWeight?: unknown; events?: unknown }
      return { criticWeight: clampCriticWeight(v.criticWeight), events: Array.isArray(v.events) ? (v.events as never[]).slice(-50) : [] }
    } catch {
      return { criticWeight: DEFAULT_CRITIC_WEIGHT, events: [] }
    }
  }

  // How much the critic's score counts against the code metrics when ranking rounds (0.25..0.75).
  async criticWeight(): Promise<number> {
    return (await this.readCalibration()).criticWeight
  }

  // Feedback learning: when the user's choice (a kept round, a rating) agrees with the code metrics
  // against the critic, the critic counts less next time, and the other way round.
  private async calibrate(kind: string, entry: string, delta: number): Promise<number> {
    const cur = await this.readCalibration()
    const next = clampCriticWeight(Math.round((cur.criticWeight + delta) * 1000) / 1000)
    if (next === cur.criticWeight) return next
    await mkdir(this.deps.userDir, { recursive: true })
    await writeFile(this.calibrationFile(), JSON.stringify({ criticWeight: next, events: [...cur.events, { at: this.now(), kind, delta, entry }].slice(-50) }, null, 2), 'utf8')
    return next
  }

  // "Use #n": the round's clip becomes the clip, and the choice teaches the critic weight when it
  // differs from the round the ranking picked.
  async useIteration(id: string, n: number): Promise<AnimEntry> {
    const hit = await this.find(id)
    if (!hit) throw new AnimError(`no animation "${id}"`)
    if (this.running.has(id)) throw new AnimError('this clip is being refined; cancel the refinement first')
    const its = hit.entry.iterations ?? []
    const chosen = its.find((it) => it.n === Number(n))
    if (!chosen) throw new AnimError(`no iteration #${n}`)
    const best = bestIteration(its)
    if (best && best !== chosen && chosen.score && best.score) {
      const c = chosen.score
      const b = best.score
      // The user overruled the ranking: whichever signal agreed with them gains weight.
      if (c.critic > b.critic && c.objective < b.objective) await this.calibrate('keep', id, 0.05)
      else if (c.objective > b.objective && c.critic < b.critic) await this.calibrate('keep', id, -0.05)
    }
    const saved = await this.update(id, { clip: chosen.clip })
    return saved
  }

  // ------------------------------------------------------------ contract (Ability Composer)

  async listAnimClips(): Promise<AnimClipRef[]> {
    return (await this.list())
      .filter((e) => e.quality !== 'avoid' && isClip(e))
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
    const set = await this.moveSet()
    for (const r of await this.readClips(files)) {
      if (r.error || !r.clips.length) {
        out.push({ file: r.file, name: basename(r.file), duration: 0, looped: false, markers: 0, suggestedTags: [], error: r.error ?? 'no KeyframeSequence in the file' })
        continue
      }
      for (const { clip } of r.clips) out.push({ file: r.file, name: clip.name, duration: clip.duration, looped: clip.looped, markers: clip.markers.length, suggestedTags: setAutoTags(clip, basename(r.file), set), rig: clipRig(clip) })
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
    const set = await this.moveSet()
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
          tags: given ?? setAutoTags(clip, basename(r.file), set),
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
    const set = await this.moveSet()
    const known = set.tags.map((t) => t.tag)
    const lines = entries.slice(0, 30).map((e, i) => `${i + 1}. "${e.name}" (file ${e.origin}): ${e.description} Suggested tags: ${e.tags.join(', ') || 'none'}.`)
    const guide = set.id === 'combat' && !set.custom.length ? `only from: ${known.join(', ')}` : `only from these ${set.name.toLowerCase()} move types:\n${moveSetGuide(set)}\n`
    const raw = await cheap(
      `You label imported Roblox R15 animation clips for an animation library${set.id === 'combat' ? '' : ` of ${set.name.toLowerCase()} moves`}. Answer with JSON only.`,
      `Clips:\n${lines.join('\n')}\n\nFor each clip give tags (${guide}) and one short style note (what makes its motion read: timing, weight, poses). JSON: [{"i":1,"tags":["${known[0]}"],"note":"..."}]`,
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
    return coverage((await this.list()).filter(isClip), coverageOptions(await this.moveSet()))
  }

  private async knownTags(): Promise<string[]> {
    return allKnownTags(await this.moveSetSettings())
  }

  // Style profiles from the whole library (pure stats), saved to style.json and as memory skills.
  async learn(): Promise<{ style: AnimStyle; saved: string[]; errors: string[] }> {
    const entries = await this.list()
    const style = buildStyle(entries, this.now(), await this.knownTags())
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
    await this.writeStyle(buildStyle(await this.list(), this.now(), await this.knownTags()))
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
    await this.recordPrinciples(saved, rating).catch((err) => this.deps.log?.(`anim: principle feedback: ${(err as Error).message}`, 'stderr'))
    if (rating) await this.calibrateFromRating(saved, rating).catch((err) => this.deps.log?.(`anim: calibration: ${(err as Error).message}`, 'stderr'))
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

  // A rating of a refined clip: when the critic and the code metrics disagreed about the round the
  // clip uses, the one the user agrees with gains weight.
  private async calibrateFromRating(e: AnimEntry, rating: 'up' | 'down'): Promise<void> {
    if (e.kind !== 'generated' || !e.iterations?.length) return
    const it = e.iterations.find((x) => JSON.stringify(x.clip.tracks) === JSON.stringify(e.clip.tracks)) ?? bestIteration(e.iterations)
    const s = it?.score
    if (!s) return
    const v = rating === 'up' ? 1 : -1
    const sc = Math.sign(s.critic - 6.5)
    const so = Math.sign(s.objective - 6.5)
    if (sc === v && so !== v) await this.calibrate(`rate-${rating}`, e.id, 0.04)
    else if (so === v && sc !== v) await this.calibrate(`rate-${rating}`, e.id, -0.04)
  }

  // Ratings teach the principle weights: the clip's per-principle scores (its last critique, else the
  // code checks) and the user's notes.
  private async recordPrinciples(e: AnimEntry, rating: 'up' | 'down' | null): Promise<void> {
    const p = this.deps.principles
    if (!p || !isClip(e)) return
    if (!rating) return void (await p.forget?.('anim', e.id))
    const last = e.iterations?.[e.iterations.length - 1]?.critique
    const ids = principleIds('anim', e.origin || e.description, { looped: e.clip.looped })
    const scores = scoresForRating(last?.principles, () => animPrincipleChecks(e.clip, runChecks(e.clip)).filter((c) => ids.includes(c.id)))
    await p.record({ lab: 'anim', entryId: e.id, name: e.name, rating, scores, ...(e.notes ? { notes: e.notes } : {}) })
  }

  private async principleWeights(): Promise<PrincipleWeights> {
    return (await this.deps.principles?.weights().catch(() => ({}))) ?? {}
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

  async recordScript(script: string, opts: { name?: string; patches?: AnimClip['patches']; rig?: RigType; request?: string; intent?: MotionIntent | null } = {}): Promise<AnimScriptResult> {
    const text = String(script ?? '')
    if (!text.trim()) return { ok: false, error: { message: 'the script is empty' }, prints: [], warnings: [], summary: '' }
    if (text.length > 60_000) return { ok: false, error: { message: 'the script is too long (60 KB max)' }, prints: [], warnings: [], summary: '' }
    const rec: AnimRecordResult = await luneAnimTimeline(text, { ...(await this.lunePaths()), run: this.deps.luneRun })
    const run = finishAnimRun(rec, text, { name: opts.name, learned: await this.learnedPoses(), patches: opts.patches, rig: await this.rigFor(opts.rig) })
    if (!run.ok || !run.clip) return { ok: false, ...(run.error ? { error: run.error } : {}), prints: run.prints, warnings: run.warnings, summary: '' }
    const tags = await this.tagsFor(run.clip.name)
    const checks = runChecks(run.clip, profileFor(await this.style(), tags, clipRig(run.clip)), opts.intent ? { intent: opts.intent } : { request: opts.request ?? '', tags })
    return { ok: true, prints: run.prints, warnings: run.warnings, summary: clipSummary(run.clip), clip: run.clip, checks }
  }

  // Saves a clip as a generated entry (new, or replacing an entry's clip) and writes it into the project.
  async saveClip(clip: AnimClip, opts: { id?: string; prompt?: string; description?: string; tags?: string[]; scope?: AnimScope; refId?: string; restatement?: Restatement; remix?: RemixOrigin } = {}): Promise<AnimEntry> {
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
      tags: opts.tags ? cleanTags(opts.tags) : prev?.entry.tags ?? cleanTags([...(await this.tagsFor(opts.prompt ?? clip.name)), ...setAutoTags(clip, '', await this.moveSet())]),
      notes: prev?.entry.notes ?? '',
      createdAt: prev?.entry.createdAt ?? now,
      updatedAt: now,
      origin: opts.prompt ?? prev?.entry.origin ?? clip.name,
      clip,
      thumbs: prev?.entry.thumbs ?? [],
      stats,
      ...(opts.refId ? { refId: opts.refId } : {}),
      ...(opts.restatement ? { restatement: opts.restatement } : {}),
      ...(opts.remix ? { remix: opts.remix } : {})
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
    if (hit) needClip(hit.entry)
    const rig = hit ? clipRig(hit.entry.clip) : await this.rigFor(opts.rig)
    const r = await this.recordScript(script, { name: hit?.entry.clip.name ?? animScriptName(script, opts.prompt ?? 'Animation'), rig, request: hit ? (hit.entry.kind === 'generated' ? hit.entry.origin : '') : opts.prompt })
    if (!r.ok || !opts.save || !r.clip) return r
    if (hit && this.running.has(hit.entry.id)) throw new AnimError('this clip is being refined; cancel the refinement first')
    const entry = await this.saveClip(r.clip, { id: hit?.entry.id, prompt: hit ? undefined : opts.prompt ?? r.clip.name })
    return { ...r, entry }
  }

  // Liked references with scripts for the request's tags (few-shot), never "avoid" clips.
  // Same-rig clips first (an R6 request learns from R6 references, then R15 ones).
  async references(tags: string[], text: string, exclude?: string, rig?: RigType): Promise<AnimEntry[]> {
    const hits = (await this.search(text, { tags, limit: 10 })).filter((e) => e.id !== exclude && isClip(e))
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
  // reference: the id of a video reference in this library; its beats, holds, vision summary (poses
  // per beat) and key frames go into the prompt, and the clip keeps it pinned (the critic scores the match).
  async compose(request: string, opts: AnimRefineOptions & { wait?: boolean; refine?: boolean; script?: string; scope?: AnimScope; rig?: RigType; reference?: string; restatement?: Restatement } = {}): Promise<AnimScriptResult & { refined?: Promise<unknown> }> {
    const restatement = normalizeRestatement(opts.restatement) ?? undefined
    const pinned = opts.reference ? await this.pinnedRef(opts.reference) : null
    const text = String(request ?? '').trim() || (pinned ? `a move like the reference video ${pinned.name}` : '')
    if (text.length < 3) throw new AnimError('Describe the move, e.g. "a heavy overhead punch with a long windup".')
    const rig = await this.rigFor(opts.rig)
    const set = await this.moveSet()
    const tags = setPromptTags(text, set)
    const style = await this.style()
    const profile = profileFor(style, tags, rig)
    let source: AnimScriptResult['source'] = 'draft'
    let result: AnimScriptResult | null = null
    let script = opts.script?.trim() ? opts.script : ''
    const writer = this.model('default')
    let modelError: string | undefined
    // The lead limb (words, else the nearest real clips) and those clips' keyframe digests.
    const qctx = await this.qualityContext({ request: text, tags, rig })
    const intent = qctx.intent ?? null
    if (!script && writer) {
      const all = await this.list()
      const refs = await this.references(tags, text, undefined, rig)
      const scripted = refs.find((e) => e.clip.script && clipRig(e.clip) === rig) ?? refs.find((e) => e.clip.script)
      const forRig = ANIM_EXAMPLES.filter((x) => (x.rig ?? 'R15') === rig)
      const ex = forRig.find((x) => archetypeFor(x.name + ' ' + x.tags.join(' ')) === archetypeFor(text, set)) ?? forRig[0] ?? ANIM_EXAMPLES[0]
      // Outside Combat (or for a custom move type), the move type's description tells the writer what the move is.
      const moveType = tags.length && (set.id !== 'combat' || set.tags.some((t) => t.custom && tags.includes(t.tag))) ? `Move type (${set.name}):\n${moveSetGuide(set, tags)}` : ''
      const avoid = this.avoidNotes(tags, all)
      const lines = [
        `Make: ${text}`,
        restatementBlock(restatement),
        `Rig: ${rig}${rig === 'R6' ? ' (start the script with a:rig("R6"); no waist, elbows, wrists, knees or ankles)' : ''}`,
        moveType,
        intentText(intent),
        profile ? profileText(profile) : 'No learned style for this move type yet: use strong anticipation, a fast action and a settling recovery.',
        qctx.refs.length ? [`The closest real clips of this move in the user's library (start from their timing and key poses; this is what the user wants it to look like):`, ...qctx.refs.slice(0, 2).map((e) => keyframeDigest(e.clip, { name: e.name, tags: e.tags })), DIGEST_NOTE].join('\n') : '',
        ...refs.filter((e) => e !== scripted).map((e) => `Library reference "${e.name}" (${e.tags.join(', ')}): ${e.description.slice(0, 300)}`),
        scripted ? `The user liked this related clip ("${scripted.origin}"); reuse what fits:\n\`\`\`lua\n${scripted.clip.script!.slice(0, 4000)}\n\`\`\`` : `An example script (${ex.name}):\n\`\`\`lua\n${ex.script}\`\`\``,
        avoid.length ? `The user marked these as bad; do not repeat them: ${avoid.join(' | ')}` : '',
        pinned ? pinned.compose : '',
        principlePlan('anim', text, { weights: await this.principleWeights() })
      ].filter(Boolean)
      try {
        const system = animComposeSystem(rig)
        const images = pinned?.images ?? []
        const prompt = lines.join('\n\n')
        const done = await composeWithGate({
          lab: 'anim',
          gate: this.deps.gate,
          ask: () => writer(system, prompt, images),
          check: async (raw): Promise<AttemptResult<{ s: string; r: AnimScriptResult }>> => {
            const s = extractAnimScript(raw)
            if (!s) return { ok: false, kind: 'no-script', message: 'no script in the answer' }
            const r = await this.recordScript(s, { name: animScriptName(s, text), rig, request: text, intent })
            if (r.ok) return { ok: true, value: { s, r } }
            const where = r.error?.line ? ` (line ${r.error.line}: ${s.split('\n')[r.error.line - 1]?.trim() ?? ''})` : ''
            return { ok: false, kind: 'script-error', message: `${r.error?.message ?? 'the script failed'}${where}` }
          },
          repair: (raw, message) => writer(system, `${prompt}\n\nYour script:\n\`\`\`lua\n${extractAnimScript(raw) ?? raw.slice(0, 4000)}\`\`\`\nfailed: ${message}\nFix it and answer with the whole corrected script.`, images),
          rephrase: () => writer(system, `${prompt}\n\n${rephraseNote('script')}`, images)
        })
        script = done.value.s
        result = done.value.r
        source = 'model'
      } catch (e) {
        this.deps.log?.(`anim: composed script unusable (${(e as Error).message}); using the built-in draft`, 'stderr')
        modelError = e instanceof ComposeGaveUp ? `the model's script did not run (${e.message})` : (e as Error).message
      }
    }
    if (!result) {
      if (!script) script = draftAnimScript(text, profile, rig, set)
      else source = 'model'
      result = await this.recordScript(script, { name: animScriptName(script, text), rig, request: text, intent })
      if (!result.ok && opts.script) return { ...result, source }
      if (!result.ok) throw new AnimError(`could not record the draft script: ${result.error?.message}`)
    }
    const refTags = pinned ? ((await this.find(pinned.id))?.entry.tags ?? []).filter((t) => t !== 'video') : []
    const entry = await this.saveClip(result.clip!, { prompt: text, tags: [...new Set([...tags, ...refTags, ...setAutoTags(result.clip!, '', set)])], scope: opts.scope, ...(pinned ? { refId: pinned.id } : {}), ...(restatement ? { restatement } : {}) })
    await this.ensureGuideSkill()
    const out: AnimScriptResult & { refined?: Promise<unknown> } = { ...result, entry, source, ...(source === 'draft' && modelError ? { modelError: `Drafted without a model because: ${modelError.replace(/\s+/g, ' ').trim().slice(0, 500)}` } : {}) }
    if (opts.refine !== false && this.deps.capture) {
      const refined = this.refine(entry.id, opts).catch((e) => this.deps.log?.(`anim: refine failed: ${(e as Error).message}`, 'stderr'))
      if (opts.wait) await refined
      out.refined = refined
    }
    return out
  }

  // ------------------------------------------------------------ remix (start from the closest clip)

  // "From scratch" / "Remix closest" for the Animate row, with the move set in settings.json.
  // auto: remix when the library has a usable clip of the request's move type.
  async remixMode(): Promise<AnimRemixMode> {
    const v = ((await this.readSettings()).remix as { mode?: unknown } | undefined)?.mode
    return v === 'remix' || v === 'scratch' ? v : 'auto'
  }

  async setRemixMode(mode: AnimRemixMode): Promise<AnimRemixMode> {
    const m: AnimRemixMode = mode === 'remix' || mode === 'scratch' ? mode : 'auto'
    const f = this.settingsFile()
    const prev = await this.readSettings()
    await mkdir(join(f, '..'), { recursive: true })
    await writeFile(f, JSON.stringify({ ...prev, remix: { ...((prev.remix as object) ?? {}), mode: m } }, null, 2) + '\n', 'utf8')
    return m
  }

  // Library clips to start from for a request, best first (reference scoring; no avoid, no video refs).
  async remixCandidates(prompt: string, opts: { rig?: RigType; limit?: number; exclude?: string } = {}): Promise<{ candidates: RemixCandidate[]; tags: string[] }> {
    const set = await this.moveSet()
    const rig = await this.rigFor(opts.rig)
    return { candidates: remixCandidates(await this.list(), String(prompt ?? ''), set, { rig, limit: opts.limit ?? 8, exclude: opts.exclude }), tags: setPromptTags(String(prompt ?? ''), set) }
  }

  private async clipLookup(): Promise<(id: string) => AnimClip | null> {
    const all = await this.list()
    return (id) => {
      const e = all.find((x) => x.id === id)
      return e && isClip(e) ? e.clip : null
    }
  }

  // Plans the edit ops for a request on a base clip: the default tier (validated JSON plan), else the
  // keyword heuristic. With current ops and a critique it re-plans the params (refinement).
  async planRemix(request: string, base: AnimEntry, others: AnimEntry[], ctx: { current?: RemixOp[]; critique?: AnimCritique | null } = {}): Promise<{ ops: RemixOp[]; source: 'model' | 'heuristic'; rejected: { op: unknown; reason: string }[] }> {
    const writer = this.model('default')
    const ids = others.map((o) => o.id)
    if (writer) {
      try {
        const prompt = remixPlanPrompt({
          request,
          base: { id: base.id, name: base.name, tags: base.tags, description: base.description, clip: base.clip },
          others: others.map((o) => ({ id: o.id, name: o.name, tags: o.tags, description: o.description, duration: o.clip.duration })),
          side: dominantSide(base.clip),
          intent: intentText(motionIntent(request, base.tags, [base.clip])),
          ...(ctx.current ? { current: ctx.current } : {}),
          ...(ctx.critique ? { critique: ctx.critique } : {})
        })
        const plan = parseRemixPlan(await writer(REMIX_SYSTEM, prompt, []), { clips: ids })
        if (plan.rejected.length) this.deps.log?.(`anim: remix plan: dropped ${plan.rejected.map((r) => r.reason).join('; ')}`, 'stderr')
        return { ops: plan.ops, source: 'model', rejected: plan.rejected }
      } catch (e) {
        this.deps.log?.(`anim: remix plan unusable (${(e as Error).message}); using the keyword heuristic`, 'stderr')
      }
    }
    if (ctx.current && ctx.critique) return { ops: adjustRemixOps(ctx.current, ctx.critique, base.clip) ?? ctx.current, source: 'heuristic', rejected: [] }
    return { ops: heuristicRemixPlan(request, base.clip), source: 'heuristic', rejected: [] }
  }

  // Request -> a clip edited from the closest library clip (or opts.base): plan ops (model or
  // heuristic), apply them, save as a generated entry (tags from the base + request) with its origin
  // (base id + ops), then refine like compose (the critic tunes op params, not keys).
  async remix(request: string, opts: AnimRemixOptions & { wait?: boolean } = {}): Promise<AnimScriptResult & { refined?: Promise<unknown> }> {
    const restatement = normalizeRestatement(opts.restatement) ?? undefined
    const text = String(request ?? '').trim()
    const rig = await this.rigFor(opts.rig)
    const set = await this.moveSet()
    const all = await this.list()
    let base: AnimEntry | undefined
    if (opts.base) {
      base = all.find((e) => e.id === opts.base)
      if (!base) throw new AnimError(`no animation "${opts.base}" to remix`)
      needClip(base)
    } else {
      const top = remixCandidates(all, text, set, { rig, limit: 1 })[0]
      if (!top) throw new AnimError(`No usable library clip matches "${text}". Import a reference clip of this move type, pick a base clip, or switch to From scratch.`)
      base = all.find((e) => e.id === top.id)!
    }
    if (text.length < 2 && !opts.ops) throw new AnimError('Describe the change, e.g. "faster, with the left foot".')
    const others = remixCandidates(all, `${text} ${base.tags.join(' ')}`, set, { rig, limit: 5, exclude: base.id })
      .map((c) => all.find((e) => e.id === c.id)!)
      .filter(Boolean)
    const planned = opts.ops ? { ...normalizeRemixPlan(opts.ops, {}), source: 'user' as const } : await this.planRemix(text, base, others)
    const lookup = await this.clipLookup()
    const r = applyRemix(base.clip, planned.ops, lookup)
    const ops = r.applied
    const named = animScriptName('', text || `${base.name} remix`)
    const clip: AnimClip = { ...(clipRig(r.clip) === rig ? r.clip : convertClip(r.clip, rig)), name: named === 'Animation' ? `${base.clip.name}Remix`.slice(0, 40) : named }
    const names: Record<string, string> = {}
    for (const o of ops) if (o.op === 'blend' || o.op === 'transplant') names[o.clip] = all.find((e) => e.id === o.clip)?.name ?? o.clip
    const origin: RemixOrigin = { base: base.id, baseName: base.name, ops, source: planned.source, ...(Object.keys(names).length ? { clips: names } : {}) }
    const tags = [...new Set([...base.tags.filter((t) => t !== 'example' && t !== 'video'), ...setPromptTags(text, set)])]
    const description = `${text || 'Remix'}. Remix of "${base.name}"${ops.length ? `: ${ops.map((o) => describeRemixOp(o, names)).join('; ')}` : ' (unchanged)'}. ${describeClip(clip)}`.slice(0, 600)
    const entry = await this.saveClip(clip, { prompt: text || `remix of ${base.name}`, description, tags, scope: opts.scope, remix: origin, ...(restatement ? { restatement } : {}) })
    const qctx = await this.qualityContext(entry)
    const checks = runChecks(clip, qctx.profile ?? null, { intent: qctx.intent })
    const warnings = [...planned.rejected.map((x) => `plan: ${x.reason}`), ...r.skipped.map((x) => `${x.op.op}: ${x.reason}`)]
    const out: AnimScriptResult & { refined?: Promise<unknown> } = { ok: true, prints: [], warnings, summary: clipSummary(clip), clip, checks, entry, source: 'remix' }
    if (opts.refine !== false && this.deps.capture) {
      const refined = this.refine(entry.id, opts).catch((e) => this.deps.log?.(`anim: refine failed: ${(e as Error).message}`, 'stderr'))
      if (opts.wait) await refined
      out.refined = refined
    }
    return out
  }

  // Re-applies (edited) ops to a remixed entry's base clip, or to a different base clip.
  async remixApply(id: string, ops: unknown, opts: { base?: string } = {}): Promise<AnimEntry> {
    const hit = await this.find(id)
    if (!hit) throw new AnimError(`no animation "${id}"`)
    needClip(hit.entry)
    if (this.running.has(id)) throw new AnimError('this clip is being refined; cancel the refinement first')
    const baseId = opts.base ?? hit.entry.remix?.base
    if (!baseId) throw new AnimError(`"${hit.entry.name}" is not a remix; pick a base clip to start from`)
    if (baseId === id) throw new AnimError('a clip cannot be its own base')
    const all = await this.list()
    const base = all.find((e) => e.id === baseId)
    if (!base) throw new AnimError(`the base clip "${hit.entry.remix?.baseName ?? baseId}" is no longer in the library`)
    needClip(base)
    const plan = normalizeRemixPlan(Array.isArray(ops) ? ops : [], { clips: all.filter((e) => isClip(e) && e.id !== id).map((e) => e.id) })
    if (plan.rejected.length) throw new AnimError(`invalid op: ${plan.rejected[0].reason}`)
    const r = applyRemix(base.clip, plan.ops, await this.clipLookup())
    const rig = clipRig(hit.entry.clip)
    const clip: AnimClip = { ...(clipRig(r.clip) === rig ? r.clip : convertClip(r.clip, rig)), name: hit.entry.clip.name }
    const names: Record<string, string> = {}
    for (const o of r.applied) if (o.op === 'blend' || o.op === 'transplant') names[o.clip] = all.find((e) => e.id === o.clip)?.name ?? o.clip
    const remix: RemixOrigin = { base: base.id, baseName: base.name, ops: r.applied, source: 'user', ...(Object.keys(names).length ? { clips: names } : {}) }
    let saved = await hit.store.save({ ...hit.entry, clip, stats: measureClip(clip), remix, updatedAt: this.now() })
    if (saved.written && this.deps.projectRoot()) saved = await this.writeProjectFiles(saved).catch(() => saved)
    this.changed()
    return saved
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

  // A video reference in this library ("make it like this"): prompt block, critic block, key frames.
  async pinnedRef(id: string): Promise<PinnedRef> {
    const hit = await this.find(String(id ?? ''))
    if (!hit) throw new AnimError(`no video reference "${id}" in the Animation Lab library`)
    return loadPinnedRef(hit.entry, (f) => hit.store.readFile(hit.entry.id, f))
  }

  private withMatch(c: AnimCritique, clip: AnimClip, pinned: PinnedRef, raw?: string): AnimCritique {
    const fromCritic = raw ? parseMatch(raw) : null
    const numeric = animNumericMatch(clip, pinned.video)
    const match = fromCritic?.match ?? numeric.match
    return { ...c, overall: blendMatch(c.overall, match), match, matchNotes: fromCritic?.notes ?? numeric.notes }
  }

  // ctx: the refinement's quality context (computed once per run); best: the best round so far.
  async critique(entry: AnimEntry, clip: AnimClip, frames: Buffer[], times: number[], iteration: number, previous: AnimCritique | null, ctxIn?: Awaited<ReturnType<AnimService['qualityContext']>>, best?: { n: number; score: AnimIterationScore; critique: AnimCritique } | null): Promise<AnimCritique> {
    const ctx = ctxIn ?? (await this.qualityContext(entry))
    const rig = clipRig(clip)
    const profile: AnimStyleProfile | null = ctx.profile ?? null
    const checks = runChecks(clip, profile, { intent: ctx.intent })
    const set = await this.moveSet()
    const typed = entry.tags.filter((t) => set.tags.some((d) => d.tag === t))
    const refs = await this.references(entry.tags, entry.origin, entry.id, rig)
    const refNames = refs.map((r) => r.name)
    const pinned = entry.refId ? await this.pinnedRef(entry.refId).catch(() => null) : null
    const critic = this.model('critic')
    const weights = await this.principleWeights()
    const request = criticBrief(entry.origin || entry.description, entry.restatement)
    const principled = (c: AnimCritique, raw?: string) => withAnimPrinciples(c, clip, { request, raw, weights, checks })
    // The must-fix cap goes on last, after the principle and reference blending.
    const done = (c: AnimCritique) => withMustFix(c)
    if (!critic || !frames.length) {
      const c = principled(heuristicAnimCritique(clip, checks, profile, refNames))
      return done(pinned ? this.withMatch(c, clip, pinned) : c)
    }
    const moveType = typed.length && (set.id !== 'combat' || set.tags.some((t) => t.custom && typed.includes(t.tag))) ? `\nMove type (${set.name}):\n${moveSetGuide(set, typed)}` : ''
    const bestNote = best ? { n: best.n, quality: best.score.quality, critic: best.score.critic, summary: best.critique.summary } : null
    const prompt = `${animCritiquePrompt({ request: criticBrief(entry.origin, entry.restatement) + moveType, clip, frameTimes: times, checks, profile, references: refs.map((r) => ({ name: r.name, description: r.description })), iteration, previous, intent: ctx.intent, best: bestNote })}\n\n${animCriticPrinciples(clip, request, { weights, focus: previous?.focus, checks })}`
    // Pinned reference: its key frames follow the rendered frames (compared side by side).
    const images = [...frames.map((f) => ({ mime: 'image/png', base64: f.toString('base64') })), ...(pinned?.images ?? [])]
    try {
      const raw = await critic(pinned ? `${animCriticSystem(rig)}\n${REF_MATCH_TEXT}` : animCriticSystem(rig), prompt + studioFramesNote(frames) + (pinned ? `\n\n${pinned.critique}` : ''), images)
      const c = principled(parseAnimCritique(raw, checks, refNames), raw)
      return done(pinned ? this.withMatch(c, clip, pinned, raw) : c)
    } catch (e) {
      this.deps.log?.(`anim: vision critique unavailable (${(e as Error).message}); using the numbers-only check`, 'stderr')
      const h = heuristicAnimCritique(clip, checks, profile, refNames)
      const why = (e as Error).message.replace(/\s+/g, ' ').trim().slice(0, 300)
      const c = principled({ ...h, summary: h.summary.replace(/^Numbers-only check \(no vision model\)/, `Numbers-only check (the vision model call failed: ${why})`) })
      return done(pinned ? this.withMatch(c, clip, pinned) : c)
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

  // Remixed entries refine by re-planning their op params from each critique and re-applying them to
  // the base clip (never by editing keys). Null when the entry is not a remix or its base is gone.
  private async remixAdjuster(entry: AnimEntry): Promise<{ adjust: (clip: AnimClip, critique: AnimCritique) => Promise<{ clip: AnimClip; applied: number }>; opsOf: (clip: AnimClip) => RemixOp[] | undefined } | null> {
    if (!entry.remix) return null
    const all = await this.list()
    const base = all.find((e) => e.id === entry.remix!.base && isClip(e))
    if (!base) return null
    const lookup = await this.clipLookup()
    const others = all.filter((e) => isClip(e) && usable(e) && e.id !== entry.id && e.id !== base.id && e.tags.some((t) => base.tags.includes(t))).slice(0, 5)
    const rig = clipRig(entry.clip)
    const ops = new WeakMap<AnimClip, RemixOp[]>()
    ops.set(entry.clip, entry.remix.ops)
    const request = entry.origin
    return {
      opsOf: (clip) => ops.get(clip),
      adjust: async (clip, critique) => {
        const current = ops.get(clip) ?? entry.remix!.ops
        const plan = await this.planRemix(request, base, others, { current, critique })
        if (JSON.stringify(plan.ops) === JSON.stringify(current)) return { clip, applied: 0 }
        const r = applyRemix(base.clip, plan.ops, lookup)
        const next: AnimClip = { ...(clipRig(r.clip) === rig ? r.clip : convertClip(r.clip, rig)), name: clip.name }
        ops.set(next, r.applied)
        return { clip: next, applied: Math.max(1, r.applied.length) }
      }
    }
  }

  // Render the key beats -> critique (critic tier, or the numbers) -> apply changes, until the score
  // passes the threshold. Without a renderer the numbers-only critic still runs (no frames).
  async refine(id: string, opts: AnimRefineOptions = {}): Promise<{ entry: AnimEntry; stop: string; score: number }> {
    const hit = await this.find(id)
    if (!hit) throw new AnimError(`no animation "${id}"`)
    needClip(hit.entry)
    if (this.running.has(id)) throw new AnimError('already refining this clip')
    const token = { cancelled: false }
    this.running.set(id, token)
    const base = hit.entry.iterations?.length ?? 0
    const reference = await this.referenceClip(hit.entry)
    const pngs = new Map<number, Buffer[]>()
    const threshold = opts.threshold ?? ANIM_DEFAULT_THRESHOLD
    const maxIt = Math.max(1, Math.min(10, Math.floor(opts.maxIterations ?? ANIM_DEFAULT_MAX_ITERATIONS)))
    const stopAfter = new Map<number, boolean>()
    const remixer = await this.remixAdjuster(hit.entry)
    const ctx = await this.qualityContext(hit.entry)
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
          critique: async (clip, _files, times, n, previous, best) => {
            this.progress({ entryId: id, iteration: base + n, phase: 'critique' })
            const gate = this.deps.gate
            const g = gate && pngs.get(n)?.length ? await gate.beforeCritique({ lab: 'anim', entryId: id, iteration: base + n, frames: pngs.get(n) ?? [], previousScore: previous?.overall ?? null, changes: previous?.changes.length ?? 0, threshold }) : null
            if (g?.skip && previous) return skippedCritique(previous, g.reason)
            const current = (await hit.store.read(id)) ?? hit.entry
            const c = await this.critique(current, clip, pngs.get(n) ?? [], times, base + n, previous, ctx, best ? { n: base + best.n, score: best.score, critique: best.critique } : null)
            if (gate) stopAfter.set(n, (await gate.afterCritique({ lab: 'anim', entryId: id, iteration: base + n, score: c.overall, threshold, remaining: maxIt - n, changes: c.changes.length, summary: c.summary })).stop)
            return c
          },
          shouldStop: async (_c, n) => stopAfter.get(n) ?? false,
          ...(remixer ? { adjust: remixer.adjust } : {}),
          // Every round is ranked on the critic and the code metrics; the critic's edits are guarded.
          score: (clip, c) => iterationScore(c, clip, ctx),
          apply: (clip, changes) => guardedApply(clip, changes, ctx),
          onIteration: async (it, best) => {
            const current = (await hit.store.read(id)) ?? hit.entry
            const ops = remixer?.opsOf(it.clip)
            const iteration: AnimIteration = { n: base + it.n, at: this.now(), clip: it.clip, frames: it.frames, times: it.times, critique: it.critique, score: it.score, ...(it.rejected.length ? { guarded: it.rejected.slice(0, 8) } : {}), ...(ops ? { ops } : {}) }
            // Keep the best round even when it is older than the last eight.
            const all = [...(current.iterations ?? []), iteration]
            const top = bestIteration(all)
            const kept = all.slice(-8)
            const iterations = top && !kept.includes(top) ? [top, ...all.slice(-7)] : kept
            // The best round so far is the clip (the preview and the default), never the last one.
            const bestOps = remixer?.opsOf(best.clip)
            await hit.store.save({ ...current, iterations, clip: best.clip, stats: measureClip(best.clip), ...(bestOps && current.remix ? { remix: { ...current.remix, ops: bestOps } } : {}), updatedAt: this.now() })
            this.progress({ entryId: id, iteration: base + it.n, phase: 'adjust', score: it.score.quality, message: `${it.score.accepted ? '' : `Not kept (${it.score.regressed}); continuing from #${base + best.n}. `}${it.critique.summary}`, best: { n: base + best.n, quality: best.score.quality } })
            this.changed()
          },
          cancelled: () => token.cancelled
        },
        { maxIterations: opts.maxIterations ?? ANIM_DEFAULT_MAX_ITERATIONS, threshold: opts.threshold ?? ANIM_DEFAULT_THRESHOLD }
      )
      const current = (await hit.store.read(id)) ?? hit.entry
      const bestFrames = result.best.frames
      const bestOps = remixer?.opsOf(result.best.clip)
      let entry = await hit.store.save({
        ...current,
        ...(bestOps && current.remix ? { remix: { ...current.remix, ops: bestOps, source: JSON.stringify(bestOps) === JSON.stringify(hit.entry.remix?.ops) ? hit.entry.remix?.source ?? current.remix.source : 'critic' } } : {}),
        clip: result.best.clip,
        stats: measureClip(result.best.clip),
        thumbs: bestFrames.length ? [bestFrames[Math.min(bestFrames.length - 1, 2)], ...current.thumbs.filter((t) => !t.startsWith('frames/'))].slice(0, 6) : current.thumbs,
        updatedAt: this.now()
      })
      if (entry.written) entry = await this.writeProjectFiles(entry)
      this.progress({ entryId: id, iteration: base + result.iterations.length, phase: 'done', score: result.best.score.quality, message: `stopped: ${result.stop}; using #${base + result.best.n} (the best round)`, best: { n: base + result.best.n, quality: result.best.score.quality } })
      this.changed()
      return { entry, stop: result.stop, score: result.best.critique.overall }
    } catch (e) {
      this.progress({ entryId: id, iteration: base, phase: 'error', message: (e as Error).message })
      throw e
    } finally {
      this.running.delete(id)
      this.deps.gate?.endRun('anim', id)
    }
  }

  // ------------------------------------------------------------ export + upload

  // src/shared/Animations/<Name>/init.luau + Sequence.rbxmx (Rojo: a ModuleScript with the
  // KeyframeSequence as its child "Sequence").
  async writeProjectFiles(entry: AnimEntry): Promise<AnimEntry> {
    const root = this.deps.projectRoot()
    if (!root) throw new AnimError('Open the game project first: export writes into src/shared/Animations.')
    needClip(entry)
    const name = animModuleName(entry.clip.name || entry.name)
    let dir = entry.written ? entry.written.module.replace(/\/init\.luau$/, '') : `${ANIM_SRC_DIR}/${name}`
    if (!entry.written) for (let i = 2; await exists(join(root, dir)); i++) dir = `${ANIM_SRC_DIR}/${name}${i}`
    const abs = resolve(root, dir)
    if (!abs.startsWith(resolve(root) + sep)) throw new AnimError('animation path escapes the project')
    await mkdir(abs, { recursive: true })
    for (const f of this.exportFiles(entry, dir)) await writeFile(join(root, ...f.path.split('/')), f.content, 'utf8')
    return this.markWritten(entry, dir)
  }

  // The files a clip writes when it lives in `dir` (repo-relative): a ModuleScript (AnimationId as
  // rbxassetid:// once uploaded) with the KeyframeSequence as its child "Sequence". One exporter for
  // writeProjectFiles and "Add to game".
  exportFiles(entry: AnimEntry, dir: string): { path: string; content: string; role: string }[] {
    needClip(entry)
    return [
      { path: `${dir}/init.luau`, content: animLuauModule(entry.clip, { description: entry.description.slice(0, 300), assetId: entry.roblox?.assetId }), role: 'animation module' },
      { path: `${dir}/${ANIM_SEQUENCE_FILE}`, content: writeKeyframeSequenceXml(entry.clip), role: 'KeyframeSequence' }
    ]
  }

  // Records where a clip lives in the project (later edits and uploads write back there).
  async markWritten(entry: AnimEntry, dir: string): Promise<AnimEntry> {
    const written = { module: `${dir}/init.luau`, model: `${dir}/${ANIM_SEQUENCE_FILE}` }
    if (entry.written?.module === written.module) return entry
    const hit = await this.find(entry.id)
    return (hit?.store ?? this.user).save({ ...entry, written })
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
    needClip(hit.entry)
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
