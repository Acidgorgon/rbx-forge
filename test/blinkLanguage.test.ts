// Blink editor language: the Monarch grammar (run through a small Monarch interpreter that
// follows monaco's rules for the subset the grammar uses), context-aware completions and hovers.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BLINK_LANGUAGE_CONFIGURATION, BLINK_MONARCH, BLINK_OPTIONS, BLINK_PRIMITIVES } from '../src/shared/blink/language.ts'
import { blinkCompletions, blinkContext, blinkDeclarations, blinkHover } from '../src/shared/blink/complete.ts'

// ------------------------------------------------------------------ Monarch interpreter

type Action = string | { token?: string; next?: string; switchTo?: string; cases?: Record<string, Action> } | Action[]
type Rule = [RegExp, Action] | { include: string }

const lang = BLINK_MONARCH as unknown as Record<string, unknown> & { tokenizer: Record<string, Rule[]> }

function rulesOf(state: string): [RegExp, Action][] {
  const out: [RegExp, Action][] = []
  for (const r of lang.tokenizer[state]) {
    if (Array.isArray(r)) out.push(r as [RegExp, Action])
    else out.push(...rulesOf(r.include.replace(/^@/, '')))
  }
  return out
}

function bracketToken(text: string): string {
  return { '{': 'delimiter.curly', '}': 'delimiter.curly', '(': 'delimiter.parenthesis', ')': 'delimiter.parenthesis', '[': 'delimiter.square', ']': 'delimiter.square', '<': 'delimiter.angle', '>': 'delimiter.angle' }[text] ?? 'delimiter'
}

function resolve(action: Action, matched: string, groups: string[], stack: string[]): { token: string; next?: string; switchTo?: string } {
  if (typeof action === 'string') return { token: action === '@brackets' ? bracketToken(matched) : action }
  if (Array.isArray(action)) throw new Error('nested group action')
  if (action.cases) {
    const parts = stack[stack.length - 1].split('.')
    for (const [key, val] of Object.entries(action.cases)) {
      let hit = false
      if (key === '@default') hit = true
      else if (key.startsWith('@')) hit = (lang[key.slice(1)] as string[]).includes(matched)
      else if (/^\$1==\$S2$/.test(key)) hit = groups[1] === parts[1]
      else hit = new RegExp(`^(?:${key})$`).test(matched)
      if (hit) return resolve(val, matched, groups, stack)
    }
    throw new Error(`no case for ${matched}`)
  }
  const token = action.token === '@brackets' ? bracketToken(matched) : (action.token ?? '')
  return { token, next: action.next, switchTo: action.switchTo }
}

function applyNext(stack: string[], next: string | undefined, switchTo: string | undefined, groups: string[]): void {
  const sub = (s: string) => s.replace(/^@/, '').replace(/\$(\d)/g, (_m, n) => groups[Number(n)] ?? '')
  if (switchTo) stack[stack.length - 1] = sub(switchTo)
  if (!next) return
  if (next === '@pop') {
    if (stack.length === 1) throw new Error('pop of root')
    stack.pop()
  } else stack.push(sub(next))
}

// [text, token] pairs for every non-whitespace token of `source`.
function tokenize(source: string): [string, string][] {
  const stack = ['root']
  const out: [string, string][] = []
  for (const line of source.split('\n')) {
    let pos = 0
    let guard = 0
    while (pos < line.length) {
      if (guard++ > 10000) throw new Error(`no progress at ${line.slice(pos)}`)
      const state = stack[stack.length - 1].split('.')[0]
      let done = false
      for (const [re, action] of rulesOf(state)) {
        const m = new RegExp(`^(?:${re.source})`).exec(line.slice(pos))
        if (!m) continue
        const depth = stack.length
        const top = stack[stack.length - 1]
        if (Array.isArray(action)) {
          let at = pos
          let last: { next?: string; switchTo?: string } = {}
          action.forEach((a, i) => {
            const text = m[i + 1] ?? ''
            const r = resolve(a, text, [...m], stack)
            if (text.trim()) out.push([text, r.token])
            at += text.length
            if (r.next || r.switchTo) last = r
          })
          applyNext(stack, last.next, last.switchTo, [...m])
        } else {
          const r = resolve(action, m[0], [...m], stack)
          if (m[0].trim()) out.push([m[0], r.token])
          applyNext(stack, r.next, r.switchTo, [...m])
        }
        if (m[0].length === 0 && stack.length === depth && stack[stack.length - 1] === top) throw new Error('no progress')
        pos += m[0].length
        done = true
        break
      }
      if (!done) {
        out.push([line[pos], ''])
        pos++
      }
    }
  }
  return out
}

const tokenOf = (toks: [string, string][], text: string, nth = 0) => toks.filter(([t]) => t === text)[nth]?.[1]

