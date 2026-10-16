// VFX Lab names from tags: imported effects ("Particles", "Effect3") are named from their tags
// ("Lightning Beam") with the original kept as sourceName (searched, matched by Make, used by
// re-import); the import review offers both names; "Name from tags" renames library entries in
// bulk (names chosen on purpose stay unless generic); layers inside are never renamed.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { allNodes } from '../src/shared/vfx/analyze.ts'
import { writeRbxmx } from '../src/shared/vfx/rbxmx.ts'
import { nearestEffects } from '../src/shared/vfx/retrieve.ts'
import { effectFromSpec, type VfxSpec } from '../src/shared/vfx/spec.ts'
import { baseName, isGenericName, nameFromTags, uniqueName } from '../src/shared/vfx/tags.ts'
import type { VfxEntry, VfxNode } from '../src/shared/vfx/types.ts'
import { VfxImporter } from '../src/main/services/vfx/importer.ts'
import { effectNameFor, VfxService } from '../src/main/services/vfx/service.ts'

const g = (kind: string[] = [], element: string[] = [], timing: string[] = [], custom: string[] = []) => ({ kind, element, timing, custom })

// Thin bright cyan beams named like bolts, a flash and sparks: tagged electric + beam.
const lightningSpec = (k = 0): VfxSpec => ({
  name: 'X',
  duration: 1,
  layers: [
    { name: 'Bolt', class: 'Beam', props: { Color: ['#60e0ff', '#ffffff'], Width0: 0.4 + k / 100, Width1: 0.3, LightEmission: 1, Brightness: 4 }, from: [0, 0, 0], to: [0, 0, -12] },
    { name: 'Bolt2', class: 'Beam', props: { Color: ['#80c0ff'], Width0: 0.3, Width1: 0.2, LightEmission: 1 }, from: [0, 1, 0], to: [2, 0, -12] },
    { name: 'Flash', class: 'ParticleEmitter', props: { Color: ['#ffffff'], Size: [[0, 4], [1, 6]], Speed: [0, 0], LightEmission: 1, Lifetime: [0.1, 0.15] }, emit: [{ at: 0, count: 1 }] },
    { name: 'Sparks', class: 'ParticleEmitter', props: { Color: ['#a0f0ff'], Size: [[0, 0.3], [1, 0]], Speed: [12, 20], LightEmission: 1 }, emit: [{ at: 0, count: 25 }] }
  ]
})
const LIGHTNING = lightningSpec()
// The effect Model as it comes out of a file / Studio, under a given name (k: a slightly different
// beam, so the effects are not duplicates of each other).
const lightningModel = (name: string, k = 0): VfxNode => ({ ...effectFromSpec(lightningSpec(k)).roots[0], name })
// An orange one-shot with nothing to name it by (only a timing tag).
const plainModel = (name: string, rate = 20): VfxNode => ({
  id: `p-${name}-${rate}`,
  className: 'Model',
  name,
  props: {},
  children: [{ id: `pp-${name}-${rate}`, className: 'Part', name: 'Root', props: { Transparency: 1, Size: [1, 1, 1] }, children: [{ id: `pa-${name}-${rate}`, className: 'Attachment', name: 'At', props: {}, children: [{ id: `pe-${name}-${rate}`, className: 'ParticleEmitter', name: 'Glow', props: { Rate: 0, Lifetime: [rate / 100, rate / 100 + 0.5], Color: [{ t: 0, c: [1, 0.5, 0.1] }, { t: 1, c: [1, 0.5, 0.1] }], LightEmission: 0.2 }, children: [] }] }] }]
})

function service(dir: string, on = true) {
  let setting = on
  const svc = new VfxService({ userDir: join(dir, 'user'), projectRoot: () => null, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null, nameFromTags: { get: () => setting, set: (v: boolean) => (setting = v) } } as never)
  return svc
}

const layerNames = (e: VfxEntry) => allNodes(e.effect!.roots).map((n) => n.name)

// ------------------------------------------------------------------ nameFromTags

