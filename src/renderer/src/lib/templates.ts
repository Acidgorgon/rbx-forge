// GenTree file templates and the create flow (SPEC §8.2, §8.6). Feature templates are byte-identical
// to tools/watch-features.sh sync_feature(), and every file is written only when missing, so it does
// not matter whether Forge or the dev watcher writes first.
import type { TreeNode } from '@shared/types'
import { storybookFile, storyFile } from '@shared/storyTemplates'
import { dirname, findNode, roots } from './roblox'

export { storyCovered } from '@shared/storyTemplates'

export type NewKind = 'ModuleScript' | 'Script' | 'LocalScript' | 'Feature' | 'Folder' | 'Story' | 'Storybook'

export function featureFiles(name: string): { path: string; contents: string }[] {
  return [
    { path: `src/shared/Features/${name}/init.luau`, contents: `-- Config/data for ${name}. Numbers must be unique to THIS game.\nlocal ${name} = {}\n\nreturn ${name}\n` },
    {
      path: `src/server/Features/${name}/${name}Service.luau`,
      contents: `local ${name}Service = {}\n\nfunction ${name}Service:Init()\nend\n\nfunction ${name}Service:Start()\nend\n\nreturn ${name}Service\n`
    },
    { path: `src/server/Features/${name}/init.server.luau`, contents: `local ${name}Service = require(script.${name}Service)\n\n${name}Service:Init()\n${name}Service:Start()\n` },
    {
      path: `src/client/Client/Controllers/${name}Controller/init.luau`,
      contents: `local ${name}Controller = {}\n\nfunction ${name}Controller:Init(_janitor)\nend\n\nfunction ${name}Controller:Start()\nend\n\nreturn ${name}Controller\n`
    }
  ]
}

export function scriptFile(kind: 'ModuleScript' | 'Script' | 'LocalScript', dir: string, name: string): { path: string; contents: string } {
  if (kind === 'Script') {
    return { path: `${dir}/${name}.server.luau`, contents: `local ServerScriptService = game:GetService("ServerScriptService")\nlocal ReplicatedStorage = game:GetService("ReplicatedStorage")\n\n` }
  }
  if (kind === 'LocalScript') {
    return { path: `${dir}/${name}.client.luau`, contents: `local Players = game:GetService("Players")\nlocal ReplicatedStorage = game:GetService("ReplicatedStorage")\n\nlocal player = Players.LocalPlayer\n` }
  }
  if (/(^|\/)client\/Client\/Controllers(\/|$)/.test(dir)) {
    return { path: `${dir}/${name}.luau`, contents: `local ${name} = {}\n\nfunction ${name}:Init(_janitor)\nend\n\nfunction ${name}:Start()\nend\n\nreturn ${name}\n` }
  }
  return { path: `${dir}/${name}.luau`, contents: `local ${name} = {}\n\nreturn ${name}\n` }
}

const isInit = (p: string) => /\/init(\.(server|client))?\.luau?$/.test(p)

function strip(dir: string, n: number): string {
  let d = dir
  for (let i = 0; i < n; i++) d = dirname(d)
  return d
}

// Instance a repo directory maps to (the inverse of dirForInstance), or null when it maps to none.
export function instanceForDir(tree: TreeNode[], dir: string): string[] | null {
  const walk = (nodes: TreeNode[], parent: string[]): string[] | null => {
    for (const n of nodes) {
      if (n.origin === 'studio' || (!n.children.length && n.filePath && !isInit(n.filePath))) continue
      const ip = [...parent, n.name]
      if (dirForInstance(tree, ip) === dir) return ip
      const hit = walk(n.children, ip)
      if (hit) return hit
    }
    return null
  }
  return walk(tree, [])
}

// Repo directory that maps to an instance, inferred from the files under it (Rojo maps folder
// names to instance names). null when it cannot hold new files (Studio-only, Wally, plain file).
export function dirForInstance(tree: TreeNode[], instancePath: string[]): string | null {
  const node = findNode(tree, instancePath)
  if (!node || node.origin === 'studio') return null
  if (instancePath.includes('Packages') || instancePath.includes('_Index')) return null
  if (node.filePath) return isInit(node.filePath) ? dirname(node.filePath) : null
  // A descendant file tells where this folder lives.
  const search = (nodes: TreeNode[], depth: number): string | null => {
    for (const c of nodes) {
      if (c.filePath) return isInit(c.filePath) ? strip(dirname(c.filePath), depth) : strip(dirname(c.filePath), depth - 1)
    }
    for (const c of nodes) {
      const hit = search(c.children, depth + 1)
      if (hit) return hit
    }
    return null
  }
  const found = search(node.children, 1)
  if (found !== null) return found || null
  // Empty folder: parent's directory plus the name.
  if (instancePath.length > 1) {
    const parent = dirForInstance(tree, instancePath.slice(0, -1))
    if (parent) return `${parent}/${node.name}`
  }
  const key = instancePath.join('/')
  const known: Record<string, string> = { 'ReplicatedStorage/Shared': 'src/shared', 'ServerScriptService/Server': 'src/server', 'StarterPlayer/StarterPlayerScripts/Client': 'src/client/Client' }
  return known[key] ?? null
}