const SAMPLE = `-- Network events
--[[ block
comment ]]
option ClientOutput = "src/shared/net/Client.luau"
option Casing = Camel
option UsePolling = true
import "./common" as "Common"

type Health = u8(0..100)?
export struct Item<T> {
    Id: string(36),
    Count: u16,
    Meta: T,
    Kind: HitKind,
    Owner: Instance(Player)?,
    Spot: CFrame<i16, f16>,
    ..Base
}
enum HitKind = { Head, Body }
enum Shape = "Type" {
    Ball { Radius: f32 },
    Box { Size: vector<u8> },
}
map Scores = { [string]: f64 }(1..100)
set Flags = { FeatureA, FeatureB }

event Damage {
    from: Client,
    Type: Unreliable,
    Call: ManyAsync,
    Data: (Item<u8>, Health)
}

function GetItems {
    Yield: Coroutine,
    Data: u8[1..50],
    Return: Common.Inventory
}

scope Combat {
    type Combo = u8
    event Hit {
        From: Server,
        Type: Reliable,
        Call: SingleSync,
        Data: struct { Target: Combo, Crit: boolean }
    }
}
type After = Health
`

test('grammar: keywords, fields, values, primitives, names', () => {
  const t = tokenize(SAMPLE)
  assert.equal(tokenOf(t, '-- Network events'), 'comment')
  assert.equal(tokenOf(t, '--[[', 0), 'comment')
  assert.equal(tokenOf(t, 'comment '), 'comment')
  for (const k of ['option', 'import', 'as', 'type', 'export', 'struct', 'enum', 'map', 'set', 'event', 'function', 'scope']) {
    assert.equal(tokenOf(t, k), 'keyword', k)
  }
  assert.equal(tokenOf(t, 'ClientOutput'), 'keyword.option')
  assert.equal(tokenOf(t, 'Casing'), 'keyword.option')
  assert.equal(tokenOf(t, 'Camel'), 'constant')
  assert.equal(tokenOf(t, 'true'), 'constant')
  assert.equal(tokenOf(t, '"src/shared/net/Client.luau"'), 'string')
  assert.equal(tokenOf(t, '"Common"'), 'string')
  // Declared names
  for (const n of ['Health', 'Item', 'HitKind', 'Scores', 'Flags', 'Damage', 'GetItems', 'Combat', 'Combo', 'Hit', 'After']) {
    assert.ok(t.some(([x, k]) => x === n && k === 'type.declaration'), n)
  }
  // Primitives and ranges
  for (const p of ['u8', 'string', 'u16', 'f32', 'f64', 'boolean', 'i16', 'f16', 'CFrame', 'Instance', 'vector']) {
    assert.equal(tokenOf(t, p), 'type.primitive', p)
  }
  assert.equal(tokenOf(t, '0'), 'number')
  assert.equal(tokenOf(t, '100'), 'number')
  assert.equal(tokenOf(t, '..'), 'operator')
  assert.equal(tokenOf(t, '?'), 'operator')
  // Struct members versus references
  assert.equal(tokenOf(t, 'Id'), 'variable.member')
  assert.equal(tokenOf(t, 'Meta'), 'variable.member')
  assert.equal(tokenOf(t, 'T', 1), 'type.ref')
  assert.equal(tokenOf(t, 'HitKind', 0), 'type.ref')
  assert.equal(tokenOf(t, 'Player'), 'type.ref')
  assert.equal(tokenOf(t, 'Base'), 'type.ref')
  assert.equal(tokenOf(t, 'Head'), 'variable.member')
  assert.equal(tokenOf(t, 'Ball'), 'variable.member')
  assert.equal(tokenOf(t, 'Radius'), 'variable.member')
  assert.equal(tokenOf(t, 'FeatureA'), 'variable.member')
  // Event and function fields, lowercase too (Blink accepts `from:`)
  assert.equal(tokenOf(t, 'from'), 'keyword.field')
  assert.equal(tokenOf(t, 'Type'), 'keyword.field')
  assert.equal(tokenOf(t, 'Call'), 'keyword.field')
  assert.equal(tokenOf(t, 'Data'), 'keyword.field')
  assert.equal(tokenOf(t, 'Yield'), 'keyword.field')
  assert.equal(tokenOf(t, 'Return'), 'keyword.field')
  assert.equal(tokenOf(t, 'From'), 'keyword.field')
  for (const v of ['Client', 'Unreliable', 'ManyAsync', 'Coroutine', 'Server', 'Reliable', 'SingleSync']) {
    assert.equal(tokenOf(t, v), 'constant', v)
  }
  assert.equal(tokenOf(t, 'Common.Inventory'), 'type.ref')
  // Inline struct in an event's Data, inside a scope
  assert.equal(tokenOf(t, 'Target'), 'variable.member')
  assert.equal(tokenOf(t, 'Combo', 1), 'type.ref')
  assert.equal(tokenOf(t, '{', 0), 'delimiter.curly')
})

