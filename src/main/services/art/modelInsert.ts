// Studio insert requests in the model inbox: an agent drops a Roblox model file (.rbxm / .rbxmx) and
// <id>.insert.json into the same folder as the FBX upload inbox (modelInbox.ts); Forge checks it,
// sends it to the linked Studio window through the Forge Bridge plugin (v14 insert job, see
// shared/studio/insert.ts for how the bytes reach Studio), which puts it under `parent` inside a
// ChangeHistoryService recording (Ctrl+Z in Studio undoes it). Forge writes <id>.insert.result.json
// and renames the request to <id>.insert.done.json so it is never inserted twice. Opt-in (Settings >
// Integrations, "Insert models dropped in the inbox": modelInbox.insertEnabled, off by default). No
// electron imports: the folder, bridge, watcher and clock come in as deps (main/integrations.ts).
//
//   <id>.insert.json         { "file": "relative/or/absolute.rbxmx", "parent": "ServerStorage.RBX_ANIMSAVES",
//                              "place": "MyGame" | 1234567, "placeId": 1234567, "placeName": "MyGame",
//                              "replace": true }
//                            parent: a dot path starting at a service (default ServerStorage); missing
//                            folders after the service are created. place: optional project place
//                            name, Studio place name or PlaceId (needed when several project places are
//                            open, or to pick a window outside the project). placeId / placeName: the
//                            same, spelled out; with both, the window must match both. A named place
//                            that is not connected waits, then fails: never another window. Unknown keys
//                            are refused. replace: remove the parent's children named like an inserted
//                            instance first (default false).
//   <id>.insert.result.json  { "status": "inserting" }
//                            { "status": "done", "paths": ["ServerStorage.RBX_ANIMSAVES.Run"], "place": "MyGame (42)",
//                              "placeId"?: 42, "projectPlace"?: "MyGame", "replaced": 0, "via": "serialization" | "tree", "insertedAt": "<ISO time>",
//                              "created"?: [...], "skipped"?: [...] }
//                            { "status": "error", "error": "..." }
//
// Same file rules as uploads: relative files resolve against the inbox; the file must be inside the
// inbox or <Documents>/ForgeModels (after resolving symlinks), up to 20 MB. A request waits (up to
// waitMs from when it was written) while Studio is not connected or busy with another Studio job,
// then fails. A result that already exists means the id is handled: no second insert.
//
// Which Studio window, without "place": only one that has a place of the open Forge project open (its
// PlaceId in a servePlaceIds or linked in Source Control; an unpublished place only through its
// Source Control link). Never any other window, not even when it is the only one connected (a game
// file opened to study it is not the project). With "place": the window it names exactly (PlaceId or
// Studio name), project place or not. See pickWindow in shared/studio/insert.ts.

import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type { ModelInboxEntry } from '../../../shared/artTypes.ts'
import type { BridgeJob } from '../../../shared/studio/protocol.ts'
import {
  chunkBase64,
  chunkText,
  INSERT_MAX_BYTES,
  INSERT_PLUGIN_VERSION,
  InsertFileError,
  insertJob,
  modelFormat,
  parseInsertReport,
  parseParentPath,
  parsePlace,
  pickWindow,
  readRbxmxTree,
  type InsertProjectPlace,
  type InsertReport,
  type StudioWindow
} from '../../../shared/studio/insert.ts'
import type { StudioTarget } from '../../../shared/studio/target.ts'
import { newJobId } from '../../../shared/studio/protocol.ts'
import { BridgeError, type EventHandler, type RunOptions } from '../studio/bridge.ts'
import { defaultWatch, resolveModelFile, writeJsonAtomic } from './modelInbox.ts'

export const INSERT_SUFFIX = '.insert.json'
export const INSERT_RESULT_SUFFIX = '.insert.result.json'
export const INSERT_DONE_SUFFIX = '.insert.done.json'
const MAX_REQUEST_BYTES = 64 * 1024

type Check<T> = { ok: true; value: T } | { ok: false; error: string }

export interface InsertRequest {
  file: string
  parent: string[]
  place: StudioTarget | null
  replace: boolean
}

// Strict: an unknown key (a misspelt "plcae", a "target") is refused, never ignored, because a request
// whose place is silently dropped would land in whichever project window is connected.
const RequestSchema = z
  .object({
    file: z.string().min(1).max(1024),
    parent: z.string().max(2000).optional(),
    place: z.union([z.string(), z.number()]).optional().nullable(),
    // Same meaning as "place", spelled out: a PlaceId, or a place name.
    placeId: z.union([z.string(), z.number()]).optional().nullable(),
    placeName: z.string().optional().nullable(),
    replace: z.boolean().optional()
  })
  .strict()

