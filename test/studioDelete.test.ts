// Game tab "Delete in Studio" on Forge's side (which paths Forge refuses, the delete job it queues on
// the Forge Bridge, version and connection gates), the outline answer that makes a forgotten plugin
// session start over, and how the Forge Bridge plugin template ships with code-only quick updates.
import assert from 'node:assert/strict'
import { linkPlaces } from './syncFixture.ts'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { StudioBridge } from '../src/main/services/studio/bridge.ts'
import { deleteInStudio, deleteJob, deleteUnavailable, DELETE_PLUGIN_VERSION, type DeleteBridge } from '../src/main/services/studio/deleteInstance.ts'
import { pluginTemplateCandidates, readPluginTemplate } from '../src/main/services/studio/wire.ts'
import { deleteRefusal, SyncService, type PlaceMapLike } from '../src/main/services/sync/service.ts'
import { SyncEngine } from '../src/main/services/sync/engine.ts'
import { loadPlaces, placeFor } from '../src/main/services/sync/mapping.ts'
import { PLUGIN_VERSION, pluginTemplateVersion } from '../src/shared/studio/plugin.ts'
import type { BridgeJob } from '../src/shared/studio/protocol.ts'
import { checkPluginTemplate } from '../build/quick-bundle.ts'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

// GenTree's default.project.json as mapping.ts sees it.
const MAP: PlaceMapLike = {
  projectFile: 'default.project.json',
  placeIds: [],
  roots: [
    { instance: ['ReplicatedStorage', 'Shared'], path: 'src/shared' },
    { instance: ['ServerScriptService', 'Server'], path: 'src/server' },
    { instance: ['ServerStorage'], path: 'src/ServerStorage' },
    { instance: ['StarterPlayer', 'StarterPlayerScripts', 'Client'], path: 'src/client' }
  ],
  skipped: [{ instance: ['ReplicatedStorage', 'Packages'] }],
  virtual: [['ReplicatedStorage'], ['ServerScriptService'], ['StarterPlayer'], ['StarterPlayer', 'StarterPlayerScripts']]
}

test('delete in Studio: Forge refuses services, project nodes and anything around a $path', () => {
  assert.match(deleteRefusal(MAP, ['Workspace'])!, /is a service/)
  assert.match(deleteRefusal(MAP, ['ReplicatedStorage', 'Shared'])!, /synced to files/)
  assert.match(deleteRefusal(MAP, ['ReplicatedStorage', 'Shared', 'Modules'])!, /synced to files/)
  assert.match(deleteRefusal(MAP, ['ServerStorage', 'Map'])!, /synced to files/)
  assert.match(deleteRefusal(MAP, ['ReplicatedStorage', 'Packages', '_Index'])!, /synced to files/)
  assert.match(deleteRefusal(MAP, ['StarterPlayer', 'StarterPlayerScripts'])!, /holds StarterPlayer\.StarterPlayerScripts\.Client/)
  // Studio-only: next to a $path, or in a service the project only names.
  assert.equal(deleteRefusal(MAP, ['StarterPlayer', 'StarterPlayerScripts', 'LocalScript']), null)
  assert.equal(deleteRefusal(MAP, ['ReplicatedStorage', 'Assets']), null)
  assert.equal(deleteRefusal(MAP, ['ReplicatedStorage', 'SharedStuff']), null)
  assert.equal(deleteRefusal(MAP, ['Workspace', 'Baseplate']), null)
  // A $className container the project defines.
  assert.match(deleteRefusal({ ...MAP, virtual: [...MAP.virtual!, ['ReplicatedStorage', 'Remotes']] }, ['ReplicatedStorage', 'Remotes'])!, /defined by the project file/)
})

function fakeBridge(over: Partial<DeleteBridge> & { runs?: BridgeJob[] } = {}): DeleteBridge & { runs: BridgeJob[] } {
  const runs = over.runs ?? []
  return {
    connected: () => true,
    studio: () => ({ pluginVersion: DELETE_PLUGIN_VERSION }),
    busy: () => null,
    run: async (job) => {
      runs.push(job)
    },
    ...over,
    runs
  }
}

