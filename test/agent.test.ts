// Agent layer tests: gentree tool handlers, chat permissions, and the test-agent scheduler.
// No Electron and no real API calls: the context is faked and query() is stubbed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TreeNode } from '../src/shared/types.ts'
import { fakeContext, type Fake } from './agentFake.ts'
import { gentreeTools, normalizeRepoPath, parseInstancePath, WRITE_TOOLS } from '../src/main/agent/tools.ts'
import { chatPermissions, ChatManager } from '../src/main/agent/chat.ts'
import { TestAgentRunner } from '../src/main/agent/testAgents.ts'
import { Credentials } from '../src/main/agent/credentials.ts'
import { toChatMessages, type QueryFn } from '../src/main/agent/sdk.ts'

// ---- helpers ----

async function call(fake: Fake, name: string, args: Record<string, unknown> = {}) {
  const t = gentreeTools(fake.ctx, { fs: fake.fs }).find((x) => x.name === name)
  assert.ok(t, `tool ${name} exists`)
  const r = (await t.handler(args as any, {})) as { content: { text: string }[]; isError?: boolean }
  return { text: r.content.map((c) => c.text).join(''), isError: !!r.isError }
}

function node(name: string, className: string, children: TreeNode[] = [], extra: Partial<TreeNode> & { props?: Record<string, unknown> } = {}): TreeNode {
  return { name, className, children, ...extra } as TreeNode
}

const TREE: TreeNode[] = [
  node('ReplicatedStorage', 'ReplicatedStorage', [
    node('Shared', 'Folder', [node('Features', 'Folder', [node('Inventory', 'Folder', [node('Config', 'ModuleScript', [], { filePath: 'src/shared/Features/Inventory/Config.luau' })])])]),
    node('Assets', 'Folder', [node('Sword Model', 'Model', [node('Handle', 'MeshPart', [], { origin: 'studio', props: { MeshId: 'rbxassetid://1' } })], { origin: 'studio' })], { origin: 'studio' })
  ]),
  node('Workspace', 'Workspace', [node('Sword', 'Tool')])
]

// ---- path handling ----

test('normalizeRepoPath refuses escapes', () => {
  assert.equal(normalizeRepoPath('../x'), null)
  assert.equal(normalizeRepoPath('src/../../x'), null)
  assert.equal(normalizeRepoPath('/etc/passwd'), null)
  assert.equal(normalizeRepoPath('C:\\x'), null)
  assert.equal(normalizeRepoPath('./src\\shared/a.luau'), 'src/shared/a.luau')
})

test('write_script refuses paths outside src/ and Packages', async () => {
  const fake = fakeContext()
  for (const path of ['../evil.luau', '/abs.luau', 'README.md', 'Packages/Janitor.luau', 'src/../README.md', 'src/other/x.luau']) {
    const r = await call(fake, 'write_script', { path, contents: 'x' })
    assert.ok(r.isError, `${path} refused`)
  }
  assert.equal(fake.files.size, 0)
})

test('write_script writes inside Rojo folders and events.blink, creating subfolders', async () => {
  const fake = fakeContext()
  assert.ok(!(await call(fake, 'write_script', { path: 'events.blink', contents: 'event A {}' })).isError)
  const r = await call(fake, 'write_script', { path: 'src/shared/Modules/Utils/Math.luau', contents: 'return {}' })
  assert.ok(!r.isError, r.text)
  assert.equal(fake.files.get('src/shared/Modules/Utils/Math.luau'), 'return {}')
  assert.ok(fake.dirs.has('src/shared/Modules/Utils'))
})

test('write_script refuses when the Rojo folder itself is missing', async () => {
  const fake = fakeContext({ dirs: ['src', 'src/shared'] })
  const r = await call(fake, 'write_script', { path: 'src/server/Foo.luau', contents: 'x' })
  assert.ok(r.isError)
  assert.match(r.text, /does not exist/)
})

test('read_script numbers lines and honours ranges', async () => {
  const fake = fakeContext({ files: { 'src/shared/a.luau': 'one\ntwo\nthree' } })
  assert.equal((await call(fake, 'read_script', { path: 'src/shared/a.luau', from: 2, to: 3 })).text, '2|two\n3|three')
  assert.ok((await call(fake, 'read_script', { path: '../secret' })).isError)
})

// ---- edit_script ----

