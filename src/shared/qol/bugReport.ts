// Bug report assembly: what happened / expected, app + OS, open page, project, recent errors and
// the last log lines, as one markdown file. Everything goes through the redactor. Pure.

import type { LogLine } from '../types.ts'
import type { ErrorRecord } from './types.ts'
import { redact } from './redact.ts'

export const REPORT_LOG_LINES = 300
export const REPORT_ERRORS = 20

export interface BugReportFacts {
  what: string
  expected: string
  at: number
  app: { version: string; electron?: string; chrome?: string; node?: string; packaged?: boolean }
  os: { platform: string; release: string; arch: string }
  page?: string
  tab?: string
  project: { name: string; root: string } | null
  includePath: boolean
  homeDir?: string
  logs: LogLine[]
  errors: ErrorRecord[]
  // File name next to report.md, or null when no screenshot was taken.
  screenshot: string | null
  // Extra sections from other tools (e.g. Forge Doctor), redacted like the rest.
  extra?: { title: string; body: string }[]
}

export interface AssembledReport {
  markdown: string
  redactions: number
}

const OS_NAMES: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

function time(at: number): string {
  const d = new Date(at)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

// Folder name for a report: 2026-10-14_09-30-05 (local time, sortable, safe on every OS).
export function reportStamp(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

function fence(text: string): string {
  // A fence longer than any backtick run inside.
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const ticks = '`'.repeat(longest + 1)
  return `${ticks}text\n${text}\n${ticks}`
}

export function formatLogLine(line: LogLine): string {
  const text = line.text.replace(/\s+$/, '')
  return `${time(line.at)} [${line.service}${line.stream === 'stderr' ? '!' : ''}] ${text}`
}

export function assembleBugReport(facts: BugReportFacts): AssembledReport {
  const replace: { from: string; to: string }[] = []
  if (facts.project && !facts.includePath && facts.project.root) replace.push({ from: facts.project.root, to: `<${facts.project.name || 'project'}>` })
  if (facts.homeDir) replace.push({ from: facts.homeDir, to: '~' })
  let redactions = 0
  const clean = (text: string) => {
    const r = redact(text, { replace })
    redactions += r.count
    return r.text
  }

  const lines: string[] = []
  lines.push('# RBX Forge bug report', '')
  lines.push(`Created ${new Date(facts.at).toISOString()} · nothing was uploaded; share this file yourself.`, '')

  lines.push('## What happened', '', clean(facts.what.trim()) || '_(not filled in)_', '')
  lines.push('## What I expected', '', clean(facts.expected.trim()) || '_(not filled in)_', '')

  lines.push('## Environment', '')
  const app = facts.app
  lines.push(`- RBX Forge ${app.version}${app.packaged === false ? ' (development build)' : ''}`)
  const runtime = [app.electron && `Electron ${app.electron}`, app.chrome && `Chrome ${app.chrome}`, app.node && `Node ${app.node}`].filter(Boolean)
  if (runtime.length) lines.push(`- ${runtime.join(' · ')}`)
  lines.push(`- ${OS_NAMES[facts.os.platform] ?? facts.os.platform} ${facts.os.release} (${facts.os.arch})`)
  if (facts.page) lines.push(`- Open page: ${clean(facts.page)}`)
  if (facts.tab && facts.tab !== facts.page) lines.push(`- Open tab: ${clean(facts.tab)}`)
  if (facts.project) {
    lines.push(`- Project: ${clean(facts.project.name)}`)
    if (facts.includePath) lines.push(`- Project path: ${clean(facts.project.root)}`)
  } else lines.push('- Project: none open')
  lines.push('')

  if (facts.screenshot) lines.push('## Screenshot', '', `![Forge window](${facts.screenshot})`, '')

  const errors = facts.errors.slice(-REPORT_ERRORS)
  lines.push(`## Recent errors (${errors.length})`, '')
  if (!errors.length) lines.push('_None recorded this session._', '')
  for (const e of errors) {
    lines.push(`- ${time(e.at)} **${e.origin}**: ${clean(e.message).split('\n')[0]}`)
    if (e.stack) lines.push('', fence(clean(e.stack).split('\n').slice(0, 12).join('\n')), '')
  }
  if (errors.length) lines.push('')

  for (const section of facts.extra ?? []) {
    if (!section.body.trim()) continue
    lines.push(`## ${clean(section.title)}`, '', clean(section.body.trim()), '')
  }

  const logs = facts.logs.slice(-REPORT_LOG_LINES)
  lines.push(`## Last ${logs.length} log lines`, '')
  lines.push(logs.length ? fence(clean(logs.map(formatLogLine).join('\n'))) : '_No log lines._', '')

  if (redactions) lines.push(`_${redactions} value${redactions === 1 ? '' : 's'} that looked like keys, tokens, passwords or cookies were replaced with [REDACTED]._`, '')
  return { markdown: lines.join('\n'), redactions }
}
