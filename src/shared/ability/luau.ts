// Game export of an ability, client side only: a data module per move (<Name>.luau, with a play()
// helper) and one shared runtime (AbilityRunner.luau) that plays everything in sync from anywhere on
// the client: the animation (Animator:LoadAnimation, AnimationTrack:Play / AdjustSpeed), the VFX Lab
// modules (Effect.play at the attach CFrame), sounds, camera shake (BindToRenderStep after the camera),
// screen effects (ColorCorrectionEffect / BloomEffect / BlurEffect under the current camera, a flash
// Frame) tweened with TweenService, hit-stop (the move's clock, the track speed and particle TimeScale
// dip together) and root velocity. Marker times are resolved at export; options.onMarker reports them
// so game code can hook gameplay on "release" without a server part here.
//
// Roblox API references (Creator Hub, read 2026-10-13): AnimationTrack (Play(fadeTime, weight,
// speed), AdjustSpeed, Stop), ColorCorrectionEffect (Brightness, Contrast, Saturation, TintColor),
// BloomEffect (Intensity, Size, Threshold), BlurEffect (Size), RunService:BindToRenderStep,
// TweenService:Create, ParticleEmitter.TimeScale, BasePart.AssemblyLinearVelocity.
//
// The project's AGENTS.md forbids comments in game scripts, so the generated Luau has none.

import { fmt } from '../vfx/sequence.ts'
import type { Rgb, Vec3 } from '../vfx/types.ts'
import { resolveAbility, type EventLengths } from './timing.ts'
import type { Ability, AbilityEvent } from './types.ts'

export const RUNNER_MODULE = 'AbilityRunner'
export const RUNNER_VERSION = 1
export const RUNNER_SENTINEL = 'rbx-forge-ability-runner'

export function isOwnRunner(src: string): boolean {
  return src.includes(`AbilityRunner.Forge = "${RUNNER_SENTINEL}"`)
}

const str = (s: string) => JSON.stringify(String(s))
const v3 = (v: Vec3) => `Vector3.new(${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])})`
const c3 = (c: Rgb) => `Color3.new(${fmt(c[0])}, ${fmt(c[1])}, ${fmt(c[2])})`
const cfOffset = (o: Vec3, r: Vec3) => {
  const base = `CFrame.new(${fmt(o[0])}, ${fmt(o[1])}, ${fmt(o[2])})`
  return r.some((x) => x !== 0) ? `${base} * CFrame.Angles(math.rad(${fmt(r[0])}), math.rad(${fmt(r[1])}), math.rad(${fmt(r[2])}))` : base
}

