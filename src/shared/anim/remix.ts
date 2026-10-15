// Remix: start from the closest real clip in the library and edit it instead of writing keys from
// scratch. Motion stays human because the keys come from a recorded (mocap / hand-keyed) clip; the
// model (or a keyword heuristic) only plans a short list of deterministic edit operations, and the
// critic loop tunes their parameters. Pure code: no model, no electron, no Lune.
//
// Operations (RemixOp), applied in order to the base clip:
//   speed      overall speed (factor > 1 is faster)
//   stretch    per-beat retime: scale the anticipation / action / recovery spans (measure.ts phases)
//   mirror     swap left and right (R15 and R6), reflecting every joint across the character's YZ plane
//   trim       keep a time range (fractions of the clip)
//   amplitude  scale rotation offsets from the rest pose for a body part ("bigger leg swing")
//   blend      first part of this clip into the rest of another, with an eased crossfade window
//   loop       crossfade the end into the start so the clip loops seamlessly
//   hold       freeze the pose at a time for a while
//   transplant take a body part's tracks from another clip (legs from one, upper-body lean from another)
//
// All ops run on the "neutral" tracks (R15 joint names, the plain joint frame; R6 clips are mapped
// losslessly with convert.ts and mapped back at the end), so mirror and amplitude mean the same on
// both rigs. Keys stay valid: sorted unique times inside [0, duration], unit quaternions (CFrames are
// re-built from normalized rotations), easing kept where a key survives.

import type { AnimBeat, AnimChange, AnimClip, AnimCritique, AnimEntry, AnimKey, AnimMarker, R15Joint, RigType } from './model.ts'
import { R15_JOINTS } from './model.ts'
import { qaxis, qnorm, qslerp, vlerp, xfToCf, type Quat, type V3, type Xf } from './math.ts'
import { clipRig, keyXf, normalizeKeys, sampleTrack } from './sample.ts'
import { convertClip, neutralToR6Tracks, r6TracksToR15 } from './convert.ts'
import { phases } from './measure.ts'
import { jointRange } from './bodyparts.ts'
import { setPromptTags, type MoveSetDef } from './movesets.ts'

// ------------------------------------------------------------------ ops

export const REMIX_PARTS = ['all', 'legs', 'arms', 'upper', 'lower', 'torso', 'head', 'leftLeg', 'rightLeg', 'leftArm', 'rightArm'] as const
export type RemixPart = (typeof REMIX_PARTS)[number]

export const REMIX_OPS = ['speed', 'stretch', 'mirror', 'trim', 'amplitude', 'blend', 'loop', 'hold', 'transplant'] as const
export type RemixOpKind = (typeof REMIX_OPS)[number]

export type RemixOp =
  | { op: 'speed'; factor: number; why?: string }
  | { op: 'stretch'; anticipation: number; action: number; recovery: number; why?: string }
  | { op: 'mirror'; why?: string }
  | { op: 'trim'; from: number; to: number; why?: string }
  | { op: 'amplitude'; part: RemixPart; scale: number; why?: string }
  | { op: 'blend'; clip: string; at: number; window: number; from?: number; why?: string }
  | { op: 'loop'; window: number; why?: string }
  | { op: 'hold'; at: number; duration: number; why?: string }
  | { op: 'transplant'; clip: string; part: RemixPart; why?: string }

// Where a remixed entry came from (AnimEntry.remix): reproducible from the base clip and the ops.
export interface RemixOrigin {
  base: string
  baseName: string
  ops: RemixOp[]
  // Who planned the current ops: the model, the keyword heuristic, the critic loop, or the user.
  source: 'model' | 'heuristic' | 'critic' | 'user'
  // Names of the other clips the ops reference (blend / transplant), for display.
  clips?: Record<string, string>
}

// Numeric parameters with their ranges (validation clamps to these; the detail panel draws sliders).
export interface RemixParam {
  key: string
  label: string
  min: number
  max: number
  step: number
  def: number
  unit?: string
}

export const REMIX_PARAMS: Record<RemixOpKind, RemixParam[]> = {
  speed: [{ key: 'factor', label: 'speed', min: 0.25, max: 4, step: 0.05, def: 1.25, unit: '×' }],
  stretch: [
    { key: 'anticipation', label: 'anticipation', min: 0.25, max: 4, step: 0.05, def: 1, unit: '×' },
    { key: 'action', label: 'action', min: 0.25, max: 4, step: 0.05, def: 1, unit: '×' },
    { key: 'recovery', label: 'recovery', min: 0.25, max: 4, step: 0.05, def: 1, unit: '×' }
  ],
  mirror: [],
  trim: [
    { key: 'from', label: 'from', min: 0, max: 0.95, step: 0.01, def: 0, unit: 'of clip' },
    { key: 'to', label: 'to', min: 0.05, max: 1, step: 0.01, def: 1, unit: 'of clip' }
  ],
  amplitude: [{ key: 'scale', label: 'amount', min: 0, max: 2.5, step: 0.05, def: 1.25, unit: '×' }],
  blend: [
    { key: 'at', label: 'switch at', min: 0.05, max: 0.95, step: 0.01, def: 0.5, unit: 'of this clip' },
    { key: 'from', label: 'other from', min: 0, max: 0.95, step: 0.01, def: 0.5, unit: 'of other clip' },
    { key: 'window', label: 'crossfade', min: 0, max: 1, step: 0.01, def: 0.2, unit: 's' }
  ],
  loop: [{ key: 'window', label: 'crossfade', min: 0.05, max: 1, step: 0.01, def: 0.25, unit: 's' }],
  hold: [
    { key: 'at', label: 'at', min: 0, max: 1, step: 0.01, def: 0.5, unit: 'of clip' },
    { key: 'duration', label: 'hold', min: 0.02, max: 1.5, step: 0.01, def: 0.12, unit: 's' }
  ],
  transplant: []
}

export const MAX_REMIX_OPS = 8

export const REMIX_PART_LABEL: Record<RemixPart, string> = {
  all: 'whole body',
  legs: 'legs',
  arms: 'arms',
  upper: 'upper body',
  lower: 'lower body',
  torso: 'torso',
  head: 'head',
  leftLeg: 'left leg',
  rightLeg: 'right leg',
  leftArm: 'left arm',
  rightArm: 'right arm'
}

