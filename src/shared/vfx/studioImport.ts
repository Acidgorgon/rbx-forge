// "Import from Studio": a read-only Forge Bridge job (plugin v1 job protocol, any plugin version,
// like the texture harvest in tex/harvest.ts and the mesh reader in mesh/bridge.ts) whose module
// serialises instances from the open place into the node format the .rbxm importer produces
// (resources/lune/vfx_extract.luau: { id, className, name, props, children, source?, attrs? }), so
// the same split + import runs on them. Nothing in the place changes.
//
// Modes:
//   auto   Selection:Get(); when nothing is selected, the folders that look like VFX packs
//          (Folder / Model in Workspace, ReplicatedStorage or ServerStorage with >= 3 children
//          holding a ParticleEmitter / Beam / Trail, or named like "VFX" with one) are listed
//          instead, for the user to pick.
//   paths  the instances at the given paths (name + child index from the service down).
//
// Wire format ('log' events to the job's event URL; up to 64 KB each, protocol.ts):
//   "forge-vfx-progress <done>/<total> <name>"    while serialising (one per effect-sized unit)
//   "forge-vfx-data <i>/<n> <json chunk>"         the payload, chunked on UTF-8 boundaries
//   "forge-vfx-end <nodes|packs|error>"            last line
// Payload: { kind = "nodes", roots, paths, count, truncated } | { kind = "packs", packs } |
//          { kind = "error", error }.
// Pure code (tests build the job and decode the messages).

import { CAMERAS } from '../studio/payload.ts'
import { KEY_COLOR } from '../studio/crop.ts'
import { BRIDGE_VERSION, type BridgeJob } from '../studio/protocol.ts'
import { SCHEMA } from './schema.ts'
import { PACK_MIN_EFFECTS, PACK_SERVICES } from './split.ts'
import type { VfxStudioPack } from './types.ts'

export const SEL_DATA_TAG = 'forge-vfx-data'
export const SEL_PROGRESS_TAG = 'forge-vfx-progress'
export const SEL_END_TAG = 'forge-vfx-end'
export const SEL_ENTRY = 'ForgeVfxRead'
export const SEL_CHUNK = 48_000
// Instances one read may serialise (a whole map selected by mistake stops here).
export const SEL_MAX_NODES = 60_000
export const SEL_MAX_SOURCE = 200_000

export type StudioPath = { name: string; index: number }[]

function luaString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/[\x00-\x1f]/g, '')}"`
}

// The schema's property list per class as a Luau table literal.
function wantedTable(): string {
  return `{\n${Object.entries(SCHEMA)
    .map(([cls, props]) => `\t[${luaString(cls)}] = { ${Object.keys(props).map(luaString).join(', ')} },`)
    .join('\n')}\n}`
}

