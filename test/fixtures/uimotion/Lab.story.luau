--!nocheck
-- RBX Forge UI Motion Lab scratch story for PlayButton (generated; not part of the game).
-- Controls: Slots (1-3), Spec1..Spec3 (motion stacks as JSON), Label1..Label3, Trigger, Reduced.
local GuiService = game:GetService("GuiService")
local RunService = game:GetService("RunService")
local TweenService = game:GetService("TweenService")
local UserInputService = game:GetService("UserInputService")
local HttpService = game:GetService("HttpService")

local TAU = math.pi * 2

-- Damped spring, closed-form step for a constant goal (frame-rate independent).
-- x'' = -w^2 (x - goal) - 2 z w x', w = 2 pi frequency, z = damping ratio.
local function stepSpring(x: number, v: number, goal: number, frequency: number, damping: number, dt: number): (number, number)
	if dt <= 0 then
		return x, v
	end
	local w = TAU * math.max(0.01, frequency)
	local z = math.max(0, damping)
	local o = x - goal
	if z < 0.9999 then
		local wd = w * math.sqrt(1 - z * z)
		local e = math.exp(-z * w * dt)
		local c, s = math.cos(wd * dt), math.sin(wd * dt)
		local o1 = e * (o * c + (v + z * w * o) / wd * s)
		local v1 = e * (v * c - (z * w * v + w * w * o) / wd * s)
		return goal + o1, v1
	elseif z <= 1.0001 then
		local e = math.exp(-w * dt)
		local b = v + w * o
		return goal + e * (o + b * dt), e * (v - w * b * dt)
	end
	local r = math.sqrt(z * z - 1)
	local r1, r2 = -w * (z - r), -w * (z + r)
	local c1 = (v - r2 * o) / (r1 - r2)
	local c2 = o - c1
	local e1, e2 = math.exp(r1 * dt), math.exp(r2 * dt)
	return goal + c1 * e1 + c2 * e2, c1 * r1 * e1 + c2 * r2 * e2
end

local SPEC = { reducedMotion = "respect", targets = {} }

local function lerp(a: number, b: number, t: number): number
	return a + (b - a) * t
end

local function reducedMotionEnabled(): boolean
	local ok, value = pcall(function()
		return (GuiService :: any).ReducedMotionEnabled
	end)
	return ok and value == true
end

local function resolve(root: Instance, path: string): Instance?
	local node: Instance? = root
	for part in string.gmatch(path, "[^%.]+") do
		node = if node then node:FindFirstChild(part) else nil
	end
	return node
end

-- Reduced motion keeps feedback and drops decoration: no float, tilt, idle shine, ripple, pop or
-- squash, no overshoot (damping >= 1), appear / disappear become fades.
local function reduceEffects(effects: { [string]: any }): { [string]: any }
	local out = {}
	for kind, e in effects do
		if kind == "float" or kind == "tilt" or kind == "ripple" or kind == "pop" or kind == "squash" then
			continue
		end
		if kind == "shine" and e.trigger == "idle" then
			continue
		end
		local c = table.clone(e)
		if c.damping ~= nil then
			c.damping = math.max(1, c.damping)
		end
		if kind == "appear" then
			c.fromScale, c.fromY = 1, 0
		elseif kind == "disappear" then
			c.toScale, c.toY = 1, 0
		elseif kind == "glow" then
			c.period = 0
		end
		out[kind] = c
	end
	return out
end

local function hasLayout(parent: Instance?): boolean
	return parent ~= nil and (parent:FindFirstChildWhichIsA("UIListLayout") ~= nil or parent:FindFirstChildWhichIsA("UIGridLayout") ~= nil)
end

-- AbsolutePosition / AbsoluteSize (zero until the first layout, e.g. in a headless preview).
local function absolute(target: GuiObject): (Vector2, Vector2)
	local pos, size = target.AbsolutePosition, target.AbsoluteSize
	if typeof(pos) ~= "Vector2" or typeof(size) ~= "Vector2" then
		return Vector2.zero, Vector2.zero
	end
	return pos, size
end

local function mouseIn(target: GuiObject): Vector2
	local m = UserInputService:GetMouseLocation()
	local screen = target:FindFirstAncestorWhichIsA("ScreenGui")
	if screen and not screen.IgnoreGuiInset then
		local ok, inset = pcall(function()
			return GuiService:GetGuiInset()
		end)
		if ok and typeof(inset) == "Vector2" then
			m -= inset
		end
	end
	return m
