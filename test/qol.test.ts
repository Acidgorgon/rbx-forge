// Quality of life: the bug report redactor and report assembly, notification routing + policy,
// session state (de)serialization and migration, and the "since you were away" digest (fake git,
// fake Forge Sync status), plus the main-side QolService writing reports and computing digests.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { redact, REDACTED } from '../src/shared/qol/redact.ts'
import { assembleBugReport, REPORT_LOG_LINES, reportStamp, type BugReportFacts } from '../src/shared/qol/bugReport.ts'
import { finalState, NotifyRouter, shouldDeliver, type NotifyCandidate } from '../src/shared/qol/notify.ts'
import { emptySession, migrateSession, parseSession, restorePlan, serializeSession, SESSION_VERSION, type SessionState } from '../src/shared/qol/session.ts'
import { buildDigest, commitsByOthers, digestSummary, GIT_LOG_FORMAT, parseGitLog, type DigestInputs } from '../src/shared/qol/digest.ts'
import { DEFAULT_QOL_SETTINGS, type NotifySettings } from '../src/shared/qol/types.ts'
import { normalizeQolSettings, QolService, type QolDeps } from '../src/main/services/qol/service.ts'
import type { LogLine } from '../src/shared/types.ts'
import type { SyncStatus } from '../src/shared/sync/types.ts'

// ---------------------------------------------------------------- redactor

test('redactor: provider keys, tokens and cookies are replaced', () => {
  const secrets = [
    'sk-ant-api03-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz9Xc8Vb7Nm6-AAAA',
    'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx1234',
    'sk-or-v1-0123456789abcdef0123456789abcdef',
    'AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    'xoxb-1234567890-0987654321-AbCdEfGhIjKl',
    'AKIAIOSFODNN7EXAMPLE',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    '_|WARNING:-DO-NOT-SHARE-THIS.--Sharing-this-will-allow-someone-to-log-in-as-you-and-to-steal-your-ROBUX-and-items.|_ABC123DEF456'
  ]
  for (const s of secrets) {
    const { text, count } = redact(`before ${s} after`)
    assert.ok(!text.includes(s), `leaked ${s}: ${text}`)
    assert.ok(text.includes(REDACTED), text)
    assert.ok(count >= 1)
    assert.ok(text.startsWith('before ') && text.endsWith(' after'), text)
  }
})

