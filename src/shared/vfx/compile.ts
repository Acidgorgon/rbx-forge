// Timeline scripts -> effects. A script (Luau, the ForgeFX API, see runtime.ts) is run headlessly
// by Lune (resources/lune/vfx_timeline.luau), which records every fx call as an op instead of
// touching Roblox. This file turns the recorded ops into the effect the preview and the exporter
// use: kit rigs (kit.ts) added to the model, cues (emit / enable / disable / tween / set) and
// stage markers. Errors carry the script line of the call that caused them.

import { allNodes } from './analyze.ts'
import { cf, isCFrame } from './cframe.ts'
import { KIT, KIT_OPTION_KEYS, kitKind, type KitCue, type KitOpts } from './kit.ts'
import { prop } from './schema.ts'
import { fromHex } from './sequence.ts'
import { applyChanges, safeName, SpecError } from './spec.ts'
import { easingDirection, easingStyle, normalizeGoal, Timeline, TimelineError } from './timeline.ts'
import type { CFrameArr, PropValue, Rgb, Vec3, VfxCue, VfxEffect, VfxNode, VfxStage } from './types.ts'

export interface RecordedOp {
  op: 'spawn' | 'emit' | 'enable' | 'disable' | 'tween' | 'set' | 'stage' | 'duration' | 'anchor'
  at: number
  line?: number
  kind?: string
  name?: string
  opts?: Record<string, unknown>
  target?: string
  count?: number
  duration?: number
  props?: Record<string, unknown>
  style?: string
  direction?: string
  label?: string
  value?: unknown
}

export interface ScriptError {
  message: string
  line?: number
}

// What the Lune recorder prints (one JSON line).
export interface RecordResult {
  ok: boolean
  ops: RecordedOp[]
  prints: string[]
  error?: ScriptError
}

export interface ScriptRun {
  ok: boolean
  effect?: VfxEffect
  error?: ScriptError
  prints: string[]
  warnings: string[]
  summary: string
}

export class ScriptCompileError extends Error {
  line?: number
  constructor(message: string, line?: number) {
    super(message)
    this.line = line
  }
}

export const DEFAULT_SCRIPT_ANCHOR: Vec3 = [0, 3.2, -3]
export const MAX_OPS = 4000
export const MAX_SPAWNS = 40
const MAX_DURATION = 15

// Default script for a new scripted effect (also the editor's template).
export const SCRIPT_TEMPLATE = `-- Timeline for this effect. fx is the ForgeFX API (same code runs in Forge and in game):
--   fx:spawn(kind, opts) -> handle   orb glow sparks smoke shockwave flash beam trail debris aura charge impact slash dust light
--   fx:emit(h, n)  fx:enable(h)  fx:disable(h)  fx:tween(h, seconds, goals, style?, direction?)  fx:set(h, goals)
--   fx:wait(s)  fx:at(t, fn)  fx:after(dt, fn)  fx:stage(label)  fx:duration(s)  fx:forward(studs)
-- Positions are studs from the effect's root; -Z is forward.
return function(fx)
	fx:stage("charge")
	local orb = fx:spawn("orb", { name = "Orb", color = Color3.fromRGB(120, 90, 255), size = 1.6 })
	fx:wait(0.6)
	fx:stage("release")
	fx:tween(orb, 0.35, { Position = fx:forward(30) }, "Quad", "In")
	fx:spawn("trail", { name = "OrbTrail", parent = orb, color = Color3.fromRGB(160, 130, 255) })
	fx:wait(0.35)
	fx:stage("impact")
	fx:spawn("impact", { name = "Hit", at = fx:forward(30), color = Color3.fromRGB(200, 170, 255) })
	fx:tween(orb, 0.2, { Fade = 1 })
end
`

// ------------------------------------------------------------------ value conversion

function vec3(v: unknown, what: string, line?: number): Vec3 {
  const o = v as Record<string, unknown>
  if (o && typeof o === 'object' && o.__t === 'v3') return [Number(o.x) || 0, Number(o.y) || 0, Number(o.z) || 0]
  if (o && typeof o === 'object' && o.__t === 'cf' && Array.isArray(o.c)) return (o.c as number[]).slice(0, 3) as Vec3
  if (Array.isArray(v) && v.length >= 3 && v.every((x) => Number.isFinite(Number(x)))) return v.slice(0, 3).map(Number) as Vec3
  throw new ScriptCompileError(`${what}: expected a Vector3`, line)
}

