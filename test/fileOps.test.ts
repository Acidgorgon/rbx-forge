import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { entryTarget, movedPath, protectedReason, renamedPath, renameProblem, siblingsOf, validateFileName } from '../src/shared/fileOps.ts'
import { renameEntry, trashEntry } from '../src/main/services/fileOps.ts'
import { Project, pruneMissing } from '../src/main/services/project.ts'
import { makeProject, write } from './fixture.ts'

const roots: string[] = []
const opened: Project[] = []
after(() => {
  for (const project of opened) project.close()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const MOUNTS = ['src/shared', 'Packages', 'src/server', 'src/ServerStorage', 'src/client']

test('validateFileName: Windows-invalid names', () => {
  assert.equal(validateFileName('Foo'), null)
  assert.equal(validateFileName('Foo.spec'), null)
  for (const bad of ['', ' ', 'a<b', 'a>b', 'a:b', 'a"b', 'a/b', 'a\\b', 'a|b', 'a?b', 'a*b', 'a\u0001b', 'Foo.', 'Foo ', '.', '..', ' Foo']) {
    assert.notEqual(validateFileName(bad), null, JSON.stringify(bad))
  }
  for (const reserved of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'nul.luau', 'Con.server.luau']) {
    assert.match(validateFileName(reserved) ?? '', /reserved/, reserved)
  }
  assert.equal(validateFileName('Console'), null)
  assert.equal(validateFileName('COM10'), null)
  assert.equal(validateFileName('x'.repeat(256)), 'That name is too long.')
})

test('entryTarget / renamedPath keep the Rojo suffix; init scripts act on their folder', () => {
  assert.deepEqual(entryTarget('src/server/Foo.server.luau'), { path: 'src/server/Foo.server.luau', isDir: false, stem: 'Foo', suffix: '.server.luau' })
  assert.deepEqual(entryTarget('src/client/Bar.client.lua'), { path: 'src/client/Bar.client.lua', isDir: false, stem: 'Bar', suffix: '.client.lua' })
  assert.deepEqual(entryTarget('src/shared/Util.luau'), { path: 'src/shared/Util.luau', isDir: false, stem: 'Util', suffix: '.luau' })
  assert.deepEqual(entryTarget('src/shared/Util.spec.luau').stem, 'Util.spec')
  assert.deepEqual(entryTarget('src/server/Features/Inventory/init.server.luau'), { path: 'src/server/Features/Inventory', isDir: true, stem: 'Inventory', suffix: '' })
  assert.deepEqual(entryTarget('src/shared/Thing/init.luau').path, 'src/shared/Thing')
  assert.deepEqual(entryTarget('src/shared/Modules/', true), { path: 'src/shared/Modules', isDir: true, stem: 'Modules', suffix: '' })
  assert.deepEqual(entryTarget('events.blink'), { path: 'events.blink', isDir: false, stem: 'events.blink', suffix: '' })
  assert.equal(renamedPath(entryTarget('src/server/Foo.server.luau'), 'Baz'), 'src/server/Baz.server.luau')
  assert.equal(renamedPath(entryTarget('src/server/Features/Inventory/init.server.luau'), 'Bag'), 'src/server/Features/Bag')
  assert.equal(renamedPath(entryTarget('events.blink'), 'net.blink'), 'net.blink')
})

test('renameProblem: collisions by instance name, ignoring case', () => {
  const siblings = [
    { name: 'Foo.server.luau', isDir: false },
    { name: 'Bar.luau', isDir: false },
    { name: 'Gear', isDir: true },
    { name: 'notes.txt', isDir: false }
  ]
  const foo = entryTarget('src/server/Foo.server.luau')
  assert.equal(renameProblem(foo, 'Foo', siblings), 'Pick a new name.')
  assert.equal(renameProblem(foo, 'Baz', siblings), null)
  assert.match(renameProblem(foo, 'bar', siblings) ?? '', /already exists/)
  assert.match(renameProblem(foo, 'GEAR', siblings) ?? '', /already exists/)
  assert.match(renameProblem(foo, 'CON', siblings) ?? '', /reserved/)
  assert.match(renameProblem(foo, 'a:b', siblings) ?? '', /:/)
  assert.match(renameProblem(entryTarget('src/shared/A.luau'), 'B.client', siblings) ?? '', /script type/)
  assert.match(renameProblem(entryTarget('src/shared/A.luau'), 'B.server', siblings) ?? '', /script type/)
  assert.match(renameProblem(entryTarget('src/shared/A.luau'), 'init', siblings) ?? '', /init/)
  assert.match(renameProblem(foo, 'Baz.', siblings) ?? '', /dot/)
  // A case-only rename of itself is fine.
  assert.equal(renameProblem(foo, 'foo', siblings), null)
  const gear = entryTarget('src/server/Gear', true)
  assert.match(renameProblem(gear, 'Bar', siblings) ?? '', /already exists/)
  assert.equal(renameProblem(gear, 'Gears', siblings), null)
})

test('protectedReason: project root, project files, .git and $path mounts plus their parents', () => {
  assert.notEqual(protectedReason('', MOUNTS), null)
  assert.notEqual(protectedReason('.', MOUNTS), null)
  assert.notEqual(protectedReason('../x', MOUNTS), null)
  assert.notEqual(protectedReason('default.project.json', MOUNTS), null)
  assert.notEqual(protectedReason('.git/config', MOUNTS), null)
  assert.match(protectedReason('src/shared', MOUNTS) ?? '', /mapped in the project file/)
  assert.match(protectedReason('src/shared/', MOUNTS) ?? '', /mapped in the project file/)
  assert.match(protectedReason('src', MOUNTS) ?? '', /holds/)
  assert.equal(protectedReason('src/shared/Modules', MOUNTS), null)
  assert.equal(protectedReason('src/server/Foo.server.luau', MOUNTS), null)
  assert.equal(protectedReason('events.blink', MOUNTS), null)
  // "src/sharedThing" is not inside "src/shared".
  assert.equal(protectedReason('src/sh', ['src/shared']), null)
})

test('movedPath / siblingsOf', () => {
  assert.equal(movedPath('src/a/B.luau', 'src/a', 'src/c'), 'src/c/B.luau')
  assert.equal(movedPath('src/a', 'src/a', 'src/c'), 'src/c')
  assert.equal(movedPath('src/ab/B.luau', 'src/a', 'src/c'), null)
  assert.deepEqual(siblingsOf('src/server', ['src/server/A.luau', 'src/server/Gear/init.luau', 'src/shared/X.luau']), [
    { name: 'A.luau', isDir: false },
    { name: 'Gear', isDir: true }
  ])
})

test('renameEntry: keeps the suffix, renames init folders, refuses collisions, mounts and escapes', async () => {
  const root = makeProject()
  roots.push(root)
  write(root, 'src/server/Foo.server.luau', 'print(1)\n')
  write(root, 'src/server/Gear.luau', 'return {}\n')
  const r = await renameEntry(root, MOUNTS, 'src/server/Foo.server.luau', 'Boot')
  assert.deepEqual(r, { from: 'src/server/Foo.server.luau', to: 'src/server/Boot.server.luau', isDir: false })
  assert.ok(existsSync(join(root, 'src/server/Boot.server.luau')))
  assert.ok(!existsSync(join(root, 'src/server/Foo.server.luau')))

  const folder = await renameEntry(root, MOUNTS, 'src/server/Features/Inventory/init.server.luau', 'Bag')
  assert.deepEqual(folder, { from: 'src/server/Features/Inventory', to: 'src/server/Features/Bag', isDir: true })
  assert.ok(existsSync(join(root, 'src/server/Features/Bag/InventoryService.luau')))

  await assert.rejects(renameEntry(root, MOUNTS, 'src/server/Boot.server.luau', 'gear'), /already exists/)
  await assert.rejects(renameEntry(root, MOUNTS, 'src/server/Boot.server.luau', 'AUX'), /reserved/)
  await assert.rejects(renameEntry(root, MOUNTS, 'src/server/Boot.server.luau', 'a/b'), /cannot contain/)
  await assert.rejects(renameEntry(root, MOUNTS, 'src/server/Boot.server.luau', 'Bad.'), /dot/)
  await assert.rejects(renameEntry(root, MOUNTS, 'src/shared', 'Common', true), /mapped in the project file/)
  await assert.rejects(renameEntry(root, MOUNTS, 'src', 'source', true), /holds/)
  await assert.rejects(renameEntry(root, MOUNTS, '../outside.luau', 'x'), /project folder|outside/)
  await assert.rejects(renameEntry(root, MOUNTS, 'src/server/Missing.luau', 'X'), /no longer exists/)
})

test('trashEntry: hands the full path to the trash, folders for init scripts, refuses mounts', async () => {
  const root = makeProject()
  roots.push(root)
  const trashed: string[] = []
  const trash = async (full: string) => {
    trashed.push(full)
    rmSync(full, { recursive: true, force: true })
  }
  const r = await trashEntry(root, MOUNTS, 'src/server/Data/PlayerData.luau', trash)
  assert.deepEqual(r, { from: 'src/server/Data/PlayerData.luau', to: null, isDir: false })
  assert.deepEqual(trashed, [join(root, 'src/server/Data/PlayerData.luau')])
  const folder = await trashEntry(root, MOUNTS, 'src/client/Client/Controllers/InventoryController/init.luau', trash)
  assert.deepEqual(folder, { from: 'src/client/Client/Controllers/InventoryController', to: null, isDir: true })
  assert.ok(!existsSync(join(root, 'src/client/Client/Controllers/InventoryController')))
  await assert.rejects(trashEntry(root, MOUNTS, 'src/server', trash, true), /mapped/)
  await assert.rejects(trashEntry(root, MOUNTS, 'default.project.json', trash), /Project files/)
  await assert.rejects(trashEntry(root, MOUNTS, '', trash, true), /project folder/)
  assert.equal(trashed.length, 2)
})

test('trashEntry refuses a symlink that leads outside the project', { skip: process.platform === 'win32' }, async () => {
  const root = makeProject()
  const outside = mkdtempSync(join(tmpdir(), 'harness-outside-'))
  roots.push(root, outside)
  write(outside, 'Secret.luau', 'return 1\n')
  symlinkSync(outside, join(root, 'src/shared/Linked'))
  await assert.rejects(trashEntry(root, MOUNTS, 'src/shared/Linked/Secret.luau', async () => assert.fail('trashed')), /outside/)
})

test('Project: mounts in the info; a stale sourcemap drops deleted / renamed scripts', async () => {
  const root = makeProject()
  roots.push(root)
  // A sourcemap from before the delete: it still lists PlayerData and the Inventory feature folder.
  write(
    root,
    'sourcemap.json',
    JSON.stringify({
      name: 'GenTree',
      className: 'DataModel',
      children: [
        {
          name: 'ServerScriptService',
          className: 'ServerScriptService',
          children: [
            {
              name: 'Server',
              className: 'Folder',
              children: [
                { name: 'Data', className: 'Folder', children: [{ name: 'PlayerData', className: 'ModuleScript', filePaths: ['src/server/Data/PlayerData.luau'] }] },
                { name: 'Features', className: 'Folder', children: [{ name: 'Inventory', className: 'Script', filePaths: ['src/server/Features/Inventory/init.server.luau'], children: [{ name: 'InventoryService', className: 'ModuleScript', filePaths: ['src/server/Features/Inventory/InventoryService.luau'] }] }] }
              ]
            }
          ]
        }
      ]
    })
  )
  const project = await Project.open(root)
  opened.push(project)
  assert.ok(project.info.mounts?.includes('src/shared'))
  assert.ok(project.info.mounts?.includes('src/server'))
  await trashEntry(root, project.info.mounts ?? [], 'src/server/Data/PlayerData.luau', async (full) => rmSync(full))
  await renameEntry(root, project.info.mounts ?? [], 'src/server/Features/Inventory/init.server.luau', 'Bag')
  await project.refresh()
  const server = project.tree.find((n) => n.name === 'ServerScriptService')?.children.find((n) => n.name === 'Server')
  const data = server?.children.find((n) => n.name === 'Data')
  assert.ok(data, 'the Data folder stays (it still exists on disk)')
  assert.ok(!data!.children.some((n) => n.name === 'PlayerData'))
  const features = server?.children.find((n) => n.name === 'Features')
  assert.ok(!features?.children.some((n) => n.name === 'Inventory'))
  assert.equal(features?.children.find((n) => n.name === 'Bag')?.filePath, 'src/server/Features/Bag/init.server.luau')
})

test('pruneMissing keeps nodes without files and drops emptied folders', async () => {
  const root = makeProject()
  roots.push(root)
  const tree = await pruneMissing(root, [
    { name: 'Gone', className: 'Folder', children: [{ name: 'X', className: 'ModuleScript', filePath: 'src/nope/X.luau', children: [] }] },
    { name: 'Empty', className: 'Folder', children: [] },
    { name: 'Kept', className: 'ModuleScript', filePath: 'src/server/Data/PlayerData.luau', children: [] }
  ])
  assert.deepEqual(tree.map((n) => n.name), ['Empty', 'Kept'])
})
