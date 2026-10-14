// Converging consults: "ask gpt 6.1 sol ... come up with a conclusion and report back".
// Pure helpers shared by main (the loop in agent/group/consult.ts), the browser mock and tests:
// trigger parsing, each reply's stance line, the convergence rule, and parsing the host's
// Conclusion into the card's fields.

import type { ConclusionChecks, ConclusionData, ConclusionPoint, ConfidenceLevel, GroupVoice } from '../groupTypes.ts'
import { consultPhrase, tokenize } from '../modelResolve.ts'

export interface ConsultTrigger {
  // The model phrase ("gpt 6.1 sol", "sol", "gemini").
  phrase: string
  // true: a structured consult that ends in a Conclusion card; false: the host just consults.
  converge: boolean
}

// Phrasings that ask for a back-and-forth that ends in a conclusion.
const CONVERGE = new RegExp(
  [
    String.raw`report\s+back`,
    String.raw`get\s+back\s+to\s+me`,
    String.raw`come\s+(?:up\s+with|to)\s+(?:a\s+|an\s+)?(?:conclusion|consensus|agreement|verdict|answer)`,
    String.raw`\bconclu(?:de|sion)\b`,
    String.raw`second\s+opinion`,
    String.raw`\b(?:double[-\s]?)?check\s+(?:it\s+|this\s+|that\s+)?with\b`,
    String.raw`\brun\s+(?:it|this|that|the\s+\w+)\s+(?:by|past)\b`,
    String.raw`\bverify\s+(?:it\s+|this\s+)?with\b`,
    String.raw`\b(?:agree|align)\s+(?:on|with\s+each\s+other)`,
    String.raw`\breach\s+(?:a\s+)?(?:consensus|agreement)`,
    String.raw`\buntil\s+you\s+(?:both\s+)?agree`,
    String.raw`\bsanity[-\s]check\s+(?:it\s+|this\s+)?with\b`
  ].join('|'),
  'i'
)

const STOP = String.raw`(?=\s+(?:and|to|about|on|for|so|then|regarding|what|whether|if|how|why|which|before|after|while|first|now|again|please|quickly|asap)\b|[,;:!?\n]|\.(?:\s|$)|$)`

// Extra phrase patterns for the converge phrasings consultPhrase does not cover.
const EXTRA = [
  new RegExp(String.raw`\bsecond\s+opinion\s+(?:from|of)\s+(.+?)` + STOP, 'i'),
  new RegExp(String.raw`\bget\s+(.+?)'s\s+second\s+opinion`, 'i'),
  new RegExp(String.raw`\b(?:double[-\s]?check|sanity[-\s]check|verify|confirm)\s+(?:it\s+|this\s+|that\s+)?with\s+(.+?)` + STOP, 'i'),
  new RegExp(String.raw`\brun\s+(?:it|this|that|the\s+\w+)\s+(?:by|past)\s+(.+?)` + STOP, 'i')
]

function clean(phrase: string | undefined): string | null {
  const p = phrase?.trim().replace(/^(?:the|a|an)\s+/i, '').replace(/\s+(?:model|too|as well)$/i, '')
  return p && p.length <= 60 && tokenize(p).length <= 6 ? p : null
}

// "ask gpt 6.1 sol and come up with a conclusion and report back" -> { phrase: 'gpt 6.1 sol', converge: true }.
// "talk to sol about the shop" -> { phrase: 'sol', converge: false }. Null when no model is named.
export function parseConsultTrigger(text: string): ConsultTrigger | null {
  const t = String(text ?? '')
  for (const re of EXTRA) {
    const p = clean(re.exec(t)?.[1])
    if (p) return { phrase: p, converge: true }
  }
  const phrase = consultPhrase(t)
  if (!phrase) return null
  return { phrase, converge: CONVERGE.test(t) }
}

// Words that make a phrase look like a model name (so "ask the server and report back" is not
// reported as a missing model).
const MODEL_WORDS = /\b(gpt|chatgpt|openai|claude|anthropic|opus|sonnet|haiku|gemini|google|llama|qwen|deepseek|mistral|grok|glm|kimi|sol|luna|astra|terra|o\d)\b|\d/i

export function looksLikeModel(phrase: string): boolean {
  return MODEL_WORDS.test(phrase)
}

// ---------------------------------------------------------------- stance

export type Stance = 'agree' | 'partial' | 'disagree'

