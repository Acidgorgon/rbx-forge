// Provider mappings of the renderer luau-lsp client against a fake server and a fake Monaco.
// Server payloads are shaped like luau-lsp 1.70.1's real responses (captured from the binary).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyTextEdits, decodeSemanticTokens, toMonacoSymbolKind, workspaceEditByUri } from '../src/renderer/src/lsp/convert.ts'
import { defaultSettings, semanticTokenRules, startLuauLsp, stopLuauLsp } from '../src/renderer/src/lsp/index.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }

// luau-lsp 1.70.1 legend (src/include/Protocol/SemanticTokens.hpp)
const LEGEND = {
  tokenTypes: [
    'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter', 'variable', 'property',
    'enumMember', 'event', 'function', 'method', 'macro', 'keyword', 'modifier', 'comment', 'string', 'number',
    'regexp', 'operator', 'decorator'
  ],
  tokenModifiers: ['declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async', 'modification', 'documentation', 'defaultLibrary']
}

// luau-lsp 1.70.1 getServerCapabilities()
const CAPS = {
  textDocumentSync: { openClose: true, change: 2, save: { includeText: false } },
  completionProvider: { triggerCharacters: ['.', ':', "'", '"', '/', '\n'], resolveProvider: false, completionItem: { labelDetailsSupport: true } },
  hoverProvider: true,
  signatureHelpProvider: { triggerCharacters: ['(', ','] },
  declarationProvider: false,
  definitionProvider: true,
  typeDefinitionProvider: true,
  implementationProvider: false,
  referencesProvider: true,
  documentSymbolProvider: true,
  colorProvider: true,
  documentLinkProvider: { resolveProvider: false },
  codeActionProvider: { codeActionKinds: ['quickfix', 'refactor.extract', 'refactor.inline', 'source', 'source.organizeImports'], resolveProvider: true },
  renameProvider: true,
  foldingRangeProvider: true,
  inlayHintProvider: true,
  diagnosticProvider: { identifier: 'luau', interFileDependencies: true, workspaceDiagnostics: true },
  workspaceSymbolProvider: true,
  callHierarchyProvider: true,
  semanticTokensProvider: { legend: LEGEND, range: false, full: true },
  documentOnTypeFormattingProvider: { firstTriggerCharacter: '{' }
}

