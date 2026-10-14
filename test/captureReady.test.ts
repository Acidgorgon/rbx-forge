// Capture setup scripts wait for the capture page's window.__xCapture API (installed after an async
// import + React effect) instead of calling it straight after loadURL.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureSetup, waitForGlobalScript } from '../src/main/services/capture/ready.ts'

// Evaluates a script the way executeJavaScript would, against a fake window.
function run(script: string, window: Record<string, unknown>): Promise<unknown> {
  return new Function('window', `return ${script}`)(window) as Promise<unknown>
}

test('captureSetup waits for a global that appears late, then calls it', async () => {
  const win: Record<string, unknown> = {}
  setTimeout(() => (win.__vfxCapture = { load: async (x: number) => x * 2 }), 80)
  assert.equal(await run(captureSetup('__vfxCapture', 'window.__vfxCapture.load(21)'), win), 42)
})

test('captureSetup fails with a clear message when the page never installs its API', async () => {
  await assert.rejects(run(captureSetup('__animCapture', 'window.__animCapture.load()', 100), {}), /capture view did not load \(window\.__animCapture missing/)
})

test('waitForGlobalScript only takes identifiers', () => {
  assert.throws(() => waitForGlobalScript('x; alert(1)'))
  assert.match(waitForGlobalScript('__abilityCapture', 50), /__abilityCapture/)
})
