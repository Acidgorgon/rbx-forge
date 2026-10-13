// Built-in Animation Lab examples, written with the timeline API (draft.ts holds the scripts so the
// drafter and the examples share them). They double as few-shot examples for anim_compose and as
// starting points in the library. Their recorded ops are kept in examples.recorded.ts so they load
// without Lune (regenerate: node --experimental-strip-types build/anim-examples.ts).

import type { RigType } from './model.ts'
import { dashPunchScript, dashPunchScriptR6, hitReactionScript, hitReactionScriptR6, signPushScript, signPushScriptR6 } from './draft.ts'

export interface AnimExample {
  key: string
  name: string
  description: string
  tags: string[]
  script: string
  // R15 when absent. R6 examples are written for R6 (a:rig("R6"), straight limbs).
  rig?: RigType
}

export const ANIM_EXAMPLES: AnimExample[] = [
  {
    key: 'sign-push',
    name: 'SignPalmPush',
    description: 'A two-finger hand sign held in front of the face while energy charges, then a coiled wind-up into a forward palm push. Markers "charge" (sign is up) and "release" (palm at full extension) sync the VFX.',
    tags: ['sign', 'cast', 'attack'],
    script: signPushScript()
  },
  {
    key: 'dash-punch',
    name: 'DashPunch',
    description: 'Guard, sink, a low forward dash with the fist cocked mid-dash, then a full-extension straight punch. Marker "hit" on the extreme frame.',
    tags: ['dash', 'attack'],
    script: dashPunchScript()
  },
  {
    key: 'hit-reaction',
    name: 'HitReaction',
    description: 'Taking a blow to the chest: snap back on frame one, stagger and fold forward, then recover to guard. Marker "impact" at 0.',
    tags: ['hit'],
    script: hitReactionScript()
  },
  {
    key: 'sign-push-r6',
    name: 'SignPalmPushR6',
    description: 'R6 version of SignPalmPush: the right arm swings up so the hand is in front of the face while energy charges, the body coils, then the straight arm thrusts forward. Markers "charge" and "release".',
    tags: ['sign', 'cast', 'attack', 'r6'],
    script: signPushScriptR6(),
    rig: 'R6'
  },
  {
    key: 'dash-punch-r6',
    name: 'DashPunchR6',
    description: 'R6 version of DashPunch: guard, lean in, a forward dash with the body leaning, then a straight-arm punch at full reach. Marker "hit".',
    tags: ['dash', 'attack', 'r6'],
    script: dashPunchScriptR6(),
    rig: 'R6'
  },
  {
    key: 'hit-reaction-r6',
    name: 'HitReactionR6',
    description: 'R6 version of HitReaction: snap back from a blow to the chest, fold forward with the arms up, recover to guard. Marker "impact" at 0.',
    tags: ['hit', 'r6'],
    script: hitReactionScriptR6(),
    rig: 'R6'
  }
]

export function animExample(key: string): AnimExample | undefined {
  return ANIM_EXAMPLES.find((e) => e.key === key)
}
