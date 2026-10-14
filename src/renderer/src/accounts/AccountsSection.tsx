// Settings > Accounts: one card per provider with its status and the easiest way to set it up.
// Claude: "Sign in with Claude" (the Claude Code CLI browser login). OpenAI: the "Sign in with
// ChatGPT (Codex)" slot plus an API key. Gemini / OpenRouter: paste a key. Ollama: run it locally.
// Keys go straight to the main process; only masked hints come back.
import { useEffect, useRef, useState } from 'react'
import type { AccountCheck, AccountId, AccountSummary, SignInProgress } from '@shared/accountTypes'
import { useStore } from '../store'
import { ProviderMark } from '../components/ModelPicker'
import { ago, errorText } from '../lib/format'
import './accounts.css'

// Re-test a card automatically when Accounts opens and its last check is older than this.
export const AUTO_TEST_MS = 5 * 60_000

const BLURB: Record<AccountId, string> = {
  claude: 'Runs through the Claude Agent SDK. The only provider with Roblox Studio (MCP) tools.',
  openai: 'GPT models. Sign in with ChatGPT through the Codex CLI, or use an API key.',
  gemini: "Google's Gemini models.",
  openrouter: 'Hundreds of models from many labs with one key.',
  ollama: 'Local models on this computer. No key needed.'
}
const KEY_PLACEHOLDER: Partial<Record<AccountId, string>> = { claude: 'sk-ant-...', openai: 'sk-...', openrouter: 'sk-or-...', gemini: 'AIza...' }

function badge(a: AccountSummary): { text: string; cls: string } {
  switch (a.state) {
    case 'subscription':
      return { text: 'signed in', cls: 'ok' }
    case 'apiKey':
    case 'cloud':
      return { text: 'API key', cls: 'ok' }
    case 'local':
      return { text: 'running', cls: 'ok' }
    case 'expired':
      return { text: 'needs attention', cls: 'warn' }
    default:
      return { text: a.id === 'ollama' ? 'not running' : 'not set up', cls: '' }
  }
}

// Cards worth testing when Accounts opens: set up (or expired) and not checked recently.
export function needsAutoTest(a: AccountSummary, now = Date.now()): boolean {
  if (a.state === 'none') return false
  return !a.lastCheck || now - a.lastCheck.at > AUTO_TEST_MS
}

function CheckLine({ check, testing }: { check?: AccountCheck; testing: boolean }) {
  if (testing) return <div className="note acct-check">Testing connection...</div>
  if (!check) return null
  return (
    <div className={`note acct-check ${check.ok ? 'ok' : 'err'}`} title={new Date(check.at).toLocaleString()}>
      {check.ok ? '✓' : '✕'} {check.message} · {ago(check.at)}
    </div>
  )
}

