// Luau language features for Monaco, backed by luau-lsp running in the main process
// (src/main/services/lspBridge.ts, reached through window.harness.lspStart / lspSend and the
// 'lsp:message' event).
//
// Integration: call once, after Monaco is loaded (e.g. in the editor's onMount):
//
//   import { startLuauLsp } from '../lsp'
//   startLuauLsp(monaco, { openPath: (path, position) => openTabAndReveal(path, position) })
//
// Every Monaco model whose language is 'luau' is synced to the server. Models are mapped to
// files by their repo-relative path (model.uri.path without the leading '/', which is what
// @monaco-editor/react's `path={file.path}` produces); pass `modelPath` / `toUri` / `rootUri`
// to change that. When lspStart() returns false (no project, luau-lsp missing, browser
// preview mock) the client stays idle, and comes up by itself when the bridge later reports
// a server (harness/lspRestarted, e.g. after a project is opened or the server restarted).
// stopLuauLsp() removes the providers, markers and listeners.
//
// Provides, each only when the server advertises it (luau-lsp 1.70 capabilities in
// src/LanguageServer.cpp getServerCapabilities):
//   completion (snippets, auto-import additionalTextEdits, string-require paths; resolve if
//   advertised), hover, signature help, go to definition / type definition, references,
//   rename, document symbols (outline, Ctrl+Shift+O), document highlights, code actions
//   (quick fixes, organise/add requires, extract/inline refactors with codeAction/resolve),
//   document links (require paths), folding ranges, Color3 colour decorators, inlay hints
//   (variable/parameter types, return types, parameter names), semantic tokens, formatting,
//   and diagnostics as model markers.
// Not mapped: call hierarchy and workspace symbols (no standalone Monaco API), on-type
// formatting (luau-lsp's only use is format.convertQuotes, off by default).
//
// Edits for files that have no Monaco model (rename across the project, code actions, the
// server's workspace/applyEdit) are written to disk through options.applyFileEdits (default:
// window.harness.readFile / writeFile); the bridge's file watcher tells the server.

import type * as Monaco from 'monaco-editor'
import { Connection, ResponseError, ErrorCodes, type CancelToken, type Transport } from './connection.ts'
import {
  applyTextEdits,
  documentation,
  fileUri,
  normaliseUri,
  relativePath,
  toLspPosition,
  toLspRange,
  toMarkdown,
  toMarkerSeverity,
  toMonacoCompletionKind,
  toMonacoRange,
  toMonacoHighlightKind,
  toMonacoSymbolKind,
  workspaceEditByUri,
  type LspRange,
  type LspTextEdit
} from './convert.ts'
export { semanticTokenRules } from './semanticTheme.ts'

type MonacoApi = typeof Monaco
type Model = Monaco.editor.ITextModel
type Position = { lineNumber: number; column: number }

export interface LuauLspOptions {
  // Opens a repo-relative file in the editor, optionally revealing a position (1-based).
  openPath?: (path: string, position?: Position) => void
  // Workspace root as a file: URI. Default: from the bridge, else from getProject().
  rootUri?: string
  // Repo-relative path -> LSP document URI. Default: rootUri + '/' + path.
  toUri?: (path: string) => string
  // Monaco model -> repo-relative path, or null to leave the model out.
  modelPath?: (model: Model) => string | null
  // Merged over the default luau-lsp settings returned for workspace/configuration.
  settings?: Record<string, unknown>
  // Server state, e.g. for a status bar.
  onStatus?: (state: 'starting' | 'ready' | 'stopped', detail?: string) => void
  // Defaults to window.harness.
  transport?: Transport & { start(): Promise<boolean> }
  // Applies server edits to a repo-relative file that has no Monaco model. Defaults to
  // window.harness.readFile + writeFile.
  applyFileEdits?: (path: string, edits: LspTextEdit[]) => Promise<void>
  // Turns on 'semanticHighlighting.enabled' for every editor when the server has semantic
  // tokens (default true). The theme needs semanticTokenRules() for colours.
  semanticHighlighting?: boolean
}

const MARKER_OWNER = 'luau-lsp'
const APPLY_EDIT_COMMAND = 'luau-lsp.forge.applyWorkspaceEdit'

function overlaps(a: LspRange | undefined, b: LspRange): boolean {
  if (!a) return false
  const before = (p: { line: number; character: number }, q: { line: number; character: number }) =>
    p.line < q.line || (p.line === q.line && p.character < q.character)
  return !before(a.end, b.start) && !before(b.end, a.start)
}

// Edits a repo-relative file through window.harness (main process, confined to the project).
function defaultApplyFileEdits(): ((path: string, edits: LspTextEdit[]) => Promise<void>) | null {
  const harness = (globalThis as { harness?: Window['harness'] }).harness
  if (!harness || typeof harness.readFile !== 'function' || typeof harness.writeFile !== 'function') return null
  return async (path, edits) => {
    const text = await harness.readFile(path)
    await harness.writeFile(path, applyTextEdits(text, edits))
  }
}

// Settings for workspace/configuration, section "luau-lsp" (see luau-lsp ClientConfiguration.hpp).
export function defaultSettings(): Record<string, unknown> {
  return {
    platform: { type: 'roblox' },
    sourcemap: {
      enabled: true,
      // The dev loop already runs `rojo sourcemap --watch`; the server never generates it itself.
      autogenerate: false,
      rojoProjectFile: 'default.project.json',
      sourcemapFile: 'sourcemap.json',
      includeNonScripts: true
    },
    types: { roblox: true },
    diagnostics: { includeDependents: true, workspace: false, strictDatamodelTypes: false },
    // Same as the VS Code extension's defaults (editors/code/package.json), which is what it
    // sends: auto-imports of services and requires, call arguments filled in as snippets.
    completion: {
      enabled: true,
      // Needs workspace/applyEdit plus a cursor move ($/command) the extension implements.
      autocompleteEnd: false,
      addParentheses: true,
      addTabstopAfterParentheses: true,
      fillCallArguments: true,
      showPropertiesOnMethodCall: false,
      showKeywords: true,
      showDeprecatedItems: true,
      enableFragmentAutocomplete: true,
      anonymousAutofilledFunction: { enabled: true, addTypeAnnotations: true, addTabstopForParameters: true },
      imports: {
        enabled: true,
        suggestServices: true,
        includedServices: [],
        excludedServices: [],
        suggestRequires: true,
        // auto | alwaysRelative | alwaysAbsolute | nearestAbsolute (1.70+)
        requireStyle: 'auto',
        stringRequires: { enabled: false },
        separateGroupsWithLine: false,
        ignoreGlobs: ['**/_Index/**']
      }
    },
    hover: { enabled: true, showTableKinds: false, multilineFunctionDefinitions: false, strictDatamodelTypes: true, includeStringLength: true },
    signatureHelp: { enabled: true },
    // The extension ships these off; Forge shows them (Monaco inlay hints, insertable on double-click).
    inlayHints: {
      parameterNames: 'literals',
      variableTypes: true,
      parameterTypes: true,
      functionReturnTypes: true,
      hideHintsForErrorTypes: true,
      hideHintsForMatchingParameterNames: true,
      typeHintMaxLength: 50,
      makeInsertable: true
    },
    index: { enabled: true, maxFiles: 10000 },
    format: { convertQuotes: false },
    ignoreGlobs: ['**/_Index/**']
  }
}

