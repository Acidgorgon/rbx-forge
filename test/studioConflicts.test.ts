import assert from 'node:assert/strict'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { StudioConflicts } from '../src/main/services/studioConflicts.ts'
import { makeProject, write } from './fixture.ts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

test('lists held Studio versions next to the repo source', async () => {
  const root = makeProject()
  roots.push(root)
  const conflicts = new StudioConflicts(root)
  assert.deepEqual(await conflicts.list(), [])
  write(root, '.studio-sync/conflicts/src__shared__Modules__ModuleLoader.luau', 'studio version\n')
  const list = await conflicts.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].path, 'src/shared/Modules/ModuleLoader.luau')
  assert.equal(list[0].studioSource, 'studio version\n')
  assert.equal(list[0].repoSource, '-- src/shared/Modules/ModuleLoader.luau\nreturn {}\n')
})

test('resolves through studio-sync.py', async () => {
  const root = makeProject()
  roots.push(root)
  const conflicts = new StudioConflicts(root)
  write(root, '.studio-sync/conflicts/src__shared__Modules__ModuleLoader.luau', 'studio version\n')
  write(root, '.studio-sync/conflicts/src__shared__events__client.luau', 'other studio\n')

  await conflicts.resolve('src/shared/Modules/ModuleLoader.luau', 'studio')
  assert.equal(readFileSync(join(root, 'src/shared/Modules/ModuleLoader.luau'), 'utf8'), 'studio version\n')
  const state = JSON.parse(readFileSync(join(root, '.studio-sync/state.json'), 'utf8'))
  assert.ok(state['src/shared/Modules/ModuleLoader.luau'])

  await conflicts.resolve('src/shared/events/client.luau', 'repo')
  assert.equal(readFileSync(join(root, 'src/shared/events/client.luau'), 'utf8'), '-- src/shared/events/client.luau\nreturn {}\n')
  assert.ok(!existsSync(join(root, '.studio-sync/conflicts/src__shared__events__client.luau')))
  assert.deepEqual(await conflicts.list(), [])
  await assert.rejects(conflicts.resolve('src/shared/events/client.luau', 'repo'), /No held Studio version/)
})

test('watch reports new conflicts', async () => {
  const root = makeProject()
  roots.push(root)
  const conflicts = new StudioConflicts(root)
  const seen = new Promise<number>((resolve) => conflicts.watch((list) => resolve(list.length), 100))
  write(root, '.studio-sync/conflicts/src__shared__events__server.luau', 'x\n')
  assert.equal(await seen, 1)
  conflicts.close()
})
