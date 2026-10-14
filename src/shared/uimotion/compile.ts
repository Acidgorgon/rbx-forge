// Spec -> Luau. The export module (Motion/<Name>Effects.luau: the stack as data plus only the runtime
// parts it uses), and the lab's scratch story that runs any stack live in the UI preview (every part
// of the runtime, specs passed in as UI Labs controls so slider moves apply without a reload). Pure.

import { SPRING_LUAU } from './spring.ts'
import { RUNTIME_LUAU } from './runtime.luau.ts'
import { describeSpec, EFFECT_KINDS, usedKinds, type EffectKind, type MotionSpec } from './spec.ts'

function services(kinds: Set<string>): string {
  const tween = ['appear', 'disappear', 'shine', 'ripple'].some((k) => kinds.has(k))
  return [
    'local GuiService = game:GetService("GuiService")',
    'local RunService = game:GetService("RunService")',
    ...(tween ? ['local TweenService = game:GetService("TweenService")'] : []),
    'local UserInputService = game:GetService("UserInputService")'
  ].join('\n')
}

// Keeps "--#if a,b" ... "--#end" blocks when one of the kinds is used.
export function selectBlocks(source: string, kinds: Set<string>): string {
  const out: string[] = []
  let keep: boolean[] = []
  for (const line of source.split('\n')) {
    const open = /^\s*--#if\s+([a-z,]+)\s*$/.exec(line)
    if (open) {
      keep.push(open[1].split(',').some((k) => kinds.has(k)))
      continue
    }
    if (/^\s*--#end\s*$/.test(line)) {
      keep = keep.slice(0, -1)
      continue
    }
    if (keep.every(Boolean)) out.push(line)
  }
  return out.join('\n')
}

const num = (n: number) => {
  const r = Math.round(n * 10000) / 10000
  return Object.is(r, -0) ? '0' : String(r)
}

