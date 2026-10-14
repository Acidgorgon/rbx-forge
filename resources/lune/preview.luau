--!nocheck
--> RBX Forge UI preview: runs one UI Labs story headless and streams its GUI tree as JSON lines.
--
-- Usage (from the project root):
--   lune run <path>/preview.luau -- --sourcemap <file> --story <file> [--width 1280] [--height 720]
--                                   [--device desktop|phone|tablet|console] [--controls <json>]
--                                   [--duration <seconds>]
--   lune run <path>/preview.luau -- --sourcemap <file> --list
--
-- Output: one JSON object per line, each with "forge": 1 and "type":
--   {"type":"story","kind":"vide|function|generic","controls":[...],"file":...}
--   {"type":"ops","ops":[...]}                 instance tree changes (see forge/gui.luau)
--   {"type":"log","level":"print|warn","text":...}
--   {"type":"error","message":...,"traceback":...}
--   {"type":"frame","n":...}                    after the first frame that sent ops (a render point)
--   {"type":"storybooks","storybooks":[...],"stories":[...]}   (--list)
--   {"type":"fatal","message":...}             cannot start; exit code 2
-- Input (stdin, JSON lines): see Gui:input (click, down, up, enter, leave, move, text, focus, blur,
-- scroll, key, resize, layout, set) plus {"type":"control","key":k,"group":g?,"value":v} and
-- {"type":"quit"}.

local fs = require("@lune/fs")
local process = require("@lune/process")
local serde = require("@lune/serde")
local stdio = require("@lune/stdio")
local task = require("@lune/task")

local World = require("./forge/world")
local Gui = require("./forge/gui")

local PROTOCOL = 1

local function parseArgs(argv)
	local options = { sourcemap = "sourcemap.json", width = 1280, height = 720, device = "desktop" }
	local i = 1
	if argv[1] == "--" then
		i = 2
	end
	while i <= #argv do
		local arg, value = argv[i], argv[i + 1]
		if arg == "--list" then
			options.list = true
			i += 1
		elseif arg == "--sourcemap" or arg == "--story" or arg == "--root" or arg == "--device" or arg == "--controls" then
			options[string.sub(arg, 3)] = value
			i += 2
		elseif arg == "--width" or arg == "--height" or arg == "--duration" then
			options[string.sub(arg, 3)] = tonumber(value)
			i += 2
		else
			i += 1
		end
	end
	return options
end

local options = parseArgs(process.args)

local function toPosix(path: string): string
	return (string.gsub(path, "\\", "/"))
end

local root = toPosix(options.root or process.cwd)
if string.sub(root, -1) ~= "/" then
	root ..= "/"
end

local function emit(event)
	event.forge = PROTOCOL
	local ok, line = pcall(serde.encode, "json", event)
	if not ok then
		line = serde.encode("json", { forge = PROTOCOL, type = "log", level = "warn", text = "forge: could not encode an event: " .. tostring(line) })
	end
	stdio.write(line .. "\n")
end

local function fatal(message: string)
	emit({ type = "fatal", message = message })
	process.exit(2)
end

