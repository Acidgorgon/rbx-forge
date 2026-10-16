--!strict
-- BlockyKit: builds blocky, voxel-style creatures out of Parts (the "plated" look of hand-made Blender
-- block models): curved ring bodies of overlapping plates with dark grooves, chunky curved spikes,
-- jaws with teeth, segmented flippers/legs, bevelled blocks and voxel eggs. Everything is built in
-- a model-local frame (-Z forward, +Y up) and placed with `origin`.

local Kit = {}
Kit.__index = Kit

local rad = math.rad

export type Palette = { [string]: Color3 }

function Kit.new(model: Model, origin: CFrame, seed: number?)
	local self = setmetatable({}, Kit)
	self.model = model
	self.origin = origin
	self.rng = Random.new(seed or 1)
	self.count = 0
	-- Material for every new part. Glacier gives the grainy "fur" read of Acid's guards; switch it
	-- per section (kit.material = Enum.Material.SmoothPlastic for eyes, teeth, claws).
	self.material = Enum.Material.SmoothPlastic
	return self
end

-- Runs fn with a temporary material, e.g. kit:with(Enum.Material.Glacier, function() ... end).
function Kit:with(material: Enum.Material, fn: () -> ())
	local old = self.material
	self.material = material
	fn()
	self.material = old
end

function Kit.lerp(a: number, b: number, t: number): number
	return a + (b - a) * t
end

-- A colour nudged in value, so neighbouring plates never read as one flat surface.
function Kit:vary(c: Color3, amount: number?): Color3
	local h, s, v = c:ToHSV()
	local a = amount or 0.03
	return Color3.fromHSV(h, s, math.clamp(v + self.rng:NextNumber(-a, a), 0, 1))
end

-- A part in model-local space. `bone` welds it to that part (nil = free, e.g. a bone itself).
function Kit:part(name: string, size: Vector3, cf: CFrame, color: Color3, bone: BasePart?, class: string?): BasePart
	local p = Instance.new((class or "Part") :: any) :: BasePart
	p.Name = name
	p.Size = Vector3.new(math.max(0.05, size.X), math.max(0.05, size.Y), math.max(0.05, size.Z))
	p.CFrame = self.origin * cf
	p.Color = color
	p.Material = self.material or Enum.Material.SmoothPlastic
	p.TopSurface = Enum.SurfaceType.Smooth
	p.BottomSurface = Enum.SurfaceType.Smooth
	p.Anchored = false
	p.CanCollide = false
	p.CanQuery = false
	p.CanTouch = false
	p.Massless = true
	p.Parent = self.model
	if bone then
		local w = Instance.new("WeldConstraint")
		w.Part0 = bone
		w.Part1 = p
		w.Parent = p
	end
	self.count += 1
	return p
end

-- A Motor6D whose joint sits at model-local `at` (parented to p1, like Roblox rigs).
function Kit:motor(name: string, p0: BasePart, p1: BasePart, at: CFrame): Motor6D
	local m = Instance.new("Motor6D")
	m.Name = name
	m.Part0 = p0
	m.Part1 = p1
	local w = self.origin * at
	m.C0 = p0.CFrame:Inverse() * w
	m.C1 = p1.CFrame:Inverse() * w
	m.Parent = p1
	return m
end

-- Frames along a spine: pos(t) -> Vector3 centre line, w(t)/h(t) -> cross-section. Each frame's -Z
-- points toward t = 0 (the head end).
function Kit:spine(pos: (number) -> Vector3, w: (number) -> number, h: (number) -> number, n: number)
	local frames = {}
	for i = 0, n - 1 do
		local t = i / (n - 1)
		local q = pos(math.max(0, t - 0.02)) - pos(math.min(1, t + 0.02))
		local p = pos(t)
		frames[i] = { cf = CFrame.lookAt(p, p + q.Unit), w = w(t), h = h(t), t = t }
	end
	return frames
end

-- One ring of overlapping plates around an ellipse (half-width a, half-height b) in frame `cf`.
-- from/to: angle range in degrees (0 = right, 90 = top). colorAt(sin) picks the plate colour.
-- opts: groove (dark ring behind the plates), panels (raised plates on the upper flank),
-- bellyEdge (bright line where the belly meets the flank), thick, palette.
function Kit:ring(bone: BasePart, cf: CFrame, a: number, b: number, spacing: number, n: number, from: number, to: number, offset: number, colorAt: (number) -> Color3, opts: any?)
	local o = opts or {}
	local pal = o.palette or {}
	local step = (to - from) / n
	for k = 0, n - 1 do
		local th = rad(from + (k + 0.5) * step + offset)
		local s, c = math.sin(th), math.cos(th)
		local ang = math.atan2(s / b, c / a) - math.pi / 2
		local arc = math.sqrt((a * s) ^ 2 + (b * c) ^ 2) * rad(step)
		local jit = CFrame.Angles(rad(self.rng:NextNumber(-3, 3)), 0, rad(self.rng:NextNumber(-2, 2)))
		local face = cf * CFrame.new(a * c, b * s, 0) * CFrame.Angles(0, 0, ang) * jit
		self:part("Plate", Vector3.new(math.max(0.35, arc * 1.12), o.thick or 0.55, spacing * (o.groove and 0.86 or 1.4)), face, colorAt(s), bone)
		if o.groove then
			self:part("Groove", Vector3.new(math.max(0.35, arc * 1.15), 0.4, spacing * 0.3), face * CFrame.new(0, -0.12, spacing * 0.5), pal.groove or Color3.fromRGB(22, 44, 66), bone)
		end
		if o.panels and s > -0.15 and s < 0.75 and self.rng:NextNumber() < 0.7 then
			self:part("Panel", Vector3.new(math.max(0.3, arc * 0.7), 0.2, spacing * 0.55), face * CFrame.new(0, 0.35, self.rng:NextNumber(-0.1, 0.1)), self:vary(pal.panel or colorAt(s), 0.04), bone)
		end
		if o.bellyEdge and s > -0.32 and s < -0.12 then
			self:part("BellyEdge", Vector3.new(math.max(0.3, arc), 0.18, spacing * 0.7), face * CFrame.new(0, 0.33, 0), pal.bellyEdge or Color3.new(1, 1, 1), bone)
		end
	end
