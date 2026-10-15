// Per-task model tiers for the Labs (VFX Lab, Animation Lab, Ability Composer). Stored in the
// settings store under LAB_MODELS_SETTING; an empty value means automatic:
//   cheap   -> the provider's cheap tier (budget.ts TIER_DEFAULTS / modelTiers): tagging, import
//              summaries, reflection after ratings, retrieval and ranking text.
//   default -> the user's chosen chat model: drafting scripts (compose) and script repair.
//   critic  -> the provider's big tier: the vision critique at key beats and the final pass.
// A call whose model fails (a subscription without the flagship model, a default model on a provider
// with no key, Codex not signed in) moves on to the default model and then to the last chat model
// that answered (agent/index.ts oneShot); when none answers, the lab shows the error.

import type { ProviderId } from './types.ts'

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

// ---- Settings > Labs model dropdowns ----------------------------------------------------------

// What the Labs model dropdowns need from main (agent/index.ts labModelInfo): what "auto" means
// right now per tier, each provider's cheap / flagship pair (for the tier hints), and the models a
// Labs call was refused on recently (a 403 on the flagship tier, a model the account cannot use).
export interface LabModelInfo {
  // The default model's provider: the provider the tier ids are sent to first.
  provider: ProviderId
  // The model each tier uses when its setting is empty.
  auto: Record<LabTier, string>
  // budget.ts tiersFor per provider (with Settings overrides); absent for Ollama / custom.
  tiers: Partial<Record<ProviderId, { cheap: string; big: string }>>
  // Recent non-transient failures of one-shot (Labs) calls; skipped by the fallback chain until `until`.
  rejected: { provider: ProviderId; model: string; message: string; until: number }[]
}

export type LabModelHint = 'cheap' | 'balanced' | 'flagship'

const FLAGSHIP = /opus|astra|(^|[-_.:/])(pro|ultra|max)([-_.:/]|$)/i

// A short tier hint for a model id: the provider's cheap / flagship pair when it is one of them,
// else by name. Ollama and custom endpoints (no tier pair) only get "cheap" for small models.
export function labModelHint(model: string, tiers: { cheap: string; big: string } | null | undefined): LabModelHint | null {
  if (tiers?.cheap === model) return 'cheap'
  if (tiers?.big === model) return 'flagship'
  if (isSmallModel(model) || /luna|flash-lite/i.test(model)) return 'cheap'
  if (!tiers) return null
  return FLAGSHIP.test(model) ? 'flagship' : 'balanced'
}

export interface LabModelOption {
  provider: ProviderId
  model: string
  hint: LabModelHint | null
  // The error a Labs call got on this model recently (it is skipped for now), when there is one.
  rejected?: string
}

export interface LabModelGroup {
  provider: ProviderId
  label: string
  // True for the default model's provider: tier ids go there first.
  primary: boolean
  options: LabModelOption[]
}

// The dropdown's model groups: every ready provider's models (the chat picker's list), the default
// model's provider first. Codex is left out: Labs calls on Codex always use the Codex model itself,
// so a Labs model id is never sent there.
export function labModelGroups(
  providers: readonly { id: ProviderId; label: string; ready: boolean; models: readonly string[] }[] | null | undefined,
  info: LabModelInfo | null | undefined,
  fetched: Partial<Record<ProviderId, readonly string[]>> = {}
): LabModelGroup[] {
  const now = Date.now()
  const rejected = new Map((info?.rejected ?? []).filter((r) => r.until > now).map((r) => [`${r.provider}:${r.model}`, r.message]))
  const ready = (providers ?? []).filter((p) => p.ready && p.id !== 'codex')
  const primary = info?.provider
  ready.sort((a, b) => Number(b.id === primary) - Number(a.id === primary))
  return ready
    .map((p) => {
      const models = [...new Set((fetched[p.id] ?? p.models).filter(Boolean))]
      return {
        provider: p.id,
        label: p.label,
        primary: p.id === primary,
        options: models.map((model) => {
          const why = rejected.get(`${p.id}:${model}`)
          return { provider: p.id, model, hint: labModelHint(model, info?.tiers[p.id]), ...(why ? { rejected: why } : {}) }
        })
      }
    })
    .filter((g) => g.options.length)
}

// What a stored tier value shows as: empty = Auto; an id listed by a provider = that model (the
// default provider's entry when several list it); anything else = "Custom: <id>".
export type LabModelSelection = { kind: 'auto' } | { kind: 'model'; option: LabModelOption } | { kind: 'custom'; model: string }

export function labModelSelection(value: string | null | undefined, groups: readonly LabModelGroup[]): LabModelSelection {
  const v = String(value ?? '').trim()
  if (!v) return { kind: 'auto' }
  for (const g of groups) {
    const option = g.options.find((o) => o.model === v)
    if (option) return { kind: 'model', option }
  }
  return { kind: 'custom', model: v }
}

// The recent rejection of a model on the default provider (for the Auto entry), if any.
export function labRejection(info: LabModelInfo | null | undefined, model: string, provider: ProviderId | undefined = info?.provider): string | null {
  const now = Date.now()
  return info?.rejected.find((r) => r.provider === provider && r.model === model && r.until > now)?.message ?? null
}

// Short display form of a model id ("claude-haiku-5-5" -> "haiku-5-5"), as the chat picker shows it.
export function shortModelId(model: string): string {
  return model.replace(/^.*\//, '').replace(/^claude-/, '').replace(/-\d{8}$/, '')
}
