-- Racing HUD (docs/design/reference-racing-hud.png): position badge, leaderboard, boost bar, lap
-- card with a timer, speedometer and key-hint buttons. BOOST opens the upgrades panel; DRIFT
-- toggles a drift combo badge.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Vide = require(ReplicatedStorage.Packages.Vide)
local Interface = script.Parent.Parent
local Theme = require(Interface.Components.Theme)
local Controls = require(Interface.Components.Controls)
local KeyButton = require(Interface.Components.KeyButton)
local UpgradePanel = require(Interface.Components.UpgradePanel)

local create = Vide.create
local source = Vide.source
local derive = Vide.derive
local cleanup = Vide.cleanup

local ORDINALS = { "ST", "ND", "RD" }
local RACERS = {
	{ name = "NOVA", userId = 156 },
	{ name = "YOU", userId = 1 },
	{ name = "DEX", userId = 261 },
	{ name = "SKYE", userId = 9 },
}

local function text(props)
	props.BackgroundTransparency = 1
	props.TextColor3 = props.TextColor3 or Theme.Text
	props.FontFace = props.FontFace or Theme.Heavy
	return create "TextLabel"(props)
end

-- "2ND" on a slanted blue plate, "/ 8" and a checker flag on a dark plate behind it.
local function PositionBadge(position: () -> number, racers: number)
	return create "Frame" {
		Name = "PositionBadge",
		Position = UDim2.fromOffset(18, 62),
		Size = UDim2.fromOffset(230, 70),
		BackgroundTransparency = 1,

		create "Frame" {
			Name = "TotalPlate",
			AnchorPoint = Vector2.new(1, 1),
			Position = UDim2.fromScale(1, 1),
			Size = UDim2.fromOffset(80, 50),
			BackgroundColor3 = Theme.PanelDark,
			create "UIStroke" { Color = Theme.Edge, Thickness = 2 },
			text {
				Name = "Total",
				Position = UDim2.fromOffset(30, 4),
				Size = UDim2.fromOffset(44, 20),
				Text = `/ {racers}`,
				TextSize = 15,
				TextXAlignment = Enum.TextXAlignment.Right,
			},
			create "Frame" {
				Name = "Checker",
				AnchorPoint = Vector2.new(1, 1),
				Position = UDim2.new(1, -8, 1, -4),
				-- 6 cells of 7px per row need 42px; at 41 Roblox fits 5 and wraps a third row.
				Size = UDim2.fromOffset(42, 14),
				BackgroundTransparency = 1,
				create "UIGridLayout" {
					CellSize = UDim2.fromOffset(7, 7),
					CellPadding = UDim2.fromOffset(0, 0),
					SortOrder = Enum.SortOrder.LayoutOrder,
				},
				(function()
					local cells = {}
					for i = 1, 12 do
						local row, column = (i - 1) // 6, (i - 1) % 6
						cells[i] = create "Frame" {
							LayoutOrder = i,
							BackgroundColor3 = if (row + column) % 2 == 0 then Color3.new(1, 1, 1) else Theme.PanelDark,
						}
					end
					return cells
				end)(),
			},
		},

		-- A tall rotated plate clipped by a short band reads as a parallelogram.
		create "Frame" {
			Name = "Plate",
			Size = UDim2.fromOffset(176, 66),
			BackgroundTransparency = 1,
			ClipsDescendants = true,
			create "Frame" {
				Name = "Slant",
				AnchorPoint = Vector2.new(0.5, 0.5),
				Position = UDim2.fromOffset(92, 33),
				Size = UDim2.fromOffset(152, 260),
				Rotation = 16,
				-- UIGradient colours multiply the background colour, so the base is white.
				BackgroundColor3 = Color3.new(1, 1, 1),
				create "UIStroke" { Color = Theme.Edge, Thickness = 3 },
				create "UIGradient" {
					Rotation = 90,
					Color = ColorSequence.new(Theme.AccentLight, Theme.Accent),
				},
			},
			text {
				Name = "Place",
				Position = UDim2.fromOffset(38, -6),
				Size = UDim2.fromOffset(60, 76),
				Text = function()
					return tostring(position())
				end,
				TextSize = 66,
				TextColor3 = Color3.fromRGB(235, 238, 244),
				create "UIStroke" { Color = Theme.Edge, Thickness = 2.5 },
				create "UIGradient" {
					Rotation = 90,
					Color = ColorSequence.new({
						ColorSequenceKeypoint.new(0, Color3.fromRGB(255, 255, 255)),
						ColorSequenceKeypoint.new(0.55, Color3.fromRGB(170, 176, 186)),
						ColorSequenceKeypoint.new(1, Color3.fromRGB(230, 233, 238)),
					}),
				},
			},
			text {
				Name = "Suffix",
				Position = UDim2.fromOffset(92, 8),
				Size = UDim2.fromOffset(52, 26),
				Text = function()
					return ORDINALS[position()] or "TH"
				end,
				TextSize = 24,
				TextXAlignment = Enum.TextXAlignment.Left,
				TextColor3 = Color3.fromRGB(235, 238, 244),
				create "UIStroke" { Color = Theme.Edge, Thickness = 2 },
			},
		},
	}
