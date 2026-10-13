// Deterministic simulation of Roblox ParticleEmitter, Beam and Trail for the VFX Lab preview.
//
// Every particle is a pure function of (seed, emitter, spawn index, time): the state at time t is
// computed in closed form, so the preview can scrub, loop and slow down without drift, and tests can
// check exact values. This approximates Roblox; it does not reproduce it bit for bit.
//
// Semantics (Roblox Creator Hub API reference, read 2026-10-13; see schema.ts for the sources):
//   Rate        particles per second while Enabled ("a rate of 5 emits a particle every 0.2 seconds");
//               the engine caps one emitter at 400/s (particle-emitters guide), so do we.
//   Lifetime    random per particle in [min, max].
//   Speed       random per particle, along EmissionDirection; negative = reverse.
//   SpreadAngle "the size of the random angle spread on the X/Z axes, in degrees"; 360 on both
//               axes emits in a full sphere, so a particle deviates by up to +-angle/2 per axis.
//   Drag        "the rate in seconds at which individual particles will lose half their speed via
//               exponential decay", applied to the emitted velocity: v(t) = v0 * 2^(-Drag*t).
//               Acceleration (global axes, studs/s^2) is not dragged.
//   Size, Transparency, Squash   NumberSequences over age / lifetime, envelopes drawn per particle.
//   Color       ColorSequence over age / lifetime.
//   Rotation, RotSpeed  degrees and degrees/s, random per particle, clockwise positive.
//   Flipbook    Loop / OneShot (lifetime split evenly over the frames) / PingPong / Random;
//               framerate capped at 30; FlipbookStartRandom picks the first frame.
//   Shape       Box (EmissionDirection), Sphere (radial; ShapePartial = hemisphere angle), Cylinder
//               (radial; ShapePartial = top radius), Disc (ShapePartial = inner radius); ShapeStyle
//               Volume / Surface; ShapeInOut Outward / Inward / InAndOut. Parented to an Attachment,
//               the emitter is a point (attachments have no size).
//   TimeScale   0..1, slows the whole effect (ages and emission).
//   LockedToPart  particles follow the parent's current transform instead of where they spawned.
//   Beam        cubic Bezier: P1 = A0 + CurveSize0 * A0.X, P2 = A1 - CurveSize1 * A1.X; Width0 to
//               Width1 linearly; Color / Transparency across the length; TextureSpeed cycles/s.
//   Trail       records both attachments' positions every frame; each segment fades over Lifetime
//               (Color / Transparency / WidthScale by segment age); MaxLength truncates.

import { add, alignY, cf, IDENTITY, isCFrame, mul, norm, NORMALS, point, pos, rotate, scale, fromEuler } from './cframe.ts'
import { prop } from './schema.ts'
import { envelopeOffsets, evalColorSequence, evalNumberSequence, hashSeed, rng, sequenceMax, sequenceMean } from './sequence.ts'
import type { CFrameArr, ColorSequence, NumberRange, NumberSequence, Rgb, Vec2, Vec3, VfxCue, VfxEffect, VfxNode } from './types.ts'

export const MAX_RATE = 400
export const MAX_FLIPBOOK_FPS = 30
// Where the dummy stands: feet at the origin, facing -Z (Roblox's Front).
export const DEFAULT_ANCHOR: Vec3 = [0, 3, 0]

export interface Particle {
  key: string
  pos: Vec3
  vel: Vec3
  // World size of the quad (Size with Squash applied): width, height.
  w: number
  h: number
  rot: number
  color: Rgb
  alpha: number
  age: number
  life: number
  frame: number
  nextFrame: number
  blend: number
}

export interface PreparedEmitter {
  id: string
  name: string
  node: VfxNode
  // Parent transform (attachment or part) at real time t.
  parentAt: (t: number) => CFrameArr
  // Part size when parented to a part (shape emission); null for attachments (point).
  partSize: Vec3 | null
  windows: [number, number][]
  bursts: { at: number; count: number }[]
}

export interface PreparedLink {
  id: string
  name: string
  node: VfxNode
  a0: ((t: number) => CFrameArr) | null
  a1: ((t: number) => CFrameArr) | null
  windows: [number, number][]
}

