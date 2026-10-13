local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local HudController = {}

function HudController.playerName(): string
	assert(RunService:IsClient(), "client only")
	return Players.LocalPlayer.Name
end

return HudController