const LEGS_L: R15Joint[] = ['LeftHip', 'LeftKnee', 'LeftAnkle']
const LEGS_R: R15Joint[] = ['RightHip', 'RightKnee', 'RightAnkle']
const ARMS_L: R15Joint[] = ['LeftShoulder', 'LeftElbow', 'LeftWrist']
const ARMS_R: R15Joint[] = ['RightShoulder', 'RightElbow', 'RightWrist']

// The (R15-named, neutral) joints of a part. On R6 only Root, Neck, shoulders and hips exist.
export const REMIX_PART_JOINTS: Record<RemixPart, R15Joint[]> = {
  all: [...R15_JOINTS],
  legs: [...LEGS_L, ...LEGS_R],
  arms: [...ARMS_L, ...ARMS_R],
  upper: ['Waist', 'Neck', ...ARMS_L, ...ARMS_R],
  lower: ['Root', ...LEGS_L, ...LEGS_R],
  torso: ['Root', 'Waist'],
  head: ['Neck'],
  leftLeg: LEGS_L,
  rightLeg: LEGS_R,
  leftArm: ARMS_L,
  rightArm: ARMS_R
}

export class RemixPlanError extends Error {}

const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const r3 = (v: number) => Math.round(v * 1000) / 1000

function num(raw: unknown, p: RemixParam, op: string): number {
  if (raw === undefined || raw === null || raw === '') return p.def
  const x = Number(raw)
  if (!Number.isFinite(x)) throw new RemixPlanError(`${op}.${p.key} must be a number`)
  // Snap to the slider step so a model's 1.2999999 and a slider's 1.3 compare equal.
  return r3(clampN(Math.round(x / p.step) * p.step, p.min, p.max))
}

const param = (op: RemixOpKind, key: string) => REMIX_PARAMS[op].find((p) => p.key === key)!

const PART_ALIASES: Record<string, RemixPart> = {
  whole: 'all', body: 'all', everything: 'all', full: 'all',
  leg: 'legs', feet: 'legs', foot: 'legs', lower_body: 'lower', lowerbody: 'lower', hips: 'lower',
  arm: 'arms', hands: 'arms', hand: 'arms', upper_body: 'upper', upperbody: 'upper', chest: 'upper', spine: 'torso', waist: 'torso', neck: 'head',
  left_leg: 'leftLeg', leftleg: 'leftLeg', right_leg: 'rightLeg', rightleg: 'rightLeg', left_arm: 'leftArm', leftarm: 'leftArm', right_arm: 'rightArm', rightarm: 'rightArm'
}

export function remixPart(raw: unknown): RemixPart | null {
  const s = String(raw ?? '').trim()
  if ((REMIX_PARTS as readonly string[]).includes(s)) return s as RemixPart
  const k = s.toLowerCase().replace(/[\s-]+/g, '_')
  if ((REMIX_PARTS as readonly string[]).includes(k)) return k as RemixPart
  return PART_ALIASES[k] ?? PART_ALIASES[k.replace(/_/g, '')] ?? null
}

// Raw JSON (a model, the UI) -> a valid op with clamped params (throws RemixPlanError with the reason).
// clips: the ids blend / transplant may name (when given, others are rejected).
export function normalizeRemixOp(raw: unknown, opts: { clips?: string[] } = {}): RemixOp {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const kind = String(r.op ?? r.kind ?? '').toLowerCase() as RemixOpKind
  const why = typeof r.why === 'string' && r.why.trim() ? { why: r.why.trim().slice(0, 200) } : {}
  const clipId = () => {
    const id = String(r.clip ?? r.with ?? '').trim()
    if (!id) throw new RemixPlanError(`${kind}: name the other clip (clip: <library id>)`)
    if (opts.clips && !opts.clips.includes(id)) throw new RemixPlanError(`${kind}: unknown clip "${id}" (use one of ${opts.clips.slice(0, 6).join(', ') || 'no other clips'})`)
    return id
  }
  const part = () => {
    const p = remixPart(r.part ?? 'all')
    if (!p) throw new RemixPlanError(`${kind}: part must be one of ${REMIX_PARTS.join(', ')}`)
    return p
  }
  switch (kind) {
    case 'speed':
      return { op: 'speed', factor: num(r.factor ?? r.scale, param('speed', 'factor'), kind), ...why }
    case 'stretch':
      return { op: 'stretch', anticipation: num(r.anticipation, param('stretch', 'anticipation'), kind), action: num(r.action, param('stretch', 'action'), kind), recovery: num(r.recovery, param('stretch', 'recovery'), kind), ...why }
    case 'mirror':
      return { op: 'mirror', ...why }
    case 'trim': {
      const from = num(r.from, param('trim', 'from'), kind)
      const to = Math.max(from + 0.05, num(r.to, param('trim', 'to'), kind))
      return { op: 'trim', from, to: r3(Math.min(1, to)), ...why }
    }
    case 'amplitude':
      return { op: 'amplitude', part: part(), scale: num(r.scale ?? r.factor, param('amplitude', 'scale'), kind), ...why }
    case 'blend': {
      const at = num(r.at, param('blend', 'at'), kind)
      return { op: 'blend', clip: clipId(), at, window: num(r.window, param('blend', 'window'), kind), from: r.from === undefined ? at : num(r.from, param('blend', 'from'), kind), ...why }
    }
    case 'loop':
      return { op: 'loop', window: num(r.window, param('loop', 'window'), kind), ...why }
    case 'hold':
      return { op: 'hold', at: num(r.at, param('hold', 'at'), kind), duration: num(r.duration, param('hold', 'duration'), kind), ...why }
    case 'transplant':
      return { op: 'transplant', clip: clipId(), part: part(), ...why }
    default:
      throw new RemixPlanError(`unknown op "${String(r.op ?? r.kind ?? '')}" (${REMIX_OPS.join(', ')})`)
  }
}

