// UiPreviewService: runs UI Labs stories headless with Lune (resources/lune/preview.luau) for the
// UI Preview page and the preview_ui agent tool. No electron imports.
//
//   lune run <runtime>/preview.luau -- --sourcemap <tmp> --story <file> --width W --height H ...
//
// One interactive session at a time (the page); hot reload restarts it when the story file or any
// module it loaded is saved (state resets, control values are kept). render() runs a separate
// short-lived process for screenshots.

import type { ChildProcess } from 'node:child_process'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnTool, toolEnv, toRepoPath } from '../tools.ts'
import { findRuntimeDir, luneStatus } from '../tests/lune.ts'
import { buildSourcemap, type SourcemapNode } from '../tests/rojoTree.ts'
import { errorLocation, parsePreviewLine, PreviewTree, type UiInput, type UiPreviewLine } from '../../../shared/uiPreview/protocol.ts'
import type {
  UiConsoleEntry,
  UiDevice,
  UiOpenRequest,
  UiPreviewEvent,
  UiSessionState,
  UiStoryEntry,
  UiStoryList,
  UiStorybook
} from '../../../shared/uiPreviewTypes.ts'
import type { UiTreeSnapshot } from '../../../shared/uiPreview/protocol.ts'

export const PREVIEW_FILE = 'preview.luau'
const MAX_CONSOLE = 300
const RELOAD_DEBOUNCE_MS = 150

export interface UiPreviewOptions {
  emit?: (event: UiPreviewEvent) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  lunePath?: () => string | null | undefined
  runtimeDir?: string
  // Active place's project file; stories are listed from every *.project.json at the root.
  projectFile?: () => string | null | undefined
}

export function isStoryFile(path: string): boolean {
  return /\.story\.luau?$/.test(path)
}

export function storyName(file: string): string {
  const base = file.split('/').pop() ?? file
  return base.replace(/\.story\.luau?$/, '')
}

// Project files at the root, the active one first.
export async function projectFiles(root: string, active?: string | null): Promise<string[]> {
  const names = (await readdir(root).catch(() => [] as string[])).filter((n) => /^[^/\\]+\.project\.json$/.test(n)).sort()
  const first = active && names.includes(active) ? active : names.includes('default.project.json') ? 'default.project.json' : names[0]
  return first ? [first, ...names.filter((n) => n !== first)] : []
}

