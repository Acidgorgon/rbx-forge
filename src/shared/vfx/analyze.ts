// Turns an imported instance tree into a VfxEffect (VFX nodes only, cues from scripts), and measures
// it: stats, tags, layer roles, curve shapes and the performance guard.

import { CONTAINER_CLASSES, PART_CLASSES, PART_DECOR_CLASSES, prop, SCRIPT_CLASSES, VFX_CLASSES } from './schema.ts'
import { revealedByCues, tweenCuesFromScripts } from './scriptTweens.ts'
import { curveShape, evalColorSequence, hex, sequenceMax, type CurveShape } from './sequence.ts'
import { emitterBudget, flipbookFrames, MAX_RATE, prepareEffect, simulate } from './simulate.ts'
import type { ColorSequence, NumberRange, NumberSequence, Rgb, VfxCue, VfxEffect, VfxNode, VfxStats } from './types.ts'

// Keeps VFX instances, their containers, scripts and visible parts (drawn in the preview); drops
// everything else (terrain, UI, sounds...). A part counts as visible when it is not fully
// transparent as authored, or when a script makes it visible during the play (`revealed`: ids a
// tween / set brings below Transparency 1, see scriptTweens.ts). A visible part keeps its
// SpecialMesh / Decal / Texture / SurfaceAppearance children.
export function pruneToVfx(nodes: VfxNode[], revealed: Set<string> = new Set()): VfxNode[] {
  const keep = (n: VfxNode, parentVisible: boolean): VfxNode | null => {
    const visiblePart = PART_CLASSES.has(n.className) && (n.props.Transparency === undefined || Number(n.props.Transparency) < 1 || revealed.has(n.id))
    const kids = n.children.map((c) => keep(c, visiblePart)).filter((x): x is VfxNode => !!x)
    const decor = parentVisible && PART_DECOR_CLASSES.has(n.className)
    const own = VFX_CLASSES.has(n.className) || SCRIPT_CLASSES.has(n.className) || visiblePart || decor
    if (own || (CONTAINER_CLASSES.has(n.className) && kids.some((k) => !SCRIPT_CLASSES.has(k.className) || k.children.length))) return { ...n, children: kids }
    return null
  }
  return nodes.map((n) => keep(n, false)).filter((x): x is VfxNode => !!x)
}

export function walk(nodes: VfxNode[], fn: (n: VfxNode, parent: VfxNode | null) => void, parent: VfxNode | null = null): void {
  for (const n of nodes) {
    fn(n, parent)
    walk(n.children, fn, n)
  }
}

export function allNodes(nodes: VfxNode[]): VfxNode[] {
  const out: VfxNode[] = []
  walk(nodes, (n) => out.push(n))
  return out
}

export function findNode(nodes: VfxNode[], key: string): VfxNode | null {
  const all = allNodes(nodes)
  return all.find((n) => n.id === key) ?? all.find((n) => n.name === key) ?? all.find((n) => n.name.toLowerCase() === key.toLowerCase()) ?? null
}

