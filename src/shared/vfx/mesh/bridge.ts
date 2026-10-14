// "Load meshes from Studio": a read-only Forge Bridge job (plugin v1 job protocol, any plugin
// version, like the texture harvest in ../tex/harvest.ts) whose module opens each MeshId with
// AssetService:CreateEditableMeshAsync, reads vertices, normals, UVs and triangles, and posts them
// back as 'log' events to the job's event URL. Nothing in the place changes; every EditableMesh is
// destroyed after reading.
//
// API (Creator Hub AssetService.CreateEditableMeshAsync and EditableMesh, read 2026-10-14): the
// current form takes a Content (Content.fromUri("rbxassetid://...")) plus options; older Studios
// take the id string. Both are tried under pcall. EditableMesh loading is limited to assets the
// Studio user may use (their own, their groups', or the experience creator's) and by a memory
// budget; failures come back per mesh with Roblox's message. Attributes per face corner:
//   GetFaces / GetFaceVertices / GetFaceNormals / GetFaceUVs, GetPosition / GetNormal / GetUV.
// Corners are de-duplicated by (vertex, normal, uv) into an indexed mesh.
//
// Wire format, per mesh: "M <id>\n" then "E <message>\n" or "P x,y,z,...\nN ...\nU u,v,...\nI a,b,c,...\n",
// split into chunks "forge-mesh <id> <i>/<n> <text>" (each one 'log' event), then one
// "forge-mesh-end <count>" line. Pure code (tests build the job and decode the messages).

import { CAMERAS } from '../../studio/payload.ts'
import { KEY_COLOR } from '../../studio/crop.ts'
import { BRIDGE_VERSION, type BridgeJob } from '../../studio/protocol.ts'
import { finishMesh, MeshError, type MeshData } from './data.ts'

export const MESH_TAG = 'forge-mesh'
export const MESH_END_TAG = 'forge-mesh-end'
export const MESH_ENTRY = 'ForgeMeshRead'
// Characters per 'log' event (protocol.ts keeps up to 64 KB of a log message).
export const MESH_CHUNK = 48_000
export const MESH_JOB_MAX = 40
// Triangles one mesh may have to be read (bigger meshes are reported, not read).
export const MESH_JOB_MAX_TRIS = 60_000

