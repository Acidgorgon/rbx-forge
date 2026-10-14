// Chat modes and slash commands: tool gating (Ask / Plan can never write, on every write tool, on
// both provider paths), the plan approval flow, edit approval (diff cards, per-hunk), every command
// handler, custom command parsing, and /rewind checkpoints on a temp git repo (git history untouched).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { fakeContext, type Fake } from './agentFake.ts'
import type { ServiceTool } from '../src/main/context.ts'
import { ChatManager } from '../src/main/agent/chat.ts'
import { Credentials } from '../src/main/agent/credentials.ts'
import { Providers } from '../src/main/agent/providers.ts'
import type { QueryFn } from '../src/main/agent/sdk.ts'
import { gentreeTools } from '../src/main/agent/tools.ts'
import { classifyTool, gateOpenAiTools, proposeEdit, sdkModeOptions, todoTool, toolCatalog, EDIT_BUILTINS } from '../src/main/agent/modes.ts'
import { Checkpoints } from '../src/main/agent/checkpoints.ts'
import { extractNotes, mergeNotes, NOTES_FILE } from '../src/main/agent/commands/notes.ts'
import { loadCustomCommands } from '../src/main/agent/commands/custom.ts'
import { applyHunks, diffLines, nextChatMode, parsePlan, type ChatMode } from '../src/shared/chatModes.ts'
import { expandCommand, matchCommands, mergeCommands, parseCustomCommand, parseSlash, splitArgs, BUILTIN_COMMANDS } from '../src/shared/chatCommands.ts'

// ---------------------------------------------------------------- helpers

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const svc = (name: string): ServiceTool => ({ name, description: name, inputSchema: { x: z.string().optional() }, handler: async () => ok(`${name} ran`) })

// A context with the service tool sets the real app has (read / tests / write / chat-only).
function withServices(fake: Fake): Fake {
  fake.ctx.serviceTools = () => ({
    read: [svc('project_map'), svc('blink_events'), svc('wally_search'), svc('preview_ui')],
    tests: [svc('run_tests'), svc('create_spec')],
    write: [svc('add_blink_event'), svc('add_wally_package'), svc('rename_feature'), svc('generate_image'), svc('import_image_to_roblox'), svc('list_art')],
    chat: [svc('run_in_terminal')]
  })
  return fake
}

// Every tool that changes the project or runs something, as the chat agent would see them.
const WRITES = [
  'write_script', 'edit_script', 'new_feature', 'sync_collaborators', 'resolve_studio_conflict', 'restart_service',
  'create_spec', 'add_blink_event', 'add_wally_package', 'rename_feature', 'generate_image', 'import_image_to_roblox', 'list_art', 'run_in_terminal'
]
const BUILTIN_WRITES = [...EDIT_BUILTINS, 'Bash', 'mcp__studio__run_code', 'mcp__studio__start_play', 'WebFetch', 'Task', 'Agent', 'mcp__gentree__brand_new_tool', 'mcp__other__write']

async function until(fn: () => boolean, ms = 10000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

type Call = { prompt: string; options: any }

// An SDK stub: `script` runs inside the query (may call canUseTool), then the turn answers `answer`.
function sdk(script: (o: any, n: number) => Promise<string | void> = async () => {}) {
  const calls: Call[] = []
  const queryFn: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt: String(prompt), options })
    const n = calls.length - 1
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: `s${n}` } as any
      const text = (await script(options, n)) || 'Done.'
      yield { type: 'assistant', parent_tool_use_id: null, session_id: `s${n}`, message: { content: [{ type: 'text', text }] } } as any
      yield { type: 'result', subtype: 'success', is_error: false, result: text, session_id: `s${n}` } as any
    })()
  }
  return { calls, queryFn }
}

function manager(fake: Fake, queryFn: QueryFn, extra: Record<string, unknown> = {}) {
  const credentials = new Credentials(fake.ctx, async () => null, { ANTHROPIC_API_KEY: 'sk-test' })
  return new ChatManager(fake.ctx, { queryFn, credentials, toolFs: fake.fs, checkpoints: null, ...extra } as any)
}

const can = (o: any, name: string, input: Record<string, unknown> = {}) => o.canUseTool(name, input, { signal: new AbortController().signal, toolUseID: 't' })
const hook = (o: any, name: string, input: Record<string, unknown> = {}) => o.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: 't' }, 't', { signal: new AbortController().signal })

const PLAN = `## Summary
Add a daily reward.
## Steps
1. Add \`src/shared/Features/Daily/Config.luau\`
2. Create DailyService
## Files
- \`src/server/Features/Daily/DailyService.luau\` - new
## Risks
- Old saves lack lastClaim`

// ---------------------------------------------------------------- gating

