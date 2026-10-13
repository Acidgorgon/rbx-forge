--!nocheck

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Janitor = require(ReplicatedStorage.Packages.Janitor)

local ModuleLoader = {}
ModuleLoader.Janitors = {}
ModuleLoader.Modules = {}

ModuleLoader.ClientLoaded = false

function ModuleLoader.InitFolder(Folder: Folder)
	if ModuleLoader.ClientLoaded then
		return
	end
	ModuleLoader.ClientLoaded = true

	for _, v in Folder:GetDescendants() do
		if v:IsA("ModuleScript") then
			local module = require(v)
			ModuleLoader.Modules[v.Name] = module
		end
	end

	for _, module in ModuleLoader.Modules do
		if type(module) == "table" and module.Init then
			local janitor = Janitor.new()
			ModuleLoader.Janitors[module] = janitor

			module:Init(janitor)
		end
	end

	for _, module in ModuleLoader.Modules do
		if type(module) == "table" and module.Start then
			task.spawn(function()
				module:Start()
			end)
		end
	end

	if RunService:IsClient() then
		local Player = Players.LocalPlayer

		local function OnCharacterAdded(Character: Model)
			for _, module in ModuleLoader.Modules do
				if type(module) == "table" and module.OnCharacterAdded then
					task.spawn(function()
						module:OnCharacterAdded(Character)
					end)
				end
			end
		end

		local function OnCharacterRemoving(Character: Model)
			for _, module in ModuleLoader.Modules do
				if type(module) == "table" and module.OnCharacterRemoving then
					task.spawn(function()
						module:OnCharacterRemoving(Character)
					end)
				end
			end
		end

		Player.CharacterAdded:Connect(OnCharacterAdded)
		Player.CharacterRemoving:Connect(OnCharacterRemoving)

		if Player.Character then
			task.spawn(OnCharacterAdded, Player.Character)
		end

		Players.PlayerRemoving:Connect(function(Leaver)
			if Leaver == Player then
				for _, janitor in ModuleLoader.Janitors do
					janitor:Destroy()
				end

				ModuleLoader.Janitors = {}
			end
		end)
	end
end

return ModuleLoader