function fakeMonaco() {
  const providers: Record<string, any> = {}
  const commands: Record<string, (...args: any[]) => any> = {}
  const models: any[] = []
  const editorOptions: any[] = []
  const reg = (name: string) => (_l: string, p: any, meta?: any) => ((providers[name] = p), meta && (providers[name + 'Meta'] = meta), { dispose() {} })
  const uri = (s: string) => ({ scheme: 'file', path: s.replace(/^file:\/\//, ''), toString: () => s })
  const monaco: any = {
    Uri: { parse: uri },
    MarkerTag: { Unnecessary: 1, Deprecated: 2 },
    editor: {
      getModels: () => models,
      getModel: (u: any) => models.find((m) => m.uri.toString() === u.toString()) ?? null,
      onDidCreateModel: () => ({ dispose() {} }),
      onWillDisposeModel: () => ({ dispose() {} }),
      onDidChangeModelLanguage: () => ({ dispose() {} }),
      setModelMarkers: () => undefined,
      registerEditorOpener: () => ({ dispose() {} }),
      registerCommand: (id: string, handler: any) => ((commands[id] = handler), { dispose() {} }),
      getEditors: () => [{ updateOptions: (o: any) => editorOptions.push(o), getModel: () => models[0] }],
      onDidCreateEditor: () => ({ dispose() {} })
    },
    languages: {
      CompletionItemKind: { Method: 0, Function: 1, Variable: 4, Module: 8, Keyword: 17, Text: 18, File: 20, Folder: 23 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      CompletionItemTag: { Deprecated: 1 },
      FoldingRangeKind: { Comment: { value: 'comment' }, Imports: { value: 'imports' }, Region: { value: 'region' } },
      registerCompletionItemProvider: reg('completion'),
      registerHoverProvider: reg('hover'),
      registerSignatureHelpProvider: reg('signature'),
      registerDefinitionProvider: reg('definition'),
      registerTypeDefinitionProvider: reg('typeDefinition'),
      registerReferenceProvider: reg('references'),
      registerDocumentHighlightProvider: reg('highlight'),
      registerRenameProvider: reg('rename'),
      registerDocumentSymbolProvider: reg('symbols'),
      registerCodeActionProvider: reg('codeAction'),
      registerLinkProvider: reg('links'),
      registerFoldingRangeProvider: reg('folding'),
      registerColorProvider: reg('color'),
      registerInlayHintsProvider: reg('inlayHints'),
      registerDocumentSemanticTokensProvider: reg('semantic'),
      registerDocumentFormattingEditProvider: reg('format'),
      registerDocumentRangeFormattingEditProvider: reg('rangeFormat')
    }
  }
  const addModel = (path: string, text: string) => {
    let value = text
    let version = 1
    const pushed: any[] = []
    const model = {
      uri: uri('file:///' + path),
      pushed,
      getLanguageId: () => 'luau',
      getValue: () => value,
      getVersionId: () => version,
      isDisposed: () => false,
      getWordUntilPosition: (pos: any) => ({ word: '', startColumn: pos.column, endColumn: pos.column }),
      onDidChangeContent: () => ({ dispose() {} }),
      pushStackElement: () => undefined,
      pushEditOperations: (_sel: any, ops: any[]) => {
        pushed.push(...ops)
        version++
        return null
      }
    }
    models.push(model)
    return model
  }
  return { monaco, providers, commands, addModel, editorOptions }
}

// Starts the client on a fake transport and answers initialize with luau-lsp's capabilities.
async function boot(options: Record<string, unknown> = {}, caps: any = CAPS) {
  const sent: any[] = []
  let deliver: (m: unknown) => void = () => undefined
  const fake = fakeMonaco()
  const a = fake.addModel('src/shared/A.luau', 'local Util = 1\nprint(Util)\n')
  const b = fake.addModel('src/shared/B.luau', 'return 1\n')
  startLuauLsp(fake.monaco, {
    rootUri: 'file:///work/game',
    transport: {
      send: (m: unknown) => sent.push(m),
      listen: (h: (m: unknown) => void) => ((deliver = h), () => undefined),
      start: async () => true
    },
    ...options
  })
  await tick()
  await tick()
  const init = sent.find((m) => m.method === 'initialize')
  deliver({ jsonrpc: '2.0', id: init.id, result: { capabilities: caps, serverInfo: { name: 'Luau', version: '1.70.1' } } })
  await tick()
  // Answers the next request with `method` (after the provider sent it).
  const answer = async (method: string, result: unknown) => {
    await tick()
    const req = [...sent].reverse().find((m) => m.method === method && m.id !== undefined)
    assert.ok(req, `no ${method} request`)
    deliver({ jsonrpc: '2.0', id: req.id, result })
    return req
  }
  return { sent, deliver: (m: unknown) => deliver(m), answer, init, a, b, ...fake }
}

const range = (sl: number, sc: number, el: number, ec: number) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } })
const A_URI = 'file:///work/game/src/shared/A.luau'
const B_URI = 'file:///work/game/src/shared/B.luau'

test('client capabilities advertise the new features; providers follow server capabilities', async () => {
  const s = await boot()
  try {
    const td = s.init.params.capabilities.textDocument
    assert.equal(td.foldingRange.lineFoldingOnly, true)
    assert.equal(td.documentSymbol.hierarchicalDocumentSymbolSupport, true)
    assert.deepEqual(td.codeAction.resolveSupport.properties, ['edit', 'command'])
    assert.equal(s.init.params.capabilities.workspace.inlayHint.refreshSupport, true)
    assert.equal(s.init.params.capabilities.workspace.applyEdit, true)
    for (const name of ['typeDefinition', 'references', 'rename', 'symbols', 'codeAction', 'links', 'folding', 'color', 'inlayHints', 'semantic']) {
      assert.ok(s.providers[name], `${name} provider`)
    }
    // luau-lsp has no documentHighlightProvider / prepareRename.
    assert.equal(s.providers.highlight, undefined)
    assert.equal(s.providers.rename.resolveRenameLocation, undefined)
    assert.deepEqual(s.providers.codeActionMeta.providedCodeActionKinds, CAPS.codeActionProvider.codeActionKinds)
    // '\n' only drives autocompleteEnd, which needs VS Code-only cursor commands.
    assert.deepEqual(s.providers.completion.triggerCharacters, ['.', ':', "'", '"', '/'])
    // Semantic highlighting is switched on in editors.
    assert.deepEqual(s.editorOptions, [{ 'semanticHighlighting.enabled': true }])
  } finally {
    stopLuauLsp()
  }

  const bare = await boot({}, { textDocumentSync: 2, hoverProvider: true, documentHighlightProvider: true, renameProvider: { prepareProvider: true } })
  try {
    assert.equal(bare.providers.inlayHints, undefined)
    assert.equal(bare.providers.semantic, undefined)
    assert.equal(bare.providers.codeAction, undefined)
    assert.ok(bare.providers.highlight)
    assert.ok(bare.providers.rename.resolveRenameLocation)
    assert.deepEqual(bare.editorOptions, [])
  } finally {
    stopLuauLsp()
  }
})

test('settings: completion imports, fillCallArguments and inlay hints', async () => {
  const settings = defaultSettings() as any
  assert.equal(settings.completion.fillCallArguments, true)
  assert.equal(settings.completion.imports.suggestRequires, true)
  assert.equal(settings.completion.imports.suggestServices, true)
  assert.equal(settings.completion.imports.requireStyle, 'auto')
  assert.equal(settings.completion.imports.stringRequires.enabled, false)
  assert.equal(settings.completion.autocompleteEnd, false)
  assert.equal(settings.inlayHints.parameterNames, 'none', 'inlay hints are opt-in (they cost a type walk per edit)')
  assert.equal(settings.inlayHints.functionReturnTypes, false)
  assert.equal(settings.diagnostics.includeDependents, false)
  assert.equal(settings.index.maxFiles, 3000)
  assert.deepEqual(settings.ignoreGlobs, ['**/_Index/**', '**/Packages/**', '**/ServerPackages/**'])
  assert.equal(settings.sourcemap.autogenerate, false, 'never writes sourcemap.json, also with Studio DataModel updates')

  const s = await boot({ settings: { completion: { imports: { requireStyle: 'alwaysAbsolute' } }, inlayHints: { variableTypes: true } } })
  try {
    s.deliver({ jsonrpc: '2.0', id: 900, method: 'workspace/configuration', params: { items: [{ section: 'luau-lsp' }, { scopeUri: 'file:///work/game', section: 'luau-lsp' }] } })
    await tick()
    const result = s.sent.find((m) => m.id === 900).result
    assert.equal(result[1].completion.imports.requireStyle, 'alwaysAbsolute')
    assert.equal(result[1].completion.imports.suggestRequires, true, 'overrides merge into defaults')
    assert.equal(result[1].inlayHints.variableTypes, true, 'a user setting turns hints back on')
    assert.equal(result[1].inlayHints.parameterTypes, false)
  } finally {
    stopLuauLsp()
  }
})

test('completion: auto-require additionalTextEdits, snippets, commit characters, string requires', async () => {
  const s = await boot({}, { ...CAPS, completionProvider: { ...CAPS.completionProvider, allCommitCharacters: ['('] } })
  try {
    const pending = s.providers.completion.provideCompletionItems(s.a, { lineNumber: 3, column: 4 }, { triggerKind: 0 }, token)
    await s.answer('textDocument/completion', {
      isIncomplete: false,
      items: [
        {
          // Auto-import of a module (luau-lsp suggestImports, requireStyle auto)
          label: 'Util',
          labelDetails: { description: 'script.Parent.Util' },
          detail: 'script.Parent.Util',
          kind: 9,
          insertText: 'Util',
          sortText: '7',
          additionalTextEdits: [{ range: range(1, 0, 1, 0), newText: 'local Util = require(script.Parent.Util)\n' }]
        },
        {
          // Auto-import of a module inside Wally's _Index (e.g. a Studio-only plugin node the
          // server's ignoreGlobs cannot match): dropped by the client.
          label: 'vide',
          labelDetails: { description: 'ReplicatedStorage.Packages._Index["centau_vide@0.4.0"].vide' },
          detail: 'ReplicatedStorage.Packages._Index["centau_vide@0.4.0"].vide',
          kind: 9,
          insertText: 'vide',
          sortText: '7',
          additionalTextEdits: [{ range: range(1, 0, 1, 0), newText: 'local vide = require(ReplicatedStorage.Packages._Index["centau_vide@0.4.0"].vide)\n' }]
        },
        {
          // fillCallArguments
          label: 'greet',
          labelDetails: { detail: '(name)' },
          kind: 3,
          insertText: 'greet(${1:name})$0',
          insertTextFormat: 2,
          preselect: true,
          filterText: 'greet',
          command: { title: 'Trigger Signature Help', command: 'editor.action.triggerParameterHints' },
          documentation: { kind: 'markdown', value: 'Says **hi**' }
        },
        {
          // String require path: insert at the cursor and delete the typed "./" (luau-lsp's shape)
          label: 'Util',
          kind: 17,
          sortText: '4',
          textEdit: { range: range(2, 21, 2, 21), newText: './Util' },
          additionalTextEdits: [{ range: range(2, 19, 2, 21), newText: '' }]
        }
      ]
    })
    const { suggestions } = await pending
    const [util, greet, path] = suggestions
    assert.equal(suggestions.length, 3, 'the _Index auto-import is filtered out')
    assert.deepEqual(util.label, { label: 'Util', detail: undefined, description: 'script.Parent.Util' })
    assert.deepEqual(util.additionalTextEdits, [
      { range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 }, text: 'local Util = require(script.Parent.Util)\n' }
    ])
    assert.equal(util.sortText, '7')
    assert.deepEqual(util.commitCharacters, ['('], 'falls back to allCommitCharacters')
    assert.equal(greet.insertText, 'greet(${1:name})$0')
    assert.equal(greet.insertTextRules, 4)
    assert.equal(greet.preselect, true)
    assert.equal(greet.filterText, 'greet')
    assert.deepEqual(greet.command, { id: 'editor.action.triggerParameterHints', title: 'Trigger Signature Help' })
    assert.deepEqual(greet.documentation, { value: 'Says **hi**' })
    assert.equal(path.kind, 20, 'File')
    assert.equal(path.insertText, './Util')
    assert.deepEqual(path.range, { startLineNumber: 3, startColumn: 22, endLineNumber: 3, endColumn: 22 })
    assert.deepEqual(path.additionalTextEdits[0].range, { startLineNumber: 3, startColumn: 20, endLineNumber: 3, endColumn: 22 })
  } finally {
    stopLuauLsp()
  }
})

