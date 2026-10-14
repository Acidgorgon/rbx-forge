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
import { flipbookGrid, prepareEffect, simulate, type PreparedEffect, type PreparedMesh, type SimFrame } from '@shared/vfx/simulate'
import { NORMALS } from '@shared/vfx/cframe'
import type { Rgb, Vec3, VfxEffect, VfxNode } from '@shared/vfx/types'
import type { PlaceholderKind } from './textures'
import { sharedMeshes, type MeshFn, type MeshGeometry } from './meshes'

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

// Real meshes with Neon / ForceField: Neon is a bright, half-additive core with a soft edge (Roblox
// draws it opaque and blooms it; the preview has no bloom); ForceField shows the texture's
// brightness tinted by Color, additively, plus a fresnel rim (no texture: rim only).
export const MESH_VS = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
varying vec2 vUv;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  #ifdef USE_UV_ATTR
  vUv = uv;
  #else
  vUv = vec2(0.0);
  #endif
  gl_Position = projectionMatrix * mv;
}
`

export const MESH_FS = /* glsl */ `
uniform vec3 color;
uniform float opacity;
uniform float mode;
uniform float hasMap;
uniform sampler2D map;
varying vec3 vN;
varying vec3 vV;
varying vec2 vUv;
void main() {
  float facing = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
  vec4 t = hasMap > 0.5 ? texture2D(map, vUv) : vec4(1.0);
  vec3 c;
  float a;
  float keep;
  if (mode > 1.5) {
    // ForceField
    float rimv = pow(1.0 - facing, 2.0);
    float lum = hasMap > 0.5 ? dot(t.rgb, vec3(0.299, 0.587, 0.114)) * t.a : 0.0;
    a = clamp(lum + rimv * (hasMap > 0.5 ? 0.6 : 1.3), 0.0, 1.0) * opacity;
    c = color * (0.7 + 0.8 * lum + 0.6 * rimv);
    keep = 0.0;
  } else {
    // Neon
    a = opacity * t.a * (0.75 + 0.25 * smoothstep(0.0, 0.6, facing));
    c = min(color * t.rgb * 1.35 + 0.15 * pow(facing, 3.0), vec3(1.0));
    keep = 0.5;
  }
  if (a < 0.003) discard;
  gl_FragColor = vec4(c * a, a * keep);
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

interface DecalView {
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  decal: PreparedMesh['decals'][number]
  normal: Vec3
  tiled?: THREE.Texture
}

interface PartView {
  id: string
  holder: THREE.Group
  mesh: THREE.Mesh
  faces: THREE.Group
  glow: boolean
  real: boolean
  decals: DecalView[]
  outline: THREE.Mesh | null
  // Proxy geometry belongs to the view; real mesh geometry to the shared mesh cache.
  ownsGeometry: boolean
}

export interface MeshInfo {
  // Mesh asset refs the effect uses (MeshPart MeshId, FileMesh SpecialMesh MeshId).
  files: string[]
  // Those drawn with their real geometry (the rest are proxies).
  loaded: string[]
  textures: { total: number; placeholders: number }
}

interface StripView {
  id: string
  node: VfxNode
  mesh: THREE.Mesh
  geo: THREE.BufferGeometry
  mat: THREE.ShaderMaterial
}

// Material-ish shading for part proxies (roughness / metalness per Enum.Material family).
const MATERIAL_LOOK: Record<string, { roughness: number; metalness: number }> = {
  Plastic: { roughness: 0.6, metalness: 0 },
  SmoothPlastic: { roughness: 0.35, metalness: 0 },
  Glass: { roughness: 0.05, metalness: 0.1 },
  Ice: { roughness: 0.15, metalness: 0.05 },
  Metal: { roughness: 0.35, metalness: 0.85 },
  DiamondPlate: { roughness: 0.4, metalness: 0.8 },
  Foil: { roughness: 0.25, metalness: 0.9 },
  CorrodedMetal: { roughness: 0.8, metalness: 0.6 },
  Marble: { roughness: 0.3, metalness: 0 },
  Wood: { roughness: 0.85, metalness: 0 },
  WoodPlanks: { roughness: 0.85, metalness: 0 },
  Concrete: { roughness: 0.95, metalness: 0 },
  Slate: { roughness: 0.9, metalness: 0 },
  Granite: { roughness: 0.9, metalness: 0 },
  Brick: { roughness: 0.95, metalness: 0 },
  Pebble: { roughness: 0.95, metalness: 0 },
  Cobblestone: { roughness: 0.95, metalness: 0 },
  Grass: { roughness: 1, metalness: 0 },
  Sand: { roughness: 1, metalness: 0 },
  Fabric: { roughness: 1, metalness: 0 }
}

// A unit wedge (Roblox WedgePart: full height at the back +Z, sloping to the bottom at the front -Z).
function wedgeGeometry(): THREE.BufferGeometry {
  const v = [
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5],
    [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5]
  ]
  const faces = [
    [0, 2, 1], [0, 3, 2], // bottom
    [3, 4, 5], [3, 5, 2], // back
    [0, 1, 5], [0, 5, 4], // slope
    [0, 4, 3], // left
    [1, 2, 5] // right
  ]
  const pos: number[] = []
  for (const f of faces) for (const i of f) pos.push(...v[i])
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  return g
}

