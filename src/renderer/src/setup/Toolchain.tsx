// Toolchain UI: the first-run "Setting up your toolchain" screen (ToolchainGate, mounted once by
// App), the Settings > Toolchain section, and the toasts for a project's own `rokit install`.
// Everything goes through window.harness.toolchain* (main/setup.ts); nothing here blocks the app.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SetupMode, SetupProgress, SetupResult, ToolStatus, ToolchainStatus } from '@shared/types'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { AnvilMark } from '../components/Brand'
import { errorText } from '../lib/format'
import './setup.css'

type StepView = { state: SetupProgress['state'] | 'pending'; message?: string }

export function useToolchain() {
  const [status, setStatus] = useState<ToolchainStatus | null>(null)
  const [steps, setSteps] = useState<Record<string, StepView>>({})
  const [running, setRunning] = useState<SetupMode | null>(null)
  const [result, setResult] = useState<SetupResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.harness.toolchainStatus())
    } catch (e) {
      setError(errorText(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
    return window.harness.on('toolchain:progress', (p) => setSteps((s) => ({ ...s, [p.step]: { state: p.state, message: p.message } })))
  }, [refresh])

  const run = useCallback(
    async (mode: SetupMode, tools?: string[]) => {
      setRunning(mode)
      setError(null)
      setResult(null)
      const names = tools ?? ['rokit', ...(status?.tools.map((t) => t.alias) ?? [])]
      setSteps((s) => ({ ...s, ...Object.fromEntries(names.map((n) => [n, { state: 'pending' as const }])) }))
      try {
        const r = await window.harness.toolchainSetup({ mode, tools })
        setResult(r)
        return r
      } catch (e) {
        setError(errorText(e))
        return null
      } finally {
        setRunning(null)
        void refresh()
      }
    },
    [status, refresh]
  )

  return { status, steps, running, result, error, refresh, run }
}

const STATE_TAG: Record<ToolStatus['state'], [string, string]> = {
  ok: ['ok', 'installed'],
  other: ['info', 'installed'],
  external: ['', 'on PATH'],
  broken: ['warn', 'broken'],
  missing: ['err', 'missing']
}

function StepIcon({ state }: { state: StepView['state'] | undefined }) {
  if (state === 'running') return <span className="spinner" aria-label="running" />
  if (state === 'done') return <Icon name="check" size={14} />
  if (state === 'failed') return <Icon name="err" size={14} />
  if (state === 'skipped') return <Icon name="arrowRight" size={14} />
  return <span className="led idle" />
}

function ToolRow({ name, sub, version, step, tag, action }: { name: string; sub: string; version: string; step?: StepView; tag?: [string, string]; action?: React.ReactNode }) {
  const state = step?.state
  return (
    <div className={`tc-row ${state ?? 'idle'}`}>
      <span className="tc-ic"><StepIcon state={state ?? (tag?.[0] === 'ok' || tag?.[0] === 'info' || tag?.[1] === 'on PATH' ? 'done' : undefined)} /></span>
      <span className="tc-name">{name}</span>
      <span className="tc-ver mono faint">{version}</span>
      <span className="tc-msg ellipsis" title={step?.message ?? sub}>{step?.message ?? sub}</span>
      {tag && !state && <span className={`tag ${tag[0]}`}>{tag[1]}</span>}
      {action}
    </div>
  )
}

// ---------------------------------------------------------------- first run

