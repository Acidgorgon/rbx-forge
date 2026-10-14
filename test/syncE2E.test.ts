// Forge Sync end to end: the real SyncEngine + mapping behind the real SyncService, reached through the
// Forge Bridge's /sync routes over HTTP, on a synthetic project shaped like Acid's FSF (two places
// sharing src/skills). Plays the Studio plugin's part with fetch.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { after, test } from 'node:test'
import { StudioBridge } from '../src/main/services/studio/bridge.ts'
import { SyncEngine } from '../src/main/services/sync/engine.ts'
import { loadPlaces, placeFor } from '../src/main/services/sync/mapping.ts'
import { SyncService } from '../src/main/services/sync/service.ts'
import { run } from '../src/main/services/tools.ts'
import type { GateState, StudioNode } from '../src/shared/sync/types.ts'
import { edit, get, makeFsfProject, MATCH_PLACE, MENU_PLACE, put, studioFromDisk } from './syncFixture.ts'

const roots: string[] = []
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

async function setup() {
  const root = makeFsfProject()
  roots.push(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: root })
  const gates: [string, GateState][] = []
  const service = new SyncService({
    root,
    engine: new SyncEngine({ root }),
    mapping: { loadPlaces, placeFor },
    settings: { get: <T>(_k: string, fb: T) => fb },
    git: (args) => run('git', args, root),
    pluginsDir: () => null,
    onGate: (file, gate) => gates.push([file, gate]),
    emit: () => undefined
  })
  await service.start()
  const bridge = new StudioBridge({ port: 0, holdMs: 50 })
  await bridge.start()
  bridge.setSyncHandler(service.handler)
  const base = `http://127.0.0.1:${bridge.port}/forge-bridge/sync`
  const plugin = {
    async config(placeId: number, name: string) {
      const r = await fetch(`${base}/config?placeId=${placeId}&gameId=9&place=${encodeURIComponent(name)}`)
      return (await r.json()) as { enabled: boolean; sessionToken: string; roots: string[][] }
    },
    async snapshot(session: string, placeId: number, nodes: StudioNode[], chunk = 7) {
      let last: Record<string, unknown> = {}
      for (let i = 0, seq = 0; i < nodes.length || seq === 0; i += chunk, seq++) {
        const body = { session, place: { placeId, gameId: 9 }, seq, final: i + chunk >= nodes.length, nodes: nodes.slice(i, i + chunk) }
        last = (await (await fetch(`${base}/snapshot`, { method: 'POST', body: JSON.stringify(body) })).json()) as Record<string, unknown>
        assert.equal(last.ok, true, JSON.stringify(last))
      }
      return last
    },
    async changes(session: string, placeId: number, changes: unknown[]) {
      return (await (await fetch(`${base}/changes`, { method: 'POST', body: JSON.stringify({ session, place: { placeId }, changes }) })).json()) as Record<string, unknown>
    }
  }
  const maps = await loadPlaces(root)
  // The plugin's ids are short; the fixture uses the joined path.
  const short = (id: string) => createHash('sha1').update(id).digest('hex').slice(0, 16)
  const studio = (placeId: number) => studioFromDisk(root, placeFor(maps, placeId)!).map((n) => ({ ...n, id: short(n.id) }))
  return { root, service, bridge, plugin, gates, studio, done: () => bridge.stop() }
}

const CONFIG = ['ServerScriptService', 'Server', 'Features', 'Skills', 'Moves', 'Dash', 'Config']

