// Installing the Forge Bridge plugin: where Studio looks for local plugins, and the .rbxmx file Forge
// writes there (a Script holding resources/studio/ForgeBridge.luau with the port and version filled in).
//
// Local plugins folder (Studio: Plugins tab > Plugins Folder opens it, see
// https://create.roblox.com/docs/studio/plugins). The paths, as Rojo's and other tools' installers
// use them (e.g. https://docs.rbxsync.dev/plugin/installation):
//   Windows: %LOCALAPPDATA%\Roblox\Plugins
//   macOS:   ~/Documents/Roblox/Plugins
// Roblox Studio does not run on Linux, so there is no folder there.

export const PLUGIN_FILE = 'ForgeBridge.rbxmx'
export const PLUGIN_VERSION = 12 // 2: Forge Sync (snapshot + change stream); 3: unsynced Instance-reference report; 4: viewport snapshot job (Thumbnail Lab); 5: Game-tab outline of the mapped services (Studio-only instances); 6: sync picks up mapped roots created after it started (Rojo connecting later) and Script Editor text in unpublished places; 7: the Game-tab outline keeps up with deletes, and Delete in Studio (the one, user-confirmed write; Ctrl+Z restores); 8: place linking (probe id per run, ForgeSyncLink attribute for unpublished places linked in Forge); 9: renames, moves and removes carry exactly their own subtree (same-name siblings, e.g. a Ctrl+D copy, keep theirs); 10: Model Lab "Build in Studio" (model jobs: one Model built in Workspace and selected, undoable); 11: same-name places told apart (config fingerprint: Workspace names + script count; Identify banner for an unlinked place); 12: polls carry the window's sync session, so Forge re-checks a linked place it lost the session of (resync) instead of waiting for its next edit
// The oldest Forge Bridge plugin whose Studio check may clear the rojo gate (Forge Sync on). A Studio
// still running an older one (not restarted after an update) keeps rojo serve waiting with "Restart
// Studio": v9's snapshot and removes carry Studio-only scripts (and same-name copies) exactly, so Rojo
// is never let in to delete what an older plugin reported wrongly. Bump only for safety fixes.
export const SYNC_GATE_PLUGIN_VERSION = 9
const VERSION_RE = /--\s*forge-bridge-version:\s*(\d+)/
// The template's own version line (resources/studio/ForgeBridge.luau). Templates from before v7 have
// none; they are v6 or older.
const TEMPLATE_RE = /--\s*forge-bridge-template:\s*(\d+)/
const UNMARKED_TEMPLATE_VERSION = 6

// The plugin template ships next to the main bundle (out/main/studio/ForgeBridge.luau, emitted by
// electron.vite.config.ts) so a quick update (code only: out/main, out/preload, out/renderer) carries
// plugin fixes too; resources/studio (extraResources) is the full installer's copy and the fallback.
export const PLUGIN_TEMPLATE_FILE = 'ForgeBridge.luau'
export const BUNDLED_TEMPLATE_DIR = 'studio'

export function pluginTemplateVersion(template: string): number {
  const m = TEMPLATE_RE.exec(template)
  return m ? Number(m[1]) : UNMARKED_TEMPLATE_VERSION
}

export interface PathEnv {
  platform: string
  env: Record<string, string | undefined>
  home: string
}

export function pluginsDir(p: PathEnv): string | null {
  if (p.platform === 'win32') {
    const local = p.env.LOCALAPPDATA || winJoin(p.home, 'AppData', 'Local')
    return winJoin(local, 'Roblox', 'Plugins')
  }
  if (p.platform === 'darwin') return posixJoin(p.home, 'Documents', 'Roblox', 'Plugins')
  return null
}

function winJoin(...parts: string[]): string {
  return parts.map((s, i) => (i === 0 ? s.replace(/[\\/]+$/, '') : s.replace(/^[\\/]+|[\\/]+$/g, ''))).join('\\')
}

function posixJoin(...parts: string[]): string {
  return parts.map((s, i) => (i === 0 ? s.replace(/\/+$/, '') : s.replace(/^\/+|\/+$/g, ''))).join('/')
}

// The plugin source with Forge's port and the version stamped in.
export function pluginSource(template: string, opts: { port: number; version?: number }): string {
  return template.replaceAll('__FORGE_PORT__', String(opts.port)).replaceAll('__FORGE_BRIDGE_VERSION__', String(opts.version ?? PLUGIN_VERSION))
}

export function pluginVersionOf(text: string): number | null {
  const m = VERSION_RE.exec(text)
  return m ? Number(m[1]) : null
}

// A model file with one Script (local plugins are Scripts; Studio runs them with the `plugin` global).
export function pluginRbxmx(source: string, name = 'ForgeBridge'): string {
  const cdata = source.split(']]>').join(']]]]><![CDATA[>')
  return [
    '<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">',
    '\t<External>null</External>',
    '\t<External>nil</External>',
    '\t<Item class="Script" referent="RBX0">',
    '\t\t<Properties>',
    `\t\t\t<string name="Name">${name}</string>`,
    '\t\t\t<bool name="Disabled">false</bool>',
    `\t\t\t<ProtectedString name="Source"><![CDATA[${cdata}]]></ProtectedString>`,
    '\t\t</Properties>',
    '\t</Item>',
    '</roblox>',
    ''
  ].join('\n')
}
