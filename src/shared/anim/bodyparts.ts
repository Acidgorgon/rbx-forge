// Named body parts: a request that says which part does the move ("right foot pushes the ball out",
// "diving header", "palm strike") must show that part moving. The parts come from the words (with
// left / right) and from the move-type tags (a shot, pass, dribble or trap is a leg move; a header is
// a head move). The motion is measured as the widest rotation range of the part's joints over the
// clip; a named part that barely moves is a must-fix (checks.ts adds the issue, critique.ts caps the
// score and keeps refinement from preferring an iteration that lost the motion). Pure code.

import type { AnimClip, R15Joint } from './model.ts'
import { qangle, type Quat } from './math.ts'
import { sampleTrack } from './sample.ts'
import { r15View } from './convert.ts'

export type BodyPart = 'RightLeg' | 'LeftLeg' | 'leg' | 'RightArm' | 'LeftArm' | 'arm' | 'head' | 'torso'

export interface PartRequest {
  part: BodyPart
  // What asked for it: the word in the request ("right foot") or the tag ("tag:shot").
  source: string
}

export interface PartMotion extends PartRequest {
  label: string
  // Widest rotation range (degrees) of the part's joints over the clip.
  rangeDeg: number
  // Below this it barely moves (must-fix); below warnDeg it is weak.
  minDeg: number
  warnDeg: number
  ok: boolean
  joint?: R15Joint
}

const LEG = String.raw`foot|feet|leg|legs|kick\w*|knee\w*|shin|shins|toe|toes|heel|heels|thigh|thighs|stomp\w*|instep|laces|sole`
const ARM = String.raw`hand|hands|arm|arms|fist|fists|punch\w*|elbow\w*|wrist|wrists|palm|palms|finger\w*|forearm\w*|jab|uppercut|wave|waving|clap\w*|throw\w*`
const HEAD = String.raw`head|header\w*|heading|neck|nod\w*|headbutt\w*`
const TORSO = String.raw`torso|chest|upper\s?body|spine|waist|shoulders`

const KINDS: { kind: 'leg' | 'arm' | 'head' | 'torso'; re: RegExp }[] = [
  { kind: 'leg', re: new RegExp(String.raw`\b(?:(right|left)\s+(?:\w+\s+)?)?(${LEG})\b`, 'gi') },
  { kind: 'arm', re: new RegExp(String.raw`\b(?:(right|left)\s+(?:\w+\s+)?)?(${ARM})\b`, 'gi') },
  { kind: 'head', re: new RegExp(String.raw`\b()(${HEAD})\b`, 'gi') },
  { kind: 'torso', re: new RegExp(String.raw`\b()(${TORSO})\b`, 'gi') }
]

