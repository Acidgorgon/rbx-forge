// The Forge Bridge job protocol between Forge (an HTTP server on 127.0.0.1) and the Studio plugin
// (resources/studio/ForgeBridge.luau, which polls it with HttpService:RequestAsync).
//
//   GET  /forge-bridge/poll?v=<plugin version>&place=<name>&placeId=<id>
//        -> {"job": BridgeJob} or {"idle": true}; held up to POLL_HOLD_MS while there is no job.
//   GET  /forge-bridge/ping -> {"now": <ms>} (the plugin measures the round trip before "start").
//   GET  /forge-bridge/blob/<jobId>/<name>/<i> -> {"data": "<chunk i of the job's blob <name>>", "n": <chunks>}
//        Only for the running job, once delivered (plugin v14 insert jobs fetch the model file this way:
//        a 20 MB model does not fit one poll answer).
//   POST /forge-bridge/event/<jobId>  body: BridgeEvent -> {"ok": true, ...}
//        Forge holds the answer to "calibrate", "ready" and "beat" until it has grabbed the frame, so
//        the plugin only moves on once the capture is done.
//
// Studio plugins may call programs on the same machine through localhost / 127.0.0.1 (Creator Hub,
// "HTTP service": https://create.roblox.com/docs/cloud-services/http-service); Studio may ask the
// user once to allow the plugin to talk to that address (Plugin Management lists the permission).
// No secrets travel here: jobs carry generated Luau and keyframes, events carry timings.

export const BRIDGE_VERSION = 1
export const POLL_HOLD_MS = 5000
// The plugin counts as connected while it polled within this window.
export const CONNECTED_MS = 15_000

export type Vec3 = [number, number, number]

// A script or folder the plugin creates under the job folder before requiring `entry`.
export interface BridgeModule {
  name: string
  className: 'ModuleScript' | 'Folder'
  source?: string
  children?: BridgeModule[]
}

// Plain instance data (a KeyframeSequence) built by the plugin with Instance.new.
export type PropJson =
  | { t: 'string'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'number'; v: number }
  | { t: 'token'; v: number }
  | { t: 'cframe'; v: number[] }
  | { t: 'vector3'; v: Vec3 }
  | { t: 'color3'; v: Vec3 }
  // Plugin v14 (insert jobs built from an .rbxmx): more value types, and references between the
  // job's own instances (`ref` names another node's `ref`).
  | { t: 'vector2'; v: [number, number] }
  | { t: 'udim'; v: [number, number] }
  | { t: 'udim2'; v: [number, number, number, number] }
  | { t: 'range'; v: [number, number] }
  | { t: 'nseq'; v: [number, number, number][] }
  | { t: 'cseq'; v: [number, number, number, number][] }
  | { t: 'ref'; v: string }

export interface InstanceJson {
  className: string
  name: string
  props: Record<string, PropJson>
  children: InstanceJson[]
  // Plugin v14 (insert jobs): this node's referent (for `ref` props), attributes and CollectionService tags.
  ref?: string
  attributes?: Record<string, string | number | boolean>
  tags?: string[]
}

// Plugin v14 insert job: put a Roblox model file (.rbxm / .rbxmx) from the inbox into the place.
export interface BridgeInsert {
  // Where it goes: a service, then child names (missing ones after the service are created as Folders).
  parent: string[]
  // Remove the parent's existing children named like an inserted root first.
  replace: boolean
  // The file's own format; the plugin reads blob "bytes" (base64 chunks of the file) with
  // SerializationService:DeserializeInstancesAsync, and for .rbxmx falls back to blob "tree"
  // (JSON text chunks of InstanceJson[] Forge read from the XML) when Studio will not read XML.
  format: 'rbxm' | 'rbxmx'
  file: string
  size: number
  blobs: { bytes: number; tree?: number }
}

export interface BridgeCamera {
  // Studs, relative to the stage origin (the dummy's feet; the dummy faces -Z), like the previews.
  pos: Vec3
  target: Vec3
  fov: number
}

export interface BridgeBeat {
  t: number
  label: string
}