test('inlay hints: label parts, kinds, insertable edits, refresh', async () => {
  const s = await boot()
  try {
    let refreshed = 0
    s.providers.inlayHints.onDidChangeInlayHints(() => refreshed++)
    const pending = s.providers.inlayHints.provideInlayHints(s.a, { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 1 }, token)
    const req = await s.answer('textDocument/inlayHint', [
      { label: [{ value: 'className:' }], position: { line: 0, character: 42 }, kind: 2, paddingLeft: false, paddingRight: true, textEdits: [] },
      {
        label: [{ value: ': ' }, { value: 'Color3', tooltip: { kind: 'markdown', value: 'A color value' } }],
        position: { line: 6, character: 7 },
        kind: 1,
        paddingLeft: false,
        paddingRight: false,
        textEdits: [{ range: range(6, 7, 6, 7), newText: ': Color3' }]
      },
      { label: '-> number', position: { line: 1, character: 3 }, tooltip: 'returns' }
    ])
    assert.deepEqual(req.params.range, range(0, 0, 2, 0))
    const { hints } = await pending
    assert.deepEqual(hints[0], {
      label: [{ label: 'className:', tooltip: undefined, location: undefined }],
      position: { lineNumber: 1, column: 43 },
      kind: 2,
      tooltip: undefined,
      paddingLeft: false,
      paddingRight: true,
      textEdits: []
    })
    assert.equal(hints[1].kind, 1)
    assert.deepEqual(hints[1].label[1], { label: 'Color3', tooltip: { value: 'A color value' }, location: undefined })
    assert.deepEqual(hints[1].textEdits, [{ range: { startLineNumber: 7, startColumn: 8, endLineNumber: 7, endColumn: 8 }, text: ': Color3' }])
    assert.equal(hints[2].label, '-> number')
    assert.equal(hints[2].tooltip, 'returns')

    // workspace/inlayHint/refresh (sent when luau-lsp.inlayHints settings change)
    s.deliver({ jsonrpc: '2.0', id: 77, method: 'workspace/inlayHint/refresh' })
    await tick()
    assert.equal(refreshed, 1)
    assert.deepEqual(s.sent.find((m) => m.id === 77), { jsonrpc: '2.0', id: 77, result: null })
  } finally {
    stopLuauLsp()
  }
})

