// A 403 on one model is not a dead sign-in. The Claude CLI words every 401 / 403 as "Failed to
// authenticate. API Error: <status> ..." and flags the assistant message authentication_failed, so
// a request for a model the account cannot use looked exactly like an expired login and Settings >
// Accounts showed "Sign-in expired". watchAnthropicAuth now marks the login failed only for a real
// auth failure (401, credential wording) or when a probe on another model fails too.
// The message shapes below are what the bundled CLI emits for a 403 (captured against a local fake API).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeContext } from './agentFake.ts'
import { AUTH_PROBE_SYSTEM, AuthHealth, authSignal, classifyAuthError, errorStatus, probeModelFor, watchAnthropicAuth } from '../src/main/accounts/authHealth.ts'
import { parseTestResult } from '../src/main/accounts/claude.ts'
import { AUTH_HELP, authHelpFor, isAuthHelp, modelRejectedHelp, toChatMessages, type QueryFn } from '../src/main/agent/sdk.ts'
import { Credentials } from '../src/main/agent/credentials.ts'
import { Providers } from '../src/main/agent/providers.ts'
import { ChatManager } from '../src/main/agent/chat.ts'

const REJECT_TEXT = 'Failed to authenticate. API Error: 403 {"type":"error","error":{"type":"permission_error","message":"claude-opus-5-5 is not available on this account"}}'
const REVOKED_TEXT = 'Failed to authenticate. API Error: 403 {"type":"error","error":{"type":"permission_error","message":"OAuth token has been revoked"}}'
const EXPIRED_TEXT = 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth session expired and could not be refreshed"}}'

// The CLI's messages for a failed request with this text and status.
function failure(text: string, status: number): unknown[] {
  return [
    { type: 'assistant', error: 'authentication_failed', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } },
    { type: 'result', subtype: 'success', is_error: true, api_error_status: status, result: text }
  ]
}
const success = (text = 'OK'): unknown[] => [
  { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } },
  { type: 'result', subtype: 'success', is_error: false, result: text }
]

// A query function that answers per model (probes included); records each call's model and prompt.
function cli(byModel: (model: string) => unknown[], opts: { throwAfter?: boolean } = {}) {
  const calls: { model: string; probe: boolean }[] = []
  const inner = ({ options }: { options: any }) => {
    const model = String(options.model)
    calls.push({ model, probe: options.systemPrompt === AUTH_PROBE_SYSTEM })
    const msgs = byModel(model)
    return (async function* () {
      for (const m of msgs) yield m as never
      // The SDK also throws after an error result ("Claude Code returned an error result: ...").
      const last = msgs[msgs.length - 1] as { is_error?: boolean; result?: string }
      if (opts.throwAfter && last?.is_error) throw new Error(`Claude Code returned an error result: ${last.result}`)
    })()
  }
  return { calls, inner }
}

async function run(q: ReturnType<typeof watchAnthropicAuth>, model: string): Promise<void> {
  try {
    for await (const _ of q({ prompt: 'x', options: { model, env: {} } as never })) void _
  } catch {
    // the error result is the caller's business
  }
}

function setup(byModel: (model: string) => unknown[], opts: { throwAfter?: boolean } = {}) {
  const fake = fakeContext()
  const health = new AuthHealth(fake.ctx)
  const c = cli(byModel, opts)
  const probes: Promise<void>[] = []
  const q = watchAnthropicAuth(c.inner as never, health, { onProbe: (p) => void probes.push(p) })
  return { health, calls: c.calls, probes, q }
}