test('edit_script replaces exactly one occurrence', async () => {
  const fake = fakeContext({ files: { 'src/shared/a.luau': 'local a = 1\nlocal b = 1\nreturn a' } })
  const missing = await call(fake, 'edit_script', { path: 'src/shared/a.luau', old_string: 'nope', new_string: 'x' })
  assert.ok(missing.isError)
  const dup = await call(fake, 'edit_script', { path: 'src/shared/a.luau', old_string: '= 1', new_string: '= 2' })
  assert.ok(dup.isError)
  assert.match(dup.text, /more than once/)
  assert.equal(fake.files.get('src/shared/a.luau'), 'local a = 1\nlocal b = 1\nreturn a')
  const good = await call(fake, 'edit_script', { path: 'src/shared/a.luau', old_string: 'local b = 1', new_string: 'local b = 2' })
  assert.ok(!good.isError, good.text)
  assert.match(good.text, /line 2/)
  assert.equal(fake.files.get('src/shared/a.luau'), 'local a = 1\nlocal b = 2\nreturn a')
})

test('edit_script refuses Packages', async () => {
  const fake = fakeContext({ files: { 'Packages/x.luau': 'a' } })
  assert.ok((await call(fake, 'edit_script', { path: 'Packages/x.luau', old_string: 'a', new_string: 'b' })).isError)
})

// ---- explorer ----

test('explorer_tree respects depth and marks studio-only nodes', async () => {
  const fake = fakeContext({ tree: TREE })
  const d1 = (await call(fake, 'explorer_tree', { depth: 1 })).text
  assert.deepEqual(d1.split('\n'), ['ReplicatedStorage ReplicatedStorage (+2)', 'Workspace Workspace (+1)'])
  const d2 = (await call(fake, 'explorer_tree', { depth: 2 })).text
  assert.ok(d2.includes('  Assets* Folder (+1)'))
  assert.ok(!d2.includes('Features'))
  const deep = (await call(fake, 'explorer_tree', { path: 'game.ReplicatedStorage.Assets', depth: 3 })).text
  assert.ok(deep.includes('Handle* MeshPart {MeshId=rbxassetid://1}'), deep)
  assert.ok(deep.includes('only in Studio'))
  const missing = await call(fake, 'explorer_tree', { path: 'ReplicatedStorage/Nope' })
  assert.match(missing.text, /not found: Nope/)
})

test('parseInstancePath handles pasted Roblox paths', () => {
  assert.deepEqual(parseInstancePath('game.ReplicatedStorage.Assets["Sword Model"]'), ['ReplicatedStorage', 'Assets', 'Sword Model'])
  assert.deepEqual(parseInstancePath('game:GetService("ReplicatedStorage").Assets:WaitForChild("Sword Model")'), ['ReplicatedStorage', 'Assets', 'Sword Model'])
  assert.deepEqual(parseInstancePath('Workspace/Map'), ['Workspace', 'Map'])
})

test('find_instance returns game paths with classes', async () => {
  const fake = fakeContext({ tree: TREE })
  const r = (await call(fake, 'find_instance', { query: 'sword' })).text.split('\n')
  assert.ok(r.includes('game.ReplicatedStorage.Assets["Sword Model"] (Model)*'), r.join('|'))
  assert.ok(r.includes('game.Workspace.Sword (Tool)'))
  const scoped = (await call(fake, 'find_instance', { query: 'sword', service: 'Workspace' })).text
  assert.equal(scoped, 'game.Workspace.Sword (Tool)')
  const pasted = (await call(fake, 'find_instance', { query: 'game.ReplicatedStorage.Assets.Handle' })).text
  assert.match(pasted, /Handle \(MeshPart\)/)
})

// ---- new_feature ----

test('new_feature validates PascalCase and creates the shared folder', async () => {
  const fake = fakeContext()
  for (const name of ['inventory', 'My Feature', '_Hidden', '../X', '']) {
    assert.ok((await call(fake, 'new_feature', { name })).isError, `${name} refused`)
  }
  const r = await call(fake, 'new_feature', { name: 'Inventory' })
  assert.ok(!r.isError, r.text)
  assert.ok(fake.dirs.has('src/shared/Features/Inventory'))
  assert.ok((await call(fake, 'new_feature', { name: 'Inventory' })).isError, 'duplicate refused')
})

test('read-only tool set has no write tools', () => {
  const names = gentreeTools(fakeContext().ctx, { readOnly: true }).map((t) => t.name)
  for (const w of WRITE_TOOLS) assert.ok(!names.includes(w), w)
  assert.ok(names.includes('read_script'))
})

// ---- chat ----

