// Compact, cached "project map": one short line per script with its category, size, top-level
// requires, exported members and (for Services/Controllers) whether Init/Start exist.
//
// Purpose: one cheap call (or one block in the cached system prompt prefix) replaces many
// list_scripts/read_script round trips. A ~60-script GenTree project renders to ~1.5k tokens.
//
// Incremental: refresh() re-reads only scripts whose stat (mtime+size) changed, or, without a
// stat function, whose content hash changed. render() output is memoized per options+version, so
// repeated calls are free and byte-identical (important for prompt caching).
//
// Over budget, render() degrades in steps: trim long export/require lists, then drop requires,
// then names only, then collapse whole folders to one summary line (largest first).

import { createHash } from 'node:crypto'
import type { ScriptCategory, ScriptEntry, ScriptGroup } from '../../../shared/types.ts'
import { estimateTokens, formatTokens } from './tokens.ts'

// What the map needs from HarnessContext. `stat` is optional: given it, unchanged files are not
// even read on refresh. (HarnessContext has no stat; services can pass fs.stat on the resolved path.)
export interface MapSource {
  scripts(): ScriptGroup[]
  readFile(path: string): Promise<string>
  stat?(path: string): Promise<{ mtimeMs: number; size: number }>
}

export type ExportKind = 'function' | 'method' | 'field'

export interface ExportInfo {
  name: string
  kind: ExportKind
  // 1-based line of the definition.
  line: number
}

export interface ParsedScript {
  lines: number
  // Top-level require targets, shortened (e.g. "Packages.Janitor", "script.Parent.Util").
  requires: string[]
  // Name of the returned local, when the module returns an identifier.
  returns?: string
  // True when the module returns a function (`return function`, or a local function).
  returnsFunction: boolean
  exports: ExportInfo[]
  // Generated file (Blink output); exports are not parsed.
  generated?: 'blink'
}

export interface MapEntry extends ParsedScript {
  path: string
  name: string
  realm: ScriptEntry['realm']
  category: ScriptCategory
  kind: ScriptEntry['kind']
  feature?: string
  // For Services/Controllers: lifecycle methods ModuleLoader calls.
  lifecycle?: { init: boolean; start: boolean }
}

export interface RenderOptions {
  // Token budget for the rendered text. Default 2500.
  maxTokens?: number
  // Only scripts under this repo-relative path prefix.
  path?: string
  realm?: ScriptEntry['realm']
  category?: string
  // Max exports listed per script before "+N". Default 8.
  maxExports?: number
}

export interface RenderResult {
  text: string
  tokens: number
  scripts: number
  // Which reduction step was needed: 0 = full detail ... 4 = folders collapsed.
  level: number
}

export interface RefreshResult {
  changed: string[]
  removed: string[]
  version: number
}

const CATEGORY_ABBR: Record<string, string> = {
  Configs: 'cfg',
  Data: 'data',
  Services: 'svc',
  Controllers: 'ctl',
  Modules: 'mod',
  Events: 'evt',
  UI: 'ui',
  'Entry points': 'entry',
  Other: 'other'
}

const LEGEND = 'legend: <file> <cat> <lines>L req=<requires: A.B instance path, a/b repo path under src/> exp=<exports; ()=function :=method> lc=<Init/Start for svc/ctl>'

// Roblox services commonly bound to locals; stripped from require targets to save tokens.
const SERVICE_ROOTS = new Set([
  'ReplicatedStorage',
  'ServerScriptService',
  'ServerStorage',
  'StarterPlayer',
  'StarterPlayerScripts',
  'ReplicatedFirst',
  'StarterGui',
  'Workspace',
  'workspace'
])

const IDENT = '[A-Za-z_][A-Za-z0-9_]*'
const RE_REQUIRE = /\brequire\s*\(\s*([^()]*(?:\([^()]*\)[^()]*)*)\)/g
const RE_RETURN = new RegExp(`^return\\s+(${IDENT})\\s*(?:--.*)?$`)
const RE_RETURN_FN = /^return\s+function\b/
const RE_LOCAL_FN = new RegExp(`^local\\s+function\\s+(${IDENT})\\b`)
const RE_FN_DEF = new RegExp(`^function\\s+(${IDENT})([.:])(${IDENT})\\s*\\(`)
const RE_FIELD = new RegExp(`^(${IDENT})\\.(${IDENT})\\s*=(?!=)`)

