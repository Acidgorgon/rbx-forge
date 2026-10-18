// Rojo's file -> instance mapping, written as a Rojo sourcemap ({ name, className, filePaths,
// children }) for the Lune runner, plus spec discovery over it.
//
// Built straight from default.project.json and the files on disk (not from sourcemap.json, which can
// lag a just-saved spec). Follows Rojo 7: $path folders, init(.server|.client).luau/.lua, *.server /
// *.client scripts, JSON modules, .txt StringValues, init.meta.json className, and a nested
// default.project.json inside a folder (how Wally packages map). Specs in a top-level tests/ folder
// that Rojo does not map go under game.ForgeTests.

import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { rojoGlob } from '../sync/mapping.ts'
import type { Realm, SpecFile } from './types.ts'

export interface SourcemapNode {
  name: string
  className: string
  filePaths?: string[]
  children?: SourcemapNode[]
}

export const TESTS_FOLDER = 'tests'
export const TESTS_INSTANCE = 'ForgeTests'

const SERVICES = new Set([
  'Workspace', 'Players', 'Lighting', 'ReplicatedFirst', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage',
  'StarterGui', 'StarterPack', 'StarterPlayer', 'SoundService', 'Teams', 'TextChatService', 'Chat',
  'LocalizationService', 'MaterialService', 'TestService', 'HttpService', 'RunService'
])
const CLIENT_ROOTS = new Set(['StarterPlayer', 'StarterGui', 'ReplicatedFirst', 'StarterPack'])
const INIT_FILES: [string, string][] = [
  ['init.server.luau', 'Script'],
  ['init.client.luau', 'LocalScript'],
  ['init.luau', 'ModuleScript'],
  ['init.server.lua', 'Script'],
  ['init.client.lua', 'LocalScript'],
  ['init.lua', 'ModuleScript']
]

// "Foo.server.luau" -> Script "Foo"; "Foo.spec.luau" -> ModuleScript "Foo.spec" (as Rojo names it).
export function fileInstance(fileName: string): { name: string; className: string } | null {
  const script = /^(.+?)(\.server|\.client)?\.(luau|lua)$/.exec(fileName)
  if (script) {
    const className = script[2] === '.server' ? 'Script' : script[2] === '.client' ? 'LocalScript' : 'ModuleScript'
    return { name: script[1], className }
  }
  if (/\.(meta|model|project)\.json$/.test(fileName)) return null
  const json = /^(.+)\.json$/.exec(fileName)
  if (json) return { name: json[1], className: 'ModuleScript' }
  const txt = /^(.+)\.txt$/.exec(fileName)
  if (txt) return { name: txt[1], className: 'StringValue' }
  return null
}

function isScriptFile(path: string): boolean {
  return /\.(luau|lua)$/.test(path)
}

export function isSpecFile(path: string): boolean {
  return /\.spec\.(luau|lua)$/.test(path)
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

function projectPath(node: Record<string, unknown>): string | undefined {
  const value = node.$path
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof (value as { optional?: unknown }).optional === 'string') {
    return (value as { optional: string }).optional
  }
  return undefined
}

interface Builder {
  root: string
  // Guards against a project that includes itself.
  depth: number
  // globIgnorePaths of the project files on the way here (each relative to its project's folder).
  ignore?: { base: string; globs: RegExp[] }[]
}

function withIgnore(b: Builder, base: string, project: { globIgnorePaths?: unknown }): Builder {
  const globs = (Array.isArray(project.globIgnorePaths) ? project.globIgnorePaths : []).filter((g): g is string => typeof g === 'string').map(rojoGlob).filter((re): re is RegExp => !!re)
  return globs.length ? { ...b, ignore: [...(b.ignore ?? []), { base, globs }] } : b
}

function ignored(b: Builder, rel: string): boolean {
  return (b.ignore ?? []).some((r) => {
    const sub = !r.base ? rel : rel.startsWith(r.base + '/') ? rel.slice(r.base.length + 1) : null
    return sub !== null && r.globs.some((re) => re.test(sub))
  })
}

// rel: repo-relative posix path of the directory.
async function fromDirectory(b: Builder, rel: string, name: string): Promise<SourcemapNode> {
  const abs = join(b.root, ...rel.split('/'))
  const nested = posix.join(rel, 'default.project.json')
  if (b.depth < 8 && existsSync(join(abs, 'default.project.json'))) {
    const project = await readJson<{ tree?: Record<string, unknown>; globIgnorePaths?: unknown }>(join(abs, 'default.project.json'))
    if (project?.tree) {
      const node = await fromProjectNode(withIgnore({ ...b, depth: b.depth + 1 }, rel, project), rel, name, project.tree)
      node.filePaths = [nested, ...(node.filePaths ?? [])]
      return node
    }
  }
  let entries: { name: string; dir: boolean; file: boolean }[] = []
  try {
    entries = (await readdir(abs, { withFileTypes: true })).map((e) => ({ name: e.name, dir: e.isDirectory(), file: e.isFile() }))
  } catch {
    return { name, className: 'Folder', children: [] }
  }
  const names = new Set(entries.map((e) => e.name))
  const node: SourcemapNode = { name, className: 'Folder', children: [] }
  for (const [file, className] of INIT_FILES) {
    if (names.has(file)) {
      node.className = className
      node.filePaths = [posix.join(rel, file)]
      break
    }
  }
  if (names.has('init.meta.json')) {
    const meta = await readJson<{ className?: string }>(join(abs, 'init.meta.json'))
    if (meta?.className && node.className === 'Folder') node.className = meta.className
  }
  for (const entry of entries.sort((a, z) => a.name.localeCompare(z.name))) {
    if (entry.name.startsWith('.')) continue
    const childRel = posix.join(rel, entry.name)
    if (ignored(b, childRel)) continue
    if (entry.dir) {
      node.children!.push(await fromDirectory(b, childRel, entry.name))
    } else if (entry.file) {
      if (/^init(\.server|\.client)?\.(luau|lua)$/.test(entry.name) || entry.name === 'init.meta.json') continue
      const mapped = fileInstance(entry.name)
      if (mapped) node.children!.push({ name: mapped.name, className: mapped.className, filePaths: [childRel], children: [] })
    }
  }
  return node
}

