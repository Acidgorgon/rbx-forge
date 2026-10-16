--!nocheck
-- RBX Forge Model Lab: runs a block-model build script headlessly and records every part it makes.
-- Nothing touches Roblox. The script is the same ModuleScript "Build in Studio" runs:
--
--   local Kit = require(script.Parent.BlockyKit)
--   return function(model: Model, ctx) ... end
--
-- Instances here are small Luau tables shaped like Roblox's (a Model, Parts, welds, Motor6Ds,
-- attachments...), with the property defaults of Lune's reflection database and the geometry kept
-- exact (Position / Orientation follow CFrame, PivotTo moves every part, Clone remaps references
-- inside the copy). Datatypes (Vector3, CFrame, Color3, Enum...) are Lune's real ones.
-- Prints one JSON line:
--   { ok, parts = { { n, k, s, cf, c, t, m, sh? } }, stats, prints, error? = { message } }
--
--   lune run model_build.luau <BlockyKit.luau> <build.luau>

local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")

local MAX_INSTANCES = 30000
local MAX_PARTS = 12000
local MAX_PRINTS = 200

local CFrame, Vector3, Color3, Enum = roblox.CFrame, roblox.Vector3, roblox.Color3, roblox.Enum

local function emit(result)
	print(serde.encode("json", result))
end

local kitPath, buildPath = process.args[1], process.args[2]
if not kitPath or not buildPath then
	emit({ ok = false, parts = {}, prints = {}, error = { message = "usage: model_build.luau <BlockyKit.luau> <build.luau>" } })
	process.exit(2)
end

local okKit, kitSource = pcall(fs.readFile, kitPath)
local okBuild, buildSource = pcall(fs.readFile, buildPath)
if not okKit or not okBuild then
	emit({ ok = false, parts = {}, prints = {}, error = { message = "cannot read " .. (if okKit then "the build script" else "BlockyKit") } })
	process.exit(2)
end

local prints = {}
local BUILD_CHUNK = '[string "build"]'

-- Errors point at the build script's line, however deep in the kit they are raised.
local function userLine()
	for level = 2, 60 do
		local s, l = debug.info(level, "sl")
		if s == nil then
			break
		end
		if s == BUILD_CHUNK then
			return l
		end
	end
	return nil
end

local function fail(message: string, level: number?)
	local line = userLine()
	error(if line then string.format("%s:%d: %s", BUILD_CHUNK, line, message) else message, 0)
end

---------------------------------------------------------------------------------------------------
-- Classes

local db = roblox.getReflectionDatabase()
local superCache = {}
local function superOf(className: string): string?
	local cached = superCache[className]
	if cached ~= nil then
		return cached or nil
	end
	local class = db:GetClass(className)
	local s = if class then class.Superclass else (if className ~= "Instance" then "Instance" else nil)
	superCache[className] = s or false
	return s
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

-- (known, default) for a property of a class, cached.
local propCache = {}
local function reflected(className: string, key: string): (boolean, any)
	local byClass = propCache[className]
	if not byClass then
		byClass = {}
		propCache[className] = byClass
	end
	local hit = byClass[key]
	if hit then
		return hit[1], hit[2]
	end
	local known, default = false, nil
	local current = className
	while current do
		local class = db:GetClass(current)
		if not class then
			break
		end
		if class.Properties[key] ~= nil then
			known = true
			local ok, value = pcall(function()
				local own = db:GetClass(className)
				local v = own and own.DefaultProperties[key]
				if v == nil then
					v = class.DefaultProperties[key]
				end
				return v
			end)
			default = if ok then value else nil
			break
		end
		current = class.Superclass
	end
	byClass[key] = { known, default }
	return known, default
end

---------------------------------------------------------------------------------------------------
-- Instances

local data = setmetatable({}, { __mode = "k" })
local InstanceMT = { __forgeType = "Instance" }
local methods = {}
local created = 0

local function isInstance(v): boolean
	return type(v) == "table" and data[v] ~= nil
