// Lab gating: cheap decisions made in code (and, once they have earned it, by small learned decision
// models) before a big-model call in the VFX Lab, Animation Lab and Ability Composer; a log of every
// decision, shadow mode, and the cost per kept result. Shared by main (services/gating), the renderer
// (Decisions list, Settings > Labs) and the tests. No node or electron imports.

export type LabId = 'vfx' | 'anim' | 'ability' | 'thumbs' | 'uimotion'
export const LAB_IDS: readonly LabId[] = ['vfx', 'anim', 'ability', 'thumbs', 'uimotion']
export const LAB_NAMES: Record<LabId, string> = { vfx: 'VFX Lab', anim: 'Animation Lab', ability: 'Ability Composer', thumbs: 'Thumbnail Lab', uimotion: 'UI Motion Lab' }

// Decision gates: shadow = decide and log, never act (the default for one release); on = act;
// off = do not evaluate (the old behaviour, nothing logged). Principle-weight updates follow the
// same switch: shadow logs the would-be change, only on applies the learned weights to the critics.
export type GateMode = 'shadow' | 'on' | 'off'
export const GATE_MODES: readonly GateMode[] = ['shadow', 'on', 'off']

// Decision models: small learned classifiers (shared/decide, logistic regression) trained in-process
// on Forge's own gate log. off = never consulted; shadow = predict and log next to the heuristic (the
// default); on = the model decides instead of the heuristic, but only once it is active (enough
// labelled examples and better than the heuristic on held-out data).
export type ModelMode = 'off' | 'shadow' | 'on'
export const MODEL_MODES: readonly ModelMode[] = ['off', 'shadow', 'on']

export interface GatingSettings {
  gates: GateMode
  models: ModelMode
  // Labelled examples a decision model needs before it may override the heuristic.
  minExamples: number
}

export const GATING_SETTING = 'labs.gating'
export const DEFAULT_GATING: GatingSettings = { gates: 'shadow', models: 'shadow', minExamples: 50 }

export function normalizeGatingSettings(raw: unknown): GatingSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const gates = GATE_MODES.includes(r.gates as GateMode) ? (r.gates as GateMode) : DEFAULT_GATING.gates
  const models = MODEL_MODES.includes(r.models as ModelMode) ? (r.models as ModelMode) : DEFAULT_GATING.models
  const minExamples = Math.max(10, Math.min(1000, Math.floor(Number(r.minExamples) || DEFAULT_GATING.minExamples)))
  return { gates, models, minExamples }
}

export type GateName = 'critic-skip' | 'plateau' | 'retry' | 'principle-weights'

export const GATE_INFO: Record<GateName, { label: string; does: string }> = {
  'critic-skip': { label: 'Skip critic', does: 'skips the vision critique when the rendered frames barely changed since the last round' },
  plateau: { label: 'Early stop', does: 'stops refining when the score has plateaued or the target is met' },
  retry: { label: 'Retry route', does: 'decides in code whether a failed compose is repaired, re-asked or given up (bounded)' },
  'principle-weights': { label: 'Principle weights', does: 'applies the weights learned from your ratings to the critics' }
}

// One logged decision. `acted` is false in shadow mode (logged only). tokensSaved estimates the
// big-model tokens the outcome avoids (in shadow mode: what acting would have saved).
export interface GateDecision {
  id: string
  at: number
  lab: LabId
  entryId?: string
  gate: GateName
  mode: GateMode
  // Short summary of what the gate looked at ("diff 0.4%, hash 2/64, prev 6.8").
  inputs: string
  outcome: string
  acted: boolean
  // Who decided: the code heuristic, or the learned decision model (active and models on).
  by: 'code' | 'model'
  // Code was in a grey zone (the conservative default won unless a model decided).
  unsure?: boolean
  // The decision model's probability of the gate's positive class, when it ran.
  modelP?: number
  // The model's outcome when it differs from the one taken (shadow comparison).
  modelSays?: string
  tokensSaved: number
}

// Token / cost accounting per lab run (one entry: compose + refine, or one critique).
export type CostTier = 'cheap' | 'default' | 'critic'
export const COST_TIERS: readonly CostTier[] = ['cheap', 'default', 'critic']

export interface TierUsage {
  calls: number
  input: number
  output: number
  costUsd: number
  // Calls with no price (tokens still counted).
  unpriced: number
}

export interface LabRun {
  lab: LabId
  entryId: string
  at: number
  updatedAt: number
  tiers: Partial<Record<CostTier, TierUsage>>
  // The user kept the result: rated it up, saved or exported it.
  kept: boolean
  keptAt?: number
}

export interface LabCostRow {
  lab: LabId
  runs: number
  kept: number
  costUsd: number
  tokens: number
  // null when nothing was kept yet.
  costPerKept: number | null
  tokensPerKept: number | null
  tiers: Partial<Record<CostTier, { calls: number; costUsd: number; tokens: number; costPerKept: number | null }>>
  // Estimated tokens the gates saved (acted) and would have saved (shadow).
  saved: number
  wouldSave: number
  decisions: number
  unpriced: number
}

// The learned decision models, one per gate. Labels come from what Forge observes afterwards.
export type DecisionType = 'critic-skip' | 'plateau' | 'retry'
export const DECISION_TYPES: readonly DecisionType[] = ['critic-skip', 'plateau', 'retry']
export const DECISION_INFO: Record<DecisionType, { label: string; question: string }> = {
  'critic-skip': { label: 'Critique worth it', question: 'will this critique round move the score by at least 0.25?' },
  plateau: { label: 'Another round helps', question: 'will one more round raise the score by at least 0.25?' },
  retry: { label: 'Repair succeeds', question: 'will a repair of this failed compose work?' }
}

// "Learning (n/50)", "Active, 87% vs heuristic 79%" (held-out accuracy), or trained but not better
// than the heuristic (the heuristic keeps deciding).
export interface DecisionModelStatus {
  type: DecisionType
  state: 'learning' | 'active' | 'not-better'
  labelled: number
  pending: number
  needed: number
  modelAcc?: number
  heuristicAcc?: number
  holdout?: number
  trainedAt?: number
}

export interface GatingView {
  settings: GatingSettings
  models: DecisionModelStatus[]
  costs: LabCostRow[]
  decisions: GateDecision[]
}

export interface GatingEvents {
  'labs:gating': { lab?: LabId; entryId?: string; at: number }
}

export interface GatingApi {
  // Settings, decision models, the cost table and recent decisions (lab / entry filter).
  labGatingView(filter?: { lab?: LabId; entryId?: string; limit?: number }): Promise<GatingView>
  labGatingSet(patch: Partial<GatingSettings>): Promise<GatingSettings>
  // Retrains the decision models from the labelled gate log now.
  labGatingRetrain(): Promise<GatingView>
  // Clears the decision log and the cost table (the labelled examples and models stay).
  labGatingReset(): Promise<GatingView>
}
