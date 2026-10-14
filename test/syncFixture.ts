// Synthetic project shaped like FSF (two places cross-mounting src/skills, nested $path inside
// $path, $path to single files, $ignoreUnknownInstances, Packages, a studio-sync skip list), plus a
// tiny Rojo-like builder that turns the disk into the Studio snapshot the Forge Bridge would send.
// No game code: every source is a placeholder.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { StudioNode } from '../src/shared/sync/types.ts'
import { parseFileName, type PlaceMap } from '../src/main/services/sync/mapping.ts'
import { readModel, type ModelNode } from '../src/main/services/sync/modelJson.ts'

export const MATCH_PLACE = 1001
export const MENU_PLACE = 2001
export const MENU_PLACE_2 = 2002

export function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

export function get(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

const matchProject = {
  name: 'Arena',
  servePlaceIds: [MATCH_PLACE],
  tree: {
    $className: 'DataModel',
    ReplicatedStorage: {
      Shared: {
        $path: 'src/shared',
        $ignoreUnknownInstances: true,
        Skills: {
          $path: 'src/skills/Definitions',
          MatchController: { $path: 'src/skills/Client' }
        }
      },
      Packages: { $path: 'Packages' }
    },
    ServerScriptService: {
      Server: {
        $className: 'Folder',
        $ignoreUnknownInstances: true,
        Handlers: { $path: 'src/server/Handlers' },
        Config: { $path: 'src/server/Config' },
        Bootstrapper: { $path: 'src/server/Bootstrapper.server.luau' },
        Features: {
          $className: 'Folder',
          $path: 'src/server/Features',
          Skills: { $path: 'src/skills/Server' }
        }
      }
    },
    ServerStorage: { $path: 'src/ServerStorage', $ignoreUnknownInstances: true },
    StarterPlayer: {
      StarterPlayerScripts: { Client: { $path: 'src/client', $ignoreUnknownInstances: true } }
    }
  }
}

const menuProject = {
  name: 'Menu',
  servePort: 34875,
  servePlaceIds: [MENU_PLACE, MENU_PLACE_2],
  tree: {
    $className: 'DataModel',
    ReplicatedStorage: {
      Shared: {
        $className: 'Folder',
        Modules: {
          $path: 'src/menu/shared/Modules',
          $ignoreUnknownInstances: true,
          SharedConfig: { $path: 'src/shared/Modules/SharedConfig.luau' }
        },
        Skills: { $path: 'src/skills/Definitions' }
      },
      Packages: { $path: 'Packages' }
    },
    ServerScriptService: {
      Server: {
        $path: 'src/menu/server',
        $ignoreUnknownInstances: true,
        Config: { $className: 'Folder', Admins: { $path: 'src/server/Config/Admins.luau' } },
        Features: {
          $className: 'Folder',
          Skills: {
            $className: 'Folder',
            Catalog: { $path: 'src/skills/Server/Catalog.luau' },
            Moves: { $path: 'src/skills/Server/Moves' }
          }
        }
      }
    }
  }
}

const ANIMATIONS = {
  ClassName: 'Folder',
  Children: [
    { Name: 'Activation', ClassName: 'Animation', Properties: { AnimationId: 'rbxassetid://1001' } },
    { Name: 'Left', ClassName: 'Animation', Properties: { AnimationId: 'rbxassetid://1002' } }
  ]
}

export const FILES: Record<string, string> = {
  'src/shared/Modules/SharedConfig.luau': 'local SharedConfig = {}\nSharedConfig.MaxPlayers = 8\nreturn SharedConfig\n',
  'src/shared/Modules/Util.luau': 'return {}\n',
  'src/skills/Definitions/Dash.luau': 'return {\n\tname = "Dash",\n\tcooldown = 3,\n}\n',
  'src/skills/Definitions/Guard.luau': 'return { name = "Guard" }\n',
  'src/skills/Client/init.luau': 'local MatchController = {}\nreturn MatchController\n',
  'src/skills/Client/Input.luau': 'return {}\n',
  'src/skills/Server/Catalog.luau': 'local Catalog = {}\n\nCatalog.list = { "Dash" }\n\nreturn Catalog\n',
  'src/skills/Server/Schema.luau': 'return {}\n',
  'src/skills/Server/Moves/Dash/Config.luau': 'return {\n\tdamage = 10,\n\trange = 4,\n\tspeed = 20,\n\tduration = 0.4,\n}\n',
  'src/skills/Server/Moves/Dash/Server.luau': 'local Server = {}\n\nfunction Server.run(player)\n\treturn player\nend\n\nreturn Server\n',
  'src/skills/Server/Moves/Dash/Animations.model.json': JSON.stringify(ANIMATIONS, null, 2) + '\n',
  'src/server/Handlers/Combat.luau': 'return {}\n',
  'src/server/Config/Admins.luau': 'return { 1 }\n',
  'src/server/Bootstrapper.server.luau': 'print("boot")\n',
  'src/server/Features/Round.server.luau': 'print("round")\n',
  'src/client/init.client.luau': 'print("client")\n',
  'src/menu/shared/Modules/MenuUtil.luau': 'return {}\n',
  'src/menu/server/Lobby.server.luau': 'print("lobby")\n',
  'Packages/Promise.luau': 'return {}\n',
  'src/ServerStorage/Loot.luau': 'return {}\n'
}

export function makeFsfProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-sync-'))
  put(root, 'default.project.json', JSON.stringify(matchProject, null, 2))
  put(root, 'menu.project.json', JSON.stringify(menuProject, null, 2))
  put(root, 'tools/studio-sync.json', JSON.stringify({ port: 34873, placeIds: [MATCH_PLACE], skip: ['Packages', 'src/ServerStorage'], projects: [{ file: 'menu.project.json', placeIds: [MENU_PLACE, MENU_PLACE_2] }] }))
  put(root, '.gitignore', 'Packages/\n')
  for (const [rel, text] of Object.entries(FILES)) put(root, rel, text)
  return root
}

