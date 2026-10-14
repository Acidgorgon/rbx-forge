// Forge Doctor: pure checks per area (green / amber / red with a fix each), the probe gathering
// with injected probes (timeouts, failing probes, python only for the project engine, ports),
// Open Cloud scope parsing, the Markdown export (no key values, home redacted), and fixes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:net'
import { appChecks, diskChecks, gitChecks, keyChecks, portChecks, projectChecks, runChecks, studioChecks, summarize, syncChecks, toolchainChecks } from '../src/shared/doctor/checks.ts'
import { doctorMarkdown, redactHome } from '../src/shared/doctor/format.ts'
import type { DoctorInputs } from '../src/shared/doctor/types.ts'
import { DoctorService, gatherInputs, scopeStrings, type DoctorProbes } from '../src/main/services/doctor/service.ts'
import { introspectOpenCloudKey, portBusy, studioCandidates } from '../src/main/services/doctor/wire.ts'

const NOW = Date.UTC(2026, 9, 14, 12)

function healthy(): DoctorInputs {
  return {
    platform: 'darwin',
    appVersion: '0.6.0',
    isPackaged: true,
    toolchain: { rokit: { installed: true, version: '1.2.0' }, tools: ['rojo', 'lune', 'luau-lsp', 'wally', 'blink', 'selene', 'stylua'].map((alias) => ({ alias, pinned: '1.0.0', version: '1.0.0', state: 'ok' as const })) },
    git: { available: true, version: '2.47.0' },
    gh: { available: true, version: '2.60.0', authed: true },
    python: null,
    studioInstall: { installed: true, path: '/Applications/RobloxStudio.app' },
    bridge: { port: 34880, listening: true, plugin: { installed: true, version: 3, bundled: 3, dir: '/x/Plugins' }, studio: { connected: true, place: 'Game', pluginVersion: 3, lastSeen: NOW } },
    legacyPlugins: [],
    ports: [{ port: 34872, label: 'rojo serve (Game)', state: 'ours', expected: true }],
    rojo: 'running',
    sync: { engine: 'forge', places: [{ projectFile: 'default.project.json', gate: 'clear', conflicts: 0, connected: true }], pendingStudioEdits: 0 },
    keys: [
      { provider: 'anthropic', label: 'Anthropic', set: true, isDefault: true },
      { provider: 'openai', label: 'OpenAI', set: true, isDefault: false },
      { provider: 'ollama', label: 'Ollama', set: false, isDefault: false, local: true }
    ],
    openCloud: { set: true, introspect: { enabled: true, expired: false, scopes: ['asset:read', 'asset:write'] } },
    openAiKey: true,
    disk: [{ label: 'App data', path: '/u', freeBytes: 50 * 1024 ** 3 }],
    project: { root: '/p', projectFiles: [{ file: 'default.project.json', ok: true, servePort: 34872 }], wallyToml: true, packagesInstalled: true, rokitToml: true, projectToolsMissing: [], sourcemap: { exists: true, ageMs: 60_000 } },
    updater: { state: 'none' },
    screenRecording: 'granted'
  }
}

test('a healthy setup is all green', () => {
  const checks = runChecks(healthy(), NOW)
  const bad = checks.filter((c) => c.status === 'warn' || c.status === 'fail')
  assert.deepEqual(bad, [])
  const r = summarize(checks, { at: NOW, ms: 5, appVersion: '0.6.0', platform: 'darwin' })
  assert.equal(r.overall, 'ok')
  assert.ok(r.counts.ok > 20)
})

