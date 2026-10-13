// Parameter editor: one layer at a time, every Roblox property the Lab knows (schema.ts), with
// sequence editors for NumberSequence / ColorSequence and the layer's timeline (Emit bursts).
// Edits return a new effect; the page previews it live and saves it (which writes back to the
// effect's Luau module and .rbxmx).
import { useMemo, useState } from 'react'
import type { ColorKey, NumKey, PropValue, VfxCue, VfxEffect, VfxMotion, VfxNode } from '@shared/types'
import { ENUMS, SCHEMA, type PropSpec } from '@shared/vfx/schema'
import { evalNumberSequence, fromHex, hex } from '@shared/vfx/sequence'
import { nodeRole } from '@shared/vfx/analyze'
import { editProp } from '@shared/vfx/spec'
import { Icon } from '../../components/Icons'
import { TexturePicker } from './TexturePicker'

const LAYER = new Set(['ParticleEmitter', 'Beam', 'Trail', 'PointLight', 'SpotLight', 'SurfaceLight', 'Highlight', 'Part', 'MeshPart', 'SpecialMesh', 'Attachment'])
const MOTIONS: VfxMotion[] = ['static', 'swing', 'orbit', 'dash', 'rise']

function layers(effect: VfxEffect): VfxNode[] {
  const out: VfxNode[] = []
  const walk = (n: VfxNode) => {
    if (LAYER.has(n.className) && (n.className !== 'Attachment' || n.children.length === 0) && n.className !== 'Part' && n.className !== 'Attachment') out.push(n)
    // Scripted effects: the visible kit parts (orb spheres, shockwave shells) are layers too.
    else if (n.kit === 'rig' && n.className === 'Part' && Number(n.props.Transparency ?? 0) < 1) out.push(n)
    n.children.forEach(walk)
  }
  effect.roots.forEach(walk)
  return out
}

// A cue as one line for the read-only timeline of scripted layers.
function cueText(c: VfxCue): string {
  if (c.action === 'emit') return `Emit ${c.count ?? 16}`
  if (c.action === 'tween' || c.action === 'set') {
    const goals = Object.entries(c.props ?? {}).map(([k, v]) => `${k} ${typeof v === 'number' ? Math.round(v * 100) / 100 : Array.isArray(v) && v.length <= 3 ? `[${(v as number[]).map((x) => Math.round(Number(x) * 100) / 100).join(', ')}]` : '…'}`).join(', ')
    return c.action === 'set' ? `set ${goals}` : `tween ${goals} · ${c.duration ?? 0}s ${c.style ?? 'Quad'} ${c.direction ?? 'Out'}`
  }
  return c.action
}

const num = (v: string, fallback: number) => {
  const x = Number(v)
  return Number.isFinite(x) ? x : fallback
}

function NumberField({ value, spec, onChange, label }: { value: number; spec: PropSpec; onChange: (v: number) => void; label: string }) {
  return (
    <span className="vfx-num">
      {spec.min !== undefined && spec.max !== undefined && spec.max - spec.min <= 1000 && (
        <input type="range" min={spec.min} max={spec.max} step={spec.step ?? 0.01} value={value} onChange={(e) => onChange(num(e.target.value, value))} aria-label={`${label} slider`} />
      )}
      <input className="input mono" type="number" step={spec.step ?? (spec.kind === 'int' ? 1 : 0.05)} value={Math.round(value * 1000) / 1000} onChange={(e) => onChange(num(e.target.value, value))} aria-label={label} />
    </span>
  )
}

function Curve({ seq, min, max }: { seq: NumKey[]; min: number; max: number }) {
  const W = 220
  const H = 46
  const lo = Math.min(min, ...seq.map((k) => k.v - (k.e ?? 0)))
  // 0-1 properties (Transparency) keep their full range; open-ended ones (Size) scale to the curve.
  const top = Math.max(...seq.map((k) => k.v + (k.e ?? 0)))
  const hi = max <= 1 && max > min ? Math.max(max, top) : Math.max(top * 1.1, lo + 0.1)
  const y = (v: number) => H - 4 - ((v - lo) / (hi - lo || 1)) * (H - 8)
  const pts = Array.from({ length: 41 }, (_, i) => i / 40)
  const line = pts.map((t) => `${(t * W).toFixed(1)},${y(evalNumberSequence(seq, t)).toFixed(1)}`).join(' ')
  const upper = seq.map((k) => `${(k.t * W).toFixed(1)},${y(k.v + (k.e ?? 0)).toFixed(1)}`)
  const lower = [...seq].reverse().map((k) => `${(k.t * W).toFixed(1)},${y(k.v - (k.e ?? 0)).toFixed(1)}`)
  return (
    <svg className="vfx-curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      {seq.some((k) => k.e) && <polygon points={[...upper, ...lower].join(' ')} className="env" />}
      <polyline points={line} className="ln" />
      {seq.map((k, i) => (
        <circle key={i} cx={k.t * W} cy={y(k.v)} r={2.4} className="pt" />
      ))}
    </svg>
  )
}

