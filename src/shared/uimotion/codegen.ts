// Luau for an imported UI: the component module (builds the instance tree with Instance.new, no UI
// library needed) and its UI Labs story (generic story: works in Forge's UI Preview and in UI Labs in
// Studio), optionally with the motion module attached. Pure.

import type { UiValue } from '../uiPreview/protocol.ts'
import type { MappingReport, UiInst } from './figma/map.ts'

const n = (x: number) => {
  const r = Math.round(x * 10000) / 10000
  return Object.is(r, -0) ? '0' : String(r)
}
const rgb = (v: [number, number, number]) => `Color3.fromRGB(${v.map((c) => Math.round(c * 255)).join(', ')})`

export function luauValue(v: UiValue): string {
  if (typeof v === 'number') return n(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'string') return JSON.stringify(v).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => `\\u{${h}}`)
  switch (v.t) {
    case 'UDim2': {
      const [xs, xo, ys, yo] = v.v
      if (xs === 0 && ys === 0) return `UDim2.fromOffset(${n(xo)}, ${n(yo)})`
      if (xo === 0 && yo === 0) return `UDim2.fromScale(${n(xs)}, ${n(ys)})`
      return `UDim2.new(${n(xs)}, ${n(xo)}, ${n(ys)}, ${n(yo)})`
    }
    case 'UDim':
      return `UDim.new(${n(v.v[0])}, ${n(v.v[1])})`
    case 'Vector2':
      return `Vector2.new(${n(v.v[0])}, ${n(v.v[1])})`
    case 'Vector3':
      return `Vector3.new(${v.v.map(n).join(', ')})`
    case 'Color3':
      return rgb(v.v)
    case 'Enum':
      return `Enum.${v.e}.${v.v}`
    case 'Font':
      return `Font.new(${JSON.stringify(v.family)}, Enum.FontWeight.${v.weight}, Enum.FontStyle.${v.style})`
    case 'ColorSequence':
      return `ColorSequence.new({ ${v.v.map((k) => `ColorSequenceKeypoint.new(${n(k[0])}, ${rgb([k[1], k[2], k[3]])})`).join(', ')} })`
    case 'NumberSequence':
      return `NumberSequence.new({ ${v.v.map((k) => `NumberSequenceKeypoint.new(${n(k[0])}, ${n(k[1])})`).join(', ')} })`
    case 'Rect':
      return `Rect.new(${v.v.map(n).join(', ')})`
    default:
      return 'nil'
  }
}

// Property order: identity, layout, look; the rest alphabetical.
const ORDER = ['Name', 'AnchorPoint', 'Position', 'Size', 'AutomaticSize', 'LayoutOrder', 'Rotation', 'ZIndex', 'BackgroundColor3', 'BackgroundTransparency', 'BorderSizePixel', 'ClipsDescendants', 'GroupTransparency', 'Image', 'ScaleType', 'ImageTransparency', 'Text', 'FontFace', 'TextSize', 'TextColor3', 'TextTransparency', 'TextXAlignment', 'TextYAlignment', 'TextWrapped']
const rank = (k: string) => {
  const i = ORDER.indexOf(k)
  return i < 0 ? ORDER.length : i
}

function propLines(inst: UiInst, indent: string, images: Map<string, string>): string[] {
  const keys = Object.keys(inst.props)
    .filter((k) => k !== 'Name')
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const out = [`${indent}Name = ${luauValue(inst.name)},`]
  for (const k of keys) {
    const v = inst.props[k]
    if (k === 'Image' && typeof v === 'string' && images.has(v)) out.push(`${indent}Image = IMAGES[${JSON.stringify(images.get(v))}],`)
    else out.push(`${indent}${k} = ${luauValue(v)},`)
  }
  return out
}

function instLuau(inst: UiInst, indent: string, images: Map<string, string>): string {
  const inner = indent + '\t'
  const props = propLines(inst, inner, images).join('\n')
  if (!inst.children.length) return `make(${JSON.stringify(inst.className)}, {\n${props}\n${indent}})`
  const kids = inst.children.map((c) => `${inner}${instLuau(c, inner, images)},`).join('\n')
  return `make(${JSON.stringify(inst.className)}, {\n${props}\n${indent}}, {\n${kids}\n${indent}})`
}

export interface ComponentSource {
  // "Figma file abc123, node 1:2" or "Figma plugin selection".
  from: string
  report: MappingReport
}

