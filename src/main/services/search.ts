// Find in files / replace in files (SPEC §7.2 Search view). Plain Node: walks the project folder, reads
// each text file once and matches it line by line (shared/search/matcher.ts), streaming results in
// chunks so the view fills while the walk goes on and a changed query cancels the old one. No electron
// here: main/index.ts passes the project's own readFile / writeFile path for replaces.
import type { Dirent } from 'node:fs'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReplaceRequest, ReplaceResult, SearchFileResult, SearchMatch, SearchOptions, SearchSummary } from '../../shared/searchTypes.ts'
import { MAX_SEARCH_FILE_BYTES, MAX_SEARCH_MATCHES } from '../../shared/search/limits.ts'
import { buildMatcher, matchLine, previewLine, replaceInText, splitLines, type Matcher } from '../../shared/search/matcher.ts'
import { backupToProjectTrash } from './fileOps.ts'
import { resolveInside } from './project.ts'
import { rojoGlob } from './sync/mapping.ts'

// Folders never searched (Rojo / npm / build output, and Forge's own state with the delete backups).
export const SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules', 'Packages', 'ServerPackages', '.forge', '.studio-sync', 'out', 'dist', 'build'])
export const MAX_FILE_BYTES = MAX_SEARCH_FILE_BYTES
export const MAX_MATCHES = MAX_SEARCH_MATCHES

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tga', 'webp', 'ico', 'psd', 'mp3', 'ogg', 'wav', 'flac', 'mp4', 'mov', 'webm',
  'rbxm', 'rbxl', 'rbxmx', 'rbxlx', 'fbx', 'obj', 'glb', 'mesh', 'ttf', 'otf', 'woff', 'woff2', 'zip', 'gz', '7z', 'exe', 'dll', 'so', 'dylib', 'node', 'pdf'
])
const PARALLEL = 16
const FLUSH_FILES = 20
const FLUSH_MS = 80

const toPosix = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '')

// ---------------------------------------------------------------- globs

// "a, b/**, *.{luau,lua}": split at commas outside braces.
function splitGlobs(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const c of text) {
    if (c === '{') depth++
    else if (c === '}') depth = Math.max(0, depth - 1)
    if (c === ',' && !depth) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

interface GlobSet {
  // Match the entry itself / anything below it.
  exact: RegExp[]
  inside: RegExp[]
}

// Rojo's glob rules (rojoGlob: `*` also crosses `/`). A pattern with no slash matches at any depth
// ("*.luau", "Tests"); one with a slash is relative to the project folder ("src/server"). A folder
// name stands for everything below it.
export function compileGlobs(text: string): GlobSet | { error: string } {
  const set: GlobSet = { exact: [], inside: [] }
  for (const raw of splitGlobs(text)) {
    let p = toPosix(raw).replace(/\/+$/, '')
    const anchored = p.startsWith('/')
    p = p.replace(/^\/+/, '')
    if (!p) continue
    if (!anchored && !p.includes('/')) p = `**/${p}`
    const exact = rojoGlob(p)
    const inside = rojoGlob(`${p}/**`)
    if (!exact || !inside) return { error: `Invalid glob: ${raw}` }
    set.exact.push(exact)
    set.inside.push(inside)
  }
  return set
}

const hits = (res: RegExp[], rel: string) => res.some((re) => re.test(rel))

// ---------------------------------------------------------------- .gitignore

interface IgnoreRule {
  negate: boolean
  dirOnly: boolean
  re: RegExp
}

// The root .gitignore only (nested ones are rare in a Rojo project). Approximates git: `!` re-includes,
// a trailing `/` means folders only, a pattern with a slash is relative to the root, any other matches
// at any depth. Folders are pruned as a whole, so a file cannot be re-included below an ignored folder.
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/\s+$/, '')
    if (!line || line.startsWith('#')) continue
    const negate = line.startsWith('!')
    if (negate) line = line.slice(1)
    const dirOnly = line.endsWith('/')
    line = line.replace(/\/+$/, '')
    const anchored = line.includes('/')
    line = line.replace(/^\/+/, '')
    if (!line) continue
    const re = rojoGlob(anchored ? line : `**/${line}`)
    if (re) rules.push({ negate, dirOnly, re })
  }
  return rules
}

export function gitignored(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
  let ignored = false
  for (const r of rules) {
    if ((r.dirOnly && !isDir) || r.negate !== ignored) continue
    if (r.re.test(rel)) ignored = !r.negate
  }
  return ignored
}

// ---------------------------------------------------------------- walking and reading

interface Filter {
  include: GlobSet | null
  exclude: GlobSet
  ignore: IgnoreRule[]
}