end

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
	local names = {}
	local cur = inst
	while cur do
		table.insert(names, 1, data[cur].Name)
		cur = data[cur].Parent
	end
	return table.concat(names, ".")
end

local function newInstance(className: string)
	if type(className) ~= "string" then
		fail("Instance.new: expected a class name, got " .. typeof(className))
	end
	if className ~= "Instance" and not db:GetClass(className) then
		fail("Unable to create an Instance of type \"" .. className .. "\"")
	end
	created += 1
	if created > MAX_INSTANCES then
		fail("too many instances (limit " .. MAX_INSTANCES .. "); is there a runaway loop?")
	end
	local inst = setmetatable({}, InstanceMT)
	data[inst] = { ClassName = className, Name = className, Parent = nil, children = {}, props = {}, attributes = {}, tags = {} }
	return inst
end

local function setParent(inst, parent)
	local d = data[inst]
	if d.locked then
		fail("The Parent property of " .. d.Name .. " is locked (it was destroyed)")
	end
	if parent ~= nil and not isInstance(parent) then
		fail("Parent must be an Instance or nil, got " .. typeof(parent))
	end
	local cur = parent
	while cur do
		if cur == inst then
			fail("Attempt to set " .. fullName(inst) .. " as its own parent")
		end
		cur = data[cur].Parent
	end
	local old = d.Parent
	if old == parent then
		return
	end
	if old then
		local siblings = data[old].children
		local i = table.find(siblings, inst)
		if i then
			table.remove(siblings, i)
		end
	end
	d.Parent = parent
	if parent then
		table.insert(data[parent].children, inst)
	end
end

local function firstChild(inst, name: string)
	for _, child in data[inst].children do
		if data[child].Name == name then
			return child
		end
	end
	return nil
end

-- Geometry read straight from the stored CFrame (Position / Orientation are views of it).
local function partCFrame(d)
	return d.props.CFrame or CFrame.new()
end

local function orientationOf(cf)
	local x, y, z = cf:ToOrientation()
	return Vector3.new(math.deg(x), math.deg(y), math.deg(z))
end

local function fromOrientation(pos, o)
	return CFrame.new(pos) * CFrame.fromOrientation(math.rad(o.X), math.rad(o.Y), math.rad(o.Z))
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
	if isA(d.ClassName, "BasePart") then
		if key == "Position" then
			return partCFrame(d).Position
		elseif key == "Orientation" or key == "Rotation" then
			return orientationOf(partCFrame(d))
		elseif key == "PivotOffset" then
			return d.props.PivotOffset or CFrame.new()
		end
	elseif key == "WorldCFrame" and d.ClassName == "Attachment" then
		local parent = d.Parent
		local base = if parent and isA(data[parent].ClassName, "BasePart") then partCFrame(data[parent]) else CFrame.new()
		return base * (d.props.CFrame or CFrame.new())
	elseif key == "WorldPosition" and d.ClassName == "Attachment" then
		return self.WorldCFrame.Position
	elseif key == "Position" and d.ClassName == "Attachment" then
		return (d.props.CFrame or CFrame.new()).Position
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
		local known, default = reflected(d.ClassName, key)
		if known then
			return default
		end
		if key:match("^%u") and (key:find("Changed$") or key == "Touched" or key == "ChildAdded" or key == "DescendantAdded") then
			-- Events: connecting is harmless while building.
			return { Connect = function() return { Disconnect = function() end } end, Once = function() return { Disconnect = function() end } end, Wait = function() end }
		end
	end
	fail(tostring(key) .. " is not a valid member of " .. d.ClassName .. " \"" .. fullName(self) .. "\"")
end

