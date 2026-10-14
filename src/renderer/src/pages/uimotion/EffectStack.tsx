// The effect stack of one element: its effects as cards with sliders (frequency / damping springs,
// amounts, colours, triggers) and the library to add more from. Edits go straight into the spec,
// which the live preview and the timeline follow.
import { useState } from 'react'
import type { EffectKind, MotionEffect, MotionSpec } from '@shared/types'
import { EFFECT_KINDS, EFFECT_LIBRARY, defaultEffect, normalizeEffect, type EffectParam } from '@shared/uimotion/spec'
import { riseTime, springOvershoot } from '@shared/uimotion/spring'
import { Icon } from '../../components/Icons'

const GROUPS: { key: 'feedback' | 'accent' | 'ambient' | 'transition'; label: string }[] = [
  { key: 'feedback', label: 'feedback' },
  { key: 'accent', label: 'accent' },
  { key: 'ambient', label: 'ambient' },
  { key: 'transition', label: 'transition' }
]

const hex = (c: number[]) => `#${c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('')}`
const fromHex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)

function SpringNote({ e }: { e: MotionEffect }) {
  if (!('frequency' in e)) return null
  const half = riseTime({ frequency: e.frequency, damping: e.damping })
  const over = springOvershoot(e.damping)
  return (
    <span className={`um-spring mono${half > 0.1 ? ' slow' : ''}`} title="Half-response time and first overshoot of this spring (step response)">
      {Math.round(half * 1000)} ms · {over > 0.005 ? `${Math.round(over * 100)}% over` : 'no overshoot'}
    </span>
  )
}

function Param({ p, value, onChange }: { p: EffectParam; value: unknown; onChange: (v: unknown) => void }) {
  if ('options' in p)
    return (
      <label className="um-param">
        <span>{p.label}</span>
        <span className="seg um-seg">
          {p.options.map((o) => (
            <button key={o} type="button" className={value === o ? 'on' : ''} aria-pressed={value === o} onClick={() => onChange(o)}>
              {o}
            </button>
          ))}
        </span>
      </label>
    )
  if ('color' in p)
    return (
      <label className="um-param">
        <span>{p.label}</span>
        <input type="color" className="um-color" value={hex(value as number[])} onChange={(e) => onChange(fromHex(e.target.value))} aria-label={p.label} />
      </label>
    )
  const v = Number(value)
  return (
    <label className="um-param">
      <span>{p.label}</span>
      <input type="range" min={p.min} max={p.max} step={p.step} value={v} onChange={(e) => onChange(Number(e.target.value))} aria-label={p.label} />
      <input
        className="input um-num mono"
        type="number"
        min={p.min}
        max={p.max}
        step={p.step}
        value={v}
        onChange={(e) => e.target.value !== '' && onChange(Number(e.target.value))}
        aria-label={`${p.label} value`}
      />
      <span className="faint mono um-unit">{p.unit ?? ''}</span>
    </label>
  )
}

export function EffectStack({ spec, path, elements, onPath, onChange }: { spec: MotionSpec; path: string; elements: { path: string; className: string }[]; onPath: (p: string) => void; onChange: (spec: MotionSpec) => void }) {
  const [adding, setAdding] = useState(false)
  const target = spec.targets.find((t) => t.path === path)
  const effects = target?.effects ?? []
  const used = new Set(effects.map((e) => e.kind))
  const setEffects = (next: MotionEffect[]) => {
    const others = spec.targets.filter((t) => t.path !== path)
    onChange({ ...spec, targets: next.length || path === '' ? [...(path === '' ? [{ path, effects: next }] : []), ...others, ...(path !== '' ? [{ path, effects: next }] : [])] : others })
  }
  const edit = (kind: EffectKind, key: string, v: unknown) => {
    const cur = effects.find((e) => e.kind === kind)
    const n = normalizeEffect({ ...cur, [key]: v })
    if (n) setEffects(effects.map((e) => (e.kind === kind ? n : e)))
  }
  const add = (kind: EffectKind) => {
    setEffects([...effects.filter((e) => e.kind !== kind), defaultEffect(kind)])
    setAdding(false)
  }
  const elementsWithFx = new Set(spec.targets.filter((t) => t.effects.length).map((t) => t.path))
  return (
    <div className="um-stack">
      <div className="row um-target">
        <span className="faint mono">element</span>
        <select className="input grow" value={path} onChange={(e) => onPath(e.target.value)} aria-label="Element">
          {[{ path: '', className: 'root' }, ...elements.filter((e) => e.path)].map((e) => (
            <option key={e.path} value={e.path}>
              {e.path || '(root)'} · {e.className}
              {elementsWithFx.has(e.path) ? ' ●' : ''}
            </option>
          ))}
        </select>
        <button className={`btn small${adding ? ' on' : ''}`} onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
          <Icon name="plus" size={11} /> Effect
        </button>
      </div>
      {adding && (
        <div className="um-lib" role="menu" aria-label="Effect library">
          {GROUPS.map((g) => (
            <div key={g.key} className="um-lib-group">
              <span className="faint mono um-lib-h">{g.label}</span>
              {EFFECT_KINDS.filter((k) => EFFECT_LIBRARY[k].group === g.key).map((k) => (
                <button key={k} role="menuitem" className="um-lib-item" disabled={used.has(k)} onClick={() => add(k)} title={`${EFFECT_LIBRARY[k].does} (${EFFECT_LIBRARY[k].drives})`}>
                  <b className="mono">{EFFECT_LIBRARY[k].label}</b>
                  <span className="faint">{EFFECT_LIBRARY[k].does}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      {!effects.length && <p className="note um-none">No effects on {path || 'the root'} yet. Add one, or describe the feel above.</p>}
      {effects.map((e) => {
        const info = EFFECT_LIBRARY[e.kind]
        return (
          <section key={e.kind} className={`um-fx g-${info.group}`} aria-label={info.label}>
            <div className="um-fx-head">
              <i className="um-dot" aria-hidden />
              <b className="mono">{info.label}</b>
              <span className="faint um-drives">{info.drives}</span>
              <span className="grow" />
              <SpringNote e={e} />
              <button className="btn small ghost" onClick={() => setEffects(effects.filter((x) => x.kind !== e.kind))} aria-label={`Remove ${info.label}`}>
                <Icon name="x" size={11} />
              </button>
            </div>
            <div className="um-params">
              {info.params.map((p) => (
                <Param key={p.key} p={p} value={(e as unknown as Record<string, unknown>)[p.key]} onChange={(v) => edit(e.kind, p.key, v)} />
              ))}
            </div>
          </section>
        )
      })}
      <label className="row um-reduced">
        <span className="faint mono">reduced motion</span>
        <span className="seg um-seg">
          {(['respect', 'ignore'] as const).map((r) => (
            <button key={r} type="button" className={spec.reducedMotion === r ? 'on' : ''} aria-pressed={spec.reducedMotion === r} onClick={() => onChange({ ...spec, reducedMotion: r })}>
              {r}
            </button>
          ))}
        </span>
        <span className="note">GuiService.ReducedMotionEnabled drops float, tilt, idle shine, ripples, pops and overshoot.</span>
      </label>
    </div>
  )
}