test('chat permissions keep edits inside the project and Bash behind a setting', async () => {
  const fake = fakeContext()
  const canUse = chatPermissions(fake.ctx)
  const opts = { signal: new AbortController().signal } as any
  const can = async (name: string, input: Record<string, unknown>, o: any) => (await canUse(name, input, o))!
  assert.equal((await can('Edit', { file_path: '/fake/project/src/shared/a.luau' }, opts)).behavior, 'allow')
  assert.equal((await can('Write', { file_path: '/elsewhere/a.luau' }, opts)).behavior, 'deny')
  assert.equal((await can('Edit', { file_path: '/fake/project/Packages/a.luau' }, opts)).behavior, 'deny')
  assert.equal((await can('Bash', { command: 'ls' }, opts)).behavior, 'deny')
  fake.settings.set('allowBash', true)
  assert.equal((await can('Bash', { command: 'ls' }, opts)).behavior, 'allow')
  assert.equal((await can('WebFetch', { url: 'x' }, opts)).behavior, 'deny')
})

test('chat streams messages, stores the SDK session id and resumes it', async () => {
  const fake = fakeContext()
  const seen: any[] = []
  const queryFn: QueryFn = (params) => {
    seen.push(params.options)
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-1' } as any
      yield { type: 'assistant', parent_tool_use_id: null, session_id: 'sdk-1', message: { content: [{ type: 'tool_use', name: 'mcp__gentree__read_script', input: { path: 'src/a.luau' } }] } } as any
      yield { type: 'assistant', parent_tool_use_id: null, session_id: 'sdk-1', message: { content: [{ type: 'text', text: 'Done.' }] } } as any
      yield { type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 'sdk-1' } as any
    })()
  }
  const credentials = new Credentials(fake.ctx, async () => null, { ANTHROPIC_API_KEY: 'sk-env', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' })
  const chats = new ChatManager(fake.ctx, { queryFn, credentials, makeServer: () => ({ type: 'stdio', command: 'none' }) })
  const chat = chats.create()
  await chats.send(chat.id, 'Read a.luau')
  while (chats.busy(chat.id)) await new Promise((r) => setTimeout(r, 5))
  const msgs = chats.messages(chat.id)!
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'tool', 'assistant'])
  assert.deepEqual(msgs[1].tool, { name: 'read_script', input: 'path=src/a.luau' })
  assert.equal(seen[0].resume, undefined)
  assert.equal(seen[0].model, 'claude-opus-5-5')
  // The API key goes to the SDK subprocess; a Claude Code OAuth token does not.
  assert.equal(seen[0].env.ANTHROPIC_API_KEY, 'sk-env')
  assert.equal(seen[0].env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
  await chats.send(chat.id, 'again')
  while (chats.busy(chat.id)) await new Promise((r) => setTimeout(r, 5))
  assert.equal(seen[1].resume, 'sdk-1')
  chats.flush()
  const stored = fake.settings.get('chats') as any
  assert.equal(stored.sessions[0].sdkSessionId, 'sdk-1')
  assert.equal(stored.sessions[0].title, 'Read a.luau')
  assert.ok(fake.events.some((e) => e.event === 'chat:busy' && e.payload.busy === false))
})

test('toChatMessages maps errors to system messages', () => {
  const out = toChatMessages({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: [] } as any, 'main')
  assert.equal(out[0].role, 'system')
})

// ---- credentials ----

test('setApiKey encrypts with safeStorage and passes the key to the SDK env', async () => {
  const fake = fakeContext()
  const env: Record<string, string | undefined> = {}
  const safe = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('enc:' + s),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  }
  const creds = new Credentials(fake.ctx, async () => safe, env as any)
  await creds.setApiKey('sk-test')
  const stored = fake.settings.get('anthropicApiKey') as any
  assert.equal(stored.enc, 'safe')
  assert.ok(!Buffer.from(stored.data, 'base64').toString().startsWith('sk-'))
  assert.equal(await creds.storedKey(), 'sk-test')
  assert.equal(await creds.hasApiKey(), true)
  const auth = await creds.anthropicAuth()
  assert.equal(auth.env?.ANTHROPIC_API_KEY, 'sk-test')
  // process.env itself is not modified.
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  await creds.setApiKey('')
  assert.equal(await creds.hasApiKey(), false)
})

// ---- test agents ----

