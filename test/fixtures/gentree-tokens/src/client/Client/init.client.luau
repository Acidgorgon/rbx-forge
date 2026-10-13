local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ModuleLoader = require(ReplicatedStorage.Shared.Modules.ModuleLoader)

ModuleLoader.InitFolder(script.Controllers)
