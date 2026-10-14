// Bulk VFX import: which effects a pack folder holds (a mix of effect Models and loose Parts, like a
// downloaded "VFX" folder with ~60 effects), place files (.rbxl / .rbxlx: the VFX folders in
// Workspace / ReplicatedStorage / ServerStorage), the Studio selection read through the Forge Bridge
// (chunked log messages; with Lune the real Luau module runs against a fake Studio), the review rows
// (names, duplicates, "same effect as"), content hashes, dedupe on import, and the library trash.
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { effectFromNodes } from '../src/shared/vfx/analyze.ts'
import { effectCanon, effectHash, fnv64 } from '../src/shared/vfx/fingerprint.ts'
import { writeRbxmx } from '../src/shared/vfx/rbxmx.ts'
import { dedupeNames, findVfxPacks, splitEffects } from '../src/shared/vfx/split.ts'
import { collectStudioImport, parseSelChunk, parseSelProgress, SEL_DATA_TAG, SEL_ENTRY, SEL_PROGRESS_TAG, studioImportJob, studioImportModuleSource } from '../src/shared/vfx/studioImport.ts'
import type { VfxImportProgress, VfxNode } from '../src/shared/vfx/types.ts'
import { VfxImporter } from '../src/main/services/vfx/importer.ts'
import { TRASH_DIR } from '../src/main/services/vfx/library.ts'
import { VfxError, VfxService } from '../src/main/services/vfx/service.ts'

// ------------------------------------------------------------------ fixtures

let seq = 0
const cf = (x = 0, y = 0, z = 0) => [x, y, z, 1, 0, 0, 0, 1, 0, 0, 0, 1]
const node = (className: string, name: string, children: VfxNode[] = [], props: VfxNode['props'] = {}): VfxNode => ({ id: `n${++seq}`, className, name, props, children })
const emitter = (name = 'Sparks', rate = 20, color: [number, number, number] = [1, 0.5, 0.1]) =>
  node('ParticleEmitter', name, [], { Rate: rate, Color: [{ t: 0, c: color }, { t: 1, c: color }], Size: [{ t: 0, v: 1 }, { t: 1, v: 0 }], Lifetime: [0.5, 1], LightEmission: 1 })
// An effect Model: an invisible part holding an attachment with emitters.
const fxModel = (name: string, rate = 20, layers = 1) => node('Model', name, [node('Part', 'Root', [node('Attachment', 'At', Array.from({ length: layers }, (_, i) => emitter(`E${i}`, rate + i)))], { Transparency: 1, CFrame: cf(0, 3, 0), Size: [1, 1, 1] })])
// A loose Part with an emitter (an effect on its own inside a pack folder).
const fxPart = (name: string, rate = 15) => node('Part', name, [node('Attachment', 'Att', [emitter('Glow', rate)])], { Transparency: 1, CFrame: cf(4, 2, 0), Size: [1, 1, 1] })
const trailPart = (name = 'Trail') => {
  const a0 = node('Attachment', 'A0', [], { CFrame: cf(0, 1, 0) })
  const a1 = node('Attachment', 'A1', [], { CFrame: cf(0, -1, 0) })
  return node('Part', name, [a0, a1, node('Trail', 'Trail', [], { Attachment0: a0.id, Attachment1: a1.id, Lifetime: 0.3, Color: [{ t: 0, c: [1, 1, 1] }, { t: 1, c: [1, 1, 1] }] })], { Transparency: 1, CFrame: cf(), Size: [1, 1, 1] })
}

// Shaped like the user's downloaded folder: effect Models, duplicate names, loose Parts ("Trail",
// "ActivateFX"), a Model with the same name as a Part, things without effects, ~62 effects in all.
function userPack(): VfxNode {
  const kids: VfxNode[] = [
    fxModel('AuraImpact', 11, 3),
    fxModel('Barrage', 12, 2),
    fxModel('Slash', 13),
    fxModel('Slash', 14),
    fxModel('Slash', 15),
    fxModel('Impact', 16),
    fxModel('Impact', 17),
    fxModel('QuickDash', 18),
    trailPart('Trail'),
    fxPart('ActivateFX', 19),
    fxModel('ActivateFX', 20),
    node('Folder', 'Sounds', [node('Sound', 'Whoosh')]),
    node('ModuleScript', 'Readme', [], {})
  ]
  for (let i = 1; i <= 51; i++) kids.push(fxModel(`Effect${String(i).padStart(2, '0')}`, 30 + i))
  return node('Folder', 'VFX', kids)
}

const names = (groups: { name: string }[]) => groups.map((g) => g.name)

// ------------------------------------------------------------------ split

test('split: a pack folder of effect Models mixed with loose Parts splits into one entry per effect', () => {
  const pack = userPack()
  const groups = splitEffects([pack])
  assert.equal(groups.length, 62)
  const first = names(groups).slice(0, 11)
  assert.deepEqual(first, ['AuraImpact', 'Barrage', 'Slash', 'Slash (2)', 'Slash (3)', 'Impact', 'Impact (2)', 'QuickDash', 'Trail', 'ActivateFX', 'ActivateFX (2)'])
  // Loose parts are their own entry, named after themselves, holding just themselves.
  const trail = groups.find((g) => g.name === 'Trail')!
  assert.equal(trail.nodes.length, 1)
  assert.equal(trail.nodes[0].className, 'Part')
  assert.equal(groups.find((g) => g.name === 'ActivateFX')!.nodes[0].className, 'Part')
  assert.equal(groups.find((g) => g.name === 'ActivateFX (2)')!.nodes[0].className, 'Model')
  // Children without effects (sounds, scripts) are not entries.
  assert.ok(!names(groups).includes('Sounds') && !names(groups).includes('Readme'))
  assert.equal(new Set(names(groups).map((n) => n.toLowerCase())).size, 62, 'names are unique')
  // The same children selected in Studio (the pack's children as top-level roots).
  assert.deepEqual(names(splitEffects(pack.children)), names(groups))
})