InstanceMT.__newindex = function(self, key, value)
	local d = data[self]
	if key == "Parent" then
		setParent(self, value)
		return
	elseif key == "ClassName" then
		fail("Unable to assign property ClassName. Property is read only")
	elseif key == "Name" then
		d.Name = tostring(value)
		return
	end
	if isA(d.ClassName, "BasePart") then
		if key == "Position" then
			if typeof(value) ~= "Vector3" then
				fail("Position must be a Vector3")
			end
			local cf = partCFrame(d)
			d.props.CFrame = cf - cf.Position + value
			return
		elseif key == "Orientation" or key == "Rotation" then
			if typeof(value) ~= "Vector3" then
				fail(key .. " must be a Vector3")
			end
			d.props.CFrame = fromOrientation(partCFrame(d).Position, value)
			return
		elseif key == "CFrame" and typeof(value) ~= "CFrame" then
			fail("CFrame must be a CFrame, got " .. typeof(value))
		elseif key == "Size" then
			if typeof(value) ~= "Vector3" then
				fail("Size must be a Vector3, got " .. typeof(value))
			end
			-- Roblox clamps part sizes to [0.001, 2048].
			value = Vector3.new(math.clamp(value.X, 0.001, 2048), math.clamp(value.Y, 0.001, 2048), math.clamp(value.Z, 0.001, 2048))
		elseif key == "Color" and typeof(value) ~= "Color3" then
			fail("Color must be a Color3, got " .. typeof(value))
		end
	elseif d.ClassName == "Attachment" then
		if key == "Position" then
			local cf = d.props.CFrame or CFrame.new()
			d.props.CFrame = cf - cf.Position + value
			return
		elseif key == "WorldCFrame" or key == "WorldPosition" then
			local parent = d.Parent
			local base = if parent and isA(data[parent].ClassName, "BasePart") then partCFrame(data[parent]) else CFrame.new()
			local world = if key == "WorldPosition" then CFrame.new(value) else value
			d.props.CFrame = base:Inverse() * world
			return
		end
	end
	if type(key) == "string" and d.props[key] == nil then
		local known = reflected(d.ClassName, key)
		if not known and not firstChild(self, key) then
			fail(key .. " is not a valid member of " .. d.ClassName .. " \"" .. fullName(self) .. "\"")
		end
	end
	d.props[key] = value
end

InstanceMT.__tostring = function(self)
	return data[self].Name
end

local function descendants(inst, out)
	for _, child in data[inst].children do
		table.insert(out, child)
		descendants(child, out)
	end
	return out
end

