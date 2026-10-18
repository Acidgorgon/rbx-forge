// Source control panel, main side (services/sourceControl.ts) on temp repos: porcelain v2 parsing
// (renames, spaces in names, conflicts), stage / unstage / discard (a copy in .forge/sync/trash
// first), commit with the user's message, the held-delete warning when staging a guarded script's
// delete, push / pull, and the auto-sync leaving manual work alone (GitSync.doSync).

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import type { SyncSettings } from '../src/shared/types.ts'
import { GitSync } from '../src/main/services/gitSync.ts'
import { cleanPaths, parseStatusV2, SourceControl } from '../src/main/services/sourceControl.ts'
import { GUARD_LINES } from '../src/main/services/sync/deleteGuard.ts'

const temps: string[] = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

function identity(dir: string, name: string): void {
  git(dir, 'config', 'user.name', name)
  git(dir, 'config', 'user.email', `${name}@example.com`)
  git(dir, 'config', 'core.autocrlf', 'false')
}

// A bare remote, my clone and a collaborator's, sharing one commit.
function setup(): { me: string; them: string; remote: string } {
  const base = mkdtempSync(join(tmpdir(), 'forge-scm-'))
  temps.push(base)
  const remote = join(base, 'remote.git')
  git(base, 'init', '--bare', '-b', 'main', remote)
  const seed = join(base, 'seed')
  git(base, 'init', '-b', 'main', seed)
  identity(seed, 'seed')
  put(seed, 'src/game.luau', 'local speed = 1\nreturn speed\n')
  put(seed, 'src/old name.luau', 'return "old"\n')
  git(seed, 'add', '-A')
  git(seed, 'commit', '-m', 'start')
  git(seed, 'remote', 'add', 'origin', remote)
  git(seed, 'push', '-u', 'origin', 'main')
  const me = join(base, 'me')
  const them = join(base, 'them')
  git(base, 'clone', '-c', 'core.autocrlf=false', remote, me)
  git(base, 'clone', '-c', 'core.autocrlf=false', remote, them)
  identity(me, 'me')
  identity(them, 'them')
  return { me, them, remote }
}

const settings: SyncSettings = { autoSyncMinutes: 0, autoCommit: true }

function open(root: string, log: string[] = []): { sync: GitSync; scm: SourceControl } {
  const sync = new GitSync({ root, settings: () => settings, log: (text) => log.push(text) })
  return { sync, scm: new SourceControl({ git: sync, log: (text) => log.push(text) }) }
}

const paths = (files: { path: string; letter: string; from?: string }[]) => files.map((f) => `${f.letter} ${f.path}${f.from ? ` <- ${f.from}` : ''}`)

test('parseStatusV2 reads branch, ahead/behind, renames, spaces and conflicts', () => {
  const out = [
    '# branch.oid 0123456789abcdef0123456789abcdef01234567',
    '# branch.head feature/shop',
    '# branch.upstream origin/feature/shop',
    '# branch.ab +2 -3',
    '1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb src/shop.luau',
    '1 .M N... 100644 100644 100644 aaaaaaa aaaaaaa src/my file.luau',
    '1 MD N... 100644 100644 000000 aaaaaaa bbbbbbb src/both.luau',
    '2 R. N... 100644 100644 100644 aaaaaaa aaaaaaa R100 src/new name.luau',
    'src/old name.luau',
    'u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc src/fight.luau',
    '? notes/to do.txt',
    '! ignored.log',
    ''
  ].join('\0')
  const s = parseStatusV2(out)
  assert.equal(s.branch, 'feature/shop')
  assert.equal(s.head, '0123456')
  assert.equal(s.upstream, 'origin/feature/shop')
  assert.deepEqual([s.ahead, s.behind], [2, 3])
  assert.deepEqual(paths(s.staged), ['M src/shop.luau', 'M src/both.luau', 'R src/new name.luau <- src/old name.luau'])
  assert.deepEqual(paths(s.changes), ['M src/my file.luau', 'D src/both.luau', 'U notes/to do.txt'])
  assert.deepEqual(s.conflicts, [{ path: 'src/fight.luau', letter: '!', label: 'Conflict: both modified' }])

  const fresh = parseStatusV2(['# branch.oid (initial)', '# branch.head main', '1 A. N... 000000 100644 100644 0000000 aaaaaaa a.luau', ''].join('\0'))
  assert.equal(fresh.head, undefined)
  assert.equal(fresh.upstream, undefined)
  assert.deepEqual(paths(fresh.staged), ['A a.luau'])
  assert.equal(parseStatusV2('# branch.oid abc\0# branch.head (detached)\0').branch, undefined)
})

