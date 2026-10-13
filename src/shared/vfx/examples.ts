// Built-in scripted examples for the VFX Lab: multi-stage effects written as timeline scripts with the
// kit (kit.ts) and the ForgeFX API. They double as few-shot examples for the assistant (vfx_compose)
// and as the proof that the approach generalises (an anime beam merge, a sword combo, a ground slam).
//
// Each example's recorded ops (what Lune's recorder returned for the script) are kept in
// examples.recorded.ts so the examples load without Lune; test/vfx-sequence.test.ts checks that the
// scripts still record to exactly those ops when Lune is installed
// (regenerate: node --experimental-strip-types build/vfx-examples.ts).

export interface VfxExample {
  key: string
  name: string
  description: string
  tags: string[]
  script: string
}

export const HOLLOW_PURPLE = `-- Hollow Purple: blue (attraction) forms on the left, red (repulsion) on the right, they are pulled
-- together and collide into an imaginary purple mass that charges, then fires forward, tearing up
-- the ground along its path, and fades.
return function(fx)
	local BLUE = Color3.fromRGB(70, 150, 255)
	local RED = Color3.fromRGB(255, 55, 70)
	local PURPLE = Color3.fromRGB(176, 92, 255)
	fx:anchor(Vector3.new(0, 3.2, -3))

	fx:stage("blue")
	local blue = fx:spawn("orb", { name = "Blue", color = BLUE, size = 1.3, at = Vector3.new(-3.2, 0.4, 0) })
	fx:spawn("charge", { name = "BlueGather", parent = blue, color = BLUE, size = 2.6, rate = 45 })
	fx:wait(0.55)

	fx:stage("red")
	local red = fx:spawn("orb", { name = "Red", color = RED, size = 1.3, at = Vector3.new(3.2, 0.4, 0) })
	fx:spawn("charge", { name = "RedGather", parent = red, color = RED, size = 2.6, rate = 45 })
	fx:wait(0.55)

	fx:stage("converge")
	fx:disable("BlueGather")
	fx:disable("RedGather")
	fx:spawn("trail", { name = "BlueTrail", parent = blue, color = BLUE, width = 0.9, lifetime = 0.25 })
	fx:spawn("trail", { name = "RedTrail", parent = red, color = RED, width = 0.9, lifetime = 0.25 })
	fx:tween(blue, 0.6, { Position = Vector3.new(0, 0, 0) }, "Quad", "In")
	fx:tween(red, 0.6, { Position = Vector3.new(0, 0, 0) }, "Quad", "In")
	fx:tween(blue.Light, 0.6, { Brightness = 6 })
	fx:tween(red.Light, 0.6, { Brightness = 6 })
	fx:wait(0.6)

	fx:stage("merge")
	fx:tween(blue, 0.1, { Fade = 1, SizeScale = 0.4 })
	fx:tween(red, 0.1, { Fade = 1, SizeScale = 0.4 })
	fx:spawn("flash", { name = "MergeFlash", color = PURPLE, size = 11, brightness = 20, duration = 0.5 })
	fx:spawn("shockwave", { name = "MergeWave", color = PURPLE, size = 17, duration = 0.5 })
	fx:spawn("sparks", { name = "MergeSparks", color = Color3.fromRGB(220, 180, 255), count = 40, speed = 28 })
	local purple = fx:spawn("orb", { name = "Purple", color = PURPLE, size = 2.3, duration = 0.25 })
	fx:wait(0.25)

	fx:stage("charge")
	fx:spawn("charge", { name = "PurpleGather", parent = purple, color = PURPLE, size = 5, rate = 80 })
	fx:spawn("glow", { name = "PurpleHalo", parent = purple, color = PURPLE, size = 6, rate = 8 })
	fx:tween(purple, 0.5, { SizeScale = 1.3 }, "Sine", "InOut")
	fx:tween(purple.Light, 0.5, { Brightness = 9, Range = 18 })
	fx:wait(0.5)

	fx:stage("fire")
	fx:disable("PurpleGather")
	fx:spawn("flash", { name = "LaunchFlash", color = PURPLE, size = 7, brightness = 12, duration = 0.3 })
	fx:spawn("beam", { name = "Wake", color = PURPLE, width = 2.6, to = purple })
	fx:spawn("trail", { name = "PurpleTrail", parent = purple, color = PURPLE, width = 2.6, lifetime = 0.45 })
	fx:tween(purple, 0.5, { Position = fx:forward(30) }, "Quad", "In")
	-- the mass wrecks the ground under its path
	for i = 1, 4 do
		local dist = i * 7
		fx:at(fx:now() + 0.5 * math.sqrt(dist / 30), function()
			local ground = Vector3.new(0, -3.1, -dist)
			fx:spawn("debris", { name = "Rubble" .. i, at = ground, count = 18, speed = 20, size = 1.2 })
			fx:spawn("dust", { name = "Dust" .. i, at = ground, size = 1.5, count = 22, speed = 10 })
		end)
	end
	fx:wait(0.5)

	fx:stage("dissipate")
	fx:tween("Wake", 0.4, { Fade = 1 })
	fx:tween(purple, 0.35, { Fade = 1, SizeScale = 1.8 }, "Quad", "Out")
	fx:spawn("shockwave", { name = "EndWave", at = fx:forward(30), color = PURPLE, size = 12, duration = 0.4 })
	fx:wait(0.4)
	fx:disable(purple)
end
`

