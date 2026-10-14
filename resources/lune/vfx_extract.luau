--!nocheck
-- RBX Forge VFX Lab: reads .rbxm / .rbxmx models with Lune's @lune/roblox and prints, per file, one
-- JSON line: { file, roots = { node... } } or { file, error }. A node is
-- { id, className, name, props = { [Prop] = value }, children = { ... }, source? }.
--
--   lune run vfx_extract.luau -- <props.json> <file> [<file> ...]
--
-- props.json maps class names to the property names to read (Forge's VFX schema). Properties that
-- are not set in the file have no default in Lune's reflection database and raise on read, so every
-- read is guarded. Values are converted to plain JSON (see src/shared/vfx/types.ts).

local fs = require("@lune/fs")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")

local args = process.args
if #args < 2 then
	print(serde.encode("json", { error = "usage: vfx_extract.luau <props.json> <file>..." }))
	process.exit(2)
end

local wanted = serde.decode("json", fs.readFile(args[1]))
local KEEP = {}
for className in wanted do
	KEEP[className] = true
end
local SCRIPTS = { Script = true, LocalScript = true, ModuleScript = true }

local function convert(v, ids)
	local t = typeof(v)
	if t == "number" or t == "boolean" or t == "string" then
		return v
	elseif t == "EnumItem" then
		return v.Name
	elseif t == "Vector3" then
		return { v.X, v.Y, v.Z }
	elseif t == "Vector2" then
		return { v.X, v.Y }
	elseif t == "Color3" then
		return { v.R, v.G, v.B }
	elseif t == "NumberRange" then
		return { v.Min, v.Max }
	elseif t == "NumberSequence" then
		local out = {}
		for _, k in v.Keypoints do
			table.insert(out, { t = k.Time, v = k.Value, e = k.Envelope })
		end
		return out
	elseif t == "ColorSequence" then
		local out = {}
		for _, k in v.Keypoints do
			table.insert(out, { t = k.Time, c = { k.Value.R, k.Value.G, k.Value.B } })
		end
		return out
	elseif t == "CFrame" then
		return { v:GetComponents() }
	elseif t == "Content" then
		local ok, uri = pcall(function()
			return v.Uri
		end)
		return if ok and uri then uri else nil
	elseif t == "Instance" then
		return ids[v]
	end
	return nil
end

local function read(inst, name)
	local ok, v = pcall(function()
		return inst[name]
	end)
	if ok then
		return v
	end
	return nil
end

local function extract(roots)
	local ids = {}
	local counter = 0
	local function assign(inst)
		counter += 1
		ids[inst] = "n" .. counter
		for _, c in inst:GetChildren() do
			assign(c)
		end
	end
	for _, r in roots do
		assign(r)
	end
	local function node(inst)
		local className = inst.ClassName
		local out = { id = ids[inst], className = className, name = inst.Name, props = {}, children = {} }
		local names = wanted[className]
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
		-- Instance attributes (EmitCount / EmitDelay / EmitDuration and friends): plain values only.
		local okAttrs, attrs = pcall(function()
			return inst:GetAttributes()
		end)
		if okAttrs and type(attrs) == "table" then
			local plain = {}
			local any = false
			for k, v in attrs do
				local t = typeof(v)
				if t == "number" or t == "boolean" or t == "string" then
					plain[k] = v
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
				out.source = string.sub(src, 1, 200000)
			end
		end
		for _, c in inst:GetChildren() do
			table.insert(out.children, node(c))
		end
		return out
	end
	local list = {}
	for _, r in roots do
		table.insert(list, node(r))
	end
	return list
end

-- Place files (.rbxl / .rbxlx): the VFX packs, i.e. Folders / Models in Workspace, ReplicatedStorage
-- and ServerStorage with at least 3 children holding a ParticleEmitter / Beam / Trail (or named like
-- "VFX" / "Effects" with one). Top-most only. Same rule as src/shared/vfx/split.ts findVfxPacks.
local PACK_FX = { ParticleEmitter = true, Beam = true, Trail = true }
local PACK_SERVICES = { "Workspace", "ReplicatedStorage", "ServerStorage" }
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
local function isGroup(inst)
	return inst.ClassName == "Folder" or inst.ClassName == "Model"
end
local function findPacks(game)
	local packs, paths = {}, {}
	local function visit(inst, path, depth)
		if depth > 12 or #packs >= 100 then
			return
		end
		local effects = 0
		for _, c in inst:GetChildren() do
			if hasFx(c) then
				effects += 1
			end
		end
		local lname = string.lower(inst.Name)
		local named = string.find(lname, "vfx") or string.find(lname, "fx") or string.find(lname, "effect") or string.find(lname, "particle")
		if effects >= 3 or (effects >= 1 and named) then
			table.insert(packs, inst)
			table.insert(paths, path)
			return
		end
		for _, c in inst:GetChildren() do
			if isGroup(c) then
				visit(c, path .. "." .. c.Name, depth + 1)
			end
		end
	end
	for _, name in PACK_SERVICES do
		local service = game:FindFirstChildOfClass(name)
		if service then
			for _, c in service:GetChildren() do
				if isGroup(c) then
					visit(c, name .. "." .. c.Name, 1)
				end
			end
		end
	end
	return packs, paths
end

local function isPlace(file)
	local lower = string.lower(file)
	return string.sub(lower, -5) == ".rbxl" or string.sub(lower, -6) == ".rbxlx"
end

for i = 2, #args do
	local file = args[i]
	local place = isPlace(file)
	local packPaths = nil
	local ok, result = pcall(function()
		if place then
			local game = roblox.deserializePlace(fs.readFile(file))
			local packs, paths = findPacks(game)
			packPaths = paths
			return extract(packs)
		end
		local roots = roblox.deserializeModel(fs.readFile(file))
		return extract(roots)
	end)
	if ok then
		if place then
			print(serde.encode("json", { file = file, roots = result, place = true, packs = packPaths }))
		else
			print(serde.encode("json", { file = file, roots = result }))
		end
	else
		print(serde.encode("json", { file = file, error = tostring(result) }))
	end
end
