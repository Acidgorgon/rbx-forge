import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { buildSourcemap, SourcemapWatcher, writeSourcemap, type SourcemapNode } from '../src/main/services/sync/sourcemap.ts'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function put(root: string, rel: string, text: string): void {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, text, 'utf8')
}

function findChild(node: SourcemapNode | undefined, ...path: string[]): SourcemapNode | undefined {
  let cur = node
  for (const name of path) {
    cur = cur?.children?.find((c) => c.name === name)
    if (!cur) return undefined
  }
  return cur
}

test('buildSourcemap: resolves services, scripts, init.* promotion, meta, models, json, txt, and Packages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-sm-'))
  dirs.push(root)

  put(
    root,
    'default.project.json',
    JSON.stringify({
      name: 'TestGame',
      tree: {
        $className: 'DataModel',
        ReplicatedStorage: {
          Shared: { $path: 'src/shared' },
          Packages: { $path: 'Packages' }
        },
        ServerScriptService: {
          Server: { $path: 'src/server' }
        },
        StarterPlayer: {
          StarterPlayerScripts: {
            Client: { $path: 'src/client' }
          }
        }
      }
    })
  )

  put(root, 'src/shared/Utils/Math.luau', 'return {}')
  put(root, 'src/shared/Config/init.meta.json', JSON.stringify({ className: 'Configuration' }))
  put(root, 'src/shared/Config/Values.json', '{"speed":16}')
  put(root, 'src/shared/Config/Notes.txt', 'hello')
  put(root, 'src/shared/Props/Crate.model.json', JSON.stringify({ ClassName: 'Model', Children: [{ Name: 'Body', ClassName: 'Part' }] }))
  put(root, 'src/server/Game/init.server.luau', 'print("hi")')
  put(root, 'src/server/Game/Helper.luau', 'return {}')
  put(root, 'src/client/Hud/init.client.luau', 'print("hud")')
  put(root, 'Packages/Current.luau', 'return require(script.Parent._Index.current)')
  put(
    root,
    'Packages/_Index/acidgorgon_current@0.1.2/current/default.project.json',
    JSON.stringify({ name: 'current', tree: { $path: 'src' } })
  )
  put(root, 'Packages/_Index/acidgorgon_current@0.1.2/current/src/init.luau', 'return {}')

  const { tree, nodeCount } = await buildSourcemap(root, 'default.project.json')
  assert.equal(tree.name, 'TestGame')
  assert.equal(tree.className, 'DataModel')
  assert.ok(nodeCount >= 12)

  assert.deepEqual(findChild(tree, 'ReplicatedStorage', 'Shared', 'Utils', 'Math'), {
    name: 'Math',
    className: 'ModuleScript',
    filePaths: ['src/shared/Utils/Math.luau']
  })
  assert.equal(findChild(tree, 'ReplicatedStorage', 'Shared', 'Config')?.className, 'Configuration')
  assert.equal(findChild(tree, 'ReplicatedStorage', 'Shared', 'Config', 'Values')?.className, 'ModuleScript')
  assert.equal(findChild(tree, 'ReplicatedStorage', 'Shared', 'Config', 'Notes')?.className, 'StringValue')
  assert.equal(findChild(tree, 'ReplicatedStorage', 'Shared', 'Props', 'Crate')?.className, 'Model')
  assert.equal(findChild(tree, 'ReplicatedStorage', 'Shared', 'Props', 'Crate', 'Body')?.className, 'Part')

  const gameNode = findChild(tree, 'ServerScriptService', 'Server', 'Game')
  assert.equal(gameNode?.className, 'Script')
  assert.deepEqual(gameNode?.filePaths, ['src/server/Game/init.server.luau'])
  assert.equal(findChild(gameNode, 'Helper')?.className, 'ModuleScript')

  const hudNode = findChild(tree, 'StarterPlayer', 'StarterPlayerScripts', 'Client', 'Hud')
  assert.equal(hudNode?.className, 'LocalScript')
  assert.deepEqual(hudNode?.filePaths, ['src/client/Hud/init.client.luau'])

  assert.equal(findChild(tree, 'ReplicatedStorage', 'Packages', 'Current')?.className, 'ModuleScript')
  const pkgSub = findChild(tree, 'ReplicatedStorage', 'Packages', '_Index', 'acidgorgon_current@0.1.2', 'current')
  assert.equal(pkgSub?.className, 'ModuleScript')
})

test('writeSourcemap writes atomically with no temp files left behind; SourcemapWatcher rebuilds on change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-smw-'))
  dirs.push(root)

  put(
    root,
    'default.project.json',
    JSON.stringify({
      name: 'WatchGame',
      tree: {
        $className: 'DataModel',
        ReplicatedStorage: { Shared: { $path: 'src/shared' } }
      }
    })
  )
  put(root, 'src/shared/A.luau', 'return 1')

  const stats = await writeSourcemap(root, 'default.project.json')
  assert.equal(stats.path, 'sourcemap.json')
  assert.ok(existsSync(join(root, 'sourcemap.json')))
  assert.ok(!readdirSync(root).some((f) => f.endsWith('.forge-tmp')))
  const written = JSON.parse(readFileSync(join(root, 'sourcemap.json'), 'utf8')) as SourcemapNode
  assert.ok(findChild(written, 'ReplicatedStorage', 'Shared', 'A'))

  let builtCount = 0
  const watcher = new SourcemapWatcher({
    root,
    debounceMs: 50,
    onBuilt: () => {
      builtCount++
    }
  })
  try {
    await watcher.start()
    const before = builtCount
    put(root, 'src/shared/B.luau', 'return 2')
    const end = Date.now() + 3000
    while (builtCount === before && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 30))
    }
    const updated = JSON.parse(readFileSync(join(root, 'sourcemap.json'), 'utf8')) as SourcemapNode
    assert.ok(findChild(updated, 'ReplicatedStorage', 'Shared', 'B'))
  } finally {
    watcher.close()
  }
})
