// Native Rojo-compatible sourcemap.json generator & debounced watcher for Forge Direct Sync.
// Emits identical { name, className, filePaths, children } trees to `rojo sourcemap --include-non-scripts`
// so luau-lsp, rur, and ree resolve every DataModel & Wally Packages/ require without running rojo.

import { watch, type FSWatcher } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { cleanRel, isSkipped, loadPlaces, parseFileName, rojoGlob, type PlaceMap } from './mapping.ts'
import { atomicWrite } from './store.ts'

export interface SourcemapNode {
  name: string
  className: string
  filePaths?: string[]
  children?: SourcemapNode[]
}

export interface SourcemapBuildResult {
  tree: SourcemapNode
  nodeCount: number
}

export interface SourcemapStats {
  path: string
  updatedAt: number
  nodes: number
}

const KNOWN_SERVICES = new Set([
  'Workspace',
  'Players',
  'Lighting',
  'MaterialService',
  'NetworkClient',
  'ReplicatedFirst',
  'ReplicatedStorage',
  'ServerScriptService',
  'ServerStorage',
  'StarterGui',
  'StarterPack',
  'StarterPlayer',
  'StarterPlayerScripts',
  'StarterCharacterScripts',
  'Teams',
  'SoundService',
  'Chat',
  'TextChatService',
  'LocalizationService',
  'TestService',
  'HttpService',
  'RunService',
  'UserInputService'
])

const SCRIPT_FROM_EXT_CLASS: Record<string, string> = {
  Script: 'Script',
  LocalScript: 'LocalScript',
  ModuleScript: 'ModuleScript'
}

const relForward = (root: string, abs: string): string => relative(root, abs).replace(/\\/g, '/')

function isIgnored(globs: string[], rel: string): boolean {
  if (!globs.length) return false
  return isSkipped(globs, rel)
}

function compileGlobs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((g): g is string => typeof g === 'string' && !!rojoGlob(g))
}

function countNodes(node: SourcemapNode): number {
  let n = 1
  if (node.children) for (const c of node.children) n += countNodes(c)
  return n
}

