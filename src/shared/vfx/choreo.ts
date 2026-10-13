// How to choreograph multi-stage VFX, for the assistant (vfx_compose, vfx_kit, the memory skill) and
// the critic, plus a deterministic first script for a request when no model writes one.

import { kitDoc } from './kit.ts'
import { paletteFor } from './draft.ts'
import { fromHex } from './sequence.ts'

export const TIMELINE_API = `Timeline scripts are Luau modules: return function(fx) ... end. The same code runs in Forge (recorded by Lune) and in game (ForgeFX runtime).
fx:spawn(kind, opts) -> handle     make a kit rig and bring it in now; handle.Glow etc. name its layers ("<Name>Glow")
fx:emit(h, n)  fx:enable(h)  fx:disable(h)      a rig handle applies to every emitter / light / beam under it
fx:tween(h, seconds, goals, style?, direction?)  TweenService; style = Enum.EasingStyle name (Quad default), direction In / Out (default) / InOut
   goals: Position = Vector3 (studs from the effect root; -Z forward, +Y up), CFrame, Size (parts), Rate, Brightness, Range,
          LightEmission, Width0 / Width1 (beams), Color = Color3 (lights; emitters / beams / trails lerp their ColorSequence),
          SizeScale (scales a rig and everything in it; 1 = authored), Fade (0 visible .. 1 gone; fades a rig and everything in it)
fx:set(h, goals)   instant      fx:wait(s)  advance the clock     fx:at(t, fn) / fx:after(dt, fn)  run fn at another time
fx:stage(label)    mark a beat (anticipation, charge, release, impact, dissipate...)     fx:duration(s)  optional length
fx:forward(d) / fx:right(d) / fx:up(d) -> Vector3     fx:anchor(Vector3)  where the preview puts the root (from the dummy's feet)
Kit (opts: name, at, parent, color, color2, size, count, rate, speed, duration, lifetime, width, to, arc, radius, tilt, spread, facing, brightness, texture):`

export const CHOREOGRAPHY_GUIDE = `## Choreographing a multi-stage effect
Five beats, each a fx:stage so the timeline and the critic can follow them:
1. Anticipation (0.2-0.8 s): small, quiet, readable. Charge streaks pulling inward, a glow swelling (Rate / SizeScale up with Quad In or Sine InOut), lights rising. It promises what comes; never skip it.
2. Charge / build (0.3-1 s, optional for fast moves): the energy concentrates. Converge (Position tweens with Quad In: accelerate into the merge), pulse SizeScale 1 -> 1.3 with Sine InOut.
3. Release (0.05-0.2 s): the fastest beat. Flash (flash kit) + light spike + shockwave on the exact frame; projectiles leave with Quad In / Quart In (accelerating), slashes sweep in 0.12-0.2 s with Quart Out.
4. Impact (0.1-0.4 s): the biggest silhouette. Impact burst, shockwave 1.5-3x the projectile size, debris and dust on the ground (y = -3 under a default root), sparks with spread < 90 when they should spray one way.
5. Dissipate (0.3-0.8 s): Fade rigs to 1 with Quad Out, smoke lingers with LightEmission 0, lights fall to 0. Nothing pops off: fade or let lifetimes run out.
Timing and easing rules of thumb:
- Contrast: slow in, fast out. Anticipation 3-6x longer than the release. Hold 0.05-0.15 s on the impact frame (a short fx:wait before the next beat).
- Out easing for things that appear (Back Out for a pop, Quad / Quart Out to settle); In easing for things that launch or collapse (Quad / Quart In); Sine InOut for pulses and breathing.
- Overlap: start the next beat's first layer slightly before the previous one ends (fx:after / fx:at) so it reads as one motion.
- Value: a white-hot core, a saturated mid colour, a darker falloff; keep smoke near LightEmission 0 so it darkens; one dominant hue per beat (two only for a deliberate merge such as blue + red -> purple).
- Scale: projectiles 1-2.5 studs, impacts 6-12, shockwaves up to 18-20; keep under ~400 live particles at the peak (reuse rigs by tweening instead of spawning a new one per beat).
- Name every spawn (name = "Blue") so goals read clearly and the critic can refer to them.`

