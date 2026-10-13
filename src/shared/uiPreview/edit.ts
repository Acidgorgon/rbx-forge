// Edit mode: turns "set Prop of the element named X to V" into a text edit of the story source when
// the value is a literal there, so Forge can apply it as an undoable editor edit. Anything computed
// (a source, a function, a variable, string interpolation) is not touched: the caller hands those to
// the AI. Pure; a small Luau scanner that respects strings and comments.

import { luauLiteral, type UiValue } from './protocol.ts'

export interface TextEdit {
  start: number
  end: number
  text: string
}

export type EditPlan =
  | { ok: true; edit: TextEdit; line: number; how: 'replace' | 'insert' | 'value-match'; before: string }
  | { ok: false; reason: string; line?: number; expression?: string }

// Index just past the string/comment starting at i, or i when there is none.
function skipToken(src: string, i: number): number {
  const c = src[i]
  if (c === '-' && src[i + 1] === '-') {
    const long = /^--\[(=*)\[/.exec(src.slice(i, i + 64))
    if (long) {
      const close = src.indexOf(`]${long[1]}]`, i + long[0].length)
      return close < 0 ? src.length : close + long[1].length + 2
    }
    const nl = src.indexOf('\n', i)
    return nl < 0 ? src.length : nl
  }
  if (c === '"' || c === "'" || c === '`') {
    let j = i + 1
    while (j < src.length && src[j] !== c) {
      if (src[j] === '\\') j++
      else if (src[j] === '\n' && c !== '`') break
      j++
    }
    return j + 1
  }
  if (c === '[') {
    const long = /^\[(=*)\[/.exec(src.slice(i, i + 64))
    if (long) {
      const close = src.indexOf(`]${long[1]}]`, i + long[0].length)
      return close < 0 ? src.length : close + long[1].length + 2
    }
  }
  return i
}

// Code-only view: strings and comments blanked with spaces (same length, newlines kept), so plain
// searches never match inside them. Strings keep their quote characters.
export function codeMask(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const end = skipToken(src, i)
    if (end > i) {
      const tok = src.slice(i, end)
      const isString = tok[0] !== '-'
      out += isString ? tok[0] + tok.slice(1, -1).replace(/[^\n]/g, ' ') + (tok.length > 1 ? tok[tok.length - 1] : '') : tok.replace(/[^\n]/g, ' ')
      i = end
    } else {
      out += src[i]
      i++
    }
  }
  return out
}

const OPEN: Record<string, string> = { '{': '}', '(': ')', '[': ']' }

// Matching close bracket for the open bracket at `i` in masked code.
function matchClose(code: string, i: number): number {
  const stack: string[] = []
  for (let j = i; j < code.length; j++) {
    const c = code[j]
    if (OPEN[c]) stack.push(OPEN[c])
    else if (c === '}' || c === ')' || c === ']') {
      if (stack.pop() !== c) return -1
      if (!stack.length) return j
    }
  }
  return -1
}

// Innermost `{` that encloses position `at` in masked code.
function enclosingTable(code: string, at: number): number {
  let depth = 0
  for (let j = at - 1; j >= 0; j--) {
    const c = code[j]
    if (c === '}' || c === ')' || c === ']') depth++
    else if (c === '{' || c === '(' || c === '[') {
      if (depth === 0) return c === '{' ? j : -1
      depth--
    }
  }
  return -1
}

// Top-level entries of the table whose braces are at [open, close]: { key, keyStart, valueStart, valueEnd }.
export function tableEntries(src: string, open: number, close: number, code = codeMask(src)): { key: string | null; keyStart: number; valueStart: number; valueEnd: number }[] {
  const entries: { key: string | null; keyStart: number; valueStart: number; valueEnd: number }[] = []
  let start = open + 1
  let depth = 0
  const push = (end: number) => {
    const raw = code.slice(start, end)
    if (raw.trim()) {
      const lead = raw.length - raw.trimStart().length
      const keyStart = start + lead
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*/.exec(code.slice(keyStart, end))
      let valueEnd = end
      while (valueEnd > keyStart && /\s/.test(src[valueEnd - 1])) valueEnd--
      entries.push({ key: m ? m[1] : null, keyStart, valueStart: m ? keyStart + m[0].length : keyStart, valueEnd })
    }
    start = end + 1
  }
  for (let j = open + 1; j < close; j++) {
    const c = code[j]
    if (OPEN[c]) depth++
    else if (c === '}' || c === ')' || c === ']') depth--
    else if (depth === 0 && (c === ',' || c === ';')) push(j)
  }
  push(close)
  return entries
}

const NUM = String.raw`-?\d+(?:\.\d+)?(?:e-?\d+)?`
const ARGS = (n: number) => String.raw`\(\s*${Array.from({ length: n }, () => NUM).join(String.raw`\s*,\s*`)}\s*\)`
const LITERAL_PATTERNS = [
  new RegExp(String.raw`^${NUM}$`),
  /^(true|false|nil)$/,
  /^"(?:[^"\\\n]|\\.)*"$/,
  /^'(?:[^'\\\n]|\\.)*'$/,
  /^\[(=*)\[[\s\S]*\]\1\]$/,
  new RegExp(String.raw`^UDim2\.new${ARGS(4)}$`),
  new RegExp(String.raw`^UDim2\.from(?:Offset|Scale)${ARGS(2)}$`),
  new RegExp(String.raw`^UDim\.new${ARGS(2)}$`),
  new RegExp(String.raw`^Vector2\.new${ARGS(2)}$`),
  new RegExp(String.raw`^Color3\.(?:fromRGB|new)${ARGS(3)}$`),
  /^Color3\.fromHex\(\s*"#?[0-9a-fA-F]{6}"\s*\)$/,
  /^Enum\.[A-Za-z]+\.[A-Za-z0-9]+$/
]

