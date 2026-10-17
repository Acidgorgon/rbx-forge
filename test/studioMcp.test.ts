// Roblox Studio's MCP server for the Assistant (agent/studioMcp.ts, agent/mcpStdio.ts): finding the
// launcher on Windows and macOS (fake file systems), settings precedence (manual > auto > none, off),
// Test connection against a fake stdio MCP server, the OpenAI-compatible bridge, and Codex overrides.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fakeContext } from './agentFake.ts'
import {
  codexStudioConfig,
  detectStudioMcp,
  detectStudioMcpAll,
  noteSdkInit,
  noteStudioConnection,
  openStudioBridge,
  resolveStudioMcp,
  setStudioDetectEnv,
  studioConnection,
  studioMcpHandlers,
  STUDIO_READ_TOOLS,
  testStudioMcp,
  type DetectEnv
} from '../src/main/agent/studioMcp.ts'
import { formatCommand, parseArgs } from '../src/shared/studioMcp.ts'
import { studioMcp, SYSTEM_PROMPT } from '../src/main/agent/sdk.ts'
import { buildExecArgs } from '../src/main/agent/codex/args.ts'
import { codexPrompt } from '../src/main/agent/codex/chat.ts'
import { CodexService, type CliRunner } from '../src/main/agent/codex/service.ts'
import { ChatManager } from '../src/main/agent/chat.ts'
import { Credentials } from '../src/main/agent/credentials.ts'
import { Providers } from '../src/main/agent/providers.ts'
import { runTool } from '../src/main/agent/tools.ts'
import type { QueryFn } from '../src/main/agent/sdk.ts'

const FAKE_SERVER = resolve(import.meta.dirname, 'fixtures', 'mcp', 'fakeStudioMcp.mjs')
const fakeServer = (...extra: string[]) => ({ command: process.execPath, args: [FAKE_SERVER, ...extra] })
const plainSafe = async () => null

afterEach(() => {
  setStudioDetectEnv(null)
  noteStudioConnection(null)
})

// A fake file system: `files` exist (with optional contents), everything else does not.
function fakeEnv(platform: NodeJS.Platform, home: string, files: Record<string, string | true>, env: Record<string, string> = {}): DetectEnv {
  const has = (p: string) => Object.prototype.hasOwnProperty.call(files, p)
  return {
    platform,
    env,
    home,
    exists: (p) => has(p),
    readText: (p) => (has(p) && typeof files[p] === 'string' ? (files[p] as string) : null),
    listDir: (dir) => {
      const sep = platform === 'win32' ? '\\' : '/'
      const out = new Set<string>()
      for (const f of Object.keys(files)) if (f.startsWith(dir + sep)) out.add(f.slice(dir.length + 1).split(sep)[0])
      return [...out]
    }
  }
}

const WIN_HOME = 'C:\\Users\\Acid Gorgon'
const WIN_LOCAL = `${WIN_HOME}\\AppData\\Local`
const WIN_ENV = { LOCALAPPDATA: WIN_LOCAL, APPDATA: `${WIN_HOME}\\AppData\\Roaming` }

// ---------------------------------------------------------------- detection

test('Windows: Studio\'s mcp.bat under %LOCALAPPDATA%\\Roblox runs through cmd.exe /c', () => {
  const bat = `${WIN_LOCAL}\\Roblox\\mcp.bat`
  const hit = detectStudioMcp(fakeEnv('win32', WIN_HOME, { [bat]: true }, WIN_ENV))
  assert.deepEqual(hit, { kind: 'studio', command: 'cmd.exe', args: ['/c', bat], path: bat })
  // Without LOCALAPPDATA in the environment, the default location under the home folder.
  assert.equal(detectStudioMcp(fakeEnv('win32', WIN_HOME, { [bat]: true }))?.path, bat)
  assert.equal(detectStudioMcp(fakeEnv('win32', WIN_HOME, {}, WIN_ENV)), null)
})

