// "Play Studio selection": a Forge Bridge job (plugin v1 job protocol, any plugin version, like the
// live loop in live.ts) that plays whatever is selected in Roblox Studio with ForgeVFX
// (emitRuntime.ts), so an attribute-driven effect built in Studio can be watched without writing
// code or entering Play mode. The job ships two modules: ForgeVFX (the same source Forge writes into
// projects; the job module marks it Archivable = false) and the entry module below. The entry:
//   - reads Selection:Get() once (Models, Folders, parts, Attachments; Forge's own folders skipped),
//   - frames the camera on it (the plugin puts the user's camera back when the job ends),
//   - emits a clone of each selected effect at its own pivot into Workspace.ForgeLivePreview
//     (Archivable false, never saved; Forge Sync skips it), once or looped with a gap,
//   - in a loop asks Forge every POLL seconds whether to go on ('log' event
//     "forge-vfxplay-poll <plays>", answered { play: { stop?, gap } }); no answer = stop,
//   - reports "forge-vfxplay-info <count> <names>" once and errors as "forge-vfxplay-error <text>".
// Every clone is removed when the job ends (Stop, another Studio job preempting it, Forge closing).
// Pure code: the module source, the job, the message format. main/services/vfx/selectionPlay.ts
// drives it.

import { CAMERAS, assertModuleSizes } from '../studio/payload.ts'
import { KEY_COLOR } from '../studio/crop.ts'
import { BRIDGE_VERSION, type BridgeJob } from '../studio/protocol.ts'
import { EMIT_RUNTIME_MODULE, FORGEVFX_SOURCE } from './emitRuntime.ts'
import { LIVE_FOLDER } from './live.ts'

export const PLAY_ENTRY = 'ForgeVFXPlay'
export const PLAY_POLL_TAG = 'forge-vfxplay-poll'
export const PLAY_INFO_TAG = 'forge-vfxplay-info'
export const PLAY_ERROR_TAG = 'forge-vfxplay-error'
export const PLAY_POLL_S = 0.25
export const PLAY_DEFAULT_GAP = 0.75
// A one-shot play waits at most this long for its effects to finish.
export const PLAY_ONCE_MAX_S = 60

// What the lab shows ("Playing the Studio selection · Fireball, Ring").
export interface SelectionPlayStatus {
  state: 'off' | 'starting' | 'playing'
  loop: boolean
  gap: number
  plays: number
  // Names of the selected effects (from Studio, at most 8) and how many there were.
  names: string[]
  count: number
  error?: string
  errorCode?: 'script-injection'
}

export interface SelectionPlayAnswer {
  stop?: boolean
  gap: number
}

export function normalizeGap(gap: unknown): number {
  const g = Number(gap)
  return Number.isFinite(g) ? Math.min(10, Math.max(0, g)) : PLAY_DEFAULT_GAP
}

// "forge-vfxplay-poll 3" -> plays
export function parsePlayPoll(message: string): { plays: number } | null {
  const m = new RegExp(`^${PLAY_POLL_TAG} (\\d+)$`).exec(message)
  return m ? { plays: Number(m[1]) } : null
}

// "forge-vfxplay-info 2 Fireball, Ring"
export function parsePlayInfo(message: string): { count: number; names: string[] } | null {
  const m = new RegExp(`^${PLAY_INFO_TAG} (\\d+)(?: (.*))?$`).exec(message)
  if (!m) return null
  const names = (m[2] ?? '')
    .split(', ')
    .map((s) => s.trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 8)
  return { count: Number(m[1]), names }
}

export function parsePlayError(message: string): string | null {
  return message.startsWith(PLAY_ERROR_TAG + ' ') ? message.slice(PLAY_ERROR_TAG.length + 1).slice(0, 300) : null
}

