// Settings > Accounts: Claude CLI status/login logic, auth health from SDK queries, card
// summaries, the sign-in service and key tests. A fake `claude` (sh script) stands in for the CLI;
// those tests are skipped on Windows like test/syncGate.test.ts does for its sh fakes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeContext } from './agentFake.ts'
import { Credentials } from '../src/main/agent/credentials.ts'
import { Providers } from '../src/main/agent/providers.ts'
import { planSpawn } from '../src/main/services/tools.ts'
import { runCli, extractUrl, stripAnsi } from '../src/main/accounts/cli.ts'
import {
  ClaudeAccount,
  claudeCliEnv,
  claudeSignInStatus,
  CLAUDE_LOGIN_ARGS,
  CLAUDE_STATUS_ARGS,
  CLAUDE_TEST_ARGS,
  findClaudeCli,
  parseAuthStatus,
  parseTestResult,
  type ClaudeStateInput
} from '../src/main/accounts/claude.ts'
import { AuthHealth, authSignal, isAnthropicAuthError, watchAnthropicAuth } from '../src/main/accounts/authHealth.ts'
import { AccountRegistry, CODEX_PLACEHOLDER, type AccountProvider } from '../src/main/accounts/registry.ts'
import { AccountsService, keyCheckMessage, summarize } from '../src/main/accounts/service.ts'
import { claudeAccount } from '../src/main/accounts/ipc.ts'
import type { ProviderInfo } from '../src/shared/types.ts'
import type { SignInProgress } from '../src/shared/accountTypes.ts'

const shOnly = { skip: process.platform === 'win32' ? 'fake claude is a sh script' : false }
const plainSafe = async () => null

// ---- CLI location, env, command building ----

test('the Claude CLI is the bundled one, then the SDK package, then PATH', () => {
  assert.deepEqual(findClaudeCli({ bundled: () => '/r/claude', sdkPackage: () => '/n/claude', onPath: () => '/usr/bin/claude' }), { path: '/r/claude', source: 'bundled' })
  assert.deepEqual(findClaudeCli({ bundled: () => undefined, sdkPackage: () => '/n/claude', onPath: () => '/usr/bin/claude' }), { path: '/n/claude', source: 'sdk' })
  assert.deepEqual(findClaudeCli({ bundled: () => undefined, sdkPackage: () => undefined, onPath: () => 'C:\\Users\\A B\\npm\\claude.cmd' }), { path: 'C:\\Users\\A B\\npm\\claude.cmd', source: 'path' })
  assert.equal(findClaudeCli({ bundled: () => undefined, sdkPackage: () => undefined, onPath: () => null }), null)
})

test('auth commands: login with the subscription, status as JSON, a tool-less test turn', () => {
  assert.deepEqual(CLAUDE_LOGIN_ARGS, ['auth', 'login', '--claudeai'])
  assert.deepEqual(CLAUDE_STATUS_ARGS, ['auth', 'status', '--json'])
  assert.equal(CLAUDE_TEST_ARGS[0], '-p')
  assert.ok(CLAUDE_TEST_ARGS.includes('--no-session-persistence'))
  assert.equal(CLAUDE_TEST_ARGS[CLAUDE_TEST_ARGS.indexOf('--tools') + 1], '')
})

test('a Windows npm shim with spaces in its path runs through cmd.exe with quoted arguments', () => {
  const plan = planSpawn('C:\\Users\\Jo Smith\\AppData\\Roaming\\npm\\claude.cmd', CLAUDE_LOGIN_ARGS, 'win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' })
  assert.equal(plan.file, 'C:\\Windows\\system32\\cmd.exe')
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.equal(plan.args[3], '"^"C:\\Users\\Jo^ Smith\\AppData\\Roaming\\npm\\claude.cmd^" ^"auth^" ^"login^" ^"--claudeai^""')
  assert.equal(plan.windowsVerbatimArguments, true)
  // The bundled claude.exe is spawned directly.
  assert.deepEqual(planSpawn('C:\\Program Files\\RBX Forge\\claude.exe', ['auth', 'status'], 'win32'), { file: 'C:\\Program Files\\RBX Forge\\claude.exe', args: ['auth', 'status'] })
})

