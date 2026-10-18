import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import type { GateState, StudioChange, StudioNode, SyncConflictInfo, SyncEntry, SyncPlace } from '../src/shared/sync/types.ts'
import { UNSYNCED_REFS_MAX } from '../src/shared/sync/types.ts'
import { commitMessage, parsePorcelainZ, placeKeyOf, SyncService, type PlaceMapLike, type SyncEngineLike } from '../src/main/services/sync/service.ts'
import { createSync, syncSummary } from '../src/main/services/sync/wire.ts'
import { disableLegacyPlugins, findLegacyPlugins, isLegacyPlugin } from '../src/main/services/sync/legacy.ts'
import { run } from '../src/main/services/tools.ts'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
function temp(prefix = 'forge-sync-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
function put(root: string, file: string, text: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), text)
}
const tick = () => new Promise((r) => setTimeout(r, 5))

// A stand-in for the engine worker's SyncEngine: writes Studio sources for 'pulled' files.
class FakeEngine implements SyncEngineLike {
  root: string
  gates = new Map<string, GateState>()
  held: SyncConflictInfo[] = []
  nodes: StudioNode[] = []
  calls: string[] = []
  // What finishSnapshot reports (and writes) next.
  next: SyncEntry[] = []
  private listeners: (() => void)[] = []
  constructor(root: string) {
    this.root = root
  }
  reload() {
    this.calls.push('reload')
  }
  beginSnapshot(placeKey: string, _place: SyncPlace) {
    this.calls.push(`begin ${placeKey}`)
    this.nodes = []
    this.gates.set(placeKey, 'checking')
    this.changed()
  }
  addSnapshot(_placeKey: string, nodes: StudioNode[]) {
    this.nodes.push(...nodes)
  }
  async finishSnapshot(placeKey: string): Promise<SyncEntry[]> {
    this.calls.push(`finish ${placeKey} ${this.nodes.length}`)
    for (const e of this.next) {
      const node = this.nodes.find((n) => n.path.join('/') === e.instancePath.join('/'))
      if ((e.action === 'pulled' || e.action === 'created') && node?.source !== undefined) put(this.root, e.file, node.source)
    }
    this.gates.set(placeKey, this.held.some((c) => c.placeKey === placeKey) ? 'blocked' : 'clear')
    const out = this.next
    this.next = []
    return out
  }
  async applyChanges(placeKey: string, changes: StudioChange[]): Promise<SyncEntry[]> {
    this.calls.push(`changes ${placeKey} ${changes.length}`)
    return []
  }
  conflicts() {
    return this.held.slice()
  }
  async resolve(placeKey: string, file: string, take: 'studio' | 'disk' | 'merged', text?: string) {
    const c = this.held.find((x) => x.placeKey === placeKey && x.file === file)
    if (!c) throw new Error('no conflict')
    if (take !== 'disk') put(this.root, file, take === 'merged' ? text! : c.studio)
    this.held = this.held.filter((x) => x !== c)
    if (!this.held.some((x) => x.placeKey === placeKey)) this.gates.set(placeKey, 'clear')
    this.changed()
  }
  async resolveAll(placeKey: string, take: 'studio' | 'disk') {
    for (const c of this.held.filter((x) => x.placeKey === placeKey)) await this.resolve(placeKey, c.file, take)
  }
  endSession(placeKey: string) {
    this.calls.push(`end ${placeKey}`)
    this.gates.set(placeKey, 'idle')
    this.changed()
  }
  gate(placeKey: string): GateState {
    return this.gates.get(placeKey) ?? 'idle'
  }
  on(_event: 'changed', fn: () => void) {
    this.listeners.push(fn)
  }
  changed() {
    for (const fn of this.listeners) fn()
  }
}

