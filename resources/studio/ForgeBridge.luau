--!nonstrict
-- forge-bridge-version: __FORGE_BRIDGE_VERSION__
-- forge-bridge-template: 10
-- Forge Bridge: the Studio side of RBX Forge's "Studio check". RBX Forge writes this plugin into the
-- local Plugins folder; it polls Forge on 127.0.0.1 for jobs. A job plays a VFX Lab effect, an
-- Animation Lab clip or an Ability Composer move on a small stage in front of a fixed camera, while
-- Forge records the Studio window and keeps the frames at the key beats for its critic.
--
-- Thumbnail Lab snapshot jobs build no stage and leave the camera alone: they only find the viewport
-- (key colour) and let Forge grab the view the user framed.
--
-- Everything it creates is removed after each job and the camera is put back. It never runs in play
-- mode and only talks to 127.0.0.1. Studio asks once to allow HTTP requests to 127.0.0.1 and to allow
-- script injection (it creates the job's ModuleScripts from Forge's Luau).
--
-- Forge Sync (plugin version 2; 3 adds the unsynced-reference report; 5 watches for late roots): in edit mode the plugin also streams the scripts and instances under
-- the project's Rojo-mapped roots to Forge (a chunked snapshot, then debounced change events), so Forge
-- can reconcile Studio with disk before Rojo serves. Sync only reads the DataModel.
-- Version 5 adds the Game-tab outline: names and classes (no properties but a few asset ids) of what
-- else sits in the services the project maps, e.g. ReplicatedStorage.Assets, so Forge can show
-- Studio-only instances. Debounced, capped, and re-sent only when it changed.
-- Version 7: the outline keeps up with deletes (it is no longer starved by a busy change stream, and a
-- session Forge forgot starts over instead of failing quietly), and the one write the plugin makes to
-- the place: "Delete in Studio" from the Game tab, which the user confirms in Forge. It removes one
-- Studio-only instance (never a service, a Rojo-mapped root or anything Forge Sync streams to files)
-- inside a ChangeHistoryService recording, so Ctrl+Z in Studio brings it back.
-- Version 8: place linking. Forge only syncs a place linked to the open project (its PlaceId in the
-- project's servePlaceIds, or linked in Forge's Source Control). The config request carries a random
-- id per plugin run (probe) and, for an unpublished place, the ServerStorage attribute ForgeSyncLink.
-- When the user links an unpublished place in Forge, the config answer carries stampLink: the plugin
-- sets that attribute (saved with the place) and asks again. Nothing else is written.
-- Version 9: a renamed, moved or removed instance carries exactly its own subtree in the sync stream.
-- Earlier versions re-pathed and forgot by path, so after Studio's Ctrl+D (a same-name copy) and a
-- rename of the copy the original's scripts were tracked under the copy's new name: edits to them
-- reached disk late or not at all, and the copy's children never did.
-- Version 10: the Model Lab's "Build in Studio" job. It requires the job's Build module (a block-model
-- script next to its BlockyKit module), builds one Model in Workspace in front of the camera inside a
-- ChangeHistoryService recording (Ctrl+Z removes it) and selects it. With a guard path it hands that
-- existing guard Model to the script, which copies its gameplay pieces; nothing else is changed.
--
-- Roblox APIs used (Creator Hub): HttpService:RequestAsync, KeyframeSequenceProvider:
-- RegisterKeyframeSequence, Animator:LoadAnimation / StepAnimations (edit-mode preview),
-- Players:CreateHumanoidModelFromDescription, Camera.CFrame / FieldOfView.

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local Players = game:GetService("Players")
local Lighting = game:GetService("Lighting")
local CoreGui = game:GetService("CoreGui")
local ServerStorage = game:GetService("ServerStorage")
local KeyframeSequenceProvider = game:GetService("KeyframeSequenceProvider")
local CollectionService = game:GetService("CollectionService")

if RunService:IsRunning() then
	return
end

local URL = "http://127.0.0.1:__FORGE_PORT__/forge-bridge"
local VERSION = tonumber("__FORGE_BRIDGE_VERSION__") or 0
local SETTING = "ForgeBridgeEnabled"
local RETRY_SECONDS = 3
local STAGE_ORIGIN = CFrame.new(0, 1500, 0)

local toolbar = plugin:CreateToolbar("RBX Forge")
local button = toolbar:CreateButton("Forge Bridge", "Let RBX Forge play effects, animations and moves here for its Studio check", "")
button.ClickableWhenViewportHidden = true

local enabled = plugin:GetSetting(SETTING) ~= false
local alive = true
local connected = false
button:SetActive(enabled)

button.Click:Connect(function()
	enabled = not enabled
	plugin:SetSetting(SETTING, enabled)
	button:SetActive(enabled)
	print(if enabled then "[Forge Bridge] on" else "[Forge Bridge] off")
end)

local function request(method: string, path: string, body: any?): (boolean, any)
	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = URL .. path,
			Method = method,
			Body = if body ~= nil then HttpService:JSONEncode(body) else nil,
			Headers = if body ~= nil then { ["Content-Type"] = "application/json" } else nil,
		})
	end)
	if not ok or not response.Success then
		return false, if ok then response.StatusCode else response
	end
	local decoded = nil
	pcall(function()
		decoded = HttpService:JSONDecode(response.Body)
	end)
	return true, decoded
end

local function frames(n: number)
	for _ = 1, n do
		RunService.Heartbeat:Wait()
	end
end

-- ------------------------------------------------------------ building

local function buildModules(list: { any }, parent: Instance)
	for _, m in list do
		local inst = Instance.new(if m.className == "Folder" then "Folder" else "ModuleScript")
		inst.Name = m.name
		if inst:IsA("ModuleScript") then
			(inst :: ModuleScript).Source = m.source or "return nil"
		end
		if m.children then
			buildModules(m.children, inst)
		end
		inst.Parent = parent
	end
end

local function propValue(p: any): any
	local v = p.v
	if p.t == "cframe" then
		return CFrame.new(table.unpack(v))
	elseif p.t == "vector3" then
		return Vector3.new(v[1], v[2], v[3])
	elseif p.t == "color3" then
		return Color3.new(v[1], v[2], v[3])
	end
	return v
end

local function buildInstance(data: any, parent: Instance?): Instance
	local inst = Instance.new(data.className)
	inst.Name = data.name
	for key, p in data.props or {} do
		pcall(function()
			(inst :: any)[key] = propValue(p)
		end)
	end
	for _, child in data.children or {} do
		buildInstance(child, inst)
	end
	if parent then
		inst.Parent = parent
	end
	return inst
end

local function pathOf(inst: Instance): { string }
	local names = {}
	local node: Instance? = inst
	while node and node ~= game do
		table.insert(names, 1, node.Name)
		node = node.Parent
	end
	return names
end

-- CoreGui keeps the job out of the saved place and out of Rojo / studio-sync; ServerStorage is the
-- fallback when CoreGui refuses the folder.
local function jobFolder(): Folder
	local folder = Instance.new("Folder")
	folder.Name = "ForgeBridgeJob"
	local ok = pcall(function()
		folder.Parent = CoreGui
	end)
	if not ok then
		folder.Parent = ServerStorage
	end
	return folder
end

local function makeRig(rigType: string): Model
	local ok, rig = pcall(function()
		local description = Instance.new("HumanoidDescription")
		return Players:CreateHumanoidModelFromDescriptionAsync(description, if rigType == "R6" then Enum.HumanoidRigType.R6 else Enum.HumanoidRigType.R15)
	end)
	if not ok or not rig then
		error("could not create the " .. rigType .. " dummy (" .. tostring(rig) .. ")")
	end
	rig.Name = "ForgeDummy"
	local root = rig:FindFirstChild("HumanoidRootPart")
	if root and root:IsA("BasePart") then
		root.Anchored = true
	end
	return rig
