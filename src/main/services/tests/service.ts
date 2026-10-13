// TestService: runs *.spec.luau files headless with Lune for the open project.
//
//   lune run <resources/lune/runner.luau> -- --sourcemap <tmp> --format json [--spec f]... [--name n]
//
// cwd is the project root. The instance tree is rebuilt from default.project.json for each run and
// handed to the runner as a temp sourcemap, so a spec saved a moment ago is already mapped. Results
// stream as TestProgress events; one run at a time (a new run cancels the one in flight).

import type { ChildProcess } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnTool, toolEnv, toRepoPath } from '../tools.ts'
import { findRuntimeDir, luneStatus, RUNNER_FILE } from './lune.ts'
import { EventStream, ResultCollector } from './protocol.ts'
import { buildSourcemap, discoverSpecs, isSpecFile, scriptFiles, type SourcemapNode } from './rojoTree.ts'
import { createSpec, specPathFor } from './scaffold.ts'
import type { CreateSpecResult, LuneStatus, RunRequest, RunSummary, SpecFile, TestLog, TestProgress } from './types.ts'

const DEFAULT_RUN_TIMEOUT_MS = 120_000
const DEFAULT_TEST_TIMEOUT_MS = 5_000
const MAX_LOGS = 500
const MAX_STDERR = 8_000
const WATCH_DEBOUNCE_MS = 300

export interface TestServiceOptions {
  onProgress?: (event: TestProgress) => void
  // Harness log sink (service 'tests' in the logs panel).
  log?: (text: string, stream?: 'info' | 'stderr') => void
  // Explicit lune binary (setting tests.lunePath); else rokit/PATH lookup.
  lunePath?: () => string | null | undefined
  // resources/lune; else found next to the app (see lune.ts).
  runtimeDir?: string
}

