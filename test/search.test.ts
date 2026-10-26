// Search view, find side: the matcher (case / whole word / regex combinations, empty matches, previews)
// and the project walk (include / exclude globs, .gitignore, skipped folders, binary and big files, the
// match cap, cancelling), on temp folders.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { buildMatcher, matchLine, previewLine, type Matcher } from '../src/shared/search/matcher.ts'
import type { SearchFileResult, SearchOptions } from '../src/shared/searchTypes.ts'
import { compileGlobs, gitignored, MAX_FILE_BYTES, MAX_MATCHES, parseGitignore, runSearch, SearchService } from '../src/main/services/search.ts'

const temps: string[] = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function tree(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-search-'))
  temps.push(root)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return root
}

const opts = (query: string, extra: Partial<SearchOptions> = {}): SearchOptions => ({ query, caseSensitive: false, wholeWord: false, regex: false, include: '', exclude: '', useIgnore: true, ...extra })

function matcher(query: string, extra: Partial<SearchOptions> = {}): Matcher {
  const built = buildMatcher({ ...opts(query), ...extra })
  assert.ok('matcher' in built, JSON.stringify(built))
  return built.matcher
}

const found = (m: Matcher, line: string) => matchLine(m, line).map((h) => line.slice(h.index, h.index + h.length))

async function search(root: string, options: SearchOptions, signal?: AbortSignal) {
  const files: SearchFileResult[] = []
  const summary = await runSearch(root, 's1', options, { onFiles: (f) => files.push(...f), signal })
  return { files, summary, paths: files.map((f) => f.path) }
}

test('matcher: case sensitivity, plain text is escaped', () => {
  assert.deepEqual(found(matcher('foo'), 'Foo foo FOO'), ['Foo', 'foo', 'FOO'])
  assert.deepEqual(found(matcher('foo', { caseSensitive: true }), 'Foo foo FOO'), ['foo'])
  assert.deepEqual(found(matcher('a.b(c)'), 'a.b(c) axb(c)'), ['a.b(c)'])
  assert.deepEqual(found(matcher('[x]+'), 'a [x]+ b'), ['[x]+'])
})

test('matcher: whole word, plain and regex, with and without case', () => {
  assert.deepEqual(found(matcher('cat', { wholeWord: true }), 'cat concat cat_x cat. Cat'), ['cat', 'cat', 'Cat'])
  assert.deepEqual(found(matcher('cat', { wholeWord: true, caseSensitive: true }), 'cat Cat'), ['cat'])
  // A regex with alternatives backtracks to the whole word.
  assert.deepEqual(found(matcher('a|ab', { regex: true, wholeWord: true }), 'ab a abc'), ['ab', 'a'])
  assert.deepEqual(found(matcher('c[a-z]t', { regex: true, wholeWord: true }), 'cat cats cut'), ['cat', 'cut'])
  assert.deepEqual(found(matcher('c[a-z]t', { regex: true, wholeWord: true, caseSensitive: true }), 'cat CAT cut'), ['cat', 'cut'])
  // A query that starts / ends with a symbol needs no boundary there.
  assert.deepEqual(found(matcher('.foo', { wholeWord: true }), 'x.foo a.foo'), ['.foo', '.foo'])
  assert.deepEqual(found(matcher('foo(', { wholeWord: true }), 'foo(1) xfoo(2)'), ['foo('])
})

test('matcher: regex flags, groups, empty matches are skipped', () => {
  assert.deepEqual(found(matcher('\\d+', { regex: true }), 'a1 b22 c333'), ['1', '22', '333'])
  assert.deepEqual(found(matcher('x*', { regex: true }), 'axxb'), ['xx'])
  assert.deepEqual(found(matcher('^', { regex: true }), 'abc'), [])
  const [hit] = matchLine(matcher('(\\w+)=(?<v>\\d+)', { regex: true }), 'id=42')
  assert.deepEqual(hit.groups, ['id', '42'])
  assert.deepEqual(hit.named, { v: '42' })
  // Plain-text search never reports groups.
  assert.equal(matchLine(matcher('(a)'), '(a)')[0].groups, undefined)
})

test('matcher: bad regex is an error, not a throw; an empty query is empty', () => {
  const bad = buildMatcher({ query: '(', caseSensitive: false, wholeWord: false, regex: true })
  assert.ok('error' in bad && bad.error.length > 0)
  assert.ok('error' in buildMatcher({ query: '[a-', caseSensitive: false, wholeWord: true, regex: true }))
  assert.deepEqual(buildMatcher({ query: '', caseSensitive: false, wholeWord: false, regex: true }), { empty: true })
  // Valid without the unicode flag only (an escaped dash outside a class).
  assert.deepEqual(found(matcher('a\\-b', { regex: true }), 'a-b'), ['a-b'])
})

