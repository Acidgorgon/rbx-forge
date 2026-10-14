// Context-aware completions and hovers for Blink files. Pure: works on the text and a
// character offset; the renderer adapts the results to Monaco (src/renderer/src/blinkLanguage.ts).

import {
  BLINK_CASINGS,
  BLINK_DOCS,
  BLINK_EVENT_FIELDS,
  BLINK_FUNCTION_FIELDS,
  BLINK_INSTANCE_CLASSES,
  BLINK_NUMBER_TYPES,
  BLINK_OPTIONS,
  BLINK_PRIMITIVES,
  type BlinkField
} from './language.ts'

export type BlinkCompletionKind = 'keyword' | 'field' | 'value' | 'type' | 'primitive' | 'option' | 'snippet' | 'class'

export interface BlinkCompletion {
  label: string
  kind: BlinkCompletionKind
  // Monaco snippet syntax when `snippet` is true, plain text otherwise.
  insertText: string
  snippet?: boolean
  detail?: string
  documentation?: string
  sortText?: string
}

// What the cursor sits in.
export type BlinkContext =
  | { kind: 'top'; scope: string[] }
  | { kind: 'optionName' }
  | { kind: 'optionValue'; option: string }
  | { kind: 'fieldKey'; block: 'event' | 'function'; present: string[] }
  | { kind: 'fieldValue'; field: string; block: 'event' | 'function' }
  | { kind: 'type'; scope: string[]; generics: string[] }
  | { kind: 'encoding' }
  | { kind: 'instanceClass' }
  | { kind: 'memberKey' }
  | { kind: 'none' }

type Frame =
  | { kind: 'scope'; name: string }
  | { kind: 'event' | 'function'; name: string }
  | { kind: 'block' }
  | { kind: 'paren'; owner: string }
  | { kind: 'angle'; owner: string }
  | { kind: 'square' }

interface Tok {
  kind: 'ident' | 'string' | 'number' | 'punct'
  text: string
  start: number
  end: number
}

// Tokens of `source` (comments dropped). A string left open at the end is kept as a string.
export function lexBlink(source: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (source.startsWith('--', i)) {
      const block = /^--\[(=*)\[/.exec(source.slice(i, i + 64))
      if (block) {
        const close = `]${block[1]}]`
        const end = source.indexOf(close, i + block[0].length)
        i = end < 0 ? source.length : end + close.length
      } else {
        const nl = source.indexOf('\n', i)
        i = nl < 0 ? source.length : nl
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < source.length && source[j] !== ch && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1
      const end = Math.min(source.length, source[j] === ch ? j + 1 : j)
      out.push({ kind: 'string', text: source.slice(i, end), start: i, end })
      i = end
      continue
    }
    const ident = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/.exec(source.slice(i, i + 256))
    if (ident) {
      out.push({ kind: 'ident', text: ident[0], start: i, end: i + ident[0].length })
      i += ident[0].length
      continue
    }
    const num = /^\d*\.?\d+/.exec(source.slice(i, i + 64))
    if (num && !source.startsWith('..', i)) {
      out.push({ kind: 'number', text: num[0], start: i, end: i + num[0].length })
      i += num[0].length
      continue
    }
    const two = source.slice(i, i + 2)
    if (two === '..') {
      out.push({ kind: 'punct', text: two, start: i, end: i + 2 })
      i += 2
      continue
    }
    out.push({ kind: 'punct', text: ch, start: i, end: i + 1 })
    i++
  }
  return out
}

const isEventLike = (f: Frame | undefined): f is { kind: 'event' | 'function'; name: string } => f?.kind === 'event' || f?.kind === 'function'

// Walk the tokens before `offset` and keep a stack of the enclosing constructs.
function frames(tokens: Tok[]): Frame[] {
  const stack: Frame[] = []
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]
    if (t.kind !== 'punct') continue
    const prev = tokens[k - 1]
    const prev2 = tokens[k - 2]
    if (t.text === '{') {
      if (prev?.kind === 'ident' && prev2?.kind === 'ident' && (prev2.text === 'event' || prev2.text === 'function')) {
        stack.push({ kind: prev2.text, name: prev.text })
      } else if (prev?.kind === 'ident' && prev2?.text === 'scope') {
        stack.push({ kind: 'scope', name: prev.text })
      } else {
        stack.push({ kind: 'block' })
      }
    } else if (t.text === '(') {
      stack.push({ kind: 'paren', owner: prev?.kind === 'ident' ? prev.text : '' })
    } else if (t.text === '<') {
      stack.push({ kind: 'angle', owner: prev?.kind === 'ident' ? prev.text : '' })
    } else if (t.text === '[') {
      stack.push({ kind: 'square' })
    } else if (t.text === '}' || t.text === ')' || t.text === '>' || t.text === ']') {
      const open = { '}': ['scope', 'event', 'function', 'block'], ')': ['paren'], '>': ['angle'], ']': ['square'] }[t.text] ?? []
      // Pop to the matching opener; an unmatched closer is ignored.
      for (let at = stack.length - 1; at >= 0; at--) {
        if (open.includes(stack[at].kind)) {
          stack.length = at
          break
        }
      }
    }
  }
  return stack
}