test('the CLI env drops an API key (status would report it) and the nested-session marker', () => {
  const env = claudeCliEnv({ ANTHROPIC_API_KEY: 'sk-ant', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/c', HTTPS_PROXY: 'http://p' })
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.CLAUDECODE, undefined)
  assert.equal(env.CLAUDE_CONFIG_DIR, '/c')
  assert.equal(env.HTTPS_PROXY, 'http://p')
})

// ---- auth status parsing and the card state ----

test('auth status JSON is parsed; exit code 1 means not logged in', () => {
  const out = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'a@b.c', subscriptionType: 'max', configDirectory: '/x' }, null, 2)
  assert.deepEqual(parseAuthStatus(out, 0), { loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c', subscriptionType: 'max' })
  assert.equal(parseAuthStatus(out, 1)?.loggedIn, false)
  assert.deepEqual(parseAuthStatus('{"loggedIn":false,"authMethod":"none"}', 1), { loggedIn: false, authMethod: 'none' })
  assert.equal(parseAuthStatus('Not logged in', 1), null)
  assert.equal(parseAuthStatus('{broken', 0), null)
})

const base: ClaudeStateInput = { useLogin: false, envToken: false, credentialsFile: false, cli: undefined, failed: false, platform: 'linux' }
const cliIn = { loggedIn: true, authMethod: 'claude.ai', email: 'me@x.com', subscriptionType: 'max' }

test('Claude sign-in state from the setting, the CLI answer, the env token and the credentials file', () => {
  assert.equal(claudeSignInStatus({ ...base, cli: { loggedIn: false, authMethod: 'none' } }).state, 'signedOut')
  const on = claudeSignInStatus({ ...base, useLogin: true, cli: cliIn })
  assert.equal(on.state, 'signedIn')
  assert.equal(on.account, 'me@x.com · Max')
  const off = claudeSignInStatus({ ...base, cli: cliIn })
  assert.equal(off.state, 'signedOut')
  assert.equal(off.foundButOff, true)
  // A request failed: expired, even though a login "exists".
  assert.equal(claudeSignInStatus({ ...base, useLogin: true, cli: cliIn, failed: true }).state, 'expired')
  // The CLI's answer beats the file: a stale credentials file with "not logged in" is not a login.
  assert.equal(claudeSignInStatus({ ...base, useLogin: true, credentialsFile: true, cli: { loggedIn: false, authMethod: 'none' } }).state, 'signedOut')
  // Without a CLI answer the file counts (Linux/Windows).
  assert.equal(claudeSignInStatus({ ...base, useLogin: true, credentialsFile: true, cli: 'error' }).state, 'signedIn')
  assert.equal(claudeSignInStatus({ ...base, useLogin: true, envToken: true }).state, 'signedIn')
  // macOS Keychain, CLI did not answer: unknown, test it.
  const mac = claudeSignInStatus({ ...base, useLogin: true, cli: 'error', platform: 'darwin' })
  assert.equal(mac.state, 'unknown')
  assert.match(mac.detail ?? '', /Test connection/)
  // No CLI at all.
  const missing = claudeSignInStatus({ ...base, cli: 'missing' })
  assert.equal(missing.state, 'unavailable')
  assert.equal(missing.needs, 'Claude Code')
  // Claude Code set up with a Console key, not a subscription.
  const keyed = claudeSignInStatus({ ...base, cli: { loggedIn: true, authMethod: 'api_key' } })
  assert.equal(keyed.state, 'signedOut')
  assert.match(keyed.detail ?? '', /api key/)
})

test('test turn results: ok, an auth failure, another failure, a timeout', () => {
  const r = (o: Partial<{ code: number; stdout: string; stderr: string; timedOut: boolean }>) => ({ code: 0, stdout: '', stderr: '', timedOut: false, cancelled: false, ...o })
  assert.deepEqual(parseTestResult(r({ stdout: '{"type":"result","is_error":false,"result":"OK"}' })), { ok: true, message: 'Connected', auth: false })
  const bad = parseTestResult(r({ code: 1, stdout: '{"is_error":true,"api_error_status":401,"result":"Failed to authenticate. OAuth session expired and could not be refreshed"}' }))
  assert.equal(bad.ok, false)
  assert.equal(bad.auth, true)
  const other = parseTestResult(r({ code: 1, stdout: '{"is_error":true,"api_error_status":529,"result":"Overloaded"}' }))
  assert.equal(other.auth, false)
  assert.match(other.message, /Overloaded/)
  assert.match(parseTestResult(r({ code: null as never, timedOut: true })).message, /timed out/)
})

// ---- auth health from real queries ----

test('auth errors are recognised in CLI and API wording', () => {
  assert.ok(isAnthropicAuthError('Failed to authenticate: OAuth session expired and could not be refreshed'))
  assert.ok(isAnthropicAuthError('Invalid API key · Fix external API key'))
  assert.ok(isAnthropicAuthError('Not logged in · Please run /login'))
  assert.ok(!isAnthropicAuthError('Overloaded'))
  assert.ok(!isAnthropicAuthError(undefined))
})

test('SDK messages: auth failures mark the credential, a successful turn clears it', async () => {
  assert.deepEqual(authSignal({ type: 'assistant', error: 'authentication_failed' } as never), { ok: false, message: 'authentication_failed' })
  assert.equal(authSignal({ type: 'assistant', error: 'rate_limit' } as never), null)
  assert.equal(authSignal({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: 'Invalid bearer token' } as never)?.ok, false)
  assert.equal(authSignal({ type: 'result', subtype: 'success', is_error: true, api_error_status: 529, result: 'Overloaded' } as never), null)
  assert.deepEqual(authSignal({ type: 'result', subtype: 'success', is_error: false, result: 'hi' } as never), { ok: true })

  const fake = fakeContext()
  const health = new AuthHealth(fake.ctx)
  let changes = 0
  health.onChange(() => changes++)
  const replies: unknown[][] = [
    [{ type: 'assistant', error: 'authentication_failed' }, { type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: 'Failed to authenticate. OAuth session expired and could not be refreshed' }],
    [{ type: 'result', subtype: 'success', is_error: false, result: 'ok' }]
  ]
  let call = 0
  const inner = () => (async function* () {
    for (const m of replies[call++]) yield m as never
  })()
  const q = watchAnthropicAuth(inner, health)
  const seen: unknown[] = []
  for await (const m of q({ prompt: 'x', options: { env: {} } })) seen.push(m)
  assert.equal(seen.length, 2, 'messages pass through')
  assert.equal(health.failed('claudeLogin'), true)
  assert.equal(health.failed('key'), false)
  assert.match(health.get()?.message ?? '', /OAuth session expired/)
  for await (const _ of q({ prompt: 'x', options: { env: {} } })) void _
  assert.equal(health.failed('claudeLogin'), false)
  assert.equal(changes, 2, 'only state changes notify')

  // A thrown auth error on a key query.
  const throwing = () => (async function* () {
    throw new Error('Invalid API key')
  })()
  await assert.rejects(async () => {
    for await (const _ of watchAnthropicAuth(throwing, health)({ prompt: 'x', options: { env: { ANTHROPIC_API_KEY: 'k' } } })) void _
  }, /Invalid API key/)
  assert.equal(health.failed('key'), true)
})

test('Credentials: the CLI answer decides "login found"; a failed login is not ready in Providers', async () => {
  const fake = fakeContext()
  const creds = new Credentials(fake.ctx, plainSafe, { CLAUDE_CONFIG_DIR: '/nonexistent' })
  creds.setUseClaudeLogin(true)
  creds.setLoginProbe(() => false)
  const none = await creds.anthropicAuth()
  assert.equal(none.ready, false)
  assert.match(none.error ?? '', /Sign in with Claude/)
  // With a key and no login, the key is used.
  await creds.setKey('anthropic', 'sk-ant-xyz1234')
  assert.equal((await creds.anthropicAuth()).source, 'key')
  // Login found: it comes first, and the key is kept out of the subprocess env.
  creds.setLoginProbe(() => true)
  const login = await creds.anthropicAuth()
  assert.equal(login.source, 'claudeLogin')
  assert.equal(login.env?.ANTHROPIC_API_KEY, undefined)
  // A failed request: still runnable (a retry may work) but reported not ready.
  creds.health.record('claudeLogin', false, 'OAuth session expired')
  const failed = await creds.anthropicAuth()
  assert.equal(failed.ready, true)
  assert.equal(failed.failed, true)
  const providers = new Providers(fake.ctx, creds, (async () => new Response('{}')) as never)
  const info = await providers.info('anthropic')
  assert.equal(info.ready, false)
  assert.equal(info.detail, 'Claude sign-in expired')
  creds.health.record('claudeLogin', true)
  assert.equal((await providers.info('anthropic')).ready, true)
})

// ---- card summaries ----

const info = (o: Partial<ProviderInfo>): ProviderInfo => ({ id: 'anthropic', label: 'Anthropic', ready: false, needsKey: true, models: [], ...o })

test('card headline: subscription, API key, expired, cloud, local, not set up', () => {
  const signedIn = { method: 'claude', label: 'Sign in with Claude', state: 'signedIn' as const }
  assert.equal(summarize({ id: 'claude', info: info({ ready: true }), signIn: signedIn }).statusText, 'Signed in with Claude subscription')
  const keyed = summarize({ id: 'claude', info: info({ ready: true, keySource: 'stored', keyHint: '…1234' }), signIn: { ...signedIn, state: 'signedOut' }, authSource: 'key' })
  assert.equal(keyed.state, 'apiKey')
  assert.equal(keyed.statusText, 'Using API key …1234')
  assert.equal(keyed.keyUrl, 'https://platform.claude.com/settings/keys')
  assert.equal(summarize({ id: 'claude', info: info({}), signIn: { ...signedIn, state: 'expired' } }).statusText, 'Sign-in expired')
  assert.equal(summarize({ id: 'claude', info: info({ keySource: 'stored' }), authSource: 'key', authFailed: true }).statusText, 'API key was rejected')
  assert.equal(summarize({ id: 'claude', info: info({ ready: true }), authSource: 'cloud' }).state, 'cloud')
  const env = summarize({ id: 'openai', info: info({ id: 'openai', ready: true, keySource: 'env', keyHint: '…9999' }), signIn: CODEX_STATUS })
  assert.equal(env.statusText, 'Using API key from OPENAI_API_KEY')
  assert.equal(env.signIn?.state, 'unavailable')
  assert.equal(summarize({ id: 'ollama', info: info({ id: 'ollama', ready: true, baseUrl: 'http://localhost:11434/v1' }) }).statusText, 'Running at http://localhost:11434/v1')
  assert.equal(summarize({ id: 'ollama', info: info({ id: 'ollama' }) }).statusText, 'Not running')
  assert.equal(summarize({ id: 'gemini', info: info({ id: 'gemini' }) }).state, 'none')
  // Codex signed in (when its service plugs in).
  assert.equal(summarize({ id: 'openai', info: info({ id: 'openai', ready: true }), signIn: { method: 'codex', label: 'Sign in with ChatGPT (Codex)', state: 'signedIn' } }).statusText, 'Signed in with ChatGPT (Codex)')
})
const CODEX_STATUS = { method: 'codex', label: 'Sign in with ChatGPT (Codex)', state: 'unavailable' as const, needs: 'Codex CLI' }

test('key check HTTP statuses', () => {
  assert.deepEqual(keyCheckMessage(200), { ok: true, message: 'Connected' })
  assert.equal(keyCheckMessage(401).ok, false)
  assert.match(keyCheckMessage(403).message, /rejected/)
  assert.equal(keyCheckMessage(429).ok, true)
  assert.equal(keyCheckMessage(500).ok, false)
})

// ---- the service ----

function service(o: { registry?: AccountRegistry; fetchFn?: typeof fetch; signInTimeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  const fake = fakeContext()
  const creds = new Credentials(fake.ctx, plainSafe, { CLAUDE_CONFIG_DIR: '/nonexistent', ...(o.env ?? {}) })
  const fetchFn = o.fetchFn ?? ((async () => new Response('{}', { status: 500 })) as never)
  const providers = new Providers(fake.ctx, creds, fetchFn)
  const events: { event: string; payload: any }[] = []
  const registry = o.registry ?? new AccountRegistry()
  const svc = new AccountsService({ credentials: creds, providers, registry, emit: (event, payload) => void events.push({ event, payload }), providersChanged: async () => undefined, fetchFn, signInTimeoutMs: o.signInTimeoutMs })
  return { svc, creds, events, fake, registry }
}

function fakeMethod(behaviour: (ctl: Parameters<AccountProvider['signIn']>[0]) => Promise<{ ok: boolean; message?: string }>): AccountProvider & { signedIn: boolean } {
  const m = {
    method: 'claude',
    account: 'claude' as const,
    label: 'Sign in with Claude',
    signedIn: false,
    status: async () => ({ method: 'claude', label: 'Sign in with Claude', state: m.signedIn ? ('signedIn' as const) : ('signedOut' as const) }),
    signIn: async (ctl: Parameters<AccountProvider['signIn']>[0]) => {
      const r = await behaviour(ctl)
      if (r.ok) m.signedIn = true
      return r
    },
    signOut: async () => {
      m.signedIn = false
    }
  }
  return m
}

test('sign-in: progress events, a pasted code reaches the method, success refreshes the cards', async () => {
  const registry = new AccountRegistry()
  let got = ''
  const m = fakeMethod(async (ctl) => {
    ctl.onCode((c) => (got = c))
    ctl.progress({ url: 'https://claude.com/x', acceptsCode: true })
    await new Promise((r) => setTimeout(r, 20))
    return { ok: true }
  })
  registry.register(m)
  const { svc, events } = service({ registry })
  const p = svc.signIn('claude')
  assert.equal(svc.signIn('claude'), p, 'a second click joins the running sign-in')
  await new Promise((r) => setTimeout(r, 5))
  svc.submitCode('claude', 'abc#123')
  const done = await p
  assert.equal(got, 'abc#123')
  assert.equal(done.phase, 'done')
  const phases = events.filter((e) => e.event === 'accounts:signin').map((e) => (e.payload as SignInProgress).phase)
  assert.deepEqual(phases, ['starting', 'waiting', 'done'])
  assert.ok(events.some((e) => e.event === 'accounts:signin' && e.payload.url === 'https://claude.com/x'))
  const list = events.filter((e) => e.event === 'accounts:changed').pop()?.payload
  assert.equal(list.find((a: any) => a.id === 'claude').state, 'subscription')
  assert.throws(() => svc.submitCode('claude', 'x'), /No sign-in/)
})

test('sign-in can be cancelled and times out', async () => {
  const registry = new AccountRegistry()
  registry.register(
    fakeMethod(
      (ctl) =>
        new Promise((resolve) => {
          ctl.signal.addEventListener('abort', () => resolve({ ok: false }))
        })
    )
  )
  const { svc } = service({ registry, signInTimeoutMs: 60 })
  const timed = await svc.signIn('claude')
  assert.equal(timed.phase, 'timeout')
  const { svc: svc2 } = service({ registry })
  const p = svc2.signIn('claude')
  svc2.cancelSignIn('claude')
  assert.equal((await p).phase, 'cancelled')
})

test('the OpenAI card shows the Codex placeholder until the Codex service registers', async () => {
  const registry = new AccountRegistry()
  registry.register(CODEX_PLACEHOLDER)
  const { svc } = service({ registry })
  const openai = await svc.summary('openai')
  assert.equal(openai.signIn?.state, 'unavailable')
  assert.equal(openai.signIn?.needs, 'Codex CLI')
  assert.equal((await svc.signIn('openai')).phase, 'failed')
  // The Codex service plugs in: same method id replaces the placeholder.
  registry.register({ ...CODEX_PLACEHOLDER, status: async () => ({ method: 'codex', label: 'Sign in with ChatGPT (Codex)', state: 'signedIn', account: 'me@x.com' }) })
  const after = await svc.summary('openai')
  assert.equal(after.state, 'subscription')
  assert.equal(after.signIn?.account, 'me@x.com')
})

test('key tests: Gemini /models, OpenRouter /key (models need no key), Anthropic records key health', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
    if (String(url).includes('generativelanguage')) return new Response('{"error":"API key not valid"}', { status: 400 })
    if (String(url).includes('openrouter')) return new Response('{"data":{}}', { status: 200 })
    if (String(url).includes('anthropic.com')) return new Response('{}', { status: 401 })
    return new Response('{}', { status: 500 })
  }) as unknown as typeof fetch
  const { svc, creds } = service({ fetchFn })
  assert.equal((await svc.test('gemini')).message, 'Not set up')
  await creds.setKey('gemini', 'AIza-bad')
  const g = await svc.test('gemini')
  assert.equal(g.ok, false)
  assert.match(g.message, /rejected/)
  await creds.setKey('openrouter', 'sk-or-1')
  assert.equal((await svc.test('openrouter')).ok, true)
  assert.ok(seen.some((s) => s.url === 'https://openrouter.ai/api/v1/key' && s.headers.Authorization === 'Bearer sk-or-1'))
  await creds.setKey('anthropic', 'sk-ant-bad')
  const a = await svc.test('claude')
  assert.equal(a.ok, false)
  assert.equal(creds.health.failed('key'), true)
  const card = await svc.summary('claude')
  assert.equal(card.statusText, 'API key was rejected')
  assert.equal(card.lastCheck?.ok, false)
  // Nothing about the key is in what the renderer gets.
  assert.ok(!JSON.stringify(await svc.list()).includes('sk-ant-bad'))
})

