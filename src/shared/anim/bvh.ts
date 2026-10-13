// BVH motion capture -> R15 clip. BVH (Biovision Hierarchy) is the plain-text mocap format Blender,
// MotionBuilder, Mixamo converters and the CMU library export: a HIERARCHY of joints with OFFSETs and
// CHANNELS, then MOTION frames of channel values. FBX is not parsed here: export FBX to BVH from
// Blender (File > Export > Motion Capture (.bvh)) and import that.
//
// Retargeting works in world space so any skeleton maps: for each R15 part we take the source bone's
// world rotation change from its rest pose (keeps twist), times a rest correction that turns the
// R15 rest bone direction onto the source rest direction (T-pose arms vs R15 arms-down). Local Motor6D
// transforms follow from the parent part's world rotation. The source is turned to face -Z with its
// right side on +X (detected from the hips or shoulders), and root motion is scaled by hip height.

import type { AnimClip, AnimKey, R15Joint } from './model.ts'
import { R15_JOINTS } from './model.ts'
import { DEG, qaxis, qconj, qfromTo, qmul, qrot, vadd, vlen, vnorm, vscale, vsub, xfToCf, type Quat, type V3 } from './math.ts'
import { JOINTS, PART_OF_JOINT, type R15Part } from './r15.ts'
import { reduceKeys } from './reduce.ts'

export class BvhError extends Error {}

export interface BvhJoint {
  name: string
  parent: number
  offset: V3
  channels: string[]
  // Index of this joint's first channel in a frame row.
  channelStart: number
  children: number[]
  end?: V3
}

export interface Bvh {
  joints: BvhJoint[]
  frames: number[][]
  frameTime: number
}

export function parseBvh(text: string): Bvh {
  const tokens = String(text ?? '').split(/\s+/).filter(Boolean)
  let i = 0
  const next = () => {
    if (i >= tokens.length) throw new BvhError('unexpected end of file')
    return tokens[i++]
  }
  const expect = (t: string) => {
    const v = next()
    if (v.toUpperCase() !== t) throw new BvhError(`expected ${t}, got "${v}"`)
  }
  const num = () => {
    const v = Number(next())
    if (!Number.isFinite(v)) throw new BvhError(`expected a number near token ${i}`)
    return v
  }
  if (next().toUpperCase() !== 'HIERARCHY') throw new BvhError('not a BVH file (no HIERARCHY)')
  const joints: BvhJoint[] = []
  let channelCount = 0
  const parseJoint = (parent: number, name: string): number => {
    const idx = joints.length
    const j: BvhJoint = { name, parent, offset: [0, 0, 0], channels: [], channelStart: channelCount, children: [] }
    joints.push(j)
    if (parent >= 0) joints[parent].children.push(idx)
    expect('{')
    for (;;) {
      const t = next()
      const u = t.toUpperCase()
      if (u === 'OFFSET') j.offset = [num(), num(), num()]
      else if (u === 'CHANNELS') {
        const n = num()
        j.channelStart = channelCount
        for (let k = 0; k < n; k++) j.channels.push(next())
        channelCount += n
      } else if (u === 'JOINT') parseJoint(idx, next())
      else if (u === 'END') {
        next() // Site
        expect('{')
        expect('OFFSET')
        j.end = [num(), num(), num()]
        expect('}')
      } else if (u === '}') break
      else throw new BvhError(`unexpected "${t}" in joint ${name}`)
      if (joints.length > 400) throw new BvhError('too many joints')
    }
    return idx
  }
  const root = next().toUpperCase()
  if (root !== 'ROOT') throw new BvhError('expected ROOT')
  parseJoint(-1, next())
  // Some files have several ROOTs; only the first skeleton is used.
  while (i < tokens.length && tokens[i].toUpperCase() !== 'MOTION') i++
  expect('MOTION')
  next() // Frames:
  const nFrames = Math.floor(num())
  next() // Frame
  next() // Time:
  const frameTime = num()
  if (!(frameTime > 0)) throw new BvhError('bad Frame Time')
  const frames: number[][] = []
  for (let f = 0; f < nFrames && i < tokens.length; f++) {
    const row: number[] = []
    for (let c = 0; c < channelCount; c++) row.push(num())
    frames.push(row)
  }
  if (!frames.length) throw new BvhError('no motion frames')
  return { joints, frames, frameTime }
}

// ------------------------------------------------------------------ evaluation

interface WorldPose {
  pos: V3[]
  rot: Quat[]
}

