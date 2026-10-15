// The real Forge Bridge plugin (resources/studio/ForgeBridge.luau) run under Lune in a small fake Studio
// (test/fixtures/forgeBridgeStudio.luau), talking to Forge's real bridge + SyncService + SyncEngine
// over HTTP, on a fresh GenTree-shaped project in an unpublished place (PlaceId 0, "Place1").
// Skipped when Lune is not installed (set LUNE_PATH).

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { StudioBridge } from '../src/main/services/studio/bridge.ts'
import { SyncEngine } from '../src/main/services/sync/engine.ts'
import { loadPlaces, placeFor } from '../src/main/services/sync/mapping.ts'
import { SyncService } from '../src/main/services/sync/service.ts'
import { deleteInStudio, deleteJob } from '../src/main/services/studio/deleteInstance.ts'
import { findLune } from '../src/main/services/tests/lune.ts'
import { pluginSource } from '../src/shared/studio/plugin.ts'
import { linkPlaces } from './syncFixture.ts'
import type { SyncStatus } from '../src/shared/sync/types.ts'

const lune = process.env.LUNE_PATH || findLune()
const skip = lune ? false : 'Lune not installed (set LUNE_PATH)'
const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

// The GenTree template's layout (default.project.json, tools/studio-sync.json, the empty client script).
function gentree(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-gentree-'))
  dirs.push(root)
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  put(
    'default.project.json',
    JSON.stringify({
      name: 'GenTree',
      tree: {
        $className: 'DataModel',
        ReplicatedStorage: { Shared: { $path: 'src/shared', $ignoreUnknownInstances: true }, Packages: { $path: 'Packages' } },
        ServerScriptService: { Server: { $path: 'src/server', $ignoreUnknownInstances: true } },
        ServerStorage: { $path: 'src/ServerStorage', $ignoreUnknownInstances: true },
        StarterPlayer: { StarterPlayerScripts: { Client: { $path: 'src/client', $ignoreUnknownInstances: true } } }
      }
    })
  )
  put('tools/studio-sync.json', JSON.stringify({ port: 34873, placeIds: [], skip: ['Packages', 'src/ServerStorage'] }))
  put('src/client/Client/init.client.luau', '')
  put('src/client/Client/Controllers/.gitkeep', '')
  put('src/shared/Modules/ModuleLoader.luau', 'return {}\n')
  put('src/server/Features/.gitkeep', '')
  return root
}

interface During {
  bridge: StudioBridge
  service: SyncService
  trees: string[][]
  // Drops a marker file the fake Studio's scenario waits for (waitForMarker).
  mark: (name: string) => void
}

// The link id an already linked place keeps in ServerStorage.ForgeSyncLink.
const LINK = 'link-0001-place1'

