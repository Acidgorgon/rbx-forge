// Self-update: the state machine (services/updater/controller.ts) driven by a fake electron-updater,
// the helpers in util.ts, the renderer's restart guard and the CI latest.yml merge script.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CHECK_EVERY_MS, FIRST_CHECK_DELAY_MS, UpdateController, type UpdaterLike, type UpdateControllerDeps } from '../src/main/services/updater/controller.ts'
import { classifyUpdateError, macSignatureKind, notesToText, parseFeedConfig, releasePageUrl } from '../src/main/services/updater/util.ts'
import { restartBlockers } from '../src/renderer/src/updates/blockers.ts'
import type { UpdateState } from '../src/shared/updateTypes.ts'
// @ts-expect-error plain .mjs build script without types
import { mergeDirs, mergeUpdateInfos, parseUpdateInfo } from '../build/merge-update-info.mjs'

const FEED = { owner: 'Acidgorgon', repo: 'rbx-forge' }

// Fake AppUpdater: records calls; the test emits the events electron-updater would.
class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = false
  allowDowngrade = true
  checks = 0
  installs: [boolean | undefined, boolean | undefined][] = []
  // What the next checkForUpdates does.
  next: (u: FakeUpdater) => Promise<unknown> = async () => ({})
  checkForUpdates(): Promise<unknown> {
    this.checks++
    return this.next(this)
  }
  downloadUpdate(): Promise<unknown> {
    return Promise.resolve([])
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter])
  }
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status, code: `HTTP_ERROR_${status}` })
}

function setup(over: Partial<UpdateControllerDeps> = {}) {
  const updater = new FakeUpdater()
  const store = new Map<string, unknown>()
  const states: UpdateState[] = []
  const timers: { fn: () => void; ms: number; repeat: boolean; cleared: boolean }[] = []
  const opened: string[] = []
  const deps: UpdateControllerDeps = {
    updater,
    currentVersion: '0.2.0',
    feed: FEED,
    mode: 'install',
    settings: { get: <T>(k: string, f: T) => (store.has(k) ? (store.get(k) as T) : f), set: (k, v) => void store.set(k, v) },
    emit: (s) => states.push(s),
    openExternal: (url) => void opened.push(url),
    log: () => undefined,
    now: () => 1_000_000_000,
    setTimer: (fn, ms) => {
      const t = { fn, ms, repeat: false, cleared: false }
      timers.push(t)
      return t
    },
    clearTimer: (h) => void ((h as { cleared: boolean }).cleared = true),
    setRepeat: (fn, ms) => {
      const t = { fn, ms, repeat: true, cleared: false }
      timers.push(t)
      return t
    },
    clearRepeat: (h) => void ((h as { cleared: boolean }).cleared = true),
    ...over
  }
  const controller = new UpdateController(deps)
  return { controller, updater, store, states, timers, opened }
}

const INFO = { version: '0.2.1', releaseName: 'v0.2.1', releaseNotes: '<h2>Changes</h2><ul><li>Auto-update</li><li>Fix &amp; polish</li></ul>', releaseDate: '2026-10-12T00:00:00.000Z' }

test('install mode: check -> available -> downloading -> ready, then restart installs silently', async () => {
  const { controller, updater, states } = setup()
  assert.equal(updater.autoDownload, true)
  assert.equal(updater.autoInstallOnAppQuit, true)
  assert.equal(updater.allowDowngrade, false)
  assert.equal(controller.current.phase, 'idle')

  updater.next = async (u) => {
    u.emit('checking-for-update')
    u.emit('update-available', INFO)
    return { updateInfo: INFO }
  }
  const after = await controller.check()
  assert.equal(after.phase, 'downloading')
  assert.equal(after.offer?.version, '0.2.1')
  assert.equal(after.offer?.url, 'https://github.com/Acidgorgon/rbx-forge/releases/tag/v0.2.1')
  assert.equal(after.offer?.notes, 'Changes\n\n- Auto-update\n- Fix & polish')
  assert.ok(after.lastCheck)
  assert.ok(states.some((s) => s.phase === 'checking'))

  updater.emit('download-progress', { percent: 41.6 })
  assert.equal(controller.current.percent, 42)
  updater.emit('update-downloaded', INFO)
  assert.equal(controller.current.phase, 'ready')
  assert.equal(controller.current.percent, 100)

  // Nothing installs until the user restarts.
  assert.equal(updater.installs.length, 0)
  controller.install()
  assert.deepEqual(updater.installs, [[true, true]])
})

