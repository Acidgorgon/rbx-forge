// Draws a PreviewTree the way Roblox would: layoutTree() boxes as nested absolutely positioned
// divs (rotation around the centre, ClipsDescendants as a rectangular clip, CanvasGroup as a
// rounded clip with opacity), backgrounds and UIGradient as CSS gradients, UIStroke as a masked
// ring (border) or a glyph stroke (text), UICorner radii, text with Roblox alignment and rich
// text, and images with ScaleType (Stretch/Fit/Crop/Tile/Slice), ImageRect sprites and ImageColor3
// tinting. Pointer, wheel and key input go back to Lune as UiInput messages (Interact mode); in Edit
// mode clicks select elements instead.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { UiImageInfo, UiInput } from '@shared/types'
import { cornerRadius, isGuiObject, layoutTree, modifier, resolvePadding, TEXT_CLASSES, IMAGE_CLASSES, type Box, type LayoutResult, type MeasureText } from '@shared/uiPreview/layout'
import { bool, color, enumName, isTagged, num, str, vec2, type PreviewTree, type UiNode } from '@shared/uiPreview/protocol'
import { cssFont, parseImage } from '@shared/uiPreview/assets'
import { parseRichText, type RichRun } from '@shared/uiPreview/richText'
import { backgroundAlpha, cssGradient, gradientOf, hasCorner, isVisible, rgba, shadeStops, strokeOf, textAlpha, type RGB } from '@shared/uiPreview/paint'
import { measureText } from './measure'

export type StageMode = 'interact' | 'edit' | 'static'

export interface StageProps {
  tree: PreviewTree
  version: number
  width: number
  height: number
  images: Record<string, UiImageInfo>
  mode: StageMode
  selected?: number | null
  hovered?: number | null
  onInput?: (message: UiInput) => void
  onHover?: (id: number | null) => void
  onSelect?: (id: number | null) => void
  measure?: MeasureText
  // Bumped when web fonts finish loading so text is measured again.
  fontsVersion?: number
  onLayout?: (layout: LayoutResult) => void
}

const BUTTONS = new Set(['TextButton', 'ImageButton'])

// ---- image natural sizes (needed for 9-slice and ImageRect sprites)

const natural = new Map<string, { w: number; h: number } | 'loading' | 'error'>()
const naturalListeners = new Set<() => void>()
function naturalSize(url: string): { w: number; h: number } | null {
  const hit = natural.get(url)
  if (hit && typeof hit === 'object') return hit
  if (!hit) {
    natural.set(url, 'loading')
    const img = new Image()
    img.onload = () => {
      natural.set(url, { w: img.naturalWidth, h: img.naturalHeight })
      for (const l of naturalListeners) l()
    }
    img.onerror = () => natural.set(url, 'error')
    img.src = url
  }
  return null
}

// ---- Roblox KeyCode names for browser keys

const KEY_NAMES: Record<string, string> = {
  ShiftLeft: 'LeftShift', ShiftRight: 'RightShift', ControlLeft: 'LeftControl', ControlRight: 'RightControl', AltLeft: 'LeftAlt', AltRight: 'RightAlt',
  Space: 'Space', Enter: 'Return', NumpadEnter: 'KeypadEnter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Minus: 'Minus', Equal: 'Equals', Comma: 'Comma', Period: 'Period', Slash: 'Slash', Semicolon: 'Semicolon', Quote: 'Quote', Backquote: 'Backquote',
  BracketLeft: 'LeftBracket', BracketRight: 'RightBracket', Backslash: 'BackSlash', CapsLock: 'CapsLock'
}
const DIGITS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine']
export function robloxKey(code: string): string | null {
  if (KEY_NAMES[code]) return KEY_NAMES[code]
  let m = /^Key([A-Z])$/.exec(code)
  if (m) return m[1]
  m = /^Digit(\d)$/.exec(code)
  if (m) return DIGITS[Number(m[1])]
  m = /^F(\d{1,2})$/.exec(code)
  if (m) return `F${m[1]}`
  return null
}

// ---- pieces

