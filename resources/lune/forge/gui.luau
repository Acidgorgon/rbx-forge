--!nocheck
-- UI preview host: runs a UI Labs story (Vide, function or generic) in a Forge world and streams the
-- GUI instance tree to RBX Forge as JSON lines; input from Forge comes back as events.
--
-- Output ops (batched per frame in {"type":"ops","ops":[...]}):
--   {op="create", id, cls, name, parent, props={...}}   an instance entered the preview tree
--   {op="set", id, k, v}                                  one property changed
--   {op="parent", id, parent}                             moved (parent = null: left the tree)
--   {op="destroy", id}
-- Values: numbers, strings, booleans, or tagged tables (see encode()).
-- Ids are stable for the life of the process: the ScreenGui is 1 and the story target Frame is 2.

local roblox = require("@lune/roblox")
local task = require("@lune/task")

local Enum = roblox.Enum
local db = roblox.getReflectionDatabase()
local nativeTypeof = typeof

local Gui = {}
Gui.__index = Gui

-- Properties streamed to the renderer when the instance's class has them.
local STREAMED = {
	"Size", "Position", "AnchorPoint", "ZIndex", "LayoutOrder", "AutomaticSize", "SizeConstraint",
	"BackgroundColor3", "BackgroundTransparency", "BorderSizePixel", "BorderColor3", "BorderMode",
	"Visible", "ClipsDescendants", "Rotation", "Active", "Interactable", "Selectable",
	"Text", "TextColor3", "TextSize", "TextScaled", "TextWrapped", "FontFace", "TextXAlignment",
	"TextYAlignment", "RichText", "TextTransparency", "TextStrokeColor3", "TextStrokeTransparency",
	"TextTruncate", "LineHeight", "MaxVisibleGraphemes", "PlaceholderText", "PlaceholderColor3",
	"TextEditable", "MultiLine", "ClearTextOnFocus",
	"Image", "ImageColor3", "ImageTransparency", "ScaleType", "SliceCenter", "SliceScale", "TileSize",
	"ImageRectOffset", "ImageRectSize", "AutoButtonColor", "HoverImage", "PressedImage",
	"CanvasSize", "CanvasPosition", "AutomaticCanvasSize", "ScrollingDirection", "ScrollBarThickness",
	"ScrollBarImageColor3", "ScrollBarImageTransparency", "ScrollingEnabled",
	"GroupTransparency", "GroupColor3",
	"Enabled", "IgnoreGuiInset", "ZIndexBehavior", "DisplayOrder", "ScreenInsets",
	"FillDirection", "Padding", "HorizontalAlignment", "VerticalAlignment", "SortOrder", "HorizontalFlex",
	"VerticalFlex", "ItemLineAlignment", "Wraps", "CellSize", "CellPadding", "FillDirectionMaxCells",
	"StartCorner", "PaddingLeft", "PaddingRight", "PaddingTop", "PaddingBottom", "CornerRadius",
	"Color", "Thickness", "Transparency", "ApplyStrokeMode", "LineJoinMode", "Offset",
	"AspectRatio", "AspectType", "DominantAxis", "MinSize", "MaxSize", "Scale", "MinTextSize",
	"MaxTextSize", "FlexMode", "GrowRatio", "ShrinkRatio",
}
local STREAMED_SET = {}
for _, name in STREAMED do
	STREAMED_SET[name] = true
end

local classProps = {} -- className -> { name }

local function hasProperty(className: string, prop: string): boolean
	local current = className
	while current do
		local class = db:GetClass(current)
		if not class then
			return false
		end
		if class.Properties[prop] ~= nil then
			return true
		end
		current = class.Superclass
	end
	return false
end

local function propsOf(className: string)
	local list = classProps[className]
	if not list then
		list = {}
		for _, name in STREAMED do
			if hasProperty(className, name) then
				table.insert(list, name)
			end
		end
		classProps[className] = list
	end
	return list
end

local function num(n: number): number
	if n ~= n then
		return 0
	end
	if n == math.huge then
		return 1e9
	elseif n == -math.huge then
		return -1e9
	end
	return n
end

