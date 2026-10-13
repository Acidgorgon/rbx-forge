-- Racing HUD palette and fonts.
local Theme = {
	Panel = Color3.fromRGB(26, 34, 48),
	PanelDark = Color3.fromRGB(16, 22, 32),
	Edge = Color3.fromRGB(8, 11, 17),
	Accent = Color3.fromRGB(19, 181, 255),
	AccentLight = Color3.fromRGB(110, 214, 255),
	Gold = Color3.fromRGB(255, 205, 0),
	Text = Color3.fromRGB(255, 255, 255),
	Muted = Color3.fromRGB(150, 160, 178),
	Scene = Color3.fromRGB(67, 78, 94),
}

-- Gotham-style heavy italic, the look of most racing HUDs.
Theme.Heavy = Font.new("rbxasset://fonts/families/GothamSSm.json", Enum.FontWeight.Heavy, Enum.FontStyle.Italic)
Theme.Bold = Font.new("rbxasset://fonts/families/GothamSSm.json", Enum.FontWeight.Bold, Enum.FontStyle.Italic)
Theme.Plain = Font.new("rbxasset://fonts/families/GothamSSm.json", Enum.FontWeight.Medium, Enum.FontStyle.Normal)

return Theme
