// Browser-preview mock of VfxApi: a small library built with the real shared code (draft -> spec ->
// effect), SVG thumbnails and iteration frames, and a fake refine loop driven by the heuristic
// critic, so the VFX Lab page renders without Electron, Lune or a model.
import type { HarnessEvents, VfxApi, VfxEffect, VfxEntry, VfxIteration, VfxRecipe } from '@shared/types'
import { draftSpec } from '@shared/vfx/draft'
import { effectFromSpec, applyChanges } from '@shared/vfx/spec'
import { describeEffect, effectColors, effectStats, perfWarnings } from '@shared/vfx/analyze'
import { extractRecipes } from '@shared/vfx/recipes'
import { heuristicCritique } from '@shared/vfx/critique'
import { compileTimeline } from '@shared/vfx/compile'
import { findExample, VFX_EXAMPLES } from '@shared/vfx/examples'
import { RECORDED } from '@shared/vfx/examples.recorded'
import { timelineSummary } from '@shared/vfx/timeline'
import type { VfxScriptResult } from '@shared/types'
import { mockResolveTexture } from './mockVfxTextures'
import { mockMeshGet, mockMeshLoad } from './mockMeshes'
import { genRef } from '@shared/vfx/tex/textures'
import { withVfxPrinciples } from '@shared/principles/attach'
import { mockPrincipleWeights, recordPrincipleRating } from './mockPrinciples'
import { effectHash } from '@shared/vfx/fingerprint'
import { autoTagGroups, autoTags, flatTags, groupsFromTags, tagGroupsOf } from '@shared/vfx/tags'
import { normalizeLiveSettings, type LiveStatus } from '@shared/vfx/live'
import type { VfxImportRow, VfxImportScan } from '@shared/types'

// What a vision critic would add for the principles code cannot measure (shape, readability), so the
// preview's scorecards show both kinds.
function previewCriticRaw(i: number): string {
  const s = (x: number) => Math.min(9.4, Math.round((x + (i - 1) * 0.7) * 10) / 10)
  return JSON.stringify({
    principles: [
      { id: 'fx-shape', score: s(5.8), note: 'the crescent reads on the release frame but the core is a round blob', fix: 'swap the core texture for a slash crescent (forgetex://gen/slash)' },
      { id: 'fx-readability', score: s(6.4), note: 'the arc is readable at 30 studs; the sparks vanish past 20', fix: 'raise the sparks Size to 0.25 and LightEmission to 1' },
      { id: 'fx-contrast', score: s(6), note: 'the core and the glow are the same purple', fix: 'start the core Color at #ffffff' }
    ]
  })
}

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
    Object.assign(critique, withVfxPrinciples(critique, effect, { request: e.origin.replace(/^Make: /, '') || e.description, raw: previewCriticRaw(i), weights: mockPrincipleWeights() }))
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

// Built-in scripted examples compile from their recorded timelines (no Lune in the browser).
function exampleEntry(key: string): VfxEntry {
  const ex = findExample(key)!
  const { effect } = compileTimeline({ name: ex.name, roots: [], cues: [], duration: 2 }, RECORDED[ex.key], ex.script)
  return entryFor(ex.name, { id: `${ex.key}-ex`, kind: 'generated', scope: 'project', quality: undefined, name: ex.name, description: ex.description, tags: [...ex.tags, 'sequence', 'example'], origin: `example:${ex.key}`, effect, stats: effectStats(effect), written: { module: `src/shared/VFX/${ex.name}/init.luau`, model: `src/shared/VFX/${ex.name}/Effect.rbxmx` } })
}
add(exampleEntry('ground-slam'))
add(exampleEntry('hollow-purple'))

// Custom textures (mockVfxTextures): the ground slam with library / procedural textures.
{
  const e = exampleEntry('ground-slam')
  const walk = (ns: NonNullable<VfxEntry['effect']>['roots']) => {
    for (const n of ns) {
      if (n.className === 'ParticleEmitter') {
        if (/^Ring2|shock|wave/i.test(n.name)) Object.assign(n.props, { Texture: 'forgetex://shockwave-expand-d4', FlipbookLayout: 'Grid4x4', FlipbookMode: 'OneShot' })
        else if (/debris/i.test(n.name)) n.props.Texture = 'forgetex://ground-crack-c3'
        else if (/dust|smoke/i.test(n.name)) n.props.Texture = genRef('smoke', {}, { tint: 'grey', seed: 3 })
        else if (/spark|ember/i.test(n.name)) n.props.Texture = genRef('spark')
        else n.props.Texture = 'forgetex://soft-core-glow-a1'
      }
      walk(n.children)
    }
  }
  walk(e.effect!.roots)
  add({ ...e, id: 'ground-slam-tex', name: 'GroundSlamTextured', description: 'Ground slam with custom textures: a ring flipbook, procedural smoke and sparks.', tags: ['impact', 'shockwave', 'sequence', 'textures'], stats: effectStats(e.effect!), origin: 'textures demo' })
}

