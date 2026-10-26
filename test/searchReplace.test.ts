// Search view, replace side: capture groups, Preserve Case, per-match replace, line endings and BOM
// kept, and replaceInProject on temp projects: several files in one go, a copy in .forge/sync/trash
// before each write, files with unsaved editor edits skipped, paths outside the project refused, the
// write going through Project.writeFile.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { buildMatcher, preserveCase, replaceInText, replacementFor, type Matcher } from '../src/shared/search/matcher.ts'
import type { ReplaceRequest, SearchQuery } from '../src/shared/searchTypes.ts'
import { Project } from '../src/main/services/project.ts'
import { replaceInProject } from '../src/main/services/search.ts'
import { makeProject } from './fixture.ts'

const temps: string[] = []
const opened: Project[] = []
after(() => {
  for (const p of opened) p.close()
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function dir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-replace-'))
  temps.push(root)
  for (const [rel, text] of Object.entries(files)) put(root, rel, text)
  return root
}
function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}
const read = (root: string, rel: string) => readFileSync(join(root, rel), 'utf8')

const q = (query: string, extra: Partial<SearchQuery> = {}): SearchQuery => ({ query, caseSensitive: false, wholeWord: false, regex: false, ...extra })
function matcher(query: SearchQuery): Matcher {
  const built = buildMatcher(query)
  assert.ok('matcher' in built)
  return built.matcher
}
const sub = (text: string, query: SearchQuery, replacement: string, keep = false, only?: string[]) => replaceInText(text, matcher(query), replacement, keep, only ? new Set(only) : undefined)

// A plain-fs write, as the stand-in for Project.writeFile in most tests.
function fsWriter(root: string, log: string[] = []) {
  return async (path: string, contents: string) => {
    log.push(path)
    writeFileSync(join(root, path), contents, 'utf8')
  }
}

const request = (extra: Partial<ReplaceRequest> & Pick<ReplaceRequest, 'targets'>): ReplaceRequest => ({ options: q('old'), replacement: 'new', preserveCase: false, dirty: [], ...extra })

test('replacement: $1, $&, $<name>, $$, escapes; plain text inserts as typed', () => {
  const re = q('(\\w+)@(?<host>\\w+)', { regex: true })
  assert.equal(sub('mail bob@site now', re, '$2 at $1 ($&) $<host>!').text, 'mail site at bob (bob@site) site! now')
  assert.equal(sub('a-b', q('(a)-(b)', { regex: true }), '$2-$1').text, 'b-a')
  // Two-digit groups only when they exist; otherwise $1 then the digit.
  assert.equal(sub('a', q('(a)', { regex: true }), '$10').text, 'a0')
  assert.equal(sub('a', q('(a)', { regex: true }), '$01').text, 'a1')
  assert.equal(sub('x', q('x', { regex: true }), 'cost $$5 \\t|\\n|\\\\').text, 'cost $5 \t|\n|\\')
  assert.equal(sub('x', q('x', { regex: true }), '$9 $<nope>').text, '$9 $<nope>')
  // Not a regex: nothing is expanded.
  assert.equal(sub('a.b', q('a.b'), '$1 $& \\n').text, '$1 $& \\n')
})

test('replacement: every match on a line and in many lines, count reported', () => {
  const out = sub('old old\nnothing\nOLD', q('old'), 'new')
  assert.equal(out.text, 'new new\nnothing\nnew')
  assert.equal(out.count, 3)
  // Whole word and case flags apply to the replace as they do to the search.
  assert.equal(sub('old bold OLD', q('old', { wholeWord: true, caseSensitive: true }), 'x').text, 'x bold OLD')
  assert.equal(sub('old bold', q('o(ld)', { regex: true, wholeWord: true }), '$1').text, 'ld bold')
})

test('preserve case: caps, lower, capitalized, snake / kebab, mixed', () => {
  assert.equal(preserveCase('FOO', 'bar'), 'BAR')
  assert.equal(preserveCase('foo', 'Bar'), 'bar')
  assert.equal(preserveCase('Foo', 'bar'), 'Bar')
  assert.equal(preserveCase('fooBar', 'Baz'), 'baz')
  assert.equal(preserveCase('Foo_Bar', 'baz_qux'), 'Baz_Qux')
  assert.equal(preserveCase('FOO-BAR', 'baz-qux'), 'BAZ-QUX')
  assert.equal(preserveCase('foo_bar', 'Baz_Qux'), 'baz_qux')
  assert.equal(preserveCase('123', 'bar'), 'bar')
  assert.equal(sub('player PLAYER Player', q('player'), 'user', true).text, 'user USER User')
  assert.equal(sub('player PLAYER Player', q('player'), 'user', false).text, 'user user user')
  assert.equal(replacementFor(matcher(q('ab')), 'cd', 'Ab', {}, true), 'Cd')
})

