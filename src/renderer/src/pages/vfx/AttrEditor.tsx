// ForgeVFX attributes of the selected layer (docs/vfx-emit.md): EmitDelay / EmitDuration /
// EmitCount / Rate / FadeOut on the layer or one of its containers, and the mesh-effect attributes
// (Lifetime, Ease, SpreadAngle, Min/MaxInitRot, Spin, SyncPosition) on a Start/End Model. Values
// set here are what ForgeVFX.emit reads in game; the preview re-times from the plan (emitPlan.ts).
import { useMemo, useState } from 'react'
import type { VfxEffect, VfxNode } from '@shared/types'
import type { VfxAttrValue } from '@shared/vfx/types'
import { editAttr } from '@shared/vfx/analyze'
import { attrBool, attrNumber, attrRange, attrVec, EASING_DIRECTIONS, EASING_STYLES, emitPlan, layerKind, meshEffectParts, planLength, type EmitPlan } from '@shared/vfx/emitPlan'
import { Icon } from '../../components/Icons'

const EASES = EASING_STYLES.flatMap((s) => EASING_DIRECTIONS.map((d) => `${s}.${d}`))
const EASE_PROPS: [string, string][] = [
  ['EaseCFrame', 'path'],
  ['EaseSize', 'size'],
  ['EaseTransparency', 'fade'],
  ['EaseColor', 'colour']
]

// The node and its ancestors (nearest first).
function chainOf(roots: VfxNode[], id: string): VfxNode[] {
  const path: VfxNode[] = []
  const find = (n: VfxNode): boolean => {
    path.push(n)
    if (n.id === id || n.children.some(find)) return true
    path.pop()
    return false
  }
  roots.some(find)
  return path.reverse()
}

const fmt = (x: number) => String(Math.round(x * 1000) / 1000)

function Clear({ show, onClick, label }: { show: boolean; onClick: () => void; label: string }) {
  return show ? (
    <button className="btn ghost small" onClick={onClick} aria-label={`Clear ${label}`} title="Remove the attribute (inherit)">
      <Icon name="x" size={10} />
    </button>
  ) : null
}

function NumAttr({ name, own, hint, step = 0.05, min = 0, onSet }: { name: string; own: VfxAttrValue | undefined; hint?: string; step?: number; min?: number; onSet: (v: VfxAttrValue | undefined) => void }) {
  const v = attrNumber(own)
  return (
    <div className="vfx-prop">
      <span className="vfx-prop-name mono">{name}</span>
      <span className="vfx-num">
        <input className="input mono" type="number" min={min} step={step} value={v ?? ''} placeholder={hint ?? ''} onChange={(e) => onSet(e.target.value === '' ? undefined : Math.max(min, Number(e.target.value) || 0))} aria-label={name} />
        <Clear show={own !== undefined} onClick={() => onSet(undefined)} label={name} />
      </span>
    </div>
  )
}

function VecAttr({ name, own, size, labels, onSet }: { name: string; own: VfxAttrValue | undefined; size: 2 | 3; labels: string[]; onSet: (v: VfxAttrValue | undefined) => void }) {
  const arr = (name === 'Lifetime' ? attrRange(own) : attrVec(own, size)) ?? []
  return (
    <div className="vfx-prop">
      <span className="vfx-prop-name mono">{name}</span>
      <span className="vfx-vec">
        {labels.map((l, i) => (
          <label key={l}>
            <span className="faint mono">{l}</span>
            <input
              className="input mono"
              type="number"
              step={name === 'Lifetime' ? 0.05 : 5}
              value={arr[i] ?? ''}
              placeholder="0"
              onChange={(e) => {
                const next = Array.from({ length: size }, (_, k) => (k === i ? Number(e.target.value) || 0 : arr[k] ?? (name === 'Lifetime' ? Number(e.target.value) || 0 : 0)))
                onSet(name === 'Lifetime' ? [Math.max(0, Math.min(next[0], next[1])), Math.max(0, next[0], next[1])] : next)
              }}
              aria-label={`${name} ${l}`}
            />
          </label>
        ))}
        <Clear show={own !== undefined} onClick={() => onSet(undefined)} label={name} />
      </span>
    </div>
  )
}