function merge(base: Record<string, unknown>, extra: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!extra) return base
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key]
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)
        ? merge(current as Record<string, unknown>, value as Record<string, unknown>)
        : value
  }
  return out
}

export const CLIENT_CAPABILITIES = {
  workspace: {
    configuration: true,
    workspaceFolders: true,
    applyEdit: true,
    workspaceEdit: { documentChanges: true },
    // The main-process bridge watches the project and sends workspace/didChangeWatchedFiles.
    didChangeWatchedFiles: { dynamicRegistration: true },
    // luau-lsp asks for an inlay hint refresh when the inlayHints settings change.
    inlayHint: { refreshSupport: true },
    semanticTokens: { refreshSupport: true }
  },
  textDocument: {
    synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: false },
    completion: {
      dynamicRegistration: false,
      contextSupport: true,
      completionItem: {
        snippetSupport: true,
        commitCharactersSupport: true,
        documentationFormat: ['markdown', 'plaintext'],
        deprecatedSupport: true,
        preselectSupport: true,
        tagSupport: { valueSet: [1] },
        insertReplaceSupport: true,
        labelDetailsSupport: true,
        resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] }
      },
      completionItemKind: { valueSet: Array.from({ length: 25 }, (_, i) => i + 1) }
    },
    hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
    signatureHelp: {
      dynamicRegistration: false,
      contextSupport: true,
      signatureInformation: {
        documentationFormat: ['markdown', 'plaintext'],
        parameterInformation: { labelOffsetSupport: true },
        activeParameterSupport: true
      }
    },
    definition: { dynamicRegistration: false, linkSupport: true },
    typeDefinition: { dynamicRegistration: false, linkSupport: true },
    references: { dynamicRegistration: false },
    documentHighlight: { dynamicRegistration: false },
    documentSymbol: {
      dynamicRegistration: false,
      hierarchicalDocumentSymbolSupport: true,
      symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
      tagSupport: { valueSet: [1] }
    },
    rename: { dynamicRegistration: false, prepareSupport: true },
    codeAction: {
      dynamicRegistration: false,
      isPreferredSupport: true,
      disabledSupport: true,
      dataSupport: true,
      resolveSupport: { properties: ['edit', 'command'] },
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports']
        }
      }
    },
    documentLink: { dynamicRegistration: false, tooltipSupport: true },
    // Monaco folds whole lines; luau-lsp then ends ranges on the line before `end`.
    foldingRange: { dynamicRegistration: false, lineFoldingOnly: true },
    colorProvider: { dynamicRegistration: false },
    inlayHint: { dynamicRegistration: false },
    semanticTokens: {
      dynamicRegistration: false,
      requests: { full: true },
      tokenTypes: [
        'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter', 'variable', 'property',
        'enumMember', 'event', 'function', 'method', 'macro', 'keyword', 'modifier', 'comment', 'string', 'number',
        'regexp', 'operator', 'decorator'
      ],
      tokenModifiers: [
        'declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async', 'modification',
        'documentation', 'defaultLibrary'
      ],
      formats: ['relative'],
      overlappingTokenSupport: false,
      multilineTokenSupport: false
    },
    formatting: { dynamicRegistration: false },
    rangeFormatting: { dynamicRegistration: false },
    // No `diagnostic` (pull) capability: luau-lsp then pushes textDocument/publishDiagnostics.
    publishDiagnostics: { relatedInformation: true, versionSupport: true, tagSupport: { valueSet: [1, 2] } }
  },
  window: { workDoneProgress: true, showMessage: { messageActionItem: { additionalPropertiesSupport: false } } },
  general: { positionEncodings: ['utf-16'] }
}

function harnessTransport(): (Transport & { start(): Promise<boolean> }) | null {
  const harness = (globalThis as { harness?: Window['harness'] }).harness
  if (!harness || typeof harness.lspStart !== 'function' || typeof harness.lspSend !== 'function') return null
  return {
    start: () => harness.lspStart(),
    send: (message) => void harness.lspSend(message),
    listen: (handler) => harness.on('lsp:message', handler)
  }
}

interface OpenDoc {
  model: Model
  uri: string
  path: string
  // Last published LSP diagnostics, sent back as codeAction context.
  diagnostics: any[]
}

// Minimal event emitter (monaco.Emitter is not in every test fake).
function emitter(monaco: MonacoApi): { event: Monaco.IEvent<void>; fire(): void; dispose(): void } {
  const Ctor = (monaco as { Emitter?: new () => Monaco.Emitter<void> }).Emitter
  if (Ctor) {
    const e = new Ctor()
    return { event: e.event, fire: () => e.fire(), dispose: () => e.dispose() }
  }
  const listeners = new Set<() => void>()
  return {
    event: (listener: () => void) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    fire: () => listeners.forEach((l) => l()),
    dispose: () => listeners.clear()
  }
}

class LuauLspClient {
  private monaco: MonacoApi
  private options: LuauLspOptions
  private transport: Transport & { start(): Promise<boolean> }
  private connection: Connection
  private disposables: Monaco.IDisposable[] = []
  private providers: Monaco.IDisposable[] = []
  private modelListeners = new Map<string, Monaco.IDisposable>()
  private docs = new Map<string, OpenDoc>() // by model uri
  private byLspUri = new Map<string, OpenDoc>() // by normalised LSP uri
  private capabilities: any = null
  private ready = false
  private rootUri: string | null = null
  private bootSeq = 0
  private disposed = false
  private inlayHintsChanged: ReturnType<typeof emitter>
  private semanticTokensChanged: ReturnType<typeof emitter>

  constructor(monaco: MonacoApi, options: LuauLspOptions, transport: Transport & { start(): Promise<boolean> }) {
    this.monaco = monaco
    this.options = options
    this.transport = transport
    this.connection = new Connection(transport)
    this.inlayHintsChanged = emitter(monaco)
    this.semanticTokensChanged = emitter(monaco)
    this.registerServerHandlers()
    this.watchModels()
    this.registerOpener()
    this.registerCommands()
  }

