import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { after, test } from 'node:test'
import { cleanRel, fromDisk, fsProbe, isSkipped, loadPlaces, parseFileName, placeFor, scriptForm, toDisk, unsafeName, type PlaceMap } from '../src/main/services/sync/mapping.ts'
import { diff3, matchLines, normalise, toFileText } from '../src/main/services/sync/merge.ts'
import { canonicalModel, canonicalValue, detectStyle, modelFromStudio, readModel, writeMeta, writeModel } from '../src/main/services/sync/modelJson.ts'
import { MATCH_PLACE, MENU_PLACE, MENU_PLACE_2, makeFsfProject, put } from './syncFixture.ts'

const roots: string[] = []
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

async function fixture(): Promise<{ root: string; match: PlaceMap; menu: PlaceMap; maps: PlaceMap[] }> {
  const root = makeFsfProject()
  roots.push(root)
  const maps = await loadPlaces(root)
  return { root, maps, match: maps.find((m) => m.projectFile === 'default.project.json')!, menu: maps.find((m) => m.projectFile === 'menu.project.json')! }
}

const RS = 'ReplicatedStorage'
const SSS = 'ServerScriptService'

// ---- mapping ----

test('loadPlaces reads every project file with nested and file-mapped $path roots', async () => {
  const { maps, match, menu } = await fixture()
  assert.deepEqual(maps.map((m) => m.projectFile), ['default.project.json', 'menu.project.json'])
  assert.deepEqual(match.placeIds, [MATCH_PLACE])
  assert.deepEqual(menu.placeIds.sort(), [MENU_PLACE, MENU_PLACE_2])
  assert.equal(menu.servePort, 34875)
  const byPath = Object.fromEntries(match.roots.map((r) => [r.instance.join('.'), r]))
  assert.equal(byPath[`${RS}.Shared`].path, 'src/shared')
  assert.equal(byPath[`${RS}.Shared`].ignoreUnknown, true)
  assert.equal(byPath[`${RS}.Shared.Skills`].path, 'src/skills/Definitions')
  assert.equal(byPath[`${RS}.Shared.Skills`].ignoreUnknown, false)
  assert.equal(byPath[`${RS}.Shared.Skills.MatchController`].path, 'src/skills/Client')
  assert.equal(byPath[`${SSS}.Server.Bootstrapper`].isFile, true)
  assert.equal(byPath[`${SSS}.Server.Features.Skills`].path, 'src/skills/Server')
  // Packages (wally) and the studio-sync skip list are never mapped.
  assert.deepEqual(match.skipped.map((s) => s.path).sort(), ['Packages', 'src/ServerStorage'])
  assert.ok(!match.roots.some((r) => r.path.startsWith('Packages')))
  assert.ok(match.virtual.some((v) => v.join('.') === `${SSS}.Server`))
  assert.ok(menu.roots.some((r) => r.path === 'src/server/Config/Admins.luau' && r.isFile))
  assert.ok(menu.virtual.some((v) => v.join('.') === `${SSS}.Server.Features.Skills`))
})

test('placeFor matches servePlaceIds and falls back to default.project.json', async () => {
  const { maps } = await fixture()
  assert.equal(placeFor(maps, MENU_PLACE_2)?.projectFile, 'menu.project.json')
  assert.equal(placeFor(maps, MATCH_PLACE)?.projectFile, 'default.project.json')
  assert.equal(placeFor(maps, 0)?.projectFile, 'default.project.json')
  assert.equal(placeFor(maps, 999)?.projectFile, 'default.project.json')
  assert.equal(placeFor([], 1), null)
})

