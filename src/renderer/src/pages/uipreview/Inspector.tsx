// Inspector: path, class, rect and properties of the hovered or selected element. In Edit mode
// literal-typed properties are editable (written back to the source by the page); everything
// else offers "Ask AI to change this".
import { useEffect, useState } from 'react'
import type { UiNode, UiValue } from '@shared/types'
import type { Box } from '@shared/uiPreview/layout'
import { isTagged, luauLiteral, type PreviewTree } from '@shared/uiPreview/protocol'
import { hex } from '@shared/uiPreview/paint'
import { Icon } from '../../components/Icons'

const FIRST = ['Text', 'Size', 'Position', 'AnchorPoint', 'Visible', 'BackgroundColor3', 'BackgroundTransparency', 'TextColor3', 'TextTransparency', 'TextSize', 'TextScaled', 'TextWrapped', 'TextXAlignment', 'TextYAlignment', 'FontFace', 'Image', 'ImageColor3', 'ImageTransparency', 'ScaleType', 'Rotation', 'ZIndex', 'LayoutOrder', 'AutomaticSize', 'ClipsDescendants', 'Active', 'AutoButtonColor']
const HIDDEN = new Set(['Name', 'Parent', 'AbsoluteSize', 'AbsolutePosition', 'AbsoluteRotation'])

export const ENUM_ITEMS: Record<string, string[]> = {
  TextXAlignment: ['Left', 'Center', 'Right'],
  TextYAlignment: ['Top', 'Center', 'Bottom'],
  AutomaticSize: ['None', 'X', 'Y', 'XY'],
  ScaleType: ['Stretch', 'Slice', 'Tile', 'Fit', 'Crop'],
  TextTruncate: ['None', 'AtEnd', 'SplitWord'],
  FillDirection: ['Horizontal', 'Vertical'],
  HorizontalAlignment: ['Left', 'Center', 'Right'],
  VerticalAlignment: ['Top', 'Center', 'Bottom'],
  SortOrder: ['Name', 'Custom', 'LayoutOrder'],
  ApplyStrokeMode: ['Contextual', 'Border'],
  LineJoinMode: ['Round', 'Bevel', 'Miter'],
  BorderMode: ['Outline', 'Middle', 'Inset'],
  SizeConstraint: ['RelativeXY', 'RelativeXX', 'RelativeYY'],
  AspectType: ['FitWithinMaxSize', 'ScaleWithParentSize'],
  DominantAxis: ['Width', 'Height'],
  UIFlexMode: ['None', 'Grow', 'Shrink', 'Fill', 'Custom'],
  ZIndexBehavior: ['Global', 'Sibling']
}

const n3 = (x: number) => String(Math.round(x * 1000) / 1000)

export function formatValue(v: UiValue | undefined): string {
  if (v === undefined) return '—'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number') return n3(v)
  if (typeof v === 'boolean') return String(v)
  switch (v.t) {
    case 'UDim2':
      return `{${n3(v.v[0])}, ${n3(v.v[1])}}, {${n3(v.v[2])}, ${n3(v.v[3])}}`
    case 'UDim':
      return `${n3(v.v[0])}, ${n3(v.v[1])}`
    case 'Vector2':
      return `${n3(v.v[0])}, ${n3(v.v[1])}`
    case 'Vector3':
      return v.v.map(n3).join(', ')
    case 'Color3':
      return `${v.v.map((c) => Math.round(c * 255)).join(', ')}`
    case 'Enum':
      return v.v
    case 'Font':
      return `${v.family.split('/').pop()?.replace('.json', '')} ${v.weight}${v.style === 'Italic' ? ' Italic' : ''}`
    case 'ColorSequence':
      return `${v.v.length} keypoints`
    case 'NumberSequence':
      return v.v.map((k) => `${n3(k[0])}:${n3(k[1])}`).join(' ')
    case 'Rect':
      return v.v.map(n3).join(', ')
    case 'Instance':
      return `#${v.id}`
  }
  return JSON.stringify(v)
}

export const editable = (v: UiValue | undefined) => v !== undefined && luauLiteral(v) != null

function NumberBox({ value, onCommit, label }: { value: number; onCommit: (n: number) => void; label: string }) {
  const [text, setText] = useState(n3(value))
  useEffect(() => setText(n3(value)), [value])
  const commit = () => {
    const n = Number(text)
    if (Number.isFinite(n) && n !== value) onCommit(n)
    else setText(n3(value))
  }
  return <input className="input uip-num" aria-label={label} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
}

function TextBoxField({ value, onCommit, label }: { value: string; onCommit: (s: string) => void; label: string }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return <input className="input uip-str" aria-label={label} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onCommit(text)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
}

