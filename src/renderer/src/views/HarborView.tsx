// Harbor Family Stack view: Current, Ripple, Anchor, Tide, Lighthouse detection,
// LibsConfig.luau live lossless boolean toggles, schema watcher status, and codegen triggers.

import { useCallback, useEffect, useState } from 'react'
import { HARBOR_LIB_IDS } from '@shared/harborTypes'
import type { HarborLibId, HarborStatus } from '@shared/types'
import { Icon } from '../components/Icons'
import { errorText } from '../lib/format'

const LIB_ROLES: Record<HarborLibId, string> = {
  current: 'Networking schema compiler (current-schema.luau / *.blink, From: Both)',
  ripple: 'State & sync schemas (**/*.ripple + Ripple Client/Server)',
  anchor: 'Spatial / placement & world persistence utilities',
  tide: 'Reactive flow / scheduling primitives',
  lighthouse: 'Diagnostics, telemetry & runtime health checks'
}

export function HarborView() {
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

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1>Harbor Family Stack</h1>
            <div className="sub">
              {status?.projectRoot ? (
                <>
                  <code>{status.libsConfigPath ?? 'LibsConfig.luau not found'}</code> · Schema watcher:{' '}
                  <strong>{status.watcherActive ? 'active' : 'off'}</strong>
                </>
              ) : (
                'Open a project to inspect Harbor libraries and LibsConfig toggles'
              )}
            </div>
          </div>
          <div className="actions">
            <button className="mini-btn" onClick={() => void refresh()} disabled={busy !== null}>
              <Icon name="restart" size={13} /> Refresh
            </button>
          </div>
        </div>

        {error && <div className="callout err">{error}</div>}
        {note && !error && <div className="callout info">{note}</div>}

        <div className="set-sec">
          <h2>Libraries</h2>
          {status ? (
            HARBOR_LIB_IDS.map((id) => {
              const lib = status.libs[id]
              const toggleKey = lib.configKey
              return (
                <div className="set-row" key={id}>
                  <div className="set-text">
                    <div className="set-title">
                      <strong>{lib.name}</strong>{' '}
                      {lib.version && <code style={{ fontSize: 11 }}>v{lib.version}</code>}{' '}
                      <span className={`badge-o ${lib.detected ? 'ok' : ''}`}>
                        {lib.detected ? 'detected' : 'not present'}
                      </span>
                    </div>
                    <div className="note">{LIB_ROLES[id]}</div>
                    {lib.sourcePaths.length > 0 && (
                      <div className="note">Sources: {lib.sourcePaths.map((p) => <code key={p} style={{ marginRight: 6 }}>{p}</code>)}</div>
                    )}
                    {lib.schemaFiles.length > 0 && (
                      <div className="note">Schemas: {lib.schemaFiles.map((p) => <code key={p} style={{ marginRight: 6 }}>{p}</code>)}</div>
                    )}
                  </div>
                  <div className="set-ctl">
                    {toggleKey && (
                      <button
                        className="mini-btn"
                        disabled={busy !== null}
                        onClick={() => void onToggle(toggleKey, !lib.enabled)}
                        title={`Toggle ${toggleKey} in ${status.libsConfigPath ?? 'LibsConfig.luau'}`}
                      >
                        {toggleKey}: {lib.enabled ? 'ON' : 'OFF'}
                      </button>
                    )}
                    <button
                      className="mini-btn"
                      disabled={busy !== null || !status.projectRoot}
                      onClick={() => void onGenerate(id)}
                    >
                      Generate
                    </button>
                    {!lib.detected && status.projectRoot && (
                      <button
                        className="mini-btn"
                        disabled={busy !== null}
                        onClick={() => void onScaffold(id)}
                      >
                        Scaffold
                      </button>
                    )}
                  </div>
                </div>
              )
            })
          ) : (
            <div className="note">Scanning Harbor stack…</div>
          )}
        </div>

        {status?.toggles && status.toggles.length > 0 && (
          <div className="set-sec">
            <h2>
              <span>LibsConfig Boolean Toggles</span>
              <span className="grow" />
              {status.libsConfigPath && <code style={{ fontSize: 11 }}>{status.libsConfigPath}</code>}
            </h2>
            {status.toggles.map((t) => (
              <div className="set-row" key={`${t.line}:${t.key}`}>
                <div className="set-text">
                  <div className="set-title">
                    <code>{t.key}</code> <span className="note">line {t.line}{t.libId ? ` · ${t.libId}` : ''}</span>
                  </div>
                </div>
                <div className="set-ctl">
                  <button
                    className={`mini-btn`}
                    disabled={busy !== null}
                    onClick={() => void onToggle(t.key, !t.value)}
                  >
                    <span className={`badge-o ${t.value ? 'ok' : ''}`}>{t.value ? 'true' : 'false'}</span>
                    Toggle
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