test('redactor: key=value, headers, URLs and webhooks', () => {
  const cases: [string, string, string][] = [
    ['password=hunter2isgood', 'hunter2isgood', 'password='],
    ['"apiKey": "abc123secretvalue"', 'abc123secretvalue', '"apiKey": "'],
    ["OPENROUTER_API_KEY='zzzzzzzzzzzz'", 'zzzzzzzzzzzz', 'OPENROUTER_API_KEY='],
    ['token: 9f8e7d6c5b4a', '9f8e7d6c5b4a', 'token: '],
    ['Authorization: Bearer abc.def.ghi-jkl', 'abc.def.ghi-jkl', 'Authorization: Bearer '],
    ['Cookie: .ROBLOSECURITY=foo; RBXSessionTracker=bar', 'RBXSessionTracker=bar', 'Cookie: '],
    ['Set-Cookie: sid=deadbeefcafe; HttpOnly', 'deadbeefcafe', 'Set-Cookie: '],
    ['GET https://api.example.com/v1?key=supersecret&page=2', 'supersecret', '&page=2'],
    ['clone https://acid:ghs_pwd123@github.com/a/b.git', 'ghs_pwd123', 'github.com/a/b.git'],
    ['https://discord.com/api/webhooks/123456/AbCdEf-GhIj_Kl', 'AbCdEf-GhIj_Kl', 'https://discord.com/api/webhooks/'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----', 'MIIEow', '']
  ]
  for (const [input, secret, kept] of cases) {
    const { text } = redact(input)
    assert.ok(!text.includes(secret), `leaked "${secret}" in ${text}`)
    if (kept) assert.ok(text.includes(kept), `lost "${kept}" in ${text}`)
  }
})

test('redactor: leaves ordinary log lines alone', () => {
  const safe = [
    'Rojo server listening: Address: localhost Port: 34872',
    'commit 9f2c1e7a3b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f by mira',
    'session 3fa85f64-5717-4562-b3fc-2c963f66afa6 started',
    '[sourcemap] wrote sourcemap.json (31 instances) to src/shared/Features/Inventory/InventoryService.luau',
    'token: true',
    'calling ReplicatedStorageSharedFeaturesInventoryController',
    'retry: 3 attempts, timeout=5000'
  ]
  for (const line of safe) {
    const { text, count } = redact(line)
    assert.equal(text, line)
    assert.equal(count, 0, line)
  }
})

test('redactor: path replacements cover both separators', () => {
  const { text } = redact('opened C:\\Users\\acid\\Games\\Tree and C:/Users/acid/Games/Tree/src', { replace: [{ from: 'C:\\Users\\acid\\Games\\Tree', to: '<Tree>' }] })
  assert.equal(text, 'opened <Tree> and <Tree>/src')
})

// ---------------------------------------------------------------- report assembly

function facts(over: Partial<BugReportFacts> = {}): BugReportFacts {
  const logs: LogLine[] = Array.from({ length: 450 }, (_, i) => ({ service: 'dev', stream: 'stdout', text: `line ${i}`, at: 1_700_000_000_000 + i }))
  logs.push({ service: 'agent', stream: 'stderr', text: 'provider failed with key sk-ant-api03-SECRETSECRETSECRET1234 at /Users/acid/Games/Tree/src/a.luau', at: 1_700_000_001_000 })
  return {
    what: 'Refine froze. My key is sk-proj-AbCdEfGhIjKlMnOpQrStUvWx1234',
    expected: 'It finishes',
    at: 1_700_000_002_000,
    app: { version: '0.5.0', electron: '38.2.0', packaged: true },
    os: { platform: 'darwin', release: '24.1.0', arch: 'arm64' },
    page: 'VFX Lab',
    tab: 'VFX Lab',
    project: { name: 'Tree', root: '/Users/acid/Games/Tree' },
    includePath: false,
    homeDir: '/Users/acid',
    logs,
    errors: [{ origin: 'renderer', message: 'TypeError: x is undefined', stack: 'TypeError: x is undefined\n  at /Users/acid/Games/Tree/a.ts:1', at: 1_700_000_001_500 }],
    screenshot: 'screenshot.png',
    ...over
  }
}

test('bug report: sections, last 300 log lines, project name only, everything redacted', () => {
  const { markdown, redactions } = assembleBugReport(facts())
  for (const h of ['# RBX Forge bug report', '## What happened', '## What I expected', '## Environment', '## Screenshot', '## Recent errors (1)', `## Last ${REPORT_LOG_LINES} log lines`]) assert.ok(markdown.includes(h), h)
  assert.ok(markdown.includes('RBX Forge 0.5.0'))
  assert.ok(markdown.includes('macOS 24.1.0 (arm64)'))
  assert.ok(markdown.includes('Open page: VFX Lab'))
  assert.ok(markdown.includes('- Project: Tree'))
  assert.ok(!markdown.includes('/Users/acid/Games/Tree'), 'full path leaked')
  assert.ok(markdown.includes('<Tree>/src/a.luau'))
  assert.ok(!markdown.includes('/Users/acid'), 'home dir leaked')
  assert.ok(!markdown.includes('line 150\n'), 'older log lines should be cut')
  assert.ok(markdown.includes('line 449'))
  assert.ok(!markdown.includes('SECRETSECRET'))
  assert.ok(!markdown.includes('AbCdEfGhIjKlMnOp'))
  assert.ok(redactions >= 2)
  assert.ok(markdown.includes('![Forge window](screenshot.png)'))
  assert.ok(markdown.includes('[REDACTED]._'))
})

test('bug report: full path only when ticked; no screenshot section without one; extra sections', () => {
  const { markdown } = assembleBugReport(facts({ includePath: true, screenshot: null, extra: [{ title: 'Forge Doctor', body: 'rojo: ok\ntoken=abcdefabcdef1234' }] }))
  assert.ok(markdown.includes('Project path: ~/Games/Tree'))
  assert.ok(!markdown.includes('## Screenshot'))
  assert.ok(markdown.includes('## Forge Doctor'))
  assert.ok(!markdown.includes('abcdefabcdef1234'))
  const none = assembleBugReport(facts({ project: null, errors: [], logs: [] })).markdown
  assert.ok(none.includes('Project: none open'))
  assert.ok(none.includes('_None recorded this session._'))
})

test('bug report: stamp is filesystem safe and sortable', () => {
  const s = reportStamp(new Date(2026, 9, 14, 9, 5, 7).getTime())
  assert.equal(s, '2026-10-14_09-05-07')
})

// ---------------------------------------------------------------- notifications

const notifySettings = (over: Partial<NotifySettings> = {}): NotifySettings => ({ ...DEFAULT_QOL_SETTINGS.notify, ...over, categories: { ...DEFAULT_QOL_SETTINGS.notify.categories, ...(over.categories ?? {}) } })
const cand = (over: Partial<NotifyCandidate> = {}): NotifyCandidate => ({ category: 'labs', key: 'k', title: 't', body: 'b', ...over })

test('notify policy: modes, categories, unfocused-only', () => {
  assert.equal(shouldDeliver(notifySettings({ mode: 'unfocused' }), cand(), false), true)
  assert.equal(shouldDeliver(notifySettings({ mode: 'unfocused' }), cand(), true), false)
  assert.equal(shouldDeliver(notifySettings({ mode: 'always' }), cand(), true), true)
  assert.equal(shouldDeliver(notifySettings({ mode: 'off' }), cand(), false), false)
  assert.equal(shouldDeliver(notifySettings({ categories: { labs: false } as NotifySettings['categories'] }), cand(), false), false)
  assert.equal(shouldDeliver(notifySettings({ mode: 'always' }), cand({ category: 'chat', unfocusedOnly: true }), true), false)
  assert.equal(shouldDeliver(notifySettings({ mode: 'always' }), cand({ category: 'chat', unfocusedOnly: true }), false), true)
})

test('notify router: chat turns over 30s, lab progress, team, tests, sync conflicts', () => {
  let now = 1000
  const r = new NotifyRouter({ now: () => now })
  assert.deepEqual(r.observe('chat:busy', { sessionId: 'c1', busy: true }), [])
  now += 10_000
  assert.deepEqual(r.observe('chat:busy', { sessionId: 'c1', busy: false }), [], 'short turn')
  r.observe('chat:busy', { sessionId: 'c1', busy: true })
  now += 31_000
  const [chat] = r.observe('chat:busy', { sessionId: 'c1', busy: false })
  assert.equal(chat.category, 'chat')
  assert.equal(chat.unfocusedOnly, true)
  assert.deepEqual(chat.target, { kind: 'chat', sessionId: 'c1' })

  assert.deepEqual(r.observe('vfx:progress', { entryId: 'e1', iteration: 1, phase: 'critique' }), [])
  const [lab] = r.observe('vfx:progress', { entryId: 'e1', iteration: 3, phase: 'done', score: 8.2 })
  assert.equal(lab.title, 'VFX Lab run finished')
  assert.ok(lab.body.includes('8.2'))
  assert.deepEqual(lab.target, { kind: 'page', page: 'vfx', entryId: 'e1' })
  assert.deepEqual(lab.run, { label: 'VFX Lab run', ok: true })

  // Generic labs from other branches (thumbnails, UI motion) by event name alone.
  now += 20_000
  const [thumb] = r.observe('thumbs:progress', { runId: 'r', state: 'failed', message: 'quota' })
  assert.equal(thumb.title, 'Thumbnail Lab run failed')
  const [motion] = r.observe('uimotion:changed', { at: 1, run: 'x', phase: 'done' })
  assert.equal(motion.title, 'UI Motion Lab run finished')
  assert.deepEqual(r.observe('vfx:changed', { at: 5 }), [], 'plain library change is not a run')

  const [team] = r.observe('orchestrator:event', { type: 'finished', runId: 'o1', board: { runId: 'o1', request: 'Build a shop', state: 'done' } })
  assert.equal(team.title, 'Team run finished')
  const [input] = r.observe('orchestrator:event', { type: 'change_request', runId: 'o1', request: { id: 'cr1', file: 'a.luau', change: 'rename X' } })
  assert.equal(input.needsInput, true)

  const [tests] = r.observe('tests:progress', { runId: 1, kind: 'end', summary: { id: 1, state: 'done', failed: 2, total: 10 } })
  assert.equal(tests.title, '2 tests failed')
  assert.equal(tests.category, 'builds')

  const place = (conflicts: number) => ({ placeKey: '1', projectFile: 'default.project.json', gate: conflicts ? 'blocked' : 'clear', connected: true, counts: {}, conflicts })
  const [sync] = r.observe('sync:status', { engine: 'forge', places: [place(2)], recent: [], pendingStudioEdits: [] })
  assert.equal(sync.category, 'sync')
  assert.deepEqual(r.observe('sync:status', { engine: 'forge', places: [place(2)], recent: [], pendingStudioEdits: [] }), [], 'no new conflicts')
  assert.deepEqual(r.observe('sync:status', { engine: 'forge', places: [place(1)], recent: [], pendingStudioEdits: [] }), [])
  const [studio] = r.observe('studio:conflicts', [{ path: 'src/a.luau' }])
  assert.deepEqual(studio.target, { kind: 'conflict', path: 'src/a.luau' })
  assert.deepEqual(r.observe('studio:conflicts', [{ path: 'src/a.luau' }]), [])

  r.observe('agents:changed', [{ id: 'a1', state: 'running', scenario: 'buy a sword' }])
  const [agent] = r.observe('agents:changed', [{ id: 'a1', state: 'passed', scenario: 'buy a sword' }])
  assert.equal(agent.title, 'Test agent passed')
})

test('notify router: long IPC calls and dedupe with the progress event', () => {
  let now = 0
  const r = new NotifyRouter({ now: () => now })
  assert.equal(r.task('vfxRefine', 5_000, true), null, 'short')
  assert.equal(r.task('vfxList', 60_000, true), null, 'not a long-task verb')
  assert.equal(r.task('terminalRunTask', 60_000, true), null, 'not a lab')
  const c = r.task('abilityCritique', 25_000, true)
  assert.equal(c?.title, 'Ability Composer: critique finished')
  assert.equal(c?.category, 'labs')
  // The progress "done" right after the IPC call ended: deduped.
  assert.deepEqual(r.observe('ability:progress', { entryId: 'x', phase: 'done' }), [])
  now += 60_000
  assert.equal(r.observe('ability:progress', { entryId: 'x', phase: 'done' }).length, 1, 'after the window it shows again')
  const rel = r.task('releaseRun', 90_000, false, 'upload failed')
  assert.equal(rel?.category, 'builds')
  assert.equal(rel?.title, 'Release failed')
  assert.equal(r.task('testsRun', 90_000, true), null, 'tests report through tests:progress')
  assert.equal(r.task('thumbnailGenerate', 40_000, true)?.title, 'Thumbnail Lab: generate finished')
})

test('notify: finalState reads generic payloads', () => {
  assert.equal(finalState({ phase: 'done' }), 'ok')
  assert.equal(finalState({ state: 'failed' }), 'error')
  assert.equal(finalState({ kind: 'end' }), 'ok')
  assert.equal(finalState({ done: true, error: 'x' }), 'error')
  assert.equal(finalState({ phase: 'render' }), null)
  assert.equal(finalState(null), null)
})

// ---------------------------------------------------------------- session state

test('session: round trip keeps tabs, cursors, labs, chats and layout', () => {
  const state: SessionState = {
    version: SESSION_VERSION,
    savedAt: 5,
    layout: { sideOpen: true, sideW: 300, bottomTab: 'shell' },
    activeChatId: 'c1',
    projects: {
      '/p/a': {
        tabs: [{ id: 'forge', kind: 'forge', title: 'Forge' }, { id: 'file:src/a.luau', kind: 'file', title: 'a', path: 'src/a.luau' }, { id: 'vfx', kind: 'vfx', title: 'VFX Lab' }],
        activeTab: 'file:src/a.luau',
        cursors: { 'src/a.luau': { line: 12, column: 4 } },
        labs: { 'vfx.selected': 'e1', 'vfx.view': 'effects' },
        savedAt: 10
      }
    },
    chats: { c1: { draft: 'half a thought', atBottom: false, scroll: 420 } }
  }
  const back = parseSession(serializeSession(state))
  assert.deepEqual(back.projects, state.projects)
  assert.deepEqual(back.chats, state.chats)
  assert.deepEqual(back.layout, state.layout)
  assert.equal(back.activeChatId, 'c1')
  assert.equal(back.version, SESSION_VERSION)
})

test('session: broken files and junk entries never throw', () => {
  assert.deepEqual(parseSession('{nope'), emptySession())
  assert.deepEqual(parseSession(''), emptySession())
  assert.deepEqual(parseSession('[1,2]'), emptySession())
  assert.deepEqual(parseSession('{"version":0}'), emptySession())
  const s = migrateSession({
    version: 2,
    projects: {
      '/p': { tabs: [null, 5, { id: 'x' }, { id: 'file:a', kind: 'file' }, { id: 'ok', kind: 'vfx', title: 'V' }, { id: 'ok', kind: 'vfx', title: 'dupe' }], cursors: { a: { line: 0, column: 1 }, b: { line: 3, column: 2 }, c: 'x' }, labs: { k: { nested: 1 }, j: 'v' } },
      '/q': 'garbage'
    },
    chats: { c: { draft: 7, scroll: -5 }, d: { draft: 'x'.repeat(30_000) } }
  })
  assert.deepEqual(s.projects['/p'].tabs, [{ id: 'ok', kind: 'vfx', title: 'V' }])
  assert.deepEqual(s.projects['/p'].cursors, { b: { line: 3, column: 2 } })
  assert.deepEqual(s.projects['/p'].labs, { j: 'v' })
  assert.equal(s.projects['/p'].activeTab, 'ok')
  assert.equal(s.projects['/q'], undefined)
  assert.equal(s.chats.c, undefined)
  assert.equal(s.chats.d.draft?.length, 20_000)
})

test('session: v1 files migrate to per-project state; newer versions keep what is understood', () => {
  const v1 = migrateSession({ version: 1, project: '/p/old', tabs: [{ id: 'file:src/x.luau', kind: 'file', title: 'x', path: 'src/x.luau' }], activeTab: 'file:src/x.luau', layout: { sideW: 250, junk: { a: 1 } }, cursors: { 'src/x.luau': { line: 3, column: 1 } } })
  assert.equal(v1.version, SESSION_VERSION)
  assert.deepEqual(v1.layout, { sideW: 250 })
  assert.equal(v1.projects['/p/old'].tabs[0].path, 'src/x.luau')
  assert.deepEqual(v1.projects['/p/old'].cursors, { 'src/x.luau': { line: 3, column: 1 } })
  const noProject = migrateSession({ version: 1, tabs: [{ id: 'forge', kind: 'forge', title: 'Forge' }] })
  assert.deepEqual(noProject.projects, {})
  const future = migrateSession({ version: 9, projects: { '/p': { tabs: [{ id: 'vfx', kind: 'vfx', title: 'VFX' }], newThing: 1 } }, somethingNew: true })
  assert.equal(future.projects['/p'].tabs.length, 1)
  assert.equal(future.version, SESSION_VERSION)
})

test('session: restorePlan skips deleted files, unknown pages, closed conflicts and transcripts', () => {
  const ps = migrateSession({
    version: 2,
    projects: {
      '/p': {
        tabs: [
          { id: 'file:gone.luau', kind: 'file', title: 'gone', path: 'gone.luau' },
          { id: 'file:here.luau', kind: 'file', title: 'here', path: 'here.luau' },
          { id: 'thumbs', kind: 'thumbs', title: 'Thumbnail Lab' },
          { id: 'conflict:c.luau', kind: 'conflict', title: 'c', path: 'c.luau' },
          { id: 'conflict:d.luau', kind: 'conflict', title: 'd', path: 'd.luau' },
          { id: 'transcript:a1', kind: 'transcript', title: 'a1', agentId: 'a1' },
          { id: 'vfx', kind: 'vfx', title: 'VFX Lab' }
        ],
        activeTab: 'file:gone.luau',
        cursors: { 'gone.luau': { line: 2, column: 1 }, 'here.luau': { line: 9, column: 3 } }
      }
    }
  }).projects['/p']
  const plan = restorePlan(ps, { fileExists: (p) => p === 'here.luau', knownPages: new Set(['vfx', 'forge']), conflicts: new Set(['d.luau']) })
  assert.deepEqual(plan.tabs.map((t) => t.id), ['file:here.luau', 'conflict:d.luau', 'vfx'])
  assert.equal(plan.activeTab, 'file:here.luau', 'falls back to the first surviving tab')
  assert.deepEqual(plan.cursors, { 'here.luau': { line: 9, column: 3 } })
})

// ---------------------------------------------------------------- digest

const US = '\x1f'
const RS = '\x1e'
function gitLog(rows: [string, string, string, number, string][]): string {
  return rows.map((r) => r.join(US) + RS + '\n').join('')
}

test('digest: git log parsing and commits by others', () => {
  assert.ok(GIT_LOG_FORMAT.includes('%x1f'))
  const commits = parseGitLog(gitLog([
    ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Mira', 'mira@x.dev', 1_700_000_000, 'Shop: weekly rotation'],
    ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Acid', 'ACID@x.dev', 1_700_000_100, 'My own work'],
    ['cccccccccccccccccccccccccccccccccccccccc', 'Jun', 'jun@x.dev', 1_700_000_200, 'Subject with \x1f odd char']
  ]) + 'garbage line')
  assert.equal(commits.length, 3)
  assert.equal(commits[0].at, 1_700_000_000_000)
  const others = commitsByOthers(commits, { email: 'acid@x.dev\n', name: 'Acid' })
  assert.deepEqual(others.map((c) => c.author), ['Mira', 'Jun'])
  assert.equal(commitsByOthers(commits, {}).length, 3)
  assert.equal(commitsByOthers(commits, { name: 'acid' }).length, 2)
})

function digestInputs(over: Partial<DigestInputs> = {}): DigestInputs {
  return {
    reason: 'open',
    since: 1000,
    project: 'Tree',
    syncEntries: [],
    commits: [],
    labRuns: [],
    syncStatus: null,
    studioConflicts: [],
    gitConflicts: [],
    tests: null,
    ...over
  }
}

test('digest: Studio pulls since last seen, per file, linking to the file', () => {
  const d = buildDigest(digestInputs({
    syncEntries: [
      { file: 'src/a.luau', action: 'pulled', instancePath: [], at: 500 }, // before since
      { file: 'src/b.luau', action: 'pulled', instancePath: [], at: 2000 },
      { file: 'src/b.luau', action: 'merged', instancePath: [], at: 3000 },
      { file: 'src/c.luau', action: 'disk-ahead', instancePath: [], at: 3000 }, // not a teammate edit
      { file: 'src/d.luau', action: 'trashed', instancePath: [], at: 2500 },
      { file: 'src/e.luau', action: 'same', instancePath: [], at: 2500 }
    ]
  }))
  assert.deepEqual(d.items.map((i) => i.text), ['b.luau merged with Studio edits', 'd.luau deleted in Studio'])
  assert.deepEqual(d.items[0].target, { kind: 'file', path: 'src/b.luau' })
  assert.deepEqual(d.items[1].target, { kind: 'side', view: 'sync' })
})

test('digest: blockers first, then commits, labs and failing tests; summary line', () => {
  const sync: SyncStatus = {
    engine: 'forge',
    places: [
      { placeKey: '1', projectFile: 'default.project.json', place: { placeId: 1, name: 'Lobby' }, gate: 'blocked', connected: true, counts: {}, conflicts: 2 },
      { placeKey: '2', projectFile: 'arena.project.json', gate: 'clear', connected: true, counts: {}, conflicts: 0 }
    ],
    recent: [],
    pendingStudioEdits: ['src/x.luau']
  }
  const many = Array.from({ length: 11 }, (_, i) => ({ hash: `${i}`.padStart(40, 'f'), author: 'Mira', email: 'm@x', at: 5000 + i, subject: `c${i}` }))
  const d = buildDigest(digestInputs({
    syncStatus: sync,
    studioConflicts: [{ path: 'src/k.luau', repoSource: '', studioSource: '', reason: 'both-changed' }, { path: 'src/k.luau', repoSource: '', studioSource: '', placeKey: '2' }],
    gitConflicts: ['src/g.luau'],
    commits: many,
    labRuns: [{ lab: 'vfx', label: 'VFX Lab run', ok: true, at: 4000, target: { kind: 'page', page: 'vfx', entryId: 'e' } }, { lab: 'anim', label: 'Animation Lab run', ok: false, at: 10 }],
    tests: { failed: 1, total: 4, failing: [{ file: 'src/s.spec.luau', name: 'S > works' }] }
  }))
  const kinds = d.items.map((i) => i.kind)
  assert.deepEqual(kinds.slice(0, 4), ['conflict', 'blocker', 'blocker', 'blocker'])
  assert.equal(d.items.filter((i) => i.kind === 'conflict').length, 1, 'same path once')
  assert.ok(d.items.some((i) => i.text === 'rojo serve is held for Lobby'))
  assert.equal(d.items.filter((i) => i.kind === 'commit').length, 9, '8 commits + "and 3 more"')
  assert.equal(d.items.find((i) => i.id === 'commit:more')?.text, 'and 3 more commits')
  assert.equal(d.items.find((i) => i.kind === 'commit')?.text, 'Mira: c10', 'newest first')
  assert.deepEqual(d.items.filter((i) => i.kind === 'lab').map((i) => i.text), ['VFX Lab run finished'], 'old lab run filtered by since')
  assert.deepEqual(d.items.find((i) => i.kind === 'lab')?.target, { kind: 'page', page: 'vfx', entryId: 'e' })
  assert.ok(d.items.some((i) => i.id === 'tests' && i.text === '1 test failing in the last run'))
  assert.deepEqual(d.items.find((i) => i.id.startsWith('test:'))?.target, { kind: 'file', path: 'src/s.spec.luau' })
  assert.equal(digestSummary(d), '4 blockers · 8 commits · 1 lab run · failing tests')
  assert.equal(buildDigest(digestInputs()).items.length, 0)
})

// ---------------------------------------------------------------- main service (fake git, fake sync)

interface Fake {
  service: QolService
  shown: { title: string; body: string; sound: boolean }[]
  emitted: [string, unknown][]
  copied: string[]
  settings: Map<string, unknown>
  git: { head: string; log: string; calls: string[][] }
  focused: { value: boolean }
  clock: { now: number }
  dir: string
}

function fake(over: Partial<QolDeps> = {}): Fake {
  const dir = mkdtempSync(join(tmpdir(), 'qol-'))
  const settings = new Map<string, unknown>()
  const shown: Fake['shown'] = []
  const emitted: Fake['emitted'] = []
  const copied: string[] = []
  const gitState = { head: 'a'.repeat(40), log: '', calls: [] as string[][] }
  const focused = { value: false }
  const clock = { now: 1_000_000 }
  const root = join(dir, 'Tree')
  const syncStatus: SyncStatus = { engine: 'forge', places: [], recent: [], pendingStudioEdits: [] }
  const service = new QolService({
    userDataDir: join(dir, 'userData'),
    getSetting: <T>(k: string, f: T) => (settings.has(k) ? (settings.get(k) as T) : f),
    setSetting: (k, v) => void settings.set(k, v),
    logs: () => [{ service: 'harness', stream: 'info', text: `opened ${root} with token=abcdef0123456789`, at: clock.now }],
    root: () => root,
    projectName: () => 'Tree',
    emit: (e, p) => void emitted.push([e, p]),
    log: () => undefined,
    isFocused: () => focused.value,
    showNotification: (n, onClick) => {
      shown.push(n)
      onClick()
    },
    focusWindow: () => undefined,
    capture: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    copy: (t) => void copied.push(t),
    reveal: () => undefined,
    app: { version: '0.5.0' },
    os: { platform: 'linux', release: '6.1', arch: 'x64' },
    homeDir: dir,
    git: async (args) => {
      gitState.calls.push(args)
      if (args[0] === 'rev-parse') return { code: 0, stdout: gitState.head + '\n' }
      if (args[0] === 'config') return args[1] === 'user.email' ? { code: 0, stdout: 'acid@x.dev\n' } : { code: 0, stdout: 'Acid\n' }
      if (args[0] === 'log') return { code: 0, stdout: gitState.log }
      return { code: 1, stdout: '' }
    },
    syncStatus: async () => syncStatus,
    studioConflicts: async () => [],
    gitStatus: async () => null,
    testsLast: async () => null,
    now: () => clock.now,
    ...over
  })
  return { service, shown, emitted, copied, settings, git: gitState, focused, clock, dir }
}

test('service: settings normalise and patch per category', () => {
  const f = fake()
  assert.deepEqual(f.service.settings(), DEFAULT_QOL_SETTINGS)
  const s = f.service.setSettings({ notify: { mode: 'always', categories: { chat: false } } })
  assert.equal(s.notify.mode, 'always')
  assert.equal(s.notify.categories.chat, false)
  assert.equal(s.notify.categories.labs, true)
  assert.equal(normalizeQolSettings({ notify: { mode: 'loud', sound: 'yes' }, digest: 1 }).notify.mode, 'unfocused')
})

test('service: notifications respect focus and open the target on click', () => {
  const f = fake()
  f.focused.value = true
  f.service.observe('vfx:progress', { entryId: 'e1', phase: 'done' })
  assert.equal(f.shown.length, 0, 'focused + unfocused mode')
  f.focused.value = false
  f.clock.now += 60_000
  f.service.observe('vfx:progress', { entryId: 'e2', phase: 'done' })
  assert.equal(f.shown.length, 1)
  assert.deepEqual(f.emitted.at(-1), ['qol:navigate', { kind: 'page', page: 'vfx', entryId: 'e2' }])
  f.service.setSettings({ notify: { categories: { labs: false } } })
  f.clock.now += 60_000
  f.service.observe('anim:progress', { entryId: 'e3', phase: 'done' })
  assert.equal(f.shown.length, 1, 'category off')
})

test('service: timed handlers notify long lab calls when they settle', async () => {
  const f = fake()
  const slow = f.service.timed('animCompose', async () => {
    f.clock.now += 45_000
    return 'ok'
  })
  assert.equal(await slow(), 'ok')
  await new Promise((r) => setImmediate(r))
  assert.equal(f.shown[0]?.title, 'Animation Lab: compose finished')
  const sync = f.service.timed('getProject', () => 42)
  assert.equal(sync(), 42)
})

test('service: bug report writes report.md + screenshot.png, copies markdown, redacts', async () => {
  const f = fake()
  f.service.recordError('main', 'boom', 'Error: boom\n at x')
  assert.deepEqual(await f.service.startBugReport(), { screenshot: true })
  const preview = await f.service.previewBugReport({ what: 'w', expected: 'e', includePath: false, includeScreenshot: true })
  assert.ok(preview.includes('![Forge window](screenshot.png)'))
  const r = await f.service.bugReport({ what: 'it broke', expected: 'not broken', includePath: false, includeScreenshot: true, page: 'Settings' })
  assert.ok(r.dir.includes(join('userData', 'bug-reports')))
  assert.ok(existsSync(r.reportPath))
  assert.ok(r.screenshotPath && existsSync(r.screenshotPath))
  const md = readFileSync(r.reportPath, 'utf8')
  assert.equal(md, r.markdown)
  assert.equal(f.copied[0], md)
  assert.ok(md.includes('boom'))
  assert.ok(!md.includes('abcdef0123456789'))
  assert.ok(md.includes('opened <Tree>'))
  assert.ok(r.redactions >= 1)
  const second = await f.service.bugReport({ what: '', expected: '', includePath: true, includeScreenshot: false })
  assert.notEqual(second.dir, r.dir, 'same second gets its own folder')
  assert.equal(second.screenshotPath, null)
})

test('service: session file save/load and tolerance to a corrupt file', () => {
  const f = fake()
  const s = emptySession()
  s.chats.c = { draft: 'x' }
  f.service.saveSession(s)
  assert.equal(f.service.loadSession().chats.c.draft, 'x')
  writeFileSync(join(f.dir, 'userData', 'session-state.json'), '{"version":2, "projects": ')
  assert.deepEqual(f.service.loadSession(), emptySession())
})

test('service: digest on open uses the last seen HEAD and only shows others\' commits', async () => {
  const f = fake()
  const root = join(f.dir, 'Tree')
  // First session: nothing to compare with.
  await f.service.onProjectOpen(root)
  assert.equal(await f.service.digest({ reason: 'open' }), null)
  await f.service.onProjectClose()
  // Teammates pushed; we pulled: HEAD moved.
  f.git.head = 'b'.repeat(40)
  f.git.log = gitLog([
    ['cccccccccccccccccccccccccccccccccccccccc', 'Mira', 'mira@x.dev', 1_700_000_000, 'Shop rotation'],
    ['dddddddddddddddddddddddddddddddddddddddd', 'Acid', 'acid@x.dev', 1_700_000_100, 'mine']
  ])
  f.clock.now += 3_600_000
  await f.service.onProjectOpen(root)
  // Forge Sync pulls a teammate's Studio edit after open.
  f.clock.now += 1000
  f.service.observe('sync:entry', [{ file: 'src/a.luau', action: 'pulled', instancePath: [], at: f.clock.now }])
  const d = await f.service.digest({ reason: 'open' })
  assert.ok(d)
  assert.deepEqual(d.items.map((i) => i.text), ['a.luau edited in Studio', 'Mira: Shop rotation'])
  const logCall = f.git.calls.find((c) => c[0] === 'log')!
  assert.ok(logCall.includes(`${'a'.repeat(40)}..HEAD`), logCall.join(' '))
  // Setting off: no digest.
  f.service.setSettings({ digest: false })
  assert.equal(await f.service.digest({ reason: 'open' }), null)
})

test('service: idle digest covers lab runs since the user left', async () => {
  const f = fake()
  const root = join(f.dir, 'Tree')
  await f.service.onProjectOpen(root)
  const left = f.clock.now
  f.clock.now += 2 * 3_600_000
  f.service.observe('vfx:progress', { entryId: 'e9', phase: 'done', message: 'Purple slash ready' })
  const d = await f.service.digest({ reason: 'idle', since: left })
  assert.ok(d)
  assert.equal(d.reason, 'idle')
  assert.deepEqual(d.items.map((i) => i.text), ['VFX Lab run finished'])
  assert.deepEqual(d.items[0].target, { kind: 'page', page: 'vfx', entryId: 'e9' })
})

test('service: the automatic open digest is answered once per project open (a renderer reload gets null)', async () => {
  const f = fake()
  const root = join(f.dir, 'Tree')
  await f.service.onProjectOpen(root)
  await f.service.onProjectClose()
  f.clock.now += 3_600_000
  await f.service.onProjectOpen(root)
  f.clock.now += 1000
  f.service.observe('sync:entry', [{ file: 'src/a.luau', action: 'pulled', instancePath: [], at: f.clock.now }])
  assert.ok(await f.service.digest({ reason: 'open' }), 'first open shows the digest')
  assert.equal(await f.service.digest({ reason: 'open' }), null, 'a reloaded renderer asking again gets nothing')
  assert.ok(await f.service.digest({ reason: 'open', again: true }), 'Show digest / a refresh of the card still answers')
  assert.ok(await f.service.digest({ reason: 'idle', since: f.clock.now - 2000 }), 'idle digests are unaffected')
  // Opening the project again (new session) shows it again.
  await f.service.onProjectClose()
  await f.service.onProjectOpen(root)
  f.service.observe('sync:entry', [{ file: 'src/b.luau', action: 'pulled', instancePath: [], at: f.clock.now + 5 }])
  f.clock.now += 10
  assert.ok(await f.service.digest({ reason: 'open' }))
})
