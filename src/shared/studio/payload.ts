// Builds Forge Bridge jobs from lab data. Jobs carry everything the plugin needs (the same Luau
// modules Forge writes into the project, and the clip as KeyframeSequence data), so a Studio check
// does not depend on Rojo having synced the latest edit; each refine iteration plays exactly the
// version being judged.

import { stageAt, stageFrameTimes } from '../vfx/critique.ts'
import { luauModule, needsRuntime, timelineModule } from '../vfx/luau.ts'
import { FORGEFX_SOURCE, RUNTIME_MODULE } from '../vfx/runtime.ts'
import { parseXml, type XmlEl } from '../vfx/rbxmx.ts'
import type { VfxEffect } from '../vfx/types.ts'
import { writeKeyframeSequenceXml } from '../anim/rbxmx.ts'
import { clipRig } from '../anim/sample.ts'
import type { AnimClip, AnimJoint, AnimKey } from '../anim/model.ts'
import { abilityModule, runnerModule, RUNNER_MODULE } from '../ability/luau.ts'
import { placeholderClips, placeholderPose, isPlaceholder } from '../ability/placeholder.ts'
import type { Ability } from '../ability/types.ts'
import { KEY_COLOR } from './crop.ts'
import { BRIDGE_VERSION, type BridgeBeat, type BridgeCamera, type BridgeJob, type BridgeModule, type InstanceJson, type PropJson } from './protocol.ts'

// The previews' "front" views (pages/*/preview), so Studio frames line up with the preview frames.
export const CAMERAS: Record<Exclude<BridgeJob['kind'], 'snapshot' | 'delete'>, BridgeCamera> = {
  vfx: { pos: [5.5, 5.2, -9.5], target: [0, 3.2, -1], fov: 70 },
  anim: { pos: [6.4, 4.8, -9.8], target: [0, 2.4, -0.6], fov: 50 },
  ability: { pos: [6.5, 5.5, -10.5], target: [0, 3, -2], fov: 70 }
}

// Where the plugin puts the job's modules (CoreGui: not saved with the place, not synced by Rojo or
// the template's studio-sync plugin). The plugin points AbilityRunner.VfxPath at the real folder.
export const JOB_ROOT = ['CoreGui', 'ForgeBridgeJob']

// ------------------------------------------------------------ instances from .rbxmx XML

const CF_KEYS = ['X', 'Y', 'Z', 'R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22']

function propOf(el: XmlEl): PropJson | null {
  const kids = (n: string) => el.children.find((c) => c.name === n)?.text ?? '0'
  switch (el.name) {
    case 'string':
    case 'ProtectedString':
      return { t: 'string', v: el.text }
    case 'bool':
      return { t: 'bool', v: el.text.trim() === 'true' }
    case 'float':
    case 'double':
    case 'int':
    case 'int64':
      return { t: 'number', v: Number(el.text) || 0 }
    case 'token':
      return { t: 'token', v: Number(el.text) || 0 }
    case 'CoordinateFrame':
      return { t: 'cframe', v: CF_KEYS.map((k) => Number(kids(k)) || 0) }
    case 'Vector3':
      return { t: 'vector3', v: [Number(kids('X')) || 0, Number(kids('Y')) || 0, Number(kids('Z')) || 0] }
    case 'Color3':
      return { t: 'color3', v: [Number(kids('R')) || 0, Number(kids('G')) || 0, Number(kids('B')) || 0] }
    default:
      return null
  }
}

function itemOf(el: XmlEl): InstanceJson {
  const props: Record<string, PropJson> = {}
  let name = el.attrs.class ?? 'Folder'
  const propsEl = el.children.find((c) => c.name === 'Properties')
  for (const p of propsEl?.children ?? []) {
    const key = p.attrs.name
    if (!key) continue
    const v = propOf(p)
    if (!v) continue
    if (key === 'Name' && v.t === 'string') name = v.v
    else props[key] = v
  }
  return { className: el.attrs.class ?? 'Folder', name, props, children: el.children.filter((c) => c.name === 'Item').map(itemOf) }
}