test('modes: Ask and Plan deny every write tool, built-in and unknown tool; Edit asks; Auto allows', () => {
  const fake = withServices(fakeContext())
  const all = gentreeTools(fake.ctx, { fs: fake.fs })
  const read = gentreeTools(fake.ctx, { readOnly: true, fs: fake.fs })
  const catalog = toolCatalog(read)
  const names = all.map((t) => t.name)
  for (const w of WRITES.filter((w) => w !== 'run_in_terminal')) assert.ok(names.includes(w), `${w} is a real tool`)
  for (const mode of ['ask', 'plan'] as ChatMode[]) {
    for (const w of WRITES) assert.equal(classifyTool(mode, `mcp__gentree__${w}`, catalog), 'deny', `${mode} denies ${w}`)
    for (const w of BUILTIN_WRITES) assert.equal(classifyTool(mode, w, catalog), 'deny', `${mode} denies ${w}`)
    for (const r of ['Read', 'Glob', 'Grep', 'mcp__gentree__read_script', 'mcp__gentree__project_map', 'mcp__gentree__run_tests', 'mcp__gentree__update_todos']) assert.equal(classifyTool(mode, r, catalog), 'allow', `${mode} allows ${r}`)
  }
  assert.equal(classifyTool('plan', 'ExitPlanMode', catalog), 'allow')
  assert.equal(classifyTool('ask', 'ExitPlanMode', catalog), 'deny')
  for (const w of WRITES.filter((w) => w !== 'run_in_terminal')) assert.equal(classifyTool('edit', `mcp__gentree__${w}`, catalog), 'approve', `edit asks for ${w}`)
  assert.equal(classifyTool('edit', 'mcp__gentree__run_in_terminal', catalog), 'allow', 'run_in_terminal confirms in the terminal itself')
  assert.equal(classifyTool('edit', 'Edit', catalog), 'approve')
  assert.equal(classifyTool('edit', 'mcp__studio__run_code', catalog), 'approve')
  assert.equal(classifyTool('auto', 'mcp__gentree__write_script', catalog), 'allow')
  assert.equal(nextChatMode('ask'), 'plan')
  assert.equal(nextChatMode('auto'), 'ask')
})

test('modes: the SDK guard (canUseTool, PreToolUse hook, disallowedTools) blocks every write in Ask and Plan', async () => {
  const fake = withServices(fakeContext())
  const read = gentreeTools(fake.ctx, { readOnly: true, fs: fake.fs })
  const all = gentreeTools(fake.ctx, { fs: fake.fs })
  for (const mode of ['ask', 'plan'] as ChatMode[]) {
    let approvals = 0
    const o = sdkModeOptions({
      mode,
      catalog: toolCatalog(read),
      serverTools: [...all.map((t) => t.name), 'run_in_terminal'],
      allowBash: true,
      studio: true,
      bounds: async (_n, input) => ({ behavior: 'allow', updatedInput: input }),
      approve: async () => (approvals++, { behavior: 'allow' }),
      onPlan: () => {}
    })
    assert.equal(o.permissionMode, mode === 'plan' ? 'plan' : 'default')
    for (const t of ['Edit', 'Write', 'Bash']) assert.ok(!(o.tools as string[]).includes(t), `${mode}: ${t} not offered`)
    for (const w of WRITES) assert.ok(o.disallowedTools!.includes(`mcp__gentree__${w}`), `${mode}: ${w} disallowed`)
    assert.ok(o.disallowedTools!.includes('mcp__studio'))
    for (const w of [...WRITES.map((x) => `mcp__gentree__${x}`), ...BUILTIN_WRITES]) {
      const r = await can(o, w, { file_path: '/fake/project/src/a.luau', command: 'rm -rf /' })
      assert.equal(r.behavior, 'deny', `${mode}: canUseTool denies ${w}`)
      const h = await hook(o, w, { file_path: '/fake/project/src/a.luau' })
      assert.equal(h.hookSpecificOutput?.permissionDecision, 'deny', `${mode}: hook denies ${w}`)
    }
    assert.equal((await can(o, 'mcp__gentree__read_script', { path: 'src/a.luau' })).behavior, 'allow')
    assert.deepEqual(await hook(o, 'Read', { file_path: '/fake/project/src/a.luau' }), {})
    assert.equal(approvals, 0, 'nothing ever reached the approval flow')
  }
  // Edit: write tools go to the approval flow; Auto: acceptEdits with the hook still keeping Packages/ out.
  const bounds = async (_n: string, input: any) => (String(input.file_path ?? '').includes('Packages') ? { behavior: 'deny' as const, message: 'Packages/ is managed by Wally' } : { behavior: 'allow' as const, updatedInput: input })
  let asked = 0
  const edit = sdkModeOptions({ mode: 'edit', catalog: toolCatalog(read), serverTools: all.map((t) => t.name), allowBash: false, studio: false, bounds, approve: async () => (asked++, { behavior: 'allow' }), onPlan: () => {} })
  assert.equal(edit.permissionMode, 'default')
  assert.ok(!edit.allowedTools!.includes('mcp__gentree__write_script') && edit.allowedTools!.includes('mcp__gentree__read_script'))
  await can(edit, 'mcp__gentree__write_script', { path: 'src/a.luau', contents: 'x' })
  assert.equal(asked, 1)
  assert.equal((await can(edit, 'Edit', { file_path: '/fake/project/Packages/x.lua' })).behavior, 'deny', 'bounds before approval')
  assert.equal(asked, 1)
  const auto = sdkModeOptions({ mode: 'auto', catalog: toolCatalog(read), serverTools: all.map((t) => t.name), allowBash: false, studio: true, bounds, approve: async () => ({ behavior: 'deny', message: 'x' }), onPlan: () => {} })
  assert.equal(auto.permissionMode, 'acceptEdits')
  assert.ok(auto.allowedTools!.includes('mcp__gentree') && auto.allowedTools!.includes('mcp__studio'))
  assert.equal((await hook(auto, 'Write', { file_path: '/fake/project/Packages/x.lua' })).hookSpecificOutput?.permissionDecision, 'deny')
})