test('Windows: a Roblox_Studio entry in Claude Desktop / Cursor config, only when its file exists; built-in wins', () => {
  const exe = 'D:\\Tools\\rbx-studio-mcp.exe'
  const claude = `${WIN_HOME}\\AppData\\Roaming\\Claude\\claude_desktop_config.json`
  const cursor = `${WIN_HOME}\\.cursor\\mcp.json`
  const store = `${WIN_LOCAL}\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json`
  const cfg = (servers: unknown) => JSON.stringify({ mcpServers: servers })
  // A third-party "roblox-studio" server (other tools) is not Roblox's: skipped.
  const files = {
    [claude]: cfg({ 'roblox-studio': { command: 'npx', args: ['-y', 'robloxstudio-mcp'] }, Roblox_Studio: { command: 'C:\\gone\\rbx-studio-mcp.exe', args: ['--stdio'] } }),
    [cursor]: cfg({ other: { command: 'node', args: ['x.js'] }, Roblox_Studio: { command: exe, args: ['--stdio'] } }),
    [exe]: true as const
  }
  const hit = detectStudioMcp(fakeEnv('win32', WIN_HOME, files, WIN_ENV))
  assert.deepEqual(hit, { kind: 'legacy', command: exe, args: ['--stdio'], path: cursor })
  // Studio's Quick connect entry (the docs' JSON, with %LOCALAPPDATA% left for cmd.exe) in the Store app's config.
  const bat = `${WIN_LOCAL}\\Roblox\\mcp.bat`
  const quick = { [store]: cfg({ Roblox_Studio: { command: 'cmd.exe', args: ['/c', '%LOCALAPPDATA%\\Roblox\\mcp.bat'] } }), [bat]: true as const }
  const all = detectStudioMcpAll(fakeEnv('win32', WIN_HOME, quick, WIN_ENV))
  assert.deepEqual(all.map((c) => c.kind), ['studio', 'client'])
  assert.deepEqual(all[1].args, ['/c', '%LOCALAPPDATA%\\Roblox\\mcp.bat'])
  assert.equal(all[1].path, store)
  // The legacy exe in Downloads.
  const dl = `${WIN_HOME}\\Downloads\\rbx-studio-mcp.exe`
  assert.deepEqual(detectStudioMcp(fakeEnv('win32', WIN_HOME, { [dl]: true }, WIN_ENV)), { kind: 'legacy', command: dl, args: ['--stdio'], path: dl })
})

test('macOS: StudioMCP inside RobloxStudio.app, then the legacy RobloxStudioMCP.app; Linux finds nothing', () => {
  const home = '/Users/acid'
  const studio = '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP'
  assert.deepEqual(detectStudioMcp(fakeEnv('darwin', home, { [studio]: true })), { kind: 'studio', command: studio, args: [], path: studio })
  const user = `${home}/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP`
  assert.equal(detectStudioMcp(fakeEnv('darwin', home, { [user]: true }))?.command, user)
  const legacy = '/Applications/RobloxStudioMCP.app/Contents/MacOS/rbx-studio-mcp'
  assert.deepEqual(detectStudioMcp(fakeEnv('darwin', home, { [legacy]: true })), { kind: 'legacy', command: legacy, args: ['--stdio'], path: legacy })
  const claude = `${home}/Library/Application Support/Claude/claude_desktop_config.json`
  const viaClaude = detectStudioMcp(fakeEnv('darwin', home, { [claude]: JSON.stringify({ mcpServers: { Roblox_Studio: { command: studio } } }), [studio]: true }))
  assert.equal(viaClaude?.kind, 'studio', 'the app itself beats the config entry pointing at it')
  assert.equal(detectStudioMcp(fakeEnv('darwin', home, {})), null)
  assert.equal(detectStudioMcp(fakeEnv('linux', '/home/x', { [studio]: true })), null)
})

// ---------------------------------------------------------------- precedence