  // --- lifecycle

  async start(): Promise<void> {
    const seq = ++this.bootSeq
    this.options.onStatus?.('starting')
    let ok = false
    try {
      ok = await this.transport.start()
    } catch {
      ok = false
    }
    if (seq !== this.bootSeq || this.disposed) return
    if (!ok) {
      this.options.onStatus?.('stopped', 'luau-lsp is not running')
      return
    }
    await this.initialize(seq, undefined)
  }

  private async resolveRootUri(fromBridge: string | undefined): Promise<string | null> {
    if (fromBridge) return fromBridge
    if (this.options.rootUri) return this.options.rootUri
    const harness = (globalThis as { harness?: Window['harness'] }).harness
    const project = harness ? await harness.getProject().catch(() => null) : null
    return project ? fileUri(project.root) : null
  }

  private async initialize(seq: number, rootFromBridge: string | undefined): Promise<void> {
    this.resetServerState()
    const rootUri = await this.resolveRootUri(rootFromBridge)
    if (seq !== this.bootSeq || this.disposed) return
    if (!rootUri) {
      this.options.onStatus?.('stopped', 'no project open')
      return
    }
    this.rootUri = rootUri
    const name = decodeURIComponent(rootUri.replace(/\/+$/, '').split('/').pop() || 'project')
    try {
      const result = await this.connection.request('initialize', {
        processId: null,
        clientInfo: { name: 'RBX Forge' },
        locale: 'en',
        rootUri,
        workspaceFolders: [{ uri: rootUri, name }],
        capabilities: CLIENT_CAPABILITIES,
        trace: 'off'
      })
      if (seq !== this.bootSeq || this.disposed) return
      this.capabilities = result?.capabilities ?? {}
      this.connection.notify('initialized', {})
      this.ready = true
      this.registerProviders()
      for (const model of this.monaco.editor.getModels()) this.openModel(model)
      this.options.onStatus?.('ready', result?.serverInfo?.version ? `luau-lsp ${result.serverInfo.version}` : 'luau-lsp')
    } catch (error) {
      if (seq !== this.bootSeq) return
      this.options.onStatus?.('stopped', `initialize failed: ${error instanceof Error ? error.message : error}`)
    }
  }

  private resetServerState(): void {
    this.ready = false
    this.connection.rejectPending('server restarted')
    for (const doc of this.docs.values()) this.monaco.editor.setModelMarkers(doc.model, MARKER_OWNER, [])
    this.docs.clear()
    this.byLspUri.clear()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.bootSeq++
    if (this.ready) {
      for (const doc of this.docs.values()) this.connection.notify('textDocument/didClose', { textDocument: { uri: doc.uri } })
    }
    this.resetServerState()
    for (const d of [...this.disposables, ...this.providers, ...this.modelListeners.values()]) d.dispose()
    this.inlayHintsChanged.dispose()
    this.semanticTokensChanged.dispose()
    this.disposables = []
    this.providers = []
    this.modelListeners.clear()
    this.connection.dispose()
  }

  // --- server -> client

  private registerServerHandlers(): void {
    const c = this.connection
    c.onRequest('workspace/configuration', (params: { items?: { section?: string }[] }) =>
      (params?.items ?? []).map((item) => {
        if (!item.section || item.section === 'luau-lsp') return merge(defaultSettings(), this.options.settings)
        if (item.section.startsWith('luau-lsp.')) {
          let value: unknown = merge(defaultSettings(), this.options.settings)
          for (const key of item.section.slice('luau-lsp.'.length).split('.')) {
            value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
          }
          return value ?? null
        }
        return null
      })
    )
    c.onRequest('workspace/workspaceFolders', () =>
      this.rootUri ? [{ uri: this.rootUri, name: decodeURIComponent(this.rootUri.split('/').pop() || 'project') }] : null
    )
    c.onRequest('window/workDoneProgress/create', () => null)
    c.onRequest('client/registerCapability', () => null)
    c.onRequest('client/unregisterCapability', () => null)
    c.onRequest('window/showMessageRequest', () => null)
    c.onRequest('window/showDocument', () => ({ success: false }))
    c.onRequest('workspace/applyEdit', async (params: { edit?: unknown }) => this.applyWorkspaceEdit(params?.edit))
    c.onRequest('workspace/semanticTokens/refresh', () => (this.semanticTokensChanged.fire(), null))
    c.onRequest('workspace/inlayHint/refresh', () => (this.inlayHintsChanged.fire(), null))
    c.onRequest('workspace/diagnostic/refresh', () => null)
    c.onRequest('workspace/codeLens/refresh', () => null)
    c.onUnhandledRequest((method) => {
      throw new ResponseError(ErrorCodes.MethodNotFound, `Unhandled method ${method}`)
    })

    c.onNotification('textDocument/publishDiagnostics', (params) => this.publishDiagnostics(params))
    c.onNotification('window/showMessage', (params: { type: number; message: string }) => {
      if (params?.type === 1) console.warn('[luau-lsp]', params.message)
    })
    c.onNotification('window/logMessage', () => undefined)
    c.onNotification('$/progress', () => undefined)
    c.onNotification('telemetry/event', () => undefined)
    // VS Code-extension-only cursor moves after autocompleteEnd (off here).
    c.onNotification('$/command', () => undefined)
    c.onNotification('harness/lspRestarted', (params: { rootUri?: string }) => {
      if (this.disposed) return
      const seq = ++this.bootSeq
      this.options.onStatus?.('starting')
      void this.initialize(seq, params?.rootUri ?? undefined)
    })
    c.onNotification('harness/lspStopped', (params: { reason?: string }) => {
      if (this.disposed) return
      this.bootSeq++
      this.resetServerState()
      this.options.onStatus?.('stopped', params?.reason)
    })
  }

  private publishDiagnostics(params: { uri: string; version?: number; diagnostics: any[] }): void {
    const doc = this.byLspUri.get(normaliseUri(params?.uri ?? ''))
    if (!doc || doc.model.isDisposed()) return
    if (typeof params.version === 'number' && params.version !== doc.model.getVersionId()) {
      // Stale result for an older text; a newer publish follows the latest didChange.
      if (params.version < doc.model.getVersionId()) return
    }
    const markers = (params.diagnostics ?? []).map((d: any): Monaco.editor.IMarkerData => {
      const range = toMonacoRange(d.range)
      const tags: Monaco.MarkerTag[] = []
      for (const tag of d.tags ?? []) {
        if (tag === 1) tags.push(this.monaco.MarkerTag.Unnecessary)
        if (tag === 2) tags.push(this.monaco.MarkerTag.Deprecated)
      }
      return {
        ...range,
        severity: toMarkerSeverity(d.severity) as Monaco.MarkerSeverity,
        message: d.message,
        source: d.source,
        code: d.code === undefined ? undefined : d.codeDescription?.href
          ? { value: String(d.code), target: this.monaco.Uri.parse(d.codeDescription.href) }
          : String(d.code),
        tags: tags.length ? tags : undefined,
        relatedInformation: (d.relatedInformation ?? []).map((info: any) => ({
          resource: this.monacoUri(info.location.uri),
          message: info.message,
          ...toMonacoRange(info.location.range)
        }))
      }
    })
    doc.diagnostics = params.diagnostics ?? []
    this.monaco.editor.setModelMarkers(doc.model, MARKER_OWNER, markers)
  }

