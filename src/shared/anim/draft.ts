// What the model reads to write animation scripts (the API, the kit, the animation guide) and the
// built-in drafts: a script per move archetype whose timing comes from the learned style profile,
// used when no model is available (or as the starting point in the compose prompt).

import type { AnimStyleProfile, RigType } from './model.ts'
import { KIT_GROUPS, KIT_POSES } from './kit.ts'
import { promptTags } from './style.ts'
import { setArchetype, setPromptTags, type MoveSetDef } from './movesets.ts'
import { r6KitReferenceText } from './convert.ts'

export const ANIM_API = `Animation timeline API (Luau). The script is \`return function(a) ... end\`; Forge records the calls into R15 keyframes (a KeyframeSequence).
Clock: a:wait(s) moves the clock; a:hold(s) keeps the current pose for s seconds and moves the clock; a:at(t, fn) / a:after(dt, fn) run fn at another time; a:now().
Keys at the clock:
- a:pose(name, opts?)  a kit pose (or "learned:<id>" from the style profile). opts: side = "left" (mirror), amount = 0..1.5 (blend from rest / exaggerate), only = group or {joints}, ease, dir, grounded = false (skip planting the feet).
- a:joint(joint, Vector3 degrees | CFrame, opts?)  one joint (CFrame.Angles order, joint-local). opts: add = true (relative to the current pose), pos = Vector3 (Root only), ease, dir.
- a:root(offset?, degrees?, opts?)  LowerTorso offset from its rest (studs) and rotation (degrees): crouch drops, leans, turns.
- a:ik(limb, target, opts?)  two-bone IK: "RightArm" | "LeftArm" | "RightLeg" | "LeftLeg" to a point in character space (studs; feet on y = 0, chest about y = 3.3, the character faces -Z, its right is +X). opts: pole = Vector3 (where the elbow / knee points), ease, dir.
- a:look(target, opts?)  head looks at a point (opts.weight 0..1).
Easing: ease = "CubicV2" | "Linear" | "Constant" | "Elastic" | "Bounce", dir = "In" | "Out" | "InOut". A key's easing shapes the move FROM that key TO the next one (Roblox PoseBase.EasingStyle). Default CubicV2 InOut; a:ease(style, dir) changes the default for later keys.
Whole-clip passes: a:plant("Left" | "Right", from, to) keeps a foot planted (leg IK, no sliding); a:overlap(group, { delay = 0.04, freq = 4, damping = 0.45, amount = 0.7 }) adds spring follow-through; a:mirror() swaps left and right. Grounded feet are locked automatically between keys (small moves stay planted, big moves become arced steps); a:feet("free") turns that off.
Labels: a:marker(name) (exported KeyframeMarker: game code and VFX sync with GetMarkerReachedSignal), a:beat(label) (anticipation / action / recovery... for the timeline and the critic).
Clip: a:duration(s) (default: the last key), a:loop(true), a:priority("Idle" | "Movement" | "Action" | "Action2" | "Action3" | "Action4" | "Core"), a:name("DashPunch"), a:rig("R15" | "R6") (otherwise the clip's / project's rig).
Joints: Root Waist Neck LeftShoulder LeftElbow LeftWrist RightShoulder RightElbow RightWrist LeftHip LeftKnee LeftAnkle RightHip RightKnee RightAnkle. Groups: ${Object.keys(KIT_GROUPS).join(', ')}.
Angle conventions: Shoulder / Hip X+ raises the limb forward; Elbow X+ bends; Knee X- bends; Ankle X+ lifts the toes; right Shoulder Z+ raises the arm sideways (left: Z-); Waist / Root Y+ turns the body to its left; Waist X- leans forward; Neck X- looks down.`

// How the same API behaves on an R6 clip (the compose prompt and anim_kit add it for R6).
export const ANIM_API_R6 = `R6 rig (this clip is R6: Head, Torso, Left / Right Arm, Left / Right Leg; Motor6Ds RootJoint, Neck, Left / Right Shoulder, Left / Right Hip). The API is the same with these differences:
- Joints: RootJoint (= Root), Neck, "Right Shoulder" / "Left Shoulder" (= RightShoulder / LeftShoulder), "Right Hip" / "Left Hip". Angles use the same conventions as R15 (Shoulder / Hip X+ raises the limb forward); Forge converts them to the R6 Motor6Ds' rotated frames on export.
- There is no Waist, elbow, wrist, knee or ankle. Poses that bend them are collapsed: each arm / leg points where the R15 pose puts the hand / foot, the Torso follows the chest. a:joint on those joints only changes the direction of the R6 limb (with a warning). Lean and turn the whole body with a:root.
- a:ik aims the whole limb at the target (no bending); the hand or foot lands on the target only at arm's / leg's length (about 1.6 studs from the shoulder or hip).
- Feet: grounded poses move the root so the lowest planted leg touches the floor; a:plant has no effect and feet are not locked between keys, so keep the root's travel small while both feet are down (R6 legs slide otherwise).
- Make the extremes bigger than on R15: with straight limbs, silhouettes read from arm and leg angles and the root's lean.`