export function meshModuleSource(opts: { port: number; jobId: string; ids: string[] }): string {
  if (!/^[\w-]{1,80}$/.test(opts.jobId)) throw new Error('bad job id')
  const ids = opts.ids.filter((id) => /^\d{1,20}$/.test(id)).slice(0, MESH_JOB_MAX)
  const port = Math.floor(Number(opts.port))
  return `-- RBX Forge mesh reader (read-only): opens each mesh with AssetService:CreateEditableMeshAsync,
-- reads its triangles and sends them to RBX Forge. Changes nothing in the place.
local AssetService = game:GetService("AssetService")
local HttpService = game:GetService("HttpService")
local URL = "http://127.0.0.1:${port}/forge-bridge/event/${opts.jobId}"
local IDS = { ${ids.map((id) => `"${id}"`).join(', ')} }
local CHUNK = ${MESH_CHUNK}
local MAX_TRIS = ${MESH_JOB_MAX_TRIS}
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

local function open(id)
	local uri = "rbxassetid://" .. id
	local errors = {}
	local okC, content = pcall(function()
		return (Content :: any).fromUri(uri)
	end)
	if okC and content then
		local ok, mesh = pcall(function()
			return (AssetService :: any):CreateEditableMeshAsync(content, { FixedSize = true })
		end)
		if ok and mesh then
			return mesh
		end
		table.insert(errors, tostring(mesh))
	end
	local ok2, mesh2 = pcall(function()
		return (AssetService :: any):CreateEditableMeshAsync(uri)
	end)
	if ok2 and mesh2 then
		return mesh2
	end
	table.insert(errors, tostring(mesh2))
	return nil, table.concat(errors, " / ")
end

local function f(x, fmt)
	if x ~= x or x == math.huge or x == -math.huge then
		return "0"
	end
	return string.format(fmt, x)
end

local function read(mesh)
	local faces = mesh:GetFaces()
	if #faces > MAX_TRIS then
		error("mesh has " .. #faces .. " triangles (limit " .. MAX_TRIS .. ")")
	end
	local P, N, U, I = {}, {}, {}, {}
	local corner = {}
	local count = 0
	local posCache, nCache, uvCache = {}, {}, {}
	for fi, face in faces do
		if fi % 1500 == 0 then
			task.wait()
		end
		local verts = mesh:GetFaceVertices(face)
		local okN, normals = pcall(function()
			return mesh:GetFaceNormals(face)
		end)
		local okU, uvs = pcall(function()
			return mesh:GetFaceUVs(face)
		end)
		if #verts == 3 then
			for k = 1, 3 do
				local v = verts[k]
				local n = if okN and normals then normals[k] else nil
				local u = if okU and uvs then uvs[k] else nil
				local key = tostring(v) .. ":" .. tostring(n) .. ":" .. tostring(u)
				local index = corner[key]
				if index == nil then
					index = count
					count += 1
					corner[key] = index
					local p = posCache[v]
					if p == nil then
						p = mesh:GetPosition(v)
						posCache[v] = p
					end
					table.insert(P, f(p.X, "%.5g") .. "," .. f(p.Y, "%.5g") .. "," .. f(p.Z, "%.5g"))
					local nv = nil
					if n ~= nil then
						nv = nCache[n]
						if nv == nil then
							local okn, vec = pcall(function()
								return mesh:GetNormal(n)
							end)
							nv = if okn and vec then vec else false
							nCache[n] = nv
						end
					end
					if nv then
						table.insert(N, f(nv.X, "%.3f") .. "," .. f(nv.Y, "%.3f") .. "," .. f(nv.Z, "%.3f"))
					else
						table.insert(N, "0,0,0")
					end
					local uv = nil
					if u ~= nil then
						uv = uvCache[u]
						if uv == nil then
							local oku, vec = pcall(function()
								return mesh:GetUV(u)
							end)
							uv = if oku and vec then vec else false
							uvCache[u] = uv
						end
					end
					if uv then
						table.insert(U, f(uv.X, "%.4f") .. "," .. f(uv.Y, "%.4f"))
					else
						table.insert(U, "0,0")
					end
				end
				table.insert(I, tostring(index))
			end
		end
	end
	return "P " .. table.concat(P, ",") .. "\\nN " .. table.concat(N, ",") .. "\\nU " .. table.concat(U, ",") .. "\\nI " .. table.concat(I, ",") .. "\\n"
end

local function post(id, text)
	local total = math.max(1, math.ceil(#text / CHUNK))
	for i = 1, total do
		send("${MESH_TAG} " .. id .. " " .. i .. "/" .. total .. " " .. string.sub(text, (i - 1) * CHUNK + 1, i * CHUNK))
	end
end

function M.play(_origin, _parent, opts)
	local done = 0
	for _, id in IDS do
		local mesh, err = open(id)
		local text
		if mesh then
			local ok, res = pcall(read, mesh)
			pcall(function()
				mesh:Destroy()
			end)
			text = if ok then "M " .. id .. "\\n" .. res else "M " .. id .. "\\nE " .. string.gsub(tostring(res), "\\n", " ") .. "\\n"
		else
			text = "M " .. id .. "\\nE " .. string.gsub(tostring(err), "\\n", " ") .. "\\n"
		end
		post(id, text)
		done += 1
		if opts and opts.onStage then
			opts.onStage("mesh " .. done .. "/" .. #IDS)
		end
		task.wait()
	end
	send("${MESH_END_TAG} " .. done)
end

return M
`
}