test('e2e: teammate edit in Studio reaches disk before rojo serves; gate checking -> clear', async () => {
  const s = await setup()
  try {
    const cfg = await s.plugin.config(MATCH_PLACE, 'FSF Match')
    assert.equal(cfg.enabled, true)
    assert.ok(cfg.roots.length > 0)
    // First connect: Studio == disk, establishes the base.
    await s.plugin.snapshot(cfg.sessionToken, MATCH_PLACE, s.studio(MATCH_PLACE))
    assert.equal(s.gates.at(-1)?.[1], 'clear')
    // A teammate edits Config in Team Create while Acid is away; Studio reopens.
    const teammate = 'return {\n\tdamage = 12,\n\trange = 4,\n\tspeed = 20,\n\tduration = 0.4,\n}\n'
    const cfg2 = await s.plugin.config(MATCH_PLACE, 'FSF Match')
    await s.plugin.snapshot(cfg2.sessionToken, MATCH_PLACE, edit(s.studio(MATCH_PLACE), CONFIG, { source: teammate }))
    assert.ok(s.gates.some(([, g]) => g === 'checking'))
    assert.equal(s.gates.at(-1)?.[1], 'clear')
    assert.equal(get(s.root, 'src/skills/Server/Moves/Dash/Config.luau'), teammate)
    const status = await s.service.status()
    assert.ok(status.pendingStudioEdits.includes('src/skills/Server/Moves/Dash/Config.luau'))
  } finally {
    await s.done()
  }
})

test('e2e: stale menu Studio does not overwrite a newer match edit; new skill folder + Animations created live', async () => {
  const s = await setup()
  try {
    const menuStudioBefore = s.studio(MENU_PLACE)
    const menu = await s.plugin.config(MENU_PLACE, 'FSF Menu')
    await s.plugin.snapshot(menu.sessionToken, MENU_PLACE, menuStudioBefore)
    const match = await s.plugin.config(MATCH_PLACE, 'FSF Match')
    await s.plugin.snapshot(match.sessionToken, MATCH_PLACE, s.studio(MATCH_PLACE))
    // Edit in match Studio (live change).
    const node = s.studio(MATCH_PLACE).find((n) => n.path.join('/') === CONFIG.join('/'))!
    const newer = node.source!.replace('damage = 10', 'damage = 15')
    assert.equal((await s.plugin.changes(match.sessionToken, MATCH_PLACE, [{ kind: 'source', node: { ...node, source: newer } }])).ok, true)
    assert.match(get(s.root, 'src/skills/Server/Moves/Dash/Config.luau'), /damage = 15/)
    // Menu Studio reconnects with its stale copy (rojo for menu was not running): must not win.
    const menu2 = await s.plugin.config(MENU_PLACE, 'FSF Menu')
    await s.plugin.snapshot(menu2.sessionToken, MENU_PLACE, menuStudioBefore)
    assert.match(get(s.root, 'src/skills/Server/Moves/Dash/Config.luau'), /damage = 15/)
    // A scripter adds a new skill in match Studio: folder with Config, Server and an Animations folder.
    const moves = ['ServerScriptService', 'Server', 'Features', 'Skills', 'Moves']
    const p = (...n: string[]) => [...moves, 'Uppercut', ...n]
    const added = {
      kind: 'added',
      node: { id: 'u', path: p(), className: 'Folder' },
      descendants: [
        { id: 'u1', path: p('Config'), className: 'ModuleScript', source: 'return { damage = 20 }\n' },
        { id: 'u2', path: p('Server'), className: 'ModuleScript', source: 'return function(skill) return true end\n' },
        { id: 'u3', path: p('Animations'), className: 'Folder' },
        { id: 'u4', path: p('Animations', 'Move'), className: 'Animation', properties: { AnimationId: 'rbxassetid://555' } }
      ]
    }
    assert.equal((await s.plugin.changes(match.sessionToken, MATCH_PLACE, [added])).ok, true)
    assert.equal(get(s.root, 'src/skills/Server/Moves/Uppercut/Config.luau'), 'return { damage = 20 }\n')
    assert.ok(existsSync(`${s.root}/src/skills/Server/Moves/Uppercut/Server.luau`))
    assert.match(get(s.root, 'src/skills/Server/Moves/Uppercut/Animations.model.json'), /rbxassetid:\/\/555/)
    // Commit teammate edits stages only Forge-written files.
    put(s.root, 'notes.txt', 'mine\n')
    await s.service.commitStudioEdits()
    const log = execFileSync('git', ['show', '--stat', '--format=%s', 'HEAD'], { cwd: s.root, encoding: 'utf8' })
    assert.match(log, /Studio edits/)
    assert.match(log, /Uppercut\/Config\.luau/)
    assert.doesNotMatch(log, /notes\.txt/)
  } finally {
    await s.done()
  }
})