export function kitReferenceText(rig: RigType = 'R15'): string {
  const base = ['Pose kit (a:pose names; written right-handed, side = "left" mirrors):', ...KIT_POSES.map((p) => `- ${p.name}: ${p.description} [${p.tags.join(', ')}]`)].join('\n')
  return rig === 'R6' ? `${base}\n\n${r6KitReferenceText()}` : base
}

export const ANIM_GUIDE = `How good game animation reads (apply these, then match the learned style):
1. Anticipation: move opposite the action first (coil the torso back, sink the hips, pull the arm back). Short for fast attacks (3-6 frames at 30 fps), longer for heavy or charged moves.
2. Action: fast. The hit or release takes 2-5 frames; ease Out into the extreme (dir "Out" on the key before it is wrong: put dir "In" on the key BEFORE the action so it accelerates, or Linear for a snap).
3. Hold / impact: keep the extreme 2-6 frames (a:hold) so it reads; put the marker ("hit", "release") on the first frame of the extreme.
4. Recovery: slower than the action, settling with overshoot (a:overlap on arms and spine) back to a ready pose.
5. Weight: hips lead the shoulders; the body sinks into the knees; the back foot pivots (heel up); feet stay planted unless they step (a:plant the support foot).
6. Silhouette: open the limbs away from the body at the key poses; clear line of action; no arms hidden behind the torso from the front three-quarter view.
7. Arcs and offsets: hands travel on arcs (an IK key halfway); not every joint arrives together (overlap, delay the wrists and head).
8. Loops (idle): a:loop(true), small breathing motion on Waist and shoulders, 1.5-3 s, first and last pose identical.`

export interface DraftTiming {
  anticipation: number
  action: number
  hold: number
  recovery: number
}

export const DEFAULT_TIMING: DraftTiming = { anticipation: 0.22, action: 0.1, hold: 0.1, recovery: 0.4 }

export function timingFrom(profile?: AnimStyleProfile | null): DraftTiming {
  if (!profile || profile.samples < 1) return { ...DEFAULT_TIMING }
  const m = (v: number, lo: number, hi: number, d: number) => (v > 0 ? Math.max(lo, Math.min(hi, v)) : d)
  return {
    anticipation: m(profile.timing.anticipation.median, 0.06, 0.8, DEFAULT_TIMING.anticipation),
    action: m(profile.timing.action.median, 0.04, 0.4, DEFAULT_TIMING.action),
    hold: m(profile.timing.holds.median, 0.03, 0.4, DEFAULT_TIMING.hold),
    recovery: m(profile.timing.recovery.median, 0.15, 1.2, DEFAULT_TIMING.recovery)
  }
}

const n2 = (v: number) => (Math.round(v * 100) / 100).toString()

// header / celebrate / save / slide / trap are the drafts for the Football and Movement & emotes move
// sets (movesets.ts maps each tag to the closest archetype).
export type Archetype = 'sign_push' | 'dash_punch' | 'punch' | 'kick' | 'hit' | 'cast' | 'dash' | 'idle' | 'block' | 'jump' | 'header' | 'celebrate' | 'save' | 'slide' | 'trap'

// The archetype for a request. With a move set other than Combat, the set's tag decides (a "power
// shot" drafts a kick, a "diving header" a header); Combat keeps the original rules, except that a
// request only a custom move type matches uses that type's archetype.
export function archetypeFor(request: string, set?: MoveSetDef | null): Archetype {
  if (set && set.id !== 'combat') {
    const a = setArchetype(request, set)
    if (a) return a
  } else if (set && !promptTags(request).length) {
    const custom = set.tags.find((t) => t.custom && setPromptTags(request, { ...set, tags: [t] }).length)
    if (custom) return custom.archetype
  }
  const r = request.toLowerCase()
  const tags = promptTags(request)
  if (tags.includes('sign') || /gojo|hollow|purple|two[- ]finger/.test(r)) return 'sign_push'
  if (tags.includes('hit') && !tags.includes('attack')) return 'hit'
  if (tags.includes('dash') && (tags.includes('attack') || /punch|strike/.test(r))) return 'dash_punch'
  if (tags.includes('kick')) return 'kick'
  if (tags.includes('attack')) return 'punch'
  if (tags.includes('block')) return 'block'
  if (tags.includes('idle')) return 'idle'
  if (tags.includes('dash')) return 'dash'
  if (tags.includes('jump') || tags.includes('land')) return 'jump'
  if (tags.includes('cast')) return 'cast'
  return 'punch'
}

