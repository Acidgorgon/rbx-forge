# RBX Forge: visual and interaction spec

Status: design target for the renderer rewrite. Reference build: `docs/design/prototype.html` (open it in a browser; `#light`, `#welcome`, `#palette`, `#ctx`, `#toast`, `#problems`, `#nobottom` in the URL hash reproduce each screenshot state).

Screenshots (1440×900):

| File | State |
|---|---|
| `01-main.png` | Default dark layout: Explorer, editor with LSP hover, Output, Assistant |
| `02-command-palette.png` | ⌘K palette, "new" query |
| `03-context-menu-new.png` | Explorer context menu with the **New ▸** submenu |
| `04-light-theme.png` | Light (steel) theme |
| `05-welcome-dashboard.png` | Forge tab (welcome dashboard), bottom panel collapsed |
| `06-delete-undo-toast.png` | Problems tab + delete/undo toast |

---

## 0. Direction in one paragraph

Today the app is a chat page with an editor attached: a serif "Good morning", a big prompt box, and recent conversations at the top of the sidebar. The new direction makes it **a game-dev workbench**, with the code and the Roblox instance tree at the centre. The AI becomes a docked tool panel, like the Output window. The visual language comes from a forge. Cool **graphite/steel** neutrals take up 95% of the surface, and a single hot **ember** accent marks "where the heat is": the active tab, the selection, the primary action and running state. Corners are machined (4–8px), not pillowy. Type is technical (IBM Plex Sans + JetBrains Mono), and the brand face (Chakra Petch) appears only in the wordmark and the dashboard title. Motion is short and physical: things slide from where they live, and nothing bounces except a toast landing. Remove all of these from the UI: serif greetings, "What should we build today?", suggestion cards that are prompts, sparkle icons, avatar bubbles and a centred chat column.

---

## 1. Identity

### Name treatment
- Wordmark: `[RBX] FORGE`. "RBX" is set in JetBrains Mono 600, 9.5px, tracking .08em, inside a 1px `--line-strong` box with radius 2px, like a stamped part number. "FORGE" is set in Chakra Petch 700, 13.5px, tracking .16em, uppercase, `--fg`.
- Mark: a 20×20 anvil silhouette with a vertical steel gradient (`#cfd6e0 → #6f7886`) and an ember spark glowing above the horn (radial `#ffd9a8 → #ff8a3d → transparent`). The SVG is in the prototype titlebar. The app icon uses the same mark on a `#0c0e11` rounded square.
- Never write "AI" or "Claude" in chrome labels. The right panel is called **Assistant**. The model name appears only in the model picker.
- In copy, the action verb is *forge* only where it is fun and unambiguous (toast: "Feature "Shop" forged"). Buttons stay literal: "New Feature", "Sync", "Serve".

### Where the ember goes (and nowhere else)
1. Active editor tab: a 2px top bar with a 10px glow.
2. The selected tree row: a 2px left bar plus a `--bg-selected` tint.
3. The active activity-bar item: a 2px left bar with glow.
4. Primary buttons (`.btn-forge`: Serve, Apply, Send, New Feature card).
5. Focus rings, the text caret, and the resizer hover line.
6. The status bar "home" segment (project name).
7. The context meter fill.

Status colours (ok/warn/err) and realm colours are **never** ember.

---

## 2. Colour tokens

All colours are CSS custom properties on `:root`. Dark is the default. Light is applied with `[data-theme="light"]` on `<html>`. "System" mode sets that attribute from `matchMedia('(prefers-color-scheme: light)')` and listens for changes. Do **not** use a bare `@media (prefers-color-scheme)` block, because the user must be able to override it.

```css
:root, [data-theme="dark"] {
  color-scheme: dark;
  /* surfaces: darkest = chrome, lighter as you approach content */
  --bg-chrome:   #0c0e11;  /* titlebar, activity bar, status bar */
  --bg-panel:    #121418;  /* side, right, bottom panels, tab strip */
  --bg-editor:   #16191e;  /* editor + Forge tab */
  --bg-raised:   #1c2026;  /* inputs, cards, chips */
  --bg-overlay:  #1f242b;  /* menus, palette, toasts, hovers */
  --bg-hover:    rgba(200, 214, 235, .055);
  --bg-active:   rgba(200, 214, 235, .095);
  --bg-selected: rgba(255, 122, 47, .13);
  --line:        #23272e;
  --line-strong: #30363f;
  --line-focus:  #ff7a2f;
  --fg:          #e3e6eb;
  --fg-2:        #b0b7c2;
  --fg-muted:    #7d8592;
  --fg-faint:    #535a66;
  --fg-on-accent:#1a0d05;

  /* the one accent */
  --ember:      #ff7a2f;
  --ember-hi:   #ffa25e;
  --ember-lo:   #d4520f;
  --ember-text: #ff9150;               /* ember used as text on dark */
  --ember-soft: rgba(255, 122, 47, .14);
  --ember-glow: rgba(255, 122, 47, .45);
  --ember-grad: linear-gradient(180deg, #ff9a4d 0%, #ff7a2f 45%, #e65a14 100%);

  /* realms (Rojo destination) */
  --realm-server: #67a3ff; --realm-server-soft: rgba(103, 163, 255, .13);
  --realm-client: #45d4a0; --realm-client-soft: rgba(69, 212, 160, .12);
  --realm-shared: #b494ff; --realm-shared-soft: rgba(180, 148, 255, .13);
  --realm-studio: #e8b44c; --realm-studio-soft: rgba(232, 180, 76, .12); /* Studio-only, not in Rojo */

  /* service / diagnostic states */
  --ok: #3fd18a; --warn: #f2b33d; --err: #ff5f5f; --info: #67a3ff; --idle: #5d6573;

  /* elevation */
  --sh-1: 0 1px 0 rgba(255,255,255,.03) inset, 0 1px 2px rgba(0,0,0,.4);
  --sh-2: 0 8px 24px rgba(0,0,0,.45), 0 2px 6px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.05);
  --sh-3: 0 24px 64px rgba(0,0,0,.6), 0 6px 16px rgba(0,0,0,.4), 0 0 0 1px rgba(255,255,255,.06);
  --focus-ring: 0 0 0 1px var(--bg-editor), 0 0 0 3px rgba(255, 122, 47, .55);

  /* syntax (UI-side highlights + Monaco theme source) */
  --syn-kw: #ff8f5a; --syn-fn: #f2d27a; --syn-str: #9fd88a; --syn-num: #d7a0ff; --syn-com: #5d6676;
  --syn-glob: #67b8ff; --syn-type: #5fd4c9; --syn-prop: #c9d1dd; --syn-op: #8a93a1;
}

[data-theme="light"] {
  color-scheme: light;
  --bg-chrome: #e4e7eb; --bg-panel: #eef0f3; --bg-editor: #fbfbfc; --bg-raised: #ffffff; --bg-overlay: #ffffff;
  --bg-hover: rgba(30, 40, 55, .055); --bg-active: rgba(30, 40, 55, .09); --bg-selected: rgba(226, 87, 15, .11);
  --line: #d9dde3; --line-strong: #c4cad3; --line-focus: #e2570f;
  --fg: #171a1f; --fg-2: #3c434d; --fg-muted: #5f6875; --fg-faint: #9aa2ad; --fg-on-accent: #ffffff;
  --ember: #e8590c; --ember-hi: #ff7a2f; --ember-lo: #b8440a; --ember-text: #c2410c;
  --ember-soft: rgba(232, 89, 12, .1); --ember-glow: rgba(232, 89, 12, .3);
  --ember-grad: linear-gradient(180deg, #ff7f3a 0%, #ec5f12 55%, #cf4c08 100%);
  --realm-server: #2563d9; --realm-server-soft: rgba(37, 99, 217, .1);
  --realm-client: #0f8f66; --realm-client-soft: rgba(15, 143, 102, .1);
  --realm-shared: #7a4fd6; --realm-shared-soft: rgba(122, 79, 214, .1);
  --realm-studio: #a8700a; --realm-studio-soft: rgba(168, 112, 10, .1);
  --ok: #16a05c; --warn: #b7790d; --err: #d63c3c; --info: #2563d9; --idle: #9aa2ad;
  --sh-1: 0 1px 2px rgba(20,30,45,.08);
  --sh-2: 0 8px 24px rgba(20,30,45,.12), 0 2px 6px rgba(20,30,45,.08), 0 0 0 1px rgba(20,30,45,.08);
  --sh-3: 0 24px 64px rgba(20,30,45,.18), 0 6px 16px rgba(20,30,45,.1), 0 0 0 1px rgba(20,30,45,.1);
  --focus-ring: 0 0 0 1px var(--bg-editor), 0 0 0 3px rgba(232, 89, 12, .45);
  --syn-kw: #c2410c; --syn-fn: #8a5a00; --syn-str: #2f7d1f; --syn-num: #8a3fd1; --syn-com: #98a0ab;
  --syn-glob: #1f5fc4; --syn-type: #0b7f78; --syn-prop: #2b313a; --syn-op: #6b7380;
}
```

