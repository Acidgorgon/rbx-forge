// Ability Composer service: the ability library (user + project), compose (request -> VFX + clip +
// timings), timing / vision critique at the key beats, ratings feeding memory, and the game export
// (client Luau module + AbilityRunner). No electron imports: rendering, the model, the VFX Lab, the
// Animation Lab and the tool registry come in as functions.

import { studioFramesNote } from '../../../shared/studio/frames.ts'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import type { AnimClipRef } from '../../../shared/anim/types.ts'
import { applyChanges, applyTimingFixes, ABILITY_CRITIC_SYSTEM, critiquePrompt, keyBeats, parseVisionCritique, summarize, timingChecks, timingScore, type CritiqueContext } from '../../../shared/ability/critique.ts'
import { draftAbility, type DraftVfx } from '../../../shared/ability/draft.ts'
import { ABILITY_EXAMPLES, findAbilityExample } from '../../../shared/ability/examples.ts'
import { ABILITY_GUIDE } from '../../../shared/ability/guide.ts'
import { abilityModule, isOwnRunner, runnerModule, RUNNER_MODULE } from '../../../shared/ability/luau.ts'
import { AbilityError, applyPatch, normalizeAbility, validateAbility } from '../../../shared/ability/model.ts'
import { isPlaceholder, placeholderClips } from '../../../shared/ability/placeholder.ts'
import { timelineText } from '../../../shared/ability/timing.ts'
import type { Ability, AbilityComposeResult, AbilityCritique, AbilityEntry, AbilityExportResult, AbilityScope, AbilityStatus } from '../../../shared/ability/types.ts'
import { prop } from '../../../shared/vfx/schema.ts'
import { evalColorSequence } from '../../../shared/vfx/sequence.ts'
import type { ColorSequence, Rgb, VfxEffect, VfxEntry } from '../../../shared/vfx/types.ts'
import { instancePathFor, requireExpression } from '../blink.ts'
import { abilityId, AbilityStore, PROJECT_ABILITY_DIR } from './store.ts'
import { abilityCriticPrinciples, principleIds, scoresForRating, withAbilityPrinciples } from '../../../shared/principles/attach.ts'
import { abilityPrincipleChecks } from '../../../shared/principles/abilityChecks.ts'
import { parsePlanObject, principlePlan } from '../../../shared/principles/select.ts'
import type { PrincipleHooks, PrincipleWeights } from '../../../shared/principles/types.ts'

export interface ImagePayload {
  mime: string
  base64: string
}
export type ModelFn = (system: string, prompt: string, images: ImagePayload[]) => Promise<string>
export type { LabTier } from '../../../shared/labModels.ts'
import type { LabTier } from '../../../shared/labModels.ts'
import { criticBrief, restatementBlock } from '../../../shared/restate/prompt.ts'
import { normalizeRestatement, type Restatement } from '../../../shared/restate/types.ts'

export interface MemoryLike {
  remember(input: { scope: 'user' | 'project'; kind?: 'memory' | 'skill'; type?: 'user' | 'project' | 'feedback' | 'reference'; name: string; description: string; body: string }, source?: 'agent' | 'reflection' | 'style' | 'user'): Promise<{ entry: { name: string } }>
}

// The VFX Lab, as far as the composer needs it.
export interface VfxLabLike {
  get(id: string): Promise<VfxEntry>
  list(): Promise<VfxEntry[]>
  search(query: string, opts?: { limit?: number }): Promise<VfxEntry[]>
  addExample(key: string): Promise<VfxEntry>
  writeProjectFiles(entry: VfxEntry): Promise<VfxEntry>
}

export interface RegistryTool {
  name: string
  handler: (args: any, extra: unknown) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>
}

export interface AbilityCaptureRequest {
  ability: Ability
  effects: Record<string, VfxEffect>
  times: number[]
  width: number
  height: number
}