function EaseAttr({ name, label, own, fallback, onSet }: { name: string; label?: string; own: VfxAttrValue | undefined; fallback: string; onSet: (v: VfxAttrValue | undefined) => void }) {
  const curve = Array.isArray(own)
  const value = typeof own === 'string' ? own : ''
  return (
    <div className="vfx-prop">
      <span className="vfx-prop-name mono" title={name}>
        {label ?? name}
      </span>
      <span className="vfx-num">
        <select className="input" value={curve ? '#curve' : value} onChange={(e) => onSet(e.target.value === '' ? undefined : e.target.value)} aria-label={name}>
          <option value="">{`(${fallback})`}</option>
          {curve && <option value="#curve">custom curve</option>}
          {EASES.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </span>
    </div>
  )
}

// One line on what the plan does with the selected layer / mesh effect.
function planLine(plan: EmitPlan, node: VfxNode): string {
  const m = plan.meshEffects.find((x) => x.id === node.id)
  if (m) {
    const lives = m.copies.map((c) => c.life)
    const lo = lives.length ? Math.min(...lives) : 0
    const hi = lives.length ? Math.max(...lives) : 0
    const first = m.copies[0]?.spawn ?? 0
    const last = m.copies[m.copies.length - 1]?.spawn ?? 0
    return `${m.copies.length} cop${m.copies.length === 1 ? 'y' : 'ies'} from ${fmt(first)}s${last > first ? ` to ${fmt(last)}s` : ''}, each ${fmt(lo)}${hi > lo ? `–${fmt(hi)}` : ''}s · plays ${fmt(planLength(plan))}s`
  }
  const l = plan.layers.find((x) => x.id === node.id)
  if (!l) return plan.driven ? `Not timed by attributes · effect plays ${fmt(planLength(plan))}s` : 'No ForgeVFX attributes yet: this layer plays as authored.'
  const bits: string[] = []
  const emits = l.bursts.reduce((s, b) => s + b.count, 0)
  if (emits) bits.push(`Emit ${emits} from ${fmt(l.bursts[0].at)}s`)
  for (const w of l.windows) bits.push(`on ${fmt(w[0])}–${fmt(w[1])}s`)
  if (l.fade) bits.push(`fades ${fmt(l.fade[0])}–${fmt(l.fade[1])}s`)
  return `${bits.join(' · ') || 'never on'} · effect plays ${fmt(planLength(plan))}s`
}

export function AttrEditor({ effect, node, onChange }: { effect: VfxEffect; node: VfxNode; onChange: (next: VfxEffect) => void }) {
  const chain = useMemo(() => chainOf(effect.roots, node.id), [effect.roots, node.id])
  const plan = useMemo(() => emitPlan(effect.roots), [effect.roots])
  const [targetId, setTargetId] = useState<string | null>(null)
  const target = chain.find((n) => n.id === targetId) ?? chain[0] ?? node
  const own = target.attrs ?? {}
  const set = (key: string) => (v: VfxAttrValue | undefined) => onChange(editAttr(effect, target.id, key, v))
  const kind = layerKind(node.className)
  const isMesh = !!meshEffectParts(target)
  const container = target.id !== node.id || !kind
  const scripted = !!effect.script
  // What the target inherits (for placeholders): the nearest ancestor value.
  const inherited = (key: string): string | undefined => {
    const up = chain.slice(chain.indexOf(target) + 1)
    if (key === 'EmitDelay') {
      const sum = up.reduce((s, n) => s + (attrNumber(n.attrs?.EmitDelay) ?? 0), 0)
      return sum ? `+${fmt(sum)}` : undefined
    }
    for (const n of up) {
      const v = attrNumber(n.attrs?.[key])
      if (v !== undefined) return fmt(v)
    }
    return undefined
  }
  const fallbackEase = typeof own.Ease === 'string' && own.Ease ? own.Ease : 'Quad.Out'
  const showFade = isMesh ? false : container || kind !== 'emitter'

  return (
    <div className="vfx-prop wide vfx-attrs">
      <span className="vfx-prop-name mono" title="Instance attributes ForgeVFX.emit reads (docs/vfx-emit.md)">
        Attributes
      </span>
      <div className="vfx-seq">
        <div className="vfx-key">
          <span className="faint">on</span>
          <select className="input" value={target.id} onChange={(e) => setTargetId(e.target.value)} aria-label="Attribute target" disabled={scripted}>
            {chain.map((n, i) => (
              <option key={n.id} value={n.id}>
                {i === 0 ? n.name : `${'↑'.repeat(Math.min(i, 3))} ${n.name}`} ({meshEffectParts(n) ? 'mesh effect' : n.className})
              </option>
            ))}
          </select>
          <span className="note vfx-attr-plan">{planLine(plan, isMesh ? target : node)}</span>
        </div>
        {scripted ? (
          <span className="note">Scripted effects are timed by their script; attributes apply to imported and hand-built effects.</span>
        ) : (
          <div className="vfx-props">
            <NumAttr name="EmitDelay" own={own.EmitDelay} hint={inherited('EmitDelay') ?? '0'} onSet={set('EmitDelay')} />
            <NumAttr name="EmitDuration" own={own.EmitDuration} hint={inherited('EmitDuration') ?? '–'} onSet={set('EmitDuration')} />
            {(container || kind === 'emitter') && <NumAttr name="EmitCount" own={own.EmitCount} hint={inherited('EmitCount') ?? (isMesh ? '1' : '–')} step={1} onSet={set('EmitCount')} />}
            {(isMesh || container) && <NumAttr name="Rate" own={own.Rate} hint={inherited('Rate') ?? '0'} step={1} onSet={set('Rate')} />}
            {showFade && <NumAttr name="FadeOut" own={own.FadeOut} hint={inherited('FadeOut') ?? '–'} onSet={set('FadeOut')} />}
            {isMesh && (
              <>
                <VecAttr name="Lifetime" own={own.Lifetime} size={2} labels={['min', 'max']} onSet={set('Lifetime')} />
                <EaseAttr name="Ease" own={own.Ease} fallback="Quad.Out" onSet={set('Ease')} />
                {EASE_PROPS.map(([k, label]) => (
                  <EaseAttr key={k} name={k} label={`Ease ${label}`} own={own[k]} fallback={fallbackEase} onSet={set(k)} />
                ))}
                <VecAttr name="SpreadAngle" own={own.SpreadAngle} size={2} labels={['x', 'y']} onSet={set('SpreadAngle')} />
                <VecAttr name="MinInitRot" own={own.MinInitRot} size={3} labels={['x', 'y', 'z']} onSet={set('MinInitRot')} />
                <VecAttr name="MaxInitRot" own={own.MaxInitRot} size={3} labels={['x', 'y', 'z']} onSet={set('MaxInitRot')} />
                <VecAttr name="Spin" own={own.Spin} size={3} labels={['x', 'y', 'z']} onSet={set('Spin')} />
                <div className="vfx-prop">
                  <span className="vfx-prop-name mono" title="Copies keep following the origin while alive">
                    SyncPosition
                  </span>
                  <input type="checkbox" className="switch" checked={attrBool(own.SyncPosition) === true} onChange={(e) => set('SyncPosition')(e.target.checked ? true : undefined)} aria-label="SyncPosition" />
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
