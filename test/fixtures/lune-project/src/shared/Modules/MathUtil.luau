--!strict
-- Small pure helpers used by the sample specs.
local MathUtil = {}

function MathUtil.clamp(value: number, min: number, max: number): number
	if value < min then
		return min
	elseif value > max then
		return max
	end
	return value
end

function MathUtil.sum(list: { number }): number
	local total = 0
	for _, n in list do
		total += n
	end
	return total
end

function MathUtil.split(text: string, sep: string): { string }
	local out = {}
	for part in string.gmatch(text, "([^" .. sep .. "]+)") do
		table.insert(out, part)
	end
	return out
end

return MathUtil