// Generic parameters of the declaration the cursor is in (`struct Name<T, U> {`).
function genericsInScope(tokens: Tok[]): string[] {
  // Find the start of the current top-level (or scope-level) declaration.
  let depth = 0
  for (let k = tokens.length - 1; k >= 0; k--) {
    const t = tokens[k]
    if (t.text === '}' || t.text === ')' || t.text === ']') depth++
    else if (t.text === '{' || t.text === '(' || t.text === '[') depth--
    if (depth <= 0 && t.kind === 'ident' && ['struct', 'enum', 'map', 'type', 'set'].includes(t.text) && tokens[k + 2]?.text === '<') {
      const out: string[] = []
      for (let j = k + 3; j < tokens.length && tokens[j].text !== '>'; j++) if (tokens[j].kind === 'ident') out.push(tokens[j].text)
      return out
    }
    if (depth <= 0 && t.kind === 'ident' && ['event', 'function', 'option', 'scope'].includes(t.text)) break
  }
  return []
}

// Start of the token run that `offset` is completing (the word being typed).
function wordBefore(source: string, offset: number): string {
  return /[A-Za-z_][\w.]*$/.exec(source.slice(0, offset))?.[0] ?? ''
}

export function blinkContext(source: string, offset: number): BlinkContext {
  const word = wordBefore(source, offset)
  const head = source.slice(0, offset - word.length)
  const tokens = lexBlink(head)
  const last = tokens[tokens.length - 1]
  // Inside a comment or an unterminated string: nothing.
  if (last?.kind === 'string' && (last.text.length === 1 || last.text[last.text.length - 1] !== last.text[0]) && last.end === head.length) return { kind: 'none' }
  const lineStart = head.lastIndexOf('\n') + 1
  if (/--/.test(stripStrings(head.slice(lineStart)))) return { kind: 'none' }
  if (/--\[=*\[(?![\s\S]*\]=*\])[\s\S]*$/.test(head)) return { kind: 'none' }

  const stack = frames(tokens)
  const top = stack[stack.length - 1]
  const scope = stack.filter((f): f is { kind: 'scope'; name: string } => f.kind === 'scope').map((f) => f.name)
  const prev = tokens[tokens.length - 1]
  const prev2 = tokens[tokens.length - 2]

  if (top?.kind === 'paren') {
    if (top.owner === 'Instance') return { kind: 'instanceClass' }
    // Ranges take numbers; type packs (`Data: (u8, string)`) take types.
    if (BLINK_PRIMITIVES.includes(top.owner as never)) return { kind: 'none' }
    return { kind: 'type', scope, generics: genericsInScope(tokens) }
  }
  if (top?.kind === 'angle') {
    if (top.owner === 'vector' || top.owner === 'CFrame') return { kind: 'encoding' }
    // Declaring generics (`struct Name<T`) names new parameters; instantiating takes types.
    const declaring = tokens.slice(-6).some((t, i, a) => ['struct', 'enum', 'map', 'type', 'set'].includes(t.text) && a[i + 2]?.text === '<')
    return declaring ? { kind: 'none' } : { kind: 'type', scope, generics: genericsInScope(tokens) }
  }
  if (top?.kind === 'square') {
    // `[K]` map keys are types; array bounds are numbers.
    const opener = tokens.map((t) => t.text).lastIndexOf('[')
    const before = tokens[opener - 1]
    return before && (before.text === '{' || before.text === ',') ? { kind: 'type', scope, generics: genericsInScope(tokens) } : { kind: 'none' }
  }

  // option Name = value
  if (prev?.text === 'option' && (stack.length === 0 || top?.kind === 'scope')) return { kind: 'optionName' }
  if (prev?.text === '=' && prev2?.kind === 'ident' && tokens[tokens.length - 3]?.text === 'option') return { kind: 'optionValue', option: prev2.text }

  if (isEventLike(top)) {
    const block = top.kind
    if (prev?.text === ':' && prev2?.kind === 'ident') {
      const field = canonicalField(prev2.text, block)
      if (field === 'Data' || field === 'Return') return { kind: 'type', scope, generics: [] }
      if (field) return { kind: 'fieldValue', field, block }
      return { kind: 'none' }
    }
    // Inside a field's type after `Data:` (e.g. `Data: u8?` then more): a type position only
    // right after `:`; otherwise a key position after `{` or `,`.
    if (prev?.text === '{' || prev?.text === ',') return { kind: 'fieldKey', block, present: presentFields(tokens, block) }
    if (inFieldValue(tokens) === 'Data' || inFieldValue(tokens) === 'Return') return { kind: 'type', scope, generics: [] }
    return { kind: 'none' }
  }

  if (top?.kind === 'block') {
    if (prev?.text === ':') return { kind: 'type', scope, generics: genericsInScope(tokens) }
    if (prev?.text === '{' || prev?.text === ',') return { kind: 'memberKey' }
    if (prev?.text === '..') return { kind: 'type', scope, generics: genericsInScope(tokens) }
    return { kind: 'none' }
  }

  // Top level or a scope body.
  if (prev?.text === '=') {
    // `type X =`, `map X =`, `enum X =` ...: a type (enum/set/map bodies start with `{` or a string).
    return { kind: 'type', scope, generics: genericsInScope(tokens) }
  }
  if (prev?.text === 'import' || prev?.text === 'as') return { kind: 'none' }
  if (prev?.kind === 'ident' && ['type', 'struct', 'enum', 'map', 'set', 'event', 'function', 'scope', 'option'].includes(prev.text)) return { kind: 'none' }
  if (prev?.text === 'export') return { kind: 'top', scope }
  // Start of a new declaration: the previous token ends one (or nothing before).
  if (!prev || startsDeclaration(tokens)) return { kind: 'top', scope }
  return { kind: 'none' }
}

