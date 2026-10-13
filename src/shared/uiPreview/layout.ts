// Roblox GUI layout as pure functions: UDim2 size/position against the parent's content box,
// AnchorPoint, UIPadding, UIScale, UISizeConstraint, UIAspectRatioConstraint, AutomaticSize,
// UIListLayout (alignment, padding, sort order, flex fill/space modes, wrapping, UIFlexItem),
// UIGridLayout, ScrollingFrame canvases and TextScaled fitting.
//
// Fidelity notes (also shown in the app): text metrics come from the injected measure function
// (the browser's font engine with substitute fonts in the app, an approximation in tests), so
// TextScaled sizes and AutomaticSize around text can differ by a few pixels from Roblox.

import {
  bool,
  enumName,
  num,
  str,
  udim,
  udim2,
  vec2,
  isTagged,
  type FontValue,
  type PreviewTree,
  type UiNode,
  type UiProps
} from './protocol.ts'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface TextMetrics {
  w: number
  h: number
}

// Measures text at a pixel size; wrapWidth null = one line per explicit newline.
export type MeasureText = (text: string, font: FontValue | undefined, size: number, wrapWidth: number | null) => TextMetrics

export interface Box extends Rect {
  id: number
  // Own rotation in degrees (around the box centre, like Roblox).
  rotation: number
  // Cumulative UIScale of this box (multiplies offsets, strokes, corner radii, text).
  scale: number
  // Pixel text size after TextScaled / UITextSizeConstraint / UIScale.
  textSize?: number
  // Children to draw, in draw order (ZIndex, then child order).
  draw: number[]
  // ScrollingFrame: canvas size and position.
  canvas?: { w: number; h: number; x: number; y: number }
}

export interface LayoutResult {
  boxes: Map<number, Box>
  // Rendering root (the ScreenGui) id.
  root: number | null
}

export const GUI_OBJECTS = new Set([
  'Frame',
  'TextLabel',
  'TextButton',
  'TextBox',
  'ImageLabel',
  'ImageButton',
  'ScrollingFrame',
  'CanvasGroup',
  'ViewportFrame',
  'VideoFrame'
])
export const LAYER_COLLECTORS = new Set(['ScreenGui', 'SurfaceGui', 'BillboardGui'])
export const TEXT_CLASSES = new Set(['TextLabel', 'TextButton', 'TextBox'])
export const IMAGE_CLASSES = new Set(['ImageLabel', 'ImageButton'])

export const isGuiObject = (cls: string) => GUI_OBJECTS.has(cls)
export const isModifier = (cls: string) => cls.startsWith('UI')

// Children that render as this node's children: GuiObjects, looking through Folders and other
// non-GUI containers (Roblox renders a GuiObject in a Folder as if parented to the Folder's parent).
export function guiChildren(tree: PreviewTree, node: UiNode): UiNode[] {
  const out: UiNode[] = []
  const visit = (n: UiNode) => {
    for (const id of n.children) {
      const c = tree.get(id)
      if (!c) continue
      if (isGuiObject(c.cls)) out.push(c)
      else if (!isModifier(c.cls) && !LAYER_COLLECTORS.has(c.cls)) visit(c)
    }
  }
  visit(node)
  return out
}

export function modifier(tree: PreviewTree, node: UiNode, cls: string): UiNode | undefined {
  for (const id of node.children) {
    const c = tree.get(id)
    if (c && c.cls === cls && bool(c.props.Enabled, true)) return c
  }
  return undefined
}

const visible = (n: UiNode) => bool(n.props.Visible, true)

// ---- pure building blocks (golden-tested)

// UDim2 against a parent box: [scaleX * w + offsetX * k, scaleY * h + offsetY * k].
export function resolveUDim2(v: [number, number, number, number], parent: { w: number; h: number }, k = 1): [number, number] {
  return [v[0] * parent.w + v[1] * k, v[2] * parent.h + v[3] * k]
}

