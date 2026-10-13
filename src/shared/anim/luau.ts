// The Luau module an exported clip gets: src/shared/Animations/<Name>/init.luau next to the
// KeyframeSequence src/shared/Animations/<Name>/Sequence.rbxmx (Rojo turns the folder into a
// ModuleScript with the sequence as its child "Sequence").
//
// Roblox plays animations by asset id: an Animation instance's AnimationId loaded through an
// Animator (Animator:LoadAnimation). A KeyframeSequence becomes an asset id once it is uploaded
// (the Animation Editor's publish, or Open Cloud's Assets API with assetType "Animation"). Until
// then, KeyframeSequenceProvider:RegisterKeyframeSequence gives a temporary id that only works in
// Studio, for local testing, which the module uses as a fallback.
//   https://create.roblox.com/docs/reference/engine/classes/KeyframeSequenceProvider#RegisterKeyframeSequence
//   https://create.roblox.com/docs/reference/engine/classes/Animator#LoadAnimation
//   https://create.roblox.com/docs/reference/engine/classes/AnimationTrack#GetMarkerReachedSignal

import type { AnimClip } from './model.ts'

export const ANIM_SRC_DIR = 'src/shared/Animations'
export const ANIM_SEQUENCE_FILE = 'Sequence.rbxmx'

const num = (v: number) => String(Math.round(v * 1000) / 1000)

export function animModuleName(name: string): string {
  const clean = String(name ?? '').replace(/[^\w]/g, '')
  return /^[A-Za-z_]/.test(clean) ? clean.slice(0, 50) : `Anim${clean}`.slice(0, 50) || 'Animation'
}

export function luauString(s: string): string {
  return JSON.stringify(String(s ?? ''))
}

export function animLuauModule(clip: AnimClip, opts: { description?: string; assetId?: string } = {}): string {
  const name = animModuleName(clip.name)
  const markers = clip.markers.length ? `{\n${clip.markers.map((m) => `\t{ name = ${luauString(m.name)}, time = ${num(m.t)} },`).join('\n')}\n}` : '{}'
  const id = opts.assetId ? `rbxassetid://${opts.assetId.replace(/\D/g, '')}` : ''
  const desc = (opts.description ?? '').split('\n').map((l) => `-- ${l}`.trimEnd()).join('\n')
  return `--!strict
-- ${name}: an R15 animation made in RBX Forge's Animation Lab.
${desc ? `${desc}\n` : ''}--
-- Usage (server or client, on a character with a Humanoid or an AnimationController):
--   local Anim = require(path.to.${name})
--   local track = Anim.play(character, {
${clip.markers.length ? clip.markers.map((m) => `--     [${luauString(m.name)}] = function(track, value) end, -- at ${num(m.t)} s`).join('\n') : '--     -- marker name = function(track, value) end'}
--   })
--
-- AnimationId: Roblox plays animations by asset id. Upload Sequence (the KeyframeSequence next to this
-- module) with the Animation Editor's Publish, or with Upload in Forge (Open Cloud), and put the id
-- here. Without an id the module registers Sequence with KeyframeSequenceProvider, which gives a
-- temporary id that only works in Studio (for testing), never in a live game.
local KeyframeSequenceProvider = game:GetService("KeyframeSequenceProvider")
local RunService = game:GetService("RunService")

local Anim = {}

Anim.Name = ${luauString(name)}
Anim.AnimationId = ${luauString(id)}
Anim.Length = ${num(clip.duration)}
Anim.Looped = ${clip.looped ? 'true' : 'false'}
Anim.Priority = Enum.AnimationPriority.${clip.priority}
Anim.Markers = ${markers}

local studioId: string? = nil

function Anim.animationId(): string
	if Anim.AnimationId ~= "" then
		return Anim.AnimationId
	end
	if studioId then
		return studioId
	end
	local sequence = script:FindFirstChild("Sequence")
	if sequence and sequence:IsA("KeyframeSequence") and RunService:IsStudio() then
		studioId = KeyframeSequenceProvider:RegisterKeyframeSequence(sequence)
		return studioId :: string
	end
	error(\`{Anim.Name}: no AnimationId. Upload the Sequence KeyframeSequence to Roblox and set Anim.AnimationId (the Studio-only fallback does not work in live games).\`)
end

local function animatorOf(target: Instance): Animator
	if target:IsA("Animator") then
		return target
	end
	local host: Instance? = target
	if target:IsA("Model") then
		host = target:FindFirstChildOfClass("Humanoid") or target:FindFirstChildOfClass("AnimationController")
	end
	assert(host, \`{Anim.Name}: {target:GetFullName()} has no Humanoid or AnimationController\`)
	local animator = host:FindFirstChildOfClass("Animator")
	if not animator then
		-- Create the Animator on the server so animations replicate to every client.
		animator = Instance.new("Animator")
		animator.Parent = host
	end
	return animator :: Animator
end

-- Loads the clip on a character (Model), Humanoid, AnimationController or Animator.
function Anim.load(target: Instance): AnimationTrack
	local animation = Instance.new("Animation")
	animation.AnimationId = Anim.animationId()
	local track = animatorOf(target):LoadAnimation(animation)
	track.Priority = Anim.Priority
	track.Looped = Anim.Looped
	return track
end

-- Loads and plays it. handlers maps marker names (Anim.Markers) to functions(track, value).
function Anim.play(target: Instance, handlers: { [string]: (AnimationTrack, string) -> () }?, fadeTime: number?, speed: number?): AnimationTrack
	local track = Anim.load(target)
	local connections = {}
	for marker, handler in handlers or {} do
		table.insert(connections, track:GetMarkerReachedSignal(marker):Connect(function(value)
			handler(track, value)
		end))
	end
	track.Stopped:Once(function()
		for _, c in connections do
			c:Disconnect()
		end
	end)
	track:Play(fadeTime or 0.1, 1, speed or 1)
	return track
end

return Anim
`
}
