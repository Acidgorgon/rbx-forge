--!nocheck
-- A small Roblox-like world for running ModuleScripts under Lune, without Studio.
--
-- The instance tree comes from a Rojo sourcemap (name, className, filePaths, children). Every
-- ModuleScript with a .luau/.lua file can be required by instance (`require(script.Parent.X)`,
-- `require(ReplicatedStorage.Shared.Modules.X)`). Instances, services and signals here are plain
-- Luau tables shaped like Roblox's; datatypes (Vector3, CFrame, Color3, UDim2, Enum, ...) are Lune's
-- real ones from @lune/roblox. Engine features (physics, rendering, replication, HTTP) are stubs.

local fs = require("@lune/fs")
local luau = require("@lune/luau")
local task = require("@lune/task")
local serde = require("@lune/serde")
local roblox = require("@lune/roblox")
local datetime = require("@lune/datetime")
local Signal = require("./signal")

local G = getfenv(0)
local nativeTypeof = typeof
local nativeRequire = require
local db = roblox.getReflectionDatabase()
local clockStart = os.clock()

local data = setmetatable({}, { __mode = "k" }) -- instance -> state
local InstanceMT = {}

local function isInstance(value): boolean
	return type(value) == "table" and data[value] ~= nil
end

local function forgeTypeof(value): string
	if type(value) == "table" then
		if data[value] then
			return "Instance"
		end
		local kind = Signal.kinds[value]
		if kind then
			return kind
		end
		local mt = getmetatable(value)
		if type(mt) == "table" and type(rawget(mt, "__forgeType")) == "string" then
			return mt.__forgeType
		end
	end
	return nativeTypeof(value)
end

---------------------------------------------------------------------------------------------------
-- Class hierarchy, events and default properties. The reflection database bundled with Lune knows
-- classes, superclasses and property defaults; events are listed here.

local SUPER_OVERRIDES = {
	Instance = nil,
}

local function superOf(className: string): string?
	if SUPER_OVERRIDES[className] ~= nil then
		return SUPER_OVERRIDES[className]
	end
	local class = db:GetClass(className)
	if class then
		return class.Superclass
	end
	if className ~= "Instance" then
		return "Instance"
	end
	return nil
end

local function isA(className: string, target: string): boolean
	local current = className
	while current do
		if current == target then
			return true
		end
		current = superOf(current)
	end
	return false
end

local EVENTS = {
	Instance = {
		"Changed",
		"ChildAdded",
		"ChildRemoved",
		"DescendantAdded",
		"DescendantRemoving",
		"AncestryChanged",
		"Destroying",
		"AttributeChanged",
	},
	DataModel = { "Close", "Loaded" },
	Players = { "PlayerAdded", "PlayerRemoving" },
	Player = { "CharacterAdded", "CharacterRemoving", "CharacterAppearanceLoaded", "Chatted", "Idle" },
	RunService = {
		"Heartbeat",
		"Stepped",
		"RenderStepped",
		"PreRender",
		"PreSimulation",
		"PostSimulation",
		"PreAnimation",
	},
	UserInputService = {
		"InputBegan",
		"InputEnded",
		"InputChanged",
		"TouchStarted",
		"TouchEnded",
		"TouchMoved",
		"TouchTap",
		"LastInputTypeChanged",
		"JumpRequest",
		"WindowFocused",
		"WindowFocusReleased",
		"GamepadConnected",
		"GamepadDisconnected",
	},
	BasePart = { "Touched", "TouchEnded" },
	Humanoid = { "Died", "HealthChanged", "Running", "Jumping", "StateChanged", "MoveToFinished", "Seated" },
	BindableEvent = { "Event" },
	RemoteEvent = { "OnServerEvent", "OnClientEvent" },
	UnreliableRemoteEvent = { "OnServerEvent", "OnClientEvent" },
	Tween = { "Completed" },
	AnimationTrack = { "Stopped", "Ended", "DidLoop", "KeyframeReached" },
	Sound = { "Ended", "Played", "Paused", "Resumed", "Stopped", "Loaded" },
	GuiButton = { "Activated", "MouseButton1Click", "MouseButton1Down", "MouseButton1Up", "MouseButton2Click" },
	GuiObject = { "MouseEnter", "MouseLeave", "InputBegan", "InputEnded", "InputChanged" },
	TextBox = { "FocusLost", "Focused" },
	ProximityPrompt = { "Triggered", "TriggerEnded", "PromptShown", "PromptHidden" },
	ClickDetector = { "MouseClick", "MouseHoverEnter", "MouseHoverLeave" },
	MarketplaceService = {
		"PromptGamePassPurchaseFinished",
		"PromptProductPurchaseFinished",
		"PromptPurchaseFinished",
	},
	TextChatService = { "MessageReceived", "SendingMessage" },
	Camera = {},
}

local function isEvent(className: string, key: string): boolean
	local current = className
	while current do
		local list = EVENTS[current]
		if list and table.find(list, key) then
			return true
		end
		current = superOf(current)
	end
	return false
end

-- Returns (true, default) when the reflection database lists `key` as a property of the class.
local function reflectedProperty(className: string, key: string): (boolean, any)
	local current = className
	while current do
		local class = db:GetClass(current)
		if not class then
			return false, nil
		end
		if class.Properties[key] ~= nil then
			-- The concrete class's defaults win (Part.Size differs from BasePart's).
			local ok, default = pcall(function()
				local own = db:GetClass(className)
				local value = own and own.DefaultProperties[key]
				if value == nil then
					value = class.DefaultProperties[key]
				end
				return value
			end)
			return true, if ok then default else nil
		end
		current = class.Superclass
	end
	return false, nil
end

---------------------------------------------------------------------------------------------------
-- Instances

local methods = {} -- [className] = { [name] = fn }; "Instance" holds the base methods
local World = {}
World.__index = World

local function method(className: string, name: string, fn)
	methods[className] = methods[className] or {}
	methods[className][name] = fn
end

local function findMethod(className: string, key: string)
	local current = className
	while current do
		local list = methods[current]
		if list and list[key] then
			return list[key]
		end
		current = superOf(current)
	end
	return nil
end

local function fullName(inst): string
	local parts = {}
	local current = inst
	while current do
		local d = data[current]
		if d.ClassName == "DataModel" then
			break
		end
		table.insert(parts, 1, d.Name)
		current = d.Parent
	end
	return table.concat(parts, ".")
end

local function signalOf(inst, name: string)
	local d = data[inst]
	local signal = d.signals[name]
	if not signal then
		signal = Signal.new(name)
		d.signals[name] = signal
	end
	return signal
end

-- Fires a signal only if someone made it (connected or waited).
local function fireIfAny(inst, name: string, ...)
	local signal = data[inst].signals[name]
	if signal then
		signal:Fire(...)
	end
