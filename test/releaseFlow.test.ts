import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { buildChangelog, classifySubject, renderChangelog } from '../src/main/services/release/changelog.ts'
import { readReleaseConfig, writeProjectVersion } from '../src/main/services/release/config.ts'
import { blinkCheck, customCheck, defaultChecks, gitCheck, luneTestsCheck, runPreflight, seleneCheck, studioConflictsCheck } from '../src/main/services/release/preflight.ts'
import { placeFileInfo, ReleaseService, STUDIO_NEXT_ACTION } from '../src/main/services/release/release.ts'
import { detectMode, summarizeRojoProject } from '../src/main/services/release/rojo.ts'
import { MemorySecretStore, secretKey } from '../src/main/services/release/secrets.ts'
import { bumpSemver, compareSemver, lastReleaseTag, listReleaseTags, parseSemver, suggestBump, versionInfo } from '../src/main/services/release/version.ts'
import type { FetchLike, NotifyEvent } from '../src/main/services/release/types.ts'

const temps: string[] = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_DATE: '', GIT_COMMITTER_DATE: '' } })
}

function commit(dir: string, file: string, content: string, message: string, author = 'Alex'): void {
  mkdirSync(join(dir, file, '..'), { recursive: true })
  writeFileSync(join(dir, file), content)
  git(dir, 'add', '-A')
  git(dir, '-c', `user.name=${author}`, '-c', `user.email=${author}@example.com`, 'commit', '-q', '-m', message)
}

const GENTREE_PROJECT = {
  name: 'GenTree',
  tree: {
    $className: 'DataModel',
    ReplicatedStorage: { Shared: { $path: 'src/shared', $ignoreUnknownInstances: true }, Packages: { $path: 'Packages' } },
    ServerScriptService: { Server: { $path: 'src/server', $ignoreUnknownInstances: true } },
    StarterPlayer: { StarterPlayerScripts: { Client: { $path: 'src/client', $ignoreUnknownInstances: true } } }
  }
}

// A bare remote and one clone ("me") with a GenTree-like layout.
function setup(): { base: string; remote: string; me: string } {
  const base = mkdtempSync(join(tmpdir(), 'forge-release-'))
  temps.push(base)
  const remote = join(base, 'remote.git')
  git(base, 'init', '-q', '--bare', '-b', 'main', remote)
  const me = join(base, 'me')
  git(base, 'init', '-q', '-b', 'main', me)
  git(me, 'config', 'user.name', 'Alex')
  git(me, 'config', 'user.email', 'alex@example.com')
  writeFileSync(join(me, 'default.project.json'), JSON.stringify(GENTREE_PROJECT, null, 2))
  mkdirSync(join(me, 'tools'))
  writeFileSync(join(me, 'tools', 'studio-sync.json'), JSON.stringify({ port: 34873, placeIds: [111], skip: [] }))
  commit(me, 'src/server/Features/Shop/init.server.luau', 'return 1\n', 'Initial commit')
  git(me, 'remote', 'add', 'origin', remote)
  git(me, 'push', '-q', '-u', 'origin', 'main')
  return { base, remote, me }
}

// ---------------------------------------------------------------- version

test('semver parse/compare/bump/suggest', () => {
  assert.deepEqual(parseSemver('v1.2.3-rc.1'), { major: 1, minor: 2, patch: 3, prerelease: 'rc.1' })
  assert.equal(parseSemver('1.2'), null)
  assert.ok(compareSemver(parseSemver('1.2.3')!, parseSemver('1.2.3-rc.1')!) > 0)
  assert.equal(bumpSemver('1.2.3', 'patch'), '1.2.4')
  assert.equal(bumpSemver('1.2.3', 'minor'), '1.3.0')
  assert.equal(bumpSemver('1.2.3', 'major'), '2.0.0')
  assert.equal(bumpSemver('1.3.0-rc.2', 'minor'), '1.3.0')
  assert.equal(bumpSemver(null, 'minor'), '0.1.0')
  assert.equal(suggestBump([{ kind: 'fix', breaking: false }], '1.0.0'), 'patch')
  assert.equal(suggestBump([{ kind: 'feature', breaking: false }], '1.0.0'), 'minor')
  assert.equal(suggestBump([{ kind: 'fix', breaking: true }], '1.0.0'), 'major')
  assert.equal(suggestBump([{ kind: 'fix', breaking: true }], '0.4.0'), 'minor')
  const info = versionInfo('v1.2.0', '1.4.0', 'minor')
  assert.equal(info.current, '1.4.0', 'project version wins when higher')
  assert.equal(info.storage, 'project')
  assert.deepEqual(info.next, { major: '2.0.0', minor: '1.5.0', patch: '1.4.1' })
  assert.equal(versionInfo(null, null, 'minor').next.minor, '0.1.0')
})

