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
import { DEFAULT_MODEL } from './sdk.ts'

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
  custom: { label: 'Custom (OpenAI-compatible)', editableBaseUrl: true, needsKey: false, defaults: [] }
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

// Extra request fields per model, from the providers' docs.
export function extraBody(provider: ProviderId, model: string): Record<string, unknown> {
  // OpenAI: "Chat Completions supports function calling only with reasoning_effort set to none" (GPT-6 Luna).
  // gpt-6.1-sol runs on the Responses API (responsesLoop.ts), which drops these Chat Completions
  // fields; sol rejects reasoning_effort "none" anyway.
  // Chat Completions only reports usage when asked (stream_options.include_usage).
  if (provider === 'openai' && /^gpt-6-luna/.test(model)) return { reasoning_effort: 'none', stream_options: { include_usage: true } }
  if (provider === 'openai') return { stream_options: { include_usage: true } }
  return {}
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

  constructor(ctx: HarnessContext, credentials: Credentials, fetchFn: FetchFn = (...a) => fetch(...a)) {
    this.ctx = ctx
    this.credentials = credentials
    this.fetchFn = fetchFn
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
    const source = await this.credentials.keySource(provider)
    if (source) {
      const key = await this.credentials.getKey(provider)
      info.keySource = source
      if (key) info.keyHint = maskKey(key)
    }
    if (provider === 'anthropic') {
      const auth = await this.credentials.anthropicAuth()
      info.ready = auth.ready
      if (!auth.ready) info.detail = source ? 'Key could not be read' : 'No API key'
      else if (auth.source === 'claudeLogin') info.detail = 'Using your Claude Code login'
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
    if (provider === 'anthropic') return PROVIDERS.anthropic.defaults.slice()
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
      let ids = (body.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string')
      // Gemini lists ids as "models/gemini-..."; chat/completions takes the bare name.
      ids = ids.map((id) => id.replace(/^models\//, '')).filter((id) => !NON_CHAT.test(id))
      if (provider === 'gemini') ids = ids.filter((id) => id.startsWith('gemini'))
      ids.sort()
      this.modelCache.set(provider, { at: Date.now(), models: ids })
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

  forgetReachability(): void {
    this.reach.clear()
  }
}

function merge(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])]
}