export interface PreparedLight {
  id: string
  name: string
  node: VfxNode
  at: (t: number) => CFrameArr
  windows: [number, number][]
}

export interface PreparedMesh {
  id: string
  name: string
  node: VfxNode
  at: (t: number) => CFrameArr
  size: Vec3
}

export interface PreparedEffect {
  effect: VfxEffect
  seed: number
  emitters: PreparedEmitter[]
  beams: PreparedLink[]
  trails: PreparedLink[]
  lights: PreparedLight[]
  highlights: VfxNode[]
  meshes: PreparedMesh[]
  root: (t: number) => CFrameArr
}

const ATTACH_CLASSES = new Set(['Attachment'])
const PART_CLASSES = new Set(['Part', 'MeshPart', 'WedgePart', 'UnionOperation'])
const LIGHT_CLASSES = new Set(['PointLight', 'SpotLight', 'SurfaceLight'])

// The root's transform for a motion preset at time t (duration D).
export function motionAt(effect: VfxEffect, t: number): CFrameArr {
  const anchor = effect.anchor ?? DEFAULT_ANCHOR
  const D = Math.max(0.1, effect.duration || 2)
  const u = ((t % D) + D) % D / D
  switch (effect.motion ?? 'static') {
    case 'swing': {
      // A slash in front of the dummy: a fast arc in the first 40% of the play, then hold.
      const k = Math.min(1, u / 0.4)
      const e = 1 - Math.pow(1 - k, 3)
      const a = (-110 + 220 * e) * (Math.PI / 180)
      const r = 3
      return fromEuler(0, -a, 0, [anchor[0] + Math.sin(a) * r, anchor[1], anchor[2] - Math.cos(a) * r])
    }
    case 'orbit': {
      const a = u * Math.PI * 2
      return fromEuler(0, -a, 0, [anchor[0] + Math.sin(a) * 3, anchor[1], anchor[2] - Math.cos(a) * 3])
    }
    case 'dash':
      return cf(anchor[0], anchor[1], anchor[2] + 8 - 16 * u)
    case 'rise':
      return cf(anchor[0], anchor[1] - 2 + 6 * u, anchor[2])
    default:
      return cf(anchor[0], anchor[1], anchor[2])
  }
}

// On / off windows of a node over [0, duration) from its Enabled flag and the cues.
export function enableWindows(node: VfxNode, cues: VfxCue[], duration: number): [number, number][] {
  let on = prop<boolean>(node, 'Enabled') !== false
  let from = 0
  const out: [number, number][] = []
  const mine = cues.filter((c) => c.target === node.id && (c.action === 'enable' || c.action === 'disable')).sort((a, b) => a.at - b.at)
  for (const c of mine) {
    if (c.action === 'enable' && !on) {
      on = true
      from = c.at
    } else if (c.action === 'disable' && on) {
      on = false
      if (c.at > from) out.push([from, c.at])
    }
  }
  if (on) out.push([from, Math.max(from, duration)])
  return out
}

