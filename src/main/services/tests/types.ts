// Types for headless Luau tests (Lune). Kept here, not in @shared/types, so this folder stands alone;
// CONTRACT.md lists which of them the integrator mirrors into src/shared/types.ts for IPC.

export type TestStatus = 'pass' | 'fail' | 'skip' | 'todo'

export interface TestError {
  message: string
  // Line in the spec file where the failure happened, when known.
  line?: number
  // Project frames of the traceback (no runner frames), newest first.
  stack?: string
}

export interface TestCaseResult {
  // Spec file, repo-relative with forward slashes.
  file: string
  // "Outer > Inner" describe path; "" for top-level tests.
  suite: string
  test: string
  status: TestStatus
  ms: number
  error?: TestError
}

export interface TestLog {
  file?: string
  test?: string
  level: 'print' | 'warn' | 'output'
  text: string
}

export type Realm = 'server' | 'client'

export interface SpecFile {
  file: string
  // Instance path from the DataModel, e.g. ["ReplicatedStorage", "Shared", "Modules", "X.spec"].
  instancePath: string[]
  realm: Realm
}

// What to run. `file` accepts a spec or the module it tests (X.luau -> X.spec.luau next to it).
export type RunScope =
  | { kind: 'all' }
  | { kind: 'file'; file: string }
  | { kind: 'files'; files: string[] }
  | { kind: 'name'; name: string; file?: string }

export interface RunRequest {
  scope: RunScope
  // Whole-run limit; the lune process is killed after it. Default 120 000.
  timeoutMs?: number
  // Per-test limit inside the runner. Default 5 000.
  testTimeoutMs?: number
  realm?: Realm
}

export type RunState =
  | 'passed'
  | 'failed'
  | 'error' // the runner could not start or crashed (see message / stderr)
  | 'cancelled'
  | 'timeout'
  | 'no-lune'
  | 'no-tests'
  | 'no-project'

export interface RunSummary {
  id: number
  state: RunState
  passed: number
  failed: number
  skipped: number
  total: number
  ms: number
  files: string[]
  results: TestCaseResult[]
  logs: TestLog[]
  message?: string
  stderr?: string
}

export type LuneStatus =
  | { available: true; path: string; version: string }
  | { available: false; hint: string }

// Streamed while a run is in flight (IPC: tests:progress).
export type TestProgress =
  | { runId: number; kind: 'start'; files: string[] }
  | { runId: number; kind: 'file'; file: string; realm: Realm }
  | { runId: number; kind: 'test'; result: TestCaseResult }
  | { runId: number; kind: 'log'; log: TestLog }
  | { runId: number; kind: 'end'; summary: RunSummary }

export interface CreateSpecResult {
  path: string
  created: boolean
  content: string
  // The module's instance path as the spec requires it, e.g. ReplicatedStorage.Shared.Modules.X
  requirePath: string
}