function KeyEditor({ a, onDone }: { a: AccountSummary; onDone?: () => void }) {
  const { actions } = useStore()
  const [key, setKey] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const save = async (value: string) => {
    setBusy(true)
    try {
      await window.harness.setProviderKey(a.provider, value)
      await actions.refreshProviders()
      actions.toast({ text: value ? `${a.label} key saved` : `${a.label} key removed`, kind: 'ok' })
      setKey('')
      setEditing(false)
      if (value) {
        // A new key is worth checking right away.
        void window.harness.accountsTest(a.id).catch(() => undefined)
        onDone?.()
      }
    } catch (e) {
      actions.toast({ text: 'Could not save the key', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }
  if (a.keySource && !editing) {
    return (
      <div className="pv-field acct-field">
        <span className="pv-label">API key</span>
        <code className="pv-hint">{a.keyHint ?? '....'}</code>
        <span className="note grow ellipsis">{a.keySource === 'env' ? `from ${a.envName ?? 'the environment'}` : 'stored in the OS keychain'}</span>
        <button className="btn small" onClick={() => setEditing(true)}>Replace</button>
        {a.keySource === 'stored' && <button className="btn small danger" disabled={busy} onClick={() => void save('')}>Remove</button>}
      </div>
    )
  }
  return (
    <form className="pv-field acct-field" onSubmit={(e) => (e.preventDefault(), key.trim() && void save(key.trim()))}>
      <span className="pv-label">API key</span>
      <input className="input grow" type="password" placeholder={KEY_PLACEHOLDER[a.id] ?? 'API key'} value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} autoComplete="off" aria-label={`${a.label} API key`} />
      <button className="btn primary small" disabled={!key.trim() || busy}>{busy ? 'Saving...' : 'Save'}</button>
      {editing && <button type="button" className="btn small ghost" onClick={() => setEditing(false)}>Cancel</button>}
      {a.keyUrl && a.id !== 'ollama' && (
        <a className="link-btn acct-getkey" href={a.keyUrl} target="_blank" rel="noreferrer">Get a key</a>
      )}
    </form>
  )
}

function SignInProgressPanel({ a, p }: { a: AccountSummary; p: SignInProgress }) {
  const { actions } = useStore()
  const [code, setCode] = useState('')
  return (
    <div className="acct-progress" role="status">
      <div className="row">
        <span className="spinner-dot" aria-hidden />
        <span className="grow">{p.message ?? 'Starting sign-in...'}</span>
        <button className="btn small ghost" onClick={() => void window.harness.accountsCancelSignIn(a.id)}>Cancel</button>
      </div>
      {p.url && (
        <div className="note">
          Browser didn't open?{' '}
          <a className="link-btn" href={p.url} target="_blank" rel="noreferrer">Open the sign-in page</a>
        </div>
      )}
      {p.acceptsCode && (
        <form
          className="pv-field acct-field"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!code.trim()) return
            try {
              await window.harness.accountsSubmitCode(a.id, code.trim())
              setCode('')
            } catch (err) {
              actions.toast({ text: 'Could not send the code', detail: errorText(err), kind: 'err' })
            }
          }}
        >
          <span className="pv-label">Code</span>
          <input className="input grow" value={code} onChange={(e) => setCode(e.target.value)} placeholder="If the page shows a code, paste it here" spellCheck={false} autoComplete="off" aria-label="Sign-in code" />
          <button className="btn small" disabled={!code.trim()}>Send</button>
        </form>
      )}
    </div>
  )
}

