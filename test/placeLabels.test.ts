// Telling Studio places with the same name apart (FSFRevamped: "Match" and "Menu" both unpublished, so
// both report PlaceId 0 and "Place1"): collision labels, the plugin v11 fingerprint on the config query,
// Identify delivered to exactly that window's next config, and linking each to its own place file.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { SyncEngine } from '../src/main/services/sync/engine.ts'
import { loadPlaces, placeFor } from '../src/main/services/sync/mapping.ts'
import { IDENTIFY_WAIT_MS, SyncService } from '../src/main/services/sync/service.ts'
import { collisionLabels, fingerprintText, identifyText } from '../src/shared/sync/labels.ts'
import { parseConfigQuery, parseFingerprint, sanitizeConfig } from '../src/shared/sync/protocol.ts'
import { PLUGIN_VERSION, pluginTemplateVersion } from '../src/shared/studio/plugin.ts'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

test('collisionLabels: unique names stay, repeated ones get #n in order', () => {
  assert.deepEqual(collisionLabels([]), [])
  assert.deepEqual(collisionLabels(['Lobby', 'VFX']), ['Lobby', 'VFX'])
  assert.deepEqual(collisionLabels(['Place1', 'Lobby', 'Place1', 'Place1']), ['Place1 #1', 'Lobby', 'Place1 #2', 'Place1 #3'])
})

test('fingerprintText: Workspace names (+more) and the script count', () => {
  assert.equal(fingerprintText(undefined), '')
  assert.equal(fingerprintText({ workspace: ['Arena', 'Lobby', 'Map', 'Spawns'], workspaceCount: 9, scripts: 42 }), 'Workspace: Arena, Lobby, Map +6 · 42 scripts')
  assert.equal(fingerprintText({ workspace: ['Baseplate'], workspaceCount: 1, scripts: 1 }), 'Workspace: Baseplate · 1 script')
  assert.equal(fingerprintText({ workspace: [], workspaceCount: 0, scripts: 0 }), 'empty Workspace · 0 scripts')
})

test('parseFingerprint / parseConfigQuery fp: bounded, odd input dropped', () => {
  assert.deepEqual(parseFingerprint('{"workspace":["Map","Lobby"],"workspaceCount":2,"scripts":7}'), { workspace: ['Map', 'Lobby'], workspaceCount: 2, scripts: 7 })
  // Roblox encodes an empty table as [] (or {} from other encoders).
  assert.deepEqual(parseFingerprint('{"workspace":{},"workspaceCount":0,"scripts":0}'), { workspace: [], workspaceCount: 0, scripts: 0 })
  assert.equal(parseFingerprint('not json'), undefined)
  assert.equal(parseFingerprint('{"workspace":[],"workspaceCount":-1,"scripts":0}'), undefined)
  assert.equal(parseFingerprint('{"workspace":"Map","workspaceCount":1,"scripts":0}'), undefined)
  assert.equal(parseFingerprint('x'.repeat(5000)), undefined)
  const many = parseFingerprint(JSON.stringify({ workspace: ['a\u0001b', 'x'.repeat(100), 3, 'c', 'd', 'e', 'f', 'g', 'h'], workspaceCount: 1, scripts: 0 }))!
  assert.equal(many.workspace.length, 6)
  assert.equal(many.workspace[0], 'a b')
  assert.equal(many.workspace[1].length, 40)
  assert.equal(many.workspaceCount, 6, 'count is at least the names sent')
  const q = parseConfigQuery(new URLSearchParams({ placeId: '0', place: 'Place1', probe: 'probe-aaaa-0001', fp: '{"workspace":["Match"],"workspaceCount":1,"scripts":3}' }))
  assert.deepEqual(q.fp, { workspace: ['Match'], workspaceCount: 1, scripts: 3 })
  assert.equal(parseConfigQuery(new URLSearchParams({ placeId: '0', fp: '{' })).fp, undefined, 'a broken fp is not an error')
})

test('sanitizeConfig passes identify (one clean line) only with enabled false', () => {
  assert.deepEqual(sanitizeConfig({ enabled: false, identify: 'Place1 #2' }), { enabled: false, identify: 'Place1 #2' })
  assert.deepEqual(sanitizeConfig({ enabled: false, identify: '\n\t' }), { enabled: false })
  assert.equal(identifyText('a\nb' + 'x'.repeat(200)).length, 80)
  assert.equal(sanitizeConfig({ enabled: true, sessionToken: 't', roots: [], skip: [], identify: 'x' }).identify, undefined)
})

test('plugin template v11: sends the fingerprint and shows identify', () => {
  const template = readFileSync(resolve(import.meta.dirname, '..', 'resources', 'studio', 'ForgeBridge.luau'), 'utf8')
  assert.equal(PLUGIN_VERSION, 11)
  assert.equal(pluginTemplateVersion(template), PLUGIN_VERSION)
  assert.match(template, /"&fp=" \.\. HttpService:UrlEncode\(fp\)/)
  assert.match(template, /config\.identify/)
  assert.match(template, /ForgeBridgeIdentify/)
})

