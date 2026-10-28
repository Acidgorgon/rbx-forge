import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { trailingDebounce } from '../src/shared/debounce.ts'
import { appChecks, isRosetta } from '../src/shared/doctor/checks.ts'
import type { DoctorInputs } from '../src/shared/doctor/types.ts'
import { MtimeJsonCache } from '../src/main/services/jsonCache.ts'
import { isWatched } from '../src/main/services/lspBridge.ts'
import { isVendoredPath, pruneMissing, Project } from '../src/main/services/project.ts'
import { CONFLICTS_POLL_MS } from '../src/main/services/studioConflicts.ts'
import { makeProject, write } from './fixture.ts'

const dirs: string[] = []
const opened: Project[] = []
after(() => {
  for (const project of opened) project.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'perf-main-'))
  dirs.push(dir)
  return dir
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('MtimeJsonCache reuses the parse until mtime or size changes', async () => {
  const dir = tempDir()
  const file = join(dir, 'sourcemap.json')
  const cache = new MtimeJsonCache()
  assert.equal(await cache.read(file), null)
  writeFileSync(file, '{"name":"a"}')
  const first = await cache.read<{ name: string }>(file)
  assert.equal(first?.name, 'a')
  assert.equal(await cache.read(file), first, 'same object while unchanged')
  // Same size, new mtime.
  writeFileSync(file, '{"name":"b"}')
  utimesSync(file, new Date(), new Date(Date.now() + 5000))
  assert.equal((await cache.read<{ name: string }>(file))?.name, 'b')
  // Different size.
  writeFileSync(file, '{"name":"longer"}')
  assert.equal((await cache.read<{ name: string }>(file))?.name, 'longer')
  // A half-written file is null, not cached, and recovers.
  writeFileSync(file, '{"name":')
  assert.equal(await cache.read(file), null)
  writeFileSync(file, '{"name":"c"}')
  assert.equal((await cache.read<{ name: string }>(file))?.name, 'c')
})

test('trailingDebounce coalesces a burst, flushes and cancels', async () => {
  let runs = 0
  const debounced = trailingDebounce(() => runs++, 30)
  debounced.call()
  debounced.call()
  await wait(15)
  debounced.call()
  assert.ok(debounced.pending)
  await wait(20)
  assert.equal(runs, 0, 'each call restarts the wait')
  await wait(30)
  assert.equal(runs, 1)
  assert.ok(!debounced.pending)
  debounced.call()
  debounced.flush()
  assert.equal(runs, 2)
  debounced.flush()
  assert.equal(runs, 2, 'nothing pending')
  debounced.call()
  debounced.cancel()
  await wait(50)
  assert.equal(runs, 2)
})

test('pruneMissing skips the stat for Packages and ServerPackages', async () => {
  const root = tempDir()
  assert.ok(isVendoredPath('Packages/_Index/x/y.luau') && isVendoredPath('ServerPackages/a.luau'))
  assert.ok(!isVendoredPath('src/Packages/a.luau'))
  const node = (name: string, filePath: string) => ({ name, className: 'ModuleScript', filePath, children: [] })
  const tree = await pruneMissing(root, [node('Wally', 'Packages/Gone.luau'), node('Srv', 'ServerPackages/Gone.luau'), node('Mine', 'src/Gone.luau')])
  assert.deepEqual(tree.map((n) => n.name), ['Wally', 'Srv'])
  // Many nodes with real files stay in order under the bounded concurrency.
  mkdirSync(join(root, 'src'))
  const nodes = Array.from({ length: 200 }, (_, i) => {
    writeFileSync(join(root, 'src', `M${i}.luau`), 'return {}')
    return node(`M${i}`, `src/M${i}.luau`)
  })
  const kept = await pruneMissing(root, [...nodes.slice(0, 100), node('Missing', 'src/none.luau'), ...nodes.slice(100)])
  assert.deepEqual(kept.map((n) => n.name), nodes.map((n) => n.name))
})

test('refresh reports no change for an unchanged project and a change after an edit', async () => {
  const root = makeProject()
  dirs.push(root)
  const project = await Project.open(root)
  opened.push(project)
  const again = await project.refresh()
  assert.deepEqual(again, { info: false, tree: false, scripts: false, places: false })
  write(root, 'src/server/Data/Fresh.luau', 'return {}\n')
  const change = await project.refresh()
  assert.ok(change.tree && change.scripts)
  assert.deepEqual(await project.refresh(), { info: false, tree: false, scripts: false, places: false })
})

test('language server watcher ignores vendored and generated folders', () => {
  for (const path of ['Packages/_Index/a/b.luau', 'ServerPackages/x.luau', '.studio-sync/tree.json', '.forge/memory/a.luau', 'node_modules/x/y.lua', '.git/HEAD']) {
    assert.ok(!isWatched(path), path)
  }
  assert.ok(isWatched('src/server/Main.server.luau'))
  assert.ok(isWatched('sourcemap.json'))
})

test('studio conflicts poll every 10 s', () => {
  assert.equal(CONFLICTS_POLL_MS, 10_000)
})

test('Rosetta check needs the x64 build translated on macOS', () => {
  assert.ok(isRosetta('darwin', 'x64', true))
  assert.ok(!isRosetta('darwin', 'x64', false))
  assert.ok(!isRosetta('darwin', 'arm64', false))
  assert.ok(!isRosetta('win32', 'x64', true))
  const base = { isPackaged: false, appVersion: '1.0.0', updater: null, screenRecording: null } as unknown as DoctorInputs
  assert.deepEqual(appChecks(base).map((c) => c.id), ['updater'])
  const warned = appChecks({ ...base, rosetta: true })
  assert.equal(warned[0].id, 'rosetta')
  assert.equal(warned[0].status, 'warn')
  assert.match(warned[0].detail, /Rosetta.*mac-arm64/)
})
