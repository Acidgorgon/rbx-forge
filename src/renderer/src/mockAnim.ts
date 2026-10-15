// Browser-preview mock of AnimApi: the built-in examples compiled from their recorded ops, a few
// "imported" clips built from kit poses (one marked avoid), style profiles and coverage from the real
// shared code, and a fake refine loop driven by the numbers-only critic, so the Animation Lab page
// renders without Electron, Lune or a model.
import type { AnimApi, AnimClip, AnimEntry, AnimIteration, AnimKey, AnimStyle, HarnessEvents, LabModels, R15Joint, RigType } from '@shared/types'
import { compileAnim, type AnimOp } from '@shared/anim/compile'
import { ANIM_EXAMPLES, animExample } from '@shared/anim/examples'
import { ANIM_RECORDED } from '@shared/anim/examples.recorded'
import { archetypeFor } from '@shared/anim/draft'
import { findKitPose, resolveKitPose } from '@shared/anim/kit'
import { xfToCf } from '@shared/anim/math'
import { measureClip } from '@shared/anim/measure'
import { runChecks } from '@shared/anim/checks'
import { autoTags, buildStyle, coverage, profileFor } from '@shared/anim/style'
import { animRefineLoop, beatFrameTimes, heuristicAnimCritique, withMustFix } from '@shared/anim/critique'
import { bestIteration, guardedApply, iterationScore } from '@shared/anim/quality'
import { motionIntent } from '@shared/anim/intent'
import { allKnownTags, coverageOptions, heuristicRetag, MOVE_SETS, moveSetDef, normalizeCustomTag, resolveMoveSet, setPromptTags, type MoveSetSettings } from '@shared/anim/movesets'
import { clipRig, poseCFrames } from '@shared/anim/sample'
import { convertClip, RIG_CONVERT_WARNING } from '@shared/anim/convert'
import { clipSummary } from '@shared/anim/compile'
import { normalizeLabModels } from '@shared/labModels'
import { figureDataUrl } from './pages/anim/figure'
import { withAnimPrinciples } from '@shared/principles/attach'
import { mockPrincipleWeights, recordPrincipleRating } from './mockPrinciples'
import { applyRemix, describeRemixOp, heuristicRemixPlan, normalizeRemixPlan, remixCandidates, type RemixOrigin } from '@shared/anim/remix'
import type { AnimRemixMode } from '@shared/animTypes'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A clip from kit poses at times (what an imported KeyframeSequence looks like in the library).
function kitClip(name: string, keys: [number, string, number?][], looped = false): AnimClip {
  const tracks: Partial<Record<R15Joint, AnimKey[]>> = {}
  for (const [t, pose, amount] of keys) {
    const r = resolveKitPose(findKitPose(pose)!, { amount: amount ?? 1 })
    for (const [j, x] of Object.entries(r.joints) as [R15Joint, { p: [number, number, number]; q: [number, number, number, number] }][]) {
      ;(tracks[j] ??= []).push({ t, cf: xfToCf(x), ease: 'CubicV2', dir: 'InOut' })
    }
  }
  return { name, duration: keys[keys.length - 1][0], looped, priority: looped ? 'Idle' : 'Action', tracks, markers: [], source: 'rbxm' }
}

const t0 = Date.UTC(2026, 9, 12, 15, 0)

function entry(clip: AnimClip, o: Partial<AnimEntry> & { id: string }): AnimEntry {
  const stats = measureClip(clip)
  return {
    scope: 'user',
    kind: 'imported',
    name: clip.name,
    description: `${clip.looped ? 'Looped ' : ''}${stats.duration.toFixed(2)} s clip; anticipation ${stats.anticipation.toFixed(2)} s, action ${stats.action.toFixed(2)} s, recovery ${stats.recovery.toFixed(2)} s.`,
    tags: autoTags(clip, clip.name),
    notes: '',
    createdAt: t0,
    updatedAt: t0,
    origin: `${clip.name}.rbxmx`,
    clip,
    thumbs: [],
    stats,
    ...o
  }
}