  // --- document sync

  private pathOf(model: Model): string | null {
    if (this.options.modelPath) return this.options.modelPath(model)
    if (model.uri.scheme !== 'file' && model.uri.scheme !== 'inmemory') return null
    const path = model.uri.path.replace(/^\/+/, '')
    return path || null
  }

  private lspUriOf(path: string): string {
    if (this.options.toUri) return this.options.toUri(path)
    const root = (this.rootUri ?? '').replace(/\/+$/, '')
    return root + '/' + path.split('/').map(encodeURIComponent).join('/')
  }

  private watchModels(): void {
    const editor = this.monaco.editor
    this.disposables.push(
      editor.onDidCreateModel((model) => this.trackModel(model)),
      editor.onWillDisposeModel((model) => this.untrackModel(model)),
      editor.onDidChangeModelLanguage(({ model }) => {
        if (model.getLanguageId() === 'luau') this.openModel(model)
        else this.closeModel(model)
      })
    )
    for (const model of editor.getModels()) this.trackModel(model)
  }

  private trackModel(model: Model): void {
    const key = model.uri.toString()
    if (!this.modelListeners.has(key)) {
      this.modelListeners.set(key, model.onDidChangeContent((event) => this.changeModel(model, event)))
    }
    this.openModel(model)
  }

  private untrackModel(model: Model): void {
    const key = model.uri.toString()
    this.closeModel(model)
    this.modelListeners.get(key)?.dispose()
    this.modelListeners.delete(key)
  }

  private openModel(model: Model): void {
    if (!this.ready || model.isDisposed() || model.getLanguageId() !== 'luau') return
    const key = model.uri.toString()
    if (this.docs.has(key)) return
    const path = this.pathOf(model)
    if (!path) return
    const doc: OpenDoc = { model, path, uri: this.lspUriOf(path), diagnostics: [] }
    this.docs.set(key, doc)
    this.byLspUri.set(normaliseUri(doc.uri), doc)
    this.connection.notify('textDocument/didOpen', {
      textDocument: { uri: doc.uri, languageId: 'luau', version: model.getVersionId(), text: model.getValue() }
    })
  }

  private closeModel(model: Model): void {
    const key = model.uri.toString()
    const doc = this.docs.get(key)
    if (!doc) return
    this.docs.delete(key)
    this.byLspUri.delete(normaliseUri(doc.uri))
    if (!model.isDisposed()) this.monaco.editor.setModelMarkers(model, MARKER_OWNER, [])
    if (this.ready) this.connection.notify('textDocument/didClose', { textDocument: { uri: doc.uri } })
  }

  private changeModel(model: Model, event: Monaco.editor.IModelContentChangedEvent): void {
    const doc = this.docs.get(model.uri.toString())
    if (!doc || !this.ready) return
    const sync = this.capabilities?.textDocumentSync
    const kind = typeof sync === 'number' ? sync : sync?.change ?? 1
    // Incremental (2): Monaco's change list applies in order, like VS Code's. Otherwise full text.
    const contentChanges =
      kind === 2 && !event.isFlush
        ? event.changes.map((change) => ({ range: toLspRange(change.range), text: change.text }))
        : [{ text: model.getValue() }]
    this.connection.notify('textDocument/didChange', {
      textDocument: { uri: doc.uri, version: model.getVersionId() },
      contentChanges
    })
  }

  // --- Monaco providers

  private docFor(model: Model): OpenDoc | null {
    if (!this.ready) return null
    return this.docs.get(model.uri.toString()) ?? null
  }

  private async request<T>(method: string, params: unknown, token: Monaco.CancellationToken): Promise<T | null> {
    try {
      return await this.connection.request<T>(method, params, token as unknown as CancelToken)
    } catch (error) {
      if (error instanceof ResponseError) return null
      throw error
    }
  }

  private monacoUri(lspUri: string): Monaco.Uri {
    const doc = this.byLspUri.get(normaliseUri(lspUri))
    return doc ? doc.model.uri : this.monaco.Uri.parse(lspUri)
  }

