--!nocheck
-- RBX Forge Animation Lab: runs an animation timeline script headlessly and records what it asks
-- for. Nothing touches Roblox: every call on the anim API becomes one op ({ op, at, line, ... }) and
-- the script's clock only moves when it says so (a:wait / a:hold / a:at / a:after), so a clip
-- records instantly. Forge turns the ops into keyframes (src/shared/anim/compile.ts). Prints one
-- JSON line: { ok, ops, prints, error? = { message } }.
--
--   lune run anim_timeline.luau <timeline.luau>
--
-- The sandbox exposes the anim API, Roblox datatypes from @lune/roblox (Vector3, CFrame, Enum...)
-- and the safe standard libraries. No require, fs, net, process, game or workspace.

local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")

local MAX_OPS = 3000
local MAX_PRINTS = 200

local function emit(result)
	print(serde.encode("json", result))
end

local path = process.args[1]
if not path then
	emit({ ok = false, ops = {}, prints = {}, error = { message = "usage: anim_timeline.luau <script.luau>" } })
	process.exit(2)
end

local okRead, source = pcall(fs.readFile, path)
if not okRead then
	emit({ ok = false, ops = {}, prints = {}, error = { message = "cannot read the script: " .. tostring(source) } })
	process.exit(2)
end
local ops = {}
local prints = {}
local CHUNK = '[string "timeline"]'

-- Line of the user's script that made the current call.
local function userLine()
	for level = 2, 40 do
		local s, l = debug.info(level, "sl")
		if s == nil then
			break
		end
		if s == CHUNK then
			return l
		end
	end
	return nil
end

-- Errors point at the user's line, however deep inside the API they are raised.
local function fail(message)
	local line = userLine()
	error(if line then string.format("%s:%d: %s", CHUNK, line, message) else message, 0)
end

-- ------------------------------------------------------------------ values

local function ser(v, depth)
	depth = depth or 0
	if depth > 6 then
		fail("value nested too deeply")
	end
	local t = typeof(v)
	if t == "number" or t == "boolean" or t == "string" then
		return v
	elseif t == "Vector3" then
		return { __t = "v3", x = v.X, y = v.Y, z = v.Z }
	elseif t == "Vector2" then
		return { __t = "v2", x = v.X, y = v.Y }
	elseif t == "Color3" then
		return { __t = "c3", r = v.R, g = v.G, b = v.B }
	elseif t == "CFrame" then
		return { __t = "cf", c = { v:GetComponents() } }
	elseif t == "EnumItem" then
		return v.Name
	elseif t == "NumberRange" then
		return { v.Min, v.Max }
	elseif t == "table" then
		local out = {}
		for k, x in v do
			out[k] = ser(x, depth + 1)
		end
		return out
	end
	fail("a " .. t .. " cannot be used in a timeline")
end

local function num(v, method, what)
	if type(v) ~= "number" or v ~= v then
		fail("a:" .. method .. ": " .. what .. " must be a number, got " .. typeof(v))
	end
	return v
end

-- ------------------------------------------------------------------ anim

local clock = 0

local function record(op)
	if #ops >= MAX_OPS then
		fail("too many anim calls (limit " .. MAX_OPS .. "); is there a runaway loop?")
	end
	op.at = clock
	op.line = userLine()
	table.insert(ops, op)
end

local function str(v, method, what)
	if type(v) ~= "string" or v == "" then
		fail("a:" .. method .. ": " .. what .. " must be a string, got " .. typeof(v))
	end
	return v
end

local function optsOf(v, method)
	if v == nil then
		return {}
	end
	if type(v) ~= "table" then
		fail("a:" .. method .. ": options must be a table")
	end
	return ser(v)
end

local anim = {}
anim.__index = anim

function anim:pose(name, opts)
	record({ op = "pose", name = str(name, "pose", "name"), opts = optsOf(opts, "pose") })
end

function anim:joint(joint, rot, opts)
	local t = typeof(rot)
	if t ~= "Vector3" and t ~= "CFrame" then
		fail("a:joint: expected a Vector3 (degrees) or a CFrame, got " .. t)
	end
	local o = optsOf(opts, "joint")
	record({ op = "joint", joint = str(joint, "joint", "joint"), rot = ser(rot), pos = o.pos, opts = o })
end

function anim:root(offset, degrees, opts)
	if offset ~= nil and typeof(offset) ~= "Vector3" then
		fail("a:root: offset must be a Vector3 (studs) or nil")
	end
	if degrees ~= nil and typeof(degrees) ~= "Vector3" then
		fail("a:root: rotation must be a Vector3 (degrees) or nil")
	end
	record({ op = "root", pos = offset and ser(offset) or nil, rot = degrees and ser(degrees) or nil, opts = optsOf(opts, "root") })
end

function anim:ik(limb, target, opts)
	if typeof(target) ~= "Vector3" then
		fail("a:ik: target must be a Vector3 (studs, feet on y = 0, facing -Z)")
	end
	record({ op = "ik", limb = str(limb, "ik", "limb"), target = ser(target), opts = optsOf(opts, "ik") })
end

function anim:look(target, opts)
	if typeof(target) ~= "Vector3" then
		fail("a:look: target must be a Vector3")
	end
	record({ op = "look", target = ser(target), opts = optsOf(opts, "look") })
