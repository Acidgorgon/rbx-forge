// VFX Lab tags: auto-tags from evidence (layer roles, dominant colours, structure), grouped as
// KIND / ELEMENT / TIMING / CUSTOM, capped and ranked by confidence; older flat tags read into
// groups; user edits survive a re-tag; recipes per kind and per kind+element pair.
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { effectFromSpec, type VfxSpec } from '../src/shared/vfx/spec.ts'
import { AUTO_TAG_MAX, autoTagGroups, autoTags, changedGroups, classifyTag, groupsFromTags, inferTags, recipeKeys, retagGroups, tagEvidence, tagGroupsOf, words } from '../src/shared/vfx/tags.ts'
import { extractRecipe, extractRecipes, recipeMatches, recipeSkill, recipeTags } from '../src/shared/vfx/recipes.ts'
import type { VfxEffect, VfxEntry } from '../src/shared/vfx/types.ts'
import { tagFields, VfxService } from '../src/main/services/vfx/service.ts'

// A red / orange slash: a blade streak, flame flipbook, embers (name says nothing).
const FIRE_SLASH: VfxSpec = {
  name: 'Attack1',
  duration: 1,
  layers: [
    { name: 'SlashStreak', class: 'ParticleEmitter', props: { Color: ['#ff3010', '#ff8020'], Orientation: 'VelocityParallel', Speed: [0.2, 0.5], Size: [[0, 0], [0.2, 6], [1, 0]], LightEmission: 1, Lifetime: [0.2, 0.3] }, emit: [{ at: 0.05, count: 3 }] },
    { name: 'Flames', class: 'ParticleEmitter', props: { Color: ['#ffb000', '#ff2000'], FlipbookLayout: 'Grid4x4', FlipbookMode: 'OneShot', Acceleration: [0, 6, 0], Size: [[0, 1], [1, 3]], LightEmission: 0.8, Lifetime: [0.4, 0.6] }, emit: [{ at: 0.1, count: 20 }] },
    { name: 'Embers', class: 'ParticleEmitter', props: { Color: ['#ff6000'], Size: [[0, 0.3], [1, 0]], Speed: [10, 20], LightEmission: 1 }, emit: [{ at: 0.1, count: 30 }] }
  ]
}

// A blue lightning arc: thin bright beams named like bolts, cyan / white, a few sparks.
const LIGHTNING_ARC: VfxSpec = {
  name: 'Attack2',
  duration: 1,
  layers: [
    { name: 'Bolt', class: 'Beam', props: { Color: ['#60e0ff', '#ffffff'], Width0: 0.4, Width1: 0.3, LightEmission: 1, Brightness: 4 }, from: [0, 0, 0], to: [0, 0, -12] },
    { name: 'Bolt2', class: 'Beam', props: { Color: ['#80c0ff'], Width0: 0.3, Width1: 0.2, LightEmission: 1 }, from: [0, 1, 0], to: [2, 0, -12] },
    { name: 'Sparks', class: 'ParticleEmitter', props: { Color: ['#a0f0ff'], Size: [[0, 0.3], [1, 0]], Speed: [12, 20], LightEmission: 1 }, emit: [{ at: 0, count: 25 }] }
  ]
}

// A blue water splash: droplets and a splash ring.
const WATER_SPLASH: VfxSpec = {
  name: 'Attack3',
  duration: 1.2,
  layers: [
    { name: 'Droplets', class: 'ParticleEmitter', props: { Color: ['#2080ff', '#60c0ff'], Size: [[0, 0.4], [1, 0.1]], Speed: [10, 18], Acceleration: [0, -40, 0], LightEmission: 0.2 }, emit: [{ at: 0, count: 40 }] },
    { name: 'SplashRing', class: 'ParticleEmitter', props: { Color: ['#40a0ff'], Orientation: 'VelocityPerpendicular', Size: [[0, 1], [1, 8]], Speed: [0, 0], LightEmission: 0.3 }, emit: [{ at: 0, count: 1 }] }
  ]
}

