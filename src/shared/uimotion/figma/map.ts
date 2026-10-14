// Figma -> Roblox: any Figma frame / component / instance (REST node JSON or the plugin's snapshot of
// the same shape) becomes a Roblox GUI instance tree (uiSpec.ts writes it as a Luau component) plus a
// mapping report of what was exact, approximated or dropped. Pure; the plugin bundles this file too.
//
//   auto layout          UIListLayout (FillDirection, Padding, alignments, SpaceBetween flex, Wraps)
//                        + UIPadding; HUG -> AutomaticSize, FILL -> UIFlexItem / scale 1
//   corner radius        UICorner (per-corner radii: the largest, noted)
//   strokes              UIStroke (Border, or Contextual on text; gradient strokes get a UIGradient)
//   linear gradients     UIGradient (Color / Transparency sequences, Rotation) on a white background
//   text                 TextLabel with FontFace from fonts.ts, size, colour, alignment, auto size
//   images               ImageLabel; image fills and vectors / icons come in as PNG files
//   drop shadow          a wrapper with stacked offset rounded Frames under a "Body" (no blur in Roblox UI)
//   constraints          AnchorPoint + Position / Size scale vs offset
// Roblox references (creator docs): UIListLayout, UIFlexItem, UIPadding, UICorner, UIStroke,
// UIGradient, TextLabel.FontFace / Font, ImageLabel.ScaleType, GuiObject.AutomaticSize, CanvasGroup.

import type { UiValue } from '../../uiPreview/protocol.ts'
import { mapFont, type FontMatch } from './fonts.ts'
import type { FigmaColor, FigmaEffect, FigmaNode, FigmaPaint, FigmaRect } from './types.ts'

export interface UiInst {
  className: string
  name: string
  props: Record<string, UiValue>
  children: UiInst[]
  // The Figma node it came from.
  figmaId?: string
}

export interface ImageRequest {
  // "fill:<imageRef>" (an image fill) or "node:<id>" (a rendered vector / icon).
  key: string
  kind: 'fill' | 'render'
  ref: string
  // Project path the PNG is written to (also the ImageLabel.Image the preview draws).
  file: string
  node: string
}

export interface MappingNote {
  level: 'approx' | 'dropped' | 'info'
  // Short feature name ("drop shadow", "layer blur").
  what: string
  node: string
  detail: string
}

export interface MappingReport {
  name: string
  size: { w: number; h: number }
  counts: Record<string, number>
  notes: MappingNote[]
  fonts: FontMatch[]
  images: ImageRequest[]
  // "approximated: drop shadow, gradient angle · dropped: layer blur"
  summary: string
}

export interface MapOptions {
  // Component name (defaults to the node name).
  name?: string
  // Where image files go (project path), e.g. art/ui/PlayButton.
  imageDir?: string
  // auto: nodes named like buttons become TextButtons (and the root when nothing inside is one);
  // root: the root is a TextButton; none: Frames only.
  interactive?: 'auto' | 'root' | 'none'
}

const VECTOR_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'REGULAR_POLYGON', 'POLYGON'])
const CONTAINER_TYPES = new Set(['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION', 'RECTANGLE', 'ELLIPSE'])
const BUTTON_RE = /(^|[^a-z])(button|btn|cta)([^a-z]|$)|Button|Btn/i

const r2 = (x: number) => Math.round(x * 100) / 100
const r4 = (x: number) => Math.round(x * 10000) / 10000
const px = (x: number) => Math.round(x)
const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

const udim2 = (xs: number, xo: number, ys: number, yo: number): UiValue => ({ t: 'UDim2', v: [r4(xs), px(xo), r4(ys), px(yo)] })
const udim = (s: number, o: number): UiValue => ({ t: 'UDim', v: [r4(s), px(o)] })
const vec2 = (x: number, y: number): UiValue => ({ t: 'Vector2', v: [r4(x), r4(y)] })
const color3 = (c: FigmaColor | { r: number; g: number; b: number }): UiValue => ({ t: 'Color3', v: [r4(c.r), r4(c.g), r4(c.b)] })
const enumv = (e: string, v: string): UiValue => ({ t: 'Enum', e, v })

export function slug(name: string): string {
  return (
    String(name ?? '')
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'image'
  )
}

// Roblox instance names: dots would break motion paths ("Content.Icon"), so they become underscores.
export function instanceName(name: string): string {
  const n = String(name ?? '').replace(/[.\n\r\t]+/g, '_').trim().slice(0, 100)
  return n || 'Layer'
}

const visible = <T extends { visible?: boolean }>(xs: T[] | undefined): T[] => (xs ?? []).filter((x) => x.visible !== false)
const paintAlpha = (p: FigmaPaint) => (p.opacity ?? 1) * (p.color?.a ?? 1)

interface Ctx {
  report: MappingReport
  opts: Required<MapOptions>
  imageNames: Set<string>
  buttonUsed: boolean
}

function note(ctx: Ctx, level: MappingNote['level'], what: string, node: FigmaNode, detail: string) {
  if (ctx.report.notes.some((n) => n.what === what && n.node === node.name && n.detail === detail)) return
  ctx.report.notes.push({ level, what, node: node.name, detail })
}

