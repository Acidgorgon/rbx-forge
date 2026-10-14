// "From Studio": every Texture id used by ParticleEmitter, Beam and Trail in the open place, with the
// instance paths as hints, offered for import as library textures that reference the existing ids.
//
// Two read-only sources, no plugin change needed:
//  1. Forge Sync's live tree (when Forge Sync is on): the synced roots carry ParticleEmitter / Beam /
//     Trail Texture values (SYNC_PROPS in ForgeBridge.luau).
//  2. A Forge Bridge job (plugin v1 job protocol, any plugin version since 1): a 'vfx' job whose
//     module walks game:GetDescendants() inside its play() and posts what it found as 'log' events
//     to the job's event URL (the bridge relays them to the job's handler). The module reads
//     properties only; the plugin builds and removes its usual stage around it.
// Pure code (tests build the job and parse the messages).

import { CAMERAS } from '../../studio/payload.ts'
import { KEY_COLOR } from '../../studio/crop.ts'
import { BRIDGE_VERSION, type BridgeJob } from '../../studio/protocol.ts'
import { parseAssetIds } from './import.ts'

export const HARVEST_TAG = 'forge-tex-harvest'
export const HARVEST_ENTRY = 'ForgeTextureHarvest'
const CHUNK = 1700
export const HARVEST_MAX = 600

export interface HarvestUse {
  texture: string
  classes: string[]
  paths: string[]
  count: number
}

export interface HarvestCandidate {
  id: string
  classes: string[]
  paths: string[]
  count: number
  // Instance names (last path part), for names and kind hints.
  names: string[]
}

export function harvestModuleSource(opts: { port: number; jobId: string }): string {
  if (!/^[\w-]{1,80}$/.test(opts.jobId)) throw new Error('bad job id')
  const port = Math.floor(Number(opts.port))
  return `-- RBX Forge texture harvest (read-only): lists the Texture of every ParticleEmitter, Beam and
-- Trail in the place and sends the list to RBX Forge. Changes nothing.
local HttpService = game:GetService("HttpService")
local URL = "http://127.0.0.1:${port}/forge-bridge/event/${opts.jobId}"
local CLASSES = { ParticleEmitter = true, Beam = true, Trail = true }
local M = {}

local function send(message)
	pcall(function()
		HttpService:RequestAsync({
			Url = URL,
			Method = "POST",
			Headers = { ["Content-Type"] = "application/json" },
			Body = HttpService:JSONEncode({ type = "log", message = message }),
		})
	end)
end

function M.play(_origin, _parent, opts)
	local found = {}
	local order = {}
	local visited = 0
	for _, service in game:GetChildren() do
		local ok, list = pcall(function()
			return service:GetDescendants()
		end)
		if ok then
			for _, inst in list do
				visited += 1
				if visited % 3000 == 0 then
					task.wait()
				end
				if CLASSES[inst.ClassName] then
					local okTex, tex = pcall(function()
						return (inst :: any).Texture
					end)
					if okTex and type(tex) == "string" and tex ~= "" then
						local e = found[tex]
						if not e and #order < ${HARVEST_MAX} then
							e = { t = tex, c = {}, p = {}, n = 0 }
							found[tex] = e
							table.insert(order, e)
						end
						if e then
							e.n += 1
							e.c[inst.ClassName] = true
							if #e.p < 4 then
								local okName, full = pcall(function()
									return inst:GetFullName()
								end)
								table.insert(e.p, if okName then full else inst.Name)
							end
						end
					end
				end
			end
		end
	end
	local list = {}
	for _, e in order do
		local classes = {}
		for k in e.c do
			table.insert(classes, k)
		end
		table.insert(list, { t = e.t, c = classes, p = e.p, n = e.n })
	end
	local body = HttpService:JSONEncode(list)
	local total = math.max(1, math.ceil(#body / ${CHUNK}))
	for i = 1, total do
		send("${HARVEST_TAG} " .. i .. "/" .. total .. " " .. string.sub(body, (i - 1) * ${CHUNK} + 1, i * ${CHUNK}))
	end
	if opts and opts.onStage then
		opts.onStage("harvest " .. #order)
	end
end

return M
`
}