test('replace only the chosen matches (line:col); ones that moved are counted as stale', () => {
  const text = 'old a\nold b old c\n'
  const one = sub(text, q('old'), 'new', false, ['2:7'])
  assert.equal(one.text, 'old a\nold b new c\n')
  assert.deepEqual([one.count, one.stale], [1, 0])
  const moved = sub(text, q('old'), 'new', false, ['2:7', '3:1', '1:2'])
  assert.deepEqual([moved.count, moved.stale], [1, 2])
})

test('line endings and a BOM are kept; nothing else changes', () => {
  assert.equal(sub('a old\r\nb old\rc old\n', q('old'), 'new').text, 'a new\r\nb new\rc new\n')
  assert.equal(sub('﻿old\n', q('old'), 'new').text, '﻿new\n')
  // Columns do not count the BOM.
  assert.equal(sub('﻿old\n', q('old'), 'new', false, ['1:1']).count, 1)
  const untouched = 'no match here\r\n'
  assert.equal(sub(untouched, q('old'), 'new').text, untouched)
})

test('a replacement may contain the query or a line break', () => {
  assert.equal(sub('a old', q('old'), 'old old').text, 'a old old')
  assert.equal(sub('a old', q('old', { regex: true }), 'x\\ny').text, 'a x\ny')
})

test('replaceInProject: several files, copies first, counts', async () => {
  const root = dir({ 'src/a.luau': 'old 1\nold 2\n', 'src/b.luau': 'x old\n', 'src/c.luau': 'untouched\n', 'src/sub/d.json': '{"old": true}' })
  const order: string[] = []
  const result = await replaceInProject(root, request({ targets: [{ path: 'src/a.luau' }, { path: 'src/b.luau' }, { path: 'src/sub/d.json' }] }), {
    writeFile: fsWriter(root, order),
    now: () => Date.UTC(2026, 9, 26, 12, 0, 0),
    log: () => undefined
  })
  assert.equal(result.error, undefined)
  assert.deepEqual(result.files, [{ path: 'src/a.luau', count: 2 }, { path: 'src/b.luau', count: 1 }, { path: 'src/sub/d.json', count: 1 }])
  assert.equal(result.replaced, 4)
  assert.deepEqual(result.skipped, [])
  assert.equal(read(root, 'src/a.luau'), 'new 1\nnew 2\n')
  assert.equal(read(root, 'src/sub/d.json'), '{"new": true}')
  assert.equal(read(root, 'src/c.luau'), 'untouched\n')
  // One trash folder for the batch, holding the files as they were.
  assert.equal(result.backup, '.forge/sync/trash/2026-10-26T12-00-00-000Z')
  assert.equal(read(root, `${result.backup}/src/a.luau`), 'old 1\nold 2\n')
  assert.equal(read(root, `${result.backup}/src/sub/d.json`), '{"old": true}')
  assert.ok(!existsSync(join(root, result.backup!, 'src/c.luau')))
  assert.deepEqual(order, ['src/a.luau', 'src/b.luau', 'src/sub/d.json'])
})

test('replaceInProject: the copy exists before the file is written', async () => {
  const root = dir({ 'a.luau': 'old\n' })
  let copyAtWrite: string | null = null
  await replaceInProject(root, request({ targets: [{ path: 'a.luau' }] }), {
    now: () => 1_700_000_000_000,
    writeFile: async (path, contents) => {
      const trash = join(root, '.forge/sync/trash')
      copyAtWrite = existsSync(trash) ? readFileSync(join(trash, readdirSync(trash).find((n) => !n.startsWith('.'))!, path), 'utf8') : null
      writeFileSync(join(root, path), contents)
    }
  })
  assert.equal(copyAtWrite, 'old\n')
})

test('replaceInProject: files with unsaved editor edits are skipped, not written', async () => {
  const root = dir({ 'a.luau': 'old\n', 'b.luau': 'old\n' })
  const result = await replaceInProject(root, request({ targets: [{ path: 'a.luau' }, { path: 'b.luau' }], dirty: ['a.luau'] }), { writeFile: fsWriter(root) })
  assert.deepEqual(result.files, [{ path: 'b.luau', count: 1 }])
  assert.deepEqual(result.skipped, [{ path: 'a.luau', reason: 'unsaved changes in the editor' }])
  assert.equal(read(root, 'a.luau'), 'old\n')
  assert.ok(!existsSync(join(root, result.backup!, 'a.luau')))
})

