--!nocheck
-- describe / it / hooks for one spec file. Collection runs the spec's describe blocks right away
-- (like Jest); run() then executes the collected tests in order, each in its own thread with a
-- timeout, and reports results through `report`.

local task = require("@lune/task")
local Expect = require("./expect")

export type TestResult = {
	suite: string,
	test: string,
	status: "pass" | "fail" | "skip" | "todo",
	ms: number,
	error: { message: string, line: number?, stack: string? }?,
}

local Testkit = {}
Testkit.__index = Testkit

local function newSuite(name: string, parent)
	return {
		name = name,
		parent = parent,
		children = {}, -- ordered list of { kind = "suite" | "test", ... }
		beforeAll = {},
		afterAll = {},
		beforeEach = {},
		afterEach = {},
		skip = parent and parent.skip or false,
		only = false,
	}
end

-- options: { file = "src/x.spec.luau", timeoutMs = 5000, filter = "name" or nil }
function Testkit.new(options)
	local self = setmetatable({}, Testkit)
	self.file = options.file
	self.timeoutMs = options.timeoutMs or 5000
	self.filter = options.filter
	self.root = newSuite("", nil)
	self.current = self.root
	self.hasOnly = false
	return self
end

function Testkit:_addTest(name: string, fn, mode: string?)
	if type(name) ~= "string" then
		error("it(name, fn): name must be a string", 3)
	end
	local test = {
		kind = "test",
		name = name,
		fn = fn,
		suite = self.current,
		skip = mode == "skip" or self.current.skip,
		todo = mode == "todo" or fn == nil,
		only = mode == "only",
	}
	if test.only then
		self.hasOnly = true
	end
	table.insert(self.current.children, test)
end

function Testkit:_addSuite(name: string, fn, mode: string?)
	if type(fn) ~= "function" then
		error("describe(name, fn): fn must be a function", 3)
	end
	local suite = newSuite(tostring(name), self.current)
	suite.skip = suite.skip or mode == "skip"
	suite.only = mode == "only"
	if suite.only then
		self.hasOnly = true
	end
	table.insert(self.current.children, { kind = "suite", suite = suite })
	local previous = self.current
	self.current = suite
	local ok, err = pcall(fn)
	self.current = previous
	if not ok then
		error(err, 0)
	end
end

-- Globals a spec sees: describe/it/test/expect/hooks, TestEZ aliases, and `forge` helpers.
function Testkit:globals(world)
	local kit = self
	local function it(name, fn)
		kit:_addTest(name, fn)
	end
	local itTable = setmetatable({
		skip = function(name, fn)
			kit:_addTest(name, fn, "skip")
		end,
		only = function(name, fn)
			kit:_addTest(name, fn, "only")
		end,
		todo = function(name)
			kit:_addTest(name, nil, "todo")
		end,
	}, {
		__call = function(_, name, fn)
			kit:_addTest(name, fn)
		end,
	})
	local describeTable = setmetatable({
		skip = function(name, fn)
			kit:_addSuite(name, fn, "skip")
		end,
		only = function(name, fn)
			kit:_addSuite(name, fn, "only")
		end,
	}, {
		__call = function(_, name, fn)
			kit:_addSuite(name, fn)
		end,
	})
	local function hook(list)
		return function(fn)
			table.insert(kit.current[list], fn)
		end
	end
	return {
		describe = describeTable,
		it = itTable,
		test = itTable,
		expect = Expect.expect,
		beforeAll = hook("beforeAll"),
		afterAll = hook("afterAll"),
		beforeEach = hook("beforeEach"),
		afterEach = hook("afterEach"),
		-- TestEZ aliases
		itSKIP = itTable.skip,
		itFOCUS = itTable.only,
		itFIXME = function(name)
			kit:_addTest(name, nil, "todo")
		end,
		describeSKIP = describeTable.skip,
		describeFOCUS = describeTable.only,
		xit = itTable.skip,
		xdescribe = describeTable.skip,
		fit = itTable.only,
		fdescribe = describeTable.only,
		forge = {
			fn = Expect.fn,
			format = Expect.format,
			deepEqual = Expect.deepEqual,
			realm = world.realm,
			world = world,
			-- Simulates a player joining (fires Players.PlayerAdded) and returns it.
			addPlayer = function(name, userId)
				return world:addPlayer(name, userId)
			end,
			removePlayer = function(player)
				world:removePlayer(player)
			end,
			-- Fires RunService frame signals once (Heartbeat etc.) with dt.
			step = function(dt)
				world:step(dt)
			end,
			-- A Janitor-shaped stand-in for Init(janitor): records what was added; :Cleanup() runs them.
			janitor = function()
				local items = {}
				local janitor = {}
				function janitor:Add(item, method)
					table.insert(items, { item = item, method = method })
					return item
				end
				function janitor:Cleanup()
					for i = #items, 1, -1 do
						local entry = items[i]
						local item = entry.item
						if type(item) == "function" then
							item()
						elseif type(item) == "table" or type(item) == "userdata" then
							local name = entry.method or (if item.Destroy then "Destroy" elseif item.Disconnect then "Disconnect" else nil)
							if name and item[name] then
								item[name](item)
							end
						end
					end
					table.clear(items)
				end
				janitor.Destroy = janitor.Cleanup
				janitor.items = items
				return janitor
			end,
		},
	}
