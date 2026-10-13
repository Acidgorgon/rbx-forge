// Interchange for the UI preview: the rendered frame as Forge JSON (what the Figma plugin in
// figma-plugin/ imports and exports back) and as SVG, plus the diff Forge runs when a frame comes
// back from Figma (literal changes vs structural ones). Pure.

import { cornerRadius, guiChildren, isGuiObject, modifier, resolvePadding, TEXT_CLASSES, IMAGE_CLASSES, type Box, type LayoutResult } from './layout.ts'
import { bool, color, enumName, isTagged, num, str, udim, udim2, vec2, type PreviewTree, type UiNode, type UiValue } from './protocol.ts'
import { backgroundAlpha, gradientOf, hex, isVisible, shadeStops, strokeOf, textAlpha, type RGB } from './paint.ts'
import { cssFont, familyName } from './assets.ts'

export const FORGE_UI_FORMAT = 'forge-ui'
export const FORGE_UI_VERSION = 1

export interface FPaint {
  color: string // #RRGGBB
  opacity: number
}

export interface FGradient {
  // Roblox UIGradient.Rotation (degrees, clockwise, 0 = left to right).
  rotation: number
  stops: { t: number; color: string; opacity: number }[]
}

export interface FText {
  content: string
  rich: boolean
  // Roblox family name (GothamSSm, SourceSansPro, ...) and the CSS/Figma substitute.
  family: string
  substitute: string
  weight: number
  italic: boolean
  size: number
  lineHeight: number
  color: string
  opacity: number
  alignX: 'Left' | 'Center' | 'Right'
  alignY: 'Top' | 'Center' | 'Bottom'
  wrapped: boolean
  scaled: boolean
}

export interface FLayout {
  kind: 'list' | 'grid'
  direction: 'Horizontal' | 'Vertical'
  // Pixels between items (list) or [x, y] cell padding (grid).
  gap: number
  gapCross?: number
  alignX: 'Left' | 'Center' | 'Right'
  alignY: 'Top' | 'Center' | 'Bottom'
  wraps: boolean
  cell?: [number, number]
}

export interface FNode {
  id: number
  // Path below the story target ("RacingHud.Speedometer.Speed"); stored as Figma plugin data.
  path: string
  name: string
  cls: string
  // Absolute, unrotated pixels in the viewport.
  x: number
  y: number
  w: number
  h: number
  rotation: number
  visible: boolean
  clips: boolean
  fill: FPaint | null
  gradient: FGradient | null
  corner: number
  stroke: (FPaint & { thickness: number; target: 'border' | 'text' }) | null
  padding: { top: number; right: number; bottom: number; left: number } | null
  layout: FLayout | null
  text: FText | null
  image: { ref: string; url?: string; scaleType: string; opacity: number } | null
  // Roblox properties as streamed (for the round trip).
  props: Record<string, UiValue>
  children: FNode[]
}

export interface ForgeUiDoc {
  format: typeof FORGE_UI_FORMAT
  version: number
  story: string
  device?: string
  viewport: { w: number; h: number }
  exportedAt?: string
  root: FNode
}

const round = (n: number) => Math.round(n * 100) / 100

function paintOf(c: RGB, alpha: number): FPaint {
  return { color: hex(c), opacity: round(alpha) }
}

function gradientDoc(tree: PreviewTree, node: UiNode, base: RGB, alpha: number): FGradient | null {
  const g = gradientOf(tree, node)
  if (!g) return null
  return { rotation: g.rotation, stops: shadeStops(g, base, alpha).map((s) => ({ t: round(s.t), color: hex(s.color), opacity: round(s.alpha) })) }
}

