-- Top-level tests/ specs are not Rojo-mapped; Forge places them under game.ForgeTests.
local ReplicatedStorage = game:GetService("ReplicatedStorage")

describe("world shim", function()
	it("resolves instance paths and datatypes", function()
		expect(ReplicatedStorage.Shared.Modules.MathUtil:IsA("ModuleScript")):toBe(true)
		expect(typeof(Vector3.new(1, 2, 3))):toBe("Vector3")
		expect(Vector3.new(1, 2, 3) + Vector3.new(1, 1, 1)):toBe(Vector3.new(2, 3, 4))
	end)

	it("creates instances and fires signals", function()
		local folder = Instance.new("Folder")
		folder.Name = "Bag"
		folder.Parent = workspace
		local event = Instance.new("BindableEvent")
		local got = forge.fn()
		event.Event:Connect(got)
		event:Fire("hi", 2)
		expect(got).toHaveBeenCalledWith("hi", 2)
		expect(workspace:FindFirstChild("Bag")).toBe(folder)
		expect(workspace.Bag:GetFullName()).toBe("Workspace.Bag")
	end)

	it.todo("documents a test still to write")
end)