test('toolchain: missing / other / external / broken tools each get a fix', () => {
  const i = healthy()
  i.toolchain!.rokit.installed = false
  i.toolchain!.tools[0] = { alias: 'rojo', pinned: '7.7.0', version: null, state: 'missing' }
  i.toolchain!.tools[1] = { alias: 'lune', pinned: '0.11.0', version: '0.10.0', state: 'other' }
  i.toolchain!.tools[2] = { alias: 'luau-lsp', pinned: '1.69.0', version: null, state: 'external' }
  i.toolchain!.tools[3] = { alias: 'wally', pinned: '0.3.2', version: '0.3.2', state: 'broken' }
  const c = Object.fromEntries(toolchainChecks(i).map((x) => [x.id, x]))
  assert.equal(c.rokit.status, 'fail')
  assert.equal(c['tool-rojo'].status, 'fail')
  assert.deepEqual(c['tool-rojo'].fix, { kind: 'action', action: 'installTools', label: 'Install' })
  assert.equal(c['tool-lune'].status, 'warn')
  assert.match(c['tool-lune'].detail, /tested with 0\.11\.0/)
  assert.equal(c['tool-luau-lsp'].status, 'warn')
  assert.equal(c['tool-wally'].status, 'fail')
  // Python only when the project engine is used.
  assert.ok(!toolchainChecks(healthy()).some((x) => x.id === 'python'))
  i.python = { available: false, version: null }
  assert.equal(toolchainChecks(i).find((x) => x.id === 'python')?.status, 'fail')
})

test('git and gh', () => {
  const i = healthy()
  i.git = { available: false, version: null, hint: 'Run xcode-select --install', downloadUrl: 'https://git-scm.com/downloads/mac' }
  i.gh = { available: true, version: '2.6', authed: false }
  const [git, gh] = gitChecks(i)
  assert.equal(git.status, 'fail')
  assert.equal(git.fix?.kind === 'instruction' && git.fix.url, 'https://git-scm.com/downloads/mac')
  assert.equal(gh.status, 'warn')
  assert.equal(gh.fix?.kind === 'instruction' && gh.fix.command, 'gh auth login')
})

test('studio: plugin missing / outdated, legacy plugin, HTTP inferred from contact', () => {
  const i = healthy()
  i.bridge!.plugin = { installed: false, bundled: 3, dir: '/x' }
  i.bridge!.studio = { connected: false }
  let c = Object.fromEntries(studioChecks(i, NOW).map((x) => [x.id, x]))
  assert.equal(c.plugin.status, 'fail')
  assert.deepEqual(c.plugin.fix, { kind: 'action', action: 'installPlugin', label: 'Install plugin' })
  assert.equal(c['studio-http'].status, 'warn')
  assert.match((c['studio-http'].fix as { text: string }).text, /Allow/)

  i.bridge!.plugin = { installed: true, version: 2, bundled: 3, outdated: true, dir: '/x' }
  i.bridge!.studio = { connected: false, lastSeen: NOW - 5 * 60_000 }
  i.legacyPlugins = ['StudioSync.rbxmx']
  c = Object.fromEntries(studioChecks(i, NOW).map((x) => [x.id, x]))
  assert.equal(c.plugin.status, 'warn')
  assert.match(c.plugin.detail, /Version 2 is older than this Forge \(v3\)/)
  assert.equal(c['legacy-plugin'].fix?.kind === 'action' && c['legacy-plugin'].fix.action, 'disableLegacyPlugins')
  assert.equal(c['studio-http'].status, 'ok') // it talked to Forge 5 minutes ago
  assert.match(c['studio-connected'].detail, /5 min ago/)

  // A connected Studio with an old plugin is outdated even if the file on disk is new.
  const j = healthy()
  j.bridge!.studio.pluginVersion = 2
  assert.equal(studioChecks(j, NOW).find((x) => x.id === 'plugin')?.status, 'warn')

  const linux = healthy()
  linux.studioInstall = null
  assert.deepEqual(studioChecks(linux, NOW).map((x) => x.status), ['skip'])
})

