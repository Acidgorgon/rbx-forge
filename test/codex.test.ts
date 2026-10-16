// Codex (ChatGPT plan) through the official Codex CLI: binary lookup, login status parsing, exec
// argument building, the --json event stream, the chat runner, image collection, and the Art /
// texture image backend. Real-process tests use a fake `codex` sh script (skipped on Windows).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { codexDirs, findCodex, loginUrl, parseLoginStatus, parseVersion } from '../src/main/agent/codex/binary.ts'
import { buildExecArgs, CODEX_DEFAULT_MODEL, codexEnv } from '../src/main/agent/codex/args.ts'
import { CodexEventMapper, LineSplitter, type CodexUpdate } from '../src/main/agent/codex/events.ts'
import { CodexService, codexHome, type CliRunner } from '../src/main/agent/codex/service.ts'
import { codexPrompt, codexSandboxFor, projectBrief } from '../src/main/agent/codex/chat.ts'
import { collectImages, generateWithCodex, imagePrompt, shapeOf } from '../src/main/agent/codex/images.ts'
import type { ToolContext } from '../src/main/services/tools.ts'
import { fakeContext } from './agentFake.ts'
import { ChatManager } from '../src/main/agent/chat.ts'
import { Credentials } from '../src/main/agent/credentials.ts'
import { SYSTEM_PROMPT } from '../src/main/agent/sdk.ts'
import { encodePng } from '../src/main/services/vfx/textures/png.ts'
import { ArtService } from '../src/main/services/art/service.ts'
import type { CodexImages } from '../src/main/services/art/imageBackend.ts'
import { CODEX_IMAGE_MODEL } from '../src/shared/artTypes.ts'
import { Providers } from '../src/main/agent/providers.ts'

const shOnly = { skip: process.platform === 'win32' ? 'fake codex is a sh script' : false }

