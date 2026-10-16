--!nocheck
-- Egg: a voxel egg (wider at the base) coloured per voxel (a belly band, spots and a face), with
-- same-colour runs merged into single parts. Anchored root, every voxel welded to it.
local Kit = require(script.Parent.BlockyKit)

return function(model: Model, ctx)
	local kit = Kit.new(model, ctx.origin, 5)
	local PAL = {
		shell = Color3.fromRGB(246, 176, 190),
		shade = Color3.fromRGB(226, 142, 162),
		spot = Color3.fromRGB(206, 104, 132),
		band = Color3.fromRGB(255, 226, 232),
		snout = Color3.fromRGB(236, 128, 150),
		nostril = Color3.fromRGB(120, 42, 64),
		eye = Color3.fromRGB(24, 18, 22),
	}
	local R, H, V = 2.4, 3.0, 0.4
	local root = kit:part("Root", Vector3.new(1, 1, 1), CFrame.new(0, H, 0), PAL.shell)
	root.Transparency = 1
	root.Anchored = true
	model.PrimaryPart = root

	-- Spots: a few fixed centres on the shell (unit directions).
	local spots = {}
	for i = 1, 9 do
		local u = kit.rng:NextUnitVector()
		if u.Z > -0.35 or math.abs(u.Y) > 0.6 then -- keep the face (front, -Z) clear
			table.insert(spots, u)
		end
	end
	local function colorAt(x: number, y: number, z: number, r: number): Color3
		local d = Vector3.new(x, y * 0.85, z)
		local u = if d.Magnitude > 0 then d.Unit else Vector3.yAxis
		for _, s in spots do
			if (u - s).Magnitude < 0.38 then
				return PAL.spot
			end
		end
		if math.abs(y + H * 0.15) < V * 0.6 then
			return PAL.band
		end
		-- darker toward the bottom and the back
		if y < -H * 0.55 or (z > r * 0.75 and y < 0) then
			return PAL.shade
		end
		return PAL.shell
	end
	local base = CFrame.new(0, 0, 0)
	local radius = kit:voxelEgg(base, R, H, V, colorAt, root)

	-- Face on the front (-Z): eyes, a snout block with nostrils, cheeks.
	local fy = H + 0.35
	local fz = -radius(fy - H) - 0.05
	for _, sx in { -1, 1 } do
		kit:part("Eye", Vector3.new(0.36, 0.5, 0.2), base * CFrame.new(sx * 0.8, fy + 0.45, fz + 0.1), PAL.eye, root)
		kit:part("EyeGlint", Vector3.new(0.14, 0.14, 0.1), base * CFrame.new(sx * 0.8 + 0.06, fy + 0.58, fz - 0.02), Color3.new(1, 1, 1), root)
		kit:part("Cheek", Vector3.new(0.45, 0.25, 0.15), base * CFrame.new(sx * 1.25, fy - 0.1, fz + 0.25), PAL.spot, root)
	end
	local snout = kit:part("Snout", Vector3.new(1.1, 0.75, 0.5), base * CFrame.new(0, fy - 0.15, fz - 0.1), PAL.snout, root)
	for _, sx in { -1, 1 } do
		kit:part("Nostril", Vector3.new(0.18, 0.28, 0.1), snout.CFrame * CFrame.new(sx * 0.22, 0, -0.24), PAL.nostril, root)
	end
	-- Little ears on top.
	for _, sx in { -1, 1 } do
		kit:pyramid(root, base * CFrame.new(sx * 0.9, 2 * H - 0.55, -0.4) * CFrame.Angles(math.rad(-15), 0, math.rad(-sx * 20)), 0.7, 0.4, 0.7, PAL.shade, "Ear")
	end
end