export function isLiteralExpression(expr: string): boolean {
  const e = expr.trim()
  return LITERAL_PATTERNS.some((p) => p.test(e))
}

const lineOf = (src: string, at: number) => src.slice(0, at).split('\n').length

function lineIndent(src: string, at: number): string {
  const lineStart = src.lastIndexOf('\n', at - 1) + 1
  return /^[\t ]*/.exec(src.slice(lineStart))![0]
}

// Tables in which `Name = "<name>"` is a top-level entry.
function tablesNamed(src: string, code: string, name: string): { open: number; close: number }[] {
  const out: { open: number; close: number }[] = []
  const quoted = new RegExp(String.raw`\bName\s*=\s*(["'])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\1`, 'g')
  for (const m of src.matchAll(quoted)) {
    const at = m.index!
    if (code.slice(at, at + 4) !== 'Name') continue // inside a string or comment
    const open = enclosingTable(code, at)
    if (open < 0) continue
    const close = matchClose(code, open)
    if (close < 0) continue
    if (tableEntries(src, open, close, code).some((e) => e.key === 'Name' && e.keyStart === at)) out.push({ open, close })
  }
  return out
}

// Every literal spelling of a value we can search for (for the value-match fallback).
function valuePatterns(v: UiValue): RegExp[] {
  const lit = luauLiteral(v)
  if (lit == null) return []
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const loose = (s: string) => esc(s).replace(/,\\? ?/g, String.raw`\s*,\s*`).replace(/\\\(/g, String.raw`\(\s*`).replace(/\\\)/g, String.raw`\s*\)`)
  const out = [new RegExp(loose(lit), 'g')]
  if (typeof v === 'string') out.push(new RegExp(esc(`'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`), 'g'))
  if (typeof v === 'object' && v.t === 'UDim2') out.push(new RegExp(loose(`UDim2.new(${v.v.map((n) => String(Math.round(n * 1000) / 1000)).join(', ')})`), 'g'))
  return out
}

export interface EditTarget {
  // Instance name and class in the live tree.
  name: string
  cls: string
  // The property's current value (used when the element has no Name = "..." literal).
  current?: UiValue
}