### Semantic usage

| Meaning | Token | Shown as |
|---|---|---|
| Server realm (ServerScriptService, ServerStorage via Rojo) | `--realm-server` | `SERVER` tag, Script glyph, tree rail |
| Client realm (StarterPlayerScripts) | `--realm-client` | `CLIENT` tag, LocalScript glyph, tree rail |
| Shared (ReplicatedStorage) | `--realm-shared` | `SHARED` tag, ModuleScript glyph, tree rail |
| Studio-only (instances not in the Rojo project: Workspace, ServerStorage assets) | `--realm-studio` | `STUDIO` tag, dimmed row, amber rail |
| Blink-generated module | `--realm-client` + bolt glyph | `BLINK` tag, read-only |
| Wally package | `--fg-muted` | `WALLY` tag, dimmed |
| Service running / ready | `--ok` | solid LED with a 6px glow |
| Service starting / connecting | `--warn` | LED pulsing (`rf-pulse` 1.4s) |
| Service crashed | `--err` | solid LED, status bar text turns `--err`, "Crashed" label |
| Service stopped | `--idle` | flat LED, no glow |
| Git modified / added | `--warn` / `--ok` | `M` / `A` letter at the row's right edge, plus a gutter bar |

Realm tags: JetBrains Mono 600, 9px, tracking .06em, padding 3px 4px 2px, radius 2px, coloured text on a `-soft` background. Do not use pills.

Contrast (measured): dark `--fg` on `--bg-editor` 14.1:1, `--fg-muted` on `--bg-panel` 5.0:1, `--ember-text` on `--bg-editor` 7.9:1. Light: `--ember-text` (#c2410c) on white 5.2:1, `--fg-muted` on `--bg-panel` ≥ 4.8:1. `--fg-faint` is for decoration and disabled text only (below 4.5:1 on purpose). Ember as a *fill* carries `--fg-on-accent` text.

---

## 3. Typography

Google Fonts (one request; bundle the files offline for Electron with `@fontsource/ibm-plex-sans`, `@fontsource/jetbrains-mono` and `@fontsource/chakra-petch`, so the app never needs the network):

```html
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

```css
:root {
  --font-ui: 'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  --font-display: 'Chakra Petch', 'IBM Plex Sans', sans-serif; /* wordmark + Forge tab H1 only */
  --fs-2xs: 10px; --fs-xs: 11px; --fs-sm: 12px; --fs-ui: 13px; --fs-md: 14px; --fs-lg: 16px; --fs-xl: 20px; --fs-2xl: 28px;
  --fs-code: 13px; --lh-code: 20px; --lh-ui: 18px;
  --fw-regular: 400; --fw-medium: 500; --fw-semibold: 600;
}
```

| Role | Font | Size / weight / extra |
|---|---|---|
| Body UI, tree rows, menus | Plex Sans | 13 / 400, line height 18 |
| Section and panel titles (EXPLORER, OUTPUT, QUICK ACTIONS) | Plex Sans | 10.5–11 / 600, uppercase, tracking .08–.1em, `--fg-muted` |
| Tab labels | Plex Sans | 13 / 400 (preview tab: italic) |
| Assistant messages | Plex Sans | 12.5 / 400, line height 1.55 |
| Code (Monaco) | JetBrains Mono | 13 / 400, line height 20, ligatures on (setting) |
| Paths, logs, kbd, counts, tags, timings | JetBrains Mono | 11–12 / 400–500 |
| Forge tab H1 | Chakra Petch | 28 / 700, tracking .02em |
| Wordmark | see §1 | |

Don't use serif type anywhere. Don't go below 9px, and only tags use 9px.

---

## 4. Density, spacing, radius, elevation

```css
:root {
  --sp-0: 0; --sp-half: 2px; --sp-1: 4px; --sp-2: 6px; --sp-3: 8px; --sp-4: 12px; --sp-5: 16px; --sp-6: 20px; --sp-7: 24px; --sp-8: 32px; --sp-10: 40px;
  --r-xs: 2px;  /* tags, kbd inner */
  --r-sm: 4px;  /* icon buttons, menu items, chips */
  --r-md: 6px;  /* buttons, inputs, palette items */
  --r-lg: 8px;  /* cards, menus, toasts, diff cards */
  --r-xl: 12px; /* command palette, dialogs */
  --r-pill: 999px; /* counters only */
  --row-h: 22px; --indent: 12px;
}
```

- Tree rows are 22px. Menu items are 26px (40px for two-line items). Palette items are 32px. Buttons are 26px (titlebar) or 22px (inline `mini-btn`). Icon buttons are 24×24. The tab strip is 35px, breadcrumbs 26px, the status bar 24px and the titlebar 38px.
- Elevation: `--sh-1` for in-flow cards; `--sh-2` for hovers, popovers and tooltips; `--sh-3` for the palette, menus and toasts. Panels never have shadows. They are separated by 1px `--line` borders.
- The scrim behind modal overlays is `rgba(5,7,10,.45)` plus `backdrop-filter: blur(1.5px)` (light: `rgba(30,40,55,.18)`).

---

## 5. Iconography

- **UI icons**: 16×16 viewBox, 1.5px stroke, round caps and joins, `currentColor`, no fills (except dots). Activity bar icons render at 20px with stroke 1.4. Status bar icons render at 12px. One sprite (`<symbol>`), as in the prototype. Suggested source: copy the prototype's symbols, or use Lucide with `strokeWidth={1.5}` at size 16. Never mix icon sets.
- No sparkles, magic wands or robot faces for the assistant. The Assistant uses **hammer**. Test agents use a small bot outline because they really are play-testing bots.
- **Roblox class glyphs** (`ClassIcon.tsx` replacement, see `glyph()` in the prototype): 16px, 1.3px stroke, with a 12–16% tint fill.
  - Script, LocalScript, ModuleScript: a page with a folded corner. The page is stroked in the **realm colour of where it lives** (server blue / client green / shared purple) and carries a class mark: two lines for Script, a person bust for LocalScript, a small hexagon (module) for ModuleScript.
  - Folder: neutral `--fg-muted` folder (folders are not a realm).
  - Services (ReplicatedStorage, ServerScriptService, ServerStorage): a rounded box with a header line, tinted by realm.
  - Workspace: an isometric cube in `#7fb3e6`. StarterPlayer: a person in client green. Model and Tool: `--realm-studio` (they are Studio-only content in GenTree).
  - Wally package: the package cube in `--fg-muted`. Blink: the bolt in client green.
- Tree "realm rails": the vertical indent guide under a service is coloured by that service's realm at 55% opacity (30% when the tree isn't hovered). It tells you at a glance which side of the network boundary you are in.