test('settings precedence: manual > auto > none; studioMcpEnabled false turns Studio tools off', () => {
  const bat = `${WIN_LOCAL}\\Roblox\\mcp.bat`
  const fake = fakeContext()
  const get = <T,>(k: string, f: T) => (fake.settings.has(k) ? (fake.settings.get(k) as T) : f)
  // none
  setStudioDetectEnv(fakeEnv('win32', WIN_HOME, {}, WIN_ENV))
  assert.equal(resolveStudioMcp(get).source, 'none')
  assert.equal(studioMcp(fake.ctx), null)
  // auto
  setStudioDetectEnv(fakeEnv('win32', WIN_HOME, { [bat]: true }, WIN_ENV))
  const auto = resolveStudioMcp(get)
  assert.equal(auto.source, 'auto')
  assert.deepEqual(studioMcp(fake.ctx), { type: 'stdio', command: 'cmd.exe', args: ['/c', bat] })
  // manual wins over auto
  fake.settings.set('studioMcp', { command: 'C:\\x\\StudioMCP.exe', args: ['--stdio', 7] })
  const manual = resolveStudioMcp(get)
  assert.equal(manual.source, 'manual')
  assert.deepEqual(manual.active, { command: 'C:\\x\\StudioMCP.exe', args: ['--stdio'] })
  assert.equal(manual.detected?.path, bat, 'the detected one is still reported')
  assert.deepEqual(studioMcp(fake.ctx)?.args, ['--stdio'])
  // off beats both
  fake.settings.set('studioMcpEnabled', false)
  assert.equal(resolveStudioMcp(get).source, 'off')
  assert.equal(studioMcp(fake.ctx), null)
  // a blank manual command falls back to auto
  fake.settings.set('studioMcpEnabled', true)
  fake.settings.set('studioMcp', { command: '  ', args: [] })
  assert.equal(resolveStudioMcp(get).source, 'auto')
})

test('the args field: quotes keep spaces; formatCommand round-trips', () => {
  assert.deepEqual(parseArgs('/c "C:\\Users\\Acid Gorgon\\AppData\\Local\\Roblox\\mcp.bat"'), ['/c', 'C:\\Users\\Acid Gorgon\\AppData\\Local\\Roblox\\mcp.bat'])
  assert.deepEqual(parseArgs("  --stdio  'a b' c"), ['--stdio', 'a b', 'c'])
  assert.deepEqual(parseArgs(''), [])
  const c = { command: 'C:\\Program Files\\x.exe', args: ['/c', 'a b'] }
  assert.equal(formatCommand(c), '"C:\\Program Files\\x.exe" /c "a b"')
  assert.deepEqual(parseArgs(formatCommand(c)), [c.command, ...c.args])
})

test('the system prompt teaches the Studio playtest loop', () => {
  for (const s of ['list_roblox_studios', 'datamodel_type', 'start_stop_play', 'get_console_output', 'screen_capture', 'character_navigation', 'Enable Studio as MCP server']) assert.ok(SYSTEM_PROMPT.includes(s), s)
  assert.ok(!SYSTEM_PROMPT.includes('${'), 'no unexpanded template')
})

// ---------------------------------------------------------------- Test connection

test('Test connection: initialize + paged tools/list + list_roblox_studios against a fake stdio server', async () => {
  const r = await testStudioMcp(fakeServer())
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(r.tools, ['execute_luau', 'start_stop_play', 'list_roblox_studios', 'screen_capture'])
  assert.equal(r.server, 'FakeStudioMCP 1.0')
  assert.equal(r.studios, 'studio_id abc: MyGame (PlaceId 42)')
})

test('Test connection: a server that exits reports the error and its stderr; a missing command fails cleanly', async () => {
  const r = await testStudioMcp(fakeServer('--fail'))
  assert.equal(r.ok, false)
  assert.match(r.error!, /exited with code 3/)
  assert.match(r.stderr!, /disabled in Roblox Studio/)
  const missing = await testStudioMcp({ command: join(tmpdir(), 'no-such-studio-mcp-binary'), args: [] })
  assert.equal(missing.ok, false)
  assert.match(missing.error!, /could not start|ENOENT/)
})