test('modes: OpenAI-compatible tools are gated the same way (read modes keep only read tools)', async () => {
  const fake = withServices(fakeContext())
  const read = gentreeTools(fake.ctx, { readOnly: true, fs: fake.fs })
  const all = [...gentreeTools(fake.ctx, { fs: fake.fs }), svc('run_in_terminal') as any, todoTool(() => null, () => {})]
  const catalog = toolCatalog([...read, { name: 'update_todos' }])
  for (const mode of ['ask', 'plan'] as ChatMode[]) {
    const names = gateOpenAiTools(mode, all, catalog, async () => ({ run: true })).map((t) => t.name)
    for (const w of WRITES) assert.ok(!names.includes(w), `${mode} drops ${w}`)
    assert.ok(names.includes('read_script') && names.includes('update_todos'))
  }
  const asked: string[] = []
  const edit = gateOpenAiTools('edit', all, catalog, async (n) => (asked.push(n), { run: false, result: { content: [{ type: 'text', text: 'rejected' }], isError: true } }))
  const r = await edit.find((t) => t.name === 'add_blink_event')!.handler({}, {})
  assert.deepEqual(asked, ['add_blink_event'])
  assert.equal(r.isError, true)
  assert.equal((await edit.find((t) => t.name === 'run_in_terminal')!.handler({}, {})).content[0].text, 'run_in_terminal ran', 'self-confirming tool not wrapped')
})

test('modes: ChatManager in Ask mode builds a read-only server and never offers writes (SDK + OpenAI loop)', async () => {
  const fake = withServices(fakeContext({ files: { 'src/shared/a.luau': 'return 1' } }))
  const s = sdk()
  const chats = manager(fake, s.queryFn)
  const c = chats.create()
  chats.setMode(c.id, 'ask')
  assert.equal(chats.list()[0].chatMode, 'ask')
  await chats.send(c.id, 'how does a.luau work?')
  await until(() => !chats.busy(c.id) && s.calls.length === 1)
  const o = s.calls[0].options
  assert.equal(o.permissionMode, 'default')
  for (const w of WRITES) assert.ok(o.disallowedTools.includes(`mcp__gentree__${w}`), w)
  assert.ok(!o.tools.includes('Edit') && !o.tools.includes('Write'))
  assert.match(o.systemPrompt, /# Mode: Ask/)
  // The in-process server only registered read tools.
  const registered = Object.keys((o.mcpServers.gentree.instance as any)._registeredTools ?? {})
  if (registered.length) for (const w of WRITES) assert.ok(!registered.includes(w), `server has no ${w}`)
  const msgs = chats.messages(c.id)!
  assert.equal(msgs[0].mode, 'ask', 'mode shown on the user message')
  assert.equal(msgs.at(-1)!.mode, 'ask', 'and on the answer')

  // OpenAI-compatible provider: the request's tool list has no write tool.
  const bodies: any[] = []
  const f = (async (url: string, init: RequestInit = {}) => {
    if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 })
    bodies.push(JSON.parse(String(init.body)))
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: PLAN } }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  const fake2 = withServices(fakeContext())
  const creds = new Credentials(fake2.ctx, async () => null, {})
  await creds.setKey('openai', 'key-openai')
  const providers = new Providers(fake2.ctx, creds, f)
  const chats2 = new ChatManager(fake2.ctx, { credentials: creds, providers, fetchFn: f, toolFs: fake2.fs, checkpoints: null })
  const c2 = chats2.create({ provider: 'openai', model: 'gpt-6-astra' })
  chats2.setMode(c2.id, 'plan')
  await chats2.send(c2.id, 'plan a daily reward')
  await until(() => !chats2.busy(c2.id) && bodies.length === 1)
  const tools = (bodies[0].tools ?? []).map((t: any) => t.function?.name ?? t.name)
  assert.ok(tools.includes('read_script'))
  for (const w of WRITES) assert.ok(!tools.includes(w), `openai plan: no ${w}`)
  assert.match(bodies[0].messages[0].content, /# Mode: Plan/)
  // Non-Claude plan: the answer becomes the plan card.
  const card = chats2.messages(c2.id)!.find((m) => m.planMode)!
  assert.deepEqual(card.planMode!.steps, ['Add `src/shared/Features/Daily/Config.luau`', 'Create DailyService'])
  assert.deepEqual(card.planMode!.risks, ['Old saves lack lastClaim'])
})

// ---------------------------------------------------------------- plan approval flow

test('plan: SDK plan mode captures ExitPlanMode as a card; Approve & run switches mode and executes it', async () => {
  const fake = withServices(fakeContext())
  const denies: any[] = []
  const s = sdk(async (o) => {
    if (o.permissionMode === 'plan') {
      denies.push(await can(o, 'ExitPlanMode', { plan: PLAN }))
      denies.push(await can(o, 'mcp__gentree__write_script', { path: 'src/a.luau', contents: 'x' }))
      return 'Waiting for your approval.'
    }
  })
  const chats = manager(fake, s.queryFn)
  const c = chats.create()
  chats.setMode(c.id, 'plan')
  await chats.send(c.id, 'add a daily reward with a streak')
  await until(() => !chats.busy(c.id) && s.calls.length === 1)
  assert.equal(s.calls[0].options.permissionMode, 'plan')
  assert.match(s.calls[0].options.planModeInstructions, /ExitPlanMode/)
  assert.deepEqual(denies.map((d) => d.behavior), ['deny', 'deny'])
  const card = chats.messages(c.id)!.find((m) => m.planMode)!
  assert.equal(card.planMode!.state, 'pending')
  assert.equal(card.planMode!.steps.length, 2)
  assert.deepEqual(card.planMode!.files, ['`src/server/Features/Daily/DailyService.luau` - new'])
  assert.equal(card.planMode!.summary, 'Add a daily reward.')

  // Edit plan, then approve in auto-accept.
  const edited = PLAN.replace('2. Create DailyService', '2. Create DailyService\n3. Add a Lune spec')
  await chats.planAction(c.id, card.id, 'edit', { text: edited })
  assert.equal(chats.messages(c.id)!.find((m) => m.id === card.id)!.planMode!.steps.length, 3)
  await chats.planAction(c.id, card.id, 'approve', { runMode: 'auto' })
  await until(() => !chats.busy(c.id) && s.calls.length === 2)
  assert.equal(s.calls[1].options.permissionMode, 'acceptEdits')
  assert.match(s.calls[1].prompt, /^Execute this approved plan now/)
  assert.match(s.calls[1].prompt, /Add a Lune spec/)
  const after = chats.messages(c.id)!.find((m) => m.id === card.id)!.planMode!
  assert.equal(after.state, 'approved')
  assert.equal(after.runMode, 'auto')
  assert.equal(after.edited, true)
  assert.equal(chats.list()[0].chatMode, 'auto', 'the chat stays in the chosen mode')
  await assert.rejects(chats.planAction(c.id, card.id, 'approve'), /already approved/)

  // Keep planning: closes the card, the chat stays in plan mode.
  chats.setMode(c.id, 'plan')
  await chats.send(c.id, 'plan another thing')
  await until(() => !chats.busy(c.id) && s.calls.length === 3)
  const second = chats.messages(c.id)!.filter((m) => m.planMode).at(-1)!
  await chats.planAction(c.id, second.id, 'keep')
  assert.equal(chats.messages(c.id)!.find((m) => m.id === second.id)!.planMode!.state, 'kept')
  assert.equal(chats.list()[0].chatMode, 'plan')
})

