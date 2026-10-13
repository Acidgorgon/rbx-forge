// Browser-preview mock of the provider/key/model API (see mock.ts).
// ?providers=none starts with nothing set up (the "Choose a provider" state).
import type { HarnessApi, HarnessEvents, ModelChoice, ProviderId, ProviderInfo } from '@shared/types'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

const LABEL: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  gemini: 'Google Gemini',
  ollama: 'Ollama',
  custom: 'Custom (OpenAI-compatible)'
}

const DEFAULTS: Record<ProviderId, string[]> = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  openai: ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-6-luna', 'gpt-6.1-sol'],
  openrouter: ['anthropic/claude-sonnet-5.5', 'openai/gpt-6-astra', 'google/gemini-3.8-flash'],
  gemini: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview'],
  ollama: ['qwen3.8', 'qwen3.6', 'llama3.1'],
  custom: []
}

// What GET /models would add once a key is present.
const FETCHED: Partial<Record<ProviderId, string[]>> = {
  openai: ['gpt-6-astra', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-5.6-terra', 'gpt-5.6-terra-mini', 'o9-mini'],
  openrouter: [
    'anthropic/claude-opus-5.5',
    'anthropic/claude-sonnet-5.5',
    'anthropic/claude-haiku-5.5',
    'openai/gpt-6-astra',
    'openai/gpt-6-luna',
    'google/gemini-3.8-flash',
    'google/gemini-3.1-pro-preview',
    'deepseek/deepseek-v4.1',
    'qwen/qwen3.8-coder',
    'mistralai/mistral-large-4',
    'z-ai/glm-5.3'
  ],
  gemini: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview'],
  ollama: ['qwen3.8:latest', 'llama3.1:8b'],
  custom: ['local-model']
}

const ORDER: ProviderId[] = ['anthropic', 'openai', 'openrouter', 'gemini', 'ollama', 'custom']

export function providersMock(emit: Emit) {
  const none = typeof location !== 'undefined' && new URLSearchParams(location.search).get('providers') === 'none'
  const keys: Record<ProviderId, string | null> = {
    anthropic: none ? null : 'sk-ant-api03-mock-9f2c',
    openai: null,
    openrouter: none ? null : 'sk-or-v1-mock-41d7',
    gemini: null,
    ollama: null,
    custom: null
  }
  const baseUrls: Partial<Record<ProviderId, string>> = { ollama: 'http://localhost:11434/v1' }
  let ollamaRunning = !none
  let useClaudeLogin = false
  let defaultModel: ModelChoice = { provider: 'anthropic', model: 'claude-opus-5-5' }
  const fetched: Partial<Record<ProviderId, string[]>> = {}

  const info = (id: ProviderId): ProviderInfo => {
    const key = keys[id]
    const p: ProviderInfo = {
      id,
      label: LABEL[id],
      ready: false,
      needsKey: id !== 'ollama' && id !== 'custom',
      models: id === 'ollama' && fetched.ollama ? fetched.ollama : [...new Set([...DEFAULTS[id], ...(fetched[id] ?? [])])]
    }
    if (key) {
      p.keyHint = `…${key.slice(-4)}`
      p.keySource = 'stored'
    }
    if (id === 'anthropic') {
      p.ready = !!key || useClaudeLogin
      p.detail = key ? undefined : useClaudeLogin ? 'Using your Claude Code login' : 'No API key'
      return p
    }
    p.baseUrl = id === 'openai' ? 'https://api.openai.com/v1' : id === 'openrouter' ? 'https://openrouter.ai/api/v1' : id === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/openai' : baseUrls[id]
    if (id === 'ollama') {
      p.ready = ollamaRunning
      if (!p.ready) p.detail = `Ollama is not running at ${p.baseUrl}`
    } else if (id === 'custom') {
      p.ready = !!p.baseUrl
      if (!p.ready) p.detail = 'No base URL'
    } else {
      p.ready = !!key
      if (!p.ready) p.detail = 'No API key'
    }
    return p
  }

  const list = () => ORDER.map(info)
  const changed = () => emit('providers:changed', list())

  // Pretend Ollama answers once it has been probed (models filled in).
  if (ollamaRunning) fetched.ollama = FETCHED.ollama

  const api: Pick<
    HarnessApi,
    | 'listProviders'
    | 'setProviderKey'
    | 'setProviderConfig'
    | 'listModels'
    | 'getDefaultModel'
    | 'setDefaultModel'
    | 'getAnthropicUseClaudeLogin'
    | 'setAnthropicUseClaudeLogin'
    | 'hasApiKey'
    | 'setApiKey'
  > = {
    async listProviders() {
      return list()
    },
    async setProviderKey(provider, key) {
      keys[provider] = key.trim() || null
      if (!keys[provider]) delete fetched[provider]
      changed()
    },
    async setProviderConfig(provider, config) {
      if (provider !== 'custom' && provider !== 'ollama') throw new Error(`${provider} has a fixed base URL`)
      const url = config.baseUrl?.trim().replace(/\/+$/, '')
      if (url && !/^https?:\/\//.test(url)) throw new Error('Base URL must start with http:// or https://')
      baseUrls[provider] = url || (provider === 'ollama' ? 'http://localhost:11434/v1' : undefined)
      if (provider === 'ollama') ollamaRunning = true
      changed()
    },
    async listModels(provider) {
      const p = info(provider)
      if (p.ready && FETCHED[provider]) {
        await new Promise((r) => setTimeout(r, 250))
        fetched[provider] = FETCHED[provider]
      }
      return info(provider).models
    },
    async getDefaultModel() {
      return defaultModel
    },
    async setDefaultModel(provider, model) {
      defaultModel = { provider, model }
    },
    async getAnthropicUseClaudeLogin() {
      return useClaudeLogin
    },
    async setAnthropicUseClaudeLogin(on) {
      useClaudeLogin = on
      changed()
    },
    async hasApiKey() {
      return info('anthropic').ready
    },
    async setApiKey(key) {
      keys.anthropic = key.trim() || null
      changed()
    }
  }

  return { api, defaultModel: () => defaultModel, ready: (id: ProviderId) => info(id).ready }
}