// Every consult reply ends with "STANCE: agree|partial|disagree". Falls back to the last lines'
// wording; null when there is no signal.
export function parseStance(text: string): Stance | null {
  const m = /(?:^|\n)\s*\**\s*stance\s*\**\s*[:=-]\s*\**\s*(agree|agreed|partial|partly|partially|disagree|disagreed)\b/i.exec(text)
  if (m) {
    const w = m[1].toLowerCase()
    return w.startsWith('dis') ? 'disagree' : w.startsWith('part') ? 'partial' : 'agree'
  }
  const tail = text.trim().split('\n').slice(-3).join(' ').toLowerCase()
  if (/\b(i (?:still )?disagree|do not agree|don't agree)\b/.test(tail)) return 'disagree'
  if (/\b(partly agree|partially agree|agree with (?:most|some))\b/.test(tail)) return 'partial'
  if (/\b(i agree|we agree|agreed|fully agree|no objections?)\b/.test(tail)) return 'agree'
  return null
}

// The reply without its stance line (for the transcript the other side reads).
export function stripStance(text: string): string {
  return text.replace(/\n?\s*\**\s*stance\s*\**\s*[:=-]\s*\**\s*(?:agree|agreed|partial|partly|partially|disagree|disagreed)\b[^\n]*/gi, '').trim()
}

export interface ExchangeStances {
  guest: Stance | null
  host: Stance | null
}

// Converged when the host agrees and the guest agreed too (in the first exchange the guest has
// only answered, so the host agreeing with that answer is enough).
export function converged(exchange: number, s: ExchangeStances): boolean {
  if (s.host !== 'agree') return false
  return exchange === 1 || s.guest === 'agree'
}

// ---------------------------------------------------------------- prompts

export const STANCE_RULE = 'End with one line exactly like "STANCE: agree", "STANCE: partial" or "STANCE: disagree" (your stance on the other model\'s latest position).'

export function guestOpenPrompt(host: string, question: string): string {
  return `${host} (the host) is consulting you and will report a joint conclusion to the user. Question:\n${question}\n\nGive your own answer first: concrete, with files/functions where relevant. Check facts with the read-only tools when they matter. If a code change is warranted, you may include it as a unified diff in a \`\`\`diff block (the host decides whether to apply it). Under 250 words.`
}

export function hostReviewPrompt(guest: string, question: string, transcript: string, exchange: number, maxTurns: number): string {
  const last = exchange >= maxTurns
  return `You are consulting ${guest} on the user's question:\n${question}\n\nConsult so far:\n${transcript}\n\nThis is exchange ${exchange} of ${maxTurns}. Check ${guest}'s latest claims (use the read-only tools for facts that matter) and reply to ${guest} by name: what you agree with, what you dispute and why, anything missing.${last ? ' This is the last exchange: state your final position.' : ''} Under 200 words. You cannot edit files in this exchange.\n${STANCE_RULE}`
}

export function guestFollowPrompt(host: string, question: string, transcript: string, exchange: number, maxTurns: number): string {
  const last = exchange >= maxTurns
  return `${host} (the host) is consulting you on the user's question:\n${question}\n\nConsult so far:\n${transcript}\n\nThis is exchange ${exchange} of ${maxTurns}. Respond to ${host}'s latest reply by name: concede what is right, defend what you still believe with evidence (check with the read-only tools when it matters).${last ? ' This is the last exchange: state your final position.' : ''} Under 200 words.\n${STANCE_RULE}`
}

// The consult so far as "[Name]: text" lines, newest kept when over budget.
export function consultTranscript(turns: { label: string; text: string }[], maxChars = 7000, perTurn = 1800): string {
  const lines = turns.map((t) => {
    const body = stripStance(t.text)
    return `[${t.label}]: ${body.length > perTurn ? body.slice(0, perTurn - 1) + '…' : body}`
  })
  const kept: string[] = []
  let size = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i].length + 2 > maxChars && kept.length) break
    kept.unshift(lines[i])
    size += lines[i].length + 2
  }
  return kept.join('\n\n')
}

export function conclusionPrompt(question: string, guest: string, host: string, transcript: string, ended: ConclusionData['ended']): string {
  const why = ended === 'agreed' ? 'You and the other model agreed.' : ended === 'cap' ? 'The exchange hit its turn cap without full agreement.' : ended === 'budget' ? 'The exchange hit its token/cost cap.' : 'The exchange stopped early.'
  return `Write the conclusion of your consult with ${guest} for the user. ${why}\nQuestion: ${question}\n\nExchange:\n${transcript}\n\nUse exactly these sections:\n## Answer\n(the answer, 1-4 sentences or a short numbered list of steps)\n## Agreed\n- one bullet per point both of you hold\n## Disagreed\n- one bullet per open point, each naming who holds what, e.g. "Retry count: **${guest}**: 3; **${host}**: 5" (write "- none" when you fully agree)\n## Confidence\nhigh|medium|low: one sentence why\nNo other sections. Under 250 words.`
}

// ---------------------------------------------------------------- conclusion parsing

