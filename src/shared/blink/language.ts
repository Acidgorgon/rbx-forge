// Blink (github.com/1Axen/blink) language data for the editor: keywords, fields, values,
// primitives and options with short docs, the Monarch tokenizer, and the language
// configuration. Pure data (no monaco import) so it can be unit tested; the renderer
// registers it in src/renderer/src/blinkLanguage.ts.
//
// Sources (Blink 0.18.x, MIT, Copyright (c) 2024 Axen):
//   src/Settings.luau  keywords and primitives
//   src/Lexer.luau     tokens: -- / --[[ ]] comments, ' and " strings, ranges, `..` merges
//   src/Parser.luau    options and event/function fields (keys also match all-lowercase:
//                      `GetOptionFromToken` accepts `string.lower(Key) == Value`)
//   docs/pages/language/*.mdx  the hover text below is condensed from these pages
// The scopes the docs site grammar (docs/public/syntax/blink.tmLanguage.json, MIT,
// Copyright (c) 2024 VirtualButFake (Tijn Epema), checkraisefold) colours are all covered:
// keyword.control, storage.type (primitives), entity.name.type.enum (settings values),
// variable.other.readwrite (`Key:`), constant.language.boolean, keyword.operator (= : .. ?),
// numbers, strings, comments. The tokenizer here is written from scratch in Monarch and adds
// context (event/function bodies versus struct bodies, type references, declared names).

export const BLINK_KEYWORDS = ['option', 'import', 'as', 'export', 'type', 'struct', 'enum', 'map', 'set', 'event', 'function', 'scope'] as const

// Declaration keywords that introduce a type.
export const BLINK_TYPE_KEYWORDS = ['type', 'struct', 'enum', 'map', 'set'] as const

export const BLINK_NUMBER_TYPES = ['u8', 'u16', 'u32', 'i8', 'i16', 'i32', 'f16', 'f32', 'f64'] as const

export const BLINK_PRIMITIVES = [
  ...BLINK_NUMBER_TYPES,
  'boolean', 'string', 'buffer', 'vector', 'CFrame', 'Color3', 'BrickColor', 'Instance', 'DateTime', 'DateTimeMillis', 'unknown'
] as const

export interface BlinkField {
  key: string
  // Fixed values (From/Type/Call/Yield/Poll); absent for type fields (Data/Return).
  values?: readonly string[]
  optional?: boolean
  doc: string
}

export const BLINK_EVENT_FIELDS: readonly BlinkField[] = [
  { key: 'From', values: ['Server', 'Client'], doc: 'The side that fires the event: `Server` or `Client`.' },
  { key: 'Type', values: ['Reliable', 'Unreliable'], doc: 'Reliability. `Reliable` arrives in order; `Unreliable` may drop or reorder and is capped at 1000 bytes.' },
  { key: 'Call', values: ['SingleSync', 'SingleAsync', 'ManySync', 'ManyAsync', 'Polling'], doc: 'The listening API on the receiving side: one or many listeners, sync (must not yield) or async, or `Polling` (`Event.Iter()`).' },
  { key: 'Poll', values: ['true', 'false'], optional: true, doc: 'Optional. `true` also exposes a polling API (`Event.Iter()`) for this event.' },
  { key: 'Data', optional: true, doc: 'Optional. The data sent with the event: any type, or a type pack `(u8, string)`.' }
]

export const BLINK_FUNCTION_FIELDS: readonly BlinkField[] = [
  { key: 'Yield', values: ['Coroutine', 'Future', 'Promise'], doc: 'How the caller yields: the builtin `Coroutine` library, or a `Future` / `Promise` library set with the `FutureLibrary` / `PromiseLibrary` options.' },
  { key: 'Data', optional: true, doc: 'Optional. The arguments sent to the server: any type, or a type pack `(u8, string)`.' },
  { key: 'Return', optional: true, doc: 'Optional. The value returned to the client: any type, or a type pack.' }
]

export type BlinkOptionKind = 'casing' | 'boolean' | 'string'

export interface BlinkOption {
  name: string
  kind: BlinkOptionKind
  default?: string
  doc: string
}

