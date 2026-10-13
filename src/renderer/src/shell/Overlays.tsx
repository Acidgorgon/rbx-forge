// Toasts (bottom-right, 6s, hover pauses) and the app's modal dialogs: confirm, rename feature,
// new Blink event, join project, feature branch, pull request.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { JoinProgress, JoinStepId } from '@shared/types'
import { useStore, type ToastSpec } from '../store'
import { Icon } from '../components/Icons'
import { featuresOf, scriptsFlat } from '../lib/roblox'
import { errorText, keyHint } from '../lib/format'
import { sparks } from '../lib/sparks'

// ---------------------------------------------------------------- toasts

function Toast({ t }: { t: ToastSpec }) {
  const { actions } = useStore()
  const [out, setOut] = useState(false)
  const ms = t.ms ?? 6000
  const remaining = useRef(ms)
  const started = useRef(Date.now())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const removeToast = useRemove()
  const remove = () => {
    setOut(true)
    setTimeout(() => removeToast(t.id), 180)
  }
  const start = () => {
    if (!ms) return
    started.current = Date.now()
    timer.current = setTimeout(remove, remaining.current)
  }
  const pause = () => {
    if (timer.current) clearTimeout(timer.current)
    remaining.current -= Date.now() - started.current
  }
  useEffect(() => {
    start()
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])
  const icon = t.kind === 'err' ? 'err' : t.kind === 'ok' ? 'check' : t.kind === 'hot' ? 'hammer' : 'info'
  return (
    <div className={`toast${out ? ' out' : ''}`} role="status" onMouseEnter={pause} onMouseLeave={start} style={{ ['--toast-ms' as string]: `${ms}ms` }}>
      <span className={`ti ${t.kind ?? ''}`}>
        <Icon name={icon} size={14} />
      </span>
      <div className="tt">
        <div>{t.text}</div>
        {t.detail && <small title={t.detail}>{t.detail}</small>}
      </div>
      {t.action && (
        <button
          className="mini-btn"
          onClick={() => {
            t.action!.run()
            remove()
          }}
        >
          {t.action.label}
        </button>
      )}
      <button className="icon-btn" aria-label="Dismiss" onClick={remove}>
        <Icon name="x" size={12} />
      </button>
      {!!ms && <span className="timer" />}
    </div>
  )
}

function useRemove() {
  const { state, actions } = useStore()
  const ref = useRef(state.toasts)
  ref.current = state.toasts
  return (id: number) => actions.set({ toasts: ref.current.filter((x) => x.id !== id) })
}

