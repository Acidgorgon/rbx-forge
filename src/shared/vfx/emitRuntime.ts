// ForgeVFX: the runtime module that plays attribute-driven effects (docs/vfx-emit.md). An effect is
// plain instances + attributes built in Studio; ForgeVFX.emit(template, at?, options?) clones it,
// places it, times every layer from its attributes (EmitDelay / EmitCount / EmitDuration / Rate /
// FadeOut), animates Start/End mesh effects and cleans up. Forge writes it to
// src/shared/VFX/ForgeVFX.luau (Rojo: ReplicatedStorage.Shared.VFX.ForgeVFX) next to ForgeFX.luau,
// only over a file whose header says it is ours. The Studio "Play selection" job (emitStudio.ts)
// ships the same source.
//
// The timing rules mirror the Lab preview's plan (emitPlan.ts) and cuesFromAttributes (analyze.ts):
//   - EmitDelay is summed down the tree (clamped 0..30); every other attribute is the node's own
//     value, else its nearest ancestor's. Numeric strings count as numbers.
//   - ParticleEmitter: exactly cuesFromAttributes (uses the emitter's Rate property).
//   - Beam / Trail / lights / Highlight: off until the delay, on for EmitDuration (open windows stay
//     on until the effect ends and make it last at least 1 s past their start); FadeOut ramps the
//     transparency / brightness to invisible over the window's last FadeOut seconds (linear).
//   - Mesh effect (Model / Folder with BasePart children Start and End): copies of Start animate to
//     End over their Lifetime; spawn times from EmitCount / EmitDuration / Rate; per copy random
//     values drawn in the order lifetime, spreadX, spreadY, rotX, rotY, rotZ. Children of Start ride
//     along with their own attribute timing (inheritance restarts at Start), relative to the copy's
//     spawn; "until the end" for them is the copy's death.
// One RunService.Heartbeat connection steps every active play (cues, mesh copies, fades, follow).
// NumberSequences are not tweenable, so Beam / Trail FadeOut rewrites Transparency from the
// authored sequence every step.
//
// The Luau below lives in a template literal: no backticks, no "${"-sequences and no backslashes.

import { PART_CLASSES } from './schema.ts'
import type { VfxNode } from './types.ts'

export const EMIT_RUNTIME_MODULE = 'ForgeVFX'
export const FORGEVFX_MODULE = EMIT_RUNTIME_MODULE
export const EMIT_RUNTIME_VERSION = 1
export const EMIT_RUNTIME_HEADER = '-- ForgeVFX runtime for RBX Forge attribute-driven effects'

// Whether an effect is attribute-driven (it wants ForgeVFX next to it in the project): a node with
// emit attributes, or a mesh effect (Model / Folder with BaseParts Start and End).
const EMIT_ATTRS = ['EmitDelay', 'EmitCount', 'EmitDuration', 'FadeOut']
export function usesEmitAttributes(roots: VfxNode[]): boolean {
  const visit = (n: VfxNode): boolean => {
    if (n.attrs && EMIT_ATTRS.some((k) => n.attrs![k] !== undefined)) return true
    if ((n.className === 'Model' || n.className === 'Folder') && ['Start', 'End'].every((name) => n.children.some((c) => c.name === name && PART_CLASSES.has(c.className)))) return true
    return n.children.some(visit)
  }
  return roots.some(visit)
}

// Whether a ForgeVFX.luau on disk is ours (safe to update) rather than someone's replacement.
export function isOwnEmitRuntime(src: string): boolean {
  return src.split('\n').slice(0, 3).some((l) => l.startsWith(EMIT_RUNTIME_HEADER))
}

