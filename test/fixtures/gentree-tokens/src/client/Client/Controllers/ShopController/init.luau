local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Vide = require(ReplicatedStorage.Packages.Vide)

local ShopController = {}

--[[
function ShopController:Start()
end
]]

function ShopController:Init(janitor)
	self.Open = Vide.source(false)
end

function ShopController:Toggle()
	self.Open(not self.Open())
end

return ShopController