end

-- Plates + core for every frame of a spine. boneFor(i) picks the bone each ring is welded to.
-- Returns the core part of every ring (cores[i]).
function Kit:body(frames, boneFor: (number) -> BasePart?, colorAt: (number) -> Color3, opts: any?)
	local o = opts or {}
	local cores = {}
	for i = 0, #frames do
		local f = frames[i]
		local bone = boneFor(i)
		cores[i] = self:part(o.coreName and o.coreName(i) or "Core", Vector3.new(f.w * 0.86, f.h * 0.86, (o.spacing or 0.9) * 1.05), f.cf, (o.palette or {}).groove or Color3.fromRGB(22, 44, 66), bone)
		local n = math.clamp(math.floor(f.w * (o.density or 2.6)), 6, 18)
		self:ring(cores[i], f.cf, f.w / 2, f.h / 2, o.spacing or 0.9, n, 0, 360, (i % 2) * (180 / n), colorAt, o)
	end
	return cores
end

-- Chunky curved spike: `segs` stacked blocks, each bent further back (total `bend` degrees) and
-- narrower, with a dark leading edge and a lighter tip. Volumetric: width ~ 0.7 x depth.
-- cf: base frame with +Y out of the body and -Z forward.
function Kit:spike(bone: BasePart, cf: CFrame, height: number, depth: number, bend: number, segs: number, pal: Palette)
	local cur = cf
	local segLen = height / segs
	for k = 0, segs - 1 do
		local u = k / math.max(1, segs - 1)
		local d = Kit.lerp(depth, depth * 0.35, u)
		local w = math.max(0.3, d * 0.7)
		cur = cur * CFrame.Angles(rad(bend / segs), 0, 0)
		local mid = cur * CFrame.new(0, segLen / 2, 0)
		self:part("Spike", Vector3.new(w, segLen + 0.12, d), mid, self:vary(u > 0.7 and (pal.tip or pal.base) or pal.base, 0.03), bone)
		self:part("SpikeEdge", Vector3.new(w * 0.75, segLen + 0.1, 0.24), mid * CFrame.new(0, 0, -d / 2 - 0.06), pal.edge or pal.base, bone)
		cur = cur * CFrame.new(0, segLen, 0)
	end
end

-- ── Faceted 3D shapes ────────────────────────────────────────────────────────────────────────
-- Roblox primitives used: WedgePart rises toward local +Z (zero height at -Z); CornerWedgePart has
-- its apex over the local (+X, -Z) corner and slopes down toward -X and +Z.

-- A corner wedge filling one quadrant whose apex corner sits at `apex` (model-local, base level),
-- with the quadrant spreading toward (sx, sz) in frame cf. sizeX/sizeZ along the frame's X/Z.
function Kit:cornerAt(name: string, bone: BasePart?, cf: CFrame, sx: number, sz: number, sizeX: number, h: number, sizeZ: number, color: Color3)
	-- Rotation that turns the local (+X, -Z) apex corner toward the quadrant's inner corner.
	local yaw = if sx < 0 and sz > 0 then 0 elseif sx > 0 and sz > 0 then 90 elseif sx > 0 and sz < 0 then 180 else -90
	local swap = (yaw == 90 or yaw == -90)
	local size = if swap then Vector3.new(sizeZ, h, sizeX) else Vector3.new(sizeX, h, sizeZ)
	local centre = cf * CFrame.new(sx * sizeX / 2, h / 2, sz * sizeZ / 2)
	return self:part(name, size, centre * CFrame.Angles(0, rad(yaw), 0), color, bone, "CornerWedgePart")
end

-- Square/rectangular pyramid: base w x d at cf (cf is the base centre, +Y up), apex h above.
-- Four corner wedges; a true pointed 3D shape for spikes, fur tufts, claws, ears, crystals, flames.
function Kit:pyramid(bone: BasePart?, cf: CFrame, w: number, d: number, h: number, color: Color3, name: string?)
	for _, q in { { -1, -1 }, { 1, -1 }, { -1, 1 }, { 1, 1 } } do
		self:cornerAt(name or "Pyramid", bone, cf, q[1], q[2], w / 2, h, d / 2, color)
	end
end

