// Auto mode: decide between one agent and the orchestrated team for a chat request.
// Explainable rules with a score; an explicit user override (UI toggle or wording) always wins.

export type OrchestrateMode = 'auto' | 'single' | 'team'

export interface ProjectHint {
  // Total scripts in the project (ScriptGroup sizes summed); tiny projects lean single-agent.
  scriptCount?: number
}

export interface OrchestrateDecision {
  orchestrate: boolean
  reason: string
  score: number
}

const FORCE_TEAM = /\b(orchestrat\w*|(?:use|with|spin up|assemble) (?:a |the |your )?(?:team|agents|sub-?agents)|multi-?agent|in parallel|parallelize|team mode)\b/i
const FORCE_SINGLE = /\b(single[- ]agent|no team|without (?:a |the )?team|don'?t orchestrate|do not orchestrate|just you|by yourself|solo)\b/i
const QUESTION = /^(what|where|which|who|when|why|how|is|are|does|do|can|could|should|explain|show|list|find)\b/i
const ACTIONS = /\b(add|create|implement|build|make|write|refactor|rewrite|migrate|wire|hook up|integrate|port|convert|replace|remove|delete|rename|fix|update|test|spec|review)\b/gi
const BIG = /\b(system|feature|features|across (?:all|every|the whole)|every (?:service|controller|module|feature)|all (?:services|controllers|modules|features)|end[- ]to[- ]end|full(?:y)? (?:working|game loop)|from scratch|overhaul|framework)\b/gi
const PATHISH = /[\w-]+(?:\/[\w.-]+)+\.(?:luau|lua|blink|json|toml)|\b[A-Z][A-Za-z]+(?:Service|Controller)\b/g
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+\S/gm
const JOINERS = /\b(and then|and also|also|plus|as well as|after that|then)\b/gi

export const TEAM_THRESHOLD = 4

export function shouldOrchestrate(request: string, project?: ProjectHint | null, mode: OrchestrateMode = 'auto'): OrchestrateDecision {
  if (mode === 'team') return { orchestrate: true, reason: 'team mode chosen', score: Infinity }
  if (mode === 'single') return { orchestrate: false, reason: 'single-agent mode chosen', score: -Infinity }
  const text = (request ?? '').trim()
  if (FORCE_SINGLE.test(text)) return { orchestrate: false, reason: 'request asks for a single agent', score: -Infinity }
  const force = FORCE_TEAM.exec(text)
  if (force) return { orchestrate: true, reason: `request asks for "${force[0]}"`, score: Infinity }

  const reasons: string[] = []
  let score = 0
  const actions = new Set((text.match(ACTIONS) ?? []).map((a) => a.toLowerCase()))
  const items = (text.match(LIST_ITEM) ?? []).length
  const paths = new Set(text.match(PATHISH) ?? [])
  const big = new Set((text.match(BIG) ?? []).map((b) => b.toLowerCase()))
  const joiners = (text.match(JOINERS) ?? []).length

  if (items >= 3) {
    score += items >= 5 ? 4 : 3
    reasons.push(`${items} listed items`)
  }
  if (actions.size >= 3) {
    score += Math.min(3, actions.size - 1)
    reasons.push(`${actions.size} distinct actions`)
  }
  if (paths.size >= 3) {
    score += paths.size >= 5 ? 3 : 2
    reasons.push(`${paths.size} files/modules`)
  }
  if (big.size) {
    score += Math.min(2, big.size)
    reasons.push(`scope words (${[...big].slice(0, 2).join(', ')})`)
  }
  if (joiners >= 2) {
    score += 1
    reasons.push('several chained steps')
  }
  if (text.length > 600) {
    score += text.length > 1500 ? 2 : 1
    reasons.push('long request')
  }
  if (text.length < 200 && QUESTION.test(text) && !text.includes('\n')) {
    score -= 3
    reasons.push('short question')
  }
  if (project?.scriptCount !== undefined && project.scriptCount < 8) {
    score -= 1
    reasons.push('small project')
  }

  const orchestrate = score >= TEAM_THRESHOLD
  return {
    orchestrate,
    score,
    reason: reasons.length ? `${orchestrate ? 'team' : 'single agent'}: ${reasons.join(', ')}` : 'single agent: simple request'
  }
}