export interface BridgeJob {
  id: string
  version: number
  // snapshot (Thumbnail Lab): no stage, no camera change; capture the user's current viewport.
  // delete (plugin v7): the Game tab's user-confirmed "Delete in Studio" of `target`; no stage.
  // model (plugin v10): the Model Lab's "Build in Studio": requires `entry` (the build script, next
  // to its BlockyKit module) and builds a Model in Workspace in front of the camera; no stage.
  // insert (plugin v14): the inbox's <id>.insert.json: `insert` says what goes where; no stage.
  kind: 'vfx' | 'anim' | 'ability' | 'snapshot' | 'delete' | 'model' | 'insert'
  // realtime: play once at full speed, Forge records the window and picks the frames nearest each
  // beat. stepped: the plugin poses the rig at each beat (Animator:StepAnimations) and waits.
  mode: 'realtime' | 'stepped'
  name: string
  rig: 'R15' | 'R6'
  duration: number
  beats: BridgeBeat[]
  camera: BridgeCamera
  modules: BridgeModule[]
  // The module the plugin requires and plays (vfx: Effect.play(cframe, parent, {onStage});
  // ability: Move.play(rig, {camera = false, onMarker})).
  entry?: string
  // Path (under the job folder) of the folder of VFX modules the AbilityRunner looks in.
  vfxFolder?: string
  // KeyframeSequence for the rig (anim jobs, and the move's clip for abilities).
  sequence?: InstanceJson
  // Show a full-viewport key colour first so Forge can find the viewport in the window capture.
  calibrate: boolean
  key: Vec3
  // Seconds the plugin keeps the stage after the play ends (particles still alive).
  linger: number
  // Seconds before the plugin gives up on the job.
  timeout: number
  // delete jobs: the Studio-only instance to remove (its class guards against a stale Game tab).
  target?: { path: string[]; className?: string }
  // model jobs: an existing guard Model (path from game) whose gameplay pieces the build copies.
  model?: { guard?: string[]; areaId?: string }
  // insert jobs (plugin v14).
  insert?: BridgeInsert
}

export type BridgeEvent =
  | { type: 'accepted' }
  | { type: 'calibrate' }
  | { type: 'ready' }
  | { type: 'start'; elapsed: number; rtt: number }
  | { type: 'beat'; index: number; t: number }
  | { type: 'mark'; label: string; t: number }
  | { type: 'done'; marks: { label: string; t: number }[] }
  | { type: 'error'; message: string }
  | { type: 'log'; message: string }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// Validates an event body from the plugin (anything else is answered with 400).
export function parseEvent(raw: unknown): BridgeEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  switch (r.type) {
    case 'accepted':
    case 'calibrate':
    case 'ready':
      return { type: r.type }
    case 'start': {
      const elapsed = num(r.elapsed)
      const rtt = num(r.rtt)
      if (elapsed === null || elapsed < 0 || elapsed > 30) return null
      return { type: 'start', elapsed, rtt: rtt !== null && rtt >= 0 && rtt < 10_000 ? rtt : 0 }
    }
    case 'beat': {
      const index = num(r.index)
      const t = num(r.t)
      if (index === null || t === null || index < 0 || index > 64 || !Number.isInteger(index)) return null
      return { type: 'beat', index, t }
    }
    case 'mark': {
      const t = num(r.t)
      if (typeof r.label !== 'string' || t === null) return null
      return { type: 'mark', label: r.label.slice(0, 60), t }
    }
    case 'done': {
      const marks = Array.isArray(r.marks)
        ? (r.marks as unknown[])
            .map((m) => m as Record<string, unknown>)
            .filter((m) => m && typeof m.label === 'string' && num(m.t) !== null)
            .slice(0, 64)
            .map((m) => ({ label: String(m.label).slice(0, 60), t: Number(m.t) }))
        : []
      return { type: 'done', marks }
    }
    case 'error':
    case 'log':
      // 'log' carries data from read-only jobs (texture harvest, mesh read): up to 64 KB.
      return { type: r.type, message: String(r.message ?? '').slice(0, r.type === 'log' ? 65_536 : 2000) }
    default:
      return null
  }
}

export function newJobId(rand: () => number = Math.random): string {
  return `job-${Date.now().toString(36)}-${Math.floor(rand() * 1e9).toString(36)}`
}