export function studioImportModuleSource(opts: { port: number; jobId: string; paths?: StudioPath[] }): string {
  if (!/^[\w-]{1,80}$/.test(opts.jobId)) throw new Error('bad job id')
  const port = Math.floor(Number(opts.port))
  const paths = (opts.paths ?? []).slice(0, 50).map((p) => p.slice(0, 32).map((s) => `{ ${luaString(String(s.name).slice(0, 200))}, ${Math.max(1, Math.floor(Number(s.index) || 1))} }`))
  const mode = paths.length ? 'paths' : 'auto'
  return `-- RBX Forge VFX import (read-only): reads the selected instances (or lists the folders that look
-- like VFX packs) and sends them to RBX Forge. Changes nothing in the place.
local HttpService = game:GetService("HttpService")
local Selection = game:GetService("Selection")
local URL = "http://127.0.0.1:${port}/forge-bridge/event/${opts.jobId}"
local MODE = "${mode}"
local PATHS = { ${paths.map((p) => `{ ${p.join(', ')} }`).join(', ')} }
local CHUNK = ${SEL_CHUNK}
local MAX_NODES = ${SEL_MAX_NODES}
local MAX_SOURCE = ${SEL_MAX_SOURCE}
local PACK_MIN = ${PACK_MIN_EFFECTS}
local PACK_SERVICES = { ${PACK_SERVICES.map(luaString).join(', ')} }
local WANTED = ${wantedTable()}
local SCRIPTS = { Script = true, LocalScript = true, ModuleScript = true }
local PACK_FX = { ParticleEmitter = true, Beam = true, Trail = true }
local SKIP = { ForgeBridgeStage = true, ForgeBridgeJob = true }
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

-- Chunks never cut a UTF-8 sequence (each chunk is valid JSON string content on its own).
local function post(text)
	local pieces = {}
	local i, n = 1, #text
	while i <= n do
		local j = math.min(n, i + CHUNK - 1)
		while j < n and j > i do
			local b = string.byte(text, j + 1)
			if b >= 0x80 and b < 0xC0 then
				j -= 1
			else
				break
			end
		end
		table.insert(pieces, string.sub(text, i, j))
		i = j + 1
	end
	if #pieces == 0 then
		pieces = { "" }
	end
	for k, p in pieces do
		send("${SEL_DATA_TAG} " .. k .. "/" .. #pieces .. " " .. p)
	end
end

local function clean(s)
	if utf8.len(s) then
		return s
	end
	return (string.gsub(s, "[\\128-\\255]", "?"))
end

local function num(x)
	if x ~= x or x == math.huge or x == -math.huge then
		return 0
	end
	return x
end

local function convert(v, ids)
	local t = typeof(v)
	if t == "number" then
		return num(v)
	elseif t == "boolean" then
		return v
	elseif t == "string" then
		return clean(v)
	elseif t == "EnumItem" then
		return v.Name
	elseif t == "Vector3" then
		return { num(v.X), num(v.Y), num(v.Z) }
	elseif t == "Vector2" then
		return { num(v.X), num(v.Y) }
	elseif t == "Color3" then
		return { num(v.R), num(v.G), num(v.B) }
	elseif t == "NumberRange" then
		return { num(v.Min), num(v.Max) }
	elseif t == "NumberSequence" then
		local out = {}
		for _, k in v.Keypoints do
			table.insert(out, { t = num(k.Time), v = num(k.Value), e = num(k.Envelope) })
		end
		return out
	elseif t == "ColorSequence" then
		local out = {}
		for _, k in v.Keypoints do
			table.insert(out, { t = num(k.Time), c = { num(k.Value.R), num(k.Value.G), num(k.Value.B) } })
		end
		return out
	elseif t == "CFrame" then
		local c = { v:GetComponents() }
		for i = 1, #c do
			c[i] = num(c[i])
		end
		return c
	elseif t == "Content" then
		local ok, uri = pcall(function()
			return (v :: any).Uri
		end)
		return if ok and type(uri) == "string" then clean(uri) else nil
	elseif t == "Instance" then
		return ids[v]
	end
	return nil
end

local function read(inst, name)
	local ok, v = pcall(function()
		return (inst :: any)[name]
	end)
	if ok then
		return v
	end
	return nil
end

local function isGroup(inst)
	return inst:IsA("Folder") or inst:IsA("Model")
end

local function fullName(inst)
	local ok, s = pcall(function()
		return inst:GetFullName()
	end)
	return clean(if ok then s else inst.Name)
end

local function serialize(roots)
	-- Progress units: the children of one selected folder, else the selected instances.
	local units = roots
	if #roots == 1 and #roots[1]:GetChildren() > 1 then
		units = roots[1]:GetChildren()
	end
	local unitSet = {}
	for _, u in units do
		unitSet[u] = true
	end
	local done = 0
	local ids = {}
	local counter = 0
	local truncated = false
	local function assign(inst)
		if counter >= MAX_NODES then
			truncated = true
			return
		end
		if SKIP[inst.Name] then
			return
		end
		counter += 1
		ids[inst] = "s" .. counter
		for _, c in inst:GetChildren() do
			assign(c)
		end
	end
	for _, r in roots do
		assign(r)
	end
	local visited = 0
	local function node(inst)
		visited += 1
		if visited % 400 == 0 then
			task.wait()
		end
		local className = inst.ClassName
		local out = { id = ids[inst], className = className, name = clean(inst.Name), props = {}, children = {} }
		local names = WANTED[className]
		if names then
			for _, prop in names do
				local v = read(inst, prop)
				if v == nil and (prop == "Texture" or prop == "TextureID" or prop == "TextureId") then
					v = read(inst, "TextureContent")
				end
				if v == nil and prop == "MeshId" then
					v = read(inst, "MeshContent")
				end
				if v == nil and prop == "ColorMap" then
					v = read(inst, "ColorMapContent")
				end
				if v ~= nil then
					local c = convert(v, ids)
					if c ~= nil then
						out.props[prop] = c
					end
				end
			end
		end
		local okAttrs, attrs = pcall(function()
			return inst:GetAttributes()
		end)
		if okAttrs and type(attrs) == "table" then
			local plain = {}
			local any = false
			for k, v in attrs do
				local t = typeof(v)
				if t == "number" or t == "boolean" or t == "string" then
					plain[clean(k)] = convert(v, ids)
					any = true
				end
			end
			if any then
				out.attrs = plain
			end
		end
		if SCRIPTS[className] then
			local src = read(inst, "Source")
			if type(src) == "string" then
				out.source = clean(string.sub(src, 1, MAX_SOURCE))
			end
		end
		for _, c in inst:GetChildren() do
			if ids[c] then
				table.insert(out.children, node(c))
			end
		end
		if unitSet[inst] then
			done += 1
			send("${SEL_PROGRESS_TAG} " .. done .. "/" .. #units .. " " .. clean(inst.Name))
		end
		return out
	end
	local list, paths = {}, {}
	for _, r in roots do
		if ids[r] then
			table.insert(list, node(r))
			table.insert(paths, fullName(r))
		end
	end
	return { kind = "nodes", roots = list, paths = paths, count = counter, truncated = truncated }
end

local function hasFx(inst)
	if PACK_FX[inst.ClassName] then
		return true
	end
	for _, d in inst:GetDescendants() do
		if PACK_FX[d.ClassName] then
			return true
		end
	end
	return false
end

local function findPacks()
	local packs = {}
	local function visit(inst, path, depth)
		if depth > 12 or #packs >= 60 or SKIP[inst.Name] then
			return
		end
		local kids = inst:GetChildren()
		local effects = 0
		for _, c in kids do
			if hasFx(c) then
				effects += 1
			end
		end
		local lname = string.lower(inst.Name)
		local named = string.find(lname, "fx", 1, true) or string.find(lname, "effect", 1, true) or string.find(lname, "particle", 1, true)
		if effects >= PACK_MIN or (effects >= 1 and named) then
			table.insert(packs, { path = path, fullName = fullName(inst), className = inst.ClassName, effects = effects, children = #kids })
			return
		end
		for i, c in kids do
			if isGroup(c) then
				local p = table.clone(path)
				table.insert(p, { name = clean(c.Name), index = i })
				visit(c, p, depth + 1)
			end
		end
		task.wait()
	end
	for _, name in PACK_SERVICES do
		local ok, service = pcall(function()
			return game:GetService(name)
		end)
		if ok and service then
			for i, c in service:GetChildren() do
				if isGroup(c) then
					visit(c, { { name = name, index = 0 }, { name = clean(c.Name), index = i } }, 1)
				end
			end
		end
	end
	return { kind = "packs", packs = packs }
end

local function resolve(path)
	local first = path[1]
	if not first then
		return nil
	end
	local ok, inst = pcall(function()
		return game:GetService(first[1])
	end)
	if not ok or not inst then
		return nil
	end
	for k = 2, #path do
		local step = path[k]
		local kids = inst:GetChildren()
		local hit = kids[step[2]]
		if not hit or hit.Name ~= step[1] then
			hit = inst:FindFirstChild(step[1])
		end
		if not hit then
			return nil
		end
		inst = hit
	end
	return inst
end

function M.play(_origin, _parent, opts)
	local ok, result = pcall(function()
		if MODE == "paths" then
			local roots = {}
			for _, p in PATHS do
				local inst = resolve(p)
				if inst then
					table.insert(roots, inst)
				end
			end
			if #roots == 0 then
				return { kind = "error", error = "the chosen folders are no longer in the place" }
			end
			return serialize(roots)
		end
		local selected = {}
		for _, inst in Selection:Get() do
			if inst ~= game and inst.Parent ~= nil and not SKIP[inst.Name] then
				table.insert(selected, inst)
			end
		end
		if #selected > 0 then
			return serialize(selected)
		end
		return findPacks()
	end)
	if not ok then
		result = { kind = "error", error = clean(tostring(result)) }
	end
	local okJson, body = pcall(function()
		return HttpService:JSONEncode(result)
	end)
	if not okJson then
		result = { kind = "error", error = "could not encode the instances: " .. clean(tostring(body)) }
		body = HttpService:JSONEncode(result)
	end
	post(body)
	send("${SEL_END_TAG} " .. tostring(result.kind))
	if opts and opts.onStage then
		opts.onStage("vfx read")
	end
end

return M
`
}