const px = (n: number) => `${Math.round(n * 100) / 100}px`

function alignX(v: string): 'flex-start' | 'center' | 'flex-end' {
  return v === 'Center' ? 'center' : v === 'Right' ? 'flex-end' : 'flex-start'
}
function alignY(v: string): 'flex-start' | 'center' | 'flex-end' {
  return v === 'Center' ? 'center' : v === 'Bottom' ? 'flex-end' : 'flex-start'
}

function richSpans(runs: RichRun[], base: { scale: number }): ReactNode[] {
  return runs.map((r, i) => {
    const s = r.style
    const st: CSSProperties = {}
    if (s.bold) st.fontWeight = 700
    if (s.weight) st.fontWeight = /^\d+$/.test(s.weight) ? Number(s.weight) : (({ Thin: 100, ExtraLight: 200, Light: 300, Regular: 400, Medium: 500, SemiBold: 600, Bold: 700, ExtraBold: 800, Heavy: 900 }) as Record<string, number>)[s.weight] ?? undefined
    if (s.italic) st.fontStyle = 'italic'
    const deco = [s.underline && 'underline', s.strike && 'line-through'].filter(Boolean).join(' ')
    if (deco) st.textDecoration = deco
    if (s.color) st.color = s.color
    // <font size> is in pixels, scaled like the label's own TextSize.
    if (s.size) st.fontSize = px(s.size * base.scale)
    if (s.face) st.fontFamily = `"${s.face}", inherit`
    if (s.transparency != null) st.opacity = 1 - s.transparency
    if (s.uppercase) st.textTransform = 'uppercase'
    if (s.smallcaps) st.fontVariant = 'small-caps'
    if (s.stroke) {
      st.WebkitTextStroke = `${s.stroke.thickness * 2}px ${s.stroke.color}`
      st.paintOrder = 'stroke fill'
    }
    if (s.mark) st.background = s.mark.color
    return (
      <span key={i} style={st}>
        {r.text}
      </span>
    )
  })
}

function TextBoxInput({ node, style, onInput }: { node: UiNode; style: CSSProperties; onInput: (m: UiInput) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const multi = bool(node.props.MultiLine)
  const value = draft ?? str(node.props.Text)
  const common = {
    className: 'uip-textbox',
    style,
    value,
    placeholder: str(node.props.PlaceholderText),
    spellCheck: false,
    readOnly: node.props.TextEditable === false,
    'data-uid': node.id,
    onFocus: () => {
      setDraft(str(node.props.Text))
      onInput({ type: 'focus', id: node.id })
    },
    onBlur: () => {
      setDraft(null)
      onInput({ type: 'blur', id: node.id })
    },
    onChange: (e: { target: { value: string } }) => {
      setDraft(e.target.value)
      onInput({ type: 'text', id: node.id, text: e.target.value })
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Enter' && !multi) {
        onInput({ type: 'blur', id: node.id, enter: true })
        ;(e.target as HTMLElement).blur()
      }
    }
  }
  return multi ? <textarea {...common} /> : <input {...common} />
}

interface Ctx {
  tree: PreviewTree
  boxes: Map<number, Box>
  images: Record<string, UiImageInfo>
  mode: StageMode
  onInput?: (m: UiInput) => void
  pressed: number | null
  hover: Set<number>
}

