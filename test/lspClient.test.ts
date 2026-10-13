import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Connection, ResponseError } from '../src/renderer/src/lsp/connection.ts'
import {
  fileUri,
  normaliseUri,
  relativePath,
  toLspPosition,
  toMarkdown,
  toMarkerSeverity,
  toMonacoCompletionKind,
  toMonacoRange
} from '../src/renderer/src/lsp/convert.ts'
import { startLuauLsp, stopLuauLsp } from '../src/renderer/src/lsp/index.ts'

function pipe() {
  const sent: any[] = []
  let handler: (m: unknown) => void = () => undefined
  return {
    sent,
    transport: {
      send: (m: unknown) => sent.push(m),
      listen: (h: (m: unknown) => void) => {
        handler = h
        return () => (handler = () => undefined)
      }
    },
    deliver: (m: unknown) => handler(m)
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('ranges and positions: LSP 0-based <-> Monaco 1-based', () => {
  assert.deepEqual(toMonacoRange({ start: { line: 0, character: 0 }, end: { line: 2, character: 5 } }), {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 3,
    endColumn: 6
  })
  assert.deepEqual(toLspPosition({ lineNumber: 10, column: 4 }), { line: 9, character: 3 })
})

test('kinds, severities, markdown', () => {
  const monacoKinds = { Method: 0, Function: 1, Variable: 4, Keyword: 17, Text: 18, Snippet: 27 }
  assert.equal(toMonacoCompletionKind(3, monacoKinds), 1)
  assert.equal(toMonacoCompletionKind(14, monacoKinds), 17)
  assert.equal(toMonacoCompletionKind(undefined, monacoKinds), 18)
  assert.equal(toMarkerSeverity(1), 8)
  assert.equal(toMarkerSeverity(2), 4)
  assert.equal(toMarkerSeverity(4), 1)
  assert.deepEqual(toMarkdown({ kind: 'markdown', value: '**x**' }), [{ value: '**x**' }])
  assert.deepEqual(toMarkdown({ language: 'luau', value: 'local x' }), [{ value: '```luau\nlocal x\n```' }])
  assert.deepEqual(toMarkdown(['a', '']), [{ value: 'a' }])
})

test('file URIs', () => {
  assert.equal(fileUri('/Users/me/My Game'), 'file:///Users/me/My%20Game')
  assert.equal(fileUri('C:\\Games\\GenTree'), 'file:///C:/Games/GenTree')
  assert.equal(normaliseUri('file:///c%3A/Games/x.luau'), normaliseUri('file:///C:/Games/x.luau'))
  assert.equal(relativePath('file:///Users/me/My%20Game', 'file:///Users/me/My%20Game/src/a.luau'), 'src/a.luau')
  assert.equal(relativePath('file:///C:/Games/GenTree', 'file:///c%3A/games/gentree/src/a.luau'), 'src/a.luau')
  assert.equal(relativePath('file:///Users/me/game', 'file:///Users/me/other/a.luau'), null)
})

test('connection: requests, responses, server requests, cancellation', async () => {
  const p = pipe()
  const c = new Connection(p.transport)
  const answer = c.request('hover', { a: 1 })
  assert.deepEqual(p.sent[0], { jsonrpc: '2.0', id: 1, method: 'hover', params: { a: 1 } })
  p.deliver({ jsonrpc: '2.0', id: 1, result: { ok: true } })
  assert.deepEqual(await answer, { ok: true })

  const failing = c.request('x')
  p.deliver({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'nope' } })
  await assert.rejects(failing, (e) => e instanceof ResponseError && e.code === -32601)

  c.onRequest('workspace/configuration', () => [{ a: 1 }])
  p.deliver({ jsonrpc: '2.0', id: 77, method: 'workspace/configuration', params: {} })
  p.deliver({ jsonrpc: '2.0', id: 78, method: 'unknown/thing', params: {} })
  await tick()
  assert.deepEqual(p.sent.find((m) => m.id === 77), { jsonrpc: '2.0', id: 77, result: [{ a: 1 }] })
  assert.equal(p.sent.find((m) => m.id === 78).error.code, -32601)

  let cancel: () => void = () => undefined
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (l: () => void) => ((cancel = l), { dispose: () => undefined })
  }
  const cancelled = c.request('slow', {}, token)
  cancel()
  await assert.rejects(cancelled, (e) => e instanceof ResponseError && e.code === -32800)
  assert.deepEqual(p.sent.at(-1), { jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 3 } })

  const pending = c.request('later')
  c.rejectPending()
  await assert.rejects(pending)
})

// --- a small fake of the Monaco API surface the client uses