// Builds transforms and schedules for every node of the effect.
export function prepareEffect(effect: VfxEffect, seed = 1): PreparedEffect {
  const root = (t: number) => motionAt(effect, t)
  // Imported models sit anywhere in their place: re-centre on the mean of their parts.
  const parts: Vec3[] = []
  const collect = (n: VfxNode) => {
    if (PART_CLASSES.has(n.className) && isCFrame(n.props.CFrame)) parts.push(pos(n.props.CFrame as CFrameArr))
    n.children.forEach(collect)
  }
  effect.roots.forEach(collect)
  const centre: Vec3 = parts.length ? scale(parts.reduce((a, b) => add(a, b), [0, 0, 0] as Vec3), 1 / parts.length) : [0, 0, 0]
  const recentre = cf(-centre[0], -centre[1], -centre[2])

  const out: PreparedEffect = { effect, seed, emitters: [], beams: [], trails: [], lights: [], highlights: [], meshes: [], root }
  const byId = new Map<string, (t: number) => CFrameArr>()
  const pending: { node: VfxNode; at: (t: number) => CFrameArr; parentPart: VfxNode | null; parentIsAttachment: boolean }[] = []

  const walk = (n: VfxNode, parentAt: (t: number) => CFrameArr, parentPart: VfxNode | null, parentIsAttachment: boolean) => {
    let here = parentAt
    if (PART_CLASSES.has(n.className)) {
      const local = mul(recentre, isCFrame(n.props.CFrame) ? (n.props.CFrame as CFrameArr) : IDENTITY)
      here = (t) => mul(root(t), local)
    } else if (ATTACH_CLASSES.has(n.className)) {
      const local = isCFrame(n.props.CFrame) ? (n.props.CFrame as CFrameArr) : IDENTITY
      here = (t) => mul(parentAt(t), local)
    }
    byId.set(n.id, here)
    pending.push({ node: n, at: here, parentPart, parentIsAttachment })
    const nextPart = PART_CLASSES.has(n.className) ? n : parentPart
    const nextIsAttachment = ATTACH_CLASSES.has(n.className) ? true : PART_CLASSES.has(n.className) ? false : parentIsAttachment
    for (const c of n.children) walk(c, here, nextPart, nextIsAttachment)
  }
  for (const r of effect.roots) walk(r, root, null, false)

  for (const { node: n, at, parentPart, parentIsAttachment } of pending) {
    const windows = enableWindows(n, effect.cues, effect.duration)
    if (n.className === 'ParticleEmitter') {
      const bursts = effect.cues.filter((c) => c.target === n.id && c.action === 'emit').map((c) => ({ at: c.at, count: Math.max(0, Math.round(c.count ?? 16)) }))
      const size = parentPart && !parentIsAttachment ? (prop<number[]>(parentPart, 'Size') as Vec3) : null
      out.emitters.push({ id: n.id, name: n.name, node: n, parentAt: at, partSize: size ?? null, windows, bursts })
    } else if (n.className === 'Beam' || n.className === 'Trail') {
      const a0 = typeof n.props.Attachment0 === 'string' ? byId.get(n.props.Attachment0) ?? null : null
      const a1 = typeof n.props.Attachment1 === 'string' ? byId.get(n.props.Attachment1) ?? null : null
      ;(n.className === 'Beam' ? out.beams : out.trails).push({ id: n.id, name: n.name, node: n, a0, a1, windows })
    } else if (LIGHT_CLASSES.has(n.className)) {
      out.lights.push({ id: n.id, name: n.name, node: n, at, windows })
    } else if (n.className === 'Highlight') {
      out.highlights.push(n)
    } else if ((n.className === 'Part' || n.className === 'MeshPart') && prop<number>(n, 'Transparency') < 1) {
      out.meshes.push({ id: n.id, name: n.name, node: n, at, size: prop<number[]>(n, 'Size') as Vec3 })
    }
  }
  return out
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function rangeOf(v: unknown, fallback: NumberRange): NumberRange {
  return Array.isArray(v) && v.length >= 2 ? [Number(v[0]) || 0, Number(v[1]) || 0] : fallback
}

export function flipbookFrames(node: VfxNode): number {
  switch (prop<string>(node, 'FlipbookLayout')) {
    case 'Grid2x2':
      return 4
    case 'Grid4x4':
      return 16
    case 'Grid8x8':
      return 64
    case 'Custom':
      return Math.max(1, (prop<number>(node, 'FlipbookSizeX') || 1) * (prop<number>(node, 'FlipbookSizeY') || 1))
    default:
      return 1
  }
}

export function flipbookGrid(node: VfxNode): [number, number] {
  switch (prop<string>(node, 'FlipbookLayout')) {
    case 'Grid2x2':
      return [2, 2]
    case 'Grid4x4':
      return [4, 4]
    case 'Grid8x8':
      return [8, 8]
    case 'Custom':
      return [Math.max(1, prop<number>(node, 'FlipbookSizeX') || 1), Math.max(1, prop<number>(node, 'FlipbookSizeY') || 1)]
    default:
      return [1, 1]
  }
}

// Two unit vectors perpendicular to d.
function basis(d: Vec3): [Vec3, Vec3] {
  const a: Vec3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const u = norm([d[1] * a[2] - d[2] * a[1], d[2] * a[0] - d[0] * a[2], d[0] * a[1] - d[1] * a[0]])
  const v: Vec3 = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]]
  return [u, v]
}

