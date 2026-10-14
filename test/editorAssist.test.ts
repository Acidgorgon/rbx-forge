// Editor assist: autosave policy, format-on-save rules, the minimal single edit, StyLua argument
// building and the stdin runner (fake stylua), completion prompt building / trimming / cleaning,
// secret guards, provider selection and charging (fake fetch), and the spending-cap pause.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { effectiveEditorAssist, minimalEdit, normalizeEditorAssist, shouldAutoSave, shouldFormatOnSave } from '../src/shared/editorAssist/policy.ts'
import { DEFAULT_EDITOR_ASSIST } from '../src/shared/editorAssist/types.ts'
import { isUnknownFlag, styluaArgs, styluaError } from '../src/shared/editorAssist/stylua.ts'
import {
  buildCompletionPrompt,
  cleanCompletion,
  cursorAllowsSuggestion,
  CURSOR,
  isSecretPath,
  looksSecret,
  MAX_PREFIX_CHARS,
  MAX_SUFFIX_CHARS,
  requireLines,
  trimPrefix,
  trimSuffix
} from '../src/shared/editorAssist/completion.ts'
import { formatWithStylua, keepLineEndings } from '../src/main/services/editorAssist/format.ts'
import { ANTHROPIC_COMPLETION_MODEL, completionBlock, InlineCompletions, NEEDS_PROVIDER, OPENAI_COMPLETION_MODEL, type CompletionDeps } from '../src/main/services/editorAssist/completions.ts'
import { createEditorAssistWiring, EDITOR_ASSIST_SETTING } from '../src/main/services/editorAssist/wire.ts'
import { sourceOfRecord } from '../src/main/services/spend/gate.ts'
import type { UsageRecord } from '../src/main/agent/budget/usage.ts'

// ---------------------------------------------------------------- settings + autosave policy

test('editor assist settings: defaults (autosave on focus change, format on autosave off, automatic toggles) and normalisation', () => {
  assert.deepEqual(normalizeEditorAssist(null), DEFAULT_EDITOR_ASSIST)
  assert.equal(DEFAULT_EDITOR_ASSIST.autoSave, 'onFocusChange')
  assert.equal(DEFAULT_EDITOR_ASSIST.formatOnAutoSave, false)
  const n = normalizeEditorAssist({ autoSave: 'sometimes', autoSaveDelayMs: 5, formatOnSave: 'yes', aiCompletions: false, formatOnAutoSave: true })
  assert.equal(n.autoSave, 'onFocusChange')
  assert.equal(n.autoSaveDelayMs, 200)
  assert.equal(n.formatOnSave, null)
  assert.equal(n.aiCompletions, false)
  assert.equal(n.formatOnAutoSave, true)
  assert.equal(normalizeEditorAssist({ autoSaveDelayMs: 1e9 }).autoSaveDelayMs, 60_000)
  // Automatic: format on save follows StyLua, completions follow provider readiness; explicit wins.
  assert.deepEqual(effectiveEditorAssist(DEFAULT_EDITOR_ASSIST, true, false), { formatOnSave: true, aiCompletions: false })
  assert.deepEqual(effectiveEditorAssist(DEFAULT_EDITOR_ASSIST, false, true), { formatOnSave: false, aiCompletions: true })
  assert.deepEqual(effectiveEditorAssist({ ...DEFAULT_EDITOR_ASSIST, formatOnSave: false, aiCompletions: false }, true, true), { formatOnSave: false, aiCompletions: false })
})

test('autosave: which trigger saves in which mode; never clean, loading or conflicted files', () => {
  const dirty = { path: 'src/a.luau', dirty: true }
  for (const t of ['tabSwitch', 'editorBlur', 'windowBlur'] as const) {
    assert.equal(shouldAutoSave('onFocusChange', t, dirty), true, t)
    assert.equal(shouldAutoSave('afterDelay', t, dirty), false, t)
    assert.equal(shouldAutoSave('off', t, dirty), false, t)
  }
  assert.equal(shouldAutoSave('afterDelay', 'delay', dirty), true)
  assert.equal(shouldAutoSave('onFocusChange', 'delay', dirty), false)
  assert.equal(shouldAutoSave('off', 'delay', dirty), false)
  assert.equal(shouldAutoSave('onFocusChange', 'tabSwitch', { ...dirty, dirty: false }), false)
  assert.equal(shouldAutoSave('onFocusChange', 'tabSwitch', { ...dirty, loading: true }), false)
  // A held Studio / Forge Sync conflict waits for the user to pick a side.
  assert.equal(shouldAutoSave('onFocusChange', 'windowBlur', { ...dirty, conflicted: true }), false)
  assert.equal(shouldAutoSave('afterDelay', 'delay', { ...dirty, conflicted: true }), false)
  assert.equal(shouldAutoSave('onFocusChange', 'editorBlur', { ...dirty, readOnly: true }), false)
})