function boxOf(n: FigmaNode): FigmaRect {
  const b = n.absoluteBoundingBox
  if (b) {
    // A rotated node's bounding box is axis aligned; prefer its own size, centred on the box.
    if (n.rotation && n.size) return { x: b.x + b.width / 2 - n.size.x / 2, y: b.y + b.height / 2 - n.size.y / 2, width: n.size.x, height: n.size.y }
    return b
  }
  return { x: 0, y: 0, width: n.size?.x ?? 100, height: n.size?.y ?? 100 }
}

// ---- gradients

export interface GradientProps {
  rotation: number
  color: UiValue
  transparency?: UiValue
  approx?: string
}

// A linear gradient paint as UIGradient props for a w x h element. Roblox spreads the sequence over
// the element's extent along Rotation (centre +- half the projected size); Figma stops sit on the
// handle line, so their positions are projected onto that axis.
export function gradientProps(p: FigmaPaint, w: number, h: number): GradientProps | null {
  const stops = p.gradientStops ?? []
  if (stops.length < 1) return null
  const hp = p.gradientHandlePositions ?? [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }]
  const [a, b] = hp
  const dx = (b.x - a.x) * w
  const dy = (b.y - a.y) * h
  const angle = Math.atan2(dy, dx)
  const rotation = Math.round((angle * 180) / Math.PI)
  const rad = (rotation * Math.PI) / 180
  const dir = { x: Math.cos(rad), y: Math.sin(rad) }
  const half = (Math.abs(w * dir.x) + Math.abs(h * dir.y)) / 2 || 1
  const start = { x: w / 2 - dir.x * half, y: h / 2 - dir.y * half }
  let approx: string | undefined
  const mapped = stops
    .map((s) => {
      const P = { x: a.x * w + s.position * dx, y: a.y * h + s.position * dy }
      const t = ((P.x - start.x) * dir.x + (P.y - start.y) * dir.y) / (2 * half)
      return { t, c: s.color, alpha: (p.opacity ?? 1) * (s.color.a ?? 1) }
    })
    .sort((x, y) => x.t - y.t)
  if (mapped.some((m) => m.t < -0.01 || m.t > 1.01)) approx = 'gradient handles extend past the element; stops clamped to its edges'
  // Clamp into 0..1, keep order, pin both ends (Roblox sequences need keypoints at 0 and 1).
  const pts = mapped.map((m) => ({ ...m, t: clamp01(m.t) }))
  if (pts[0].t > 0) pts.unshift({ ...pts[0], t: 0 })
  if (pts[pts.length - 1].t < 1) pts.push({ ...pts[pts.length - 1], t: 1 })
  // Distinct times (Roblox rejects equal times on non-end keypoints) and at most 20 keypoints.
  const out: typeof pts = []
  for (const q of pts) {
    if (out.length && q.t - out[out.length - 1].t < 0.0005) {
      if (q.t >= 1) out[out.length - 1] = q
      continue
    }
    out.push(q)
  }
  if (out.length > 20) {
    approx = 'more than 20 stops; reduced to 20'
    out.splice(19, out.length - 20)
  }
  if (out.length === 1) out.push({ ...out[0], t: 1 })
  out[0].t = 0
  out[out.length - 1].t = 1
  const color: UiValue = { t: 'ColorSequence', v: out.map((q) => [r4(q.t), r4(q.c.r), r4(q.c.g), r4(q.c.b)] as [number, number, number, number]) }
  const opaque = out.every((q) => q.alpha >= 0.999)
  return { rotation, color, ...(opaque ? {} : { transparency: { t: 'NumberSequence', v: out.map((q) => [r4(q.t), r4(1 - q.alpha)] as [number, number]) } }), ...(approx ? { approx } : {}) }
}

function gradientInst(g: GradientProps): UiInst {
  return { className: 'UIGradient', name: 'UIGradient', props: { Rotation: g.rotation, Color: g.color, ...(g.transparency ? { Transparency: g.transparency } : {}) }, children: [] }
}

// ---- paints on an element

interface Paints {
  color: FigmaPaint | null
  image: FigmaPaint | null
}

function paintsOf(ctx: Ctx, node: FigmaNode): Paints {
  const fills = visible(node.fills)
  const colors = fills.filter((p) => p.type === 'SOLID' || p.type.startsWith('GRADIENT_'))
  const images = fills.filter((p) => p.type === 'IMAGE')
  if (colors.length > 1) note(ctx, 'approx', 'stacked fills', node, `${colors.length} colour fills; used the top one`)
  if (images.length > 1) note(ctx, 'approx', 'stacked image fills', node, 'used the top image fill')
  for (const p of fills) if (p.blendMode && p.blendMode !== 'NORMAL' && p.blendMode !== 'PASS_THROUGH') note(ctx, 'dropped', 'blend mode', node, `${p.blendMode.toLowerCase()} fill drawn as normal`)
  for (const p of fills) if (p.type === 'VIDEO' || p.type === 'PATTERN' || p.type === 'EMOJI') note(ctx, 'dropped', `${p.type.toLowerCase()} fill`, node, 'not supported in Roblox UI')
  return { color: colors[colors.length - 1] ?? null, image: images[images.length - 1] ?? null }
}

