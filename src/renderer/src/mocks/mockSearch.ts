// Browser-preview mock for the Search view: find / replace over the mock files with the same matcher
// the app uses (shared/search/matcher.ts), streamed in small chunks so the progress and cancelling can
// be seen. Globs are a small stand-in for Rojo's (main/services/sync/mapping.ts needs node:fs):
// `*` and `**` cross folders, a name without a slash matches at any depth, braces work.
import type { HarnessEvents, ReplaceRequest, ReplaceResult, SearchApi, SearchFileResult, SearchMatch, SearchOptions, SearchSummary } from '@shared/types'
import { buildMatcher, matchLine, previewLine, replaceInText } from '@shared/search/matcher'
import { MAX_SEARCH_FILE_BYTES, MAX_SEARCH_MATCHES } from '@shared/search/limits'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

export interface SearchMockDeps {
  files: Record<string, string>
  writeFile: (path: string, contents: string) => Promise<void>
  // The tabs of these files reload (the watcher's files:changed in the app).
  changed: (paths: string[]) => void
}

const SKIP = /(^|\/)(\.git|node_modules|Packages|ServerPackages|\.forge|\.studio-sync|out|dist|build)\//
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function globs(text: string): RegExp[] {
  const out: RegExp[] = []
  for (const raw of text.split(/,(?![^{]*\})/).map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)) {
    const p = raw.includes('/') ? raw.replace(/^\/+/, '') : `**/${raw}`
    const body = p
      .replace(/[.+^$()|\\]/g, '\\$&')
      .replace(/\{([^}]*)\}/g, (_, alts: string) => `(?:${alts.split(',').join('|')})`)
      .replace(/\*\*\/|\*\*|\*|\?/g, (m) => (m === '**/' ? '(?:.*/)?' : m === '?' ? '.' : '.*'))
    out.push(new RegExp(`^${body}(?:/.*)?$`))
  }
  return out
}

export function searchMock(emit: Emit, deps: SearchMockDeps): SearchApi {
  const cancelled = new Set<string>()
  return {
    async searchFiles(id: string, options: SearchOptions): Promise<SearchSummary> {
      const summary: SearchSummary = { id, files: 0, matches: 0, limitHit: false, cancelled: false, skippedLarge: 0, skippedBinary: 0 }
      cancelled.delete(id)
      const built = buildMatcher(options)
      if ('error' in built) return { ...summary, error: `Invalid regular expression: ${built.error}` }
      if ('empty' in built) return summary
      const include = globs(options.include)
      const exclude = globs(options.exclude)
      const paths = Object.keys(deps.files).filter((p) => !SKIP.test(p) && !exclude.some((re) => re.test(p)) && (!include.length || include.some((re) => re.test(p)))).sort()
      let chunk: SearchFileResult[] = []
      for (const path of paths) {
        await delay(8)
        if (cancelled.has(id)) {
          cancelled.delete(id)
          return { ...summary, cancelled: true }
        }
        const text = deps.files[path]
        if (text.length > MAX_SEARCH_FILE_BYTES) {
          summary.skippedLarge++
          continue
        }
        const matches: SearchMatch[] = []
        text.split(/\r?\n/).forEach((line, i) => {
          for (const hit of matchLine(built.matcher, line, MAX_SEARCH_MATCHES - summary.matches - matches.length)) {
            matches.push({ line: i + 1, col: hit.index + 1, endCol: hit.index + hit.length + 1, ...previewLine(line, hit.index, hit.length), ...(hit.groups ? { groups: hit.groups } : {}), ...(hit.named ? { named: hit.named } : {}) })
          }
        })
        if (!matches.length) continue
        summary.files++
        summary.matches += matches.length
        chunk.push({ path, matches })
        if (chunk.length >= 3) {
          emit('search:files', { id, files: chunk })
          chunk = []
        }
        if (summary.matches >= MAX_SEARCH_MATCHES) {
          summary.limitHit = true
          break
        }
      }
      if (chunk.length) emit('search:files', { id, files: chunk })
      return summary
    },
    async searchCancel(id: string) {
      cancelled.add(id)
    },
    async replaceInFiles(request: ReplaceRequest): Promise<ReplaceResult> {
      const result: ReplaceResult = { files: [], replaced: 0, skipped: [], stale: 0 }
      const built = buildMatcher(request.options)
      if ('error' in built) return { ...result, error: `Invalid regular expression: ${built.error}` }
      if ('empty' in built) return { ...result, error: 'Type what to search for first.' }
      await delay(60)
      const dirty = new Set(request.dirty)
      for (const target of request.targets) {
        const text = deps.files[target.path]
        if (text === undefined) {
          result.skipped.push({ path: target.path, reason: 'no longer exists' })
          continue
        }
        if (dirty.has(target.path)) {
          result.skipped.push({ path: target.path, reason: 'unsaved changes in the editor' })
          continue
        }
        const only = target.only ? new Set(target.only.map((m) => `${m.line}:${m.col}`)) : undefined
        const out = replaceInText(text, built.matcher, request.replacement, request.preserveCase, only)
        result.stale += out.stale
        if (!out.count) {
          result.skipped.push({ path: target.path, reason: 'the matches are gone (the file changed since the search)' })
          continue
        }
        result.backup ??= '.forge/sync/trash/2026-01-01T00-00-00-000Z'
        await deps.writeFile(target.path, out.text)
        result.files.push({ path: target.path, count: out.count })
        result.replaced += out.count
      }
      if (result.files.length) deps.changed(result.files.map((f) => f.path))
      return result
    }
  }
}