// A purple aura that stays on.
const AURA: VfxSpec = {
  name: 'PowerUpAura',
  duration: 2,
  layers: [
    { name: 'Glow', class: 'ParticleEmitter', props: { Color: ['#a040ff'], Size: [[0, 3], [1, 4]], Speed: [0, 1], Rate: 20, LightEmission: 1 } },
    { name: 'Wisps', class: 'ParticleEmitter', props: { Color: ['#c060ff'], Size: [[0, 0.5], [1, 0]], Speed: [2, 4], Rate: 30, LightEmission: 1 } }
  ]
}

const groupsOf = (spec: VfxSpec, hint = '') => autoTagGroups(effectFromSpec(spec), hint).groups

test('tags: a red fire slash is slash + fire, never water or electric', () => {
  const effect = effectFromSpec(FIRE_SLASH)
  const g = autoTagGroups(effect).groups
  assert.deepEqual(g.kind, ['slash'])
  assert.deepEqual(g.element, ['fire'])
  assert.deepEqual(g.timing, ['burst'])
  const all = tagEvidence(effect)
  assert.ok(!all.some((x) => x.tag === 'water' || x.tag === 'electric'), all.map((x) => x.tag).join(','))
  // Every kept tag says why.
  const fire = inferTags(effect).find((x) => x.tag === 'fire')!
  assert.ok(fire.confidence >= 0.9)
  assert.match(fire.why, /orange \/ red \/ yellow/)
  assert.match(fire.why, /flipbook/)
})

test('tags: a blue lightning arc is electric (thin bright jagged beams), not fire or water', () => {
  const effect = effectFromSpec(LIGHTNING_ARC)
  const g = autoTagGroups(effect).groups
  assert.deepEqual(g.element, ['electric'])
  assert.ok(g.kind.includes('beam'))
  assert.ok(!autoTags(effect).some((t) => t === 'fire' || t === 'water'))
  assert.match(inferTags(effect).find((x) => x.tag === 'electric')!.why, /thin bright beams/)
  // Blue alone is not water, and blue sparks alone are not electric.
  const sparks: VfxSpec = { name: 'Attack4', layers: [{ name: 'Sparks', class: 'ParticleEmitter', props: { Color: ['#3070ff'], Size: [[0, 0.3], [1, 0]], Speed: [12, 20], LightEmission: 1 }, emit: [{ at: 0, count: 25 }] }] }
  const sg = groupsOf(sparks)
  assert.ok(!sg.element.includes('water') && !sg.element.includes('electric'), JSON.stringify(sg))
})

test('tags: water needs blue + droplet / splash layers; loops are auras; names are strong evidence; at most 4 tags', () => {
  const w = groupsOf(WATER_SPLASH)
  assert.deepEqual(w.element, ['water'])
  assert.ok(!w.element.includes('electric'))
  const a = groupsOf(AURA)
  assert.ok(a.kind.includes('aura'), JSON.stringify(a))
  assert.deepEqual(a.timing, ['loop'])
  // The name (or file name) says it.
  assert.deepEqual(groupsOf({ ...AURA, name: 'FrostNova' }).element, ['ice'])
  assert.ok(groupsOf(FIRE_SLASH, 'Explosion pack/Kaboom.rbxm').kind.includes('explosion'))
  for (const spec of [FIRE_SLASH, LIGHTNING_ARC, WATER_SPLASH, AURA, { ...FIRE_SLASH, name: 'FireSlashImpactExplosionDash' }]) {
    const tags = inferTags(effectFromSpec(spec), 'lightning water wind dark')
    assert.ok(tags.length <= AUTO_TAG_MAX, tags.map((t) => t.tag).join(','))
    const g = autoTagGroups(effectFromSpec(spec)).groups
    assert.ok(g.kind.length <= 2 && g.element.length <= 2 && g.timing.length <= 1)
    // Ranked by confidence.
    assert.deepEqual(
      tags.map((t) => t.confidence),
      [...tags.map((t) => t.confidence)].sort((x, y) => y - x)
    )
  }
  assert.deepEqual(words('AuraImpact_2 QuickDASHFx'), ['aura', 'impact', '2', 'quick', 'dash', 'fx'])
})

