// "Live in Studio" / "Loop in Studio": Roblox Studio replays the VFX Lab's current effect over and
// over, through one long-running, preemptible Forge Bridge job (plugin v1 job protocol, any plugin
// version). The job's module asks Forge what to play every ~0.25 s by posting a 'log' event
// ("forge-live-poll <version> <plays> <camera>") and reads the answer, which the bridge returns as
// the HTTP response ({ live: LiveAnswer }). A new version carries the effect's Luau module (the same
// module Forge writes into the project) and replaces the looping one at once.
//
// In Studio: every spawned instance goes into Workspace.ForgeLivePreview (Archivable false, so it
// is never saved; Forge Sync skips it), cleared before each replay (no buildup) and destroyed when
// the loop stops: Stop / toggle off (Forge answers stop), a capture or any other Studio job (the
// bridge preempts the loop; Forge answers abort), Forge closing or the connection dropping (the
// module stops when Forge does not answer). The camera is framed on the first play only; a loop
// resumed after a pause puts the camera back where the user had it.
//
// Pure code: the module source, the job, the message format and the loop schedule (LiveSchedule,
// tested without Studio). main/services/vfx/live.ts drives it.

import { assertModuleSizes, CAMERAS } from '../studio/payload.ts'
import { KEY_COLOR } from '../studio/crop.ts'
import { BRIDGE_VERSION, type BridgeJob } from '../studio/protocol.ts'
import { effectModules, timelineModule } from './luau.ts'
import { FORGEFX_SOURCE, RUNTIME_MODULE } from './runtime.ts'
import type { VfxEffect } from './types.ts'

export const LIVE_FOLDER = 'ForgeLivePreview'
export const LIVE_ENTRY = 'ForgeLive'
export const LIVE_POLL_TAG = 'forge-live-poll'
export const LIVE_ERROR_TAG = 'forge-live-error'
export const LIVE_POLL_S = 0.25
export const LIVE_DEFAULT_GAP = 0.75
export const LIVE_DEBOUNCE_MS = 300

export type LiveMode = 'dummy' | 'origin'

export interface LiveSettings {
  gap: number
  mode: LiveMode
}

// What the lab shows ("Looping in Studio · Stop").
export interface LiveStatus {
  state: 'off' | 'waiting' | 'starting' | 'looping' | 'paused'
  // Loop on one entry (Test in Studio > Loop); null = Live (follows the current effect).
  pinned: string | null
  // The header toggle is on (a Loop returns to following when it stops).
  following?: boolean
  name: string | null
  label: string
  plays: number
  settings: LiveSettings
  error?: string
  message?: string
}

export interface LiveEffectPayload {
  name: string
  source: string
  // Data parts of an effect too big for one module (luau.ts effectModules): children of the module.
  data?: { name: string; source: string }[]
  timeline?: string
  duration: number
  linger: number
}

export interface LiveAnswer {
  stop?: boolean
  version: number
  gap: number
  label: string
  effect?: LiveEffectPayload
}

export function normalizeLiveSettings(s: Partial<LiveSettings> | null | undefined): LiveSettings {
  const gap = Number(s?.gap)
  return { gap: Number.isFinite(gap) ? Math.min(10, Math.max(0, gap)) : LIVE_DEFAULT_GAP, mode: s?.mode === 'origin' ? 'origin' : 'dummy' }
}

function lingerOf(effect: VfxEffect): number {
  let max = 0
  const walk = (n: VfxEffect['roots'][number]) => {
    const life = n.props.Lifetime
    if (Array.isArray(life)) max = Math.max(max, Number(life[1] ?? life[0]) || 0)
    n.children.forEach(walk)
  }
  effect.roots.forEach(walk)
  return Math.min(4, max)
}

// Throws (ModuleTooLargeError) when a module could not be built in Studio.
export function livePayload(effect: VfxEffect): LiveEffectPayload {
  const m = effectModules(effect, {})
  const timeline = effect.script ? timelineModule(effect.script) : null
  assertModuleSizes([{ name: effect.name, className: 'ModuleScript', source: m.source, children: [...m.data.map((d) => ({ name: d.name, className: 'ModuleScript' as const, source: d.source })), ...(timeline ? [{ name: 'Timeline', className: 'ModuleScript' as const, source: timeline }] : [])] }])
  return {
    name: effect.name,
    source: m.source,
    ...(m.data.length ? { data: m.data } : {}),
    ...(timeline ? { timeline } : {}),
    duration: Math.max(0.1, Number(effect.duration) || 1),
    linger: lingerOf(effect)
  }
}

