--!nonstrict
-- forge-bridge-version: __FORGE_BRIDGE_VERSION__
-- Forge Bridge: the Studio side of RBX Forge's "Studio check". RBX Forge writes this plugin into the
-- local Plugins folder; it polls Forge on 127.0.0.1 for jobs. A job plays a VFX Lab effect, an
-- Animation Lab clip or an Ability Composer move on a small stage in front of a fixed camera, while
-- Forge records the Studio window and keeps the frames at the key beats for its critic.
--
-- Everything it creates is removed after each job and the camera is put back. It never runs in play
-- mode and only talks to 127.0.0.1. Studio asks once to allow HTTP requests to 127.0.0.1 and to allow
-- script injection (it creates the job's ModuleScripts from Forge's Luau).
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
			connected = false
			task.wait(RETRY_SECONDS)
			continue
		end
		if not connected then
			connected = true
			print("[Forge Bridge] connected to RBX Forge")
		end
		if type(answer) == "table" and answer.job then
			runJob(answer.job)
		end
	end
end)
