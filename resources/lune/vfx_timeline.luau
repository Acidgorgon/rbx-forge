--!nocheck
-- RBX Forge VFX Lab: runs an effect's timeline script headlessly and records what it asks for.
-- Nothing touches Roblox: every fx call becomes one op ({ op, at, line, ... }) and the script's
-- clock only moves when it says so (fx:wait / fx:at / fx:after), so a 3 second effect records
-- instantly. Prints one JSON line: { ok, ops, prints, error? = { message } }.
--
--   lune run vfx_timeline.luau <timeline.luau>
--
-- The sandbox exposes the ForgeFX API (same methods as the runtime module the exporter writes,
-- src/shared/vfx/runtime.ts), Roblox datatypes from @lune/roblox (Vector3, Color3, CFrame, Enum...)
-- and the safe standard libraries. No require, fs, net, process, game or workspace.

local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")

local MAX_OPS = 4000
local MAX_PRINTS = 200

local function emit(result)
	print(serde.encode("json", result))
end

local path = process.args[1]
if not path then
	emit({ ok = false, ops = {}, prints = {}, error = { message = "usage: vfx_timeline.luau <script.luau>" } })
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

-- Errors point at the user's line, however deep inside fx they are raised.
local function fail(message)
	local line = userLine()
	error(if line then string.format("%s:%d: %s", CHUNK, line, message) else message, 0)
end

-- ------------------------------------------------------------------ values

local Handle = {}
local function handle(name)
	return setmetatable({ __forgeHandle = true, __name = name }, Handle)
end
Handle.__index = function(h, key)
	if type(key) ~= "string" then
		return nil
	end
	-- orb.Glow -> the instance "<OrbName>Glow"
	return handle(rawget(h, "__name") .. key)
end
Handle.__tostring = function(h)
	return rawget(h, "__name")
end
Handle.__concat = function(a, b)
	return tostring(a) .. tostring(b)
end

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
		if rawget(v, "__forgeHandle") then
			return { __t = "h", name = rawget(v, "__name") }
		end
		local out = {}
		for k, x in v do
			out[k] = ser(x, depth + 1)
		end
		return out
	end
	fail("a " .. t .. " cannot be used in a timeline")
end

local function targetName(target, method)
	if type(target) == "string" and target ~= "" then
		return target
	end
	if type(target) == "table" and rawget(target, "__forgeHandle") then
		return rawget(target, "__name")
	end
	fail("fx:" .. method .. ": expected a handle from fx:spawn or an instance name, got " .. typeof(target))
end

local function num(v, method, what)
	if type(v) ~= "number" or v ~= v then
		fail("fx:" .. method .. ": " .. what .. " must be a number, got " .. typeof(v))
	end
	return v
end

-- ------------------------------------------------------------------ fx

local clock = 0
local spawnCounts = {}

local function record(op)
	if #ops >= MAX_OPS then
		fail("too many fx calls (limit " .. MAX_OPS .. "); is there a runaway loop?")
	end
	op.at = clock
	op.line = userLine()
	table.insert(ops, op)
end

local fx = {}
fx.__index = fx

function fx:spawn(kind, opts)
	if type(kind) ~= "string" then
		fail("fx:spawn: kind must be a string such as \"orb\"")
	end
	if opts ~= nil and type(opts) ~= "table" then
		fail("fx:spawn: options must be a table")
	end
	opts = opts or {}
	local name = opts.name
	if name ~= nil then
		if type(name) ~= "string" or not string.match(name, "^[A-Za-z][A-Za-z0-9_]*$") then
			fail("fx:spawn: name must start with a letter and use only letters, digits and _")
		end
	else
		local key = string.lower(kind)
		spawnCounts[key] = (spawnCounts[key] or 0) + 1
		name = string.upper(string.sub(key, 1, 1)) .. string.sub(key, 2) .. spawnCounts[key]
	end
	record({ op = "spawn", kind = kind, name = name, opts = ser(opts) })
	return handle(name)
end

function fx:emit(target, count)
	record({ op = "emit", target = targetName(target, "emit"), count = num(count or 16, "emit", "count") })
end

function fx:enable(target)
	record({ op = "enable", target = targetName(target, "enable") })
end

function fx:disable(target)
	record({ op = "disable", target = targetName(target, "disable") })
end

function fx:tween(target, duration, goals, style, direction)
	local name = targetName(target, "tween")
	num(duration, "tween", "duration")
	if type(goals) ~= "table" then
		fail("fx:tween: goals must be a table such as { Position = Vector3.new(0, 0, -10) }")
	end
	record({ op = "tween", target = name, duration = duration, props = ser(goals), style = style and ser(style) or "Quad", direction = direction and ser(direction) or "Out" })
	return duration
end

function fx:set(target, goals)
	if type(goals) ~= "table" then
		fail("fx:set: goals must be a table")
	end
	record({ op = "set", target = targetName(target, "set"), props = ser(goals) })
end

function fx:wait(seconds)
	seconds = num(seconds or 0, "wait", "seconds")
	if seconds < 0 then
		fail("fx:wait: seconds must be >= 0")
	end
	clock += seconds
	return clock
end

function fx:at(t, fn)
	num(t, "at", "time")
	if type(fn) ~= "function" then
		fail("fx:at: expected a function")
	end
	local saved = clock
	clock = math.max(0, t)
	fn()
	clock = saved
end

function fx:after(dt, fn)
	num(dt, "after", "delay")
	if type(fn) ~= "function" then
		fail("fx:after: expected a function")
	end
	local saved = clock
	clock = math.max(0, clock + dt)
	fn()
	clock = saved
end

function fx:now()
	return clock
end

function fx:stage(label)
	if type(label) ~= "string" then
		fail("fx:stage: label must be a string")
	end
	record({ op = "stage", label = label })
end

function fx:duration(seconds)
	record({ op = "duration", value = num(seconds, "duration", "seconds") })
end

function fx:anchor(v)
	if typeof(v) ~= "Vector3" then
		fail("fx:anchor: expected a Vector3")
	end
	record({ op = "anchor", value = ser(v) })
end

function fx:forward(d)
	return roblox.Vector3.new(0, 0, -num(d or 1, "forward", "distance"))
end

function fx:right(d)
	return roblox.Vector3.new(num(d or 1, "right", "distance"), 0, 0)
end

function fx:up(d)
	return roblox.Vector3.new(0, num(d or 1, "up", "distance"), 0)
end

local api = setmetatable({}, fx)

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
	fx = api,
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
	-- task.wait / task.delay move the timeline clock like fx:wait / fx:after.
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
		error(string.format("'%s' is not available in the timeline sandbox: drive the effect through fx (and Vector3, Color3, CFrame, Enum, math...)", tostring(key)), 2)
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
