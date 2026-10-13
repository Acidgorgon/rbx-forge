// Blink (github.com/1Axen/blink) source parsing, shared by main (services/blink.ts) and the
// browser preview mock. Pure: no Node APIs.
//
// Grammar notes (Blink 0.18.1, src/Parser.luau + docs/pages/language/*):
//   option Name = value                         ClientOutput, ServerOutput, TypesOutput, Casing, ...
//   import "./path" [as Name]                   imported declarations live in a scope named Name or the file name
//   [export] type|map|set|enum|struct Name ...  type declarations (generics: struct Name<T> { ... })
//   event Name { From: Server|Client, Type: Reliable|Unreliable,
//                Call: SingleSync|SingleAsync|ManySync|ManyAsync|Polling, Poll: bool?, Data: T? }
//   function Name { Yield: Coroutine|Future|Promise, Data: T?, Return: T? }
//   scope Name { ...declarations... }
//   comments: -- line, --[[ block ]], --[=[ block ]=]

import type { BlinkEvent, BlinkTypeDecl } from './types'

export const BLINK_ENTRY = 'events.blink'

const DECL_KEYWORDS = new Set(['type', 'map', 'set', 'enum', 'struct', 'event', 'function', 'scope', 'option', 'export', 'import'])
const TYPE_KEYWORDS = new Set(['type', 'map', 'set', 'enum', 'struct'])

// ---------------------------------------------------------------- tokenizer

type TokKind = 'ident' | 'string' | 'number' | 'punct' | 'comment'

interface Token {
  kind: TokKind
  text: string
  // String tokens: the value without quotes.
  value: string
  start: number
  end: number
  line: number
  column: number
}

export function tokenize(source: string): Token[] {
  const out: Token[] = []
  let i = 0
  let line = 1
  let lineStart = 0
  const push = (kind: TokKind, start: number, end: number, value?: string) => {
    out.push({ kind, text: source.slice(start, end), value: value ?? source.slice(start, end), start, end, line, column: start - lineStart + 1 })
  }
  const advanceLines = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      if (source[k] === '\n') {
        line++
        lineStart = k + 1
      }
    }
  }
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\n') {
      line++
      i++
      lineStart = i
      continue
    }
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (source.startsWith('--', i)) {
      const block = /^--\[(=*)\[/.exec(source.slice(i, i + 64))
      let end: number
      if (block) {
        const close = source.indexOf(`]${block[1]}]`, i + block[0].length)
        end = close < 0 ? source.length : close + block[1].length + 2
      } else {
        const nl = source.indexOf('\n', i)
        end = nl < 0 ? source.length : nl
      }
      const startLine = line
      const startCol = i - lineStart + 1
      out.push({ kind: 'comment', text: source.slice(i, end), value: '', start: i, end, line: startLine, column: startCol })
      advanceLines(i, end)
      i = end
      continue
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < source.length && source[j] !== ch && source[j] !== '\n') {
        if (source[j] === '\\') j++
        j++
      }
      const closed = source[j] === ch
      push('string', i, closed ? j + 1 : j, source.slice(i + 1, j))
      i = closed ? j + 1 : j
      continue
    }
    const num = /^-?(\d+\.?\d*|\.\d+)/.exec(source.slice(i, i + 64))
    if (num && (ch !== '-' || /\d|\./.test(source[i + 1] ?? ''))) {
      // `0..100` is a range: stop the number before the dots.
      let text = num[0]
      if (text.endsWith('.') && source[i + text.length] === '.') text = text.slice(0, -1)
      push('number', i, i + text.length)
      i += text.length
      continue
    }
    const ident = /^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)*/.exec(source.slice(i, i + 256))
    if (ident) {
      push('ident', i, i + ident[0].length)
      i += ident[0].length
      continue
    }
    if (source.startsWith('..', i)) {
      push('punct', i, i + 2)
      i += 2
      continue
    }
    push('punct', i, i + 1)
    i++
  }
  return out
}

// ---------------------------------------------------------------- parser

export interface BlinkImport {
  // The path exactly as written in the import statement.
  path: string
  as?: string
  // The scope name Blink gives it: `as` name, else the file name without extension.
  scopeName: string
  line: number
}

export interface ParsedBlinkFile {
  file: string
  options: Record<string, string | boolean | number>
  optionLines: Record<string, number>
  imports: (BlinkImport & { scope: string[] })[]
  events: BlinkEvent[]
  types: BlinkTypeDecl[]
  // Constructs the parser skipped (unknown keywords etc.), for debugging. Never fatal.
  skipped: { line: number; text: string }[]
}