test('classifyAuthError: 401 and credential wording are auth failures; a plain 403 is a per-model rejection', () => {
  assert.equal(errorStatus(REJECT_TEXT), 403)
  assert.equal(errorStatus('x', 401), 401)
  assert.equal(errorStatus('Overloaded'), undefined)
  assert.equal(classifyAuthError(REJECT_TEXT), 'rejected')
  assert.equal(classifyAuthError('Failed to authenticate. API Error: 403 claude-opus-5-5 is not available on this account'), 'rejected')
  assert.equal(classifyAuthError('Claude Code returned an error result: ' + REJECT_TEXT), 'rejected')
  assert.equal(classifyAuthError('Forbidden', 403), 'rejected')
  assert.equal(classifyAuthError(REVOKED_TEXT), 'auth')
  assert.equal(classifyAuthError('Failed to authenticate. API Error: 403 OAuth organization not allowed (oauth_org_not_allowed)'), 'auth')
  assert.equal(classifyAuthError(EXPIRED_TEXT), 'auth')
  assert.equal(classifyAuthError('Invalid bearer token', 401), 'auth')
  assert.equal(classifyAuthError('Not logged in · Please run /login'), 'auth')
  assert.equal(classifyAuthError('Overloaded', 529), null)
  assert.equal(classifyAuthError(undefined), null)
  assert.equal(probeModelFor('claude-opus-5-5'), 'claude-haiku-5-5')
  assert.equal(probeModelFor('claude-haiku-5-5'), 'claude-sonnet-5-5')
})

test('authSignal: the CLI messages of a per-model 403 are a rejection, not a failed sign-in', () => {
  const [assistant, result] = failure(REJECT_TEXT, 403)
  assert.deepEqual(authSignal(assistant as never), { ok: false, message: REJECT_TEXT, rejected: true })
  assert.equal(authSignal(result as never)?.rejected, true)
  const [a401, r401] = failure(EXPIRED_TEXT, 401)
  assert.deepEqual(authSignal(a401 as never), { ok: false, message: 'authentication_failed' })
  assert.equal(authSignal(r401 as never)?.rejected, undefined)
  assert.equal(authSignal(r401 as never)?.ok, false)
  assert.equal(authSignal(failure(REVOKED_TEXT, 403)[1] as never)?.rejected, undefined)
})

test('a 403 on one model does not mark the Claude login expired when a probe on another model answers', async () => {
  const { health, calls, probes, q } = setup((m) => (m === 'claude-opus-5-5' ? failure(REJECT_TEXT, 403) : success()), { throwAfter: true })
  health.record('claudeLogin', true)
  await run(q, 'claude-opus-5-5')
  assert.equal(health.failed('claudeLogin'), false, 'not marked while the probe runs')
  assert.equal(probes.length, 1)
  await Promise.all(probes)
  assert.deepEqual(calls, [{ model: 'claude-opus-5-5', probe: false }, { model: 'claude-haiku-5-5', probe: true }])
  assert.equal(health.failed('claudeLogin'), false)
  assert.equal(health.get()?.ok, true)
  // A probe on the same rejected model is not repeated within a few minutes.
  await run(q, 'claude-opus-5-5')
  assert.equal(probes.length, 1)
  assert.equal(health.failed('claudeLogin'), false)
  // An earlier (wrong) "expired" record is cleared by a probe that answers.
  const s2 = setup((m) => (m === 'claude-haiku-5-5' ? failure(REJECT_TEXT, 403) : success()))
  s2.health.record('claudeLogin', false, 'stale')
  await run(s2.q, 'claude-haiku-5-5')
  await Promise.all(s2.probes)
  assert.deepEqual(s2.calls.map((c) => c.model), ['claude-haiku-5-5', 'claude-sonnet-5-5'])
  assert.equal(s2.health.failed('claudeLogin'), false)
})

test('a 403 is an expired sign-in when the probe on another model fails too', async () => {
  const { health, calls, probes, q } = setup(() => failure(REJECT_TEXT, 403), { throwAfter: true })
  await run(q, 'claude-opus-5-5')
  assert.equal(health.failed('claudeLogin'), false)
  await Promise.all(probes)
  assert.deepEqual(calls.map((c) => `${c.model}${c.probe ? ' (probe)' : ''}`), ['claude-opus-5-5', 'claude-haiku-5-5 (probe)'])
  assert.equal(health.failed('claudeLogin'), true)
  assert.match(health.get()?.message ?? '', /a check on claude-haiku-5-5 failed too/)
  // The probe failing with a 401 counts the same.
  const s2 = setup((m) => (m === 'claude-opus-5-5' ? failure(REJECT_TEXT, 403) : failure(EXPIRED_TEXT, 401)))
  await run(s2.q, 'claude-opus-5-5')
  await Promise.all(s2.probes)
  assert.equal(s2.health.failed('claudeLogin'), true)
  // A probe that fails for another reason (overloaded) proves nothing: no record.
  const s3 = setup((m) => (m === 'claude-opus-5-5' ? failure(REJECT_TEXT, 403) : [{ type: 'result', subtype: 'success', is_error: true, api_error_status: 529, result: 'Overloaded' }]))
  await run(s3.q, 'claude-opus-5-5')
  await Promise.all(s3.probes)
  assert.equal(s3.health.get(), null)
})