// Rotates d by angles (radians) around its two perpendicular axes.
function spread(d: Vec3, ax: number, ay: number): Vec3 {
  const [u, v] = basis(d)
  // Spherical offset: tilt toward u by ax, then toward v by ay.
  const ca = Math.cos(ax), sa = Math.sin(ax), cb = Math.cos(ay), sb = Math.sin(ay)
  const t: Vec3 = [d[0] * ca + u[0] * sa, d[1] * ca + u[1] * sa, d[2] * ca + u[2] * sa]
  return norm([t[0] * cb + v[0] * sb, t[1] * cb + v[1] * sb, t[2] * cb + v[2] * sb])
}

interface Spawn {
  local: Vec3 // position in parent space
  dirLocal: Vec3
}

// Where a particle starts and which way it goes, in the parent's space.
export function shapeSpawn(node: VfxNode, partSize: Vec3 | null, r: () => number): Spawn {
  const dir = NORMALS[prop<string>(node, 'EmissionDirection')] ?? NORMALS.Top
  const inOut = prop<string>(node, 'ShapeInOut')
  const sign = inOut === 'Inward' ? -1 : inOut === 'InAndOut' ? (r() < 0.5 ? -1 : 1) : 1
  if (!partSize) return { local: [0, 0, 0], dirLocal: scale(dir, sign) }
  const half: Vec3 = scale(partSize, 0.5)
  const surface = prop<string>(node, 'ShapeStyle') === 'Surface'
  const partial = Math.max(0, Math.min(1, prop<number>(node, 'ShapePartial')))
  const [u, v] = basis(dir)
  const ext = (axis: Vec3) => Math.abs(axis[0]) * half[0] + Math.abs(axis[1]) * half[1] + Math.abs(axis[2]) * half[2]
  switch (prop<string>(node, 'Shape')) {
    case 'Sphere': {
      // Uniform direction within the cap of angle partial*180 around the emission direction.
      const cosMax = Math.cos(partial * Math.PI)
      const z = 1 - r() * (1 - cosMax)
      const phi = r() * Math.PI * 2
      const s = Math.sqrt(Math.max(0, 1 - z * z))
      const n: Vec3 = norm(add(add(scale(dir, z), scale(u, s * Math.cos(phi))), scale(v, s * Math.sin(phi))))
      const rad = surface ? 1 : Math.cbrt(r())
      return { local: [n[0] * half[0] * rad, n[1] * half[1] * rad, n[2] * half[2] * rad], dirLocal: scale(n, sign) }
    }
    case 'Cylinder': {
      const h = ext(dir)
      const y = (r() * 2 - 1) * h
      const topScale = lerp(1, partial, (y + h) / (2 * h || 1))
      const phi = r() * Math.PI * 2
      const radial = add(scale(u, Math.cos(phi)), scale(v, Math.sin(phi)))
      const rad = (surface ? 1 : Math.sqrt(r())) * topScale
      const p = add(scale(dir, y), [radial[0] * half[0] * rad * 1, radial[1] * half[1] * rad, radial[2] * half[2] * rad])
      return { local: p, dirLocal: scale(norm(radial), sign) }
    }
    case 'Disc': {
      const phi = r() * Math.PI * 2
      const inner = partial
      const rad = surface ? 1 : Math.sqrt(lerp(inner * inner, 1, r()))
      const radial = add(scale(u, Math.cos(phi)), scale(v, Math.sin(phi)))
      const p: Vec3 = [radial[0] * half[0] * rad, radial[1] * half[1] * rad, radial[2] * half[2] * rad]
      return { local: p, dirLocal: scale(dir, sign) }
    }
    default: {
      // Box
      let p: Vec3 = [(r() * 2 - 1) * half[0], (r() * 2 - 1) * half[1], (r() * 2 - 1) * half[2]]
      if (surface) {
        const axis = Math.floor(r() * 3)
        p = [...p] as Vec3
        p[axis] = (r() < 0.5 ? -1 : 1) * half[axis]
      }
      return { local: p, dirLocal: scale(dir, sign) }
    }
  }
}

