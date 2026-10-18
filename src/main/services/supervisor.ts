import { execFile, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { LogLine, PlaceInfo, RojoPlaceStatus, ServiceId, ServiceState, ServiceStatus } from '@shared/types'
import { SYNC_ENGINE_SETTING, SYNC_GATE_SETTING, type GateState, type RojoServeState, type WaitReason } from '../../shared/sync/types.ts'
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
  // A place's serve state or its "reconnect Rojo in Studio" notice changed (Forge Sync re-reads them).
  onRojoChange?: () => void
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
  // rojo serve: the running child printed its port (Studio's Rojo plugin can be connected to it).
  listening?: boolean
  // rojo procs: the last error line (a crash, the port being taken), and gave up restarting.
  lastError?: string
  gaveUp?: boolean
  // Stopped by pausePlace (a file Forge writes for that place); resumePlace starts it again.
  paused?: boolean
}

// rojo's "address in use" bind error (Linux os error 98, macOS 48, Windows 10048).
const ADDRESS_IN_USE = /address already in use|os error (98|48|10048)\b|only one usage of each socket address/i

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

// Forge Sync gate: rojo serve for a place waits while no Studio check has cleared it ('waiting':
// Studio not open, the open place not linked, or an old plugin), while its Studio snapshot is being
// reconciled ('checking') and while conflicts or Studio-only scripts are held ('blocked'). 'clear'
// serves, and so does 'idle' (Forge Sync not gating, or the user chose "Serve without Studio check").
export function gateHolds(gate: GateState | undefined): boolean {
  return gate === 'checking' || gate === 'blocked' || gate === 'waiting'
}

