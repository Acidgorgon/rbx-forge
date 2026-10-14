// The Ability Composer's WebGL preview: a blocky R15 or R6 dummy (the clip's rig) posed by the move's animation (placeholder
// pose track or Animation Lab clip, Motor6D maths in shared/ability/rig.ts), root movement from move
// events, one VFX Lab layer (pages/vfx/preview/fxLayer.ts) per VFX event spawned at its part or
// attachment CFrame when the event starts (like Effect.play(cframe) in game), and camera shake on top
// of the orbit camera. Screen effects are drawn by the DOM overlay (ScreenFx) from screenAt(). It is
// an approximation of Roblox, the same way the VFX Lab preview is.

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { attachWorldFor, partsFor, partSize, ROOT_HEIGHT, solveRigFor } from '@shared/ability/rig'
import { resolveAbility, rootOffset, screenAt, shakeAt, type EventLengths, type ResolvedAbility, type ScreenState } from '@shared/ability/timing'
import type { Ability, AbilityRig, BodyPart, VfxEvent } from '@shared/ability/types'
import type { CFrameArr, VfxEffect } from '@shared/vfx/types'
import { FxLayer } from '../../vfx/preview/fxLayer'
import { TextureCache, type Background, type TextureResolver } from '../../vfx/preview/scene'
import { LinearOutput, srgbColor, Stage } from '../../vfx/preview/stage'
import { PoseTrack } from './pose'

export type AbilityView = 'front' | 'side' | 'wide' | 'back'

const VIEWS: Record<AbilityView, { pos: [number, number, number]; target: [number, number, number] }> = {
  front: { pos: [6.5, 5.5, -10.5], target: [0, 3, -2] },
  side: { pos: [18, 6, -6], target: [0, 3, -6] },
  wide: { pos: [16, 12, -26], target: [0, 3, -10] },
  back: { pos: [3, 6, 9], target: [0, 3, -4] }
}

export interface AbilityFrame {
  particles: number
  screen: ScreenState
  shake: number
  clipTime: number | null
}

function cframeMatrix(c: CFrameArr, m = new THREE.Matrix4()): THREE.Matrix4 {
  return m.set(c[3], c[4], c[5], c[0], c[6], c[7], c[8], c[1], c[9], c[10], c[11], c[2], 0, 0, 0, 1)
}

function rootAt(resolved: ResolvedAbility, t: number): CFrameArr {
  const o = rootOffset(resolved, t)
  return [o[0], ROOT_HEIGHT + o[1], o[2], 1, 0, 0, 0, 1, 0, 0, 0, 1]
}

function buildRig(rig: AbilityRig = 'R15'): { group: THREE.Group; parts: Map<BodyPart, THREE.Mesh>; rig: AbilityRig } {
  const group = new THREE.Group()
  const mat = new THREE.MeshStandardMaterial({ color: srgbColor(0x9aa1ab), roughness: 0.85, metalness: 0 })
  const face = new THREE.MeshStandardMaterial({ color: srgbColor(0x6f7782), roughness: 0.85, metalness: 0 })
  const parts = new Map<BodyPart, THREE.Mesh>()
  for (const p of partsFor(rig)) {
    if (p === 'HumanoidRootPart') continue
    const [w, h, d] = partSize(rig, p)
    const geo = p === 'Head' ? new THREE.SphereGeometry(0.62, 24, 16).scale(1.1, 1, 1.1) : new THREE.BoxGeometry(w * 0.98, h * 0.98, d * 0.98)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.matrixAutoUpdate = false
    group.add(mesh)
    parts.set(p, mesh)
  }
  // A small "nose" so the facing (-Z) reads in every view.
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 0.2), face)
  nose.position.set(0, 0, -0.66)
  parts.get('Head')!.add(nose)
  return { group, parts, rig }
}

interface VfxLayerSlot {
  event: VfxEvent
  layer: FxLayer
  start: number
  length: number
}

export class AbilityScene {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly controls: OrbitControls | null
  private rig = buildRig()
  private textures: TextureCache
  private slots: VfxLayerSlot[] = []
  private pose = new PoseTrack()
  private resolved: ResolvedAbility = { events: [], markers: [], animation: null, end: 0 }
  private ability: Ability | null = null
  private loadSeq = 0
  private disposed = false
  private shake = { offset: [0, 0, 0] as number[], roll: 0, strength: 0 }
  // Reduced motion: the camera does not shake (the HUD still reports it).
  shakeEnabled = true
  private stage: Stage
  private output: LinearOutput