end

local function suitePath(suite): { string }
	local names = {}
	local current = suite
	while current and current.parent do
		table.insert(names, 1, current.name)
		current = current.parent
	end
	return names
end

local function suiteName(suite): string
	return table.concat(suitePath(suite), " > ")
end

local function fullTestName(test): string
	local suite = suiteName(test.suite)
	return if suite == "" then test.name else suite .. " > " .. test.name
end

local function isFocused(test): boolean
	if test.only then
		return true
	end
	local current = test.suite
	while current do
		if current.only then
			return true
		end
		current = current.parent
	end
	return false
end

-- Turns "src/a.spec.luau:12: boom" into message "boom" and line 12 (when the path is our file),
-- and keeps only project frames of the traceback.
function Testkit:_parseError(err, traceback: string?)
	local message = if type(err) == "string" then err else Expect.format(err)
	-- Lune appends its own traceback to some errors (syntax errors from luau.load); drop it.
	message = string.gsub(message, "\n%s*stack traceback:.*$", "")
	message = string.gsub(message, "\n%[Stack Begin%].*$", "")
	local line
	local escaped = string.gsub(self.file, "[%-%.%+%[%]%(%)%$%^%%%?%*]", "%%%0")
	local prefixLine, rest = string.match(message, "^" .. escaped .. ":(%d+): (.*)$")
	if prefixLine then
		line = tonumber(prefixLine)
		message = rest
	end
	local frames = {}
	if traceback then
		for frame in string.gmatch(traceback, "[^\n]+") do
			if not string.find(frame, "forge/", 1, true) and not string.find(frame, "[C]", 1, true) and string.match(frame, "^[^%s].-:%d+") then
				table.insert(frames, frame)
				if not line then
					local found = string.match(frame, "^" .. escaped .. ":(%d+)")
					if found then
						line = tonumber(found)
					end
				end
			end
			if #frames >= 6 then
				break
			end
		end
	end
	if not line then
		local found = string.match(message, escaped .. ":(%d+)")
		if found then
			line = tonumber(found)
		end
	end
	return { message = message, line = line, stack = if #frames > 0 then table.concat(frames, "\n") else nil }
end

-- Runs fn in its own thread; returns ok, errorInfo. Times out after timeoutMs.
function Testkit:_runGuarded(fn): (boolean, any)
	local done, ok, info = false, true, nil
	local kit = self
	local thread = task.spawn(function()
		local success, err = xpcall(fn, function(e)
			return { err = e, traceback = debug.traceback() }
		end)
		if not success then
			ok = false
			info = kit:_parseError(err.err, err.traceback)
		end
		done = true
	end)
	local started = os.clock()
	while not done do
		if (os.clock() - started) * 1000 >= self.timeoutMs then
			pcall(task.cancel, thread)
			return false, { message = `timed out after {self.timeoutMs} ms` }
		end
		task.wait()
	end
	return ok, info
end

-- report(result) is called for each test as it finishes.
function Testkit:run(report)
	local kit = self
	local exactFilter = false
	if self.filter then
		local function scan(suite)
			for _, child in suite.children do
				if child.kind == "test" then
					if fullTestName(child) == kit.filter or child.name == kit.filter then
						exactFilter = true
					end
				else
					scan(child.suite)
				end
			end
		end
		scan(self.root)
	end

	local function selected(test): boolean
		if self.hasOnly and not isFocused(test) then
			return false
		end
		if self.filter then
			local name = fullTestName(test)
			if exactFilter then
				return name == self.filter or test.name == self.filter
			end
			return string.find(name, self.filter, 1, true) ~= nil
		end
		return true
	end

	local function hasSelected(suite): boolean
		for _, child in suite.children do
			if child.kind == "test" then
				if selected(child) then
					return true
				end
			elseif hasSelected(child.suite) then
				return true
			end
		end
		return false
	end

	local function eachHooks(suite, list: string, reverse: boolean)
		local chain = {}
		local current = suite
		while current do
			table.insert(chain, 1, current)
			current = current.parent
		end
		if reverse then
			local out = {}
			for i = #chain, 1, -1 do
				table.insert(out, chain[i])
			end
			chain = out
		end
		local hooks = {}
		for _, s in chain do
			for _, fn in s[list] do
				table.insert(hooks, fn)
			end
		end
		return hooks
	end

	local function runTest(test)
		local result = { suite = suiteName(test.suite), test = test.name, status = "pass", ms = 0 }
		if test.todo then
			result.status = "todo"
			report(result)
			return
		end
		if test.skip then
			result.status = "skip"
			report(result)
			return
		end
		if kit.onTestStart then
			kit.onTestStart(fullTestName(test))
		end
		local started = os.clock()
		local ok, info = true, nil
		for _, hook in eachHooks(test.suite, "beforeEach", false) do
			ok, info = kit:_runGuarded(hook)
			if not ok then
				info.message = "beforeEach: " .. info.message
				break
			end
		end
		if ok then
			ok, info = kit:_runGuarded(test.fn)
		end
		for _, hook in eachHooks(test.suite, "afterEach", true) do
			local hookOk, hookInfo = kit:_runGuarded(hook)
			if ok and not hookOk then
				ok, info = false, hookInfo
				info.message = "afterEach: " .. info.message
			end
		end
		result.ms = math.floor((os.clock() - started) * 100000 + 0.5) / 100
		if not ok then
			result.status = "fail"
			result.error = info
		end
		report(result)
	end

	local function runSuite(suite)
		if not hasSelected(suite) then
			return
		end
		local setupOk, setupInfo = true, nil
		if not suite.skip then
			for _, hook in suite.beforeAll do
				setupOk, setupInfo = kit:_runGuarded(hook)
				if not setupOk then
					setupInfo.message = "beforeAll: " .. setupInfo.message
					break
				end
			end
		end
		for _, child in suite.children do
			if child.kind == "test" then
				if selected(child) then
					if setupOk then
						runTest(child)
					else
						report({ suite = suiteName(suite), test = child.name, status = "fail", ms = 0, error = setupInfo })
					end
				end
			else
				runSuite(child.suite)
			end
		end
		if not suite.skip then
			for _, hook in suite.afterAll do
				local ok, info = kit:_runGuarded(hook)
				if not ok then
					info.message = "afterAll: " .. info.message
					report({ suite = suiteName(suite), test = "(afterAll)", status = "fail", ms = 0, error = info })
				end
			end
		end
	end

	runSuite(self.root)
end

function Testkit:countSelected(): number
	local n = 0
	local function walk(suite)
		for _, child in suite.children do
			if child.kind == "test" then
				n += 1
			else
				walk(child.suite)
			end
		end
	end
	walk(self.root)
	return n
end

Testkit.parseError = Testkit._parseError

return Testkit
