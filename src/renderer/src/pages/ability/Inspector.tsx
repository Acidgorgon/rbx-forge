// Edit panel of the Ability Composer: the animation (clip, start, speed, fade, published asset id), the
// move's name and length, "add event" buttons, and the selected event's fields. Every change goes
// through the shared model (applyPatch normalises and clamps), then up to the page, which saves it.
import { useEffect, useState } from 'react'
import { releaseMarker } from '@shared/ability/critique'
import { applyPatch, defaultEvent, removeEvent, upsertEvent } from '@shared/ability/model'
import { placeholderClips } from '@shared/ability/placeholder'
import { attachmentsFor, partsFor } from '@shared/ability/rig'
import { markerTimes, round } from '@shared/ability/timing'
import { EVENT_KINDS, type Ability, type AbilityRig, type AbilityEvent, type EventKind, type ScreenKind, type TimeRef } from '@shared/ability/types'
import type { AnimClipRef } from '@shared/anim/types'
import type { VfxEntry } from '@shared/types'
import { Icon } from '../../components/Icons'
import { KIND_LABEL } from './AbilityTimeline'

const STYLES = ['Linear', 'Sine', 'Quad', 'Cubic', 'Quart', 'Quint', 'Exponential', 'Circular', 'Back', 'Bounce', 'Elastic']

function Num({ label, value, onChange, step = 0.01, min, max, title }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; title?: string }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const v = Number(text)
    if (Number.isFinite(v) && v !== value) onChange(v)
    else setText(String(value))
  }
  return (
    <label className="ab-field" title={title}>
      <span>{label}</span>
      <input className="input mono" type="number" step={step} min={min} max={max} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    </label>
  )
}

function Vec({ label, value, onChange, step = 0.1 }: { label: string; value: number[]; onChange: (v: [number, number, number]) => void; step?: number }) {
  return (
    <div className="ab-field ab-vec">
      <span>{label}</span>
      <div>
        {[0, 1, 2].map((i) => (
          <input
            key={`${i}:${value[i]}`}
            className="input mono"
            type="number"
            step={step}
            defaultValue={value[i]}
            aria-label={`${label} ${'xyz'[i]}`}
            onBlur={(e) => {
              const v = Number(e.target.value)
              if (!Number.isFinite(v) || v === value[i]) return
              const next = [...value] as [number, number, number]
              next[i] = v
              onChange(next)
            }}
          />
        ))}
      </div>
    </div>
  )
}

function Pick<T extends string>({ label, value, options, onChange, labels }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void; labels?: Record<string, string> }) {
  return (
    <label className="ab-field">
      <span>{label}</span>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {labels?.[o] ?? o}
          </option>
        ))}
      </select>
    </label>
  )
}

function Color({ label, value, onChange }: { label: string; value: number[]; onChange: (v: [number, number, number]) => void }) {
  const hex = `#${value.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('')}`
  return (
    <label className="ab-field">
      <span>{label}</span>
      <input
        className="vfx-color"
        type="color"
        value={hex}
        onChange={(e) => {
          const h = e.target.value
          onChange([1, 3, 5].map((i) => round(parseInt(h.slice(i, i + 2), 16) / 255)) as [number, number, number])
        }}
      />
    </label>
  )
}

// Marker-relative or absolute start.
function When({ ability, at, onChange }: { ability: Ability; at: TimeRef; onChange: (r: TimeRef) => void }) {
  const markers = markerTimes(ability)
  return (
    <div className="ab-when">
      <label className="ab-field">
        <span>at</span>
        <select className="input" value={at.marker ?? ''} onChange={(e) => onChange(e.target.value ? { marker: e.target.value, at: 0 } : { at: round((markers.find((m) => m.name === at.marker)?.t ?? 0) + at.at) })}>
          <option value="">absolute</option>
          {markers.map((m) => (
            <option key={m.name} value={m.name}>
              marker {m.name}
            </option>
          ))}
        </select>
      </label>
      <Num label={at.marker ? 'offset s' : 'seconds'} value={at.at} step={1 / 60} onChange={(v) => onChange({ ...at, at: round(v) })} />
    </div>
  )
}

