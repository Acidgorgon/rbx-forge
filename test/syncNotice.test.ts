// Forge Sync tells the user when Studio edits are NOT reaching disk, and why (SyncStatus.notice, the
// status bar summary). Real SyncEngine + mapping on a GenTree-shaped project, unpublished place.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { SyncEngine } from '../src/main/services/sync/engine.ts'
import { loadPlaces, placeFor } from '../src/main/services/sync/mapping.ts'
import { SyncService } from '../src/main/services/sync/service.ts'
import { syncSummary } from '../src/main/services/sync/wire.ts'
import { PLUGIN_VERSION } from '../src/shared/studio/plugin.ts'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function project(servePlaceIds?: number[]): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-notice-'))
  dirs.push(root)
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  put(
    'default.project.json',
    JSON.stringify({
      name: 'GenTree',
      ...(servePlaceIds ? { servePlaceIds } : {}),
      tree: {
        $className: 'DataModel',
        ReplicatedStorage: { Shared: { $path: 'src/shared', $ignoreUnknownInstances: true } },
        StarterPlayer: { StarterPlayerScripts: { Client: { $path: 'src/client', $ignoreUnknownInstances: true } } }
      }
    })
  )
  put('src/client/Client/init.client.luau', '')
  put('src/shared/A.luau', 'return 1\n')
  return root
}

type Studio = { placeId?: number; place?: string; pluginVersion?: number; connected: boolean } | null

async function make(opts: { root: string; studio: () => Studio; plugin?: { installed: boolean; version?: number } | null; now?: () => number }) {
  const service = new SyncService({
    root: opts.root,
    engine: new SyncEngine({ root: opts.root }),
    mapping: { loadPlaces, placeFor },
    settings: { get: <T>(_k: string, fb: T) => fb },
    git: async () => ({ code: 1, stdout: '', stderr: '' }),
    pluginsDir: () => null,
    studio: opts.studio,
    plugin: async () => (opts.plugin === undefined ? { installed: true, version: PLUGIN_VERSION } : opts.plugin),
    emit: () => undefined,
    now: opts.now
  })
  await service.start()
  return service
}

const place = { placeId: 0, gameId: 0, name: 'Place1' }
const LINK = 'link-0001-place1'

// The user linked the unpublished place in Source Control earlier (the plugin keeps LINK in the place).
function linkPlace(root: string): void {
  mkdirSync(join(root, '.forge', 'sync'), { recursive: true })
  writeFileSync(join(root, '.forge', 'sync', 'links.json'), JSON.stringify({ version: 1, links: { [`local:${LINK}`]: { projectFile: 'default.project.json', name: 'Place1', at: 1 } } }))
}

test('notice: no plugin installed -> install it (and the status bar is not green)', async () => {
  const service = await make({ root: project(), studio: () => null, plugin: { installed: false } })
  const status = await service.status()
  assert.equal(status.notice?.action, 'install-plugin')
  assert.match(status.notice!.text, /not installed/)
  assert.equal(syncSummary(status).state, 'starting')
  assert.match(syncSummary(status).detail, /not syncing/i)
  service.close()
})

test('notice: plugin installed but Studio never connected', async () => {
  const service = await make({ root: project(), studio: () => null })
  const status = await service.status()
  assert.equal(status.notice?.level, 'warn')
  assert.match(status.notice!.text, /no Forge Bridge plugin connected/)
  service.close()
})