  private registerProviders(): void {
    if (this.providers.length) return
    const monaco = this.monaco
    const languages = monaco.languages
    const caps = this.capabilities ?? {}

    if (caps.completionProvider) {
      const triggers: string[] = (caps.completionProvider.triggerCharacters ?? []).filter((ch: string) => ch !== '\n')
      this.providers.push(
        languages.registerCompletionItemProvider('luau', {
          triggerCharacters: triggers,
          provideCompletionItems: async (model, position, context, token) => {
            const doc = this.docFor(model)
            if (!doc) return null
            const triggerKind = context.triggerKind + 1 // Monaco 0..2, LSP 1..3
            const result = await this.request<any>(
              'textDocument/completion',
              {
                textDocument: { uri: doc.uri },
                position: toLspPosition(position),
                context: { triggerKind, triggerCharacter: context.triggerCharacter }
              },
              token
            )
            if (!result) return { suggestions: [] }
            const items: any[] = Array.isArray(result) ? result : result.items ?? []
            const defaults = Array.isArray(result) ? undefined : result.itemDefaults
            const word = model.getWordUntilPosition(position)
            const defaultRange = {
              startLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endLineNumber: position.lineNumber,
              endColumn: position.column
            }
            return {
              incomplete: !Array.isArray(result) && Boolean(result.isIncomplete),
              suggestions: items.map((item) => this.toCompletion(item, defaults, defaultRange))
            }
          },
          resolveCompletionItem: caps.completionProvider.resolveProvider
            ? async (item, token) => {
                const original = (item as any).__lsp
                if (!original) return item
                const resolved = await this.request<any>('completionItem/resolve', original, token)
                if (!resolved) return item
                if (resolved.detail !== undefined) item.detail = resolved.detail
                if (resolved.documentation !== undefined) item.documentation = documentation(resolved.documentation)
                if (resolved.additionalTextEdits) {
                  item.additionalTextEdits = resolved.additionalTextEdits.map((edit: any) => ({
                    range: toMonacoRange(edit.range),
                    text: edit.newText
                  }))
                }
                return item
              }
            : undefined
        })
      )
    }

    if (caps.hoverProvider) {
      this.providers.push(
        languages.registerHoverProvider('luau', {
          provideHover: async (model, position, token) => {
            const doc = this.docFor(model)
            if (!doc) return null
            const hover = await this.request<any>(
              'textDocument/hover',
              { textDocument: { uri: doc.uri }, position: toLspPosition(position) },
              token
            )
            if (!hover) return null
            const contents = toMarkdown(hover.contents)
            if (!contents.length) return null
            return { contents, range: hover.range ? toMonacoRange(hover.range) : undefined }
          }
        })
      )
    }

    if (caps.signatureHelpProvider) {
      this.providers.push(
        languages.registerSignatureHelpProvider('luau', {
          signatureHelpTriggerCharacters: caps.signatureHelpProvider.triggerCharacters ?? ['(', ','],
          signatureHelpRetriggerCharacters: caps.signatureHelpProvider.retriggerCharacters ?? [],
          provideSignatureHelp: async (model, position, token, context) => {
            const doc = this.docFor(model)
            if (!doc) return null
            const help = await this.request<any>(
              'textDocument/signatureHelp',
              {
                textDocument: { uri: doc.uri },
                position: toLspPosition(position),
                context: {
                  triggerKind: context.triggerKind,
                  triggerCharacter: context.triggerCharacter,
                  isRetrigger: context.isRetrigger
                }
              },
              token
            )
            if (!help || !help.signatures?.length) return null
            return {
              value: {
                activeSignature: help.activeSignature ?? 0,
                activeParameter: help.activeParameter ?? 0,
                signatures: help.signatures.map((sig: any) => ({
                  label: sig.label,
                  documentation: documentation(sig.documentation),
                  activeParameter: sig.activeParameter,
                  parameters: (sig.parameters ?? []).map((param: any) => ({
                    label: param.label,
                    documentation: documentation(param.documentation)
                  }))
                }))
              },
              dispose: () => undefined
            }
          }
        })
      )
    }

    if (caps.definitionProvider) {
      this.providers.push(
        languages.registerDefinitionProvider('luau', {
          provideDefinition: async (model, position, token) => {
            const doc = this.docFor(model)
            if (!doc) return null
            const result = await this.request<any>(
              'textDocument/definition',
              { textDocument: { uri: doc.uri }, position: toLspPosition(position) },
              token
            )
            if (!result) return null
            const list: any[] = Array.isArray(result) ? result : [result]
            return list.map((loc) =>
              'targetUri' in loc
                ? {
                    uri: this.monacoUri(loc.targetUri),
                    range: toMonacoRange(loc.targetSelectionRange ?? loc.targetRange),
                    targetSelectionRange: loc.targetSelectionRange ? toMonacoRange(loc.targetSelectionRange) : undefined,
                    originSelectionRange: loc.originSelectionRange ? toMonacoRange(loc.originSelectionRange) : undefined
                  }
                : { uri: this.monacoUri(loc.uri), range: toMonacoRange(loc.range as LspRange) }
            )
          }
        })
      )
    }

    const formatOptions = (options: Monaco.languages.FormattingOptions) => ({
      tabSize: options.tabSize,
      insertSpaces: options.insertSpaces,
      trimTrailingWhitespace: true,
      insertFinalNewline: true
    })
    const toEdits = (edits: any[] | null) =>
      (edits ?? []).map((edit) => ({ range: toMonacoRange(edit.range), text: edit.newText }))
    if (caps.documentFormattingProvider) {
      this.providers.push(
        languages.registerDocumentFormattingEditProvider('luau', {
          provideDocumentFormattingEdits: async (model, options, token) => {
            const doc = this.docFor(model)
            if (!doc) return null
            const edits = await this.request<any[]>(
              'textDocument/formatting',
              { textDocument: { uri: doc.uri }, options: formatOptions(options) },
              token
            )
            return toEdits(edits)
          }
        })
      )
    }
    if (caps.documentRangeFormattingProvider) {
      this.providers.push(
        languages.registerDocumentRangeFormattingEditProvider('luau', {
          provideDocumentRangeFormattingEdits: async (model, range, options, token) => {
            const doc = this.docFor(model)
            if (!doc) return null
            const edits = await this.request<any[]>(
              'textDocument/rangeFormatting',
              { textDocument: { uri: doc.uri }, range: toLspRange(range), options: formatOptions(options) },
              token
            )
            return toEdits(edits)
          }
        })
      )
    }

    const location = (loc: any): Monaco.languages.Location | null => {
      if (!loc) return null
      if ('targetUri' in loc) return { uri: this.monacoUri(loc.targetUri), range: toMonacoRange(loc.targetSelectionRange ?? loc.targetRange) }
      return { uri: this.monacoUri(loc.uri), range: toMonacoRange(loc.range as LspRange) }
    }
    const locations = (result: any): Monaco.languages.Location[] =>
      (Array.isArray(result) ? result : result ? [result] : []).map(location).filter((l): l is Monaco.languages.Location => l !== null)
    const at = (doc: OpenDoc, position: Position) => ({ textDocument: { uri: doc.uri }, position: toLspPosition(position) })

    if (caps.typeDefinitionProvider) {
      this.providers.push(
        languages.registerTypeDefinitionProvider('luau', {
          provideTypeDefinition: async (model, position, token) => {
            const doc = this.docFor(model)
            if (!doc) return null
            return locations(await this.request<any>('textDocument/typeDefinition', at(doc, position), token))
          }
        })
      )
    }

    if (caps.referencesProvider) {
      this.providers.push(
        languages.registerReferenceProvider('luau', {
          provideReferences: async (model, position, context, token) => {
            const doc = this.docFor(model)
            if (!doc) return null
            return locations(
              await this.request<any>('textDocument/references', { ...at(doc, position), context: { includeDeclaration: context.includeDeclaration } }, token)
            )
          }
        })
      )
    }

    if (caps.documentHighlightProvider) {
      this.providers.push(
        languages.registerDocumentHighlightProvider('luau', {
          provideDocumentHighlights: async (model, position, token) => {
            const doc = this.docFor(model)
            if (!doc) return null
            const result = await this.request<any[]>('textDocument/documentHighlight', at(doc, position), token)
            return (result ?? []).map((h) => ({ range: toMonacoRange(h.range), kind: toMonacoHighlightKind(h.kind) as Monaco.languages.DocumentHighlightKind }))
          }
        })
      )
    }

    if (caps.renameProvider) {
      const prepare = typeof caps.renameProvider === 'object' && caps.renameProvider.prepareProvider
      this.providers.push(
        languages.registerRenameProvider('luau', {
          provideRenameEdits: async (model, position, newName, token) => {
            const doc = this.docFor(model)
            if (!doc) return null
            const result = await this.request<any>('textDocument/rename', { ...at(doc, position), newName }, token)
            if (!result) return { edits: [], rejectReason: 'Nothing to rename here' }
            const { edits, external } = this.splitWorkspaceEdit(result)
            // Files without a model are changed on disk; Monaco applies the rest (undoable).
            const failed = await this.applyExternal(external)
            return failed ? { edits, rejectReason: failed } : { edits }
          },
          resolveRenameLocation: prepare
            ? async (model, position, token) => {
                const doc = this.docFor(model)
                if (!doc) return null as any
                const result = await this.request<any>('textDocument/prepareRename', at(doc, position), token)
                if (!result) return { range: null as any, text: '', rejectReason: 'This element cannot be renamed' }
                if ('range' in result) return { range: toMonacoRange(result.range), text: result.placeholder ?? model.getValueInRange(toMonacoRange(result.range)) }
                if ('start' in result) return { range: toMonacoRange(result), text: model.getValueInRange(toMonacoRange(result)) }
                const word = model.getWordAtPosition(position)
                return word
                  ? { range: { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }, text: word.word }
                  : (null as any)
              }
            : undefined
        })
      )
    }

    if (caps.documentSymbolProvider) {
      this.providers.push(
        languages.registerDocumentSymbolProvider('luau', {
          displayName: 'luau-lsp',
          provideDocumentSymbols: async (model, token) => {
            const doc = this.docFor(model)
            if (!doc) return null
            const result = await this.request<any[]>('textDocument/documentSymbol', { textDocument: { uri: doc.uri } }, token)
            return (result ?? []).map((symbol) => this.toDocumentSymbol(symbol))
          }
        })
      )
    }

    if (caps.codeActionProvider) {
      const kinds: string[] | undefined = typeof caps.codeActionProvider === 'object' ? caps.codeActionProvider.codeActionKinds : undefined
      const canResolve = typeof caps.codeActionProvider === 'object' && Boolean(caps.codeActionProvider.resolveProvider)
      this.providers.push(
        languages.registerCodeActionProvider(
          'luau',
          {
            provideCodeActions: async (model, range, context, token) => {
              const doc = this.docFor(model)
              if (!doc) return null
              const lspRange = toLspRange(range)
              const result = await this.request<any[]>(
                'textDocument/codeAction',
                {
                  textDocument: { uri: doc.uri },
                  range: lspRange,
                  context: {
                    diagnostics: doc.diagnostics.filter((d) => overlaps(d.range, lspRange)),
                    only: context.only ? [context.only] : undefined,
                    triggerKind: context.trigger === 2 ? 2 : 1
                  }
                },
                token
              )
              return { actions: (result ?? []).map((item) => this.toCodeAction(item, doc)), dispose: () => undefined }
            },
            resolveCodeAction: canResolve
              ? async (action, token) => {
                  const original = (action as any).__lsp
                  if (!original || original.edit || typeof original.command === 'string') return action
                  const resolved = await this.request<any>('codeAction/resolve', original, token)
                  if (!resolved) return action
                  const doc = this.byLspUri.get(normaliseUri(original.data?.uri ?? '')) ?? null
                  // Monaco keeps its own action object and only copies `edit` from the result,
                  // so fill in the edit and the follow-up command (luau-lsp.rename) in place.
                  const converted = this.toCodeAction(resolved, doc)
                  action.edit = converted.edit
                  if (converted.command) action.command = converted.command
                  ;(action as any).__lsp = resolved
                  return action
                }
              : undefined
          },
          kinds ? { providedCodeActionKinds: kinds } : undefined
        )
      )
    }

    if (caps.documentLinkProvider) {
      this.providers.push(
        languages.registerLinkProvider('luau', {
          provideLinks: async (model, token) => {
            const doc = this.docFor(model)
            if (!doc) return null
            const result = await this.request<any[]>('textDocument/documentLink', { textDocument: { uri: doc.uri } }, token)
            return {
              links: (result ?? [])
                .filter((link) => link.target)
                .map((link) => ({ range: toMonacoRange(link.range), url: this.monacoUri(link.target), tooltip: link.tooltip }))
            }
          }
        })
      )
    }

    if (caps.foldingRangeProvider) {
      const FoldingKind = (languages as any).FoldingRangeKind
      const kindOf = (kind: string | undefined) =>
        !FoldingKind || !kind ? undefined : kind === 'comment' ? FoldingKind.Comment : kind === 'imports' ? FoldingKind.Imports : kind === 'region' ? FoldingKind.Region : undefined
      this.providers.push(
        languages.registerFoldingRangeProvider('luau', {
          provideFoldingRanges: async (model, _context, token) => {
            const doc = this.docFor(model)
            if (!doc) return null
            const result = await this.request<any[]>('textDocument/foldingRange', { textDocument: { uri: doc.uri } }, token)
            return (result ?? [])
              .filter((r) => r.endLine > r.startLine)
              .map((r) => ({ start: r.startLine + 1, end: r.endLine + 1, kind: kindOf(r.kind) }))
          }
        })
      )
    }

    if (caps.colorProvider) {
      this.providers.push(
        languages.registerColorProvider('luau', {
          provideDocumentColors: async (model, token) => {
            const doc = this.docFor(model)
            if (!doc) return null
            const result = await this.request<any[]>('textDocument/documentColor', { textDocument: { uri: doc.uri } }, token)
            return (result ?? []).map((c) => ({ color: c.color, range: toMonacoRange(c.range) }))
          },
          provideColorPresentations: async (model, info, token) => {
            const doc = this.docFor(model)
            if (!doc) return null
            const result = await this.request<any[]>(
              'textDocument/colorPresentation',
              { textDocument: { uri: doc.uri }, color: info.color, range: toLspRange(info.range) },
              token
            )
            return (result ?? []).map((p) => ({
              label: p.label,
              textEdit: p.textEdit ? { range: toMonacoRange(p.textEdit.range), text: p.textEdit.newText } : undefined,
              additionalTextEdits: p.additionalTextEdits?.map((e: any) => ({ range: toMonacoRange(e.range), text: e.newText }))
            }))
          }
        })
      )
    }

    if (caps.inlayHintProvider) {
      this.providers.push(
        languages.registerInlayHintsProvider('luau', {
          displayName: 'luau-lsp',
          onDidChangeInlayHints: this.inlayHintsChanged.event,
          provideInlayHints: async (model, range, token) => {
            const doc = this.docFor(model)
            if (!doc) return null
            const result = await this.request<any[]>('textDocument/inlayHint', { textDocument: { uri: doc.uri }, range: toLspRange(range) }, token)
            return { hints: (result ?? []).map((hint) => this.toInlayHint(hint)), dispose: () => undefined }
          }
        })
      )
    }

    const semantic = caps.semanticTokensProvider
    if (semantic && semantic.legend && semantic.full) {
      const legend = { tokenTypes: semantic.legend.tokenTypes ?? [], tokenModifiers: semantic.legend.tokenModifiers ?? [] }
      this.providers.push(
        languages.registerDocumentSemanticTokensProvider('luau', {
          onDidChange: this.semanticTokensChanged.event,
          getLegend: () => legend,
          provideDocumentSemanticTokens: async (model, _lastResultId, token) => {
            const doc = this.docFor(model)
            if (!doc) return null
            const result = await this.request<any>('textDocument/semanticTokens/full', { textDocument: { uri: doc.uri } }, token)
            if (!result || !Array.isArray(result.data)) return null
            return { resultId: result.resultId, data: Uint32Array.from(result.data) }
          },
          releaseDocumentSemanticTokens: () => undefined
        })
      )
      if (this.options.semanticHighlighting !== false) this.enableSemanticHighlighting()
    }
  }

