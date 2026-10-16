// The Model Lab's WebGL preview: every recorded part of a build (shared/model/types.ts ModelPart)
// drawn as its Roblox shape (box, wedge, corner wedge, ball, cylinder) with its CFrame, Size, Color,
// Transparency and a material look (Neon glows, Glass and transparent parts blend, the rest is
// matte like SmoothPlastic). One InstancedMesh per shape and look, so thousands of parts stay cheap.
// The stage (backdrop, lights, floor) and the linear-light output are the VFX Lab's (vfx/preview/stage.ts).

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { displayOffset, partBounds, viewCamera, visibleParts, type Bounds, type ModelView } from '@shared/model/frame'
import type { ModelPart } from '@shared/model/types'
import { LinearOutput, Stage, type Background } from '../../vfx/preview/stage'
import { shapeGeometry, shapeOf, type ShapeKey } from './geometry'

export type { Background }

type Look = 'matte' | 'neon' | 'clear'

const lookOf = (p: ModelPart): Look => (p.m === 'Neon' ? 'neon' : (p.t ?? 0) > 0.02 || p.m === 'Glass' || p.m === 'ForceField' ? 'clear' : 'matte')

// Roughness per material family (Roblox reads SmoothPlastic as soft matte; metals a little glossier).
function roughnessOf(m?: string): number {
  if (!m) return 0.75
  if (/Metal|Foil|DiamondPlate/.test(m)) return 0.45
  if (/Ice|Glacier|Glass/.test(m)) return 0.55
  if (/Smooth/.test(m)) return 0.7
  return 0.85
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

export class ModelScene {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly controls: OrbitControls | null
  private stage: Stage
  private output: LinearOutput
  private group = new THREE.Group()
  private geometries = new Map<ShapeKey, THREE.BufferGeometry>()
  private bounds: Bounds | null = null
  private view: ModelView = 'front'
  private disposed = false
  partCount = 0

  constructor(canvas: HTMLCanvasElement, opts: { interactive?: boolean; background?: Background } = {}) {
    THREE.ColorManagement.enabled = false
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false })
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace
    this.renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1))
    this.camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 2000)
    this.controls = opts.interactive === false ? null : new OrbitControls(this.camera, canvas)
    if (this.controls) this.controls.enableDamping = false
    this.output = new LinearOutput(this.renderer)
    this.stage = new Stage(this.scene, opts.background ?? 'dark')
    this.scene.add(this.group)
    // A soft fill from the front-left so the dark top plates keep their shape.
    const fill = new THREE.DirectionalLight(0xffffff, 0.45)
    fill.position.set(8, 6, -10)
    this.scene.add(fill)
    this.setView('front')
  }

  private geometry(key: ShapeKey): THREE.BufferGeometry {
    let g = this.geometries.get(key)
    if (!g) {
      g = shapeGeometry(key)
      this.geometries.set(key, g)
    }
    return g
  }

  private clear(): void {
    for (const o of [...this.group.children]) {
      this.group.remove(o)
      const m = o as THREE.InstancedMesh
      ;(m.material as THREE.Material | undefined)?.dispose?.()
      m.dispose?.()
    }
  }

  // Draws a build. The model is stood on the floor and centred (display only).
  load(parts: ModelPart[]): void {
    this.clear()
    const shown = visibleParts(parts)
    this.partCount = parts.length
    this.bounds = partBounds(shown)
    const off = displayOffset(this.bounds)
    this.group.position.set(off[0], off[1], off[2])
    const buckets = new Map<string, ModelPart[]>()
    for (const p of shown) {
      const key = `${shapeOf(p.k, p.sh)}|${lookOf(p)}|${lookOf(p) === 'clear' ? Math.round((p.t ?? 0) * 10) : 0}|${roughnessOf(p.m)}`
      let list = buckets.get(key)
      if (!list) buckets.set(key, (list = []))
      list.push(p)
    }
    const m4 = new THREE.Matrix4()
    const scale = new THREE.Matrix4()
    const color = new THREE.Color()
    for (const [key, list] of buckets) {
      const [shape, look, alpha, rough] = key.split('|')
      const t = Number(alpha) / 10
      const mat =
        look === 'neon'
          ? new THREE.MeshBasicMaterial({ color: 0xffffff })
          : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: Number(rough), metalness: 0, transparent: look === 'clear', opacity: look === 'clear' ? Math.max(0.15, 1 - Math.max(t, 0.35)) : 1, depthWrite: look !== 'clear' })
      const mesh = new THREE.InstancedMesh(this.geometry(shape as ShapeKey), mat, list.length)
      list.forEach((p, i) => {
        const c = p.cf
        m4.set(c[3], c[4], c[5], c[0], c[6], c[7], c[8], c[1], c[9], c[10], c[11], c[2], 0, 0, 0, 1)
        scale.makeScale(Math.max(0.01, p.s[0]), Math.max(0.01, p.s[1]), Math.max(0.01, p.s[2]))
        mesh.setMatrixAt(i, m4.multiply(scale))
        const k = look === 'neon' ? 1.6 : 1
        color.setRGB(srgbToLinear(p.c[0]) * k, srgbToLinear(p.c[1]) * k, srgbToLinear(p.c[2]) * k)
        mesh.setColorAt(i, color)
      })
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.computeBoundingSphere()
      if (look === 'clear') mesh.renderOrder = 2
      this.group.add(mesh)
    }
    this.setView(this.view)
  }

  setView(view: ModelView): void {
    this.view = view
    const pose = viewCamera(this.bounds, view, this.camera.fov, this.camera.aspect)
    this.camera.position.set(...pose.pos)
    this.camera.far = pose.far
    this.camera.updateProjectionMatrix()
    if (this.controls) {
      this.controls.target.set(...pose.target)
      this.controls.update()
    } else this.camera.lookAt(...pose.target)
  }

  setBackground(bg: Background): void {
    this.stage.set(bg)
  }

  resize(width: number, height: number): void {
    if (width < 2 || height < 2) return
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  render(): void {
    if (this.disposed) return
    this.output.render(this.scene, this.camera)
  }

  // The current view as a PNG data URL (thumbnails); with a view, that view (the camera is put back).
  snapshot(view?: ModelView): string {
    const saved = view ? { pos: this.camera.position.clone(), target: this.controls?.target.clone(), view: this.view } : null
    if (view) this.setView(view)
    this.render()
    const url = this.renderer.domElement.toDataURL('image/png')
    if (saved) {
      this.view = saved.view
      this.camera.position.copy(saved.pos)
      if (this.controls && saved.target) {
        this.controls.target.copy(saved.target)
        this.controls.update()
      } else this.camera.lookAt(...viewCamera(this.bounds, saved.view, this.camera.fov, this.camera.aspect).target)
      this.render()
    }
    return url
  }

  dispose(): void {
    this.disposed = true
    this.clear()
    for (const g of this.geometries.values()) g.dispose()
    this.geometries.clear()
    this.controls?.dispose()
    this.stage.dispose()
    this.output.dispose()
    this.renderer.dispose()
  }
}
