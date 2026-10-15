// Motion intent: which limb must lead a move. The parts a request names come from bodyparts.ts
// (words and move-type tags); this adds the skill words that imply a leg (elastico, rabona, step-over,
// volley...) and the lead side: a sided word ("right foot") wins, else the nearest real clips decide
// (the side most of them do the move with) and give the expected size of the lead limb's swing. The
// checks turn the lead into a must-fix (it has to move about as much as in the references and must not
// be out-moved by the other side), the critic is told never to shrink it, and the guarded refinement
// rejects edits that do. Pure code: no model, no electron.

import type { AnimClip, R15Joint } from './model.ts'
import { jointRange, PART_JOINTS, requestedParts, type BodyPart, type PartRequest } from './bodyparts.ts'
import { r15View } from './convert.ts'

export type Limb = 'RightLeg' | 'LeftLeg' | 'RightArm' | 'LeftArm'
export const LIMBS: Limb[] = ['RightLeg', 'LeftLeg', 'RightArm', 'LeftArm']
export type LimbKind = 'leg' | 'arm'

export const LIMB_LABEL: Record<Limb, string> = { RightLeg: 'right leg', LeftLeg: 'left leg', RightArm: 'right arm', LeftArm: 'left arm' }
export const limbKind = (l: Limb): LimbKind => (l.endsWith('Leg') ? 'leg' : 'arm')
export const otherSide = (l: Limb): Limb => (l.startsWith('Right') ? (l.replace('Right', 'Left') as Limb) : (l.replace('Left', 'Right') as Limb))
export const limbOf = (kind: LimbKind, side: 'right' | 'left'): Limb => `${side === 'right' ? 'Right' : 'Left'}${kind === 'leg' ? 'Leg' : 'Arm'}` as Limb

// Skill words that are done with a leg even when the request names no body part.
const LEG_SKILLS = /\b(elastico|flip[\s-]?flap|step[\s-]?overs?|stepover\w*|rabona|nutmeg\w*|cruyff|roulette|marseille|rainbow|scissor\w*|drag[\s-]?back|croqueta|volley\w*|chip\w*|curler|toe[\s-]?poke|bicycle|scorpion|back[\s-]?heel\w*|heel[\s-]?flick|juggl\w*|keepy[\s-]?uppy|kick\w*|shot|shoot\w*|pass|passes|passing|cross(?:es|ing)?\s+(?:the\s+)?(?:ball|in|into|field)|tackl\w*|trap\w*|dribbl\w*|stomp\w*|sweep\w*|roundhouse)\b/i
const ARM_SKILLS = /\b(punch\w*|jab\w*|uppercut\w*|hook|slash\w*|swing\w*|throw\w*|palm|wave|waving|salute|chop|backhand|haymaker)\b/i

// Widest joint rotation (degrees) per limb plus head and torso, over the whole clip.
export type LimbRanges = Record<Limb | 'head' | 'torso', number>

export function limbRanges(clip: AnimClip): LimbRanges {
  const view = r15View(clip)
  const range = (joints: R15Joint[]) => Math.max(0, ...joints.map((j) => jointRange(view, j, 30)))
  const out = {} as LimbRanges
  for (const l of LIMBS) out[l] = Math.round(range(PART_JOINTS[l]) * 10) / 10
  out.head = Math.round(range(PART_JOINTS.head) * 10) / 10
  out.torso = Math.round(range(PART_JOINTS.torso) * 10) / 10
  return out
}

// The limb of a kind that does the move in a clip: the side that moves clearly more (null when both
// sides move about the same, or the kind barely moves at all).
export function dominantLimb(ranges: LimbRanges, kind: LimbKind): Limb | null {
  const r = ranges[limbOf(kind, 'right')]
  const l = ranges[limbOf(kind, 'left')]
  if (Math.max(r, l) < 10 || Math.max(r, l) < Math.min(r, l) * 1.15) return null
  return r > l ? limbOf(kind, 'right') : limbOf(kind, 'left')
}

export interface LeadIntent {
  limb: Limb
  // What decided the side: the word in the request, or "references".
  source: string
  // Median swing of the lead limb in the references (degrees), when they decided or agree.
  refDeg?: number
  // Must-fix below minDeg, weak below warnDeg.
  minDeg: number
  warnDeg: number
}

export interface MotionIntent {
  // Every part that must move (the lead replaces the unsided part of its kind).
  parts: PartRequest[]
  lead?: LeadIntent
}

const BASE: Record<LimbKind, [number, number]> = { leg: [14, 24], arm: [14, 24] }

