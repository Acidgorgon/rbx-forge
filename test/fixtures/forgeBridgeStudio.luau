-- A tiny fake Roblox Studio for running resources/studio/ForgeBridge.luau under Lune (test/syncPlugin.test.ts).
-- Just enough of the DataModel (Instances with Name/Parent/Source, Changed / DescendantAdded /
-- DescendantRemoving / AncestryChanged signals), HttpService (over @lune/net, JSON encoded the way
-- Roblox does it: an empty table is []) and ScriptEditorService to drive the plugin's Forge Sync
-- against Forge's real bridge.
--
-- lune run forgeBridgeStudio.luau <plugin.luau> <scenario> [link id kept in the place]

local fs = require("@lune/fs")
local luau = require("@lune/luau")
local net = require("@lune/net")
local process = require("@lune/process")
local serde = require("@lune/serde")
local task = require("@lune/task")

local pluginFile, scenario, presetLink = process.args[1], process.args[2], process.args[3]

-- ---------------------------------------------------------------- signals

local Signal = {}
Signal.__index = Signal

function Signal.new()
	return setmetatable({ list = {} }, Signal)
end

function Signal:Connect(fn)
	local conn = { Connected = true }
	function conn.Disconnect()
		conn.Connected = false
	end
	table.insert(self.list, { conn = conn, fn = fn })
	return conn
end

function Signal:Fire(...)
	for _, e in table.clone(self.list) do
		if e.conn.Connected then
			e.fn(...)
		end
	end
end

-- ---------------------------------------------------------------- instances

local data = setmetatable({}, { __mode = "k" })
local SIGNALS = { Changed = true, AttributeChanged = true, AncestryChanged = true, DescendantAdded = true, DescendantRemoving = true }
local SCRIPTS = { Script = true, LocalScript = true, ModuleScript = true }
local methods = {}
local mt = {}

local function chain(inst)
	local out = {}
	while inst do
		table.insert(out, inst)
		inst = data[inst].props.Parent
	end
	return out
end

function methods.GetChildren(self)
	return table.clone(data[self].children)
end

function methods.GetDescendants(self)
	local out = {}
	local function walk(i)
		for _, c in data[i].children do
			table.insert(out, c)
			walk(c)
		end
	end
	walk(self)
	return out
end

function methods.FindFirstChild(self, name)
	for _, c in data[self].children do
		if data[c].props.Name == name then
			return c
		end
	end
	return nil
end

function methods.IsA(self, class)
	local own = data[self].props.ClassName
	if class == own or class == "Instance" then
		return true
	end
	if class == "LuaSourceContainer" then
		return SCRIPTS[own] == true
	end
	if class == "BaseScript" then
		return own == "Script" or own == "LocalScript"
	end
	return false
end

function methods.IsDescendantOf(self, other)
	local node = data[self].props.Parent
	while node do
		if node == other then
			return true
		end
		node = data[node].props.Parent
	end
	return false
end

function methods.GetAttributes(self)
	return table.clone(data[self].attrs)
end

function methods.GetAttribute(self, name)
	return data[self].attrs[name]
end

function methods.SetAttribute(self, name, value)
	data[self].attrs[name] = value
	print("SET ATTRIBUTE " .. tostring(data[self].props.Name) .. "." .. name .. " = " .. tostring(value))
end

function methods.GetPropertyChangedSignal(self, name)
	local d = data[self]
	d.propSignals[name] = d.propSignals[name] or Signal.new()
	return d.propSignals[name]
end

function methods.Destroy(self)
	self.Parent = nil
end

local function setParent(self, parent)
	local d = data[self]
	local old = d.props.Parent
	local moving = { self }
	for _, x in methods.GetDescendants(self) do
		table.insert(moving, x)
	end
	if old then
		for _, a in chain(old) do
			for _, x in moving do
				data[a].signals.DescendantRemoving:Fire(x)
			end
		end
		local list = data[old].children
		table.remove(list, table.find(list, self))
	end
	d.props.Parent = parent
	if parent then
		table.insert(data[parent].children, self)
		for _, a in chain(parent) do
			for _, x in moving do
				data[a].signals.DescendantAdded:Fire(x)
			end
		end
	end
	d.signals.AncestryChanged:Fire(self, parent)
end