function exampleEntry(key: string, id = `example-${key}`): AnimEntry {
  const ex = animExample(key)!
  const { clip } = compileAnim(ANIM_RECORDED[key] ?? [], ex.script, { name: ex.name, rig: ex.rig ?? 'R15' })
  return entry(clip, { id, kind: 'generated', origin: `example:${key}`, description: ex.description, tags: [...ex.tags, 'example'] })
}

export function animMock(emit: Emit): AnimApi {
  const files = new Map<string, string>()
  let labModels: LabModels = {}
  const entries: AnimEntry[] = [
    { ...exampleEntry('sign-push'), rating: 'up', quality: 'good', updatedAt: t0 + 9000 },
    exampleEntry('dash-punch'),
    exampleEntry('hit-reaction'),
    exampleEntry('sign-push-r6'),
    entry(kitClip('Jab_Heavy', [[0, 'guard'], [0.28, 'windup'], [0.38, 'punch_extend', 1.15], [0.5, 'punch_extend'], [0.95, 'guard']]), { id: 'jab-heavy-a1', tags: ['attack'], rating: 'up', notes: 'Good snap on the extend; the hold sells the weight.' }),
    entry(kitClip('Kick_Round', [[0, 'guard'], [0.25, 'kick_chamber'], [0.36, 'kick_extend'], [0.52, 'kick_extend'], [1.0, 'guard']]), { id: 'kick-round-b2', tags: ['kick', 'attack'] }),
    entry(kitClip('Idle_Breathe', [[0, 'idle'], [1.2, 'idle', 0.7], [2.4, 'idle']], true), { id: 'idle-breathe-c3', tags: ['idle'] }),
    entry(kitClip('Cast_Overhead', [[0, 'idle'], [0.4, 'crouch', 0.5], [0.62, 'cast_raise'], [0.9, 'cast_raise'], [1.4, 'idle']]), { id: 'cast-overhead-d4', tags: ['cast'] }),
    entry(kitClip('Punch_Floaty', [[0, 'idle'], [0.6, 'punch_extend', 0.6], [1.6, 'idle']]), { id: 'punch-floaty-e5', tags: ['attack'], rating: 'down', quality: 'avoid', notes: 'Too slow and floaty: no anticipation, the arm drifts out.' })
  ]
  let style: AnimStyle = buildStyle(entries, t0)
  const changed = () => {
    style = buildStyle(entries, Date.now())
    emit('anim:changed', { at: Date.now() })
  }
  const find = (id: string) => {
    const e = entries.find((x) => x.id === id)
    if (!e) throw new Error(`no animation "${id}"`)
    return e
  }
  let seq = 0
  let rig: RigType = 'R15'
  let moveSets: MoveSetSettings = { set: 'combat', custom: {} }
  let remixMode: AnimRemixMode = 'auto'

  async function refine(e: AnimEntry, max: number) {
    const ref = e.reference ? entries.find((x) => x.id === e.reference)?.clip : undefined
    const base = e.iterations?.length ?? 0
    const ctx = { intent: motionIntent(e.kind === 'generated' ? e.origin : '', e.tags), profile: profileFor(style, e.tags, clipRig(e.clip)) }
    await animRefineLoop(
      e.clip,
      {
        render: async (clip, n) => {
          emit('anim:progress', { entryId: e.id, iteration: base + n, phase: 'render' })
          await delay(350)
          const times = beatFrameTimes(clip, 4)
          const names = times.map((t, i) => {
            const f = `frames/iter-${base + n}-${i + 1}.svg`
            files.set(`${e.id}/${f}`, figureDataUrl(clip, t, { width: 240, height: 200, ghost: ref, label: `t=${t.toFixed(2)}s` }))
            return f
          })
          return { frames: names, times }
        },
        critique: async (clip, _f, _t, n) => {
          emit('anim:progress', { entryId: e.id, iteration: base + n, phase: 'critique' })
          await delay(400)
          const p = profileFor(style, e.tags, clipRig(clip))
          const checks = runChecks(clip, p, { intent: ctx.intent })
          return withMustFix(withAnimPrinciples(heuristicAnimCritique(clip, checks, p), clip, { request: e.origin.replace(/^Make: /, '') || e.description, weights: mockPrincipleWeights(), checks }))
        },
        score: (clip, c) => iterationScore(c, clip, ctx),
        apply: (clip, changes) => guardedApply(clip, changes, ctx),
        onIteration: (it, best) => {
          const iteration: AnimIteration = { n: base + it.n, at: Date.now(), clip: it.clip, frames: it.frames, times: it.times, critique: it.critique, score: it.score, ...(it.rejected.length ? { guarded: it.rejected } : {}) }
          e.iterations = [...(e.iterations ?? []), iteration]
          e.clip = best.clip
          emit('anim:progress', { entryId: e.id, iteration: base + it.n, phase: 'adjust', score: it.score.quality, message: it.critique.summary, best: { n: base + best.n, quality: best.score.quality } })
          changed()
        }
      },
      { maxIterations: max }
    ).then(
      (r) => {
        e.clip = r.best.clip
        e.stats = measureClip(e.clip)
        emit('anim:progress', { entryId: e.id, iteration: base + r.iterations.length, phase: 'done', score: r.best.score.quality, message: `stopped: ${r.stop}; using #${base + r.best.n}`, best: { n: base + r.best.n, quality: r.best.score.quality } })
        changed()
      },
      (err) => emit('anim:progress', { entryId: e.id, iteration: base, phase: 'error', message: (err as Error).message })
    )
  }

  return {
    async animStatus() {
      return { projectRoot: '/demo/game', lune: { available: true, version: '0.11.0' }, vision: true, upload: false, entries: { user: entries.filter((e) => e.scope === 'user').length, project: entries.filter((e) => e.scope === 'project').length }, profiles: style.profiles.length + (style.r6?.profiles.length ?? 0), rig }
    },
    async animList() {
      return [...entries].sort((a, b) => b.updatedAt - a.updatedAt)
    },
    async animGet(id) {
      return find(id)
    },
    async animPreviewImport(paths, opts?: { convert?: RigType }) {
      return paths.map((p, i) => {
        const name = p.split(/[\\/]/).pop()!.replace(/\.\w+$/, '')
        const clip = kitClip(name, [[0, 'guard'], [0.3, i % 2 ? 'kick_chamber' : 'windup'], [0.42, i % 2 ? 'kick_extend' : 'punch_extend'], [0.9, 'guard']])
        return { file: p, name, duration: clip.duration, looped: false, markers: 0, suggestedTags: autoTags(clip, name), rig: opts?.convert ?? 'R15' as RigType }
      })
    },
    async animImport(paths, scope, opts) {
      const added = paths.map((p, i) => {
        const name = p.split(/[\\/]/).pop()!.replace(/\.\w+$/, '')
        const raw = kitClip(name, [[0, 'guard'], [0.3, i % 2 ? 'kick_chamber' : 'windup'], [0.42, i % 2 ? 'kick_extend' : 'punch_extend'], [0.9, 'guard']])
        const clip = opts?.convert === 'R6' ? convertClip(raw, 'R6') : raw
        const e = entry(clip, { id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${(seq++).toString(36)}`, scope, createdAt: Date.now(), updatedAt: Date.now(), ...(opts?.tags?.length ? { tags: opts.tags } : {}), ...(opts?.quality ? { quality: opts.quality } : {}), ...(opts?.quality === 'avoid' ? { rating: 'down' as const } : {}) })
        entries.push(e)
        return e
      })
      changed()
      return { added, skipped: [] }
    },
    async animChooseImport() {
      return ['/demo/refs/Uppercut_Fast.rbxm', '/demo/refs/Roundhouse.bvh']
    },
    async animUpdate(id, patch) {
      const e = find(id)
      if (patch.name) e.name = patch.name
      if (typeof patch.description === 'string') e.description = patch.description
      if (typeof patch.notes === 'string') e.notes = patch.notes
      if (patch.tags) e.tags = patch.tags
      if (patch.quality === null) delete e.quality
      else if (patch.quality) e.quality = patch.quality
      if (patch.reference === null) delete e.reference
      else if (patch.reference) e.reference = patch.reference
      if (patch.clip) e.clip = patch.clip
      e.updatedAt = Date.now()
      changed()
      return e
    },
    async animDelete(id) {
      const i = entries.findIndex((e) => e.id === id)
      if (i >= 0) entries.splice(i, 1)
      changed()
      return i >= 0
    },
    async animRate(id, rating) {
      const e = find(id)
      recordPrincipleRating('anim', e.id, e.name, rating, e.iterations?.[e.iterations.length - 1]?.critique?.principles, e.notes)
      if (rating) e.rating = rating
      else delete e.rating
      if (rating === 'down') e.quality = 'avoid'
      else if (e.quality === 'avoid') delete e.quality
      changed()
      return e
    },
    async animLearn() {
      style = buildStyle(entries, Date.now(), allKnownTags(moveSets))
      return { style, saved: style.profiles.map((p) => `anim-style-${p.tag}`), errors: [] }
    },
    async animStyle() {
      return style
    },
    async animCoverage() {
      return coverage(entries, coverageOptions(resolveMoveSet(moveSets)))
    },
    async animMoveSets() {
      return { active: resolveMoveSet(moveSets), sets: MOVE_SETS.map(({ id, name, description }) => ({ id, name, description })) }
    },
    async animSetMoveSet(id) {
      moveSets = { ...moveSets, set: moveSetDef(id).id }
      changed()
      return resolveMoveSet(moveSets)
    },
    async animAddMoveTag(tag) {
      const c = normalizeCustomTag(tag)
      if (!c) throw new Error('Name the move type')
      moveSets = { ...moveSets, custom: { ...moveSets.custom, [moveSets.set]: [...(moveSets.custom[moveSets.set] ?? []).filter((x) => x.tag !== c.tag), c] } }
      changed()
      return resolveMoveSet(moveSets)
    },
    async animRemoveMoveTag(tag) {
      moveSets = { ...moveSets, custom: { ...moveSets.custom, [moveSets.set]: (moveSets.custom[moveSets.set] ?? []).filter((x) => x.tag !== tag) } }
      changed()
      return resolveMoveSet(moveSets)
    },
    async animRetag() {
      const set = resolveMoveSet(moveSets)
      const changes = heuristicRetag(entries, set)
      for (const c of changes) {
        const e = entries.find((x) => x.id === c.id)
        if (e) e.tags = c.after
      }
      style = buildStyle(entries, Date.now(), allKnownTags(moveSets))
      changed()
      return { set: set.id, source: 'heuristic' as const, total: entries.length, changed: changes.length, changes }
    },
    async animCompose(request, opts) {
      await delay(500)
      const arch = archetypeFor(request, resolveMoveSet(moveSets))
      const r6 = (opts?.rig ?? rig) === 'R6'
      const key = (arch === 'sign_push' || arch === 'cast' ? 'sign-push' : arch === 'hit' ? 'hit-reaction' : 'dash-punch') + (r6 ? '-r6' : '')
      const base = exampleEntry(key, `composed-${(seq++).toString(36)}`)
      const e: AnimEntry = { ...base, ...(opts?.restatement ? { restatement: opts.restatement } : {}), origin: request, description: request, tags: [...new Set([...setPromptTags(request, resolveMoveSet(moveSets)), ...base.tags.filter((t) => t !== 'example')])], createdAt: Date.now(), updatedAt: Date.now() }
      entries.push(e)
      changed()
      if (opts?.refine !== false) void refine(e, opts?.maxIterations ?? 2)
      return { ok: true, entry: e, clip: e.clip, prints: [], warnings: [], summary: clipSummary(e.clip), checks: runChecks(e.clip), source: 'model' }
    },
    async animRemixCandidates(prompt) {
      const set = resolveMoveSet(moveSets)
      return { candidates: remixCandidates(entries, prompt, set, { rig }), tags: setPromptTags(prompt, set) }
    },
    async animRemix(request, opts) {
      await delay(300)
      const set = resolveMoveSet(moveSets)
      const base = opts?.base ? find(opts.base) : entries.find((e) => e.id === remixCandidates(entries, request, set, { rig, limit: 1 })[0]?.id)
      if (!base) throw new Error(`No usable library clip matches "${request}".`)
      const ops = opts?.ops ? normalizeRemixPlan(opts.ops).ops : heuristicRemixPlan(request, base.clip)
      const r = applyRemix(base.clip, ops, (id) => entries.find((e) => e.id === id)?.clip)
      const remix: RemixOrigin = { base: base.id, baseName: base.name, ops: r.applied, source: opts?.ops ? 'user' : 'heuristic' }
      const clip = { ...r.clip, name: `${base.clip.name}Remix` }
      const e: AnimEntry = { ...entry(clip, { id: `remix-${(seq++).toString(36)}` }), kind: 'generated', origin: request, description: `${request}. Remix of "${base.name}": ${r.applied.map((o) => describeRemixOp(o)).join('; ') || 'unchanged'}.`, tags: [...new Set([...base.tags.filter((t) => t !== 'example'), ...setPromptTags(request, set)])], remix, createdAt: Date.now(), updatedAt: Date.now() }
      entries.push(e)
      changed()
      if (opts?.refine !== false) void refine(e, opts?.maxIterations ?? 2)
      return { ok: true, entry: e, clip: e.clip, prints: [], warnings: [], summary: clipSummary(e.clip), checks: runChecks(e.clip), source: 'remix' }
    },
    async animRemixApply(id, ops, opts) {
      const e = find(id)
      const base = find(opts?.base ?? e.remix?.base ?? '')
      const r = applyRemix(base.clip, normalizeRemixPlan(ops).ops, (x) => entries.find((y) => y.id === x)?.clip)
      e.clip = { ...r.clip, name: e.clip.name }
      e.stats = measureClip(e.clip)
      e.remix = { base: base.id, baseName: base.name, ops: r.applied, source: 'user' }
      e.updatedAt = Date.now()
      changed()
      return e
    },
    async animRemixMode() {
      return remixMode
    },
    async animSetRemixMode(mode) {
      remixMode = mode
      return mode
    },
    async animRunScript(script, opts) {
      const ex = ANIM_EXAMPLES.find((x) => x.script.trim() === script.trim())
      // Pose names are checked like the compiler does, so the error marker shows on the right line.
      const lines = script.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const m = /a:pose\(\s*"([^"]+)"/.exec(lines[i])
        if (!m || findKitPose(m[1])) continue
        try {
          compileAnim([{ at: 0, line: i + 1, op: 'pose', name: m[1] } as AnimOp], script)
        } catch (e) {
          return { ok: false, error: { message: (e as Error).message, line: i + 1 }, prints: [], warnings: [], summary: '' }
        }
      }
      if (!ex) return { ok: false, error: { message: 'The browser preview has no Lune: only the built-in example scripts run here.', line: 1 }, prints: [], warnings: [], summary: '' }
      const target = opts?.id ? clipRig(find(opts.id).clip) : opts?.rig ?? rig
      const { clip, warnings } = compileAnim(ANIM_RECORDED[ex.key], ex.script, { name: ex.name, rig: target })
      if (opts?.save && opts.id) {
        const e = find(opts.id)
        e.clip = clip
        changed()
        return { ok: true, clip, prints: [], warnings, summary: clipSummary(clip), checks: runChecks(clip), entry: e }
      }
      return { ok: true, clip, prints: [], warnings, summary: clipSummary(clip), checks: runChecks(clip) }
    },
    async animRefine(id, opts) {
      void refine(find(id), opts?.maxIterations ?? 3)
    },
    async animUseIteration(id, n) {
      const e = find(id)
      const it = (e.iterations ?? []).find((x) => x.n === n) ?? bestIteration(e.iterations ?? [])
      if (it) e.clip = it.clip
      e.updatedAt = Date.now()
      changed()
      return e
    },
    async animCancel(id) {
      emit('anim:progress', { entryId: id, iteration: 0, phase: 'done', message: 'Cancelled.' })
    },
    async animChecks(id) {
      const e = find(id)
      return runChecks(e.clip, profileFor(style, e.tags, clipRig(e.clip)))
    },
    async animGetRig() {
      return rig
    },
    async animSetRig(r) {
      rig = r === 'R6' ? 'R6' : 'R15'
      changed()
      return rig
    },
    async animConvert(id, to, opts) {
      const e = find(id)
      const target: RigType = to === 'R6' ? 'R6' : 'R15'
      if (clipRig(e.clip) === target) return { entry: e, warning: `already ${target}` }
      const clip = convertClip(e.clip, target)
      if (opts?.copy) {
        const copy = entry({ ...clip, name: `${clip.name}${target}` }, { id: `${e.id}-${target.toLowerCase()}-${(seq++).toString(36)}`, kind: e.kind, tags: e.tags, origin: e.origin, description: e.description, notes: `Converted from ${clipRig(e.clip)} to ${target}.`, createdAt: Date.now(), updatedAt: Date.now() })
        entries.push(copy)
        changed()
        return { entry: copy, warning: RIG_CONVERT_WARNING[target] }
      }
      e.clip = clip
      e.stats = measureClip(clip)
      e.iterations = []
      e.updatedAt = Date.now()
      changed()
      return { entry: e, warning: RIG_CONVERT_WARNING[target] }
    },
    async animExamples() {
      return ANIM_EXAMPLES.map(({ key, name, description, tags, rig: r }) => ({ key, name, description, tags, rig: r ?? 'R15' }))
    },
    async animAddExample(key) {
      const prev = entries.find((e) => e.origin === `example:${key}`)
      if (prev) return prev
      const e = exampleEntry(key)
      entries.push(e)
      changed()
      return e
    },
    async animFile(id, file) {
      return files.get(`${id}/${file}`) ?? null
    },
    async animSaveThumb(id) {
      return find(id)
    },
    async animExport(id) {
      const e = find(id)
      e.written = { module: `src/shared/Animations/${e.clip.name}/init.luau`, model: `src/shared/Animations/${e.clip.name}/Sequence.rbxmx` }
      changed()
      return { module: e.written.module, model: e.written.model, instancePath: `game.ReplicatedStorage.Shared.Animations.${e.clip.name}`, command: `require(game.ReplicatedStorage.Shared.Animations.${e.clip.name}).play(game.Players.LocalPlayer.Character)` }
    },
    async animUpload() {
      throw new Error('No Open Cloud API key with asset:read + asset:write. Add one on the Art page.')
    },
    async listAnimClips() {
      return entries.filter((e) => e.quality !== 'avoid').map((e) => ({ id: e.id, name: e.name, duration: e.clip.duration, looped: e.clip.looped, markers: e.clip.markers, scope: e.scope, rig: clipRig(e.clip) }))
    },
    async getAnimPose(id, t) {
      const e = entries.find((x) => x.id === id)
      return e ? poseCFrames(e.clip, t) : null
    },
    async getLabModels() {
      return labModels
    },
    async setLabModels(m) {
      labModels = normalizeLabModels(m)
      return labModels
    }
  }
}
