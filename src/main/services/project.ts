import { watch, type Dirent, type FSWatcher } from 'node:fs'
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  PlaceInfo,
  ProjectInfo,
  ScriptCategory,
  ScriptEntry,
  ScriptGroup,
  ScriptKind,
  TreeNode
} from '@shared/types'

// Studio props travel with the node when the live Studio snapshot has them.
export type HarnessTreeNode = TreeNode & { props?: Record<string, string | number> }

// One node of .studio-sync/tree.json, written by tools/studio-sync.py.
export interface StudioNode {
  name: string
  className: string
  props?: Record<string, unknown>
  children?: StudioNode[]
}

// The live Studio tree as Forge Sync has it (flat, see sync/service.ts liveTree), when Studio is
// connected through the Forge Bridge plugin.
export interface LiveStudioTree {
  nodes: { path: string[]; className: string; props?: Record<string, unknown> }[]
  truncated?: boolean
}

// Nests Forge Sync's flat live tree into .studio-sync/tree.json's shape (services at the top).
// Ancestors the list lacks (the services themselves) are filled in; one node per name path.
export function studioTreeFromLive(nodes: LiveStudioTree['nodes']): StudioNode[] {
  const top: StudioNode[] = []
  const byKey = new Map<string, StudioNode>()
  const sorted = [...nodes].filter((n) => Array.isArray(n.path) && n.path.length > 0).sort((a, b) => a.path.length - b.path.length)
  const ensure = (path: string[], className?: string, props?: Record<string, unknown>): StudioNode => {
    const key = path.join('\u0000')
    let node = byKey.get(key)
    if (!node) {
      const name = path[path.length - 1]
      node = { name, className: className ?? (path.length === 1 && KNOWN_SERVICES.has(name) ? name : 'Folder'), children: [] }
      byKey.set(key, node)
      if (path.length === 1) top.push(node)
      else ensure(path.slice(0, -1)).children!.push(node)
    } else if (className && node.className === 'Folder' && className !== 'Folder') node.className = className
    if (props && !node.props) node.props = props
    return node
  }
  for (const n of sorted) ensure(n.path, n.className, n.props)
  return top
}

interface SourcemapNode {
  name: string
  className: string
  filePaths?: string[]
  children?: SourcemapNode[]
}

export const CATEGORY_ORDER: ScriptCategory[] = [
  'Configs',
  'Data',
  'Services',
  'Handlers',
  'Controllers',
  'Skills',
  'Modules',
  'Protocols',
  'Events',
  'UI',
  'Stories',
  'Entry points',
  'Tests',
  'Other'
]

const IGNORED_DIRS = new Set(['node_modules', '.git', 'Packages', 'ServerPackages', '.studio-sync'])
const SCRIPT_KINDS = new Set(['ModuleScript', 'Script', 'LocalScript'])
const KNOWN_SERVICES = new Set([
  'Workspace', 'Lighting', 'ReplicatedFirst', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage',
  'StarterGui', 'StarterPack', 'StarterPlayer', 'StarterPlayerScripts', 'StarterCharacterScripts',
  'SoundService', 'Teams', 'TextChatService', 'Chat', 'LocalizationService', 'MaterialService'
])

function toPosix(path: string): string {
  return path.split(sep).join('/').replace(/\\/g, '/')
}

function byName(a: TreeNode, b: TreeNode): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

// Rejects anything that resolves outside root, including through symlinks.
export async function resolveInside(root: string, path: string): Promise<string> {
  if (typeof path !== 'string' || path.includes('\0')) throw new Error('Invalid path')
  const base = resolve(root)
  const full = resolve(base, path)
  const rel = relative(base, full)
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new Error(`Path is outside the project: ${path}`)
  }
  let existing = full
  for (;;) {
    try {
      await stat(existing)
      break
    } catch {
      const parent = dirname(existing)
      if (parent === existing) break
      existing = parent
    }
  }
  const realBase = await realpath(base)
  const realExisting = await realpath(existing)
  const realRel = relative(realBase, realExisting)
  if (realRel === '..' || realRel.startsWith('..' + sep) || isAbsolute(realRel)) {
    throw new Error(`Path is outside the project: ${path}`)
  }
  return full
}