const MAPS: PlaceMapLike[] = [
  { projectFile: 'default.project.json', placeIds: [111], roots: [{ instance: ['ReplicatedStorage', 'Skills'], path: 'src/skills' }, { instance: ['ReplicatedStorage', 'Packages'], path: 'Packages' }] },
  { projectFile: 'menu.project.json', placeIds: [222], roots: [{ instance: ['ReplicatedStorage', 'Skills'], path: 'src/skills' }] }
]
const mapping = {
  loadPlaces: async () => MAPS,
  placeFor: (maps: PlaceMapLike[], placeId: number) => maps.find((m) => m.placeIds.includes(placeId)) ?? maps[0]
}

function gitRepo(): string {
  const root = temp()
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@example.com'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
  put(root, '.gitignore', '.forge/sync/\n')
  put(root, 'src/skills/Uppercut.luau', 'return 1\n')
  put(root, 'notes.txt', 'mine\n')
  execFileSync('git', ['-C', root, 'add', '-A'])
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'init'])
  return root
}

function setup(opts: { settings?: Record<string, unknown>; root?: string; staleMs?: number } = {}) {
  const root = opts.root ?? gitRepo()
  const engine = new FakeEngine(root)
  const gates: [string, GateState, string | undefined][] = []
  const events: [string, unknown][] = []
  const values: Record<string, unknown> = { ...opts.settings }
  const pluginDir = temp('plugins-')
  const service = new SyncService({
    root,
    engine,
    mapping,
    settings: { get: <T>(k: string, fb: T) => (k in values ? (values[k] as T) : fb) },
    git: (args) => run('git', args, root),
    pluginsDir: () => pluginDir,
    onGate: (file, gate, detail) => gates.push([file, gate, detail]),
    emit: (event, payload) => events.push([event, payload]),
    staleMs: opts.staleMs
  })
  return { root, engine, service, gates, events, values, pluginDir }
}

const node = (path: string[], source?: string): StudioNode => ({ id: path.join('.'), path, className: source === undefined ? 'Folder' : 'ModuleScript', ...(source !== undefined ? { source } : {}) })

test('placeKey, commit message and porcelain parsing', () => {
  assert.equal(placeKeyOf({ placeId: 42 }), '42')
  assert.equal(placeKeyOf({ placeId: 0, name: 'FSF' }), 'unpublished:FSF')
  assert.equal(placeKeyOf({ placeId: 0 }, 'menu.project.json'), 'unpublished:menu')
  assert.equal(commitMessage(['a/Dash.luau', 'b/Kick.luau']), 'Studio edits: Dash.luau, Kick.luau')
  assert.equal(commitMessage(['1.luau', '2.luau', '3.luau', '4.luau', '5.luau']), 'Studio edits: 1.luau, 2.luau, 3.luau and 2 more')
  assert.deepEqual(parsePorcelainZ(' M src/a.luau\0?? src/new dir/b.luau\0R  src/c.luau\0src/old.luau\0 D gone.luau\0'), ['src/a.luau', 'src/new dir/b.luau', 'src/c.luau', 'src/old.luau', 'gone.luau'])
})

test('config hands out a session and the place roots, skipping Packages', async () => {
  const { service } = setup()
  await service.start()
  const cfg = await service.handler.config({ placeId: 222 })
  assert.equal(cfg.enabled, true)
  assert.ok(cfg.sessionToken)
  assert.deepEqual(cfg.roots, [['ReplicatedStorage', 'Skills']])
  const match = await service.handler.config({ placeId: 111 })
  assert.deepEqual(match.roots, [['ReplicatedStorage', 'Skills']])
  // Packages, and the VFX Lab's live Studio preview folder.
  assert.deepEqual(match.skip, [['ReplicatedStorage', 'Packages'], ['Workspace', 'ForgeLivePreview']])
  // A published place no project lists (a test copy, another game): not synced into this project.
  const other = await service.handler.config({ placeId: 999 })
  assert.equal(other.enabled, false)
  assert.match(other.reason ?? '', /999/)
  // An unpublished place (placeId 0) is not linked: it no longer falls back to the default project.
  const local = await service.handler.config({ placeId: 0, place: 'Local' })
  assert.equal(local.enabled, false)
  assert.match(local.reason ?? '', /not linked/)
})

