import { git, type CollabDeps } from '../collab/git.ts'
import type { CheckOutcome, CheckResult, PreflightReport, ReleaseCheck } from './types.ts'

// Release pre-flight: a list of checks run one after another (git first, since a failed fetch makes
// later answers stale). Each tool check is an injected function so the integrator wires the real
// Blink / Lune / selene runners; missing ones are reported as skipped, never as passed.

export async function runPreflight(checks: ReleaseCheck[], options: { timeoutMs?: number; onProgress?: (result: CheckResult) => void } = {}): Promise<PreflightReport> {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000
  const results: CheckResult[] = []
  for (const check of checks) {
    const started = Date.now()
    let outcome: CheckOutcome
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      outcome = await Promise.race([
        check.run(),
        new Promise<CheckOutcome>((resolve) => {
          timer = setTimeout(() => resolve({ status: 'fail', summary: `Timed out after ${Math.round(timeoutMs / 1000)} s` }), timeoutMs)
        })
      ])
    } catch (error) {
      outcome = { status: 'fail', summary: error instanceof Error ? error.message : String(error) }
    } finally {
      if (timer) clearTimeout(timer)
    }
    // A non-blocking failure is downgraded to a warning so the UI and `ok` agree.
    if (outcome.status === 'fail' && !check.blocking) outcome = { ...outcome, status: 'warn' }
    const result: CheckResult = { id: check.id, label: check.label, blocking: check.blocking, durationMs: Date.now() - started, ...outcome }
    results.push(result)
    options.onProgress?.(result)
  }
  const blockers = results.filter((r) => r.status === 'fail').map((r) => `${r.label}: ${r.summary}`)
  return { ok: blockers.length === 0, checks: results, blockers }
}

// ---------------------------------------------------------------- git

export interface GitCheckOptions extends CollabDeps {
  // Release needs a remote to push the tag to; without one the check fails (default true).
  requireRemote?: boolean
  fetch?: boolean
}

export function gitCheck(root: string, options: GitCheckOptions = {}): ReleaseCheck {
  return {
    id: 'git',
    label: 'Git is clean and in sync with teammates',
    blocking: true,
    async run() {
      const inside = await git(root, ['rev-parse', '--is-inside-work-tree'], options)
      if (inside.code !== 0) return { status: 'fail', summary: 'This project is not a git repository' }
      const details: string[] = []
      const branch = (await git(root, ['symbolic-ref', '--short', 'HEAD'], options)).stdout.trim()
      if (!branch) return { status: 'fail', summary: 'HEAD is detached; check out a branch first' }
      const upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], options)
      const hasUpstream = upstream.code === 0
      let fetchNote = ''
      if (hasUpstream && options.fetch !== false) {
        const fetched = await git(root, ['fetch', '--quiet', '--tags'], options)
        if (fetched.code !== 0) fetchNote = 'Could not reach the remote, so teammates’ latest work was not checked.'
      }
      const conflicts = (await git(root, ['diff', '--name-only', '--diff-filter=U'], options)).stdout.trim().split(/\r?\n/).filter(Boolean)
      if (conflicts.length) return { status: 'fail', summary: `${conflicts.length} file(s) have merge conflicts`, details: conflicts }
      const status = (await git(root, ['status', '--porcelain', '--untracked-files=normal'], options)).stdout.split(/\r?\n/).filter(Boolean)
      if (status.length) return { status: 'fail', summary: `${status.length} uncommitted change(s). Sync or commit them first.`, details: status.slice(0, 50) }
      if (!hasUpstream) {
        if (options.requireRemote === false) return { status: 'warn', summary: `Branch ${branch} has no upstream; the tag stays local` }
        return { status: 'fail', summary: `Branch ${branch} has no upstream to push the release to. Sync once to publish the branch.` }
      }
      const counts = (await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'], options)).stdout.trim().split(/\s+/).map(Number)
      const [ahead = 0, behind = 0] = counts
      if (behind > 0) return { status: 'fail', summary: `Teammates pushed ${behind} commit(s) you do not have. Sync first.` }
      if (ahead > 0) return { status: 'fail', summary: `${ahead} local commit(s) are not shared yet. Sync first.` }
      details.push(`On ${branch}, up to date with ${upstream.stdout.trim()}`)
      if (fetchNote) return { status: 'warn', summary: fetchNote, details }
      return { status: 'pass', summary: 'Clean and up to date', details }
    }
  }
}

// ---------------------------------------------------------------- Studio sync

