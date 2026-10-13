// Browser-preview mock of VfxApi: a small library built with the real shared code (draft -> spec ->
// effect), SVG thumbnails and iteration frames, and a fake refine loop driven by the heuristic
// critic, so the VFX Lab page renders without Electron, Lune or a model.
import type { HarnessEvents, VfxApi, VfxEffect, VfxEntry, VfxIteration, VfxRecipe } from '@shared/types'
import { draftSpec } from '@shared/vfx/draft'
import { effectFromSpec, applyChanges } from '@shared/vfx/spec'
import { autoTags, describeEffect, effectColors, effectStats, perfWarnings } from '@shared/vfx/analyze'
import { extractRecipes } from '@shared/vfx/recipes'
import { heuristicCritique } from '@shared/vfx/critique'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function glow(colors: string[], seed: number, label = ''): string {
  const [a = '#ffb15c', b = '#ff5a36', c = '#ffffff'] = colors
  const rays = Array.from({ length: 7 }, (_, i) => {
    const ang = (i / 7) * Math.PI * 2 + seed
    const x = 160 + Math.cos(ang) * (60 + ((seed * 13 + i * 7) % 30))
    const y = 120 + Math.sin(ang) * (44 + ((seed * 5 + i * 11) % 24))
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${2 + ((i + seed) % 3)}" fill="${c}" opacity=".85"/>`
  }).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><defs><radialGradient id="g"><stop offset="0" stop-color="${c}"/><stop offset=".25" stop-color="${a}" stop-opacity=".9"/><stop offset=".7" stop-color="${b}" stop-opacity=".35"/><stop offset="1" stop-color="${b}" stop-opacity="0"/></radialGradient></defs><rect width="320" height="240" fill="#0c0c0e"/><ellipse cx="160" cy="120" rx="${80 + (seed % 3) * 14}" ry="${62 + (seed % 2) * 10}" fill="url(#g)"/>${rays}${label ? `<text x="10" y="228" font-family="monospace" font-size="12" fill="#888">${label}</text>` : ''}</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const t0 = Date.UTC(2026, 9, 12, 15, 0)
let seq = 0
function entryFor(prompt: string, opts: Partial<VfxEntry> = {}): VfxEntry {
  const effect = effectFromSpec(draftSpec(prompt))
  const id = `${effect.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${(seq++).toString(36)}`
  return {
    id,
    scope: 'user',
    kind: 'model',
    name: effect.name,
    description: describeEffect(effect),
    tags: autoTags(effect, prompt),
    createdAt: t0 + seq * 3600_000,
    updatedAt: t0 + seq * 3600_000,
    origin: `~/Downloads/vfx-pack/${effect.name}.rbxm`,
    effect,
    stats: effectStats(effect),
    thumbs: ['thumbs/0.png'],
    quality: 'reference',
    ...opts
  }
}

const files = new Map<string, string>()
const entries: VfxEntry[] = []
function add(e: VfxEntry): VfxEntry {
  entries.unshift(e)
  if (e.effect) files.set(`${e.id}/thumbs/0.png`, glow(effectColors(e.effect), seq))
  return e
}

function iterations(e: VfxEntry, n: number): VfxIteration[] {
  const out: VfxIteration[] = []
  let effect = e.effect!
  for (let i = 1; i <= n; i++) {
    const critique = heuristicCritique(effect, null, ['ref-slash-a', 'ref-slash-b'])
    const bump = Math.min(9.2, critique.overall + (i - 1) * 0.9)
    critique.overall = Math.round(bump * 10) / 10
    for (const k of Object.keys(critique.scores) as (keyof typeof critique.scores)[]) critique.scores[k] = Math.min(10, critique.scores[k] + (i - 1) * 0.8)
    const frames = [0, 1, 2, 3].map((f) => {
      const file = `frames/${i}-${f}.png`
      files.set(`${e.id}/${file}`, glow(effectColors(effect), i * 4 + f, `#${i} t${f}`))
      return file
    })
    out.push({ n: i, at: e.createdAt + i * 20_000, effect, frames, critique })
    effect = applyChanges(effect, critique.changes)
  }
  return out
}

add(entryFor('fire aura burning', { tags: ['fire', 'aura', 'continuous'] }))
add(entryFor('blue lightning impact', { tags: ['lightning', 'impact', 'burst'] }))
add(entryFor('green heal burst', { scope: 'project', tags: ['heal', 'burst', 'magic'] }))
add(entryFor('energy beam', { tags: ['beam', 'magic'] }))
add({
  id: 'ref-clip-slash-0',
  scope: 'user',
  kind: 'media',
  name: 'Slash reference clip',
  description: 'Screen capture of a front-page sword slash, for critique only.',
  tags: ['slash', 'reference'],
  createdAt: t0,
  updatedAt: t0,
  origin: '~/Movies/slash-ref.gif',
  media: [{ file: 'media/slash-ref.gif', mime: 'image/gif' }],
  thumbs: [],
  quality: 'reference'
})
files.set('ref-clip-slash-0/media/slash-ref.gif', glow(['#bfe3ff', '#4f8dff', '#ffffff'], 3, 'slash-ref.gif'))
const made = add(entryFor('purple sword slash with sparks', { kind: 'generated', scope: 'project', quality: 'good', rating: 'up', origin: 'Make: purple sword slash with sparks', written: { module: 'src/shared/VFX/PurpleSwordSlash/init.luau', model: 'src/shared/VFX/PurpleSwordSlash/Effect.rbxmx' } }))
made.iterations = iterations(made, 3)

let recipes: VfxRecipe[] = extractRecipes(entries)

export function vfxMock(emit: Emit): VfxApi {
  const changed = () => emit('vfx:changed', { at: Date.now() })
  const find = (id: string) => {
    const e = entries.find((x) => x.id === id)
    if (!e) throw new Error(`No VFX entry ${id}`)
    return e
  }
  const refine = async (e: VfxEntry, max: number) => {
    const its = iterations(e, Math.max(1, Math.min(max, 3)))
    for (const it of its) {
      for (const phase of ['render', 'critique', 'adjust'] as const) {
        emit('vfx:progress', { entryId: e.id, iteration: it.n, phase, score: phase === 'adjust' ? it.critique?.overall : undefined })
        await delay(500)
      }
      e.iterations = [...(e.iterations ?? []), it]
      e.updatedAt = Date.now()
      changed()
    }
    emit('vfx:progress', { entryId: e.id, iteration: its.length, phase: 'done', score: its[its.length - 1]?.critique?.overall, message: 'Reached the iteration limit.' })
  }
  return {
    async vfxStatus() {
      return { projectRoot: '/Users/you/games/Bladefall', lune: { available: true, version: '0.11.0' }, vision: true, rojo: true, entries: { user: entries.filter((e) => e.scope === 'user').length, project: entries.filter((e) => e.scope === 'project').length }, recipes: recipes.length }
    },
    async vfxList() {
      return [...entries].sort((a, b) => (a.scope === b.scope ? b.updatedAt - a.updatedAt : a.scope === 'project' ? -1 : 1))
    },
    async vfxGet(id) {
      return find(id)
    },
    async vfxSearch(q) {
      const w = q.toLowerCase()
      return entries.filter((e) => `${e.name} ${e.tags.join(' ')} ${e.description}`.toLowerCase().includes(w))
    },
    async vfxImport(paths, scope) {
      await delay(400)
      const added = paths.map((p) => add(entryFor(p.split(/[\\/]/).pop()!.replace(/\.\w+$/, '').replace(/[-_]/g, ' '), { scope, origin: p })))
      changed()
      return { added, skipped: [] }
    },
    async vfxChooseImport() {
      return ['~/Downloads/vfx-pack/Ice_Shatter.rbxm']
    },
    async vfxUpdate(id, patch) {
      const e = find(id)
      Object.assign(e, patch, { updatedAt: Date.now() })
      if (patch.effect) e.stats = effectStats(patch.effect)
      changed()
      return e
    },
    async vfxDelete(id) {
      const i = entries.findIndex((e) => e.id === id)
      if (i >= 0) entries.splice(i, 1)
      changed()
      return i >= 0
    },
    async vfxRate(id, rating) {
      const e = find(id)
      e.rating = rating ?? undefined
      if (e.kind === 'generated') e.quality = rating === 'up' ? 'good' : rating === 'down' ? 'avoid' : undefined
      changed()
      return e
    },
    async vfxLearn() {
      await delay(300)
      recipes = extractRecipes(entries)
      changed()
      return { recipes, saved: recipes.map((r) => `vfx-recipe-${r.tag}`), errors: [] }
    },
    async vfxRecipes() {
      return recipes
    },
    async vfxMake(prompt, opts) {
      emit('vfx:progress', { entryId: 'pending', iteration: 0, phase: 'create' })
      await delay(500)
      const e = add(entryFor(prompt, { kind: 'generated', scope: 'project', quality: undefined, origin: `Make: ${prompt}`, thumbs: ['thumbs/0.png'] }))
      changed()
      void refine(e, opts?.maxIterations ?? 3)
      return e
    },
    async vfxRefine(id, opts) {
      void refine(find(id), opts?.maxIterations ?? 3)
    },
    async vfxCancel(id) {
      emit('vfx:progress', { entryId: id, iteration: 0, phase: 'done', message: 'Cancelled.' })
    },
    async vfxCreate(spec, id) {
      const effect: VfxEffect = effectFromSpec(spec)
      const e = id ? Object.assign(find(id), { effect, updatedAt: Date.now() }) : add(entryFor(spec.name, { kind: 'generated' }))
      if (!id) e.effect = effect
      changed()
      return { entry: e, warnings: perfWarnings(effect) }
    },
    async vfxFile(id, file) {
      return files.get(`${id}/${file}`) ?? null
    },
    async vfxSaveThumb(id, png) {
      const e = find(id)
      files.set(`${id}/thumbs/0.png`, png)
      e.thumbs = ['thumbs/0.png']
      return e
    },
    async vfxResolveTexture() {
      return null
    },
    async vfxTestInStudio(id) {
      const e = find(id)
      return { module: `src/shared/VFX/${e.name}/init.luau`, rojo: 'running', command: `require(game.ReplicatedStorage.Shared.VFX.${e.name}).play(workspace.CurrentCamera.CFrame * CFrame.new(0, -2, -14))`, instancePath: `ReplicatedStorage.Shared.VFX.${e.name}` }
    }
  }
}
