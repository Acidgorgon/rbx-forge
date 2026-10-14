import { execFile, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { LogLine, PlaceInfo, ServiceId, ServiceState, ServiceStatus } from '@shared/types'
import { SYNC_ENGINE_SETTING, SYNC_GATE_SETTING, type GateState } from '../../shared/sync/types.ts'
import { findBash, findPowerShell, findTool, run, spawnTool, toolEnv } from './tools.ts'
import { gateAction, isRojoPanic, RestartPolicy, ROJO_STABLE_MS, secondsText, type RestartPolicyOptions } from './rojoRestart.ts'

const isWindows = process.platform === 'win32'
const TEMPLATE_ORIGIN = /github\.com[:/]Acidgorgon\/MyTemplate-Legacy(\.git)?\/?$/i
const HEALTHY_MS = 60_000
const MAX_BACKOFF_MS = 30_000
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

const LABELS: Record<ServiceId, string> = {
  dev: 'Dev loop',
  rojo: 'Rojo',
  lsp: 'Luau LSP',
  studioSync: 'Studio sync'
}

export interface SupervisorOptions {
  log: (line: Omit<LogLine, 'at'>) => void
  onStatus: (statuses: ServiceStatus[]) => void
  getSetting: <T>(key: string, fallback: T) => T
  // Tests: rojo restart backoff / give-up (default rojoRestart.ts constants).
  rojoRestart?: RestartPolicyOptions
}

interface Proc {
  child: ChildProcess | null
  wanted: boolean
  failures: number
  startedAt: number
  retry: ReturnType<typeof setTimeout> | null
  healthy: ReturnType<typeof setTimeout> | null
  // rojo serve held by the Forge Sync gate (wanted, but not spawned until the gate clears).
  held?: boolean
  // rojo procs: restart backoff / give-up (rojoRestart.ts), and whether this run printed a panic.
  policy?: RestartPolicy
  panicked?: boolean
}

type Command = { file: string; args: string[] }

const DEFAULT_PLACE = 'default.project.json'

// One rojo process for the places setup: `rojo serve <file>` per served place, plus
// `rojo sourcemap --watch` for a non-default active place (the dev loop only maps default.project.json).
export interface RojoJob {
  // Proc key: "rojo" for the active place's serve, "rojo:<file>" for the others, "sourcemap:<file>".
  key: string
  place: string
  kind: 'serve' | 'sourcemap'
  args: string[]
  port?: number
}

// What rojo runs for the given places. The active place is always served; with serveAll the other
// places are served too, except when their port is already taken (rojo would fail to bind).
export function rojoJobs(places: PlaceInfo[], active: string | null, serveAll: boolean): { jobs: RojoJob[]; skipped: string[] } {
  const current = places.find((p) => p.file === active) ?? places.find((p) => p.isDefault) ?? places[0]
  if (!current) {
    return { jobs: [{ key: 'rojo', place: DEFAULT_PLACE, kind: 'serve', args: ['serve', DEFAULT_PLACE] }], skipped: [] }
  }
  const serve = (place: PlaceInfo, key: string): RojoJob => ({
    key,
    place: place.file,
    kind: 'serve',
    args: ['serve', place.file, '--port', String(place.servePort)],
    port: place.servePort
  })
  const jobs: RojoJob[] = [serve(current, 'rojo')]
  const skipped: string[] = []
  if (serveAll) {
    const ports = new Set([current.servePort])
    for (const place of places) {
      if (place === current) continue
      if (ports.has(place.servePort)) {
        skipped.push(`${place.file}: port ${place.servePort} is already served by another place; set a servePort in it to serve both.`)
        continue
      }
      ports.add(place.servePort)
      jobs.push(serve(place, `rojo:${place.file}`))
    }
  }
  if (!current.isDefault) {
    jobs.push({
      key: `sourcemap:${current.file}`,
      place: current.file,
      kind: 'sourcemap',
      args: ['sourcemap', current.file, '--output', current.sourcemap, '--watch', '--include-non-scripts']
    })
  }
  return { jobs, skipped }
}

// Forge Sync gate: rojo serve for a place waits while its Studio snapshot is being reconciled
// ('checking') or conflicts are held ('blocked'). 'idle' (no Studio session) and 'clear' serve.
export function gateHolds(gate: GateState | undefined): boolean {
  return gate === 'checking' || gate === 'blocked'
}

export function syncEngineOf(getSetting: <T>(key: string, fallback: T) => T): 'forge' | 'project' | 'off' {
  const engine = getSetting<string>(SYNC_ENGINE_SETTING, 'forge')
  return engine === 'project' || engine === 'off' ? engine : 'forge'
}

export function isTemplateOrigin(url: string): boolean {
  return TEMPLATE_ORIGIN.test(url.trim())
}

// Supervises the dev loop and rojo serve for one project root, and reports lsp and studio sync.
export class Supervisor {
  private options: SupervisorOptions
  private root: string | null = null
  private status: Record<ServiceId, ServiceStatus>
  // "dev", "rojo" (active place) and the extra rojo jobs ("rojo:<file>", "sourcemap:<file>").
  private procs: Record<string, Proc | undefined> = {}
  private places: PlaceInfo[] = []
  private activePlace: string | null = null
  private extraCommands = new Map<string, Command>()
  private probeTimer: ReturnType<typeof setInterval> | null = null
  private lspPath: string | null = null
  // Forge Sync gate per project file (set by the SyncService).
  private gates = new Map<string, { gate: GateState; detail?: string }>()

  constructor(options: SupervisorOptions) {
    this.options = options
    const make = (id: ServiceId): ServiceStatus => ({ id, label: LABELS[id], state: 'stopped', restarts: 0 })
    this.status = { dev: make('dev'), rojo: make('rojo'), lsp: make('lsp'), studioSync: make('studioSync') }
  }

  statuses(): ServiceStatus[] {
    return [this.status.dev, this.status.rojo, this.status.lsp, this.status.studioSync].map((s) => ({ ...s }))
  }

  private update(id: ServiceId, patch: Partial<ServiceStatus>): void {
    const next = { ...this.status[id], ...patch }
    for (const key of Object.keys(patch) as (keyof ServiceStatus)[]) {
      if (patch[key] === undefined) delete next[key]
    }
    if (JSON.stringify(next) === JSON.stringify(this.status[id])) return
    this.status[id] = next
    this.options.onStatus(this.statuses())
  }

  private info(service: ServiceId, text: string): void {
    this.options.log({ service, stream: 'info', text })
  }

  // Switches to a new project (or none). Stops everything for the old one.
  async setRoot(root: string | null): Promise<void> {
    await this.stopAll()
    this.root = root
    this.places = []
    this.activePlace = null
    this.gates.clear()
    for (const id of Object.keys(this.status) as ServiceId[]) {
      this.update(id, { state: 'stopped', restarts: 0, pid: undefined, detail: undefined })
    }
  }

  // Places of the open project and the active one. rojo serves the active place (and, with the
  // serveAllPlaces setting, every other place); a running rojo restarts when this changes it.
  async setPlaces(places: PlaceInfo[], active: string | null): Promise<void> {
    const before = JSON.stringify(this.rojoPlan())
    this.places = places.map((place) => ({ ...place }))
    this.activePlace = active
    if (JSON.stringify(this.rojoPlan()) === before) return
    if (this.procs.rojo?.wanted) await this.restart('rojo')
  }

  private rojoPlan(): ReturnType<typeof rojoJobs> {
    return rojoJobs(this.places, this.activePlace, this.options.getSetting('serveAllPlaces', false))
  }

  async startAll(): Promise<void> {
    await this.start('dev')
    await this.start('rojo')
    await this.start('lsp')
    this.startProbe()
  }

  async start(id: ServiceId): Promise<void> {
    if (!this.root) throw new Error('No project open')
    if (id === 'lsp') return this.checkLsp()
    if (id === 'studioSync') {
      // Forge Sync runs inside Forge (nothing to start); 'off' has nothing to start either.
      if (this.syncEngine() !== 'project') return
      // studio-sync.py is started by the dev loop; starting it means making sure dev runs.
      if (!this.procs.dev?.wanted) await this.start('dev')
      this.startProbe()
      return
    }
    const proc = this.procs[id]
    if (proc?.wanted && proc.child) return
    const command = await this.command(id)
    if (!command) return
    const next: Proc = proc ?? { child: null, wanted: true, failures: 0, startedAt: 0, retry: null, healthy: null }
    next.wanted = true
    next.failures = 0
    next.policy?.reset()
    this.procs[id] = next
    this.update(id, { restarts: 0, gaveUp: undefined })
    this.spawnService(id, id, command)
    if (id === 'rojo') this.startRojoExtras(command.file)
  }

  private startRojoExtras(rojo: string): void {
    const { jobs, skipped } = this.rojoPlan()
    for (const text of skipped) this.info('rojo', text)
    for (const job of jobs) {
      if (job.key === 'rojo') continue
      const command = { file: rojo, args: job.args }
      if (job.kind === 'sourcemap' && this.root) {
        try {
          mkdirSync(dirname(join(this.root, job.args[3])), { recursive: true })
        } catch {
          // rojo reports the write error
        }
      }
      this.extraCommands.set(job.key, command)
      this.procs[job.key] = { child: null, wanted: true, failures: 0, startedAt: 0, retry: null, healthy: null }
      this.spawnService(job.key, 'rojo', command)
    }
  }

  private async stopProc(key: string): Promise<void> {
    const proc = this.procs[key]
    if (!proc) return
    proc.wanted = false
    if (proc.retry) clearTimeout(proc.retry)
    if (proc.healthy) clearTimeout(proc.healthy)
    proc.retry = null
    proc.healthy = null
    proc.held = false
    const child = proc.child
    if (child) await killTree(child)
    proc.child = null
  }

  async stop(id: ServiceId): Promise<void> {
    if (id === 'lsp') {
      this.update('lsp', { state: 'stopped', detail: undefined })
      return
    }
    if (id === 'studioSync') {
      this.info('studioSync', 'Studio sync runs inside the dev loop; stop the dev loop to stop it.')
      return
    }
    if (id === 'rojo') {
      const extras = Object.keys(this.procs).filter((key) => key !== 'rojo' && key !== 'dev')
      await Promise.all(extras.map((key) => this.stopProc(key)))
      for (const key of extras) delete this.procs[key]
      this.extraCommands.clear()
    }
    if (!this.procs[id]) return
    await this.stopProc(id)
    this.update(id, { state: 'stopped', pid: undefined, detail: undefined, hold: undefined, gaveUp: undefined })
  }

  async restart(id: ServiceId): Promise<void> {
    if (id === 'studioSync' && this.syncEngine() !== 'project') return
    if (id === 'studioSync') {
      await this.stop('dev')
      await this.start('dev')
      this.startProbe()
      return
    }
    await this.stop(id)
    await this.start(id)
  }

  async stopAll(): Promise<void> {
    if (this.probeTimer) clearInterval(this.probeTimer)
    this.probeTimer = null
    await Promise.all([this.stop('dev'), this.stop('rojo')])
    this.update('studioSync', { state: 'stopped', detail: undefined })
  }

  // Last-resort cleanup when the process is exiting and async work cannot run.
  killAllSync(): void {
    for (const proc of Object.values(this.procs)) {
      const pid = proc?.child?.pid
      if (!pid) continue
      try {
        if (isWindows) execFileSync(taskkill(), ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        else process.kill(-pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  }

  private syncEngine(): 'forge' | 'project' | 'off' {
    return syncEngineOf(this.options.getSetting)
  }

  private gating(): boolean {
    return this.syncEngine() === 'forge' && this.options.getSetting<boolean>(SYNC_GATE_SETTING, true) !== false
  }

  // The place a rojo serve proc serves ("rojo" = the active place, "rojo:<file>" = another place).
  private servedPlace(key: string): string | null {
    if (key === 'rojo') return this.rojoPlan().jobs[0]?.place ?? null
    if (key.startsWith('rojo:')) return key.slice(5)
    return null
  }

  private holdFor(key: string): { file: string; detail: string } | null {
    if (!this.gating()) return null
    const file = this.servedPlace(key)
    const gate = file ? this.gates.get(file) : undefined
    if (!file || !gate || !gateHolds(gate.gate)) return null
    return { file, detail: gate.detail || (gate.gate === 'blocked' ? 'Studio sync conflicts: resolve or serve anyway' : 'Waiting for Studio sync check') }
  }

  private holdView(file: string): ServiceStatus['hold'] {
    const gate = this.gates.get(file)?.gate
    return gate === 'blocked' || gate === 'checking' ? { gate, file } : undefined
  }

  gateOf(file: string): GateState {
    return this.gates.get(file)?.gate ?? 'idle'
  }

  // Forge Sync gate for one place file. Holding stops a running serve of that place (a new Studio
  // session: stop, reconcile, restart); clearing starts a held one.
  setGate(file: string, gate: GateState, detail?: string): void {
    this.gates.set(file, { gate, detail })
    this.applyGates()
  }

  // Re-checks every rojo serve against the gates (also after the sync settings change).
  applyGates(): void {
    for (const [key, proc] of Object.entries(this.procs)) {
      if (!proc || !proc.wanted || !this.servedPlace(key)) continue
      const hold = this.holdFor(key)
      const action = gateAction({ holds: !!hold, running: !!proc.child, held: !!proc.held })
      if (hold && action === 'stop') {
        this.info('rojo', `${hold.file}: ${hold.detail}; stopping rojo serve until Studio and disk agree`)
        proc.held = true
        if (proc.retry) clearTimeout(proc.retry)
        proc.retry = null
        const child = proc.child as ChildProcess
        proc.child = null
        void killTree(child)
        if (key === 'rojo') this.update('rojo', { state: 'starting', pid: undefined, detail: `${hold.detail} (${hold.file})`, hold: this.holdView(hold.file) })
      } else if (hold && action === 'wait') {
        if (key === 'rojo') this.update('rojo', { detail: `${hold.detail} (${hold.file})`, hold: this.holdView(hold.file) })
      } else if (action === 'start') {
        proc.held = false
        if (key === 'rojo') this.update('rojo', { hold: undefined })
        this.info('rojo', `${this.servedPlace(key)}: Studio sync clear; starting rojo serve`)
        void (async () => {
          const command = key === 'rojo' ? await this.command('rojo') : this.extraCommands.get(key) ?? null
          if (command && proc.wanted && !proc.child && !proc.held) this.spawnService(key, 'rojo', command)
        })()
      }
    }
  }

  // Forge Sync's own summary on the "Studio sync" service row (the old studio-sync.py is not run).
  setSyncSummary(state: ServiceState, detail: string): void {
    if (this.syncEngine() !== 'forge') return
    this.update('studioSync', { state, detail })
  }

  // Spawns `luau-lsp lsp <args>` over stdio for the editor bridge (lspBridge.ts). Not supervised;
  // the caller owns the process. `lsp` takes no --sourcemap flag: the sourcemap is an LSP setting.
  spawnLsp(args: string[] = []): ChildProcess | null {
    if (!this.root) return null
    const lsp = this.lspPath || findTool('luau-lsp')
    if (!lsp) return null
    return spawnTool(lsp, ['lsp', ...args], {
      cwd: this.root,
      env: toolEnv(),
      stdio: ['pipe', 'pipe', 'pipe']
    })
  }

  private async checkLsp(): Promise<void> {
    this.lspPath = findTool('luau-lsp')
    if (!this.lspPath) {
      this.update('lsp', { state: 'missing', detail: 'luau-lsp not found. Run rokit install (or add luau-lsp to rokit.toml).' })
      return
    }
    const version = await run(this.lspPath, ['--version'], this.root || process.cwd())
    const text = (version.stdout || version.stderr).trim().split('\n')[0]
    this.update('lsp', { state: 'running', detail: text ? `luau-lsp ${text.replace(/^luau-lsp\s*/i, '')}` : 'luau-lsp' })
  }

  private async command(id: 'dev' | 'rojo'): Promise<Command | null> {
    const root = this.root as string
    if (id === 'rojo') {
      const rojo = findTool('rojo')
      if (!rojo) {
        this.update('rojo', { state: 'missing', detail: 'rojo not found. Run rokit install.' })
        return null
      }
      return { file: rojo, args: this.rojoPlan().jobs[0].args }
    }
    const blocked = await this.templateGuard(root)
    if (blocked) {
      this.update('dev', { state: 'stopped', detail: blocked })
      this.info('dev', blocked)
      return null
    }
    if (!existsSync(join(root, 'Packages', 'Janitor.lua')) && !findTool('wally')) {
      this.update('dev', { state: 'missing', detail: 'wally not found. Run rokit install.' })
      return null
    }
    const dev = devCommand(root, process.platform, existsSync)
    if ('missing' in dev) {
      this.update('dev', { state: 'missing', detail: dev.missing })
      return null
    }
    return dev
  }

  // dev.sh deletes .git when origin is the template repo and .keep-git is missing. Do not let that happen silently.
  private async templateGuard(root: string): Promise<string | null> {
    if (this.options.getSetting('allowTemplateDisconnect', false)) return null
    if (existsSync(join(root, '.keep-git')) || !existsSync(join(root, '.git'))) return null
    const git = findTool('git')
    if (!git) return null
    const origin = await run(git, ['remote', 'get-url', 'origin'], root)
    if (origin.code !== 0 || !isTemplateOrigin(origin.stdout)) return null
    return (
      'Not started: this folder is still the MyTemplate-Legacy git repo, and ./dev would delete its .git. ' +
      'Add a .keep-git file to keep it (template maintenance), or allow the disconnect in settings.'
    )
  }

  // key is the proc ("dev", "rojo", or an extra rojo job); id is the service it reports under.
  // Only the "dev" and "rojo" procs drive the service status; extra jobs just log and restart.
  private spawnService(key: string, id: 'dev' | 'rojo', command: Command): void {
    const proc = this.procs[key] as Proc
    const primary = key === id
    const update = (patch: Partial<ServiceStatus>) => {
      if (primary) this.update(id, patch)
    }
    const hold = id === 'rojo' ? this.holdFor(key) : null
    if (hold) {
      proc.held = true
      update({ state: 'starting', pid: undefined, detail: `${hold.detail} (${hold.file})`, hold: this.holdView(hold.file) })
      this.info('rojo', `${hold.file}: ${hold.detail}; rojo serve waits`)
      return
    }
    update({ state: 'starting', detail: undefined, pid: undefined, hold: undefined, gaveUp: undefined })
    this.info(id, `$ ${[command.file, ...command.args].join(' ')}`)
    if (id === 'rojo') proc.policy ??= new RestartPolicy(this.options.rojoRestart)
    let child: ChildProcess
    try {
      child = spawnTool(command.file, command.args, {
        cwd: this.root as string,
        // FORGE_SYNC=1 tells the project's dev script to skip studio-sync.py and its plugin copy.
        env: key === 'dev' && this.syncEngine() === 'forge' ? { ...toolEnv(), FORGE_SYNC: '1' } : toolEnv(),
        // Own process group on mac/linux so killTree can stop everything ./dev started.
        detached: !isWindows,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      update({ state: 'crashed', detail: String(error) })
      if (!primary) this.info(id, `${key}: ${error}`)
      return
    }
    proc.child = child
    proc.startedAt = Date.now()
    proc.panicked = false
    proc.policy?.started(proc.startedAt)
    let lastLine = ''
    const onText = (stream: 'stdout' | 'stderr') => {
      let buffer = ''
      return (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const raw of lines) {
          const text = raw.replace(ANSI, '')
          if (!text.trim()) continue
          lastLine = text.trim()
          this.options.log({ service: id, stream, text: primary ? text : `[${key.replace(/^rojo:/, '')}] ${text}` })
          if (primary && id === 'rojo') this.parseRojo(text)
          if (id === 'rojo' && !proc.panicked && isRojoPanic(text)) this.onRojoPanic(key, proc, child)
        }
      }
    }
    child.stdout?.on('data', onText('stdout'))
    child.stderr?.on('data', onText('stderr'))
    child.on('spawn', () => {
      update({ state: 'running', pid: child.pid })
      proc.healthy = setTimeout(() => {
        proc.failures = 0
        proc.policy?.stable()
      }, proc.policy ? this.options.rojoRestart?.stableMs ?? ROJO_STABLE_MS : HEALTHY_MS)
    })
    let done = false
    const onExit = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (done) return
      done = true
      if (proc.healthy) clearTimeout(proc.healthy)
      proc.healthy = null
      // Already detached on purpose (a gate hold stopped it, maybe started a new one): not a crash.
      const superseded = proc.child !== child
      if (!superseded) proc.child = null
      if (!proc.wanted || proc.held || superseded) return
      const reason = proc.panicked ? 'panicked' : error ? error.message : signal ? `killed by ${signal}` : `exited with code ${code}`
      if (proc.policy) return this.onRojoExit(key, proc, reason, lastLine)
      if (Date.now() - proc.startedAt >= HEALTHY_MS) proc.failures = 0
      const delay = Math.min(1000 * 2 ** proc.failures, MAX_BACKOFF_MS)
      proc.failures++
      if (primary) {
        const restarts = this.status[id].restarts + 1
        this.update(id, {
          state: 'crashed',
          pid: undefined,
          restarts,
          detail: `${reason}${lastLine ? `: ${lastLine}` : ''}. Restarting in ${Math.round(delay / 1000)}s`
        })
      }
      this.options.log({ service: id, stream: 'info', text: `${primary ? '' : `${key}: `}${reason}; restarting in ${Math.round(delay / 1000)}s` })
      proc.retry = setTimeout(async () => {
        proc.retry = null
        if (!proc.wanted || !this.root) return
        const next = primary ? await this.command(id) : this.extraCommands.get(key) ?? null
        if (next && proc.wanted) this.spawnService(key, id, next)
      }, delay)
    }
    child.on('error', (error) => onExit(null, null, error))
    child.on('exit', (code, signal) => onExit(code, signal))
  }

  // rojo printed a panic. It may stay up with a dead change processor (Studio then gets WebSocket
  // errors), so stop it; the exit handler restarts it.
  private onRojoPanic(key: string, proc: Proc, child: ChildProcess): void {
    proc.panicked = true
    this.info('rojo', `${key === 'rojo' ? '' : `${key}: `}rojo panicked (usually a folder deleted or renamed while serving); restarting it`)
    setTimeout(() => {
      if (proc.child === child) void killTree(child, 1000)
    }, 250)
  }

  // A rojo serve (or rojo sourcemap) exited unexpectedly: restart with backoff, or give up after
  // several quick crashes in a row and wait for the user's Restart.
  private onRojoExit(key: string, proc: Proc, reason: string, lastLine: string): void {
    const primary = key === 'rojo'
    const decision = (proc.policy as RestartPolicy).failed(Date.now())
    const label = primary ? '' : `${key}: `
    if (decision.action === 'give-up') {
      const detail = `Rojo keeps crashing (${decision.failures} restarts did not help): ${reason}${lastLine ? `: ${lastLine}` : ''}. Restart to try again`
      if (primary) this.update('rojo', { state: 'crashed', pid: undefined, detail, gaveUp: true })
      this.options.log({ service: 'rojo', stream: 'stderr', text: `${label}rojo ${reason} ${decision.failures + 1} times in a row; not restarting again. Use Restart.` })
      return
    }
    if (primary) {
      this.update('rojo', {
        state: 'crashed',
        pid: undefined,
        restarts: this.status.rojo.restarts + 1,
        detail: `Rojo ${reason === 'panicked' ? 'crashed (panic)' : reason}${lastLine ? `: ${lastLine}` : ''}. Restarting in ${secondsText(decision.delayMs)}`
      })
    }
    this.options.log({ service: 'rojo', stream: 'info', text: `${label}rojo ${reason}; restarting in ${secondsText(decision.delayMs)} (attempt ${decision.attempt})` })
    proc.retry = setTimeout(async () => {
      proc.retry = null
      if (!proc.wanted || proc.held || !this.root) return
      const next = primary ? await this.command('rojo') : this.extraCommands.get(key) ?? null
      if (next && proc.wanted && !proc.child && !proc.held) this.spawnService(key, 'rojo', next)
    }, decision.delayMs)
  }

  // Stops rojo serve for a Forge file operation (RojoPause); false when it was not running.
  async pauseRojo(reason: string): Promise<boolean> {
    // Only a running rojo can trip; a held or stopped one stays as it is.
    const running = Object.entries(this.procs).some(([key, proc]) => key !== 'dev' && proc?.wanted && proc.child)
    if (!this.root || !this.procs.rojo?.wanted || !running) return false
    this.info('rojo', `Stopping rojo serve during a ${reason} (rojo can crash on folders that vanish while it serves)`)
    await this.stop('rojo')
    this.update('rojo', { state: 'starting', detail: `Paused for a ${reason}` })
    return true
  }

  async resumeRojo(): Promise<void> {
    if (!this.root || this.procs.rojo?.wanted) return
    await this.start('rojo')
  }

  private parseRojo(text: string): void {
    const match = /Port:\s*(\d+)/i.exec(text) || /localhost:(\d+)/i.exec(text)
    if (!match) return
    const place = this.places.find((p) => p.file === this.activePlace)
    const extra = Object.keys(this.procs).filter((key) => key.startsWith('rojo:') && this.procs[key]?.wanted).length
    const label = place && !place.isDefault ? ` (${place.name})` : ''
    this.update('rojo', { detail: `rojo serve on :${match[1]}${label}${extra ? ` + ${extra} more place${extra === 1 ? '' : 's'}` : ''}` })
  }

  private studioSyncPort(): number {
    try {
      const settings = JSON.parse(readFileSync(join(this.root as string, 'tools', 'studio-sync.json'), 'utf8'))
      return Number(settings.port) || 34873
    } catch {
      return 34873
    }
  }

  private startProbe(): void {
    if (this.probeTimer) return
    void this.probe()
    this.probeTimer = setInterval(() => void this.probe(), 3000)
  }

  private async probe(): Promise<void> {
    if (!this.root) return
    const engine = this.syncEngine()
    if (engine === 'off') {
      this.update('studioSync', { state: 'stopped', detail: 'off (Settings > Sync)' })
      return
    }
    // Forge Sync reports through setSyncSummary; studio-sync.py is not needed.
    if (engine === 'forge') {
      if (this.status.studioSync.state === 'stopped' && !this.status.studioSync.detail) this.update('studioSync', { state: 'running', detail: 'Forge Sync (built in)' })
      return
    }
    const port = this.studioSyncPort()
    let ok = false
    try {
      const response = await fetch(`http://127.0.0.1:${port}/config`, { signal: AbortSignal.timeout(1500) })
      ok = response.ok
    } catch {
      ok = false
    }
    if (ok) {
      this.update('studioSync', { state: 'running', detail: `listening on :${port}` })
    } else if (this.status.dev.state === 'running' || this.status.dev.state === 'starting') {
      this.update('studioSync', { state: 'starting', detail: `waiting for :${port} (started by the dev loop; needs Python 3)` })
    } else {
      this.update('studioSync', { state: 'stopped', detail: 'starts with the dev loop' })
    }
  }
}

// taskkill by full path: a GUI app's PATH can lack System32 entries, and a PATH entry could shadow it.
function taskkill(): string {
  return join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'taskkill.exe')
}

// The dev loop command for a project root: tools/dev.ps1 under PowerShell on Windows (Git Bash for
// ./dev when there is no dev.ps1), ./dev (or tools/dev.sh) under bash elsewhere.
export function devCommand(
  root: string,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
  locate: { powershell: () => string; bash: () => string | null } = { powershell: findPowerShell, bash: findBash }
): Command | { missing: string } {
  const has = (rel: string) => exists(join(root, rel))
  if (platform === 'win32') {
    if (has(join('tools', 'dev.ps1'))) {
      return { file: locate.powershell(), args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join('tools', 'dev.ps1')] }
    }
    const script = has('dev') ? './dev' : has(join('tools', 'dev.sh')) ? 'tools/dev.sh' : null
    if (!script) return { missing: 'tools/dev.ps1 not found in this project.' }
    const bash = locate.bash()
    if (!bash) return { missing: 'tools/dev.ps1 not found, and Git Bash is not installed to run ./dev.' }
    return { file: bash, args: [script] }
  }
  const bash = locate.bash()
  if (!bash) return { missing: 'bash not found.' }
  return { file: bash, args: [has('dev') ? './dev' : 'tools/dev.sh'] }
}

// Stops a child and everything it started: the process group on mac/linux, taskkill /T on Windows.
export function killTree(child: ChildProcess, graceMs = 3000): Promise<void> {
  const pid = child.pid
  if (!pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(force)
      resolve()
    }
    child.once('exit', finish)
    if (isWindows) {
      execFile(taskkill(), ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
    } else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    }
    const force = setTimeout(() => {
      try {
        if (isWindows) execFile(taskkill(), ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
        else process.kill(-pid, 'SIGKILL')
      } catch {
        // already gone
      }
      setTimeout(resolve, 500)
    }, graceMs)
  })
}