export function studioConflictsCheck(list: () => Promise<{ path: string }[]>): ReleaseCheck {
  return {
    id: 'studio-sync',
    label: 'No unresolved Studio sync conflicts',
    blocking: true,
    async run() {
      const held = await list()
      if (!held.length) return { status: 'pass', summary: 'No held Studio versions' }
      return { status: 'fail', summary: `${held.length} script(s) changed in both Studio and the repo. Resolve them first.`, details: held.map((c) => c.path) }
    }
  }
}

// ---------------------------------------------------------------- tool adapters

// Shape of services/blink.ts checkBlink(root) results.
export interface BlinkRun {
  ok: boolean
  diagnostics: { file: string; line: number; message: string }[]
  skipped?: string
}

export function blinkCheck(checkBlink: () => Promise<BlinkRun>): ReleaseCheck {
  return {
    id: 'blink',
    label: 'Blink networking compiles',
    blocking: true,
    async run() {
      const result = await checkBlink()
      if (result.skipped) return { status: 'skip', summary: result.skipped }
      if (result.ok) return { status: 'pass', summary: 'events.blink compiles' }
      return { status: 'fail', summary: `${result.diagnostics.length} Blink error(s)`, details: result.diagnostics.slice(0, 20).map((d) => `${d.file}:${d.line} ${d.message}`) }
    }
  }
}

// What the integrator's Lune test runner should return.
export interface LuneTestRun {
  // false = no tests in this project or lune missing (reason in note).
  ran: boolean
  passed: number
  failed: number
  note?: string
  failures?: string[]
}

export function luneTestsCheck(runTests: () => Promise<LuneTestRun>): ReleaseCheck {
  return {
    id: 'lune-tests',
    label: 'Lune tests pass',
    blocking: true,
    async run() {
      const result = await runTests()
      if (!result.ran) return { status: 'skip', summary: result.note || 'No Lune tests' }
      if (result.failed > 0) return { status: 'fail', summary: `${result.failed} of ${result.passed + result.failed} test(s) failed`, details: result.failures?.slice(0, 20) }
      return { status: 'pass', summary: `${result.passed} test(s) passed` }
    }
  }
}

// Shape of collab/quality.ts runSelene(root) results.
export interface SeleneRun {
  ran: boolean
  problems: { path: string; line: number; severity: 'error' | 'warning' | 'info'; message: string }[]
  note?: string
}

// Errors block; warnings only warn.
export function seleneCheck(runSelene: () => Promise<SeleneRun>): ReleaseCheck {
  return {
    id: 'selene',
    label: 'selene lint is clean',
    blocking: true,
    async run() {
      const result = await runSelene()
      if (!result.ran) return { status: 'skip', summary: result.note || 'selene not available' }
      const errors = result.problems.filter((p) => p.severity === 'error')
      const lines = result.problems.slice(0, 20).map((p) => `${p.path}:${p.line} ${p.message}`)
      if (errors.length) return { status: 'fail', summary: `${errors.length} lint error(s)`, details: lines }
      if (result.problems.length) return { status: 'warn', summary: `${result.problems.length} lint warning(s)`, details: lines }
      return { status: 'pass', summary: 'No lint problems' }
    }
  }
}

// For anything else the integrator wants to add (e.g. a Rojo sourcemap check).
export function customCheck(id: string, label: string, run: () => Promise<CheckOutcome | boolean>, blocking = true): ReleaseCheck {
  return {
    id,
    label,
    blocking,
    async run() {
      const result = await run()
      if (typeof result === 'boolean') return result ? { status: 'pass', summary: 'OK' } : { status: 'fail', summary: 'Failed' }
      return result
    }
  }
}

export interface DefaultCheckDeps extends GitCheckOptions {
  studioConflicts?: () => Promise<{ path: string }[]>
  blink?: () => Promise<BlinkRun>
  lune?: () => Promise<LuneTestRun>
  selene?: () => Promise<SeleneRun>
  extra?: ReleaseCheck[]
}

function notWired(id: string, label: string, why: string): ReleaseCheck {
  return { id, label, blocking: false, run: async () => ({ status: 'skip', summary: why }) }
}

export function defaultChecks(root: string, deps: DefaultCheckDeps = {}): ReleaseCheck[] {
  return [
    gitCheck(root, deps),
    deps.studioConflicts ? studioConflictsCheck(deps.studioConflicts) : notWired('studio-sync', 'No unresolved Studio sync conflicts', 'Studio sync check not connected'),
    deps.blink ? blinkCheck(deps.blink) : notWired('blink', 'Blink networking compiles', 'Blink check not connected'),
    deps.lune ? luneTestsCheck(deps.lune) : notWired('lune-tests', 'Lune tests pass', 'No Lune test runner connected'),
    deps.selene ? seleneCheck(deps.selene) : notWired('selene', 'selene lint is clean', 'selene check not connected'),
    ...(deps.extra ?? [])
  ]
}
