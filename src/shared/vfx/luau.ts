// Luau module for an effect, GenTree style: src/shared/VFX/<Name>/init.luau next to the model
// template src/shared/VFX/<Name>/Effect.rbxmx (Rojo turns the folder into a ModuleScript with the
// model as its child "Effect"). The module clones the template (or builds the instances in code when
// the template is missing), places it, runs the timeline (Emit bursts, Enabled toggles) and cleans up.

import { allNodes } from './analyze.ts'
import { RUNTIME_MODULE } from './runtime.ts'
import { SCHEMA } from './schema.ts'
import { fmt, luauColorSequence, luauNumberSequence } from './sequence.ts'
import { tweenKind } from './timeline.ts'
import type { ColorKey, NumKey, PropValue, VfxCue, VfxEffect, VfxNode } from './types.ts'

function value(kind: string, v: PropValue, refName: (id: string) => string | null): string | null {
  const a = Array.isArray(v) ? (v as number[]) : []
  switch (kind) {
    case 'number':
    case 'int':
      return fmt(Number(v))
    case 'bool':
      return v ? 'true' : 'false'
    case 'string':
    case 'content':
      return JSON.stringify(String(v))
    case 'vec2':
      return `Vector2.new(${fmt(a[0])}, ${fmt(a[1])})`
    case 'vec3':
      return `Vector3.new(${fmt(a[0])}, ${fmt(a[1])}, ${fmt(a[2])})`
    case 'color3':
      return `Color3.new(${fmt(a[0])}, ${fmt(a[1])}, ${fmt(a[2])})`
    case 'range':
      return `NumberRange.new(${fmt(a[0])}, ${fmt(a[1] ?? a[0])})`
    case 'nseq':
      return luauNumberSequence(v as NumKey[])
    case 'cseq':
      return luauColorSequence(v as ColorKey[])
    case 'cframe':
      return `CFrame.new(${a.map(fmt).join(', ')})`
    case 'ref':
      return refName(String(v))
    default:
      return kind.startsWith('enum:') ? `Enum.${kind.slice(5)}.${String(v)}` : null
  }
}

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
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `[${JSON.stringify(k)}]`
}