test('split: loose Parts selected together stay one effect; a Model with its own effect is not split', () => {
  // Several loose top-level parts (one effect built from parts).
  const parts = [fxPart('Left', 10), fxPart('Right', 11), fxPart('Center', 12)]
  const one = splitEffects(parts)
  assert.equal(one.length, 1)
  assert.equal(one[0].nodes.length, 3)
  // A folder of loose parts only: one effect too (no effect Model / Folder among them).
  assert.equal(splitEffects([node('Folder', 'Parts', [fxPart('A', 1), fxPart('B', 2)])]).length, 1)
  // A Model with emitters of its own next to child Models: one effect.
  const own = node('Model', 'Combo', [fxPart('Base', 3), fxModel('Inner1', 4), fxModel('Inner2', 5)])
  assert.deepEqual(names(splitEffects([own])), ['Combo'])
  // A Model whose effects are all child Models: a pack.
  assert.deepEqual(names(splitEffects([node('Model', 'Pack', [fxModel('Fire', 1), fxModel('Ice', 2), node('Script', 'Play', [], {})])])), ['Fire', 'Ice'])
  // ... unless it has parts of its own (a loose Trail part, a visible base).
  assert.deepEqual(names(splitEffects([node('Model', 'Rig', [fxModel('Fire', 1), fxModel('Ice', 2), trailPart('Glue')])])), ['Rig'])
  assert.deepEqual(names(splitEffects([node('Model', 'Statue', [fxModel('Fire', 1), fxModel('Ice', 2), node('Part', 'Base', [], { Transparency: 0, Size: [4, 1, 4], CFrame: cf() })])])), ['Statue'])
  // One effect plus a visible part next to it: one effect with both.
  const mesh = node('MeshPart', 'Blade', [], { Transparency: 0, CFrame: cf(1, 1, 1), Size: [4, 1, 4], MeshId: 'rbxassetid://123' })
  const withGeo = splitEffects([fxModel('Swing', 9), mesh])
  assert.equal(withGeo.length, 1)
  assert.equal(withGeo[0].nodes.length, 2)
  // Nothing with content: no effects.
  assert.deepEqual(splitEffects([node('Folder', 'Empty', [node('Sound', 'S')])]), [])
})

test('split: nested pack folders split again; place packs (packs: true) split every root', () => {
  const vfx = node('Folder', 'VFX', [node('Folder', 'Combat', [fxModel('Punch', 1), fxModel('Kick', 2), fxPart('Spark', 3)]), node('Folder', 'Magic', [fxModel('Fireball', 4), fxModel('Punch', 5)]), fxModel('Idle', 6)])
  assert.deepEqual(names(splitEffects([vfx])), ['Punch', 'Kick', 'Spark', 'Fireball', 'Punch (2)', 'Idle'])
  // Place packs: each root is a pack; its children with content are the effects (a pack of
  // loose parts splits too).
  const ws = node('Folder', 'VFX', [fxPart('A', 1), fxPart('B', 2), fxModel('C', 3)])
  const rs = node('Folder', 'Effects', [fxModel('A', 4), node('Folder', 'Nothing', [])])
  assert.deepEqual(names(splitEffects([ws, rs], { packs: true })), ['A', 'B', 'C', 'A (2)'])
})

test('dedupeNames: numbered suffixes never reuse a name that is already there', () => {
  assert.deepEqual(names(dedupeNames([{ name: 'Slash' }, { name: 'Slash (2)' }, { name: 'slash' }, { name: 'Slash' }])), ['Slash', 'Slash (2)', 'slash (3)', 'Slash (4)'])
  assert.deepEqual(names(dedupeNames([{ name: '' }, { name: ' ' }])), ['Effect', 'Effect (2)'])
  const same = { name: 'Only' }
  assert.equal(dedupeNames([same])[0], same, 'unchanged groups are kept as they are')
})

// ------------------------------------------------------------------ place files

function placeRoots(): VfxNode[] {
  const ws = node('Workspace', 'Workspace', [
    node('Folder', 'VFX', [fxModel('Slash', 1), fxModel('Slash', 2), fxModel('Impact', 3), node('Folder', 'Sub', [fxModel('X', 4), fxModel('Y', 5), fxModel('Z', 6)])]),
    node('Model', 'Map', [node('Folder', 'Props', [fxModel('Torch', 7), fxModel('Torch', 8)])])
  ])
  const rs = node('ReplicatedStorage', 'ReplicatedStorage', [node('Folder', 'Assets', [node('Folder', 'Effects', [fxModel('Aura', 9)])])])
  const lighting = node('Lighting', 'Lighting', [node('Folder', 'VFX', [fxModel('Nope', 10), fxModel('Nope2', 11), fxModel('Nope3', 12)])])
  return [ws, rs, lighting]
}

test('findVfxPacks: folders with 3+ effects (or a VFX-like name) in Workspace / ReplicatedStorage / ServerStorage, top-most only', () => {
  const packs = findVfxPacks(placeRoots())
  assert.deepEqual(
    packs.map((p) => [p.path.join('.'), p.effects]),
    [
      ['Workspace.VFX', 4],
      ['ReplicatedStorage.Assets.Effects', 1]
    ]
  )
  // Map.Props has two torches and no VFX-like name; Lighting is not searched.
})