const OPEN: Record<string, string> = { '{': '}', '(': ')', '[': ']', '<': '>' }
const CLOSE = new Set(['}', ')', ']', '>'])

// Source text for tokens [from, to), comments removed, whitespace collapsed.
function sliceText(source: string, toks: Token[], from: number, to: number): string {
  let out = ''
  let prev: Token | null = null
  for (let k = from; k < to; k++) {
    const t = toks[k]
    if (t.kind === 'comment') continue
    if (prev) {
      const gap = source.slice(prev.end, t.start)
      if (/\s|--/.test(gap)) out += ' '
    }
    out += t.text
    prev = t
  }
  return out.trim()
}

export function importScopeName(path: string, as?: string): string {
  if (as) return as
  const base = path.split(/[\\/]/).pop() || path
  return base.replace(/\.(blink|txt)$/i, '')
}

export function parseBlink(source: string, file = BLINK_ENTRY, scopePrefix: string[] = []): ParsedBlinkFile {
  const all = tokenize(source)
  const toks = all
  const result: ParsedBlinkFile = { file, options: {}, optionLines: {}, imports: [], events: [], types: [], skipped: [] }
  let i = 0

  const peek = (k = i): Token | undefined => {
    while (k < toks.length && toks[k].kind === 'comment') k++
    return toks[k]
  }
  const nextIndex = (k = i): number => {
    while (k < toks.length && toks[k].kind === 'comment') k++
    return k
  }
  const take = (): Token | undefined => {
    i = nextIndex()
    const t = toks[i]
    if (t) i++
    return t
  }
  const is = (t: Token | undefined, text: string) => !!t && t.kind !== 'string' && t.text === text

  // Skips a balanced group starting at an opening bracket. Returns the index after it.
  const skipGroup = (k: number): number => {
    const stack: string[] = []
    for (; k < toks.length; k++) {
      const t = toks[k]
      if (t.kind !== 'punct') continue
      if (OPEN[t.text]) stack.push(OPEN[t.text])
      else if (CLOSE.has(t.text)) {
        if (stack[stack.length - 1] === t.text) stack.pop()
        else if (!stack.includes(t.text)) continue
        else while (stack.length && stack.pop() !== t.text) { /* unwind */ }
        if (stack.length === 0) return k + 1
      }
    }
    return k
  }

  // Skips a type expression (after `=` in a type declaration) up to the next top-level declaration.
  const skipTypeExpr = (k: number): number => {
    let prevSignificant: Token | undefined
    for (; k < toks.length; k++) {
      const t = toks[k]
      if (t.kind === 'comment') continue
      if (t.kind === 'punct' && OPEN[t.text]) {
        k = skipGroup(k) - 1
        prevSignificant = toks[k]
        continue
      }
      if (t.kind === 'punct' && t.text === '}') return k
      // A keyword starts the next declaration unless it is part of this expression (`= struct {`).
      if (t.kind === 'ident' && DECL_KEYWORDS.has(t.text) && prevSignificant && !is(prevSignificant, '=') && !is(prevSignificant, ':')) {
        return k
      }
      prevSignificant = t
    }
    return k
  }

  // Parses `{ Key: value, ... }` for events and functions. Values are kept as source text.
  const parseFields = (): { fields: Record<string, string>; fieldLines: Record<string, number> } => {
    const fields: Record<string, string> = {}
    const fieldLines: Record<string, number> = {}
    const open = nextIndex()
    if (!is(toks[open], '{')) return { fields, fieldLines }
    const end = skipGroup(open)
    let k = open + 1
    while (k < end - 1) {
      k = nextIndex(k)
      if (k >= end - 1) break
      const key = toks[k]
      const colon = nextIndex(k + 1)
      if (key.kind !== 'ident' || !is(toks[colon], ':')) {
        k++
        continue
      }
      let v = colon + 1
      const valueStart = nextIndex(v)
      for (v = valueStart; v < end - 1; v++) {
        const t = toks[v]
        if (t.kind === 'punct' && OPEN[t.text]) {
          v = skipGroup(v) - 1
          continue
        }
        if (is(t, ',')) break
      }
      fields[key.text] = sliceText(source, toks, valueStart, v)
      fieldLines[key.text] = key.line
      k = v + 1
    }
    i = end
    return { fields, fieldLines }
  }

  const scopeStack: string[] = []
  const currentScope = () => [...scopePrefix, ...scopeStack]

  while (i < toks.length) {
    const t = take()
    if (!t) break
    if (is(t, '}')) {
      if (scopeStack.length) scopeStack.pop()
      continue
    }
    if (t.kind !== 'ident') {
      result.skipped.push({ line: t.line, text: t.text })
      continue
    }
    const word = t.text

    if (word === 'option') {
      const name = take()
      const eq = peek()
      if (!name) break
      if (is(eq, '=')) take()
      const value = take()
      if (value) {
        let v: string | boolean | number = value.value
        if (value.kind === 'ident' && (value.text === 'true' || value.text === 'false')) v = value.text === 'true'
        else if (value.kind === 'number') v = Number(value.text)
        result.options[name.text] = v
        result.optionLines[name.text] = name.line
      }
      continue
    }

    if (word === 'import') {
      const path = take()
      if (!path || path.kind !== 'string') continue
      let as: string | undefined
      if (is(peek(), 'as')) {
        take()
        const name = take()
        as = name?.value
      }
      result.imports.push({ path: path.value, as, scopeName: importScopeName(path.value, as), line: t.line, scope: currentScope() })
      continue
    }

    if (word === 'scope') {
      const name = take()
      if (name && is(peek(), '{')) {
        take()
        scopeStack.push(name.text)
        // Scopes are not types, but listing them helps navigation.
      }
      continue
    }

    let exported = false
    let keyword = word
    let keywordTok = t
    if (word === 'export') {
      exported = true
      const next = take()
      if (!next) break
      keyword = next.text
      keywordTok = next
    }

    if (keyword === 'event' || keyword === 'function') {
      const name = take()
      if (!name || name.kind !== 'ident') continue
      const { fields } = parseFields()
      const ev: BlinkEvent = {
        kind: keyword,
        name: name.text,
        scope: currentScope(),
        file,
        line: keywordTok.line,
        column: keywordTok.column
      }
      if (i > 0 && toks[i - 1]) ev.endLine = toks[i - 1].line
      if (keyword === 'event') {
        if (fields.From === 'Server' || fields.From === 'Client') ev.from = fields.From
        if (fields.Type === 'Reliable' || fields.Type === 'Unreliable') ev.type = fields.Type
        if (fields.Call) ev.call = fields.Call as BlinkEvent['call']
        if (fields.Poll !== undefined) ev.poll = fields.Poll === 'true'
      } else {
        if (fields.Yield) ev.yield = fields.Yield as BlinkEvent['yield']
      }
      if (fields.Data !== undefined) ev.data = fields.Data
      if (fields.Return !== undefined) ev.return = fields.Return
      result.events.push(ev)
      continue
    }

    if (TYPE_KEYWORDS.has(keyword)) {
      const name = take()
      if (!name || name.kind !== 'ident') continue
      const decl: BlinkTypeDecl = {
        kind: keyword as BlinkTypeDecl['kind'],
        name: name.text,
        scope: currentScope(),
        file,
        line: keywordTok.line
      }
      if (exported) decl.exported = true
      // Generic parameters: Name<K, V>
      let k = nextIndex()
      if (is(toks[k], '<')) {
        const end = skipGroup(k)
        decl.generics = toks.slice(k + 1, end - 1).filter((x) => x.kind === 'ident').map((x) => x.text)
        k = end
      }
      k = nextIndex(k)
      if (is(toks[k], '=')) k = nextIndex(k + 1)
      const bodyStart = k
      let bodyEnd: number
      if (keyword === 'struct' && is(toks[k], '{')) bodyEnd = skipGroup(k)
      else bodyEnd = skipTypeExpr(k)
      decl.definition = sliceText(source, toks, bodyStart, bodyEnd)
      if (keyword === 'enum' || keyword === 'set') {
        const tagged = toks[bodyStart]?.kind === 'string'
        if (tagged) decl.tag = toks[bodyStart].value
        const brace = tagged ? nextIndex(bodyStart + 1) : bodyStart
        if (is(toks[brace], '{')) decl.members = memberNames(toks, brace, skipGroup(brace))
      } else if (keyword === 'struct' && is(toks[bodyStart], '{')) {
        decl.members = memberNames(toks, bodyStart, bodyEnd)
      }
      i = bodyEnd
      result.types.push(decl)
      continue
    }

    result.skipped.push({ line: t.line, text: t.text })
  }
  return result
}