test('plan: /plan and /ask switch the mode for one message only', async () => {
  const fake = withServices(fakeContext())
  const s = sdk()
  const chats = manager(fake, s.queryFn)
  const c = chats.create()
  await chats.command(c.id, 'plan', 'add shops')
  await until(() => !chats.busy(c.id) && s.calls.length === 1)
  assert.equal(s.calls[0].options.permissionMode, 'plan')
  await chats.command(c.id, 'ask', 'what is ModuleLoader?')
  await until(() => !chats.busy(c.id) && s.calls.length === 2)
  assert.ok(s.calls[1].options.disallowedTools.includes('mcp__gentree__write_script'))
  await chats.send(c.id, 'now fix it')
  await until(() => !chats.busy(c.id) && s.calls.length === 3)
  assert.equal(s.calls[2].options.permissionMode, 'default')
  assert.equal(s.calls[2].options.disallowedTools, undefined)
  assert.equal(chats.list()[0].chatMode, undefined, 'chat mode unchanged (edit)')
})

// ---------------------------------------------------------------- edit approval

test('edit: a write shows a diff card; Accept allows, Reject denies, a partial accept is applied by Forge', async () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
  const fake = withServices(fakeContext({ files: { 'src/shared/a.luau': before } }))
  const results: any[] = []
  const after = before.replace('line 1\n', 'LINE ONE\n').replace('line 18', 'LINE EIGHTEEN')
  const s = sdk(async (o) => {
    results.push(await can(o, 'mcp__gentree__write_script', { path: 'src/shared/a.luau', contents: after }))
  })
  const chats = manager(fake, s.queryFn)
  const c = chats.create()
  const decide = async (d: { accept: boolean; hunks?: number[] }) => {
    await until(() => chats.messages(c.id)!.some((m) => m.diff?.state === 'pending'))
    const card = chats.messages(c.id)!.find((m) => m.diff?.state === 'pending')!
    assert.equal(card.diff!.path, 'src/shared/a.luau')
    assert.equal(card.diff!.hunks.length, 2)
    assert.equal(card.diff!.added, 2)
    await chats.reviewEdit(c.id, card.id, d)
    await until(() => !chats.busy(c.id))
    return chats.messages(c.id)!.find((m) => m.id === card.id)!.diff!
  }
  await chats.send(c.id, 'rename the lines')
  assert.equal((await decide({ accept: true })).state, 'accepted')
  assert.equal(results[0].behavior, 'allow')

  await chats.send(c.id, 'again')
  assert.equal((await decide({ accept: false })).state, 'rejected')
  assert.equal(results[1].behavior, 'deny')
  assert.match(results[1].message, /rejected/)
  assert.equal(fake.files.get('src/shared/a.luau'), before)

  await chats.send(c.id, 'once more')
  const partial = await decide({ accept: true, hunks: [2] })
  assert.equal(partial.state, 'partial')
  assert.deepEqual(partial.accepted, [2])
  assert.equal(results[2].behavior, 'deny', 'the tool itself does not run')
  assert.match(results[2].message, /accepted 1 of 2 hunks/)
  assert.equal(fake.files.get('src/shared/a.luau'), before.replace('line 18', 'LINE EIGHTEEN'), 'only hunk 2 applied')
  await assert.rejects(chats.reviewEdit(c.id, chats.messages(c.id)!.find((m) => m.diff)!.id, { accept: true }), /no longer waiting/)
})

test('edit: Stop while a diff card waits rejects it; non-file tools get an action card', async () => {
  const fake = withServices(fakeContext())
  const results: any[] = []
  const s = sdk(async (o) => {
    results.push(await o.canUseTool('mcp__gentree__add_blink_event', { name: 'Claim' }, { signal: o.abortController.signal, toolUseID: 't' }))
  })
  const chats = manager(fake, s.queryFn)
  const c = chats.create()
  await chats.send(c.id, 'add an event')
  await until(() => chats.messages(c.id)!.some((m) => m.diff?.state === 'pending'))
  const card = chats.messages(c.id)!.find((m) => m.diff)!
  assert.equal(card.diff!.path, '')
  assert.match(card.diff!.action!, /name=Claim/)
  chats.stop(c.id)
  await until(() => !chats.busy(c.id))
  assert.equal(results[0].behavior, 'deny')
  assert.equal(chats.messages(c.id)!.find((m) => m.id === card.id)!.diff!.state, 'rejected')
})

