import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diskReloadAction, openPathsIn } from '../src/renderer/src/lib/diskReload.ts'

test('disk reload: a clean tab takes the disk text, unsaved edits are kept', () => {
  const clean = { path: 'src/client/Client/init.client.luau', saved: '', current: '' }
  assert.equal(diskReloadAction(clean, 'adawdawdawd\n'), 'reload')
  assert.equal(diskReloadAction(clean, ''), 'none')
  assert.equal(diskReloadAction({ ...clean, current: 'mine' }, 'theirs'), 'keep-edits')
  assert.equal(diskReloadAction({ ...clean, loading: true }, 'x'), 'none')
  assert.equal(diskReloadAction(undefined, 'x'), 'none')
})

test('disk reload: only open, loaded buffers named in the change list', () => {
  const bufs = [
    { path: 'src/client/Client/init.client.luau', saved: '', current: '' },
    { path: 'src/shared/A.luau', saved: '', current: '', loading: true },
    { path: 'src/shared/B.luau', saved: '', current: '' }
  ]
  assert.deepEqual(openPathsIn(bufs, ['src\\client\\Client\\init.client.luau', 'src/shared/A.luau', 'other.luau']), ['src/client/Client/init.client.luau'])
})