// Top-level items of an .rbxmx document as plain instance data (the types a KeyframeSequence uses).
export function rbxmxToInstances(xml: string): InstanceJson[] {
  const root = parseXml(xml)
  const doc = root.children.find((c) => c.name === 'roblox') ?? root
  return doc.children.filter((c) => c.name === 'Item').map(itemOf)
}

export function sequenceJson(clip: AnimClip): InstanceJson {
  const [seq] = rbxmxToInstances(writeKeyframeSequenceXml(clip))
  return seq
}

// A built-in placeholder pose track (Ability Composer) sampled into a clip, so Studio can play it.
export function placeholderClip(id: string, fps = 20): AnimClip | null {
  const ref = placeholderClips().find((c) => c.id === id)
  if (!ref) return null
  const tracks: Partial<Record<AnimJoint, AnimKey[]>> = {}
  const n = Math.max(2, Math.ceil(ref.duration * fps))
  for (let i = 0; i <= n; i++) {
    const t = Math.round(Math.min(ref.duration, i / fps) * 1000) / 1000
    const pose = placeholderPose(id, t) ?? {}
    for (const [joint, cf] of Object.entries(pose)) {
      if (!cf) continue
      ;(tracks[joint as AnimJoint] ??= []).push({ t, cf: [...cf] })
    }
  }
  return { name: ref.name.replace(/\W+/g, ''), duration: ref.duration, looped: false, priority: 'Action', tracks, markers: ref.markers.map((m) => ({ ...m })) }
}

// ------------------------------------------------------------ jobs

interface JobBase {
  id: string
}

function vfxModules(effect: VfxEffect, name = 'Effect'): BridgeModule {
  const children: BridgeModule[] = []
  if (effect.script) children.push({ name: 'Timeline', className: 'ModuleScript', source: timelineModule(effect.script) })
  return { name, className: 'ModuleScript', source: luauModule(effect, {}), children }
}

const runtimeModule = (): BridgeModule => ({ name: RUNTIME_MODULE, className: 'ModuleScript', source: FORGEFX_SOURCE })

function linger(effect: VfxEffect): number {
  let max = 0
  const walk = (n: VfxEffect['roots'][number]) => {
    const life = n.props.Lifetime
    if (Array.isArray(life)) max = Math.max(max, Number(life[1] ?? life[0]) || 0)
    n.children.forEach(walk)
  }
  effect.roots.forEach(walk)
  return Math.min(4, max)
}

// Beat times and labels for an effect: one inside each stage, else spread over the play.
export function vfxBeats(effect: VfxEffect, n = 4): BridgeBeat[] {
  const staged = effect.stages?.length ? stageFrameTimes(effect, Math.max(n, Math.min(8, effect.stages.length))) : []
  const times = staged.length ? staged : Array.from({ length: n }, (_, i) => Math.round(effect.duration * Math.pow((i + 0.5) / n, 1.5) * 1000) / 1000)
  return times.map((t, i) => ({ t, label: stageAt(effect, t) ?? `t${i + 1}` }))
}

export function vfxJob(effect: VfxEffect, opts: JobBase & { times?: number[]; calibrate?: boolean }): BridgeJob {
  const beats = opts.times?.length ? opts.times.map((t, i) => ({ t, label: stageAt(effect, t) ?? `t${i + 1}` })) : vfxBeats(effect)
  const modules: BridgeModule[] = [vfxModules(effect)]
  if (needsRuntime(effect)) modules.unshift(runtimeModule())
  return {
    id: opts.id,
    version: BRIDGE_VERSION,
    kind: 'vfx',
    mode: 'realtime',
    name: effect.name,
    rig: 'R15',
    duration: effect.duration,
    beats,
    camera: CAMERAS.vfx,
    modules,
    entry: 'Effect',
    calibrate: opts.calibrate ?? true,
    key: KEY_COLOR,
    linger: linger(effect),
    timeout: Math.ceil(effect.duration + 40)
  }
}

