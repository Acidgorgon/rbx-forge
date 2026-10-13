local ReplicatedStorage = game:GetService("ReplicatedStorage")
local MathUtil = require(ReplicatedStorage.Shared.Modules.MathUtil)

describe("MathUtil", function()
	describe("clamp", function()
		it("keeps values inside the range", function()
			expect(MathUtil.clamp(5, 0, 10)):toBe(5)
		end)

		it("clamps below and above", function()
			expect(MathUtil.clamp(-1, 0, 10)):toBe(0)
			expect(MathUtil.clamp(11, 0, 10)):toBe(10)
		end)
	end)

	it("sums a list", function()
		expect(MathUtil.sum({ 1, 2, 3 })).toBe(6)
	end)

	it("splits text", function()
		expect(MathUtil.split("a,b,c", ",")):toEqual({ "a", "b", "c" })
		expect(MathUtil.split("a,b", ",")).never.toContain("c")
	end)
end)
