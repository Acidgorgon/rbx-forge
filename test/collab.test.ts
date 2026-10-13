import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { findTool } from '../src/main/services/tools.ts'
import { incomingChanges } from '../src/main/services/collab/incoming.ts'
import { activityFeed } from '../src/main/services/collab/activity.ts'
import { BlameCache, fileHistory } from '../src/main/services/collab/blame.ts'
import { claim, CLAIMS_PATH, commitClaims, listClaims, release } from '../src/main/services/collab/claims.ts'
import { joinProject } from '../src/main/services/collab/join.ts'
import { readProjectConfig, writeProjectConfig } from '../src/main/services/collab/config.ts'
import { startFeatureBranch, openPullRequest } from '../src/main/services/collab/branches.ts'
import { changedLuaFiles, preSyncCheck } from '../src/main/services/collab/quality.ts'

const temps: string[] = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function identity(dir: string, name: string): void {
  git(dir, 'config', 'user.name', name)
  git(dir, 'config', 'user.email', `${name.toLowerCase().replace(/\s+/g, '')}@example.com`)
}

function write(root: string, rel: string, text: string): void {
  const file = join(root, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}

function commitAll(dir: string, message: string): void {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', message)
}

// Only git is "installed": rokit, wally, gh, selene, stylua are absent.
const gitOnly = { findTool: (name: string) => (name === 'git' ? findTool('git') : null) }

// A bare remote with a GenTree-shaped seed, plus clones for Alex and Sam.
function setup(): { base: string; remote: string; alex: string; sam: string } {
  const base = mkdtempSync(join(tmpdir(), 'forge-collab-'))
  temps.push(base)
  const remote = join(base, 'remote.git')
  git(base, 'init', '--bare', '-b', 'main', remote)
  const seed = join(base, 'seed')
  git(base, 'init', '-b', 'main', seed)
  identity(seed, 'Seed')
  write(seed, 'default.project.json', JSON.stringify({ name: 'GenTree', tree: { $className: 'DataModel', ReplicatedStorage: { Shared: { $path: 'src/shared' }, Packages: { $path: 'Packages' } } } }))
  write(seed, 'src/shared/Modules/Util.luau', 'local Util = {}\n\nfunction Util.add(a, b)\n\treturn a + b\nend\n\nreturn Util\n')
  write(seed, 'src/shared/Features/Shop/init.luau', 'return { price = 10 }\n')
  write(seed, 'rokit.toml', '[tools]\nrojo = "rojo-rbx/rojo@7.7.0"\n')
  write(seed, 'wally.toml', '[package]\nname = "a/b"\nversion = "0.1.0"\nrealm = "shared"\n')
  commitAll(seed, 'start')
  git(seed, 'remote', 'add', 'origin', remote)
  git(seed, 'push', '-u', 'origin', 'main')
  const alex = join(base, 'alex')
  const sam = join(base, 'sam')
  git(base, 'clone', remote, alex)
  git(base, 'clone', remote, sam)
  identity(alex, 'Alex')
  identity(sam, 'Sam Lee')
  return { base, remote, alex, sam }
}

test('incomingChanges lists upstream commits, grouped files, diffs, local work and overlap', async () => {
  const { alex, sam } = setup()
  write(sam, 'src/shared/Features/Shop/init.luau', 'return { price = 25 }\n')
  write(sam, 'src/server/Features/Inventory/InventoryService.luau', 'return {}\n')
  write(sam, 'src/shared/Modules/Util.luau', 'local Util = {}\nreturn Util\n')
  commitAll(sam, 'Shop price and inventory service')
  git(sam, 'push')

  write(alex, 'src/shared/Modules/Util.luau', '-- mine\n')
  write(alex, 'notes.txt', 'hi\n')

  let summarized = ''
  const result = await incomingChanges(alex, {
    maxDiffBytes: 4000,
    summarize: async (input) => {
      summarized = input.commits.map((c) => c.subject).join(',')
      return 'Sam raised the shop price.'
    }
  })
  assert.equal(result.isRepo, true)
  assert.equal(result.fetched, true)
  assert.equal(result.upstream, 'origin/main')
  assert.equal(result.commits.length, 1)
  assert.equal(result.commits[0].author, 'Sam Lee')
  assert.equal(result.commits[0].subject, 'Shop price and inventory service')
  assert.ok(result.commits[0].at > 0)

  const paths = result.files.map((f) => f.path).sort()
  assert.deepEqual(paths, ['src/server/Features/Inventory/InventoryService.luau', 'src/shared/Features/Shop/init.luau', 'src/shared/Modules/Util.luau'])
  const shop = result.files.find((f) => f.path.includes('Shop'))!
  assert.equal(shop.status, 'modified')
  assert.equal(shop.added, 1)
  assert.equal(shop.deleted, 1)
  assert.equal(shop.feature, 'Shop')
  assert.match(shop.diff!, /\+return \{ price = 25 \}/)
  const util = result.files.find((f) => f.path.endsWith('Util.luau'))!
  assert.equal(util.category, 'Modules')
  assert.ok(result.files.find((f) => f.path.includes('Inventory'))!.status === 'added')

  const keys = result.groups.map((g) => g.key)
  assert.deepEqual(keys, ['feature:Inventory', 'feature:Shop', 'category:Modules'])

  assert.deepEqual(result.local.map((f) => [f.path, f.status]).sort(), [['notes.txt', 'untracked'], ['src/shared/Modules/Util.luau', 'modified']])
  assert.deepEqual(result.overlap, ['src/shared/Modules/Util.luau'])
  assert.equal(result.summary, 'Sam raised the shop price.')
  assert.equal(summarized, 'Shop price and inventory service')
})

test('incomingChanges caps diffs and reports a failing summarizer without throwing', async () => {
  const { alex, sam } = setup()
  write(sam, 'src/shared/Modules/Big.luau', Array.from({ length: 400 }, (_, i) => `local v${i} = ${i}`).join('\n') + '\n')
  commitAll(sam, 'big')
  git(sam, 'push')
  const result = await incomingChanges(alex, { maxDiffBytes: 500, summarize: async () => { throw new Error('no key') } })
  const big = result.files[0]
  assert.equal(big.added, 400)
  assert.equal(big.diffTruncated, true)
  assert.ok(Buffer.byteLength(big.diff!) < 600)
  assert.equal(result.summaryError, 'no key')
})

test('incomingChanges with nothing upstream and with no upstream branch', async () => {
  const { alex } = setup()
  const none = await incomingChanges(alex)
  assert.equal(none.commits.length, 0)
  git(alex, 'switch', '-c', 'solo')
  const solo = await incomingChanges(alex)
  assert.equal(solo.upstream, null)
  assert.match(solo.note!, /no upstream/)
})

test('activityFeed merges commits and Studio sync log, filters by author and feature', async () => {
  const { alex, sam } = setup()
  write(sam, 'src/shared/Features/Shop/init.luau', 'return { price = 30 }\n')
  commitAll(sam, 'Shop price')
  git(sam, 'push')
  git(alex, 'pull')

  const anchor = new Date()
  anchor.setHours(12, 0, 30, 0)
  // Two lines from "yesterday evening" (clock goes back after them), then today.
  write(alex, '.studio-sync/sync.log', [
    '22:10:00 studio-sync listening on 127.0.0.1:34873 for ReplicatedStorage.Shared',
    '22:15:00 pull  src/shared/Features/Shop/init.luau',
    '09:00:00 new   src/shared/Modules/Fresh.luau',
    '09:05:00 skip  src/shared/Nope/x.luau  (no matching folder in the repo; create it by hand to track this script)',
    '12:00:30 conflict  src/shared/Modules/Util.luau',
    ''
  ].join('\n'))
  utimesSync(join(alex, '.studio-sync/sync.log'), anchor, anchor)

  const all = await activityFeed(alex, { since: Date.now() - 3 * 24 * 3600 * 1000 })
  const studio = all.filter((e) => e.kind === 'studio')
  assert.equal(studio.length, 3)
  assert.ok(studio.every((e) => e.who === 'Studio'))
  const pull = studio.find((e) => e.studioAction === 'pull')!
  const expectedPull = new Date(anchor)
  expectedPull.setDate(expectedPull.getDate() - 1)
  expectedPull.setHours(22, 15, 0, 0)
  assert.equal(pull.at, expectedPull.getTime())
  assert.equal(studio.find((e) => e.studioAction === 'conflict')!.at, anchor.getTime())

  const commits = all.filter((e) => e.kind === 'commit')
  assert.deepEqual(commits.map((c) => c.who), ['Sam Lee', 'Seed'])
  assert.deepEqual(commits[0].files, [{ path: 'src/shared/Features/Shop/init.luau', change: 'M' }])
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].at >= all[i].at, 'newest first')

  const bySam = await activityFeed(alex, { author: 'sam' })
  assert.deepEqual(bySam.map((e) => e.message), ['Shop price'])
  const byStudio = await activityFeed(alex, { author: 'Studio' })
  assert.equal(byStudio.length, 3)
  const shop = await activityFeed(alex, { feature: 'shop' })
  assert.deepEqual(shop.map((e) => e.kind).sort(), ['commit', 'commit', 'studio'])
  const recent = await activityFeed(alex, { since: anchor.getTime() - 1000 })
  assert.ok(recent.every((e) => e.at >= anchor.getTime() - 1000))
})

