import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// Copies of the GenTree template's (github.com/Acidgorgon/MyTemplate-Legacy) default.project.json and
// tools/studio-sync.py, vendored so the tests run from a clone of rbx-forge alone.
const TEMPLATE = resolve(import.meta.dirname, 'fixtures', 'template')

export function write(root: string, path: string, contents = ''): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), contents)
}

// A temp project shaped like the template's src layout, plus an Inventory feature.
export function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-project-'))
  cpSync(join(TEMPLATE, 'default.project.json'), join(root, 'default.project.json'))
  write(root, 'tools/studio-sync.json', JSON.stringify({ port: 34873, placeIds: [123], skip: ['Packages'] }))
  cpSync(join(TEMPLATE, 'tools', 'studio-sync.py'), join(root, 'tools', 'studio-sync.py'))
  const files = [
    'src/shared/Modules/ModuleLoader.luau',
    'src/shared/Modules/Utils/.gitkeep',
    'src/shared/events/client.luau',
    'src/shared/events/server.luau',
    'src/shared/Interface/MountUI.luau',
    'src/shared/Interface/App/app.luau',
    'src/shared/Features/.gitkeep',
    'src/shared/Features/Inventory/init.luau',
    'src/server/Handlers/.gitkeep',
    'src/server/Data/.gitkeep',
    'src/server/Data/PlayerData.luau',
    'src/server/Features/.gitkeep',
    'src/server/Features/Inventory/init.server.luau',
    'src/server/Features/Inventory/InventoryService.luau',
    'src/client/Client/Controllers/.gitkeep',
    'src/client/Client/Controllers/InventoryController/init.luau',
    'src/client/Client/init.client.luau',
    'src/ServerStorage/Assets/Loot.luau'
  ]
  for (const file of files) write(root, file, file.endsWith('.gitkeep') ? '' : `-- ${file}\nreturn {}\n`)
  return root
}