export interface AbilityServiceDeps {
  // userData/abilities (the user library is <userDir>/library).
  userDir: string
  projectRoot: () => string | null
  vfx?: VfxLabLike
  // Animation Lab clips (listAnimClips), when the lab is there.
  anim?: () => Promise<AnimClipRef[]>
  // Every agent tool (vfx_compose / anim_compose are used when present).
  tools?: () => RegistryTool[]
  model?: (tier: LabTier) => ModelFn | null
  capture?: (req: AbilityCaptureRequest) => Promise<Buffer[]>
  memory?: MemoryLike
  lune?: () => Promise<boolean>
  emit?: (event: 'ability:changed', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  now?: () => number
  // Principle priorities: the user's learned weights (critique, compose plan) and the rating log.
  principles?: PrincipleHooks
}

export class AbilityServiceError extends Error {}

const FRAME_SIZE = { width: 512, height: 384 }
const AUDIO_MIME: Record<string, string> = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4' }

export const COMPOSE_SYSTEM = `You time Roblox abilities ("moves") for the RBX Forge Ability Composer. You get a drafted move as JSON (an animation clip with markers, VFX attached to body parts of the clip's rig (R15, or R6 Torso / "Right Arm"... when animation.rig is "R6"), screen effects, camera shake, hit-stop and root movement), its resolved timeline and the timing checks.
Improve the timing and feel for the request. Answer with JSON only: {"events":[{"id":"existing or new id","kind":"vfx|screen|shake|hitstop|move","at":{"marker":"release","at":0},...fields}],"remove":["ids"],"duration":seconds}. Keep event ids you edit; only include fields you change. Never invent VFX entry ids or sound asset ids.

${ABILITY_GUIDE}`

// The first id in a tool's text answer ("<id>: Name ..." or "id": "...").
export function idFromToolText(text: string): string | null {
  const json = /"id"\s*:\s*"([A-Za-z0-9:_-]{3,100})"/.exec(text)
  if (json) return json[1]
  const line = /^\s*([a-z0-9][a-z0-9:_-]{2,100}):\s/m.exec(text)
  return line ? line[1] : null
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !['the', 'and', 'with', 'that', 'move', 'ability', 'make', 'skill'].includes(w))
}

function effectColor(effect: VfxEffect | undefined): Rgb[] {
  if (!effect) return []
  const out: Rgb[] = []
  const walk = (n: VfxEffect['roots'][number]) => {
    if (n.className === 'ParticleEmitter' || n.className === 'Beam' || n.className === 'Trail') {
      const c = evalColorSequence(prop<ColorSequence>(n, 'Color'), 0)
      if (c && c.some((x) => x < 0.97)) out.push(c)
    }
    n.children.forEach(walk)
  }
  effect.roots.forEach(walk)
  return out.slice(0, 3)
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false
  )
}

export class AbilityService {
  readonly user: AbilityStore
  private deps: AbilityServiceDeps
  private projectStore: { root: string; store: AbilityStore } | null = null
  private now: () => number
  private guideSaved = false

  constructor(deps: AbilityServiceDeps) {
    this.deps = deps
    this.user = new AbilityStore('user', join(deps.userDir, 'library'))
    this.now = deps.now ?? Date.now
  }

  get userLibraryDir(): string {
    return this.user.dir
  }

  project(): AbilityStore | null {
    const root = this.deps.projectRoot()
    if (!root) return null
    if (this.projectStore?.root !== root) this.projectStore = { root, store: new AbilityStore('project', join(root, ...PROJECT_ABILITY_DIR.split('/'), 'library')) }
    return this.projectStore.store
  }

  private changed(): void {
    this.deps.emit?.('ability:changed', { at: this.now() })
  }

  // ------------------------------------------------------------ library

  async list(): Promise<AbilityEntry[]> {
    const p = this.project()
    return [...(p ? await p.list() : []), ...(await this.user.list())]
  }

  async find(id: string): Promise<{ entry: AbilityEntry; store: AbilityStore } | null> {
    for (const s of [this.project(), this.user]) {
      if (!s) continue
      const e = await s.read(id).catch(() => null)
      if (e) return { entry: e, store: s }
    }
    return null
  }

  async get(id: string): Promise<AbilityEntry> {
    const hit = await this.find(String(id))
    if (!hit) throw new AbilityServiceError(`no ability "${id}"`)
    return hit.entry
  }