// Shortens a require argument: game:GetService("ReplicatedStorage").Packages.X -> Packages.X,
// ReplicatedStorage.Shared.Y -> Shared.Y, script:WaitForChild("Z") -> script.Z.
export function shortenRequire(arg: string): string {
  // Drop whitespace outside quoted names.
  let s = arg.trim().replace(/("[^"]*"|'[^']*')|\s+/g, (_m, q: string | undefined) => q ?? '')
  if (/^["'`]/.test(s)) return s.replace(/^["'`]|["'`]$/g, '')
  s = s.replace(/^game:GetService\(["']([^"']+)["']\)/, '$1')
  s = s.replace(/^game\./, '')
  s = s.replace(/:WaitForChild\(["']([^"']+)["'](?:,[^)]*)?\)/g, '.$1')
  s = s.replace(/:FindFirstChild\(["']([^"']+)["'](?:,[^)]*)?\)/g, '.$1')
  s = s.replace(/\[["']([^"']+)["']\]/g, '.$1')
  const parts = s.split('.')
  if (parts.length > 1 && SERVICE_ROOTS.has(parts[0])) parts.shift()
  return parts.join('.')
}

// Resolves `script.Parent.X` style targets against the requiring file's repo path, giving a repo
// path without src/ and extension ("server/Data/PlayerData"). Returns the input when it cannot.
export function resolveScriptRequire(filePath: string, target: string): string {
  if (!/^script(\.|$)/.test(target) || !filePath) return target
  const segs = filePath.split('/')
  const file = segs.pop() ?? ''
  // For init.* the script IS the folder; otherwise it is a child of the folder.
  const here = /^init(\.server|\.client)?\.(luau|lua)$/.test(file) ? segs : [...segs, file.replace(/(\.server|\.client)?\.(luau|lua)$/, '')]
  const parts = target.split('.').slice(1)
  const cur = here.slice()
  for (const p of parts) {
    if (p === 'Parent') {
      if (cur.length <= 1) return target
      cur.pop()
    } else cur.push(p)
  }
  if (cur[0] === 'src') cur.shift()
  return cur.join('/')
}

function isBlinkGenerated(source: string): boolean {
  return /File generated by Blink/.test(source.slice(0, 600))
}

// Parses a Luau source for the map. Line-based and top-level only (column 0), which matches how
// GenTree modules are written; it never throws.
export function parseLuau(source: string, filePath = ''): ParsedScript {
  const lines = source.split(/\r?\n/)
  const lineCount = source.length === 0 ? 0 : source.endsWith('\n') ? lines.length - 1 : lines.length
  if (isBlinkGenerated(source)) {
    return { lines: lineCount, requires: [], exports: [], returnsFunction: false, generated: 'blink' }
  }
  const requires: string[] = []
  const seenReq = new Set<string>()
  const defs: { table: string; name: string; kind: ExportKind; line: number }[] = []
  const localFns = new Set<string>()
  let returns: string | undefined
  let returnsFunction = false
  let inBlockComment = false

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    if (inBlockComment) {
      const end = line.indexOf(']]')
      if (end < 0) continue
      inBlockComment = false
      line = line.slice(end + 2)
      if (!line.trim()) continue
    }
    if (line.startsWith('--[[') || line.startsWith('--[=[')) {
      if (!line.includes(']]')) inBlockComment = true
      continue
    }
    if (!line || line[0] === ' ' || line[0] === '\t' || line.startsWith('--')) continue

    if (line.includes('require')) {
      RE_REQUIRE.lastIndex = 0
      for (let m = RE_REQUIRE.exec(line); m; m = RE_REQUIRE.exec(line)) {
        const target = resolveScriptRequire(filePath, shortenRequire(m[1]))
        if (target && !seenReq.has(target)) {
          seenReq.add(target)
          requires.push(target)
        }
      }
    }
    let m = RE_FN_DEF.exec(line)
    if (m) {
      defs.push({ table: m[1], name: m[3], kind: m[2] === ':' ? 'method' : 'function', line: i + 1 })
      continue
    }
    m = RE_LOCAL_FN.exec(line)
    if (m) {
      localFns.add(m[1])
      continue
    }
    m = RE_FIELD.exec(line)
    if (m) {
      const rhs = line.slice(m[0].length).trim()
      defs.push({ table: m[1], name: m[2], kind: /^function\b/.test(rhs) ? 'function' : 'field', line: i + 1 })
      continue
    }
    if (RE_RETURN_FN.test(line)) {
      returnsFunction = true
      returns = undefined
      continue
    }
    m = RE_RETURN.exec(line)
    if (m) {
      returns = m[1]
      returnsFunction = localFns.has(m[1])
    }
  }

  const exports: ExportInfo[] = []
  if (returns && !returnsFunction) {
    const seen = new Set<string>()
    for (const d of defs) {
      if (d.table !== returns || seen.has(d.name)) continue
      seen.add(d.name)
      exports.push({ name: d.name, kind: d.kind, line: d.line })
    }
  }
  return { lines: lineCount, requires, ...(returns ? { returns } : {}), returnsFunction, exports }
}

function hash(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i + 1)
}

function fileOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

function exportText(e: ExportInfo): string {
  return e.kind === 'method' ? `:${e.name}()` : e.kind === 'function' ? `${e.name}()` : e.name
}

function listWithMore(items: string[], max: number): string {
  if (items.length <= max) return items.join(',')
  return items.slice(0, max).join(',') + `,+${items.length - max}`
}

// Detail levels: 0 full, 1 trimmed lists, 2 no requires, 3 names only.
function entryLine(e: MapEntry, level: number, maxExports: number): string {
  const parts = [fileOf(e.path), CATEGORY_ABBR[e.category] ?? e.category.toLowerCase(), `${e.lines}L`]
  if (e.generated === 'blink') {
    parts.push('generated by Blink from events.blink (do not edit)')
    return parts.join(' ')
  }
  if (level >= 3) return parts.join(' ')
  const reqMax = level === 0 ? 12 : 4
  const expMax = level === 0 ? maxExports : Math.min(4, maxExports)
  if (level < 2 && e.requires.length) parts.push('req=' + listWithMore(e.requires, reqMax))
  if (e.returnsFunction) parts.push('exp=(function)')
  else if (e.exports.length) parts.push('exp=' + listWithMore(e.exports.map(exportText), expMax))
  if (e.lifecycle) {
    const lc = [e.lifecycle.init ? 'Init' : '', e.lifecycle.start ? 'Start' : ''].filter(Boolean).join('+')
    parts.push('lc=' + (lc || 'none'))
  }
  return parts.join(' ')
}

interface DirGroup {
  dir: string
  entries: MapEntry[]
}

function groupByDir(entries: MapEntry[]): DirGroup[] {
  const map = new Map<string, MapEntry[]>()
  for (const e of entries) {
    const d = dirOf(e.path)
    const list = map.get(d) ?? []
    list.push(e)
    map.set(d, list)
  }
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([dir, list]) => ({ dir, entries: list }))
}

function realmLabel(entries: MapEntry[]): string {
  const realms = [...new Set(entries.map((e) => e.realm))].sort()
  return realms.join('/')
}

function collapsedLine(dir: string, entries: MapEntry[]): string {
  const counts = new Map<string, number>()
  let lines = 0
  for (const e of entries) {
    const c = CATEGORY_ABBR[e.category] ?? e.category
    counts.set(c, (counts.get(c) ?? 0) + 1)
    lines += e.lines
  }
  const cats = [...counts.entries()].map(([c, n]) => `${c} ${n}`).join(', ')
  return `${dir || './'} (${realmLabel(entries)}) [collapsed: ${entries.length} scripts, ${lines}L; ${cats}]`
}

// Top-level folder a path collapses into at `depth` segments (e.g. depth 3: src/server/Features/).
function prefixAt(path: string, depth: number): string {
  const segs = path.split('/')
  if (segs.length - 1 <= depth) return dirOf(path)
  return segs.slice(0, depth).join('/') + '/'
}

export class ProjectMap {
  private src: MapSource
  private entriesByPath = new Map<string, MapEntry>()
  private fingerprints = new Map<string, string>()
  private renderCache = new Map<string, RenderResult>()
  private refreshing: Promise<RefreshResult> | null = null
  version = 0

  constructor(src: MapSource) {
    this.src = src
  }

  // Re-reads changed scripts. Concurrent callers share one refresh.
  refresh(): Promise<RefreshResult> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null
      })
    }
    return this.refreshing
  }

  private async doRefresh(): Promise<RefreshResult> {
    const scripts = this.src.scripts().flatMap((g) => g.scripts)
    const seen = new Set<string>()
    const changed: string[] = []
    const queue = scripts.slice()
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        seen.add(s.path)
        if (await this.update(s)) changed.push(s.path)
      }
    }
    await Promise.all(Array.from({ length: Math.min(16, queue.length) }, worker))
    const removed: string[] = []
    for (const path of [...this.entriesByPath.keys()]) {
      if (!seen.has(path)) {
        this.entriesByPath.delete(path)
        this.fingerprints.delete(path)
        removed.push(path)
      }
    }
    if (changed.length || removed.length) {
      this.version++
      this.renderCache.clear()
    }
    changed.sort()
    removed.sort()
    return { changed, removed, version: this.version }
  }

  // Returns true when the entry was added or changed.
  private async update(s: ScriptEntry): Promise<boolean> {
    const prev = this.entriesByPath.get(s.path)
    const meta = `${s.name}|${s.realm}|${s.category}|${s.kind}|${s.feature ?? ''}`
    let statKey: string | null = null
    if (this.src.stat) {
      try {
        const st = await this.src.stat(s.path)
        statKey = `${st.mtimeMs}:${st.size}|${meta}`
        if (prev && this.fingerprints.get(s.path) === statKey) return false
      } catch {
        statKey = null
      }
    }
    let source = ''
    try {
      source = await this.src.readFile(s.path)
    } catch {
      source = ''
    }
    const fp = statKey ?? `${hash(source)}|${meta}`
    if (prev && this.fingerprints.get(s.path) === fp) return false
    this.fingerprints.set(s.path, fp)
    const parsed = parseLuau(source, s.path)
    const entry: MapEntry = {
      path: s.path,
      name: s.name,
      realm: s.realm,
      category: s.category,
      kind: s.kind,
      ...(s.feature ? { feature: s.feature } : {}),
      ...parsed
    }
    if ((s.category === 'Services' || s.category === 'Controllers') && !parsed.generated) {
      const names = new Set(parsed.exports.map((e) => e.name))
      entry.lifecycle = { init: names.has('Init'), start: names.has('Start') }
    }
    this.entriesByPath.set(s.path, entry)
    return true
  }

  entries(): MapEntry[] {
    return [...this.entriesByPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }

  get(path: string): MapEntry | undefined {
    return this.entriesByPath.get(path)
  }

  // Renders the map within opts.maxTokens. Memoized until the next change.
  render(opts: RenderOptions = {}): RenderResult {
    const key = JSON.stringify([opts.maxTokens, opts.path, opts.realm, opts.category, opts.maxExports])
    const hit = this.renderCache.get(key)
    if (hit) return hit
    const result = this.doRender(opts)
    this.renderCache.set(key, result)
    return result
  }

  private doRender(opts: RenderOptions): RenderResult {
    const maxTokens = opts.maxTokens ?? 2500
    const maxExports = opts.maxExports ?? 8
    const prefix = opts.path?.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    const list = this.entries().filter(
      (e) =>
        (!prefix || e.path === prefix || e.path.startsWith(prefix + '/')) &&
        (!opts.realm || e.realm === opts.realm) &&
        (!opts.category ||
          e.category.toLowerCase() === opts.category.toLowerCase() ||
          CATEGORY_ABBR[e.category] === opts.category.toLowerCase())
    )
    if (!list.length) return { text: '(no scripts match)', tokens: 4, scripts: 0, level: 0 }

    const totalLines = list.reduce((n, e) => n + e.lines, 0)
    const header = `${list.length} scripts, ${totalLines} lines${prefix ? ` under ${prefix}/` : ''}. ${LEGEND}`
    const groups = groupByDir(list)

    const build = (level: number, collapsed: Set<string>): string => {
      const out = [header]
      const done = new Set<string>()
      for (const g of groups) {
        const c = [...collapsed].find((p) => g.dir.startsWith(p))
        if (c) {
          if (done.has(c)) continue
          done.add(c)
          out.push(collapsedLine(c, list.filter((e) => e.path.startsWith(c))))
          continue
        }
        out.push(`${g.dir || './'} (${realmLabel(g.entries)})`)
        for (const e of g.entries) out.push('  ' + entryLine(e, level, maxExports))
      }
      return out.join('\n')
    }

    for (let level = 0; level <= 3; level++) {
      const text = build(level, new Set())
      const tokens = estimateTokens(text)
      if (tokens <= maxTokens) return { text, tokens, scripts: list.length, level }
    }

    // Level 4: collapse folders, deepest-and-largest first, then coarser prefixes.
    const collapsed = new Set<string>()
    const maxDepth = Math.max(...list.map((e) => e.path.split('/').length - 1))
    let text = build(3, collapsed)
    for (let depth = maxDepth; depth >= 1; depth--) {
      const candidates = new Map<string, number>()
      for (const e of list) {
        const p = prefixAt(e.path, depth)
        candidates.set(p, (candidates.get(p) ?? 0) + 1)
      }
      const order = [...candidates.entries()].filter(([, n]) => n > 1 || depth === 1).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      for (const [p] of order) {
        if ([...collapsed].some((c) => p.startsWith(c))) continue
        for (const c of [...collapsed]) if (c.startsWith(p)) collapsed.delete(c)
        collapsed.add(p)
        text = build(3, collapsed)
        if (estimateTokens(text) <= maxTokens - 20) {
          text += `\n(trimmed to ~${formatTokens(maxTokens)} tokens; call project_map with path=<folder> for detail)`
          return { text, tokens: estimateTokens(text), scripts: list.length, level: 4 }
        }
      }
    }
    // Still too big (huge project, tiny budget): hard cut.
    const lines = text.split('\n')
    const out: string[] = []
    let used = 0
    for (const l of lines) {
      const t = estimateTokens(l) + 1
      if (used + t > maxTokens - 20) break
      out.push(l)
      used += t
    }
    out.push(`…${lines.length - out.length} more lines; call project_map with path=<folder>`)
    const cut = out.join('\n')
    return { text: cut, tokens: estimateTokens(cut), scripts: list.length, level: 4 }
  }

  // Finds definitions by name: exported members first, then script/module names. Case-insensitive;
  // exact matches before substring matches. Returns "path:line kind name" lines.
  findSymbol(name: string, limit = 20): SymbolHit[] {
    const q = name.trim().replace(/^[.:]/, '').replace(/\(\)$/, '')
    if (!q) return []
    const lower = q.toLowerCase()
    const exact: SymbolHit[] = []
    const partial: SymbolHit[] = []
    for (const e of this.entries()) {
      const table = e.returns ?? e.name
      if (e.name.toLowerCase() === lower) exact.push({ path: e.path, line: 1, kind: 'module', name: e.name })
      else if (e.name.toLowerCase().includes(lower)) partial.push({ path: e.path, line: 1, kind: 'module', name: e.name })
      for (const x of e.exports) {
        const sep = x.kind === 'method' ? ':' : '.'
        const hit: SymbolHit = { path: e.path, line: x.line, kind: x.kind, name: `${table}${sep}${x.name}` }
        if (x.name.toLowerCase() === lower || hit.name.toLowerCase() === lower) exact.push(hit)
        else if (x.name.toLowerCase().includes(lower)) partial.push(hit)
      }
    }
    return [...exact, ...partial].slice(0, limit)
  }
}

export interface SymbolHit {
  path: string
  line: number
  kind: ExportKind | 'module'
  name: string
}

export function formatSymbolHits(hits: SymbolHit[]): string {
  if (!hits.length) return '(no matches)'
  return hits.map((h) => `${h.path}:${h.line} ${h.kind} ${h.name}`).join('\n')
}