function NumSeqField({ value, spec, onChange, label }: { value: NumKey[]; spec: PropSpec; onChange: (v: NumKey[]) => void; label: string }) {
  const set = (i: number, patch: Partial<NumKey>) => onChange(normalize(value.map((k, j) => (j === i ? { ...k, ...patch } : k))))
  return (
    <div className="vfx-seq">
      <Curve seq={value} min={spec.min ?? 0} max={spec.max ?? 1} />
      {value.map((k, i) => (
        <div key={i} className="vfx-key">
          <span className="faint mono">t</span>
          <input className="input mono" type="number" step={0.05} min={0} max={1} value={k.t} disabled={i === 0 || i === value.length - 1} onChange={(e) => set(i, { t: num(e.target.value, k.t) })} aria-label={`${label} key ${i + 1} time`} />
          <span className="faint mono">v</span>
          <input className="input mono" type="number" step={0.05} value={k.v} onChange={(e) => set(i, { v: num(e.target.value, k.v) })} aria-label={`${label} key ${i + 1} value`} />
          <span className="faint mono">±</span>
          <input className="input mono" type="number" step={0.05} min={0} value={k.e ?? 0} onChange={(e) => set(i, { e: Math.max(0, num(e.target.value, 0)) || undefined })} aria-label={`${label} key ${i + 1} envelope`} />
          <button className="btn ghost small" disabled={value.length <= 2 || i === 0 || i === value.length - 1} onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove ${label} key ${i + 1}`}>
            <Icon name="x" size={10} />
          </button>
        </div>
      ))}
      <button className="btn ghost small" disabled={value.length >= 20} onClick={() => onChange(addKey(value))}>
        <Icon name="plus" size={10} /> key
      </button>
    </div>
  )
}

function addKey(seq: NumKey[]): NumKey[] {
  // Split the widest gap.
  let gi = 0
  let gw = 0
  for (let i = 1; i < seq.length; i++) if (seq[i].t - seq[i - 1].t > gw) (gw = seq[i].t - seq[i - 1].t), (gi = i)
  const t = Math.round(((seq[gi - 1]?.t ?? 0) + gw / 2) * 1000) / 1000
  return normalize([...seq, { t, v: Math.round(evalNumberSequence(seq, t) * 1000) / 1000 }])
}

function normalize<T extends { t: number }>(keys: T[]): T[] {
  return [...keys].sort((a, b) => a.t - b.t).map((k, i, a) => ({ ...k, t: i === 0 ? 0 : i === a.length - 1 ? 1 : Math.min(1, Math.max(0, k.t)) }))
}

function ColorSeqField({ value, onChange, label }: { value: ColorKey[]; onChange: (v: ColorKey[]) => void; label: string }) {
  const grad = `linear-gradient(90deg, ${value.map((k) => `${hex(k.c)} ${Math.round(k.t * 100)}%`).join(', ')})`
  const set = (i: number, patch: Partial<ColorKey>) => onChange(normalize(value.map((k, j) => (j === i ? { ...k, ...patch } : k))))
  return (
    <div className="vfx-seq">
      <div className="vfx-grad" style={{ background: grad }} aria-hidden />
      {value.map((k, i) => (
        <div key={i} className="vfx-key">
          <span className="faint mono">t</span>
          <input className="input mono" type="number" step={0.05} min={0} max={1} value={k.t} disabled={i === 0 || i === value.length - 1} onChange={(e) => set(i, { t: num(e.target.value, k.t) })} aria-label={`${label} stop ${i + 1} time`} />
          <input type="color" className="vfx-color" value={hex(k.c)} onChange={(e) => set(i, { c: fromHex(e.target.value) })} aria-label={`${label} stop ${i + 1} colour`} />
          <span className="mono faint">{hex(k.c)}</span>
          <button className="btn ghost small" disabled={value.length <= 2 || i === 0 || i === value.length - 1} onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove ${label} stop ${i + 1}`}>
            <Icon name="x" size={10} />
          </button>
        </div>
      ))}
      <button
        className="btn ghost small"
        disabled={value.length >= 20}
        onClick={() => {
          const t = 0.5
          const mid = value.find((k) => k.t >= t) ?? value[value.length - 1]
          onChange(normalize([...value, { t, c: [...mid.c] as ColorKey['c'] }]))
        }}
      >
        <Icon name="plus" size={10} /> stop
      </button>
    </div>
  )
}

