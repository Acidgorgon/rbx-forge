// KeyframeSequence <-> AnimClip. Roblox stores an animation as a KeyframeSequence (Loop, Priority)
// holding Keyframes (Time) that hold a Pose tree named after parts (HumanoidRootPart > LowerTorso >
// UpperTorso > ...), each Pose with CFrame = the Motor6D.Transform of the joint whose Part1 it names,
// EasingStyle / EasingDirection (how it eases to the next key) and Weight (0 = a container that only
// carries its children), plus KeyframeMarker children (Name, Value) for GetMarkerReachedSignal.
//
// The XML (.rbxmx) side is read here with the VFX Lab's small XML reader; binary .rbxm comes in
// through Lune (resources/lune/anim_extract.luau) in the same RawSequence shape. R6 sequences
// (Torso, "Left Arm"...) are retargeted onto R15 joints.

import { parseXml, type XmlEl } from '../vfx/rbxmx.ts'
import { ANIM_PRIORITIES, POSE_EASING_DIRECTIONS, POSE_EASING_STYLES, R15_JOINTS, type AnimClip, type AnimKey, type AnimPriority, type PoseEasingDirection, type PoseEasingStyle, type R15Joint } from './model.ts'
import type { AnimMarker } from './types.ts'
import { cfToXf, isCf, qconj, qeuler, qmul, qrot, xfToCf, type CF, type Xf } from './math.ts'
import { normalizeKeys } from './sample.ts'
import { JOINT_OF_PART, JOINTS, PART_OF_JOINT, type R15Part } from './r15.ts'

export interface RawPose {
  name: string
  cf: number[]
  style?: number | string
  dir?: number | string
  weight?: number
  children: RawPose[]
}

export interface RawKeyframe {
  time: number
  name?: string
  poses: RawPose[]
  markers: { name: string; value?: string }[]
}

export interface RawSequence {
  name: string
  loop?: boolean
  priority?: number | string
  keyframes: RawKeyframe[]
}

export class AnimParseError extends Error {}

// ------------------------------------------------------------------ enums

export function easingStyleOf(v: unknown): PoseEasingStyle {
  if (typeof v === 'number') return POSE_EASING_STYLES[v] ?? 'Linear'
  const s = String(v ?? '').replace(/^Enum\.PoseEasingStyle\./, '')
  return (POSE_EASING_STYLES as readonly string[]).includes(s) ? (s as PoseEasingStyle) : 'Linear'
}

export function easingDirOf(v: unknown): PoseEasingDirection {
  if (typeof v === 'number') return POSE_EASING_DIRECTIONS[v] ?? 'In'
  const s = String(v ?? '').replace(/^Enum\.PoseEasingDirection\./, '')
  return (POSE_EASING_DIRECTIONS as readonly string[]).includes(s) ? (s as PoseEasingDirection) : 'In'
}

const PRIORITY_VALUE: Record<AnimPriority, number> = { Idle: 0, Movement: 1, Action: 2, Action2: 3, Action3: 4, Action4: 5, Core: 1000 }

export function priorityOf(v: unknown): AnimPriority {
  if (typeof v === 'number') return (Object.entries(PRIORITY_VALUE).find(([, n]) => n === v)?.[0] as AnimPriority) ?? 'Action'
  const s = String(v ?? '').replace(/^Enum\.AnimationPriority\./, '')
  return (ANIM_PRIORITIES as readonly string[]).includes(s) ? (s as AnimPriority) : 'Action'
}

// ------------------------------------------------------------------ XML read

const childEl = (el: XmlEl, name: string) => el.children.find((c) => c.name === name)
const num = (s: string | undefined) => {
  const v = Number(String(s ?? '').trim())
  return Number.isFinite(v) ? v : 0
}

function props(item: XmlEl): Map<string, XmlEl> {
  const m = new Map<string, XmlEl>()
  const p = childEl(item, 'Properties')
  for (const c of p?.children ?? []) if (c.attrs.name) m.set(c.attrs.name, c)
  return m
}

function cframeOf(el: XmlEl | undefined): number[] {
  if (!el) return [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]
  return ['X', 'Y', 'Z', 'R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22'].map((k) => num(childEl(el, k)?.text))
}

function items(el: XmlEl, cls?: string): XmlEl[] {
  return el.children.filter((c) => c.name === 'Item' && (!cls || c.attrs.class === cls))
}

function readPose(item: XmlEl): RawPose {
  const p = props(item)
  return {
    name: p.get('Name')?.text ?? '',
    cf: cframeOf(p.get('CFrame')),
    style: num(p.get('EasingStyle')?.text),
    dir: num(p.get('EasingDirection')?.text),
    weight: p.has('Weight') ? num(p.get('Weight')!.text) : 1,
    children: items(item, 'Pose').map(readPose)
  }
}