test('semantic tokens: server legend, data passed through, decode', async () => {
  const s = await boot()
  try {
    assert.deepEqual(s.providers.semantic.getLegend(), LEGEND)
    // Captured from luau-lsp 1.70.1 for:
    //   local ReplicatedStorage = game:GetService("ReplicatedStorage")
    //   local function greet(name: string)
    //   print(greet("x"))
    const data = [0, 26, 4, 8, 516, 0, 5, 10, 13, 516, 1, 21, 4, 7, 0, 0, 6, 6, 1, 0, 1, 0, 5, 12, 516]
    const pending = s.providers.semantic.provideDocumentSemanticTokens(s.a, null, token)
    await s.answer('textDocument/semanticTokens/full', { data })
    const result = await pending
    assert.ok(result.data instanceof Uint32Array)
    assert.deepEqual([...result.data], data)
    assert.deepEqual(
      decodeSemanticTokens(result.data, LEGEND).map((t) => `${t.line}:${t.character}+${t.length} ${t.type} ${t.modifiers.join(',')}`),
      [
        '0:26+4 variable readonly,defaultLibrary',
        '0:31+10 method readonly,defaultLibrary',
        '1:21+4 parameter ',
        '1:27+6 type ',
        '2:0+5 function readonly,defaultLibrary'
      ]
    )
    // Every token type luau-lsp emits has a theme rule, in both themes.
    for (const theme of ['dark', 'light'] as const) {
      const tokens = new Set(semanticTokenRules(theme).map((r) => r.token))
      for (const type of ['variable', 'parameter', 'property', 'function', 'method', 'event', 'class', 'enum', 'enumMember', 'namespace', 'type']) {
        assert.ok(tokens.has(type), `${theme}: ${type}`)
      }
      assert.ok(tokens.has('variable.readonly.defaultLibrary'))
    }
  } finally {
    stopLuauLsp()
  }
})

