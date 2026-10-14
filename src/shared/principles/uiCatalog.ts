// The UI motion principles (UI Motion Lab): a small set for buttons and panels, scored by the critic
// on captured preview frames and measured in code (uiChecks.ts) on the effect spec's simulated
// timeline. Sources: the 100 ms "instant" response limit (Nielsen, Response Times: The 3 Important
// Limits), Material motion guidance on restraint and consistency, and the platform reduced-motion
// setting (Roblox GuiService.ReducedMotionEnabled).

import type { Principle } from './types.ts'

export const UI_PRINCIPLES: Principle[] = [
  {
    id: 'ui-responsiveness',
    domain: 'ui',
    name: 'Responsiveness',
    rule: 'Visible feedback starts within 100 ms of hover or press.',
    roblox: 'Drive hover / press with a RenderStepped spring (or a short tween) that moves on the first frame; avoid delays and long ease-ins on input.',
    good: 'Press scales to 0.94 in about 40 ms; the hover lift is half done within 80 ms.',
    bad: 'A 0.3 s ease-in tween on press, so the button seems to ignore the click.',
    measure: 'time to 50% of the hover and press response on the simulated timeline',
    plan: 'how fast does hover / press respond (ms), and with what?',
    kinds: 'all',
    base: 1.3,
    words: /laggy|slow|delay|unresponsive|sluggish|input lag|late/i
  },
  {
    id: 'ui-anticipation',
    domain: 'ui',
    name: 'Anticipation',
    rule: 'A small press-in before the release pop makes the click read as cause and effect.',
    roblox: 'Squash or scale down while the button is held (UIScale below 1), then pop past 1 on release.',
    good: 'Held: 0.94 scale and a slight squash; release: a quick pop to 1.06 that settles.',
    bad: 'The pop fires on press with no press-in, or nothing at all happens until release.',
    measure: 'press-in depth before the release (scale below rest while held)',
    plan: 'what happens while held, before the release?',
    kinds: 'all',
    base: 1,
    words: /anticipat|press[- ]?in|no feedback|flat click|dead/i
  },
  {
    id: 'ui-overshoot',
    domain: 'ui',
    name: 'Overshoot restraint',
    rule: 'Springs may overshoot a little; UI should settle fast and not wobble.',
    roblox: 'Damping 0.5..0.8 for playful buttons, 0.8..1 for menus; keep scale overshoot under ~15% of the move and settle within ~0.4 s.',
    good: 'A pop that overshoots once by 8% and settles in 0.3 s.',
    bad: 'A wobbly 0.3-damped spring that rings for a second after every hover.',
    measure: 'overshoot after hover / release and the spring damping ratios',
    plan: 'how much overshoot, and how fast does it settle?',
    kinds: 'all',
    base: 1.1,
    words: /wobbl|jelly|bouncy|too much bounce|overshoot|ring|jiggle/i
  },
  {
    id: 'ui-consistency',
    domain: 'ui',
    name: 'Consistency',
    rule: 'Related motions share one spring family and timing so the UI feels like one system.',
    roblox: 'Reuse the same frequency / damping for hover, press and pop (or a deliberate ratio); keep durations of appear / disappear related.',
    good: 'Hover, press and pop all use frequency 5, damping 0.7.',
    bad: 'Hover at 2 Hz underdamped, press at 9 Hz critically damped, pop at 3 Hz: three different personalities.',
    measure: 'spread of the springs’ frequencies and dampings across effects',
    plan: null,
    kinds: 'all',
    base: 0.8,
    words: /inconsistent|mismatch|random|different feel|doesn'?t match/i
  },
  {
    id: 'ui-readability',
    domain: 'ui',
    name: 'Readability',
    rule: 'The label stays legible during motion: modest scale and tilt, shine and glow never wash out the text.',
    roblox: 'Keep UIScale within ~0.85..1.15, tilt under ~8°, float amplitude a few pixels, shine intensity moderate and glow below the text contrast.',
    good: 'A 6% hover lift with a soft shine passing behind readable text.',
    bad: 'A 30% scale-up, 15° tilt and a white shine that hides the label.',
    measure: 'scale range, tilt angle, float amplitude and shine / glow strength',
    plan: 'how does the label stay readable at the extremes?',
    kinds: 'all',
    base: 1,
    words: /can'?t read|unreadable|blurry|too big|washed out|distract|noisy/i
  },
  {
    id: 'ui-reduced-motion',
    domain: 'ui',
    name: 'Reduced motion',
    rule: 'Respect the player’s reduced-motion setting: keep feedback, drop decorative movement.',
    roblox: 'Read GuiService.ReducedMotionEnabled; keep press feedback and fades, turn off idle float, tilt, shine sweeps and big pops.',
    good: 'With reduced motion on, only a short fade and a gentle press scale remain.',
    bad: 'Idle float, tilt and a looping shine keep running for players who turned motion off.',
    measure: 'whether the spec respects the setting and how much loops / decorative motion it has',
    plan: null,
    kinds: 'all',
    base: 0.9,
    words: /motion sick|accessib|reduced motion|too much motion|nause/i
  }
]
