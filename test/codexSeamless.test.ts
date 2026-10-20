// One-click "Sign in with ChatGPT": Forge's private Codex CLI install (npm --prefix), detection of
// that copy, `codex login --device-auth` output parsing, the browser fallback, the CLI's model list,
// and Codex becoming the default when no OpenAI API key works. Real-process tests use fake `codex`
// and `npm` sh scripts (skipped on Windows).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { DeviceAuthParser, deviceAuthUnsupported, findCodex, parseModelCatalog } from '../src/main/agent/codex/binary.ts'
import {
  CODEX_NPM_VERSION,
  findPrivateCodex,
  installArgs,
  installEnv,
  installError,
  installPlan,
  installProgressLine,
  privateCodexCandidates,
  privateCodexPrefix
} from '../src/main/agent/codex/install.ts'
import { CodexService, type SignInUpdate } from '../src/main/agent/codex/service.ts'
import { applyCodexDefaults } from '../src/main/accounts/codexDefaults.ts'
import { codexSignInStatus } from '../src/main/accounts/codex.ts'
import { AccountRegistry } from '../src/main/accounts/registry.ts'
import { AccountsService } from '../src/main/accounts/service.ts'
import { Providers } from '../src/main/agent/providers.ts'
import { Credentials } from '../src/main/agent/credentials.ts'
import { fakeContext } from './agentFake.ts'
import type { ToolContext } from '../src/main/services/tools.ts'
import type { ModelChoice } from '../src/shared/types.ts'
import type { ImageBackend } from '../src/shared/artTypes.ts'
import type { SignInProgress } from '../src/shared/accountTypes.ts'

const shOnly = { skip: process.platform === 'win32' ? 'fake codex/npm are sh scripts' : false }

function toolCtx(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string, exists: string[]): ToolContext {
  const set = new Set(exists)
  return { platform, env, home, isExecutable: (f) => set.has(f), listDir: () => [] }
}

// What codex-rs/login/src/device_code_auth.rs prints (with its ANSI colours).
const G = '\x1b[90m'
const B = '\x1b[94m'
const R = '\x1b[0m'
const DEVICE_PROMPT = `\nWelcome to Codex [v${G}0.162.1${R}]\n${G}OpenAI's command-line coding agent${R}\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   ${B}https://auth.openai.com/codex/device${R}\n\n2. Enter this one-time code ${G}(expires in 15 minutes)${R}\n   ${B}ABCD-12345${R}\n\n${G}Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.${R}\n`

// ---------------------------------------------------------------- parsing

test('DeviceAuthParser reads the URL and one-time code from the real prompt (ANSI, CRLF)', () => {
  for (const text of [DEVICE_PROMPT, DEVICE_PROMPT.replace(/\n/g, '\r\n')]) {
    const p = new DeviceAuthParser()
    for (const line of text.split(/\r?\n/)) p.line(line)
    assert.equal(p.url, 'https://auth.openai.com/codex/device')
    assert.equal(p.code, 'ABCD-12345')
  }
  // The version number and the expiry note are not mistaken for the code.
  const p = new DeviceAuthParser()
  p.line('Welcome to Codex [v0.162.1]')
  p.line('2. Enter this one-time code (expires in 15 minutes)')
  assert.equal(p.code, null)
  p.line('   WXYZ-9876')
  assert.equal(p.code, 'WXYZ-9876')
  // A code on the same line also works.
  const inline = new DeviceAuthParser()
  inline.line('Enter the code: qrst-5678')
  assert.equal(inline.code, 'QRST-5678')
})

test('deviceAuthUnsupported: old CLI without the flag, or device codes turned off', () => {
  assert.equal(deviceAuthUnsupported("error: unexpected argument '--device-auth' found\n\nUsage: codex login [OPTIONS]"), true)
  assert.equal(deviceAuthUnsupported('Error logging in with device code: device code login is not enabled for this Codex server. Use the browser login'), true)
  assert.equal(deviceAuthUnsupported('Error logging in with device code: error sending request for url (https://auth.openai.com/api/accounts/deviceauth/usercode)'), false)
})