// ---------------------------------------------------------------- changelog

test('classifySubject: conventional prefixes, scopes, breaking, plain verbs', () => {
  assert.deepEqual(classifySubject('feat(shop): sell swords'), { kind: 'feature', scope: 'shop', breaking: false, text: 'sell swords' })
  assert.equal(classifySubject('fix!: drop old save format').breaking, true)
  assert.equal(classifySubject('refactor: x', 'BREAKING CHANGE: saves reset').breaking, true)
  assert.equal(classifySubject('Add daily rewards').kind, 'feature')
  assert.equal(classifySubject('Fixed the door').kind, 'fix')
  assert.equal(classifySubject('Tweak lighting').kind, 'other')
})

test('changelog from a temp repo: since the last tag, grouped, auto-syncs folded, Studio activity', async () => {
  const { me } = setup()
  commit(me, 'src/shared/a.luau', '1', 'feat: first feature')
  git(me, 'tag', '-a', 'v0.1.0', '-m', 'Release v0.1.0')
  // Tag time must be strictly earlier than later sync log entries.
  commit(me, 'src/server/Features/Shop/Buy.luau', '1', 'feat: buy swords in the shop', 'Sam')
  commit(me, 'src/client/Features/Hud/init.client.luau', '1', 'Fix HUD overlapping the shop', 'Alex')
  commit(me, 'src/shared/b.luau', '1', 'refactor!: rename currency to Gold\n\nBREAKING CHANGE: old saves lose coins', 'Sam')
  commit(me, 'src/server/Features/Pets/init.server.luau', '1', 'harness: sync', 'Alex')
  commit(me, 'README.md', 'x', 'docs: explain setup', 'Alex')
  mkdirSync(join(me, '.studio-sync'), { recursive: true })
  const later = new Date(Date.now() + 60_000)
  const hh = (d: Date) => [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
  writeFileSync(join(me, '.studio-sync', 'sync.log'), `${hh(later)} pull src/server/Features/Shop/Buy.luau\n${hh(later)} new src/server/Features/Pets/Feed.luau\n`)
  utimesSync(join(me, '.studio-sync', 'sync.log'), later, later)

  assert.equal(await lastReleaseTag(me), 'v0.1.0')
  const log = await buildChangelog(me, { since: 'v0.1.0' })
  assert.equal(log.since, 'v0.1.0')
  assert.equal(log.commits.length, 5, 'only commits after the tag')
  assert.ok(!log.commits.some((c) => c.subject === 'first feature'))
  const buy = log.commits.find((c) => c.subject === 'buy swords in the shop')!
  assert.equal(buy.kind, 'feature')
  assert.deepEqual(buy.features, ['Shop'])
  assert.equal(buy.author, 'Sam')
  assert.ok(log.commits.find((c) => c.subject === 'rename currency to Gold')!.breaking)
  assert.deepEqual(log.authors, ['Alex', 'Sam'])
  assert.equal(log.studio.length, 2)
  const md = log.markdown
  assert.match(md, /### Breaking changes\n- rename currency to Gold/)
  assert.match(md, /### New\n- \*\*Shop\*\*: buy swords in the shop/)
  assert.match(md, /### Fixes\n- \*\*Hud\*\*: Fix HUD overlapping the shop/)
  assert.match(md, /### Synced work\n- 1 auto-sync commit touching Pets/)
  assert.match(md, /### Studio\n- 1 script edited in Studio: src\/server\/Features\/Shop\/Buy\.luau\n- 1 new script from Studio/)
  assert.match(md, /not tracked by git/)
  assert.match(md, /_Thanks: Alex, Sam_/)
  assert.ok(!md.includes('harness: sync'))

  const first = await buildChangelog(me, { since: null })
  assert.ok(first.commits.some((c) => c.subject === 'first feature'))
  assert.equal(renderChangelog({ since: null, commits: [], studio: [] }), '_No code changes since the last release._\n')
})

// ---------------------------------------------------------------- preflight

test('runPreflight aggregates pass/warn/fail/skip, downgrades non-blocking, catches throws and timeouts', async () => {
  const seen: string[] = []
  const report = await runPreflight(
    [
      customCheck('ok', 'OK', async () => true),
      customCheck('soft', 'Soft', async () => false, false),
      customCheck('boom', 'Boom', async () => {
        throw new Error('exploded')
      }),
      customCheck('slow', 'Slow', () => new Promise(() => {})),
      blinkCheck(async () => ({ ok: true, diagnostics: [], skipped: 'blink not found. Run rokit install.' })),
      blinkCheck(async () => ({ ok: false, diagnostics: [{ file: 'events.blink', line: 3, message: 'Unknown type' }] })),
      luneTestsCheck(async () => ({ ran: true, passed: 4, failed: 1, failures: ['Shop buys'] })),
      luneTestsCheck(async () => ({ ran: false, passed: 0, failed: 0, note: 'No tests/ folder' })),
      seleneCheck(async () => ({ ran: true, problems: [{ path: 'a.luau', line: 1, severity: 'warning', message: 'unused' }] })),
      seleneCheck(async () => ({ ran: true, problems: [{ path: 'a.luau', line: 2, severity: 'error', message: 'bad' }] })),
      studioConflictsCheck(async () => [{ path: 'src/server/x.luau' }])
    ],
    { timeoutMs: 50, onProgress: (r) => seen.push(r.id) }
  )
  const by = (i: number) => report.checks[i].status
  assert.deepEqual(report.checks.map((c) => c.status), ['pass', 'warn', 'fail', 'fail', 'skip', 'fail', 'fail', 'skip', 'warn', 'fail', 'fail'])
  assert.equal(by(1), 'warn')
  assert.match(report.checks[3].summary, /Timed out/)
  assert.equal(report.ok, false)
  assert.equal(report.blockers.length, 6)
  assert.ok(report.blockers.some((b) => b.includes('exploded')))
  assert.equal(seen.length, 11)
  assert.deepEqual(report.checks[5].details, ['events.blink:3 Unknown type'])
  const clean = await runPreflight([customCheck('a', 'A', async () => true)])
  assert.deepEqual([clean.ok, clean.blockers], [true, []])
})

test('gitCheck: dirty, ahead, behind, clean', async () => {
  const { base, remote, me } = setup()
  const check = gitCheck(me)
  assert.equal((await check.run()).status, 'pass')
  writeFileSync(join(me, 'dirty.luau'), 'x')
  const dirty = await check.run()
  assert.equal(dirty.status, 'fail')
  assert.match(dirty.summary, /uncommitted/)
  rmSync(join(me, 'dirty.luau'))
  commit(me, 'local.luau', '1', 'feat: local only')
  assert.match((await check.run()).summary, /not shared yet/)
  git(me, 'push', '-q')
  const them = join(base, 'them')
  git(base, 'clone', '-q', remote, them)
  commit(them, 'theirs.luau', '1', 'feat: from Sam', 'Sam')
  git(them, 'push', '-q')
  const behind = await check.run()
  assert.equal(behind.status, 'fail')
  assert.match(behind.summary, /Teammates pushed 1 commit/)
  const checks = defaultChecks(me)
  assert.deepEqual(checks.map((c) => c.id), ['git', 'studio-sync', 'blink', 'lune-tests', 'selene'])
  assert.equal((await checks[2].run()).status, 'skip')
})

// ---------------------------------------------------------------- mode detection

test('GenTree template is detected as NOT fully managed; Rojo summary warns about wiping', async () => {
  const { me } = setup()
  const detection = await detectMode(me, undefined)
  assert.equal(detection.mode, 'studio')
  assert.equal(detection.source, 'default')
  assert.equal(detection.fullyManaged, false)
  assert.ok(detection.reasons.some((r) => r.includes('$ignoreUnknownInstances')))
  assert.ok(detection.reasons.some((r) => r.includes('Workspace')))
  assert.equal((await detectMode(me, { mode: 'rojo' })).mode, 'rojo')
  const summary = summarizeRojoProject(GENTREE_PROJECT)
  assert.ok(summary.contains.includes('ReplicatedStorage.Shared <- src/shared'))
  assert.deepEqual(summary.services, ['ReplicatedStorage', 'ServerScriptService', 'StarterPlayer'])
  assert.ok(summary.warnings.some((w) => /wipe|replaces it with nothing/.test(w)))

  const managed = mkdtempSync(join(tmpdir(), 'forge-managed-'))
  temps.push(managed)
  writeFileSync(join(managed, 'default.project.json'), JSON.stringify({ name: 'M', tree: { $className: 'DataModel', Workspace: { $path: 'world' }, ServerScriptService: { $path: 'src' } } }))
  const auto = await detectMode(managed, undefined)
  assert.deepEqual([auto.mode, auto.source, auto.fullyManaged], ['rojo', 'detected', true])
})

test('release config: reads publish/version, writes version keeping other keys', async () => {
  const { me } = setup()
  mkdirSync(join(me, '.forge'))
  writeFileSync(join(me, '.forge', 'project.json'), JSON.stringify({ conventions: 'keep me', version: '1.0.0', publish: { mode: 'file', placeId: '123', versionType: 'Saved' } }))
  const config = await readReleaseConfig(me)
  assert.deepEqual(config, { version: '1.0.0', publish: { mode: 'file', placeId: 123, versionType: 'Saved' }, issues: [] })
  await writeProjectVersion(me, '1.1.0')
  const raw = JSON.parse(readFileSync(join(me, '.forge', 'project.json'), 'utf8'))
  assert.equal(raw.version, '1.1.0')
  assert.equal(raw.conventions, 'keep me')
  writeFileSync(join(me, '.forge', 'project.json'), JSON.stringify({ version: 'one', publish: { mode: 'yolo' } }))
  assert.equal((await readReleaseConfig(me)).issues.length, 2)
})

// ---------------------------------------------------------------- full runs

function service(opts: { fetch?: FetchLike; rojoRunner?: (file: string, args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>; checks?: 'git' | 'none' } = {}) {
  const secrets = new MemorySecretStore()
  const kv = new Map<string, unknown>()
  const store = { get: <T>(k: string, f: T) => (kv.has(k) ? (kv.get(k) as T) : f), set: (k: string, v: unknown) => void kv.set(k, v) }
  const events: NotifyEvent[] = []
  const svc = new ReleaseService({
    secrets,
    store,
    checks: (root) => (opts.checks === 'none' ? [] : [gitCheck(root)]),
    notify: async (_root, event) => {
      events.push(event)
      return { sent: true }
    },
    fetch: opts.fetch,
    rojo: { rojo: '/fake/rojo', runner: opts.rojoRunner }
  })
  return { svc, secrets, events }
}

test('studio mode: plan, tag + push + notify, next action, history from tags', async () => {
  const { remote, me } = setup()
  git(me, 'tag', '-a', 'v0.1.0', '-m', 'Release v0.1.0')
  git(me, 'push', '-q', 'origin', 'v0.1.0')
  commit(me, 'src/server/Features/Shop/Buy.luau', '1', 'feat: buy swords')
  git(me, 'push', '-q')
  const { svc, events } = service()
  const plan = await svc.plan(me)
  assert.equal(plan.mode, 'studio')
  assert.equal(plan.preflight.ok, true)
  assert.equal(plan.version.current, '0.1.0')
  assert.equal(plan.version.suggestedBump, 'minor')
  assert.equal(plan.version.next.minor, '0.2.0')
  assert.equal(plan.placeId, 111, 'from tools/studio-sync.json')
  assert.equal(plan.rojo, undefined)

  const result = await svc.run(me, { mode: 'studio', bump: 'minor', changelog: '### New\n- buy swords\n' })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.nextAction, STUDIO_NEXT_ACTION)
  assert.equal(result.record!.tag, 'v0.2.0')
  assert.equal(result.record!.studioPublishPending, true)
  assert.deepEqual(result.steps.map((s) => `${s.id}:${s.state}`), ['preflight:done', 'build:skipped', 'publish:skipped', 'version:skipped', 'tag:done', 'push:done', 'notify:done'])
  assert.match(git(remote, 'tag', '--list'), /v0\.2\.0/)
  assert.match(git(me, 'tag', '-l', '--format=%(contents)', 'v0.2.0'), /### New\n- buy swords/)
  assert.equal(events[0].kind, 'release')
  assert.deepEqual(await listReleaseTags(me), ['v0.2.0', 'v0.1.0'])

  const again = await svc.run(me, { mode: 'studio', version: '0.2.0' })
  assert.equal(again.ok, false)
  assert.match(again.error!, /already exists/)

  await svc.markStudioPublished(me, 'v0.2.0')
  assert.equal(svc.history(me)[0].studioPublishPending, false)
  assert.equal(events.at(-1)!.kind, 'publish')
  const team = await svc.teamHistory(me)
  assert.deepEqual(team.map((r) => r.tag), ['v0.2.0', 'v0.1.0'])
  assert.match(team[0].changelog, /buy swords/)
  assert.equal(team[0].by, 'Alex')
})

test('release stops on a blocking preflight failure and creates no tag', async () => {
  const { me } = setup()
  writeFileSync(join(me, 'dirty.luau'), 'x')
  const { svc, events } = service()
  const result = await svc.run(me, { mode: 'studio', bump: 'patch' })
  assert.equal(result.ok, false)
  assert.match(result.error!, /uncommitted/)
  assert.equal(git(me, 'tag', '--list').trim(), '')
  assert.equal(events.length, 0)
})

test('project version is bumped in a pushed release commit', async () => {
  const { remote, me } = setup()
  mkdirSync(join(me, '.forge'))
  writeFileSync(join(me, '.forge', 'project.json'), JSON.stringify({ conventions: '', version: '2.0.0' }, null, 2))
  commit(me, '.forge/project.json', readFileSync(join(me, '.forge', 'project.json'), 'utf8'), 'chore: track version')
  git(me, 'push', '-q')
  const { svc } = service()
  const result = await svc.run(me, { mode: 'studio', bump: 'patch' })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.record!.tag, 'v2.0.1')
  assert.equal(JSON.parse(git(remote, 'show', 'main:.forge/project.json')).version, '2.0.1')
  assert.equal(git(remote, 'log', '-1', '--format=%s', 'main').trim(), 'Release v2.0.1')
})

test('rojo mode is refused for a GenTree project that did not opt in', async () => {
  const { me } = setup()
  const { svc, secrets } = service({ rojoRunner: async () => assert.fail('must not build') })
  await secrets.set(secretKey('openCloudApiKey', me), 'key')
  const result = await svc.run(me, { mode: 'rojo', confirmToken: 'x' })
  assert.equal(result.ok, false)
  assert.match(result.error!, /wipe Studio-only content/)
  assert.equal(git(me, 'tag', '--list').trim(), '')
})

test('rojo mode (opted in): confirm token required, builds, publishes, then tags', async () => {
  const { me } = setup()
  mkdirSync(join(me, '.forge'))
  writeFileSync(join(me, '.forge', 'project.json'), JSON.stringify({ publish: { mode: 'rojo', placeId: 111, universeId: 999, versionType: 'Saved' } }))
  commit(me, '.forge/project.json', readFileSync(join(me, '.forge', 'project.json'), 'utf8'), 'chore: opt in to rojo publish')
  git(me, 'push', '-q')
  const builds: string[][] = []
  const { fetch, calls } = (() => {
    const calls: { url: string; headers?: Record<string, string>; body?: unknown }[] = []
    const fetch: FetchLike = async (url, init = {}) => {
      calls.push({ url, ...init })
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => '{"versionNumber":31}' }
    }
    return { fetch, calls }
  })()
  const { svc, secrets } = service({
    fetch,
    rojoRunner: async (_file, args) => {
      builds.push(args)
      writeFileSync(args[3], 'RBXL-BYTES')
      return { code: 0, stdout: '', stderr: '' }
    }
  })
  await secrets.set(secretKey('openCloudApiKey', me), 'my-open-cloud-key')
  const plan = await svc.plan(me)
  assert.equal(plan.mode, 'rojo')
  assert.equal(plan.detection.source, 'project')
  assert.ok(plan.rojo!.confirmToken)
  assert.ok(plan.warnings.some((w) => /NOT fully managed/.test(w)))

  const unconfirmed = await svc.run(me, { mode: 'rojo', bump: 'minor' })
  assert.equal(unconfirmed.ok, false)
  assert.match(unconfirmed.error!, /not confirmed/)
  assert.equal(calls.length, 0)

  const result = await svc.run(me, { mode: 'rojo', bump: 'minor', confirmToken: plan.rojo!.confirmToken })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(builds[0].slice(0, 3), ['build', 'default.project.json', '-o'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://apis.roblox.com/universes/v1/999/places/111/versions?versionType=Saved')
  assert.equal(calls[0].headers!['x-api-key'], 'my-open-cloud-key')
  assert.equal(Buffer.from(calls[0].body as Uint8Array).toString(), 'RBXL-BYTES')
  assert.equal(result.record!.placeVersion, 31)
  assert.equal(result.record!.tag, 'v0.1.0')
  assert.equal(result.nextAction, undefined)
})

test('file mode: rejected publish leaves no tag; plan flags stale and unsupported classes', async () => {
  const { me, base } = setup()
  const place = join(base, 'export.rbxlx')
  writeFileSync(place, '<roblox><Item class="PartOperation"></Item></roblox>')
  utimesSync(place, new Date(0), new Date(0))
  const info = await placeFileInfo(me, place, Date.now())
  assert.equal(info.format, 'rbxlx')
  assert.equal(info.stale, true)
  assert.deepEqual(info.unsupportedClasses, ['PartOperation'])

  mkdirSync(join(me, '.forge'))
  writeFileSync(join(me, '.forge', 'project.json'), JSON.stringify({ publish: { mode: 'file', placeFile: place } }))
  commit(me, '.forge/project.json', readFileSync(join(me, '.forge', 'project.json'), 'utf8'), 'chore: file mode')
  git(me, 'push', '-q')
  const lookups: string[] = []
  const fetch: FetchLike = async (url) => {
    lookups.push(url)
    if (url.endsWith('/universe')) return { status: 200, ok: true, headers: { get: () => null }, text: async () => '{"universeId":555}' }
    return { status: 403, ok: false, headers: { get: () => null }, text: async () => '{"code":"PERMISSION_DENIED","message":"Insufficient scope"}' }
  }
  const { svc, secrets, events } = service({ fetch })
  await secrets.set(secretKey('openCloudApiKey'), 'k')
  const plan = await svc.plan(me, { skipPreflight: true })
  assert.ok(plan.warnings.some((w) => /older than the latest commit/.test(w)))
  assert.ok(plan.warnings.some((w) => /PartOperation/.test(w)))
  const result = await svc.run(me, { mode: 'file', bump: 'patch' })
  assert.equal(result.ok, false)
  assert.match(result.error!, /universe-places:write/)
  assert.deepEqual(lookups, ['https://apis.roblox.com/universes/v1/places/111/universe', 'https://apis.roblox.com/universes/v1/555/places/111/versions?versionType=Published'])
  assert.equal(result.steps.find((s) => s.id === 'publish')!.state, 'failed')
  assert.equal(git(me, 'tag', '--list').trim(), '')
  assert.equal(events.length, 0)
})