test('replaceInProject: per-match replace, and a match that is no longer there', async () => {
  const root = dir({ 'a.luau': 'old\nold\n', 'b.luau': 'changed\n' })
  const result = await replaceInProject(root, request({ targets: [{ path: 'a.luau', only: [{ line: 2, col: 1 }] }, { path: 'b.luau', only: [{ line: 1, col: 1 }] }] }), { writeFile: fsWriter(root) })
  assert.equal(read(root, 'a.luau'), 'old\nnew\n')
  assert.equal(read(root, 'b.luau'), 'changed\n')
  assert.equal(result.stale, 1)
  assert.match(result.skipped[0].reason, /changed since the search/)
})

test('replaceInProject: refuses paths outside the project, in .git / .forge, links out, and non-text files', async () => {
  const outside = dir({ 'secret.txt': 'old\n' })
  const root = dir({ 'ok.luau': 'old\n', '.git/config': 'old\n', '.forge/sync/trash/1/a.luau': 'old\n', 'node_modules/x/i.js': 'old\n', 'pic.png': 'old', 'bin.dat': 'old\0' })
  symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
  const targets = ['../secret.txt', join(outside, 'secret.txt'), 'a/../../secret.txt', '.git/config', '.forge/sync/trash/1/a.luau', 'node_modules/x/i.js', 'link.txt', 'pic.png', 'bin.dat', 'gone.luau', 'ok.luau'].map((path) => ({ path }))
  const writes: string[] = []
  const result = await replaceInProject(root, request({ targets }), { writeFile: fsWriter(root, writes) })
  assert.deepEqual(result.files, [{ path: 'ok.luau', count: 1 }])
  assert.deepEqual(writes, ['ok.luau'])
  assert.equal(read(outside, 'secret.txt'), 'old\n')
  assert.equal(read(root, '.git/config'), 'old\n')
  assert.equal(result.skipped.length, targets.length - 1)
  const why = Object.fromEntries(result.skipped.map((s) => [s.path, s.reason]))
  assert.equal(why['../secret.txt'], 'outside the project')
  assert.equal(why[join(outside, 'secret.txt')], 'outside the project')
  assert.equal(why['a/../../secret.txt'], 'outside the project')
  assert.equal(why['.git/config'], 'not a searched folder')
  assert.equal(why['link.txt'], 'outside the project')
  assert.equal(why['pic.png'], 'not a text file')
  assert.equal(why['gone.luau'], 'no longer exists')
})

test('replaceInProject: a bad regex or an empty query writes nothing', async () => {
  const root = dir({ 'a.luau': 'old\n' })
  const bad = await replaceInProject(root, request({ options: q('(', { regex: true }), targets: [{ path: 'a.luau' }] }), { writeFile: fsWriter(root) })
  assert.match(bad.error ?? '', /^Invalid regular expression/)
  const empty = await replaceInProject(root, request({ options: q(''), targets: [{ path: 'a.luau' }] }), { writeFile: fsWriter(root) })
  assert.ok(empty.error)
  assert.equal(read(root, 'a.luau'), 'old\n')
  assert.ok(!existsSync(join(root, '.forge')))
})

test('replaceInProject: a write that fails is reported and the others still go', async () => {
  const root = dir({ 'a.luau': 'old\n', 'b.luau': 'old\n' })
  const result = await replaceInProject(root, request({ targets: [{ path: 'a.luau' }, { path: 'b.luau' }] }), {
    writeFile: async (path, contents) => {
      if (path === 'a.luau') throw new Error('EACCES')
      writeFileSync(join(root, path), contents)
    }
  })
  assert.deepEqual(result.files, [{ path: 'b.luau', count: 1 }])
  assert.match(result.skipped[0].reason, /could not write it: EACCES/)
})

test('replaceInProject: the same path twice is replaced once', async () => {
  const root = dir({ 'a.luau': 'old\n' })
  const result = await replaceInProject(root, request({ targets: [{ path: 'a.luau' }, { path: './a.luau' }, { path: 'a.luau' }] }), { writeFile: fsWriter(root) })
  assert.equal(result.replaced, 1)
  assert.equal(read(root, 'a.luau'), 'new\n')
})

test('replaceInProject through Project.writeFile (the app\'s normal write path)', async () => {
  const root = makeProject()
  temps.push(root)
  const project = await Project.open(root)
  opened.push(project)
  const result = await replaceInProject(root, request({ options: q('InventoryService', { caseSensitive: true }), replacement: 'ItemService', targets: [{ path: 'src/server/Features/Inventory/InventoryService.luau' }] }), { writeFile: (p, c) => project.writeFile(p, c) })
  assert.equal(result.replaced, 1)
  assert.match(read(root, 'src/server/Features/Inventory/InventoryService.luau'), /-- src\/server\/Features\/Inventory\/ItemService\.luau/)
  assert.match(read(root, `${result.backup}/src/server/Features/Inventory/InventoryService.luau`), /InventoryService\.luau/)
  // Project.writeFile itself refuses a path outside the root.
  await assert.rejects(project.writeFile('../x.txt', 'x'), /outside the project/)
})