end

local function newInstance(world, className: string, name: string?)
	local inst = setmetatable({}, InstanceMT)
	data[inst] = {
		world = world,
		ClassName = className,
		Name = name or className,
		Parent = nil,
		children = {},
		props = {},
		attributes = {},
		tags = {},
		signals = {},
		propSignals = {},
		attrSignals = {},
	}
	local setup = world and world._setup[className]
	if setup then
		setup(inst, world)
	end
	return inst
end

local function setParent(inst, parent)
	local d = data[inst]
	if d.parentLocked then
		error(`The Parent property of {d.Name} is locked, current parent: NULL, new parent {parent and data[parent].Name or "NULL"}`, 3)
	end
	if parent ~= nil and not isInstance(parent) then
		error("Parent must be an Instance or nil", 3)
	end
	local current = parent
	while current do
		if current == inst then
			error(`Attempt to set {fullName(inst)} as its own parent`, 3)
		end
		current = data[current].Parent
	end
	local old = d.Parent
	if old == parent then
		return
	end
	if old then
		local siblings = data[old].children
		local index = table.find(siblings, inst)
		if index then
			table.remove(siblings, index)
		end
		fireIfAny(old, "ChildRemoved", inst)
	end
	d.Parent = parent
	if parent then
		table.insert(data[parent].children, inst)
		fireIfAny(parent, "ChildAdded", inst)
		local ancestor = parent
		while ancestor do
			fireIfAny(ancestor, "DescendantAdded", inst)
			ancestor = data[ancestor].Parent
		end
	end
	fireIfAny(inst, "AncestryChanged", inst, parent)
	local signal = d.propSignals.Parent
	if signal then
		signal:Fire()
	end
	fireIfAny(inst, "Changed", "Parent")
end

local function firstChild(inst, name: string)
	for _, child in data[inst].children do
		if data[child].Name == name then
			return child
		end
	end
	return nil
end

InstanceMT.__index = function(self, key)
	local d = data[self]
	if key == "Name" or key == "ClassName" or key == "Parent" then
		return d[key]
	end
	local fn = findMethod(d.ClassName, key)
	if fn then
		return fn
	end
	local value = d.props[key]
	if value ~= nil then
		return value
	end
	if type(key) == "string" then
		local child = firstChild(self, key)
		if child then
			return child
		end
		if isEvent(d.ClassName, key) then
			return signalOf(self, key)
		end
		local known, default = reflectedProperty(d.ClassName, key)
		if known then
			return default
		end
	end
	error(`{tostring(key)} is not a valid member of {d.ClassName} "{fullName(self)}"`, 2)
end

InstanceMT.__newindex = function(self, key, value)
	local d = data[self]
	if key == "Parent" then
		setParent(self, value)
		return
	elseif key == "ClassName" then
		error("Unable to assign property ClassName. Property is read only", 2)
	elseif key == "Name" then
		d.Name = tostring(value)
	else
		d.props[key] = value
	end
	local signal = d.propSignals[key]
	if signal then
		signal:Fire()
	end
	if key == "Value" and isA(d.ClassName, "ValueBase") then
		fireIfAny(self, "Changed", value)
	else
		fireIfAny(self, "Changed", key)
	end
end

InstanceMT.__tostring = function(self)
	return data[self].Name
end

InstanceMT.__forgeType = "Instance"

-- Base Instance methods ---------------------------------------------------------------------------

method("Instance", "IsA", function(self, className)
	return isA(data[self].ClassName, className)
end)

method("Instance", "GetFullName", function(self)
	return fullName(self)
end)

method("Instance", "GetChildren", function(self)
	return table.clone(data[self].children)
end)

method("Instance", "GetDescendants", function(self)
	local out = {}
	local function walk(inst)
		for _, child in data[inst].children do
			table.insert(out, child)
			walk(child)
		end
	end
	walk(self)
	return out
end)

method("Instance", "FindFirstChild", function(self, name, recursive)
	local child = firstChild(self, name)
	if child or not recursive then
		return child
	end
	for _, descendant in self:GetDescendants() do
		if data[descendant].Name == name then
			return descendant
		end
	end
	return nil
end)

method("Instance", "FindFirstDescendant", function(self, name)
	return self:FindFirstChild(name, true)
end)

method("Instance", "FindFirstChildOfClass", function(self, className)
	for _, child in data[self].children do
		if data[child].ClassName == className then
			return child
		end
	end
	return nil
end)

method("Instance", "FindFirstChildWhichIsA", function(self, className, recursive)
	local list = if recursive then self:GetDescendants() else data[self].children
	for _, child in list do
		if isA(data[child].ClassName, className) then
			return child
		end
	end
	return nil
end)

method("Instance", "FindFirstAncestor", function(self, name)
	local current = data[self].Parent
	while current do
		if data[current].Name == name then
			return current
		end
		current = data[current].Parent
	end
	return nil
end)

method("Instance", "FindFirstAncestorOfClass", function(self, className)
	local current = data[self].Parent
	while current do
		if data[current].ClassName == className then
			return current
		end
		current = data[current].Parent
	end
	return nil
end)

method("Instance", "FindFirstAncestorWhichIsA", function(self, className)
	local current = data[self].Parent
	while current do
		if isA(data[current].ClassName, className) then
			return current
		end
		current = data[current].Parent
	end
	return nil
end)

-- Without a timeout Roblox waits forever; in tests that hides the real failure, so Forge gives up
-- after 5 seconds with an error naming the missing child.
method("Instance", "WaitForChild", function(self, name, timeout)
	local child = firstChild(self, name)
	if child then
		return child
	end
	local limit = timeout or 5
	local started = os.clock()
	while os.clock() - started < limit do
		task.wait()
		child = firstChild(self, name)
		if child then
			return child
		end
	end
	if timeout then
		return nil
	end
	error(`WaitForChild: {name} never appeared in {fullName(self)} (Forge stops waiting after 5s in tests)`, 2)
end)

method("Instance", "IsDescendantOf", function(self, ancestor)
	local current = data[self].Parent
	while current do
		if current == ancestor then
			return true
		end
		current = data[current].Parent
	end
	return false
end)

method("Instance", "IsAncestorOf", function(self, descendant)
	return isInstance(descendant) and descendant:IsDescendantOf(self)
end)

method("Instance", "ClearAllChildren", function(self)
	for _, child in table.clone(data[self].children) do
		child:Destroy()
	end
end)

method("Instance", "Destroy", function(self)
	local d = data[self]
	if d.destroyed then
		return
	end
	fireIfAny(self, "Destroying")
	for _, child in table.clone(d.children) do
		child:Destroy()
	end
	setParent(self, nil)
	d.destroyed = true
	d.parentLocked = true
	for _, signal in d.signals do
		signal:DisconnectAll()
	end
end)

