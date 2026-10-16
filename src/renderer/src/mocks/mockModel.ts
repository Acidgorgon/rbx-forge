// Browser-preview mock of ModelApi: no Lune here, so a "build" is a small procedural block model drawn
// in TS (a curved spine of plate rings coloured by sin(angle), chunky spikes, an eye pair; a voxel
// egg for the egg template). The template scripts are the real ones (resources/lune/model_templates).
// ?model=empty starts with an empty library, ?model=nolune shows the Lune hint.
import type { HarnessEvents, ModelApi, ModelBuild, ModelEntry, ModelPart, ModelSettings, ModelTemplateId } from '@shared/types'
import { buildWarnings } from '@shared/model/checks'
import { modelName, TEMPLATE_INFO } from '@shared/model/prompt'
import creatureScript from '../../../../resources/lune/model_templates/creature.luau?raw'
import guardScript from '../../../../resources/lune/model_templates/guard.luau?raw'
import eggScript from '../../../../resources/lune/model_templates/egg.luau?raw'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.UTC(2026, 9, 14, 15, 0)
const SCRIPTS: Record<ModelTemplateId, string> = { creature: creatureScript, guard: guardScript, egg: eggScript }

// Rotation about Y then X as the 12 CFrame components.
function cf(x: number, y: number, z: number, yaw = 0, pitch = 0, roll = 0): number[] {
  const [cy, sy, cp, sp, cr, sr] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch), Math.cos(roll), Math.sin(roll)]
  // R = Ry * Rx * Rz
  const r00 = cy * cr + sy * sp * sr
  const r01 = -cy * sr + sy * sp * cr
  const r02 = sy * cp
  const r10 = cp * sr
  const r11 = cp * cr
  const r12 = -sp
  const r20 = -sy * cr + cy * sp * sr
  const r21 = sy * sr + cy * sp * cr
  const r22 = cy * cp
  return [x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22]
}

const mix = (a: number[], b: number[], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

function creatureParts(dark: number[], light: number[], seed = 1): ModelPart[] {
  const parts: ModelPart[] = [{ n: 'Root', k: 'P', s: [2, 2, 2], cf: cf(0, 3, 0), c: [0.6, 0.6, 0.6], t: 1, a: true }]
  const rings = 12
  for (let i = 0; i < rings; i++) {
    const u = i / (rings - 1)
    const z = -6 + u * 13
    const y = 3 + Math.sin(u * Math.PI) * 0.8 - u * 0.6
    const rx = 1.2 + Math.sin(Math.min(1, u * 1.4) * Math.PI) * 1.6
    const ry = rx * 0.85
    const plates = 12
    for (let j = 0; j < plates; j++) {
      const a = (j / plates) * Math.PI * 2
      const shade = (Math.sin(a) + 1) / 2
      const c = mix(light, dark, shade)
      const v = ((i * 7 + j * 3 + seed) % 5) * 0.012
      parts.push({ n: 'Plate', k: 'P', s: [((2 * Math.PI * rx) / plates) * 1.15, 0.35, 1.3], cf: cf(Math.cos(a) * rx, y + Math.sin(a) * ry, z, 0, 0, a + Math.PI / 2), c: [c[0] + v, c[1] + v, c[2] + v], m: 'SmoothPlastic' })
    }
    parts.push({ n: 'Groove', k: 'P', s: [rx * 1.7, ry * 1.7, 0.2], cf: cf(0, y, z + 0.6), c: [0.08, 0.08, 0.1] })
    if (i > 1 && i < rings - 2) parts.push({ n: 'Spike', k: 'W', s: [0.7, 1.2 + Math.sin(u * Math.PI) * 0.9, 1.1], cf: cf(0, y + ry + 0.5, z), c: mix(dark, [0, 0, 0], 0.3) })
  }
  for (const side of [-1, 1]) {
    parts.push({ n: 'Eye', k: 'P', s: [0.5, 0.5, 0.5], cf: cf(side * 1.4, 3.6, -5.6), c: [1, 0.85, 0.2], m: 'Neon' })
    parts.push({ n: 'Fin', k: 'C', s: [0.4, 1.6, 2.2], cf: cf(side * 2.6, 2.2, -1, side > 0 ? 0 : Math.PI), c: mix(dark, light, 0.4) })
  }
  return parts
}

function eggParts(): ModelPart[] {
  const parts: ModelPart[] = [{ n: 'Root', k: 'P', s: [1, 1, 1], cf: cf(0, 0.5, 0), c: [0.6, 0.6, 0.6], t: 1, a: true }]
  const V = 0.4
  for (let y = 0; y < 15; y++) {
    const h = (y + 0.5) / 15
    const r = 2.4 * Math.sqrt(Math.max(0, 1 - Math.pow((h - 0.45) / 0.55, 2))) * (h > 0.45 ? 1 - (h - 0.45) * 0.4 : 1)
    const n = Math.max(1, Math.round((r * 2) / V))
    for (let x = 0; x < n; x++) {
      const px = -r + (x + 0.5) * V * ((r * 2) / (n * V))
      const half = Math.sqrt(Math.max(0, r * r - px * px))
      if (half < V / 2) continue
      const spot = (x * 3 + y * 5) % 11 === 0
      const c: [number, number, number] = spot ? [0.85, 0.45, 0.55] : y === 6 ? [0.95, 0.75, 0.8] : [1, 0.62, 0.7]
      parts.push({ n: 'Voxel', k: 'P', s: [V, V, half * 2], cf: cf(px, y * V + V / 2, 0), c })
    }
  }
  for (const side of [-1, 1]) parts.push({ n: 'Eye', k: 'P', s: [0.3, 0.4, 0.2], cf: cf(side * 0.7, 3.4, -2.3), c: [0.1, 0.1, 0.12] })
  return parts
}

function fakeBuild(script: string, name?: string): ModelBuild {
  const text = String(script ?? '')
  if (!/return\s+function/.test(text)) return { ok: false, parts: [], prints: [], warnings: [], error: { message: 'the script must return function(model, ctx)' } }
  const bad = /error\("([^"]*)"\)/.exec(text)
  if (bad) {
    const line = text.slice(0, bad.index).split('\n').length
    return { ok: false, parts: [], prints: [], warnings: [], error: { line, message: bad[1] } }
  }
  const parts = /voxelEgg/.test(text) ? eggParts() : /Glacier|wireGuard/.test(text) ? creatureParts([0.25, 0.45, 0.7], [0.85, 0.95, 1], 3) : creatureParts([0.2, 0.3, 0.42], [0.9, 0.92, 0.95])
  const stats = { motors: 3, welds: 0, weldConstraints: parts.length - 4, attachments: 0, animators: 1, animationControllers: 1, humanoids: 0, anchored: 1, instances: parts.length + 6, assemblies: 1, loose: 0, primaryPart: 'Root' }
  return { ok: true, name: name ?? 'BlockModel', parts, stats, prints: [], warnings: buildWarnings(parts, stats), ms: 48 }
}