// Displacement after time a with initial velocity v0, drag D (half-life rate) and acceleration A.
export function displacement(v0: Vec3, A: Vec3, D: number, a: number): Vec3 {
  const k = D * Math.LN2
  const f = Math.abs(k) < 1e-6 ? a : (1 - Math.exp(-k * a)) / k
  return [v0[0] * f + 0.5 * A[0] * a * a, v0[1] * f + 0.5 * A[1] * a * a, v0[2] * f + 0.5 * A[2] * a * a]
}

export function velocityAt(v0: Vec3, A: Vec3, D: number, a: number): Vec3 {
  const g = Math.pow(2, -D * a)
  return [v0[0] * g + A[0] * a, v0[1] * g + A[1] * a, v0[2] * g + A[2] * a]
}

// Per-emitter constants read once per simulate call.
function emitterParams(node: VfxNode) {
  return {
    rate: Math.min(MAX_RATE, Math.max(0, prop<number>(node, 'Rate') || 0)),
    life: rangeOf(node.props.Lifetime, prop<NumberRange>(node, 'Lifetime')),
    speed: rangeOf(node.props.Speed, prop<NumberRange>(node, 'Speed')),
    spread: (prop<number[]>(node, 'SpreadAngle') ?? [0, 0]) as Vec2,
    accel: (prop<number[]>(node, 'Acceleration') ?? [0, 0, 0]) as Vec3,
    drag: prop<number>(node, 'Drag') || 0,
    size: prop<NumberSequence>(node, 'Size'),
    transp: prop<NumberSequence>(node, 'Transparency'),
    squash: prop<NumberSequence>(node, 'Squash'),
    color: prop<ColorSequence>(node, 'Color'),
    rotation: rangeOf(node.props.Rotation, [0, 0]),
    rotSpeed: rangeOf(node.props.RotSpeed, [0, 0]),
    timeScale: Math.max(0, Math.min(1, node.props.TimeScale === undefined ? 1 : Number(node.props.TimeScale))),
    locked: prop<boolean>(node, 'LockedToPart') === true,
    frames: flipbookFrames(node),
    fbMode: prop<string>(node, 'FlipbookMode'),
    fbRate: rangeOf(node.props.FlipbookFramerate, [1, 1]),
    fbStartRandom: prop<boolean>(node, 'FlipbookStartRandom') === true,
    brightness: prop<number>(node, 'Brightness'),
    lightInfluence: prop<number>(node, 'LightInfluence')
  }
}

function flipFrame(p: ReturnType<typeof emitterParams>, r: () => number, key: number, age: number, life: number): [number, number, number] {
  const n = p.frames
  if (n <= 1) return [0, 0, 0]
  const fps = Math.min(MAX_FLIPBOOK_FPS, lerp(p.fbRate[0], p.fbRate[1], r()))
  const start = p.fbStartRandom ? Math.floor(r() * n) : 0
  switch (p.fbMode) {
    case 'OneShot': {
      const f = Math.min(n - 1e-6, (age / Math.max(1e-6, life)) * n)
      const i = Math.floor(f)
      return [i, Math.min(n - 1, i + 1), f - i]
    }
    case 'PingPong': {
      const P = 2 * n - 2
      const f = start + age * fps
      const x = ((f % P) + P) % P
      const i = Math.floor(x)
      const map = (k: number) => (k < n ? k : P - k)
      return [map(i), map((i + 1) % P), x - i]
    }
    case 'Random': {
      const f = age * fps
      const i = Math.floor(f)
      const pick = (k: number) => Math.floor(rng(hashSeed(key, k))() * n)
      return [pick(i), pick(i + 1), f - i]
    }
    default: {
      const f = start + age * fps
      const i = Math.floor(f)
      return [i % n, (i + 1) % n, f - i]
    }
  }
}