method("Instance", "IsA", function(self, className)
	return isA(data[self].ClassName, className)
end)
method("Instance", "GetChildren", function(self)
	return table.clone(data[self].children)
end)
method("Instance", "GetDescendants", function(self)
	return descendants(self, {})
end)
method("Instance", "FindFirstChild", function(self, name, recursive)
	if recursive then
		for _, inst in descendants(self, {}) do
			if data[inst].Name == name then
				return inst
			end
		end
		return nil
	end
	return firstChild(self, name)
end)
method("Instance", "WaitForChild", function(self, name)
	local child = firstChild(self, name)
	if not child then
		fail(fullName(self) .. " has no child " .. tostring(name) .. " (WaitForChild would wait forever)")
	end
	return child
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
	for _, child in (if recursive then descendants(self, {}) else data[self].children) do
		if isA(data[child].ClassName, className) then
			return child
		end
	end
	return nil
end)
method("Instance", "FindFirstAncestor", function(self, name)
	local cur = data[self].Parent
	while cur do
		if data[cur].Name == name then
			return cur
		end
		cur = data[cur].Parent
	end
	return nil
end)
method("Instance", "FindFirstAncestorOfClass", function(self, className)
	local cur = data[self].Parent
	while cur do
		if data[cur].ClassName == className then
			return cur
		end
		cur = data[cur].Parent
	end
	return nil
end)
method("Instance", "FindFirstAncestorWhichIsA", function(self, className)
	local cur = data[self].Parent
	while cur do
		if isA(data[cur].ClassName, className) then
			return cur
		end
		cur = data[cur].Parent
	end
	return nil
end)
method("Instance", "IsDescendantOf", function(self, other)
	local cur = data[self].Parent
	while cur do
		if cur == other then
			return true
		end
		cur = data[cur].Parent
	end
	return false
end)
method("Instance", "IsAncestorOf", function(self, other)
	return other:IsDescendantOf(self)
end)
method("Instance", "GetFullName", function(self)
	return fullName(self)
end)
method("Instance", "ClearAllChildren", function(self)
	for _, child in table.clone(data[self].children) do
		child:Destroy()
	end
end)
method("Instance", "Destroy", function(self)
	for _, child in table.clone(data[self].children) do
		child:Destroy()
	end
	setParent(self, nil)
	data[self].locked = true
end)
method("Instance", "Remove", function(self)
	setParent(self, nil)
end)
method("Instance", "GetAttribute", function(self, name)
	return data[self].attributes[name]
end)
method("Instance", "GetAttributes", function(self)
	return table.clone(data[self].attributes)
end)
method("Instance", "SetAttribute", function(self, name, value)
	data[self].attributes[name] = value
end)
method("Instance", "AddTag", function(self, tag)
	data[self].tags[tag] = true
end)
method("Instance", "RemoveTag", function(self, tag)
	data[self].tags[tag] = nil
end)
method("Instance", "HasTag", function(self, tag)
	return data[self].tags[tag] == true
end)
method("Instance", "GetTags", function(self)
	local out = {}
	for tag in data[self].tags do
		table.insert(out, tag)
	end
	return out
end)
method("Instance", "GetPropertyChangedSignal", function()
	return { Connect = function() return { Disconnect = function() end } end }
end)
method("Instance", "GetAttributeChangedSignal", function()
	return { Connect = function() return { Disconnect = function() end } end }
end)

-- Clone copies the subtree; references to instances inside the copy (Part0, PrimaryPart...) point
-- at their copies, like Roblox.
method("Instance", "Clone", function(self)
	local map = {}
	local function copy(inst)
		local d = data[inst]
		local c = newInstance(d.ClassName)
		local cd = data[c]
		cd.Name = d.Name
		cd.props = table.clone(d.props)
		cd.attributes = table.clone(d.attributes)
		cd.tags = table.clone(d.tags)
		map[inst] = c
		for _, child in d.children do
			setParent(copy(child), c)
		end
		return c
	end
	local root = copy(self)
	for _, c in map do
		local props = data[c].props
		for k, v in props do
			if isInstance(v) and map[v] then
				props[k] = map[v]
			end
		end
	end
	return root
end)

-- Models and parts -------------------------------------------------------------------------------

local function partsOf(inst)
	local out = {}
	if isA(data[inst].ClassName, "BasePart") then
		table.insert(out, inst)
	end
	for _, x in descendants(inst, {}) do
		if isA(data[x].ClassName, "BasePart") then
			table.insert(out, x)
		end
	end
	return out
end

local function bounds(parts)
	local minV, maxV = nil, nil
	for _, p in parts do
		local d = data[p]
		local cf, s = partCFrame(d), d.props.Size or Vector3.new(4, 1, 2)
		local h = s / 2
		for _, sx in { -1, 1 } do
			for _, sy in { -1, 1 } do
				for _, sz in { -1, 1 } do
					local w = cf:PointToWorldSpace(Vector3.new(sx * h.X, sy * h.Y, sz * h.Z))
					minV = if minV then minV:Min(w) else w
					maxV = if maxV then maxV:Max(w) else w
				end
			end
		end
	end
	return minV, maxV
end

