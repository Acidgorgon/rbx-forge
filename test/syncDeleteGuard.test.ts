// Delete guard (FSF incident, 2026-10-17): src/server/Features/Character/CharacterService.luau
// (1587 lines) left the disk between two "harness: sync" commits without Forge Sync trashing it. Its
// base stayed in .forge/sync/index.json and .forge/sync/trash had nothing, the signature of a hard
// delete outside Forge Sync's engine (Rojo two-way sync's fs::remove_file when the ModuleScript is
// deleted in Studio, or any tool deleting the file while Rojo carried it into Studio). Forge Sync then
// saw a file gone from both sides and said nothing, and the git auto-sync committed the delete and
// pushed it. These tests replay that and pin the guard: nothing large or required leaves the project
// on its own, every removal keeps a copy, and the auto-commit does not push such a delete.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import type { StudioNode, SyncEntry } from '../src/shared/sync/types.ts'
import { GUARD_LINES, SyncEngine } from '../src/main/services/sync/engine.ts'
import type { PlaceMap } from '../src/main/services/sync/mapping.ts'
import { GitSync } from '../src/main/services/gitSync.ts'
import { Checkpoints } from '../src/main/agent/checkpoints.ts'
import { SyncService } from '../src/main/services/sync/service.ts'
import { run } from '../src/main/services/tools.ts'
import { find, get, makeFsfProject, MATCH_PLACE, put, studioFromDisk } from './syncFixture.ts'

const roots: string[] = []
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const MK = String(MATCH_PLACE)
const MATCH = { placeId: MATCH_PLACE, name: 'Arena' }
const HANDLERS = ['ServerScriptService', 'Server', 'Handlers']
// A big module like CharacterService (more lines than the guard allows).
const BIG = 'src/server/Handlers/CharacterService.luau'
const BIG_TEXT = ['local CharacterService = {}', ...Array.from({ length: GUARD_LINES + 20 }, (_, i) => `CharacterService.value${i} = ${i}`), 'return CharacterService'].join('\r\n') + '\r\n'
// A small module another script requires.
const SMALL = 'src/server/Handlers/KickMath.luau'
const REQUIRER = 'src/server/Handlers/Ball.luau'

interface Ctx {
  root: string
  engine: SyncEngine
  match: PlaceMap
  log: string[]
}

async function setup(): Promise<Ctx> {
  const root = makeFsfProject()
  roots.push(root)
  put(root, BIG, BIG_TEXT)
  put(root, SMALL, 'return { kick = 1 }\n')
  put(root, REQUIRER, 'local KickMath = require(script.Parent.KickMath)\nreturn KickMath\n')
  const engine = new SyncEngine({ root, now: (() => {
    let t = Date.UTC(2026, 9, 17, 0, 41, 14)
    return () => t++
  })() })
  const maps = await engine.places()
  const ctx = { root, engine, match: maps.find((m) => m.projectFile === 'default.project.json')!, log: [] }
  const first = await snapshot(ctx, studioFromDisk(root, ctx.match))
  assert.deepEqual(first.filter((e) => !['same', 'unmapped'].includes(e.action)), [])
  return ctx
}

async function snapshot(ctx: { engine: SyncEngine }, nodes: StudioNode[]): Promise<SyncEntry[]> {
  ctx.engine.beginSnapshot(MK, MATCH)
  ctx.engine.addSnapshot(MK, nodes)
  return ctx.engine.finishSnapshot(MK)
}

const studio = (ctx: Ctx): StudioNode[] => studioFromDisk(ctx.root, ctx.match)
const byFile = (entries: SyncEntry[], file: string): SyncEntry | undefined => entries.find((e) => e.file === file)
const trashFiles = (root: string): string[] => {
  const dir = join(root, '.forge/sync/trash')
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(child)
      else if (child !== '.gitignore') out.push(child.split('/').slice(1).join('/'))
    }
  }
  walk('')
  return out.sort()
}