// Default target for a create request when nothing is selected.
export function defaultTarget(tree: TreeNode[], kind: NewKind): string[] | null {
  const candidates: Record<NewKind, string[][]> = {
    Feature: [['ReplicatedStorage', 'Shared', 'Features']],
    ModuleScript: [['ReplicatedStorage', 'Shared', 'Modules'], ['ReplicatedStorage', 'Shared']],
    Folder: [['ReplicatedStorage', 'Shared']],
    Story: [['ReplicatedStorage', 'Shared', 'Interface', 'Stories'], ['ReplicatedStorage', 'Shared', 'Interface'], ['ReplicatedStorage', 'Shared']],
    Storybook: [['ReplicatedStorage', 'Shared', 'Interface', 'Stories'], ['ReplicatedStorage', 'Shared', 'Interface'], ['ReplicatedStorage', 'Shared']],
    Script: [['ServerScriptService', 'Server']],
    LocalScript: [['StarterPlayer', 'StarterPlayerScripts', 'Client']]
  }
  for (const c of candidates[kind]) if (findNode(tree, c)) return c
  const first = roots(tree).find((n) => n.origin !== 'studio')
  return first ? [first.name] : null
}

export function realmOfDir(dir: string): 'server' | 'client' | 'shared' | null {
  if (/^src\/server(\/|$)/.test(dir)) return 'server'
  if (/^src\/client(\/|$)/.test(dir)) return 'client'
  if (/^src\/shared(\/|$)/.test(dir)) return 'shared'
  return null
}

// Hint/warning shown under the inline name input.
export function createHint(kind: NewKind, dir: string | null, instancePath: string[]): { level: 'warn' | 'info'; text: string } | null {
  if (kind === 'Script' && instancePath[0] === 'ReplicatedStorage') return { level: 'warn', text: "Scripts in ReplicatedStorage don't run (RunContext Legacy)." }
  if (kind === 'LocalScript' && instancePath[0] === 'ReplicatedStorage') return { level: 'warn', text: "LocalScripts in ReplicatedStorage don't run." }
  if (kind === 'ModuleScript' && dir && /client\/Client\/Controllers/.test(dir)) return { level: 'info', text: 'Loaded as a controller by ModuleLoader (Init/Start).' }
  if (kind === 'Feature') return { level: 'info', text: 'Creates shared/Features + Service + Controller.' }
  if (kind === 'Story') return { level: 'info', text: 'UI Labs story (Vide); shows up in UI Preview.' }
  if (kind === 'Storybook') return { level: 'info', text: 'Lists the stories in this folder and below.' }
  if (kind === 'Folder' && dir && /src\/shared\/Features$/.test(dir)) return { level: 'info', text: 'A folder here is a Feature: the watcher adds a Service and Controller.' }
  return null
}

export async function exists(path: string): Promise<boolean> {
  try {
    await window.harness.readFile(path)
    return true
  } catch {
    return false
  }
}

// Writes the files that are missing; returns the paths written and the main file to open.
export async function createItem(kind: NewKind, dir: string | null, name: string): Promise<{ written: string[]; open: string | null; line: number }> {
  const h = window.harness
  const written: string[] = []
  const put = async (path: string, contents: string) => {
    if (await exists(path)) return
    await h.writeFile(path, contents)
    written.push(path)
  }
  if (kind === 'Feature' || (kind === 'Folder' && dir && /src\/shared\/Features$/.test(dir))) {
    for (const f of featureFiles(name)) await put(f.path, f.contents)
    return { written, open: `src/server/Features/${name}/${name}Service.luau`, line: 4 }
  }
  if (!dir) throw new Error('This location is not mapped to a folder in the repo.')
  if (kind === 'Folder') {
    // git keeps empty folders only with a file in them; Rojo ignores .gitkeep.
    await put(`${dir}/${name}/.gitkeep`, '')
    return { written, open: null, line: 1 }
  }
  const f = kind === 'Story' ? storyFile(dir, name) : kind === 'Storybook' ? storybookFile(dir, name) : scriptFile(kind, dir, name)
  await put(f.path, f.contents)
  if (!written.length) throw new Error(`${f.path} already exists.`)
  if (kind === 'Story') return { written, open: f.path, line: f.contents.split('\n').indexOf('\tstory = function(props)') + 2 }
  const line = f.contents.split('\n').findIndex((l) => /:Init\(/.test(l))
  return { written, open: f.path, line: line >= 0 ? line + 2 : f.contents.split('\n').length }
}
