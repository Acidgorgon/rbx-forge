// ForgeFX: the tiny runtime module that plays scripted effects in a real game. The exporter writes it
// once to src/shared/VFX/ForgeFX.luau (Rojo: ReplicatedStorage.Shared.VFX.ForgeFX) and every scripted
// effect module requires it. It exposes the same fx API as the Lab's recorder
// (resources/lune/vfx_timeline.luau), so the timeline script written in Forge is the code that runs
// in game:
//   fx:spawn / emit / enable / disable / tween / set / wait / at / after / now / stage / forward ...
// Real Roblox calls underneath: TweenService:Create (TweenInfo with Enum.EasingStyle / Direction),
// task.wait / task.delay, ParticleEmitter:Emit and Enabled. NumberSequence / ColorSequence are not
// tweenable (TweenService docs), so the virtual SizeScale / Fade / Color tint are driven by a
// NumberValue tween whose Changed signal rewrites the sequences from their authored values.

export const RUNTIME_MODULE = 'ForgeFX'
export const RUNTIME_VERSION = 1
export const RUNTIME_HEADER = '-- ForgeFX runtime for RBX Forge VFX timelines'

// Whether a ForgeFX.luau on disk is ours (safe to update) rather than someone's replacement.
export function isOwnRuntime(src: string): boolean {
  return src.split('\n').slice(0, 3).some((l) => l.startsWith(RUNTIME_HEADER))
}

