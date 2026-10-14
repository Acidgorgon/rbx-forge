// "Send selection to Forge": any frame, component, instance, group or layer (no Forge plugin data
// needed) as a REST-shaped node snapshot plus the PNGs Forge needs (image fills by hash, vectors and
// icons rendered at 2x), in Forge's "forge-figma" format. Forge maps it to Roblox instances with
// its own rules (src/shared/uimotion/figma/map.ts); the plugin runs the same mapper only to show
// what will be approximated. No network: the JSON is copied or downloaded.

import { mapFigmaNode } from '../src/shared/uimotion/figma/map.ts'
import { handlesFromTransform, type FigmaEffect, type FigmaNode, type FigmaPaint } from '../src/shared/uimotion/figma/types.ts'

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/extra ?light|ultra ?light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi ?bold|demi ?bold/i, 600],
  [/extra ?bold|ultra ?bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700]
]
const weightOf = (style: string) => WEIGHTS.find(([re]) => re.test(style))?.[1] ?? 400

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const isMixed = (v: unknown) => typeof v === 'symbol'

function paints(list: unknown): FigmaPaint[] | undefined {
  if (!Array.isArray(list)) return undefined
  const out: FigmaPaint[] = []
  for (const p of list as Any[]) {
    const base = { visible: p.visible !== false, opacity: num(p.opacity) ?? 1, blendMode: p.blendMode }
    if (p.type === 'SOLID') out.push({ ...base, type: 'SOLID', color: { r: p.color.r, g: p.color.g, b: p.color.b, a: 1 } })
    else if (typeof p.type === 'string' && p.type.startsWith('GRADIENT_'))
      out.push({ ...base, type: p.type, gradientHandlePositions: handlesFromTransform(p.gradientTransform), gradientStops: (p.gradientStops ?? []).map((s: Any) => ({ position: s.position, color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a } })) })
    else if (p.type === 'IMAGE' && p.imageHash) out.push({ ...base, type: 'IMAGE', imageRef: p.imageHash, scaleMode: p.scaleMode })
    else out.push({ ...base, type: p.type })
  }
  return out
}

function effects(list: unknown): FigmaEffect[] | undefined {
  if (!Array.isArray(list)) return undefined
  return (list as Any[]).map((e) => ({
    type: e.type,
    visible: e.visible !== false,
    radius: num(e.radius) ?? 0,
    ...(e.color ? { color: { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a } } : {}),
    ...(e.offset ? { offset: { x: e.offset.x, y: e.offset.y } } : {}),
    ...(num(e.spread) != null ? { spread: e.spread } : {})
  }))
}

function textStyle(n: Any): FigmaNode['style'] {
  const font = isMixed(n.fontName) ? n.getRangeFontName(0, 1) : n.fontName
  const size = isMixed(n.fontSize) ? n.getRangeFontSize(0, 1) : n.fontSize
  const ls = isMixed(n.letterSpacing) ? n.getRangeLetterSpacing(0, 1) : n.letterSpacing
  const lh = isMixed(n.lineHeight) ? n.getRangeLineHeight(0, 1) : n.lineHeight
  const textCase = isMixed(n.textCase) ? n.getRangeTextCase(0, 1) : n.textCase
  const deco = isMixed(n.textDecoration) ? n.getRangeTextDecoration(0, 1) : n.textDecoration
  const weight = isMixed(n.fontWeight) ? n.getRangeFontWeight(0, 1) : n.fontWeight
  const style: NonNullable<FigmaNode['style']> = {
    fontFamily: font.family,
    fontPostScriptName: `${font.family}-${font.style}`.replace(/\s+/g, ''),
    fontWeight: num(weight) ?? weightOf(font.style),
    italic: /italic|oblique/i.test(font.style),
    fontSize: size,
    textAlignHorizontal: n.textAlignHorizontal,
    textAlignVertical: n.textAlignVertical,
    letterSpacing: ls.unit === 'PERCENT' ? (ls.value / 100) * size : ls.value,
    textCase: textCase === 'ORIGINAL' ? 'ORIGINAL' : textCase,
    textDecoration: deco,
    textAutoResize: n.textAutoResize
  }
  if (lh.unit === 'PIXELS') Object.assign(style, { lineHeightPx: lh.value, lineHeightUnit: 'PIXELS' })
  else if (lh.unit === 'PERCENT') Object.assign(style, { lineHeightPercentFontSize: lh.value, lineHeightUnit: 'FONT_SIZE_%' })
  else Object.assign(style, { lineHeightUnit: 'INTRINSIC_%' })
  return style
}

const H: Record<string, string> = { MIN: 'LEFT', MAX: 'RIGHT', CENTER: 'CENTER', STRETCH: 'LEFT_RIGHT', SCALE: 'SCALE' }
const V: Record<string, string> = { MIN: 'TOP', MAX: 'BOTTOM', CENTER: 'CENTER', STRETCH: 'TOP_BOTTOM', SCALE: 'SCALE' }