test('config is off when the setting is not forge, or without an engine', async () => {
  const { service } = setup({ settings: { 'sync.engine': 'project' } })
  await service.start()
  assert.equal((await service.handler.config({ placeId: 111 })).enabled, false)
  assert.equal((await service.handler.snapshot({ session: 'x', place: { placeId: 111 }, seq: 0, final: true, nodes: [] })).ok, false)
  const bare = new SyncService({ root: temp(), engine: null, mapping: null, settings: { get: (_k, fb) => fb }, git: async () => ({ code: 1, stdout: '', stderr: '' }), pluginsDir: () => null, emit: () => undefined })
  assert.equal((await bare.handler.config({ placeId: 1 })).enabled, false)
})

test('chunked snapshot: checking gate, then clear; files Forge wrote become pending Studio edits', async () => {
  const { root, engine, service, gates, events } = setup()
  await service.start()
  const { sessionToken } = await service.handler.config({ placeId: 111, place: 'FSF Match' })
  const place = { placeId: 111, name: 'FSF Match' }
  engine.next = [
    { file: 'src/skills/Uppercut.luau', action: 'pulled', instancePath: ['ReplicatedStorage', 'Skills', 'Uppercut'], at: 1 },
    { file: 'src/skills/NewMove/init.luau', action: 'created', instancePath: ['ReplicatedStorage', 'Skills', 'NewMove'], at: 1 },
    { file: 'src/skills/Same.luau', action: 'same', instancePath: ['ReplicatedStorage', 'Skills', 'Same'], at: 1 }
  ]
  assert.deepEqual(await service.handler.snapshot({ session: sessionToken, place, seq: 0, final: false, nodes: [node(['ReplicatedStorage', 'Skills'])] }), { ok: true })
  await tick()
  assert.deepEqual(gates.at(-1), ['default.project.json', 'checking', 'Waiting for Studio sync check'])
  // Out of order chunk: plugin must resend.
  const bad = await service.handler.snapshot({ session: sessionToken, place, seq: 5, final: false, nodes: [] })
  assert.equal(bad.ok, false)
  assert.equal((bad as { resend?: boolean }).resend, true)
  await service.handler.snapshot({ session: sessionToken, place, seq: 0, final: false, nodes: [node(['ReplicatedStorage', 'Skills'])] })
  await service.handler.snapshot({
    session: sessionToken,
    place,
    seq: 1,
    final: true,
    nodes: [node(['ReplicatedStorage', 'Skills', 'Uppercut'], 'return 2\n'), node(['ReplicatedStorage', 'Skills', 'NewMove'], 'return "new"\n')]
  })
  await tick()
  assert.deepEqual(gates.at(-1), ['default.project.json', 'clear', undefined])
  assert.equal(readFileSync(join(root, 'src/skills/Uppercut.luau'), 'utf8'), 'return 2\n')
  const status = await service.status()
  const p = status.places.find((x) => x.placeKey === '111')!
  assert.equal(p.gate, 'clear')
  assert.equal(p.connected, true)
  assert.deepEqual(p.counts, { pulled: 1, created: 1, same: 1 })
  assert.deepEqual(status.recent.map((e) => e.action), ['created', 'pulled'])
  assert.deepEqual(status.pendingStudioEdits, ['src/skills/NewMove/init.luau', 'src/skills/Uppercut.luau'])
  // The menu place has no session: listed, and rojo serve waits for its first Studio check.
  const menu = status.places.find((x) => x.projectFile === 'menu.project.json')
  assert.equal(menu?.gate, 'waiting')
  assert.equal(menu?.waitReason, 'studio')
  assert.equal(service.gateFor('menu.project.json').gate, 'waiting')
  const entryEvents = events.filter(([e]) => e === 'sync:entry')
  assert.equal(entryEvents.length, 1)
  assert.equal((entryEvents[0][1] as SyncEntry[]).length, 2)
  // Changes need a complete snapshot of the current session; unknown sessions are told to resend.
  assert.deepEqual(await service.handler.changes({ session: sessionToken, place, changes: [] }), { ok: true })
  assert.equal((await service.handler.changes({ session: 'nope', place, changes: [] }) as { resend?: boolean }).resend, true)
})

