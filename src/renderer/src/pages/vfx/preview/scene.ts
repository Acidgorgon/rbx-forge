// The VFX Lab's WebGL preview: a three.js scene that draws the deterministic simulation in
// shared/vfx/simulate.ts the way Roblox draws ParticleEmitters, Beams and Trails, closely enough to
// judge an effect. It approximates Roblox; it does not match it exactly (no engine lighting model,
// no bloom or post-processing, placeholder textures when an asset cannot be fetched, MeshParts drawn
// as proxies until their mesh files are loaded (preview/meshes.ts)). Timeline tweens (shared/vfx/timeline.ts) move parts and attachments and drive emitter,
// beam, light and part properties every frame; Neon parts glow and ForceField parts are rim-lit.
// The drawables live in fxLayer.ts (shared with the Ability Composer preview).

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { prop } from '@shared/vfx/schema'
import { effectBounds, type SimFrame } from '@shared/vfx/simulate'
import type { Rgb, VfxEffect } from '@shared/vfx/types'
import { FxLayer, type LayerStats, type MeshInfo } from './fxLayer'
import { frameView } from './framing'
import { placeholderTexture, type PlaceholderKind } from './textures'
import { DUMMY_GREY, LinearOutput, setSrgb, srgbColor, Stage, type Background } from './stage'

export type { Background }
export { BACKGROUNDS } from './stage'
// Camera presets: the default three-quarter view, a side view for things that travel forward, and a
// wide view that fits long sequences.
export type View = 'front' | 'side' | 'wide'

const VIEWS: Record<View, { pos: [number, number, number]; target: [number, number, number] }> = {
  front: { pos: [5.5, 5.2, -9.5], target: [0, 3.2, -1] },
  side: { pos: [26, 9, -13], target: [0, 3, -13] },
  wide: { pos: [16, 12, -26], target: [0, 3, -10] }
}

export type TextureResolver = (ref: string) => Promise<string | null>


export type SceneStats = LayerStats

// Textures by asset ref, falling back to a generated placeholder (cached per kind and grid).
export class TextureCache {
  private textures = new Map<string, Promise<THREE.Texture>>()
  private resolver: TextureResolver | null
  constructor(resolver: TextureResolver | null) {
    this.resolver = resolver
  }

