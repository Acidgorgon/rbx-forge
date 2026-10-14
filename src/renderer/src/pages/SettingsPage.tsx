// Settings tab: accounts (sign in with Claude, API keys; accounts/AccountsSection.tsx), appearance,
// default model, AI providers (Ollama and custom base URLs),
// budgets and usage history, auto-routing, places (serveAllPlaces) and collaborator sync.
import { useEffect, useState, type ReactNode } from 'react'
import type { BudgetLimits, ProviderId, ProviderInfo, SyncSettings, UsageSummary } from '@shared/types'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { ModelPicker, ProviderMark } from '../components/ModelPicker'
import { setMotionMode, setThemeMode, useAppearance, type MotionMode, type ThemeMode } from '../theme'
import { errorText, fmtTokens, fmtUsd } from '../lib/format'
import { ToolchainSection } from '../setup/Toolchain'
import { DefaultEffortSetting } from '../assistant/EffortPicker'
import { UpdatesSection } from '../updates/UpdatesSection'
import { ForgeSyncSettings } from './ForgeSyncSettings'
import { LabsSettings } from './LabsSettings'
import { RestateSettingRow } from './RestateSettings'
import { QolSettings } from '../qol/QolSettings'
import { DoctorBanner } from './qolc/Doctor'
import { SpendSettingsSection } from './qolc/Spend'
import { FigmaTokenSettings } from './FigmaTokenSettings'
import { AccountsSection } from '../accounts/AccountsSection'

const BLURB: Record<ProviderId, string> = {
  anthropic: 'Claude through the Claude Agent SDK. The only provider with Roblox Studio (MCP) tools.',
  openai: 'GPT models through api.openai.com.',
  openrouter: 'Hundreds of models from many labs with one key.',
  gemini: "Google's Gemini models through their OpenAI-compatible endpoint.",
  ollama: 'Local models on this machine. No key needed; start Ollama and pull a model with tool support.',
  custom: 'Any server that speaks the OpenAI Chat Completions API (LM Studio, vLLM, a gateway...).'
}
const KEY_PLACEHOLDER: Partial<Record<ProviderId, string>> = { anthropic: 'sk-ant-...', openai: 'sk-...', openrouter: 'sk-or-...', gemini: 'AIza...', custom: 'Optional' }
const ENV_NAME: Partial<Record<ProviderId, string>> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY', gemini: 'GEMINI_API_KEY' }

const SECTIONS = [
  ['accounts', 'Accounts'],
  ['appearance', 'Appearance'],
  ['model', 'Default model'],
  ['chat', 'Chat'],
  ['providers', 'Providers'],
  ['usage', 'Usage'],
  ['budgets', 'Budgets'],
  ['labs', 'Labs'],
  ['integrations', 'Integrations'],
  ['places', 'Places'],
  ['sync', 'Sync'],
  ['toolchain', 'Toolchain'],
  ['notifications', 'Notifications'],
  ['updates', 'Updates']
] as const

function Row({ title, desc, children, id }: { title: ReactNode; desc?: ReactNode; children?: ReactNode; id?: string }) {
  return (
    <div className="set-row" id={id}>
      <div className="set-text">
        <div className="set-title">{title}</div>
        {desc && <div className="note">{desc}</div>}
      </div>
      {children && <div className="set-ctl">{children}</div>}
    </div>
  )
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  )
}

function KeyField({ p }: { p: ProviderInfo }) {
  const { actions } = useStore()
  const [key, setKey] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)

  const save = async (value: string) => {
    setBusy(true)
    try {
      await window.harness.setProviderKey(p.id, value)
      await actions.refreshProviders()
      actions.toast({ text: value ? `${p.label} key saved` : `${p.label} key removed`, kind: 'ok' })
      setKey('')
      setEditing(false)
    } catch (e) {
      actions.toast({ text: 'Could not save the key', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }

  if (p.keySource && !editing) {
    return (
      <div className="pv-field">
        <span className="pv-label">API key</span>
        <code className="pv-hint">{p.keyHint ?? '....'}</code>
        <span className="note grow ellipsis">{p.keySource === 'env' ? `from ${ENV_NAME[p.id] ?? 'the environment'}` : 'stored in the OS keychain'}</span>
        <button className="btn small" onClick={() => setEditing(true)}>Replace</button>
        {p.keySource === 'stored' && <button className="btn small danger" disabled={busy} onClick={() => void save('')}>Clear</button>}
      </div>
    )
  }
  return (
    <form className="pv-field" onSubmit={(e) => (e.preventDefault(), key.trim() && void save(key.trim()))}>
      <span className="pv-label">API key</span>
      <input className="input grow" type="password" placeholder={KEY_PLACEHOLDER[p.id] ?? 'API key'} value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} autoComplete="off" aria-label={`${p.label} API key`} />
      <button className="btn primary small" disabled={!key.trim() || busy}>{busy ? 'Saving...' : 'Save'}</button>
      {editing && <button type="button" className="btn small ghost" onClick={() => setEditing(false)}>Cancel</button>}
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
      className="pv-field"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        try {
          await window.harness.setProviderConfig(p.id, { baseUrl: url.trim() })
          await actions.refreshProviders()
          actions.toast({ text: `${p.label} base URL saved`, kind: 'ok' })
        } catch (err) {
          actions.toast({ text: 'Could not save the base URL', detail: errorText(err), kind: 'err' })
        } finally {
          setBusy(false)
        }
      }}
    >
      <span className="pv-label">Base URL</span>
      <input className="input grow" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={p.id === 'ollama' ? 'http://localhost:11434/v1' : 'https://my-server/v1'} spellCheck={false} aria-label={`${p.label} base URL`} />
      <button className="btn small" disabled={!dirty || busy}>Save</button>
    </form>
  )
}

