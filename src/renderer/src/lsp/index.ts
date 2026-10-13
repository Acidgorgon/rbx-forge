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
// Provides: completion (+ resolve when the server supports it), hover, signature help,
// go to definition (other files open through openPath), document formatting when the server
// advertises it (luau-lsp does not today), and diagnostics as model markers.

import type * as Monaco from 'monaco-editor'
import { Connection, ResponseError, ErrorCodes, type CancelToken, type Transport } from './connection.ts'
import {
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
  type LspRange
} from './convert.ts'

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
}

const MARKER_OWNER = 'luau-lsp'

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
    completion: {
      enabled: true,
      autocompleteEnd: false,
      addParentheses: true,
      imports: { enabled: true, suggestServices: true, suggestRequires: true }
    },
    hover: { enabled: true, showTableKinds: false, multilineFunctionDefinitions: false, strictDatamodelTypes: true },
    signatureHelp: { enabled: true },
    inlayHints: { parameterNames: 'none', variableTypes: false, parameterTypes: false, functionReturnTypes: false },
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
    // The main-process bridge watches the project and sends workspace/didChangeWatchedFiles.
    didChangeWatchedFiles: { dynamicRegistration: true }
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

  constructor(monaco: MonacoApi, options: LuauLspOptions, transport: Transport & { start(): Promise<boolean> }) {
    this.monaco = monaco
    this.options = options
    this.transport = transport
    this.connection = new Connection(transport)
    this.registerServerHandlers()
    this.watchModels()
    this.registerOpener()
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
    c.onRequest('workspace/applyEdit', () => ({ applied: false, failureReason: 'not supported' }))
    c.onRequest('workspace/semanticTokens/refresh', () => null)
    c.onRequest('workspace/inlayHint/refresh', () => null)
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
    const doc: OpenDoc = { model, path, uri: this.lspUriOf(path) }
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
      commitCharacters: item.commitCharacters ?? defaults?.commitCharacters,
      tags: item.deprecated || item.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
      additionalTextEdits: item.additionalTextEdits?.map((e: any) => ({ range: toMonacoRange(e.range), text: e.newText })),
      command
    }
    ;(out as any).__lsp = item
    return out
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