-- Tapered block (frustum): bottom bw x bd at cf, top tw x td, height h. A centre box plus four
-- side wedges and four corner wedges, so every side slopes. Use for heads, muzzles, legs, torsos.
-- `bottomColor` (optional) tints the slopes so the taper reads; returns the centre box.
function Kit:frustum(bone: BasePart?, cf: CFrame, bw: number, bd: number, tw: number, td: number, h: number, color: Color3, name: string?, slopeColor: Color3?)
	local n = name or "Block"
	local core = self:part(n, Vector3.new(tw, h, td), cf * CFrame.new(0, h / 2, 0), color, bone)
	local ox, oz = (bw - tw) / 2, (bd - td) / 2
	local sc = slopeColor or color
	if ox > 0.04 then
		for _, sx in { -1, 1 } do
			local at = cf * CFrame.new(sx * (tw / 2 + ox / 2), h / 2, 0)
			-- local -Z of the wedge points outward (thin edge out), +Z inward (tall edge at the core)
			local look = CFrame.lookAt(at.Position, (at * CFrame.new(sx, 0, 0)).Position, (cf.UpVector))
			self:part(n .. "Side", Vector3.new(td, h, ox), look, sc, bone, "WedgePart")
		end
	end
	if oz > 0.04 then
		for _, sz in { -1, 1 } do
			local at = cf * CFrame.new(0, h / 2, sz * (td / 2 + oz / 2))
			local look = CFrame.lookAt(at.Position, (at * CFrame.new(0, 0, sz)).Position, (cf.UpVector))
			self:part(n .. "Side", Vector3.new(tw, h, oz), look, sc, bone, "WedgePart")
		end
	end
	if ox > 0.04 and oz > 0.04 then
		for _, q in { { -1, -1 }, { 1, -1 }, { -1, 1 }, { 1, 1 } } do
			self:cornerAt(n .. "Corner", bone, cf * CFrame.new(q[1] * tw / 2, 0, q[2] * td / 2), q[1], q[2], ox, h, oz, sc)
		end
	end
	return core
end

-- Faceted horn/spike: stacked frustums that narrow and bend back, capped with a pyramid tip, so
-- it is round-ish and pointed from every angle (never a flat plate). cf: base, +Y out, -Z forward;
-- positive bend leans the tip back toward +Z.
-- pal: { base, tip, edge? } — edge adds a darker leading ridge.
function Kit:horn(bone: BasePart, cf: CFrame, height: number, w: number, d: number, bend: number, segs: number, pal: Palette)
	local cur = cf
	local segLen = height / (segs + 1)
	for k = 0, segs - 1 do
		local u0, u1 = k / (segs + 1), (k + 1) / (segs + 1)
		local w0, w1 = Kit.lerp(w, w * 0.2, u0), Kit.lerp(w, w * 0.2, u1)
		local d0, d1 = Kit.lerp(d, d * 0.2, u0), Kit.lerp(d, d * 0.2, u1)
		local col = self:vary(if u1 > 0.6 and pal.tip then pal.tip else pal.base, 0.03)
		self:frustum(bone, cur, w0, d0, w1, d1, segLen + 0.06, col, "Spike")
		if pal.edge then
			self:part("SpikeEdge", Vector3.new(math.max(0.12, w1 * 0.35), segLen + 0.06, 0.18), cur * CFrame.new(0, segLen / 2, -Kit.lerp(d0, d1, 0.5) / 2), pal.edge, bone)
		end
		cur = cur * CFrame.new(0, segLen, 0) * CFrame.Angles(rad(bend / segs), 0, 0)
	end
	local wt, dt = w * 0.2 + 0.02, d * 0.2 + 0.02
	self:pyramid(bone, cur, math.max(0.1, Kit.lerp(w, w * 0.2, segs / (segs + 1))), math.max(0.1, Kit.lerp(d, d * 0.2, segs / (segs + 1))), segLen * 1.2, pal.tip or pal.base, "SpikeTip")
	return wt, dt
end

