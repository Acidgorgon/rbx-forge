// The real Forge Bridge plugin (resources/studio/ForgeBridge.luau) run under Lune in a small fake Studio
// (test/fixtures/forgeBridgeStudio.luau), talking to Forge's real bridge + SyncService + SyncEngine
// over HTTP, on a fresh GenTree-shaped project in an unpublished place (PlaceId 0, "Place1").
// Skipped when Lune is not installed (set LUNE_PATH).

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
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
}

async function runStudio(scenario: string, during?: (env: During) => Promise<void>): Promise<{ root: string; out: string; status: SyncStatus; trees: string[][]; final: string[] }> {
  const root = gentree()
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
      execFile(lune!, ['run', harness, join(dir, 'ForgeBridge.luau'), scenario], { cwd: dir, timeout: 60_000 }, (err, stdout, stderr) => (err ? rej(new Error(`${err.message}\n${stdout}\n${stderr}`)) : res(stdout + stderr)))
    )
    const [out] = await Promise.all([run, during?.({ bridge, service, trees })])
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
  const place = status.places.find((p) => p.placeKey === 'unpublished:Place1')
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