function eventTable(ev: AbilityEvent, at: number, indent: string): string | null {
  const bits = [`Id = ${str(ev.id)}`, `At = ${fmt(at)}`]
  if (ev.at.marker) bits.push(`Marker = ${str(ev.at.marker)}`, `MarkerOffset = ${fmt(ev.at.at)}`)
  switch (ev.kind) {
    case 'vfx':
      bits.splice(1, 0, `Kind = "Vfx"`)
      bits.push(`Effect = ${str(ev.effectName)}`, `Part = ${str(ev.part)}`)
      if (ev.attachment) bits.push(`Attachment = ${str(ev.attachment)}`)
      bits.push(`Offset = ${cfOffset(ev.offset, ev.rotation)}`)
      break
    case 'sound':
      if (ev.source.kind !== 'asset' || !ev.source.id) return null
      bits.splice(1, 0, `Kind = "Sound"`)
      bits.push(`SoundId = ${str(ev.source.id)}`, `Volume = ${fmt(ev.volume)}`, `Pitch = ${fmt(ev.pitch)}`)
      if (ev.part) bits.push(`Part = ${str(ev.part)}`)
      break
    case 'shake':
      bits.splice(1, 0, `Kind = "Shake"`)
      bits.push(`Duration = ${fmt(ev.duration)}`, `Amplitude = ${fmt(ev.amplitude)}`, `Frequency = ${fmt(ev.frequency)}`, `Falloff = ${str(ev.falloff)}`)
      break
    case 'screen': {
      bits.splice(1, 0, `Kind = "Screen"`)
      bits.push(`Effect = ${str(ev.effect)}`, `Attack = ${fmt(ev.attack)}`, `Hold = ${fmt(ev.hold)}`, `Release = ${fmt(ev.release)}`, `Style = ${str(ev.style)}`)
      const v = ev.values
      const goals: string[] = []
      if (ev.effect === 'flash') goals.push(`Color = ${c3(v.color ?? [1, 1, 1])}`, `Opacity = ${fmt(v.opacity ?? 0.8)}`)
      if (ev.effect === 'colorCorrection') goals.push(`Brightness = ${fmt(v.brightness ?? 0)}`, `Contrast = ${fmt(v.contrast ?? 0)}`, `Saturation = ${fmt(v.saturation ?? 0)}`, `TintColor = ${c3(v.tint ?? [1, 1, 1])}`)
      if (ev.effect === 'bloom') goals.push(`Intensity = ${fmt(v.intensity ?? 1)}`, `Size = ${fmt(v.size ?? 24)}`, `Threshold = ${fmt(v.threshold ?? 0.8)}`)
      if (ev.effect === 'blur') goals.push(`Size = ${fmt(v.size ?? 12)}`)
      bits.push(`Values = { ${goals.join(', ')} }`)
      break
    }
    case 'hitstop':
      bits.splice(1, 0, `Kind = "HitStop"`)
      bits.push(`Duration = ${fmt(ev.duration)}`, `TimeScale = ${fmt(ev.timeScale)}`)
      break
    case 'move':
      bits.splice(1, 0, `Kind = "Move"`)
      bits.push(`Duration = ${fmt(ev.duration)}`, `Velocity = ${v3(ev.velocity)}`, `Easing = ${str(ev.easing)}`)
      break
  }
  return `${indent}{ ${bits.join(', ')} },`
}

// The move's data module. Skipped (and reported): muted events, sounds without an asset id.
export function abilityModule(ability: Ability, lengths: EventLengths = {}): { source: string; skipped: string[] } {
  const r = resolveAbility(ability, lengths)
  const name = ability.name
  const skipped: string[] = []
  const rows: string[] = []
  for (const e of r.events) {
    const row = eventTable(e.event, e.start, '\t\t')
    if (row) rows.push(row)
    else skipped.push(`${e.id}: sound without a Roblox asset id`)
  }
  for (const e of ability.events) if (e.muted) skipped.push(`${e.id}: muted`)
  const a = ability.animation
  const anim = a ? `{ Id = ${str(a.assetId ?? '')}, Name = ${str(a.name)}, Clip = ${str(a.clip)}, Speed = ${fmt(a.speed)}, FadeIn = ${fmt(a.fadeIn)}, Start = ${fmt(a.start)}, Length = ${fmt(a.duration)} }` : 'nil'
  const markers = r.markers.map((m) => `{ Name = ${str(m.name)}, At = ${fmt(m.t)} }`)
  const source = `local ${RUNNER_MODULE} = require(script.Parent:WaitForChild("${RUNNER_MODULE}"))

local ${name} = {
\tName = ${str(name)},
\tDuration = ${fmt(ability.duration)},
\tAnimation = ${anim},
\tMarkers = { ${markers.join(', ')} },
\tEvents = {
${rows.join('\n')}
\t},
}

function ${name}.play(character: Model, options: { [string]: any }?)
\treturn ${RUNNER_MODULE}.play(character, ${name}, options)
end

return ${name}
`
  return { source, skipped }
}