-- A fur tuft / shard cluster: n pyramids fanned around cf's -Z/+Y, each tilted out. Good for
-- cheek ruffs, manes, tail tips, elbow fur and flame crowns.
function Kit:tuft(bone: BasePart, cf: CFrame, n: number, len: number, base: number, spread: number, colors: { Color3 })
	for i = 1, n do
		local t = if n == 1 then 0 else (i - 1) / (n - 1) - 0.5
		local tilt = CFrame.Angles(rad(self.rng:NextNumber(-8, 8)), 0, rad(t * spread))
		local c = colors[(i - 1) % #colors + 1]
		local L = len * self.rng:NextNumber(0.75, 1.1)
		self:pyramid(bone, cf * CFrame.new(t * base * n * 0.5, 0, 0) * tilt, base, base * 0.8, L, self:vary(c, 0.03), "Tuft")
	end
end

-- Raised stripe band over the top and flanks of a box (tiger/zebra stripes, armour straps): a
-- slab on top, slabs down each side, ending in a pyramid point. cf: box centre; size: the box.
-- reach: 0-1 how far down the flank the stripe runs before its point.
function Kit:stripe(bone: BasePart, cf: CFrame, size: Vector3, z: number, width: number, reach: number, color: Color3, thick: number?)
	local th = thick or 0.18
	local top = cf * CFrame.new(0, size.Y / 2 + th / 2 - 0.05, z)
	self:part("Stripe", Vector3.new(size.X + 2 * th - 0.1, th, width), top, color, bone)
	local drop = size.Y * reach
	for _, sx in { -1, 1 } do
		local side = cf * CFrame.new(sx * (size.X / 2 + th / 2 - 0.05), size.Y / 2 - drop / 2, z)
		self:part("Stripe", Vector3.new(th, drop, width), side, color, bone)
		-- pointed end: a thin pyramid pointing down the flank
		local tipBase = cf * CFrame.new(sx * (size.X / 2 + th / 2 - 0.05), size.Y / 2 - drop, z) * CFrame.Angles(math.pi, 0, 0)
		self:pyramid(bone, tipBase, th, width, math.min(size.Y * 0.25, width * 1.6), color, "StripeTip")
	end
end

-- Ring of n blocks around a circle (halo, belt, orbit, wreath, gear rim): cf is the centre and the
-- circle lies in cf's XZ plane; tilt cf for an angled ring.
function Kit:torus(bone: BasePart?, cf: CFrame, R: number, thick: number, n: number, color: Color3, name: string?, height: number?)
	for i = 0, n - 1 do
		local a = i / n * math.pi * 2
		local seg = 2 * math.pi * R / n * 1.15
		self:part(name or "Ring", Vector3.new(seg, height or thick, thick), cf * CFrame.Angles(0, a, 0) * CFrame.new(0, 0, -R), color, bone)
	end
end

-- Gear: a rim with teeth, three spokes and a hub, lying in cf's XZ plane.
function Kit:gear(bone: BasePart?, cf: CFrame, R: number, thick: number, teeth: number, color: Color3, hubColor: Color3?)
	self:torus(bone, cf, R, thick, math.max(8, teeth * 2), color, "Gear", thick * 0.8)
	for i = 0, teeth - 1 do
		local a = i / teeth * math.pi * 2
		self:part("GearTooth", Vector3.new(thick * 0.9, thick * 0.8, thick * 1.1), cf * CFrame.Angles(0, a, 0) * CFrame.new(0, 0, -R - thick * 0.8), color, bone)
	end
	for i = 0, 2 do
		self:part("GearSpoke", Vector3.new(R * 2, thick * 0.6, thick * 0.5), cf * CFrame.Angles(0, i * math.pi / 3, 0), color, bone)
	end
	self:part("GearHub", Vector3.new(thick * 1.6, thick, thick * 1.6), cf, hubColor or color, bone)
end

-- Teeth: a 45-degree diamond half-buried in the lip so a triangle shows. up = true points up.
function Kit:tooth(bone: BasePart, cf: CFrame, size: number, color: Color3)
	return self:part("Tooth", Vector3.new(0.2, size, size), cf * CFrame.Angles(rad(45), 0, 0), color, bone)
end

-- A jaw built from half-rings along its own frame (-Z forward). upper = top half, else bottom half.
-- spec: { length, rings, w0, w1, h0, h1, teeth0, teeth1, lip, inner, innerDark, tooth, colorAt, groove }
function Kit:jaw(bone: BasePart, frame: CFrame, upper: boolean, spec: any)
	for i = 0, spec.rings - 1 do
		local u = i / (spec.rings - 1)
		local z = -0.4 - u * spec.length
		local aw = Kit.lerp(spec.w0, spec.w1, u ^ 1.1)
		local hb = Kit.lerp(spec.h0, spec.h1, u)
		local cf = frame * CFrame.new(0, 0, z)
		if i > 0 then
			self:part("JawCore", Vector3.new(aw * 1.5, hb * 0.9, 0.95), cf * CFrame.new(0, (upper and 1 or -1) * hb * 0.45, 0), spec.core or spec.inner, bone)
		end
		if upper then
			self:ring(bone, cf, aw, hb, 0.9, 8, 8, 172, (i % 2) * 10, spec.colorAt, { groove = spec.groove, panels = i < spec.rings * 0.6, palette = spec.palette })
		else
			self:ring(bone, cf, aw, hb, 0.9, 7, 188, 352, (i % 2) * 12, spec.colorAt, { groove = spec.groove, palette = spec.palette })
		end
		local sgn = upper and 1 or -1
		for _, sx in { -1, 1 } do
			self:part("Lip", Vector3.new(0.5, 0.4, 0.95), cf * CFrame.new(sx * (aw - 0.12), 0.04 * sgn, 0), self:vary(spec.lip, 0.02), bone)
			local ts = Kit.lerp(spec.teeth0, spec.teeth1, u)
			self:tooth(bone, cf * CFrame.new(sx * (aw - 0.32), -0.18 * sgn, 0), ts, spec.tooth)
		end
		self:part("Mouth", Vector3.new(math.max(0.4, aw * 2 - 1.1), 0.22, 0.95), cf * CFrame.new(0, -0.08 * sgn, 0), (i % 3 == 0) and spec.innerDark or spec.inner, bone)
	end
end

-- Segmented limb (flipper, leg, wing arm): pieces of `lens` bending out/back from `cf`, each a top
-- block with an underside, an edge ridge, a raised ridge and a dark joint line. Returns the first
-- piece (motored to `bone` at `cf`).
function Kit:limb(tag: string, bone: BasePart, cf: CFrame, sx: number, lens: { number }, wid: number, pal: Palette, bendY: number?, bendZ: number?)
	local first: BasePart? = nil
	local cur = cf
	for k, L in lens do
		local wk = wid * (1 - (k - 1) * 0.2)
		local seg = cur * CFrame.new(sx * L / 2, 0, 0)
		local a = self:part(tag .. k, Vector3.new(L, 0.55, wk), seg, self:vary(pal.base, 0.03), first)
		if k == 1 then
			self:motor(tag, bone, a, cur)
			first = a
		end
		self:part("Under", Vector3.new(L * 0.95, 0.25, wk * 0.85), seg * CFrame.new(0, -0.38, 0.05), self:vary(pal.under or pal.base, 0.02), first)
		self:part("Edge", Vector3.new(L * 0.9, 0.32, 0.32), seg * CFrame.new(0, 0.3, wk / 2 - 0.12), pal.edge or pal.base, first)
		self:part("Ridge", Vector3.new(L * 0.7, 0.2, wk * 0.45), seg * CFrame.new(0, 0.35, -0.1), self:vary(pal.panel or pal.base, 0.04), first)
		self:part("JointLine", Vector3.new(0.25, 0.62, wk * 1.02), seg * CFrame.new(sx * L / 2, 0, 0), pal.groove or pal.base, first)
		cur = cur * CFrame.new(sx * L, 0, 0) * CFrame.Angles(0, sx * rad(bendY or -16), 0) * CFrame.Angles(0, 0, sx * rad(bendZ or -8))
	end
	return first
end

-- Bevel: a box becomes three overlapping boxes, each inset on two axes, so edges read chamfered.
function Kit:bevel(p: BasePart, inset: number?)
	local b = inset or 0.15
	local s = p.Size
	if s.X < 0.9 or s.Y < 0.9 or s.Z < 0.9 then return end
	for _, v in { Vector3.new(s.X - 2 * b, s.Y, s.Z - 2 * b), Vector3.new(s.X - 2 * b, s.Y - 2 * b, s.Z) } do
		local q = p:Clone()
		q:ClearAllChildren()
		q.Size = v
		q.Name = p.Name .. "_Bevel"
		q.Parent = p.Parent
		local w = Instance.new("WeldConstraint")
		w.Part0 = p
		w.Part1 = q
		w.Parent = q
	end
	p.Size = Vector3.new(s.X, s.Y - 2 * b, s.Z - 2 * b)
	self.count += 2
end

-- Voxel egg (wider at the base) at model-local `base` (bottom centre). colorAt(x, y, z, r) per voxel;
-- runs of equal colour along X merge into one part. Returns radius(y) for placing features, and the parts.
function Kit:voxelEgg(base: CFrame, R: number, H: number, V: number, colorAt: (number, number, number, number) -> Color3, bone: BasePart?)
	local function radius(y: number): number
		local t = y / H
		if math.abs(t) >= 1 then return 0 end
		return R * math.sqrt(1 - t * t) * (1 - 0.14 * t)
	end
	local span = R * 1.2
	local parts = {}
	local nxz = math.floor(span * 2 / V)
	local ny = math.floor(H * 2 / V)
	for iy = 0, ny - 1 do
		local y = -H + (iy + 0.5) * V
		local rr = radius(y)
		for iz = 0, nxz - 1 do
			local z = -span + (iz + 0.5) * V
			local runStart: number?, runColor: Color3? = nil, nil
			for ix = 0, nxz do
				local x = -span + (ix + 0.5) * V
				local inside = ix < nxz and (x * x + z * z <= rr * rr)
				local c = if inside then colorAt(x, y, z, rr) else nil
				if runStart and (not inside or c ~= runColor) then
					local x0 = -span + runStart * V
					local x1 = -span + ix * V
					self:part("Voxel", Vector3.new(x1 - x0, V, V), base * CFrame.new((x0 + x1) / 2, y + H, z), self:vary(runColor :: Color3, 0.02), bone)
					runStart = nil
				end
				if inside and not runStart then
					runStart, runColor = ix, c
				end
			end
		end
	end
	return radius, parts
end

-- Copies a guard's gameplay pieces (Humanoid, HumanoidRootPart + sounds, HumanoidMass, Collider,
-- CENTER, EggPoint, SleepVFXAttachment, AlertGui, attributes) from `source` onto `guard`, re-welded
-- to this guard's parts. place: { hrp, collider, center, egg } model-local CFrames; sizes optional.
function Kit:wireGuard(guard: Model, source: Model, root: BasePart, head: BasePart, areaId: string, place: any)
	local function copy(name: string): BasePart
		local c = (source:FindFirstChild(name) :: BasePart):Clone()
		c.Parent = guard
		return c
	end
	local hum = (source:FindFirstChildOfClass("Humanoid") :: Humanoid):Clone()
	hum.HipHeight = place.hipHeight or hum.HipHeight
	hum.Parent = guard
	local hrp = copy("HumanoidRootPart")
	if place.hrpSize then hrp.Size = place.hrpSize end
	hrp.CFrame = self.origin * place.hrp
	local mass = copy("HumanoidMass")
	mass.CFrame = hrp.CFrame
	local col = copy("Collider")
	if place.colliderSize then col.Size = place.colliderSize end
	col.CFrame = self.origin * place.collider
	local center = copy("CENTER")
	center.CFrame = self.origin * place.center
	local egg = copy("EggPoint")
	egg.CFrame = self.origin * place.egg
	-- Cloned welds still point at the source guard: aim them at this guard's parts.
	local function rew(part: BasePart, a: BasePart, b: BasePart)
		for _, w in part:GetChildren() do
			if w:IsA("WeldConstraint") then
				w.Part0 = a
				w.Part1 = b
			end
		end
	end
	rew(hrp, hrp, root)
	rew(mass, mass, hrp)
	rew(col, col, hrp)
	rew(center, hrp, center)
	rew(egg, egg, head)
	local att = source:FindFirstChild("SleepVFXAttachment", true)
	if att then
		local a = att:Clone() :: Attachment
		a.Parent = head
		a.CFrame = head.CFrame:Inverse() * (self.origin * (place.sleep or place.center))
	end
	local gui = source:FindFirstChild("AlertGui", true)
	if gui then gui:Clone().Parent = head end
	for k, v in source:GetAttributes() do guard:SetAttribute(k, v) end
	guard:SetAttribute("AreaId", areaId)
	guard.PrimaryPart = hrp
	return hrp