function Field({ name, spec, value, onChange }: { name: string; spec: PropSpec; value: PropValue | undefined; onChange: (v: PropValue) => void }) {
  const v = value ?? spec.default
  const k = spec.kind
  if (k === 'number' || k === 'int') return <NumberField value={Number(v ?? 0)} spec={spec} onChange={onChange} label={name} />
  if (k === 'bool') return <input type="checkbox" className="switch" checked={v === true} onChange={(e) => onChange(e.target.checked)} aria-label={name} />
  if (k === 'content' || k === 'string')
    return <input className="input mono vfx-text" value={String(v ?? '')} onChange={(e) => onChange(e.target.value)} placeholder="rbxassetid://… or art/…png" spellCheck={false} aria-label={name} />
  if (k.startsWith('enum:'))
    return (
      <select className="input" value={String(v ?? '')} onChange={(e) => onChange(e.target.value)} aria-label={name}>
        {Object.keys(ENUMS[k.slice(5)] ?? {}).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  if (k === 'vec2' || k === 'vec3' || k === 'range') {
    const arr = (Array.isArray(v) ? v : []) as number[]
    const n = k === 'vec3' ? 3 : 2
    const labels = k === 'range' ? ['min', 'max'] : ['x', 'y', 'z']
    return (
      <span className="vfx-vec">
        {Array.from({ length: n }, (_, i) => (
          <label key={i}>
            <span className="faint mono">{labels[i]}</span>
            <input
              className="input mono"
              type="number"
              step={spec.step ?? 0.1}
              value={Math.round((arr[i] ?? 0) * 1000) / 1000}
              onChange={(e) => {
                const next = [...arr]
                next[i] = num(e.target.value, arr[i] ?? 0)
                onChange(k === 'range' ? [Math.min(next[0], next[1]), Math.max(next[0], next[1])] : next)
              }}
              aria-label={`${name} ${labels[i]}`}
            />
          </label>
        ))}
      </span>
    )
  }
  if (k === 'color3') return <input type="color" className="vfx-color" value={hex((v as [number, number, number]) ?? [1, 1, 1])} onChange={(e) => onChange(fromHex(e.target.value))} aria-label={name} />
  if (k === 'nseq') return <NumSeqField value={(v as NumKey[]) ?? []} spec={spec} onChange={onChange} label={name} />
  if (k === 'cseq') return <ColorSeqField value={(v as ColorKey[]) ?? []} onChange={onChange} label={name} />
  return <span className="note">{JSON.stringify(v)}</span>
}

export function ParamEditor({ effect, onChange }: { effect: VfxEffect; onChange: (next: VfxEffect) => void }) {
  const list = useMemo(() => layers(effect), [effect])
  const [sel, setSel] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const node = list.find((n) => n.id === sel) ?? list[0] ?? null
  const schema = node ? SCHEMA[node.className] ?? {} : {}
  // Flipbook properties join the main list once the layer uses a flipbook.
  const flipbook = !!node && typeof node.props.FlipbookLayout === 'string' && node.props.FlipbookLayout !== 'None'
  const entries = Object.entries(schema).filter(([name, s]) => s.kind !== 'ref' && s.kind !== 'cframe' && (advanced || s.main || (flipbook && /^Flipbook(Layout|Mode|Framerate|StartRandom)$/.test(name))))
  const cues = node ? effect.cues.filter((c) => c.target === node.id) : []
  const scripted = !!effect.script
  const setCues = (next: VfxCue[]) => onChange({ ...effect, cues: [...effect.cues.filter((c) => c.target !== node!.id), ...next].sort((a, b) => a.at - b.at) })

  return (
    <div className="vfx-params">
      <div className="vfx-effect-row">
        <label>
          <span className="faint">duration</span>
          <input className="input mono" type="number" min={0.2} max={10} step={0.1} value={Math.round(effect.duration * 100) / 100} disabled={scripted} title={scripted ? 'Set by the timeline script (fx:duration, or the last cue)' : undefined} onChange={(e) => onChange({ ...effect, duration: Math.max(0.2, Math.min(10, num(e.target.value, effect.duration))) })} aria-label="Effect duration" />
        </label>
        <label>
          <span className="faint">motion</span>
          <select className="input" value={effect.motion ?? 'static'} disabled={scripted} title={scripted ? 'The timeline script moves the rigs itself' : undefined} onChange={(e) => onChange({ ...effect, motion: e.target.value as VfxMotion })} aria-label="Preview motion">
            {MOTIONS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className="vfx-adv">
          <input type="checkbox" className="switch" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} /> <span className="faint">all properties</span>
        </label>
      </div>
      <div className="vfx-layers" role="tablist" aria-label="Layers">
        {list.map((n) => (
          <button key={n.id} role="tab" aria-selected={node?.id === n.id} className={`badge-o${node?.id === n.id ? ' hot' : ''}`} onClick={() => setSel(n.id)} title={n.className}>
            {n.name} <span className="faint">{nodeRole(n)}</span>
          </button>
        ))}
      </div>
      {!node && <div className="note">This effect has no editable layers.</div>}
      {node && (
        <div className="vfx-props">
          {entries.map(([name, spec]) => (
            <div key={name} className={`vfx-prop${spec.kind === 'nseq' || spec.kind === 'cseq' || name === 'Texture' ? ' wide' : ''}`}>
              <span className="vfx-prop-name mono">{name}</span>
              {name === 'Texture' && (node.className === 'ParticleEmitter' || node.className === 'Beam' || node.className === 'Trail') ? (
                <TexturePicker
                  value={String(node.props.Texture ?? spec.default ?? '')}
                  className={node.className}
                  onChange={(v) => onChange(editProp(effect, node.id, name, v))}
                  onPick={(ref, fb) => {
                    let next = editProp(effect, node.id, 'Texture', ref)
                    // A flipbook texture brings its layout (OneShot plays the sheet once per particle).
                    if (fb && (!node.props.FlipbookLayout || node.props.FlipbookLayout === 'None')) next = editProp(editProp(next, node.id, 'FlipbookLayout', fb.layout), node.id, 'FlipbookMode', 'OneShot')
                    onChange(next)
                  }}
                />
              ) : (
                <Field name={name} spec={spec} value={node.props[name]} onChange={(v) => onChange(editProp(effect, node.id, name, v))} />
              )}
            </div>
          ))}
          {scripted && (
            <div className="vfx-prop wide">
              <span className="vfx-prop-name mono">Timeline</span>
              <div className="vfx-seq">
                {cues.length === 0 && <span className="note">No cues on this layer; its rig's cues apply.</span>}
                {cues.map((c, i) => (
                  <div key={i} className="vfx-cue-ro mono">
                    <span className="faint">{c.at.toFixed(2)}s</span> {cueText(c)}
                  </div>
                ))}
                <span className="note">Cues come from the timeline script (Script tab). Property edits here are kept when the script runs again.</span>
              </div>
            </div>
          )}
          {!scripted && (node.className === 'ParticleEmitter' || cues.length > 0) && (
            <div className="vfx-prop wide">
              <span className="vfx-prop-name mono">Timeline</span>
              <div className="vfx-seq">
                {cues.map((c, i) => (
                  <div key={i} className="vfx-key">
                    <select className="input" value={c.action} onChange={(e) => setCues(cues.map((x, j) => (j === i ? { ...x, action: e.target.value as VfxCue['action'] } : x)))} aria-label={`Cue ${i + 1} action`}>
                      {node.className === 'ParticleEmitter' && <option value="emit">Emit</option>}
                      <option value="enable">enable</option>
                      <option value="disable">disable</option>
                    </select>
                    <span className="faint mono">at</span>
                    <input className="input mono" type="number" step={0.05} min={0} value={c.at} onChange={(e) => setCues(cues.map((x, j) => (j === i ? { ...x, at: Math.max(0, num(e.target.value, x.at)) } : x)))} aria-label={`Cue ${i + 1} time`} />
                    {c.action === 'emit' && (
                      <>
                        <span className="faint mono">n</span>
                        <input className="input mono" type="number" step={1} min={1} value={c.count ?? 16} onChange={(e) => setCues(cues.map((x, j) => (j === i ? { ...x, count: Math.max(1, Math.round(num(e.target.value, x.count ?? 16))) } : x)))} aria-label={`Cue ${i + 1} count`} />
                      </>
                    )}
                    <button className="btn ghost small" onClick={() => setCues(cues.filter((_, j) => j !== i))} aria-label={`Remove cue ${i + 1}`}>
                      <Icon name="x" size={10} />
                    </button>
                  </div>
                ))}
                <button className="btn ghost small" onClick={() => setCues([...cues, { at: 0, target: node.id, action: node.className === 'ParticleEmitter' ? 'emit' : 'enable', count: 16 }])}>
                  <Icon name="plus" size={10} /> cue
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