---

## 6. Motion system

### Tokens

```css
:root {
  --dur-instant: 70ms;   /* hover bg, press */
  --dur-fast: 120ms;     /* menus, tooltips, view swap, colour changes */
  --dur-base: 180ms;     /* tree expand, tab open/close, palette, list items */
  --dur-panel: 220ms;    /* panel collapse/expand */
  --dur-slow: 280ms;     /* toasts in, dashboard card stagger */
  --dur-glacial: 420ms;  /* only for first paint of the Forge tab */
  --ease-out: cubic-bezier(.16, 1, .3, 1);     /* default for anything entering */
  --ease-in: cubic-bezier(.5, 0, .75, 0);      /* things leaving */
  --ease-in-out: cubic-bezier(.65, 0, .35, 1); /* things moving in place / closing tabs */
  --ease-snap: cubic-bezier(.2, .9, .25, 1.15);/* toasts only: a 1–2px settle */
  --ease-linear: linear;                       /* shimmer, timers, spinners */
}
```

Rules: enter = `--ease-out`, exit = `--ease-in` at ≈70% of the enter duration, never above 280ms for anything the user waits on, and animate only `transform`, `opacity`, `grid-template-rows` and `width`/`height` of panels (the last two are allowed because Monaco must re-layout anyway).

### Keyframes (paste as is)

```css
@keyframes rf-fade-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes rf-pop-in { from { opacity: 0; transform: translateY(-4px) scale(.98) } to { opacity: 1; transform: none } }
@keyframes rf-menu-in { from { opacity: 0; transform: scale(.97) } to { opacity: 1; transform: none } }
@keyframes rf-palette-in { from { opacity: 0; transform: translateY(-8px) scale(.985) } to { opacity: 1; transform: none } }
@keyframes rf-scrim-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes rf-item-in { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
@keyframes rf-tab-open { from { opacity: 0; max-width: 0; } to { opacity: 1; max-width: 240px; } }
@keyframes rf-tab-close { from { opacity: 1; max-width: 240px; } to { opacity: 0; max-width: 0; padding-inline: 0; } }
@keyframes rf-toast-in { from { opacity: 0; transform: translateY(12px) scale(.98) } to { opacity: 1; transform: none } }
@keyframes rf-toast-out { to { opacity: 0; transform: translateX(16px) } }
@keyframes rf-toast-timer { from { transform: scaleX(1) } to { transform: scaleX(0) } }
@keyframes rf-shimmer { from { background-position: 150% 0 } to { background-position: -50% 0 } }
@keyframes rf-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .35 } }
@keyframes rf-spin { to { transform: rotate(360deg) } }
@keyframes rf-flash { 0% { background: var(--ember-soft) } 100% { background: transparent } }
@keyframes rf-spark { 0% { opacity: 0; transform: translate(0,0) scale(.6) } 20% { opacity: 1 } 100% { opacity: 0; transform: translate(var(--sx), var(--sy)) scale(.2) } }
@keyframes rf-caret { 50% { opacity: 0 } }
```

### Catalogue