// A plan ({ ops: [...] } or a bare list) -> valid ops (at most MAX_REMIX_OPS) and the rejected ones.
export function normalizeRemixPlan(raw: unknown, opts: { clips?: string[] } = {}): { ops: RemixOp[]; rejected: { op: unknown; reason: string }[] } {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { ops?: unknown }).ops) ? (raw as { ops: unknown[] }).ops : null
  if (!list) throw new RemixPlanError('the plan must be {"ops": [...]}')
  const ops: RemixOp[] = []
  const rejected: { op: unknown; reason: string }[] = []
  for (const x of list) {
    if (ops.length >= MAX_REMIX_OPS) {
      rejected.push({ op: x, reason: `at most ${MAX_REMIX_OPS} ops` })
      continue
    }
    try {
      ops.push(normalizeRemixOp(x, opts))
    } catch (e) {
      rejected.push({ op: x, reason: (e as Error).message })
    }
  }
  return { ops, rejected }
}

// A model's answer (JSON, possibly fenced) -> plan.
export function parseRemixPlan(raw: string, opts: { clips?: string[] } = {}): { ops: RemixOp[]; rejected: { op: unknown; reason: string }[] } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
  const text = fenced ? fenced[1] : raw
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  const la = text.indexOf('[')
  let data: unknown
  try {
    data = la >= 0 && (a < 0 || la < a) ? JSON.parse(text.slice(la, text.lastIndexOf(']') + 1)) : JSON.parse(text.slice(a, b + 1))
  } catch {
    throw new RemixPlanError('the plan is not JSON')
  }
  return normalizeRemixPlan(data, opts)
}

const fmt = (v: number) => (Math.round(v * 100) / 100).toString()
const pct = (v: number) => `${Math.round(v * 100)}%`

export function describeRemixOp(op: RemixOp, names: Record<string, string> = {}): string {
  const other = (id: string) => `"${names[id] ?? id}"`
  switch (op.op) {
    case 'speed':
      return `speed ×${fmt(op.factor)}`
    case 'stretch':
      return `retime beats: anticipation ×${fmt(op.anticipation)}, action ×${fmt(op.action)}, recovery ×${fmt(op.recovery)}`
    case 'mirror':
      return 'mirror left / right'
    case 'trim':
      return `trim to ${pct(op.from)}–${pct(op.to)}`
    case 'amplitude':
      return `${REMIX_PART_LABEL[op.part]} amplitude ×${fmt(op.scale)}`
    case 'blend':
      return `blend into ${other(op.clip)} at ${pct(op.at)} (from its ${pct(op.from ?? op.at)}, ${fmt(op.window)} s crossfade)`
    case 'loop':
      return `loop (${fmt(op.window)} s crossfade)`
    case 'hold':
      return `hold ${fmt(op.duration)} s at ${pct(op.at)}`
    case 'transplant':
      return `${REMIX_PART_LABEL[op.part]} from ${other(op.clip)}`
  }
}

// ------------------------------------------------------------------ working clip (neutral tracks)

type Tracks = Partial<Record<R15Joint, AnimKey[]>>

interface Work {
  duration: number
  looped: boolean
  tracks: Tracks
  markers: AnimMarker[]
  beats: AnimBeat[]
}

const rt = (t: number) => Math.round(t * 10000) / 10000

function toWork(clip: AnimClip): Work {
  const tracks: Tracks = clipRig(clip) === 'R6' ? r6TracksToR15(clip.tracks) : { ...(clip.tracks as Tracks) }
  return { duration: clip.duration, looped: clip.looped, tracks, markers: clip.markers.map((m) => ({ ...m })), beats: (clip.beats ?? []).map((b) => ({ ...b })) }
}

// The same joints / rig as `like`, from the working tracks. Keys are cleaned (sorted, unique, inside
// the clip, normalized rotations).
function fromWork(w: Work, like: AnimClip): AnimClip {
  const D = Math.max(0.03, rt(w.duration))
  const clean: Tracks = {}
  for (const [j, keys] of Object.entries(w.tracks) as [R15Joint, AnimKey[]][]) {
    if (!keys?.length) continue
    const ks = normalizeKeys(keys.map((k) => ({ ...k, t: rt(clampN(k.t, 0, D)), cf: xfToCf(normXf(keyXf(k))) })))
    if (ks.length) clean[j] = ks
  }
  const tracks = clipRig(like) === 'R6' ? (neutralToR6Tracks(clean) as AnimClip['tracks']) : clean
  const markers = w.markers.filter((m) => m.t >= -1e-6 && m.t <= D + 1e-6).map((m) => ({ ...m, t: rt(clampN(m.t, 0, D)) })).sort((a, b) => a.t - b.t)
  const beats = w.beats.filter((b) => b.at >= -1e-6 && b.at <= D + 1e-6).map((b) => ({ ...b, at: rt(clampN(b.at, 0, D)) })).sort((a, b) => a.at - b.at)
  const out: AnimClip = { ...like, duration: D, looped: w.looped, tracks, markers, ...(beats.length ? { beats } : {}) }
  if (!beats.length) delete out.beats
  // Remixed keys are no longer what the script records.
  delete out.script
  delete out.patches
  return out
}

const normXf = (x: Xf): Xf => ({ p: x.p, q: qnorm(x.q) })
const keyOf = (t: number, x: Xf, ease?: AnimKey['ease'], dir?: AnimKey['dir']): AnimKey => ({ t: rt(t), cf: xfToCf(normXf(x)), ...(ease ? { ease } : {}), ...(dir ? { dir } : {}) })
const IDENT: Xf = { p: [0, 0, 0], q: [0, 0, 0, 1] }
const sampleOr = (keys: AnimKey[] | undefined, t: number): Xf => sampleTrack(keys, t) ?? IDENT

// The key a time falls after (its easing shapes the segment the time is in).
function keyBefore(keys: AnimKey[], t: number): AnimKey | undefined {
  let k: AnimKey | undefined
  for (const x of keys) {
    if (x.t <= t + 1e-9) k = x
    else break
  }
  return k
}

const smooth = (x: number) => {
  const t = clampN(x, 0, 1)
  return t * t * (3 - 2 * t)
}

function blendXf(a: Xf, b: Xf, w: number): Xf {
  return { p: vlerp(a.p, b.p, w) as V3, q: qslerp(qnorm(a.q), qnorm(b.q), w) }
}

// ------------------------------------------------------------------ retime