end

local function part(name: string, size: Vector3, cframe: CFrame, color: Color3, parent: Instance): Part
	local p = Instance.new("Part")
	p.Name = name
	p.Size = size
	p.CFrame = cframe
	p.Color = color
	p.Material = Enum.Material.SmoothPlastic
	p.Anchored = true
	p.CanCollide = false
	p.CastShadow = false
	p.Locked = true
	p.TopSurface = Enum.SurfaceType.Smooth
	p.BottomSurface = Enum.SurfaceType.Smooth
	p.Parent = parent
	return p
end

local function buildStage(job: any): (Model, Model)
	local stage = Instance.new("Model")
	stage.Name = "ForgeBridgeStage"
	part("Floor", Vector3.new(80, 1, 80), STAGE_ORIGIN * CFrame.new(0, -0.5, 0), Color3.fromRGB(32, 35, 40), stage)
	part("Backdrop", Vector3.new(160, 90, 1), STAGE_ORIGIN * CFrame.new(0, 30, 45), Color3.fromRGB(14, 16, 19), stage)
	local rig = makeRig(job.rig)
	local cf, size = rig:GetBoundingBox()
	local lift = (cf.Position.Y - size.Y / 2) - rig:GetPivot().Position.Y
	rig:PivotTo(STAGE_ORIGIN * CFrame.new(0, -lift, 0))
	rig.Parent = stage
	stage.Parent = workspace
	return stage, rig
end

-- ------------------------------------------------------------ view

local LIGHTING_KEYS = { "ClockTime", "Brightness", "ExposureCompensation", "GlobalShadows" }

local function saveView(): any
	local camera = workspace.CurrentCamera
	local lighting = {}
	for _, key in LIGHTING_KEYS do
		lighting[key] = (Lighting :: any)[key]
	end
	return { cframe = camera.CFrame, focus = camera.Focus, fov = camera.FieldOfView, lighting = lighting }
end

local function setView(job: any)
	local camera = workspace.CurrentCamera
	local c = job.camera
	local pos = STAGE_ORIGIN * Vector3.new(c.pos[1], c.pos[2], c.pos[3])
	local target = STAGE_ORIGIN * Vector3.new(c.target[1], c.target[2], c.target[3])
	camera.FieldOfView = c.fov
	camera.CFrame = CFrame.lookAt(pos, target)
	camera.Focus = CFrame.new(target)
	-- Neutral daylight so every check is lit the same way (restored after the job).
	Lighting.ClockTime = 14
	Lighting.Brightness = 2
	Lighting.ExposureCompensation = 0
	Lighting.GlobalShadows = true
end

local function restoreView(saved: any)
	if not saved then
		return
	end
	local camera = workspace.CurrentCamera
	pcall(function()
		camera.FieldOfView = saved.fov
		camera.CFrame = saved.cframe
		camera.Focus = saved.focus
	end)
	for key, value in saved.lighting do
		pcall(function()
			(Lighting :: any)[key] = value
		end)
	end
end

-- ------------------------------------------------------------ jobs

local function post(job: any, event: any): any
	local ok, answer = request("POST", "/event/" .. job.id, event)
	if not ok then
		error("RBX Forge stopped answering (" .. tostring(answer) .. ")")
	end
	if type(answer) == "table" and answer.abort then
		error("RBX Forge cancelled the check: " .. tostring(answer.reason or "timeout"))
	end
	return answer
end

local function ping(): number
	local t = os.clock()
	request("GET", "/ping")
	return (os.clock() - t) * 1000
end

local function calibrate(job: any)
	local gui = Instance.new("ScreenGui")
	gui.Name = "ForgeBridgeKey"
	gui.IgnoreGuiInset = true
	gui.DisplayOrder = 100000
	local fill = Instance.new("Frame")
	fill.Size = UDim2.fromScale(1, 1)
	fill.BorderSizePixel = 0
	fill.BackgroundColor3 = Color3.fromRGB(job.key[1], job.key[2], job.key[3])
	fill.Parent = gui
	gui.Parent = CoreGui
	frames(4)
	local ok, err = pcall(post, job, { type = "calibrate" })
	gui:Destroy()
	frames(3)
	if not ok then
		error(err, 0)
	end
end

local function loadTrack(job: any, rig: Model): (AnimationTrack?, Animator?, string?)
	if not job.sequence then
		return nil, nil, nil
	end
	local humanoid = rig:FindFirstChildOfClass("Humanoid")
	if not humanoid then
		error("the dummy has no Humanoid")
	end
	local animator = humanoid:FindFirstChildOfClass("Animator") or Instance.new("Animator")
	animator.Parent = humanoid
	local sequence = buildInstance(job.sequence) :: KeyframeSequence
	local id = KeyframeSequenceProvider:RegisterKeyframeSequence(sequence)
	local animation = Instance.new("Animation")
	animation.AnimationId = id
	return (animator :: Animator):LoadAnimation(animation), animator :: Animator, id
end

local function runStepped(job: any, rig: Model)
	local track, animator = loadTrack(job, rig)
	if not track or not animator then
		error("the job has no animation")
	end
	track:Play(0, 1, 0)
	for i, beat in job.beats do
		track.TimePosition = math.clamp(beat.t, 0, math.max(0, track.Length - 1e-3))
		animator:StepAnimations(0)
		frames(3)
		post(job, { type = "beat", index = i - 1, t = beat.t })
	end
	track:Stop(0)
	post(job, { type = "done", marks = {} })
end

local function runRealtime(job: any, folder: Folder, stage: Model, rig: Model)
	local module = folder:FindFirstChild(job.entry)
	if not module then
		error("the job has no module " .. tostring(job.entry))
	end
	local marks = {}
	local t0 = 0
	local function mark(label: string)
		table.insert(marks, { label = label, t = os.clock() - t0 })
	end
	local play
	local stepper: RBXScriptConnection? = nil
	if job.kind == "ability" then
		local runner = require(folder:FindFirstChild("AbilityRunner") :: ModuleScript) :: any
		local vfx = folder:FindFirstChild(job.vfxFolder or "VFX")
		if vfx then
			runner.VfxPath = pathOf(vfx)
		end
		local move = require(module :: ModuleScript) :: any
		local _, animator, id = loadTrack(job, rig)
		if move.Animation and id then
			move.Animation.Id = id
		end
		if animator then
			-- Edit mode does not advance animations by itself; step them every frame.
			stepper = RunService.Heartbeat:Connect(function(dt)
				animator:StepAnimations(dt)
			end)
		end
		play = function()
			move.play(rig, { camera = false, vfxParent = stage, onMarker = mark })
		end
	else
		local effect = require(module :: ModuleScript) :: any
		play = function()
			effect.play(STAGE_ORIGIN, stage, { onStage = mark })
		end
	end
	post(job, { type = "ready" })
	local rtt = ping()
	t0 = os.clock()
	local ok, err = pcall(play)
	if not ok then
		if stepper then
			stepper:Disconnect()
		end
		error(err, 0)
	end
	post(job, { type = "start", elapsed = os.clock() - t0, rtt = rtt })
	local finish = t0 + job.duration + math.min(job.linger or 0, 2) + 0.3
	while os.clock() < finish do
		RunService.Heartbeat:Wait()
	end
	if stepper then
		stepper:Disconnect()
	end
	post(job, { type = "done", marks = marks })
end

-- Thumbnail Lab: capture the viewport exactly as the user framed it (no stage, camera untouched).
-- The selection is cleared for the capture so selection boxes do not end up in the thumbnail.
local function runSnapshot(job: any)
	local Selection = game:GetService("Selection")
	local selected = Selection:Get()
	Selection:Set({})
	local ok, err = pcall(function()
		if job.calibrate then
			calibrate(job)
		end
		for i, beat in job.beats do
			frames(3)
			post(job, { type = "beat", index = i - 1, t = beat.t })
		end
		post(job, { type = "done", marks = {} })
	end)
	Selection:Set(selected)
	if not ok then
		error(err, 0)
	end
