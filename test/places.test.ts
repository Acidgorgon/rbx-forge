import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import type { BlinkModel, ScriptEntry, TreeNode } from '../src/shared/types.ts'
import { BlinkWatcher, discoverBlinkFiles, listEvents, loadBlinkModels } from '../src/main/services/blink.ts'
import { rojoJobs } from '../src/main/services/supervisor.ts'
import { LspBridge } from '../src/main/services/lspBridge.ts'
import { categorize, discoverPlaces, pickPlace, Project, sourcemapFor } from '../src/main/services/project.ts'
import { write } from './fixture.ts'

// Synthetic two-place project shaped like a GenTree game with a separate menu place.
const FIXTURE = resolve(import.meta.dirname, 'fixtures', 'fsf-like')
const roots: string[] = []
const opened: Project[] = []
after(() => {
  for (const project of opened) project.close()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function copyFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-places-'))
  cpSync(FIXTURE, root, { recursive: true })
  roots.push(root)
  return root
}

async function open(root: string, activePlace?: string): Promise<Project> {
  const project = await Project.open(root, { activePlace })
  opened.push(project)
  return project
}

function find(nodes: TreeNode[], path: string[]): TreeNode | undefined {
  let current: TreeNode | undefined
  let list = nodes
  for (const name of path) {
    current = list.find((node) => node.name === name)
    if (!current) return undefined
    list = current.children
  }
  return current
}

function scriptsByPath(project: Project): Map<string, ScriptEntry> {
  return new Map(project.scripts.flatMap((group) => group.scripts).map((s) => [s.path, s]))
}

test('discovers every *.project.json as a place, default first', async () => {
  const root = copyFixture()
  write(root, 'aaa.project.json', JSON.stringify({ name: 'Lab', tree: { $className: 'DataModel' } }))
  write(root, 'not-a-place.json', '{}')
  const places = await discoverPlaces(root)
  assert.deepEqual(places.map((p) => p.file), ['default.project.json', 'aaa.project.json', 'menu.project.json'])
  const [match, lab, menu] = places
  // Same "name" in both files: the default keeps it, the other falls back to its file stem.
  assert.equal(match.name, 'FsfLike')
  assert.equal(match.isDefault, true)
  assert.equal(match.servePort, 34872)
  assert.deepEqual(match.servePlaceIds, [1000001])
  assert.equal(match.sourcemap, 'sourcemap.json')
  assert.equal(lab.name, 'Lab')
  assert.equal(lab.servePort, 34872)
  assert.equal(menu.name, 'menu')
  assert.equal(menu.servePort, 34875)
  assert.deepEqual(menu.servePlaceIds, [2000001, 2000002])
  assert.equal(menu.sourcemap, '.studio-sync/sourcemap.menu.json')
  assert.equal(sourcemapFor('menu.project.json'), '.studio-sync/sourcemap.menu.json')
  assert.equal(pickPlace(places, 'gone.project.json')?.file, 'default.project.json')
  assert.equal(pickPlace(places, 'menu.project.json')?.file, 'menu.project.json')
})

test('default place tree: Features folder with $path and cross-mounted Skills', async () => {
  const project = await open(copyFixture())
  assert.equal(project.activePlace, 'default.project.json')
  assert.equal(project.getActivePlace()?.name, 'FsfLike')
  assert.equal(project.info.activePlace, 'default.project.json')
  assert.equal(project.info.places?.length, 2)
  const tree = project.tree
  const features = find(tree, ['ServerScriptService', 'Server', 'Features'])
  assert.equal(features?.className, 'Folder')
  assert.deepEqual(features?.children.map((c) => c.name), ['Round', 'Skills'])
  const move = find(tree, ['ServerScriptService', 'Server', 'Features', 'Skills', 'Moves', 'Dash'])
  assert.equal(move?.filePath, 'src/skills/Server/Moves/Dash/init.luau')
  assert.equal(find(tree, ['ServerScriptService', 'Server', 'Bootstrapper'])?.className, 'Script')
  assert.equal(find(tree, ['ReplicatedStorage', 'Shared', 'Skills', 'Dash'])?.filePath, 'src/skills/Definitions/Dash.luau')
  const matchController = find(tree, ['ReplicatedStorage', 'Shared', 'Skills', 'MatchController'])
  assert.equal(matchController?.className, 'ModuleScript')
  assert.equal(matchController?.filePath, 'src/skills/Client/init.luau')
  // Menu-only folders are not in the match place.
  assert.equal(find(tree, ['ReplicatedFirst']), undefined)
  assert.equal(scriptsByPath(project).has('src/menu/server/QueueHandler.server.luau'), false)
})

test('menu place tree, and files shared by both places show in both', async () => {
  const root = copyFixture()
  const project = await open(root, 'menu.project.json')
  assert.equal(project.activePlace, 'menu.project.json')
  const tree = project.tree
  assert.equal(find(tree, ['ReplicatedFirst', 'First', 'Loading'])?.className, 'LocalScript')
  assert.equal(find(tree, ['ServerScriptService', 'Server', 'QueueHandler'])?.className, 'Script')
  assert.equal(find(tree, ['ServerScriptService', 'Server', 'Data', 'PlayerData'])?.filePath, 'src/server/Data/PlayerData.luau')
  assert.equal(find(tree, ['ServerScriptService', 'Server', 'Admins'])?.filePath, 'src/server/Config/Admins.luau')
  assert.equal(find(tree, ['ReplicatedStorage', 'Shared', 'Skills', 'Dash'])?.filePath, 'src/skills/Definitions/Dash.luau')
  assert.equal(find(tree, ['ServerScriptService', 'Server', 'Handlers']), undefined)

  const menu = scriptsByPath(project)
  assert.deepEqual(menu.get('src/server/Data/PlayerData.luau')?.places, ['default.project.json', 'menu.project.json'])
  assert.deepEqual(menu.get('src/server/Config/Admins.luau')?.places, ['default.project.json', 'menu.project.json'])
  assert.deepEqual(menu.get('src/skills/Definitions/Dash.luau')?.places, ['default.project.json', 'menu.project.json'])
  assert.deepEqual(menu.get('src/menu/server/QueueHandler.server.luau')?.places, ['menu.project.json'])

  // Switching back rebuilds the tree for the match place.
  const change = await project.setActivePlace('default.project.json')
  assert.equal(change.places, true)
  assert.equal(change.tree, true)
  const match = scriptsByPath(project)
  assert.ok(match.has('src/server/Data/PlayerData.luau'))
  assert.ok(match.has('src/server/Handlers/CombatHandler.server.luau'))
  assert.deepEqual(match.get('src/server/Handlers/CombatHandler.server.luau')?.places, ['default.project.json'])
  await assert.rejects(project.setActivePlace('nope.project.json'))
})

test("the active place's own sourcemap is used when present", async () => {
  const root = copyFixture()
  write(root, '.studio-sync/sourcemap.menu.json', JSON.stringify({
    name: 'FsfLike',
    className: 'DataModel',
    children: [{ name: 'ReplicatedFirst', className: 'ReplicatedFirst', children: [
      { name: 'FromSourcemap', className: 'LocalScript', filePaths: ['src/menu/first/Loading.client.luau'] }
    ] }]
  }))
  // The default place's sourcemap must not leak into the menu place.
  write(root, 'sourcemap.json', JSON.stringify({ name: 'FsfLike', className: 'DataModel', children: [{ name: 'Workspace', className: 'Workspace' }] }))
  const project = await open(root, 'menu.project.json')
  assert.equal(find(project.tree, ['ReplicatedFirst', 'FromSourcemap'])?.filePath, 'src/menu/first/Loading.client.luau')
  assert.equal(find(project.tree, ['Workspace']), undefined)
  await project.setActivePlace('default.project.json')
  assert.ok(find(project.tree, ['Workspace']))
})

test('a remembered place that no longer exists falls back to the default place', async () => {
  const project = await open(copyFixture(), 'removed.project.json')
  assert.equal(project.activePlace, 'default.project.json')
})

test('categorizes handlers, protocols, skills, stories and tests', async () => {
  const project = await open(copyFixture())
  const byPath = scriptsByPath(project)
  const expect = (path: string, category: string, feature?: string) => {
    const entry = byPath.get(path)
    assert.ok(entry, `missing ${path}`)
    assert.equal(entry.category, category, path)
    assert.equal(entry.feature, feature, path)
  }
  expect('src/server/Handlers/CombatHandler.server.luau', 'Handlers')
  expect('src/shared/Modules/CombatProtocol.luau', 'Protocols')
  expect('src/shared/Modules/Util.luau', 'Modules')
  expect('src/skills/Definitions/Dash.luau', 'Skills')
  expect('src/skills/Client/init.luau', 'Skills')
  expect('src/skills/Server/Moves/Dash/init.luau', 'Skills', 'Dash')
  expect('src/skills/Server/Moves/Dash/Hitbox.luau', 'Skills', 'Dash')
  expect('src/shared/Interface/Hud.story.luau', 'Stories')
  expect('src/shared/Interface/Match.storybook.luau', 'Stories')
  expect('src/shared/Interface/HudApp.luau', 'UI')
  expect('src/server/Bootstrapper.server.luau', 'Entry points')
  expect('src/server/Data/PlayerData.luau', 'Data')
  expect('src/shared/events/client.luau', 'Events')
  assert.deepEqual(project.scripts.map((g) => g.category), [
    'Data', 'Services', 'Handlers', 'Skills', 'Modules', 'Protocols', 'Events', 'UI', 'Stories', 'Entry points', 'Other'
  ])

  const base = { instancePath: [], realm: 'server' as const }
  assert.equal(categorize({ ...base, path: 'tests/Combat.spec.luau', name: 'Combat.spec', kind: 'ModuleScript' }), 'Tests')
  assert.equal(categorize({ ...base, path: 'src/menu/server/QueueHandler.server.luau', name: 'QueueHandler', kind: 'Script' }), 'Handlers')
  assert.equal(categorize({ ...base, path: 'src/server/Features/Foo/FooHandler.luau', name: 'FooHandler', kind: 'ModuleScript' }), 'Services')
  assert.equal(categorize({ ...base, path: 'src/x/Thing.luau', name: 'Thing', kind: 'ModuleScript', instancePath: ['ReplicatedStorage', 'Shared', 'Skills', 'Thing'] }), 'Skills')
})

// ---------------------------------------------------------------- multi-place blink + rojo

test('every root *.blink file is its own Blink model with its own outputs', async () => {
  const root = copyFixture()
  assert.deepEqual(await discoverBlinkFiles(root), ['events.blink', 'menu.blink'])
  const models = await loadBlinkModels(root)
  assert.deepEqual(models.map((l) => l.model.file), ['events.blink', 'menu.blink'])
  const [match, menu] = models.map((l) => l.model)
  assert.deepEqual(match.events.map((e) => e.name), ['Damage'])
  assert.deepEqual(match.outputs, { client: 'src/shared/events/client.luau', server: 'src/server/events/server.luau' })
  assert.deepEqual(match.requirePaths, { client: 'ReplicatedStorage.Shared.events.client', server: 'ServerScriptService.Server.events.server' })
  assert.deepEqual(menu.events.map((e) => e.name), ['JoinQueue', 'QueueUpdated'])
  assert.equal(menu.outputs?.client, 'src/menu/shared/events/client.luau')
  // Only menu.project.json maps the menu outputs.
  assert.deepEqual(menu.requirePaths, { client: 'ReplicatedStorage.Shared.events.client', server: 'ReplicatedStorage.Shared.events.server' })
  // listEvents without an entry spans every file; with one it stays per file.
  assert.deepEqual((await listEvents(root)).map((e) => `${e.file}:${e.name}`), ['events.blink:Damage', 'menu.blink:JoinQueue', 'menu.blink:QueueUpdated'])
  assert.deepEqual((await listEvents(root, 'menu.blink')).map((e) => e.name), ['JoinQueue', 'QueueUpdated'])
})

test('an entry imported by another root entry is not its own model', async () => {
  const root = copyFixture()
  write(root, 'common.blink', 'event Ping {\n    From: Client,\n    Type: Reliable,\n    Call: SingleSync\n}\n')
  write(root, 'menu.blink', 'import "./common"\n' + (await import('node:fs')).readFileSync(join(FIXTURE, 'menu.blink'), 'utf8'))
  const models = await loadBlinkModels(root)
  assert.deepEqual(models.map((l) => l.model.file), ['events.blink', 'menu.blink'])
})

test('watcher checks each blink file and groups the models by file', async () => {
  const root = copyFixture()
  const checked: string[] = []
  const lines: string[] = []
  const models: BlinkModel[] = []
  const watcher = new BlinkWatcher({
    root,
    debounceMs: 20,
    log: (line) => lines.push(line.text),
    onChange: (model) => models.push(model),
    check: async (_root, options) => {
      checked.push(options?.entry ?? '')
      return options?.entry === 'menu.blink'
        ? { ok: false, diagnostics: [{ file: 'menu.blink', line: 4, column: 5, message: 'bad', severity: 'error' }] }
        : { ok: true, diagnostics: [] }
    }
  })
  try {
    const model = await watcher.start()
    assert.deepEqual(checked, ['events.blink', 'menu.blink'])
    // Backward compatible top level: events.blink.
    assert.equal(model.file, 'events.blink')
    assert.deepEqual(model.events.map((e) => e.name), ['Damage'])
    assert.deepEqual(model.diagnostics, [])
    assert.deepEqual(model.files?.map((m) => [m.file, m.events.length, m.diagnostics.length, m.checking]), [
      ['events.blink', 1, 0, false],
      ['menu.blink', 2, 1, false]
    ])
    assert.ok(lines.includes('[blink] events.blink OK (1 event/function)'))
    assert.ok(lines.includes('[blink] menu.blink:4:5: bad'))
    // A new root .blink file becomes an entry.
    write(root, 'lobby.blink', 'event Hello {\n    From: Server,\n    Type: Reliable,\n    Call: SingleSync\n}\n')
    for (let k = 0; k < 100 && !(watcher.model.files?.length === 3 && !watcher.model.files.some((m) => m.checking)); k++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.deepEqual(watcher.model.files?.map((m) => m.file), ['events.blink', 'lobby.blink', 'menu.blink'])
  } finally {
    watcher.close()
  }
})

test('rojo serves the active place on its port, optionally every place', async () => {
  const places = await discoverPlaces(copyFixture())
  const def = rojoJobs(places, 'default.project.json', false)
  assert.deepEqual(def.jobs.map((j) => [j.key, j.args.join(' ')]), [['rojo', 'serve default.project.json --port 34872']])
  const menu = rojoJobs(places, 'menu.project.json', false)
  assert.deepEqual(menu.jobs.map((j) => [j.key, j.args.join(' ')]), [
    ['rojo', 'serve menu.project.json --port 34875'],
    ['sourcemap:menu.project.json', 'sourcemap menu.project.json --output .studio-sync/sourcemap.menu.json --watch --include-non-scripts']
  ])
  const all = rojoJobs(places, 'default.project.json', true)
  assert.deepEqual(all.jobs.map((j) => [j.key, j.port]), [['rojo', 34872], ['rojo:menu.project.json', 34875]])
  // Two places on the same port: the second is skipped, not double-served.
  const clash = rojoJobs([...places, { ...places[1], file: 'lab.project.json', name: 'lab', servePort: 34875 }], 'default.project.json', true)
  assert.deepEqual(clash.jobs.map((j) => j.key), ['rojo', 'rojo:menu.project.json'])
  assert.match(clash.skipped[0], /lab\.project\.json: port 34875/)
  // No places known (older callers): the old command.
  assert.deepEqual(rojoJobs([], null, false).jobs[0].args, ['serve', 'default.project.json'])
})

test('lsp bridge points luau-lsp at the active place sourcemap', () => {
  const bridge = new LspBridge({
    spawn: () => null,
    send: () => undefined,
    log: () => undefined,
    cacheDir: tmpdir(),
    types: { ensure: async () => ({ definitions: null, docs: null }) }
  })
  const answer = { jsonrpc: '2.0', id: 7, result: [{ platform: { type: 'roblox' }, sourcemap: { enabled: true, rojoProjectFile: 'default.project.json', sourcemapFile: 'sourcemap.json' } }] }
  const patch = (m: unknown) => (bridge as unknown as { patchConfig(m: unknown): any }).patchConfig(m)
  assert.deepEqual(patch(answer), answer, 'no place set: untouched')
  bridge.setPlace('menu.project.json', '.studio-sync/sourcemap.menu.json')
  const patched = patch(answer)
  assert.deepEqual(patched.result[0].sourcemap, { enabled: true, rojoProjectFile: 'menu.project.json', sourcemapFile: '.studio-sync/sourcemap.menu.json' })
  assert.deepEqual(patched.result[0].platform, { type: 'roblox' })
  bridge.dispose()
})
