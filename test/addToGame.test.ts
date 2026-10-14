// "Add to game": folder suggestions from the Rojo layout (GenTree template, FSF-like default + menu
// places, a folder mapped to its own $path), the diff, and the service end to end with the real VFX
// Lab exporter: options, preview (exact files), apply, never overwriting without a confirm, Rojo
// mapping respected, the remembered choice per lab + project, and the anim / ability adapters.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diffStat, unifiedDiff } from '../src/shared/addToGame/diff.ts'
import { pickSuggestion, scoreRoot, suggestTargets } from '../src/shared/addToGame/suggest.ts'
import { loadPlaces, fsProbe, toDisk } from '../src/main/services/sync/mapping.ts'
import { AddToGameError, AddToGameService, REMEMBER_SETTING } from '../src/main/services/addToGame/service.ts'
import { abilityAdapter, animAdapter, vfxAdapter, type AbilityLabPort, type AnimLabPort } from '../src/main/services/addToGame/adapters.ts'
import { createAddToGameWiring } from '../src/main/services/addToGame/wire.ts'
import { VfxService } from '../src/main/services/vfx/service.ts'
import { effectFromSpec } from '../src/shared/vfx/spec.ts'
import type { VfxSpec } from '../src/shared/vfx/spec.ts'

const FIX = join(import.meta.dirname, 'fixtures')
const SLASH: VfxSpec = {
  name: 'Test Slash',
  duration: 1,
  layers: [{ name: 'Core', class: 'ParticleEmitter', props: { Color: '#a070ff', Size: 1, Lifetime: [0.3, 0.5], Rate: 0 }, emit: [{ at: 0, count: 20 }] }]
}

async function copyProject(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `a2g-${name}-`))
  await cp(join(FIX, name), dir, { recursive: true })
  return dir
}

function settingsStore() {
  const m = new Map<string, unknown>()
  return { m, get: <T,>(k: string, f: T): T => (m.has(k) ? (m.get(k) as T) : f), set: (k: string, v: unknown) => void m.set(k, v) }
}

async function suggestionsFor(root: string, realm: 'shared' | 'client' | 'server', folder: string) {
  const maps = await loadPlaces(root)
  const probe = fsProbe(root)
  return suggestTargets(
    maps.map((m) => ({ projectFile: m.projectFile, name: m.name, roots: m.roots })),
    realm,
    folder,
    (file, inst) => {
      const map = maps.find((m) => m.projectFile === file)!
      const mf = toDisk(map, { path: inst, className: 'Folder' }, probe)
      return mf && mf.kind === 'folder' ? { dir: mf.file, exists: probe.isDir(mf.file) } : null
    }
  )
}

test('suggestions: GenTree template', async () => {
  const root = await copyProject('template')
  await mkdir(join(root, 'src', 'shared'), { recursive: true })
  await mkdir(join(root, 'src', 'client'), { recursive: true })
  await mkdir(join(root, 'src', 'server'), { recursive: true })
  const anim = await suggestionsFor(root, 'shared', 'Animations')
  assert.equal(anim[0].label, 'ReplicatedStorage.Shared.Animations')
  assert.equal(anim[0].dir, 'src/shared/Animations')
  assert.equal(anim[0].recommended, true)
  assert.ok(!anim.some((t) => t.instance[0] === 'ServerScriptService'), 'server trees are never offered for shared modules')
  const vfx = await suggestionsFor(root, 'client', 'VFX')
  assert.equal(vfx[0].dir, 'src/shared/VFX')
  assert.ok(vfx.some((t) => t.dir === 'src/client/VFX'))
  // An existing lab folder wins.
  await mkdir(join(root, 'src', 'client', 'VFX'), { recursive: true })
  const again = await suggestionsFor(root, 'client', 'VFX')
  assert.equal(again[0].dir, 'src/client/VFX')
  assert.match(again[0].reason, /already has VFX/)
  const server = await suggestionsFor(root, 'server', 'Handlers')
  assert.ok(server.every((t) => t.instance[0] === 'ServerScriptService' || t.instance[0] === 'ServerStorage'))
})

