// The in-preview message when WebGL cannot start (VFX / Animation / Ability previews, compare panes).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webglMessage } from '../src/renderer/src/lib/webgl.ts'

test('webglMessage: names WebGL, keeps the reason without three.js prefix, says what to do', () => {
  const m = webglMessage(new Error('THREE.WebGLRenderer: Error creating WebGL context.'))
  assert.match(m, /^3D preview needs WebGL: Error creating WebGL context\. /)
  assert.match(m, /hardware acceleration/)
  assert.match(webglMessage(undefined), /^3D preview needs WebGL: no WebGL context\./)
  assert.match(webglMessage('context lost'), /^3D preview needs WebGL: context lost\./)
})