end

function anim:plant(foot, from, to)
	if to == nil then
		to = from
		from = clock
	end
	num(from, "plant", "from")
	num(to, "plant", "to")
	record({ op = "plant", foot = str(foot, "plant", "foot"), opts = { from = from }, ["until"] = to })
end

function anim:overlap(group, opts)
	if group ~= nil and type(group) ~= "string" and type(group) ~= "table" then
		fail("a:overlap: group must be a name such as \"arms\" or a list of joints")
	end
	record({ op = "overlap", group = group and ser(group) or "arms", opts = optsOf(opts, "overlap") })
end

function anim:mirror()
	record({ op = "mirror" })
end

function anim:feet(mode)
	if mode ~= "auto" and mode ~= "free" then
		fail('a:feet: mode must be "auto" (lock grounded feet, the default) or "free"')
	end
	record({ op = "feet", value = mode })
end

function anim:hold(seconds)
	seconds = num(seconds or 0, "hold", "seconds")
	if seconds < 0 then
		fail("a:hold: seconds must be >= 0")
	end
	record({ op = "hold", dt = seconds })
	clock += seconds
	return clock
end

function anim:marker(name)
	record({ op = "marker", name = str(name, "marker", "name") })
end

function anim:beat(label)
	record({ op = "beat", name = str(label, "beat", "label") })
end

function anim:duration(seconds)
	record({ op = "duration", value = num(seconds, "duration", "seconds") })
end

function anim:loop(on)
	record({ op = "loop", value = on ~= false })
end

function anim:priority(p)
	record({ op = "priority", value = ser(p) })
end

function anim:name(n)
	record({ op = "name", value = str(n, "name", "name") })
end

function anim:ease(style, dir)
	record({ op = "ease", value = ser(style), opts = { dir = dir and ser(dir) or nil } })
end

function anim:wait(seconds)
	seconds = num(seconds or 0, "wait", "seconds")
	if seconds < 0 then
		fail("a:wait: seconds must be >= 0")
	end
	clock += seconds
	return clock
end

function anim:at(t, fn)
	num(t, "at", "time")
	if type(fn) ~= "function" then
		fail("a:at: expected a function")
	end
	local saved = clock
	clock = math.max(0, t)
	fn()
	clock = saved
end

function anim:after(dt, fn)
	num(dt, "after", "delay")
	if type(fn) ~= "function" then
		fail("a:after: expected a function")
	end
	local saved = clock
	clock = math.max(0, clock + dt)
	fn()
	clock = saved
end

function anim:now()
	return clock
end

local api = setmetatable({}, anim)

-- ------------------------------------------------------------------ sandbox

local function capture(prefix)
	return function(...)
		if #prints >= MAX_PRINTS then
			return
		end
		local parts = {}
		for i = 1, select("#", ...) do
			parts[i] = tostring((select(i, ...)))
		end
		table.insert(prints, prefix .. table.concat(parts, "\t"))
	end
end

local env = {
	a = api,
	anim = api,
	Vector3 = roblox.Vector3,
	Vector2 = roblox.Vector2,
	Color3 = roblox.Color3,
	CFrame = roblox.CFrame,
	NumberRange = roblox.NumberRange,
	NumberSequence = roblox.NumberSequence,
	NumberSequenceKeypoint = roblox.NumberSequenceKeypoint,
	ColorSequence = roblox.ColorSequence,
	ColorSequenceKeypoint = roblox.ColorSequenceKeypoint,
	Enum = roblox.Enum,
	math = math,
	string = string,
	table = table,
	utf8 = utf8,
	bit32 = bit32,
	typeof = typeof,
	type = type,
	pairs = pairs,
	ipairs = ipairs,
	next = next,
	select = select,
	tostring = tostring,
	tonumber = tonumber,
	error = error,
	assert = assert,
	pcall = pcall,
	xpcall = xpcall,
	unpack = table.unpack,
	setmetatable = setmetatable,
	getmetatable = getmetatable,
	rawget = rawget,
	rawset = rawset,
	rawequal = rawequal,
	print = capture(""),
	warn = capture("warn: "),
	-- task.wait / task.delay move the timeline clock like a:wait / a:after.
	task = {
		wait = function(s)
			return api:wait(s or 0)
		end,
		delay = function(s, fn, ...)
			local args = table.pack(...)
			api:after(s or 0, function()
				fn(table.unpack(args, 1, args.n))
			end)
		end,
		spawn = function(fn, ...)
			fn(...)
		end,
	},
}
setmetatable(env, {
	__index = function(_, key)
		error(string.format("'%s' is not available in the timeline sandbox: drive the animation through a (and Vector3, CFrame, Enum, math...)", tostring(key)), 2)
	end,
})

local okLoad, chunk = pcall(luau.load, source, { debugName = "timeline", environment = env, injectGlobals = false })
if not okLoad then
	emit({ ok = false, ops = ops, prints = prints, error = { message = tostring(chunk) } })
	return
end

local okRun, result = pcall(chunk, api)
if okRun and type(result) == "function" then
	okRun, result = pcall(result, api)
end
if not okRun then
	emit({ ok = false, ops = ops, prints = prints, error = { message = tostring(result) } })
	return
end
emit({ ok = true, ops = ops, prints = prints })