interface ActiveRun {
  id: number
  child: ChildProcess
  reason: 'cancelled' | 'timeout' | null
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Specs a change to `changed` (repo-relative) should rerun: a changed spec itself; a module's own
// X.spec.luau; and every spec whose source mentions the module's instance name as a word (how GenTree
// specs require: ...Modules.X / script.Parent.X). A change under Packages/ reruns everything.
export function affectedSpecs(
  changed: string[],
  specs: SpecFile[],
  moduleNames: Map<string, string>,
  specSources: Map<string, string>
): string[] {
  const out = new Set<string>()
  for (const file of changed) {
    if (/^(Server)?Packages\//.test(file)) return specs.map((s) => s.file)
    if (isSpecFile(file)) {
      if (specs.some((s) => s.file === file)) out.add(file)
      continue
    }
    const own = specPathFor(file)
    if (specs.some((s) => s.file === own)) out.add(own)
    const name = moduleNames.get(file)
    if (!name) continue
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(name)}([^A-Za-z0-9_]|$)`)
    for (const spec of specs) {
      const source = specSources.get(spec.file)
      if (source && pattern.test(source)) out.add(spec.file)
    }
  }
  return [...out].sort()
}

export class TestService {
  private options: TestServiceOptions
  private root: string | null = null
  private active: ActiveRun | null = null
  private nextId = 1
  private watcher: FSWatcher | null = null
  private watchTimer: ReturnType<typeof setTimeout> | null = null
  private pending = new Set<string>()
  private lastSummary: RunSummary | null = null

  constructor(options: TestServiceOptions = {}) {
    this.options = options
  }

  setRoot(root: string | null): void {
    this.stopWatch()
    this.cancel()
    this.root = root
    this.lastSummary = null
  }

  last(): RunSummary | null {
    return this.lastSummary
  }

  running(): boolean {
    return this.active !== null
  }

  async status(): Promise<LuneStatus> {
    return luneStatus(this.options.lunePath?.(), this.root ?? process.cwd())
  }

  async discover(): Promise<SpecFile[]> {
    if (!this.root) return []
    return discoverSpecs(await buildSourcemap(this.root))
  }

  async createSpec(modulePath: string): Promise<CreateSpecResult> {
    if (!this.root) throw new Error('No project open')
    return createSpec(this.root, modulePath)
  }

  // Kills the run in flight, if any. Its run() resolves with state 'cancelled'.
  cancel(): boolean {
    const active = this.active
    if (!active) return false
    active.reason = 'cancelled'
    active.child.kill()
    return true
  }

  async run(request: RunRequest = { scope: { kind: 'all' } }): Promise<RunSummary> {
    this.cancel()
    const id = this.nextId++
    const started = Date.now()
    const base = (state: RunSummary['state'], message: string): RunSummary => ({
      id, state, message, passed: 0, failed: 0, skipped: 0, total: 0, ms: 0, files: [], results: [], logs: []
    })
    const root = this.root
    if (!root) return this.finish(base('no-project', 'No project open.'))
    const lune = await this.status()
    if (!lune.available) return this.finish(base('no-lune', lune.hint))
    const runtimeDir = this.options.runtimeDir ?? findRuntimeDir()
    if (!runtimeDir) return this.finish(base('error', 'The Lune test runtime (resources/lune/runner.luau) is missing from this build.'))

    let tree: SourcemapNode
    try {
      tree = await buildSourcemap(root)
    } catch (error) {
      return this.finish(base('error', (error as Error).message))
    }
    const specs = discoverSpecs(tree)
    const selection = this.select(request, specs)
    if (typeof selection === 'string') return this.finish(base('no-tests', selection))

    const mapFile = join(tmpdir(), `rbx-forge-sourcemap-${process.pid}-${id}.json`)
    await writeFile(mapFile, JSON.stringify(tree))
    const args = ['run', join(runtimeDir, RUNNER_FILE), '--', '--sourcemap', mapFile, '--format', 'json']
    args.push('--timeout', String(request.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS))
    if (request.realm) args.push('--realm', request.realm)
    for (const file of selection.files) args.push('--spec', file)
    if (selection.name) args.push('--name', selection.name)

    const collector = new ResultCollector()
    const stream = new EventStream()
    let stderr = ''
    const emit = (event: TestProgress) => this.options.onProgress?.(event)
    this.options.log?.(`lune ${lune.version}: ${selection.label}`)

    const child = spawnTool(lune.path, args, { cwd: root, env: toolEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    const active: ActiveRun = { id, child, reason: null }
    this.active = active
    const timer = setTimeout(() => {
      active.reason = 'timeout'
      child.kill()
    }, request.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS)

    const handle = (items: ReturnType<EventStream['push']>) => {
      for (const item of items) {
        collector.add(item)
        if ('output' in item) {
          emit({ runId: id, kind: 'log', log: { level: 'output', text: item.output } })
          continue
        }
        const event = item.event
        if (event.type === 'start') emit({ runId: id, kind: 'start', files: event.files })
        else if (event.type === 'file') emit({ runId: id, kind: 'file', file: event.file, realm: event.realm })
        else if (event.type === 'test') emit({ runId: id, kind: 'test', result: collector.results[collector.results.length - 1] })
        else if (event.type === 'log') emit({ runId: id, kind: 'log', log: collector.logs[collector.logs.length - 1] })
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => handle(stream.push(chunk)))
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR)
    })

    const code = await new Promise<number | null>((resolve) => {
      child.on('error', (error) => {
        stderr += `\n${error.message}`
        resolve(null)
      })
      child.on('close', (exitCode) => resolve(exitCode))
    })
    clearTimeout(timer)
    handle(stream.flush())
    if (this.active === active) this.active = null
    await rm(mapFile, { force: true }).catch(() => undefined)

    const counts = collector.counts()
    const logs: TestLog[] = collector.logs.slice(-MAX_LOGS)
    const summary: RunSummary = {
      id,
      state: 'passed',
      ...counts,
      ms: collector.ended?.ms ?? Date.now() - started,
      files: collector.files.length ? collector.files : selection.files,
      results: collector.results,
      logs
    }
    if (active.reason === 'cancelled') {
      summary.state = 'cancelled'
      summary.message = 'Run cancelled.'
    } else if (active.reason === 'timeout') {
      summary.state = 'timeout'
      summary.message = `Run stopped after ${Math.round((request.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS) / 1000)} s (a test may loop without yielding).`
    } else if (collector.fatal) {
      summary.state = 'error'
      summary.message = collector.fatal
    } else if (!collector.ended) {
      summary.state = 'error'
      summary.message = `lune exited (code ${code}) before the run finished.`
    } else {
      summary.state = counts.failed > 0 ? 'failed' : 'passed'
    }
    if (stderr.trim()) summary.stderr = stderr
    return this.finish(summary)
  }

  private finish(summary: RunSummary): RunSummary {
    this.lastSummary = summary
    this.options.onProgress?.({ runId: summary.id, kind: 'end', summary })
    return summary
  }

  // Resolves a scope to spec files (empty list = runner discovers all) and an optional name filter,
  // or returns a message when nothing matches.
  private select(request: RunRequest, specs: SpecFile[]): { files: string[]; name?: string; label: string } | string {
    const scope = request.scope
    const known = new Set(specs.map((s) => s.file))
    const noSpecs =
      'No *.spec.luau files found. Create one next to a module (create_spec / "New spec"), or put specs in a top-level tests/ folder.'
    if (specs.length === 0) return noSpecs
    const resolveFile = (file: string): string | null => {
      const path = toRepoPath(file)
      if (known.has(path)) return path
      if (!isSpecFile(path)) {
        const spec = specPathFor(path)
        if (known.has(spec)) return spec
      }
      return null
    }
    switch (scope.kind) {
      case 'all':
        return { files: [], label: `all ${specs.length} spec file(s)` }
      case 'file': {
        const file = resolveFile(scope.file)
        if (!file) return `No spec for ${scope.file}. Spec files: ${specs.slice(0, 10).map((s) => s.file).join(', ')}`
        return { files: [file], label: file }
      }
      case 'files': {
        const files = scope.files.map(resolveFile).filter((f): f is string => !!f)
        if (files.length === 0) return 'None of the changed files have specs.'
        return { files, label: files.join(', ') }
      }
      case 'name': {
        if (scope.file) {
          const file = resolveFile(scope.file)
          if (!file) return `No spec for ${scope.file}.`
          return { files: [file], name: scope.name, label: `"${scope.name}" in ${file}` }
        }
        return { files: [], name: scope.name, label: `"${scope.name}"` }
      }
    }
  }

  // Watch mode: reruns the specs affected by each save (debounced). onResult gets each summary.
  startWatch(onResult?: (summary: RunSummary) => void): void {
    const root = this.root
    if (!root || this.watcher) return
    this.watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const file = toRepoPath(String(filename))
      if (!/\.(luau|lua)$/.test(file) || /(^|\/)(node_modules|\.git|\.studio-sync)\//.test(file)) return
      this.pending.add(file)
      if (this.watchTimer) clearTimeout(this.watchTimer)
      this.watchTimer = setTimeout(() => void this.flushWatch(onResult), WATCH_DEBOUNCE_MS)
    })
    this.watcher.on('error', (error) => this.options.log?.(`test watch stopped: ${error.message}`, 'stderr'))
  }

  stopWatch(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer)
    this.watchTimer = null
    this.pending.clear()
    this.watcher?.close()
    this.watcher = null
  }

  watching(): boolean {
    return this.watcher !== null
  }

  private async flushWatch(onResult?: (summary: RunSummary) => void): Promise<void> {
    const root = this.root
    const changed = [...this.pending]
    this.pending.clear()
    if (!root || changed.length === 0) return
    const tree = await buildSourcemap(root).catch(() => null)
    if (!tree) return
    const specs = discoverSpecs(tree)
    const sources = new Map<string, string>()
    await Promise.all(
      specs.map(async (s) => sources.set(s.file, await readFile(join(root, ...s.file.split('/')), 'utf8').catch(() => '')))
    )
    const files = affectedSpecs(changed, specs, scriptFiles(tree), sources)
    if (files.length === 0) return
    const summary = await this.run({ scope: { kind: 'files', files } })
    onResult?.(summary)
  }
}