async function readJsonSafe(file: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function mergeNodes(base: SourcemapNode, overlay: SourcemapNode): SourcemapNode {
  const filePaths = [...new Set([...(base.filePaths ?? []), ...(overlay.filePaths ?? [])])]
  const childMap = new Map<string, SourcemapNode>()
  for (const c of base.children ?? []) childMap.set(c.name, c)
  for (const c of overlay.children ?? []) {
    const prev = childMap.get(c.name)
    childMap.set(c.name, prev ? mergeNodes(prev, c) : c)
  }
  const children = [...childMap.values()].sort((a, b) => a.name.localeCompare(b.name))
  return {
    name: overlay.name || base.name,
    className: overlay.className || base.className,
    ...(filePaths.length ? { filePaths } : {}),
    ...(children.length ? { children } : {})
  }
}

function stripMetaAndOrder(node: SourcemapNode): SourcemapNode {
  const out: SourcemapNode = { name: node.name, className: node.className }
  if (node.filePaths?.length) out.filePaths = [...new Set(node.filePaths)]
  if (node.children?.length) {
    out.children = [...node.children]
      .map(stripMetaAndOrder)
      .sort((a, b) => a.name.localeCompare(b.name))
  }
  return out
}

function modelJsonNode(name: string, rel: string, data: Record<string, unknown> | null): SourcemapNode {
  const rawClass = (data?.ClassName ?? data?.className) as unknown
  const className = typeof rawClass === 'string' && rawClass ? rawClass : 'Folder'
  const rawChildren = (data?.Children ?? data?.children) as unknown
  const children: SourcemapNode[] = []
  if (Array.isArray(rawChildren)) {
    for (const c of rawChildren) {
      if (!c || typeof c !== 'object') continue
      const obj = c as Record<string, unknown>
      const cn = typeof obj.Name === 'string' ? obj.Name : typeof obj.name === 'string' ? obj.name : ''
      if (cn) children.push(modelJsonNode(cn, rel, obj))
    }
  }
  return {
    name,
    className,
    filePaths: [rel],
    ...(children.length ? { children } : {})
  }
}

async function scanFsPath(
  root: string,
  absPath: string,
  nodeName: string,
  explicitClass: string | undefined,
  ignoreGlobs: string[],
  visitedRealPaths: Set<string>
): Promise<SourcemapNode | null> {
  const rel = relForward(root, absPath)
  if (rel && isIgnored(ignoreGlobs, rel)) return null

  let stat
  try {
    stat = await fsp.stat(absPath)
  } catch {
    return null
  }

  if (stat.isFile()) {
    const base = basename(absPath)
    const info = parseFileName(base, true)
    if (info?.kind === 'script') {
      return { name: nodeName, className: explicitClass || SCRIPT_FROM_EXT_CLASS[info.className ?? ''] || 'ModuleScript', filePaths: [rel] }
    }
    if (info?.kind === 'model') {
      const data = await readJsonSafe(absPath)
      const built = modelJsonNode(nodeName, rel, data)
      if (explicitClass) built.className = explicitClass
      return built
    }
    if (base.endsWith('.json') && !base.endsWith('.meta.json') && !base.endsWith('.project.json')) {
      return { name: nodeName, className: explicitClass || 'ModuleScript', filePaths: [rel] }
    }
    if (base.endsWith('.txt')) {
      return { name: nodeName, className: explicitClass || 'StringValue', filePaths: [rel] }
    }
    if (base.endsWith('.rbxm') || base.endsWith('.rbxmx')) {
      return { name: nodeName, className: explicitClass || 'Model', filePaths: [rel] }
    }
    return { name: nodeName, className: explicitClass || 'Folder', filePaths: [rel] }
  }

  if (!stat.isDirectory()) return null

  const real = await fsp.realpath(absPath).catch(() => absPath)
  if (visitedRealPaths.has(real)) return null
  visitedRealPaths.add(real)

  try {
    const entries = await fsp.readdir(absPath, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))

    let className = explicitClass || (KNOWN_SERVICES.has(nodeName) ? nodeName : 'Folder')
    const filePaths: string[] = []
    const childMap = new Map<string, SourcemapNode>()

    // Check init.meta.json first
    const initMeta = entries.find((e) => e.isFile() && e.name === 'init.meta.json')
    if (initMeta) {
      const metaRel = relForward(root, join(absPath, initMeta.name))
      filePaths.push(metaRel)
      const meta = await readJsonSafe(join(absPath, initMeta.name))
      if (!explicitClass && typeof meta?.className === 'string' && meta.className) className = meta.className
    }

    // Check default.project.json inside subdirectory (Wally _Index / package sub-projects)
    const nestedProject = entries.find((e) => e.isFile() && e.name === 'default.project.json')
    if (nestedProject && rel !== '') {
      const builtNested = await buildSourcemapFromProjectFile(root, relForward(root, join(absPath, nestedProject.name)), ignoreGlobs, visitedRealPaths)
      if (builtNested) {
        builtNested.name = nodeName
        if (explicitClass) builtNested.className = explicitClass
        return builtNested
      }
    }

    // Check init.* script (promotes this folder)
    const initCandidates = ['init.server.luau', 'init.server.lua', 'init.client.luau', 'init.client.lua', 'init.luau', 'init.lua']
    let initName: string | null = null
    for (const cand of initCandidates) {
      if (entries.some((e) => e.isFile() && e.name === cand)) {
        initName = cand
        break
      }
    }
    if (initName) {
      const parsed = parseFileName(initName, true)
      if (parsed?.kind === 'script') {
        if (!explicitClass) className = parsed.className || 'ModuleScript'
        filePaths.push(relForward(root, join(absPath, initName)))
      }
    }

    // Index adjacent *.meta.json files by stem
    const metaByStem = new Map<string, { rel: string; className?: string }>()
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.meta.json') || e.name === 'init.meta.json') continue
      const stem = e.name.slice(0, -'.meta.json'.length)
      if (!stem) continue
      const metaRel = relForward(root, join(absPath, e.name))
      const meta = await readJsonSafe(join(absPath, e.name))
      metaByStem.set(stem, {
        rel: metaRel,
        ...(typeof meta?.className === 'string' && meta.className ? { className: meta.className } : {})
      })
    }

    for (const e of entries) {
      if (e.name === '.git' || e.name === '.forge' || e.name === 'node_modules' || e.name === '.gitkeep' || e.name === '.DS_Store') continue
      if (e.name.endsWith('.forge-tmp')) continue
      if (initName && e.name === initName) continue
      if (e.name === 'init.meta.json' || e.name.endsWith('.meta.json')) continue

      const childAbs = join(absPath, e.name)
      const childRel = relForward(root, childAbs)
      if (isIgnored(ignoreGlobs, childRel)) continue

      if (e.isDirectory() || e.isSymbolicLink()) {
        const sub = await scanFsPath(root, childAbs, e.name, undefined, ignoreGlobs, visitedRealPaths)
        if (sub) {
          const prev = childMap.get(sub.name)
          childMap.set(sub.name, prev ? mergeNodes(prev, sub) : sub)
        }
        continue
      }

      if (!e.isFile()) continue
      const info = parseFileName(e.name, true)
      if (info?.kind === 'script') {
        if (info.stem === null) continue
        const stemName = info.stem
        const meta = metaByStem.get(stemName)
        const files = meta ? [childRel, meta.rel] : [childRel]
        const node: SourcemapNode = { name: stemName, className: info.className || 'ModuleScript', filePaths: files }
        const prev = childMap.get(stemName)
        childMap.set(stemName, prev ? mergeNodes(prev, node) : node)
      } else if (info?.kind === 'model') {
        if (info.stem === null) continue
        const stemName = info.stem
        const data = await readJsonSafe(childAbs)
        const node = modelJsonNode(stemName, childRel, data)
        const meta = metaByStem.get(stemName)
        if (meta) {
          node.filePaths = [...(node.filePaths ?? []), meta.rel]
          if (meta.className) node.className = meta.className
        }
        const prev = childMap.get(stemName)
        childMap.set(stemName, prev ? mergeNodes(prev, node) : node)
      } else if (e.name.endsWith('.json') && !e.name.endsWith('.project.json')) {
        const stem = e.name.slice(0, -'.json'.length)
        if (stem) {
          const meta = metaByStem.get(stem)
          const node: SourcemapNode = { name: stem, className: meta?.className || 'ModuleScript', filePaths: meta ? [childRel, meta.rel] : [childRel] }
          const prev = childMap.get(stem)
          childMap.set(stem, prev ? mergeNodes(prev, node) : node)
        }
      } else if (e.name.endsWith('.txt')) {
        const stem = e.name.slice(0, -'.txt'.length)
        if (stem) {
          const node: SourcemapNode = { name: stem, className: 'StringValue', filePaths: [childRel] }
          const prev = childMap.get(stem)
          childMap.set(stem, prev ? mergeNodes(prev, node) : node)
        }
      } else if (e.name.endsWith('.rbxm') || e.name.endsWith('.rbxmx')) {
        const stem = e.name.replace(/\.(rbxm|rbxmx)$/, '')
        if (stem) {
          const node: SourcemapNode = { name: stem, className: 'Model', filePaths: [childRel] }
          const prev = childMap.get(stem)
          childMap.set(stem, prev ? mergeNodes(prev, node) : node)
        }
      }
    }

    const children = [...childMap.values()].sort((a, b) => a.name.localeCompare(b.name))
    return {
      name: nodeName,
      className,
      ...(filePaths.length ? { filePaths } : {}),
      ...(children.length ? { children } : {})
    }
  } finally {
    visitedRealPaths.delete(real)
  }
}