test('cleanPaths refuses paths outside the work tree and .git', () => {
  assert.deepEqual(cleanPaths(['src\\a.luau', './src/b c.luau', 'src/a.luau']), ['src/a.luau', 'src/b c.luau'])
  for (const bad of ['../x', '/etc/passwd', 'C:/x', '.git/config', 'a/../../b', '', 7]) assert.throws(() => cleanPaths([bad]), String(bad))
  assert.throws(() => cleanPaths('src/a.luau'))
})

test('status of a real repo: rename staged, names with spaces, untracked', async () => {
  const { me } = setup()
  git(me, 'mv', 'src/old name.luau', 'src/new name.luau')
  put(me, 'src/game.luau', 'local speed = 2\nreturn speed\n')
  put(me, 'docs/read me.md', '# hi\n')
  const { scm } = open(me)
  const s = await scm.status()
  assert.equal(s.isRepo, true)
  assert.equal(s.branch, 'main')
  assert.equal(s.upstream, 'origin/main')
  assert.equal(s.hasRemote, true)
  assert.deepEqual(paths(s.staged), ['R src/new name.luau <- src/old name.luau'])
  assert.deepEqual(paths(s.changes).sort(), ['M src/game.luau', 'U docs/read me.md'])
  assert.equal(s.autoSync?.includes('staged'), true)

  // Unstaging the rename puts both names back.
  const r = await scm.unstage(['src/new name.luau'])
  assert.equal(r.error, undefined)
  assert.deepEqual(r.status.staged, [])
  assert.deepEqual(paths(r.status.changes).sort(), ['D src/old name.luau', 'M src/game.luau', 'U docs/read me.md', 'U src/new name.luau'])
})

test('stage, unstage, stage all, unstage all', async () => {
  const { me } = setup()
  put(me, 'src/game.luau', 'local speed = 2\nreturn speed\n')
  put(me, 'src/[Gold] sword.luau', 'return 1\n')
  rmSync(join(me, 'src/old name.luau'))
  const { scm } = open(me)

  let r = await scm.stage(['src/[Gold] sword.luau'])
  assert.equal(r.error, undefined)
  assert.deepEqual(paths(r.status.staged), ['A src/[Gold] sword.luau'])
  r = await scm.stage(['src/old name.luau'])
  assert.deepEqual(paths(r.status.staged).sort(), ['A src/[Gold] sword.luau', 'D src/old name.luau'])
  r = await scm.unstage(['src/[Gold] sword.luau'])
  assert.deepEqual(paths(r.status.staged), ['D src/old name.luau'])
  r = await scm.stage('all')
  assert.deepEqual(paths(r.status.staged).sort(), ['A src/[Gold] sword.luau', 'D src/old name.luau', 'M src/game.luau'])
  assert.deepEqual(r.status.changes, [])
  r = await scm.unstage('all')
  assert.deepEqual(r.status.staged, [])
  assert.equal(r.status.changes.length, 3)
})

test('commit uses the message, commits only the staged files, and asks before committing all', async () => {
  const { me } = setup()
  put(me, 'src/game.luau', 'local speed = 2\nreturn speed\n')
  put(me, 'src/shop.luau', 'return {}\n')
  const { scm } = open(me)

  assert.match((await scm.commit('  ')).error ?? '', /message/)
  // Nothing staged and not "all": nothing happens.
  const none = await scm.commit('Faster')
  assert.match(none.error ?? '', /Nothing is staged/)
  assert.equal(git(me, 'log', '-1', '--format=%s').trim(), 'start')

  await scm.stage(['src/shop.luau'])
  const done = await scm.commit('Add the shop\n\nEmpty for now.')
  assert.equal(done.error, undefined)
  assert.ok(done.commit)
  assert.equal(git(me, 'log', '-1', '--format=%B').trim(), 'Add the shop\n\nEmpty for now.')
  assert.equal(git(me, 'show', '--name-only', '--format=', 'HEAD').trim(), 'src/shop.luau')
  assert.deepEqual(paths(done.status.changes), ['M src/game.luau'])
  assert.equal(done.status.ahead, 1)

  const all = await scm.commit('Faster', { all: true })
  assert.equal(all.error, undefined)
  assert.equal(git(me, 'log', '-1', '--format=%s').trim(), 'Faster')
  assert.equal(git(me, 'status', '--porcelain').trim(), '')
})

