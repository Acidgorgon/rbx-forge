// LSP <-> Monaco conversions. Pure functions (Monaco enums are passed in), so node tests can
// cover them. LSP positions are 0-based; Monaco lines and columns are 1-based. Both count
// columns in UTF-16 code units.

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface MonacoRange {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export interface MonacoPosition {
  lineNumber: number
  column: number
}

export function toLspPosition(position: MonacoPosition): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 }
}

export function toMonacoPosition(position: LspPosition): MonacoPosition {
  return { lineNumber: position.line + 1, column: position.character + 1 }
}

export function toLspRange(range: MonacoRange): LspRange {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
  }
}

export function toMonacoRange(range: LspRange): MonacoRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1
  }
}

// LSP CompletionItemKind (1-based) by name; looked up in Monaco's own enum.
const COMPLETION_KINDS = [
  '', 'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module',
  'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder',
  'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'
]

export function toMonacoCompletionKind(kind: number | undefined, monacoKinds: Record<string, number | string>): number {
  const name = (kind && COMPLETION_KINDS[kind]) || 'Text'
  const value = monacoKinds[name]
  return typeof value === 'number' ? value : (monacoKinds.Text as number)
}

// LSP DiagnosticSeverity 1 Error, 2 Warning, 3 Information, 4 Hint -> Monaco MarkerSeverity.
export const MarkerSeverity = { Hint: 1, Info: 2, Warning: 4, Error: 8 } as const

export function toMarkerSeverity(severity: number | undefined): number {
  switch (severity) {
    case 2:
      return MarkerSeverity.Warning
    case 3:
      return MarkerSeverity.Info
    case 4:
      return MarkerSeverity.Hint
    default:
      return MarkerSeverity.Error
  }
}

export type MarkupContent = { kind: 'markdown' | 'plaintext'; value: string }
export type MarkedString = string | { language: string; value: string }

// Hover / completion / signature documentation -> Monaco IMarkdownString.
export function toMarkdown(content: MarkupContent | MarkedString | MarkedString[] | undefined | null): { value: string }[] {
  if (content === undefined || content === null) return []
  if (Array.isArray(content)) return content.flatMap((item) => toMarkdown(item))
  if (typeof content === 'string') return content ? [{ value: content }] : []
  if ('kind' in content) {
    if (!content.value) return []
    return [{ value: content.kind === 'plaintext' ? escapeMarkdown(content.value) : content.value }]
  }
  return [{ value: '```' + content.language + '\n' + content.value + '\n```' }]
}

export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&')
}

export function documentation(content: string | MarkupContent | undefined): string | { value: string } | undefined {
  if (content === undefined) return undefined
  if (typeof content === 'string') return content
  return content.kind === 'markdown' ? { value: content.value } : content.value
}

// Normalises a file URI for comparison: decoded, forward slashes, lower-case drive letter.
export function normaliseUri(uri: string): string {
  let out = uri
  try {
    out = decodeURIComponent(uri)
  } catch {
    // keep as is
  }
  out = out.replace(/\\/g, '/')
  return out.replace(/^file:\/\/\/([A-Za-z]):/, (_, drive: string) => `file:///${drive.toLowerCase()}:`)
}