end

-- ── Crystal / armour helpers (added for the Abyssalisk) ─────────────────────────────────────

-- A frame at pos whose +Y points along dir and whose +Z leans toward `bend` (made orthogonal).
-- Use it to aim horns, shards and antlers in any direction: their tips bend toward +Z, and a
-- shard's width runs along the frame's X (= dir x bend).
function Kit.aim(pos: Vector3, dir: Vector3, bend: Vector3): CFrame
	local y = dir.Unit
	local z = bend - y * bend:Dot(y)
	if z.Magnitude < 1e-4 then
		z = if math.abs(y.Y) < 0.9 then Vector3.yAxis - y * y.Y else Vector3.xAxis - y * y.X
	end
	z = z.Unit
	return CFrame.fromMatrix(pos, y:Cross(z), y, z)
end

local QUADS = { { -1, -1 }, { 1, -1 }, { 1, 1 }, { -1, 1 } }

-- Crystal shard / blade: a w x d body with a four-facet pyramid tip whose quadrants alternate
-- light/mid/dark so it reads cut, plus (facet ~= false) a light bevel strip down one half of the
-- body. cf: base centre, +Y along the shard (see Kit.aim). pal: { light, mid, dark }. ~6 parts;
-- pass facet = false for 5. Works for crystal spikes, mane blades, claws and fan blades.
function Kit:shard(bone: BasePart?, cf: CFrame, len: number, w: number, d: number, pal: any, name: string?, tipFrac: number?, facet: boolean?)
	local n = name or "Shard"
	local tip = math.min(len * (tipFrac or 0.42), math.max(w, d) * 2.4)
	local body = math.max(0.1, len - tip)
	self:part(n, Vector3.new(w, body + 0.04, d), cf * CFrame.new(0, body / 2, 0), self:vary(pal.mid, 0.025), bone)
	if facet ~= false and w > 0.5 then
		self:part(n .. "Facet", Vector3.new(w * 0.42, body * 0.94, d + 0.05), cf * CFrame.new(w * 0.27, body * 0.5, 0), pal.light, bone)
	end
	local top = cf * CFrame.new(0, body, 0)
	local cols = { pal.light, pal.mid, pal.dark or pal.mid, pal.light }
	for i, q in QUADS do
		self:cornerAt(n .. "Tip", bone, top, q[1], q[2], w / 2, tip, d / 2, cols[i])
	end