const header = (name: string) => `-- Name: ${name}\nreturn function(a)\n\ta:name("${name}")\n\ta:priority("Action")\n`

export function signPushScript(t: DraftTiming = DEFAULT_TIMING, name = 'SignPalmPush'): string {
  const charge = Math.max(0.45, t.anticipation * 2.4)
  return `${header(name)}\t-- Ready: settle from idle, eyes forward.
\ta:beat("ready")
\ta:pose("idle")
\ta:wait(0.22)
\t-- Sign: the right hand snaps up in front of the face (two fingers raised), head dips toward it.
\ta:beat("sign")
\ta:pose("two_finger_sign", { amount = 0.6, ease = "CubicV2", dir = "In" })
\ta:wait(0.12)
\ta:pose("two_finger_sign", { ease = "CubicV2", dir = "Out" })
\ta:look(Vector3.new(0.6, 4.4, -3), { weight = 0.5 })
\ta:marker("charge")
\t-- Charge: hold the sign, a slow tension build (the body sinks a little, the hand trembles forward).
\ta:hold(${n2(charge * 0.5)})
\ta:joint("Waist", Vector3.new(-3, 6, 0), { add = true })
\ta:joint("RightWrist", Vector3.new(-6, 0, 0), { add = true })
\ta:root(Vector3.new(0, -0.12, 0.05))
\ta:hold(${n2(charge * 0.5)})
\t-- Anticipation: the hand pulls back past the shoulder, the torso coils right.
\ta:beat("anticipation")
\ta:wait(${n2(t.anticipation)})
\ta:pose("windup", { only = "upper", amount = 0.75, ease = "CubicV2", dir = "In" })
\ta:ik("RightArm", Vector3.new(1.3, 3.0, 0.5), { ease = "CubicV2", dir = "In" })
\ta:joint("RightWrist", Vector3.new(70, 0, 0), { ease = "CubicV2", dir = "In" })
\t-- Release: palm thrust forward, hips through, front foot steps in.
\ta:beat("release")
\ta:wait(${n2(t.action)})
\ta:pose("palm_push", { ease = "CubicV2", dir = "Out" })
\ta:marker("release")
\ta:hold(${n2(Math.max(0.12, t.hold * 1.6))})
\t-- Recovery: settle back to idle with follow-through.
\ta:beat("recovery")
\ta:wait(${n2(t.recovery)})
\ta:pose("idle")
\ta:plant("Right", 0, a:now())
\ta:overlap("arms", { delay = 0.035, amount = 0.6 })
\ta:overlap("spine", { delay = 0.05, amount = 0.4, freq = 3 })
end
`
}

export function dashPunchScript(t: DraftTiming = DEFAULT_TIMING, name = 'DashPunch'): string {
  return `${header(name)}\t-- Guard, then sink and lean in before the burst.
\ta:beat("anticipation")
\ta:pose("guard")
\ta:wait(0.08)
\ta:pose("guard", { ease = "CubicV2", dir = "In" })
\ta:root(Vector3.new(0, -0.35, 0.25), Vector3.new(6, -26, 0), { ease = "CubicV2", dir = "In" })
\ta:wait(${n2(t.anticipation)})
\t-- Dash: low forward lean, arms swept back, lead knee drives.
\ta:beat("dash")
\ta:root(Vector3.new(0, 0, -1.4), nil, { ease = "Linear" })
\ta:pose("dash_lean", { ease = "Linear" })
\ta:wait(0.14)
\t-- Windup inside the dash: the right fist cocks while the left foot lands.
\ta:beat("windup")
\ta:pose("windup", { ease = "CubicV2", dir = "In" })
\ta:wait(${n2(t.action)})
\t-- Strike: full extension, marker on the first frame of the extreme.
\ta:beat("strike")
\ta:pose("punch_extend", { amount = 1.1, ease = "CubicV2", dir = "Out" })
\ta:marker("hit")
\ta:hold(${n2(t.hold)})
\t-- Recovery back to guard.
\ta:beat("recovery")
\ta:wait(${n2(t.recovery)})
\ta:pose("guard")
\ta:overlap("arms", { delay = 0.03, amount = 0.65 })
\ta:overlap({ "Waist", "Neck" }, { delay = 0.04, amount = 0.45, freq = 3.5 })
end
`
}

