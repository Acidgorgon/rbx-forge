// Animation timeline scripts -> clips. A script (Luau, the anim API below) is run headlessly by Lune
// (resources/lune/anim_timeline.luau), which records every call as an op with the script line and
// the script's clock instead of touching Roblox. This file turns the ops into an AnimClip: kit poses,
// joint keys, IK, look-at, root motion, holds, markers and beats, then the post passes (spring
// overlap, foot plants, mirror) and patches from the critic. Errors carry the script line.

import { ANIM_PRIORITIES, POSE_EASING_DIRECTIONS, POSE_EASING_STYLES, R15_JOINTS, type AnimBeat, type AnimClip, type AnimKey, type AnimPriority, type LearnedPose, type PoseEasingDirection, type PoseEasingStyle, type R15Joint, type RigType } from './model.ts'
import type { AnimMarker } from './types.ts'
import { cfToXf, qeulerDeg, qmul, xfToCf, type V3, type Xf } from './math.ts'
import { findKitPose, KIT_GROUPS, KIT_POSES, resolveKitPose, type KitPose } from './kit.ts'
import { forwardKinematics, isJoint, LIMBS, mirrorJoint, mirrorXf, type LimbName } from './r15.ts'
import { aimLimbR6, lookAtRotation, solveTwoBone } from './ik.ts'
import { collapsePose, jointAlias, r6TracksFromView } from './convert.ts'
import { R6_CAPABLE, R6_JOINT_DEFS, R6_OF_R15 } from './r6.ts'
import { keyXf, normalizeKeys, samplePose } from './sample.ts'
import { footLockPass, footLockPassR6, overlapPass, plantPass, settleFeet, settleFeetR6, Tracks } from './passes.ts'
import { applyAnimChanges } from './patch.ts'

export interface AnimOp {
  op: 'pose' | 'joint' | 'ik' | 'plant' | 'look' | 'root' | 'hold' | 'overlap' | 'marker' | 'beat' | 'mirror' | 'feet' | 'duration' | 'loop' | 'priority' | 'name' | 'ease' | 'rig'
  at: number
  line?: number
  name?: string
  joint?: string
  limb?: string
  foot?: string
  value?: unknown
  target?: unknown
  rot?: unknown
  pos?: unknown
  opts?: Record<string, unknown>
  dt?: number
  until?: number
  group?: unknown
}

export interface AnimRecordResult {
  ok: boolean
  ops: AnimOp[]
  prints: string[]
  error?: { message: string; line?: number }
}

export class AnimCompileError extends Error {
  line?: number
  constructor(message: string, line?: number) {
    super(message)
    this.line = line
  }
}

export const MAX_ANIM_OPS = 3000
export const MAX_ANIM_DURATION = 20
export const DEFAULT_EASE: { style: PoseEasingStyle; dir: PoseEasingDirection } = { style: 'CubicV2', dir: 'InOut' }

export const ANIM_SCRIPT_TEMPLATE = `-- Animation timeline. a is the anim API (Forge records it into keyframes):
--   a:pose(name, opts?)  kit or learned pose at the clock   opts: side, amount, only, ease, dir
--   a:joint(joint, Vector3 degrees | CFrame, opts?)          a:root(offset, degrees?, opts?)
--   a:ik(limb, target, opts?)   RightArm LeftArm RightLeg LeftLeg, target in studs (feet on 0, -Z forward)
--   a:look(target)  a:plant("Left", from, to)  a:overlap(group, opts?)  a:mirror()  a:feet("free")
--   a:wait(s)  a:hold(s)  a:at(t, fn)  a:after(dt, fn)  a:marker(name)  a:beat(label)
--   a:duration(s)  a:loop(bool)  a:priority("Action")  a:ease(style, dir)
return function(a)
	a:beat("anticipation")
	a:pose("guard")
	a:wait(0.25)
	a:pose("windup", { ease = "CubicV2", dir = "In" })
	a:wait(0.12)
	a:beat("action")
	a:marker("hit")
	a:pose("punch_extend", { ease = "CubicV2", dir = "Out" })
	a:hold(0.08)
	a:beat("recovery")
	a:wait(0.35)
	a:pose("guard")
	a:overlap("arms", { amount = 0.6 })
end
`

// ------------------------------------------------------------------ values