local function enumParts(item): (string, string)
	local text = tostring(item) -- Enum.TextXAlignment.Center
	local enumName, itemName = string.match(text, "^Enum%.([%w_]+)%.([%w_]+)$")
	return enumName or "?", itemName or text
end

-- Encodes a property value for JSON. Unknown types return nil (not streamed).
local function encode(value, idOf)
	local kind = nativeTypeof(value)
	if kind == "number" then
		return num(value)
	elseif kind == "string" or kind == "boolean" then
		return value
	elseif kind == "UDim2" then
		return { t = "UDim2", v = { num(value.X.Scale), num(value.X.Offset), num(value.Y.Scale), num(value.Y.Offset) } }
	elseif kind == "UDim" then
		return { t = "UDim", v = { num(value.Scale), num(value.Offset) } }
	elseif kind == "Vector2" then
		return { t = "Vector2", v = { num(value.X), num(value.Y) } }
	elseif kind == "Vector3" then
		return { t = "Vector3", v = { num(value.X), num(value.Y), num(value.Z) } }
	elseif kind == "Color3" then
		return { t = "Color3", v = { num(value.R), num(value.G), num(value.B) } }
	elseif kind == "EnumItem" then
		local enumName, itemName = enumParts(value)
		return { t = "Enum", e = enumName, v = itemName }
	elseif kind == "Font" then
		local _, weight = enumParts(value.Weight)
		local _, style = enumParts(value.Style)
		return { t = "Font", family = value.Family, weight = weight, style = style }
	elseif kind == "ColorSequence" then
		local out = {}
		for _, k in value.Keypoints do
			table.insert(out, { num(k.Time), num(k.Value.R), num(k.Value.G), num(k.Value.B) })
		end
		return { t = "ColorSequence", v = out }
	elseif kind == "NumberSequence" then
		local out = {}
		for _, k in value.Keypoints do
			table.insert(out, { num(k.Time), num(k.Value) })
		end
		return { t = "NumberSequence", v = out }
	elseif kind == "Rect" then
		return { t = "Rect", v = { num(value.Min.X), num(value.Min.Y), num(value.Max.X), num(value.Max.Y) } }
	elseif kind == "Content" then
		return tostring(value.Uri or "")
	elseif idOf and type(value) == "table" then
		local id = idOf(value)
		if id then
			return { t = "Instance", id = id }
		end
	end
	return nil
end
Gui.encode = encode

-- Decodes a value sent by Forge (control values, edits) into a Roblox datatype.
local function decode(value)
	if type(value) ~= "table" then
		return value
	end
	local v = value.v
	if value.t == "Color3" then
		return roblox.Color3.new(v[1], v[2], v[3])
	elseif value.t == "UDim2" then
		return roblox.UDim2.new(v[1], v[2], v[3], v[4])
	elseif value.t == "UDim" then
		return roblox.UDim.new(v[1], v[2])
	elseif value.t == "Vector2" then
		return roblox.Vector2.new(v[1], v[2])
	elseif value.t == "Enum" then
		return Enum[value.e][value.v]
	end
	return value
end
Gui.decode = decode

---------------------------------------------------------------------------------------------------
-- Tweens: TweenService tweens interpolate over time (the test world applies goals at once).

local function bounceOut(t)
	if t < 1 / 2.75 then
		return 7.5625 * t * t
	elseif t < 2 / 2.75 then
		t -= 1.5 / 2.75
		return 7.5625 * t * t + 0.75
	elseif t < 2.5 / 2.75 then
		t -= 2.25 / 2.75
		return 7.5625 * t * t + 0.9375
	end
	t -= 2.625 / 2.75
	return 7.5625 * t * t + 0.984375
end

