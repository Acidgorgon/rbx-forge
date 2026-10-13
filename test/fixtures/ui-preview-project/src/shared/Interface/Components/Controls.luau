-- The UI Labs utility package's control constructors (pepeeltoro41/ui-labs, MIT), reduced to the
-- shapes they return, so this fixture needs no extra package: { EntryType, Type, ControlValue, ... }.
local Controls = {}

function Controls.Slider(def: number, min: number, max: number, step: number?)
	return { EntryType = "Control", Type = "Slider", ControlValue = def, Min = min, Max = max, Step = step }
end

function Controls.Choose(list: { any }, def: number?)
	return { EntryType = "Control", Type = "Choose", ControlValue = list[def or 1], List = list, DefIndex = def or 1 }
end

function Controls.Boolean(def: boolean)
	return { EntryType = "Control", Type = "Boolean", ControlValue = def }
end

return Controls