end

-- Glowing zigzag crack / vein: bars through the model-local points `pts`, lying flat on a surface
-- whose normals are `nrm` (one per point). Call inside kit:with(Enum.Material.Neon, ...). halo
-- (e.g. 3) adds a wider translucent strip under the line so it reads as a soft glow.
function Kit:crack(bone: BasePart?, pts: { Vector3 }, nrm: { Vector3 }, width: number, color: Color3, halo: number?)
	for i = 1, #pts - 1 do
		local a, b = pts[i], pts[i + 1]
		local n = (nrm[i] + nrm[i + 1]).Unit
		local d = (b - a).Magnitude
		local cf = CFrame.lookAt((a + b) / 2, b, n)
		self:part("Crack", Vector3.new(width, width * 0.7, d + width * 0.9), cf, color, bone)
		if halo then
			local h = self:part("CrackGlow", Vector3.new(width * halo, width * 0.35, d + width * halo * 0.5), cf * CFrame.new(0, -width * 0.2, 0), color, bone)
			h.Transparency = 0.72
		end
	end
end

-- Branching crystal antler. cf: base, +Y along the beam, bends toward +Z (use Kit.aim).
-- spec = { len, w, segs, bend = deg per joint (number or per-joint list), branches = { { at =
-- joint index, pitch, roll, len, w?, segs, bend, branches? } } }. Negative pitch tilts a tine
-- away from the bend (upward on a back-swept beam); roll tilts it sideways. Segments are
-- diamond prisms with a light facet and an angular knuckle; the last one is a shard tip.
function Kit:antler(bone: BasePart?, cf: CFrame, spec: any, pal: any)
	local cur = cf
	local segLen = spec.len / spec.segs
	for k = 1, spec.segs do
		local u = (k - 1) / spec.segs
		local wk = spec.w * (1 - 0.45 * u)
		if k == spec.segs then
			self:shard(bone, cur, segLen * 1.25, wk, wk * 0.8, pal, "Antler", 0.6)
		else
			local mid = cur * CFrame.new(0, segLen / 2, 0) * CFrame.Angles(0, math.rad(45), 0)
			self:part("Antler", Vector3.new(wk, segLen + wk * 0.35, wk * 0.8), mid, self:vary(k % 2 == 0 and pal.light or pal.mid, 0.02), bone)
			self:part("AntlerFacet", Vector3.new(wk * 0.45, segLen * 0.85, wk * 0.85), mid * CFrame.new(wk * 0.3, 0, 0), pal.light, bone)
			cur = cur * CFrame.new(0, segLen, 0)
			self:part("AntlerKnuckle", Vector3.new(wk * 1.08, wk * 1.0, wk * 0.95), cur * CFrame.Angles(math.rad(25), math.rad(45), math.rad(20)), pal.dark or pal.mid, bone)
			for _, br in spec.branches or {} do
				if br.at == k then
					local bcf = cur * CFrame.Angles(math.rad(br.pitch or 0), 0, math.rad(br.roll or 0))
					self:antler(bone, bcf, { len = br.len, w = br.w or wk * 0.75, segs = br.segs or 2, bend = br.bend or 0, branches = br.branches }, pal)
				end
			end
			local b = spec.bend
			if type(b) == "table" then b = b[k] or 0 end
			cur = cur * CFrame.Angles(math.rad(b or 0), 0, 0)
		end
	end