test('notice: unpublished place whose mapped folders are not in Studio yet; connected via the bridge for PlaceId 0', async () => {
  let t = 1_000_000
  const studio: Studio = { placeId: undefined, place: 'Place1', pluginVersion: PLUGIN_VERSION, connected: true }
  const root = project()
  linkPlace(root)
  const service = await make({ root, studio: () => studio, now: () => t })
  const cfg = await service.handler.config({ placeId: 0, gameId: 0, place: 'Place1', link: LINK })
  assert.equal(cfg.enabled, true)
  assert.deepEqual((await service.handler.snapshot({ session: cfg.sessionToken, place, seq: 0, final: true, nodes: [] })).ok, true)
  t += 5 * 60_000 // long after the last sync request: still connected through the bridge
  let status = await service.status()
  const p = status.places.find((x) => x.placeKey === `local:${LINK}`)!
  assert.equal(p.connected, true)
  assert.deepEqual(p.missingRoots, ['ReplicatedStorage.Shared', 'StarterPlayer.StarterPlayerScripts.Client'])
  assert.match(status.notice!.text, /none of the mapped folders exist in Studio yet/)
  assert.equal(syncSummary(status).state, 'starting')

  // Rojo built them; the v5 plugin re-snapshots.
  const nodes = [
    { id: '1', path: ['ReplicatedStorage', 'Shared'], className: 'Folder' },
    { id: '2', path: ['ReplicatedStorage', 'Shared', 'A'], className: 'ModuleScript', source: 'return 1\n' },
    { id: '3', path: ['StarterPlayer', 'StarterPlayerScripts', 'Client'], className: 'Folder' },
    { id: '4', path: ['StarterPlayer', 'StarterPlayerScripts', 'Client', 'Client'], className: 'LocalScript', source: '' }
  ]
  assert.equal((await service.handler.snapshot({ session: cfg.sessionToken, place, seq: 0, final: true, nodes })).ok, true)
  status = await service.status()
  assert.equal(status.notice, undefined)
  assert.equal(status.places[0].missingRoots, undefined)
  assert.equal(syncSummary(status).state, 'running')
  service.close()
})

test('notice: a place the project does not list (servePlaceIds) says so; an old plugin is told to restart Studio', async () => {
  const studio: Studio = { placeId: 999, place: 'Other', pluginVersion: PLUGIN_VERSION, connected: true }
  const service = await make({ root: project([111]), studio: () => studio })
  const cfg = await service.handler.config({ placeId: 999, gameId: 5, place: 'Other' })
  assert.equal(cfg.enabled, false)
  const status = await service.status()
  // Not linked: nothing from it syncs, and rojo serve waits for a linked place's check (Rojo would
  // otherwise connect to it unchecked and offer to delete its Studio-only scripts).
  assert.match(status.notice!.text, /Studio has "Other" open, but it isn't linked to this project.*rojo serve waits/)
  assert.equal(status.notice!.level, 'warn')
  assert.deepEqual(status.unlinked?.map((u) => [u.name, u.placeId, u.canLink]), [['Other', 999, true]])
  assert.equal(status.places.length, 1)
  assert.equal(status.places[0].gate, 'waiting')
  assert.equal(status.places[0].waitReason, 'unlinked')

  studio.placeId = 111
  studio.pluginVersion = PLUGIN_VERSION - 1
  const ok = await service.handler.config({ placeId: 111, gameId: 5, place: 'Other' })
  assert.equal(ok.enabled, true)
  await service.handler.snapshot({ session: ok.sessionToken, place: { placeId: 111 }, seq: 0, final: true, nodes: [{ id: '1', path: ['ReplicatedStorage', 'Shared'], className: 'Folder' }, { id: '2', path: ['StarterPlayer', 'StarterPlayerScripts', 'Client'], className: 'Folder' }] })
  const after = await service.status()
  // v8 checked the place, but a check by a plugin older than SYNC_GATE_PLUGIN_VERSION does not clear
  // rojo serve: restart Studio.
  assert.equal(after.notice?.action, 'restart-studio')
  assert.equal(after.notice?.level, 'warn')
  assert.match(after.notice!.text, new RegExp(`Restart Studio to update the Forge Bridge plugin \\(v${PLUGIN_VERSION - 1} → v${PLUGIN_VERSION}\\)`))
  assert.equal(after.places[0].gate, 'waiting')
  assert.equal(after.places[0].waitReason, 'plugin')
  assert.equal(service.gateFor('default.project.json').gate, 'waiting')
  // Restarted Studio: the current plugin's check clears it.
  studio.pluginVersion = PLUGIN_VERSION
  assert.equal(service.gateFor('default.project.json').gate, 'clear')
  service.close()
})