// One particle at time t, spawned at ts with key (seed source); null when dead.
function particleAt(em: PreparedEmitter, p: ReturnType<typeof emitterParams>, key: string, seedKey: number, ts: number, t: number): Particle | null {
  const r = rng(seedKey)
  const life = lerp(p.life[0], p.life[1], r())
  if (life <= 0) return null
  const age = (t - ts) * p.timeScale
  if (age < 0 || age >= life) return null
  const speed = lerp(p.speed[0], p.speed[1], r())
  const spawn = shapeSpawn(em.node, em.partSize, r)
  const ax = (r() - 0.5) * p.spread[0] * (Math.PI / 180)
  const ay = (r() - 0.5) * p.spread[1] * (Math.PI / 180)
  const dirLocal = p.spread[0] || p.spread[1] ? spread(spawn.dirLocal, ax, ay) : spawn.dirLocal
  const rot0 = lerp(p.rotation[0], p.rotation[1], r())
  const rotSpeed = lerp(p.rotSpeed[0], p.rotSpeed[1], r())
  const sizeOff = envelopeOffsets(p.size, r)
  const transOff = envelopeOffsets(p.transp, r)
  const squashOff = envelopeOffsets(p.squash, r)
  const [frame, nextFrame, blend] = flipFrame(p, r, seedKey, age, life)

  const frameAt = em.parentAt(p.locked ? t : ts)
  const v0Local = scale(dirLocal, speed)
  let position: Vec3
  let vel: Vec3
  if (p.locked) {
    // Locked: integrate in the parent's space, acceleration is still global (rotated in).
    const accLocal = rotate(transpose(frameAt), p.accel)
    const d = displacement(v0Local, accLocal, p.drag, age)
    position = point(frameAt, add(spawn.local, d))
    vel = rotate(frameAt, velocityAt(v0Local, accLocal, p.drag, age))
  } else {
    const v0 = rotate(frameAt, v0Local)
    position = add(point(frameAt, spawn.local), displacement(v0, p.accel, p.drag, age))
    vel = velocityAt(v0, p.accel, p.drag, age)
  }
  const tn = age / life
  const size = Math.max(0, evalNumberSequence(p.size, tn, sizeOff))
  const sq = evalNumberSequence(p.squash, tn, squashOff)
  const transparency = Math.max(0, Math.min(1, evalNumberSequence(p.transp, tn, transOff)))
  const c = evalColorSequence(p.color, tn)
  // Brightness scales emitted light when LightInfluence is 0 (Brightness docs); the preview's
  // lighting is neutral, so influence just blends the scale back toward 1.
  const b = lerp(p.brightness, 1, Math.max(0, Math.min(1, p.lightInfluence)))
  return {
    key,
    pos: position,
    vel,
    // Squash > 0: narrower and taller; < 0: wider and shorter (area kept).
    w: size * Math.pow(2, -sq),
    h: size * Math.pow(2, sq),
    rot: rot0 + rotSpeed * age,
    color: [c[0] * b, c[1] * b, c[2] * b],
    alpha: 1 - transparency,
    age,
    life,
    frame,
    nextFrame,
    blend
  }
}

function transpose(c: CFrameArr): CFrameArr {
  return [0, 0, 0, c[3], c[6], c[9], c[4], c[7], c[10], c[5], c[8], c[11]]
}

// All live particles of one emitter at time t (seconds since the effect started).
export function simulateEmitter(em: PreparedEmitter, t: number, seed = 1): Particle[] {
  const p = emitterParams(em.node)
  const out: Particle[] = []
  const ts = p.timeScale
  if (ts <= 0) return out
  const maxAge = p.life[1] / ts
  // Continuous emission windows.
  if (p.rate > 0) {
    const step = 1 / (p.rate * ts)
    em.windows.forEach(([from, to], w) => {
      const lo = Math.max(from, t - maxAge)
      const hi = Math.min(to, t)
      if (hi < lo) return
      const k0 = Math.max(0, Math.ceil((lo - from) / step - 1e-9))
      const k1 = Math.floor((hi - from) / step + 1e-9)
      for (let k = k0; k <= k1 && k - k0 < 20000; k++) {
        const at = from + k * step
        if (at >= to) break
        const q = particleAt(em, p, `c${w}:${k}`, hashSeed(seed, em.id, 'c', w, k), at, t)
        if (q) out.push(q)
      }
    })
  }
  em.bursts.forEach((b, i) => {
    if (b.at > t || b.at < t - maxAge) return
    for (let j = 0; j < Math.min(b.count, 5000); j++) {
      const q = particleAt(em, p, `b${i}:${j}`, hashSeed(seed, em.id, 'b', i, j), b.at, t)
      if (q) out.push(q)
    }
  })
  return out
}

