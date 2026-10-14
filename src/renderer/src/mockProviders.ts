// Browser-preview mock of the provider/key/model API (see mock.ts).
// ?providers=none starts with nothing set up (the "Choose a provider" state).
import type { HarnessApi, HarnessEvents, ModelChoice, ProviderId, ProviderInfo } from '@shared/types'
import { ACCOUNT_IDS, ACCOUNT_PROVIDER, type AccountCheck, type AccountId, type AccountSummary, type SignInProgress, type SignInStatus } from '@shared/accountTypes'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

const LABEL: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  gemini: 'Google Gemini',
  ollama: 'Ollama',
  custom: 'Custom (OpenAI-compatible)',
  codex: 'Codex (ChatGPT plan)'
}

const DEFAULTS: Record<ProviderId, string[]> = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  openai: ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-6-luna', 'gpt-6.1-sol'],
  openrouter: ['anthropic/claude-sonnet-5.5', 'openai/gpt-6-astra', 'google/gemini-3.8-flash'],
  gemini: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview'],
  ollama: ['qwen3.8', 'qwen3.6', 'llama3.1'],
  custom: [],
  codex: ['codex-default', 'gpt-6.1-sol', 'gpt-6-astra']
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

const ORDER: ProviderId[] = ['anthropic', 'openai', 'openrouter', 'gemini', 'ollama', 'custom', 'codex']

