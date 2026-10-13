-- A minimal Vide story: a button that counts clicks (used by Forge's UI preview end-to-end test).
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Vide = require(ReplicatedStorage.Packages.Vide)
local create = Vide.create
local source = Vide.source

local controls = {
	Label = "Clicks",
	Accent = Color3.fromRGB(0, 170, 255),
}

return {
	vide = Vide,
	controls = controls,
	story = function(props)
		local count = source(0)
		return create "TextButton" {
			Name = "CounterButton",
			AnchorPoint = Vector2.new(0.5, 0.5),
			Position = UDim2.fromScale(0.5, 0.5),
			Size = UDim2.fromOffset(220, 64),
			BackgroundColor3 = props.controls.Accent,
			TextColor3 = Color3.new(1, 1, 1),
			TextSize = 24,
			Font = Enum.Font.GothamBold,
			Text = function()
				return `{props.controls.Label()}: {count()}`
			end,
			Activated = function()
				count(count() + 1)
			end,

			create "UICorner" { CornerRadius = UDim.new(0, 12) },
		}
	end,
}