// Maps every key, marker and beat through a monotonic time map (key count and order are kept).
function retimeWork(w: Work, f: (t: number) => number): Work {
  const tracks: Tracks = {}
  for (const [j, keys] of Object.entries(w.tracks) as [R15Joint, AnimKey[]][]) tracks[j] = keys.map((k) => ({ ...k, t: rt(f(k.t)) }))
  return { ...w, duration: f(w.duration), tracks, markers: w.markers.map((m) => ({ ...m, t: rt(f(m.t)) })), beats: w.beats.map((b) => ({ ...b, at: rt(f(b.at)) })) }
}

// Piecewise-linear time map scaling [0, a0], [a0, a1], [a1, D] by s0, s1, s2.
export function beatTimeMap(D: number, a0: number, a1: number, s: [number, number, number]): (t: number) => number {
  const e0 = a0 * s[0]
  const e1 = e0 + (a1 - a0) * s[1]
  return (t) => (t <= a0 ? t * s[0] : t <= a1 ? e0 + (t - a0) * s[1] : e1 + (t - a1) * s[2])
}

// The anticipation / action / recovery boundaries of a clip (falls back to thirds for a still clip).
export function clipBeatSpans(clip: AnimClip): { a0: number; a1: number } {
  const D = clip.duration
  const ph = phases(clip)
  let a0 = ph.actionStart
  let a1 = ph.actionEnd
  if (!(a1 > a0) || a1 - a0 < 1e-3) {
    a0 = D / 3
    a1 = (2 * D) / 3
  }
  return { a0: clampN(a0, 0, D), a1: clampN(a1, 0, D) }
}

// ------------------------------------------------------------------ mirror

const MIRROR: Partial<Record<R15Joint, R15Joint>> = {}
for (const j of R15_JOINTS) {
  if (j.startsWith('Left')) MIRROR[j] = j.replace(/^Left/, 'Right') as R15Joint
  else if (j.startsWith('Right')) MIRROR[j] = j.replace(/^Right/, 'Left') as R15Joint
}

// Reflection across the character's YZ plane (x -> -x): positions negate x; a rotation's axis is a
// pseudovector, so (qx, qy, qz) -> (qx, -qy, -qz).
export function mirrorXf(x: Xf): Xf {
  return { p: [-x.p[0], x.p[1], x.p[2]], q: [x.q[0], -x.q[1], -x.q[2], x.q[3]] }
}

function mirrorWork(w: Work): Work {
  const tracks: Tracks = {}
  for (const [j, keys] of Object.entries(w.tracks) as [R15Joint, AnimKey[]][]) {
    tracks[MIRROR[j] ?? j] = keys.map((k) => ({ ...k, cf: xfToCf(mirrorXf(keyXf(k))) }))
  }
  const swap = (s: string) => s.replace(/\b(left|right|Left|Right|LEFT|RIGHT)/g, (m) => ({ left: 'right', right: 'left', Left: 'Right', Right: 'Left', LEFT: 'RIGHT', RIGHT: 'LEFT' })[m] ?? m)
  return { ...w, tracks, markers: w.markers.map((m) => ({ ...m, name: swap(m.name) })), beats: w.beats.map((b) => ({ ...b, label: swap(b.label) })) }
}

// ------------------------------------------------------------------ trim / hold / loop

function trimWork(w: Work, from: number, to: number): Work {
  const D = w.duration
  const t0 = clampN(from, 0, 1) * D
  const t1 = Math.max(t0 + 0.03, clampN(to, 0, 1) * D)
  const tracks: Tracks = {}
  for (const [j, keys] of Object.entries(w.tracks) as [R15Joint, AnimKey[]][]) {
    if (!keys.length) continue
    const head = keyBefore(keys, t0)
    const mid = keys.filter((k) => k.t > t0 + 1e-6 && k.t < t1 - 1e-6).map((k) => ({ ...k, t: k.t - t0 }))
    const tail = keyBefore(keys, t1)
    tracks[j] = [keyOf(0, sampleOr(keys, t0), head?.ease, head?.dir), ...mid, keyOf(t1 - t0, sampleOr(keys, t1), tail?.ease, tail?.dir)]
  }
  const inside = (t: number) => t >= t0 - 1e-6 && t <= t1 + 1e-6
  return { duration: t1 - t0, looped: false, tracks, markers: w.markers.filter((m) => inside(m.t)).map((m) => ({ ...m, t: m.t - t0 })), beats: w.beats.filter((b) => inside(b.at)).map((b) => ({ ...b, at: b.at - t0 })) }
}

function holdWork(w: Work, at: number, duration: number): Work {
  const T = clampN(at, 0, 1) * w.duration
  const d = Math.max(0, duration)
  if (d < 1e-4) return w
  const tracks: Tracks = {}
  for (const [j, keys] of Object.entries(w.tracks) as [R15Joint, AnimKey[]][]) {
    if (!keys.length) continue
    const seg = keyBefore(keys, T)
    const pose = sampleOr(keys, T)
    const before = keys.filter((k) => k.t < T - 1e-6)
    const after = keys.filter((k) => k.t > T + 1e-6).map((k) => ({ ...k, t: k.t + d }))
    // The frozen span is Linear between two equal poses; the second key carries the original easing on.
    tracks[j] = [...before, keyOf(T, pose, 'Linear', 'In'), keyOf(T + d, pose, seg?.ease, seg?.dir), ...after]
  }
  const shift = (t: number) => (t > T + 1e-6 ? t + d : t)
  return { ...w, duration: w.duration + d, tracks, markers: w.markers.map((m) => ({ ...m, t: shift(m.t) })), beats: w.beats.map((b) => ({ ...b, at: shift(b.at) })) }
}

const WINDOW_FPS = 30

function loopWork(w: Work, window: number): Work {
  const D = w.duration
  const win = clampN(window, 0.02, D * 0.5)
  const ws = D - win
  const n = Math.max(2, Math.ceil(win * WINDOW_FPS))
  const tracks: Tracks = {}
  for (const [j, keys] of Object.entries(w.tracks) as [R15Joint, AnimKey[]][]) {
    if (!keys.length) continue
    const start = sampleOr(keys, 0)
    const out = keys.filter((k) => k.t < ws - 1e-6)
    out.push(keyOf(ws, sampleOr(keys, ws), 'Linear', 'In'))
    for (let i = 1; i <= n; i++) {
      const t = ws + (win * i) / n
      out.push(keyOf(t, i === n ? start : blendXf(sampleOr(keys, t), start, smooth(i / n)), 'Linear', 'In'))
    }
    tracks[j] = out
  }
  return { ...w, looped: true, tracks }
}