export function providersMock(emit: Emit) {
  const none = typeof location !== 'undefined' && new URLSearchParams(location.search).get('providers') === 'none'
  const keys: Record<ProviderId, string | null> = {
    anthropic: none ? null : 'sk-ant-api03-mock-9f2c',
    openai: null,
    openrouter: none ? null : 'sk-or-v1-mock-41d7',
    gemini: null,
    ollama: null,
    custom: null,
    codex: null
  }
  const baseUrls: Partial<Record<ProviderId, string>> = { ollama: 'http://localhost:11434/v1' }
  let ollamaRunning = !none
  // ?accounts=expired: a Claude login whose last request failed; ?accounts=claude: signed in.
  const accountsParam = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('accounts') : null
  let useClaudeLogin = accountsParam === 'claude' || accountsParam === 'expired'
  let claudeExpired = accountsParam === 'expired'
  const checks: Partial<Record<AccountId, AccountCheck>> = {}
  let signInTimer: ReturnType<typeof setTimeout> | null = null
  // ?codex=missing: no Codex CLI on this computer; ?codex=signedin: already signed in with ChatGPT.
  const codexParam = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('codex') : null
  const codexInstalled = codexParam !== 'missing'
  let codexSignedIn = codexParam === 'signedin'
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
    if (id === 'codex') {
      p.needsKey = false
      p.ready = codexSignedIn
      p.detail = !codexInstalled ? 'Codex CLI not found' : codexSignedIn ? 'Signed in with ChatGPT' : 'Not logged in'
      p.codex = { installed: codexInstalled, loggedIn: codexSignedIn, version: '0.140.0', ...(codexSignedIn ? { method: 'chatgpt' as const } : {}) }
      return p
    }
    if (id === 'anthropic') {
      p.ready = (!!key || useClaudeLogin) && !(useClaudeLogin && claudeExpired)
      p.detail = useClaudeLogin ? (claudeExpired ? 'Claude sign-in expired' : 'Using your Claude login') : key ? undefined : 'No API key'
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
  const KEY_URL: Record<AccountId, string> = {
    claude: 'https://platform.claude.com/settings/keys',
    openai: 'https://platform.openai.com/api-keys',
    gemini: 'https://aistudio.google.com/apikey',
    openrouter: 'https://openrouter.ai/settings/keys',
    ollama: 'https://ollama.com/download'
  }
  const ENV: Partial<Record<AccountId, string>> = { claude: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY' }
  const ACC_LABEL: Record<AccountId, string> = { claude: 'Claude', openai: 'OpenAI', gemini: 'Google Gemini', openrouter: 'OpenRouter', ollama: 'Ollama' }
  const signInOf = (id: AccountId): SignInStatus | undefined => {
    if (id === 'claude') {
      const state = useClaudeLogin ? (claudeExpired ? 'expired' : 'signedIn') : 'signedOut'
      return { method: 'claude', label: 'Sign in with Claude', state, canCliLogout: true, ...(useClaudeLogin ? { account: 'you@example.com · Max', detail: 'Claude Code login on this computer' } : {}) }
    }
    if (id === 'openai') {
      const base = { method: 'codex', label: 'Sign in with ChatGPT (Codex)', needs: 'Codex CLI', cliLogoutOnly: true, canCliLogout: true } as const
      if (!codexInstalled) return { ...base, state: 'unavailable', needsUrl: 'https://developers.openai.com/codex/cli', detail: 'Needs the Codex CLI. Use an API key for now.' }
      return codexSignedIn ? { ...base, state: 'signedIn', account: 'ChatGPT account', detail: 'Codex CLI login on this computer' } : { ...base, state: 'signedOut', detail: 'Codex CLI 0.140.0 found' }
    }
    return undefined
  }
  const account = (id: AccountId): AccountSummary => {
    const p = info(ACCOUNT_PROVIDER[id])
    const signIn = signInOf(id)
    let state: AccountSummary['state'] = 'none'
    let statusText = id === 'ollama' ? 'Not running' : 'Not set up'
    if (signIn?.state === 'expired') [state, statusText] = ['expired', 'Sign-in expired']
    else if (signIn?.state === 'signedIn') [state, statusText] = ['subscription', signIn.method === 'codex' ? 'Signed in with ChatGPT' : 'Signed in with Claude subscription']
    else if (p.keySource) [state, statusText] = ['apiKey', `Using API key ${p.keyHint ?? ''}`.trim()]
    else if (id === 'ollama' && p.ready) [state, statusText] = ['local', `Running at ${p.baseUrl}`]
    return {
      id, provider: p.id, label: ACC_LABEL[id], state, statusText, ready: p.ready,
      ...(p.keySource ? { keySource: p.keySource, keyHint: p.keyHint } : {}),
      ...(ENV[id] ? { envName: ENV[id] } : {}),
      keyUrl: KEY_URL[id],
      ...(signIn ? { signIn } : {}),
      ...(id === 'ollama' ? { baseUrl: p.baseUrl } : {}),
      ...(checks[id] ? { lastCheck: checks[id] } : {})
    }
  }
  const accounts = () => ACCOUNT_IDS.map(account)
  const changed = () => {
    emit('providers:changed', list())
    emit('accounts:changed', accounts())
  }

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
    | 'accountsList'
    | 'accountsSignIn'
    | 'accountsCancelSignIn'
    | 'accountsSubmitCode'
    | 'accountsSignOut'
    | 'accountsUseExistingLogin'
    | 'accountsTest'
    | 'accountsCancelTest'
    | 'codexStatus'
    | 'codexSignIn'
    | 'codexCancelSignIn'
    | 'codexSignOut'
  > = {
    async accountsList() {
      return accounts()
    },
    accountsSignIn(id) {
      const progress = (p: Partial<SignInProgress>): SignInProgress => {
        const full = { account: id, method: id === 'claude' ? 'claude' : 'codex', phase: 'waiting', ...p } as SignInProgress
        emit('accounts:signin', full)
        return full
      }
      if (id === 'openai' && codexInstalled) {
        progress({ phase: 'starting' })
        progress({ stage: 'device', url: 'https://auth.openai.com/codex/device', userCode: 'MOCK-1234', message: 'Enter this code on the ChatGPT sign-in page. Waiting for you to finish...' })
        return new Promise((resolve) => {
          signInTimer = setTimeout(() => {
            signInTimer = null
            codexSignedIn = true
            checks.openai = { ok: true, message: 'Signed in', at: Date.now(), via: 'subscription' }
            changed()
            resolve(progress({ phase: 'done', message: 'Signed in with ChatGPT.' }))
          }, 1500)
        })
      }
      if (id !== 'claude') return Promise.resolve(progress({ phase: 'failed', message: 'Sign in with ChatGPT needs the Codex CLI.' }))
      progress({ phase: 'starting' })
      progress({ url: 'https://claude.com/cai/oauth/authorize?mock=1', message: 'Finish signing in in your browser.', acceptsCode: true })
      return new Promise((resolve) => {
        signInTimer = setTimeout(() => {
          signInTimer = null
          useClaudeLogin = true
          claudeExpired = false
          checks.claude = { ok: true, message: 'Signed in', at: Date.now(), via: 'subscription' }
          changed()
          resolve(progress({ phase: 'done', message: 'Signed in.' }))
        }, 1500)
      })
    },
    async accountsCancelSignIn(id) {
      if (signInTimer) clearTimeout(signInTimer)
      signInTimer = null
      emit('accounts:signin', { account: id, method: id === 'openai' ? 'codex' : 'claude', phase: 'cancelled', message: 'Sign-in cancelled.' })
    },
    async accountsSubmitCode() {},
    async accountsSignOut(id, opts) {
      if (id === 'openai' && opts?.cliLogout) codexSignedIn = false
      if (id === 'claude') {
        useClaudeLogin = false
        claudeExpired = false
      }
      delete checks[id]
      changed()
      return accounts()
    },
    async accountsUseExistingLogin(id) {
      if (id === 'claude') useClaudeLogin = true
      changed()
      return accounts()
    },
    async accountsTest(id) {
      await new Promise((r) => setTimeout(r, 400))
      const a = account(id)
      const ok = a.state !== 'none' && a.state !== 'expired'
      const check: AccountCheck = { ok, message: ok ? 'Connected' : a.state === 'expired' ? 'Sign-in expired or invalid. Sign in again.' : 'Not set up', at: Date.now() }
      checks[id] = check
      changed()
      return check
    },
    async accountsCancelTest() {},
    async codexStatus() {
      return info('codex').codex!
    },
    async codexSignIn() {
      await new Promise((r) => setTimeout(r, 600))
      codexSignedIn = true
      changed()
      return { ok: true, message: 'Signed in with ChatGPT' }
    },
    async codexCancelSignIn() {},
    async codexSignOut() {
      codexSignedIn = false
      changed()
      return info('codex').codex!
    },
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