end

local function runJob(job: any)
	if job.version ~= 1 then
		pcall(post, job, { type = "error", message = "this Forge Bridge plugin is outdated; reinstall it from RBX Forge" })
		return
	end
	local saved = nil
	local stage: Model? = nil
	local folder: Folder? = nil
	local ok, err = pcall(function()
		post(job, { type = "accepted" })
		if job.kind == "snapshot" then
			runSnapshot(job)
			return
		end
		folder = jobFolder()
		buildModules(job.modules or {}, folder :: Folder)
		saved = saveView()
		local s, rig = buildStage(job)
		stage = s
		setView(job)
		frames(5)
		if job.calibrate then
			calibrate(job)
		end
		if job.mode == "stepped" then
			runStepped(job, rig)
		else
			runRealtime(job, folder :: Folder, s, rig)
		end
	end)
	if stage then
		stage:Destroy()
	end
	if folder then
		folder:Destroy()
	end
	restoreView(saved)
	if not ok then
		warn("[Forge Bridge] " .. tostring(err))
		pcall(post, job, { type = "error", message = tostring(err) })
	end
end

-- ------------------------------------------------------------ Forge Sync
--
-- Protocol: src/shared/sync/protocol.ts. Reads LuaSourceContainer.Source, which is the committed
-- source; with Collaborative Editing drafts the editor text can differ and is only reachable through
-- ScriptEditorService:GetEditorSource ("The edit-time source is not always consistent with the
-- Script.Source property", Creator Hub, ScriptEditorService). Drafts stay local until committed, so
-- Forge never writes someone's unfinished draft to disk.
--
-- An unpublished place (PlaceId 0) cannot be in Team Create, so it has no drafts: there the editor
-- text is the script, and the plugin also listens to ScriptEditorService.TextDocumentDidChange and
-- reads GetEditorSource, so a script typed in the Script Editor reaches Forge even when Studio has
-- not written Script.Source yet.
--
-- Mapped roots that do not exist yet (a fresh place before Rojo has connected and built
-- StarterPlayerScripts.Client and the rest) are checked every few seconds; when one appears the
-- plugin sends a fresh snapshot, so its scripts are watched from then on.
--
-- Cost: no per-frame work. One Changed (+ AttributeChanged) connection per mapped instance, two
-- connections per root, a 10 Hz check of a dirty flag, and a walk that yields every few hundred
-- instances when a snapshot is taken.

local SYNC_DEBOUNCE = 0.3
local SYNC_MAX_WAIT = 2
local SYNC_CHUNK_BYTES = 180 * 1024
local SYNC_MAX_SOURCE = 2 * 1024 * 1024
local SYNC_MAX_NODES = 50000
local SYNC_MAX_CHANGE_BYTES = 4 * 1024 * 1024
local SYNC_YIELD_EVERY = 300
local SYNC_RECHECK_OFF = 5
-- Place linking (v8): the attribute an unpublished place keeps its Forge link id in, and this run's id.
local LINK_ATTRIBUTE = "ForgeSyncLink"
local SYNC_PROBE = HttpService:GenerateGUID(false)
local SYNC_RECHECK_OLD = 120
local SYNC_ROOT_RECHECK = 2
-- Wally packages and the bridge's own job instances never sync.
local SYNC_SKIP_NAMES = {
	Packages = true,
	ServerPackages = true,
	DevPackages = true,
	_Index = true,
	ForgeBridgeJob = true,
	ForgeBridgeStage = true,
}

-- Non-script properties Forge writes into Rojo .model.json files (only values that differ from a
-- fresh Instance.new are sent). Checked with IsA, so subclasses pick up their bases' entries.
local SYNC_PROPS: { { any } } = {
	{ "ValueBase", { "Value" } },
	{ "Animation", { "AnimationId" } },
	{
		"Sound",
		{ "SoundId", "Volume", "Looped", "PlaybackSpeed", "RollOffMaxDistance", "RollOffMinDistance", "RollOffMode", "PlayOnRemove", "TimePosition" },
	},
	{
		"ParticleEmitter",
		{
			"Enabled", "Texture", "Color", "Transparency", "Size", "Squash", "Lifetime", "Rate", "Speed", "SpreadAngle",
			"Rotation", "RotSpeed", "Acceleration", "Drag", "LightEmission", "LightInfluence", "Brightness", "ZOffset",
			"EmissionDirection", "LockedToPart", "Orientation", "Shape", "ShapeStyle", "ShapeInOut", "ShapePartial",
			"TimeScale", "VelocityInheritance", "WindAffectsDrag", "FlipbookLayout", "FlipbookMode", "FlipbookFramerate",
			"FlipbookStartRandom",
		},
	},
	{
		"Trail",
		{ "Enabled", "Texture", "Color", "Transparency", "Lifetime", "MinLength", "MaxLength", "WidthScale", "LightEmission", "LightInfluence", "Brightness", "FaceCamera", "TextureLength", "TextureMode" },
	},
	{
		"Beam",
		{ "Enabled", "Texture", "Color", "Transparency", "Width0", "Width1", "CurveSize0", "CurveSize1", "Segments", "LightEmission", "LightInfluence", "Brightness", "FaceCamera", "TextureLength", "TextureMode", "TextureSpeed", "ZOffset" },
	},
	{ "Attachment", { "CFrame", "Visible" } },
	{ "Light", { "Enabled", "Brightness", "Color", "Shadows" } },
	{ "PointLight", { "Range" } },
	{ "SpotLight", { "Range", "Angle", "Face" } },
	{ "SurfaceLight", { "Range", "Angle", "Face" } },
	{ "Decal", { "Texture", "Color3", "Transparency", "Face", "ZIndex" } },
	{ "Texture", { "StudsPerTileU", "StudsPerTileV", "OffsetStudsU", "OffsetStudsV" } },
	{ "Highlight", { "Enabled", "FillColor", "FillTransparency", "OutlineColor", "OutlineTransparency", "DepthMode" } },
	{
		"BasePart",
		{ "Size", "CFrame", "Anchored", "CanCollide", "CanQuery", "CanTouch", "CastShadow", "Transparency", "Color", "Material", "Reflectance", "Massless" },
	},
	{ "SpecialMesh", { "MeshType", "MeshId", "TextureId", "Scale", "Offset", "VertexColor" } },
	{ "Model", { "LevelOfDetail", "ModelStreamingMode" } },
}

-- Game-tab outline (plugin version 5).
local OUTLINE_DEBOUNCE = 1.5
local OUTLINE_MAX_WAIT = 10
-- Renames do not fire DescendantAdded/Removing: a rescan catches them (sent only when changed).
local OUTLINE_RESCAN = 30
local OUTLINE_DEPTH = 12
local OUTLINE_SKIP_CLASSES: { [string]: boolean } = { Camera = true, Terrain = true, Players = true }
-- A few asset ids shown in the Game tab (strings only; read with pcall).
local OUTLINE_PROPS: { { any } } = {
	{ "Animation", "AnimationId" },
	{ "Sound", "SoundId" },
	{ "MeshPart", "MeshId" },
	{ "SpecialMesh", "MeshId" },
	{ "Decal", "Texture" },
	{ "ImageLabel", "Image" },
	{ "ImageButton", "Image" },
}

-- Instance-reference properties (Creator Hub API: ObjectValue.Value, JointInstance / WeldConstraint /
-- NoCollisionConstraint Part0/Part1, Constraint / Beam / Trail Attachment0/Attachment1,
-- Model.PrimaryPart). Forge Sync does not write references to disk; it only reports where they are
-- set, so Forge can tell the user they stay in Studio.
local SYNC_REF_PROPS: { { any } } = {
	{ "ObjectValue", { "Value" } },
	{ "JointInstance", { "Part0", "Part1" } },
	{ "WeldConstraint", { "Part0", "Part1" } },
	{ "NoCollisionConstraint", { "Part0", "Part1" } },
	{ "Constraint", { "Attachment0", "Attachment1" } },
	{ "Beam", { "Attachment0", "Attachment1" } },
	{ "Trail", { "Attachment0", "Attachment1" } },
	{ "Model", { "PrimaryPart" } },
}
local SYNC_MAX_REFS = 200

type Known = { id: string, path: { string }, key: string }

local sync = {
	wanted = true, -- start (or restart) at the next loop turn
	retryAt = 0,
	waitingForForge = false, -- Forge was unreachable: the poll loop restarts us when it answers again
	session = nil :: string?,
	generation = 0,
	roots = {} :: { Instance },
	-- Config roots not in the DataModel yet (checked every SYNC_ROOT_RECHECK seconds).
	missing = {} :: { { string } },
	rootCheckAt = 0,
	skip = {} :: { string },
	known = {} :: { [Instance]: Known },
	conns = {} :: { [Instance]: { RBXScriptConnection } },
	rootConns = {} :: { RBXScriptConnection },
	touched = {} :: { [Instance]: { [string]: boolean } },
	refs = {} :: { [Instance]: string }, -- set reference properties, comma-joined
	refsDirty = false,
	dirty = false,
	firstTouch = 0,
	lastTouch = 0,
	-- Game-tab outline: containers to walk, node cap, change flags and the last body sent.
	outline = {} :: { Instance },
	outlineMax = 0,
	outlineDirty = false,
	outlineFirst = 0,
	outlineLast = 0,
	outlineScan = 0,
	outlineSent = nil :: string?,
}
-- Ids stay the same for an instance for the whole Studio session, across re-snapshots.
local syncIds: { [Instance]: string } = setmetatable({}, { __mode = "k" }) :: any
local syncNextId = 0
local classProps: { [string]: { string } } = {}
local classDefaults: { [string]: { [string]: any } | false } = {}
local classRefProps: { [string]: { string } } = {}

local function pathKey(path: { string }, last: number?): string
	return table.concat(path, "\0", 1, last or #path)
end

local function underKey(key: string, prefix: string): boolean
	return key == prefix or string.sub(key, 1, #prefix + 1) == prefix .. "\0"
end

local function syncPlace(): any
	return { placeId = game.PlaceId, gameId = game.GameId, name = game.Name }
end

local function idFor(inst: Instance): string
	local id = syncIds[inst]
	if not id then
		syncNextId += 1
		id = tostring(syncNextId)
		syncIds[inst] = id
	end
	return id
end

-- The instance path when it is inside a mapped root and not skipped, else nil.
local function syncPath(inst: Instance): { string }?
	local root: Instance? = nil
	for _, r in sync.roots do
		if inst == r or inst:IsDescendantOf(r) then
			root = r
			break
		end
	end
	if not root then
		return nil
	end
	local node: Instance? = inst
	while node and node ~= root do
		if SYNC_SKIP_NAMES[node.Name] or node.Name == "" then
			return nil
		end
		node = node.Parent
	end
	local path = pathOf(inst)
	local key = pathKey(path)
	for _, s in sync.skip do
		if underKey(key, s) then
			return nil
		end
	end
	return path
end

local function finite(n: number): boolean
	return n == n and n ~= math.huge and n ~= -math.huge
end

-- Rojo's explicit property syntax (rojo.space/docs/v7/properties): { "<Type>": value }. Strings,
-- numbers and booleans stay plain (Rojo infers String/Content/Float64/Bool from the property).
local function encodeValue(v: any): any
	local t = typeof(v)
	if t == "string" or t == "boolean" then
		return v
	elseif t == "number" then
		return if finite(v) then v else nil
	elseif t == "EnumItem" then
		return { Enum = v.Value }
	elseif t == "Vector3" then
		return { Vector3 = { v.X, v.Y, v.Z } }
	elseif t == "Vector2" then
		return { Vector2 = { v.X, v.Y } }
	elseif t == "Color3" then
		return { Color3 = { v.R, v.G, v.B } }
	elseif t == "BrickColor" then
		return { BrickColor = v.Number }
	elseif t == "NumberRange" then
		return { NumberRange = { v.Min, v.Max } }
	elseif t == "UDim" then
		return { UDim = { v.Scale, v.Offset } }
	elseif t == "UDim2" then
		return { UDim2 = { { v.X.Scale, v.X.Offset }, { v.Y.Scale, v.Y.Offset } } }
	elseif t == "CFrame" then
		local x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22 = v:GetComponents()
		return { CFrame = { position = { x, y, z }, orientation = { { r00, r01, r02 }, { r10, r11, r12 }, { r20, r21, r22 } } } }
	elseif t == "ColorSequence" then
		local points = {}
		for _, k in v.Keypoints do
			table.insert(points, { time = k.Time, color = { k.Value.R, k.Value.G, k.Value.B } })
		end
		return { ColorSequence = { keypoints = points } }
	elseif t == "NumberSequence" then
		local points = {}
		for _, k in v.Keypoints do
			table.insert(points, { time = k.Time, value = k.Value, envelope = k.Envelope })
		end
		return { NumberSequence = { keypoints = points } }
	end
	return nil -- Instance refs and other types are not synced
end

local function propsFor(inst: Instance): { string }
	local list = classProps[inst.ClassName]
	if list then
		return list
	end
	list = {}
	for _, entry in SYNC_PROPS do
		if inst:IsA(entry[1]) then
			for _, name in entry[2] do
				table.insert(list, name)
			end
		end
	end
	classProps[inst.ClassName] = list
	return list
end

local function refPropsFor(inst: Instance): { string }
	local list = classRefProps[inst.ClassName]
	if list then
		return list
	end
	list = {}
	for _, entry in SYNC_REF_PROPS do
		if inst:IsA(entry[1]) then
			for _, name in entry[2] do
				table.insert(list, name)
			end
		end
	end
	classRefProps[inst.ClassName] = list
	return list
end

-- Re-reads which reference properties of a known instance are set; marks the list dirty on a change.
local function updateRefs(inst: Instance)
	local set = {}
	if sync.known[inst] then
		for _, name in refPropsFor(inst) do
			local ok, value = pcall(function()
				return (inst :: any)[name]
			end)
			if ok and typeof(value) == "Instance" then
				table.insert(set, name)
			end
		end
	end
	local joined = if #set > 0 then table.concat(set, ",") else nil
	if sync.refs[inst] ~= joined then
		sync.refs[inst] = joined
		sync.refsDirty = true
	end
end

-- The reported list ({ path, property }, capped) and the uncapped count.
local function refList(): ({ any }, number)
	local list, total = {}, 0
	for inst, joined in sync.refs do
		local known = sync.known[inst]
		if known then
			for _, name in string.split(joined, ",") do
				total += 1
				if #list < SYNC_MAX_REFS then
					table.insert(list, { path = known.path, property = name })
				end
			end
		end
	end
	return list, total
end

local function defaultsFor(inst: Instance, props: { string }): { [string]: any }?
	local cached = classDefaults[inst.ClassName]
	if cached ~= nil then
		return if cached then cached else nil
	end
	local ok, fresh = pcall(Instance.new, inst.ClassName)
	if not ok then
		classDefaults[inst.ClassName] = false
		return nil
	end
	local values = {}
	for _, name in props do
		pcall(function()
			values[name] = (fresh :: any)[name]
		end)
	end
	fresh:Destroy()
	classDefaults[inst.ClassName] = values
	return values
end

local scriptEditor: any = nil
pcall(function()
	scriptEditor = game:GetService("ScriptEditorService")
end)

-- The script's text: the editor's text in an unpublished place (no Team Create, so no drafts),
-- otherwise the committed Source.
local function scriptSource(inst: Instance): (boolean, any)
	if game.PlaceId == 0 and scriptEditor then
		local ok, text = pcall(function()
			return scriptEditor:GetEditorSource(inst)
		end)
		if ok and type(text) == "string" then
			return true, text
		end
	end
	return pcall(function()
		return (inst :: any).Source
	end)
end

local function buildNode(inst: Instance, path: { string }): any
	local node: any = { id = idFor(inst), path = path, className = inst.ClassName }
	if inst:IsA("LuaSourceContainer") then
		local ok, source = scriptSource(inst)
		if ok and type(source) == "string" then
			if #source > SYNC_MAX_SOURCE then
				node.oversize = true
			else
				node.source = source
			end
		end
		if inst.ClassName == "Script" then
			local context = (inst :: Script).RunContext
			if context ~= Enum.RunContext.Legacy then
				node.runContext = context.Name
			end
		end
	else
		local props = propsFor(inst)
		if #props > 0 then
			local defaults = defaultsFor(inst, props)
			local out = {}
			for _, name in props do
				local ok, value = pcall(function()
					return (inst :: any)[name]
				end)
				if ok and (not defaults or defaults[name] ~= value) then
					out[name] = encodeValue(value)
				end
			end
			if next(out) then
				node.properties = out
			end
		end
	end
	local attributes = {}
	for name, value in inst:GetAttributes() do
		if name ~= LINK_ATTRIBUTE then
			attributes[name] = encodeValue(value)
		end
	end
	if next(attributes) then
		node.attributes = attributes
	end
	local tags = CollectionService:GetTags(inst)
	if #tags > 0 then
		node.tags = tags
	end
	return node
end

-- A cheap size estimate (bytes of JSON) so chunks stay well under Forge's body limit without encoding
-- every node twice.
local function nodeBytes(node: any): number
	local n = 160 + #pathKey(node.path)
	if node.source then
		n += math.ceil(#node.source * 1.15)
	end
	for _ in node.properties or {} do
		n += 120
	end
	for _ in node.attributes or {} do
		n += 120
	end
	return n
end

local function touch(inst: Instance, flag: string?)
	if not sync.session then
		return
	end
	local flags = sync.touched[inst]
	if not flags then
		flags = {}
		sync.touched[inst] = flags
	end
	if flag then
		flags[flag] = true
	end
	local now = os.clock()
	if not sync.dirty then
		sync.dirty = true
		sync.firstTouch = now
	end
	sync.lastTouch = now
end

local function register(inst: Instance, path: { string })
	sync.known[inst] = { id = idFor(inst), path = path, key = pathKey(path) }
	if sync.conns[inst] then
		return
	end
	local list = {}
	if inst:IsA("LuaSourceContainer") then
		table.insert(list, inst.Changed:Connect(function(prop)
			if prop == "Source" or prop == "RunContext" then
				touch(inst, "source")
			elseif prop == "Name" then
				touch(inst, nil)
			end
		end))
	elseif inst:IsA("ValueBase") then
		-- ValueBase.Changed only fires for Value (with the new value).
		table.insert(list, inst.Changed:Connect(function()
			touch(inst, "props")
		end))
		table.insert(list, inst:GetPropertyChangedSignal("Name"):Connect(function()
			touch(inst, nil)
		end))
	else
		local watched = {}
		for _, name in propsFor(inst) do
			watched[name] = true
		end
		local refWatched = {}
		for _, name in refPropsFor(inst) do
			refWatched[name] = true
		end
		table.insert(list, inst.Changed:Connect(function(prop)
			if prop == "Name" then
				touch(inst, nil)
			elseif watched[prop] then
				touch(inst, "props")
			elseif refWatched[prop] then
				touch(inst, "refs")
			end
		end))
	end
	table.insert(list, inst.AttributeChanged:Connect(function()
		touch(inst, "props")
	end))
	sync.conns[inst] = list
end

local function unregister(inst: Instance)
	sync.known[inst] = nil
	if sync.refs[inst] then
		sync.refs[inst] = nil
		sync.refsDirty = true
	end
	local list = sync.conns[inst]
	if list then
		for _, c in list do
			c:Disconnect()
		end
		sync.conns[inst] = nil
	end
end

local function stopSync()
	sync.generation += 1
	sync.session = nil
	for _, c in sync.rootConns do
		c:Disconnect()
	end
	sync.rootConns = {}
	for inst in sync.conns do
		unregister(inst)
	end
	sync.known = {}
	sync.conns = {}
	sync.touched = {}
	sync.refs = {}
	sync.refsDirty = false
	sync.dirty = false
	sync.outline = {}
	sync.outlineDirty = false
	sync.outlineSent = nil
	sync.missing = {}
end

local function resolve(path: { string }): Instance?
	local node: Instance? = game
	for _, name in path do
		node = node and node:FindFirstChild(name)
	end
	return node
end

local function syncPost(route: string, body: any): (boolean, string?)
	local ok, answer = request("POST", "/sync/" .. route, body)
	if not ok then
		if type(answer) ~= "number" then
			sync.waitingForForge = true
		end
		return false, "Forge did not take the " .. route .. " (" .. tostring(answer) .. ")"
	end
	if type(answer) ~= "table" or answer.ok ~= true then
		local err = if type(answer) == "table" then tostring(answer.error) else "no answer"
		if type(answer) == "table" and answer.resend then
			sync.wanted = true
		end
		return false, err
	end
	return true, nil
end

local function sendSnapshot(gen: number)
	local chunk, bytes, seq, count = {}, 0, 0, 0
	local place = syncPlace()
	local function send(final: boolean)
		local body: any = { session = sync.session, place = place, seq = seq, final = final, nodes = chunk }
		if final then
			body.refs, body.refsTotal = refList()
			sync.refsDirty = false
		end
		local ok, err = syncPost("snapshot", body)
		if not ok then
			error("snapshot: " .. tostring(err), 0)
		end
		seq += 1
		chunk, bytes = {}, 0
	end
	local function visit(inst: Instance)
		if gen ~= sync.generation then
			error("snapshot restarted", 0)
		end
		if sync.known[inst] then
			return -- nested roots: already walked
		end
		local path = syncPath(inst)
		if not path then
			return
		end
		register(inst, path)
		updateRefs(inst)
		local node = buildNode(inst, path)
		local size = nodeBytes(node)
		if bytes > 0 and bytes + size > SYNC_CHUNK_BYTES then
			send(false)
		end
		table.insert(chunk, node)
		bytes += size
		count += 1
		if count > SYNC_MAX_NODES then
			error("more than " .. SYNC_MAX_NODES .. " instances under the mapped roots; sync stopped", 0)
		end
		if count % SYNC_YIELD_EVERY == 0 then
			task.wait()
		end
		for _, child in inst:GetChildren() do
			visit(child)
		end
	end
	for _, root in sync.roots do
		visit(root)
	end
	send(true)
	return count
end

-- "off": Forge has no sync for this place; "waiting": Forge unreachable; "ok": streaming.
local function startSync(): string
	stopSync()
	local gen = sync.generation
	local query = "/sync/config?placeId="
		.. tostring(game.PlaceId)
		.. "&gameId="
		.. tostring(game.GameId)
		.. "&place="
		.. HttpService:UrlEncode(game.Name)
		.. "&probe="
		.. SYNC_PROBE
	local link = nil
	if game.PlaceId == 0 then
		pcall(function()
			link = ServerStorage:GetAttribute(LINK_ATTRIBUTE)
		end)
	end
	if type(link) == "string" and link ~= "" then
		query ..= "&link=" .. HttpService:UrlEncode(link)
	end
	local ok, config = request("GET", query)
	if not ok then
		if type(config) == "number" then
			-- An older RBX Forge without Forge Sync answers 404.
			sync.retryAt = os.clock() + SYNC_RECHECK_OLD
			sync.wanted = true
			return "off"
		end
		sync.waitingForForge = true
		return "waiting"
	end
	if type(config) == "table" and not config.enabled and type(config.stampLink) == "string" and game.PlaceId == 0 then
		-- The user linked this unpublished place to the open Forge project: keep the link in the place.
		local stamped = pcall(function()
			ServerStorage:SetAttribute(LINK_ATTRIBUTE, config.stampLink)
		end)
		if stamped then
			print("[Forge Bridge] Forge Sync: this place is now linked to the Forge project (save the place to keep the link)")
			sync.retryAt = 0
			sync.wanted = true
			return "off"
		end
	end
	if type(config) ~= "table" or not config.enabled then
		sync.retryAt = os.clock() + SYNC_RECHECK_OFF
		sync.wanted = true
		return "off"
	end
	sync.session = tostring(config.sessionToken or "")
	sync.roots = {}
	sync.skip = {}
	for _, path in config.skip or {} do
		table.insert(sync.skip, pathKey(path))
	end
	sync.missing = {}
	sync.rootCheckAt = os.clock() + SYNC_ROOT_RECHECK
	for _, path in config.roots or {} do
		local root = resolve(path)
		if root then
			table.insert(sync.roots, root)
		else
			table.insert(sync.missing, path)
		end
	end
	sync.outline = {}
	sync.outlineMax = math.clamp(tonumber(config.outlineMax) or 0, 0, 5000)
	if sync.outlineMax > 0 then
		for _, path in config.outline or {} do
			local container = resolve(path)
			if container and not table.find(sync.outline, container) then
				table.insert(sync.outline, container)
				local function mark()
					local now = os.clock()
					if not sync.outlineDirty then
						sync.outlineDirty = true
						sync.outlineFirst = now
					end
					sync.outlineLast = now
				end
				table.insert(sync.rootConns, container.DescendantAdded:Connect(mark))
				table.insert(sync.rootConns, container.DescendantRemoving:Connect(mark))
			end
		end
		-- First outline right after the snapshot.
		sync.outlineDirty = #sync.outline > 0
		sync.outlineFirst = 0
		sync.outlineLast = 0
	end
	-- Watch before walking: anything that changes during the walk is diffed against the walk afterwards.
	for _, root in sync.roots do
		table.insert(sync.rootConns, root.DescendantAdded:Connect(function(d)
			touch(d, nil)
		end))
		table.insert(sync.rootConns, root.DescendantRemoving:Connect(function(d)
			touch(d, nil)
		end))
		table.insert(sync.rootConns, root.AncestryChanged:Connect(function()
			sync.wanted = true -- a root itself moved: start over
		end))
	end
	local count = sendSnapshot(gen)
	print(("[Forge Bridge] Forge Sync: sent %d instances from %d roots"):format(count, #sync.roots))
	if #sync.missing > 0 then
		local names = {}
		for _, path in sync.missing do
			table.insert(names, table.concat(path, "."))
		end
		print("[Forge Bridge] Forge Sync: not in Studio yet (synced once they appear, e.g. after Rojo connects): " .. table.concat(names, ", "))
	end
	return "ok"
end

-- Re-paths a renamed or moved instance and its descendants. By instance, not by path: a same-name
-- sibling (Studio's Ctrl+D copy) shares the old path and keeps its own.
local function rebase(inst: Instance, newPath: { string })
	local k = sync.known[inst]
	if k then
		k.path = newPath
		k.key = pathKey(newPath)
	end
	for _, d in inst:GetDescendants() do
		local dk = sync.known[d]
		local path = if dk then syncPath(d) else nil
		if dk and path then
			dk.path = path
			dk.key = pathKey(path)
		end
	end
end

-- Forgets a removed instance and what was known below it: everything under its old path that is no
-- longer in a mapped root, or that still descends from it. A same-name sibling at that path (and its
-- subtree) is still in Studio and stays known.
local function forget(inst: Instance, oldKey: string)
	local gone = {}
	for other, k in sync.known do
		if other == inst or (underKey(k.key, oldKey) and (other:IsDescendantOf(inst) or not syncPath(other))) then
			table.insert(gone, other)
		end
	end
	for _, other in gone do
		unregister(other)
	end
end

local function sendChanges(changes: { any })
	local batch, bytes = {}, 0
	local total = 0
	local place = syncPlace()
	local function send(last: boolean?)
		local body: any = { session = sync.session, place = place, changes = batch }
		if last and sync.refsDirty then
			-- The whole current list: Forge replaces what it had for this place.
			body.refs, body.refsTotal = refList()
			sync.refsDirty = false
		end
		local ok, err = syncPost("changes", body)
		batch, bytes = {}, 0
		if not ok then
			error("changes: " .. tostring(err), 0)
		end
	end
	for _, change in changes do
		local size = 200
		if change.node then
			size += nodeBytes(change.node)
		end
		for _, d in change.descendants or {} do
			size += nodeBytes(d)
		end
		total += size
		if total > SYNC_MAX_CHANGE_BYTES then
			-- Too much at once (a big paste): a fresh snapshot is cheaper to reason about.
			sync.wanted = true
			return
		end
		if bytes > 0 and bytes + size > SYNC_CHUNK_BYTES then
			send()
		end
		table.insert(batch, change)
		bytes += size
	end
	if #batch > 0 or sync.refsDirty then
		send(true)
	end
end

local function flush()
	local items = {}
	for inst, flags in sync.touched do
		local was = sync.known[inst]
		local path = syncPath(inst)
		local depth = if path then #path elseif was then #was.path else 0
		table.insert(items, { inst = inst, flags = flags, path = path, depth = depth })
	end
	sync.touched = {}
	sync.dirty = false
	-- Parents first: a moved/added/removed subtree is one change, its descendants ride along.
	table.sort(items, function(a, b)
		return a.depth < b.depth
	end)
	local changes = {}
	local handled: { [Instance]: boolean } = {}
	for _, item in items do
		local inst, path = item.inst, item.path
		local was = sync.known[inst]
		if handled[inst] then
			continue
		end
		if path and not was then
			register(inst, path)
			updateRefs(inst)
			local node = buildNode(inst, path)
			local descendants = {}
			for _, d in inst:GetDescendants() do
				handled[d] = true
				if not sync.known[d] then
					local dp = syncPath(d)
					if dp then
						register(d, dp)
						updateRefs(d)
						table.insert(descendants, buildNode(d, dp))
					end
				end
			end
			table.insert(changes, { kind = "added", node = node, descendants = if #descendants > 0 then descendants else nil })
		elseif was and not path then
			table.insert(changes, { kind = "removed", id = was.id, path = was.path })
			forget(inst, was.key)
		elseif was and path then
			local key = pathKey(path)
			if key ~= was.key then
				local from = was.path
				local sameParent = #path == #from and pathKey(path, #path - 1) == pathKey(from, #from - 1)
				rebase(inst, path)
				if next(sync.refs) then
					sync.refsDirty = true -- reported paths under it changed
				end
				table.insert(changes, { kind = if sameParent then "renamed" else "moved", id = was.id, from = from, node = buildNode(inst, path) })
			elseif item.flags.source then
				table.insert(changes, { kind = "source", node = buildNode(inst, path) })
			elseif item.flags.props then
				table.insert(changes, { kind = "props", node = buildNode(inst, path) })
			end
			updateRefs(inst)
		end
	end
	if #changes > 0 or sync.refsDirty then
		sendChanges(changes)
	end
end

local function outlineProps(inst: Instance): any
	local props = nil
	for _, entry in OUTLINE_PROPS do
		if inst:IsA(entry[1]) then
			local ok, value = pcall(function()
				return (inst :: any)[entry[2]]
			end)
			if ok and type(value) == "string" and value ~= "" and #value <= 1024 then
				props = props or {}
				props[entry[2]] = value
			end
		end
	end
	return props
end

local function insideSyncRoot(inst: Instance): boolean
	for _, r in sync.roots do
		if inst == r or inst:IsDescendantOf(r) then
			return true
		end
	end
	return false
end

-- Breadth-first over the outline containers, outside the synced roots (they stream on their own) and
-- the skip list, up to OUTLINE_DEPTH levels and outlineMax nodes. Sent only when it changed.
local function sendOutline(gen: number)
	sync.outlineDirty = false
	sync.outlineScan = os.clock()
	local nodes, truncated = {}, false
	local queue, head = {}, 1
	for _, container in sync.outline do
		if container.Parent then
			table.insert(queue, { container, pathOf(container), 0 })
		end
	end
	local seen, deep = 0, false
	while head <= #queue and not truncated do
		local item = queue[head]
		head += 1
		local inst, path, depth = item[1], item[2], item[3]
		if depth >= OUTLINE_DEPTH then
			if #inst:GetChildren() > 0 then
				deep = true
			end
			continue
		end
		for _, child in inst:GetChildren() do
			if OUTLINE_SKIP_CLASSES[child.ClassName] or SYNC_SKIP_NAMES[child.Name] or child.Name == "" or insideSyncRoot(child) then
				continue
			end
			local childPath = table.clone(path)
			table.insert(childPath, child.Name)
			local key = pathKey(childPath)
			local skipped = false
			for _, sk in sync.skip do
				if underKey(key, sk) then
					skipped = true
					break
				end
			end
			if skipped then
				continue
			end
			if #nodes >= sync.outlineMax then
				truncated = true
				break
			end
			table.insert(nodes, { path = childPath, className = child.ClassName, props = outlineProps(child) })
			table.insert(queue, { child, childPath, depth + 1 })
			seen += 1
			if seen % SYNC_YIELD_EVERY == 0 then
				task.wait()
				if gen ~= sync.generation then
					return
				end
			end
		end
	end
	truncated = truncated or deep
	local signature = HttpService:JSONEncode({ nodes, truncated })
	if signature == sync.outlineSent then
		return
	end
	local ok, err = syncPost("outline", { session = sync.session, place = syncPlace(), nodes = nodes, truncated = truncated })
	if not ok then
		error("outline: " .. tostring(err), 0)
	end
	sync.outlineSent = signature
end

-- Typing in the Script Editor of an unpublished place: the document changed, Source may not have yet.
if scriptEditor then
	pcall(function()
		scriptEditor.TextDocumentDidChange:Connect(function(doc)
			if game.PlaceId ~= 0 or not sync.session then
				return
			end
			local ok, inst = pcall(function()
				return doc:GetScript()
			end)
			if ok and inst and sync.known[inst] then
				touch(inst, "source")
			end
		end)
	end)
end

local function syncLoop()
	while alive do
		if not enabled then
			if sync.session then
				stopSync()
				sync.wanted = true
			end
			task.wait(1)
			continue
		end
		local now = os.clock()
		if sync.session and #sync.missing > 0 and now >= sync.rootCheckAt then
			sync.rootCheckAt = now + SYNC_ROOT_RECHECK
			for _, path in sync.missing do
				if resolve(path) then
					print("[Forge Bridge] Forge Sync: " .. table.concat(path, ".") .. " is in Studio now; sending a fresh snapshot")
					sync.wanted = true
					sync.retryAt = 0
					break
				end
			end
		end
		if sync.wanted and not sync.waitingForForge and now >= sync.retryAt then
			sync.wanted = false
			local ok, result = pcall(startSync)
			if not ok then
				warn("[Forge Bridge] Forge Sync: " .. tostring(result))
				stopSync()
				if not sync.waitingForForge then
					sync.wanted = true
					sync.retryAt = os.clock() + RETRY_SECONDS * 2
				end
			end
		elseif sync.session and sync.dirty and (now - sync.lastTouch >= SYNC_DEBOUNCE or now - sync.firstTouch >= SYNC_MAX_WAIT) then
			local ok, err = pcall(flush)
			if not ok then
				warn("[Forge Bridge] Forge Sync: " .. tostring(err) .. "; sending a fresh snapshot")
				stopSync()
				if not sync.waitingForForge then
					sync.wanted = true
					sync.retryAt = os.clock() + RETRY_SECONDS
				end
			end
		end
		now = os.clock()
		-- The outline waits for a pending change flush, but not for longer than OUTLINE_MAX_WAIT: a steady
		-- stream of edits under the roots (typing, a plugin nudging values) used to hold it back for good,
		-- so instances deleted outside the roots stayed in the Game tab.
		if
			sync.session
			and #sync.outline > 0
			and (not sync.dirty or now - sync.outlineFirst >= OUTLINE_MAX_WAIT or now - sync.outlineScan >= OUTLINE_RESCAN)
			and (
				(sync.outlineDirty and (now - sync.outlineLast >= OUTLINE_DEBOUNCE or now - sync.outlineFirst >= OUTLINE_MAX_WAIT))
				or now - sync.outlineScan >= OUTLINE_RESCAN
			)
		then
			-- The outline is only for display: a failure waits for the next rescan, sync keeps going.
			local ok, err = pcall(sendOutline, sync.generation)
			if not ok then
				warn("[Forge Bridge] Forge Sync outline: " .. tostring(err))
				sync.outlineDirty = false
				sync.outlineScan = os.clock()
			end
		end
		if sync.wanted and not sync.session then
			task.wait(0.5)
		else
			task.wait(0.1)
		end
	end
	stopSync()
end

-- ------------------------------------------------------------ Delete in Studio (version 7)
--
-- The only change the plugin makes to the place: the Game tab's "Delete in Studio", confirmed by the
-- user in Forge, for an instance that exists only in Studio. Refused for services, default containers,
-- same-name siblings (the path would be ambiguous), and anything Forge Sync streams to files: a mapped
-- root, something inside one, or something that holds one (those are files; delete the file instead).
-- The instance is parented to nil inside a ChangeHistoryService recording (Creator Hub:
-- TryBeginRecording / FinishRecording), the way Studio's own Delete works, so Ctrl+Z restores it.

local function isPrefix(prefix: { string }, path: { string }): boolean
	if #prefix > #path then
		return false
	end
	for i, name in prefix do
		if path[i] ~= name then
			return false
		end
	end
	return true
end

-- The instance at `path` and nil, or nil and why it cannot be deleted.
local function deleteTarget(path: any, className: any): (Instance?, string?)
	if type(path) ~= "table" or #path < 1 then
		return nil, "no instance path"
	end
	local dotted = table.concat(path, ".")
	if #path < 2 then
		return nil, dotted .. " is a service; services cannot be deleted"
	end
	if not sync.session then
		return nil, "Forge Sync is not running in this Studio, so the plugin cannot tell what is synced; reconnect and try again"
	end
	local node: Instance = game
	for i, name in path do
		if type(name) ~= "string" or name == "" then
			return nil, "bad instance path"
		end
		local found, count = nil, 0
		for _, child in node:GetChildren() do
			if child.Name == name then
				found = found or child
				count += 1
			end
		end
		local here = table.concat(path, ".", 1, i)
		if count == 0 then
			return nil, here .. " is not in Studio (already deleted?)"
		elseif count > 1 then
			return nil, "Studio has " .. count .. " instances named " .. here .. "; delete the right one in Studio's Explorer"
		end
		node = found
	end
	if node.Parent == game then
		return nil, dotted .. " is a service; services cannot be deleted"
	end
	if type(className) == "string" and className ~= "" and node.ClassName ~= className then
		return nil, dotted .. " is a " .. node.ClassName .. " in Studio now, not a " .. className .. "; refresh and try again"
	end
	for _, r in sync.roots do
		if node == r or node:IsDescendantOf(r) then
			return nil, dotted .. " is synced to a file (a Rojo $path); delete the file in Forge instead"
		end
		if r:IsDescendantOf(node) then
			return nil, dotted .. " holds " .. table.concat(pathOf(r), ".") .. ", which is synced to files; delete those files in Forge instead"
		end
	end
	for _, p in sync.missing do
		if isPrefix(path, p) or isPrefix(p, path) then
			return nil, dotted .. " is where Rojo builds " .. table.concat(p, ".") .. "; it is not Studio-only"
		end
	end
	if node.Parent and node.Parent.Parent == game and node.Name == node.ClassName then
		return nil, dotted .. " is a default " .. node.ClassName .. " container; Studio needs it"
	end
	local key = pathKey(path)
	for _, sk in sync.skip do
		if underKey(key, sk) or underKey(sk, key) then
			return nil, dotted .. " is (or holds) a Wally packages folder; change the packages instead"
		end
	end
	return node, nil
end

local ChangeHistoryService: any = nil
pcall(function()
	ChangeHistoryService = game:GetService("ChangeHistoryService")
end)

-- Removes the instance (undoable); returns true or false and why.
local function deleteInStudio(path: any, className: any): (boolean, string?)
	local node, why = deleteTarget(path, className)
	if not node then
		return false, why
	end
	local recording = nil
	if ChangeHistoryService then
		local ok, id = pcall(function()
			return ChangeHistoryService:TryBeginRecording("Forge: delete " .. node.Name, "Delete " .. table.concat(path, ".") .. " (from RBX Forge)")
		end)
		recording = if ok then id else nil
	end
	if not recording then
		-- Without a recording Ctrl+Z could not bring it back: refuse rather than delete for good.
		return false, "Studio is recording another change (or refused to record this one); try again in a moment"
	end
	local ok, err = pcall(function()
		node.Parent = nil
	end)
	pcall(function()
		ChangeHistoryService:FinishRecording(recording, if ok then Enum.FinishRecordingOperation.Commit else Enum.FinishRecordingOperation.Cancel)
	end)
	if not ok then
		return false, "Studio refused: " .. tostring(err)
	end
	-- The Game tab drops it on the next loop turn instead of after the debounce.
	sync.outlineDirty = true
	sync.outlineFirst = 0
	print("[Forge Bridge] deleted " .. table.concat(path, ".") .. " (Ctrl+Z in Studio restores it)")
	return true, nil
end

local function runDeleteJob(job: any)
	local ok, err = pcall(function()
		post(job, { type = "accepted" })
		local target = if type(job.target) == "table" then job.target else {}
		local done, why = deleteInStudio(target.path, target.className)
		if done then
			post(job, { type = "done", marks = {} })
		else
			post(job, { type = "error", message = tostring(why) })
		end
	end)
	if not ok then
		warn("[Forge Bridge] " .. tostring(err))
	end
end

-- ------------------------------------------------------------ Model Lab (v10)

local function findByPath(path: any): Instance?
	if type(path) ~= "table" then
		return nil
	end
	local node: Instance? = game
	for i, name in path do
		if type(name) ~= "string" or not node then
			return nil
		end
		local child = node:FindFirstChild(name)
		if not child and i == 1 then
			-- "Workspace" / "ServerStorage"...: a service name
			local ok, service = pcall(function()
				return game:GetService(name)
			end)
			child = if ok then service else nil
		end
		node = child
	end
	return node
end

-- The floor in front of the camera, facing it (the model's front is -Z).
local function buildOrigin(): CFrame
	local camera = workspace.CurrentCamera
	local cf = if camera then camera.CFrame else CFrame.new(0, 10, 30)
	local look = Vector3.new(cf.LookVector.X, 0, cf.LookVector.Z)
	look = if look.Magnitude > 1e-3 then look.Unit else Vector3.new(0, 0, -1)
	local at = cf.Position + look * 28
	local hit = workspace:Raycast(at + Vector3.new(0, 300, 0), Vector3.new(0, -2000, 0))
	local ground = if hit then hit.Position else Vector3.new(at.X, 0, at.Z)
	return CFrame.lookAt(ground, ground - look)
end

local function runModelJob(job: any)
	local folder: Folder? = nil
	local ok, err = pcall(function()
		post(job, { type = "accepted" })
		local spec = if type(job.model) == "table" then job.model else {}
		local guard = nil
		if type(spec.guard) == "table" and #spec.guard > 0 then
			guard = findByPath(spec.guard)
			if not guard or not guard:IsA("Model") then
				error("the guard to copy, " .. table.concat(spec.guard, ".") .. ", is not a Model in this place", 0)
			end
		end
		folder = jobFolder()
		buildModules(job.modules or {}, folder :: Folder)
		local module = (folder :: Folder):FindFirstChild(job.entry or "Build")
		if not module then
			error("the job has no build script", 0)
		end
		local build = require(module :: ModuleScript) :: any
		if type(build) ~= "function" then
			error("the build script must return function(model, ctx)", 0)
		end
		local recording = nil
		if ChangeHistoryService then
			local okRec, id = pcall(function()
				return ChangeHistoryService:TryBeginRecording("Forge: build " .. tostring(job.name), "Build " .. tostring(job.name) .. " (RBX Forge Model Lab)")
			end)
			recording = if okRec then id else nil
		end
		local model = Instance.new("Model")
		model.Name = job.name
		local okBuild, buildErr = pcall(build, model, { origin = buildOrigin(), preview = false, guard = guard, areaId = spec.areaId })
		if okBuild then
			model.Parent = workspace
		else
			model:Destroy()
		end
		if recording then
			pcall(function()
				ChangeHistoryService:FinishRecording(recording, if okBuild then Enum.FinishRecordingOperation.Commit else Enum.FinishRecordingOperation.Cancel)
			end)
		end
		if not okBuild then
			error("the build script failed: " .. tostring(buildErr), 0)
		end
		pcall(function()
			game:GetService("Selection"):Set({ model })
		end)
		local parts = 0
		for _, d in model:GetDescendants() do
			if d:IsA("BasePart") then
				parts += 1
			end
		end
		print("[Forge Bridge] built " .. model:GetFullName() .. " (" .. parts .. " parts; Ctrl+Z in Studio removes it)")
		post(job, { type = "log", message = HttpService:JSONEncode({ built = model.Name, parts = parts, path = model:GetFullName() }) })
		post(job, { type = "done", marks = {} })
	end)
	if folder then
		folder:Destroy()
	end
	if not ok then
		warn("[Forge Bridge] " .. tostring(err))
		pcall(post, job, { type = "error", message = tostring(err) })
	end
end

-- ------------------------------------------------------------ poll loop

plugin.Unloading:Connect(function()
	alive = false
end)

task.spawn(function()
	while alive do
		if not enabled then
			task.wait(1)
			continue
		end
		local query = "/poll?v=" .. VERSION .. "&place=" .. HttpService:UrlEncode(game.Name) .. "&placeId=" .. tostring(game.PlaceId)
		local ok, answer = request("GET", query)
		if not ok then
			if connected then
				print("[Forge Bridge] RBX Forge is not reachable; retrying")
			end
			if sync.session then
				stopSync()
				sync.waitingForForge = true
			end
			connected = false
			task.wait(RETRY_SECONDS)
			continue
		end
		if not connected then
			connected = true
			print("[Forge Bridge] connected to RBX Forge")
		end
		if sync.waitingForForge then
			-- Forge is back (maybe restarted with a new session): fetch the config and resend everything.
			sync.waitingForForge = false
			sync.wanted = true
			sync.retryAt = 0
		end
		if type(answer) == "table" and answer.job then
			if answer.job.kind == "delete" then
				runDeleteJob(answer.job)
			elseif answer.job.kind == "model" then
				runModelJob(answer.job)
			else
				runJob(answer.job)
			end
		end
	end
end)

task.spawn(syncLoop)