test('import: a .rbxlx place without Lune imports its VFX folders (place bytes are not kept)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfxplace-'))
  const svc = new VfxService({ userDir: join(dir, 'user'), projectRoot: () => null, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null } as never)
  await writeFile(join(dir, 'Game.rbxlx'), writeRbxmx(placeRoots()))
  const r = await svc.import([join(dir, 'Game.rbxlx')], 'user')
  assert.deepEqual(names(r.added).sort(), ['Aura', 'Impact', 'Slash', 'Slash (2)', 'X', 'Y', 'Z'].sort())
  assert.ok(r.notes?.some((n) => n.notes.some((x) => /VFX folders read: Workspace\.VFX, ReplicatedStorage\.Assets\.Effects/.test(x))))
  for (const e of r.added) assert.deepEqual(await readdir(join(svc.store('user').entryDir(e.id), 'media')).catch(() => []), [], 'the place file is not stored with each entry')
  // A place without a VFX folder is skipped with a reason; .rbxl without Lune asks for Lune.
  await writeFile(join(dir, 'Empty.rbxlx'), writeRbxmx([node('Workspace', 'Workspace', [node('Model', 'Baseplate', [node('Part', 'P', [], { Transparency: 0, Size: [4, 1, 4], CFrame: cf() })])])]))
  await writeFile(join(dir, 'Bin.rbxl'), Buffer.from('<roblox!binary'))
  const r2 = await svc.import([join(dir, 'Empty.rbxlx'), join(dir, 'Bin.rbxl')], 'user')
  assert.equal(r2.added.length, 0)
  assert.match(r2.skipped.find((s) => s.file.endsWith('Empty.rbxlx'))!.reason, /no VFX folder found/)
  assert.match(r2.skipped.find((s) => s.file.endsWith('Bin.rbxl'))!.reason, /needs Lune.*\.rbxlx/)
})

function findLune(): string | null {
  for (const c of [process.env.LUNE_PATH, 'lune']) {
    if (!c) continue
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' })
      return c
    } catch {
      /* next */
    }
  }
  return null
}
const lune = findLune()
const runtime = join(import.meta.dirname, '..', 'resources', 'lune')
const runLune = (dir: string, script: string) => new Promise<string>((res, rej) => execFile(lune!, ['run', script], { cwd: dir, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => (err ? rej(new Error(stderr || err.message)) : res(stdout))))

test('import: binary .rbxl places through Lune (VFX folders in Workspace and ReplicatedStorage)', { skip: !lune ? 'Lune not installed (set LUNE_PATH)' : false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfxrbxl-'))
  await writeFile(
    join(dir, 'make.luau'),
    `local roblox = require("@lune/roblox")
local fs = require("@lune/fs")
local Instance = roblox.Instance
local game = Instance.new("DataModel")
local vfx = Instance.new("Folder"); vfx.Name = "VFX"; vfx.Parent = game:GetService("Workspace")
for i, n in {"Slash", "Slash", "Impact", "Burst"} do
  local m = Instance.new("Model"); m.Name = n; m.Parent = vfx
  local p = Instance.new("Part"); p.Name = "Root"; p.Transparency = 1; p.Parent = m
  local a = Instance.new("Attachment"); a.Parent = p
  local e = Instance.new("ParticleEmitter"); e.Name = "Sparks"; e.Rate = i * 3; e.Parent = a
end
local loose = Instance.new("Part"); loose.Name = "Trail"; loose.Transparency = 1; loose.Parent = vfx
local t = Instance.new("Trail"); t.Parent = loose
local fx = Instance.new("Folder"); fx.Name = "Effects"; fx.Parent = game:GetService("ReplicatedStorage")
local m = Instance.new("Model"); m.Name = "Aura"; m.Parent = fx
local p = Instance.new("Part"); p.Name = "P"; p.Transparency = 1; p.Parent = m
local e = Instance.new("ParticleEmitter"); e.Name = "Glow"; e.Parent = p
fs.writeFile("Game.rbxl", roblox.serializePlace(game))
`
  )
  await runLune(dir, 'make.luau')
  const svc = new VfxService({ userDir: join(dir, 'user'), projectRoot: () => null, lune: async () => ({ path: lune! }), runtimeDir: () => runtime } as never)
  const r = await svc.import([join(dir, 'Game.rbxl')], 'user')
  assert.deepEqual(names(r.added), ['Slash', 'Slash (2)', 'Impact', 'Burst', 'Trail', 'Aura'], JSON.stringify(r.skipped))
  assert.ok(r.notes?.some((n) => n.notes.some((x) => x.includes('Workspace.VFX') && x.includes('ReplicatedStorage.Effects'))))
})

// ------------------------------------------------------------------ content hash

test('fingerprint: same effect under other names / ids / order / position hashes the same; a changed property does not', () => {
  const a = fxModel('Slash', 20, 3)
  const b: VfxNode = JSON.parse(JSON.stringify(a))
  // Other names and ids, children reversed, everything moved by (10, 0, -5).
  const rename = (n: VfxNode, i = 0): void => {
    n.name = `${n.name}_copy${i}`
    n.id = `other-${n.id}`
    n.children.reverse()
    if (Array.isArray(n.props.CFrame)) n.props.CFrame = [(n.props.CFrame as number[])[0] + 10, (n.props.CFrame as number[])[1], (n.props.CFrame as number[])[2] - 5, ...(n.props.CFrame as number[]).slice(3)]
    n.children.forEach((c, j) => rename(c, j))
  }
  rename(b)
  b.name = 'Totally Different'
  const ea = effectFromNodes('Slash', [a])
  const eb = effectFromNodes('Totally Different', [b])
  assert.equal(effectHash(ea), effectHash(eb))
  assert.equal(effectHash([a]), effectHash([b]))
  assert.ok(!effectCanon(ea).includes('Slash'), 'names are not part of the canonical text')
  // A changed property, colour or an extra layer changes it.
  const c: VfxNode = JSON.parse(JSON.stringify(a))
  ;(c.children[0].children[0].children[1].props as Record<string, unknown>).Rate = 99
  assert.notEqual(effectHash([c]), effectHash([a]))
  const d: VfxNode = JSON.parse(JSON.stringify(a))
  d.children[0].children[0].children[0].props.Color = [{ t: 0, c: [0, 0.4, 1] }, { t: 1, c: [0, 0.4, 1] }]
  assert.notEqual(effectHash([d]), effectHash([a]))
  assert.notEqual(effectHash([fxModel('Slash', 20, 4)]), effectHash([fxModel('Slash', 20, 3)]))
  // Float noise below 1e-4 does not matter.
  const e: VfxNode = JSON.parse(JSON.stringify(a))
  ;(e.children[0].children[0].children[1].props as Record<string, unknown>).Rate = 21.000001
  assert.equal(effectHash([e]), effectHash([a]))
  assert.match(fnv64('x'), /^[0-9a-f]{16}$/)
  assert.notEqual(fnv64('a'), fnv64('b'))
})

// ------------------------------------------------------------------ dedupe on import

test('import dedupe: effects already in the library (same scope) and repeats in one import are skipped unless forced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfxdedupe-'))
  const proj = join(dir, 'proj')
  let clock = 0
  const svc = new VfxService({ userDir: join(dir, 'user'), projectRoot: () => proj, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null, now: () => ++clock * 1000 } as never)
  await writeFile(join(dir, 'Blast.rbxmx'), writeRbxmx([fxModel('Blast', 40, 2)]))
  const first = await svc.import([join(dir, 'Blast.rbxmx')], 'user')
  assert.equal(first.added.length, 1)
  assert.equal(first.duplicates, undefined)
  // The same effect under another file and instance names.
  const renamed = fxModel('Kaboom', 40, 2)
  renamed.children[0].name = 'Holder'
  await writeFile(join(dir, 'Kaboom.rbxmx'), writeRbxmx([renamed]))
  const again = await svc.import([join(dir, 'Kaboom.rbxmx')], 'user')
  assert.equal(again.added.length, 0)
  assert.deepEqual(again.duplicates, [{ file: join(dir, 'Kaboom.rbxmx'), name: 'Kaboom', of: 'Blast' }])
  // Import anyway.
  const forced = await svc.import([join(dir, 'Kaboom.rbxmx')], 'user', { force: true })
  assert.equal(forced.added.length, 1)
  // Another scope is another library.
  assert.equal((await svc.import([join(dir, 'Kaboom.rbxmx')], 'project')).added.length, 1)
  // Within one import: the same effect twice in a pack is imported once.
  await writeFile(join(dir, 'Pack.rbxmx'), writeRbxmx([node('Folder', 'Pack', [fxModel('One', 70), fxModel('OneCopy', 70), fxModel('Two', 71)])]))
  const pack = await svc.import([join(dir, 'Pack.rbxmx')], 'user')
  assert.deepEqual(names(pack.added), ['One', 'Two'])
  assert.deepEqual(pack.duplicates?.map((d) => [d.name, d.of]), [['OneCopy', 'One']])
  // Find duplicates: the forced copy shows up with its original (oldest first).
  const dups = await svc.duplicates()
  assert.equal(dups.length, 1)
  assert.equal(dups[0].scope, 'user')
  assert.deepEqual(names(dups[0].entries), ['Blast', 'Kaboom'])
})