// Background props (and a UIGradient child) for a colour paint.
function background(ctx: Ctx, node: FigmaNode, paint: FigmaPaint | null, w: number, h: number, opacity: number): { props: Record<string, UiValue>; extra: UiInst[] } {
  if (!paint) return { props: { BackgroundTransparency: 1 }, extra: [] }
  if (paint.type === 'SOLID' && paint.color) return { props: { BackgroundColor3: color3(paint.color), BackgroundTransparency: r4(1 - paintAlpha(paint) * opacity) }, extra: [] }
  if (paint.type !== 'GRADIENT_LINEAR') note(ctx, 'approx', `${paint.type.replace('GRADIENT_', '').toLowerCase()} gradient`, node, 'drawn as a linear UIGradient along the handle direction')
  const g = gradientProps(paint, w, h)
  if (!g) return { props: { BackgroundTransparency: 1 }, extra: [] }
  if (g.approx) note(ctx, 'approx', 'gradient', node, g.approx)
  // UIGradient multiplies BackgroundColor3, so the base is white.
  return { props: { BackgroundColor3: color3({ r: 1, g: 1, b: 1 }), BackgroundTransparency: r4(1 - (paint.opacity ?? 1) * opacity * (g.transparency ? 1 : 1)) }, extra: [gradientInst(g)] }
}

function cornerOf(ctx: Ctx, node: FigmaNode, w: number, h: number): UiInst | null {
  let r = 0
  if (node.type === 'ELLIPSE') return { className: 'UICorner', name: 'UICorner', props: { CornerRadius: udim(0.5, 0) }, children: [] }
  if (node.rectangleCornerRadii) {
    const rs = node.rectangleCornerRadii
    r = Math.max(...rs)
    if (rs.some((x) => Math.abs(x - r) > 0.5)) note(ctx, 'approx', 'per-corner radius', node, `radii ${rs.join('/')}: UICorner rounds every corner, used ${r2(r)}`)
  } else if (typeof node.cornerRadius === 'number') r = node.cornerRadius
  if (r <= 0) return null
  if (r >= Math.min(w, h) / 2 - 0.5) return { className: 'UICorner', name: 'UICorner', props: { CornerRadius: udim(0.5, 0) }, children: [] }
  return { className: 'UICorner', name: 'UICorner', props: { CornerRadius: udim(0, r) }, children: [] }
}

function strokeOf(ctx: Ctx, node: FigmaNode, text: boolean, w: number, h: number): UiInst | null {
  const strokes = visible(node.strokes)
  if (!strokes.length) return null
  const p = strokes[strokes.length - 1]
  let weight = node.strokeWeight ?? 1
  if (node.individualStrokeWeights) {
    const s = node.individualStrokeWeights
    const max = Math.max(s.top, s.right, s.bottom, s.left)
    if ([s.top, s.right, s.bottom, s.left].some((x) => x !== max)) note(ctx, 'approx', 'per-side stroke', node, `UIStroke has one thickness; used ${max}`)
    weight = max
  }
  if (weight <= 0) return null
  if (node.strokeDashes?.length) note(ctx, 'dropped', 'dashed stroke', node, 'UIStroke is solid')
  if (!text && node.strokeAlign && node.strokeAlign !== 'OUTSIDE') note(ctx, 'approx', `${node.strokeAlign.toLowerCase()} stroke`, node, 'UIStroke draws outside the border')
  const props: Record<string, UiValue> = { ApplyStrokeMode: enumv('ApplyStrokeMode', text ? 'Contextual' : 'Border'), Thickness: r2(weight), LineJoinMode: enumv('LineJoinMode', 'Round') }
  const children: UiInst[] = []
  if (p.type === 'SOLID' && p.color) {
    props.Color = color3(p.color)
    props.Transparency = r4(1 - paintAlpha(p))
  } else if (p.type.startsWith('GRADIENT_')) {
    const g = gradientProps(p, w, h)
    props.Color = color3({ r: 1, g: 1, b: 1 })
    if (g) children.push(gradientInst(g))
  } else {
    note(ctx, 'dropped', 'image stroke', node, 'UIStroke needs a colour')
    return null
  }
  return { className: 'UIStroke', name: 'UIStroke', props, children }
}

// ---- effects (drop shadow)

function shadowLayers(ctx: Ctx, node: FigmaNode, shadow: FigmaEffect, corner: UiInst | null, w: number, h: number): UiInst[] {
  const blur = Math.max(0, shadow.radius ?? 0)
  const spread = shadow.spread ?? 0
  const c = shadow.color ?? { r: 0, g: 0, b: 0, a: 0.25 }
  const off = shadow.offset ?? { x: 0, y: 0 }
  const layers = blur > 1 ? 3 : 1
  note(ctx, 'approx', 'drop shadow', node, blur > 1 ? `${layers} stacked rounded Frames, offset ${off.x},${off.y}, spread to ${r2(blur)}px (Roblox UI has no blur)` : `an offset rounded Frame at ${off.x},${off.y}`)
  const radius = corner && corner.props.CornerRadius && typeof corner.props.CornerRadius === 'object' && 'v' in corner.props.CornerRadius ? (corner.props.CornerRadius as { v: [number, number] }).v : [0, 0]
  const out: UiInst[] = []
  for (let k = layers; k >= 1; k--) {
    const grow = spread + (blur * k) / layers / 1.5
    const alpha = (c.a ?? 0.25) / layers / (k === 1 ? 0.8 : 1.15)
    out.push({
      className: 'Frame',
      name: layers > 1 ? `Shadow${k}` : 'Shadow',
      props: {
        AnchorPoint: vec2(0.5, 0.5),
        Position: udim2(0.5, off.x, 0.5, off.y),
        Size: udim2(1, grow * 2, 1, grow * 2),
        BackgroundColor3: color3(c),
        BackgroundTransparency: r4(1 - clamp01(alpha)),
        BorderSizePixel: 0,
        ZIndex: 0
      },
      children: radius[0] || radius[1] ? [{ className: 'UICorner', name: 'UICorner', props: { CornerRadius: radius[0] ? udim(radius[0], 0) : udim(0, radius[1] + grow) }, children: [] }] : []
    })
  }
  void w
  void h
  return out
}