function stripStrings(line: string): string {
  return line.replace(/"([^"\\]|\\.)*"?|'([^'\\]|\\.)*'?/g, '""')
}

// True when the tokens so far end a complete declaration, so the cursor starts a new one.
function startsDeclaration(tokens: Tok[]): boolean {
  const last = tokens[tokens.length - 1]
  if (!last) return true
  if (last.text === '{' || last.text === '}') return true
  // `option X = value`, `type X = u8`, `import "x"`: a value just ended. A new line is the
  // usual signal, but the lexer drops whitespace; accept anything that is not an operator.
  return !['=', ':', ',', '..', '<', '(', '['].includes(last.text) && !(last.kind === 'ident' && ['export', 'import', 'as', 'option'].includes(last.text))
}

function canonicalField(key: string, block: 'event' | 'function'): string | undefined {
  const fields = block === 'event' ? BLINK_EVENT_FIELDS : BLINK_FUNCTION_FIELDS
  return fields.find((f) => f.key === key || f.key.toLowerCase() === key)?.key
}

// Field keys already written in the innermost event/function body.
function presentFields(tokens: Tok[], block: 'event' | 'function'): string[] {
  const out: string[] = []
  let depth = 0
  for (let k = tokens.length - 1; k >= 0; k--) {
    const t = tokens[k]
    if (t.text === '}' || t.text === ')') depth++
    else if (t.text === '{' || t.text === '(') {
      if (depth === 0) break
      depth--
    } else if (depth === 0 && t.kind === 'ident' && tokens[k + 1]?.text === ':') {
      const f = canonicalField(t.text, block)
      if (f) out.unshift(f)
    }
  }
  return out
}

