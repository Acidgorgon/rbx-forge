// Forge Sync mapping: which Studio instance lives in which file, following Rojo 7.7's project and
// file conventions (rojo.space/docs/v7/sync-details). Read from every *.project.json at the
// project root, so one PlaceMap per place (match, menu ...). No electron imports.

import { statSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileKind, MappedFile } from '../../../shared/sync/types.ts'

export interface SyncRoot {
  // Instance path of the project node that carries the $path.
  instance: string[]
  // Repo-relative, forward slashes.
  path: string
  isFile: boolean
  // $ignoreUnknownInstances (Rojo default: false for $path nodes): Rojo leaves Studio-only
  // children of this instance alone instead of deleting them.
  ignoreUnknown: boolean
}

export interface PlaceMap {
  projectFile: string
  // Project "name".
  name: string
  // Absolute project root.
  root: string
  // servePlaceIds, plus the legacy tools/studio-sync.json placeIds for this project file.
  placeIds: number[]
  servePort?: number
  // Rojo emitLegacyScripts (default true): .server -> Script, .client -> LocalScript.
  emitLegacyScripts: boolean
  roots: SyncRoot[]
  // $path nodes Forge never syncs (Packages, skip list): instances under them are left alone.
  skipped: { instance: string[]; path: string }[]
  // Project nodes without $path (services, $className containers): Rojo-defined, not disk-backed.
  virtual: string[][]
  // Disk path globs never written (studio-sync.json "skip" + .forge/project.json sync.skip).
  skipGlobs: string[]
}

// Wally output folders: never mapped.
export const PACKAGE_DIRS = new Set(['Packages', 'ServerPackages', 'DevPackages', '_Index'])

export const SCRIPT_CLASSES = new Set(['ModuleScript', 'Script', 'LocalScript'])
export function isScriptClass(className: string): boolean {
  return SCRIPT_CLASSES.has(className)
}

// ---- names ----

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i
const RESERVED_SUFFIX = /\.(server|client|plugin|meta|model|project|legacy|local)$/i