  private toCompletion(item: any, defaults: any, defaultRange: Monaco.IRange): Monaco.languages.CompletionItem {
    const monaco = this.monaco
    const edit = item.textEdit
    let range: Monaco.languages.CompletionItem['range'] = defaultRange
    if (edit) {
      range = 'range' in edit ? toMonacoRange(edit.range) : { insert: toMonacoRange(edit.insert), replace: toMonacoRange(edit.replace) }
    } else if (defaults?.editRange) {
      const r = defaults.editRange
      range = 'start' in r ? toMonacoRange(r) : { insert: toMonacoRange(r.insert), replace: toMonacoRange(r.replace) }
    }
    const format = item.insertTextFormat ?? defaults?.insertTextFormat
    const label = item.labelDetails
      ? { label: item.label, detail: item.labelDetails.detail, description: item.labelDetails.description }
      : item.label
    const command = item.command && /^editor\.action\.(triggerParameterHints|triggerSuggest)$/.test(item.command.command)
      ? { id: item.command.command, title: item.command.title ?? '' }
      : undefined
    const out: Monaco.languages.CompletionItem = {
      label,
      kind: toMonacoCompletionKind(item.kind, monaco.languages.CompletionItemKind as unknown as Record<string, number>),
      detail: item.detail,
      documentation: documentation(item.documentation),
      insertText: edit?.newText ?? item.insertText ?? item.label,
      insertTextRules: format === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
      range,
      sortText: item.sortText,
      filterText: item.filterText,
      preselect: item.preselect,
      commitCharacters: item.commitCharacters ?? defaults?.commitCharacters ?? this.capabilities?.completionProvider?.allCommitCharacters,
      tags: item.deprecated || item.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
      additionalTextEdits: item.additionalTextEdits?.map((e: any) => ({ range: toMonacoRange(e.range), text: e.newText })),
      command
    }
    ;(out as any).__lsp = item
    return out
  }