// Reads Emit bursts, Enabled toggles and waits out of the effect's scripts (heuristic, line by
// line): `X:Emit(20)`, `X.Enabled = false`, `task.wait(0.2)` / `wait(0.2)` advance the clock.
// `X` matches an emitter by its Name (last path segment, e.g. script.Parent.Sparks or
// effect:FindFirstChild("Sparks", true)). Loops (`for ... do`, GetDescendants) apply to all emitters.
export function cuesFromScripts(nodes: VfxNode[]): VfxCue[] {
  const targets = allNodes(nodes).filter((n) => n.className === 'ParticleEmitter' || n.className === 'Beam' || n.className === 'Trail' || /Light$/.test(n.className))
  const byName = new Map<string, VfxNode[]>()
  for (const t of targets) byName.set(t.name.toLowerCase(), [...(byName.get(t.name.toLowerCase()) ?? []), t])
  const cues: VfxCue[] = []
  for (const s of allNodes(nodes).filter((n) => SCRIPT_CLASSES.has(n.className) && n.source)) {
    let clock = 0
    for (const raw of s.source!.split('\n')) {
      const line = raw.replace(/--.*$/, '')
      const wait = /(?:task\.)?wait\s*\(\s*([\d.]+)\s*\)/.exec(line)
      const emit = /([\w"'\]\[.:()]+?)\s*:\s*Emit\s*\(\s*(\d*)\s*\)/.exec(line)
      const toggle = /([\w"'\]\[.:()]+?)\.Enabled\s*=\s*(true|false)/.exec(line)
      const resolve = (expr: string): VfxNode[] => {
        const quoted = /["']([^"']+)["']/.exec(expr)
        const last = (quoted ? quoted[1] : expr.split(/[.:]/).filter(Boolean).pop() ?? '').replace(/\W/g, '').toLowerCase()
        const hit = byName.get(last)
        if (hit) return hit
        // Loop variables (v:Emit(...) inside for ... GetDescendants): every emitter.
        return /^(v|p|e|emitter|particle|child|obj|d|desc|fx)$/i.test(last) ? targets.filter((t) => t.className === 'ParticleEmitter') : []
      }
      if (emit) for (const t of resolve(emit[1])) if (t.className === 'ParticleEmitter') cues.push({ at: round(clock), target: t.id, action: 'emit', count: emit[2] ? Number(emit[2]) : 16 })
      if (toggle) for (const t of resolve(toggle[1])) cues.push({ at: round(clock), target: t.id, action: toggle[2] === 'true' ? 'enable' : 'disable' })
      if (wait) clock += Number(wait[1]) || 0
    }
  }
  // Same target, same time, same action: keep one.
  const seen = new Set<string>()
  return cues.filter((c) => {
    const k = `${c.at}|${c.target}|${c.action}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000
}

// Burst effects whose scripts we could not read still need something to show: emitters that are
// disabled and never cued get one Emit at t=0 of Rate x 0.25 (min 8) particles.
export function defaultCues(nodes: VfxNode[], cues: VfxCue[]): VfxCue[] {
  const out = [...cues]
  for (const n of allNodes(nodes)) {
    if (n.className !== 'ParticleEmitter' || prop<boolean>(n, 'Enabled') !== false) continue
    if (cues.some((c) => c.target === n.id)) continue
    out.push({ at: 0, target: n.id, action: 'emit', count: Math.max(8, Math.round((prop<number>(n, 'Rate') || 0) * 0.25)) })
  }
  return out
}

export function effectDuration(nodes: VfxNode[], cues: VfxCue[]): number {
  let end = 0
  for (const n of allNodes(nodes)) {
    if (n.className === 'ParticleEmitter') {
      const life = (prop<NumberRange>(n, 'Lifetime') ?? [1, 1])[1]
      const last = Math.max(0, ...cues.filter((c) => c.target === n.id).map((c) => c.at))
      end = Math.max(end, last + Math.min(life, 6))
    }
    if (n.className === 'Trail') end = Math.max(end, Math.min(6, prop<number>(n, 'Lifetime')))
  }
  // Tweens and sets read from scripts (part growth / fades) end where they end.
  for (const c of cues) if (c.action === 'tween' || c.action === 'set') end = Math.max(end, c.at + (c.duration ?? 0) + 0.2)
  return Math.max(1, Math.min(10, round(end || 2)))
}

// ------------------------------------------------------------------ emit attributes
//
// The community convention for emit-on-demand VFX (the user's own effects use exactly these):
// attributes on a ParticleEmitter, or on its parent Attachment / Part / Model (the nearest ancestor
// that has one; the emitter's own value wins):
//   EmitDelay     seconds to wait before emitting (default 0)
//   EmitCount     ParticleEmitter:Emit(EmitCount) after the delay
//   EmitDuration  seconds the emitter stays Enabled after the delay; with Rate 0 the EmitCount
//                 particles are spread evenly over that time instead of one burst
// When any of them applies, they drive the emitter's timeline (the script / burst guesses do not).
// Beams and Trails with EmitDelay / EmitDuration are switched on for that window.

export const EMIT_ATTRS = ['EmitCount', 'EmitDelay', 'EmitDuration'] as const

export interface EmitAttrs {
  count?: number
  delay: number
  duration?: number
}

// The emit attributes that apply to each node id (own value, else the nearest ancestor's).
export function emitAttributes(nodes: VfxNode[]): Map<string, EmitAttrs> {
  const out = new Map<string, EmitAttrs>()
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined)
  const visit = (n: VfxNode, inherited: Partial<Record<(typeof EMIT_ATTRS)[number], number>>) => {
    const here = { ...inherited }
    for (const k of EMIT_ATTRS) {
      const v = num(n.attrs?.[k])
      if (v !== undefined) here[k] = v
    }
    if ((n.className === 'ParticleEmitter' || n.className === 'Beam' || n.className === 'Trail') && EMIT_ATTRS.some((k) => here[k] !== undefined)) {
      out.set(n.id, {
        delay: Math.max(0, Math.min(30, here.EmitDelay ?? 0)),
        ...(here.EmitCount !== undefined ? { count: Math.max(0, Math.min(10000, Math.round(here.EmitCount))) } : {}),
        ...(here.EmitDuration !== undefined && here.EmitDuration > 0 ? { duration: Math.min(30, here.EmitDuration) } : {})
      })
    }
    for (const c of n.children) visit(c, here)
  }
  for (const r of nodes) visit(r, {})
  return out
}

// Cues for attribute-driven nodes (see above).
export function cuesFromAttributes(nodes: VfxNode[], attrs = emitAttributes(nodes)): VfxCue[] {
  const cues: VfxCue[] = []
  for (const n of allNodes(nodes)) {
    const a = attrs.get(n.id)
    if (!a) continue
    const startsOn = prop<boolean>(n, 'Enabled') !== false
    if (n.className !== 'ParticleEmitter') {
      // Beams / Trails: on for [delay, delay + duration] (or from the delay on).
      if (startsOn && (a.delay > 0 || a.duration)) cues.push({ at: 0, target: n.id, action: 'disable' })
      cues.push({ at: round(a.delay), target: n.id, action: 'enable' })
      if (a.duration) cues.push({ at: round(a.delay + a.duration), target: n.id, action: 'disable' })
      continue
    }
    if (startsOn) cues.push({ at: 0, target: n.id, action: 'disable' })
    const rate = prop<number>(n, 'Rate') || 0
    if (a.duration && rate <= 0 && a.count) {
      // Spread EmitCount over EmitDuration (at most 60 steps).
      const steps = Math.max(1, Math.min(60, a.count, Math.round(a.duration * 30)))
      let sent = 0
      for (let i = 0; i < steps; i++) {
        const want = Math.round(((i + 1) * a.count) / steps)
        if (want > sent) cues.push({ at: round(a.delay + (i * a.duration) / steps), target: n.id, action: 'emit', count: want - sent })
        sent = want
      }
      continue
    }
    if (a.count) cues.push({ at: round(a.delay), target: n.id, action: 'emit', count: a.count })
    if (a.duration) {
      cues.push({ at: round(a.delay), target: n.id, action: 'enable' })
      cues.push({ at: round(a.delay + a.duration), target: n.id, action: 'disable' })
    } else if (a.count === undefined) {
      // Only a delay: a default burst then (like Emit() with no count).
      cues.push({ at: round(a.delay), target: n.id, action: 'emit', count: Math.max(8, Math.round(rate * 0.25)) })
    }
  }
  return cues
}

// What an imported model does that the preview does not reproduce, for the import note.
export function importNotes(raw: VfxNode[], effect: VfxEffect, attrs: Map<string, EmitAttrs>): string[] {
  const notes: string[] = []
  const all = allNodes(raw)
  const scripts = all.filter((n) => SCRIPT_CLASSES.has(n.className))
  if (attrs.size) notes.push(`${attrs.size} emitter${attrs.size === 1 ? '' : 's'} timed by EmitCount / EmitDelay / EmitDuration attributes.`)
  const tweens = effect.cues.filter((c) => c.action === 'tween' || c.action === 'set').length
  if (tweens) notes.push(`${tweens} tween${tweens === 1 ? '' : 's'} / set${tweens === 1 ? '' : 's'} read from scripts (TweenService:Create with literal goals, property sets) play in the preview.`)
  const logic = scripts.filter((s) => s.source && /RunService|while\s|repeat\s|require\s*\(|Heartbeat|RenderStepped|math\.random|:Connect\s*\(|GetAttribute/.test(s.source))
  if (logic.length) notes.push(`Script logic the preview cannot run (${logic.slice(0, 3).map((s) => s.name).join(', ')}${logic.length > 3 ? ' ...' : ''}): event handlers, attribute reads, loops, random values and per-frame movement are not played.`)
  else if (scripts.length && !effect.cues.length) notes.push('Scripts were found but no Emit / Enabled / tween lines in them; emitters use their own settings.')
  const meshes = allNodes(effect.roots).filter((n) => n.className === 'MeshPart' || (n.className === 'SpecialMesh' && n.props.MeshType === 'FileMesh'))
  if (meshes.length) notes.push(`${meshes.length} mesh${meshes.length === 1 ? '' : 'es'}: the preview loads the mesh files from Roblox Studio or Open Cloud ("Load meshes"); until then they draw as proxies.`)
  const unions = allNodes(effect.roots).filter((n) => n.className === 'UnionOperation')
  if (unions.length) notes.push(`${unions.length} union${unions.length === 1 ? '' : 's'} drawn as proxy shapes (union geometry is not readable outside Studio).`)
  const skipped = new Set<string>()
  for (const n of all) if (['Sound', 'SurfaceGui', 'BillboardGui', 'Humanoid', 'Fire', 'Smoke', 'Sparkles', 'Explosion'].includes(n.className)) skipped.add(n.className)
  if (skipped.size) notes.push(`Not shown: ${[...skipped].join(', ')}.`)
  const flip = all.filter((n) => n.className === 'ParticleEmitter' && typeof n.props.Texture === 'string' && /^rbxassetid:|^http/.test(String(n.props.Texture)))
  if (flip.length) notes.push('Uploaded textures load from Roblox when online; offline they show as a placeholder.')
  return notes
}

// Bumped when the importer keeps more of a model than before (2: script-revealed parts, meshes,
// decals and script tweens), so older library entries offer "Re-import".
export const IMPORT_VERSION = 2

export function effectFromNodes(name: string, nodes: VfxNode[]): VfxEffect {
  // Part tweens / sets from scripts first (on the full tree, so script.Parent paths resolve): they
  // decide which fully transparent parts become visible during the play.
  const tweens = tweenCuesFromScripts(nodes)
  const roots = pruneToVfx(nodes, revealedByCues(tweens))
  const kept = new Set(allNodes(roots).map((n) => n.id))
  const attrs = emitAttributes(roots)
  // Attribute-driven nodes: the attributes are the timeline (script reads would be the generic
  // emit loop guessing 16 for every emitter).
  const scripted = cuesFromScripts(roots).filter((c) => !attrs.has(c.target))
  const cues = defaultCues(roots, [...cuesFromAttributes(roots, attrs), ...scripted, ...tweens.filter((c) => kept.has(c.target))])
  const hasTrail = allNodes(roots).some((n) => n.className === 'Trail')
  return { name, roots, cues, duration: effectDuration(roots, cues), motion: hasTrail ? 'swing' : 'static' }
}

export function isSequence(effect: VfxEffect): boolean {
  return !!effect.script || effect.cues.some((c) => c.action === 'tween' || c.action === 'set')
}

// Most particles alive at once, sampled over one play (deterministic).
export function peakParticles(effect: VfxEffect, samples = 32): number {
  try {
    const p = prepareEffect(effect, 1)
    let peak = 0
    for (let i = 0; i < samples; i++) {
      const f = simulate(p, (effect.duration * (i + 0.5)) / samples)
      peak = Math.max(peak, f.emitters.reduce((a, e) => a + e.particles.length, 0))
    }
    return peak
  } catch {
    return 0
  }
}

export function effectStats(effect: VfxEffect): VfxStats {
  const nodes = allNodes(effect.roots)
  const stats: VfxStats = { emitters: 0, beams: 0, trails: 0, lights: 0, meshes: 0, scripts: 0, particles: 0, overdraw: 0, textures: [], flipbooks: 0 }
  const tex = new Set<string>()
  const seq = isSequence(effect)
  // In a sequence most emitters start disabled and are switched on by cues: budget them as running.
  const cued = new Set(seq ? effect.cues.filter((c) => c.action === 'enable').map((c) => c.target) : [])
  for (const n of nodes) {
    if (n.className === 'ParticleEmitter') {
      stats.emitters++
      const b = emitterBudget(
        cued.has(n.id) ? { ...n, props: { ...n.props, Enabled: true } } : n,
        effect.cues.filter((c) => c.target === n.id && c.action === 'emit').map((c) => c.count ?? 16)
      )
      stats.particles += b.live
      stats.overdraw += b.overdraw
      if (flipbookFrames(n) > 1) stats.flipbooks++
    } else if (n.className === 'Beam') stats.beams++
    else if (n.className === 'Trail') stats.trails++
    else if (/Light$/.test(n.className)) stats.lights++
    else if (n.className === 'MeshPart' || n.className === 'SpecialMesh') stats.meshes++
    else if (n.className.endsWith('Script')) stats.scripts++
    for (const k of ['Texture', 'TextureID', 'TextureId']) {
      const v = n.props[k]
      if (typeof v === 'string' && v) tex.add(v)
    }
  }
  // Sequences turn layers on and off: measure the peak live count over a play instead of assuming
  // every emitter runs at once.
  if (seq && stats.particles > 0) {
    const peak = peakParticles(effect)
    stats.overdraw *= Math.min(1, peak / stats.particles)
    stats.particles = peak
  }
  stats.particles = Math.round(stats.particles)
  stats.overdraw = Math.round(stats.overdraw * 10) / 10
  stats.textures = [...tex]
  return stats
}

// ------------------------------------------------------------------ layer roles

export type LayerRole = 'core' | 'glow' | 'sparks' | 'smoke' | 'ring' | 'debris' | 'trail' | 'beam' | 'light' | 'mesh' | 'other'

const ROLE_WORDS: [LayerRole, RegExp][] = [
  ['sparks', /spark|ember|spec|glitter|star|flare/i],
  ['smoke', /smoke|dust|fog|mist|steam|cloud/i],
  ['glow', /glow|bloom|light|halo|aura/i],
  ['ring', /ring|shock|wave|circle|crescent/i],
  ['debris', /debris|rock|chunk|shard|bits/i],
  ['core', /core|main|base|fire|flame|center|centre|burst|blast/i]
]

export function luminance(c: Rgb): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

function saturation(c: Rgb): number {
  const mx = Math.max(...c)
  const mn = Math.min(...c)
  return mx <= 0 ? 0 : (mx - mn) / mx
}

// What job an emitter does in a layered effect (name first, then its numbers).
export function emitterRole(n: VfxNode): LayerRole {
  for (const [role, re] of ROLE_WORDS) if (re.test(n.name)) return role
  const size = sequenceMax(prop<NumberSequence>(n, 'Size'))
  const speed = Math.max(...(prop<NumberRange>(n, 'Speed') ?? [0, 0]).map(Math.abs))
  const life = (prop<NumberRange>(n, 'Lifetime') ?? [1, 1])[1]
  const le = prop<number>(n, 'LightEmission')
  const mid = evalColorSequence(prop<ColorSequence>(n, 'Color'), 0.5)
  if (prop<string>(n, 'Orientation') === 'VelocityParallel' || (size <= 0.6 && speed >= 8)) return 'sparks'
  if (le < 0.3 && saturation(mid) < 0.35 && life >= 1) return 'smoke'
  if (speed <= 2 && size >= 2 && le >= 0.5) return 'glow'
  return 'core'
}

export function nodeRole(n: VfxNode): LayerRole {
  if (n.className === 'ParticleEmitter') return emitterRole(n)
  if (n.className === 'Trail') return 'trail'
  if (n.className === 'Beam') return 'beam'
  if (/Light$/.test(n.className) || n.className === 'Highlight') return 'light'
  if (n.className === 'MeshPart' || n.className === 'SpecialMesh') return 'mesh'
  return 'other'
}

// ------------------------------------------------------------------ tags

export const KNOWN_TAGS = ['fire', 'ice', 'lightning', 'electric', 'water', 'poison', 'dark', 'holy', 'magic', 'slash', 'impact', 'explosion', 'aura', 'heal', 'smoke', 'sparks', 'portal', 'beam', 'trail', 'projectile', 'charge', 'shockwave', 'wind', 'blood', 'level-up', 'buff', 'teleport', 'ambient'] as const

const TAG_WORDS: Record<string, RegExp> = {
  fire: /fire|flame|burn|blaze|inferno|ember|magma|lava/i,
  ice: /ice|frost|freeze|snow|cryo|glacier/i,
  lightning: /lightning|thunder|bolt|zap|volt/i,
  electric: /electric|shock|spark|plasma/i,
  water: /water|splash|aqua|wave|bubble|rain/i,
  poison: /poison|toxic|venom|acid/i,
  dark: /dark|shadow|void|abyss|curse/i,
  holy: /holy|divine|angel|light ?beam|radiant/i,
  magic: /magic|arcane|mana|spell|rune|mystic/i,
  slash: /slash|swing|cut|sword|blade|katana|swipe/i,
  impact: /impact|hit|punch|strike|land|smash|slam/i,
  explosion: /explo|blast|boom|nuke|detonat/i,
  aura: /aura|charge ?up|power ?up|ki\b|chi\b|ambient/i,
  heal: /heal|regen|cure|restore/i,
  smoke: /smoke|dust|fog|mist/i,
  sparks: /spark|glitter|sparkle/i,
  portal: /portal|gate|rift|warp/i,
  shockwave: /shock ?wave|ring|wave/i,
  wind: /wind|tornado|gust|air|whirl/i,
  blood: /blood|gore/i,
  'level-up': /level ?up|lvl ?up|rank ?up/i,
  buff: /buff|boost|shield|barrier/i,
  teleport: /teleport|blink|dash/i,
  projectile: /projectile|bullet|fireball|orb|missile|shot/i,
  charge: /charge|channel|gather/i
}

function hueName(c: Rgb): string | null {
  const mx = Math.max(...c)
  const mn = Math.min(...c)
  if (mx < 0.15) return 'black'
  if (mx - mn < 0.12) return mx > 0.8 ? 'white' : 'grey'
  let h = 0
  const d = mx - mn
  if (mx === c[0]) h = ((c[1] - c[2]) / d) % 6
  else if (mx === c[1]) h = (c[2] - c[0]) / d + 2
  else h = (c[0] - c[1]) / d + 4
  h = (h * 60 + 360) % 360
  if (h < 15 || h >= 345) return 'red'
  if (h < 45) return 'orange'
  if (h < 70) return 'yellow'
  if (h < 160) return 'green'
  if (h < 200) return 'cyan'
  if (h < 255) return 'blue'
  if (h < 290) return 'purple'
  return 'pink'
}

// Dominant hues of the effect (by emitter, weighted by its particle budget).
export function effectColors(effect: VfxEffect): string[] {
  const w = new Map<string, number>()
  for (const n of allNodes(effect.roots)) {
    if (n.className !== 'ParticleEmitter' && n.className !== 'Beam' && n.className !== 'Trail') continue
    const seq = prop<ColorSequence>(n, 'Color')
    const weight = n.className === 'ParticleEmitter' ? Math.max(1, emitterBudget(n).live) : 10
    for (const t of [0, 0.5]) {
      const name = hueName(evalColorSequence(seq, t))
      if (name) w.set(name, (w.get(name) ?? 0) + weight)
    }
  }
  return [...w.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k)
}

// Tags from names, file name, colours and structure.
export function autoTags(effect: VfxEffect, extra = ''): string[] {
  const text = [effect.name, extra, ...allNodes(effect.roots).map((n) => n.name)].join(' ')
  const tags = new Set<string>()
  for (const [tag, re] of Object.entries(TAG_WORDS)) if (re.test(text)) tags.add(tag)
  const nodes = allNodes(effect.roots)
  const colors = effectColors(effect)
  if (nodes.some((n) => n.className === 'Trail')) tags.add('trail')
  if (nodes.some((n) => n.className === 'Beam')) tags.add('beam')
  const emitters = nodes.filter((n) => n.className === 'ParticleEmitter')
  const allBurst = emitters.length > 0 && emitters.every((e) => prop<boolean>(e, 'Enabled') === false)
  if (!tags.size) {
    if (allBurst) tags.add('impact')
    else if (emitters.length) tags.add('aura')
    if ((colors[0] === 'orange' || colors[0] === 'red' || colors[0] === 'yellow') && emitters.some((e) => (prop<number[]>(e, 'Acceleration') ?? [0, 0, 0])[1] > 0)) tags.add('fire')
    if (colors[0] === 'cyan' || colors[0] === 'blue') tags.add('magic')
  }
  for (const c of colors.slice(0, 2)) tags.add(c)
  return [...tags].slice(0, 10)
}

export function describeEffect(effect: VfxEffect): string {
  const stats = effectStats(effect)
  const roles = allNodes(effect.roots)
    .filter((n) => n.className === 'ParticleEmitter')
    .map((n) => `${n.name} (${emitterRole(n)})`)
  const bits = [
    `${stats.emitters} emitter${stats.emitters === 1 ? '' : 's'}${roles.length ? `: ${roles.slice(0, 6).join(', ')}` : ''}`,
    stats.beams ? `${stats.beams} beam(s)` : '',
    stats.trails ? `${stats.trails} trail(s)` : '',
    stats.lights ? `${stats.lights} light(s)` : '',
    effect.cues.some((c) => c.action === 'emit') ? `bursts at ${[...new Set(effect.cues.filter((c) => c.action === 'emit').map((c) => c.at))].slice(0, 5).join(', ')} s` : 'continuous',
    `colours ${effectColors(effect).join('/') || 'n/a'}`
  ].filter(Boolean)
  return bits.join('; ')
}

// ------------------------------------------------------------------ performance guard

export interface PerfWarning {
  level: 'info' | 'warn' | 'error'
  node?: string
  message: string
}

export const PERF = {
  // Live particles across the effect before it is "heavy" / "too heavy" (one instance on screen).
  particlesWarn: 400,
  particlesError: 1500,
  // Sum of live x area x opacity (studs^2): large, opaque, overlapping quads are what cost fill rate.
  overdrawWarn: 600,
  overdrawError: 2500,
  emittersWarn: 8,
  burstWarn: 200
}

export function perfWarnings(effect: VfxEffect): PerfWarning[] {
  const out: PerfWarning[] = []
  const stats = effectStats(effect)
  for (const n of allNodes(effect.roots)) {
    if (n.className !== 'ParticleEmitter') continue
    const rate = prop<number>(n, 'Rate') || 0
    const life = prop<NumberRange>(n, 'Lifetime') ?? [1, 1]
    if (rate > MAX_RATE) out.push({ level: 'warn', node: n.name, message: `Rate ${rate} is above Roblox's ${MAX_RATE}/s cap per emitter (100/s on mobile).` })
    const b = emitterBudget(n)
    if (prop<boolean>(n, 'Enabled') !== false && rate * life[1] > 300) out.push({ level: 'warn', node: n.name, message: `Rate x Lifetime = ${Math.round(rate * life[1])} live particles at most; lower Rate or Lifetime.` })
    if (b.area > 100 && prop<number>(n, 'LightEmission') < 0.5) out.push({ level: 'info', node: n.name, message: `Large opaque particles (mean ${Math.round(Math.sqrt(b.area))} studs): heavy overdraw up close.` })
    for (const c of effect.cues) if (c.target === n.id && c.action === 'emit' && (c.count ?? 0) > PERF.burstWarn) out.push({ level: 'warn', node: n.name, message: `Emit(${c.count}) is a big burst; ${PERF.burstWarn} or fewer usually reads the same.` })
    const fps = prop<NumberRange>(n, 'FlipbookFramerate')
    if (flipbookFrames(n) > 1 && fps && fps[1] > 30) out.push({ level: 'info', node: n.name, message: 'FlipbookFramerate above 30 is capped at 30 by Roblox.' })
  }
  if (stats.particles > PERF.particlesError) out.push({ level: 'error', message: `About ${stats.particles} live particles: too heavy for an effect that can appear several times at once.` })
  else if (stats.particles > PERF.particlesWarn) out.push({ level: 'warn', message: `About ${stats.particles} live particles: fine alone, heavy if several play at once.` })
  if (stats.overdraw > PERF.overdrawError) out.push({ level: 'error', message: `Overdraw estimate ${stats.overdraw}: large overlapping quads will cost fill rate on mobile.` })
  else if (stats.overdraw > PERF.overdrawWarn) out.push({ level: 'warn', message: `Overdraw estimate ${stats.overdraw}: consider smaller or fewer large particles.` })
  if (stats.emitters > PERF.emittersWarn && !isSequence(effect)) out.push({ level: 'info', message: `${stats.emitters} emitters; most good effects use 3 to 6 layers.` })
  if (isSequence(effect) && stats.emitters > 40) out.push({ level: 'info', message: `${stats.emitters} emitters across the sequence; reuse rigs (tween them) instead of spawning new ones per beat.` })
  return out
}

// Same message on several layers (e.g. "FlipbookFramerate above 30..." on 12 emitters) -> one line
// with the count and the layer names.
export function dedupeWarnings(list: PerfWarning[]): PerfWarning[] {
  const by = new Map<string, { w: PerfWarning; nodes: string[] }>()
  for (const w of list) {
    const k = `${w.level}|${w.message}`
    const e = by.get(k)
    if (e) {
      if (w.node && !e.nodes.includes(w.node)) e.nodes.push(w.node)
    } else by.set(k, { w, nodes: w.node ? [w.node] : [] })
  }
  return [...by.values()].map(({ w, nodes }) =>
    nodes.length > 1 ? { level: w.level, node: nodes.join(', '), message: `${w.message} (${nodes.length} layers: ${nodes.slice(0, 4).join(', ')}${nodes.length > 4 ? ', ...' : ''})` } : w
  )
}

// 0..10 performance score from the stats (used in the rubric next to the critic's judgement).
export function perfScore(effect: VfxEffect): number {
  const s = effectStats(effect)
  const p = s.particles <= PERF.particlesWarn ? 0 : Math.min(1, (s.particles - PERF.particlesWarn) / (PERF.particlesError - PERF.particlesWarn))
  const o = s.overdraw <= PERF.overdrawWarn ? 0 : Math.min(1, (s.overdraw - PERF.overdrawWarn) / (PERF.overdrawError - PERF.overdrawWarn))
  return Math.round((10 - 6 * Math.max(p, o) - 2 * Math.min(p, o)) * 10) / 10
}

export function sizeShape(n: VfxNode): CurveShape {
  return curveShape(prop<NumberSequence>(n, 'Size'))
}

export { hex }