export interface BeamFrame {
  id: string
  points: Vec3[]
  // Width direction per point (used when FaceCamera is false).
  sides: Vec3[]
  widths: number[]
  colors: Rgb[]
  alphas: number[]
  // Texture coordinate along the beam (cycles), including TextureSpeed scrolling.
  us: number[]
}

function inWindows(windows: [number, number][], t: number): boolean {
  return windows.some(([a, b]) => t >= a && t < b)
}

export function simulateBeam(b: PreparedLink, t: number): BeamFrame | null {
  if (!b.a0 || !b.a1 || !inWindows(b.windows, t)) return null
  const n = b.node
  const A0 = b.a0(t)
  const A1 = b.a1(t)
  const p0 = pos(A0)
  const p3 = pos(A1)
  const x0 = rotate(A0, [1, 0, 0])
  const x1 = rotate(A1, [1, 0, 0])
  const p1 = add(p0, scale(x0, prop<number>(n, 'CurveSize0')))
  const p2 = add(p3, scale(x1, -prop<number>(n, 'CurveSize1')))
  const segs = Math.max(1, Math.min(200, Math.round(prop<number>(n, 'Segments') || 10)))
  const w0 = prop<number>(n, 'Width0')
  const w1 = prop<number>(n, 'Width1')
  const color = prop<ColorSequence>(n, 'Color')
  const transp = prop<NumberSequence>(n, 'Transparency')
  const z0 = rotate(A0, [0, 0, 1])
  const z1 = rotate(A1, [0, 0, 1])
  const frame: BeamFrame = { id: b.id, points: [], sides: [], widths: [], colors: [], alphas: [], us: [] }
  let length = 0
  let prev: Vec3 | null = null
  const bright = prop<number>(n, 'Brightness')
  for (let i = 0; i <= segs; i++) {
    const s = i / segs
    const m = 1 - s
    const q: Vec3 = [0, 1, 2].map((k) => m * m * m * p0[k] + 3 * m * m * s * p1[k] + 3 * m * s * s * p2[k] + s * s * s * p3[k]) as Vec3
    if (prev) length += Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2])
    prev = q
    frame.points.push(q)
    frame.sides.push(norm(add(scale(z0, 1 - s), scale(z1, s))))
    frame.widths.push(lerp(w0, w1, s))
    const c = evalColorSequence(color, s)
    frame.colors.push([c[0] * bright, c[1] * bright, c[2] * bright])
    frame.alphas.push(1 - Math.max(0, Math.min(1, evalNumberSequence(transp, s))))
  }
  const mode = prop<string>(n, 'TextureMode')
  const texLen = Math.max(0.01, prop<number>(n, 'TextureLength') || 1)
  const cycles = mode === 'Stretch' ? texLen : length / texLen
  const scroll = -prop<number>(n, 'TextureSpeed') * t
  for (let i = 0; i <= segs; i++) frame.us.push((i / segs) * cycles + scroll)
  return frame
}

export interface TrailFrame {
  id: string
  // Pairs of edge points (attachment 0 side, attachment 1 side), newest first.
  left: Vec3[]
  right: Vec3[]
  colors: Rgb[]
  alphas: number[]
  us: number[]
}

export const TRAIL_STEP = 1 / 60

