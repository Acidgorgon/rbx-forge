// The offline VFX Make benchmark (test/vfxEval, npm run eval:vfx) held to a floor: the grounded
// pipeline must beat the old draft on the same prompts and library, by code metrics only.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findLune, findRuntimeDir } from '../src/main/services/tests/lune.ts'
import { formatReport, runEval } from './vfxEval/eval.ts'

const lune = process.env.LUNE_PATH || findLune()
const runtimeDir = findRuntimeDir()

test('VFX benchmark: grounded Make beats the old draft on realism, texture reuse and timing', async () => {
  const r = await runEval({ lune: lune && runtimeDir ? { lune, runtimeDir } : null })
  const text = formatReport(r)
  const { before, after, pick3 } = r.mean
  assert.ok(after.overall >= before.overall + 1, text)
  assert.ok(after.realism > before.realism, text)
  assert.ok(after.textureReuse >= 0.9 && after.textureReuse > before.textureReuse, text)
  assert.ok(after.timing >= before.timing, text)
  assert.ok(pick3.overall >= after.overall - 0.2, text)
  // Every prompt is at least as good as before.
  for (const row of r.rows) assert.ok(row.after.overall >= row.before.overall, `${row.prompt}: ${row.before.overall} -> ${row.after.overall}`)
  // The closest effect removed from the library: still better (it generalises to the next one).
  assert.ok(r.heldOut.after.overall > r.heldOut.before.overall, text)
  // Variations: the code pick never keeps a worse one than the average.
  assert.ok(r.fakeModelPick.chosen >= r.fakeModelPick.meanOfVariations, text)
  if (r.sequences) {
    assert.ok(r.sequences.prompts >= 10, text)
    assert.ok(r.sequences.after.overall > r.sequences.before.overall + 1, text)
    assert.ok(r.sequences.after.textureReuse > r.sequences.before.textureReuse, text)
  }
})