export function modelMock(emit: Emit): ModelApi {
  const q = new URLSearchParams(location.search).get('model')
  let settings: ModelSettings = { critic: true, rounds: 2 }
  const files: Record<string, Record<string, string>> = {}
  let seq = 0
  const entries: ModelEntry[] =
    q === 'empty'
      ? []
      : [
          { id: 'plated-shark', name: 'Plated Shark', prompt: 'a plated shark creature', template: 'creature', script: creatureScript, parts: fakeBuild(creatureScript).parts.length, refs: [], origin: 'template', createdAt: t0, updatedAt: t0 + 60_000 },
          { id: 'pig-egg', name: 'Pig Egg', prompt: 'a pig egg', template: 'egg', script: eggScript, parts: fakeBuild(eggScript).parts.length, refs: [], origin: 'template', createdAt: t0 - 3_600_000, updatedAt: t0 - 3_600_000 }
        ]
  const find = (id: string) => {
    const e = entries.find((x) => x.id === id)
    if (!e) throw new Error(`no model "${id}"`)
    return e
  }
  const changed = (id?: string) => emit('model:changed', { at: Date.now(), ...(id ? { id } : {}) })
  const put = (e: ModelEntry) => {
    const i = entries.findIndex((x) => x.id === e.id)
    if (i >= 0) entries[i] = e
    else entries.unshift(e)
    changed(e.id)
    return e
  }
  const withBuild = (e: ModelEntry, b: ModelBuild): ModelEntry => (b.ok ? { ...e, parts: b.parts.length, stats: b.stats, error: undefined } : { ...e, error: `${b.error?.line ? `line ${b.error.line}: ` : ''}${b.error?.message}` })
  const newId = (name: string) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'model'}-${++seq}`
  return {
    async modelStatus() {
      return {
        projectRoot: '/home/acid/Projects/obby-quest',
        libraryDir: '/home/acid/Projects/obby-quest/.forge/models/library',
        lune: q === 'nolune' ? { available: false, hint: 'Lune was not found. Settings > Tests > Lune path, or `rokit add lune-org/lune`.' } : { available: true, version: '0.10.4' },
        vision: true,
        render: true,
        studio: { connected: true, place: 'Obby Quest', pluginVersion: 10, canBuild: true, message: 'Builds in Obby Quest' },
        settings,
        entries: entries.length
      }
    },
    async modelList() {
      return [...entries].sort((a, b) => b.updatedAt - a.updatedAt)
    },
    async modelLoad(id) {
      await delay(80)
      const entry = find(id)
      return { entry, build: fakeBuild(entry.script, entry.name) }
    },
    async modelRun(script, opts) {
      await delay(120)
      return fakeBuild(script, opts?.name)
    },
    async modelGenerate(prompt, opts) {
      const template = opts?.template ?? 'creature'
      const run = opts?.run
      const existing = opts?.id ? find(opts.id) : null
      const name = opts?.name || existing?.name || modelName(prompt, TEMPLATE_INFO[template].label)
      const id = existing?.id ?? newId(name)
      const step = async (phase: HarnessEvents['model:progress']['phase'], message: string, round?: number) => {
        emit('model:progress', { id, run, phase, message, at: Date.now(), ...(round ? { round } : {}) })
        await delay(350)
      }
      await step('writing', `Writing the build script${opts?.refs?.length ? ` from ${opts.refs.length} reference${opts.refs.length === 1 ? '' : 's'}` : ''}`)
      await step('building', 'Building the preview')
      const script = `-- ${prompt}\n${SCRIPTS[template]}`
      const build = fakeBuild(script, name)
      const refs = (opts?.refs ?? []).map((_, i) => `refs/ref-${i + 1}.png`)
      files[id] = { ...(files[id] ?? {}), ...Object.fromEntries((opts?.refs ?? []).map((r, i) => [`refs/ref-${i + 1}.png`, r])) }
      let entry = put(withBuild({ id, name, prompt, template, script, parts: 0, refs: refs.length ? refs : (existing?.refs ?? []), origin: 'ai', createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now() }, build))
      const rounds = (opts?.critic ?? settings.critic) ? (opts?.rounds ?? settings.rounds) : 0
      for (let r = 1; r <= rounds; r++) {
        await step('capturing', `Round ${r}: snapshotting the preview`, r)
        await step('critic', `Round ${r}: comparing with the request`, r)
        const changedRound = r === 1
        entry = put({ ...entry, critic: [...(entry.critic ?? []), { round: r, at: Date.now(), summary: changedRound ? 'Made the dorsal spikes bigger; darkened the top plates' : 'kept as it is', changed: changedRound, frames: [], parts: entry.parts }], updatedAt: Date.now() })
        if (!changedRound) break
      }
      emit('model:progress', { id, run, phase: 'done', message: `${build.parts.length} parts`, at: Date.now() })
      return { entry, build, source: 'model', notes: [] }
    },
    async modelFromTemplate(template, opts) {
      await delay(120)
      const name = opts?.name || TEMPLATE_INFO[template].label
      const script = SCRIPTS[template]
      const build = fakeBuild(script, name)
      const entry = put(withBuild({ id: newId(name), name, prompt: opts?.prompt || TEMPLATE_INFO[template].prompt, template, script, parts: 0, refs: [], origin: 'template', createdAt: Date.now(), updatedAt: Date.now() }, build))
      return { entry, build }
    },
    async modelSave(id, patch) {
      await delay(100)
      const e = find(id)
      const next: ModelEntry = { ...e, ...(patch.name ? { name: patch.name } : {}), ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}), ...(patch.template ? { template: patch.template } : {}), updatedAt: Date.now() }
      if (patch.guard === null) delete next.guard
      else if (patch.guard) next.guard = patch.guard
      if (patch.script !== undefined && patch.script !== e.script) {
        next.script = patch.script
        next.origin = 'edit'
      }
      const build = fakeBuild(next.script, next.name)
      return { entry: put(withBuild(next, build)), build }
    },
    async modelRename(id, name) {
      return put({ ...find(id), name: name.trim() || find(id).name, updatedAt: Date.now() })
    },
    async modelDelete(id) {
      const i = entries.findIndex((x) => x.id === id)
      if (i < 0) return false
      entries.splice(i, 1)
      changed(id)
      return true
    },
    async modelCritique(id, opts) {
      const e = find(id)
      emit('model:progress', { id, run: opts?.run, phase: 'critic', message: 'Round 1: comparing with the request', at: Date.now(), round: 1 })
      await delay(500)
      const build = fakeBuild(e.script, e.name)
      const round = (e.critic?.length ?? 0) + 1
      const entry = put({ ...e, critic: [...(e.critic ?? []), { round, at: Date.now(), summary: 'kept as it is', changed: false, frames: [] }] })
      emit('model:progress', { id, run: opts?.run, phase: 'done', message: `${build.parts.length} parts`, at: Date.now() })
      return { entry, build, source: 'model', notes: [] }
    },
    async modelSetSettings(patch) {
      settings = { critic: patch.critic ?? settings.critic, rounds: Math.max(0, Math.min(5, Math.round(patch.rounds ?? settings.rounds))) }
      return settings
    },
    async modelFile(id, file) {
      return files[id]?.[file] ?? null
    },
    async modelSaveThumb(id, url) {
      const e = find(id)
      files[id] = { ...(files[id] ?? {}), 'thumb.png': url }
      const i = entries.indexOf(e)
      entries[i] = { ...e, thumb: 'thumb.png', thumbStamp: e.updatedAt }
      changed(id)
      return entries[i]
    },
    async modelBuildInStudio(id) {
      const e = find(id)
      emit('model:progress', { id, phase: 'studio', message: `Building ${e.name} in Studio`, at: Date.now() })
      await delay(600)
      const name = e.name.replace(/[^\w ()-]+/g, '').trim() || 'BlockModel'
      return { name, parts: e.parts, path: `Workspace.${name}`, place: 'Obby Quest' }
    }
  }
}