// "forge-live-poll 3 12 x,y,z,r00..." -> version, plays, camera
export function parseLivePoll(message: string): { version: number; plays: number; camera: number[] | null } | null {
  const m = new RegExp(`^${LIVE_POLL_TAG} (-?\\d+) (\\d+)(?: ([-\\d.e,]+))?$`).exec(message)
  if (!m) return null
  const cam = m[3] ? m[3].split(',').map(Number) : null
  return { version: Number(m[1]), plays: Number(m[2]), camera: cam && cam.length === 12 && cam.every(Number.isFinite) ? cam : null }
}

export function parseLiveError(message: string): { version: number; error: string } | null {
  const m = new RegExp(`^${LIVE_ERROR_TAG} (-?\\d+) (.*)$`).exec(message)
  return m ? { version: Number(m[1]), error: m[2].slice(0, 300) } : null
}

export function liveModuleSource(opts: { port: number; jobId: string; mode: LiveMode; frame: boolean; camera?: number[] | null }): string {
  if (!/^[\w-]{1,80}$/.test(opts.jobId)) throw new Error('bad job id')
  const port = Math.floor(Number(opts.port))
  const cam = CAMERAS.vfx
  const restore = !opts.frame && opts.camera && opts.camera.length === 12 && opts.camera.every(Number.isFinite) ? `CFrame.new(${opts.camera.map((x) => String(Math.round(x * 1e4) / 1e4)).join(', ')})` : 'nil'
  return `-- RBX Forge live preview: replays the VFX Lab's current effect until Forge says stop. Everything it
-- spawns lives in Workspace.${LIVE_FOLDER} (not saved, removed when the loop stops).
local HttpService = game:GetService("HttpService")
local URL = "http://127.0.0.1:${port}/forge-bridge/event/${opts.jobId}"
local MODE = "${opts.mode}"
local FRAME = ${opts.frame ? 'true' : 'false'}
local RESTORE_CAMERA = ${restore}
local POLL = ${LIVE_POLL_S}
local M = {}

local function camText()
	local ok, s = pcall(function()
		local c = { workspace.CurrentCamera.CFrame:GetComponents() }
		for i = 1, #c do
			c[i] = string.format("%.4f", c[i])
		end
		return table.concat(c, ",")
	end)
	return if ok then s else ""
end

local function ask(version, plays)
	local ok, res = pcall(function()
		return HttpService:RequestAsync({
			Url = URL,
			Method = "POST",
			Headers = { ["Content-Type"] = "application/json" },
			Body = HttpService:JSONEncode({ type = "log", message = "${LIVE_POLL_TAG} " .. version .. " " .. plays .. " " .. camText() }),
		})
	end)
	if not ok or not res.Success then
		return nil
	end
	local okJ, body = pcall(function()
		return HttpService:JSONDecode(res.Body)
	end)
	if not okJ or type(body) ~= "table" or body.abort or type(body.live) ~= "table" or body.live.stop then
		return nil
	end
	return body.live
end

local function report(version, message)
	pcall(function()
		HttpService:RequestAsync({
			Url = URL,
			Method = "POST",
			Headers = { ["Content-Type"] = "application/json" },
			Body = HttpService:JSONEncode({ type = "log", message = "${LIVE_ERROR_TAG} " .. version .. " " .. string.sub(tostring(message), 1, 300) }),
		})
	end)
end

function M.play(origin, _stage, _opts)
	local old = workspace:FindFirstChild("${LIVE_FOLDER}")
	if old then
		old:Destroy()
	end
	local folder = Instance.new("Folder")
	folder.Name = "${LIVE_FOLDER}"
	folder.Archivable = false
	folder.Parent = workspace
	local target = if MODE == "origin" then CFrame.new() else origin
	local camera = workspace.CurrentCamera
	if RESTORE_CAMERA then
		pcall(function()
			camera.CFrame = RESTORE_CAMERA
		end)
	elseif FRAME and MODE == "origin" then
		pcall(function()
			local pos = target * Vector3.new(${cam.pos.join(', ')})
			local at = target * Vector3.new(${cam.target.join(', ')})
			camera.CFrame = CFrame.lookAt(pos, at)
			camera.Focus = CFrame.new(at)
		end)
	end
	local current = nil
	local modules = {}
	local plays = 0
	local lastFx = nil

	local function install(live)
		local e = live.effect
		if type(e) ~= "table" or type(e.source) ~= "string" then
			return
		end
		local m = Instance.new("ModuleScript")
		m.Name = "LiveEffect" .. tostring(live.version)
		m.Source = e.source
		if type(e.data) == "table" then
			-- An effect too big for one module: its data parts (Data1, Data2, ...).
			for _, d in e.data do
				local part = Instance.new("ModuleScript")
				part.Name = tostring(d.name)
				part.Source = tostring(d.source)
				part.Parent = m
			end
		end
		if type(e.timeline) == "string" then
			local t = Instance.new("ModuleScript")
			t.Name = "Timeline"
			t.Source = e.timeline
			t.Parent = m
		end
		m.Parent = script.Parent
		table.insert(modules, m)
		local ok, mod = pcall(require, m)
		if ok and type(mod) == "table" and type(mod.play) == "function" then
			current = { version = live.version, mod = mod, duration = tonumber(e.duration) or 1, gap = tonumber(live.gap) or 0.75, label = tostring(live.label or e.name or "") }
			print("[Forge Live] " .. current.label)
		else
			-- Keep the last good effect; tell Forge (it shows the error) and do not ask again.
			if current then
				current.version = live.version
			else
				current = { version = live.version, mod = nil, duration = 1, gap = 0.75, label = "" }
			end
			report(live.version, mod)
		end
	end

	local function clear()
		if lastFx then
			pcall(function()
				lastFx:stop()
			end)
			lastFx = nil
		end
		folder:ClearAllChildren()
	end

	local function label(text)
		if text == "" then
			return
		end
		pcall(function()
			local anchor = Instance.new("Part")
			anchor.Name = "ForgeLiveLabel"
			anchor.Anchored = true
			anchor.CanCollide = false
			anchor.CanQuery = false
			anchor.Transparency = 1
			anchor.Size = Vector3.new(0.2, 0.2, 0.2)
			anchor.CFrame = target * CFrame.new(0, 8, 0)
			anchor.Archivable = false
			local gui = Instance.new("BillboardGui")
			gui.Size = UDim2.fromOffset(260, 28)
			gui.AlwaysOnTop = true
			gui.Adornee = anchor
			local t = Instance.new("TextLabel")
			t.Size = UDim2.fromScale(1, 1)
			t.BackgroundTransparency = 0.35
			t.BackgroundColor3 = Color3.fromRGB(20, 20, 24)
			t.TextColor3 = Color3.fromRGB(255, 186, 120)
			t.Font = Enum.Font.GothamMedium
			t.TextSize = 14
			t.Text = "Forge live · " .. text
			t.Parent = gui
			gui.Parent = anchor
			anchor.Parent = folder
		end)
	end

	local alive = true
	while alive do
		local live = ask(if current then current.version else -1, plays)
		if not live then
			break
		end
		if live.effect and (not current or live.version ~= current.version) then
			install(live)
		end
		if current and live.version == current.version then
			current.gap = tonumber(live.gap) or current.gap
			current.label = tostring(live.label or current.label)
		end
		if current and current.mod then
			clear()
			label(current.label)
			local ok, a, b = pcall(current.mod.play, target, folder)
			if ok then
				lastFx = b
			else
				report(current.version, a)
			end
			plays += 1
			local untilT = os.clock() + current.duration + current.gap
			local playing = current.version
			while os.clock() < untilT do
				task.wait(POLL)
				local upd = ask(playing, plays)
				if not upd then
					alive = false
					break
				end
				if upd.version ~= playing then
					-- A new version: replace the looping one at once.
					if upd.effect then
						install(upd)
					end
					break
				end
				current.gap = tonumber(upd.gap) or current.gap
				if tostring(upd.label or "") ~= current.label then
					current.label = tostring(upd.label or "")
					local old = folder:FindFirstChild("ForgeLiveLabel")
					if old then
						old:Destroy()
					end
					label(current.label)
				end
			end
		else
			task.wait(POLL)
		end
	end
	clear()
	folder:Destroy()
	for _, m in modules do
		pcall(function()
			m:Destroy()
		end)
	end
end

return M
`
}