test('the incident: a big module gone from disk and Studio outside Forge is held, a copy is saved, and Take disk restores it', async () => {
  const ctx = await setup()
  const node = find(studio(ctx), [...HANDLERS, 'CharacterService'])
  // Rojo two-way sync deletes the file (fs::remove_file, no trash) as Studio removes the instance.
  rmSync(join(ctx.root, BIG))
  const entries = await ctx.engine.applyChanges(MK, [{ kind: 'removed', id: node.id, path: node.path }])
  // Before the guard: no entry at all, nothing in the trash, the base left behind, gate clear.
  const e = byFile(entries, BIG)
  assert.equal(e?.action, 'conflict')
  assert.match(e!.note!, /gone from disk and from Studio, not removed by Forge Sync \(322 lines\)/)
  assert.match(e!.trashPath!, /^\.forge\/sync\/recovered\/[^/]+\/src\/server\/Handlers\/CharacterService\.luau$/)
  assert.equal(readFileSync(join(ctx.root, e!.trashPath!), 'utf8'), BIG_TEXT.replace(/\r\n/g, '\n'))
  assert.equal(ctx.engine.gate(MK), 'blocked', 'rojo serve is held until the user decides')
  assert.equal(ctx.engine.conflicts(MK)[0].disk, BIG_TEXT.replace(/\r\n/g, '\n').replace(/\n$/, ''), 'the conflict shows the copy Take disk restores')

  // A full snapshot later (Studio reconnects) still holds it, without a second recovery copy.
  const again = await snapshot(ctx, studio(ctx))
  assert.equal(byFile(again, BIG)?.action, 'conflict')
  assert.equal(readdirSync(join(ctx.root, '.forge/sync/recovered')).length, 1)

  await ctx.engine.resolve(MK, BIG, 'disk')
  assert.equal(readFileSync(join(ctx.root, BIG), 'utf8').replace(/\r\n/g, '\n'), BIG_TEXT.replace(/\r\n/g, '\n'), 'restored to disk; Rojo puts it back in Studio')
  assert.equal(ctx.engine.gate(MK), 'clear')
  const back = await snapshot(ctx, studio(ctx))
  assert.equal(byFile(back, BIG)?.action, 'same')
})