end

-- Transparency properties the fades scale (base values captured at attach).
local FADE_PROPS = {
	{ "GuiObject", "BackgroundTransparency" },
	{ "TextLabel", "TextTransparency" },
	{ "TextButton", "TextTransparency" },
	{ "TextBox", "TextTransparency" },
	{ "ImageLabel", "ImageTransparency" },
	{ "ImageButton", "ImageTransparency" },
	{ "UIStroke", "Transparency" },
}

type State = {
	target: GuiObject,
	clickable: GuiObject,
	fx: { [string]: any },
	hovered: boolean,
	pressed: boolean,
	time: number,
	mode: string,
	modeTime: number,
	scale: { x: number, v: number },
	pop: { x: number, v: number },
	squash: { x: number, v: number },
	lift: { x: number, v: number },
	rot: { x: number, v: number },
	tx: { x: number, v: number },
	ty: { x: number, v: number },
	glow: { x: number, v: number },
	enterY: { x: number, v: number },
	shineNext: number,
	basePosition: UDim2,
	baseSize: UDim2,
	baseRotation: number,
	uiScale: UIScale?,
	shine: Frame?,
	shineGradient: UIGradient?,
	shineTween: Tween?,
	stroke: UIStroke?,
	strokeOwned: boolean,
	strokeBase: { thickness: number, transparency: number, color: Color3 }?,
	fades: { { inst: Instance, prop: string, base: number } },
	ripples: number,
	baseClips: boolean,
}

local DEFAULT_SPRING = { frequency = 4, damping = 1 }

local function step(s: { x: number, v: number }, goal: number, p: any, dt: number)
	s.x, s.v = stepSpring(s.x, s.v, goal, p.frequency, p.damping, dt)
end

local Effects = {}