test('edit: proposeEdit works out before/after for Edit, MultiEdit, Write, edit_script', async () => {
  const files: Record<string, string> = { 'src/a.luau': 'local a = 1\nlocal b = 2\n' }
  const read = async (p: string) => {
    if (!(p in files)) throw new Error('missing')
    return files[p]
  }
  assert.deepEqual(await proposeEdit('Edit', { file_path: '/r/src/a.luau', old_string: 'a = 1', new_string: 'a = 3' }, '/r', read), { path: 'src/a.luau', before: files['src/a.luau'], after: 'local a = 3\nlocal b = 2\n' })
  assert.equal((await proposeEdit('MultiEdit', { file_path: '/r/src/a.luau', edits: [{ old_string: 'a = 1', new_string: 'a = 5' }, { old_string: 'b = 2', new_string: 'b = 6' }] }, '/r', read))!.after, 'local a = 5\nlocal b = 6\n')
  assert.deepEqual(await proposeEdit('Write', { file_path: '/r/src/new.luau', content: 'x' }, '/r', read), { path: 'src/new.luau', before: null, after: 'x' })
  assert.equal((await proposeEdit('mcp__gentree__edit_script', { path: 'src/a.luau', old_string: 'b = 2', new_string: 'b = 9' }, '/r', read))!.after, 'local a = 1\nlocal b = 9\n')
  assert.equal(await proposeEdit('Edit', { file_path: '/elsewhere/x', old_string: 'a', new_string: 'b' }, '/r', read), null)
  assert.equal(await proposeEdit('mcp__gentree__add_blink_event', { name: 'x' }, '/r', read), null)
})

test('diff: hunks round-trip; any subset of hunks applies cleanly', () => {
  const a = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n')
  const lines = a.split('\n')
  lines[3] = 'X3'
  lines.splice(20, 2, 'Y', 'Z', 'W')
  lines.push('tail')
  const b = lines.join('\n')
  const h = diffLines(a, b)
  assert.equal(h.length, 3)
  assert.equal(applyHunks(a, h, h.map((x) => x.id)), b)
  assert.equal(applyHunks(a, h, []), a)
  const only2 = applyHunks(a, h, [2]).split('\n')
  assert.equal(only2[3], 'l3')
  assert.deepEqual(only2.slice(20, 23), ['Y', 'Z', 'W'])
  assert.equal(diffLines('', 'a\nb')[0].lines.length, 2)
  assert.deepEqual(diffLines('same', 'same'), [])
})

// ---------------------------------------------------------------- commands

