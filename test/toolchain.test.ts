import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  aliasPath,
  checkProjectTools,
  detectGit,
  detectTools,
  explainFailure,
  installProjectTools,
  parseRokitToml,
  PINNED_TOOLS,
  rokitPaths,
  runSetup,
  storedToolPath,
  toolchainStatus,
  type SetupProgress,
  type ToolchainEnv
} from '../src/main/services/setup/toolchain.ts'
import type { CommandRunner, RunOptions } from '../src/main/services/setup/runner.ts'
import { errorLine } from '../src/main/services/setup/runner.ts'
import { findBundledRokit, refreshProcessPath } from '../src/main/setup.ts'
import type { ToolContext } from '../src/main/services/tools.ts'

// A fake machine: files in a Set, text files in a Map, and a fake rokit that edits them the way the
// real one does (self-install copies itself to ~/.rokit/bin; add --global writes the manifest, the
// tool storage and the alias link).
interface Call {
  file: string
  args: string[]
  cwd: string
}

function machine(platform: NodeJS.Platform = 'linux') {
  const files = new Set<string>()
  const texts = new Map<string, string>()
  const ctx: ToolContext = {
    platform,
    env: platform === 'win32' ? { Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me' } : { PATH: '/usr/bin:/bin' },
    home: platform === 'win32' ? 'C:\\Users\\me' : '/home/me',
    isExecutable: (file) => files.has(file),
    listDir: () => []
  }
  const paths = rokitPaths(ctx)
  const calls: Call[] = []
  // Per-alias behaviour for `rokit add`: output and exit code.
  const fail = new Map<string, { code: number; output: string }>()
  const manifest = () => parseRokitToml(texts.get(paths.manifest) ?? '')
  const writeManifest = (entries: Map<string, { id: string; version: string }>) =>
    texts.set(paths.manifest, '[tools]\n' + [...entries].map(([a, s]) => `${a} = "${s.id}@${s.version}"`).join('\n') + '\n')
  const install = (alias: string, id: string, version: string) => {
    const m = manifest()
    m.set(alias, { id, version })
    writeManifest(m)
    files.add(storedToolPath(ctx, id, version))
    files.add(aliasPath(ctx, alias))
  }
  let hold: Promise<void> | null = null
  const runner: CommandRunner = async (file, args, options: RunOptions) => {
    calls.push({ file, args, cwd: options.cwd })
    if (hold) await hold
    if (options.signal?.aborted) return { code: 130, output: 'cancelled' }
    if (args[0] === '--version') {
      if (file.endsWith('git')) return { code: 0, output: 'git version 2.50.1' }
      return { code: 0, output: 'rokit 1.2.0' }
    }
    if (args[0] === 'self-install') {
      files.add(paths.rokit)
      options.onLine?.('Rokit has been installed successfully!')
      return { code: 0, output: '' }
    }
    if (args[0] === 'add') {
      const [spec, alias] = args.slice(-2)
      const f = fail.get(alias)
      if (f) return f
      const [id, version = '9.9.9'] = spec.split('@')
      options.onLine?.(`Fetching ${spec}`)
      install(alias, id, version)
      return { code: 0, output: `Added version ${version} of tool ${alias}` }
    }
    if (args[0] === 'update') {
      const alias = args[2]
      const spec = manifest().get(alias)!
      install(alias, spec.id, '99.0.0')
      return { code: 0, output: '' }
    }
    if (args[0] === 'install') return { code: 0, output: 'Installed' }
    return { code: 1, output: `unknown ${args.join(' ')}` }
  }
  const env: ToolchainEnv = {
    ctx,
    fs: { exists: (f) => files.has(f) || texts.has(f), read: (f) => texts.get(f) ?? null },
    runner,
    bundledRokit: platform === 'win32' ? 'C:\\Program Files\\RBX Forge\\resources\\rokit\\rokit.exe' : '/opt/forge/resources/rokit/rokit'
  }
  return { ctx, env, files, texts, calls, fail, paths, install, setHold: (p: Promise<void> | null) => (hold = p) }
}

function collect() {
  const events: SetupProgress[] = []
  return { events, onProgress: (p: SetupProgress) => events.push(p) }
}

test('parseRokitToml reads [tools] aliases, ignores comments and other tables', () => {
  const m = parseRokitToml('# c\n[tools]\nrojo = "rojo-rbx/rojo@7.7.0" # pinned\n"luau-lsp" = "JohnnyMorganz/luau-lsp@1.69.0"\nStyLua = \'JohnnyMorganz/StyLua@v2.5.2\'\n[other]\nx = "a/b@1.0.0"\n')
  assert.deepEqual([...m.keys()], ['rojo', 'luau-lsp', 'stylua'])
  assert.deepEqual(m.get('stylua'), { id: 'JohnnyMorganz/StyLua', version: '2.5.2' })
  assert.equal(m.has('x'), false)
})

test('rokit paths follow rokit: ~/.rokit, USERPROFILE on Windows, lower-cased storage, .exe', () => {
  const lin = machine('linux')
  assert.equal(lin.paths.rokit, '/home/me/.rokit/bin/rokit')
  assert.equal(storedToolPath(lin.ctx, 'JohnnyMorganz/StyLua', '2.5.2'), '/home/me/.rokit/tool-storage/johnnymorganz/stylua/2.5.2/stylua')
  const win = machine('win32')
  assert.equal(win.paths.rokit, 'C:\\Users\\me\\.rokit\\bin\\rokit.exe')
  assert.equal(aliasPath(win.ctx, 'luau-lsp'), 'C:\\Users\\me\\.rokit\\bin\\luau-lsp.exe')
  const rooted = { ...lin.ctx, env: { ...lin.ctx.env, ROKIT_ROOT: '/data/rokit' } }
  assert.equal(rokitPaths(rooted).bin, '/data/rokit/bin')
})

test('pinned tools match the template rokit.toml versions and rokit ids', () => {
  const byAlias = Object.fromEntries(PINNED_TOOLS.map((t) => [t.alias, `${t.id}@${t.version}`]))
  assert.deepEqual(byAlias, {
    rojo: 'rojo-rbx/rojo@7.7.0',
    wally: 'UpliftGames/wally@0.3.2',
    blink: '1Axen/blink@0.18.1',
    lune: 'lune-org/lune@0.11.0',
    'luau-lsp': 'JohnnyMorganz/luau-lsp@1.69.0',
    selene: 'Kampfkarren/selene@0.32.0',
    stylua: 'JohnnyMorganz/StyLua@2.5.2',
    'wally-package-types': 'JohnnyMorganz/wally-package-types@1.6.2'
  })
})

test('detectTools: ok, other, broken, external and missing', () => {
  const m = machine()
  m.install('rojo', 'rojo-rbx/rojo', '7.7.0')
  m.install('wally', 'UpliftGames/wally', '0.4.0')
  m.install('blink', '1Axen/blink', '0.18.1')
  m.files.delete(storedToolPath(m.ctx, '1Axen/blink', '0.18.1'))
  m.files.add('/usr/bin/selene')
  const by = Object.fromEntries(detectTools(m.env).map((t) => [t.alias, t]))
  assert.equal(by.rojo.state, 'ok')
  assert.equal(by.wally.state, 'other')
  assert.equal(by.wally.version, '0.4.0')
  assert.equal(by.blink.state, 'broken')
  assert.equal(by.selene.state, 'external')
  assert.equal(by.selene.path, '/usr/bin/selene')
  assert.equal(by.lune.state, 'missing')
})

test('first-run setup: self-installs the bundled rokit, then adds every pinned tool globally', async () => {
  const m = machine()
  const { events, onProgress } = collect()
  const result = await runSetup(m.env, { mode: 'install', onProgress })
  assert.equal(result.ok, true)
  assert.deepEqual(m.calls.filter((c) => c.args[0] !== '--version').map((c) => [c.file, ...c.args].join(' ')), [
    '/opt/forge/resources/rokit/rokit self-install',
    ...PINNED_TOOLS.map((t) => `/home/me/.rokit/bin/rokit add --global --force ${t.id}@${t.version} ${t.alias}`)
  ])
  assert.deepEqual(result.steps.map((s) => s.state), Array(9).fill('done'))
  // Live progress: each tool goes running -> done, with output lines in between.
  assert.ok(events.some((e) => e.step === 'lune' && e.state === 'running' && e.message === 'Fetching lune-org/lune@0.11.0'))
  assert.ok(detectTools(m.env).every((t) => t.state === 'ok'))
  const status = await toolchainStatus(m.env, 'done')
  assert.equal(status.needsSetup, false)
  assert.equal(status.git.available, false)
})

test('a second install run skips what is already installed', async () => {
  const m = machine()
  await runSetup(m.env, { mode: 'install' })
  m.calls.length = 0
  const result = await runSetup(m.env, { mode: 'install' })
  assert.ok(result.ok)
  assert.equal(m.calls.filter((c) => c.args[0] === 'add' || c.args[0] === 'self-install').length, 0)
  assert.ok(result.steps.slice(1).every((s) => s.state === 'skipped' && /already installed/.test(s.message ?? '')))
})

test('a failing tool is reported with a readable reason and the others still install', async () => {
  const m = machine()
  m.fail.set('lune', { code: 1, output: 'WARN Retry attempt #2\nERROR GitHub error: reqwest middleware error: Request failed after 3 retries\nStack backtrace:\n  0: rokit::main' })
  m.fail.set('selene', { code: 1, output: 'error: Failed to fetch release for Kampfkarren/selene@0.32.0\nMake sure the given tool version exists.' })
  const result = await runSetup(m.env, { mode: 'install' })
  assert.equal(result.ok, false)
  assert.equal(result.network, true)
  const by = Object.fromEntries(result.steps.map((s) => [s.step, s]))
  assert.equal(by.lune.state, 'failed')
  assert.match(by.lune.message!, /Could not reach GitHub/)
  assert.equal(by.selene.state, 'failed')
  assert.equal(by.selene.message, 'Failed to fetch release for Kampfkarren/selene@0.32.0')
  assert.equal(by.rojo.state, 'done')
  assert.equal(by.stylua.state, 'done')
  // Retry only touches what is missing.
  m.fail.clear()
  m.calls.length = 0
  const retry = await runSetup(m.env, { mode: 'install' })
  assert.ok(retry.ok)
  assert.deepEqual(m.calls.filter((c) => c.args[0] === 'add').map((c) => c.args.at(-1)), ['lune', 'selene'])
})

test('rate limits are explained as such', () => {
  assert.match(explainFailure('GitHub error: API rate limit exceeded for 1.2.3.4').message, /rate limit/)
  assert.equal(explainFailure('GitHub error: API rate limit exceeded').network, true)
  assert.equal(errorLine('\u001b[31mERROR\u001b[0m boom\n   0: x\n   at y'), 'boom')
})

test('skip: aborting stops after the running step and marks the rest skipped', async () => {
  const m = machine()
  const controller = new AbortController()
  let release!: () => void
  m.setHold(new Promise<void>((r) => (release = r)))
  const done = runSetup(m.env, {
    mode: 'install',
    signal: controller.signal,
    onProgress: (p) => {
      if (p.step === 'rokit' && p.state === 'done') {
        controller.abort()
      }
    }
  })
  release()
  const result = await done
  assert.equal(result.cancelled, true)
  assert.equal(result.steps[0].step, 'rokit')
  assert.ok(result.steps.slice(1).every((s) => s.state === 'skipped' && s.message === 'Cancelled'))
  assert.equal(m.calls.filter((c) => c.args[0] === 'add').length, 0)
})

test('repair reinstalls rokit and the pinned versions, even over ok and other versions', async () => {
  const m = machine()
  await runSetup(m.env, { mode: 'install' })
  m.install('wally', 'UpliftGames/wally', '0.4.0')
  m.files.delete(aliasPath(m.ctx, 'rojo'))
  assert.equal(detectTools(m.env).find((t) => t.alias === 'rojo')!.state, 'broken')
  m.calls.length = 0
  const result = await runSetup(m.env, { mode: 'repair' })
  assert.ok(result.ok)
  assert.equal(m.calls.filter((c) => c.args[0] === 'self-install').length, 1)
  assert.equal(m.calls.filter((c) => c.args[0] === 'add').length, PINNED_TOOLS.length)
  assert.ok(detectTools(m.env).every((t) => t.state === 'ok'))
})

test('repair of one tool only touches that tool', async () => {
  const m = machine()
  await runSetup(m.env, { mode: 'install' })
  m.calls.length = 0
  const result = await runSetup(m.env, { mode: 'repair', tools: ['blink'] })
  assert.deepEqual(result.steps.map((s) => s.step), ['rokit', 'blink'])
  assert.deepEqual(m.calls.filter((c) => c.args[0] === 'add').map((c) => c.args.join(' ')), ['add --global --force 1Axen/blink@0.18.1 blink'])
})

test('update uses rokit update --global for managed tools', async () => {
  const m = machine()
  await runSetup(m.env, { mode: 'install', tools: ['rojo'] })
  m.calls.length = 0
  await runSetup(m.env, { mode: 'update', tools: ['rojo', 'wally'] })
  assert.deepEqual(m.calls.filter((c) => c.args[0] === 'update' || c.args[0] === 'add').map((c) => c.args.join(' ')), [
    'update --global rojo',
    'add --global --force UpliftGames/wally wally'
  ])
  assert.equal(detectTools(m.env).find((t) => t.alias === 'rojo')!.state, 'other')
})

test('without a bundled or installed rokit every tool is skipped with a clear reason', async () => {
  const m = machine()
  m.env.bundledRokit = null
  const result = await runSetup(m.env, { mode: 'install' })
  assert.equal(result.steps[0].state, 'failed')
  assert.match(result.steps[0].message!, /github.com\/rojo-rbx\/rokit/)
  assert.ok(result.steps.slice(1).every((s) => s.state === 'skipped' && s.message === 'Needs rokit'))
})

test('detectGit runs git --version and gives a Windows download link when missing', async () => {
  const win = machine('win32')
  const missing = await detectGit(win.env)
  assert.equal(missing.available, false)
  assert.equal(missing.downloadUrl, 'https://git-scm.com/downloads/win')
  assert.match(missing.hint!, /Git for Windows/)
  const lin = machine()
  lin.files.add('/usr/bin/git')
  const found = await detectGit(lin.env)
  assert.deepEqual([found.available, found.version], [true, '2.50.1'])
})

test('per-project tools: missing known tools install with --no-trust-check; unknown ones wait for trust', async () => {
  const m = machine()
  await runSetup(m.env, { mode: 'install' })
  m.texts.set('/games/a/rokit.toml', '[tools]\nrojo = "rojo-rbx/rojo@7.6.0"\nwally = "UpliftGames/wally@0.3.2"\n')
  const check = checkProjectTools(m.env, '/games/a')
  assert.deepEqual(check.missing.map((t) => `${t.alias}@${t.version}`), ['rojo@7.6.0'])
  m.calls.length = 0
  const done = await installProjectTools(m.env, '/games/a')
  assert.equal(done.state, 'done')
  assert.deepEqual(m.calls.map((c) => [c.args.join(' '), c.cwd]), [['install --no-trust-check', '/games/a']])

  m.texts.set('/games/b/rokit.toml', '[tools]\nzap = "red-blox/zap@0.6.29"\n')
  m.calls.length = 0
  const trust = await installProjectTools(m.env, '/games/b')
  assert.equal(trust.state, 'needsTrust')
  assert.match(trust.message!, /red-blox\/zap/)
  assert.equal(m.calls.length, 0)
  assert.equal((await installProjectTools(m.env, '/games/none')).state, 'none')
})

test('bundled rokit is found in resources when packaged and in resources/rokit/<os>-<arch> in development', () => {
  const have = new Set(['/app/Contents/Resources/rokit/rokit', '/repo/resources/rokit/win-arm64/rokit.exe'])
  assert.equal(findBundledRokit('/app/Contents/Resources', '/repo', 'darwin', 'arm64', (f) => have.has(f)), '/app/Contents/Resources/rokit/rokit')
  // Paths follow the target platform, not the host running the test.
  assert.equal(findBundledRokit(null, '/repo', 'win32', 'arm64', (f) => have.has(f.replace(/\\/g, '/'))), '\\repo\\resources\\rokit\\win-arm64\\rokit.exe')
  assert.equal(findBundledRokit(null, '/repo', 'darwin', 'x64', (f) => have.has(f)), null)
})

test('refreshProcessPath puts ~/.rokit/bin on this process PATH once', () => {
  // An explicit bin: the host's own home (C:\Users\... on Windows) has a ':' that splits a POSIX PATH.
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
  assert.equal(refreshProcessPath(env, 'linux', '/home/me/.rokit/bin'), true)
  assert.equal(env.PATH, '/home/me/.rokit/bin:/usr/bin')
  assert.equal(refreshProcessPath(env, 'linux', '/home/me/.rokit/bin'), false)
  const win: NodeJS.ProcessEnv = { Path: 'C:\\Windows', USERPROFILE: 'D:\\Me' }
  assert.equal(refreshProcessPath(win, 'win32'), true)
  assert.equal(win.Path, 'D:\\Me\\.rokit\\bin;C:\\Windows')
  assert.equal(refreshProcessPath(win, 'win32'), false)
})
