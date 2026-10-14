// The principle catalogues: the 12 animation principles adapted for blocky Roblox rigs plus four
// game-specific ones, and the VFX principles for ParticleEmitter / Beam / Trail / light effects. Each
// has a one-line rule, how it applies in Roblox, a good and a bad example, and what the code checks
// measure (animChecks.ts, vfxChecks.ts, abilityChecks.ts). The compose planner (select.ts) and the
// critics pick the relevant ones per request; the catalogue is never sent whole.

import type { Principle, PrincipleDomain } from './types.ts'

export const ANIM_PRINCIPLES: Principle[] = [
  {
    id: 'squash-stretch',
    domain: 'anim',
    name: 'Squash and stretch',
    rule: 'Bodies compress before a push and extend through the action, keeping their volume.',
    roblox: 'R15 / R6 parts are rigid and cannot scale in an animation: express it through pose compression (crouch, bent knees, curled spine) and extension (straight line of action, limbs reaching), and with Root height.',
    good: 'A jump crouches low (Root down, knees bent) then extends fully at takeoff, arms reaching up.',
    bad: 'The body keeps the same height and outline from windup to strike; nothing compresses or stretches.',
    measure: 'body extent range: silhouette spread min vs max and Root height dip',
    plan: 'where does the body compress, and where does it fully extend?',
    kinds: ['attack', 'locomotion', 'reaction'],
    base: 0.8,
    words: /squash|stretch|compress|stiff|rigid|extend/i
  },
  {
    id: 'anticipation',
    domain: 'anim',
    name: 'Anticipation',
    rule: 'A smaller opposite move telegraphs the main action before it happens.',
    roblox: 'Wind up in the opposite direction (pull the arm back, lean away, dip the Root) before the release marker; long enough to read, short enough not to feel like input lag.',
    good: 'A punch pulls the shoulder back and turns the waist away for 0.2 s, then snaps forward.',
    bad: 'The arm shoots forward from the idle pose with no windup, so the hit pops.',
    measure: 'windup length versus the action, from the motion-speed curve',
    plan: 'what anticipates the action, in which direction, and for how long?',
    kinds: ['attack', 'locomotion', 'reaction', 'emote'],
    base: 1.2,
    words: /anticipat|wind ?up|telegraph|windup|no build|out of nowhere|pops/i
  },
  {
    id: 'staging',
    domain: 'anim',
    name: 'Staging',
    rule: 'Present one idea at a time, clearly, from the camera the player has.',
    roblox: 'Players see the character from a third-person camera behind and above: pose the action to read from there (side or three-quarter), not only from the front.',
    good: 'The strike happens to the side of the body where the camera sees the arm against the background.',
    bad: 'The key action happens behind the torso or straight at the camera, hidden by the body.',
    measure: null,
    plan: null,
    kinds: ['attack', 'emote'],
    base: 0.8,
    words: /staging|hidden|can'?t tell|unclear|camera|angle/i
  },
  {
    id: 'pose-to-pose',
    domain: 'anim',
    name: 'Straight ahead and pose to pose',
    rule: 'Block strong key poses first, then fill the in-betweens; use straight-ahead only for chaotic motion.',
    roblox: 'Script the extremes (a:pose) at beats and let Roblox easing in-between; reserve dense keys for flailing, cloth-like or mocap motion.',
    good: 'Four clear keys (ready, windup, strike, recover) with eased in-betweens.',
    bad: 'Dozens of keys of noise that never land on a clear pose.',
    measure: null,
    plan: null,
    kinds: ['attack', 'emote'],
    base: 0.6,
    words: /jitter|noisy|mushy|no clear pose|key ?poses/i
  },
  {
    id: 'follow-through',
    domain: 'anim',
    name: 'Follow-through and overlapping action',
    rule: 'Parts keep moving after the body stops and settle at different times.',
    roblox: 'Offset joint chains (shoulder > elbow > wrist, waist > neck) by a few frames and let the lead limb overshoot its end pose, then settle (a:overlap, Back / Elastic easing on the last key).',
    good: 'After the swing the arm overshoots 10-15 degrees and eases back while the head settles a frame later.',
    bad: 'Every joint stops on the same frame, so the move ends like a robot.',
    measure: 'overshoot and settle of the most active joints after the action',
    plan: 'what overshoots and settles after the action?',
    kinds: ['attack', 'locomotion', 'reaction', 'emote'],
    base: 1,
    words: /follow[- ]?through|overlap|robot|stops dead|abrupt|settle/i
  },
  {
    id: 'slow-in-out',
    domain: 'anim',
    name: 'Slow in and slow out',
    rule: 'Motion eases out of and into key poses; spacing is dense near the keys.',
    roblox: 'Use CubicV2 / Quad easing between keys; Linear only for constant motion (spins, loops). Ease the hold poses, snap the strike.',
    good: 'The arm accelerates out of the windup and decelerates into the extended pose.',
    bad: 'Linear keys everywhere: constant speed, mechanical start and stop.',
    measure: 'velocity at key poses versus the peak velocity between them',
    plan: null,
    kinds: 'all',
    base: 0.9,
    words: /linear|mechanical|robotic|ease|floaty/i
  },
  {
    id: 'arcs',
    domain: 'anim',
    name: 'Arcs',
    rule: 'Hands, head and feet travel on arcs, not straight lines.',
    roblox: 'Rotate joints (shoulder, hip) rather than sliding parts; add a small waist or Root rotation so the end effectors curve.',
    good: 'A slash sweeps the hand through a wide curve from above the shoulder to the opposite hip.',
    bad: 'The hand moves in a straight line between two keys like a piston.',
    measure: 'path curvature of the hands, feet and head',
    plan: 'which arc does the leading hand or foot trace?',
    kinds: ['attack', 'locomotion', 'emote'],
    base: 1,
    words: /arc|straight line|piston|linear path|curve/i
  },
  {
    id: 'secondary-action',
    domain: 'anim',
    name: 'Secondary action',
    rule: 'Smaller motions support the main one without stealing it.',
    roblox: 'Head turns, the free arm balancing, breathing on the torso; keep them smaller than the main action.',
    good: 'During a punch the free arm pulls back to the chest and the head tilts into the hit.',
    bad: 'The free arm hangs dead, or flails more than the punching arm.',
    measure: null,
    plan: null,
    kinds: ['idle', 'emote', 'locomotion'],
    base: 0.6,
    words: /dead arm|lifeless|secondary|free arm|stiff/i
  },
  {
    id: 'timing',
    domain: 'anim',
    name: 'Timing and spacing',
    rule: 'The number and spacing of frames sets weight and mood; vary them.',
    roblox: 'Mix fast and slow: snappy strikes (2-4 frames at 30 fps), longer anticipation and recovery, holds of a few frames on key poses.',
    good: 'Windup 6 frames, strike 3, hold 3, recovery 10.',
    bad: 'Every key evenly spaced 0.2 s apart, so the move has no rhythm.',
    measure: 'variety of the key spacing (even spacing scores low) and holds',
    plan: 'which beat is fast, which is slow, and where is the hold?',
    kinds: 'all',
    base: 1.1,
    words: /timing|slow|fast|too long|too short|rhythm|even|sluggish|snappy/i
  },
  {
    id: 'exaggeration',
    domain: 'anim',
    name: 'Exaggeration',
    rule: 'Push poses and timing past realism so they read.',
    roblox: 'Blocky rigs at gameplay distance need bigger extremes than real bodies: deeper crouches, wider swings, longer holds on the impact.',
    good: 'The overhead swing raises the arms well above the head before slamming down.',
    bad: 'Realistic small movements that look like nothing happened from the camera.',
    measure: 'peak silhouette spread against standing',
    plan: null,
    kinds: ['attack', 'emote', 'reaction'],
    base: 0.8,
    words: /exaggerat|subtle|too small|weak|push|bigger/i
  },
  {
    id: 'solid-posing',
    domain: 'anim',
    name: 'Solid drawing (solid posing)',
    rule: 'Poses have weight, balance and a clear line of action, with no twinning or tangents.',
    roblox: 'Keep the centre of mass over the feet, avoid both arms mirroring (twinning), keep joints inside natural limits and limbs out of the torso.',
    good: 'Asymmetric arms, weight on the front foot, a clear C or S curve through the spine.',
    bad: 'Both arms in the same pose, knees bending backwards, a hand inside the torso.',
    measure: 'joint limits, interpenetration and foot sliding (the automatic checks)',
    plan: null,
    kinds: 'all',
    base: 0.9,
    words: /twin|symmetr|clipping|through the body|broken|unbalanced|sliding|skate/i
  },
  {
    id: 'appeal',
    domain: 'anim',
    name: 'Appeal',
    rule: 'The move has personality and fits the character and the game.',
    roblox: 'Match the game\'s style (anime battleground, simulator, horror); a distinctive pose players recognise as this move.',
    good: 'A signature stance before the ultimate that players can spot from across the map.',
    bad: 'A generic move that could belong to any character.',
    measure: null,
    plan: null,
    kinds: ['emote', 'attack', 'idle'],
    base: 0.7,
    words: /appeal|boring|generic|personality|cool|style/i
  },
  {
    id: 'responsiveness',
    domain: 'anim',
    name: 'Responsiveness (startup)',
    rule: 'The action starts within a few frames of the input; anticipation must not feel like lag.',
    roblox: 'Combat moves: first motion within 2-3 frames, the release within 0.1-0.4 s for light attacks; longer only for charged moves.',
    good: 'The light attack moves on frame 1 and hits at 0.18 s.',
    bad: 'Half a second of nothing before the move starts.',
    measure: 'time to first motion and to the release',
    plan: 'how many frames until the release?',
    kinds: ['attack', 'locomotion'],
    base: 1,
    words: /lag|delay|unresponsive|slow to start|input|startup/i
  },
  {
    id: 'readability',
    domain: 'anim',
    name: 'Readability from the gameplay camera',
    rule: 'Every key pose reads as a silhouette from the gameplay camera at distance.',
    roblox: 'Limbs off the body, a clear line of action, the strike visible from behind and above; small R15 parts disappear at 30+ studs.',
    good: 'The strike pose spreads the arms wide so the outline reads at a glance.',
    bad: 'Arms in front of the torso: the silhouette stays a block.',
    measure: 'silhouette spread at the strongest pose versus standing',
    plan: 'what is the strongest silhouette, and on which beat?',
    kinds: 'all',
    base: 1.1,
    words: /read|silhouette|can'?t see|unclear|blob|messy/i
  },
  {
    id: 'weight-impact',
    domain: 'anim',
    name: 'Weight and impact',
    rule: 'Heavy actions commit and hits land: hold the impact frame, recoil, settle.',
    roblox: 'Hips lead, knees absorb, a short hold (hit-stop) or slowdown on contact, recoil after; Root dips on landings.',
    good: 'The slam drops the Root on impact, holds 3 frames, then recoils up.',
    bad: 'The hit passes through the impact pose without a pause or recoil, so it feels weightless.',
    measure: 'holds or deceleration at the impact and recoil after it',
    plan: 'how does the impact land (hold, recoil, hit-stop)?',
    kinds: ['attack', 'reaction', 'locomotion'],
    base: 1.1,
    words: /weight|weightless|floaty|heavy|impact|hit ?stop|recoil|no punch|land/i
  },
  {
    id: 'loopability',
    domain: 'anim',
    name: 'Loopability',
    rule: 'Looped clips end where they start, with continuous velocity across the seam.',
    roblox: 'Looped idles and runs: the last key equals the first, easing continues through the loop point, no pop when Roblox restarts the track.',
    good: 'A 2 s idle whose breath cycle ends exactly at its starting pose.',
    bad: 'The idle snaps back to the first pose each loop.',
    measure: 'pose and velocity difference between the end and the start of a looped clip',
    plan: 'how does the end flow back into the start?',
    kinds: ['idle', 'locomotion'],
    base: 1.2,
    words: /loop|pop|snap|seam|jump back/i
  }
]