export class FxLayer {
  readonly group = new THREE.Group()
  private emitters: EmitterView[] = []
  private strips: StripView[] = []
  private lights: THREE.PointLight[] = []
  private meshes: PartView[] = []
  prepared: PreparedEffect | null = null
  effect: VfxEffect | null = null
  frame: SimFrame | null = null
  private camera: THREE.Camera
  private texture: TextureFn
  private meshFn: MeshFn
  // What the last load drew: real meshes vs proxies (the Lab's "Load meshes" notice).
  meshInfo: MeshInfo = { files: [], loaded: [], textures: { total: 0, placeholders: 0 } }

  constructor(camera: THREE.Camera, texture: TextureFn, meshes: MeshFn = sharedMeshes.get) {
    this.camera = camera
    this.texture = texture
    this.meshFn = meshes
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
    const files = new Set<string>()
    const loaded = new Set<string>()
    for (const m of this.prepared.meshes) {
      if (m.file) files.add(m.file.meshId)
      waits.push(
        this.addPart(m).then((real) => {
          if (real && m.file) loaded.add(m.file.meshId)
        })
      )
    }
    this.meshInfo = { files: [...files], loaded: [], textures: { total: 0, placeholders: 0 } }
    await Promise.all(waits)
    this.meshInfo.loaded = [...loaded]
  }