test('suggestions: FSF-like default + menu places', async () => {
  const root = await copyProject('fsf-like')
  const vfx = await suggestionsFor(root, 'client', 'VFX')
  const byPlace = (f: string) => vfx.filter((t) => t.placeFile === f)
  // default: the client tree under ReplicatedStorage (src/skills/Client).
  assert.equal(byPlace('default.project.json')[0].dir, 'src/skills/Client/VFX')
  assert.deepEqual(byPlace('default.project.json')[0].instance, ['ReplicatedStorage', 'Shared', 'Skills', 'MatchController', 'VFX'])
  assert.equal(byPlace('menu.project.json')[0].recommended, true)
  assert.equal(byPlace('menu.project.json')[0].dir, 'src/menu/shared/Modules/VFX')
  const anim = await suggestionsFor(root, 'shared', 'Animations')
  assert.equal(anim.find((t) => t.placeFile === 'default.project.json')!.dir, 'src/shared/Modules/Animations')
  assert.equal(scoreRoot('client', ['ServerScriptService', 'Server'], 'src/server').score, -1)
  assert.ok(scoreRoot('shared', ['ReplicatedStorage', 'Shared', 'events'], 'src/shared/events').score < scoreRoot('shared', ['ReplicatedStorage', 'Shared', 'Modules'], 'src/shared/Modules').score)
})

test('remembered choice wins while it is still offered', () => {
  const targets = [
    { placeFile: 'default.project.json', instance: ['A', 'VFX'], dir: 'a/VFX', exists: false, label: 'A.VFX', recommended: true, reason: '' },
    { placeFile: 'default.project.json', instance: ['B', 'VFX'], dir: 'b/VFX', exists: false, label: 'B.VFX', recommended: false, reason: '' },
    { placeFile: 'menu.project.json', instance: ['C', 'VFX'], dir: 'c/VFX', exists: false, label: 'C.VFX', recommended: true, reason: '' }
  ]
  assert.deepEqual(pickSuggestion(targets, null, ['default.project.json', 'menu.project.json']), { target: { placeFile: 'default.project.json', instance: ['A', 'VFX'] }, remembered: false })
  assert.deepEqual(pickSuggestion(targets, { placeFile: 'menu.project.json', instance: ['C', 'VFX'] }, ['default.project.json']).remembered, true)
  assert.equal(pickSuggestion(targets, { placeFile: 'gone.project.json', instance: ['X'] }, ['default.project.json']).target?.instance.join('.'), 'A.VFX')
})

test('unified diff: hunks, context, stats, cap', () => {
  const a = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n'
  const b = 'one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\n'
  const d = unifiedDiff('x.luau', a, b, { context: 1 })
  assert.match(d, /^--- x\.luau\n\+\+\+ x\.luau\n@@ -2,3 \+2,3 @@\n two\n-three\n\+THREE\n four\n@@/)
  assert.match(d, /\+eight\n$/)
  assert.deepEqual(diffStat(a, b), { added: 2, removed: 1 })
  assert.equal(unifiedDiff('x', a, a), '')
  const big = Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n')
  assert.match(unifiedDiff('x', '', big, { maxLines: 10 }), /… 40 more lines/)
})

async function vfxSetup(project = 'template') {
  const root = await copyProject(project)
  await mkdir(join(root, 'src', 'shared'), { recursive: true })
  await mkdir(join(root, 'src', 'client'), { recursive: true })
  const userDir = await mkdtemp(join(tmpdir(), 'a2g-user-'))
  // projectRoot null while saving so the lab does not auto-write into src/shared/VFX.
  let labRoot: string | null = null
  const vfx = new VfxService({ userDir, projectRoot: () => labRoot, lune: async () => ({ error: 'no' }), runtimeDir: () => null })
  const { entry } = await vfx.saveEffect(effectFromSpec(SLASH))
  labRoot = root
  const settings = settingsStore()
  const wiring = createAddToGameWiring({ root: () => root, settings, vfx })
  return { root, vfx, entry, settings, wiring, svc: wiring.service }
}