// ------------------------------------------------------------------ amplitude

// Rotation q raised to a power (the same axis, angle times s; capped below a half turn).
export function qscale(q: Quat, s: number): Quat {
  let [x, y, z, w] = qnorm(q)
  if (w < 0) [x, y, z, w] = [-x, -y, -z, -w]
  const angle = 2 * Math.acos(Math.min(1, w))
  const sh = Math.sin(angle / 2)
  if (angle < 1e-9 || sh < 1e-9) return [x, y, z, w]
  const a = Math.min(Math.PI * 0.97, angle * Math.max(0, s))
  return qaxis([x / sh, y / sh, z / sh], a)
}

function amplitudeWork(w: Work, part: RemixPart, scale: number): Work {
  if (Math.abs(scale - 1) < 1e-9) return w
  const joints = new Set(REMIX_PART_JOINTS[part])
  const tracks: Tracks = { ...w.tracks }
  for (const [j, keys] of Object.entries(w.tracks) as [R15Joint, AnimKey[]][]) {
    if (!joints.has(j)) continue
    tracks[j] = keys.map((k) => {
      const x = keyXf(k)
      return { ...k, cf: xfToCf({ p: [x.p[0] * scale, x.p[1] * scale, x.p[2] * scale], q: qscale(x.q, scale) }) }
    })
  }
  return { ...w, tracks }
}

// ------------------------------------------------------------------ blend / transplant

// This clip until `at` (fraction of it), then the other clip from `from` (fraction of it) on, with a
// smoothstep crossfade of `window` seconds centred on the switch. At the window edges the result is
// exactly the outgoing / incoming clip.
function blendWork(a: Work, b: Work, at: number, window: number, from: number): Work {
  const tA = clampN(at, 0, 1) * a.duration
  const tB = clampN(from, 0, 1) * b.duration
  const restB = Math.max(0.03, b.duration - tB)
  const half = clampN(window / 2, 0, Math.min(tA, restB, a.duration - tA + restB))
  const ws = tA - half
  const we = tA + half
  const toB = (t: number) => t - tA + tB
  const duration = tA + restB
  const joints = new Set<R15Joint>([...(Object.keys(a.tracks) as R15Joint[]), ...(Object.keys(b.tracks) as R15Joint[])])
  const n = Math.max(2, Math.ceil((we - ws) * WINDOW_FPS))
  const tracks: Tracks = {}
  for (const j of joints) {
    const ka = a.tracks[j] ?? []
    const kb = b.tracks[j] ?? []
    const out: AnimKey[] = ka.filter((k) => k.t < ws - 1e-6)
    if (half > 1e-6) {
      for (let i = 0; i <= n; i++) {
        const t = ws + ((we - ws) * i) / n
        const x = i === 0 ? sampleOr(ka, t) : i === n ? sampleOr(kb, toB(t)) : blendXf(sampleOr(ka, t), sampleOr(kb, toB(t)), smooth(i / n))
        // The last window key carries the incoming clip's easing on.
        const seg = i === n ? keyBefore(kb, toB(t)) : undefined
        out.push(keyOf(t, x, i === n ? seg?.ease : 'Linear', i === n ? seg?.dir : 'In'))
      }
    } else {
      const seg = keyBefore(kb, tB)
      out.push(keyOf(tA, sampleOr(kb, tB), seg?.ease, seg?.dir))
    }
    for (const k of kb) if (k.t - tB + tA > we + 1e-6) out.push({ ...k, t: k.t - tB + tA })
    tracks[j] = out
  }
  return {
    duration,
    looped: a.looped && b.looped,
    tracks,
    markers: [...a.markers.filter((m) => m.t <= tA), ...b.markers.filter((m) => m.t > tB).map((m) => ({ ...m, t: m.t - tB + tA }))],
    beats: [...a.beats.filter((x) => x.at <= tA), ...b.beats.filter((x) => x.at > tB).map((x) => ({ ...x, at: x.at - tB + tA }))]
  }
}

// The part's tracks from the other clip, stretched to this clip's length (its beats line up with
// this clip's start and end). Every other joint is left exactly as it was.
function transplantWork(a: Work, b: Work, part: RemixPart): Work {
  const joints = REMIX_PART_JOINTS[part]
  const s = b.duration > 1e-6 ? a.duration / b.duration : 1
  const tracks: Tracks = { ...a.tracks }
  for (const j of joints) {
    const kb = b.tracks[j]
    if (kb?.length) tracks[j] = kb.map((k) => ({ ...k, t: k.t * s }))
    else delete tracks[j]
  }
  return { ...a, tracks }
}

// ------------------------------------------------------------------ apply

export interface RemixResult {
  clip: AnimClip
  applied: RemixOp[]
  skipped: { op: RemixOp; reason: string }[]
}

function sameRig(clip: AnimClip, rig: RigType): AnimClip {
  return clipRig(clip) === rig ? clip : convertClip(clip, rig)
}

// Applies the ops in order. lookup resolves the other clips blend / transplant name (library ids);
// an op whose clip is missing is skipped with the reason. The result keeps the base clip's rig.
export function applyRemix(base: AnimClip, ops: RemixOp[], lookup: (id: string) => AnimClip | null | undefined = () => null): RemixResult {
  const rig = clipRig(base)
  let w = toWork(base)
  const applied: RemixOp[] = []
  const skipped: { op: RemixOp; reason: string }[] = []
  const asClip = (x: Work) => fromWork(x, base)
  for (const op of ops) {
    try {
      switch (op.op) {
        case 'speed':
          w = retimeWork(w, (t) => t / clampN(op.factor, 0.05, 20))
          break
        case 'stretch': {
          const { a0, a1 } = clipBeatSpans(asClip(w))
          w = retimeWork(w, beatTimeMap(w.duration, a0, a1, [op.anticipation, op.action, op.recovery]))
          break
        }
        case 'mirror':
          w = mirrorWork(w)
          break
        case 'trim':
          w = trimWork(w, op.from, op.to)
          break
        case 'amplitude':
          w = amplitudeWork(w, op.part, op.scale)
          break
        case 'loop':
          w = loopWork(w, op.window)
          break
        case 'hold':
          w = holdWork(w, op.at, op.duration)
          break
        case 'blend':
        case 'transplant': {
          const other = lookup(op.clip)
          if (!other) {
            skipped.push({ op, reason: `clip "${op.clip}" is not in the library` })
            continue
          }
          const b = toWork(sameRig(other, rig))
          w = op.op === 'blend' ? blendWork(w, b, op.at, op.window, op.from ?? op.at) : transplantWork(w, b, op.part)
          break
        }
      }
      applied.push(op)
    } catch (e) {
      skipped.push({ op, reason: (e as Error).message })
    }
  }
  return { clip: asClip(w), applied, skipped }
}