export function studioImportJob(opts: { id: string; port: number; paths?: StudioPath[] }): BridgeJob {
  return {
    id: opts.id,
    version: BRIDGE_VERSION,
    kind: 'vfx',
    mode: 'realtime',
    name: 'VFX import',
    rig: 'R15',
    duration: 0,
    beats: [],
    camera: CAMERAS.vfx,
    modules: [{ name: SEL_ENTRY, className: 'ModuleScript', source: studioImportModuleSource({ port: opts.port, jobId: opts.id, paths: opts.paths }) }],
    entry: SEL_ENTRY,
    calibrate: false,
    key: KEY_COLOR,
    linger: 0,
    timeout: 600
  }
}

export function parseSelProgress(message: string): { done: number; total: number; label: string } | null {
  const m = new RegExp(`^${SEL_PROGRESS_TAG} (\\d+)/(\\d+) ?(.*)$`).exec(message)
  return m ? { done: Number(m[1]), total: Number(m[2]), label: m[3] ?? '' } : null
}

// Chunk i of n of the payload (for "receiving" progress).
export function parseSelChunk(message: string): { index: number; total: number } | null {
  const m = new RegExp(`^${SEL_DATA_TAG} (\\d+)/(\\d+) `).exec(message)
  return m ? { index: Number(m[1]), total: Number(m[2]) } : null
}