test('.forge/project.json sync.skip globs and unsafe $path values are skipped', async () => {
  const root = makeFsfProject()
  roots.push(root)
  put(root, '.forge/project.json', JSON.stringify({ sync: { skip: ['src/client/**'] } }))
  put(root, 'evil.project.json', JSON.stringify({ name: 'Evil', tree: { $className: 'DataModel', A: { $path: '../outside' }, B: { $path: '/etc' }, C: { $path: 'src/../..' } } }))
  const maps = await loadPlaces(root)
  const match = maps.find((m) => m.projectFile === 'default.project.json')!
  assert.ok(match.skipped.some((s) => s.path === 'src/client'))
  const evil = maps.find((m) => m.projectFile === 'evil.project.json')!
  assert.deepEqual(evil.roots, [])
  assert.equal(evil.skipped.length, 3)
  assert.equal(isSkipped(['src/client/**'], 'src/client/x.luau'), true)
  assert.equal(isSkipped(['src/ServerStorage'], 'src/ServerStorage/Loot.luau'), true)
  assert.equal(isSkipped([], 'src/shared/Packages/x.luau'), true)
  assert.equal(isSkipped(['src/*/Temp'], 'src/shared/Temp/a.luau'), true)
  assert.equal(isSkipped(['src/*/Temp'], 'src/shared/Other/a.luau'), false)
})

test('unsafeName refuses names that cannot round-trip through a file name', () => {
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'C:x', 'name ', ' name', 'dot.', 'CON', 'nul.txt', 'init', 'init.server', 'Foo.server', 'Bar.client', 'X.model', 'a*b', 'a\u0001b', 'x'.repeat(201)]) {
    assert.ok(unsafeName(bad), `expected ${JSON.stringify(bad)} to be refused`)
  }
  for (const ok of ['Dash', 'New Move', 'Config.v2', 'Ñandú', 'a-b_c', 'Initial']) assert.equal(unsafeName(ok), null, ok)
  assert.equal(cleanRel('./src/x'), 'src/x')
  assert.equal(cleanRel('../x'), null)
  assert.equal(cleanRel('src/../x'), null)
  assert.equal(cleanRel('C:/x'), null)
})

test('script suffixes follow Rojo 7.7 (emitLegacyScripts on and off)', () => {
  assert.deepEqual(scriptForm('ModuleScript', undefined), { suffix: '' })
  assert.deepEqual(scriptForm('Script', undefined), { suffix: '.server' })
  assert.deepEqual(scriptForm('LocalScript', undefined), { suffix: '.client' })
  assert.deepEqual(scriptForm('Script', 'Plugin'), { suffix: '.plugin' })
  assert.deepEqual(scriptForm('Script', 'Client'), { suffix: '.server', meta: 'Client' })
  assert.deepEqual(scriptForm('Script', 'Server'), { suffix: '.server', meta: 'Server' })
  assert.deepEqual(scriptForm('Script', 'Client', false), { suffix: '.client' })
  assert.deepEqual(scriptForm('Script', undefined, false), { suffix: '.server', meta: 'Legacy' })
  assert.equal(scriptForm('Part', undefined), null)
  assert.deepEqual(parseFileName('init.server.luau'), { stem: null, kind: 'script', className: 'Script' })
  assert.deepEqual(parseFileName('X.client.lua'), { stem: 'X', kind: 'script', className: 'LocalScript' })
  assert.deepEqual(parseFileName('X.client.lua', false), { stem: 'X', kind: 'script', className: 'Script' })
  assert.deepEqual(parseFileName('X.plugin.luau'), { stem: 'X', kind: 'script', className: 'Script', plugin: true })
  assert.deepEqual(parseFileName('Animations.model.json'), { stem: 'Animations', kind: 'model' })
  assert.deepEqual(parseFileName('init.meta.json'), { stem: null, kind: 'meta' })
  assert.deepEqual(parseFileName('Data.json'), { stem: 'Data', kind: 'other' })
  assert.equal(parseFileName('.gitkeep'), null)
  assert.equal(parseFileName('README.md'), null)
})

