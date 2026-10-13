// One effect's drawables (particles, beams, trails, lights, parts) as a three.js group, driven by the
// deterministic simulation in shared/vfx/simulate.ts. The VFX Lab scene (scene.ts) has one layer at
// the origin; the Ability Composer puts one layer per VFX event on a body part's CFrame. The shaders
// honour the group's transform (modelMatrix), so a layer can sit anywhere in the world.
//
// Blending: Roblox says LightEmission 0 is normal blending and 1 is additive (Creator Hub,
// ParticleEmitter.LightEmission). We output premultiplied colour with alpha * (1 - LightEmission) and
// blend ONE, ONE_MINUS_SRC_ALPHA: 0 gives src*a + dst*(1-a), 1 gives src*a + dst, in between mixes.

import * as THREE from 'three'
import { emitterRole } from '@shared/vfx/analyze'
import { prop } from '@shared/vfx/schema'
import { flipbookGrid, prepareEffect, simulate, type PreparedEffect, type SimFrame } from '@shared/vfx/simulate'
import type { Rgb, Vec3, VfxEffect, VfxNode } from '@shared/vfx/types'
import type { PlaceholderKind } from './textures'

export type TextureFn = (ref: string, kind: PlaceholderKind, grid: [number, number]) => Promise<THREE.Texture>

export interface LayerStats {
  particles: number
  emitters: number
  drawCalls: number
}