-- "In" curves; Out and InOut are derived.
local EASE_IN = {
	Linear = function(t)
		return t
	end,
	Sine = function(t)
		return 1 - math.cos(t * math.pi / 2)
	end,
	Quad = function(t)
		return t * t
	end,
	Cubic = function(t)
		return t * t * t
	end,
	Quart = function(t)
		return t ^ 4
	end,
	Quint = function(t)
		return t ^ 5
	end,
	Exponential = function(t)
		return if t == 0 then 0 else 2 ^ (10 * t - 10)
	end,
	Circular = function(t)
		return 1 - math.sqrt(1 - t * t)
	end,
	Back = function(t)
		local s = 1.70158
		return t * t * ((s + 1) * t - s)
	end,
	Elastic = function(t)
		if t == 0 or t == 1 then
			return t
		end
		return -(2 ^ (10 * t - 10)) * math.sin((t * 10 - 10.75) * (2 * math.pi) / 3)
	end,
	Bounce = function(t)
		return 1 - bounceOut(1 - t)
	end,
}

local function ease(alpha: number, style: string, direction: string): number
	local f = EASE_IN[style] or EASE_IN.Quad
	alpha = math.clamp(alpha, 0, 1)
	if direction == "In" then
		return f(alpha)
	elseif direction == "InOut" then
		if alpha < 0.5 then
			return f(alpha * 2) / 2
		end
		return 1 - f((1 - alpha) * 2) / 2
	end
	return 1 - f(1 - alpha)
end
Gui.ease = ease

local function lerp(a, b, t)
	local kind = nativeTypeof(a)
	if kind == "number" and type(b) == "number" then
		return a + (b - a) * t
	elseif kind == "UDim" then
		return roblox.UDim.new(a.Scale + (b.Scale - a.Scale) * t, a.Offset + (b.Offset - a.Offset) * t)
	elseif kind == "UDim2" or kind == "Color3" or kind == "Vector2" or kind == "Vector3" or kind == "CFrame" then
		return a:Lerp(b, t)
	end
	return if t >= 1 then b else a
end

---------------------------------------------------------------------------------------------------

-- options: { world, emit(event), width, height, device }
function Gui.new(options)
	local self = setmetatable({}, Gui)
	self.world = options.world
	self.emit = options.emit
	self.ids = {} -- inst -> id
	self.byId = {} -- id -> inst
	self.inTree = {} -- inst -> true while it is a descendant of the ScreenGui
	self.nextId = 1
	self.ops = {}
	self.tweens = {} -- tween -> state
	self.device = options.device or "desktop"
	self.width = options.width or 1280
	self.height = options.height or 720
	self.hovered = nil
	self:_installTweens()
	self:_installServices()

	local world = self.world
	local Instance = world.globals.Instance
	local player = world:localPlayer()
	local playerGui = player and player:FindFirstChild("PlayerGui")
	local screen = Instance.new("ScreenGui")
	screen.Name = "ForgePreview"
	screen.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
	screen.IgnoreGuiInset = true
	screen.ResetOnSpawn = false
	self.screen = screen
	self:_track(screen)
	local target = Instance.new("Frame")
	target.Name = "StoryTarget"
	target.Size = roblox.UDim2.fromScale(1, 1)
	target.BackgroundTransparency = 1
	target.BorderSizePixel = 0
	self.target = target
	self:_track(target)
	target.Parent = screen
	if playerGui then
		screen.Parent = playerGui
	end
	self:_emitCreate(screen, nil)
	world.observer = function(inst, key, value)
		self:_observe(inst, key, value)
	end
	self:resize(self.width, self.height)
	return self
end

function Gui:_track(inst): number
	local id = self.ids[inst]
	if not id then
		id = self.nextId
		self.nextId += 1
		self.ids[inst] = id
		self.byId[id] = inst
	end
	return id
end

function Gui:idOf(inst): number?
	return self.ids[inst]
end

function Gui:_props(inst)
	local out = {}
	local idOf = function(x)
		return self.ids[x]
	end
	for _, name in propsOf(inst.ClassName) do
		local ok, value = pcall(function()
			return inst[name]
		end)
		if ok and value ~= nil then
			local encoded = encode(value, idOf)
			if encoded ~= nil then
				out[name] = encoded
			end
		end
	end
	return out
end

function Gui:_emitCreate(inst, parentId)
	local id = self:_track(inst)
	self.inTree[inst] = true
	table.insert(self.ops, {
		op = "create",
		id = id,
		cls = inst.ClassName,
		name = inst.Name,
		parent = parentId,
		props = self:_props(inst),
		path = inst:GetFullName(),
		file = self.world:fileOf(inst),
	})
	self.created = (self.created or 0) + 1
	for _, child in inst:GetChildren() do
		self:_emitCreate(child, id)
	end