test('commands: /help, /todos, /permissions, /context, /effort, /model, /cost, /export', async () => {
  const fake = withServices(fakeContext())
  const s = sdk(async (o) => {
    // The agent keeps its task list through update_todos (allowed in every mode).
    assert.equal((await can(o, 'mcp__gentree__update_todos', {})).behavior, 'allow')
  })
  const chats = manager(fake, s.queryFn, {
    gating: async () => [{ lab: 'vfx', runs: 4, kept: 2, costUsd: 0.5, costPerKept: 0.25, saved: 1200 }]
  })
  const c = chats.create()
  const help = await chats.command(c.id, 'help')
  for (const b of BUILTIN_COMMANDS) assert.ok(help.text!.includes(`/${b.name}`), b.name)
  assert.equal(chats.messages(c.id)!.at(-1)!.command, '/help')

  assert.match((await chats.command(c.id, 'todos')).text!, /No tasks yet/)
  const store = (chats as any).find(c.id)
  const tool = todoTool(() => store, () => {})
  await tool.handler({ todos: [{ text: 'Config', state: 'done' }, { text: 'Service', state: 'in_progress' }] }, {})
  assert.equal((await chats.command(c.id, 'todos')).text, '- [x] Config\n- [~] Service')

  chats.setMode(c.id, 'ask')
  const perms = (await chats.command(c.id, 'permissions')).text!
  assert.match(perms, /\*\*Ask\*\* mode/)
  assert.match(perms, /Blocked:\*\* .*`write_script`/)
  assert.doesNotMatch(perms, /Asks you first/)
  chats.setMode(c.id, 'edit')
  assert.match((await chats.command(c.id, 'permissions')).text!, /Asks you first:\*\* .*`edit_script`/)

  const ctxText = (await chats.command(c.id, 'context')).text!
  assert.match(ctxText, /System prompt: ~/)
  assert.match(ctxText, /Tools \(\d+\)/)

  await chats.command(c.id, 'effort', 'high')
  assert.equal(chats.list()[0].effort, 'high')
  assert.match((await chats.command(c.id, 'effort', 'turbo')).text!, /Unknown effort/)

  assert.equal((await chats.command(c.id, 'model')).action?.kind, 'pickModel')
  assert.match((await chats.command(c.id, 'model', 'anthropic/claude-sonnet-5-5')).text!, /claude-sonnet-5-5/)
  assert.equal(chats.list()[0].model, 'claude-sonnet-5-5')

  await chats.send(c.id, 'hi')
  await until(() => !chats.busy(c.id))
  const cost = (await chats.command(c.id, 'cost')).text!
  assert.match(cost, /This chat/)
  assert.match(cost, /vfx: 4 runs, 2 kept, \$0.5000 · \$0.2500 per kept/)

  const exp = await chats.command(c.id, 'export')
  const path = /`(\.forge\/exports\/[^`]+\.md)`/.exec(exp.text!)![1]
  const md = fake.files.get(path)!
  assert.match(md, /^# hi/)
  assert.match(md, /## You/)
  assert.doesNotMatch(md, /\/help/, 'command output is not exported')

  assert.match((await chats.command(c.id, 'nope')).text!, /Unknown command/)
})

test('commands: /clear, /compact (tokens saved, next turn continues from the summary), /memory', async () => {
  const fake = withServices(fakeContext())
  const s = sdk()
  const notes: string[] = []
  const chats = manager(fake, s.queryFn, { oneShot: async () => '- goal: daily reward\n- done: config', remember: async (n: string) => notes.push(n) })
  const c = chats.create()
  await chats.send(c.id, 'a long request '.repeat(200))
  await until(() => !chats.busy(c.id))
  const r = (await chats.command(c.id, 'compact')).text!
  assert.match(r, /Compacted: ~[\d.]+k? → ~\d+ tokens \(saved ~/)
  await chats.send(c.id, 'continue')
  await until(() => !chats.busy(c.id) && s.calls.length === 2)
  assert.equal(s.calls[1].options.resume, undefined, 'fresh session')
  assert.match(s.calls[1].prompt, /^Summary of the conversation so far \(compacted with \/compact\):\n- goal: daily reward/)
  assert.match(s.calls[1].prompt, /New message:\ncontinue$/)

  assert.equal((await chats.command(c.id, 'memory')).action?.kind, 'openPage')
  await chats.command(c.id, 'memory', 'coins are saved in PlayerData.coins')
  assert.deepEqual(notes, ['coins are saved in PlayerData.coins'])

  const cleared = await chats.command(c.id, 'clear')
  assert.deepEqual(cleared.action, { kind: 'selectChat', id: c.id })
  assert.deepEqual(chats.messages(c.id)!.map((m) => m.command), ['/clear'])
  await chats.send(c.id, 'fresh')
  await until(() => !chats.busy(c.id) && s.calls.length === 3)
  assert.equal(s.calls[2].options.resume, undefined)
  assert.equal(s.calls[2].prompt, 'fresh')
})

test('commands: /init writes .forge/AGENTS.md, merges into an existing one and never touches the root AGENTS.md', async () => {
  const notes = '# Project notes\n## Layout\n- Features live in src/shared/Features\n- Services in src/server/Features\n## Gotchas\n- Never edit src/shared/events'
  const fake = withServices(fakeContext({ files: { 'AGENTS.md': 'No comments in game scripts.' } }))
  const s = sdk(async () => `Here you go:\n\`\`\`markdown\n${notes}\n\`\`\``)
  const chats = manager(fake, s.queryFn)
  const c = chats.create()
  const r = await chats.command(c.id, 'init')
  assert.equal(r.started, true)
  await until(() => !chats.busy(c.id) && fake.files.has(NOTES_FILE))
  assert.ok(s.calls[0].options.disallowedTools.includes('mcp__gentree__write_script'), '/init investigates read-only')
  assert.equal(fake.files.get(NOTES_FILE), notes + '\n')
  assert.equal(fake.files.get('AGENTS.md'), 'No comments in game scripts.')
  assert.equal(chats.messages(c.id)!.find((m) => m.role === 'user')!.text, '/init')

  // Existing notes: kept line for line; new bullets and sections added.
  const mine = '# Notes\n## Layout\n- Features live in src/shared/Features\n- my own note\n\n## Team\n- Ask Maya about DataService\n'
  fake.files.set(NOTES_FILE, mine)
  await chats.command(c.id, 'init')
  await until(() => !chats.busy(c.id) && fake.files.get(NOTES_FILE) !== mine)
  const merged = fake.files.get(NOTES_FILE)!
  for (const line of mine.trim().split('\n')) assert.ok(merged.includes(line), `kept: ${line}`)
  assert.ok(merged.includes('- Services in src/server/Features'))
  assert.ok(merged.indexOf('- Services in src/server/Features') < merged.indexOf('## Team'), 'new bullet goes into its section')
  assert.match(merged, /## Gotchas\n- Never edit src\/shared\/events/)
  assert.equal((merged.match(/Features live in src\/shared\/Features/g) ?? []).length, 1, 'no duplicates')
})

