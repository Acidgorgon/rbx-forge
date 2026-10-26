// Search (Ctrl+Shift+F): find across the project's text files, VS Code style. A search box with Match
// Case / Whole Word / Regular Expression, a replace box (Preserve Case, Replace All), "files to include /
// exclude" under the ellipsis, then the results grouped by file with a line preview: click a match to
// open it selected in the editor. Replace is per match, per file or All; files with unsaved editor edits
// are never written. State and flows: searchState.ts (shared with the palette's "Search: …" commands);
// the walk and the writes happen in main (services/search.ts).
import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import type { SearchFileResult, SearchMatch } from '@shared/types'
import { buildMatcher, replacementFor, type Matcher } from '@shared/search/matcher'
import { MAX_SEARCH_MATCHES } from '@shared/search/limits'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { FileGlyph } from '../components/ClassIcon'
import { keyHint } from '../lib/format'
import { basename, dirname } from '../lib/roblox'
import { allCollapsed, clearSearch, count, collapseAll, dismiss, replace, runSearch, setOption, setQuery, setReplacement, setView, startSearch, toggleCollapsed, useSearch, type ReplaceScope } from './searchState'

let focusedNonce = 0

interface Preview {
  matcher: Matcher
  replacement: string
  keepCase: boolean
}

function Toggle({ on, label, onClick, children }: { on: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={`srch-tog${on ? ' on' : ''}`} aria-pressed={on} aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  )
}

// One result line: the text around the match, the match highlighted; with a replacement typed, the
// match struck through and the text it becomes after it.
function MatchText({ m, preview }: { m: SearchMatch; preview: Preview | null }) {
  const found = m.text.slice(m.from, m.to)
  let becomes: string | null = null
  if (preview) becomes = replacementFor(preview.matcher, preview.replacement, found, m, preview.keepCase)
  return (
    <span className="srch-text">
      {m.text.slice(0, m.from)}
      {becomes === null ? <mark>{found}</mark> : <><del>{found}</del><ins>{becomes}</ins></>}
      {m.text.slice(m.to)}
    </span>
  )
}

interface GroupProps {
  file: SearchFileResult
  collapsed: boolean
  dirty: boolean
  replaceOpen: boolean
  canReplace: boolean
  preview: Preview | null
  open: (path: string, m: SearchMatch) => void
  onReplace: (scope: ReplaceScope) => void
}

const FileGroup = memo(function FileGroup({ file, collapsed, dirty, replaceOpen, canReplace, preview, open, onReplace }: GroupProps) {
  const key = (e: React.KeyboardEvent, run: () => void) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    run()
  }
  const unsaved = dirty ? 'Unsaved changes in the editor: Search replaces what is on disk, so this file is skipped' : undefined
  return (
    <div className="srch-group" data-path={file.path}>
      <div className="lrow srch-file" role="button" tabIndex={0} aria-expanded={!collapsed} title={file.path} onClick={() => toggleCollapsed(file.path)} onKeyDown={(e) => key(e, () => toggleCollapsed(file.path))}>
        <Icon name={collapsed ? 'chev' : 'chevDown'} size={12} />
        <FileGlyph path={file.path} size={14} />
        <span className="srch-name ellipsis">{basename(file.path)}</span>
        <span className="sub ellipsis grow">{dirname(file.path)}</span>
        {dirty && <span className="tag warn" title={unsaved}>unsaved</span>}
        <span className="srch-acts" onClick={(e) => e.stopPropagation()}>
          {replaceOpen && (
            <button className="row-act" title={dirty ? unsaved : 'Replace all in this file'} aria-label={`Replace all in ${file.path}`} disabled={!canReplace || dirty} onClick={() => onReplace({ kind: 'file', path: file.path })}>
              <Icon name="replaceAll" size={13} />
            </button>
          )}
          <button className="row-act" title="Dismiss" aria-label={`Dismiss ${file.path}`} onClick={() => dismiss(file.path)}>
            <Icon name="x" size={13} />
          </button>
        </span>
        <span className="count">{file.matches.length}</span>
      </div>
      {!collapsed &&
        file.matches.map((m) => (
          <div key={`${m.line}:${m.col}`} className="lrow srch-match" role="button" tabIndex={0} title={`${file.path}:${m.line}:${m.col}`} onClick={() => open(file.path, m)} onKeyDown={(e) => key(e, () => open(file.path, m))}>
            <span className="srch-ln mono">{m.line}</span>
            <MatchText m={m} preview={preview} />
            <span className="srch-acts" onClick={(e) => e.stopPropagation()}>
              {replaceOpen && (
                <button className="row-act" title={dirty ? unsaved : 'Replace'} aria-label={`Replace line ${m.line} in ${file.path}`} disabled={!canReplace || dirty} onClick={() => onReplace({ kind: 'match', path: file.path, match: m })}>
                  <Icon name="replace" size={13} />
                </button>
              )}
              <button className="row-act" title="Dismiss" aria-label={`Dismiss line ${m.line} in ${file.path}`} onClick={() => dismiss(file.path, m)}>
                <Icon name="x" size={13} />
              </button>
            </span>
          </div>
        ))}
    </div>
  )
})