method("PVInstance", "GetPivot", function(self)
	local d = data[self]
	if isA(d.ClassName, "BasePart") then
		return partCFrame(d) * (d.props.PivotOffset or CFrame.new())
	end
	local primary = d.props.PrimaryPart
	if primary and data[primary] then
		return primary:GetPivot()
	end
	if d.props.WorldPivot then
		return d.props.WorldPivot
	end
	local minV, maxV = bounds(partsOf(self))
	if minV then
		return CFrame.new((minV + maxV) / 2)
	end
	return CFrame.new()
end)
method("PVInstance", "PivotTo", function(self, target)
	if typeof(target) ~= "CFrame" then
		fail("PivotTo expects a CFrame, got " .. typeof(target))
	end
	local delta = target * self:GetPivot():Inverse()
	local d = data[self]
	for _, p in partsOf(self) do
		local pd = data[p]
		pd.props.CFrame = delta * partCFrame(pd)
	end
	if not isA(d.ClassName, "BasePart") and d.props.WorldPivot and not d.props.PrimaryPart then
		d.props.WorldPivot = target
	end
end)
method("Model", "SetPrimaryPartCFrame", function(self, cf)
	self:PivotTo(cf)
end)
method("Model", "MoveTo", function(self, pos)
	local pivot = self:GetPivot()
	self:PivotTo(pivot - pivot.Position + pos)
end)
method("Model", "TranslateBy", function(self, delta)
	self:PivotTo(self:GetPivot() + delta)
end)
method("Model", "GetBoundingBox", function(self)
	local minV, maxV = bounds(partsOf(self))
	if not minV then
		return self:GetPivot(), Vector3.zero
	end
	return CFrame.new((minV + maxV) / 2), maxV - minV
end)
method("Model", "GetExtentsSize", function(self)
	local _, size = self:GetBoundingBox()
	return size
end)
method("Model", "GetScale", function()
	return 1
end)
method("Model", "ScaleTo", function()
	fail("Model:ScaleTo is not supported while building; build at the size you want")
end)
method("BasePart", "GetMass", function(self)
	local s = data[self].props.Size or Vector3.new(4, 1, 2)
	return s.X * s.Y * s.Z * 0.7
end)
method("BasePart", "GetConnectedParts", function()
	return {}
end)
method("BasePart", "BreakJoints", function() end)
method("BasePart", "MakeJoints", function() end)
method("BasePart", "SetNetworkOwner", function() end)

---------------------------------------------------------------------------------------------------
-- Datatypes missing from @lune/roblox

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
	return Vector3.new(r * math.cos(theta), r * math.sin(theta), z)
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

local nativeTypeof = typeof
local function forgeTypeof(v)
	if type(v) == "table" then
		if data[v] then
			return "Instance"
		end
		local mt = getmetatable(v)
		if type(mt) == "table" and type(rawget(mt, "__forgeType")) == "string" then
			return mt.__forgeType
		end
	end
	return nativeTypeof(v)
end

---------------------------------------------------------------------------------------------------
-- Sandbox

local function capture(prefix)
	return function(...)
		if #prints >= MAX_PRINTS then
			return
		end
		local parts = {}
		for i = 1, select("#", ...) do
			parts[i] = tostring((select(i, ...)))
		end
		table.insert(prints, prefix .. table.concat(parts, "\t"))
	end
end

local job = newInstance("Folder")
job.Name = "ForgeModelJob"
local kitModule = newInstance("ModuleScript")
kitModule.Name = "BlockyKit"
kitModule.Parent = job
local buildModule = newInstance("ModuleScript")
buildModule.Name = "Build"
buildModule.Parent = job

local env = {}
local kitValue = nil
local kitLoaded = false

local function loadKit()
	if kitLoaded then
		return kitValue
	end
	local okLoad, chunk = pcall(luau.load, kitSource, { debugName = "BlockyKit", environment = env, injectGlobals = false })
	if not okLoad then
		fail("BlockyKit does not compile: " .. tostring(chunk))
	end
	kitValue = chunk()
	kitLoaded = true
	return kitValue
end

local function sandboxRequire(target)
	if target == kitModule or target == "BlockyKit" or target == "./BlockyKit" or target == "@self/BlockyKit" then
		return loadKit()
	end
	if isInstance(target) then
		fail("require: only BlockyKit can be required while building (got " .. fullName(target) .. ")")
	end
	fail("require: only BlockyKit can be required while building (got " .. tostring(target) .. ")")