function imageLayer(ctx: Ctx, node: UiNode, box: Box, radius: number): ReactNode {
  const ref = str(node.props.Image)
  if (!ref) return null
  const info = ctx.images[ref]
  const parsed = parseImage(ref)
  const alpha = 1 - num(node.props.ImageTransparency)
  if (alpha <= 0) return null
  const base: CSSProperties = { borderRadius: radius ? px(radius) : undefined, opacity: alpha }
  if (!info?.url) {
    const label = parsed.kind === 'asset' ? `rbxassetid ${parsed.id}` : parsed.kind === 'thumb' ? `${parsed.type} ${parsed.id}` : parsed.kind === 'engine' ? parsed.path.split('/').pop() : ref.split('/').pop()
    return (
      <div className="uip-img-ph" style={{ ...base, fontSize: px(Math.max(7, Math.min(11, box.h / 4))) }} title={`${ref}${info?.reason ? ` (${info.reason})` : ''}`}>
        {box.w > 40 && box.h > 14 ? <span>{label}</span> : null}
      </div>
    )
  }
  const url = `url("${info.url.replace(/"/g, '%22')}")`
  const tint = color(node.props.ImageColor3, [1, 1, 1]) as RGB
  const tinted = tint.some((c) => c < 0.999)
  const scale = enumName(node.props.ScaleType, 'Stretch')
  const rectSize = vec2(node.props.ImageRectSize)
  const rectOffset = vec2(node.props.ImageRectOffset)
  const nat = scale === 'Slice' || rectSize[0] > 0 ? naturalSize(info.url) : null
  const st: CSSProperties = { ...base }
  if (scale === 'Slice') {
    const center = isTagged(node.props.SliceCenter, 'Rect') ? node.props.SliceCenter.v : [0, 0, 0, 0]
    if (nat) {
      const k = num(node.props.SliceScale, 1) * box.scale
      const [l, t, r, b] = [center[0], center[1], nat.w - center[2], nat.h - center[3]].map((n) => Math.max(0, n))
      st.borderStyle = 'solid'
      st.borderColor = 'transparent'
      st.borderWidth = `${t * k}px ${r * k}px ${b * k}px ${l * k}px`
      st.borderImage = `${url} ${t} ${r} ${b} ${l} fill / ${t * k}px ${r * k}px ${b * k}px ${l * k}px stretch`
      st.boxSizing = 'border-box'
      return <div className="uip-img" style={st} />
    }
    st.backgroundImage = url
    st.backgroundSize = '100% 100%'
  } else if (rectSize[0] > 0 && rectSize[1] > 0) {
    if (!nat) return <div className="uip-img" style={st} />
    const sx = box.w / rectSize[0]
    const sy = box.h / rectSize[1]
    st.backgroundImage = url
    st.backgroundSize = `${nat.w * sx}px ${nat.h * sy}px`
    st.backgroundPosition = `${-rectOffset[0] * sx}px ${-rectOffset[1] * sy}px`
    st.backgroundRepeat = 'no-repeat'
  } else {
    st.backgroundImage = url
    st.backgroundRepeat = 'no-repeat'
    st.backgroundPosition = 'center'
    if (scale === 'Fit') st.backgroundSize = 'contain'
    else if (scale === 'Crop') st.backgroundSize = 'cover'
    else if (scale === 'Tile') {
      const [ts, to, us, uo] = isTagged(node.props.TileSize, 'UDim2') ? node.props.TileSize.v : [1, 0, 1, 0]
      st.backgroundSize = `${ts * box.w + to * box.scale}px ${us * box.h + uo * box.scale}px`
      st.backgroundRepeat = 'repeat'
      st.backgroundPosition = '0 0'
    } else st.backgroundSize = '100% 100%'
  }
  if (tinted) {
    // Multiply by ImageColor3, and keep the image's own alpha with a mask of the same image.
    st.backgroundColor = rgba(tint)
    st.backgroundBlendMode = 'multiply'
    st.WebkitMaskImage = st.backgroundImage as string
    st.WebkitMaskSize = st.backgroundSize as string
    st.WebkitMaskPosition = st.backgroundPosition as string
    st.WebkitMaskRepeat = st.backgroundRepeat as string
  }
  return <div className="uip-img" style={st} />
}

