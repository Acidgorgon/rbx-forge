// Settings: default model and AI providers (keys, base URLs, the Claude login opt-in).
import { useEffect, useState } from 'react'
import type { ProviderId, ProviderInfo } from '@shared/types'
import { useStore } from '../store'
import { Drawer } from '../components/Drawer'
import { IconCheck, IconGear } from '../components/Icons'
import { ModelPicker, ProviderMark } from '../components/ModelPicker'

const BLURB: Record<ProviderId, string> = {
  anthropic: 'Claude through the Claude Agent SDK. The only provider with Roblox Studio (MCP) tools.',
  openai: 'GPT models through api.openai.com.',
  openrouter: 'Hundreds of models from many labs with one key.',
  gemini: "Google's Gemini models through their OpenAI-compatible endpoint.",
  ollama: 'Local models on this machine. No key needed; start Ollama and pull a model with tool support.',
  custom: 'Any server that speaks the OpenAI Chat Completions API (LM Studio, vLLM, a gateway…).'
}

const KEY_PLACEHOLDER: Partial<Record<ProviderId, string>> = {
  anthropic: 'sk-ant-…',
  openai: 'sk-…',
  openrouter: 'sk-or-…',
  gemini: 'AIza…',
  custom: 'Optional'
}

const ENV_NAME: Partial<Record<ProviderId, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  gemini: 'GEMINI_API_KEY'
}

