// Memory export/import (.forgepack) and device sync: pack round-trip, per-item conflict choices,
// zip-slip refusal, secret refusal, folder-sync merge by newest `updated`, and git-sync
// orchestration against a fake git runner (no network, no real git).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as zlib from 'node:zlib'
import { MemoryStore } from '../src/main/agent/memory/store.ts'
import { formatFrontmatter, parseFrontmatter } from '../src/main/agent/memory/frontmatter.ts'
import { readZip, writeZip } from '../src/main/services/setup/unzip.ts'
import { applyImport, buildPack, exportCandidates, MANIFEST, PackError, parsePack, previewPack, type PackDeps } from '../src/main/agent/memory/sync/pack.ts'
import { crc32, writeDeflatedZip } from '../src/main/agent/memory/sync/zipWrite.ts'
import { safeJoin, safeRel } from '../src/main/agent/memory/sync/files.ts'
import { mirror } from '../src/main/agent/memory/sync/mirror.ts'
import { BrainSync } from '../src/main/agent/memory/sync/brainSync.ts'
import { checkRepoUrl, GitBrain, type GitRunner } from '../src/main/agent/memory/sync/gitBrain.ts'
import type { PackSection } from '../src/main/agent/memory/sync/sections.ts'
import type { BrainSyncSettings, BrainSyncStatus } from '../src/main/agent/memory/sync/types.ts'

const tmp = (p: string) => mkdtemp(join(tmpdir(), `forge-brain-${p}-`))

async function put(path: string, text: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

function memFile(name: string, description: string, body: string, updated: number): string {
  return formatFrontmatter({ name, description, type: 'user', created: 1000, updated, lastUsed: 0, uses: 0 }, body)
}

async function device(label: string, withProject = true, withVfx = true) {
  const root = await tmp(label)
  const user = new MemoryStore({ scope: 'user', dir: join(root, 'memory') })
  const project = withProject ? new MemoryStore({ scope: 'project', dir: join(root, 'game', '.forge', 'memory'), usageKey: 'project:game' }) : null
  const vfxDir = join(root, 'vfx', 'library')
  const sections: PackSection[] = withVfx ? [{ id: 'vfx', label: 'VFX library', dir: () => vfxDir }] : []
  const deps: PackDeps = { user, project: () => project, sections: () => sections, device: label, now: () => 1_700_000_000_000 }
  return { root, user, project, vfxDir, sections, deps }
}

// ------------------------------------------------------------------ zip writer

test('zip writer: deflated entries with real CRC-32s read back through unzip.ts', () => {
  const big = 'tween '.repeat(2000)
  const zip = writeDeflatedZip([{ name: 'a.txt', data: big }, { name: 'dir/b.bin', data: Buffer.from([0, 1, 2, 3]) }, { name: 'ü.md', data: 'unicode name' }])
  const entries = readZip(zip)
  assert.deepEqual(entries.map((e) => e.name), ['a.txt', 'dir/b.bin', 'ü.md'])
  assert.equal(entries[0].data.toString(), big)
  assert.ok(zip.length < big.length / 4, 'text is deflated')
  // Central directory CRC matches zlib's (Node >= 20.15 / 22.2 has zlib.crc32).
  const zcrc = (zlib as unknown as { crc32?: (b: Buffer) => number }).crc32
  if (zcrc) assert.equal(crc32(Buffer.from(big)), zcrc(Buffer.from(big)))
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926) // the standard check value
})

// ------------------------------------------------------------------ pack round-trip