// The field whose value the cursor is in (`Data: Foo<` ... before the next `,`).
function inFieldValue(tokens: Tok[]): string | undefined {
  let depth = 0
  for (let k = tokens.length - 1; k >= 0; k--) {
    const t = tokens[k]
    if (t.text === '}' || t.text === ')' || t.text === '>') depth++
    else if (t.text === '{' || t.text === '(' || t.text === '<') {
      if (depth === 0) return undefined
      depth--
    } else if (depth === 0 && t.text === ',') return undefined
    else if (depth === 0 && t.text === ':' && tokens[k - 1]?.kind === 'ident') return canonicalField(tokens[k - 1].text, 'function') ?? canonicalField(tokens[k - 1].text, 'event')
  }
  return undefined
}

export interface BlinkDeclaration {
  // Qualified name (`Scope.Name` inside scopes).
  name: string
  keyword: string
  // 1-based line of the declaration.
  line: number
  scope: string[]
}

// Every type, event and function declared in the file (not imports' contents).
export function blinkDeclarations(source: string): BlinkDeclaration[] {
  const tokens = lexBlink(source)
  const out: BlinkDeclaration[] = []
  const scopes: { name: string; depth: number }[] = []
  let depth = 0
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]
    if (t.text === '{') depth++
    else if (t.text === '}') {
      depth--
      if (scopes.length && scopes[scopes.length - 1].depth === depth) scopes.pop()
    } else if (t.kind === 'ident' && depth === scopes.length && ['type', 'struct', 'enum', 'map', 'set', 'event', 'function', 'scope'].includes(t.text)) {
      const name = tokens[k + 1]
      if (name?.kind !== 'ident') continue
      const path = scopes.map((s) => s.name)
      const line = source.slice(0, name.start).split('\n').length
      if (t.text === 'scope') {
        if (tokens[k + 2]?.text === '{') {
          out.push({ name: [...path, name.text].join('.'), keyword: 'scope', line, scope: path })
          scopes.push({ name: name.text, depth })
        }
        continue
      }
      out.push({ name: [...path, name.text].join('.'), keyword: t.text, line, scope: path })
    } else if (t.kind === 'ident' && t.text === 'import' && depth === scopes.length) {
      const path = tokens[k + 1]
      if (path?.kind !== 'string') continue
      const as = tokens[k + 2]?.text === 'as' && tokens[k + 3]?.kind === 'string' ? unquote(tokens[k + 3].text) : null
      const file = unquote(path.text).split('/').pop()?.replace(/\.(blink|txt)$/, '') ?? ''
      if (file || as) out.push({ name: as || file, keyword: 'import', line: source.slice(0, t.start).split('\n').length, scope: [] })
    }
  }
  return out
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, '')
}

const TOP_SNIPPETS: BlinkCompletion[] = [
  { label: 'event', kind: 'snippet', snippet: true, insertText: 'event ${1:Name} {\n\tFrom: ${2|Server,Client|},\n\tType: ${3|Reliable,Unreliable|},\n\tCall: ${4|SingleAsync,SingleSync,ManyAsync,ManySync,Polling|},\n\tData: ${5:u8}\n}', detail: 'event Name { From, Type, Call, Data }' },
  { label: 'function', kind: 'snippet', snippet: true, insertText: 'function ${1:Name} {\n\tYield: ${2|Coroutine,Future,Promise|},\n\tData: ${3:u8},\n\tReturn: ${4:u8}\n}', detail: 'function Name { Yield, Data, Return }' },
  { label: 'struct', kind: 'snippet', snippet: true, insertText: 'struct ${1:Name} {\n\t${2:Key}: ${3:u8},\n}', detail: 'struct Name { Key: Type }' },
  { label: 'enum', kind: 'snippet', snippet: true, insertText: 'enum ${1:Name} = { ${2:A}, ${3:B} }', detail: 'enum Name = { A, B }' },
  { label: 'enum (tagged)', kind: 'snippet', snippet: true, insertText: 'enum ${1:Name} = "${2:Type}" {\n\t${3:A} {\n\t\t${4:Value}: ${5:u8}\n\t},\n}', detail: 'enum Name = "Tag" { A { ... } }' },
  { label: 'map', kind: 'snippet', snippet: true, insertText: 'map ${1:Name} = { [${2:string}]: ${3:u8} }', detail: 'map Name = { [K]: V }' },
  { label: 'set', kind: 'snippet', snippet: true, insertText: 'set ${1:Name} = { ${2:A}, ${3:B} }', detail: 'set Name = { A, B }' },
  { label: 'type', kind: 'snippet', snippet: true, insertText: 'type ${1:Name} = ${2:u8}', detail: 'type Name = Type' },
  { label: 'scope', kind: 'snippet', snippet: true, insertText: 'scope ${1:Name} {\n\t$0\n}', detail: 'scope Name { ... }' },
  { label: 'import', kind: 'snippet', snippet: true, insertText: 'import "${1:./file}"', detail: 'import "./path" [as "Name"]' },
  { label: 'export', kind: 'keyword', insertText: 'export ', detail: 'export a type\'s Read/Write' },
  { label: 'option', kind: 'keyword', insertText: 'option ', detail: 'option Name = value' }
]