function KeyField({ p }: { p: ProviderInfo }) {
  const { actions } = useStore()
  const [key, setKey] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const has = !!p.keySource

  const save = async (value: string) => {
    setBusy(true)
    try {
      await window.harness.setProviderKey(p.id, value)
      await actions.refreshProviders()
      actions.toast(value ? `${p.label} key saved` : `${p.label} key removed`)
      setKey('')
      setEditing(false)
    } catch (e) {
      actions.toast(`Could not save: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  if (has && !editing) {
    return (
      <div className="pv-row">
        <span className="pv-label">API key</span>
        <span className="pv-key">
          <code>{p.keyHint ?? '••••'}</code>
          <span className="muted small">{p.keySource === 'env' ? `from ${ENV_NAME[p.id] ?? 'the environment'}` : 'stored in the OS keychain'}</span>
        </span>
        <button className="btn small ghost" onClick={() => setEditing(true)}>Replace</button>
        {p.keySource === 'stored' && (
          <button className="btn small ghost" disabled={busy} onClick={() => void save('')}>Clear</button>
        )}
      </div>
    )
  }
  return (
    <form
      className="pv-row"
      onSubmit={(e) => {
        e.preventDefault()
        if (key.trim()) void save(key.trim())
      }}
    >
      <span className="pv-label">API key</span>
      <div className="key-form pv-input">
        <input
          type="password"
          placeholder={KEY_PLACEHOLDER[p.id] ?? 'API key'}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          aria-label={`${p.label} API key`}
        />
        <button className="btn primary" disabled={!key.trim() || busy}>{busy ? 'Saving…' : 'Save'}</button>
        {editing && (
          <button type="button" className="btn ghost" onClick={() => setEditing(false)}>Cancel</button>
        )}
      </div>
    </form>
  )
}

function BaseUrlField({ p }: { p: ProviderInfo }) {
  const { actions } = useStore()
  const [url, setUrl] = useState(p.baseUrl ?? '')
  const [busy, setBusy] = useState(false)
  useEffect(() => setUrl(p.baseUrl ?? ''), [p.baseUrl])
  const dirty = url.trim().replace(/\/+$/, '') !== (p.baseUrl ?? '')
  return (
    <form
      className="pv-row"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        try {
          await window.harness.setProviderConfig(p.id, { baseUrl: url.trim() })
          await actions.refreshProviders()
          actions.toast(`${p.label} base URL saved`)
        } catch (err) {
          actions.toast((err as Error).message)
        } finally {
          setBusy(false)
        }
      }}
    >
      <span className="pv-label">Base URL</span>
      <div className="key-form pv-input">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={p.id === 'ollama' ? 'http://localhost:11434/v1' : 'https://my-server/v1'}
          spellCheck={false}
          aria-label={`${p.label} base URL`}
        />
        <button className="btn" disabled={!dirty || busy}>Save</button>
      </div>
    </form>
  )
}

function ClaudeLoginToggle() {
  const { actions } = useStore()
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => {
    void window.harness.getAnthropicUseClaudeLogin().then(setOn)
  }, [])
  return (
    <label className="pv-toggle">
      <div>
        <div className="setting-title">Use my Claude Code login (personal use only)</div>
        <div className="muted small">
          When no API key is set, run on the Claude Code login on this machine (or CLAUDE_CODE_OAUTH_TOKEN). This draws from your Claude Pro/Max
          plan limits and is meant for your own use. An API key is Anthropic’s documented way to authenticate apps built on the Agent SDK.
        </div>
      </div>
      <input
        type="checkbox"
        className="switch"
        checked={!!on}
        disabled={on === null}
        onChange={async (e) => {
          const next = e.target.checked
          setOn(next)
          await window.harness.setAnthropicUseClaudeLogin(next)
          await actions.refreshProviders()
        }}
      />
    </label>
  )
}

function ProviderCard({ p }: { p: ProviderInfo }) {
  const status = p.ready ? 'Ready' : p.id === 'ollama' ? 'Not running' : 'Not set up'
  return (
    <div className={`pv-card${p.ready ? ' ready' : ''}`}>
      <div className="pv-head">
        <ProviderMark id={p.id} size={26} />
        <div className="pv-titles">
          <div className="pv-name">{p.label}</div>
          <div className="muted small">{BLURB[p.id]}</div>
        </div>
        <span className={`pv-status${p.ready ? ' ok' : ''}`} title={p.detail}>
          {p.ready ? <IconCheck size={12} /> : <span className="pv-dot" />}
          {status}
        </span>
      </div>
      {p.detail && !/^No (API key|base URL)$/.test(p.detail) && <div className="pv-detail">{p.detail}</div>}
      <div className="pv-fields">
        {(p.id === 'custom' || p.id === 'ollama') && <BaseUrlField p={p} />}
        {p.id !== 'ollama' && <KeyField p={p} />}
      </div>
      {p.id === 'anthropic' && <ClaudeLoginToggle />}
    </div>
  )
}

export function SettingsDrawer() {
  const { state, actions } = useStore()
  const providers = state.providers
  const ready = providers?.filter((p) => p.ready).length ?? 0

  useEffect(() => {
    void actions.refreshProviders()
  }, [actions])

  // Opened from a picker's "Add key": bring that provider's card into view and focus its field.
  const focus = state.settingsFocus
  useEffect(() => {
    if (!focus || !providers) return
    const el = document.getElementById(`pv-${focus}`)
    el?.scrollIntoView({ block: 'center' })
    el?.classList.add('flash')
    el?.querySelector<HTMLInputElement>('input:not([type=checkbox])')?.focus()
    setTimeout(() => el?.classList.remove('flash'), 1400)
    actions.set({ settingsFocus: null })
  }, [focus, providers, actions])

  return (
    <Drawer
      title="Settings"
      icon={<IconGear />}
      subtitle={providers ? `${ready} of ${providers.length} providers ready` : 'Loading…'}
      width={600}
      onClose={() => actions.set({ drawer: null })}
    >
      <section className="section">
        <div className="section-head">
          <h3>Default model</h3>
        </div>
        <p className="muted small">New chats and test-agent runs start on this model. Each chat can switch from the picker under the message box.</p>
        <ModelPicker
          variant="field"
          direction="down"
          value={state.defaultModel}
          providers={providers}
          onAddKey={(id) => actions.set({ settingsFocus: id })}
          onChange={async (c) => {
            await window.harness.setDefaultModel(c.provider, c.model)
            actions.set({ defaultModel: c })
            actions.toast(`Default model: ${c.model}`)
          }}
        />
      </section>

      <section className="section">
        <div className="section-head">
          <h3>Providers</h3>
        </div>
        <p className="muted small">
          Keys are encrypted with the OS keychain (Electron safeStorage) and never leave the app’s main process. Studio MCP tools are only available on
          Anthropic; other providers get the gentree project tools.
        </p>
        <div className="pv-list">
          {providers?.map((p) => (
            <div key={p.id} id={`pv-${p.id}`}>
              <ProviderCard p={p} />
            </div>
          ))}
        </div>
      </section>
    </Drawer>
  )
}