end

local Instance = {
	new = function(className, parent)
		local inst = newInstance(className)
		if parent ~= nil then
			inst.Parent = parent
		end
		return inst
	end,
}

local globals = {
	Instance = Instance,
	Vector3 = Vector3,
	Vector2 = roblox.Vector2,
	CFrame = CFrame,
	Color3 = Color3,
	BrickColor = roblox.BrickColor,
	Enum = Enum,
	NumberRange = roblox.NumberRange,
	NumberSequence = roblox.NumberSequence,
	NumberSequenceKeypoint = roblox.NumberSequenceKeypoint,
	ColorSequence = roblox.ColorSequence,
	ColorSequenceKeypoint = roblox.ColorSequenceKeypoint,
	UDim = roblox.UDim,
	UDim2 = roblox.UDim2,
	PhysicalProperties = roblox.PhysicalProperties,
	Random = Random,
	math = math,
	string = string,
	table = table,
	utf8 = utf8,
	bit32 = bit32,
	buffer = buffer,
	typeof = forgeTypeof,
	type = type,
	pairs = pairs,
	ipairs = ipairs,
	next = next,
	select = select,
	tostring = tostring,
	tonumber = tonumber,
	error = error,
	assert = assert,
	pcall = pcall,
	xpcall = xpcall,
	unpack = table.unpack,
	setmetatable = setmetatable,
	getmetatable = getmetatable,
	rawget = rawget,
	rawset = rawset,
	rawequal = rawequal,
	rawlen = rawlen,
	print = capture(""),
	warn = capture("warn: "),
	os = { clock = os.clock, time = os.time },
	-- Building is synchronous; waits return at once.
	task = {
		wait = function()
			return 0
		end,
		spawn = function(fn, ...)
			fn(...)
		end,
		defer = function(fn, ...)
			fn(...)
		end,
		delay = function(_, fn, ...)
			fn(...)
		end,
	},
	wait = function()
		return 0
	end,
	require = sandboxRequire,
	script = buildModule,
}
for k, v in globals do
	env[k] = v
end
setmetatable(env, {
	__index = function(_, key)
		if key == "game" or key == "workspace" or key == "Workspace" then
			error(string.format("'%s' is not available while building: build into the model your function gets (Build in Studio puts it in Workspace)", tostring(key)), 2)
		end
		error(string.format("'%s' is not available in the build sandbox", tostring(key)), 2)
	end,
})

---------------------------------------------------------------------------------------------------
-- Run

local model = newInstance("Model")
model.Name = process.args[3] or "BlockModel"
local ctx = { origin = CFrame.new(), preview = true, guard = nil, areaId = process.args[4] }

local okLoad, chunk = pcall(luau.load, buildSource, { debugName = "build", environment = env, injectGlobals = false })
if not okLoad then
	emit({ ok = false, parts = {}, prints = prints, error = { message = (tostring(chunk):gsub("\nstack traceback:.*$", "")) } })
	return
end

-- Errors raised inside the kit or by Lune's datatypes name the build script's line that led there.
local function onError(err)
	local text = tostring(err):gsub("\nstack traceback:.*$", "")
	if not text:find(BUILD_CHUNK, 1, true) then
		local line = userLine()
		if line then
			text = string.format("%s:%d: %s", BUILD_CHUNK, line, text)
		end
	end
	return text
end

local okRun, result = xpcall(chunk, onError)
if okRun then
	if type(result) == "function" then
		okRun, result = xpcall(result, onError, model, ctx)
	elseif result ~= nil then
		okRun, result = false, "the build script must return function(model, ctx) (it returned a " .. forgeTypeof(result) .. ")"
	else
		okRun, result = false, "the build script must end with `return function(model, ctx) ... end`"
	end
end

-- Parts and joints in the model ----------------------------------------------------------------

local function r4(x: number): number
	return math.floor(x * 10000 + 0.5) / 10000
end

