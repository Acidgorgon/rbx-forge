local Janitor = {}
function Janitor.new()
	return setmetatable({}, Janitor)
end
-- AddItem appears here too, but Packages are skipped by default
function Janitor:AddItem() end
return Janitor