test('notes: mergeNotes and extractNotes', () => {
  assert.equal(extractNotes('Sure!\n```md\n# A\n- x\n```'), '# A\n- x')
  assert.equal(extractNotes('intro\n# A\n- x'), '# A\n- x')
  const m = mergeNotes('## A\n- one\n', '## A\n- one\n- two\n## B\n- three')
  assert.equal(m.added, 2)
  assert.match(m.text, /## A\n- one\n- two\n/)
  assert.match(m.text, /## B\n- three/)
  assert.equal(mergeNotes('## A\n- one\n', '## A\n- one').text, '## A\n- one\n')
})

test('commands: /review sends the git diff in Ask mode; nothing to review without changes', async () => {
  const fake = withServices(fakeContext())
  const s = sdk()
  let diff = ''
  const chats = manager(fake, s.queryFn, { gitDiff: async () => diff })
  const c = chats.create()
  assert.match((await chats.command(c.id, 'review')).text!, /No uncommitted changes/)
  diff = 'diff --git a/src/a.luau b/src/a.luau\n+local x = nil + 1'
  await chats.command(c.id, 'review', 'nil safety')
  await until(() => !chats.busy(c.id) && s.calls.length === 1)
  assert.match(s.calls[0].prompt, /focusing on: nil safety/)
  assert.match(s.calls[0].prompt, /\+local x = nil \+ 1/)
  assert.ok(s.calls[0].options.disallowedTools.includes('mcp__gentree__edit_script'))
  const user = chats.messages(c.id)!.find((m) => m.role === 'user')!
  assert.equal(user.text, '/review nil safety')
  assert.equal(user.mode, 'ask')
})

test('commands: /resume lists or picks other chats; /rewind without checkpoints says so', async () => {
  const fake = withServices(fakeContext())
  const chats = manager(fake, sdk().queryFn)
  const a = chats.create(undefined, { title: 'Shop purchase bug' })
  const b = chats.create(undefined, { title: 'Daily rewards' })
  const list = await chats.command(b.id, 'resume')
  assert.equal(list.action?.kind, 'pickChat')
  assert.deepEqual((list.action as any).chats.map((c: any) => c.id), [a.id])
  assert.deepEqual((await chats.command(b.id, 'resume', 'shop')).action, { kind: 'selectChat', id: a.id })
  assert.match((await chats.command(b.id, 'rewind')).text!, /No checkpoints/)
})

// ---------------------------------------------------------------- custom commands

test('custom commands: frontmatter, namespaces, $ARGUMENTS / $1, precedence, files on disk', async () => {
  const c = parseCustomCommand('frontend/test.md', '---\ndescription: Run UI tests\nargument-hint: <screen> [mode]\nmode: ask\n---\nTest $1 in $2 mode. All: $ARGUMENTS', 'project')!
  assert.equal(c.name, 'frontend:test')
  assert.equal(c.description, 'Run UI tests')
  assert.equal(c.argumentHint, '<screen> [mode]')
  assert.equal(c.mode, 'ask')
  assert.equal(expandCommand(c.body, 'Shop "dark mode"'), 'Test Shop in dark mode mode. All: Shop "dark mode"')
  assert.deepEqual(splitArgs(`a "b c" 'd'`), ['a', 'b c', 'd'])
  assert.equal(expandCommand('Fix the bug', 'in Shop'), 'Fix the bug\n\nin Shop', 'arguments appended without placeholders')
  assert.equal(parseCustomCommand('x.md', '---\nallowed-tools: Read, Grep\n---\nlook', 'user')!.mode, 'ask', 'no write tool allowed -> ask')
  assert.equal(parseCustomCommand('x.md', 'Fix it', 'user')!.description, 'Fix it')
  assert.equal(parseCustomCommand('9bad.md', 'x', 'user'), null)
  assert.equal(parseCustomCommand('empty.md', '---\na: b\n---\n', 'user'), null)
  const merged = mergeCommands([parseCustomCommand('fix.md', 'project fix', 'project')!, parseCustomCommand('help.md', 'nope', 'project')!], [parseCustomCommand('fix.md', 'user fix', 'user')!, parseCustomCommand('mine.md', 'mine', 'user')!])
  assert.deepEqual(merged.map((m) => `${m.name}:${m.source}`), ['fix:project', 'mine:user'], 'project wins, built-ins cannot be shadowed')
  assert.deepEqual(parseSlash('/Fix the  shop'), { name: 'fix', args: 'the  shop' })
  assert.equal(parseSlash('not a command'), null)
  assert.deepEqual(matchCommands(BUILTIN_COMMANDS, '/co').map((x) => x.name), ['compact', 'cost', 'context'])

  const root = await mkdtemp(join(tmpdir(), 'forge-cmd-'))
  const user = await mkdtemp(join(tmpdir(), 'forge-ucmd-'))
  try {
    await mkdir(join(root, '.forge', 'commands', 'econ'), { recursive: true })
    await writeFile(join(root, '.forge', 'commands', 'econ', 'balance.md'), '---\ndescription: Balance check\nmode: plan\n---\nCheck prices of $ARGUMENTS')
    await writeFile(join(user, 'tidy.md'), 'Tidy $ARGUMENTS')
    const all = await loadCustomCommands(root, user)
    assert.deepEqual(all.map((x) => `${x.name}:${x.source}`), ['econ:balance:project', 'tidy:user'])

    const fake = withServices(fakeContext())
    fake.ctx.project = () => ({ root, name: 'T', placeIds: [] }) as any
    const s = sdk()
    const chats = manager(fake, s.queryFn, { userCommandsDir: user })
    const ch = chats.create()
    const names = (await chats.commands()).map((x) => x.name)
    assert.ok(names.includes('econ:balance') && names.includes('tidy') && names.includes('compact'))
    const r = await chats.command(ch.id, 'econ:balance', 'the sword shop')
    assert.equal(r.started, true)
    await until(() => !chats.busy(ch.id) && s.calls.length === 1)
    assert.equal(s.calls[0].prompt, 'Check prices of the sword shop')
    assert.equal(s.calls[0].options.permissionMode, 'plan', 'mode from frontmatter')
    assert.equal(chats.messages(ch.id)![0].text, '/econ:balance the sword shop')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(user, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- checkpoints

async function tempRepo(): Promise<{ dir: string; git: (c: string) => string }> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-cp-'))
  const git = (c: string) => execSync(`git ${c}`, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' } }).toString()
  git('init -q')
  await writeFile(join(dir, '.gitignore'), 'Packages/\n')
  await mkdir(join(dir, 'src'), { recursive: true })
  await mkdir(join(dir, 'Packages'), { recursive: true })
  await writeFile(join(dir, 'src', 'a.luau'), 'v1')
  await writeFile(join(dir, 'Packages', 'lib.lua'), 'wally')
  git('add -A')
  git('commit -qm init')
  return { dir, git }
}

test('checkpoints: create / restore on a temp git repo without touching its history, index or refs', async () => {
  const { dir, git } = await tempRepo()
  try {
    const head = git('rev-parse HEAD')
    const refs = git('for-each-ref')
    const log = git('log --oneline --all')
    await writeFile(join(dir, 'src', 'staged.luau'), 'staged')
    git('add src/staged.luau')
    const staged = git('diff --cached --name-only')

    const cp = new Checkpoints(dir)
    const c1 = await cp.create('before turn 1')
    await writeFile(join(dir, 'src', 'a.luau'), 'v2')
    await writeFile(join(dir, 'src', 'b.luau'), 'new file')
    await writeFile(join(dir, 'Packages', 'lib.lua'), 'changed by wally')
    assert.deepEqual((await cp.changedSince(c1)).sort(), ['src/a.luau', 'src/b.luau'])
    const r = await cp.restore(c1)
    assert.deepEqual(r.files.sort(), ['src/a.luau', 'src/b.luau'])
    assert.equal(await readFile(join(dir, 'src', 'a.luau'), 'utf8'), 'v1')
    await assert.rejects(readFile(join(dir, 'src', 'b.luau'), 'utf8'), 'added file removed')
    assert.equal(await readFile(join(dir, 'Packages', 'lib.lua'), 'utf8'), 'changed by wally', 'ignored files untouched')
    // The rewind itself can be undone.
    await cp.restore(r.undo)
    assert.equal(await readFile(join(dir, 'src', 'a.luau'), 'utf8'), 'v2')
    assert.equal(await readFile(join(dir, 'src', 'b.luau'), 'utf8'), 'new file')

    assert.equal(git('rev-parse HEAD'), head)
    assert.equal(git('for-each-ref'), refs)
    assert.equal(git('log --oneline --all'), log)
    assert.equal(git('diff --cached --name-only'), staged, "the user's index is untouched")
    assert.doesNotMatch(git('status --porcelain'), /\.forge/, 'checkpoints never show up in git status')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('checkpoints: /rewind restores files and conversation to before a turn', async () => {
  const { dir, git } = await tempRepo()
  try {
    const head = git('rev-parse HEAD')
    const fake = withServices(fakeContext())
    fake.ctx.project = () => ({ root: dir, name: 'T', placeIds: [] }) as any
    const s = sdk(async (_o, n) => {
      if (n === 0) await writeFile(join(dir, 'src', 'a.luau'), 'turn 1')
      if (n === 1) await writeFile(join(dir, 'src', 'c.luau'), 'turn 2')
    })
    const credentials = new Credentials(fake.ctx, async () => null, { ANTHROPIC_API_KEY: 'sk' })
    const chats = new ChatManager(fake.ctx, { queryFn: s.queryFn, credentials, toolFs: fake.fs })
    const c = chats.create()
    await chats.send(c.id, 'first change')
    await until(() => !chats.busy(c.id) && s.calls.length === 1)
    await chats.send(c.id, 'second change')
    await until(() => !chats.busy(c.id) && s.calls.length === 2)
    const cps = chats.checkpointsOf(c.id)
    assert.deepEqual(cps.map((x) => x.label), ['first change', 'second change'])
    // Ask mode takes none (it cannot edit).
    await chats.send(c.id, 'what changed?')
    await until(() => !chats.busy(c.id) && s.calls.length === 3)
    chats.setMode(c.id, 'ask')
    await chats.send(c.id, 'explain')
    await until(() => !chats.busy(c.id) && s.calls.length === 4)
    assert.equal(chats.checkpointsOf(c.id).length, 3)

    const pick = await chats.command(c.id, 'rewind')
    assert.equal(pick.action?.kind, 'pickCheckpoint')
    assert.equal((pick.action as any).checkpoints[0].label, 'what changed?', 'newest first')

    // Files only: conversation stays.
    const n = chats.messages(c.id)!.length
    await chats.rewind(c.id, cps[1].id, 'files')
    await assert.rejects(readFile(join(dir, 'src', 'c.luau'), 'utf8'))
    assert.equal(await readFile(join(dir, 'src', 'a.luau'), 'utf8'), 'turn 1')
    assert.equal(chats.messages(c.id)!.length, n + 1)

    // Both: back to before the first turn.
    const r = await chats.rewind(c.id, cps[0].id, 'both')
    assert.ok(r.removed > 0)
    assert.equal(await readFile(join(dir, 'src', 'a.luau'), 'utf8'), 'v1')
    const left = chats.messages(c.id)!
    assert.ok(!left.some((m) => m.text === 'first change'))
    assert.equal(left.at(-1)!.command, '/rewind')
    assert.equal(chats.checkpointsOf(c.id).length, 0)
    chats.setMode(c.id, 'edit')
    await chats.send(c.id, 'try again')
    await until(() => !chats.busy(c.id) && s.calls.length === 5)
    assert.equal(s.calls[4].options.resume, undefined, 'a fresh session after the rewind')
    assert.equal(s.calls[4].prompt, 'try again')
    assert.equal(git('rev-parse HEAD'), head)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('plan parsing: lenient sections and bullets', () => {
  const p = parsePlan('Here is the plan.\n\n**Steps:**\n- one\n- two\n\nFiles:\n- `a.luau`\n\n### Risks and checks\n- slow')
  assert.deepEqual(p.steps, ['one', 'two'])
  assert.deepEqual(p.files, ['`a.luau`'])
  assert.deepEqual(p.risks, ['slow'])
  assert.equal(p.summary, 'Here is the plan.')
  assert.deepEqual(parsePlan('1. Edit `src/x.luau`\n2. Test').files, ['src/x.luau'])
})

test('notes: .forge/AGENTS.md from /init joins the project rules block after the root AGENTS.md', async () => {
  const { buildRulesBlock, readRulesSources } = await import('../src/main/agent/projectRules.ts')
  const fake = fakeContext({ files: { 'AGENTS.md': 'No comments.', '.forge/AGENTS.md': '# Project notes\n- Features in src/shared/Features' } })
  const block = buildRulesBlock(await readRulesSources(fake.ctx))
  assert.ok(block.indexOf('AGENTS.md (project root)') < block.indexOf('Project notes (.forge/AGENTS.md'))
  assert.match(block, /Features in src\/shared\/Features/)
})