export function forgeNode(tree: PreviewTree, layout: LayoutResult, node: UiNode, images: Record<string, { url?: string }> = {}): FNode | null {
  const box = layout.boxes.get(node.id)
  if (!box || !isGuiObject(node.cls)) return null
  const k = box.scale
  const corner = modifier(tree, node, 'UICorner')
  const base = color(node.props.BackgroundColor3, [0.64, 0.64, 0.64]) as RGB
  const bgA = backgroundAlpha(node)
  const stroke = strokeOf(tree, node, k)
  const pad = modifier(tree, node, 'UIPadding')
  const list = modifier(tree, node, 'UIListLayout')
  const grid = list ? undefined : modifier(tree, node, 'UIGridLayout')
  let fl: FLayout | null = null
  if (list) {
    const vertical = enumName(list.props.FillDirection, 'Vertical') === 'Vertical'
    const [s, o] = udim(list.props.Padding)
    fl = {
      kind: 'list',
      direction: vertical ? 'Vertical' : 'Horizontal',
      gap: round(s * (vertical ? box.h : box.w) + o * k),
      alignX: enumName(list.props.HorizontalAlignment, 'Left') as FLayout['alignX'],
      alignY: enumName(list.props.VerticalAlignment, 'Top') as FLayout['alignY'],
      wraps: bool(list.props.Wraps)
    }
  } else if (grid) {
    const cell = udim2(grid.props.CellSize ?? { t: 'UDim2', v: [0, 100, 0, 100] })
    const gap = udim2(grid.props.CellPadding ?? { t: 'UDim2', v: [0, 5, 0, 5] })
    fl = {
      kind: 'grid',
      direction: enumName(grid.props.FillDirection, 'Horizontal') === 'Vertical' ? 'Vertical' : 'Horizontal',
      gap: round(gap[0] * box.w + gap[1] * k),
      gapCross: round(gap[2] * box.h + gap[3] * k),
      alignX: enumName(grid.props.HorizontalAlignment, 'Left') as FLayout['alignX'],
      alignY: enumName(grid.props.VerticalAlignment, 'Top') as FLayout['alignY'],
      wraps: true,
      cell: [round(cell[0] * box.w + cell[1] * k), round(cell[2] * box.h + cell[3] * k)]
    }
  }
  let text: FText | null = null
  if (TEXT_CLASSES.has(node.cls)) {
    const fontValue = isTagged(node.props.FontFace, 'Font') ? node.props.FontFace : undefined
    const f = cssFont(fontValue)
    const tc = color(node.props.TextColor3, [0, 0, 0]) as RGB
    text = {
      content: str(node.props.Text),
      rich: bool(node.props.RichText),
      family: familyName(fontValue),
      substitute: f.family.split(',')[0].replace(/"/g, '').trim(),
      weight: f.weight,
      italic: f.style === 'italic',
      size: round(box.textSize ?? num(node.props.TextSize, 14) * k),
      lineHeight: num(node.props.LineHeight, 1),
      color: hex(tc),
      opacity: round(textAlpha(node)),
      alignX: enumName(node.props.TextXAlignment, 'Center') as FText['alignX'],
      alignY: enumName(node.props.TextYAlignment, 'Center') as FText['alignY'],
      wrapped: bool(node.props.TextWrapped),
      scaled: bool(node.props.TextScaled)
    }
  }
  let image: FNode['image'] = null
  if (IMAGE_CLASSES.has(node.cls) && str(node.props.Image)) {
    const ref = str(node.props.Image)
    image = { ref, ...(images[ref]?.url ? { url: images[ref].url } : {}), scaleType: enumName(node.props.ScaleType, 'Stretch'), opacity: round(1 - num(node.props.ImageTransparency)) }
  }
  const children: FNode[] = []
  for (const id of box.draw) {
    const c = tree.get(id)
    const fc = c ? forgeNode(tree, layout, c, images) : null
    if (fc) children.push(fc)
  }
  const p = pad ? resolvePadding(pad.props, box, k) : null
  return {
    id: node.id,
    path: tree.relativePath(node.id),
    name: node.name,
    cls: node.cls,
    x: round(box.x),
    y: round(box.y),
    w: round(box.w),
    h: round(box.h),
    rotation: box.rotation,
    visible: isVisible(node),
    clips: bool(node.props.ClipsDescendants) || node.cls === 'CanvasGroup' || node.cls === 'ScrollingFrame',
    fill: bgA > 0 ? paintOf(base, bgA) : null,
    gradient: bgA > 0 ? gradientDoc(tree, node, base, bgA) : text ? gradientDoc(tree, node, color(node.props.TextColor3, [0, 0, 0]) as RGB, textAlpha(node)) : null,
    corner: corner ? round(cornerRadius(corner.props, box, k)) : 0,
    stroke: stroke ? { ...paintOf(stroke.color, 1 - stroke.transparency), thickness: round(stroke.thickness), target: stroke.target } : null,
    padding: p ? { top: round(p.top), right: round(p.right), bottom: round(p.bottom), left: round(p.left) } : null,
    layout: fl,
    text,
    image,
    props: { ...node.props },
    children
  }
}

// The story frame (everything under the story target) as a Forge JSON document.
export function forgeDoc(tree: PreviewTree, layout: LayoutResult, o: { story: string; device?: string; viewport: { w: number; h: number }; images?: Record<string, { url?: string }>; now?: string }): ForgeUiDoc {
  const screen = tree.root != null ? tree.get(tree.root) : undefined
  const target = screen ? guiChildren(tree, screen).find((n) => n.name === 'StoryTarget') : undefined
  const kids = target ? (layout.boxes.get(target.id)?.draw ?? []).map((id) => tree.get(id)).filter((n): n is UiNode => !!n) : []
  const children = kids.map((n) => forgeNode(tree, layout, n, o.images)).filter((n): n is FNode => !!n)
  const name = o.story.split('/').pop()!.replace(/\.story\.luau?$/, '')
  return {
    format: FORGE_UI_FORMAT,
    version: FORGE_UI_VERSION,
    story: o.story,
    ...(o.device ? { device: o.device } : {}),
    viewport: o.viewport,
    ...(o.now ? { exportedAt: o.now } : {}),
    root: { id: target?.id ?? 0, path: '', name, cls: 'Frame', x: 0, y: 0, w: o.viewport.w, h: o.viewport.h, rotation: 0, visible: true, clips: true, fill: null, gradient: null, corner: 0, stroke: null, padding: null, layout: null, text: null, image: null, props: {}, children }
  }
}

export function parseForgeDoc(text: string): ForgeUiDoc {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new Error('Not JSON. Export the frame from the Forge Figma plugin (Export to Forge).')
  }
  const d = doc as Partial<ForgeUiDoc>
  if (!d || d.format !== FORGE_UI_FORMAT || typeof d.version !== 'number' || !d.root) throw new Error('Not a Forge UI document (format "forge-ui").')
  if (d.version > FORGE_UI_VERSION) throw new Error(`Forge UI document version ${d.version} is newer than this Forge (${FORGE_UI_VERSION}).`)
  return d as ForgeUiDoc
}