function color(v: unknown, what: string, line?: number): Rgb {
  const o = v as Record<string, unknown>
  if (o && typeof o === 'object' && o.__t === 'c3') return [Number(o.r) || 0, Number(o.g) || 0, Number(o.b) || 0]
  if (typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v.trim())) return fromHex(v)
  if (Array.isArray(v) && v.length === 3) {
    const a = v.map(Number)
    return (a.some((x) => x > 1) ? a.map((x) => x / 255) : a) as Rgb
  }
  throw new ScriptCompileError(`${what}: expected a Color3 or "#rrggbb"`, line)
}

function handleName(v: unknown): string | null {
  const o = v as Record<string, unknown>
  if (o && typeof o === 'object' && o.__t === 'h' && typeof o.name === 'string') return o.name
  if (typeof v === 'string' && v.trim()) return v.trim()
  return null
}

function kitOpts(raw: Record<string, unknown> | undefined, line?: number): KitOpts {
  const o: KitOpts = {}
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (!(KIT_OPTION_KEYS as readonly string[]).includes(k)) throw new ScriptCompileError(`spawn: unknown option "${k}" (options: ${KIT_OPTION_KEYS.join(', ')})`, line)
    const what = `spawn option ${k}`
    switch (k) {
      case 'name':
      case 'texture':
        if (typeof v !== 'string') throw new ScriptCompileError(`${what}: expected a string`, line)
        ;(o as Record<string, unknown>)[k] = k === 'texture' && /^\d+$/.test(v) ? `rbxassetid://${v}` : v
        break
      case 'parent': {
        const h = handleName(v)
        if (!h) throw new ScriptCompileError(`${what}: expected a handle from fx:spawn`, line)
        o.parent = h
        break
      }
      case 'at':
        o.at = vec3(v, what, line)
        break
      case 'to': {
        const h = typeof v === 'object' && v && (v as Record<string, unknown>).__t === 'h' ? handleName(v) : null
        o.to = h ?? vec3(v, what, line)
        break
      }
      case 'color':
      case 'color2':
        o[k] = color(v, what, line)
        break
      case 'facing': {
        const f = String(v ?? '').replace(/^Enum\.NormalId\./, '')
        const ok = ['Top', 'Bottom', 'Front', 'Back', 'Left', 'Right'].find((n) => n.toLowerCase() === f.toLowerCase())
        if (!ok) throw new ScriptCompileError(`${what}: expected Top, Bottom, Front, Back, Left or Right`, line)
        o.facing = ok as KitOpts['facing']
        break
      }
      default: {
        const n = Number(v)
        if (!Number.isFinite(n)) throw new ScriptCompileError(`${what}: expected a number`, line)
        ;(o as Record<string, unknown>)[k] = n
      }
    }
  }
  return o
}

// ------------------------------------------------------------------ compile

let counter = 0
function makeId(prefix: string): string {
  counter = (counter + 1) % 1e9
  return `${prefix}-k${counter.toString(36)}`
}

function stripKit(nodes: VfxNode[]): VfxNode[] {
  return nodes.filter((n) => !n.kit).map((n) => ({ ...n, children: stripKit(n.children) }))
}

// The effect a script builds on: the base effect without anything an earlier run of the script
// made, with a Model > Root (invisible anchored part at the pivot) to hang rigs on.
export function scriptBase(base: Pick<VfxEffect, 'name' | 'roots' | 'cues'>): { roots: VfxNode[]; model: VfxNode; cues: VfxCue[] } {
  let roots = stripKit(JSON.parse(JSON.stringify(base.roots)) as VfxNode[])
  let model = roots.length === 1 && roots[0].className === 'Model' ? roots[0] : null
  if (!model) {
    model = { id: makeId('model'), className: 'Model', name: safeName(base.name || 'Effect'), props: {}, children: roots }
    roots = [model]
  }
  if (!model.children.some((c) => c.className === 'Part' && c.name === 'Root')) {
    model.children.unshift({ id: makeId('root'), className: 'Part', name: 'Root', props: { Size: [1, 1, 1], Transparency: 1, Anchored: true, CanCollide: false, CFrame: cf(0, 0, 0) }, children: [] })
  }
  const ids = new Set(allNodes(roots).map((n) => n.id))
  return { roots, model, cues: base.cues.filter((c) => !c.script && ids.has(c.target)) }
}

function lifetimeEnd(n: VfxNode): number {
  if (n.className === 'ParticleEmitter') return (prop<number[]>(n, 'Lifetime') ?? [1, 1])[1] ?? 1
  if (n.className === 'Trail') return prop<number>(n, 'Lifetime')
  return 0
}