export const VFX_PRINCIPLES: Principle[] = [
  {
    id: 'fx-shape',
    domain: 'vfx',
    name: 'Shape language',
    rule: 'One clear primary shape (arc, ring, burst, column, spiral) says what the effect is.',
    roblox: 'Build the primary shape with the right instance: a crescent slash texture or Beam curve, a ring texture on a flat emitter, a cone with SpreadAngle; textures that fit the job.',
    good: 'A slash reads as a crisp crescent with sparks thrown along its tangent.',
    bad: 'Round dots everywhere: a fuzzy ball no matter what the effect is.',
    measure: null,
    plan: 'what is the primary shape and its direction?',
    kinds: 'all',
    base: 1.1,
    words: /shape|blob|round|ball|crescent|ring|form/i
  },
  {
    id: 'fx-timing',
    domain: 'vfx',
    name: 'Timing (fast in, slow out; holds)',
    rule: 'Appear fast, hold the peak briefly, fade slowly.',
    roblox: 'Size swells in the first 10-20% of Lifetime then decays; bursts on the beat; a short hold (fx:wait 0.05-0.15) on the impact; long, soft dissipate.',
    good: 'The impact flash reaches full size in 2 frames, holds, and the smoke lingers 0.6 s.',
    bad: 'Particles grow linearly over their whole life and vanish, so nothing pops.',
    measure: 'size curves peak early (fast in, slow out) and beat lengths vary',
    plan: 'which beat is fastest, and where is the hold?',
    kinds: 'all',
    base: 1.1,
    words: /timing|slow|fast|too long|too short|sluggish|snappy|linger/i
  },
  {
    id: 'fx-contrast',
    domain: 'vfx',
    name: 'Value and contrast',
    rule: 'A bright, near-white core against darker, saturated edges.',
    roblox: 'Core: LightEmission 1 with a white-hot Color start; glow and edges: more saturated and transparent; smoke: LightEmission 0 so it darkens. Avoid every layer additive (blown out to white).',
    good: 'A white core fading to orange, then a dark red rim and grey smoke.',
    bad: 'Every layer at the same mid brightness: a flat, washed-out blob, or all additive white.',
    measure: 'core versus edge luminance in the simulated peak frame',
    plan: 'where is the bright core, and what is darker around it?',
    kinds: 'all',
    base: 1.1,
    words: /contrast|washed|flat|bright|dark|blown out|white|value/i
  },
  {
    id: 'fx-hue',
    domain: 'vfx',
    name: 'Colour and hue shifting',
    rule: 'One dominant hue per beat that shifts with heat and age (hot to cool, light to dark).',
    roblox: 'ColorSequence from a hot hue to a cooler or darker one over life (yellow > orange > red, white > cyan > blue); one accent hue at most.',
    good: 'Fire goes white-yellow to orange to deep red as it rises.',
    bad: 'A single flat colour, or five unrelated hues fighting each other.',
    measure: 'hue shift over particle life and the number of distinct hues',
    plan: null,
    kinds: 'all',
    base: 0.8,
    words: /colou?r|hue|palette|rainbow|saturat|tint/i
  },
  {
    id: 'fx-layers',
    domain: 'vfx',
    name: 'Layering (primary, secondary, tertiary)',
    rule: 'A primary element carries the idea; secondary and tertiary layers support it at smaller scale.',
    roblox: 'Primary: the core or main shape; secondary: glow, ring or shockwave; tertiary: sparks, embers, debris, smoke. 3-6 emitters per beat, each with one job.',
    good: 'Core burst + shockwave ring + spark spray + lingering smoke.',
    bad: 'One emitter doing everything, or eight layers of the same glow.',
    measure: 'layer count and coverage of the primary / secondary / tertiary roles',
    plan: 'primary, secondary and tertiary elements?',
    kinds: 'all',
    base: 1,
    words: /layer|depth|busy|simple|empty|cluttered/i
  },
  {
    id: 'fx-readability',
    domain: 'vfx',
    name: 'Silhouette and readability at gameplay distance',
    rule: 'The effect reads as its shape and gameplay meaning from the gameplay camera, at a glance.',
    roblox: 'Players see effects from 20-60 studs: size the primary element 4-12 studs, keep a focal point, do not hide the character or the hit area.',
    good: 'The danger zone of a slam is a clear ring on the floor visible from far away.',
    bad: 'Tiny sparks that disappear past 20 studs, or a cloud that hides who got hit.',
    measure: null,
    plan: null,
    kinds: 'all',
    base: 1.1,
    words: /read|see|tiny|small|hidden|silhouette|visible|noise|mush/i
  },
  {
    id: 'fx-anticipation',
    domain: 'vfx',
    name: 'Motion and anticipation',
    rule: 'Energy gathers before it releases; motion has a direction.',
    roblox: 'A charge beat (inward streaks, a swelling glow, rising light) 3-6x longer than the release; release with In easing (accelerating), particles moving along the action\'s direction.',
    good: 'Streaks pull into the hand for 0.5 s, then the blast leaves in 0.1 s.',
    bad: 'The explosion appears out of nowhere with particles spraying in every direction.',
    measure: 'a gathering beat before the release and its length versus the release',
    plan: 'what anticipates the release, and for how long?',
    kinds: ['projectile', 'charge', 'slash', 'burst'],
    base: 1,
    words: /anticipat|charge|build ?up|out of nowhere|direction|gather/i
  },
  {
    id: 'fx-breakup',
    domain: 'vfx',
    name: 'Noise and break-up',
    rule: 'Avoid uniform shapes: vary size, rotation, speed and timing so it feels organic.',
    roblox: 'Size and Transparency envelopes, Rotation / RotSpeed ranges, Lifetime and Speed ranges, flipbooks or noisy textures; never every particle identical.',
    good: 'Smoke puffs with random rotation, 30% size variance and a flipbook.',
    bad: 'Identical round particles at one size and rotation: a polka-dot pattern.',
    measure: 'size, rotation, lifetime and speed variance across emitters',
    plan: null,
    kinds: 'all',
    base: 0.8,
    words: /uniform|same|identical|repetit|pattern|boring|cg|clean|organic|noise/i
  },
  {
    id: 'fx-dissipation',
    domain: 'vfx',
    name: 'Dissipation',
    rule: 'Effects end softly: fade, shrink, slow down and darken instead of popping off.',
    roblox: 'Transparency reaching 1 at the end of life with a smooth curve, Size decaying, Drag slowing particles, lights falling to 0 before the effect is destroyed.',
    good: 'The flash fades over 0.15 s while smoke drifts up and thins out.',
    bad: 'Particles at full opacity disappear on their last frame.',
    measure: 'fade curves end at full transparency smoothly; lights and beams fade out',
    plan: 'how does it fade out?',
    kinds: 'all',
    base: 1,
    words: /fade|pop|disappear|abrupt|linger|end|dissipat|vanish/i
  },
  {
    id: 'fx-cohesion',
    domain: 'vfx',
    name: 'Cohesion with the animation',
    rule: 'The effect follows the body: it starts on the windup, peaks on the release frame and trails the motion.',
    roblox: 'Attach to the right body part (RightHand, Torso), put the release stage on the animation\'s release marker, trails follow the swing.',
    good: 'The slash trail starts with the swing and the impact burst lands on the release marker.',
    bad: 'The burst fires a few frames after the punch already landed, away from the fist.',
    measure: 'the effect\'s release stage lands on the release marker (Ability Composer)',
    plan: 'which body part and beat does the effect follow?',
    kinds: ['slash', 'projectile', 'burst'],
    base: 0.9,
    words: /sync|late|early|off|doesn'?t match|follow|attach/i
  },
  {
    id: 'fx-budget',
    domain: 'vfx',
    name: 'Performance budget',
    rule: 'Cheap enough to play several at once on mobile.',
    roblox: 'Keep under ~400 live particles at the peak, Rate below 400/s per emitter, avoid large opaque overlapping quads (overdraw); reuse rigs by tweening.',
    good: '250 particles at the peak with small sparks and a few large transparent glows.',
    bad: 'Two thousand particles and big opaque smoke quads stacked on each other.',
    measure: 'particle count, overdraw and emitter count (the performance guard)',
    plan: null,
    kinds: 'all',
    base: 0.9,
    words: /lag|fps|perf|heavy|mobile|too many|drop/i
  }
]

export const ALL_PRINCIPLES: Principle[] = [...ANIM_PRINCIPLES, ...VFX_PRINCIPLES]
const BY_ID = new Map(ALL_PRINCIPLES.map((p) => [p.id, p]))

export function principle(id: string): Principle | undefined {
  return BY_ID.get(id)
}

export function principlesFor(domain: PrincipleDomain): Principle[] {
  return domain === 'anim' ? ANIM_PRINCIPLES : VFX_PRINCIPLES
}

export function principleName(id: string): string {
  return BY_ID.get(id)?.name ?? id
}

// Short label for scorecards (terminal style).
export function principleLabel(id: string): string {
  return id.replace(/^fx-/, '')
}

// Ids the code checks can measure.
export function measurable(): string[] {
  return ALL_PRINCIPLES.filter((p) => p.measure).map((p) => p.id)
}
