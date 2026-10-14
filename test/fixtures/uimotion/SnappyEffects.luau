--!strict
-- Snappy: UI motion compiled by RBX Forge's UI Motion Lab.
-- Client only: require it from a LocalScript or a UI component, then
--   local motion = Effects.attach(button)  -- returns { destroy, show, hide }
--   motion.hide(function() button.Visible = false end)
-- Springs: x'' = -w^2 (x - goal) - 2 z w x', w = 2 pi frequency, z = damping ratio, stepped in closed form
-- every RenderStepped (frame-rate independent). Quenty's Spring: Speed = 2 pi frequency, Damper = damping.
-- Reduced motion (GuiService.ReducedMotionEnabled) drops float, tilt, idle shine, ripple, pop and squash
-- and removes overshoot, unless SPEC.reducedMotion is "ignore". Regenerate from the lab; hand edits are
-- overwritten on the next export.
--
--   (root): hover x1.04 lift 1px f6 z0.9 · press x0.95 f9 z0.95

local GuiService = game:GetService("GuiService")
local RunService = game:GetService("RunService")
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
				scale = 1.04,
				lift = 1,
				frequency = 6,
				damping = 0.9,
			},
			press = {
				scale = 0.95,
				frequency = 9,
				damping = 0.95,
			},
		},
	} },
}


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
		table.insert(states, s)

		local function press(on: boolean)
			if on then
				if s.pressed then
					return
				end
				s.pressed = true
				return
			end
			if not s.pressed then
				return
			end
			s.pressed = false
			-- A release after a press is a click.
		end

		table.insert(connections, clickable.MouseEnter:Connect(function()
			s.hovered = true
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
