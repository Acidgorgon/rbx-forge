local HudController = require(script.Parent.HudController)

describe("HudController", function()
	it("runs as the client with a LocalPlayer", function()
		expect(forge.realm):toBe("client")
		expect(HudController.playerName()):toBe("Player1")
	end)
end)