  constructor(canvas: HTMLCanvasElement, opts: { resolver?: TextureResolver; interactive?: boolean; background?: Background } = {}) {
    THREE.ColorManagement.enabled = false
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false })
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace
    this.renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1))
    this.textures = new TextureCache(opts.resolver ?? null)
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000)
    this.controls = opts.interactive === false ? null : new OrbitControls(this.camera, canvas)
    if (this.controls) this.controls.enableDamping = false
    this.setView('front')
    this.output = new LinearOutput(this.renderer)
    this.stage = new Stage(this.scene, opts.background ?? 'dark')
    this.scene.add(this.rig.group)
  }

  setView(view: AbilityView): void {
    const v = VIEWS[view] ?? VIEWS.front
    this.camera.position.set(...v.pos)
    if (this.controls) {
      this.controls.target.set(...v.target)
      this.controls.update()
    } else this.camera.lookAt(...v.target)
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

  get duration(): number {
    return this.ability?.duration ?? 2
  }

  get timeline(): ResolvedAbility {
    return this.resolved
  }

  get rigType(): AbilityRig {
    return this.rig.rig
  }

  get poseMissing(): boolean {
    return this.pose.missing
  }

  // Loads a move and its VFX Lab effects (by library entry id). Resolves when textures are ready.
  // Clip samples are cached per clip; reloadPose samples the Animation Lab clip again.
  async load(ability: Ability, effects: Record<string, VfxEffect>, opts: { reloadPose?: boolean } = {}): Promise<void> {
    const seq = ++this.loadSeq
    const lengths: EventLengths = { vfx: (id) => effects[id]?.duration }
    this.ability = ability
    this.resolved = resolveAbility(ability, lengths)
    await this.pose.load(ability.animation, opts.reloadPose)
    if (seq !== this.loadSeq) return
    if (this.pose.rig !== this.rig.rig) {
      this.scene.remove(this.rig.group)
      for (const m of this.rig.parts.values()) m.geometry.dispose()
      this.rig = buildRig(this.pose.rig)
      this.scene.add(this.rig.group)
    }
    for (const s of this.slots) {
      s.layer.clear()
      this.scene.remove(s.layer.group)
    }
    this.slots = []
    const waits: Promise<void>[] = []
    for (const r of this.resolved.events) {
      if (r.event.kind !== 'vfx') continue
      const fx = effects[r.event.effect]
      if (!fx) continue
      const layer = new FxLayer(this.camera, this.textures.get)
      layer.group.matrixAutoUpdate = false
      layer.group.visible = false
      this.scene.add(layer.group)
      // Placed where the part (or attachment) is when the event starts, like Effect.play(cframe).
      const parts = solveRigFor(this.rig.rig, rootAt(this.resolved, r.start), this.pose.at(r.start))
      cframeMatrix(attachWorldFor(this.rig.rig, parts, r.event.part, r.event.attachment, r.event.offset, r.event.rotation), layer.group.matrix)
      layer.group.matrixWorldNeedsUpdate = true
      this.slots.push({ event: r.event, layer, start: r.start, length: fx.duration })
      waits.push(layer.load({ ...fx, anchor: [0, 0, 0], motion: 'static' }, 1))
    }
    await Promise.all(waits)
  }

  // Poses the dummy, runs every VFX layer and works out shake and screen effects at ability time t.
  setTime(t: number): AbilityFrame {
    const parts = solveRigFor(this.rig.rig, rootAt(this.resolved, t), this.pose.at(t))
    for (const [name, mesh] of this.rig.parts) {
      cframeMatrix(parts[name], mesh.matrix)
      mesh.matrixWorldNeedsUpdate = true
    }
    let particles = 0
    for (const s of this.slots) {
      const local = t - s.start
      const on = local >= 0 && local <= s.length + 1e-3
      s.layer.group.visible = on
      if (on) particles += s.layer.setTime(local).particles
    }
    this.shake = shakeAt(this.resolved, t)
    return { particles, screen: screenAt(this.resolved, t), shake: this.shake.strength, clipTime: this.pose.clipTime(t) }
  }

  render(): void {
    if (this.disposed) return
    const strength = this.shakeEnabled ? this.shake.strength : 0
    if (strength <= 1e-4) {
      this.output.render(this.scene, this.camera)
      return
    }
    // Shake in camera space on top of the orbit camera (the runner does camera.CFrame * offset), restored after the frame.
    const pos = this.camera.position.clone()
    const quat = this.camera.quaternion.clone()
    const [x, y, z] = this.shake.offset
    this.camera.translateX(x)
    this.camera.translateY(y)
    this.camera.translateZ(z)
    this.camera.rotateZ(this.shake.roll)
    this.camera.updateMatrixWorld()
    this.output.render(this.scene, this.camera)
    this.camera.position.copy(pos)
    this.camera.quaternion.copy(quat)
    this.camera.updateMatrixWorld()
  }

  snapshot(): string {
    this.render()
    return this.renderer.domElement.toDataURL('image/png')
  }

  usesPlaceholders(): Promise<boolean> {
    return this.textures.usesPlaceholders()
  }

  dispose(): void {
    this.disposed = true
    for (const s of this.slots) s.layer.clear()
    this.slots = []
    this.controls?.dispose()
    this.textures.dispose()
    this.stage.dispose()
    this.output.dispose()
    this.renderer.dispose()
  }
}
