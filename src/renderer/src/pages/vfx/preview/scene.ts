// The VFX Lab's WebGL preview: a three.js scene that draws the deterministic simulation in
// shared/vfx/simulate.ts the way Roblox draws ParticleEmitters, Beams and Trails, closely enough to
// judge an effect. It approximates Roblox; it does not match it exactly (no engine lighting model,
// no bloom or post-processing, placeholder textures when an asset cannot be fetched, MeshParts drawn
// as boxes, scripts' tweens not run).
//
// Blending: Roblox says LightEmission 0 is normal blending and 1 is additive (Creator Hub,
// ParticleEmitter.LightEmission). We output premultiplied colour with alpha * (1 - LightEmission) and
// blend ONE, ONE_MINUS_SRC_ALPHA: 0 gives src*a + dst*(1-a), 1 gives src*a + dst, in between mixes.

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { emitterRole } from '@shared/vfx/analyze'
import { prop } from '@shared/vfx/schema'
import { flipbookGrid, prepareEffect, simulate, type PreparedEffect, type SimFrame } from '@shared/vfx/simulate'
import type { Rgb, Vec3, VfxEffect, VfxNode } from '@shared/vfx/types'
import { placeholderTexture, type PlaceholderKind } from './textures'

export type Background = 'dark' | 'grey'
export type TextureResolver = (ref: string) => Promise<string | null>

const BG: Record<Background, number> = { dark: 0x0b0d10, grey: 0x585d64 }
const ORIENT: Record<string, number> = { FacingCamera: 0, FacingCameraWorldUp: 1, VelocityParallel: 2, VelocityPerpendicular: 3 }

const PARTICLE_VS = /* glsl */ `
attribute vec3 iPos;
attribute vec2 iSize;
attribute float iRot;
attribute vec4 iColor;
attribute vec3 iFrame;
attribute vec3 iVel;
uniform int mode;
uniform float zOffset;
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vFrame;

void main() {
  vUv = uv;
  vColor = iColor;
  vFrame = iFrame;
  vec2 c = position.xy * iSize;
  float a = -radians(iRot);
  vec2 r = vec2(c.x * cos(a) - c.y * sin(a), c.x * sin(a) + c.y * cos(a));
  vec4 mv;
  if (mode == 0) {
    mv = viewMatrix * vec4(iPos, 1.0);
    mv.xy += r;
  } else {
    vec3 toCam = normalize(cameraPosition - iPos);
    vec3 up;
    vec3 right;
    if (mode == 1) {
      up = vec3(0.0, 1.0, 0.0);
      right = normalize(cross(up, toCam));
      if (length(right) < 1e-3) right = vec3(1.0, 0.0, 0.0);
    } else {
      vec3 v = length(iVel) > 1e-4 ? normalize(iVel) : vec3(0.0, 1.0, 0.0);
      if (mode == 2) {
        up = v;
        right = cross(up, toCam);
        right = length(right) < 1e-4 ? vec3(1.0, 0.0, 0.0) : normalize(right);
      } else {
        vec3 helper = abs(v.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        right = normalize(cross(helper, v));
        up = cross(v, right);
      }
    }
    mv = viewMatrix * vec4(iPos + right * r.x + up * r.y, 1.0);
  }
  // ZOffset: move toward the camera (studs) and rescale so the screen size stays the same.
  if (zOffset != 0.0) {
    float d = length(mv.xyz);
    float nd = max(d - zOffset, 0.05);
    mv.xyz *= nd / max(d, 1e-4);
  }
  gl_Position = projectionMatrix * mv;
}
`

const PARTICLE_FS = /* glsl */ `
uniform sampler2D map;
uniform vec2 grid;
uniform float lightEmission;
uniform float blendFrames;
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vFrame;

vec2 cellUv(float frame) {
  float col = mod(frame, grid.x);
  float row = floor(frame / grid.x);
  return vec2((col + vUv.x) / grid.x, 1.0 - (row + 1.0 - vUv.y) / grid.y);
}

void main() {
  vec4 t0 = texture2D(map, cellUv(vFrame.x));
  vec4 t = t0;
  if (blendFrames > 0.5 && (grid.x > 1.0 || grid.y > 1.0)) t = mix(t0, texture2D(map, cellUv(vFrame.y)), vFrame.z);
  float a = t.a * vColor.a;
  if (a < 0.002) discard;
  vec3 rgb = t.rgb * vColor.rgb;
  gl_FragColor = vec4(rgb * a, a * (1.0 - lightEmission));
}
`

