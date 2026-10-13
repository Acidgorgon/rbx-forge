--!nocheck
--> RBX Forge test runner: runs *.spec.luau files against a Roblox-like world under Lune.
--
-- Usage (from the project root):
--   lune run <path>/runner.luau -- [--sourcemap sourcemap.json] [--spec <file>]... [--name <test>]
--                                  [--timeout <ms>] [--realm server|client] [--format json|human|both]
--
-- --sourcemap  Rojo sourcemap (`rojo sourcemap default.project.json -o sourcemap.json`); RBX Forge
--              writes a fresh one from default.project.json for each run.
-- --spec       Spec file(s) relative to the project root. Default: every *.spec.luau in the tree.
-- --name       Only tests whose full name ("Suite > test") equals this, else contains it.
-- --timeout    Per-test timeout in ms (default 5000).
-- --realm      Force server or client. Default: client under StarterPlayer/StarterGui/ReplicatedFirst
--              (or a `--!forge realm=client` line at the top of the spec), else server.
-- --format     json: one JSON object per line ({"forge":1,"type":...}); human: summary only; both.
--
-- Exit code: 0 all passed, 1 a test failed, 2 the run could not start.

local fs = require("@lune/fs")
local process = require("@lune/process")
local serde = require("@lune/serde")
local stdio = require("@lune/stdio")

local World = require("./forge/world")
local Testkit = require("./forge/testkit")

local PROTOCOL = 1

local function parseArgs(argv)
	local options = { specs = {}, timeoutMs = 5000, format = "both", sourcemap = "sourcemap.json" }
	local i = 1
	-- `lune run script -- args` passes the `--` through to process.args; skip it.
	if argv[1] == "--" then
		i = 2
	end
	while i <= #argv do
		local arg = argv[i]
		local value = argv[i + 1]
		if arg == "--spec" then
			table.insert(options.specs, value)
			i += 2
		elseif arg == "--name" then
			options.name = value
			i += 2
		elseif arg == "--timeout" then
			options.timeoutMs = tonumber(value) or options.timeoutMs
			i += 2
		elseif arg == "--realm" then
			options.realm = value
			i += 2
		elseif arg == "--format" then
			options.format = value
			i += 2
		elseif arg == "--sourcemap" then
			options.sourcemap = value
			i += 2
		elseif arg == "--root" then
			options.root = value
			i += 2
		else
			-- A bare path is a spec file.
			table.insert(options.specs, arg)
			i += 1
		end
	end
	return options
end

local options = parseArgs(process.args)
local wantJson = options.format == "json" or options.format == "both"
local wantHuman = options.format == "human" or options.format == "both"

local function toPosix(path: string): string
	return (string.gsub(path, "\\", "/"))
end

local root = toPosix(options.root or process.cwd)
if string.sub(root, -1) ~= "/" then
	root ..= "/"
end

local function emit(event)
	if not wantJson then
		return
	end
	event.forge = PROTOCOL
	local ok, line = pcall(serde.encode, "json", event)
	if not ok then
		-- Non-UTF-8 text in a message: replace it rather than lose the event.
		for key, value in event do
			if type(value) == "string" then
				event[key] = string.gsub(value, "[\128-\255]", "?")
			end
		end
		if event.error and type(event.error.message) == "string" then
			event.error.message = string.gsub(event.error.message, "[\128-\255]", "?")
		end
		line = serde.encode("json", event)
	end
	stdio.write(line .. "\n")
end

local function human(text: string)
	if wantHuman then
		stdio.write(text .. "\n")
	end
end