test('gone from both sides: Take Studio confirms the delete; a small unrequired file only keeps a copy', async () => {
  const ctx = await setup()
  const node = find(studio(ctx), [...HANDLERS, 'CharacterService'])
  rmSync(join(ctx.root, BIG))
  await ctx.engine.applyChanges(MK, [{ kind: 'removed', id: node.id, path: node.path }])
  await ctx.engine.resolve(MK, BIG, 'studio')
  assert.ok(!existsSync(join(ctx.root, BIG)))
  assert.equal(ctx.engine.gate(MK), 'clear')
  const later = await snapshot(ctx, studio(ctx))
  assert.equal(byFile(later, BIG), undefined, 'confirmed: not held again')

  const combat = find(studio(ctx), [...HANDLERS, 'Combat'])
  rmSync(join(ctx.root, 'src/server/Handlers/Combat.luau'))
  const small = await ctx.engine.applyChanges(MK, [{ kind: 'removed', id: combat.id, path: combat.path }])
  const e = byFile(small, 'src/server/Handlers/Combat.luau')
  assert.equal(e?.action, 'disk-ahead')
  assert.match(e!.note!, /last synced copy saved to \.forge\/sync\/recovered\//)
  assert.equal(readFileSync(join(ctx.root, e!.trashPath!), 'utf8'), 'return {}\n')
  assert.equal(ctx.engine.gate(MK), 'clear')
})

test('a Studio delete of a big module is held as "keep or delete?", never trashed on its own', async () => {
  const ctx = await setup()
  const node = find(studio(ctx), [...HANDLERS, 'CharacterService'])
  const entries = await ctx.engine.applyChanges(MK, [{ kind: 'removed', id: node.id, path: node.path }])
  const e = byFile(entries, BIG)
  assert.equal(e?.action, 'conflict')
  assert.match(e!.note!, /^deleted in Studio \(322 lines\): keep or delete\?/)
  assert.ok(existsSync(join(ctx.root, BIG)), 'still on disk')
  assert.deepEqual(trashFiles(ctx.root), [])
  assert.equal(ctx.engine.gate(MK), 'blocked')
  // Take Studio: the delete goes ahead, into the trash.
  await ctx.engine.resolve(MK, BIG, 'studio')
  assert.ok(!existsSync(join(ctx.root, BIG)))
  assert.deepEqual(trashFiles(ctx.root), [BIG])
  assert.equal(ctx.engine.gate(MK), 'clear')
})

test('a Studio delete of a small module another script requires is held; Take disk keeps it', async () => {
  const ctx = await setup()
  const node = find(studio(ctx), [...HANDLERS, 'KickMath'])
  const entries = await ctx.engine.applyChanges(MK, [{ kind: 'removed', id: node.id, path: node.path }])
  assert.equal(byFile(entries, SMALL)?.action, 'conflict')
  assert.match(byFile(entries, SMALL)!.note!, /required by src\/server\/Handlers\/Ball\.luau/)
  await ctx.engine.resolve(MK, SMALL, 'disk')
  assert.equal(get(ctx.root, SMALL), 'return { kick = 1 }\n')
  // Rojo puts it back in Studio (the next check agrees on it again).
  ctx.engine.endSession(MK)
  await snapshot(ctx, studio(ctx))
  // Deleting the requirer too is fine: nothing that stays requires it.
  const ball = find(studio(ctx), [...HANDLERS, 'Ball'])
  const kick = find(studio(ctx), [...HANDLERS, 'KickMath'])
  const both = await ctx.engine.applyChanges(MK, [
    { kind: 'removed', id: ball.id, path: ball.path },
    { kind: 'removed', id: kick.id, path: kick.path }
  ])
  assert.deepEqual(both.filter((x) => x.action === 'trashed').map((x) => x.file).sort(), [REQUIRER, SMALL])
})

test('a big module deleted on disk while Studio still has it is held before Rojo can delete it in Studio', async () => {
  const ctx = await setup()
  ctx.engine.endSession(MK)
  const nodes = studio(ctx)
  rmSync(join(ctx.root, BIG))
  const entries = await snapshot(ctx, nodes)
  const e = byFile(entries, BIG)
  assert.equal(e?.action, 'conflict')
  assert.match(e!.note!, /^deleted on disk, not by Forge Sync \(322 lines\)/)
  assert.equal(ctx.engine.gate(MK), 'blocked', 'rojo serve does not start and delete it from Studio')
  // Take Studio writes it back.
  await ctx.engine.resolve(MK, BIG, 'studio')
  assert.equal(readFileSync(join(ctx.root, BIG), 'utf8').replace(/\r\n/g, '\n'), BIG_TEXT.replace(/\r\n/g, '\n'))

  // Take disk confirms the disk delete: the next pass lets Rojo carry it into Studio, no re-hold.
  rmSync(join(ctx.root, BIG))
  ctx.engine.endSession(MK)
  await snapshot(ctx, nodes)
  await ctx.engine.resolve(MK, BIG, 'disk')
  ctx.engine.endSession(MK)
  const next = await snapshot(ctx, nodes)
  assert.equal(byFile(next, BIG)?.action, 'disk-ahead')
  assert.deepEqual(ctx.engine.conflicts(MK), [])
  // Rojo then removes it from Studio: the base goes quietly, nothing is held.
  const node = find(nodes, [...HANDLERS, 'CharacterService'])
  const gone = await ctx.engine.applyChanges(MK, [{ kind: 'removed', id: node.id, path: node.path }])
  assert.equal(byFile(gone, BIG), undefined)
  assert.equal(ctx.engine.gate(MK), 'clear')
})

test('a Studio rename into a folder that already has that name does not lose the big module', async () => {
  // Studio drags CharacterService into Legacy, which already has a CharacterService (FSF's layout).
  const ctx = await setup()
  put(ctx.root, 'src/server/Handlers/Legacy/CharacterService.luau', 'return "old"\n')
  ctx.engine.endSession(MK)
  await snapshot(ctx, studio(ctx))
  const node = find(studio(ctx), [...HANDLERS, 'CharacterService'])
  const moved = { ...node, path: [...HANDLERS, 'Legacy', 'CharacterService'] }
  const entries = await ctx.engine.applyChanges(MK, [{ kind: 'moved', id: node.id, from: node.path, node: moved }])
  assert.ok(existsSync(join(ctx.root, BIG)), 'the disk copy stays (kept: Legacy now has two CharacterService)')
  assert.equal(get(ctx.root, BIG), BIG_TEXT)
  assert.equal(entries.filter((e) => e.action === 'trashed').length, 0)
  assert.equal(get(ctx.root, 'src/server/Handlers/Legacy/CharacterService.luau'), 'return "old"\n')
})

// ---- git auto-sync ----

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-guard-git-'))
  roots.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'core.autocrlf', 'false')
  git(dir, 'config', 'user.name', 'me')
  git(dir, 'config', 'user.email', 'me@example.com')
  const write = (rel: string, text: string): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  write('src/server/Features/Character/CharacterService.luau', BIG_TEXT)
  write('src/server/Features/Character/KickMath.luau', 'return 1\n')
  write('src/server/Features/Character/Momentum.luau', 'local KickMath = require(script.Parent.KickMath)\nreturn KickMath\n')
  write('src/server/Features/Character/Unused.luau', 'return 2\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'start')
  return dir
}

