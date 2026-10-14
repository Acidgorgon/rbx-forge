// The Figma node shape the importer reads: a subset of the REST API's node JSON
// (https://developers.figma.com/docs/rest-api/files/ , GET /v1/files/:key/nodes), which the Forge
// Figma plugin (figma-plugin/) also writes for any selection, so both import paths share map.ts.
// Pure types plus the plugin's document envelope.

export interface FigmaColor {
  r: number
  g: number
  b: number
  a: number
}

export interface FigmaVector {
  x: number
  y: number
}

export interface FigmaRect {
  x: number
  y: number
  width: number
  height: number
}

export interface FigmaGradientStop {
  position: number
  color: FigmaColor
}

export interface FigmaPaint {
  type: 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND' | 'IMAGE' | 'EMOJI' | 'VIDEO' | 'PATTERN'
  visible?: boolean
  opacity?: number
  blendMode?: string
  color?: FigmaColor
  // Normalised node space: start, end, and the width handle.
  gradientHandlePositions?: FigmaVector[]
  gradientStops?: FigmaGradientStop[]
  scaleMode?: 'FILL' | 'FIT' | 'TILE' | 'STRETCH' | 'CROP'
  imageRef?: string
  scalingFactor?: number
}

export interface FigmaEffect {
  type: 'DROP_SHADOW' | 'INNER_SHADOW' | 'LAYER_BLUR' | 'BACKGROUND_BLUR' | 'TEXTURE' | 'NOISE'
  visible?: boolean
  radius?: number
  color?: FigmaColor
  offset?: FigmaVector
  spread?: number
}

export interface FigmaTypeStyle {
  fontFamily?: string
  fontPostScriptName?: string | null
  fontWeight?: number
  fontSize?: number
  italic?: boolean
  textAlignHorizontal?: 'LEFT' | 'RIGHT' | 'CENTER' | 'JUSTIFIED'
  textAlignVertical?: 'TOP' | 'CENTER' | 'BOTTOM'
  letterSpacing?: number
  lineHeightPx?: number
  lineHeightPercentFontSize?: number
  lineHeightUnit?: 'PIXELS' | 'FONT_SIZE_%' | 'INTRINSIC_%'
  textCase?: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE' | 'SMALL_CAPS' | 'SMALL_CAPS_FORCED'
  textDecoration?: 'NONE' | 'STRIKETHROUGH' | 'UNDERLINE'
  textAutoResize?: 'NONE' | 'HEIGHT' | 'WIDTH_AND_HEIGHT' | 'TRUNCATE'
}

// REST constraint values; the plugin's MIN / MAX / STRETCH are accepted too.
export type FigmaConstraintH = 'LEFT' | 'RIGHT' | 'CENTER' | 'LEFT_RIGHT' | 'SCALE' | 'MIN' | 'MAX' | 'STRETCH'
export type FigmaConstraintV = 'TOP' | 'BOTTOM' | 'CENTER' | 'TOP_BOTTOM' | 'SCALE' | 'MIN' | 'MAX' | 'STRETCH'

export interface FigmaNode {
  id: string
  name: string
  type: string
  visible?: boolean
  children?: FigmaNode[]
  absoluteBoundingBox?: FigmaRect | null
  // Unrotated size (the plugin writes it; REST only with geometry=paths).
  size?: FigmaVector
  // Degrees, counter-clockwise (Figma's convention).
  rotation?: number
  opacity?: number
  blendMode?: string
  isMask?: boolean
  clipsContent?: boolean
  fills?: FigmaPaint[]
  strokes?: FigmaPaint[]
  strokeWeight?: number
  individualStrokeWeights?: { top: number; right: number; bottom: number; left: number }
  strokeAlign?: 'INSIDE' | 'OUTSIDE' | 'CENTER'
  strokeDashes?: number[]
  cornerRadius?: number
  rectangleCornerRadii?: [number, number, number, number]
  effects?: FigmaEffect[]
  constraints?: { horizontal: FigmaConstraintH; vertical: FigmaConstraintV }
  // Auto layout
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID'
  layoutWrap?: 'NO_WRAP' | 'WRAP'
  itemSpacing?: number
  counterAxisSpacing?: number
  paddingLeft?: number
  paddingRight?: number
  paddingTop?: number
  paddingBottom?: number
  primaryAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN'
  counterAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE'
  primaryAxisSizingMode?: 'FIXED' | 'AUTO'
  counterAxisSizingMode?: 'FIXED' | 'AUTO'
  layoutPositioning?: 'AUTO' | 'ABSOLUTE'
  layoutSizingHorizontal?: 'FIXED' | 'HUG' | 'FILL'
  layoutSizingVertical?: 'FIXED' | 'HUG' | 'FILL'
  layoutGrow?: number
  layoutAlign?: 'INHERIT' | 'STRETCH' | 'MIN' | 'CENTER' | 'MAX'
  itemReverseZIndex?: boolean
  // Text
  characters?: string
  style?: FigmaTypeStyle
  characterStyleOverrides?: number[]
}

export const FORGE_FIGMA_FORMAT = 'forge-figma'
export const FORGE_FIGMA_VERSION = 1

// What the Forge Figma plugin's "Send selection to Forge" writes (paste or download, no network).
export interface ForgeFigmaDoc {
  format: typeof FORGE_FIGMA_FORMAT
  version: number
  source: { kind: 'plugin'; fileName?: string; page?: string; nodeId: string; nodeName: string }
  exportedAt?: string
  root: FigmaNode
  // PNG bytes (base64) by image key: "fill:<imageRef>" for image fills, "node:<id>" for rendered nodes.
  images: Record<string, string>
  // The plugin's own mapping summary (shown in the plugin; Forge maps again with its current rules).
  summary?: string
}

export function parseForgeFigmaDoc(text: string): ForgeFigmaDoc {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Not JSON. In Figma run Forge UI > Send selection to Forge, then copy or download the JSON.')
  }
  const d = raw as Partial<ForgeFigmaDoc>
  if (!d || d.format !== FORGE_FIGMA_FORMAT || !d.root || typeof d.root !== 'object') throw new Error('Not a Forge Figma selection (format "forge-figma"). Use Send selection to Forge in the plugin.')
  if (typeof d.version !== 'number' || d.version > FORGE_FIGMA_VERSION) throw new Error(`Forge Figma document version ${String(d.version)} is newer than this Forge.`)
  return { ...d, images: d.images && typeof d.images === 'object' ? d.images : {} } as ForgeFigmaDoc
}

// Gradient handles (normalised node space) from a plugin gradientTransform (the 2x3 matrix that maps
// node space to gradient space, where the gradient runs (0, 0.5) -> (1, 0.5)).
export function handlesFromTransform(t: [[number, number, number], [number, number, number]]): FigmaVector[] {
  const [[a, b, c], [d, e, f]] = t
  const det = a * e - b * d
  if (Math.abs(det) < 1e-9) return [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }]
  // Inverse of [[a b c][d e f][0 0 1]].
  const ia = e / det
  const ib = -b / det
  const id = -d / det
  const ie = a / det
  const ic = -(ia * c + ib * f)
  const iff = -(id * c + ie * f)
  const map = (x: number, y: number) => ({ x: ia * x + ib * y + ic, y: id * x + ie * y + iff })
  return [map(0, 0.5), map(1, 0.5), map(0, 1)]
}