// ------------------------------------------------------------------ trash

test('trash: delete selected / clear go to a recoverable trash (undo), purged on the next start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfxtrash-'))
  const svc = new VfxService({ userDir: join(dir, 'user'), projectRoot: () => null, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null } as never)
  await writeFile(join(dir, 'Pack.rbxmx'), writeRbxmx([node('Folder', 'Pack', [fxModel('A', 1), fxModel('B', 2), fxModel('C', 3)])]))
  const r = await svc.import([join(dir, 'Pack.rbxmx')], 'user')
  const [a, b, c] = r.added
  const t = await svc.trash([a.id, b.id, 'not-there'])
  assert.deepEqual(t.removed.sort(), [a.id, b.id].sort())
  assert.match(t.batch, /^t[a-z0-9]+-[a-z0-9]+$/)
  assert.deepEqual(names(await svc.list()), ['C'])
  assert.ok((await stat(join(svc.userLibraryDir, TRASH_DIR, t.batch, a.id))).isDirectory())
  // Undo.
  const back = await svc.restore(t.batch)
  assert.deepEqual(back.restored.sort(), [a.id, b.id].sort())
  assert.deepEqual(names(await svc.list()).sort(), ['A', 'B', 'C'])
  assert.equal((await svc.restore(t.batch)).restored.length, 0, 'a batch restores once')
  // Clear the library: everything to the trash, then the next start empties it.
  const cleared = await svc.clear('user')
  assert.equal(cleared.removed.length, 3)
  assert.deepEqual(await svc.list(), [])
  await svc.purgeTrash()
  await assert.rejects(stat(join(svc.userLibraryDir, TRASH_DIR)))
  assert.deepEqual((await svc.restore(cleared.batch)).restored, [])
  assert.deepEqual(await svc.list(), [])
  assert.ok(c)
  // Batch names are checked.
  await assert.rejects(svc.restore('../../etc'), /bad trash batch/)
})

// ------------------------------------------------------------------ Studio import (bridge messages)

// The module's log messages for a payload (chunked like the Luau post()).
function studioMessages(payload: unknown, chunk = 300): string[] {
  const text = JSON.stringify(payload)
  const pieces: string[] = []
  for (let i = 0; i < text.length; i += chunk) pieces.push(text.slice(i, i + chunk))
  return pieces.map((p, i) => `${SEL_DATA_TAG} ${i + 1}/${pieces.length} ${p}`)
}