export function hitReactionScript(t: DraftTiming = DEFAULT_TIMING, name = 'HitReaction'): string {
  return `${header(name)}\t-- The blow lands on the first frame: no anticipation for a reaction.
\ta:beat("impact")
\ta:pose("guard")
\ta:marker("impact")
\ta:wait(0.07)
\t-- Snap back: chest and head thrown back, arms flung.
\ta:pose("recoil", { amount = 1.15, ease = "CubicV2", dir = "Out" })
\ta:hold(0.06)
\t-- Stagger: fold forward over the knees, arms up to cover.
\ta:beat("stagger")
\ta:wait(0.2)
\ta:pose("flinch", { ease = "CubicV2", dir = "InOut" })
\ta:root(Vector3.new(0, -0.3, 0.3), Vector3.new(-10, 6, 0))
\ta:hold(0.08)
\t-- Recover to guard.
\ta:beat("recovery")
\ta:wait(${n2(Math.max(0.35, t.recovery))})
\ta:pose("guard")
\ta:plant("Right", 0, a:now())
\ta:overlap({ "Waist", "Neck" }, { delay = 0.05, amount = 0.7, freq = 3.2, damping = 0.35 })
\ta:overlap("arms", { delay = 0.04, amount = 0.6 })
end
`
}

function punchScript(t: DraftTiming, name = 'Punch'): string {
  return `${header(name)}\ta:beat("anticipation")
\ta:pose("guard")
\ta:wait(0.06)
\ta:pose("windup", { ease = "CubicV2", dir = "In" })
\ta:wait(${n2(t.anticipation)})
\ta:beat("action")
\ta:wait(${n2(t.action)})
\ta:pose("punch_extend", { ease = "CubicV2", dir = "Out" })
\ta:marker("hit")
\ta:hold(${n2(t.hold)})
\ta:beat("recovery")
\ta:wait(${n2(t.recovery)})
\ta:pose("guard")
\ta:plant("Right", 0, a:now())
\ta:overlap("arms", { amount = 0.6 })
end
`
}

function kickScript(t: DraftTiming, name = 'FrontKick', amount?: number): string {
  return `${header(name)}\ta:beat("anticipation")
\ta:pose("guard")
\ta:wait(${n2(t.anticipation)})
\ta:pose("kick_chamber", { ease = "CubicV2", dir = "In" })
\ta:beat("action")
\ta:wait(${n2(t.action + 0.04)})
\ta:pose("kick_extend", { ${amount ? `amount = ${n2(amount)}, ` : ''}ease = "CubicV2", dir = "Out" })
\ta:marker("hit")
\ta:hold(${n2(t.hold)})
\ta:beat("recovery")
\ta:wait(0.12)
\ta:pose("kick_chamber", { amount = 0.8 })
\ta:wait(${n2(t.recovery)})
\ta:pose("guard")
\ta:plant("Left", 0, a:now())
\ta:overlap("arms", { amount = 0.6 })
end
`
}

function castScript(t: DraftTiming, name = 'Cast'): string {
  return `${header(name)}\ta:beat("anticipation")
\ta:pose("idle")
\ta:wait(0.1)
\ta:pose("crouch", { amount = 0.45, ease = "CubicV2", dir = "In" })
\ta:wait(${n2(t.anticipation * 1.5)})
\ta:beat("charge")
\ta:pose("cast_raise", { ease = "CubicV2", dir = "Out" })
\ta:marker("charge")
\ta:hold(0.3)
\ta:beat("release")
\ta:wait(${n2(t.action)})
\ta:pose("palm_push", { ease = "CubicV2", dir = "Out" })
\ta:marker("release")
\ta:hold(${n2(t.hold)})
\ta:beat("recovery")
\ta:wait(${n2(t.recovery)})
\ta:pose("idle")
\ta:overlap("arms", { amount = 0.6 })
end
`
}

function dashScript(t: DraftTiming, name = 'Dash'): string {
  return `${header(name)}\ta:beat("anticipation")
\ta:pose("idle")
\ta:wait(0.05)
\ta:pose("crouch", { amount = 0.5, ease = "CubicV2", dir = "In" })
\ta:wait(${n2(t.anticipation)})
\ta:beat("dash")
\ta:pose("dash_lean", { ease = "Linear" })
\ta:marker("dash")
\ta:hold(0.18)
\ta:beat("recovery")
\ta:wait(${n2(t.recovery)})
\ta:pose("land", { amount = 0.5 })
\ta:wait(0.2)
\ta:pose("idle")
\ta:overlap("arms", { amount = 0.6 })
end
`
}