test('commitStudioEdits stages only the files Forge wrote', async () => {
  const { root, engine, service } = setup()
  await service.start()
  const { sessionToken } = await service.handler.config({ placeId: 111 })
  engine.next = [{ file: 'src/skills/Uppercut.luau', action: 'pulled', instancePath: ['ReplicatedStorage', 'Skills', 'Uppercut'], at: 1 }]
  await service.handler.snapshot({ session: sessionToken, place: { placeId: 111 }, seq: 0, final: true, nodes: [node(['ReplicatedStorage', 'Skills', 'Uppercut'], 'return 3\n')] })
  // The user's own unrelated edit (staged even) must stay out of the commit.
  put(root, 'notes.txt', 'mine, edited\n')
  execFileSync('git', ['-C', root, 'add', 'notes.txt'])
  const result = await service.commitStudioEdits()
  assert.deepEqual(result.committed, ['src/skills/Uppercut.luau'])
  assert.equal(result.message, 'Studio edits: Uppercut.luau')
  const show = execFileSync('git', ['-C', root, 'show', '--name-only', '--format=%s', 'HEAD'], { encoding: 'utf8' })
  assert.match(show, /^Studio edits: Uppercut\.luau\n\nsrc\/skills\/Uppercut\.luau\n$/)
  const porcelain = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' })
  assert.match(porcelain, /^M  notes\.txt/m)
  assert.deepEqual(await service.pendingStudioEdits(), [])
  assert.equal((await service.commitStudioEdits()).error, 'No uncommitted Studio edits')
})

test('commitStudioEdits: bracket names are literal paths, and hundreds of files fit (pathspec file)', async () => {
  const { root, engine, service } = setup()
  await service.start()
  // A user's own file that "[Gold]" would match as a glob.
  put(root, 'src/skills/Sword G.luau', 'return "mine"\n')
  execFileSync('git', ['-C', root, 'add', '-A'])
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'mine'])
  put(root, 'src/skills/Sword G.luau', 'return "mine, edited"\n')
  const { sessionToken } = await service.handler.config({ placeId: 111 })
  const many = Array.from({ length: 300 }, (_, i) => `src/skills/Generated/Move_${String(i).padStart(3, '0')}_with_a_longer_name.luau`)
  engine.next = [{ file: 'src/skills/Sword [Gold].luau', action: 'created', instancePath: ['ReplicatedStorage', 'Skills', 'Sword [Gold]'], at: 1 }, ...many.map((file) => ({ file, action: 'created' as const, instancePath: ['ReplicatedStorage', 'Skills', 'x'], at: 1 }))]
  for (const f of many) put(root, f, 'return 1\n')
  await service.handler.snapshot({ session: sessionToken, place: { placeId: 111 }, seq: 0, final: true, nodes: [node(['ReplicatedStorage', 'Skills', 'Sword [Gold]'], 'return "gold"\n')] })
  const result = await service.commitStudioEdits()
  assert.equal(result.error, undefined)
  assert.equal(result.committed.length, 301)
  const show = execFileSync('git', ['-C', root, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' })
  assert.ok(show.includes('src/skills/Sword [Gold].luau'))
  assert.ok(!show.includes('Sword G.luau'))
  assert.match(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }), /^ M "?src\/skills\/Sword G\.luau/m)
})