async function listFiles(root: string, filter: Filter, cancelled: () => boolean): Promise<string[]> {
  const out: string[] = []
  const walk = async (rel: string): Promise<void> => {
    if (cancelled()) return
    let entries: Dirent[]
    try {
      entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const dirs: string[] = []
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name
      // Symlinks are neither files nor directories here: a link never leads out of the project.
      if (e.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(e.name) || hits(filter.exclude.exact, child) || gitignored(filter.ignore, child, true)) continue
        dirs.push(child)
      } else if (e.isFile()) {
        if (hits(filter.exclude.exact, child) || hits(filter.exclude.inside, child) || gitignored(filter.ignore, child, false)) continue
        if (filter.include && !hits(filter.include.exact, child) && !hits(filter.include.inside, child)) continue
        out.push(child)
      }
    }
    for (const dir of dirs) await walk(dir)
  }
  await walk('')
  return out
}

const extOf = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase()

type Read = { text: string } | { skip: 'large' | 'binary' | 'gone' }

// The text of a file, or why it is not searched: over the size cap, binary (a NUL in the first 8 KB or a
// known binary extension), gone.
async function readText(full: string, rel: string): Promise<Read> {
  if (BINARY_EXT.has(extOf(rel))) return { skip: 'binary' }
  try {
    const info = await stat(full)
    if (!info.isFile()) return { skip: 'gone' }
    if (info.size > MAX_FILE_BYTES) return { skip: 'large' }
    const buf = await readFile(full)
    if (buf.subarray(0, 8000).includes(0)) return { skip: 'binary' }
    return { text: buf.toString('utf8') }
  } catch {
    return { skip: 'gone' }
  }
}