test('previewLine: indent dropped, long lines cut around the match', () => {
  assert.deepEqual(previewLine('    local x = 1', 10, 1), { text: 'local x = 1', from: 6, to: 7 })
  const long = `${'a'.repeat(100)}NEEDLE${'b'.repeat(400)}`
  const p = previewLine(long, 100, 6)
  assert.ok(p.text.startsWith('…') && p.text.endsWith('…'))
  assert.equal(p.text.slice(p.from, p.to), 'NEEDLE')
  assert.ok(p.text.length < 260)
})

test('globs: no slash matches at any depth, a folder covers what is below, braces and commas', () => {
  const set = compileGlobs('*.luau, src/server, **/Tests/**, *.{json,md}')
  assert.ok(!('error' in set))
  const hit = (rel: string) => [...set.exact, ...set.inside].some((re) => re.test(rel))
  assert.ok(hit('a.luau') && hit('src/shared/b.luau'))
  assert.ok(hit('src/server/x.txt') && hit('README.md') && hit('a/b/Tests/c.txt'))
  assert.ok(!hit('src/shared/x.txt') && !hit('x.txt'))
  assert.ok('error' in compileGlobs('src/[bad'))
  assert.deepEqual(compileGlobs(' , '), { exact: [], inside: [] })
})

test('gitignore: patterns, negation, folder-only, anchored', () => {
  const rules = parseGitignore('# c\n*.log\n/dist\nsecrets/\n!keep.log\nsrc/gen/*.luau\n')
  assert.ok(gitignored(rules, 'a/b.log', false))
  assert.ok(!gitignored(rules, 'keep.log', false))
  assert.ok(gitignored(rules, 'dist', true) && !gitignored(rules, 'x/dist', true))
  assert.ok(gitignored(rules, 'a/secrets', true) && !gitignored(rules, 'a/secrets', false))
  assert.ok(gitignored(rules, 'src/gen/a.luau', false) && !gitignored(rules, 'src/other/a.luau', false))
})

test('search: finds matches with line and column, in path order', async () => {
  const root = tree({
    'src/b.luau': 'local Player = 1\nprint(player)\n',
    'src/a.luau': 'return Player.Name\n',
    'notes.md': 'nothing here\n'
  })
  const { files, summary, paths } = await search(root, opts('player'))
  assert.deepEqual(paths, ['src/a.luau', 'src/b.luau'])
  assert.equal(summary.files, 2)
  assert.equal(summary.matches, 3)
  assert.deepEqual(files[1].matches.map((m) => [m.line, m.col, m.endCol, m.text.slice(m.from, m.to)]), [[1, 7, 13, 'Player'], [2, 7, 13, 'player']])
  const cs = await search(root, opts('player', { caseSensitive: true }))
  assert.deepEqual(cs.paths, ['src/b.luau'])
  assert.equal(cs.summary.matches, 1)
})

test('search: columns ignore a BOM, CRLF files give the same lines', async () => {
  const root = tree({ 'a.luau': '﻿one\r\ntwo needle\r\nthree\r\n' })
  const { files } = await search(root, opts('needle'))
  assert.deepEqual(files[0].matches.map((m) => [m.line, m.col]), [[2, 5]])
})

test('search: skips .git, node_modules, Packages, .forge, out / dist / build', async () => {
  const hit = 'needle\n'
  const root = tree({
    'src/a.luau': hit,
    '.git/x': hit,
    'node_modules/m/i.js': hit,
    'Packages/p/init.luau': hit,
    'ServerPackages/p.luau': hit,
    '.forge/sync/trash/1/a.luau': hit,
    'out/main.js': hit,
    'dist/x.js': hit,
    'build/x.js': hit,
    'src/build/ok.luau': hit
  })
  assert.deepEqual((await search(root, opts('needle'))).paths, ['src/a.luau'])
})

test('search: .gitignore applies unless switched off', async () => {
  const root = tree({ '.gitignore': '*.gen.luau\ncache/\n', 'a.luau': 'x needle\n', 'b.gen.luau': 'needle\n', 'cache/c.luau': 'needle\n' })
  assert.deepEqual((await search(root, opts('needle'))).paths, ['a.luau'])
  assert.deepEqual((await search(root, opts('needle', { useIgnore: false }))).paths, ['a.luau', 'b.gen.luau', 'cache/c.luau'])
})