export const CHARGE_SLASH = `-- Charge-and-slash: energy gathers on the blade while an aura flares, then two fast crescent slashes
-- (the second crossing the first) and a hit burst in front.
return function(fx)
	local EDGE = Color3.fromRGB(110, 225, 255)
	fx:anchor(Vector3.new(0, 3, -2))

	fx:stage("anticipation")
	fx:spawn("aura", { name = "Aura", color = EDGE, at = Vector3.new(0, -0.6, 2), rate = 20 })
	local blade = fx:spawn("glow", { name = "Blade", color = EDGE, size = 2.2, at = Vector3.new(1.9, 0.2, 1.2) })
	fx:spawn("charge", { name = "Gather", color = EDGE, size = 2.4, at = Vector3.new(1.9, 0.2, 1.2), rate = 70 })
	fx:tween(blade.Glow, 0.6, { Rate = 22 }, "Quad", "In")
	fx:wait(0.65)

	fx:stage("slash")
	fx:disable("Gather")
	fx:disable(blade)
	fx:spawn("flash", { name = "Pop", color = EDGE, size = 5, brightness = 10, at = Vector3.new(1.2, 0.2, 0.6) })
	fx:spawn("slash", { name = "Cut1", color = EDGE, radius = 5, width = 1.8, arc = 160, tilt = -18, duration = 0.15 })
	fx:wait(0.14)
	fx:spawn("slash", { name = "Cut2", color = Color3.fromRGB(190, 245, 255), radius = 4.6, width = 1.5, arc = 150, tilt = 200, duration = 0.14 })
	fx:wait(0.1)

	fx:stage("impact")
	fx:spawn("impact", { name = "Hit", color = EDGE, at = fx:forward(3.5), size = 6, count = 34 })
	fx:spawn("shockwave", { name = "HitWave", color = EDGE, at = fx:forward(3.5), size = 8, duration = 0.3 })
	fx:wait(0.25)

	fx:stage("dissipate")
	fx:tween("Aura", 0.4, { Fade = 1 })
	fx:wait(0.4)
	fx:disable("Aura")
end
`

export const GROUND_SLAM = `-- Ground slam: a fist of energy winds up overhead, drops, and hits the floor with a flash, a
-- shockwave, a ring of dust and rubble, then an aftershock.
return function(fx)
	local HEAT = Color3.fromRGB(255, 150, 60)
	fx:anchor(Vector3.new(0, 3, -3.5))

	fx:stage("wind-up")
	local fist = fx:spawn("orb", { name = "Fist", color = HEAT, size = 1.4, at = Vector3.new(0, 3.5, 0) })
	fx:spawn("charge", { name = "Gather", parent = fist, color = HEAT, size = 3, rate = 50 })
	fx:tween(fist, 0.5, { Position = Vector3.new(0, 4.5, 0.6), SizeScale = 1.25 }, "Sine", "Out")
	fx:wait(0.5)

	fx:stage("drop")
	fx:disable("Gather")
	fx:spawn("trail", { name = "FistTrail", parent = fist, color = HEAT, width = 1.4, lifetime = 0.2 })
	fx:tween(fist, 0.16, { Position = Vector3.new(0, -2.6, 0) }, "Quad", "In")
	fx:wait(0.16)

	fx:stage("impact")
	local ground = Vector3.new(0, -2.9, 0)
	fx:tween(fist, 0.08, { Fade = 1, SizeScale = 2 })
	fx:spawn("flash", { name = "Flash", color = HEAT, size = 9, brightness = 16, at = ground + Vector3.new(0, 0.5, 0) })
	fx:spawn("shockwave", { name = "Wave", color = Color3.fromRGB(255, 200, 140), size = 18, duration = 0.45, at = ground })
	fx:spawn("dust", { name = "Ring", at = ground, size = 2, count = 50, speed = 18 })
	fx:spawn("debris", { name = "Rubble", at = ground, count = 36, speed = 26, size = 1.3 })
	fx:spawn("sparks", { name = "Embers", color = HEAT, count = 30, speed = 22, spread = 70, at = ground })
	fx:wait(0.22)

	fx:stage("aftershock")
	fx:spawn("dust", { name = "Ring2", at = ground, size = 3.5, count = 30, speed = 9 })
	fx:spawn("smoke", { name = "Haze", at = ground + Vector3.new(0, 1, 0), count = 10, size = 2.4, speed = 2 })
	fx:wait(0.6)
	fx:stage("dissipate")
end
`

export const VFX_EXAMPLES: VfxExample[] = [
  { key: 'hollow-purple', name: 'HollowPurple', description: 'Gojo-style Hollow Purple: blue and red orbs form, converge and merge in a flash and shockwave, the purple mass charges and fires forward with a beam, trail and rubble, then fades.', tags: ['magic', 'projectile', 'beam', 'charge', 'purple'], script: HOLLOW_PURPLE },
  { key: 'charge-slash', name: 'ChargeSlash', description: 'Charge-and-slash: aura and gathering streaks on the blade, two crossing crescent slashes, a hit burst and shockwave.', tags: ['slash', 'charge', 'impact', 'cyan'], script: CHARGE_SLASH },
  { key: 'ground-slam', name: 'GroundSlam', description: 'Ground slam: an energy fist winds up, drops and hits the floor with a flash, shockwave, dust ring, rubble and an aftershock.', tags: ['impact', 'shockwave', 'smoke', 'orange'], script: GROUND_SLAM }
]

export function findExample(key: string): VfxExample | null {
  const k = String(key ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return VFX_EXAMPLES.find((e) => e.key === k || e.name.toLowerCase() === k.replace(/-/g, '')) ?? null
}