function fakeMonaco() {
  const listeners = { create: [] as any[], dispose: [] as any[], language: [] as any[] }
  const models: any[] = []
  const markers = new Map<string, any[]>()
  const providers: Record<string, any> = {}
  const openers: any[] = []
  const uri = (path: string) => ({ scheme: 'file', path: '/' + path, toString: () => 'file:///' + path })
  const monaco: any = {
    Uri: { parse: (s: string) => ({ scheme: 'file', path: s.replace(/^file:\/\//, ''), toString: () => s }) },
    MarkerTag: { Unnecessary: 1, Deprecated: 2 },
    editor: {
      getModels: () => models,
      getModel: (u: any) => models.find((m) => m.uri.toString() === u.toString()) ?? null,
      onDidCreateModel: (l: any) => (listeners.create.push(l), { dispose() {} }),
      onWillDisposeModel: (l: any) => (listeners.dispose.push(l), { dispose() {} }),
      onDidChangeModelLanguage: (l: any) => (listeners.language.push(l), { dispose() {} }),
      setModelMarkers: (model: any, _owner: string, list: any[]) => markers.set(model.uri.toString(), list),
      registerEditorOpener: (o: any) => (openers.push(o), { dispose() {} })
    },
    languages: {
      CompletionItemKind: { Method: 0, Function: 1, Variable: 4, Keyword: 17, Text: 18 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      CompletionItemTag: { Deprecated: 1 },
      registerCompletionItemProvider: (_l: string, p: any) => ((providers.completion = p), { dispose() {} }),
      registerHoverProvider: (_l: string, p: any) => ((providers.hover = p), { dispose() {} }),
      registerSignatureHelpProvider: (_l: string, p: any) => ((providers.signature = p), { dispose() {} }),
      registerDefinitionProvider: (_l: string, p: any) => ((providers.definition = p), { dispose() {} }),
      registerDocumentFormattingEditProvider: (_l: string, p: any) => ((providers.format = p), { dispose() {} }),
      registerDocumentRangeFormattingEditProvider: (_l: string, p: any) => ((providers.rangeFormat = p), { dispose() {} })
    }
  }
  const addModel = (path: string, text: string) => {
    let version = 1
    let value = text
    const changeListeners: any[] = []
    const model = {
      uri: uri(path),
      getLanguageId: () => 'luau',
      getValue: () => value,
      getVersionId: () => version,
      isDisposed: () => false,
      getWordUntilPosition: (pos: any) => ({ word: '', startColumn: pos.column, endColumn: pos.column }),
      onDidChangeContent: (l: any) => (changeListeners.push(l), { dispose() {} }),
      edit: (next: string, change: any) => {
        value = next
        version++
        for (const l of changeListeners) l({ changes: [change], isFlush: false })
      }
    }
    models.push(model)
    for (const l of listeners.create) l(model)
    return model
  }
  return { monaco, addModel, markers, providers, openers }
}

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }

test('client: initialize, sync, diagnostics, completion, definition, configuration', async () => {
  const p = pipe()
  const fake = fakeMonaco()
  const existing = fake.addModel('src/shared/A.luau', 'local a = 1')
  const opened: any[] = []
  let started = 0
  startLuauLsp(fake.monaco, {
    rootUri: 'file:///work/game',
    openPath: (path, position) => opened.push({ path, position }),
    transport: { ...p.transport, start: async () => (started++, true) }
  })
  await tick()
  await tick()
  try {
    assert.equal(started, 1)
    const init = p.sent.find((m) => m.method === 'initialize')
    assert.equal(init.params.rootUri, 'file:///work/game')
    assert.equal(init.params.capabilities.workspace.configuration, true)
    assert.equal(init.params.capabilities.textDocument.diagnostic, undefined, 'push diagnostics')
    p.deliver({
      jsonrpc: '2.0',
      id: init.id,
      result: {
        capabilities: {
          textDocumentSync: { openClose: true, change: 2 },
          completionProvider: { triggerCharacters: ['.', ':', '\n'], resolveProvider: false },
          hoverProvider: true,
          signatureHelpProvider: { triggerCharacters: ['(', ','] },
          definitionProvider: true
        }
      }
    })
    await tick()
    assert.ok(p.sent.some((m) => m.method === 'initialized'))
    const didOpen = p.sent.find((m) => m.method === 'textDocument/didOpen')
    assert.equal(didOpen.params.textDocument.uri, 'file:///work/game/src/shared/A.luau')
    assert.equal(didOpen.params.textDocument.text, 'local a = 1')
    assert.equal(fake.providers.format, undefined, 'no formatting provider when the server has none')
    assert.deepEqual(fake.providers.completion.triggerCharacters, ['.', ':'])

    // Incremental change, 1-based Monaco range -> 0-based LSP range.
    existing.edit('local ab = 1', {
      range: { startLineNumber: 1, startColumn: 8, endLineNumber: 1, endColumn: 8 },
      text: 'b'
    })
    const didChange = p.sent.find((m) => m.method === 'textDocument/didChange')
    assert.deepEqual(didChange.params.contentChanges, [
      { range: { start: { line: 0, character: 7 }, end: { line: 0, character: 7 } }, text: 'b' }
    ])
    assert.equal(didChange.params.textDocument.version, 2)

    // workspace/configuration
    p.deliver({ jsonrpc: '2.0', id: 500, method: 'workspace/configuration', params: { items: [{ section: 'luau-lsp' }, { section: 'other' }] } })
    p.deliver({ jsonrpc: '2.0', id: 501, method: 'window/workDoneProgress/create', params: { token: 't' } })
    await tick()
    const config = p.sent.find((m) => m.id === 500).result
    assert.equal(config[0].platform.type, 'roblox')
    assert.equal(config[0].sourcemap.enabled, true)
    assert.equal(config[1], null)
    assert.deepEqual(p.sent.find((m) => m.id === 501), { jsonrpc: '2.0', id: 501, result: null })

    // Diagnostics -> markers
    p.deliver({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: 'file:///work/game/src/shared/A.luau',
        diagnostics: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 8 } }, severity: 2, message: 'unused', code: 'LocalUnused' }]
      }
    })
    const markers = fake.markers.get('file:///src/shared/A.luau')!
    assert.equal(markers.length, 1)
    assert.equal(markers[0].startColumn, 7)
    assert.equal(markers[0].severity, 4)

    // Completion
    const completion = fake.providers.completion.provideCompletionItems(existing, { lineNumber: 1, column: 3 }, { triggerKind: 1, triggerCharacter: '.' }, token)
    await tick()
    const req = p.sent.find((m) => m.method === 'textDocument/completion')
    assert.deepEqual(req.params.position, { line: 0, character: 2 })
    assert.deepEqual(req.params.context, { triggerKind: 2, triggerCharacter: '.' })
    p.deliver({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        isIncomplete: false,
        items: [
          { label: 'print', kind: 3, insertText: 'print($1)', insertTextFormat: 2, documentation: { kind: 'markdown', value: 'Prints' } },
          { label: 'local', kind: 14, textEdit: { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: 'local' } }
        ]
      }
    })
    const list = await completion
    assert.equal(list.suggestions[0].kind, 1)
    assert.equal(list.suggestions[0].insertTextRules, 4)
    assert.deepEqual(list.suggestions[0].documentation, { value: 'Prints' })
    assert.deepEqual(list.suggestions[1].range, { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 })

    // Definition into an unopened file, then the opener hands it to openPath.
    const definition = fake.providers.definition.provideDefinition(existing, { lineNumber: 1, column: 1 }, token)
    await tick()
    const defReq = p.sent.find((m) => m.method === 'textDocument/definition')
    p.deliver({
      jsonrpc: '2.0',
      id: defReq.id,
      result: [{ uri: 'file:///work/game/src/server/B.luau', range: { start: { line: 4, character: 2 }, end: { line: 4, character: 5 } } }]
    })
    const locations = await definition
    assert.equal(locations[0].uri.toString(), 'file:///work/game/src/server/B.luau')
    const handled = fake.openers[0].openCodeEditor({ getModel: () => existing }, locations[0].uri, locations[0].range)
    assert.equal(handled, true)
    assert.deepEqual(opened, [{ path: 'src/server/B.luau', position: { lineNumber: 5, column: 3 } }])

    // Server restart: the client initializes again and reopens documents.
    const before = p.sent.length
    p.deliver({ jsonrpc: '2.0', method: 'harness/lspRestarted', params: { rootUri: 'file:///work/game' } })
    await tick()
    const reinit = p.sent.slice(before).find((m) => m.method === 'initialize')
    assert.ok(reinit)
    p.deliver({ jsonrpc: '2.0', id: reinit.id, result: { capabilities: { textDocumentSync: 2 } } })
    await tick()
    assert.ok(p.sent.slice(before).some((m) => m.method === 'textDocument/didOpen'))
  } finally {
    stopLuauLsp()
  }
})

test('client stays idle when lspStart() is false (preview mock)', async () => {
  const p = pipe()
  const fake = fakeMonaco()
  startLuauLsp(fake.monaco, { rootUri: 'file:///x', transport: { ...p.transport, start: async () => false } })
  await tick()
  assert.equal(p.sent.length, 0)
  stopLuauLsp()
})