// A clause that keeps the part still ("feet stay planted") does not ask for motion.
const STILL = /\b(planted|plant|still|stationary|grounded|frozen|locked|motionless|steady|static|don'?t\s+move|no\s+movement|stays?\s+(?:down|put))\b/i

// Move-type tags whose move is done with one part (Football and Combat sets).
export const TAG_PARTS: Record<string, BodyPart> = {
  shot: 'leg',
  pass: 'leg',
  dribble: 'leg',
  trap: 'leg',
  tackle: 'leg',
  kick: 'leg',
  header: 'head',
  save: 'arm',
  throw: 'arm'
}

export const PART_JOINTS: Record<BodyPart, R15Joint[]> = {
  RightLeg: ['RightHip', 'RightKnee', 'RightAnkle'],
  LeftLeg: ['LeftHip', 'LeftKnee', 'LeftAnkle'],
  leg: ['RightHip', 'RightKnee', 'RightAnkle', 'LeftHip', 'LeftKnee', 'LeftAnkle'],
  RightArm: ['RightShoulder', 'RightElbow', 'RightWrist'],
  LeftArm: ['LeftShoulder', 'LeftElbow', 'LeftWrist'],
  arm: ['RightShoulder', 'RightElbow', 'RightWrist', 'LeftShoulder', 'LeftElbow', 'LeftWrist'],
  head: ['Neck'],
  torso: ['Waist', 'Root']
}

const LABEL: Record<BodyPart, string> = { RightLeg: 'right leg', LeftLeg: 'left leg', leg: 'legs', RightArm: 'right arm', LeftArm: 'left arm', arm: 'arms', head: 'head', torso: 'upper body' }

// Must-fix below the first number, weak below the second (degrees of joint rotation range).
const THRESHOLDS: Record<'leg' | 'arm' | 'head' | 'torso', [number, number]> = { leg: [14, 24], arm: [14, 24], head: [8, 14], torso: [5, 9] }
const kindOf = (p: BodyPart): 'leg' | 'arm' | 'head' | 'torso' => (p === 'head' || p === 'torso' ? p : p.endsWith('Leg') || p === 'leg' ? 'leg' : 'arm')

// Parts the request (and the clip's move-type tags) name. A sided part ("right foot") replaces the
// unsided one of the same kind; a tag only adds a part the words did not already name.
export function requestedParts(request: string, tags: string[] = []): PartRequest[] {
  const out = new Map<BodyPart, PartRequest>()
  const text = String(request ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_]+/g, ' ')
  for (const clause of text.split(/[,.;:!?\n]+|\bthen\b|\bwhile\b|\band\b/i)) {
    if (!clause.trim() || STILL.test(clause)) continue
    for (const { kind, re } of KINDS) {
      re.lastIndex = 0
      for (let m = re.exec(clause); m; m = re.exec(clause)) {
        const side = (m[1] ?? '').toLowerCase()
        const part: BodyPart = kind === 'head' || kind === 'torso' ? kind : side ? (`${side === 'right' ? 'Right' : 'Left'}${kind === 'leg' ? 'Leg' : 'Arm'}` as BodyPart) : kind
        if (!out.has(part)) out.set(part, { part, source: m[0].trim().toLowerCase() })
      }
    }
  }
  for (const t of tags) {
    const part = TAG_PARTS[t]
    if (!part) continue
    const sided = [...out.keys()].some((p) => kindOf(p) === kindOf(part))
    if (!sided && !out.has(part)) out.set(part, { part, source: `tag:${t}` })
  }
  // "right foot" and "foot" in one request: the sided one is the stricter requirement.
  for (const k of ['leg', 'arm'] as const) if (out.has(k) && [...out.keys()].some((p) => p !== k && kindOf(p) === k)) out.delete(k)
  return [...out.values()]
}

// Widest rotation range (degrees) of a joint over the clip (max pairwise angle between samples).
export function jointRange(clip: AnimClip, joint: R15Joint, samples = 36): number {
  const keys = clip.tracks[joint]
  if (!keys?.length) return 0
  const qs: Quat[] = []
  for (let i = 0; i <= samples; i++) {
    const x = sampleTrack(keys, (clip.duration * i) / samples)
    if (x) qs.push(x.q)
  }
  let best = 0
  for (let i = 0; i < qs.length; i++) for (let j = i + 1; j < qs.length; j++) best = Math.max(best, qangle(qs[i], qs[j]))
  return (best * 180) / Math.PI
}

export function measureParts(clip: AnimClip, parts: PartRequest[]): PartMotion[] {
  const view = r15View(clip)
  return parts.map((r) => {
    let rangeDeg = 0
    let joint: R15Joint | undefined
    for (const j of PART_JOINTS[r.part]) {
      const v = jointRange(view, j)
      if (v > rangeDeg) {
        rangeDeg = v
        joint = j
      }
    }
    const [minDeg, warnDeg] = THRESHOLDS[kindOf(r.part)]
    return { ...r, label: LABEL[r.part], rangeDeg: Math.round(rangeDeg * 10) / 10, minDeg, warnDeg, ok: rangeDeg >= minDeg, ...(joint ? { joint } : {}) }
  })
}

// The parts a request names that barely move in the clip.
export function missingParts(motion: PartMotion[] | undefined | null): PartMotion[] {
  return (motion ?? []).filter((m) => !m.ok)
}

export function partMustFix(m: PartMotion): string {
  return `the request names the ${m.label} ("${m.source.replace(/^tag:/, '')}") but it barely moves (${m.rangeDeg.toFixed(0)}° of joint rotation, needs at least ${m.minDeg}°); make the ${m.label} do the move`
}