function SignOutConfirm({ a, onClose }: { a: AccountSummary; onClose: () => void }) {
  const { actions } = useStore()
  const [busy, setBusy] = useState(false)
  const tool = a.id === 'claude' ? 'Claude Code' : (a.signIn?.needs ?? 'the CLI')
  const go = async (cliLogout: boolean) => {
    setBusy(true)
    try {
      await window.harness.accountsSignOut(a.id, { cliLogout })
      await actions.refreshProviders()
      actions.toast({ text: cliLogout ? `Signed out of ${tool}` : `${a.label} login no longer used by Forge`, kind: 'ok' })
      onClose()
    } catch (e) {
      actions.toast({ text: 'Could not sign out', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }
  if (a.signIn?.cliLogoutOnly) {
    // Codex: Forge holds no login of its own, so signing out means `codex logout`.
    return (
      <div className="acct-confirm">
        <div className="note grow">Log out of the {tool}? This signs out the {tool} everywhere on this computer (terminal and IDE too), not only in Forge.</div>
        <button className="btn small danger" disabled={busy} onClick={() => void go(true)}>Log out of {tool}</button>
        <button className="btn small ghost" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    )
  }
  return (
    <div className="acct-confirm">
      <div className="note grow">Stop using this login in Forge? Logging out of {tool} too also signs out your terminal sessions.</div>
      <button className="btn small" disabled={busy} onClick={() => void go(false)}>Stop using in Forge</button>
      {a.signIn?.canCliLogout && (
        <button className="btn small danger" disabled={busy} onClick={() => void go(true)}>Also log out of {tool}</button>
      )}
      <button className="btn small ghost" disabled={busy} onClick={onClose}>Cancel</button>
    </div>
  )
}

function AccountCard({ a, progress, testing, onTest }: { a: AccountSummary; progress?: SignInProgress; testing: boolean; onTest: () => void }) {
  const { actions } = useStore()
  const [showKey, setShowKey] = useState(false)
  const [confirmOut, setConfirmOut] = useState(false)
  const b = badge(a)
  const s = a.signIn
  const running = !!progress && (progress.phase === 'starting' || progress.phase === 'waiting')
  const signedIn = s?.state === 'signedIn' && !s.foundButOff
  const subscriptionInUse = signedIn || s?.state === 'expired'
  // Claude: the key is the secondary path; it shows when asked for or already in use.
  const keyVisible = a.id === 'ollama' ? false : !s || a.id !== 'claude' || showKey || (!!a.keySource && !subscriptionInUse)

  const signIn = async () => {
    try {
      const r = await window.harness.accountsSignIn(a.id)
      if (r.phase === 'done') {
        await actions.refreshProviders()
        actions.toast({ text: `${a.label}: signed in`, kind: 'ok' })
      } else if (r.phase === 'failed' || r.phase === 'timeout') {
        actions.toast({ text: `${a.label}: sign-in did not finish`, detail: r.message, kind: 'err' })
      }
    } catch (e) {
      actions.toast({ text: 'Sign-in failed', detail: errorText(e), kind: 'err' })
    }
  }
  const useExisting = async () => {
    try {
      await window.harness.accountsUseExistingLogin(a.id)
      await actions.refreshProviders()
      onTest()
    } catch (e) {
      actions.toast({ text: 'Could not use that login', detail: errorText(e), kind: 'err' })
    }
  }
  const test = onTest
  const useKeyInstead = async () => {
    // With a subscription login in use, an API key only takes over once the login is off.
    if (signedIn || s?.state === 'expired') {
      await window.harness.accountsSignOut(a.id, { cliLogout: false }).catch(() => undefined)
      await actions.refreshProviders()
    }
    setShowKey(true)
  }

  return (
    <div className={`pv-card acct-card st-${a.state}${a.ready ? ' ready' : ''}`} id={`acct-${a.id}`} data-state={a.state}>
      <div className="pv-head">
        <ProviderMark id={a.provider} size={22} />
        <div className="grow">
          <div className="set-title">{a.label}</div>
          <div className="note">{BLURB[a.id]}</div>
        </div>
        <span className={`badge-o ${b.cls}`}>{b.text}</span>
      </div>
      <div className="acct-body">
        <div className="acct-status">
          <span className="acct-headline">{a.statusText}</span>
          {s?.account && subscriptionInUse && <span className="note"> · {s.account}</span>}
        </div>
        {s?.state === 'expired' && <div className="note acct-warn">{s.detail ?? 'The last request could not authenticate.'}</div>}
        {s && s.state !== 'unavailable' && !subscriptionInUse && s.detail && <div className="note">{s.detail}{s.account && s.foundButOff ? ` (${s.account})` : ''}</div>}
        <CheckLine check={a.lastCheck} testing={testing} />

        {running && progress && <SignInProgressPanel a={a} p={progress} />}

        {s && !running && (
          <div className="acct-actions">
            {s.state === 'unavailable' ? (
              <>
                <button className="btn small" disabled title={s.detail}>{s.label}</button>
                <span className="note">
                  needs {s.needs ?? 'a CLI'}
                  {s.needsUrl && (
                    <>
                      {' · '}
                      <a className="link-btn" href={s.needsUrl} target="_blank" rel="noreferrer">Get it</a>
                    </>
                  )}
                </span>
              </>
            ) : s.foundButOff ? (
              <>
                <button className="btn primary small" onClick={() => void useExisting()}>Use this login</button>
                <button className="btn small" onClick={() => void signIn()}>{s.label}</button>
              </>
            ) : s.state === 'expired' ? (
              <>
                <button className="btn primary small" onClick={() => void signIn()}>Sign in again</button>
                <button className="btn small" disabled={testing} onClick={test}>Test connection</button>
                <button className="btn small ghost" onClick={() => setConfirmOut(true)}>Sign out</button>
              </>
            ) : signedIn ? (
              <>
                <button className="btn small" disabled={testing} onClick={test}>Test connection</button>
                <button className="btn small ghost" onClick={() => setConfirmOut(true)}>Sign out</button>
              </>
            ) : (
              <button className="btn primary small" onClick={() => void signIn()}>{s.label}</button>
            )}
          </div>
        )}
        {confirmOut && <SignOutConfirm a={a} onClose={() => setConfirmOut(false)} />}

        {a.id === 'claude' && !keyVisible && (
          <button className="link-btn acct-alt" onClick={() => void useKeyInstead()}>Use an API key instead</button>
        )}
        {keyVisible && <KeyEditor a={a} />}
        {keyVisible && a.keySource && !subscriptionInUse && (
          <div className="acct-actions">
            <button className="btn small" disabled={testing} onClick={test}>Test connection</button>
          </div>
        )}

        {a.id === 'ollama' && (
          <div className="acct-actions">
            <button className="btn small" disabled={testing} onClick={test}>Test connection</button>
            {a.state !== 'local' && (
              <a className="link-btn" href={a.keyUrl ?? 'https://ollama.com/download'} target="_blank" rel="noreferrer">Download Ollama</a>
            )}
            <span className="note grow">Server URL is under Providers below{a.baseUrl ? ` (${a.baseUrl})` : ''}.</span>
          </div>
        )}
      </div>
    </div>
  )
}

export function AccountsSection() {
  const [accounts, setAccounts] = useState<AccountSummary[] | null>(null)
  const [progress, setProgress] = useState<Partial<Record<AccountId, SignInProgress>>>({})
  const [testing, setTesting] = useState<Partial<Record<AccountId, boolean>>>({})
  const autoTested = useRef(false)

  useEffect(() => {
    let alive = true
    const load = (refresh = false) =>
      window.harness
        .accountsList({ refresh })
        .then((l) => alive && setAccounts(l))
        .catch(() => alive && setAccounts((cur) => cur ?? []))
    void load(true)
    const offs = [
      window.harness.on('accounts:changed', (l) => setAccounts(l)),
      window.harness.on('providers:changed', () => void load()),
      window.harness.on('accounts:signin', (p) => setProgress((cur) => ({ ...cur, [p.account]: p })))
    ]
    return () => {
      alive = false
      for (const off of offs) off()
    }
  }, [])

  const runTest = (id: AccountId) => {
    setTesting((cur) => ({ ...cur, [id]: true }))
    void window.harness
      .accountsTest(id)
      .catch(() => undefined)
      .finally(() => setTesting((cur) => ({ ...cur, [id]: false })))
  }

  // Test connection automatically (once per visit) for cards whose last check is stale. Cancelled
  // when Settings closes.
  useEffect(() => {
    if (!accounts || autoTested.current) return
    autoTested.current = true
    for (const a of accounts) if (needsAutoTest(a)) runTest(a.id)
  }, [accounts])
  useEffect(
    () => () => {
      for (const id of ['claude', 'openai', 'gemini', 'openrouter', 'ollama'] as AccountId[]) void window.harness.accountsCancelTest(id).catch(() => undefined)
    },
    []
  )

  if (!accounts) return <div className="note">Checking your accounts...</div>
  return (
    <div className="pv-list acct-list">
      {accounts.map((a) => (
        <AccountCard key={a.id} a={a} progress={progress[a.id]} testing={!!testing[a.id]} onTest={() => runTest(a.id)} />
      ))}
    </div>
  )
}