// Top-level member names inside { ... }: struct fields, enum variants, set flags.
function memberNames(toks: Token[], open: number, end: number): string[] {
  const names: string[] = []
  let depth = 0
  let expectName = true
  for (let k = open + 1; k < end - 1; k++) {
    const t = toks[k]
    if (t.kind === 'comment') continue
    if (t.kind === 'punct' && OPEN[t.text]) {
      depth++
      continue
    }
    if (t.kind === 'punct' && CLOSE.has(t.text)) {
      depth--
      continue
    }
    if (depth !== 0) continue
    if (t.text === ',') {
      expectName = true
      continue
    }
    if (t.text === '..') {
      const next = toks[k + 1]
      if (expectName && next?.kind === 'ident') names.push(`..${next.text}`)
      expectName = false
      k++
      continue
    }
    if (expectName && t.kind === 'ident') names.push(t.text)
    expectName = false
  }
  return names
}

// ---------------------------------------------------------------- formatting new declarations

export interface BlinkEventSpec {
  kind?: 'event' | 'function'
  name: string
  // Events
  from?: 'Server' | 'Client'
  type?: 'Reliable' | 'Unreliable'
  call?: 'SingleSync' | 'SingleAsync' | 'ManySync' | 'ManyAsync' | 'Polling'
  poll?: boolean
  // Functions
  yield?: 'Coroutine' | 'Future' | 'Promise'
  data?: string
  return?: string
  // Optional scope to add it to; created at the end of the file when missing.
  scope?: string
}