test('format on save: Luau/Lua only, manual saves, autosave only when asked', () => {
  const base = { path: 'src/a.luau', formatOnSave: true, formatOnAutoSave: false }
  assert.equal(shouldFormatOnSave({ ...base, reason: 'manual' }), true)
  assert.equal(shouldFormatOnSave({ ...base, reason: 'auto' }), false)
  assert.equal(shouldFormatOnSave({ ...base, reason: 'auto', formatOnAutoSave: true }), true)
  assert.equal(shouldFormatOnSave({ ...base, reason: 'manual', path: 'src/B.LUA' }), true)
  assert.equal(shouldFormatOnSave({ ...base, reason: 'manual', path: 'events.blink' }), false)
  assert.equal(shouldFormatOnSave({ ...base, reason: 'manual', path: 'default.project.json' }), false)
  assert.equal(shouldFormatOnSave({ ...base, reason: 'manual', formatOnSave: false }), false)
})

test('minimalEdit: one replacement by common prefix/suffix; applying it gives the target', () => {
  const apply = (from: string, e: ReturnType<typeof minimalEdit>) => (e ? from.slice(0, e.start) + e.text + from.slice(e.end) : from)
  const cases: [string, string][] = [
    ['local x = {1,2}\nprint( x )\n', 'local x = { 1, 2 }\nprint(x)\n'],
    ['a', 'a\n'],
    ['abc\n', ''],
    ['', 'new\n'],
    ['same\nend\n', 'same\nend\n'],
    ['x = 1\r\ny = 2\r\n', 'x = 1\r\n\r\ny = 2\r\n'],
    ['-- 😀 a', '-- 😀 b'],
    ['aaaa', 'aa']
  ]
  for (const [from, to] of cases) {
    const e = minimalEdit(from, to)
    assert.equal(apply(from, e), to, JSON.stringify([from, to]))
  }
  assert.equal(minimalEdit('same', 'same'), null)
  const e = minimalEdit('local a = 1\nlocal b=2\nlocal c = 3\n', 'local a = 1\nlocal b = 2\nlocal c = 3\n')!
  assert.ok(e.start >= 'local a = 1\nlocal b'.length && e.end <= 'local a = 1\nlocal b=2'.length, 'only the changed span is replaced')
  // Never splits a CRLF pair.
  const crlf = minimalEdit('a\r\nb', 'a\nb')!
  assert.ok(!(crlf.start > 0 && 'a\r\nb'[crlf.start - 1] === '\r' && 'a\r\nb'[crlf.start] === '\n'))
})

// ---------------------------------------------------------------- StyLua

test('styluaArgs: stdin with the repo path (forward slashes), --respect-ignores unless disabled, optional config', () => {
  assert.deepEqual(styluaArgs('src\\server\\A.server.luau'), ['--stdin-filepath', 'src/server/A.server.luau', '--respect-ignores', '-'])
  assert.deepEqual(styluaArgs('./src/a.luau', { respectIgnores: false }), ['--stdin-filepath', 'src/a.luau', '-'])
  assert.deepEqual(styluaArgs('src/a.luau', { configPath: 'C:\\proj\\stylua.toml' }), ['--stdin-filepath', 'src/a.luau', '--config-path', 'C:\\proj\\stylua.toml', '--respect-ignores', '-'])
  assert.equal(isUnknownFlag("error: unexpected argument '--respect-ignores' found", '--respect-ignores'), true)
  assert.equal(isUnknownFlag('error: Found argument \'--respect-ignores\' which wasn\'t expected, or isn\'t valid in this context', '--respect-ignores'), true)
  assert.equal(isUnknownFlag('error parsing: unexpected token', '--respect-ignores'), false)
  assert.match(styluaError('error: could not format from stdin: failed to format from stdin: error parsing: \n - unexpected token `(` (1:11 to 1:12), expected an expression\n', 2), /could not parse the file: unexpected token `\(`/)
  assert.equal(styluaError('', 3), 'StyLua exited with code 3')
})