const STRIP_VS = /* glsl */ `
attribute vec4 color4;
varying vec2 vUv;
varying vec4 vColor;
uniform float zOffset;
void main() {
  vUv = uv;
  vColor = color4;
  vec4 mv = viewMatrix * vec4(position, 1.0);
  if (zOffset != 0.0) {
    float d = length(mv.xyz);
    mv.xyz *= max(d - zOffset, 0.05) / max(d, 1e-4);
  }
  gl_Position = projectionMatrix * mv;
}
`

const STRIP_FS = /* glsl */ `
uniform sampler2D map;
uniform float lightEmission;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 t = texture2D(map, vUv);
  float a = t.a * vColor.a;
  if (a < 0.002) discard;
  gl_FragColor = vec4(t.rgb * vColor.rgb * a, a * (1.0 - lightEmission));
}
`

function blendMaterial(vs: string, fs: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: vs,
    fragmentShader: fs,
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor
  })
}

interface EmitterView {
  id: string
  node: VfxNode
  mesh: THREE.Mesh
  geo: THREE.InstancedBufferGeometry
  mat: THREE.ShaderMaterial
  cap: number
  attrs: Record<'iPos' | 'iSize' | 'iRot' | 'iColor' | 'iFrame' | 'iVel', THREE.InstancedBufferAttribute>
}

interface StripView {
  id: string
  node: VfxNode
  mesh: THREE.Mesh
  geo: THREE.BufferGeometry
  mat: THREE.ShaderMaterial
}

export interface SceneStats {
  particles: number
  emitters: number
  drawCalls: number
}

// R15-proportioned dummy (about 5.2 studs tall, feet at y=0, facing -Z) for scale.
function buildDummy(): { group: THREE.Group; body: THREE.Mesh[] } {
  const group = new THREE.Group()
  const mat = new THREE.MeshStandardMaterial({ color: 0x9aa1ab, roughness: 0.85, metalness: 0 })
  const body: THREE.Mesh[] = []
  const box = (w: number, h: number, d: number, x: number, y: number, z = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
    m.position.set(x, y, z)
    group.add(m)
    body.push(m)
    return m
  }
  box(0.9, 1.9, 0.95, -0.5, 0.95) // legs
  box(0.9, 1.9, 0.95, 0.5, 0.95)
  box(2, 0.45, 1, 0, 2.12) // lower torso
  box(2, 1.55, 1, 0, 3.12) // upper torso
  box(0.95, 2.05, 0.95, -1.5, 2.88) // arms
  box(0.95, 2.05, 0.95, 1.5, 2.88)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.62, 24, 16), mat)
  head.scale.set(1.15, 1, 1.15)
  head.position.set(0, 4.55, 0)
  group.add(head)
  body.push(head)
  return { group, body }
}

export class VfxScene {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly controls: OrbitControls | null
  private dummy = buildDummy()
  private outline: THREE.Mesh[] = []
  private fx = new THREE.Group()
  private emitters: EmitterView[] = []
  private strips: StripView[] = []
  private lights: THREE.PointLight[] = []
  private meshes: { id: string; mesh: THREE.Mesh }[] = []
  private prepared: PreparedEffect | null = null
  private effect: VfxEffect | null = null
  private textures = new Map<string, Promise<THREE.Texture>>()
  private resolver: TextureResolver | null
  private disposed = false
  frame: SimFrame | null = null