test('delete in Studio: the job queued for the plugin, and the gates before it', async () => {
  const bridge = fakeBridge()
  const deps = { bridge, refusal: (p: string[]) => deleteRefusal(MAP, p), newId: () => 'job-1' }
  await deleteInStudio(deps, ['StarterPlayer', 'StarterPlayerScripts', 'LocalScript'], 'LocalScript')
  assert.equal(bridge.runs.length, 1)
  const job = bridge.runs[0]
  assert.equal(job.id, 'job-1')
  assert.equal(job.kind, 'delete')
  assert.equal(job.version, 1)
  assert.deepEqual(job.target, { path: ['StarterPlayer', 'StarterPlayerScripts', 'LocalScript'], className: 'LocalScript' })
  assert.deepEqual(deleteJob(['A', 'B'], undefined, 'x').target, { path: ['A', 'B'] })

  // Refused by the mapping: nothing reaches Studio.
  await assert.rejects(deleteInStudio(deps, ['ReplicatedStorage', 'Shared']), /synced to files/)
  assert.equal(bridge.runs.length, 1)
  // No Studio, or a plugin that does not know delete jobs (it would build an effect stage).
  const off = fakeBridge({ connected: () => false })
  assert.match((await deleteUnavailable({ bridge: off, refusal: () => null }, ['A', 'B']))!, /not connected/)
  await assert.rejects(deleteInStudio({ bridge: off, refusal: () => null }, ['A', 'B']), /not connected/)
  const old = fakeBridge({ studio: () => ({ pluginVersion: 6 }) })
  await assert.rejects(deleteInStudio({ bridge: old, refusal: () => null }, ['A', 'B']), /v6; restart Studio to load v7/)
  assert.equal(old.runs.length + off.runs.length, 0)
  // A Studio check holds the job channel.
  const busy = fakeBridge({ busy: () => deleteJob(['X', 'Y'], undefined) })
  await assert.rejects(deleteInStudio({ bridge: busy, refusal: () => null }, ['A', 'B']), /Studio check is running/)
  assert.equal(await deleteUnavailable(deps, ['StarterPlayer', 'StarterPlayerScripts', 'LocalScript']), null)
})

test('delete in Studio: over the real bridge, the plugin\'s refusal is the error and done resolves', async () => {
  const bridge = new StudioBridge({ port: 0, holdMs: 200 })
  await bridge.start()
  try {
    const base = `http://127.0.0.1:${bridge.port}/forge-bridge`
    // A fake v7 plugin: polls, refuses the first delete, carries out the second.
    let n = 0
    const plugin = (async () => {
      for (let i = 0; i < 40 && n < 2; i++) {
        const answer = (await (await fetch(`${base}/poll?v=7&place=Place1&placeId=0`)).json()) as { job?: BridgeJob }
        if (!answer.job) continue
        n++
        const post = (ev: unknown) => fetch(`${base}/event/${answer.job!.id}`, { method: 'POST', body: JSON.stringify(ev) })
        await post({ type: 'accepted' })
        await post(n === 1 ? { type: 'error', message: 'Studio has 2 instances named ReplicatedStorage.Dup; delete the right one in Studio\'s Explorer' } : { type: 'done', marks: [] })
      }
    })()
    await fetch(`${base}/poll?v=7&place=Place1&placeId=0`) // connected, v7
    const deps = { bridge, refusal: () => null }
    await assert.rejects(deleteInStudio(deps, ['ReplicatedStorage', 'Dup'], 'Folder'), (e: Error) => e.message === 'Studio has 2 instances named ReplicatedStorage.Dup; delete the right one in Studio\'s Explorer')
    await deleteInStudio(deps, ['ReplicatedStorage', 'Assets'], 'Folder')
    await plugin
    assert.equal(n, 2)
  } finally {
    await bridge.stop()
  }
})