  // --- edits

  // LSP WorkspaceEdit -> Monaco edits for documents with a model, plus repo-relative edits
  // for files without one (Monaco's standalone bulk edit service only edits existing models).
  private splitWorkspaceEdit(edit: unknown): { edits: Monaco.languages.IWorkspaceTextEdit[]; external: Map<string, LspTextEdit[]> } {
    const edits: Monaco.languages.IWorkspaceTextEdit[] = []
    const external = new Map<string, LspTextEdit[]>()
    for (const [uri, list] of workspaceEditByUri(edit).byUri) {
      const doc = this.byLspUri.get(normaliseUri(uri))
      if (doc && !doc.model.isDisposed()) {
        for (const e of list) {
          edits.push({ resource: doc.model.uri, textEdit: { range: toMonacoRange(e.range), text: e.newText }, versionId: doc.model.getVersionId() })
        }
        continue
      }
      const path = this.rootUri ? relativePath(this.rootUri, uri) : null
      if (path) external.set(path, [...(external.get(path) ?? []), ...list])
    }
    return { edits, external }
  }

  // Writes edits to files without a model. Returns an error message, or null.
  private async applyExternal(external: Map<string, LspTextEdit[]>): Promise<string | null> {
    if (!external.size) return null
    const apply = this.options.applyFileEdits ?? defaultApplyFileEdits()
    if (!apply) return `cannot edit ${[...external.keys()].join(', ')} (not open)`
    const failures: string[] = []
    for (const [path, edits] of external) {
      try {
        await apply(path, edits)
      } catch (error) {
        failures.push(`${path}: ${error instanceof Error ? error.message : error}`)
      }
    }
    return failures.length ? `could not edit ${failures.join('; ')}` : null
  }

  // workspace/applyEdit from the server, and code actions touching files without a model.
  async applyWorkspaceEdit(edit: unknown): Promise<{ applied: boolean; failureReason?: string }> {
    const { edits, external } = this.splitWorkspaceEdit(edit)
    const byModel = new Map<Model, Monaco.editor.IIdentifiedSingleEditOperation[]>()
    for (const e of edits) {
      const model = this.monaco.editor.getModel(e.resource as Monaco.Uri)
      if (!model) continue
      const list = byModel.get(model) ?? []
      list.push({ range: e.textEdit.range, text: e.textEdit.text, forceMoveMarkers: true })
      byModel.set(model, list)
    }
    for (const [model, operations] of byModel) {
      model.pushStackElement()
      model.pushEditOperations([], operations, () => null)
      model.pushStackElement()
    }
    const failed = await this.applyExternal(external)
    return failed ? { applied: byModel.size > 0, failureReason: failed } : { applied: true }
  }

  // --- conversions needing the client (URIs, models)

  private toDocumentSymbol(symbol: any): Monaco.languages.DocumentSymbol {
    const deprecated = symbol.deprecated || symbol.tags?.includes(1)
    if (symbol.location) {
      // SymbolInformation (flat)
      const range = toMonacoRange(symbol.location.range)
      return {
        name: symbol.name,
        detail: '',
        kind: toMonacoSymbolKind(symbol.kind) as Monaco.languages.SymbolKind,
        tags: deprecated ? [1 as Monaco.languages.SymbolTag] : [],
        containerName: symbol.containerName,
        range,
        selectionRange: range
      }
    }
    return {
      name: symbol.name,
      detail: symbol.detail ?? '',
      kind: toMonacoSymbolKind(symbol.kind) as Monaco.languages.SymbolKind,
      tags: deprecated ? [1 as Monaco.languages.SymbolTag] : [],
      range: toMonacoRange(symbol.range),
      selectionRange: toMonacoRange(symbol.selectionRange ?? symbol.range),
      children: (symbol.children ?? []).map((child: any) => this.toDocumentSymbol(child))
    }
  }

