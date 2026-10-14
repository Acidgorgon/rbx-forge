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

async function runStudio(scenario: string): Promise<{ root: string; out: string; status: SyncStatus }> {
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
  bridge.setSyncHandler(service.handler)
  try {
    const dir = mkdtempSync(join(tmpdir(), 'forge-plugin-run-'))
    dirs.push(dir)
    const template = readFileSync(resolve(import.meta.dirname, '..', 'resources', 'studio', 'ForgeBridge.luau'), 'utf8')
    writeFileSync(join(dir, 'ForgeBridge.luau'), pluginSource(template, { port: bridge.port }))
    const harness = resolve(import.meta.dirname, 'fixtures', 'forgeBridgeStudio.luau')
    const out = await new Promise<string>((res, rej) =>
      execFile(lune!, ['run', harness, join(dir, 'ForgeBridge.luau'), scenario], { cwd: dir, timeout: 60_000 }, (err, stdout, stderr) => (err ? rej(new Error(`${err.message}\n${stdout}\n${stderr}`)) : res(stdout + stderr)))
    )
    assert.match(out, /SCENARIO DONE/, out)
    return { root, out, status: await service.status() }
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
