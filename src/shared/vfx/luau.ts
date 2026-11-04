// Luau module for an effect, GenTree style: src/shared/VFX/<Name>/init.luau next to the model
// template src/shared/VFX/<Name>/Effect.rbxmx (Rojo turns the folder into a ModuleScript with the
// model as its child "Effect"). The module clones the template (or builds the instances from its
// data when the template is missing, as in Studio checks and Live), places it, runs the timeline
// (Emit bursts, Enabled toggles) and cleans up.
//
// The instances are data: one compact table row per instance ({ ClassName, Name, parent, props })
// read by a small builder, not one statement per property (that was ~5x larger and, with one local
// per instance, did not compile past ~200 instances: Luau allows 200 locals per function).
//
// Roblox refuses a script Source of 200,000 characters or more ("Provided string length (200254) is
// greater than or equal to max length (200000)"; Rojo hits the same limit when it syncs a file). An
// effect whose module would pass SOURCE_CAP keeps only the code in the module and moves its rows
// into child ModuleScripts Data1..DataN (whole rows per part, never a split value), which the module
// requires and merges: init.luau + Data1.luau... in the project, children of the module in Studio
// jobs. Both forms build the same instances and play the same cues.

import { allNodes } from './analyze.ts'
import { centreEffect } from './placement.ts'
import { NODE_ID_ATTR, RUNTIME_MODULE } from './runtime.ts'
import { SCHEMA, SCRIPT_CLASSES } from './schema.ts'
import { fmt } from './sequence.ts'
import { tweenKind } from './timeline.ts'
import type { ColorKey, NumKey, PropValue, VfxCue, VfxEffect, VfxNode } from './types.ts'

// Roblox's limit (a Source must be shorter), and the size Forge keeps each generated module under.
export const SOURCE_LIMIT = 200_000
export const SOURCE_CAP = 190_000
// Child modules holding an oversized effect's data: Data1, Data2, ...
export const DATA_MODULE = 'Data'
export const DATA_HEADER = '-- RBX Forge effect data'

// Length as Roblox counts it (bytes of UTF-8).
export function sourceLength(src: string): number {
  let n = 0
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < src.length) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

// A Luau string literal (JSON's \uXXXX escapes are not Luau).
export function luauString(s: string): string {
  const esc = (c: string) => {
    if (c === '\\') return '\\\\'
    if (c === '"') return '\\"'
    if (c === '\n') return '\\n'
    if (c === '\r') return '\\r'
    if (c === '\t') return '\\t'
    return `\\${String(c.charCodeAt(0)).padStart(3, '0')}`
  }
  return `"${s.replace(/[\\"\x00-\x1f\x7f]/g, esc)}"`
}

const rgb255 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255)

// NS / CS / NR are defined by the module (and each data part) that holds instance rows.
function numberSequence(seq: NumKey[]): string {
  if (seq.length === 2 && seq[0].v === seq[1].v && !seq[0].e && !seq[1].e) return `NS(${fmt(seq[0].v)})`
  return `NS{${seq.map((k) => `${fmt(k.t)},${fmt(k.v)},${k.e ? fmt(k.e) : 0}`).join(',')}}`
}

function colorSequence(seq: ColorKey[]): string {
  if (seq.length === 2 && seq[0].c.every((x, i) => x === seq[1].c[i])) return `CS(${seq[0].c.map(rgb255).join(',')})`
  return `CS{${seq.map((k) => `${fmt(k.t)},${k.c.map(rgb255).join(',')}`).join(',')}}`
}

function value(kind: string, v: PropValue): string | null {
  const a = Array.isArray(v) ? (v as number[]) : []
  switch (kind) {
    case 'number':
    case 'int':
      return fmt(Number(v))
    case 'bool':
      return v ? 'true' : 'false'
    case 'string':
    case 'content':
      return luauString(String(v))
    case 'vec2':
      return `Vector2.new(${fmt(a[0])}, ${fmt(a[1])})`
    case 'vec3':
      return `Vector3.new(${fmt(a[0])}, ${fmt(a[1])}, ${fmt(a[2])})`
    case 'color3':
      return `Color3.new(${fmt(a[0])}, ${fmt(a[1])}, ${fmt(a[2])})`
    case 'range':
      return `NR(${fmt(a[0])}, ${fmt(a[1] ?? a[0])})`
    case 'nseq':
      return numberSequence(v as NumKey[])
    case 'cseq':
      return colorSequence(v as ColorKey[])
    case 'cframe':
      return `CFrame.new(${a.map(fmt).join(', ')})`
    default:
      return kind.startsWith('enum:') ? `Enum.${kind.slice(5)}.${String(v)}` : null
  }
}