test('up to date: update-not-available -> none; a skipped check (null result) also settles', async () => {
  const { controller, updater } = setup()
  updater.next = async (u) => {
    u.emit('checking-for-update')
    u.emit('update-not-available', { version: '0.2.0' })
    return { updateInfo: { version: '0.2.0' } }
  }
  assert.equal((await controller.check()).phase, 'none')
  updater.next = async () => null
  assert.equal((await controller.check()).phase, 'none')
})

test('install refuses before an update is ready', () => {
  const { controller, updater } = setup()
  assert.throws(() => controller.install(), /No update is ready/)
  assert.equal(updater.installs.length, 0)
})

test('private repo: the 404 from the releases feed becomes a clear, non-throwing error', async () => {
  const { controller, updater } = setup()
  const error = httpError(404, '404 Not Found\nHeaders: {}')
  updater.next = async (u) => {
    u.emit('checking-for-update')
    // electron-updater emits 'error' and rejects with the same error.
    u.emit('error', error)
    throw error
  }
  const state = await controller.check()
  assert.equal(state.phase, 'error')
  assert.equal(state.error?.kind, 'private')
  assert.match(state.error!.message, /Acidgorgon\/rbx-forge/)
  assert.match(state.error!.message, /never ships a GitHub token/)
  assert.equal(state.error?.detail, '404 Not Found')

  // The next good check clears the error.
  updater.next = async (u) => {
    u.emit('checking-for-update')
    u.emit('update-not-available', { version: '0.2.0' })
    return {}
  }
  const ok = await controller.check()
  assert.equal(ok.phase, 'none')
  assert.equal(ok.error, undefined)
})

test('a failed download keeps the offer and reports the error', async () => {
  const { controller, updater } = setup()
  updater.next = async (u) => {
    u.emit('update-available', INFO)
    return {}
  }
  await controller.check()
  updater.emit('error', Object.assign(new Error('net::ERR_INTERNET_DISCONNECTED'), { code: 'ERR_INTERNET' }))
  assert.equal(controller.current.phase, 'error')
  assert.equal(controller.current.error?.kind, 'offline')
  assert.equal(controller.current.offer?.version, '0.2.1')
})

test('manual mode (unsigned Mac): no background download, available opens the release page', async () => {
  const { controller, updater, opened } = setup({ mode: 'manual', modeNote: 'ad-hoc' })
  assert.equal(updater.autoDownload, false)
  assert.equal(updater.autoInstallOnAppQuit, false)
  updater.next = async (u) => {
    u.emit('update-available', INFO)
    return {}
  }
  const state = await controller.check()
  assert.equal(state.phase, 'available')
  assert.equal(state.note, 'ad-hoc')
  assert.throws(() => controller.install(), /release page/)
  controller.openRelease()
  assert.deepEqual(opened, ['https://github.com/Acidgorgon/rbx-forge/releases/tag/v0.2.1'])
})

test('disabled builds never check or schedule', async () => {
  const { controller, updater, timers } = setup({ disabledReason: 'Development build.' })
  controller.start()
  assert.equal(timers.length, 0)
  const state = await controller.check()
  assert.equal(state.phase, 'disabled')
  assert.equal(state.note, 'Development build.')
  assert.equal(updater.checks, 0)
})

test('schedule: first check after a short delay, then every 4 hours; auto-check off clears both', async () => {
  const { controller, updater, timers, store } = setup()
  controller.start()
  assert.deepEqual(timers.map((t) => [t.ms, t.repeat]), [[FIRST_CHECK_DELAY_MS, false], [CHECK_EVERY_MS, true]])
  assert.equal(CHECK_EVERY_MS, 4 * 60 * 60 * 1000)
  timers[0].fn()
  await new Promise((r) => setImmediate(r))
  assert.equal(updater.checks, 1)

  controller.setSettings({ autoCheck: false })
  assert.ok(timers.every((t) => t.cleared))
  assert.deepEqual(store.get('updates'), { autoCheck: false, channel: 'stable', quick: true })
  assert.equal(controller.current.autoCheck, false)
})

test('the timer leaves a running download and a ready update alone', async () => {
  const { controller, updater, timers } = setup()
  updater.next = async (u) => {
    u.emit('update-available', INFO)
    return {}
  }
  await controller.check()
  assert.equal(controller.current.phase, 'downloading')
  controller.start()
  timers.find((t) => t.repeat)!.fn()
  await controller.check(true)
  assert.equal(updater.checks, 1, 'no check while downloading')
  updater.emit('update-downloaded', INFO)
  timers.find((t) => t.repeat && !t.cleared)!.fn()
  await new Promise((r) => setImmediate(r))
  assert.equal(updater.checks, 1, 'the timer does not re-check a ready update')
  await controller.check(true)
  assert.equal(updater.checks, 2, '"Check now" still works')
})