export function harvestJob(opts: { id: string; port: number }): BridgeJob {
  return {
    id: opts.id,
    version: BRIDGE_VERSION,
    kind: 'vfx',
    mode: 'realtime',
    name: 'Texture harvest',
    rig: 'R15',
    duration: 0,
    beats: [],
    camera: CAMERAS.vfx,
    modules: [{ name: HARVEST_ENTRY, className: 'ModuleScript', source: harvestModuleSource({ port: opts.port, jobId: opts.id }) }],
    entry: HARVEST_ENTRY,
    calibrate: false,
    key: KEY_COLOR,
    linger: 0,
    timeout: 90
  }
}

// Reassembles the module's 'log' messages; null when they are incomplete or not ours.
export function collectHarvest(messages: string[]): HarvestUse[] | null {
  const parts = new Map<number, string>()
  let total = 0
  for (const m of messages) {
    const r = new RegExp(`^${HARVEST_TAG} (\\d+)/(\\d+) `).exec(m)
    if (!r) continue
    total = Number(r[2])
    parts.set(Number(r[1]), m.slice(r[0].length))
  }
  if (!total || parts.size !== total) return null
  let raw: unknown
  try {
    raw = JSON.parse(Array.from({ length: total }, (_, i) => parts.get(i + 1) ?? '').join(''))
  } catch {
    return null
  }
  // Roblox's JSONEncode writes an empty table as [] (or {}).
  if (!Array.isArray(raw)) return raw && typeof raw === 'object' && !Object.keys(raw).length ? [] : null
  const out: HarvestUse[] = []
  for (const e of raw as Record<string, unknown>[]) {
    if (!e || typeof e.t !== 'string') continue
    out.push({ texture: e.t, classes: Array.isArray(e.c) ? e.c.map(String) : [], paths: Array.isArray(e.p) ? e.p.map(String).slice(0, 4) : [], count: Number(e.n) || 1 })
  }
  return out
}

// Texture uses from Forge Sync's live tree (synced roots carry the Texture values).
export function harvestFromTree(nodes: { path: string[]; className: string; props?: Record<string, unknown> }[]): HarvestUse[] {
  const by = new Map<string, HarvestUse>()
  for (const n of nodes) {
    if (n.className !== 'ParticleEmitter' && n.className !== 'Beam' && n.className !== 'Trail') continue
    const tex = n.props?.Texture
    if (typeof tex !== 'string' || !tex) continue
    const e = by.get(tex) ?? { texture: tex, classes: [], paths: [], count: 0 }
    e.count++
    if (!e.classes.includes(n.className)) e.classes.push(n.className)
    if (e.paths.length < 4) e.paths.push(n.path.join('.'))
    by.set(tex, e)
  }
  return [...by.values()]
}

// Uses -> asset ids (built-in rbxasset:// textures and empty values are skipped), merged by id.
export function harvestCandidates(...sources: HarvestUse[][]): HarvestCandidate[] {
  const by = new Map<string, HarvestCandidate>()
  for (const list of sources) {
    for (const u of list) {
      const id = parseAssetIds(u.texture)[0]?.id ?? (/^\d+$/.test(u.texture.trim()) ? u.texture.trim() : null)
      if (!id || /^rbxasset:\/\//i.test(u.texture)) continue
      const c = by.get(id) ?? { id, classes: [], paths: [], count: 0, names: [] }
      for (const k of u.classes) if (!c.classes.includes(k)) c.classes.push(k)
      for (const p of u.paths) {
        if (c.paths.includes(p) || c.paths.length >= 4) continue
        c.paths.push(p)
        const name = p.split('.').pop()!
        if (!c.names.includes(name)) c.names.push(name)
      }
      c.count = Math.max(c.count, u.count)
      by.set(id, c)
    }
  }
  return [...by.values()].sort((a, b) => b.count - a.count)
}