end

-- Faceted gem: an elongated octahedron (two four-facet pyramids base to base). cf: centre, +Y
-- along the long axis (h), +Z out of the surface (d). Seen along Z it is a w x h diamond. Nest a
-- Neon gem in a larger navy one for a socketed jewel.
function Kit:gem(bone: BasePart?, cf: CFrame, w: number, h: number, d: number, pal: any)
	local cols = { pal.light, pal.mid, pal.light, pal.dark or pal.mid }
	for _, flip in { 0, math.pi } do
		local base = cf * CFrame.Angles(flip, 0, 0)
		for i, q in QUADS do
			self:cornerAt("Gem", bone, base, q[1], q[2], w / 2, h / 2, d / 2, cols[i])
		end
	end
end

-- Armour scale: a two-facet ridge (two CornerWedges sharing an apex at the back-centre) over a
-- dark base slab. cf: on the surface, +Y = normal, -Z = upstream (toward the head); the thick
-- edge sits at cf's back, so rows of scales spaced < len overlap like roof tiles. 3 parts.
function Kit:scale(bone: BasePart?, cf: CFrame, w: number, len: number, h: number, color: Color3, baseColor: Color3?)
	if baseColor then
		self:part("ScaleBase", Vector3.new(w * 0.96, 0.4, len * 0.66), cf * CFrame.new(0, 0, -len * 0.4), baseColor, bone)
	end
	self:cornerAt("Scale", bone, cf, -1, -1, w / 2, h, len, self:vary(color, 0.02))
	self:cornerAt("Scale", bone, cf, 1, -1, w / 2, h, len, self:vary(color, 0.05))
end

-- Chevron scute row (belly plates): n flat plates across an elliptical arc (half-axes a, b in
-- frame cf, angles from..to in degrees, 270 = straight down), outer plates shifted toward -Z and
-- yawed so the row forms a V pointing to +Z, each over a darker seam plate.
function Kit:scutes(bone: BasePart?, cf: CFrame, a: number, b: number, from: number, to: number, n: number, len: number, color: Color3, seam: Color3, vDepth: number?)
	local step = (to - from) / n
	local perim = math.pi * (a + b)
	for j = 0, n - 1 do
		local c = j - (n - 1) / 2
		local th = math.rad(from + (j + 0.5) * step)
		local cs, sn = math.cos(th), math.sin(th)
		local face = cf * CFrame.new(a * cs, b * sn, 0) * CFrame.Angles(0, 0, math.atan2(sn / b, cs / a) - math.pi / 2)
		local pw = perim * step / 360 * 1.1
		local sc = face * CFrame.new(0, 0.12, -math.abs(c) * (vDepth or 0.18) * len) * CFrame.Angles(0, math.rad(math.sign(c) * 7), 0)
		self:part("Scute", Vector3.new(pw, 0.5, len * 0.84), sc, self:vary(color, 0.025), bone)
		self:part("ScuteSeam", Vector3.new(pw * 1.08, 0.3, len * 1.1), face * CFrame.new(0, -0.08, 0), seam, bone)
	end
end

-- ── Faceted stone / bat-wing helpers (added for the Mourngoyle) ─────────────────────────────

