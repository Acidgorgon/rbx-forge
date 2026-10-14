// Capture pages (?vfx-capture=1, ?anim-capture=1, ?ability-capture=1) install their window.__xCapture
// API from a React effect, after a dynamic import that is still in flight when loadURL resolves. A
// setup script must wait for that global before calling it. No Electron imports (tested directly).

// JS (an expression) that resolves once window[name] exists, or rejects with a clear message.
export function waitForGlobalScript(name: string, timeoutMs = 10_000): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`bad global name ${name}`)
  const tries = Math.max(1, Math.ceil(timeoutMs / 25))
  return `(async () => {
      for (let i = 0; i < ${tries} && !window.${name}; i++) await new Promise((r) => setTimeout(r, 25))
      if (!window.${name}) throw new Error('the capture view did not load (window.${name} missing; is WebGL available?)')
      return true
    })()`
}

// The setup script for a capture page whose API lives at window[name]: wait for it, then run `call`.
export function captureSetup(name: string, call: string, timeoutMs = 10_000): string {
  return `(async () => { await ${waitForGlobalScript(name, timeoutMs)}; return ${call} })()`
}