function idleScript(name = 'Idle'): string {
  return `${header(name).replace('a:priority("Action")', 'a:priority("Idle")')}\ta:loop(true)
\ta:beat("inhale")
\ta:pose("guard")
\ta:wait(1)
\ta:beat("exhale")
\ta:pose("guard", { amount = 0.92 })
\ta:joint("Waist", Vector3.new(3, 0, 0), { add = true })
\ta:joint("RightShoulder", Vector3.new(4, 0, 0), { add = true })
\ta:joint("LeftShoulder", Vector3.new(4, 0, 0), { add = true })
\ta:wait(1)
\ta:duration(2)
\ta:marker("loop")
\ta:overlap("arms", { delay = 0.06, amount = 0.5, freq = 1.5 })
end
`
}

function blockScript(t: DraftTiming, name = 'Block'): string {
  return `${header(name)}\ta:beat("anticipation")
\ta:pose("guard")
\ta:wait(${n2(Math.max(0.06, t.anticipation * 0.5))})
\ta:beat("block")
\ta:pose("block_cross", { ease = "CubicV2", dir = "Out" })
\ta:marker("block")
\ta:hold(0.35)
\ta:beat("recovery")
\ta:wait(${n2(t.recovery)})
\ta:pose("guard")
\ta:overlap("arms", { amount = 0.5 })
end
`
}

function jumpScript(t: DraftTiming, name = 'JumpLand'): string {
  return `${header(name)}\ta:beat("anticipation")
\ta:pose("idle")
\ta:wait(0.06)
\ta:pose("crouch", { ease = "CubicV2", dir = "In" })
\ta:wait(${n2(t.anticipation)})
\ta:beat("air")
\ta:pose("jump_tuck", { ease = "CubicV2", dir = "Out" })
\ta:marker("takeoff")
\ta:wait(0.35)
\ta:pose("jump_tuck", { amount = 0.6, ease = "CubicV2", dir = "In" })
\ta:wait(0.15)
\ta:beat("land")
\ta:pose("land")
\ta:marker("land")
\ta:hold(0.08)
\ta:beat("recovery")
\ta:wait(${n2(t.recovery)})
\ta:pose("idle")
\ta:overlap("arms", { amount = 0.6 })
end
`
}

// Header: sink, jump with the back arched and the head back, then snap the neck and torso forward
// through the ball (marker "hit" on the contact frame), land and recover.
function headerScript(t: DraftTiming, name = 'Header'): string {
  return `${header(name)}\ta:beat("anticipation")
\ta:pose("idle")
\ta:wait(0.06)
\ta:pose("crouch", { amount = 0.55, ease = "CubicV2", dir = "In" })
\ta:wait(${n2(t.anticipation)})
\ta:beat("jump")
\ta:pose("jump_tuck", { amount = 0.45, ease = "CubicV2", dir = "Out" })
\ta:root(Vector3.new(0, 1.1, 0), Vector3.new(12, 0, 0), { ease = "CubicV2", dir = "Out" })
\ta:joint("Waist", Vector3.new(14, 0, 0), { ease = "CubicV2", dir = "Out" })
\ta:joint("Neck", Vector3.new(24, 0, 0), { ease = "CubicV2", dir = "Out" })
\ta:marker("takeoff")
\ta:wait(0.2)
\ta:beat("header")
\ta:wait(${n2(t.action)})
\ta:root(Vector3.new(0, 1.2, -0.25), Vector3.new(-14, 0, 0), { ease = "CubicV2", dir = "Out" })
\ta:joint("Waist", Vector3.new(-22, 0, 0), { ease = "CubicV2", dir = "Out" })
\ta:joint("Neck", Vector3.new(-28, 0, 0), { ease = "CubicV2", dir = "Out" })
\ta:marker("hit")
\ta:hold(${n2(t.hold)})
\ta:beat("land")
\ta:wait(0.22)
\ta:pose("land", { amount = 0.7 })
\ta:marker("land")
\ta:hold(0.06)
\ta:beat("recovery")
\ta:wait(${n2(t.recovery)})
\ta:pose("idle")
\ta:overlap("arms", { amount = 0.6 })
\ta:overlap("spine", { delay = 0.05, amount = 0.4, freq = 3 })
end
`
}