// Top-left of a box of `size` placed at `position` with `anchor` inside `parent`.
export function placeBox(position: [number, number, number, number], anchor: [number, number], size: [number, number], parent: Rect, k = 1): [number, number] {
  const [px, py] = resolveUDim2(position, parent, k)
  return [parent.x + px - anchor[0] * size[0], parent.y + py - anchor[1] * size[1]]
}

export interface Padding {
  left: number
  right: number
  top: number
  bottom: number
}

// UIPadding: scale is relative to the padded box's own size.
export function resolvePadding(props: UiProps | undefined, size: { w: number; h: number }, k = 1): Padding {
  if (!props) return { left: 0, right: 0, top: 0, bottom: 0 }
  const side = (key: string, axis: number) => {
    const [s, o] = udim(props[key])
    return s * axis + o * k
  }
  return { left: side('PaddingLeft', size.w), right: side('PaddingRight', size.w), top: side('PaddingTop', size.h), bottom: side('PaddingBottom', size.h) }
}

export function inset(r: Rect, p: Padding): Rect {
  return { x: r.x + p.left, y: r.y + p.top, w: Math.max(0, r.w - p.left - p.right), h: Math.max(0, r.h - p.top - p.bottom) }
}

// UIAspectRatioConstraint. FitWithinMaxSize keeps the box inside its size; ScaleWithParentSize
// follows the dominant axis.
export function applyAspect(size: [number, number], ratio: number, aspectType: string, dominantAxis: string): [number, number] {
  if (!(ratio > 0)) return size
  const [w, h] = size
  if (aspectType === 'ScaleWithParentSize') {
    return dominantAxis === 'Height' ? [h * ratio, h] : [w, w / ratio]
  }
  if (w / Math.max(h, 1e-9) > ratio) return [h * ratio, h]
  return [w, w / ratio]
}

export function clampSize(size: [number, number], min: [number, number], max: [number, number]): [number, number] {
  const c = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
  return [c(size[0], min[0], max[0]), c(size[1], min[1], max[1])]
}

export interface ListItem {
  id: number
  size: [number, number]
  layoutOrder: number
  name: string
  index: number
  // UIFlexItem: grow weight (0 = fixed), shrink weight.
  grow?: number
  shrink?: number
}

export interface ListOptions {
  direction: 'Vertical' | 'Horizontal'
  padding: number
  horizontalAlignment: 'Left' | 'Center' | 'Right'
  verticalAlignment: 'Top' | 'Center' | 'Bottom'
  sortOrder: 'LayoutOrder' | 'Name' | 'Custom'
  // HorizontalFlex / VerticalFlex for the main axis: None, Fill, SpaceAround, SpaceBetween, SpaceEvenly.
  mainFlex?: string
  // Cross-axis flex: Fill stretches every item across.
  crossFlex?: string
  wraps?: boolean
}

export function sortItems<T extends { layoutOrder: number; name: string; index: number }>(items: T[], sortOrder: string): T[] {
  return [...items].sort((a, b) => {
    if (sortOrder === 'Name') return a.name < b.name ? -1 : a.name > b.name ? 1 : a.index - b.index
    if (sortOrder === 'LayoutOrder') return a.layoutOrder - b.layoutOrder || a.index - b.index
    return a.index - b.index
  })
}