function optionSnippet(name: string): string {
  const o = BLINK_OPTIONS.find((x) => x.name === name)
  if (!o) return name
  if (o.kind === 'casing') return `${name} = \${1|${BLINK_CASINGS.join(',')}|}`
  if (o.kind === 'boolean') return `${name} = \${1|${o.default === 'true' ? 'false,true' : 'true,false'}|}`
  return `${name} = "\${1}"`
}

function fieldSnippet(f: BlinkField): string {
  if (f.values) return `${f.key}: \${1|${f.values.join(',')}|}`
  return `${f.key}: \${1:u8}`
}

function typeCompletions(source: string, scope: string[], generics: string[]): BlinkCompletion[] {
  const out: BlinkCompletion[] = BLINK_PRIMITIVES.map((p) => ({ label: p, kind: 'primitive', insertText: p, detail: 'primitive', documentation: BLINK_DOCS[p], sortText: `1${p}` }))
  out.push({ label: 'Instance(Class)', kind: 'snippet', snippet: true, insertText: 'Instance(${1:Player})', detail: 'Instance narrowed by class', sortText: '1Instance(' })
  for (const g of generics) out.push({ label: g, kind: 'type', insertText: g, detail: 'generic parameter', sortText: `0${g}` })
  const seen = new Set<string>()
  const decls = blinkDeclarations(source)
  for (const d of decls) {
    if (d.keyword === 'event' || d.keyword === 'function') continue
    // A scope is only worth offering (as `Scope.`) when it declares types.
    if (d.keyword === 'scope' && !decls.some((x) => x.name.startsWith(`${d.name}.`) && !['event', 'function', 'scope'].includes(x.keyword))) continue
    // Names declared in the enclosing scope (or its parents) are visible unqualified.
    const inScope = d.scope.length <= scope.length && d.scope.every((s, i) => scope[i] === s)
    const label = inScope ? d.name.split('.').slice(d.scope.length).join('.') : d.name
    if (seen.has(label)) continue
    seen.add(label)
    const kind = d.keyword === 'scope' || d.keyword === 'import' ? 'class' : 'type'
    out.push({ label, kind, insertText: label, detail: d.keyword === 'import' ? 'imported scope' : `${d.keyword} ${d.name}`, sortText: `0${label}` })
  }
  for (const k of ['struct', 'enum', 'map', 'set']) {
    const snip: Record<string, string> = {
      struct: 'struct {\n\t${1:Key}: ${2:u8}\n}',
      enum: 'enum { ${1:A}, ${2:B} }',
      map: 'map { [${1:string}]: ${2:u8} }',
      set: 'set { ${1:A}, ${2:B} }'
    }
    out.push({ label: k, kind: 'keyword', snippet: true, insertText: snip[k], detail: `inline ${k}`, documentation: BLINK_DOCS[k], sortText: `2${k}` })
  }
  return out
}

