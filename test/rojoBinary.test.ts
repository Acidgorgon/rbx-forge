import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, test } from 'node:test'
import type { ServiceStatus } from '../src/shared/types.ts'
import { ASSETS, FORGE_BUILD, ForgeRojo, type ForgeRojoDeps, parseRojoVersion, RELEASE_TAG, ROJO_VERSION } from '../src/main/services/rojoBinary.ts'
import { Supervisor } from '../src/main/services/supervisor.ts'
import { makeProject, write } from './fixture.ts'

const temps: string[] = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})
const tmp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const shOnly = { skip: process.platform === 'win32' ? 'uses a /bin/sh fake rojo' : false }

const BODY = Buffer.from('#!/bin/sh\necho crash-safe\n')
const SHA = createHash('sha256').update(BODY).digest('hex')

function forgeRojo(over: Partial<ForgeRojoDeps> = {}) {
  const urls: string[] = []
  const lines: string[] = []
  const deps: ForgeRojoDeps = {
    dir: tmp('forge-rojo-'),
    platform: 'linux',
    arch: 'x64',
    assets: { 'linux-x64': { asset: 'rojo-test-linux-x86_64', sha256: SHA } },
    get: async (url) => {
      urls.push(url)
      return { status: 200, body: BODY }
    },
    version: async () => `Rojo ${ROJO_VERSION}`,
    enabled: () => true,
    log: (text) => lines.push(text),
    waitMs: 2000,
    ...over
  }
  return { rojo: new ForgeRojo(deps), urls, lines, deps }
}

test('parseRojoVersion reads rojo --version output', () => {
  assert.equal(parseRojoVersion('Rojo 7.7.0'), '7.7.0')
  assert.equal(parseRojoVersion('rojo 7.4.4\n'), '7.4.4')
  assert.equal(parseRojoVersion('Rojo 7.7.0-rc.1'), '7.7.0-rc.1')
  assert.equal(parseRojoVersion('error: no tool named rojo'), null)
})

test('every platform asset is named for this build and comes from its release', () => {
  for (const [key, a] of Object.entries(ASSETS)) {
    assert.ok(a.asset.startsWith(`rojo-${FORGE_BUILD}-`), key)
    assert.ok(key !== 'win32-x64' || a.asset.endsWith('.exe'))
  }
  assert.equal(RELEASE_TAG, `rojo-${FORGE_BUILD}`)
})

test('the crash-safe build is downloaded once, checked, and served for the same rojo version', async () => {
  const { rojo, urls } = forgeRojo()
  const first = await rojo.choose('/project/rojo', '/project')
  assert.equal(first.crashSafe, true, first.why)
  assert.notEqual(first.file, '/project/rojo')
  assert.deepEqual(readFileSync(first.file), BODY)
  assert.equal(urls.length, 1)
  assert.match(urls[0], new RegExp(`/releases/download/${RELEASE_TAG}/rojo-test-linux-x86_64$`))
  const again = await rojo.choose('/project/rojo', '/project')
  assert.equal(again.file, first.file)
  assert.equal(urls.length, 1, 'not downloaded again')
})

test('a build already on disk with the right checksum is used without downloading', async () => {
  const one = forgeRojo()
  await one.rojo.ensure()
  const two = forgeRojo({ dir: one.deps.dir })
  assert.equal((await two.rojo.choose('/p/rojo', '/p')).crashSafe, true)
  assert.equal(two.urls.length, 0)
})