// The runtime (ForgeFX) always ships: scripted effects need it and any version may be one.
export function liveJob(opts: { id: string; port: number; mode: LiveMode; frame: boolean; camera?: number[] | null }): BridgeJob {
  const modules: BridgeJob['modules'] = [
    { name: RUNTIME_MODULE, className: 'ModuleScript', source: FORGEFX_SOURCE },
    { name: LIVE_ENTRY, className: 'ModuleScript', source: liveModuleSource({ ...opts, jobId: opts.id }) }
  ]
  assertModuleSizes(modules)
  return {
    id: opts.id,
    version: BRIDGE_VERSION,
    kind: 'vfx',
    mode: 'realtime',
    name: 'Live preview',
    rig: 'R15',
    duration: 0,
    beats: [],
    camera: CAMERAS.vfx,
    modules,
    entry: LIVE_ENTRY,
    calibrate: false,
    key: KEY_COLOR,
    linger: 0,
    // A long loop; Forge ends it with stop / cancel.
    timeout: 12 * 3600
  }
}

// ------------------------------------------------------------------ schedule (what Forge answers)

export interface LiveCurrent {
  // Library entry id (or "draft:<entry>" for refine iterations).
  key: string
  effect: VfxEffect
  label: string
}

// Forge's side of the loop, without timers or IO: the current effect and its version, debounced
// updates (set -> flush after LIVE_DEBOUNCE_MS), pinned loops (Loop on one entry stops when another
// entry becomes current), and the answer to each poll.
export class LiveSchedule {
  version = 0
  current: (LiveCurrent & { payload: LiveEffectPayload }) | null = null
  settings: LiveSettings = normalizeLiveSettings(null)
  // Loop pinned to one entry (Test in Studio > Loop); null = follow whatever is current (Live).
  pin: string | null = null
  enabled = false
  plays = 0
  camera: number[] | null = null
  lastError: string | null = null
  private pending: { value: LiveCurrent; at: number } | null = null

