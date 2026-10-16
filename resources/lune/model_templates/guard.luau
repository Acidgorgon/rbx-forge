--!nocheck
-- Guard: a plated, spiky four-legged beast. Ring-plated body (dark top, light belly), a tapered
-- skull with stripes, jaws with diamond teeth, chunky faceted back spikes, segmented legs with
-- joint lines and claws, fur tufts, a Motor6D rig with an Animator. In Studio, with a guard of the
-- place picked as ctx.guard, kit:wireGuard copies its gameplay pieces (Humanoid, HumanoidRootPart,
-- Collider, CENTER, EggPoint...) onto this model. Visuals only: no scripts are added.
local Kit = require(script.Parent.BlockyKit)

return function(model: Model, ctx)
	local kit = Kit.new(model, ctx.origin, 23)
	kit.material = Enum.Material.Glacier
	local PAL = {
		top = Color3.fromRGB(86, 58, 42),
		flank = Color3.fromRGB(140, 96, 62),
		belly = Color3.fromRGB(228, 206, 170),
		groove = Color3.fromRGB(38, 24, 18),
		panel = Color3.fromRGB(116, 80, 54),
		bellyEdge = Color3.fromRGB(242, 228, 202),
		spike = Color3.fromRGB(226, 216, 196),
		spikeTip = Color3.fromRGB(250, 246, 236),
		stripe = Color3.fromRGB(44, 30, 22),
		lip = Color3.fromRGB(58, 38, 28),
		inner = Color3.fromRGB(150, 46, 52),
		innerDark = Color3.fromRGB(70, 20, 26),
		tooth = Color3.fromRGB(246, 242, 228),
		eye = Color3.fromRGB(255, 196, 40),
		pupil = Color3.fromRGB(16, 14, 12),
		claw = Color3.fromRGB(236, 230, 214),
	}
	local function colorAt(s: number): Color3
		if s > 0.4 then
			return kit:vary(PAL.top, 0.03)
		elseif s > -0.25 then
			return kit:vary(PAL.flank, 0.03)
		end
		return kit:vary(PAL.belly, 0.02)
	end
	local function invisible(p: BasePart)
		p.Transparency = 1
		return p
	end

	-- Rig: anchored invisible root, torso / head / jaw / leg / tail bones joined by Motor6Ds.
	local HIP = 3.4
	local root = invisible(kit:part("Root", Vector3.new(2, 2, 2), CFrame.new(0, HIP, 0), PAL.groove))
	root.Anchored = true
	model.PrimaryPart = root
	local torso = invisible(kit:part("Torso", Vector3.new(3, 3, 7), CFrame.new(0, HIP + 0.8, 0), PAL.groove))
	kit:motor("RootJoint", root, torso, CFrame.new(0, HIP, 0))

	-- Body: a short, deep spine from chest (-Z) to rump (+Z).
	local LEN = 7.5
	local function pos(t: number): Vector3
		return Vector3.new(0, HIP + 1.1 + math.sin(t * math.pi) * 0.25 - t * 0.35, -LEN / 2 + t * LEN)
	end
	local frames = kit:spine(pos, function(t)
		return Kit.lerp(4.4, 3.6, t)
	end, function(t)
		return Kit.lerp(4.0, 3.2, t)
	end, 9)
	kit:body(frames, function()
		return torso
	end, colorAt, { groove = true, panels = true, bellyEdge = true, palette = PAL, spacing = 1.0 })

	-- Head: a tapered skull on a neck joint, a stripe over the brow, jaws in front.
	local chest = frames[0]
	local neck = chest.cf * CFrame.new(0, 0.8, -0.6)
	local head = invisible(kit:part("Head", Vector3.new(2.6, 2.6, 3), neck * CFrame.new(0, 0.6, -1.8), PAL.groove))
	kit:motor("Neck", torso, head, neck)
	local skullBase = neck * CFrame.new(0, -0.9, -1.9)
	kit:frustum(head, skullBase, 3.6, 3.2, 2.8, 2.4, 2.8, PAL.flank, "Skull", PAL.top)
	kit:stripe(head, skullBase * CFrame.new(0, 1.4, 0), Vector3.new(2.8, 2.8, 2.4), -0.5, 0.4, 0.55, PAL.stripe)
	kit:stripe(head, skullBase * CFrame.new(0, 1.4, 0), Vector3.new(2.8, 2.8, 2.4), 0.35, 0.4, 0.45, PAL.stripe)
	local mouth = skullBase * CFrame.new(0, 0.75, -1.0)
	local jawSpec = {
		length = 1.9,
		rings = 3,
		w0 = 1.45,
		w1 = 0.95,
		h0 = 0.75,
		h1 = 0.5,
		teeth0 = 0.5,
		teeth1 = 0.38,
		lip = PAL.lip,
		inner = PAL.inner,
		innerDark = PAL.innerDark,
		tooth = PAL.tooth,
		colorAt = colorAt,
		groove = true,
		palette = PAL,
	}
	kit:jaw(head, mouth * CFrame.new(0, 0.1, 0), true, jawSpec)
	local jaw = invisible(kit:part("JawBone", Vector3.new(1.4, 0.6, 2), mouth * CFrame.new(0, -0.5, -1.3), PAL.groove))
	kit:motor("Jaw", head, jaw, mouth * CFrame.new(0, -0.1, 0.3))
	kit:jaw(jaw, mouth * CFrame.new(0, -0.1, 0), false, jawSpec)
	kit:with(Enum.Material.SmoothPlastic, function()
		for _, sx in { -1, 1 } do
			local eye = skullBase * CFrame.new(sx * 1.05, 1.75, -1.25)
			kit:part("Eye", Vector3.new(0.6, 0.5, 0.2), eye, PAL.eye, head)
			kit:part("Pupil", Vector3.new(0.22, 0.42, 0.22), eye * CFrame.new(sx * 0.08, 0, -0.04), PAL.pupil, head)
			kit:part("Brow", Vector3.new(0.85, 0.24, 0.35), eye * CFrame.new(0, 0.38, -0.05) * CFrame.Angles(0, 0, math.rad(-sx * 14)), PAL.stripe, head)
		end
	end)
	-- Ears / horns: faceted, swept back.
	for _, sx in { -1, 1 } do
		kit:horn(head, skullBase * CFrame.new(sx * 1.0, 2.7, 0.5) * CFrame.Angles(0, 0, math.rad(-sx * 20)), 1.8, 0.8, 0.9, 40, 2, { base = PAL.top, tip = PAL.spike })
	end

	-- Back spikes: chunky horns along the spine, tallest over the shoulders.
	for i = 1, 7 do
		local f = frames[i]
		local hgt = Kit.lerp(2.6, 1.2, (i - 1) / 6)
		kit:horn(torso, f.cf * CFrame.new(0, f.h / 2 - 0.15, 0), hgt, 0.9, 1.3, 32, 3, { base = PAL.spike, tip = PAL.spikeTip, edge = PAL.top })
	end
	-- Cheek and shoulder fur tufts.
	for _, sx in { -1, 1 } do
		kit:tuft(head, skullBase * CFrame.new(sx * 1.6, 0.9, 0.6) * CFrame.Angles(0, 0, math.rad(-sx * 80)), 3, 0.9, 0.45, 40, { PAL.flank, PAL.belly })
		kit:tuft(torso, frames[1].cf * CFrame.new(sx * 2.0, 0.2, 0) * CFrame.Angles(0, 0, math.rad(-sx * 75)), 3, 1.1, 0.5, 40, { PAL.top, PAL.flank })
	end

	-- Legs: upper and lower tapered blocks (built downward), dark joint lines, a paw with claws.
	for _, leg in { { "FL", -1, frames[1] }, { "FR", 1, frames[1] }, { "BL", -1, frames[7] }, { "BR", 1, frames[7] } } do
		local tag, sx, f = leg[1], leg[2], leg[3]
		local hip = CFrame.new(sx * (f.w / 2 - 0.5), f.cf.Position.Y - 0.6, f.cf.Position.Z)
		local bone = invisible(kit:part("Leg" .. tag, Vector3.new(1.2, HIP, 1.2), hip * CFrame.new(0, -HIP / 2, 0), PAL.groove))
		kit:motor("Leg" .. tag, torso, bone, hip)
		local down = hip * CFrame.Angles(math.pi, 0, 0)
		kit:frustum(bone, down, 1.8, 1.8, 1.4, 1.4, 1.8, PAL.flank, "Thigh", PAL.top)
		kit:part("JointLine", Vector3.new(1.55, 0.2, 1.55), hip * CFrame.new(0, -1.85, 0), PAL.groove, bone)
		kit:frustum(bone, down * CFrame.new(0, 1.95, 0), 1.4, 1.4, 1.2, 1.2, 1.5, PAL.flank, "Shin", PAL.top)
		kit:part("JointLine", Vector3.new(1.3, 0.18, 1.3), hip * CFrame.new(0, -3.5, 0), PAL.groove, bone)
		local paw = kit:part("Paw", Vector3.new(1.6, 0.7, 1.9), CFrame.new(hip.Position.X, ctx.origin.Y * 0 + 0.35, hip.Position.Z - 0.2), PAL.belly, bone)
		kit:bevel(paw, 0.12)
		kit:with(Enum.Material.SmoothPlastic, function()
			for c = -1, 1 do
				kit:pyramid(bone, CFrame.new(hip.Position.X + c * 0.5, 0.25, hip.Position.Z - 1.15) * CFrame.Angles(math.rad(-80), 0, 0), 0.3, 0.3, 0.55, PAL.claw, "Claw")
			end
		end)
	end

	-- Tail: a short plated stub on its own bone with a tuft at the tip.
	local rump = frames[8]
	local tailAt = rump.cf * CFrame.new(0, 0.6, 0.4)
	local tail = invisible(kit:part("TailBone", Vector3.new(1, 1, 3), tailAt * CFrame.new(0, 0.4, 1.5), PAL.groove))
	kit:motor("Tail", torso, tail, tailAt)
	local tframes = kit:spine(function(t)
		return (tailAt * CFrame.new(0, t * 1.4, t * 3.2)).Position
	end, function(t)
		return Kit.lerp(1.6, 0.8, t)
	end, function(t)
		return Kit.lerp(1.5, 0.7, t)
	end, 4)
	kit:body(tframes, function()
		return tail
	end, colorAt, { groove = true, palette = PAL, spacing = 0.9 })
	kit:tuft(tail, tframes[3].cf * CFrame.Angles(math.rad(-100), 0, 0), 3, 1.3, 0.5, 50, { PAL.top, PAL.spike })

	local controller = Instance.new("AnimationController")
	controller.Parent = model
	Instance.new("Animator").Parent = controller

	-- Gameplay: copy an existing guard's pieces (Studio only; ctx.guard is nil in the preview).
	if ctx.guard then
		kit:wireGuard(model, ctx.guard, root, head, ctx.areaId or "Area1", {
			hrp = CFrame.new(0, HIP, 0),
			hrpSize = Vector3.new(4, 4, 8),
			collider = CFrame.new(0, HIP, 0),
			colliderSize = Vector3.new(6, 7, 11),
			center = CFrame.new(0, HIP, 0),
			egg = CFrame.new(0, HIP + 2, -6.5),
			sleep = CFrame.new(0, HIP + 4.5, -4),
			hipHeight = HIP - 2,
		})
		-- The copied HumanoidRootPart carries the guard; the visual root follows it.
		root.Anchored = false
	end
end