test('parseModelCatalog: listed models by priority, hidden ones dropped, noise around the JSON ignored', () => {
  const json = JSON.stringify({
    models: [
      { slug: 'gpt-6-astra', visibility: 'list', priority: 2 },
      { slug: 'gpt-6.1-sol', visibility: 'list', priority: 1 },
      { slug: 'codex-auto-review', visibility: 'hide', priority: 43 },
      { slug: 'gpt-5.5', visibility: 'list', priority: 13 },
      { slug: 'bad slug; rm -rf', visibility: 'list', priority: 0 },
      { nope: true }
    ]
  })
  assert.deepEqual(parseModelCatalog(`WARNING: something\n${json}\n`), ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.5'])
  assert.deepEqual(parseModelCatalog('not json'), [])
  assert.deepEqual(parseModelCatalog('{"models": 3}'), [])
})

// ---------------------------------------------------------------- install command and detection

test('install: pinned version into <userData>/tools/codex; npm.cmd goes through cmd.exe on Windows', () => {
  assert.match(CODEX_NPM_VERSION, /^\d+\.\d+\.\d+$/)
  const winUser = 'C:\\Users\\Acid Smith\\AppData\\Roaming\\RBX Forge'
  const winPrefix = privateCodexPrefix(winUser, 'win32')
  assert.equal(winPrefix, 'C:\\Users\\Acid Smith\\AppData\\Roaming\\RBX Forge\\tools\\codex')
  assert.equal(privateCodexPrefix('/Users/acid/Library/Application Support/RBX Forge', 'darwin'), '/Users/acid/Library/Application Support/RBX Forge/tools/codex')

  const args = installArgs('/u/tools/codex')
  assert.deepEqual(args.slice(0, 3), ['install', '--prefix', '/u/tools/codex'])
  assert.equal(args.at(-1), `@openai/codex@${CODEX_NPM_VERSION}`)
  assert.ok(!args.includes('-g') && !args.includes('--global'), 'never a global install')

  const posix = installPlan('/usr/local/bin/npm', '/u/tools/codex', 'darwin', {})
  assert.equal(posix.file, '/usr/local/bin/npm')
  assert.equal(posix.windowsVerbatimArguments, undefined)

  const npmCmd = 'C:\\Program Files\\nodejs\\npm.cmd'
  const win = installPlan(npmCmd, winPrefix, 'win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' })
  assert.equal(win.file, 'C:\\Windows\\system32\\cmd.exe')
  assert.deepEqual(win.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.equal(win.windowsVerbatimArguments, true)
  const line = win.args[3]
  // Paths with spaces stay one (quoted, caret-escaped) argument each.
  assert.ok(line.startsWith('"^"C:\\Program^ Files\\nodejs\\npm.cmd^" ^"install^" ^"--prefix^" '), line)
  assert.ok(line.includes(' ^"C:\\Users\\Acid^ Smith\\AppData\\Roaming\\RBX^ Forge\\tools\\codex^" '), line)
  assert.ok(line.endsWith(` ^"@openai/codex@${CODEX_NPM_VERSION}^""`), line)

  // Environment that would make it global is dropped.
  const env = installEnv({ PATH: '/bin', npm_config_global: 'true', NPM_CONFIG_PREFIX: '/x', npm_config_location: 'global', npm_config_registry: 'https://r.example' })
  assert.equal(env.npm_config_global, undefined)
  assert.equal(env.NPM_CONFIG_PREFIX, undefined)
  assert.equal(env.npm_config_location, undefined)
  assert.equal(env.npm_config_registry, 'https://r.example', 'a custom registry is kept')
})

test('install progress and error lines', () => {
  assert.equal(installProgressLine('npm http fetch GET 200 https://registry.npmjs.org/@openai/codex/-/codex-0.162.1-win32-x64.tgz 900ms'), 'Downloading the Codex CLI...')
  assert.equal(installProgressLine('npm http cache https://registry.npmjs.org/@openai%2fcodex 103ms (cache hit)'), 'Looking up the Codex CLI on npm...')
  assert.equal(installProgressLine('added 2 packages in 13s'), 'Installed. Checking it runs...')
  assert.equal(installProgressLine('npm warn something'), null)
  assert.match(installError(1, 'npm error code ENOTFOUND\nnpm error network request failed'), /could not reach the npm registry/)
  assert.match(installError(1, 'npm ERR! code EACCES\nnpm ERR! syscall mkdir'), /could not write/)
  assert.equal(installError(7, 'nothing useful'), 'npm install exited with code 7')
})

test('findCodex: the private copy is found (codex.cmd on Windows) after the user\'s own installs', () => {
  const home = '/Users/acid'
  const prefix = '/Users/acid/Library/Application Support/RBX Forge/tools/codex'
  const priv = `${prefix}/node_modules/.bin/codex`
  assert.deepEqual(privateCodexCandidates(prefix, 'darwin'), [priv])
  assert.equal(findCodex(toolCtx('darwin', { PATH: '/usr/bin' }, home, [priv]), null, prefix), priv)
  assert.equal(findCodex(toolCtx('darwin', { PATH: '/usr/bin' }, home, [priv]), null, null), null, 'no prefix, no private lookup')
  // The user's own codex wins over Forge's copy; an override wins over both.
  assert.equal(findCodex(toolCtx('darwin', { PATH: '/usr/bin' }, home, [priv, '/opt/homebrew/bin/codex']), null, prefix), '/opt/homebrew/bin/codex')
  assert.equal(findCodex(toolCtx('darwin', { PATH: '/usr/bin' }, home, [priv, '/x/codex']), '/x/codex', prefix), '/x/codex')

  const wprefix = 'C:\\Users\\Acid\\AppData\\Roaming\\RBX Forge\\tools\\codex'
  const wcmd = path.win32.join(wprefix, 'node_modules', '.bin', 'codex.cmd')
  const wbare = path.win32.join(wprefix, 'node_modules', '.bin', 'codex')
  const env = { APPDATA: 'C:\\Users\\Acid\\AppData\\Roaming', Path: 'C:\\Windows\\System32', PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  assert.equal(findCodex(toolCtx('win32', env, 'C:\\Users\\Acid', [wcmd, wbare]), null, wprefix), wcmd)
  assert.equal(findPrivateCodex(wprefix, toolCtx('win32', env, 'C:\\Users\\Acid', [wbare])), null, 'the sh shim is never picked on Windows')
})

// ---------------------------------------------------------------- status and the card

test('status: missing CLI with npm -> installable (button enabled); without npm -> unavailable with docs', async () => {
  const withNpm = new CodexService({ findBin: () => null, privatePrefix: () => '/u/tools/codex', findNpm: () => '/usr/bin/npm' })
  const s = await withNpm.status()
  assert.equal(s.installed, false)
  assert.equal(s.canInstall, true)
  const card = codexSignInStatus(s)
  assert.equal(card.state, 'signedOut')
  assert.match(card.detail ?? '', /installs the Codex CLI/)
  assert.match((await withNpm.notReady()) ?? '', /Sign in with ChatGPT/)

  const noNpm = new CodexService({ findBin: () => null, privatePrefix: () => '/u/tools/codex', findNpm: () => null })
  const s2 = await noNpm.status()
  assert.equal(s2.canInstall, undefined)
  assert.match(s2.detail, /npm/)
  const card2 = codexSignInStatus(s2)
  assert.equal(card2.state, 'unavailable')
  assert.ok(card2.needsUrl?.startsWith('https://'))
  const r = await noNpm.signIn({ signal: new AbortController().signal })
  assert.equal(r.ok, false)
  assert.match(r.message ?? '', /needs npm/)
  assert.ok(r.helpUrl?.startsWith('https://'))
  assert.equal(noNpm.signingInNow(), false)
})

test('the card says "Signed in with ChatGPT" with the plan, version and who installed it', () => {
  const st = codexSignInStatus({ installed: true, loggedIn: true, method: 'chatgpt', version: '0.162.1', privateInstall: true, detail: 'Signed in with ChatGPT', checkedAt: 1 })
  assert.equal(st.state, 'signedIn')
  assert.equal(st.account, 'ChatGPT plan · codex 0.162.1 (installed by Forge)')
})

test('AccountsService: a new stage drops the old link/code; a failure carries its help link', async () => {
  const fake = fakeContext()
  const creds = new Credentials(fake.ctx)
  const providers = new Providers(fake.ctx, creds, (async () => new Response('{}')) as never)
  const registry = new AccountRegistry()
  const events: SignInProgress[] = []
  let fail = false
  registry.register({
    method: 'codex',
    account: 'openai',
    label: 'Sign in with ChatGPT (Codex)',
    status: async () => ({ method: 'codex', label: 'x', state: 'signedOut' }),
    signIn: async (ctl) => {
      ctl.progress({ stage: 'installing', message: 'Installing...' })
      ctl.progress({ stage: 'device', url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' })
      ctl.progress({ stage: 'browser', message: 'Opening the browser' })
      return fail ? { ok: false, message: 'no npm', helpUrl: 'https://docs.example/codex' } : { ok: true }
    },
    signOut: async () => undefined
  })
  const svc = new AccountsService({ credentials: creds, providers, registry, emit: (e, p) => e === 'accounts:signin' && events.push(p as SignInProgress), providersChanged: async () => undefined })
  await svc.signIn('openai')
  const device = events.find((e) => e.stage === 'device')!
  assert.equal(device.userCode, 'ABCD-1234')
  const browser = events.find((e) => e.stage === 'browser')!
  assert.equal(browser.userCode, undefined)
  assert.equal(browser.url, undefined)
  fail = true
  const last = await svc.signIn('openai')
  assert.equal(last.phase, 'failed')
  assert.equal(last.helpUrl, 'https://docs.example/codex')
})

// ---------------------------------------------------------------- defaults after sign-in

function defaultsFixture(o: { key: boolean | null; model: ModelChoice; ready?: Partial<Record<string, boolean>>; backend?: ImageBackend }) {
  const state = { model: o.model, backend: o.backend }
  return {
    state,
    deps: {
      openAiKeyWorks: async () => o.key,
      defaultModel: () => state.model,
      providerReady: async (p: string) => o.ready?.[p] ?? false,
      setDefaultModel: (c: ModelChoice) => (state.model = c),
      imageBackend: () => state.backend,
      setImageBackend: (b: ImageBackend) => (state.backend = b)
    }
  }
}

test('applyCodexDefaults: a rejected/missing OpenAI key moves OpenAI chat and images to Codex', async () => {
  const f = defaultsFixture({ key: false, model: { provider: 'openai', model: 'gpt-6-astra' } })
  const r = await applyCodexDefaults(f.deps)
  assert.deepEqual(f.state.model, { provider: 'codex', model: 'codex-default' })
  assert.equal(f.state.backend, 'codex')
  assert.match(r.message ?? '', /chat and images/)

  // A working Claude default stays; images still move (the API backend has no working key).
  const g = defaultsFixture({ key: false, model: { provider: 'anthropic', model: 'claude-opus-5-5' }, ready: { anthropic: true } })
  const r2 = await applyCodexDefaults(g.deps)
  assert.equal(g.state.model.provider, 'anthropic')
  assert.equal(g.state.backend, 'codex')
  assert.equal(r2.chat, false)
  assert.match(r2.message ?? '', /for images/)

  // An unusable default (Claude not set up) moves too.
  const h = defaultsFixture({ key: false, model: { provider: 'anthropic', model: 'claude-opus-5-5' }, ready: { anthropic: false } })
  assert.equal((await applyCodexDefaults(h.deps)).chat, true)
})

test('applyCodexDefaults: a working key, or no answer (offline), changes nothing', async () => {
  for (const key of [true, null]) {
    const f = defaultsFixture({ key, model: { provider: 'openai', model: 'gpt-6-astra' }, backend: 'api' })
    const r = await applyCodexDefaults(f.deps)
    assert.equal(r.message, null)
    assert.equal(f.state.model.provider, 'openai')
    assert.equal(f.state.backend, 'api')
  }
  // Already Codex everywhere: nothing to say.
  const g = defaultsFixture({ key: false, model: { provider: 'codex', model: 'gpt-6.1-sol' }, backend: 'codex' })
  assert.equal((await applyCodexDefaults(g.deps)).message, null)
})

test('Providers.models("codex") lists what the CLI reports, codex-default first; defaults otherwise', async () => {
  const fake = fakeContext()
  const creds = new Credentials(fake.ctx)
  let listed: string[] = ['gpt-6.1-sol', 'gpt-5.5']
  const codex = { models: async () => listed, status: async () => ({ installed: true, loggedIn: true, detail: '', checkedAt: 1 }), signingInNow: () => false }
  const providers = new Providers(fake.ctx, creds, (async () => new Response('{}')) as never, () => codex as never)
  assert.deepEqual(await providers.models('codex'), ['codex-default', 'gpt-6.1-sol', 'gpt-5.5'])
  listed = []
  const p2 = new Providers(fake.ctx, creds, (async () => new Response('{}')) as never, () => codex as never)
  const defaults = await p2.models('codex')
  assert.equal(defaults[0], 'codex-default')
  assert.ok(defaults.length > 2)
})

// ---------------------------------------------------------------- the real processes (fake scripts)

// mode: 'device' (prints the device prompt, then signs in), 'old' (no --device-auth flag),
// 'devicefail' (device login errors), 'slow' (waits for cancel).
async function fakeCodexScript(file: string, state: string): Promise<void> {
  const prompt = DEVICE_PROMPT.replace(/\x1b/g, '\\033').replace(/'/g, "'\\''").replace(/%/g, '%%').replace(/\n/g, '\\n')
  await writeFile(
    file,
    `#!/bin/sh
S="${state}"
MODE=$(cat "$S/mode" 2>/dev/null || echo device)
case "$1" in
  --version) echo "codex-cli 0.162.1"; exit 0 ;;
  debug) echo '{"models":[{"slug":"gpt-6.1-sol","visibility":"list","priority":1},{"slug":"x-hidden","visibility":"hide","priority":2}]}'; exit 0 ;;
  login)
    if [ "$2" = "status" ]; then
      if [ -f "$S/loggedin" ]; then echo "Logged in using ChatGPT" >&2; exit 0; fi
      echo "Not logged in" >&2; exit 1
    fi
    if [ "$2" = "--device-auth" ]; then
      echo device >> "$S/calls"
      if [ "$MODE" = "old" ]; then printf "error: unexpected argument '--device-auth' found\\n\\nUsage: codex login [OPTIONS] [COMMAND]\\n" >&2; exit 2; fi
      if [ "$MODE" = "devicefail" ]; then echo "Error logging in with device code: boom" >&2; exit 1; fi
      printf '${prompt}'
      if [ "$MODE" = "slow" ]; then sleep 30; fi
      sleep 0.2
      touch "$S/loggedin"; echo "Successfully logged in" >&2; exit 0
    fi
    echo browser >> "$S/calls"
    echo "If your browser did not open, navigate to this URL to authenticate: https://auth.openai.com/oauth/authorize?state=abc" >&2
    touch "$S/loggedin"; echo "Successfully logged in" >&2; exit 0 ;;
  logout) rm -f "$S/loggedin"; exit 0 ;;
esac
exit 2
`
  )
  await chmod(file, 0o755)
}

async function fixture(): Promise<{ dir: string; state: string; prefix: string; codexSrc: string; npm: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-seam-'))
  const state = join(dir, 'state')
  await mkdir(state, { recursive: true })
  const codexSrc = join(dir, 'codex-src')
  await fakeCodexScript(codexSrc, state)
  const prefix = join(dir, 'user data', 'tools', 'codex')
  // Fake npm: records its args and cwd, then "installs" codex where npm --prefix puts the launcher.
  const npm = join(dir, 'npm')
  await writeFile(
    npm,
    `#!/bin/sh
S="${state}"
printf '%s\\n' "$@" > "$S/npm-args"
pwd > "$S/npm-cwd"
printf '%s' "$npm_config_global" > "$S/npm-global"
NPMMODE=$(cat "$S/npm-mode" 2>/dev/null || echo ok)
P="$3"
echo "npm http fetch GET 200 https://registry.npmjs.org/@openai/codex/-/codex-0.162.1-linux-x64.tgz 10ms" >&2
mkdir -p "$P/node_modules/@openai/codex"
if [ "$NPMMODE" = "fail" ]; then echo "npm error code ENOTFOUND" >&2; echo "npm error network request failed" >&2; exit 1; fi
if [ "$NPMMODE" = "slow" ]; then sleep 30; fi
mkdir -p "$P/node_modules/.bin"
cp "${codexSrc}" "$P/node_modules/.bin/codex"
chmod +x "$P/node_modules/.bin/codex"
echo "added 2 packages in 1s"
exit 0
`
  )
  await chmod(npm, 0o755)
  return { dir, state, prefix, codexSrc, npm }
}

function service(f: { dir: string; prefix: string; npm: string }, npm: string | null = f.npm): CodexService {
  return new CodexService({
    // Only Forge's private copy counts here, so a real codex on this machine cannot interfere.
    findBin: () => findPrivateCodex(f.prefix),
    privatePrefix: () => f.prefix,
    findNpm: () => npm,
    env: () => ({ PATH: process.env.PATH, npm_config_global: 'true' }),
    tmpDir: () => f.dir
  })
}

test('fake npm + codex: one click installs privately, then device sign-in shows the code and finishes', shOnly, async () => {
  const f = await fixture()
  try {
    const svc = service(f)
    assert.equal((await svc.status()).canInstall, true)
    const updates: SignInUpdate[] = []
    const r = await svc.signIn({ signal: new AbortController().signal, progress: (u) => updates.push(u) })
    assert.equal(r.ok, true, r.message)
    // npm: a local --prefix install of the pinned version, run inside the prefix, never global.
    const args = (await readFile(join(f.state, 'npm-args'), 'utf8')).trim().split('\n')
    assert.deepEqual(args.slice(0, 3), ['install', '--prefix', f.prefix])
    assert.equal(args.at(-1), `@openai/codex@${CODEX_NPM_VERSION}`)
    // realpath: macOS's tmpdir is a symlink (/var -> /private/var), and the shell's pwd resolves it.
    assert.equal(realpathSync((await readFile(join(f.state, 'npm-cwd'), 'utf8')).trim()), realpathSync(f.prefix))
    assert.equal(await readFile(join(f.state, 'npm-global'), 'utf8'), '', 'npm_config_global is not passed on')
    assert.ok(updates.some((u) => u.stage === 'installing' && /Downloading/.test(u.message ?? '')))
    const device = updates.find((u) => u.userCode)
    assert.equal(device?.userCode, 'ABCD-12345')
    assert.equal(device?.url, 'https://auth.openai.com/codex/device')
    assert.equal(device?.stage, 'device')
    const st = await svc.status()
    assert.equal(st.loggedIn, true)
    assert.equal(st.privateInstall, true)
    assert.equal(st.path, join(f.prefix, 'node_modules', '.bin', 'codex'))
    assert.deepEqual(await svc.models(), ['gpt-6.1-sol'])
    // Signing in again while signed in does not start a new device login (it would clear the login).
    assert.equal((await svc.signIn({ signal: new AbortController().signal })).ok, true)
    assert.equal((await readFile(join(f.state, 'calls'), 'utf8')).trim().split('\n').length, 1)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('fake codex: an older CLI without --device-auth falls back to the browser login', shOnly, async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.prefix, 'node_modules', '.bin'), { recursive: true })
    await fakeCodexScript(join(f.prefix, 'node_modules', '.bin', 'codex'), f.state)
    await writeFile(join(f.state, 'mode'), 'old')
    const svc = service(f)
    const updates: SignInUpdate[] = []
    const r = await svc.signIn({ signal: new AbortController().signal, progress: (u) => updates.push(u) })
    assert.equal(r.ok, true, r.message)
    assert.deepEqual((await readFile(join(f.state, 'calls'), 'utf8')).trim().split('\n'), ['device', 'browser'])
    assert.ok(updates.some((u) => u.stage === 'browser' && u.url === 'https://auth.openai.com/oauth/authorize?state=abc'))
    assert.ok(!existsSync(join(f.state, 'npm-args')), 'nothing installed when codex is there')

    // A real device-login error is reported, not papered over with the browser.
    await rm(join(f.state, 'loggedin'), { force: true })
    await rm(join(f.state, 'calls'), { force: true })
    await writeFile(join(f.state, 'mode'), 'devicefail')
    const bad = await svc.signIn({ signal: new AbortController().signal })
    assert.equal(bad.ok, false)
    assert.match(bad.message ?? '', /boom/)
    assert.deepEqual((await readFile(join(f.state, 'calls'), 'utf8')).trim().split('\n'), ['device'])
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('fake npm: a failed install cleans up and says why; cancel stops the install', shOnly, async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.state, 'npm-mode'), 'fail')
    const svc = service(f)
    const r = await svc.signIn({ signal: new AbortController().signal })
    assert.equal(r.ok, false)
    assert.match(r.message ?? '', /could not reach the npm registry/)
    assert.ok(r.helpUrl)
    assert.ok(!existsSync(join(f.prefix, 'node_modules')), 'half-installed files removed')

    await writeFile(join(f.state, 'npm-mode'), 'slow')
    const abort = new AbortController()
    const started = Date.now()
    const p = svc.signIn({ signal: abort.signal, progress: (u) => u.stage === 'installing' && setTimeout(() => abort.abort(), 300) })
    const c = await p
    assert.equal(c.ok, false)
    assert.match(c.message ?? '', /cancelled/)
    assert.ok(Date.now() - started < 8000, `stopped in ${Date.now() - started} ms`)
    assert.ok(!existsSync(join(f.prefix, 'node_modules')))
    assert.equal(svc.signingInNow(), false)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('fake codex: cancel while waiting for the device code', shOnly, async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.prefix, 'node_modules', '.bin'), { recursive: true })
    await fakeCodexScript(join(f.prefix, 'node_modules', '.bin', 'codex'), f.state)
    await writeFile(join(f.state, 'mode'), 'slow')
    const svc = service(f)
    const abort = new AbortController()
    const r = await svc.signIn({ signal: abort.signal, progress: (u) => u.userCode && abort.abort() })
    assert.equal(r.ok, false)
    assert.match(r.message ?? '', /cancelled/)
    assert.equal((await svc.status({ refresh: true })).loggedIn, false)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})