export function Inspector({ ability, selected, t, vfxEntries, onChange, onSelect }: { ability: Ability; selected: string | null; t: number; vfxEntries: VfxEntry[]; onChange: (a: Ability) => void; onSelect: (id: string | null) => void }) {
  const h = window.harness
  const [clips, setClips] = useState<AnimClipRef[]>(placeholderClips())
  useEffect(() => {
    let live = true
    const api = h as unknown as { listAnimClips?: () => Promise<AnimClipRef[]> }
    void Promise.resolve(api.listAnimClips?.())
      .then((lab) => live && setClips([...(lab ?? []), ...placeholderClips()]))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  const ev = ability.events.find((e) => e.id === selected) ?? null
  const patch = (fields: Record<string, unknown>) => onChange(applyPatch(ability, { events: [{ id: ev!.id, ...fields }] }))
  const anim = ability.animation

  const setClip = (id: string) => {
    if (!id) return onChange({ ...ability, animation: null })
    const c = clips.find((x) => x.id === id)
    if (!c) return
    onChange(applyPatch(ability, { ability: { animation: { clip: c.id, name: c.name, duration: c.duration, looped: c.looped, markers: c.markers, speed: anim?.speed ?? 1, start: anim?.start ?? 0, fadeIn: anim?.fadeIn ?? 0.1, ...(anim?.clip === c.id && anim.assetId ? { assetId: anim.assetId } : {}), rig: c.rig === 'R6' ? 'R6' : 'R15' } } }))
  }
  const setAnim = (fields: Record<string, unknown>) => onChange(applyPatch(ability, { ability: { animation: fields } }))

  const add = (kind: EventKind) => {
    const rel = releaseMarker(ability)
    const at: TimeRef = rel ? { marker: rel.name, at: 0 } : { at: round(t) }
    const extra: Record<string, unknown> = {}
    if (kind === 'vfx') {
      const fx = vfxEntries.find((e) => e.effect)
      if (!fx) return
      Object.assign(extra, { effect: fx.id, effectName: fx.effect!.name, duration: fx.effect!.duration, part: 'RightHand', attachment: 'RightGripAttachment' })
    }
    if (kind === 'sound') extra.source = { kind: 'asset', id: '' }
    const e = defaultEvent(ability, kind, at, extra)
    onChange(upsertEvent(ability, e))
    onSelect(e.id)
  }
  const importSound = async () => {
    const [path] = await h.abilityChooseSounds()
    if (path) patch({ source: { kind: 'file', path, name: path.split(/[\\/]/).pop() } })
  }
  const vfxOptions = vfxEntries.filter((e) => e.effect)

  return (
    <div className="ab-inspect">
      <div className="ab-sec">
        <div className="ab-sec-head mono">
          <i className="ab-k anim">anim</i> animation
        </div>
        <div className="ab-fields">
          <label className="ab-field wide">
            <span>clip</span>
            <select className="input" value={anim?.clip ?? ''} onChange={(e) => setClip(e.target.value)}>
              <option value="">none</option>
              {clips.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.duration.toFixed(2)}s{c.rig === 'R6' ? ' · R6' : ''}{c.id.startsWith('placeholder:') ? ' · placeholder' : ''}
                </option>
              ))}
            </select>
          </label>
          {anim && (
            <>
              <Num label="start s" value={anim.start} min={0} onChange={(v) => setAnim({ start: Math.max(0, round(v)) })} />
              <Num label="speed" value={anim.speed} step={0.05} min={0.05} onChange={(v) => setAnim({ speed: v })} title="AnimationTrack:Play speed; markers move with it" />
              <Num label="fade in s" value={anim.fadeIn} min={0} onChange={(v) => setAnim({ fadeIn: v })} />
              <label className="ab-field wide" title="The published animation's asset id; the runner skips the animation without it">
                <span>asset id</span>
                <input className="input mono" defaultValue={anim.assetId ?? ''} key={anim.clip} placeholder="rbxassetid://…" onBlur={(e) => e.target.value !== (anim.assetId ?? '') && setAnim({ assetId: e.target.value.trim() })} />
              </label>
            </>
          )}
          <Num label="length s" value={ability.duration} min={0.1} max={30} onChange={(v) => onChange(applyPatch(ability, { ability: { duration: v } }))} />
        </div>
        {anim && anim.markers.length > 0 && (
          <div className="ab-markers mono">
            {markerTimes(ability).map((m) => (
              <span key={m.name}>
                {m.name} <span className="faint">{m.t.toFixed(2)}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="ab-add" role="group" aria-label="Add event">
        <span className="faint mono">add</span>
        {EVENT_KINDS.map((k) => (
          <button key={k} className="badge-o" onClick={() => add(k)} disabled={k === 'vfx' && !vfxOptions.length} title={k === 'vfx' && !vfxOptions.length ? 'The VFX Lab library has no effects yet' : `Add a ${KIND_LABEL[k]} event on the release marker`}>
            <Icon name="plus" size={10} /> {KIND_LABEL[k]}
          </button>
        ))}
      </div>

      {!ev && <div className="note ab-hint">Select a row in the timeline to edit it. Drag bars to retime (they snap to markers; hold Alt to drag freely).</div>}
      {ev && (
        <div className="ab-sec">
          <div className="ab-sec-head mono">
            <i className={`ab-k ${ev.kind}`}>{KIND_LABEL[ev.kind]}</i> {ev.id}
            <span className="grow" />
            <label className="ab-mute">
              <input type="checkbox" checked={!!ev.muted} onChange={(e) => patch({ muted: e.target.checked })} /> mute
            </label>
            <button className="btn small ghost danger" onClick={() => (onChange(removeEvent(ability, ev.id)), onSelect(null))} aria-label={`Delete ${ev.id}`} title="Delete event">
              <Icon name="trash" size={11} />
            </button>
          </div>
          <div className="ab-fields">
            <label className="ab-field wide">
              <span>label</span>
              <input className="input" defaultValue={ev.label ?? ''} key={`${ev.id}-label`} onBlur={(e) => e.target.value !== (ev.label ?? '') && patch({ label: e.target.value })} />
            </label>
            <When ability={ability} at={ev.at} onChange={(at) => patch({ at })} />
            <EventFields ev={ev} vfxOptions={vfxOptions} patch={patch} importSound={importSound} rig={anim?.rig ?? 'R15'} />
          </div>
        </div>
      )}
    </div>
  )
}

// Part and attachment choices follow the clip's rig (R6: Torso, "Right Arm"...); a part named for the
// other rig stays listed so it is not silently changed (it plays on the matching part).
function EventFields({ ev, vfxOptions, patch, importSound, rig }: { ev: AbilityEvent; vfxOptions: VfxEntry[]; patch: (f: Record<string, unknown>) => void; importSound: () => void; rig: AbilityRig }) {
  const attachments = ['', ...Object.keys(attachmentsFor(rig))]
  const evPart = 'part' in ev ? ev.part : undefined
  const parts: string[] = [...partsFor(rig), ...(evPart && !partsFor(rig).includes(evPart) ? [evPart] : [])]
  switch (ev.kind) {
    case 'vfx':
      return (
        <>
          <label className="ab-field wide">
            <span>effect</span>
            <select
              className="input"
              value={ev.effect}
              onChange={(e) => {
                const fx = vfxOptions.find((x) => x.id === e.target.value)
                if (fx) patch({ effect: fx.id, effectName: fx.written?.module.replace(/\/init\.luau$/, '').split('/').pop() ?? fx.effect!.name, duration: fx.effect!.duration })
              }}
            >
              {!vfxOptions.some((x) => x.id === ev.effect) && <option value={ev.effect}>{ev.effectName} (missing)</option>}
              {vfxOptions.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} · {x.effect!.duration.toFixed(2)}s
                </option>
              ))}
            </select>
          </label>
          <Pick label="part" value={ev.part} options={parts} onChange={(part) => patch({ part, attachment: undefined })} />
          <Pick label="attachment" value={ev.attachment ?? ''} options={attachments} labels={{ '': '(part centre)' }} onChange={(attachment) => patch(attachment ? { attachment } : { attachment: undefined, part: ev.part })} />
          <Vec label="offset" value={ev.offset} onChange={(offset) => patch({ offset })} />
          <Vec label="rotation°" value={ev.rotation} step={5} onChange={(rotation) => patch({ rotation })} />
        </>
      )
    case 'sound':
      return (
        <>
          <label className="ab-field wide" title="Roblox audio asset id">
            <span>sound</span>
            <span className="ab-sound">
              <input className="input mono" defaultValue={ev.source.kind === 'asset' ? ev.source.id : ''} key={`${ev.id}-src-${ev.source.kind}`} placeholder={ev.source.kind === 'file' ? `${ev.source.name} (local: upload it)` : 'rbxassetid://…'} onBlur={(e) => e.target.value.trim() && patch({ source: { kind: 'asset', id: e.target.value.trim() } })} />
              <button className="btn small" onClick={importSound} title="Use a local file for the preview (upload it to Roblox for the game)">
                <Icon name="upload" size={11} /> file
              </button>
            </span>
          </label>
          <Num label="volume" value={ev.volume} step={0.05} min={0} max={10} onChange={(volume) => patch({ volume })} />
          <Num label="pitch" value={ev.pitch} step={0.05} min={0.05} max={4} onChange={(pitch) => patch({ pitch })} />
          <Pick label="from" value={ev.part ?? ''} options={['', ...parts]} labels={{ '': '2D (no part)' }} onChange={(part) => patch({ part: part || undefined })} />
        </>
      )
    case 'shake':
      return (
        <>
          <Num label="duration s" value={ev.duration} onChange={(duration) => patch({ duration })} />
          <Num label="amplitude" value={ev.amplitude} step={0.05} min={0} onChange={(amplitude) => patch({ amplitude })} title="Studs of camera offset at the peak" />
          <Num label="frequency" value={ev.frequency} step={1} min={0.1} onChange={(frequency) => patch({ frequency })} title="Oscillations per second" />
          <Pick label="falloff" value={ev.falloff} options={['none', 'linear', 'exponential'] as const} onChange={(falloff) => patch({ falloff })} />
        </>
      )
    case 'screen':
      return (
        <>
          <Pick label="effect" value={ev.effect} options={['flash', 'colorCorrection', 'bloom', 'blur'] as ScreenKind[]} onChange={(effect) => patch({ effect, values: {} })} />
          <Num label="attack s" value={ev.attack} onChange={(attack) => patch({ attack })} />
          <Num label="hold s" value={ev.hold} onChange={(hold) => patch({ hold })} />
          <Num label="release s" value={ev.release} onChange={(release) => patch({ release })} />
          <Pick label="easing" value={ev.style} options={STYLES} onChange={(style) => patch({ style })} />
          {ev.effect === 'flash' && (
            <>
              <Color label="color" value={ev.values.color ?? [1, 1, 1]} onChange={(color) => patch({ values: { ...ev.values, color } })} />
              <Num label="opacity" value={ev.values.opacity ?? 0.8} step={0.05} min={0} max={1} onChange={(opacity) => patch({ values: { ...ev.values, opacity } })} />
            </>
          )}
          {ev.effect === 'colorCorrection' && (
            <>
              <Num label="brightness" value={ev.values.brightness ?? 0} step={0.05} onChange={(brightness) => patch({ values: { ...ev.values, brightness } })} />
              <Num label="contrast" value={ev.values.contrast ?? 0} step={0.05} onChange={(contrast) => patch({ values: { ...ev.values, contrast } })} />
              <Num label="saturation" value={ev.values.saturation ?? 0} step={0.05} onChange={(saturation) => patch({ values: { ...ev.values, saturation } })} />
              <Color label="tint" value={ev.values.tint ?? [1, 1, 1]} onChange={(tint) => patch({ values: { ...ev.values, tint } })} />
            </>
          )}
          {ev.effect === 'bloom' && (
            <>
              <Num label="intensity" value={ev.values.intensity ?? 1} step={0.1} onChange={(intensity) => patch({ values: { ...ev.values, intensity } })} />
              <Num label="size" value={ev.values.size ?? 24} step={1} onChange={(size) => patch({ values: { ...ev.values, size } })} />
              <Num label="threshold" value={ev.values.threshold ?? 0.8} step={0.05} onChange={(threshold) => patch({ values: { ...ev.values, threshold } })} />
            </>
          )}
          {ev.effect === 'blur' && <Num label="size" value={ev.values.size ?? 12} step={1} onChange={(size) => patch({ values: { ...ev.values, size } })} />}
        </>
      )
    case 'hitstop':
      return (
        <>
          <Num label="duration s" value={ev.duration} step={0.005} onChange={(duration) => patch({ duration })} title="Real seconds the slow-down lasts" />
          <Num label="time scale" value={ev.timeScale} step={0.01} min={0.001} max={1} onChange={(timeScale) => patch({ timeScale })} title="How fast the move runs during the hit-stop (0.05 = nearly frozen)" />
        </>
      )
    case 'move':
      return (
        <>
          <Vec label="velocity" value={ev.velocity} step={1} onChange={(velocity) => patch({ velocity })} />
          <Num label="duration s" value={ev.duration} onChange={(duration) => patch({ duration })} />
          <Pick label="easing" value={ev.easing} options={['constant', 'decay'] as const} onChange={(easing) => patch({ easing })} />
        </>
      )
  }
}