test('tag groups: older flat tags are read into groups (colours dropped, unknown kept as custom)', () => {
  assert.deepEqual(classifyTag('Lightning'), ['element', 'electric'])
  assert.deepEqual(classifyTag('holy'), ['element', 'light'])
  assert.deepEqual(classifyTag('red'), null)
  assert.deepEqual(classifyTag('burst'), ['kind', 'burst'])
  assert.deepEqual(groupsFromTags(['fire', 'slash', 'red', 'lightning', 'My Thing', 'ambient', 'startup']), { kind: ['slash', 'charge'], element: ['fire', 'electric'], timing: ['loop'], custom: ['my thing'] })
  const old = { tags: ['magic', 'impact', 'blue'] }
  assert.deepEqual(tagGroupsOf(old), { kind: ['impact'], element: ['energy'], timing: [], custom: [] })
  // Stored groups win over the flat list.
  assert.deepEqual(tagGroupsOf({ tags: ['x'], tagGroups: { kind: ['Dash'], custom: ['ball'] } }), { kind: ['dash'], element: [], timing: [], custom: ['ball'] })
  assert.deepEqual(recipeKeys({ tags: ['slash', 'impact', 'fire'] }), ['slash', 'impact', 'slash+fire', 'impact+fire'])
})

test('re-tag: auto groups are recomputed, groups the user edited and custom tags stay', () => {
  const current = { kind: ['impact'], element: ['fire'], timing: ['burst'], custom: ['boss'] }
  const auto = { kind: ['slash'], element: ['electric'], timing: ['loop'], custom: [] }
  assert.deepEqual(retagGroups(current, auto, ['kind']), { kind: ['impact'], element: ['electric'], timing: ['loop'], custom: ['boss'] })
  assert.deepEqual(retagGroups(current, auto), { kind: ['slash'], element: ['electric'], timing: ['loop'], custom: ['boss'] })
  assert.deepEqual(changedGroups(current, { ...current, element: ['fire'], kind: ['slash'] }), ['kind'])
  // tagFields: tags given by a spec merge in; edited groups on the previous entry stay.
  const effect = effectFromSpec(FIRE_SLASH)
  const t = tagFields(effect, '', ['goal', 'impact'])
  assert.deepEqual(t.tagGroups?.kind, ['impact', 'slash'])
  assert.deepEqual(t.tagGroups?.custom, ['goal'])
  assert.ok(t.autoTagInfo?.length)
  const kept = tagFields(effect, '', [], { tags: ['dash', 'water'], tagGroups: { kind: ['dash'], element: ['water'], timing: [], custom: [] }, userTagGroups: ['element'] })
  assert.deepEqual(kept.tagGroups?.element, ['water'])
  assert.deepEqual(kept.tagGroups?.kind, ['slash'])
  assert.deepEqual(kept.userTagGroups, ['element'])
})