async function runStudio(scenario: string, during?: (env: During) => Promise<void>, opts: { linked?: boolean } = {}): Promise<{ root: string; out: string; status: SyncStatus; trees: string[][]; final: string[] }> {
  const root = gentree()
  const linked = opts.linked !== false
  if (linked) linkPlaces(root, { [`local:${LINK}`]: 'default.project.json' })
  const service = new SyncService({
    root,
    engine: new SyncEngine({ root }),
    mapping: { loadPlaces, placeFor },
    settings: { get: <T>(_k: string, fb: T) => fb },
    git: async () => ({ code: 1, stdout: '', stderr: '' }),
    pluginsDir: () => null,
    emit: () => undefined
  })
  await service.start()
  const bridge = new StudioBridge({ port: 0, holdMs: 200 })
  await bridge.start()
  // Every outline the plugin posts, as the Game tab sees it (live tree paths, joined with dots).
  const trees: string[][] = []
  const paths = () => (service.liveTree(join(root, 'default.project.json')) ?? service.liveTree('default.project.json'))?.nodes.map((n) => n.path.join('.')).sort() ?? []
  bridge.setSyncHandler({
    ...service.handler,
    outline: async (body) => {
      const answer = await service.handler.outline!(body)
      trees.push(paths())
      return answer
    }
  })
  try {
    const dir = mkdtempSync(join(tmpdir(), 'forge-plugin-run-'))
    dirs.push(dir)
    const template = readFileSync(resolve(import.meta.dirname, '..', 'resources', 'studio', 'ForgeBridge.luau'), 'utf8')
    writeFileSync(join(dir, 'ForgeBridge.luau'), pluginSource(template, { port: bridge.port }))
    const harness = resolve(import.meta.dirname, 'fixtures', 'forgeBridgeStudio.luau')
    const run = new Promise<string>((res, rej) =>
      execFile(lune!, ['run', harness, join(dir, 'ForgeBridge.luau'), scenario, linked ? LINK : ''], { cwd: dir, timeout: 60_000 }, (err, stdout, stderr) => (err ? rej(new Error(`${err.message}\n${stdout}\n${stderr}`)) : res(stdout + stderr)))
    )
    const mark = (name: string) => writeFileSync(join(dir, name), '')
    const [out] = await Promise.all([run, during?.({ bridge, service, trees, mark })])
    assert.match(out, /SCENARIO DONE/, out)
    return { root, out, status: await service.status(), trees, final: paths() }
  } finally {
    await bridge.stop()
    service.close()
  }
}

test('plugin: mapped folders Rojo builds after the bridge started are synced (fresh unpublished place)', { skip }, async () => {
  const { root, out, status } = await runStudio('late-root')
  assert.match(out, /not in Studio yet/, out)
  assert.match(out, /StarterPlayer\.StarterPlayerScripts\.Client is in Studio now/, out)
  // The edit typed into StarterPlayerScripts.Client.Client reached init.client.luau.
  assert.equal(readFileSync(join(root, 'src/client/Client/init.client.luau'), 'utf8'), 'adawdawdawd\n', out)
  // A script created in Studio under a mapped folder became a file.
  assert.ok(existsSync(join(root, 'src/client/Client/Controllers/Shop.luau')), out)
  assert.equal(readFileSync(join(root, 'src/client/Client/Controllers/Shop.luau'), 'utf8'), 'return {}\n')
  const place = status.places.find((p) => p.placeKey === `local:${LINK}`)
  assert.ok(place, JSON.stringify(status.places))
  assert.equal(place.gate, 'clear')
})

test('plugin: Script Editor text in an unpublished place syncs without a Source change', { skip }, async () => {
  const { root, out } = await runStudio('editor-only')
  assert.equal(readFileSync(join(root, 'src/client/Client/init.client.luau'), 'utf8'), 'print("typed")\n', out)
})

test('plugin: Studio-only instances deleted in Studio leave the Game tab outline', { skip }, async () => {
  const { out, trees, final } = await runStudio('outline-removal')
  assert.ok(
    trees.some((t) => t.includes('StarterPlayer.StarterPlayerScripts.LocalScript') && t.includes('StarterPlayer.StarterCharacterScripts.Health')),
    `${out}\n${JSON.stringify(trees)}`
  )
  assert.ok(!final.includes('StarterPlayer.StarterPlayerScripts.LocalScript'), `${out}\n${JSON.stringify(final)}`)
  assert.ok(!final.includes('StarterPlayer.StarterCharacterScripts.Health'), `${out}\n${JSON.stringify(final)}`)
  // The mapped folder and the default container stay.
  assert.ok(final.includes('StarterPlayer.StarterPlayerScripts.Client'), JSON.stringify(final))
  assert.ok(final.includes('StarterPlayer.StarterCharacterScripts'), JSON.stringify(final))
})