// ---- SVG

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function forgeSvg(doc: ForgeUiDoc, o: { background?: string } = {}): string {
  const defs: string[] = []
  let uid = 0
  const body: string[] = []
  const gradientDef = (g: FGradient, n: FNode): string => {
    const id = `g${++uid}`
    const rad = (g.rotation * Math.PI) / 180
    const [cx, cy] = [n.x + n.w / 2, n.y + n.h / 2]
    const half = (Math.abs(n.w * Math.cos(rad)) + Math.abs(n.h * Math.sin(rad))) / 2
    const [dx, dy] = [Math.cos(rad) * half, Math.sin(rad) * half]
    defs.push(
      `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${round(cx - dx)}" y1="${round(cy - dy)}" x2="${round(cx + dx)}" y2="${round(cy + dy)}">${g.stops
        .map((s) => `<stop offset="${round(Math.max(0, Math.min(1, s.t)))}" stop-color="${s.color}" stop-opacity="${s.opacity}"/>`)
        .join('')}</linearGradient>`
    )
    return `url(#${id})`
  }
  const visit = (n: FNode, out: string[]) => {
    if (!n.visible) return
    const own: string[] = []
    const rot = n.rotation ? ` transform="rotate(${n.rotation} ${round(n.x + n.w / 2)} ${round(n.y + n.h / 2)})"` : ''
    const rx = n.corner ? ` rx="${n.corner}"` : ''
    const rect = `x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}"${rx}`
    if (n.fill) {
      const fill = n.gradient ? gradientDef(n.gradient, n) : n.fill.color
      own.push(`<rect ${rect} fill="${fill}"${n.gradient ? '' : ` fill-opacity="${n.fill.opacity}"`}/>`)
    }
    if (n.stroke?.target === 'border') {
      const t = n.stroke.thickness
      own.push(`<rect x="${round(n.x - t / 2)}" y="${round(n.y - t / 2)}" width="${round(n.w + t)}" height="${round(n.h + t)}"${n.corner ? ` rx="${round(n.corner + t / 2)}"` : ''} fill="none" stroke="${n.stroke.color}" stroke-opacity="${n.stroke.opacity}" stroke-width="${t}"/>`)
    }
    if (n.image) {
      if (n.image.url && /^(data:|https?:)/.test(n.image.url)) own.push(`<image href="${esc(n.image.url)}" ${rect.replace(rx, '')} preserveAspectRatio="${n.image.scaleType === 'Fit' ? 'xMidYMid meet' : n.image.scaleType === 'Crop' ? 'xMidYMid slice' : 'none'}" opacity="${n.image.opacity}"/>`)
      else own.push(`<rect ${rect} fill="#808080" fill-opacity="0.25" stroke="#808080" stroke-dasharray="4 3"/><text x="${round(n.x + n.w / 2)}" y="${round(n.y + n.h / 2)}" font-family="monospace" font-size="9" fill="#808080" text-anchor="middle" dominant-baseline="middle">${esc(n.image.ref.replace(/^rbxassetid:\/\//, 'id '))}</text>`)
    }
    if (n.text && n.text.content) {
      const t = n.text
      const p = n.padding ?? { top: 0, right: 0, bottom: 0, left: 0 }
      const content = t.rich ? t.content.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '') : t.content
      const lines = content.split('\n')
      const lh = t.size * t.lineHeight
      const x = t.alignX === 'Left' ? n.x + p.left : t.alignX === 'Right' ? n.x + n.w - p.right : n.x + p.left + (n.w - p.left - p.right) / 2
      const innerH = n.h - p.top - p.bottom
      const blockH = lines.length * lh
      const top = t.alignY === 'Top' ? n.y + p.top : t.alignY === 'Bottom' ? n.y + n.h - p.bottom - blockH : n.y + p.top + (innerH - blockH) / 2
      const fill = n.gradient && !n.fill ? gradientDef(n.gradient, n) : t.color
      const strokeAttr = n.stroke?.target === 'text' ? ` stroke="${n.stroke.color}" stroke-opacity="${n.stroke.opacity}" stroke-width="${n.stroke.thickness * 2}" paint-order="stroke" stroke-linejoin="round"` : ''
      own.push(
        `<text font-family="${esc(t.substitute)}, sans-serif" font-size="${t.size}" font-weight="${t.weight}"${t.italic ? ' font-style="italic"' : ''} fill="${fill}"${n.gradient && !n.fill ? '' : ` fill-opacity="${t.opacity}"`} text-anchor="${t.alignX === 'Left' ? 'start' : t.alignX === 'Right' ? 'end' : 'middle'}"${strokeAttr}>${lines
          .map((l, i) => `<tspan x="${round(x)}" y="${round(top + i * lh + lh / 2)}" dominant-baseline="central">${esc(l)}</tspan>`)
          .join('')}</text>`
      )
    }
    const kids: string[] = []
    for (const c of n.children) visit(c, kids)
    let kidsSvg = kids.join('')
    if (n.clips && kids.length) {
      const id = `c${++uid}`
      defs.push(`<clipPath id="${id}"><rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}"${n.cls === 'CanvasGroup' ? rx : ''}/></clipPath>`)
      kidsSvg = `<g clip-path="url(#${id})">${kidsSvg}</g>`
    }
    out.push(`<g id="${esc(n.path || n.name)}" data-class="${n.cls}"${rot}>${own.join('')}${kidsSvg}</g>`)
  }
  for (const c of doc.root.children) visit(c, body)
  const { w, h } = doc.viewport
  const bg = o.background ? `<rect width="${w}" height="${h}" fill="${o.background}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><title>${esc(doc.root.name)}</title><defs>${defs.join('')}</defs>${bg}${body.join('')}</svg>\n`
}