test('pack round-trip: user memories, skills (with extra files), project memory and VFX entries', async () => {
  const a = await device('a')
  await a.user.save({ scope: 'user', name: 'answer-style', description: 'Prefers terse answers: the diff first', type: 'feedback', body: 'Lead with the diff.' })
  await a.user.save({ scope: 'user', kind: 'skill', name: 'profile-a-slow-server', description: 'A server frame-time regression needs tracking down', body: '1. MicroProfiler\n2. Compare tags' })
  await put(join(a.user.dir, 'skills', 'profile-a-slow-server', 'reference.md'), 'Extra notes for the skill.')
  await a.project!.save({ scope: 'project', name: 'data-store-keys', description: 'PlayerData uses ProfileStore with key Player_<UserId>', body: 'Store PlayerData_v2.' })
  await put(join(a.vfxDir, 'ember-burst', 'entry.json'), JSON.stringify({ name: 'Ember burst', description: 'warm sparks' }))
  await put(join(a.vfxDir, 'ember-burst', 'thumbs', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]))
  await put(join(a.vfxDir, 'loose.json'), '{"x":1}')

  const cands = await exportCandidates(a.deps)
  assert.equal(cands.items.length, 5)
  assert.ok(cands.items.every((i) => !i.blocked))
  assert.equal(cands.items.find((i) => i.key === 'vfx/extra/ember-burst')?.description, 'Ember burst — warm sparks')

  // 'all' leaves project memory out unless asked.
  const userOnly = await buildPack(a.deps, { keys: 'all' })
  assert.equal(userOnly.manifest.counts.projectMemories, 0)

  const { zip, manifest } = await buildPack(a.deps, { keys: 'all', includeProject: true })
  assert.equal(manifest.format, 'forgepack')
  assert.equal(manifest.version, 1)
  assert.equal(manifest.device, 'a')
  assert.deepEqual(manifest.counts, { userMemories: 1, userSkills: 1, projectMemories: 1, projectSkills: 0, extra: { vfx: 2 } })
  const names = readZip(zip).map((e) => e.name).sort()
  assert.equal(readZip(zip)[0].name, MANIFEST)
  assert.deepEqual(names, [
    'extra/vfx/ember-burst/entry.json',
    'extra/vfx/ember-burst/thumbs/a.png',
    'extra/vfx/loose.json',
    MANIFEST,
    'project/data-store-keys.md',
    'user/answer-style.md',
    'user/skills/profile-a-slow-server/SKILL.md',
    'user/skills/profile-a-slow-server/reference.md'
  ])

  const b = await device('b')
  const parsed = parsePack(zip)
  const preview = await previewPack(b.deps, parsed, 't', 'x.forgepack')
  assert.ok(preview.items.every((i) => i.status === 'new'), JSON.stringify(preview.items.map((i) => [i.key, i.status])))
  const r = await applyImport(b.deps, parsed)
  assert.deepEqual(r, { added: 5, replaced: 0, renamed: 0, merged: 0, skipped: 0, errors: [] })
  const got = await b.user.get('memory', 'answer-style')
  assert.equal(got?.body, 'Lead with the diff.')
  assert.equal(got?.type, 'feedback')
  assert.equal((await b.user.get('skill', 'profile-a-slow-server'))?.body, '1. MicroProfiler\n2. Compare tags')
  assert.equal(await readFile(join(b.user.dir, 'skills', 'profile-a-slow-server', 'reference.md'), 'utf8'), 'Extra notes for the skill.')
  assert.ok(await b.project!.get('memory', 'data-store-keys'))
  assert.deepEqual(await readFile(join(b.vfxDir, 'ember-burst', 'thumbs', 'a.png')), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]))
  assert.equal(await readFile(join(b.vfxDir, 'loose.json'), 'utf8'), '{"x":1}')

  // Importing the same pack again: everything is "same" and skipped.
  const again = await previewPack(b.deps, parsePack(zip), 't2', 'x')
  assert.ok(again.items.every((i) => i.status === 'same'))
  assert.equal((await applyImport(b.deps, parsePack(zip))).skipped, 5)

  // A selection exports only those keys.
  const sel = await buildPack(a.deps, { keys: ['user/memory/answer-style', 'vfx/extra/loose.json'] })
  assert.deepEqual(sel.manifest.items.map((i) => i.key).sort(), ['user/memory/answer-style', 'vfx/extra/loose.json'])
})

