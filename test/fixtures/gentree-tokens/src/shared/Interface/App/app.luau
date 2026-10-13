local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Vide = require(ReplicatedStorage.Packages.Vide)

local create = Vide.create

local function app()
	return create("ScreenGui")({
		Name = "HUD",
		ResetOnSpawn = false,
		IgnoreGuiInset = true,
	})
end

return app