test('outline from a session Forge no longer knows asks the plugin to start over', async () => {
  const root = tmp('forge-outline-')
  writeFileSync(join(root, 'default.project.json'), JSON.stringify({ name: 'G', tree: { $className: 'DataModel', ReplicatedStorage: { Shared: { $path: 'src/shared' } } } }))
  mkdirSync(join(root, 'src', 'shared'), { recursive: true })
  linkPlaces(root, { 'local:link-0001-place1': 'default.project.json' })
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
  try {
    const answer = await service.handler.outline!({ session: 'forgotten', place: { placeId: 0, name: 'Place1' }, nodes: [] })
    assert.deepEqual(answer, { ok: false, error: 'unknown session', resend: true })
    // A live session takes an empty outline (everything outside the roots deleted) and replaces the old one.
    const config = await service.handler.config({ placeId: 0, place: 'Place1', link: 'link-0001-place1' })
    const place = { placeId: 0, name: 'Place1' }
    assert.deepEqual(await service.handler.outline!({ session: config.sessionToken, place, nodes: [{ path: ['ReplicatedStorage', 'Old'], className: 'Folder' }] }), { ok: true })
    assert.deepEqual(service.liveTree('default.project.json')?.nodes.map((x) => x.path.join('.')), ['ReplicatedStorage.Old'])
    assert.deepEqual(await service.handler.outline!({ session: config.sessionToken, place, nodes: [] }), { ok: true })
    assert.deepEqual(service.liveTree('default.project.json')?.nodes, [])
  } finally {
    service.close()
  }
})

// ---- the plugin template in quick updates

const TEMPLATE = readFileSync(resolve(import.meta.dirname, '..', 'resources', 'studio', 'ForgeBridge.luau'), 'utf8')

test('plugin template: its version line matches PLUGIN_VERSION', () => {
  assert.equal(pluginTemplateVersion(TEMPLATE), PLUGIN_VERSION)
  assert.equal(pluginTemplateVersion('-- forge-bridge-version: __FORGE_BRIDGE_VERSION__\nlocal x = 1'), 6, 'templates from before the marker are v6 or older')
})

test('plugin template: the copy next to the code (a quick update) wins over the installer\'s resources', async () => {
  const userData = tmp('forge-quick-code-')
  const code = join(userData, 'code', '0.6.2-quick.1', 'main')
  const resources = join(userData, 'resources')
  mkdirSync(join(code, 'studio'), { recursive: true })
  mkdirSync(join(resources, 'studio'), { recursive: true })
  const oldTemplate = TEMPLATE.replace(/^-- forge-bridge-template: \d+\n/m, '')
  writeFileSync(join(resources, 'studio', 'ForgeBridge.luau'), oldTemplate)
  writeFileSync(join(code, 'studio', 'ForgeBridge.luau'), TEMPLATE)
  const candidates = pluginTemplateCandidates(code, resources)
  assert.equal(candidates[0], join(code, 'studio'))
  assert.equal(candidates[1], join(resources, 'studio'))
  assert.equal(await readPluginTemplate(candidates), TEMPLATE)
  // Even listed after an older copy, the current one is picked.
  assert.equal(await readPluginTemplate([join(resources, 'studio'), join(code, 'studio')]), TEMPLATE)
  // A quick code folder without its copy falls back to the installer's (stamped with its own version).
  rmSync(join(code, 'studio'), { recursive: true })
  assert.equal(await readPluginTemplate(pluginTemplateCandidates(code, resources).slice(0, 2)), oldTemplate)
  assert.equal(await readPluginTemplate([join(userData, 'nowhere')]), null)
})

test('plugin template: a quick bundle must carry the current template', () => {
  const file = (p: string, text: string): [string, Buffer] => [p, Buffer.from(text)]
  assert.doesNotThrow(() => checkPluginTemplate([file('main/app.js', ''), file('main/studio/ForgeBridge.luau', TEMPLATE)]))
  assert.throws(() => checkPluginTemplate([file('main/app.js', '')]), /main\/studio\/ForgeBridge\.luau is missing/)
  assert.throws(() => checkPluginTemplate([file('main/studio/ForgeBridge.luau', TEMPLATE.replace(/forge-bridge-template: \d+/, 'forge-bridge-template: 5'))]), new RegExp(`template v5 but the code installs v${PLUGIN_VERSION}`))
})