function readSequence(item: XmlEl): RawSequence {
  const p = props(item)
  return {
    name: p.get('Name')?.text ?? 'Animation',
    loop: p.get('Loop')?.text.trim() === 'true',
    priority: num(p.get('Priority')?.text),
    keyframes: items(item, 'Keyframe').map((k) => {
      const kp = props(k)
      return {
        time: num(kp.get('Time')?.text),
        name: kp.get('Name')?.text,
        poses: items(k, 'Pose').map(readPose),
        markers: items(k, 'KeyframeMarker').map((m) => {
          const mp = props(m)
          return { name: mp.get('Name')?.text ?? 'marker', value: mp.get('Value')?.text ?? '' }
        })
      }
    })
  }
}

// Every KeyframeSequence in an .rbxmx (anywhere in the tree).
export function readKeyframeSequencesXml(xml: string): RawSequence[] {
  const doc = parseXml(xml)
  const out: RawSequence[] = []
  const walk = (el: XmlEl) => {
    for (const it of items(el)) {
      if (it.attrs.class === 'KeyframeSequence') out.push(readSequence(it))
      else walk(it)
    }
  }
  walk(doc.children.find((c) => c.name === 'roblox') ?? doc)
  return out
}

// ------------------------------------------------------------------ retarget (pose names -> joints)

// R6 Motor6Ds have rotated C0/C1 (Roblox's default R6 rig), so their Transform is expressed in a
// rotated joint frame. Rotating it back gives the equivalent R15 joint-local transform.
const R6: Record<string, { joint: R15Joint; c0: [number, number, number] }> = {
  Torso: { joint: 'Root', c0: [-Math.PI / 2, 0, Math.PI] },
  Head: { joint: 'Neck', c0: [-Math.PI / 2, 0, Math.PI] },
  'Right Arm': { joint: 'RightShoulder', c0: [0, Math.PI / 2, 0] },
  'Left Arm': { joint: 'LeftShoulder', c0: [0, -Math.PI / 2, 0] },
  'Right Leg': { joint: 'RightHip', c0: [0, Math.PI / 2, 0] },
  'Left Leg': { joint: 'LeftHip', c0: [0, -Math.PI / 2, 0] }
}

function conjugate(t: Xf, e: [number, number, number]): Xf {
  const r = qeuler(e[0], e[1], e[2])
  return { p: qrot(r, t.p), q: qmul(qmul(r, t.q), qconj(r)) }
}

export interface RetargetInfo {
  rig: 'R15' | 'R6' | 'unknown'
  unmapped: string[]
}

// RawSequence -> AnimClip (keys per R15 joint; containers with Weight 0 are skipped).
// Lune's serde writes an empty Luau table as {} (not []), so lists from anim_extract may be objects.
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
function cleanPose(p: RawPose): RawPose {
  return { ...p, children: list<RawPose>(p.children).map(cleanPose) }
}
export function normalizeRawSequence(seq: RawSequence): RawSequence {
  return { ...seq, keyframes: list<RawKeyframe>(seq.keyframes).map((k) => ({ ...k, poses: list<RawPose>(k.poses).map(cleanPose), markers: list<RawKeyframe['markers'][number]>(k.markers) })) }
}

export function clipFromSequence(rawSeq: RawSequence, opts: { source?: AnimClip['source']; name?: string } = {}): { clip: AnimClip; info: RetargetInfo } {
  const seq = normalizeRawSequence(rawSeq)
  const names = new Set<string>()
  const scan = (p: RawPose) => {
    names.add(p.name)
    p.children.forEach(scan)
  }
  for (const k of seq.keyframes) k.poses.forEach(scan)
  const isR6 = names.has('Torso') && !names.has('UpperTorso')
  const unmapped = new Set<string>()
  const tracks: Partial<Record<R15Joint, AnimKey[]>> = {}
  const markers: AnimMarker[] = []
  let maxT = 0
  for (const kf of seq.keyframes) {
    const t = Math.max(0, Number(kf.time) || 0)
    maxT = Math.max(maxT, t)
    for (const m of kf.markers) markers.push({ name: String(m.name || 'marker').slice(0, 60), t })
    const visit = (p: RawPose) => {
      p.children.forEach(visit)
      if (p.name === 'HumanoidRootPart') return
      if ((p.weight ?? 1) <= 0) return
      let joint: R15Joint | undefined
      let x = cfToXf(isCf(p.cf) ? p.cf : [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])
      if (isR6) {
        const r = R6[p.name]
        if (r) {
          joint = r.joint
          x = conjugate(x, r.c0)
        }
      } else joint = JOINT_OF_PART[p.name]
      if (!joint) {
        unmapped.add(p.name)
        return
      }
      ;(tracks[joint] ??= []).push({ t, cf: xfToCf(x), ease: easingStyleOf(p.style), dir: easingDirOf(p.dir) })
    }
    kf.poses.forEach(visit)
  }
  for (const j of Object.keys(tracks) as R15Joint[]) tracks[j] = normalizeKeys(tracks[j]!)
  markers.sort((a, b) => a.t - b.t)
  const clip: AnimClip = {
    name: (opts.name ?? seq.name ?? 'Animation').slice(0, 60),
    duration: Math.max(0.05, Math.round(maxT * 1000) / 1000),
    looped: !!seq.loop,
    priority: priorityOf(seq.priority),
    tracks,
    markers,
    source: opts.source ?? 'rbxmx'
  }
  return { clip, info: { rig: isR6 ? 'R6' : Object.keys(tracks).length ? 'R15' : 'unknown', unmapped: [...unmapped] } }
}