test('Settings handlers: status, save, test (connection state + event), off', async () => {
  const fake = fakeContext()
  const emitted: any[] = []
  setStudioDetectEnv(fakeEnv('darwin', '/Users/a', {}))
  const h = studioMcpHandlers({
    getSetting: (k, f) => (fake.settings.has(k) ? (fake.settings.get(k) as never) : f),
    setSetting: (k, v) => fake.settings.set(k, v),
    emit: (s) => emitted.push(s),
    browse: async () => '/picked'
  })
  assert.equal((await h.studioMcpStatus()).source, 'none')
  const none = await h.studioMcpTest()
  assert.equal(none.ok, false)
  assert.match(none.error!, /No Studio MCP command/)
  const saved = await h.studioMcpSetSettings({ manual: fakeServer() })
  assert.equal(saved.source, 'manual')
  assert.deepEqual(fake.settings.get('studioMcp'), fakeServer())
  const r = await h.studioMcpTest()
  assert.equal(r.ok, true)
  const st = await h.studioMcpStatus()
  assert.equal(st.connection?.state, 'connected')
  assert.equal(st.connection?.tools, 4)
  assert.ok(emitted.some((s) => s.connection?.state === 'connected'), 'the connection change is pushed to the renderer')
  // Testing a typed (unsaved) command uses that one.
  assert.equal((await h.studioMcpTest(fakeServer('--fail'))).ok, false)
  assert.equal(studioConnection()?.state, 'failed')
  const off = await h.studioMcpSetSettings({ enabled: false })
  assert.equal(off.source, 'off')
  assert.equal(off.connection, null)
  assert.equal(await h.studioMcpBrowse(), '/picked')
})

test('SDK init message: the studio server state and tool count become the connection', () => {
  noteSdkInit({ mcp_servers: [{ name: 'gentree', status: 'connected' }, { name: 'studio', status: 'connected' }], tools: ['Read', 'mcp__studio__execute_luau', 'mcp__studio__screen_capture'] }, 'studio')
  assert.deepEqual({ state: studioConnection()?.state, tools: studioConnection()?.tools }, { state: 'connected', tools: 2 })
  noteSdkInit({ mcp_servers: [{ name: 'studio', status: 'failed' }], tools: [] }, 'studio')
  assert.equal(studioConnection()?.state, 'failed')
})

// ---------------------------------------------------------------- OpenAI-compatible bridge

test('bridge: Studio tools as function tools with their JSON Schema; calls reach the server; images go to the chat', async () => {
  const b = await openStudioBridge(fakeServer())
  assert.ok(b)
  try {
    assert.deepEqual(b.tools.map((t) => t.name), ['mcp__studio__execute_luau', 'mcp__studio__start_stop_play', 'mcp__studio__list_roblox_studios', 'mcp__studio__screen_capture'])
    const luau = b.tools[0]
    assert.equal((luau.jsonSchema as any).properties.datamodel_type.enum[2], 'Client')
    assert.equal((luau.jsonSchema as any).$schema, undefined)
    assert.deepEqual(b.tools[2].jsonSchema, { type: 'object', properties: {} })
    const r = await runTool(luau, { code: 'print(1)', datamodel_type: 'Server' })
    assert.equal(r.content[0].text, 'ran print(1) in Server')
    const shot = await runTool(b.tools[3], {})
    assert.match(shot.content[0].text, /image/)
  } finally {
    await b.close()
  }
  assert.equal(await openStudioBridge(fakeServer('--fail')), null)
  assert.equal(studioConnection()?.state, 'failed')
})

