import { formatSignals } from './insights.ts'
import { compactSeries, pct, round } from './series.ts'
import type { AcquisitionResult, CompareResult, OverviewResult, SeriesResult } from './service.ts'
import type { AnalyticsStatus, CatalogItem } from './types.ts'

// Compact text renderings for agent tool results: few tokens, every number labelled, and the data
// source on each line so an agent never mistakes a public-snapshot estimate for dashboard data.

const n = (v: number | null | undefined) => (v === null || v === undefined ? '-' : String(round(v)))

export function formatOverview(r: OverviewResult): string {
  const lines = [`overview ${r.range.start}..${r.range.end} vs ${r.previous.start}..${r.previous.end} (end exclusive, UTC)`]
  for (const k of r.kpis) lines.push(`${k.label}: ${n(k.current)} (prev ${n(k.previous)}, ${pct(k.change)}) [${k.metric}, ${k.source}]`)
  if (!r.kpis.length) lines.push('no KPI data')
  if (r.live) {
    const like = r.live.upVotes !== undefined && r.live.downVotes !== undefined && r.live.upVotes + r.live.downVotes > 0 ? ` likes=${round((r.live.upVotes / (r.live.upVotes + r.live.downVotes)) * 100)}%` : ''
    lines.push(`live (public): playing=${r.live.playing} visits=${r.live.visits} favorites=${r.live.favorites}${like}`)
  }
  lines.push(formatSignals(r.signals))
  if (r.notes.length) lines.push('notes: ' + r.notes.join(' | '))
  return lines.join('\n')
}

export function formatSeriesResult(r: SeriesResult, maxSeries = 12): string {
  const lines = [`range ${r.range.start}..${r.range.end} source=${r.source ?? 'none'}`]
  for (const s of r.series.slice(0, maxSeries)) lines.push(compactSeries(s, r.range))
  if (r.series.length > maxSeries) lines.push(`(+${r.series.length - maxSeries} more series; narrow with filter or limit)`)
  if (r.releases.length) lines.push('releases in range: ' + r.releases.map((x) => `${x.tag}@${x.at.slice(0, 10)}`).join(' '))
  if (r.notes.length) lines.push('notes: ' + r.notes.join(' | '))
  return lines.join('\n')
}

export function formatCompare(r: CompareResult): string {
  const lines = [`A=${r.a.start}..${r.a.end} B=${r.b.start}..${r.b.end} (change = A vs B)`]
  for (const row of r.rows) lines.push(`${row.label}: A=${n(row.a)} B=${n(row.b)} ${pct(row.change)} [${row.metric}, ${row.source ?? 'no data'}]`)
  if (r.notes.length) lines.push('notes: ' + r.notes.join(' | '))
  return lines.join('\n')
}

export function formatAcquisition(r: AcquisitionResult): string {
  const lines = [`acquisition ${r.range.start}..${r.range.end} vs ${r.previous.start}..${r.previous.end}`]
  const t = r.totals
  lines.push(`totals: impression-users=${n(t.impressions)} (${pct(t.impressionsChange)}) play-users=${n(t.plays)} (${pct(t.playsChange)}) qualified=${n(t.qualifiedPlays)} plays/impr=${n(r.rates.playsPerImpressionUser)}`)
  if (r.bySource.length) {
    lines.push('source | impr (prev) | plays (prev) | plays/impr (prev) | qualified')
    for (const row of r.bySource.slice(0, 15)) {
      lines.push(`${row.source} | ${n(row.impressions)} (${n(row.impressionsPrev)}) | ${n(row.plays)} (${n(row.playsPrev)}) | ${n(row.playsPerImpression)} (${n(row.playsPerImpressionPrev)}) | ${n(row.qualifiedPlays)}`)
    }
  } else lines.push('by source: no data (needs the Analytics API key)')
  if (r.homeRecs.length) lines.push('home recommendations: ' + r.homeRecs.map((h) => `${h.label}=${n(h.current)} (${pct(h.change)})`).join(', '))
  if (r.newVsReturning.length) lines.push('DAU: ' + r.newVsReturning.map((s) => `${s.segment}=${n(s.dau)} (${pct(s.change)})`).join(', '))
  const p = r.publicTrend
  if (p.newVisits !== null || p.likeRatio !== null) lines.push(`public snapshots: new visits=${n(p.newVisits)} (${pct(p.newVisitsChange)}) new favorites=${n(p.newFavorites)} like ratio=${n(p.likeRatio)}`)
  lines.push(formatSignals(r.signals, 8))
  if (r.notes.length) lines.push('notes: ' + r.notes.join(' | '))
  return lines.join('\n')
}

export function formatStatus(s: AnalyticsStatus): string {
  const lines = [
    `universe=${s.universeId ?? 'unknown'} place=${s.placeId ?? 'unknown'} apiKey=${s.hasApiKey ? 'set' : 'missing'}`,
    `public poller: ${s.poller.running ? 'running' : 'stopped'} every ${s.poller.intervalMinutes} min, ${s.poller.snapshots} snapshots${s.poller.lastAt ? `, last ${s.poller.lastAt}` : ''}`
  ]
  if (s.apiProblem) lines.push(`api problem: ${s.apiProblem}`)
  if (s.imports.length) {
    lines.push('imported CSV series:')
    for (const i of s.imports) lines.push(`  ${i.metric}${i.breakdown ? ` [${Object.values(i.breakdown).join(',')}]` : ''} ${i.first}..${i.last} n=${i.points}`)
  } else lines.push('imported CSV series: none')
  return lines.join('\n')
}

export function formatCatalog(items: CatalogItem[]): string {
  if (!items.length) return 'no game passes or developer products'
  return items.map((i) => `${i.kind === 'gamePass' ? 'pass' : 'product'} ${i.id} "${i.name}" ${i.priceRobux ?? '?'}R$ ${i.isForSale ? 'on sale' : 'off sale'}`).join('\n')
}