function fakeStylua(dir: string, body: string): string {
  const file = join(dir, 'stylua')
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

test('formatWithStylua: stdin in, stdout out, args and cwd; errors and timeouts leave the text alone', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stylua-'))
  // Echoes the args and cwd as a comment, then the input with trailing spaces stripped.
  const ok = fakeStylua(dir, `echo "-- $* @ $(pwd)"; sed 's/[ ]*$//'`)
  const r = await formatWithStylua(dir, 'src/a.luau', 'local x = 1   \n', { findTool: () => ok, env: process.env })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.match(r.text, /^-- --stdin-filepath src\/a\.luau --respect-ignores - @ /)
    assert.ok(r.text.includes(dir), 'runs in the project root (rokit picks the pinned version there)')
    assert.ok(r.text.endsWith('local x = 1\n'))
  }
  const missing = await formatWithStylua(dir, 'src/a.luau', 'x', { findTool: () => null })
  assert.deepEqual(missing.ok, false)
  assert.equal(!missing.ok && missing.missing, true)
  const parse = fakeStylua(join(mkdtempSync(join(tmpdir(), 'stylua-')), ''), `cat >/dev/null; echo "error: could not format from stdin: error parsing:" >&2; echo " - unexpected token \\\`(\\\`" >&2; exit 2`)
  const bad = await formatWithStylua(dir, 'src/a.luau', 'local x = (', { findTool: () => parse, env: process.env })
  assert.equal(bad.ok, false)
  assert.match(!bad.ok ? bad.error : '', /could not parse the file: unexpected token/)
  const slow = fakeStylua(mkdtempSync(join(tmpdir(), 'stylua-')), 'sleep 5; cat')
  const t = Date.now()
  const timedOut = await formatWithStylua(dir, 'src/a.luau', 'x = 1\n', { findTool: () => slow, env: process.env, timeoutMs: 300 })
  assert.equal(timedOut.ok, false)
  assert.match(!timedOut.ok ? timedOut.error : '', /longer than/)
  assert.ok(Date.now() - t < 3000)
  // Old StyLua without --respect-ignores: retried without it.
  const old = fakeStylua(mkdtempSync(join(tmpdir(), 'stylua-')), `for a in "$@"; do if [ "$a" = "--respect-ignores" ]; then echo "error: unexpected argument '--respect-ignores' found" >&2; exit 2; fi; done; cat`)
  const retried = await formatWithStylua(dir, 'src/a.luau', 'x = 1\n', { findTool: () => old, env: process.env })
  assert.deepEqual(retried, { ok: true, text: 'x = 1\n' })
  // Empty output for a non-empty buffer is refused (never wipes the file).
  const empty = fakeStylua(mkdtempSync(join(tmpdir(), 'stylua-')), 'cat >/dev/null')
  const wiped = await formatWithStylua(dir, 'src/a.luau', 'x = 1\n', { findTool: () => empty, env: process.env })
  assert.equal(wiped.ok, false)
})

test('keepLineEndings: a CRLF buffer stays CRLF, an LF buffer stays LF', () => {
  assert.equal(keepLineEndings('a\r\nb\r\n', 'a\nb\n'), 'a\r\nb\r\n')
  assert.equal(keepLineEndings('a\nb\n', 'a\nb\n'), 'a\nb\n')
  assert.equal(keepLineEndings('a\r\nb', 'a\r\nb\r\n'), 'a\r\nb\r\n')
})

// ---------------------------------------------------------------- completion prompt