const kindOfPart = (p: BodyPart): LimbKind | null => (p === 'head' || p === 'torso' ? null : p.endsWith('Leg') || p === 'leg' ? 'leg' : 'arm')

// The request's parts plus the lead limb. refs: the nearest real clips of the move (they decide the
// side when the words do not, and how big the lead swing has to be).
export function motionIntent(request: string, tags: string[] = [], refs: AnimClip[] = []): MotionIntent {
  const parts = requestedParts(request, tags)
  const text = String(request ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_]+/g, ' ')
  let kind: LimbKind | null = null
  for (const p of parts) {
    const k = kindOfPart(p.part)
    if (k && p.part !== 'leg' && p.part !== 'arm') {
      kind = k
      break
    }
    kind ??= k
  }
  if (!kind && !parts.some((p) => p.part === 'head')) {
    // The skill word that comes first decides ("jab cross" is a punch, "cross into the box" a pass).
    const leg = LEG_SKILLS.exec(text)
    const arm = ARM_SKILLS.exec(text)
    const m = leg && (!arm || leg.index <= arm.index) ? leg : arm
    if (m) {
      kind = m === leg ? 'leg' : 'arm'
      parts.push({ part: kind, source: m[0].toLowerCase() })
    }
  }
  if (!kind) return { parts }
  // The reference side and swing.
  const refRanges = refs.map(limbRanges)
  const sides = refRanges.map((r) => dominantLimb(r, kind!)).filter((x): x is Limb => !!x)
  const votes = new Map<Limb, number>()
  for (const s of sides) votes.set(s, (votes.get(s) ?? 0) + 1)
  const top = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]
  const refSide = top && top[1] >= Math.max(1, Math.ceil(refRanges.length * 0.6)) ? top[0] : null
  const sided = parts.find((p) => p.part !== 'leg' && p.part !== 'arm' && kindOfPart(p.part) === kind)
  const limb = (sided?.part as Limb | undefined) ?? refSide
  if (!limb) return { parts }
  // Swing of the dominant limb in each reference (a left-footed reference counts its left leg).
  const swings = refRanges.map((r) => Math.max(r[limbOf(kind!, 'right')], r[limbOf(kind!, 'left')])).filter((v) => v > 0).sort((a, b) => a - b)
  const refDeg = swings.length ? swings[Math.floor((swings.length - 1) / 2)] : undefined
  const [baseMin, baseWarn] = BASE[kind]
  const minDeg = refDeg ? Math.round(Math.max(baseMin, Math.min(60, refDeg * 0.5))) : baseMin
  const warnDeg = refDeg ? Math.round(Math.max(minDeg + 5, Math.min(80, refDeg * 0.75))) : baseWarn
  const lead: LeadIntent = { limb, source: sided ? sided.source : 'references', ...(refDeg ? { refDeg: Math.round(refDeg) } : {}), minDeg, warnDeg }
  // The lead replaces the unsided part of its kind ("leg" from a shot tag becomes "right leg").
  const out = parts.filter((p) => p.part !== kind)
  if (!out.some((p) => p.part === limb)) out.unshift({ part: limb, source: lead.source })
  return { parts: out, lead }
}

// One line for the compose and critic prompts.
export function intentText(intent: MotionIntent | null | undefined, ranges?: LimbRanges): string {
  if (!intent?.lead && !intent?.parts.length) return ''
  const lines: string[] = []
  const lead = intent.lead
  if (lead) {
    const why = lead.source === 'references' ? 'the closest library clips do this move with it' : `the request says "${lead.source.replace(/^tag:/, '')}"`
    const now = ranges ? ` It currently swings ${Math.round(ranges[lead.limb])}°${ranges[otherSide(lead.limb)] ? ` (the ${LIMB_LABEL[otherSide(lead.limb)]} ${Math.round(ranges[otherSide(lead.limb)])}°)` : ''}.` : ''
    lines.push(`Motion intent: the ${LIMB_LABEL[lead.limb]} leads this move (${why}); it must clearly do the move: at least ${lead.minDeg}° of joint swing${lead.refDeg ? `, about ${lead.refDeg}° in the references` : ''}, and more than the ${LIMB_LABEL[otherSide(lead.limb)]}.${now} Never shrink the ${LIMB_LABEL[lead.limb]}'s swing; the other ${limbKind(lead.limb)} supports.`)
  }
  const rest = intent.parts.filter((p) => p.part !== lead?.limb)
  if (rest.length) lines.push(`Also named: ${rest.map((p) => `${p.part === 'torso' ? 'upper body' : p.part} ("${p.source.replace(/^tag:/, '')}")`).join(', ')}; these must visibly move.`)
  return lines.join('\n')
}