export const FORGEVFX_SOURCE = `--!nonstrict
${EMIT_RUNTIME_HEADER} (v${EMIT_RUNTIME_VERSION}).
-- Written by RBX Forge; it is rewritten when Forge updates it, so put your own changes in another module.
-- Build an effect in Studio as plain instances + attributes, then play it with one call:
--   local ForgeVFX = require(ReplicatedStorage.Shared.VFX.ForgeVFX)
--   ForgeVFX.init()                                  -- optional: shared.ForgeVFX + Workspace.ForgeVFX
--   local e = ForgeVFX.emit(template, at, options)   -- at: CFrame | BasePart | Attachment | Model | nil
--   e.Finished:Wait()   e.Finished:Connect(fn)   e:Stop()   e.Duration   e.Instance
--   ForgeVFX.stopAll()
-- options: parent (default Workspace.ForgeVFX), follow (default true), offset (CFrame), duration (s).
-- Attributes (seconds; EmitDelay adds up down the tree, the others inherit from the nearest ancestor):
--   EmitDelay, EmitDuration, EmitCount, Rate (mesh effects), FadeOut (beams, trails, lights).
-- Mesh effect: a Model / Folder with BaseParts "Start" and "End"; attributes on it: Lifetime
-- (NumberRange), Ease / EaseCFrame / EaseSize / EaseTransparency / EaseColor ("Quad.Out" or a
-- NumberSequence curve), SpreadAngle (Vector2), MinInitRot / MaxInitRot / Spin (Vector3, degrees),
-- SyncPosition (boolean); the same strings / numbers the VFX Lab accepts work too. See
-- docs/vfx-emit.md in RBX Forge.
local RunService = game:GetService("RunService")
local TweenService = game:GetService("TweenService")

local ForgeVFX = {}
ForgeVFX.Version = ${EMIT_RUNTIME_VERSION}
ForgeVFX.FolderName = "ForgeVFX"

local MAX_DELAY = 30
local MAX_WINDOW = 30
local MAX_COPIES = 200
local DEFAULT_LIFETIME = 0.5
local DEFAULT_DURATION = 1
local OPEN_MIN = 1
local TOGGLES = { Beam = true, Trail = true, PointLight = true, SpotLight = true, SurfaceLight = true, Highlight = true }

local rng = Random.new()
local active = {}
local stepConn = nil

-- ------------------------------------------------------------ small helpers

local function jsRound(x: number): number
	return math.floor(x + 0.5)
end

local function finite(n: number?): boolean
	return n ~= nil and n == n and n ~= math.huge and n ~= -math.huge
end

-- A number attribute (numeric strings count), else nil.
local function num(inst: Instance, name: string): number?
	local v = inst:GetAttribute(name)
	if type(v) == "number" then
		if finite(v) then
			return v
		end
		return nil
	end
	if type(v) == "string" then
		local s = string.match(v, "^%s*(.-)%s*$")
		if s and s ~= "" then
			local n = tonumber(s)
			if finite(n) then
				return n
			end
		end
	end
	return nil
end

local function lerp(a: number, b: number, k: number): number
	return a + (b - a) * k
end

local function lerpV3(a: Vector3, b: Vector3, k: number): Vector3
	return a + (b - a) * k
end

-- CFrame lerp that also extrapolates (custom curves may go below 0 / above 1).
local function lerpCF(a: CFrame, b: CFrame, k: number): CFrame
	if k >= 0 and k <= 1 then
		return a:Lerp(b, k)
	end
	local pos = a.Position + (b.Position - a.Position) * k
	local ra = a.Rotation
	local axis, angle = (ra:Inverse() * b.Rotation):ToAxisAngle()
	local rot = ra
	if math.abs(angle) > 1e-6 then
		rot = ra * CFrame.fromAxisAngle(axis, angle * k)
	end
	return CFrame.new(pos) * rot
end

local function fadeSeq(seq: NumberSequence, k: number): NumberSequence
	local keys = {}
	for _, kp in seq.Keypoints do
		table.insert(keys, NumberSequenceKeypoint.new(kp.Time, 1 - (1 - kp.Value) * (1 - k), kp.Envelope * (1 - k)))
	end
	return NumberSequence.new(keys)
end

-- ------------------------------------------------------------ easing

-- The names emitPlan.ts knows (EASING_STYLES / EASING_DIRECTIONS), by lower-case name.
local STYLES = {}
for _, name in { "Linear", "Sine", "Back", "Quad", "Quart", "Quint", "Bounce", "Elastic", "Exponential", "Circular", "Cubic" } do
	STYLES[string.lower(name)] = Enum.EasingStyle[name]
end
local DIRECTIONS = { ["in"] = Enum.EasingDirection.In, out = Enum.EasingDirection.Out, inout = Enum.EasingDirection.InOut }

local function easeFn(style: Enum.EasingStyle, direction: Enum.EasingDirection): (number) -> number
	return function(a: number): number
		return TweenService:GetValue(math.clamp(a, 0, 1), style, direction)
	end
end

local QUAD_OUT = easeFn(Enum.EasingStyle.Quad, Enum.EasingDirection.Out)

-- An ease string, read like emitPlan.ts parseEase: "Quad.Out", "Quad" (Out), "QuadOut", "Back InOut",
-- "quad_in", "Sine/In", "Enum.EasingStyle.Back.InOut"; names in any case. Empty or unknown -> fallback.
local function easeFromString(text: string, fallback: (number) -> number): (number) -> number
	local s = string.match(text, "^%s*(.-)%s*$") or ""
	if string.lower(string.sub(s, 1, 17)) == "enum.easingstyle." then
		s = string.sub(s, 18)
	end
	-- A trailing In / Out / InOut right after a lower-case letter starts the direction (QuadOut).
	local cuts = {}
	for _, suffix in { "In", "Out", "InOut" } do
		local at = #s - #suffix + 1
		if at > 1 and string.sub(s, at) == suffix and string.match(string.sub(s, at - 1, at - 1), "%l") then
			table.insert(cuts, at)
		end
	end
	-- (cuts are in descending order, so each insert leaves the earlier positions in place)
	for _, at in cuts do
		s = string.sub(s, 1, at - 1) .. "." .. string.sub(s, at)
	end
	-- Parts split on . space _ / -; the first is the style, the rest joined is the direction.
	local parts = {}
	for part in string.gmatch(s, "[^%.%s_/%-]+") do
		table.insert(parts, part)
	end
	local style = STYLES[string.lower(parts[1] or "")]
	if not style then
		return fallback
	end
	local dir = string.lower(table.concat(parts, "", 2))
	local direction = if dir == "" then Enum.EasingDirection.Out else DIRECTIONS[dir]
	if not direction then
		return fallback
	end
	return easeFn(style, direction)
end

-- A NumberSequence curve: time 0..1 -> progress (piecewise linear, envelope ignored).
local function easeFromSequence(seq: NumberSequence): (number) -> number
	local kps = seq.Keypoints
	return function(a: number): number
		if a <= kps[1].Time then
			return kps[1].Value
		end
		for i = 2, #kps do
			local k1 = kps[i]
			if a <= k1.Time then
				local k0 = kps[i - 1]
				local span = k1.Time - k0.Time
				if span <= 0 then
					return k1.Value
				end
				return k0.Value + (k1.Value - k0.Value) * (a - k0.Time) / span
			end
		end
		return kps[#kps].Value
	end
end

-- Ease / Ease* attribute: a string (easeFromString) or a NumberSequence curve; anything else, or an
-- empty / unknown string (a new string attribute in Studio is ""), -> fallback.
local function easeOf(inst: Instance, name: string, fallback: (number) -> number): (number) -> number
	local v = inst:GetAttribute(name)
	if type(v) == "string" then
		return easeFromString(v, fallback)
	elseif typeof(v) == "NumberSequence" then
		return easeFromSequence(v)
	end
	return fallback
end

-- ------------------------------------------------------------ Finished signal

local Signal = {}
Signal.__index = Signal

local function newSignal()
	return setmetatable({ _handlers = {}, _waiting = {}, _fired = false }, Signal)
end

function Signal:Connect(fn: () -> ())
	local entry = { fn = fn, connected = true }
	if self._fired then
		entry.connected = false
		task.spawn(fn)
	else
		table.insert(self._handlers, entry)
	end
	return {
		Disconnect = function(_)
			entry.connected = false
		end,
	}
end

Signal.Once = Signal.Connect

function Signal:Wait()
	if self._fired then
		return
	end
	table.insert(self._waiting, coroutine.running())
	coroutine.yield()
end

function Signal:_fire()
	if self._fired then
		return
	end
	self._fired = true
	local handlers, waiting = self._handlers, self._waiting
	self._handlers, self._waiting = {}, {}
	for _, h in handlers do
		if h.connected then
			task.spawn(h.fn)
		end
	end
	for _, co in waiting do
		-- A waiter cancelled meanwhile (task.cancel) is dead and cannot be resumed: skip it.
		if coroutine.status(co) == "suspended" then
			task.spawn(co)
		end
	end
end

-- ------------------------------------------------------------ instances

local function stripScripts(root: Instance)
	for _, d in root:GetDescendants() do
		if d:IsA("LuaSourceContainer") then
			d:Destroy()
		end
	end
end

local function prepPart(p: BasePart)
	p.Anchored = true
	p.CanCollide = false
	p.CanQuery = false
	p.CanTouch = false
end

local function prepParts(root: Instance)
	if root:IsA("BasePart") then
		prepPart(root)
	end
	for _, d in root:GetDescendants() do
		if d:IsA("BasePart") then
			prepPart(d)
		end
	end
end

local function defaultParent(): Instance
	local f = workspace:FindFirstChild(ForgeVFX.FolderName)
	if not f then
		f = Instance.new("Folder")
		f.Name = ForgeVFX.FolderName
		f.Parent = workspace
	end
	return f
end

-- The clone as something with a pivot: Models and parts as they are; an Attachment goes into an
-- invisible part where the template was; a Folder (or anything else) into a Model.
local function holderFor(clone: Instance, template: Instance): PVInstance
	if clone:IsA("PVInstance") then
		return clone
	end
	if clone:IsA("Attachment") then
		local p = Instance.new("Part")
		p.Name = clone.Name
		p.Transparency = 1
		p.Size = Vector3.new(0.2, 0.2, 0.2)
		p.CFrame = (template :: Attachment).WorldCFrame
		prepPart(p)
		local att = clone :: any
		att.CFrame = CFrame.new()
		att.Parent = p
		return p
	end
	local m = Instance.new("Model")
	m.Name = clone.Name
	clone.Parent = m
	local ok, cf = pcall(function()
		return (m:GetBoundingBox())
	end)
	m.WorldPivot = if ok and typeof(cf) == "CFrame" then CFrame.new(cf.Position) else CFrame.new()
	return m
end

local function meshPair(inst: Instance): (BasePart?, BasePart?)
	local s = inst:FindFirstChild("Start")
	local e = inst:FindFirstChild("End")
	if s and e and s:IsA("BasePart") and e:IsA("BasePart") then
		return s, e
	end
	return nil, nil
end

-- ------------------------------------------------------------ plan / scopes
--
-- A scope is the top-level effect (base 0) or one mesh copy (base = its spawn time). Times inside
-- a scope are relative to its base; cues are stored with absolute play times.

local ROOT_CTX = { delay = 0, timed = false }

local function childCtx(inst: Instance, parent)
	local ctx = {
		delay = parent.delay,
		count = parent.count,
		duration = parent.duration,
		rate = parent.rate,
		fade = parent.fade,
		timed = parent.timed,
	}
	local d = num(inst, "EmitDelay")
	if d ~= nil then
		ctx.delay += d
		ctx.timed = true
	end
	local c = num(inst, "EmitCount")
	if c ~= nil then
		ctx.count = c
		ctx.timed = true
	end
	local du = num(inst, "EmitDuration")
	if du ~= nil then
		ctx.duration = du
		ctx.timed = true
	end
	local r = num(inst, "Rate")
	if r ~= nil then
		ctx.rate = r
	end
	local f = num(inst, "FadeOut")
	if f ~= nil then
		ctx.fade = f
	end
	return ctx
end

local function clampDelay(d: number): number
	return math.clamp(d, 0, MAX_DELAY)
end

local function windowOf(ctx): number?
	if ctx.duration and ctx.duration > 0 then
		return math.min(MAX_WINDOW, ctx.duration)
	end
	return nil
end

local function newScope(run, base: number, copy)
	local scope = {
		run = run,
		base = base,
		copy = copy,
		dead = false,
		-- every ParticleEmitter / toggle layer the scope switches off at its end
		layers = {},
		-- top level only: layers without attributes, left as authored until clean-up (Stop switches
		-- them off; the plan neither ends them at Duration nor counts them in linger)
		free = {},
		-- latest window start / explicit window end / last emission (relative)
		endT = 0,
		-- latest end of particles / trail segments from explicit windows (relative)
		lingerT = 0,
		-- longest particle / trail lifetime of layers that stay on until the scope ends
		openLinger = 0,
		-- an Enabled layer without attributes (Duration fallback)
		hasOpen = false,
		-- fades of open windows (they end where the scope ends)
		untilEnd = {},
		frame = nil,
	}
	table.insert(run.scopes, scope)
	return scope
end

-- run.cues stays sorted latest first (equal times: newest first), so the next cue is always the
-- last entry (fireDue pops it).
local function cue(scope, t: number, fn: () -> ())
	local list = scope.run.cues
	local at = scope.base + t
	local lo, hi = 1, #list + 1
	while lo < hi do
		local mid = (lo + hi) // 2
		if list[mid].t > at then
			lo = mid + 1
		else
			hi = mid
		end
	end
	table.insert(list, lo, { t = at, fn = fn, scope = scope })
end

local function fadeBase(x: Instance)
	if x:IsA("Beam") or x:IsA("Trail") then
		return { seq = (x :: any).Transparency }
	elseif x:IsA("Light") then
		return { brightness = (x :: any).Brightness }
	elseif x:IsA("Highlight") then
		return { fill = x.FillTransparency, outline = x.OutlineTransparency }
	end
	return {}
end

local function applyFade(x: Instance, base, k: number)
	if x:IsA("Beam") or x:IsA("Trail") then
		(x :: any).Transparency = fadeSeq(base.seq, k)
	elseif x:IsA("Light") then
		(x :: any).Brightness = base.brightness * (1 - k)
	elseif x:IsA("Highlight") then
		x.FillTransparency = 1 - (1 - base.fill) * (1 - k)
		x.OutlineTransparency = 1 - (1 - base.outline) * (1 - k)
	end
end

local function scheduleFade(scope, x: Instance, base, from: number, to: number)
	table.insert(scope.run.fades, { x = x, base = base, t0 = scope.base + from, t1 = scope.base + to, scope = scope })
end

local function emitAt(scope, pe: ParticleEmitter, t: number, n: number)
	cue(scope, t, function()
		pe:Emit(n)
	end)
end

-- Where a scope's events stop (relative): a mesh copy's death (later cues are dropped, like the
-- plan's c.at <= death); the top level has no such limit (its cues all lie within Duration).
local function stopOf(scope): number
	return if scope.copy then scope.copy.life else math.huge
end

-- A layer without attributes: in a mesh copy it keeps its authored state until the copy's death;
-- at the top level it is left as authored until clean-up (not ended at Duration, no linger).
local function untimedLayer(scope, x: Instance)
	if scope.copy then
		table.insert(scope.layers, x)
	else
		table.insert(scope.free, x)
	end
	if (x :: any).Enabled then
		scope.hasOpen = true
	end
end

-- ParticleEmitter: identical to cuesFromAttributes (analyze.ts).
local function particleLayer(scope, pe: ParticleEmitter, ctx)
	local life = pe.Lifetime.Max
	if not ctx.timed then
		untimedLayer(scope, pe)
		if scope.copy and pe.Enabled and pe.Rate > 0 then
			scope.openLinger = math.max(scope.openLinger, life)
		end
		return
	end
	table.insert(scope.layers, pe)
	pe.Enabled = false
	local delay = clampDelay(ctx.delay)
	local rate = pe.Rate
	local count = if ctx.count ~= nil then math.clamp(jsRound(ctx.count), 0, 10000) else nil
	local dur = windowOf(ctx)
	local stop = stopOf(scope)
	-- last: the latest scheduled point (Duration); lastEmit: the latest emission up to stop (linger).
	-- Nothing scheduled (EmitCount 0 without a window) leaves both nil.
	local last, lastEmit = nil, nil
	if dur and rate <= 0 and count and count > 0 then
		-- Spread EmitCount over EmitDuration (at most 60 steps).
		local steps = math.max(1, math.min(60, count, jsRound(dur * 30)))
		local sent = 0
		for i = 0, steps - 1 do
			local want = jsRound((i + 1) * count / steps)
			if want > sent then
				local t = delay + i * dur / steps
				emitAt(scope, pe, t, want - sent)
				last = t
				if t <= stop then
					lastEmit = t
				end
			end
			sent = want
		end
	else
		if count and count > 0 then
			emitAt(scope, pe, delay, count)
			last = delay
			if delay <= stop then
				lastEmit = delay
			end
		end
		if dur then
			cue(scope, delay, function()
				pe.Enabled = true
			end)
			cue(scope, delay + dur, function()
				pe.Enabled = false
			end)
			last = delay + dur
			-- Rate > 0 emits all window long; in a mesh copy the window ends at the copy's death.
			if rate > 0 and delay < stop then
				lastEmit = math.min(delay + dur, stop)
			end
		elseif count == nil then
			-- Only a delay: a default burst (like Emit() with no count).
			emitAt(scope, pe, delay, math.max(8, jsRound(rate * 0.25)))
			last = delay
			if delay <= stop then
				lastEmit = delay
			end
		end
	end
	if last ~= nil then
		scope.endT = math.max(scope.endT, last)
	end
	if lastEmit ~= nil then
		scope.lingerT = math.max(scope.lingerT, lastEmit + life)
	end
end

-- Beam / Trail / lights / Highlight: off until the delay, on for the window, FadeOut at its end.
local function toggleLayer(scope, x: Instance, ctx)
	local a = x :: any
	local fade = if ctx.fade and ctx.fade > 0 then ctx.fade else nil
	local isTrail = x:IsA("Trail")
	if not ctx.timed and not fade then
		untimedLayer(scope, x)
		if scope.copy and isTrail and a.Enabled then
			scope.openLinger = math.max(scope.openLinger, a.Lifetime)
		end
		return
	end
	table.insert(scope.layers, x)
	local base = if fade then fadeBase(x) else nil
	local delay = clampDelay(ctx.delay)
	local dur = windowOf(ctx)
	local stop = stopOf(scope)
	if a.Enabled and (delay > 0 or dur) then
		a.Enabled = false
	end
	cue(scope, delay, function()
		a.Enabled = true
	end)
	if dur then
		cue(scope, delay + dur, function()
			a.Enabled = false
		end)
		scope.endT = math.max(scope.endT, delay + dur)
		-- In a mesh copy the window ends at the copy's death at the latest (trail tail, fade ramp).
		local wEnd = math.min(delay + dur, stop)
		if wEnd > delay then
			if isTrail then
				scope.lingerT = math.max(scope.lingerT, wEnd + a.Lifetime)
			end
			if fade then
				scheduleFade(scope, x, base, math.max(delay, wEnd - fade), wEnd)
			end
		end
	else
		-- Open window: on until the scope ends (top level: at least OPEN_MIN past its start).
		scope.endT = math.max(scope.endT, delay)
		if scope.copy == nil then
			scope.endT = math.max(scope.endT, delay + OPEN_MIN)
		end
		if isTrail and delay < stop then
			scope.openLinger = math.max(scope.openLinger, a.Lifetime)
		end
		if fade then
			table.insert(scope.untilEnd, { x = x, base = base, from = delay, fade = fade })
		end
	end
end

-- The scope ends at endRel: open fades get their ramps; returns the linger after it.
local function finishScope(scope, endRel: number): number
	for _, f in scope.untilEnd do
		if endRel > f.from then
			scheduleFade(scope, f.x, f.base, math.max(f.from, endRel - f.fade), endRel)
		end
	end
	scope.untilEnd = {}
	return math.max(0, scope.lingerT - endRel, scope.openLinger)
end

local function disableLayers(scope)
	for _, x in scope.layers do
		(x :: any).Enabled = false
	end
end

-- ------------------------------------------------------------ mesh effects

-- The numbers in an array-like attribute value, read like emitPlan.ts numbersOf: NumberRange (Min,
-- Max), Vector2 / Vector3 / Color3 components (non-finite -> 0), a "a b" / "a, b, c" string (all
-- numbers) or one number; else nil.
local function numbersOf(v: any): { number }?
	local kind = typeof(v)
	local out
	if kind == "NumberRange" then
		out = { v.Min, v.Max }
	elseif kind == "Vector2" then
		out = { v.X, v.Y }
	elseif kind == "Vector3" then
		out = { v.X, v.Y, v.Z }
	elseif kind == "Color3" then
		out = { v.R, v.G, v.B }
	elseif kind == "number" then
		return if finite(v) then { v } else nil
	elseif kind == "string" then
		local list = {}
		for part in string.gmatch(v, "[^%s,]+") do
			local n = tonumber(part)
			if not finite(n) then
				return nil
			end
			table.insert(list, n)
		end
		return if #list > 0 then list else nil
	else
		return nil
	end
	for i, x in out do
		if not finite(x) then
			out[i] = 0
		end
	end
	return out
end

-- Vector attribute (emitPlan.ts attrVec): numbersOf's forms except a lone number; missing
-- components are 0. Returns { x, y, z } or nil.
local function vecAttr(inst: Instance, name: string): { number }?
	local v = inst:GetAttribute(name)
	if type(v) == "number" then
		return nil
	end
	local n = numbersOf(v)
	if not n then
		return nil
	end
	return { n[1] or 0, n[2] or 0, n[3] or 0 }
end

local function vec3Attr(inst: Instance, name: string): Vector3
	local n = vecAttr(inst, name)
	if n then
		return Vector3.new(n[1], n[2], n[3])
	end
	return Vector3.zero
end

-- Boolean attribute (emitPlan.ts attrBool): a boolean, a number (not 0 = true), or the string
-- true / yes / 1 / false / no / 0 (any case); else nil.
local function boolAttr(inst: Instance, name: string): boolean?
	local v = inst:GetAttribute(name)
	if type(v) == "boolean" then
		return v
	elseif type(v) == "number" then
		return v ~= 0
	elseif type(v) == "string" then
		local s = string.lower(string.match(v, "^%s*(.-)%s*$") or "")
		if s == "true" or s == "yes" or s == "1" then
			return true
		elseif s == "false" or s == "no" or s == "0" then
			return false
		end
	end
	return nil
end

-- Lifetime (emitPlan.ts attrRange): a NumberRange, a number (both ends), "min max", or a vector's
-- first two numbers; ends sorted and at least 0.
local function lifetimeRange(inst: Instance): (number, number)
	local n = numbersOf(inst:GetAttribute("Lifetime"))
	if not n then
		return DEFAULT_LIFETIME, DEFAULT_LIFETIME
	end
	local a = n[1]
	local b = if #n > 1 then n[2] else n[1]
	return math.max(0, math.min(a, b)), math.max(0, a, b)
end

local function meshSpec(container: Instance, s: BasePart, e: BasePart)
	local default = easeOf(container, "Ease", QUAD_OUT)
	local spread = vecAttr(container, "SpreadAngle")
	local spin = vec3Attr(container, "Spin")
	local spec = {
		start = s,
		startCF = s.CFrame,
		endCF = e.CFrame,
		pivot = CFrame.new(s.Position),
		size0 = s.Size,
		size1 = e.Size,
		t0 = s.Transparency,
		t1 = e.Transparency,
		c0 = s.Color,
		c1 = e.Color,
		easeCF = easeOf(container, "EaseCFrame", default),
		easeSize = easeOf(container, "EaseSize", default),
		easeT = easeOf(container, "EaseTransparency", default),
		easeColor = easeOf(container, "EaseColor", default),
		spreadX = if spread then math.abs(spread[1]) else 0,
		spreadY = if spread then math.abs(spread[2]) else 0,
		rot0 = vec3Attr(container, "MinInitRot"),
		rot1 = vec3Attr(container, "MaxInitRot"),
		spin = if spin.Magnitude > 0 then spin else nil,
		sync = boolAttr(container, "SyncPosition") == true,
		mesh = nil,
		decals = {},
	}
	local m0 = s:FindFirstChildOfClass("SpecialMesh")
	local m1 = e:FindFirstChildOfClass("SpecialMesh")
	if m0 and m1 then
		spec.mesh = {
			scale0 = m0.Scale,
			scale1 = m1.Scale,
			offset0 = m0.Offset,
			offset1 = m1.Offset,
			vc0 = m0.VertexColor,
			vc1 = m1.VertexColor,
		}
	end
	-- Decals / Textures with the same name under both parts (Texture is a Decal).
	for _, d0 in s:GetChildren() do
		if d0:IsA("Decal") and s:FindFirstChild(d0.Name) == d0 then
			local d1 = e:FindFirstChild(d0.Name)
			if d1 and d1:IsA("Decal") then
				table.insert(spec.decals, { name = d0.Name, t0 = d0.Transparency, t1 = d1.Transparency, c0 = d0.Color3, c1 = d1.Color3 })
			end
		end
	end
	return spec
end

local function applyCopy(copy, age: number, M: CFrame)
	local spec = copy.spec
	local inst = copy.inst
	local a = math.clamp(age / copy.life, 0, 1)
	local kc = spec.easeCF(a)
	local ks = spec.easeSize(a)
	local kt = spec.easeT(a)
	local kk = spec.easeColor(a)
	local rel = copy.pre * lerpCF(spec.startCF, spec.endCF, kc)
	if spec.spin then
		local sp = spec.spin
		rel = rel * CFrame.Angles(math.rad(sp.X * age), math.rad(sp.Y * age), math.rad(sp.Z * age))
	end
	copy.rel = rel
	local size = lerpV3(spec.size0, spec.size1, ks)
	inst.Size = Vector3.new(math.max(size.X, 0.001), math.max(size.Y, 0.001), math.max(size.Z, 0.001))
	inst.CFrame = M * rel
	inst.Transparency = math.clamp(lerp(spec.t0, spec.t1, kt), 0, 1)
	inst.Color = Color3.new(
		math.clamp(lerp(spec.c0.R, spec.c1.R, kk), 0, 1),
		math.clamp(lerp(spec.c0.G, spec.c1.G, kk), 0, 1),
		math.clamp(lerp(spec.c0.B, spec.c1.B, kk), 0, 1)
	)
	if spec.mesh and copy.mesh then
		local m = spec.mesh
		copy.mesh.Scale = lerpV3(m.scale0, m.scale1, ks)
		copy.mesh.Offset = lerpV3(m.offset0, m.offset1, kc)
		copy.mesh.VertexColor = lerpV3(m.vc0, m.vc1, kk)
	end
	for _, pair in copy.decals do
		local d, p = pair.inst, pair.spec
		d.Transparency = math.clamp(lerp(p.t0, p.t1, kt), 0, 1)
		d.Color3 = Color3.new(lerp(p.c0.R, p.c1.R, kk), lerp(p.c0.G, p.c1.G, kk), lerp(p.c0.B, p.c1.B, kk))
	end
end

local walk

-- A copy's death: hidden, its riding layers off; destroyed once their particles are gone.
local function killCopy(copy)
	copy.dead = true
	copy.scope.dead = true
	copy.inst.Transparency = 1
	for _, d in copy.inst:GetChildren() do
		if d:IsA("Decal") then
			d.Transparency = 1
		end
	end
	disableLayers(copy.scope)
end

local function spawnCopy(run, copy)
	local spec = copy.spec
	local inst = spec.start:Clone()
	if not inst then
		return
	end
	stripScripts(inst)
	copy.inst = inst
	copy.mesh = if spec.mesh then inst:FindFirstChildOfClass("SpecialMesh") else nil
	copy.decals = {}
	for _, p in spec.decals do
		local d = inst:FindFirstChild(p.name)
		if d and d:IsA("Decal") then
			table.insert(copy.decals, { inst = d, spec = p })
		end
	end
	copy.M = copy.frame()
	applyCopy(copy, 0, copy.M)
	local scope = newScope(run, copy.born, copy)
	copy.scope = scope
	scope.frame = function()
		return inst.CFrame * spec.startCF:Inverse()
	end
	-- Riding children: inheritance restarts at Start (its own attributes apply).
	walk(scope, inst, ROOT_CTX)
	local linger = finishScope(scope, copy.life)
	copy.removeAt = copy.born + copy.life + linger
	inst.Parent = copy.parent
	table.insert(run.copies, copy)
end

-- Spawn times (relative): D > 0 and Rate > 0: a burst of c at d + k / Rate while k / Rate < D;
-- D > 0: c copies spread over D; else c copies at d. At most MAX_COPIES.
local function spawnTimes(ctx): { number }
	local c = math.clamp(jsRound(if ctx.count ~= nil then ctx.count else 1), 0, MAX_COPIES)
	local d = clampDelay(ctx.delay)
	local D = windowOf(ctx)
	local r = math.max(0, ctx.rate or 0)
	local times = {}
	if c <= 0 then
		return times
	end
	if D and r > 0 then
		local k = 0
		while k / r < D and #times < MAX_COPIES do
			for _ = 1, c do
				if #times >= MAX_COPIES then
					break
				end
				table.insert(times, d + k / r)
			end
			k += 1
		end
	elseif D then
		for i = 0, c - 1 do
			table.insert(times, d + i * D / c)
		end
	else
		for _ = 1, c do
			table.insert(times, d)
		end
	end
	return times
end

local function meshLayer(scope, container: Instance, s: BasePart, e: BasePart, ctx)
	local run = scope.run
	-- Start and End are never shown: they leave the clone and stay as templates.
	s.Parent = nil
	e.Parent = nil
	prepParts(s)
	local spec = meshSpec(container, s, e)
	local lo, hi = lifetimeRange(container)
	local times = spawnTimes(ctx)
	-- Duration counts the copies' deaths only (EmitCount 0: nothing, like the plan).
	for _, t in times do
		-- Random values drawn in a fixed order: lifetime, spreadX, spreadY, rotX, rotY, rotZ.
		local life = math.max(0.01, lo + (hi - lo) * rng:NextNumber())
		local sx = (rng:NextNumber() * 2 - 1) * spec.spreadX
		local sy = (rng:NextNumber() * 2 - 1) * spec.spreadY
		local rx = spec.rot0.X + (spec.rot1.X - spec.rot0.X) * rng:NextNumber()
		local ry = spec.rot0.Y + (spec.rot1.Y - spec.rot0.Y) * rng:NextNumber()
		local rz = spec.rot0.Z + (spec.rot1.Z - spec.rot0.Z) * rng:NextNumber()
		local pre = spec.pivot
			* CFrame.Angles(math.rad(sx), math.rad(sy), 0)
			* CFrame.Angles(math.rad(rx), math.rad(ry), math.rad(rz))
			* spec.pivot:Inverse()
		local copy = {
			spec = spec,
			life = life,
			pre = pre,
			born = scope.base + t,
			parent = container,
			frame = scope.frame,
			dead = false,
		}
		cue(scope, t, function()
			spawnCopy(run, copy)
		end)
		scope.endT = math.max(scope.endT, t + life)
	end
end

walk = function(scope, inst: Instance, parentCtx)
	local ctx = childCtx(inst, parentCtx)
	local class = inst.ClassName
	if class == "ParticleEmitter" then
		particleLayer(scope, inst :: ParticleEmitter, ctx)
	elseif TOGGLES[class] then
		toggleLayer(scope, inst, ctx)
	end
	if inst:IsA("Model") or inst:IsA("Folder") then
		local s, e = meshPair(inst)
		if s and e then
			meshLayer(scope, inst, s, e, ctx)
		end
	end
	for _, child in inst:GetChildren() do
		walk(scope, child, ctx)
	end
end

-- ------------------------------------------------------------ playing

local function originOf(run): CFrame
	local at = run.follow
	if at and at.Parent then
		if at:IsA("Attachment") then
			return at.WorldCFrame * run.offset
		end
		return at:GetPivot() * run.offset
	end
	return run.placeCF
end

local function anchorAll(root: Instance)
	prepParts(root)
end

-- Fires the cues due by rt in time order (run.cues is sorted latest first: pop from the end). Cues
-- a fired cue adds (a copy's riding layers) land in order and fire in the same pass when due. A
-- mesh copy's cues after its death are dropped even on a long frame (the plan keeps c.at <= death).
local function fireDue(run, rt: number)
	while not run.stopped do
		local list = run.cues
		local n = #list
		local c = list[n]
		if c == nil or c.t > rt then
			return
		end
		list[n] = nil
		local copy = c.scope.copy
		if not c.scope.dead and not (copy and c.t > copy.born + copy.life) then
			c.fn()
		end
	end
end

local function cleanup(run)
	if run.finished then
		return
	end
	run.finished = true
	active[run] = nil
	for _, copy in run.copies do
		if copy.inst then
			copy.inst:Destroy()
		end
	end
	run.copies = {}
	run.fades = {}
	run.cues = {}
	run.root:Destroy()
	run.signal:_fire()
end

local function endRun(run)
	if run.ended then
		return
	end
	run.ended = true
	run.rootScope.dead = true
	disableLayers(run.rootScope)
end

local function stopRun(run, immediate: boolean?)
	if run.finished then
		return
	end
	if immediate then
		cleanup(run)
		return
	end
	if run.stopped then
		return
	end
	run.stopped = true
	run.cues = {}
	run.fades = {}
	local linger = 0
	for _, scope in run.scopes do
		-- Stop switches the untimed top-level layers off too.
		for _, x in scope.free do
			table.insert(scope.layers, x)
		end
		scope.free = {}
		for _, x in scope.layers do
			if x:IsA("ParticleEmitter") then
				linger = math.max(linger, x.Lifetime.Max)
			elseif x:IsA("Trail") then
				linger = math.max(linger, x.Lifetime)
			end
		end
		disableLayers(scope)
	end
	run.ended = true
	run.rootScope.dead = true
	run.cleanupAt = math.min(run.cleanupAt, os.clock() - run.t0 + linger)
end

local function stepRun(run, now: number)
	if run.finished then
		return
	end
	-- The emission's instance (or something above it) was destroyed or removed: nothing left to play
	-- (spawning a copy into it would fail: "Parent property is locked").
	if run.root.Parent == nil then
		cleanup(run)
		return
	end
	local rt = now - run.t0
	-- Follow: welded parts move by themselves; attachments / models are re-pivoted.
	if run.follow then
		if run.follow.Parent then
			run.placeCF = originOf(run)
			if run.pivotEachFrame then
				run.root:PivotTo(run.placeCF)
			end
		elseif run.welded and not run.unwelded then
			run.unwelded = true
			anchorAll(run.root)
		end
	end
	fireDue(run, rt)
	-- Mesh copies.
	local i = 1
	while i <= #run.copies do
		local copy = run.copies[i]
		if rt >= copy.removeAt then
			copy.inst:Destroy()
			table.remove(run.copies, i)
			local at = table.find(run.scopes, copy.scope)
			if at then
				table.remove(run.scopes, at)
			end
		else
			local M = if copy.spec.sync then copy.frame() else copy.M
			local age = rt - copy.born
			if not copy.dead then
				applyCopy(copy, math.min(age, copy.life), M)
				if age >= copy.life then
					killCopy(copy)
				end
			elseif copy.rel then
				copy.inst.CFrame = M * copy.rel
			end
			i += 1
		end
	end
	-- FadeOut ramps.
	local j = 1
	while j <= #run.fades do
		local f = run.fades[j]
		local done = false
		if rt >= f.t0 then
			local k = if f.t1 > f.t0 then math.clamp((rt - f.t0) / (f.t1 - f.t0), 0, 1) else 1
			applyFade(f.x, f.base, k)
			done = k >= 1
		end
		if done then
			table.remove(run.fades, j)
		else
			j += 1
		end
	end
	if not run.ended and rt >= run.duration then
		endRun(run)
	end
	if run.ended and rt >= run.cleanupAt and #run.copies == 0 then
		cleanup(run)
	end
end

local function step()
	local now = os.clock()
	local list = {}
	for run in active do
		table.insert(list, run)
	end
	for _, run in list do
		local ok, err = pcall(stepRun, run, now)
		if not ok then
			warn("ForgeVFX: " .. tostring(err))
			pcall(cleanup, run)
		end
	end
	if next(active) == nil and stepConn then
		stepConn:Disconnect()
		stepConn = nil
	end
end

local function ensureStepper()
	if not stepConn then
		stepConn = RunService.Heartbeat:Connect(step)
	end
end

local Emission = {}
Emission.__index = Emission

-- Stops spawning and switches every layer off; alive particles and mesh copies finish. Stop(true)
-- removes everything at once. Finished fires after the clean-up either way.
function Emission:Stop(immediate: boolean?)
	stopRun(self._run, immediate)
end

function Emission:IsPlaying(): boolean
	return not self._run.finished
end

-- ------------------------------------------------------------ API

function ForgeVFX.emit(template: Instance, at: any?, options: any?)
	assert(typeof(template) == "Instance", "ForgeVFX.emit: template must be an Instance")
	local o = options or {}
	local clone = template:Clone()
	if not clone then
		error("ForgeVFX.emit: " .. template:GetFullName() .. " cannot be cloned (Archivable is false)", 2)
	end
	stripScripts(clone)
	local root = holderFor(clone, template)
	local offset = if typeof(o.offset) == "CFrame" then o.offset else CFrame.new()
	local run = {
		root = root,
		pivot0 = root:GetPivot(),
		offset = offset,
		placeCF = CFrame.new(),
		follow = nil,
		welded = false,
		pivotEachFrame = false,
		unwelded = false,
		t0 = os.clock(),
		cues = {},
		fades = {},
		copies = {},
		scopes = {},
		duration = 0,
		cleanupAt = 0,
		ended = false,
		stopped = false,
		finished = false,
		signal = newSignal(),
	}
	run.placeCF = run.pivot0 * offset
	if typeof(at) == "CFrame" then
		run.placeCF = at * offset
	elseif typeof(at) == "Instance" then
		if at:IsA("Attachment") then
			run.placeCF = at.WorldCFrame * offset
		elseif at:IsA("PVInstance") then
			run.placeCF = at:GetPivot() * offset
		else
			error("ForgeVFX.emit: at must be a CFrame, BasePart, Attachment or Model", 2)
		end
		if o.follow ~= false then
			run.follow = at
			if at:IsA("BasePart") then
				run.welded = true
			else
				run.pivotEachFrame = true
			end
		end
	elseif at ~= nil then
		error("ForgeVFX.emit: at must be a CFrame, BasePart, Attachment or Model", 2)
	end
	local ok, err = pcall(function()
		local scope = newScope(run, 0, nil)
		run.rootScope = scope
		scope.frame = function()
			return run.placeCF * run.pivot0:Inverse()
		end
		walk(scope, root, ROOT_CTX)
		prepParts(root)
		-- Start / End have left the clone: if one was the PrimaryPart the Model's pivot would move
		-- (and PivotTo shift the static parts); keep the template's pivot instead.
		if root:IsA("Model") then
			local model = root :: Model
			model.PrimaryPart = nil
			model.WorldPivot = run.pivot0
		end
		local duration = scope.endT
		if typeof(o.duration) == "number" and o.duration >= 0 then
			duration = o.duration
		elseif duration <= 0 and scope.hasOpen then
			duration = DEFAULT_DURATION
		end
		run.duration = duration
		run.cleanupAt = duration + finishScope(scope, duration)
		root:PivotTo(run.placeCF)
		root.Parent = o.parent or defaultParent()
		if run.welded then
			local target = at :: BasePart
			local parts = {}
			if root:IsA("BasePart") then
				table.insert(parts, root)
			end
			for _, d in root:GetDescendants() do
				if d:IsA("BasePart") then
					table.insert(parts, d)
				end
			end
			for _, p in parts do
				local w = Instance.new("WeldConstraint")
				w.Part0 = target
				w.Part1 = p
				w.Parent = p
				p.Massless = true
				p.Anchored = false
			end
		end
	end)
	if not ok then
		root:Destroy()
		error("ForgeVFX.emit: " .. tostring(err), 2)
	end
	run.t0 = os.clock()
	active[run] = true
	ensureStepper()
	fireDue(run, 0)
	return setmetatable({ Instance = root, Duration = run.duration, Finished = run.signal, _run = run }, Emission)
end

-- Stops every play (see Emission:Stop).
function ForgeVFX.stopAll(immediate: boolean?)
	local list = {}
	for run in active do
		table.insert(list, run)
	end
	for _, run in list do
		stopRun(run, immediate)
	end
end

-- Optional: shared.ForgeVFX for quick tests and the Workspace.ForgeVFX folder.
function ForgeVFX.init()
	shared.ForgeVFX = ForgeVFX
	defaultParent()
	return ForgeVFX
end

return ForgeVFX
`