test('secret guards: .env / key / credential files and credential-shaped text are never sent', () => {
  for (const p of ['.env', '.env.local', 'config/.env.production', 'prod.env', 'secrets.json', '.secret', 'keys/id_rsa', 'server.pem', 'api.key', 'cert.p12', '.npmrc', 'tokens.json', 'credentials.toml', 'secrets/config.luau', '.ssh/config', 'my_api_key.txt'])
    assert.equal(isSecretPath(p), true, p)
  for (const p of ['src/server/Services/TokenService.luau', 'src/shared/SecretDoor.lua', 'src/client/Env.luau', 'default.project.json', 'events.blink', 'src/a.luau'])
    assert.equal(isSecretPath(p), false, p)
  assert.equal(looksSecret('local KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz123456"'), true)
  assert.equal(looksSecret('local t = "ghp_' + 'a'.repeat(36) + '"'), true)
  assert.equal(looksSecret('-----BEGIN RSA PRIVATE KEY-----'), true)
  assert.equal(looksSecret('_|WARNING:-DO-NOT-SHARE-THIS.--Sharing-this-will-allow'), true)
  assert.equal(looksSecret('local Players = game:GetService("Players")'), false)
})

test('trimPrefix / trimSuffix keep a short window at line boundaries', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `local v${i} = ${i}`).join('\n')
  const p = trimPrefix(lines)
  assert.ok(p.length <= MAX_PREFIX_CHARS)
  assert.ok(lines.endsWith(p))
  assert.ok(p.startsWith('local v'), 'starts on a whole line')
  const s = trimSuffix(lines)
  assert.ok(s.length <= MAX_SUFFIX_CHARS)
  assert.ok(lines.startsWith(s))
  assert.ok(/\d$/.test(s), 'ends on a whole line')
  assert.equal(trimPrefix('short'), 'short')
  assert.equal(trimSuffix('short'), 'short')
  // One huge line: cut by characters.
  assert.equal(trimPrefix('x'.repeat(10_000)).length, MAX_PREFIX_CHARS)
})

test('requireLines + buildCompletionPrompt: path, requires outside the window, cursor marker', () => {
  const text = 'local Players = game:GetService("Players")\nlocal Signal = require(ReplicatedStorage.Packages.Signal)\n-- local Old = require(x)\nlocal Util = require(script.Parent.Util)\nlocal Util = require(script.Parent.Util)\n'
  assert.deepEqual(requireLines(text), ['local Signal = require(ReplicatedStorage.Packages.Signal)', 'local Util = require(script.Parent.Util)'])
  const prompt = buildCompletionPrompt({ path: 'src\\server\\Inventory.luau', languageId: 'luau', prefix: 'local Util = require(script.Parent.Util)\nlocal function add(a, b)\n\treturn ', suffix: '\nend\n', requires: requireLines(text) })
  assert.match(prompt.user, /^File: src\/server\/Inventory\.luau \(luau\)/)
  assert.ok(prompt.user.includes(`\treturn ${CURSOR}\nend\n`))
  assert.ok(prompt.user.includes('local Signal = require(ReplicatedStorage.Packages.Signal)'), 'a require outside the window is listed')
  assert.equal(prompt.user.split('local Util = require(script.Parent.Util)').length - 1, 1, 'a require already in the window is not repeated')
  assert.match(prompt.system, /ONLY the text to insert/)
  const big = buildCompletionPrompt({ path: 'a.luau', languageId: 'luau', prefix: 'x\n'.repeat(5000), suffix: 'y\n'.repeat(5000) })
  assert.ok(big.user.length < MAX_PREFIX_CHARS + MAX_SUFFIX_CHARS + 500)
})

test('cleanCompletion: fences, repeated line start, suffix echo, line cap, empty', () => {
  const ctx = { prefix: 'local function add(a, b)\n\treturn ', suffix: '\nend\n' }
  assert.equal(cleanCompletion('```lua\na + b\n```', ctx), 'a + b')
  assert.equal(cleanCompletion('\treturn a + b', ctx), 'a + b')
  assert.equal(cleanCompletion('return a + b', ctx), 'a + b')
  assert.equal(cleanCompletion('a + b\nend', { prefix: ctx.prefix, suffix: '\nend\nreturn M\n' }), 'a + b\nend', 'a 3-char line is too short to treat as an echo')
  assert.equal(cleanCompletion('a + b\nreturn Module', { prefix: ctx.prefix, suffix: '\nend\nreturn Module\n' }), 'a + b')
  // The repeated `print(` is dropped and the closing bracket after the cursor is not doubled.
  assert.equal(cleanCompletion('print("hi")', { prefix: 'print(', suffix: ')' }), '"hi"')
  assert.equal(cleanCompletion('"hi")', { prefix: 'print(', suffix: ')' }), '"hi"')
  assert.equal(cleanCompletion(`a${CURSOR} + b`, ctx), 'a + b')
  assert.equal(cleanCompletion('   \n ', ctx), '')
  assert.equal(cleanCompletion(Array.from({ length: 20 }, (_, i) => `x${i}`).join('\n'), ctx).split('\n').length, 8)
  // Starting an indented empty line: the model's own indentation is not doubled.
  assert.equal(cleanCompletion('\tlocal y = 2', { prefix: 'do\n\t', suffix: '\nend' }), 'local y = 2')
  assert.equal(cursorAllowsSuggestion(''), true)
  assert.equal(cursorAllowsSuggestion(')'), true)
  assert.equal(cursorAllowsSuggestion('  }) '), true)
  assert.equal(cursorAllowsSuggestion('foo)'), false)
})

