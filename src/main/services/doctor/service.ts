// Forge Doctor service: gathers DoctorInputs through injected probes (each one time-boxed, a
// failing probe never fails the run), runs the pure checks (shared/doctor/checks.ts) and dispatches
// one-click fixes. No electron imports; wire.ts builds the real probes.

import { runChecks, summarize } from '../../../shared/doctor/checks.ts'
import type { DoctorAction, DoctorInputs, DoctorReport, PortProbe, ProjectFileProbe } from '../../../shared/doctor/types.ts'

export interface DoctorProbes {
  platform: string
  appVersion: string
  isPackaged: boolean
  userDataDir: string
  projectRoot(): string | null
  toolchain(): Promise<DoctorInputs['toolchain']>
  git(): Promise<DoctorInputs['git']>
  // Runs a command; resolves with exit code + combined output (never rejects).
  run(cmd: string, args: string[], cwd?: string): Promise<{ code: number | null; output: string }>
  studioInstall(): Promise<DoctorInputs['studioInstall']>
  bridge(): Promise<DoctorInputs['bridge']>
  legacyPlugins(): Promise<string[]>
  // Rojo serve ports Forge would use, and which of them rojo serves right now.
  // live: `served` is the place's real serve state (supervisor), not the settings.
  servePorts(): { port: number; label: string; served: boolean; live?: boolean }[]
  rojo(): DoctorInputs['rojo']
  // 'busy' when something accepts / holds the port.
  portBusy(port: number): Promise<boolean | null>
  // Who listens on a port Forge does not serve (a stray rojo?).
  portOwner?(port: number): Promise<{ pid: number; name: string; rojo: boolean } | null>
  // Rojo project nodes mapped twice (mapping.ts duplicateMappings), one line each.
  duplicateMappings?(root: string): Promise<string[]>
  sync(): Promise<DoctorInputs['sync']>
  keys(): Promise<DoctorInputs['keys']>
  openCloudKey(): Promise<string | null>
  introspectKey?(key: string): Promise<{ enabled: boolean; expired: boolean; scopes: string[] }>
  openAiKey(): Promise<boolean>
  freeBytes(path: string): Promise<number | null>
  readText(path: string): Promise<string | null>
  listDir(path: string): Promise<string[]>
  exists(path: string): Promise<boolean>
  mtimeMs(path: string): Promise<number | null>
  projectToolsMissing(root: string): string[]
  updater(): Promise<DoctorInputs['updater']>
  screenRecording(): DoctorInputs['screenRecording']
  rosetta?(): boolean
  now?(): number
}

export type DoctorFixers = Partial<Record<DoctorAction, () => Promise<string>>>

const PROBE_MS = 8000