test('git auto-sync does not commit (or push) the delete of a big or required module that left the disk outside Forge', async () => {
  const dir = repo()
  const log: string[] = []
  const sync = new GitSync({ root: dir, settings: () => ({ autoSyncMinutes: 0, autoCommit: true }), log: (t) => log.push(t) })
  const big = 'src/server/Features/Character/CharacterService.luau'
  const required = 'src/server/Features/Character/KickMath.luau'
  const unused = 'src/server/Features/Character/Unused.luau'
  for (const f of [big, required, unused]) rmSync(join(dir, f))
  writeFileSync(join(dir, 'notes.md'), 'work\n')
  await sync.syncNow()
  const tracked = git(dir, 'ls-files').split('\n')
  assert.ok(tracked.includes(big), 'the big module is still in git')
  assert.ok(tracked.includes(required), 'the required module is still in git')
  assert.ok(!tracked.includes(unused), 'an unguarded delete is committed as before')
  assert.ok(tracked.includes('notes.md'))
  assert.equal(git(dir, 'log', '-1', '--format=%s').trim(), 'harness: sync')
  assert.ok(log.some((l) => l.includes(`not committing the delete of ${big} (322 lines)`)), log.join('\n'))
  assert.ok(log.some((l) => l.includes(`not committing the delete of ${required} (required by src/server/Features/Character/Momentum.luau)`)))
  // Restorable from git as the message says.
  git(dir, 'checkout', '--', big)
  assert.equal(readFileSync(join(dir, big), 'utf8'), BIG_TEXT)

  // A delete Forge made (a copy in .forge/sync/trash) is meant: it is committed.
  rmSync(join(dir, big))
  mkdirSync(dirname(join(dir, '.forge/sync/trash/2026-10-17T00-45-00-000Z', big)), { recursive: true })
  writeFileSync(join(dir, '.forge/sync/trash/.gitignore'), '*\n')
  writeFileSync(join(dir, '.forge/sync/trash/2026-10-17T00-45-00-000Z', big), BIG_TEXT)
  const before = git(dir, 'rev-parse', 'HEAD')
  await sync.syncNow()
  assert.notEqual(git(dir, 'rev-parse', 'HEAD'), before)
  assert.ok(!git(dir, 'ls-files').split('\n').includes(big))
  assert.equal(git(dir, 'status', '--porcelain', '--', '.forge'), '', 'the trash is never committed')
})

test('git auto-sync with only a held delete makes no empty commit', async () => {
  const dir = repo()
  const sync = new GitSync({ root: dir, settings: () => ({ autoSyncMinutes: 0, autoCommit: true }) })
  const head = git(dir, 'rev-parse', 'HEAD')
  rmSync(join(dir, 'src/server/Features/Character/CharacterService.luau'))
  const status = await sync.syncNow()
  assert.equal(status.error, undefined)
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head)
})

test('"Studio edits" commits leave out a guarded delete too (a file Forge once wrote, gone outside Forge)', async () => {
  const dir = repo()
  const big = 'src/server/Features/Character/CharacterService.luau'
  const small = 'src/server/Features/Character/Unused.luau'
  mkdirSync(join(dir, '.forge/sync'), { recursive: true })
  writeFileSync(join(dir, '.gitignore'), '.forge/sync/\n')
  writeFileSync(join(dir, '.forge/sync/forge-written.json'), JSON.stringify({ files: [big, small] }))
  git(dir, 'add', '.gitignore')
  git(dir, 'commit', '-q', '-m', 'ignore')
  rmSync(join(dir, big))
  rmSync(join(dir, small))
  const service = new SyncService({ root: dir, engine: null, mapping: null, settings: { get: (_k, fb) => fb }, git: (args) => run('git', args, dir), pluginsDir: () => null, emit: () => undefined })
  const result = await service.commitStudioEdits()
  assert.deepEqual(result.committed, [small])
  assert.ok(git(dir, 'ls-files').split('\n').includes(big))
})

// ---- rewind ----

test('a rewind copies the files it removes to .forge/sync/trash first', async () => {
  const dir = repo()
  const cp = new Checkpoints(dir)
  const c1 = await cp.create('before turn')
  const added = 'src/server/Features/Character/NewThing.luau'
  writeFileSync(join(dir, added), 'return "agent"\n')
  const r = await cp.restore(c1, () => Date.UTC(2026, 9, 17, 0, 45))
  assert.deepEqual(r.removed, [added])
  assert.ok(!existsSync(join(dir, added)))
  assert.equal(r.trash, '.forge/sync/trash/2026-10-17T00-45-00-000Z-rewind')
  assert.equal(readFileSync(join(dir, r.trash!, added), 'utf8'), 'return "agent"\n')
  assert.equal(git(dir, 'status', '--porcelain', '--', '.forge/sync'), '', 'the copies are never committed')
})
