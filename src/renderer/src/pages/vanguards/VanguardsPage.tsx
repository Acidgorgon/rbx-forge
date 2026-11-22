// Vanguards & Offline Build Pipeline Workstation:
// - Live tool health & upstream git repo auto-updater (ror, rur, ree)
// - rur UI previews + native storybook launcher + Studio compare
// - FM Offline Build Pipeline (envbuild.py -> modelpreview.py / ror render / cost -> insert_rbxm.py)
// - Live visual preview stage, filmstrip & fullscreen Lightbox

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { VanguardsImageData, VanguardsRepoId, VanguardsRepoUpdateInfo, VanguardsRunResult, VanguardsStatus } from '@shared/types'
import { FORBIDDEN_FCM_PLACE_ID } from '@shared/vanguardsTypes'
import { Icon } from '../../components/Icons'
import { Lightbox, type LightboxItem } from '../../components/Lightbox'
import { errorText } from '../../lib/format'
import { useActions, useStorePick } from '../../store'
import './vanguards.css'

type VgTab = 'ui' | 'pipeline' | 'cli' | 'packs'
type StageBg = 'dark' | 'checker' | 'light'

const VIEWPORTS: Array<{ label: string; w: number; h: number }> = [
  { label: '1920×1080', w: 1920, h: 1080 },
  { label: '1280×720', w: 1280, h: 720 },
  { label: '1180×820', w: 1180, h: 820 },
  { label: '844×390', w: 844, h: 390 }
]

const TOOL_SUBTITLES: Record<'ror' | 'rur' | 'ree' | 'python' | 'lune', string> = {
  ror: 'DX12 3D Renderer',
  rur: 'Offline UI Engine',
  ree: 'Headless Luau',
  python: 'FM Scripts Host',
  lune: 'Story Runtime'
}

