--!strict
-- PlayButton: imported from Figma by RBX Forge (Figma file KEY, node 12:34).
-- Mapping: approximated: font, absolute child in auto layout, drop shadow · dropped: background blur, letter spacing.
--   dropped background blur (Play Button): Roblox UI has no blur
--   approx font (Label): Inter -> BuilderSans ExtraBold (closest Roblox family to Inter)
--   dropped letter spacing (Label): 0.5px tracking (TextLabel has none)
--   approx absolute child in auto layout (Play Button): flow children moved into a "Flow" frame
--   approx drop shadow (Play Button): 3 stacked rounded Frames, offset 0,6, spread to 12px (Roblox UI has no blur)
-- Returns a function that builds a fresh copy: local ui = Component(parent?).
-- Re-importing overwrites this file; keep hand edits in the code that uses it.

-- Images are files in the project (Forge's UI Preview draws them). Upload each one (Art page or
-- Asset Manager) and replace the path with its rbxassetid:// before shipping.
local IMAGES = {
	["icon"] = "art/ui/play-button/icon.png",
}

local function make(className: string, props: { [string]: any }, children: { Instance }?): any
	local inst = Instance.new(className)
	for key, value in props do
		(inst :: any)[key] = value
	end
	if children then
		for _, child in children do
			child.Parent = inst
		end
	end
	return inst
end