// ------------------------------------------------------------------ write

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const fmt = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6
  return Object.is(r, -0) ? '0' : String(r)
}

// Pose tree order: which part holds which (Part0 -> Part1 children).
const CHILDREN: Record<string, R15Part[]> = {}
for (const j of R15_JOINTS) (CHILDREN[JOINTS[j].part0] ??= []).push(JOINTS[j].part1)

// AnimClip -> KeyframeSequence .rbxmx (one Keyframe per key time, markers on Keyframes at their time,
// a closing Keyframe at the clip's duration so the track length matches).
export function writeKeyframeSequenceXml(clip: AnimClip): string {
  const times = new Set<number>()
  const r3 = (t: number) => Math.round(t * 1000) / 1000
  for (const keys of Object.values(clip.tracks)) for (const k of keys ?? []) times.add(r3(k.t))
  for (const m of clip.markers) times.add(r3(m.t))
  times.add(r3(clip.duration))
  const sorted = [...times].filter((t) => t >= 0 && t <= clip.duration + 1e-6).sort((a, b) => a - b)
  let ref = 0
  const nextRef = () => `RBX${(ref++).toString(16).toUpperCase().padStart(8, '0')}`
  const lines: string[] = [
    '<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">',
    '\t<External>null</External>',
    '\t<External>nil</External>',
    `\t<Item class="KeyframeSequence" referent="${nextRef()}">`,
    '\t\t<Properties>',
    `\t\t\t<string name="Name">${esc(clip.name)}</string>`,
    `\t\t\t<bool name="Loop">${clip.looped ? 'true' : 'false'}</bool>`,
    `\t\t\t<token name="Priority">${PRIORITY_VALUE[clip.priority] ?? 2}</token>`,
    '\t\t\t<float name="AuthoredHipHeight">2</float>',
    '\t\t</Properties>'
  ]
  const keyAt = (j: R15Joint, t: number) => clip.tracks[j]?.find((k) => Math.abs(r3(k.t) - t) < 5e-4)
  for (const t of sorted) {
    lines.push(`\t\t<Item class="Keyframe" referent="${nextRef()}">`, '\t\t\t<Properties>', `\t\t\t\t<string name="Name">Keyframe</string>`, `\t\t\t\t<float name="Time">${fmt(t)}</float>`, '\t\t\t</Properties>')
    // A part's Pose is written when it or any descendant has a key at t.
    const has = (part: R15Part): boolean => {
      const j = JOINT_OF_PART[part]
      if (j && keyAt(j, t)) return true
      return (CHILDREN[part] ?? []).some(has)
    }
    const pose = (part: R15Part, depth: number) => {
      const pad = '\t'.repeat(depth)
      const j = JOINT_OF_PART[part]
      const k = j ? keyAt(j, t) : undefined
      const cf: CF = k?.cf ?? [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]
      const c = ['X', 'Y', 'Z', 'R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22'].map((name, i) => `<${name}>${fmt(cf[i])}</${name}>`).join('')
      lines.push(
        `${pad}<Item class="Pose" referent="${nextRef()}">`,
        `${pad}\t<Properties>`,
        `${pad}\t\t<string name="Name">${part}</string>`,
        `${pad}\t\t<CoordinateFrame name="CFrame">${c}</CoordinateFrame>`,
        `${pad}\t\t<token name="EasingDirection">${POSE_EASING_DIRECTIONS.indexOf(k?.dir ?? 'In')}</token>`,
        `${pad}\t\t<token name="EasingStyle">${POSE_EASING_STYLES.indexOf(k?.ease ?? 'Linear')}</token>`,
        `${pad}\t\t<float name="Weight">${k ? 1 : 0}</float>`,
        `${pad}\t</Properties>`
      )
      for (const c of CHILDREN[part] ?? []) if (has(c)) pose(c, depth + 1)
      lines.push(`${pad}</Item>`)
    }
    if (has('HumanoidRootPart')) pose('HumanoidRootPart', 3)
    for (const m of clip.markers.filter((m) => Math.abs(r3(m.t) - t) < 5e-4)) {
      lines.push(`\t\t\t<Item class="KeyframeMarker" referent="${nextRef()}">`, '\t\t\t\t<Properties>', `\t\t\t\t\t<string name="Name">${esc(m.name)}</string>`, '\t\t\t\t\t<string name="Value"></string>', '\t\t\t\t</Properties>', '\t\t\t</Item>')
    }
    lines.push('\t\t</Item>')
  }
  lines.push('\t</Item>', '</roblox>')
  return lines.join('\n') + '\n'
}

export { PART_OF_JOINT }