// ---- the fake Claude CLI ----

function fakeClaude(): { dir: string; bin: string; state: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'forge-claude-'))
  const dir = join(root, 'fake cli dir')
  mkdirSync(dir)
  const state = join(root, 'state')
  const bin = join(dir, 'claude')
  writeFileSync(
    bin,
    `#!/bin/sh
STATE="${state}"
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ -n "$ANTHROPIC_API_KEY" ]; then echo '{"loggedIn":true,"authMethod":"api_key"}'; exit 0; fi
  if [ -f "$STATE" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","email":"me@x.com","subscriptionType":"pro"}'; exit 0; fi
  echo '{"loggedIn":false,"authMethod":"none"}'; exit 1
fi
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  echo "Opening browser to sign in..."
  echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc"
  printf "Paste code here if prompted > "
  read CODE
  if [ "$CODE" = "good-code" ]; then touch "$STATE"; echo "Login successful."; exit 0; fi
  echo "Invalid code" >&2; exit 1
fi
if [ "$1" = "auth" ] && [ "$2" = "logout" ]; then rm -f "$STATE"; echo "Successfully logged out"; exit 0; fi
if [ "$1" = "-p" ]; then
  if [ -f "$STATE" ]; then echo '{"type":"result","subtype":"success","is_error":false,"result":"OK"}'; exit 0; fi
  echo '{"type":"result","subtype":"success","is_error":true,"api_error_status":401,"result":"Not logged in · Please run /login"}'; exit 1
fi
if [ "$1" = "sleep" ]; then sleep 30; exit 0; fi
exit 2
`
  )
  chmodSync(bin, 0o755)
  return { dir, bin, state, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('runCli: lines and prompts arrive, a timeout and a cancel stop the process', shOnly, async () => {
  const f = fakeClaude()
  try {
    const lines: string[] = []
    let write: ((t: string) => void) | null = null
    const r = await runCli(f.bin, ['auth', 'login'], {
      timeoutMs: 5000,
      onStdin: (w) => (write = w),
      onLine: (l) => {
        lines.push(l)
        if (/Paste code/.test(l)) write?.('nope\n')
      }
    })
    assert.equal(r.code, 1)
    assert.ok(lines.some((l) => extractUrl(l) === 'https://claude.com/cai/oauth/authorize?code=true&state=abc'))
    assert.ok(lines.some((l) => /Paste code here/.test(l)), 'a prompt without a newline is delivered')
    const t0 = Date.now()
    const timed = await runCli(f.bin, ['sleep'], { timeoutMs: 150 })
    assert.equal(timed.timedOut, true)
    assert.ok(Date.now() - t0 < 5000)
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    const cancelled = await runCli(f.bin, ['sleep'], { timeoutMs: 10_000, signal: ac.signal })
    assert.equal(cancelled.cancelled, true)
    const missing = await runCli(join(f.dir, 'nope'), [], { timeoutMs: 1000 })
    assert.ok(missing.error, 'a missing binary reports an error instead of throwing')
  } finally {
    f.cleanup()
  }
})

test('ClaudeAccount with a fake CLI: detect, sign in with a pasted code, test, sign out', shOnly, async () => {
  const f = fakeClaude()
  try {
    const fake = fakeContext()
    const env = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: join(f.dir, 'cfg'), ANTHROPIC_API_KEY: 'sk-env' }
    const creds = new Credentials(fake.ctx, plainSafe, env)
    const claude = claudeAccount(creds, env)
    // Point it at the fake (a path with spaces).
    ;(claude as any).deps.locate = { bundled: () => undefined, sdkPackage: () => undefined, onPath: () => f.bin }
    const before = await claude.status({ refresh: true })
    assert.equal(before.state, 'signedOut', 'the env API key is hidden from `auth status`')
    assert.equal(creds.claudeLoginFound(), false)

    const progress: { url?: string; acceptsCode?: boolean; message?: string }[] = []
    let send: ((c: string) => void) | null = null
    const ac = new AbortController()
    const p = claude.signIn({
      signal: ac.signal,
      progress: (u) => {
        progress.push(u)
        if (u.acceptsCode) setTimeout(() => send?.('good-code'), 10)
      },
      onCode: (h) => (send = h)
    })
    const r = await p
    assert.deepEqual(r, { ok: true })
    assert.ok(progress.some((u) => u.url?.startsWith('https://claude.com/')))
    assert.equal(creds.useClaudeLogin(), true, 'success turns the Claude login on')
    assert.equal(creds.claudeLoginFound(), true)
    const after = await claude.status()
    assert.equal(after.state, 'signedIn')
    assert.equal(after.account, 'me@x.com · Pro')
    assert.equal((await creds.anthropicAuth()).source, 'claudeLogin')

    const ok = await claude.test(new AbortController().signal)
    assert.equal(ok.ok, true)
    // Logged out behind Forge's back: the test reports it and marks the login expired.
    rmSync(f.state)
    const bad = await claude.test(new AbortController().signal)
    assert.equal(bad.ok, false)
    assert.equal(creds.health.failed('claudeLogin'), true)
    assert.equal((await claude.status()).state, 'expired')

    // Sign out without the CLI logout keeps the CLI login; with it, the CLI logs out.
    writeFileSync(f.state, '')
    creds.health.record('claudeLogin', true)
    await claude.signOut({ cliLogout: false })
    assert.equal(creds.useClaudeLogin(), false)
    assert.ok(existsSync(f.state))
    await claude.signOut({ cliLogout: true })
    assert.ok(!existsSync(f.state))
    assert.equal((await claude.status()).state, 'signedOut')
  } finally {
    f.cleanup()
  }
})