// ---- Rojo-like build of the Studio side from the disk ----

function modelNodes(model: ModelNode, path: string[], out: StudioNode[]): void {
  out.push({ id: path.join('/'), path, className: model.className, properties: model.properties, attributes: model.attributes, tags: model.tags.length ? model.tags : undefined })
  for (const child of model.children) modelNodes(child, [...path, child.name!], out)
}

function readMetaRunContext(file: string): StudioNode['runContext'] | undefined {
  try {
    const rc = JSON.parse(readFileSync(file, 'utf8')).properties?.RunContext
    return rc === 'Server' || rc === 'Client' || rc === 'Plugin' ? rc : undefined
  } catch {
    return undefined
  }
}

function buildDir(abs: string, path: string[], out: StudioNode[], self: boolean): void {
  const entries = readdirSync(abs)
  const init = entries.find((e) => /^init(\.server|\.client)?\.luau?$/.test(e))
  if (self) {
    if (init) {
      const info = parseFileName(init)!
      out.push({ id: path.join('/'), path, className: info.className!, source: readFileSync(join(abs, init), 'utf8'), runContext: readMetaRunContext(join(abs, 'init.meta.json')) })
    } else {
      let className = 'Folder'
      try {
        className = JSON.parse(readFileSync(join(abs, 'init.meta.json'), 'utf8')).className ?? 'Folder'
      } catch {
        // plain folder
      }
      out.push({ id: path.join('/'), path, className })
    }
  }
  for (const e of entries.sort()) {
    const full = join(abs, e)
    if (statSync(full).isDirectory()) {
      buildDir(full, [...path, e], out, true)
      continue
    }
    const info = parseFileName(e)
    if (!info || info.stem === null) continue
    if (info.kind === 'script') {
      const rc = info.plugin ? 'Plugin' : readMetaRunContext(join(abs, `${info.stem}.meta.json`))
      out.push({ id: [...path, info.stem].join('/'), path: [...path, info.stem], className: info.className!, source: readFileSync(full, 'utf8'), runContext: rc })
    } else if (info.kind === 'model') modelNodes(readModel(readFileSync(full, 'utf8')), [...path, info.stem], out)
  }
}

// What the plugin's snapshot would contain for this place: each root and its descendants.
export function studioFromDisk(root: string, map: PlaceMap): StudioNode[] {
  const out: StudioNode[] = []
  for (const r of map.roots) {
    const abs = join(root, r.path)
    if (r.isFile) {
      const info = parseFileName(r.path.split('/').pop()!)!
      if (info.kind === 'script') out.push({ id: r.instance.join('/'), path: r.instance, className: info.className!, source: readFileSync(abs, 'utf8') })
      else if (info.kind === 'model') modelNodes(readModel(readFileSync(abs, 'utf8')), r.instance, out)
    } else buildDir(abs, r.instance, out, true)
  }
  return out
}

// Replace (or add) the node at `path` in a snapshot.
export function edit(nodes: StudioNode[], path: string[], patch: Partial<StudioNode>): StudioNode[] {
  const key = path.join('/')
  const hit = nodes.find((n) => n.path.join('/') === key)
  if (!hit) throw new Error(`no node ${key}`)
  return nodes.map((n) => (n === hit ? { ...n, ...patch } : n))
}

export function find(nodes: StudioNode[], path: string[]): StudioNode {
  const hit = nodes.find((n) => n.path.join('/') === path.join('/'))
  if (!hit) throw new Error(`no node ${path.join('/')}`)
  return hit
}

// Every file under root (relative), for "nothing else was touched" checks.
export function listFiles(root: string, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (skip(child)) continue
      if (e.isDirectory()) walk(child)
      else out.push(child)
    }
  }
  walk('')
  return out.sort()
}

// The user linked these Studio places to place files in Source Control (.forge/sync/links.json):
// keys `place:<PlaceId>` (published) or `local:<link id>` (unpublished; the plugin sends ?link=).
export function linkPlaces(root: string, links: Record<string, string>): void {
  mkdirSync(join(root, '.forge', 'sync'), { recursive: true })
  const data = { version: 1, links: Object.fromEntries(Object.entries(links).map(([k, projectFile]) => [k, { projectFile, at: 1 }])) }
  writeFileSync(join(root, '.forge', 'sync', 'links.json'), JSON.stringify(data, null, 2))
}