test('service: tag edits mark the group as the user\'s; Re-tag library keeps them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfxtags-'))
  const svc = new VfxService({ userDir: join(dir, 'user'), projectRoot: () => null, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null } as never)
  const effect = effectFromSpec(FIRE_SLASH)
  const { entry } = await svc.addEffect(svc.store('user'), { name: 'Attack1', nodes: effect.roots }, { origin: 'Attack1.rbxm' })
  // Older entry: flat tags only, wrong ones.
  const legacy = await svc.store('user').save({ ...entry, tags: ['water', 'red', 'slash', 'mine'], tagGroups: undefined, userTagGroups: undefined, autoTagInfo: undefined })
  assert.deepEqual(tagGroupsOf(legacy), { kind: ['slash'], element: ['water'], timing: [], custom: ['mine'] })
  const edited = await svc.update(entry.id, { tagGroups: { kind: ['impact', 'Slash'] } })
  assert.deepEqual(edited.userTagGroups, ['kind'])
  assert.deepEqual(edited.tagGroups?.kind, ['impact', 'slash'])
  assert.ok(edited.tags.includes('impact') && edited.tags.includes('mine'))
  const r = await svc.retag()
  assert.equal(r.total, 1)
  assert.equal(r.changed, 1)
  const after = (await svc.list())[0]
  assert.deepEqual(after.tagGroups?.kind, ['impact', 'slash'], 'the user\'s kinds stay')
  assert.deepEqual(after.tagGroups?.element, ['fire'], 'the wrong old element is re-tagged')
  assert.deepEqual(after.tagGroups?.custom, ['mine'])
  assert.ok(!after.tags.includes('red') && !after.tags.includes('water'))
  assert.equal((await svc.retag()).changed, 0, 'a second re-tag changes nothing')
  // Flat tag edits (older callers) still work and are the user's too.
  const flat = await svc.update(entry.id, { tags: ['dash', 'wind'] })
  assert.deepEqual(flat.tagGroups, { kind: ['dash'], element: ['wind'], timing: [], custom: [] })
  assert.deepEqual([...(flat.userTagGroups ?? [])].sort(), ['custom', 'element', 'kind', 'timing'])
})

// ------------------------------------------------------------------ recipes

let n = 0
function entry(effect: VfxEffect, groups: { kind?: string[]; element?: string[]; custom?: string[] }, quality: VfxEntry['quality'] = 'reference'): VfxEntry {
  const tagGroups = { kind: groups.kind ?? [], element: groups.element ?? [], timing: [], custom: groups.custom ?? [] }
  return { id: `e${++n}`, scope: 'user', kind: 'model', name: `E${n}`, description: '', tags: [...tagGroups.kind, ...tagGroups.element, ...tagGroups.custom], tagGroups, createdAt: n, updatedAt: n, origin: 'x', effect, thumbs: [], quality }
}

test('recipes: per kind, and per kind+element pair once there are 2 examples', () => {
  const fire = effectFromSpec(FIRE_SLASH)
  const arc = effectFromSpec(LIGHTNING_ARC)
  const entries = [
    entry(fire, { kind: ['slash'], element: ['fire'] }),
    entry(fire, { kind: ['slash'], element: ['fire'], custom: ['boss'] }),
    entry(arc, { kind: ['slash'], element: ['electric'] }),
    entry(arc, { kind: ['beam'], element: ['electric'], custom: ['boss'] }),
    entry(arc, { kind: ['impact'] }, 'avoid'),
    // An older entry with flat tags.
    { ...entry(fire, {}), tags: ['slash', 'fire', 'red'], tagGroups: undefined }
  ]
  const keys = recipeTags(entries)
  assert.ok(keys.includes('slash'))
  assert.ok(keys.includes('beam'))
  assert.ok(keys.includes('slash+fire'))
  assert.ok(keys.includes('boss'), 'custom tags with 2 examples')
  assert.ok(!keys.includes('slash+electric'), 'a pair needs 2 examples')
  assert.ok(!keys.includes('fire') && !keys.includes('electric'), 'elements alone are not effect types')
  assert.ok(!keys.includes('red'))
  assert.ok(!keys.includes('impact'), 'avoid-only tags make no recipe')
  assert.equal(keys[0], 'slash')
  assert.ok(recipeMatches(entries[5], 'slash+fire'))
  assert.ok(!recipeMatches(entries[2], 'slash+fire'))
  const pair = extractRecipe('slash+fire', entries)!
  assert.equal(pair.samples, 3)
  assert.equal(extractRecipe('slash', entries)!.samples, 4)
  assert.equal(recipeSkill(pair).name, 'vfx-recipe-slash-fire')
  assert.deepEqual(
    extractRecipes(entries, 2).map((r) => r.tag),
    keys.filter((k) => extractRecipe(k, entries)!.samples >= 2)
  )
})