test('toDisk maps instances through nested roots, file roots, init files and model files', async () => {
  const { match, menu } = await fixture()
  const at = (map: PlaceMap, path: string[], className = 'ModuleScript', extra: object = {}) => toDisk(map, { path, className, ...extra })
  assert.equal(at(match, [RS, 'Shared', 'Skills', 'Dash'])?.file, 'src/skills/Definitions/Dash.luau')
  assert.equal(at(match, [RS, 'Shared', 'Skills', 'MatchController'])?.file, 'src/skills/Client/init.luau')
  assert.equal(at(match, [RS, 'Shared', 'Skills', 'MatchController', 'Input'])?.file, 'src/skills/Client/Input.luau')
  assert.equal(at(match, [RS, 'Shared', 'Modules', 'Util'])?.file, 'src/shared/Modules/Util.luau')
  assert.equal(at(match, [SSS, 'Server', 'Bootstrapper'], 'Script')?.file, 'src/server/Bootstrapper.server.luau')
  assert.equal(at(match, [SSS, 'Server', 'Features', 'Skills', 'Moves', 'Dash', 'Config'])?.file, 'src/skills/Server/Moves/Dash/Config.luau')
  const anim = at(match, [SSS, 'Server', 'Features', 'Skills', 'Moves', 'Dash', 'Animations', 'Left'], 'Animation')
  assert.deepEqual(anim, { file: 'src/skills/Server/Moves/Dash/Animations.model.json', kind: 'model', modelPath: ['Left'], className: 'Animation' })
  assert.equal(at(match, [SSS, 'Server', 'Features', 'Skills', 'Moves', 'Dash', 'Animations'], 'Folder')?.kind, 'model')
  assert.deepEqual(at(match, [SSS, 'Server', 'Features', 'Skills', 'Moves', 'Dash'], 'Folder'), { file: 'src/skills/Server/Moves/Dash', kind: 'folder', className: 'Folder' })
  // The same files from the menu place's tree.
  assert.equal(at(menu, [SSS, 'Server', 'Features', 'Skills', 'Moves', 'Dash', 'Config'])?.file, 'src/skills/Server/Moves/Dash/Config.luau')
  assert.equal(at(menu, [SSS, 'Server', 'Features', 'Skills', 'Catalog'])?.file, 'src/skills/Server/Catalog.luau')
  assert.equal(at(menu, [SSS, 'Server', 'Config', 'Admins'])?.file, 'src/server/Config/Admins.luau')
  assert.equal(at(menu, [RS, 'Shared', 'Modules', 'SharedConfig'])?.file, 'src/shared/Modules/SharedConfig.luau')
  // Project-defined containers without $path, skipped roots, Packages: not on disk.
  assert.equal(at(menu, [SSS, 'Server', 'Features', 'Skills', 'NewThing']), null)
  assert.equal(at(menu, [SSS, 'Server', 'Config', 'Other']), null)
  assert.equal(at(match, ['ServerStorage', 'Loot']), null)
  assert.equal(at(match, [RS, 'Packages', 'Promise']), null)
  assert.equal(at(match, ['Workspace', 'Thing']), null)
  // New scripts: suffixes, init form when it has children, meta for RunContext.
  assert.equal(at(match, [RS, 'Shared', 'Skills', 'Fresh'], 'Script')?.file, 'src/skills/Definitions/Fresh.server.luau')
  assert.equal(at(match, [RS, 'Shared', 'Skills', 'Fresh'], 'LocalScript')?.file, 'src/skills/Definitions/Fresh.client.luau')
  assert.equal(at(match, [RS, 'Shared', 'Skills', 'Fresh'], 'Script', { runContext: 'Plugin' })?.file, 'src/skills/Definitions/Fresh.plugin.luau')
  assert.deepEqual(at(match, [RS, 'Shared', 'Skills', 'Fresh'], 'Script', { runContext: 'Client' }), { file: 'src/skills/Definitions/Fresh.server.luau', kind: 'script', className: 'Script', runContext: 'Client', metaFile: 'src/skills/Definitions/Fresh.meta.json' })
  assert.equal(at(match, [RS, 'Shared', 'Skills', 'Fresh'], 'ModuleScript', { hasChildren: true })?.file, 'src/skills/Definitions/Fresh/init.luau')
  assert.equal(at(match, [RS, 'Shared', 'Skills', 'Fresh'], 'Folder', { hasChildren: false })?.kind, 'folder')
  assert.equal(at(match, [RS, 'Shared', 'Skills', 'Fresh'], 'Folder', { hasChildren: true, hasScriptDescendants: false })?.file, 'src/skills/Definitions/Fresh.model.json')
  assert.equal(at(match, [RS, 'Shared', 'Skills', 'Fresh'], 'Model', { hasChildren: true, hasScriptDescendants: true })?.kind, 'folder')
  // Unsafe names never produce a path.
  for (const bad of ['..', 'a/b', 'x:y', 'trail ', 'b\\s']) assert.equal(at(match, [RS, 'Shared', 'Skills', bad]), null, bad)
  assert.equal(at(match, [RS, 'Shared', 'Skills', '..', '..', 'escape']), null)
})

