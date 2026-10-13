// The Animation Lab's WebGL preview: a blocky R15 dummy (shared/anim/r15.ts proportions, feet on
// y = 0, facing -Z) or, for R6 clips, the R6 dummy (shared/anim/r6.ts: Head, Torso, one part per arm
// and leg on the default R6 Motor6Ds) posed by forward kinematics from the clip at time t, an optional ghost of a
// library reference clip, onion skins (earlier and later poses), a floor grid and three cameras.
// The same scene renders offscreen for the critic (AnimCapture).

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { AnimClip, RigType } from '@shared/anim/model'
import { drawPartNames, drawSize, partRole, posedParts, type PartRole } from '@shared/anim/posed'
import { clipRig } from '@shared/anim/sample'

export type AnimView = 'front' | 'side' | 'wide'

const VIEWS: Record<AnimView, { pos: [number, number, number]; target: [number, number, number] }> = {
  front: { pos: [6.4, 4.8, -9.8], target: [0, 2.4, -0.6] },
  side: { pos: [12, 3.6, -1.2], target: [0, 2.4, -1.2] },
  wide: { pos: [9, 7.5, -14], target: [0, 2.2, -2.5] }
}

function partColor(role: PartRole, side?: 'Left' | 'Right'): number {
  if (role === 'head') return 0xd9d4ca
  if (role === 'torso') return 0x4f7fc4
  if (role === 'lowerTorso') return 0x41679f
  if (role === 'upperLeg' || role === 'lowerLeg' || role === 'foot' || role === 'leg') return side === 'Right' ? 0x55617a : 0x3d4656
  return side === 'Right' ? 0xc2ab8d : 0x8e96a2
}

interface Rig {
  rig: RigType
  group: THREE.Group
  meshes: Map<string, THREE.Mesh>
}

function buildRig(opts: { ghost?: number; opacity?: number; rig?: RigType } = {}): Rig {
  const rig = opts.rig ?? 'R15'
  const group = new THREE.Group()
  const meshes = new Map<string, THREE.Mesh>()
  for (const p of drawPartNames(rig)) {
    const s = drawSize(rig, p)
    const role = partRole(rig, p)
    const torso = role === 'torso' || role === 'lowerTorso'
    const inset = role === 'head' ? 0.92 : torso ? 1 : 0.9
    const geo = new THREE.BoxGeometry(s[0] * inset, s[1] * (torso ? 1 : 0.98), s[2] * inset)
    const ghost = opts.ghost !== undefined
    const mat = ghost
      ? new THREE.MeshBasicMaterial({ color: opts.ghost, transparent: true, opacity: opts.opacity ?? 0.25, depthWrite: false })
      : new THREE.MeshStandardMaterial({ color: partColor(role, p.startsWith('Left') ? 'Left' : p.startsWith('Right') ? 'Right' : undefined), roughness: 0.8, metalness: 0 })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.matrixAutoUpdate = false
    if (!ghost) {
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x0b0d10, transparent: true, opacity: 0.55 }))
      mesh.add(edges)
    }
    group.add(mesh)
    meshes.set(p, mesh)
  }
  return { rig, group, meshes }
}

function poseRig(rig: Rig, clip: AnimClip | null, t: number, travel: boolean): void {
  const parts = new Map(posedParts(clip, t, travel, rig.rig).map((p) => [p.name, p.x]))
  const q = new THREE.Quaternion()
  const v = new THREE.Vector3()
  const one = new THREE.Vector3(1, 1, 1)
  for (const [p, mesh] of rig.meshes) {
    const x = parts.get(p)
    if (!x) continue
    q.set(x.q[0], x.q[1], x.q[2], x.q[3])
    v.set(x.p[0], x.p[1], x.p[2])
    mesh.matrix.compose(v, q, one)
    mesh.matrixWorldNeedsUpdate = true
  }
}

function disposeRig(rig: Rig): void {
  rig.group.traverse((o) => {
    const m = o as THREE.Mesh
    m.geometry?.dispose()
    const mat = m.material as THREE.Material | undefined
    mat?.dispose()
  })
}

export class AnimScene {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly controls: OrbitControls | null
  private rig = buildRig()
  private ghost = buildRig({ ghost: 0x6fd3c4, opacity: 0.28 })
  private onions: { rig: Rig; dt: number }[] = []
  private clip: AnimClip | null = null
  private reference: AnimClip | null = null
  private onion = 0
  private onionStep = 0.08
  travel = true