// UIListLayout: item rects relative to the content box origin, plus the content extent.
export function listLayout(items: ListItem[], content: { w: number; h: number }, o: ListOptions): { rects: Map<number, Rect>; extent: [number, number] } {
  const vertical = o.direction === 'Vertical'
  const main = (s: [number, number]) => (vertical ? s[1] : s[0])
  const cross = (s: [number, number]) => (vertical ? s[0] : s[1])
  const mainAvail = vertical ? content.h : content.w
  const crossAvail = vertical ? content.w : content.h
  const sorted = sortItems(items, o.sortOrder)

  // Lines (one unless Wraps).
  const lines: ListItem[][] = []
  let line: ListItem[] = []
  let used = 0
  for (const item of sorted) {
    const m = main(item.size)
    if (o.wraps && line.length && used + o.padding + m > mainAvail + 0.01) {
      lines.push(line)
      line = []
      used = 0
    }
    used += (line.length ? o.padding : 0) + m
    line.push(item)
  }
  if (line.length) lines.push(line)

  const rects = new Map<number, Rect>()
  let crossCursor = 0
  let maxMain = 0
  const lineCount = lines.length
  for (const items of lines) {
    const sizes = items.map((i) => [main(i.size), o.crossFlex === 'Fill' && lineCount === 1 ? crossAvail : cross(i.size)] as [number, number])
    const total = sizes.reduce((s, x) => s + x[0], 0) + o.padding * Math.max(0, items.length - 1)
    let free = mainAvail - total
    // Grow: UIFlexItem weights, or every item when the layout's flex is Fill.
    const weights = items.map((i) => i.grow ?? (o.mainFlex === 'Fill' ? 1 : 0))
    const weightSum = weights.reduce((a, b) => a + b, 0)
    if (free > 0 && weightSum > 0) {
      items.forEach((_, i) => (sizes[i][0] += (free * weights[i]) / weightSum))
      free = 0
    } else if (free < 0) {
      const shrink = items.map((i) => i.shrink ?? 0)
      const shrinkSum = shrink.reduce((a, b) => a + b, 0)
      if (shrinkSum > 0) {
        items.forEach((_, i) => (sizes[i][0] = Math.max(0, sizes[i][0] + (free * shrink[i]) / shrinkSum)))
        free = 0
      }
    }
    let gap = o.padding
    let start = 0
    const n = items.length
    if (free > 0 && o.mainFlex === 'SpaceBetween' && n > 1) gap += free / (n - 1)
    else if (free > 0 && o.mainFlex === 'SpaceAround') {
      gap += free / n
      start = free / n / 2
    } else if (free > 0 && o.mainFlex === 'SpaceEvenly') {
      gap += free / (n + 1)
      start = free / (n + 1)
    } else {
      const align = vertical ? o.verticalAlignment : o.horizontalAlignment
      if (align === 'Center' || align === 'Bottom' || align === 'Right') start = (align === 'Center' ? 0.5 : 1) * free
    }
    const lineCross = Math.max(0, ...sizes.map((s) => s[1]))
    let cursor = start
    items.forEach((item, i) => {
      const [m, c] = sizes[i]
      const crossAlign = vertical ? o.horizontalAlignment : o.verticalAlignment
      const span = lineCount > 1 ? lineCross : crossAvail
      const factor = crossAlign === 'Center' ? 0.5 : crossAlign === 'Right' || crossAlign === 'Bottom' ? 1 : 0
      const off = crossCursor + (span - c) * factor
      rects.set(item.id, vertical ? { x: off, y: cursor, w: c, h: m } : { x: cursor, y: off, w: m, h: c })
      cursor += m + gap
    })
    maxMain = Math.max(maxMain, total)
    crossCursor += lineCross + (lineCount > 1 ? o.padding : 0)
  }
  const crossExtent = lineCount > 1 ? crossCursor - o.padding : Math.max(0, ...[...rects.values()].map((r) => (vertical ? r.w : r.h)))
  return { rects, extent: vertical ? [crossExtent, maxMain] : [maxMain, crossExtent] }
}

export interface GridOptions {
  cell: [number, number]
  padding: [number, number]
  direction: 'Horizontal' | 'Vertical'
  maxCells: number
  horizontalAlignment: 'Left' | 'Center' | 'Right'
  verticalAlignment: 'Top' | 'Center' | 'Bottom'
  sortOrder: string
}