test('discard keeps a copy in .forge/sync/trash, restores tracked files and removes untracked ones', async () => {
  const { me } = setup()
  put(me, 'src/game.luau', 'local speed = 99\nreturn speed\n')
  put(me, 'src/scratch file.luau', 'return "scratch"\n')
  rmSync(join(me, 'src/old name.luau'))
  const log: string[] = []
  const { scm } = open(me, log)

  const r = await scm.discard(['src/game.luau', 'src/scratch file.luau', 'src/old name.luau'])
  assert.equal(r.error, undefined)
  assert.deepEqual(r.status.changes, [])
  assert.equal(readFileSync(join(me, 'src/game.luau'), 'utf8'), 'local speed = 1\nreturn speed\n')
  assert.equal(readFileSync(join(me, 'src/old name.luau'), 'utf8'), 'return "old"\n')
  assert.equal(existsSync(join(me, 'src/scratch file.luau')), false)
  // Both files that were on disk have a copy, in one trash folder.
  assert.equal(r.backups?.length, 2)
  const stamps = readdirSync(join(me, '.forge/sync/trash')).filter((n) => n !== '.gitignore')
  assert.equal(stamps.length, 1)
  assert.equal(readFileSync(join(me, '.forge/sync/trash', stamps[0], 'src/game.luau'), 'utf8'), 'local speed = 99\nreturn speed\n')
  assert.equal(readFileSync(join(me, '.forge/sync/trash', stamps[0], 'src/scratch file.luau'), 'utf8'), 'return "scratch"\n')
  assert.ok(log.some((l) => /discarded 3 changes; copies in \.forge\/sync\/trash\//.test(l)))
  // The trash is never a change itself.
  assert.equal(git(me, 'status', '--porcelain').trim(), '')

  // Staged changes stay: only the working-tree part is discarded.
  put(me, 'src/game.luau', 'local speed = 2\nreturn speed\n')
  await scm.stage(['src/game.luau'])
  put(me, 'src/game.luau', 'local speed = 3\nreturn speed\n')
  const partial = await scm.discard(['src/game.luau'])
  assert.equal(readFileSync(join(me, 'src/game.luau'), 'utf8'), 'local speed = 2\nreturn speed\n')
  assert.deepEqual(paths(partial.status.staged), ['M src/game.luau'])
  assert.deepEqual(partial.status.changes, [])
})

test('staging a guarded script deleted outside Forge warns first (held delete)', async () => {
  const { me } = setup()
  const big = 'src/server/CharacterService.luau'
  put(me, big, ['local CharacterService = {}', ...Array.from({ length: GUARD_LINES + 5 }, (_, i) => `CharacterService.v${i} = ${i}`), 'return CharacterService', ''].join('\n'))
  git(me, 'add', '-A')
  git(me, 'commit', '-m', 'big')
  rmSync(join(me, big))
  put(me, 'src/game.luau', 'local speed = 2\nreturn speed\n')
  const log: string[] = []
  const { scm } = open(me, log)

  const r = await scm.stage('all')
  assert.deepEqual(r.held?.map((h) => h.path), [big])
  assert.match(r.held![0].why, /lines/)
  assert.deepEqual(paths(r.status.staged), ['M src/game.luau'])
  assert.ok(log.some((l) => l.startsWith(`git: not staging the delete of ${big}`) && l.includes('no copy in .forge/sync/trash')))
  const one = await scm.stage([big])
  assert.deepEqual(one.held?.map((h) => h.path), [big])
  assert.deepEqual(paths(one.status.staged), ['M src/game.luau'])

  // Commit all with nothing staged asks too, and stages nothing until confirmed.
  await scm.unstage('all')
  const asked = await scm.commit('Remove the character service', { all: true })
  assert.deepEqual(asked.held?.map((h) => h.path), [big])
  assert.equal(asked.commit, undefined)
  assert.deepEqual(asked.status.staged, [])

  // Confirmed: staged and committed like `git rm`.
  const confirmed = await scm.stage([big], true)
  assert.equal(confirmed.held, undefined)
  assert.deepEqual(paths(confirmed.status.staged), [`D ${big}`])
  const done = await scm.commit('Remove the character service')
  assert.equal(done.error, undefined)
  assert.match(git(me, 'show', '--name-status', '--format=', 'HEAD'), /^D\tsrc\/server\/CharacterService\.luau$/m)
})

test('a conflicted file with markers is not staged; merge conflicts block the commit', async () => {
  const { me, them } = setup()
  put(them, 'src/game.luau', 'local speed = 2\nreturn speed\n')
  git(them, 'commit', '-am', 'faster')
  git(them, 'push')
  put(me, 'src/game.luau', 'local speed = 3\nreturn speed\n')
  git(me, 'commit', '-am', 'mine')
  git(me, 'fetch')
  try {
    git(me, 'merge', '--no-edit', 'origin/main')
  } catch {
    // conflict expected
  }
  const { scm } = open(me)
  const s = await scm.status()
  assert.equal(s.merging, true)
  assert.deepEqual(s.conflicts.map((f) => f.path), ['src/game.luau'])
  const refused = await scm.stage(['src/game.luau'])
  assert.match(refused.error ?? '', /conflict markers/)
  assert.match((await scm.commit('merge', { all: true })).error ?? '', /Resolve the merge conflicts/)

  put(me, 'src/game.luau', 'local speed = 4\nreturn speed\n')
  const resolved = await scm.stage(['src/game.luau'])
  assert.equal(resolved.error, undefined)
  assert.deepEqual(resolved.status.conflicts, [])
  const done = await scm.commit('Merge the collaborator')
  assert.equal(done.error, undefined)
  assert.equal(git(me, 'log', '-1', '--format=%p').trim().split(' ').length, 2)
})

test('diff sides: staged is HEAD -> index, unstaged is index -> working tree', async () => {
  const { me } = setup()
  put(me, 'src/game.luau', 'local speed = 2\nreturn speed\n')
  await open(me).scm.stage(['src/game.luau'])
  put(me, 'src/game.luau', 'local speed = 3\nreturn speed\n')
  put(me, 'src/new one.luau', 'return 1\n')
  const { scm } = open(me)
  const staged = await scm.diff('src/game.luau', true)
  assert.deepEqual([staged.original, staged.modified], ['local speed = 1\nreturn speed\n', 'local speed = 2\nreturn speed\n'])
  const work = await scm.diff('src/game.luau', false)
  assert.deepEqual([work.original, work.modified, work.originalLabel], ['local speed = 2\nreturn speed\n', 'local speed = 3\nreturn speed\n', 'Staged'])
  const added = await scm.diff('src/new one.luau', false)
  assert.deepEqual([added.original, added.modified], ['', 'return 1\n'])
  writeFileSync(join(me, 'blob.bin'), Buffer.from([0, 1, 2, 0]))
  assert.equal((await scm.diff('blob.bin', false)).binary, true)
})

test('commit & push, and pull with files staged only fast-forwards (staging kept)', async () => {
  const { me, them } = setup()
  put(me, 'src/shop.luau', 'return {}\n')
  const { scm } = open(me)
  await scm.stage(['src/shop.luau'])
  const pushed = await scm.commit('Shop', { push: true })
  assert.equal(pushed.error, undefined)
  assert.equal(pushed.status.ahead, 0)
  git(them, 'pull')
  assert.equal(readFileSync(join(them, 'src/shop.luau'), 'utf8'), 'return {}\n')

  // The collaborator pushes; I have a file staged.
  put(them, 'src/inventory.luau', 'return {}\n')
  git(them, 'add', '-A')
  git(them, 'commit', '-m', 'inventory')
  git(them, 'push')
  put(me, 'src/game.luau', 'local speed = 5\nreturn speed\n')
  await scm.stage(['src/game.luau'])
  const fetched = await scm.fetch()
  assert.equal(fetched.status.behind, 1)
  const pulled = await scm.pull()
  assert.equal(pulled.error, undefined)
  assert.equal(pulled.status.behind, 0)
  assert.ok(existsSync(join(me, 'src/inventory.luau')))
  assert.deepEqual(paths(pulled.status.staged), ['M src/game.luau'])

  // Diverged with files staged: refused with git's own first line, nothing changes.
  put(them, 'src/a.luau', 'return 1\n')
  git(them, 'add', '-A')
  git(them, 'commit', '-m', 'a')
  git(them, 'push')
  await scm.commit('Speed 5')
  put(me, 'src/b.luau', 'return 2\n')
  await scm.stage(['src/b.luau'])
  const refused = await scm.pull()
  assert.match(refused.error ?? '', /fast-forward/i)
  assert.deepEqual(paths(refused.status.staged), ['A src/b.luau'])
  // A push now is rejected (no force): "Pull first".
  const rejected = await scm.push()
  assert.match(rejected.error ?? '', /^Pull first/)
})

test('auto-sync skips its commit and the pull while files are staged, and pushes when nothing waits', async () => {
  const { me, them } = setup()
  const log: string[] = []
  const { sync, scm } = open(me, log)
  put(me, 'src/game.luau', 'local speed = 2\nreturn speed\n')
  put(me, 'src/shop.luau', 'return {}\n')
  await scm.stage(['src/shop.luau'])

  const s = await sync.syncNow()
  assert.equal(s.error, undefined)
  assert.match(s.note ?? '', /did not commit your changes \(files are staged/)
  assert.equal(git(me, 'log', '-1', '--format=%s').trim(), 'start')
  // The selection is untouched.
  assert.deepEqual(paths((await scm.status()).staged), ['A src/shop.luau'])

  // My own commit goes out with the next sync; the unstaged edit stays uncommitted.
  await scm.commit('Shop')
  put(me, 'src/other.luau', 'return 0\n')
  await scm.stage(['src/other.luau'])
  const pushed = await sync.syncNow()
  assert.equal(pushed.ahead, 0)
  assert.equal(git(them, 'pull').length > 0, true)
  assert.ok(existsSync(join(them, 'src/shop.luau')))
  assert.equal(existsSync(join(them, 'src/other.luau')), false)

  // Something to pull while files are staged: the sync waits (no autostash) and says so once.
  put(them, 'src/inventory.luau', 'return {}\n')
  git(them, 'add', '-A')
  git(them, 'commit', '-m', 'inventory')
  git(them, 'push')
  const waiting = await sync.syncNow()
  assert.equal(waiting.behind, 1)
  assert.match(waiting.note ?? '', /did not pull 1 incoming commit/)
  assert.deepEqual(paths((await scm.status()).staged), ['A src/other.luau'])
  await sync.syncNow()
  assert.equal(log.filter((l) => l.includes('did not pull 1 incoming commit')).length, 1)

  // Unstaged: the sync commits as before.
  await scm.unstage('all')
  const normal = await sync.syncNow()
  assert.equal(normal.error, undefined)
  assert.equal(normal.note, undefined)
  assert.equal(normal.behind, 0)
  assert.equal(normal.dirty, 0)
  assert.match(git(me, 'log', '-1', '--format=%s'), /harness: sync/)
})

test('auto-sync skips its commit while a message is typed, but still pulls and pushes', async () => {
  const { me, them } = setup()
  const { sync, scm } = open(me)
  put(them, 'src/inventory.luau', 'return {}\n')
  git(them, 'add', '-A')
  git(them, 'commit', '-m', 'inventory')
  git(them, 'push')
  put(me, 'src/game.luau', 'local speed = 2\nreturn speed\n')
  sync.setDraft(true)
  assert.match((await scm.status()).autoSync ?? '', /message is typed/)

  const s = await sync.syncNow()
  assert.equal(s.error, undefined)
  assert.match(s.note ?? '', /a commit message is typed/)
  assert.equal(s.behind, 0)
  assert.ok(existsSync(join(me, 'src/inventory.luau')))
  // The edit is still mine to commit.
  assert.equal(readFileSync(join(me, 'src/game.luau'), 'utf8'), 'local speed = 2\nreturn speed\n')
  assert.deepEqual(paths((await scm.status()).changes), ['M src/game.luau'])

  sync.setDraft(false)
  assert.equal((await scm.status()).autoSync, undefined)
})

test('steps run one at a time on the GitSync queue', async () => {
  const { me } = setup()
  const { sync } = open(me)
  const order: string[] = []
  const slow = sync.exclusive(async () => {
    order.push('a-start')
    await new Promise((r) => setTimeout(r, 50))
    order.push('a-end')
  })
  const fast = sync.exclusive(async () => {
    order.push('b')
  })
  const failing = sync.exclusive(async () => {
    throw new Error('boom')
  })
  await Promise.all([slow, fast, failing.catch(() => undefined)])
  await sync.exclusive(async () => order.push('c'))
  assert.deepEqual(order, ['a-start', 'a-end', 'b', 'c'])
})

test('long path lists go through a pathspec file (Windows command-line limit)', async () => {
  const { me } = setup()
  const many = Array.from({ length: 160 }, (_, i) => `src/generated/a rather long folder name for item ${String(i).padStart(3, '0')}/Item [${i}].luau`)
  for (const p of many) put(me, p, `return ${many.indexOf(p)}\n`)
  const { scm } = open(me)
  assert.ok(many.join('').length > 8000)
  const r = await scm.stage(many)
  assert.equal(r.error, undefined)
  assert.equal(r.status.staged.length, many.length)
  const back = await scm.unstage(many)
  assert.equal(back.error, undefined)
  assert.equal(back.status.staged.length, 0)
})