  get = (ref: string, kind: PlaceholderKind, grid: [number, number]): Promise<THREE.Texture> => {
    const key = `${ref}|${kind}|${grid.join('x')}`
    let p = this.textures.get(key)
    if (!p) {
      p = (async () => {
        const url = ref && this.resolver && !/^rbxasset:\/\//i.test(ref) ? await this.resolver(ref).catch(() => null) : null
        if (url) {
          const tex = await new THREE.TextureLoader().loadAsync(url).catch(() => null)
          if (tex) {
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping
            // Roblox textures are sRGB: decoded to linear by the GPU (see stage.ts).
            tex.colorSpace = THREE.SRGBColorSpace
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

  usesPlaceholders(): Promise<boolean> {
    return Promise.all([...this.textures.values()]).then((ts) => ts.some((t) => t.userData.placeholder))
  }

  // Uploaded textures (rbxassetid / numeric ids) asked for, and how many fell back to a placeholder.
  async uploadedStats(): Promise<{ total: number; missing: string[] }> {
    const refs = new Map<string, boolean>()
    for (const [key, p] of this.textures) {
      const ref = key.split('|')[0]
      if (!/^(?:rbxassetid:\/\/)?\d+$/i.test(ref) && !/roblox\.com\/asset/i.test(ref)) continue
      const t = await p.catch(() => null)
      refs.set(ref, (refs.get(ref) ?? false) || !t || !!t.userData.placeholder)
    }
    return { total: refs.size, missing: [...refs].filter(([, miss]) => miss).map(([r]) => r) }
  }

  dispose(): void {
    for (const p of this.textures.values()) void p.then((t) => t.dispose())
    this.textures.clear()
  }
}

// R15-proportioned dummy (about 5.2 studs tall, feet at y=0, facing -Z) for scale.
function buildDummy(): { group: THREE.Group; body: THREE.Mesh[] } {
  const group = new THREE.Group()
  const mat = new THREE.MeshStandardMaterial({ color: srgbColor(DUMMY_GREY.dark), roughness: 0.85, metalness: 0 })
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
  private textures: TextureCache
  private layer: FxLayer
  private disposed = false
  private stage: Stage
  private output: LinearOutput
  private view: View = 'front'
  // Where the loaded effect reaches (the camera pulls back when a preset does not show it all).
  private bounds: ReturnType<typeof effectBounds> = null
  private framed = false

  constructor(canvas: HTMLCanvasElement, opts: { resolver?: TextureResolver; interactive?: boolean; background?: Background } = {}) {
    THREE.ColorManagement.enabled = false
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false })
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace
    this.renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1))
    this.textures = new TextureCache(opts.resolver ?? null)
    // Roblox's default camera field of view is 70 degrees.
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000)
    this.camera.position.set(5.5, 5.2, -9.5)
    this.controls = opts.interactive === false ? null : new OrbitControls(this.camera, canvas)
    if (this.controls) {
      this.controls.target.set(0, 3.2, -1)
      this.controls.enableDamping = false
      this.controls.update()
    } else this.camera.lookAt(0, 3.2, -1)
    this.output = new LinearOutput(this.renderer)
    this.stage = new Stage(this.scene, opts.background ?? 'dark')
    this.scene.add(this.dummy.group)
    this.layer = new FxLayer(this.camera, this.textures.get)
    this.scene.add(this.layer.group)
  }

  get frame(): SimFrame | null {
    return this.layer.frame
  }

  setView(view: View): void {
    this.view = VIEWS[view] ? view : 'front'
    const preset = VIEWS[this.view]
    const v = frameView(preset, this.bounds, this.camera.fov)
    this.framed = v !== preset
    this.camera.position.set(...v.pos)
    if (this.controls) {
      this.controls.target.set(...v.target)
      this.controls.update()
    } else this.camera.lookAt(...v.target)
  }

  setBackground(bg: Background): void {
    this.stage.set(bg)
    this.applyHighlight()
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
    const done = this.layer.load(effect, seed)
    // Re-aim the camera only when this effect (or the last one) needs more than the preset shows,
    // so an orbit the user made stays while browsing effects that fit.
    try {
      this.bounds = effectBounds(effect)
    } catch {
      this.bounds = null
    }
    const preset = VIEWS[this.view]
    if (this.framed || frameView(preset, this.bounds, this.camera.fov) !== preset) this.setView(this.view)
    this.applyHighlight()
    await done
  }

  // Same effect with edited parameters: rebuild (cheap; textures are cached).
  async update(effect: VfxEffect): Promise<void> {
    await this.load(effect)
  }

  get duration(): number {
    return this.layer.duration
  }

  private applyHighlight(): void {
    for (const o of this.outline) this.dummy.group.remove(o)
    this.outline = []
    const h = this.layer.prepared?.highlights.find((n) => prop<boolean>(n, 'Enabled') !== false)
    for (const m of this.dummy.body) {
      const mat = m.material as THREE.MeshStandardMaterial
      mat.emissive.setRGB(0, 0, 0)
      mat.color.copy(srgbColor(DUMMY_GREY[this.stage?.preset ?? 'dark']))
    }
    if (!h) return
    const fill = prop<Rgb>(h, 'FillColor')
    const fillA = 1 - prop<number>(h, 'FillTransparency')
    const out = prop<Rgb>(h, 'OutlineColor')
    const outA = 1 - prop<number>(h, 'OutlineTransparency')
    const base = this.dummy.body[0].material as THREE.MeshStandardMaterial
    setSrgb(base.color, 0.6 * (1 - fillA) + fill[0] * fillA, 0.63 * (1 - fillA) + fill[1] * fillA, 0.67 * (1 - fillA) + fill[2] * fillA)
    setSrgb(base.emissive, fill[0] * fillA * 0.6, fill[1] * fillA * 0.6, fill[2] * fillA * 0.6)
    if (outA <= 0.01) return
    const outlineMat = new THREE.MeshBasicMaterial({ color: srgbColor(out[0], out[1], out[2]), side: THREE.BackSide, transparent: outA < 1, opacity: outA })
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
    return this.layer.setTime(t, extraCues)
  }

  render(): void {
    if (this.disposed) return
    this.output.render(this.scene, this.camera)
  }

  // Current frame as a PNG data URL (thumbnails).
  snapshot(): string {
    this.render()
    return this.renderer.domElement.toDataURL('image/png')
  }

  usesPlaceholders(): Promise<boolean> {
    return this.textures.usesPlaceholders()
  }

  textureStats(): Promise<{ total: number; missing: string[] }> {
    return this.textures.uploadedStats()
  }

  // Meshes the effect uses and which of them draw with real geometry.
  get meshInfo(): MeshInfo {
    return this.layer.meshInfo
  }

  dispose(): void {
    this.disposed = true
    this.layer.clear()
    this.controls?.dispose()
    this.textures.dispose()
    this.stage.dispose()
    this.output.dispose()
    this.renderer.dispose()
  }
}
