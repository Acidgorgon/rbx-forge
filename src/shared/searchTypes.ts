// Find in files / replace in files (Search view, palette "Search: Find in Files"): the options, the
// results main streams back in chunks, and the replace request. Engine: shared/search/matcher.ts
// (pure) and main/services/search.ts (walks the project folder).

export interface SearchQuery {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

export interface SearchOptions extends SearchQuery {
  // Comma separated globs (Rojo's glob semantics, see sync/mapping.ts rojoGlob), repo-relative.
  // "*.luau" matches at any depth; "src/server" matches everything below it.
  include: string
  exclude: string
  // The root .gitignore applies (VS Code's "Use Exclude Settings and Ignore Files").
  useIgnore: boolean
}

export interface SearchMatch {
  // 1-based, as Monaco counts them: col = first character, endCol = just past the last one.
  line: number
  col: number
  endCol: number
  // The line shortened around the match (leading space dropped, "…" at a cut) and the match's span in it.
  text: string
  from: number
  to: number
  // Capture groups of a regex match (for the replacement preview).
  groups?: (string | undefined)[]
  named?: Record<string, string | undefined>
}

export interface SearchFileResult {
  // Repo-relative, forward slashes.
  path: string
  matches: SearchMatch[]
}

export interface SearchSummary {
  id: string
  files: number
  matches: number
  // Stopped at the match cap: refine the search.
  limitHit: boolean
  cancelled: boolean
  // A query that does not compile (regex), shown under the box.
  error?: string
  // Files left out: over the size cap, or binary.
  skippedLarge: number
  skippedBinary: number
}

export interface ReplaceTarget {
  path: string
  // Only these matches (their line and col); every match in the file when left out.
  only?: { line: number; col: number }[]
}

export interface ReplaceRequest {
  options: SearchQuery
  replacement: string
  preserveCase: boolean
  targets: ReplaceTarget[]
  // Files with unsaved edits in the editor: never written.
  dirty: string[]
}

export interface ReplaceResult {
  files: { path: string; count: number }[]
  replaced: number
  skipped: { path: string; reason: string }[]
  // Matches that were no longer where the search saw them (the file changed since).
  stale: number
  // Repo-relative folder holding the copies of the changed files.
  backup?: string
  error?: string
}

export interface SearchApi {
  // Resolves when the search ended (done, cancelled or failed); results arrive as search:files events
  // carrying the same id. A new search with the same id replaces the running one.
  searchFiles(id: string, options: SearchOptions): Promise<SearchSummary>
  searchCancel(id: string): Promise<void>
  replaceInFiles(request: ReplaceRequest): Promise<ReplaceResult>
}

export interface SearchEvents {
  'search:files': { id: string; files: SearchFileResult[] }
}