local function relative(path: string): string
	path = toPosix(path)
	if string.sub(path, 1, #root) == root then
		path = string.sub(path, #root + 1)
	end
	return (string.gsub(path, "^%./", ""))
end

local sourcemapPath = options.sourcemap
local fullSourcemap = if string.match(sourcemapPath, "^/") or string.match(sourcemapPath, "^%a:[/\\]") then sourcemapPath else root .. sourcemapPath
if not fs.isFile(fullSourcemap) then
	fatal(`no sourcemap at {sourcemapPath}`)
end
local okTree, tree = pcall(function()
	return serde.decode("json", fs.readFile(fullSourcemap))
end)
if not okTree or type(tree) ~= "table" then
	fatal(`could not read sourcemap {sourcemapPath}: {tostring(tree)}`)
end

local world = World.new({
	root = root,
	tree = tree,
	realm = "client",
	log = function(level, text)
		emit({ type = "log", level = level, text = text })
	end,
})

-- Roblox reports Instances as userdata; Vide (and other libraries) tell children from property
-- tables with type(x) == "userdata", so the preview's scripts see the same.
local nativeType = type
world.globals.type = function(value)
	if World.isInstance(value) then
		return "userdata"
	end
	return nativeType(value)
end
local debugLib = table.clone(debug)
debugLib.profilebegin = function() end
debugLib.profileend = function() end
debugLib.setmemorycategory = function() end
debugLib.resetmemorycategory = function() end
-- Lune raises error objects, not strings; Luau's traceback rejects those (Vide passes it to xpcall).
debugLib.traceback = function(message, ...)
	if message ~= nil and type(message) ~= "string" and type(message) ~= "thread" then
		message = tostring(message)
	end
	return debug.traceback(message, ...)
end
world.globals.debug = debugLib

-- UDim offsets are int32 in Roblox, which truncates fractional offsets; Lune's constructors reject
-- them, so the preview truncates first.
local roblox = require("@lune/roblox")
local function int(n)
	if type(n) ~= "number" then
		return n
	end
	return if n >= 0 then math.floor(n) else math.ceil(n)
end
world.globals.UDim = setmetatable({
	new = function(scale, offset)
		return roblox.UDim.new(scale, int(offset))
	end,
}, { __index = roblox.UDim })
world.globals.UDim2 = setmetatable({
	new = function(xs, xo, ys, yo)
		if typeof(xs) == "UDim" then
			return roblox.UDim2.new(xs, xo)
		end
		return roblox.UDim2.new(xs, int(xo), ys, int(yo))
	end,
	fromOffset = function(x, y)
		return roblox.UDim2.fromOffset(int(x), int(y))
	end,
}, { __index = roblox.UDim2 })

local function traceback(err)
	return { message = tostring(err), traceback = debug.traceback(nil, 2) }
end

local function report(info)
	emit({ type = "error", message = info.message, traceback = info.traceback })
end

local function moduleFor(file: string)
	local inst = world:instanceForFile(file)
	if inst then
		return inst
	end
	if not fs.isFile(root .. file) then
		return nil
	end
	local folder = world.game:FindFirstChild("ForgeStories") or world.globals.Instance.new("Folder", world.game)
	folder.Name = "ForgeStories"
	inst = world.globals.Instance.new("ModuleScript", folder)
	inst.Name = string.match(file, "([^/]+)%.luau?$") or file
	world:bindFile(inst, file)
	return inst
end

---------------------------------------------------------------------------------------------------
-- --list: storybooks and the stories under their storyRoots (UI Labs semantics).

if options.list then
	local storybooks, stories = {}, {}
	local function walk(node, path)
		local here = table.clone(path)
		if node.className ~= "DataModel" then
			table.insert(here, node.name)
		end
		for _, file in node.filePaths or {} do
			local rel = relative(file)
			if not string.match(rel, "^Packages/") and not string.match(rel, "^ServerPackages/") then
				if string.match(rel, "%.storybook%.luau?$") then
					table.insert(storybooks, { file = rel, path = here })
				elseif string.match(rel, "%.story%.luau?$") then
					table.insert(stories, { file = rel, path = here })
				end
			end
		end
		for _, child in node.children or {} do
			walk(child, here)
		end
	end
	walk(tree, {})
	for _, book in storybooks do
		local inst = world:instanceForFile(book.file)
		local ok, result = pcall(function()
			return world:loadModule(inst)
		end)
		if not ok then
			book.error = tostring(result)
		elseif type(result) ~= "table" then
			book.error = "storybook did not return a table"
		else
			book.name = if type(result.name) == "string" then result.name else nil
			book.groupRoots = result.groupRoots == true
			book.roots = {}
			for _, rootInst in result.storyRoots or {} do
				if World.isInstance(rootInst) then
					table.insert(book.roots, World.fullName(rootInst))
				end
			end
		end
	end
	emit({ type = "storybooks", storybooks = storybooks, stories = stories })
	process.exit(0)
end

---------------------------------------------------------------------------------------------------
-- Run one story

if not options.story then
	fatal("--story <file> is required")
end
local storyFile = relative(options.story)
local storyModule = moduleFor(storyFile)
if not storyModule then
	fatal(`story file not found: {storyFile}`)
end

local host = Gui.new({
	world = world,
	emit = emit,
	width = options.width,
	height = options.height,
	device = options.device,
})

local initialValues = {}
if options.controls then
	local ok, decoded = pcall(serde.decode, "json", options.controls)
	if ok and type(decoded) == "table" then
		initialValues = decoded
	end
end

local story
local loaded, loadInfo = xpcall(function()
	story = world:loadModule(storyModule)
end, traceback)
if not loaded then
	report(loadInfo)
	emit({ type = "story", kind = "error", file = storyFile, controls = {} })
	host:flush()
end

local kind = "error"
local controlsDef = nil
local sources = {} -- Vide sources: [group or ""][key] = source
local genericListeners = {}
local cleanup = nil

local function valueKey(group, key)
	return if group then group .. "/" .. key else key
end

local function controlDef(group, key)
	if not controlsDef then
		return nil
	end
	if group then
		local g = controlsDef[group]
		return g and g.Controls and g.Controls[key]
	end
	return controlsDef[key]
end

-- Plain control values, the shape UI Labs passes to generic stories.
local function plainValues()
	local out = {}
	for key, control in controlsDef or {} do
		if type(control) == "table" and control.EntryType == "ControlGroup" then
			out[key] = {}
			for inner, c in control.Controls or {} do
				out[key][inner] = Gui.controlValue(c, initialValues[valueKey(key, inner)])
			end
		else
			out[key] = Gui.controlValue(control, initialValues[key])
		end
	end
	return out
end

if loaded then
	if type(story) == "function" then
		kind = "function"
	elseif type(story) == "table" then
		controlsDef = story.controls
		if story.vide then
			kind = "vide"
		elseif type(story.render) == "function" then
			kind = "generic"
		elseif story.react or story.roact or story.reactRoblox or story.fusion or story.iris then
			kind = "unsupported"
			report({ message = "Forge's UI preview runs Vide, generic (render) and function stories; React, Roact, Fusion and Iris stories need Studio + UI Labs.", traceback = "" })
		else
			kind = "unsupported"
			report({ message = "Not a UI Labs story: return a function, or a table with vide + story, or render.", traceback = "" })
		end
	else
		report({ message = `Story module returned a {type(story)}`, traceback = "" })
	end
	emit({ type = "story", kind = kind, file = storyFile, controls = Gui.parseControls(controlsDef), path = World.fullName(storyModule) })
end

local target = host.target

if kind == "vide" then
	local vide = story.vide
	local ok, info = xpcall(function()
		local controls = {}
		local sourceRoot = vide.root(function(destroy)
			for key, control in controlsDef or {} do
				if type(control) == "table" and control.EntryType == "ControlGroup" then
					controls[key] = {}
					sources[key] = {}
					for inner, c in control.Controls or {} do
						local s = vide.source(Gui.controlValue(c, initialValues[valueKey(key, inner)]))
						controls[key][inner] = s
						sources[key][inner] = s
					end
				else
					local s = vide.source(Gui.controlValue(control, initialValues[key]))
					controls[key] = s
					sources[""] = sources[""] or {}
					sources[""][key] = s
				end
			end
			return destroy
		end)
		cleanup = vide.mount(function()
			return story.story({ controls = controls, target = target })
		end, target)
		local _ = sourceRoot
	end, traceback)
	if not ok then
		report(info)
	end
elseif kind == "function" then
	local ok, info = xpcall(function()
		cleanup = story(target)
	end, traceback)
	if not ok then
		report(info)
	end
elseif kind == "generic" then
	local ok, info = xpcall(function()
		cleanup = story.render({
			target = target,
			controls = plainValues(),
			converted = controlsDef or {},
			subscribe = function(listener)
				table.insert(genericListeners, listener)
				return function()
					local i = table.find(genericListeners, listener)
					if i then
						table.remove(genericListeners, i)
					end
				end
			end,
		})
	end, traceback)
	if not ok then
		report(info)
	end
end
local _ = cleanup

local function setControl(msg)
	local key, group = msg.key, msg.group
	initialValues[valueKey(group, key)] = msg.value
	local def = controlDef(group, key)
	local value = Gui.controlValue(def, msg.value)
	if kind == "vide" then
		local bucket = sources[group or ""]
		local source = bucket and bucket[key]
		if source then
			local ok, info = xpcall(function()
				source(value)
			end, traceback)
			if not ok then
				report(info)
			end
		end
	elseif kind == "generic" then
		local values = plainValues()
		for _, listener in table.clone(genericListeners) do
			local ok, info = xpcall(listener, traceback, values, { [key] = { new = value } })
			if not ok then
				report(info)
			end
		end
	end
end

---------------------------------------------------------------------------------------------------
-- Input and the frame loop

local running = true

task.spawn(function()
	while running do
		local line = stdio.readLine()
		if line == nil or line == "" then
			running = false
			break
		end
		local ok, msg = pcall(serde.decode, "json", line)
		if ok and type(msg) == "table" then
			if msg.type == "quit" then
				running = false
				break
			elseif msg.type == "control" then
				setControl(msg)
			else
				local handled, info = xpcall(function()
					return host:input(msg)
				end, traceback)
				if not handled then
					report(info)
				end
			end
		end
	end
end)

-- Module files the story loaded, for hot reload (Forge restarts when one of them is saved).
local sentModules = 0
local function emitModules()
	local files = {}
	for inst in world.cache do
		local file = world:fileOf(inst)
		if file then
			table.insert(files, file)
		end
	end
	if #files ~= sentModules then
		sentModules = #files
		table.sort(files)
		emit({ type = "modules", files = files })
	end
end

local started = os.clock()
local frames = 0
local announced = false
host:flush()
while running do
	local dt = task.wait(1 / 60)
	world:step(dt)
	host:stepTweens(dt)
	-- Vide's Heartbeat handler defers its step: let deferred work run before flushing.
	task.wait()
	frames += 1
	if frames == 1 or frames % 30 == 0 then
		emitModules()
	end
	local sent = host:flush()
	if sent > 0 or not announced then
		announced = true
		emit({ type = "frame", n = frames })
	end
	if options.duration and os.clock() - started >= options.duration then
		break
	end
end
host:flush()
process.exit(0)