function sections(text: string): Map<string, string> {
  const out = new Map<string, string>()
  const parts = text.split(/\n(?=#{1,4}\s)/)
  for (const p of parts) {
    const m = /^\s*#{1,4}\s*([^\n]+)\n?([\s\S]*)$/.exec(p)
    if (!m) continue
    out.set(m[1].trim().toLowerCase().replace(/[:*]/g, '').trim(), m[2].trim())
  }
  return out
}

function bullets(body: string): string[] {
  const items = body
    .split('\n')
    .map((l) => /^\s*(?:[-*+•]|\d+[.)])\s+(.+)$/.exec(l)?.[1]?.trim())
    .filter((x): x is string => !!x)
  return items.length ? items : body.trim() ? [body.trim()] : []
}

const NONE = /^(none|nothing|n\/a|no disagreements?\.?|-)\.?$/i

// Who a point is attributed to: labels (or aliases) named in it, mapped to labels.
function attribution(text: string, people: { label: string; alias?: string }[]): string[] {
  const by: string[] = []
  const lower = text.toLowerCase()
  for (const p of people) {
    const names = [p.label, p.alias, p.label.split(' ').slice(-1)[0]].filter((x): x is string => !!x && x.length >= 3)
    if (names.some((n) => lower.includes(n.toLowerCase()))) by.push(p.label)
  }
  return by
}

export function parseConfidence(body: string): { level: ConfidenceLevel; why?: string } {
  const m = /\b(high|medium|moderate|low)\b/i.exec(body)
  const level = (m ? (m[1].toLowerCase() === 'moderate' ? 'medium' : m[1].toLowerCase()) : 'medium') as ConfidenceLevel
  const why = body
    .replace(/^\s*\**\s*(high|medium|moderate|low)\s*\**\s*[:.\-–—]?\s*/i, '')
    .trim()
  return why ? { level, why } : { level }
}

export interface ParsedConclusion {
  answer: string
  agreed: ConclusionPoint[]
  disagreed: ConclusionPoint[]
  confidence: ConfidenceLevel
  confidenceWhy?: string
}

// The host's sectioned conclusion -> card fields. Without sections the whole text is the answer.
export function parseConclusion(text: string, people: { label: string; alias?: string }[] = []): ParsedConclusion {
  const s = sections(text)
  const pick = (...keys: string[]) => {
    for (const [k, v] of s) if (keys.some((x) => k.startsWith(x))) return v
    return undefined
  }
  const answer = pick('answer', 'conclusion', 'recommendation', 'final answer') ?? (s.size ? '' : text.trim())
  const agreedBody = pick('agreed', 'agreements', 'agree')
  const disagreedBody = pick('disagreed', 'disagreements', 'open', 'disagree')
  const conf = pick('confidence')
  const points = (body: string | undefined, attribute: boolean): ConclusionPoint[] =>
    bullets(body ?? '')
      .filter((b) => !NONE.test(b.trim()))
      .map((b) => {
        const by = attribute ? attribution(b, people) : []
        return by.length ? { text: b, by } : { text: b }
      })
  const c = parseConfidence(conf ?? '')
  return {
    answer: answer || text.trim(),
    agreed: points(agreedBody, false),
    disagreed: points(disagreedBody, true),
    confidence: c.level,
    ...(c.why ? { confidenceWhy: c.why } : {})
  }
}

// ---------------------------------------------------------------- what each model checked

// "mcp__gentree__read_script" -> "read_script".
export function bareTool(name: string): string {
  return name.replace(/^mcp__.+?__/, '')
}

// Tool calls per speaker, as short lines ("read_script src/server/Shop.luau"), deduped, capped.
export function checksFrom(calls: { label: string; tool: string; input: string }[], people: GroupVoice[], max = 8): ConclusionChecks[] {
  return people.map((p) => {
    const mine = calls.filter((c) => c.label === p.label)
    const lines: string[] = []
    for (const c of mine) {
      const arg = c.input
        .replace(/\b(path|query|name|pattern|file|symbol|paths?)=/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
      const line = `${bareTool(c.tool)}${arg ? ` ${arg}` : ''}`
      if (!lines.includes(line)) lines.push(line)
    }
    return { label: p.label, checked: lines.slice(0, max).concat(lines.length > max ? [`+${lines.length - max} more`] : []) }
  })
}

// Markdown version of a conclusion (copy, transcripts, host notes).
export function conclusionMarkdown(c: Pick<ConclusionData, 'answer' | 'agreed' | 'disagreed' | 'confidence' | 'confidenceWhy' | 'checks'>): string {
  const pts = (list: ConclusionPoint[]) => (list.length ? list.map((p) => `- ${p.text}`).join('\n') : '- none')
  const checked = c.checks
    .map((k) => `- **${k.label}**: ${k.checked.length ? k.checked.join('; ') : 'reasoned from the context only'}`)
    .join('\n')
  return `## Answer\n${c.answer}\n\n## Agreed\n${pts(c.agreed)}\n\n## Disagreed\n${pts(c.disagreed)}\n\n## Confidence\n${c.confidence}${c.confidenceWhy ? `: ${c.confidenceWhy}` : ''}${checked ? `\n\n## Checked\n${checked}` : ''}`
}