test('a download with the wrong checksum is refused and the project rojo serves', async () => {
  const { rojo, lines } = forgeRojo({ get: async () => ({ status: 200, body: Buffer.from('tampered') }) })
  const choice = await rojo.choose('/p/rojo', '/p')
  assert.equal(choice.crashSafe, false)
  assert.equal(choice.file, '/p/rojo')
  assert.match(choice.why, /could not be downloaded \(checksum mismatch/)
  assert.ok(lines.some((l) => /checksum mismatch/.test(l)))
})

test('a project pinned to another rojo version keeps its own rojo (the Studio plugin expects it)', async () => {
  const { rojo, urls } = forgeRojo({ version: async () => 'Rojo 7.4.4' })
  const choice = await rojo.choose('/p/rojo', '/p')
  assert.equal(choice.file, '/p/rojo')
  assert.match(choice.why, /project's rojo is 7\.4\.4/)
  assert.equal(urls.length, 0)
})

test('the setting off, or no build for the platform, serves with the project rojo', async () => {
  const off = forgeRojo({ enabled: () => false })
  assert.equal((await off.rojo.choose('/p/rojo', '/p')).file, '/p/rojo')
  assert.equal(off.urls.length, 0)
  const none = forgeRojo({ arch: 'riscv64' })
  assert.equal((await none.rojo.choose('/p/rojo', '/p')).file, '/p/rojo')
  // An entry without a pinned checksum is never downloaded.
  const unpinned = forgeRojo({ assets: { 'linux-x64': { asset: 'x', sha256: '' } } })
  assert.equal((await unpinned.rojo.choose('/p/rojo', '/p')).file, '/p/rojo')
  assert.equal(unpinned.urls.length, 0)
})

test('a slow download does not hold rojo serve past waitMs; the next start uses it', async () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((r) => (release = r))
  const { rojo } = forgeRojo({
    waitMs: 50,
    get: async () => {
      await gate
      return { status: 200, body: BODY }
    }
  })
  const first = await rojo.choose('/p/rojo', '/p')
  assert.equal(first.file, '/p/rojo')
  assert.match(first.why, /still downloading/)
  release()
  await rojo.ensure()
  assert.equal((await rojo.choose('/p/rojo', '/p')).crashSafe, true)
})

test('supervisor serves with the binary chooseRojo picks', shOnly, async () => {
  const home = tmp('crashsafe-home-')
  const bin = tmp('crashsafe-bin-')
  const safe = tmp('crashsafe-safe-')
  const marks = join(bin, 'runs.log')
  write(bin, 'rojo', `#!/bin/sh\necho project >> "${marks}"\necho "Port: 34872"\nexec sleep 60\n`)
  write(safe, 'rojo', `#!/bin/sh\necho crash-safe "$@" >> "${marks}"\necho "Port: 34872"\nexec sleep 60\n`)
  chmodSync(join(bin, 'rojo'), 0o755)
  chmodSync(join(safe, 'rojo'), 0o755)
  const env = { HOME: process.env.HOME, PATH: process.env.PATH }
  process.env.HOME = home
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`
  const root = makeProject()
  temps.push(root)
  let statuses: ServiceStatus[] = []
  const asked: string[] = []
  const supervisor = new Supervisor({
    log: () => undefined,
    onStatus: (s) => (statuses = s),
    getSetting: <T>(_key: string, fallback: T) => fallback,
    chooseRojo: async (projectRojo, r) => {
      asked.push(`${projectRojo}|${r}`)
      return { file: join(safe, 'rojo'), why: 'test' }
    }
  })
  try {
    await supervisor.setRoot(root)
    await supervisor.start('rojo')
    const end = Date.now() + 5000
    while (!(existsSync(marks) && statuses.find((s) => s.id === 'rojo')?.state === 'running') && Date.now() < end) await sleep(25)
    assert.match(readFileSync(marks, 'utf8'), /^crash-safe serve default\.project\.json/)
    assert.deepEqual(asked, [`${join(bin, 'rojo')}|${root}`])
  } finally {
    await supervisor.stopAll()
    process.env.HOME = env.HOME
    process.env.PATH = env.PATH
  }
})

// The crash itself, against real rojo binaries (tools/rojo/burst-test.mjs; CI runs it in rojo.yml):
//   FORGE_TEST_UPSTREAM_ROJO=<rojo 7.7.0>       must crash (reproduces the bug)
//   FORGE_TEST_ROJO=<crash-safe rojo build>     must keep serving
const burst = join(import.meta.dirname, '..', 'tools', 'rojo', 'burst-test.mjs')
test('upstream rojo 7.7.0 exits when a folder vanishes mid-sync', { skip: process.env.FORGE_TEST_UPSTREAM_ROJO ? false : 'set FORGE_TEST_UPSTREAM_ROJO' }, () => {
  execFileSync(process.execPath, [burst, process.env.FORGE_TEST_UPSTREAM_ROJO as string, '--expect-crash'], { stdio: 'inherit', timeout: 120_000 })
})
test('the crash-safe rojo keeps serving when a folder vanishes mid-sync', { skip: process.env.FORGE_TEST_ROJO ? false : 'set FORGE_TEST_ROJO' }, () => {
  execFileSync(process.execPath, [burst, process.env.FORGE_TEST_ROJO as string], { stdio: 'inherit', timeout: 120_000 })
})