test('grammar: state returns to the top level after every construct', () => {
  // `After` is declared after the scope closes: it would not tokenize as a declaration if a
  // state had leaked. Unbalanced input must not throw either.
  assert.doesNotThrow(() => tokenize('}\n}\nevent X {\n From: Server,\n'))
  assert.doesNotThrow(() => tokenize('event\nstruct X {\n a: u8\n'))
  const t = tokenize('event A { From: Server, Data: u8 }\nstruct B { From: u8 }')
  assert.equal(tokenOf(t, 'From', 1), 'variable.member')
})

test('language configuration: comments, brackets, indentation', () => {
  assert.equal(BLINK_LANGUAGE_CONFIGURATION.comments.lineComment, '--')
  assert.deepEqual(BLINK_LANGUAGE_CONFIGURATION.comments.blockComment, ['--[[', ']]'])
  assert.ok(BLINK_LANGUAGE_CONFIGURATION.autoClosingPairs.some((p) => p.open === '{' && p.close === '}'))
  assert.ok(BLINK_LANGUAGE_CONFIGURATION.indentationRules.increaseIndentPattern.test('event Foo {'))
  assert.ok(!BLINK_LANGUAGE_CONFIGURATION.indentationRules.increaseIndentPattern.test('struct X { a: u8 }'))
  assert.ok(BLINK_LANGUAGE_CONFIGURATION.indentationRules.decreaseIndentPattern.test('  }'))
})

// ------------------------------------------------------------------ completions

// Completions at the `|` marker.
function at(src: string) {
  const offset = src.indexOf('|')
  const text = src.slice(0, offset) + src.slice(offset + 1)
  return { text, offset, items: blinkCompletions(text, offset), ctx: blinkContext(text, offset) }
}
const labels = (src: string) => at(src).items.map((i) => i.label)

test('completions: top level suggests declarations and options', () => {
  const l = labels('|')
  for (const k of ['event', 'function', 'struct', 'enum', 'map', 'set', 'type', 'scope', 'import', 'export', 'option']) assert.ok(l.includes(k), k)
  const ev = at('ev|').items.find((i) => i.label === 'event')!
  assert.ok(ev.snippet)
  assert.match(ev.insertText, /From: \$\{2\|Server,Client\|\}/)
  assert.deepEqual(labels('type A = u8\n|'), labels('|'))
  // Inside a scope: no option/import.
  const scoped = labels('scope S {\n  |')
  assert.ok(scoped.includes('event') && !scoped.includes('option'))
  // After export: only type declarations.
  assert.deepEqual(labels('export |').sort(), ['enum', 'enum (tagged)', 'map', 'set', 'struct', 'type'].sort())
})

test('completions: options and their values', () => {
  const names = labels('option |')
  assert.deepEqual(names.sort(), BLINK_OPTIONS.map((o) => o.name).sort())
  const casing = at('option Ca|').items.find((i) => i.label === 'Casing')!
  assert.equal(casing.insertText, 'Casing = ${1|Pascal,Camel,Snake|}')
  assert.deepEqual(labels('option Casing = |'), ['Pascal', 'Camel', 'Snake'])
  assert.deepEqual(labels('option Typescript = |'), ['true', 'false'])
})

test('completions: event and function fields with snippets, minus the ones written', () => {
  const ev = at('event A {\n  |')
  assert.deepEqual(ev.items.map((i) => i.label), ['From', 'Type', 'Call', 'Poll', 'Data'])
  assert.equal(ev.items[0].insertText, 'From: ${1|Server,Client|}')
  assert.equal(ev.items[2].insertText, 'Call: ${1|SingleSync,SingleAsync,ManySync,ManyAsync,Polling|}')
  assert.deepEqual(labels('event A {\n  From: Server,\n  Type: Reliable,\n  |'), ['Call', 'Poll', 'Data'])
  assert.deepEqual(labels('event A {\n  Call: Polling,\n  |'), ['From', 'Type', 'Data'])
  assert.deepEqual(labels('event A {\n  from: Server,\n  fr|'), ['Type', 'Call', 'Poll', 'Data'])
  assert.deepEqual(labels('function F {\n  |'), ['Yield', 'Data', 'Return'])
  // A nested struct in Data is a struct body, not the event's.
  assert.deepEqual(labels('event A {\n  Data: struct {\n    |'), [])
})