function localRot(j: BvhJoint, row: number[] | null): Quat {
  let q: Quat = [0, 0, 0, 1]
  if (!row) return q
  j.channels.forEach((ch, k) => {
    const c = ch.toLowerCase()
    const v = row[j.channelStart + k] * DEG
    if (c === 'xrotation') q = qmul(q, qaxis([1, 0, 0], v))
    else if (c === 'yrotation') q = qmul(q, qaxis([0, 1, 0], v))
    else if (c === 'zrotation') q = qmul(q, qaxis([0, 0, 1], v))
  })
  return q
}

function localPos(j: BvhJoint, row: number[] | null): V3 {
  if (!row) return [...j.offset] as V3
  const p: V3 = [...j.offset] as V3
  let has = false
  const abs: V3 = [0, 0, 0]
  j.channels.forEach((ch, k) => {
    const c = ch.toLowerCase()
    const v = row[j.channelStart + k]
    if (c === 'xposition') (abs[0] = v), (has = true)
    else if (c === 'yposition') (abs[1] = v), (has = true)
    else if (c === 'zposition') (abs[2] = v), (has = true)
  })
  // Root position channels are absolute in most exporters (offset usually 0); joints add them.
  return has ? (j.parent < 0 ? vadd(abs, j.offset) : vadd(p, abs)) : p
}

export function worldPose(bvh: Bvh, row: number[] | null): WorldPose {
  const pos: V3[] = []
  const rot: Quat[] = []
  bvh.joints.forEach((j, idx) => {
    const lp = localPos(j, row)
    const lr = localRot(j, row)
    if (j.parent < 0) {
      pos[idx] = lp
      rot[idx] = lr
    } else {
      pos[idx] = vadd(pos[j.parent], qrot(rot[j.parent], lp))
      rot[idx] = qmul(rot[j.parent], lr)
    }
  })
  return { pos, rot }
}

// ------------------------------------------------------------------ bone name mapping

export type BoneRole = 'hips' | 'spine' | 'neck' | 'head' | 'upperArm' | 'lowerArm' | 'hand' | 'upperLeg' | 'lowerLeg' | 'foot' | 'toe' | 'clavicle'

export function boneRole(raw: string): { role: BoneRole; side: 'L' | 'R' | null } | null {
  let n = raw.replace(/^.*[:|]/, '').replace(/^(mixamorig|bip0?1|character\d*|def|ctrl|bn|b)[_ .-]?/i, '')
  let side: 'L' | 'R' | null = null
  const sideRe: [RegExp, 'L' | 'R'][] = [
    [/left/i, 'L'],
    [/right/i, 'R'],
    [/^l(?=[A-Z_ .-])/, 'L'],
    [/^r(?=[A-Z_ .-])/, 'R'],
    [/[_ .-]l$/i, 'L'],
    [/[_ .-]r$/i, 'R'],
    [/^l(?=(humerus|radius|wrist|hand|femur|tibia|foot|toes|clavicle|thigh|shin|uparm|lowarm|upleg|lowleg|forearm|shoulder|elbow|knee|ankle))/i, 'L'],
    [/^r(?=(humerus|radius|wrist|hand|femur|tibia|foot|toes|clavicle|thigh|shin|uparm|lowarm|upleg|lowleg|forearm|shoulder|elbow|knee|ankle))/i, 'R']
  ]
  for (const [re, s] of sideRe) {
    if (re.test(n)) {
      side = s
      n = n.replace(re, '')
      break
    }
  }
  const k = n.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/\d+$/, '')
  const roles: [RegExp, BoneRole][] = [
    [/^(hips|pelvis|hip|root)$/, 'hips'],
    [/^(spine|chest|upperchest|torso|back|lowerback|upperback|thorax|abdomen|waist)$/, 'spine'],
    [/^(neck)$/, 'neck'],
    [/^(head)$/, 'head'],
    [/^(shoulder|clavicle|collar)$/, 'clavicle'],
    [/^(arm|upperarm|uparm|humerus)$/, 'upperArm'],
    [/^(forearm|lowerarm|lowarm|elbow|radius)$/, 'lowerArm'],
    [/^(hand|wrist)$/, 'hand'],
    [/^(upleg|upperleg|thigh|femur|hip)$/, 'upperLeg'],
    [/^(leg|lowerleg|lowleg|calf|shin|knee|tibia)$/, 'lowerLeg'],
    [/^(foot|ankle)$/, 'foot'],
    [/^(toe|toes|toebase|ball)$/, 'toe']
  ]
  for (const [re, role] of roles) if (re.test(k)) return { role, side: role === 'hips' || role === 'spine' || role === 'neck' || role === 'head' ? null : side }
  return null
}