export function PropField({ prop, value, onCommit }: { prop: string; value: UiValue; onCommit: (v: UiValue) => void }) {
  if (typeof value === 'boolean') return <input type="checkbox" className="switch" checked={value} onChange={(e) => onCommit(e.target.checked)} aria-label={prop} />
  if (typeof value === 'number') return <NumberBox value={value} onCommit={onCommit} label={prop} />
  if (typeof value === 'string') return <TextBoxField value={value} onCommit={onCommit} label={prop} />
  if (isTagged(value, 'Color3'))
    return (
      <span className="uip-color">
        <input type="color" value={hex(value.v).toLowerCase()} aria-label={prop} onChange={(e) => {
          const m = /^#(..)(..)(..)$/.exec(e.target.value)
          if (m) onCommit({ t: 'Color3', v: [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] })
        }} />
        <span className="mono faint">{hex(value.v)}</span>
      </span>
    )
  if (isTagged(value, 'UDim2')) {
    const set = (i: number) => (n: number) => onCommit({ t: 'UDim2', v: value.v.map((x, j) => (j === i ? n : x)) as [number, number, number, number] })
    return (
      <span className="uip-vec">
        {['xs', 'xo', 'ys', 'yo'].map((l, i) => (
          <NumberBox key={l} value={value.v[i]} onCommit={set(i)} label={`${prop} ${l}`} />
        ))}
      </span>
    )
  }
  if (isTagged(value, 'UDim') || isTagged(value, 'Vector2')) {
    const set = (i: number) => (n: number) => onCommit({ ...value, v: value.v.map((x, j) => (j === i ? n : x)) as [number, number] })
    return (
      <span className="uip-vec">
        <NumberBox value={value.v[0]} onCommit={set(0)} label={`${prop} 1`} />
        <NumberBox value={value.v[1]} onCommit={set(1)} label={`${prop} 2`} />
      </span>
    )
  }
  if (isTagged(value, 'Enum')) {
    const items = ENUM_ITEMS[value.e]
    if (items)
      return (
        <select className="input" value={value.v} aria-label={prop} onChange={(e) => onCommit({ t: 'Enum', e: value.e, v: e.target.value })}>
          {items.map((i) => (
            <option key={i}>{i}</option>
          ))}
        </select>
      )
  }
  return <span className="mono">{formatValue(value)}</span>
}

export function orderedProps(node: UiNode): [string, UiValue][] {
  const keys = Object.keys(node.props).filter((k) => !HIDDEN.has(k))
  keys.sort((a, b) => {
    const ia = FIRST.indexOf(a)
    const ib = FIRST.indexOf(b)
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b)
  })
  return keys.map((k) => [k, node.props[k]])
}

export interface InspectorProps {
  tree: PreviewTree
  id: number | null
  box: Box | undefined
  pinned: boolean
  editMode: boolean
  busy: string | null
  // Bumped after every edit attempt so fields drop values that were not written.
  revision?: number
  onEdit: (node: UiNode, prop: string, value: UiValue) => void
  onJump: (node: UiNode) => void
  onAsk: (node: UiNode) => void
  onSelect: (id: number | null) => void
}

export function Inspector({ tree, id, box, pinned, editMode, busy, revision = 0, onEdit, onJump, onAsk, onSelect }: InspectorProps) {
  const node = id != null ? tree.get(id) : undefined
  if (!node)
    return (
      <div className="uip-insp-empty note">
        {editMode ? 'Click an element in the preview to select it. Literal properties are editable; edits rewrite the story source and hot-reload.' : 'Hover an element to inspect it. Switch to Edit to select and change it.'}
      </div>
    )
  const path = tree.relativePath(node.id)
  const modifiers = node.children.map((c) => tree.get(c)).filter((c): c is UiNode => !!c && c.cls.startsWith('UI'))
  const crumbs = path.split('.')
  return (
    <div className="uip-insp">
      <div className="uip-insp-head">
        <div className="uip-crumbs mono" title={path}>
          {crumbs.map((c, i) => (
            <span key={i}>
              {i > 0 && <span className="faint">.</span>}
              <span className={i === crumbs.length - 1 ? 'on' : ''}>{c}</span>
            </span>
          ))}
        </div>
        <div className="uip-insp-meta">
          <span className="badge-o">{node.cls}</span>
          {box && (
            <span className="mono faint">
              {Math.round(box.x)},{Math.round(box.y)} · {Math.round(box.w)}×{Math.round(box.h)}
              {box.rotation ? ` · ${box.rotation}°` : ''}
            </span>
          )}
          {pinned && (
            <button className="btn small ghost" onClick={() => onSelect(node.parent != null && tree.get(node.parent)?.name !== 'StoryTarget' ? node.parent : null)} title="Select parent">
              <Icon name="arrowUp" size={11} /> parent
            </button>
          )}
        </div>
        <div className="uip-insp-actions">
          <button className="btn small" onClick={() => onJump(node)} title="Open the code that creates this element">
            <Icon name="code" size={11} /> Jump to code
          </button>
          <button className="btn small ghost" onClick={() => onAsk(node)} title="Prefill the chat with this element">
            <Icon name="bot" size={11} /> Ask AI to change this
          </button>
        </div>
        {busy && (
          <div className="note">
            <span className="spinner" aria-hidden /> {busy}
          </div>
        )}
      </div>
      <PropTable key={`${node.id}:${revision}`} node={node} editMode={editMode && pinned} onEdit={onEdit} />
      {modifiers.map((m) => (
        <div key={m.id} className="uip-mod">
          <div className="set-sub">
            {m.cls}
            {m.name !== m.cls ? <span className="faint"> “{m.name}”</span> : null}
          </div>
          <PropTable key={`${m.id}:${revision}`} node={m} editMode={editMode && pinned} onEdit={onEdit} />
        </div>
      ))}
    </div>
  )
}

function PropTable({ node, editMode, onEdit }: { node: UiNode; editMode: boolean; onEdit: InspectorProps['onEdit'] }) {
  const rows = orderedProps(node)
  if (!rows.length) return <div className="note faint">defaults</div>
  return (
    <dl className="uip-props">
      {rows.map(([k, v]) => (
        <div key={k} className="uip-prop">
          <dt title={k}>{k}</dt>
          <dd>{editMode && editable(v) ? <PropField prop={k} value={v} onCommit={(nv) => onEdit(node, k, nv)} /> : <span className="mono">{formatValue(v)}</span>}</dd>
        </div>
      ))}
    </dl>
  )
}