method("Instance", "Clone", function(self)
	local d = data[self]
	local copy = newInstance(d.world, d.ClassName, d.Name)
	local c = data[copy]
	c.props = table.clone(d.props)
	c.attributes = table.clone(d.attributes)
	c.tags = table.clone(d.tags)
	c.file = d.file
	for _, child in d.children do
		local childCopy = child:Clone()
		setParent(childCopy, copy)
	end
	return copy
end)

method("Instance", "GetAttribute", function(self, name)
	return data[self].attributes[name]
end)

method("Instance", "GetAttributes", function(self)
	return table.clone(data[self].attributes)
end)

method("Instance", "SetAttribute", function(self, name, value)
	local d = data[self]
	if type(value) == "table" or type(value) == "function" or type(value) == "thread" then
		error(`SetAttribute: {forgeTypeof(value)} is not a supported attribute type`, 2)
	end
	if d.attributes[name] == value then
		return
	end
	d.attributes[name] = value
	local signal = d.attrSignals[name]
	if signal then
		signal:Fire()
	end
	fireIfAny(self, "AttributeChanged", name)
end)

method("Instance", "GetAttributeChangedSignal", function(self, name)
	local d = data[self]
	d.attrSignals[name] = d.attrSignals[name] or Signal.new("AttributeChanged:" .. name)
	return d.attrSignals[name]
end)

method("Instance", "GetPropertyChangedSignal", function(self, name)
	local d = data[self]
	d.propSignals[name] = d.propSignals[name] or Signal.new("PropertyChanged:" .. name)
	return d.propSignals[name]
end)

method("Instance", "AddTag", function(self, tag)
	local d = data[self]
	if d.tags[tag] then
		return
	end
	d.tags[tag] = true
	if d.world then
		d.world:_tagChanged(self, tag, true)
	end
end)

method("Instance", "RemoveTag", function(self, tag)
	local d = data[self]
	if not d.tags[tag] then
		return
	end
	d.tags[tag] = nil
	if d.world then
		d.world:_tagChanged(self, tag, false)
	end
end)

method("Instance", "HasTag", function(self, tag)
	return data[self].tags[tag] == true
end)

method("Instance", "GetTags", function(self)
	local out = {}
	for tag in data[self].tags do
		table.insert(out, tag)
	end
	table.sort(out)
	return out
end)

method("Instance", "GetActor", function()
	return nil
end)

---------------------------------------------------------------------------------------------------
-- Services and engine classes. Stubs keep the API shape; engine-only behaviour is a no-op.

local function noop() end

local function notInTests(what: string)
	return function()
		error(`{what} is not available in Forge's Lune tests; mock it or test this in Studio`, 2)
	end
end

method("DataModel", "GetService", function(self, name)
	local d = data[self]
	for _, child in d.children do
		if data[child].ClassName == name then
			return child
		end
	end
	if not db:GetClass(name) and not methods[name] then
		error(`'{tostring(name)}' is not a valid Service name`, 2)
	end
	local service = newInstance(d.world, name, name)
	setParent(service, self)
	return service
end)

method("DataModel", "FindService", function(self, name)
	for _, child in data[self].children do
		if data[child].ClassName == name then
			return child
		end
	end
	return nil
end)

method("DataModel", "IsLoaded", function()
	return true
end)

method("DataModel", "BindToClose", function(self, fn)
	table.insert(data[self].world.closeHandlers, fn)
end)

-- RunService
method("RunService", "IsServer", function(self)
	return data[self].world.realm == "server"
end)
method("RunService", "IsClient", function(self)
	return data[self].world.realm == "client"
end)
method("RunService", "IsStudio", function()
	return true
end)
method("RunService", "IsRunning", function()
	return true
end)
method("RunService", "IsRunMode", function()
	return false
end)
method("RunService", "IsEdit", function()
	return false
end)
method("RunService", "BindToRenderStep", noop)
method("RunService", "UnbindFromRenderStep", noop)

-- Players / Player
local function makePlayer(world, name: string, userId: number)
	local player = newInstance(world, "Player", name)
	local d = data[player]
	d.props.UserId = userId
	d.props.DisplayName = name
	d.props.AccountAge = 365
	d.props.MembershipType = roblox.Enum.MembershipType.None
	setParent(newInstance(world, "Backpack", "Backpack"), player)
	setParent(newInstance(world, "PlayerGui", "PlayerGui"), player)
	setParent(newInstance(world, "PlayerScripts", "PlayerScripts"), player)
	return player
end

method("Players", "GetPlayers", function(self)
	local out = {}
	for _, child in data[self].children do
		if data[child].ClassName == "Player" then
			table.insert(out, child)
		end
	end
	return out
end)
method("Players", "GetPlayerByUserId", function(self, userId)
	for _, player in self:GetPlayers() do
		if player.UserId == userId then
			return player
		end
	end
	return nil
end)
method("Players", "GetPlayerFromCharacter", function(self, character)
	for _, player in self:GetPlayers() do
		if data[player].props.Character == character and character ~= nil then
			return player
		end
	end
	return nil
end)
method("Players", "GetNameFromUserIdAsync", function(self, userId)
	return "Player" .. tostring(userId)
end)
method("Players", "GetUserIdFromNameAsync", function()
	return 1
end)

method("Player", "Kick", function(self, message)
	data[self].props.KickMessage = message or ""
	local players = data[self].Parent
	if players then
		fireIfAny(players, "PlayerRemoving", self)
		setParent(self, nil)
	end
end)
method("Player", "LoadCharacter", function(self)
	local d = data[self]
	local world = d.world
	local old = d.props.Character
	if old then
		fireIfAny(self, "CharacterRemoving", old)
		old:Destroy()
	end
	local character = newInstance(world, "Model", d.Name)
	local root = newInstance(world, "Part", "HumanoidRootPart")
	setParent(root, character)
	data[character].props.PrimaryPart = root
	setParent(newInstance(world, "Humanoid", "Humanoid"), character)
	setParent(newInstance(world, "Part", "Head"), character)
	self.Character = character
	setParent(character, world.game:GetService("Workspace"))
	fireIfAny(self, "CharacterAdded", character)
	return character
end)
method("Player", "GetMouse", function(self)
	local d = data[self]
	d.mouse = d.mouse or newInstance(d.world, "Mouse", "Mouse")
	return d.mouse
end)
method("Player", "IsInGroup", function()
	return false
end)
method("Player", "GetRankInGroup", function()
	return 0
end)
method("Player", "GetRoleInGroup", function()
	return "Guest"
end)
method("Player", "HasAppearanceLoaded", function()
	return true
end)
method("Player", "GetJoinData", function()
	return {}
end)

