local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerScriptService = game:GetService("ServerScriptService")
local Janitor = require(ReplicatedStorage.Packages.Janitor)
local Config = require(ReplicatedStorage.Shared.Features.Inventory)
local Events = require(ServerScriptService.Server.events.server)
local PlayerData = require(script.Parent.Parent.Parent.Data.PlayerData)

local InventoryService = {}
InventoryService.Inventories = {}

local function slotsFor(player: Player)
	return InventoryService.Inventories[player] or {}
end

function InventoryService:Init()
	self.Janitor = Janitor.new()
end

function InventoryService:Start()
	-- require inside a function is not a top-level dependency
	local Players = require(script.Parent.Lazy)
end

function InventoryService.AddItem(player: Player, item: string, count: number)
	local slots = slotsFor(player)
	if #slots >= Config.MaxSlots then
		return false
	end
	table.insert(slots, { item = item, count = count })
	Events.ItemAdded.Fire(player, item, count)
	return true
end

function InventoryService:GetItems(player: Player)
	return slotsFor(player)
end

return InventoryService
