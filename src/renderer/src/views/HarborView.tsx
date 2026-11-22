// Harbor Family Stack view: Current, Ripple, Anchor, Tide, Lighthouse card grid,
// LibsConfig.luau lossless pill toggle switches, clickable schema chips, and codegen triggers.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { HARBOR_LIB_IDS } from '@shared/harborTypes'
import type { HarborLibId, HarborStatus } from '@shared/types'
import { Icon } from '../components/Icons'
import { errorText } from '../lib/format'
import { useActions } from '../store'
import './harbor.css'

const LIB_ROLES: Record<HarborLibId, string> = {
  current: 'Networking schema compiler (current-schema.luau / *.blink, From: Both)',
  ripple: 'Reactive state & replication schemas (**/*.ripple + Client/Server sync)',
  anchor: 'Spatial persistence, placement & world data helpers',
  tide: 'Reactive flow, lifecycle & scheduling primitives',
  lighthouse: 'Runtime diagnostics, telemetry & health instrumentation'
}

const FILE_EXT_RE = /\.(luau?|blink|ripple|json|toml)$/i

export function HarborView() {
  const actions = useActions()
  const h = window.harness
  const [status, setStatus] = useState<HarborStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const s = await h.harborRefresh()
      setStatus(s)
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
  }, [h])

  useEffect(() => {
    void h.harborStatus().then(setStatus).catch((e) => setError(errorText(e)))
    const offStatus = h.on('harbor:status', setStatus)
    const offGen = h.on('harbor:generated', (res) => {
      setNote(`${res.lib}: ${res.output}`)
    })
    return () => {
      offStatus()
      offGen()
    }
  }, [h])

  const onToggle = async (key: string, nextVal: boolean) => {
    setBusy(`toggle:${key}`)
    setError(null)
    try {
      setStatus(await h.harborToggleLib(key, nextVal))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const onGenerate = async (lib: HarborLibId) => {
    setBusy(`gen:${lib}`)
    setError(null)
    try {
      const res = await h.harborGenerate(lib)
      setNote(res.output)
      if (!res.ok) setError(res.output)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const onScaffold = async (lib: HarborLibId) => {
    setBusy(`scaf:${lib}`)
    setError(null)
    try {
      const res = await h.harborScaffold(lib)
      setNote(res.message)
      setStatus(await h.harborStatus())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const detectedCount = useMemo(
    () => (status ? HARBOR_LIB_IDS.filter((id) => status.libs[id].detected).length : 0),
    [status]
  )

  return (
    <div className="page">
      <div className="page-inner hb-page">
        <div className="page-head">
          <div>
            <h1>Harbor Family Stack</h1>
            <div className="sub">Current, Ripple, Anchor, Tide &amp; Lighthouse detection, schema watch &amp; LibsConfig toggles</div>
          </div>
          <div className="actions">
            <button className="mini-btn" onClick={() => void refresh()} disabled={busy !== null}>
              <Icon name="restart" size={13} /> Refresh
            </button>
          </div>
        </div>

        {/* Summary Strip */}
        <div className="hb-summary">
          <div className="hb-summary-left">
            <span className={`badge-o ${detectedCount > 0 ? 'ok' : ''}`}>
              {detectedCount} / {HARBOR_LIB_IDS.length} libraries detected
            </span>
            {status?.libsConfigPath ? (
              <button
                type="button"
                className="hb-chip"
                onClick={() => void actions.openFile(status.libsConfigPath!)}
                title="Open LibsConfig in editor"
              >
                <Icon name="file" size={11} /> {status.libsConfigPath}
              </button>
            ) : (
              <span className="note">{status?.projectRoot ? 'LibsConfig.luau not found' : 'Open a project to inspect Harbor stack'}</span>
            )}
          </div>
          <div className="hb-summary-right">
            <span className={`badge-o ${status?.watcherActive ? 'ok' : ''}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className={`hb-dot ${status?.watcherActive ? 'ok' : ''}`} />
              Schema watcher: {status?.watcherActive ? 'active' : 'off'}
            </span>
          </div>
        </div>

        {error && <div className="callout err">{error}</div>}
        {note && !error && <div className="callout info">{note}</div>}

        {/* 5-Card Responsive Grid */}
        {status ? (
          <div className="hb-grid">
            {HARBOR_LIB_IDS.map((id) => {
              const lib = status.libs[id]
              const toggleKey = lib.configKey
              return (
                <section key={id} className={`hb-card${lib.detected ? ' detected' : ''}`}>
                  <div className="hb-card-head">
                    <span className={`hb-dot ${lib.detected ? 'ok' : ''}`} />
                    <div className="hb-card-title">
                      <span className="ellipsis">{lib.name}</span>
                      {lib.version && <span className="hb-ver">v{lib.version}</span>}
                    </div>
                    <span className="grow" />
                    {toggleKey ? (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={Boolean(lib.enabled)}
                        aria-label={`Toggle ${toggleKey}`}
                        className={`hb-switch${lib.enabled ? ' on' : ''}`}
                        disabled={busy !== null}
                        onClick={() => void onToggle(toggleKey, !lib.enabled)}
                        title={`${toggleKey}: ${lib.enabled ? 'true' : 'false'} (in ${status.libsConfigPath ?? 'LibsConfig.luau'})`}
                      >
                        <span className="hb-switch-thumb" />
                      </button>
                    ) : (
                      <span className={`badge-o ${lib.detected ? 'ok' : ''}`}>{lib.detected ? 'active' : 'missing'}</span>
                    )}
                  </div>

                  <div className="hb-role">{LIB_ROLES[id]}</div>

                  {lib.schemaFiles.length > 0 && (
                    <div>
                      <div className="hb-section-label">Schemas</div>
                      <div className="hb-chips">
                        {lib.schemaFiles.map((p) => (
                          <button
                            key={p}
                            type="button"
                            className="hb-chip"
                            onClick={() => void actions.openFile(p)}
                            title={`Open ${p}`}
                          >
                            <Icon name="bolt" size={10} /> {p}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {lib.sourcePaths.length > 0 && (
                    <div>
                      <div className="hb-section-label">Sources</div>
                      <div className="hb-chips">
                        {lib.sourcePaths.map((p) =>
                          FILE_EXT_RE.test(p) ? (
                            <button
                              key={p}
                              type="button"
                              className="hb-chip"
                              onClick={() => void actions.openFile(p)}
                              title={`Open ${p}`}
                            >
                              <Icon name="file" size={10} /> {p}
                            </button>
                          ) : (
                            <button
                              key={p}
                              type="button"
                              className="hb-chip static"
                              onClick={() => void actions.copy(p, 'Folder path')}
                              title={`Copy ${p}`}
                            >
                              <Icon name="folder" size={10} /> {p}
                            </button>
                          )
                        )}
                      </div>
                    </div>
                  )}

                  <div className="hb-card-foot">
                    <button
                      className="btn small primary"
                      disabled={busy !== null || !status.projectRoot}
                      onClick={() => void onGenerate(id)}
                    >
                      <Icon name="play" size={10} /> Generate
                    </button>
                    {!lib.detected && status.projectRoot && (
                      <button
                        className="btn small"
                        disabled={busy !== null}
                        onClick={() => void onScaffold(id)}
                      >
                        Scaffold
                      </button>
                    )}
                    {toggleKey && (
                      <>
                        <span className="grow" />
                        <code style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>
                          {toggleKey}: {String(Boolean(lib.enabled))}
                        </code>
                      </>
                    )}
                  </div>
                </section>
              )
            })}
          </div>
        ) : (
          <div className="note">Scanning Harbor stack…</div>
        )}

        {/* LibsConfig Toggles Panel */}
        {status?.toggles && status.toggles.length > 0 && (
          <div className="set-sec">
            <h2>
              <span>LibsConfig Boolean Toggles</span>
              <span className="grow" />
              {status.libsConfigPath && (
                <button
                  type="button"
                  className="hb-chip"
                  onClick={() => void actions.openFile(status.libsConfigPath!)}
                >
                  {status.libsConfigPath}
                </button>
              )}
            </h2>
            <div className="hb-toggles-grid">
              {status.toggles.map((t) => (
                <div key={`${t.line}:${t.key}`} className="hb-toggle-row">
                  <div className="hb-toggle-meta">
                    <code className="ellipsis" style={{ fontSize: 12 }}>{t.key}</code>
                    <span className="note" style={{ fontSize: 10.5 }}>
                      line {t.line}{t.libId ? ` · ${t.libId}` : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={t.value}
                    aria-label={`Toggle ${t.key}`}
                    className={`hb-switch${t.value ? ' on' : ''}`}
                    disabled={busy !== null}
                    onClick={() => void onToggle(t.key, !t.value)}
                  >
                    <span className="hb-switch-thumb" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