// ---- layout

interface Placement {
  props: Record<string, UiValue>
  extra: UiInst[]
}

function constraintAxis(c: string | undefined, pos: number, size: number, parent: number): { anchor: number; scale: number; offset: number; sizeScale: number; sizeOffset: number } {
  switch (c) {
    case 'RIGHT':
    case 'BOTTOM':
    case 'MAX':
      return { anchor: 1, scale: 1, offset: -(parent - pos - size), sizeScale: 0, sizeOffset: size }
    case 'CENTER':
      return { anchor: 0.5, scale: 0.5, offset: pos + size / 2 - parent / 2, sizeScale: 0, sizeOffset: size }
    case 'LEFT_RIGHT':
    case 'TOP_BOTTOM':
    case 'STRETCH':
      return { anchor: 0, scale: 0, offset: pos, sizeScale: 1, sizeOffset: -(parent - size) }
    case 'SCALE':
      return parent > 0 ? { anchor: 0, scale: pos / parent, offset: 0, sizeScale: size / parent, sizeOffset: 0 } : { anchor: 0, scale: 0, offset: pos, sizeScale: 0, sizeOffset: size }
    default:
      return { anchor: 0, scale: 0, offset: pos, sizeScale: 0, sizeOffset: size }
  }
}

function freePlacement(node: FigmaNode, box: FigmaRect, parent: FigmaRect): Placement {
  const x = constraintAxis(node.constraints?.horizontal, box.x - parent.x, box.width, parent.width)
  const y = constraintAxis(node.constraints?.vertical, box.y - parent.y, box.height, parent.height)
  const props: Record<string, UiValue> = { Position: udim2(x.scale, x.offset, y.scale, y.offset), Size: udim2(x.sizeScale, x.sizeOffset, y.sizeScale, y.sizeOffset) }
  if (x.anchor || y.anchor) props.AnchorPoint = vec2(x.anchor, y.anchor)
  return { props, extra: [] }
}

function flowPlacement(node: FigmaNode, box: FigmaRect, parent: FigmaNode, order: number): Placement {
  const horizontal = parent.layoutMode === 'HORIZONTAL'
  const hSizing = node.layoutSizingHorizontal ?? (horizontal ? (node.layoutGrow ? 'FILL' : 'FIXED') : node.layoutAlign === 'STRETCH' ? 'FILL' : 'FIXED')
  const vSizing = node.layoutSizingVertical ?? (!horizontal ? (node.layoutGrow ? 'FILL' : 'FIXED') : node.layoutAlign === 'STRETCH' ? 'FILL' : 'FIXED')
  const extra: UiInst[] = []
  let xs = 0
  let xo = box.width
  let ys = 0
  let yo = box.height
  // FILL on the main axis grows into the free space (UIFlexItem); on the cross axis it spans the line.
  if (hSizing === 'FILL') {
    if (horizontal) extra.push({ className: 'UIFlexItem', name: 'UIFlexItem', props: { FlexMode: enumv('UIFlexMode', 'Fill') }, children: [] })
    else ((xs = 1), (xo = 0))
  }
  if (vSizing === 'FILL') {
    if (!horizontal) extra.push({ className: 'UIFlexItem', name: 'UIFlexItem', props: { FlexMode: enumv('UIFlexMode', 'Fill') }, children: [] })
    else ((ys = 1), (yo = 0))
  }
  const props: Record<string, UiValue> = { Size: udim2(xs, xo, ys, yo), LayoutOrder: order }
  const auto = hSizing === 'HUG' && vSizing === 'HUG' ? 'XY' : hSizing === 'HUG' ? 'X' : vSizing === 'HUG' ? 'Y' : null
  if (auto && node.type !== 'TEXT') props.AutomaticSize = enumv('AutomaticSize', auto)
  return { props, extra }
}