test('blame per line with cache keyed by HEAD, and fileHistory follows renames', async () => {
  const { alex, sam } = setup()
  write(sam, 'src/shared/Modules/Util.luau', 'local Util = {}\n\nfunction Util.add(a, b)\n\treturn a + b + 0\nend\n\nreturn Util\n')
  commitAll(sam, 'tweak add')
  git(sam, 'push')
  git(alex, 'pull')

  const cache = new BlameCache()
  const result = await cache.blame(alex, 'src/shared/Modules/Util.luau')
  assert.equal(result.lines.length, 7)
  assert.equal(result.lines[0].author, 'Seed')
  assert.equal(result.lines[0].summary, 'start')
  assert.equal(result.lines[3].author, 'Sam Lee')
  assert.equal(result.lines[3].summary, 'tweak add')
  assert.equal(result.lines[3].content, '\treturn a + b + 0')
  assert.equal(result.lines[3].line, 4)
  assert.match(result.lines[3].commit, /^[0-9a-f]{40}$/)
  assert.ok(result.lines[3].at > 0)
  assert.equal(await cache.blame(alex, 'src/shared/Modules/Util.luau'), result, 'cached object reused')

  git(alex, 'mv', 'src/shared/Modules/Util.luau', 'src/shared/Modules/Math.luau')
  commitAll(alex, 'rename util')
  const history = await fileHistory(alex, 'src/shared/Modules/Math.luau')
  assert.deepEqual(history.map((h) => h.subject), ['rename util', 'tweak add', 'start'])
  assert.equal(history[0].change, 'R')
  assert.equal(history[2].path, 'src/shared/Modules/Util.luau')
  await assert.rejects(cache.blame(alex, '../outside.luau'), /outside the project/)
})

