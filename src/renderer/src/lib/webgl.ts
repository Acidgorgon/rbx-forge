// The message a 3D preview shows in place of its canvas when WebGL cannot start (no GPU, blocked
// driver, hardware acceleration off). three.js throws "THREE.WebGLRenderer: Error creating WebGL context."
export function webglMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const detail = raw.replace(/^THREE\.WebGLRenderer:\s*/, '').replace(/\.\s*$/, '').trim() || 'no WebGL context'
  return `3D preview needs WebGL: ${detail}. Check that hardware acceleration is on and the graphics driver is up to date; the rest of the lab still works.`
}
