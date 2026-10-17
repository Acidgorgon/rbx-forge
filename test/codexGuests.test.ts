// Codex (ChatGPT plan) as a group-chat guest: adding it, @mentions and roundtables through
// `codex exec --json` in the read-only sandbox, its own resumed thread, the guest-tools switch
// (scratch folder), the stale-thread retry, "not signed in", and name resolution next to OpenAI.
// The CLI is a fake runner, as in codex.test.ts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fakeContext } from './agentFake.ts'
import { ChatManager } from '../src/main/agent/chat.ts'
import { Credentials } from '../src/main/agent/credentials.ts'
import { Providers } from '../src/main/agent/providers.ts'
import { CodexService, type CliRunner } from '../src/main/agent/codex/service.ts'
import { codexGroupPrompt } from '../src/main/agent/codex/chat.ts'
import { GroupChat } from '../src/main/agent/groupChat.ts'
import type { QueryFn } from '../src/main/agent/sdk.ts'

const plainSafe = async () => null

async function idle(chats: ChatManager, id: string) {
  while (chats.busy(id)) await new Promise((r) => setTimeout(r, 5))
}

interface ExecCall {
  args: string[]
  stdin: string
  cwd: string
  cwdExisted: boolean
}

// A fake `codex`: signed in with ChatGPT; each exec answers with `reply(n)` (n counts exec runs)
// on a new thread, or on the thread it resumes.
function fakeCodex(reply: (n: number, call: ExecCall) => { text?: string; error?: string; stderr?: string; code?: number; warnings?: string[] } = (n) => ({ text: `Codex says ${n}` })) {
  const execs: ExecCall[] = []
  const run: CliRunner = async (o) => {
    if (o.args[0] === 'login' && o.args[1] === 'status') return { code: 0, stderr: 'Logged in using ChatGPT\n', aborted: false, timedOut: false }
    if (o.args[0] === '--version') {
      o.onStdoutLine?.('codex-cli 0.162.1')
      return { code: 0, stderr: '', aborted: false, timedOut: false }
    }
    if (o.args[0] !== 'exec') return { code: 1, stderr: '', aborted: false, timedOut: false }
    const call = { args: o.args, stdin: o.stdin ?? '', cwd: o.cwd, cwdExisted: existsSync(o.cwd) }
    execs.push(call)
    const n = execs.length
    const r = reply(n, call)
    const at = o.args.indexOf('resume')
    const thread = at >= 0 ? o.args[at + 1] : `th-${n}`
    if (r.code && !r.text) return { code: r.code, stderr: r.stderr ?? '', aborted: false, timedOut: false }
    const out = (e: unknown) => o.onStdoutLine?.(JSON.stringify(e))
    out({ type: 'thread.started', thread_id: thread })
    for (const [k, w] of (r.warnings ?? []).entries()) out({ type: 'item.completed', item: { id: `item_w${k}`, type: 'error', message: w } })
    if (r.text) out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: r.text } })
    if (r.error) out({ type: 'turn.failed', error: { message: r.error } })
    else out({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 0 } })
    return { code: r.error ? 1 : 0, stderr: '', aborted: false, timedOut: false }
  }
  return { svc: new CodexService({ findBin: () => '/bin/codex', run, env: () => ({}) }), execs }
}