test('ports: bridge not listening, rojo port held by another program, expected but free', () => {
  const i = healthy()
  i.bridge!.listening = false
  i.bridge!.error = 'EADDRINUSE'
  i.ports = [
    { port: 34872, label: 'rojo serve (Game)', state: 'other', expected: false },
    { port: 34873, label: 'rojo serve (Menu)', state: 'free', expected: true },
    { port: 34874, label: 'rojo serve (Lobby)', state: 'free', expected: false }
  ]
  const c = Object.fromEntries(portChecks(i).map((x) => [x.id, x]))
  assert.equal(c['port-bridge'].status, 'fail')
  assert.equal(c['port-34872'].status, 'warn')
  assert.match((c['port-34872'].fix as { command: string }).command, /lsof -nP -iTCP:34872/)
  assert.equal(c['port-34873'].fix?.kind === 'action' && c['port-34873'].fix.action, 'startRojo')
  assert.equal(c['port-34874'].status, 'ok')
})

test('sync: engine off, conflicts + blocked gate, uncommitted Studio edits', () => {
  const i = healthy()
  i.sync = { engine: 'forge', places: [{ projectFile: 'default.project.json', gate: 'blocked', conflicts: 2, connected: true }], pendingStudioEdits: 3 }
  const c = Object.fromEntries(syncChecks(i).map((x) => [x.id, x]))
  assert.equal(c['sync-conflicts'].status, 'fail')
  assert.match(c['sync-conflicts'].detail, /2 conflicts; rojo is held for default\.project\.json/)
  assert.equal(c['sync-pending'].status, 'warn')
  i.sync.engine = 'off'
  assert.equal(syncChecks(i)[0].status, 'warn')
})

test('keys: set / missing only, default provider red, Open Cloud scopes', () => {
  const i = healthy()
  i.keys = [
    { provider: 'anthropic', label: 'Anthropic', set: false, isDefault: true },
    { provider: 'gemini', label: 'Gemini', set: false, isDefault: false }
  ]
  i.openAiKey = false
  i.openCloud = { set: true, introspect: { enabled: true, expired: false, scopes: ['asset:read'] } }
  const c = Object.fromEntries(keyChecks(i).map((x) => [x.id, x]))
  assert.equal(c['key-anthropic'].status, 'fail')
  assert.equal(c['key-gemini'].status, 'skip')
  assert.equal(c['key-openai-art'].status, 'warn')
  assert.match(c['key-opencloud'].detail, /missing scope asset:write/)
  i.openCloud = { set: true, introspect: { enabled: true, expired: true, scopes: [] } }
  assert.equal(keyChecks(i).find((x) => x.id === 'key-opencloud')?.status, 'fail')
  i.openCloud = { set: true, introspect: { error: 'Roblox answered 401' } }
  assert.equal(keyChecks(i).find((x) => x.id === 'key-opencloud')?.status, 'warn')
  for (const x of keyChecks(i)) assert.ok(!/sk-|[A-Za-z0-9]{32,}/.test(x.detail))
})

test('disk, project validity, app (updater + screen recording)', () => {
  const i = healthy()
  i.disk = [
    { label: 'App data', path: '/u', freeBytes: 0.5 * 1024 ** 3 },
    { label: 'Project', path: '/p', freeBytes: 3 * 1024 ** 3 },
    { label: 'Other', path: '/o', freeBytes: null }
  ]
  assert.deepEqual(diskChecks(i).map((x) => x.status), ['fail', 'warn', 'skip'])
  i.project = { root: '/p', projectFiles: [{ file: 'default.project.json', ok: false, error: 'Unexpected token }' }], wallyToml: true, packagesInstalled: false, rokitToml: true, projectToolsMissing: ['rojo 7.7.0'], sourcemap: { exists: true, ageMs: 3 * 24 * 3600_000 } }
  const c = Object.fromEntries(projectChecks(i, NOW).map((x) => [x.id, x]))
  assert.equal(c['pf-default.project.json'].status, 'fail')
  assert.equal(c.wally.fix?.kind === 'action' && c.wally.fix.action, 'wallyInstall')
  assert.equal(c['project-tools'].fix?.kind === 'action' && c['project-tools'].fix.action, 'installProjectTools')
  assert.match(c.sourcemap.detail, /72 h old/)
  i.project.projectFiles = []
  assert.equal(projectChecks(i, NOW)[0].status, 'fail')
  i.project = null
  assert.equal(projectChecks(i, NOW)[0].status, 'skip')

  i.updater = { state: 'error', error: 'offline' }
  i.screenRecording = 'denied'
  const a = Object.fromEntries(appChecks(i).map((x) => [x.id, x]))
  assert.equal(a.updater.status, 'warn')
  assert.equal(a['screen-recording'].fix?.kind === 'action' && a['screen-recording'].fix.action, 'openScreenRecording')
  i.isPackaged = false
  i.screenRecording = null
  assert.deepEqual(appChecks(i).map((x) => x.status), ['skip'])
})