end

function Gui:_leaveTree(inst)
	self.inTree[inst] = nil
	for _, child in inst:GetChildren() do
		self:_leaveTree(child)
	end
end

function Gui:_observe(inst, key, value)
	if key == "__destroyed" then
		local id = self.ids[inst]
		if id and self.inTree[inst] ~= nil then
			table.insert(self.ops, { op = "destroy", id = id })
		end
		self.inTree[inst] = nil
		self.tweens[inst] = nil
		return
	end
	if key == "Parent" then
		if inst == self.screen then
			return
		end
		local inside = value ~= nil and self.inTree[value] == true
		if inside then
			if self.ids[inst] and self.inTree[inst] == false then
				-- Back into the tree after leaving it: re-send it whole (props may have changed).
				table.insert(self.ops, { op = "destroy", id = self.ids[inst] })
			end
			if self.inTree[inst] == true then
				table.insert(self.ops, { op = "parent", id = self.ids[inst], parent = self.ids[value] })
			else
				self:_emitCreate(inst, self.ids[value])
			end
		elseif self.inTree[inst] == true then
			table.insert(self.ops, { op = "parent", id = self.ids[inst], parent = nil })
			self:_leaveTree(inst)
			self.inTree[inst] = false
		end
		return
	end
	if self.inTree[inst] ~= true then
		return
	end
	if key == "Name" then
		table.insert(self.ops, { op = "set", id = self.ids[inst], k = "Name", v = tostring(value) })
		return
	end
	if key == "Font" and nativeTypeof(value) == "EnumItem" then
		-- Setting Font updates FontFace in Roblox.
		local ok, face = pcall(roblox.Font.fromEnum, value)
		if ok then
			inst.FontFace = face
		end
		return
	end
	if STREAMED_SET[key] then
		local encoded = encode(value, function(x)
			return self.ids[x]
		end)
		if encoded ~= nil then
			table.insert(self.ops, { op = "set", id = self.ids[inst], k = key, v = encoded })
		end
	end
end

-- Sends queued ops; returns how many went out.
function Gui:flush(): number
	local count = #self.ops
	if count > 0 then
		local ops = self.ops
		self.ops = {}
		-- Only the last of several sets of one property in a frame matters.
		local last = {}
		for i, op in ops do
			if op.op == "set" then
				last[op.id .. "\0" .. op.k] = i
			end
		end
		local kept = {}
		for i, op in ops do
			if op.op ~= "set" or last[op.id .. "\0" .. op.k] == i then
				table.insert(kept, op)
			end
		end
		ops = kept
		count = #ops
		self.emit({ type = "ops", ops = ops })
	end
	return count
end

---------------------------------------------------------------------------------------------------
-- Services the preview drives

function Gui:_installServices()
	local World = getmetatable(self.world)
	local method = World.method
	local host = self
	method("GuiService", "IsTenFootInterface", function()
		return host.device == "console"
	end)
	method("UserInputService", "GetMouseLocation", function()
		return roblox.Vector2.new(host.mouseX or 0, host.mouseY or 0)
	end)
	method("UserInputService", "GetLastInputType", function()
		if host.device == "phone" or host.device == "tablet" then
			return Enum.UserInputType.Touch
		elseif host.device == "console" then
			return Enum.UserInputType.Gamepad1
		end
		return Enum.UserInputType.MouseMovement
	end)
	method("UserInputService", "IsKeyDown", function(_self, keyCode)
		return host.keysDown ~= nil and host.keysDown[keyCode] == true
	end)
	method("UserInputService", "GetFocusedTextBox", function()
		return host.focused
	end)
	local input = self.world.game:GetService("UserInputService")
	input.TouchEnabled = self.device == "phone" or self.device == "tablet"
	input.KeyboardEnabled = self.device == "desktop"
	input.MouseEnabled = self.device == "desktop"
	input.GamepadEnabled = self.device == "console"
end