export function componentModule(root: UiInst, src: ComponentSource): string {
  const images = new Map<string, string>()
  for (const req of src.report.images) images.set(req.file, req.file.split('/').pop()!.replace(/\.png$/, ''))
  const lines = [
    '--!strict',
    `-- ${root.name}: imported from Figma by RBX Forge (${src.from}).`,
    `-- Mapping: ${src.report.summary}.`,
    ...src.report.notes.filter((x) => x.level !== 'info').slice(0, 12).map((x) => `--   ${x.level === 'dropped' ? 'dropped' : 'approx'} ${x.what} (${x.node}): ${x.detail}`),
    '-- Returns a function that builds a fresh copy: local ui = Component(parent?).',
    '-- Re-importing overwrites this file; keep hand edits in the code that uses it.',
    ''
  ]
  if (images.size) {
    lines.push(
      '-- Images are files in the project (Forge\'s UI Preview draws them). Upload each one (Art page or',
      '-- Asset Manager) and replace the path with its rbxassetid:// before shipping.',
      'local IMAGES = {',
      ...[...images.entries()].map(([file, key]) => `\t[${JSON.stringify(key)}] = ${JSON.stringify(file)},`),
      '}',
      ''
    )
  }
  lines.push(
    'local function make(className: string, props: { [string]: any }, children: { Instance }?): any',
    '\tlocal inst = Instance.new(className)',
    '\tfor key, value in props do',
    '\t\t(inst :: any)[key] = value',
    '\tend',
    '\tif children then',
    '\t\tfor _, child in children do',
    '\t\t\tchild.Parent = inst',
    '\t\tend',
    '\tend',
    '\treturn inst',
    'end',
    '',
    'return function(parent: Instance?): GuiObject',
    `\tlocal root = ${instLuau(root, '\t', images)}`,
    '\troot.Parent = parent',
    '\treturn root',
    'end',
    ''
  )
  return lines.join('\n')
}

// A require expression from one module to another: relative (script.Parent...) when both map into
// the same Rojo tree, else absolute through game:GetService.
export function requireBetween(fromInst: string[] | null, toInst: string[] | null, fallbackFiles?: { from: string; to: string }): string {
  if (fromInst && toInst) {
    let common = 0
    while (common < fromInst.length - 1 && common < toInst.length && fromInst[common] === toInst[common]) common++
    if (common >= 1) {
      const ups = fromInst.length - 1 - common
      const parts = ['script.Parent', ...Array(ups).fill('Parent'), ...toInst.slice(common).map((p) => (/^[A-Za-z_]\w*$/.test(p) ? p : `[${JSON.stringify(p)}]`))]
      return parts.reduce((acc, p, i) => (i === 0 ? p : p.startsWith('[') ? `${acc}${p}` : `${acc}.${p}`), '')
    }
    return absoluteRequire(toInst)
  }
  if (toInst) return absoluteRequire(toInst)
  // No project mapping: assume the folder layout matches the instance tree.
  if (fallbackFiles) {
    const a = fallbackFiles.from.split('/').slice(0, -1)
    const b = fallbackFiles.to.replace(/\.luau?$/, '').split('/')
    let c = 0
    while (c < a.length && c < b.length - 1 && a[c] === b[c]) c++
    return ['script.Parent', ...Array(a.length - c).fill('Parent'), ...b.slice(c)].join('.')
  }
  throw new Error('cannot resolve the require path')
}

export function absoluteRequire(inst: string[]): string {
  const [service, ...rest] = inst
  return `game:GetService(${JSON.stringify(service)})${rest.map((p) => (/^[A-Za-z_]\w*$/.test(p) ? `.${p}` : `[${JSON.stringify(p)}]`)).join('')}`
}

export function storyModule(o: { name: string; component: string; effects?: string | null }): string {
  const fx = !!o.effects
  return [
    `-- ${o.name}: UI Labs story written by RBX Forge (Figma import / UI Motion Lab).`,
    '-- A generic story: runs in Forge\'s UI Preview and in UI Labs in Studio.',
    `local Component = require(${o.component})`,
    ...(fx ? [`local Effects = require(${o.effects})`] : []),
    '',
    'return {',
    `\tcontrols = {${fx ? ' Motion = true ' : ''}},`,
    '\trender = function(props)',
    '\t\tlocal ui = Component()',
    '\t\tui.AnchorPoint = Vector2.new(0.5, 0.5)',
    '\t\tui.Position = UDim2.fromScale(0.5, 0.5)',
    '\t\tui.Parent = props.target',
    ...(fx
      ? [
          '\t\tlocal motion = if props.controls.Motion then Effects.attach(ui) else nil',
          '\t\tlocal unsubscribe = props.subscribe(function(values)',
          '\t\t\tif motion then',
          '\t\t\t\tmotion.destroy()',
          '\t\t\t\tmotion = nil',
          '\t\t\tend',
          '\t\t\tif values.Motion then',
          '\t\t\t\tmotion = Effects.attach(ui)',
          '\t\t\tend',
          '\t\tend)',
          '\t\treturn function()',
          '\t\t\tunsubscribe()',
          '\t\t\tif motion then',
          '\t\t\t\tmotion.destroy()',
          '\t\t\tend',
          '\t\t\tui:Destroy()',
          '\t\tend'
        ]
      : ['\t\treturn function()', '\t\t\tui:Destroy()', '\t\tend']),
    '\tend,',
    '}',
    ''
  ].join('\n')
}

export function storybookModule(name: string): string {
  return [`-- Storybook for the UI stories in this folder (UI Labs; written by RBX Forge).`, 'return {', `\tname = ${JSON.stringify(name)},`, '\tstoryRoots = { script.Parent },', '}', ''].join('\n')
}