export function simulateTrail(tr: PreparedLink, t: number): TrailFrame | null {
  if (!tr.a0 || !tr.a1) return null
  const n = tr.node
  const life = Math.max(0.01, prop<number>(n, 'Lifetime'))
  const color = prop<ColorSequence>(n, 'Color')
  const transp = prop<NumberSequence>(n, 'Transparency')
  const width = prop<NumberSequence>(n, 'WidthScale')
  const maxLen = prop<number>(n, 'MaxLength') || 0
  const minLen = Math.max(0, prop<number>(n, 'MinLength'))
  const bright = prop<number>(n, 'Brightness')
  const frame: TrailFrame = { id: tr.id, left: [], right: [], colors: [], alphas: [], us: [] }
  let length = 0
  let last: Vec3 | null = null
  // Segments are recorded at a fixed 60 Hz grid so scrubbing gives the same trail.
  const newest = Math.floor(t / TRAIL_STEP)
  for (let k = newest; k >= 0; k--) {
    const at = k === newest ? t : k * TRAIL_STEP
    const age = t - at
    if (age > life) break
    if (!inWindows(tr.windows, at)) continue
    const a = pos(tr.a0(at))
    const b = pos(tr.a1(at))
    const mid = scale(add(a, b), 0.5)
    if (last && k !== newest && Math.hypot(mid[0] - last[0], mid[1] - last[1], mid[2] - last[2]) < minLen) continue
    if (last) length += Math.hypot(mid[0] - last[0], mid[1] - last[1], mid[2] - last[2])
    if (maxLen > 0 && length > maxLen) break
    last = mid
    const tn = age / life
    const ws = Math.max(0, evalNumberSequence(width, tn))
    frame.left.push(add(mid, scale(add(a, scale(mid, -1)), ws)))
    frame.right.push(add(mid, scale(add(b, scale(mid, -1)), ws)))
    const c = evalColorSequence(color, tn)
    frame.colors.push([c[0] * bright, c[1] * bright, c[2] * bright])
    frame.alphas.push(1 - Math.max(0, Math.min(1, evalNumberSequence(transp, tn))))
    frame.us.push(tn)
  }
  return frame.left.length >= 2 ? frame : null
}

export interface LightFrame {
  id: string
  className: string
  pos: Vec3
  dir: Vec3
  color: Rgb
  brightness: number
  range: number
  angle: number
}

export function simulateLight(l: PreparedLight, t: number): LightFrame | null {
  if (!inWindows(l.windows, t)) return null
  const c = l.at(t)
  const face = NORMALS[prop<string>(l.node, 'Face') ?? 'Front'] ?? NORMALS.Front
  return {
    id: l.id,
    className: l.node.className,
    pos: pos(c),
    dir: rotate(c, face),
    color: prop<Rgb>(l.node, 'Color'),
    brightness: prop<number>(l.node, 'Brightness'),
    range: prop<number>(l.node, 'Range'),
    angle: prop<number>(l.node, 'Angle') ?? 90
  }
}

export interface SimFrame {
  t: number
  emitters: { id: string; name: string; node: VfxNode; particles: Particle[] }[]
  beams: BeamFrame[]
  trails: TrailFrame[]
  lights: LightFrame[]
  root: CFrameArr
}

export function simulate(prepared: PreparedEffect, t: number): SimFrame {
  return {
    t,
    emitters: prepared.emitters.map((e) => ({ id: e.id, name: e.name, node: e.node, particles: simulateEmitter(e, t, prepared.seed) })),
    beams: prepared.beams.map((b) => simulateBeam(b, t)).filter((x): x is BeamFrame => !!x),
    trails: prepared.trails.map((b) => simulateTrail(b, t)).filter((x): x is TrailFrame => !!x),
    lights: prepared.lights.map((l) => simulateLight(l, t)).filter((x): x is LightFrame => !!x),
    root: prepared.root(t)
  }
}

// Steady-state live particle estimate of one emitter (Rate x mean lifetime, plus its largest burst).
export function emitterBudget(node: VfxNode, bursts: number[] = []): { live: number; area: number; overdraw: number } {
  const p = emitterParams(node)
  const meanLife = (p.life[0] + p.life[1]) / 2
  const live = (prop<boolean>(node, 'Enabled') !== false ? p.rate * meanLife : 0) + Math.max(0, ...bursts)
  const meanSize = Math.max(0, sequenceMean(p.size))
  const opacity = 1 - Math.max(0, Math.min(1, sequenceMean(p.transp)))
  const area = meanSize * meanSize
  return { live, area, overdraw: live * area * opacity }
}

export { alignY, sequenceMax }