  async exportDir(): Promise<string | null> {
    const root = this.deps.projectRoot()
    if (!root) return null
    return (await exists(join(root, 'src', 'skills', 'Client'))) ? 'src/skills/Client/Abilities' : 'src/shared/Abilities'
  }

  async status(): Promise<AbilityStatus> {
    const p = this.project()
    return {
      projectRoot: this.deps.projectRoot(),
      vision: !!this.deps.model?.('critic'),
      render: !!this.deps.capture,
      lune: (await this.deps.lune?.().catch(() => false)) ?? false,
      entries: { user: (await this.user.list()).length, project: p ? (await p.list()).length : 0 },
      exportDir: await this.exportDir(),
      soundGeneration: false
    }
  }

  // Saves an ability (new, or replacing `id`). New entries go to the project library when a project is open.
  async save(raw: unknown, opts: { id?: string; origin?: string; scope?: AbilityScope; restatement?: Restatement } = {}): Promise<AbilityEntry> {
    const ability = normalizeAbility(raw)
    const prev = opts.id ? await this.find(opts.id) : null
    if (opts.id && !prev) throw new AbilityServiceError(`no ability "${opts.id}"`)
    const store = prev?.store ?? (opts.scope === 'user' ? this.user : (this.project() ?? this.user))
    const now = this.now()
    const entry: AbilityEntry = {
      ...(prev?.entry ?? { createdAt: now, thumbs: [], origin: opts.origin ?? 'manual' }),
      id: prev?.entry.id ?? abilityId(ability.name),
      scope: store.scope,
      name: ability.name,
      description: ability.description ?? prev?.entry.description ?? '',
      tags: ability.tags ?? prev?.entry.tags ?? [],
      updatedAt: now,
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.restatement ? { restatement: opts.restatement } : {}),
      ability
    } as AbilityEntry
    const saved = await store.save(entry)
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

  async file(id: string, file: string): Promise<string | null> {
    const hit = await this.find(id)
    if (!hit) return null
    const bytes = await hit.store.readFile(id, file).catch(() => null)
    return bytes ? `data:image/png;base64,${bytes.toString('base64')}` : null
  }

