// Which effects an imported instance tree holds (a .rbxm / .rbxmx, a place file, or a Studio
// selection read through the Forge Bridge). Pure code: main (services/vfx) and tests use it.
//
// Rules, in order:
//  - A pack container is split into one entry per child that has content (emitters, beams, trails,
//    lights or visible geometry):
//      a Folder whose content children include at least one Model / Folder (a mix of effect Models
//        and loose Parts / MeshParts / Attachments splits too: each loose part with its own emitters
//        or geometry is its own entry, named after it). Folders inside a pack that are packs
//        themselves are split again (VFX/Combat/...).
//      a Model with nothing of its own (every child with emitters or visible parts is a Model /
//        Folder, two or more of them with emitters).
//  - Several top-level roots with two or more effect Models / Folders among them (the children of a
//    pack selected in Studio) are a pack too.
//  - Several loose top-level Parts selected together (not inside a pack folder) stay one effect:
//    they keep their relative positions. One effect plus loose visible parts next to it is one effect.
//  - No emitters at all: the visible geometry is the effect (a slash mesh tweened by a script).
//  - Duplicate names get " (2)", " (3)" suffixes.

import { allNodes, pruneToVfx } from './analyze.ts'
import { PART_CLASSES } from './schema.ts'
import { revealedByCues, tweenCuesFromScripts } from './scriptTweens.ts'
import type { VfxNode } from './types.ts'

export interface EffectGroup {
  name: string
  nodes: VfxNode[]
}

const VFX_CLASSES = new Set(['ParticleEmitter', 'Beam', 'Trail', 'PointLight', 'SpotLight', 'SurfaceLight', 'Highlight'])
// What makes a child of a place folder count as an effect when looking for packs.
const PACK_FX = new Set(['ParticleEmitter', 'Beam', 'Trail'])
// A folder with this many effect children is offered / imported as a VFX pack.
export const PACK_MIN_EFFECTS = 3
const PACK_NAME = /vfx|fx|effect|particle/i
// Where place files and Studio keep VFX packs.
export const PACK_SERVICES = ['Workspace', 'ReplicatedStorage', 'ServerStorage']

const isGroup = (n: VfxNode) => n.className === 'Model' || n.className === 'Folder'

