import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirForInstance, resolveCreateTarget } from '../src/renderer/src/lib/templates.ts'
import type { TreeNode } from '../src/shared/types.ts'

const node = (name: string, className: string, children: TreeNode[] = [], filePath?: string, origin: TreeNode['origin'] = 'repo'): TreeNode => ({
  name,
  className,
  ...(filePath ? { filePath } : {}),
  origin,
  children
})

const footballManagerTree: TreeNode[] = [
  node('ReplicatedStorage', 'ReplicatedStorage', [
    node('Packages', 'Folder', [node('Current', 'ModuleScript', [], 'Packages/Current.luau')]),
    node('Shared', 'Folder', [
      node('Modules', 'Folder', [node('ModuleLoader', 'ModuleScript', [], 'src/shared/Modules/ModuleLoader.luau')])
    ]),
    node('Assets', 'Folder', [], undefined, 'studio')
  ]),
  node('ServerScriptService', 'ServerScriptService', [
    node('Server', 'Folder', [
      node('Data', 'Folder', [node('Data', 'Script', [], 'src/server/Data/Data.server.luau')])
    ])
  ]),
  node('ServerStorage', 'ServerStorage', [
    node('EnvKit', 'Folder', [node('Helper', 'ModuleScript', [], 'src/ServerStorage/EnvKit/Helper.luau')])
  ]),
  node('StarterPlayer', 'StarterPlayer', [
    node('StarterPlayerScripts', 'StarterPlayerScripts', [
      node('Client', 'Folder', [
        node(
          'Client',
          'LocalScript',
          [node('Controllers', 'Folder', [node('MatchController', 'ModuleScript', [], 'src/client/Client/Controllers/MatchController/init.luau')])],
          'src/client/Client/init.client.luau'
        )
      ])
    ])
  ])
]

test('dirForInstance never climbs above mapped roots into unmapped src or service roots', () => {
  assert.equal(dirForInstance(footballManagerTree, ['ReplicatedStorage']), null)
  assert.equal(dirForInstance(footballManagerTree, ['ServerScriptService']), null)
  assert.equal(dirForInstance(footballManagerTree, ['StarterPlayer']), null)
  assert.equal(dirForInstance(footballManagerTree, ['StarterPlayer', 'StarterPlayerScripts']), null)

  assert.equal(dirForInstance(footballManagerTree, ['ReplicatedStorage', 'Shared']), 'src/shared')
  assert.equal(dirForInstance(footballManagerTree, ['ServerScriptService', 'Server']), 'src/server')
  assert.equal(dirForInstance(footballManagerTree, ['ServerStorage']), 'src/ServerStorage')
  assert.equal(dirForInstance(footballManagerTree, ['StarterPlayer', 'StarterPlayerScripts', 'Client']), 'src/client')
  assert.equal(dirForInstance(footballManagerTree, ['StarterPlayer', 'StarterPlayerScripts', 'Client', 'Client']), 'src/client/Client')
})

test('resolveCreateTarget redirects unmapped services to their mapped Rojo root folder', () => {
  assert.deepEqual(resolveCreateTarget(footballManagerTree, ['StarterPlayer', 'StarterPlayerScripts']), {
    instancePath: ['StarterPlayer', 'StarterPlayerScripts', 'Client'],
    dir: 'src/client'
  })
  assert.deepEqual(resolveCreateTarget(footballManagerTree, ['StarterPlayer']), {
    instancePath: ['StarterPlayer', 'StarterPlayerScripts', 'Client'],
    dir: 'src/client'
  })
  assert.deepEqual(resolveCreateTarget(footballManagerTree, ['ServerScriptService']), {
    instancePath: ['ServerScriptService', 'Server'],
    dir: 'src/server'
  })
  assert.deepEqual(resolveCreateTarget(footballManagerTree, ['ReplicatedStorage']), {
    instancePath: ['ReplicatedStorage', 'Shared'],
    dir: 'src/shared'
  })
  assert.deepEqual(resolveCreateTarget(footballManagerTree, ['ServerStorage']), {
    instancePath: ['ServerStorage'],
    dir: 'src/ServerStorage'
  })
  assert.equal(resolveCreateTarget(footballManagerTree, ['ReplicatedStorage', 'Assets']), null)
})