test('conflicts block the gate; serve anyway clears it until Hold again; resolve writes and clears', async () => {
  const { root, engine, service, gates } = setup()
  await service.start()
  const { sessionToken } = await service.handler.config({ placeId: 111 })
  engine.held = [
    { placeKey: '111', file: 'src/skills/Uppercut.luau', instancePath: ['ReplicatedStorage', 'Skills', 'Uppercut'], base: 'return 1\n', disk: 'return 1 -- disk\n', studio: 'return 1 -- studio\n', reason: 'both-changed' },
    { placeKey: '111', file: 'src/skills/Dash.luau', instancePath: ['ReplicatedStorage', 'Skills', 'Dash'], base: null, disk: 'a\n', studio: 'b\n', reason: 'first-run' }
  ]
  await service.handler.snapshot({ session: sessionToken, place: { placeId: 111 }, seq: 0, final: true, nodes: [] })
  await tick()
  assert.deepEqual(gates.at(-1), ['default.project.json', 'blocked', '2 conflicts: resolve or serve anyway'])
  await service.serveAnyway('111')
  await tick()
  assert.deepEqual(gates.at(-1), ['default.project.json', 'clear', 'Serving anyway (your choice)'])
  // Serve anyway sticks through a new snapshot and a new Studio session (it used to end there, and
  // rojo was stopped under a connected Rojo plugin) ...
  await service.handler.snapshot({ session: sessionToken, place: { placeId: 111 }, seq: 0, final: true, nodes: [] })
  await tick()
  assert.equal(gates.at(-1)![1], 'clear')
  const again = await service.handler.config({ placeId: 111 })
  await service.handler.snapshot({ session: again.sessionToken, place: { placeId: 111 }, seq: 0, final: true, nodes: [] })
  await tick()
  assert.equal(gates.at(-1)![1], 'clear')
  assert.equal((await service.status()).places.find((p) => p.projectFile === 'default.project.json')?.forced, true)
  // ... until the user holds it again.
  await service.stopServingAnyway('default.project.json')
  await tick()
  assert.equal(gates.at(-1)![1], 'blocked')
  await service.resolve('111', 'src/skills/Uppercut.luau', 'studio')
  assert.equal(readFileSync(join(root, 'src/skills/Uppercut.luau'), 'utf8'), 'return 1 -- studio\n')
  await assert.rejects(service.resolve('111', 'src/skills/Dash.luau', 'merged'), /merged text/)
  const s = await service.resolveAll('111', 'disk')
  await tick()
  assert.equal(engine.held.length, 0)
  assert.deepEqual(gates.at(-1), ['default.project.json', 'clear', undefined])
  assert.deepEqual(s.pendingStudioEdits, ['src/skills/Uppercut.luau'])
})