test('completions: field values per field, any casing of the key', () => {
  assert.deepEqual(labels('event A {\n  From: |'), ['Server', 'Client'])
  assert.deepEqual(labels('event A {\n  from: Se|'), ['Server', 'Client'])
  assert.deepEqual(labels('event A {\n  From: Server,\n  Type: |'), ['Reliable', 'Unreliable'])
  assert.deepEqual(labels('event A { Call: |'), ['SingleSync', 'SingleAsync', 'ManySync', 'ManyAsync', 'Polling'])
  assert.deepEqual(labels('event A { Poll: |'), ['true', 'false'])
  assert.deepEqual(labels('function A { Yield: |'), ['Coroutine', 'Future', 'Promise'])
})

test('completions: type positions offer primitives and declared types', () => {
  const src = 'struct Item { a: u8 }\nenum Kind = { A, B }\nmap M = { [string]: u8 }\nscope S {\n  type Inner = u8\n}\nimport "./shared/common"\n'
  for (const pos of ['event E {\n  Data: |', 'type X = |', 'struct Y {\n  b: |', 'function F { Return: |', 'event E { Data: (u8, |', 'map Z = { [|']) {
    const l = labels(src + pos)
    for (const p of BLINK_PRIMITIVES) assert.ok(l.includes(p), `${pos}: ${p}`)
    for (const d of ['Item', 'Kind', 'M', 'S.Inner', 'common']) assert.ok(l.includes(d), `${pos}: ${d}`)
    assert.ok(!l.includes('E'), 'events are not types')
  }
  // A scope holding only events is not a type namespace.
  assert.ok(!labels('scope Net { event E { From: Server } }\ntype X = |').includes('Net'))
  assert.ok(labels('scope Net { type T = u8 }\ntype X = |').includes('Net'))
  // Inside the scope its own declarations are unqualified.
  assert.ok(labels('scope S {\n  type Inner = u8\n  type X = |').includes('Inner'))
  // Generic parameters of the declaration being written.
  assert.ok(labels('struct Box<T, U> {\n  v: |').includes('T'))
  assert.ok(labels('struct Box<T, U> {\n  v: |').includes('U'))
})

test('completions: encodings, instance classes, and quiet spots', () => {
  assert.deepEqual(labels('type V = vector<|'), ['u8', 'u16', 'u32', 'i8', 'i16', 'i32', 'f16', 'f32', 'f64'])
  assert.ok(labels('type C = CFrame<i16, |').includes('f16'))
  assert.ok(labels('type P = Instance(|').includes('Player'))
  assert.deepEqual(labels('type H = u8(|'), [])
  assert.deepEqual(labels('-- event |'), [])
  assert.deepEqual(labels('option ServerOutput = "src/|'), [])
  assert.deepEqual(labels('event |'), [])
  assert.deepEqual(labels('struct S {\n  |'), [])
})

test('declarations: qualified by scope, imports by name', () => {
  const d = blinkDeclarations('type A = u8\nscope S {\n  struct B { x: u8 }\n  scope T { type C = u8 }\n}\nevent E { From: Server }\nimport "./x/common" as "Shared"\n')
  assert.deepEqual(d.map((x) => `${x.keyword} ${x.name}:${x.line}`), ['type A:1', 'scope S:2', 'struct S.B:3', 'scope S.T:4', 'type S.T.C:4', 'event E:6', 'import Shared:7'])
})

// ------------------------------------------------------------------ hovers

function hover(src: string) {
  const offset = src.indexOf('|')
  return blinkHover(src.slice(0, offset) + src.slice(offset + 1), offset)
}

test('hover: keywords, fields, values, primitives, options, declared names', () => {
  assert.match(hover('ev|ent A {}')!.markdown, /remote event/)
  assert.match(hover('event A {\n  Fr|om: Server\n}')!.markdown, /\*\*From\*\* — `Server \| Client`/)
  assert.match(hover('event A {\n  fr|om: Server\n}')!.markdown, /\*\*From\*\*/)
  assert.match(hover('event A {\n  Type: Unrel|iable\n}')!.markdown, /1000 bytes/)
  assert.match(hover('event A {\n  Ty|pe: Reliable\n}')!.markdown, /Reliability/)
  assert.match(hover('function A {\n  Yi|eld: Future\n}')!.markdown, /Coroutine/)
  assert.match(hover('type X = u1|6')!.markdown, /65,535/)
  assert.match(hover('option Cas|ing = Camel')!.markdown, /default `Pascal`/)
  assert.match(hover('struct Item { a: u8 }\nevent A { Data: It|em }')!.markdown, /struct Item \{ a: u8 \}/)
  assert.equal(hover('struct S { na|me: u8 }'), null)
  const h = hover('type X = u1|6')!
  assert.deepEqual([h.start, h.end], [9, 12])
})