function textLayer(ctx: Ctx, node: UiNode, box: Box): ReactNode {
  const k = box.scale
  const pad = resolvePadding(modifier(ctx.tree, node, 'UIPadding')?.props, box, k)
  const font = cssFont(isTagged(node.props.FontFace, 'Font') ? node.props.FontFace : undefined)
  const size = box.textSize ?? num(node.props.TextSize, 14) * k
  const lineHeight = num(node.props.LineHeight, 1)
  const wrapped = bool(node.props.TextWrapped)
  const truncate = enumName(node.props.TextTruncate, 'None') !== 'None'
  const isBox = node.cls === 'TextBox'
  const raw = str(node.props.Text)
  const placeholder = isBox && !raw
  const text = placeholder ? str(node.props.PlaceholderText) : raw
  const alpha = placeholder ? 1 : textAlpha(node)
  const tc = (placeholder ? color(node.props.PlaceholderColor3, [0.7, 0.7, 0.7]) : color(node.props.TextColor3, [0, 0, 0])) as RGB
  const stroke = strokeOf(ctx.tree, node, k)
  const grad = gradientOf(ctx.tree, node)
  const xa = enumName(node.props.TextXAlignment, 'Center')
  const ya = enumName(node.props.TextYAlignment, 'Center')
  const outer: CSSProperties = {
    padding: `${px(pad.top)} ${px(pad.right)} ${px(pad.bottom)} ${px(pad.left)}`,
    alignItems: alignX(xa),
    justifyContent: alignY(ya),
    fontFamily: font.family,
    fontWeight: font.weight,
    fontStyle: font.style,
    fontSize: px(size),
    lineHeight: px(size * lineHeight),
    color: rgba(tc, alpha),
    textAlign: xa === 'Center' ? 'center' : xa === 'Right' ? 'right' : 'left'
  }
  const inner: CSSProperties = {
    whiteSpace: wrapped ? 'pre-wrap' : 'pre',
    maxWidth: wrapped || truncate ? '100%' : undefined,
    overflow: truncate ? 'hidden' : undefined,
    textOverflow: truncate ? 'ellipsis' : undefined
  }
  if (grad && alpha > 0) {
    outer.backgroundImage = cssGradient(grad, tc, alpha)
    outer.WebkitBackgroundClip = 'text'
    outer.backgroundClip = 'text'
    outer.color = 'transparent'
  }
  if (stroke?.target === 'text') {
    outer.WebkitTextStroke = `${px(stroke.thickness * 2)} ${rgba(stroke.color, 1 - stroke.transparency)}`
    outer.paintOrder = 'stroke fill'
  }
  if (isBox && ctx.mode === 'interact' && ctx.onInput) {
    const inputStyle: CSSProperties = { ...outer, ...inner, color: rgba(color(node.props.TextColor3, [0, 0, 0]) as RGB, textAlpha(node)), caretColor: rgba(color(node.props.TextColor3, [0, 0, 0]) as RGB) }
    delete inputStyle.alignItems
    delete inputStyle.justifyContent
    return <TextBoxInput node={node} style={inputStyle} onInput={ctx.onInput} />
  }
  if (!text) return null
  const content = bool(node.props.RichText) && !placeholder ? richSpans(parseRichText(text), { scale: k }) : text
  return (
    <div className="uip-text" style={outer}>
      <div style={inner}>{content}</div>
    </div>
  )
}