test('rename: edits across open models, files without a model go to applyFileEdits', async () => {
  const written: any[] = []
  const s = await boot({ applyFileEdits: async (path: string, edits: any[]) => void written.push({ path, edits }) })
  try {
    const pending = s.providers.rename.provideRenameEdits(s.a, { lineNumber: 1, column: 8 }, 'Helpers', token)
    const req = await s.answer('textDocument/rename', {
      changes: {
        [A_URI]: [
          { range: range(0, 6, 0, 10), newText: 'Helpers' },
          { range: range(1, 6, 1, 10), newText: 'Helpers' }
        ],
        [B_URI]: [{ range: range(0, 7, 0, 8), newText: 'Helpers' }],
        'file:///work/game/src/server/C.luau': [{ range: range(3, 0, 3, 4), newText: 'Helpers' }]
      }
    })
    assert.deepEqual(req.params, { textDocument: { uri: A_URI }, position: { line: 0, character: 7 }, newName: 'Helpers' })
    const result = await pending
    assert.equal(result.rejectReason, undefined)
    assert.deepEqual(
      result.edits.map((e: any) => [e.resource.toString(), e.textEdit.range.startLineNumber, e.textEdit.range.startColumn, e.textEdit.text, e.versionId]),
      [
        ['file:///src/shared/A.luau', 1, 7, 'Helpers', 1],
        ['file:///src/shared/A.luau', 2, 7, 'Helpers', 1],
        ['file:///src/shared/B.luau', 1, 8, 'Helpers', 1]
      ]
    )
    assert.deepEqual(written, [{ path: 'src/server/C.luau', edits: [{ range: range(3, 0, 3, 4), newText: 'Helpers' }] }])
  } finally {
    stopLuauLsp()
  }
})