// The shared client runtime. vfxPath: instance path of the folder holding the VFX Lab modules.
export function runnerModule(vfxPath: string[] = ['ReplicatedStorage', 'Shared', 'VFX']): string {
  const path = vfxPath.map(str).join(', ')
  return `local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local SoundService = game:GetService("SoundService")
local TweenService = game:GetService("TweenService")
local Debris = game:GetService("Debris")

local AbilityRunner = {}
AbilityRunner.Forge = "${RUNNER_SENTINEL}"
AbilityRunner.Version = ${RUNNER_VERSION}
AbilityRunner.VfxPath = { ${path} }

local effects: { [string]: any } = {}
local renderSeq = 0

local function vfxFolder(): Instance?
	local node: Instance? = game:GetService(AbilityRunner.VfxPath[1])
	for i = 2, #AbilityRunner.VfxPath do
		if not node then
			return nil
		end
		node = node:WaitForChild(AbilityRunner.VfxPath[i], 5)
	end
	return node
end

local function effectModule(name: string): any
	local cached = effects[name]
	if cached ~= nil then
		return if cached == false then nil else cached
	end
	local folder = vfxFolder()
	local module = folder and folder:FindFirstChild(name)
	if not module then
		warn(\`AbilityRunner: VFX module "{name}" not found\`)
		effects[name] = false
		return nil
	end
	local ok, result = pcall(require, module)
	if not ok then
		warn(\`AbilityRunner: VFX module "{name}" failed: {result}\`)
		effects[name] = false
		return nil
	end
	effects[name] = result
	return result
end

local function easing(name: string?): Enum.EasingStyle
	local ok, style = pcall(function()
		return (Enum.EasingStyle :: any)[name or "Quad"]
	end)
	return if ok and style then style else Enum.EasingStyle.Quad
end

local function falloff(kind: string, u: number): number
	if kind == "none" then
		return 1
	elseif kind == "linear" then
		return 1 - u
	end
	return math.exp(-4.5 * u) * (1 - u)
end

local Handle = {}
Handle.__index = Handle

function Handle:_scale(): number
	local s = 1
	for _, ev in self.events do
		if ev.Kind == "HitStop" and self.clock >= ev.At and self.clock < ev.At + ev.Duration * ev.TimeScale then
			s = math.min(s, math.max(0.001, ev.TimeScale))
		end
	end
	return s
end

function Handle:_setTimeScale(scale: number)
	if scale == self.timeScale then
		return
	end
	self.timeScale = scale
	if self.track and self.track.IsPlaying then
		self.track:AdjustSpeed(self.speed * scale)
	end
	for _, model in self.models do
		for _, d in model:GetDescendants() do
			if d:IsA("ParticleEmitter") then
				if self.particleScale[d] == nil then
					self.particleScale[d] = d.TimeScale
				end
				d.TimeScale = self.particleScale[d] * scale
			end
		end
	end
end

function Handle:_partCFrame(partName: string?, attachmentName: string?): CFrame?
	if attachmentName then
		local part = partName and self.character:FindFirstChild(partName)
		local att = (part and part:FindFirstChild(attachmentName)) or self.character:FindFirstChild(attachmentName, true)
		if att and att:IsA("Attachment") then
			return att.WorldCFrame
		end
	end
	local part = self.character:FindFirstChild(partName or "HumanoidRootPart")
	if part and part:IsA("BasePart") then
		return part.CFrame
	end
	return nil
end

function Handle:_screen(ev: any)
	if not self.cameraFx then
		return
	end
	local camera = workspace.CurrentCamera
	local info = TweenInfo.new(ev.Attack, easing(ev.Style), Enum.EasingDirection.Out)
	local back = TweenInfo.new(ev.Release, easing(ev.Style), Enum.EasingDirection.In)
	local v = ev.Values
	local inst: Instance
	local peak: { [string]: any }
	local neutral: { [string]: any }
	if ev.Effect == "flash" then
		local player = Players.LocalPlayer
		local gui = Instance.new("ScreenGui")
		gui.Name = "AbilityFlash"
		gui.IgnoreGuiInset = true
		gui.DisplayOrder = 100
		gui.ResetOnSpawn = false
		local frame = Instance.new("Frame")
		frame.Size = UDim2.fromScale(1, 1)
		frame.BorderSizePixel = 0
		frame.BackgroundColor3 = v.Color
		frame.BackgroundTransparency = 1
		frame.Parent = gui
		gui.Parent = player and player:FindFirstChildOfClass("PlayerGui")
		table.insert(self.screens, gui)
		inst = frame
		peak = { BackgroundTransparency = 1 - v.Opacity }
		neutral = { BackgroundTransparency = 1 }
		Debris:AddItem(gui, ev.Attack + ev.Hold + ev.Release + 0.5)
	else
		local effect: Instance
		if ev.Effect == "colorCorrection" then
			effect = Instance.new("ColorCorrectionEffect")
			peak = { Brightness = v.Brightness, Contrast = v.Contrast, Saturation = v.Saturation, TintColor = v.TintColor }
			neutral = { Brightness = 0, Contrast = 0, Saturation = 0, TintColor = Color3.new(1, 1, 1) }
		elseif ev.Effect == "bloom" then
			local bloom = Instance.new("BloomEffect")
			bloom.Intensity = 0
			bloom.Size = v.Size
			bloom.Threshold = v.Threshold
			effect = bloom
			peak = { Intensity = v.Intensity }
			neutral = { Intensity = 0 }
		else
			local blur = Instance.new("BlurEffect")
			blur.Size = 0
			effect = blur
			peak = { Size = v.Size }
			neutral = { Size = 0 }
		end
		effect.Name = "Ability" .. ev.Id
		effect.Parent = camera
		table.insert(self.screens, effect)
		inst = effect
		Debris:AddItem(effect, ev.Attack + ev.Hold + ev.Release + 0.5)
	end
	TweenService:Create(inst, info, peak):Play()
	task.delay(ev.Attack + ev.Hold, function()
		if inst.Parent then
			TweenService:Create(inst, back, neutral):Play()
		end
	end)
end

function Handle:_fire(ev: any)
	local kind = ev.Kind
	if kind == "Vfx" then
		local module = effectModule(ev.Effect)
		local base = self:_partCFrame(ev.Part, ev.Attachment)
		if module and base then
			local ok, model = pcall(module.play, base * ev.Offset, self.options.vfxParent or workspace)
			if ok and model then
				table.insert(self.models, model)
			elseif not ok then
				warn(\`AbilityRunner: {ev.Effect}: {model}\`)
			end
		end
	elseif kind == "Sound" then
		local sound = Instance.new("Sound")
		sound.Name = "Ability" .. ev.Id
		sound.SoundId = ev.SoundId
		sound.Volume = ev.Volume
		sound.PlaybackSpeed = ev.Pitch
		local part = ev.Part and self.character:FindFirstChild(ev.Part)
		sound.Parent = if part then part else SoundService
		sound:Play()
		sound.Ended:Once(function()
			sound:Destroy()
		end)
		Debris:AddItem(sound, 15)
	elseif kind == "Screen" then
		self:_screen(ev)
	elseif kind == "Shake" then
		if self.cameraFx then
			table.insert(self.shakes, ev)
		end
	elseif kind == "Move" then
		table.insert(self.moves, ev)
	end
end

function Handle:_shakeOffset(): CFrame
	local x, y, z, roll = 0, 0, 0, 0
	local keep = {}
	for _, ev in self.shakes do
		local u = (self.clock - ev.At) / math.max(0.001, ev.Duration)
		if u < 1 then
			table.insert(keep, ev)
			local amp = ev.Amplitude * falloff(ev.Falloff, math.max(0, u))
			local w = 2 * math.pi * ev.Frequency * (self.clock - ev.At)
			x += amp * (0.7 * math.sin(w + 0.3) + 0.3 * math.sin(w * 2.37 + 1.1))
			y += amp * (0.7 * math.sin(w * 1.13 + 2.1) + 0.3 * math.sin(w * 2.71 + 0.4))
			z += amp * 0.25 * math.sin(w * 0.91 + 4.2)
			roll += amp * 0.02 * math.sin(w * 0.77 + 0.9)
		end
	end
	self.shakes = keep
	return CFrame.new(x, y, z) * CFrame.Angles(0, 0, roll)
end

function Handle:_move()
	if #self.moves == 0 or not self.root then
		return
	end
	local sum = Vector3.zero
	local vertical = false
	local keep = {}
	for _, ev in self.moves do
		local u = (self.clock - ev.At) / math.max(0.001, ev.Duration)
		if u < 1 then
			table.insert(keep, ev)
			local k = if ev.Easing == "decay" then 1 - math.max(0, u) else 1
			sum += ev.Velocity * k * self.timeScale
			vertical = vertical or ev.Velocity.Y ~= 0
		end
	end
	self.moves = keep
	if #keep > 0 then
		local world = self.root.CFrame:VectorToWorldSpace(sum)
		local current = self.root.AssemblyLinearVelocity
		self.root.AssemblyLinearVelocity = Vector3.new(world.X, if vertical then world.Y else current.Y, world.Z)
	end
end

function Handle:_step(dt: number)
	if not self.alive then
		return
	end
	self:_setTimeScale(self:_scale())
	self.clock += dt * self.timeScale * self.globalSpeed
	while self.next <= #self.events and self.events[self.next].At <= self.clock do
		local ev = self.events[self.next]
		self.next += 1
		if ev.Kind == "Animation" then
			if self.track then
				self.track:Play(ev.FadeIn, 1, self.speed * self.timeScale)
			end
		elseif ev.Kind ~= "HitStop" then
			self:_fire(ev)
		end
	end
	while self.nextMarker <= #self.markers and self.markers[self.nextMarker].At <= self.clock do
		local m = self.markers[self.nextMarker]
		self.nextMarker += 1
		if self.options.onMarker then
			task.spawn(self.options.onMarker, m.Name, m.At)
		end
	end
	self:_move()
	if self.clock >= self.duration and #self.shakes == 0 and #self.moves == 0 then
		self:Stop(false)
	end
end

function Handle:Stop(cancelAnimation: boolean?)
	if not self.alive then
		return
	end
	self.alive = false
	if self.connection then
		self.connection:Disconnect()
	end
	if self.renderName then
		RunService:UnbindFromRenderStep(self.renderName)
	end
	self:_setTimeScale(1)
	if self.track and cancelAnimation ~= false then
		self.track:Stop(0.15)
	end
	if cancelAnimation ~= false then
		for _, inst in self.screens do
			inst:Destroy()
		end
	end
	self.finished:Fire()
end

function AbilityRunner.play(character: Model, def: any, options: { [string]: any }?)
	local opts = options or {}
	local humanoid = character:FindFirstChildOfClass("Humanoid")
	local root = character:FindFirstChild("HumanoidRootPart")
	if not humanoid or not root then
		warn("AbilityRunner: the character needs a Humanoid and a HumanoidRootPart")
		return nil
	end
	local events = table.clone(def.Events)
	local anim = def.Animation
	local track: AnimationTrack? = nil
	if anim and anim.Id ~= "" then
		local animator = humanoid:FindFirstChildOfClass("Animator") or Instance.new("Animator", humanoid)
		local animation = Instance.new("Animation")
		animation.AnimationId = anim.Id
		track = animator:LoadAnimation(animation)
		table.insert(events, { Kind = "Animation", At = anim.Start, FadeIn = anim.FadeIn })
	elseif anim then
		warn(\`AbilityRunner: {def.Name}: the animation "{anim.Name}" has no asset id yet\`)
	end
	table.sort(events, function(a, b)
		return a.At < b.At
	end)
	local markers = table.clone(def.Markers or {})
	table.sort(markers, function(a, b)
		return a.At < b.At
	end)
	local localPlayer = Players.LocalPlayer
	local finished = Instance.new("BindableEvent")
	local self = setmetatable({
		character = character,
		root = root,
		options = opts,
		events = events,
		markers = markers,
		next = 1,
		nextMarker = 1,
		clock = 0,
		duration = def.Duration,
		speed = if anim then anim.Speed else 1,
		globalSpeed = opts.speed or 1,
		timeScale = 1,
		track = track,
		models = {},
		particleScale = {},
		screens = {},
		shakes = {},
		moves = {},
		alive = true,
		cameraFx = opts.camera ~= false and (opts.camera == true or (localPlayer ~= nil and localPlayer.Character == character)),
		finished = finished,
		Ended = finished.Event,
	}, Handle)
	if self.cameraFx then
		renderSeq += 1
		self.renderName = "AbilityShake" .. renderSeq
		RunService:BindToRenderStep(self.renderName, Enum.RenderPriority.Camera.Value + 1, function()
			if #self.shakes > 0 then
				local camera = workspace.CurrentCamera
				camera.CFrame = camera.CFrame * self:_shakeOffset()
			end
		end)
	end
	self.connection = RunService.Heartbeat:Connect(function(dt)
		self:_step(dt)
	end)
	self:_step(0)
	return self
end

return AbilityRunner
`
}
