// Per-task model tiers for the Labs (VFX Lab, Animation Lab, Ability Composer). Stored in the
// settings store under LAB_MODELS_SETTING; an empty value means automatic:
//   cheap   -> the provider's cheap tier (budget.ts TIER_DEFAULTS / modelTiers): tagging, import
//              summaries, reflection after ratings, retrieval and ranking text.
//   default -> the user's chosen chat model: drafting scripts (compose) and script repair.
//   critic  -> the provider's big tier: the vision critique at key beats and the final pass.
// A call whose model fails (a subscription without the flagship model, a default model on a provider
// with no key, Codex not signed in) moves on to the default model and then to the last chat model
// that answered (agent/index.ts oneShot); when none answers, the lab shows the error.

export type LabTier = 'cheap' | 'default' | 'critic'
export const LAB_TIERS: readonly LabTier[] = ['cheap', 'default', 'critic']
export const LAB_MODELS_SETTING = 'labs.models'
// The last chat model that answered a turn ({ provider, model }): the Labs fall back to it when the
// default model or a tier model does not work, so they use whatever chat uses.
export const LAST_CHAT_MODEL_SETTING = 'labs.lastChatModel'

export interface LabModels {
  cheap?: string
  default?: string
  critic?: string
}

export const LAB_TIER_INFO: Record<LabTier, { label: string; uses: string; auto: string }> = {
  cheap: { label: 'Cheap', uses: 'auto-tagging, import summaries, reflection after ratings, retrieval and ranking', auto: "provider's cheap tier" },
  default: { label: 'Default', uses: 'drafting scripts (compose) and script repair', auto: 'your chat model' },
  critic: { label: 'Critic', uses: 'vision critique at key beats and the final pass', auto: "provider's flagship tier" }
}

export function normalizeLabModels(raw: unknown): LabModels {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: LabModels = {}
  for (const t of LAB_TIERS) {
    const v = typeof r[t] === 'string' ? (r[t] as string).trim().slice(0, 120) : ''
    if (v) out[t] = v
  }
  return out
}

// The model for a tier: the Labs setting when set, else the automatic choice. `tiers` is the
// provider's cheap/big pair (budget.ts tiersFor), null when the provider has none (Ollama, custom).
export function resolveLabModel(tier: LabTier, labs: LabModels | null | undefined, chosen: string, tiers: { cheap: string; big: string } | null): string {
  const set = normalizeLabModels(labs)[tier]
  if (set) return set
  if (tier === 'cheap') return tiers?.cheap ?? chosen
  if (tier === 'critic') return tiers?.big ?? chosen
  return chosen
}

// Small / fast model ids (Haiku, mini, nano, flash-lite, small open models): fine for tagging and
// summaries, but they write sparse effects (two or three layers) and "simplify" rich ones when they
// draft or critique. The Labs settings and the VFX Lab say so; nothing switches models on its own.
export function isSmallModel(id: string | null | undefined): boolean {
  const m = String(id ?? '').toLowerCase()
  if (!m) return false
  return /haiku|(^|[-_.:/])(mini|nano|lite|small|tiny)([-_.:/]|$)|flash-lite|-8b\b|:8b\b|\b[1-9]b\b|gemma|phi-?\d/.test(m)
}

// The hint for a Labs tier whose model is small (null when it is not).
export function smallModelHint(tier: LabTier, model: string | null | undefined): string | null {
  if (tier === 'cheap' || !isSmallModel(model)) return null
  return tier === 'default'
    ? `Drafting on a small model (${model}): it tends to write sparse effects and hide layers of your library copies. Pick a larger model here for richer effects.`
    : `Critiquing on a small model (${model}): it tends to prefer the sparsest variation. Pick a larger model here for a better critic.`
}