async function timed<T>(p: Promise<T> | T, fallback: T, ms = PROBE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([Promise.resolve(p).catch(() => fallback), new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))])
  } catch {
    return fallback
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const sep = (root: string) => (root.includes('\\') && !root.includes('/') ? '\\' : '/')

export async function projectProbe(probes: DoctorProbes, root: string): Promise<NonNullable<DoctorInputs['project']>> {
  const j = (rel: string) => `${root}${sep(root)}${rel}`
  const projectFiles: ProjectFileProbe[] = []
  const files = (await timed(probes.listDir(root), [] as string[])).filter((f) => f.endsWith('.project.json')).sort()
  for (const file of files) {
    const text = await timed(probes.readText(j(file)), null)
    if (text === null) {
      projectFiles.push({ file, ok: false, error: 'cannot read' })
      continue
    }
    try {
      const json = JSON.parse(text) as { tree?: unknown; servePort?: unknown }
      if (!json || typeof json.tree !== 'object' || !json.tree) projectFiles.push({ file, ok: false, error: 'no "tree" object' })
      else projectFiles.push({ file, ok: true, ...(typeof json.servePort === 'number' ? { servePort: json.servePort } : {}) })
    } catch (e) {
      projectFiles.push({ file, ok: false, error: (e as Error).message.slice(0, 160) })
    }
  }
  const [wallyToml, packagesInstalled, rokitToml, smTime] = await Promise.all([timed(probes.exists(j('wally.toml')), false), timed(probes.exists(j('Packages')), false), timed(probes.exists(j('rokit.toml')), false), timed(probes.mtimeMs(j('sourcemap.json')), null)])
  const now = probes.now?.() ?? Date.now()
  const duplicateMappings = probes.duplicateMappings ? await timed(probes.duplicateMappings(root), [] as string[]) : []
  return {
    root,
    ...(duplicateMappings.length ? { duplicateMappings } : {}),
    projectFiles,
    wallyToml,
    packagesInstalled,
    rokitToml,
    projectToolsMissing: rokitToml ? probes.projectToolsMissing(root) : [],
    sourcemap: smTime === null ? { exists: false } : { exists: true, ageMs: Math.max(0, now - smTime) }
  }
}

export async function gatherInputs(probes: DoctorProbes): Promise<DoctorInputs> {
  const root = probes.projectRoot()
  const [toolchain, git, ghVer, studioInstall, bridge, legacyPlugins, sync, keys, ocKey, openAiKey, project] = await Promise.all([
    timed(probes.toolchain(), null, 20_000),
    timed(probes.git(), { available: false, version: null }),
    timed(probes.run('gh', ['--version']), { code: null, output: '' }),
    timed(probes.studioInstall(), null),
    timed(probes.bridge(), null),
    timed(probes.legacyPlugins(), [] as string[]),
    timed(probes.sync(), null),
    timed(probes.keys(), [] as DoctorInputs['keys']),
    timed(probes.openCloudKey(), null),
    timed(probes.openAiKey(), false),
    root ? timed(projectProbe(probes, root), null, 15_000) : Promise.resolve(null)
  ])
  const ghAvailable = ghVer.code === 0
  const ghAuth = ghAvailable ? await timed(probes.run('gh', ['auth', 'status']), { code: null, output: '' }) : null
  let python: DoctorInputs['python'] = null
  if (sync?.engine === 'project') {
    python = { available: false, version: null }
    for (const cmd of probes.platform === 'win32' ? ['py', 'python'] : ['python3', 'python']) {
      const r = await timed(probes.run(cmd, ['--version']), { code: null, output: '' })
      const v = /Python (\d+\.\d+(?:\.\d+)?)/.exec(r.output)?.[1]
      if (r.code === 0 && v) {
        python = { available: v.startsWith('3'), version: `Python ${v}` }
        break
      }
    }
  }
  const ports: PortProbe[] = []
  const rojo = probes.rojo()
  for (const sp of probes.servePorts()) {
    if (ports.some((p) => p.port === sp.port)) continue
    const busy = await timed(probes.portBusy(sp.port), null, 3000)
    const expected = sp.served && (sp.live || rojo === 'running' || rojo === 'starting')
    const state: PortProbe['state'] = busy === null ? 'unknown' : busy ? (expected ? 'ours' : 'other') : 'free'
    const owner = state === 'other' && probes.portOwner ? await timed(probes.portOwner(sp.port), null, 6000) : null
    ports.push({ port: sp.port, label: sp.label, state, expected, ...(owner ? { owner } : {}) })
  }
  let introspect: DoctorInputs['openCloud']['introspect']
  if (ocKey && probes.introspectKey) {
    introspect = await timed(
      probes.introspectKey(ocKey).catch((e: Error) => ({ error: e.message.slice(0, 120) })),
      { error: 'timed out' }
    )
  }
  const disk = [{ label: 'App data', path: probes.userDataDir }, ...(root ? [{ label: 'Project', path: root }] : [])]
  const freeList = await Promise.all(disk.map((d) => timed(probes.freeBytes(d.path), null)))
  return {
    platform: probes.platform,
    appVersion: probes.appVersion,
    isPackaged: probes.isPackaged,
    toolchain,
    git,
    gh: { available: ghAvailable, version: /gh version (\S+)/.exec(ghVer.output)?.[1] ?? null, authed: ghAuth ? ghAuth.code === 0 : null },
    python,
    studioInstall,
    bridge,
    legacyPlugins,
    ports,
    rojo,
    sync,
    keys,
    openCloud: { set: !!ocKey, ...(introspect ? { introspect } : {}) },
    openAiKey,
    disk: disk.map((d, i) => ({ ...d, freeBytes: freeList[i] })),
    project,
    updater: await timed(probes.updater(), null),
    screenRecording: probes.screenRecording(),
    ...(probes.rosetta?.() ? { rosetta: true } : {})
  }
}

// Scope strings ("asset:read") from the Open Cloud API key introspection response
// (POST https://apis.roblox.com/api-keys/v1/introspect, documented at
// https://create.roblox.com/docs/cloud/auth/api-keys : scopes[] with name + operations).
export function scopeStrings(scopes: unknown): string[] {
  const out = new Set<string>()
  for (const s of Array.isArray(scopes) ? scopes : []) {
    const name = typeof (s as { name?: unknown })?.name === 'string' ? (s as { name: string }).name : ''
    const ops = (s as { operations?: unknown })?.operations
    const base = name.replace(/^assets?$/, 'asset')
    for (const op of Array.isArray(ops) ? ops : []) if (typeof op === 'string') out.add(`${base}:${op}`)
  }
  return [...out]
}

export class DoctorService {
  private probes: DoctorProbes
  private fixers: DoctorFixers
  private last: DoctorReport | null = null
  private running: Promise<DoctorReport> | null = null
  private emit?: (report: DoctorReport) => void

  constructor(deps: { probes: DoctorProbes; fixers?: DoctorFixers; emit?: (report: DoctorReport) => void }) {
    this.probes = deps.probes
    this.fixers = deps.fixers ?? {}
    this.emit = deps.emit
  }

  lastReport(): DoctorReport | null {
    return this.last
  }

  run(): Promise<DoctorReport> {
    this.running ??= (async () => {
      const t0 = Date.now()
      try {
        const inputs = await gatherInputs(this.probes)
        const now = this.probes.now?.() ?? Date.now()
        const report = summarize(runChecks(inputs, now), { at: now, ms: Date.now() - t0, appVersion: this.probes.appVersion, platform: this.probes.platform })
        this.last = report
        this.emit?.(report)
        return report
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  async fix(action: DoctorAction): Promise<{ ok: boolean; message: string }> {
    const f = this.fixers[action]
    if (!f) return { ok: false, message: `No automatic fix for ${action} here.` }
    try {
      return { ok: true, message: await f() }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  }
}