async function until(fn: () => boolean, ms = 10000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

function toolCtx(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string, exists: string[]): ToolContext {
  const set = new Set(exists)
  return { platform, env, home, isExecutable: (f) => set.has(f), listDir: () => [] }
}

function png(w = 4, h = 4): Buffer {
  return encodePng({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(200) } as any)
}

// ---------------------------------------------------------------- binary

test('findCodex: Windows npm global shim (%APPDATA%\\npm\\codex.cmd) when PATH lacks it', () => {
  const env = { APPDATA: 'C:\\Users\\Acid\\AppData\\Roaming', Path: 'C:\\Windows\\System32', PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  const shim = path.win32.join('C:\\Users\\Acid\\AppData\\Roaming', 'npm', 'codex.cmd')
  assert.equal(findCodex(toolCtx('win32', env, 'C:\\Users\\Acid', [shim])), shim)
  // The sh shim npm also writes (no extension) and codex.ps1 are never picked.
  const bare = path.win32.join('C:\\Users\\Acid\\AppData\\Roaming', 'npm', 'codex')
  assert.equal(findCodex(toolCtx('win32', env, 'C:\\Users\\Acid', [bare, bare + '.ps1'])), null)
})

test('findCodex: PATH first, then Homebrew / ~/.npm-global on a Mac; an override wins', () => {
  const home = '/Users/acid'
  assert.equal(findCodex(toolCtx('darwin', { PATH: '/usr/bin:/bin' }, home, ['/opt/homebrew/bin/codex'])), '/opt/homebrew/bin/codex')
  assert.equal(findCodex(toolCtx('darwin', { PATH: '/usr/bin:/bin' }, home, [`${home}/.npm-global/bin/codex`])), `${home}/.npm-global/bin/codex`)
  assert.equal(findCodex(toolCtx('darwin', { PATH: '/custom/bin:/usr/bin' }, home, ['/custom/bin/codex', '/opt/homebrew/bin/codex'])), '/custom/bin/codex')
  assert.equal(findCodex(toolCtx('darwin', { PATH: '/usr/bin' }, home, ['/x/codex', '/opt/homebrew/bin/codex']), '/x/codex'), '/x/codex')
  assert.equal(findCodex(toolCtx('darwin', { PATH: '/usr/bin' }, home, ['/opt/homebrew/bin/codex']), '/missing/codex'), '/opt/homebrew/bin/codex')
  assert.equal(findCodex(toolCtx('linux', { PATH: '/usr/bin' }, '/home/a', [])), null)
  assert.ok(codexDirs(toolCtx('darwin', { npm_config_prefix: '/opt/npm' }, home, [])).includes('/opt/npm/bin'))
})

test('parseLoginStatus / parseVersion / loginUrl', () => {
  assert.deepEqual(parseLoginStatus(0, 'Logged in using ChatGPT\n'), { loggedIn: true, method: 'chatgpt', detail: 'Signed in with ChatGPT' })
  const key = parseLoginStatus(0, 'Logged in using an API key - sk-proj-***abcd\n')
  assert.equal(key.method, 'apikey')
  assert.ok(!key.detail.includes('sk-'), 'the masked key is not echoed')
  assert.equal(parseLoginStatus(1, 'Not logged in\n').loggedIn, false)
  assert.equal(parseLoginStatus(1, 'Error checking login status: boom').loggedIn, false)
  assert.equal(parseLoginStatus(0, 'WARNING: something\r\nLogged in using ChatGPT\r\n').method, 'chatgpt')
  assert.equal(parseVersion('codex-cli 0.140.0\n'), '0.140.0')
  assert.equal(parseVersion('nothing'), null)
  assert.equal(loginUrl('If your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?client_id=x&y=1\n'), 'https://auth.openai.com/oauth/authorize?client_id=x&y=1')
})

// ---------------------------------------------------------------- args

test('buildExecArgs: JSON, sandbox, cwd, prompt on stdin; model, resume and images', () => {
  assert.deepEqual(buildExecArgs({ cwd: '/p', sandbox: 'workspace-write' }), ['exec', '--json', '--color', 'never', '--sandbox', 'workspace-write', '--cd', '/p', '--skip-git-repo-check', '--', '-'])
  assert.deepEqual(buildExecArgs({ cwd: '/p', sandbox: 'read-only', model: CODEX_DEFAULT_MODEL }).includes('--model'), false)
  const a = buildExecArgs({ cwd: 'C:\\My Projects\\game', sandbox: 'workspace-write', model: 'gpt-6.1-sol', resumeId: '0199-abc', images: ['/i/a.png', '/i/b.png'], ephemeral: true })
  assert.deepEqual(a.slice(9), ['--model', 'gpt-6.1-sol', '--ephemeral', 'resume', '0199-abc', '--image', '/i/a.png', '--image', '/i/b.png', '--', '-'])
  assert.equal(a[8 - 1], 'C:\\My Projects\\game', 'paths with spaces stay one argument')
  // --image takes 1.. values split on ',': a comma would split a path.
  assert.throws(() => buildExecArgs({ cwd: '/p', sandbox: 'read-only', images: ['/a,b.png'] }), /comma/)
  // A thread id that is not a plain token is not passed on.
  assert.equal(buildExecArgs({ cwd: '/p', sandbox: 'read-only', resumeId: '--last; rm' }).includes('resume'), false)
})

test('codexEnv: drops OPENAI_API_KEY / CODEX_API_KEY so the ChatGPT plan is used', () => {
  const env = codexEnv({ PATH: '/bin', OPENAI_API_KEY: 'sk-1', codex_api_key: 'sk-2', OTHER: 'x' })
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.codex_api_key, undefined)
  assert.equal(env.OTHER, 'x')
  assert.equal(env.NO_COLOR, '1')
})

test('codexSandboxFor: Ask / Plan read-only, Edit / Auto workspace-write (never full access)', () => {
  assert.equal(codexSandboxFor('ask'), 'read-only')
  assert.equal(codexSandboxFor('plan'), 'read-only')
  assert.equal(codexSandboxFor('edit'), 'workspace-write')
  assert.equal(codexSandboxFor('auto'), 'workspace-write')
})

test('codexPrompt: a fresh thread gets the project brief, rules and transcript; a resumed one only the message', () => {
  const fresh = codexPrompt({ text: 'add a coin', mode: 'edit', rules: '# Rules\nno comments', fresh: true, transcript: 'User: hi', basePrompt: SYSTEM_PROMPT })
  assert.ok(fresh.includes('Project layout'))
  assert.ok(!fresh.includes('mcp__gentree__'), 'tool advice for Forge tools is left out')
  assert.ok(fresh.includes('no comments') && fresh.includes('User: hi') && fresh.endsWith('New message:\nadd a coin'))
  assert.equal(codexPrompt({ text: 'next', mode: 'edit', rules: 'x', fresh: false, transcript: 'y', basePrompt: SYSTEM_PROMPT }), 'next')
  assert.ok(codexPrompt({ text: 'q', mode: 'ask', rules: '', fresh: false, transcript: '', basePrompt: SYSTEM_PROMPT }).startsWith('# Mode: Ask'))
  assert.ok(!projectBrief(SYSTEM_PROMPT).includes('Working rules'))
})

// ---------------------------------------------------------------- events

test('CodexEventMapper: text, tool chips, usage, thread id, failures', () => {
  const m = new CodexEventMapper('/proj')
  const out: CodexUpdate[] = []
  const feed = (e: unknown) => out.push(...m.line(JSON.stringify(e)))
  feed({ type: 'thread.started', thread_id: 't-1' })
  feed({ type: 'turn.started' })
  feed({ type: 'item.started', item: { id: 'item_0', type: 'reasoning', text: 'thinking' } })
  feed({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc ls', aggregated_output: '', exit_code: null, status: 'in_progress' } })
  feed({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc ls', aggregated_output: 'src\n', exit_code: 0, status: 'completed' } })
  feed({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: '/proj/src/shared/Coin.luau', kind: 'add' }], status: 'completed' } })
  feed({ type: 'item.completed', item: { id: 'item_3', type: 'command_execution', command: 'false', aggregated_output: 'nope', exit_code: 1, status: 'failed' } })
  feed({ type: 'item.completed', item: { id: 'item_4', type: 'mcp_tool_call', server: 'docs', tool: 'search', arguments: { q: 'x' }, result: { content: [{ type: 'text', text: 'hit' }] }, error: null, status: 'completed' } })
  feed({ type: 'item.updated', item: { id: 'item_5', type: 'todo_list', items: [{ text: 'a', completed: true }, { text: 'b', completed: false }] } })
  feed({ type: 'item.completed', item: { id: 'item_6', type: 'agent_message', text: 'Added Coin.' } })
  feed({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 5 } })
  assert.equal(m.threadId, 't-1')
  assert.equal(m.lastMessage, 'Added Coin.')
  assert.deepEqual(m.usage, { input: 100, cachedInput: 40, output: 15 })
  assert.deepEqual(out[0], { kind: 'thread', threadId: 't-1' })
  const tools = out.filter((u): u is Extract<CodexUpdate, { kind: 'tool' }> => u.kind === 'tool')
  assert.equal(tools[0].key, tools[1].key, 'start and completion update one chip')
  assert.equal(tools[0].done, false)
  assert.equal(tools[1].text, 'src')
  assert.equal(tools[2].name, 'apply_patch')
  assert.equal(tools[2].text, 'add src/shared/Coin.luau', 'paths relative to the project')
  assert.ok(tools[3].error && tools[3].text.startsWith('Error: exit 1'))
  assert.equal(tools[4].name, 'docs.search')
  assert.equal(tools[4].text, 'hit')
  assert.ok(out.some((u) => u.kind === 'notice' && u.text === '[x] a\n[ ] b'))
  assert.ok(!out.some((u) => u.kind === 'text' && u.text === 'thinking'), 'reasoning is not shown')

  const f = new CodexEventMapper()
  assert.deepEqual(f.line('{"type":"error","message":"Reconnecting... 1/5"}'), [{ kind: 'notice', key: 'reconnect', text: 'Reconnecting... 1/5' }])
  assert.equal(f.failed, null)
  assert.deepEqual(f.line('{"type":"turn.failed","error":{"message":"usage limit reached"}}'), [{ kind: 'error', message: 'usage limit reached' }])
  assert.equal(f.failed, 'usage limit reached')
  assert.deepEqual(f.line('not json'), [])
  assert.deepEqual(f.line('{"type":"item.completed","item":{"id":"x","type":"future_thing"}}'), [])
})

test('LineSplitter: CRLF and partial chunks', () => {
  const s = new LineSplitter()
  assert.deepEqual(s.push('{"a":1}\r\n{"b"'), ['{"a":1}'])
  assert.deepEqual(s.push(':2}\n'), ['{"b":2}'])
  assert.deepEqual(s.push('tail'), [])
  assert.deepEqual(s.end(), ['tail'])
})

// ---------------------------------------------------------------- service with a fake runner (all platforms)

function scripted(lines: unknown[], o: { code?: number; stderr?: string } = {}): { run: CliRunner; calls: { args: string[]; stdin?: string; env: NodeJS.ProcessEnv }[] } {
  const calls: { args: string[]; stdin?: string; env: NodeJS.ProcessEnv }[] = []
  const run: CliRunner = async (opts) => {
    calls.push({ args: opts.args, stdin: opts.stdin, env: opts.env })
    if (opts.args[0] === 'login' && opts.args[1] === 'status') return { code: 0, stderr: 'Logged in using ChatGPT\n', aborted: false, timedOut: false }
    if (opts.args[0] === '--version') {
      opts.onStdoutLine?.('codex-cli 0.140.0')
      return { code: 0, stderr: '', aborted: false, timedOut: false }
    }
    for (const l of lines) opts.onStdoutLine?.(typeof l === 'string' ? l : JSON.stringify(l))
    return { code: o.code ?? 0, stderr: o.stderr ?? '', aborted: false, timedOut: false }
  }
  return { run, calls }
}

test('CodexService.status: installed, version, signed in; cached until refresh', async () => {
  const s = scripted([])
  const svc = new CodexService({ findBin: () => '/bin/codex', run: s.run, env: () => ({ OPENAI_API_KEY: 'sk-x' }) })
  const st = await svc.status()
  assert.deepEqual({ installed: st.installed, loggedIn: st.loggedIn, method: st.method, version: st.version }, { installed: true, loggedIn: true, method: 'chatgpt', version: '0.140.0' })
  await svc.status()
  assert.equal(s.calls.length, 2, 'second call is cached')
  await svc.status({ refresh: true })
  assert.equal(s.calls.length, 4)
  assert.equal(s.calls[0].env.OPENAI_API_KEY, undefined, 'API keys never reach codex')
  const missing = new CodexService({ findBin: () => null })
  const m = await missing.status()
  assert.equal(m.installed, false)
  assert.match((await missing.notReady())!, /not found.*npm i -g @openai\/codex/)
})

test('ChatManager on codex: streams messages, resumes the thread, records plan usage at $0', async () => {
  const s = scripted([
    { type: 'thread.started', thread_id: 'th-9' },
    { type: 'item.completed', item: { id: 'item_1', type: 'file_change', changes: [{ path: '/fake/project/src/shared/a.luau', kind: 'update' }], status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Edited a.luau.' } },
    { type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0 } }
  ])
  const svc = new CodexService({ findBin: () => '/bin/codex', run: s.run, env: () => ({}) })
  const fake = fakeContext({ files: { 'src/shared/a.luau': 'x\n' } })
  const credentials = new Credentials(fake.ctx, async () => null, {})
  const chats = new ChatManager(fake.ctx, { credentials, toolFs: fake.fs, checkpoints: null, codex: () => svc } as any)
  const c = chats.create({ provider: 'codex', model: 'codex-default' })
  await chats.send(c.id, 'edit a')
  await until(() => !chats.busy(c.id))
  const msgs = chats.messages(c.id)!
  assert.ok(msgs.some((m) => m.role === 'tool' && m.tool?.name === 'apply_patch' && m.text === 'update src/shared/a.luau'))
  assert.ok(msgs.some((m) => m.role === 'assistant' && m.text === 'Edited a.luau.'))
  assert.ok(msgs.some((m) => m.role === 'system' && /no per-edit approval/.test(m.text)), 'Edit mode explains that Codex edits directly')
  const exec1 = s.calls.find((x) => x.args[0] === 'exec')!
  assert.ok(exec1.args.includes('workspace-write'))
  assert.equal(exec1.args[exec1.args.indexOf('--cd') + 1], '/fake/project')
  assert.ok(!exec1.args.includes('resume'))
  assert.ok(exec1.stdin!.includes('New message:\nedit a'))
  const session = chats.list().find((x) => x.id === c.id)!
  assert.equal(session.usage?.[0].costUsd, 0)
  assert.equal(session.usage?.[0].provider, 'codex')

  await chats.setMode(c.id, 'ask')
  await chats.send(c.id, 'what changed?')
  await until(() => !chats.busy(c.id))
  const exec2 = s.calls.filter((x) => x.args[0] === 'exec')[1]
  assert.deepEqual(exec2.args.slice(exec2.args.indexOf('resume'), exec2.args.indexOf('resume') + 2), ['resume', 'th-9'])
  assert.ok(exec2.args.includes('read-only'), 'Ask mode is read-only')
  assert.ok(exec2.stdin!.startsWith('# Mode: Ask') && exec2.stdin!.endsWith('what changed?'))
})

test('ChatManager on codex: not signed in -> a notice with a Settings link, no run', async () => {
  const svc = new CodexService({ findBin: () => null })
  const fake = fakeContext()
  const credentials = new Credentials(fake.ctx, async () => null, {})
  const chats = new ChatManager(fake.ctx, { credentials, toolFs: fake.fs, checkpoints: null, codex: () => svc } as any)
  const c = chats.create({ provider: 'codex', model: 'codex-default' })
  await chats.send(c.id, 'hi')
  const last = chats.messages(c.id)!.at(-1)!
  assert.equal(last.settingsLink, 'codex')
  assert.match(last.text, /Codex CLI not found/)
  assert.equal(chats.busy(c.id), false)
  // Codex can be a guest too (test/codexGuests.test.ts); adding one never throws over IPC.
  assert.equal(chats.addGuest(chats.create().id, { provider: 'codex', model: 'codex-default' }).guests?.[0].provider, 'codex')
})

test('ChatManager on codex: a stale thread id starts a fresh thread; turn errors are shown once', async () => {
  let n = 0
  const calls: string[][] = []
  const run: CliRunner = async (o) => {
    if (o.args[1] === 'status') return { code: 0, stderr: 'Logged in using ChatGPT', aborted: false, timedOut: false }
    if (o.args[0] !== 'exec') return { code: 0, stderr: '', aborted: false, timedOut: false }
    calls.push(o.args)
    n++
    if (n === 1) {
      o.onStdoutLine?.(JSON.stringify({ type: 'thread.started', thread_id: 'old' }))
      o.onStdoutLine?.(JSON.stringify({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'one' } }))
      return { code: 0, stderr: '', aborted: false, timedOut: false }
    }
    if (n === 2) return { code: 1, stderr: 'Error: no rollout found for thread id old', aborted: false, timedOut: false }
    o.onStdoutLine?.(JSON.stringify({ type: 'thread.started', thread_id: 'new' }))
    o.onStdoutLine?.(JSON.stringify({ type: 'turn.failed', error: { message: 'You have hit your usage limit' } }))
    return { code: 1, stderr: '', aborted: false, timedOut: false }
  }
  const svc = new CodexService({ findBin: () => '/bin/codex', run, env: () => ({}) })
  const fake = fakeContext()
  const chats = new ChatManager(fake.ctx, { credentials: new Credentials(fake.ctx, async () => null, {}), toolFs: fake.fs, checkpoints: null, codex: () => svc } as any)
  const c = chats.create({ provider: 'codex', model: 'gpt-6.1-sol' })
  await chats.send(c.id, 'first')
  await until(() => !chats.busy(c.id))
  await chats.send(c.id, 'second')
  await until(() => !chats.busy(c.id))
  assert.equal(calls.length, 3)
  assert.ok(calls[1].includes('resume'))
  assert.ok(!calls[2].includes('resume'), 'retried without resume')
  assert.deepEqual(calls[2].slice(calls[2].indexOf('--model'), calls[2].indexOf('--model') + 2), ['--model', 'gpt-6.1-sol'])
  const errors = chats.messages(c.id)!.filter((m) => m.role === 'system' && m.text.startsWith('Error:'))
  assert.deepEqual(errors.map((m) => m.text), ['Error: You have hit your usage limit'])
})

test('Providers: codex is ready only when installed and signed in; it has no endpoint', async () => {
  const fake = fakeContext()
  const s = scripted([])
  const svc = new CodexService({ findBin: () => '/bin/codex', run: s.run, env: () => ({}) })
  const p = new Providers(fake.ctx, new Credentials(fake.ctx, async () => null, {}), undefined, () => svc)
  const info = await p.info('codex')
  assert.equal(info.ready, true)
  assert.equal(info.codex?.method, 'chatgpt')
  assert.ok(info.models.includes('codex-default'))
  assert.ok('error' in (await p.endpoint('codex')))
  const off = new Providers(fake.ctx, new Credentials(fake.ctx, async () => null, {}), undefined, () => new CodexService({ findBin: () => null }))
  assert.equal((await off.info('codex')).ready, false)
})

// ---------------------------------------------------------------- images

test('imagePrompt / shapeOf', () => {
  const p = imagePrompt({ prompt: 'a coin', n: 9, size: '1536x1024', transparent: true }, ['reference-1.png'])
  assert.ok(p.startsWith('$imagegen'))
  assert.ok(p.includes('4 separate images'), 'capped at 4')
  assert.ok(p.includes('landscape (1536x1024)') && p.includes('transparent_background') && p.includes('reference-1.png') && p.includes('a coin'))
  assert.equal(shapeOf('1024x1024'), 'square')
  assert.equal(shapeOf('1024x1536'), 'portrait')
  assert.equal(shapeOf('auto'), null)
})

test('collectImages: the thread folder under $CODEX_HOME/generated_images, else the scratch folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-img-'))
  try {
    const home = join(dir, 'home')
    const scratch = join(dir, 'scratch')
    await mkdir(join(home, 'generated_images', 't1'), { recursive: true })
    await mkdir(scratch, { recursive: true })
    await writeFile(join(home, 'generated_images', 't1', 'call_a.png'), png())
    await writeFile(join(scratch, 'reference-1.png'), png())
    assert.deepEqual(await collectImages({ home, threadId: 't1', saved: [], scratch, refNames: ['reference-1.png'] }), [join(home, 'generated_images', 't1', 'call_a.png')])
    assert.deepEqual(await collectImages({ home, threadId: 'none', saved: [], scratch, refNames: ['reference-1.png'] }), [])
    await writeFile(join(scratch, 'out.png'), png())
    assert.deepEqual(await collectImages({ home, threadId: null, saved: [], scratch, refNames: ['reference-1.png'] }), [join(scratch, 'out.png')])
    assert.deepEqual(await collectImages({ home, threadId: '../x', saved: [], scratch, refNames: ['reference-1.png', 'out.png'] }), [])
    assert.equal(codexHome({ CODEX_HOME: '/h' }), '/h')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('generateWithCodex: read-only run in a scratch folder with references; reads the thread images', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-gen-'))
  try {
    const home = join(dir, 'codexhome')
    let seen: { args: string[]; stdin?: string; refs: string[] } | null = null
    const run: CliRunner = async (o) => {
      if (o.args[1] === 'status') return { code: 0, stderr: 'Logged in using ChatGPT', aborted: false, timedOut: false }
      if (o.args[0] !== 'exec') return { code: 0, stderr: '', aborted: false, timedOut: false }
      const { readdir } = await import('node:fs/promises')
      seen = { args: o.args, stdin: o.stdin, refs: await readdir(o.cwd) }
      o.onStdoutLine?.(JSON.stringify({ type: 'thread.started', thread_id: 'img-1' }))
      await mkdir(join(home, 'generated_images', 'img-1'), { recursive: true })
      await writeFile(join(home, 'generated_images', 'img-1', 'c1.png'), png(8, 8))
      await writeFile(join(home, 'generated_images', 'img-1', 'c2.png'), png(8, 8))
      return { code: 0, stderr: '', aborted: false, timedOut: false }
    }
    const svc = new CodexService({ findBin: () => '/bin/codex', run, env: () => ({ CODEX_HOME: home }) })
    const r = await generateWithCodex(svc, { prompt: 'shiny coin', n: 6, size: '1024x1024', references: [`data:image/png;base64,${png().toString('base64')}`] }, { tmpDir: dir })
    assert.equal(r.images.length, 2)
    assert.ok(r.notes.some((x) => /at most 4/.test(x)) && r.notes.some((x) => /returned 2 of 4/.test(x)))
    assert.ok(seen!.args.includes('read-only'))
    assert.deepEqual(seen!.refs, ['reference-1.png'])
    assert.ok(seen!.stdin!.includes('shiny coin'))
    // The scratch folder is removed afterwards.
    const left = (await import('node:fs/promises')).readdir(dir)
    assert.deepEqual((await left).filter((x) => x.startsWith('forge-codex-img-')), [])

    const none: CliRunner = async (o) => {
      if (o.args[1] === 'status') return { code: 0, stderr: 'Logged in using ChatGPT', aborted: false, timedOut: false }
      if (o.args[0] === 'exec') o.onStdoutLine?.(JSON.stringify({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'Image generation is not available on your plan.' } }))
      return { code: 0, stderr: '', aborted: false, timedOut: false }
    }
    const svc2 = new CodexService({ findBin: () => '/bin/codex', run: none, env: () => ({ CODEX_HOME: home }) })
    await assert.rejects(generateWithCodex(svc2, { prompt: 'x', n: 1 }, { tmpDir: dir }), /did not produce an image: Image generation is not available/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ArtService on the codex backend: no key, no cost, no budget; masks refused clearly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-art-'))
  try {
    const store = new Map<string, unknown>()
    const reqs: any[] = []
    const codex: CodexImages = {
      status: async () => ({ ready: true, detail: 'Signed in with ChatGPT' }),
      generate: async (req) => {
        reqs.push(req)
        return { images: [png(16, 16)], notes: [] }
      }
    }
    const svc = new ArtService({
      root: () => root,
      scope: () => 's',
      settings: { get: (k, f) => (store.has(k) ? (store.get(k) as any) : f), set: (k, v) => void store.set(k, v) },
      openAiKey: async () => null,
      robloxKey: async () => null,
      trashDir: join(root, '.trash'),
      codex
    })
    let status = await svc.setSettings({ backend: 'codex', dailyCapUsd: 0.01 })
    assert.equal(status.settings.backend, 'codex')
    assert.deepEqual(status.codex, { ready: true, detail: 'Signed in with ChatGPT' })
    const est = await svc.estimate({ prompt: 'coin', n: 3 })
    assert.equal(est.totalUsd, 0)
    const items = await svc.generate({ prompt: 'coin icon', n: 2, transparent: true })
    assert.equal(items.length, 1)
    assert.equal(items[0].costUsd, 0)
    assert.equal(items[0].model, CODEX_IMAGE_MODEL)
    assert.equal(items[0].width, 16)
    assert.ok(existsSync(items[0].absPath))
    assert.equal(reqs[0].transparent, true)
    assert.equal(reqs[0].n, 2)
    await assert.rejects(svc.generate({ prompt: 'x', referencePaths: [items[0].path], maskPath: items[0].path }), /Masks need the OpenAI API/)
    status = await svc.setSettings({ backend: 'api' })
    assert.equal(status.settings.backend, undefined)
    assert.equal(status.codex, undefined)
    await assert.rejects(svc.generate({ prompt: 'x' }), /No OpenAI API key/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- the real process (fake codex script)

async function fakeCodex(): Promise<{ dir: string; bin: string; state: string; home: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-fake-'))
  const state = join(dir, 'state')
  const home = join(dir, 'home')
  await mkdir(state, { recursive: true })
  await writeFile(join(state, 'img.png'), png(6, 6))
  const bin = join(dir, 'codex')
  await writeFile(
    bin,
    `#!/bin/sh
S="${state}"
case "$1" in
  --version) echo "codex-cli 0.140.0"; exit 0 ;;
  login)
    if [ "$2" = "status" ]; then
      if [ -f "$S/loggedin" ]; then echo "Logged in using ChatGPT" >&2; exit 0; fi
      echo "Not logged in" >&2; exit 1
    fi
    # 0.140.0 predates --device-auth: the service falls back to the browser login.
    if [ "$2" = "--device-auth" ]; then echo "error: unexpected argument '--device-auth' found" >&2; exit 2; fi
    echo "If your browser did not open, navigate to this URL to authenticate: https://auth.openai.com/oauth/authorize?state=abc" >&2
    if [ -f "$S/slowlogin" ]; then sleep 30; fi
    touch "$S/loggedin"; echo "Successfully logged in" >&2; exit 0 ;;
  logout) rm -f "$S/loggedin"; exit 0 ;;
  exec)
    printf '%s\\n' "$@" > "$S/args"
    cat > "$S/stdin"
    printf '%s' "$OPENAI_API_KEY" > "$S/key"
    echo '{"type":"thread.started","thread_id":"t-fake"}'
    if grep -q SLOW "$S/stdin"; then sleep 30; fi
    if grep -q imagegen "$S/stdin"; then mkdir -p "$CODEX_HOME/generated_images/t-fake"; cp "$S/img.png" "$CODEX_HOME/generated_images/t-fake/call_1.png"; fi
    echo '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"hello from fake"}}'
    echo '{"type":"turn.completed","usage":{"input_tokens":3,"cached_input_tokens":0,"output_tokens":2,"reasoning_output_tokens":0}}'
    exit 0 ;;
esac
exit 2
`
  )
  await chmod(bin, 0o755)
  return { dir, bin, state, home }
}

test('fake codex: sign in (URL reported), status, exec over stdin, sign out', shOnly, async () => {
  const f = await fakeCodex()
  try {
    const svc = new CodexService({ findBin: () => f.bin, env: () => ({ PATH: process.env.PATH, OPENAI_API_KEY: 'sk-should-not-pass', CODEX_HOME: f.home }), tmpDir: () => f.dir })
    assert.equal((await svc.status()).loggedIn, false)
    const urls: string[] = []
    const r = await svc.signIn({ signal: new AbortController().signal, progress: (u) => u.url && urls.push(u.url) })
    assert.deepEqual(r.ok, true)
    assert.deepEqual(urls, ['https://auth.openai.com/oauth/authorize?state=abc'])
    assert.equal((await svc.status()).loggedIn, true)
    const updates: CodexUpdate[] = []
    const ex = await svc.exec({ cwd: f.dir, prompt: 'say hi\nwith "quotes" & $vars', sandbox: 'workspace-write', onUpdate: (u) => updates.push(u) })
    assert.equal(ex.error, undefined)
    assert.equal(ex.threadId, 't-fake')
    assert.equal(ex.lastMessage, 'hello from fake')
    assert.equal(await readFile(join(f.state, 'stdin'), 'utf8'), 'say hi\nwith "quotes" & $vars')
    assert.equal(await readFile(join(f.state, 'key'), 'utf8'), '', 'OPENAI_API_KEY is stripped')
    assert.ok((await readFile(join(f.state, 'args'), 'utf8')).split('\n').includes('--json'))
    assert.ok(updates.some((u) => u.kind === 'usage'))
    const img = await generateWithCodex(svc, { prompt: 'a gem', n: 1 }, { tmpDir: f.dir, env: { CODEX_HOME: f.home } })
    assert.equal(img.images.length, 1)
    assert.equal((await svc.signOut()).loggedIn, false)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('fake codex: cancel kills the run (process tree) promptly', shOnly, async () => {
  const f = await fakeCodex()
  try {
    await writeFile(join(f.state, 'loggedin'), '')
    const svc = new CodexService({ findBin: () => f.bin, env: () => ({ PATH: process.env.PATH }), tmpDir: () => f.dir })
    const abort = new AbortController()
    const started = Date.now()
    const p = svc.exec({ cwd: f.dir, prompt: 'SLOW', sandbox: 'read-only', signal: abort.signal })
    setTimeout(() => abort.abort(), 300)
    const r = await p
    assert.equal(r.aborted, true)
    assert.ok(Date.now() - started < 8000, `stopped in ${Date.now() - started} ms`)
    // Sign-in cancel too.
    await rm(join(f.state, 'loggedin'))
    await writeFile(join(f.state, 'slowlogin'), '')
    const ctl = new AbortController()
    const s = svc.signIn({ signal: ctl.signal })
    await until(() => svc.signingInNow())
    assert.equal((await svc.signIn({ signal: new AbortController().signal })).ok, false, 'one sign-in at a time')
    setTimeout(() => ctl.abort(), 200)
    const res = await s
    assert.equal(res.ok, false)
    assert.match(res.message!, /cancelled/)
    assert.equal(svc.signingInNow(), false)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('TextureService on the codex backend: no key or budget; a short 2x2 flipbook still fills four frames', async () => {
  const { TextureService } = await import('../src/main/services/vfx/textures/service.ts')
  const dir = await mkdtemp(join(tmpdir(), 'codex-tex-'))
  try {
    const reqs: any[] = []
    const codex: CodexImages = {
      status: async () => ({ ready: true, detail: 'Signed in with ChatGPT' }),
      generate: async (req) => {
        reqs.push(req)
        return { images: [png(64, 64)], notes: ['Codex returned 1 of 4 images.'] }
      }
    }
    // dailyCapUsd 0.0001 would stop any API generation; Codex ignores it.
    const svc = new TextureService({ userDir: dir, projectRoot: () => null, imageSettings: () => ({ model: 'gpt-image-2.5-flare', quality: 'high', dailyCapUsd: 0.0001, backend: 'codex' }), codexImages: codex })
    const st = await svc.status()
    assert.equal(st.codex?.ready, true)
    const [sheet] = await svc.generate({ ai: true, kind: 'wisp', description: 'purple wisp', frames: 4 })
    assert.equal(sheet.flipbook?.frames, 4)
    assert.equal(sheet.model, CODEX_IMAGE_MODEL)
    assert.equal(sheet.costUsd, 0)
    assert.equal(reqs[0].transparent, true)
    assert.equal(reqs[0].n, 4)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