// Why an instance name cannot become a file/dir name (null when it can). Refusing is safer than
// escaping: an escaped name would come back from Rojo as a different instance name.
export function unsafeName(name: string): string | null {
  if (!name) return 'empty name'
  if (name === '.' || name === '..') return 'dot name'
  if (/[/\\:*?"<>|]/.test(name)) return 'contains / \\ : * ? " < > or |'
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return 'control character'
  if (name !== name.trim()) return 'leading or trailing space'
  if (name.endsWith('.')) return 'trailing dot'
  if (WINDOWS_RESERVED.test(name)) return 'reserved file name on Windows'
  if (/^init$/i.test(name) || /^init\./i.test(name)) return '"init" is a Rojo file convention'
  if (RESERVED_SUFFIX.test(name)) return 'ends in a Rojo file suffix'
  if (name.length > 200) return 'name too long'
  return null
}

// ---- file names ----

export interface FileNameInfo {
  // Instance name from the file name; null for init.* (the containing directory).
  stem: string | null
  kind: FileKind
  className?: string
  // Script run context implied by the suffix (Rojo 7: .plugin -> Script RunContext=Plugin).
  plugin?: boolean
}

const OTHER_EXT = /\.(txt|csv|json|jsonc|toml|rbxm|rbxmx|yml|yaml)$/i

export function parseFileName(base: string, emitLegacyScripts = true): FileNameInfo | null {
  if (base === 'init.meta.json' || base === 'init.meta.jsonc') return { stem: null, kind: 'meta' }
  let m = /^(.*)\.meta\.jsonc?$/.exec(base)
  if (m) return { stem: m[1], kind: 'meta' }
  m = /^(.*)\.model\.jsonc?$/.exec(base)
  if (m) return { stem: m[1], kind: 'model' }
  m = /^(.*?)(\.server|\.client|\.plugin)?\.(lua|luau)$/.exec(base)
  if (m) {
    const stem = m[1] === 'init' ? null : m[1]
    const suffix = m[2] ?? ''
    if (suffix === '.server') return { stem, kind: 'script', className: 'Script' }
    if (suffix === '.client') return { stem, kind: 'script', className: emitLegacyScripts ? 'LocalScript' : 'Script' }
    if (suffix === '.plugin') return { stem, kind: 'script', className: 'Script', plugin: true }
    return { stem, kind: 'script', className: 'ModuleScript' }
  }
  if (/\.project\.jsonc?$/.test(base)) return null
  m = /^(.*)\.[^.]+$/.exec(base)
  if (m && OTHER_EXT.test(base)) return { stem: m[1] === 'init' ? null : m[1], kind: 'other' }
  return null
}

export interface ScriptForm {
  // '' | '.server' | '.client' | '.plugin'
  suffix: string
  // RunContext that needs an adjacent meta file.
  meta?: 'Legacy' | 'Server' | 'Client'
}

// File suffix for a script class (Rojo 7.7 lua.rs): with emitLegacyScripts (default),
// .server -> Script (Legacy), .client -> LocalScript; without it .server/.client -> Script with
// RunContext Server/Client. .plugin -> Script RunContext Plugin either way. Anything else is
// expressed with an adjacent meta file setting RunContext.
export function scriptForm(className: string, runContext: string | undefined, emitLegacyScripts = true): ScriptForm | null {
  if (className === 'ModuleScript') return { suffix: '' }
  if (className === 'LocalScript') return { suffix: '.client' }
  if (className !== 'Script') return null
  const rc = runContext ?? 'Legacy'
  if (rc === 'Plugin') return { suffix: '.plugin' }
  if (emitLegacyScripts) {
    if (rc === 'Legacy') return { suffix: '.server' }
    return { suffix: '.server', meta: rc as 'Server' | 'Client' }
  }
  if (rc === 'Server') return { suffix: '.server' }
  if (rc === 'Client') return { suffix: '.client' }
  return { suffix: '.server', meta: 'Legacy' }
}

// ---- paths ----

export function cleanRel(path: string): string | null {
  let p = path.replace(/\\/g, '/').replace(/\/+$/, '')
  while (p.startsWith('./')) p = p.slice(2)
  if (!p || p === '.' || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null
  if (p.split('/').some((s) => s === '..' || s === '.' || s === '')) return null
  return p
}

function globToRegExp(glob: string): RegExp {
  // "dir/**" also covers "dir" itself.
  const tail = glob.endsWith('/**')
  if (tail) glob = glob.slice(0, -3)
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
        if (glob[i + 1] === '/') i++
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}${tail ? '(/.*)?' : ''}$`)
}

// True when `rel` or one of its parent directories matches a skip glob, or sits in a wally folder.
export function isSkipped(globs: string[], rel: string): boolean {
  const parts = rel.split('/')
  if (parts.some((p) => PACKAGE_DIRS.has(p))) return true
  const res = globs.map(globToRegExp)
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join('/')
    if (res.some((re) => re.test(prefix))) return true
  }
  return false
}

const startsWith = (path: string[], prefix: string[]): boolean => prefix.length <= path.length && prefix.every((p, i) => path[i] === p)
const samePath = (a: string[], b: string[]): boolean => a.length === b.length && startsWith(a, b)

// ---- loading ----

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

type Json = Record<string, unknown>

export async function loadPlaces(root: string): Promise<PlaceMap[]> {
  const entries = await readdir(root).catch(() => [] as string[])
  const projectFiles = entries.filter((f) => f.endsWith('.project.json')).sort((a, b) => (a === 'default.project.json' ? -1 : b === 'default.project.json' ? 1 : a.localeCompare(b)))
  const legacy = ((await readJson(join(root, 'tools', 'studio-sync.json'))) ?? {}) as Json
  const forgeConfig = ((await readJson(join(root, '.forge', 'project.json'))) ?? {}) as Json
  const skipGlobs: string[] = []
  for (const s of Array.isArray(legacy.skip) ? legacy.skip : []) if (typeof s === 'string' && cleanRel(s)) skipGlobs.push(cleanRel(s)!)
  const forgeSync = (forgeConfig.sync ?? {}) as Json
  for (const s of Array.isArray(forgeSync.skip) ? forgeSync.skip : []) if (typeof s === 'string' && s.trim()) skipGlobs.push(s.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))

  const maps: PlaceMap[] = []
  for (const projectFile of projectFiles) {
    const project = (await readJson(join(root, projectFile))) as Json | null
    if (!project || typeof project.tree !== 'object' || !project.tree) continue
    const placeIds = new Set<number>()
    for (const id of Array.isArray(project.servePlaceIds) ? project.servePlaceIds : []) if (typeof id === 'number') placeIds.add(id)
    if (projectFile === 'default.project.json') for (const id of Array.isArray(legacy.placeIds) ? legacy.placeIds : []) if (typeof id === 'number') placeIds.add(id)
    for (const extra of Array.isArray(legacy.projects) ? (legacy.projects as Json[]) : []) {
      if (extra?.file === projectFile) for (const id of Array.isArray(extra.placeIds) ? extra.placeIds : []) if (typeof id === 'number') placeIds.add(id)
    }
    const map: PlaceMap = {
      projectFile,
      name: typeof project.name === 'string' ? project.name : projectFile.replace(/\.project\.json$/, ''),
      root,
      placeIds: [...placeIds],
      servePort: typeof project.servePort === 'number' ? project.servePort : undefined,
      emitLegacyScripts: project.emitLegacyScripts !== false,
      roots: [],
      skipped: [],
      virtual: [],
      skipGlobs
    }
    const walk = async (node: Json, names: string[]): Promise<void> => {
      let raw = node.$path as unknown
      if (raw && typeof raw === 'object' && typeof (raw as Json).optional === 'string') raw = (raw as Json).optional
      if (typeof raw === 'string' && names.length > 0) {
        const path = cleanRel(raw)
        if (!path || isSkipped(skipGlobs, path) || PACKAGE_DIRS.has(names[names.length - 1])) map.skipped.push({ instance: names, path: path ?? raw })
        else {
          const info = await stat(join(root, path)).catch(() => null)
          if (info) map.roots.push({ instance: names, path, isFile: info.isFile(), ignoreUnknown: node.$ignoreUnknownInstances === true })
          else map.skipped.push({ instance: names, path })
        }
      } else if (names.length > 0) map.virtual.push(names)
      for (const [key, child] of Object.entries(node)) {
        if (!key.startsWith('$') && child && typeof child === 'object' && !Array.isArray(child)) await walk(child as Json, [...names, key])
      }
    }
    await walk(project.tree as Json, [])
    maps.push(map)
  }
  return maps
}

export function placeFor(maps: PlaceMap[], placeId: number | null | undefined): PlaceMap | null {
  if (placeId) {
    const hit = maps.find((m) => m.placeIds.includes(placeId))
    if (hit) return hit
  }
  return maps.find((m) => m.projectFile === 'default.project.json') ?? maps[0] ?? null
}

// ---- instance -> file ----

export interface RootHit {
  root: SyncRoot | null // null when the deepest match is a skipped root
  rest: string[]
}

// Deepest $path node containing the instance path. A project-defined node without $path in
// between (e.g. a $className Folder declared under a $path node) means the instance is not on disk.
export function findRoot(map: PlaceMap, path: string[]): RootHit | null {
  let best: { instance: string[]; root: SyncRoot | null } | null = null
  for (const root of map.roots) if (startsWith(path, root.instance) && (!best || root.instance.length > best.instance.length)) best = { instance: root.instance, root }
  for (const s of map.skipped) if (startsWith(path, s.instance) && (!best || s.instance.length > best.instance.length)) best = { instance: s.instance, root: null }
  if (!best) return null
  for (const v of map.virtual) if (v.length > best.instance.length && startsWith(path, v)) return null
  return { root: best.root, rest: path.slice(best.instance.length) }
}

// Project-defined instance paths (roots, skipped roots, virtual nodes): their children are not
// planned as part of the parent's directory.
export function isProjectNode(map: PlaceMap, path: string[]): boolean {
  return map.roots.some((r) => samePath(r.instance, path)) || map.skipped.some((s) => samePath(s.instance, path)) || map.virtual.some((v) => samePath(v, path))
}

export interface DiskProbe {
  isFile(rel: string): boolean
  isDir(rel: string): boolean
}

export function fsProbe(root: string): DiskProbe {
  const kind = (rel: string): 'file' | 'dir' | null => {
    try {
      const s = statSync(join(root, rel))
      return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : null
    } catch {
      return null
    }
  }
  return { isFile: (rel) => kind(rel) === 'file', isDir: (rel) => kind(rel) === 'dir' }
}

export interface ToDiskNode {
  path: string[]
  className: string
  runContext?: string
  // Layout hints from the Studio tree: a script with children needs an init file; a non-script
  // with scripts below needs a directory, otherwise it fits one .model.json.
  hasChildren?: boolean
  hasScriptDescendants?: boolean
}

const OTHER_FORMS = ['.json', '.jsonc', '.toml', '.txt', '.csv', '.yml', '.yaml', '.rbxm', '.rbxmx']
const join2 = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name)

function scriptFile(map: PlaceMap, dir: string, leaf: string | null, node: ToDiskNode, probe: DiskProbe): MappedFile | null {
  const form = scriptForm(node.className, node.runContext, map.emitLegacyScripts)
  if (!form) return null
  const own = leaf === null ? dir : join2(dir, leaf)
  const candidates = leaf === null ? [`${own}/init${form.suffix}.luau`, `${own}/init${form.suffix}.lua`] : [join2(dir, `${leaf}${form.suffix}.luau`), join2(dir, `${leaf}${form.suffix}.lua`), `${own}/init${form.suffix}.luau`, `${own}/init${form.suffix}.lua`]
  // A script with children has to be an init file inside a directory.
  let file = (leaf !== null && node.hasChildren ? candidates.slice(2) : candidates).find((c) => probe.isFile(c))
  if (!file && leaf !== null) {
    const other = OTHER_FORMS.map((ext) => join2(dir, leaf + ext)).find((c) => probe.isFile(c))
    if (other) return { file: other, kind: 'other', className: node.className }
  }
  if (!file) file = leaf === null || node.hasChildren || probe.isDir(own) ? `${own}/init${form.suffix}.luau` : join2(dir, `${leaf}${form.suffix}.luau`)
  const out: MappedFile = { file, kind: 'script', className: node.className }
  if (form.meta) {
    out.runContext = form.meta
    out.metaFile = /\/init(\.\w+)?\.luau?$/.test(file) ? `${own}/init.meta.json` : join2(dir, `${leaf}.meta.json`)
  }
  return out
}

// Where an instance lives on disk, or null when it is unmapped/refused (see unsafeName).
// kind 'folder': `file` is the directory. kind 'model' with modelPath: inside that model file.
// kind 'other': a file Rojo owns that Forge never writes (.txt, .csv, .json, .rbxm ...).
export function toDisk(map: PlaceMap, node: ToDiskNode, probe: DiskProbe = fsProbe(map.root)): MappedFile | null {
  const hit = findRoot(map, node.path)
  if (!hit || !hit.root) return null
  const { root, rest } = hit
  if (rest.some((seg) => unsafeName(seg))) return null
  const script = isScriptClass(node.className)
  if (root.isFile) {
    const info = parseFileName(root.path.split('/').pop()!, map.emitLegacyScripts)
    if (!info) return null
    if (rest.length === 0) return { file: root.path, kind: info.kind, className: info.kind === 'script' ? info.className : node.className }
    if (info.kind === 'model') return { file: root.path, kind: 'model', modelPath: rest, className: node.className }
    return null
  }
  let dir = root.path
  for (let i = 0; i < rest.length - 1; i++) {
    const seg = rest[i]
    if (!probe.isDir(join2(dir, seg)) && probe.isFile(join2(dir, `${seg}.model.json`))) return { file: join2(dir, `${seg}.model.json`), kind: 'model', modelPath: rest.slice(i + 1), className: node.className }
    dir = join2(dir, seg)
  }
  if (rest.length === 0) {
    if (script) return scriptFile(map, dir, null, node, probe)
    return { file: dir, kind: 'folder', className: node.className }
  }
  const leaf = rest[rest.length - 1]
  if (script) return scriptFile(map, dir, leaf, node, probe)
  const own = join2(dir, leaf)
  if (!probe.isDir(own) && probe.isFile(`${own}.model.json`) && !node.hasScriptDescendants) return { file: `${own}.model.json`, kind: 'model', className: node.className }
  if (probe.isDir(own)) return { file: own, kind: 'folder', className: node.className }
  const other = OTHER_FORMS.map((ext) => own + ext).find((c) => probe.isFile(c))
  if (other) return { file: other, kind: 'other', className: node.className }
  if (node.hasScriptDescendants || (node.className === 'Folder' && !node.hasChildren)) return { file: own, kind: 'folder', className: node.className }
  return { file: `${own}.model.json`, kind: 'model', className: node.className }
}

// ---- file -> instance ----

// Instance path a repo-relative file builds (meta files: the instance they describe), or null.
export function fromDisk(map: PlaceMap, file: string): string[] | null {
  const rel = cleanRel(file)
  if (!rel || isSkipped(map.skipGlobs, rel)) return null
  let best: SyncRoot | null = null
  for (const root of map.roots) {
    const inside = root.isFile ? rel === root.path : rel.startsWith(root.path + '/')
    if (inside && (!best || root.path.length > best.path.length)) best = root
  }
  if (!best) return null
  if (best.isFile) return parseFileName(rel.split('/').pop()!, map.emitLegacyScripts) ? [...best.instance] : null
  const segs = rel.slice(best.path.length + 1).split('/')
  const info = parseFileName(segs[segs.length - 1], map.emitLegacyScripts)
  if (!info) return null
  const dirs = segs.slice(0, -1)
  return info.stem === null ? [...best.instance, ...dirs] : [...best.instance, ...dirs, info.stem]
}

// Every repo-relative path Forge may write under for this place.
export function insideMappedRoots(map: PlaceMap, rel: string): boolean {
  if (isSkipped(map.skipGlobs, rel)) return false
  return map.roots.some((r) => (r.isFile ? rel === r.path : rel.startsWith(r.path + '/')))
}