test('import: project items are blocked without an open project, unknown sections are blocked', async () => {
  const a = await device('a2')
  await a.project!.save({ scope: 'project', name: 'facts', description: 'A project fact', body: 'Fact.' })
  await put(join(a.vfxDir, 'e1', 'entry.json'), '{}')
  const { zip } = await buildPack(a.deps, { keys: 'all', includeProject: true })
  const b = await device('b2', false, false)
  const p = await previewPack(b.deps, parsePack(zip), 't', 'f')
  assert.equal(p.items.find((i) => i.key === 'project/memory/facts')?.status, 'blocked')
  assert.match(p.items.find((i) => i.key === 'vfx/extra/e1')?.reason ?? '', /no "vfx" library/)
  const r = await applyImport(b.deps, parsePack(zip))
  assert.equal(r.skipped, 2)
})

// ------------------------------------------------------------------ conflict choices

test('import conflicts: keep mine, take theirs, keep both (renamed), and the dedupe for near-duplicates', async () => {
  const a = await device('ca')
  await a.user.save({ scope: 'user', name: 'answer-style', description: 'Prefers terse answers, code first', body: 'THEIRS body' })
  await a.user.save({ scope: 'user', name: 'tween-easing-pref', description: 'Prefers Quint Out easing for UI tweens', body: 'Quint Out 0.25 s' })
  await put(join(a.vfxDir, 'ember', 'entry.json'), '{"v":"theirs"}')
  const { zip } = await buildPack(a.deps, { keys: 'all' })

  const fresh = async (label: string) => {
    const b = await device(label)
    await b.user.save({ scope: 'user', name: 'answer-style', description: 'Prefers terse answers, code first', body: 'MINE body' })
    await b.user.save({ scope: 'user', name: 'ui-tween-easing', description: 'Prefers Quint Out easing for UI tweens', body: 'Quint Out' })
    await put(join(b.vfxDir, 'ember', 'entry.json'), '{"v":"mine"}')
    return b
  }

  const b0 = await fresh('cb0')
  const prev = await previewPack(b0.deps, parsePack(zip), 't', 'f')
  const st = Object.fromEntries(prev.items.map((i) => [i.key, i]))
  assert.equal(st['user/memory/answer-style'].status, 'conflict')
  assert.equal(st['user/memory/answer-style'].renameTo, 'answer-style-2')
  assert.equal(st['user/memory/tween-easing-pref'].status, 'similar')
  assert.equal(st['user/memory/tween-easing-pref'].local?.name, 'ui-tween-easing')
  assert.equal(st['vfx/extra/ember'].status, 'conflict')
  assert.equal(st['vfx/extra/ember'].renameTo, 'ember-2')

  // Default: conflicts keep mine; the near-duplicate merges into the local one (existing dedupe).
  const rDefault = await applyImport(b0.deps, parsePack(zip))
  assert.equal(rDefault.merged, 1)
  assert.equal((await b0.user.get('memory', 'answer-style'))?.body, 'MINE body')
  assert.equal((await b0.user.get('memory', 'ui-tween-easing'))?.body, 'Quint Out 0.25 s')
  assert.equal(await b0.user.get('memory', 'tween-easing-pref'), null)
  assert.equal(await readFile(join(b0.vfxDir, 'ember', 'entry.json'), 'utf8'), '{"v":"mine"}')

  // Take theirs.
  const b1 = await fresh('cb1')
  const r1 = await applyImport(b1.deps, parsePack(zip), { 'user/memory/answer-style': 'theirs', 'vfx/extra/ember': 'theirs', 'user/memory/tween-easing-pref': 'mine' })
  assert.equal(r1.replaced, 2)
  assert.equal((await b1.user.get('memory', 'answer-style'))?.body, 'THEIRS body')
  assert.equal(await readFile(join(b1.vfxDir, 'ember', 'entry.json'), 'utf8'), '{"v":"theirs"}')
  assert.equal((await b1.user.get('memory', 'ui-tween-easing'))?.body, 'Quint Out')

  // Keep both.
  const b2 = await fresh('cb2')
  const r2 = await applyImport(b2.deps, parsePack(zip), { 'user/memory/answer-style': 'both', 'vfx/extra/ember': 'both', 'user/memory/tween-easing-pref': 'both' })
  assert.equal(r2.renamed, 2)
  assert.equal((await b2.user.get('memory', 'answer-style'))?.body, 'MINE body')
  assert.equal((await b2.user.get('memory', 'answer-style-2'))?.body, 'THEIRS body')
  assert.equal(await readFile(join(b2.vfxDir, 'ember', 'entry.json'), 'utf8'), '{"v":"mine"}')
  assert.equal(await readFile(join(b2.vfxDir, 'ember-2', 'entry.json'), 'utf8'), '{"v":"theirs"}')
  assert.ok(await b2.user.get('memory', 'tween-easing-pref'), 'keep both skips the dedupe')
  assert.ok(await b2.user.get('memory', 'ui-tween-easing'))
})

