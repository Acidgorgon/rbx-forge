// Provider catalogue, readiness, endpoints and model lists.
//
// Endpoints (checked against each provider's docs, Oct 2026):
//   openai      https://api.openai.com/v1                                  Bearer key
//   openrouter  https://openrouter.ai/api/v1                               Bearer key (+ optional X-OpenRouter-Title)
//   gemini      https://generativelanguage.googleapis.com/v1beta/openai    Bearer key (OpenAI compatibility)
//   ollama      http://localhost:11434/v1                                  no key for a local server
//   custom      any OpenAI-compatible base URL                             optional Bearer key
// All of them take POST {base}/chat/completions with stream + tools and list models at GET {base}/models.

import type { ModelChoice, ProviderId, ProviderInfo } from '@shared/types'
import { PROVIDER_IDS } from '../../shared/types.ts'
import type { HarnessContext } from '../context.ts'
import { maskKey, type Credentials } from './credentials.ts'
import { clampEffort, effortSupport, type EffortLevel, type ModelMeta } from '../../shared/modelCaps.ts'
import { DEFAULT_MODEL } from './sdk.ts'
import { CODEX_DEFAULT_MODEL } from './codex/args.ts'
import { codexService, type CodexService } from './codex/service.ts'

export type FetchFn = typeof fetch

interface ProviderDef {
  label: string
  // Fixed base URL, or the default for editable ones.
  baseUrl?: string
  editableBaseUrl?: boolean
  needsKey: boolean
  defaults: string[]
}

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  anthropic: { label: 'Anthropic', needsKey: true, defaults: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true, defaults: ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-6-luna', 'gpt-6.1-sol'] },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    defaults: ['anthropic/claude-sonnet-5.5', 'openai/gpt-6-astra', 'google/gemini-3.8-flash']
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    needsKey: true,
    defaults: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview']
  },
  ollama: { label: 'Ollama', baseUrl: 'http://localhost:11434/v1', editableBaseUrl: true, needsKey: false, defaults: ['qwen3.8', 'qwen3.6', 'llama3.1'] },
  custom: { label: 'Custom (OpenAI-compatible)', editableBaseUrl: true, needsKey: false, defaults: [] },
  // The user's Codex CLI signed in with ChatGPT (agent/codex). codex-default = no --model (the
  // model set in the user's Codex config); the others are passed as --model.
  codex: { label: 'Codex (ChatGPT plan)', needsKey: false, defaults: [CODEX_DEFAULT_MODEL, 'gpt-6.1-sol', 'gpt-6-astra'] }
}

const CONFIG_SETTING = 'providerConfig'
const DEFAULT_SETTING = 'defaultModel'
const MODELS_TTL = 10 * 60_000
const REACH_TTL = 15_000

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === 'string' && (PROVIDER_IDS as string[]).includes(v)
}

// Model ids from GET /models that are not chat models.
const NON_CHAT = /embed|tts|whisper|transcri|dall-e|image|moderation|realtime|audio|search|davinci|babbage|sora|veo|imagen|aqa|computer-use|-live|lyria/i

// Extra request fields per model, from the providers' docs. `effort` is the reasoning effort for
// this request (explicit or routed); it is clamped to what the model takes and dropped when the
// model takes none (see shared/modelCaps.ts).
//   openai      reasoning_effort (Chat Completions); responsesLoop.ts turns it into reasoning.effort
//   gemini      reasoning_effort low|medium|high (OpenAI compatibility -> thinking_level/budget)
//   openrouter  reasoning: { effort }
export function extraBody(provider: ProviderId, model: string, effort?: EffortLevel, meta?: ModelMeta): Record<string, unknown> {
  const level = clampEffort(effort, effortSupport(provider, model, meta).levels)
  // OpenAI: "Chat Completions supports function calling only with reasoning_effort set to none" (GPT-6 Luna).
  // gpt-6.1-sol runs on the Responses API (responsesLoop.ts), which drops these Chat Completions
  // fields; sol rejects reasoning_effort "none" anyway.
  // Chat Completions only reports usage when asked (stream_options.include_usage).
  if (provider === 'openai' && /^gpt-6-luna/.test(model)) return { reasoning_effort: 'none', stream_options: { include_usage: true } }
  if (provider === 'openai') return { stream_options: { include_usage: true }, ...(level ? { reasoning_effort: level } : {}) }
  if (provider === 'gemini' && level) return { reasoning_effort: level }
  if (provider === 'openrouter' && level) return { reasoning: { effort: level } }
  return {}
}

