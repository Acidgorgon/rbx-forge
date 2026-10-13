import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseSeleneJson2, parseStyluaJson, splitJsonValues } from '../src/main/services/collab/quality.ts'
import { parseBlamePorcelain } from '../src/main/services/collab/blame.ts'
import { parseSyncLog } from '../src/main/services/collab/activity.ts'
import { overlaps, parseClaims, serialiseClaims, viewClaims } from '../src/main/services/collab/claims.ts'
import { compareUrl, parseGitHubRemote, parsePrList, slugifyBranch } from '../src/main/services/collab/branches.ts'
import { classifyPath, groupByFeature } from '../src/main/services/collab/classify.ts'
import { parsePorcelainZ, splitDiff } from '../src/main/services/collab/incoming.ts'
import { repoNameFromUrl } from '../src/main/services/collab/join.ts'
import { validateProjectConfig } from '../src/main/services/collab/config.ts'

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', 'collab', name), 'utf8')

test('selene json2 output becomes 1-based Problems; summary lines are ignored', () => {
  const problems = parseSeleneJson2(fixture('selene-json2.txt'))
  assert.equal(problems.length, 3)
  assert.deepEqual(problems[0], {
    path: 'src/shared/Modules/Util.luau', line: 1, col: 7, endLine: 1, endCol: 8,
    severity: 'warning', message: 'x is assigned a value, but never used', source: 'selene', code: 'unused_variable'
  })
  assert.equal(problems[1].severity, 'error')
  assert.equal(problems[1].line, 4)
  assert.match(problems[1].message, /see the Roblox docs/)
  assert.equal(problems[2].message, 'unexpected token `end` — expected an expression')
  // Absolute file names are made repo-relative.
  const abs = parseSeleneJson2(fixture('selene-json2.txt').replace(/"filename":"/g, '"filename":"/work/game/'), '/work/game')
  assert.equal(abs[0].path, 'src/shared/Modules/Util.luau')
  assert.deepEqual(parseSeleneJson2('not json\n{"type":"Summary","errors":0,"warnings":0,"parse_errors":0}\n'), [])
})

test('stylua --check json output and stderr parse errors become Problems', () => {
  const problems = parseStyluaJson(fixture('stylua-check.json.txt'), fixture('stylua-parse-error.stderr.txt'))
  assert.equal(problems.length, 4)
  assert.deepEqual(problems[0], {
    path: 'src/shared/Modules/Util.luau', line: 3, col: 1, endLine: 3, severity: 'warning',
    message: 'Not formatted (StyLua). Expected: function Util.add(a, b)', source: 'stylua', code: 'format'
  })
  assert.equal(problems[1].line, 1)
  assert.equal(problems[2].message, 'Not formatted (StyLua): extra lines')
  assert.deepEqual(
    { path: problems[3].path, line: problems[3].line, col: problems[3].col, severity: problems[3].severity, code: problems[3].code },
    { path: 'src/client/Broken.luau', line: 2, col: 1, severity: 'error', code: 'parse_error' }
  )
  assert.equal(splitJsonValues('[1][2]{"a":"]["}').length, 3)
})

test('blame --line-porcelain parsing, including --porcelain style repeated commits', () => {
  const sha = 'a'.repeat(40)
  const text = [
    `${sha} 1 1 2`, 'author Alex', 'author-mail <a@x>', 'author-time 1700000000', 'author-tz +0000', 'summary first', 'filename f.luau', '\tlocal a = 1',
    `${sha} 2 2`, '\tlocal b = 2',
    `${'0'.repeat(40)} 3 3 1`, 'author Not Committed Yet', 'author-time 1700000100', 'summary Version of f.luau from f.luau', '\tlocal c',
    ''
  ].join('\n')
  const lines = parseBlamePorcelain(text)
  assert.equal(lines.length, 3)
  assert.deepEqual(lines[1], { line: 2, author: 'Alex', at: 1700000000000, commit: sha, summary: 'first', content: 'local b = 2' })
  assert.equal(lines[2].author, 'You (not committed)')
})

test('sync log: date rollover across midnight and ignored lines', () => {
  const anchor = new Date(2026, 9, 13, 0, 30, 0).getTime()
  const entries = parseSyncLog('23:50:00 pull  a.luau\n23:55:00 skip  b.luau  (no matching folder)\n00:10:00 differs at start  c.luau\nrandom\n', anchor)
  assert.deepEqual(entries.map((e) => e.studioAction), ['pull', 'conflict'])
  assert.equal(entries[0].at, new Date(2026, 9, 12, 23, 50, 0).getTime())
  assert.equal(entries[1].at, new Date(2026, 9, 13, 0, 10, 0).getTime())
  assert.deepEqual(entries[1].files, [{ path: 'c.luau', change: 'conflict' }])
})

test('claims: union-merged file parses, dedupes, and reserialises as JSON', () => {
  const a = { who: 'Alex', what: 'src/shared/Features/Shop', since: '2026-10-10T10:00:00.000Z' }
  const b = { who: 'Sam', what: 'src/shared/Features/Shop/init.luau', since: '2026-10-11T10:00:00.000Z', note: 'ui' }
  const merged = `[\n${JSON.stringify(a)},\n${JSON.stringify(b)}\n${JSON.stringify(a)},\n<<<<<<< HEAD\n]\n`
  const claims = parseClaims(merged)
  assert.equal(claims.length, 2)
  assert.deepEqual(JSON.parse(serialiseClaims(claims)), claims)
  const views = viewClaims(claims, Date.parse('2026-10-13T11:00:00.000Z'), 'Sam')
  assert.deepEqual(views.map((v) => [v.who, v.contested, v.stale, v.mine]), [['Alex', true, true, false], ['Sam', true, false, true]])
  assert.equal(overlaps('src/a', 'src/ab'), false)
  assert.equal(overlaps('feature:Shop', 'feature:shop'), true)
  assert.deepEqual(parseClaims('[{"who":1}]'), [])
})

test('GitHub remotes, compare URLs, branch names and gh pr list JSON', () => {
  for (const url of ['https://github.com/Acme/game.git', 'git@github.com:Acme/game.git', 'ssh://git@github.com/Acme/game', 'https://token@github.com/Acme/game/']) {
    assert.deepEqual(parseGitHubRemote(url), { host: 'github.com', owner: 'Acme', repo: 'game' }, url)
  }
  assert.equal(parseGitHubRemote('https://gitlab.com/a/b.git'), null)
  assert.equal(parseGitHubRemote('/tmp/remote.git'), null)
  assert.equal(
    compareUrl({ host: 'github.com', owner: 'A', repo: 'b' }, 'main', 'feature/x y', { title: 'T & U' }),
    'https://github.com/A/b/compare/main...feature/x%20y?quick_pull=1&title=T+%26+U'
  )
  assert.equal(slugifyBranch('  Shop UI: v2..final!  '), 'Shop-UI-v2.final')
  const prs = parsePrList('[{"number":7,"title":"Shop","url":"https://github.com/A/b/pull/7","author":{"login":"sam"},"headRefName":"feature/shop","isDraft":true,"updatedAt":"2026-10-12T00:00:00Z"}]')
  assert.deepEqual(prs[0], { number: 7, title: 'Shop', url: 'https://github.com/A/b/pull/7', author: 'sam', branch: 'feature/shop', draft: true, updatedAt: '2026-10-12T00:00:00Z' })
  assert.equal(repoNameFromUrl('git@github.com:Acme/My Game.git'), 'My-Game')
  assert.equal(repoNameFromUrl('/tmp/x/remote.git/'), 'remote')
})

test('path classification and grouping follow GenTree features and categories', () => {
  assert.deepEqual(classifyPath('src/shared/Features/Shop/init.luau'), { category: 'Configs', feature: 'Shop' })
  assert.deepEqual(classifyPath('src/client/Client/Controllers/ShopController.luau'), { category: 'Controllers', feature: 'Shop' })
  assert.deepEqual(classifyPath('src/server/Features/Shop/ShopService.luau'), { category: 'Services', feature: 'Shop' })
  assert.deepEqual(classifyPath('src/client/Client/init.client.luau'), { category: 'Entry points' })
  assert.deepEqual(classifyPath('events.blink'), { category: 'Project' })
  const groups = groupByFeature([{ path: 'events.blink' }, { path: 'src/shared/Modules/A.luau' }, { path: 'src/server/Features/Zed/Z.luau' }])
  assert.deepEqual(groups.map((g) => g.label), ['Zed', 'Modules', 'Project files'])
})

test('diff splitting and porcelain -z parsing', () => {
  const diff = 'diff --git a/x y.luau b/x y.luau\nindex 1..2\n--- a/x y.luau\n+++ b/x y.luau\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/z.luau b/z.luau\nnew file mode 100644\n'
  const parts = splitDiff(diff)
  assert.deepEqual([...parts.keys()], ['x y.luau', 'z.luau'])
  assert.match(parts.get('x y.luau')!, /\+b/)
  assert.deepEqual(parsePorcelainZ(' M a.luau\0?? b.luau\0R  new.luau\0old.luau\0UU c.luau\0'), [
    { path: 'a.luau', status: 'modified' },
    { path: 'b.luau', status: 'untracked' },
    { path: 'new.luau', status: 'renamed' },
    { path: 'c.luau', status: 'conflicted' }
  ])
})

test('project config validation reports field paths', () => {
  const bad = validateProjectConfig({ testScenarios: [{ name: '', steps: [] }], branchPrefix: 'bad prefix' })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.deepEqual(bad.issues.map((i) => i.path).sort(), ['branchPrefix', 'testScenarios.0.name'])
})
