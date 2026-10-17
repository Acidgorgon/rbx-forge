// What a model can do: which reasoning-effort levels it takes and whether it reads images.
// Shared by main (request mapping, routing, vision gating) and the renderer (effort picker, attach
// button). Pure functions, no I/O. Runtime metadata (OpenRouter's /models list, Ollama's
// /api/show capabilities) overrides the static tables when the main process has fetched it.
//
// Sources (checked 2026-10-13):
// - Anthropic effort: platform.claude.com/docs/en/build-with-claude/effort. Every level on Opus 5.5,
//   Sonnet 5.5, Haiku 5.5, Opus 5, Sonnet 5, Opus 4.8/4.7, Fable 5/5.1, Mythos 5/5.1; no xhigh on
//   Mythos Preview, Opus 4.6, Sonnet 4.6; Opus 4.5 low/medium/high only. Default medium on Opus 5.5
//   and Haiku 5.5, high elsewhere. Claude models all take image input.
// - OpenAI (developers.openai.com/api/docs/models/*): gpt-6.1-sol and gpt-6-astra take
//   reasoning.effort low|medium|high|xhigh|max; gpt-5.6-terra none..max (default medium);
//   gpt-6-luna supports function calling on Chat Completions "only with reasoning_effort set to
//   none", so its chat (which always sends tools) has no effort choice. All four take image input.
// - Gemini OpenAI compatibility (ai.google.dev/gemini-api/docs/openai): reasoning_effort
//   low|medium|high, mapped to thinking_level (Gemini 3) or thinking_budget (2.5). Images as
//   image_url data URLs.
// - OpenRouter (openrouter.ai/docs/use-cases/reasoning-tokens): reasoning.effort max|xhigh|high|
//   medium|low|minimal|none; GET /models may return reasoning.supported_efforts (null = all).
// - Ollama: OpenAI-compatible endpoint takes base64 images only; /api/show lists "vision" in
//   capabilities for vision models (docs.ollama.com/api/openai-compatibility, ollama docs/api.md).

import type { ProviderId } from './types'

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]
// 'auto' = no explicit choice: the router picks (or the provider default applies).
export type EffortChoice = 'auto' | EffortLevel

export function isEffortChoice(v: unknown): v is EffortChoice {
  return v === 'auto' || (EFFORT_LEVELS as readonly string[]).includes(v as string)
}

export const EFFORT_LABEL: Record<EffortChoice, string> = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max' }
export const EFFORT_SHORT: Record<EffortChoice, string> = { auto: 'Auto', low: 'Low', medium: 'Med', high: 'High', xhigh: 'XHigh', max: 'Max' }

// Metadata fetched at runtime for one model (main/agent/providers.ts).
export interface ModelMeta {
  vision?: boolean
  // OpenRouter reasoning.supported_efforts: null = every value; undefined = not exposed.
  efforts?: string[] | null
  // Context window in tokens, when the provider lists it (OpenRouter context_length).
  contextWindow?: number
}

export interface EffortSupport {
  // Empty: the picker is hidden and no effort is sent.
  levels: EffortLevel[]
  // The provider's own default when no effort is sent (for display), when documented.
  default?: EffortLevel
}

const ALL: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const NO_XHIGH: EffortLevel[] = ['low', 'medium', 'high', 'max']
const BASIC: EffortLevel[] = ['low', 'medium', 'high']
const NONE: EffortSupport = { levels: [] }

function bare(model: string): string {
  return (model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model).toLowerCase()
}

// Claude ids: "claude-opus-5-5", "claude-sonnet-4-6", "anthropic/claude-haiku-5.5".
export function claudeEffort(model: string): EffortSupport {
  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(preview|\d+(?:[.-]\d+)?)/.exec(bare(model))
  if (!m) return NONE
  const family = m[1]
  if (m[2] === 'preview') return family === 'mythos' ? { levels: NO_XHIGH, default: 'high' } : NONE
  const v = Number(m[2].replace('-', '.'))
  if (family === 'haiku') return v >= 5.5 ? { levels: ALL, default: 'medium' } : NONE
  if (family === 'fable' || family === 'mythos') return v >= 5 ? { levels: ALL, default: 'high' } : NONE
  if (family === 'opus') {
    if (v >= 5.5) return { levels: ALL, default: 'medium' }
    if (v >= 4.7) return { levels: ALL, default: 'high' }
    if (v >= 4.6) return { levels: NO_XHIGH, default: 'high' }
    if (v >= 4.5) return { levels: BASIC, default: 'high' }
    return NONE
  }
  // sonnet
  if (v >= 5) return { levels: ALL, default: 'high' }
  if (v >= 4.6) return { levels: NO_XHIGH, default: 'high' }
  return NONE
}

function openAiEffort(model: string): EffortSupport {
  const id = bare(model)
  // Chat with tools on Chat Completions: luna only accepts reasoning_effort "none".
  if (/^gpt-6-luna/.test(id)) return NONE
  if (/^gpt-6(\.\d+)?-(sol|astra)/.test(id)) return { levels: ALL, default: 'medium' }
  if (/^gpt-5\.6-terra/.test(id)) return { levels: ALL, default: 'medium' }
  if (/^(gpt-5|o[134])/.test(id)) return { levels: BASIC, default: 'medium' }
  return NONE
}

