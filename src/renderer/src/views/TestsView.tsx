// Tests: headless Lune specs (discover, run all / file / name, watch, live results) and test agents
// (scenarios played in Studio or reviewed in code, with transcripts in editor tabs).
import { useEffect, useMemo, useState } from 'react'
import type { ModelChoice, TestAgent, TestCaseResult } from '@shared/types'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { ModelPicker, providerLabel } from '../components/ModelPicker'
import { useMenu } from '../components/Menu'
import { basename } from '../lib/roblox'
import { fmtDuration, fmtUsd, errorText, keyHint } from '../lib/format'

const AGENT_TAG: Record<TestAgent['state'], string> = { queued: '', running: 'info', passed: 'ok', failed: 'err', error: 'err', cancelled: '' }

function ResultRow({ r }: { r: TestCaseResult }) {
  const { actions } = useStore()
  const [open, setOpen] = useState(r.status === 'fail')
  return (
    <>
      <div className="tres" onClick={() => (r.error ? setOpen(!open) : void actions.openFile(r.file))} title={`${r.file}\n${r.suite ? r.suite + ' > ' : ''}${r.test}`}>
        <span className={`st-${r.status}`}>{r.status === 'pass' ? '✓' : r.status === 'fail' ? '×' : '–'}</span>
        <span className="grow ellipsis">{r.suite ? <span className="faint">{r.suite} › </span> : null}{r.test}</span>
        <span className="faint">{r.ms}ms</span>
      </div>
      {open && r.error && (
        <div className="terr" onClick={() => r.error?.line && void actions.openFileAt(r.file, r.error.line)}>
          {r.error.message}
          {r.error.stack ? `\n${r.error.stack}` : ''}
        </div>
      )}
    </>
  )
}

function Lune() {
  const { state, actions } = useStore()
  const menu = useMenu()
  const t = state.tests
  const [name, setName] = useState('')
  const results = t.running ? t.live : t.last?.results ?? []
  const byFile = useMemo(() => {
    const m = new Map<string, TestCaseResult[]>()
    for (const r of results) m.set(r.file, [...(m.get(r.file) ?? []), r])
    return [...m.entries()]
  }, [results])
  const toggleWatch = async () => {
    try {
      const on = await window.harness.testsWatch(!t.watching)
      actions.set({ tests: { ...t, watching: on } })
    } catch (e) {
      actions.toast({ text: 'Watch mode failed', detail: errorText(e), kind: 'err' })
    }
  }
  const last = t.last
  return (
    <section className="vsec">
      <div className="vsec-head">
        Lune tests <span className="count">{t.specs.length}</span>
        <span className="grow" />
        <button className="link-btn" onClick={() => void actions.refreshTests()}>refresh</button>
      </div>
      {t.status && !t.status.available ? (
        <div className="vbox">
          <div className="warn-text" style={{ marginBottom: 6 }}>Lune is not installed.</div>
          <div className="note">{t.status.hint}</div>
          <button className="btn" style={{ marginTop: 8 }} onClick={() => actions.openPage('packages')}>Open Packages · Tools</button>
        </div>
      ) : (
        <>
          <div className="row" style={{ padding: '2px 12px 6px', flexWrap: 'wrap' }}>
            {t.running ? (
              <button className="btn" onClick={() => void window.harness.testsCancel()}><Icon name="stop" size={12} /> Stop</button>
            ) : (
              <button className="btn primary" onClick={() => void actions.runTests({ scope: { kind: 'all' } })} disabled={!t.specs.length}><Icon name="play" size={12} /> Run all</button>
            )}
            <button className={`btn${t.watching ? ' primary' : ''}`} onClick={() => void toggleWatch()} title="Re-run specs when files change">
              <Icon name="eye" size={12} /> {t.watching ? 'Watching' : 'Watch'}
            </button>
            {t.status?.available && <span className="note">lune {t.status.version}</span>}
          </div>
          <div className="row" style={{ padding: '0 12px 6px' }}>
            <input className="input grow" placeholder="run tests named…" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void actions.runTests({ scope: { kind: 'name', name: name.trim() } })} spellCheck={false} />
          </div>
          {(t.running || last) && (
            <div className="lrow static">
              {t.running ? <span className="spinner" /> : <span className={`badge-o ${last!.state === 'passed' ? 'ok' : last!.state === 'failed' || last!.state === 'error' || last!.state === 'timeout' ? 'err' : 'warn'}`}>{last!.state}</span>}
              <span className="sub">
                {t.running ? `${t.live.length} done · ${t.files.length} files` : `${last!.passed} passed · ${last!.failed} failed · ${last!.skipped} skipped · ${fmtDuration(last!.ms)}`}
              </span>
            </div>
          )}
          {last?.message && !t.running && <div className="note" style={{ padding: '0 12px' }}>{last.message}</div>}
          {byFile.map(([file, rs]) => (
            <div key={file}>
              <div className="lrow" onClick={() => void actions.openFile(file)} onContextMenu={(e) => menu.openAt(e, [{ label: 'Run this file', icon: <Icon name="play" />, onSelect: () => void actions.runTests({ scope: { kind: 'file', file } }) }, { label: 'Open', icon: <Icon name="file" />, onSelect: () => void actions.openFile(file) }])}>
                <Icon name="flask" size={13} />
                <span className="grow ellipsis">{basename(file)}</span>
                <span className="sub">{rs.filter((r) => r.status === 'pass').length}/{rs.length}</span>
              </div>
              {rs.map((r, i) => <ResultRow key={i} r={r} />)}
            </div>
          ))}
          {!byFile.length && !t.running && (
            <>
              {t.specs.map((s) => (
                <div key={s.file} className="lrow" onClick={() => void actions.openFile(s.file)} onContextMenu={(e) => menu.openAt(e, [{ label: 'Run this spec', icon: <Icon name="play" />, onSelect: () => void actions.runTests({ scope: { kind: 'file', file: s.file } }) }])}>
                  <Icon name="flask" size={13} />
                  <span className="grow ellipsis">{basename(s.file)}</span>
                  <span className={`tag ${s.realm}`}>{s.realm}</span>
                  <button className="row-act" style={{ display: 'grid' }} title="Run" onClick={(e) => (e.stopPropagation(), void actions.runTests({ scope: { kind: 'file', file: s.file } }))}><Icon name="play" size={11} /></button>
                </div>
              ))}
              {!t.specs.length && <div className="note" style={{ padding: '0 12px' }}>No *.spec.luau files yet. Right-click a ModuleScript in the Explorer and pick Create spec.</div>}
            </>
          )}
        </>
      )}
      {menu.node}
    </section>
  )
}