test('git guard: commits pending Studio edits before a pull with autoCommit, warns without', async () => {
  const { root, engine, service } = setup()
  await service.start()
  const { sessionToken } = await service.handler.config({ placeId: 111 })
  engine.next = [{ file: 'src/skills/Uppercut.luau', action: 'pulled', instancePath: ['ReplicatedStorage', 'Skills', 'Uppercut'], at: 1 }]
  await service.handler.snapshot({ session: sessionToken, place: { placeId: 111 }, seq: 0, final: true, nodes: [node(['ReplicatedStorage', 'Skills', 'Uppercut'], 'return 9\n')] })
  const warned = await service.guardGitOp('pull', { autoCommit: false })
  assert.deepEqual(warned.pending, ['src/skills/Uppercut.luau'])
  assert.match(warned.warning ?? '', /1 teammate edit from Studio is not committed/)
  assert.match((await service.status()).warning ?? '', /before the pull/)
  const done = await service.guardGitOp('pull', { autoCommit: true })
  assert.deepEqual(done.committed, ['src/skills/Uppercut.luau'])
  assert.equal(execFileSync('git', ['-C', root, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim(), 'Studio edits: Uppercut.luau')
  assert.equal((await service.status()).warning, undefined)
  assert.deepEqual(await service.guardGitOp('switch', { autoCommit: false }), { pending: [] })
})

test('written set survives a restart (.forge/sync/forge-written.json)', async () => {
  const first = setup()
  await first.service.start()
  const { sessionToken } = await first.service.handler.config({ placeId: 111 })
  first.engine.next = [{ file: 'src/skills/Uppercut.luau', action: 'pulled', instancePath: ['ReplicatedStorage', 'Skills', 'Uppercut'], at: 1 }]
  await first.service.handler.snapshot({ session: sessionToken, place: { placeId: 111 }, seq: 0, final: true, nodes: [node(['ReplicatedStorage', 'Skills', 'Uppercut'], 'return 4\n')] })
  const again = setup({ root: first.root })
  assert.deepEqual(await again.service.pendingStudioEdits(), ['src/skills/Uppercut.luau'])
})

test('legacy StudioSyncPlugin detection and disable', async () => {
  const dir = temp('plugins-')
  for (const f of ['FSFStudioSync.lua', 'RepoStudioSync.lua', 'StudioSyncPlugin.rbxmx', 'ForgeBridge.rbxmx', 'Other.lua', 'Old.lua.disabled']) put(dir, f, '--')
  assert.ok(isLegacyPlugin('FSFStudioSync.luau'))
  assert.ok(!isLegacyPlugin('ForgeBridge.rbxmx'))
  assert.ok(!isLegacyPlugin('FSFStudioSync.lua.disabled'))
  assert.deepEqual((await findLegacyPlugins(dir)).map((f) => f.slice(dir.length + 1)), ['FSFStudioSync.lua', 'RepoStudioSync.lua', 'StudioSyncPlugin.rbxmx'])
  put(dir, 'FSFStudioSync.lua.disabled', 'older')
  assert.equal((await disableLegacyPlugins(dir)).length, 3)
  assert.deepEqual(readdirSync(dir).sort(), ['FSFStudioSync.lua.disabled', 'ForgeBridge.rbxmx', 'Old.lua.disabled', 'Other.lua', 'RepoStudioSync.lua.disabled', 'StudioSyncPlugin.rbxmx.disabled'])
  assert.equal(readFileSync(join(dir, 'FSFStudioSync.lua.disabled'), 'utf8'), '--')
  assert.deepEqual(await findLegacyPlugins(null), [])

  const { service, pluginDir } = setup()
  put(pluginDir, 'FSFStudioSync.lua', '--')
  await service.start()
  assert.equal((await service.status()).legacyPluginInstalled, true)
  const after = await service.disableLegacyPlugin()
  assert.equal(after.legacyPluginInstalled, false)
  assert.ok(existsSync(join(pluginDir, 'FSFStudioSync.lua.disabled')))
})

test('createSync: bridge handler per project, studio-conflict shape, guarded git, settings', async () => {
  const root = gitRepo()
  const values: Record<string, unknown> = {}
  const gates: [string, GateState][] = []
  const summaries: string[] = []
  let applied = 0
  const emitted: [string, unknown][] = []
  let engine: FakeEngine | null = null
  const wiring = createSync({
    settings: { get: <T>(k: string, fb: T) => (k in values ? (values[k] as T) : fb), set: (k, v) => (values[k] = v) },
    emit: (e, p) => emitted.push([e, p]),
    supervisor: { setGate: (f, g) => gates.push([f, g]), applyGates: () => applied++, setSyncSummary: (_s, d) => summaries.push(d) },
    pluginsDir: () => null,
    engine: (r) => (engine = new FakeEngine(r)),
    mapping
  })
  assert.equal((await wiring.handler.config({ placeId: 111 })).enabled, false)
  await wiring.onProjectOpen(root)
  const { sessionToken } = await wiring.handler.config({ placeId: 111 })
  engine!.held = [{ placeKey: '111', file: 'src/skills/Uppercut.luau', instancePath: ['ReplicatedStorage', 'Skills', 'Uppercut'], base: 'return 1\n', disk: 'D\n', studio: 'S\n', reason: 'both-changed' }]
  await wiring.handler.snapshot({ session: sessionToken, place: { placeId: 111 }, seq: 0, final: true, nodes: [] })
  await tick()
  assert.deepEqual(wiring.studioConflicts(), [{ path: 'src/skills/Uppercut.luau', repoSource: 'D\n', studioSource: 'S\n', base: 'return 1\n', placeKey: '111', instancePath: ['ReplicatedStorage', 'Skills', 'Uppercut'], reason: 'both-changed' }])
  assert.ok(emitted.some(([e, p]) => e === 'studio:conflicts' && (p as unknown[]).length === 1))
  assert.equal(summaries.at(-1), 'Forge Sync: 1 conflict held')
  await wiring.resolveStudioConflict('src/skills/Uppercut.luau', 'studio')
  assert.equal(readFileSync(join(root, 'src/skills/Uppercut.luau'), 'utf8'), 'S\n')

  let pulled = 0
  const git = wiring.guardGit({ syncNow: async () => (pulled++, {}), refresh: async () => undefined, extra: 7 }, () => true)
  await git.syncNow()
  assert.equal(pulled, 1)
  assert.equal(git.extra, 7)
  assert.equal(execFileSync('git', ['-C', root, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim(), 'Studio edits: Uppercut.luau')

  assert.deepEqual(await wiring.handlers.setForgeSyncSettings({ engine: 'project', gateRojo: false }), { engine: 'project', gateRojo: false })
  assert.equal(values['sync.engine'], 'project')
  assert.equal(applied, 1)
  assert.equal(wiring.studioConflicts(), null)
  wiring.onProjectClose()
  assert.equal((await wiring.handler.snapshot({ session: sessionToken, place: { placeId: 111 }, seq: 0, final: true, nodes: [] })).ok, false)
})

test('syncSummary', () => {
  const base = { recent: [], pendingStudioEdits: [] }
  assert.equal(syncSummary({ ...base, engine: 'off', places: [] }).detail, 'off')
  assert.deepEqual(syncSummary({ ...base, engine: 'forge', places: [{ placeKey: '1', projectFile: 'menu.project.json', gate: 'checking', connected: true, counts: {}, conflicts: 0 }] }), { state: 'starting', detail: 'Forge Sync: checking menu' })
  assert.equal(syncSummary({ ...base, engine: 'forge', places: [] }).detail, 'Forge Sync: waiting for Studio')
})

test('unsynced references: collected over a chunked snapshot, replaced by changes, capped in status', async () => {
  const { service } = setup()
  await service.start()
  const place = { placeId: 111, name: 'FSF Match' }
  const { sessionToken } = await service.handler.config({ placeId: 111 })
  const ref = (name: string, property: string) => ({ path: ['ReplicatedStorage', 'Skills', name], property })
  assert.equal((await service.status()).unsyncedRefs, undefined)
  await service.handler.snapshot({ session: sessionToken, place, seq: 0, final: false, nodes: [node(['ReplicatedStorage', 'Skills'])], refs: [ref('Weld', 'Part0')] })
  // Not shown until the snapshot is complete.
  assert.equal((await service.status()).unsyncedRefs, undefined)
  await service.handler.snapshot({ session: sessionToken, place, seq: 1, final: true, nodes: [], refs: [ref('Weld', 'Part1'), ref('Target', 'Value')], refsTotal: 3 })
  let status = await service.status()
  assert.deepEqual(status.unsyncedRefs, [ref('Weld', 'Part0'), ref('Weld', 'Part1'), ref('Target', 'Value')])
  assert.equal(status.unsyncedRefsTotal, 3)

  // A changes body with refs replaces the list (and an empty change list does not reach the engine).
  await service.handler.changes({ session: sessionToken, place, changes: [], refs: [ref('Target', 'Value')], refsTotal: 1 })
  status = await service.status()
  assert.deepEqual(status.unsyncedRefs, [ref('Target', 'Value')])
  // Without refs the list stays.
  await service.handler.changes({ session: sessionToken, place, changes: [{ kind: 'source', node: node(['ReplicatedStorage', 'Skills', 'Uppercut'], 'return 3\n') }] })
  assert.equal((await service.status()).unsyncedRefsTotal, 1)

  // The menu place reports the same reference plus many more: de-duplicated, capped, total uncapped.
  const menu = await service.handler.config({ placeId: 222 })
  const many = Array.from({ length: 150 }, (_, i) => ref(`V${i}`, 'Value'))
  await service.handler.snapshot({ session: menu.sessionToken, place: { placeId: 222 }, seq: 0, final: true, nodes: [], refs: [ref('Target', 'Value'), ...many], refsTotal: 400 })
  status = await service.status()
  assert.equal(status.unsyncedRefs!.length, UNSYNCED_REFS_MAX)
  assert.deepEqual(status.unsyncedRefs![0], ref('Target', 'Value'))
  assert.equal(status.unsyncedRefsTotal, 1 + 150 + (400 - 151))

  // Cleared again when Studio reports none.
  await service.handler.changes({ session: sessionToken, place, changes: [], refs: [], refsTotal: 0 })
  await service.handler.changes({ session: menu.sessionToken, place: { placeId: 222 }, changes: [], refs: [] })
  assert.equal((await service.status()).unsyncedRefs, undefined)
})

test('a snapshot that stalls ends the session (back to waiting for a new Studio check), also when Studio reopened and the new session never sent a chunk', async () => {
  const { engine, service, gates } = setup({ staleMs: 30 })
  await service.start()
  const place = { placeId: 111, name: 'FSF Match' }
  const first = await service.handler.config({ placeId: 111 })
  await service.handler.snapshot({ session: first.sessionToken, place, seq: 0, final: false, nodes: [node(['ReplicatedStorage', 'Skills'])] })
  await tick()
  assert.equal(gates.at(-1)?.[1], 'checking')
  // Studio closed mid-snapshot and opened again: a new config drops the old token.
  await service.handler.config({ placeId: 111 })
  await new Promise((r) => setTimeout(r, 80))
  assert.ok(engine.calls.includes('end 111'))
  // Not 'checking' any more, and not 'clear' either: rojo serve waits for Studio's next check.
  assert.equal(gates.at(-1)?.[1], 'waiting')
  assert.equal(service.gateFor('default.project.json').reason, 'studio')
})

test('first Studio check: waiting before it, checking from the config on, "serve without check" lasts until the next check', async () => {
  const { engine, service, gates } = setup()
  await service.start()
  // start() pushes every place file's gate before it returns (main starts rojo right after).
  const last = (file: string) => gates.filter(([f]) => f === file).at(-1)
  assert.equal(last('default.project.json')?.[1], 'waiting')
  assert.match(last('default.project.json')?.[2] ?? '', /^Waiting for Studio's first sync check/)
  assert.equal(last('menu.project.json')?.[1], 'waiting')
  // The user's call for one place file.
  await service.serveWithoutCheck('default.project.json')
  await tick()
  assert.equal(last('default.project.json')?.[1], 'idle')
  assert.equal(last('menu.project.json')?.[1], 'waiting')
  await assert.rejects(service.serveWithoutCheck('nope.project.json'), /No nope\.project\.json/)
  // Studio asks for config: checking at once, before any snapshot chunk (a rojo still running stops).
  const { sessionToken } = await service.handler.config({ placeId: 111, place: 'FSF Match' })
  await tick()
  assert.equal(last('default.project.json')?.[1], 'checking')
  await service.handler.snapshot({ session: sessionToken, place: { placeId: 111 }, seq: 0, final: true, nodes: [node(['ReplicatedStorage', 'Skills'])] })
  await tick()
  assert.equal(last('default.project.json')?.[1], 'clear')
  // The check replaced the earlier choice: once this session is over, the place waits again.
  engine.endSession('111')
  await tick()
  assert.equal(last('default.project.json')?.[1], 'waiting')
  service.close()
})
