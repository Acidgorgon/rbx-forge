local ShopService = require(script.Parent.ShopService)

describe("ShopService", function()
	local janitor

	beforeEach(function()
		janitor = forge.janitor()
		ShopService:Init(janitor)
	end)

	afterEach(function()
		janitor:Cleanup()
		table.clear(ShopService.Coins)
	end)

	it("gives joining players 100 coins", function()
		local player = forge.addPlayer("Alice")
		task.wait() -- PlayerAdded handlers run on the scheduler
		expect(ShopService.Coins[player.UserId]):toBe(100)
	end)

	it("buys while the player can afford it", function()
		local player = forge.addPlayer("Bob")
		task.wait()
		expect(ShopService:Buy(player, "Sword")):toBe(true)
		expect(ShopService.Coins[player.UserId]):toBe(40)
		expect(ShopService:Buy(player, "Shield")):toBe(false)
	end)

	it("rejects unknown items", function()
		local player = forge.addPlayer("Cara")
		expect(function()
			ShopService:Buy(player, "Banana")
		end):toThrow("unknown item")
	end)

	it("starts on the server", function()
		expect(function()
			ShopService:Start()
		end).never.toThrow()
	end)
end)