  // One part: the real mesh when its geometry is cached, else the proxy shape; decals on its faces
  // and a Highlight on it. Resolves true when the real mesh is drawn.
  private async addPart(m: PreparedMesh): Promise<boolean> {
    const c = prop<Rgb>(m.node, 'Color')
    const material = m.material
    const holder = new THREE.Group()
    this.group.add(holder)
    const geom: MeshGeometry | null = m.file ? await this.meshFn(m.file.meshId).catch(() => null) : null
    if (this.prepared?.meshes.indexOf(m) === -1) return false
    const real = !!geom
    // Proxy: unit geometry scaled by the (possibly tweened) size every frame. Roblox cylinders run
    // along X; wedges slope down towards -Z (front) like WedgePart; unloaded meshes are ellipsoids.
    const geo = geom ? (m.file!.mode === 'part' ? geom.fitted : geom.raw) : m.shape === 'ball' || m.shape === 'ellipsoid' ? new THREE.SphereGeometry(0.5, 40, 24) : m.shape === 'cylinder' ? new THREE.CylinderGeometry(0.5, 0.5, 1, 40).rotateZ(Math.PI / 2) : m.shape === 'wedge' ? wedgeGeometry() : new THREE.BoxGeometry(1, 1, 1)
    let map: THREE.Texture | null = null
    if (geom && m.file?.textureId) {
      const t = await this.texture(m.file.textureId, 'soft', [1, 1]).catch(() => null)
      this.meshInfo.textures.total++
      if (t && !t.userData.placeholder) map = t
      else this.meshInfo.textures.placeholders++
    }
    const glow = material === 'Neon' || material === 'ForceField'
    const look = MATERIAL_LOOK[material] ?? MATERIAL_LOOK.Plastic
    const opacity = (1 - prop<number>(m.node, 'Transparency')) * (m.shape === 'ellipsoid' && !real ? 0.85 : 1)
    let mat: THREE.Material
    if (glow && real) {
      mat = blendMaterial(MESH_VS, MESH_FS, { color: { value: new THREE.Color(c[0], c[1], c[2]) }, opacity: { value: opacity }, mode: { value: material === 'ForceField' ? 2 : 1 }, hasMap: { value: map ? 1 : 0 }, map: { value: map } })
      if (geo.getAttribute('uv')) (mat as THREE.ShaderMaterial).defines = { USE_UV_ATTR: '' }
    } else if (glow) {
      mat = blendMaterial(PART_VS, PART_FS, { color: { value: new THREE.Color(c[0], c[1], c[2]) }, opacity: { value: opacity }, rim: { value: material === 'ForceField' ? 1 : 0 } })
    } else {
      // A MeshPart's texture replaces its Color (Color shows where the texture is transparent:
      // approximated by tinting white); a SpecialMesh's texture is tinted by VertexColor.
      mat = new THREE.MeshStandardMaterial({
        color: map ? new THREE.Color(1, 1, 1) : new THREE.Color(c[0], c[1], c[2]),
        map,
        transparent: true,
        alphaTest: map ? 0.02 : 0,
        opacity: material === 'Glass' ? Math.min(opacity, 0.45) : opacity,
        depthWrite: opacity > 0.99 && !map,
        roughness: look.roughness,
        metalness: look.metalness,
        flatShading: m.shape === 'wedge' && !real,
        side: real || m.shape === 'wedge' ? THREE.DoubleSide : THREE.FrontSide
      })
    }
    if (glow && real) (mat as THREE.ShaderMaterial).side = THREE.DoubleSide
    const mesh = new THREE.Mesh(geo, mat)
    mesh.renderOrder = glow ? 4 : 0
    holder.add(mesh)
    // Decals / Textures: a unit quad per face inside a box scaled by the part Size.
    const faces = new THREE.Group()
    holder.add(faces)
    const decals: DecalView[] = []
    for (const d of m.decals) {
      const plane = new THREE.PlaneGeometry(1, 1)
      const n = NORMALS[d.face] ?? NORMALS.Front
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(n[0], n[1], n[2]))
      plane.applyQuaternion(q)
      plane.translate(n[0] * 0.502, n[1] * 0.502, n[2] * 0.502)
      const dm = new THREE.MeshBasicMaterial({ color: new THREE.Color(d.color[0], d.color[1], d.color[2]), transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 })
      const dmesh = new THREE.Mesh(plane, dm)
      dmesh.renderOrder = 3
      faces.add(dmesh)
      const view: DecalView = { mesh: dmesh, mat: dm, decal: d, normal: n }
      decals.push(view)
      void this.texture(d.texture, 'soft', [1, 1]).then((t) => {
        if (t.userData.placeholder) return
        const tex = d.tile ? t.clone() : t
        if (d.tile) tex.needsUpdate = true
        dm.map = tex
        dm.needsUpdate = true
        view.tiled = d.tile ? tex : undefined
      })
    }
    // Highlight on the part: fill tint + an outline shell (back faces, slightly larger).
    let outline: THREE.Mesh | null = null
    if (m.highlight && prop<boolean>(m.highlight, 'Enabled') !== false) {
      const h = m.highlight
      const out = prop<Rgb>(h, 'OutlineColor')
      const outA = 1 - prop<number>(h, 'OutlineTransparency')
      const fill = prop<Rgb>(h, 'FillColor')
      const fillA = 1 - prop<number>(h, 'FillTransparency')
      if (fillA > 0.01 && mat instanceof THREE.MeshStandardMaterial) mat.emissive = new THREE.Color(fill[0] * fillA, fill[1] * fillA, fill[2] * fillA)
      if (outA > 0.01) {
        outline = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(out[0], out[1], out[2]), side: THREE.BackSide, transparent: true, opacity: outA, depthWrite: false }))
        outline.scale.setScalar(1.05)
        mesh.add(outline)
      }
    }
    this.meshes.push({ id: m.id, holder, mesh, faces, glow, real, decals, outline, ownsGeometry: !geom })
    return real
  }

  get meshesLoaded(): number {
    return this.meshInfo.loaded.length
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
      m.holder.position.set(c[0], c[1], c[2])
      m.holder.quaternion.setFromRotationMatrix(new THREE.Matrix4().set(c[3], c[4], c[5], 0, c[6], c[7], c[8], 0, c[9], c[10], c[11], 0, 0, 0, 0, 1))
      const look = pm.look(t)
      const size = look.size.map((v) => Math.max(1e-3, v)) as Vec3
      if (m.real && pm.file?.mode === 'special') {
        // FileMesh: mesh units x Scale, moved by Offset (part space).
        const sc = look.scale ?? [1, 1, 1]
        const off = pm.file.offset(t)
        m.mesh.scale.set(Math.max(1e-3, sc[0]), Math.max(1e-3, sc[1]), Math.max(1e-3, sc[2]))
        m.mesh.position.set(off[0], off[1], off[2])
      } else m.mesh.scale.set(size[0], size[1], size[2])
      m.faces.scale.set(size[0], size[1], size[2])
      const opacity = 1 - Math.max(0, Math.min(1, look.transparency))
      m.mesh.visible = opacity > 0.003
      const mat = m.mesh.material as THREE.ShaderMaterial | THREE.MeshStandardMaterial
      const vc = m.real && pm.file?.mode === 'special' ? pm.file.vertexColor(t) : null
      if (m.glow) {
        const u = (mat as THREE.ShaderMaterial).uniforms
        u.opacity.value = opacity
        ;(u.color.value as THREE.Color).setRGB(look.color[0], look.color[1], look.color[2])
      } else {
        const sm = mat as THREE.MeshStandardMaterial
        sm.opacity = sm.map ? opacity : opacity
        if (sm.map) sm.color.setRGB(vc ? vc[0] : 1, vc ? vc[1] : 1, vc ? vc[2] : 1)
        else sm.color.setRGB(look.color[0], look.color[1], look.color[2])
      }
      for (const d of m.decals) {
        const dop = (1 - Math.max(0, Math.min(1, d.decal.transparency(t)))) * opacity
        d.mat.opacity = d.mat.map ? dop : 0
        d.mesh.visible = !!d.mat.map && dop > 0.003
        if (d.tiled && d.decal.tile) {
          // Texture: repeats every StudsPerTile studs across the face.
          const axes = [0, 1, 2].filter((k) => Math.abs(d.normal[k]) < 0.5)
          d.tiled.repeat.set(size[axes[0]] / d.decal.tile[0], size[axes[1]] / d.decal.tile[1])
        }
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
      if (m.ownsGeometry) m.mesh.geometry.dispose()
      ;(m.mesh.material as THREE.Material).dispose()
      if (m.outline) (m.outline.material as THREE.Material).dispose()
      for (const d of m.decals) {
        d.mesh.geometry.dispose()
        d.mat.dispose()
        if (d.tiled) d.tiled.dispose()
      }
    }
    this.group.clear()
    this.emitters = []
    this.strips = []
    this.lights = []
    this.meshes = []
    this.prepared = null
  }
}
