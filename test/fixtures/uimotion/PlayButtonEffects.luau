--!strict
-- PlayButton: UI motion compiled by RBX Forge's UI Motion Lab (PlayButton / Juicy).
-- Client only: require it from a LocalScript or a UI component, then
--   local motion = Effects.attach(button)  -- returns { destroy, show, hide }
--   motion.hide(function() button.Visible = false end)
-- Springs: x'' = -w^2 (x - goal) - 2 z w x', w = 2 pi frequency, z = damping ratio, stepped in closed form
-- every RenderStepped (frame-rate independent). Quenty's Spring: Speed = 2 pi frequency, Damper = damping.
-- Reduced motion (GuiService.ReducedMotionEnabled) drops float, tilt, idle shine, ripple, pop and squash
-- and removes overshoot, unless SPEC.reducedMotion is "ignore". Regenerate from the lab; hand edits are
-- overwritten on the next export.
--
--   (root): hover x1.06 lift 2px f4 z0.55 · press x0.92 f7 z0.6 · squash 0.08 f5 z0.4 · shine on idle 0.55s every 2.5s @20° · glow on hover +3px pulse 1.1s f3 z1 · ripple 0.45s

local GuiService = game:GetService("GuiService")
local RunService = game:GetService("RunService")
local TweenService = game:GetService("TweenService")
local UserInputService = game:GetService("UserInputService")

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

local SPEC = {
	reducedMotion = "respect",
	targets = { {
		path = "",
		effects = {
			hover = {
				scale = 1.06,
				lift = 2,
				frequency = 4,
				damping = 0.55,
			},
			press = {
				scale = 0.92,
				frequency = 7,
				damping = 0.6,
			},
			squash = {
				amount = 0.08,
				frequency = 5,
				damping = 0.4,
			},
			shine = {
				trigger = "idle",
				duration = 0.55,
				interval = 2.5,
				angle = 20,
				width = 0.16,
				intensity = 0.45,
				color = { 1, 1, 1 },
			},
			glow = {
				trigger = "hover",
				color = { 1, 0.85, 0.35 },
				thickness = 3,
				opacity = 0.8,
				period = 1.1,
				frequency = 3,
				damping = 1,
			},
			ripple = {
				color = { 1, 1, 1 },
				duration = 0.45,
				opacity = 0.35,
			},
		},
	} },
}

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


	local function startAppear(s: State)
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
			shineNext = 0.6,
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

Effects.spec = SPEC

return Effects