interface Segment {
  part: R15Part
  from: number
  to: number | 'end' | null
  rest: V3
}

// R15 rest direction of each part (from its joint toward its child end).
const R15_DIR: Record<string, V3> = {
  LowerTorso: [0, 1, 0],
  UpperTorso: [0, 1, 0],
  Head: [0, 1, 0],
  UpperArm: [0, -1, 0],
  LowerArm: [0, -1, 0],
  Hand: [0, -1, 0],
  UpperLeg: [0, -1, 0],
  LowerLeg: [0, -1, 0],
  Foot: vnorm([0, -0.35, -1])
}

function r15Dir(part: R15Part): V3 {
  return R15_DIR[part.replace(/^(Left|Right)/, '')] ?? [0, 1, 0]
}

export interface BvhMapping {
  segments: Segment[]
  unmapped: string[]
  hips: number
}

export function mapSkeleton(bvh: Bvh): BvhMapping {
  const roles = bvh.joints.map((j) => boneRole(j.name))
  const find = (role: BoneRole, side: 'L' | 'R' | null) => roles.findIndex((r) => r?.role === role && r.side === side)
  const hips = Math.max(0, roles.findIndex((r) => r?.role === 'hips'))
  const spines = roles.map((r, i) => (r?.role === 'spine' ? i : -1)).filter((i) => i >= 0)
  const neck = find('neck', null)
  const head = find('head', null)
  const upperTorso = spines.length ? spines[spines.length - 1] : -1
  const childTo = (idx: number, prefer: number): number | 'end' | null => (prefer >= 0 ? prefer : bvh.joints[idx]?.children[0] ?? (bvh.joints[idx]?.end ? 'end' : null))
  const segs: Segment[] = []
  const add = (part: R15Part, from: number, to: number | 'end' | null) => {
    if (from < 0) return
    segs.push({ part, from, to, rest: r15Dir(part) })
  }
  add('LowerTorso', hips, spines[0] ?? (upperTorso >= 0 ? upperTorso : neck))
  add('UpperTorso', upperTorso, neck >= 0 ? neck : head)
  add('Head', head >= 0 ? head : neck, childTo(head >= 0 ? head : neck, -1))
  for (const [s, side] of [['Left', 'L'], ['Right', 'R']] as const) {
    const ua = find('upperArm', side)
    const la = find('lowerArm', side)
    const ha = find('hand', side)
    const ul = find('upperLeg', side)
    const ll = find('lowerLeg', side)
    const ft = find('foot', side)
    const toe = find('toe', side)
    add(`${s}UpperArm`, ua, childTo(ua, la))
    add(`${s}LowerArm`, la, childTo(la, ha))
    add(`${s}Hand`, ha, childTo(ha, -1))
    add(`${s}UpperLeg`, ul, childTo(ul, ll))
    add(`${s}LowerLeg`, ll, childTo(ll, ft))
    add(`${s}Foot`, ft, childTo(ft, toe))
  }
  const used = new Set(segs.map((s) => s.from))
  const unmapped = bvh.joints.filter((_, i) => !used.has(i) && !roles[i]).map((j) => j.name)
  return { segments: segs, unmapped, hips }
}

// ------------------------------------------------------------------ retarget

export interface BvhImportOptions {
  name?: string
  // Max key rate after resampling (default 30 fps).
  fps?: number
  // Key reduction tolerance in degrees (0 keeps every frame).
  tolerance?: number
  looped?: boolean
}