-- Workspace
method("Workspace", "GetServerTimeNow", function()
	return datetime.now().unixTimestampMillis / 1000
end)
method("Workspace", "Raycast", function()
	return nil
end)
method("WorldRoot", "Raycast", function()
	return nil
end)
method("WorldRoot", "Blockcast", function()
	return nil
end)
method("WorldRoot", "Spherecast", function()
	return nil
end)
method("WorldRoot", "Shapecast", function()
	return nil
end)
method("WorldRoot", "GetPartBoundsInBox", function()
	return {}
end)
method("WorldRoot", "GetPartBoundsInRadius", function()
	return {}
end)
method("WorldRoot", "GetPartsInPart", function()
	return {}
end)

-- Models and parts
method("PVInstance", "GetPivot", function(self)
	local d = data[self]
	if d.props.Pivot then
		return d.props.Pivot
	end
	local primary = d.props.PrimaryPart
	if primary then
		return primary.CFrame
	end
	if d.props.CFrame then
		return d.props.CFrame
	end
	return roblox.CFrame.new()
end)
method("PVInstance", "PivotTo", function(self, cframe)
	local d = data[self]
	d.props.Pivot = cframe
	if isA(d.ClassName, "BasePart") then
		self.CFrame = cframe
		self.Position = cframe.Position
	elseif d.props.PrimaryPart then
		d.props.PrimaryPart.CFrame = cframe
	end
end)
method("Model", "SetPrimaryPartCFrame", function(self, cframe)
	self:PivotTo(cframe)
end)
method("Model", "GetBoundingBox", function(self)
	return self:GetPivot(), roblox.Vector3.new(0, 0, 0)
end)
method("Model", "GetExtentsSize", function()
	return roblox.Vector3.new(0, 0, 0)
end)
method("Model", "ScaleTo", noop)
method("Model", "GetScale", function()
	return 1
end)
method("BasePart", "GetMass", function()
	return 1
end)
method("BasePart", "GetTouchingParts", function()
	return {}
end)
method("BasePart", "ApplyImpulse", noop)
method("BasePart", "ApplyAngularImpulse", noop)
method("BasePart", "SetNetworkOwner", noop)
method("BasePart", "SetNetworkOwnershipAuto", noop)
method("BasePart", "CanSetNetworkOwnership", function()
	return true
end)
method("BasePart", "GetNetworkOwner", function()
	return nil
end)

-- Humanoid / animation
method("Humanoid", "TakeDamage", function(self, amount)
	local health = math.max(0, (self.Health or 100) - amount)
	self.Health = health
	fireIfAny(self, "HealthChanged", health)
	if health <= 0 then
		fireIfAny(self, "Died")
	end
end)
method("Humanoid", "MoveTo", function(self, position)
	data[self].props.WalkToPoint = position
	fireIfAny(self, "MoveToFinished", true)
end)
method("Humanoid", "ChangeState", function(self, state)
	data[self].props.__state = state
end)
method("Humanoid", "GetState", function(self)
	return data[self].props.__state or roblox.Enum.HumanoidStateType.Running
end)
method("Humanoid", "SetStateEnabled", noop)
method("Humanoid", "UnequipTools", noop)
method("Humanoid", "EquipTool", noop)
local function loadAnimation(self, animation)
	local track = newInstance(data[self].world, "AnimationTrack", "AnimationTrack")
	data[track].props.Animation = animation
	data[track].props.IsPlaying = false
	return track
end
method("Humanoid", "LoadAnimation", loadAnimation)
method("Animator", "LoadAnimation", loadAnimation)
method("Animator", "GetPlayingAnimationTracks", function()
	return {}
end)
method("AnimationTrack", "Play", function(self)
	data[self].props.IsPlaying = true
end)
method("AnimationTrack", "Stop", function(self)
	data[self].props.IsPlaying = false
	fireIfAny(self, "Stopped")
end)
method("AnimationTrack", "AdjustSpeed", noop)
method("AnimationTrack", "AdjustWeight", noop)
method("AnimationTrack", "GetMarkerReachedSignal", function(self, name)
	return signalOf(self, "Marker:" .. name)
end)

-- Sounds
method("Sound", "Play", function(self)
	data[self].props.IsPlaying = true
	fireIfAny(self, "Played", self.SoundId)
end)
method("Sound", "Stop", function(self)
	data[self].props.IsPlaying = false
	fireIfAny(self, "Stopped", self.SoundId)
end)
method("Sound", "Pause", function(self)
	data[self].props.IsPlaying = false
end)
method("Sound", "Resume", function(self)
	data[self].props.IsPlaying = true
end)
method("SoundService", "PlayLocalSound", noop)

-- Bindables and remotes: remotes loop back inside the one test process.
method("BindableEvent", "Fire", function(self, ...)
	signalOf(self, "Event"):Fire(...)
end)
method("BindableFunction", "Invoke", function(self, ...)
	local callback = data[self].props.OnInvoke
	if not callback then
		error("BindableFunction has no OnInvoke callback", 2)
	end
	return callback(...)
end)
local function remoteFireServer(self, ...)
	local world = data[self].world
	signalOf(self, "OnServerEvent"):Fire(world:localPlayer(), ...)
end
local function remoteFireClient(self, _player, ...)
	signalOf(self, "OnClientEvent"):Fire(...)
end
local function remoteFireAll(self, ...)
	signalOf(self, "OnClientEvent"):Fire(...)
end
for _, className in { "RemoteEvent", "UnreliableRemoteEvent" } do
	method(className, "FireServer", remoteFireServer)
	method(className, "FireClient", remoteFireClient)
	method(className, "FireAllClients", remoteFireAll)
end
method("RemoteFunction", "InvokeServer", function(self, ...)
	local callback = data[self].props.OnServerInvoke
	if not callback then
		error("RemoteFunction has no OnServerInvoke callback", 2)
	end
	return callback(data[self].world:localPlayer(), ...)
end)
method("RemoteFunction", "InvokeClient", function(self, _player, ...)
	local callback = data[self].props.OnClientInvoke
	if not callback then
		error("RemoteFunction has no OnClientInvoke callback", 2)
	end
	return callback(...)
end)