// "Foo.server.luau" -> Script "Foo". Returns null for files Rojo would not turn into a script.
export function scriptFromFileName(fileName: string): { name: string; kind: ScriptKind } | null {
  const match = /^(.+?)(\.server|\.client)?\.(luau|lua)$/.exec(fileName)
  if (!match) return null
  const kind: ScriptKind = match[2] === '.server' ? 'Script' : match[2] === '.client' ? 'LocalScript' : 'ModuleScript'
  return { name: match[1], kind }
}

const INIT_FILES: [string, ScriptKind][] = [
  ['init.server.luau', 'Script'],
  ['init.client.luau', 'LocalScript'],
  ['init.luau', 'ModuleScript'],
  ['init.server.lua', 'Script'],
  ['init.client.lua', 'LocalScript'],
  ['init.lua', 'ModuleScript']
]

async function fromDirectory(root: string, relDir: string, name: string): Promise<TreeNode> {
  let entries: Dirent[] = []
  try {
    entries = await readdir(join(root, relDir), { withFileTypes: true })
  } catch {
    return { name, className: 'Folder', children: [] }
  }
  const names = new Set(entries.map((entry) => entry.name))
  const node: TreeNode = { name, className: 'Folder', children: [] }
  for (const [file, kind] of INIT_FILES) {
    if (names.has(file)) {
      node.className = kind
      node.filePath = toPosix(join(relDir, file))
      break
    }
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const childRel = join(relDir, entry.name)
    if (entry.isDirectory()) {
      node.children.push(await fromDirectory(root, childRel, entry.name))
    } else if (entry.isFile()) {
      if (/^init(\.server|\.client)?\.(luau|lua)$/.test(entry.name)) continue
      const script = scriptFromFileName(entry.name)
      if (script) {
        node.children.push({ name: script.name, className: script.kind, filePath: toPosix(childRel), children: [] })
      } else if (/\.model\.json$/.test(entry.name)) {
        // Rojo model files (Forge Sync's non-script instances, "Save to repo"): in the repo, with their
        // children, so they merge with Studio as one node instead of showing as Studio-only.
        const model = await modelNode(join(root, childRel), entry.name.replace(/\.model\.json$/, ''))
        if (model) node.children.push(model)
      }
    }
  }
  node.children.sort(byName)
  return node
}

const MODEL_MAX_BYTES = 4 * 1024 * 1024

