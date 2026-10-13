import { watch, type Dirent, type FSWatcher } from 'node:fs'
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
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
  'Controllers',
  'Modules',
  'Events',
  'UI',
  'Entry points',
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
      }
    }
  }
  node.children.sort(byName)
  return node
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
  if (/^init\.(server|client)\.(luau|lua)$/.test(fileName)) return 'Entry points'
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
}

export class Project {
  readonly root: string
  info: ProjectInfo
  tree: HarnessTreeNode[] = []
  scripts: ScriptGroup[] = []
  // Instance roots where $path folders live, kept to know what to watch.
  private watchDirs: string[] = []
  private watchers: FSWatcher[] = []
  private studioWatcher: FSWatcher | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null
  private studioTree: StudioNode[] | null = null
  private closed = false
  private onChange: ((change: ProjectChange) => void) | null = null

  private constructor(root: string, info: ProjectInfo) {
    this.root = root
    this.info = info
  }

  static async open(root: string): Promise<Project> {
    const full = resolve(root)
    const info = await loadProjectInfo(full)
    const project = new Project(full, info)
    await project.refresh()
    return project
  }

  // Rebuilds everything from disk and reports what changed.
  async refresh(): Promise<ProjectChange> {
    const info = await loadProjectInfo(this.root).catch(() => this.info)
    const projectJson = (await readJson<{ tree?: Record<string, unknown> }>(join(this.root, 'default.project.json'))) ?? {}
    this.watchDirs = collectPaths(projectJson.tree)
    const sourcemap = await readJson<SourcemapNode>(join(this.root, 'sourcemap.json'))
    let repoTree: TreeNode[]
    if (sourcemap && typeof sourcemap.name === 'string' && typeof sourcemap.className === 'string') {
      repoTree = treeFromSourcemap(this.root, sourcemap)
    } else {
      repoTree = await buildRepoTree(this.root, projectJson)
    }
    // A half-written snapshot keeps the previous one; a deleted snapshot drops Studio nodes.
    const treeFile = join(this.root, '.studio-sync', 'tree.json')
    const snapshot = await readJson<{ roots?: StudioNode[] }>(treeFile)
    if (snapshot && Array.isArray(snapshot.roots)) this.studioTree = snapshot.roots
    else if (!(await stat(treeFile).catch(() => null))) this.studioTree = null
    const tree = mergeStudioTree(repoTree, this.studioTree)
    const scripts = buildScriptGroups(repoTree)
    const change: ProjectChange = {
      info: JSON.stringify(info) !== JSON.stringify(this.info),
      tree: JSON.stringify(tree) !== JSON.stringify(this.tree),
      scripts: JSON.stringify(scripts) !== JSON.stringify(this.scripts)
    }
    this.info = info
    this.tree = tree
    this.scripts = scripts
    return change
  }

  // Watches the Rojo folders, the project files and .studio-sync/tree.json. Debounced 300ms.
  watch(onChange: (change: ProjectChange) => void): void {
    this.onChange = onChange
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
          schedule()
        })
        watcher.on('error', () => watcher.close())
        this.watchers.push(watcher)
        return true
      } catch {
        return false
      }
    }
    const rootFiles = new Set(['default.project.json', 'sourcemap.json'])
    add(this.root, false, (file) => {
      if (file === '.studio-sync') {
        this.watchStudio()
        return true
      }
      return rootFiles.has(file)
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

  private watchStudio(): void {
    if (this.studioWatcher || this.closed) return
    try {
      this.studioWatcher = watch(join(this.root, '.studio-sync'), (_event, file) => {
        if (!file || String(file).startsWith('tree.json')) this.schedule()
      })
      this.studioWatcher.on('error', () => {
        this.studioWatcher?.close()
        this.studioWatcher = null
      })
    } catch {
      this.studioWatcher = null
    }
  }

  private schedule(): void {
    if (this.closed) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      this.refresh()
        .then((change) => {
          if (!this.closed && (change.info || change.tree || change.scripts)) this.onChange?.(change)
        })
        .catch(() => undefined)
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
