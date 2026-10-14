// Mesh files for the VFX Lab preview: MeshPart / SpecialMesh MeshIds -> geometry, cached by asset
// id in <userData>/vfx/meshes/<id>.json (shared/vfx/mesh/data.ts MeshWire). Sources, in order:
//   1. Roblox Studio through the Forge Bridge: a read-only job (shared/vfx/mesh/bridge.ts) reads
//      each mesh with AssetService:CreateEditableMeshAsync. Works for meshes the Studio user may
//      load as EditableMesh (their own, their groups', the experience creator's).
//   2. Open Cloud asset delivery (GET apis.roblox.com/asset-delivery-api/v1/assetId/{id}, header
//      x-api-key, scope legacy-asset:manage) with the user's Open Cloud key, then the .mesh file
//      from the returned location (no key sent there), parsed by shared/vfx/mesh/parse.ts.
//   3. Nothing: the preview keeps its proxy shapes; the report says why per mesh.
// The Open Cloud key stays in the main process: it is only sent to apis.roblox.com, never logged,
// never returned. No electron imports.

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { isMeshWire, meshAssetId, MeshError, toWire, type MeshData, type MeshSource, type MeshWire } from '../../../shared/vfx/mesh/data.ts'
import { parseRobloxMesh } from '../../../shared/vfx/mesh/parse.ts'
import { collectMeshes, meshJob, MESH_JOB_MAX } from '../../../shared/vfx/mesh/bridge.ts'
import type { BridgeJob } from '../../../shared/studio/protocol.ts'
import type { MeshLoadReport, MeshLoadResult, MeshStatus } from '../../../shared/vfxMeshTypes.ts'

export const ASSET_DELIVERY = 'https://apis.roblox.com/asset-delivery-api/v1/assetId'
const MAX_MESH_BYTES = 30 * 1024 * 1024
// A failed id is not retried automatically for this long (an explicit "Load meshes" retries).
const FAIL_TTL_MS = 10 * 60_000
const MAX_IDS = 200

export interface MeshResponse {
  ok: boolean
  status: number
  headers?: { get(name: string): string | null }
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}
export type MeshFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<MeshResponse>

export interface MeshBridge {
  port: number
  listening: boolean
  connected(): boolean
  run(job: BridgeJob, handler: (ev: { type: string; message?: string }, at: number) => unknown, opts?: { acceptTimeoutMs?: number; timeoutMs?: number }): Promise<void>
}

export interface MeshServiceDeps {
  // <userData>/vfx
  userDir: string
  robloxKey?: () => Promise<string | null>
  fetch?: MeshFetch
  bridge?: MeshBridge
  emit?: (event: 'vfx:meshes', payload: { at: number; ids: string[] }) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  now?: () => number
}

export class MeshService {
  private deps: MeshServiceDeps
  private mem = new Map<string, MeshWire>()
  private failed = new Map<string, { reason: string; at: number; source?: MeshSource | 'none' }>()
  private inflight: Promise<MeshLoadReport> | null = null
  private now: () => number