export const PART_VS = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`

// Neon: flat bright core with a soft edge; ForceField: transparent centre, bright rim.
export const PART_FS = /* glsl */ `
uniform vec3 color;
uniform float opacity;
uniform float rim;
varying vec3 vN;
varying vec3 vV;
void main() {
  float facing = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
  float a;
  vec3 c;
  if (rim > 0.5) {
    float r = pow(1.0 - facing, 2.2);
    a = clamp(r * 1.4, 0.0, 1.0) * opacity;
    c = color * (0.6 + 1.2 * r);
  } else {
    a = opacity * (0.6 + 0.4 * smoothstep(0.0, 0.5, facing));
    c = mix(color * 0.85, vec3(1.0), 0.5 * pow(facing, 4.0));
  }
  if (a < 0.003) discard;
  gl_FragColor = vec4(c * a, a * (rim > 0.5 ? 0.0 : 0.7));
}
`

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
  vec3 wPos = (modelMatrix * vec4(iPos, 1.0)).xyz;
  vec3 wVel = mat3(modelMatrix) * iVel;
  vec2 c = position.xy * iSize;
  float a = -radians(iRot);
  vec2 r = vec2(c.x * cos(a) - c.y * sin(a), c.x * sin(a) + c.y * cos(a));
  vec4 mv;
  if (mode == 0) {
    mv = viewMatrix * vec4(wPos, 1.0);
    mv.xy += r;
  } else {
    vec3 toCam = normalize(cameraPosition - wPos);
    vec3 up;
    vec3 right;
    if (mode == 1) {
      up = vec3(0.0, 1.0, 0.0);
      right = normalize(cross(up, toCam));
      if (length(right) < 1e-3) right = vec3(1.0, 0.0, 0.0);
    } else {
      vec3 v = length(wVel) > 1e-4 ? normalize(wVel) : vec3(0.0, 1.0, 0.0);
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
    mv = viewMatrix * vec4(wPos + right * r.x + up * r.y, 1.0);
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
  vec4 mv = viewMatrix * modelMatrix * vec4(position, 1.0);
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

export function blendMaterial(vs: string, fs: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
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

export class FxLayer {
  readonly group = new THREE.Group()
  private emitters: EmitterView[] = []
  private strips: StripView[] = []
  private lights: THREE.PointLight[] = []
  private meshes: { id: string; mesh: THREE.Mesh; glow: boolean }[] = []
  prepared: PreparedEffect | null = null
  effect: VfxEffect | null = null
  frame: SimFrame | null = null
  private camera: THREE.Camera
  private texture: TextureFn

  constructor(camera: THREE.Camera, texture: TextureFn) {
    this.camera = camera
    this.texture = texture
  }

  // Builds a mesh per emitter / beam / trail and resolves textures (resolves when all are ready).
  async load(effect: VfxEffect, seed = 1): Promise<void> {
    this.clear()
    this.effect = effect
    this.prepared = prepareEffect(effect, seed)
    const waits: Promise<unknown>[] = []
    for (const e of this.prepared.emitters) waits.push(this.addEmitter(e.id, e.node))
    for (const b of [...this.prepared.beams, ...this.prepared.trails]) waits.push(this.addStrip(b.id, b.node))
    for (const l of this.prepared.lights) {
      const light = new THREE.PointLight(0xffffff, 0, 8, 1.5)
      light.userData.id = l.id
      this.lights.push(light)
      this.group.add(light)
    }
    for (const m of this.prepared.meshes) {
      const c = prop<Rgb>(m.node, 'Color')
      const shape = prop<string>(m.node, 'Shape')
      const material = prop<string>(m.node, 'Material')
      // Unit geometry scaled by the (possibly tweened) size every frame. Roblox cylinders run along X.
      const geo = shape === 'Ball' ? new THREE.SphereGeometry(0.5, 40, 24) : shape === 'Cylinder' ? new THREE.CylinderGeometry(0.5, 0.5, 1, 40).rotateZ(Math.PI / 2) : new THREE.BoxGeometry(1, 1, 1)
      const glow = material === 'Neon' || material === 'ForceField'
      const mat = glow
        ? blendMaterial(PART_VS, PART_FS, { color: { value: new THREE.Color(c[0], c[1], c[2]) }, opacity: { value: 1 - prop<number>(m.node, 'Transparency') }, rim: { value: material === 'ForceField' ? 1 : 0 } })
        : new THREE.MeshStandardMaterial({ color: new THREE.Color(c[0], c[1], c[2]), transparent: true, opacity: 1 - prop<number>(m.node, 'Transparency'), depthWrite: false })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.renderOrder = glow ? 4 : 0
      this.meshes.push({ id: m.id, mesh, glow })
      this.group.add(mesh)
    }
    await Promise.all(waits)
  }

  get duration(): number {
    return this.effect?.duration ?? 2
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
    this.group.add(mesh)
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
    this.group.add(mesh)
    this.strips.push({ id, node, mesh, geo, mat })
    mat.uniforms.map.value = await this.texture(String(node.props.Texture ?? ''), node.className === 'Trail' ? 'trail' : 'beam', [1, 1])
  }

  // The camera position in this layer's space (sorting and camera-facing strips).
  private cameraLocal(): THREE.Vector3 {
    this.group.updateWorldMatrix(true, false)
    return this.group.worldToLocal(this.camera.position.clone())
  }

  // Simulates and uploads the frame at time t (seconds into the effect).
  setTime(t: number, extraCues?: VfxEffect['cues']): LayerStats {
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
    const camPos = this.cameraLocal()
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
      view.mat.uniforms.lightEmission.value = Math.max(0, Math.min(1, em.lightEmission))
      view.mat.uniforms.zOffset.value = em.zOffset
      const mean = sorted.length ? sorted.reduce((s, x) => s + Math.sqrt(x.d), 0) / sorted.length : 0
      order.push({ view, depth: mean - (prop<number>(view.node, 'ZOffset') || 0) })
    }
    // Emitters far (and low ZOffset) first.
    order.sort((a, b) => b.depth - a.depth).forEach((o, i) => (o.view.mesh.renderOrder = 10 + i))

    for (const s of this.strips) {
      const beam = f.beams.find((b) => b.id === s.id)
      const trail = f.trails.find((b) => b.id === s.id)
      if (beam) this.fillBeam(s, beam, camPos)
      else if (trail) this.fillTrail(s, trail, camPos)
      else s.geo.setDrawRange(0, 0)
      const le = beam?.lightEmission ?? trail?.lightEmission
      if (le !== undefined) s.mat.uniforms.lightEmission.value = Math.max(0, Math.min(1, le))
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
      const look = pm.look(t)
      m.mesh.scale.set(Math.max(1e-3, look.size[0]), Math.max(1e-3, look.size[1]), Math.max(1e-3, look.size[2]))
      const opacity = 1 - Math.max(0, Math.min(1, look.transparency))
      m.mesh.visible = opacity > 0.003
      const mat = m.mesh.material as THREE.ShaderMaterial | THREE.MeshStandardMaterial
      if (m.glow) {
        const u = (mat as THREE.ShaderMaterial).uniforms
        u.opacity.value = opacity
        ;(u.color.value as THREE.Color).setRGB(look.color[0], look.color[1], look.color[2])
      } else {
        ;(mat as THREE.MeshStandardMaterial).opacity = opacity
        ;(mat as THREE.MeshStandardMaterial).color.setRGB(look.color[0], look.color[1], look.color[2])
      }
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

  private fillBeam(s: StripView, b: NonNullable<SimFrame['beams'][number]>, cam: THREE.Vector3): void {
    const faceCamera = prop<boolean>(s.node, 'FaceCamera') === true
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

  private fillTrail(s: StripView, tr: NonNullable<SimFrame['trails'][number]>, cam: THREE.Vector3): void {
    let { left, right } = tr
    if (prop<boolean>(s.node, 'FaceCamera') === true) {
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

  clear(): void {
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
    this.group.clear()
    this.emitters = []
    this.strips = []
    this.lights = []
    this.meshes = []
    this.prepared = null
  }
}