| Interaction | Spec |
|---|---|
| **Hover** | Background to `--bg-hover` in `--dur-instant` with `--ease-out`. Text goes up one step (`--fg-muted` → `--fg-2`, or `--fg-2` → `--fg`). |
| **Press** | `:active` gives `translateY(1px)` on buttons and `scale(.94)` on icon buttons, over `--dur-instant`. Primary buttons also get `filter: brightness(.96)`. |
| **Focus ring** | Only on `:focus-visible`: `box-shadow: var(--focus-ring)`, which is a 1px gap plus a 3px ember at 55%. Inputs use `border-color: var(--ember)` plus `0 0 0 3px var(--ember-soft)`. The ring appears instantly, with no transition. |
| **Panel collapse / expand** (⌘B, ⌘J, ⌘L) | Animate the panel's `width`/`height` over `--dur-panel` with `--ease-out`. The inner content has a fixed size and gets `opacity → 0` plus `translateX(∓12px)` (or `translateY(8px)` for bottom) over `--dur-base`. The panel border fades to transparent. Monaco: keep `automaticLayout: true` (it uses ResizeObserver, so each frame re-lays out). If profiling shows jank, set the editor container to `contain: strict` and call `editor.layout()` on `transitionend` only. |
| **Panel resize** (drag) | 5px hit area straddling the border. The 1px ember line appears on hover after a **300ms delay** (no flicker when you pass over it) and stays while dragging. During a drag, set `transition: none` on panels and `cursor` on body. Double-click resets to the default size. Snap-to-collapse: dragging below the min size by 40px collapses the panel (same animation). |
| **Tab open** | `rf-tab-open` over `--dur-base` with `--ease-out` (max-width 0 → 240, fade). The ember top bar of the newly active tab is already present (no slide between tabs; it cuts instantly, like VS Code). |
| **Tab close** | `rf-tab-close` over `--dur-base` with `--ease-in-out` and `pointer-events: none`. When it ends, remove the tab and activate the right neighbour (or the left one if there is none). Middle-click also closes. |
| **View swap** (tab content, bottom tabs) | `rf-fade-in` over `--dur-fast`. Never slide content. |
| **Tree expand / collapse** | The children wrapper uses `display: grid; grid-template-rows: 0fr → 1fr` and `opacity: 0 → 1`, both over `--dur-base` with `--ease-out`. The inner element has `overflow: hidden; min-height: 0`. The chevron rotates 90° over `--dur-base`. For trees over about 500 visible rows, virtualize. Then animate only the first 30 inserted rows with `rf-item-in` (12ms stagger, capped at 120ms) and skip the height animation. |
| **List item enter** (new log line, new tree node, new assistant message, palette results) | `rf-item-in` over `--dur-base`/`--dur-slow` with `--ease-out`, staggered `18–35ms × index` up to 8 items, then no stagger. New log lines also get `rf-flash` (1.2s) when the panel is visible. |
| **Created or restored node** | The row plays `rf-flash` over 900ms (ember tint fading out) after create, move, undo-delete or "reveal in tree". |
| **Delete** | The row fades to opacity 0 over 160ms with `--ease-in`, then collapses (height to 0 over `--dur-base`). |
| **Command palette open** | The scrim plays `rf-scrim-in` over `--dur-fast`. The palette plays `rf-palette-in` over `--dur-base` with `--ease-out` and origin at top centre. Results stagger with `rf-item-in` at 18ms. Close is an instant removal (palettes must feel instant to dismiss). |
| **Context menu** | `rf-menu-in` over `--dur-fast` with `--ease-out`, with `transform-origin` set to the corner nearest the cursor. A submenu opens on 0ms hover over the parent item (or →) and closes after 250ms of leaving, measured from a safe triangle toward the submenu. |
| **Tooltip** | 500ms show delay. Once one tooltip is visible, others show with no delay for 800ms. `rf-fade-in` over `--dur-fast`. The activity bar tooltip shows the label plus a `<kbd>`. |
| **Hover card** (LSP hover) | 300ms delay, `rf-pop-in` over `--dur-base`. It opens above the line when there is no room below. |
| **Toast** | Stack at bottom-right, 16px above the status bar, offset left by the Assistant width when that panel is open (it animates with the panel). In: `rf-toast-in` over `--dur-slow` with `--ease-snap`. Out: `rf-toast-out` over `--dur-base` with `--ease-in`. Auto-dismiss after 6s. A 2px ember timer bar along the bottom edge (`rf-toast-timer`) **pauses on hover**. On mouse-leave, 2.5s more. A maximum of 3 toasts are visible; older ones collapse. |
| **Skeleton loading** | `.skel` blocks at real text sizes (10px bars, 12px chips) use a `--bg-active` base with a shimmer gradient over `rf-shimmer` (1.4s linear, infinite). Use them when data takes more than 150ms (show nothing for the first 150ms to avoid a flash). Examples: service card while connecting, Packages list, Agents history, quick-open index. |
| **Service state change** | The LED colour cross-fades over `--dur-base`. starting/connecting → `rf-pulse` 1.4s. Crashed → one `rf-flash` on that status-bar segment using the error colour, and the Output chip for that service gets a red LED. |
| **Primary action sparks** | On Serve/restart, Apply diff, New Feature create and a successful sync, 9 three-pixel ember dots burst upward from the button and fade out (`rf-spark`, 520ms, 12ms stagger). This is purely decorative and is disabled by reduced motion and by the setting "Effects: Sparks". |
| **Caret** | Ember 2px caret with a 6px glow and 1.1s steps(1) blink (Monaco: `cursorStyle: 'line'`, `cursorBlinking: 'phase'`, colour via theme `editorCursor.foreground`). |

### Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  :root { --dur-instant: 0ms; --dur-fast: 0ms; --dur-base: 0ms; --dur-panel: 0ms; --dur-slow: 0ms; --dur-glacial: 0ms; }
  *, *::before, *::after {
    animation-duration: 1ms !important; animation-iteration-count: 1 !important;
    transition-duration: 1ms !important; scroll-behavior: auto !important;
  }
  .spark { display: none !important; }
}
```

Also add an in-app setting, **Motion: Full / Reduced / Off**, that sets `data-motion="reduced"` on `<html>` with the same overrides, so users on a system without that preference can opt out. The LED pulse becomes a static ring. Skeleton shimmer becomes static `--bg-active`. Progress uses determinate text ("Syncing 3/7").

---

## 7. Layout

```
┌──────────────────────────── titlebar 38 ─────────────────────────────────────┐
│ ● ● ●  [anvil][RBX]FORGE │ GenTree ⎇ main ▾   [ ⌕ Search scripts, instances… ⌘K ]   [Sync ↓2] [▶ Serve :34872] │ ▯ ▭ ▯ ☀ │
├──┬───────────┬┬──────────────────── editor area ──────────────────┬┬────────────┤
│A │ SIDE      ││ tabs 35                                           ││ ASSISTANT  │
│c │ PANEL     ││ breadcrumbs 26  game › SSS › Server › … [SERVER]  ││ 360        │
│t │ 268       ││                                                   ││            │
│i │           ││ Monaco / Forge tab / diff / settings              ││            │
│v │           │├───────────────────────────────────────────────────┤│            │
│46│           ││ BOTTOM PANEL 214: Output · Problems · Dev·Rojo   ││            │
├──┴───────────┴┴───────────────────────────────────────────────────┴┴────────────┤
│ ⚒ GenTree │ ⎇ main ↓2 │ ● Rojo :34872 │ ● Watcher │ ● Blink │ ● Studio …   ⚠3 ⊗0 │ SERVER │ Ln 33, Col 58 │ Tabs: 4 │ ● luau-lsp │ ⚒ 46.1k · $0.42 │ 🔔 │
└──────────────────────────────── status 24 ───────────────────────────────────┘
```

| Region | Default | Min | Max | Collapse | Persisted |
|---|---|---|---|---|---|
| Titlebar | 38 | – | – | never. On macOS it is a `titleBarStyle: 'hiddenInset'` drag region with a 72px traffic-light inset; on Windows/Linux `titleBarOverlay` controls sit on the right, so move `tb-right` left by the overlay width | – |
| Activity bar | 46 | – | – | ⌘⌥B hides it (rare) | yes |
| Side panel | 268 | 200 | 480 | ⌘B, clicking the active activity icon, or dragging 40px past min | width + open + view |
| Editor area | flex | 360 | – | never | – |
| Bottom panel | 214 | 120 | 60% of center | ⌘J, its × button, or a drag. Auto-opens on a **crash** (Output filtered to that service) or on a new **error** (Problems) only if the user hasn't closed it in the last 5 minutes | height + open + tab + service filter |
| Assistant | 360 | 300 | 560 | ⌘L, the × button, or the titlebar toggle | width + open |
| Status bar | 24 | – | – | never | – |

The window min-size is 1024×640. Below 1180px wide, opening the Assistant auto-collapses the side panel, and the side panel restores when the Assistant closes. Side panel views are mutually exclusive: one activity at a time, like VS Code.

### 7.1 Titlebar
- Left: traffic lights, then the brand (with a 1px right divider), then the **project switcher** (`GenTree ⎇ main ▾`). The project switcher opens a menu with recent projects, "Open folder…", "New project from GenTree template…" and "Reveal in Finder".
- Centre: the **omnibox**, 460px (34vw max), absolutely centred. Clicking it opens the palette in quick-open mode. It shows the placeholder "Search scripts, instances, commands" and `⌘K`.
- Right: **Sync** (ghost button, shows ↓behind/↑ahead and turns ember text when behind), then **Serve** (`.btn-forge`, shows the Rojo port). Serve has three states: *Serve* (stopped), *Serving :port* (running, click restarts with sparks) and *Crashed* (err-tinted outline, click restarts). Then a divider, three panel toggles (lit when open) and the theme toggle.

### 7.2 Activity bar (top → bottom)
| Icon | View | Shortcut | Badge |
|---|---|---|---|
| tree | **Explorer** (Roblox game tree / files / features) | ⌘⇧E | – |
| script | **Scripts** (flat role-grouped list: Services, Controllers, Shared modules, Entry points, Blink outputs; this is the current Scripts tab, restyled) | ⌘⇧J | – |
| search | **Search** (find / replace in files: Match Case, Whole Word, regex, files to include / exclude, results by file; views/SearchView.tsx) | ⌘⇧F | – |
| bolt | **Events (Blink)**: parsed `events.blink`, one row per event with `From` arrow (S→C / C→S), Type, Call, Data. Click opens `events.blink` at that line. "+ New event" form. Generated outputs listed read-only | ⌘⇧V | count of Blink errors |
| package | **Packages (Wally)**: `wally.toml` deps, version, "update available" chip, Install / Update buttons, link to `Packages/` | – | outdated count |
| branch | **Source control & Sync**: branch, behind/ahead, changed files (click opens a diff tab), Studio conflicts (click opens a 3-way diff tab with *Keep repo* / *Use Studio*). The SyncDrawer content moves here and conflict diffs open as editor tabs instead of a drawer | ⌘⇧G | behind + conflicts (ember) |
| bot | **Agents**: "New run" textarea at the top, runs list (Running / Passed / Failed chips). Details open as an editor tab with a transcript and tool calls. Replaces AgentsDrawer | ⌘⇧A | pulsing amber dot while running; red count on failures |
| (spacer) | | | |
| gear | **Settings**: opens a Settings editor tab (not a drawer) | ⌘, | – |

The active item gets an ember left bar (2px, inset 8px top and bottom, with glow). Tooltips sit on the right and show the label plus the shortcut.

### 7.3 Side panel: Explorer
- Header: `EXPLORER`, then icon buttons: New… (opens the **New ▸** menu anchored under it), New Feature, Collapse all.
- Filter input (⌥F focuses it) filters by name and keeps ancestors. Matches are highlighted in `--ember-text`.
- Segmented control: **Game tree** (default; the Rojo-mapped instance tree from `sourcemap.json` plus Studio-only instances from Studio Sync), **Files** (the raw `src/` tree), and **Features** (one row per feature showing the status of its three parts: ✓ shared, ✓ Service, ✓ Controller, or a warning when one is missing).
- Game tree rules: the root section is `GAME · rojo · <instance count>`. Rojo-mapped folders show their `$path` as right-aligned faint mono meta (`src/shared`). Studio-only instances are dimmed with a `STUDIO` tag on the top-level node. Packages are dimmed with a `WALLY` tag and collapsed by default. Blink outputs get a `BLINK` tag and a lock on hover. Script folders that are really `init.*` show the `init` / `init.server` / `init.client` suffix in faint text after the name.
- Row anatomy: `[chevron 14][glyph 16] name [ext faint] ……… [git letter | tag | meta]`.
- Selection: ember left bar plus `--bg-selected`. Context-menu target gets a 1px ember inset outline (`.focus-outline`). Keyboard: ↑/↓ move, ←/→ collapse and expand, Enter opens, Space previews (italic tab), F2 renames, ⌘⌫ deletes, type-ahead jumps.

### 7.4 Editor area
- **Tabs**: 35px, max 240px each, separated by 1px `--line`. Active tab: `--bg-editor` background merging into the editor, a 2px ember top bar with glow, and `--fg` text. The dirty dot (7px, `--fg-2`) swaps to × on hover. Preview tabs are italic and are replaced by the next preview. Tabs show the class glyph, not a file-type icon. The overflow is a horizontal scroll with fade masks plus a ⌄ list button. On the right: Split right (⌘\) and a ⋯ menu.
- **Breadcrumbs** (26px): the Roblox path, with each segment's glyph: `game › ServerScriptService › Server › Features › Inventory › InventoryService`, then a realm tag (`SERVER`), then the file path in faint mono, right-aligned and truncated from the left. Clicking a segment opens a dropdown of its siblings (navigate within the tree). For files outside the Rojo tree (`events.blink`, `wally.toml`), show the file path instead.
- **Monaco**: theme `forge-dark` / `forge-light` built from the `--syn-*` tokens. Settings: font `JetBrains Mono` 13/20, `renderLineHighlight: 'all'`, `minimap: { renderCharacters: false, maxColumn: 80 }`, `guides.indentation: true`, `bracketPairColorization: false` (it competes with the realm colours), `smoothScrolling: true` (off under reduced motion), `cursorSmoothCaretAnimation: 'on'` (off under reduced motion), `stickyScroll.enabled: true`, and git gutter decorations (`--ok` added, `--info` modified, `--err` deleted triangle). Overview ruler marks for problems.
- **Forge tab (welcome / dashboard)**: shown when no editor is open (it can't be closed when it is the last tab), and reopened with ⌘⇧H or by clicking the status-bar home segment. The background is the editor colour with a faint 24px blueprint grid masked to fade out by 80% height and an ember radial glow in the top-left. Content is max 860px, centred:
  1. Header: `GenTree` (Chakra Petch 28), a mono subline with path · branch ↓↑ · Rojo version · Blink version, and "Open in Studio" on the right.
  2. **Quick actions** (4 cards, 4-column grid): **New Feature** (primary, ember icon), **New Script**, **Sync** (live subline: "Pull 2 commits, 1 Studio conflict"), **Run agents**. Each card shows its shortcut in the top-right corner.
  3. Two columns. Left: **Services** (Rojo, Dev watcher, Blink, Luau LSP, Studio Sync), each row with an LED, name, mono detail, a 64×18 activity sparkline of log lines per minute and a state label. Click it to open Output filtered to that service. Hover reveals Restart/Stop. Right: **Recent projects** (monogram tile, name, path, relative time, plus "New project from GenTree…"), then **Features** (feature name, parts, completeness).
  4. Cards enter with `rf-item-in` staggered 30ms.

### 7.5 Assistant panel (right)
It is a tool panel, not the main screen. It is never open on first launch until a project is open, and it then remembers its state.
- Header (38px): `ASSISTANT` panel title, then the **model picker** (24px button, ember diamond plus model name. The menu lists models with context size and price per Mtok), then History (clock), New thread (+, ⌘⇧L) and Close (×).
- **Meter row**: `ctx [====··········] 46.1k/200k · $0.42`. The ember fill is used context, the grey segment is the reserved output budget, and the cost is cumulative for the session. It turns `--warn` above 75% and `--err` above 90%, with a "Compact" link.
- **Messages**: compact, without avatars or bubbles for the assistant.
  - User message: a `--bg-raised` box with a 1px border and a mono `YOU` label on the left. Text is 12.5px.
  - Assistant text: plain text, 12.5/1.55, `--fg-2`. Inline code gets a `--bg-active` chip.
  - Tool calls: one 22px mono row each: `✓ read_script InventoryService.luau ……… 0.1s`. Running calls show a spinner (`rf-spin` 0.8s). Failures get a red ×. They collapse to "5 tool calls" when there are more than 4.
  - **Diff cards**: filename with glyph, +N/−N, then *Open* (opens a diff tab) and *Apply* (`.mini-btn.hot`, sparks). There are 4–8 lines of unified diff preview with ok/err left rules.
  - Agent reports appear as cards linking to the Agents view.
- **Composer**: a bordered box (ember focus ring) with context chips on top (the current file is auto-attached and removable; "3 problems" is attachable; @ adds a file, instance or event) and a 44px auto-growing textarea (max 40% of panel height). Footer: @ button, "Edits need approval" (a permission-mode switch: Ask / Auto-apply / Read-only), `⌘↵`, and the send button (ember, 26×24). Enter adds a newline and ⌘↵ sends. This is the reverse of chat apps on purpose, because it is a code tool.
- Editor integration: ⌘L with a selection opens the panel and adds the selection as a chip. The LSP hover card has "Ask Assistant ⌘L".

### 7.6 Bottom panel
- Tabs (uppercase 10.5/600, ember underline 2px when active): **Output**, **Problems** (count badge, amber for warnings, red for errors), **Dev · Rojo** (raw terminal-like output of the `./dev` and `rojo serve` processes; read-only, with ANSI colours mapped to tokens, plus a "Restart" button).
- Output toolbar: service chips `All · rojo · watcher · blink · luau-lsp · studio`, each with its LED, one selected at a time. ⌥-click selects several. Then on the right: Filter (text filter), Restart selected service, Clear, and Close (×, ⌘J).
- Log line: a grid `64px time | 64px source | message` in mono 12/19. The source is coloured (rojo ember, watcher shared-purple, blink client-green, luau-lsp server-blue, studio amber). Watcher `add` and `del` are coloured ok and err. Paths in messages are links that open in the editor (src paths) or reveal in the tree (instance paths). The view auto-scrolls when at the bottom; otherwise a "↓ 12 new lines" pill appears.
- Problems: grouped by file (glyph, name, path, count), with child rows `⚠ message [line, col] ……… source` where the source is `luau-lsp`, `selene` or `blink`. Click jumps there. Blink parse errors show here and as squiggles in `events.blink`.

### 7.7 Status bar (24px, `--bg-chrome`)
Left to right:
1. **Home** segment: ember gradient, `⚒ GenTree`. It opens the Forge tab.
2. Branch: `⎇ main ↓2`, which opens the Sync view.
3. Service segments: `● Rojo :34872`, `● Watcher`, `● Blink`, `● Studio connecting…`. Each opens Output filtered to that service. A crashed service shows red text and "Crashed", and right-click offers Restart / Stop / Show log.
4. Flexible spacer.
5. Problems: `⚠ 3 ⊗ 0` opens Problems.
6. Realm of the current file: a `SERVER` / `CLIENT` / `SHARED` / `BLINK` tag.
7. Cursor position `Ln 33, Col 58`, then indentation (`Tabs: 4`).
8. LSP: `● luau-lsp` (it pulses while indexing and shows a tooltip with the sourcemap age).
9. Assistant tokens: `⚒ 46.1k · $0.42`, which toggles the Assistant.
10. The notifications bell (toast history).

---

## 8. Workflow QoL

### 8.1 Explorer context menu

On a folder or instance (see `03-context-menu-new.png`):

```
New                              ▸  ┌ SCRIPT · IN <target>
───────────────────────────         │ ModuleScript                 M
Rename                       F2     │ Script                       S
Duplicate                    ⌘D     │ LocalScript                  L
Copy Roblox path            ⌥⌘C     ├ SCAFFOLD
Copy require(…)             ⇧⌘C     │ Feature                      F
Reveal in Finder            ⌥⌘R     │   shared/Features + Service + Controller
───────────────────────────         │ Folder                       D
Delete…                     ⌘⌫      │ Blink event                  E
                                    └   appends to events.blink