function renderNode(ctx: Ctx, id: number, parent: { x: number; y: number }): ReactNode {
  const node = ctx.tree.get(id)
  const box = ctx.boxes.get(id)
  if (!node || !box || !isGuiObject(node.cls) || !isVisible(node)) return null
  const k = box.scale
  const style: CSSProperties = { left: px(box.x - parent.x), top: px(box.y - parent.y), width: px(box.w), height: px(box.h) }
  if (box.rotation) style.transform = `rotate(${box.rotation}deg)`
  const corner = hasCorner(ctx.tree, node)
  const radius = corner ? cornerRadius(corner.props, box, k) : 0
  if (radius) style.borderRadius = px(radius)
  const bgAlpha = backgroundAlpha(node)
  const base = color(node.props.BackgroundColor3, [0.64, 0.64, 0.64]) as RGB
  const grad = gradientOf(ctx.tree, node)
  const isButton = BUTTONS.has(node.cls)
  const auto = isButton && bool(node.props.AutoButtonColor, true)
  let shade = 1
  if (auto && ctx.mode === 'interact') shade = ctx.pressed === id ? 0.7 : ctx.hover.has(id) ? 0.85 : 1
  const shaded: RGB = [base[0] * shade, base[1] * shade, base[2] * shade]
  // A UIGradient under a CanvasGroup applies to the whole group (its transparency as a mask).
  const isCanvas = node.cls === 'CanvasGroup'
  const groupGradient = isCanvas && grad ? grad : null
  if (bgAlpha > 0) {
    if (grad && !groupGradient) style.backgroundImage = cssGradient(grad, shaded, bgAlpha)
    else style.backgroundColor = rgba(shaded, bgAlpha)
  }
  if (groupGradient) {
    const mask = `linear-gradient(${90 + groupGradient.rotation}deg, ${shadeStops(groupGradient, [1, 1, 1], 1)
      .map((s) => `rgba(0, 0, 0, ${s.alpha}) ${(s.t * 100).toFixed(2)}%`)
      .join(', ')})`
    style.WebkitMaskImage = mask
    style.maskImage = mask
  }
  // Legacy border: drawn outside the box (BorderMode Outline) unless the corner is rounded.
  const border = num(node.props.BorderSizePixel, 0)
  const shadows: string[] = []
  if (border > 0 && bgAlpha > 0 && !radius) {
    const mode = enumName(node.props.BorderMode, 'Outline')
    const bc = rgba(color(node.props.BorderColor3, [0.106, 0.165, 0.208]) as RGB, bgAlpha)
    shadows.push(mode === 'Inset' ? `inset 0 0 0 ${px(border)} ${bc}` : mode === 'Middle' ? `0 0 0 ${px(border / 2)} ${bc}, inset 0 0 0 ${px(border / 2)} ${bc}` : `0 0 0 ${px(border)} ${bc}`)
  }
  if (shadows.length) style.boxShadow = shadows.join(', ')
  const stroke = strokeOf(ctx.tree, node, k)
  const strokeEl =
    stroke?.target === 'border' ? (
      <div
        className="uip-stroke"
        style={{
          inset: px(-stroke.thickness),
          padding: px(stroke.thickness),
          borderRadius: radius ? px(radius + stroke.thickness) : stroke.join === 'Round' ? px(stroke.thickness) : undefined,
          background: stroke.gradient ? cssGradient(stroke.gradient, stroke.color, 1 - stroke.transparency) : rgba(stroke.color, 1 - stroke.transparency)
        }}
      />
    ) : null
  if (isCanvas) style.opacity = 1 - num(node.props.GroupTransparency)
  const clips = bool(node.props.ClipsDescendants) || isCanvas || node.cls === 'ScrollingFrame'
  const kids = box.draw.map((c) => renderNode(ctx, c, box))
  let scrollbar: ReactNode = null
  if (node.cls === 'ScrollingFrame' && box.canvas && bool(node.props.ScrollingEnabled, true)) {
    const thick = num(node.props.ScrollBarThickness, 12) * k
    const sa = 1 - num(node.props.ScrollBarImageTransparency, 0)
    const sc = rgba(color(node.props.ScrollBarImageColor3, [1, 1, 1]) as RGB, sa)
    if (box.canvas.h > box.h + 0.5 && thick > 0) {
      const len = (box.h / box.canvas.h) * box.h
      const top = (box.canvas.y / Math.max(1, box.canvas.h - box.h)) * (box.h - len)
      scrollbar = <div className="uip-scrollbar" style={{ right: 0, top: px(top), width: px(thick), height: px(len), background: sc }} />
    }
    if (box.canvas.w > box.w + 0.5 && thick > 0) {
      const len = (box.w / box.canvas.w) * box.w
      const left = (box.canvas.x / Math.max(1, box.canvas.w - box.w)) * (box.w - len)
      scrollbar = (
        <>
          {scrollbar}
          <div className="uip-scrollbar" style={{ bottom: 0, left: px(left), height: px(thick), width: px(len), background: sc }} />
        </>
      )
    }
  }
  return (
    <div key={id} className={`uip-node${isButton ? ' uip-btn' : ''}`} style={style} data-uid={id}>
      {strokeEl}
      {IMAGE_CLASSES.has(node.cls) ? imageLayer(ctx, node, box, radius) : null}
      {TEXT_CLASSES.has(node.cls) ? textLayer(ctx, node, box) : null}
      {clips ? (
        <div className="uip-clip" style={isCanvas && radius ? { borderRadius: px(radius) } : undefined}>
          {kids}
        </div>
      ) : (
        kids
      )}
      {scrollbar}
    </div>
  )
}

