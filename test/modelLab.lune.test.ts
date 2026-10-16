// Model Lab with the real lune binary: the three template scripts build in the preview sandbox
// (resources/lune/model_build.luau) on the real BlockyKit, rigged in one assembly under the part
// budget, and script errors come back with their build line. Uses $LUNE_PATH, else lune on the
// rokit/PATH lookup; skips with a message when neither exists.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findLune } from '../src/main/services/tests/lune.ts'
import { findModelAssets, luneModelBuild } from '../src/main/services/model/lune.ts'
import { partBounds, visibleParts } from '../src/shared/model/frame.ts'
import { PART_BUDGET } from '../src/shared/model/prompt.ts'

const ROOT = resolve(import.meta.dirname, '..')
const lune = findLune(process.env.LUNE_PATH || null)
const skip = lune ? false : 'lune not found (set LUNE_PATH or `rokit add --global lune-org/lune`); skipping Model Lab Lune tests'
if (!lune) console.log(`# ${skip}`)
const assets = findModelAssets([join(ROOT, 'resources/lune')])!
const template = (id: string) => readFileSync(join(assets.templates, `${id}.luau`), 'utf8')
const build = (script: string, name = 'Test', timeoutMs?: number) => luneModelBuild(script, { lune: lune!, assets, name, ...(timeoutMs ? { timeoutMs } : {}) })

for (const id of ['creature', 'guard', 'egg']) {
  test(`the ${id} template builds a rigged block model under the part budget`, { skip }, async () => {
    const b = await build(template(id), id)
    assert.equal(b.ok, true, b.error?.message)
    assert.equal(b.name, id)
    assert.ok(b.parts.length > 150 && b.parts.length < PART_BUDGET, `${b.parts.length} parts`)
    assert.deepEqual(b.warnings, [])
    const s = b.stats!
    assert.equal(s.loose, 0, 'every part is welded to the rig')
    assert.equal(s.assemblies, 1)
    assert.ok(s.primaryPart, 'PrimaryPart is set')
    assert.equal(s.anchored, 1, 'only the root is anchored')
    // Creatures and guards are rigged (Motor6Ds + AnimationController / Animator); an egg is a static prop.
    if (id !== 'egg') {
      assert.ok(s.motors >= 2, `${s.motors} Motor6Ds`)
      assert.ok(s.animators >= 1 && s.animationControllers >= 1)
    }
    // The model stands near the origin in model-local studs.
    const bb = partBounds(visibleParts(b.parts))!
    assert.ok(bb.min[1] > -1 && bb.min[1] < 2, `floor at ${bb.min[1]}`)
    assert.ok(Math.abs((bb.min[0] + bb.max[0]) / 2) < 1.5, 'centred on X (symmetric)')
    // Several colours: the plates are shaded, not one flat colour.
    assert.ok(new Set(b.parts.map((p) => p.c.map((c) => Math.round(c * 40)).join())).size > 12)
    assert.ok(b.ms !== undefined)
  })
}

test('the creature faces -Z: its eyes are at the front', { skip }, async () => {
  const b = await build(template('creature'))
  const eyes = b.parts.filter((p) => /eye/i.test(p.n))
  assert.ok(eyes.length >= 2, 'eyes are named')
  const bb = partBounds(visibleParts(b.parts))!
  const mid = (bb.min[2] + bb.max[2]) / 2
  for (const e of eyes) assert.ok(e.cf[2] < mid, 'eye in the front half')
})

test('script errors come back with their line; the sandbox has no game or workspace', { skip }, async () => {
  const runtime = await build('local Kit = require(script.Parent.BlockyKit)\nreturn function(model, ctx)\n\tlocal kit = Kit.new(model, ctx.origin, 1)\n\tlocal x = nil\n\tprint(x.y)\nend\n')
  assert.equal(runtime.ok, false)
  assert.equal(runtime.error?.line, 5)
  assert.match(runtime.error!.message, /index nil/)
  const syntax = await build('return function(model, ctx)\n\tlocal = 1\nend\n')
  assert.equal(syntax.ok, false)
  assert.equal(syntax.error?.line, 2)
  const world = await build('return function(model, ctx)\n\tworkspace.Gravity = 0\nend\n')
  assert.equal(world.ok, false)
  assert.match(world.error!.message, /workspace/)
  const shape = await build('return 5\n')
  assert.equal(shape.ok, false)
  assert.match(shape.error!.message, /return function\(model, ctx\)/)
})

test('prints are kept and an endless loop times out', { skip }, async () => {
  const printed = await build('local Kit = require(script.Parent.BlockyKit)\nreturn function(model, ctx)\n\tprint("hello", 3)\n\tlocal kit = Kit.new(model, ctx.origin, 1)\n\tkit:part("Box", Vector3.new(1, 1, 1), CFrame.new(0, 0.5, 0), Color3.new(1, 0, 0))\nend\n')
  assert.equal(printed.ok, true, printed.error?.message)
  assert.deepEqual(printed.prints, ['hello\t3'])
  assert.equal(printed.parts.length, 1)
  const loop = await build('return function(model, ctx)\n\twhile true do end\nend\n', 'Loop', 1500)
  assert.equal(loop.ok, false)
  assert.match(loop.error!.message, /more than 2 s/)
})