test('code actions: diagnostics context, quick fix edits, resolve in place, edits to unopened files', async () => {
  const written: any[] = []
  const s = await boot({ applyFileEdits: async (path: string, edits: any[]) => void written.push({ path, edits }) })
  try {
    const unused = { range: range(0, 6, 0, 10), severity: 2, code: 'LocalUnused', source: 'Luau', message: "LocalUnused: Variable 'Util' is never used" }
    const elsewhere = { range: range(5, 0, 5, 3), severity: 1, message: 'far away' }
    s.deliver({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: A_URI, diagnostics: [unused, elsewhere] } })

    const pending = s.providers.codeAction.provideCodeActions(s.a, { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 11 }, { markers: [], trigger: 1 }, token)
    const req = await s.answer('textDocument/codeAction', [
      {
        title: "Prefix 'Util' with '_' to silence",
        kind: 'quickfix',
        isPreferred: true,
        diagnostics: [unused],
        edit: { changes: { [A_URI]: [{ range: range(0, 6, 0, 6), newText: '_' }] } }
      },
      { title: 'Extract to local variable', kind: 'refactor.extract', data: { uri: A_URI, type: 'extractVariable', range: range(1, 6, 1, 10) } },
      {
        title: 'Add missing requires',
        kind: 'source',
        edit: { changes: { [A_URI]: [{ range: range(0, 0, 0, 0), newText: 'local X = 1\n' }], 'file:///work/game/src/shared/Other.luau': [{ range: range(0, 0, 0, 0), newText: '--x\n' }] } }
      }
    ])
    assert.deepEqual(req.params.context.diagnostics, [unused], 'only diagnostics overlapping the range')
    assert.equal(req.params.context.triggerKind, 1)
    const { actions } = await pending
    const [fix, extract, missing] = actions
    assert.equal(fix.kind, 'quickfix')
    assert.equal(fix.isPreferred, true)
    assert.equal(fix.diagnostics[0].startColumn, 7)
    assert.deepEqual(fix.edit.edits.map((e: any) => [e.resource.toString(), e.textEdit.text]), [['file:///src/shared/A.luau', '_']])

    // codeAction/resolve fills Monaco's own action object (Monaco only copies `edit` back).
    assert.equal(extract.edit, undefined)
    const resolving = s.providers.codeAction.resolveCodeAction(extract, token)
    const resolveReq = await s.answer('codeAction/resolve', {
      title: 'Extract to local variable',
      kind: 'refactor.extract',
      data: { uri: A_URI, type: 'extractVariable', range: range(1, 6, 1, 10) },
      edit: { changes: { [A_URI]: [{ range: range(1, 0, 1, 0), newText: 'local extracted = Util\n' }] } },
      command: { title: 'Rename Symbol', command: 'luau-lsp.rename', arguments: [A_URI, { line: 1, character: 6 }] }
    })
    assert.equal(resolveReq.params.data.type, 'extractVariable')
    const resolved = await resolving
    assert.equal(resolved, extract)
    assert.equal(extract.edit.edits[0].textEdit.text, 'local extracted = Util\n')
    assert.deepEqual(extract.command, { id: 'luau-lsp.rename', title: 'Rename Symbol', arguments: [A_URI, { line: 1, character: 6 }] })
    assert.ok(s.commands['luau-lsp.rename'], 'luau-lsp.rename is a registered command')

    // An edit reaching a file without a model runs through the client's own command.
    assert.equal(missing.edit, undefined)
    assert.equal(missing.command.id, 'luau-lsp.forge.applyWorkspaceEdit')
    await s.commands[missing.command.id](null, ...missing.command.arguments)
    assert.deepEqual(s.a.pushed, [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: 'local X = 1\n', forceMoveMarkers: true }])
    assert.deepEqual(written, [{ path: 'src/shared/Other.luau', edits: [{ range: range(0, 0, 0, 0), newText: '--x\n' }] }])
  } finally {
    stopLuauLsp()
  }
})