const CALLS = ['SingleSync', 'SingleAsync', 'ManySync', 'ManyAsync', 'Polling']

export function formatDeclaration(spec: BlinkEventSpec, indent = ''): string {
  const kind = spec.kind ?? 'event'
  if (!/^[A-Za-z_]\w*$/.test(spec.name)) throw new Error(`Invalid Blink name "${spec.name}"`)
  const fields: string[] = []
  if (kind === 'event') {
    const from = spec.from ?? 'Server'
    const type = spec.type ?? 'Reliable'
    const call = spec.call ?? 'ManyAsync'
    if (from !== 'Server' && from !== 'Client') throw new Error('From must be Server or Client')
    if (type !== 'Reliable' && type !== 'Unreliable') throw new Error('Type must be Reliable or Unreliable')
    if (!CALLS.includes(call)) throw new Error(`Call must be one of ${CALLS.join(', ')}`)
    fields.push(`From: ${from}`, `Type: ${type}`, `Call: ${call}`)
    if (spec.poll !== undefined) fields.push(`Poll: ${spec.poll}`)
  } else {
    const y = spec.yield ?? 'Coroutine'
    if (!['Coroutine', 'Future', 'Promise'].includes(y)) throw new Error('Yield must be Coroutine, Future or Promise')
    fields.push(`Yield: ${y}`)
  }
  if (spec.data && spec.data.trim()) fields.push(`Data: ${spec.data.trim()}`)
  if (kind === 'function' && spec.return && spec.return.trim()) fields.push(`Return: ${spec.return.trim()}`)
  const inner = indent + '    '
  return `${indent}${kind} ${spec.name} {\n${fields.map((f) => inner + f).join(',\n')}\n${indent}}\n`
}

// Appends a declaration to the source: at the end of the file, or at the end of `scope` when given.
export function appendDeclaration(source: string, spec: BlinkEventSpec): string {
  const parsed = parseBlink(source)
  const scopePath = spec.scope ? spec.scope.split('.') : []
  if (parsed.events.some((e) => e.name === spec.name && e.scope.join('.') === scopePath.join('.'))) {
    throw new Error(`${[...scopePath, spec.name].join('.')} is already declared`)
  }
  const base = source.replace(/\s*$/, '')
  if (!scopePath.length) return `${base}${base ? '\n\n' : ''}${formatDeclaration(spec)}`
  // Find the closing brace of a top-level `scope Name {`.
  const toks = tokenize(source).filter((t) => t.kind !== 'comment')
  for (let k = 0; k < toks.length - 2; k++) {
    if (toks[k].text === 'scope' && toks[k + 1].text === scopePath[0] && toks[k + 2].text === '{' && scopePath.length === 1) {
      let depth = 0
      for (let j = k + 2; j < toks.length; j++) {
        if (toks[j].text === '{') depth++
        else if (toks[j].text === '}' && --depth === 0) {
          const close = toks[j]
          const lineStart = source.lastIndexOf('\n', close.start - 1) + 1
          const before = source.slice(0, lineStart).replace(/\s*$/, '')
          const closeIndent = source.slice(lineStart, close.start).match(/^\s*/)?.[0] ?? ''
          return `${before}\n\n${formatDeclaration(spec, closeIndent + '    ')}${source.slice(lineStart)}`
        }
      }
    }
  }
  const decl = formatDeclaration(spec, '    ')
  return `${base}${base ? '\n\n' : ''}scope ${scopePath.join('.')} {\n${decl}}\n`
}
