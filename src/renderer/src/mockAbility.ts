// Browser-preview mock of AbilityApi: a small move library built with the real shared code (the
// Hollow Purple example on the mock VFX Lab's Hollow Purple, a drafted strike), the timing critic,
// and a fake export, so the Ability Composer page renders without Electron, Lune or a model.
import type { Ability, AbilityApi, AbilityCritique, AbilityEntry, HarnessEvents, VfxEntry } from '@shared/types'
import { applyTimingFixes, keyBeats, summarize, timingChecks, timingScore, type CritiqueContext } from '@shared/ability/critique'
import { draftAbility } from '@shared/ability/draft'
import { ABILITY_EXAMPLES, findAbilityExample } from '@shared/ability/examples'
import { abilityModule } from '@shared/ability/luau'
import { normalizeAbility, slug } from '@shared/ability/model'
import { placeholderClips } from '@shared/ability/placeholder'
import { vfxMock } from './mockVfx'
import { withAbilityPrinciples } from '@shared/principles/attach'
import { mockPrincipleWeights, recordPrincipleRating } from './mockPrinciples'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.UTC(2026, 9, 12, 18, 0)

function frameSvg(label: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><defs><radialGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset=".3" stop-color="hsl(${hue},90%,65%)" stop-opacity=".9"/><stop offset="1" stop-color="hsl(${hue},80%,40%)" stop-opacity="0"/></radialGradient></defs><rect width="320" height="240" fill="#0b0d10"/><rect x="146" y="92" width="28" height="70" fill="#9aa1ab"/><circle cx="160" cy="80" r="13" fill="#9aa1ab"/><ellipse cx="160" cy="112" rx="70" ry="54" fill="url(#g)"/><text x="10" y="228" font-family="monospace" font-size="12" fill="#888">${label}</text></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

export function abilityMock(emit: Emit): AbilityApi {
  const vfx = vfxMock(emit)
  const entries: AbilityEntry[] = []
  const files = new Map<string, string>()
  const changed = () => emit('ability:changed', { at: Date.now() })
  const find = (id: string) => {
    const e = entries.find((x) => x.id === id)
    if (!e) throw new Error(`no ability "${id}"`)
    return e
  }
  const effectFor = async (id: string): Promise<VfxEntry | null> => vfx.vfxGet(id).catch(() => null)
  const context = async (ability: Ability): Promise<CritiqueContext> => {
    const fx: Record<string, VfxEntry | null> = {}
    for (const e of ability.events) if (e.kind === 'vfx' && !(e.effect in fx)) fx[e.effect] = await effectFor(e.effect)
    return { vfx: (id) => fx[id]?.effect?.duration, stages: (id) => fx[id]?.effect?.stages }
  }
  const put = (ability: Ability, opts: { id?: string; origin?: string; scope?: 'user' | 'project' } = {}): AbilityEntry => {
    const a = normalizeAbility(ability)
    const prev = opts.id ? find(opts.id) : null
    const now = t0 + entries.length * 3_600_000 + (prev ? 60_000 : 0)
    const entry: AbilityEntry = {
      ...(prev ?? { createdAt: now, thumbs: [], origin: opts.origin ?? 'manual' }),
      id: prev?.id ?? `${slug(a.name)}-${entries.length.toString(36)}`,
      scope: prev?.scope ?? opts.scope ?? 'project',
      name: a.name,
      description: a.description ?? '',
      tags: a.tags ?? [],
      updatedAt: Math.max(now, Date.now()),
      ability: a
    } as AbilityEntry
    if (prev) entries.splice(entries.indexOf(prev), 1, entry)
    else entries.unshift(entry)
    return entry
  }
  const addExample = async (key: string): Promise<AbilityEntry> => {
    const ex = findAbilityExample(key)
    if (!ex) throw new Error(`no built-in ability example "${key}"`)
    const prev = entries.find((e) => e.origin === `example:${ex.key}`)
    if (prev) return prev
    const effects: Record<string, { id: string; duration?: number }> = {}
    for (const [event, vfxKey] of Object.entries(ex.vfx)) {
      const fx = await vfx.vfxAddExample(vfxKey).catch(() => null)
      effects[event] = fx ? { id: fx.id, duration: fx.effect?.duration } : { id: `example:${vfxKey}` }
    }
    return put(ex.build(effects), { origin: `example:${ex.key}` })
  }
  const compose = async (request: string) => {
    const lib = await vfx.vfxList()
    const words = request.toLowerCase().split(/\W+/).filter((w) => w.length > 3)
    const pick = lib.find((e) => e.effect && words.some((w) => `${e.name} ${e.tags.join(' ')}`.toLowerCase().includes(w))) ?? lib.find((e) => e.id === 'hollow-purple-ex') ?? null
    const clips = placeholderClips()
    const clip = /slam|smash|ground/i.test(request) ? clips.find((c) => c.id === 'placeholder:slam')! : /purple|charge|beam|blast/i.test(request) ? clips.find((c) => c.id === 'placeholder:hollow-purple')! : clips.find((c) => c.id === 'placeholder:strike')!
    const draft = draftAbility({ request, clip, vfx: pick?.effect ? { id: pick.id, name: pick.effect.name, duration: pick.effect.duration, stages: pick.effect.stages, anchor: pick.effect.anchor } : null })
    const ctx = await context(draft)
    return { ability: applyTimingFixes(draft, timingChecks(draft, ctx)), vfx: pick, clip }
  }

  // Seed library: the Hollow Purple example (critiqued and liked) and a drafted strike.
  const seeded = (async () => {
    const hp = await addExample('hollow-purple')
    const ctx = await context(hp.ability)
    const checks = timingChecks(hp.ability, ctx)
    const beats = keyBeats(hp.ability)
    const frames = beats.map((b, i) => {
      const f = `frames/critique-${i + 1}.png`
      files.set(`${hp.id}/${f}`, frameSvg(`${b.label} ${b.t.toFixed(2)}s`, 275))
      return f
    })
    const vision = { scores: { anticipation: 8, impact: 8.5, sync: 9, readability: 7.5, followThrough: 7 }, overall: 8, summary: 'The fire reads clearly on the release; the recover could hold the pose a beat longer.', changes: [] }
    const t = timingScore(checks)
    const raw = JSON.stringify({ principles: [{ id: 'anticipation', score: 8.5, note: 'the two orbs gather for 0.9 s while the hands spread: clearly telegraphed', fix: 'keep it' }, { id: 'follow-through', score: 6.2, note: 'the recover pose snaps back the moment the purple ball leaves', fix: 'hold the push pose 0.15 s, then ease the arms down' }, { id: 'fx-cohesion', score: 9, note: 'the merge flash lands on the release frame between the hands' }] })
    hp.critique = withAbilityPrinciples({ at: t0 + 600_000, timingScore: t, checks, vision, beats, frames, overall: Math.round(((t + vision.overall) / 2) * 10) / 10, summary: summarize(checks, vision) }, hp.ability, ctx, { request: 'hollow purple', raw, weights: mockPrincipleWeights() })
    hp.thumbs = [frames[Math.min(3, frames.length - 1)]]
    hp.rating = 'up'
    hp.quality = 'good'
    const strike = await compose('a quick dash punch with an orange impact')
    put({ ...strike.ability, name: 'DashPunch' }, { origin: 'Make: a quick dash punch with an orange impact', scope: 'user' })
  })()

  return {
    async abilityStatus() {
      await seeded
      return { projectRoot: '/Users/you/games/Bladefall', vision: true, render: false, lune: true, entries: { user: entries.filter((e) => e.scope === 'user').length, project: entries.filter((e) => e.scope === 'project').length }, exportDir: 'src/skills/Client/Abilities', soundGeneration: false }
    },
    async abilityList() {
      await seeded
      return [...entries].sort((a, b) => (a.scope === b.scope ? b.updatedAt - a.updatedAt : a.scope === 'project' ? -1 : 1))
    },
    async abilityGet(id) {
      await seeded
      return find(id)
    },
    async abilitySave(ability, opts) {
      const e = put(ability, opts)
      changed()
      return e
    },
    async abilityDelete(id) {
      const i = entries.findIndex((e) => e.id === id)
      if (i < 0) return false
      entries.splice(i, 1)
      changed()
      return true
    },
    async abilityRate(id, rating) {
      const e = find(id)
      recordPrincipleRating('ability', e.id, e.name, rating, e.critique?.principles)
      e.rating = rating ?? undefined
      e.quality = rating === 'up' ? 'good' : rating === 'down' ? 'avoid' : undefined
      changed()
      return e
    },
    async abilityCompose(request) {
      await delay(700)
      const r = await compose(request)
      const entry = put(r.ability, { origin: request })
      changed()
      return { entry, vfx: r.vfx ? { id: r.vfx.id, name: r.vfx.name, source: 'library' as const } : null, animation: { id: r.clip.id, name: r.clip.name, source: 'placeholder' as const }, timing: 'draft' as const, notes: ['browser preview: no model, timings from the draft rules'] }
    },
    async abilityCritique(id, opts) {
      await delay(500)
      const e = find(id)
      const ctx = await context(e.ability)
      const checks = timingChecks(e.ability, ctx)
      const t = timingScore(checks)
      const critique: AbilityCritique = withAbilityPrinciples({ at: Date.now(), timingScore: t, checks, beats: keyBeats(e.ability), frames: [], overall: t, summary: summarize(checks) }, e.ability, ctx, { request: e.origin.replace(/^Make: /, ''), weights: mockPrincipleWeights() })
      const applied = opts?.apply ? checks.filter((c) => !c.ok && c.fix).map((c) => `${c.fix!.event}: ${c.rule}`) : []
      const next = put(opts?.apply ? applyTimingFixes(e.ability, checks) : e.ability, { id })
      next.critique = critique
      changed()
      return { entry: next, critique, applied }
    },
    async abilityExport(id) {
      await delay(300)
      const e = find(id)
      const ctx = await context(e.ability)
      const mod = abilityModule(e.ability, ctx)
      const dir = 'src/skills/Client/Abilities'
      e.written = { module: `${dir}/${e.ability.name}.luau`, runner: `${dir}/AbilityRunner.luau` }
      changed()
      return {
        files: [e.written.module, e.written.runner],
        module: e.written.module,
        runner: e.written.runner,
        source: mod.source,
        requirePath: `ReplicatedStorage.Skills.Client.Abilities.${e.ability.name}`,
        command: `require(ReplicatedStorage.Skills.Client.Abilities.${e.ability.name}).play(game.Players.LocalPlayer.Character)`,
        warnings: [...mod.skipped, ...(e.ability.animation && !e.ability.animation.assetId ? ['the animation has no asset id yet: publish the clip and set it, or the runner skips the animation'] : [])]
      }
    },
    async abilityExamples() {
      return ABILITY_EXAMPLES.map(({ key, name, description, tags }) => ({ key, name, description, tags }))
    },
    async abilityAddExample(key) {
      const e = await addExample(key)
      changed()
      return e
    },
    async abilityFile(id, file) {
      await seeded
      return files.get(`${id}/${file}`) ?? null
    },
    async abilitySaveThumb(id, url) {
      const e = find(id)
      files.set(`${id}/thumbs/0.png`, url)
      e.thumbs = ['thumbs/0.png', ...e.thumbs.filter((f) => f !== 'thumbs/0.png')]
      changed()
      return e
    },
    async abilityChooseSounds() {
      return ['/Users/you/Sounds/whoosh.ogg']
    },
    async abilitySoundUrl() {
      return null
    }
  }
}