function ProviderCard({ p }: { p: ProviderInfo }) {
  const status = p.ready ? 'ready' : p.id === 'ollama' ? 'not running' : 'not set up'
  return (
    <div className={`pv-card${p.ready ? ' ready' : ''}`} id={`pv-${p.id}`}>
      <div className="pv-head">
        <ProviderMark id={p.id} size={22} />
        <div className="grow">
          <div className="set-title">{p.label}</div>
          <div className="note">{BLURB[p.id]}</div>
        </div>
        <span className={`badge-o ${p.ready ? 'ok' : ''}`} title={p.detail}>{status}</span>
      </div>
      {p.detail && !/^No (API key|base URL)$/.test(p.detail) && <div className="note pv-detail">{p.detail}</div>}
      {(p.id === 'custom' || p.id === 'ollama') && <BaseUrlField p={p} />}
      {p.id !== 'ollama' && <KeyField p={p} />}
    </div>
  )
}

type NumKey = Exclude<keyof BudgetLimits, 'tokenMetric'>
const BUDGET_FIELDS: { key: NumKey; label: string; desc: string; unit: '$' | 'tok' | '%' }[] = [
  { key: 'chatSoftCostUsd', label: 'Chat warning at', desc: 'Suggest a new chat or a cheaper model past this spend.', unit: '$' },
  { key: 'chatSoftTokens', label: 'Chat warning tokens', desc: 'Same warning, by context size.', unit: 'tok' },
  { key: 'chatMaxCostUsd', label: 'Chat hard cap', desc: 'Stop a chat at this spend. Empty = no cap.', unit: '$' },
  { key: 'agentMaxCostUsd', label: 'Test agent cap', desc: 'Each test-agent run stops here.', unit: '$' },
  { key: 'agentMaxTokens', label: 'Test agent tokens', desc: 'Token cap for one test-agent run.', unit: 'tok' },
  { key: 'dailyMaxCostUsd', label: 'Daily cap', desc: 'All spend in a local day. Empty = no cap.', unit: '$' },
  { key: 'warnAt', label: 'Warn at', desc: 'Fraction of a cap where the meter turns amber.', unit: '%' }
]

function BudgetField({ f, value, onSave }: { f: (typeof BUDGET_FIELDS)[number]; value: number | undefined; onSave: (v: number | undefined) => void }) {
  const shown = value === undefined ? '' : f.unit === '%' ? String(Math.round(value * 100)) : String(value)
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  const commit = () => {
    if (text === shown) return
    if (!text.trim()) return onSave(undefined)
    const n = Number(text)
    if (!Number.isFinite(n) || n < 0) return setText(shown)
    onSave(f.unit === '%' ? Math.min(1, n / 100) : n)
  }
  return (
    <Row title={f.label} desc={f.desc}>
      <div className="unit-input">
        {f.unit === '$' && <span className="unit">$</span>}
        <input className="input" inputMode="decimal" value={text} placeholder="none" onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} aria-label={f.label} />
        {f.unit !== '$' && <span className="unit">{f.unit}</span>}
      </div>
    </Row>
  )
}