// Stub query: waits a bit, then calls report_result through the captured tool definitions.
function agentHarness(fake: Fake, behaviour: (scenario: string) => 'passed' | 'failed' | 'none' | 'throw' = () => 'passed') {
  const servers: any[][] = []
  let active = 0
  let maxActive = 0
  let studioActive = 0
  let maxStudio = 0
  const optionsSeen: any[] = []
  const queryFn: QueryFn = ({ prompt, options }) => {
    const tools = (options.mcpServers as any).gentree.tools
    optionsSeen.push(options)
    return (async function* () {
      active++
      maxActive = Math.max(maxActive, active)
      const studio = !!options.mcpServers?.studio
      if (studio) studioActive++
      maxStudio = Math.max(maxStudio, studioActive)
      try {
        for (let i = 0; i < 3; i++) {
          await new Promise((r) => setTimeout(r, 5))
          if (options.abortController?.signal.aborted) throw new Error('aborted')
          yield { type: 'assistant', parent_tool_use_id: null, session_id: 's', message: { content: [{ type: 'text', text: `step ${i}` }] } } as any
        }
        const b = behaviour(prompt as string)
        if (b === 'throw') throw new Error('boom')
        if (b !== 'none') await tools.find((t: any) => t.name === 'report_result').handler({ status: b, summary: `${b} ok` }, {})
        yield { type: 'result', subtype: 'success', is_error: false, result: '', session_id: 's' } as any
      } finally {
        active--
        if (studio) studioActive--
      }
    })()
  }
  const runner = new TestAgentRunner(fake.ctx, {
    queryFn,
    makeServer: (tools) => {
      servers.push(tools)
      return { type: 'stdio', command: 'none', tools } as any
    }
  })
  return { runner, optionsSeen, stats: () => ({ maxActive, maxStudio }) }
}

test('test agents run concurrently up to maxParallelAgents', async () => {
  const fake = fakeContext()
  fake.settings.set('maxParallelAgents', 2)
  const h = agentHarness(fake, (p) => (p.includes('bad') ? 'failed' : 'passed'))
  const started = h.runner.run(['a', 'b', 'bad c', 'd', 'e'])
  assert.equal(started.length, 5)
  assert.deepEqual(started.map((a) => a.state), ['running', 'running', 'queued', 'queued', 'queued'])
  await h.runner.idle()
  assert.equal(h.stats().maxActive, 2)
  const states = h.runner.list().map((a) => a.state)
  assert.deepEqual(states, ['passed', 'passed', 'failed', 'passed', 'passed'])
  assert.ok(fake.events.filter((e) => e.event === 'agents:changed').length >= 10)
  const agentId = h.runner.list()[0].id
  assert.ok(fake.events.some((e) => e.event === 'chat:message' && e.payload.agentId === agentId))
  // Read-only: no write tools reach test agents.
  assert.ok(!h.optionsSeen[0].tools.includes('Edit'))
})

test('only one agent at a time gets Studio tools; others are static reviewers', async () => {
  const fake = fakeContext()
  fake.settings.set('maxParallelAgents', 3)
  fake.settings.set('studioMcp', { command: 'studio-mcp', args: [] })
  const h = agentHarness(fake)
  h.runner.run(['a', 'b', 'c', 'd'])
  await h.runner.idle()
  assert.equal(h.stats().maxActive, 3)
  assert.equal(h.stats().maxStudio, 1)
  const withStudio = h.optionsSeen.filter((o) => o.mcpServers.studio)
  assert.ok(withStudio.length >= 1)
  assert.ok(withStudio.every((o) => o.allowedTools.includes('mcp__studio')))
  assert.ok(h.optionsSeen.some((o) => !o.mcpServers.studio && /static reviewer/.test(o.systemPrompt)))
})

test('missing report, thrown errors and cancellation map to agent states', async () => {
  const fake = fakeContext()
  fake.settings.set('maxParallelAgents', 1)
  const h = agentHarness(fake, (p) => (p.includes('silent') ? 'none' : p.includes('crash') ? 'throw' : 'passed'))
  const [silent, crash, running, queued] = h.runner.run(['silent', 'crash', 'long', 'later'])
  h.runner.cancel(queued.id)
  assert.equal(h.runner.list().find((a) => a.id === queued.id)!.state, 'cancelled')
  // Cancel the third once it is running.
  while (h.runner.list().find((a) => a.id === running.id)!.state !== 'running') await new Promise((r) => setTimeout(r, 2))
  h.runner.cancel(running.id)
  await h.runner.idle()
  const byId = new Map(h.runner.list().map((a) => [a.id, a]))
  assert.equal(byId.get(silent.id)!.state, 'error')
  assert.match(byId.get(silent.id)!.summary!, /report_result/)
  assert.equal(byId.get(crash.id)!.state, 'error')
  assert.equal(byId.get(crash.id)!.summary, 'boom')
  assert.equal(byId.get(running.id)!.state, 'cancelled')
})