// Length of a play: last thing that happens plus what it leaves behind.
export function timelineDuration(effect: Pick<VfxEffect, 'roots' | 'cues'>): number {
  const byId = new Map(allNodes(effect.roots).map((n) => [n.id, n]))
  let end = 0.5
  for (const c of effect.cues) {
    const n = byId.get(c.target)
    if (c.action === 'tween') end = Math.max(end, c.at + (c.duration ?? 0))
    else if (c.action === 'emit' || c.action === 'disable') end = Math.max(end, c.at + (n ? Math.min(3, lifetimeEnd(n)) : 0))
    else end = Math.max(end, c.at + 0.3)
  }
  return Math.min(MAX_DURATION, Math.round((end + 0.2) * 100) / 100)
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]
    d[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j]
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return d[b.length]
}

// Names that contain / are contained in the typo, or are within two edits of it.
function closest(name: string, names: string[]): string[] {
  const lower = name.toLowerCase()
  const near = names.filter((n) => n.toLowerCase().includes(lower) || lower.includes(n.toLowerCase()))
  const typo = names.filter((n) => !near.includes(n) && editDistance(lower, n.toLowerCase()) <= (lower.length <= 3 ? 1 : 2))
  return [...typo, ...near].slice(0, 4)
}

// Recorded ops (+ the effect they build on) -> the scripted effect.
export function compileTimeline(base: VfxEffect, ops: RecordedOp[], script: string): { effect: VfxEffect; warnings: string[] } {
  if (ops.length > MAX_OPS) throw new ScriptCompileError(`the script made ${ops.length} calls; the limit is ${MAX_OPS}`)
  const { roots, model, cues: baseCues } = scriptBase(base)
  const warnings: string[] = []
  const cues: VfxCue[] = [...baseCues]
  const stages: VfxStage[] = []
  const byName = new Map<string, VfxNode>()
  for (const n of allNodes(roots)) if (!byName.has(n.name)) byName.set(n.name, n)
  const kitCounts = new Map<string, number>()
  const located: { node: VfxNode; parent: string; at: number; line?: number; cues: VfxCue[] }[] = []
  let duration: number | null = null
  let anchor: Vec3 | null = null
  let spawns = 0

  const addNode = (node: VfxNode, line?: number) => {
    for (const n of allNodes([node])) {
      if (byName.has(n.name)) throw new ScriptCompileError(`spawn: the name "${n.name}" is already used; pick another name`, line)
      byName.set(n.name, n)
    }
  }
  const kitCue = (k: KitCue, at: number, line?: number): VfxCue => {
    const target = byName.get(k.target)
    if (!target) throw new ScriptCompileError(`kit: no node "${k.target}"`, line)
    const c: VfxCue = { at: Math.max(0, at + k.dt), target: target.id, action: k.action, script: true }
    if (k.count !== undefined) c.count = k.count
    if (k.props) c.props = k.props
    if (k.duration !== undefined) c.duration = k.duration
    if (k.style) c.style = k.style
    if (k.direction) c.direction = k.direction
    return c
  }

  // Pass 1: spawns (structure), so later ops can name any rig whatever the script order.
  for (const op of ops) {
    if (op.op === 'stage') stages.push({ at: Math.max(0, Number(op.at) || 0), label: String(op.label ?? '').slice(0, 40) || 'stage' })
    else if (op.op === 'duration') duration = Math.max(0.2, Math.min(MAX_DURATION, Number(op.value) || 0))
    else if (op.op === 'anchor') anchor = vec3(op.value, 'fx:anchor', op.line)
    if (op.op !== 'spawn') continue
    if (++spawns > MAX_SPAWNS) throw new ScriptCompileError(`more than ${MAX_SPAWNS} spawns; reuse rigs (tween them) instead`, op.line)
    const kind = kitKind(String(op.kind ?? ''))
    if (!kind) throw new ScriptCompileError(`spawn: unknown kind "${op.kind}" (kinds: ${Object.keys(KIT).join(', ')})`, op.line)
    const o = kitOpts(op.opts, op.line)
    let name = o.name ? safeName(o.name) : String(op.name ?? '')
    if (!name) {
      const n = (kitCounts.get(kind) ?? 0) + 1
      kitCounts.set(kind, n)
      name = `${kind[0].toUpperCase()}${kind.slice(1)}${n}`
    }
    const def = KIT[kind]
    let built
    try {
      built = def.build(name, o, makeId)
    } catch (e) {
      throw new ScriptCompileError(`spawn ${kind}: ${(e as Error).message}`, op.line)
    }
    const at = Math.max(0, Number(op.at) || 0)
    const parentNode = o.parent ? byName.get(o.parent) : null
    if (o.parent && !parentNode) throw new ScriptCompileError(`spawn: no rig named "${o.parent}" to use as parent`, op.line)
    if (built.mode === 'attach' && kind !== 'trail') {
      if (parentNode) {
        if (parentNode.className !== 'Part') throw new ScriptCompileError(`spawn: parent "${o.parent}" must be a rig made by fx:spawn (a part), not a ${parentNode.className}`, op.line)
        addNode(built.node, op.line)
        parentNode.children.push(built.node)
      } else {
        const att = built.node
        const pos = isCFrame(att.props.CFrame) ? (att.props.CFrame as CFrameArr).slice(0, 3) : [0, 0, 0]
        att.name = `${name}Att`
        att.props.CFrame = cf(0, 0, 0)
        const rig: VfxNode = { id: makeId('part'), className: 'Part', name, props: { Size: [1, 1, 1], Transparency: 1, Anchored: true, CanCollide: false, CastShadow: false, CFrame: cf(pos[0], pos[1], pos[2]) }, children: [att], kit: 'rig' }
        addNode(rig, op.line)
        model.children.push(rig)
      }
    } else if (built.mode === 'part') {
      addNode(built.node, op.line)
      model.children.push(built.node)
    }
    for (const ex of built.extras ?? []) {
      const host = byName.get(ex.parent)
      if (!host || host.className !== 'Part') throw new ScriptCompileError(`spawn ${kind}: "${ex.parent}" must be a rig made by fx:spawn`, op.line)
      addNode(ex.node, op.line)
      host.children.push(ex.node)
    }
    for (const p of built.prelude) cues.push({ ...kitCue(p, 0, op.line), prelude: true })
    const mine = built.activate.map((a) => ({ ...kitCue(a, at, op.line), spawn: name, spawnAt: at }))
    cues.push(...mine)
    if (built.mode === 'part' && parentNode) located.push({ node: built.node, parent: parentNode.id, at, line: op.line, cues: mine })
  }

  // Pass 2: timeline ops.
  const names = [...byName.keys()]
  const resolve = (raw: unknown, line?: number): VfxNode => {
    const name = handleName(raw)
    const n = name ? byName.get(name) : null
    if (!n) {
      const near = name ? closest(name, names) : []
      throw new ScriptCompileError(`no instance named "${name ?? String(raw)}"${near.length ? ` (did you mean ${near.join(', ')}?)` : ''}`, line)
    }
    return n
  }
  for (const op of ops) {
    const at = Math.max(0, Number(op.at) || 0)
    if (op.op === 'emit') {
      const n = resolve(op.target, op.line)
      if (n.className !== 'ParticleEmitter') {
        const kids = allNodes(n.children).filter((k) => k.className === 'ParticleEmitter')
        if (!kids.length) throw new ScriptCompileError(`emit: "${n.name}" is a ${n.className} with no ParticleEmitter`, op.line)
        for (const k of kids) cues.push({ at, target: k.id, action: 'emit', count: Math.max(1, Math.min(1000, Math.round(Number(op.count) || 16))), script: true })
        continue
      }
      cues.push({ at, target: n.id, action: 'emit', count: Math.max(1, Math.min(1000, Math.round(Number(op.count) || 16))), script: true })
    } else if (op.op === 'enable' || op.op === 'disable') {
      const n = resolve(op.target, op.line)
      const toggles = ['ParticleEmitter', 'Beam', 'Trail', 'PointLight', 'SpotLight', 'SurfaceLight', 'Highlight']
      const targets = toggles.includes(n.className) ? [n] : allNodes(n.children).filter((k) => toggles.includes(k.className))
      if (!targets.length) throw new ScriptCompileError(`${op.op}: "${n.name}" has nothing to ${op.op}`, op.line)
      for (const k of targets) {
        if (op.op === 'enable' && k.props.Enabled === undefined) k.props.Enabled = false
        cues.push({ at, target: k.id, action: op.op, script: true })
      }
    } else if (op.op === 'tween' || op.op === 'set') {
      const n = resolve(op.target, op.line)
      const goals: Record<string, PropValue> = {}
      for (const [k, v] of Object.entries(op.props ?? {})) {
        try {
          goals[k] = normalizeGoal(n.className, k, v)
        } catch (e) {
          throw new ScriptCompileError(`${op.op} ${n.name}: ${(e as Error).message}`, op.line)
        }
      }
      if (!Object.keys(goals).length) throw new ScriptCompileError(`${op.op} ${n.name}: no goals`, op.line)
      const c: VfxCue = { at, target: n.id, action: op.op, props: goals, script: true }
      if (op.op === 'tween') {
        c.duration = Math.max(0, Math.min(MAX_DURATION, Number(op.duration) || 0))
        c.style = easingStyle(op.style)
        c.direction = easingDirection(op.direction)
      }
      cues.push(c)
    }
  }

  // Part rigs spawned "at a parent": shift them (and their own motion) to where the parent is then.
  if (located.length) {
    const tl = new Timeline({ roots, cues })
    for (const l of located) {
      const parent = allNodes(roots).find((n) => n.id === l.parent)!
      const base = isCFrame(parent.props.CFrame) ? (parent.props.CFrame as CFrameArr) : cf()
      const p = tl.value<CFrameArr>(parent.id, 'CFrame', base, l.at)
      const pos = tl.has(parent.id, 'Position') ? tl.value<number[]>(parent.id, 'Position', base.slice(0, 3), l.at) : p.slice(0, 3)
      const shift = (c: number[]) => [c[0] + pos[0], c[1] + pos[1], c[2] + pos[2], ...c.slice(3)]
      const own = isCFrame(l.node.props.CFrame) ? (l.node.props.CFrame as CFrameArr) : cf()
      l.node.props.CFrame = shift(own)
      for (const c of l.cues) {
        if (c.props?.CFrame) c.props.CFrame = shift(c.props.CFrame as number[])
        if (c.props?.Position) c.props.Position = shift(c.props.Position as number[]).slice(0, 3)
      }
    }
  }

  cues.sort((a, b) => a.at - b.at)
  stages.sort((a, b) => a.at - b.at)
  let effect: VfxEffect = {
    ...base,
    roots,
    cues,
    stages,
    script,
    space: 'local',
    motion: base.motion && base.motion !== 'static' && !base.script ? base.motion : 'static',
    anchor: anchor ?? base.anchor ?? DEFAULT_SCRIPT_ANCHOR,
    duration: 0
  }
  // Parameter edits made on an earlier run (param editor, critic) apply on top.
  if (base.patches?.length) {
    const kept: typeof base.patches = []
    for (const p of base.patches) {
      try {
        effect = applyChanges(effect, [p], { record: false })
        kept.push(p)
      } catch (e) {
        warnings.push(`patch ${p.node}.${p.prop} no longer applies: ${e instanceof SpecError ? e.message : (e as Error).message}`)
      }
    }
    effect.patches = kept
  }
  effect.duration = duration ?? timelineDuration(effect)
  if (!stages.length) warnings.push('no fx:stage markers: add stages (charge, release, impact...) so the timeline and the critic can follow the sequence')
  return { effect, warnings }
}