test('workspace/applyEdit from the server edits models and files', async () => {
  const written: any[] = []
  const s = await boot({ applyFileEdits: async (path: string, edits: any[]) => void written.push({ path, edits }) })
  try {
    s.deliver({
      jsonrpc: '2.0',
      id: 'apply-1',
      method: 'workspace/applyEdit',
      params: {
        label: 'insert end',
        edit: {
          documentChanges: [
            { textDocument: { uri: B_URI, version: 1 }, edits: [{ range: range(1, 0, 1, 0), newText: 'end\n' }] },
            { textDocument: { uri: 'file:///work/game/src/x.luau', version: null }, edits: [{ range: range(0, 0, 0, 0), newText: 'y' }] }
          ]
        }
      }
    })
    for (let i = 0; i < 5; i++) await tick()
    assert.deepEqual(s.sent.find((m) => m.id === 'apply-1'), { jsonrpc: '2.0', id: 'apply-1', result: { applied: true } })
    assert.equal(s.b.pushed[0].text, 'end\n')
    assert.deepEqual(written.map((w) => w.path), ['src/x.luau'])
  } finally {
    stopLuauLsp()
  }
})

test('symbols, references, type definition, links, folding, colours', async () => {
  const s = await boot()
  try {
    let pending = s.providers.symbols.provideDocumentSymbols(s.a, token)
    await s.answer('textDocument/documentSymbol', [
      {
        name: 'greet',
        detail: 'function (name)',
        kind: 12,
        range: range(2, 0, 4, 3),
        selectionRange: range(2, 15, 2, 20),
        children: [{ name: 'name', kind: 13, range: range(2, 20, 2, 34), selectionRange: range(2, 21, 2, 25) }]
      }
    ])
    const [greet] = await pending
    assert.equal(greet.kind, 11, 'Monaco SymbolKind.Function')
    assert.equal(greet.children[0].kind, 12, 'Monaco SymbolKind.Variable')
    assert.deepEqual(greet.selectionRange, { startLineNumber: 3, startColumn: 16, endLineNumber: 3, endColumn: 21 })
    assert.equal(toMonacoSymbolKind(1), 0)

    pending = s.providers.references.provideReferences(s.a, { lineNumber: 2, column: 8 }, { includeDeclaration: true }, token)
    const refReq = await s.answer('textDocument/references', [
      { uri: A_URI, range: range(0, 6, 0, 10) },
      { uri: 'file:///work/game/src/other.luau', range: range(4, 0, 4, 4) }
    ])
    assert.deepEqual(refReq.params.context, { includeDeclaration: true })
    const refs = await pending
    assert.equal(refs[0].uri.toString(), 'file:///src/shared/A.luau', 'open documents map to their model')
    assert.equal(refs[1].uri.toString(), 'file:///work/game/src/other.luau')

    pending = s.providers.typeDefinition.provideTypeDefinition(s.a, { lineNumber: 1, column: 7 }, token)
    await s.answer('textDocument/typeDefinition', [{ targetUri: B_URI, targetRange: range(0, 0, 3, 0), targetSelectionRange: range(1, 5, 1, 9) }])
    const [typeDef] = await pending
    assert.equal(typeDef.uri.toString(), 'file:///src/shared/B.luau')
    assert.equal(typeDef.range.startColumn, 6)

    pending = s.providers.links.provideLinks(s.a, token)
    await s.answer('textDocument/documentLink', [{ range: range(0, 18, 0, 36), target: 'file:///work/game/src/shared/Util.luau' }, { range: range(1, 0, 1, 1) }])
    const { links } = await pending
    assert.equal(links.length, 1)
    assert.equal(links[0].url.toString(), 'file:///work/game/src/shared/Util.luau')

    pending = s.providers.folding.provideFoldingRanges(s.a, {}, token)
    await s.answer('textDocument/foldingRange', [
      { startLine: 2, endLine: 3 },
      { startLine: 5, endLine: 8, kind: 'comment' },
      { startLine: 9, endLine: 9 }
    ])
    assert.deepEqual(await pending, [
      { start: 3, end: 4, kind: undefined },
      { start: 6, end: 9, kind: { value: 'comment' } }
    ])

    pending = s.providers.color.provideDocumentColors(s.a, token)
    await s.answer('textDocument/documentColor', [{ color: { red: 1, green: 0, blue: 0, alpha: 1 }, range: range(6, 10, 6, 29) }])
    const [color] = await pending
    assert.deepEqual(color.color, { red: 1, green: 0, blue: 0, alpha: 1 })
    pending = s.providers.color.provideColorPresentations(s.a, color, token)
    const presReq = await s.answer('textDocument/colorPresentation', [
      { label: 'Color3.new(1, 0, 0)', textEdit: { range: range(6, 10, 6, 29), newText: 'Color3.new(1, 0, 0)' } }
    ])
    assert.deepEqual(presReq.params.range, range(6, 10, 6, 29))
    const [presentation] = await pending
    assert.equal(presentation.textEdit.text, 'Color3.new(1, 0, 0)')
  } finally {
    stopLuauLsp()
  }
})

test('edit helpers', () => {
  assert.equal(
    applyTextEdits('local a = 1\nprint(a)\n', [
      { range: range(1, 6, 1, 7), newText: 'b' },
      { range: range(0, 6, 0, 7), newText: 'b' },
      { range: range(0, 0, 0, 0), newText: '--!strict\n' }
    ]),
    '--!strict\nlocal b = 1\nprint(b)\n'
  )
  assert.equal(applyTextEdits('a\r\nb', [{ range: range(0, 1, 0, 99), newText: 'x' }]), 'ax\r\nb', 'clamped before CRLF')
  assert.equal(applyTextEdits('x', [{ range: range(5, 0, 5, 0), newText: '\ny' }]), 'x\ny', 'past the end appends')
  const { byUri, unsupported } = workspaceEditByUri({
    documentChanges: [{ textDocument: { uri: 'a', version: 1 }, edits: [{ range: range(0, 0, 0, 0), newText: 'x' }] }, { kind: 'create', uri: 'b' }]
  })
  assert.equal(byUri.get('a')?.length, 1)
  assert.equal(unsupported, 1)
})
