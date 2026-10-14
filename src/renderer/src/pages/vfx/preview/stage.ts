// The look around an effect in the VFX Lab and Ability Composer previews, and how the frame reaches
// the screen.
//
// Output: the scene renders into a half-float (linear) target, so additive particles, beams and Neon
// add up in linear light like Roblox's renderer instead of in 8-bit sRGB (where two half-bright
// sprites already clip to white). A final pass applies a soft highlight shoulder (values below ~0.75
// are untouched; overbright stacks roll off instead of clipping) and encodes sRGB. Colours from
// Roblox properties are sRGB: shaders and materials convert them to linear (srgbColor / the GLSL
// toLinear below); textures are marked sRGB so the GPU decodes them.
//
// Stages: 'dark' and 'grey' (the Lab's neutral backdrops with a grid), and 'studio', which mimics a
// default Roblox Studio baseplate: blue-grey sky with horizon haze, grey baseplate with the studs
// grid, the default Lighting (ClockTime 14.5 sun, ambient, a little distance fog) and neutral
// exposure, so an imported effect looks the way it did in Studio.

import * as THREE from 'three'

export type Background = 'dark' | 'grey' | 'studio'
export const BACKGROUNDS: Background[] = ['studio', 'dark', 'grey']

// sRGB 0..1 (or 0xRRGGBB) -> a linear THREE.Color.
export function srgbColor(r: number | [number, number, number], g?: number, b?: number): THREE.Color {
  const c = typeof r === 'number' && g === undefined ? new THREE.Color(r) : new THREE.Color(r as number, g ?? 0, b ?? 0)
  if (Array.isArray(r)) c.setRGB(r[0], r[1], r[2])
  return c.convertSRGBToLinear()
}

export function setSrgb(c: THREE.Color, r: number, g: number, b: number): THREE.Color {
  return c.setRGB(r, g, b).convertSRGBToLinear()
}

// GLSL: sRGB -> linear for colours that arrive as Roblox values.
export const TO_LINEAR = /* glsl */ `
vec3 toLinear(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
`

const OUT_FS = /* glsl */ `
uniform sampler2D tex;
uniform float exposure;
varying vec2 vUv;
vec3 shoulder(vec3 c) {
  const float k = 0.75;
  vec3 over = max(c - k, vec3(0.0));
  return min(c, vec3(k)) + (1.0 - k) * (1.0 - exp(-over / (1.0 - k)));
}
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
void main() {
  vec4 t = texture2D(tex, vUv);
  gl_FragColor = vec4(toSrgb(shoulder(t.rgb * exposure)), 1.0);
}
`

export { outputCurve } from '@shared/vfx/light'

export class LinearOutput {
  private target: THREE.WebGLRenderTarget
  private quad: THREE.Mesh
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private renderer: THREE.WebGLRenderer
  exposure = 1

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer
    this.target = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true })
    const mat = new THREE.ShaderMaterial({
      uniforms: { tex: { value: this.target.texture }, exposure: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: OUT_FS,
      depthTest: false,
      depthWrite: false
    })
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    if (this.target.width !== size.x || this.target.height !== size.y) this.target.setSize(Math.max(1, size.x), Math.max(1, size.y))
    ;(this.quad.material as THREE.ShaderMaterial).uniforms.exposure.value = this.exposure
    this.renderer.setRenderTarget(this.target)
    this.renderer.render(scene, camera)
    this.renderer.setRenderTarget(null)
    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.target.dispose()
    this.quad.geometry.dispose()
    ;(this.quad.material as THREE.Material).dispose()
  }
}