  constructor(deps: MeshServiceDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  get dir(): string {
    return join(this.deps.userDir, 'meshes')
  }

  private studioConnected(): boolean {
    const b = this.deps.bridge
    return !!(b?.listening && b.connected())
  }

  async status(): Promise<MeshStatus> {
    return { studio: this.studioConnected(), cloudKey: !!(await this.deps.robloxKey?.().catch(() => null)) }
  }

  // Cached geometry only (fast; what the preview asks for first). Unknown or bad ids are left out.
  async get(refs: string[]): Promise<Record<string, MeshWire>> {
    const out: Record<string, MeshWire> = {}
    for (const ref of refs.slice(0, MAX_IDS)) {
      const id = meshAssetId(ref)
      if (!id || out[id]) continue
      const w = await this.cached(id)
      if (w) out[id] = w
    }
    return out
  }

  private async cached(id: string): Promise<MeshWire | null> {
    const hit = this.mem.get(id)
    if (hit) return hit
    const raw = await readFile(join(this.dir, `${id}.json`), 'utf8').catch(() => null)
    if (!raw) return null
    try {
      const w = JSON.parse(raw) as unknown
      if (!isMeshWire(w) || w.id !== id) return null
      this.mem.set(id, w)
      return w
    } catch {
      return null
    }
  }

  private async store(id: string, mesh: MeshData, source: MeshSource): Promise<MeshWire> {
    const w = toWire(id, mesh, source, this.now())
    await mkdir(this.dir, { recursive: true })
    const tmp = join(this.dir, `${id}.${randomBytes(4).toString('hex')}.tmp`)
    await writeFile(tmp, JSON.stringify(w))
    await rename(tmp, join(this.dir, `${id}.json`))
    this.mem.set(id, w)
    this.failed.delete(id)
    return w
  }

  // Loads every id that is not cached yet: Studio first, then Open Cloud. One load at a time (a
  // second call waits for the first and then runs for what is still missing).
  async load(refs: string[], opts: { studio?: boolean; cloud?: boolean; retry?: boolean } = {}): Promise<MeshLoadReport> {
    while (this.inflight) await this.inflight.catch(() => null)
    const p = this.loadNow(refs, opts)
    this.inflight = p
    try {
      return await p
    } finally {
      this.inflight = null
    }
  }

  private async loadNow(refs: string[], opts: { studio?: boolean; cloud?: boolean; retry?: boolean }): Promise<MeshLoadReport> {
    const ids = [...new Set(refs.map(meshAssetId).filter((x): x is string => !!x))].slice(0, MAX_IDS)
    const results = new Map<string, MeshLoadResult>()
    const notes: string[] = []
    const todo: string[] = []
    for (const id of ids) {
      const c = await this.cached(id)
      if (c) results.set(id, { id, state: 'cached', source: c.source, verts: c.verts, tris: c.tris })
      else {
        const f = this.failed.get(id)
        if (f && !opts.retry && this.now() - f.at < FAIL_TTL_MS) results.set(id, { id, state: 'failed', reason: f.reason, ...(f.source ? { source: f.source } : {}) })
        else todo.push(id)
      }
    }
    const reasons = new Map<string, string[]>()
    const why = (id: string, r: string) => reasons.set(id, [...(reasons.get(id) ?? []), r])
    const loaded: string[] = []
    let missing = todo
    // 1. Studio
    if (missing.length && opts.studio !== false) {
      if (this.studioConnected()) {
        const b = this.deps.bridge!
        for (let i = 0; i < missing.length; i += MESH_JOB_MAX) {
          const batch = missing.slice(i, i + MESH_JOB_MAX)
          const jobId = `job-mesh-${randomBytes(5).toString('hex')}`
          const messages: string[] = []
          try {
            await b.run(meshJob({ id: jobId, port: b.port, ids: batch }), (ev) => {
              if (ev.type === 'log' && typeof ev.message === 'string') messages.push(ev.message)
              return {}
            }, { acceptTimeoutMs: 12_000, timeoutMs: 240_000 })
          } catch (e) {
            notes.push(`Studio mesh read failed: ${(e as Error).message}`)
          }
          const { results: got } = collectMeshes(messages)
          for (const id of batch) {
            const r = got.get(id)
            if (!r) why(id, 'Studio: no answer for this mesh')
            else if (!r.ok) why(id, `Studio: ${r.error}`)
            else {
              const w = await this.store(id, r.mesh, 'studio')
              results.set(id, { id, state: 'loaded', source: 'studio', verts: w.verts, tris: w.tris })
              loaded.push(id)
            }
          }
        }
      } else notes.push('Roblox Studio is not connected (Forge Bridge plugin), so meshes were not read from Studio.')
      missing = missing.filter((id) => !results.has(id))
    }
    // 2. Open Cloud
    if (missing.length && opts.cloud !== false) {
      const key = await this.deps.robloxKey?.().catch(() => null)
      if (!key) {
        notes.push('No Open Cloud API key (Art page): meshes were not downloaded. A key with the legacy-asset:manage scope lets Forge download mesh files.')
        for (const id of missing) why(id, 'Open Cloud: no API key')
      } else {
        let scopeProblem = false
        for (const id of missing) {
          if (scopeProblem) {
            why(id, 'Open Cloud: the key cannot read assets (needs legacy-asset:manage)')
            continue
          }
          try {
            const mesh = await this.download(id, key)
            const w = await this.store(id, mesh, 'cloud')
            results.set(id, { id, state: 'loaded', source: 'cloud', verts: w.verts, tris: w.tris })
            loaded.push(id)
          } catch (e) {
            const err = e as Error & { status?: number }
            if (err.status === 401 || err.status === 403) {
              // 403 can also mean "this asset is not yours": only stop after an auth failure.
              if (err.status === 401) scopeProblem = true
            }
            why(id, `Open Cloud: ${err.message}`)
          }
        }
        if (scopeProblem) notes.push('The Open Cloud key was refused for asset delivery: give it the legacy-asset:manage scope (Creator Dashboard > API keys).')
      }
    }
    for (const id of todo) {
      if (results.has(id)) continue
      const reason = (reasons.get(id) ?? ['no source available']).join('; ')
      this.failed.set(id, { reason, at: this.now(), source: 'none' })
      results.set(id, { id, state: 'failed', reason })
    }
    if (loaded.length) this.deps.emit?.('vfx:meshes', { at: this.now(), ids: loaded })
    const list = ids.map((id) => results.get(id)!).filter(Boolean)
    if (todo.length) this.deps.log?.(`meshes: ${loaded.length}/${todo.length} loaded (${list.filter((r) => r.state === 'failed').length} failed)`)
    return { results: list, notes, studio: this.studioConnected(), at: this.now() }
  }

  private async download(id: string, key: string): Promise<MeshData> {
    const f = this.deps.fetch ?? (globalThis.fetch as unknown as MeshFetch)
    const res = await f(`${ASSET_DELIVERY}/${encodeURIComponent(id)}`, { headers: { 'x-api-key': key, accept: 'application/json' } })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const msg =
        res.status === 401 || res.status === 403
          ? `Roblox refused (${res.status}): the key needs the legacy-asset:manage scope, or this mesh is not available to its owner`
          : res.status === 404
            ? 'asset not found'
            : res.status === 429
              ? 'rate limited; try again in a minute'
              : `Roblox answered ${res.status}${body ? `: ${body.slice(0, 120).replace(/\s+/g, ' ')}` : ''}`
      throw Object.assign(new Error(msg), { status: res.status })
    }
    let location: string | undefined
    try {
      const j = JSON.parse(await res.text()) as { location?: unknown; locations?: { location?: unknown }[] }
      location = typeof j.location === 'string' ? j.location : typeof j.locations?.[0]?.location === 'string' ? (j.locations[0].location as string) : undefined
    } catch {
      location = undefined
    }
    if (!location || !/^https:\/\/[\w.-]+\.(?:rbxcdn\.com|roblox\.com)\//i.test(location)) throw new Error('no download location in the answer')
    // The CDN link is pre-signed: the API key is not sent there.
    const file = await f(location)
    if (!file.ok) throw Object.assign(new Error(`download failed (${file.status})`), { status: file.status })
    let bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.length > MAX_MESH_BYTES) throw new Error('mesh file is too big')
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = new Uint8Array(gunzipSync(bytes))
    try {
      return parseRobloxMesh(bytes)
    } catch (e) {
      if (e instanceof MeshError) throw new Error(e.message)
      throw e
    }
  }
}