// Recorder output -> ScriptRun (compile errors become script errors with a line).
export function finishRun(base: VfxEffect, script: string, rec: RecordResult): ScriptRun {
  const prints = rec.prints ?? []
  if (!rec.ok || rec.error) return { ok: false, error: rec.error ?? { message: 'the script failed' }, prints, warnings: [], summary: '' }
  try {
    const { effect, warnings } = compileTimeline(base, rec.ops ?? [], script)
    return { ok: true, effect, prints, warnings, summary: '' }
  } catch (e) {
    if (e instanceof ScriptCompileError) return { ok: false, error: { message: e.message, ...(e.line ? { line: e.line } : {}) }, prints, warnings: [], summary: '' }
    if (e instanceof TimelineError || e instanceof SpecError) return { ok: false, error: { message: e.message }, prints, warnings: [], summary: '' }
    throw e
  }
}

// "[string \"timeline\"]:12: attempt to ..." -> { line: 12, message }
export function parseLuauError(raw: string): ScriptError {
  const text = String(raw ?? '').replace(/^.*?LuaError\(\s*/s, '').trim()
  const m = /\[string "[^"]*"\]:(\d+):\s*([\s\S]*)/.exec(text) ?? /timeline(?:\.luau)?:(\d+):\s*([\s\S]*)/.exec(text)
  if (m) return { line: Number(m[1]), message: m[2].split('\n')[0].replace(/^syntax error:\s*/i, '').trim().slice(0, 400) }
  return { message: text.split('\n')[0].slice(0, 400) || 'the script failed' }
}
