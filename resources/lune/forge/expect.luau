--!nocheck
-- expect() for Forge specs. Jest-style matchers, callable with `:` or `.`:
--   expect(x):toBe(y)  expect(x).toBe(y)  expect(x).never.toBe(y)
-- plus TestEZ-style chains (expect(x).to.equal(y), .to.be.ok(), .to.never.throw()).
-- Failures raise at the spec's line, so the runner can report it.

local World = require("./world")

local typeofValue = World.typeof

local function formatValue(value, depth: number?, seen): string
	depth = depth or 0
	local kind = typeofValue(value)
	if kind == "string" then
		return string.format("%q", value)
	elseif kind == "Instance" then
		return `Instance({World.fullName(value)})`
	elseif type(value) ~= "table" then
		return tostring(value)
	end
	seen = seen or {}
	if seen[value] then
		return "<cycle>"
	end
	if depth >= 3 then
		return "{...}"
	end
	seen[value] = true
	local parts = {}
	local count = 0
	local isArray = #value > 0
	if isArray then
		for i, v in ipairs(value) do
			count += 1
			if count > 10 then
				table.insert(parts, "...")
				break
			end
			table.insert(parts, formatValue(v, depth + 1, seen))
		end
	end
	local keys = {}
	for k in value do
		if not (isArray and type(k) == "number" and k >= 1 and k <= #value and k % 1 == 0) then
			table.insert(keys, k)
		end
	end
	table.sort(keys, function(a, b)
		return tostring(a) < tostring(b)
	end)
	for _, k in keys do
		count += 1
		if count > 10 then
			table.insert(parts, "...")
			break
		end
		local key = if type(k) == "string" and string.match(k, "^[%a_][%w_]*$") then k else "[" .. formatValue(k, depth + 1, seen) .. "]"
		table.insert(parts, key .. " = " .. formatValue(value[k], depth + 1, seen))
	end
	seen[value] = nil
	return "{" .. table.concat(parts, ", ") .. "}"
end

-- Returns nil when equal, or the path and the two differing values.
local function deepDiff(a, b, path: string, seen)
	if a == b then
		return nil
	end
	if type(a) ~= "table" or type(b) ~= "table" or World.isInstance(a) or World.isInstance(b) then
		return { path = path, a = a, b = b }
	end
	seen = seen or {}
	if seen[a] == b then
		return nil
	end
	seen[a] = b
	for k, v in a do
		local child = path .. (if type(k) == "string" then "." .. k else "[" .. tostring(k) .. "]")
		local diff = deepDiff(v, b[k], child, seen)
		if diff then
			return diff
		end
	end
	for k, v in b do
		if a[k] == nil then
			local child = path .. (if type(k) == "string" then "." .. k else "[" .. tostring(k) .. "]")
			return { path = child, a = nil, b = v }
		end
	end
	return nil
end

local function lengthOf(value)
	if type(value) == "string" then
		return #value
	end
	if type(value) == "table" then
		return #value
	end
	return nil
end

-- Mock functions: forge.fn(impl?) records calls; use with toHaveBeenCalled*.
local mocks = setmetatable({}, { __mode = "k" })

local function mockFn(impl)
	local record = { calls = {} }
	local mock = setmetatable({}, {
		__call = function(_, ...)
			table.insert(record.calls, table.pack(...))
			if record.impl then
				return record.impl(...)
			end
			return nil
		end,
		__index = function(_, key)
			if key == "calls" then
				return record.calls
			end
			return nil
		end,
	})
	record.impl = impl
	mocks[mock] = record
	return mock
end

local function argsEqual(packed, expected)
	if packed.n ~= expected.n then
		return false
	end
	for i = 1, packed.n do
		if deepDiff(packed[i], expected[i], "") then
			return false
		end
	end
	return true
end

-- Each matcher returns pass, message (for a failed positive), negatedMessage (for a failed `never`).
local matchers = {}

function matchers.toBe(actual, expected)
	return actual == expected, `expected {formatValue(actual)} to be {formatValue(expected)}`, `expected {formatValue(actual)} not to be {formatValue(expected)}`
end

function matchers.toEqual(actual, expected)
	local diff = deepDiff(actual, expected, "")
	local message = `expected {formatValue(actual)} to equal {formatValue(expected)}`
	if diff and diff.path ~= "" then
		message ..= ` (at {diff.path}: got {formatValue(diff.a)}, wanted {formatValue(diff.b)})`
	end
	return diff == nil, message, `expected {formatValue(actual)} not to equal {formatValue(expected)}`
end

function matchers.toBeNil(actual)
	return actual == nil, `expected {formatValue(actual)} to be nil`, "expected value not to be nil"
end

function matchers.toBeTruthy(actual)
	return not not actual, `expected {formatValue(actual)} to be truthy`, `expected {formatValue(actual)} to be falsy`
end

function matchers.toBeFalsy(actual)
	return not actual, `expected {formatValue(actual)} to be falsy`, `expected {formatValue(actual)} to be truthy`
end

function matchers.toBeA(actual, typeName)
	local kind = typeofValue(actual)
	return kind == typeName, `expected a {typeName}, got {kind} {formatValue(actual)}`, `expected {formatValue(actual)} not to be a {typeName}`
end

function matchers.toThrow(actual, expected)
	if type(actual) ~= "function" and not mocks[actual] then
		return false, "toThrow expects a function", "toThrow expects a function"
	end
	local ok, err = pcall(actual)
	if ok then
		return false, "expected function to throw", "expected function not to throw"
	end
	local message = tostring(err)
	if expected ~= nil and not string.find(message, tostring(expected), 1, true) then
		return false, `expected error containing {formatValue(expected)}, got {formatValue(message)}`, `expected error not containing {formatValue(expected)}`
	end
	return true, "", `expected function not to throw, but it threw {formatValue(message)}`
end

function matchers.toContain(actual, item)
	local found = false
	if type(actual) == "string" then
		found = string.find(actual, tostring(item), 1, true) ~= nil
	elseif type(actual) == "table" then
		for _, v in actual do
			if v == item or deepDiff(v, item, "") == nil then
				found = true
				break
			end
		end
	end
	return found, `expected {formatValue(actual)} to contain {formatValue(item)}`, `expected {formatValue(actual)} not to contain {formatValue(item)}`
end

function matchers.toMatch(actual, pattern)
	local found = type(actual) == "string" and string.find(actual, pattern) ~= nil
	return found, `expected {formatValue(actual)} to match pattern {formatValue(pattern)}`, `expected {formatValue(actual)} not to match pattern {formatValue(pattern)}`
end

function matchers.toHaveLength(actual, length)
	local n = lengthOf(actual)
	return n == length, `expected length {length}, got {tostring(n)}`, `expected length not to be {length}`
end

function matchers.toBeCloseTo(actual, expected, digits)
	local tolerance = 10 ^ -(digits or 2) / 2
	local pass = type(actual) == "number" and math.abs(actual - expected) < tolerance
	return pass, `expected {formatValue(actual)} to be close to {expected} (±{tolerance})`, `expected {formatValue(actual)} not to be close to {expected}`
end

function matchers.toBeGreaterThan(actual, n)
	return actual > n, `expected {formatValue(actual)} > {n}`, `expected {formatValue(actual)} not > {n}`
end

function matchers.toBeGreaterThanOrEqual(actual, n)
	return actual >= n, `expected {formatValue(actual)} >= {n}`, `expected {formatValue(actual)} not >= {n}`
end

function matchers.toBeLessThan(actual, n)
	return actual < n, `expected {formatValue(actual)} < {n}`, `expected {formatValue(actual)} not < {n}`
end

function matchers.toBeLessThanOrEqual(actual, n)
	return actual <= n, `expected {formatValue(actual)} <= {n}`, `expected {formatValue(actual)} not <= {n}`
end

local function callsOf(actual)
	local record = mocks[actual]
	if not record then
		error("expected a mock made with forge.fn()", 4)
	end
	return record.calls
end

function matchers.toHaveBeenCalled(actual)
	local n = #callsOf(actual)
	return n > 0, "expected mock to have been called", `expected mock not to have been called, but it was called {n} time(s)`
end

function matchers.toHaveBeenCalledTimes(actual, times)
	local n = #callsOf(actual)
	return n == times, `expected mock to be called {times} time(s), got {n}`, `expected mock not to be called {times} time(s)`
end

function matchers.toHaveBeenCalledWith(actual, ...)
	local expected = table.pack(...)
	for _, call in callsOf(actual) do
		if argsEqual(call, expected) then
			return true, "", "expected mock not to have been called with those arguments"
		end
	end
	local args = {}
	for i = 1, expected.n do
		args[i] = formatValue(expected[i])
	end
	return false, `expected mock to have been called with ({table.concat(args, ", ")})`, ""
end

-- TestEZ names
local testez = {
	equal = "toBe",
	ok = "toBeTruthy",
	a = "toBeA",
	an = "toBeA",
	throw = "toThrow",
	contain = "toContain",
	match = "toMatch",
}

local function near(actual, expected, limit)
	limit = limit or 1e-7
	return math.abs(actual - expected) <= limit, `expected {formatValue(actual)} to be near {expected} (±{limit})`, `expected {formatValue(actual)} not to be near {expected}`
end

local function expect(actual)
	local negate = false
	local obj = {}
	local function wrap(impl)
		return function(first, ...)
			local pass, message, negated
			if rawequal(first, obj) then
				pass, message, negated = impl(actual, ...)
			else
				pass, message, negated = impl(actual, first, ...)
			end
			if (not not pass) == negate then
				error(if negate then negated else message, 2)
			end
			return obj
		end
	end
	setmetatable(obj, {
		__index = function(_, key)
			if key == "never" or key == "Not" then
				negate = not negate
				return obj
			end
			if key == "to" or key == "be" or key == "been" or key == "have" then
				return obj
			end
			if key == "near" then
				return wrap(near)
			end
			if key == "ok" then
				-- TestEZ's ok means "not nil", unlike toBeTruthy.
				return wrap(function(value)
					return value ~= nil, `expected value to be ok (not nil), got nil`, `expected {formatValue(value)} to be nil`
				end)
			end
			local name = testez[key] or key
			local impl = matchers[name]
			if impl then
				return wrap(impl)
			end
			error(`expect(): unknown matcher {tostring(key)}`, 2)
		end,
	})
	return obj
end

return {
	expect = expect,
	fn = mockFn,
	format = formatValue,
	deepEqual = function(a, b)
		return deepDiff(a, b, "") == nil
	end,
}