// Every track sorted with unique times inside [0, duration] and valid unit-rotation CFrames.
export function clipKeysValid(clip: AnimClip): string | null {
  for (const [j, keys] of Object.entries(clip.tracks)) {
    let last = -Infinity
    for (const k of keys ?? []) {
      if (!Number.isFinite(k.t) || k.t <= last) return `${j}: times not strictly increasing at ${k.t}`
      if (k.t < -1e-6 || k.t > clip.duration + 1e-6) return `${j}: key at ${k.t} outside 0..${clip.duration}`
      if (!Array.isArray(k.cf) || k.cf.length !== 12 || k.cf.some((v) => !Number.isFinite(v))) return `${j}: bad CFrame`
      const m = k.cf.slice(3)
      for (let r = 0; r < 3; r++) {
        const len = Math.hypot(m[r * 3], m[r * 3 + 1], m[r * 3 + 2])
        if (Math.abs(len - 1) > 1e-3) return `${j}: rotation not orthonormal at ${k.t}`
      }
      last = k.t
    }
  }
  return null
}

// ------------------------------------------------------------------ heuristic plan (no model)

// Which side does the move: the wider-moving leg (or arm when the arms move more).
export function dominantSide(clip: AnimClip): 'left' | 'right' | null {
  const v = r15ViewLite(clip)
  const r = Math.max(jointRange(v, 'RightHip'), jointRange(v, 'RightShoulder'))
  const l = Math.max(jointRange(v, 'LeftHip'), jointRange(v, 'LeftShoulder'))
  if (Math.max(r, l) < 8 || Math.abs(r - l) < Math.max(r, l) * 0.15) return null
  return r > l ? 'right' : 'left'
}

function r15ViewLite(clip: AnimClip): AnimClip {
  return clipRig(clip) === 'R6' ? { ...clip, rig: 'R15', tracks: r6TracksToR15(clip.tracks) } : clip
}

const has = (text: string, re: RegExp) => re.test(text)

// The part a phrase names (for "bigger leg swing", "arms more relaxed").
function partIn(text: string): RemixPart | null {
  const t = text.toLowerCase()
  const side = /\bleft\b/.test(t) ? 'left' : /\bright\b/.test(t) ? 'right' : null
  if (/\b(leg|legs|kick\w*|foot|feet|knee\w*|swing|stride|backswing|follow[\s-]?through)\b/.test(t)) return side === 'left' ? 'leftLeg' : side === 'right' ? 'rightLeg' : 'legs'
  if (/\b(arm|arms|hand|hands|punch\w*|elbow\w*|reach)\b/.test(t)) return side === 'left' ? 'leftArm' : side === 'right' ? 'rightArm' : 'arms'
  if (/\b(lean|torso|upper\s?body|chest|spine|back)\b/.test(t)) return 'upper'
  if (/\b(head|neck)\b/.test(t)) return 'head'
  if (/\b(hips?|lower\s?body)\b/.test(t)) return 'lower'
  return null
}

// Prompt words -> ops: faster / slower, mirror / left / right, bigger / exaggerate, smaller / subtle,
// shorter, loop, hold, longer windup, snappier. The base clip decides whether "left" needs a mirror.
export function heuristicRemixPlan(prompt: string, base: AnimClip): RemixOp[] {
  const t = ` ${String(prompt ?? '').toLowerCase()} `
  const ops: RemixOp[] = []
  const strong = has(t, /\b(much|way|very|super|really|a lot)\b/)
  // Mirror: asked for, or the request names the other side than the clip uses.
  const side = dominantSide(base)
  const wantsLeft = has(t, /\b(left[\s-]?(foot|footed|leg|arm|hand|side)|with the left|lefty|left)\b/) && !has(t, /\bright\b/)
  const wantsRight = has(t, /\b(right[\s-]?(foot|footed|leg|arm|hand|side)|with the right|right)\b/) && !has(t, /\bleft\b/)
  if (has(t, /\b(mirror\w*|flip\w*|other side|opposite side|swap sides?|weak foot)\b/) || (wantsLeft && side === 'right') || (wantsRight && side === 'left')) ops.push({ op: 'mirror', why: 'requested side' })
  // Trim before retiming so fractions refer to the original clip.
  if (has(t, /\b(shorter|trim\w*|cut (the )?(start|end|idle)|crop\w*|tighter|no idle)\b/)) {
    const ph = phases(base)
    const D = Math.max(1e-3, base.duration)
    const from = clampN((ph.motionStart - 0.08) / D, 0, 0.9)
    const to = clampN((ph.motionEnd + 0.12) / D, from + 0.05, 1)
    if (from > 0.02 || to < 0.98) ops.push({ op: 'trim', from: r3(from), to: r3(to), why: 'shorter: cut the still start / end' })
    else ops.push({ op: 'speed', factor: 1.2, why: 'shorter' })
  }
  const windup = has(t, /\b(longer|bigger|more|slower|exaggerated?)\s+(wind[\s-]?up|anticipation|backswing|load)\b/)
  const snappy = has(t, /\b(snappier|snappy|punchier|sharper|explosive|quicker (strike|contact|release))\b/)
  if (windup || snappy) ops.push({ op: 'stretch', anticipation: windup ? 1.4 : 1, action: snappy ? 0.75 : 1, recovery: 1, why: [windup ? 'longer windup' : '', snappy ? 'snappier action' : ''].filter(Boolean).join(', ') })
  if (has(t, /\b(faster|quick(er)?|speed (it )?up|rapid|hurried|fast)\b/) && !has(t, /\bquicker (strike|contact|release)\b/)) ops.push({ op: 'speed', factor: strong ? 1.6 : 1.3, why: 'faster' })
  else if (has(t, /\b(slower|slow(ed)?[\s-]?(down|mo(tion)?)?|heavier|sluggish|relaxed)\b/) && !windup) ops.push({ op: 'speed', factor: strong ? 0.6 : 0.75, why: 'slower' })
  const bigger = has(t, /\b(bigger|exaggerat\w*|more power\w*|wider|huge|extreme|larger|more (swing|extension|lean)|stronger|powerful)\b/)
  const smaller = has(t, /\b(smaller|subtler|subtle|dampen\w*|less|softer|gentle|tone(d)? down|calmer|tighter swing)\b/)
  if (bigger || smaller) {
    const m = (bigger ? /\b(bigger|exaggerat\w*|more|wider|huge|extreme|larger|stronger|powerful)\b(.{0,40})/ : /\b(smaller|subtler|subtle|dampen\w*|less|softer|gentle|calmer)\b(.{0,40})/).exec(t)
    const part = partIn(m?.[2] ?? '') ?? partIn(t) ?? 'all'
    ops.push({ op: 'amplitude', part, scale: bigger ? (strong ? 1.5 : 1.3) : strong ? 0.55 : 0.75, why: bigger ? `bigger ${REMIX_PART_LABEL[part]}` : `subtler ${REMIX_PART_LABEL[part]}` })
  }
  if (has(t, /\b(hold|pause|freeze|linger)\b/)) {
    const ph = phases(base)
    ops.push({ op: 'hold', at: r3(clampN(ph.peakTime / Math.max(1e-3, base.duration), 0, 1)), duration: 0.15, why: 'hold the peak' })
  }
  if (has(t, /\b(loop\w*|cycle|repeat\w*|seamless)\b/) && !base.looped) ops.push({ op: 'loop', window: 0.25, why: 'loop' })
  return normalizeRemixPlan(ops).ops
}

