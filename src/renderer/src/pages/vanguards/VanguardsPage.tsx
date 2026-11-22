// Vanguards & FM Offline Build Pipeline page: external CLI status (ror, rur, ree),
// FM scripts (envbuild, modelpreview, insert_rbxm, mcp_bridge), packs, and quick runners.

import { useCallback, useEffect, useState } from 'react'
import type { VanguardsRunResult, VanguardsStatus } from '@shared/types'
import { Icon } from '../../components/Icons'
import { errorText } from '../../lib/format'

export function VanguardsPage() {
  const h = window.harness
  const [status, setStatus] = useState<VanguardsStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<{ label: string; res: VanguardsRunResult } | null>(null)

  const [binDir, setBinDir] = useState('')
  const [fmDir, setFmDir] = useState('')
  const [packsDir, setPacksDir] = useState('')
  const [customArgs, setCustomArgs] = useState('')
  const [envModule, setEnvModule] = useState('')
  const [previewModel, setPreviewModel] = useState('')

  const syncDirs = (s: VanguardsStatus) => {
    setBinDir(s.binDir)
    setFmDir(s.fmDir)
    setPacksDir(s.packsDir)
  }

  const refresh = useCallback(async () => {
    try {
      const s = await h.vanguardsRefresh()
      setStatus(s)
      syncDirs(s)
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
  }, [h])

  useEffect(() => {
    void h.vanguardsStatus().then((s) => {
      setStatus(s)
      syncDirs(s)
    }).catch((e) => setError(errorText(e)))
    return h.on('vanguards:status', (s) => {
      setStatus(s)
    })
  }, [h])

  const runAction = async (label: string, fn: () => Promise<VanguardsRunResult>) => {
    setBusy(label)
    setError(null)
    try {
      const res = await fn()
      setLastResult({ label, res })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const savePaths = async () => {
    setBusy('save')
    setError(null)
    try {
      const s = await h.vanguardsSetSettings({ binDir, fmDir, packsDir })
      setStatus(s)
      syncDirs(s)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const toggleBridge = async () => {
    if (!status) return
    setBusy('bridge')
    setError(null)
    try {
      const s = status.mcpBridge.running ? await h.vanguardsStopMcpBridge() : await h.vanguardsStartMcpBridge(status.mcpBridge.port)
      setStatus(s)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const parseArgs = (fallback: string[]) => {
    const trimmed = customArgs.trim()
    if (!trimmed) return fallback
    return trimmed.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((s) => s.replace(/^"|"$/g, '')) ?? fallback
  }

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1>Vanguards &amp; Offline Pipeline</h1>
            <div className="sub">External CLIs only (ror DX12, rur UI, ree headless, FM build &amp; asset packs)</div>
          </div>
          <div className="actions">
            <button className="mini-btn" onClick={() => void refresh()} disabled={busy !== null}>
              <Icon name="restart" size={13} /> Refresh
            </button>
          </div>
        </div>

        {error && <div className="callout err">{error}</div>}

        <div className="set-sec">
          <h2>Detected External Tools</h2>
          {status ? (
            (['ror', 'rur', 'ree', 'python', 'lune'] as const).map((id) => {
              const t = status.tools[id]
              return (
                <div className="set-row" key={id}>
                  <div className="set-text">
                    <div className="set-title"><code>{id}</code></div>
                    <div className="note">{t.found ? t.path : 'Not detected'}</div>
                  </div>
                  <div className="set-ctl">
                    <span className={`badge-o ${t.found ? 'ok' : 'warn'}`}>{t.found ? (t.source ?? 'found') : 'missing'}</span>
                  </div>
                </div>
              )
            })
          ) : (
            <div className="note">Detecting Vanguards tools…</div>
          )}
        </div>

        <div className="set-sec">
          <h2>FM Pipeline Scripts &amp; Studio MCP Bridge</h2>
          <div className="set-row">
            <div className="set-text">
              <div className="set-title">StudioMCP TCP Bridge (<code>127.0.0.1:{status?.mcpBridge.port ?? 7655}</code>)</div>
              <div className="note">
                {status?.mcpBridge.running
                  ? `Running (pid ${status.mcpBridge.pid ?? '?'}) — injects RUR_STUDIO_MCP_PORT & ROR_STUDIO_MCP into rur/ror runs`
                  : status?.mcpBridge.lastError
                    ? `Stopped (${status.mcpBridge.lastError})`
                    : 'Stopped — required only for rur compare / ror Studio parity checks'}
              </div>
            </div>
            <div className="set-ctl">
              <span className={`badge-o ${status?.mcpBridge.running ? 'ok' : ''}`}>
                {status?.mcpBridge.running ? 'running' : 'stopped'}
              </span>
              <button className="mini-btn" onClick={() => void toggleBridge()} disabled={busy !== null || !status?.fmScripts.mcp_bridge.found}>
                {status?.mcpBridge.running ? 'Stop Bridge' : 'Start Bridge'}
              </button>
            </div>
          </div>
          {status &&
            (['envbuild', 'modelpreview', 'insert_rbxm', 'mcp_bridge'] as const).map((id) => {
              const s = status.fmScripts[id]
              return (
                <div className="set-row" key={id}>
                  <div className="set-text">
                    <div className="set-title"><code>{id}.py</code></div>
                    <div className="note">{s.found ? s.path : `Missing in ${status.fmDir}`}</div>
                  </div>
                  <div className="set-ctl">
                    <span className={`badge-o ${s.found ? 'ok' : 'warn'}`}>{s.found ? 'ready' : 'missing'}</span>
                  </div>
                </div>
              )
            })}
        </div>

        <div className="set-sec">
          <h2>Quick Offline Checks &amp; Builds</h2>
          <div className="set-row">
            <div className="set-text">
              <div className="set-title">CLI Arguments</div>
              <div className="note">Optional override args shared by rur / ror / ree buttons below</div>
            </div>
            <div className="set-ctl" style={{ minWidth: 280 }}>
              <input
                className="input"
                placeholder="e.g. stories --json"
                value={customArgs}
                onChange={(e) => setCustomArgs(e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
          </div>
          <div className="set-row">
            <div className="set-text">
              <div className="set-title">Run Vanguards CLIs</div>
              <div className="note">Runs headlessly outside Studio (DX12 + 2GB memory floor injected for ror)</div>
            </div>
            <div className="set-ctl">
              <button className="mini-btn" disabled={busy !== null || !status?.tools.rur.found} onClick={() => void runAction('rur stories', () => h.vanguardsRunRur({ args: ['stories'] }))}>
                rur stories
              </button>
              <button className="mini-btn" disabled={busy !== null || !status?.tools.rur.found} onClick={() => void runAction('rur doctor', () => h.vanguardsRunRur({ args: ['doctor'] }))}>
                rur doctor
              </button>
              <button className="mini-btn" disabled={busy !== null || !status?.tools.rur.found} onClick={() => void runAction('rur', () => h.vanguardsRunRur({ args: parseArgs(['--help']) }))}>
                Run rur
              </button>
              <button className="mini-btn" disabled={busy !== null || !status?.tools.ror.found} onClick={() => void runAction('ror', () => h.vanguardsRunRor({ args: parseArgs(['--help']) }))}>
                Run ror
              </button>
              <button className="mini-btn" disabled={busy !== null || !status?.tools.ree.found} onClick={() => void runAction('ree', () => h.vanguardsRunRee({ args: parseArgs(['--help']) }))}>
                Run ree
              </button>
            </div>
          </div>
          <div className="set-row">
            <div className="set-text">
              <div className="set-title">FM Envbuild Module</div>
              <div className="note">Bakes env-study module offline via ror + ree into <code>final.rbxm</code></div>
            </div>
            <div className="set-ctl">
              <input className="input" placeholder="e.g. Rooftop" value={envModule} onChange={(e) => setEnvModule(e.target.value)} style={{ width: 160 }} />
              <button
                className="mini-btn"
                disabled={busy !== null || !envModule.trim() || !status?.fmScripts.envbuild.found}
                onClick={() => void runAction(`envbuild ${envModule.trim()}`, () => h.vanguardsFmEnvbuild({ module: envModule.trim() }))}
              >
                Bake Module
              </button>
            </div>
          </div>
          <div className="set-row">
            <div className="set-text">
              <div className="set-title">FM Model Preview</div>
              <div className="note">Renders multi-view PNGs + <code>sheet.jpg</code> of a <code>.rbxm</code> file via ror</div>
            </div>
            <div className="set-ctl">
              <input className="input" placeholder="Path to model.rbxm" value={previewModel} onChange={(e) => setPreviewModel(e.target.value)} style={{ width: 200 }} />
              <button
                className="mini-btn"
                disabled={busy !== null || !previewModel.trim() || !status?.fmScripts.modelpreview.found}
                onClick={() => void runAction(`modelpreview`, () => h.vanguardsFmModelpreview({ modelPath: previewModel.trim() }))}
              >
                Preview Model
              </button>
            </div>
          </div>
        </div>

        {lastResult && (
          <div className="set-sec">
            <h2>
              <span>Last Run: {lastResult.label}</span>
              <span className="grow" />
              <span className={`badge-o ${lastResult.res.ok ? 'ok' : 'err'}`}>
                {lastResult.res.ok ? `ok · ${lastResult.res.durationMs}ms` : `exit ${lastResult.res.code}`}
              </span>
            </h2>
            {lastResult.res.error && <div className="callout err">{lastResult.res.error}</div>}
            {lastResult.res.outputPath && <div className="note" style={{ marginBottom: 6 }}>Baked model: <code>{lastResult.res.outputPath}</code></div>}
            {lastResult.res.images?.length ? (
              <div className="note" style={{ marginBottom: 8 }}>
                Generated images ({lastResult.res.images.length}): {lastResult.res.images.map((p) => <code key={p} style={{ marginRight: 6 }}>{p}</code>)}
              </div>
            ) : null}
            <pre style={{ margin: 0, maxHeight: 260, overflow: 'auto', fontSize: 11.5, background: 'var(--bg-0)', padding: 10, borderRadius: 6, border: '1px solid var(--line)' }}>
              {[lastResult.res.stdout, lastResult.res.stderr].filter(Boolean).join('\n--- stderr ---\n') || '(no output)'}
            </pre>
          </div>
        )}

        <div className="set-sec">
          <h2>Asset Packs ({status?.packs.length ?? 0})</h2>
          {status?.packs.length ? (
            status.packs.map((p) => (
              <div className="set-row" key={p.path}>
                <div className="set-text">
                  <div className="set-title">{p.name}</div>
                  <div className="note"><code>{p.path}</code></div>
                </div>
                <div className="set-ctl">
                  <span className="badge-o">{p.files ?? 0} files</span>
                </div>
              </div>
            ))
          ) : (
            <div className="note">No packs found in <code>{status?.packsDir ?? 'C:\\tools\\packs'}</code></div>
          )}
        </div>

        <div className="set-sec">
          <h2>Directories</h2>
          <div className="set-row">
            <div className="set-text">
              <div className="set-title">Vanguards bin folder</div>
              <div className="note">Contains <code>ror.cmd</code>, <code>rur.cmd</code>, <code>ree.cmd</code></div>
            </div>
            <div className="set-ctl" style={{ minWidth: 280 }}>
              <input className="input" value={binDir} onChange={(e) => setBinDir(e.target.value)} style={{ width: '100%' }} />
            </div>
          </div>
          <div className="set-row">
            <div className="set-text">
              <div className="set-title">FM scripts folder</div>
              <div className="note">Contains <code>envbuild.py</code>, <code>modelpreview.py</code>, <code>insert_rbxm.py</code>, <code>mcp_bridge.py</code></div>
            </div>
            <div className="set-ctl" style={{ minWidth: 280 }}>
              <input className="input" value={fmDir} onChange={(e) => setFmDir(e.target.value)} style={{ width: '100%' }} />
            </div>
          </div>
          <div className="set-row">
            <div className="set-text">
              <div className="set-title">Packs folder</div>
              <div className="note">Root directory for offline model/environment build kits</div>
            </div>
            <div className="set-ctl" style={{ minWidth: 280 }}>
              <input className="input" value={packsDir} onChange={(e) => setPacksDir(e.target.value)} style={{ width: '100%' }} />
            </div>
          </div>
          <div className="set-row">
            <div className="set-text" />
            <div className="set-ctl">
              <button className="mini-btn" onClick={() => void savePaths()} disabled={busy !== null}>Save Directories</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