```

- The submenu header names the target ("IN FEATURES"). Single-letter accelerators work while the submenu is open.
- On a script, the menu also has *Open*, *Open to the side* and *Ask Assistant about this*. On a Studio-only instance there is only *Copy Roblox path* and *Pull into Rojo…*, which writes it to `src/ServerStorage` via Studio Sync. On a Wally package: *Open docs*, *Update*. On a Blink output: *Open events.blink* (no New/Rename/Delete; these are generated files).
- Hiding vs disabling: items that are impossible for the target are **hidden**. Items that are temporarily blocked are **disabled** with a reason in the tooltip (for example "Rojo isn't serving").
- *Copy require(…)* produces the right form for the realm of the *current editor file*, for example `require(ReplicatedStorage.Shared.Features.Inventory)`, or `require(ServerScriptService.Server.events.server)` for the server Blink module.

### 8.2 Create flow (all "New" items)
1. Insert a placeholder row at the top of the target's children (it auto-expands, `rf-item-in`) with an inline input pre-selected, holding `NewModule`, `NewScript` or `NewFeature`.
2. Live validation under the input (an 11px line in `--err`/`--warn`):
   - PascalCase required for Feature / Service / Controller names (`^[A-Za-z][A-Za-z0-9]*$`, the same rule as `watch-features.sh`). Names starting with `_` or `.` are refused for Feature.
   - Duplicate sibling name gives an error.
   - Lua keywords give an error.
   - Creating a Script inside `ReplicatedStorage` gives the warning "Scripts in ReplicatedStorage don't run (RunContext Legacy)."
   - A ModuleScript under `Controllers` gives the hint "Loaded as a controller by ModuleLoader (Init/Start)."
3. Enter commits and Esc cancels (the row is removed with no trace). Blur commits if the name is valid; otherwise it cancels.
4. On commit: write the files (templates in §8.6), open the main file in a **non-preview** tab with the cursor inside `Init`, flash the new rows, and show a toast. For Feature, the toast reads `Feature "Shop" forged` with `+ ShopService · + ShopController` and *Undo*.

### 8.3 Rename (F2), Duplicate, Delete
- **F2**: inline input over the row with the name selected (not the extension). Renaming a ModuleScript offers in a toast: "Update 4 require() paths?" with *Update* and *Skip*. Renaming a shared Feature folder renames the trio (`XService`, `XController`) in one operation. The watcher would otherwise delete and recreate them and lose code, so **pause the watcher's tick during the operation**. This needs a `KNOWN_*` reset or a temporary stop of `watch-features.sh`; coordinate with the services worker.
- **Duplicate (⌘D)**: creates `NameCopy` next to the original and puts the new row straight into rename mode.
- **Delete**: a confirm dialog *only* when deleting a folder with more than one script, or a shared Feature (the dialog lists the trio: "This also removes `server/Features/Inventory` and `InventoryController` (watcher rule)."). Single scripts delete immediately. Every delete moves the files to the OS trash (`shell.trashItem`) and shows a toast "Deleted X" with **Undo ⌘Z** (6s, timer bar, hover pauses). Undo restores from trash and flashes the row.

### 8.4 Drag to move (Rojo-aware)
- Drag starts after 4px of movement. The ghost is the row's glyph plus name on `--bg-overlay` with `--sh-2`. Hovering a collapsed folder for 600ms expands it.
- On each hover target the drop indicator is either a green inset outline with "Move into Features" (`.drop-ok`) or a red outline with the reason. Validation:

| Case | Result |
|---|---|
| Target is under `Packages` (Wally) | ✗ "Packages are managed by Wally" |
| Target is Studio-only (not in the Rojo project) | ✗ "Not synced by Rojo, the file would be lost" |
| Source is a Blink output | ✗ "Generated by Blink. Edit events.blink instead" |
| Name collision at target | ✗ "Features already has Inventory" (⌥-drop = keep both → `Inventory2`) |
| Server → Shared (ReplicatedStorage) | ⚠ "Clients will be able to read this module" (allowed) |
| Shared → Server | ⚠ "3 client scripts require this" (count via the require index; allowed, with a confirm) |
| Into `shared/Features` as a new top-level folder | ⚠ "The dev watcher will scaffold a Service + Controller" |
| Into a ModuleScript file | ⚠ "Converts Inventory.luau to Inventory/init.luau" |
| Into `Controllers` | ℹ "Will be loaded by ModuleLoader" |

- After the drop, offer to update `require()` paths (toast with a count). The moved row flashes.

### 8.5 Command palette (⌘K) and quick open (⌘P)
One component with modes chosen by prefix: none = quick open, `>` = commands, `@` = symbols in the current file, `#` = instances across the game tree, `:` = go to line. ⌘K opens it with `>`. ⌘P opens it empty. Mode hint chips sit on the right of the input.