export function splitEffects(roots: VfxNode[], opts: { packs?: boolean } = {}): EffectGroup[] {
  const hasVfx = (n: VfxNode) => allNodes([n]).some((x) => VFX_CLASSES.has(x.className))
  // Visible geometry (as authored or revealed by a script's tween / set).
  const revealed = revealedByCues(tweenCuesFromScripts(roots))
  const hasGeometry = (n: VfxNode) => pruneToVfx([n], revealed).some((k) => allNodes([k]).some((x) => PART_CLASSES.has(x.className)))
  const hasContent = (n: VfxNode) => hasVfx(n) || hasGeometry(n)

  // The children a pack container splits into; null when the container is one effect.
  const packKids = (n: VfxNode): VfxNode[] | null => {
    if (!isGroup(n)) return null
    const kids = n.children.filter(hasContent)
    if (n.className === 'Folder') return kids.length >= 2 && kids.some(isGroup) ? kids : null
    // A Model splits only when it has nothing of its own (no emitters or visible parts outside its
    // child Models / Folders).
    return kids.length > 1 && kids.every(isGroup) && kids.filter(hasVfx).length > 1 ? kids : null
  }
  // A child of a pack: its own entry, or (a Folder that is a pack itself) its children.
  const expand = (n: VfxNode, depth = 0): EffectGroup[] => {
    const kids = depth < 6 && n.className === 'Folder' ? packKids(n) : null
    return kids ? kids.flatMap((k) => expand(k, depth + 1)) : [{ name: n.name, nodes: [n] }]
  }
  const split = (n: VfxNode): EffectGroup[] => {
    const kids = packKids(n)
    return kids ? kids.flatMap((k) => expand(k)) : [{ name: n.name, nodes: [n] }]
  }

  if (opts.packs) {
    // Each root is a pack (found in a place file): every child with content is an effect.
    return dedupeNames(roots.flatMap((r) => (isGroup(r) ? r.children.filter(hasContent).flatMap((k) => expand(k)) : hasContent(r) ? [{ name: r.name, nodes: [r] }] : [])))
  }

  const content = roots.filter(hasContent)
  const withVfx = roots.filter(hasVfx)
  if (!content.length) return []
  if (content.length > 1 && (content.filter((n) => isGroup(n) && hasVfx(n)).length >= 2 || content.some((n) => n.className === 'Folder' && packKids(n)))) {
    // The children of a pack selected together (or several effect Models): one entry each.
    return dedupeNames(content.flatMap((n) => (n.className === 'Folder' ? split(n) : [{ name: n.name, nodes: [n] }])))
  }
  if (withVfx.length > 1) return [{ name: withVfx[0].name, nodes: roots }]
  if (withVfx.length === 1) {
    const only = withVfx[0]
    if (packKids(only)) return dedupeNames(split(only))
    // Visible geometry next to the effect (loose parts selected with it) stays in it.
    const extra = roots.filter((r) => r !== only && hasGeometry(r))
    return [{ name: only.name, nodes: [only, ...extra] }]
  }
  // No emitters at all: the visible geometry is the effect (one entry), unless it is a folder of
  // separate geometry effects.
  if (content.length === 1) return dedupeNames(content[0].className === 'Folder' ? split(content[0]) : [{ name: content[0].name, nodes: content }])
  return [{ name: content[0].name, nodes: roots }]
}

// "Slash", "Slash", "Slash" -> "Slash", "Slash (2)", "Slash (3)" (case-insensitive; never reuses a
// name that is already there).
export function dedupeNames<T extends { name: string }>(groups: T[]): T[] {
  const used = new Set<string>()
  const count = new Map<string, number>()
  return groups.map((g) => {
    const base = g.name.trim() || 'Effect'
    let n = count.get(base.toLowerCase()) ?? 0
    let name = base
    while (used.has(name.toLowerCase())) {
      n++
      name = `${base} (${n + 1})`
    }
    count.set(base.toLowerCase(), n)
    used.add(name.toLowerCase())
    return name === g.name ? g : { ...g, name }
  })
}

// ------------------------------------------------------------------ packs in a place

export interface FoundPack {
  node: VfxNode
  // Names from the service down ("Workspace", "VFX").
  path: string[]
  effects: number
}

// Folders / Models that look like VFX packs: at least PACK_MIN_EFFECTS children with a
// ParticleEmitter / Beam / Trail inside (or a name like "VFX" / "Effects" and one such child), in
// the place's Workspace / ReplicatedStorage / ServerStorage. Top-most only (a pack's own subfolders
// are split by splitEffects). `roots` are the place's services (DataModel children).
export function findVfxPacks(roots: VfxNode[], services: string[] = PACK_SERVICES): FoundPack[] {
  const out: FoundPack[] = []
  const hasFx = (n: VfxNode) => allNodes([n]).some((x) => PACK_FX.has(x.className))
  const visit = (n: VfxNode, path: string[], depth: number) => {
    if (depth > 12 || out.length >= 100) return
    if (isGroup(n)) {
      const effects = n.children.filter(hasFx).length
      if (effects >= PACK_MIN_EFFECTS || (effects >= 1 && PACK_NAME.test(n.name))) {
        out.push({ node: n, path, effects })
        return
      }
    }
    for (const c of n.children) if (isGroup(c)) visit(c, [...path, c.name], depth + 1)
  }
  for (const s of roots) {
    if (!services.includes(s.className)) continue
    for (const c of s.children) if (isGroup(c)) visit(c, [s.className, c.name], 1)
  }
  return out
}
