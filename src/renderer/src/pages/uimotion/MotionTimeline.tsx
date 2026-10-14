// The timeline of state transitions: a scripted appear -> hover -> press -> release -> leave run of
// the selected element through the shared engine (the same springs the Luau runs), drawn as state
// bands, the scale curve (with lift, glow and fade) and event markers, plus the measured response
// and overshoot the UI principles score.
import { useMemo, useState } from 'react'
import type { MotionSpec } from '@shared/types'
import { defaultScript, overshootAfter, responseTime, simulate } from '@shared/uimotion/engine'
import { usedKinds } from '@shared/uimotion/spec'

const W = 640
const H = 150
const TOP = 18
const PAD = 6

export function MotionTimeline({ spec, path, reduced, onReplay }: { spec: MotionSpec; path: string; reduced: boolean; onReplay?: () => void }) {
  const tl = useMemo(() => simulate(spec, path, defaultScript(usedKinds(spec)), { dt: 1 / 120, reduced }), [spec, path, reduced])
  const [at, setAt] = useState<number | null>(null)
  const x = (t: number) => PAD + (t / tl.duration) * (W - PAD * 2)
  const scales = tl.samples.map((s) => s.values.scale * s.values.sy)
  const lo = Math.min(0.85, ...scales)
  const hi = Math.max(1.15, ...scales)
  const y = (v: number) => TOP + 8 + (1 - (v - lo) / (hi - lo)) * (H - TOP - 22)
  const line = (f: (i: number) => number) => tl.samples.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)},${f(i).toFixed(1)}`).join('')
  const maxLift = Math.max(1, ...tl.samples.map((s) => Math.abs(s.values.dy)))
  const hasGlow = tl.samples.some((s) => s.values.glow > 0.01)
  const hasFade = tl.samples.some((s) => s.values.alpha < 0.99)
  const hasLift = tl.samples.some((s) => Math.abs(s.values.dy) > 0.2)
  const hover = responseTime(tl, 'enter')
  const press = responseTime(tl, 'down')
  const over = overshootAfter(tl, 'up')
  const ms = (v: number | null) => (v == null ? '—' : `${Math.round(v * 1000)} ms`)
  const sample = at == null ? null : tl.samples[Math.min(tl.samples.length - 1, Math.max(0, Math.round(at / tl.dt)))]
  return (
    <div className="um-tl">
      <div className="row um-tl-head">
        <span className="mono faint">timeline</span>
        <span className="um-metric mono" title="Time to half of the hover response (UI principle: feedback within 100 ms)">
          hover <b className={hover != null && hover > 0.1 ? 'warn' : ''}>{ms(hover)}</b>
        </span>
        <span className="um-metric mono" title="Time to half of the press response">
          press <b className={press != null && press > 0.1 ? 'warn' : ''}>{ms(press)}</b>
        </span>
        <span className="um-metric mono" title="Overshoot after release, as a share of the move">
          release overshoot <b className={over > 0.3 ? 'warn' : ''}>{Math.round(over * 100)}%</b>
        </span>
        <span className="grow" />
        {sample && (
          <span className="mono faint um-readout">
            {sample.t.toFixed(2)}s · ×{(sample.values.scale * sample.values.sy).toFixed(3)}
            {hasLift ? ` · y ${sample.values.dy.toFixed(1)}px` : ''}
            {hasGlow ? ` · glow ${sample.values.glow.toFixed(2)}` : ''}
          </span>
        )}
        {onReplay && (
          <button className="btn small" onClick={onReplay} title="Play this sequence in the live preview">
            replay in preview
          </button>
        )}
      </div>
      <svg
        className="um-tl-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Timeline: hover response ${ms(hover)}, press response ${ms(press)}, release overshoot ${Math.round(over * 100)}%`}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setAt(Math.max(0, Math.min(tl.duration, ((e.clientX - r.left) / r.width) * tl.duration)))
        }}
        onPointerLeave={() => setAt(null)}
      >
        {tl.states.map((s, i) => (
          <g key={i}>
            <rect className={`um-band ${s.state}`} x={x(s.from)} y={2} width={Math.max(0, x(s.to) - x(s.from))} height={12} />
            {x(s.to) - x(s.from) > 34 && (
              <text className="um-band-t" x={x(s.from) + 4} y={11}>
                {s.state}
              </text>
            )}
          </g>
        ))}
        <line className="um-rest" x1={PAD} x2={W - PAD} y1={y(1)} y2={y(1)} />
        <text className="um-axis" x={W - PAD - 2} y={y(1) - 3} textAnchor="end">
          ×1
        </text>
        {tl.events.map((e, i) => (
          <g key={i}>
            <line className="um-ev" x1={x(e.at)} x2={x(e.at)} y1={TOP} y2={H - 4} />
            <text className="um-ev-t" x={x(e.at) + 3} y={H - 6}>
              {e.label ?? e.kind}
            </text>
          </g>
        ))}
        {hasFade && <path className="um-c-fade" d={line((i) => y(lo + (hi - lo) * tl.samples[i].values.alpha))} />}
        {hasGlow && <path className="um-c-glow" d={line((i) => y(lo + (hi - lo) * Math.min(1, tl.samples[i].values.glow) * 0.5))} />}
        {hasLift && <path className="um-c-lift" d={line((i) => y(1 + (-tl.samples[i].values.dy / maxLift) * (hi - 1) * 0.6))} />}
        <path className="um-c-scale" d={line((i) => y(scales[i]))} />
        {sample && <line className="um-head" x1={x(sample.t)} x2={x(sample.t)} y1={TOP} y2={H - 4} />}
      </svg>
      <div className="um-legend mono faint">
        <span className="k scale">scale</span>
        {hasLift && <span className="k lift">lift</span>}
        {hasGlow && <span className="k glow">glow</span>}
        {hasFade && <span className="k fade">opacity</span>}
        {reduced && <span>· reduced motion</span>}
      </div>
    </div>
  )
}
