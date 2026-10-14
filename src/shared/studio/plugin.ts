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
export const PLUGIN_VERSION = 4 // 2: Forge Sync (snapshot + change stream); 3: unsynced Instance-reference report; 4: viewport snapshot job (Thumbnail Lab)
const VERSION_RE = /--\s*forge-bridge-version:\s*(\d+)/

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
