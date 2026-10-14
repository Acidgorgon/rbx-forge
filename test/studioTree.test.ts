// Game tab from Forge Sync's live Studio tree, and "Save to repo" for Studio-only instances, on a
// project mapped like the GenTree template (MyTemplate-Legacy default.project.json): ReplicatedStorage
// itself has no $path (only Shared and Packages do), ServerStorage is a $path root with
// $ignoreUnknownInstances. Plays the Forge Bridge plugin over HTTP.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { StudioBridge } from '../src/main/services/studio/bridge.ts'
import { SyncEngine } from '../src/main/services/sync/engine.ts'
import { loadPlaces, NOT_UNDER_PATH, placeFor, saveTarget, type DiskProbe, type PlaceMap } from '../src/main/services/sync/mapping.ts'
import { outlineContainers, outsideTops, SyncService } from '../src/main/services/sync/service.ts'
import { mergeStudioTree, Project, studioTreeFromLive, type HarnessTreeNode } from '../src/main/services/project.ts'
import { parseOutlineBody, sanitizeConfig, SyncProtocolError } from '../src/shared/sync/protocol.ts'
import type { StudioNode, SyncEntry, SyncStatus } from '../src/shared/sync/types.ts'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

const GENTREE = {
  name: 'GenTree',
  tree: {
    $className: 'DataModel',
    ReplicatedStorage: { Shared: { $path: 'src/shared', $ignoreUnknownInstances: true }, Packages: { $path: 'Packages' } },
    ServerScriptService: { Server: { $path: 'src/server', $ignoreUnknownInstances: true } },
    ServerStorage: { $path: 'src/ServerStorage', $ignoreUnknownInstances: true },
    StarterPlayer: { StarterPlayerScripts: { Client: { $path: 'src/client', $ignoreUnknownInstances: true } } }
  }
}

function gentree(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-studiotree-'))
  dirs.push(root)
  put(root, 'default.project.json', JSON.stringify(GENTREE, null, 2))
  put(root, 'src/shared/Util.luau', 'return {}\n')
  put(root, 'src/server/Main.server.luau', 'print("server")\n')
  put(root, 'src/client/Main.client.luau', 'print("client")\n')
  put(root, 'src/ServerStorage/Templates/Spawn.model.json', JSON.stringify({ className: 'Model', children: [{ name: 'Base', className: 'Part' }] }))
  mkdirSync(join(root, 'Packages'), { recursive: true })
  return root
}

let nextId = 0
const n = (path: string[], className: string, extra: Partial<StudioNode> = {}): StudioNode => ({ id: String(++nextId), path, className, ...extra })

// What the plugin's snapshot holds for the GenTree place: the mapped roots only.
function snapshotNodes(): StudioNode[] {
  return [
    n(['ReplicatedStorage', 'Shared'], 'Folder'),
    n(['ReplicatedStorage', 'Shared', 'Util'], 'ModuleScript', { source: 'return {}\n' }),
    n(['ServerScriptService', 'Server'], 'Folder'),
    n(['ServerScriptService', 'Server', 'Main'], 'Script', { source: 'print("server")\n' }),
    n(['ServerStorage'], 'ServerStorage'),
    n(['ServerStorage', 'Templates'], 'Folder'),
    n(['ServerStorage', 'Templates', 'Spawn'], 'Model'),
    n(['ServerStorage', 'Templates', 'Spawn', 'Base'], 'Part'),
    // Studio-only under an $ignoreUnknownInstances root: left in Studio.
    n(['ServerStorage', 'Maps'], 'Model', { properties: { LevelOfDetail: { Enum: 0 } } }),
    n(['ServerStorage', 'Maps', 'Floor'], 'Part', { properties: { Anchored: true } }),
    n(['StarterPlayer', 'StarterPlayerScripts', 'Client'], 'Folder'),
    n(['StarterPlayer', 'StarterPlayerScripts', 'Client', 'Main'], 'LocalScript', { source: 'print("client")\n' })
  ]
}

