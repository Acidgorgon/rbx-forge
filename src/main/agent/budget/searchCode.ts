// Token-cheap code search for agents: grep-style `path:line: text` output with optional context,
// capped by result count and output tokens, skipping vendored and generated files by default.
//
// Cheaper than the SDK's built-in Grep for this project because it knows the GenTree layout:
// Packages/ (Wally), node_modules, .git, .studio-sync and the Blink outputs are skipped unless
// asked for, lines are clipped, and it stops reading files as soon as the limit is reached.

import { formatSymbolHits, type ProjectMap, type SymbolHit } from './projectMap.ts'
import { estimateTokens } from './tokens.ts'

// What search needs; HarnessContext satisfies it (listFiles is recursive and repo-relative).
export interface SearchFs {
  listFiles(dir: string): Promise<string[]>
  readFile(path: string): Promise<string>
}

export type Realm = 'shared' | 'server' | 'client'

export interface SearchOptions {
  query: string
  // Treat query as a JavaScript regular expression (without slashes).
  regex?: boolean
  caseSensitive?: boolean
  // Repo-relative folder or file to search in. Default: whole repo.
  path?: string
  realm?: Realm
  // Default 30.
  maxResults?: number
  // Lines of context before and after each match. Default 1, max 5.
  context?: number
  // Search Packages/, node_modules, generated Blink outputs too.
  includeIgnored?: boolean
  // File extensions to search. Default .luau .lua .blink.
  extensions?: string[]
  // Cap on the rendered output. Default 3000.
  maxTokens?: number
  // Realm lookup by path (e.g. from ctx.scripts()); falls back to the src/<realm> convention.
  realmOf?: (path: string) => Realm | undefined
}

export interface SearchResult {
  text: string
  matches: number
  filesScanned: number
  // True when stopped early (maxResults or maxTokens reached).
  truncated: boolean
}

export const DEFAULT_EXTENSIONS = ['.luau', '.lua', '.blink']
const IGNORED_SEGMENTS = new Set(['Packages', 'ServerPackages', 'DevPackages', 'node_modules', '.git', '.studio-sync', 'out', 'dist'])
const MAX_LINE_CHARS = 200
const BLINK_DEFAULT_OUTPUTS = ['src/shared/events/client.luau', 'src/shared/events/server.luau', 'src/server/events/server.luau']

// Realm from the GenTree folder convention.
export function realmFromPath(path: string): Realm | undefined {
  if (path.startsWith('src/shared/')) return 'shared'
  if (path.startsWith('src/server/') || path.startsWith('src/ServerStorage/')) return 'server'
  if (path.startsWith('src/client/')) return 'client'
  return undefined
}