// file: URI for an absolute path (posix or Windows), matching Node's pathToFileURL closely.
export function fileUri(path: string): string {
  let p = path.replace(/\\/g, '/')
  if (/^[A-Za-z]:/.test(p)) p = '/' + p
  const encoded = p
    .split('/')
    .map((segment, index) => (index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/')
  return 'file://' + encoded
}

// Repo-relative path for a URI under rootUri, or null.
export function relativePath(rootUri: string, uri: string): string | null {
  const root = normaliseUri(rootUri).replace(/\/+$/, '') + '/'
  const target = normaliseUri(uri)
  const windows = /^file:\/\/\/[a-z]:/.test(root)
  const matches = windows ? target.toLowerCase().startsWith(root.toLowerCase()) : target.startsWith(root)
  return matches ? target.slice(root.length) : null
}

// --- Edits

export interface LspTextEdit {
  range: LspRange
  newText: string
}

// LSP WorkspaceEdit -> text edits by document URI (in server order). Handles `changes` and
// `documentChanges` text edits; create/rename/delete file operations are reported back in
// `unsupported` (luau-lsp does not send them).
export function workspaceEditByUri(edit: any): { byUri: Map<string, LspTextEdit[]>; unsupported: number } {
  const byUri = new Map<string, LspTextEdit[]>()
  let unsupported = 0
  const add = (uri: string, edits: LspTextEdit[]) => {
    const list = byUri.get(uri) ?? []
    list.push(...edits)
    byUri.set(uri, list)
  }
  if (!edit || typeof edit !== 'object') return { byUri, unsupported }
  if (Array.isArray(edit.documentChanges)) {
    for (const change of edit.documentChanges) {
      if (change && change.textDocument && Array.isArray(change.edits)) add(change.textDocument.uri, change.edits)
      else unsupported++
    }
  } else if (edit.changes && typeof edit.changes === 'object') {
    for (const [uri, edits] of Object.entries(edit.changes)) if (Array.isArray(edits)) add(uri, edits as LspTextEdit[])
  }
  return { byUri, unsupported }
}

function offsetAt(text: string, lineStarts: number[], position: LspPosition): number {
  if (position.line >= lineStarts.length) return text.length
  const start = lineStarts[position.line]
  const next = position.line + 1 < lineStarts.length ? lineStarts[position.line + 1] : text.length
  // Clamp to the line, before its line break.
  let end = next
  if (end > start && text[end - 1] === '\n') end--
  if (end > start && text[end - 1] === '\r') end--
  return Math.min(start + Math.max(0, position.character), end)
}

// Applies LSP text edits (all against the original text, non-overlapping) to a string.
export function applyTextEdits(text: string, edits: LspTextEdit[]): string {
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1)
  const resolved = edits
    .map((edit, index) => ({ start: offsetAt(text, lineStarts, edit.range.start), end: offsetAt(text, lineStarts, edit.range.end), text: edit.newText, index }))
    .sort((a, b) => b.start - a.start || b.index - a.index)
  let out = text
  for (const edit of resolved) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  return out
}

// --- Symbols, highlights, folding

// LSP SymbolKind is 1-based (File = 1); Monaco's languages.SymbolKind is the same list 0-based.
export function toMonacoSymbolKind(kind: number | undefined): number {
  return typeof kind === 'number' && kind >= 1 && kind <= 26 ? kind - 1 : 12 // Variable
}

// LSP DocumentHighlightKind 1 Text, 2 Read, 3 Write -> Monaco 0, 1, 2.
export function toMonacoHighlightKind(kind: number | undefined): number {
  return kind === 2 ? 1 : kind === 3 ? 2 : 0
}

export interface DecodedSemanticToken {
  line: number
  character: number
  length: number
  type: string
  modifiers: string[]
}

// Relative-encoded LSP semantic token data -> absolute tokens (for tests and debugging; Monaco
// takes the encoded data as is).
export function decodeSemanticTokens(data: ArrayLike<number>, legend: { tokenTypes: string[]; tokenModifiers: string[] }): DecodedSemanticToken[] {
  const out: DecodedSemanticToken[] = []
  let line = 0
  let character = 0
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i]
    line += deltaLine
    character = deltaLine === 0 ? character + data[i + 1] : data[i + 1]
    const modifiers: string[] = []
    for (let bit = 0, set = data[i + 4]; set > 0 && bit < legend.tokenModifiers.length; bit++, set >>= 1) {
      if (set & 1) modifiers.push(legend.tokenModifiers[bit])
    }
    out.push({ line, character, length: data[i + 2], type: legend.tokenTypes[data[i + 3]] ?? String(data[i + 3]), modifiers })
  }
  return out
}