// The plugin's outline of the mapped services outside the roots (Acid's Animation is here).
const OUTLINE = [
  { path: ['ReplicatedStorage', 'Assets'], className: 'Folder' },
  { path: ['ReplicatedStorage', 'Assets', 'Animations'], className: 'Folder' },
  { path: ['ReplicatedStorage', 'Assets', 'Animations', 'Animation'], className: 'Animation', props: { AnimationId: 'rbxassetid://123' } },
  { path: ['StarterPlayer', 'StarterPlayerScripts'], className: 'StarterPlayerScripts' },
  { path: ['StarterPlayer', 'StarterCharacterScripts'], className: 'StarterCharacterScripts' }
]

async function setup() {
  const root = gentree()
  const trees: number[] = []
  const entries: SyncEntry[][] = []
  const logs: string[] = []
  const service = new SyncService({
    root,
    engine: new SyncEngine({ root }),
    mapping: { loadPlaces, placeFor },
    settings: { get: <T>(_k: string, fb: T) => fb },
    git: async () => ({ code: 1, stdout: '', stderr: 'no git' }),
    pluginsDir: () => null,
    emit: (event, payload) => {
      if (event === 'sync:entry') entries.push(payload as SyncEntry[])
    },
    log: (text) => logs.push(text),
    onStudioTree: () => trees.push(Date.now()),
    treeThrottleMs: 0
  })
  await service.start()
  const bridge = new StudioBridge({ port: 0, holdMs: 50 })
  await bridge.start()
  bridge.setSyncHandler(service.handler)
  const base = `http://127.0.0.1:${bridge.port}/forge-bridge/sync`
  const post = async (route: string, body: unknown) => (await (await fetch(`${base}/${route}`, { method: 'POST', body: JSON.stringify(body) })).json()) as { ok: boolean; error?: string }
  const config = (await (await fetch(`${base}/config?placeId=555&gameId=9&place=GenTree`)).json()) as { enabled: boolean; sessionToken: string; outline?: string[][]; outlineMax?: number }
  const place = { placeId: 555, gameId: 9 }
  const project = await Project.open(root)
  project.setLiveStudio((file) => service.liveTree(file))
  return {
    root,
    service,
    project,
    config,
    trees,
    entries,
    logs,
    snapshot: (nodes: StudioNode[]) => post('snapshot', { session: config.sessionToken, place, seq: 0, final: true, nodes }),
    outline: (nodes: unknown[], truncated = false) => post('outline', { session: config.sessionToken, place, nodes, truncated }),
    changes: (changes: unknown[]) => post('changes', { session: config.sessionToken, place, changes }),
    close: async () => {
      service.close()
      project.close()
      await bridge.stop()
    }
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function find(nodes: HarnessTreeNode[], path: string[]): HarnessTreeNode | undefined {
  let list = nodes
  let hit: HarnessTreeNode | undefined
  for (const name of path) {
    hit = list.find((x) => x.name === name)
    if (!hit) return undefined
    list = hit.children as HarnessTreeNode[]
  }
  return hit
}

test('GenTree: the Game tab shows ReplicatedStorage.Assets.Animations.Animation from the live Studio tree', async () => {
  const t = await setup()
  try {
    assert.equal(t.config.enabled, true)
    // Only the services the project maps are outlined (no Workspace, Lighting ...).
    assert.deepEqual(t.config.outline, [['ReplicatedStorage'], ['ServerScriptService'], ['ServerStorage'], ['StarterPlayer']])
    assert.equal(t.config.outlineMax, 3000)
    assert.deepEqual(await t.snapshot(snapshotNodes()), { ok: true })
    assert.deepEqual(await t.outline(OUTLINE), { ok: true })
    await wait(20)
    assert.ok(t.trees.length >= 1, 'the Game tab is told to rebuild')

    const live = t.service.liveTree('default.project.json')
    assert.ok(live)
    assert.ok(live.nodes.some((x) => x.path.join('.') === 'ReplicatedStorage.Assets.Animations.Animation'))
    // No script sources travel to the Game tab.
    assert.ok(live.nodes.every((x) => !('source' in x)))

    await t.project.refresh()
    const anim = find(t.project.tree, ['ReplicatedStorage', 'Assets', 'Animations', 'Animation'])
    assert.equal(anim?.origin, 'studio')
    assert.equal(anim?.className, 'Animation')
    assert.equal(anim?.props?.AnimationId, 'rbxassetid://123')
    assert.equal(find(t.project.tree, ['ReplicatedStorage', 'Shared'])?.origin, 'both')
    assert.equal(find(t.project.tree, ['ServerStorage', 'Maps'])?.origin, 'studio')
    // A repo .model.json merges with Studio (not Studio-only).
    assert.equal(find(t.project.tree, ['ServerStorage', 'Templates', 'Spawn'])?.origin, 'both')
    assert.equal(find(t.project.tree, ['ServerStorage', 'Templates', 'Spawn', 'Base'])?.origin, 'both')

    // An unchanged outline resend and a script edit do not rebuild the tree.
    const before = t.trees.length
    assert.deepEqual(await t.outline(OUTLINE), { ok: true })
    assert.deepEqual(await t.changes([{ kind: 'source', node: { id: '2', path: ['ReplicatedStorage', 'Shared', 'Util'], className: 'ModuleScript', source: 'return { x = 1 }\n' } }]), { ok: true })
    await wait(20)
    assert.equal(t.trees.length, before)

    // One line on what stays in Studio, and why.
    const status: SyncStatus = await t.service.status()
    const left = status.places.find((p) => p.projectFile === 'default.project.json')?.leftInStudio
    assert.ok(left)
    assert.equal(left.count, 2)
    assert.match(left.note, /ReplicatedStorage\.Assets/)
    assert.match(left.note, /ServerStorage\.Maps/)
    assert.match(left.note, /1 outside every Rojo \$path, 1 under \$ignoreUnknownInstances/)
    assert.ok(t.logs.some((l) => l.includes('stays in Studio') || l.includes('stay in Studio')))
  } finally {
    await t.close()
  }
})

test('Save to repo: refused outside a $path, writes a .model.json under an $ignoreUnknownInstances root', async () => {
  const t = await setup()
  try {
    await t.snapshot(snapshotNodes())
    await t.outline(OUTLINE)
    // Acid's case: ReplicatedStorage has no $path in GenTree.
    assert.deepEqual(await t.service.saveTarget('default.project.json', ['ReplicatedStorage', 'Assets', 'Animations', 'Animation']), { reason: NOT_UNDER_PATH })
    await assert.rejects(t.service.saveToRepo('default.project.json', ['ReplicatedStorage', 'Assets']), /Not under a Rojo \$path/)
    // A nested Studio-only instance: its Studio-only parent goes first.
    assert.match(String((await t.service.saveTarget('default.project.json', ['ServerStorage', 'Maps', 'Floor']) as { reason: string }).reason), /Maps is Studio-only too/)

    assert.deepEqual(await t.service.saveTarget('default.project.json', ['ServerStorage', 'Maps']), { file: 'src/ServerStorage/Maps.model.json', className: 'Model' })
    const entry = await t.service.saveToRepo('default.project.json', ['ServerStorage', 'Maps'])
    assert.equal(entry.file, 'src/ServerStorage/Maps.model.json')
    assert.equal(entry.action, 'created')
    const model = JSON.parse(readFileSync(join(t.root, 'src/ServerStorage/Maps.model.json'), 'utf8'))
    assert.equal(model.className, 'Model')
    assert.equal(model.children[0].name, 'Floor')
    assert.equal(model.children[0].properties.Anchored, true)
    assert.ok(t.entries.flat().some((e) => e.file === 'src/ServerStorage/Maps.model.json'))

    // Second time: already there. Next snapshot: same, nothing left in Studio there.
    assert.match(String((await t.service.saveTarget('default.project.json', ['ServerStorage', 'Maps']) as { reason: string }).reason), /Already in the repo/)
    await t.snapshot(snapshotNodes())
    const status = await t.service.status()
    assert.equal(status.places[0].leftInStudio?.count, 1)
    await t.project.refresh()
    assert.equal(find(t.project.tree, ['ServerStorage', 'Maps'])?.origin, 'both')
  } finally {
    await t.close()
  }
})

test('a new Studio-only instance under an $ignoreUnknownInstances root gets a one-line note in the feed', async () => {
  const t = await setup()
  try {
    await t.snapshot(snapshotNodes())
    t.entries.length = 0
    assert.deepEqual(await t.changes([{ kind: 'added', node: { id: 'sw', path: ['ServerStorage', 'Sword'], className: 'Tool' } }]), { ok: true })
    const shown = t.entries.flat()
    const left = shown.find((e) => e.instancePath.join('.') === 'ServerStorage.Sword')
    assert.ok(left, JSON.stringify(shown))
    assert.equal(left.action, 'unmapped')
    assert.match(left.note ?? '', /^left in Studio \(\$ignoreUnknownInstances\): .*Save to repo/)
    assert.equal(existsSync(join(t.root, 'src/ServerStorage/Sword.model.json')), false)
  } finally {
    await t.close()
  }
})

test('Game tab falls back to .studio-sync/tree.json without a live session', async () => {
  const root = gentree()
  put(root, '.studio-sync/tree.json', JSON.stringify({ roots: [{ name: 'ReplicatedStorage', className: 'ReplicatedStorage', children: [{ name: 'Assets', className: 'Folder' }] }] }))
  const project = await Project.open(root)
  try {
    project.setLiveStudio(() => null)
    await project.refresh()
    assert.equal(find(project.tree, ['ReplicatedStorage', 'Assets'])?.origin, 'studio')
    // Live wins once Studio is connected.
    project.setLiveStudio(() => ({ nodes: [{ path: ['ReplicatedStorage', 'Gear'], className: 'Folder' }] }))
    await project.refresh()
    assert.equal(find(project.tree, ['ReplicatedStorage', 'Gear'])?.origin, 'studio')
    assert.equal(find(project.tree, ['ReplicatedStorage', 'Assets']), undefined)
  } finally {
    project.close()
  }
})

test('studioTreeFromLive nests a flat list and fills in the services', () => {
  const tree = studioTreeFromLive([
    { path: ['ReplicatedStorage', 'Assets', 'Animations', 'Run'], className: 'Animation', props: { AnimationId: 'rbxassetid://1' } },
    { path: ['ReplicatedStorage', 'Assets'], className: 'Folder' },
    { path: ['ReplicatedStorage', 'Assets', 'Animations'], className: 'Configuration' },
    { path: ['Workspace', 'Baseplate'], className: 'Part' }
  ])
  assert.deepEqual(tree.map((x) => [x.name, x.className]), [['ReplicatedStorage', 'ReplicatedStorage'], ['Workspace', 'Workspace']])
  const anims = tree[0].children![0].children![0]
  assert.equal(anims.className, 'Configuration')
  assert.equal(anims.children![0].props?.AnimationId, 'rbxassetid://1')
  const merged = mergeStudioTree([{ name: 'ReplicatedStorage', className: 'ReplicatedStorage', children: [] }], tree)
  assert.equal(merged.find((x) => x.name === 'ReplicatedStorage')?.origin, 'both')
  assert.equal(merged.find((x) => x.name === 'ReplicatedStorage')?.children[0].origin, 'studio')
})

// ---- pure: mapping and protocol ----

async function gentreeMap(): Promise<PlaceMap> {
  const maps = await loadPlaces(gentree())
  return maps[0]
}

function probe(files: string[], dirsOnDisk: string[]): DiskProbe {
  return { isFile: (rel) => files.includes(rel), isDir: (rel) => dirsOnDisk.includes(rel) }
}

test('saveTarget: path resolution, Windows names and refusals', async () => {
  const map = await gentreeMap()
  const disk = probe(['src/ServerStorage/Taken.model.json', 'src/ServerStorage/Spawn.rbxm'], ['src/ServerStorage', 'src/ServerStorage/Templates', 'src/shared'])
  const at = (path: string[], className = 'Folder', extra: { hasScriptDescendants?: boolean } = {}) => saveTarget(map, { path, className, ...extra }, disk)
  assert.deepEqual(at(['ReplicatedStorage', 'Assets', 'Animations', 'Animation'], 'Animation'), { reason: NOT_UNDER_PATH })
  assert.deepEqual(at(['Workspace', 'Map']), { reason: NOT_UNDER_PATH })
  assert.deepEqual(at(['ServerStorage', 'Maps'], 'Model'), { file: 'src/ServerStorage/Maps.model.json' })
  assert.deepEqual(at(['ServerStorage', 'Templates', 'Sword'], 'Tool'), { file: 'src/ServerStorage/Templates/Sword.model.json' })
  assert.deepEqual(at(['ReplicatedStorage', 'Shared', 'Config'], 'Configuration'), { file: 'src/shared/Config.model.json' })
  // Names spaces and brackets are fine; Windows-reserved or illegal ones are not.
  assert.deepEqual(at(['ServerStorage', 'Sword [Gold]'], 'Tool'), { file: 'src/ServerStorage/Sword [Gold].model.json' })
  assert.match((at(['ServerStorage', 'CON'], 'Model') as { reason: string }).reason, /reserved file name on Windows/)
  assert.match((at(['ServerStorage', 'lpt1.txt'], 'Model') as { reason: string }).reason, /reserved file name on Windows/)
  assert.match((at(['ServerStorage', 'Boss: Phase 2'], 'Model') as { reason: string }).reason, /cannot be a file name/)
  assert.match((at(['ServerStorage', 'Trail.'], 'Model') as { reason: string }).reason, /trailing dot/)
  assert.match((at(['ServerStorage', 'Gun '], 'Model') as { reason: string }).reason, /trailing space/)
  assert.match((at(['ServerStorage', 'Taken'], 'Model') as { reason: string }).reason, /Already in the repo \(src\/ServerStorage\/Taken\.model\.json\)/)
  assert.match((at(['ServerStorage', 'Spawn'], 'Model') as { reason: string }).reason, /Already in the repo/)
  assert.match((at(['ServerStorage', 'Maps', 'Floor'], 'Part') as { reason: string }).reason, /ServerStorage\.Maps is Studio-only too|Maps is Studio-only too/)
  assert.match((at(['ReplicatedStorage', 'Packages', 'Promise'], 'ModuleScript') as { reason: string }).reason, /Scripts sync/)
  assert.match((at(['ReplicatedStorage', 'Packages', 'Promise']) as { reason: string }).reason, /never syncs/)
  assert.match((at(['ServerStorage'], 'ServerStorage') as { reason: string }).reason, /\$path root/)
  assert.match((at(['ServerStorage', 'Kit'], 'Folder', { hasScriptDescendants: true }) as { reason: string }).reason, /holds scripts/)
  // Another place file names itself in the hint.
  assert.equal((saveTarget({ ...map, projectFile: 'menu.project.json' }, { path: ['Lighting', 'Sky'], className: 'Sky' }, disk) as { reason: string }).reason, NOT_UNDER_PATH.replace('default.project.json', 'menu.project.json'))
})

test('outline containers and the Studio-only tops outside every $path', async () => {
  const map = await gentreeMap()
  assert.deepEqual(outlineContainers(map), [['ReplicatedStorage'], ['ServerScriptService'], ['ServerStorage'], ['StarterPlayer']])
  assert.deepEqual(
    outsideTops(map, OUTLINE).map((p) => p.join('.')),
    ['ReplicatedStorage.Assets']
  )
})

test('outline body validation and config pass-through', () => {
  const body = parseOutlineBody({ session: 's', place: { placeId: 1 }, nodes: OUTLINE, truncated: true })
  assert.equal(body.nodes.length, 5)
  assert.equal(body.truncated, true)
  assert.throws(() => parseOutlineBody({ session: 's', place: { placeId: 1 }, nodes: [{ path: ['A'], className: 'bad class' }] }), SyncProtocolError)
  assert.throws(() => parseOutlineBody({ session: 's', place: { placeId: 1 }, nodes: [{ path: [], className: 'Folder' }] }), SyncProtocolError)
  assert.throws(() => parseOutlineBody({ session: 's', place: { placeId: 1 }, nodes: [{ path: ['A'], className: 'Sound', props: { SoundId: 5 } }] }), SyncProtocolError)
  assert.throws(() => parseOutlineBody({ session: 's', place: { placeId: 1 }, nodes: Array.from({ length: 5001 }, () => ({ path: ['A'], className: 'Folder' })) }), SyncProtocolError)
  assert.deepEqual(sanitizeConfig({ enabled: true, sessionToken: 't', roots: [['A']], skip: [], outline: [['ReplicatedStorage']], outlineMax: 99999 }), { enabled: true, sessionToken: 't', roots: [['A']], skip: [], outline: [['ReplicatedStorage']], outlineMax: 5000 })
  assert.deepEqual(sanitizeConfig({ enabled: true, sessionToken: 't', roots: [], skip: [] }), { enabled: true, sessionToken: 't', roots: [], skip: [] })
})