test('real auth failures still mark the login at once, without a probe', async () => {
  for (const [text, status] of [[EXPIRED_TEXT, 401], [REVOKED_TEXT, 403]] as const) {
    const { health, calls, probes, q } = setup(() => failure(text, status), { throwAfter: true })
    await run(q, 'claude-opus-5-5')
    assert.equal(health.failed('claudeLogin'), true, text)
    assert.equal(probes.length, 0)
    assert.equal(calls.length, 1)
  }
  // A thrown 401 (no messages) too.
  const fake = fakeContext()
  const health = new AuthHealth(fake.ctx)
  const q = watchAnthropicAuth((() => (async function* () {
    throw new Error('Failed to authenticate. API Error: 401 Invalid bearer token')
  })()) as never, health)
  await run(q, 'claude-haiku-5-5')
  assert.equal(health.failed('claudeLogin'), true)
})

test('Test connection: a 403 model rejection is a failed test, not an expired sign-in', () => {
  const r = (stdout: string) => ({ code: 1, stdout, stderr: '', cancelled: false, timedOut: false }) as never
  const rejected = parseTestResult(r(JSON.stringify({ is_error: true, api_error_status: 403, result: REJECT_TEXT })))
  assert.equal(rejected.auth, false)
  assert.match(rejected.message, /^Test failed: .*403/)
  assert.equal(parseTestResult(r(JSON.stringify({ is_error: true, api_error_status: 401, result: EXPIRED_TEXT }))).auth, true)
  assert.equal(parseTestResult(r(JSON.stringify({ is_error: true, api_error_status: 403, result: REVOKED_TEXT }))).auth, true)
})

// ---- chat messages: a per-model 403 names the model, a real auth failure keeps the sign-in help ----

const OPUS_HELP = "Your account can't use Claude Opus 5.5 (claude-opus-5-5). Pick another model in the model menu."

test('toChatMessages: a per-model 403 names the model; a real auth failure keeps the sign-in help', () => {
  const [assistant, result] = failure(REJECT_TEXT, 403)
  const out = toChatMessages(assistant as never, 'main', undefined, { model: 'claude-opus-5-5' })
  assert.deepEqual(out.map((m) => [m.role, m.text]), [['system', OPUS_HELP]])
  assert.deepEqual(toChatMessages(result as never, 'main', undefined, { model: 'claude-opus-5-5' }), [], 'not repeated by the result')
  // A 403 result without the CLI's auth wording (no assistant error before it) still says so.
  const bare = toChatMessages({ type: 'result', subtype: 'success', is_error: true, api_error_status: 403, result: 'Forbidden' } as never, 'main', undefined, { model: 'gpt-x' })
  assert.deepEqual(bare.map((m) => m.text), ["Your account can't use gpt-x. Pick another model in the model menu."])
  // Real auth failures: the sign-in help.
  for (const [text, status] of [[EXPIRED_TEXT, 401], [REVOKED_TEXT, 403]] as const) {
    const [a] = failure(text, status)
    assert.deepEqual(toChatMessages(a as never, 'main', undefined, { model: 'claude-opus-5-5' }).map((m) => m.text), [AUTH_HELP], text)
  }
  assert.deepEqual(toChatMessages({ type: 'assistant', error: 'authentication_failed', parent_tool_use_id: null, message: { content: [] } } as never, 'main').map((m) => m.text), [AUTH_HELP])
  // Helpers.
  assert.equal(modelRejectedHelp(), "Your account can't use this model. Pick another model in the model menu.")
  assert.equal(authHelpFor(`Claude Code returned an error result: ${REJECT_TEXT}`, 'claude-opus-5-5'), OPUS_HELP)
  assert.equal(authHelpFor(`Claude Code returned an error result: ${EXPIRED_TEXT}`, 'claude-opus-5-5'), AUTH_HELP)
  assert.equal(authHelpFor('Overloaded', 'claude-opus-5-5'), null)
  assert.ok(isAuthHelp(OPUS_HELP) && isAuthHelp(AUTH_HELP) && !isAuthHelp('Error: x'))
})

