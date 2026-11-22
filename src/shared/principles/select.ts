// Picking the principles that matter for a request, and the prompt blocks built from them.
import { principle, principlesFor } from './catalog.ts'
import type { Principle, PrincipleLab, PrincipleWeights, RequestKind } from './types.ts'

export function requestKinds(_lab: PrincipleLab, _text: string): RequestKind[] {
  return []
}

const wOf = (weights: PrincipleWeights | undefined, id: string) => (weights && Number.isFinite(weights[id]) ? weights[id] : 1)

export function relevance(p: Principle, kinds: RequestKind[]): number {
  if (p.kinds === 'all') return 1
  return kinds.some((k) => (p.kinds as RequestKind[]).includes(k)) ? 1 : 0.35
}

export function selectPrinciples(_lab: PrincipleLab, text: string, opts: { weights?: PrincipleWeights; max?: number; planOnly?: boolean; looped?: boolean } = {}): Principle[] {
  const kinds = requestKinds('uimotion', text)
  const pool = principlesFor('ui').filter((p) => !opts.planOnly || p.plan)
  const ranked = pool
    .map((p) => ({ p, s: relevance(p, kinds) * p.base * wOf(opts.weights, p.id) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.p.id.localeCompare(b.p.id))
  return ranked.slice(0, opts.max ?? 8).map((x) => x.p)
}

export const estimateTokens = (text: string) => Math.ceil(text.length / 4)

export const PLAN_TOKEN_BUDGET = 170
export const CRITIC_TOKEN_BUDGET = 520

export function principlePlan(lab: PrincipleLab, text: string, opts: { weights?: PrincipleWeights; max?: number; looped?: boolean; budget?: number } = {}): string {
  const picked = selectPrinciples(lab, text, { weights: opts.weights, max: opts.max ?? 4, planOnly: true, looped: opts.looped })
  const head = 'Principle plan: add "plan":{"<id>":"a few words"} to your JSON answering:'
  const budget = opts.budget ?? PLAN_TOKEN_BUDGET
  const lines = [head]
  for (const p of picked) {
    const line = `- ${p.id}: ${p.plan}`
    if (estimateTokens([...lines, line].join('\n')) > budget) break
    lines.push(line)
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

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

export function principleCriticBlock(
  ids: string[],
  opts: { weights?: PrincipleWeights; measured?: Record<string, { score: number; note: string; fix?: string }>; focus?: string[]; budget?: number } = {}
): string {
  const budget = opts.budget ?? CRITIC_TOKEN_BUDGET
  const head = 'Principles (0-10 each; score every id listed):'
  const lines = [head]
  for (const id of ids) {
    const p = principle(id)
    if (!p) continue
    const w = wOf(opts.weights, id)
    const m = opts.measured?.[id]
    const focus = opts.focus?.includes(id) ? ' [FOCUS]' : ''
    const weightTag = Math.abs(w - 1) >= 0.1 ? ` [user weight x${w.toFixed(1)}]` : ''
    const meas = m ? ` | code: ${m.score.toFixed(1)} (${m.note})` : ''
    const line = `- ${id}${weightTag}${focus}: ${p.rule}${meas}`
    if (estimateTokens([...lines, line].join('\n')) > budget) break
    lines.push(line)
  }
  return lines.length > 1 ? lines.join('\n') : ''
}