function Gui:_installTweens()
	local World = getmetatable(self.world)
	local method = World.method
	local host = self
	local Instance = self.world.globals.Instance
	method("TweenService", "Create", function(_self, instance, info, goals)
		if type(goals) ~= "table" then
			error("TweenService:Create: goals must be a table", 2)
		end
		local tween = Instance.new("Tween")
		tween.Instance = instance
		tween.TweenInfo = info
		tween.PlaybackState = Enum.PlaybackState.Begin
		host.tweens[tween] = { instance = instance, info = info, goals = goals, playing = false, elapsed = 0 }
		return tween
	end)
	method("TweenService", "GetValue", function(_self, alpha, style, direction)
		local _, s = enumParts(style or Enum.EasingStyle.Quad)
		local _, d = enumParts(direction or Enum.EasingDirection.Out)
		return ease(alpha, s, d)
	end)
	method("Tween", "Play", function(tween)
		local state = host.tweens[tween]
		if not state then
			return
		end
		-- Another playing tween on the same property stops (Roblox cancels the older one).
		for other, o in host.tweens do
			if other ~= tween and o.playing and o.instance == state.instance then
				for key in state.goals do
					o.goals[key] = nil
				end
			end
		end
		if not state.paused then
			state.elapsed = 0
			state.start = {}
			for key in state.goals do
				state.start[key] = state.instance[key]
			end
		end
		state.paused = false
		state.playing = true
		tween.PlaybackState = Enum.PlaybackState.Playing
	end)
	method("Tween", "Pause", function(tween)
		local state = host.tweens[tween]
		if state and state.playing then
			state.playing = false
			state.paused = true
			tween.PlaybackState = Enum.PlaybackState.Paused
		end
	end)
	method("Tween", "Cancel", function(tween)
		local state = host.tweens[tween]
		if state then
			state.playing = false
			state.paused = false
			tween.PlaybackState = Enum.PlaybackState.Cancelled
		end
	end)
end

-- Advances playing tweens by dt seconds.
function Gui:stepTweens(dt: number)
	for tween, state in self.tweens do
		if not state.playing then
			continue
		end
		state.elapsed += dt
		local info = state.info or {}
		local duration = math.max(info.Time or 1, 1e-6)
		local delayTime = info.DelayTime or 0
		local reverses = info.Reverses == true
		local repeats = info.RepeatCount or 0
		local cycle = duration * (if reverses then 2 else 1) + delayTime
		local t = state.elapsed
		local done = false
		local cycleIndex = math.floor(t / cycle)
		if repeats >= 0 and cycleIndex > repeats then
			done = true
			t = cycle - 1e-9
		else
			t -= cycleIndex * cycle
		end
		local alpha
		if t < delayTime then
			alpha = 0
		else
			local inner = t - delayTime
			if reverses and inner > duration then
				alpha = 1 - (inner - duration) / duration
			else
				alpha = inner / duration
			end
		end
		if done then
			alpha = if reverses then 0 else 1
		end
		local _, style = enumParts(info.EasingStyle or Enum.EasingStyle.Quad)
		local _, direction = enumParts(info.EasingDirection or Enum.EasingDirection.Out)
		local eased = ease(alpha, style, direction)
		for key, goal in state.goals do
			local start = state.start and state.start[key]
			if start ~= nil then
				pcall(function()
					state.instance[key] = lerp(start, goal, eased)
				end)
			end
		end
		if done then
			state.playing = false
			tween.PlaybackState = Enum.PlaybackState.Completed
			tween.Completed:Fire(Enum.PlaybackState.Completed)
		end
	end
end

---------------------------------------------------------------------------------------------------
-- Input from Forge

local function inputObject(typeName: string, state: string, x: number?, y: number?, keyCode)
	return setmetatable({
		UserInputType = Enum.UserInputType[typeName],
		UserInputState = Enum.UserInputState[state],
		KeyCode = keyCode,
		Position = roblox.Vector3.new(x or 0, y or 0, 0),
		Delta = roblox.Vector3.new(0, 0, 0),
	}, { __forgeType = "InputObject" })
end

local function fire(inst, event: string, ...)
	local ok, signal = pcall(function()
		return inst[event]
	end)
	if ok and type(signal) == "table" and signal.Fire then
		signal:Fire(...)
	end