test('VFX: options, preview with exact files, apply, then a hand edit needs a confirmed diff', async () => {
  const { root, vfx, entry, settings, svc } = await vfxSetup()
  const opts = await svc.options('vfx', entry.id)
  assert.equal(opts.name, entry.effect!.name)
  assert.deepEqual(opts.places.map((p) => p.file), ['default.project.json'])
  assert.deepEqual(opts.suggested, { placeFile: 'default.project.json', instance: ['ReplicatedStorage', 'Shared', 'VFX'] })
  assert.equal(opts.remembered, false)

  const plan = await svc.preview('vfx', entry.id, opts.suggested!)
  const name = entry.effect!.name
  assert.deepEqual(plan.files.map((f) => [f.path, f.status]), [
    [`src/shared/VFX/${name}/init.luau`, 'new'],
    [`src/shared/VFX/${name}/Effect.rbxmx`, 'new']
  ])
  assert.deepEqual(plan.instance, ['ReplicatedStorage', 'Shared', 'VFX', name])
  assert.equal(plan.requirePath, `game.ReplicatedStorage.Shared.VFX.${name}`)
  assert.deepEqual(plan.warnings, [])

  const r = await svc.apply('vfx', entry.id, opts.suggested!, [])
  assert.equal(r.written.length, 2)
  assert.deepEqual(r.skipped, [])
  const written = await vfx.get(entry.id)
  assert.equal(written.written?.module, `src/shared/VFX/${name}/init.luau`)
  assert.deepEqual((settings.m.get(REMEMBER_SETTING) as any)[root].vfx, opts.suggested)

  // Same content again: nothing to write.
  const same = await svc.preview('vfx', entry.id, opts.suggested!)
  assert.deepEqual(same.files.map((f) => f.status), ['same', 'same'])

  // A hand edit: shown as a diff, not written unless confirmed.
  const file = join(root, 'src', 'shared', 'VFX', name, 'init.luau')
  const original = await readFile(file, 'utf8')
  await writeFile(file, original.replace('local Effect = {}', 'local Effect = {} -- tuned by hand'), 'utf8')
  const changed = await svc.preview('vfx', entry.id, opts.suggested!)
  const f0 = changed.files[0]
  assert.equal(f0.status, 'changed')
  assert.match(f0.diff ?? '', /-local Effect = \{\} -- tuned by hand\n\+local Effect = \{\}/)
  const declined = await svc.apply('vfx', entry.id, opts.suggested!, [])
  assert.deepEqual(declined.written, [])
  assert.deepEqual(declined.skipped, [f0.path])
  assert.match(await readFile(file, 'utf8'), /tuned by hand/)
  const confirmed = await svc.apply('vfx', entry.id, opts.suggested!, [f0.path])
  assert.deepEqual(confirmed.written, [f0.path])
  assert.equal(await readFile(file, 'utf8'), original)

  // Re-opening offers where it is now first.
  const reopen = await svc.options('vfx', entry.id)
  assert.equal(reopen.targets[0].reason, 'where it is now')
})