// ------------------------------------------------------------------ critic -> op params

const PART_OF_JOINT = (j: string | undefined): RemixPart | null => {
  if (!j) return null
  if (/^Left(Hip|Knee|Ankle)/.test(j)) return 'leftLeg'
  if (/^Right(Hip|Knee|Ankle)/.test(j)) return 'rightLeg'
  if (/^Left(Shoulder|Elbow|Wrist)/.test(j)) return 'leftArm'
  if (/^Right(Shoulder|Elbow|Wrist)/.test(j)) return 'rightArm'
  if (j === 'Neck') return 'head'
  return 'torso'
}

const BODYPART_TO_REMIX: Record<string, RemixPart> = { RightLeg: 'rightLeg', LeftLeg: 'leftLeg', leg: 'legs', RightArm: 'rightArm', LeftArm: 'leftArm', arm: 'arms', head: 'head', torso: 'torso' }

const sameOps = (a: RemixOp[], b: RemixOp[]) => JSON.stringify(a) === JSON.stringify(b)

// The critic's verdict -> new op params (no new keys): a named part that barely moves gets more
// amplitude; retimes of the anticipation / action / recovery spans scale that beat's stretch. Returns
// null when nothing maps (the loop stops with "no changes").
export function adjustRemixOps(ops: RemixOp[], critique: Pick<AnimCritique, 'changes' | 'checks'>, current: AnimClip): RemixOp[] | null {
  const next: RemixOp[] = ops.map((o) => ({ ...o }))
  const amp = (part: RemixPart, factor: number, why: string) => {
    const i = next.findIndex((o) => o.op === 'amplitude' && o.part === part)
    const p = param('amplitude', 'scale')
    if (i >= 0) {
      const o = next[i] as Extract<RemixOp, { op: 'amplitude' }>
      next[i] = { ...o, scale: r3(clampN(o.scale * factor, p.min, p.max)), why }
    } else if (next.length < MAX_REMIX_OPS) next.push({ op: 'amplitude', part, scale: r3(clampN(factor, p.min, p.max)), why })
  }
  for (const m of critique.checks?.motion ?? []) {
    if (m.ok) continue
    const part = BODYPART_TO_REMIX[m.part]
    if (part) amp(part, 1.35, `critic: the ${m.label} barely moves`)
  }
  const { a0, a1 } = clipBeatSpans(current)
  for (const c of (critique.changes ?? []) as AnimChange[]) {
    if (c.kind === 'retime') {
      const mid = (c.from + c.to) / 2
      const key = mid < a0 ? 'anticipation' : mid <= a1 ? 'action' : 'recovery'
      const p = param('stretch', key)
      let i = next.findIndex((o) => o.op === 'stretch')
      if (i < 0) {
        if (next.length >= MAX_REMIX_OPS) continue
        next.push({ op: 'stretch', anticipation: 1, action: 1, recovery: 1 })
        i = next.length - 1
      }
      const o = next[i] as Extract<RemixOp, { op: 'stretch' }>
      next[i] = { ...o, [key]: r3(clampN(Math.round((o[key] * c.scale) / p.step) * p.step, p.min, p.max)), why: `critic: ${c.why ?? `retime the ${key}`}`.slice(0, 200) }
    } else if (c.kind === 'offset') {
      // A big pose offset on a part reads as "this part should do more" (or less, against the swing).
      const part = PART_OF_JOINT(c.joint)
      const mag = Math.hypot(...c.rot)
      if (part && part !== 'torso' && mag >= 12) amp(part, 1.15, `critic: more ${REMIX_PART_LABEL[part]} (${c.why ?? 'pose offset'})`.slice(0, 200))
    }
  }
  return sameOps(next, ops) ? null : normalizeRemixPlan(next).ops
}

// ------------------------------------------------------------------ retrieval

export interface RemixCandidate {
  id: string
  name: string
  score: number
  tags: string[]
  // The request's move types this clip has.
  matched: string[]
  rig: RigType
  duration: number
  kind: AnimEntry['kind']
  scope: AnimEntry['scope']
}

export const usableEntry = (e: Pick<AnimEntry, 'quality' | 'rating'>) => e.quality !== 'avoid' && e.rating !== 'down'