const VALUE_HELPERS = `local NR = NumberRange.new
local function NS(k: any): NumberSequence
	if type(k) == "number" then
		return NumberSequence.new(k)
	end
	local points = {}
	for i = 1, #k, 3 do
		table.insert(points, NumberSequenceKeypoint.new(k[i], k[i + 1], k[i + 2]))
	end
	return NumberSequence.new(points)
end
local function CS(k: any, g: number?, b: number?): ColorSequence
	if type(k) == "number" then
		return ColorSequence.new(Color3.fromRGB(k, g :: number, b :: number))
	end
	local points = {}
	for i = 1, #k, 4 do
		table.insert(points, ColorSequenceKeypoint.new(k[i], Color3.fromRGB(k[i + 1], k[i + 2], k[i + 3])))
	end
	return ColorSequence.new(points)
end`

// Scripted effects (and effects with tweens) play through the ForgeFX runtime.
export function needsRuntime(effect: VfxEffect): boolean {
  return !!effect.script || effect.cues.some((c) => c.action === 'tween' || c.action === 'set')
}

// The effect's Timeline ModuleScript: the script as written in Forge. Scripts in the
// "return function(fx) ... end" form are already modules; others (using "local fx = ...") are wrapped.
export function timelineModule(script: string): string {
  if (/(^|\n)\s*return\s+function\s*\(/.test(script)) return script.endsWith('\n') ? script : `${script}\n`
  return `return function(fx) -- wrapped by RBX Forge so the timeline is a ModuleScript (line numbers are one higher than in Forge)\n${script}\nend\n`
}

function goalValue(className: string, prop: string, v: PropValue): string | null {
  const kind = tweenKind(className, prop)
  const a = Array.isArray(v) ? (v as number[]) : []
  switch (kind) {
    case 'number':
      return fmt(Number(v))
    case 'vec3':
      return `Vector3.new(${fmt(a[0])}, ${fmt(a[1])}, ${fmt(a[2])})`
    case 'color3':
    case 'tint':
      return `Color3.new(${fmt(a[0])}, ${fmt(a[1])}, ${fmt(a[2])})`
    case 'cframe':
      return `CFrame.new(${a.map(fmt).join(', ')})`
    default:
      return null
  }
}

function luauKey(k: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `[${luauString(k)}]`
}

// One cue as a Luau table for ForgeFX:cue.
function cueTable(c: VfxCue, node: VfxNode, timeKey: 'at' | 'dt', time: number): string {
  const id = Number(node.attrs?.[NODE_ID_ATTR]) || 0
  const bits = [`${timeKey} = ${fmt(time)}`, ...(id ? [`id = ${id}`] : []), `name = ${luauString(node.name)}`, `action = "${c.action}"`]
  if (c.action === 'emit') bits.push(`count = ${Math.round(c.count ?? 16)}`)
  if (c.action === 'tween') bits.push(`duration = ${fmt(c.duration ?? 0)}`, `style = "${c.style ?? 'Quad'}"`, `direction = "${c.direction ?? 'Out'}"`)
  if (c.props) bits.push(`goals = ${goalsTable(node, c.props)}`)
  return `{ ${bits.join(', ')} }`
}

function goalsTable(node: VfxNode, props: Record<string, PropValue>): string {
  const goals = Object.entries(props)
    .map(([k, v]) => {
      const text = goalValue(node.className, k, v)
      return text === null ? null : `${luauKey(k)} = ${text}`
    })
    .filter(Boolean)
  return `{ ${goals.join(', ')} }`
}

// ------------------------------------------------------------ the shipped tree

// Instances in post-order (children before their parents): the order of the NODES rows.
function postOrder(roots: VfxNode[]): VfxNode[] {
  const order: VfxNode[] = []
  const walk = (n: VfxNode) => {
    for (const c of n.children) walk(c)
    order.push(n)
  }
  roots.forEach(walk)
  return order
}

// The effect as its module and its Effect.rbxmx template ship it (call on the centred effect):
//  - without Script / LocalScript / ModuleScript (an imported model's own scripts stay in the
//    library for reading, but in the template they would run next to the module's cues and play
//    the effect twice); a script's non-script children move up to the script's parent;
//  - with a ForgeId attribute (NODE_ID_ATTR: the node's row in NODES) on every node a cue
//    addresses, so cues find their instance even when names repeat ("1SP" in imported packs).
// A copy: the effect passed in is not changed.
export function shippedEffect(effect: VfxEffect): VfxEffect {
  const strip = (nodes: VfxNode[]): VfxNode[] =>
    nodes.flatMap((n): VfxNode[] => {
      const children = strip(n.children)
      if (SCRIPT_CLASSES.has(n.className)) return children
      const copy: VfxNode = { ...n, props: { ...n.props }, children }
      if (n.attrs) copy.attrs = { ...n.attrs }
      return [copy]
    })
  const roots = strip(effect.roots)
  // Cues name their target by id; with repeated ids the last node in tree order wins (as in byId).
  const byId = new Map(allNodes(roots).map((n) => [n.id, n]))
  const targeted = new Set(effect.cues.map((c) => byId.get(c.target)).filter((n): n is VfxNode => !!n))
  postOrder(roots).forEach((n, i) => {
    if (targeted.has(n)) n.attrs = { ...(n.attrs ?? {}), [NODE_ID_ATTR]: i + 1 }
  })
  return { ...effect, roots }
}

// The template written next to the module (Effect.rbxmx): the centred effect's shipped tree.
export function templateRoots(effect: VfxEffect): VfxNode[] {
  return shippedEffect(centreEffect(effect)).roots
}

// Seconds the module keeps the effect running: the effect's duration, and at least until its last
// cue (and tween) ends, so nothing scheduled is cut by the module switching emitters off.
export function moduleDuration(effect: VfxEffect): number {
  let end = Number(effect.duration) || 0
  for (const c of effect.cues) if (!c.prelude) end = Math.max(end, c.at + (c.action === 'tween' ? c.duration ?? 0 : 0))
  return Math.round(end * 1000) / 1000
}

// ------------------------------------------------------------ data

type ListKey = 'nodes' | 'init' | 'spawns' | 'cues' | 'base'

// Schema properties a script cannot write (setting them would stop the rebuild): template only.
const NOT_SCRIPTABLE = new Set(['InitialSize'])

// One row of a data list (a Luau expression); spawns rows are grouped by spawn name.
interface Row {
  list: ListKey
  spawn?: string
  text: string
}

// Instance rows, children before their parents (the order the old builder parented them in, so
// GetChildren order is the same): { ClassName, Name, parent row (0 = the effect's Model), { prop,
// value, ... } in authored order, { reference prop, row, ... } (or false)?, { attribute, value,
// ... }? }.
function nodeRows(effect: VfxEffect): { rows: Row[]; root: number } {
  const order: VfxNode[] = []
  const parentOf = new Map<VfxNode, VfxNode | null>()
  const walk = (n: VfxNode, parent: VfxNode | null) => {
    parentOf.set(n, parent)
    for (const c of n.children) walk(c, n)
    order.push(n)
  }
  const top = effect.roots.length === 1 && effect.roots[0].className === 'Model' ? effect.roots[0] : null
  for (const r of effect.roots) walk(r, null)
  const rowOf = new Map<VfxNode, number>()
  order.forEach((n, i) => rowOf.set(n, i + 1))
  // References by id (as before: the last instance in tree order with that id).
  const index = new Map<string, number>()
  for (const n of allNodes(effect.roots)) index.set(n.id, rowOf.get(n)!)
  const rows = order.map((n): Row => {
    const schema = SCHEMA[n.className] ?? {}
    const props: string[] = []
    const refs: string[] = []
    for (const [k, val] of Object.entries(n.props)) {
      const spec = schema[k]
      if (!spec || NOT_SCRIPTABLE.has(k)) continue
      if (spec.kind === 'ref') {
        const at = index.get(String(val))
        if (at) refs.push(luauString(k), String(at))
        continue
      }
      const text = value(spec.kind, val)
      if (text !== null) props.push(luauString(k), text)
    }
    // Attributes (SetAttribute): numbers, booleans and strings (the cue id, EmitCount ...).
    const attrs: string[] = []
    for (const [k, val] of Object.entries(n.attrs ?? {})) {
      if (typeof val === 'number' && Number.isFinite(val)) attrs.push(luauString(k), String(val))
      else if (typeof val === 'boolean') attrs.push(luauString(k), val ? 'true' : 'false')
      else if (typeof val === 'string') attrs.push(luauString(k), luauString(val))
    }
    const parent = parentOf.get(n)
    const bits = [luauString(n.className), luauString(n.name), String(parent ? rowOf.get(parent)! : 0), `{${props.join(',')}}`]
    if (refs.length || attrs.length) bits.push(refs.length ? `{${refs.join(',')}}` : 'false')
    if (attrs.length) bits.push(`{${attrs.join(',')}}`)
    return { list: 'nodes', text: `{${bits.join(',')}}` }
  })
  return { rows, root: top ? rowOf.get(top)! : 0 }
}

const LIST_NAMES: Record<ListKey, string> = { nodes: 'NODES', init: 'INIT', spawns: 'SPAWNS', cues: 'CUES', base: 'BASE_CUES' }

// A list as a Luau table literal (rows indented by `indent` tabs).
function listLiteral(rows: Row[], list: ListKey, indent: number): string {
  const t = '\t'.repeat(indent)
  const mine = rows.filter((r) => r.list === list)
  if (list !== 'spawns') return `{\n${mine.map((r) => `${t}\t${r.text},\n`).join('')}${t}}`
  const names = [...new Set(mine.map((r) => r.spawn!))]
  return `{\n${names.map((s) => `${t}\t[${luauString(s)}] = {\n${mine.filter((r) => r.spawn === s).map((r) => `${t}\t\t${r.text},\n`).join('')}${t}\t},\n`).join('')}${t}}`
}

const usedLists = (rows: Row[]) => (['nodes', 'init', 'spawns', 'cues', 'base'] as ListKey[]).filter((k) => rows.some((r) => r.list === k))

// A data part: a ModuleScript returning { nodes = {...}, cues = {...}, spawns = { name = {...} } }.
function dataModule(name: string, part: number, parts: number, rows: Row[]): string {
  const lists = usedLists(rows)
  return `--!nocheck
${DATA_HEADER}: ${name}, part ${part} of ${parts} (made with the RBX Forge VFX Lab).
-- The ${name} module requires every part; one module would pass Roblox's 200,000-character Source limit.
${rows.some((r) => r.list === 'nodes') ? `${VALUE_HELPERS}\n` : ''}return {
${lists.map((k) => `\t${k} = ${listLiteral(rows, k, 1)},\n`).join('')}}
`
}

// Splits rows into parts that each stay under SOURCE_CAP, at row boundaries, in order.
function splitRows(name: string, rows: Row[], cap: number): Row[][] {
  const overhead = sourceLength(dataModule(name, 999, 999, [{ list: 'nodes', text: '' }])) + 2000
  const budget = cap - overhead
  const parts: Row[][] = []
  let cur: Row[] = []
  let size = 0
  for (const r of rows) {
    const n = sourceLength(r.text) + 4 + (r.spawn ? sourceLength(r.spawn) + 16 : 0)
    if (n > budget) throw new Error(`${name}: one instance or cue of this effect is ${n} characters of Luau, more than a Roblox script can hold`)
    if (cur.length && size + n > budget) {
      parts.push(cur)
      cur = []
      size = 0
    }
    cur.push(r)
    size += n
  }
  if (cur.length) parts.push(cur)
  return parts
}

const LOADER = (parts: number) => `-- This effect is too big for one ModuleScript (Roblox caps a script's Source at 200,000
-- characters): its instances and cues are in the ${DATA_MODULE}1..${DATA_MODULE}${parts} modules next to this one.
local function load(parts: number): { [string]: any }
\tlocal data: { [string]: any } = { nodes = {}, init = {}, spawns = {}, cues = {}, base = {} }
\tfor i = 1, parts do
\t\tlocal part: any = require(script:WaitForChild("${DATA_MODULE}" .. i) :: ModuleScript)
\t\tfor key, list in part do
\t\t\tif key == "spawns" then
\t\t\t\tfor spawn, cues in list do
\t\t\t\t\tlocal into = data.spawns[spawn] or {}
\t\t\t\t\tdata.spawns[spawn] = into
\t\t\t\t\ttable.move(cues, 1, #cues, #into + 1, into)
\t\t\t\tend
\t\t\telse
\t\t\t\tlocal into = data[key]
\t\t\t\ttable.move(list, 1, #list, #into + 1, into)
\t\t\tend
\t\tend
\tend
\treturn data
end
local DATA = load(${parts})`

// The data section of the main module: the lists inline, or loaded from the parts.
function dataSection(rows: Row[], comments: Partial<Record<ListKey, string>>, parts: number, always: ListKey[]): string {
  const lists = (['nodes', 'init', 'spawns', 'cues', 'base'] as ListKey[]).filter((k) => always.includes(k) || rows.some((r) => r.list === k))
  const decl = (k: ListKey) => (k === 'nodes' ? `local ${LIST_NAMES[k]}: { any } = ` : `local ${LIST_NAMES[k]} = `)
  if (parts > 0) return `${LOADER(parts)}\n${lists.map((k) => `${comments[k] ? `${comments[k]}\n` : ''}${decl(k)}DATA.${k}`).join('\n')}`
  return `${rows.some((r) => r.list === 'nodes') ? `${VALUE_HELPERS}\n\n` : ''}${lists.map((k) => `${comments[k] ? `${comments[k]}\n` : ''}${decl(k)}${listLiteral(rows, k, 0)}`).join('\n\n')}`
}

const NODES_COMMENT = `-- The instances, children before their parents: { ClassName, Name, parent (row; 0 = the effect's
-- Model), { property, value, ... }, { reference property, row, ... } or false?, { attribute,
-- value, ... }? }. Used without the template.`

// Scripts cannot set MeshPart.MeshId: a MeshPart row with a mesh is made by
// AssetService:CreateMeshPartAsync (it yields), else a plain MeshPart (MeshId tried, may be refused).
const CREATE_MESHES = `local AssetService = game:GetService("AssetService")

local function create(n: { any }): Instance
\tif n[1] == "MeshPart" then
\t\tlocal props = n[4]
\t\tfor p = 1, #props, 2 do
\t\t\tif props[p] == "MeshId" and props[p + 1] ~= "" then
\t\t\t\tlocal ok, part = pcall(AssetService.CreateMeshPartAsync, AssetService, props[p + 1])
\t\t\t\tif ok and part then
\t\t\t\t\treturn part
\t\t\t\tend
\t\t\tend
\t\tend
\tend
\treturn Instance.new(n[1])
end

local warned = false
`

// Builds the model from NODES (when there is no template next to the module). meshes: the effect
// has MeshParts / unions, which only the template carries whole: the rebuild warns once.
const BUILD = (template: string, root: number, meshes: boolean, name: string) => `local ROOT = ${root}

${meshes ? CREATE_MESHES : ''}local function build(): Model
\tlocal template = script:FindFirstChild(${luauString(template)})
\tif template then
\t\treturn (template :: any):Clone()
\tend
${
  meshes
    ? `\tif not warned then
\t\twarned = true
\t\twarn(${luauString(`${name}: built without its ${template} template (Effect.rbxmx next to the module): meshes load through AssetService:CreateMeshPartAsync and unions have no geometry.`)})
\tend
`
    : ''
}\tlocal made: { any } = {}
\tfor i, n in NODES do
\t\tlocal inst: any = ${meshes ? 'create(n)' : 'Instance.new(n[1])'}
\t\tinst.Name = n[2]
\t\tlocal props = n[4]
\t\tfor p = 1, #props, 2 do
${
  meshes
    ? `\t\t\tlocal key, v = props[p], props[p + 1]
\t\t\tif key == "MeshId" and inst:IsA("MeshPart") then
\t\t\t\tif inst.MeshId ~= v then
\t\t\t\t\tpcall(function()
\t\t\t\t\t\tinst.MeshId = v
\t\t\t\t\tend)
\t\t\t\tend
\t\t\telse
\t\t\t\tinst[key] = v
\t\t\tend
`
    : `\t\t\tinst[props[p]] = props[p + 1]
`
}\t\tend
\t\tlocal attrs = n[6]
\t\tif attrs then
\t\t\tfor a = 1, #attrs, 2 do
\t\t\t\tpcall(inst.SetAttribute, inst, attrs[a], attrs[a + 1])
\t\t\tend
\t\tend
\t\tmade[i] = inst
\tend
\tlocal model = if ROOT > 0 then made[ROOT] else Instance.new("Model")
\tfor i, n in NODES do
\t\tif i ~= ROOT then
\t\t\tmade[i].Parent = if n[3] > 0 then made[n[3]] else model
\t\tend
\tend
\tfor i, n in NODES do
\t\tlocal refs = n[5]
\t\tif refs then
\t\t\tfor p = 1, #refs, 2 do
\t\t\t\tmade[i][refs[p]] = made[refs[p + 1]]
\t\t\tend
\t\tend
\tend
\treturn model
end`

export interface EffectModules {
  // The effect module (init.luau / the ModuleScript the job requires).
  source: string
  // Its child data modules, empty unless the effect is too big for one module.
  data: { name: string; source: string }[]
}

// The module plays the effect with its anchor at the target (placement.ts): an effect imported with
// the world positions of its place is moved to the origin here, as in the preview. The Effect.rbxmx
// template written next to the module must come from the same centred copy (centreEffect).
// opts.cap: the size past which the data moves to parts (SOURCE_CAP; tests force a split with less).
export function effectModules(authored: VfxEffect, opts: { description?: string; templateName?: string; cap?: number } = {}): EffectModules {
  const cap = opts.cap ?? SOURCE_CAP
  const effect = shippedEffect(centreEffect(authored))
  const nodes = allNodes(effect.roots)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const { rows: instanceRows, root } = nodeRows(effect)
  const maxLife = Math.max(
    0,
    ...nodes.filter((n) => n.className === 'ParticleEmitter').map((n) => {
      const l = n.props.Lifetime
      return Array.isArray(l) ? Number(l[1]) || 0 : 10
    }),
    ...nodes.filter((n) => n.className === 'Trail').map((n) => Number(n.props.Lifetime ?? 2))
  )
  const meshes = nodes.some((n) => n.className === 'MeshPart' || n.className === 'UnionOperation')
  const p: ModuleParts = {
    byId,
    build: BUILD(opts.templateName ?? 'Effect', root, meshes, effect.name),
    duration: moduleDuration(effect),
    maxLife,
    desc: (opts.description ?? '').replace(/\s+/g, ' ').trim()
  }
  const make = needsRuntime(effect) ? scriptedModule : plainModule
  const rows = [...instanceRows, ...(needsRuntime(effect) ? scriptedRows(effect, p) : plainRows(effect, p))]
  const inline = make(effect, p, rows, 0)
  if (sourceLength(inline) < cap) return { source: inline, data: [] }
  const parts = splitRows(effect.name, rows, cap)
  const out: EffectModules = { source: make(effect, p, rows, parts.length), data: parts.map((r, i) => ({ name: `${DATA_MODULE}${i + 1}`, source: dataModule(effect.name, i + 1, parts.length, r) })) }
  for (const m of [{ name: effect.name, source: out.source }, ...out.data]) {
    const n = sourceLength(m.source)
    if (n >= cap) throw new Error(`${effect.name}: the ${m.name} module is ${n} characters, more than a Roblox script can hold`)
  }
  return out
}

// The effect module alone, for effects that fit in one module (tests and small tools); callers that
// write or ship modules use effectModules and its data parts.
export function luauModule(authored: VfxEffect, opts: { description?: string; templateName?: string } = {}): string {
  const m = effectModules(authored, opts)
  if (m.data.length) throw new Error(`${authored.name} is too big for one module (${m.data.length} data parts); use effectModules`)
  return m.source
}

interface ModuleParts {
  byId: Map<string, VfxNode>
  build: string
  duration: number
  maxLife: number
  desc: string
}

// A cue target's ForgeId (shippedEffect gives every cue target one).
const nodeId = (n: VfxNode): number => Number(n.attrs?.[NODE_ID_ATTR]) || 0

// Plain cues: { at, instance id (ForgeId), instance name, "emit" | "enable" | "disable", count }.
function plainRows(effect: VfxEffect, p: ModuleParts): Row[] {
  return effect.cues
    .filter((c) => p.byId.has(c.target))
    .map((c) => {
      const n = p.byId.get(c.target)!
      return { list: 'cues', text: `{ ${fmt(c.at)}, ${nodeId(n)}, ${luauString(n.name)}, "${c.action === 'emit' ? 'emit' : c.action === 'enable' ? 'enable' : 'disable'}"${c.action === 'emit' ? `, ${Math.round(c.count ?? 16)}` : ''} }` }
    })
}

function plainModule(effect: VfxEffect, p: ModuleParts, rows: Row[], parts: number): string {
  return `--!strict
-- ${effect.name}: made with the RBX Forge VFX Lab.${p.desc ? `\n-- ${p.desc.slice(0, 200)}` : ''}
-- Usage:
--   local ${effect.name} = require(ReplicatedStorage.Shared.VFX.${effect.name})
--   ${effect.name}.play(target) -- target: CFrame, BasePart or Attachment; returns the effect Model
local Debris = game:GetService("Debris")

local Effect = {}

-- Seconds of the timeline, and how long the last particles can live after it.
Effect.Duration = ${fmt(p.duration)}
Effect.Linger = ${fmt(Math.min(20, p.maxLife))}

${dataSection(rows, { nodes: NODES_COMMENT, cues: `-- Timeline: Emit bursts and Enabled toggles: { at, instance (its ${NODE_ID_ATTR} attribute), name, action, count }.` }, parts, ['nodes', 'cues'])}

${p.build}

local function place(model: Model, target: any)
\t-- The effect's anchor is at the model's origin: play it there (a new Model's pivot would be the
\t-- centre of its bounding box).
\tif not model.PrimaryPart then
\t\tmodel.WorldPivot = CFrame.new()
\tend
\tif typeof(target) == "CFrame" then
\t\tmodel:PivotTo(target)
\telseif typeof(target) == "Instance" and target:IsA("Attachment") then
\t\tmodel:PivotTo(target.WorldCFrame)
\telseif typeof(target) == "Instance" and target:IsA("BasePart") then
\t\tmodel:PivotTo(target.CFrame)
\t\tlocal root = model.PrimaryPart or model:FindFirstChildWhichIsA("BasePart")
\t\tif root then
\t\t\t-- Follow the part: unanchor the effect's parts and weld them on.
\t\t\tfor _, part in model:GetDescendants() do
\t\t\t\tif part:IsA("BasePart") then
\t\t\t\t\tpart.Anchored = false
\t\t\t\t\tlocal weld = Instance.new("WeldConstraint")
\t\t\t\t\tweld.Part0 = part
\t\t\t\t\tweld.Part1 = target
\t\t\t\t\tweld.Parent = part
\t\t\t\tend
\t\t\tend
\t\tend
\tend
end

local TOGGLES: { [string]: boolean } = { ParticleEmitter = true, Beam = true, Trail = true, PointLight = true, SpotLight = true, SurfaceLight = true, Highlight = true }

-- Emit only on ParticleEmitters, Enabled only on what has it (a Part may share an emitter's name).
local function run(fx: Instance, cue: { any })
\tif cue[4] == "emit" then
\t\tif fx:IsA("ParticleEmitter") then
\t\t\tfx:Emit(cue[5])
\t\tend
\telseif TOGGLES[fx.ClassName] then
\t\t(fx :: any).Enabled = cue[4] == "enable"
\tend
end

-- The instances each cue addresses, by their ${NODE_ID_ATTR} attribute (names repeat in imported packs).
local function byId(model: Model): { [number]: { Instance } }
\tlocal out: { [number]: { Instance } } = {}
\tfor _, d in model:GetDescendants() do
\t\tlocal id = d:GetAttribute("${NODE_ID_ATTR}")
\t\tif type(id) == "number" then
\t\t\tlocal list = out[id] or {}
\t\t\tout[id] = list
\t\t\ttable.insert(list, d)
\t\tend
\tend
\treturn out
end

-- Builds, places and plays the effect; it removes itself when done.
function Effect.play(target: any, parent: Instance?): Model
\tlocal model = build()
\tplace(model, target or CFrame.new())
\tmodel.Parent = parent or workspace
\tlocal ids = byId(model)
\tfor _, cue in CUES do
\t\tlocal targets = ids[cue[2]]
\t\tif not targets then
\t\t\t-- A template without ids: the first instance with the name.
\t\t\tlocal found = model:FindFirstChild(cue[3], true)
\t\t\ttargets = if found then { found } else {}
\t\tend
\t\tfor _, fx in targets do
\t\t\tif cue[1] <= 0 then
\t\t\t\trun(fx, cue)
\t\t\telse
\t\t\t\ttask.delay(cue[1], run, fx, cue)
\t\t\tend
\t\tend
\tend
\ttask.delay(Effect.Duration, function()
\t\tfor _, d in model:GetDescendants() do
\t\t\tif d:IsA("ParticleEmitter") or d:IsA("Trail") or d:IsA("Beam") then
\t\t\t\t(d :: any).Enabled = false
\t\t\tend
\t\tend
\tend)
\tDebris:AddItem(model, Effect.Duration + Effect.Linger + 0.5)
\treturn model
end

return Effect
`
}

// Rows of a scripted effect: the prelude (INIT), what each fx:spawn brings in (SPAWNS), the whole
// compiled timeline (CUES) and the base effect's own cues (BASE_CUES).
function scriptedRows(effect: VfxEffect, p: ModuleParts): Row[] {
  const cues = effect.cues.filter((c) => p.byId.has(c.target))
  const node = (c: VfxCue) => p.byId.get(c.target)!
  const rows: Row[] = cues.filter((c) => c.prelude && c.props).map((c) => ({ list: 'init', text: `{ ${nodeId(node(c)) ? `id = ${nodeId(node(c))}, ` : ''}name = ${luauString(node(c).name)}, goals = ${goalsTable(node(c), c.props!)} }` }))
  const live = cues.filter((c) => !c.prelude)
  for (const s of new Set(live.filter((c) => c.spawn).map((c) => c.spawn!))) {
    for (const c of live.filter((c) => c.spawn === s)) rows.push({ list: 'spawns', spawn: s, text: cueTable(c, node(c), 'dt', Math.max(0, c.at - (c.spawnAt ?? 0))) })
  }
  for (const c of live) rows.push({ list: 'cues', text: cueTable(c, node(c), 'at', c.at) })
  // Cues of the effect the script was built on (a library copy under a composed sequence): the
  // Timeline module only replays the script, so these run next to it.
  for (const c of live.filter((c) => !c.script && !c.spawn)) rows.push({ list: 'base', text: cueTable(c, node(c), 'at', c.at) })
  return rows
}

// The module of a scripted effect: builds the model, applies the prelude, then runs the Timeline
// script through ForgeFX (or, without a Timeline child, the compiled cue list).
function scriptedModule(effect: VfxEffect, p: ModuleParts, rows: Row[], parts: number): string {
  const name = effect.name
  const hasBase = rows.some((r) => r.list === 'base')
  const stages = (effect.stages ?? []).map((s) => `{ at = ${fmt(s.at)}, label = ${luauString(s.label)} }`)
  const comments: Partial<Record<ListKey, string>> = {
    nodes: NODES_COMMENT,
    init: '-- State before each rig appears (applied before the model is parented).',
    spawns: '-- What fx:spawn(name) brings in (seconds after the spawn).',
    cues: '-- The whole timeline, compiled (used when there is no Timeline module).',
    base: "-- The base effect's own cues (they play next to the Timeline module)."
  }
  return `--!nonstrict
-- ${name}: made with the RBX Forge VFX Lab (scripted timeline).${p.desc ? `\n-- ${p.desc.slice(0, 200)}` : ''}
-- Usage:
--   local ${name} = require(ReplicatedStorage.Shared.VFX.${name})
--   ${name}.play(target, parent?, { onStage = function(label) end }) -- target: CFrame, BasePart or Attachment
-- The timeline is the Timeline module next to this one (the script from Forge's Script tab); the
-- ${RUNTIME_MODULE} module runs it with TweenService, task.wait / task.delay, Emit and Enabled.
local Debris = game:GetService("Debris")
local RunService = game:GetService("RunService")
local ${RUNTIME_MODULE} = require(script.Parent:WaitForChild("${RUNTIME_MODULE}"))

local Effect = {}

-- Seconds of the timeline, and how long the last particles can live after it.
Effect.Duration = ${fmt(p.duration)}
Effect.Linger = ${fmt(Math.min(20, p.maxLife))}
Effect.Stages = { ${stages.join(', ')} }

${dataSection(rows, comments, parts, ['nodes', 'init', 'spawns', 'cues'])}

${p.build}

local function pivot(target: any): CFrame
\tif typeof(target) == "CFrame" then
\t\treturn target
\telseif typeof(target) == "Instance" and target:IsA("Attachment") then
\t\treturn target.WorldCFrame
\telseif typeof(target) == "Instance" and target:IsA("BasePart") then
\t\treturn target.CFrame
\tend
\treturn CFrame.new()
end

-- A BasePart or Attachment target: the effect moves with it every frame until the model is gone
-- (re-pivoted by how far the target moved; ForgeFX drives part tweens relative to the effect, so
-- they keep their motion while it follows).
local function follow(model: Model, fx: any, target: any)
\tif typeof(target) ~= "Instance" or not (target:IsA("BasePart") or target:IsA("Attachment")) then
\t\treturn
\tend
\tlocal last = pivot(target)
\tlocal conn
\tconn = RunService.Heartbeat:Connect(function()
\t\tif not model.Parent or not target.Parent then
\t\t\tconn:Disconnect()
\t\t\treturn
\t\tend
\t\tlocal now = pivot(target)
\t\tif now ~= last then
\t\t\tlocal moved = now * last:Inverse()
\t\t\tlast = now
\t\t\tmodel:PivotTo(moved * model:GetPivot())
\t\t\tfx.pivot = moved * fx.pivot
\t\tend
\tend)
end

-- Builds, places and plays the effect; it removes itself when done. Returns the model and the fx
-- object (fx:stop() cancels what is still scheduled).
function Effect.play(target: any, parent: Instance?, options: { onStage: ((string, number) -> ())? }?): (Model, any)
\tlocal model = build()
\tlocal root = model:FindFirstChild("Root")
\tif root and root:IsA("BasePart") then
\t\tmodel.PrimaryPart = root
\telseif not model.PrimaryPart then
\t\t-- No Root part: the effect's anchor is at the model's origin.
\t\tmodel.WorldPivot = CFrame.new()
\tend
\tmodel:PivotTo(pivot(target))
\tlocal fx = ${RUNTIME_MODULE}.new(model, { spawns = SPAWNS, onStage = options and options.onStage })
\tfx:prelude(INIT)
\tmodel.Parent = parent or workspace
\tfollow(model, fx, target)
\t-- The Timeline module returns the timeline function; without one (or when it returns nothing, as
\t-- a Timeline.luau left from an older scripted version does) the compiled cues play.
\tlocal timeline = script:FindFirstChild("Timeline")
\tlocal ok, fn = false, nil
\tif timeline then
\t\tok, fn = pcall(require, timeline)
\t\tif not ok then
\t\t\twarn(${luauString(`${name}: its Timeline module failed (the compiled cues play instead): `)} .. tostring(fn))
\t\tend
\tend
\tif ok and type(fn) == "function" then
${hasBase ? '\t\tfx:runCues(BASE_CUES)\n' : ''}\t\tfx:run(fn)
\telse
\t\tfx:runCues(CUES, Effect.Stages)
\tend
\ttask.delay(Effect.Duration, function()
\t\tfx.alive = false
\t\tfor _, d in model:GetDescendants() do
\t\t\tif d:IsA("ParticleEmitter") or d:IsA("Trail") or d:IsA("Beam") then
\t\t\t\t(d :: any).Enabled = false
\t\t\tend
\t\tend
\tend)
\tDebris:AddItem(model, Effect.Duration + Effect.Linger + 0.5)
\treturn model, fx
end

return Effect
`
}