test('channel: beta sets allowPrerelease, is saved, and re-checks', async () => {
  const { controller, updater, store } = setup()
  assert.equal(updater.allowPrerelease, false)
  const state = controller.setSettings({ channel: 'beta' })
  assert.equal(state.channel, 'beta')
  assert.equal(updater.allowPrerelease, true)
  assert.deepEqual(store.get('updates'), { autoCheck: true, channel: 'beta', quick: true })
  await new Promise((r) => setImmediate(r))
  assert.equal(updater.checks, 1)

  // Saved settings are read back on the next launch.
  const again = setup()
  again.store.set('updates', { autoCheck: false, channel: 'beta' })
  const c2 = new UpdateController({
    updater: again.updater,
    currentVersion: '0.2.0',
    feed: FEED,
    mode: 'install',
    settings: { get: <T>(k: string, f: T) => (again.store.has(k) ? (again.store.get(k) as T) : f), set: () => undefined },
    emit: () => undefined,
    openExternal: () => undefined,
    log: () => undefined
  })
  assert.equal(c2.current.channel, 'beta')
  assert.equal(c2.current.autoCheck, false)
  assert.equal(again.updater.allowPrerelease, true)
})

test('classifyUpdateError', () => {
  assert.equal(classifyUpdateError(httpError(404, '404 Not Found'), FEED).kind, 'private')
  // Stable channel: /releases/latest 404 is wrapped by electron-updater.
  assert.equal(classifyUpdateError(Object.assign(new Error('Unable to find latest version on GitHub (https://github.com/a/b/releases/latest), please ensure a production release exists: HttpError: 404 Not Found'), { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' }), FEED).kind, 'private')
  assert.equal(classifyUpdateError(Object.assign(new Error('No published versions on GitHub'), { code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' }), FEED).kind, 'noReleases')
  assert.equal(classifyUpdateError(Object.assign(new Error('Cannot find latest.yml'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }), FEED).kind, 'noMetadata')
  assert.equal(classifyUpdateError(httpError(403, '403 Forbidden'), FEED).kind, 'rateLimited')
  assert.equal(classifyUpdateError(Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' }), FEED).kind, 'offline')
  assert.equal(classifyUpdateError(new Error('boom'), null).kind, 'other')
  assert.equal(classifyUpdateError('weird', null).detail, 'weird')
})

test('parseFeedConfig reads app-update.yml', () => {
  assert.deepEqual(parseFeedConfig('owner: Acidgorgon\nrepo: rbx-forge-releases\nprovider: github\nupdaterCacheDirName: rbx-forge-updater\n'), { owner: 'Acidgorgon', repo: 'rbx-forge-releases' })
  assert.equal(parseFeedConfig('provider: generic\nurl: https://example.com\n'), null)
  assert.equal(parseFeedConfig(''), null)
  assert.equal(releasePageUrl(FEED), 'https://github.com/Acidgorgon/rbx-forge/releases/latest')
  assert.equal(releasePageUrl(FEED, 'v0.3.0-beta.2'), 'https://github.com/Acidgorgon/rbx-forge/releases/tag/v0.3.0-beta.2')
})

test('macSignatureKind tells Developer ID from ad-hoc', () => {
  assert.equal(macSignatureKind('Executable=/Applications/RBX Forge.app/Contents/MacOS/RBX Forge\nIdentifier=com.acidgorgon.rbxforge\nSignature=adhoc\nTeamIdentifier=not set'), 'adhoc')
  assert.equal(macSignatureKind('Authority=Developer ID Application: Someone (ABCDE12345)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=ABCDE12345'), 'developerId')
  assert.equal(macSignatureKind('/Applications/X.app: code object is not signed at all'), 'unsigned')
  assert.equal(macSignatureKind('Authority=Apple Development: me'), 'other')
})

test('notesToText strips HTML and handles the full-changelog array form', () => {
  assert.equal(notesToText('<p>One<br>Two</p><script>x()</script><p>&lt;b&gt; &#39;q&#39;</p>'), "One\nTwo\n\n<b> 'q'")
  assert.equal(notesToText([{ version: '0.2.2', note: '<p>B</p>' }, { version: '0.2.1', note: 'A' }]), '0.2.2\nB\n\n0.2.1\nA')
  assert.equal(notesToText(null), '')
})

test('restartBlockers lists what a restart would interrupt', () => {
  const idle = { files: [{ path: 'src/a.luau', current: 'x', saved: 'x' }], busy: { c1: false }, agents: [{ state: 'passed' }], boards: [{ state: 'done' }], testsRunning: false }
  assert.deepEqual(restartBlockers(idle), [])
  const busy = restartBlockers({
    files: [{ path: 'src/server/A.luau', current: 'x', saved: 'y' }, { path: 'src\\b.luau', current: '1', saved: '2' }],
    busy: { c1: true },
    agents: [{ state: 'running' }, { state: 'queued' }],
    boards: [{ state: 'integrating' }],
    testsRunning: true
  })
  assert.deepEqual(busy, ['2 files have unsaved changes (A.luau, b.luau)', '1 chat is still answering', '2 test agents are running', '1 agent team is working', 'Lune tests are running'])
})

// ---- build/merge-update-info.mjs

const winX64 = `version: 0.2.1
files:
  - url: RBX-Forge-0.2.1-win-x64.exe
    sha512: AAA
    size: 100
path: RBX-Forge-0.2.1-win-x64.exe
sha512: AAA
releaseDate: '2026-10-12T10:00:00.000Z'
`
const winArm = `version: 0.2.1
files:
  - url: RBX-Forge-0.2.1-win-arm64.exe
    sha512: BBB
    size: 90
path: RBX-Forge-0.2.1-win-arm64.exe
sha512: BBB
releaseDate: '2026-10-12T10:05:00.000Z'
`
const macArm = `version: 0.2.1
files:
  - url: RBX-Forge-0.2.1-mac-arm64.zip
    sha512: CCC
    size: 80
path: RBX-Forge-0.2.1-mac-arm64.zip
sha512: CCC
releaseDate: '2026-10-12T10:01:00.000Z'
`
const macX64 = `version: 0.2.1
files:
  - url: RBX-Forge-0.2.1-mac-x64.zip
    sha512: DDD
    size: 85
path: RBX-Forge-0.2.1-mac-x64.zip
sha512: DDD
releaseDate: '2026-10-12T09:59:00.000Z'
`

test('mergeUpdateInfos lists both arches (x64 first), keeps the newest date and rejects mismatches', () => {
  const merged = mergeUpdateInfos([parseUpdateInfo(winArm), parseUpdateInfo(winX64)])
  assert.deepEqual(merged.files.map((f: { url: string }) => f.url), ['RBX-Forge-0.2.1-win-x64.exe', 'RBX-Forge-0.2.1-win-arm64.exe'])
  assert.equal(merged.path, 'RBX-Forge-0.2.1-win-x64.exe')
  assert.equal(merged.sha512, 'AAA')
  assert.equal(merged.releaseDate, '2026-10-12T10:05:00.000Z')
  assert.deepEqual(Object.keys(merged).slice(0, 4), ['version', 'files', 'path', 'sha512'])

  assert.throws(() => mergeUpdateInfos([parseUpdateInfo(winX64), { ...parseUpdateInfo(winArm), version: '0.2.2' }]), /disagree on version/)
  assert.throws(() => mergeUpdateInfos([parseUpdateInfo(winX64), parseUpdateInfo(winX64.replace(/AAA/g, 'ZZZ'))]), /different checksums/)
  // The same file twice (re-run job) is fine.
  assert.equal(mergeUpdateInfos([parseUpdateInfo(winX64), parseUpdateInfo(winX64)]).files.length, 1)
})

test('mergeDirs merges latest.yml and latest-mac.yml across job folders', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-merge-'))
  const jobs = ['mac-arm64', 'mac-x64', 'win-x64', 'win-arm64'].map((n) => join(root, n))
  for (const j of jobs) mkdirSync(j)
  writeFileSync(join(jobs[0], 'latest-mac.yml'), macArm)
  writeFileSync(join(jobs[1], 'latest-mac.yml'), macX64)
  writeFileSync(join(jobs[2], 'latest.yml'), winX64)
  writeFileSync(join(jobs[3], 'latest.yml'), winArm)
  writeFileSync(join(jobs[3], 'builder-debug.yml'), 'x: 1\n')
  const out = join(root, 'out')
  const written = mergeDirs(out, jobs)
  assert.deepEqual(written.map((w: { name: string }) => w.name).sort(), ['latest-mac.yml', 'latest.yml'])
  const mac = parseUpdateInfo(readFileSync(join(out, 'latest-mac.yml'), 'utf8'))
  assert.deepEqual(mac.files.map((f: { url: string }) => f.url), ['RBX-Forge-0.2.1-mac-x64.zip', 'RBX-Forge-0.2.1-mac-arm64.zip'])
  const win = readFileSync(join(out, 'latest.yml'), 'utf8')
  assert.match(win, /^version: 0\.2\.1\nfiles:\n {2}- url: RBX-Forge-0\.2\.1-win-x64\.exe\n/)
})