// ---- Figma -> Forge diff

export interface PropChange {
  id: number
  path: string
  name: string
  cls: string
  prop: string
  from: UiValue | undefined
  to: UiValue
}

export interface DocDiff {
  literal: PropChange[]
  // Changes that need code edits beyond a literal (added/removed/reparented elements, layout).
  structural: string[]
}

const near = (a: number, b: number, eps = 0.5) => Math.abs(a - b) <= eps

function hexToRgb(h: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h.trim())
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : null
}

const sameHex = (a: string | undefined, b: string | undefined) => (a ?? '').toUpperCase() === (b ?? '').toUpperCase()

// Elements by path; repeated paths (same-named siblings) get ~2, ~3 in tree order.
function flatten(n: FNode, out = new Map<string, { node: FNode; parent: FNode | null }>()) {
  for (const c of n.children) {
    const base = c.path || c.name
    let key = base
    for (let i = 2; out.has(key); i++) key = `${base}~${i}`
    out.set(key, { node: c, parent: n })
    flatten(c, out)
  }
  return out
}

// What changed between the frame Forge exported (`before`) and the one Figma sent back (`after`).
export function diffDocs(before: ForgeUiDoc, after: ForgeUiDoc): DocDiff {
  const a = flatten(before.root)
  const b = flatten(after.root)
  const literal: PropChange[] = []
  const structural: string[] = []
  for (const [path, { node: o, parent: op }] of a) {
    const hit = b.get(path)
    if (!hit) {
      structural.push(`removed ${o.cls} ${path}`)
      continue
    }
    const n = hit.node
    const change = (prop: string, to: UiValue) => literal.push({ id: o.id, path, name: o.name, cls: o.cls, prop, from: o.props[prop], to })
    if (hit.parent && op && (hit.parent.path || '') !== (op.path || '')) structural.push(`moved ${path} under ${hit.parent.path || '(story root)'}`)
    if (n.visible !== o.visible) change('Visible', n.visible)
    if (!near(n.rotation, o.rotation, 0.05)) change('Rotation', Math.round(n.rotation * 100) / 100)
    // Geometry: keep the UDim2 scales and move the offsets by the pixel delta.
    const inLayout = !!op?.layout
    const dw = n.w - o.w
    const dh = n.h - o.h
    if (!near(dw, 0) || !near(dh, 0)) {
      const s = udim2(o.props.Size)
      change('Size', { t: 'UDim2', v: [s[0], Math.round(s[1] + dw), s[2], Math.round(s[3] + dh)] })
    }
    const anchor = vec2(o.props.AnchorPoint)
    const dx = n.x - o.x + anchor[0] * dw
    const dy = n.y - o.y + anchor[1] * dh
    if (!near(dx, 0) || !near(dy, 0)) {
      if (inLayout) structural.push(`${path} moved inside its ${op!.layout!.kind === 'grid' ? 'UIGridLayout' : 'UIListLayout'} (reorder with LayoutOrder or change the layout)`)
      else {
        const p = udim2(o.props.Position)
        change('Position', { t: 'UDim2', v: [p[0], Math.round(p[1] + dx), p[2], Math.round(p[3] + dy)] })
      }
    }
    if (n.fill && o.fill) {
      if (!sameHex(n.fill.color, o.fill.color) && !o.gradient) {
        const rgb = hexToRgb(n.fill.color)
        if (rgb) change('BackgroundColor3', { t: 'Color3', v: rgb })
      }
      if (!near(n.fill.opacity, o.fill.opacity, 0.01)) change('BackgroundTransparency', Math.round((1 - n.fill.opacity) * 100) / 100)
    } else if (!n.fill && o.fill) change('BackgroundTransparency', 1)
    else if (n.fill && !o.fill) {
      const rgb = hexToRgb(n.fill.color)
      if (rgb) change('BackgroundColor3', { t: 'Color3', v: rgb })
      change('BackgroundTransparency', Math.round((1 - n.fill.opacity) * 100) / 100)
    }
    if (n.text && o.text) {
      if (n.text.content !== o.text.content) change('Text', n.text.content)
      if (!sameHex(n.text.color, o.text.color) && !(o.gradient && !o.fill)) {
        const rgb = hexToRgb(n.text.color)
        if (rgb) change('TextColor3', { t: 'Color3', v: rgb })
      }
      if (!near(n.text.opacity, o.text.opacity, 0.01)) change('TextTransparency', Math.round((1 - n.text.opacity) * 100) / 100)
      if (!o.text.scaled && !near(n.text.size, o.text.size)) change('TextSize', Math.round(n.text.size))
      if (n.text.alignX !== o.text.alignX) change('TextXAlignment', { t: 'Enum', e: 'TextXAlignment', v: n.text.alignX })
      if (n.text.alignY !== o.text.alignY) change('TextYAlignment', { t: 'Enum', e: 'TextYAlignment', v: n.text.alignY })
      if (n.text.family !== o.text.family || n.text.weight !== o.text.weight || n.text.italic !== o.text.italic) structural.push(`${path} font changed to ${n.text.family} ${n.text.weight}${n.text.italic ? ' italic' : ''} (set FontFace)`)
    }
    if (!near(n.corner, o.corner)) structural.push(`${path} corner radius ${o.corner} -> ${n.corner} px (UICorner.CornerRadius)`)
    if (JSON.stringify(n.stroke) !== JSON.stringify(o.stroke)) structural.push(`${path} stroke ${o.stroke ? `${o.stroke.color} ${o.stroke.thickness}px` : 'none'} -> ${n.stroke ? `${n.stroke.color} ${n.stroke.thickness}px` : 'none'} (UIStroke)`)
    if (JSON.stringify(n.gradient) !== JSON.stringify(o.gradient)) structural.push(`${path} gradient changed (UIGradient): ${n.gradient ? n.gradient.stops.map((s) => `${s.color}@${s.t}`).join(' ') : 'removed'}`)
    if (JSON.stringify(n.padding) !== JSON.stringify(o.padding)) structural.push(`${path} padding ${JSON.stringify(o.padding)} -> ${JSON.stringify(n.padding)} (UIPadding)`)
    if (JSON.stringify(n.layout) !== JSON.stringify(o.layout)) structural.push(`${path} layout ${JSON.stringify(o.layout)} -> ${JSON.stringify(n.layout)}`)
  }
  for (const [path, { node, parent }] of b) if (!a.has(path)) structural.push(`added ${node.cls} "${node.name}" under ${parent?.path || '(story root)'} at ${Math.round(node.x)},${Math.round(node.y)} ${Math.round(node.w)}x${Math.round(node.h)}${node.text ? ` text "${node.text.content.slice(0, 60)}"` : ''}${node.fill ? ` fill ${node.fill.color}` : ''}`)
  return { literal, structural }
}

export function describeChange(c: PropChange, literal: (v: UiValue) => string | null): string {
  const from = c.from === undefined ? '(default)' : literal(c.from) ?? JSON.stringify(c.from)
  return `${c.path}.${c.prop}: ${from} -> ${literal(c.to) ?? JSON.stringify(c.to)}`
}