async function resolveProjectTreeNode(
  root: string,
  projectDir: string,
  nodeName: string,
  obj: Record<string, unknown>,
  ignoreGlobs: string[],
  visitedRealPaths: Set<string>,
  rootProjectFile?: string
): Promise<SourcemapNode> {
  const explicitClass = typeof obj.$className === 'string' && obj.$className ? obj.$className : undefined
  const defaultClass = explicitClass || (KNOWN_SERVICES.has(nodeName) ? nodeName : 'Folder')

  let result: SourcemapNode = {
    name: nodeName,
    className: defaultClass,
    ...(rootProjectFile ? { filePaths: [rootProjectFile] } : {})
  }

  if (typeof obj.$path === 'string' && obj.$path) {
    const cleaned = cleanPathTarget(obj.$path)
    if (cleaned) {
      const absTarget = resolve(projectDir, cleaned)
      const fsNode = await scanFsPath(root, absTarget, nodeName, explicitClass, ignoreGlobs, visitedRealPaths)
      if (fsNode) result = mergeNodes(result, fsNode)
    }
  } else if (typeof obj.$path === 'object' && obj.$path && !Array.isArray(obj.$path)) {
    const optional = (obj.$path as Record<string, unknown>).optional
    if (typeof optional === 'string' && optional) {
      const absTarget = resolve(projectDir, optional)
      const fsNode = await scanFsPath(root, absTarget, nodeName, explicitClass, ignoreGlobs, visitedRealPaths)
      if (fsNode) result = mergeNodes(result, fsNode)
    }
  }

  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith('$') || !val || typeof val !== 'object' || Array.isArray(val)) continue
    const child = await resolveProjectTreeNode(root, projectDir, key, val as Record<string, unknown>, ignoreGlobs, visitedRealPaths)
    const prev = result.children?.find((c) => c.name === child.name)
    const others = (result.children ?? []).filter((c) => c.name !== child.name)
    result.children = [...others, prev ? mergeNodes(prev, child) : child]
  }

  if (explicitClass) result.className = explicitClass
  return stripMetaAndOrder(result)
}