  async saveThumb(id: string, dataUrl: string): Promise<AbilityEntry> {
    const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl))
    if (!m) throw new AbilityServiceError('expected a PNG data URL')
    const hit = await this.find(id)
    if (!hit) throw new AbilityServiceError(`no ability "${id}"`)
    const bytes = Buffer.from(m[1], 'base64')
    if (bytes.length > 4 * 1024 * 1024) throw new AbilityServiceError('thumbnail too large')
    await hit.store.writeFile(id, 'thumbs/preview.png', bytes)
    const e = await hit.store.save({ ...hit.entry, thumbs: ['thumbs/preview.png', ...hit.entry.thumbs.filter((t) => t !== 'thumbs/preview.png')].slice(0, 4) })
    this.changed()
    return e
  }

  // A local audio file as a data URL for the preview (Roblox asset audio cannot be fetched without auth).
  async soundUrl(path: string): Promise<string | null> {
    const root = this.deps.projectRoot()
    const abs = resolve(root ?? '', String(path ?? ''))
    const mime = AUDIO_MIME[extname(abs).toLowerCase()]
    if (!mime) return null
    const s = await stat(abs).catch(() => null)
    if (!s?.isFile() || s.size > 12 * 1024 * 1024) return null
    return `data:${mime};base64,${(await readFile(abs)).toString('base64')}`
  }

  // ------------------------------------------------------------ lab lookups

  // Lengths and stages of the VFX the ability uses, for timing resolution and the critique.
  async context(ability: Ability): Promise<{ ctx: CritiqueContext; effects: Record<string, VfxEffect> }> {
    const effects: Record<string, VfxEffect> = {}
    for (const e of ability.events) {
      if (e.kind !== 'vfx' || effects[e.effect] || !this.deps.vfx) continue
      const fx = await this.deps.vfx.get(e.effect).catch(() => null)
      if (fx?.effect) effects[e.effect] = fx.effect
    }
    return {
      effects,
      ctx: {
        vfx: (id) => effects[id]?.duration,
        stages: (id) => effects[id]?.stages
      }
    }
  }

  async clips(): Promise<AnimClipRef[]> {
    const lab = this.deps.anim ? await this.deps.anim().catch(() => [] as AnimClipRef[]) : []
    return [...lab, ...placeholderClips()]
  }

  private tool(name: string): RegistryTool | null {
    try {
      return this.deps.tools?.().find((t) => t.name === name) ?? null
    } catch {
      return null
    }
  }

  // ------------------------------------------------------------ examples

  examples(): { key: string; name: string; description: string; tags: string[] }[] {
    return ABILITY_EXAMPLES.map(({ key, name, description, tags }) => ({ key, name, description, tags }))
  }

  async addExample(key: string): Promise<AbilityEntry> {
    const ex = findAbilityExample(key)
    if (!ex) throw new AbilityServiceError(`no built-in ability example "${key}" (examples: ${ABILITY_EXAMPLES.map((e) => e.key).join(', ')})`)
    const origin = `example:${ex.key}`
    const prev = (await this.list()).find((e) => e.origin === origin)
    if (prev) return prev
    const effects: Record<string, { id: string; duration?: number }> = {}
    for (const [event, vfxKey] of Object.entries(ex.vfx)) {
      const fx = this.deps.vfx ? await this.deps.vfx.addExample(vfxKey).catch(() => null) : null
      effects[event] = fx ? { id: fx.id, duration: fx.effect?.duration } : { id: `example:${vfxKey}` }
    }
    return this.save(ex.build(effects), { origin })
  }

  // ------------------------------------------------------------ compose

  private async pickVfx(request: string, notes: string[]): Promise<{ entry: VfxEntry; source: 'library' | 'vfx_compose' | 'example' } | null> {
    const vfx = this.deps.vfx
    if (!vfx) return null
    const hits = (await vfx.search(request, { limit: 4 }).catch(() => [] as VfxEntry[])).filter((e) => e.effect && e.kind !== 'media' && e.quality !== 'avoid')
    const wanted = words(request)
    const strong = hits.find((e) => wanted.some((w) => e.name.toLowerCase().includes(w) || e.tags.includes(w)))
    if (strong) return { entry: strong, source: 'library' }
    const compose = this.tool('vfx_compose')
    if (compose) {
      try {
        const out = await compose.handler({ request, refine: false }, {})
        const text = out.content.map((c) => c.text).join('\n')
        const id = !out.isError ? idFromToolText(text) : null
        const entry = id ? await vfx.get(id).catch(() => null) : null
        if (entry?.effect) return { entry, source: 'vfx_compose' }
        notes.push(`vfx_compose did not return an effect (${text.slice(0, 160)})`)
      } catch (e) {
        notes.push(`vfx_compose failed: ${(e as Error).message}`)
      }
    }
    if (hits[0]) return { entry: hits[0], source: 'library' }
    if (/purple|gojo|infinity/i.test(request)) {
      const ex = await vfx.addExample('hollow-purple').catch(() => null)
      if (ex) return { entry: ex, source: 'example' }
    }
    if (/slam|smash|ground/i.test(request)) {
      const ex = await vfx.addExample('ground-slam').catch(() => null)
      if (ex) return { entry: ex, source: 'example' }
    }
    if (/slash|sword|blade|cut/i.test(request)) {
      const ex = await vfx.addExample('charge-slash').catch(() => null)
      if (ex) return { entry: ex, source: 'example' }
    }
    return null
  }

  private async pickClip(request: string, notes: string[]): Promise<{ clip: AnimClipRef; source: 'library' | 'anim_compose' | 'placeholder' }> {
    const lab = this.deps.anim ? await this.deps.anim().catch(() => [] as AnimClipRef[]) : []
    const wanted = words(request)
    const scored = lab.map((c) => ({ c, s: wanted.filter((w) => c.name.toLowerCase().includes(w)).length })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)
    if (scored[0]) return { clip: scored[0].c, source: 'library' }
    const compose = this.tool('anim_compose')
    if (compose) {
      try {
        const out = await compose.handler({ request }, {})
        const text = out.content.map((c) => c.text).join('\n')
        const id = !out.isError ? idFromToolText(text) : null
        const fresh = id && this.deps.anim ? (await this.deps.anim().catch(() => [] as AnimClipRef[])).find((c) => c.id === id) : null
        if (fresh) return { clip: fresh, source: 'anim_compose' }
        notes.push(`anim_compose did not return a clip id the Animation Lab lists (${text.slice(0, 160)})`)
      } catch (e) {
        notes.push(`anim_compose failed: ${(e as Error).message}`)
      }
    }
    const ph = placeholderClips()
    const pick = /purple|gojo|beam|blast|cast|kamehameha/i.test(request) ? 'placeholder:hollow-purple' : /slam|smash|ground|stomp/i.test(request) ? 'placeholder:slam' : 'placeholder:strike'
    notes.push('no Animation Lab clip matched: using a placeholder pose track (swap in a real clip when it exists)')
    return { clip: ph.find((c) => c.id === pick)!, source: 'placeholder' }
  }

  async compose(request: string, opts: { restatement?: Restatement } = {}): Promise<AbilityComposeResult> {
    const text = String(request ?? '').trim()
    const restatement = normalizeRestatement(opts.restatement) ?? undefined
    if (text.length < 3) throw new AbilityServiceError('Describe the move, e.g. "a charged palm blast that knocks the caster back".')
    const notes: string[] = []
    const vfx = await this.pickVfx(text, notes)
    const { clip, source: clipSource } = await this.pickClip(text, notes)
    let moduleName = vfx?.entry.name ?? ''
    if (vfx?.entry.written) moduleName = vfx.entry.written.module.replace(/\/init\.luau$/, '').split('/').pop() ?? moduleName
    const draftVfx: DraftVfx | null = vfx?.entry.effect ? { id: vfx.entry.id, name: moduleName || vfx.entry.effect.name, duration: vfx.entry.effect.duration, stages: vfx.entry.effect.stages, anchor: vfx.entry.effect.anchor, colors: effectColor(vfx.entry.effect) } : null
    let ability = draftAbility({ request: text, vfx: draftVfx, clip })
    let timing: 'model' | 'draft' = 'draft'
    const { ctx } = await this.context(ability)
    const model = this.deps.model?.('default')
    if (model) {
      const liked = (await this.list()).filter((e) => e.rating === 'up').slice(0, 2)
      const prompt = [
        `Move: ${text}`,
        restatementBlock(restatement),
        `Draft: ${JSON.stringify(ability)}`,
        `Timeline:\n${timelineText(ability, ctx)}`,
        `Timing checks:\n${timingChecks(ability, ctx).map((c) => `- ${c.ok ? 'ok' : c.level}: ${c.message}`).join('\n')}`,
        ...liked.map((e) => `A move the user liked ("${e.origin}"):\n${timelineText(e.ability)}`),
        principlePlan('ability', text, { weights: await this.principleWeights() })
      ].filter(Boolean).join('\n\n')
      try {
        const raw = await model(COMPOSE_SYSTEM, prompt, [])
        const m = /\{[\s\S]*\}/.exec(raw.replace(/```(?:json)?/g, ''))
        if (!m) throw new Error('no JSON in the answer')
        const j = JSON.parse(m[0]) as { events?: Record<string, unknown>[]; remove?: string[]; duration?: number; plan?: unknown }
        const plan = parsePlanObject(j.plan)
        if (Object.keys(plan).length) notes.push(`plan: ${Object.entries(plan).map(([k, v]) => `${k}: ${v}`).join('; ')}`)
        const next = applyPatch(ability, { ability: j.duration ? { duration: j.duration } : undefined, events: Array.isArray(j.events) ? j.events : [], remove: Array.isArray(j.remove) ? j.remove.map(String) : [] })
        const errors = validateAbility(next, ctx).filter((i) => i.level === 'error')
        if (errors.length) throw new Error(errors.map((e) => e.message).join('; '))
        const fixed = applyTimingFixes(next, timingChecks(next, ctx))
        ability = fixed
        timing = 'model'
      } catch (e) {
        notes.push(`model timing unusable (${(e as Error).message}); kept the draft`)
        this.deps.log?.(`ability: compose model: ${(e as Error).message}`, 'stderr')
      }
    }
    const entry = await this.save(ability, { origin: text, ...(restatement ? { restatement } : {}) })
    await this.ensureSkill()
    return {
      entry,
      vfx: vfx ? { id: vfx.entry.id, name: vfx.entry.name, source: vfx.source } : null,
      animation: { id: clip.id, name: clip.name, source: clipSource },
      timing,
      notes
    }
  }

  async ensureSkill(): Promise<void> {
    if (this.guideSaved || !this.deps.memory) return
    this.guideSaved = true
    await this.deps.memory
      .remember({ scope: 'user', kind: 'skill', name: 'ability-choreography', description: 'How to time a Roblox move: anticipation, release marker, impact flash / shake / hit-stop, VFX on body parts, follow-through (Ability Composer)', body: ABILITY_GUIDE.slice(0, 7900) }, 'agent')
      .catch((e) => {
        this.guideSaved = false
        this.deps.log?.(`ability: choreography skill: ${(e as Error).message}`, 'stderr')
      })
  }

  // ------------------------------------------------------------ critique

  async critique(id: string, opts: { vision?: boolean; apply?: boolean; frames?: Buffer[] } = {}): Promise<{ entry: AbilityEntry; critique: AbilityCritique; applied: string[] }> {
    const hit = await this.find(id)
    if (!hit) throw new AbilityServiceError(`no ability "${id}"`)
    const ability = hit.entry.ability
    const { ctx, effects } = await this.context(ability)
    const checks = timingChecks(ability, ctx)
    const beats = keyBeats(ability)
    const frames: string[] = []
    let vision: AbilityCritique['vision']
    const model = opts.vision === false ? null : this.deps.model?.('critic')
    const weights = await this.principleWeights()
    const request = criticBrief(hit.entry.origin || hit.entry.description, hit.entry.restatement)
    const mainEffect = this.mainEffect(ability, effects)
    let raw: string | undefined
    if (model && (this.deps.capture || opts.frames?.length)) {
      try {
        // Studio check frames (studio/...) come in ready-made; otherwise render the beats.
        const pngs = opts.frames?.length ? opts.frames : await this.deps.capture!({ ability, effects, times: beats.map((b) => b.t), ...FRAME_SIZE })
        for (const [i, png] of pngs.entries()) {
          const f = `frames/critique-${i + 1}.png`
          await hit.store.writeFile(id, f, png)
          frames.push(f)
        }
        raw = await model(ABILITY_CRITIC_SYSTEM, `${critiquePrompt({ request: criticBrief(hit.entry.origin, hit.entry.restatement), timeline: timelineText(ability, ctx), checks, beats })}\n\n${abilityCriticPrinciples(ability, ctx, request, { weights, focus: hit.entry.critique?.focus, effect: mainEffect })}` + studioFramesNote(pngs), pngs.map((p) => ({ mime: 'image/png', base64: p.toString('base64') })))
        vision = parseVisionCritique(raw)
      } catch (e) {
        this.deps.log?.(`ability: vision critique unavailable (${(e as Error).message}); timing rules only`, 'stderr')
      }
    }
    const t = timingScore(checks)
    const critique: AbilityCritique = withAbilityPrinciples(
      { at: this.now(), timingScore: t, checks, ...(vision ? { vision } : {}), beats, frames, overall: vision ? Math.round(((t + vision.overall) / 2) * 10) / 10 : t, summary: summarize(checks, vision) },
      ability,
      ctx,
      { request, raw: vision ? raw : undefined, weights, effect: mainEffect }
    )
    let next = ability
    const applied: string[] = []
    if (opts.apply) {
      next = applyTimingFixes(next, checks)
      applied.push(...checks.filter((c) => !c.ok && c.fix).map((c) => `${c.fix!.event}: ${c.rule}`))
      const ordered = critique.vision?.changes ?? []
      if (ordered.length) {
        const r = applyChanges(next, ordered)
        next = r.ability
        applied.push(...ordered.map((c) => `${c.event}.${c.field}`).filter((x) => !r.skipped.some((s) => s.startsWith(x))))
      }
    }
    const entry = await hit.store.save({ ...hit.entry, ability: next, critique, updatedAt: this.now(), thumbs: frames.length ? [frames[Math.min(2, frames.length - 1)], ...hit.entry.thumbs.filter((f) => !f.startsWith('frames/'))].slice(0, 4) : hit.entry.thumbs })
    await this.ensureSkill()
    this.changed()
    return { entry, critique, applied }
  }

  // ------------------------------------------------------------ rating

  async rate(id: string, rating: 'up' | 'down' | null): Promise<AbilityEntry> {
    const hit = await this.find(id)
    if (!hit) throw new AbilityServiceError(`no ability "${id}"`)
    const e: AbilityEntry = { ...hit.entry, updatedAt: this.now() }
    if (rating) e.rating = rating
    else delete e.rating
    if (rating === 'up') e.quality = 'good'
    else if (rating === 'down') e.quality = 'avoid'
    else delete e.quality
    const saved = await hit.store.save(e)
    await this.recordPrinciples(saved, rating).catch((err) => this.deps.log?.(`ability: principle feedback: ${(err as Error).message}`, 'stderr'))
    if (this.deps.memory && rating) {
      const { ctx } = await this.context(saved.ability)
      const up = rating === 'up'
      const body = [
        up ? `A move the user liked in the Ability Composer ("${saved.origin}"). Reuse its timing for similar requests.` : `A move the user disliked in the Ability Composer ("${saved.origin}"). Avoid repeating these choices.`,
        saved.critique ? `Critique (${saved.critique.overall}/10): ${saved.critique.summary.slice(0, 300)}` : '',
        'Timeline (ability time, marker-relative refs in brackets):',
        timelineText(saved.ability, ctx),
        up ? '```json' : '',
        up ? JSON.stringify(saved.ability).slice(0, 5000) : '',
        up ? '```' : ''
      ]
        .filter(Boolean)
        .join('\n')
      await this.deps.memory
        .remember(up ? { scope: 'user', kind: 'skill', name: `ability-example-${saved.name}`.slice(0, 60), description: `Liked move timing: ${saved.description || saved.origin}`.slice(0, 200), body: body.slice(0, 7900) } : { scope: 'user', kind: 'memory', type: 'feedback', name: `ability-avoid-${saved.name}`.slice(0, 60), description: `Disliked move timing: ${saved.origin}`.slice(0, 200), body: body.slice(0, 2900) }, 'user')
        .catch((err) => this.deps.log?.(`ability: rating memory: ${(err as Error).message}`, 'stderr'))
    }
    this.changed()
    return saved
  }

  // Ratings teach the principle weights: the move's per-principle scores (its last critique, else the
  // timing rules and the main effect's checks).
  private async recordPrinciples(e: AbilityEntry, rating: 'up' | 'down' | null): Promise<void> {
    const p = this.deps.principles
    if (!p) return
    if (!rating) return void (await p.forget?.('ability', e.id))
    const { ctx, effects } = await this.context(e.ability)
    const ids = principleIds('ability', e.origin || e.description)
    const scores = scoresForRating(e.critique?.principles, () => abilityPrincipleChecks(e.ability, ctx, { effect: this.mainEffect(e.ability, effects) }).filter((c) => ids.includes(c.id)))
    await p.record({ lab: 'ability', entryId: e.id, name: e.name, rating, scores })
  }

  private async principleWeights(): Promise<PrincipleWeights> {
    return (await this.deps.principles?.weights().catch(() => ({}))) ?? {}
  }

  // The move's first VFX effect (the one the principle checks look at).
  private mainEffect(ability: Ability, effects: Record<string, VfxEffect>): VfxEffect | null {
    const ev = ability.events.find((x) => x.kind === 'vfx' && effects[(x as { effect: string }).effect])
    return ev ? effects[(ev as { effect: string }).effect] : null
  }

  // ------------------------------------------------------------ export

  private async projectTree(root: string): Promise<Record<string, unknown> | undefined> {
    try {
      return (JSON.parse(await readFile(join(root, 'default.project.json'), 'utf8')) as { tree?: Record<string, unknown> }).tree
    } catch {
      return undefined
    }
  }

  async export(id: string): Promise<AbilityExportResult> {
    const root = this.deps.projectRoot()
    if (!root) throw new AbilityServiceError('Open the game project first: the export writes Luau modules into it.')
    const entry = await this.get(id)
    const dir = (await this.exportDir())!
    const warnings: string[] = []
    let ability = entry.ability
    const { ctx } = await this.context(ability)
    for (const issue of validateAbility(ability, ctx)) if (issue.level === 'error') throw new AbilityError(`fix before export: ${issue.message}`)
    const tree = await this.projectTree(root)
    let vfxPath: string[] | null = null
    const renamed: Record<string, Record<string, unknown>> = {}
    for (const ev of ability.events) {
      if (ev.kind !== 'vfx' || ev.muted) continue
      let fx = this.deps.vfx ? await this.deps.vfx.get(ev.effect).catch(() => null) : null
      if (!fx) {
        warnings.push(`${ev.id}: VFX entry "${ev.effect}" is not in the VFX library; the module expects src/shared/VFX/${ev.effectName}`)
        continue
      }
      if (!fx.written && this.deps.vfx) fx = await this.deps.vfx.writeProjectFiles(fx)
      const folder = fx.written ? fx.written.module.replace(/\/init\.luau$/, '') : `src/shared/VFX/${ev.effectName}`
      const name = folder.split('/').pop()!
      if (name !== ev.effectName) renamed[ev.id] = { id: ev.id, effectName: name }
      vfxPath ??= instancePathFor(tree, `${folder.split('/').slice(0, -1).join('/')}/x.luau`)?.slice(0, -1) ?? null
    }
    if (Object.keys(renamed).length) ability = applyPatch(ability, { events: Object.values(renamed) })
    if (ability.events.some((e) => e.kind === 'vfx') && !vfxPath) warnings.push('src/shared/VFX is not mapped in default.project.json; AbilityRunner.VfxPath assumes ReplicatedStorage.Shared.VFX (map the folder or edit VfxPath)')
    if (ability.animation && !ability.animation.assetId) warnings.push(isPlaceholder(ability.animation.clip) ? `the animation is a placeholder pose track: publish a real clip and set its asset id` : `animation "${ability.animation.name}" has no asset id yet: publish it to Roblox and set the id`)
    const { source, skipped } = abilityModule(ability, ctx)
    warnings.push(...skipped.map((s) => `skipped ${s}`))
    const absDir = resolve(root, dir)
    if (!absDir.startsWith(resolve(root) + sep)) throw new AbilityServiceError('export path escapes the project')
    await mkdir(absDir, { recursive: true })
    const moduleFile = `${dir}/${ability.name}.luau`
    const runnerFile = `${dir}/${RUNNER_MODULE}.luau`
    await writeFile(join(root, moduleFile), source, 'utf8')
    const runnerSrc = runnerModule(vfxPath ?? ['ReplicatedStorage', 'Shared', 'VFX'])
    const cur = await readFile(join(root, runnerFile), 'utf8').catch(() => null)
    if (cur === null || isOwnRunner(cur)) {
      if (cur !== runnerSrc) await writeFile(join(root, runnerFile), runnerSrc, 'utf8')
    } else warnings.push(`${runnerFile} was replaced by hand; left as is`)
    const inst = instancePathFor(tree, moduleFile)
    const requirePath = inst ? `game.${requireExpression(inst)}` : null
    if (!requirePath) warnings.push(`${dir} is not mapped in default.project.json (Rojo will not sync it)`)
    const saved = await this.find(id)
    if (saved) await saved.store.save({ ...saved.entry, written: { module: moduleFile, runner: runnerFile } })
    this.changed()
    return {
      files: [moduleFile, runnerFile],
      module: moduleFile,
      runner: runnerFile,
      source,
      requirePath,
      command: requirePath ? `require(${requirePath}).play(game.Players.LocalPlayer.Character)` : null,
      warnings
    }
  }
}