// Matches of one file's text, up to `room` of them.
export function searchText(text: string, matcher: Matcher, room: number): SearchMatch[] {
  const { lines } = splitLines(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  const out: SearchMatch[] = []
  for (let i = 0; i < lines.length && out.length < room; i++) {
    for (const hit of matchLine(matcher, lines[i], room - out.length)) {
      const preview = previewLine(lines[i], hit.index, hit.length)
      const match: SearchMatch = { line: i + 1, col: hit.index + 1, endCol: hit.index + hit.length + 1, ...preview }
      if (hit.groups) match.groups = hit.groups
      if (hit.named) match.named = hit.named
      out.push(match)
    }
  }
  return out
}

export interface SearchHooks {
  // A chunk of results (files in path order).
  onFiles: (files: SearchFileResult[]) => void
  signal?: AbortSignal
}

export async function runSearch(root: string, id: string, options: SearchOptions, hooks: SearchHooks): Promise<SearchSummary> {
  const summary: SearchSummary = { id, files: 0, matches: 0, limitHit: false, cancelled: false, skippedLarge: 0, skippedBinary: 0 }
  const built = buildMatcher(options)
  if ('error' in built) return { ...summary, error: `Invalid regular expression: ${built.error}` }
  if ('empty' in built) return summary
  const include = compileGlobs(options.include ?? '')
  const exclude = compileGlobs(options.exclude ?? '')
  if ('error' in include) return { ...summary, error: include.error }
  if ('error' in exclude) return { ...summary, error: exclude.error }
  const cancelled = () => !!hooks.signal?.aborted
  const ignore = options.useIgnore ? parseGitignore(await readFile(join(root, '.gitignore'), 'utf8').catch(() => '')) : []
  const paths = await listFiles(root, { include: include.exact.length ? include : null, exclude, ignore }, cancelled)

  let pending: SearchFileResult[] = []
  let lastFlush = Date.now()
  const flush = () => {
    if (pending.length) hooks.onFiles(pending)
    pending = []
    lastFlush = Date.now()
  }
  for (let i = 0; i < paths.length && !summary.limitHit && !cancelled(); i += PARALLEL) {
    const chunk = paths.slice(i, i + PARALLEL)
    const reads = await Promise.all(chunk.map((rel) => readText(join(root, rel), rel)))
    for (let j = 0; j < chunk.length && !summary.limitHit; j++) {
      const read = reads[j]
      if ('skip' in read) {
        if (read.skip === 'large') summary.skippedLarge++
        else if (read.skip === 'binary') summary.skippedBinary++
        continue
      }
      const room = MAX_MATCHES - summary.matches
      const matches = searchText(read.text, built.matcher, room)
      if (!matches.length) continue
      summary.files++
      summary.matches += matches.length
      pending.push({ path: chunk[j], matches })
      if (summary.matches >= MAX_MATCHES) summary.limitHit = true
    }
    if (pending.length >= FLUSH_FILES || Date.now() - lastFlush >= FLUSH_MS) flush()
  }
  summary.cancelled = cancelled()
  if (!summary.cancelled) flush()
  return summary
}

// ---------------------------------------------------------------- replace

export interface ReplaceDeps {
  // The project's own write path (main/index.ts: Project.writeFile), so the watcher, Forge Sync and the
  // open editor tabs see the change like any other save.
  writeFile: (path: string, contents: string) => Promise<void>
  now?: () => number
  log?: (text: string) => void
}

// Why a path from the renderer is refused before it is even opened.
function refusal(path: string): string | null {
  if (!path || path.includes('\0') || /^([a-zA-Z]:|\/)/.test(path)) return 'outside the project'
  const parts = path.split('/')
  if (parts.some((p) => p === '..' || p === '')) return 'outside the project'
  if (parts.slice(0, -1).some((p) => SEARCH_SKIP_DIRS.has(p))) return 'not a searched folder'
  return null
}

export async function replaceInProject(root: string, request: ReplaceRequest, deps: ReplaceDeps): Promise<ReplaceResult> {
  const result: ReplaceResult = { files: [], replaced: 0, skipped: [], stale: 0 }
  const built = buildMatcher(request.options ?? { query: '', caseSensitive: false, wholeWord: false, regex: false })
  if ('error' in built) return { ...result, error: `Invalid regular expression: ${built.error}` }
  if ('empty' in built) return { ...result, error: 'Type what to search for first.' }
  const replacement = typeof request.replacement === 'string' ? request.replacement : ''
  const dirty = new Set((request.dirty ?? []).map(toPosix))
  const skip = (path: string, reason: string) => result.skipped.push({ path, reason })

  // Read and compute everything first; nothing is written until every copy is kept.
  const todo: { path: string; text: string; count: number }[] = []
  const seen = new Set<string>()
  for (const target of Array.isArray(request.targets) ? request.targets : []) {
    const path = toPosix(String(target?.path ?? ''))
    if (seen.has(path)) continue
    seen.add(path)
    const why = refusal(path)
    if (why) {
      skip(path, why)
      continue
    }
    if (dirty.has(path)) {
      skip(path, 'unsaved changes in the editor')
      continue
    }
    let full: string
    try {
      full = await resolveInside(root, path)
      if ((await lstat(full)).isSymbolicLink()) throw new Error('a link')
    } catch (e) {
      const message = e instanceof Error ? e.message : ''
      skip(path, /outside/.test(message) ? 'outside the project' : /ENOENT/.test(message) ? 'no longer exists' : 'not a file in the project')
      continue
    }
    const read = await readText(full, path)
    if ('skip' in read) {
      skip(path, read.skip === 'large' ? 'over 1 MB' : read.skip === 'binary' ? 'not a text file' : 'no longer exists')
      continue
    }
    const only = target.only ? new Set(target.only.map((m) => `${m.line}:${m.col}`)) : undefined
    const out = replaceInText(read.text, built.matcher, replacement, !!request.preserveCase, only)
    result.stale += out.stale
    if (!out.count) {
      skip(path, 'the matches are gone (the file changed since the search)')
      continue
    }
    todo.push({ path, text: out.text, count: out.count })
  }

  const at = (deps.now ?? Date.now)()
  for (const file of todo) {
    try {
      const copy = await backupToProjectTrash(root, file.path, () => at)
      result.backup ??= copy.slice(0, copy.length - file.path.length - 1)
    } catch (e) {
      skip(file.path, `could not keep a copy first: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    try {
      await deps.writeFile(file.path, file.text)
    } catch (e) {
      skip(file.path, `could not write it: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    result.files.push({ path: file.path, count: file.count })
    result.replaced += file.count
  }
  if (result.files.length) deps.log?.(`replaced ${result.replaced} match${result.replaced === 1 ? '' : 'es'} in ${result.files.length} file${result.files.length === 1 ? '' : 's'}${result.backup ? `; copies in ${result.backup}` : ''}`)
  return result
}

// ---------------------------------------------------------------- service

// Options from the renderer, whatever they hold.
function cleanOptions(o: Partial<SearchOptions> | null | undefined): SearchOptions {
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  return { query: text(o?.query), caseSensitive: o?.caseSensitive === true, wholeWord: o?.wholeWord === true, regex: o?.regex === true, include: text(o?.include).slice(0, 2000), exclude: text(o?.exclude).slice(0, 2000), useIgnore: o?.useIgnore !== false }
}

export interface SearchServiceDeps extends Pick<ReplaceDeps, 'writeFile' | 'log'> {
  root: () => string | null
  emit: (id: string, files: SearchFileResult[]) => void
}

// One running search per id: starting another with the same id cancels the first.
export class SearchService {
  private running = new Map<string, AbortController>()

  private deps: SearchServiceDeps

  constructor(deps: SearchServiceDeps) {
    this.deps = deps
  }

  private requireRoot(): string {
    const root = this.deps.root()
    if (!root) throw new Error('No project open')
    return root
  }

  async search(id: unknown, options: SearchOptions): Promise<SearchSummary> {
    const key = String(id ?? '')
    const root = this.requireRoot()
    this.running.get(key)?.abort()
    const control = new AbortController()
    this.running.set(key, control)
    try {
      return await runSearch(root, key, cleanOptions(options), { signal: control.signal, onFiles: (files) => !control.signal.aborted && this.deps.emit(key, files) })
    } finally {
      if (this.running.get(key) === control) this.running.delete(key)
    }
  }

  cancel(id: unknown): void {
    this.running.get(String(id ?? ''))?.abort()
  }

  replace(request: ReplaceRequest): Promise<ReplaceResult> {
    const { query, caseSensitive, wholeWord, regex } = cleanOptions(request?.options)
    return replaceInProject(this.requireRoot(), { ...request, options: { query, caseSensitive, wholeWord, regex } }, this.deps)
  }
}