-- Wires the stack to root (spec defaults to this module's SPEC). Returns a handle:
--   handle.destroy()   disconnects everything, removes what it added, restores the element
--   handle.show()      plays the appear transition (also played on attach)
--   handle.hide(done?) plays the disappear transition, then calls done
-- options.reduced overrides GuiService.ReducedMotionEnabled (the lab's toggle).
function Effects.attach(root: GuiObject, spec: any?, options: { reduced: boolean? }?)
	local s0 = spec or SPEC
	local wantsReduced = if options and options.reduced ~= nil then options.reduced else reducedMotionEnabled()
	local reduced = s0.reducedMotion == "respect" and wantsReduced
	local connections: { RBXScriptConnection } = {}
	local created: { Instance } = {}
	local tweens: { Tween } = {}
	local states: { State } = {}
	local restores: { () -> () } = {}

	local function make(className: string, props: { [string]: any }, parent: Instance): Instance
		local inst = Instance.new(className)
		for k, v in props do
			(inst :: any)[k] = v
		end
		inst.Parent = parent
		table.insert(created, inst)
		return inst
	end

	local function tween(inst: Instance, info: TweenInfo, goals: { [string]: any }): Tween
		local t = TweenService:Create(inst, info, goals)
		table.insert(tweens, t)
		t:Play()
		return t
	end

	local function fadeTo(s: State, alpha: number, duration: number, delay: number)
		for _, f in s.fades do
			if f.inst.Parent ~= nil or f.inst == s.target then
				tween(f.inst, TweenInfo.new(duration, Enum.EasingStyle.Linear, Enum.EasingDirection.Out, 0, false, delay), { [f.prop] = 1 - (1 - f.base) * alpha })
			end
		end
	end

	local function startAppear(s: State)
		local a = s.fx.appear
		if not a then
			return
		end
		s.mode, s.modeTime = "entering", 0
		s.scale.x, s.scale.v = a.fromScale, 0
		s.enterY.x, s.enterY.v = a.fromY, 0
		for _, f in s.fades do
			(f.inst :: any)[f.prop] = 1
		end
		fadeTo(s, 1, a.duration, a.delay)
	end

	for _, t in s0.targets do
		local found = resolve(root, t.path)
		if not found or not found:IsA("GuiObject") then
			warn("[motion] no GuiObject at " .. (if t.path == "" then "(root)" else t.path))
			continue
		end
		local target = found :: GuiObject
		local fx = if reduced then reduceEffects(t.effects) else t.effects
		local clickable = if target:IsA("GuiButton") then target else (target:FindFirstAncestorWhichIsA("GuiButton") or target) :: GuiObject
		local s: State = {
			target = target,
			clickable = clickable,
			fx = fx,
			hovered = false,
			pressed = false,
			time = 0,
			mode = "visible",
			modeTime = 0,
			scale = { x = 1, v = 0 },
			pop = { x = 0, v = 0 },
			squash = { x = 0, v = 0 },
			lift = { x = 0, v = 0 },
			rot = { x = 0, v = 0 },
			tx = { x = 0, v = 0 },
			ty = { x = 0, v = 0 },
			glow = { x = if fx.glow and fx.glow.trigger == "idle" then 1 else 0, v = 0 },
			enterY = { x = 0, v = 0 },
			-- Hover / click shines wait for their event (engine.ts: only idle shines start on a timer).
			shineNext = if fx.shine and fx.shine.trigger == "idle" then 0.6 else math.huge,
			basePosition = target.Position,
			baseSize = target.Size,
			baseRotation = target.Rotation,
			strokeOwned = false,
			fades = {},
			ripples = 0,
			baseClips = target.ClipsDescendants,
		}
		local scales = fx.hover or fx.press or fx.pop or fx.appear or fx.disappear
		-- Scale, squash and turn around the centre: move the anchor to the middle without moving
		-- the element (a layout ignores Position, so only free elements are re-anchored).
		if (scales or fx.squash or fx.tilt or fx.float) and not hasLayout(target.Parent) and target.AnchorPoint ~= Vector2.new(0.5, 0.5) then
			local a, size, pos = target.AnchorPoint, target.Size, target.Position
			local dx, dy = 0.5 - a.X, 0.5 - a.Y
			target.AnchorPoint = Vector2.new(0.5, 0.5)
			target.Position = UDim2.new(pos.X.Scale + dx * size.X.Scale, pos.X.Offset + dx * size.X.Offset, pos.Y.Scale + dy * size.Y.Scale, pos.Y.Offset + dy * size.Y.Offset)
			s.basePosition = target.Position
			table.insert(restores, function()
				target.AnchorPoint = a
				target.Position = pos
			end)
		else
			local pos = target.Position
			table.insert(restores, function()
				target.Position = pos
			end)
		end
		local size, rotation = target.Size, target.Rotation
		table.insert(restores, function()
			target.Size = size
			target.Rotation = rotation
			target.ClipsDescendants = s.baseClips
		end)
		if scales then
			s.uiScale = make("UIScale", { Name = "ForgeMotionScale", Scale = 1 }, target) :: UIScale
		end
		if fx.shine then
			local e = fx.shine
			local w = math.clamp(e.width, 0.02, 0.9) / 2
			local shine = make("Frame", { Name = "ForgeMotionShine", Size = UDim2.fromScale(1, 1), BackgroundColor3 = Color3.new(e.color[1], e.color[2], e.color[3]), BorderSizePixel = 0, ZIndex = 1000, Visible = false }, target) :: Frame
			local corner = target:FindFirstChildWhichIsA("UICorner")
			if corner then
				make("UICorner", { CornerRadius = corner.CornerRadius }, shine)
			end
			s.shine = shine
			s.shineGradient = make("UIGradient", {
				Rotation = e.angle,
				Offset = Vector2.new(-1, 0),
				Transparency = NumberSequence.new({
					NumberSequenceKeypoint.new(0, 1),
					NumberSequenceKeypoint.new(math.max(0.001, 0.5 - w), 1),
					NumberSequenceKeypoint.new(0.5, 1 - e.intensity),
					NumberSequenceKeypoint.new(math.min(0.999, 0.5 + w), 1),
					NumberSequenceKeypoint.new(1, 1),
				}),
			}, shine) :: UIGradient
		end
		if fx.glow then
			local existing: UIStroke? = nil
			for _, child in target:GetChildren() do
				if child:IsA("UIStroke") and child.ApplyStrokeMode == Enum.ApplyStrokeMode.Border then
					existing = child
					break
				end
			end
			if existing then
				s.stroke = existing
				s.strokeBase = { thickness = existing.Thickness, transparency = existing.Transparency, color = existing.Color }
				local base = s.strokeBase :: any
				table.insert(restores, function()
					existing.Thickness, existing.Transparency, existing.Color = base.thickness, base.transparency, base.color
				end)
			else
				s.stroke = make("UIStroke", { Name = "ForgeMotionGlow", ApplyStrokeMode = Enum.ApplyStrokeMode.Border, Thickness = 0, Transparency = 1 }, target) :: UIStroke
				s.strokeOwned = true
			end
		end
		if fx.appear or fx.disappear then
			local function capture(inst: Instance)
				for _, pair in FADE_PROPS do
					if inst:IsA(pair[1]) and not table.find(created, inst) then
						local base = (inst :: any)[pair[2]]
						table.insert(s.fades, { inst = inst, prop = pair[2], base = base })
						table.insert(restores, function()
							(inst :: any)[pair[2]] = base
						end)
					end
				end
			end
			capture(target)
			for _, d in target:GetDescendants() do
				capture(d)
			end
		end
		table.insert(states, s)

		local function press(on: boolean)
			if on then
				if s.pressed then
					return
				end
				s.pressed = true
				if fx.ripple then
					local e = fx.ripple
					local pos, size = absolute(target)
					local m = mouseIn(target) - pos
					local far = math.max(m.Magnitude, (Vector2.new(size.X, 0) - m).Magnitude, (Vector2.new(0, size.Y) - m).Magnitude, (size - m).Magnitude)
					local ring = make("Frame", { Name = "ForgeMotionRipple", AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.fromOffset(m.X, m.Y), Size = UDim2.fromOffset(0, 0), BackgroundColor3 = Color3.new(e.color[1], e.color[2], e.color[3]), BackgroundTransparency = 1 - e.opacity, BorderSizePixel = 0, ZIndex = 999 }, target)
					make("UICorner", { CornerRadius = UDim.new(0.5, 0) }, ring)
					target.ClipsDescendants = true
					s.ripples += 1
					tween(ring, TweenInfo.new(e.duration, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { Size = UDim2.fromOffset(far * 2, far * 2) })
					local fade = tween(ring, TweenInfo.new(e.duration, Enum.EasingStyle.Linear), { BackgroundTransparency = 1 })
					fade.Completed:Connect(function()
						ring:Destroy()
						s.ripples -= 1
						if s.ripples <= 0 then
							target.ClipsDescendants = s.baseClips
						end
					end)
				end
				return
			end
			if not s.pressed then
				return
			end
			s.pressed = false
			-- A release after a press is a click.
			if fx.pop then
				s.pop.v += fx.pop.amount * 2 * math.pi * fx.pop.frequency * math.exp(1)
			end
			if fx.shine and fx.shine.trigger == "click" then
				s.shineNext = s.time
			end
		end

		table.insert(connections, clickable.MouseEnter:Connect(function()
			s.hovered = true
			if fx.shine and fx.shine.trigger == "hover" then
				s.shineNext = s.time
			end
		end))
		table.insert(connections, clickable.MouseLeave:Connect(function()
			s.hovered = false
			s.pressed = false
		end))
		table.insert(connections, clickable.InputBegan:Connect(function(input: InputObject)
			if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
				press(true)
			end
		end))
		table.insert(connections, UserInputService.InputEnded:Connect(function(input: InputObject)
			if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
				press(false)
			end
		end))
		startAppear(s)
	end

	local function frame(dt: number)
		for _, s in states do
			local fx = s.fx
			s.time += dt
			s.modeTime += dt
			local holding = s.mode == "entering" and fx.appear ~= nil and s.modeTime < fx.appear.delay
			if s.mode == "entering" and fx.appear and s.modeTime > fx.appear.delay + 2 then
				s.mode = "visible"
			end
			local goal, params = 1, fx.hover or DEFAULT_SPRING
			if s.pressed and fx.press then
				goal, params = fx.press.scale, fx.press
			elseif s.hovered and fx.hover then
				goal = fx.hover.scale
			end
			local yGoal, yParams = 0, fx.appear or DEFAULT_SPRING
			if s.mode == "entering" and fx.appear and not s.hovered and not s.pressed then
				params = fx.appear
			end
			if s.mode == "hidden" and fx.disappear then
				goal = fx.disappear.toScale
				params = { frequency = 1.2 / math.max(0.05, fx.disappear.duration), damping = 1 }
				yGoal, yParams = fx.disappear.toY, params
			end
			if not holding then
				step(s.scale, goal, params, dt)
				step(s.enterY, yGoal, yParams, dt)
			end
			if fx.pop then
				step(s.pop, 0, fx.pop, dt)
			end
			if fx.squash then
				step(s.squash, if s.pressed then fx.squash.amount else 0, fx.squash, dt)
			end
			if fx.hover then
				step(s.lift, if s.hovered and not s.pressed then fx.hover.lift else 0, fx.hover, dt)
			end
			if fx.tilt then
				local nx, ny = 0, 0
				local pos, size = absolute(s.target)
				if s.hovered and size.X > 0 and size.Y > 0 then
					local m = mouseIn(s.target)
					local centre = pos + size / 2
					nx = math.clamp((m.X - centre.X) / (size.X / 2), -1, 1)
					ny = math.clamp((m.Y - centre.Y) / (size.Y / 2), -1, 1)
				end
				step(s.rot, nx * fx.tilt.angle, fx.tilt, dt)
				step(s.tx, nx * fx.tilt.shift, fx.tilt, dt)
				step(s.ty, ny * fx.tilt.shift, fx.tilt, dt)
			end
			if fx.glow then
				step(s.glow, if fx.glow.trigger == "idle" or s.hovered then 1 else 0, fx.glow, dt)
			end
			if fx.shine and s.shine and s.shineGradient and s.time >= s.shineNext and not s.shineTween then
				local e = fx.shine
				s.shineNext = if e.trigger == "idle" then s.time + e.interval + e.duration else math.huge
				s.shine.Visible = true
				s.shineGradient.Offset = Vector2.new(-1, 0)
				local t = tween(s.shineGradient, TweenInfo.new(e.duration, Enum.EasingStyle.Quad, Enum.EasingDirection.InOut), { Offset = Vector2.new(1, 0) })
				s.shineTween = t
				t.Completed:Connect(function()
					s.shineTween = nil
					if s.shine then
						s.shine.Visible = false
					end
				end)
			end

			-- Write the element.
			local target = s.target
			if s.uiScale then
				s.uiScale.Scale = math.max(0, s.scale.x + s.pop.x)
			end
			if fx.squash then
				local b = s.baseSize
				local sx, sy = 1 + s.squash.x, 1 - s.squash.x
				target.Size = UDim2.new(b.X.Scale * sx, b.X.Offset * sx, b.Y.Scale * sy, b.Y.Offset * sy)
			end
			local floatY, floatR = 0, 0
			if fx.float then
				local f = fx.float
				floatY = -math.sin(2 * math.pi * s.time / f.period) * f.amplitude
				if f.rotate ~= 0 then
					floatR = math.cos(2 * math.pi * s.time / f.period) * f.rotate
				end
			end
			if fx.hover or fx.tilt or fx.float or fx.appear or fx.disappear then
				local p = s.basePosition
				target.Position = UDim2.new(p.X.Scale, p.X.Offset + s.tx.x, p.Y.Scale, p.Y.Offset - s.lift.x + s.ty.x + s.enterY.x + floatY)
			end
			if fx.tilt or (fx.float and fx.float.rotate ~= 0) then
				target.Rotation = s.baseRotation + s.rot.x + floatR
			end
			if fx.glow and s.stroke then
				local g = fx.glow
				local pulse = if g.period > 0 then 0.7 + 0.3 * math.cos(2 * math.pi * s.time / g.period) else 1
				local k = math.clamp(s.glow.x, 0, 1.25) * pulse
				local glowColor = Color3.new(g.color[1], g.color[2], g.color[3])
				if s.strokeOwned then
					s.stroke.Thickness = k * g.thickness
					s.stroke.Transparency = 1 - math.clamp(k, 0, 1) * g.opacity
					s.stroke.Color = glowColor
				elseif s.strokeBase then
					local b = s.strokeBase
					local kk = math.clamp(k, 0, 1)
					s.stroke.Thickness = b.thickness + k * g.thickness
					s.stroke.Transparency = lerp(b.transparency, 1 - g.opacity, kk)
					s.stroke.Color = b.color:Lerp(glowColor, kk)
				end
			end
		end
	end

	table.insert(connections, RunService.RenderStepped:Connect(frame))

	local handle = {}
	function handle.show()
		for _, s in states do
			startAppear(s)
		end
	end
	function handle.hide(done: (() -> ())?)
		local longest = 0
		for _, s in states do
			local d = s.fx.disappear
			if d then
				s.mode, s.modeTime = "hidden", 0
				fadeTo(s, 0, d.duration, 0)
				longest = math.max(longest, d.duration)
			end
		end
		if done then
			task.delay(longest, done)
		end
	end
	function handle.destroy()
		for _, c in connections do
			c:Disconnect()
		end
		for _, t in tweens do
			t:Cancel()
		end
		for i = #created, 1, -1 do
			created[i]:Destroy()
		end
		for _, r in restores do
			r()
		end
		table.clear(connections)
		table.clear(states)
	end
	return handle
end

local Component = require(game:GetService("ReplicatedStorage").Shared.Interface.Components.PlayButton) :: any

local function mount(slot: Frame): (Instance, () -> ())
	local ui = Component()
	ui.AnchorPoint = Vector2.new(0.5, 0.5)
	ui.Position = UDim2.fromScale(0.5, 0.5)
	ui.Parent = slot
	return ui, function()
		ui:Destroy()
	end
end

-- Forge's spec JSON ({targets = {{path, effects = {{kind, ...}}}}}) in the runtime's shape.
local function decode(text: string): any
	if type(text) ~= "string" or text == "" then
		return nil
	end
	local ok, raw = pcall(function()
		return HttpService:JSONDecode(text)
	end)
	if not ok or type(raw) ~= "table" then
		warn("[motion lab] bad spec JSON")
		return nil
	end
	local targets = {}
	for _, t in raw.targets or {} do
		local effects = {}
		for _, e in t.effects or {} do
			local copy = table.clone(e)
			copy.kind = nil
			effects[e.kind] = copy
		end
		table.insert(targets, { path = t.path or "", effects = effects })
	end
	return { reducedMotion = raw.reducedMotion or "respect", targets = targets }
end

local controls = {
	Slots = 1,
	Spec1 = "",
	Spec2 = "",
	Spec3 = "",
	Label1 = "",
	Label2 = "",
	Label3 = "",
	Trigger = "",
	Reduced = false,
}

return {
	controls = controls,
	render = function(props)
		local holder = Instance.new("Frame")
		holder.Name = "ForgeMotionLab"
		holder.Size = UDim2.fromScale(1, 1)
		holder.BackgroundTransparency = 1
		holder.Parent = props.target
		local slots = {}
		local current = table.clone(props.controls)

		local function clear()
			for _, s in slots do
				if s.handle then
					s.handle.destroy()
				end
				s.unmount()
				s.frame:Destroy()
			end
			table.clear(slots)
		end

		local function build(values)
			clear()
			local n = math.clamp(math.floor(tonumber(values.Slots) or 1), 1, 3)
			for i = 1, n do
				local frame = Instance.new("Frame")
				frame.Name = "Slot" .. i
				frame.AnchorPoint = Vector2.new(0.5, 0.5)
				frame.Position = UDim2.fromScale((i - 0.5) / n, 0.5)
				frame.Size = UDim2.fromScale(1 / n, 1)
				frame.BackgroundTransparency = 1
				frame.Parent = holder
				local label = values["Label" .. i]
				if n > 1 and type(label) == "string" and label ~= "" then
					local text = Instance.new("TextLabel")
					text.Name = "ForgeMotionLabel"
					text.AnchorPoint = Vector2.new(0.5, 1)
					text.Position = UDim2.new(0.5, 0, 1, -24)
					text.Size = UDim2.fromOffset(240, 24)
					text.BackgroundTransparency = 1
					text.Text = label
					text.TextSize = 18
					text.TextColor3 = Color3.fromRGB(150, 158, 170)
					text.FontFace = Font.new("rbxasset://fonts/families/RobotoMono.json")
					text.Parent = frame
				end
				local root, unmount = mount(frame)
				local spec = decode(values["Spec" .. i])
				local handle = if spec then Effects.attach(root :: any, spec, { reduced = values.Reduced == true }) else nil
				table.insert(slots, { frame = frame, unmount = unmount, handle = handle })
			end
		end

		build(current)
		local unsubscribe = props.subscribe(function(values)
			local trigger = values.Trigger
			local onlyTrigger = trigger ~= current.Trigger
			for key, value in values do
				if key ~= "Trigger" and current[key] ~= value then
					onlyTrigger = false
				end
			end
			current = table.clone(values)
			if onlyTrigger then
				local action = string.match(tostring(trigger), "^(%a+)")
				for _, s in slots do
					if s.handle and action == "appear" then
						s.handle.show()
					elseif s.handle and action == "disappear" then
						s.handle.hide()
					end
				end
				return
			end
			build(values)
		end)
		return function()
			unsubscribe()
			clear()
			holder:Destroy()
		end
	end,
}