test('search: include and exclude globs', async () => {
  const root = tree({
    'src/server/A.luau': 'needle\n',
    'src/shared/B.luau': 'needle\n',
    'src/shared/B.spec.luau': 'needle\n',
    'src/shared/data.json': 'needle\n',
    'docs/readme.md': 'needle\n'
  })
  const paths = async (extra: Partial<SearchOptions>) => (await search(root, opts('needle', extra))).paths
  assert.deepEqual(await paths({ include: '*.json, *.md' }), ['docs/readme.md', 'src/shared/data.json'])
  assert.deepEqual(await paths({ include: 'src/server' }), ['src/server/A.luau'])
  assert.deepEqual(await paths({ include: 'src/shared/**', exclude: '*.spec.luau' }), ['src/shared/B.luau', 'src/shared/data.json'])
  assert.deepEqual(await paths({ exclude: 'src' }), ['docs/readme.md'])
  assert.deepEqual(await paths({ exclude: 'shared, *.md' }), ['src/server/A.luau'])
  assert.deepEqual(await paths({ include: '*.{luau,json}', exclude: 'server' }), ['src/shared/B.luau', 'src/shared/B.spec.luau', 'src/shared/data.json'])
  assert.match((await search(root, opts('needle', { include: 'src/[x' }))).summary.error ?? '', /Invalid glob/)
})

test('search: binary files and files over the size cap are skipped and counted', async () => {
  const root = tree({
    'ok.luau': 'needle\n',
    'bin.dat': Buffer.concat([Buffer.from('needle'), Buffer.from([0, 1, 2]), Buffer.from('needle')]),
    'pic.png': 'needle in a png',
    'big.json': `needle\n${'x'.repeat(MAX_FILE_BYTES)}`,
    'edge.json': `needle\n${'x'.repeat(MAX_FILE_BYTES - 7)}`
  })
  const { paths, summary } = await search(root, opts('needle'))
  assert.deepEqual(paths, ['edge.json', 'ok.luau'])
  assert.equal(summary.skippedLarge, 1)
  assert.equal(summary.skippedBinary, 2)
})

test('search: stops at the match cap and says so', async () => {
  const root = tree({
    'a.txt': 'x\n'.repeat(3000),
    'b.txt': 'x\n'.repeat(3000),
    'c.txt': 'x\n'
  })
  const { files, summary } = await search(root, opts('x'))
  assert.equal(summary.matches, MAX_MATCHES)
  assert.ok(summary.limitHit)
  assert.equal(files.reduce((n, f) => n + f.matches.length, 0), MAX_MATCHES)
  assert.deepEqual(files.map((f) => f.path), ['a.txt', 'b.txt'])
})

test('search: a bad regex and an empty query come back without walking', async () => {
  const root = tree({ 'a.txt': 'x\n' })
  const bad = await search(root, opts('(', { regex: true }))
  assert.match(bad.summary.error ?? '', /^Invalid regular expression/)
  assert.equal(bad.files.length, 0)
  const empty = await search(root, opts(''))
  assert.equal(empty.summary.error, undefined)
  assert.equal(empty.summary.matches, 0)
})

test('search: cancelling stops the walk and reports cancelled', async () => {
  const files: Record<string, string> = {}
  for (let i = 0; i < 400; i++) files[`d${i % 20}/f${i}.txt`] = 'needle\n'
  const root = tree(files)
  const control = new AbortController()
  const got: SearchFileResult[] = []
  const summary = await runSearch(root, 'c', opts('needle'), {
    signal: control.signal,
    onFiles: (f) => {
      got.push(...f)
      control.abort()
    }
  })
  assert.ok(summary.cancelled)
  assert.ok(got.length > 0 && got.length < 400, `${got.length} files`)
  // Cancelled before it started: nothing at all.
  const early = new AbortController()
  early.abort()
  const none = await runSearch(root, 'c', opts('needle'), { signal: early.signal, onFiles: (f) => got.push(...f) })
  assert.ok(none.cancelled && none.matches === 0)
})

test('SearchService: a second search with the same id cancels the first; cancel() works; no project is an error', async () => {
  const files: Record<string, string> = {}
  for (let i = 0; i < 600; i++) files[`d${i % 30}/f${i}.txt`] = 'needle\n'
  const root = tree(files)
  const emitted: string[] = []
  const service = new SearchService({ root: () => root, writeFile: async () => undefined, emit: (id, f) => emitted.push(`${id}:${f.length}`) })
  const first = service.search('q', opts('needle'))
  const second = service.search('q', opts('nothing-like-this'))
  const [a, b] = await Promise.all([first, second])
  assert.ok(a.cancelled)
  assert.ok(!b.cancelled && b.matches === 0)
  const third = service.search('z', opts('needle'))
  service.cancel('z')
  assert.ok((await third).cancelled)
  await assert.rejects(new SearchService({ root: () => null, writeFile: async () => undefined, emit: () => undefined }).search('x', opts('a')), /No project open/)
})
