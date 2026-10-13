// Built-in Animation Lab examples, written with the timeline API (draft.ts holds the scripts so the
// drafter and the examples share them). They double as few-shot examples for anim_compose and as
// starting points in the library. Their recorded ops are kept in examples.recorded.ts so they load
// without Lune (regenerate: node --experimental-strip-types build/anim-examples.ts).

import { dashPunchScript, hitReactionScript, signPushScript } from './draft.ts'

export interface AnimExample {
  key: string
  name: string
  description: string
  tags: string[]
  script: string
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
  }
]

export function animExample(key: string): AnimExample | undefined {
  return ANIM_EXAMPLES.find((e) => e.key === key)
}