export function parseInsertRequest(text: string): Check<InsertRequest> {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: 'The request is not valid JSON' }
  }
  const parsed = RequestSchema.safeParse(json)
  if (!parsed.success) return { ok: false, error: `Bad request: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ')}` }
  const r = parsed.data
  if (r.file.includes('\0') || /[\u0000-\u001f]/.test(r.file)) return { ok: false, error: 'Bad request: control characters in file' }
  const parent = parseParentPath(r.parent)
  if (!parent.ok) return parent
  // "place", "placeId" and "placeName" may be combined: at most one PlaceId and one name. Both given:
  // the window must have that PlaceId and that name (pickWindow), so a stale id or name is refused.
  let placeId: number | undefined
  let placeName: string | undefined
  for (const [key, raw] of [['place', r.place], ['placeId', r.placeId], ['placeName', r.placeName]] as const) {
    const t = parsePlace(raw)
    if (!t.ok) return { ok: false, error: t.error.replace(/^Bad place/, `Bad ${key}`) }
    if (!t.value) continue
    if (key === 'placeId' && !t.value.placeId) return { ok: false, error: `Bad placeId "${raw}": a PlaceId is a positive whole number (a name goes in "placeName")` }
    if (key === 'placeName' || t.value.place) {
      const name = key === 'placeName' ? String(raw).trim() : t.value.place!
      if (placeName !== undefined && placeName.toLowerCase() !== name.toLowerCase()) return { ok: false, error: `Bad request: two different place names ("${placeName}", "${name}"); give one` }
      placeName = name
    } else {
      if (placeId !== undefined && placeId !== t.value.placeId) return { ok: false, error: `Bad request: two different PlaceIds (${placeId}, ${t.value.placeId}); give one` }
      placeId = t.value.placeId
    }
  }
  const place: StudioTarget | null = placeId || placeName ? { ...(placeId ? { placeId } : {}), ...(placeName ? { place: placeName } : {}) } : null
  return { ok: true, value: { file: r.file, parent: parent.value, place, replace: r.replace === true } }
}

export type InsertResult =
  | { status: 'inserting' }
  | { status: 'done'; paths: string[]; place: string; placeId?: number; projectPlace?: string; replaced: number; via: InsertReport['via']; insertedAt: string; created?: string[]; skipped?: string[] }
  | { status: 'error'; error: string }

export interface InsertBridgeWindow extends StudioWindow {
  lastSeen?: number
}

// What the inbox needs of the Forge Bridge (StudioBridge).
export interface InsertBridge {
  readonly listening: boolean
  studios(): InsertBridgeWindow[]
  // A Studio job that is not a background one.
  busy(): BridgeJob | null
  run(job: BridgeJob, handler: EventHandler, opts?: RunOptions): Promise<void>
}

export interface InsertInboxDeps {
  dir: () => string
  modelsDir: () => string
  enabled: () => boolean
  bridge: () => InsertBridge | null
  // The open project's places (null: no project open). Inserts only go to Studio windows of these.
  projectPlaces: () => InsertProjectPlace[] | null
  log: (text: string, stream?: 'info' | 'stderr') => void
  onResult?: (entry: ModelInboxEntry) => void
  now?: () => number
  newId?: () => string
  watch?: ((dir: string, onChange: () => void) => () => void) | null
  pollMs?: number
  settleMs?: number
  // How long a request waits for Studio (not connected, the named place not open, busy) after it was
  // written before it fails.
  waitMs?: number
}

const windowLabel = (w: StudioWindow) => `${w.place ?? 'Studio'}${w.placeId ? ` (${w.placeId})` : ''}`

export class InsertInbox {
  private deps: InsertInboxDeps
  private timer: ReturnType<typeof setInterval> | null = null
  private unwatch: (() => void) | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null
  private scanning: Promise<void> | null = null
  private again = false
  private active = new Set<string>()
  private waiting = new Set<string>()
  private entries: ModelInboxEntry[] = []
  private watchingDir: string | null = null

  constructor(deps: InsertInboxDeps) {
    this.deps = deps
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  recent(): ModelInboxEntry[] {
    return this.entries.slice()
  }

  watching(): boolean {
    return this.watchingDir !== null
  }

  async start(): Promise<void> {
    this.stop()
    if (!this.deps.enabled()) return
    const dir = this.deps.dir()
    try {
      await mkdir(dir, { recursive: true })
    } catch (error) {
      this.deps.log(`[model inbox] cannot create ${dir}: ${(error as Error).message}`, 'stderr')
      return
    }
    this.watchingDir = dir
    const watch = this.deps.watch === undefined ? defaultWatch : this.deps.watch
    if (watch) {
      try {
        this.unwatch = watch(dir, () => this.kick())
      } catch {
        // polling alone still works
      }
    }
    const poll = this.deps.pollMs ?? 4000
    if (poll > 0) {
      this.timer = setInterval(() => this.kick(0), poll)
      this.timer.unref?.()
    }
    this.deps.log(`[model inbox] watching ${dir} for Studio inserts`)
    this.kick(0)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.debounce) clearTimeout(this.debounce)
    this.unwatch?.()
    this.timer = null
    this.debounce = null
    this.unwatch = null
    this.watchingDir = null
  }

