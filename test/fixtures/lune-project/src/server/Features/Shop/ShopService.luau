-- GenTree-style service: Init(janitor) / Start, requires a sibling and a shared module.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local MathUtil = require(ReplicatedStorage.Shared.Modules.MathUtil)
local Prices = require(script.Parent.Prices)

local ShopService = {}
ShopService.Coins = {} :: { [number]: number }

function ShopService:Init(janitor)
	janitor:Add(Players.PlayerAdded:Connect(function(player)
		self.Coins[player.UserId] = 100
	end))
	janitor:Add(Players.PlayerRemoving:Connect(function(player)
		self.Coins[player.UserId] = nil
	end))
end

function ShopService:Start()
	assert(RunService:IsServer(), "ShopService runs on the server")
end

function ShopService:Buy(player, item: string): boolean
	local price = Prices[item]
	if not price then
		error("unknown item " .. item)
	end
	local coins = self.Coins[player.UserId] or 0
	if coins < price then
		return false
	end
	self.Coins[player.UserId] = MathUtil.clamp(coins - price, 0, math.huge)
	return true
end

return ShopService