test('nameFromTags: element display word, then the kind; short Title Case; fallback without usable tags', () => {
  assert.equal(nameFromTags(g(['impact'], ['electric']), 'Particles'), 'Lightning Impact')
  assert.equal(nameFromTags(g(['slash'], ['fire'], ['burst']), 'X'), 'Fire Slash')
  assert.equal(nameFromTags(g(['burst'], ['light']), 'X'), 'Holy Burst')
  assert.equal(nameFromTags(g(['aura'], ['dark']), 'X'), 'Shadow Aura')
  assert.equal(nameFromTags(g(['ground-crack', 'impact'], ['earth']), 'X'), 'Earth Ground Crack')
  // One kind with an element; up to two without one.
  assert.equal(nameFromTags(g(['slash', 'trail'], ['ice']), 'X'), 'Ice Slash')
  assert.equal(nameFromTags(g(['aura', 'impact']), 'X'), 'Aura Impact')
  assert.equal(nameFromTags(g(['ground-crack', 'shockwave']), 'X'), 'Ground Crack Shockwave')
  assert.equal(nameFromTags(g(['ground-crack', 'trail', 'impact']), 'X'), 'Ground Crack Trail')
  // Element alone ("renames to like lightning").
  assert.equal(nameFromTags(g([], ['electric'], ['loop']), 'Particles'), 'Lightning')
  // A custom tag when there is no element or kind.
  assert.equal(nameFromTags(g([], [], ['burst'], ['ball trail', 'goal']), 'Part'), 'Ball Trail')
  assert.equal(nameFromTags(g([], [], [], ['a very long custom tag name']), 'Part'), 'A Very Long')
  // Timing alone, or nothing: the original name.
  assert.equal(nameFromTags(g([], [], ['burst']), 'Attachment'), 'Attachment')
  assert.equal(nameFromTags(g(), 'VFX'), 'VFX')
  assert.equal(nameFromTags(null, 'Effect3'), 'Effect3')
  // Tags the user typed in odd case or outside the lists still read.
  assert.equal(nameFromTags({ kind: ['IMPACT'], element: ['Electric'] }, 'X'), 'Lightning Impact')
  assert.equal(nameFromTags(g(['spin-attack'], ['poison']), 'X'), 'Poison Spin Attack')
  for (const n of [nameFromTags(g(['ground-crack'], ['electric'])), nameFromTags(g(['ground-crack', 'charge']))]) assert.ok(n.split(' ').length <= 3, n)
})

test('uniqueName / baseName / isGenericName', () => {
  const used = new Set(['lightning impact', 'lightning impact (2)'])
  assert.equal(uniqueName('Lightning Impact', used), 'Lightning Impact (3)')
  assert.equal(uniqueName('Fire Slash', used), 'Fire Slash')
  assert.equal(uniqueName('Fire Slash', used), 'Fire Slash (2)')
  assert.equal(baseName('Fire Slash (12)'), 'Fire Slash')
  assert.equal(baseName('Fire Slash'), 'Fire Slash')
  for (const n of ['Particles', 'ParticleEmitter', 'Attachment', 'Part', 'VFX', 'Effect3', 'Model (2)', 'Copy of FX', 'Particle 2']) assert.ok(isGenericName(n), n)
  for (const n of ['HollowPurple', 'Hollow Purple', 'FireSlash', 'Quick Dash', 'Barrage']) assert.ok(!isGenericName(n), n)
  assert.equal(effectNameFor('Lightning Impact (2)'), 'LightningImpact2')
  assert.equal(effectNameFor('Particles (2)', 'Particles (2)'), 'Particles (2)')
})

// ------------------------------------------------------------------ import

test('import review: rows carry a unique tag name; commit names entries from tags, keeps the original, never renames layers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfxnames-'))
  const svc = service(dir)
  // Already in the library: an effect called "Lightning Beam".
  await writeFile(join(dir, 'Lightning Beam.rbxmx'), writeRbxmx([plainModel('Lightning Beam', 3)]))
  assert.equal((await svc.import([join(dir, 'Lightning Beam.rbxmx')], 'user')).added[0].name, 'Lightning Beam')
  const pack: VfxNode = { id: 'pack', className: 'Folder', name: 'VFX', props: {}, children: [lightningModel('Particles'), lightningModel('Effect3', 1), lightningModel('Zap', 2), plainModel('Extra1', 41), plainModel('Attachment', 42)] }
  await writeFile(join(dir, 'Pack.rbxmx'), writeRbxmx([pack]))
  const imp = new VfxImporter({ service: svc })
  const scan = await imp.scanFiles([join(dir, 'Pack.rbxmx')])
  assert.equal(scan.nameFromTags, true)
  const row = (n: string) => scan.rows.find((r) => r.name === n)!
  // Unique against the library ("Lightning Beam" is taken) and within the scan.
  assert.deepEqual([row('Particles').tagName, row('Effect3').tagName, row('Zap').tagName], ['Lightning Beam (2)', 'Lightning Beam (3)', 'Lightning Beam (4)'])
  // Nothing to name it by: no tag name.
  assert.equal(row('Extra1').tagName, undefined)
  assert.equal(row('Attachment').tagName, undefined)
  // Commit: tag name, the user's own name, the original name.
  const res = await imp.commit({
    scanId: scan.scanId,
    scope: 'user',
    rows: [
      { key: row('Particles').key, name: row('Particles').tagName! },
      { key: row('Effect3').key, name: 'Storm Call' },
      { key: row('Zap').key, name: 'Zap' },
      { key: row('Extra1').key, name: 'Extra1' }
    ]
  })
  const [tagged, user, kept, plain] = res.added
  assert.equal(tagged.name, 'Lightning Beam (2)')
  assert.equal(tagged.sourceName, 'Particles')
  assert.equal(tagged.nameFrom, 'tags')
  assert.deepEqual(tagged.tagGroups?.element, ['electric'])
  // The effect's own name follows (module / Studio instance); layers keep theirs, the Model too.
  assert.equal(tagged.effect!.name, 'LightningBeam2')
  assert.equal(tagged.effect!.roots[0].name, 'Particles')
  assert.ok(['Bolt', 'Bolt2', 'Flash', 'Sparks'].every((n) => layerNames(tagged).includes(n)))
  assert.equal(user.name, 'Storm Call')
  assert.equal(user.sourceName, 'Effect3')
  assert.equal(user.nameFrom, 'user')
  assert.equal(kept.name, 'Zap')
  assert.equal(kept.sourceName, undefined)
  assert.equal(kept.nameFrom, undefined)
  assert.equal(plain.name, 'Extra1')
  // The original name stays searchable.
  assert.deepEqual((await svc.search('particles')).map((e) => e.id), [tagged.id])
  assert.deepEqual((await svc.search('effect3')).map((e) => e.id), [user.id])
  // Re-import finds the effect in its stored file by its original name and keeps the name.
  const re = await svc.reimport(tagged.id)
  assert.equal(re.name, 'Lightning Beam (2)')
  assert.equal(re.effect!.name, 'LightningBeam2')
  assert.equal(re.stats?.beams, 2)
  // Setting off: the review starts with original names (rows still offer the tag name).
  svc.setNamesFromTags(false)
  const off = await imp.scanFiles([join(dir, 'Pack.rbxmx')])
  assert.equal(off.nameFromTags, false)
  assert.ok(off.rows.find((r) => r.name === 'Particles')!.tagName)
})