function vec3(v: unknown, what: string, line?: number): V3 {
  const o = v as Record<string, unknown>
  if (o && typeof o === 'object' && o.__t === 'v3') return [Number(o.x) || 0, Number(o.y) || 0, Number(o.z) || 0]
  if (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((x) => Number.isFinite(Number(x)))) return v.slice(0, 3).map(Number) as V3
  throw new AnimCompileError(`${what}: expected a Vector3`, line)
}

function cframeOf(v: unknown): Xf | null {
  const o = v as Record<string, unknown>
  if (o && typeof o === 'object' && o.__t === 'cf' && Array.isArray(o.c) && o.c.length >= 12) return cfToXf((o.c as number[]).map(Number))
  return null
}

function easeOf(v: unknown, line?: number): PoseEasingStyle | undefined {
  if (v === undefined || v === null) return undefined
  const s = String(v).replace(/^Enum\.PoseEasingStyle\./, '')
  const hit = POSE_EASING_STYLES.find((x) => x.toLowerCase() === s.toLowerCase())
  if (!hit) throw new AnimCompileError(`ease: "${s}" is not a PoseEasingStyle (${POSE_EASING_STYLES.join(', ')})`, line)
  return hit
}

function dirOf(v: unknown, line?: number): PoseEasingDirection | undefined {
  if (v === undefined || v === null) return undefined
  const s = String(v).replace(/^Enum\.PoseEasingDirection\./, '')
  const hit = POSE_EASING_DIRECTIONS.find((x) => x.toLowerCase() === s.toLowerCase())
  if (!hit) throw new AnimCompileError(`dir: "${s}" is not In, Out or InOut`, line)
  return hit
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]
    d[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j]
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return d[b.length]
}

function suggest(name: string, names: string[]): string {
  const l = name.toLowerCase()
  const near = names.filter((n) => n.toLowerCase().includes(l) || l.includes(n.toLowerCase()) || editDistance(l, n.toLowerCase()) <= 2).slice(0, 4)
  return near.length ? ` (did you mean ${near.join(', ')}?)` : ` (one of: ${names.join(', ')})`
}

const R6_NAMES = R6_JOINT_DEFS.map((d) => d.name)
const R6_NO_JOINT: Partial<Record<R15Joint, string>> = {
  Waist: 'R6 has one Torso (no Waist); turn or lean the body with a:root',
  LeftElbow: 'R6 arms have no elbow; aim the whole arm with "Left Shoulder" or a:ik("LeftArm", target)',
  RightElbow: 'R6 arms have no elbow; aim the whole arm with "Right Shoulder" or a:ik("RightArm", target)',
  LeftWrist: 'R6 has no LeftWrist (no hands)',
  RightWrist: 'R6 has no RightWrist (no hands)',
  LeftKnee: 'R6 legs have no knee; aim the whole leg with "Left Hip" or a:ik("LeftLeg", target)',
  RightKnee: 'R6 legs have no knee; aim the whole leg with "Right Hip" or a:ik("RightLeg", target)',
  LeftAnkle: 'R6 has no LeftAnkle (no feet)',
  RightAnkle: 'R6 has no RightAnkle (no feet)'
}

// A joint name in a script: the R15 name, or the R6 Motor6D / part name ("Right Shoulder",
// "RootJoint", "Torso"...), always resolved to the R15 name the kit and IK work with.
function jointOf(v: unknown, line?: number, rig: RigType = 'R15'): R15Joint {
  const s = String(v ?? '')
  const hit = R15_JOINTS.find((j) => j.toLowerCase() === s.toLowerCase()) ?? jointAlias(s)
  if (!hit) {
    const names = rig === 'R6' ? [...R6_NAMES, ...R6_CAPABLE] : [...R15_JOINTS]
    throw new AnimCompileError(`no ${rig} joint "${s}"${suggest(s, names)}`, line)
  }
  return hit
}

function groupOf(v: unknown, line?: number, rig: RigType = 'R15'): R15Joint[] {
  if (Array.isArray(v)) return v.map((x) => jointOf(x, line, rig))
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).map((x) => jointOf(x, line, rig))
  const s = String(v ?? 'all')
  const g = Object.entries(KIT_GROUPS).find(([k]) => k.toLowerCase() === s.toLowerCase())
  if (g) return g[1]
  if (isJoint(s)) return [s]
  return [jointOf(s, line, rig)]
}