function cleanPathTarget(p: string): string | null {
  const c = cleanRel(p)
  if (c) return c
  const trimmed = p.trim()
  if (!trimmed || trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) return null
  return trimmed
}

async function buildSourcemapFromProjectFile(
  root: string,
  projectFile: string,
  parentIgnoreGlobs: string[],
  visitedRealPaths: Set<string>
): Promise<SourcemapNode | null> {
  const absProj = join(root, projectFile)
  const json = await readJsonSafe(absProj)
  if (!json || !json.tree || typeof json.tree !== 'object' || Array.isArray(json.tree)) return null
  const ignoreGlobs = [...parentIgnoreGlobs, ...compileGlobs(json.globIgnorePaths)]
  const treeObj = json.tree as Record<string, unknown>
  const name = typeof json.name === 'string' && json.name ? json.name : basename(projectFile, '.project.json')
  return resolveProjectTreeNode(root, dirname(absProj), name, treeObj, ignoreGlobs, visitedRealPaths, projectFile)
}

export async function buildSourcemap(root: string, projectFile = 'default.project.json'): Promise<SourcemapBuildResult> {
  const absRoot = resolve(root)
  const absProj = join(absRoot, projectFile)
  const json = await readJsonSafe(absProj)
  if (!json || !json.tree || typeof json.tree !== 'object' || Array.isArray(json.tree)) {
    throw new Error(`Invalid or missing project file: ${projectFile}`)
  }
  const ignoreGlobs = compileGlobs(json.globIgnorePaths)
  const treeObj = json.tree as Record<string, unknown>
  const name = typeof json.name === 'string' && json.name ? json.name : basename(projectFile, '.project.json')
  if (typeof treeObj.$className !== 'string' || !treeObj.$className) treeObj.$className = 'DataModel'
  const tree = await resolveProjectTreeNode(absRoot, dirname(absProj), name, treeObj, ignoreGlobs, new Set(), projectFile)
  return { tree, nodeCount: countNodes(tree) }
}

export async function writeSourcemap(root: string, projectFile = 'default.project.json', outRel = 'sourcemap.json'): Promise<SourcemapStats> {
  const { tree, nodeCount } = await buildSourcemap(root, projectFile)
  const targetRel = cleanRel(outRel) || 'sourcemap.json'
  const outAbs = join(resolve(root), targetRel)
  await atomicWrite(fsp, outAbs, `${JSON.stringify(tree)}\n`)
  return { path: targetRel, updatedAt: Date.now(), nodes: nodeCount }
}

export interface SourcemapWatcherOptions {
  root: string
  debounceMs?: number
  onBuilt?: (projectFile: string, stats: SourcemapStats) => void
  onError?: (projectFile: string, err: Error) => void
}