// One cue as a Luau table for ForgeFX:cue.
function cueTable(c: VfxCue, node: VfxNode, timeKey: 'at' | 'dt', time: number): string {
  const bits = [`${timeKey} = ${fmt(time)}`, `name = ${JSON.stringify(node.name)}`, `action = "${c.action}"`]
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

export function luauModule(effect: VfxEffect, opts: { description?: string; templateName?: string } = {}): string {
  const nodes = allNodes(effect.roots)
  const vars = new Map<string, string>()
  nodes.forEach((n, i) => vars.set(n.id, `i${i}`))
  const refName = (id: string) => vars.get(id) ?? null
  const build: string[] = []
  const refs: string[] = []
  const emit = (n: VfxNode, parentVar: string | null) => {
    const v = vars.get(n.id)!
    build.push(`\tlocal ${v} = Instance.new(${JSON.stringify(n.className)})`)
    build.push(`\t${v}.Name = ${JSON.stringify(n.name)}`)
    const schema = SCHEMA[n.className] ?? {}
    for (const [k, val] of Object.entries(n.props)) {
      const spec = schema[k]
      if (!spec) continue
      const text = value(spec.kind, val, refName)
      if (text === null) continue
      ;(spec.kind === 'ref' ? refs : build).push(`\t${v}.${k} = ${text}`)
    }
    for (const c of n.children) emit(c, v)
    if (parentVar) build.push(`\t${v}.Parent = ${parentVar}`)
  }
  const top = effect.roots.length === 1 && effect.roots[0].className === 'Model' ? effect.roots[0] : null
  if (top) emit(top, null)
  else {
    build.push('\tlocal model = Instance.new("Model")')
    for (const r of effect.roots) emit(r, 'model')
  }
  const modelVar = top ? vars.get(top.id)! : 'model'
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const cueLines = effect.cues
    .filter((c) => byId.has(c.target))
    .map((c) => {
      const name = JSON.stringify(byId.get(c.target)!.name)
      const call = c.action === 'emit' ? `:Emit(${Math.round(c.count ?? 16)})` : `.Enabled = ${c.action === 'enable'}`
      return `\t{ at = ${fmt(c.at)}, name = ${name}, run = function(fx: any) fx${call} end },`
    })
  const maxLife = Math.max(
    0,
    ...nodes.filter((n) => n.className === 'ParticleEmitter').map((n) => {
      const l = n.props.Lifetime
      return Array.isArray(l) ? Number(l[1]) || 0 : 10
    }),
    ...nodes.filter((n) => n.className === 'Trail').map((n) => Number(n.props.Lifetime ?? 2))
  )
  const template = opts.templateName ?? 'Effect'
  const desc = (opts.description ?? '').replace(/\s+/g, ' ').trim()
  if (needsRuntime(effect)) return scriptedModule(effect, { nodes, byId, build, refs, modelVar, maxLife, template, desc })
  return `--!strict
-- ${effect.name}: made with the RBX Forge VFX Lab.${desc ? `\n-- ${desc.slice(0, 200)}` : ''}
-- Usage:
--   local ${effect.name} = require(ReplicatedStorage.Shared.VFX.${effect.name})
--   ${effect.name}.play(target) -- target: CFrame, BasePart or Attachment; returns the effect Model
local Debris = game:GetService("Debris")

local Effect = {}

-- Seconds of the timeline, and how long the last particles can live after it.
Effect.Duration = ${fmt(effect.duration)}
Effect.Linger = ${fmt(Math.min(20, maxLife))}

-- Timeline: Emit bursts and Enabled toggles, by instance name.
local CUES = {
${cueLines.join('\n')}
}

local function build(): Model
\tlocal template = script:FindFirstChild(${JSON.stringify(template)})
\tif template then
\t\treturn (template :: any):Clone()
\tend
${build.join('\n')}
${refs.join('\n')}
\treturn ${modelVar}
end

local function place(model: Model, target: any)
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

-- Builds, places and plays the effect; it removes itself when done.
function Effect.play(target: any, parent: Instance?): Model
\tlocal model = build()
\tplace(model, target or CFrame.new())
\tmodel.Parent = parent or workspace
\tfor _, cue in CUES do
\t\tlocal fx = model:FindFirstChild(cue.name, true)
\t\tif fx then
\t\t\tif cue.at <= 0 then
\t\t\t\tcue.run(fx)
\t\t\telse
\t\t\t\ttask.delay(cue.at, cue.run, fx)
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

interface ModuleParts {
  nodes: VfxNode[]
  byId: Map<string, VfxNode>
  build: string[]
  refs: string[]
  modelVar: string
  maxLife: number
  template: string
  desc: string
}

// The module of a scripted effect: builds the model, applies the prelude, then runs the Timeline
// script through ForgeFX (or, without a Timeline child, the compiled cue list).
function scriptedModule(effect: VfxEffect, p: ModuleParts): string {
  const name = effect.name
  const cues = effect.cues.filter((c) => p.byId.has(c.target))
  const init = cues.filter((c) => c.prelude && c.props).map((c) => `\t{ name = ${JSON.stringify(p.byId.get(c.target)!.name)}, goals = ${goalsTable(p.byId.get(c.target)!, c.props!)} },`)
  const live = cues.filter((c) => !c.prelude)
  const spawnNames = [...new Set(live.filter((c) => c.spawn).map((c) => c.spawn!))]
  const spawns = spawnNames.map((s) => {
    const mine = live.filter((c) => c.spawn === s)
    return `\t[${JSON.stringify(s)}] = {\n${mine.map((c) => `\t\t${cueTable(c, p.byId.get(c.target)!, 'dt', Math.max(0, c.at - (c.spawnAt ?? 0)))},`).join('\n')}\n\t},`
  })
  const cueLines = live.map((c) => `\t${cueTable(c, p.byId.get(c.target)!, 'at', c.at)},`)
  const stages = (effect.stages ?? []).map((s) => `{ at = ${fmt(s.at)}, label = ${JSON.stringify(s.label)} }`)
  return `--!nonstrict
-- ${name}: made with the RBX Forge VFX Lab (scripted timeline).${p.desc ? `\n-- ${p.desc.slice(0, 200)}` : ''}
-- Usage:
--   local ${name} = require(ReplicatedStorage.Shared.VFX.${name})
--   ${name}.play(target, parent?, { onStage = function(label) end }) -- target: CFrame, BasePart or Attachment
-- The timeline is the Timeline module next to this one (the script from Forge's Script tab); the
-- ${RUNTIME_MODULE} module runs it with TweenService, task.wait / task.delay, Emit and Enabled.
local Debris = game:GetService("Debris")
local ${RUNTIME_MODULE} = require(script.Parent:WaitForChild("${RUNTIME_MODULE}"))

local Effect = {}

-- Seconds of the timeline, and how long the last particles can live after it.
Effect.Duration = ${fmt(effect.duration)}
Effect.Linger = ${fmt(Math.min(20, p.maxLife))}
Effect.Stages = { ${stages.join(', ')} }

-- State before each rig appears (applied before the model is parented).
local INIT = {
${init.join('\n')}
}

-- What fx:spawn(name) brings in (seconds after the spawn).
local SPAWNS = {
${spawns.join('\n')}
}

-- The whole timeline, compiled (used when there is no Timeline module).
local CUES = {
${cueLines.join('\n')}
}

local function build(): Model
\tlocal template = script:FindFirstChild(${JSON.stringify(p.template)})
\tif template then
\t\treturn (template :: any):Clone()
\tend
${p.build.join('\n')}
${p.refs.join('\n')}
\treturn ${p.modelVar}
end

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

-- Builds, places and plays the effect; it removes itself when done. Returns the model and the fx
-- object (fx:stop() cancels what is still scheduled).
function Effect.play(target: any, parent: Instance?, options: { onStage: ((string, number) -> ())? }?): (Model, any)
\tlocal model = build()
\tlocal root = model:FindFirstChild("Root")
\tif root and root:IsA("BasePart") then
\t\tmodel.PrimaryPart = root
\tend
\tmodel:PivotTo(pivot(target))
\tlocal fx = ${RUNTIME_MODULE}.new(model, { spawns = SPAWNS, onStage = options and options.onStage })
\tfx:prelude(INIT)
\tmodel.Parent = parent or workspace
\tlocal timeline = script:FindFirstChild("Timeline")
\tif timeline then
\t\tfx:run(require(timeline) :: any)
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