mt.__index = function(self, key)
	local d = data[self]
	if methods[key] then
		return methods[key]
	end
	if SIGNALS[key] then
		return d.signals[key]
	end
	return d.props[key]
end

mt.__newindex = function(self, key, value)
	local d = data[self]
	if key == "Parent" then
		setParent(self, value)
	else
		d.props[key] = value
	end
	d.signals.Changed:Fire(key)
	if d.propSignals[key] then
		d.propSignals[key]:Fire()
	end
end

mt.__tostring = function(self)
	return data[self].props.Name
end

local function new(className, name, parent, source)
	local self = setmetatable({}, mt)
	local signals = {}
	for k in SIGNALS do
		signals[k] = Signal.new()
	end
	data[self] = { props = { ClassName = className, Name = name or className }, children = {}, attrs = {}, signals = signals, propSignals = {} }
	if SCRIPTS[className] then
		data[self].props.Source = source or ""
	end
	if parent then
		self.Parent = parent
	end
	return self
end

-- ---------------------------------------------------------------- services

local function encode(v)
	local t = type(v)
	if t == "table" then
		if next(v) == nil then
			return "[]"
		end
		if #v > 0 then
			local parts = {}
			for _, x in v do
				table.insert(parts, encode(x))
			end
			return "[" .. table.concat(parts, ",") .. "]"
		end
		local parts = {}
		for k, x in v do
			table.insert(parts, serde.encode("json", tostring(k)) .. ":" .. encode(x))
		end
		return "{" .. table.concat(parts, ",") .. "}"
	end
	return serde.encode("json", v)
end

local HttpService = {}
function HttpService:JSONEncode(v)
	return encode(v)
end
function HttpService:JSONDecode(s)
	return serde.decode("json", s)
end
function HttpService:UrlEncode(s)
	return (string.gsub(s, "[^%w%-_%.~]", function(c)
		return string.format("%%%02X", string.byte(c))
	end))
end
function HttpService:GenerateGUID(_wrap)
	local hex = "0123456789ABCDEF"
	local out = {}
	for i = 1, 32 do
		local k = math.random(1, 16)
		table.insert(out, string.sub(hex, k, k))
		if i == 8 or i == 12 or i == 16 or i == 20 then
			table.insert(out, "-")
		end
	end
	return table.concat(out)
end

function HttpService:RequestAsync(req)
	local res = net.request({ url = req.Url, method = req.Method, body = req.Body, headers = req.Headers })
	return { Success = res.ok, StatusCode = res.statusCode, Body = res.body }
end

local editorText = {}
local ScriptEditorService = { TextDocumentDidChange = Signal.new() }
function ScriptEditorService:GetEditorSource(inst)
	return editorText[inst] or inst.Source
end

-- ChangeHistoryService: one recording at a time, logged so the test can see the delete was undoable.
local recordingOpen = nil
local nextRecording = 0
local ChangeHistoryService = {}
function ChangeHistoryService:TryBeginRecording(name)
	if recordingOpen then
		return nil
	end
	nextRecording += 1
	recordingOpen = { id = "rec" .. nextRecording, name = name }
	return recordingOpen.id
end
function ChangeHistoryService:FinishRecording(id, op)
	assert(recordingOpen and recordingOpen.id == id, "FinishRecording without TryBeginRecording")
	print("RECORDING " .. tostring(op) .. " " .. recordingOpen.name)
	recordingOpen = nil
end

local stubs = {
	ChangeHistoryService = ChangeHistoryService,
	HttpService = HttpService,
	ScriptEditorService = ScriptEditorService,
	RunService = {
		IsRunning = function()
			return false
		end,
		Heartbeat = Signal.new(),
	},
	CollectionService = {
		GetTags = function()
			return {}
		end,
	},
}

local game = new("DataModel", "Place1")
data[game].props.PlaceId = 0
data[game].props.GameId = 0
function methods.GetService(self, name)
	if stubs[name] then
		return stubs[name]
	end
	return methods.FindFirstChild(self, name) or new(name, name, self)
end

for _, name in { "ReplicatedStorage", "ServerScriptService", "ServerStorage", "StarterPlayer", "Players", "Lighting", "CoreGui" } do
	new(name, name, game)