export function VanguardsPage() {
  const actions = useActions()
  const state = useStorePick('project')
  const h = window.harness

  const [status, setStatus] = useState<VanguardsStatus | null>(null)
  const [repos, setRepos] = useState<Record<VanguardsRepoId, VanguardsRepoUpdateInfo> | null>(null)
  const [tab, setTab] = useState<VgTab>('ui')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  // Last execution result + loaded PNG/JPG previews + console
  const [lastResult, setLastResult] = useState<{ label: string; res: VanguardsRunResult } | null>(null)
  const [previewImages, setPreviewImages] = useState<VanguardsImageData[]>([])
  const [imageIdx, setImageIdx] = useState(0)
  const [stageBg, setStageBg] = useState<StageBg>('dark')
  const [rawSize, setRawSize] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(true)
  const [logTail, setLogTail] = useState<string[]>([])

  // Tab 1: rur UI preview state
  const [stories, setStories] = useState<string[]>([])
  const [storyFilter, setStoryFilter] = useState('')
  const [storyPath, setStoryPath] = useState('')
  const [vp, setVp] = useState<{ w: number; h: number }>({ w: 1920, h: 1080 })
  const [rurScale, setRurScale] = useState<1 | 2>(1)
  const [rurDevice, setRurDevice] = useState<'desktop' | 'touch' | 'gamepad'>('desktop')
  const [rurAllLayers, setRurAllLayers] = useState(false)
  const [rurPlaceholders, setRurPlaceholders] = useState(false)

  // Tab 2: Offline Build Pipeline (envbuild / modelpreview / ror / insert_rbxm)
  const [envModule, setEnvModule] = useState('')
  const [envFn, setEnvFn] = useState('')
  const [envViews, setEnvViews] = useState('iso,front,top')
  const [envSize, setEnvSize] = useState('1280x1280')
  const [envOutDir, setEnvOutDir] = useState('')

  const [modelPath, setModelPath] = useState('')
  const [modelMode, setModelMode] = useState<'fm' | 'ror-render' | 'ror-cost'>('fm')
  const [modelViews, setModelViews] = useState('iso,front,right')
  const [modelSize, setModelSize] = useState('1280x1280')

  const [insertStudioId, setInsertStudioId] = useState('')
  const [insertFile, setInsertFile] = useState('')
  const [insertParent, setInsertParent] = useState('Workspace')
  const [insertAt, setInsertAt] = useState('')
  const [insertReplace, setInsertReplace] = useState(false)
  const [insertSelect, setInsertSelect] = useState(true)

  // Tab 3: Headless CLI
  const [customArgs, setCustomArgs] = useState('')

  // Tab 4: Paths
  const [binDir, setBinDir] = useState('')
  const [fmDir, setFmDir] = useState('')
  const [packsDir, setPacksDir] = useState('')

  const syncFromStatus = useCallback((s: VanguardsStatus) => {
    setStatus(s)
    setBinDir(s.binDir)
    setFmDir(s.fmDir)
    setPacksDir(s.packsDir)
    if (s.repos) setRepos(s.repos)
  }, [])

  const loadStories = useCallback(async () => {
    try {
      const res = await h.vanguardsListRurStories()
      if (res.ok) {
        setStories(res.stories)
        setStoryPath((cur) => cur || res.stories[0] || '')
      }
    } catch {
      // ignore if rur is not configured yet
    }
  }, [h])

  const refresh = useCallback(async () => {
    try {
      const s = await h.vanguardsRefresh()
      syncFromStatus(s)
      setError(null)
      if (s.tools.rur.found) void loadStories()
    } catch (e) {
      setError(errorText(e))
    }
  }, [h, syncFromStatus, loadStories])

  useEffect(() => {
    void h.vanguardsStatus().then((s) => {
      syncFromStatus(s)
      if (s.tools.rur.found) void loadStories()
    }).catch((e) => setError(errorText(e)))

    const offStatus = h.on('vanguards:status', (s) => {
      syncFromStatus(s)
    })
    const offUpdates = h.on('vanguards:updates', (r) => {
      setRepos(r)
    })
    const offLog = h.on('vanguards:log', (entry) => {
      setLogTail((prev) => [...prev.slice(-140), entry.text])
    })
    return () => {
      offStatus()
      offUpdates()
      offLog()
    }
  }, [h, syncFromStatus, loadStories, state.project?.root])

  const loadResultImages = useCallback(
    async (res: VanguardsRunResult) => {
      if (!res.images?.length) {
        setPreviewImages([])
        setImageIdx(0)
        return
      }
      const loaded = (await Promise.all(res.images.map((p) => h.vanguardsReadImage(p).catch(() => null)))).filter(
        (x): x is VanguardsImageData => x !== null
      )
      setPreviewImages(loaded)
      setImageIdx(0)
    },
    [h]
  )

  const runAction = async (label: string, fn: () => Promise<VanguardsRunResult>) => {
    setBusy(label)
    setError(null)
    setNote(null)
    try {
      const res = await fn()
      setLastResult({ label, res })
      await loadResultImages(res)
      if (res.outputPath && !insertFile) {
        setInsertFile(res.outputPath)
      }
      if (!res.ok) {
        setError(res.error || `${label} exited with code ${res.code}`)
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const checkUpdates = async () => {
    setBusy('Checking upstream pushes…')
    setError(null)
    setNote(null)
    try {
      const map = await h.vanguardsCheckUpdates()
      setRepos(map)
      const behindCount = Object.values(map).reduce((acc, r) => acc + (r.behind > 0 ? 1 : 0), 0)
      setNote(behindCount > 0 ? `${behindCount} Vanguards repo(s) have upstream updates available.` : 'All detected Vanguards repos are up to date.')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const pullAndRebuild = async (target: VanguardsRepoId | 'all') => {
    setBusy(target === 'all' ? 'Updating all Vanguards repos…' : `Updating ${target}…`)
    setError(null)
    setNote(null)
    try {
      const res = await h.vanguardsUpdateTools(target)
      setRepos(res.repos)
      const summary = res.results.map((r) => `${r.id}: ${r.message}`).join(' · ')
      setNote(summary)
      const combinedOut = res.results.map((r) => r.output).filter(Boolean).join('\n\n')
      if (combinedOut) {
        setLastResult({
          label: `update ${target}`,
          res: { ok: res.ok, code: res.ok ? 0 : 1, stdout: combinedOut, stderr: '', durationMs: 0 }
        })
      }
      if (!res.ok) setError(summary)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const toggleAutoUpdate = async () => {
    if (!status) return
    try {
      const next = await h.vanguardsSetSettings({ autoUpdateRepos: !status.autoUpdateRepos })
      syncFromStatus(next)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const toggleBridge = async () => {
    if (!status) return
    setBusy('Toggling MCP bridge…')
    setError(null)
    try {
      const s = status.mcpBridge.running ? await h.vanguardsStopMcpBridge() : await h.vanguardsStartMcpBridge(status.mcpBridge.port)
      syncFromStatus(s)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const savePaths = async () => {
    setBusy('Saving directories…')
    setError(null)
    try {
      const s = await h.vanguardsSetSettings({ binDir, fmDir, packsDir })
      syncFromStatus(s)
      setNote('Saved Vanguards directories.')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const launchNative = async () => {
    const res = await h.vanguardsLaunchRurNative(storyPath.trim() || undefined)
    if (!res.ok) setError(res.error || 'Failed to launch rur native')
    else actions.toast({ text: 'Launched rur native storybook', detail: res.pid ? `pid ${res.pid}` : undefined, kind: 'ok', ms: 2600 })
  }

  const parseArgs = (fallback: string[]) => {
    const trimmed = customArgs.trim()
    if (!trimmed) return fallback
    return trimmed.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((s) => s.replace(/^"|"$/g, '')) ?? fallback
  }

  const filteredStories = useMemo(() => {
    const q = storyFilter.trim().toLowerCase()
    if (!q) return stories
    return stories.filter((s) => s.toLowerCase().includes(q))
  }, [stories, storyFilter])

  const behindRepos = useMemo(() => (repos ? (['ror', 'rur', 'ree'] as const).filter((id) => repos[id]?.behind > 0) : []), [repos])
  const activeImg = previewImages[imageIdx] ?? previewImages[0] ?? null
  const lightboxItems: LightboxItem[] = useMemo(
    () =>
      previewImages.map((img) => ({
        key: img.path,
        name: img.name,
        detail: `${img.width && img.height ? `${img.width}×${img.height} · ` : ''}${(img.bytes / 1024).toFixed(1)} KB`,
        title: img.path,
        src: img.dataUrl,
        transparent: img.mime === 'image/png'
      })),
    [previewImages]
  )

  const consoleText = useMemo(() => {
    if (lastResult) {
      return [lastResult.res.stdout, lastResult.res.stderr].filter(Boolean).join('\n--- stderr ---\n') || '(no output)'
    }
    return logTail.join('\n') || 'Run rur, ror, ree, or an FM pipeline script to see live visual previews and output.'
  }, [lastResult, logTail])

  return (
    <div className="page">
      <div className="page-inner vg-page">
        <div className="page-head">
          <div>
            <h1>Vanguards &amp; Offline Pipeline</h1>
            <div className="sub">External CLI workstation (ror DX12, rur UI, ree headless, FM offline build &amp; asset packs)</div>
          </div>
          <div className="actions">
            <button className="mini-btn" onClick={() => void checkUpdates()} disabled={busy !== null} title="Fetch upstream git status for ror, rur & ree">
              <Icon name="sync" size={13} /> Check Updates
            </button>
            <button
              className={`mini-btn${behindRepos.length ? ' primary' : ''}`}
              onClick={() => void pullAndRebuild('all')}
              disabled={busy !== null}
              title="Pull upstream commits and rebuild changed Vanguards CLIs"
            >
              <Icon name="download" size={13} /> Update{behindRepos.length ? ` (${behindRepos.length})` : ' All'}
            </button>
            <button className="mini-btn" onClick={() => void refresh()} disabled={busy !== null}>
              <Icon name="restart" size={13} /> Refresh
            </button>
          </div>
        </div>

        {/* Live Health & Upstream Status Rail */}
        <div className="vg-health-rail">
          {status ? (
            (['ror', 'rur', 'ree', 'python', 'lune'] as const).map((id) => {
              const t = status.tools[id]
              const repo = id === 'ror' || id === 'rur' || id === 'ree' ? repos?.[id] : undefined
              const isBehind = Boolean(repo && repo.behind > 0)
              return (
                <div key={id} className={`vg-tool-card${isBehind ? ' behind' : ''}`}>
                  <div className="vg-tool-head">
                    <span className={`vg-dot ${isBehind ? 'ember' : t.found ? 'ok' : 'warn'}`} />
                    <span className="vg-tool-name">{id}</span>
                    <span className="vg-tool-tag">{TOOL_SUBTITLES[id]}</span>
                    <span className="grow" />
                    <span className={`badge-o ${t.found ? 'ok' : 'warn'}`}>{t.found ? (t.source ?? 'ready') : 'missing'}</span>
                  </div>
                  <div className="vg-tool-path" title={t.path ?? 'Not found'}>
                    {t.found ? t.path : `Not found in ${status.binDir}`}
                  </div>
                  {repo && (
                    <div className="vg-repo-row">
                      <span>{repo.found ? `${repo.branch ?? 'main'} · ${repo.localSha ?? '?'}` : 'no git repo'}</span>
                      {repo.dirty && <span className="badge-o warn">dirty</span>}
                      {repo.behind > 0 && (
                        <>
                          <span className="badge-o" style={{ borderColor: 'var(--ember-lo)', color: 'var(--ember-text)' }}>
                            ↓{repo.behind}
                          </span>
                          <button
                            className="mini-btn"
                            disabled={busy !== null || repo.dirty}
                            onClick={() => void pullAndRebuild(repo.id)}
                            title={repo.dirty ? 'Commit or clean local changes first' : `Pull & rebuild ${repo.id}`}
                          >
                            Update
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })
          ) : (
            <div className="note">Detecting Vanguards tools…</div>
          )}
        </div>

        {/* MCP Bridge + Auto-Update Settings Strip */}
        <div className="vg-bar">
          <div className="vg-bar-left">
            <span className={`vg-dot ${status?.mcpBridge.running ? 'ok' : ''}`} />
            <span style={{ fontSize: 12 }}>
              StudioMCP Bridge <code style={{ fontSize: 11 }}>127.0.0.1:{status?.mcpBridge.port ?? 7655}</code>
            </span>
            <span className={`badge-o ${status?.mcpBridge.running ? 'ok' : ''}`}>
              {status?.mcpBridge.running ? `running · pid ${status.mcpBridge.pid ?? '?'}` : 'stopped'}
            </span>
            <button
              className="mini-btn"
              onClick={() => void toggleBridge()}
              disabled={busy !== null || !status?.fmScripts.mcp_bridge.found}
              title={status?.fmScripts.mcp_bridge.found ? 'Toggle StudioMCP TCP bridge for rur compare / ror Studio parity' : 'mcp_bridge.py not found'}
            >
              {status?.mcpBridge.running ? 'Stop Bridge' : 'Start Bridge'}
            </button>
          </div>
          <div className="vg-bar-right">
            <button
              type="button"
              role="switch"
              aria-checked={Boolean(status?.autoUpdateRepos)}
              className={`vg-auto-pill${status?.autoUpdateRepos ? ' on' : ''}`}
              onClick={() => void toggleAutoUpdate()}
              title="Automatically check upstream Vanguards git repos every 15 minutes and pull/rebuild when clean"
            >
              <Icon name={status?.autoUpdateRepos ? 'check' : 'sync'} size={12} />
              Auto-update CLIs on upstream push: <strong>{status?.autoUpdateRepos ? 'ON' : 'OFF'}</strong>
            </button>
          </div>
        </div>

        {error && <div className="callout err">{error}</div>}
        {note && !error && <div className="callout info">{note}</div>}

        {/* Workstation Tabs */}
        <div className="seg vg-tabs" role="tablist" aria-label="Vanguards workstation modes">
          <button role="tab" aria-selected={tab === 'ui'} className={tab === 'ui' ? 'on' : ''} onClick={() => setTab('ui')}>
            <Icon name="monitor" size={12} /> UI Previews (rur)
          </button>
          <button role="tab" aria-selected={tab === 'pipeline'} className={tab === 'pipeline' ? 'on' : ''} onClick={() => setTab('pipeline')}>
            <Icon name="cube" size={12} /> Offline Build Pipeline (ror / FM)
          </button>
          <button role="tab" aria-selected={tab === 'cli'} className={tab === 'cli' ? 'on' : ''} onClick={() => setTab('cli')}>
            <Icon name="terminal" size={12} /> Headless (ree) &amp; CLI
          </button>
          <button role="tab" aria-selected={tab === 'packs'} className={tab === 'packs' ? 'on' : ''} onClick={() => setTab('packs')}>
            <Icon name="package" size={12} /> Packs &amp; Paths ({status?.packs.length ?? 0})
          </button>
        </div>

        {/* Tab 1 & 2 & 3 use Workstation Split Layout (Controls Left + Live Visual Stage Right) */}
        {tab === 'packs' ? (
          <div className="vg-col">
            <div className="vg-card">
              <div className="vg-card-head">
                <Icon name="package" size={13} />
                <span>Asset Packs ({status?.packs.length ?? 0})</span>
                <span className="grow" />
                <code style={{ fontSize: 11 }}>{status?.packsDir}</code>
              </div>
              {status?.packs.length ? (
                <div className="vg-packs-grid">
                  {status.packs.map((p) => (
                    <div key={p.path} className="vg-pack-card">
                      <div className="vg-pack-top">
                        <strong style={{ fontSize: 12.5 }}>{p.name}</strong>
                        <span className="badge-o">{p.files ?? 0} files</span>
                      </div>
                      <div className="vg-tool-path" title={p.path}>{p.path}</div>
                      <div className="vg-actions-row">
                        <button className="mini-btn" onClick={() => void actions.copy(p.path, 'Pack path')}>
                          <Icon name="copy" size={11} /> Copy Path
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="note">No packs found in <code>{status?.packsDir ?? 'C:\\tools\\packs'}</code></div>
              )}
            </div>

            <div className="vg-card">
              <div className="vg-card-head">
                <Icon name="gear" size={13} />
                <span>Vanguards Directories</span>
              </div>
              <div className="vg-field">
                <span className="vg-label">Vanguards bin folder (<code>ror.cmd</code>, <code>rur.cmd</code>, <code>ree.cmd</code>)</span>
                <input className="input" value={binDir} onChange={(e) => setBinDir(e.target.value)} />
              </div>
              <div className="vg-field">
                <span className="vg-label">FM scripts folder (<code>envbuild.py</code>, <code>modelpreview.py</code>, <code>insert_rbxm.py</code>, <code>mcp_bridge.py</code>)</span>
                <input className="input" value={fmDir} onChange={(e) => setFmDir(e.target.value)} />
              </div>
              <div className="vg-field">
                <span className="vg-label">Packs folder (offline build kits)</span>
                <input className="input" value={packsDir} onChange={(e) => setPacksDir(e.target.value)} />
              </div>
              <div className="vg-actions-row">
                <button className="btn small primary" onClick={() => void savePaths()} disabled={busy !== null}>
                  Save Directories
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="vg-workstation">
            {/* LEFT COLUMN: Controls per tab */}
            <div className="vg-col">
              {tab === 'ui' && (
                <div className="vg-card">
                  <div className="vg-card-head">
                    <Icon name="monitor" size={13} />
                    <span>Render UI Story with rur</span>
                    <span className="grow" />
                    <button className="icon-btn" onClick={() => void loadStories()} title="Refresh stories from rur" aria-label="Refresh rur stories">
                      <Icon name="restart" size={12} />
                    </button>
                  </div>

                  <input
                    className="input"
                    placeholder="Filter stories…"
                    value={storyFilter}
                    onChange={(e) => setStoryFilter(e.target.value)}
                  />

                  <div className="vg-story-box">
                    {filteredStories.length ? (
                      filteredStories.map((s) => (
                        <button
                          key={s}
                          type="button"
                          className={`vg-story-item${storyPath === s ? ' on' : ''}`}
                          onClick={() => setStoryPath(s)}
                          title={s}
                        >
                          <Icon name="file" size={12} />
                          <span className="ellipsis">{s}</span>
                        </button>
                      ))
                    ) : (
                      <div className="note" style={{ padding: 8 }}>
                        {status?.tools.rur.found ? 'No .story.luau files listed yet. Enter a path below or refresh.' : 'rur CLI not detected.'}
                      </div>
                    )}
                  </div>

                  <div className="vg-field">
                    <span className="vg-label">Story path</span>
                    <input
                      className="input"
                      placeholder="src/ReplicatedStorage/Stories/Button.story.luau"
                      value={storyPath}
                      onChange={(e) => setStoryPath(e.target.value)}
                    />
                  </div>

                  <div className="vg-field">
                    <span className="vg-label">Viewport</span>
                    <div className="vg-presets">
                      {VIEWPORTS.map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          className={`vg-chip${vp.w === preset.w && vp.h === preset.h ? ' on' : ''}`}
                          onClick={() => setVp({ w: preset.w, h: preset.h })}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="vg-field-row">
                    <div className="vg-field">
                      <span className="vg-label">Scale</span>
                      <div className="seg">
                        <button type="button" className={rurScale === 1 ? 'on' : ''} onClick={() => setRurScale(1)}>1x</button>
                        <button type="button" className={rurScale === 2 ? 'on' : ''} onClick={() => setRurScale(2)}>2x</button>
                      </div>
                    </div>
                    <div className="vg-field">
                      <span className="vg-label">Device</span>
                      <select className="input" value={rurDevice} onChange={(e) => setRurDevice(e.target.value as 'desktop' | 'touch' | 'gamepad')}>
                        <option value="desktop">desktop</option>
                        <option value="touch">touch</option>
                        <option value="gamepad">gamepad</option>
                      </select>
                    </div>
                  </div>

                  <div className="vg-checks">
                    <label>
                      <input type="checkbox" checked={rurAllLayers} onChange={(e) => setRurAllLayers(e.target.checked)} />
                      <span>All layers</span>
                    </label>
                    <label>
                      <input type="checkbox" checked={rurPlaceholders} onChange={(e) => setRurPlaceholders(e.target.checked)} />
                      <span>Placeholders</span>
                    </label>
                  </div>

                  <div className="vg-actions-row">
                    <button
                      className="btn small primary"
                      disabled={busy !== null || !storyPath.trim() || !status?.tools.rur.found}
                      onClick={() =>
                        void runAction(`rur render`, () =>
                          h.vanguardsRenderRurStory({
                            story: storyPath.trim(),
                            width: vp.w,
                            height: vp.h,
                            scale: rurScale,
                            device: rurDevice,
                            allLayers: rurAllLayers,
                            placeholders: rurPlaceholders
                          })
                        )
                      }
                    >
                      <Icon name="play" size={11} /> Render Story
                    </button>
                    <button
                      className="btn small"
                      disabled={busy !== null || !storyPath.trim() || !status?.tools.rur.found}
                      onClick={() =>
                        void runAction(`rur compare`, () =>
                          h.vanguardsRenderRurStory({
                            story: storyPath.trim(),
                            width: vp.w,
                            height: vp.h,
                            compare: true
                          })
                        )
                      }
                      title="Render offline vs Studio via StudioMCP bridge and generate diff.png"
                    >
                      <Icon name="diff" size={11} /> Compare Studio
                    </button>
                    <button
                      className="btn small"
                      disabled={busy !== null || !status?.tools.rur.found}
                      onClick={() => void runAction('rur sweep', () => h.vanguardsRunRur({ args: ['sweep'] }))}
                    >
                      Sweep All
                    </button>
                    <button
                      className="btn small ghost"
                      disabled={!status?.tools.rur.found}
                      onClick={() => void launchNative()}
                    >
                      <Icon name="external" size={11} /> rur Native
                    </button>
                  </div>
                </div>
              )}

              {tab === 'pipeline' && (
                <>
                  {/* Stage 1: FM Envbuild */}
                  <div className="vg-card">
                    <div className="vg-card-head">
                      <Icon name="bolt" size={13} />
                      <span>1. Offline Envbuild (<code>envbuild.py</code>)</span>
                      <span className="grow" />
                      <span className={`badge-o ${status?.fmScripts.envbuild.found ? 'ok' : 'warn'}`}>
                        {status?.fmScripts.envbuild.found ? 'ready' : 'missing'}
                      </span>
                    </div>
                    <div className="vg-field">
                      <span className="vg-label">Env module name or path</span>
                      <input className="input" placeholder="e.g. Rooftop" value={envModule} onChange={(e) => setEnvModule(e.target.value)} />
                    </div>
                    <div className="vg-field-row">
                      <div className="vg-field">
                        <span className="vg-label">Entry fn (optional)</span>
                        <input className="input" placeholder="build" value={envFn} onChange={(e) => setEnvFn(e.target.value)} />
                      </div>
                      <div className="vg-field">
                        <span className="vg-label">Views / Size</span>
                        <input className="input" placeholder="iso,front,top" value={envViews} onChange={(e) => setEnvViews(e.target.value)} />
                      </div>
                    </div>
                    <div className="vg-field-row">
                      <div className="vg-field">
                        <span className="vg-label">Resolution</span>
                        <input className="input" placeholder="1280x1280" value={envSize} onChange={(e) => setEnvSize(e.target.value)} />
                      </div>
                      <div className="vg-field">
                        <span className="vg-label">Out dir (optional)</span>
                        <input className="input" placeholder="default FM out" value={envOutDir} onChange={(e) => setEnvOutDir(e.target.value)} />
                      </div>
                    </div>
                    <div className="vg-actions-row">
                      <button
                        className="btn small primary"
                        disabled={busy !== null || !envModule.trim() || !status?.fmScripts.envbuild.found}
                        onClick={() =>
                          void runAction(`envbuild ${envModule.trim()}`, () =>
                            h.vanguardsFmEnvbuild({
                              module: envModule.trim(),
                              ...(envFn.trim() ? { fn: envFn.trim() } : {}),
                              ...(envViews.trim() ? { views: envViews.trim() } : {}),
                              ...(envSize.trim() ? { size: envSize.trim() } : {}),
                              ...(envOutDir.trim() ? { outDir: envOutDir.trim() } : {})
                            })
                          )
                        }
                      >
                        <Icon name="cube" size={11} /> Bake Environment
                      </button>
                    </div>
                  </div>

                  {/* Stage 2: 3D Preview (FM Modelpreview / Direct ror render / ror cost) */}
                  <div className="vg-card">
                    <div className="vg-card-head">
                      <Icon name="image" size={13} />
                      <span>2. 3D Model &amp; Cost Preview</span>
                    </div>
                    <div className="vg-field">
                      <span className="vg-label">Model or Place (.rbxm, .rbxmx, .rbxl)</span>
                      <input className="input" placeholder="out/final.rbxm" value={modelPath} onChange={(e) => setModelPath(e.target.value)} />
                    </div>
                    <div className="vg-presets">
                      <button type="button" className={`vg-chip${modelMode === 'fm' ? ' on' : ''}`} onClick={() => setModelMode('fm')}>
                        FM Sheet (modelpreview.py)
                      </button>
                      <button type="button" className={`vg-chip${modelMode === 'ror-render' ? ' on' : ''}`} onClick={() => setModelMode('ror-render')}>
                        ror render (DX12)
                      </button>
                      <button type="button" className={`vg-chip${modelMode === 'ror-cost' ? ' on' : ''}`} onClick={() => setModelMode('ror-cost')}>
                        ror cost (Heatmap)
                      </button>
                    </div>
                    <div className="vg-field-row">
                      <div className="vg-field">
                        <span className="vg-label">Views</span>
                        <input className="input" value={modelViews} onChange={(e) => setModelViews(e.target.value)} />
                      </div>
                      <div className="vg-field">
                        <span className="vg-label">Image Size</span>
                        <input className="input" value={modelSize} onChange={(e) => setModelSize(e.target.value)} />
                      </div>
                    </div>
                    <div className="vg-actions-row">
                      <button
                        className="btn small primary"
                        disabled={
                          busy !== null ||
                          !modelPath.trim() ||
                          (modelMode === 'fm' ? !status?.fmScripts.modelpreview.found : !status?.tools.ror.found)
                        }
                        onClick={() => {
                          const target = modelPath.trim()
                          if (modelMode === 'fm') {
                            return void runAction('modelpreview', () =>
                              h.vanguardsFmModelpreview({
                                modelPath: target,
                                ...(modelViews.trim() ? { views: modelViews.trim() } : {}),
                                ...(modelSize.trim() ? { size: modelSize.trim() } : {})
                              })
                            )
                          }
                          const subcommand = modelMode === 'ror-cost' ? 'cost' : 'render'
                          return void runAction(`ror ${subcommand}`, () =>
                            h.vanguardsRenderRorPreview({
                              modelPath: target,
                              subcommand,
                              ...(modelViews.trim() ? { views: modelViews.trim() } : {}),
                              ...(modelSize.trim() ? { size: modelSize.trim() } : {})
                            })
                          )
                        }}
                      >
                        <Icon name="image" size={11} /> Render 3D Preview
                      </button>
                    </div>
                  </div>

                  {/* Stage 3: Insert to Studio (insert_rbxm.py) */}
                  <div className="vg-card">
                    <div className="vg-card-head">
                      <Icon name="studio" size={13} />
                      <span>3. Insert to Studio (<code>insert_rbxm.py</code>)</span>
                      <span className="grow" />
                      <span className="badge-o warn" title={`Place ${FORBIDDEN_FCM_PLACE_ID} is hard-refused`}>
                        FCM Protected
                      </span>
                    </div>
                    <div className="vg-field-row">
                      <div className="vg-field">
                        <span className="vg-label">Studio ID / Name</span>
                        <input className="input" placeholder="e.g. Baseplate" value={insertStudioId} onChange={(e) => setInsertStudioId(e.target.value)} />
                      </div>
                      <div className="vg-field">
                        <span className="vg-label">Parent Service</span>
                        <input className="input" placeholder="Workspace" value={insertParent} onChange={(e) => setInsertParent(e.target.value)} />
                      </div>
                    </div>
                    <div className="vg-field-row">
                      <div className="vg-field">
                        <span className="vg-label">.rbxm file path</span>
                        <input className="input" placeholder="final.rbxm" value={insertFile} onChange={(e) => setInsertFile(e.target.value)} />
                      </div>
                      <div className="vg-field">
                        <span className="vg-label">Position --at (optional)</span>
                        <input className="input" placeholder="0,0,0" value={insertAt} onChange={(e) => setInsertAt(e.target.value)} />
                      </div>
                    </div>
                    <div className="vg-checks">
                      <label>
                        <input type="checkbox" checked={insertReplace} onChange={(e) => setInsertReplace(e.target.checked)} />
                        <span>Replace existing (<code>--replace</code>)</span>
                      </label>
                      <label>
                        <input type="checkbox" checked={insertSelect} onChange={(e) => setInsertSelect(e.target.checked)} />
                        <span>Select after insert (<code>--select</code>)</span>
                      </label>
                    </div>
                    <div className="vg-actions-row">
                      <button
                        className="btn small primary"
                        disabled={busy !== null || !insertStudioId.trim() || !insertFile.trim() || !status?.fmScripts.insert_rbxm.found}
                        onClick={() =>
                          void runAction('insert_rbxm', () =>
                            h.vanguardsFmInsertRbxm({
                              studioId: insertStudioId.trim(),
                              filePath: insertFile.trim(),
                              ...(insertParent.trim() ? { parent: insertParent.trim() } : {}),
                              ...(insertAt.trim() ? { at: insertAt.trim() } : {}),
                              replace: insertReplace,
                              select: insertSelect
                            })
                          )
                        }
                      >
                        <Icon name="upload" size={11} /> Insert into Studio
                      </button>
                    </div>
                  </div>
                </>
              )}

              {tab === 'cli' && (
                <div className="vg-card">
                  <div className="vg-card-head">
                    <Icon name="terminal" size={13} />
                    <span>Headless Runner (ree) &amp; Direct CLI</span>
                  </div>
                  <div className="vg-field">
                    <span className="vg-label">CLI Arguments</span>
                    <input
                      className="input"
                      placeholder="e.g. test.luau --json or stories"
                      value={customArgs}
                      onChange={(e) => setCustomArgs(e.target.value)}
                    />
                  </div>
                  <div className="vg-actions-row">
                    <button
                      className="btn small primary"
                      disabled={busy !== null || !status?.tools.ree.found}
                      onClick={() => void runAction('ree', () => h.vanguardsRunRee({ args: parseArgs(['--help']) }))}
                    >
                      Run ree
                    </button>
                    <button
                      className="btn small"
                      disabled={busy !== null || !status?.tools.rur.found}
                      onClick={() => void runAction('rur', () => h.vanguardsRunRur({ args: parseArgs(['--help']) }))}
                    >
                      Run rur
                    </button>
                    <button
                      className="btn small"
                      disabled={busy !== null || !status?.tools.ror.found}
                      onClick={() => void runAction('ror', () => h.vanguardsRunRor({ args: parseArgs(['--help']) }))}
                    >
                      Run ror (DX12)
                    </button>
                  </div>
                  <div className="vg-label">Quick Diagnostics</div>
                  <div className="vg-presets">
                    <button type="button" className="vg-chip" disabled={busy !== null || !status?.tools.rur.found} onClick={() => void runAction('rur doctor', () => h.vanguardsRunRur({ args: ['doctor'] }))}>
                      rur doctor
                    </button>
                    <button type="button" className="vg-chip" disabled={busy !== null || !status?.tools.rur.found} onClick={() => void runAction('rur stories', () => h.vanguardsRunRur({ args: ['stories'] }))}>
                      rur stories
                    </button>
                    <button type="button" className="vg-chip" disabled={busy !== null || !status?.tools.rur.found} onClick={() => void runAction('rur selftest', () => h.vanguardsRunRur({ args: ['selftest'] }))}>
                      rur selftest
                    </button>
                    <button type="button" className="vg-chip" disabled={busy !== null || !status?.tools.ror.found} onClick={() => void runAction('ror --version', () => h.vanguardsRunRor({ args: ['--version'] }))}>
                      ror --version
                    </button>
                    <button type="button" className="vg-chip" disabled={busy !== null || !status?.tools.ree.found} onClick={() => void runAction('ree --version', () => h.vanguardsRunRee({ args: ['--version'] }))}>
                      ree --version
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* RIGHT COLUMN: Shared Live Visual Preview Stage + Console */}
            <div className="vg-col">
              <div className="vg-stage-card">
                <div className="vg-stage-bar">
                  <Icon name="image" size={13} />
                  <strong style={{ fontSize: 12 }}>
                    {lastResult ? lastResult.label : 'Preview Stage'}
                  </strong>
                  {lastResult && (
                    <span className={`badge-o ${lastResult.res.ok ? 'ok' : 'err'}`}>
                      {lastResult.res.ok ? `ok · ${lastResult.res.durationMs}ms` : `exit ${lastResult.res.code}`}
                    </span>
                  )}
                  <span className="grow" />
                  <div className="seg" role="group" aria-label="Stage backdrop">
                    <button type="button" className={stageBg === 'dark' ? 'on' : ''} onClick={() => setStageBg('dark')}>Dark</button>
                    <button type="button" className={stageBg === 'checker' ? 'on' : ''} onClick={() => setStageBg('checker')}>Grid</button>
                    <button type="button" className={stageBg === 'light' ? 'on' : ''} onClick={() => setStageBg('light')}>Light</button>
                  </div>
                  <button
                    type="button"
                    className={`mini-btn${rawSize ? ' on' : ''}`}
                    disabled={!activeImg}
                    onClick={() => setRawSize((v) => !v)}
                  >
                    {rawSize ? 'Fit' : '100%'}
                  </button>
                  <button
                    type="button"
                    className="mini-btn"
                    disabled={!activeImg}
                    onClick={() => setLightboxOpen(true)}
                  >
                    <Icon name="expand" size={11} /> Expand
                  </button>
                </div>

                <div className={`vg-stage-canvas bg-${stageBg}`}>
                  {activeImg ? (
                    <img
                      className={`vg-stage-img${rawSize ? ' raw' : ''}`}
                      src={activeImg.dataUrl}
                      alt={activeImg.name}
                      onClick={() => setLightboxOpen(true)}
                    />
                  ) : (
                    <div className="vg-stage-empty">
                      <Icon name="image" size={26} />
                      <div style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>No preview image loaded yet</div>
                      <div className="note">
                        Render a <code>rur</code> UI story, bake an FM environment, or run <code>ror</code> 3D preview to inspect PNG/JPG results live.
                      </div>
                    </div>
                  )}
                  {busy && (
                    <div className="vg-stage-busy">
                      <span className="spinner" aria-hidden /> {busy}
                    </div>
                  )}
                </div>

                {previewImages.length > 1 && (
                  <div className="vg-thumbs">
                    {previewImages.map((img, i) => (
                      <button
                        key={img.path}
                        type="button"
                        className={`vg-thumb${i === imageIdx ? ' on' : ''}`}
                        onClick={() => setImageIdx(i)}
                        title={img.path}
                      >
                        <img src={img.dataUrl} alt={img.name} />
                        <span>{img.name}</span>
                      </button>
                    ))}
                  </div>
                )}

                {(activeImg || lastResult?.res.outputPath) && (
                  <div className="vg-stage-meta">
                    {activeImg && (
                      <>
                        <span>{activeImg.name}</span>
                        {activeImg.width && activeImg.height && <span>{activeImg.width}×{activeImg.height}</span>}
                        <span>{(activeImg.bytes / 1024).toFixed(1)} KB</span>
                        <button className="mini-btn" onClick={() => void actions.copy(activeImg.path, 'Image path')}>
                          <Icon name="copy" size={11} /> Copy Image Path
                        </button>
                      </>
                    )}
                    {lastResult?.res.outputPath && (
                      <>
                        <span style={{ color: 'var(--ok)' }}>Baked: <code>{lastResult.res.outputPath}</code></span>
                        <button
                          className="mini-btn"
                          onClick={() => {
                            setInsertFile(lastResult.res.outputPath!)
                            setModelPath(lastResult.res.outputPath!)
                            setTab('pipeline')
                            actions.toast({ text: 'Loaded baked .rbxm into Model Preview & Insert to Studio', kind: 'ok', ms: 2400 })
                          }}
                        >
                          Use in Pipeline
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>

              <div className="vg-console">
                <button className="vg-console-head" onClick={() => setConsoleOpen((v) => !v)} aria-expanded={consoleOpen}>
                  <Icon name={consoleOpen ? 'chevDown' : 'chev'} size={11} />
                  <span>Console Output</span>
                  <span className="grow" />
                  {lastResult && <span className="faint" style={{ textTransform: 'none' }}>{lastResult.label}</span>}
                </button>
                {consoleOpen && <pre className="vg-console-body">{consoleText}</pre>}
              </div>
            </div>
          </div>
        )}

        {lightboxOpen && lightboxItems.length > 0 && (
          <Lightbox
            items={lightboxItems}
            index={imageIdx}
            onIndex={setImageIdx}
            onClose={() => setLightboxOpen(false)}
            actions={(item) => (
              <button className="mini-btn" onClick={() => void actions.copy(item.title ?? item.name, 'Image path')}>
                <Icon name="copy" size={11} /> Copy path
              </button>
            )}
          />
        )}
      </div>
    </div>
  )
}