  constructor(canvas: HTMLCanvasElement, opts: { interactive?: boolean; light?: boolean } = {}) {
    THREE.ColorManagement.enabled = false
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false })
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace
    this.renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1))
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500)
    this.controls = opts.interactive === false ? null : new OrbitControls(this.camera, canvas)
    this.setView('front')
    this.setTheme(opts.light ? 'light' : 'dark')
    this.scene.add(new THREE.HemisphereLight(0xe6ecf3, 0x30343a, 1.15))
    const sun = new THREE.DirectionalLight(0xffffff, 1.25)
    sun.position.set(6, 12, -8)
    this.scene.add(sun)
    this.ghost.group.visible = false
    this.scene.add(this.ghost.group)
    this.scene.add(this.rig.group)
    poseRig(this.rig, null, 0, true)
  }

  private grid: THREE.GridHelper | null = null
  private floor: THREE.Mesh | null = null

  setTheme(theme: 'dark' | 'light'): void {
    const dark = theme === 'dark'
    this.scene.background = new THREE.Color(dark ? 0x0d1014 : 0xe9ebee)
    if (this.grid) this.scene.remove(this.grid)
    if (this.floor) this.scene.remove(this.floor)
    this.grid = new THREE.GridHelper(40, 40, dark ? 0x3a4048 : 0xb5bac2, dark ? 0x22262c : 0xd2d6db)
    this.scene.add(this.grid)
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: dark ? 0x14171b : 0xdfe2e6, roughness: 1 }))
    this.floor.rotation.x = -Math.PI / 2
    this.floor.position.y = -0.01
    this.scene.add(this.floor)
  }

  setView(view: AnimView): void {
    const v = VIEWS[view] ?? VIEWS.front
    this.camera.position.set(...v.pos)
    if (this.controls) {
      this.controls.target.set(...v.target)
      this.controls.update()
    } else this.camera.lookAt(...v.target)
  }

  // The dummy follows the clip's rig (R15 or R6); rebuilt when it changes.
  setClip(clip: AnimClip | null): void {
    this.clip = clip
    const rig = clipRig(clip)
    if (rig !== this.rig.rig) {
      this.scene.remove(this.rig.group)
      disposeRig(this.rig)
      this.rig = buildRig({ rig })
      this.scene.add(this.rig.group)
      const n = this.onion
      this.onion = -1
      this.setOnion(n, this.onionStep)
    }
  }

  get rigType(): RigType {
    return this.rig.rig
  }

  setReference(clip: AnimClip | null): void {
    this.reference = clip
    const rig = clipRig(clip)
    if (clip && rig !== this.ghost.rig) {
      this.scene.remove(this.ghost.group)
      disposeRig(this.ghost)
      this.ghost = buildRig({ ghost: 0x6fd3c4, opacity: 0.28, rig })
      this.scene.add(this.ghost.group)
    }
    this.ghost.group.visible = !!clip
  }

  // n onion skins on each side, step seconds apart.
  setOnion(n: number, step = 0.08): void {
    this.onionStep = step
    if (n === this.onion) return
    for (const o of this.onions) {
      this.scene.remove(o.rig.group)
      disposeRig(o.rig)
    }
    this.onions = []
    this.onion = n
    for (let i = 1; i <= n; i++) {
      for (const sign of [-1, 1]) {
        const rig = buildRig({ ghost: sign < 0 ? 0x7c8cff : 0xffa86b, opacity: 0.16 / i + 0.04, rig: this.rig.rig })
        this.scene.add(rig.group)
        this.onions.push({ rig, dt: sign * i })
      }
    }
  }

  get duration(): number {
    return this.clip?.duration ?? 1
  }

  setTime(t: number): void {
    poseRig(this.rig, this.clip, t, this.travel)
    if (this.reference) poseRig(this.ghost, this.reference, this.reference.looped ? t : Math.min(t, this.reference.duration), this.travel)
    for (const o of this.onions) {
      const tt = t + o.dt * this.onionStep
      const D = this.duration
      const visible = !!this.clip && (this.clip.looped || (tt >= 0 && tt <= D))
      o.rig.group.visible = visible
      if (visible) poseRig(o.rig, this.clip, tt, this.travel)
    }
  }

  resize(width: number, height: number): void {
    if (width < 2 || height < 2) return
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  render(): void {
    this.renderer.render(this.scene, this.camera)
  }

  snapshot(): string {
    this.render()
    return this.renderer.domElement.toDataURL('image/png')
  }

  dispose(): void {
    this.controls?.dispose()
    disposeRig(this.rig)
    disposeRig(this.ghost)
    for (const o of this.onions) disposeRig(o.rig)
    this.renderer.dispose()
  }
}