// Celebration: dip, burst up with both arms overhead (held), then point to the crowd with the other
// arm raised (held), settle.
function celebrateScript(t: DraftTiming, name = 'Celebration'): string {
  return `${header(name)}\ta:beat("anticipation")
\ta:pose("idle")
\ta:wait(0.08)
\ta:pose("crouch", { amount = 0.4, ease = "CubicV2", dir = "In" })
\ta:wait(${n2(t.anticipation)})
\ta:beat("cheer")
\ta:wait(${n2(Math.max(0.1, t.action))})
\ta:pose("cast_raise", { amount = 1.1, ease = "CubicV2", dir = "Out" })
\ta:marker("cheer")
\ta:hold(0.35)
\ta:beat("pose")
\ta:wait(0.18)
\ta:pose("point", { ease = "CubicV2", dir = "Out" })
\ta:joint("LeftShoulder", Vector3.new(150, 0, -20), { ease = "CubicV2", dir = "Out" })
\ta:joint("Waist", Vector3.new(8, 10, 0), { ease = "CubicV2", dir = "Out" })
\ta:look(Vector3.new(0, 5, -6), { weight = 0.5 })
\ta:marker("pose")
\ta:hold(0.5)
\ta:beat("recovery")
\ta:wait(${n2(t.recovery)})
\ta:pose("idle")
\ta:overlap("arms", { delay = 0.04, amount = 0.6 })
\ta:overlap("spine", { delay = 0.05, amount = 0.4, freq = 3 })
end
`
}

// Keeper save: ready crouch with the hands out, push off and dive to the right (arms reaching
// overhead, body rolled), the catch, then land and get up.
function saveScript(t: DraftTiming, name = 'KeeperSave'): string {
  return `${header(name)}\ta:beat("ready")
\ta:pose("crouch", { amount = 0.45 })
\ta:joint("RightShoulder", Vector3.new(40, 0, 30))
\ta:joint("LeftShoulder", Vector3.new(40, 0, -30))
\ta:wait(${n2(Math.max(0.12, t.anticipation))})
\ta:feet("free")
\ta:beat("dive")
\ta:wait(${n2(Math.max(0.12, t.action * 1.5))})
\ta:pose("cast_raise", { only = "upper", ease = "CubicV2", dir = "Out" })
\ta:pose("jump_tuck", { only = "legs", amount = 0.35, ease = "CubicV2", dir = "Out" })
\ta:root(Vector3.new(1.6, 0.7, 0), Vector3.new(0, 0, -55), { ease = "CubicV2", dir = "Out" })
\ta:marker("save")
\ta:hold(${n2(Math.max(0.1, t.hold * 1.5))})
\ta:beat("land")
\ta:wait(0.25)
\ta:pose("land", { amount = 0.8 })
\ta:marker("land")
\ta:hold(0.12)
\ta:beat("recovery")
\ta:wait(${n2(t.recovery)})
\ta:pose("idle")
\ta:overlap("arms", { amount = 0.6 })
end
`
}

// Slide tackle: drop low, slide forward on the left leg with the right leg reaching for the ball,
// lean back, then get up.
function slideScript(t: DraftTiming, name = 'SlideTackle'): string {
  return `${header(name)}\ta:beat("anticipation")
\ta:pose("idle")
\ta:wait(0.05)
\ta:pose("crouch", { amount = 0.5, ease = "CubicV2", dir = "In" })
\ta:wait(${n2(t.anticipation)})
\ta:feet("free")
\ta:beat("slide")
\ta:wait(${n2(Math.max(0.1, t.action))})
\ta:pose("kick_extend", { only = "legs", ease = "CubicV2", dir = "Out" })
\ta:joint("LeftKnee", Vector3.new(-80, 0, 0), { ease = "CubicV2", dir = "Out" })
\ta:root(Vector3.new(0, -1, -1.8), Vector3.new(25, 0, 0), { ease = "CubicV2", dir = "Out" })
\ta:joint("RightShoulder", Vector3.new(30, 0, 40))
\ta:joint("LeftShoulder", Vector3.new(-20, 0, -30))
\ta:marker("hit")
\ta:hold(${n2(Math.max(0.18, t.hold * 2))})
\ta:beat("recovery")
\ta:wait(${n2(t.recovery)})
\ta:pose("crouch", { amount = 0.6 })
\ta:wait(0.25)
\ta:pose("idle")
\ta:overlap("arms", { amount = 0.6 })
end
`
}

// First touch: lift the right foot to meet the ball, cushion it down (soft hold), back to ready.
function trapScript(t: DraftTiming, name = 'Trap'): string {
  return `${header(name)}\ta:beat("ready")
\ta:pose("idle")
\ta:wait(${n2(Math.max(0.1, t.anticipation))})
\ta:beat("touch")
\ta:pose("kick_chamber", { amount = 0.45, ease = "CubicV2", dir = "Out" })
\ta:joint("Waist", Vector3.new(-10, 0, 0), { ease = "CubicV2", dir = "Out" })
\ta:joint("Neck", Vector3.new(-25, 0, 0), { ease = "CubicV2", dir = "Out" })
\ta:marker("touch")
\ta:beat("cushion")
\ta:wait(0.16)
\ta:pose("kick_chamber", { amount = 0.25, ease = "CubicV2", dir = "InOut" })
\ta:hold(${n2(Math.max(0.08, t.hold))})
\ta:beat("recovery")
\ta:wait(${n2(t.recovery)})
\ta:pose("idle")
\ta:overlap("arms", { amount = 0.5 })
end
`
}