export function kitReference(): string {
  return `${TIMELINE_API}\n${kitDoc()}`
}

// ------------------------------------------------------------------ deterministic first script

type Archetype = 'projectile' | 'slash' | 'slam' | 'breath' | 'orb' | 'explosion' | 'teleport' | 'generic'

export function archetype(prompt: string): Archetype {
  const p = prompt.toLowerCase()
  if (/teleport|blink|warp/.test(p)) return 'teleport'
  if (/breath|flamethrower|stream|sweep|spray/.test(p)) return 'breath'
  if (/slash|sword|katana|blade|cut|swipe/.test(p)) return 'slash'
  if (/slam|smash|stomp|quake|ground|punch the ground/.test(p)) return 'slam'
  if (/beam|laser|kamehameha|hollow|blast|shoot|fire(s|d)? forward|projectile|fireball|bolt|shot/.test(p)) return 'projectile'
  if (/rasengan|spirit bomb|orb|ball|sphere|charge/.test(p)) return 'orb'
  if (/explo|nuke|boom|detonat/.test(p)) return 'explosion'
  return 'generic'
}

function rgb(hexColor: string): string {
  const c = fromHex(hexColor).map((v) => Math.round(v * 255))
  return `Color3.fromRGB(${c.join(', ')})`
}

// A complete, runnable timeline script for a request (palette and archetype from its words).
export function draftScript(prompt: string): string {
  const pal = paletteFor(prompt.toLowerCase())
  const MAIN = rgb(pal.mid)
  const HOT = rgb(pal.hot)
  const SMOKE = rgb(pal.smoke)
  const head = `-- ${prompt.replace(/\s+/g, ' ').trim().slice(0, 100)} (first draft by RBX Forge: tune timings and colours, then refine)\nreturn function(fx)\n\tlocal MAIN = ${MAIN}\n\tlocal HOT = ${HOT}\n\tlocal SMOKE = ${SMOKE}\n`
  const body: Record<Archetype, string> = {
    projectile: `\tfx:anchor(Vector3.new(0, 3.2, -2.5))
	fx:stage("anticipation")
	local core = fx:spawn("orb", { name = "Core", color = MAIN, size = 1.6 })
	fx:spawn("charge", { name = "Gather", parent = core, color = MAIN, size = 3, rate = 60 })
	fx:tween(core, 0.6, { SizeScale = 1.3 }, "Sine", "InOut")
	fx:wait(0.6)
	fx:stage("release")
	fx:disable("Gather")
	fx:spawn("flash", { name = "Launch", color = HOT, size = 6 })
	fx:spawn("beam", { name = "Wake", color = MAIN, width = 1.8, to = core })
	fx:spawn("trail", { name = "CoreTrail", parent = core, color = MAIN, width = 1.8, lifetime = 0.35 })
	fx:tween(core, 0.4, { Position = fx:forward(26) }, "Quad", "In")
	fx:wait(0.4)
	fx:stage("impact")
	fx:spawn("impact", { name = "Hit", color = HOT, at = fx:forward(26), size = 8 })
	fx:spawn("shockwave", { name = "Wave", color = MAIN, at = fx:forward(26), size = 12 })
	fx:spawn("debris", { name = "Rubble", at = Vector3.new(0, -3, -26), count = 24 })
	fx:tween(core, 0.15, { Fade = 1 })
	fx:wait(0.2)
	fx:stage("dissipate")
	fx:tween("Wake", 0.4, { Fade = 1 })
	fx:spawn("smoke", { name = "Haze", at = fx:forward(26), color2 = SMOKE, count = 8 })
	fx:wait(0.5)
`,
    slash: `\tfx:anchor(Vector3.new(0, 3, -2))
	fx:stage("anticipation")
	fx:spawn("charge", { name = "Gather", color = MAIN, size = 2.4, at = Vector3.new(1.8, 0.2, 1), rate = 60 })
	fx:spawn("glow", { name = "Edge", color = MAIN, size = 2, at = Vector3.new(1.8, 0.2, 1) })
	fx:wait(0.5)
	fx:stage("release")
	fx:disable("Gather")
	fx:disable("Edge")
	fx:spawn("slash", { name = "Cut", color = MAIN, radius = 5, arc = 160, tilt = -15, duration = 0.16 })
	fx:wait(0.12)
	fx:stage("impact")
	fx:spawn("impact", { name = "Hit", color = HOT, at = fx:forward(3.5), size = 6 })
	fx:spawn("shockwave", { name = "Wave", color = MAIN, at = fx:forward(3.5), size = 8, duration = 0.3 })
	fx:wait(0.3)
	fx:stage("dissipate")
	fx:wait(0.4)
`,
    slam: `\tfx:anchor(Vector3.new(0, 3, -3))
	fx:stage("anticipation")
	local fist = fx:spawn("orb", { name = "Fist", color = MAIN, size = 1.4, at = Vector3.new(0, 3.5, 0) })
	fx:spawn("charge", { name = "Gather", parent = fist, color = MAIN, size = 3 })
	fx:wait(0.5)
	fx:stage("release")
	fx:disable("Gather")
	fx:tween(fist, 0.15, { Position = Vector3.new(0, -2.6, 0) }, "Quad", "In")
	fx:wait(0.15)
	fx:stage("impact")
	local ground = Vector3.new(0, -2.9, 0)
	fx:tween(fist, 0.08, { Fade = 1 })
	fx:spawn("flash", { name = "Flash", color = HOT, size = 9, at = ground })
	fx:spawn("shockwave", { name = "Wave", color = MAIN, size = 16, at = ground })
	fx:spawn("dust", { name = "Ring", at = ground, count = 45 })
	fx:spawn("debris", { name = "Rubble", at = ground, count = 30 })
	fx:wait(0.3)
	fx:stage("dissipate")
	fx:spawn("smoke", { name = "Haze", at = ground, color2 = SMOKE, count = 8 })
	fx:wait(0.5)
`,
    breath: `\tfx:anchor(Vector3.new(0, 4.4, -1))
	fx:stage("anticipation")
	local mouth = fx:spawn("glow", { name = "Mouth", color = MAIN, size = 1.5 })
	fx:spawn("charge", { name = "Gather", color = MAIN, size = 2, rate = 50 })
	fx:tween(mouth.Glow, 0.6, { Rate = 25 }, "Quad", "In")
	fx:wait(0.6)
	fx:stage("release")
	fx:disable("Gather")
	local stream = fx:spawn("sparks", { name = "Stream", color = HOT, rate = 220, speed = 38, spread = 14, facing = "Front" })
	fx:spawn("smoke", { name = "Plume", parent = stream, color = MAIN, rate = 40, speed = 24, spread = 18, size = 1.4, facing = "Front", lifetime = 0.7 })
	fx:set(stream, { CFrame = CFrame.Angles(0, math.rad(40), 0) })
	fx:tween(stream, 1.1, { CFrame = CFrame.Angles(0, math.rad(-40), 0) }, "Sine", "InOut")
	fx:wait(1.1)
	fx:stage("dissipate")
	fx:disable(stream)
	fx:tween(mouth, 0.3, { Fade = 1 })
	fx:wait(0.6)
`,
    orb: `\tfx:anchor(Vector3.new(0, 3.2, -2.5))
	fx:stage("anticipation")
	fx:spawn("charge", { name = "Gather", color = MAIN, size = 3.5, rate = 70 })
	fx:wait(0.4)
	fx:stage("charge")
	local orb = fx:spawn("orb", { name = "Orb", color = MAIN, size = 1.4 })
	fx:spawn("glow", { name = "Swirl", parent = orb, color = MAIN, size = 3.5 })
	fx:tween(orb, 0.7, { SizeScale = 1.6 }, "Sine", "InOut")
	fx:wait(0.7)
	fx:stage("release")
	fx:disable("Gather")
	fx:spawn("trail", { name = "OrbTrail", parent = orb, color = MAIN, width = 1.6 })
	fx:tween(orb, 0.3, { Position = fx:forward(14) }, "Quad", "In")
	fx:wait(0.3)
	fx:stage("impact")
	fx:spawn("impact", { name = "Hit", color = HOT, at = fx:forward(14), size = 9 })
	fx:spawn("shockwave", { name = "Wave", color = MAIN, at = fx:forward(14), size = 14 })
	fx:tween(orb, 0.12, { Fade = 1, SizeScale = 2.4 })
	fx:wait(0.3)
	fx:stage("dissipate")
	fx:wait(0.5)
`,
    explosion: `\tfx:anchor(Vector3.new(0, 3, -6))
	fx:stage("anticipation")
	local core = fx:spawn("orb", { name = "Core", color = HOT, size = 0.8 })
	fx:spawn("charge", { name = "Gather", parent = core, color = MAIN, size = 4, rate = 80 })
	fx:tween(core, 0.5, { SizeScale = 2 }, "Quad", "In")
	fx:wait(0.5)
	fx:stage("release")
	fx:disable("Gather")
	fx:tween(core, 0.08, { Fade = 1, SizeScale = 4 })
	fx:spawn("flash", { name = "Flash", color = HOT, size = 14, brightness = 20 })
	fx:spawn("shockwave", { name = "Wave", color = MAIN, size = 20, duration = 0.5 })
	fx:spawn("sparks", { name = "Spray", color = HOT, count = 60, speed = 40 })
	fx:wait(0.1)
	fx:stage("impact")
	fx:spawn("debris", { name = "Rubble", at = Vector3.new(0, -2.9, 0), count = 40, speed = 30 })
	fx:spawn("dust", { name = "Ring", at = Vector3.new(0, -2.9, 0), size = 3, count = 50 })
	fx:wait(0.3)
	fx:stage("dissipate")
	fx:spawn("smoke", { name = "Cloud", color2 = SMOKE, count = 16, size = 3, speed = 6 })
	fx:wait(0.8)
`,
    teleport: `\tfx:anchor(Vector3.new(0, 3, 0))
	fx:stage("anticipation")
	fx:spawn("charge", { name = "Gather", color = MAIN, size = 3, rate = 60 })
	fx:wait(0.35)
	fx:stage("vanish")
	fx:disable("Gather")
	fx:spawn("flash", { name = "Out", color = HOT, size = 6 })
	fx:spawn("smoke", { name = "Puff", color2 = SMOKE, count = 12, size = 1.6 })
	local streak = fx:spawn("orb", { name = "Streak", color = MAIN, size = 0.6 })
	fx:spawn("trail", { name = "StreakTrail", parent = streak, color = MAIN, width = 2.4, lifetime = 0.25 })
	fx:tween(streak, 0.12, { Position = fx:forward(10) }, "Quart", "In")
	fx:wait(0.12)
	fx:stage("strike")
	fx:tween(streak, 0.05, { Fade = 1 })
	fx:spawn("flash", { name = "In", color = HOT, size = 6, at = fx:forward(10) })
	fx:spawn("slash", { name = "Cut", color = MAIN, at = fx:forward(10), radius = 4.5, arc = 160, tilt = 20, duration = 0.14 })
	fx:wait(0.15)
	fx:stage("impact")
	fx:spawn("impact", { name = "Hit", color = HOT, at = fx:forward(13), size = 6 })
	fx:wait(0.5)
`,
    generic: `\tfx:anchor(Vector3.new(0, 3.2, -3))
	fx:stage("anticipation")
	local core = fx:spawn("orb", { name = "Core", color = MAIN, size = 1.5 })
	fx:spawn("charge", { name = "Gather", parent = core, color = MAIN, size = 3 })
	fx:wait(0.5)
	fx:stage("release")
	fx:disable("Gather")
	fx:tween(core, 0.1, { Fade = 1, SizeScale = 2.5 })
	fx:spawn("flash", { name = "Flash", color = HOT, size = 9 })
	fx:spawn("shockwave", { name = "Wave", color = MAIN, size = 14 })
	fx:spawn("sparks", { name = "Spray", color = HOT, count = 40 })
	fx:wait(0.3)
	fx:stage("dissipate")
	fx:spawn("smoke", { name = "Haze", color2 = SMOKE, count = 10, size = 2 })
	fx:wait(0.5)
`
  }
  return `${head}${body[archetype(prompt)]}end\n`
}