function listLayout(ctx: Ctx, node: FigmaNode): UiInst[] {
  const horizontal = node.layoutMode === 'HORIZONTAL'
  const main = node.primaryAxisAlignItems ?? 'MIN'
  const cross = node.counterAxisAlignItems ?? 'MIN'
  const al = (v: string, x: boolean) => (v === 'CENTER' || v === 'BASELINE' ? 'Center' : v === 'MAX' ? (x ? 'Right' : 'Bottom') : x ? 'Left' : 'Top')
  if (cross === 'BASELINE') note(ctx, 'approx', 'baseline alignment', node, 'centred (UIListLayout has no baseline alignment)')
  const props: Record<string, UiValue> = {
    FillDirection: enumv('FillDirection', horizontal ? 'Horizontal' : 'Vertical'),
    SortOrder: enumv('SortOrder', 'LayoutOrder'),
    Padding: udim(0, main === 'SPACE_BETWEEN' ? 0 : (node.itemSpacing ?? 0)),
    HorizontalAlignment: enumv('HorizontalAlignment', horizontal ? (main === 'SPACE_BETWEEN' ? 'Left' : al(main, true)) : al(cross, true)),
    VerticalAlignment: enumv('VerticalAlignment', horizontal ? al(cross, false) : main === 'SPACE_BETWEEN' ? 'Top' : al(main, false))
  }
  if (main === 'SPACE_BETWEEN') props[horizontal ? 'HorizontalFlex' : 'VerticalFlex'] = enumv('UIFlexAlignment', 'SpaceBetween')
  if (node.layoutWrap === 'WRAP') {
    props.Wraps = true
    if (node.counterAxisSpacing) note(ctx, 'approx', 'wrap gap', node, `row gap ${node.counterAxisSpacing}px: UIListLayout uses one Padding for both`)
  }
  if (node.itemReverseZIndex) note(ctx, 'dropped', 'reverse stacking', node, 'children stack in layout order')
  const out: UiInst[] = [{ className: 'UIListLayout', name: 'UIListLayout', props, children: [] }]
  const pad = [node.paddingTop ?? 0, node.paddingRight ?? 0, node.paddingBottom ?? 0, node.paddingLeft ?? 0]
  if (pad.some((p) => p > 0)) out.push({ className: 'UIPadding', name: 'UIPadding', props: { PaddingTop: udim(0, pad[0]), PaddingRight: udim(0, pad[1]), PaddingBottom: udim(0, pad[2]), PaddingLeft: udim(0, pad[3]) }, children: [] })
  return out
}

// ---- nodes

function iconLike(node: FigmaNode): boolean {
  if (VECTOR_TYPES.has(node.type)) return true
  if (!node.children?.length || node.type === 'TEXT') return false
  const b = node.absoluteBoundingBox
  if (b && (b.width > 160 || b.height > 160)) return false
  let vectors = 0
  const walk = (n: FigmaNode): boolean => {
    if (n.visible === false) return true
    if (n.type === 'TEXT') return false
    if (visible(n.fills).some((p) => p.type === 'IMAGE')) return false
    if (VECTOR_TYPES.has(n.type)) {
      vectors++
      return true
    }
    if (n.type === 'ELLIPSE' || n.type === 'RECTANGLE') return true
    return (n.children ?? []).every(walk)
  }
  return (node.children ?? []).every(walk) && vectors > 0
}

function imageRequest(ctx: Ctx, kind: 'fill' | 'render', ref: string, node: FigmaNode): ImageRequest {
  const key = `${kind === 'fill' ? 'fill' : 'node'}:${ref}`
  const existing = ctx.report.images.find((i) => i.key === key)
  if (existing) return existing
  let base = slug(node.name)
  for (let i = 2; ctx.imageNames.has(base); i++) base = `${slug(node.name)}-${i}`
  ctx.imageNames.add(base)
  const req: ImageRequest = { key, kind, ref, file: `${ctx.opts.imageDir}/${base}.png`, node: node.name }
  ctx.report.images.push(req)
  return req
}

const SCALE_TYPE: Record<string, string> = { FILL: 'Crop', FIT: 'Fit', TILE: 'Tile', STRETCH: 'Stretch', CROP: 'Crop' }