test('fromDisk inverts the conventions and refuses paths outside roots', async () => {
  const { match, menu } = await fixture()
  assert.deepEqual(fromDisk(match, 'src/skills/Definitions/Dash.luau'), [RS, 'Shared', 'Skills', 'Dash'])
  assert.deepEqual(fromDisk(match, 'src/skills/Client/init.luau'), [RS, 'Shared', 'Skills', 'MatchController'])
  assert.deepEqual(fromDisk(match, 'src/server/Bootstrapper.server.luau'), [SSS, 'Server', 'Bootstrapper'])
  assert.deepEqual(fromDisk(match, 'src/skills/Server/Moves/Dash/Animations.model.json'), [SSS, 'Server', 'Features', 'Skills', 'Moves', 'Dash', 'Animations'])
  assert.deepEqual(fromDisk(match, 'src/skills/Server/Moves/Dash/init.meta.json'), [SSS, 'Server', 'Features', 'Skills', 'Moves', 'Dash'])
  assert.deepEqual(fromDisk(match, 'src/server/Features/Round.server.luau'), [SSS, 'Server', 'Features', 'Round'])
  assert.deepEqual(fromDisk(menu, 'src/skills/Server/Moves/Dash/Config.luau'), [SSS, 'Server', 'Features', 'Skills', 'Moves', 'Dash', 'Config'])
  assert.deepEqual(fromDisk(menu, 'src/server/Config/Admins.luau'), [SSS, 'Server', 'Config', 'Admins'])
  assert.equal(fromDisk(menu, 'src/server/Handlers/Combat.luau'), null)
  assert.equal(fromDisk(match, 'src/ServerStorage/Loot.luau'), null)
  assert.equal(fromDisk(match, 'Packages/Promise.luau'), null)
  assert.equal(fromDisk(match, 'src/shared/../../etc/passwd'), null)
  assert.equal(fromDisk(match, 'src/shared/.gitkeep'), null)
  // toDisk(fromDisk(f)) round-trips for existing files.
  for (const f of ['src/skills/Definitions/Dash.luau', 'src/skills/Client/init.luau', 'src/server/Bootstrapper.server.luau']) {
    const path = fromDisk(match, f)!
    const info = parseFileName(f.split('/').pop()!)!
    assert.equal(toDisk(match, { path, className: info.className! }, fsProbe(match.root))?.file, f)
  }
})

// ---- merge ----

test('normalise / toFileText keep CRLF files CRLF', () => {
  assert.equal(normalise('a\r\nb\r\n\r\n'), 'a\nb')
  assert.equal(toFileText('a\nb', 'x\r\ny\r\n'), 'a\r\nb\r\n')
  assert.equal(toFileText('a\nb', 'x\ny\n'), 'a\nb\n')
  assert.equal(toFileText('a\nb\n\n'), 'a\nb\n')
})

test('diff3 merges disjoint edits cleanly', () => {
  const base = 'a\nb\nc\nd\ne\nf\n'
  const disk = 'A\nb\nc\nd\ne\nf\n'
  const studio = 'a\nb\nc\nd\ne\nF\n'
  assert.deepEqual(diff3(base, disk, studio), { clean: true, text: 'A\nb\nc\nd\ne\nF' })
  assert.deepEqual(diff3(base, base, studio), { clean: true, text: normalise(studio) })
  assert.deepEqual(diff3(base, disk, base), { clean: true, text: normalise(disk) })
  // Same change on both sides, insertions at both ends, deletions.
  assert.equal(diff3(base, disk, disk).text, normalise(disk))
  assert.deepEqual(diff3('x\ny\n', 'top\nx\ny\n', 'x\ny\nbottom\n'), { clean: true, text: 'top\nx\ny\nbottom' })
  assert.deepEqual(diff3('a\nb\nc\nd\n', 'a\nc\nd\n', 'a\nb\nc\n'), { clean: true, text: 'a\nc' })
  assert.deepEqual(diff3('', 'x\n', ''), { clean: true, text: 'x' })
})

