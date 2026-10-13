// UI Labs controls, generated from the story's `controls` table: String, Number, Boolean, Color3,
// Choose / EnumList, Slider and RGBA. Changes go to Lune as `control` inputs.
import type { UiControl } from '@shared/types'
import { isTagged, type Color3Value } from '@shared/uiPreview/protocol'
import { hex } from '@shared/uiPreview/paint'

const keyOf = (c: UiControl) => (c.group ? `${c.group}/${c.key}` : c.key)

function toColor(hexText: string): Color3Value | null {
  const m = /^#(..)(..)(..)$/.exec(hexText)
  return m ? { t: 'Color3', v: [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] } : null
}

function Control({ c, value, onChange }: { c: UiControl; value: unknown; onChange: (v: unknown) => void }) {
  switch (c.type) {
    case 'Boolean':
      return <input type="checkbox" className="switch" checked={!!value} onChange={(e) => onChange(e.target.checked)} aria-label={c.key} />
    case 'Number':
      return <input className="input uip-num" type="number" value={Number(value ?? 0)} step={c.step ?? 1} onChange={(e) => e.target.value !== '' && onChange(Number(e.target.value))} aria-label={c.key} />
    case 'Slider': {
      const n = Number(value ?? c.min ?? 0)
      return (
        <span className="uip-slider">
          <input type="range" min={c.min ?? 0} max={c.max ?? 1} step={c.step ?? 0.01} value={n} onChange={(e) => onChange(Number(e.target.value))} aria-label={c.key} />
          <span className="mono">{Math.round(n * 100) / 100}</span>
        </span>
      )
    }
    case 'Color3': {
      const v = isTagged(value as never, 'Color3') ? (value as Color3Value) : { t: 'Color3' as const, v: [1, 1, 1] as [number, number, number] }
      return (
        <span className="uip-color">
          <input type="color" value={hex(v.v).toLowerCase()} onChange={(e) => {
            const nv = toColor(e.target.value)
            if (nv) onChange(nv)
          }} aria-label={c.key} />
          <span className="mono faint">{hex(v.v)}</span>
        </span>
      )
    }
    case 'RGBA': {
      const v = (value ?? {}) as { color?: Color3Value; transparency?: number }
      const col = v.color && isTagged(v.color as never, 'Color3') ? v.color : { t: 'Color3' as const, v: [1, 1, 1] as [number, number, number] }
      return (
        <span className="uip-color">
          <input type="color" value={hex(col.v).toLowerCase()} onChange={(e) => {
            const nv = toColor(e.target.value)
            if (nv) onChange({ color: nv, transparency: v.transparency ?? 0 })
          }} aria-label={`${c.key} colour`} />
          <input type="range" min={0} max={1} step={0.01} value={v.transparency ?? 0} onChange={(e) => onChange({ color: col, transparency: Number(e.target.value) })} aria-label={`${c.key} transparency`} />
        </span>
      )
    }
    case 'Choose':
    case 'EnumList': {
      const options = c.options ?? []
      const index = c.type === 'Choose' ? Number(value ?? 1) - 1 : options.indexOf(String(value))
      return (
        <select className="input" value={Math.max(0, index)} onChange={(e) => onChange(c.type === 'Choose' ? Number(e.target.value) + 1 : options[Number(e.target.value)])} aria-label={c.key}>
          {options.map((o, i) => (
            <option key={i} value={i}>
              {o}
            </option>
          ))}
        </select>
      )
    }
    case 'String':
      return <input className="input uip-str" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} aria-label={c.key} />
    default:
      return <span className="note faint">{c.type} (edit in Studio)</span>
  }
}

export function ControlsPanel({ controls, values, onChange, onReset }: { controls: UiControl[]; values: Record<string, unknown>; onChange: (c: UiControl, v: unknown) => void; onReset: () => void }) {
  if (!controls.length) return <div className="note uip-insp-empty">This story has no controls. Add a <span className="mono">controls</span> table to the story to get knobs here.</div>
  const sorted = [...controls].sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key))
  let group: string | undefined
  return (
    <div className="uip-controls">
      {sorted.map((c) => {
        const head = c.group !== group ? ((group = c.group), c.group ? <div className="set-sub" key={`g:${c.group}`}>{c.group}</div> : null) : null
        return (
          <div key={keyOf(c)}>
            {head}
            <label className="uip-control">
              <span className="uip-control-key mono">{c.key}</span>
              <Control c={c} value={values[keyOf(c)]} onChange={(v) => onChange(c, v)} />
            </label>
          </div>
        )
      })}
      <button className="btn small ghost" onClick={onReset}>
        Reset controls
      </button>
    </div>
  )
}