export function bvhToClip(bvh: Bvh, opts: BvhImportOptions = {}): { clip: AnimClip; mapped: string[]; unmapped: string[] } {
  const map = mapSkeleton(bvh)
  if (map.segments.length < 4) throw new BvhError(`could not recognise the skeleton (bones: ${bvh.joints.slice(0, 12).map((j) => j.name).join(', ')})`)
  const rest = worldPose(bvh, null)
  const endPos = (pose: WorldPose, seg: Segment): V3 | null => {
    if (seg.to === null) return null
    if (seg.to === 'end') {
      const e = bvh.joints[seg.from].end
      return e ? vadd(pose.pos[seg.from], qrot(pose.rot[seg.from], e)) : null
    }
    return pose.pos[seg.to]
  }
  // Facing: the source's right (+X after the turn) from the hips' or shoulders' left -> right vector.
  const side = (role: BoneRole) => {
    const l = map.segments.find((s) => s.part === `Left${role}`)
    const r = map.segments.find((s) => s.part === `Right${role}`)
    return l && r ? vsub(rest.pos[r.from], rest.pos[l.from]) : null
  }
  const right = side('UpperLeg' as BoneRole) ?? side('UpperArm' as BoneRole) ?? [1, 0, 0]
  const yaw = Math.atan2(-right[2], right[0])
  const turn: Quat = qaxis([0, 1, 0], yaw)
  const toR = (v: V3): V3 => qrot(turn, v)
  const toRq = (q: Quat): Quat => qmul(qmul(turn, q), qconj(turn))
  // Scale: source hip height -> R15 hip height (2 studs).
  const feet = map.segments.filter((s) => s.part.endsWith('Foot')).map((s) => rest.pos[s.from][1])
  const floor = feet.length ? Math.min(...feet) : Math.min(...rest.pos.map((p) => p[1]))
  const hipH = rest.pos[map.hips][1] - floor
  // Feet segments start at the ankles: hip-to-ankle height maps to the R15's 1.7 studs.
  const scale = hipH > 1e-6 ? 1.7 / hipH : 1
  // Rest corrections.
  const corr = new Map<R15Part, Quat>()
  for (const s of map.segments) {
    const e = endPos(rest, s)
    const d = e ? vsub(e, rest.pos[s.from]) : null
    corr.set(s.part, d && vlen(d) > 1e-6 ? qfromTo(s.rest, vnorm(toR(d))) : [0, 0, 0, 1])
  }
  const segOf = new Map(map.segments.map((s) => [s.part, s]))
  const fps = Math.max(5, Math.min(60, opts.fps ?? 30))
  const srcFps = 1 / bvh.frameTime
  const step = Math.max(1, Math.round(srcFps / fps))
  const tracks: Partial<Record<R15Joint, AnimKey[]>> = {}
  const first = worldPose(bvh, bvh.frames[0])
  const firstHips = first.pos[map.hips]
  const firstFeet = map.segments.filter((s) => s.part.endsWith('Foot')).map((s) => first.pos[s.from][1])
  const floor0 = firstFeet.length ? Math.min(...firstFeet) : firstHips[1] - hipH
  for (let f = 0; f < bvh.frames.length; f += step) {
    const t = Math.round(f * bvh.frameTime * 1000) / 1000
    const pose = worldPose(bvh, bvh.frames[f])
    const world = new Map<R15Part, Quat>()
    world.set('HumanoidRootPart', [0, 0, 0, 1])
    for (const j of R15_JOINTS) {
      const part = PART_OF_JOINT[j]
      const s = segOf.get(part)
      const parentWorld = world.get(JOINTS[j].part0) ?? [0, 0, 0, 1]
      let w: Quat
      if (s) {
        const delta = qmul(pose.rot[s.from], qconj(rest.rot[s.from]))
        w = qmul(toRq(delta), corr.get(part)!)
      } else w = parentWorld
      world.set(part, w)
      const local = qmul(qconj(parentWorld), w)
      let p: V3 = [0, 0, 0]
      if (j === 'Root') {
        const h = pose.pos[map.hips]
        const d: V3 = [h[0] - firstHips[0], h[1] - floor0 - hipH, h[2] - firstHips[2]]
        p = vscale(toR(d), scale)
      }
      ;(tracks[j] ??= []).push({ t, cf: xfToCf({ p, q: local }), ease: 'Linear', dir: 'In' })
    }
  }
  const tol = opts.tolerance ?? 0.6
  for (const j of Object.keys(tracks) as R15Joint[]) tracks[j] = tol > 0 ? reduceKeys(tracks[j]!, tol) : tracks[j]
  const duration = Math.max(0.05, Math.round((bvh.frames.length - 1) * bvh.frameTime * 1000) / 1000)
  const clip: AnimClip = { name: (opts.name ?? 'Mocap').slice(0, 60), duration, looped: !!opts.looped, priority: 'Action', tracks, markers: [], source: 'bvh', fps: Math.round(srcFps / step) }
  return { clip, mapped: map.segments.map((s) => `${bvh.joints[s.from].name} -> ${s.part}`), unmapped: map.unmapped }
}