export function Toasts() {
  const { state } = useStore()
  return (
    <div className="toasts" aria-live="polite">
      {state.toasts.map((t) => (
        <Toast key={t.id} t={t} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- dialog frame

function Dialog({ title, children, onClose, width }: { title: string; children: ReactNode; onClose: () => void; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <>
      <div className="scrim" onMouseDown={onClose} />
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} style={width ? { width: `min(${width}px, calc(100vw - 32px))` } : undefined}>
        <h2>{title}</h2>
        {children}
      </div>
    </>
  )
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9]*$/
const KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while', 'continue', 'export', 'type'])

export function validateName(name: string, taken: string[] = []): string | null {
  if (!name) return 'A name is required.'
  if (name.startsWith('_') || name.startsWith('.')) return 'Names starting with _ or . are not allowed.'
  if (!NAME_RE.test(name)) return 'Use PascalCase letters and digits (A–Z, 0–9).'
  if (KEYWORDS.has(name.toLowerCase())) return `"${name}" is a Luau keyword.`
  if (taken.some((t) => t.toLowerCase() === name.toLowerCase())) return `"${name}" already exists here.`
  return null
}

// ---------------------------------------------------------------- dialogs

function ConfirmDialog({ title, body, confirm, danger, run, onClose }: { title: string; body: string; confirm: string; danger?: boolean; run: () => void; onClose: () => void }) {
  return (
    <Dialog title={title} onClose={onClose}>
      <p>{body}</p>
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button
          className={`btn ${danger ? 'danger' : 'primary'}`}
          autoFocus
          onClick={() => {
            onClose()
            run()
          }}
        >
          {confirm}
        </button>
      </div>
    </Dialog>
  )
}

function RenameFeatureDialog({ from, onClose }: { from?: string; onClose: () => void }) {
  const { state, actions } = useStore()
  const features = featuresOf(scriptsFlat(state.scripts))
  const [source, setSource] = useState(from ?? features[0]?.name ?? '')
  const [to, setTo] = useState(from ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const f = features.find((x) => x.name === source)
  const problem = to === source ? 'Pick a new name.' : validateName(to, features.map((x) => x.name).filter((n) => n !== source))
  const submit = async () => {
    if (problem || !source) return
    setBusy(true)
    setError(null)
    try {
      const r = await window.harness.renameFeature(source, to)
      onClose()
      const target = r.moved.find((m) => /Service\.luau?$/.test(m.to))?.to
      if (target) void actions.openFile(target)
      if (r.notes.length) actions.toast({ text: `Renamed ${r.from} → ${r.to}`, detail: r.notes.join(' · '), kind: 'info' })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title="Rename Feature" onClose={onClose}>
      <p>Renames the shared module, its Service and its Controller together and updates requires. The dev watcher is paused while it runs.</p>
      {!features.length ? (
        <p className="note">No features found under src/shared/Features.</p>
      ) : (
        <div className="col-form">
          <label className="field">
            <span>Feature</span>
            <select className="input" value={source} onChange={(e) => setSource(e.target.value)} disabled={!!from}>
              {features.map((x) => (
                <option key={x.name} value={x.name}>{x.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>New name</span>
            <input className="input mono" autoFocus value={to} onChange={(e) => setTo(e.target.value.trim())} onKeyDown={(e) => e.key === 'Enter' && void submit()} spellCheck={false} />
          </label>
          {to && problem && <div className="err-text">{problem}</div>}
          {f && to && !problem && (
            <div className="note mono">
              {f.shared && <div>shared/Features/{source} → {to}</div>}
              {f.service && <div>{source}Service → {to}Service</div>}
              {f.controller && <div>{source}Controller → {to}Controller</div>}
            </div>
          )}
          {error && <div className="err-text">{error}</div>}
        </div>
      )}
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!!problem || busy || !features.length} onClick={() => void submit()}>
          {busy && <span className="spinner" />} Rename
        </button>
      </div>
    </Dialog>
  )
}

function BlinkEventDialog({ onClose }: { onClose: () => void }) {
  const { state, actions } = useStore()
  const files = (state.blink?.files?.map((m) => m.file) ?? [state.blink?.file]).filter((x): x is string => !!x)
  const [file, setFile] = useState(files[0] ?? 'events.blink')
  const [name, setName] = useState('')
  const [from, setFrom] = useState<'Server' | 'Client'>('Server')
  const [type, setType] = useState<'Reliable' | 'Unreliable'>('Reliable')
  const [call, setCall] = useState('SingleSync')
  const [data, setData] = useState('')
  const [busy, setBusy] = useState(false)
  const taken = (state.blink?.files ?? (state.blink ? [state.blink] : [])).flatMap((m) => m.events.map((e) => e.name))
  const problem = validateName(name, taken)
  const submit = async (el?: HTMLElement | null) => {
    if (problem) return
    setBusy(true)
    try {
      let current = ''
      try {
        current = await window.harness.readFile(file)
      } catch {
        current = ''
      }
      const block = `event ${name} {\n\tFrom: ${from},\n\tType: ${type},\n\tCall: ${call},\n\tData: ${data.trim() || 'struct { }'}\n}\n`
      const sep = current && !current.endsWith('\n\n') ? (current.endsWith('\n') ? '\n' : '\n\n') : ''
      const next = current + sep + block
      await window.harness.writeFile(file, next)
      sparks(el)
      onClose()
      await actions.reloadFile(file)
      const line = next.slice(0, next.length - block.length).split('\n').length
      void actions.openFileAt(file, line, 7)
      actions.toast({ text: `Event ${name} added`, detail: `${file} · Blink recompiles the outputs`, kind: 'hot' })
    } catch (e) {
      actions.toast({ text: 'Could not add the event', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }
  const submitRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog title="New Blink event" onClose={onClose} width={480}>
      <p>Appends an event block to a Blink file. Saving triggers a compile; errors show in Problems.</p>
      <div className="col-form">
        <div className="grid2">
          <label className="field">
            <span>Name</span>
            <input className="input mono" autoFocus value={name} placeholder="PlayerDamaged" onChange={(e) => setName(e.target.value.trim())} spellCheck={false} onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && void submit(submitRef.current)} />
          </label>
          <label className="field">
            <span>File</span>
            {files.length > 1 ? (
              <select className="input" value={file} onChange={(e) => setFile(e.target.value)}>
                {files.map((f) => <option key={f}>{f}</option>)}
              </select>
            ) : (
              <input className="input mono" value={file} onChange={(e) => setFile(e.target.value)} />
            )}
          </label>
        </div>
        {name && problem && <div className="err-text">{problem}</div>}
        <div className="grid2">
          <div className="field">
            <span>From</span>
            <div className="seg">
              {(['Server', 'Client'] as const).map((v) => <button key={v} className={from === v ? 'on' : ''} onClick={() => setFrom(v)}>{v}</button>)}
            </div>
          </div>
          <div className="field">
            <span>Type</span>
            <div className="seg">
              {(['Reliable', 'Unreliable'] as const).map((v) => <button key={v} className={type === v ? 'on' : ''} onClick={() => setType(v)}>{v}</button>)}
            </div>
          </div>
        </div>
        <label className="field">
          <span>Call</span>
          <select className="input" value={call} onChange={(e) => setCall(e.target.value)}>
            {['SingleSync', 'SingleAsync', 'ManySync', 'ManyAsync', 'Polling'].map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Data</span>
          <input className="input mono" value={data} placeholder="struct { amount: u16, source: Instance? }" onChange={(e) => setData(e.target.value)} spellCheck={false} />
        </label>
      </div>
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button ref={submitRef} className="btn primary" disabled={!!problem || busy} onClick={(e) => void submit(e.currentTarget)}>
          Add event <kbd>{keyHint('mod+enter')}</kbd>
        </button>
      </div>
    </Dialog>
  )
}

const JOIN_STEPS: { id: JoinStepId; label: string }[] = [
  { id: 'clone', label: 'Clone the repository' },
  { id: 'rokit', label: 'Install pinned tools (rokit)' },
  { id: 'wally', label: 'Install packages (wally)' },
  { id: 'validate', label: 'Check the Rojo project' }
]

function JoinProjectDialog({ onClose }: { onClose: () => void }) {
  const { actions } = useStore()
  const [repoUrl, setRepoUrl] = useState('')
  const [parentDir, setParentDir] = useState('')
  const [name, setName] = useState('')
  const [trust, setTrust] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<Record<string, JoinProgress>>({})
  const [result, setResult] = useState<{ root: string; notes: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => window.harness.on('collab:joinProgress', (p) => setProgress((x) => ({ ...x, [p.step]: p }))), [])
  const submit = async () => {
    setRunning(true)
    setError(null)
    setProgress({})
    try {
      const r = await window.harness.joinProject({ repoUrl: repoUrl.trim(), parentDir: parentDir.trim(), name: name.trim() || undefined, trustTools: trust })
      setResult({ root: r.root, notes: r.notes })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setRunning(false)
    }
  }
  return (
    <Dialog title="Join a project" onClose={running ? () => undefined : onClose} width={500}>
      <p>Clones a team's game, installs its pinned tools and packages, then opens it.</p>
      {!result && (
        <div className="col-form">
          <label className="field">
            <span>Repository URL</span>
            <input className="input mono" autoFocus value={repoUrl} placeholder="https://github.com/team/game.git" onChange={(e) => setRepoUrl(e.target.value)} disabled={running} spellCheck={false} />
          </label>
          <div className="grid2">
            <label className="field">
              <span>Parent folder</span>
              <input className="input mono" value={parentDir} placeholder="~/Games" onChange={(e) => setParentDir(e.target.value)} disabled={running} spellCheck={false} />
            </label>
            <label className="field">
              <span>Folder name (optional)</span>
              <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} disabled={running} spellCheck={false} />
            </label>
          </div>
          <label className="row note" style={{ gap: 8 }}>
            <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} disabled={running} />
            Trust the tools this game pins in rokit.toml (skips rokit's trust prompt)
          </label>
        </div>
      )}
      {(running || Object.keys(progress).length > 0) && (
        <div className="steps">
          {JOIN_STEPS.map((s) => {
            const p = progress[s.id]
            return (
              <div key={s.id} className={`step ${p?.state ?? 'idle'}`}>
                {p?.state === 'running' ? <span className="spinner" /> : p?.state === 'done' ? <Icon name="check" size={14} /> : p?.state === 'failed' ? <Icon name="err" size={14} /> : p?.state === 'skipped' ? <Icon name="arrowRight" size={14} /> : <span className="led idle" />}
                <span className="grow">{s.label}</span>
                {p?.message && <span className="faint mono ellipsis" style={{ maxWidth: 200, fontSize: 11 }}>{p.message}</span>}
              </div>
            )
          })}
        </div>
      )}
      {result && (
        <div className="note">
          <div className="ok-text">Ready at <span className="mono">{result.root}</span></div>
          {result.notes.map((n, i) => <div key={i}>{n}</div>)}
        </div>
      )}
      {error && <div className="err-text">{error}</div>}
      <div className="actions">
        {result ? (
          <>
            <button className="btn ghost" onClick={onClose}>Close</button>
            <button
              className="btn primary"
              onClick={() => {
                onClose()
                void window.harness.openProject(result.root).catch((e) => actions.toast({ text: 'Could not open the project', detail: errorText(e), kind: 'err' }))
              }}
            >
              Open project
            </button>
          </>
        ) : (
          <>
            <button className="btn ghost" onClick={onClose} disabled={running}>Cancel</button>
            <button className="btn primary" disabled={running || !repoUrl.trim() || !parentDir.trim()} onClick={() => void submit()}>
              {running && <span className="spinner" />} Join
            </button>
          </>
        )}
      </div>
    </Dialog>
  )
}

function FeatureBranchDialog({ onClose }: { onClose: () => void }) {
  const { state, actions } = useStore()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.harness.startFeatureBranch(name.trim())
      onClose()
      actions.toast({ text: `On branch ${r.branch}`, detail: [r.from ? `from ${r.from}` : null, r.synced ? 'synced first' : null, r.note].filter(Boolean).join(' · '), kind: 'ok' })
      void actions.refreshSync()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title="Start a feature branch" onClose={onClose}>
      <p>Syncs {state.git?.branch ?? 'the current branch'} first, then creates and switches to a new branch for your work.</p>
      <label className="field">
        <span>Branch name</span>
        <input className="input mono" autoFocus value={name} placeholder="shop-ui" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void submit()} spellCheck={false} />
      </label>
      {error && <div className="err-text" style={{ marginTop: 8 }}>{error}</div>}
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!name.trim() || busy} onClick={() => void submit()}>
          {busy && <span className="spinner" />} Start branch
        </button>
      </div>
    </Dialog>
  )
}

function PullRequestDialog({ onClose }: { onClose: () => void }) {
  const { state, actions } = useStore()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [base, setBase] = useState('')
  const [draft, setDraft] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.harness.openPullRequest({ title: title.trim(), body: body.trim() || undefined, base: base.trim() || undefined, draft })
      onClose()
      if (r.kind === 'created') actions.toast({ text: 'Pull request opened', detail: r.url, kind: 'ok', ms: 0, action: { label: 'View', run: () => window.open(r.url, '_blank') } })
      else actions.toast({ text: 'Finish the pull request in your browser', detail: r.reason, kind: 'info' })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title="Open a pull request" onClose={onClose} width={500}>
      <p>Pushes {state.git?.branch ?? 'this branch'} and opens a pull request with the GitHub CLI (or in your browser when gh is not signed in).</p>
      <div className="col-form">
        <label className="field">
          <span>Title</span>
          <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea className="input" rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <div className="grid2">
          <label className="field">
            <span>Base branch (optional)</span>
            <input className="input mono" value={base} placeholder="main" onChange={(e) => setBase(e.target.value)} spellCheck={false} />
          </label>
          <label className="row note" style={{ alignSelf: 'end', height: 26 }}>
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Draft
          </label>
        </div>
      </div>
      {error && <div className="err-text" style={{ marginTop: 8 }}>{error}</div>}
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!title.trim() || busy} onClick={() => void submit()}>
          {busy && <span className="spinner" />} Open pull request
        </button>
      </div>
    </Dialog>
  )
}

export function Dialogs() {
  const { state, actions } = useStore()
  const d = state.dialog
  if (!d) return null
  const close = () => actions.openDialog(null)
  switch (d.kind) {
    case 'confirm':
      return <ConfirmDialog {...d} onClose={close} />
    case 'renameFeature':
      return <RenameFeatureDialog from={d.from} onClose={close} />
    case 'blinkEvent':
      return <BlinkEventDialog onClose={close} />
    case 'joinProject':
      return <JoinProjectDialog onClose={close} />
    case 'featureBranch':
      return <FeatureBranchDialog onClose={close} />
    case 'pullRequest':
      return <PullRequestDialog onClose={close} />
  }
}