// ------------------------------------------------------------------ learned poses as kit poses

export function learnedKitPoses(learned: LearnedPose[] = []): KitPose[] {
  return learned.map((p) => ({ name: `learned:${p.id}`, description: `Learned ${p.tag} pose (${p.count} keys, phase ${p.phase})`, tags: [p.tag], joints: p.joints, rootRot: p.root }))
}

// ------------------------------------------------------------------ compile

export interface CompileOptions {
  name?: string
  learned?: LearnedPose[]
  // Rig the clip is made for (default R15). On R6: no elbows / knees (IK aims the whole limb), kit
  // poses are collapsed, feet are planted by moving the root, and the clip stores R6 Motor6D tracks.
  rig?: RigType
}

export function compileAnim(ops: AnimOp[], script: string, opts: CompileOptions = {}): { clip: AnimClip; warnings: string[] } {
  if (ops.length > MAX_ANIM_OPS) throw new AnimCompileError(`the script made ${ops.length} calls; the limit is ${MAX_ANIM_OPS}`)
  // a:rig("R6") in the script wins over the rig the caller asks for.
  const scripted = [...ops].reverse().find((o) => o.op === 'rig')?.value
  const rig: RigType = (scripted ?? opts.rig) === 'R6' ? 'R6' : 'R15'
  const r6 = rig === 'R6'
  const r6Folded = new Set<R15Joint>()
  const tracks = new Tracks()
  const warnings: string[] = []
  const markers: AnimMarker[] = []
  const beats: AnimBeat[] = []
  const extraKit = learnedKitPoses(opts.learned)
  let name = opts.name ?? 'Animation'
  let duration: number | null = null
  let looped = false
  let priority: AnimPriority = 'Action'
  let ease = { ...DEFAULT_EASE }
  let mirror = false
  let feetLock = true
  const overlaps: { joints: R15Joint[]; o: { delay: number; freq: number; damping: number; amount: number }; line?: number }[] = []
  const plants: { foot: 'Left' | 'Right'; from: number; to: number; line?: number }[] = []
  const at = (op: AnimOp) => Math.max(0, Math.min(MAX_ANIM_DURATION, Math.round((Number(op.at) || 0) * 10000) / 10000))
  const keyEase = (op: AnimOp) => ({ style: easeOf(op.opts?.ease, op.line) ?? ease.style, dir: dirOf(op.opts?.dir, op.line) ?? ease.dir })

  for (const op of ops) {
    const t = at(op)
    switch (op.op) {
      case 'rig':
        if (op.value !== 'R6' && op.value !== 'R15') throw new AnimCompileError('rig: expected "R15" or "R6"', op.line)
        break
      case 'name':
        name = String(op.value ?? name).replace(/[^\w ]/g, '').slice(0, 50) || name
        break
      case 'duration':
        duration = Math.max(0.1, Math.min(MAX_ANIM_DURATION, Number(op.value) || 1))
        break
      case 'loop':
        looped = !!op.value
        break
      case 'priority': {
        const p = ANIM_PRIORITIES.find((x) => x.toLowerCase() === String(op.value ?? '').replace(/^Enum\.AnimationPriority\./, '').toLowerCase())
        if (!p) throw new AnimCompileError(`priority: expected one of ${ANIM_PRIORITIES.join(', ')}`, op.line)
        priority = p
        break
      }
      case 'ease':
        ease = { style: easeOf(op.value, op.line) ?? ease.style, dir: dirOf(op.opts?.dir, op.line) ?? ease.dir }
        break
      case 'marker':
        markers.push({ name: String(op.name ?? 'marker').slice(0, 60), t })
        break
      case 'beat':
        beats.push({ at: t, label: String(op.name ?? 'beat').slice(0, 40) })
        break
      case 'pose': {
        const kp = findKitPose(String(op.name ?? ''), extraKit)
        if (!kp) throw new AnimCompileError(`no pose "${op.name}"${suggest(String(op.name ?? ''), [...KIT_POSES.map((p) => p.name), ...extraKit.map((p) => p.name)])}`, op.line)
        const side = op.opts?.side === undefined ? undefined : String(op.opts.side).toLowerCase()
        if (side !== undefined && side !== 'left' && side !== 'right') throw new AnimCompileError('pose: side must be "left" or "right"', op.line)
        const only = op.opts?.only !== undefined ? groupOf(op.opts.only, op.line, rig) : undefined
        const r = resolveKitPose(kp, { side: side as 'left' | 'right' | undefined, amount: op.opts?.amount === undefined ? 1 : Number(op.opts.amount), only, rig })
        const e = keyEase(op)
        // A pose's root offset is relative to where the character has travelled (a:root moves it), so
        // a pose after a dash does not snap back to the start.
        const travel = tracks.map.has('Root') ? tracks.sample('Root', t).p : ([0, 0, 0] as V3)
        for (const [j, x] of Object.entries(r.joints) as [R15Joint, Xf][]) {
          tracks.set(j, t, j === 'Root' ? { p: [travel[0] + x.p[0], x.p[1], travel[2] + x.p[2]], q: x.q } : x, e.style, e.dir)
        }
        const grounded = op.opts?.grounded === undefined ? true : !!op.opts.grounded
        if (grounded && (!only || only.includes('Root'))) (r6 ? settleFeetR6 : settleFeet)(tracks, t, r.feet, e.style, e.dir)
        break
      }
      case 'joint': {
        const j = jointOf(op.joint, op.line, rig)
        if (r6 && !R6_OF_R15[j] && !r6Folded.has(j)) {
          r6Folded.add(j)
          warnings.push(`line ${op.line ?? '?'}: ${R6_NO_JOINT[j] ?? `R6 has no ${j}`}; its rotation only changes the direction of the R6 part`)
        }
        const e = keyEase(op)
        const cfv = cframeOf(op.rot)
        let x: Xf
        if (cfv) x = cfv
        else {
          const deg = vec3(op.rot, `joint ${j}`, op.line)
          x = { p: op.pos !== undefined && op.pos !== null ? vec3(op.pos, `joint ${j} position`, op.line) : [0, 0, 0], q: qeulerDeg(deg) }
        }
        if (op.opts?.add) {
          const cur = tracks.sample(j, t)
          x = { p: [cur.p[0] + x.p[0], cur.p[1] + x.p[1], cur.p[2] + x.p[2]], q: qmul(cur.q, x.q) }
        }
        tracks.set(j, t, x, e.style, e.dir)
        break
      }
      case 'root': {
        const e = keyEase(op)
        const cur = tracks.sample('Root', t)
        const p = op.pos !== undefined && op.pos !== null ? vec3(op.pos, 'root offset', op.line) : cur.p
        const q = op.rot !== undefined && op.rot !== null ? qeulerDeg(vec3(op.rot, 'root rotation', op.line)) : cur.q
        tracks.set('Root', t, { p, q }, e.style, e.dir)
        break
      }
      case 'ik': {
        const limb = Object.keys(LIMBS).find((l) => l.toLowerCase() === String(op.limb ?? '').toLowerCase()) as LimbName | undefined
        if (!limb) throw new AnimCompileError(`ik: limb must be one of ${Object.keys(LIMBS).join(', ')}`, op.line)
        const target = vec3(op.target, 'ik target', op.line)
        if (r6) {
          // The whole limb aims at the target (no elbow / knee); the R15 tracks get a straight limb so
          // the final collapse keeps exactly this direction.
          const a = aimLimbR6(collapsePose(tracks.pose(t)), limb, target)
          if (!a.reached) warnings.push(`line ${op.line ?? '?'}: ik ${limb}: an R6 limb cannot bend, so it is aimed at the target (the ${limb.endsWith('Arm') ? 'hand' : 'foot'} ends at ${a.end.map((v) => v.toFixed(1)).join(', ')})`)
          const e = keyEase(op)
          const L = LIMBS[limb]
          // Arms hang from the torso (UpperTorso = the R6 Torso); legs from LowerTorso, so undo the waist.
          const q = limb.endsWith('Arm') ? a.upper : qmul(tracks.sample('Waist', t).q, a.upper)
          tracks.set(L.upper, t, { p: tracks.sample(L.upper, t).p, q }, e.style, e.dir)
          tracks.set(L.lower, t, { p: [0, 0, 0], q: [0, 0, 0, 1] }, e.style, e.dir)
          break
        }
        const pole = op.opts?.pole !== undefined ? vec3(op.opts.pole, 'ik pole', op.line) : undefined
        const parts = forwardKinematics(tracks.pose(t))
        const r = solveTwoBone(parts, limb, target, { pole })
        if (!r.reached) warnings.push(`line ${op.line ?? '?'}: ik ${limb} target is out of reach; the limb is stretched toward it`)
        const e = keyEase(op)
        tracks.set(LIMBS[limb].upper, t, { p: [0, 0, 0], q: r.upper }, e.style, e.dir)
        tracks.set(LIMBS[limb].lower, t, { p: [0, 0, 0], q: r.lower }, e.style, e.dir)
        break
      }
      case 'look': {
        const target = vec3(op.target, 'look target', op.line)
        const parts = forwardKinematics(tracks.pose(t))
        const e = keyEase(op)
        tracks.set('Neck', t, { p: [0, 0, 0], q: lookAtRotation(parts, target, tracks.sample('Neck', t).q, op.opts?.weight === undefined ? 1 : Number(op.opts.weight)) }, e.style, e.dir)
        break
      }
      case 'hold': {
        const dt = Math.max(0, Math.min(5, Number(op.dt) || 0))
        if (!dt) break
        for (const [j, keys] of tracks.map) {
          if (!keys.length) continue
          const x = tracks.sample(j, t)
          tracks.set(j, t + dt, x, ease.style, ease.dir)
          const k = keys.find((k) => Math.abs(k.t - t) < 1e-4)
          if (!k) tracks.set(j, t, x, ease.style, ease.dir)
        }
        break
      }
      case 'plant': {
        const f = String(op.foot ?? '').toLowerCase()
        if (f !== 'left' && f !== 'right') throw new AnimCompileError('plant: foot must be "Left" or "Right"', op.line)
        const from = op.opts?.from !== undefined ? Number(op.opts.from) : t
        const to = Number(op.until)
        if (!Number.isFinite(to) || to <= from) throw new AnimCompileError('plant: expected plant(foot, from, to) with to > from', op.line)
        if (r6) warnings.push(`line ${op.line ?? '?'}: a:plant has no effect on R6 (legs have no knees to keep a foot still); the root sets the height instead`)
        else plants.push({ foot: f === 'left' ? 'Left' : 'Right', from, to, line: op.line })
        break
      }
      case 'overlap': {
        const o = op.opts ?? {}
        overlaps.push({
          joints: groupOf(op.group ?? 'arms', op.line, rig).filter((j) => j !== 'Root'),
          o: {
            delay: Math.max(0, Math.min(0.3, Number(o.delay ?? 0.04))),
            freq: Math.max(0.5, Math.min(12, Number(o.freq ?? 4))),
            damping: Math.max(0.05, Math.min(2, Number(o.damping ?? 0.45))),
            amount: Math.max(0, Math.min(1, Number(o.amount ?? 0.7)))
          },
          line: op.line
        })
        break
      }
      case 'feet':
        feetLock = op.value !== 'free'
        break
      case 'mirror':
        mirror = !mirror
        break
      default:
        throw new AnimCompileError(`unknown call "${(op as AnimOp).op}"`, (op as AnimOp).line)
    }
  }

  if (!tracks.map.size) throw new AnimCompileError('the script made no keys: call a:pose(...) or a:joint(...)')
  const D = Math.round((duration ?? Math.max(0.1, tracks.maxTime())) * 10000) / 10000
  // Looping clips close the loop: every track returns to its first key at the end.
  if (looped) {
    for (const [j, keys] of tracks.map) {
      const last = keys[keys.length - 1]
      if (last.t < D - 1e-4) tracks.set(j, D, keyXf(keys[0]), last.ease ?? ease.style, last.dir ?? ease.dir)
    }
  }
  // Key times of the body and legs before the passes add per-frame keys (the foot-lock beats).
  const lockTimes = (['Root', 'LeftHip', 'RightHip', 'LeftKnee', 'RightKnee', 'LeftAnkle', 'RightAnkle'] as R15Joint[]).flatMap((j) => (tracks.map.get(j) ?? []).map((k) => k.t))
  for (const ov of overlaps) overlapPass(tracks, ov.joints, D, ov.o)
  if (feetLock) (r6 ? footLockPassR6 : footLockPass)(tracks, D, lockTimes)
  for (const p of plants) {
    if (p.from >= D) {
      warnings.push(`line ${p.line ?? '?'}: plant starts after the clip ends`)
      continue
    }
    plantPass(tracks, p.foot, p.from, Math.min(D, p.to))
  }
  let out: Partial<Record<R15Joint, AnimKey[]>> = {}
  for (const [j, keys] of tracks.map) out[j] = normalizeKeys(keys.filter((k) => k.t <= D + 1e-4))
  if (mirror) {
    const m: Partial<Record<R15Joint, AnimKey[]>> = {}
    for (const [j, keys] of Object.entries(out) as [R15Joint, AnimKey[]][]) m[mirrorJoint(j)] = keys.map((k) => ({ ...k, cf: xfToCf(mirrorXf(cfToXf(k.cf))) }))
    out = m
  }
  markers.sort((a, b) => a.t - b.t)
  beats.sort((a, b) => a.at - b.at)
  let finalTracks: AnimClip['tracks'] = out
  // R6: the whole R15 result collapses onto the six R6 joints (limbs keep their overall direction).
  if (r6) finalTracks = r6TracksFromView(out)
  if (!markers.length) warnings.push('no a:marker(...): add markers (e.g. "hit", "release") so game code and VFX can sync to the clip')
  if (!beats.length) warnings.push('no a:beat(...): label the anticipation / action / recovery beats so the timeline and the critic can follow them')
  for (const m of markers) if (m.t > D + 1e-4) warnings.push(`marker "${m.name}" at ${m.t.toFixed(2)} s is after the end (${D.toFixed(2)} s)`)
  const clip: AnimClip = { name, duration: D, looped, priority, ...(r6 ? { rig: 'R6' as const } : {}), tracks: finalTracks, markers: markers.filter((m) => m.t <= D + 1e-4), beats, script, source: 'script' }
  return { clip, warnings }
}