// Fake OpenAI-compatible endpoint: records each request, answers from `replies`.
function fakeFetch(replies: unknown[][]): { fetch: typeof fetch; bodies: any[] } {
  const bodies: any[] = []
  const fn = (async (_url: string, init: RequestInit = {}) => {
    bodies.push(JSON.parse(String(init.body)))
    const chunks = replies[bodies.length - 1] ?? [{ choices: [{ index: 0, delta: { content: 'done' } }] }]
    const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  return { fetch: fn, bodies }
}

test('chat on an OpenAI-compatible provider gets the Studio tools in Auto, not in Ask', async () => {
  const fake = fakeContext()
  fake.settings.set('studioMcp', fakeServer())
  const creds = new Credentials(fake.ctx, plainSafe, {})
  await creds.setKey('openai', 'sk-openai')
  const call = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'mcp__studio__execute_luau', arguments: '{"code":"return 2","datamodel_type":"Edit"}' } }] } }] }
  const f = fakeFetch([[call], [{ choices: [{ index: 0, delta: { content: 'It returned 2.' } }] }], [{ choices: [{ index: 0, delta: { content: 'Read only.' } }] }]])
  const chats = new ChatManager(fake.ctx, { credentials: creds, providers: new Providers(fake.ctx, creds, f.fetch), fetchFn: f.fetch, toolFs: fake.fs, checkpoints: null })
  const chat = chats.create({ provider: 'openai', model: 'gpt-6-astra' })
  await chats.setMode(chat.id, 'auto')
  await chats.send(chat.id, 'run some Luau in Studio')
  while (chats.busy(chat.id)) await new Promise((r) => setTimeout(r, 5))
  const names = (f.bodies[0].tools as any[]).map((t) => t.function.name)
  assert.ok(names.includes('mcp__studio__execute_luau') && names.includes('read_script'))
  assert.match(f.bodies[0].messages[0].content, /live Studio tools keep their mcp__studio__ names/)
  const toolMsg = (f.bodies[1].messages as any[]).find((m) => m.role === 'tool')
  assert.equal(toolMsg.content, 'ran return 2 in Edit')
  assert.equal(chats.messages(chat.id)!.at(-1)!.text, 'It returned 2.')

  await chats.setMode(chat.id, 'ask')
  await chats.send(chat.id, 'what is in Studio?')
  while (chats.busy(chat.id)) await new Promise((r) => setTimeout(r, 5))
  const askNames = (f.bodies[2].tools as any[]).map((t) => t.function.name)
  assert.ok(!askNames.some((n) => n.startsWith('mcp__studio__')), 'Ask mode: no Studio tools')
  assert.match(f.bodies[2].messages[0].content, /no Studio tools/)
})

// ---------------------------------------------------------------- Codex

test('codex exec: -c overrides add the studio server; read-only gets the look-only tools', () => {
  const cmd = { command: 'cmd.exe', args: ['/c', 'C:\\Users\\Acid Gorgon\\AppData\\Local\\Roblox\\mcp.bat'] }
  const cfg = codexStudioConfig(cmd)
  assert.deepEqual(cfg, [
    'mcp_servers.studio.command="cmd.exe"',
    'mcp_servers.studio.args=["/c","C:\\\\Users\\\\Acid Gorgon\\\\AppData\\\\Local\\\\Roblox\\\\mcp.bat"]',
    'mcp_servers.studio.startup_timeout_sec=30',
    'mcp_servers.studio.tool_timeout_sec=300',
    'mcp_servers.studio.default_tools_approval_mode="approve"'
  ])
  assert.deepEqual(codexStudioConfig(null), [])
  const ro = codexStudioConfig(cmd, { readOnly: true })
  assert.equal(ro.at(-1), `mcp_servers.studio.enabled_tools=${JSON.stringify(STUDIO_READ_TOOLS)}`)
  assert.ok(!STUDIO_READ_TOOLS.includes('execute_luau' as never) && !STUDIO_READ_TOOLS.includes('start_stop_play' as never))
  const args = buildExecArgs({ cwd: '/p', sandbox: 'workspace-write', resumeId: 'th-1', config: cfg })
  assert.ok(args.indexOf('-c') < args.indexOf('resume'), 'overrides come before the resume subcommand')
  assert.equal(args.filter((a) => a === '-c').length, 5)
  assert.equal(args[args.indexOf('-c') + 1], 'mcp_servers.studio.command="cmd.exe"')
  // The brief says Studio is there (and how to use it) instead of "not reachable".
  const brief = codexPrompt({ text: 'hi', mode: 'edit', rules: '', fresh: true, transcript: '', basePrompt: SYSTEM_PROMPT, studio: true })
  assert.match(brief, /"studio" MCP server/)
  assert.doesNotMatch(brief, /not reachable/)
  assert.match(codexPrompt({ text: 'hi', mode: 'edit', rules: '', fresh: true, transcript: '', basePrompt: SYSTEM_PROMPT }), /not reachable/)
})

