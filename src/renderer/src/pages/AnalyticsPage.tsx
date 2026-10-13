// Analytics tab (analytics/CONTRACT.md §5): key setup, KPI tiles with source badges and a range
// picker, signals, a series chart with release markers and projected points, acquisition table,
// CSV imports (drop zone), public-stats poller, catalog, instrumentation snippets, Ask the agent.
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type {
  AnalyticsAcquisition,
  AnalyticsCatalogItem,
  AnalyticsGranularity,
  AnalyticsKpi,
  AnalyticsOverview,
  AnalyticsSeriesResult,
  AnalyticsSignal,
  AnalyticsSnippet,
  AnalyticsSnippetKind,
  AnalyticsSource,
  AnalyticsStatus
} from '@shared/types'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { ago, errorText, fmtNum } from '../lib/format'

// Metrics where a rise is bad (from main/services/analytics/metrics.ts `better: 'down'`), and ones
// with no good direction. Deltas are coloured by direction, never by raw sign.
const LOWER_BETTER = new Set(['ClientCrashRate15m', 'ClientCrashCount', 'ServerCrashCount', 'OomUnexpectedExits', 'ClientMemoryUsageP90', 'MemoryUsageP90', 'FunnelStepChurnRate'])
const NEUTRAL = new Set(['EconomyTransactionAmount', 'EconomyTransactionCount', 'EconomyAverageWalletBalance', 'CustomEventCount', 'CustomEventCountUser', 'CustomEventSumValue', 'CustomEventAvgValue'])
const RANGES = ['7d', '28d', '90d'] as const
const BREAKDOWNS = ['', 'Platform', 'Country', 'AcquisitionSource', 'IsNewUser', 'AgeGroup'] as const
const SOURCE_LABEL: Record<AnalyticsSource, string> = { api: 'API', csv: 'CSV', public: 'Public' }
const SEV: Record<AnalyticsSignal['severity'], { cls: string; icon: 'info' | 'check' | 'warn' | 'err' }> = {
  info: { cls: 'info', icon: 'info' },
  good: { cls: 'ok', icon: 'check' },
  warn: { cls: 'warn', icon: 'warn' },
  bad: { cls: 'err', icon: 'err' }
}

function fmtValue(v: number | null, unit: string): string {
  if (v === null || v === undefined) return '—'
  if (unit === 'ratio') return `${(v * 100).toFixed(1)}%`
  if (unit === 'seconds') return v >= 60 ? `${Math.floor(v / 60)}m ${Math.round(v % 60)}s` : `${Math.round(v)}s`
  if (unit === 'robux') return `R$ ${fmtNum(v)}`
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (Math.abs(v) >= 10_000) return `${(v / 1000).toFixed(1)}k`
  return fmtNum(v, v % 1 ? 2 : 0)
}

function deltaClass(metric: string, change: number | null): string {
  if (change === null || NEUTRAL.has(metric) || Math.abs(change) < 0.005) return ''
  const good = LOWER_BETTER.has(metric) ? change < 0 : change > 0
  return good ? 'ok' : 'err'
}

function Delta({ metric, change }: { metric: string; change: number | null }) {
  if (change === null) return <span className="faint">—</span>
  return <span className={`delta ${deltaClass(metric, change)}`}>{change >= 0 ? '+' : '−'}{Math.abs(change * 100).toFixed(1)}%</span>
}

function Kpi({ k, active, onClick }: { k: AnalyticsKpi; active: boolean; onClick: () => void }) {
  return (
    <button className={`kpi${active ? ' on' : ''}`} onClick={onClick} title={`${k.metric} · previous ${fmtValue(k.previous, k.unit)}`}>
      <div className="row">
        <span className="kpi-label grow ellipsis">{k.label}</span>
        <span className={`tag ${k.source === 'api' ? 'info' : k.source === 'csv' ? '' : 'warn'}`}>{SOURCE_LABEL[k.source]}</span>
      </div>
      <div className="kpi-value">{fmtValue(k.current, k.unit)}</div>
      <Delta metric={k.metric} change={k.change} />
    </button>
  )
}

