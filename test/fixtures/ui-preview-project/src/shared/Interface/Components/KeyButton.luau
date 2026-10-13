-- A key-hint button: a small key cap ("Shift") and a label ("BOOST"). Hover brightens it.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Vide = require(ReplicatedStorage.Packages.Vide)
local Theme = require(script.Parent.Theme)

local create = Vide.create
local source = Vide.source

type Props = {
	Key: string,
	Label: string,
	Position: UDim2,
	Active: () -> boolean,
	OnClick: () -> (),
}

return function(props: Props)
	local hovered = source(false)
	return create "TextButton" {
		Name = props.Label .. "Button",
		AnchorPoint = Vector2.new(1, 1),
		Position = props.Position,
		Size = UDim2.fromOffset(118, 36),
		AutoButtonColor = false,
		Text = "",
		BackgroundColor3 = function()
			if props.Active() then
				return Theme.Accent
			end
			return if hovered() then Theme.Panel:Lerp(Color3.new(1, 1, 1), 0.08) else Theme.Panel
		end,
		MouseEnter = function()
			hovered(true)
		end,
		MouseLeave = function()
			hovered(false)
		end,
		Activated = props.OnClick,

		create "UIStroke" { Color = Theme.Edge, Thickness = 2 },
		create "UICorner" { CornerRadius = UDim.new(0, 3) },

		create "Frame" {
			Name = "KeyCap",
			AnchorPoint = Vector2.new(0, 0.5),
			Position = UDim2.new(0, 12, 0.5, 0),
			Size = UDim2.fromOffset(26, 16),
			BackgroundColor3 = Color3.fromRGB(235, 238, 244),
			create "UICorner" { CornerRadius = UDim.new(0, 2) },
			create "TextLabel" {
				Size = UDim2.fromScale(1, 1),
				BackgroundTransparency = 1,
				Text = props.Key,
				TextColor3 = Color3.fromRGB(40, 44, 52),
				TextSize = 7,
				FontFace = Theme.Plain,
			},
		},

		create "TextLabel" {
			Name = "Label",
			AnchorPoint = Vector2.new(1, 0.5),
			Position = UDim2.new(1, -16, 0.5, 0),
			Size = UDim2.fromOffset(70, 20),
			BackgroundTransparency = 1,
			Text = props.Label,
			TextColor3 = Theme.Text,
			TextSize = 12,
			TextXAlignment = Enum.TextXAlignment.Right,
			FontFace = Theme.Heavy,
		},
	}
end
