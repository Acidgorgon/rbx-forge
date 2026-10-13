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