export function ToolchainGate() {
  const { state, actions } = useStore()
  const tc = useToolchain()
  const [open, setOpen] = useState(false)
  const started = useRef(false)

  // Decide once: first launch (never set up or skipped) with something missing shows the screen and
  // starts right away. A set-up toolchain that lost tools only gets a toast.
  useEffect(() => {
    if (!tc.status || started.current) return
    started.current = true
    if (!tc.status.needsSetup) return
    if (tc.status.record === 'never') {
      setOpen(true)
      void tc.run('install')
    } else if (tc.status.record === 'done') {
      const missing = tc.status.tools.filter((t) => t.state === 'missing' || t.state === 'broken').map((t) => t.alias)
      actions.toast({
        text: 'Some Roblox tools are missing',
        detail: (tc.status.rokit.installed ? missing : ['rokit', ...missing]).join(', '),
        kind: 'info',
        ms: 0,
        action: { label: 'Repair', run: () => actions.openPage('settings') }
      })
    }
  }, [tc.status])

  // A project's own rokit.toml tools.
  useEffect(
    () =>
      window.harness.on('toolchain:projectTools', (e) => {
        if (e.state === 'running') actions.toast({ text: 'Installing this project\'s tools', detail: e.tools.join(', '), kind: 'info', ms: 4000 })
        else if (e.state === 'done') actions.toast({ text: 'Project tools installed', detail: e.tools.join(', '), kind: 'ok' })
        else actions.toast({ text: e.state === 'needsTrust' ? 'This project pins unknown tools' : 'Could not install the project\'s tools', detail: e.message, kind: 'err', ms: 0, action: { label: 'Packages', run: () => actions.openPage('packages') } })
      }),
    [actions]
  )

  if (!open || !tc.status) return null
  const s = tc.status
  const failed = tc.result?.steps.filter((x) => x.state === 'failed').map((x) => x.step) ?? []
  const done = !tc.running && tc.result
  const skip = async () => {
    await window.harness.toolchainSkip().catch(() => undefined)
    setOpen(false)
    actions.toast({ text: 'Toolchain setup skipped', detail: 'Finish it any time from Settings > Toolchain.', kind: 'info' })
  }
  const close = () => {
    setOpen(false)
    if (tc.result?.ok) actions.toast({ text: 'Toolchain ready', detail: 'rokit, rojo, wally, lune, luau-lsp, blink, selene, stylua', kind: 'ok' })
  }
  const toolSteps = ['rokit', ...s.tools.map((t) => t.alias)]
  const finished = toolSteps.filter((n) => tc.steps[n] && tc.steps[n].state !== 'pending' && tc.steps[n].state !== 'running').length

  return (
    <div className="tc-screen" role="dialog" aria-modal="true" aria-label="Setting up your toolchain">
      <div className="tc-card">
        <div className="tc-head">
          <span className="tc-mark"><AnvilMark size={22} /></span>
          <div className="grow">
            <h1>Setting up your toolchain</h1>
            <p className="note">
              Forge installs rokit and the Roblox tools it uses into <span className="mono">{s.rokit.binDir}</span> for your user only. No admin rights;
              projects keep their own pinned versions.
            </p>
          </div>
        </div>
        <div className="tc-progress" aria-hidden="true"><span style={{ width: `${(finished / toolSteps.length) * 100}%` }} /></div>
        <div className="tc-list">
          <ToolRow name="rokit" sub={s.rokit.bundled ? 'Toolchain manager (bundled with Forge)' : 'Toolchain manager'} version={s.rokit.bundledVersion} step={tc.steps.rokit} />
          {s.tools.map((t) => (
            <ToolRow key={t.alias} name={t.alias} sub={t.purpose} version={t.pinned} step={tc.steps[t.alias]} />
          ))}
          <GitRow git={s.git} onCheck={() => void tc.refresh()} />
        </div>
        {tc.result?.network && <div className="err-text tc-banner"><Icon name="warn" size={13} /> Some downloads could not reach GitHub. Check your connection, then Retry. You can keep using Forge meanwhile.</div>}
        {tc.error && <div className="err-text tc-banner">{tc.error}</div>}
        <div className="tc-actions">
          {tc.running ? (
            <>
              <span className="note grow">{finished} of {toolSteps.length}</span>
              <button className="btn ghost" onClick={() => void skip()}>Skip for now</button>
            </>
          ) : done && failed.length ? (
            <>
              <span className="note grow">{failed.length} failed</span>
              <button className="btn ghost" onClick={() => void skip()}>Skip for now</button>
              <button className="btn primary" onClick={() => void tc.run('install')}><Icon name="restart" size={12} /> Retry</button>
            </>
          ) : (
            <>
              <span className="note grow">{done ? 'All tools are installed.' : ''}</span>
              {!done && <button className="btn ghost" onClick={() => void skip()}>Skip for now</button>}
              <button className="btn primary" onClick={done ? close : () => void tc.run('install')}>{done ? 'Start using Forge' : 'Install'}</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function GitRow({ git, onCheck }: { git: ToolchainStatus['git']; onCheck: () => void }) {
  return (
    <div className={`tc-row ${git.available ? 'done' : 'failed'} tc-git`}>
      <span className="tc-ic">{git.available ? <Icon name="check" size={14} /> : <Icon name="warn" size={14} />}</span>
      <span className="tc-name">git</span>
      <span className="tc-ver mono faint">{git.version ?? '-'}</span>
      <span className="tc-msg ellipsis" title={git.hint ?? git.path ?? ''}>{git.available ? 'Version control (yours, not bundled)' : git.hint}</span>
      {!git.available && (
        <>
          {git.downloadUrl && <button className="btn small" onClick={() => window.open(git.downloadUrl, '_blank')}><Icon name="external" size={11} /> git-scm.com</button>}
          <button className="btn small ghost" onClick={onCheck}>Check again</button>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- Settings > Toolchain

export function ToolchainSection() {
  const { actions } = useStore()
  const tc = useToolchain()
  const s = tc.status
  const go = async (mode: SetupMode, tools?: string[]) => {
    const r = await tc.run(mode, tools)
    if (!r) return
    const failed = r.steps.filter((x) => x.state === 'failed')
    if (failed.length) actions.toast({ text: `${failed.length} tool${failed.length > 1 ? 's' : ''} failed`, detail: failed[0].message, kind: 'err' })
    else if (!r.cancelled) actions.toast({ text: mode === 'update' ? 'Tools updated' : 'Toolchain repaired', kind: 'ok' })
  }
  if (!s) return <div className="note">{tc.error ?? 'Checking tools...'}</div>
  const busy = !!tc.running
  return (
    <div className="tc-settings">
      <p className="note">
        Global tools installed by Forge through rokit ({s.rokit.binDir}). A project's rokit.toml still pins its own versions; Forge runs rokit install
        when you open a project whose tools are missing.
      </p>
      <div className="tc-list">
        <ToolRow
          name="rokit"
          sub={s.rokit.installed ? `Toolchain manager · ${s.rokit.path ?? ''}` : s.rokit.bundled ? 'Not installed yet (bundled copy ready)' : 'Not installed and not bundled with this build'}
          version={s.rokit.version ?? s.rokit.bundledVersion}
          tag={s.rokit.installed ? ['ok', 'installed'] : ['err', 'missing']}
          step={busy ? tc.steps.rokit : undefined}
        />
        {s.tools.map((t) => (
          <ToolRow
            key={t.alias}
            name={t.alias}
            sub={t.path ? `${t.purpose} · ${t.path}` : `${t.purpose} · ${t.id}`}
            version={t.version ?? t.pinned}
            tag={STATE_TAG[t.state]}
            step={busy || tc.steps[t.alias]?.state === 'failed' ? tc.steps[t.alias] : undefined}
            action={
              !busy && (t.state === 'missing' || t.state === 'broken') ? (
                <button className="btn small" onClick={() => void go('repair', [t.alias])}>Install</button>
              ) : undefined
            }
          />
        ))}
        <GitRow git={s.git} onCheck={() => void tc.refresh()} />
      </div>
      <div className="row tc-buttons">
        {busy ? (
          <>
            <span className="spinner" />
            <span className="note grow">{tc.running === 'update' ? 'Updating' : 'Repairing'}...</span>
            <button className="btn small ghost" onClick={() => void window.harness.toolchainCancel()}>Cancel</button>
          </>
        ) : (
          <>
            <button className="btn small" onClick={() => void go('repair')} title="Reinstall rokit and every tool at Forge's pinned versions"><Icon name="tool" size={12} /> Repair</button>
            <button className="btn small" onClick={() => void go('update')} title="Install the latest release of every tool"><Icon name="download" size={12} /> Update</button>
            <span className="grow" />
            <button className="btn small ghost" onClick={() => void tc.refresh()}><Icon name="restart" size={12} /> Check again</button>
          </>
        )}
      </div>
      {tc.result?.network && <div className="err-text">GitHub could not be reached. Check your connection and press Repair to retry.</div>}
    </div>
  )
}