local SHORT = { Part = "P", WedgePart = "W", CornerWedgePart = "C", MeshPart = "M", TrussPart = "T", SpawnLocation = "P", Seat = "P", VehicleSeat = "P" }

local parts = {}
local index = {}
local stats = { motors = 0, welds = 0, weldConstraints = 0, attachments = 0, animators = 0, animationControllers = 0, humanoids = 0, anchored = 0, instances = 0 }
local joints = {}
local all = descendants(model, {})
stats.instances = #all
for _, inst in all do
	local d = data[inst]
	local cls = d.ClassName
	if isA(cls, "BasePart") then
		if #parts < MAX_PARTS then
			local cf = partCFrame(d)
			local s = inst.Size
			local c = inst.Color
			local comps = { cf:GetComponents() }
			for i, v in comps do
				comps[i] = r4(v)
			end
			local entry = {
				n = d.Name,
				k = SHORT[cls] or "P",
				s = { r4(s.X), r4(s.Y), r4(s.Z) },
				cf = comps,
				c = { r4(c.R), r4(c.G), r4(c.B) },
			}
			local t = inst.Transparency
			if t and t > 0 then
				entry.t = r4(t)
			end
			local m = inst.Material
			if m and m.Name ~= "Plastic" then
				entry.m = m.Name
			end
			if cls == "Part" then
				local sh = inst.Shape
				if sh and sh.Name ~= "Block" then
					entry.sh = sh.Name
				end
			end
			if inst.Anchored then
				stats.anchored += 1
				entry.a = true
			end
			table.insert(parts, entry)
			index[inst] = #parts
		end
	elseif cls == "Motor6D" then
		stats.motors += 1
		table.insert(joints, inst)
	elseif cls == "Weld" or cls == "ManualWeld" then
		stats.welds += 1
		table.insert(joints, inst)
	elseif cls == "WeldConstraint" then
		stats.weldConstraints += 1
		table.insert(joints, inst)
	elseif cls == "Attachment" then
		stats.attachments += 1
	elseif cls == "Animator" then
		stats.animators += 1
	elseif cls == "AnimationController" then
		stats.animationControllers += 1
	elseif cls == "Humanoid" then
		stats.humanoids += 1
	end
end

-- Assemblies: parts joined by welds and motors. Unanchored parts outside the main one fall apart
-- when the game runs.
local parent = {}
local function find(i)
	while parent[i] and parent[i] ~= i do
		parent[i] = parent[parent[i]] or parent[i]
		i = parent[i]
	end
	return i
end
for i = 1, #parts do
	parent[i] = i
end
for _, j in joints do
	local p0, p1 = data[j].props.Part0, data[j].props.Part1
	local a, b = p0 and index[p0], p1 and index[p1]
	if a and b then
		local ra, rb = find(a), find(b)
		if ra ~= rb then
			parent[ra] = rb
		end
	end
end
local sizes = {}
local hasAnchor = {}
for i = 1, #parts do
	local r = find(i)
	sizes[r] = (sizes[r] or 0) + 1
	if parts[i].a then
		hasAnchor[r] = true
	end
end
local primary = data[model].props.PrimaryPart
local mainRoot = primary and index[primary] and find(index[primary]) or nil
if not mainRoot then
	local best = 0
	for r, n in sizes do
		if n > best then
			best, mainRoot = n, r
		end
	end
end
local loose = 0
local assemblies = 0
for r, n in sizes do
	assemblies += 1
	if r ~= mainRoot and not hasAnchor[r] then
		loose += n
	end
end
stats.assemblies = assemblies
stats.loose = loose
stats.primaryPart = if primary and data[primary] then data[primary].Name else nil
stats.truncated = (#parts >= MAX_PARTS) or nil

if not okRun then
	emit({ ok = false, parts = parts, stats = stats, prints = prints, error = { message = tostring(result) } })
	return
end
emit({ ok = true, name = data[model].Name, parts = parts, stats = stats, prints = prints })