// Output paths declared in events.blink (`option ClientOutput = "..."`), or the template defaults.
export async function blinkOutputs(fs: SearchFs): Promise<Set<string>> {
  const out = new Set<string>()
  try {
    const text = await fs.readFile('events.blink')
    for (const m of text.matchAll(/option\s+(?:Client|Server|Types)Output\s*=\s*["']([^"']+)["']/g)) {
      out.add(m[1].replace(/\\/g, '/').replace(/^\.\//, ''))
    }
  } catch {
    // no events.blink
  }
  if (!out.size) for (const p of BLINK_DEFAULT_OUTPUTS) out.add(p)
  return out
}

function clipLine(line: string): string {
  const t = line.replace(/\t/g, '  ').trimEnd()
  return t.length > MAX_LINE_CHARS ? t.slice(0, MAX_LINE_CHARS - 1) + '…' : t
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function buildMatcher(opts: Pick<SearchOptions, 'query' | 'regex' | 'caseSensitive'>): RegExp {
  if (!opts.query) throw new Error('query is empty')
  const flags = opts.caseSensitive ? '' : 'i'
  if (!opts.regex) return new RegExp(escapeRegex(opts.query), flags)
  try {
    return new RegExp(opts.query, flags)
  } catch (e) {
    throw new Error(`invalid regex: ${(e as Error).message}`)
  }
}

function normalizeDir(path: string | undefined): string {
  if (!path) return ''
  const p = path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (p.startsWith('/') || p.split('/').includes('..')) throw new Error(`path must be repo-relative: ${path}`)
  return p === '.' ? '' : p
}

export async function searchCode(fs: SearchFs, opts: SearchOptions): Promise<SearchResult> {
  const re = buildMatcher(opts)
  // Whole-file pre-check; multiline so ^/$ anchors behave as they do per line.
  const reFile = new RegExp(re.source, re.flags + 'm')
  const maxResults = Math.max(1, Math.min(opts.maxResults ?? 30, 500))
  const context = Math.max(0, Math.min(opts.context ?? 1, 5))
  const maxTokens = opts.maxTokens ?? 3000
  const exts = (opts.extensions?.length ? opts.extensions : DEFAULT_EXTENSIONS).map((e) => (e.startsWith('.') ? e : '.' + e).toLowerCase())
  const dir = normalizeDir(opts.path)
  const realmOf = opts.realmOf ?? realmFromPath
  const generated = opts.includeIgnored ? new Set<string>() : await blinkOutputs(fs)

  let files: string[]
  const lower = dir.toLowerCase()
  if (dir && exts.some((e) => lower.endsWith(e))) files = [dir]
  else files = await fs.listFiles(dir)
  files = files
    .filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)))
    .filter((f) => opts.includeIgnored || (!f.split('/').some((s) => IGNORED_SEGMENTS.has(s)) && !generated.has(f)))
    .filter((f) => !opts.realm || realmOf(f) === opts.realm)
    .sort()

  const out: string[] = []
  let tokens = 0
  let matches = 0
  let scanned = 0
  let truncated = false

  outer: for (const file of files) {
    let text: string
    try {
      text = await fs.readFile(file)
    } catch {
      continue
    }
    scanned++
    // Generated-file sniff for outputs not declared in events.blink.
    if (!opts.includeIgnored && /File generated by Blink/.test(text.slice(0, 600))) continue
    if (!reFile.test(text)) continue
    const lines = text.split(/\r?\n/)
    let lastPrinted = -1
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue
      if (matches >= maxResults) {
        truncated = true
        break outer
      }
      matches++
      const from = Math.max(0, i - context, lastPrinted + 1)
      const to = Math.min(lines.length - 1, i + context)
      const chunk: string[] = []
      // Separator between non-adjacent hunks (grep style), only when printing context.
      if (context > 0 && out.length && (lastPrinted < 0 || from > lastPrinted + 1)) chunk.push('--')
      for (let j = from; j <= to; j++) {
        // Context lines that are matches themselves are printed when their turn comes.
        if (j > i && re.test(lines[j])) break
        chunk.push(`${file}${j === i ? ':' : '-'}${j + 1}${j === i ? ':' : '-'} ${clipLine(lines[j])}`)
        lastPrinted = j
      }
      const cost = estimateTokens(chunk.join('\n')) + chunk.length
      if (tokens + cost > maxTokens) {
        truncated = true
        break outer
      }
      tokens += cost
      out.push(...chunk)
    }
  }

  let textOut = out.length ? out.join('\n') : '(no matches)'
  if (truncated) textOut += `\n…stopped at ${matches} matches; narrow with path/realm or a more specific query`
  return { text: textOut, matches, filesScanned: scanned, truncated }
}

// Symbol lookup through the project map, falling back to a definition-shaped search
// (`function X.name`, `function X:name`, `local function name`, `X.name =`) when the map has none.
export async function findSymbol(
  map: ProjectMap,
  fs: SearchFs,
  name: string,
  opts: { limit?: number } = {}
): Promise<{ text: string; hits: SymbolHit[]; fromSearch: boolean }> {
  const hits = map.findSymbol(name, opts.limit ?? 20)
  if (hits.length) return { text: formatSymbolHits(hits), hits, fromSearch: false }
  const id = escapeRegex(name.trim().replace(/^[.:]/, '').replace(/\(\)$/, ''))
  if (!id) return { text: '(no matches)', hits: [], fromSearch: false }
  const res = await searchCode(fs, {
    query: `(function\\s+[\\w.:]*[.:]${id}\\b|local\\s+function\\s+${id}\\b|^\\s*[\\w.]+\\.${id}\\s*=|^local\\s+${id}\\s*=)`,
    regex: true,
    context: 0,
    maxResults: opts.limit ?? 20
  })
  return { text: res.text, hits: [], fromSearch: true }
}