function fakeCodex() {
  const execs: { args: string[]; stdin: string }[] = []
  const run: CliRunner = async (o) => {
    if (o.args[0] === 'login') return { code: 0, stderr: 'Logged in using ChatGPT\n', aborted: false, timedOut: false }
    if (o.args[0] === '--version') {
      o.onStdoutLine?.('codex-cli 0.162.1')
      return { code: 0, stderr: '', aborted: false, timedOut: false }
    }
    execs.push({ args: o.args, stdin: o.stdin ?? '' })
    o.onStdoutLine?.(JSON.stringify({ type: 'thread.started', thread_id: `th-${execs.length}` }))
    o.onStdoutLine?.(JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'ok' } }))
    o.onStdoutLine?.(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }))
    return { code: 0, stderr: '', aborted: false, timedOut: false }
  }
  return { svc: new CodexService({ findBin: () => '/bin/codex', run, env: () => ({}) }), execs }
}

const configOf = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []))

test('Codex host chat: Studio overrides in Edit / Auto, none in Ask; Codex guests get only look-only tools', async () => {
  const { svc, execs } = fakeCodex()
  const fake = fakeContext()
  fake.settings.set('studioMcp', { command: '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP', args: [] })
  const creds = new Credentials(fake.ctx, plainSafe, {})
  const chats = new ChatManager(fake.ctx, { credentials: creds, toolFs: fake.fs, checkpoints: null, codex: () => svc } as any)
  const c = chats.create({ provider: 'codex', model: 'codex-default' })
  await chats.send(c.id, 'playtest the shop')
  while (chats.busy(c.id)) await new Promise((r) => setTimeout(r, 5))
  const edit = configOf(execs[0].args)
  assert.ok(edit.includes('mcp_servers.studio.command="/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP"'))
  assert.ok(!edit.some((x) => x.includes('enabled_tools')), 'the host gets every Studio tool')
  assert.match(execs[0].stdin, /"studio" MCP server/)
  await chats.setMode(c.id, 'ask')
  await chats.send(c.id, 'what is wrong?')
  while (chats.busy(c.id)) await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(configOf(execs[1].args), [], 'Ask: no Studio server')

  // A Codex guest next to a Claude host.
  const g = fakeCodex()
  const fake2 = fakeContext()
  fake2.settings.set('studioMcp', { command: 'studio-mcp', args: ['--stdio'] })
  const creds2 = new Credentials(fake2.ctx, plainSafe, {})
  await creds2.setKey('anthropic', 'key')
  const queryFn: QueryFn = () =>
    (async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, result: '', session_id: 's', usage: { input_tokens: 1, output_tokens: 1 } } as any
    })()
  const fetchFn = (async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  const chats2 = new ChatManager(fake2.ctx, { credentials: creds2, providers: new Providers(fake2.ctx, creds2, fetchFn, () => g.svc), fetchFn, toolFs: fake2.fs, queryFn, checkpoints: null, codex: () => g.svc })
  const host = chats2.create({ provider: 'anthropic', model: 'claude-opus-5-5' })
  chats2.addGuest(host.id, { provider: 'codex', model: 'gpt-6.1-sol' })
  await chats2.send(host.id, '@sol look at the shop in Studio')
  while (chats2.busy(host.id)) await new Promise((r) => setTimeout(r, 5))
  const guest = configOf(g.execs[0].args)
  assert.ok(guest.includes('mcp_servers.studio.command="studio-mcp"'))
  assert.ok(guest.includes(`mcp_servers.studio.enabled_tools=${JSON.stringify(STUDIO_READ_TOOLS)}`), 'guests: look-only Studio tools')
  // Guest file access off: no project, no Studio.
  chats2.setGuestTools(host.id, false)
  await chats2.send(host.id, '@sol again')
  while (chats2.busy(host.id)) await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(configOf(g.execs[1].args), [])
})

test('the fake server sees the MCP handshake in order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-mcp-'))
  try {
    const log = join(dir, 'log.txt')
    const r = await testStudioMcp(fakeServer('--log', log))
    assert.equal(r.ok, true)
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'tools/call'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