// ------------------------------------------------------------------ zip-slip

test('zip-slip: packs with escaping paths are refused whole and nothing is written', async () => {
  const manifest = JSON.stringify({ format: 'forgepack', version: 1, created: 1, device: 'x', counts: {}, items: [] })
  const evil = [
    '../evil.md',
    'user/../../evil.md',
    '/etc/evil.md',
    'C:/evil.md',
    'user\\..\\evil.md',
    'extra/vfx/../../../evil.json',
    'user/./x.md'
  ]
  const b = await device('slip')
  for (const name of evil) {
    const zip = writeZip([{ name: MANIFEST, data: manifest }, { name: 'user/ok.md', data: memFile('ok', 'fine', 'fine', 1) }, { name, data: 'pwned' }])
    assert.throws(() => parsePack(zip), (e: unknown) => e instanceof PackError && /unsafe path/.test((e as Error).message), name)
  }
  assert.equal(existsSync(join(b.root, 'evil.md')), false)
  assert.equal(existsSync(join(dirname(b.root), 'evil.md')), false)
  assert.equal(await b.user.get('memory', 'ok'), null)

  assert.equal(safeRel('a/../b'), null)
  assert.equal(safeRel('a/b.md'), 'a/b.md')
  assert.throws(() => safeJoin(b.root, '../x'), PackError)
  assert.ok(safeJoin(b.root, 'a/b').startsWith(b.root))

  // Not a pack at all / wrong format / newer version.
  assert.throws(() => parsePack(Buffer.from('nope')), PackError)
  assert.throws(() => parsePack(writeZip([{ name: 'user/x.md', data: 'x' }])), /no manifest/)
  assert.throws(() => parsePack(writeZip([{ name: MANIFEST, data: JSON.stringify({ format: 'forgepack', version: 99 }) }])), /update Forge/)
})

// ------------------------------------------------------------------ secrets