test('VFX: lands where Rojo maps the folder ($path of its own), outside-root and unmapped targets refused', async () => {
  const root = await copyProject('template')
  await mkdir(join(root, 'src', 'shared'), { recursive: true })
  await mkdir(join(root, 'assets', 'vfx'), { recursive: true })
  const project = JSON.parse(await readFile(join(root, 'default.project.json'), 'utf8'))
  project.tree.ReplicatedStorage.Shared.VFX = { $path: 'assets/vfx' }
  await writeFile(join(root, 'default.project.json'), JSON.stringify(project), 'utf8')
  const userDir = await mkdtemp(join(tmpdir(), 'a2g-user-'))
  let labRoot: string | null = null
  const vfx = new VfxService({ userDir, projectRoot: () => labRoot, lune: async () => ({ error: 'no' }), runtimeDir: () => null })
  const { entry } = await vfx.saveEffect(effectFromSpec(SLASH))
  labRoot = root
  const svc = new AddToGameService({ root: () => root, loadPlaces, getSetting: (_k, f) => f, setSetting: () => undefined })
  svc.registerAdapter(vfxAdapter(vfx))
  const opts = await svc.options('vfx', entry.id)
  assert.deepEqual(opts.suggested?.instance, ['ReplicatedStorage', 'Shared', 'VFX'])
  const plan = await svc.preview('vfx', entry.id, opts.suggested!)
  assert.equal(plan.files[0].path, `assets/vfx/${entry.effect!.name}/init.luau`)
  await assert.rejects(svc.preview('vfx', entry.id, { placeFile: 'default.project.json', instance: ['ServerScriptService'] }), AddToGameError)
  await assert.rejects(svc.preview('vfx', entry.id, { placeFile: 'nope.project.json', instance: ['ReplicatedStorage'] }), /not a place/)
  await assert.rejects(svc.options('nolab', entry.id), /No "Add to game" support/)
})

test('FSF-like: menu place, and the remembered choice per lab + project', async () => {
  const { root, entry, settings, svc, vfx } = await vfxSetup('fsf-like')
  const opts = await svc.options('vfx', entry.id)
  assert.deepEqual(opts.places.map((p) => p.file), ['default.project.json', 'menu.project.json'])
  const menu = opts.targets.find((t) => t.placeFile === 'menu.project.json' && t.recommended)!
  const r = await svc.apply('vfx', entry.id, menu, [])
  assert.ok(r.written[0].startsWith('src/menu/shared/Modules/VFX/'), r.written[0])
  // A second effect: the menu folder is remembered for the VFX lab in this project.
  const second = (await vfx.saveEffect(effectFromSpec({ ...SLASH, name: 'Second Slash' }))).entry
  const o2 = await svc.options('vfx', second.id)
  assert.equal(o2.remembered, true)
  assert.deepEqual(o2.suggested, { placeFile: menu.placeFile, instance: menu.instance })
  assert.ok((settings.m.get(REMEMBER_SETTING) as any)[root].vfx)
})

test('anim adapter: module + KeyframeSequence via the lab exporter, upload note, markWritten', async () => {
  const root = await copyProject('template')
  await mkdir(join(root, 'src', 'shared'), { recursive: true })
  const marked: string[] = []
  const entry = { id: 'a1', name: 'Dash Punch', description: '', clip: { name: 'DashPunch' }, written: null } as any
  const port: AnimLabPort = {
    get: async () => entry,
    exportFiles: (_e, dir) => [
      { path: `${dir}/init.luau`, content: 'return {}\n', role: 'animation module' },
      { path: `${dir}/Sequence.rbxmx`, content: '<roblox/>\n', role: 'KeyframeSequence' }
    ],
    markWritten: async (e, dir) => (marked.push(dir), e)
  }
  const svc = new AddToGameService({ root: () => root, loadPlaces, getSetting: (_k, f) => f, setSetting: () => undefined })
  svc.registerAdapter(animAdapter(port))
  const opts = await svc.options('anim', 'a1')
  assert.match(opts.notes[0], /Not uploaded to Roblox yet/)
  assert.deepEqual(opts.suggested?.instance, ['ReplicatedStorage', 'Shared', 'Animations'])
  const r = await svc.apply('anim', 'a1', opts.suggested!, [])
  assert.deepEqual(r.written, ['src/shared/Animations/DashPunch/init.luau', 'src/shared/Animations/DashPunch/Sequence.rbxmx'])
  assert.equal(r.command, 'require(game.ReplicatedStorage.Shared.Animations.DashPunch).play(game.Players.LocalPlayer.Character)')
  assert.deepEqual(marked, ['src/shared/Animations/DashPunch'])
})

