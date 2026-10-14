// Temp GenTree-shaped project for the click-through suite: the template's default.project.json,
// rokit/wally manifests and events.blink (test/fixtures/template), the feature layout test/fixture.ts
// uses, the UI Labs stories + vendored Vide from test/fixtures/ui-preview-project, and a git repo with
// one commit and a bare local "origin" (Source control flows commit and push to it).

import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { write } from '../../fixture.ts'

const FIXTURES = resolve(import.meta.dirname, '..', '..', 'fixtures')

export const INVENTORY_SERVICE = 'src/server/Features/Inventory/InventoryService.luau'
export const STORY = 'src/shared/Interface/Stories/Counter.story.luau'

// The suite's own git calls ignore the caller's git config and GIT_* environment (signing, proxies).
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
}

export function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=e2e@forge.test', '-c', 'user.name=Forge E2E', ...args], { cwd: root, encoding: 'utf8', env: gitEnv() })
}

export function makeAppProject(parent: string): string {
  const root = mkdtempSync(join(parent, 'GenTreeE2E-'))
  const template = join(FIXTURES, 'template')
  for (const f of ['default.project.json', 'rokit.toml', 'wally.toml', 'events.blink']) cpSync(join(template, f), join(root, f))
  write(root, 'tools/studio-sync.json', JSON.stringify({ port: 34873, placeIds: [123], skip: ['Packages'] }))
  const files = [
    'src/shared/Modules/ModuleLoader.luau',
    'src/shared/events/client.luau',
    'src/shared/events/server.luau',
    'src/shared/Interface/MountUI.luau',
    'src/shared/Features/Inventory/init.luau',
    'src/server/Data/PlayerData.luau',
    'src/server/Features/Inventory/init.server.luau',
    INVENTORY_SERVICE,
    'src/client/Client/Controllers/InventoryController/init.luau',
    'src/client/Client/init.client.luau',
    'src/ServerStorage/Assets/Loot.luau'
  ]
  for (const file of files) write(root, file, `-- ${file}\nlocal M = {}\n\nfunction M.start()\n\treturn true\nend\n\nreturn M\n`)
  const ui = join(FIXTURES, 'ui-preview-project')
  cpSync(join(ui, 'src', 'shared', 'Interface'), join(root, 'src', 'shared', 'Interface'), { recursive: true })
  cpSync(join(ui, 'Packages'), join(root, 'Packages'), { recursive: true })
  write(root, '.gitignore', 'Packages/\n*.rbxl\n')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'GenTree fixture')
  // A bare "origin" next to it, so Sync now can commit, fetch and push without a network.
  const origin = `${root}-origin.git`
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: gitEnv() })
  git(root, 'remote', 'add', 'origin', origin)
  git(root, 'push', '-q', '-u', 'origin', 'main')
  return root
}