test('plugin: Delete in Studio removes a Studio-only instance undoably and refuses synced or ambiguous ones', { skip }, async () => {
  const refusals: Record<string, string> = {}
  let deleted = false
  const { out, final } = await runStudio('studio-delete', async ({ bridge, service, trees }) => {
    const until = Date.now() + 30_000
    while (!trees.some((t) => t.includes('StarterPlayer.StarterPlayerScripts.LocalScript')) && Date.now() < until) await new Promise((r) => setTimeout(r, 100))
    // Straight to the plugin (Forge's own checks skipped): the plugin refuses on its own.
    const pluginSays = async (key: string, path: string[], className?: string) => {
      try {
        await bridge.run(deleteJob(path, className), () => ({}), { acceptTimeoutMs: 10_000, timeoutMs: 15_000 })
        refusals[key] = 'deleted'
      } catch (e) {
        refusals[key] = (e as Error).message
      }
    }
    await pluginSays('root', ['StarterPlayer', 'StarterPlayerScripts', 'Client'])
    await pluginSays('inRoot', ['StarterPlayer', 'StarterPlayerScripts', 'Client', 'Client'])
    await pluginSays('holder', ['StarterPlayer', 'StarterPlayerScripts'])
    await pluginSays('default', ['StarterPlayer', 'StarterCharacterScripts'])
    await pluginSays('dup', ['ReplicatedStorage', 'Dup'])
    await pluginSays('service', ['ReplicatedStorage'])
    await pluginSays('stale', ['StarterPlayer', 'StarterPlayerScripts', 'LocalScript'], 'Script')
    await pluginSays('gone', ['StarterPlayer', 'StarterPlayerScripts', 'Nope'])
    // Forge's own refusal (project mapping) before anything reaches Studio.
    const deps = { bridge, refusal: (p: string[]) => service.deleteRefusal('default.project.json', p) }
    await assert.rejects(deleteInStudio(deps, ['StarterPlayer', 'StarterPlayerScripts']), /holds StarterPlayer\.StarterPlayerScripts\.Client/)
    await deleteInStudio(deps, ['StarterPlayer', 'StarterPlayerScripts', 'LocalScript'], 'LocalScript')
    deleted = true
  })
  assert.ok(deleted, out)
  assert.match(refusals.root, /synced to a file/, JSON.stringify(refusals))
  assert.match(refusals.inRoot, /synced to a file/, JSON.stringify(refusals))
  assert.match(refusals.holder, /holds StarterPlayer\.StarterPlayerScripts\.Client/, JSON.stringify(refusals))
  assert.match(refusals.default, /default StarterCharacterScripts container/, JSON.stringify(refusals))
  assert.match(refusals.dup, /2 instances named ReplicatedStorage\.Dup/, JSON.stringify(refusals))
  assert.match(refusals.service, /is a service/, JSON.stringify(refusals))
  assert.match(refusals.stale, /is a LocalScript in Studio now, not a Script/, JSON.stringify(refusals))
  assert.match(refusals.gone, /not in Studio/, JSON.stringify(refusals))
  assert.match(out, /LOOSE DELETED/, out)
  // One recording, committed: Ctrl+Z in Studio restores it. Refusals record nothing.
  assert.equal(out.match(/RECORDING /g)?.length, 1, out)
  assert.match(out, /RECORDING Commit Forge: delete LocalScript/, out)
  // The Game tab dropped it (and its child) right away.
  assert.ok(!final.some((p) => p.startsWith('StarterPlayer.StarterPlayerScripts.LocalScript')), JSON.stringify(final))
  assert.ok(final.includes('ReplicatedStorage.Dup'), JSON.stringify(final))
})

// Every file under the project (but Forge's own .forge/ state) with its content.
function diskState(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (child === '.forge') continue
      if (e.isDirectory()) walk(child)
      else out[child] = readFileSync(join(root, child), 'utf8')
    }
  }
  walk('')
  return out
}

async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