// ---------------------------------------------------------------- providers + charging

function fakeFetch(handler: (url: string, body: any, headers: Record<string, string>) => { status?: number; json: unknown }) {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = []
  const fn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    const headers = init.headers as Record<string, string>
    calls.push({ url, body, headers })
    const r = handler(url, body, headers)
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fn, calls }
}

function deps(over: Partial<CompletionDeps> & { keys?: Partial<Record<'openai' | 'anthropic', string>> } = {}): CompletionDeps & { records: UsageRecord[] } {
  const records: UsageRecord[] = []
  return {
    getKey: async (p) => over.keys?.[p] ?? null,
    blocked: () => null,
    record: (r) => records.push(r),
    records,
    ...over
  }
}

const REQ = { id: 'r1', path: 'src/server/A.luau', languageId: 'luau', prefix: 'local function add(a, b)\n\treturn ', suffix: '\nend\n' }

test('inline completions: OpenAI key first (small fast model, no reasoning), usage charged as editor completions', async () => {
  const f = fakeFetch(() => ({ json: { choices: [{ message: { content: 'a + b' } }], usage: { prompt_tokens: 1000, completion_tokens: 10 } } }))
  const d = deps({ keys: { openai: 'sk-test', anthropic: 'sk-ant-test' }, fetchFn: f.fn })
  const c = new InlineCompletions(d)
  const r = await c.complete(REQ)
  assert.equal(r.text, 'a + b')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, 'https://api.openai.com/v1/chat/completions')
  assert.equal(f.calls[0].body.model, OPENAI_COMPLETION_MODEL)
  assert.equal(f.calls[0].body.reasoning_effort, 'none')
  assert.equal(f.calls[0].headers.Authorization, 'Bearer sk-test')
  assert.ok(f.calls[0].body.messages[1].content.includes(CURSOR))
  assert.equal(d.records.length, 1)
  assert.equal(d.records[0].source, 'completions')
  assert.equal(d.records[0].provider, 'openai')
  assert.ok((d.records[0].costUsd ?? 0) > 0)
  assert.equal(sourceOfRecord(d.records[0]), 'completions')
  const s = await c.status()
  assert.equal(s.ready, true)
  assert.equal(s.provider, 'openai')
})

test('inline completions: Anthropic key -> Haiku on the Messages API', async () => {
  const f = fakeFetch(() => ({ json: { content: [{ type: 'text', text: 'a + b' }], usage: { input_tokens: 800, output_tokens: 6 } } }))
  const d = deps({ keys: { anthropic: 'sk-ant-test' }, fetchFn: f.fn })
  const r = await new InlineCompletions(d).complete(REQ)
  assert.equal(r.text, 'a + b')
  assert.equal(f.calls[0].url, 'https://api.anthropic.com/v1/messages')
  assert.equal(f.calls[0].body.model, ANTHROPIC_COMPLETION_MODEL)
  assert.equal(f.calls[0].headers['x-api-key'], 'sk-ant-test')
  assert.equal(d.records[0].provider, 'anthropic')
  assert.equal(d.records[0].input, 800)
})

test('inline completions: no provider (Claude login only) -> not ready, says what to add; extra backend seam is used', async () => {
  const none = new InlineCompletions(deps({ claudeLoginOnly: async () => true }))
  const s = await none.status()
  assert.equal(s.ready, false)
  assert.ok(s.detail.startsWith(NEEDS_PROVIDER))
  assert.match(s.detail, /too slow/)
  assert.deepEqual(await none.complete(REQ), { text: '', note: NEEDS_PROVIDER })
  const codex = new InlineCompletions(
    deps({ extraBackends: async () => ({ id: 'codex', label: 'Codex', model: 'codex-mini', complete: async () => ({ text: 'a + b' }) }) })
  )
  assert.equal((await codex.status()).provider, 'codex')
  assert.equal((await codex.complete(REQ)).text, 'a + b')
})