test('studio import: progress, chunks (UTF-8 names), packs and errors are read back from the log messages', () => {
  assert.deepEqual(parseSelProgress(`${SEL_PROGRESS_TAG} 3/62 Slash`), { done: 3, total: 62, label: 'Slash' })
  assert.equal(parseSelProgress('something else'), null)
  assert.deepEqual(parseSelChunk(`${SEL_DATA_TAG} 2/9 {"x"`), { index: 2, total: 9 })
  const roots = [{ id: 's1', className: 'Model', name: 'Éclair ⚡ 斬撃', props: [], children: [] }]
  const msgs = studioMessages({ kind: 'nodes', roots, paths: ['Workspace.VFX.Éclair'], count: 1, truncated: false }, 7)
  assert.ok(msgs.length > 5)
  // Out of order and with unrelated logs in between.
  const mixed = [msgs[3], 'forge-vfx-progress 1/1 x', ...msgs.filter((_, i) => i !== 3).reverse()]
  const got = collectStudioImport(mixed)
  assert.equal(got?.kind, 'nodes')
  assert.equal((got as { roots: { name: string }[] }).roots[0].name, 'Éclair ⚡ 斬撃')
  assert.equal(collectStudioImport(msgs.slice(1)), null, 'a missing chunk')
  assert.equal(collectStudioImport([`${SEL_DATA_TAG} 1/1 {not json`]), null)
  const packs = collectStudioImport(
    studioMessages({
      kind: 'packs',
      packs: [
        { path: [{ name: 'Workspace', index: 0 }, { name: 'Small', index: 2 }], fullName: 'Workspace.Small', className: 'Folder', effects: 3, children: 3 },
        { path: [{ name: 'ReplicatedStorage', index: 0 }, { name: 'VFX', index: 1 }], fullName: 'ReplicatedStorage.VFX', className: 'Folder', effects: 62, children: 64 },
        { path: [{ name: 'Workspace', index: 0 }], fullName: 'bad', effects: 9 }
      ]
    })
  )
  assert.equal(packs?.kind, 'packs')
  assert.deepEqual(
    (packs as { packs: { fullName: string; effects: number }[] }).packs.map((p) => [p.fullName, p.effects]),
    [
      ['ReplicatedStorage.VFX', 62],
      ['Workspace.Small', 3]
    ]
  )
  assert.deepEqual(collectStudioImport(studioMessages({ kind: 'error', error: 'boom' })), { kind: 'error', error: 'boom' })
  // Roblox writes an empty table as [] or {}.
  assert.deepEqual(collectStudioImport(studioMessages({ kind: 'packs', packs: {} })), { kind: 'packs', packs: [] })
})

