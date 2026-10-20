// Crash-safe rojo (no electron imports; unit tested in test/rojoBinary.test.ts).
//
// rojo 7.7.0 panics, and on Windows exits, when it handles a file event for a path that is already
// gone: a folder renamed or deleted right after files were written into it (agents committing a batch,
// generators that build in one folder and rename it). Studio's Rojo plugin then shows "WebSocket error
// ... forcibly closed by the remote host" and stays disconnected until Connect is clicked again; the
// supervisor's restart cannot reconnect it. tools/rojo/burst-test.mjs reproduces it.
//
// Forge therefore serves with the same rojo version built with tools/rojo/forge-rojo.patch (the
// "Crash-safe rojo" workflow, .github/workflows/rojo.yml), downloaded once from the rbx-forge release
// below and checked against the SHA-256 pinned here. It is used only when the project's own rojo (its
// rokit.toml pin) is exactly ROJO_VERSION, so the Studio plugin always sees the version it expects;
// any other version, a platform without a build, or the setting turned off serves with the project's
// rojo as before.
import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs/promises'
import { join } from 'node:path'

export const CRASH_SAFE_ROJO_SETTING = 'rojo.crashSafe'
export const ROJO_VERSION = '7.7.0'
export const FORGE_BUILD = `${ROJO_VERSION}-forge.1`
export const RELEASE_TAG = `rojo-${FORGE_BUILD}`
const RELEASE_BASE = `https://github.com/Acidgorgon/rbx-forge/releases/download/${RELEASE_TAG}`
const MAX_BYTES = 80 * 1024 * 1024

// <node platform>-<node arch> -> release asset and its sha256 (printed by the workflow's build jobs).
export const ASSETS: Record<string, { asset: string; sha256: string }> = {
  'win32-x64': { asset: `rojo-${FORGE_BUILD}-windows-x86_64.exe`, sha256: 'b0c640a11227855c2215dd77fad9458483f4f17155a7dea6340ec1f3c7ee1228' },
  'darwin-arm64': { asset: `rojo-${FORGE_BUILD}-macos-aarch64`, sha256: '4e7cc235070c5d868432199f28c82619552e7e31a995b6797ba4bd1aaa5ec354' },
  'darwin-x64': { asset: `rojo-${FORGE_BUILD}-macos-x86_64`, sha256: 'c5d8dcf9d77efca3a8440a235f957eaaf830a51ed29a98869037e54b85d66cd6' },
  'linux-x64': { asset: `rojo-${FORGE_BUILD}-linux-x86_64`, sha256: 'a9b940af1d38395ea2bda5d9dae22e5b4bb082c5e015bbe650bb914a6cb48291' }
}

// "Rojo 7.7.0" / "rojo 7.7.0" -> "7.7.0"
export function parseRojoVersion(text: string): string | null {
  const m = /\brojo\s+v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/i.exec(text)
  return m ? m[1] : null
}

export interface ForgeRojoDeps {
  // Where builds are kept (userData/tools/rojo).
  dir: string
  platform: NodeJS.Platform
  arch: string
  get: (url: string, maxBytes: number) => Promise<{ status: number; body: Buffer }>
  // `rojo --version` of the project's rojo, run in the project root (rokit picks the pinned version there).
  version: (rojo: string, root: string) => Promise<string | null>
  enabled: () => boolean
  log: (text: string, stream?: 'info' | 'stderr') => void
  fs?: Pick<typeof nodeFs, 'readFile' | 'writeFile' | 'rename' | 'mkdir' | 'chmod' | 'rm'>
  assets?: typeof ASSETS
  // How long a rojo start waits for a download that is under way (default 20s).
  waitMs?: number
}

export type RojoChoice = { file: string; crashSafe: boolean; why: string }

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

export class ForgeRojo {
  private deps: ForgeRojoDeps
  private fs: NonNullable<ForgeRojoDeps['fs']>
  private ready: string | null = null
  private pending: Promise<string | null> | null = null
  private failed: string | null = null
  private versions = new Map<string, Promise<string | null>>()
  private said = new Set<string>()

  constructor(deps: ForgeRojoDeps) {
    this.deps = deps
    this.fs = deps.fs ?? nodeFs
  }

  private target(): { asset: string; sha256: string } | null {
    const t = (this.deps.assets ?? ASSETS)[`${this.deps.platform}-${this.deps.arch}`]
    return t && /^[0-9a-f]{64}$/.test(t.sha256) ? t : null
  }