test('ability adapter: module + runner, unwritten VFX added along in the suggested VFX folder', async () => {
  const { root, vfx, entry: fx, svc } = await vfxSetup('fsf-like')
  const ability = { id: 'ab1', ability: { name: 'DashPunch', events: [{ kind: 'vfx', id: 'e1', effect: fx.id, effectName: 'Whatever' }], animation: { name: 'Dash', clip: {}, assetId: 123 } } } as any
  let got: { vfxFolders: Record<string, string>; vfxPath: string[] | null; moduleInstance?: string[] | null } | null = null
  const marked: string[] = []
  const port: AbilityLabPort = {
    get: async () => ability,
    exportFiles: async (_id, dir, o) => {
      got = o
      return { files: [{ path: `${dir}/DashPunch.luau`, content: 'return {}\n', role: 'ability module' }, { path: `${dir}/AbilityRunner.luau`, content: '-- runner\n', role: 'AbilityRunner', owned: () => false }], warnings: [], requirePath: o.moduleInstance ? `game.${o.moduleInstance.join('.')}` : null }
    },
    markWritten: async (_id, dir) => void marked.push(dir)
  }
  svc.registerAdapter(abilityAdapter(port, vfx))
  const opts = await svc.options('ability', 'ab1')
  assert.deepEqual(opts.suggested?.instance, ['ReplicatedStorage', 'Shared', 'Skills', 'MatchController', 'Abilities'])
  // A hand-written runner is kept.
  await mkdir(join(root, 'src', 'skills', 'Client', 'Abilities'), { recursive: true })
  await writeFile(join(root, 'src', 'skills', 'Client', 'Abilities', 'AbilityRunner.luau'), '-- mine\n', 'utf8')
  const plan = await svc.preview('ability', 'ab1', opts.suggested!)
  const name = fx.effect!.name
  assert.deepEqual(plan.files.map((f) => [f.path, f.status]), [
    [`src/skills/Client/VFX/${name}/init.luau`, 'new'],
    [`src/skills/Client/VFX/${name}/Effect.rbxmx`, 'new'],
    ['src/skills/Client/Abilities/DashPunch.luau', 'new'],
    ['src/skills/Client/Abilities/AbilityRunner.luau', 'kept']
  ])
  assert.deepEqual(got!.vfxFolders, { e1: `src/skills/Client/VFX/${name}` })
  assert.deepEqual(got!.vfxPath, ['ReplicatedStorage', 'Shared', 'Skills', 'MatchController', 'VFX'])
  assert.equal(plan.requirePath, 'game.ReplicatedStorage.Shared.Skills.MatchController.Abilities.DashPunch')
  const r = await svc.apply('ability', 'ab1', opts.suggested!, [])
  assert.deepEqual(r.skipped, ['src/skills/Client/Abilities/AbilityRunner.luau'])
  assert.equal(await readFile(join(root, 'src', 'skills', 'Client', 'Abilities', 'AbilityRunner.luau'), 'utf8'), '-- mine\n')
  assert.deepEqual(marked, ['src/skills/Client/Abilities'])
  assert.equal((await vfx.get(fx.id)).written?.module, `src/skills/Client/VFX/${name}/init.luau`)
})

test('IPC handlers validate their input', async () => {
  const { wiring, entry } = await vfxSetup()
  const opts = (await wiring.handlers.addToGameOptions('vfx', entry.id)) as { suggested: unknown }
  const plan = (await wiring.handlers.addToGamePreview('vfx', entry.id, opts.suggested)) as { files: unknown[] }
  assert.equal(plan.files.length, 2)
  await assert.rejects(Promise.resolve().then(() => wiring.handlers.addToGamePreview('vfx', entry.id, null)), AddToGameError)
})
