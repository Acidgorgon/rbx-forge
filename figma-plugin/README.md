# Forge UI: Figma plugin

This plugin moves a RBX Forge UI Preview frame into Figma and brings your edits back to Forge.

- **Import:** the plugin turns Forge JSON into Figma frames.
  - `UIListLayout` becomes auto layout; `UIGridLayout` becomes wrapping auto layout.
  - `UIPadding` becomes padding and `UICorner` becomes corner radius.
  - `UIStroke` becomes an outside stroke, on the frame or on the text.
  - `UIGradient` becomes a linear gradient.
  - Text keeps its font, size, colour, alignment and line height.
  - Rotation maps across, and images become image fills (or a placeholder when the image is not embedded).
  - Every layer stores its Roblox instance path with `setPluginData`.
- **Export:** you select the imported frame (or anything inside it) and get Forge JSON back.
- **In Forge:** *UI Preview › Figma › Import from Figma / Paste from Figma* diffs that JSON against the live story.
  - Literal changes (text, colours, transparency, size, position, rotation, alignment, text size) are rewritten in the `.luau` source and hot-reload.
  - Structural changes (new or removed layers, corner, stroke, gradient, padding, layout, fonts) go to the AI chat as a prefilled request, together with the diff and the saved frame.

## Install (Figma desktop)

1. Build `code.js` (it is committed, so this step only matters after you change `code.ts`):
   ```sh
   cd figma-plugin
   npm install
   npm run build
   ```
2. Open the Figma desktop app and go to **Plugins › Development › Import plugin from manifest…**
3. Pick `figma-plugin/manifest.json`.
4. Run it from **Plugins › Development › Forge UI**.

Development plugins only run in the desktop app. The manifest sets `documentAccess: "dynamic-page"`, which Figma requires for new plugins. It also sets `networkAccess.allowedDomains: ["none"]`, so the plugin never uses the network: frames travel as JSON that you paste or download.

## Round trip

1. **Export from Forge:** in *UI Preview*, choose **Figma › Forge JSON (for Figma)**.
   - This writes `art/ui-exports/<Story>.forge-ui.json`.
   - **Copy Forge JSON** puts it on the clipboard instead.
2. **Import into Figma:** in Figma, run **Forge UI**, paste the JSON and click **Import Forge JSON**.
3. **Edit** the frame: text, colours, sizes, positions, auto layout spacing and so on.
4. **Export from Figma:** select the frame and click **Export selection to Forge**, then **Copy** (or **Download .json**).
5. **Import into Forge:** in Forge, choose **Figma › Paste from Figma** (or **Import from Figma…** for a file). Review the literal changes, click **Apply**, and use **Ask AI to make these** for the rest.

Layers you add in Figma come back as new elements. Forge describes them to the AI with their position, size, fill and text, because they need new code.

## Limits

- Images are only embedded when Forge has them as data URLs (Art concepts). Roblox asset images appear as dashed placeholders.
- Fonts use the bundled substitutes when you have them installed: Montserrat for Gotham, Source Sans 3 for Source Sans Pro, Fredoka for Fredoka One. Otherwise they fall back to Inter. A font change comes back to Forge as a structural change.
- `UIGridLayout` cell sizes, `UIAspectRatioConstraint`, `UISizeConstraint` and `AutomaticSize` are kept in plugin data but not edited as such in Figma. Figma's grid auto layout is not used.

API references: [plugin manifest](https://developers.figma.com/docs/plugins/manifest/) and `@figma/plugin-typings` 1.141.0.
