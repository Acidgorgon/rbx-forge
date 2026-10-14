// UI Motion Lab "From a story" source: the user's own UI (Vide / Roact / plain Instance code) rendered
// from a UI Labs *.story.luau in the lab's slot. Pure parts: the elements effects can target (buttons
// and frames of the rendered tree, by relative instance path under the slot, with a readable name
// path "RacingHud > BOOSTButton"), the element a click in select mode means, and the export for a
// story source: every target becomes its own attach root (the user calls Effects.attach(button) in
// their component), identical stacks share one, and the two lines to paste.

import { luauName, normalizeSpec, type MotionEffect, type MotionSpec } from './spec.ts'

// The classes a story target can be (what the list offers).
export const STORY_TARGET_CLASSES: ReadonlySet<string> = new Set(['TextButton', 'ImageButton', 'GuiButton', 'Frame'])
const BUTTONS: ReadonlySet<string> = new Set(['TextButton', 'ImageButton', 'GuiButton'])
const LIST_LIMIT = 200

// The tree shape both UiTreeSnapshot nodes and PreviewTree nodes have.
export interface TreeNodeLike {
  id: number
  cls: string
  name: string
  parent: number | null
  children: number[]
  props?: Record<string, unknown>
}

export interface StoryTarget {
  // Relative instance path under the slot ("RacingHud.BOOSTButton"): what the spec stores.
  path: string
  // "RacingHud > BOOSTButton": what the list shows.
  label: string
  className: string
  id: number
  button: boolean
  hidden: boolean
}

export const isButtonClass = (cls: string): boolean => BUTTONS.has(cls)

// "RacingHud.Controls.Boost" -> "RacingHud > Controls > Boost".
export function namePath(path: string): string {
  return path ? path.split('.').join(' > ') : '(root)'
}

// Lab-added instances (scale / shine / ripple helpers, labels) are not the user's UI.
const isForge = (n: TreeNodeLike) => /^ForgeMotion/.test(n.name)

function lookup(nodes: Iterable<TreeNodeLike> | Map<number, TreeNodeLike>): Map<number, TreeNodeLike> {
  if (nodes instanceof Map) return nodes
  const m = new Map<number, TreeNodeLike>()
  for (const n of nodes) m.set(n.id, n)
  return m
}

// Buttons and frames under root (the slot the story renders into), in tree order, buttons first.
// Paths resolve with FindFirstChild (first child of a name), so a later sibling with the same name is
// unreachable and left out; names with dots cannot be a path part and are left out too.
export function storyTargets(nodes: Iterable<TreeNodeLike> | Map<number, TreeNodeLike>, rootId: number | null): StoryTarget[] {
  const byId = lookup(nodes)
  const root = rootId == null ? undefined : byId.get(rootId)
  if (!root) return []
  const out: StoryTarget[] = []
  const walk = (node: TreeNodeLike, prefix: string, hidden: boolean) => {
    const seen = new Set<string>()
    for (const cid of node.children) {
      const c = byId.get(cid)
      if (!c || isForge(c) || seen.has(c.name)) continue
      seen.add(c.name)
      if (!c.name || c.name.includes('.')) continue
      const path = prefix ? `${prefix}.${c.name}` : c.name
      const hid = hidden || c.props?.Visible === false
      if (STORY_TARGET_CLASSES.has(c.cls)) out.push({ path, label: namePath(path), className: c.cls, id: c.id, button: isButtonClass(c.cls), hidden: hid })
      walk(c, path, hid)
    }
  }
  walk(root, '', false)
  const buttons = out.filter((t) => t.button)
  return [...buttons, ...out.filter((t) => !t.button)].slice(0, LIST_LIMIT)
}

// The target a click on node id means: the nearest enclosing button (a click on a button's label
// picks the button), else the nearest listed frame. null outside root or on root itself.
export function pickTarget(nodes: Iterable<TreeNodeLike> | Map<number, TreeNodeLike>, id: number, rootId: number | null): string | null {
  const byId = lookup(nodes)
  const chain: TreeNodeLike[] = []
  let cur = byId.get(id)
  while (cur && cur.id !== rootId) {
    chain.push(cur)
    cur = cur.parent != null ? byId.get(cur.parent) : undefined
  }
  if (!cur || !chain.length) return null
  const pathOf = (n: TreeNodeLike) => chain.slice(chain.indexOf(n)).reverse().map((x) => x.name).join('.')
  const button = chain.find((n) => isButtonClass(n.cls))
  if (button) return pathOf(button)
  const frame = chain.find((n) => STORY_TARGET_CLASSES.has(n.cls) && !isForge(n))
  return frame ? pathOf(frame) : pathOf(chain[0])
}

