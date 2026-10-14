// errorText: the IPC wrapper Electron adds to errors thrown in main is not shown to the user.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { errorText } from '../src/renderer/src/lib/format.ts'

test('errorText strips the IPC prefix and the error class name', () => {
  const e = new Error("Error invoking remote method 'harness:animCompose': Error: Animation scripts run in Lune, which is not available")
  assert.equal(errorText(e), 'Animation scripts run in Lune, which is not available')
  assert.equal(errorText(new Error("Error invoking remote method 'harness:vfxRefine': VfxError: no VFX entry \"x\"")), 'no VFX entry "x"')
})

test('errorText keeps plain messages and non-errors', () => {
  assert.equal(errorText(new Error('the timeline did not compile')), 'the timeline did not compile')
  assert.equal(errorText('offline'), 'offline')
  assert.equal(errorText(new Error('line 3: TypeError-ish text stays')), 'line 3: TypeError-ish text stays')
})