// The browser preview cannot run Luau: a script that matches a built-in example (ignoring
// whitespace) compiles from its recording; an unknown fx method is reported like Lune would.
const FX_METHODS = new Set(['spawn', 'emit', 'enable', 'disable', 'tween', 'set', 'wait', 'at', 'after', 'now', 'stage', 'duration', 'anchor', 'forward', 'right', 'up'])
function mockRun(script: string, base: VfxEffect): VfxScriptResult {
  const lines = script.split('\n')
  for (const [i, l] of lines.entries()) {
    const m = /\bfx:(\w+)/.exec(l.replace(/--.*$/, ''))
    if (m && !FX_METHODS.has(m[1])) return { ok: false, error: { message: `attempt to call a nil value (method '${m[1]}')`, line: i + 1 }, prints: [], warnings: [], summary: '' }
  }
  const norm = (x: string) => x.replace(/\s+/g, ' ').trim()
  const ex = VFX_EXAMPLES.find((e) => norm(e.script) === norm(script))
  if (!ex) return { ok: true, effect: { ...base, script }, prints: [], warnings: ['browser preview: the script was not executed (Lune runs it in the desktop app)'], summary: timelineSummary(base) }
  const { effect, warnings } = compileTimeline({ ...base, name: base.name || ex.name }, RECORDED[ex.key], script)
  return { ok: true, effect, prints: [], warnings, summary: timelineSummary(effect) }
}

let recipes: VfxRecipe[] = extractRecipes(entries)

// Browser preview of the bulk import: a pack shaped like a Studio VFX folder (Models plus a loose
// Part, duplicate names), the trash, and the live loop state.
const STUDIO_PACK = ['AuraImpact', 'Barrage', 'Slash', 'Slash', 'Slash', 'Impact', 'Impact', 'QuickDash', 'Trail', 'ActivateFX', 'Fire Burst', 'Ice Shatter', 'Lightning Arc', 'Wind Swirl']
const trash = new Map<string, VfxEntry[]>()
const scans = new Map<string, { rows: VfxImportRow[]; prompts: Map<string, string> }>()