// Story and storybook files in a sourcemap tree (Wally packages skipped).
export function scanStories(tree: SourcemapNode): { stories: { file: string; path: string[] }[]; storybooks: { file: string; path: string[] }[] } {
  const stories: { file: string; path: string[] }[] = []
  const storybooks: { file: string; path: string[] }[] = []
  const walk = (node: SourcemapNode, parents: string[]) => {
    const here = node.className === 'DataModel' ? parents : [...parents, node.name]
    for (const file of node.filePaths ?? []) {
      if (/^(Server)?Packages\//.test(file)) continue
      if (/\.storybook\.luau?$/.test(file)) storybooks.push({ file, path: here })
      else if (isStoryFile(file)) stories.push({ file, path: here })
    }
    for (const child of node.children ?? []) walk(child, here)
  }
  walk(tree, [])
  return { stories, storybooks }
}

export interface ListedStorybook {
  file: string
  path: string[]
  name?: string
  groupRoots?: boolean
  roots?: string[]
  error?: string
}

// Groups stories under storybooks the UI Labs way: a story belongs to every storybook whose
// storyRoots contain it; groupRoots adds a sub-folder per root; the rest are "Unknown stories".
export function groupStories(stories: { file: string; path: string[] }[], books: ListedStorybook[], projectFile: string): UiStorybook[] {
  const out: UiStorybook[] = []
  const claimed = new Set<string>()
  const entry = (s: { file: string; path: string[] }, folder?: string): UiStoryEntry => ({
    file: s.file,
    name: storyName(s.file),
    path: s.path,
    projectFile,
    ...(folder ? { folder } : {})
  })
  for (const book of books) {
    const name = book.name ?? storyName(book.file.replace(/\.storybook(\.luau?)$/, '.story$1'))
    const roots = book.roots ?? []
    const list: UiStoryEntry[] = []
    for (const s of stories) {
      // Compare whole instance names: story modules are named like "Counter.story", so a full
      // name cannot be split on dots.
      let depth = 0
      const root = roots.find((r) => {
        for (let n = 1; n < s.path.length; n++) if (s.path.slice(0, n).join('.') === r) return (depth = n), true
        return false
      })
      if (!root) continue
      claimed.add(s.file)
      const inner = s.path.slice(depth, -1)
      const folder = [...(book.groupRoots ? [s.path[depth - 1]] : []), ...inner].join(' / ')
      list.push(entry(s, folder || undefined))
    }
    out.push({ name, file: book.file, stories: list, ...(book.error ? { error: book.error } : {}) })
  }
  const rest = stories.filter((s) => !claimed.has(s.file))
  if (rest.length) out.push({ name: books.length ? 'Unknown stories' : 'Stories', stories: rest.map((s) => entry(s, s.path.slice(-2, -1)[0])) })
  return out
}

// Folds preview lines into a state (shared by the page session and headless renders).
export class SessionModel {
  tree = new PreviewTree()
  console: UiConsoleEntry[] = []
  modules: string[] = []
  controls: UiSessionState['controls'] = []
  kind: UiSessionState['kind']
  frames = 0
  fatal: string | null = null

  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  addConsole(level: UiConsoleEntry['level'], text: string): UiConsoleEntry {
    const loc = level === 'print' ? null : errorLocation(text)
    const entry: UiConsoleEntry = { at: Date.now(), level, text, ...(loc ? { file: this.relative(loc.file), line: loc.line } : {}) }
    this.console.push(entry)
    if (this.console.length > MAX_CONSOLE) this.console.splice(0, this.console.length - MAX_CONSOLE)
    return entry
  }

  private relative(file: string): string {
    const root = toRepoPath(this.root).replace(/\/?$/, '/')
    const f = toRepoPath(file)
    return f.startsWith(root) ? f.slice(root.length) : f
  }

  // Applies one line; returns the console entry it produced, if any.
  apply(line: UiPreviewLine): UiConsoleEntry | null {
    switch (line.type) {
      case 'ops':
        this.tree.apply(line.ops)
        return null
      case 'story':
        this.kind = line.kind
        this.controls = line.controls
        return null
      case 'log':
        return this.addConsole(line.level, line.text)
      case 'error':
        return this.addConsole('error', line.traceback && !line.message.includes(line.traceback) ? `${line.message}\n${line.traceback}` : line.message)
      case 'frame':
        this.frames = Math.max(this.frames, line.n)
        return null
      case 'modules':
        this.modules = line.files
        return null
      case 'fatal':
        this.fatal = line.message
        return this.addConsole('error', line.message)
      default:
        return null
    }
  }
}

class LineSplitter {
  private buffer = ''
  push(chunk: string): string[] {
    this.buffer += chunk
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''
    return lines
  }
  flush(): string[] {
    const rest = this.buffer
    this.buffer = ''
    return rest ? [rest] : []
  }
}

interface Session {
  id: number
  request: UiOpenRequest
  child: ChildProcess | null
  model: SessionModel
  status: UiSessionState['status']
  values: Record<string, unknown>
  mapFile: string
  message?: string
}

export interface RenderRequest {
  file: string
  width?: number
  height?: number
  device?: UiDevice
  controls?: Record<string, unknown>
  // Instance names or relative paths ("RacingHud.BOOSTButton") to click, in order, before capturing.
  clicks?: string[]
  // How long to let the story settle after the first frame and after each click.
  settleMs?: number
  timeoutMs?: number
}

export interface RenderResult {
  file: string
  tree: UiTreeSnapshot
  console: UiConsoleEntry[]
  kind?: UiSessionState['kind']
  clicked: string[]
  missing: string[]
  error?: string
}

export class UiPreviewService {
  private options: UiPreviewOptions
  private root: string | null = null
  private session: Session | null = null
  private nextId = 1
  private watcher: FSWatcher | null = null
  private reloadTimer: ReturnType<typeof setTimeout> | null = null
  private storyProjects = new Map<string, string>()

  constructor(options: UiPreviewOptions = {}) {
    this.options = options
  }

  setRoot(root: string | null): void {
    this.close()
    this.root = root
    this.storyProjects.clear()
  }

  private emit(event: UiPreviewEvent): void {
    this.options.emit?.(event)
  }

  private runtime(): string | null {
    const dir = this.options.runtimeDir ?? findRuntimeDir()
    return dir && existsSync(join(dir, PREVIEW_FILE)) ? dir : null
  }

  private async lune(): Promise<{ path: string } | { hint: string }> {
    const status = await luneStatus(this.options.lunePath?.(), this.root ?? process.cwd())
    return status.available ? { path: status.path } : { hint: status.hint }
  }

  private async sourcemapFor(projectFile: string, id: string): Promise<string> {
    const tree = await buildSourcemap(this.root!, projectFile)
    const mapFile = join(tmpdir(), `rbx-forge-uipreview-${process.pid}-${id}.json`)
    await writeFile(mapFile, JSON.stringify(tree))
    return mapFile
  }

  // Runs preview.luau to completion and returns its parsed lines (used by --list).
  private runOnce(lunePath: string, args: string[], timeoutMs: number): Promise<UiPreviewLine[]> {
    return new Promise((resolve) => {
      const child = spawnTool(lunePath, args, { cwd: this.root!, env: toolEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
      const lines: UiPreviewLine[] = []
      const split = new LineSplitter()
      const timer = setTimeout(() => child.kill(), timeoutMs)
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        for (const l of split.push(chunk)) {
          const parsed = parsePreviewLine(l)
          if (parsed) lines.push(parsed)
        }
      })
      child.on('error', () => resolve(lines))
      child.on('close', () => {
        clearTimeout(timer)
        for (const l of split.flush()) {
          const parsed = parsePreviewLine(l)
          if (parsed) lines.push(parsed)
        }
        resolve(lines)
      })
    })
  }

  async listStories(): Promise<UiStoryList> {
    const root = this.root
    if (!root) return { storybooks: [], luneAvailable: false, hint: 'No project open.' }
    const lune = await this.lune()
    const runtime = this.runtime()
    const books: UiStorybook[] = []
    const seen = new Set<string>()
    this.storyProjects.clear()
    for (const projectFile of await projectFiles(root, this.options.projectFile?.())) {
      let tree: SourcemapNode
      try {
        tree = await buildSourcemap(root, projectFile)
      } catch {
        continue
      }
      const scanned = scanStories(tree)
      const fresh = scanned.stories.filter((s) => !seen.has(s.file))
      if (!fresh.length) continue
      for (const s of fresh) {
        seen.add(s.file)
        this.storyProjects.set(s.file, projectFile)
      }
      let listed: ListedStorybook[] = scanned.storybooks.map((b) => ({ ...b, roots: [b.path.slice(0, -1).join('.')] }))
      if ('path' in lune && runtime && scanned.storybooks.length) {
        const mapFile = join(tmpdir(), `rbx-forge-uipreview-${process.pid}-list.json`)
        await writeFile(mapFile, JSON.stringify(tree))
        const lines = await this.runOnce(lune.path, ['run', join(runtime, PREVIEW_FILE), '--', '--sourcemap', mapFile, '--list'], 20_000)
        await rm(mapFile, { force: true }).catch(() => undefined)
        const out = lines.find((l) => l.type === 'storybooks')
        if (out && out.type === 'storybooks') listed = out.storybooks
      }
      const grouped = groupStories(fresh, listed, projectFile)
      const label = projectFile === 'default.project.json' ? '' : ` (${projectFile.replace(/\.project\.json$/, '')})`
      for (const g of grouped) books.push({ ...g, name: g.name + label })
    }
    return { storybooks: books, luneAvailable: 'path' in lune && !!runtime, ...('hint' in lune ? { hint: lune.hint } : !runtime ? { hint: 'The UI preview runtime (resources/lune/preview.luau) is missing from this build.' } : {}) }
  }

  private async projectFor(file: string): Promise<string> {
    const known = this.storyProjects.get(file)
    if (known) return known
    for (const projectFile of await projectFiles(this.root!, this.options.projectFile?.())) {
      const tree = await buildSourcemap(this.root!, projectFile).catch(() => null)
      if (tree && scanStories(tree).stories.some((s) => s.file === file)) {
        this.storyProjects.set(file, projectFile)
        return projectFile
      }
    }
    return this.options.projectFile?.() || 'default.project.json'
  }

  private args(runtime: string, mapFile: string, request: { file: string; width?: number; height?: number; device?: string; controls?: Record<string, unknown> }, extra: string[] = []): string[] {
    const args = ['run', join(runtime, PREVIEW_FILE), '--', '--sourcemap', mapFile, '--story', request.file]
    args.push('--width', String(Math.round(request.width ?? 1280)), '--height', String(Math.round(request.height ?? 720)), '--device', request.device ?? 'desktop')
    if (request.controls && Object.keys(request.controls).length) args.push('--controls', JSON.stringify(request.controls))
    return [...args, ...extra]
  }

  state(): UiSessionState | null {
    const s = this.session
    if (!s) return null
    return {
      session: s.id,
      file: s.request.file,
      status: s.status,
      ...(s.model.kind ? { kind: s.model.kind } : {}),
      controls: s.model.controls,
      values: { ...s.values },
      tree: s.model.tree.snapshot(),
      console: [...s.model.console],
      modules: [...s.model.modules],
      ...(s.message ? { message: s.message } : {})
    }
  }

  async open(request: UiOpenRequest, reason: 'open' | 'reload' = 'open'): Promise<UiSessionState> {
    const root = this.root
    if (!root) throw new Error('No project open')
    const file = toRepoPath(request.file)
    const previous = this.session
    const keepValues = previous && previous.request.file === file ? previous.values : {}
    this.stopChild()
    const id = this.nextId++
    const model = new SessionModel(root)
    const session: Session = { id, request: { ...request, file }, child: null, model, status: 'starting', values: { ...keepValues, ...(request.controls ?? {}) }, mapFile: '' }
    this.session = session
    this.emit({ session: id, type: 'reset', file, status: 'starting', reason })
    await this.start(session)
    this.startWatch()
    return this.state()!
  }

  private async start(session: Session): Promise<void> {
    const lune = await this.lune()
    const runtime = this.runtime()
    const fail = (message: string) => {
      session.status = 'error'
      session.message = message
      const entry = session.model.addConsole('error', message)
      this.emit({ session: session.id, type: 'console', entry })
      this.emit({ session: session.id, type: 'status', status: 'error', message })
    }
    if (!('path' in lune)) return fail(lune.hint)
    if (!runtime) return fail('The UI preview runtime (resources/lune/preview.luau) is missing from this build.')
    try {
      session.mapFile = await this.sourcemapFor(await this.projectFor(session.request.file), String(session.id))
    } catch (error) {
      return fail((error as Error).message)
    }
    if (this.session !== session) return
    const child = spawnTool(lune.path, this.args(runtime, session.mapFile, { ...session.request, controls: session.values }), { cwd: this.root!, env: toolEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    session.child = child
    const split = new LineSplitter()
    const errSplit = new LineSplitter()
    const handle = (raw: string) => {
      const line = parsePreviewLine(raw)
      if (!line) {
        if (raw.trim()) this.emitConsole(session, 'print', raw)
        return
      }
      if (line.type === 'storybooks') return
      const entry = session.model.apply(line)
      if (this.session !== session) return
      if (entry) this.emit({ session: session.id, type: 'console', entry })
      else if (line.type === 'ops') this.emit({ session: session.id, type: 'ops', ops: line.ops })
      else if (line.type === 'story') this.emit({ session: session.id, type: 'story', kind: line.kind, controls: line.controls })
      else if (line.type === 'modules') this.emit({ session: session.id, type: 'modules', files: line.files })
      else if (line.type === 'frame' && session.status !== 'running') {
        session.status = 'running'
        this.emit({ session: session.id, type: 'status', status: 'running' })
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => split.push(chunk).forEach(handle))
    // Lune prints errors from spawned threads (signal handlers) on stderr.
    child.stderr?.on('data', (chunk: string) => {
      for (const l of errSplit.push(chunk)) if (l.trim()) this.emitConsole(session, 'error', l)
    })
    child.stdin?.on('error', () => undefined)
    child.on('error', (error) => this.emitConsole(session, 'error', `could not start lune: ${error.message}`))
    child.on('close', (code) => {
      split.flush().forEach(handle)
      if (session.child === child) session.child = null
      void rm(session.mapFile, { force: true }).catch(() => undefined)
      if (this.session === session && session.status !== 'reloading') {
        session.status = code === 0 || code === null ? 'exited' : 'error'
        this.emit({ session: session.id, type: 'status', status: session.status, ...(code ? { message: `lune exited with code ${code}` } : {}) })
      }
    })
  }

  private emitConsole(session: Session, level: UiConsoleEntry['level'], text: string): void {
    const entry = session.model.addConsole(level, text)
    if (this.session === session) this.emit({ session: session.id, type: 'console', entry })
  }

  input(message: UiInput): void {
    const s = this.session
    if (!s) return
    if (message.type === 'control') s.values[message.group ? `${message.group}/${message.key}` : message.key] = message.value
    if (message.type === 'resize') Object.assign(s.request, { width: message.width, height: message.height })
    if (message.type === 'device') s.request.device = message.device as UiDevice
    const stdin = s.child?.stdin
    if (stdin && !stdin.destroyed) stdin.write(JSON.stringify(message) + '\n')
  }

  // Restarts the story (state resets; control values, size and device are kept).
  async reload(): Promise<void> {
    const s = this.session
    if (!s) return
    s.status = 'reloading'
    this.stopChild()
    await this.open({ ...s.request, controls: s.values }, 'reload')
  }

  private stopChild(): void {
    const child = this.session?.child
    if (!child) return
    this.session!.child = null
    try {
      child.stdin?.end(JSON.stringify({ type: 'quit' }) + '\n')
    } catch {
      // closed already
    }
    setTimeout(() => child.kill(), 500).unref?.()
  }

  close(): void {
    this.stopWatch()
    this.stopChild()
    this.session = null
  }

  private startWatch(): void {
    const root = this.root
    if (!root || this.watcher) return
    try {
      this.watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) return
        const file = toRepoPath(String(filename))
        if (!/\.(luau|lua)$/.test(file) || /(^|\/)(node_modules|\.git)\//.test(file)) return
        if (!this.affects(file)) return
        if (this.reloadTimer) clearTimeout(this.reloadTimer)
        this.reloadTimer = setTimeout(() => {
          this.reloadTimer = null
          this.options.log?.(`[ui-preview] ${file} changed; reloading ${this.session?.request.file}`)
          void this.reload()
        }, RELOAD_DEBOUNCE_MS)
      })
      this.watcher.on('error', (error) => this.options.log?.(`[ui-preview] watch stopped: ${error.message}`, 'stderr'))
    } catch (error) {
      this.options.log?.(`[ui-preview] cannot watch files: ${(error as Error).message}`, 'stderr')
    }
  }

  // A save reloads the preview when it is the story or a module the story loaded (or, before the
  // first module list arrives, any Luau file).
  affects(file: string): boolean {
    const s = this.session
    if (!s) return false
    if (file === s.request.file) return true
    if (!s.model.modules.length) return true
    return s.model.modules.includes(file)
  }

  private stopWatch(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.reloadTimer = null
    this.watcher?.close()
    this.watcher = null
  }

  // Headless render for screenshots: runs the story, clicks the named elements, returns the tree.
  async render(request: RenderRequest): Promise<RenderResult> {
    const root = this.root
    const file = toRepoPath(request.file)
    const empty = (error: string): RenderResult => ({ file, tree: { root: null, nodes: [] }, console: [], clicked: [], missing: [], error })
    if (!root) return empty('No project open.')
    const lune = await this.lune()
    if (!('path' in lune)) return empty(lune.hint)
    const runtime = this.runtime()
    if (!runtime) return empty('The UI preview runtime (resources/lune/preview.luau) is missing from this build.')
    const mapFile = await this.sourcemapFor(await this.projectFor(file), `render-${Date.now()}`)
    const model = new SessionModel(root)
    const settle = request.settleMs ?? 400
    const child = spawnTool(lune.path, this.args(runtime, mapFile, { ...request, file }), { cwd: root, env: toolEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    const split = new LineSplitter()
    let firstFrame: (() => void) | null = null
    const framed = new Promise<void>((resolve) => (firstFrame = resolve))
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      for (const raw of split.push(chunk)) {
        const line = parsePreviewLine(raw)
        if (!line) continue
        model.apply(line)
        if (line.type === 'frame' || line.type === 'fatal') firstFrame?.()
      }
    })
    child.stderr?.on('data', (chunk: string) => {
      for (const l of chunk.split(/\r?\n/)) if (l.trim()) model.addConsole('error', l)
    })
    child.stdin?.on('error', () => undefined)
    const closed = new Promise<void>((resolve) => child.on('close', () => resolve()))
    child.on('error', () => firstFrame?.())
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), request.timeoutMs ?? 20_000))
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const clicked: string[] = []
    const missing: string[] = []
    let error: string | undefined
    const result = await Promise.race([framed.then(() => 'ok' as const), closed.then(() => 'closed' as const), timeout])
    if (result === 'ok' && !model.fatal) {
      await sleep(settle)
      for (const target of request.clicks ?? []) {
        const id = findNode(model.tree, target)
        if (id == null) {
          missing.push(target)
          continue
        }
        for (const type of ['down', 'up', 'click'] as const) child.stdin?.write(JSON.stringify({ type, id }) + '\n')
        clicked.push(target)
        await sleep(settle)
      }
    } else if (result === 'timeout') error = 'The story did not render within the time limit.'
    try {
      child.stdin?.end(JSON.stringify({ type: 'quit' }) + '\n')
    } catch {
      // closed
    }
    await Promise.race([closed, sleep(1500)])
    child.kill()
    await rm(mapFile, { force: true }).catch(() => undefined)
    if (model.fatal) error = model.fatal
    return { file, tree: model.tree.snapshot(), console: model.console, ...(model.kind ? { kind: model.kind } : {}), clicked, missing, ...(error ? { error } : {}) }
  }
}

// Node by name, relative path ("RacingHud.BOOSTButton") or full-path suffix; first match wins.
export function findNode(tree: PreviewTree, target: string): number | null {
  const want = target.trim()
  if (/^\d+$/.test(want) && tree.get(Number(want))) return Number(want)
  let byName: number | null = null
  for (const node of tree.nodes.values()) {
    const rel = tree.relativePath(node.id)
    if (rel === want || node.path === want || (node.path && node.path.endsWith('.' + want))) return node.id
    if (byName == null && node.name === want) byName = node.id
  }
  return byName
}