function Chart({ data }: { data: AnalyticsSeriesResult }) {
  const W = 760
  const H = 200
  const P = { l: 44, r: 10, t: 10, b: 22 }
  const all = data.series.flatMap((s) => s.points)
  if (!all.length) return <div className="note chart-empty">No data in this range.</div>
  const times = [...new Set(all.map((p) => p.t))].sort()
  const max = Math.max(...all.map((p) => p.v)) || 1
  const min = Math.min(0, ...all.map((p) => p.v))
  const x = (t: string) => P.l + (times.length < 2 ? 0 : (times.indexOf(t) / (times.length - 1)) * (W - P.l - P.r))
  const y = (v: number) => P.t + (1 - (v - min) / (max - min || 1)) * (H - P.t - P.b)
  const ticks = [0, 0.5, 1].map((f) => min + f * (max - min))
  const releaseX = (at: string) => {
    const d = at.slice(0, 10)
    const i = times.findIndex((t) => t.slice(0, 10) >= d)
    return i < 0 ? null : x(times[i])
  }
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${data.series[0]?.metric} over time`}>
      {ticks.map((v, i) => (
        <g key={i}>
          <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} className="grid" />
          <text x={P.l - 6} y={y(v) + 3} textAnchor="end" className="axis">{fmtValue(v, data.series[0]?.unit ?? '')}</text>
        </g>
      ))}
      <text x={P.l} y={H - 6} className="axis">{times[0]?.slice(5, 10)}</text>
      <text x={W - P.r} y={H - 6} textAnchor="end" className="axis">{times[times.length - 1]?.slice(5, 10)}</text>
      {data.releases.map((r) => {
        const rx = releaseX(r.at)
        return rx === null ? null : (
          <g key={r.tag}>
            <line x1={rx} x2={rx} y1={P.t} y2={H - P.b} className="rel" />
            <text x={rx + 4} y={P.t + 10} className="axis rel-t">{r.tag}</text>
          </g>
        )
      })}
      {data.series.map((s, si) => {
        const solid = s.points.filter((p) => p.flag !== 'projected')
        const proj = s.points.filter((p, i) => p.flag === 'projected' || s.points[i + 1]?.flag === 'projected')
        const path = (pts: typeof s.points) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('')
        return (
          <g key={si} className={`line s${si % 4}`}>
            <path d={path(solid)} />
            {proj.length > 1 && <path d={path(proj)} className="proj" />}
          </g>
        )
      })}
    </svg>
  )
}

export function AnalyticsPage() {
  const { state, actions } = useStore()
  const h = window.harness
  const [status, setStatus] = useState<AnalyticsStatus | null>(null)
  const [range, setRange] = useState<string>('7d')
  const [custom, setCustom] = useState('')
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null)
  const [ovErr, setOvErr] = useState<string | null>(null)
  const [metric, setMetric] = useState('DailyActiveUsers')
  const [gran, setGran] = useState<AnalyticsGranularity>('day')
  const [breakdown, setBreakdown] = useState('')
  const [series, setSeries] = useState<AnalyticsSeriesResult | null>(null)
  const [acq, setAcq] = useState<AnalyticsAcquisition | null>(null)
  const [catalog, setCatalog] = useState<AnalyticsCatalogItem[] | null>(null)
  const [snippetKind, setSnippetKind] = useState<AnalyticsSnippetKind>('setup')
  const [snippet, setSnippet] = useState<AnalyticsSnippet | null>(null)
  const [key, setKey] = useState('')
  const [ids, setIds] = useState({ placeId: '', universeId: '' })
  const [drag, setDrag] = useState(false)
  const [importMsg, setImportMsg] = useState<string[]>([])
  const fileInput = useRef<HTMLInputElement>(null)

  const loadStatus = () => void h.analyticsStatus().then(setStatus).catch(() => undefined)
  useEffect(() => {
    loadStatus()
    const off = h.on('analytics:snapshot', () => loadStatus())
    return off
  }, [])
  useEffect(() => {
    setOvErr(null)
    void h.analyticsOverview({ range }).then(setOverview).catch((e) => setOvErr(errorText(e)))
    void h.analyticsAcquisition({ range }).then(setAcq).catch(() => setAcq(null))
  }, [range, status?.hasApiKey, status?.universeId])
  useEffect(() => {
    setSeries(null)
    void h.analyticsSeries({ metric, range, granularity: gran, breakdown: breakdown ? [breakdown] : undefined, limit: breakdown ? 5 : undefined }).then(setSeries).catch((e) => setSeries({ range: { start: '', end: '' }, source: null, series: [], notes: [errorText(e)], releases: [] }))
  }, [metric, range, gran, breakdown, status?.hasApiKey])
  useEffect(() => {
    if (status?.hasApiKey) void h.analyticsCatalog().then((c) => setCatalog(c.items)).catch(() => setCatalog(null))
  }, [status?.hasApiKey])
  useEffect(() => {
    void h.analyticsSnippet({ kind: snippetKind }).then(setSnippet).catch(() => setSnippet(null))
  }, [snippetKind])

  const importPaths = async (paths: string[]) => {
    const msgs: string[] = []
    for (const path of paths) {
      try {
        const r = await h.analyticsImportCsv({ path })
        msgs.push(`${path.split(/[\\/]/).pop()}: ${r.series.map((s) => `${s.label} (${s.points} points)`).join(', ') || 'no series'}`, ...r.warnings)
      } catch (e) {
        msgs.push(`${path.split(/[\\/]/).pop()}: ${errorText(e)}`)
      }
    }
    setImportMsg(msgs)
    loadStatus()
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDrag(false)
    const files = [...e.dataTransfer.files].filter((f) => /\.csv$/i.test(f.name))
    const paths = files.map((f) => window.forgeFiles?.pathFor(f) ?? '').filter(Boolean)
    if (!paths.length) return setImportMsg(['Drop a .csv exported from the Creator Dashboard (unzip a sales .zip first).'])
    void importPaths(paths)
  }

  const needsSetup = status && (!status.hasApiKey || status.apiProblem)
  const kpis = overview?.kpis ?? []
  const metricLabel = kpis.find((k) => k.metric === metric)?.label ?? metric
  const live = overview?.live
  const signals = useMemo(() => [...(overview?.signals ?? []), ...(acq?.signals ?? [])], [overview, acq])

  return (
    <div className="page">
      <div className="page-inner analytics">
        <div className="page-head">
          <div>
            <h1>Analytics</h1>
            <div className="sub">{live?.name ?? state.project?.name ?? 'No project'}{status?.universeId ? ` · universe ${status.universeId}` : ''}{overview ? ` · ${overview.range.start} to ${overview.range.end}` : ''}</div>
          </div>
          <div className="actions">
            <div className="seg">
              {RANGES.map((r) => <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{r}</button>)}
            </div>
            <input className="input" style={{ width: 170 }} placeholder="2026-09-01..2026-09-30" value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && custom.trim() && setRange(custom.trim())} aria-label="Custom range" spellCheck={false} />
            <button className="btn primary" onClick={() => actions.ask("Review this experience's analytics for the last 7 days and suggest code changes ")}><Icon name="at" size={12} /> Ask the agent</button>
          </div>
        </div>

        {needsSetup && (
          <section className="set-sec setup">
            <h2>Connect Open Cloud analytics</h2>
            {status?.apiProblem && <div className="callout err">{status.apiProblem}</div>}
            <p className="note">
              Create an API key at <a href="https://create.roblox.com/dashboard/credentials" target="_blank" rel="noreferrer">create.roblox.com/dashboard/credentials</a> with
              <span className="mono"> universe-analytics → universe.analytics:read</span>, and optionally <span className="mono">game-pass:read</span> and
              <span className="mono"> developer-product:read</span> for the catalog. Add this experience under Access Permissions. Without a key, this page still works from public stats and CSV imports.
            </p>
            <form className="row" onSubmit={async (e) => { e.preventDefault(); if (key.trim()) { setStatus(await h.analyticsSetApiKey(key.trim(), 'project')); setKey('') } }}>
              <input className="input grow" type="password" placeholder="Open Cloud API key" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" aria-label="Analytics API key" />
              <button className="btn primary" disabled={!key.trim()}>Save key</button>
            </form>
            {(!status?.universeId || !status?.placeId) && (
              <form className="row" style={{ marginTop: 8 }} onSubmit={async (e) => { e.preventDefault(); setStatus(await h.analyticsSetExperience({ placeId: Number(ids.placeId) || undefined, universeId: Number(ids.universeId) || undefined })) }}>
                <input className="input grow" inputMode="numeric" placeholder="Place ID" value={ids.placeId} onChange={(e) => setIds({ ...ids, placeId: e.target.value })} aria-label="Place ID" />
                <input className="input grow" inputMode="numeric" placeholder="Universe ID" value={ids.universeId} onChange={(e) => setIds({ ...ids, universeId: e.target.value })} aria-label="Universe ID" />
                <button className="btn">Set experience</button>
              </form>
            )}
          </section>
        )}

        {ovErr && <div className="callout err">{ovErr}</div>}
        <div className="kpis">
          {kpis.map((k) => <Kpi key={k.metric} k={k} active={k.metric === metric} onClick={() => setMetric(k.metric)} />)}
          {live && (
            <div className="kpi static" title="Public game stats (no key needed)">
              <div className="row"><span className="kpi-label grow">Playing now</span><span className="tag warn">Public</span></div>
              <div className="kpi-value">{fmtNum(live.playing)}</div>
              <span className="faint">{fmtValue(live.visits, '')} visits · {fmtValue(live.favorites, '')} favs</span>
            </div>
          )}
          {!overview && !ovErr && [0, 1, 2, 3].map((i) => <div key={i} className="kpi skeleton" />)}
        </div>

        {signals.length > 0 && (
          <section className="set-sec">
            <h2>Signals</h2>
            {signals.map((s) => (
              <div key={s.id} className="lrow static signal" title={Object.entries(s.evidence).map(([k, v]) => `${k}: ${v}`).join('\n')}>
                <span className={`sev ${SEV[s.severity].cls}`}><Icon name={SEV[s.severity].icon} size={13} /></span>
                <span className="grow">{s.text}</span>
                <button className="mini-btn" onClick={() => actions.ask(`Analytics signal: ${s.text} What in the code could explain this? `)}>Ask</button>
              </div>
            ))}
          </section>
        )}

        <section className="set-sec">
          <h2>
            {metricLabel}
            {series?.source && <span className="tag">{SOURCE_LABEL[series.source]}</span>}
            <span className="grow" />
            <select className="input" value={breakdown} onChange={(e) => setBreakdown(e.target.value)} aria-label="Breakdown">
              {BREAKDOWNS.map((b) => <option key={b} value={b}>{b ? `by ${b}` : 'no breakdown'}</option>)}
            </select>
            <div className="seg">
              {(['day', 'week', 'month'] as AnalyticsGranularity[]).map((g) => <button key={g} className={gran === g ? 'on' : ''} onClick={() => setGran(g)}>{g}</button>)}
            </div>
          </h2>
          <div className="chart-box">{series ? <Chart data={series} /> : <div className="chart-empty"><span className="spinner" /></div>}</div>
          {series && series.series.length > 1 && (
            <div className="row legend">{series.series.map((s, i) => <span key={i} className={`lg s${i % 4}`}>{Object.values(s.breakdown ?? {}).join(' / ') || s.metric}</span>)}</div>
          )}
          {series?.notes.map((n, i) => <div key={i} className="note">{n}</div>)}
        </section>

        {acq && (
          <section className="set-sec">
            <h2>Acquisition</h2>
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>Source</th><th>Impressions</th><th>Plays</th><th>Qualified</th><th>Plays / impr.</th></tr>
                </thead>
                <tbody>
                  {acq.bySource.map((r) => (
                    <tr key={r.source}>
                      <td>{r.source}</td>
                      <td>{fmtValue(r.impressions, '')}</td>
                      <td>{fmtValue(r.plays, '')}</td>
                      <td>{fmtValue(r.qualifiedPlays, '')}</td>
                      <td>{r.playsPerImpression === null ? '—' : `${(r.playsPerImpression * 100).toFixed(2)}%`} {r.playsPerImpression !== null && r.playsPerImpressionPrev ? <Delta metric="x" change={r.playsPerImpression / r.playsPerImpressionPrev - 1} /> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row note" style={{ flexWrap: 'wrap', gap: 14, marginTop: 8 }}>
              {acq.homeRecs.map((r) => <span key={r.metric}>{r.label} {fmtValue(r.current, 'ratio')} <Delta metric={r.metric} change={r.change} /></span>)}
              {acq.newVsReturning.map((r) => <span key={r.segment}>{r.segment} DAU {fmtValue(r.dau, '')} <Delta metric="DailyActiveUsers" change={r.change} /></span>)}
              {acq.publicTrend.likeRatio !== null && <span>like ratio {fmtValue(acq.publicTrend.likeRatio, 'ratio')}</span>}
            </div>
          </section>
        )}

        <div className="grid2">
          <section className="set-sec">
            <h2>Imports</h2>
            <div
              className={`drop${drag ? ' over' : ''}`}
              onDragOver={(e) => (e.preventDefault(), setDrag(true))}
              onDragLeave={() => setDrag(false)}
              onDrop={onDrop}
              onClick={() => fileInput.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && fileInput.current?.click()}
            >
              <Icon name="upload" size={16} />
              <span>Drop a Creator Dashboard CSV, or click to choose</span>
              <span className="note">Unzip a sales .zip first.</span>
              <input ref={fileInput} type="file" accept=".csv" multiple hidden onChange={(e) => void importPaths([...(e.target.files ?? [])].map((f) => window.forgeFiles?.pathFor(f) ?? f.name))} />
            </div>
            {importMsg.map((m, i) => <div key={i} className="note">{m}</div>)}
            {status?.imports.map((s) => (
              <div key={`${s.metric}:${JSON.stringify(s.breakdown ?? {})}`} className="lrow static">
                <Icon name="file" size={13} />
                <span className="grow ellipsis" title={s.file}>{s.label}</span>
                <span className="sub">{s.points} pts · {s.first ?? '?'} to {s.last ?? '?'}</span>
                <button className="row-act" style={{ display: 'grid' }} title="Remove import" onClick={async () => { await h.analyticsRemoveImport({ metric: s.metric, breakdown: s.breakdown }); loadStatus() }}><Icon name="x" size={11} /></button>
              </div>
            ))}
          </section>

          <section className="set-sec">
            <h2>Public tracking</h2>
            <div className="set-row">
              <div className="set-text">
                <div className="set-title">Snapshot public stats</div>
                <div className="note">Every {status?.poller.intervalMinutes ?? '?'} min · {status?.poller.snapshots ?? 0} snapshots{status?.poller.lastAt ? ` · last ${ago(status.poller.lastAt)}` : ''}</div>
              </div>
              <div className="set-ctl">
                <input type="checkbox" className="switch" checked={!!status?.poller.running} disabled={!status} onChange={async (e) => setStatus(await h.analyticsPoller(e.target.checked))} aria-label="Snapshot public stats" />
              </div>
            </div>
            <button className="btn small" onClick={async () => { await h.analyticsPollNow(); loadStatus() }}>Snapshot now</button>
            {status?.hasApiKey && (
              <div className="row" style={{ marginTop: 10 }}>
                <span className="note grow">Open Cloud key set</span>
                <button className="btn small danger" onClick={async () => setStatus(await h.analyticsClearApiKey('project'))}>Remove key</button>
              </div>
            )}
          </section>
        </div>

        {catalog && (
          <section className="set-sec">
            <h2>Catalog <span className="count">{catalog.length}</span></h2>
            {catalog.map((c) => (
              <div key={`${c.kind}:${c.id}`} className="lrow static">
                <span className="tag">{c.kind === 'gamePass' ? 'pass' : 'product'}</span>
                <span className="grow ellipsis">{c.name}</span>
                {!c.isForSale && <span className="tag warn">off sale</span>}
                <span className="mono">{c.priceRobux !== undefined ? `R$ ${c.priceRobux}` : '—'}</span>
                <span className="sub mono">{c.id}</span>
              </div>
            ))}
          </section>
        )}

        <section className="set-sec">
          <h2>
            Instrumentation
            <span className="grow" />
            <select className="input" value={snippetKind} onChange={(e) => setSnippetKind(e.target.value as AnalyticsSnippetKind)} aria-label="Snippet kind">
              {(['setup', 'custom', 'onboarding', 'funnel', 'economy', 'progression'] as AnalyticsSnippetKind[]).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </h2>
          {snippet ? (
            <>
              {snippet.files.map((f) => (
                <div key={f.path} className="snippet">
                  <div className="row snippet-head">
                    <span className="mono grow ellipsis">{f.path}</span>
                    <button className="mini-btn" onClick={() => void actions.copy(f.code, f.path)}>Copy</button>
                  </div>
                  <pre className="mono">{f.code}</pre>
                </div>
              ))}
              {snippet.call && (
                <div className="snippet">
                  <div className="row snippet-head"><span className="grow">At the call site</span><button className="mini-btn" onClick={() => void actions.copy(snippet.call!, 'call')}>Copy</button></div>
                  <pre className="mono">{snippet.call}</pre>
                </div>
              )}
              {snippet.notes.map((n, i) => <div key={i} className="note">{n}</div>)}
            </>
          ) : (
            <div className="note">Loading...</div>
          )}
        </section>
      </div>
    </div>
  )
}