// Host: Claude through a fake Agent SDK query. Guests: whatever the test adds.
async function setup(codex: CodexService, opts: { openai?: boolean } = {}) {
  const fake = fakeContext()
  const creds = new Credentials(fake.ctx, plainSafe, {})
  await creds.setKey('anthropic', 'key-anthropic')
  if (opts.openai) await creds.setKey('openai', 'key-openai')
  const hostPrompts: string[] = []
  const queryFn: QueryFn = ({ prompt }) => {
    hostPrompts.push(String(prompt))
    const plan = /## Agreements/.test(String(prompt))
    return (async function* () {
      yield { type: 'assistant', parent_tool_use_id: null, session_id: 's', message: { content: [{ type: 'text', text: plan ? '## Agreements\n- ok\n## Disagreements\n- none\n## Recommendation\n1. Do it' : `Opus turn ${hostPrompts.length}` }] } } as any
      yield { type: 'result', subtype: 'success', is_error: false, result: '', session_id: 's', usage: { input_tokens: 10, output_tokens: 5 } } as any
    })()
  }
  const fetchFn = (async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  const providers = new Providers(fake.ctx, creds, fetchFn, () => codex)
  const chats = new ChatManager(fake.ctx, { credentials: creds, providers, fetchFn, toolFs: fake.fs, queryFn, checkpoints: null, codex: () => codex })
  return { fake, chats, providers, hostPrompts }
}

test('a Codex model joins as a guest and answers @mentions through codex exec, read-only, resuming its own thread', async () => {
  const { svc, execs } = fakeCodex()
  const { chats } = await setup(svc)
  const c = chats.create({ provider: 'anthropic', model: 'claude-opus-5-5' })
  const session = chats.addGuest(c.id, { provider: 'codex', model: 'gpt-6.1-sol' })
  assert.deepEqual(session.guests?.map((g) => `${g.provider}/${g.model}@${g.alias}`), ['codex/gpt-6.1-sol@sol'])
  const joined = chats.messages(c.id)!.at(-1)!
  assert.match(joined.text, /joined the chat as a guest \(@sol\)\. It answers through the Codex CLI .*read-only sandbox/)

  await chats.send(c.id, '@sol what do you think of the shop?')
  await idle(chats, c.id)
  assert.equal(execs.length, 1)
  const [first] = execs
  assert.equal(first.args[first.args.indexOf('--sandbox') + 1], 'read-only', 'guests always run in the read-only sandbox')
  assert.equal(first.args[first.args.indexOf('--cd') + 1], '/fake/project', 'guest tools on: the project root')
  assert.equal(first.args[first.args.indexOf('--model') + 1], 'gpt-6.1-sol')
  assert.ok(!first.args.includes('resume') && !first.args.includes('--ephemeral'))
  assert.match(first.stdin, /guest adviser in a group chat/)
  assert.match(first.stdin, /read-only sandbox in the project folder/)
  assert.match(first.stdin, /The user addressed you directly:\n@sol what do you think of the shop\?/)
  const answer = chats.messages(c.id)!.find((m) => m.role === 'assistant' && m.text === 'Codex says 1')!
  assert.equal(answer.speaker?.provider, 'codex')
  assert.equal(answer.speaker?.label, 'GPT-6.1 Sol')
  // ChatGPT plan: tokens counted, no cost.
  const usage = chats.list().find((x) => x.id === c.id)!.usage!.find((u) => u.provider === 'codex')!
  assert.deepEqual({ input: usage.input, output: usage.output, cost: usage.costUsd, calls: usage.calls }, { input: 120, output: 30, cost: 0, calls: 1 })

  // The next ask resumes the guest's thread with only the new context (the system prompt is in it).
  await chats.send(c.id, '@sol and the inventory?')
  await idle(chats, c.id)
  const second = execs[1]
  assert.deepEqual(second.args.slice(second.args.indexOf('resume'), second.args.indexOf('resume') + 2), ['resume', 'th-1'])
  assert.doesNotMatch(second.stdin, /guest adviser/)
  assert.match(second.stdin, /read-only sandbox in the project folder/)
  assert.match(second.stdin, /@sol and the inventory\?/)
  // The host was never run for direct asks; it hears about them next turn.
  await chats.send(c.id, 'ok, go on')
  await idle(chats, c.id)
  assert.equal(execs.length, 2)
})

test('roundtable with a Codex guest: host and Codex take turns, Codex resumes its thread, the host writes the plan', async () => {
  const { svc, execs } = fakeCodex()
  const { chats, hostPrompts } = await setup(svc)
  const c = chats.create({ provider: 'anthropic', model: 'claude-opus-5-5' })
  chats.addGuest(c.id, { provider: 'codex', model: 'codex-default' })
  await chats.roundtable(c.id, 'How should we save player data?', 2)
  await idle(chats, c.id)
  assert.equal(execs.length, 2, 'one Codex turn per round')
  assert.ok(!execs[0].args.includes('--model'), 'codex-default uses the Codex config model')
  assert.match(execs[0].stdin, /Roundtable on: How should we save player data\?\nRound 1 of 2/)
  assert.ok(execs[1].args.includes('resume'))
  assert.match(execs[1].stdin, /Round 2 of 2/)
  // Round 2's pack shows what Codex said in round 1.
  assert.match(execs[1].stdin, /\[Codex Default\]: Codex says 1/)
  assert.equal(hostPrompts.length, 3, 'host: two rounds and the plan')
  assert.match(hostPrompts[1], /\[Codex Default\]: Codex says 1/)
  const plan = chats.messages(c.id)!.find((m) => m.card === 'plan')!
  assert.match(plan.text, /## Recommendation/)
  assert.equal(plan.speaker?.provider, 'anthropic')
})

test('guest tools off: Codex runs in an empty scratch folder, is told not to read the project, and the switch says so', async () => {
  const { svc, execs } = fakeCodex()
  const { chats } = await setup(svc)
  const c = chats.create({ provider: 'anthropic', model: 'claude-opus-5-5' })
  chats.addGuest(c.id, { provider: 'codex', model: 'gpt-6.1-sol' })
  chats.setGuestTools(c.id, false)
  const notice = chats.messages(c.id)!.at(-1)!
  assert.equal(notice.role, 'system')
  assert.match(notice.text, /GPT-6.1 Sol \(Codex\) will run in an empty scratch folder/)
  assert.match(notice.text, /blocks writes, not reads/)
  await chats.send(c.id, '@sol thoughts?')
  await idle(chats, c.id)
  const [call] = execs
  const cwd = call.args[call.args.indexOf('--cd') + 1]
  assert.notEqual(cwd, '/fake/project')
  assert.match(cwd, /forge-codex-guest-/)
  assert.ok(call.cwdExisted, 'the scratch folder exists during the run')
  assert.ok(!existsSync(cwd), 'and is removed afterwards')
  assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only')
  assert.match(call.stdin, /empty scratch folder/)
  assert.match(call.stdin, /You have no tools/)
  // Switching back says so too; no notice when nothing changes.
  const before = chats.messages(c.id)!.length
  chats.setGuestTools(c.id, false)
  assert.equal(chats.messages(c.id)!.length, before)
  chats.setGuestTools(c.id, true)
  assert.match(chats.messages(c.id)!.at(-1)!.text, /can read the project again/)
})

test('a Codex guest whose thread is gone starts a new one; errors are shown once, under its name', async () => {
  const { svc, execs } = fakeCodex((n) => (n === 2 ? { code: 1, stderr: 'Error: no rollout found for thread id th-1' } : n === 3 ? { error: 'You have hit your usage limit' } : { text: `Codex says ${n}` }))
  const { chats } = await setup(svc)
  const c = chats.create({ provider: 'anthropic', model: 'claude-opus-5-5' })
  chats.addGuest(c.id, { provider: 'codex', model: 'gpt-6.1-sol' })
  await chats.send(c.id, '@sol one')
  await idle(chats, c.id)
  await chats.send(c.id, '@sol two')
  await idle(chats, c.id)
  assert.equal(execs.length, 3)
  assert.ok(execs[1].args.includes('resume'))
  assert.ok(!execs[2].args.includes('resume'), 'retried on a new thread')
  assert.match(execs[2].stdin, /guest adviser/, 'a new thread gets the system prompt again')
  const errors = chats.messages(c.id)!.filter((m) => m.role === 'system' && /usage limit|rollout/.test(m.text))
  assert.deepEqual(errors.map((m) => m.text), ['GPT-6.1 Sol: You have hit your usage limit'])
  // Removing the guest forgets its thread: invited again, it starts fresh.
  chats.removeGuest(c.id, 'sol')
  chats.addGuest(c.id, { provider: 'codex', model: 'gpt-6.1-sol' })
  await chats.send(c.id, '@sol three')
  await idle(chats, c.id)
  assert.ok(!execs[3].args.includes('resume'))
})

test('a Codex guest: CLI config warnings stay out of the chat; only its reply is posted', async () => {
  const warning = 'Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings. user (/home/you/.codex/config.toml): `mcp_servers.Neon.type` is ignored.'
  const { svc } = fakeCodex(() => ({ text: 'Hi!', warnings: [warning, warning] }))
  const { chats } = await setup(svc)
  const c = chats.create({ provider: 'anthropic', model: 'claude-opus-5-5' })
  chats.addGuest(c.id, { provider: 'codex', model: 'gpt-6.1-sol' })
  const before = chats.messages(c.id)!.length
  await chats.send(c.id, '@sol hi')
  await idle(chats, c.id)
  const added = chats.messages(c.id)!.slice(before).filter((m) => m.role !== 'user')
  assert.ok(!added.some((m) => /ignoring|unrecognized|is ignored/.test(m.text)), `no warning in the chat: ${added.map((m) => m.text).join(' | ')}`)
  assert.deepEqual(added.filter((m) => m.role === 'assistant').map((m) => m.text), ['Hi!'])
})

test('Codex not signed in: the guest says so with a Settings link, no CLI run, no thrown error', async () => {
  const svc = new CodexService({ findBin: () => null })
  const { chats } = await setup(svc)
  const c = chats.create({ provider: 'anthropic', model: 'claude-opus-5-5' })
  assert.doesNotThrow(() => chats.addGuest(c.id, { provider: 'codex', model: 'gpt-6.1-sol' }))
  await chats.send(c.id, '@sol hi')
  await idle(chats, c.id)
  const last = chats.messages(c.id)!.at(-1)!
  assert.equal(last.settingsLink, 'codex')
  assert.match(last.text, /^GPT-6.1 Sol: Codex CLI not found/)
})

test('names: OpenAI wins "sol" when both are set up; "codex" and an OpenAI model without a key find Codex', async () => {
  const { svc } = fakeCodex()
  const both = await setup(svc, { openai: true })
  const group = new GroupChat(both.fake.ctx, { credentials: new Credentials(both.fake.ctx, plainSafe, {}), providers: both.providers })
  const room = { host: { provider: 'anthropic' as const, model: 'claude-opus-5-5', label: 'Claude Opus 5.5', alias: 'opus', role: 'host' as const }, guests: [] }
  const sol = await group.resolve('sol', room)
  assert.equal(sol.kind === 'ok' && `${sol.choice.provider}/${sol.choice.model}`, 'openai/gpt-6.1-sol')
  const codex = await group.resolve('codex', room)
  assert.equal(codex.kind === 'ok' && `${codex.choice.provider}/${codex.choice.model}`, 'codex/codex-default')
  const only = await setup(svc)
  const g2 = new GroupChat(only.fake.ctx, { credentials: new Credentials(only.fake.ctx, plainSafe, {}), providers: only.providers })
  const viaPlan = await g2.resolve('gpt 6.1 sol', room)
  assert.equal(viaPlan.kind === 'ok' && `${viaPlan.choice.provider}/${viaPlan.choice.model}`, 'codex/gpt-6.1-sol')
})

test('codexGroupPrompt: the system prompt only on a fresh thread; the file-access line every time', () => {
  const fresh = codexGroupPrompt({ system: 'SYS', prompt: 'ASK', fresh: true, projectFiles: true })
  assert.ok(fresh.startsWith('SYS\n\n') && fresh.endsWith('\n\nASK'))
  assert.match(fresh, /read-only sandbox in the project folder/)
  const resumed = codexGroupPrompt({ system: 'SYS', prompt: 'ASK', fresh: false, projectFiles: false })
  assert.ok(!resumed.includes('SYS'))
  assert.match(resumed, /empty scratch folder/)
})
