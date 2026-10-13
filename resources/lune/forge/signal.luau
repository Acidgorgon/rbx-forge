--!nocheck
-- RBXScriptSignal / RBXScriptConnection stand-ins. Handlers run immediately through Lune's
-- task.spawn, like Roblox's immediate signal mode. :Fire is a Forge extra for tests.

local task = require("@lune/task")

local kinds = setmetatable({}, { __mode = "k" })

local Connection = {}
Connection.__index = Connection

function Connection:Disconnect()
	if not self.Connected then
		return
	end
	self.Connected = false
	local handlers = self._signal._handlers
	local index = table.find(handlers, self)
	if index then
		table.remove(handlers, index)
	end
end

Connection.disconnect = Connection.Disconnect

local Signal = {}
Signal.__index = Signal
Signal.__tostring = function(self)
	return "Signal " .. (self._name or "")
end

function Signal.new(name: string?)
	local self = setmetatable({ _handlers = {}, _waiting = {}, _name = name }, Signal)
	kinds[self] = "RBXScriptSignal"
	return self
end

local function callable(value): boolean
	if type(value) == "function" then
		return true
	end
	local mt = getmetatable(value)
	return type(mt) == "table" and mt.__call ~= nil
end

function Signal:Connect(fn)
	if not callable(fn) then
		error("Attempt to connect failed: Passed value is not a function", 2)
	end
	local handler = if type(fn) == "function" then fn else function(...)
		return fn(...)
	end
	local connection = setmetatable({ Connected = true, _fn = handler, _signal = self }, Connection)
	kinds[connection] = "RBXScriptConnection"
	table.insert(self._handlers, connection)
	return connection
end

Signal.ConnectParallel = Signal.Connect
Signal.connect = Signal.Connect

function Signal:Once(fn)
	local connection
	connection = self:Connect(function(...)
		connection:Disconnect()
		fn(...)
	end)
	return connection
end

function Signal:Wait()
	table.insert(self._waiting, coroutine.running())
	return coroutine.yield()
end

-- Fires every handler (and resumes :Wait callers) with the arguments.
function Signal:Fire(...)
	for _, connection in table.clone(self._handlers) do
		if connection.Connected then
			task.spawn(connection._fn, ...)
		end
	end
	local waiting = self._waiting
	self._waiting = {}
	for _, thread in waiting do
		task.spawn(thread, ...)
	end
end

function Signal:DisconnectAll()
	for _, connection in table.clone(self._handlers) do
		connection:Disconnect()
	end
end

function Signal:HandlerCount(): number
	return #self._handlers
end

return {
	new = Signal.new,
	kinds = kinds,
}