test('import (files at once): named from tags with the setting on, original names with it off', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfxnames2-'))
  await writeFile(join(dir, 'Particles.rbxmx'), writeRbxmx([lightningModel('Particles')]))
  await writeFile(join(dir, 'Attachment.rbxmx'), writeRbxmx([plainModel('Attachment')]))
  const on = service(join(dir, 'on'))
  const a = (await on.import([dir], 'user')).added
  assert.deepEqual(a.map((e) => e.name).sort(), ['Attachment', 'Lightning Beam'])
  assert.equal(a.find((e) => e.name === 'Lightning Beam')!.sourceName, 'Particles')
  const off = service(join(dir, 'off'), false)
  const b = (await off.import([dir], 'user')).added
  assert.deepEqual(b.map((e) => e.name).sort(), ['Attachment', 'Particles'])
  assert.ok(b.every((e) => e.sourceName === undefined && e.nameFrom === undefined))
  // Make still finds an effect by its original name ("make particles but red").
  assert.ok(nearestEffects('particles but red', a)[0]?.nameMatch)
})

// ------------------------------------------------------------------ library actions

test('Name from tags: bulk renames imported effects, leaves names chosen on purpose unless generic; force; rename and back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfxnames3-'))
  const svc = service(dir, false)
  for (const n of ['Particles', 'Effect3', 'HollowStorm', 'Mine']) await writeFile(join(dir, `${n}.rbxmx`), writeRbxmx([lightningModel(n, n.length)]))
  await writeFile(join(dir, 'Attachment.rbxmx'), writeRbxmx([plainModel('Attachment')]))
  const added = (await svc.import([dir], 'user')).added
  const byName = (n: string) => added.find((e) => e.name === n)!
  // The user renamed one; a built-in example is in the library too.
  const mine = await svc.update(byName('Mine').id, { name: 'My Storm' })
  assert.equal(mine.nameFrom, 'user')
  assert.equal(mine.sourceName, 'Mine')
  assert.equal(mine.effect!.name, 'MyStorm')
  const example = await svc.addExample('hollow-purple')
  const r = await svc.renameFromTags(null)
  // Every imported model: Particles, Effect3, HollowStorm renamed; "My Storm" kept; Attachment has no tags to name by.
  assert.deepEqual(r.renamed.map((e) => e.name).sort(), ['Lightning Beam', 'Lightning Beam (2)', 'Lightning Beam (3)'])
  assert.deepEqual({ kept: r.kept, noTags: r.noTags, unchanged: r.unchanged, total: r.total }, { kept: 1, noTags: 1, unchanged: 0, total: 5 })
  assert.ok(r.renamed.every((e) => e.nameFrom === 'tags' && e.sourceName && /^LightningBeam\d?$/.test(e.effect!.name)))
  assert.ok(r.renamed.every((e) => layerNames(e).includes('Bolt')))
  // Again: already named so.
  assert.equal((await svc.renameFromTags(null)).unchanged, 3)
  // Selected entries: the example (a name chosen on purpose) and the user's name stay, unless forced.
  const sel = await svc.renameFromTags([example.id, mine.id])
  assert.equal(sel.renamed.length, 0)
  assert.equal(sel.kept, 2)
  assert.equal((await svc.get(example.id)).name, example.name)
  const forced = await svc.renameFromTags([mine.id], { force: true })
  assert.equal(forced.renamed[0].name, 'Lightning Beam (4)')
  assert.equal(forced.renamed[0].sourceName, 'Mine')
  // A generic name is renamed even when chosen by the user.
  const generic = await svc.update(byName('Attachment').id, { name: 'Particles 2', tagGroups: { kind: ['burst'], element: ['fire'] } })
  assert.equal(generic.nameFrom, 'user')
  assert.equal((await svc.renameFromTags([generic.id])).renamed[0]?.name, 'Fire Burst')
  // Back to the original name: no longer a rename.
  const back = await svc.update(forced.renamed[0].id, { name: 'Mine' })
  assert.equal(back.name, 'Mine')
  assert.equal(back.sourceName, undefined)
  assert.equal(back.nameFrom, undefined)
  assert.equal(back.effect!.name, 'Mine')
  // Effect edits from an editor that still has the old name keep the entry's effect name.
  const tagged = r.renamed[0]
  const edited = await svc.update(tagged.id, { effect: { ...tagged.effect!, name: 'Particles', duration: 2 } })
  assert.equal(edited.effect!.name, tagged.effect!.name)
  assert.equal(edited.effect!.duration, 2)
})