test('claims round-trip through git, and a double claim is visible to both and flagged', async () => {
  const { alex, sam } = setup()
  const now = Date.now()
  let views = await claim(alex, 'src/shared/Features/Shop', { note: 'new prices', now })
  assert.equal(views.length, 1)
  assert.equal(views[0].who, 'Alex')
  assert.equal(views[0].mine, true)
  assert.equal(views[0].contested, false)
  // Re-claiming keeps since, updates the note.
  views = await claim(alex, 'src/shared/Features/Shop/', { note: 'prices + UI', now: now + 1000 })
  assert.equal(views.length, 1)
  assert.equal(views[0].note, 'prices + UI')
  assert.equal(views[0].since, new Date(now).toISOString())
  assert.match(readFileSync(join(alex, '.gitattributes'), 'utf8'), /\.forge\/claims\.json merge=union/)

  // Unrelated work stays uncommitted.
  write(alex, 'src/shared/Modules/Wip.luau', 'return 1\n')
  assert.equal(await commitClaims(alex), true)
  assert.equal(await commitClaims(alex), false)
  const status = git(alex, 'status', '--porcelain')
  assert.match(status, /Wip\.luau/)
  assert.doesNotMatch(status, /claims/)

  // Sam claims a file inside the same folder at the same time, without having pulled.
  await claim(sam, 'src/shared/Features/Shop/init.luau', { now })
  await commitClaims(sam)
  git(alex, 'stash', '-u')
  git(alex, 'push')
  // Rebase over Alex's claim: the union merge rule keeps both without a conflict.
  git(sam, 'pull', '--rebase')
  git(sam, 'push')
  git(alex, 'pull', '--rebase')

  for (const [root, me] of [[alex, 'Alex'], [sam, 'Sam Lee']] as const) {
    const list = await listClaims(root, { now })
    assert.deepEqual(list.map((c) => c.who).sort(), ['Alex', 'Sam Lee'])
    assert.ok(list.every((c) => c.contested), 'both flagged')
    assert.equal(list.find((c) => c.who === 'Alex')!.others[0], 'Sam Lee')
    assert.equal(list.find((c) => c.mine)!.who, me)
  }
  // Same exact thing claimed by both also flags.
  await claim(alex, 'feature:Shop', { now, who: 'Sam Lee' })
  await claim(alex, 'Feature:Shop', { now })
  assert.ok((await listClaims(alex, { now })).filter((c) => c.what === 'feature:Shop').every((c) => c.contested))

  // Stale after 3 days.
  const later = await listClaims(alex, { now: now + 4 * 24 * 3600 * 1000 })
  assert.ok(later.every((c) => c.stale))

  const released = await release(alex, 'src/shared/Features/Shop')
  assert.ok(!released.some((c) => c.who === 'Alex' && c.what === 'src/shared/Features/Shop'))
  assert.equal(released.find((c) => c.what === 'src/shared/Features/Shop/init.luau')!.contested, false)
  JSON.parse(readFileSync(join(alex, CLAIMS_PATH), 'utf8'))
})