-- TweenService: tweens apply their goals at once when played.
method("TweenService", "Create", function(self, instance, info, goals)
	local tween = newInstance(data[self].world, "Tween", "Tween")
	local d = data[tween]
	d.props.Instance = instance
	d.props.TweenInfo = info
	d.props.PlaybackState = roblox.Enum.PlaybackState.Begin
	d.goals = goals
	return tween
end)
method("TweenService", "GetValue", function(_self, alpha)
	return alpha
end)
method("Tween", "Play", function(self)
	local d = data[self]
	for key, value in d.goals do
		d.props.Instance[key] = value
	end
	d.props.PlaybackState = roblox.Enum.PlaybackState.Completed
	fireIfAny(self, "Completed", roblox.Enum.PlaybackState.Completed)
end)
method("Tween", "Pause", function(self)
	data[self].props.PlaybackState = roblox.Enum.PlaybackState.Paused
end)
method("Tween", "Cancel", function(self)
	data[self].props.PlaybackState = roblox.Enum.PlaybackState.Cancelled
end)

-- HttpService
method("HttpService", "JSONEncode", function(_self, value)
	return serde.encode("json", value)
end)
method("HttpService", "JSONDecode", function(_self, text)
	return serde.decode("json", text)
end)
method("HttpService", "GenerateGUID", function(_self, wrap)
	local hex = string.gsub("xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx", "[xy]", function(c)
		local v = if c == "x" then math.random(0, 15) else math.random(8, 11)
		return string.format("%X", v)
	end)
	return if wrap == false then hex else "{" .. hex .. "}"
end)
method("HttpService", "UrlEncode", function(_self, text)
	return (string.gsub(text, "[^%w%-_%.~]", function(c)
		return string.format("%%%02X", string.byte(c))
	end))
end)
method("HttpService", "GetAsync", notInTests("HttpService:GetAsync"))
method("HttpService", "PostAsync", notInTests("HttpService:PostAsync"))
method("HttpService", "RequestAsync", notInTests("HttpService:RequestAsync"))

-- CollectionService
method("CollectionService", "GetTagged", function(self, tag)
	local out = {}
	for _, inst in data[self].world.game:GetDescendants() do
		if data[inst].tags[tag] then
			table.insert(out, inst)
		end
	end
	return out
end)
method("CollectionService", "AddTag", function(_self, inst, tag)
	inst:AddTag(tag)
end)
method("CollectionService", "RemoveTag", function(_self, inst, tag)
	inst:RemoveTag(tag)
end)
method("CollectionService", "HasTag", function(_self, inst, tag)
	return inst:HasTag(tag)
end)
method("CollectionService", "GetTags", function(_self, inst)
	return inst:GetTags()
end)
method("CollectionService", "GetAllTags", function(self)
	local seen, out = {}, {}
	for _, inst in data[self].world.game:GetDescendants() do
		for tag in data[inst].tags do
			if not seen[tag] then
				seen[tag] = true
				table.insert(out, tag)
			end
		end
	end
	return out
end)
method("CollectionService", "GetInstanceAddedSignal", function(self, tag)
	return signalOf(self, "Added:" .. tag)
end)
method("CollectionService", "GetInstanceRemovedSignal", function(self, tag)
	return signalOf(self, "Removed:" .. tag)
end)

-- DataStoreService: an in-memory store per test file, so data code can be tested.
local function deepCopy(value)
	if type(value) ~= "table" then
		return value
	end
	local out = {}
	for k, v in value do
		out[deepCopy(k)] = deepCopy(v)
	end
	return out
end

local function makeStore(world, className: string, name: string)
	local store = newInstance(world, className, name)
	data[store].values = {}
	return store
end