function UsageHistory() {
  const [days, setDays] = useState<{ day: string; totals: UsageSummary }[] | null>(null)
  useEffect(() => {
    void window.harness.getUsageHistory(14).then(setDays).catch(() => setDays([]))
  }, [])
  if (!days) return <div className="note">Loading usage...</div>
  if (!days.length) return <div className="note">No usage recorded yet.</div>
  const max = Math.max(0.0001, ...days.map((d) => d.totals.costUsd))
  const total = days.reduce((n, d) => n + d.totals.costUsd, 0)
  return (
    <div className="usage-hist">
      <div className="uh-bars" role="img" aria-label={`Spend over the last ${days.length} days, ${fmtUsd(total)} total`}>
        {days.map((d) => (
          <div key={d.day} className="uh-col" title={`${d.day}\n${fmtUsd(d.totals.costUsd)} · ${fmtTokens(d.totals.input + d.totals.output)} tokens · ${d.totals.requests} requests`}>
            <div className="uh-bar" style={{ height: `${Math.max(2, (d.totals.costUsd / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="row note">
        <span>{days[0]?.day}</span>
        <span className="grow" />
        <span>{fmtUsd(total)} over {days.length} days</span>
        <span className="grow" />
        <span>{days[days.length - 1]?.day}</span>
      </div>
    </div>
  )
}

export function SettingsPage() {
  const { state, actions } = useStore()
  const appearance = useAppearance()
  const providers = state.providers
  const ready = providers?.filter((p) => p.ready).length ?? 0
  const [budget, setBudget] = useState<BudgetLimits | null>(null)
  const [sync, setSync] = useState<SyncSettings | null>(state.syncSettings)

  useEffect(() => {
    void actions.refreshProviders()
    void window.harness.getBudget().then(setBudget).catch(() => setBudget({}))
  }, [actions])
  useEffect(() => setSync(state.syncSettings), [state.syncSettings])

  // Opened from a picker's "Add key": bring that provider's card into view and focus its field.
  const focus = state.settingsFocus
  useEffect(() => {
    if (!focus || !providers) return
    // Accounts cards first (anthropic -> Claude); Custom only lives under Providers.
    const el = document.getElementById(`acct-${focus === 'anthropic' ? 'claude' : focus}`) ?? document.getElementById(`pv-${focus}`)
    el?.scrollIntoView({ block: 'center' })
    el?.classList.add('flash')
    el?.querySelector<HTMLInputElement>('input:not([type=checkbox])')?.focus()
    const t = setTimeout(() => el?.classList.remove('flash'), 1400)
    actions.set({ settingsFocus: null })
    return () => clearTimeout(t)
  }, [focus, providers, actions])

  const saveBudget = async (patch: Partial<BudgetLimits>) => {
    try {
      setBudget(await window.harness.setBudget(patch))
    } catch (e) {
      actions.toast({ text: 'Could not save the budget', detail: errorText(e), kind: 'err' })
    }
  }
  const saveSync = (s: SyncSettings) => {
    setSync(s)
    void window.harness.setSyncSettings(s).then(() => actions.set({ syncSettings: s }))
  }
  const jump = (id: string) => document.getElementById(`set-${id}`)?.scrollIntoView({ block: 'start' })

  return (
    <div className="page">
      <div className="page-inner settings">
        <div className="page-head">
          <div>
            <h1>Settings</h1>
            <div className="sub">{providers ? `${ready} of ${providers.length} providers ready` : 'Loading...'}</div>
          </div>
        </div>
        <DoctorBanner />
        <nav className="set-nav" aria-label="Settings sections">
          {SECTIONS.map(([id, label]) => (
            <button key={id} className="chip" onClick={() => jump(id)}>{label}</button>
          ))}
        </nav>

        <section className="set-sec" id="set-accounts">
          <h2>Accounts</h2>
          <p className="note">
            Sign in or add a key for each AI provider you want to use. Keys are encrypted with the OS keychain (Electron safeStorage) and never leave the
            main process.
          </p>
          <AccountsSection />
        </section>

        <section className="set-sec" id="set-appearance">
          <h2>Appearance</h2>
          <Row title="Theme" desc="System follows your OS setting.">
            <Seg<ThemeMode> value={appearance.theme} options={[['dark', 'Dark'], ['light', 'Light'], ['system', 'System']]} onChange={setThemeMode} />
          </Row>
          <Row title="Motion" desc="Reduced keeps state changes but drops decorative movement. Your OS reduce-motion setting is always respected.">
            <Seg<MotionMode> value={appearance.motion} options={[['full', 'Full'], ['reduced', 'Reduced'], ['off', 'Off']]} onChange={setMotionMode} />
          </Row>
        </section>

        <section className="set-sec" id="set-model">
          <h2>Default model</h2>
          <Row title="New chats and test agents" desc="Each chat can switch from the picker above the message box.">
            <ModelPicker
              variant="field"
              direction="down"
              value={state.defaultModel}
              providers={providers}
              onAddKey={(id) => actions.set({ settingsFocus: id })}
              onChange={async (c) => {
                await window.harness.setDefaultModel(c.provider, c.model)
                actions.set({ defaultModel: c })
                actions.toast({ text: `Default model: ${c.model}`, kind: 'ok', ms: 2500 })
              }}
            />
          </Row>
          <Row title="Auto-route simple turns" desc="Send short, simple chat turns to a cheaper model tier. Off = always use the chosen model.">
            <input type="checkbox" className="switch" checked={!!state.appSettings?.autoRoute} disabled={!state.appSettings} onChange={(e) => void actions.setAppSettings({ autoRoute: e.target.checked })} aria-label="Auto-route simple turns" />
          </Row>
          <DefaultEffortSetting />
        </section>

        <section className="set-sec" id="set-chat">
          <h2>Chat</h2>
          <RestateSettingRow scope="chat" />
        </section>

        <section className="set-sec" id="set-providers">
          <h2>Providers</h2>
          <p className="note">
            Server URLs for local and self-hosted models; sign-ins and API keys for the hosted providers are under Accounts above. Studio MCP tools are only
            available on Claude; other providers get the project tools.
          </p>
          <div className="pv-list">{providers?.filter((p) => p.id === 'ollama' || p.id === 'custom').map((p) => <ProviderCard key={p.id} p={p} />)}</div>
        </section>

        <section className="set-sec" id="set-usage">
          <h2>Usage and spending cap</h2>
          <SpendSettingsSection />
        </section>

        <section className="set-sec" id="set-budgets">
          <h2>Budgets</h2>
          {budget ? BUDGET_FIELDS.map((f) => <BudgetField key={f.key} f={f} value={budget[f.key]} onSave={(v) => void saveBudget({ [f.key]: v })} />) : <div className="note">Loading...</div>}
          {budget && (
            <Row title="Count tokens as" desc="Effective weighs cache reads lower; total counts every token.">
              <Seg<'effective' | 'total'> value={budget.tokenMetric ?? 'effective'} options={[['effective', 'Effective'], ['total', 'Total']]} onChange={(v) => void saveBudget({ tokenMetric: v })} />
            </Row>
          )}
          <h3 className="set-sub">Spend, last 14 days</h3>
          <UsageHistory />
        </section>

        <section className="set-sec" id="set-labs">
          <h2>Labs</h2>
          <LabsSettings />
          <RestateSettingRow scope="labs" />
        </section>

        <section className="set-sec" id="set-integrations">
          <h2>Integrations</h2>
          <FigmaTokenSettings />
        </section>

        <section className="set-sec" id="set-places">
          <h2>Places</h2>
          {!state.project ? (
            <div className="note">Open a project to see its places.</div>
          ) : (
            <>
              <div className="place-list">
                {state.places.map((p) => (
                  <button key={p.file} className={`place-row${state.activePlace === p.file ? ' on' : ''}`} onClick={() => void actions.setActivePlace(p.file)}>
                    <span className={`radio${state.activePlace === p.file ? ' on' : ''}`} />
                    <span className="grow ellipsis">{p.name}</span>
                    {p.isDefault && <span className="tag">default</span>}
                    <span className="mono faint">{p.file}</span>
                    <span className="mono faint">:{p.servePort}</span>
                  </button>
                ))}
              </div>
              <Row title="Serve every place" desc="rojo serves all places, not only the active one. Changing this restarts a running rojo.">
                <input type="checkbox" className="switch" checked={!!state.appSettings?.serveAllPlaces} disabled={!state.appSettings || state.places.length < 2} onChange={(e) => void actions.setAppSettings({ serveAllPlaces: e.target.checked })} aria-label="Serve every place" />
              </Row>
            </>
          )}
        </section>

        <section className="set-sec" id="set-sync">
          <h2>Sync</h2>
          <ForgeSyncSettings />
          {sync ? (
            <>
              <Row title="Auto sync every" desc="Pull and push with your team on a timer. 0 = only when you press Sync.">
                <div className="unit-input">
                  <input className="input" type="number" min={0} max={120} value={sync.autoSyncMinutes} onChange={(e) => saveSync({ ...sync, autoSyncMinutes: Math.max(0, Number(e.target.value) || 0) })} aria-label="Auto sync minutes" />
                  <span className="unit">min</span>
                </div>
              </Row>
              <Row title="Commit local work before pulling" desc="Keeps your edits safe when teammates' changes come in.">
                <input type="checkbox" className="switch" checked={sync.autoCommit} onChange={(e) => saveSync({ ...sync, autoCommit: e.target.checked })} aria-label="Commit local work before pulling" />
              </Row>
            </>
          ) : (
            <div className="note">Open a project to change sync settings.</div>
          )}
          <Row title="Team settings" desc="Shared project rules live in .forge/project.json and are edited from the Team view.">
            <button className="btn small" onClick={() => actions.showSide('team')}><Icon name="team" size={12} /> Team</button>
          </Row>
        </section>

        <section className="set-sec" id="set-toolchain">
          <h2>Toolchain</h2>
          <ToolchainSection />
        </section>

        <section className="set-sec" id="set-notifications">
          <h2>Notifications</h2>
          <QolSettings />
        </section>

        <section className="set-sec" id="set-updates">
          <h2>Updates</h2>
          <UpdatesSection />
        </section>
      </div>
    </div>
  )
}
