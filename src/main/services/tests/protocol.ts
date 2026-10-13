// The runner's JSON-line protocol (resources/lune/runner.luau --format json) and compact text for
// agents. Each machine line is one JSON object with "forge": 1 and a "type"; anything else on stdout
// is stray output (a module writing directly to stdio) and is kept as a log.

import type { RunSummary, TestCaseResult, TestLog, TestStatus } from './types.ts'

export const PROTOCOL_VERSION = 1

export type RunnerEvent =
  | { type: 'start'; files: string[]; filter?: string }
  | { type: 'file'; file: string; realm: 'server' | 'client'; instancePath?: string[] }
  | ({ type: 'test' } & TestCaseResult)
  | { type: 'log'; file?: string; test?: string; level: 'print' | 'warn'; text: string }
  | { type: 'fileEnd'; file: string; passed: number; failed: number; skipped: number; ms: number }
  | { type: 'end'; passed: number; failed: number; skipped: number; files: number; ms: number }
  | { type: 'fatal'; message: string }

const STATUSES = new Set<TestStatus>(['pass', 'fail', 'skip', 'todo'])

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

// Parses one stdout line. Returns null for anything that is not a well-formed runner event.
export function parseEventLine(line: string): RunnerEvent | null {
  const text = line.trim()
  if (!text.startsWith('{')) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || raw.forge !== PROTOCOL_VERSION) return null
  switch (raw.type) {
    case 'start':
      return { type: 'start', files: Array.isArray(raw.files) ? raw.files.filter((f): f is string => typeof f === 'string') : [], filter: str(raw.filter) }
    case 'file': {
      const file = str(raw.file)
      if (!file) return null
      return {
        type: 'file',
        file,
        realm: raw.realm === 'client' ? 'client' : 'server',
        instancePath: Array.isArray(raw.instancePath) ? raw.instancePath.map(String) : undefined
      }
    }
    case 'test': {
      const file = str(raw.file)
      const test = str(raw.test)
      const status = str(raw.status) as TestStatus | undefined
      if (!file || test === undefined || !status || !STATUSES.has(status)) return null
      const result: { type: 'test' } & TestCaseResult = { type: 'test', file, suite: str(raw.suite) ?? '', test, status, ms: num(raw.ms) }
      const error = raw.error as Record<string, unknown> | undefined
      if (error && typeof error === 'object') {
        result.error = { message: str(error.message) ?? String(error.message ?? 'error') }
        if (typeof error.line === 'number') result.error.line = error.line
        if (typeof error.stack === 'string') result.error.stack = error.stack
      }
      return result
    }
    case 'log':
      return { type: 'log', file: str(raw.file), test: str(raw.test), level: raw.level === 'warn' ? 'warn' : 'print', text: str(raw.text) ?? '' }
    case 'fileEnd':
      return { type: 'fileEnd', file: str(raw.file) ?? '', passed: num(raw.passed), failed: num(raw.failed), skipped: num(raw.skipped), ms: num(raw.ms) }
    case 'end':
      return { type: 'end', passed: num(raw.passed), failed: num(raw.failed), skipped: num(raw.skipped), files: num(raw.files), ms: num(raw.ms) }
    case 'fatal':
      return { type: 'fatal', message: str(raw.message) ?? 'runner failed' }
    default:
      return null
  }
}

export type StreamItem = { event: RunnerEvent } | { output: string }

// Splits a byte stream into lines (CRLF-safe) and parses each. Partial lines wait for the next chunk.
export class EventStream {
  private buffer = ''

  push(chunk: string): StreamItem[] {
    this.buffer += chunk
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''
    return lines.flatMap((line) => this.item(line))
  }

  flush(): StreamItem[] {
    const rest = this.buffer
    this.buffer = ''
    return rest ? this.item(rest) : []
  }

  private item(line: string): StreamItem[] {
    if (!line.trim()) return []
    const event = parseEventLine(line)
    return [event ? { event } : { output: line }]
  }
}

// Folds runner events into results and logs (the service adds state/timing on top).
export class ResultCollector {
  results: TestCaseResult[] = []
  logs: TestLog[] = []
  files: string[] = []
  ended: Extract<RunnerEvent, { type: 'end' }> | null = null
  fatal: string | null = null

  add(item: StreamItem): void {
    if ('output' in item) {
      this.logs.push({ level: 'output', text: item.output })
      return
    }
    const event = item.event
    if (event.type === 'start') this.files = event.files
    else if (event.type === 'test') {
      const { type: _type, ...result } = event
      this.results.push(result)
    } else if (event.type === 'log') {
      this.logs.push({ file: event.file, test: event.test, level: event.level, text: event.text })
    } else if (event.type === 'end') this.ended = event
    else if (event.type === 'fatal') this.fatal = event.message
  }

  counts(): { passed: number; failed: number; skipped: number; total: number } {
    let passed = 0
    let failed = 0
    let skipped = 0
    for (const r of this.results) {
      if (r.status === 'pass') passed++
      else if (r.status === 'fail') failed++
      else skipped++
    }
    return { passed, failed, skipped, total: this.results.length }
  }
}

export interface CompactOptions {
  // Failures listed in full; the rest are counted. Default 8.
  maxFailures?: number
  // Lines of each error message kept. Default 2.
  maxErrorLines?: number
  // Max characters per error line. Default 200.
  maxLineChars?: number
}

function fullName(result: TestCaseResult): string {
  return result.suite ? `${result.suite} > ${result.test}` : result.test
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

// Token-cheap text for the agent: one status line, then the first error lines of each failure as
// "x file:line name: message". Passing tests are counted, never listed.
export function formatCompact(summary: RunSummary, options: CompactOptions = {}): string {
  const maxFailures = options.maxFailures ?? 8
  const maxErrorLines = options.maxErrorLines ?? 2
  const maxLineChars = options.maxLineChars ?? 200
  switch (summary.state) {
    case 'no-lune':
    case 'no-tests':
    case 'no-project':
      return summary.message ?? summary.state
    case 'error':
      return clip(`ERROR ${summary.message ?? 'runner failed'}${summary.stderr ? `\n${summary.stderr.trim().split('\n').slice(-3).join('\n')}` : ''}`, 800)
    default:
      break
  }
  const head =
    summary.state === 'passed'
      ? 'PASS'
      : summary.state === 'failed'
        ? 'FAIL'
        : summary.state === 'cancelled'
          ? 'CANCELLED'
          : 'TIMEOUT'
  const counts = [`${summary.passed} passed`]
  if (summary.failed) counts.unshift(`${summary.failed} failed`)
  if (summary.skipped) counts.push(`${summary.skipped} skipped`)
  const lines = [`${head} ${counts.join(', ')} (${summary.files.length} file${summary.files.length === 1 ? '' : 's'}, ${Math.round(summary.ms)} ms)`]
  if (summary.message && summary.state !== 'passed' && summary.state !== 'failed') lines.push(summary.message)
  const failures = summary.results.filter((r) => r.status === 'fail')
  for (const failure of failures.slice(0, maxFailures)) {
    const where = failure.error?.line ? `${failure.file}:${failure.error.line}` : failure.file
    const message = (failure.error?.message ?? 'failed').split('\n').filter((l) => l.trim()).slice(0, maxErrorLines)
    lines.push(`x ${where} ${fullName(failure)}: ${clip(message[0] ?? 'failed', maxLineChars)}`)
    for (const extra of message.slice(1)) lines.push(`  ${clip(extra.trim(), maxLineChars)}`)
  }
  if (failures.length > maxFailures) lines.push(`… ${failures.length - maxFailures} more failure(s)`)
  return lines.join('\n')
}