method("DataStoreService", "GetDataStore", function(self, name, scope)
	local d = data[self]
	d.stores = d.stores or {}
	local key = name .. "/" .. tostring(scope or "global")
	d.stores[key] = d.stores[key] or makeStore(d.world, "DataStore", name)
	return d.stores[key]
end)
method("DataStoreService", "GetGlobalDataStore", function(self)
	return self:GetDataStore("__global")
end)
method("DataStoreService", "GetOrderedDataStore", function(self, name, scope)
	local d = data[self]
	d.ordered = d.ordered or {}
	local key = name .. "/" .. tostring(scope or "global")
	d.ordered[key] = d.ordered[key] or makeStore(d.world, "OrderedDataStore", name)
	return d.ordered[key]
end)
method("DataStoreService", "GetRequestBudgetForRequestType", function()
	return 60
end)
method("GlobalDataStore", "GetAsync", function(self, key)
	return deepCopy(data[self].values[key]), nil
end)
method("GlobalDataStore", "SetAsync", function(self, key, value)
	data[self].values[key] = deepCopy(value)
	return "v1"
end)
method("GlobalDataStore", "UpdateAsync", function(self, key, transform)
	local values = data[self].values
	local nextValue = transform(deepCopy(values[key]), nil)
	if nextValue ~= nil then
		values[key] = deepCopy(nextValue)
	end
	return deepCopy(values[key]), nil
end)
method("GlobalDataStore", "RemoveAsync", function(self, key)
	local values = data[self].values
	local old = values[key]
	values[key] = nil
	return old, nil
end)
method("GlobalDataStore", "IncrementAsync", function(self, key, delta)
	local values = data[self].values
	values[key] = (values[key] or 0) + (delta or 1)
	return values[key]
end)
method("OrderedDataStore", "GetSortedAsync", function(self, ascending, pageSize)
	local entries = {}
	for key, value in data[self].values do
		table.insert(entries, { key = key, value = value })
	end
	table.sort(entries, function(a, b)
		if ascending then
			return a.value < b.value
		end
		return a.value > b.value
	end)
	local page = {}
	for i = 1, math.min(pageSize or 50, #entries) do
		page[i] = entries[i]
	end
	local pages = newInstance(data[self].world, "DataStorePages", "DataStorePages")
	data[pages].props.IsFinished = true
	data[pages].page = page
	return pages
end)
method("Pages", "GetCurrentPage", function(self)
	return data[self].page or {}
end)
method("Pages", "AdvanceToNextPageAsync", noop)

method("MemoryStoreService", "GetSortedMap", notInTests("MemoryStoreService"))
method("MemoryStoreService", "GetQueue", notInTests("MemoryStoreService"))
method("MemoryStoreService", "GetHashMap", notInTests("MemoryStoreService"))
method("MessagingService", "PublishAsync", function(self, topic, message)
	signalOf(self, "Topic:" .. topic):Fire({ Data = message, Sent = os.time() })
end)
method("MessagingService", "SubscribeAsync", function(self, topic, callback)
	return signalOf(self, "Topic:" .. topic):Connect(callback)
end)

-- Input and UI services
method("UserInputService", "IsKeyDown", function()
	return false
end)
method("UserInputService", "IsMouseButtonPressed", function()
	return false
end)
method("UserInputService", "GetMouseLocation", function()
	return roblox.Vector2.new(0, 0)
end)
method("UserInputService", "GetMouseDelta", function()
	return roblox.Vector2.new(0, 0)
end)
method("UserInputService", "GetKeysPressed", function()
	return {}
end)
method("UserInputService", "GetLastInputType", function()
	return roblox.Enum.UserInputType.Keyboard
end)
method("UserInputService", "GetFocusedTextBox", function()
	return nil
end)
method("UserInputService", "GetConnectedGamepads", function()
	return {}
end)
method("ContextActionService", "BindAction", function(self, name, fn)
	local d = data[self]
	d.actions = d.actions or {}
	d.actions[name] = fn
end)
method("ContextActionService", "BindActionAtPriority", function(self, name, fn)
	self:BindAction(name, fn)
end)
method("ContextActionService", "UnbindAction", function(self, name)
	local d = data[self]
	if d.actions then
		d.actions[name] = nil
	end
end)
method("ContextActionService", "UnbindAllActions", function(self)
	data[self].actions = {}
end)
method("ContextActionService", "GetBoundActionInfo", function(self, name)
	local d = data[self]
	return if d.actions and d.actions[name] then {} else nil
end)
method("ContextActionService", "SetTitle", noop)
method("ContextActionService", "SetImage", noop)
method("ContextActionService", "SetPosition", noop)
method("StarterGui", "SetCore", noop)
method("StarterGui", "GetCore", function()
	return nil
end)
method("StarterGui", "SetCoreGuiEnabled", noop)
method("StarterGui", "GetCoreGuiEnabled", function()
	return true
end)
method("GuiService", "IsTenFootInterface", function()
	return false
end)
method("GuiService", "GetGuiInset", function()
	return roblox.Vector2.new(0, 0), roblox.Vector2.new(0, 0)
end)
method("TextService", "GetTextSize", function(_self, text, size)
	return roblox.Vector2.new(#text * size * 0.5, size)
end)
method("TextService", "FilterStringAsync", function(self, text)
	local result = newInstance(data[self].world, "TextFilterResult", "TextFilterResult")
	data[result].text = text
	return result
end)
method("TextFilterResult", "GetNonChatStringForBroadcastAsync", function(self)
	return data[self].text
end)
method("TextFilterResult", "GetNonChatStringForUserAsync", function(self)
	return data[self].text
end)
method("TextFilterResult", "GetChatForUserAsync", function(self)
	return data[self].text
end)

-- Misc services
method("Debris", "AddItem", function(_self, inst, lifetime)
	task.delay(lifetime or 10, function()
		if isInstance(inst) then
			inst:Destroy()
		end
	end)
end)
method("PhysicsService", "RegisterCollisionGroup", noop)
method("PhysicsService", "UnregisterCollisionGroup", noop)
method("PhysicsService", "CollisionGroupSetCollidable", noop)
method("PhysicsService", "CollisionGroupsAreCollidable", function()
	return true
end)
method("PhysicsService", "IsCollisionGroupRegistered", function()
	return true
end)
method("MarketplaceService", "UserOwnsGamePassAsync", function()
	return false
end)
method("MarketplaceService", "PlayerOwnsAsset", function()
	return false
end)
method("MarketplaceService", "GetProductInfo", function()
	return {}
end)
method("MarketplaceService", "PromptGamePassPurchase", noop)
method("MarketplaceService", "PromptProductPurchase", noop)
method("MarketplaceService", "PromptPurchase", noop)
method("BadgeService", "UserHasBadgeAsync", function()
	return false
end)
method("BadgeService", "AwardBadge", function()
	return true
end)
method("TeleportService", "Teleport", noop)
method("TeleportService", "TeleportAsync", noop)
method("TeleportService", "TeleportToPlaceInstance", noop)
method("TeleportService", "GetLocalPlayerTeleportData", function()
	return nil
end)
method("LocalizationService", "GetCountryRegionForPlayerAsync", function()
	return "US"
end)
method("PolicyService", "GetPolicyInfoForPlayerAsync", function()
	return { AreAdsAllowed = false, ArePaidRandomItemsRestricted = false, AllowedExternalLinkReferences = {} }
end)

---------------------------------------------------------------------------------------------------
-- Datatypes missing from @lune/roblox

local TweenInfo = {}
function TweenInfo.new(time, easingStyle, easingDirection, repeatCount, reverses, delayTime)
	return setmetatable({
		Time = time or 1,
		EasingStyle = easingStyle or roblox.Enum.EasingStyle.Quad,
		EasingDirection = easingDirection or roblox.Enum.EasingDirection.Out,
		RepeatCount = repeatCount or 0,
		Reverses = reverses or false,
		DelayTime = delayTime or 0,
	}, { __forgeType = "TweenInfo" })
end

local function paramsType(typeName: string, defaults)
	return {
		new = function()
			local out = table.clone(defaults)
			out.FilterDescendantsInstances = {}
			return setmetatable(out, { __forgeType = typeName })
		end,
	}
end

local RaycastParams = paramsType("RaycastParams", {
	FilterType = roblox.Enum.RaycastFilterType.Exclude,
	IgnoreWater = false,
	CollisionGroup = "Default",
	RespectCanCollide = false,
})
local OverlapParams = paramsType("OverlapParams", {
	FilterType = roblox.Enum.RaycastFilterType.Exclude,
	MaxParts = 0,
	CollisionGroup = "Default",
	RespectCanCollide = false,
})

-- Random with a seed, independent of math.random (32-bit LCG; fine for gameplay tests).
local RandomMT = { __forgeType = "Random" }
RandomMT.__index = RandomMT
local Random = {}
function Random.new(seed)
	local state = math.floor(seed or (os.clock() * 1e6)) % 4294967296
	return setmetatable({ _state = state }, RandomMT)
end
function RandomMT:_next(): number
	self._state = (1664525 * self._state + 1013904223) % 4294967296
	return self._state / 4294967296
end
function RandomMT:NextNumber(min, max)
	min = min or 0
	max = max or 1
	return min + (max - min) * self:_next()
end
function RandomMT:NextInteger(min, max)
	return min + math.floor(self:_next() * (max - min + 1))
end
function RandomMT:NextUnitVector()
	local theta = self:NextNumber(0, 2 * math.pi)
	local z = self:NextNumber(-1, 1)
	local r = math.sqrt(1 - z * z)
	return roblox.Vector3.new(r * math.cos(theta), r * math.sin(theta), z)
end
function RandomMT:Shuffle(list)
	for i = #list, 2, -1 do
		local j = self:NextInteger(1, i)
		list[i], list[j] = list[j], list[i]
	end
end
function RandomMT:Clone()
	return setmetatable({ _state = self._state }, RandomMT)
end

local DateTimeMT = { __forgeType = "DateTime" }
DateTimeMT.__index = DateTimeMT
local DateTime = {}
local function makeDateTime(millis: number)
	return setmetatable({ UnixTimestampMillis = millis, UnixTimestamp = math.floor(millis / 1000) }, DateTimeMT)
end
function DateTime.now()
	return makeDateTime(datetime.now().unixTimestampMillis)
end
function DateTime.fromUnixTimestamp(seconds)
	return makeDateTime(seconds * 1000)
end
function DateTime.fromUnixTimestampMillis(millis)
	return makeDateTime(millis)
end
function DateTime.fromIsoDate(text)
	return makeDateTime(datetime.fromIsoDate(text).unixTimestampMillis)
end
function DateTimeMT:ToIsoDate()
	return datetime.fromUnixTimestamp(self.UnixTimestampMillis / 1000):toIsoDate()
end
function DateTimeMT:ToUniversalTime()
	return datetime.fromUnixTimestamp(self.UnixTimestampMillis / 1000):toUniversalTime()
end
function DateTimeMT:ToLocalTime()
	return datetime.fromUnixTimestamp(self.UnixTimestampMillis / 1000):toLocalTime()
end

---------------------------------------------------------------------------------------------------
-- World

export type SourcemapNode = {
	name: string,
	className: string,
	filePaths: { string }?,
	children: { SourcemapNode }?,
}

local function scriptFile(node: SourcemapNode, root: string): string?
	for _, path in node.filePaths or {} do
		if string.match(path, "%.luau$") or string.match(path, "%.lua$") then
			path = string.gsub(path, "\\", "/")
			if string.sub(path, 1, #root) == root then
				path = string.sub(path, #root + 1)
			end
			return (string.gsub(path, "^%./", ""))
		end
	end
	return nil
end

-- Builds a fresh world. options: { root = "/abs/project/" (trailing slash), tree = SourcemapNode,
-- realm = "server" | "client", log = function(kind, text) }
function World.new(options)
	local self = setmetatable({}, World)
	self.root = options.root or ""
	self.realm = options.realm or "server"
	self.log = options.log or function(_kind, text)
		print(text)
	end
	self.cache = {} -- instance -> { state = "loading" | "done", value }
	self.loadingStack = {}
	self.byFile = {}
	self.closeHandlers = {}
	self.shared = {}
	self._setup = {
		Workspace = function(inst, world)
			local camera = newInstance(world, "Camera", "Camera")
			setParent(camera, inst)
			data[inst].props.CurrentCamera = camera
			setParent(newInstance(world, "Terrain", "Terrain"), inst)
		end,
		StarterPlayer = function(inst, world)
			setParent(newInstance(world, "StarterPlayerScripts", "StarterPlayerScripts"), inst)
			setParent(newInstance(world, "StarterCharacterScripts", "StarterCharacterScripts"), inst)
		end,
		Players = function(inst, world)
			data[inst].props.MaxPlayers = 8
			if world.realm == "client" then
				local player = makePlayer(world, "Player1", 1)
				setParent(player, inst)
				data[inst].props.LocalPlayer = player
			end
		end,
		DataModel = function(inst)
			local props = data[inst].props
			props.PlaceId = 0
			props.GameId = 0
			props.JobId = ""
			props.CreatorId = 0
			props.PlaceVersion = 0
			props.PrivateServerId = ""
			props.PrivateServerOwnerId = 0
		end,
	}

	local tree = options.tree
	local function build(node: SourcemapNode, parent)
		local inst
		if parent and data[parent].ClassName == "DataModel" and db:GetClass(node.className) then
			-- Services exist once; reuse one GetService already made.
			inst = parent:FindService(node.className)
		end
		if not inst then
			inst = newInstance(self, node.className, node.name)
		end
		data[inst].Name = node.name
		local file = scriptFile(node, self.root)
		if file then
			data[inst].file = file
			self.byFile[file] = inst
		end
		for _, child in node.children or {} do
			setParent(build(child, inst), inst)
		end
		return inst
	end

	if tree and tree.className == "DataModel" then
		self.game = newInstance(self, "DataModel", "Game")
		for _, child in tree.children or {} do
			local inst = build(child, self.game)
			setParent(inst, self.game)
		end
	else
		self.game = newInstance(self, "DataModel", "Game")
		if tree then
			setParent(build(tree, self.game), self.game)
		end
	end
	-- Common services always exist, as in a live game.
	for _, name in { "Workspace", "Players", "ReplicatedStorage", "RunService", "ServerScriptService", "ServerStorage", "StarterPlayer", "StarterGui", "Lighting" } do
		self.game:GetService(name)
	end
	self.globals = self:_makeGlobals()
	return self
end

function World:localPlayer()
	local players = self.game:GetService("Players")
	return data[players].props.LocalPlayer
end

function World:addPlayer(name: string?, userId: number?)
	local players = self.game:GetService("Players")
	local count = #players:GetPlayers()
	local player = makePlayer(self, name or ("Player" .. (count + 1)), userId or (count + 1))
	setParent(player, players)
	fireIfAny(players, "PlayerAdded", player)
	return player
end

function World:removePlayer(player)
	local players = self.game:GetService("Players")
	fireIfAny(players, "PlayerRemoving", player)
	setParent(player, nil)
end

-- Fires the per-frame RunService signals once with `dt`.
function World:step(dt: number?)
	local runService = self.game:GetService("RunService")
	dt = dt or 1 / 60
	for _, name in { "PreRender", "RenderStepped", "PreAnimation", "Stepped", "PreSimulation", "PostSimulation", "Heartbeat" } do
		if name == "Stepped" then
			fireIfAny(runService, name, os.clock() - clockStart, dt)
		elseif (name == "RenderStepped" or name == "PreRender") and self.realm ~= "client" then
			continue
		else
			fireIfAny(runService, name, dt)
		end
	end
end

function World:_tagChanged(inst, tag: string, added: boolean)
	local service = self.game:FindService("CollectionService")
	if service then
		fireIfAny(service, (if added then "Added:" else "Removed:") .. tag, inst)
	end
end

function World:_makeGlobals()
	local world = self
	local globals = {}
	globals.game = self.game
	globals.Game = self.game
	globals.workspace = self.game:GetService("Workspace")
	globals.Workspace = globals.workspace
	globals.shared = self.shared
	globals._G = self.shared
	globals.typeof = forgeTypeof
	globals.Instance = {
		new = function(className: string, parent)
			local class = db:GetClass(className)
			if not class and not methods[className] and not EVENTS[className] then
				error(`Unable to create an Instance of type "{className}"`, 2)
			end
			if class and table.find(class.Tags, "Service") then
				error(`Unable to create an Instance of type "{className}"`, 2)
			end
			local inst = newInstance(world, className, className)
			if parent then
				setParent(inst, parent)
			end
			return inst
		end,
	}
	-- Lune's real datatypes.
	for _, name in {
		"Axes",
		"BrickColor",
		"CFrame",
		"Color3",
		"ColorSequence",
		"ColorSequenceKeypoint",
		"Content",
		"Enum",
		"Faces",
		"Font",
		"NumberRange",
		"NumberSequence",
		"NumberSequenceKeypoint",
		"PhysicalProperties",
		"Ray",
		"Rect",
		"Region3",
		"Region3int16",
		"UDim",
		"UDim2",
		"Vector2",
		"Vector2int16",
		"Vector3",
		"Vector3int16",
	} do
		globals[name] = roblox[name]
	end
	globals.TweenInfo = TweenInfo
	globals.RaycastParams = RaycastParams
	globals.OverlapParams = OverlapParams
	globals.Random = Random
	globals.DateTime = DateTime
	local taskLib = table.clone(task)
	taskLib.synchronize = noop
	taskLib.desynchronize = noop
	globals.task = taskLib
	globals.wait = task.wait
	globals.delay = task.delay
	globals.spawn = function(fn, ...)
		return task.defer(fn, ...)
	end
	globals.Delay = task.delay
	globals.Spawn = globals.spawn
	globals.Wait = task.wait
	globals.tick = function()
		return datetime.now().unixTimestampMillis / 1000
	end
	globals.time = function()
		return os.clock() - clockStart
	end
	globals.elapsedTime = globals.time
	globals.version = function()
		return "0.0.0.0"
	end
	globals.settings = function()
		return setmetatable({}, {
			__index = function()
				return setmetatable({}, { __index = function() end })
			end,
		})
	end
	globals.UserSettings = globals.settings
	globals.print = function(...)
		local parts = table.pack(...)
		for i = 1, parts.n do
			parts[i] = tostring(parts[i])
		end
		world.log("print", table.concat(parts, " ", 1, parts.n))
	end
	globals.warn = function(...)
		local parts = table.pack(...)
		for i = 1, parts.n do
			parts[i] = tostring(parts[i])
		end
		world.log("warn", table.concat(parts, " ", 1, parts.n))
	end
	return setmetatable(globals, { __index = G })
end

-- Environment for one script: the world's globals plus `script` and a `require` bound to it.
function World:envFor(inst, file: string?, extra)
	local world = self
	local env = setmetatable({}, { __index = self.globals })
	env.script = inst
	env.require = function(target)
		return world:require(target, file)
	end
	if extra then
		for k, v in extra do
			env[k] = v
		end
	end
	return env
end

function World:compile(file: string, env)
	local ok, source = pcall(fs.readFile, self.root .. file)
	if not ok then
		error(`Could not read {file}: {source}`, 0)
	end
	-- "@path" makes errors and tracebacks read "path:line: message".
	return luau.load(source, { debugName = "@" .. file, environment = env, injectGlobals = false })
end

local function normalize(path: string): string
	local out = {}
	for part in string.gmatch(path, "[^/]+") do
		if part == ".." then
			if #out > 0 and out[#out] ~= ".." then
				table.remove(out)
			else
				table.insert(out, part)
			end
		elseif part ~= "." then
			table.insert(out, part)
		end
	end
	return table.concat(out, "/")
end

local function dirname(path: string): string
	return string.match(path, "^(.*)/[^/]*$") or ""
end

-- require(string) for relative paths and @self, per Luau's require-by-string rules.
function World:_resolveString(target: string, from: string?): string?
	if not from then
		return nil
	end
	local dir = dirname(from)
	local isInit = string.match(from, "/init%.[%w%.]*luau?$") ~= nil or string.match(from, "^init%.") ~= nil
	local rest
	if string.sub(target, 1, 5) == "@self" then
		rest = string.sub(target, 7)
	elseif string.sub(target, 1, 2) == "./" or string.sub(target, 1, 3) == "../" then
		if isInit then
			dir = dirname(dir)
		end
		rest = target
	else
		return nil
	end
	local base = normalize((if dir == "" then "" else dir .. "/") .. rest)
	for _, candidate in { base .. ".luau", base .. ".lua", base .. "/init.luau", base .. "/init.lua" } do
		if fs.isFile(self.root .. candidate) then
			return candidate
		end
	end
	error(`require("{target}"): no module at {base}(.luau|.lua|/init.luau) relative to {from}`, 0)
end

function World:require(target, from: string?)
	if type(target) == "string" then
		if string.sub(target, 1, 6) == "@lune/" then
			return nativeRequire(target)
		end
		local file = self:_resolveString(target, from)
		if not file then
			error(`require("{target}") is not supported in Forge tests: require the ModuleScript instance (e.g. require(script.Parent.X)) or use a relative path`, 2)
		end
		local inst = self.byFile[file]
		if not inst then
			inst = newInstance(self, "ModuleScript", string.match(file, "([^/]+)%.luau?$") or file)
			data[inst].file = file
			self.byFile[file] = inst
		end
		return self:loadModule(inst)
	end
	if type(target) == "number" then
		error("require(assetId) is not supported in Forge tests", 2)
	end
	if not isInstance(target) then
		error("Attempted to call require with invalid argument(s).", 2)
	end
	local d = data[target]
	if d.ClassName ~= "ModuleScript" then
		error(`Attempted to call require with invalid argument(s): {fullName(target)} is a {d.ClassName}, not a ModuleScript`, 2)
	end
	return self:loadModule(target)
end

function World:loadModule(inst)
	local d = data[inst]
	local cached = self.cache[inst]
	if cached then
		if cached.state == "loading" then
			local chain = {}
			for _, item in self.loadingStack do
				table.insert(chain, fullName(item))
			end
			table.insert(chain, fullName(inst))
			error("Requested module was required recursively: " .. table.concat(chain, " -> "), 0)
		end
		return cached.value
	end
	if not d.file then
		error(`{fullName(inst)} has no source file (only Rojo-mapped .luau/.lua files can be required in Forge tests)`, 0)
	end
	local entry = { state = "loading" }
	self.cache[inst] = entry
	table.insert(self.loadingStack, inst)
	local fn = self:compile(d.file, self:envFor(inst, d.file))
	local result = table.pack(pcall(fn))
	table.remove(self.loadingStack)
	if not result[1] then
		self.cache[inst] = nil
		error(result[2], 0)
	end
	if result.n ~= 2 then
		self.cache[inst] = nil
		error(`Module code did not return exactly one value: {d.file}`, 0)
	end
	entry.state = "done"
	entry.value = result[2]
	return entry.value
end

function World:instanceForFile(file: string)
	return self.byFile[file]
end

function World:fileOf(inst): string?
	return isInstance(inst) and data[inst].file or nil
end

World.isInstance = isInstance
World.fullName = fullName
World.typeof = forgeTypeof
World.Signal = Signal
World.isA = isA

return World