function luauValue(v: unknown, indent: string): string {
  if (typeof v === 'number') return num(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return `{ ${v.map((x) => luauValue(x, indent)).join(', ')} }`
  if (v && typeof v === 'object') {
    const inner = indent + '\t'
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
    if (!entries.length) return '{}'
    return `{\n${entries.map(([k, x]) => `${inner}${/^[A-Za-z_]\w*$/.test(k) ? k : `[${JSON.stringify(k)}]`} = ${luauValue(x, inner)},`).join('\n')}\n${indent}}`
  }
  return 'nil'
}

// The spec in the runtime's shape: effects keyed by kind.
export function runtimeSpec(spec: MotionSpec): { reducedMotion: string; targets: { path: string; effects: Record<string, Record<string, unknown>> }[] } {
  return {
    reducedMotion: spec.reducedMotion,
    targets: spec.targets.map((t) => ({
      path: t.path,
      effects: Object.fromEntries(t.effects.map((e) => {
        const { kind, ...rest } = e as unknown as Record<string, unknown> & { kind: string }
        return [kind, rest]
      }))
    }))
  }
}

export function specLuau(spec: MotionSpec): string {
  return luauValue(runtimeSpec(spec), '')
}

function runtimeFor(kinds: Set<string>): string {
  return selectBlocks(RUNTIME_LUAU, kinds)
}

export interface CompileOptions {
  // Where it came from, for the header ("UI Motion Lab: Play Button / Bouncy").
  source?: string
}

// The export module. require(it).attach(root) returns { destroy, show, hide }.
export function compileMotionModule(spec: MotionSpec, opts: CompileOptions = {}): string {
  const kinds = usedKinds(spec)
  const lines = [
    '--!strict',
    `-- ${spec.name}: UI motion compiled by RBX Forge's UI Motion Lab${opts.source ? ` (${opts.source})` : ''}.`,
    '-- Client only: require it from a LocalScript or a UI component, then',
    '--   local motion = Effects.attach(button)  -- returns { destroy, show, hide }',
    '--   motion.hide(function() button.Visible = false end)',
    '-- Springs: x\'\' = -w^2 (x - goal) - 2 z w x\', w = 2 pi frequency, z = damping ratio, stepped in closed form',
    '-- every RenderStepped (frame-rate independent). Quenty\'s Spring: Speed = 2 pi frequency, Damper = damping.',
    '-- Reduced motion (GuiService.ReducedMotionEnabled) drops float, tilt, idle shine, ripple, pop and squash',
    '-- and removes overshoot, unless SPEC.reducedMotion is "ignore". Regenerate from the lab; hand edits are',
    '-- overwritten on the next export.',
    '--',
    ...describeSpec(spec).split('\n').map((l) => `--   ${l}`),
    '',
    services(kinds),
    '',
    SPRING_LUAU,
    '',
    `local SPEC = ${specLuau(spec)}`,
    '',
    runtimeFor(kinds),
    '',
    'Effects.spec = SPEC',
    '',
    'return Effects',
    ''
  ]
  return lines.join('\n')
}

// ---- the lab story (scratch, in <project>/.forge/uimotion/lab/, not part of the game)

export type LabSubject =
  // An imported / generated component module: require(path)(parent?) -> GuiObject.
  | { kind: 'component'; require: string; name: string }
  // An existing UI Labs story (function, generic or Vide); paths resolve under each slot.
  | { kind: 'story'; require: string; name: string }

export const LAB_SLOTS = 3
export const LAB_HOLDER = 'ForgeMotionLab'

export function labStoryLuau(subject: LabSubject): string {
  const all = new Set<string>(EFFECT_KINDS as readonly EffectKind[])
  const mount =
    subject.kind === 'component'
      ? `local Component = require(${subject.require}) :: any

local function mount(slot: Frame): (Instance, () -> ())
	local ui = Component()
	ui.AnchorPoint = Vector2.new(0.5, 0.5)
	ui.Position = UDim2.fromScale(0.5, 0.5)
	ui.Parent = slot
	return ui, function()
		ui:Destroy()
	end
end`
      : `local Story = require(${subject.require}) :: any

-- Renders the story into the slot the way UI Labs does (controls at their defaults).
local function mount(slot: Frame): (Instance, () -> ())
	local cleanup: any = nil
	if type(Story) == "function" then
		cleanup = Story(slot)
	elseif type(Story) == "table" and Story.vide then
		local vide = Story.vide
		local controls = {}
		for key, control in Story.controls or {} do
			if type(control) ~= "table" then
				controls[key] = vide.source(control)
			elseif control.ControlValue ~= nil then
				controls[key] = vide.source(control.ControlValue)
			end
		end
		cleanup = vide.mount(function()
			return Story.story({ controls = controls, target = slot })
		end, slot)
	elseif type(Story) == "table" and Story.render then
		local values = {}
		for key, control in Story.controls or {} do
			values[key] = if type(control) == "table" then control.ControlValue else control
		end
		cleanup = Story.render({ target = slot, controls = values, converted = Story.controls or {}, subscribe = function()
			return function() end
		end })
	end
	return slot, function()
		if type(cleanup) == "function" then
			cleanup()
		end
	end
end`
  return [
    '--!nocheck',
    `-- RBX Forge UI Motion Lab scratch story for ${subject.name} (generated; not part of the game).`,
    '-- Controls: Slots (1-3), Spec1..Spec3 (motion stacks as JSON), Label1..Label3, Trigger, Reduced.',
    services(all),
    'local HttpService = game:GetService("HttpService")',
    '',
    SPRING_LUAU,
    '',
    'local SPEC = { reducedMotion = "respect", targets = {} }',
    '',
    runtimeFor(all),
    '',
    mount,
    '',
    `-- Forge's spec JSON ({targets = {{path, effects = {{kind, ...}}}}}) in the runtime's shape.
local function decode(text: string): any
	if type(text) ~= "string" or text == "" then
		return nil
	end
	local ok, raw = pcall(function()
		return HttpService:JSONDecode(text)
	end)
	if not ok or type(raw) ~= "table" then
		warn("[motion lab] bad spec JSON")
		return nil
	end
	local targets = {}
	for _, t in raw.targets or {} do
		local effects = {}
		for _, e in t.effects or {} do
			local copy = table.clone(e)
			copy.kind = nil
			effects[e.kind] = copy
		end
		table.insert(targets, { path = t.path or "", effects = effects })
	end
	return { reducedMotion = raw.reducedMotion or "respect", targets = targets }
end

local controls = {
	Slots = 1,
	Spec1 = "",
	Spec2 = "",
	Spec3 = "",
	Label1 = "",
	Label2 = "",
	Label3 = "",
	Trigger = "",
	Reduced = false,
}

return {
	controls = controls,
	render = function(props)
		local holder = Instance.new("Frame")
		holder.Name = "${LAB_HOLDER}"
		holder.Size = UDim2.fromScale(1, 1)
		holder.BackgroundTransparency = 1
		holder.Parent = props.target
		local slots = {}
		local current = table.clone(props.controls)

		local function clear()
			for _, s in slots do
				if s.handle then
					s.handle.destroy()
				end
				s.unmount()
				s.frame:Destroy()
			end
			table.clear(slots)
		end

		local function build(values)
			clear()
			local n = math.clamp(math.floor(tonumber(values.Slots) or 1), 1, ${LAB_SLOTS})
			for i = 1, n do
				local frame = Instance.new("Frame")
				frame.Name = "Slot" .. i
				frame.AnchorPoint = Vector2.new(0.5, 0.5)
				frame.Position = UDim2.fromScale((i - 0.5) / n, 0.5)
				frame.Size = UDim2.fromScale(1 / n, 1)
				frame.BackgroundTransparency = 1
				frame.Parent = holder
				local label = values["Label" .. i]
				if n > 1 and type(label) == "string" and label ~= "" then
					local text = Instance.new("TextLabel")
					text.Name = "ForgeMotionLabel"
					text.AnchorPoint = Vector2.new(0.5, 1)
					text.Position = UDim2.new(0.5, 0, 1, -24)
					text.Size = UDim2.fromOffset(240, 24)
					text.BackgroundTransparency = 1
					text.Text = label
					text.TextSize = 18
					text.TextColor3 = Color3.fromRGB(150, 158, 170)
					text.FontFace = Font.new("rbxasset://fonts/families/RobotoMono.json")
					text.Parent = frame
				end
				local root, unmount = mount(frame)
				local spec = decode(values["Spec" .. i])
				local handle = if spec then Effects.attach(root :: any, spec, { reduced = values.Reduced == true }) else nil
				table.insert(slots, { frame = frame, unmount = unmount, handle = handle })
			end
		end

		build(current)
		local unsubscribe = props.subscribe(function(values)
			local trigger = values.Trigger
			local onlyTrigger = trigger ~= current.Trigger
			for key, value in values do
				if key ~= "Trigger" and current[key] ~= value then
					onlyTrigger = false
				end
			end
			current = table.clone(values)
			if onlyTrigger then
				local action = string.match(tostring(trigger), "^(%a+)")
				for _, s in slots do
					if s.handle and action == "appear" then
						s.handle.show()
					elseif s.handle and action == "disappear" then
						s.handle.hide()
					end
				end
				return
			end
			build(values)
		end)
		return function()
			unsubscribe()
			clear()
			holder:Destroy()
		end
	end,
}`,
    ''
  ].join('\n')
}

// Forge's spec JSON for the lab story's Spec controls.
export function labSpecJson(spec: MotionSpec): string {
  return JSON.stringify({ reducedMotion: spec.reducedMotion, targets: spec.targets })
}