return function(parent: Instance?): GuiObject
	local root = make("TextButton", {
		Name = "PlayButton",
		AnchorPoint = Vector2.new(0.5, 0.5),
		Position = UDim2.fromScale(0.5, 0.5),
		Size = UDim2.fromOffset(240, 72),
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		Text = "",
		AutoButtonColor = false,
	}, {
		make("UICorner", {
			Name = "UICorner",
			CornerRadius = UDim.new(0, 18),
		}),
		make("Frame", {
			Name = "Shadow3",
			AnchorPoint = Vector2.new(0.5, 0.5),
			Position = UDim2.new(0.5, 0, 0.5, 6),
			Size = UDim2.new(1, 16, 1, 16),
			ZIndex = 0,
			BackgroundColor3 = Color3.fromRGB(0, 0, 0),
			BackgroundTransparency = 0.8986,
			BorderSizePixel = 0,
		}, {
			make("UICorner", {
				Name = "UICorner",
				CornerRadius = UDim.new(0, 26),
			}),
		}),
		make("Frame", {
			Name = "Shadow2",
			AnchorPoint = Vector2.new(0.5, 0.5),
			Position = UDim2.new(0.5, 0, 0.5, 6),
			Size = UDim2.new(1, 11, 1, 11),
			ZIndex = 0,
			BackgroundColor3 = Color3.fromRGB(0, 0, 0),
			BackgroundTransparency = 0.8986,
			BorderSizePixel = 0,
		}, {
			make("UICorner", {
				Name = "UICorner",
				CornerRadius = UDim.new(0, 23),
			}),
		}),
		make("Frame", {
			Name = "Shadow1",
			AnchorPoint = Vector2.new(0.5, 0.5),
			Position = UDim2.new(0.5, 0, 0.5, 6),
			Size = UDim2.new(1, 5, 1, 5),
			ZIndex = 0,
			BackgroundColor3 = Color3.fromRGB(0, 0, 0),
			BackgroundTransparency = 0.8542,
			BorderSizePixel = 0,
		}, {
			make("UICorner", {
				Name = "UICorner",
				CornerRadius = UDim.new(0, 21),
			}),
		}),
		make("Frame", {
			Name = "Body",
			Size = UDim2.fromScale(1, 1),
			ZIndex = 1,
			BackgroundColor3 = Color3.fromRGB(255, 255, 255),
			BackgroundTransparency = 0,
			BorderSizePixel = 0,
		}, {
			make("UIGradient", {
				Name = "UIGradient",
				Rotation = 90,
				Color = ColorSequence.new({ ColorSequenceKeypoint.new(0, Color3.fromRGB(102, 217, 89)), ColorSequenceKeypoint.new(1, Color3.fromRGB(33, 153, 51)) }),
			}),
			make("UICorner", {
				Name = "UICorner",
				CornerRadius = UDim.new(0, 18),
			}),
			make("UIStroke", {
				Name = "UIStroke",
				ApplyStrokeMode = Enum.ApplyStrokeMode.Border,
				Color = Color3.fromRGB(13, 77, 26),
				LineJoinMode = Enum.LineJoinMode.Round,
				Thickness = 3,
				Transparency = 0,
			}),
			make("Frame", {
				Name = "Flow",
				Size = UDim2.fromScale(1, 1),
				BackgroundTransparency = 1,
				BorderSizePixel = 0,
			}, {
				make("UIListLayout", {
					Name = "UIListLayout",
					FillDirection = Enum.FillDirection.Horizontal,
					HorizontalAlignment = Enum.HorizontalAlignment.Center,
					Padding = UDim.new(0, 12),
					SortOrder = Enum.SortOrder.LayoutOrder,
					VerticalAlignment = Enum.VerticalAlignment.Center,
				}),
				make("UIPadding", {
					Name = "UIPadding",
					PaddingBottom = UDim.new(0, 14),
					PaddingLeft = UDim.new(0, 24),
					PaddingRight = UDim.new(0, 28),
					PaddingTop = UDim.new(0, 14),
				}),
				make("ImageLabel", {
					Name = "Icon",
					Size = UDim2.fromOffset(36, 36),
					LayoutOrder = 1,
					BackgroundTransparency = 1,
					Image = IMAGES["icon"],
					ScaleType = Enum.ScaleType.Fit,
				}),
				make("TextLabel", {
					Name = "Label",
					Size = UDim2.fromOffset(140, 32),
					AutomaticSize = Enum.AutomaticSize.XY,
					LayoutOrder = 2,
					BackgroundTransparency = 1,
					Text = "PLAY NOW",
					FontFace = Font.new("rbxasset://fonts/families/BuilderSans.json", Enum.FontWeight.ExtraBold, Enum.FontStyle.Normal),
					TextSize = 26,
					TextColor3 = Color3.fromRGB(255, 255, 255),
					TextTransparency = 0,
					TextXAlignment = Enum.TextXAlignment.Left,
					TextYAlignment = Enum.TextYAlignment.Center,
					TextWrapped = false,
				}, {
					make("UIStroke", {
						Name = "UIStroke",
						ApplyStrokeMode = Enum.ApplyStrokeMode.Contextual,
						Color = Color3.fromRGB(13, 77, 26),
						LineJoinMode = Enum.LineJoinMode.Round,
						Thickness = 2,
						Transparency = 0,
					}),
				}),
			}),
			make("Frame", {
				Name = "Badge",
				AnchorPoint = Vector2.new(1, 0),
				Position = UDim2.new(1, 8, 0, -8),
				Size = UDim2.fromOffset(30, 22),
				BackgroundColor3 = Color3.fromRGB(255, 64, 77),
				BackgroundTransparency = 0,
				BorderSizePixel = 0,
			}, {
				make("UICorner", {
					Name = "UICorner",
					CornerRadius = UDim.new(0.5, 0),
				}),
				make("TextLabel", {
					Name = "Count",
					AnchorPoint = Vector2.new(0, 0.5),
					Position = UDim2.fromScale(0, 0.5),
					Size = UDim2.new(1, 0, 0, 22),
					BackgroundTransparency = 1,
					Text = "2",
					FontFace = Font.new("rbxasset://fonts/families/FredokaOne.json", Enum.FontWeight.Bold, Enum.FontStyle.Normal),
					TextSize = 14,
					TextColor3 = Color3.fromRGB(255, 255, 255),
					TextTransparency = 0,
					TextXAlignment = Enum.TextXAlignment.Center,
					TextYAlignment = Enum.TextYAlignment.Center,
					TextWrapped = true,
				}),
			}),
		}),
	})
	root.Parent = parent
	return root
end
