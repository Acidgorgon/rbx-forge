import assert from 'node:assert/strict'
import { rmSync, symlinkSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { TreeNode } from '../src/shared/types.ts'
import { Project, fillFromProject, mergeStudioTree, resolveInside, type HarnessTreeNode } from '../src/main/services/project.ts'
import { makeProject, write } from './fixture.ts'

const roots: string[] = []
const opened: Project[] = []
after(() => {
  for (const project of opened) project.close()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

async function open(root: string): Promise<Project> {
  const project = await Project.open(root)
  opened.push(project)
  return project
}

function find(nodes: TreeNode[], path: string[]): HarnessTreeNode | undefined {
  let current: HarnessTreeNode | undefined
  let list = nodes
  for (const name of path) {
    current = list.find((node) => node.name === name)
    if (!current) return undefined
    list = current.children
  }
  return current
}

test('builds the explorer tree the way Rojo maps files', async () => {
  const root = makeProject()
  roots.push(root)
  const project = await open(root)
  assert.equal(project.info.name, 'GenTree')
  assert.deepEqual(project.info.placeIds, [123])

  const tree = project.tree
  assert.deepEqual(
    tree.map((node) => node.name),
    ['ReplicatedStorage', 'ServerScriptService', 'ServerStorage', 'StarterPlayer']
  )
  assert.equal(find(tree, ['ReplicatedStorage'])?.className, 'ReplicatedStorage')
  assert.equal(find(tree, ['ReplicatedStorage', 'Shared'])?.className, 'Folder')

  const inventory = find(tree, ['ReplicatedStorage', 'Shared', 'Features', 'Inventory'])
  assert.equal(inventory?.className, 'ModuleScript')
  assert.equal(inventory?.filePath, 'src/shared/Features/Inventory/init.luau')

  const serverFeature = find(tree, ['ServerScriptService', 'Server', 'Features', 'Inventory'])
  assert.equal(serverFeature?.className, 'Script')
  assert.equal(serverFeature?.filePath, 'src/server/Features/Inventory/init.server.luau')
  assert.equal(serverFeature?.children[0].name, 'InventoryService')
  assert.equal(serverFeature?.children[0].className, 'ModuleScript')

  assert.equal(find(tree, ['StarterPlayer', 'StarterPlayerScripts', 'Client'])?.className, 'Folder')
  const client = find(tree, ['StarterPlayer', 'StarterPlayerScripts', 'Client', 'Client'])
  assert.equal(client?.className, 'LocalScript')
  assert.equal(client?.filePath, 'src/client/Client/init.client.luau')
  assert.equal(find(tree, ['ReplicatedStorage', 'Shared', 'Modules', 'Utils'])?.children.length, 0)
  assert.equal(find(tree, ['ReplicatedStorage', 'Packages'])?.className, 'Folder')
  assert.equal(inventory?.origin, 'repo')
  project.close()
})

test('categorizes scripts for this template', async () => {
  const root = makeProject()
  roots.push(root)
  const project = await open(root)
  const byPath = new Map(project.scripts.flatMap((group) => group.scripts).map((s) => [s.path, s]))
  const expect = (path: string, category: string, realm: string, feature?: string) => {
    const entry = byPath.get(path)
    assert.ok(entry, `missing ${path}`)
    assert.equal(entry.category, category, path)
    assert.equal(entry.realm, realm, path)
    assert.equal(entry.feature, feature, path)
  }
  expect('src/shared/Features/Inventory/init.luau', 'Configs', 'shared', 'Inventory')
  expect('src/server/Data/PlayerData.luau', 'Data', 'server')
  expect('src/server/Features/Inventory/InventoryService.luau', 'Services', 'server', 'Inventory')
  expect('src/server/Features/Inventory/init.server.luau', 'Entry points', 'server', 'Inventory')
  expect('src/client/Client/Controllers/InventoryController/init.luau', 'Controllers', 'client', 'Inventory')
  expect('src/shared/Modules/ModuleLoader.luau', 'Modules', 'shared')
  expect('src/shared/events/client.luau', 'Events', 'shared')
  expect('src/shared/Interface/MountUI.luau', 'UI', 'shared')
  expect('src/shared/Interface/App/app.luau', 'UI', 'shared')
  expect('src/client/Client/init.client.luau', 'Entry points', 'client')
  expect('src/ServerStorage/Assets/Loot.luau', 'Other', 'server')

  assert.deepEqual(
    project.scripts.map((group) => group.category),
    ['Configs', 'Data', 'Services', 'Controllers', 'Modules', 'Events', 'UI', 'Entry points', 'Other']
  )
  const events = project.scripts.find((group) => group.category === 'Events')!
  assert.deepEqual(events.scripts.map((s) => s.path), ['src/shared/events/client.luau', 'src/shared/events/server.luau'])
  const controller = byPath.get('src/client/Client/Controllers/InventoryController/init.luau')!
  assert.deepEqual(controller.instancePath, ['StarterPlayer', 'StarterPlayerScripts', 'Client', 'Client', 'Controllers', 'InventoryController'])
  assert.equal(controller.kind, 'ModuleScript')
  project.close()
})

test('prefers sourcemap.json when present', async () => {
  const root = makeProject()
  roots.push(root)
  write(root, 'sourcemap.json', JSON.stringify({
    name: 'GenTree',
    className: 'DataModel',
    children: [{
      name: 'ReplicatedStorage',
      className: 'ReplicatedStorage',
      children: [{
        name: 'Shared',
        className: 'Folder',
        children: [{ name: 'Thing', className: 'ModuleScript', filePaths: ['src/shared/Thing.luau', 'src/shared/Thing.meta.json'] }]
      }]
    }]
  }))
  // Sourcemap entries whose file is gone are dropped (a stale sourcemap after a delete), so it exists.
  write(root, 'src/shared/Thing.luau', 'return {}\n')
  const project = await open(root)
  assert.equal(find(project.tree, ['ReplicatedStorage', 'Shared', 'Thing'])?.filePath, 'src/shared/Thing.luau')
  // Branches the sourcemap leaves out (Rojo skips folders with no scripts) come from the project file.
  assert.ok(find(project.tree, ['ServerScriptService']))
  assert.ok(project.scripts.some((g) => g.scripts.some((s) => s.path === 'src/shared/Thing.luau')))
  project.close()
})

test('merges the live Studio tree from .studio-sync/tree.json', async () => {
  const root = makeProject()
  roots.push(root)
  write(root, '.studio-sync/tree.json', JSON.stringify({
    placeId: 123,
    at: 1,
    truncated: false,
    roots: [
      { name: 'Workspace', className: 'Workspace', children: [
        { name: 'Baseplate', className: 'Part', props: { Anchored: true, Size: '2048, 16, 2048' } }
      ] },
      { name: 'ReplicatedStorage', className: 'ReplicatedStorage', children: [
        { name: 'Shared', className: 'Folder', children: [
          { name: 'Features', className: 'Folder', children: [
            { name: 'Inventory', className: 'ModuleScript' }
          ] }
        ] },
        { name: 'Assets', className: 'Folder', children: [{ name: 'Sword Model', className: 'Model' }] }
      ] }
    ]
  }))
  const project = await open(root)
  const tree = project.tree
  assert.equal(find(tree, ['Workspace'])?.origin, 'studio')
  const baseplate = find(tree, ['Workspace', 'Baseplate'])
  assert.equal(baseplate?.origin, 'studio')
  assert.deepEqual(baseplate?.props, { Anchored: 'true', Size: '2048, 16, 2048' })
  assert.equal(find(tree, ['ReplicatedStorage'])?.origin, 'both')
  const inventory = find(tree, ['ReplicatedStorage', 'Shared', 'Features', 'Inventory'])
  assert.equal(inventory?.origin, 'both')
  assert.equal(inventory?.filePath, 'src/shared/Features/Inventory/init.luau')
  assert.equal(find(tree, ['ReplicatedStorage', 'Assets', 'Sword Model'])?.origin, 'studio')
  assert.equal(find(tree, ['ReplicatedStorage', 'Shared', 'Modules'])?.origin, 'repo')
  assert.equal(find(tree, ['ServerScriptService'])?.origin, 'repo')
  // Studio-only nodes never show up as scripts to edit.
  assert.ok(!project.scripts.flatMap((g) => g.scripts).some((s) => s.instancePath[0] === 'Workspace'))
  project.close()
})

test('pairs same-named siblings in order', () => {
  const repo: TreeNode[] = [{ name: 'A', className: 'Folder', children: [] }]
  const merged = mergeStudioTree(repo, [
    { name: 'A', className: 'Folder' },
    { name: 'A', className: 'Folder' }
  ])
  assert.deepEqual(merged.map((node) => node.origin), ['both', 'studio'])
})

test('emits tree changes when tree.json changes', async () => {
  const root = makeProject()
  roots.push(root)
  const project = await open(root)
  const changed = new Promise<boolean>((resolve) => project.watch((change) => resolve(change.tree)))
  await new Promise((r) => setTimeout(r, 50))
  write(root, '.studio-sync/tree.json', JSON.stringify({ roots: [{ name: 'Lighting', className: 'Lighting' }] }))
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4000).unref())
  assert.equal(await Promise.race([changed, timeout]), true)
  assert.equal(find(project.tree, ['Lighting'])?.origin, 'studio')
  project.close()
})

test('emits tree and script changes when a feature is added', async () => {
  const root = makeProject()
  roots.push(root)
  const project = await open(root)
  const changed = new Promise<boolean>((resolve) => project.watch((change) => resolve(change.scripts)))
  await new Promise((r) => setTimeout(r, 50))
  write(root, 'src/shared/Features/Shop/init.luau', 'return {}\n')
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4000).unref())
  assert.equal(await Promise.race([changed, timeout]), true)
  assert.ok(project.scripts.some((g) => g.scripts.some((s) => s.feature === 'Shop')))
  project.close()
})

