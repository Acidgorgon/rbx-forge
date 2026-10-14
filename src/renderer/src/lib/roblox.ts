// Roblox/GenTree helpers for the renderer: realms, display names, requires.
import type { ScriptEntry, ScriptKind, TreeNode } from '@shared/types'

export type Realm = 'server' | 'client' | 'shared' | 'studio'

const SERVER_ROOTS = new Set(['ServerScriptService', 'ServerStorage'])
const CLIENT_ROOTS = new Set(['StarterPlayer', 'StarterGui', 'StarterPack', 'ReplicatedFirst', 'StarterPlayerScripts', 'StarterCharacterScripts'])

// Realm of an instance from the service it lives under.
export function realmOfInstance(instancePath: string[]): Realm | undefined {
  const root = instancePath[0]
  if (!root) return undefined
  if (SERVER_ROOTS.has(root)) return 'server'
  if (CLIENT_ROOTS.has(root)) return 'client'
  if (root === 'ReplicatedStorage') return 'shared'
  return undefined
}

// Realm of a repo file from GenTree's src/ layout.
export function realmOfFile(path: string): Realm | undefined {
  if (/^src\/server\//.test(path)) return 'server'
  if (/^src\/client\//.test(path)) return 'client'
  if (/^src\/shared\//.test(path)) return 'shared'
  return undefined
}

export function kindOfFile(path: string): ScriptKind | 'Blink' | 'File' {
  if (/\.blink$/.test(path)) return 'Blink'
  if (/\.server\.luau?$/.test(path)) return 'Script'
  if (/\.client\.luau?$/.test(path)) return 'LocalScript'
  if (/\.luau?$/.test(path)) return 'ModuleScript'
  return 'File'
}

// Roblox name of a file: init files are named after their folder; extensions dropped.
export function instanceNameOfFile(path: string): string {
  const parts = path.split('/')
  const file = parts[parts.length - 1]
  if (/^init(\.(server|client))?\.luau?$/.test(file) && parts.length > 1) return parts[parts.length - 2]
  if (!/\.luau?$/.test(file)) return file
  return file.replace(/(\.(server|client))?\.luau?$/, '')
}

// "init" / "init.server" / "init.client" suffix when the script is a folder with an init file.
export function initSuffix(path: string | undefined): string | null {
  if (!path) return null
  const m = /\/(init(?:\.(server|client))?)\.luau?$/.exec(path)
  return m ? m[1] : null
}

export function basename(path: string): string {
  return path.split('/').pop() ?? path
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

// Flattens the explorer tree (skipping a DataModel root).
export function roots(tree: TreeNode[]): TreeNode[] {
  if (tree.length === 1 && tree[0].className === 'DataModel') return tree[0].children
  return tree
}

// Instance path for a file, from the tree (first node with that filePath).
export function instancePathOfFile(tree: TreeNode[], path: string): string[] | null {
  const walk = (nodes: TreeNode[], parent: string[]): string[] | null => {
    for (const n of nodes) {
      const here = [...parent, n.name]
      if (n.filePath === path) return here
      const hit = walk(n.children, here)
      if (hit) return hit
    }
    return null
  }
  return walk(roots(tree), [])
}

export function findNode(tree: TreeNode[], instancePath: string[]): TreeNode | null {
  let nodes = roots(tree)
  let node: TreeNode | null = null
  for (const name of instancePath) {
    node = nodes.find((n) => n.name === name) ?? null
    if (!node) return null
    nodes = node.children
  }
  return node
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

// require(...) expression for an instance path, e.g. require(ReplicatedStorage.Shared.Features.Inventory).
export function requireExpression(instancePath: string[]): string {
  const [service, ...rest] = instancePath
  let expr = service ?? 'game'
  for (const n of rest) expr += IDENT.test(n) ? `.${n}` : `[${JSON.stringify(n)}]`
  return `require(${expr})`
}

export function scriptsFlat(groups: { scripts: ScriptEntry[] }[]): ScriptEntry[] {
  return groups.flatMap((g) => g.scripts)
}

// Feature folders: src/shared/Features/<F>, src/server/Features/<F>, client Controllers/<F>Controller.
export interface FeatureInfo {
  name: string
  shared?: string
  service?: string
  controller?: string
}

// What "Delete Feature" moves to the trash: each part's own folder (or file, for a single-file part),
// as featuresOf found them. Controller and Service first, the shared part last: the template's ./dev
// watcher deletes a feature's Service and Controller (for good, not to the trash) when its shared
// folder goes, so by then there is nothing left for it to delete.
export interface FeatureDeleteTarget {
  part: 'Controller' | 'Service' | 'shared'
  path: string
  isDir: boolean
}

export function featureDeleteTargets(f: FeatureInfo): FeatureDeleteTarget[] {
  const out: FeatureDeleteTarget[] = []
  const name = f.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (f.controller) {
    const m = new RegExp(`^(.*/Controllers/${name}Controller)/init\\.luau?$`).exec(f.controller)
    out.push(m ? { part: 'Controller', path: m[1], isDir: true } : { part: 'Controller', path: f.controller, isDir: false })
  }
  if (f.service) {
    const m = new RegExp(`^(src/server/Features/${name})/${name}Service\\.luau?$`).exec(f.service)
    out.push(m ? { part: 'Service', path: m[1], isDir: true } : { part: 'Service', path: f.service, isDir: false })
  }
  if (f.shared) {
    const m = new RegExp(`^(src/shared/Features/${name})/init\\.luau?$`).exec(f.shared)
    out.push(m ? { part: 'shared', path: m[1], isDir: true } : { part: 'shared', path: f.shared, isDir: false })
  }
  return out
}

export function featuresOf(scripts: ScriptEntry[]): FeatureInfo[] {
  const map = new Map<string, FeatureInfo>()
  const get = (name: string) => {
    let f = map.get(name)
    if (!f) map.set(name, (f = { name }))
    return f
  }
  for (const s of scripts) {
    let m = /^src\/shared\/Features\/([^/]+)\/init\.luau?$/.exec(s.path) ?? /^src\/shared\/Features\/([^/]+)\.luau?$/.exec(s.path)
    if (m) get(m[1]).shared = s.path
    m = /^src\/server\/Features\/([^/]+)\/\1Service\.luau?$/.exec(s.path)
    if (m) get(m[1]).service = s.path
    m = /^src\/client\/Client\/Controllers\/([^/]+)Controller(?:\/init)?\.luau?$/.exec(s.path)
    if (m) get(m[1]).controller = s.path
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}
