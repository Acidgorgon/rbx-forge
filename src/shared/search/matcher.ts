// Find / replace on text, line by line (a regex never matches across a line break). Pure: used by the
// search service in main and by the Search view's replacement preview. Matches follow VS Code: empty
// matches are skipped, Whole Word needs a non-word character (or the text's edge) on both sides, and
// Preserve Case follows the matched text (ALL CAPS, lower case, Capitalized, snake_case / kebab-case).
import type { SearchQuery } from '../searchTypes.ts'

export interface Matcher {
  regex: RegExp
  isRegex: boolean
}

export type MatcherResult = { matcher: Matcher } | { error: string } | { empty: true }

const WORD = /\w/

// A query that does not compile comes back as { error }, an empty query as { empty }.
export function buildMatcher(q: SearchQuery): MatcherResult {
  if (!q.query) return { empty: true }
  let source = q.regex ? q.query : q.query.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
  if (q.wholeWord) {
    // A literal needs the boundary only on the side that starts / ends with a word character.
    const left = q.regex || WORD.test(q.query[0])
    const right = q.regex || WORD.test(q.query[q.query.length - 1])
    source = `${left ? '(?<!\\w)' : ''}(?:${source})${right ? '(?!\\w)' : ''}`
  }
  const flags = q.caseSensitive ? 'g' : 'gi'
  // Unicode mode first (\p{L}, \u{…}); a pattern only valid without it (a stray \- or ]) still works.
  try {
    return { matcher: { regex: new RegExp(source, flags + 'u'), isRegex: q.regex } }
  } catch {
    try {
      return { matcher: { regex: new RegExp(source, flags), isRegex: q.regex } }
    } catch (e) {
      return { error: (e instanceof Error ? e.message : String(e)).replace(/^Invalid regular expression: /, '').replace(/^\/.*\/[a-z]*: /, '') }
    }
  }
}

export interface LineHit {
  index: number
  length: number
  groups?: (string | undefined)[]
  named?: Record<string, string | undefined>
}

// Every non-empty match in one line (without its line break), up to `max`.
export function matchLine(m: Matcher, line: string, max = Infinity): LineHit[] {
  const out: LineHit[] = []
  const re = m.regex
  re.lastIndex = 0
  for (let hit = re.exec(line); hit && out.length < max; hit = re.exec(line)) {
    if (!hit[0]) {
      re.lastIndex++
      continue
    }
    const one: LineHit = { index: hit.index, length: hit[0].length }
    if (m.isRegex && hit.length > 1) one.groups = hit.slice(1)
    if (m.isRegex && hit.groups) one.named = { ...hit.groups }
    out.push(one)
  }
  re.lastIndex = 0
  return out
}

const LEAD = 40
const TAIL = 160

// The line cut down to the part around the match, for a result row: leading space dropped, "…" where
// text was cut off, and the match's span (from, to) in the shortened text.
export function previewLine(line: string, index: number, length: number): { text: string; from: number; to: number } {
  const indent = Math.min(line.length - line.trimStart().length, index)
  const start = Math.max(indent, index - LEAD)
  const end = Math.min(line.length, index + length + TAIL)
  const pre = start > indent ? '…' : ''
  const post = end < line.length ? '…' : ''
  const from = pre.length + index - start
  return { text: pre + line.slice(start, end).trimEnd() + post, from, to: from + Math.min(length, end - index) }
}

// Splits text into lines and the line breaks after them (the last line has an empty break).
export function splitLines(text: string): { lines: string[]; breaks: string[] } {
  const parts = text.split(/(\r\n|\n|\r)/)
  const lines: string[] = []
  const breaks: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    lines.push(parts[i])
    breaks.push(parts[i + 1] ?? '')
  }
  return { lines, breaks }
}

const isUpper = (s: string) => s.toUpperCase() === s && s.toLowerCase() !== s
const isLower = (s: string) => s.toLowerCase() === s && s.toUpperCase() !== s

// Preserve Case: the replacement takes the letter case of the text it replaces.
export function preserveCase(matched: string, replacement: string): string {
  if (!replacement || !matched) return replacement
  if (isUpper(matched)) return replacement.toUpperCase()
  if (isLower(matched)) return replacement.toLowerCase()
  for (const sep of ['_', '-']) {
    if (matched.includes(sep) && replacement.includes(sep)) {
      const from = matched.split(sep)
      const to = replacement.split(sep)
      if (from.length === to.length) return to.map((part, i) => preserveCase(from[i], part)).join(sep)
    }
  }
  const first = matched[0]
  if (isUpper(first)) return replacement[0].toUpperCase() + replacement.slice(1)
  if (isLower(first)) return replacement[0].toLowerCase() + replacement.slice(1)
  return replacement
}

// The text a match is replaced with. A regular expression expands $1 … $99, $<name>, $& (and $0, the
// whole match), $$, and \n \t \\ ; a plain-text search inserts the replacement as typed.
export function replacementFor(m: Matcher, replacement: string, matched: string, hit: Pick<LineHit, 'groups' | 'named'>, keepCase = false): string {
  let out = replacement
  if (m.isRegex) {
    const groups = hit.groups ?? []
    out = ''
    for (let i = 0; i < replacement.length; i++) {
      const c = replacement[i]
      const next = replacement[i + 1]
      if (c === '\\' && next !== undefined) {
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next
        i++
      } else if (c === '$' && next === '$') {
        out += '$'
        i++
      } else if (c === '$' && (next === '&' || next === '0')) {
        out += matched
        i++
      } else if (c === '$' && next === '<') {
        const close = replacement.indexOf('>', i + 2)
        const name = close > 0 ? replacement.slice(i + 2, close) : ''
        if (close > 0 && hit.named && name in hit.named) {
          out += hit.named[name] ?? ''
          i = close
        } else out += c
      } else if (c === '$' && next !== undefined && next >= '0' && next <= '9') {
        // Two digits when that group exists, else one (JS: "$10" with 3 groups is $1 then "0").
        const d2 = replacement[i + 2]
        const two = d2 !== undefined && d2 >= '0' && d2 <= '9' ? Number(next + d2) : 0
        const len = two >= 1 && two <= groups.length ? 2 : 1
        const n = len === 2 ? two : Number(next)
        if (n >= 1 && n <= groups.length) {
          out += groups[n - 1] ?? ''
          i += len
        } else out += c
      } else out += c
    }
  }
  return keepCase ? preserveCase(matched, out) : out
}

export interface ReplaceOutcome {
  text: string
  // Matches replaced.
  count: number
  // Of `only`: the ones that were not found where they were expected.
  stale: number
}

// Replaces the matches in `text`: all of them, or only those whose "line:col" is in `only` (1-based, as
// the search reported them). A leading BOM is kept and not counted in the columns.
export function replaceInText(text: string, m: Matcher, replacement: string, keepCase = false, only?: ReadonlySet<string>): ReplaceOutcome {
  const bom = text.charCodeAt(0) === 0xfeff ? '﻿' : ''
  const { lines, breaks } = splitLines(bom ? text.slice(1) : text)
  let count = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let out = ''
    let at = 0
    for (const hit of matchLine(m, line)) {
      if (only && !only.has(`${i + 1}:${hit.index + 1}`)) continue
      const matched = line.slice(hit.index, hit.index + hit.length)
      out += line.slice(at, hit.index) + replacementFor(m, replacement, matched, hit, keepCase)
      at = hit.index + hit.length
      count++
    }
    if (at) lines[i] = out + line.slice(at)
  }
  return { text: bom + lines.map((l, i) => l + breaks[i]).join(''), count, stale: only ? Math.max(0, only.size - count) : 0 }
}