test('plugin: an unlinked place writes nothing and holds no conflicts (rojo serve waits for a linked check); once linked, its first sync waits for a side', { skip }, async () => {
  let before: Record<string, string> = {}
  let checked = false
  const { root, out } = await runStudio(
    'unlinked',
    async ({ service }) => {
      before = diskState(join(service.root))
      // The plugin connects and asks for sync: not linked, so it is listed, nothing else.
      const unlinked = await until('the unlinked place', async () => (await service.status()).unlinked?.[0])
      assert.equal(unlinked.name, 'Place1')
      assert.equal(unlinked.canLink, true)
      await new Promise((r) => setTimeout(r, 1500))
      let status = await service.status()
      // No conflicts or snapshot from it; the project's place waits for a linked check, saying why.
      assert.ok(status.places.every((p) => p.gate === 'waiting' && p.waitReason === 'unlinked' && !p.conflicts && !p.lastSnapshot), JSON.stringify(status.places))
      assert.equal(service.gateFor('default.project.json').gate, 'waiting')
      assert.match(service.gateFor('default.project.json').detail ?? '', /Studio has "Place1" open, but it isn't linked to this project/)
      assert.deepEqual(service.conflicts(), [])
      assert.deepEqual(diskState(service.root), before)
      // No base state for any place either.
      const index = join(service.root, '.forge', 'sync', 'index.json')
      assert.deepEqual(existsSync(index) ? JSON.parse(readFileSync(index, 'utf8')).places : {}, {})
      // Link it: the plugin stores the link id in the place and starts the first sync.
      await service.linkPlace(unlinked.id)
      const place = await until('the linked place held for the first-sync choice', async () => (await service.status()).places.find((p) => p.placeKey.startsWith('local:') && p.gate === 'blocked'))
      const first = service.conflicts().filter((c) => c.placeKey === place.placeKey)
      assert.ok(first.length >= 2 && first.every((c) => c.reason === 'first-run'), JSON.stringify(first.map((c) => [c.file, c.reason])))
      assert.ok(first.some((c) => c.file === 'src/client/Client/Controllers/Shop.luau'), 'a Studio-only script waits too')
      // Still nothing written or trashed before the decision.
      assert.deepEqual(diskState(service.root), before)
      await service.resolveAll(place.placeKey, 'studio', 'first-run')
      assert.equal(readFileSync(join(service.root, 'src/client/Client/Controllers/Shop.luau'), 'utf8'), 'return { vfx = true }\n')
      assert.equal(readFileSync(join(service.root, 'src/client/Client/init.client.luau'), 'utf8'), 'print("vfx place")\n')
      status = await service.status()
      assert.equal(status.places.find((p) => p.placeKey === place.placeKey)?.gate, 'clear')
      checked = true
    },
    { linked: false }
  )
  assert.ok(checked, out)
  assert.match(out, /SET ATTRIBUTE ServerStorage\.ForgeSyncLink = /, out)
  assert.match(out, /now linked to the Forge project/, out)
  const links = JSON.parse(readFileSync(join(root, '.forge', 'sync', 'links.json'), 'utf8'))
  assert.deepEqual(Object.values(links.links).map((l: any) => l.projectFile), ['default.project.json'])
})

const ONBOARDING_DIR = 'src/client/Client/Controllers/OnboardingController'
const CUTSCENE_FILES = [
  'init.luau',
  'TrainerCutscene/init.luau',
  'TrainerCutscene/Shots.luau',
  'TrainerCutscene/Body.luau',
  'WakeUpCutscene/init.luau',
  ...['Body', 'Lens', 'Motion', 'Overlay', 'Sfx', 'Title'].map((n) => `WakeUpCutscene/${n}.luau`),
  'WakeUpCutscene/Props/init.luau',
  'WakeUpCutscene/Props/Toon.luau'
].map((f) => `${ONBOARDING_DIR}/${f}`)

// Bug report (GenTree, 0.6.1-quick.7): Studio had OnboardingController.WakeUpCutscene and its child
// modules, the disk did not, the gate was clear and Rojo's connect offered to delete WakeUpCutscene.
test('plugin: a Studio-only module tree holds rojo after "Disk wins" until Pull to disk; new children sync live', { skip }, async () => {
  let checked = false
  const { out } = await runStudio('cutscene', async ({ service, mark }) => {
    const key = `local:${LINK}`
    await until('the first sync held with every Studio-only script', async () => service.conflicts().filter((c) => c.placeKey === key && c.reason === 'first-run').length === CUTSCENE_FILES.length)
    for (const f of CUTSCENE_FILES) assert.ok(!existsSync(join(service.root, f)), f)
    // "Disk wins": the disk has none of them. Rojo stays held instead of offering to delete them.
    await service.resolveAll(key, 'disk', 'first-run')
    let place = (await service.status()).places.find((p) => p.placeKey === key)!
    assert.equal(place.gate, 'blocked')
    assert.deepEqual({ count: place.studioOnly?.count, pullable: place.studioOnly?.pullable, holds: place.studioOnly?.holds }, { count: CUTSCENE_FILES.length, pullable: CUTSCENE_FILES.length, holds: true })
    assert.match(service.gateFor('default.project.json').detail ?? '', /13 Studio-only scripts not on disk: pull to disk or serve anyway/)
    // "Pull to disk".
    place = (await service.pullStudioOnly(key)).places.find((p) => p.placeKey === key)!
    assert.equal(place.gate, 'clear')
    assert.equal(place.studioOnly, undefined)
    assert.equal(service.gateFor('default.project.json').gate, 'clear')
    for (const f of CUTSCENE_FILES) assert.ok(existsSync(join(service.root, f)), f)
    assert.equal(readFileSync(join(service.root, ONBOARDING_DIR, 'WakeUpCutscene/Props/Toon.luau'), 'utf8'), "return 'toon'\n")
    mark('pulled')
    // A child module added in Studio afterwards is written right away.
    await until('the live child', async () => existsSync(join(service.root, ONBOARDING_DIR, 'WakeUpCutscene/Vignette.luau')))
    assert.equal(service.gateFor('default.project.json').gate, 'clear')
    mark('vignette')
    checked = true
  })
  assert.ok(checked, out)
})

// Studio's Ctrl+D makes a same-name copy (children included); the user then renames it. The copy's
// subtree must land under the new name, and the original must keep syncing.
test('plugin: Ctrl+D a cutscene module and rename the copy: both trees sync, deleting the copy leaves the original', { skip }, async () => {
  let checked = false
  const { out } = await runStudio('duplicate-rename', async ({ service, mark }) => {
    const key = `local:${LINK}`
    const read = (rel: string) => (existsSync(join(service.root, ONBOARDING_DIR, rel)) ? readFileSync(join(service.root, ONBOARDING_DIR, rel), 'utf8') : null)
    await until('the first sync', async () => service.conflicts().filter((c) => c.placeKey === key).length >= 4)
    await service.resolveAll(key, 'studio', 'first-run')
    mark('synced')
    await until('the renamed copy with its edited child and a new child', async () =>  read('WakeUpCutscene/Body.luau') === "return 'wake body'\n" && read('WakeUpCutscene/Lens.luau') !== null && read('TrainerCutscene/Shots.luau') === "return 'trainer shots 2'\n")
    assert.equal(read('WakeUpCutscene/init.luau'), "return 'trainer'\n")
    assert.equal(read('WakeUpCutscene/Shots.luau'), "return 'shots'\n")
    assert.equal(read('TrainerCutscene/Body.luau'), "return 'trainer body'\n")
    assert.equal(read('TrainerCutscene/init.luau'), "return 'trainer'\n")
    assert.equal(service.gateFor('default.project.json').gate, 'clear')
    mark('renamed')
    await until('the original edited after the copy is gone', async () => read('TrainerCutscene/Body.luau') === "return 'trainer body 2'\n" && read('WakeUpCutscene/init.luau') === null)
    assert.equal(read('TrainerCutscene/Shots.luau'), "return 'trainer shots 2'\n")
    assert.equal((await service.status()).places.find((p) => p.placeKey === key)?.studioOnly, undefined)
    mark('deleted')
    checked = true
  })
  assert.ok(checked, out)
})