// Agent SDK options for an effort (Options.effort in @anthropic-ai/claude-agent-sdk 0.3.296:
// 'low' | 'medium' | 'high' | 'xhigh' | 'max', "works with adaptive thinking to guide thinking depth").
export function sdkEffortOptions(model: string, effort?: EffortLevel): { effort?: EffortLevel } {
  const level = clampEffort(effort, effortSupport('anthropic', model).levels)
  return level ? { effort: level } : {}
}

export interface Endpoint {
  provider: ProviderId
  baseUrl: string
  headers: Record<string, string>
}

export class Providers {
  private ctx: HarnessContext
  private credentials: Credentials
  private fetchFn: FetchFn
  private modelCache = new Map<ProviderId, { at: number; models: string[] }>()
  private reach = new Map<string, { at: number; ok: boolean }>()
  // Runtime model metadata (OpenRouter /models, Ollama /api/show), by provider then model id.
  private meta = new Map<ProviderId, Map<string, ModelMeta>>()

  private codex: () => CodexService

  constructor(ctx: HarnessContext, credentials: Credentials, fetchFn: FetchFn = (...a) => fetch(...a), codex: () => CodexService = codexService) {
    this.ctx = ctx
    this.credentials = credentials
    this.fetchFn = fetchFn
    this.codex = codex
  }

  baseUrl(provider: ProviderId): string | undefined {
    const def = PROVIDERS[provider]
    if (!def.editableBaseUrl) return def.baseUrl
    const cfg = this.ctx.getSetting<Partial<Record<ProviderId, { baseUrl?: string }>>>(CONFIG_SETTING, {})
    const v = cfg?.[provider]?.baseUrl?.trim()
    return (v || def.baseUrl)?.replace(/\/+$/, '')
  }