end

local function LeaderRow(index: number, racer, isYou: boolean)
	local faded = index == 4
	-- The last row fades out as a whole: a UIGradient under a CanvasGroup applies to the group's
	-- children too (under a Frame it would fade only the Frame's own background).
	return create(if faded then "CanvasGroup" else "Frame") {
		Name = "Row" .. index,
		LayoutOrder = index,
		Size = UDim2.fromOffset(230, 38),
		BackgroundColor3 = if isYou then Theme.Accent else Theme.Panel,
		create "UIStroke" { Color = if isYou then Theme.AccentLight else Theme.Edge, Thickness = 2 },
		if faded
			then create "UIGradient" {
				Rotation = 90,
				Transparency = NumberSequence.new(0.25, 1),
			}
			else nil,
		create "Frame" {
			Name = "Rank",
			Size = UDim2.new(0, 52, 1, 0),
			BackgroundColor3 = if isYou then Color3.fromRGB(10, 150, 220) else Theme.PanelDark,
			BackgroundTransparency = 0,
			text {
				Size = UDim2.fromScale(1, 1),
				Text = string.format("%02d", index),
				TextSize = 15,
				TextColor3 = if isYou then Theme.PanelDark else Theme.Text,
			},
		},
		create "ImageLabel" {
			Name = "Avatar",
			Position = UDim2.fromOffset(56, 2),
			Size = UDim2.fromOffset(34, 34),
			BackgroundColor3 = Theme.PanelDark,
			Image = `rbxthumb://type=AvatarHeadShot&id={racer.userId}&w=48&h=48`,
		},
		text {
			Name = "Name",
			Position = UDim2.fromOffset(100, 0),
			Size = UDim2.new(1, -108, 1, 0),
			Text = racer.name,
			TextSize = 15,
			TextXAlignment = Enum.TextXAlignment.Left,
			TextColor3 = if isYou then Theme.PanelDark else Theme.Text,
		},
	}
end

local function Leaderboard(you: () -> number)
	return create "Frame" {
		Name = "Leaderboard",
		Position = UDim2.fromOffset(18, 142),
		Size = UDim2.fromOffset(230, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		BackgroundTransparency = 1,
		create "UIListLayout" { Padding = UDim.new(0, 7), SortOrder = Enum.SortOrder.LayoutOrder },
		function()
			local rows = {}
			for i, racer in RACERS do
				rows[i] = LeaderRow(i, racer, i == you())
			end
			return rows
		end,
	}
end

local function BoostBar(boost: () -> number)
	return create "Frame" {
		Name = "BoostBar",
		AnchorPoint = Vector2.new(0.5, 0),
		Position = UDim2.new(0.5, 0, 0, 20),
		Size = UDim2.fromOffset(560, 54),
		BackgroundColor3 = Theme.PanelDark,
		ClipsDescendants = true,
		create "UIStroke" { Color = Theme.Edge, Thickness = 3 },
		create "Frame" {
			Name = "Fill",
			Size = function()
				return UDim2.fromScale(boost(), 1)
			end,
			BackgroundColor3 = Color3.new(1, 1, 1),
			create "UIGradient" {
				Color = ColorSequence.new({
					ColorSequenceKeypoint.new(0, Theme.Gold),
					ColorSequenceKeypoint.new(0.6, Theme.Gold),
					ColorSequenceKeypoint.new(0.6001, Color3.fromRGB(0, 190, 255)),
					ColorSequenceKeypoint.new(0.74, Color3.fromRGB(70, 225, 255)),
					ColorSequenceKeypoint.new(0.7401, Theme.Gold),
					ColorSequenceKeypoint.new(0.95, Color3.fromRGB(255, 240, 170)),
					ColorSequenceKeypoint.new(1, Color3.new(1, 1, 1)),
				}),
			},
			create "Frame" {
				Name = "Shine",
				AnchorPoint = Vector2.new(0.5, 0.5),
				Position = UDim2.fromScale(0.22, 0.5),
				Size = UDim2.new(0, 46, 2, 0),
				Rotation = 35,
				BackgroundColor3 = Color3.new(1, 1, 1),
				BackgroundTransparency = 0.8,
			},
		},
		create "Frame" {
			Name = "Glow",
			AnchorPoint = Vector2.new(0, 0),
			Position = function()
				return UDim2.fromScale(boost(), 0)
			end,
			Size = UDim2.new(0, 40, 1, 0),
			BackgroundColor3 = Color3.fromRGB(255, 250, 220),
			create "UIGradient" { Transparency = NumberSequence.new(0.1, 1) },
		},
	}
end

local function LapCard(lap: () -> number, laps: number, seconds: () -> number)
	return create "Frame" {
		Name = "LapCard",
		AnchorPoint = Vector2.new(1, 0),
		Position = UDim2.new(1, -10, 0, 62),
		Size = UDim2.fromOffset(100, 82),
		BackgroundTransparency = 1,
		create "Frame" {
			Name = "Lap",
			Size = UDim2.fromOffset(100, 56),
			BackgroundColor3 = Theme.PanelDark,
			create "UIStroke" { Color = Theme.Edge, Thickness = 2 },
			create "UICorner" { CornerRadius = UDim.new(0, 2) },
			text { Position = UDim2.fromOffset(12, 6), Size = UDim2.fromOffset(28, 34), Text = function()
				return tostring(lap())
			end, TextSize = 28 },
			text { Position = UDim2.fromOffset(46, 22), Size = UDim2.fromOffset(16, 22), Text = "/", TextSize = 16 },
			text { Position = UDim2.fromOffset(66, 6), Size = UDim2.fromOffset(26, 14), Text = "LAP", TextSize = 9, TextXAlignment = Enum.TextXAlignment.Right },
			text { Position = UDim2.fromOffset(66, 30), Size = UDim2.fromOffset(26, 22), Text = tostring(laps), TextSize = 16, TextXAlignment = Enum.TextXAlignment.Right },
		},
		create "Frame" {
			Name = "Timer",
			Position = UDim2.fromOffset(0, 62),
			Size = UDim2.fromOffset(100, 20),
			BackgroundColor3 = Theme.Panel,
			create "UIStroke" { Color = Theme.Edge, Thickness = 2 },
			text { Position = UDim2.fromOffset(6, 0), Size = UDim2.fromOffset(16, 20), Text = "◷", TextSize = 11, FontFace = Theme.Plain },
			text {
				Name = "Time",
				Position = UDim2.fromOffset(30, 0),
				Size = UDim2.fromOffset(60, 20),
				Text = function()
					local s = seconds()
					return string.format("%02d:%02d", s // 60, s % 60)
				end,
				TextSize = 11,
			},
		},
	}
end

local function Speedometer(speed: () -> number)
	local lit = derive(function()
		-- 8 bars over 0..210 km/h: 180 lights 7, like the reference.
		return math.clamp(math.floor(speed() / 210 * 8 + 0.5), 0, 8)
	end)
	local bars = {}
	for i = 1, 8 do
		bars[i] = create "Frame" {
			LayoutOrder = i,
			Size = UDim2.fromOffset(22, 22),
			BackgroundColor3 = function()
				return if i <= lit() then Theme.Accent else Theme.PanelDark
			end,
			create "UIStroke" {
				Color = function()
					return if i <= lit() then Theme.AccentLight else Theme.Panel
				end,
				Thickness = 1.5,
			},
		}
	end
	return create "Frame" {
		Name = "Speedometer",
		AnchorPoint = Vector2.new(1, 1),
		Position = UDim2.new(1, -10, 1, -60),
		Size = UDim2.fromOffset(246, 96),
		BackgroundColor3 = Theme.Panel,
		create "UIStroke" { Color = Theme.Edge, Thickness = 2 },
		create "UICorner" { CornerRadius = UDim.new(0, 3) },
		create "Frame" {
			Name = "Bars",
			Position = UDim2.fromOffset(14, 10),
			Size = UDim2.new(1, -28, 0, 24),
			BackgroundTransparency = 1,
			create "UIListLayout" {
				FillDirection = Enum.FillDirection.Horizontal,
				Padding = UDim.new(0, 5.5),
				SortOrder = Enum.SortOrder.LayoutOrder,
			},
			bars,
		},
		text {
			Name = "Speed",
			Position = UDim2.fromOffset(40, 36),
			Size = UDim2.fromOffset(110, 54),
			Text = function()
				return tostring(math.floor(speed()))
			end,
			TextSize = 48,
			TextXAlignment = Enum.TextXAlignment.Right,
		},
		text { Name = "Unit", AnchorPoint = Vector2.new(1, 0), Position = UDim2.new(1, -18, 0, 62), Size = UDim2.fromOffset(60, 18), Text = "KM/H", TextSize = 13, TextXAlignment = Enum.TextXAlignment.Right },
	}
end

local function DriftBadge(open: () -> boolean)
	return create "TextLabel" {
		Name = "DriftCombo",
		AnchorPoint = Vector2.new(0.5, 1),
		Position = UDim2.new(0.5, 0, 1, -40),
		Size = UDim2.fromOffset(180, 44),
		Visible = open,
		BackgroundColor3 = Theme.PanelDark,
		Text = "DRIFT x2",
		TextColor3 = Theme.Gold,
		TextSize = 26,
		FontFace = Theme.Heavy,
		create "UIStroke" { Color = Theme.Gold, Thickness = 2, ApplyStrokeMode = Enum.ApplyStrokeMode.Border },
		create "UICorner" { CornerRadius = UDim.new(0, 4) },
	}
end

return {
	vide = Vide,
	controls = {
		Position = Controls.Slider(2, 1, 4, 1),
		Speed = Controls.Slider(180, 0, 240, 1),
		Boost = Controls.Slider(0.72, 0, 1, 0.01),
		Lap = 1,
		Backdrop = true,
	},
	story = function(props)
		local c = props.controls
		local upgradesOpen = source(false)
		local drifting = source(false)
		local seconds = source(102)
		local running = true
		task.spawn(function()
			while running do
				task.wait(1)
				if running then
					seconds(seconds() + 1)
				end
			end
		end)
		cleanup(function()
			running = false
		end)

		return create "Frame" {
			Name = "RacingHud",
			Size = UDim2.fromScale(1, 1),
			BackgroundColor3 = Theme.Scene,
			BackgroundTransparency = function()
				return if c.Backdrop() then 0 else 1
			end,

			BoostBar(c.Boost),
			PositionBadge(c.Position, 8),
			Leaderboard(c.Position),
			LapCard(c.Lap, 3, seconds),
			Speedometer(c.Speed),
			DriftBadge(drifting),
			UpgradePanel({
				Open = upgradesOpen,
				OnClose = function()
					upgradesOpen(false)
				end,
			}),
			KeyButton({
				Key = "Shift",
				Label = "BOOST",
				Position = UDim2.new(1, -137, 1, -12),
				Active = upgradesOpen,
				OnClick = function()
					upgradesOpen(not upgradesOpen())
				end,
			}),
			KeyButton({
				Key = "Space",
				Label = "DRIFT",
				Position = UDim2.new(1, -10, 1, -12),
				Active = drifting,
				OnClick = function()
					drifting(not drifting())
				end,
			}),
		}
	end,
}