test('ClaudeAccount: a wrong code fails, a missing CLI is reported', shOnly, async () => {
  const f = fakeClaude()
  try {
    const fake = fakeContext()
    const env = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: join(f.dir, 'cfg') }
    const creds = new Credentials(fake.ctx, plainSafe, env)
    const claude = claudeAccount(creds, env)
    ;(claude as any).deps.locate = { bundled: () => undefined, sdkPackage: () => undefined, onPath: () => f.bin }
    let send: ((c: string) => void) | null = null
    const r = await claude.signIn({ signal: new AbortController().signal, progress: (u) => u.acceptsCode && setTimeout(() => send?.('bad'), 10), onCode: (h) => (send = h) })
    assert.equal(r.ok, false)
    assert.match(r.message ?? '', /Invalid code/)
    assert.equal(creds.useClaudeLogin(), false)
    ;(claude as any).deps.locate = { bundled: () => undefined, sdkPackage: () => undefined, onPath: () => null }
    assert.equal((await claude.status({ refresh: true })).state, 'unavailable')
    assert.equal((await claude.signIn({ signal: new AbortController().signal, progress: () => undefined, onCode: () => undefined })).ok, false)
  } finally {
    f.cleanup()
  }
})

test('stripAnsi removes colour codes', () => {
  assert.equal(stripAnsi('\x1b[32mLogin successful\x1b[0m'), 'Login successful')
})