end
local starterPlayerScripts = new("StarterPlayerScripts", "StarterPlayerScripts", methods.FindFirstChild(game, "StarterPlayer"))
if presetLink and presetLink ~= "" then
	-- The place was linked in Forge earlier (and saved): the plugin finds the link in ServerStorage.
	data[methods.FindFirstChild(game, "ServerStorage")].attrs.ForgeSyncLink = presetLink
end

-- ---------------------------------------------------------------- plugin

local unloading = Signal.new()
local plugin = {
	Unloading = unloading,
	CreateToolbar = function()
		return {
			CreateButton = function()
				return { SetActive = function() end, Click = Signal.new() }
			end,
		}
	end,
	GetSetting = function()
		return nil
	end,
	SetSetting = function() end,
}

local env = {
	game = game,
	plugin = plugin,
	task = task,
	warn = function(...)
		print("WARN", ...)
	end,
	CFrame = {
		new = function()
			return {}
		end,
	},
	Enum = { RunContext = { Legacy = "Legacy" }, FinishRecordingOperation = { Commit = "Commit", Cancel = "Cancel" } },
}
local run = luau.load(fs.readFile(pluginFile), { debugName = "ForgeBridge", environment = env })
run()

-- ---------------------------------------------------------------- scenarios

-- Waits (up to 60 s) for the test to drop a marker file next to the plugin (the run's cwd).
local function waitForMarker(name)
	local waited = 0
	while not fs.isFile(name) and waited < 60 do
		task.wait(0.1)
		waited += 0.1
	end
	print("MARKER " .. name .. (if fs.isFile(name) then "" else " (timed out)"))
end

local function rojoBuildsClient()
	-- What Rojo's Studio plugin creates for StarterPlayerScripts.Client ($path src/client).
	local client = new("Folder", "Client", nil)
	local script = new("LocalScript", "Client", client, "")
	new("Folder", "Controllers", script)
	client.Parent = starterPlayerScripts
	return client, script
end

if scenario == "late-root" then
	-- Studio opened a fresh place; the Forge Bridge started before Rojo built the mapped folders.
	task.wait(1.5)
	local _, script = rojoBuildsClient()
	task.wait(4)
	script.Source = "adawdawdawd"
	task.wait(1.5)
	local controllers = methods.FindFirstChild(script, "Controllers")
	new("ModuleScript", "Shop", controllers, "return {}")
	task.wait(1.5)
elseif scenario == "forge-restart" then
	-- Plugin v12: Forge restarts (or the project is reopened) while this window sits idle with its old
	-- session. The next poll says resync and the plugin checks again without any edit in Studio; the
	-- first edit after that reaches disk through the new session.
	local _, script = rojoBuildsClient()
	waitForMarker("swapped")
	waitForMarker("resynced")
	script.Source = "print(\"after restart\")"
	task.wait(2)
elseif scenario == "editor-only" then
	-- The mapped folders exist from the start; the user types in the Script Editor and Studio has not
	-- written Script.Source (yet).
	local _, script = rojoBuildsClient()
	task.wait(2)
	editorText[script] = "print(\"typed\")"
	ScriptEditorService.TextDocumentDidChange:Fire({
		GetScript = function()
			return script
		end,
	})
	task.wait(1.5)
elseif scenario == "outline-removal" then
	-- Studio-only instances outside the mapped Client folder show in the Game tab outline, then the
	-- user deletes them in Studio: the outline drops them.
	-- While it happens the user keeps typing in a synced script (a steady change stream), which used
	-- to hold the outline back for good.
	local _, client = rojoBuildsClient()
	local starterPlayer = methods.FindFirstChild(game, "StarterPlayer")
	local characterScripts = new("StarterCharacterScripts", "StarterCharacterScripts", starterPlayer)
	task.wait(2)
	local loose = new("LocalScript", "LocalScript", starterPlayerScripts, "print(1)")
	local health = new("Script", "Health", characterScripts, "")
	task.wait(3)
	print("OUTLINE ADDED")
	local typing = true
	task.spawn(function()
		local n = 0
		while typing do
			n += 1
			client.Source = "-- " .. n
			task.wait(0.05)
		end
	end)
	task.wait(0.5)
	loose:Destroy()
	health:Destroy()
	task.wait(14)
	typing = false
	task.wait(0.5)
elseif scenario == "unlinked" then
	-- An unrelated place (a VFX scratch place): Studio has scripts the repo does not. Forge must not
	-- write anything until the user links it, and the first sync after linking waits for a decision.
	local _, script = rojoBuildsClient()
	script.Source = "print(\"vfx place\")"
	new("ModuleScript", "Shop", methods.FindFirstChild(script, "Controllers"), "return { vfx = true }")
	local waited = 0
	while waited < 40 and not methods.GetAttribute(methods.FindFirstChild(game, "ServerStorage"), "ForgeSyncLink") do
		task.wait(0.25)
		waited += 0.25
	end
	task.wait(8)
	print("LINK ATTRIBUTE " .. tostring(methods.GetAttribute(methods.FindFirstChild(game, "ServerStorage"), "ForgeSyncLink")))
elseif scenario == "studio-delete" then
	-- Forge's Game tab deletes a Studio-only LocalScript; the test also sends delete jobs the plugin
	-- must refuse (synced root, its holder, default container, same-name siblings, stale class).
	rojoBuildsClient()
	local starterPlayer = methods.FindFirstChild(game, "StarterPlayer")
	new("StarterCharacterScripts", "StarterCharacterScripts", starterPlayer)
	local rs = methods.FindFirstChild(game, "ReplicatedStorage")
	new("Folder", "Dup", rs)
	new("Folder", "Dup", rs)
	local loose = new("LocalScript", "LocalScript", starterPlayerScripts, "print(1)")
	new("Folder", "Inner", loose)
	local waited = 0
	while loose.Parent ~= nil and waited < 40 do
		task.wait(0.25)
		waited += 0.25
	end
	print(if loose.Parent == nil then "LOOSE DELETED" else "LOOSE STILL THERE")
	task.wait(2)
elseif scenario == "cutscene" or scenario == "duplicate-rename" then
	-- GenTree's onboarding: the ModuleScript OnboardingController holds cutscene modules with child
	-- modules of their own. None of it is on disk yet.
	local _, script = rojoBuildsClient()
	local controllers = methods.FindFirstChild(script, "Controllers")
	local onboarding = new("ModuleScript", "OnboardingController", nil, "return {}")
	local trainer = new("ModuleScript", "TrainerCutscene", onboarding, "return 'trainer'")
	new("ModuleScript", "Shots", trainer, "return 'shots'")
	new("ModuleScript", "Body", trainer, "return 'trainer body'")
	if scenario == "cutscene" then
		local wake = new("ModuleScript", "WakeUpCutscene", onboarding, "return 'wake'")
		for _, n in { "Body", "Lens", "Motion", "Overlay", "Sfx", "Title" } do
			new("ModuleScript", n, wake, "return '" .. n .. "'")
		end
		local props = new("ModuleScript", "Props", wake, "return 'props'")
		new("ModuleScript", "Toon", props, "return 'toon'")
		onboarding.Parent = controllers
		-- Forge's side (the test): "Disk wins", rojo held, "Pull to disk".
		waitForMarker("pulled")
		-- Live: one more child module of WakeUpCutscene.
		new("ModuleScript", "Vignette", wake, "return 'vignette'")
		waitForMarker("vignette")
	else
		onboarding.Parent = controllers
		waitForMarker("synced")
		-- Ctrl+D on TrainerCutscene (a copy with the same name, children included), then rename it.
		local copy = new("ModuleScript", "TrainerCutscene", nil, "return 'trainer'")
		new("ModuleScript", "Shots", copy, "return 'shots'")
		new("ModuleScript", "Body", copy, "return 'trainer body'")
		copy.Parent = onboarding
		task.wait(1)
		copy.Name = "WakeUpCutscene"
		task.wait(1)
		methods.FindFirstChild(copy, "Body").Source = "return 'wake body'"
		methods.FindFirstChild(trainer, "Shots").Source = "return 'trainer shots 2'"
		task.wait(1)
		new("ModuleScript", "Lens", copy, "return 'lens'")
		waitForMarker("renamed")
		-- Then the copy is deleted again; the original keeps syncing.
		copy:Destroy()
		task.wait(1)
		methods.FindFirstChild(trainer, "Body").Source = "return 'trainer body 2'"
		waitForMarker("deleted")
	end
end

print("SCENARIO DONE")
unloading:Fire()
process.exit(0)