// A .model.json as tree nodes (name, class, children; camelCase or PascalCase keys), null when unreadable.
async function modelNode(file: string, name: string): Promise<TreeNode | null> {
  try {
    if ((await stat(file)).size > MODEL_MAX_BYTES) return { name, className: 'Model', children: [] }
    const json = JSON.parse(await readFile(file, 'utf8')) as unknown
    const convert = (v: unknown, fallback: string, depth: number): TreeNode | null => {
      if (!v || typeof v !== 'object' || depth > 64) return null
      const o = v as Record<string, unknown>
      const className = o.className ?? o.ClassName
      const n = depth === 0 ? fallback : (o.name ?? o.Name)
      if (typeof className !== 'string' || typeof n !== 'string') return null
      const kids = o.children ?? o.Children
      const children = (Array.isArray(kids) ? kids : []).map((c) => convert(c, '', depth + 1)).filter((c): c is TreeNode => !!c).sort(byName)
      return { name: n, className, children }
    }
    return convert(json, name, 0)
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

async function fromProjectNode(root: string, name: string, node: Record<string, unknown>): Promise<TreeNode> {
  let className = typeof node.$className === 'string' ? node.$className : undefined
  let filePath: string | undefined
  const children: TreeNode[] = []
  const path = projectPath(node)
  if (path) {
    const info = await stat(join(root, path)).catch(() => null)
    if (info?.isDirectory()) {
      const mapped = await fromDirectory(root, path, name)
      className = className ?? mapped.className
      filePath = mapped.filePath
      children.push(...mapped.children)
    } else if (info?.isFile()) {
      const script = scriptFromFileName(basename(path))
      if (script) {
        className = className ?? script.kind
        filePath = toPosix(path)
      }
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('$') || !value || typeof value !== 'object') continue
    children.push(await fromProjectNode(root, key, value as Record<string, unknown>))
  }
  children.sort(byName)
  return {
    name,
    className: className ?? (KNOWN_SERVICES.has(name) ? name : 'Folder'),
    filePath,
    children
  }
}

// Explorer tree from default.project.json plus the files Rojo would map. Returns the DataModel's children.
export async function buildRepoTree(root: string, project: { tree?: Record<string, unknown> }): Promise<TreeNode[]> {
  if (!project.tree) return []
  const top = await fromProjectNode(root, 'game', project.tree)
  return top.className === 'DataModel' ? top.children : [top]
}

// Adds the nodes `extra` has that `base` lacks (matched by name per level); `base` wins otherwise.
export function fillFromProject(base: TreeNode[], extra: TreeNode[]): TreeNode[] {
  const out = base.map((node) => ({ ...node }))
  for (const node of extra) {
    const hit = out.find((n) => n.name === node.name)
    if (!hit) out.push(node)
    else if (node.children.length) hit.children = fillFromProject(hit.children, node.children)
  }
  return out.sort(byName)
}

export function treeFromSourcemap(root: string, sourcemap: SourcemapNode): TreeNode[] {
  const convert = (node: SourcemapNode): TreeNode => {
    const file = node.filePaths?.find((path) => /\.(luau|lua)$/.test(path))
    let filePath: string | undefined
    if (file) filePath = toPosix(isAbsolute(file) ? relative(root, file) : file)
    const children = (node.children ?? []).map(convert).sort(byName)
    return { name: node.name, className: node.className, filePath, children }
  }
  const top = convert(sourcemap)
  return top.className === 'DataModel' ? top.children : [top]
}

// Drops sourcemap nodes whose script file is gone (a stale sourcemap.json while ./dev is off, e.g.
// right after an Explorer delete or rename), and folders that only held such nodes.
export async function pruneMissing(root: string, nodes: TreeNode[]): Promise<TreeNode[]> {
  const out: TreeNode[] = []
  for (const node of nodes) {
    if (node.filePath && !(await stat(join(root, node.filePath)).catch(() => null))) continue
    const children = await pruneMissing(root, node.children)
    if (!node.filePath && node.children.length > 0 && children.length === 0 && node.className === 'Folder') continue
    out.push(children.length === node.children.length ? node : { ...node, children })
  }
  return out
}

function cleanProps(props: unknown): Record<string, string | number> | undefined {
  if (!props || typeof props !== 'object') return undefined
  const out: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = value
    else if (typeof value === 'boolean') out[key] = String(value)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function markRepo(node: TreeNode): HarnessTreeNode {
  return { ...node, origin: 'repo', children: node.children.map(markRepo) }
}

function markStudio(node: StudioNode): HarnessTreeNode {
  const out: HarnessTreeNode = {
    name: String(node.name),
    className: String(node.className),
    origin: 'studio',
    children: (node.children ?? []).map(markStudio).sort(byName)
  }
  const props = cleanProps(node.props)
  if (props) out.props = props
  return out
}

// Merges the Rojo tree with the live Studio snapshot by name path. Same-named siblings pair up in order.
export function mergeStudioTree(repo: TreeNode[], studio: StudioNode[] | null): HarnessTreeNode[] {
  if (!studio) return repo.map(markRepo)
  const pool = new Map<string, StudioNode[]>()
  for (const node of studio) {
    if (!node || typeof node.name !== 'string') continue
    const list = pool.get(node.name) ?? []
    list.push(node)
    pool.set(node.name, list)
  }
  const merged: HarnessTreeNode[] = []
  for (const node of repo) {
    const match = pool.get(node.name)?.shift()
    if (!match) {
      merged.push(markRepo(node))
      continue
    }
    const out: HarnessTreeNode = {
      ...node,
      origin: 'both',
      children: mergeStudioTree(node.children, match.children ?? [])
    }
    const props = cleanProps(match.props)
    if (props) out.props = props
    merged.push(out)
  }
  for (const list of pool.values()) {
    for (const node of list) merged.push(markStudio(node))
  }
  return merged.sort(byName)
}

function realmOf(path: string, instancePath: string[], kind: ScriptKind): ScriptEntry['realm'] {
  const service = instancePath[0]
  if (service === 'ReplicatedStorage') return 'shared'
  if (service === 'ServerScriptService' || service === 'ServerStorage') return 'server'
  if (['StarterPlayer', 'StarterGui', 'StarterPack', 'ReplicatedFirst'].includes(service)) return 'client'
  const segments = path.split('/')
  if (segments.includes('shared')) return 'shared'
  if (segments.includes('server')) return 'server'
  if (segments.includes('client')) return 'client'
  return kind === 'Script' ? 'server' : kind === 'LocalScript' ? 'client' : 'shared'
}

function stripScriptExt(segment: string): string {
  return segment.replace(/(\.server|\.client)?\.(luau|lua)$/, '')
}

function featureOf(segments: string[]): string | undefined {
  const features = segments.indexOf('Features')
  if (features >= 0 && features + 1 < segments.length) {
    const name = stripScriptExt(segments[features + 1])
    if (name && !name.startsWith('init')) return name
  }
  // src/skills/Server/Moves/<Move>/...: one feature per move.
  const moves = segments.indexOf('Moves')
  if (moves >= 0 && moves + 1 < segments.length && segments.some((part) => part.toLowerCase() === 'skills')) {
    const name = stripScriptExt(segments[moves + 1])
    if (name && !name.startsWith('init')) return name
  }
  const controllers = segments.indexOf('Controllers')
  if (controllers >= 0 && controllers + 1 < segments.length) {
    const name = stripScriptExt(segments[controllers + 1]).replace(/Controller$/, '')
    if (name) return name
  }
  return undefined
}

export function categorize(entry: Omit<ScriptEntry, 'category' | 'feature'>): ScriptCategory {
  const segments = entry.path.split('/')
  const fileName = segments[segments.length - 1]
  const lower = segments.map((segment) => segment.toLowerCase())
  if (/\.spec\.(luau|lua)$/.test(fileName) || lower[0] === 'tests') return 'Tests'
  if (/\.story(book)?\.(luau|lua)$/.test(fileName)) return 'Stories'
  if (/^init\.(server|client)\.(luau|lua)$/.test(fileName)) return 'Entry points'
  if (/^Bootstrapper\.(server|client)\.(luau|lua)$/.test(fileName)) return 'Entry points'
  if (lower.includes('skills') || (entry.instancePath ?? []).includes('Skills')) return 'Skills'
  if (segments.includes('Handlers') || (entry.kind !== 'ModuleScript' && /Handler$/.test(entry.name))) return 'Handlers'
  if (entry.kind === 'ModuleScript' && /Protocol$/.test(entry.name)) return 'Protocols'
  if (entry.realm === 'shared' && segments.includes('Features')) return 'Configs'
  if (/Data/.test(entry.path)) return 'Data'
  if (entry.realm === 'shared' && lower.includes('events')) return 'Events'
  if (/Controller$/.test(entry.name) || segments.includes('Controllers')) return 'Controllers'
  if (/Service$/.test(entry.name) || (entry.realm === 'server' && segments.includes('Features'))) return 'Services'
  if (segments.includes('Interface') || /UI|App/.test(entry.name) || entry.name.toLowerCase() === 'app') return 'UI'
  if (segments.includes('Modules')) return 'Modules'
  return 'Other'
}

// Script list for the sidebar, grouped by category. Empty groups are left out. Packages are skipped.
export function buildScriptGroups(tree: TreeNode[]): ScriptGroup[] {
  const entries: ScriptEntry[] = []
  const walk = (node: TreeNode, parents: string[]) => {
    const instancePath = [...parents, node.name]
    if (node.filePath && SCRIPT_KINDS.has(node.className) && !/^(Server)?Packages\//.test(node.filePath)) {
      const kind = node.className as ScriptKind
      const base = {
        path: node.filePath,
        instancePath,
        name: node.name,
        kind,
        realm: realmOf(node.filePath, instancePath, kind)
      }
      const entry: ScriptEntry = { ...base, category: categorize(base) }
      const feature = featureOf(node.filePath.split('/'))
      if (feature) entry.feature = feature
      entries.push(entry)
    }
    for (const child of node.children) walk(child, instancePath)
  }
  for (const node of tree) walk(node, [])
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const groups: ScriptGroup[] = []
  for (const category of CATEGORY_ORDER) {
    const scripts = entries.filter((entry) => entry.category === category)
    if (scripts.length > 0) groups.push({ category, scripts })
  }
  return groups
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- places

export const DEFAULT_PLACE = 'default.project.json'
const ROJO_DEFAULT_PORT = 34872
const PLACE_FILE = /^(.+)\.project\.json$/

// Repo-relative sourcemap path for a place. The dev loop writes sourcemap.json for the default
// place; the supervisor writes the others under .studio-sync/ (gitignored by the template).
export function sourcemapFor(file: string): string {
  if (file === DEFAULT_PLACE) return 'sourcemap.json'
  const stem = PLACE_FILE.exec(file)?.[1] ?? file
  return `.studio-sync/sourcemap.${stem}.json`
}

// Every *.project.json at the root is a place. default.project.json first, then by file name.
export async function discoverPlaces(root: string): Promise<PlaceInfo[]> {
  let names: string[] = []
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && PLACE_FILE.test(entry.name))
      .map((entry) => entry.name)
  } catch {
    return []
  }
  names.sort((a, b) => (a === DEFAULT_PLACE ? -1 : b === DEFAULT_PLACE ? 1 : a.localeCompare(b)))
  const raw: { file: string; stem: string; json: Record<string, unknown> | null }[] = []
  for (const file of names) {
    const json = await readJson<Record<string, unknown>>(join(root, file))
    raw.push({ file, stem: PLACE_FILE.exec(file)![1], json: json && typeof json === 'object' ? json : null })
  }
  const nameCount = new Map<string, number>()
  for (const place of raw) {
    const name = typeof place.json?.name === 'string' ? place.json.name : ''
    if (name) nameCount.set(name, (nameCount.get(name) ?? 0) + 1)
  }
  return raw.map(({ file, stem, json }) => {
    const field = typeof json?.name === 'string' ? json.name : ''
    const isDefault = file === DEFAULT_PLACE
    // A shared "name" (menu.project.json often copies the game's) only labels the default place.
    const name = field && (nameCount.get(field) === 1 || isDefault) ? field : stem
    const port = Number(json?.servePort)
    const ids = Array.isArray(json?.servePlaceIds) ? (json!.servePlaceIds as unknown[]) : []
    return {
      file,
      name,
      isDefault,
      servePort: Number.isInteger(port) && port > 0 ? port : ROJO_DEFAULT_PORT,
      servePlaceIds: ids.filter((id): id is number => typeof id === 'number'),
      sourcemap: sourcemapFor(file)
    }
  })
}

// Picks the active place: the wanted file when it still exists, else the default place, else the first.
export function pickPlace(places: PlaceInfo[], wanted?: string | null): PlaceInfo | null {
  return places.find((p) => p.file === wanted) ?? places.find((p) => p.isDefault) ?? places[0] ?? null
}

// Repo-relative folders/files a project file maps ($path values).
export function mappedPaths(tree: Record<string, unknown> | undefined): string[] {
  return collectPaths(tree).map((path) => path.replace(/^\.\//, '').replace(/\/$/, ''))
}

function isMappedBy(paths: string[], file: string): boolean {
  return paths.some((path) => file === path || file.startsWith(path + '/'))
}

export async function loadProjectInfo(root: string): Promise<ProjectInfo> {
  const project = await readJson<{ name?: string }>(join(root, 'default.project.json'))
  if (!project) throw new Error(`No readable default.project.json in ${root}`)
  const sync = await readJson<{ placeIds?: unknown[] }>(join(root, 'tools', 'studio-sync.json'))
  const placeIds = (sync?.placeIds ?? []).filter((id): id is number => typeof id === 'number')
  return { root, name: project.name || basename(root), placeIds }
}

export interface ProjectChange {
  info: boolean
  tree: boolean
  scripts: boolean
  // Places were added/removed/edited, or the active place changed.
  places?: boolean
}

export interface ProjectOpenOptions {
  // Place file to make active (e.g. remembered in settings); falls back to default.project.json.
  activePlace?: string | null
}

export class Project {
  readonly root: string
  info: ProjectInfo
  tree: HarnessTreeNode[] = []
  scripts: ScriptGroup[] = []
  places: PlaceInfo[] = []
  // File name of the active place ("default.project.json", "menu.project.json"...).
  activePlace: string = DEFAULT_PLACE
  // Instance roots where $path folders live, kept to know what to watch.
  private watchDirs: string[] = []
  private watchers: FSWatcher[] = []
  private studioWatcher: FSWatcher | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null
  private studioTree: StudioNode[] | null = null
  // Forge Sync's live Studio tree for a place file (preferred over .studio-sync/tree.json).
  private liveStudio: ((placeFile: string) => LiveStudioTree | null) | null = null
  private closed = false
  private onChange: ((change: ProjectChange) => void) | null = null
  // Repo-relative files the watchers reported since the last debounce (open editors reload them).
  private onFiles: ((files: string[]) => void) | null = null
  private changedFiles = new Set<string>()

  private constructor(root: string, info: ProjectInfo) {
    this.root = root
    this.info = info
  }

  static async open(root: string, options: ProjectOpenOptions = {}): Promise<Project> {
    const full = resolve(root)
    const info = await loadProjectInfo(full)
    const project = new Project(full, info)
    if (options.activePlace) project.activePlace = options.activePlace
    await project.refresh()
    return project
  }

  // The active place, or null when the root has no project file at all.
  getActivePlace(): PlaceInfo | null {
    return this.places.find((place) => place.file === this.activePlace) ?? null
  }

  listPlaces(): PlaceInfo[] {
    return this.places.map((place) => ({ ...place, servePlaceIds: [...place.servePlaceIds] }))
  }

  // Switches the explorer/scripts to another place and rebuilds. Throws for an unknown file.
  async setActivePlace(file: string): Promise<ProjectChange> {
    const places = await discoverPlaces(this.root)
    if (!places.some((place) => place.file === file)) throw new Error(`No ${file} in ${this.root}`)
    const changed = file !== this.activePlace
    this.activePlace = file
    const change = await this.refresh()
    if (changed) {
      change.places = true
      // The watch set depends on the place's $path folders.
      if (this.onChange) this.rewatch()
    }
    return change
  }

  // Rebuilds everything from disk and reports what changed.
  async refresh(): Promise<ProjectChange> {
    const places = await discoverPlaces(this.root)
    const active = pickPlace(places, this.activePlace)
    const activeFile = active?.file ?? DEFAULT_PLACE
    const placeTrees = new Map<string, Record<string, unknown> | undefined>()
    for (const place of places) {
      placeTrees.set(place.file, (await readJson<{ tree?: Record<string, unknown> }>(join(this.root, place.file)))?.tree)
    }
    const projectJson = { tree: placeTrees.get(activeFile) }
    // Watch every place's folders so edits to files only another place maps still refresh.
    this.watchDirs = [...new Set([...placeTrees.values()].flatMap((tree) => collectPaths(tree)))]
    const info: ProjectInfo = {
      ...(await loadProjectInfo(this.root).catch(() => this.info)),
      places,
      activePlace: activeFile,
      mounts: [...new Set([...placeTrees.values()].flatMap((tree) => mappedPaths(tree)))]
    }
    const sourcemap = await readJson<SourcemapNode>(join(this.root, sourcemapFor(activeFile)))
    let repoTree: TreeNode[]
    if (sourcemap && typeof sourcemap.name === 'string' && typeof sourcemap.className === 'string') {
      // Rojo's sourcemap leaves out branches with no scripts yet (a new project's empty
      // src/server), so the project file's own nodes fill those in.
      repoTree = fillFromProject(await pruneMissing(this.root, treeFromSourcemap(this.root, sourcemap)), await buildRepoTree(this.root, projectJson))
    } else {
      repoTree = await buildRepoTree(this.root, projectJson)
    }
    // A half-written snapshot keeps the previous one; a deleted snapshot drops Studio nodes.
    // Studio side: Forge Sync's live tree when a Bridge session has sent one, else tools/studio-sync.py's
    // tree.json. A half-written tree.json keeps the previous tree; a deleted one drops Studio nodes.
    let live: LiveStudioTree | null = null
    try {
      live = this.liveStudio?.(activeFile) ?? null
    } catch {
      live = null
    }
    if (live) this.studioTree = studioTreeFromLive(live.nodes)
    else {
      const treeFile = join(this.root, '.studio-sync', 'tree.json')
      const snapshot = await readJson<{ roots?: StudioNode[] }>(treeFile)
      if (snapshot && Array.isArray(snapshot.roots)) this.studioTree = snapshot.roots
      else if (!(await stat(treeFile).catch(() => null))) this.studioTree = null
    }
    const tree = mergeStudioTree(repoTree, this.studioTree)
    const scripts = buildScriptGroups(repoTree)
    if (places.length > 1) {
      const mapped = places.map((place) => ({ file: place.file, paths: mappedPaths(placeTrees.get(place.file)) }))
      for (const group of scripts) {
        for (const script of group.scripts) {
          script.places = mapped.filter((place) => isMappedBy(place.paths, script.path)).map((place) => place.file)
        }
      }
    }
    const change: ProjectChange = {
      info: JSON.stringify(info) !== JSON.stringify(this.info),
      tree: JSON.stringify(tree) !== JSON.stringify(this.tree),
      scripts: JSON.stringify(scripts) !== JSON.stringify(this.scripts),
      places: JSON.stringify(places) !== JSON.stringify(this.places) || activeFile !== this.activePlace
    }
    this.places = places
    this.activePlace = activeFile
    this.info = info
    this.tree = tree
    this.scripts = scripts
    return change
  }

  // Feeds Forge Sync's live Studio tree into the Game tab; call studioChanged() when it changes.
  setLiveStudio(source: ((placeFile: string) => LiveStudioTree | null) | null): void {
    this.liveStudio = source
  }

  // The live Studio tree changed (Forge Sync throttles these): rebuild through the usual debounce.
  studioChanged(): void {
    this.schedule()
  }

  // Watches the Rojo folders, the project files and .studio-sync/tree.json. Debounced 300ms.
  // onFiles gets every changed file the watchers named (content edits too, e.g. Forge Sync writing a
  // script from Studio), so open editor tabs can reload.
  watch(onChange: (change: ProjectChange) => void, onFiles?: (files: string[]) => void): void {
    this.onChange = onChange
    if (onFiles) this.onFiles = onFiles
    const schedule = () => this.schedule()
    const add = (path: string, recursive: boolean, filter?: (file: string) => boolean) => {
      try {
        const watcher = watch(path, { recursive }, (_event, file) => {
          const name = file ? toPosix(String(file)) : ''
          if (filter) {
            if (name && !filter(name)) return
          } else if (name && name.split('/').some((part) => IGNORED_DIRS.has(part))) {
            return
          }
          if (name) this.changedFiles.add(toPosix(relative(this.root, join(path, name))))
          schedule()
        })
        watcher.on('error', () => watcher.close())
        this.watchers.push(watcher)
        return true
      } catch {
        return false
      }
    }
    add(this.root, false, (file) => {
      if (file === '.studio-sync') {
        this.watchStudio()
        return true
      }
      return file === 'sourcemap.json' || PLACE_FILE.test(file)
    })
    add(join(this.root, 'tools'), false, (file) => file === 'studio-sync.json')
    let recursiveOk = true
    for (const dir of this.watchDirs) {
      if (IGNORED_DIRS.has(dir.split('/')[0])) continue
      if (!add(join(this.root, dir), true)) recursiveOk = false
    }
    this.watchStudio()
    // Without recursive watch support, fall back to a slow poll.
    if (!recursiveOk) this.pollTimer = setInterval(schedule, 5000)
  }

  // Re-creates the folder watchers (after the active place, and so the mapped folders, changed).
  private rewatch(): void {
    const onChange = this.onChange
    if (!onChange || this.closed) return
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
    this.studioWatcher?.close()
    this.studioWatcher = null
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.watch(onChange)
  }

  private watchStudio(): void {
    if (this.studioWatcher || this.closed) return
    try {
      this.studioWatcher = watch(join(this.root, '.studio-sync'), (_event, file) => {
        const name = file ? String(file) : ''
        const sourcemap = sourcemapFor(this.activePlace)
        if (!name || name.startsWith('tree.json') || sourcemap === `.studio-sync/${name}`) this.schedule()
      })
      this.studioWatcher.on('error', () => {
        this.studioWatcher?.close()
        this.studioWatcher = null
      })
    } catch {
      this.studioWatcher = null
    }
  }

  // Forge's own multi-step file operations (feature rename) pause the watcher reaction so the tree,
  // scripts and LSP never see the half-done state; resume() refreshes once.
  private pauses = 0
  private missed = false

  pause(): void {
    this.pauses++
  }

  resume(): void {
    if (this.pauses > 0) this.pauses--
    if (this.pauses === 0 && this.missed) {
      this.missed = false
      this.schedule()
    }
  }

  get paused(): boolean {
    return this.pauses > 0
  }

  private schedule(): void {
    if (this.closed) return
    if (this.pauses > 0) {
      this.missed = true
      return
    }
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      const files = [...this.changedFiles]
      this.changedFiles.clear()
      this.refresh()
        .then((change) => {
          if (!this.closed && (change.info || change.tree || change.scripts || change.places)) this.onChange?.(change)
        })
        .catch(() => undefined)
        .finally(() => {
          if (!this.closed && files.length) this.onFiles?.(files)
        })
    }, 300)
  }

  async readFile(path: string): Promise<string> {
    return readFile(await resolveInside(this.root, path), 'utf8')
  }

  async writeFile(path: string, contents: string): Promise<void> {
    const full = await resolveInside(this.root, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, contents, 'utf8')
  }

  // Repo-relative files under dir, recursive, skipping node_modules/.git/Packages/.studio-sync.
  async listFiles(dir: string, limit = 5000): Promise<string[]> {
    const start = await resolveInside(this.root, dir || '.')
    const out: string[] = []
    const walk = async (abs: string) => {
      let entries: Dirent[]
      try {
        entries = await readdir(abs, { withFileTypes: true })
      } catch {
        return
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (out.length >= limit) return
        const child = join(abs, entry.name)
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) await walk(child)
        } else if (entry.isFile()) {
          out.push(toPosix(relative(this.root, child)))
        }
      }
    }
    await walk(start)
    return out
  }

  close(): void {
    this.closed = true
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
    this.studioWatcher?.close()
    this.studioWatcher = null
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.debounce) clearTimeout(this.debounce)
  }
}

function collectPaths(tree: Record<string, unknown> | undefined): string[] {
  const out: string[] = []
  const walk = (node: Record<string, unknown>) => {
    const path = projectPath(node)
    if (path) out.push(toPosix(path))
    for (const [key, value] of Object.entries(node)) {
      if (!key.startsWith('$') && value && typeof value === 'object') walk(value as Record<string, unknown>)
    }
  }
  if (tree) walk(tree)
  return out
}