// The Studio baseplate texture: grey with lighter lines every 4 studs (one tile = 8 studs).
function baseplateTexture(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  g.fillStyle = '#6b6c6e'
  g.fillRect(0, 0, 128, 128)
  g.fillStyle = '#727375'
  g.fillRect(0, 0, 64, 64)
  g.fillRect(64, 64, 64, 64)
  g.strokeStyle = 'rgba(255,255,255,0.16)'
  g.lineWidth = 2
  for (const x of [1, 64]) {
    g.beginPath()
    g.moveTo(x, 0)
    g.lineTo(x, 128)
    g.moveTo(0, x)
    g.lineTo(128, x)
    g.stroke()
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

// Sky dome: zenith blue-grey to a hazy horizon (Studio's default sky with Atmosphere off).
function skyDome(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { top: { value: srgbColor(0x5f8fc7) }, horizon: { value: srgbColor(0xc9d6e3) }, ground: { value: srgbColor(0x8d949b) } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; varying vec3 vDir;
void main() { float y = vDir.y; vec3 c = y > 0.0 ? mix(horizon, top, pow(clamp(y, 0.0, 1.0), 0.55)) : mix(horizon, ground, clamp(-y * 6.0, 0.0, 1.0)); gl_FragColor = vec4(c, 1.0); }`
  })
  const m = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), mat)
  m.renderOrder = -10
  m.frustumCulled = false
  return m
}

export const DUMMY_GREY: Record<Background, number> = { dark: 0x9aa1ab, grey: 0x9aa1ab, studio: 0xa3a2a5 }
const BG_HEX: Record<Exclude<Background, 'studio'>, number> = { dark: 0x0b0d10, grey: 0x585d64 }

// Lights, floor and sky for a preset; swapped as a group.
export class Stage {
  private scene: THREE.Scene
  private group = new THREE.Group()
  preset: Background = 'dark'
  private baseplate: THREE.Texture | null = null

  constructor(scene: THREE.Scene, preset: Background = 'dark') {
    this.scene = scene
    scene.add(this.group)
    this.set(preset)
  }

  set(preset: Background): void {
    this.preset = BACKGROUNDS.includes(preset) ? preset : 'dark'
    for (const o of [...this.group.children]) {
      this.group.remove(o)
      o.traverse((x) => {
        const m = x as THREE.Mesh
        m.geometry?.dispose()
        const mat = m.material as THREE.Material | undefined
        mat?.dispose?.()
      })
    }
    if (this.preset === 'studio') {
      this.scene.background = srgbColor(0xc9d6e3)
      // Default Lighting: Brightness 2-3 sun at ClockTime 14.5, grey ambient, light distance fog.
      this.scene.fog = new THREE.Fog(srgbColor(0xc9d6e3), 180, 900)
      this.group.add(new THREE.HemisphereLight(srgbColor(0xd6e2f0), srgbColor(0x6b6c6e), 1.35))
      const sun = new THREE.DirectionalLight(srgbColor(0xfff4e5), 2.1)
      sun.position.set(-9, 14, -6)
      this.group.add(sun)
      this.group.add(skyDome())
      this.baseplate ??= baseplateTexture()
      const tex = this.baseplate
      tex.repeat.set(512 / 8, 512 / 8)
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(512, 512), new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, roughness: 0.9, metalness: 0 }))
      plate.rotation.x = -Math.PI / 2
      plate.position.y = -0.01
      this.group.add(plate)
      return
    }
    this.scene.fog = null
    this.scene.background = srgbColor(BG_HEX[this.preset])
    this.group.add(new THREE.HemisphereLight(srgbColor(0xdfe6ef), srgbColor(0x30343a), 1.1))
    const sun = new THREE.DirectionalLight(0xffffff, 1.3)
    sun.position.set(-6, 12, -8)
    this.group.add(sun)
    const grid = new THREE.GridHelper(64, 64, srgbColor(0x3a4048), srgbColor(0x23272d))
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.9
    this.group.add(grid)
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(64, 64), new THREE.MeshStandardMaterial({ color: srgbColor(0x15181c), roughness: 1 }))
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -0.01
    this.group.add(floor)
  }

  dispose(): void {
    this.group.traverse((x) => {
      const m = x as THREE.Mesh
      m.geometry?.dispose()
      ;(m.material as THREE.Material | undefined)?.dispose?.()
    })
    this.scene.remove(this.group)
    this.baseplate?.dispose()
  }
}