const WAITING_DETAIL = "Waiting for Studio's first sync check"


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
  private gates = new Map<string, { gate: GateState; detail?: string; reason?: WaitReason }>()
  // Place files whose listening rojo serve stopped while the project stayed open (a gate hold, a
  // pause, a crash, a restart): Studio's Rojo plugin lost it and does not reconnect by itself. When the
  // serve listens again the file moves to `reconnect` (the "click Connect in Rojo" notice).
  private cut = new Set<string>()
  private reconnect = new Map<string, { port: number; at: number }>()
  private closing = false

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
    this.cut.clear()
    this.reconnect.clear()
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
    if (this.procs.rojo?.wanted) await this.restart('rojo', 'the served places changed')
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
    if (proc?.wanted && proc.child) {
      // The active place serves: still bring up the other places' serves that are not running
      // (crashed and gave up, never started), without touching the ones that are.
      if (id === 'rojo') {
        const command = await this.command('rojo')
        if (command) await this.startRojoExtras(command.file)
      }
      return
    }
    const command = await this.command(id)
    if (!command) return
    const next: Proc = proc ?? { child: null, wanted: true, failures: 0, startedAt: 0, retry: null, healthy: null }
    // A pending crash restart would spawn a second child next to this one.
    if (next.retry) clearTimeout(next.retry)
    next.retry = null
    next.wanted = true
    next.failures = 0
    next.gaveUp = false
    next.lastError = undefined
    next.paused = false
    next.policy?.reset()
    this.procs[id] = next
    this.update(id, { restarts: 0, gaveUp: undefined })
    this.spawnService(id, id, command)
    if (id === 'rojo') await this.startRojoExtras(command.file)
    this.placesChanged()
  }

  // The other places' serves (and a non-default place's sourcemap watch). One that already runs the
  // same command (or is held, or about to restart) is kept; any other is stopped before it is
  // replaced. Before, a second Start replaced the proc and left its rojo running unsupervised on the
  // port, and the new one crash-looped on "address in use".
  private async startRojoExtras(rojo: string): Promise<void> {
    const { jobs, skipped } = this.rojoPlan()
    for (const text of skipped) this.info('rojo', text)
    const planned = new Set(jobs.map((job) => job.key))
    for (const key of Object.keys(this.procs)) {
      if (key === 'rojo' || key === 'dev' || planned.has(key)) continue
      await this.stopProc(key, 'its place is no longer served')
      delete this.procs[key]
      this.extraCommands.delete(key)
    }
    for (const job of jobs) {
      if (job.key === 'rojo') continue
      const command = { file: rojo, args: job.args }
      const old = this.procs[job.key]
      const same = JSON.stringify(this.extraCommands.get(job.key)) === JSON.stringify(command)
      if (old?.wanted && same && !old.gaveUp && (old.child || old.held || old.retry)) continue
      if (old) await this.stopProc(job.key, old.gaveUp ? 'it gave up after crashing; starting it again' : 'it is started again')
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

  // "rojo:menu.project.json" for a serve (the active place's too), the key otherwise.
  private procName(key: string): string {
    return key === 'rojo' ? `rojo:${this.servedPlace('rojo') ?? DEFAULT_PLACE}` : key
  }

  // Every rojo stop goes through here or applyGates, and says why in the output panel.
  private async stopProc(key: string, why = 'it was stopped'): Promise<void> {
    const proc = this.procs[key]
    if (!proc) return
    if (proc.child && key !== 'dev') this.options.log({ service: 'rojo', stream: 'info', text: `stopping ${this.procName(key)} because ${why}` })
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

  async stop(id: ServiceId, why = 'you stopped it'): Promise<void> {
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
      await Promise.all(extras.map((key) => this.stopProc(key, why)))
      for (const key of extras) delete this.procs[key]
      this.extraCommands.clear()
    }
    if (!this.procs[id]) return
    await this.stopProc(id, why)
    this.update(id, { state: 'stopped', pid: undefined, detail: undefined, hold: undefined, gaveUp: undefined, places: undefined })
    this.placesChanged()
  }

  async restart(id: ServiceId, why = 'a restart was asked for'): Promise<void> {
    if (id === 'studioSync' && this.syncEngine() !== 'project') return
    if (id === 'studioSync') {
      await this.stop('dev')
      await this.start('dev')
      this.startProbe()
      return
    }
    await this.stop(id, why)
    await this.start(id)
  }

  async stopAll(): Promise<void> {
    if (this.probeTimer) clearInterval(this.probeTimer)
    this.probeTimer = null
    // The project closes: no "reconnect Rojo" notice for serves that end with it.
    this.closing = true
    try {
      await Promise.all([this.stop('dev', 'the project closed'), this.stop('rojo', 'the project closed')])
    } finally {
      this.closing = false
    }
    this.cut.clear()
    this.reconnect.clear()
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
    return { file, detail: gate.detail || (gate.gate === 'blocked' ? 'Studio sync conflicts: resolve or serve anyway' : gate.gate === 'waiting' ? WAITING_DETAIL : 'Waiting for Studio sync check') }
  }

  private holdView(file: string): ServiceStatus['hold'] {
    const g = this.gates.get(file)
    if (!g || !gateHolds(g.gate)) return undefined
    return g.gate === 'waiting' ? { gate: 'waiting', file, reason: g.reason ?? 'studio' } : { gate: g.gate as 'checking' | 'blocked', file }
  }

  // rojo serve for one place file: running (or coming up), held by the Forge Sync gate, or not
  // running (not the active place with "Serve all places" off, stopped, or paused).
  // A serve that crashed and gave up (or failed to start) is not serving.
  rojoState(file: string): RojoServeState {
    let held = false
    for (const [key, proc] of Object.entries(this.procs)) {
      if (!proc?.wanted || this.servedPlace(key) !== file) continue
      if (proc.held) held = true
      else if (proc.child || proc.retry) return 'serving'
    }
    return held ? 'held' : 'stopped'
  }

  // Each served place's own state, when more than one place is served (ServiceStatus.places).
  rojoPlaces(): RojoPlaceStatus[] {
    const plan = this.rojoPlan().jobs
    const out: RojoPlaceStatus[] = []
    for (const [key, proc] of Object.entries(this.procs)) {
      const file = this.servedPlace(key)
      if (!proc || !file) continue
      const job = plan.find((j) => j.key === key)
      const gate = this.gates.get(file)?.gate
      const state: RojoPlaceStatus['state'] = !proc.wanted
        ? 'stopped'
        : proc.held
          ? gate === 'checking' ? 'checking' : gate === 'waiting' ? 'waiting' : 'held'
          : proc.gaveUp
            ? 'gave-up'
            : proc.child
              ? proc.listening ? 'serving' : 'starting'
              : proc.retry ? 'crashed' : 'stopped'
      const name = this.places.find((p) => p.file === file)?.name ?? file.replace(/\.project\.json$/, '')
      out.push({
        file,
        name,
        ...(job?.port ? { port: job.port } : {}),
        primary: key === 'rojo',
        state,
        ...(proc.lastError && state !== 'serving' ? { error: proc.lastError } : {}),
        ...(this.reconnect.has(file) ? { reconnect: true } : {})
      })
    }
    return out.sort((a, b) => Number(b.primary) - Number(a.primary) || a.file.localeCompare(b.file))
  }

  // Pushes the per-place list onto the rojo row (only with other places served next to the active one).
  private placesChanged(): void {
    const places = this.rojoPlaces()
    this.update('rojo', { places: places.length > 1 ? places : undefined })
    this.options.onRojoChange?.()
  }

  // The "click Connect in Rojo" notice for a place file (see `cut`), and taking it back once Studio
  // shows Rojo is connected again (or the user says so).
  rojoReconnect(file: string): { port: number; at: number } | null {
    return this.reconnect.get(file) ?? null
  }

  clearRojoReconnect(file: string): void {
    if (!this.reconnect.delete(file)) return
    this.info('rojo', `${file}: Rojo is connected in Studio again`)
    this.placesChanged()
  }

  // Our rojo serve children (pids), and whether a serve of ours is up on this port right now.
  servesPort(port: number): boolean {
    return this.rojoPlan().jobs.some((job) => job.port === port && !!this.procs[job.key]?.child)
  }

  gateOf(file: string): GateState {
    return this.gates.get(file)?.gate ?? 'idle'
  }

  // Forge Sync gate for one place file. Holding stops a running serve of that place (a new Studio
  // session: stop, reconcile, restart); clearing starts a held one.
  setGate(file: string, gate: GateState, detail?: string, reason?: WaitReason): void {
    this.gates.set(file, { gate, detail, ...(gate === 'waiting' && reason ? { reason } : {}) })
    this.applyGates()
    this.placesChanged()
  }

  // Re-checks every rojo serve against the gates (also after the sync settings change).
  applyGates(): void {
    for (const [key, proc] of Object.entries(this.procs)) {
      if (!proc || !proc.wanted || !this.servedPlace(key)) continue
      const hold = this.holdFor(key)
      const action = gateAction({ holds: !!hold, running: !!proc.child, held: !!proc.held })
      if (hold && action === 'stop') {
        this.info('rojo', `stopping ${this.procName(key)} because ${hold.file} is held (${hold.detail}); it starts again when Studio and disk agree`)
        proc.held = true
        if (proc.retry) clearTimeout(proc.retry)
        proc.retry = null
        const child = proc.child as ChildProcess
        // Detached now, so its exit counts as superseded: mark the cut here, before a new serve can listen.
        if (proc.listening) this.markCut(key)
        proc.child = null
        proc.listening = false
        void killTree(child)
        if (key === 'rojo') this.update('rojo', { state: 'starting', pid: undefined, detail: `${hold.detail} (${hold.file})`, hold: this.holdView(hold.file) })
      } else if (hold && action === 'wait') {
        if (key === 'rojo') this.update('rojo', { detail: `${hold.detail} (${hold.file})`, hold: this.holdView(hold.file) })
      } else if (action === 'start') {
        proc.held = false
        if (key === 'rojo') this.update('rojo', { hold: undefined })
        const file = this.servedPlace(key)
        const why = file && this.gates.get(file)?.gate === 'clear' ? 'Studio sync clear' : this.gating() ? 'serving without a Studio check' : 'Studio sync gate off'
        this.info('rojo', `${file}: ${why}; starting rojo serve`)
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
    proc.listening = false
    proc.policy?.started(proc.startedAt)
    let lastLine = ''
    // This child printed its port: a Rojo plugin may connect to it (losing it is a "cut"). rojo prints
    // the port before it binds, so a bind failure does not count.
    let listened = false
    let bindFailed = false
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
          if (id === 'rojo' && !listened && proc.child === child && /Port:\s*\d+/i.test(text)) {
            listened = true
            proc.listening = true
            this.onListening(key)
          }
          if (primary && id === 'rojo') this.parseRojo(text)
          if (id === 'rojo' && ADDRESS_IN_USE.test(text)) {
            bindFailed = true
            this.onPortInUse(key, proc)
          }
          if (id === 'rojo' && !proc.panicked && isRojoPanic(text)) this.onRojoPanic(key, proc, child)
        }
      }
    }
    child.stdout?.on('data', onText('stdout'))
    child.stderr?.on('data', onText('stderr'))
    child.on('spawn', () => {
      update({ state: 'running', pid: child.pid })
      if (id === 'rojo') this.placesChanged()
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
      if (!superseded) {
        proc.child = null
        proc.listening = false
      }
      // Whatever ended it, a Rojo plugin connected to it is cut off (unless the project closes).
      const file = id === 'rojo' ? this.servedPlace(key) : null
      if (listened && !bindFailed && file && !superseded && !this.closing && this.root) this.markCut(key)
      if (id === 'rojo') this.placesChanged()
      if (!proc.wanted || proc.held || superseded) return
      const reason = proc.panicked ? 'panicked' : error ? error.message : signal ? `killed by ${signal}` : `exited with code ${code}`
      if (id === 'rojo' && !/ in use by another process/.test(proc.lastError ?? '')) proc.lastError = `${reason}${lastLine ? `: ${lastLine}` : ''}`
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
    const why = / in use by another process/.test(proc.lastError ?? '') ? `it could not bind its port (${proc.lastError})` : 'it panicked (usually a folder deleted or renamed while serving)'
    this.info('rojo', `stopping ${this.procName(key)} because ${why}; restarting it`)
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
      const inUse = / in use by another process/.test(proc.lastError ?? '') ? proc.lastError : null
      const detail = inUse ? `Rojo cannot serve: ${inUse}. Stop it (Forge Doctor can stop a stray rojo), then Restart` : `Rojo keeps crashing (${decision.failures} restarts did not help): ${reason}${lastLine ? `: ${lastLine}` : ''}. Restart to try again`
      proc.gaveUp = true
      this.placesChanged()
      if (primary) this.update('rojo', { state: 'crashed', pid: undefined, detail, gaveUp: true })
      this.options.log({ service: 'rojo', stream: 'stderr', text: `${label}rojo ${reason} ${decision.failures + 1} times in a row; not restarting again. Use Restart.` })
      return
    }
    this.placesChanged()
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
    await this.stop('rojo', `of a ${reason}${/folder/.test(reason) ? ' (rojo can crash on folders that vanish while it serves)' : ''}`)
    this.update('rojo', { state: 'starting', detail: `Paused for a ${reason}` })
    return true
  }

  async resumeRojo(): Promise<void> {
    if (!this.root || this.procs.rojo?.wanted) return
    await this.start('rojo')
  }

  // Stops only this place file's serve around a Forge write for it (a file for an instance made in
  // that place's Studio), so the other places' Rojo plugins stay connected. False when it was not
  // running.
  async pausePlace(file: string, reason: string): Promise<boolean> {
    const keys = Object.keys(this.procs).filter((key) => this.servedPlace(key) === file && this.procs[key]?.wanted && this.procs[key]?.child)
    if (!this.root || !keys.length) return false
    for (const key of keys) {
      await this.stopProc(key, `of a ${reason} for ${file}`)
      this.procs[key]!.paused = true
      if (key === 'rojo') this.update('rojo', { state: 'starting', pid: undefined, detail: `Paused for a ${reason}` })
    }
    this.placesChanged()
    return true
  }

  async resumePlace(file: string): Promise<void> {
    for (const [key, proc] of Object.entries(this.procs)) {
      if (!proc?.paused || this.servedPlace(key) !== file || proc.child || !this.root) continue
      proc.paused = false
      proc.wanted = true
      proc.failures = 0
      proc.policy?.reset()
      const command = key === 'rojo' ? await this.command('rojo') : this.extraCommands.get(key) ?? null
      if (command && proc.wanted && !proc.child) this.spawnService(key, 'rojo', command)
    }
    this.placesChanged()
  }

  // A listening serve of this place stopped while the project stays open.
  private markCut(key: string): void {
    const file = key.startsWith('rojo') ? this.servedPlace(key) : null
    if (!file || this.closing || !this.root) return
    this.cut.add(file)
    this.reconnect.delete(file)
  }

  // A serve printed its port. After a cut, Studio's Rojo plugin has to be connected again by hand.
  private onListening(key: string): void {
    const file = this.servedPlace(key)
    const proc = this.procs[key]
    if (proc) proc.lastError = undefined
    if (file && this.cut.delete(file)) {
      const port = this.rojoPlan().jobs.find((j) => j.key === key)?.port ?? this.places.find((p) => p.file === file)?.servePort ?? 34872
      this.reconnect.set(file, { port, at: Date.now() })
      const name = this.places.find((p) => p.file === file)?.name ?? file.replace(/\.project\.json$/, '')
      this.options.log({ service: 'rojo', stream: 'stderr', text: `${this.procName(key)} serves again. Studio's Rojo plugin was disconnected: click Connect in Rojo (port ${port}) in ${name} Studio` })
    }
    this.placesChanged()
  }

  // rojo could not bind its port: another process (often an old rojo) has it.
  private onPortInUse(key: string, proc: Proc): void {
    const port = this.rojoPlan().jobs.find((j) => j.key === key)?.port
    const text = `port ${port ?? '?'} is in use by another process (old rojo?)`
    if (proc.lastError === text) return
    proc.lastError = text
    this.options.log({ service: 'rojo', stream: 'stderr', text: `${this.procName(key)}: ${text}. Stop that process (Forge Doctor can stop a stray rojo), or change "servePort" in ${this.servedPlace(key)}` })
    this.placesChanged()
  }

  private parseRojo(text: string): void {
    const match = /Port:\s*(\d+)/i.exec(text) || /localhost:(\d+)/i.exec(text)
    if (!match) return
    const place = this.places.find((p) => p.file === this.activePlace)
    const extra = Object.keys(this.procs).filter((key) => key.startsWith('rojo:') && this.procs[key]?.wanted && this.procs[key]?.child).length
    const label = place && !place.isDefault ? ` (${place.name})` : ''
    this.update('rojo', { detail: `rojo serve on :${match[1]}${label}${extra ? ` + ${extra} more place${extra === 1 ? '' : 's'} running` : ''}` })
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