// One node (and its subtree) in the REST "file nodes" shape.
export function serialize(n: Any): FigmaNode {
  const out: Any = { id: n.id, name: n.name, type: n.type, visible: n.visible !== false }
  const box = n.absoluteBoundingBox ?? (n.absoluteTransform ? { x: n.absoluteTransform[0][2], y: n.absoluteTransform[1][2], width: n.width, height: n.height } : null)
  if (box) out.absoluteBoundingBox = { x: box.x, y: box.y, width: box.width, height: box.height }
  if (num(n.width) != null) out.size = { x: n.width, y: n.height }
  if (num(n.rotation)) out.rotation = n.rotation
  if (num(n.opacity) != null && n.opacity < 1) out.opacity = n.opacity
  if (n.blendMode && n.blendMode !== 'PASS_THROUGH' && n.blendMode !== 'NORMAL') out.blendMode = n.blendMode
  if (n.isMask) out.isMask = true
  if (typeof n.clipsContent === 'boolean') out.clipsContent = n.clipsContent
  if ('fills' in n && !isMixed(n.fills)) out.fills = paints(n.fills)
  else if ('fills' in n && n.type === 'TEXT') out.fills = paints(n.getRangeFills(0, 1))
  if ('strokes' in n) {
    out.strokes = paints(n.strokes)
    if (num(n.strokeWeight) != null) out.strokeWeight = n.strokeWeight
    else if (num(n.strokeTopWeight) != null) out.individualStrokeWeights = { top: n.strokeTopWeight, right: n.strokeRightWeight, bottom: n.strokeBottomWeight, left: n.strokeLeftWeight }
    out.strokeAlign = n.strokeAlign
    if (Array.isArray(n.dashPattern) && n.dashPattern.length) out.strokeDashes = [...n.dashPattern]
  }
  if ('cornerRadius' in n) {
    if (isMixed(n.cornerRadius)) out.rectangleCornerRadii = [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius]
    else if (n.cornerRadius) out.cornerRadius = n.cornerRadius
  }
  if ('effects' in n) out.effects = effects(n.effects)
  if (n.constraints) out.constraints = { horizontal: H[n.constraints.horizontal] ?? n.constraints.horizontal, vertical: V[n.constraints.vertical] ?? n.constraints.vertical }
  if (n.layoutMode && n.layoutMode !== 'NONE') {
    for (const k of ['layoutMode', 'layoutWrap', 'itemSpacing', 'counterAxisSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'primaryAxisSizingMode', 'counterAxisSizingMode', 'itemReverseZIndex']) if (n[k] !== undefined && n[k] !== null && !isMixed(n[k])) out[k] = n[k]
  }
  for (const k of ['layoutPositioning', 'layoutSizingHorizontal', 'layoutSizingVertical', 'layoutGrow', 'layoutAlign']) if (n[k] !== undefined && n[k] !== null && !isMixed(n[k])) out[k] = n[k]
  if (n.type === 'TEXT') {
    out.characters = n.characters
    out.style = textStyle(n)
  }
  if ('children' in n && Array.isArray(n.children) && !['INSTANCE_SWAP'].includes(n.type)) out.children = n.children.map(serialize)
  return out as FigmaNode
}

function walk(n: FigmaNode, fn: (n: FigmaNode) => void): void {
  fn(n)
  for (const c of n.children ?? []) walk(c, fn)
}

export interface SendResult {
  json: string
  name: string
  summary: string
  images: number
  missing: string[]
  bytes: number
}

// The selection (first selected node) as a Forge Figma document.
export async function sendSelection(api: Any): Promise<SendResult> {
  const sel = api.currentPage.selection[0]
  if (!sel) throw new Error('Select a frame, component or layer to send to Forge.')
  const root = serialize(sel)
  const { report } = mapFigmaNode(root, { name: sel.name })
  const images: Record<string, string> = {}
  const missing: string[] = []
  // Image fills by hash (the mapper's "fill:<imageRef>" keys).
  const hashes = new Set<string>()
  walk(root, (n) => (n.fills ?? []).forEach((p) => p.type === 'IMAGE' && p.imageRef && hashes.add(p.imageRef)))
  for (const h of hashes) {
    try {
      const bytes = await api.getImageByHash(h)?.getBytesAsync()
      if (bytes) images[`fill:${h}`] = api.base64Encode(bytes)
      else missing.push(`image ${h}`)
    } catch {
      missing.push(`image ${h}`)
    }
  }
  // Vectors / icons the mapper renders to PNG ("node:<id>").
  for (const req of report.images.filter((r) => r.kind === 'render')) {
    try {
      const node = await api.getNodeByIdAsync(req.ref)
      if (!node || !('exportAsync' in node)) throw new Error('gone')
      const png = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } })
      images[req.key] = api.base64Encode(png)
    } catch {
      missing.push(req.node)
    }
  }
  const doc = {
    format: 'forge-figma',
    version: 1,
    source: { kind: 'plugin', fileName: api.root?.name, page: api.currentPage?.name, nodeId: sel.id, nodeName: sel.name },
    exportedAt: new Date().toISOString(),
    root,
    images,
    summary: report.summary
  }
  const json = JSON.stringify(doc)
  return { json, name: sel.name, summary: report.summary || 'maps exactly', images: Object.keys(images).length, missing, bytes: json.length }
}