// ---- export

export interface StoryAttach {
  // The target's path in the lab ("RacingHud.BOOSTButton") and its readable form.
  path: string
  label: string
  // A Luau local name for the snippet ("boostButton").
  variable: string
  // Key in Effects.stacks when this target's stack is not the module's default.
  stack?: string
}

export interface StoryExportPlan {
  // The default stack, rebased onto the element it is attached to (path "").
  spec: MotionSpec
  // Other distinct stacks (Effects.stacks.<key>), rebased the same way.
  stacks: Record<string, MotionSpec>
  attach: StoryAttach[]
}

// "BOOSTButton" -> "boostButton", "Play Button" -> "playButton", "UI" -> "ui".
export function luauLocal(name: string): string {
  const base = luauName(name, 'Button')
  const m = /^[A-Z]+(?=[A-Z][a-z]|\d|$)/.exec(base)
  const head = m ? m[0].toLowerCase() : base[0].toLowerCase()
  const out = head + base.slice(m ? m[0].length : 1)
  return /^(and|break|do|else|elseif|end|false|for|function|if|in|local|nil|not|or|repeat|return|then|true|until|while|continue|type|export)$/.test(out) ? `${out}Button` : out
}

const effectsKey = (effects: MotionEffect[]) => JSON.stringify([...effects].sort((a, b) => a.kind.localeCompare(b.kind)))

// Each target with effects becomes an attach root; the first distinct stack is the module default.
export function storyExportPlan(spec: MotionSpec): StoryExportPlan {
  const targets = spec.targets.filter((t) => t.effects.length)
  const groups = new Map<string, { effects: MotionEffect[]; key?: string }>()
  const attach: StoryAttach[] = []
  const stacks: Record<string, MotionSpec> = {}
  const vars = new Set<string>()
  let first: MotionEffect[] | null = null
  for (const t of targets) {
    const k = effectsKey(t.effects)
    let g = groups.get(k)
    const leaf = t.path.split('.').pop() || 'Root'
    if (!g) {
      g = { effects: t.effects }
      if (first) {
        let key = luauName(leaf, 'Stack')
        for (let i = 2; stacks[key]; i++) key = `${luauName(leaf, 'Stack')}${i}`
        g.key = key
        stacks[key] = normalizeSpec({ name: `${spec.name}${key}`, reducedMotion: spec.reducedMotion, targets: [{ path: '', effects: structuredClone(t.effects) }] })
      } else first = t.effects
      groups.set(k, g)
    }
    let variable = luauLocal(leaf)
    for (let i = 2; vars.has(variable); i++) variable = `${luauLocal(leaf)}${i}`
    vars.add(variable)
    attach.push({ path: t.path, label: namePath(t.path), variable, ...(g.key ? { stack: g.key } : {}) })
  }
  const main = normalizeSpec({ name: spec.name, reducedMotion: spec.reducedMotion, targets: [{ path: '', effects: structuredClone(first ?? []) }] })
  return { spec: main, stacks, attach }
}

// The lines to add to the user's component: one require, one attach per target.
export function storySnippet(o: { requirePath: string | null; module: string; attach: StoryAttach[] }): string {
  const base = o.module.split('/').pop()!.replace(/\.luau?$/, '')
  const lines = [o.requirePath ? `local Effects = require(${o.requirePath})` : `local Effects = require(script.Parent.Motion.${base}) -- adjust the path: Motion/ is not mapped in the project file`]
  const attach = o.attach.length ? o.attach : [{ path: '', label: 'button', variable: 'button' }]
  for (const a of attach) lines.push(`Effects.attach(${a.variable}${a.stack ? `, Effects.stacks.${a.stack}` : ''}) -- ${a.label}`)
  return lines.join('\n')
}