export const BLINK_OPTIONS: readonly BlinkOption[] = [
  { name: 'Casing', kind: 'casing', default: 'Pascal', doc: 'Casing of the generated event/function methods: `Pascal`, `Camel` or `Snake`.' },
  { name: 'ServerOutput', kind: 'string', doc: 'Path of the generated server module.' },
  { name: 'ClientOutput', kind: 'string', doc: 'Path of the generated client module.' },
  { name: 'TypesOutput', kind: 'string', doc: 'Path of the generated types module.' },
  { name: 'Typescript', kind: 'boolean', default: 'false', doc: 'Also generate TypeScript `.d.ts` files next to the outputs.' },
  { name: 'UsePolling', kind: 'boolean', default: 'false', doc: 'Output every event with a polling API (`Event.Iter()`).' },
  { name: 'FutureLibrary', kind: 'string', doc: 'Path of the Future library used by `Yield: Future` functions.' },
  { name: 'PromiseLibrary', kind: 'string', doc: 'Path of the Promise library used by `Yield: Promise` functions.' },
  { name: 'SyncValidation', kind: 'boolean', default: 'true', doc: 'Check whether a sync call yielded.' },
  { name: 'WriteValidations', kind: 'boolean', default: 'false', doc: 'Check primitive types when firing/invoking. Useful in development; costs performance.' },
  { name: 'ManualReplication', kind: 'boolean', default: 'false', doc: 'Disable automatic end-of-frame replication and expose `StepReplication()` instead.' },
  { name: 'RemoteScope', kind: 'string', default: '""', doc: 'Prefix for the generated remotes, e.g. `"PACKAGE"` gives `PACKAGE_BLINK_RELIABLE_REMOTE`.' },
  { name: 'UseColon', kind: 'boolean', default: 'false', doc: 'Generate methods called with `:` instead of `.`.' }
]

export const BLINK_CASINGS = ['Pascal', 'Camel', 'Snake'] as const

// Every fixed value an event/function field or option can take.
export const BLINK_VALUES = [
  'Server', 'Client', 'Reliable', 'Unreliable', 'SingleSync', 'SingleAsync', 'ManySync', 'ManyAsync', 'Polling',
  'Coroutine', 'Future', 'Promise', ...BLINK_CASINGS
] as const

// Common classes for `Instance(Class)`.
export const BLINK_INSTANCE_CLASSES = [
  'Player', 'Model', 'BasePart', 'Part', 'MeshPart', 'Humanoid', 'Tool', 'Accessory', 'Attachment', 'Folder',
  'Sound', 'Animation', 'Camera', 'GuiObject', 'ScreenGui', 'Frame', 'TextLabel', 'ImageLabel', 'Team', 'Script',
  'ModuleScript', 'ProximityPrompt', 'ParticleEmitter', 'Beam', 'Light', 'Decal', 'Texture'
] as const

const FIELD_KEYS = [...new Set([...BLINK_EVENT_FIELDS, ...BLINK_FUNCTION_FIELDS].map((f) => f.key))]

