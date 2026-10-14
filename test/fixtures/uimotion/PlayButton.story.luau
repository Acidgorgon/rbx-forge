-- PlayButton: UI Labs story written by RBX Forge (Figma import / UI Motion Lab).
-- A generic story: runs in Forge's UI Preview and in UI Labs in Studio.
local Component = require(script.Parent.Parent.Components.PlayButton)
local Effects = require(script.Parent.Parent.Motion.PlayButtonEffects)

return {
	controls = { Motion = true },
	render = function(props)
		local ui = Component()
		ui.AnchorPoint = Vector2.new(0.5, 0.5)
		ui.Position = UDim2.fromScale(0.5, 0.5)
		ui.Parent = props.target
		local motion = if props.controls.Motion then Effects.attach(ui) else nil
		local unsubscribe = props.subscribe(function(values)
			if motion then
				motion.destroy()
				motion = nil
			end
			if values.Motion then
				motion = Effects.attach(ui)
			end
		end)
		return function()
			unsubscribe()
			if motion then
				motion.destroy()
			end
			ui:Destroy()
		end
	end,
}