test('studio import job: a read-only realtime vfx job; paths of the chosen folders are in the module', () => {
  const job = studioImportJob({ id: 'job-vfxsel-1', port: 34877 })
  assert.equal(job.kind, 'vfx')
  assert.equal(job.mode, 'realtime')
  assert.equal(job.entry, SEL_ENTRY)
  assert.equal(job.modules.length, 1)
  assert.equal(job.timeout, 600)
  const src = job.modules[0].source ?? ''
  assert.match(src, /local MODE = "auto"/)
  assert.match(src, /http:\/\/127\.0\.0\.1:34877\/forge-bridge\/event\/job-vfxsel-1/)
  assert.ok(!/:Destroy\(|\.Parent\s*=|Selection:Set/.test(src), 'changes nothing in the place')
  const withPaths = studioImportModuleSource({ port: 1, jobId: 'j', paths: [[{ name: 'ReplicatedStorage', index: 0 }, { name: 'VFX "x"', index: 3 }]] })
  assert.match(withPaths, /local MODE = "paths"/)
  assert.ok(withPaths.includes('"ReplicatedStorage", 1') && withPaths.includes('"VFX \\"x\\"", 3'), withPaths.split('\n').find((l) => l.includes('PATHS')))
  assert.throws(() => studioImportModuleSource({ port: 1, jobId: 'bad id"' }))
})

// Studio's answer as JSON (what the Luau module serializes): a selected pack folder.
function studioPayload(): { roots: unknown[]; paths: string[] } {
  const pack = userPack()
  // Two identical effects under different names (sameAs in the review), and a mesh to load.
  pack.children.push(fxModel('Copy Of Barrage', 12, 2))
  pack.children.push(node('Model', 'MeshSlash', [node('MeshPart', 'Blade', [], { MeshId: 'rbxassetid://777', Transparency: 0, Size: [4, 1, 4], CFrame: cf() }), fxPart('Glint', 3)]))
  const toStudio = (n: VfxNode): unknown => ({ id: n.id, className: n.className, name: n.name, props: Object.keys(n.props).length ? n.props : [], children: n.children.map(toStudio) })
  return { roots: [toStudio(pack)], paths: ['ReplicatedStorage.VFX'] }
}

function fakeStudio(answer: (job: { modules: { source?: string }[] }) => string[] | Promise<string[]>, opts: { connected?: boolean } = {}) {
  const jobs: { source: string; opts: unknown }[] = []
  return {
    jobs,
    bridge: {
      port: 34877,
      listening: true,
      connected: () => opts.connected ?? true,
      async run(job: { modules: { source?: string }[] }, handler: (ev: { type: string; message?: string }, at: number) => unknown, o?: unknown) {
        jobs.push({ source: job.modules[0].source ?? '', opts: o })
        for (const m of await answer(job)) handler({ type: 'log', message: m }, 0)
      }
    }
  }
}

test('studio import: the selection becomes review rows (names, duplicates, same-as), commit adds them and loads meshes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfxstudio-'))
  const svc = new VfxService({ userDir: join(dir, 'user'), projectRoot: () => null, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null } as never)
  // Already in the library: Barrage (imported from a file earlier).
  await writeFile(join(dir, 'Barrage.rbxmx'), writeRbxmx([fxModel('Barrage', 12, 2)]))
  const existing = (await svc.import([join(dir, 'Barrage.rbxmx')], 'user')).added[0]
  const p = studioPayload()
  const studio = fakeStudio(() => [`${SEL_PROGRESS_TAG} 1/66 AuraImpact`, `${SEL_PROGRESS_TAG} 66/66 MeshSlash`, ...studioMessages({ kind: 'nodes', ...p, count: 400, truncated: false }, 5000)])
  const events: VfxImportProgress[] = []
  const meshCalls: string[][] = []
  const imp = new VfxImporter({
    service: svc,
    bridge: () => studio.bridge,
    emit: (_e, x) => events.push(x),
    loadMeshes: async (refs) => {
      meshCalls.push(refs)
      return { results: refs.map(() => ({ state: 'loaded' })) }
    }
  })
  assert.equal(imp.studioConnected(), true)
  const scan = await imp.scanStudio()
  assert.equal(studio.jobs.length, 1)
  assert.deepEqual(studio.jobs[0].opts, { acceptTimeoutMs: 12_000, timeoutMs: 600_000 })
  assert.equal(scan.source, 'studio')
  assert.equal(scan.rows.length, 64)
  const row = (n: string) => scan.rows.find((r) => r.name === n)!
  assert.deepEqual(scan.rows.slice(0, 5).map((r) => r.name), ['AuraImpact', 'Barrage', 'Slash', 'Slash (2)', 'Slash (3)'])
  assert.equal(row('AuraImpact').origin, 'ReplicatedStorage.VFX.AuraImpact')
  assert.equal(row('AuraImpact').stats.emitters, 3)
  assert.deepEqual(row('Barrage').duplicates, [{ scope: 'user', id: existing.id, name: 'Barrage' }])
  assert.equal(row('Copy Of Barrage').sameAs, row('Barrage').key)
  assert.equal(row('Trail').stats.trails, 1)
  assert.equal(row('MeshSlash').stats.meshes, 1)
  // Progress: reading n of m (from the module), done.
  assert.ok(events.some((e) => e.phase === 'reading' && e.done === 1 && e.total === 66 && e.label === 'AuraImpact'))
  assert.equal(events.at(-1)?.phase, 'done')
  // Commit: everything except the duplicates, one renamed.
  const pick = scan.rows.filter((r) => !r.duplicates.length && !r.sameAs).map((r) => ({ key: r.key, name: r.name === 'QuickDash' ? 'Quick Dash' : r.name }))
  assert.equal(pick.length, 62)
  events.length = 0
  const res = await imp.commit({ scanId: scan.scanId, scope: 'user', rows: pick })
  assert.equal(res.added.length, 62)
  assert.ok(res.added.some((e) => e.name === 'Quick Dash'))
  assert.equal(res.added.find((e) => e.name === 'AuraImpact')!.origin, 'ReplicatedStorage.VFX.AuraImpact')
  assert.deepEqual(meshCalls, [['777']])
  assert.deepEqual(res.meshes, { total: 1, loaded: 1, failed: 0 })
  assert.ok(events.some((e) => e.phase === 'importing' && e.done === 62 && e.total === 62))
  assert.ok(events.some((e) => e.phase === 'meshes'))
  assert.equal((await svc.list()).length, 63)
  // Each entry keeps its instances as .rbxmx (re-import works from it).
  const slash = res.added.find((e) => e.name === 'Slash (2)')!
  assert.deepEqual(await readdir(join(svc.store('user').entryDir(slash.id), 'media')), ['Slash_2_.rbxmx'])
  const re = await svc.reimport(slash.id)
  assert.equal(re.stats?.emitters, 1)
  // The review is gone after commit.
  await assert.rejects(imp.commit({ scanId: scan.scanId, scope: 'user', rows: pick }), /expired/)
})

test('studio import: nothing selected lists VFX folders; reading the chosen folders; errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfxstudio2-'))
  const svc = new VfxService({ userDir: join(dir, 'user'), projectRoot: () => null, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null } as never)
  const packs = [{ path: [{ name: 'ReplicatedStorage', index: 0 }, { name: 'VFX', index: 4 }], fullName: 'ReplicatedStorage.VFX', className: 'Folder', effects: 5, children: 6 }]
  const folder = { id: 's1', className: 'Folder', name: 'VFX', props: [], children: [fxModel('A', 1), fxModel('B', 2), fxPart('C', 3)] }
  const studio = fakeStudio((job) => (/MODE = "paths"/.test(job.modules[0].source ?? '') ? studioMessages({ kind: 'nodes', roots: [folder], paths: ['ReplicatedStorage.VFX'], count: 10, truncated: true }) : studioMessages({ kind: 'packs', packs })))
  const imp = new VfxImporter({ service: svc, bridge: () => studio.bridge })
  const first = await imp.scanStudio()
  assert.deepEqual(first.rows, [])
  assert.equal(first.packs?.[0].fullName, 'ReplicatedStorage.VFX')
  assert.match(first.notes[0], /pick the VFX folders/)
  const second = await imp.scanStudio({ packs: first.packs!.map((p) => p.path) })
  assert.match(studio.jobs[1].source, /"VFX", 4/)
  assert.deepEqual(second.rows.map((r) => r.name), ['A', 'B', 'C'])
  assert.match(second.notes.join(' '), /first 10 instances/)
  // Errors: not connected, Studio's own error, nothing arrived.
  await assert.rejects(new VfxImporter({ service: svc, bridge: () => fakeStudio(() => [], { connected: false }).bridge }).scanStudio(), (e: unknown) => e instanceof VfxError && /not connected/.test((e as Error).message))
  await assert.rejects(new VfxImporter({ service: svc, bridge: () => undefined }).scanStudio(), VfxError)
  await assert.rejects(new VfxImporter({ service: svc, bridge: () => fakeStudio(() => studioMessages({ kind: 'error', error: 'the chosen folders are no longer in the place' })).bridge }).scanStudio(), /Studio: the chosen folders/)
  await assert.rejects(new VfxImporter({ service: svc, bridge: () => fakeStudio(() => []).bridge }).scanStudio(), /did not arrive/)
  // A failed run with the data already in hand still reads it.
  const late = fakeStudio(() => studioMessages({ kind: 'nodes', roots: [folder], paths: ['X'], count: 3, truncated: false }))
  const run = late.bridge.run.bind(late.bridge)
  late.bridge.run = async (job, handler, o) => {
    await run(job, handler, o)
    throw new Error('the Studio check timed out')
  }
  assert.equal((await new VfxImporter({ service: svc, bridge: () => late.bridge }).scanStudio()).rows.length, 3)
})