export function blinkCompletions(source: string, offset: number): BlinkCompletion[] {
  const ctx = blinkContext(source, offset)
  switch (ctx.kind) {
    case 'top': {
      const after = lexBlink(source.slice(0, offset - wordBefore(source, offset).length)).pop()
      if (after?.text === 'export') {
        return TOP_SNIPPETS.filter((s) => ['struct', 'enum', 'enum (tagged)', 'map', 'set', 'type'].includes(s.label))
      }
      const list = TOP_SNIPPETS.map((s) => ({ ...s, documentation: BLINK_DOCS[s.label.split(' ')[0]] }))
      // Options and imports only make sense at the top of the file, outside scopes.
      return ctx.scope.length ? list.filter((s) => s.label !== 'option' && s.label !== 'import') : list
    }
    case 'optionName':
      return BLINK_OPTIONS.map((o) => ({ label: o.name, kind: 'option', snippet: true, insertText: optionSnippet(o.name), detail: o.default ? `default ${o.default}` : o.kind, documentation: o.doc }))
    case 'optionValue': {
      const o = BLINK_OPTIONS.find((x) => x.name === ctx.option)
      if (!o) return []
      if (o.kind === 'casing') return BLINK_CASINGS.map((c) => ({ label: c, kind: 'value', insertText: c, documentation: BLINK_DOCS[c] }))
      if (o.kind === 'boolean') return ['true', 'false'].map((v) => ({ label: v, kind: 'value', insertText: v }))
      return [{ label: '"…"', kind: 'value', snippet: true, insertText: '"${1}"', detail: 'path' }]
    }
    case 'fieldKey': {
      const fields = ctx.block === 'event' ? BLINK_EVENT_FIELDS : BLINK_FUNCTION_FIELDS
      return fields
        .filter((f) => !ctx.present.includes(f.key))
        .filter((f) => !(f.key === 'Poll' && ctx.present.includes('Call')))
        .map((f, i) => ({ label: f.key, kind: 'field', snippet: true, insertText: fieldSnippet(f), detail: f.optional ? 'optional' : 'required', documentation: f.doc, sortText: `${f.optional ? 1 : 0}${i}` }))
    }
    case 'fieldValue': {
      const fields = ctx.block === 'event' ? BLINK_EVENT_FIELDS : BLINK_FUNCTION_FIELDS
      const f = fields.find((x) => x.key === ctx.field)
      return (f?.values ?? []).map((v, i) => ({ label: v, kind: 'value', insertText: v, documentation: BLINK_DOCS[v], sortText: `${i}` }))
    }
    case 'type':
      return typeCompletions(source, ctx.scope, ctx.generics)
    case 'encoding':
      return BLINK_NUMBER_TYPES.map((n) => ({ label: n, kind: 'primitive', insertText: n, documentation: BLINK_DOCS[n] }))
    case 'instanceClass':
      return BLINK_INSTANCE_CLASSES.map((c) => ({ label: c, kind: 'class', insertText: c }))
    default:
      return []
  }
}

export interface BlinkHover {
  start: number
  end: number
  markdown: string
}

// Hover docs for the word at `offset`: keywords, fields, values, primitives, options, and
// declared names (their declaration line).
export function blinkHover(source: string, offset: number): BlinkHover | null {
  const left = /[A-Za-z_][\w.]*$/.exec(source.slice(0, offset))?.[0] ?? ''
  const right = /^\w*/.exec(source.slice(offset))?.[0] ?? ''
  const word = left + right
  if (!word) return null
  const start = offset - left.length
  const end = offset + right.length
  const tokens = lexBlink(source.slice(0, start))
  const prev = tokens[tokens.length - 1]
  const next = source.slice(end).match(/^\s*(\S)/)?.[1]
  // Option names.
  if (prev?.text === 'option' && BLINK_DOCS[`option:${word}`]) return { start, end, markdown: BLINK_DOCS[`option:${word}`] }
  // Field keys (`From:`, `from:`) inside event/function bodies.
  if (next === ':') {
    const stack = frames(tokens)
    const top = stack[stack.length - 1]
    if (isEventLike(top)) {
      const key = canonicalField(word, top.kind)
      const field = (top.kind === 'event' ? BLINK_EVENT_FIELDS : BLINK_FUNCTION_FIELDS).find((f) => f.key === key)
      if (field) return { start, end, markdown: `**${field.key}**${field.values ? ` — \`${field.values.join(' | ')}\`` : ''}\n\n${field.doc}` }
    }
    return null
  }
  if (word === 'Type' || word === 'Data' || word === 'Return') return null
  const doc = BLINK_DOCS[word]
  if (doc) return { start, end, markdown: /^\*\*/.test(doc) ? doc : `**${word}** — ${doc}` }
  const decl = blinkDeclarations(source).find((d) => d.name === word || d.name.split('.').pop() === word)
  if (decl) {
    const line = source.split('\n')[decl.line - 1]?.trim() ?? ''
    return { start, end, markdown: `\`\`\`blink\n${line}\n\`\`\`\n${decl.keyword} declared on line ${decl.line}` }
  }
  return null
}