export type SelPayload =
  | { kind: 'nodes'; roots: unknown[]; paths: string[]; count: number; truncated: boolean }
  | { kind: 'packs'; packs: VfxStudioPack[] }
  | { kind: 'error'; error: string }

// Reassembles the module's 'log' messages; null when they are incomplete or not ours.
export function collectStudioImport(messages: string[]): SelPayload | null {
  const parts = new Map<number, string>()
  let total = 0
  for (const m of messages) {
    const r = new RegExp(`^${SEL_DATA_TAG} (\\d+)/(\\d+) `).exec(m)
    if (!r) continue
    total = Number(r[2])
    parts.set(Number(r[1]), m.slice(r[0].length))
  }
  if (!total || parts.size !== total) return null
  let raw: any
  try {
    raw = JSON.parse(Array.from({ length: total }, (_, i) => parts.get(i + 1) ?? '').join(''))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  if (raw.kind === 'error') return { kind: 'error', error: String(raw.error ?? 'Studio could not read the selection') }
  // Roblox's JSONEncode writes an empty table as [] (or {}).
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
  if (raw.kind === 'packs') {
    const packs: VfxStudioPack[] = list(raw.packs).flatMap((p: any) => {
      const path = list(p?.path).map((s: any) => ({ name: String(s?.name ?? ''), index: Number(s?.index) || 0 }))
      if (path.length < 2) return []
      const fullName = String(p?.fullName ?? path.map((s) => s.name).join('.'))
      return [{ key: fullName, path, fullName, className: String(p?.className ?? 'Folder'), effects: Number(p?.effects) || 0, children: Number(p?.children) || 0 }]
    })
    return { kind: 'packs', packs: packs.sort((a, b) => b.effects - a.effects) }
  }
  if (raw.kind === 'nodes') return { kind: 'nodes', roots: list(raw.roots), paths: list(raw.paths).map(String), count: Number(raw.count) || 0, truncated: !!raw.truncated }
  return null
}