test('markdown export: table, no key values, home redacted', () => {
  const i = healthy()
  i.project!.root = '/Users/acid/game'
  i.disk = [{ label: 'App data', path: '/Users/acid/Library/Application Support/rbx-forge', freeBytes: 0.2 * 1024 ** 3 }]
  const r = summarize(runChecks(i, NOW), { at: NOW, ms: 1, appVersion: '0.6.0', platform: 'darwin' })
  const md = doctorMarkdown(r, { home: '/Users/acid' })
  assert.match(md, /^## Forge Doctor/)
  assert.match(md, /\| FAIL \| Disk: App data \|/)
  assert.ok(!md.includes('/Users/acid'))
  assert.match(md, /\| OK \| Keys: Anthropic key \| set \|/)
  assert.equal(redactHome('C:\\Users\\Acid\\x and /home/bob/y'), '~\\x and ~/y')
})

function fakeProbes(over: Partial<DoctorProbes> = {}): DoctorProbes {
  const h = healthy()
  return {
    platform: 'linux',
    appVersion: '0.6.0',
    isPackaged: false,
    userDataDir: '/u',
    projectRoot: () => '/p',
    toolchain: async () => h.toolchain,
    git: async () => h.git,
    run: async (cmd, args) => (cmd === 'gh' ? { code: args[0] === 'auth' ? 1 : 0, output: 'gh version 2.61.0 (2026-01-01)' } : cmd === 'python3' ? { code: 0, output: 'Python 3.12.1' } : { code: null, output: '' }),
    studioInstall: async () => null,
    bridge: async () => h.bridge,
    legacyPlugins: async () => [],
    servePorts: () => [
      { port: 34872, label: 'rojo serve (Game)', served: true },
      { port: 34872, label: 'dup', served: true },
      { port: 34873, label: 'rojo serve (Menu)', served: false }
    ],
    rojo: () => 'running',
    portBusy: async (port) => port === 34872 || port === 34873,
    sync: async () => ({ engine: 'project', places: [], pendingStudioEdits: 0 }),
    keys: async () => h.keys,
    openCloudKey: async () => 'secret-key-value',
    introspectKey: async () => ({ enabled: true, expired: false, scopes: ['asset:read', 'asset:write'] }),
    openAiKey: async () => true,
    freeBytes: async () => 20 * 1024 ** 3,
    readText: async (p) => (p.endsWith('default.project.json') ? '{"name":"Game","tree":{"$className":"DataModel"},"servePort":34872}' : p.endsWith('menu.project.json') ? '{"name":' : null),
    listDir: async () => ['default.project.json', 'menu.project.json', 'src', 'wally.toml'],
    exists: async (p) => p.endsWith('wally.toml') || p.endsWith('rokit.toml'),
    mtimeMs: async () => null,
    projectToolsMissing: () => [],
    updater: async () => null,
    screenRecording: () => null,
    now: () => NOW,
    ...over
  }
}

test('gatherInputs: gh auth, python for the project engine, ports, project files, keys never carried', async () => {
  const i = await gatherInputs(fakeProbes())
  assert.deepEqual(i.gh, { available: true, version: '2.61.0', authed: false })
  assert.deepEqual(i.python, { available: true, version: 'Python 3.12.1' })
  assert.deepEqual(i.ports, [
    { port: 34872, label: 'rojo serve (Game)', state: 'ours', expected: true },
    { port: 34873, label: 'rojo serve (Menu)', state: 'other', expected: false }
  ])
  assert.deepEqual(i.project!.projectFiles.map((f) => [f.file, f.ok]), [['default.project.json', true], ['menu.project.json', false]])
  assert.equal(i.project!.packagesInstalled, false)
  assert.equal(i.project!.sourcemap.exists, false)
  assert.equal(i.openCloud.set, true)
  assert.ok(!JSON.stringify(i).includes('secret-key-value'))
})

test('gatherInputs: a throwing or hanging probe degrades, never fails the run', async () => {
  const i = await gatherInputs(
    fakeProbes({
      bridge: async () => {
        throw new Error('boom')
      },
      introspectKey: async () => {
        throw new Error('Roblox answered 403')
      },
      sync: () => new Promise(() => undefined) as never
    })
  )
  assert.equal(i.bridge, null)
  assert.deepEqual(i.openCloud.introspect, { error: 'Roblox answered 403' })
  assert.equal(i.sync, null)
})

test('service: run, last report, fixes (unknown fix, failing fix)', async () => {
  let emitted = 0
  const svc = new DoctorService({
    probes: fakeProbes({ sync: async () => ({ engine: 'forge', places: [], pendingStudioEdits: 0 }) }),
    fixers: {
      installPlugin: async () => 'installed',
      wallyInstall: async () => {
        throw new Error('wally not found')
      }
    },
    emit: () => emitted++
  })
  assert.equal(svc.lastReport(), null)
  const [a, b] = await Promise.all([svc.run(), svc.run()])
  assert.equal(a, b) // concurrent runs share one
  assert.equal(emitted, 1)
  assert.equal(svc.lastReport(), a)
  assert.equal(a.overall, 'fail') // menu.project.json does not parse
  assert.deepEqual(await svc.fix('installPlugin'), { ok: true, message: 'installed' })
  assert.deepEqual(await svc.fix('wallyInstall'), { ok: false, message: 'wally not found' })
  assert.equal((await svc.fix('sourcemap')).ok, false)
})

test('Open Cloud introspection: scope strings and the request shape', async () => {
  assert.deepEqual(scopeStrings([{ name: 'asset', operations: ['read', 'write'] }, { name: 'universe-places', operations: ['write'] }, { bad: 1 }]), ['asset:read', 'asset:write', 'universe-places:write'])
  let sent: { url: string; body: string } | null = null
  const fake = (async (url: string, init: { body: string }) => {
    sent = { url, body: init.body }
    return { ok: true, status: 200, json: async () => ({ name: 'k', enabled: true, expired: false, scopes: [{ name: 'asset', operations: ['read'] }] }) }
  }) as unknown as typeof fetch
  const r = await introspectOpenCloudKey('KEY', fake)
  assert.deepEqual(r, { enabled: true, expired: false, scopes: ['asset:read'] })
  assert.equal(sent!.url, 'https://apis.roblox.com/api-keys/v1/introspect')
  assert.deepEqual(JSON.parse(sent!.body), { apiKey: 'KEY' })
  const denied = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch
  await assert.rejects(introspectOpenCloudKey('KEY', denied), /401/)
})

test('studio install candidates and the real port probe', async () => {
  assert.equal(studioCandidates('linux', {}, '/home/a'), null)
  assert.deepEqual(studioCandidates('darwin', {}, '/Users/a')!.apps, ['/Applications/RobloxStudio.app', '/Users/a/Applications/RobloxStudio.app'])
  assert.equal(studioCandidates('win32', { LOCALAPPDATA: 'C:\\L' }, 'C:\\Users\\a')!.versionsDirs[0], 'C:\\L\\Roblox\\Versions')
  const srv = createServer()
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as { port: number }).port
  assert.equal(await portBusy(port), true)
  await new Promise<void>((r) => srv.close(() => r()))
  assert.equal(await portBusy(port), false)
})