local function relative(path: string): string
	path = toPosix(path)
	if string.sub(path, 1, #root) == root then
		path = string.sub(path, #root + 1)
	end
	return (string.gsub(path, "^%./", ""))
end

local function readTree()
	local path = options.sourcemap
	local full = if string.match(path, "^/") or string.match(path, "^%a:[/\\]") then path else root .. path
	if not fs.isFile(full) then
		return nil, `no sourcemap at {path}. Run: rojo sourcemap default.project.json -o sourcemap.json`
	end
	local ok, tree = pcall(function()
		return serde.decode("json", fs.readFile(full))
	end)
	if not ok or type(tree) ~= "table" then
		return nil, `could not read sourcemap {path}: {tostring(tree)}`
	end
	return tree
end

local function isSpecFile(path: string): boolean
	return string.match(path, "%.spec%.luau$") ~= nil or string.match(path, "%.spec%.lua$") ~= nil
end

-- Every spec file in the tree with its instance path, skipping Wally packages.
local function discover(tree)
	local found = {}
	local function walk(node, path)
		local here = table.clone(path)
		if node.className ~= "DataModel" then
			table.insert(here, node.name)
		end
		for _, file in node.filePaths or {} do
			local rel = relative(file)
			if isSpecFile(rel) and not string.match(rel, "^Packages/") and not string.match(rel, "^ServerPackages/") then
				table.insert(found, { file = rel, instancePath = here })
			end
		end
		for _, child in node.children or {} do
			walk(child, here)
		end
	end
	walk(tree, {})
	table.sort(found, function(a, b)
		return a.file < b.file
	end)
	return found
end

local CLIENT_ROOTS = { StarterPlayer = true, StarterGui = true, ReplicatedFirst = true, StarterPack = true }

local function realmFor(file: string, instancePath): string
	if options.realm then
		return options.realm
	end
	local ok, source = pcall(fs.readFile, root .. file)
	if ok then
		local header = string.sub(source, 1, 400)
		local forced = string.match(header, "%-%-!forge%s+realm=(%a+)") or string.match(header, "%-%-%s*forge:%s*realm=(%a+)")
		if forced == "client" or forced == "server" then
			return forced
		end
	end
	if instancePath and CLIENT_ROOTS[instancePath[1]] then
		return "client"
	end
	return "server"
end

local tree, treeError = readTree()
if not tree then
	emit({ type = "fatal", message = treeError })
	human("forge: " .. treeError)
	process.exit(2)
end

local all = discover(tree)
local byFile = {}
for _, spec in all do
	byFile[spec.file] = spec
end

local specs = {}
if #options.specs > 0 then
	for _, file in options.specs do
		local rel = relative(file)
		table.insert(specs, byFile[rel] or { file = rel, instancePath = nil })
	end
else
	specs = all
end

local files = {}
for _, spec in specs do
	table.insert(files, spec.file)
end
emit({ type = "start", files = files, filter = options.name })

local totals = { pass = 0, fail = 0, skip = 0, todo = 0 }
local failures = {}
local runStarted = os.clock()

for _, spec in specs do
	local file = spec.file
	local fileStarted = os.clock()
	local realm = realmFor(file, spec.instancePath)
	local results = {}
	local currentTest = nil

	local world = World.new({
		root = root,
		tree = tree,
		realm = realm,
		log = function(level, text)
			emit({ type = "log", file = file, test = currentTest, level = level, text = text })
			if wantHuman and not wantJson then
				human(`  | {text}`)
			end
		end,
	})

	emit({ type = "file", file = file, realm = realm, instancePath = spec.instancePath })

	local function report(result)
		result.type = "test"
		result.file = file
		emit(result)
		totals[result.status] += 1
		table.insert(results, result)
		if result.status == "fail" then
			table.insert(failures, result)
		end
	end

	local kit = Testkit.new({ file = file, timeoutMs = options.timeoutMs, filter = options.name })
	local inst = world:instanceForFile(file)
	if not inst then
		if not fs.isFile(root .. file) then
			report({ suite = "", test = "(load)", status = "fail", ms = 0, error = { message = `spec file not found: {file}` } })
			continue
		end
		-- A spec Rojo does not map: give it a ModuleScript under game.ForgeTests.
		local folder = world.game:FindFirstChild("ForgeTests") or world.globals.Instance.new("Folder", world.game)
		folder.Name = "ForgeTests"
		inst = world.globals.Instance.new("ModuleScript", folder)
		inst.Name = string.match(file, "([^/]+)%.luau?$") or file
		world.byFile[file] = inst
	end

	-- Collect: run the spec body (describe/it register tests). TestEZ specs return a function.
	local env = world:envFor(inst, file, kit:globals(world))
	local loadOk, loadInfo = kit:_runGuarded(function()
		local fn = world:compile(file, env)
		local returned = fn()
		if type(returned) == "function" then
			returned()
		end
	end)
	if not loadOk then
		loadInfo.message = "could not load spec: " .. loadInfo.message
		report({ suite = "", test = "(load)", status = "fail", ms = 0, error = loadInfo })
	else
		kit.onTestStart = function(name)
			currentTest = name
		end
		kit:run(function(result)
			currentTest = nil
			report(result)
		end)
	end

	local counts = { pass = 0, fail = 0, skip = 0, todo = 0 }
	for _, result in results do
		counts[result.status] += 1
	end
	local fileMs = math.floor((os.clock() - fileStarted) * 100000 + 0.5) / 100
	emit({ type = "fileEnd", file = file, passed = counts.pass, failed = counts.fail, skipped = counts.skip + counts.todo, ms = fileMs })

	human(`{if counts.fail > 0 then "FAIL" else "PASS"} {file} ({#results} test{if #results == 1 then "" else "s"}, {fileMs} ms)`)
	for _, result in results do
		if result.status == "fail" then
			local name = if result.suite ~= "" then result.suite .. " > " .. result.test else result.test
			local where = if result.error and result.error.line then ` (line {result.error.line})` else ""
			human(`  x {name}{where}`)
			if result.error then
				human("      " .. string.gsub(result.error.message, "\n", "\n      "))
			end
		end
	end
end

local totalMs = math.floor((os.clock() - runStarted) * 100000 + 0.5) / 100
emit({
	type = "end",
	passed = totals.pass,
	failed = totals.fail,
	skipped = totals.skip + totals.todo,
	files = #specs,
	ms = totalMs,
})

local parts = {}
if totals.fail > 0 then
	table.insert(parts, `{totals.fail} failed`)
end
table.insert(parts, `{totals.pass} passed`)
if totals.skip + totals.todo > 0 then
	table.insert(parts, `{totals.skip + totals.todo} skipped`)
end
human(`Tests: {table.concat(parts, ", ")}, {totals.pass + totals.fail + totals.skip + totals.todo} total in {#specs} file(s) ({totalMs} ms)`)

-- Exit now: modules may have left loops running (task.spawn/while true), which would keep Lune alive.
process.exit(if totals.fail > 0 then 1 else 0)