// UIGridLayout: fills rows (Horizontal) or columns (Vertical) with fixed cells.
export function gridLayout(items: ListItem[], content: { w: number; h: number }, o: GridOptions): { rects: Map<number, Rect>; extent: [number, number] } {
  const sorted = sortItems(items, o.sortOrder)
  const [cw, ch] = o.cell
  const [px, py] = o.padding
  const horizontal = o.direction === 'Horizontal'
  let perLine = horizontal ? Math.floor((content.w + px) / Math.max(cw + px, 1e-9)) : Math.floor((content.h + py) / Math.max(ch + py, 1e-9))
  perLine = Math.max(1, perLine)
  if (o.maxCells > 0) perLine = Math.min(perLine, o.maxCells)
  const n = sorted.length
  const cols = horizontal ? Math.min(perLine, n) : Math.ceil(n / perLine)
  const rows = horizontal ? Math.ceil(n / perLine) : Math.min(perLine, n)
  const blockW = cols * cw + Math.max(0, cols - 1) * px
  const blockH = rows * ch + Math.max(0, rows - 1) * py
  const fx = o.horizontalAlignment === 'Center' ? 0.5 : o.horizontalAlignment === 'Right' ? 1 : 0
  const fy = o.verticalAlignment === 'Center' ? 0.5 : o.verticalAlignment === 'Bottom' ? 1 : 0
  const ox = (content.w - blockW) * fx
  const oy = (content.h - blockH) * fy
  const rects = new Map<number, Rect>()
  sorted.forEach((item, i) => {
    const col = horizontal ? i % perLine : Math.floor(i / perLine)
    const row = horizontal ? Math.floor(i / perLine) : i % perLine
    rects.set(item.id, { x: ox + col * (cw + px), y: oy + row * (ch + py), w: cw, h: ch })
  })
  return { rects, extent: [blockW, blockH] }
}

// Largest pixel size (1..max, Roblox caps TextScaled at 100) at which the text fits the box.
export function fitTextSize(text: string, font: FontValue | undefined, box: { w: number; h: number }, wrapped: boolean, measure: MeasureText, min = 1, max = 100): number {
  if (!text) return Math.max(min, Math.min(max, 14))
  let lo = Math.max(1, min)
  let hi = Math.max(lo, max)
  const fits = (size: number) => {
    const m = measure(text, font, size, wrapped ? box.w : null)
    return m.w <= box.w + 0.5 && m.h <= box.h + 0.5
  }
  if (fits(hi)) return hi
  if (!fits(lo)) return lo
  while (hi - lo > 0.5) {
    const mid = (lo + hi) / 2
    if (fits(mid)) lo = mid
    else hi = mid
  }
  // Roblox text sizes are whole pixels: the largest integer that fits.
  for (let size = Math.floor(hi); size > Math.floor(lo); size--) if (fits(size)) return size
  return Math.floor(lo)
}

// Rough metrics for tests and headless summaries: average glyph 0.5em wide, 1em lines.
export const approxMeasure: MeasureText = (text, _font, size, wrapWidth) => {
  const charW = size * 0.5
  const lines = text.split('\n')
  let count = 0
  let widest = 0
  for (const line of lines) {
    const w = line.length * charW
    if (wrapWidth && wrapWidth > 0 && w > wrapWidth) {
      const perLine = Math.max(1, Math.floor(wrapWidth / charW))
      count += Math.ceil(line.length / perLine)
      widest = Math.max(widest, Math.min(w, perLine * charW))
    } else {
      count += 1
      widest = Math.max(widest, w)
    }
  }
  return { w: widest, h: count * size }
}

