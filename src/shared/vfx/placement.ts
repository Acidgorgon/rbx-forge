// Where an effect sits on the stage. Effects imported from Studio or a .rbxm keep the world positions
// they had in their place (a Part at (120, 40, -300)); the preview, the critic's frame renders and
// the exported Luau module all play an effect relative to a root (the dummy's chest in the preview,
// the CFrame given to Effect.play in game), so the effect's anchor point has to sit at that root.
//
// One pure function decides it for every consumer (simulate.ts prepareEffect, luau.ts luauModule,
// the exported Effect.rbxmx): centreEffect returns a copy whose content is moved so the anchor is at
// the origin, keeping the parts' layout relative to each other. Stored library entries are never
// rewritten; an effect authored at the origin comes back unchanged (the same object).
//
// The anchor (effectAnchor), among the parts that move:
//   1. a root part: the single top-level Part, or a Part named "Root" at the top level / directly
//      under the single top-level Model (what the game module uses as PrimaryPart);
//   2. else the bounds centre of the parts that carry the effect (a ParticleEmitter, Beam, Trail or
//      light in their own subtree, through Attachments / Bones);
//   3. else the bounds centre of every part (geometry-only effects: a slash mesh);
//   4. no parts: the origin (attachments are already relative to the root).
// Which parts move: every part, except in a scripted effect ('local' space), where the timeline's
// kit rigs and the Root it made are already placed relative to the root and stay put: only the
// effect the script was built on (a library copy, e.g. an imported effect) moves. Tween / set goals
// recorded with the effect (CFrame, Position: world positions from an import) move with their part;
// goals written by the timeline script are in the effect's space already and do not.

import { PART_CLASSES } from './schema.ts'
import type { CFrameArr, PropValue, Vec3, VfxCue, VfxEffect, VfxNode } from './types.ts'

const CARRIERS = new Set(['ParticleEmitter', 'Beam', 'Trail', 'PointLight', 'SpotLight', 'SurfaceLight'])
// Below this distance (studs) the effect counts as authored at the origin.
const EPS = 1e-6

export interface EffectPlacement {
  // The authored point that belongs at the root (stage origin).
  anchor: Vec3
  // Ids of the parts that move by -anchor.
  moved: Set<string>
}

function partPos(n: VfxNode): Vec3 {
  const c = n.props.CFrame
  return Array.isArray(c) && c.length === 12 ? [Number(c[0]) || 0, Number(c[1]) || 0, Number(c[2]) || 0] : [0, 0, 0]
}

function allParts(nodes: VfxNode[], out: VfxNode[] = []): VfxNode[] {
  for (const n of nodes) {
    if (PART_CLASSES.has(n.className)) out.push(n)
    allParts(n.children, out)
  }
  return out
}

// A part carries the effect when an emitter / beam / trail / light sits in its own subtree (not
// inside a nested part, which counts on its own).
function carries(n: VfxNode): boolean {
  const walk = (k: VfxNode): boolean => CARRIERS.has(k.className) || (!PART_CLASSES.has(k.className) && k.children.some(walk))
  return n.children.some(walk)
}

function boundsCentre(ps: Vec3[]): Vec3 {
  const lo: Vec3 = [Infinity, Infinity, Infinity]
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const p of ps)
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], p[i])
      hi[i] = Math.max(hi[i], p[i])
    }
  return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
}

// The parts at the top of the effect: the roots, or the children of a single top-level Model.
function topLevel(effect: Pick<VfxEffect, 'roots'>): VfxNode[] {
  const r = effect.roots
  return r.length === 1 && r[0].className === 'Model' ? r[0].children : r
}

// The Root part a timeline script added (compile.ts scriptBase): invisible, at the origin, holding
// nothing but the script's own rigs. It is the effect's root in game (PrimaryPart) and never moves.
function madeRoot(effect: Pick<VfxEffect, 'roots'>): VfxNode | null {
  const n = topLevel(effect).find((k) => k.className === 'Part' && k.name === 'Root')
  if (!n || Number(n.props.Transparency ?? 0) < 1 || n.children.some((k) => !k.kit)) return null
  const p = partPos(n)
  return Math.hypot(p[0], p[1], p[2]) < EPS ? n : null
}

export function effectPlacement(effect: Partial<VfxEffect> & Pick<VfxEffect, 'roots'>): EffectPlacement {
  const local = effect.space === 'local'
  const skip = local ? madeRoot(effect) : null
  const parts = allParts(effect.roots).filter((n) => n !== skip && !(local && n.kit))
  const moved = new Set(parts.map((n) => n.id))
  if (!parts.length) return { anchor: [0, 0, 0], moved }
  const top = topLevel(effect)
  const rootPart = (effect.roots.length === 1 && PART_CLASSES.has(effect.roots[0].className) ? effect.roots[0] : null) ?? top.find((n) => PART_CLASSES.has(n.className) && n.name === 'Root') ?? null
  if (rootPart && moved.has(rootPart.id)) return { anchor: partPos(rootPart), moved }
  const carriers = parts.filter(carries)
  return { anchor: boundsCentre((carriers.length ? carriers : parts).map(partPos)), moved }
}

// The authored point of the effect that the preview / game module puts at the root.
export function effectAnchor(effect: Partial<VfxEffect> & Pick<VfxEffect, 'roots'>): Vec3 {
  return effectPlacement(effect).anchor
}

function shiftCFrame(v: PropValue, d: Vec3): PropValue {
  if (!Array.isArray(v) || v.length !== 12) return v
  const c = v as CFrameArr
  return [c[0] + d[0], c[1] + d[1], c[2] + d[2], ...c.slice(3)]
}

function shiftPosition(v: PropValue, d: Vec3): PropValue {
  if (!Array.isArray(v) || v.length !== 3) return v
  const p = v as number[]
  return [p[0] + d[0], p[1] + d[1], p[2] + d[2]]
}

// The effect with its anchor at the origin (the relative layout of its parts kept). Returns the
// same object when there is nothing to move, so origin-authored effects play exactly as before.
export function centreEffect<T extends VfxEffect>(effect: T): T {
  const { anchor, moved } = effectPlacement(effect)
  if (Math.hypot(anchor[0], anchor[1], anchor[2]) < EPS) return effect
  const d: Vec3 = [-anchor[0], -anchor[1], -anchor[2]]
  const copy = (n: VfxNode): VfxNode => {
    const next: VfxNode = { ...n, children: n.children.map(copy) }
    if (moved.has(n.id)) next.props = { ...n.props, CFrame: shiftCFrame(n.props.CFrame ?? [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], d) }
    return next
  }
  const cues = effect.cues.map((c): VfxCue => {
    if (c.script || !c.props || !moved.has(c.target) || (c.props.CFrame === undefined && c.props.Position === undefined)) return c
    const props = { ...c.props }
    if (props.CFrame !== undefined) props.CFrame = shiftCFrame(props.CFrame, d)
    if (props.Position !== undefined) props.Position = shiftPosition(props.Position, d)
    return { ...c, props }
  })
  return { ...effect, roots: effect.roots.map(copy), cues }
}
