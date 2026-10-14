// Explorer delete helpers: which paths "Delete Feature" moves to the trash (complete and partial
// features, folder and single-file parts) and when a delete still asks after "Don't ask again".
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { featureDeleteTargets, featuresOf } from '../src/renderer/src/lib/roblox.ts'
import { shouldConfirmDelete } from '../src/renderer/src/lib/deleteConfirm.ts'
import type { ScriptEntry } from '../src/shared/types.ts'

const script = (path: string): ScriptEntry => ({ path, name: path.split('/').pop()!, kind: 'ModuleScript' }) as ScriptEntry

test('Delete Feature: all three parts, Controller and Service before the shared folder', () => {
  const [f] = featuresOf([
    script('src/shared/Features/Shop/init.luau'),
    script('src/server/Features/Shop/ShopService.luau'),
    script('src/client/Client/Controllers/ShopController.luau'),
    script('src/shared/Modules/ModuleLoader.luau')
  ])
  assert.deepEqual(featureDeleteTargets(f), [
    { part: 'Controller', path: 'src/client/Client/Controllers/ShopController.luau', isDir: false },
    { part: 'Service', path: 'src/server/Features/Shop', isDir: true },
    { part: 'shared', path: 'src/shared/Features/Shop', isDir: true }
  ])
})

test('Delete Feature: partial features and single-file / folder parts', () => {
  const features = featuresOf([
    // 2/3: no Controller; the shared part is a single file.
    script('src/shared/Features/Inventory.luau'),
    script('src/server/Features/Inventory/InventoryService.lua'),
    // 1/3: only a Controller, as a folder with init.
    script('src/client/Client/Controllers/HudController/init.luau'),
    // 2/3: shared + Controller.
    script('src/shared/Features/Quests/init.lua'),
    script('src/client/Client/Controllers/QuestsController.luau')
  ])
  const by = Object.fromEntries(features.map((f) => [f.name, featureDeleteTargets(f)]))
  assert.deepEqual(by.Inventory, [
    { part: 'Service', path: 'src/server/Features/Inventory', isDir: true },
    { part: 'shared', path: 'src/shared/Features/Inventory.luau', isDir: false }
  ])
  assert.deepEqual(by.Hud, [{ part: 'Controller', path: 'src/client/Client/Controllers/HudController', isDir: true }])
  assert.deepEqual(by.Quests, [
    { part: 'Controller', path: 'src/client/Client/Controllers/QuestsController.luau', isDir: false },
    { part: 'shared', path: 'src/shared/Features/Quests', isDir: true }
  ])
  assert.deepEqual(featureDeleteTargets({ name: 'Empty' }), [])
})

test('delete confirmation: "Don\'t ask again" skips it, unsaved tabs never do', () => {
  assert.equal(shouldConfirmDelete(undefined, 0), true)
  assert.equal(shouldConfirmDelete(true, 0), true)
  assert.equal(shouldConfirmDelete(false, 0), false)
  assert.equal(shouldConfirmDelete(false, 1), true)
})