// Strips rich text tags for measuring.
export function plainText(text: string, rich: boolean): string {
  if (!rich) return text
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

// ---- the tree

const ALIGN_H = (v: string): 'Left' | 'Center' | 'Right' => (v === 'Center' || v === 'Right' ? v : 'Left')
const ALIGN_V = (v: string): 'Top' | 'Center' | 'Bottom' => (v === 'Center' || v === 'Bottom' ? v : 'Top')

export interface LayoutOptions {
  viewport: { w: number; h: number }
  measure?: MeasureText
}

export function layoutTree(tree: PreviewTree, options: LayoutOptions): LayoutResult {
  const measure = options.measure ?? approxMeasure
  const boxes = new Map<number, Box>()
  const rootNode = tree.root != null ? tree.get(tree.root) : undefined
  if (!rootNode) return { boxes, root: null }
  const screen: Rect = { x: 0, y: 0, w: options.viewport.w, h: options.viewport.h }

  // Base size of a node inside parent content `p`, before AutomaticSize.
  const baseSize = (node: UiNode, p: { w: number; h: number }, k: number): [number, number] => {
    const constraint = enumName(node.props.SizeConstraint, 'RelativeXY')
    const parent = constraint === 'RelativeXX' ? { w: p.w, h: p.w } : constraint === 'RelativeYY' ? { w: p.h, h: p.h } : p
    let size = resolveUDim2(udim2(node.props.Size), parent, k)
    const sc = modifier(tree, node, 'UISizeConstraint')
    if (sc) {
      const mn = vec2(sc.props.MinSize, [0, 0])
      const mx = vec2(sc.props.MaxSize, [Infinity, Infinity])
      size = clampSize(size, [mn[0] * k, mn[1] * k], [mx[0] >= 1e8 ? Infinity : mx[0] * k, mx[1] >= 1e8 ? Infinity : mx[1] * k])
    }
    const ar = modifier(tree, node, 'UIAspectRatioConstraint')
    if (ar) size = applyAspect(size, num(ar.props.AspectRatio, 1), enumName(ar.props.AspectType, 'FitWithinMaxSize'), enumName(ar.props.DominantAxis, 'Width'))
    const s = modifier(tree, node, 'UIScale')
    if (s) size = [size[0] * num(s.props.Scale, 1), size[1] * num(s.props.Scale, 1)]
    return [Math.max(0, size[0]), Math.max(0, size[1])]
  }

  const textSizeOf = (node: UiNode, w: number, h: number, k: number): number | undefined => {
    if (!TEXT_CLASSES.has(node.cls)) return undefined
    const font = isTagged(node.props.FontFace, 'Font') ? node.props.FontFace : undefined
    const tsc = modifier(tree, node, 'UITextSizeConstraint')
    const minSize = tsc ? num(tsc.props.MinTextSize, 1) : 1
    const maxSize = tsc ? num(tsc.props.MaxTextSize, 100) : 100
    if (bool(node.props.TextScaled)) {
      const text = plainText(str(node.props.Text) || (node.cls === 'TextBox' ? str(node.props.PlaceholderText) : ''), bool(node.props.RichText))
      return fitTextSize(text, font, { w, h }, bool(node.props.TextWrapped), measure, minSize * k, Math.min(100, maxSize) * k)
    }
    return Math.min(maxSize, Math.max(minSize, num(node.props.TextSize, 14))) * k
  }

  // Lays out `node` whose box is already decided; recurses into children.
  const layoutChildren = (node: UiNode, box: Box): [number, number] => {
    const k = box.scale
    const pad = resolvePadding(modifier(tree, node, 'UIPadding')?.props, box, k)
    let content: Rect = inset(box, pad)
    if (node.cls === 'ScrollingFrame') {
      const canvasSize = resolveUDim2(udim2(node.props.CanvasSize), box, k)
      const pos = vec2(node.props.CanvasPosition)
      box.canvas = { w: Math.max(box.w, canvasSize[0]), h: Math.max(box.h, canvasSize[1]), x: pos[0], y: pos[1] }
      content = inset({ x: box.x - pos[0], y: box.y - pos[1], w: box.canvas.w, h: box.canvas.h }, pad)
    }
    const kids = guiChildren(tree, node)
    const list = modifier(tree, node, 'UIListLayout')
    const grid = list ? undefined : modifier(tree, node, 'UIGridLayout')
    let extent: [number, number] = [0, 0]
    const placed: Box[] = []
    if (list || grid) {
      const items: ListItem[] = []
      const shown = kids.filter(visible)
      shown.forEach((c, index) => {
        const flex = modifier(tree, c, 'UIFlexItem')
        let grow: number | undefined
        let shrink: number | undefined
        if (flex) {
          const mode = enumName(flex.props.FlexMode, 'None')
          if (mode === 'Grow' || mode === 'Fill') grow = 1
          if (mode === 'Shrink' || mode === 'Fill') shrink = 1
          if (mode === 'Custom') {
            grow = num(flex.props.GrowRatio, 0)
            shrink = num(flex.props.ShrinkRatio, 0)
          }
        }
        const size = autoSized(c, content, k)
        items.push({ id: c.id, size, layoutOrder: num(c.props.LayoutOrder), name: c.name, index, ...(grow !== undefined ? { grow } : {}), ...(shrink !== undefined ? { shrink } : {}) })
      })
      let result: { rects: Map<number, Rect>; extent: [number, number] }
      if (list) {
        const vertical = enumName(list.props.FillDirection, 'Vertical') === 'Vertical'
        const [ps, po] = udim(list.props.Padding)
        result = listLayout(items, content, {
          direction: vertical ? 'Vertical' : 'Horizontal',
          padding: ps * (vertical ? content.h : content.w) + po * k,
          horizontalAlignment: ALIGN_H(enumName(list.props.HorizontalAlignment, 'Left')),
          verticalAlignment: ALIGN_V(enumName(list.props.VerticalAlignment, 'Top')),
          sortOrder: enumName(list.props.SortOrder, 'LayoutOrder') as ListOptions['sortOrder'],
          mainFlex: enumName(vertical ? list.props.VerticalFlex : list.props.HorizontalFlex, 'None'),
          crossFlex: enumName(vertical ? list.props.HorizontalFlex : list.props.VerticalFlex, 'None'),
          wraps: bool(list.props.Wraps)
        })
      } else {
        const g = grid!
        result = gridLayout(items, content, {
          cell: resolveUDim2(udim2(g.props.CellSize ?? { t: 'UDim2', v: [0, 100, 0, 100] }), content, k),
          padding: resolveUDim2(udim2(g.props.CellPadding ?? { t: 'UDim2', v: [0, 5, 0, 5] }), content, k),
          direction: enumName(g.props.FillDirection, 'Horizontal') === 'Vertical' ? 'Vertical' : 'Horizontal',
          maxCells: num(g.props.FillDirectionMaxCells, 0),
          horizontalAlignment: ALIGN_H(enumName(g.props.HorizontalAlignment, 'Left')),
          verticalAlignment: ALIGN_V(enumName(g.props.VerticalAlignment, 'Top')),
          sortOrder: enumName(g.props.SortOrder, 'LayoutOrder')
        })
      }
      extent = result.extent
      for (const c of shown) {
        const r = result.rects.get(c.id)!
        placed.push(place(c, { x: content.x + r.x, y: content.y + r.y, w: r.w, h: r.h }, k, true))
      }
      for (const c of kids) if (!visible(c)) placed.push(place(c, { x: content.x, y: content.y, w: 0, h: 0 }, k, true))
    } else {
      for (const c of kids) {
        const b = layoutNode(c, content, k)
        placed.push(b)
        if (!visible(c)) continue
        const [sx, , sy] = udim2(c.props.Size)
        if (sx === 0) extent[0] = Math.max(extent[0], b.x + b.w - content.x)
        if (sy === 0) extent[1] = Math.max(extent[1], b.y + b.h - content.y)
      }
    }
    // Draw order: ZIndex, then child order.
    const order = kids.map((c, i) => ({ id: c.id, z: num(c.props.ZIndex, 1), i }))
    order.sort((a, b) => a.z - b.z || a.i - b.i)
    box.draw = order.map((o) => o.id)
    // Text contributes to AutomaticSize too.
    if (TEXT_CLASSES.has(node.cls)) {
      const text = plainText(str(node.props.Text), bool(node.props.RichText))
      const auto = enumName(node.props.AutomaticSize, 'None')
      const wrap = bool(node.props.TextWrapped) && auto !== 'X' && auto !== 'XY' ? content.w : null
      const m = measure(text, isTagged(node.props.FontFace, 'Font') ? node.props.FontFace : undefined, box.textSize ?? num(node.props.TextSize, 14) * k, wrap)
      extent = [Math.max(extent[0], m.w), Math.max(extent[1], m.h)]
    }
    if (node.cls === 'ScrollingFrame' && box.canvas) {
      const autoCanvas = enumName(node.props.AutomaticCanvasSize, 'None')
      if (autoCanvas === 'X' || autoCanvas === 'XY') box.canvas.w = Math.max(box.canvas.w, extent[0] + pad.left + pad.right)
      if (autoCanvas === 'Y' || autoCanvas === 'XY') box.canvas.h = Math.max(box.canvas.h, extent[1] + pad.top + pad.bottom)
    }
    return [extent[0] + pad.left + pad.right, extent[1] + pad.top + pad.bottom]
  }

  // Size including AutomaticSize, computed by a dry layout of the subtree (used by list/grid items).
  const autoSized = (node: UiNode, parent: Rect, k: number): [number, number] => {
    const size = baseSize(node, parent, k)
    const auto = enumName(node.props.AutomaticSize, 'None')
    if (auto === 'None') return size
    const scratch: Box = { id: node.id, x: 0, y: 0, w: size[0], h: size[1], rotation: 0, scale: scaleOf(node, k), draw: [] }
    scratch.textSize = textSizeOf(node, size[0], size[1], scratch.scale)
    const extent = layoutChildren(node, scratch)
    return [auto === 'X' || auto === 'XY' ? Math.max(size[0], extent[0]) : size[0], auto === 'Y' || auto === 'XY' ? Math.max(size[1], extent[1]) : size[1]]
  }

  const scaleOf = (node: UiNode, k: number) => {
    const s = modifier(tree, node, 'UIScale')
    return s ? k * num(s.props.Scale, 1) : k
  }

  // Places a node at a fixed rect (list/grid children).
  const place = (node: UiNode, r: Rect, k: number, fixed: boolean): Box => {
    const box: Box = { id: node.id, x: r.x, y: r.y, w: r.w, h: r.h, rotation: num(node.props.Rotation), scale: scaleOf(node, k), draw: [] }
    box.textSize = textSizeOf(node, box.w, box.h, box.scale)
    boxes.set(node.id, box)
    layoutChildren(node, box)
    void fixed
    return box
  }

  const layoutNode = (node: UiNode, parent: Rect, k: number): Box => {
    let size = baseSize(node, parent, k)
    const auto = enumName(node.props.AutomaticSize, 'None')
    const anchor = vec2(node.props.AnchorPoint)
    const position = udim2(node.props.Position)
    const [x, y] = placeBox(position, anchor, size, parent, k)
    const box: Box = { id: node.id, x, y, w: size[0], h: size[1], rotation: num(node.props.Rotation), scale: scaleOf(node, k), draw: [] }
    box.textSize = textSizeOf(node, box.w, box.h, box.scale)
    boxes.set(node.id, box)
    const extent = layoutChildren(node, box)
    if (auto !== 'None') {
      const grown: [number, number] = [auto === 'X' || auto === 'XY' ? Math.max(size[0], extent[0]) : size[0], auto === 'Y' || auto === 'XY' ? Math.max(size[1], extent[1]) : size[1]]
      if (grown[0] !== size[0] || grown[1] !== size[1]) {
        size = grown
        const [nx, ny] = placeBox(position, anchor, size, parent, k)
        Object.assign(box, { x: nx, y: ny, w: size[0], h: size[1] })
        layoutChildren(node, box)
      }
    }
    return box
  }

  // The ScreenGui fills the viewport; its GuiObjects lay out against it.
  const rootBox: Box = { id: rootNode.id, ...screen, rotation: 0, scale: 1, draw: [] }
  boxes.set(rootNode.id, rootBox)
  const kids = guiChildren(tree, rootNode)
  for (const c of kids) layoutNode(c, screen, 1)
  rootBox.draw = kids.map((c, i) => ({ id: c.id, z: num(c.props.ZIndex, 1), i })).sort((a, b) => a.z - b.z || a.i - b.i).map((o) => o.id)
  return { boxes, root: rootNode.id }
}

// CornerRadius in pixels (scale is relative to the smaller side).
export function cornerRadius(props: UiProps | undefined, box: { w: number; h: number }, k = 1): number {
  if (!props) return 0
  const [s, o] = udim(props.CornerRadius ?? { t: 'UDim', v: [0, 8] })
  return Math.max(0, Math.min(s * Math.min(box.w, box.h) + o * k, Math.min(box.w, box.h) / 2))
}