test('refuses paths that leave the project root', async () => {
  const root = makeProject()
  roots.push(root)
  const project = await open(root)
  await assert.rejects(project.readFile('../outside.txt'), /outside the project/)
  await assert.rejects(project.readFile('/etc/passwd'), /outside the project/)
  await assert.rejects(project.writeFile('src/../../escape.luau', 'x'), /outside the project/)
  await assert.rejects(project.listFiles('..'), /outside the project/)
  const outside = mkdtempSync(join(tmpdir(), 'harness-outside-'))
  roots.push(outside)
  symlinkSync(outside, join(root, 'link'))
  await assert.rejects(project.writeFile('link/evil.luau', 'x'), /outside the project/)

  await project.writeFile('src/shared/New.luau', 'return 1\n')
  assert.equal(await project.readFile('src/shared/New.luau'), 'return 1\n')
  assert.equal(await resolveInside(root, '..file'), join(root, '..file'))
  const files = await project.listFiles('src/server')
  assert.ok(files.includes('src/server/Features/Inventory/InventoryService.luau'))
  project.close()
})

test('fillFromProject: branches the sourcemap left out (no scripts yet) come from the project file', () => {
  const leaf = (name: string, className = 'Folder') => ({ name, className, children: [] as never[] })
  const sourcemap = [{ name: 'ReplicatedStorage', className: 'ReplicatedStorage', children: [{ name: 'Shared', className: 'Folder', filePath: 'src/shared/init.luau', children: [] }] }]
  const project = [
    { name: 'ReplicatedStorage', className: 'ReplicatedStorage', children: [leaf('Shared'), leaf('Packages')] },
    { name: 'ServerScriptService', className: 'ServerScriptService', children: [{ name: 'Server', className: 'Folder', children: [leaf('Data'), leaf('Features')] }] }
  ]
  const tree = fillFromProject(sourcemap, project)
  assert.deepEqual(tree.map((n) => n.name), ['ReplicatedStorage', 'ServerScriptService'])
  assert.equal(tree[0].children.find((n) => n.name === 'Shared')?.filePath, 'src/shared/init.luau', 'the sourcemap node wins')
  assert.deepEqual(tree[0].children.map((n) => n.name).sort(), ['Packages', 'Shared'])
  assert.deepEqual(tree[1].children[0].children.map((n) => n.name), ['Data', 'Features'])
})