// The library's reference score (AnimService.search): request move types on tags first, then words
// in tags, names, descriptions and notes; liked / good / reference clips count 1.3x.
export function libraryScore(e: Pick<AnimEntry, 'tags' | 'name' | 'description' | 'notes' | 'rating' | 'quality'>, words: string[], tags: Set<string>): number {
  let s = 0
  for (const t of e.tags) if (tags.has(t)) s += 6
  const name = e.name.toLowerCase()
  const desc = e.description.toLowerCase()
  const notes = e.notes.toLowerCase()
  for (const w of words) {
    if (e.tags.includes(w)) s += 3
    if (name.includes(w)) s += 3
    if (desc.includes(w)) s += 1
    if (notes.includes(w)) s += 1
  }
  if (e.rating === 'up' || e.quality === 'good' || e.quality === 'reference') s *= 1.3
  return s
}

const STOP = new Set(['a', 'an', 'the', 'with', 'and', 'of', 'to', 'for', 'in', 'on', 'my', 'it', 'its', 'but', 'more', 'less', 'like', 'make', 'animation', 'anim', 'move', 'please'])
export const queryWords = (text: string) => String(text ?? '').toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length > 1 && !STOP.has(w))

// Library clips to start a remix from, best first. Only usable clips with keys (no avoid, no video
// references); when the request names a move type of the set, only clips of that type. Real clips
// (imported mocap / KeyframeSequences) rank above generated ones, the rig's own clips above others.
export function remixCandidates(entries: AnimEntry[], prompt: string, set: MoveSetDef, opts: { rig?: RigType; limit?: number; exclude?: string } = {}): RemixCandidate[] {
  const tags = new Set(setPromptTags(prompt, set))
  const words = queryWords(prompt)
  const out: RemixCandidate[] = []
  for (const e of entries) {
    if (e.id === opts.exclude || e.kind === 'media' || e.video || !usableEntry(e)) continue
    if (!Object.values(e.clip?.tracks ?? {}).some((k) => (k?.length ?? 0) > 1)) continue
    const matched = e.tags.filter((t) => tags.has(t))
    if (tags.size && !matched.length) continue
    let s = libraryScore(e, words, tags)
    if (s <= 0) continue
    if (e.kind === 'imported') s *= 1.15
    if (opts.rig && clipRig(e.clip) === opts.rig) s *= 1.05
    out.push({ id: e.id, name: e.name, score: Math.round(s * 100) / 100, tags: e.tags, matched, rig: clipRig(e.clip), duration: e.clip.duration, kind: e.kind, scope: e.scope })
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, opts.limit ?? 8)
}

// ------------------------------------------------------------------ model prompt

export const REMIX_SYSTEM = `You are a senior game animator editing an existing, real (motion-captured or hand-keyed) Roblox character animation to match a request. You do NOT write keyframes: you plan a short list of edit operations that Forge applies to the base clip, so the motion stays human.
Operations (params are clamped to the ranges):
{"op":"speed","factor":0.25-4}  overall speed (>1 faster)
{"op":"stretch","anticipation":0.25-4,"action":0.25-4,"recovery":0.25-4}  scale each beat's duration (>1 longer)
{"op":"mirror"}  swap left and right (e.g. the request wants the other foot / hand)
{"op":"trim","from":0-0.95,"to":0.05-1}  keep a time range (fractions of the clip)
{"op":"amplitude","part":"all|legs|arms|upper|lower|torso|head|leftLeg|rightLeg|leftArm|rightArm","scale":0-2.5}  scale the rotations from the rest pose (1.3 = 30% bigger swing, 0.7 = subtler)
{"op":"blend","clip":"<id>","at":0.05-0.95,"from":0-0.95,"window":0-1}  this clip until "at", then the other clip from its "from" on, crossfading "window" seconds
{"op":"loop","window":0.05-1}  crossfade the end into the start
{"op":"hold","at":0-1,"duration":0.02-1.5}  freeze the pose at a time (seconds)
{"op":"transplant","clip":"<id>","part":"..."}  take that body part's motion from another clip
Use as few ops as the request needs (often 1-3); an empty list keeps the clip as is. Answer with JSON only: {"ops":[...],"why":"one sentence"}`

export function remixPlanPrompt(input: { request: string; base: { id: string; name: string; tags: string[]; description: string; clip: AnimClip }; others: { id: string; name: string; tags: string[]; description: string; duration: number }[]; side?: 'left' | 'right' | null; current?: RemixOp[]; critique?: Pick<AnimCritique, 'overall' | 'summary' | 'mustFix' | 'changes'> | null; intent?: string }): string {
  const c = input.base.clip
  const ph = phases(c)
  const lines = [
    `Request: ${input.request}`,
    '',
    `Base clip "${input.base.name}" (${input.base.tags.join(', ') || 'no tags'}): ${input.base.description.slice(0, 300)}`,
    `${clipRig(c)}, ${c.duration.toFixed(2)} s${c.looped ? ', looped' : ''}; anticipation until ${ph.actionStart.toFixed(2)} s, action ${ph.actionStart.toFixed(2)}–${ph.actionEnd.toFixed(2)} s (peak ${ph.peakTime.toFixed(2)} s), recovery after${input.side ? `; the ${input.side} side does the move` : ''}.`,
    c.markers.length ? `Markers: ${c.markers.map((m) => `${m.name} @ ${m.t.toFixed(2)} s`).join(', ')}` : '',
    input.intent ? `${input.intent} Do not scale the lead limb down (amplitude below 1 on it) unless the request asks for a smaller move.` : ''
  ]
  if (input.others.length) lines.push('', 'Other library clips (for blend / transplant):', ...input.others.slice(0, 6).map((o) => `- ${o.id}: "${o.name}" (${o.tags.join(', ')}; ${o.duration.toFixed(2)} s) ${o.description.slice(0, 140)}`))
  if (input.current) lines.push('', `Current ops: ${JSON.stringify(input.current)}`)
  if (input.critique) {
    lines.push('', `Critic (${input.critique.overall}/10): ${input.critique.summary}`)
    if (input.critique.mustFix?.length) lines.push(`Must fix: ${input.critique.mustFix.join('; ')}`)
    if (input.critique.changes?.length) lines.push(`The critic's suggested key changes (translate them into op params; you cannot add keys): ${JSON.stringify(input.critique.changes.slice(0, 6))}`)
    lines.push('Adjust the op params (or add / remove ops) to fix this. Keep what works.')
  }
  return lines.filter((l) => l !== '').join('\n')
}