test('diff3 reports conflicts with markers', () => {
  const r = diff3('a\nb\nc\n', 'a\nDISK\nc\n', 'a\nSTUDIO\nc\n')
  assert.equal(r.clean, false)
  assert.equal(r.text, 'a\n<<<<<<< disk\nDISK\n||||||| base\nb\n=======\nSTUDIO\n>>>>>>> studio\nc')
  assert.equal(diff3('', 'one\n', 'two\n').clean, false)
})

test('matchLines finds an LCS on large inputs', () => {
  const a = Array.from({ length: 3000 }, (_, i) => `line ${i}`)
  const b = [...a]
  b.splice(1500, 1, 'changed')
  b.splice(10, 0, 'inserted')
  const m = matchLines(a, b)
  assert.equal(m[0], 0)
  assert.equal(m[1500], -1)
  assert.equal(m[2999], 3000)
  let matched = 0
  for (const v of m) if (v >= 0) matched++
  assert.equal(matched, 2999)
})

// ---- model json ----

const PASCAL = JSON.stringify({ ClassName: 'Folder', Children: [{ Name: 'Left', ClassName: 'Animation', Properties: { AnimationId: 'rbxassetid://2' } }, { Name: 'Activation', ClassName: 'Animation', Properties: { AnimationId: 'rbxassetid://1' } }] }, null, 2)

test('readModel accepts both key styles; canonical form ignores order and spelling', () => {
  const camel = JSON.stringify({ className: 'Folder', children: [{ name: 'Activation', className: 'Animation', properties: { AnimationId: { ContentId: 'rbxassetid://1' } } }, { name: 'Left', className: 'Animation', properties: { AnimationId: 'rbxassetid://2' } }] })
  assert.equal(canonicalModel(PASCAL), canonicalModel(camel))
  const model = readModel(PASCAL)
  assert.deepEqual(model.children.map((c) => c.name), ['Activation', 'Left'])
  assert.equal(detectStyle(PASCAL), 'pascal')
  assert.equal(detectStyle(camel), 'camel')
  assert.match(writeModel(model, 'pascal'), /"ClassName": "Folder"/)
  assert.ok(!writeModel(model).includes('"name": undefined'))
  assert.deepEqual(readModel(writeModel(model)), model)
  assert.equal(canonicalModel('{ nope'), null)
  assert.throws(() => readModel('{"children": []}'))
})

test('modelFromStudio takes non-script descendants, tags and attributes', () => {
  const root = ['S', 'Moves', 'NewMove', 'Animations']
  const nodes = [
    { id: '1', path: [...root, 'Swing'], className: 'Animation', properties: { AnimationId: 'rbxassetid://5' }, tags: ['b', 'a'] },
    { id: '2', path: [...root, 'Swing', 'Marker'], className: 'StringValue', attributes: { Damage: 4 } },
    { id: '3', path: [...root, 'Helper'], className: 'ModuleScript', source: 'return 1' },
    { id: '4', path: ['S', 'Other'], className: 'Animation' }
  ]
  const model = modelFromStudio({ id: '0', path: root, className: 'Folder' }, nodes)
  assert.equal(model.children.length, 1)
  assert.deepEqual(model.children[0].tags, ['a', 'b'])
  assert.equal(model.children[0].children[0].attributes.Damage, 4)
  const text = writeModel(model)
  assert.match(text, /"Tags": \[\s*"a",\s*"b"\s*\]/)
  assert.deepEqual(readModel(text), model)
  assert.equal(canonicalValue({ String: 'x' }), 'x')
  assert.deepEqual(canonicalValue({ Vector3: [1, 2, 3] }), { Vector3: [1, 2, 3] })
})

test('writeMeta keeps unmanaged keys', () => {
  const existing = JSON.stringify({ ignoreUnknownInstances: true, properties: { RunContext: 'Client', Other: 1 } })
  const out = JSON.parse(writeMeta(existing, { runContext: null }, true))
  assert.deepEqual(out, { ignoreUnknownInstances: true, properties: { Other: 1 } })
  assert.deepEqual(JSON.parse(writeMeta(null, { runContext: 'Server' }, true)), { properties: { RunContext: 'Server' } })
  assert.deepEqual(JSON.parse(writeMeta(null, { className: 'Model', properties: {}, attributes: { A: 1 }, tags: ['t'] }, false)), { className: 'Model', attributes: { A: 1 }, properties: { Tags: ['t'] } })
})
