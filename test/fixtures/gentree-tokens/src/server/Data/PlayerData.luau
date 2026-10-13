local PlayerData = {}

PlayerData.Template = { Coins = 0, Inventory = {} }

PlayerData.Get = function(player: Player)
	return PlayerData.Template
end

return PlayerData