// Ids of preview elements under a client point, topmost first.
function idsAt(root: HTMLElement, x: number, y: number): number[] {
  const out: number[] = []
  for (const el of document.elementsFromPoint(x, y)) {
    if (!root.contains(el)) continue
    const uid = (el as HTMLElement).dataset?.uid
    if (uid) {
      const id = Number(uid)
      if (!out.includes(id)) out.push(id)
    }
  }
  return out
}

export const Stage = memo(function Stage(props: StageProps) {
  const { tree, version, width, height, images, mode, onInput, onHover, onSelect, selected, hovered } = props
  const rootRef = useRef<HTMLDivElement>(null)
  const [, bump] = useState(0)
  const [pressed, setPressed] = useState<number | null>(null)
  const [hoverSet, setHoverSet] = useState<Set<number>>(() => new Set())
  const lastRects = useRef<Map<number, string>>(new Map())

  useEffect(() => {
    const l = () => bump((n) => n + 1)
    naturalListeners.add(l)
    return () => {
      naturalListeners.delete(l)
    }
  }, [])

  const layout = useMemo(() => layoutTree(tree, { viewport: { w: width, h: height }, measure: props.measure ?? measureText }), [tree, version, width, height, props.fontsVersion, props.measure])

  useEffect(() => {
    props.onLayout?.(layout)
    if (!onInput || mode === 'static') return
    // AbsoluteSize / AbsolutePosition back to Lune (only what changed).
    const rects: Record<string, [number, number, number, number]> = {}
    let changed = 0
    for (const [id, b] of layout.boxes) {
      const r: [number, number, number, number] = [Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)]
      const key = r.join(',')
      if (lastRects.current.get(id) === key) continue
      lastRects.current.set(id, key)
      rects[id] = r
      changed++
    }
    if (changed) onInput({ type: 'layout', rects })
  }, [layout, onInput, mode])

  useEffect(() => {
    lastRects.current.clear()
  }, [width, height])

  const toStage = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const r = rootRef.current!.getBoundingClientRect()
      return { x: Math.round(((e.clientX - r.left) * width) / Math.max(1, r.width)), y: Math.round(((e.clientY - r.top) * height) / Math.max(1, r.height)) }
    },
    [width, height]
  )

  const isTarget = (id: number) => {
    const n = tree.get(id)
    return !n || (n.name === 'StoryTarget' && n.parent === tree.root)
  }

  // Roblox sinks clicks at the first Active object under the mouse; buttons are Active by default.
  const clickTarget = (ids: number[]): number | null => {
    for (const id of ids) {
      const n = tree.get(id)
      if (!n || isTarget(id)) continue
      const active = bool(n.props.Active, BUTTONS.has(n.cls) || n.cls === 'TextBox' || n.cls === 'ScrollingFrame')
      if (active) return BUTTONS.has(n.cls) ? id : null
    }
    return null
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!rootRef.current) return
    const ids = idsAt(rootRef.current, e.clientX, e.clientY).filter((id) => !isTarget(id))
    if (mode === 'edit') {
      onHover?.(ids[0] ?? null)
      return
    }
    if (mode !== 'interact' || !onInput) return
    const at = toStage(e)
    const next = new Set(ids)
    for (const id of hoverSet) if (!next.has(id)) onInput({ type: 'leave', id, ...at })
    for (const id of next) if (!hoverSet.has(id)) onInput({ type: 'enter', id, ...at })
    if (next.size !== hoverSet.size || [...next].some((id) => !hoverSet.has(id))) setHoverSet(next)
    onInput({ type: 'move', ...at })
    onHover?.(ids[0] ?? null)
  }

  const onPointerLeave = () => {
    onHover?.(null)
    if (mode !== 'interact' || !onInput) return
    for (const id of hoverSet) onInput({ type: 'leave', id })
    setHoverSet(new Set())
    setPressed(null)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!rootRef.current) return
    const ids = idsAt(rootRef.current, e.clientX, e.clientY).filter((id) => !isTarget(id))
    if (mode === 'edit') {
      e.preventDefault()
      onSelect?.(ids[0] ?? null)
      return
    }
    if (mode !== 'interact' || !onInput) return
    if ((e.target as HTMLElement).classList.contains('uip-textbox')) return
    rootRef.current.focus()
    const at = toStage(e)
    const target = clickTarget(ids)
    if (e.button === 2) {
      if (target != null) onInput({ type: 'rightclick', id: target, ...at })
      return
    }
    onInput({ type: 'down', ...(target != null ? { id: target } : {}), ...at })
    setPressed(target)
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if (mode !== 'interact' || !onInput || !rootRef.current || e.button === 2) return
    if ((e.target as HTMLElement).classList.contains('uip-textbox')) return
    const at = toStage(e)
    const ids = idsAt(rootRef.current, e.clientX, e.clientY).filter((id) => !isTarget(id))
    const target = clickTarget(ids)
    onInput({ type: 'up', ...(target != null ? { id: target } : {}), ...at })
    if (target != null && target === pressed) onInput({ type: 'click', id: target, ...at })
    setPressed(null)
  }

  const onWheel = (e: React.WheelEvent) => {
    if (mode !== 'interact' || !onInput || !rootRef.current) return
    for (const id of idsAt(rootRef.current, e.clientX, e.clientY)) {
      const n = tree.get(id)
      const b = layout.boxes.get(id)
      if (n?.cls !== 'ScrollingFrame' || !b?.canvas || !bool(n.props.ScrollingEnabled, true)) continue
      const maxX = Math.max(0, b.canvas.w - b.w)
      const maxY = Math.max(0, b.canvas.h - b.h)
      if (!maxX && !maxY) continue
      const x = Math.max(0, Math.min(maxX, b.canvas.x + (e.shiftKey ? e.deltaY : e.deltaX)))
      const y = Math.max(0, Math.min(maxY, b.canvas.y + (e.shiftKey ? 0 : e.deltaY)))
      onInput({ type: 'scroll', id, x, y })
      return
    }
  }

  const onKey = (down: boolean) => (e: React.KeyboardEvent) => {
    if (mode !== 'interact' || !onInput || e.repeat) return
    const key = robloxKey(e.code)
    if (!key) return
    e.preventDefault()
    onInput({ type: 'key', key, down })
  }

  const ctx: Ctx = { tree, boxes: layout.boxes, images, mode, ...(onInput ? { onInput } : {}), pressed, hover: hoverSet }
  const rootBox = layout.root != null ? layout.boxes.get(layout.root) : undefined
  const overlay = (id: number | null | undefined, kind: 'hover' | 'selected') => {
    if (id == null) return null
    const b = layout.boxes.get(id)
    const n = tree.get(id)
    if (!b || !n) return null
    return (
      <div className={`uip-mark uip-mark-${kind}`} style={{ left: px(b.x), top: px(b.y), width: px(b.w), height: px(b.h), transform: b.rotation ? `rotate(${b.rotation}deg)` : undefined }}>
        {kind === 'selected' || mode === 'edit' ? (
          <span className="uip-mark-label">
            {n.name} <em>{n.cls}</em> {Math.round(b.w)}×{Math.round(b.h)}
          </span>
        ) : null}
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className={`uip-stage uip-mode-${mode}`}
      style={{ width: px(width), height: px(height) }}
      tabIndex={mode === 'interact' ? 0 : -1}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      onKeyDown={onKey(true)}
      onKeyUp={onKey(false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {rootBox ? rootBox.draw.map((c) => renderNode(ctx, c, { x: 0, y: 0 })) : null}
      {mode !== 'static' ? (
        <>
          {hovered !== selected ? overlay(hovered, 'hover') : null}
          {overlay(selected, 'selected')}
        </>
      ) : null}
    </div>
  )
})