- Width 620, top 70px, radius 12, `--sh-3`, with a scrim. Input row 46px (14px text). Rows 32px. Groups have uppercase 10px labels. The selected row has an ember left bar, `--bg-selected` and the ember icon. Matched characters are `<mark>` in `--ember-text` 600. Footer: `↑↓ move · ↵ run · ⌘↵ run, keep open · esc close`.
- **Fuzzy matching** (quick open): fzf-style scoring over file name (×3 weight), instance path (`ReplicatedStorage.Shared.Features.Inventory`, ×2) and file path. Acronyms (`ics` → **I**nventory**C**ontroller **S**…) and path segments (`srv/inv` → `server/Features/Inventory`) both match. Results show the glyph, name, faint Roblox path and realm tag. When the query is empty, show recently opened files.
- **Commands list** (initial set; each lists its shortcut if bound):

| Group | Command | Shortcut |
|---|---|---|
| Create | New Feature… | ⌘⇧N |
| | New ModuleScript… (in selected folder) | ⌘N |
| | New Script… / New LocalScript… | – |
| | New Folder… | – |
| | New Blink event… | – |
| | New project from GenTree template… | – |
| Services | Start / Restart / Stop Rojo | ⌘⇧R (restart) |
| | Restart dev watcher · Restart Blink · Restart Luau LSP | – |
| | Regenerate sourcemap | – |
| | Wally install | – |
| | Connect Studio / Disconnect Studio | – |
| Sync | Sync with collaborators | ⌘⇧S |
| | Resolve next Studio conflict | – |
| | Commit… / Push / Pull | – |
| Navigate | Go to file… | ⌘P |
| | Go to instance… | ⌘⇧P then `#` |
| | Go to symbol… / Go to line… | ⌘⇧O / ⌃G |
| | Reveal active file in tree | ⌥⌘R |
| | Open Forge tab | ⌘⇧H |
| | Go to Service ⇄ Controller ⇄ Shared of this feature | ⌥⌘↑ / ⌥⌘↓ |
| Assistant & agents | Toggle Assistant | ⌘L |
| | New assistant thread | ⌘⇧L |
| | Ask Assistant about selection | ⌘L (with selection) |
| | Explain this problem | ⌘. → "Ask Assistant" |
| | Run test agents… | ⌘⇧A |
| View | Toggle side panel / bottom panel / Assistant | ⌘B / ⌘J / ⌘L |
| | Focus Explorer / Search / Scripts / Events / Packages / Sync / Agents | ⌘⇧E / ⌘⇧F / ⌘⇧J / ⌘⇧V / – / ⌘⇧G / ⌘⇧A |
| | Toggle theme (Dark / Light / System) | – |
| | Motion: Full / Reduced / Off | – |
| | Zoom in / out / reset | ⌘= / ⌘- / ⌘0 |

A "Recently used" group is pinned at the top when the query is empty or matches.

### 8.6 File templates (GenTree conventions)
Rojo naming: `X.luau` → ModuleScript, `X.server.luau` → Script, `X.client.luau` → LocalScript, and a folder with `init(.server|.client).luau` → a script that has children. The Feature templates are **byte-identical** to `tools/watch-features.sh` `sync_feature()`, so it doesn't matter whether Forge or the watcher writes first (both use write-if-missing).

**Feature `Shop`**: Forge writes all four files itself, so it works without `./dev` running. Each file is written only if missing:

`src/shared/Features/Shop/init.luau`
```lua
-- Config/data for Shop. Numbers must be unique to THIS game.
local Shop = {}

return Shop
```
`src/server/Features/Shop/ShopService.luau`
```lua
local ShopService = {}

function ShopService:Init()
end

function ShopService:Start()
end

return ShopService
```
`src/server/Features/Shop/init.server.luau`
```lua
local ShopService = require(script.ShopService)

ShopService:Init()
ShopService:Start()
```
`src/client/Client/Controllers/ShopController/init.luau`
```lua
local ShopController = {}

function ShopController:Init(_janitor)
end

function ShopController:Start()
end

return ShopController
```
After creation, open `ShopService.luau` with the cursor inside `Init`, and keep `init.luau` (shared) and `ShopController` as preview tabs to the right.

