--!nocheck
-- Creature: a plated shark. Curved spine of ellipse rings (dark top, light belly by sin(angle)),
-- dark groove rings, raised panels, a chunky faceted dorsal fin and tail, jaws with diamond teeth
-- half-buried in the lips, segmented pectoral fins, and a Motor6D rig with an Animator.
local Kit = require(script.Parent.BlockyKit)

return function(model: Model, ctx)
	local kit = Kit.new(model, ctx.origin, 11)
	local PAL = {
		top = Color3.fromRGB(46, 84, 128),
		flank = Color3.fromRGB(78, 126, 178),
		belly = Color3.fromRGB(226, 233, 240),
		groove = Color3.fromRGB(20, 36, 58),
		panel = Color3.fromRGB(64, 108, 158),
		bellyEdge = Color3.fromRGB(246, 248, 250),
		lip = Color3.fromRGB(36, 64, 98),
		inner = Color3.fromRGB(150, 40, 52),
		innerDark = Color3.fromRGB(70, 16, 26),
		tooth = Color3.fromRGB(245, 242, 230),
		eye = Color3.fromRGB(14, 16, 20),
	}
	-- Dark top, mid flank, light belly: the plate colour follows sin(angle) around each ring.
	local function colorAt(s: number): Color3
		if s > 0.4 then
			return kit:vary(PAL.top, 0.03)
		elseif s > -0.2 then
			return kit:vary(PAL.flank, 0.03)
		end
		return kit:vary(PAL.belly, 0.02)
	end

	-- Rig: an anchored invisible root, a torso bone and a tail bone (Motor6D joints).
	local LEN, Y = 15, 4
	local function invisible(p: BasePart)
		p.Transparency = 1
		return p
	end
	local root = invisible(kit:part("Root", Vector3.new(2, 2, 2), CFrame.new(0, Y, 0), PAL.groove))
	root.Anchored = true
	model.PrimaryPart = root
	local torso = invisible(kit:part("Torso", Vector3.new(2, 2, 6), CFrame.new(0, Y, -2), PAL.groove))
	kit:motor("RootJoint", root, torso, CFrame.new(0, Y, 0))
	local tail = invisible(kit:part("TailBone", Vector3.new(1.5, 1.5, 5), CFrame.new(0, Y + 0.4, 4.5), PAL.groove))
	kit:motor("Tail", torso, tail, CFrame.new(0, Y + 0.2, 2.2))

	-- Spine: head at t = 0 (-Z), tail at t = 1, a gentle S curve; fat in front, thin at the tail.
	local function pos(t: number): Vector3
		return Vector3.new(0, Y + math.sin(t * math.pi * 1.2) * 0.6 - t * 0.2, -LEN / 2 + t * LEN)
	end
	local function w(t: number): number
		return Kit.lerp(4.6, 0.9, t ^ 1.3) * (1 - 0.35 * math.max(0, 0.18 - t) / 0.18)
	end
	local function h(t: number): number
		return Kit.lerp(4.0, 1.1, t ^ 1.2) * (1 - 0.3 * math.max(0, 0.18 - t) / 0.18)
	end
	local frames = kit:spine(pos, w, h, 15)
	kit:body(frames, function(i)
		return if i < 9 then torso else tail
	end, colorAt, { groove = true, panels = true, bellyEdge = true, palette = PAL, spacing = 1.05, density = 2.6 })

	-- Jaws: half-rings forward of the head frame, teeth as 45-degree diamonds in the lip strip.
	local head = frames[0]
	local jawFrame = head.cf * CFrame.new(0, -0.1, 0)
	local jawSpec = {
		length = 2.6,
		rings = 4,
		w0 = head.w / 2 * 0.95,
		w1 = 0.9,
		h0 = head.h / 2 * 0.8,
		h1 = 0.55,
		teeth0 = 0.55,
		teeth1 = 0.35,
		lip = PAL.lip,
		inner = PAL.inner,
		innerDark = PAL.innerDark,
		tooth = PAL.tooth,
		colorAt = colorAt,
		groove = true,
		palette = PAL,
	}
	kit:jaw(torso, jawFrame * CFrame.new(0, 0.12, 0), true, jawSpec)
	local jaw = invisible(kit:part("JawBone", Vector3.new(1.5, 0.6, 2.5), jawFrame * CFrame.new(0, -0.6, -1.6), PAL.groove))
	kit:motor("Jaw", torso, jaw, jawFrame * CFrame.new(0, -0.2, 0.2))
	kit:jaw(jaw, jawFrame * CFrame.new(0, -0.12, 0), false, jawSpec)

	-- Eyes: dark blocks with a glint, set into the head flank.
	for _, sx in { -1, 1 } do
		local eye = head.cf * CFrame.new(sx * (head.w / 2 - 0.05), head.h * 0.12, -0.6)
		kit:part("Eye", Vector3.new(0.3, 0.55, 0.55), eye, PAL.eye, torso)
		kit:part("EyeGlint", Vector3.new(0.32, 0.16, 0.16), eye * CFrame.new(0, 0.12, -0.12), Color3.new(1, 1, 1), torso)
		kit:part("Brow", Vector3.new(0.4, 0.22, 0.9), eye * CFrame.new(-sx * 0.05, 0.38, 0) * CFrame.Angles(0, 0, math.rad(sx * 12)), PAL.groove, torso)
	end

	-- Dorsal fin and back spikes: chunky faceted horns, never flat plates.
	local dorsal = frames[5]
	kit:horn(torso, dorsal.cf * CFrame.new(0, dorsal.h / 2 - 0.15, 0), 4.2, 1.1, 2.6, 38, 4, { base = PAL.top, tip = PAL.flank, edge = PAL.groove })
	for _, i in { 3, 7, 9, 11 } do
		local f = frames[i]
		local bone = if i < 9 then torso else tail
		kit:horn(bone, f.cf * CFrame.new(0, f.h / 2 - 0.1, 0), Kit.lerp(1.6, 0.9, f.t), 0.7, 1.1, 30, 2, { base = PAL.top, tip = PAL.flank })
	end

	-- Tail fin: two bent horns fanned up and down from the last frame.
	local last = frames[14]
	kit:horn(tail, last.cf * CFrame.Angles(math.rad(55), 0, 0), 3.6, 0.7, 1.8, 25, 3, { base = PAL.top, tip = PAL.flank, edge = PAL.groove })
	kit:horn(tail, last.cf * CFrame.Angles(math.rad(125), 0, 0), 2.4, 0.6, 1.4, -25, 2, { base = PAL.flank, tip = PAL.belly })

	-- Pectoral fins: segmented limbs with joint lines, motored to the torso.
	local chest = frames[4]
	for _, sx in { -1, 1 } do
		local at = chest.cf * CFrame.new(sx * chest.w / 2 * 0.85, -chest.h * 0.22, 0) * CFrame.Angles(0, 0, math.rad(sx * 18))
		kit:limb(if sx < 0 then "FinL" else "FinR", torso, at, sx, { 1.6, 1.3, 1.0 }, 1.5, { base = PAL.top, under = PAL.belly, edge = PAL.groove, panel = PAL.panel, groove = PAL.groove }, -22, -6)
	end

	-- Animation: an AnimationController with an Animator drives the Motor6D rig.
	local controller = Instance.new("AnimationController")
	controller.Parent = model
	Instance.new("Animator").Parent = controller
end