// R6 versions of the archetypes (straight limbs: no wrist / waist keys, no plants, the root leans and
// turns the body). The other archetypes use the R15 script; the compiler collapses it onto R6.
export function signPushScriptR6(t: DraftTiming = DEFAULT_TIMING, name = 'SignPalmPushR6'): string {
  const charge = Math.max(0.45, t.anticipation * 2.4)
  return `${header(name)}\ta:rig("R6")
\t-- Ready: settle from idle, eyes forward.
\ta:beat("ready")
\ta:pose("idle")
\ta:wait(0.22)
\t-- Sign: the right arm swings up so the hand is in front of the face, head dips toward it.
\ta:beat("sign")
\ta:pose("two_finger_sign", { amount = 0.6, ease = "CubicV2", dir = "In" })
\ta:wait(0.12)
\ta:pose("two_finger_sign", { ease = "CubicV2", dir = "Out" })
\ta:ik("RightArm", Vector3.new(0.35, 4.3, -1.1), { ease = "CubicV2", dir = "Out" })
\ta:look(Vector3.new(0.6, 4.4, -3), { weight = 0.5 })
\ta:marker("charge")
\t-- Charge: hold the sign while the body sinks and leans in a little.
\ta:hold(${n2(charge * 0.5)})
\ta:root(Vector3.new(0, -0.1, 0.05), Vector3.new(-4, 8, 0))
\ta:joint("Right Shoulder", Vector3.new(6, 0, 0), { add = true })
\ta:hold(${n2(charge * 0.5)})
\t-- Anticipation: the arm pulls back past the shoulder, the body coils right.
\ta:beat("anticipation")
\ta:wait(${n2(t.anticipation)})
\ta:pose("windup", { only = "upper", amount = 0.75, ease = "CubicV2", dir = "In" })
\ta:ik("RightArm", Vector3.new(2.3, 2.9, 0.5), { ease = "CubicV2", dir = "In" })
\ta:root(Vector3.new(0, -0.15, 0.15), Vector3.new(-6, -24, 0), { ease = "CubicV2", dir = "In" })
\t-- Release: the straight arm thrusts forward at shoulder height, body turns through.
\ta:beat("release")
\ta:wait(${n2(t.action)})
\ta:pose("palm_push", { ease = "CubicV2", dir = "Out" })
\ta:ik("RightArm", Vector3.new(0.9, 3.5, -2.5), { ease = "CubicV2", dir = "Out" })
\ta:root(Vector3.new(0, -0.2, -0.25), Vector3.new(-10, 18, 0), { ease = "CubicV2", dir = "Out" })
\ta:marker("release")
\ta:hold(${n2(Math.max(0.12, t.hold * 1.6))})
\t-- Recovery: settle back to idle with follow-through.
\ta:beat("recovery")
\ta:wait(${n2(t.recovery)})
\ta:pose("idle")
\ta:root(Vector3.new(0, 0, 0), Vector3.new(0, 0, 0))
\ta:overlap("arms", { delay = 0.035, amount = 0.6 })
\ta:overlap({ "Neck" }, { delay = 0.05, amount = 0.4, freq = 3 })
end
`
}

export function dashPunchScriptR6(t: DraftTiming = DEFAULT_TIMING, name = 'DashPunchR6'): string {
  return `${header(name)}\ta:rig("R6")
\t-- Guard, then lean in before the burst.
\ta:beat("anticipation")
\ta:pose("guard")
\ta:wait(0.08)
\ta:pose("guard", { ease = "CubicV2", dir = "In" })
\ta:root(Vector3.new(0, -0.2, 0.25), Vector3.new(8, -26, 0), { ease = "CubicV2", dir = "In" })
\ta:wait(${n2(t.anticipation)})
\t-- Dash: forward lean, arms swept back, lead leg forward.
\ta:beat("dash")
\ta:pose("dash_lean", { ease = "Linear" })
\ta:root(Vector3.new(0, -0.1, -1.4), Vector3.new(-18, 0, 0), { ease = "Linear" })
\ta:wait(0.14)
\t-- Windup inside the dash.
\ta:beat("windup")
\ta:pose("windup", { ease = "CubicV2", dir = "In" })
\ta:root(nil, Vector3.new(-6, -30, 0), { ease = "CubicV2", dir = "In" })
\ta:wait(${n2(t.action)})
\t-- Strike: straight arm at full reach, marker on the first frame of the extreme.
\ta:beat("strike")
\ta:pose("punch_extend", { amount = 1.1, ease = "CubicV2", dir = "Out" })
\ta:ik("RightArm", Vector3.new(0.6, 3.4, -4.2), { ease = "CubicV2", dir = "Out" })
\ta:marker("hit")
\ta:hold(${n2(t.hold)})
\t-- Recovery back to guard.
\ta:beat("recovery")
\ta:wait(${n2(t.recovery)})
\ta:pose("guard")
\ta:overlap("arms", { delay = 0.03, amount = 0.65 })
end
`
}