export function animJob(clip: AnimClip, opts: JobBase & { times: number[]; calibrate?: boolean }): BridgeJob {
  const marker = (t: number) => clip.markers.find((m) => Math.abs(m.t - t) < 0.02)?.name
  const beat = (t: number) => [...(clip.beats ?? [])].sort((a, b) => a.at - b.at).filter((b) => b.at <= t + 1e-6).pop()?.label
  return {
    id: opts.id,
    version: BRIDGE_VERSION,
    kind: 'anim',
    mode: 'stepped',
    name: clip.name,
    rig: clipRig(clip),
    duration: clip.duration,
    beats: opts.times.map((t, i) => ({ t, label: marker(t) ?? beat(t) ?? `t${i + 1}` })),
    camera: CAMERAS.anim,
    modules: [],
    sequence: sequenceJson(clip),
    calibrate: opts.calibrate ?? true,
    key: KEY_COLOR,
    linger: 0,
    timeout: 60
  }
}

// effects: VFX Lab entry id -> effect. clip: the move's Animation Lab clip (placeholders are sampled).
export function abilityJob(ability: Ability, effects: Record<string, VfxEffect>, clip: AnimClip | null, opts: JobBase & { times: { t: number; label: string }[]; calibrate?: boolean }): BridgeJob {
  const vfx: BridgeModule[] = [runtimeModule()]
  const seen = new Set<string>()
  for (const ev of ability.events) {
    if (ev.kind !== 'vfx' || ev.muted || seen.has(ev.effectName)) continue
    const fx = effects[ev.effect]
    if (!fx) continue
    seen.add(ev.effectName)
    vfx.push(vfxModules(fx, ev.effectName))
  }
  const lengths = { vfx: (id: string) => effects[id]?.duration, stages: (id: string) => effects[id]?.stages }
  const anim = ability.animation
  const playClip = clip ?? (anim && isPlaceholder(anim.clip) ? placeholderClip(anim.clip) : null)
  let lingerS = 0
  for (const fx of Object.values(effects)) lingerS = Math.max(lingerS, linger(fx))
  return {
    id: opts.id,
    version: BRIDGE_VERSION,
    kind: 'ability',
    mode: 'realtime',
    name: ability.name,
    rig: anim?.rig === 'R6' ? 'R6' : 'R15',
    duration: ability.duration,
    beats: opts.times.map((b) => ({ t: b.t, label: b.label })),
    camera: CAMERAS.ability,
    modules: [
      { name: 'VFX', className: 'Folder', children: vfx },
      { name: RUNNER_MODULE, className: 'ModuleScript', source: runnerModule([...JOB_ROOT, 'VFX']) },
      { name: ability.name, className: 'ModuleScript', source: abilityModule(ability, lengths).source }
    ],
    entry: ability.name,
    vfxFolder: 'VFX',
    ...(playClip ? { sequence: sequenceJson(playClip) } : {}),
    calibrate: opts.calibrate ?? true,
    key: KEY_COLOR,
    linger: lingerS,
    timeout: Math.ceil(ability.duration + 40)
  }
}

// Thumbnail Lab: capture the user's own Studio viewport as it is (no stage, the camera is not moved).
// The plugin shows the key colour to find the viewport, removes it, then answers one beat.
export function snapshotJob(opts: { id: string; name?: string }): BridgeJob {
  return {
    id: opts.id,
    version: BRIDGE_VERSION,
    kind: 'snapshot',
    mode: 'stepped',
    name: opts.name ?? 'Thumbnail capture',
    rig: 'R15',
    duration: 0,
    beats: [{ t: 0, label: 'view' }],
    camera: { pos: [0, 0, 0], target: [0, 0, -1], fov: 70 },
    modules: [],
    calibrate: true,
    key: KEY_COLOR,
    linger: 0,
    timeout: 20
  }
}