test('inline completions: secret files and credential-shaped text are not sent; caps pause; cancel aborts', async () => {
  const f = fakeFetch(() => ({ json: { choices: [{ message: { content: 'x' } }] } }))
  const d = deps({ keys: { openai: 'sk-test' }, fetchFn: f.fn })
  const c = new InlineCompletions(d)
  assert.deepEqual(await c.complete({ ...REQ, path: '.env' }), { text: '' })
  assert.deepEqual(await c.complete({ ...REQ, prefix: 'local KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123"\n' }), { text: '' })
  assert.equal(f.calls.length, 0)
  const capped = new InlineCompletions({ ...d, blocked: () => 'AI completions paused: cap' })
  assert.deepEqual(await capped.complete(REQ), { text: '', note: 'AI completions paused: cap' })
  assert.equal(f.calls.length, 0)
  assert.equal((await capped.status()).paused, 'AI completions paused: cap')
  // Cancel: the in-flight fetch is aborted and nothing is shown or charged.
  let aborted = false
  const slow = (async (_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        aborted = true
        reject(new Error('aborted'))
      })
    })) as unknown as typeof fetch
  const d2 = deps({ keys: { openai: 'sk-test' }, fetchFn: slow })
  const c2 = new InlineCompletions(d2)
  const pending = c2.complete({ ...REQ, id: 'x' })
  setTimeout(() => c2.cancel('x'), 20)
  assert.deepEqual(await pending, { text: '' })
  assert.equal(aborted, true)
  assert.equal(d2.records.length, 0)
  // HTTP errors come back as a note, not an exception.
  const err = fakeFetch(() => ({ status: 401, json: { error: 'bad key' } }))
  const r = await new InlineCompletions(deps({ keys: { openai: 'sk-bad' }, fetchFn: err.fn })).complete(REQ)
  assert.equal(r.text, '')
  assert.match(r.note ?? '', /HTTP 401/)
})

test('completionBlock: spending cap first, then the daily budget', () => {
  assert.equal(completionBlock(null, 1, undefined), null)
  assert.equal(completionBlock(null, 0.5, 1), null)
  assert.match(completionBlock(null, 1.2, 1) ?? '', /daily budget/)
  assert.match(completionBlock('Daily cap of $5.00 reached', 0, 1) ?? '', /^AI completions paused: Daily cap/)
})

test('editor assist wiring: settings persist normalised, status resolves automatic toggles, format needs a project', async () => {
  const store: Record<string, unknown> = {}
  const emitted: unknown[] = []
  let root: string | null = null
  const w = createEditorAssistWiring({
    root: () => root,
    getSetting: (k, f) => (k in store ? (store[k] as never) : f),
    setSetting: (k, v) => void (store[k] = v),
    emit: (s) => void emitted.push(s),
    completions: deps({ keys: { openai: 'sk' } }),
    format: { findTool: () => null }
  })
  const s0 = await w.status()
  assert.deepEqual(s0.effective, { formatOnSave: false, aiCompletions: true })
  assert.equal(s0.stylua.found, false)
  const s1 = (await w.handlers.editorAssistSetSettings({ autoSave: 'afterDelay', aiCompletions: false, bogus: 1 })) as Awaited<ReturnType<typeof w.status>>
  assert.equal(s1.settings.autoSave, 'afterDelay')
  assert.equal(s1.effective.aiCompletions, false)
  assert.deepEqual(Object.keys(store[EDITOR_ASSIST_SETTING] as object).sort(), Object.keys(DEFAULT_EDITOR_ASSIST).sort())
  assert.equal(emitted.length, 1)
  assert.deepEqual(await w.handlers.formatLuau('src/a.luau', 'x'), { ok: false, error: 'No project is open.' })
  root = '/tmp'
  const missing = (await w.handlers.formatLuau('src/a.luau', 'x')) as { ok: boolean; missing?: boolean }
  assert.equal(missing.missing, true)
})