export function hitReactionScriptR6(t: DraftTiming = DEFAULT_TIMING, name = 'HitReactionR6'): string {
  return `${header(name)}\ta:rig("R6")
\t-- The blow lands on the first frame; the feet stay put (no step), only the body reacts.
\ta:beat("impact")
\ta:pose("guard")
\ta:marker("impact")
\ta:wait(0.07)
\t-- Snap back: body and head thrown back, arms flung out.
\ta:pose("recoil", { amount = 1.2, only = "upper", ease = "CubicV2", dir = "Out" })
\ta:root(Vector3.new(0, 0, 0.12), Vector3.new(8, 8, 0), { ease = "CubicV2", dir = "Out" })
\ta:hold(0.06)
\t-- Stagger: fold forward, arms up to cover.
\ta:beat("stagger")
\ta:wait(0.2)
\ta:pose("flinch", { only = "upper", ease = "CubicV2", dir = "InOut" })
\ta:root(Vector3.new(0, -0.1, 0.1), Vector3.new(-12, 6, 0))
\ta:hold(0.08)
\t-- Recover to guard.
\ta:beat("recovery")
\ta:wait(${n2(Math.max(0.35, t.recovery))})
\ta:pose("guard")
\ta:overlap("arms", { delay = 0.04, amount = 0.6 })
\ta:overlap({ "Neck" }, { delay = 0.05, amount = 0.6, freq = 3.2, damping = 0.35 })
end
`
}

// The other archetypes on R6: the same script marked a:rig("R6"), without foot plants (an R6 leg has
// no knee to plant with; the automatic foot lock still keeps grounded feet still).
function asR6(script: string): string {
  return script
    .replace(/^(return function\(a\)\n)/m, '$1\ta:rig("R6")\n')
    .split('\n')
    .filter((l) => !/^\s*a:plant\(/.test(l))
    .join('\n')
}

const pascal = (tag: string) => tag.split(/[\s-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('')

// The built-in draft (no model). set: the active move set (default Combat, the original drafts);
// under another set the clip is named after the move type ("Shot", "Header") and a pass is a lighter kick.
export function draftAnimScript(request: string, profile?: AnimStyleProfile | null, rig: RigType = 'R15', set?: MoveSetDef | null): string {
  const t = timingFrom(profile)
  const arch = archetypeFor(request, set)
  const tag = set && set.id !== 'combat' ? setPromptTags(request, set).find((x) => set.tags.find((d) => d.tag === x)?.archetype === arch) : undefined
  const name = tag ? pascal(tag) || undefined : undefined
  if (rig === 'R6') {
    if (arch === 'sign_push') return signPushScriptR6(t, name)
    if (arch === 'dash_punch') return dashPunchScriptR6(t, name)
    if (arch === 'hit') return hitReactionScriptR6(t, name)
    return asR6(draftAnimScript(request, profile, 'R15', set))
  }
  switch (arch) {
    case 'sign_push':
      return signPushScript(t, name)
    case 'dash_punch':
      return dashPunchScript(t, name)
    case 'hit':
      return hitReactionScript(t, name)
    case 'kick':
      return kickScript(t, name, tag === 'pass' ? 0.75 : tag === 'shot' ? 1.1 : undefined)
    case 'cast':
      return castScript(t, name)
    case 'dash':
      return dashScript(t, name)
    case 'idle':
      return idleScript(name)
    case 'block':
      return blockScript(t, name)
    case 'jump':
      return jumpScript(t, name)
    case 'header':
      return headerScript(t, name)
    case 'celebrate':
      return celebrateScript(t, name)
    case 'save':
      return saveScript(t, name)
    case 'slide':
      return slideScript(t, name)
    case 'trap':
      return trapScript(t, name)
    default:
      return punchScript(t, name)
  }
}