  private toCodeAction(item: any, doc: OpenDoc | null): Monaco.languages.CodeAction {
    // A bare Command (title + command string).
    if (typeof item.command === 'string') {
      const out: Monaco.languages.CodeAction = { title: item.title, command: { id: item.command, title: item.title, arguments: item.arguments } }
      ;(out as any).__lsp = item
      return out
    }
    const out: Monaco.languages.CodeAction = {
      title: item.title,
      kind: item.kind,
      isPreferred: item.isPreferred,
      disabled: item.disabled?.reason,
      diagnostics: doc
        ? (item.diagnostics ?? []).map((d: any) => ({
            ...toMonacoRange(d.range),
            severity: toMarkerSeverity(d.severity) as Monaco.MarkerSeverity,
            message: d.message,
            source: d.source,
            code: d.code === undefined ? undefined : String(d.code)
          }))
        : undefined
    }
    if (item.edit) {
      const { edits, external } = this.splitWorkspaceEdit(item.edit)
      if (external.size) {
        // Monaco cannot edit files without a model; apply the whole edit ourselves.
        out.command = { id: APPLY_EDIT_COMMAND, title: item.title, arguments: [item.edit] }
      } else {
        out.edit = { edits }
      }
    }
    if (item.command) {
      if (out.command) {
        // Already applying the edit through our command: chain the server's command after it.
        out.command.arguments = [item.edit, item.command]
      } else {
        out.command = { id: item.command.command, title: item.command.title, arguments: item.command.arguments }
      }
    }
    ;(out as any).__lsp = item
    return out
  }

  private toInlayHint(hint: any): Monaco.languages.InlayHint {
    const tooltip = (value: any) => (value === undefined ? undefined : typeof value === 'string' ? value : { value: value.value })
    const label =
      typeof hint.label === 'string'
        ? hint.label
        : (hint.label ?? []).map((part: any) => ({
            label: part.value,
            tooltip: tooltip(part.tooltip),
            location: part.location ? { uri: this.monacoUri(part.location.uri), range: toMonacoRange(part.location.range) } : undefined
          }))
    return {
      label,
      position: { lineNumber: hint.position.line + 1, column: hint.position.character + 1 },
      kind: hint.kind === 1 || hint.kind === 2 ? hint.kind : undefined,
      tooltip: tooltip(hint.tooltip),
      paddingLeft: hint.paddingLeft,
      paddingRight: hint.paddingRight,
      textEdits: hint.textEdits?.map((e: any) => ({ range: toMonacoRange(e.range), text: e.newText }))
    }
  }

  // --- editor integration

  private registerCommands(): void {
    const editor = this.monaco.editor
    if (typeof editor.registerCommand !== 'function') return
    this.disposables.push(
      // Code actions whose edits reach files without a model; [edit, then a server command].
      editor.registerCommand(APPLY_EDIT_COMMAND, async (_accessor: unknown, edit: unknown, then?: { command: string; arguments?: unknown[] }) => {
        const result = await this.applyWorkspaceEdit(edit)
        if (result.failureReason) console.warn('[luau-lsp]', result.failureReason)
        if (then?.command === 'luau-lsp.rename') this.startRename(then.arguments?.[0] as string, then.arguments?.[1] as any)
      }),
      // Sent by luau-lsp after extract-variable/function refactors (Refactoring.cpp
      // resolveRefactoring): put the cursor on the new name and start a rename.
      editor.registerCommand('luau-lsp.rename', (_accessor: unknown, uri: string, position: { line: number; character: number }) =>
        this.startRename(uri, position)
      )
    )
  }

  private startRename(uri: string, position: { line: number; character: number } | undefined): void {
    if (!uri || !position) return
    const doc = this.byLspUri.get(normaliseUri(uri))
    const getEditors = (this.monaco.editor as unknown as { getEditors?: () => Monaco.editor.ICodeEditor[] }).getEditors
    const target = doc && getEditors ? getEditors().find((e) => e.getModel() === doc.model) : undefined
    if (!target) return
    // The edit lands first; rename on the next tick so the new text is in the model.
    setTimeout(() => {
      target.setPosition({ lineNumber: position.line + 1, column: position.character + 1 })
      target.focus()
      target.trigger('luau-lsp', 'editor.action.rename', null)
    })
  }

  private enableSemanticHighlighting(): void {
    const editor = this.monaco.editor as unknown as {
      getEditors?: () => Monaco.editor.ICodeEditor[]
      onDidCreateEditor?: (listener: (e: Monaco.editor.ICodeEditor) => void) => Monaco.IDisposable
    }
    const enable = (e: Monaco.editor.ICodeEditor) => e.updateOptions({ 'semanticHighlighting.enabled': true } as any)
    for (const e of editor.getEditors?.() ?? []) enable(e)
    if (editor.onDidCreateEditor) this.providers.push(editor.onDidCreateEditor(enable))
  }

  // Cross-file navigation (go to definition into another file) goes through openPath.
  private registerOpener(): void {
    const editor = this.monaco.editor
    if (typeof editor.registerEditorOpener !== 'function') return
    this.disposables.push(
      editor.registerEditorOpener({
        openCodeEditor: (source, resource, selectionOrPosition) => {
          if (!this.options.openPath) return false
          if (source.getModel()?.uri.toString() === resource.toString()) return false
          const model = editor.getModel(resource)
          let path = model ? this.pathOf(model) : null
          if (!path && this.rootUri) path = relativePath(this.rootUri, resource.toString())
          if (!path) return false
          let position: Position | undefined
          if (selectionOrPosition) {
            position =
              'lineNumber' in selectionOrPosition
                ? { lineNumber: selectionOrPosition.lineNumber, column: selectionOrPosition.column }
                : { lineNumber: selectionOrPosition.startLineNumber, column: selectionOrPosition.startColumn }
          }
          this.options.openPath(path, position)
          return true
        }
      })
    )
  }
}

let client: LuauLspClient | null = null

// Starts the Luau language client once; later calls return the running one.
export function startLuauLsp(monaco: MonacoApi, options: LuauLspOptions = {}): { dispose(): void } {
  if (!client) {
    const transport = options.transport ?? harnessTransport()
    if (!transport) return { dispose: () => undefined }
    client = new LuauLspClient(monaco, options, transport)
    void client.start()
  }
  return { dispose: stopLuauLsp }
}

export function stopLuauLsp(): void {
  client?.dispose()
  client = null
}