end

local function isA(inst, className: string): boolean
	local ok, result = pcall(function()
		return inst:IsA(className)
	end)
	return ok and result
end

function Gui:resize(width: number, height: number)
	self.width = width
	self.height = height
	local size = roblox.Vector2.new(width, height)
	self.screen.AbsoluteSize = size
	self.screen.AbsolutePosition = roblox.Vector2.new(0, 0)
	local camera = self.world.game:GetService("Workspace").CurrentCamera
	if camera then
		camera.ViewportSize = size
	end
end

-- Handles one decoded input message; returns false for an unknown message.
function Gui:input(msg): boolean
	local kind = msg.type
	local inst = msg.id and self.byId[msg.id]
	local x, y = msg.x or 0, msg.y or 0
	local uis = self.world.game:GetService("UserInputService")
	if kind == "resize" then
		self:resize(msg.width, msg.height)
	elseif kind == "device" then
		self.device = msg.device
	elseif kind == "move" then
		self.mouseX, self.mouseY = x, y
		local io = inputObject("MouseMovement", "Change", x, y)
		fire(uis, "InputChanged", io, false)
		if inst then
			fire(inst, "MouseMoved", x, y)
			fire(inst, "InputChanged", io)
		end
	elseif kind == "enter" and inst then
		fire(inst, "MouseEnter", x, y)
		fire(inst, "InputBegan", inputObject("MouseMovement", "Begin", x, y))
	elseif kind == "leave" and inst then
		fire(inst, "MouseLeave", x, y)
		fire(inst, "InputEnded", inputObject("MouseMovement", "End", x, y))
	elseif kind == "down" then
		local io = inputObject("MouseButton1", "Begin", x, y)
		fire(uis, "InputBegan", io, inst ~= nil)
		if inst then
			fire(inst, "InputBegan", io)
			if isA(inst, "GuiButton") then
				fire(inst, "MouseButton1Down", x, y)
			end
		end
	elseif kind == "up" then
		local io = inputObject("MouseButton1", "End", x, y)
		fire(uis, "InputEnded", io, inst ~= nil)
		if inst then
			fire(inst, "InputEnded", io)
			if isA(inst, "GuiButton") then
				fire(inst, "MouseButton1Up", x, y)
			end
		end
	elseif kind == "click" and inst then
		if isA(inst, "GuiButton") then
			fire(inst, "MouseButton1Click")
			fire(inst, "Activated", inputObject("MouseButton1", "End", x, y), 1)
		end
	elseif kind == "rightclick" and inst then
		if isA(inst, "GuiButton") then
			fire(inst, "MouseButton2Click")
		end
	elseif kind == "focus" and inst then
		self.focused = inst
		fire(inst, "Focused")
		fire(uis, "TextBoxFocused", inst)
	elseif kind == "blur" and inst then
		if self.focused == inst then
			self.focused = nil
		end
		fire(inst, "FocusLost", msg.enter == true, inputObject(if msg.enter then "Keyboard" else "MouseButton1", "Begin"))
		fire(uis, "TextBoxFocusReleased", inst)
	elseif kind == "text" and inst then
		inst.Text = tostring(msg.text or "")
	elseif kind == "scroll" and inst then
		inst.CanvasPosition = roblox.Vector2.new(x, y)
	elseif kind == "key" then
		local ok, keyCode = pcall(function()
			return Enum.KeyCode[msg.key]
		end)
		if ok and keyCode then
			self.keysDown = self.keysDown or {}
			self.keysDown[keyCode] = msg.down == true or nil
			local io = inputObject("Keyboard", if msg.down then "Begin" else "End", nil, nil, keyCode)
			fire(uis, if msg.down then "InputBegan" else "InputEnded", io, self.focused ~= nil)
		end
	elseif kind == "layout" then
		-- Absolute rects the renderer computed: { [id] = {x, y, w, h} }.
		for key, rect in msg.rects or {} do
			local target = self.byId[tonumber(key)]
			if target and target ~= self.screen then
				local size = roblox.Vector2.new(rect[3], rect[4])
				local pos = roblox.Vector2.new(rect[1], rect[2])
				local okSize, current = pcall(function()
					return target.AbsoluteSize
				end)
				if not okSize or current ~= size then
					pcall(function()
						target.AbsoluteSize = size
					end)
				end
				local okPos, currentPos = pcall(function()
					return target.AbsolutePosition
				end)
				if not okPos or currentPos ~= pos then
					pcall(function()
						target.AbsolutePosition = pos
					end)
				end
			end
		end
	elseif kind == "set" and inst then
		inst[msg.k] = decode(msg.v)
	else
		return false
	end
	return true