export function SearchView() {
  const { state, actions } = useStore()
  const s = useSearch()
  const findRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    startSearch()
    findRef.current?.focus()
    findRef.current?.select()
  }, [])
  // A focus request (Ctrl+Shift+F, the palette's "Search: …") is handled once, also when it mounted this view.
  useEffect(() => {
    if (!s.focusNonce || s.focusNonce === focusedNonce) return
    focusedNonce = s.focusNonce
    const box = s.focusReplace ? replaceRef.current : findRef.current
    box?.focus()
    box?.select()
  })

  const dirty = useMemo(() => new Set(state.files.filter((f) => f.current !== f.saved).map((f) => f.path)), [state.files])
  const matcher = useMemo(() => {
    if (!s.ran) return null
    const built = buildMatcher(s.ran)
    return 'matcher' in built ? built.matcher : null
  }, [s.ran])
  const preview = useMemo<Preview | null>(() => (s.replaceOpen && s.replacement && matcher ? { matcher, replacement: s.replacement, keepCase: s.preserveCase } : null), [s.replaceOpen, s.replacement, s.preserveCase, matcher])

  const sum = s.summary
  const total = s.files.reduce((n, f) => n + f.matches.length, 0)
  const canReplace = !!sum && !s.running && !s.replacing && !sum.error
  const canReplaceAll = canReplace && total > 0 && !sum.limitHit

  // Stable callbacks, so a streamed chunk of results re-renders only the files that changed.
  const latest = useRef({ actions, dirty })
  latest.current = { actions, dirty }
  const open = useCallback((path: string, m: SearchMatch) => void latest.current.actions.openFileAt(path, m.line, m.col, { line: m.line, column: m.endCol }), [])
  const onReplace = useCallback((scope: ReplaceScope) => replace(latest.current.actions, scope, [...latest.current.dirty]), [])

  // Alt+C / Alt+W / Alt+R in the boxes, like VS Code; Alt+P for Preserve Case in the replace box.
  const toggleKeys = (e: React.KeyboardEvent) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return
    if (e.code === 'KeyC') setOption({ caseSensitive: !s.caseSensitive })
    else if (e.code === 'KeyW') setOption({ wholeWord: !s.wholeWord })
    else if (e.code === 'KeyR') setOption({ regex: !s.regex })
    else if (e.code === 'KeyP') setView({ preserveCase: !s.preserveCase })
    else return
    e.preventDefault()
  }

  const status = (() => {
    if (!state.project) return <div className="note srch-line">Open a project to search it.</div>
    if (sum?.error) return <div className="err-text srch-line" role="alert">{sum.error}</div>
    if (s.error) return <div className="err-text srch-line" role="alert">{s.error}</div>
    if (!s.query) return <div className="note srch-line">Type to search the text files of the project.</div>
    if (s.running && !s.files.length) return <div className="note srch-line"><span className="spinner" /> Searching…</div>
    if (!sum) return null
    if (sum.cancelled) return null
    if (!total) return <div className="note srch-line">No results found{s.include || s.exclude ? '. Check the files to include / exclude' : ''}.</div>
    return null
  })()

  return (
    <>
      <div className="panel-head">
        <span className="panel-title">Search</span>
        <button className="icon-btn" title="Refresh" aria-label="Refresh" disabled={!s.query || s.running} onClick={() => void runSearch()}>
          <Icon name="sync" size={14} className={s.running ? 'spin' : undefined} />
        </button>
        <button className="icon-btn" title="Clear Search Results" aria-label="Clear Search Results" disabled={!s.query && !s.files.length} onClick={clearSearch}>
          <Icon name="clearAll" size={14} />
        </button>
        <button className="icon-btn" title={allCollapsed(s) ? 'Expand All' : 'Collapse All'} aria-label={allCollapsed(s) ? 'Expand All' : 'Collapse All'} disabled={!s.files.length} onClick={() => collapseAll(!allCollapsed(s))}>
          <Icon name={allCollapsed(s) ? 'chevDown' : 'collapse'} size={14} />
        </button>
      </div>
      <div className="srch-top">
        <button className="srch-expand" title="Toggle Replace" aria-label="Toggle Replace" aria-expanded={s.replaceOpen} onClick={() => setView({ replaceOpen: !s.replaceOpen })}>
          <Icon name={s.replaceOpen ? 'chevDown' : 'chev'} size={12} />
        </button>
        <div className="srch-inputs">
          <label className="filter srch-box">
            <input
              ref={findRef}
              value={s.query}
              placeholder="Search"
              aria-label="Search"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                toggleKeys(e)
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void runSearch()
                else if (e.key === 'Escape' && s.query) setQuery('')
              }}
            />
            <Toggle on={s.caseSensitive} label={`Match Case (${keyHint('alt+c')})`} onClick={() => setOption({ caseSensitive: !s.caseSensitive })}>Aa</Toggle>
            <Toggle on={s.wholeWord} label={`Match Whole Word (${keyHint('alt+w')})`} onClick={() => setOption({ wholeWord: !s.wholeWord })}><span className="srch-ab">ab</span></Toggle>
            <Toggle on={s.regex} label={`Use Regular Expression (${keyHint('alt+r')})`} onClick={() => setOption({ regex: !s.regex })}>.*</Toggle>
          </label>
          {s.replaceOpen && (
            <div className="row srch-replace">
              <label className="filter srch-box grow">
                <input ref={replaceRef} value={s.replacement} placeholder="Replace" aria-label="Replace" spellCheck={false} onChange={(e) => setReplacement(e.target.value)} onKeyDown={toggleKeys} />
                <Toggle on={s.preserveCase} label={`Preserve Case (${keyHint('alt+p')})`} onClick={() => setView({ preserveCase: !s.preserveCase })}>AB</Toggle>
              </label>
              <button
                className="icon-btn"
                title={sum?.limitHit ? `Refine the search first: only the first ${MAX_SEARCH_MATCHES} results are listed` : `Replace All${total ? ` (${count(total, 'match')})` : ''}`}
                aria-label="Replace All"
                disabled={!canReplaceAll}
                onClick={() => onReplace({ kind: 'all' })}
              >
                {s.replacing ? <span className="spinner" /> : <Icon name="replaceAll" size={14} />}
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="srch-more">
        <button className={`icon-btn${s.details ? ' on' : ''}`} title="Toggle Search Details" aria-label="Toggle Search Details" aria-pressed={s.details} onClick={() => setView({ details: !s.details })}>
          <Icon name="more" size={14} />
        </button>
      </div>
      {s.details && (
        <div className="srch-details">
          <label className="srch-cap" htmlFor="srch-include">files to include</label>
          <label className="filter srch-box">
            <input id="srch-include" value={s.include} placeholder="e.g. *.luau, src/server" spellCheck={false} onChange={(e) => setOption({ include: e.target.value })} />
          </label>
          <label className="srch-cap" htmlFor="srch-exclude">files to exclude</label>
          <label className="filter srch-box">
            <input id="srch-exclude" value={s.exclude} placeholder="e.g. *.spec.luau, Tests" spellCheck={false} onChange={(e) => setOption({ exclude: e.target.value })} />
            <Toggle on={s.useIgnore} label="Use Exclude Settings and Ignore Files (.gitignore)" onClick={() => setOption({ useIgnore: !s.useIgnore })}>
              <Icon name="filter" size={13} />
            </Toggle>
          </label>
        </div>
      )}
      {sum && total > 0 && (
        <div className="note srch-line srch-sum" aria-live="polite">
          {count(total, 'result')} in {count(s.files.length, 'file')}
          {s.running && ' …'}
        </div>
      )}
      {status}
      {sum?.limitHit && (
        <div className="note warn srch-line">
          Only the first {MAX_SEARCH_MATCHES} results are shown. Refine your search: a longer text, Whole Word, or files to include / exclude.
        </div>
      )}
      {sum && sum.skippedLarge > 0 && <div className="note srch-line">{count(sum.skippedLarge, 'file')} over 1 MB not searched.</div>}
      <div className="panel-body srch-results" aria-busy={s.running}>
        {s.files.map((f) => (
          <FileGroup key={f.path} file={f} collapsed={s.collapsed.has(f.path)} dirty={dirty.has(f.path)} replaceOpen={s.replaceOpen} canReplace={canReplace} preview={preview} open={open} onReplace={onReplace} />
        ))}
      </div>
    </>
  )
}