test('re-tag: entries named from tags follow new tags (setting on); renamed ones and edited tags do not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfxnames4-'))
  const svc = service(dir)
  for (const n of ['Particles', 'Effect3', 'Effect4']) await writeFile(join(dir, `${n}.rbxmx`), writeRbxmx([lightningModel(n, n.length + Number(n.slice(-1) === '4'))]))
  const added = (await svc.import([dir], 'user')).added
  assert.ok(added.every((e) => e.nameFrom === 'tags'))
  const [a, b, c] = ['Particles', 'Effect3', 'Effect4'].map((n) => added.find((e) => e.sourceName === n)!)
  // Simulate entries tagged by an older tagger (auto groups only).
  const store = svc.store('user')
  await store.save({ ...a, tagGroups: { kind: ['slash'], element: ['fire'], timing: ['burst'], custom: [] }, tags: ['slash', 'fire', 'burst'], name: 'Fire Slash' })
  // b: the user edited its element (only the explicit action renames after that).
  await svc.update(b.id, { tagGroups: { element: ['ice'] } })
  // c: renamed by the user.
  await svc.update(c.id, { name: 'Storm' })
  const r = await svc.retag()
  assert.equal(r.renamed, 1)
  const after = await svc.get(a.id)
  assert.match(after.name, /^Lightning Beam/)
  assert.equal(after.sourceName, 'Particles')
  // The tag name is no evidence for the tags: the original name and the layers are.
  assert.deepEqual(after.tagGroups?.element, ['electric'])
  assert.equal((await svc.get(b.id)).name, b.name)
  assert.equal((await svc.get(c.id)).name, 'Storm')
  // The explicit action names b from its edited tags.
  assert.equal((await svc.renameFromTags([b.id])).renamed[0].name, 'Ice Beam')
})

// ------------------------------------------------------------------ Make finds renamed effects

test('retrieve: the original name of a renamed entry counts for nameMatch like its name ("hollow purple")', () => {
  const effect = effectFromSpec(LIGHTNING)
  const base = { scope: 'user', kind: 'model', description: '', tags: ['beam', 'electric'], tagGroups: { kind: ['beam'], element: ['electric'], timing: [], custom: [] }, createdAt: 1, updatedAt: 1, origin: 'pack.rbxm', thumbs: [], effect } as unknown as VfxEntry
  const renamed: VfxEntry = { ...base, id: 'r', name: 'Energy Beam', sourceName: 'HollowPurple', nameFrom: 'tags' }
  const plain: VfxEntry = { ...base, id: 'p', name: 'HollowPurple' }
  const other: VfxEntry = { ...base, id: 'o', name: 'Lightning Beam' }
  for (const e of [renamed, plain]) {
    const m = nearestEffects('make hollow purple but red', [other, e])
    assert.equal(m[0].entry.id, e.id)
    assert.equal(m[0].nameMatch, true)
    assert.equal(m.find((x) => x.entry.id === 'o')?.nameMatch ?? false, false)
  }
  // Same score either way: the original name weighs exactly like the name.
  assert.equal(nearestEffects('hollow purple', [renamed])[0].score, nearestEffects('hollow purple', [plain])[0].score)
})