export function vfxMock(emit: Emit): VfxApi {
  const changed = () => emit('vfx:changed', { at: Date.now() })
  let live: LiveStatus = { state: 'off', pinned: null, name: null, label: '', plays: 0, settings: normalizeLiveSettings(null) }
  const liveEmit = (patch: Partial<LiveStatus>) => {
    live = { ...live, ...patch }
    emit('vfx:live', live)
    return live
  }
  const scanOf = (names: string[], source: 'files' | 'studio'): VfxImportScan => {
    const index = new Map(entries.filter((e) => e.effect).map((e) => [effectHash(e.effect!), e]))
    const prompts = new Map<string, string>()
    const first = new Map<string, string>()
    const counts = new Map<string, number>()
    const rows: VfxImportRow[] = names.map((n, i) => {
      const c = (counts.get(n) ?? 0) + 1
      counts.set(n, c)
      const name = c > 1 ? `${n} (${c})` : n
      // Two of the three "Slash" copies are the same effect (dedupe within the import).
      const prompt = n === 'Slash' && c === 3 ? 'Slash' : c > 1 ? `${n} ${c}` : n
      const effect = effectFromSpec(draftSpec(prompt.toLowerCase()))
      const hash = effectHash(effect)
      const st = effectStats(effect)
      const key = `r${i}`
      prompts.set(key, prompt)
      const dup = index.get(hash)
      const row: VfxImportRow = { key, name, origin: source === 'studio' ? `Workspace.VFX.${n}` : `vfx-pack.rbxm`, source: source === 'studio' ? 'studio' : 'file', stats: { emitters: st.emitters, beams: st.beams, trails: st.trails, lights: st.lights, meshes: st.meshes, scripts: st.scripts, parts: n === 'Trail' ? 1 : 2 }, notes: [], hash, duplicates: dup ? [{ scope: dup.scope, id: dup.id, name: dup.name }] : [], ...(first.has(hash) ? { sameAs: first.get(hash) } : {}) }
      if (!first.has(hash)) first.set(hash, key)
      return row
    })
    const scanId = `scan-${(seq++).toString(36)}`
    scans.set(scanId, { rows, prompts })
    return { scanId, source, rows, media: [], skipped: [], notes: [] }
  }
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
    async vfxImportScan(paths) {
      await delay(300)
      return scanOf(paths.map((p) => p.split(/[\\/]/).pop()!.replace(/\.\w+$/, '')), 'files')
    },
    async vfxStudioScan(opts) {
      for (let i = 1; i <= 4; i++) {
        emit('vfx:import', { phase: 'reading', done: i * 3, total: 12, label: 'reading the selection' })
        await delay(150)
      }
      if (!opts?.packs?.length && !entries.some((e) => e.origin.startsWith('Workspace.'))) {
        return { scanId: `scan-${(seq++).toString(36)}`, source: 'studio', rows: [], packs: [{ key: 'Workspace.VFX', path: [{ name: 'Workspace', index: 0 }, { name: 'VFX', index: 3 }], fullName: 'Workspace.VFX', className: 'Folder', effects: STUDIO_PACK.length, children: STUDIO_PACK.length }], media: [], skipped: [], notes: ['Nothing is selected in Studio: pick the VFX folders to import.'] }
      }
      return scanOf(STUDIO_PACK, 'studio')
    },
    async vfxImportCommit(input) {
      const s = scans.get(input.scanId)
      if (!s) throw new Error('This import review expired; scan again.')
      const added: VfxEntry[] = []
      for (const [i, r] of input.rows.entries()) {
        const row = s.rows.find((x) => x.key === r.key)!
        const e = add(entryFor(s.prompts.get(r.key)!.toLowerCase(), { scope: input.scope, origin: row.origin }))
        e.name = r.name
        const g = autoTagGroups(e.effect!, r.name).groups
        e.tagGroups = g
        e.tags = flatTags(g)
        added.push(e)
        emit('vfx:import', { scanId: input.scanId, phase: 'importing', done: i + 1, total: input.rows.length, label: r.name })
        await delay(30)
      }
      scans.delete(input.scanId)
      changed()
      return { added, skipped: [] }
    },
    async vfxTrash(ids) {
      const batch = `t${(seq++).toString(36)}`
      const removed = entries.filter((e) => ids.includes(e.id))
      for (const e of removed) entries.splice(entries.indexOf(e), 1)
      trash.set(batch, removed)
      changed()
      return { batch, removed: removed.map((e) => e.id) }
    },
    async vfxRestore(batch) {
      const back = trash.get(batch) ?? []
      trash.delete(batch)
      for (const e of back) entries.push(e)
      changed()
      return { restored: back.map((e) => e.id) }
    },
    async vfxClear(scope) {
      return this.vfxTrash(entries.filter((e) => e.scope === scope).map((e) => e.id))
    },
    async vfxDuplicates() {
      const by = new Map<string, VfxEntry[]>()
      for (const e of entries) if (e.effect) by.set(`${e.scope}:${effectHash(e.effect)}`, [...(by.get(`${e.scope}:${effectHash(e.effect)}`) ?? []), e])
      return [...by.entries()].filter(([, l]) => l.length > 1).map(([k, l]) => ({ hash: k.split(':')[1], scope: l[0].scope, entries: [...l].sort((a, b) => a.createdAt - b.createdAt) }))
    },
    async vfxRetag() {
      let n = 0
      for (const e of entries) {
        if (!e.effect) continue
        const user = e.userTagGroups ?? []
        const cur = tagGroupsOf(e)
        const auto = autoTagGroups(e.effect, e.name).groups
        const g = { kind: user.includes('kind') ? cur.kind : auto.kind, element: user.includes('element') ? cur.element : auto.element, timing: user.includes('timing') ? cur.timing : auto.timing, custom: cur.custom }
        e.tagGroups = g
        e.tags = flatTags(g)
        n++
      }
      changed()
      return { changed: n, total: n }
    },
    async vfxLiveStart(opts) {
      const settings = normalizeLiveSettings({ ...live.settings, ...(opts?.settings ?? {}) })
      if (!opts?.pin && live.state !== 'off' && live.pinned) return liveEmit({ following: true, settings })
      return liveEmit({ state: 'looping', pinned: opts?.pin ?? null, following: opts?.pin ? !!live.following : true, name: opts?.current?.effect.name ?? live.name, label: opts?.current?.label ?? live.label, settings })
    },
    async vfxLiveStop(opts) {
      if (opts?.loop && live.pinned && live.following) return liveEmit({ pinned: null })
      if (opts?.follow && live.pinned) return liveEmit({ following: false })
      return liveEmit({ state: 'off', pinned: null, following: false, plays: 0 })
    },
    async vfxLiveSet(current) {
      if (live.state === 'off') return live
      if (live.pinned && live.pinned !== current.key.replace(/^draft:/, '')) return live.following ? liveEmit({ pinned: null, name: current.effect.name, label: current.label ?? current.effect.name }) : liveEmit({ state: 'off', pinned: null })
      return liveEmit({ name: current.effect.name, label: current.label ?? current.effect.name, plays: live.plays + 1 })
    },
    async vfxLiveSettings(settings) {
      return liveEmit({ settings: normalizeLiveSettings({ ...live.settings, ...settings }) })
    },
    async vfxLiveStatus() {
      return live
    },
    async vfxChooseImport() {
      return ['~/Downloads/vfx-pack/Ice_Shatter.rbxm']
    },
    async vfxUpdate(id, patch) {
      const e = find(id)
      if (patch.tags || patch.tagGroups) {
        const g = patch.tagGroups ? { ...tagGroupsOf(e), ...patch.tagGroups } : groupsFromTags(patch.tags!)
        patch = { ...patch, tags: flatTags(g as ReturnType<typeof tagGroupsOf>), tagGroups: g }
        e.userTagGroups = [...new Set([...(e.userTagGroups ?? []), ...(Object.keys(patch.tagGroups ?? g) as ('kind' | 'element' | 'timing' | 'custom')[])])]
      }
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
      recordPrincipleRating('vfx', e.id, e.name, rating, e.iterations?.[e.iterations.length - 1]?.critique?.principles, e.notes)
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
    async vfxResolveTexture(ref) {
      return mockResolveTexture(String(ref ?? ''))
    },
    // Meshes: a few demo ids have procedural geometry "in Studio" (mockMeshes.ts); the cache starts
    // empty so the "Load meshes" flow shows.
    async vfxMeshGet(refs) {
      return mockMeshGet(refs)
    },
    async vfxMeshLoad(refs, opts) {
      await delay(400)
      const r = mockMeshLoad(refs, opts)
      if (r.results.some((x) => x.state === 'loaded')) emit('vfx:meshes', { at: Date.now(), ids: r.results.filter((x) => x.state === 'loaded').map((x) => x.id) })
      return r
    },
    async vfxMeshStatus() {
      return { studio: true, cloudKey: false }
    },
    async vfxReimport(id) {
      const e = find(id)
      e.importVersion = 2
      e.updatedAt = Date.now()
      changed()
      return e
    },
    async vfxRunScript(script, opts) {
      await delay(250)
      const e = opts?.id ? find(opts.id) : null
      const r = mockRun(script, e?.effect ?? { name: 'Sequence', roots: [], cues: [], duration: 2 })
      if (!r.ok || !opts?.save || !r.effect) return r
      const entry = e ? Object.assign(e, { effect: r.effect, stats: effectStats(r.effect), updatedAt: Date.now() }) : add(entryFor('sequence', { kind: 'generated', effect: r.effect, name: r.effect.name }))
      changed()
      return { ...r, entry }
    },
    async vfxCompose(request, opts) {
      emit('vfx:progress', { entryId: 'pending', iteration: 0, phase: 'create' })
      await delay(600)
      const ex = /purple|gojo/i.test(request) ? 'hollow-purple' : /slash|sword/i.test(request) ? 'charge-slash' : 'ground-slam'
      const e = add({ ...exampleEntry(ex), id: `composed-${(seq++).toString(36)}`, origin: request, description: request, rating: undefined, ...(opts?.restatement ? { restatement: opts.restatement } : {}) })
      if (e.effect) e.effect = { ...e.effect, script: findExample(ex)!.script }
      changed()
      if (opts?.refine !== false) void refine(e, opts?.maxIterations ?? 2)
      return { ok: true, entry: e, effect: e.effect, prints: [], warnings: [], summary: timelineSummary(e.effect!), source: 'model' }
    },
    async vfxExamples() {
      return VFX_EXAMPLES.map(({ key, name, description, tags }) => ({ key, name, description, tags }))
    },
    async vfxAddExample(key) {
      const prev = entries.find((e) => e.origin === `example:${key}`)
      if (prev) return prev
      const e = add(exampleEntry(key))
      changed()
      return e
    },
    async vfxTestInStudio(id) {
      const e = find(id)
      return { module: `src/shared/VFX/${e.name}/init.luau`, rojo: 'running', command: `require(game.ReplicatedStorage.Shared.VFX.${e.name}).play(workspace.CurrentCamera.CFrame * CFrame.new(0, -2, -14))`, instancePath: `ReplicatedStorage.Shared.VFX.${e.name}` }
    }
  }
}
