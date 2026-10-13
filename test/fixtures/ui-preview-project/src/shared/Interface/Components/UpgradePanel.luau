-- Boost upgrades panel, opened by the BOOST key button. Slides in with a Vide spring.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Vide = require(ReplicatedStorage.Packages.Vide)
local Theme = require(script.Parent.Theme)

local create = Vide.create
local source = Vide.source
local spring = Vide.spring
local indexes = Vide.indexes

local UPGRADES = {
	{ name = "NITRO TANK", level = 2 },
	{ name = "BURST POWER", level = 3 },
	{ name = "RECHARGE", level = 1 },
}
local MAX_LEVEL = 5

return function(props: { Open: () -> boolean, OnClose: () -> () })
	local levels = source(table.clone(UPGRADES))

	local function upgrade(i: number)
		local list = table.clone(levels())
		local item = table.clone(list[i])
		item.level = math.min(MAX_LEVEL, item.level + 1)
		list[i] = item
		levels(list)
	end

	local x = spring(function()
		return if props.Open() then 0 else 1
	end, 0.25)

	return create "Frame" {
		Name = "UpgradePanel",
		AnchorPoint = Vector2.new(1, 1),
		Position = function()
			return UDim2.new(1, -16 + x() * 320, 1, -160)
		end,
		Size = UDim2.fromOffset(280, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		BackgroundColor3 = Theme.PanelDark,
		Visible = function()
			return x() < 0.99
		end,

		create "UIStroke" { Color = Theme.Accent, Thickness = 2 },
		create "UICorner" { CornerRadius = UDim.new(0, 4) },
		create "UIPadding" {
			PaddingTop = UDim.new(0, 12),
			PaddingBottom = UDim.new(0, 12),
			PaddingLeft = UDim.new(0, 14),
			PaddingRight = UDim.new(0, 14),
		},
		create "UIListLayout" {
			Padding = UDim.new(0, 8),
			SortOrder = Enum.SortOrder.LayoutOrder,
		},

		create "Frame" {
			Name = "Header",
			LayoutOrder = 0,
			Size = UDim2.new(1, 0, 0, 24),
			BackgroundTransparency = 1,
			create "TextLabel" {
				Size = UDim2.fromScale(1, 1),
				BackgroundTransparency = 1,
				Text = "BOOST UPGRADES",
				TextColor3 = Theme.Text,
				TextSize = 16,
				TextXAlignment = Enum.TextXAlignment.Left,
				FontFace = Theme.Heavy,
			},
			create "TextButton" {
				Name = "Close",
				AnchorPoint = Vector2.new(1, 0),
				Position = UDim2.fromScale(1, 0),
				Size = UDim2.fromOffset(24, 24),
				BackgroundColor3 = Theme.Panel,
				Text = "X",
				TextColor3 = Theme.Muted,
				TextSize = 12,
				FontFace = Theme.Heavy,
				Activated = props.OnClose,
				create "UICorner" { CornerRadius = UDim.new(0, 3) },
			},
		},

		indexes(levels, function(item, i)
			return create "Frame" {
				Name = "Upgrade" .. i,
				LayoutOrder = i,
				Size = UDim2.new(1, 0, 0, 30),
				BackgroundTransparency = 1,
				create "TextLabel" {
					Size = UDim2.new(0.45, 0, 1, 0),
					BackgroundTransparency = 1,
					Text = function()
						return item().name
					end,
					TextColor3 = Theme.Muted,
					TextSize = 11,
					TextXAlignment = Enum.TextXAlignment.Left,
					FontFace = Theme.Bold,
				},
				create "Frame" {
					Name = "Pips",
					Position = UDim2.fromScale(0.45, 0),
					Size = UDim2.new(0.3, 0, 1, 0),
					BackgroundTransparency = 1,
					create "UIListLayout" {
						FillDirection = Enum.FillDirection.Horizontal,
						VerticalAlignment = Enum.VerticalAlignment.Center,
						Padding = UDim.new(0, 3),
					},
					(function()
						local pips = {}
						for level = 1, MAX_LEVEL do
							pips[level] = create "Frame" {
								LayoutOrder = level,
								Size = UDim2.fromOffset(10, 14),
								BackgroundColor3 = function()
									return if level <= item().level then Theme.Accent else Theme.Panel
								end,
							}
						end
						return pips
					end)(),
				},
				create "TextButton" {
					Name = "Buy",
					AnchorPoint = Vector2.new(1, 0.5),
					Position = UDim2.fromScale(1, 0.5),
					Size = UDim2.fromOffset(62, 24),
					BackgroundColor3 = Theme.Gold,
					Text = function()
						return if item().level >= MAX_LEVEL then "MAX" else "UPGRADE"
					end,
					TextColor3 = Theme.PanelDark,
					TextSize = 10,
					FontFace = Theme.Heavy,
					Activated = function()
						upgrade(i)
					end,
					create "UICorner" { CornerRadius = UDim.new(0, 3) },
				},
			}
		end),
	}
end