// Short docs for hovers and completion details, condensed from docs/pages/language/*.mdx.
export const BLINK_DOCS: Record<string, string> = {
  option: '`option Name = value`. Configures Blink\'s output; options go at the top of the file.',
  import: '`import "./path" [as "Name"]`. Imports another Blink file into a scope named after the file, or `Name`.',
  as: '`import "./path" as "Name"`. Names the scope an import is placed in.',
  export: 'Prefix to a type declaration: also generates `Read(buffer)` / `Write(value)` functions for it.',
  type: '`type Name = T`. A type alias, e.g. `type Health = u8(0..100)`.',
  struct: '`struct Name { Key: T, ..Other }`. Fixed, statically named keys. `..Other` merges another struct. Supports generics `struct Name<T>`.',
  enum: 'Unit enum `enum Name = { A, B }`, or tagged enum `enum Name = "Tag" { A { ... }, B { ... } }`. Tagged enums support generics.',
  map: '`map Name = { [K]: V }`. Key/value table, size bounded with `(min..max)`. Supports generics `map Name<K, V>`.',
  set: '`set Name = { A, B }`. A map of static string keys to `true`.',
  event: '`event Name { From, Type, Call, Data }`. A remote event between client and server.',
  function: '`function Name { Yield, Data, Return }`. A remote function: the client invokes, the server returns.',
  scope: '`scope Name { ... }`. Groups declarations; they are exported as `Blink.Name.X` and typed `Name_X`.',
  u8: 'Unsigned integer, 1 byte: 0 to 255.',
  u16: 'Unsigned integer, 2 bytes: 0 to 65,535.',
  u32: 'Unsigned integer, 4 bytes: 0 to 4,294,967,295.',
  i8: 'Signed integer, 1 byte: -128 to 127.',
  i16: 'Signed integer, 2 bytes: -32,768 to 32,767.',
  i32: 'Signed integer, 4 bytes: -2,147,483,648 to 2,147,483,647.',
  f16: 'Half float, 2 bytes, exact integers to ±2048. Slower: not native to the buffer library.',
  f32: 'Float, 4 bytes, exact integers to ±16,777,216.',
  f64: 'Double, 8 bytes (Luau\'s own number type), exact integers to ±2^53.',
  boolean: '`true` or `false`.',
  string: 'Text. Bound the length with a range: `string(3..20)`.',
  buffer: 'Raw bytes you serialize yourself, still batched by Blink. Bound the length: `buffer(..900)`.',
  vector: 'A 3D vector. Bound the magnitude `vector(0..1)` or pick the encoding `vector<i16>`.',
  CFrame: 'Position and rotation. Encodings for position and rotation: `CFrame<i16, f16>`.',
  Color3: 'A Roblox Color3.',
  BrickColor: 'A Roblox BrickColor.',
  Instance: 'A Roblox Instance, narrowed by class with `Instance(Player)`. Mark it optional (`?`) if it may not exist on the receiver.',
  DateTime: 'A Roblox DateTime (second precision).',
  DateTimeMillis: 'A Roblox DateTime with millisecond precision.',
  unknown: 'Any value, serialized by Roblox. Use sparingly: it loses Blink\'s size benefits.',
  Server: 'Fired by the server, received by clients.',
  Client: 'Fired by a client, received by the server.',
  Reliable: 'Guaranteed to arrive, in the order sent.',
  Unreliable: 'May be dropped or reordered; at most 1000 bytes.',
  SingleSync: 'One listener that must not yield.',
  SingleAsync: 'One listener that may yield.',
  ManySync: 'Many listeners that must not yield.',
  ManyAsync: 'Many listeners that may yield.',
  Polling: 'No listener: iterate received events with `Event.Iter()`.',
  Coroutine: 'Yield with the builtin coroutine library.',
  Future: 'Return a Future (set `option FutureLibrary`).',
  Promise: 'Return a Promise (set `option PromiseLibrary`).',
  Pascal: 'Methods like `FireAll`.',
  Camel: 'Methods like `fireAll`.',
  Snake: 'Methods like `fire_all`.'
}
for (const f of [...BLINK_EVENT_FIELDS, ...BLINK_FUNCTION_FIELDS]) {
  // Data and Return appear in both; the event wording is the general one.
  if (!(f.key in BLINK_DOCS)) BLINK_DOCS[f.key] = `**${f.key}** — ${f.doc}`
}
// `Type` is both the event field and (lowercase) the `type` keyword; keep both.
BLINK_DOCS.Type = `**Type** — ${BLINK_EVENT_FIELDS[1].doc}`
for (const o of BLINK_OPTIONS) BLINK_DOCS[`option:${o.name}`] = `**option ${o.name}**${o.default ? ` (default \`${o.default}\`)` : ''} — ${o.doc}`

// ------------------------------------------------------------------ Monarch tokenizer
//
// Token names (the theme appends nothing; Monaco adds the `.blink` suffix):
//   keyword                 option import as export type struct enum map set event function scope
//   keyword.field           From Type Call Poll Yield Data Return inside event/function bodies
//   keyword.option          option names (Casing, ServerOutput, ...)
//   constant                Server, Reliable, SingleSync, Coroutine, Camel, true/false, ...
//   type.primitive          u8 ... f64, string, buffer, vector, CFrame, Instance, ...
//   type.ref                references to declared types (Item, Scope.Type, Instance(Class))
//   type.declaration        the name being declared (event Name, struct Name, ...)
//   variable.member         struct/map keys, set and unit enum members, tagged enum variants
//   number, string, comment, operator (= .. ?), delimiter (, :), @brackets

const IDENT = /[A-Za-z_]\w*/
const lowerAndUpper = (keys: readonly string[]) => [...keys, ...keys.map((k) => k.toLowerCase())]

// Rules every state shares: comments and strings.
const COMMON = [
  [/--\[(=*)\[/, { token: 'comment', next: '@blockComment.$1' }],
  [/--.*$/, 'comment'],
  [/"([^"\\]|\\.)*"?/, 'string'],
  [/'([^'\\]|\\.)*'?/, 'string'],
  [/\s+/, '']
]

// Type expressions: primitives, references, ranges, arrays, optionals, generics.
const TYPE_RULES = [
  [/(\.\.)([A-Za-z_][\w.]*)/, ['operator', 'type.ref']],
  [/[A-Za-z_]\w*(\.[A-Za-z_]\w*)+/, 'type.ref'],
  [IDENT, { cases: { '@typeKeywords': 'keyword', '@primitives': 'type.primitive', 'true|false': 'constant', '@default': 'type.ref' } }],
  [/-?\d*\.?\d+(?:[eE][-+]?\d+)?/, 'number'],
  [/\.\./, 'operator'],
  [/\?/, 'operator'],
  [/=/, 'operator'],
  [/\(/, { token: '@brackets', next: '@paren' }],
  [/</, { token: '@brackets', next: '@angle' }],
  [/[[\]]/, '@brackets'],
  [/\)/, '@brackets'],
  [/>/, '@brackets']
]

export const BLINK_MONARCH = {
  defaultToken: '',
  keywords: [...BLINK_KEYWORDS],
  typeKeywords: [...BLINK_TYPE_KEYWORDS],
  primitives: [...BLINK_PRIMITIVES],
  values: [...BLINK_VALUES, 'true', 'false'],
  // Field keys match in their documented casing and all-lowercase, like Blink's parser.
  eventFields: lowerAndUpper(FIELD_KEYS.filter((k) => k !== 'Data' && k !== 'Return')),
  typeFields: lowerAndUpper(['Data', 'Return']),
  options: BLINK_OPTIONS.map((o) => o.name),
  tokenizer: {
    root: [
      ...COMMON,
      [/(option)(\s+)([A-Za-z_]\w*)/, ['keyword', '', { cases: { '@options': 'keyword.option', '@default': 'identifier' } }]],
      [/(event|function)(\s+)([A-Za-z_]\w*)/, ['keyword', '', { token: 'type.declaration', next: '@eventHead' }]],
      [/(scope)(\s+)([A-Za-z_]\w*)/, ['keyword', '', { token: 'type.declaration', next: '@scopeHead' }]],
      [/(type|struct|enum|map|set)(\s+)([A-Za-z_]\w*)/, ['keyword', '', 'type.declaration']],
      [IDENT, { cases: { '@keywords': 'keyword', '@values': 'constant', '@primitives': 'type.primitive', '@default': 'type.ref' } }],
      [/\{/, { token: '@brackets', next: '@block' }],
      [/\}/, '@brackets'],
      ...TYPE_RULES,
      [/,/, 'delimiter']
    ],
    // Between `scope Name` and its `{`.
    scopeHead: [
      ...COMMON,
      [/\{/, { token: '@brackets', switchTo: '@scopeBody' }],
      [/(?=\S)/, { token: '', next: '@pop' }]
    ],
    // A scope body is the top-level grammar until its `}`.
    scopeBody: [
      [/\}/, { token: '@brackets', next: '@pop' }],
      { include: '@root' }
    ],
    // Between `event Name` / `function Name` and its `{`.
    eventHead: [
      ...COMMON,
      [/\{/, { token: '@brackets', switchTo: '@eventBody' }],
      [/(?=\S)/, { token: '', next: '@pop' }]
    ],
    eventBody: [
      ...COMMON,
      [/([A-Za-z_]\w*)(\s*)(:)/, [
        { cases: { '@eventFields': { token: 'keyword.field', next: '@value' }, '@typeFields': { token: 'keyword.field', next: '@typeExpr' }, '@default': 'identifier' } },
        '',
        'delimiter'
      ]],
      [/\}/, { token: '@brackets', next: '@pop' }],
      [/,/, 'delimiter'],
      [IDENT, 'identifier']
    ],
    // The value of From/Type/Call/Poll/Yield: up to `,` or `}`.
    value: [
      ...COMMON,
      [/,/, { token: 'delimiter', next: '@pop' }],
      [/(?=\})/, { token: '', next: '@pop' }],
      [IDENT, { cases: { '@values': 'constant', '@default': 'identifier' } }]
    ],
    // A type after `Key:` in a body: up to `,` or `}` at this nesting level.
    typeExpr: [
      ...COMMON,
      [/,/, { token: 'delimiter', next: '@pop' }],
      [/(?=\})/, { token: '', next: '@pop' }],
      [/\{/, { token: '@brackets', next: '@block' }],
      ...TYPE_RULES
    ],
    // struct / map / set / enum bodies.
    block: [
      ...COMMON,
      [/(\[)/, { token: '@brackets', next: '@mapKey' }],
      [/([A-Za-z_]\w*)(\s*)(:)/, ['variable.member', '', { token: 'delimiter', next: '@typeExpr' }]],
      [/:/, { token: 'delimiter', next: '@typeExpr' }],
      [/(\.\.)([A-Za-z_][\w.]*)/, ['operator', 'type.ref']],
      [/\{/, { token: '@brackets', next: '@block' }],
      [/\}/, { token: '@brackets', next: '@pop' }],
      [IDENT, 'variable.member'],
      [/,/, 'delimiter']
    ],
    // `[K]` in a map body.
    mapKey: [
      ...COMMON,
      [/\]/, { token: '@brackets', next: '@pop' }],
      ...TYPE_RULES
    ],
    // Inside ( ): ranges, Instance classes, type packs.
    paren: [
      ...COMMON,
      [/\)/, { token: '@brackets', next: '@pop' }],
      [/,/, 'delimiter'],
      [/\{/, { token: '@brackets', next: '@block' }],
      ...TYPE_RULES
    ],
    // Inside < >: generics and encodings.
    angle: [
      ...COMMON,
      [/>/, { token: '@brackets', next: '@pop' }],
      [/,/, 'delimiter'],
      ...TYPE_RULES
    ],
    blockComment: [
      [/\](=*)\]/, { cases: { '$1==$S2': { token: 'comment', next: '@pop' }, '@default': 'comment' } }],
      [/[^\]]+/, 'comment'],
      [/./, 'comment']
    ]
  }
}

// Language configuration (Monaco's LanguageConfiguration shape).
export const BLINK_LANGUAGE_CONFIGURATION = {
  comments: { lineComment: '--', blockComment: ['--[[', ']]'] as [string, string] },
  brackets: [['{', '}'], ['[', ']'], ['(', ')'], ['<', '>']] as [string, string][],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string', 'comment'] },
    { open: "'", close: "'", notIn: ['string', 'comment'] }
  ],
  surroundingPairs: [
    { open: '{', close: '}' }, { open: '(', close: ')' }, { open: '[', close: ']' }, { open: '<', close: '>' },
    { open: '"', close: '"' }, { open: "'", close: "'" }
  ],
  autoCloseBefore: ';:.,=}])> \n\t',
  indentationRules: { increaseIndentPattern: /^.*\{[^}"']*$/, decreaseIndentPattern: /^\s*\}/ },
  wordPattern: /-?\d*\.\d\w*|[A-Za-z_][\w]*/,
  folding: { markers: { start: /^\s*--\s*#?region\b/, end: /^\s*--\s*#?endregion\b/ } }
}