  setConfig(provider: ProviderId, config: { baseUrl?: string }): void {
    if (!PROVIDERS[provider].editableBaseUrl) throw new Error(`${provider} has a fixed base URL`)
    const cfg = { ...this.ctx.getSetting<Record<string, { baseUrl?: string }>>(CONFIG_SETTING, {}) }
    const url = config.baseUrl?.trim()
    if (url && !/^https?:\/\//i.test(url)) throw new Error('Base URL must start with http:// or https://')
    cfg[provider] = { ...cfg[provider], baseUrl: url || undefined }
    this.ctx.setSetting(CONFIG_SETTING, cfg)
    this.modelCache.delete(provider)
  }

  defaultModel(): ModelChoice {
    const v = this.ctx.getSetting<ModelChoice | null>(DEFAULT_SETTING, null)
    if (v && isProviderId(v.provider) && typeof v.model === 'string' && v.model) return v
    // Older settings: a bare 'model' string for the anthropic provider.
    const legacy = this.ctx.getSetting<string>('model', DEFAULT_MODEL) || DEFAULT_MODEL
    return { provider: 'anthropic', model: legacy }
  }

  setDefaultModel(provider: ProviderId, model: string): void {
    if (!isProviderId(provider) || !model.trim()) throw new Error('invalid model choice')
    this.ctx.setSetting(DEFAULT_SETTING, { provider, model: model.trim() })
  }

  // Endpoint and headers for an OpenAI-compatible provider, or why it cannot be used.
  async endpoint(provider: ProviderId): Promise<Endpoint | { error: string }> {
    if (provider === 'anthropic') return { error: 'anthropic uses the Agent SDK' }
    if (provider === 'codex') return { error: 'Codex (ChatGPT plan) runs only as the chat agent and for one-shot calls. Pick another model here.' }
    const baseUrl = this.baseUrl(provider)
    if (!baseUrl) return { error: `Set a base URL for ${PROVIDERS[provider].label} in Settings.` }
    const key = await this.credentials.getKey(provider)
    if (PROVIDERS[provider].needsKey && !key) return { error: `Add a ${PROVIDERS[provider].label} API key in Settings.` }
    const headers: Record<string, string> = {}
    if (key) headers.Authorization = `Bearer ${key}`
    if (provider === 'openrouter') {
      // Optional app attribution header (openrouter.ai/docs/api/reference/overview).
      headers['X-OpenRouter-Title'] = 'RBX Forge'
    }
    return { provider, baseUrl, headers }
  }

  async info(provider: ProviderId): Promise<ProviderInfo> {
    const def = PROVIDERS[provider]
    const info: ProviderInfo = {
      id: provider,
      label: def.label,
      ready: false,
      needsKey: def.needsKey,
      models: this.cachedModels(provider)
    }
    const known = this.meta.get(provider)
    if (known?.size) info.meta = Object.fromEntries(known)
    if (provider === 'codex') {
      const svc = this.codex()
      const s = await svc.status()
      info.ready = s.installed && s.loggedIn
      info.detail = s.detail
      info.codex = { installed: s.installed, loggedIn: s.loggedIn, ...(s.method ? { method: s.method } : {}), ...(s.version ? { version: s.version } : {}), ...(s.path ? { path: s.path } : {}), ...(svc.signingInNow() ? { signingIn: true } : {}) }
      return info
    }
    const source = await this.credentials.keySource(provider)
    if (source) {
      const key = await this.credentials.getKey(provider)
      info.keySource = source
      if (key) info.keyHint = maskKey(key)
    }
    if (provider === 'anthropic') {
      const auth = await this.credentials.anthropicAuth()
      // A credential whose last request failed to authenticate is not ready (Settings > Accounts
      // shows "Sign-in expired"); the next successful request or test clears it.
      info.ready = auth.ready && !auth.failed
      if (!auth.ready) info.detail = source ? 'Key could not be read' : 'No API key'
      else if (auth.failed) info.detail = auth.source === 'key' ? 'API key was rejected' : 'Claude sign-in expired'
      else if (auth.source === 'claudeLogin') info.detail = 'Using your Claude login'
      else if (auth.source === 'cloud') info.detail = 'Using cloud credentials from the environment'
      return info
    }
    info.baseUrl = this.baseUrl(provider)
    if (provider === 'ollama') {
      info.ready = !!info.baseUrl && (await this.reachable(info.baseUrl))
      if (!info.ready) info.detail = `Ollama is not running at ${info.baseUrl}`
    } else if (provider === 'custom') {
      info.ready = !!info.baseUrl
      if (!info.ready) info.detail = 'No base URL'
    } else {
      info.ready = !!source
      if (!info.ready) info.detail = 'No API key'
    }
    // The ollama probe may have just filled the cache.
    info.models = this.cachedModels(provider)
    return info
  }

  async list(): Promise<ProviderInfo[]> {
    return Promise.all(PROVIDER_IDS.map((p) => this.info(p)))
  }

  async ready(provider: ProviderId): Promise<boolean> {
    return (await this.info(provider)).ready
  }

  // Defaults plus the cached /models list (if fetched).
  cachedModels(provider: ProviderId): string[] {
    const fetched = this.modelCache.get(provider)?.models ?? []
    // A local Ollama lists what is actually pulled; suggestions would only fail.
    if (provider === 'ollama' && fetched.length) return fetched.slice()
    return merge(PROVIDERS[provider].defaults, fetched)
  }

  // Fetches GET {base}/models when the provider is usable; falls back to defaults on any error.
  async models(provider: ProviderId, refresh = false): Promise<string[]> {
    if (provider === 'anthropic' || provider === 'codex') return PROVIDERS[provider].defaults.slice()
    const cached = this.modelCache.get(provider)
    if (cached && !refresh && Date.now() - cached.at < MODELS_TTL) return this.cachedModels(provider)
    const ep = await this.endpoint(provider)
    if ('error' in ep) return PROVIDERS[provider].defaults.slice()
    try {
      // OpenRouter can filter to models that accept `tools`.
      const query = provider === 'openrouter' ? '?supported_parameters=tools' : ''
      const res = await this.fetchFn(`${ep.baseUrl}/models${query}`, { headers: ep.headers, signal: AbortSignal.timeout(8000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { data?: { id?: string }[]; models?: { name?: string }[] }
      if (provider === 'openrouter') this.readOpenRouterMeta(body.data ?? [])
      let ids = (body.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string')
      // Gemini lists ids as "models/gemini-..."; chat/completions takes the bare name.
      ids = ids.map((id) => id.replace(/^models\//, '')).filter((id) => !NON_CHAT.test(id))
      if (provider === 'gemini') ids = ids.filter((id) => id.startsWith('gemini'))
      ids.sort()
      this.modelCache.set(provider, { at: Date.now(), models: ids })
      if (provider === 'ollama') await this.probeOllama(ep.baseUrl, ids)
      return this.cachedModels(provider)
    } catch (e) {
      this.ctx.log({ service: 'agent', stream: 'info', text: `${provider}: could not list models (${(e as Error).message})` })
      return this.cachedModels(provider)
    }
  }

  // Quick GET {base}/models probe, cached briefly (used for ollama readiness).
  private async reachable(baseUrl: string): Promise<boolean> {
    const hit = this.reach.get(baseUrl)
    if (hit && Date.now() - hit.at < REACH_TTL) return hit.ok
    let ok = false
    try {
      const res = await this.fetchFn(`${baseUrl}/models`, { signal: AbortSignal.timeout(1500) })
      ok = res.ok
      if (ok) {
        const body = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null
        const ids = (body?.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string')
        if (ids.length) this.modelCache.set('ollama', { at: Date.now(), models: ids.sort() })
      }
    } catch {
      ok = false
    }
    this.reach.set(baseUrl, { at: Date.now(), ok })
    return ok
  }

  // Metadata for one model (runtime when known; Ollama is probed on first use).
  async modelMeta(provider: ProviderId, model: string): Promise<ModelMeta | undefined> {
    if (provider === 'ollama' && !this.meta.get('ollama')?.has(model)) {
      const base = this.baseUrl('ollama')
      if (base) await this.probeOllama(base, [model])
    }
    return this.meta.get(provider)?.get(model)
  }

  // OpenRouter /models entries: architecture.input_modalities (vision) and
  // reasoning.supported_efforts (null = every effort; absent = no effort selection).
  readOpenRouterMeta(entries: any[]): void {
    const map = this.meta.get('openrouter') ?? new Map<string, ModelMeta>()
    for (const e of entries) {
      if (typeof e?.id !== 'string') continue
      const m: ModelMeta = {}
      const mods = e.architecture?.input_modalities
      if (Array.isArray(mods)) m.vision = mods.includes('image')
      if (e.reasoning && typeof e.reasoning === 'object' && 'supported_efforts' in e.reasoning) {
        const se = e.reasoning.supported_efforts
        m.efforts = Array.isArray(se) ? se.filter((x: unknown): x is string => typeof x === 'string') : null
      } else m.efforts = undefined
      map.set(e.id, m)
    }
    this.meta.set('openrouter', map)
  }

  // Ollama: POST {native base}/api/show {"model"} lists "vision" in capabilities for vision models.
  private async probeOllama(baseUrl: string, models: string[]): Promise<void> {
    const native = baseUrl.replace(/\/v1\/?$/, '')
    const map = this.meta.get('ollama') ?? new Map<string, ModelMeta>()
    this.meta.set('ollama', map)
    await Promise.all(
      models.slice(0, 40).map(async (model) => {
        if (map.has(model)) return
        try {
          const res = await this.fetchFn(`${native}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(2000) })
          if (!res.ok) return
          const body = (await res.json()) as { capabilities?: unknown }
          if (Array.isArray(body.capabilities)) map.set(model, { vision: body.capabilities.includes('vision') })
        } catch {
          // Unknown: the name heuristic applies.
        }
      })
    )
  }

  forgetReachability(): void {
    this.reach.clear()
  }
}

function merge(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])]
}