// FSFRevamped-like: two place files, no servePlaceIds.
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-labels-'))
  dirs.push(root)
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  put('default.project.json', JSON.stringify({ name: 'Match', tree: { $className: 'DataModel', ServerScriptService: { Server: { $path: 'src/server' } } } }))
  put('menu.project.json', JSON.stringify({ name: 'Menu', servePort: 34880, tree: { $className: 'DataModel', ServerScriptService: { Server: { $path: 'menu/server' } } } }))
  put('src/server/Main.server.luau', 'print("match")\n')
  put('menu/server/Main.server.luau', 'print("menu")\n')
  put('.gitignore', '.forge/sync/\n')
  return root
}

function make(root: string, now: () => number) {
  return new SyncService({
    root,
    engine: new SyncEngine({ root }),
    mapping: { loadPlaces, placeFor },
    settings: { get: <T>(_k: string, fb: T) => fb },
    git: async () => ({ code: 1, stdout: '', stderr: '' }),
    pluginsDir: () => null,
    emit: () => undefined,
    onGate: () => undefined,
    now
  })
}

test('two unpublished "Place1" windows: #1 / #2 with fingerprints, Identify reaches only that window, each links to its own place file', async () => {
  const root = project()
  let t = 1_000_000
  const service = make(root, () => t)
  await service.start()
  try {
    const MATCH = { placeId: 0, place: 'Place1', probe: 'probe-match-0001', fp: { workspace: ['Arena', 'Spawns'], workspaceCount: 2, scripts: 40 } }
    const MENU = { placeId: 0, place: 'Place1', probe: 'probe-menu-00002', fp: { workspace: ['MenuStage'], workspaceCount: 1, scripts: 12 } }
    const OLD = { placeId: 0, place: 'Lobby', probe: 'probe-old-000003' } // older plugin: no fingerprint
    await service.handler.config(MATCH)
    await service.handler.config(MENU)
    await service.handler.config(OLD)
    let status = await service.status()
    assert.deepEqual(
      status.unlinked!.map((u) => [u.label, u.fingerprint, !!u.canIdentify]),
      [
        ['Place1 #1', 'Workspace: Arena, Spawns · 40 scripts', true],
        ['Place1 #2', 'Workspace: MenuStage · 12 scripts', true],
        ['Lobby', undefined, false]
      ]
    )
    // The rojo wait line names them apart too.
    assert.match(status.places[0].gateDetail ?? '', /"Place1 #1", "Place1 #2" and 1 more/)
    // Labels stay put when a window asks again.
    t += 5_000
    await service.handler.config(MATCH)
    assert.deepEqual((await service.status()).unlinked!.map((u) => u.label), ['Place1 #1', 'Place1 #2', 'Lobby'])

    // Identify #2: only the Menu window's next config carries it, once.
    assert.deepEqual(service.identifyPlace('probe:probe-menu-00002'), { label: 'Place1 #2' })
    assert.equal((await service.handler.config(MATCH)).identify, undefined)
    assert.equal((await service.handler.config(MENU)).identify, 'Place1 #2')
    assert.equal((await service.handler.config(MENU)).identify, undefined, 'delivered once')
    assert.throws(() => service.identifyPlace('probe:probe-old-000003'), /Restart Studio to load Forge Bridge v11/)
    assert.throws(() => service.identifyPlace('probe:nobody'), /not connected/)
    // A press the window never picked up goes stale.
    service.identifyPlace('probe:probe-match-0001')
    t += IDENTIFY_WAIT_MS + 1
    assert.equal((await service.handler.config(MATCH)).identify, undefined)
    await service.handler.config(MENU)

    // Link each to its own place file (no switching the active place in between).
    await service.linkPlace('probe:probe-match-0001', 'default.project.json')
    await service.linkPlace('probe:probe-menu-00002', 'menu.project.json')
    const a = await service.handler.config(MATCH)
    const b = await service.handler.config(MENU)
    assert.ok(a.stampLink && b.stampLink && a.stampLink !== b.stampLink)
    const links = JSON.parse(readFileSync(join(root, '.forge', 'sync', 'links.json'), 'utf8')).links
    assert.deepEqual(Object.values(links).map((l) => (l as { projectFile: string }).projectFile).sort(), ['default.project.json', 'menu.project.json'])
    assert.equal((await service.handler.config({ ...MATCH, link: a.stampLink })).enabled, true)
    assert.equal((await service.handler.config({ ...MENU, link: b.stampLink })).enabled, true)
    status = await service.status()
    assert.deepEqual(status.unlinked?.map((u) => u.name), ['Lobby'])
    // Linked rows keep their fingerprint for the Source Control row.
    assert.deepEqual(
      status.places.filter((p) => p.place).map((p) => [p.projectFile, p.fingerprint]),
      [
        ['default.project.json', 'Workspace: Arena, Spawns · 40 scripts'],
        ['menu.project.json', 'Workspace: MenuStage · 12 scripts']
      ]
    )
  } finally {
    service.close()
  }
})