export function playModuleSource(opts: { port: number; jobId: string; loop: boolean; gap: number }): string {
  if (!/^[\w-]{1,80}$/.test(opts.jobId)) throw new Error('bad job id')
  const port = Math.floor(Number(opts.port))
  if (!Number.isFinite(port) || port <= 0 || port > 65535) throw new Error('bad port')
  return `-- RBX Forge: plays the current Studio selection with ForgeVFX (attribute-driven effects). Clones go
-- into Workspace.${LIVE_FOLDER} (not saved) and are removed when the job ends.
local HttpService = game:GetService("HttpService")
local Selection = game:GetService("Selection")
local URL = "http://127.0.0.1:${port}/forge-bridge/event/${opts.jobId}"
local LOOP = ${opts.loop ? 'true' : 'false'}
local GAP = ${normalizeGap(opts.gap)}
local POLL = ${PLAY_POLL_S}
local ONCE_MAX = ${PLAY_ONCE_MAX_S}
local FOLDER = "${LIVE_FOLDER}"
local RUNTIME = "${EMIT_RUNTIME_MODULE}"
local M = {}

local function send(message)
	local ok, res = pcall(function()
		return HttpService:RequestAsync({
			Url = URL,
			Method = "POST",
			Headers = { ["Content-Type"] = "application/json" },
			Body = HttpService:JSONEncode({ type = "log", message = message }),
		})
	end)
	if not ok or not res.Success then
		return nil
	end
	local okJ, body = pcall(function()
		return HttpService:JSONDecode(res.Body)
	end)
	if not okJ or type(body) ~= "table" then
		return nil
	end
	return body
end

local function report(message)
	send("${PLAY_ERROR_TAG} " .. string.sub(tostring(message), 1, 300))
end

-- Forge's answer to a poll; nil = stop.
local function ask(plays)
	local body = send("${PLAY_POLL_TAG} " .. plays)
	if not body or body.abort or type(body.play) ~= "table" or body.play.stop then
		return nil
	end
	return body.play
end

-- Forge's own instances (earlier plays, the bridge stage) and anything without a place are skipped.
local function skip(inst)
	if inst == workspace or inst.Parent == nil or inst.Parent == game then
		return true
	end
	local cur = inst
	while cur and cur ~= game do
		if cur.Name == FOLDER or cur.Name == "ForgeBridgeStage" or cur.Name == "ForgeBridgeJob" then
			return true
		end
		if cur.Name == "ForgeVFX" and cur.Parent == workspace then
			return true
		end
		cur = cur.Parent
	end
	return not (inst:IsA("PVInstance") or inst:IsA("Folder") or inst:IsA("Attachment"))
end

local function centreOf(inst)
	local ok, cf, size = pcall(function()
		if inst:IsA("Model") then
			return inst:GetBoundingBox()
		elseif inst:IsA("BasePart") then
			return inst.CFrame, inst.Size
		elseif inst:IsA("Attachment") then
			return inst.WorldCFrame, Vector3.new(4, 4, 4)
		end
		return nil, nil
	end)
	if ok and typeof(cf) == "CFrame" and typeof(size) == "Vector3" then
		return cf.Position, size.Magnitude / 2
	end
	local sum, n = Vector3.zero, 0
	for _, d in inst:GetDescendants() do
		if d:IsA("BasePart") then
			sum += d.Position
			n += 1
		elseif d:IsA("Attachment") then
			sum += d.WorldPosition
			n += 1
		end
	end
	if n == 0 then
		return nil, 0
	end
	return sum / n, 6
end

local function frame(list)
	local centres, radius = {}, 2
	for _, inst in list do
		local c, r = centreOf(inst)
		if c then
			table.insert(centres, { c = c, r = r })
		end
	end
	if #centres == 0 then
		return
	end
	local sum = Vector3.zero
	for _, x in centres do
		sum += x.c
	end
	local centre = sum / #centres
	for _, x in centres do
		radius = math.max(radius, (x.c - centre).Magnitude + x.r)
	end
	local dist = math.clamp(radius * 2.6, 8, 400)
	local camera = workspace.CurrentCamera
	camera.CFrame = CFrame.lookAt(centre + Vector3.new(0.6, 0.45, 1).Unit * dist, centre)
	camera.Focus = CFrame.new(centre)
end

local function playing(handles)
	local keep = {}
	for _, e in handles do
		if e:IsPlaying() then
			table.insert(keep, e)
		end
	end
	return keep
end

function M.play(_origin, _stage, _opts)
	local runtime = script.Parent:FindFirstChild(RUNTIME)
	if not runtime then
		report("the job has no " .. RUNTIME .. " module")
		return
	end
	runtime.Archivable = false
	local okR, ForgeVFX = pcall(require, runtime)
	if not okR or type(ForgeVFX) ~= "table" then
		report("could not load " .. RUNTIME .. ": " .. tostring(ForgeVFX))
		return
	end
	local list = {}
	for _, inst in Selection:Get() do
		if not skip(inst) then
			table.insert(list, inst)
		end
	end
	if #list == 0 then
		report("nothing to play: select an effect (a Model, Folder, Part or Attachment) in Studio first")
		return
	end
	local names = {}
	for i, inst in list do
		if i <= 8 then
			table.insert(names, inst.Name)
		end
	end
	send("${PLAY_INFO_TAG} " .. #list .. " " .. table.concat(names, ", "))
	local old = workspace:FindFirstChild(FOLDER)
	if old then
		old:Destroy()
	end
	local folder = Instance.new("Folder")
	folder.Name = FOLDER
	folder.Archivable = false
	folder.Parent = workspace
	pcall(frame, list)
	local handles = {}
	local plays = 0
	local gap = GAP
	local alive = true
	while alive do
		local longest = 0
		local started = 0
		for _, inst in list do
			if inst.Parent then
				local ok, e = pcall(ForgeVFX.emit, inst, nil, { parent = folder })
				if ok then
					table.insert(handles, e)
					longest = math.max(longest, e.Duration)
					started += 1
				elseif plays == 0 then
					report(inst.Name .. ": " .. tostring(e))
				end
			end
		end
		plays += 1
		if started == 0 then
			if plays > 1 then
				report("the selected effects are gone")
			end
			break
		end
		if not LOOP then
			-- Once: wait for every clone to finish (clean-up included).
			local deadline = os.clock() + ONCE_MAX
			while os.clock() < deadline and #playing(handles) > 0 do
				task.wait(0.1)
			end
			break
		end
		local untilT = os.clock() + longest + gap
		repeat
			local answer = ask(plays)
			if not answer then
				alive = false
				break
			end
			gap = tonumber(answer.gap) or gap
			untilT = math.min(untilT, os.clock() + longest + gap)
			task.wait(POLL)
		until os.clock() >= untilT
		handles = playing(handles)
	end
	for _, e in handles do
		pcall(function()
			e:Stop(true)
		end)
	end
	folder:Destroy()
end

return M
`
}

