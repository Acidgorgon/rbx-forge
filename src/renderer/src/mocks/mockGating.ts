// Browser-preview mock of GatingApi: a seeded decision log for the three labs, a cost table built
// with the real shared accounting (shared/gating/costs.ts) and decision models trained with the real
// shared code (shared/decide) on synthetic examples, so Settings > Labs shows one model active and
// two still learning.
import type { GateDecision, GatingApi, GatingSettings, GatingView, HarnessEvents, LabId, LabRun, DecisionModelStatus } from '@shared/types'
import { chargeRun, costRows, markKept } from '@shared/gating/costs'
import { DECISION_TYPES, normalizeGatingSettings } from '@shared/gating/types'
import { isActive, trainDecisionModel, type Example } from '@shared/decide/model'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

const t0 = Date.UTC(2026, 9, 13, 15, 0)
let settings: GatingSettings = normalizeGatingSettings({})

function seedRuns(): LabRun[] {
  let runs: LabRun[] = []
  const add = (lab: LabId, id: string, critic: number, def: number, cheap: number, kept: boolean, i: number) => {
    const at = t0 + i * 600_000
    runs = chargeRun(runs, lab, id, 'default', { input: def * 3200, output: def * 1700, costUsd: def * 0.034 }, at)
    for (let k = 0; k < critic; k++) runs = chargeRun(runs, lab, id, 'critic', { input: 5200, output: 640, costUsd: 0.078 }, at + k)
    if (cheap) runs = chargeRun(runs, lab, id, 'cheap', { input: 900, output: 120, costUsd: 0.0011 }, at)
    if (kept) runs = markKept(runs, lab, id, true, at + 1000)
  }
  add('vfx', 'vfx-hollow-purple', 4, 1, 1, true, 0)
  add('vfx', 'vfx-fire-slash', 3, 2, 0, true, 1)
  add('vfx', 'vfx-ground-slam', 4, 1, 0, false, 2)
  add('vfx', 'vfx-ice-burst', 2, 1, 1, false, 3)
  add('anim', 'anim-heavy-punch', 4, 1, 1, true, 4)
  add('anim', 'anim-spin-kick', 3, 1, 0, false, 5)
  add('ability', 'ability-dash-punch', 1, 1, 0, true, 6)
  return runs
}

function seedDecisions(): GateDecision[] {
  const d = (i: number, lab: LabId, entryId: string, gate: GateDecision['gate'], inputs: string, outcome: string, tokensSaved: number, extra: Partial<GateDecision> = {}): GateDecision => ({ id: `seed-${i}`, at: t0 + i * 240_000, lab, entryId, gate, mode: 'shadow', inputs, outcome, acted: false, by: 'code', tokensSaved, ...extra })
  return [
    d(1, 'vfx', 'vfx-hollow-purple', 'critic-skip', 'frames changed (diff 6.2%, hash 14/64); round 2, prev 6.4', 'critique', 0),
    d(2, 'vfx', 'vfx-hollow-purple', 'plateau', 'improving (6.4 > 7.1); 2 rounds left', 'continue', 0),
    d(3, 'vfx', 'vfx-hollow-purple', 'critic-skip', 'frames unchanged (diff 0.6%, hash 2/64); round 3, prev 7.1', 'would skip critic', 2318, { modelP: 0.18 }),
    d(4, 'vfx', 'vfx-ground-slam', 'plateau', 'plateau (6.8 > 6.9 > 6.9); 1 round left', 'would stop', 2318, { modelP: 0.22 }),
    d(5, 'vfx', 'vfx-ground-slam', 'retry', 'script-error: attempt to index nil with \'Emit\' (line 14); 0 repairs so far', 'retry', 0),
    d(6, 'anim', 'anim-heavy-punch', 'critic-skip', 'small change (diff 2.1%, hash 6/64); round 2, prev 6.9', 'critique', 0, { unsure: true, modelP: 0.61 }),
    d(7, 'anim', 'anim-spin-kick', 'retry', 'no-script: no script in the answer; 0 repairs so far', 'would rephrase (did give-up)', 0),
    d(8, 'anim', 'anim-spin-kick', 'principle-weights', 'arcs 1.00→1.24, weight-impact 1.00→1.12', 'would apply', 0),
    d(9, 'ability', 'ability-dash-punch', 'critic-skip', 'frames unchanged (diff 0.3%, hash 0/64); round 1, prev 7.2', 'would skip critic', 1534, { modelSays: 'critique', modelP: 0.55 })
  ]
}

// Synthetic labelled examples: the critique only mattered when the frames moved.
function syntheticExamples(n: number, seed = 7): Example[] {
  let x = seed
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647)
  return Array.from({ length: n }, (_, i) => {
    const diff = rnd() * 0.08
    const prevScore = 5 + rnd() * 3
    const label = diff + (rnd() - 0.5) * 0.03 > 0.025 ? 1 : 0
    return { id: `x${i}`, at: t0 + i, features: { diff, hash: diff * 4, prev_score: prevScore / 10, iteration: 2 + (i % 3) }, heuristic: diff > 0.06 ? 1 : 0, label }
  })
}

const criticModel = trainDecisionModel('critic-skip', ['no', 'yes'], syntheticExamples(64), t0)
let decisions = seedDecisions()
let runs = seedRuns()

function models(): DecisionModelStatus[] {
  return DECISION_TYPES.map((type) => {
    if (type === 'critic-skip' && criticModel) {
      return { type, state: isActive(criticModel, settings.minExamples) ? 'active' : 'not-better', labelled: criticModel.n, pending: 2, needed: settings.minExamples, modelAcc: criticModel.holdout.modelAcc, heuristicAcc: criticModel.holdout.heuristicAcc, holdout: criticModel.holdout.n, trainedAt: criticModel.trainedAt }
    }
    return { type, state: 'learning', labelled: type === 'plateau' ? 23 : 6, pending: 1, needed: settings.minExamples }
  })
}

function view(filter: { lab?: LabId; entryId?: string; limit?: number } = {}): GatingView {
  let ds = decisions.filter((d) => (!filter.lab || d.lab === filter.lab) && (!filter.entryId || d.entryId === filter.entryId))
  // Preview: an entry with no seeded decisions shows its lab's seeds (the mock libraries use other ids).
  if (filter.entryId && !ds.length) ds = decisions.filter((d) => !filter.lab || d.lab === filter.lab).map((d) => ({ ...d, entryId: filter.entryId }))
  return { settings, models: models(), costs: costRows(runs, decisions), decisions: ds.slice(-(filter.limit ?? 40)).reverse() }
}

export function gatingMock(emit: Emit): GatingApi {
  const changed = () => emit('labs:gating', { at: Date.now() })
  return {
    async labGatingView(filter) {
      return view(filter ?? {})
    },
    async labGatingSet(patch) {
      settings = normalizeGatingSettings({ ...settings, ...(patch ?? {}) })
      changed()
      return settings
    },
    async labGatingRetrain() {
      changed()
      return view()
    },
    async labGatingReset() {
      decisions = []
      runs = []
      changed()
      return view()
    }
  }
}