-- Picks a colour from a list of shades (e.g. five stone greys, dark to light). light = true
-- biases toward the lighter end. Used by boulder/lump so neighbouring facets differ.
function Kit:shade(shades: { Color3 }, light: boolean?): Color3
	local i = self.rng:NextInteger(1, #shades)
	if light then i = math.min(#shades, i + 2) end
	return shades[i]
end

-- Faceted boulder: a band box with a tapered frustum above and a flipped one below, i.e. an
-- octagonal low-poly rock whose top and bottom facets catch different light. cf: centre, +Y up.
-- shades: a Color3 or a list of shades. opts: taper (0.6) or taperX/taperZ, taperB (extra bottom
-- taper, < 1 = narrower foot), band (vertical fraction of the straight band, 0.4), yaw/tilt
-- (random degrees), light, name. ~11 parts. Good for shoulders, knuckles, feet, tail segments.
function Kit:boulder(bone: BasePart?, cf: CFrame, size: Vector3, shades: any, opts: any?): BasePart
	local o = opts or {}
	local r = self.rng
	local tx, tz = o.taperX or o.taper or 0.6, o.taperZ or o.taper or 0.6
	local tb = o.taperB or 1
	local band = o.band or 0.4
	if o.yaw or o.tilt then
		local t, y = o.tilt or 0, o.yaw or 0
		cf = cf * CFrame.Angles(rad(r:NextNumber(-t, t)), rad(r:NextNumber(-y, y)), rad(r:NextNumber(-t, t)))
	end
	local hb = size.Y * band
	local hs = (size.Y - hb) / 2
	local function c(light: boolean?): Color3
		return if typeof(shades) == "Color3" then self:vary(shades, 0.03) else self:shade(shades, light)
	end
	local nm = o.name or "Rock"
	local core = self:part(nm, Vector3.new(size.X, hb + 0.04, size.Z), cf, c(o.light), bone)
	self:frustum(bone, cf * CFrame.new(0, hb / 2, 0), size.X, size.Z, size.X * tx, size.Z * tz, hs, c(true), nm, c(o.light))
	self:frustum(bone, cf * CFrame.new(0, -hb / 2, 0) * CFrame.Angles(math.pi, 0, 0), size.X, size.Z, size.X * tx * tb, size.Z * tz * tb, hs, c(false), nm, c(false))
	return core
end

-- Rock-chunk limb / mass: a core boulder plus n smaller boulders bulging out of it at random
-- spots and angles, so one body part reads as a cluster of faceted stones rather than a box.
-- opts as boulder, plus bias (Vector3 in cf space) to push bulges toward the faces seen most.
function Kit:lump(bone: BasePart?, cf: CFrame, size: Vector3, n: number?, shades: any, opts: any?): BasePart
	local o = opts or {}
	local r = self.rng
	local core = self:boulder(bone, cf, size * 0.92, shades, o)
	for _ = 1, n or 2 do
		local d = (Vector3.new(r:NextNumber(-1, 1), r:NextNumber(-0.6, 0.8), r:NextNumber(-1, 1)) + (o.bias or Vector3.zero)).Unit
		local off = Vector3.new(d.X * size.X, d.Y * size.Y, d.Z * size.Z) * 0.3
		local bcf = cf * CFrame.new(off) * CFrame.Angles(rad(r:NextNumber(-20, 20)), rad(r:NextNumber(0, 90)), rad(r:NextNumber(-20, 20)))
		self:boulder(bone, bcf, size * r:NextNumber(0.45, 0.6), shades, { taper = r:NextNumber(0.5, 0.7), band = r:NextNumber(0.3, 0.5), light = o.light, name = o.name })
	end
	return core
end

-- Zigzag glow crack: cf sits on a surface with LookVector = outward normal; the crack runs len
-- studs down cf's -Y in n kinks of +-amp (random 55-100%). Draws through Kit:crack in Neon and
-- returns the points, so a branch can start from one of them.
function Kit:zigCrack(bone: BasePart?, cf: CFrame, len: number, amp: number, n: number, width: number, color: Color3, halo: number?): { Vector3 }
	local pts, nrm = {}, {}
	for i = 0, n do
		local x = if i == 0 or i == n then 0 else ((i % 2 == 0) and 1 or -1) * amp * self.rng:NextNumber(0.55, 1)
		pts[#pts + 1] = (cf * CFrame.new(x, -len * i / n, 0)).Position
		nrm[#nrm + 1] = cf.LookVector
	end
	self:with(Enum.Material.Neon, function()
		self:crack(bone, pts, nrm, width, color, halo)
	end)
	return pts
end

-- Flat triangle a, b, c (model-local points) from two WedgeParts, th thick. Any triangle works;
-- use it for membranes, faceted plates and shards that boxes cannot shape. 2 parts.
function Kit:tri(bone: BasePart?, a: Vector3, b: Vector3, c: Vector3, th: number, color: Color3, name: string?)
	local ab, ac, bc = b - a, c - a, c - b
	local abd, acd, bcd = ab:Dot(ab), ac:Dot(ac), bc:Dot(bc)
	if abd > acd and abd > bcd then
		c, a = a, c
	elseif acd > bcd and acd > abd then
		a, b = b, a
	end
	ab, ac, bc = b - a, c - a, c - b
	local right = ac:Cross(ab)
	if right.Magnitude < 1e-4 then return end
	right = right.Unit
	local up = bc:Cross(right).Unit
	local back = bc.Unit
	local height = math.abs(ab:Dot(up))
	self:part(name or "Tri", Vector3.new(th, height, math.abs(ab:Dot(back))), CFrame.fromMatrix((a + b) / 2, right, up, back), color, bone, "WedgePart")
	self:part(name or "Tri", Vector3.new(th, height, math.abs(ac:Dot(back))), CFrame.fromMatrix((a + c) / 2, -right, up, -back), color, bone, "WedgePart")
end

-- Faceted bat-wing membrane: fans triangles from the hub W (the wing's wrist) along the edge
-- polyline `edge` (model-local points running from the leading edge round to the body). Each fan
-- triangle is split into folded facets: its edge-side corner is pushed back by `fold` studs
-- along `foldDir` so neighbouring planes catch light differently. shades: list of dark colours.
-- Add bone spars with Kit:shard / Kit.aim from W to the tips. ~4 parts per edge segment.
function Kit:wingFan(bone: BasePart?, W: Vector3, edge: { Vector3 }, th: number, shades: { Color3 }, fold: number?, foldDir: Vector3?)
	local f = fold or 0.6
	local fd = (foldDir or Vector3.zAxis).Unit
	for i = 1, #edge - 1 do
		local a, b = edge[i], edge[i + 1]
		local m = (a + b) / 2 + fd * f * (if i % 2 == 0 then 1 else -1)
		local mid = W + (m - W) * 0.55
		self:tri(bone, W, a, mid, th, self:shade(shades), "Membrane")
		self:tri(bone, mid, a, m, th, self:shade(shades), "Membrane")
		self:tri(bone, W, mid, b, th, self:shade(shades), "Membrane")
		self:tri(bone, mid, m, b, th, self:shade(shades), "Membrane")
	end
end

-- Curved talon / claw: base at pos, starting along dir, curling `bend` degrees toward `curl`
-- over segs segments (a Kit:horn aimed with Kit.aim). pal = { base, tip }. Use 3-4 per hand,
-- spread a little and curled downward, with w around 35% of len for a chunky gargoyle claw.
function Kit:claw(bone: BasePart, pos: Vector3, dir: Vector3, curl: Vector3, len: number, w: number, bend: number, segs: number?, pal: Palette)
	self:horn(bone, Kit.aim(pos, dir, curl), len, w, w * 0.85, bend, segs or 2, pal)
end

return Kit