**ModuleScript** (`Name.luau`). The body depends on location:
- In `shared/` (generic):
  ```lua
  local Name = {}

  return Name
  ```
- Under `client/Client/Controllers/` (it will be picked up by `ModuleLoader.InitFolder`):
  ```lua
  local Name = {}

  function Name:Init(_janitor)
  end

  function Name:Start()
  end

  return Name
  ```
- Under `server/Features/<F>/` (a service helper module): the generic body.

**Script** (`Name.server.luau`; under `server/` only):
```lua
local ServerScriptService = game:GetService("ServerScriptService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

```
**LocalScript** (`Name.client.luau`; under `client/` only):
```lua
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local player = Players.LocalPlayer
```
Under `ReplicatedStorage`, warn and allow it (the new RunContext rules mean it may still be wanted).

**Folder**: create the directory. If the folder is under `shared/Features`, treat it as a **Feature** (it confirms first: "Create Feature Shop? The watcher will add ShopService + ShopController").

**Blink event**: a small form (or an inline snippet with tab stops) appended to `events.blink`:
```
event Name {
	From: Server,
	Type: Reliable,
	Call: SingleSync,
	Data: struct { }
}
```
The form fields are Name (PascalCase), From (Server | Client segmented), Type (Reliable | Unreliable), Call (SingleSync | SingleAsync | ManySync | ManyAsync, with the default SingleSync) and Data (free text with a Blink-type autocomplete). Saving triggers Blink compile, and the Output shows `blink compiled … → 2 outputs`.

### 8.7 Keyboard shortcuts (⌘ = Ctrl on Windows/Linux)

| Action | Shortcut |
|---|---|
| Command palette | ⌘K (also ⌘⇧P) |
| Quick open (files + instances) | ⌘P |
| Toggle side panel / bottom panel / Assistant | ⌘B / ⌘J / ⌘L |
| New assistant thread | ⌘⇧L |
| Send assistant message | ⌘↵ |
| New ModuleScript in selection | ⌘N |
| New Feature | ⌘⇧N |
| Rename / Duplicate / Delete (tree) | F2 / ⌘D / ⌘⌫ |
| Undo last file operation | ⌘Z (when focus is in the tree, or within 6s of a toast) |
| Copy Roblox path / Copy require | ⌥⌘C / ⇧⌘C |
| Reveal active file in tree | ⌥⌘R |
| Close tab / Reopen closed tab | ⌘W / ⌘⇧T |
| Next / previous tab | ⌃Tab / ⌃⇧Tab (also ⌘⌥→/←) |
| Go to tab 1–9 | ⌘1…⌘9 |
| Split editor right | ⌘\ |
| Save / Save all | ⌘S / ⌥⌘S |
| Go to symbol / line | ⌘⇧O / ⌃G |
| Jump Service ⇄ Controller ⇄ Shared | ⌥⌘↑ / ⌥⌘↓ |
| Quick fix | ⌘. |
| Next / previous problem | F8 / ⇧F8 |
| Sync / Restart Rojo | ⌘⇧S / ⌘⇧R |
| Run test agents | ⌘⇧A |
| Focus views | ⌘⇧E Explorer, ⌘⇧F Search, ⌘⇧J Scripts, ⌘⇧V Events, ⌘⇧G Sync, ⌘⇧A Agents |
| Settings | ⌘, |
| Forge tab | ⌘⇧H |
| Filter tree | ⌥F (in the side panel) |

The app's shortcuts must not be swallowed by Monaco. Register them as Monaco `addCommand` / keybinding overrides for ⌘K, ⌘P, ⌘B, ⌘J and ⌘L (the current code skips ⌘B inside Monaco; flip that).

### 8.8 Empty states
Each is a centred, 13px `--fg-muted` block in the panel with one 16px icon, one line of text and at most two buttons. No illustrations and no chat suggestions.

| Where | Copy | Actions |
|---|---|---|
| No project open (whole window) | The Forge tab shows only **Recent projects** plus "Open folder…" and "New project from GenTree…". The Assistant is closed | Open folder (⌘O), New project |
| Explorer, Rojo not serving and no sourcemap | "No game tree yet. Start Rojo or run ./dev to build the sourcemap." | ▶ Serve, Files view |
| Explorer filter with no match | "No instances match "foo"." | Clear filter |
| `shared/Features` is empty (the folder row expanded) | Inline faint row: "+ New Feature…" | (row is clickable) |
| Problems | "✓ No problems. luau-lsp checked 23 files 4s ago." | – |
| Output for a stopped service | "Rojo is stopped." | ▶ Start |
| Events, no `events.blink` | "No Blink file. Create events.blink with client/server outputs?" | Create |
| Packages, no `wally.toml` | "Not a Wally project." | – |
| Sync, up to date | "✓ Up to date with origin/main · last sync 7 min ago" | Sync now |
| Agents, no runs | "Agents play your game in Studio and report what broke." | New run |
| Assistant, new thread | Three faint mono lines with context: "Context: InventoryService.luau · 3 problems", "@ to add files, instances, events", "⌘↵ to send". No greeting and no suggestion cards | – |
| Editor, all tabs closed | The Forge tab | – |

---

## 9. Mapping to the current code (`src/renderer/src`)

| Today | Becomes |
|---|---|
| `styles.css` `:root` palette (warm Claude browns, serif) | §2–§6 tokens. Delete `--serif`. Rename `--accent*` to `--ember*` |
| `App.tsx` `.app` (sidebar + chat-pane + editor split) | `Shell` = Titlebar + ActivityBar + SidePanel + EditorArea (Tabs, Crumbs, views) + BottomPanel + AssistantPanel + StatusBar |
| `panels/Sidebar.tsx` (New chat, Recents, Explorer/Scripts switch) | `ActivityBar` + `SidePanel` views. **Remove chat recents from the sidebar**; history lives behind the Assistant clock button |
| `panels/Chat.tsx` (centre, greeting, suggestions) | `AssistantPanel` (right, compact). Delete the greeting and suggestion grid |
| `panels/EditorPane.tsx` | `EditorArea` with multiple tab kinds: script, diff, conflict, agent run, settings, forge |
| `panels/ExplorerPanel.tsx`, `ScriptsPanel.tsx` | Explorer view (game tree / files / features) and Scripts view |
| `panels/LogsDrawer.tsx` | BottomPanel → Output + Dev·Rojo |
| `panels/SyncDrawer.tsx` | Sync side view + conflict editor tab |
| `panels/AgentsDrawer.tsx` | Agents side view + run editor tab |
| `panels/StatusBar.tsx` | New status bar (§7.7) |
| `components/ClassIcon.tsx` | New realm-aware glyphs (§5) |
| `components/Menu.tsx` | Menu with submenus, accelerators, safe-triangle, `rf-menu-in` |
| `components/Drawer.tsx` | Retire it. Drawers become views and tabs |
| `theme.ts` | Monaco `forge-dark` / `forge-light` from `--syn-*` |