// Recorder output -> clip (compile errors become script errors with a line), with patches re-applied.
export function finishAnimRun(rec: AnimRecordResult, script: string, opts: CompileOptions & { patches?: AnimClip['patches'] } = {}): { ok: boolean; clip?: AnimClip; error?: { message: string; line?: number }; prints: string[]; warnings: string[] } {
  const prints = rec.prints ?? []
  if (!rec.ok || rec.error) return { ok: false, error: rec.error ?? { message: 'the script failed' }, prints, warnings: [] }
  try {
    const { clip, warnings } = compileAnim(rec.ops ?? [], script, opts)
    if (opts.patches?.length) {
      const r = applyAnimChanges(clip, opts.patches)
      for (const x of r.rejected) warnings.push(`patch no longer applies: ${x.reason}`)
      return { ok: true, clip: { ...r.clip, patches: r.applied }, prints, warnings }
    }
    return { ok: true, clip, prints, warnings }
  } catch (e) {
    if (e instanceof AnimCompileError) return { ok: false, error: { message: e.message, ...(e.line ? { line: e.line } : {}) }, prints, warnings: [] }
    throw e
  }
}

// One line per key time (what the assistant reads back after a run).
export function clipSummary(clip: AnimClip, maxLines = 60): string {
  const times = new Map<number, string[]>()
  const r = (t: number) => Math.round(t * 100) / 100
  for (const [j, keys] of Object.entries(clip.tracks) as [string, AnimKey[]][]) {
    for (const k of keys) {
      const list = times.get(r(k.t)) ?? []
      list.push(j)
      times.set(r(k.t), list)
    }
  }
  const all = clip.rig === 'R6' ? R6_JOINT_DEFS.length : R15_JOINTS.length
  const lines = [`${clip.name}: ${clip.rig ?? 'R15'}, ${clip.duration.toFixed(2)} s${clip.looped ? ', looped' : ''}, priority ${clip.priority}, ${Object.keys(clip.tracks).length} joints`]
  if (clip.beats?.length) lines.push(`beats: ${clip.beats.map((b) => `${b.label} @ ${b.at.toFixed(2)}`).join(', ')}`)
  if (clip.markers.length) lines.push(`markers: ${clip.markers.map((m) => `${m.name} @ ${m.t.toFixed(2)}`).join(', ')}`)
  const sorted = [...times.entries()].sort((a, b) => a[0] - b[0])
  for (const [t, joints] of sorted.slice(0, maxLines)) lines.push(`${t.toFixed(2)}s  ${joints.length === all ? 'all joints' : joints.join(' ')}`)
  if (sorted.length > maxLines) lines.push(`... ${sorted.length - maxLines} more key times`)
  return lines.join('\n')
}

export { samplePose }