export function meshJob(opts: { id: string; port: number; ids: string[] }): BridgeJob {
  return {
    id: opts.id,
    version: BRIDGE_VERSION,
    kind: 'vfx',
    mode: 'realtime',
    name: 'Mesh read',
    rig: 'R15',
    duration: 0,
    beats: [],
    camera: CAMERAS.vfx,
    modules: [{ name: MESH_ENTRY, className: 'ModuleScript', source: meshModuleSource({ port: opts.port, jobId: opts.id, ids: opts.ids }) }],
    entry: MESH_ENTRY,
    calibrate: false,
    key: KEY_COLOR,
    linger: 0,
    timeout: 240
  }
}

export type MeshJobResult = { ok: true; mesh: MeshData } | { ok: false; error: string }

function nums(line: string | undefined, tag: string): number[] {
  if (!line || !line.startsWith(tag + ' ')) return []
  const body = line.slice(tag.length + 1).trim()
  if (!body) return []
  return body.split(',').map(Number)
}

// One mesh's text ("M <id>\n..." without the M line) -> geometry or the error Studio gave.
export function decodeMeshText(text: string): MeshJobResult {
  const lines = text.split('\n')
  const err = lines.find((l) => l.startsWith('E '))
  if (err) return { ok: false, error: err.slice(2).trim() || 'Studio could not open the mesh' }
  const p = nums(lines.find((l) => l.startsWith('P ')), 'P')
  const n = nums(lines.find((l) => l.startsWith('N ')), 'N')
  const u = nums(lines.find((l) => l.startsWith('U ')), 'U')
  const i = nums(lines.find((l) => l.startsWith('I ')), 'I')
  if (!p.length || p.length % 3 || !i.length || i.length % 3 || [...p, ...i].some((x) => !Number.isFinite(x))) return { ok: false, error: 'the mesh data from Studio was incomplete' }
  const nv = p.length / 3
  const normals = n.length === nv * 3 && n.every(Number.isFinite) && n.some((x) => x !== 0) ? Float32Array.from(n) : undefined
  // EditableMesh UVs use the top-left origin like mesh files: flip v for OpenGL.
  const uvs = u.length === nv * 2 && u.every(Number.isFinite) ? Float32Array.from(u.map((x, k) => (k % 2 ? 1 - x : x))) : undefined
  try {
    return { ok: true, mesh: finishMesh({ positions: Float32Array.from(p), normals, uvs, indices: Uint32Array.from(i), format: 'editablemesh' }) }
  } catch (e) {
    return { ok: false, error: e instanceof MeshError ? e.message : 'bad mesh data' }
  }
}

// Reassembles the module's 'log' messages: mesh id -> result. Meshes whose chunks did not all
// arrive are left out (the caller reports them as not received). `complete` is true once the
// end line arrived.
export function collectMeshes(messages: string[]): { results: Map<string, MeshJobResult>; complete: boolean } {
  const parts = new Map<string, { total: number; got: Map<number, string> }>()
  let complete = false
  for (const m of messages) {
    if (m.startsWith(MESH_END_TAG + ' ')) {
      complete = true
      continue
    }
    const r = new RegExp(`^${MESH_TAG} (\\d{1,20}) (\\d+)/(\\d+) `).exec(m)
    if (!r) continue
    const e = parts.get(r[1]) ?? { total: Number(r[3]), got: new Map<number, string>() }
    e.total = Number(r[3])
    e.got.set(Number(r[2]), m.slice(r[0].length))
    parts.set(r[1], e)
  }
  const results = new Map<string, MeshJobResult>()
  for (const [id, e] of parts) {
    if (e.got.size !== e.total) continue
    const text = Array.from({ length: e.total }, (_, k) => e.got.get(k + 1) ?? '').join('')
    const body = text.replace(/^M \d+\n/, '')
    results.set(id, decodeMeshText(body))
  }
  return { results, complete }
}