export function playSelectionJob(opts: { id: string; port: number; loop: boolean; gap: number }): BridgeJob {
  const modules: BridgeJob['modules'] = [
    { name: EMIT_RUNTIME_MODULE, className: 'ModuleScript', source: FORGEVFX_SOURCE },
    { name: PLAY_ENTRY, className: 'ModuleScript', source: playModuleSource({ port: opts.port, jobId: opts.id, loop: opts.loop, gap: opts.gap }) }
  ]
  assertModuleSizes(modules)
  return {
    id: opts.id,
    version: BRIDGE_VERSION,
    kind: 'vfx',
    mode: 'realtime',
    name: 'Play selection',
    rig: 'R15',
    duration: 0,
    beats: [],
    camera: CAMERAS.vfx,
    modules,
    entry: PLAY_ENTRY,
    calibrate: false,
    key: KEY_COLOR,
    linger: 0,
    // A loop runs until Forge says stop; a single play is over in seconds.
    timeout: opts.loop ? 12 * 3600 : PLAY_ONCE_MAX_S + 60
  }
}

// Forge's answer to a poll.
export function playAnswer(a: SelectionPlayAnswer): { play: SelectionPlayAnswer } {
  return { play: a.stop ? { stop: true, gap: normalizeGap(a.gap) } : { gap: normalizeGap(a.gap) } }
}