function textProps(ctx: Ctx, node: FigmaNode, opacity: number, w: number, h: number): { props: Record<string, UiValue>; extra: UiInst[] } {
  const st = node.style ?? {}
  const font = mapFont(st.fontFamily, st.fontWeight, st.italic, st.fontPostScriptName)
  if (!ctx.report.fonts.some((f) => f.figma === font.figma && f.weight === font.weight && f.style === font.style)) ctx.report.fonts.push(font)
  if (!font.exact) note(ctx, 'approx', 'font', node, `${font.figma} -> ${font.family} ${font.weight}${font.reason ? ` (${font.reason})` : ''}`)
  let text = node.characters ?? ''
  switch (st.textCase) {
    case 'UPPER':
      text = text.toUpperCase()
      break
    case 'LOWER':
      text = text.toLowerCase()
      break
    case 'TITLE':
      text = text.replace(/\b\w/g, (c) => c.toUpperCase())
      break
    case 'SMALL_CAPS':
    case 'SMALL_CAPS_FORCED':
      text = text.toUpperCase()
      note(ctx, 'approx', 'small caps', node, 'written in capitals')
      break
  }
  if (node.characterStyleOverrides?.some((x) => x !== 0)) note(ctx, 'approx', 'mixed text styles', node, 'one style for the whole label (use RichText for runs)')
  if (st.letterSpacing && Math.abs(st.letterSpacing) > 0.05) note(ctx, 'dropped', 'letter spacing', node, `${r2(st.letterSpacing)}px tracking (TextLabel has none)`)
  if (st.textDecoration && st.textDecoration !== 'NONE') note(ctx, 'dropped', st.textDecoration.toLowerCase(), node, 'not a TextLabel property (RichText <u>/<s> can do it)')
  const size = st.fontSize ?? 14
  const props: Record<string, UiValue> = {
    Text: text,
    FontFace: { t: 'Font', family: font.asset, weight: font.weight, style: font.style },
    TextSize: px(size),
    TextXAlignment: enumv('TextXAlignment', st.textAlignHorizontal === 'CENTER' ? 'Center' : st.textAlignHorizontal === 'RIGHT' ? 'Right' : 'Left'),
    TextYAlignment: enumv('TextYAlignment', st.textAlignVertical === 'CENTER' ? 'Center' : st.textAlignVertical === 'BOTTOM' ? 'Bottom' : 'Top'),
    TextWrapped: st.textAutoResize !== 'WIDTH_AND_HEIGHT',
    BackgroundTransparency: 1
  }
  if (Math.abs(size - Math.round(size)) > 0.01) note(ctx, 'approx', 'text size', node, `${size}px rounded to ${px(size)}`)
  if (st.textAlignHorizontal === 'JUSTIFIED') note(ctx, 'approx', 'justified text', node, 'left aligned')
  if (st.textAutoResize === 'WIDTH_AND_HEIGHT') props.AutomaticSize = enumv('AutomaticSize', 'XY')
  else if (st.textAutoResize === 'HEIGHT') props.AutomaticSize = enumv('AutomaticSize', 'Y')
  else if (st.textAutoResize === 'TRUNCATE') props.TextTruncate = enumv('TextTruncate', 'AtEnd')
  if (st.lineHeightUnit && st.lineHeightUnit !== 'INTRINSIC_%' && st.lineHeightPx) {
    const lh = st.lineHeightPx / (size * 1.2)
    if (Math.abs(lh - 1) > 0.04) {
      props.LineHeight = r2(Math.max(1, Math.min(3, lh)))
      if (lh < 1) note(ctx, 'approx', 'tight line height', node, `${r2(st.lineHeightPx)}px is below Roblox's minimum LineHeight of 1`)
    }
  }
  const extra: UiInst[] = []
  const fills = visible(node.fills)
  const p = fills[fills.length - 1]
  if (p?.type === 'SOLID' && p.color) {
    props.TextColor3 = color3(p.color)
    props.TextTransparency = r4(1 - paintAlpha(p) * opacity)
  } else if (p?.type.startsWith('GRADIENT_')) {
    const g = gradientProps(p, w, h)
    props.TextColor3 = color3({ r: 1, g: 1, b: 1 })
    props.TextTransparency = r4(1 - opacity)
    if (g) extra.push(gradientInst(g))
  } else props.TextColor3 = color3({ r: 0, g: 0, b: 0 })
  return { props, extra }
}