test('secrets: export marks and refuses items the scanner trips; import blocks them too', async () => {
  const a = await device('sec')
  await a.user.save({ scope: 'user', name: 'clean', description: 'A clean memory', body: 'Nothing to see.' })
  // A hand edit after saving (the store would have refused it).
  await put(join(a.user.dir, 'leaky.md'), memFile('leaky', 'Token notes', 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB', 5))
  await put(join(a.vfxDir, 'fx', 'entry.json'), '{"webhook":"https://discord.com/api/webhooks/123456/abcdefghijklmnopqrstuvwxyz"}')

  const c = await exportCandidates(a.deps)
  assert.match(c.items.find((i) => i.key === 'user/memory/leaky')?.blocked ?? '', /GitHub token/)
  assert.match(c.items.find((i) => i.key === 'vfx/extra/fx')?.blocked ?? '', /Discord webhook/)
  assert.equal(c.items.find((i) => i.key === 'user/memory/clean')?.blocked, undefined)

  await assert.rejects(buildPack(a.deps, { keys: 'all' }), (e: unknown) => e instanceof PackError && /export refused/.test((e as Error).message) && /leaky/.test((e as Error).message))
  const ok = await buildPack(a.deps, { keys: ['user/memory/clean'] })
  assert.equal(ok.manifest.items.length, 1)

  // A pack made elsewhere that carries a secret: previewed as blocked, never written.
  const manifest = JSON.stringify({ format: 'forgepack', version: 1, created: 1, device: 'x', counts: {}, items: [] })
  const zip = writeZip([{ name: MANIFEST, data: manifest }, { name: 'user/leak.md', data: memFile('leak', 'key', 'OPEN_CLOUD_API_KEY=abcdefghijklmnop1234', 1) }])
  const b = await device('sec-b')
  const p = await previewPack(b.deps, parsePack(zip), 't', 'f')
  assert.equal(p.items[0].status, 'blocked')
  await applyImport(b.deps, parsePack(zip), { 'user/memory/leak': 'theirs' })
  assert.equal(await b.user.get('memory', 'leak'), null)
})

// ------------------------------------------------------------------ folder sync

function settingsBag(initial: Partial<BrainSyncSettings>) {
  const map = new Map<string, unknown>([['brainSync.settings', initial]])
  return {
    getSetting: <T,>(k: string, f: T) => (map.has(k) ? (map.get(k) as T) : f),
    setSetting: (k: string, v: unknown) => void map.set(k, v),
    map
  }
}

async function syncDevice(label: string, shared: Partial<BrainSyncSettings>, run?: GitRunner) {
  const d = await device(label, false)
  const bag = settingsBag(shared)
  const statuses: BrainSyncStatus[] = []
  let pulledCalls = 0
  const sync = new BrainSync({
    userDir: d.user.dir,
    dataDir: d.root,
    device: label,
    ...bag,
    emit: (s) => void statuses.push(s),
    onPulled: () => {
      pulledCalls++
      d.user.invalidate()
    },
    sections: () => d.sections,
    run,
    debounceMs: 5
  })
  return { ...d, sync, statuses, pulled: () => pulledCalls, bag }
}

test('folder sync: two devices converge; both-edited files resolve by newest `updated` with a .conflict copy', async () => {
  const cloud = await tmp('cloud')
  const A = await syncDevice('A', { mode: 'folder', folder: cloud })
  const B = await syncDevice('B', { mode: 'folder', folder: cloud })
  const shared = join(cloud, 'forge-brain')

  await put(join(A.user.dir, 'x.md'), memFile('x', 'fact x', 'v1', 1000))
  await put(join(A.vfxDir, 'fx', 'entry.json'), '{"a":1}')
  let s = await A.sync.syncNow()
  assert.equal(s.state, 'idle', s.lastError)
  assert.equal(s.last?.pushed, 2)
  assert.ok(existsSync(join(shared, 'memory', 'x.md')))
  assert.ok(existsSync(join(shared, 'extra', 'vfx', 'fx', 'entry.json')))

  s = await B.sync.syncNow()
  assert.equal(s.last?.pulled, 2)
  assert.equal(B.pulled(), 1, 'stores re-read after a pull')
  assert.equal((await B.user.get('memory', 'x'))?.body, 'v1')

  // Both edit x: A at t=2000, B at t=3000. A syncs first, then B: B is newer and wins.
  await put(join(A.user.dir, 'x.md'), memFile('x', 'fact x', 'A edit', 2000))
  await put(join(B.user.dir, 'x.md'), memFile('x', 'fact x', 'B edit', 3000))
  await A.sync.syncNow()
  s = await B.sync.syncNow()
  assert.equal(s.last?.conflicts, 1)
  assert.equal(parseFrontmatter(await readFile(join(shared, 'memory', 'x.md'), 'utf8')).body, 'B edit')
  assert.equal(parseFrontmatter(await readFile(join(B.user.dir, 'x.md.conflict'), 'utf8')).body, 'A edit')
  // The conflict copy is not a memory and is not synced.
  B.user.invalidate()
  assert.deepEqual((await B.user.list()).map((e) => e.name), ['x'])
  assert.equal(existsSync(join(shared, 'memory', 'x.md.conflict')), false)

  // A pulls B's newer version (only the shared side changed since A's last sync).
  s = await A.sync.syncNow()
  assert.equal(s.last?.conflicts, 0)
  assert.equal(parseFrontmatter(await readFile(join(A.user.dir, 'x.md'), 'utf8')).body, 'B edit')

  // Older-but-later edit loses: A edits with an older timestamp than B's concurrent edit.
  await put(join(A.user.dir, 'x.md'), memFile('x', 'fact x', 'A old', 3500))
  await put(join(B.user.dir, 'x.md'), memFile('x', 'fact x', 'B new', 4000))
  await B.sync.syncNow()
  await A.sync.syncNow()
  assert.equal(parseFrontmatter(await readFile(join(A.user.dir, 'x.md'), 'utf8')).body, 'B new')
  assert.equal(parseFrontmatter(await readFile(join(A.user.dir, 'x.md.conflict'), 'utf8')).body, 'A old')

  // Deletion propagates; MEMORY.md (regenerated index) never syncs.
  await rm(join(A.user.dir, 'x.md'))
  await put(join(A.user.dir, 'MEMORY.md'), '# index')
  await A.sync.syncNow()
  assert.equal(existsSync(join(shared, 'memory', 'x.md')), false)
  assert.equal(existsSync(join(shared, 'memory', 'MEMORY.md')), false)
  await B.sync.syncNow()
  assert.equal(existsSync(join(B.user.dir, 'x.md')), false)

  // A local file with a secret is held back, and the status says so.
  await put(join(A.user.dir, 'leak.md'), memFile('leak', 'k', 'token = "abcdefghijklmnop"', 9000))
  s = await A.sync.syncNow()
  assert.equal(existsSync(join(shared, 'memory', 'leak.md')), false)
  assert.match(s.lastError ?? '', /look like they contain secrets/)
})

test('folder sync: missing folder is an error state; off mode does nothing; local changes push debounced', async () => {
  const A = await syncDevice('A3', { mode: 'folder', folder: join(tmpdir(), 'forge-brain-does-not-exist-xyz') })
  const s = await A.sync.syncNow()
  assert.equal(s.state, 'error')
  assert.match(s.lastError ?? '', /not available/)

  const off = await syncDevice('off', { mode: 'off' })
  assert.equal((await off.sync.syncNow()).state, 'off')

  const cloud = await tmp('cloud2')
  const D = await syncDevice('D', { mode: 'folder', folder: cloud })
  await put(join(D.user.dir, 'y.md'), memFile('y', 'fact y', 'y', 10))
  D.sync.onLocalChange()
  assert.equal(D.sync.status().pending, true)
  for (let i = 0; i < 100 && !existsSync(join(cloud, 'forge-brain', 'memory', 'y.md')); i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(existsSync(join(cloud, 'forge-brain', 'memory', 'y.md')))
  D.sync.dispose()
})

test('mirror: first sync between two devices that both have the same new file is a newest-wins conflict', async () => {
  const local = await tmp('ml')
  const shared = await tmp('ms')
  await put(join(local, 'a.md'), memFile('a', 'd', 'local', 50))
  await put(join(shared, 'memory', 'a.md'), memFile('a', 'd', 'shared', 60))
  const r = await mirror([{ prefix: 'memory', dir: local }], shared, {})
  assert.equal(r.conflicts, 1)
  assert.equal(parseFrontmatter(await readFile(join(local, 'a.md'), 'utf8')).body, 'shared')
  assert.ok(existsSync(join(local, 'a.md.conflict')))
  assert.ok(r.localChanged)
})

// ------------------------------------------------------------------ git sync (fake runner)

// An in-memory "remote": files at the tip of main. The fake understands just the commands
// GitBrain issues, copies between the remote snapshot and the clone's working tree, and records
// every call. No network, no real git.
function fakeGit(opts: { authFail?: boolean } = {}) {
  const remote = new Map<string, Buffer>()
  const calls: string[][] = []
  let commits = 0
  let rejectNext: (() => void) | null = null
  let authFail = opts.authFail ?? false

  const listTree = async (dir: string): Promise<Map<string, Buffer>> => {
    const out = new Map<string, Buffer>()
    const walk = async (abs: string, rel: string) => {
      for (const e of await readdir(abs, { withFileTypes: true }).catch(() => [])) {
        if (e.name === '.git') continue
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) await walk(join(abs, e.name), r)
        else out.set(r, await readFile(join(abs, e.name)))
      }
    }
    await walk(dir, '')
    return out
  }
  const checkoutRemote = async (dir: string) => {
    for (const e of await readdir(dir)) if (e !== '.git') await rm(join(dir, e), { recursive: true, force: true })
    for (const [rel, data] of remote) await put(join(dir, rel), data)
  }
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
  const no = (stderr = '', code = 1) => ({ code, stdout: '', stderr })

  const run: GitRunner = async (args, cwd) => {
    calls.push(args)
    const ids = args.filter((a, i) => !(a === '-c' || args[i - 1] === '-c'))
    const [cmd, ...rest] = ids
    if (authFail && (cmd === 'clone' || cmd === 'fetch' || cmd === 'push')) return no('remote: Repository not found.\nfatal: Authentication failed for \'https://github.com/dev/forge-brain.git/\'', 128)
    switch (cmd) {
      case 'clone': {
        const dir = rest[rest.length - 1]
        await mkdir(join(dir, '.git'), { recursive: true })
        await checkoutRemote(dir)
        return ok()
      }
      case 'remote':
        return rest[0] === 'get-url' ? ok('https://github.com/dev/forge-brain.git\n') : ok()
      case 'fetch':
        return ok()
      case 'symbolic-ref':
        if (rest[0] === '--short') return commits ? ok('origin/main\n') : no()
        return ok()
      case 'rev-parse':
        return no()
      case 'checkout':
        return ok()
      case 'reset':
        await checkoutRemote(cwd)
        return ok()
      case 'clean':
      case 'add':
        return ok()
      case 'status': {
        const tree = await listTree(cwd)
        const same = tree.size === remote.size && [...tree].every(([k, v]) => remote.get(k)?.equals(v))
        return ok(same ? '' : ' M changed\n')
      }
      case 'config':
        return no() // no user.email configured: GitBrain must supply one
      case 'commit':
        return ok()
      case 'push': {
        if (rejectNext) {
          const change = rejectNext
          rejectNext = null
          change()
          return no(' ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs', 1)
        }
        const tree = await listTree(cwd)
        remote.clear()
        for (const [k, v] of tree) remote.set(k, v)
        commits++
        return ok()
      }
      default:
        return no(`fake git: unexpected ${args.join(' ')}`)
    }
  }
  return {
    run,
    remote,
    calls,
    commits: () => commits,
    rejectOnceWith: (fn: () => void) => void (rejectNext = fn),
    setAuthFail: (v: boolean) => void (authFail = v)
  }
}

test('git sync: clone, merge, commit and push; a second device pulls; rejected pushes retry', async () => {
  const git = fakeGit()
  const url = 'https://github.com/dev/forge-brain.git'
  const A = await syncDevice('A', { mode: 'git', repoUrl: url }, git.run)
  await put(join(A.user.dir, 'x.md'), memFile('x', 'fact x', 'from A', 100))
  let s = await A.sync.syncNow()
  assert.equal(s.state, 'idle', s.lastError)
  assert.equal(git.commits(), 1)
  assert.equal(parseFrontmatter(git.remote.get('memory/x.md')!.toString()).body, 'from A')
  const commit = git.calls.find((c) => c.includes('commit'))!
  assert.ok(commit.includes('user.email=forge@A.local'), 'falls back to a local identity when none is configured')
  assert.ok(commit.includes('Forge sync from A'))
  assert.ok(git.calls.some((c) => c[0] === 'push' && c.includes('HEAD:refs/heads/main')))
  assert.ok(!git.calls.some((c) => c.includes('--force') || c.includes('-f')), 'never force-pushes')

  // Nothing changed: no commit, no push.
  const pushes = git.calls.filter((c) => c[0] === 'push').length
  await A.sync.syncNow()
  assert.equal(git.calls.filter((c) => c[0] === 'push').length, pushes)

  // Device B: clones and pulls.
  const B = await syncDevice('B', { mode: 'git', repoUrl: url }, git.run)
  s = await B.sync.syncNow()
  assert.equal(s.last?.pulled, 1)
  assert.equal((await B.user.get('memory', 'x'))?.body, 'from A')

  // B edits, but A pushes first: B's push is rejected once, it refetches, merges by newest and pushes.
  await put(join(B.user.dir, 'x.md'), memFile('x', 'fact x', 'from B', 300))
  git.rejectOnceWith(() => git.remote.set('memory/z.md', Buffer.from(memFile('z', 'fact z', 'from A again', 200))))
  s = await B.sync.syncNow()
  assert.equal(s.state, 'idle', s.lastError)
  assert.equal(parseFrontmatter(git.remote.get('memory/x.md')!.toString()).body, 'from B')
  assert.ok(git.remote.has('memory/z.md'))
  assert.ok(existsSync(join(B.user.dir, 'z.md')))
})

test('git sync: missing auth gives a clear message and never a token; credential URLs are refused', async () => {
  const git = fakeGit({ authFail: true })
  const A = await syncDevice('A', { mode: 'git', repoUrl: 'https://github.com/dev/forge-brain.git' }, git.run)
  const s = await A.sync.syncNow()
  assert.equal(s.state, 'error')
  assert.equal(s.authProblem, true)
  assert.match(s.lastError ?? '', /could not sign in to github\.com/)
  assert.match(s.lastError ?? '', /never stores a token/)
  assert.match(s.lastError ?? '', /git clone https:\/\/github\.com\/dev\/forge-brain\.git/)
  // Nothing about the token was stored in settings.
  assert.ok(![...A.bag.map.keys()].some((k) => /token|password|cred/i.test(k)))

  assert.throws(() => checkRepoUrl('https://ghp_abc123@github.com/dev/forge-brain.git'), /never stores a token/)
  assert.throws(() => checkRepoUrl('https://me:pw@github.com/dev/forge-brain.git'), /token/)
  assert.equal(checkRepoUrl('git@github.com:dev/forge-brain.git'), 'git@github.com:dev/forge-brain.git')
  assert.equal(checkRepoUrl(' https://github.com/dev/forge-brain '), 'https://github.com/dev/forge-brain')
  assert.throws(() => checkRepoUrl(''), /URL/)

  // git missing on PATH.
  const missing = new GitBrain({ run: async () => ({ code: 1, stdout: '', stderr: 'spawn git ENOENT' }), url: 'https://github.com/dev/forge-brain.git', dir: join(A.root, 'clone'), device: 'A' })
  await assert.rejects(missing.sync(async () => ({ pulled: 0, pushed: 0, conflicts: 0, held: [], base: {}, localChanged: false })), /git is not installed/)
})