test('joinProject clones a local bare repo, skips missing rokit/wally with notes, validates the project', async () => {
  const { base, remote } = setup()
  const events: string[] = []
  const result = await joinProject(
    { repoUrl: remote, parentDir: join(base, 'joined') },
    { ...gitOnly, onProgress: (p) => events.push(`${p.step}:${p.state}`) }
  )
  assert.equal(result.root, join(base, 'joined', 'remote'))
  assert.equal(result.projectName, 'GenTree')
  assert.deepEqual(result.steps.map((s) => `${s.step}:${s.state}`), ['clone:done', 'rokit:skipped', 'wally:skipped', 'validate:done'])
  assert.ok(result.notes.some((n) => /rokit is not installed/.test(n)))
  assert.ok(result.notes.some((n) => /wally is not installed/.test(n)))
  assert.ok(result.notes.some((n) => /src\/shared does not exist|Rojo folder/.test(n)) === false)
  assert.ok(events.includes('clone:running') && events.includes('validate:done'))
  assert.equal(git(result.root, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main')

  await assert.rejects(joinProject({ repoUrl: remote, parentDir: join(base, 'joined') }, gitOnly), /already exists/)
  const named = await joinProject({ repoUrl: remote, parentDir: join(base, 'joined'), name: 'MyCopy' }, gitOnly)
  assert.equal(named.root, join(base, 'joined', 'MyCopy'))
  await assert.rejects(joinProject({ repoUrl: join(base, 'nope.git'), parentDir: join(base, 'joined') }, gitOnly))
})

test('shared project config: defaults, round-trip, validation errors', async () => {
  const { alex } = setup()
  const missing = await readProjectConfig(alex)
  assert.equal(missing.exists, false)
  assert.deepEqual(missing.config, { conventions: '', aiRules: '', testScenarios: [], lint: { selene: true, stylua: false } })
  const saved = await writeProjectConfig(alex, { conventions: 'PascalCase modules', testScenarios: [{ name: 'Buy', steps: ['Join', 'Buy'] }], branchPrefix: 'alex/' })
  assert.equal(saved.aiRules, '')
  const back = await readProjectConfig(alex)
  assert.equal(back.exists, true)
  assert.equal(back.config.branchPrefix, 'alex/')
  assert.match(readFileSync(join(alex, '.forge/README.md'), 'utf8'), /claims\.json/)
  await assert.rejects(writeProjectConfig(alex, { lint: { selene: 'yes' } }), /lint\.selene/)
  writeFileSync(join(alex, '.forge/project.json'), '{bad')
  const broken = await readProjectConfig(alex)
  assert.equal(broken.issues?.[0].path, '(file)')
  assert.equal(broken.config.lint.selene, true)
})

test('startFeatureBranch syncs then branches with the configured prefix; PR falls back to a compare URL', async () => {
  const { alex, sam, remote } = setup()
  write(sam, 'src/shared/Modules/New.luau', 'return 2\n')
  commitAll(sam, 'new')
  git(sam, 'push')
  await writeProjectConfig(alex, { branchPrefix: 'alex/' })
  const started = await startFeatureBranch(alex, 'Shop UI polish!', gitOnly)
  assert.equal(started.branch, 'alex/Shop-UI-polish')
  assert.equal(started.from, 'main')
  assert.equal(started.synced, true)
  assert.equal(git(alex, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'alex/Shop-UI-polish')
  assert.match(git(alex, 'log', '--format=%s', '-1', 'main'), /new/)
  await assert.rejects(startFeatureBranch(alex, 'Shop UI polish', gitOnly), /already exists/)

  // A local bare remote is not GitHub: with no gh, openPullRequest explains instead of guessing.
  write(alex, 'src/shared/Modules/Ui.luau', 'return 3\n')
  commitAll(alex, 'ui')
  await assert.rejects(openPullRequest(alex, { title: 'Shop UI' }, gitOnly), /not a GitHub remote/)
  // The branch was pushed first.
  assert.match(git(sam, 'ls-remote', 'origin'), /refs\/heads\/alex\/Shop-UI-polish/)
  git(alex, 'remote', 'set-url', 'origin', 'git@github.com:Acme/my-game.git')
  git(alex, 'remote', 'set-url', '--push', 'origin', remote)
  const pr = await openPullRequest(alex, { title: 'Shop UI', body: 'Adds the shop UI', base: 'main' }, gitOnly)
  assert.equal(pr.kind, 'browser')
  assert.equal(pr.url, 'https://github.com/Acme/my-game/compare/main...alex/Shop-UI-polish?quick_pull=1&title=Shop+UI&body=Adds+the+shop+UI')
})

test('preSyncCheck finds changed Luau files and notes missing linters', async () => {
  const { alex } = setup()
  write(alex, 'src/shared/Modules/Util.luau', 'return 1\n')
  write(alex, 'src/shared/Modules/New.luau', 'return 2\n')
  write(alex, 'README.md', '# hi\n')
  assert.deepEqual(await changedLuaFiles(alex), ['src/shared/Modules/New.luau', 'src/shared/Modules/Util.luau'])
  const report = await preSyncCheck(alex, { ...gitOnly, config: { conventions: '', aiRules: '', testScenarios: [], lint: { selene: true, stylua: true } } })
  assert.equal(report.ok, true)
  assert.equal(report.files.length, 2)
  assert.equal(report.selene?.ran, false)
  assert.ok(report.notes.some((n) => /selene not found/.test(n)))
  assert.ok(report.notes.some((n) => /stylua not found/.test(n)))
})
