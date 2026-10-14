// Picking the principles that matter for a request, and the two prompt blocks built from them: the
// compose "principle plan" (a few planning questions the writer answers before the script, sized to a
// small token budget) and the critic's per-principle scoring section. The user's learned weights
// raise or lower how often a principle is picked and how strongly the critic weighs it.

import { principle, principlesFor } from './catalog.ts'
import type { AnimKind, Principle, PrincipleDomain, PrincipleLab, PrincipleWeights, RequestKind, VfxKind } from './types.ts'

export function animKind(text: string): AnimKind {
  const p = text.toLowerCase()
  if (/\bidle|breath|stance|loop(ed)?\b|standing/.test(p)) return 'idle'
  if (/\bwalk|run|sprint|jog|jump|dash|roll|climb|crouch walk|strafe/.test(p)) return 'locomotion'
  if (/\bhit react|stagger|knock(ed)? ?back|death|die|flinch|stun|get hit|hurt/.test(p)) return 'reaction'
  if (/\bwave|dance|emote|taunt|bow|cheer|celebrat|point|clap|salute/.test(p)) return 'emote'
  return 'attack'
}

export function vfxKind(text: string): VfxKind {
  const p = text.toLowerCase()
  if (/aura|ambient|buff|heal|shield|loop|idle|portal|field|rain|snow/.test(p)) return 'aura'
  if (/slash|sword|katana|blade|cut|swipe/.test(p)) return 'slash'
  if (/beam|laser|blast|projectile|fireball|bolt|shot|shoot|kamehameha|arrow|orb/.test(p)) return 'projectile'
  if (/charge|rasengan|spirit bomb|gather|channel/.test(p)) return 'charge'
  return 'burst'
}

export function requestKinds(lab: PrincipleLab, text: string): RequestKind[] {
  if (lab === 'anim') return [animKind(text)]
  if (lab === 'vfx') return [vfxKind(text)]
  if (lab === 'uimotion') return []
  return [animKind(text), vfxKind(text)]
}

const wOf = (weights: PrincipleWeights | undefined, id: string) => (weights && Number.isFinite(weights[id]) ? weights[id] : 1)

// Relevance of a principle for the request kinds (core: 1, otherwise 0.35; loops only matter for loops).
export function relevance(p: Principle, kinds: RequestKind[]): number {
  if (p.id === 'loopability') return kinds.includes('idle') || kinds.includes('locomotion') ? 1 : 0
  if (p.kinds === 'all') return 1
  return kinds.some((k) => (p.kinds as RequestKind[]).includes(k)) ? 1 : 0.35
}

// The principles for a request, most important first (relevance x base x the user's weight).
export function selectPrinciples(lab: PrincipleLab, text: string, opts: { weights?: PrincipleWeights; max?: number; planOnly?: boolean; looped?: boolean } = {}): Principle[] {
  const kinds = requestKinds(lab, text)
  if (opts.looped && !kinds.includes('idle')) kinds.push('idle')
  const domains: PrincipleDomain[] = lab === 'ability' ? ['anim', 'vfx'] : lab === 'uimotion' ? ['ui'] : [lab]
  const pool = domains.flatMap((d) => principlesFor(d)).filter((p) => !opts.planOnly || p.plan)
  // In the ability composer, effects follow the move: cohesion is always core there.
  const rel = (p: Principle) => (lab === 'ability' && p.id === 'fx-cohesion' ? 1.3 : relevance(p, kinds))
  const ranked = pool
    .map((p) => ({ p, s: rel(p) * p.base * wOf(opts.weights, p.id) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.p.id.localeCompare(b.p.id))
  return ranked.slice(0, opts.max ?? 8).map((x) => x.p)
}

// Rough token count (4 characters per token, the usual estimate for English prose).
export const estimateTokens = (text: string) => Math.ceil(text.length / 4)

export const PLAN_TOKEN_BUDGET = 170
export const CRITIC_TOKEN_BUDGET = 520

// The compose planning step: a few questions the writer answers in a "Plan" comment before the code
// (script labs) or a "plan" object (the ability composer's JSON). Trimmed to the token budget.
export function principlePlan(lab: PrincipleLab, text: string, opts: { weights?: PrincipleWeights; max?: number; looped?: boolean; budget?: number } = {}): string {
  const picked = selectPrinciples(lab, text, { weights: opts.weights, max: opts.max ?? (lab === 'ability' ? 5 : 4), planOnly: true, looped: opts.looped })
  const json = lab === 'ability' || lab === 'uimotion'
  const head = json
    ? 'Principle plan: add "plan":{"<id>":"a few words"} to your JSON answering:'
    : 'Principle plan: start the script with a "-- Plan:" comment, one short line per item, then write the code to match it:'
  const budget = opts.budget ?? PLAN_TOKEN_BUDGET
  const lines = [head]
  for (const p of picked) {
    const line = `- ${p.id}: ${p.plan}`
    if (estimateTokens([...lines, line].join('\n')) > budget) break
    lines.push(line)
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

// The plan the writer gave: "-- Plan:" comment lines in a script ("-- anticipation: ...").
export function parseScriptPlan(script: string): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = script.split('\n').slice(0, 30)
  const start = lines.findIndex((l) => /^\s*--\s*plan\s*:/i.test(l))
  if (start < 0) return out
  for (const l of lines.slice(start + 1)) {
    const m = /^\s*--\s*-?\s*([a-z][a-z-]{2,30})\s*:\s*(.+)$/i.exec(l)
    if (!m) break
    const id = m[1].toLowerCase()
    if (principle(id)) out[id] = m[2].trim().slice(0, 160)
  }
  return out
}

export function parsePlanObject(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!v || typeof v !== 'object') return out
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (principle(k) && typeof x === 'string') out[k] = x.trim().slice(0, 160)
  return out
}

// The critic's principle section: which principles to score (with the user's weight when it is not
// neutral and the code measurement when there is one), the JSON shape, and the focus for this round.
export function principleCriticBlock(ids: string[], opts: { weights?: PrincipleWeights; measured?: Record<string, { score: number; note: string }>; focus?: string[]; budget?: number } = {}): string {
  const budget = opts.budget ?? CRITIC_TOKEN_BUDGET
  const lines = ['Principles: also score each of these 0-10 with a concrete note (what you see, where) and a fix (what to change).']
  for (const id of ids) {
    const p = principle(id)
    if (!p) continue
    const w = wOf(opts.weights, id)
    const m = opts.measured?.[id]
    const line = `- ${id}${Math.abs(w - 1) >= 0.1 ? ` [user weight x${w.toFixed(1)}]` : ''}: ${p.rule}${m ? ` Measured: ${m.score.toFixed(1)} (${m.note})` : ''}`
    if (estimateTokens([...lines, line].join('\n')) > budget - 60) break
    lines.push(line)
  }
  lines.push('Add to your JSON: "principles":[{"id":"...","score":n,"note":"...","fix":"..."}] and tag each change with "principle":"<id>" (the one it raises). List changes for the lowest-scoring, highest-weight principles first.')
  if (opts.focus?.length) lines.push(`Focus this round on: ${opts.focus.join(', ')} (lowest last time).`)
  return lines.join('\n')
}