function Agents() {
  const { state, actions } = useStore()
  const [text, setText] = useState('')
  const [starting, setStarting] = useState(false)
  const [picked, setPicked] = useState<ModelChoice | null>(null)
  const choice = picked ?? state.defaultModel
  const ready = !!state.providers?.find((p) => p.id === choice?.provider)?.ready
  const scenarios = text.split('\n').map((s) => s.trim()).filter(Boolean)
  const running = state.agents.some((a) => a.state === 'running')
  const [, tick] = useState(0)
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [running])
  const run = async () => {
    setStarting(true)
    try {
      await window.harness.runAgents(scenarios, choice ?? undefined)
      setText('')
    } catch (e) {
      actions.toast({ text: 'Agents could not start', detail: errorText(e), kind: 'err' })
    } finally {
      setStarting(false)
    }
  }
  return (
    <section className="vsec">
      <div className="vsec-head">Test agents <span className="count">{state.agents.length}</span></div>
      <div className="textarea-box">
        <textarea
          className="input"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'one scenario per line\nbuy the starter sword with 100 coins'}
          onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && scenarios.length && void run()}
          spellCheck={false}
        />
      </div>
      <div className="row" style={{ padding: '0 10px 6px' }}>
        <ModelPicker value={choice} providers={state.providers} onChange={setPicked} onAddKey={(id) => actions.openSettings(id)} direction="down" />
        <span className="grow" />
        <button className="btn primary" disabled={!scenarios.length || starting || !ready} onClick={() => void run()} title={ready ? `Run (${keyHint('mod+enter')})` : 'Set up this provider in Settings'}>
          <Icon name="play" size={12} /> Run{scenarios.length > 1 ? ` ${scenarios.length}` : ''}
        </button>
      </div>
      <div className="note" style={{ padding: '0 12px 6px' }}>
        {choice?.provider === 'anthropic' ? 'Agents play-test in Studio when the Studio MCP is set up; otherwise they review code.' : `Studio tools need Anthropic. On ${choice ? providerLabel(choice.provider) : 'this provider'} agents review the code only.`}
      </div>
      {!state.agents.length && <div className="note" style={{ padding: '0 12px' }}>Agents play your game in Studio and report what broke.</div>}
      {state.agents.map((a) => {
        const live = a.state === 'running' || a.state === 'queued'
        const secs = a.startedAt ? ((a.finishedAt ?? Date.now()) - a.startedAt) : 0
        return (
          <div key={a.id} className="lrow" onClick={() => actions.openTranscript(a.id, `Agent · ${a.scenario.slice(0, 24)}`)} title={`${a.scenario}${a.summary ? `\n\n${a.summary}` : ''}`}>
            {live ? <span className="spinner" /> : <span className={`led ${a.state === 'passed' ? 'ok' : a.state === 'failed' || a.state === 'error' ? 'err' : 'idle'}`} />}
            <span className="grow ellipsis">{a.scenario}</span>
            {a.usage && <span className="sub">{fmtUsd(a.usage.costUsd)}</span>}
            {secs > 0 && <span className="sub">{fmtDuration(secs)}</span>}
            <span className={`tag ${AGENT_TAG[a.state]}`}>{a.state}</span>
            {live && (
              <button className="row-act" style={{ display: 'grid' }} title="Cancel" onClick={(e) => (e.stopPropagation(), void window.harness.cancelAgent(a.id))}>
                <Icon name="x" size={11} />
              </button>
            )}
          </div>
        )
      })}
    </section>
  )
}

export function TestsView() {
  return (
    <>
      <div className="panel-head">
        <span className="panel-title">Tests &amp; agents</span>
      </div>
      <div className="panel-body">
        <Lune />
        <Agents />
      </div>
    </>
  )
}