end

---------------------------------------------------------------------------------------------------
-- UI Labs controls (https://ui-labs.luau.page/docs/controls/adding.html): literals (string, number,
-- boolean, Color3) or control objects { EntryType = "Control", Type, ControlValue, ... } and
-- { EntryType = "ControlGroup", Controls = {...} }.

local function describeOption(value): string
	local kind = nativeTypeof(value)
	if kind == "string" then
		return value
	elseif kind == "number" or kind == "boolean" then
		return tostring(value)
	elseif kind == "EnumItem" then
		local _, name = enumParts(value)
		return name
	end
	return tostring(value)
end

-- Returns a flat list of control descriptors (group = name of the ControlGroup, or nil).
function Gui.parseControls(controls)
	local out = {}
	if type(controls) ~= "table" then
		return out
	end
	local function add(key: string, control, group: string?)
		local kind = nativeTypeof(control)
		local entry = { key = key, group = group }
		if kind == "string" then
			entry.type, entry.value = "String", control
		elseif kind == "number" then
			entry.type, entry.value = "Number", control
		elseif kind == "boolean" then
			entry.type, entry.value = "Boolean", control
		elseif kind == "Color3" then
			entry.type, entry.value = "Color3", encode(control)
		elseif kind == "table" and control.EntryType == "ControlGroup" then
			local keys = {}
			for k in control.Controls or {} do
				table.insert(keys, k)
			end
			table.sort(keys)
			for _, k in keys do
				add(k, control.Controls[k], key)
			end
			return
		elseif kind == "table" and control.EntryType == "Control" then
			entry.type = control.Type
			entry.order = control.Order
			local value = control.ControlValue
			if control.Type == "Choose" then
				entry.options = {}
				for i, option in control.List or {} do
					entry.options[i] = describeOption(option)
				end
				entry.value = control.DefIndex or 1
			elseif control.Type == "EnumList" then
				entry.options = {}
				for name in control.List or {} do
					table.insert(entry.options, name)
				end
				table.sort(entry.options)
				entry.value = control.DefIndex
			elseif control.Type == "RGBA" then
				entry.value = { color = encode(value.Color), transparency = value.Transparency or 0 }
			elseif control.Type == "Object" then
				entry.value = nil
			else
				entry.value = encode(value)
			end
			entry.min = control.Min
			entry.max = control.Max
			entry.step = control.Step
		else
			entry.type, entry.value = "Unsupported", tostring(control)
		end
		table.insert(out, entry)
	end
	local keys = {}
	for k in controls do
		table.insert(keys, k)
	end
	table.sort(keys, function(a, b)
		return tostring(a) < tostring(b)
	end)
	for _, k in keys do
		add(tostring(k), controls[k], nil)
	end
	return out
end

-- Story value for a control (control object or literal) given Forge's value, or its default.
function Gui.controlValue(control, value)
	local kind = nativeTypeof(control)
	if kind == "table" and control.EntryType == "Control" then
		if control.Type == "Choose" then
			local index = if type(value) == "number" then value else (control.DefIndex or 1)
			return control.List[index]
		elseif control.Type == "EnumList" then
			return control.List[if type(value) == "string" then value else control.DefIndex]
		elseif control.Type == "RGBA" then
			if type(value) == "table" and value.color then
				return { Color = decode(value.color), Transparency = value.transparency or 0 }
			end
			return control.ControlValue
		end
		if value == nil then
			return control.ControlValue
		end
		return decode(value)
	end
	if value == nil then
		return control
	end
	return decode(value)
end

return Gui