test('file import review: scan dropped files (models + media), duplicates unchecked, commit with media', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-vfxscan-'))
  const svc = new VfxService({ userDir: join(root, 'user'), projectRoot: () => null, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null } as never)
  const dir = join(root, 'drop')
  await mkdir(dir)
  await writeFile(join(dir, 'Pack.rbxmx'), writeRbxmx([userPack()]))
  await writeFile(join(dir, 'Single.rbxmx'), writeRbxmx([fxModel('Whatever', 5)]))
  await writeFile(join(dir, 'ref.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await writeFile(join(dir, 'broken.rbxmx'), '<roblox><Item class="Folder"><Properties><string name="Name">Nothing</string></Properties></Item></roblox>')
  const imp = new VfxImporter({ service: svc })
  const scan = await imp.scanFiles([dir])
  assert.equal(scan.source, 'files')
  assert.equal(scan.rows.length, 63)
  // A single-effect file is named after the file; pack entries after the instances.
  assert.ok(scan.rows.some((r) => r.name === 'Single' && r.origin === 'Single.rbxmx'))
  assert.ok(scan.rows.some((r) => r.name === 'Slash (3)' && r.origin === 'Pack.rbxmx'))
  assert.deepEqual(scan.media, ['ref.png'])
  assert.equal(scan.skipped.length, 1)
  assert.match(scan.skipped[0].reason, /no ParticleEmitter/)
  const res = await imp.commit({ scanId: scan.scanId, scope: 'user', rows: scan.rows.slice(0, 3).map((r) => ({ key: r.key, name: r.name })) })
  assert.deepEqual(names(res.added), ['AuraImpact', 'Barrage', 'Slash', 'ref'])
  // Scanning again: those three are already in the library.
  const again = await imp.scanFiles([join(dir, 'Pack.rbxmx')])
  assert.deepEqual(again.rows.filter((r) => r.duplicates.length).map((r) => r.name), ['AuraImpact', 'Barrage', 'Slash'])
  // Unknown keys are ignored; the project scope needs a project.
  const scan3 = await imp.scanFiles([join(dir, 'Single.rbxmx')])
  await assert.rejects(imp.commit({ scanId: scan3.scanId, scope: 'project', rows: [{ key: scan3.rows[0].key, name: 'x' }] }), /Open a project/)
})

// ------------------------------------------------------------------ the real Luau module (Lune)

// Runs the Studio import module in Lune against a DataModel built by `build` (Luau returning the
// selection), with fake HttpService / Selection; returns the posted log messages.
async function runModule(source: string, build: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfxselmod-'))
  await writeFile(join(dir, 'module.luau'), source)
  await writeFile(
    join(dir, 'harness.luau'),
    `local roblox = require("@lune/roblox")
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local serde = require("@lune/serde")
local task = require("@lune/task")
local Instance = roblox.Instance
local dm = Instance.new("DataModel")
local selection = (function()
${build}
end)()
local messages = {}
local Http = {}
function Http:JSONEncode(v) return serde.encode("json", v) end
function Http:RequestAsync(req)
  table.insert(messages, serde.decode("json", req.Body).message)
  return { Success = true, StatusCode = 200, Body = "{}" }
end
local Sel = {}
function Sel:Get() return selection end
local game = {}
function game:GetService(name)
  if name == "HttpService" then return Http end
  if name == "Selection" then return Sel end
  return dm:GetService(name)
end
local env = { game = game, task = task, typeof = typeof, utf8 = utf8 }
local M = luau.load(fs.readFile("module.luau"), { debugName = "ForgeVfxRead", environment = env })()
M.play(nil, nil, {})
fs.writeFile("out.json", serde.encode("json", messages))
`
  )
  await runLune(dir, 'harness.luau')
  return JSON.parse(await readFile(join(dir, 'out.json'), 'utf8'))
}

const BUILD_PACK = `local vfx = Instance.new("Folder"); vfx.Name = "VFX"; vfx.Parent = dm:GetService("ReplicatedStorage")
for i, n in {"Slash", "Slash", "Impact"} do
  local m = Instance.new("Model"); m.Name = n; m.Parent = vfx
  local p = Instance.new("Part"); p.Name = "Root"; p.Transparency = 1; p.CFrame = roblox.CFrame.new(i, 2, 3); p.Parent = m
  local a = Instance.new("Attachment"); a.Parent = p
  local e = Instance.new("ParticleEmitter"); e.Name = "Sparks"; e.Rate = i * 5; e.Enabled = false
  e.Color = roblox.ColorSequence.new(roblox.Color3.new(1, 0.5, 0), roblox.Color3.new(1, 0, 0))
  e.Size = roblox.NumberSequence.new({ roblox.NumberSequenceKeypoint.new(0, 1, 0.5), roblox.NumberSequenceKeypoint.new(1, 0) })
  e.Speed = roblox.NumberRange.new(2, 4)
  e.Texture = "rbxassetid://555"
  e:SetAttribute("EmitCount", 12)
  e.Parent = a
end
local loose = Instance.new("Part"); loose.Name = "Trail"; loose.Transparency = 1; loose.Parent = vfx
local a0 = Instance.new("Attachment"); a0.Name = "A0"; a0.Parent = loose
local a1 = Instance.new("Attachment"); a1.Name = "A1"; a1.Parent = loose
local t = Instance.new("Trail"); t.Attachment0 = a0; t.Attachment1 = a1; t.Parent = loose
local s = Instance.new("Script"); s.Name = "Play"; s.Source = "print('héllo')"; s.Parent = vfx:FindFirstChild("Impact")
local other = Instance.new("Folder"); other.Name = "Effects"; other.Parent = dm:GetService("Workspace")
for i = 1, 3 do
  local m = Instance.new("Model"); m.Name = "Fx" .. i; m.Parent = other
  local e = Instance.new("Beam"); e.Parent = m
end`

test('studio import module (Lune): reads the selection, lists VFX folders when nothing is selected, resolves chosen folders', { skip: !lune ? 'Lune not installed (set LUNE_PATH)' : false }, async () => {
  // Selected: the pack folder.
  const msgs = await runModule(studioImportModuleSource({ port: 1, jobId: 'job-a' }), `${BUILD_PACK}\nreturn { vfx }`)
  assert.ok(msgs.some((m) => m === `${SEL_PROGRESS_TAG} 4/4 Trail`), msgs.filter((m) => !m.startsWith(SEL_DATA_TAG)).join('\n'))
  assert.equal(msgs.at(-1), 'forge-vfx-end nodes')
  const got = collectStudioImport(msgs)
  assert.equal(got?.kind, 'nodes')
  const studio = fakeStudio(() => msgs)
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfxselmod-svc-'))
  const svc = new VfxService({ userDir: join(dir, 'user'), projectRoot: () => null, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null } as never)
  const imp = new VfxImporter({ service: svc, bridge: () => studio.bridge })
  const scan = await imp.scanStudio()
  assert.deepEqual(
    scan.rows.map((r) => [r.name, r.origin]),
    [
      ['Slash', 'ReplicatedStorage.VFX.Slash'],
      ['Slash (2)', 'ReplicatedStorage.VFX.Slash'],
      ['Impact', 'ReplicatedStorage.VFX.Impact'],
      ['Trail', 'ReplicatedStorage.VFX.Trail']
    ]
  )
  // The values arrive in the importer's node format.
  const committed = await imp.commit({ scanId: scan.scanId, scope: 'user', rows: scan.rows.map((r) => ({ key: r.key, name: r.name })) })
  const slash2 = committed.added.find((e) => e.name === 'Slash (2)')!
  const em = slash2.effect!.roots[0].children[0].children[0].children[0]
  assert.equal(em.className, 'ParticleEmitter')
  assert.equal(em.props.Rate, 10)
  assert.deepEqual(em.props.Speed, [2, 4])
  assert.deepEqual(em.props.Size, [
    { t: 0, v: 1, e: 0.5 },
    { t: 1, v: 0 }
  ])
  assert.deepEqual((em.props.Color as { c: number[] }[])[0].c, [1, 0.5, 0])
  assert.equal(em.props.Texture, 'rbxassetid://555')
  assert.deepEqual(em.attrs, { EmitCount: 12 })
  assert.ok(slash2.effect!.cues.some((c) => c.action === 'emit' && c.count === 12), 'EmitCount drives the cues')
  assert.deepEqual((slash2.effect!.roots[0].children[0].props.CFrame as number[]).slice(0, 3), [2, 2, 3])
  const trail = committed.added.find((e) => e.name === 'Trail')!
  const tr = trail.effect!.roots[0].children.find((c) => c.className === 'Trail')!
  assert.ok(tr.props.Attachment0 && tr.props.Attachment0 === trail.effect!.roots[0].children.find((c) => c.name === 'A0')!.id, 'instance refs become node ids')
  assert.equal(committed.added.find((e) => e.name === 'Impact')!.effect!.roots[0].children.find((c) => c.className === 'Script')?.source, "print('héllo')")
  // Nothing selected: the VFX-like folders.
  const none = collectStudioImport(await runModule(studioImportModuleSource({ port: 1, jobId: 'job-b' }), `${BUILD_PACK}\nreturn {}`))
  assert.equal(none?.kind, 'packs')
  assert.deepEqual(
    (none as { packs: { fullName: string; effects: number; path: { name: string; index: number }[] }[] }).packs.map((p) => [p.fullName, p.effects]),
    [
      ['ReplicatedStorage.VFX', 4],
      ['Workspace.Effects', 3]
    ]
  )
  // The chosen folders, by path.
  const chosen = (none as { packs: { path: { name: string; index: number }[] }[] }).packs.map((p) => p.path)
  const byPath = collectStudioImport(await runModule(studioImportModuleSource({ port: 1, jobId: 'job-c', paths: chosen }), `${BUILD_PACK}\nreturn {}`))
  assert.equal(byPath?.kind, 'nodes')
  assert.deepEqual((byPath as { paths: string[] }).paths, ['ReplicatedStorage.VFX', 'Workspace.Effects'])
  // A path that is gone.
  const gone = collectStudioImport(await runModule(studioImportModuleSource({ port: 1, jobId: 'job-d', paths: [[{ name: 'Workspace', index: 0 }, { name: 'Nope', index: 9 }]] }), `${BUILD_PACK}\nreturn {}`))
  assert.deepEqual(gone, { kind: 'error', error: 'the chosen folders are no longer in the place' })
})
