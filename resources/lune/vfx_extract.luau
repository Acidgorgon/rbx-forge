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
				if v ~= nil then
					local c = convert(v, ids)
					if c ~= nil then
						out.props[prop] = c
					end
				end
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

for i = 2, #args do
	local file = args[i]
	local ok, result = pcall(function()
		local roots = roblox.deserializeModel(fs.readFile(file))
		return extract(roots)
	end)
	if ok then
		print(serde.encode("json", { file = file, roots = result }))
	else
		print(serde.encode("json", { file = file, error = tostring(result) }))
	end
end