export const FORGEFX_SOURCE = `--!nonstrict
${RUNTIME_HEADER} (v${RUNTIME_VERSION}).
-- Written by RBX Forge next to your effects; it is rewritten when an effect is saved, so edit the
-- effects' Timeline scripts instead. API (the same in Forge's Script tab):
--   local h = fx:spawn(kind, opts)   rig made in Forge, brought in now (h.Glow = "<Name>Glow")
--   fx:emit(h, n)  fx:enable(h)  fx:disable(h)
--   fx:tween(h, seconds, goals, style?, direction?)  -- TweenService; goals may use SizeScale / Fade
--   fx:set(h, goals)  fx:wait(s)  fx:at(t, fn)  fx:after(dt, fn)  fx:now()  fx:stage(label)
--   fx:forward(d) / fx:right(d) / fx:up(d)   (Vector3 in the effect's space; -Z is forward)
local TweenService = game:GetService("TweenService")

local ForgeFX = {}
ForgeFX.__index = ForgeFX
ForgeFX.Version = ${RUNTIME_VERSION}

-- ------------------------------------------------------------ handles

local Handle = {}
local function handle(name)
	return setmetatable({ __forgeHandle = true, __name = name }, Handle)
end
Handle.__index = function(h, key)
	if type(key) ~= "string" then
		return nil
	end
	return handle(rawget(h, "__name") .. key)
end
Handle.__tostring = function(h)
	return rawget(h, "__name")
end
ForgeFX.handle = handle

local SEQ_LAYERS = { ParticleEmitter = true, Beam = true, Trail = true }
local TOGGLES = { ParticleEmitter = true, Beam = true, Trail = true, PointLight = true, SpotLight = true, SurfaceLight = true, Highlight = true }

function ForgeFX.new(model: Model, options: any?)
	local o = options or {}
	local self = setmetatable({}, ForgeFX)
	self.model = model
	self.root = model.PrimaryPart or model:FindFirstChild("Root")
	self.spawns = o.spawns or {}
	self.onStage = o.onStage
	self.t0 = os.clock()
	self.clocks = {}
	self.counts = {}
	self.virt = {}
	self.base = {}
	self.drivers = {}
	self.alive = true
	self.byName = {}
	for _, d in model:GetDescendants() do
		if self.byName[d.Name] == nil then
			self.byName[d.Name] = d
		end
	end
	return self
end

function ForgeFX:find(target): Instance?
	if typeof(target) == "Instance" then
		return target
	end
	local name = if type(target) == "table" then rawget(target, "__name") else target
	local inst = self.byName[name]
	if not inst then
		warn(("ForgeFX: no instance named %s in %s"):format(tostring(name), self.model.Name))
	end
	return inst
end

-- Instances an action applies to: the target if it can, else its descendants that can.
local function layers(inst: Instance, ok: { [string]: boolean }): { Instance }
	if ok[inst.ClassName] then
		return { inst }
	end
	local out = {}
	for _, d in inst:GetDescendants() do
		if ok[d.ClassName] then
			table.insert(out, d)
		end
	end
	return out
end

-- ------------------------------------------------------------ clock

function ForgeFX:now(): number
	return self.clocks[coroutine.running()] or 0
end

function ForgeFX:wait(seconds: number?): number
	local c = self:now() + math.max(0, seconds or 0)
	self.clocks[coroutine.running()] = c
	local delta = self.t0 + c - os.clock()
	if delta > 0 then
		task.wait(delta)
	end
	return c
end

function ForgeFX:at(t: number, fn: () -> ())
	task.delay(math.max(0, self.t0 + t - os.clock()), function()
		if not self.alive then
			return
		end
		local co = coroutine.running()
		self.clocks[co] = t
		fn()
		self.clocks[co] = nil
	end)
end

function ForgeFX:after(dt: number, fn: () -> ())
	self:at(self:now() + dt, fn)
end

function ForgeFX:forward(d: number?): Vector3
	return Vector3.new(0, 0, -(d or 1))
end

function ForgeFX:right(d: number?): Vector3
	return Vector3.new(d or 1, 0, 0)
end

function ForgeFX:up(d: number?): Vector3
	return Vector3.new(0, d or 1, 0)
end

function ForgeFX:stage(label: string)
	if self.onStage then
		task.spawn(self.onStage, label, self:now())
	end
end

function ForgeFX:duration() end
function ForgeFX:anchor() end

-- ------------------------------------------------------------ actions

function ForgeFX:emit(target, count: number?)
	local inst = self:find(target)
	if not inst then
		return
	end
	for _, e in layers(inst, { ParticleEmitter = true }) do
		(e :: ParticleEmitter):Emit(count or 16)
	end
end

function ForgeFX:enable(target)
	local inst = self:find(target)
	if inst then
		for _, x in layers(inst, TOGGLES) do
			(x :: any).Enabled = true
		end
	end
end

function ForgeFX:disable(target)
	local inst = self:find(target)
	if inst then
		for _, x in layers(inst, TOGGLES) do
			(x :: any).Enabled = false
		end
	end
end

-- Authored values the virtual properties scale (read once, before anything changes them).
function ForgeFX:_base(x: Instance)
	local b = self.base[x]
	if b then
		return b
	end
	b = {}
	local a = x :: any
	if x:IsA("ParticleEmitter") then
		b.Size, b.Transparency, b.Color = a.Size, a.Transparency, a.Color
	elseif x:IsA("Beam") then
		b.Width0, b.Width1, b.Transparency, b.Color = a.Width0, a.Width1, a.Transparency, a.Color
	elseif x:IsA("Trail") then
		b.WidthScale, b.Transparency, b.Color = a.WidthScale, a.Transparency, a.Color
	elseif x:IsA("Light") then
		b.Brightness, b.Range = a.Brightness, a.Range
	elseif x:IsA("BasePart") then
		b.Size, b.Transparency = a.Size, a.Transparency
	elseif x:IsA("Highlight") then
		b.FillTransparency, b.OutlineTransparency = a.FillTransparency, a.OutlineTransparency
	end
	self.base[x] = b
	return b
end

local function scaleSeq(seq: NumberSequence, k: number): NumberSequence
	local keys = {}
	for _, kp in seq.Keypoints do
		table.insert(keys, NumberSequenceKeypoint.new(kp.Time, kp.Value * k, kp.Envelope * k))
	end
	return NumberSequence.new(keys)
end

local function fadeSeq(seq: NumberSequence, f: number): NumberSequence
	local keys = {}
	for _, kp in seq.Keypoints do
		table.insert(keys, NumberSequenceKeypoint.new(kp.Time, 1 - (1 - kp.Value) * (1 - f), kp.Envelope * (1 - f)))
	end
	return NumberSequence.new(keys)
end

local function tintSeq(seq: ColorSequence, c: Color3, a: number): ColorSequence
	local keys = {}
	for _, kp in seq.Keypoints do
		table.insert(keys, ColorSequenceKeypoint.new(kp.Time, kp.Value:Lerp(c, a)))
	end
	return ColorSequence.new(keys)
end

-- Applies SizeScale / Fade (own and every ancestor's) and the tint to one instance.
function ForgeFX:_apply(x: Instance)
	local scale, keep, hasScale, hasFade = 1, 1, false, false
	local cur: Instance? = x
	while cur and cur ~= self.model.Parent do
		local v = self.virt[cur]
		if v then
			if v.SizeScale ~= nil then
				scale *= v.SizeScale
				hasScale = true
			end
			if v.Fade ~= nil then
				keep *= 1 - math.clamp(v.Fade, 0, 1)
				hasFade = true
			end
		end
		cur = cur.Parent
	end
	local fade = 1 - keep
	local tint = self.virt[x] and self.virt[x].tint
	if not hasScale and not hasFade and not tint then
		return
	end
	local b = self:_base(x)
	local a = x :: any
	if x:IsA("ParticleEmitter") then
		if hasScale then a.Size = scaleSeq(b.Size, scale) end
		if hasFade then a.Transparency = fadeSeq(b.Transparency, fade) end
	elseif x:IsA("Beam") then
		if hasScale then
			a.Width0 = b.Width0 * scale
			a.Width1 = b.Width1 * scale
		end
		if hasFade then a.Transparency = fadeSeq(b.Transparency, fade) end
	elseif x:IsA("Trail") then
		if hasScale then a.WidthScale = scaleSeq(b.WidthScale, scale) end
		if hasFade then a.Transparency = fadeSeq(b.Transparency, fade) end
	elseif x:IsA("Light") then
		if hasFade then a.Brightness = b.Brightness * keep end
		if hasScale then a.Range = b.Range * scale end
	elseif x:IsA("BasePart") then
		if hasScale then a.Size = b.Size * scale end
		if hasFade then a.Transparency = 1 - (1 - b.Transparency) * keep end
	elseif x:IsA("Highlight") then
		if hasFade then
			a.FillTransparency = 1 - (1 - b.FillTransparency) * keep
			a.OutlineTransparency = 1 - (1 - b.OutlineTransparency) * keep
		end
	end
	if tint and SEQ_LAYERS[x.ClassName] then
		a.Color = tintSeq(b.Color, tint.color, tint.alpha)
	end
end

function ForgeFX:_applyUnder(inst: Instance)
	self:_apply(inst)
	for _, d in inst:GetDescendants() do
		self:_apply(d)
	end
end

-- Drives fn(alpha) from 0 to 1 with a NumberValue tween (the last driver of a key wins, like
-- TweenService cancelling an older tween of the same property).
function ForgeFX:_drive(inst: Instance, key: string, info: TweenInfo, fn: (number) -> ())
	local drivers = self.drivers[inst] or {}
	self.drivers[inst] = drivers
	local old = drivers[key]
	if old then
		old:Cancel()
	end
	if info.Time <= 0 then
		drivers[key] = nil
		fn(1)
		return
	end
	local value = Instance.new("NumberValue")
	value.Value = 0
	value.Parent = self.model
	value.Changed:Connect(fn)
	local tween = TweenService:Create(value, info, { Value = 1 })
	drivers[key] = tween
	tween.Completed:Connect(function()
		value:Destroy()
	end)
	tween:Play()
end

function ForgeFX:_virtual(inst: Instance, prop: string, goal: number, info: TweenInfo)
	local v = self.virt[inst] or {}
	self.virt[inst] = v
	local from = v[prop] or (if prop == "SizeScale" then 1 else 0)
	self:_drive(inst, prop, info, function(alpha)
		local k = TweenService:GetValue(alpha, info.EasingStyle, info.EasingDirection)
		v[prop] = from + (goal - from) * k
		self:_applyUnder(inst)
	end)
end

function ForgeFX:_tint(inst: Instance, color: Color3, info: TweenInfo)
	for _, x in layers(inst, SEQ_LAYERS) do
		local v = self.virt[x] or {}
		self.virt[x] = v
		local st = v.tint or { color = Color3.new(1, 1, 1), alpha = 0 }
		self:_drive(x, "Color", info, function(alpha)
			local e = TweenService:GetValue(alpha, info.EasingStyle, info.EasingDirection)
			local A = 1 - (1 - st.alpha) * (1 - e)
			if A <= 1e-6 then
				v.tint = { color = color, alpha = 0 }
			else
				local function ch(a: number, c: number): number
					return (a * st.alpha * (1 - e) + c * e) / A
				end
				v.tint = { color = Color3.new(ch(st.color.R, color.R), ch(st.color.G, color.G), ch(st.color.B, color.B)), alpha = A }
			end
			self:_apply(x)
		end)
	end
end

local function easing(enumType, value, fallback)
	if typeof(value) == "EnumItem" then
		return value
	end
	local ok, item = pcall(function()
		return (Enum :: any)[enumType][value or fallback]
	end)
	return if ok and item then item else (Enum :: any)[enumType][fallback]
end

function ForgeFX:tween(target, seconds: number, goals: { [string]: any }, style: any?, direction: any?)
	local inst = self:find(target)
	if not inst then
		return seconds
	end
	local info = TweenInfo.new(math.max(0, seconds), easing("EasingStyle", style, "Quad"), easing("EasingDirection", direction, "Out"))
	local native = {}
	for prop, goal in goals do
		if prop == "SizeScale" or prop == "Fade" then
			self:_virtual(inst, prop, goal, info)
		elseif prop == "Color" and typeof(goal) == "Color3" and SEQ_LAYERS[inst.ClassName] then
			self:_tint(inst, goal, info)
		elseif inst:IsA("BasePart") and (prop == "Position" or prop == "CFrame") and self.root then
			-- Goals are in the effect's space (relative to its root part).
			local rel = self.root.CFrame:ToObjectSpace((inst :: BasePart).CFrame)
			local goalCf = if prop == "CFrame" then goal else CFrame.new(goal) * rel.Rotation
			native.CFrame = self.root.CFrame * goalCf
		else
			native[prop] = goal
		end
	end
	if next(native) then
		if info.Time <= 0 then
			for k, v in native do
				(inst :: any)[k] = v
			end
		else
			TweenService:Create(inst, info, native):Play()
		end
	end
	return seconds
end

function ForgeFX:set(target, goals: { [string]: any })
	self:tween(target, 0, goals)
end

-- One cue of the compiled timeline (CUES / SPAWNS tables in the effect module).
function ForgeFX:cue(c)
	if c.action == "emit" then
		self:emit(c.name, c.count)
	elseif c.action == "enable" then
		self:enable(c.name)
	elseif c.action == "disable" then
		self:disable(c.name)
	elseif c.action == "tween" then
		self:tween(c.name, c.duration or 0, c.goals, c.style, c.direction)
	elseif c.action == "set" then
		self:set(c.name, c.goals)
	end
end

-- State before rigs appear (applied before the model is parented, so nothing pops in).
function ForgeFX:prelude(list)
	for _, c in list do
		self:set(c.name, c.goals)
	end
end

function ForgeFX:spawn(kind: string, opts: any?)
	local name = opts and opts.name
	if not name then
		local key = string.lower(kind)
		self.counts[key] = (self.counts[key] or 0) + 1
		name = string.upper(string.sub(key, 1, 1)) .. string.sub(key, 2) .. self.counts[key]
	end
	local start = self:now()
	for _, c in self.spawns[name] or {} do
		if c.dt <= 0 then
			self:cue(c)
		else
			self:at(start + c.dt, function()
				self:cue(c)
			end)
		end
	end
	return handle(name)
end

-- Runs a timeline function (the effect's Timeline module) on its own thread.
function ForgeFX:run(timeline: (any) -> ())
	task.spawn(function()
		self.clocks[coroutine.running()] = 0
		local ok, err = pcall(timeline, self)
		if not ok then
			warn("ForgeFX timeline error in " .. self.model.Name .. ": " .. tostring(err))
		end
	end)
end

-- Plays a compiled cue list instead (no Timeline module).
function ForgeFX:runCues(cues, stages)
	for _, c in cues do
		self:at(c.at, function()
			self:cue(c)
		end)
	end
	for _, s in stages or {} do
		self:at(s.at, function()
			self:stage(s.label)
		end)
	end
end

function ForgeFX:stop()
	self.alive = false
	for _, drivers in self.drivers do
		for _, t in drivers do
			t:Cancel()
		end
	end
end

return ForgeFX
`