  private kick(ms = 400): void {
    if (this.debounce) return
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.scan().catch((error) => this.deps.log(`[model inbox] ${(error as Error).message}`, 'stderr'))
    }, ms)
    this.debounce.unref?.()
  }

  scan(): Promise<void> {
    if (this.scanning) {
      this.again = true
      return this.scanning
    }
    this.scanning = (async () => {
      try {
        do {
          this.again = false
          await this.pass()
        } while (this.again && this.deps.enabled())
      } finally {
        this.scanning = null
      }
    })()
    return this.scanning
  }

  private async pass(): Promise<void> {
    if (!this.deps.enabled()) return
    const dir = this.deps.dir()
    const names = await readdir(dir).catch(() => [] as string[])
    const ids = names.filter((n) => n.endsWith(INSERT_SUFFIX) && n.length > INSERT_SUFFIX.length).map((n) => n.slice(0, -INSERT_SUFFIX.length))
    const dated = await Promise.all(ids.map(async (id) => ({ id, at: (await stat(join(dir, id + INSERT_SUFFIX)).catch(() => null))?.mtimeMs ?? 0 })))
    dated.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    for (const { id } of dated) {
      if (!this.deps.enabled()) return
      await this.process(dir, id)
    }
  }

  // Request -> inserting -> done | error -> request renamed. Returns what happened, for tests.
  async process(dir: string, id: string): Promise<'skipped' | 'deferred' | 'done' | 'error'> {
    if (this.active.has(id)) return 'skipped'
    const requestPath = join(dir, id + INSERT_SUFFIX)
    const resultPath = join(dir, id + INSERT_RESULT_SUFFIX)
    const finish = () => rename(requestPath, join(dir, id + INSERT_DONE_SUFFIX)).catch((error) => this.deps.log(`[model inbox] could not rename ${id}${INSERT_SUFFIX}: ${(error as Error).message}`, 'stderr'))

    // Idempotent: a result means this id was handled. An "inserting" left by a Forge that quit
    // mid-insert is closed out as an error, never sent again (Studio may have inserted it).
    const existing = await readFile(resultPath, 'utf8').then((t) => t, () => null)
    if (existing !== null) {
      let status: unknown
      try {
        status = (JSON.parse(existing) as { status?: unknown }).status
      } catch {
        status = undefined
      }
      if (status === 'inserting') await this.fail(dir, id, undefined, 'Forge stopped during this insert. Studio may still have inserted it (check the parent; Ctrl+Z in Studio undoes it); drop a new request with a new id to try again.')
      await finish()
      return 'skipped'
    }

    const settle = this.deps.settleMs ?? 2000
    const fresh = (mtimeMs: number) => settle > 0 && this.now() - mtimeMs < settle
    const reqStat = await stat(requestPath).catch(() => null)
    if (!reqStat?.isFile()) return 'skipped'
    if (fresh(reqStat.mtimeMs)) return 'deferred'
    if (reqStat.size > MAX_REQUEST_BYTES) return this.fail(dir, id, undefined, 'The request file is larger than 64 KB', finish)
    const parsed = parseInsertRequest(await readFile(requestPath, 'utf8').catch(() => ''))
    if (!parsed.ok) return this.fail(dir, id, undefined, parsed.error, finish)
    const request = parsed.value
    const file = await resolveModelFile(request.file, { baseDir: dir, roots: [dir, this.deps.modelsDir()], maxBytes: INSERT_MAX_BYTES, kind: 'model' })
    const name = basename(request.file)
    if (!file.ok) return this.fail(dir, id, name, file.error, finish)
    if (fresh(file.value.mtimeMs)) return 'deferred'

    // Studio: the window, its plugin version, and whether the bridge is free.
    const waitFor = (why: string): 'deferred' | Promise<'error'> => {
      if (this.now() - reqStat.mtimeMs < (this.deps.waitMs ?? 120_000)) {
        if (!this.waiting.has(id)) {
          this.waiting.add(id)
          this.deps.log(`[model inbox] ${id}: waiting for Studio (${why})`)
        }
        return 'deferred'
      }
      return this.fail(dir, id, name, why, finish)
    }
    const bridge = this.deps.bridge()
    if (!bridge?.listening) return waitFor('the Forge Bridge is not running in Forge')
    const picked = pickWindow(bridge.studios(), request.place, this.deps.projectPlaces())
    if ('error' in picked) {
      // Not a project place, or several project windows: waiting does not fix that.
      if (!picked.wait) return this.fail(dir, id, name, picked.error, finish)
      return waitFor(picked.error)
    }
    const win = picked.window
    const v = win.pluginVersion ?? 0
    if (v < INSERT_PLUGIN_VERSION) return this.fail(dir, id, name, `${windowLabel(win)} runs Forge Bridge v${v || '?'}; restart Studio to load v${INSERT_PLUGIN_VERSION} or newer, which can insert models`, finish)
    const busy = bridge.busy()
    if (busy) return waitFor(`Studio is busy with ${busy.kind} ${busy.name}`)

    // The payload: the file's bytes, and for .rbxmx Forge's own reading of it (the plugin's fallback).
    let bytes: Buffer
    try {
      bytes = await readFile(file.value.abs)
    } catch (error) {
      return this.fail(dir, id, name, `Could not read ${name}: ${(error as Error).message}`, finish)
    }
    const format = modelFormat(name, bytes)
    if (!format.ok) return this.fail(dir, id, name, format.error, finish)
    const blobs: Record<string, string[]> = { bytes: chunkBase64(bytes) }
    if (format.value === 'rbxmx') {
      try {
        blobs.tree = chunkText(JSON.stringify(readRbxmxTree(bytes.toString('utf8')).roots))
      } catch (error) {
        return this.fail(dir, id, name, error instanceof InsertFileError ? error.message : `Could not read ${name}: ${(error as Error).message}`, finish)
      }
    }
    const job = insertJob({
      id: this.deps.newId?.() ?? newJobId(),
      file: name,
      parent: request.parent,
      replace: request.replace,
      format: format.value,
      size: bytes.length,
      blobs: { bytes: blobs.bytes.length, ...(blobs.tree ? { tree: blobs.tree.length } : {}) },
      timeout: Math.min(300, 60 + Math.ceil(bytes.length / (1024 * 1024)) * 10)
    })
    const target: StudioTarget = win.placeId && win.placeId > 0 ? { placeId: win.placeId } : { place: win.place ?? '' }

    this.active.add(id)
    this.waiting.delete(id)
    try {
      await writeJsonAtomic(resultPath, { status: 'inserting' } satisfies InsertResult)
      this.deps.log(`[model inbox] inserting ${name} into ${request.parent.join('.')} in ${windowLabel(win)}`)
      let report: InsertReport | null = null
      try {
        await bridge.run(
          job,
          (ev) => {
            if (ev.type === 'log') report = parseInsertReport(ev.message) ?? report
            return {}
          },
          { target, blobs, acceptTimeoutMs: 15_000, timeoutMs: job.timeout * 1000 }
        )
      } catch (error) {
        if (error instanceof BridgeError && error.code === 'busy') {
          // Another Studio job started in between: nothing was sent; try again on a later pass.
          await rm(resultPath, { force: true }).catch(() => undefined)
          return 'deferred'
        }
        const message = (error as Error).message.replace(/^Studio: /, '')
        return await this.fail(dir, id, name, message, finish)
      }
      const r: InsertReport = report ?? { paths: [], replaced: 0, via: 'serialization', created: [], skipped: [] }
      const insertedAt = new Date(this.now()).toISOString()
      await writeJsonAtomic(resultPath, {
        status: 'done',
        paths: r.paths,
        place: windowLabel(win),
        ...(win.placeId && win.placeId > 0 ? { placeId: win.placeId } : {}),
        ...(picked.projectPlace ? { projectPlace: picked.projectPlace.name } : {}),
        replaced: r.replaced,
        via: r.via,
        insertedAt,
        ...(r.created.length ? { created: r.created } : {}),
        ...(r.skipped.length ? { skipped: r.skipped } : {})
      } satisfies InsertResult)
      await finish()
      this.deps.log(`[model inbox] ${name} -> ${r.paths.join(', ') || request.parent.join('.')} in ${windowLabel(win)}${r.replaced ? ` (replaced ${r.replaced})` : ''} (Ctrl+Z in Studio undoes it)`)
      this.record({ id, name, kind: 'insert', status: 'done', paths: r.paths, at: insertedAt })
      return 'done'
    } finally {
      this.active.delete(id)
    }
  }

  private async fail(dir: string, id: string, name: string | undefined, error: string, finish?: () => Promise<unknown>): Promise<'error'> {
    this.waiting.delete(id)
    await writeJsonAtomic(join(dir, id + INSERT_RESULT_SUFFIX), { status: 'error', error } satisfies InsertResult)
    await finish?.()
    this.deps.log(`[model inbox] insert ${name ?? id} failed: ${error}`, 'stderr')
    this.record({ id, ...(name ? { name } : {}), kind: 'insert', status: 'error', error, at: new Date(this.now()).toISOString() })
    return 'error'
  }

  private record(entry: ModelInboxEntry): void {
    this.entries = [entry, ...this.entries].slice(0, 10)
    this.deps.onResult?.(entry)
  }
}