// The SDK as the CLI behaves: the failure's messages, then a throw ("returned an error result").
function failingSdk(text: string, status: number): QueryFn {
  return () =>
    (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's' } as never
      for (const m of failure(text, status)) yield m as never
      throw new Error(`Claude Code returned an error result: ${text}`)
    })()
}

async function idle(chats: ChatManager, id: string): Promise<void> {
  const end = Date.now() + 5000
  while (chats.busy(id)) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

function chatSetup(queryFn: QueryFn) {
  const fake = fakeContext()
  fake.settings.set('anthropicUseClaudeLogin', true)
  const creds = new Credentials(fake.ctx, async () => null, { HOME: '/nonexistent' })
  creds.setLoginProbe(() => true)
  const providers = new Providers(fake.ctx, creds)
  return new ChatManager(fake.ctx, { credentials: creds, providers, toolFs: fake.fs, queryFn })
}

test('chat: a turn on a model the account cannot use says so once, without the sign-in help', async () => {
  const chats = chatSetup(failingSdk(REJECT_TEXT, 403))
  const chat = chats.create({ provider: 'anthropic', model: 'claude-opus-5-5' })
  await chats.send(chat.id, 'hello')
  await idle(chats, chat.id)
  const system = chats.messages(chat.id)!.filter((m) => m.role === 'system').map((m) => m.text)
  assert.deepEqual(system.filter(isAuthHelp), [OPUS_HELP])
  assert.ok(!system.includes(AUTH_HELP))
  assert.ok(!system.some((t) => /^Error: /.test(t)), system.join(' | '))
  // A real auth failure keeps the sign-in help.
  const chats2 = chatSetup(failingSdk(EXPIRED_TEXT, 401))
  const c2 = chats2.create({ provider: 'anthropic', model: 'claude-opus-5-5' })
  await chats2.send(c2.id, 'hello')
  await idle(chats2, c2.id)
  const sys2 = chats2.messages(c2.id)!.filter((m) => m.role === 'system').map((m) => m.text)
  assert.deepEqual(sys2.filter(isAuthHelp), [AUTH_HELP])
})

test('group chat: an SDK guest on a model the account cannot use says so; an expired sign-in keeps the help', async () => {
  for (const [text, status, expected] of [[REJECT_TEXT, 403, OPUS_HELP], [EXPIRED_TEXT, 401, AUTH_HELP]] as const) {
    const fake = fakeContext()
    const creds = new Credentials(fake.ctx, async () => null, {})
    await creds.setKey('anthropic', 'key-anthropic')
    await creds.setKey('openai', 'key-openai')
    const providers = new Providers(fake.ctx, creds, (async () => new Response('{}')) as never)
    const chats = new ChatManager(fake.ctx, { credentials: creds, providers, toolFs: fake.fs, queryFn: failingSdk(text, status) })
    const chat = chats.create({ provider: 'openai', model: 'gpt-6.1-sol' })
    chats.addGuest(chat.id, { provider: 'anthropic', model: 'claude-opus-5-5' })
    await chats.send(chat.id, '@opus how should saving work?')
    await idle(chats, chat.id)
    const system = chats.messages(chat.id)!.filter((m) => m.role === 'system').map((m) => m.text)
    assert.deepEqual(system.filter(isAuthHelp), [expected], system.join(' | '))
  }
})