function mapChild(ctx: Ctx, node: FigmaNode, parent: FigmaNode | null, parentBox: FigmaRect | null, order: number, inheritedButton: boolean): UiInst | null {
  if (node.visible === false) {
    note(ctx, 'info', 'hidden layer', node, 'skipped')
    return null
  }
  if (node.isMask) {
    note(ctx, 'approx', 'mask', node, 'masks are not supported; the parent clips instead (ClipsDescendants)')
    return null
  }
  const box = boxOf(node)
  const w = box.width
  const h = box.height
  const opacity = node.opacity ?? 1
  const name = instanceName(node.name)
  const flow = !!parent && (parent.layoutMode === 'HORIZONTAL' || parent.layoutMode === 'VERTICAL') && node.layoutPositioning !== 'ABSOLUTE'
  const placement: Placement = !parent || !parentBox ? { props: { AnchorPoint: vec2(0.5, 0.5), Position: udim2(0.5, 0, 0.5, 0), Size: udim2(0, w, 0, h) }, extra: [] } : flow ? flowPlacement(node, box, parent, order) : freePlacement(node, box, parentBox)
  if (node.rotation && Math.abs(node.rotation) > 0.05) {
    placement.props.Rotation = r2(-node.rotation)
    if (!node.size) note(ctx, 'approx', 'rotation', node, 'size taken from the rotated bounding box')
  }
  if (node.blendMode && !['NORMAL', 'PASS_THROUGH'].includes(node.blendMode)) note(ctx, 'dropped', 'blend mode', node, `${node.blendMode.toLowerCase()} drawn as normal`)
  for (const e of visible(node.effects)) {
    if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') note(ctx, 'dropped', e.type === 'LAYER_BLUR' ? 'layer blur' : 'background blur', node, 'Roblox UI has no blur')
    else if (e.type === 'INNER_SHADOW') note(ctx, 'dropped', 'inner shadow', node, 'no inner shadows in Roblox UI')
    else if (e.type === 'TEXTURE' || e.type === 'NOISE') note(ctx, 'dropped', e.type.toLowerCase(), node, 'not supported')
  }
  const shadows = visible(node.effects).filter((e) => e.type === 'DROP_SHADOW')
  if (shadows.length > 1) note(ctx, 'approx', 'multiple shadows', node, 'used the first drop shadow')

  // Interactive: the outermost node named like a button (or the root, see opts).
  let button = false
  if (!inheritedButton && ctx.opts.interactive !== 'none' && node.type !== 'TEXT') {
    if (ctx.opts.interactive === 'root' ? !parent : BUTTON_RE.test(node.name)) button = true
  }
  const insideButton = inheritedButton || button
  if (button) ctx.buttonUsed = true

  let inst: UiInst
  if (node.type === 'TEXT') {
    const t = textProps(ctx, node, opacity, w, h)
    inst = { className: 'TextLabel', name, props: { ...t.props }, children: [...t.extra], figmaId: node.id }
    const st = strokeOf(ctx, node, true, w, h)
    if (st) inst.children.push(st)
  } else if (iconLike(node) && !button) {
    const req = imageRequest(ctx, 'render', node.id, node)
    if (!VECTOR_TYPES.has(node.type)) note(ctx, 'info', 'icon', node, `vector group rendered to ${req.file}`)
    else note(ctx, 'approx', 'vector', node, `rendered to ${req.file} (Roblox UI draws images, not paths)`)
    inst = { className: 'ImageLabel', name, props: { BackgroundTransparency: 1, Image: req.file, ScaleType: enumv('ScaleType', 'Fit'), ...(opacity < 1 ? { ImageTransparency: r4(1 - opacity) } : {}) }, children: [], figmaId: node.id }
  } else {
    if (!CONTAINER_TYPES.has(node.type)) note(ctx, 'info', node.type.toLowerCase(), node, 'mapped as a Frame')
    const paints = paintsOf(ctx, node)
    const kids = (node.children ?? []).filter((c) => c.visible !== false)
    const group = opacity < 0.99 && kids.length > 0 && !button
    const ownOpacity = group ? 1 : opacity
    const bg = background(ctx, node, paints.color, w, h, ownOpacity)
    const corner = cornerOf(ctx, node, w, h)
    const imageOnly = paints.image && !kids.length && !button
    const className = button ? (imageOnly ? 'ImageButton' : 'TextButton') : imageOnly ? 'ImageLabel' : group ? 'CanvasGroup' : 'Frame'
    const props: Record<string, UiValue> = { ...bg.props, BorderSizePixel: 0 }
    if (className === 'TextButton') Object.assign(props, { Text: '', AutoButtonColor: false })
    if (group) {
      props.GroupTransparency = r4(1 - opacity)
      note(ctx, 'info', 'layer opacity', node, 'CanvasGroup (renders the group to a texture; costs memory)')
    } else if (opacity < 0.99 && kids.length) note(ctx, 'approx', 'layer opacity', node, 'applied to the element only, not its children')
    if (node.clipsContent && kids.length && !group) props.ClipsDescendants = true
    const children: UiInst[] = [...bg.extra]
    if (corner) children.push(corner)
    const stroke = strokeOf(ctx, node, false, w, h)
    if (stroke) children.push(stroke)
    if (paints.image) {
      const req = imageRequest(ctx, 'fill', paints.image.imageRef ?? node.id, node)
      const scaleType = SCALE_TYPE[paints.image.scaleMode ?? 'FILL'] ?? 'Crop'
      if (paints.image.scaleMode === 'STRETCH' || paints.image.scaleMode === 'CROP') note(ctx, 'approx', 'image crop', node, 'custom image transform drawn as Crop')
      const imageProps: Record<string, UiValue> = { Image: req.file, ScaleType: enumv('ScaleType', scaleType), ImageTransparency: r4(1 - (paints.image.opacity ?? 1) * ownOpacity) }
      if (imageOnly) Object.assign(props, imageProps)
      else children.push({ className: 'ImageLabel', name: 'Image', props: { ...imageProps, Size: udim2(1, 0, 1, 0), BackgroundTransparency: 1, BorderSizePixel: 0, ZIndex: 0 }, children: corner ? [{ ...corner, children: [] }] : [] })
    }
    const layout = node.layoutMode === 'HORIZONTAL' || node.layoutMode === 'VERTICAL'
    if (node.layoutMode === 'GRID') note(ctx, 'approx', 'grid auto layout', node, 'children placed where they are (no UIGridLayout mapping)')
    const flowKids = layout ? kids.filter((c) => c.layoutPositioning !== 'ABSOLUTE') : []
    const freeKids = layout ? kids.filter((c) => c.layoutPositioning === 'ABSOLUTE') : kids
    if (layout && flowKids.length) {
      const own = node.layoutSizingHorizontal === 'HUG' || node.layoutSizingVertical === 'HUG' || node.primaryAxisSizingMode === 'AUTO'
      if (own && !parent) {
        // The root keeps its designed size; HUG roots grow with content.
        const hug = (node.layoutSizingHorizontal ?? (node.layoutMode === 'HORIZONTAL' && node.primaryAxisSizingMode === 'AUTO' ? 'HUG' : 'FIXED')) === 'HUG'
        const vhug = (node.layoutSizingVertical ?? (node.layoutMode === 'VERTICAL' && node.primaryAxisSizingMode === 'AUTO' ? 'HUG' : 'FIXED')) === 'HUG'
        if (hug || vhug) placement.props.AutomaticSize = enumv('AutomaticSize', hug && vhug ? 'XY' : hug ? 'X' : 'Y')
      }
      const flow = flowKids.map((c, i) => mapChild(ctx, c, node, box, i + 1, insideButton)).filter((x): x is UiInst => !!x)
      if (freeKids.length) {
        // UIListLayout places every GuiObject sibling: the flow goes into its own frame so the
        // absolute children keep their positions.
        note(ctx, 'approx', 'absolute child in auto layout', node, 'flow children moved into a "Flow" frame')
        children.push({ className: 'Frame', name: 'Flow', props: { Size: udim2(1, 0, 1, 0), BackgroundTransparency: 1, BorderSizePixel: 0 }, children: [...listLayout(ctx, node), ...flow] })
      } else children.push(...listLayout(ctx, node), ...flow)
    }
    for (const c of freeKids) {
      const m = mapChild(ctx, c, { ...node, layoutMode: 'NONE' }, box, 0, insideButton)
      if (m) children.push(m)
    }
    inst = { className, name, props, children, figmaId: node.id }
    // A drop shadow needs to sit behind the element: wrap it (the wrapper takes the placement and
    // the name; the element becomes "Body", the shadow frames go first).
    if (shadows.length) {
      const layers = shadowLayers(ctx, node, shadows[0], corner, w, h)
      const wrapper: UiInst = {
        className: button ? 'TextButton' : 'Frame',
        name,
        props: { BackgroundTransparency: 1, BorderSizePixel: 0, ...(button ? { Text: '', AutoButtonColor: false } : {}), ...placement.props },
        children: [...(corner ? [{ ...corner, children: [] }] : []), ...placement.extra, ...layers],
        figmaId: node.id
      }
      if (button) {
        inst.className = className === 'TextButton' ? 'Frame' : className === 'ImageButton' ? 'ImageLabel' : className
        delete inst.props.Text
        delete inst.props.AutoButtonColor
      }
      inst.name = 'Body'
      inst.props.Size = udim2(1, 0, 1, 0)
      inst.props.ZIndex = 1
      delete inst.figmaId
      wrapper.children.push(inst)
      ctx.report.counts[inst.className] = (ctx.report.counts[inst.className] ?? 0) + 1
      ctx.report.counts[wrapper.className] = (ctx.report.counts[wrapper.className] ?? 0) + 1
      return wrapper
    }
  }
  Object.assign(inst.props, placement.props)
  inst.children.unshift(...placement.extra)
  ctx.report.counts[inst.className] = (ctx.report.counts[inst.className] ?? 0) + 1
  return inst
}