// base: directory (repo-relative) that this project's $path values are relative to.
async function fromProjectNode(b: Builder, base: string, name: string, node: Record<string, unknown>): Promise<SourcemapNode> {
  const explicit = typeof node.$className === 'string' ? node.$className : undefined
  let out: SourcemapNode = { name, className: explicit ?? 'Folder', children: [] }
  let mappedClass: string | undefined
  const path = projectPath(node)
  if (path) {
    const rel = posix.normalize(posix.join(base, path.replace(/\\/g, '/'))).replace(/^\.\//, '')
    const info = await stat(join(b.root, ...rel.split('/'))).catch(() => null)
    if (info?.isDirectory()) {
      const dir = await fromDirectory(b, rel, name)
      out = { ...dir, name }
      mappedClass = dir.className
    } else if (info?.isFile()) {
      const mapped = fileInstance(posix.basename(rel))
      if (mapped) {
        mappedClass = mapped.className
        out.filePaths = [rel]
      }
    }
  }
  out.className = explicit ?? (mappedClass && mappedClass !== 'Folder' ? mappedClass : SERVICES.has(name) ? name : mappedClass ?? 'Folder')
  out.children = out.children ?? []
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('$') || !value || typeof value !== 'object' || Array.isArray(value)) continue
    out.children.push(await fromProjectNode(b, base, key, value as Record<string, unknown>))
  }
  return out
}

function mapsFolder(tree: SourcemapNode, folder: string): boolean {
  const prefix = folder + '/'
  const walk = (node: SourcemapNode): boolean =>
    (node.filePaths ?? []).some((p) => p === folder || p.startsWith(prefix)) || (node.children ?? []).some(walk)
  return walk(tree)
}

// The project's instance tree in sourcemap form, from the active place's project file (multi-place
// projects: e.g. menu.project.json; default.project.json otherwise). Throws when it is unreadable.
export async function buildSourcemap(root: string, projectFile = 'default.project.json'): Promise<SourcemapNode> {
  const file = /^[^/\\]+\.project\.json$/.test(projectFile) ? projectFile : 'default.project.json'
  const project = await readJson<{ name?: string; tree?: Record<string, unknown>; globIgnorePaths?: unknown }>(join(root, file))
  if (!project?.tree) throw new Error(`No readable ${file} in ${root}`)
  const tree = await fromProjectNode(withIgnore({ root, depth: 0 }, '', project), '', project.name || 'Game', project.tree)
  tree.filePaths = [file, ...(tree.filePaths ?? [])]
  const testsInfo = await stat(join(root, TESTS_FOLDER)).catch(() => null)
  if (testsInfo?.isDirectory() && !mapsFolder(tree, TESTS_FOLDER)) {
    const folder = await fromDirectory({ root, depth: 0 }, TESTS_FOLDER, TESTS_INSTANCE)
    folder.className = 'Folder'
    if (tree.className === 'DataModel') tree.children = [...(tree.children ?? []), folder]
  }
  return tree
}

export function realmOf(instancePath: string[]): Realm {
  return CLIENT_ROOTS.has(instancePath[0]) ? 'client' : 'server'
}

function isPackagePath(path: string): boolean {
  return /^(Server)?Packages\//.test(path)
}

// Every spec file in the tree with its instance path, sorted by file. Wally packages are skipped.
export function discoverSpecs(tree: SourcemapNode): SpecFile[] {
  const out: SpecFile[] = []
  const walk = (node: SourcemapNode, parents: string[]) => {
    const here = node.className === 'DataModel' ? parents : [...parents, node.name]
    for (const file of node.filePaths ?? []) {
      if (isSpecFile(file) && !isPackagePath(file)) out.push({ file, instancePath: here, realm: realmOf(here) })
    }
    for (const child of node.children ?? []) walk(child, here)
  }
  walk(tree, [])
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

// Instance path (from the DataModel) of the instance whose source is `file`, or null if unmapped.
export function instancePathOf(tree: SourcemapNode, file: string): { path: string[]; className: string } | null {
  let found: { path: string[]; className: string } | null = null
  const walk = (node: SourcemapNode, parents: string[]): void => {
    if (found) return
    const here = node.className === 'DataModel' ? parents : [...parents, node.name]
    if ((node.filePaths ?? []).some((p) => p === file && isScriptFile(p))) {
      found = { path: here, className: node.className }
      return
    }
    for (const child of node.children ?? []) walk(child, here)
  }
  walk(tree, [])
  return found
}

// Every script file the tree maps (for watch: file -> instance name).
export function scriptFiles(tree: SourcemapNode): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (node: SourcemapNode) => {
    for (const file of node.filePaths ?? []) if (isScriptFile(file)) out.set(file, node.name)
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  return out
}