function sourcemapOutOf(projectFile: string): string {
  return projectFile === 'default.project.json' ? 'sourcemap.json' : `sourcemap.${basename(projectFile, '.project.json')}.json`
}

export class SourcemapWatcher {
  private readonly root: string
  private readonly debounceMs: number
  private readonly onBuilt?: SourcemapWatcherOptions['onBuilt']
  private readonly onError?: SourcemapWatcherOptions['onError']
  private maps: PlaceMap[] = []
  private watchers: FSWatcher[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private building: Promise<void> | null = null
  private rebuildAgain = false
  private closed = false
  private statsMap = new Map<string, SourcemapStats>()

  constructor(opts: SourcemapWatcherOptions) {
    this.root = resolve(opts.root)
    this.debounceMs = opts.debounceMs ?? 150
    this.onBuilt = opts.onBuilt
    this.onError = opts.onError
  }

  lastStats(projectFile: string): SourcemapStats | undefined {
    return this.statsMap.get(projectFile)
  }

  async start(maps?: PlaceMap[]): Promise<void> {
    if (this.closed) return
    this.maps = maps ?? (await loadPlaces(this.root).catch(() => []))
    this.resetWatchers()
    await this.rebuildNow()
  }

  async setMaps(maps: PlaceMap[]): Promise<void> {
    if (this.closed) return
    this.maps = maps
    this.resetWatchers()
    await this.rebuildNow()
  }

  async rebuildNow(): Promise<void> {
    if (this.closed) return
    if (this.building) {
      this.rebuildAgain = true
      await this.building
      return
    }
    const run = (async () => {
      if (!this.maps.length) this.maps = await loadPlaces(this.root).catch(() => [])
      const targetFiles = this.maps.length
        ? this.maps.map((m) => ({ file: m.projectFile, out: sourcemapOutOf(m.projectFile) }))
        : await this.defaultFileList()
      for (const item of targetFiles) {
        if (this.closed) return
        try {
          const stats = await writeSourcemap(this.root, item.file, item.out)
          this.statsMap.set(item.file, stats)
          this.onBuilt?.(item.file, stats)
        } catch (e) {
          this.onError?.(item.file, e as Error)
        }
      }
    })()
    this.building = run
    try {
      await run
    } finally {
      this.building = null
    }
    if (this.rebuildAgain && !this.closed) {
      this.rebuildAgain = false
      await this.rebuildNow()
    }
  }

  private async defaultFileList(): Promise<{ file: string; out: string }[]> {
    try {
      const raw = await fsp.stat(join(this.root, 'default.project.json'))
      if (raw.isFile()) return [{ file: 'default.project.json', out: 'sourcemap.json' }]
    } catch {
      // no default project json
    }
    return []
  }

  private resetWatchers(): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
    if (this.closed) return

    const dirs = new Set<string>([this.root])
    for (const m of this.maps) {
      for (const r of m.roots) dirs.add(resolve(this.root, r.path))
      for (const s of m.skipped) dirs.add(resolve(this.root, s.path))
    }

    for (const dir of dirs) {
      try {
        const w = watch(dir, { recursive: process.platform === 'win32' || process.platform === 'darwin', persistent: false }, (_event, filename) => {
          const f = typeof filename === 'string' ? filename.replace(/\\/g, '/') : ''
          if (this.shouldIgnoreEvent(f)) return
          this.schedule()
        })
        ;(w as { unref?: () => void }).unref?.()
        w.on('error', () => {
          // Ignore deleted dir watch errors
        })
        this.watchers.push(w)
      } catch {
        // Fallback: root watch catches top-level project.json edits
      }
    }
  }

  private shouldIgnoreEvent(rel: string): boolean {
    if (!rel) return false
    const base = rel.split('/').pop() ?? ''
    if (base === 'sourcemap.json' || base.endsWith('.sourcemap.json') || base.endsWith('.forge-tmp')) return true
    if (rel === '.git' || rel.startsWith('.git/') || rel === '.forge' || rel.startsWith('.forge/') || rel.startsWith('node_modules/')) return true
    return false
  }

  private schedule(): void {
    if (this.closed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.rebuildNow()
    }, this.debounceMs)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const w of this.watchers) w.close()
    this.watchers = []
  }
}