  private file(): string {
    return join(this.deps.dir, FORGE_BUILD, this.deps.platform === 'win32' ? 'rojo.exe' : 'rojo')
  }

  // The verified binary, downloading it once if needed (concurrent callers share one download).
  // null: no build for this platform, or the download / check failed (retried on a later call).
  ensure(): Promise<string | null> {
    if (this.ready) return Promise.resolve(this.ready)
    if (this.pending) return this.pending
    this.pending = this.load().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  private async load(): Promise<string | null> {
    const target = this.target()
    if (!target) return null
    const file = this.file()
    const existing = await this.fs.readFile(file).catch(() => null)
    if (existing && sha256(existing) === target.sha256) return (this.ready = file)
    try {
      const res = await this.deps.get(`${RELEASE_BASE}/${target.asset}`, MAX_BYTES)
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
      const got = sha256(res.body)
      if (got !== target.sha256) throw new Error(`checksum mismatch (got ${got.slice(0, 12)}…)`)
      await this.fs.mkdir(join(file, '..'), { recursive: true })
      const temp = `${file}.${process.pid}.download`
      await this.fs.writeFile(temp, res.body)
      if (this.deps.platform !== 'win32') await this.fs.chmod(temp, 0o755)
      await this.fs.rm(file, { force: true })
      await this.fs.rename(temp, file)
      this.failed = null
      this.deps.log(`rojo: crash-safe rojo ${FORGE_BUILD} downloaded`)
      return (this.ready = file)
    } catch (error) {
      const why = (error as Error).message
      if (this.failed !== why) this.deps.log(`rojo: could not download crash-safe rojo ${FORGE_BUILD} (${why}); serving with the project's rojo`, 'stderr')
      this.failed = why
      return null
    }
  }

  private versionOf(rojo: string, root: string): Promise<string | null> {
    const key = `${rojo}\u0000${root}`
    let v = this.versions.get(key)
    if (!v) {
      v = this.deps.version(rojo, root).catch(() => null)
      this.versions.set(key, v)
      // A failed check is tried again next time (rokit may still be installing the pin).
      void v.then((x) => x === null && this.versions.delete(key))
    }
    return v
  }

  // Forget cached `rojo --version` results (rokit.toml changed, tools reinstalled).
  forgetVersions(): void {
    this.versions.clear()
  }

  // The rojo binary to serve with: the crash-safe build when it is ready and the project's rojo is
  // the same version, else the project's own. A download under way (main starts one at launch) is
  // waited for up to waitMs; one still not done then is used from the next rojo start.
  async choose(projectRojo: string, root: string): Promise<RojoChoice> {
    const own = (why: string): RojoChoice => {
      if (!this.said.has(why)) {
        this.said.add(why)
        this.deps.log(`rojo: ${why}`)
      }
      return { file: projectRojo, crashSafe: false, why }
    }
    if (!this.deps.enabled()) return { file: projectRojo, crashSafe: false, why: 'crash-safe rojo is off (Settings > Toolchain)' }
    if (!this.target()) return own(`no crash-safe rojo build for ${this.deps.platform}-${this.deps.arch}; serving with the project's rojo`)
    const raw = await this.versionOf(projectRojo, root)
    const version = raw ? parseRojoVersion(raw) : null
    if (version !== ROJO_VERSION) {
      return own(`the project's rojo is ${version ?? 'an unknown version'}; the crash-safe build is rojo ${ROJO_VERSION}, so the project's rojo serves (it can crash when a folder is renamed or deleted while it serves)`)
    }
    if (!this.ready) {
      const waitMs = this.deps.waitMs ?? 20_000
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([this.ensure(), new Promise<null>((r) => (timer = setTimeout(() => r(null), waitMs)))])
      clearTimeout(timer)
    }
    if (!this.ready) {
      const why = this.failed ? `crash-safe rojo ${FORGE_BUILD} could not be downloaded (${this.failed}); serving with the project's rojo` : `crash-safe rojo ${FORGE_BUILD} is still downloading; it is used from the next rojo start`
      return { file: projectRojo, crashSafe: false, why }
    }
    return { file: this.ready, crashSafe: true, why: `serving with crash-safe rojo ${FORGE_BUILD} (same version as the project's rojo ${ROJO_VERSION})` }
  }
}
