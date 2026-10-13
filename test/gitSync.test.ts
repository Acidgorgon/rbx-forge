import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { SyncSettings } from '../src/shared/types.ts'
import { GitSync } from '../src/main/services/gitSync.ts'

const temps: string[] = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function identity(dir: string, name: string): void {
  git(dir, 'config', 'user.name', name)
  git(dir, 'config', 'user.email', `${name}@example.com`)
}

// A bare remote plus two clones (me and a collaborator) sharing one commit.
function setup(): { me: string; them: string } {
  const base = mkdtempSync(join(tmpdir(), 'harness-git-'))
  temps.push(base)
  const remote = join(base, 'remote.git')
  git(base, 'init', '--bare', '-b', 'main', remote)
  const seed = join(base, 'seed')
  git(base, 'init', '-b', 'main', seed)
  identity(seed, 'seed')
  writeFileSync(join(seed, 'game.luau'), 'local speed = 1\nreturn speed\n')
  git(seed, 'add', '-A')
  git(seed, 'commit', '-m', 'start')
  git(seed, 'remote', 'add', 'origin', remote)
  git(seed, 'push', '-u', 'origin', 'main')
  const me = join(base, 'me')
  const them = join(base, 'them')
  git(base, 'clone', remote, me)
  git(base, 'clone', remote, them)
  identity(me, 'me')
  identity(them, 'them')
  return { me, them }
}

const settings: SyncSettings = { autoSyncMinutes: 0, autoCommit: true }

test('clean sync commits local work, pulls the collaborator and pushes', async () => {
  const { me, them } = setup()
  writeFileSync(join(them, 'shop.luau'), 'return {}\n')
  git(them, 'add', '-A')
  git(them, 'commit', '-m', 'shop')
  git(them, 'push')

  writeFileSync(join(me, 'inventory.luau'), 'return {}\n')
  const sync = new GitSync({ root: me, settings: () => settings })
  const before = await sync.status()
  assert.equal(before.isRepo, true)
  assert.equal(before.hasRemote, true)
  assert.equal(before.branch, 'main')
  assert.equal(before.dirty, 1)

  const after = await sync.syncNow()
  assert.equal(after.error, undefined)
  assert.deepEqual(after.conflicts, [])
  assert.equal(after.ahead, 0)
  assert.equal(after.behind, 0)
  assert.equal(after.dirty, 0)
  assert.ok(after.lastSync)
  assert.equal(readFileSync(join(me, 'shop.luau'), 'utf8'), 'return {}\n')
  assert.match(git(me, 'log', '--format=%s'), /harness: sync/)

  git(them, 'pull')
  assert.equal(readFileSync(join(them, 'inventory.luau'), 'utf8'), 'return {}\n')
})

test('conflicting edits are left as merge conflicts and reported', async () => {
  const { me, them } = setup()
  writeFileSync(join(them, 'game.luau'), 'local speed = 2\nreturn speed\n')
  git(them, 'commit', '-am', 'faster')
  git(them, 'push')

  writeFileSync(join(me, 'game.luau'), 'local speed = 3\nreturn speed\n')
  const sync = new GitSync({ root: me, settings: () => settings })
  const status = await sync.syncNow()
  assert.deepEqual(status.conflicts, ['game.luau'])
  assert.match(status.error ?? '', /conflict/i)
  assert.match(readFileSync(join(me, 'game.luau'), 'utf8'), /<<<<<<<|>>>>>>>/)

  // Nothing was pushed: the remote still has only the collaborator's change.
  git(them, 'pull')
  assert.equal(readFileSync(join(them, 'game.luau'), 'utf8'), 'local speed = 2\nreturn speed\n')

  // A second sync refuses to continue until the conflict is resolved.
  const again = await sync.syncNow()
  assert.match(again.error ?? '', /Resolve the conflicts/)
})

test('initGit creates a repo and pushes to a new remote', async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-init-'))
  temps.push(base)
  const remote = join(base, 'remote.git')
  git(base, 'init', '--bare', '-b', 'main', remote)
  const project = join(base, 'project')
  execFileSync('mkdir', [project])
  writeFileSync(join(project, 'default.project.json'), '{"name":"X","tree":{"$className":"DataModel"}}\n')
  const env = { GIT_AUTHOR_NAME: 'me', GIT_AUTHOR_EMAIL: 'me@example.com', GIT_COMMITTER_NAME: 'me', GIT_COMMITTER_EMAIL: 'me@example.com' }
  Object.assign(process.env, env)
  const sync = new GitSync({ root: project, settings: () => settings })
  const status = await sync.initGit(remote)
  assert.equal(status.error, undefined)
  assert.equal(status.isRepo, true)
  assert.equal(status.hasRemote, true)
  assert.equal(status.ahead, 0)
  assert.match(git(remote, 'log', '--format=%s', 'main'), /Initial commit/)
})
