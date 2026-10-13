--!nocheck
-- RBX Forge Animation Lab: reads KeyframeSequences from .rbxm / .rbxmx files with Lune's
-- @lune/roblox and prints, per file, one JSON line:
--   { file, sequences = { { name, loop, priority, keyframes = { { time, name, markers, poses } } } } }
-- or { file, error }. A pose is { name, cf = { 12 numbers }, style, dir, weight, children }.
-- Enums are written as item names. Matches RawSequence in src/shared/anim/rbxmx.ts.
--
--   lune run anim_extract.luau -- <file> [<file> ...]

local fs = require("@lune/fs")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")

local function read(inst, name)
	local ok, v = pcall(function()
		return inst[name]
	end)
	if ok then
		return v
	end
	return nil
end

local function enumName(v)
	if typeof(v) == "EnumItem" then
		return v.Name
	end
	return v
end

local function pose(inst)
	local cf = read(inst, "CFrame")
	local out = {
		name = inst.Name,
		cf = if typeof(cf) == "CFrame" then { cf:GetComponents() } else { 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1 },
		style = enumName(read(inst, "EasingStyle")) or "Linear",
		dir = enumName(read(inst, "EasingDirection")) or "In",
		weight = read(inst, "Weight") or 1,
		children = {},
	}
	for _, c in inst:GetChildren() do
		if c.ClassName == "Pose" then
			table.insert(out.children, pose(c))
		end
	end
	return out
end

local function sequence(inst)
	local out = {
		name = inst.Name,
		loop = read(inst, "Loop") == true,
		priority = enumName(read(inst, "Priority")) or "Action",
		keyframes = {},
	}
	for _, kf in inst:GetChildren() do
		if kf.ClassName == "Keyframe" then
			local k = { time = read(kf, "Time") or 0, name = kf.Name, poses = {}, markers = {} }
			for _, c in kf:GetChildren() do
				if c.ClassName == "Pose" then
					table.insert(k.poses, pose(c))
				elseif c.ClassName == "KeyframeMarker" then
					table.insert(k.markers, { name = c.Name, value = tostring(read(c, "Value") or "") })
				end
			end
			table.insert(out.keyframes, k)
		end
	end
	return out
end

local function collect(inst, list)
	if inst.ClassName == "KeyframeSequence" then
		table.insert(list, sequence(inst))
		return
	end
	for _, c in inst:GetChildren() do
		collect(c, list)
	end
end

local args = process.args
for i = 1, #args do
	local file = args[i]
	local ok, result = pcall(function()
		local roots = roblox.deserializeModel(fs.readFile(file))
		local list = {}
		for _, r in roots do
			collect(r, list)
		end
		return list
	end)
	if ok then
		print(serde.encode("json", { file = file, sequences = result }))
	else
		print(serde.encode("json", { file = file, error = tostring(result) }))
	end
end