  constructor(canvas: HTMLCanvasElement, opts: { resolver?: TextureResolver; interactive?: boolean; background?: Background } = {}) {
    THREE.ColorManagement.enabled = false
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false })
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace
    this.renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1))
    this.resolver = opts.resolver ?? null
    // Roblox's default camera field of view is 70 degrees.
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000)
    this.camera.position.set(5.5, 5.2, -9.5)
    this.controls = opts.interactive === false ? null : new OrbitControls(this.camera, canvas)
    if (this.controls) {
      this.controls.target.set(0, 3.2, -1)
      this.controls.enableDamping = false
      this.controls.update()
    } else this.camera.lookAt(0, 3.2, -1)
    this.setBackground(opts.background ?? 'dark')

    this.scene.add(new THREE.HemisphereLight(0xdfe6ef, 0x30343a, 1.1))
    const sun = new THREE.DirectionalLight(0xffffff, 1.3)
    sun.position.set(-6, 12, -8)
    this.scene.add(sun)
    const grid = new THREE.GridHelper(64, 64, 0x3a4048, 0x23272d)
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.9
    this.scene.add(grid)
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(64, 64), new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 1 }))
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -0.01
    this.scene.add(floor)
    this.scene.add(this.dummy.group)
    this.scene.add(this.fx)
  }

  setBackground(bg: Background): void {
    this.scene.background = new THREE.Color(BG[bg] ?? BG.dark)
  }

  resize(width: number, height: number): void {
    if (width < 2 || height < 2) return
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  // Loads an effect: builds a mesh per emitter / beam / trail, resolves textures. Resolves when
  // every texture is ready (placeholders count), so a capture can render right away.
  async load(effect: VfxEffect, seed = 1): Promise<void> {
    this.clearFx()
    this.effect = effect
    this.prepared = prepareEffect(effect, seed)
    const waits: Promise<unknown>[] = []
    for (const e of this.prepared.emitters) waits.push(this.addEmitter(e.id, e.node))
    for (const b of [...this.prepared.beams, ...this.prepared.trails]) waits.push(this.addStrip(b.id, b.node))
    for (const l of this.prepared.lights) {
      const light = new THREE.PointLight(0xffffff, 0, 8, 1.5)
      light.userData.id = l.id
      this.lights.push(light)
      this.fx.add(light)
    }
    for (const m of this.prepared.meshes) {
      const c = prop<Rgb>(m.node, 'Color')
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(m.size[0], m.size[1], m.size[2]), new THREE.MeshStandardMaterial({ color: new THREE.Color(c[0], c[1], c[2]), transparent: true, opacity: 1 - prop<number>(m.node, 'Transparency'), depthWrite: false }))
      this.meshes.push({ id: m.id, mesh })
      this.fx.add(mesh)
    }
    this.applyHighlight()
    await Promise.all(waits)
  }

  // Same effect with edited parameters: rebuild (cheap; textures are cached).
  async update(effect: VfxEffect): Promise<void> {
    await this.load(effect)
  }

  get duration(): number {
    return this.effect?.duration ?? 2
  }

  private texture(ref: string, kind: PlaceholderKind, grid: [number, number]): Promise<THREE.Texture> {
    const key = `${ref}|${kind}|${grid.join('x')}`
    let p = this.textures.get(key)
    if (!p) {
      p = (async () => {
        const url = ref && this.resolver && !/^rbxasset:\/\//i.test(ref) ? await this.resolver(ref).catch(() => null) : null
        if (url) {
          const tex = await new THREE.TextureLoader().loadAsync(url).catch(() => null)
          if (tex) {
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping
            return tex
          }
        }
        const tex = new THREE.CanvasTexture(placeholderTexture(kind, grid))
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping
        tex.userData.placeholder = true
        return tex
      })()
      this.textures.set(key, p)
    }
    return p
  }

  private async addEmitter(id: string, node: VfxNode): Promise<void> {
    const geo = new THREE.InstancedBufferGeometry()
    const quad = new THREE.PlaneGeometry(1, 1)
    geo.index = quad.index
    geo.setAttribute('position', quad.getAttribute('position'))
    geo.setAttribute('uv', quad.getAttribute('uv'))
    const cap = 64
    const attrs = this.makeAttrs(cap)
    for (const [k, a] of Object.entries(attrs)) geo.setAttribute(k, a)
    geo.instanceCount = 0
    const grid = flipbookGrid(node)
    const mat = blendMaterial(PARTICLE_VS, PARTICLE_FS, {
      map: { value: null },
      grid: { value: new THREE.Vector2(grid[0], grid[1]) },
      mode: { value: ORIENT[prop<string>(node, 'Orientation')] ?? 0 },
      zOffset: { value: prop<number>(node, 'ZOffset') || 0 },
      lightEmission: { value: Math.max(0, Math.min(1, prop<number>(node, 'LightEmission'))) },
      blendFrames: { value: prop<boolean>(node, 'FlipbookBlendFrames') === false ? 0 : 1 }
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.frustumCulled = false
    this.fx.add(mesh)
    this.emitters.push({ id, node, mesh, geo, mat, cap, attrs })
    const role = emitterRole(node)
    const kind: PlaceholderKind = role === 'sparks' ? 'spark' : role === 'smoke' ? 'smoke' : role === 'ring' ? 'ring' : 'soft'
    mat.uniforms.map.value = await this.texture(String(node.props.Texture ?? ''), kind, grid)
  }

  private makeAttrs(cap: number): EmitterView['attrs'] {
    const a = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n).setUsage(THREE.DynamicDrawUsage)
    return { iPos: a(3), iSize: a(2), iRot: a(1), iColor: a(4), iFrame: a(3), iVel: a(3) }
  }

  private async addStrip(id: string, node: VfxNode): Promise<void> {
    const geo = new THREE.BufferGeometry()
    const mat = blendMaterial(STRIP_VS, STRIP_FS, {
      map: { value: null },
      zOffset: { value: prop<number>(node, 'ZOffset') || 0 },
      lightEmission: { value: Math.max(0, Math.min(1, prop<number>(node, 'LightEmission'))) }
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.frustumCulled = false
    this.fx.add(mesh)
    this.strips.push({ id, node, mesh, geo, mat })
    mat.uniforms.map.value = await this.texture(String(node.props.Texture ?? ''), node.className === 'Trail' ? 'trail' : 'beam', [1, 1])
  }

  private applyHighlight(): void {
    for (const o of this.outline) this.dummy.group.remove(o)
    this.outline = []
    const h = this.prepared?.highlights.find((n) => prop<boolean>(n, 'Enabled') !== false)
    for (const m of this.dummy.body) {
      const mat = m.material as THREE.MeshStandardMaterial
      mat.emissive.setRGB(0, 0, 0)
      mat.color.setHex(0x9aa1ab)
    }
    if (!h) return
    const fill = prop<Rgb>(h, 'FillColor')
    const fillA = 1 - prop<number>(h, 'FillTransparency')
    const out = prop<Rgb>(h, 'OutlineColor')
    const outA = 1 - prop<number>(h, 'OutlineTransparency')
    const base = this.dummy.body[0].material as THREE.MeshStandardMaterial
    base.color.setRGB(0.6 * (1 - fillA) + fill[0] * fillA, 0.63 * (1 - fillA) + fill[1] * fillA, 0.67 * (1 - fillA) + fill[2] * fillA)
    base.emissive.setRGB(fill[0] * fillA * 0.6, fill[1] * fillA * 0.6, fill[2] * fillA * 0.6)
    if (outA <= 0.01) return
    const outlineMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(out[0], out[1], out[2]), side: THREE.BackSide, transparent: outA < 1, opacity: outA })
    for (const m of this.dummy.body) {
      const o = new THREE.Mesh(m.geometry, outlineMat)
      o.position.copy(m.position)
      o.scale.copy(m.scale).multiplyScalar(1.06)
      this.dummy.group.add(o)
      this.outline.push(o)
    }
  }

  // Simulates and uploads the frame at time t (seconds into the effect).
  setTime(t: number, extraCues?: VfxEffect['cues']): SceneStats {
    if (!this.prepared) return { particles: 0, emitters: 0, drawCalls: 0 }
    if (extraCues) {
      // Preview-only bursts ("Emit burst"): appended to each emitter's schedule.
      for (const e of this.prepared.emitters) {
        e.bursts = this.effect!.cues.filter((c) => c.target === e.id && c.action === 'emit').map((c) => ({ at: c.at, count: c.count ?? 16 }))
        for (const c of extraCues) if (c.target === e.id && c.action === 'emit') e.bursts.push({ at: c.at, count: c.count ?? 16 })
      }
    }
    const f = simulate(this.prepared, t)
    this.frame = f
    const camPos = this.camera.position
    let particles = 0
    const order: { view: EmitterView; depth: number }[] = []
    for (const em of f.emitters) {
      const view = this.emitters.find((v) => v.id === em.id)
      if (!view) continue
      const ps = em.particles
      particles += ps.length
      if (ps.length > view.cap) {
        let cap = view.cap
        while (cap < ps.length) cap *= 2
        view.cap = cap
        view.attrs = this.makeAttrs(cap)
        for (const [k, a] of Object.entries(view.attrs)) view.geo.setAttribute(k, a)
      }
      // Back to front within the emitter.
      const dist = (p: Vec3) => (p[0] - camPos.x) ** 2 + (p[1] - camPos.y) ** 2 + (p[2] - camPos.z) ** 2
      const sorted = ps.map((p) => ({ p, d: dist(p.pos) })).sort((a, b) => b.d - a.d)
      const A = view.attrs
      sorted.forEach(({ p }, i) => {
        A.iPos.setXYZ(i, p.pos[0], p.pos[1], p.pos[2])
        A.iSize.setXY(i, p.w, p.h)
        A.iRot.setX(i, p.rot)
        A.iColor.setXYZW(i, p.color[0], p.color[1], p.color[2], p.alpha)
        A.iFrame.setXYZ(i, p.frame, p.nextFrame, p.blend)
        A.iVel.setXYZ(i, p.vel[0], p.vel[1], p.vel[2])
      })
      for (const a of Object.values(A)) a.needsUpdate = true
      view.geo.instanceCount = ps.length
      const mean = sorted.length ? sorted.reduce((s, x) => s + Math.sqrt(x.d), 0) / sorted.length : 0
      order.push({ view, depth: mean - (prop<number>(view.node, 'ZOffset') || 0) })
    }
    // Emitters far (and low ZOffset) first.
    order.sort((a, b) => b.depth - a.depth).forEach((o, i) => (o.view.mesh.renderOrder = 10 + i))

    for (const s of this.strips) {
      const beam = f.beams.find((b) => b.id === s.id)
      const trail = f.trails.find((b) => b.id === s.id)
      if (beam) this.fillBeam(s, beam)
      else if (trail) this.fillTrail(s, trail)
      else s.geo.setDrawRange(0, 0)
      s.mesh.renderOrder = 5
    }
    for (const light of this.lights) {
      const l = f.lights.find((x) => x.id === light.userData.id)
      if (!l) {
        light.intensity = 0
        continue
      }
      light.position.set(l.pos[0], l.pos[1], l.pos[2])
      light.color.setRGB(l.color[0], l.color[1], l.color[2])
      // Tuned by eye against Studio: Brightness 2-4 lights a character without blowing it out.
      light.intensity = l.brightness * 1.4
      light.distance = l.range
    }
    for (const m of this.meshes) {
      const pm = this.prepared.meshes.find((x) => x.id === m.id)
      if (!pm) continue
      const c = pm.at(t)
      m.mesh.position.set(c[0], c[1], c[2])
      m.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().set(c[3], c[4], c[5], 0, c[6], c[7], c[8], 0, c[9], c[10], c[11], 0, 0, 0, 0, 1))
    }
    return { particles, emitters: f.emitters.length, drawCalls: this.emitters.length + this.strips.length }
  }

  private writeStrip(s: StripView, left: Vec3[], right: Vec3[], us: number[], colors: Rgb[], alphas: number[]): void {
    const n = left.length
    const pos = new Float32Array(n * 2 * 3)
    const uv = new Float32Array(n * 2 * 2)
    const col = new Float32Array(n * 2 * 4)
    for (let i = 0; i < n; i++) {
      pos.set(left[i], i * 6)
      pos.set(right[i], i * 6 + 3)
      uv.set([us[i], 1, us[i], 0], i * 4)
      col.set([colors[i][0], colors[i][1], colors[i][2], alphas[i], colors[i][0], colors[i][1], colors[i][2], alphas[i]], i * 8)
    }
    const idx: number[] = []
    for (let i = 0; i < n - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2)
    s.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    s.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    s.geo.setAttribute('color4', new THREE.BufferAttribute(col, 4))
    s.geo.setIndex(idx)
    s.geo.setDrawRange(0, idx.length)
  }

  private fillBeam(s: StripView, b: NonNullable<SimFrame['beams'][number]>): void {
    const faceCamera = prop<boolean>(s.node, 'FaceCamera') === true
    const cam = this.camera.position
    const left: Vec3[] = []
    const right: Vec3[] = []
    b.points.forEach((p, i) => {
      let side = b.sides[i]
      if (faceCamera) {
        const next = b.points[Math.min(i + 1, b.points.length - 1)]
        const prev = b.points[Math.max(i - 1, 0)]
        const tan = new THREE.Vector3(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]).normalize()
        const toCam = new THREE.Vector3(cam.x - p[0], cam.y - p[1], cam.z - p[2]).normalize()
        const v = new THREE.Vector3().crossVectors(tan, toCam).normalize()
        side = [v.x, v.y, v.z]
      }
      const w = b.widths[i] / 2
      left.push([p[0] + side[0] * w, p[1] + side[1] * w, p[2] + side[2] * w])
      right.push([p[0] - side[0] * w, p[1] - side[1] * w, p[2] - side[2] * w])
    })
    this.writeStrip(s, left, right, b.us, b.colors, b.alphas)
  }

  private fillTrail(s: StripView, tr: NonNullable<SimFrame['trails'][number]>): void {
    let { left, right } = tr
    if (prop<boolean>(s.node, 'FaceCamera') === true) {
      const cam = this.camera.position
      left = []
      right = []
      tr.left.forEach((a, i) => {
        const b = tr.right[i]
        const mid = new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
        const half = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 2
        const nb = tr.left[Math.min(i + 1, tr.left.length - 1)]
        const pb = tr.left[Math.max(i - 1, 0)]
        const tan = new THREE.Vector3(nb[0] - pb[0], nb[1] - pb[1], nb[2] - pb[2]).normalize()
        const toCam = new THREE.Vector3().subVectors(cam, mid).normalize()
        const side = new THREE.Vector3().crossVectors(tan, toCam).normalize().multiplyScalar(half)
        left.push([mid.x + side.x, mid.y + side.y, mid.z + side.z])
        right.push([mid.x - side.x, mid.y - side.y, mid.z - side.z])
      })
    }
    const mode = prop<string>(s.node, 'TextureMode')
    const len = Math.max(0.01, prop<number>(s.node, 'TextureLength') || 1)
    let us = tr.us
    if (mode !== 'Stretch') {
      let acc = 0
      us = tr.left.map((p, i) => {
        if (i) {
          const q = tr.left[i - 1]
          acc += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
        }
        return acc / len
      })
    }
    this.writeStrip(s, left, right, us, tr.colors, tr.alphas)
  }

  render(): void {
    if (this.disposed) return
    this.renderer.render(this.scene, this.camera)
  }

  // Current frame as a PNG data URL (thumbnails).
  snapshot(): string {
    this.render()
    return this.renderer.domElement.toDataURL('image/png')
  }

  usesPlaceholders(): Promise<boolean> {
    return Promise.all([...this.textures.values()]).then((ts) => ts.some((t) => t.userData.placeholder))
  }

  private clearFx(): void {
    for (const e of this.emitters) {
      e.geo.dispose()
      e.mat.dispose()
    }
    for (const s of this.strips) {
      s.geo.dispose()
      s.mat.dispose()
    }
    for (const m of this.meshes) {
      m.mesh.geometry.dispose()
      ;(m.mesh.material as THREE.Material).dispose()
    }
    this.fx.clear()
    this.emitters = []
    this.strips = []
    this.lights = []
    this.meshes = []
  }

  dispose(): void {
    this.disposed = true
    this.clearFx()
    this.controls?.dispose()
    for (const p of this.textures.values()) void p.then((t) => t.dispose())
    this.renderer.dispose()
  }
}
