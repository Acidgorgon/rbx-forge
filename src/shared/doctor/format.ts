// Forge Doctor report as Markdown (for bug reports). Never contains key values: the checks only
// carry "set" / "missing". Home-directory paths are shortened to ~.

import type { DoctorReport, DoctorStatus } from './types.ts'

const MARK: Record<DoctorStatus, string> = { ok: 'OK', warn: 'WARN', fail: 'FAIL', skip: 'skip' }

export function redactHome(text: string, home?: string): string {
  let t = text
  if (home && home.length > 1) t = t.split(home).join('~')
  return t.replace(/\/Users\/[^/\s]+/g, '~').replace(/\/home\/[^/\s]+/g, '~').replace(/[A-Z]:\\Users\\[^\\\s]+/gi, '~')
}

export function doctorMarkdown(r: DoctorReport, opts: { home?: string } = {}): string {
  const lines: string[] = []
  lines.push(`## Forge Doctor`)
  lines.push('')
  lines.push(`RBX Forge ${r.appVersion} · ${r.platform} · ${new Date(r.at).toISOString()} · ${r.counts.fail} failing, ${r.counts.warn} warnings, ${r.counts.ok} ok`)
  lines.push('')
  lines.push('| | Check | Result |')
  lines.push('|---|---|---|')
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  for (const c of r.checks) lines.push(`| ${MARK[c.status]} | ${cell(`${c.group}: ${c.title}`)} | ${cell(c.detail)} |`)
  return redactHome(lines.join('\n'), opts.home) + '\n'
}