  start(opts: { pin?: string | null; settings?: Partial<LiveSettings> } = {}): void {
    this.enabled = true
    this.pin = opts.pin ?? null
    if (opts.settings) this.settings = normalizeLiveSettings({ ...this.settings, ...opts.settings })
  }

  stop(): void {
    this.enabled = false
    this.pin = null
    this.pending = null
  }

  setSettings(s: Partial<LiveSettings>): void {
    this.settings = normalizeLiveSettings({ ...this.settings, ...s })
  }

  // A new current effect (debounced: the last one within LIVE_DEBOUNCE_MS wins). Returns 'stopped'
  // when a pinned loop's entry is no longer current.
  set(value: LiveCurrent, now: number): 'queued' | 'stopped' | 'ignored' {
    if (!this.enabled) return 'ignored'
    if (this.pin && baseKey(value.key) !== this.pin) {
      this.stop()
      return 'stopped'
    }
    this.pending = { value, at: now }
    return 'queued'
  }

  // A label-only change (a refine score for the iteration already looping) applies at once.
  relabel(key: string, label: string): boolean {
    if (!this.current || this.current.key !== key || this.current.label === label) return false
    this.current = { ...this.current, label }
    return true
  }

  // Applies the pending update once it is LIVE_DEBOUNCE_MS old (or `force`). Returns true when the
  // version changed. An identical effect only updates the label.
  flush(now: number, force = false): boolean {
    const p = this.pending
    if (!p || (!force && now - p.at < LIVE_DEBOUNCE_MS)) return false
    this.pending = null
    let payload: LiveEffectPayload
    try {
      payload = livePayload(p.value.effect)
    } catch (e) {
      // Keep looping the last good version; the lab shows why this one cannot play.
      this.lastError = (e as Error).message
      return false
    }
    const same = (a: LiveEffectPayload, b: LiveEffectPayload) => a.source === b.source && a.timeline === b.timeline && JSON.stringify(a.data ?? []) === JSON.stringify(b.data ?? [])
    if (this.current && same(this.current.payload, payload)) {
      this.current = { ...this.current, key: p.value.key, label: p.value.label }
      return false
    }
    this.current = { ...p.value, payload }
    this.version++
    this.lastError = null
    return true
  }

  hasPending(): boolean {
    return !!this.pending
  }

  // The answer to a module poll.
  answer(poll: { version: number; plays: number; camera: number[] | null }, now: number): LiveAnswer {
    this.flush(now)
    this.plays = poll.plays
    if (poll.camera) this.camera = poll.camera
    if (!this.enabled) return { stop: true, version: this.version, gap: this.settings.gap, label: '' }
    const base = { version: this.version, gap: this.settings.gap, label: this.current?.label ?? '' }
    if (this.current && poll.version !== this.version) return { ...base, effect: this.current.payload }
    return base
  }
}

export function baseKey(key: string): string {
  return key.startsWith('draft:') ? key.slice(6) : key
}