function geminiEffort(model: string): EffortSupport {
  return /^gemini-(2\.5|[3-9])/.test(bare(model)) ? { levels: BASIC } : NONE
}

// Levels a model takes, from runtime metadata when there is some, else the static tables.
export function effortSupport(provider: ProviderId, model: string, meta?: ModelMeta): EffortSupport {
  if (!model) return NONE
  switch (provider) {
    case 'anthropic':
      return claudeEffort(model)
    case 'openai':
      return openAiEffort(model)
    case 'gemini':
      return geminiEffort(model)
    case 'openrouter': {
      if (meta && 'efforts' in meta) {
        if (meta.efforts === undefined) return NONE
        if (meta.efforts === null) return { levels: ALL }
        return { levels: ALL.filter((l) => meta.efforts!.includes(l)) }
      }
      const vendor = model.includes('/') ? model.slice(0, model.indexOf('/')).toLowerCase() : ''
      if (vendor === 'anthropic') return claudeEffort(model)
      if (vendor === 'openai') return openAiEffort(model)
      if (vendor === 'google') return geminiEffort(model)
      return NONE
    }
    default:
      // Ollama and custom endpoints: model-defined names, not exposed.
      return NONE
  }
}

// The level to send for a choice: an explicit level (clamped to what the model takes), or for
// 'auto' the router's pick. Undefined = send nothing (provider default).
export function clampEffort(level: EffortLevel | undefined, levels: EffortLevel[]): EffortLevel | undefined {
  if (!level || !levels.length) return undefined
  if (levels.includes(level)) return level
  const i = ALL.indexOf(level)
  // Nearest lower supported level, else the lowest supported one.
  for (let j = i - 1; j >= 0; j--) if (levels.includes(ALL[j])) return ALL[j]
  return levels[0]
}

// Effort the auto-router uses with a tier: cheap turns think little, big tasks think hard,
// everything else keeps the model's default.
export function autoEffort(tier: 'cheap' | 'big' | 'chosen', support: EffortSupport): EffortLevel | undefined {
  if (tier === 'cheap') return clampEffort('low', support.levels)
  if (tier === 'big') return clampEffort('high', support.levels)
  return undefined
}

// "auto → sonnet · med", "opus · high". `model` is the effective model id.
export function routeSummary(route: { model: string; tier: string; effort?: string } | undefined, choice: EffortChoice, fallbackDefault?: EffortLevel): string {
  if (!route) return ''
  const name = shortName(route.model)
  const eff = (route.effort ?? fallbackDefault) as EffortChoice | undefined
  const effText = eff && isEffortChoice(eff) ? ` · ${EFFORT_SHORT[eff].toLowerCase()}` : ''
  const auto = route.tier !== 'chosen' || choice === 'auto'
  return `${auto ? 'auto → ' : ''}${name}${effText}`
}

// "claude-sonnet-5-5" -> "sonnet", "gpt-6.1-sol" -> "sol", "gemini-3.1-pro-preview" -> "gemini-3.1-pro".
export function shortName(model: string): string {
  const id = bare(model)
  const claude = /^claude-(\w+)/.exec(id)
  if (claude) return claude[1]
  const gpt = /^gpt-[\d.]+-(\w+)/.exec(id)
  if (gpt) return gpt[1]
  return id.replace(/-preview$/, '')
}

// ---------------------------------------------------------------- vision

const VISION_NAME = /llava|bakllava|vision|-vl\b|-vl[:\-.]|vl:|qwen\d(\.\d)?-?vl|gemma3|gemma-3|minicpm-v|moondream|pixtral|granite3?\.?\d*-vision|mistral-small3\.[12]|llama4/i

export function supportsVision(provider: ProviderId, model: string, meta?: ModelMeta): boolean {
  if (!model) return false
  if (meta && typeof meta.vision === 'boolean') return meta.vision
  const id = bare(model)
  switch (provider) {
    case 'anthropic':
      return /^claude-/.test(id)
    case 'openai':
      return /^(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-[5-9]|chatgpt-4o|o[134])/.test(id)
    case 'gemini':
      return /^gemini-/.test(id)
    case 'openrouter':
      return /^claude-|^gpt-4o|^gpt-4\.1|^gpt-[5-9]|^o[34]|^gemini-/.test(id) || VISION_NAME.test(id)
    case 'ollama':
    case 'custom':
      return VISION_NAME.test(id)
    case 'codex':
      // codex exec --image: every Codex model takes images.
      return true
  }
  return false
}

export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type ImageMime = (typeof IMAGE_MIMES)[number]
// Long edge images are scaled down to before sending (Anthropic's recommended maximum).
export const IMAGE_MAX_EDGE = 1568
export const MAX_IMAGES_PER_MESSAGE = 8
