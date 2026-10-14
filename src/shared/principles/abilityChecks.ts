// Code checks for an ability ("move"): the composer's timing rules (critique.ts timingChecks) grouped
// by the principle they serve (anticipation, weight and impact, follow-through, cohesion of the VFX
// with the animation, responsiveness), plus the VFX checks on the move's main effect when it is known.

import { anticipationStart, charged, releaseMarker, timingChecks, type CritiqueContext } from '../ability/critique.ts'
import type { Ability, TimingCheck } from '../ability/types.ts'
import type { VfxEffect } from '../vfx/types.ts'
import type { PrincipleCheck } from './types.ts'
import { vfxPrincipleChecks } from './vfxChecks.ts'

const r1 = (x: number) => Math.round(x * 10) / 10

export const RULE_PRINCIPLE: Record<string, string> = {
  anticipation: 'anticipation',
  'flash-on-release': 'weight-impact',
  'shake-on-release': 'weight-impact',
  'hitstop-on-release': 'weight-impact',
  'hitstop-length': 'weight-impact',
  'hitstop-depth': 'weight-impact',
  'vfx-release-sync': 'fx-cohesion',
  'release-marker': 'fx-cohesion',
  'follow-through': 'follow-through'
}

const FIXES: Record<string, string> = {
  anticipation: 'move the anticipation marker so the wind-up lasts 0.12-1.2 s before the release (longer only for charged moves)',
  'weight-impact': 'put the flash, camera shake and a 30-150 ms hit-stop on the release marker',
  'fx-cohesion': 'start the effect so its release stage lands on the animation\'s release marker ("Fix timings")',
  'follow-through': 'leave 0.25 s or more after the release for the recovery and the effect to dissipate'
}

export function abilityPrincipleChecks(ability: Ability, ctx: CritiqueContext = {}, opts: { checks?: TimingCheck[]; effect?: VfxEffect | null } = {}): PrincipleCheck[] {
  const checks = opts.checks ?? timingChecks(ability, ctx)
  const by = new Map<string, TimingCheck[]>()
  for (const c of checks) {
    const id = RULE_PRINCIPLE[c.rule]
    if (!id) continue
    by.set(id, [...(by.get(id) ?? []), c])
  }
  const out: PrincipleCheck[] = []
  for (const [id, list] of by) {
    let s = 10
    for (const c of list) if (!c.ok) s -= c.level === 'error' ? 4 : 2
    const bad = list.filter((c) => !c.ok)
    out.push({ id, score: r1(Math.max(0, s)), note: (bad.length ? bad : list).slice(0, 2).map((c) => c.message).join('; '), ...(bad.length && FIXES[id] ? { fix: FIXES[id] } : {}) })
  }
  const rel = releaseMarker(ability)
  if (rel) {
    const ant = anticipationStart(ability)
    const A = rel.t - ant.t
    const limit = charged(ability, ctx) ? 1.6 : 0.5
    const score = r1(Math.max(0, Math.min(10, 10 - Math.max(0, A - limit) * 6)))
    out.push({ id: 'responsiveness', score, note: `release ${A.toFixed(2)} s after the ${ant.label}${charged(ability, ctx) ? ' (charged move)' : ''}`, ...(score < 7 ? { fix: 'reach the release sooner: trim the wind-up or start the animation later in its anticipation' } : {}) })
  }
  if (opts.effect) for (const c of vfxPrincipleChecks(opts.effect)) if (!out.some((o) => o.id === c.id)) out.push(c)
  return out
}