// Plans setting `prop` to `value` on the element `target` in `src`.
export function planPropertyEdit(src: string, target: EditTarget, prop: string, value: UiValue): EditPlan {
  const literal = luauLiteral(value)
  if (literal == null) return { ok: false, reason: `${prop} values of this type can't be written as a literal` }
  const code = codeMask(src)
  const tables = tablesNamed(src, code, target.name)
  if (tables.length === 1) {
    const { open, close } = tables[0]
    const entries = tableEntries(src, open, close, code)
    const entry = entries.find((e) => e.key === prop)
    if (entry) {
      const expr = src.slice(entry.valueStart, entry.valueEnd)
      const line = lineOf(src, entry.valueStart)
      if (!isLiteralExpression(expr)) return { ok: false, reason: `${prop} is computed in code`, line, expression: expr.trim().slice(0, 200) }
      return { ok: true, how: 'replace', line, before: expr, edit: { start: entry.valueStart, end: entry.valueEnd, text: literal } }
    }
    // Not set here: add it after the Name entry, on its own line with the same indent.
    const nameEntry = entries.find((e) => e.key === 'Name')!
    const commaAt = code.indexOf(',', nameEntry.valueEnd)
    const lineEnd = src.indexOf('\n', nameEntry.valueEnd)
    if (commaAt >= 0 && lineEnd >= 0 && commaAt < lineEnd && src.slice(commaAt + 1, lineEnd).trim() === '') {
      const indent = lineIndent(src, nameEntry.keyStart)
      return { ok: true, how: 'insert', line: lineOf(src, lineEnd) + 1, before: '', edit: { start: lineEnd + 1, end: lineEnd + 1, text: `${indent}${prop} = ${literal},\n` } }
    }
    return { ok: true, how: 'insert', line: lineOf(src, nameEntry.valueEnd), before: '', edit: { start: commaAt >= 0 && commaAt < close ? commaAt + 1 : nameEntry.valueEnd, end: commaAt >= 0 && commaAt < close ? commaAt + 1 : nameEntry.valueEnd, text: commaAt >= 0 && commaAt < close ? ` ${prop} = ${literal},` : `, ${prop} = ${literal}` } }
  }
  if (tables.length > 1) return { ok: false, reason: `${tables.length} elements are named "${target.name}" in this file` }
  // No literal name: replace the current value if it appears exactly once, as `Prop = <value>`.
  if (target.current !== undefined) {
    const hits: { start: number; end: number }[] = []
    for (const re of valuePatterns(target.current)) {
      for (const m of src.matchAll(re)) {
        const start = m.index!
        const before = code.slice(Math.max(0, start - 80), start)
        const isString = typeof target.current === 'string'
        // Skip matches inside comments (strings are kept in the mask only for string values).
        if (!isString && code.slice(start, start + m[0].length) !== m[0]) continue
        if (isString && code[start] !== m[0][0]) continue
        if (!new RegExp(String.raw`\b${prop}\s*=\s*$`).test(before)) continue
        if (!hits.some((h) => h.start === start)) hits.push({ start, end: start + m[0].length })
      }
    }
    if (hits.length === 1) {
      const h = hits[0]
      return { ok: true, how: 'value-match', line: lineOf(src, h.start), before: src.slice(h.start, h.end), edit: { start: h.start, end: h.end, text: literal } }
    }
    if (hits.length > 1) return { ok: false, reason: `${prop} = ${luauLiteral(target.current)} appears ${hits.length} times` }
  }
  return { ok: false, reason: `no literal for ${target.name}.${prop} in this file (the name or value is built in code)` }
}

export function applyEdit(src: string, edit: TextEdit): string {
  return src.slice(0, edit.start) + edit.text + src.slice(edit.end)
}

// Offset -> 1-based line/column (Monaco ranges).
export function position(src: string, at: number): { lineNumber: number; column: number } {
  const before = src.slice(0, at)
  const lineNumber = before.split('\n').length
  return { lineNumber, column: at - (before.lastIndexOf('\n') + 1) + 1 }
}

// The chat prompt for changes Forge can't make as a literal edit.
export function askAiPrompt(o: { file: string; path: string; cls: string; prop?: string; from?: string | null; to?: string | null; reason?: string; note?: string }): string {
  const change = o.prop ? `Set ${o.prop}${o.from ? ` from ${o.from}` : ''}${o.to ? ` to ${o.to}` : ''}.` : (o.note ?? 'Describe the change: ')
  return [`In the UI preview of ${o.file}, change the ${o.cls} at ${o.path}.`, change, o.reason ? `(Forge couldn't edit it directly: ${o.reason}.)` : '', 'Check the result with preview_ui afterwards.'].filter(Boolean).join('\n')
}