// Roblox finds children by name: same-named siblings get " 2", " 3" (Figma allows duplicates).
function dedupe(inst: UiInst): void {
  const seen = new Map<string, number>()
  for (const c of inst.children) {
    const n = seen.get(c.name) ?? 0
    seen.set(c.name, n + 1)
    if (n && !/^UI[A-Z]/.test(c.className)) c.name = `${c.name} ${n + 1}`
    dedupe(c)
  }
}

export function summarize(notes: MappingNote[]): string {
  const approx = [...new Set(notes.filter((n) => n.level === 'approx').map((n) => n.what))]
  const dropped = [...new Set(notes.filter((n) => n.level === 'dropped').map((n) => n.what))]
  const parts: string[] = []
  if (approx.length) parts.push(`approximated: ${approx.join(', ')}`)
  if (dropped.length) parts.push(`dropped: ${dropped.join(', ')}`)
  return parts.join(' · ') || 'everything mapped exactly'
}

export function mapFigmaNode(root: FigmaNode, opts: MapOptions = {}): { root: UiInst; report: MappingReport } {
  const name = opts.name ?? root.name
  const report: MappingReport = { name, size: { w: boxOf(root).width, h: boxOf(root).height }, counts: {}, notes: [], fonts: [], images: [], summary: '' }
  const ctx: Ctx = { report, opts: { name, imageDir: opts.imageDir ?? `art/ui/${slug(name)}`, interactive: opts.interactive ?? 'auto' }, imageNames: new Set(), buttonUsed: false }
  let mapped = mapChild(ctx, { ...root, visible: true, isMask: false }, null, null, 0, false)
  // auto: when nothing was named like a button, a root called like one (or a component) is clickable.
  if (mapped && ctx.opts.interactive === 'auto' && !ctx.buttonUsed && (root.type === 'COMPONENT' || root.type === 'INSTANCE' || root.type === 'COMPONENT_SET')) {
    report.notes = []
    report.counts = {}
    report.fonts = []
    report.images = []
    ctx.imageNames.clear()
    ctx.opts.interactive = 'root'
    mapped = mapChild(ctx, { ...root, visible: true, isMask: false }, null, null, 0, false)
    report.notes.unshift({ level: 'info', what: 'button', node: root.name, detail: 'the component root is a TextButton' })
  }
  if (!mapped) throw new Error('nothing to import')
  mapped.name = instanceName(name)
  dedupe(mapped)
  report.summary = summarize(report.notes)
  return { root: mapped, report }
}

// Every instance (depth first), e.g. for counts and tests.
export function walkInst(inst: UiInst, fn: (i: UiInst, path: string) => void, path = ''): void {
  fn(inst, path)
  for (const c of inst.children) walkInst(c, fn, path ? `${path}.${c.name}` : c.name)
}
