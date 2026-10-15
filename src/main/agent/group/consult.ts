// The converging consult: "ask <model> ... come up with a conclusion and report back".
// The guest answers first (no anchoring on the host), then host and guest take turns until both
// agree, the turn cap is hit, or the per-consult token/cost cap is spent. The host then writes the
// conclusion, which becomes a Conclusion card (answer, agreed, disagreed with who said what,
// confidence, and what each model checked: taken from their actual tool calls).
//
// Pure loop over an injected `speak`, so tests drive it with fake models.

import type { ConclusionData, GroupVoice } from '../../../shared/group/types.ts'
import {
  checksFrom,
  conclusionPrompt,
  consultTranscript,
  converged,
  guestFollowPrompt,
  guestOpenPrompt,
  hostReviewPrompt,
  parseConclusion,
  parseStance,
  type Stance
} from '../../../shared/group/consult.ts'

export interface SpeakResult {
  text: string
  tokens: number
  costUsd?: number
  tools: { name: string; input: string }[]
}

export interface ConsultSides {
  host: GroupVoice & { alias?: string }
  guest: GroupVoice & { alias?: string }
  // One model call. `who` picks the side; `prompt` is the full user prompt; `tools` = read-only tools.
  // `silent`: do not show it in the chat (the conclusion is posted as a card instead).
  speak(who: 'host' | 'guest', prompt: string, opts: { tools: boolean; silent?: boolean }): Promise<SpeakResult>
  signal: AbortSignal
}

export interface ConsultLimits {
  maxTurns: number
  maxTokens: number
  maxUsd: number
  tools: boolean
}

export interface ConsultOutcome {
  // null when the guest never answered (nothing to conclude).
  conclusion: Omit<ConclusionData, 'question'> | null
  // The host's conclusion text (markdown).
  text: string
  stances: { exchange: number; guest: Stance | null; host: Stance | null }[]
  error?: string
}

export async function runConsult(sides: ConsultSides, question: string, pack: string, limits: ConsultLimits): Promise<ConsultOutcome> {
  const maxTurns = Math.max(1, Math.min(6, Math.floor(limits.maxTurns) || 3))
  const turns: { label: string; text: string }[] = []
  const calls: { label: string; tool: string; input: string }[] = []
  const stances: ConsultOutcome['stances'] = []
  let tokens = 0
  let cost = 0
  let priced = true
  const overBudget = () => tokens >= limits.maxTokens || (priced && limits.maxUsd > 0 && cost >= limits.maxUsd)
  const say = async (who: 'host' | 'guest', prompt: string) => {
    const r = await sides.speak(who, prompt, { tools: limits.tools })
    tokens += r.tokens
    if (r.costUsd === undefined) priced = priced && r.tokens === 0
    else cost += r.costUsd
    const label = sides[who].label
    for (const t of r.tools) calls.push({ label, tool: t.name, input: t.input })
    if (r.text) turns.push({ label, text: r.text })
    return r.text
  }

  const g = sides.guest.label
  const h = sides.host.label
  let guestReply = await say('guest', `${pack}\n\n---\n${guestOpenPrompt(h, question)}`)
  if (!guestReply) return { conclusion: null, text: '', stances, error: `${g} gave no answer (see the chat for errors).` }

  let ended: ConclusionData['ended'] = 'cap'
  let exchange = 1
  for (; exchange <= maxTurns; exchange++) {
    if (sides.signal.aborted) {
      ended = 'stopped'
      break
    }
    if (overBudget()) {
      ended = 'budget'
      exchange--
      break
    }
    const hostReply = await say('host', hostReviewPrompt(g, question, consultTranscript(turns), exchange, maxTurns))
    const s = { exchange, guest: exchange === 1 ? null : parseStance(guestReply), host: parseStance(hostReply) }
    stances.push(s)
    if (!hostReply) {
      ended = sides.signal.aborted ? 'stopped' : 'error'
      break
    }
    if (converged(exchange, s)) {
      ended = 'agreed'
      break
    }
    if (exchange >= maxTurns) break
    if (sides.signal.aborted) {
      ended = 'stopped'
      break
    }
    if (overBudget()) {
      ended = 'budget'
      break
    }
    guestReply = await say('guest', guestFollowPrompt(h, question, consultTranscript(turns), exchange + 1, maxTurns))
    if (!guestReply) {
      ended = sides.signal.aborted ? 'stopped' : 'error'
      break
    }
  }
  const used = Math.min(maxTurns, Math.max(1, exchange))

  // The conclusion is written even when the loop stopped early (from what was said).
  let text = ''
  if (!sides.signal.aborted) {
    const r = await sides.speak('host', conclusionPrompt(question, g, h, consultTranscript(turns, 9000, 1500), ended), { tools: false, silent: true })
    tokens += r.tokens
    if (r.costUsd !== undefined) cost += r.costUsd
    text = r.text
  }
  if (!text) {
    // No conclusion call (stopped) or it failed: the last positions stand in.
    const last = turns.slice(-2)
    text = `## Answer\n${last.map((t) => `**${t.label}**: ${t.text}`).join('\n\n') || 'No conclusion.'}\n\n## Confidence\nlow: the consult ${ended === 'stopped' ? 'was stopped' : 'ended without a conclusion'}`
  }
  const people: GroupVoice[] = [sides.host, sides.guest].map((p) => ({ label: p.label, provider: p.provider, model: p.model }))
  const parsed = parseConclusion(text, [sides.host, sides.guest])
  return {
    text,
    stances,
    conclusion: {
      ...parsed,
      checks: checksFrom(calls, people),
      participants: people,
      turns: used,
      maxTurns,
      ended,
      tokens,
      ...(priced || cost > 0 ? { costUsd: Math.round(cost * 1e6) / 1e6 } : {})
    }
  }
}
