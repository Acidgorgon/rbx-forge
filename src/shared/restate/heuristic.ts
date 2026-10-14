// Cheap code check: is this request big or ambiguous enough to restate before acting? No model call.
// Explainable score from length, action verbs, file mentions, list items, chained steps, vague words
// and the chat's effort level. "/restate" forces it; the setting can say always or never.

import type { RestateKind, RestateMode } from './types.ts'

export interface RestateInput {
  mode: RestateMode
  kind?: RestateKind
  // The chat's explicit effort ('auto' / unset = no signal).
  effort?: string
  // "/restate" (chat) or the card's force button.
  force?: boolean
}

export interface RestateDecision {
  restate: boolean
  reason: string
  score: number
}

export const CHAT_THRESHOLD = 3
export const LAB_THRESHOLD = 2

const RESTATE_CMD = /^\/restate\b\s*/i

// "/restate fix the shop" -> { forced: true, text: 'fix the shop' }.
export function parseRestateCommand(text: string): { forced: boolean; text: string } {
  const t = String(text ?? '')
  return RESTATE_CMD.test(t.trimStart()) ? { forced: true, text: t.trimStart().replace(RESTATE_CMD, '').trim() } : { forced: false, text: t }
}

const ACTIONS = /\b(add|create|implement|build|make|write|refactor|rewrite|migrate|wire|hook up|integrate|port|convert|replace|remove|delete|rename|fix|update|change|move|split|merge|redesign|rework|clean up|set up|test)\b/gi
const FILES = /`[^`\n]+\.(?:luau|lua|blink|json|toml|ts|tsx|md)`|[\w-]+(?:\/[\w.-]+)+\.(?:luau|lua|blink|json|toml)|\b[\w-]+\.(?:luau|lua|blink|toml)\b|\b[A-Z][A-Za-z]+(?:Service|Controller)\b/g
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+\S/gm
const JOINERS = /\b(and then|and also|also|plus|as well as|after that|then|afterwards)\b/gi
const VAGUE = /\b(something like|somehow|not sure|kind of|sort of|maybe|better|improve|nicer|cleaner|feel(?:s)? off|feels? wrong|rework|overhaul|revamp|polish|figure out|whatever works)\b/gi
const SCOPE = /\b(system|systems|feature|architecture|across|every|all (?:the )?(?:services|controllers|modules|scripts)|whole|end[- ]to[- ]end|from scratch|framework|pipeline)\b/gi
const QUESTION = /^(what|where|which|who|when|why|how|is|are|does|do|can|could|should|explain|show|list|find)\b/i
const ACK = /^(ok(?:ay)?|thanks?|thank you|ty|yes|yep|no|nope|sure|cool|nice|great|go|continue|do it|lgtm|👍)[.!]*$/i

// Lab briefs are short by nature: stage words and references to something else count instead.
const STAGES = /\b(then|charges?|winds? up|windup|anticipation|release|impact|explodes?|followed by|after|before|into|while|ends?|finally|lingers?|dissipates?|recovery|loops?)\b/gi
const LIKE = /\b(like|style|inspired|from (?:jjk|naruto|dbz|genshin|one piece|bleach)|similar to|as in)\b/gi

function uniq(list: string[] | null): Set<string> {
  return new Set((list ?? []).map((s) => s.toLowerCase()))
}

export function decideRestate(request: string, input: RestateInput): RestateDecision {
  const text = String(request ?? '').trim()
  const kind = input.kind ?? 'chat'
  const words = text ? text.split(/\s+/).length : 0
  if (!text) return { restate: false, reason: 'empty request', score: 0 }
  if (input.force) return { restate: true, reason: kind === 'chat' ? '/restate' : 'asked to restate', score: Infinity }
  if (input.mode === 'never') return { restate: false, reason: 'restating is off', score: -Infinity }
  if (ACK.test(text)) return { restate: false, reason: 'acknowledgement', score: -Infinity }
  if (input.mode === 'always') {
    return words >= 3 ? { restate: true, reason: 'always restate', score: Infinity } : { restate: false, reason: 'too short to restate', score: -Infinity }
  }
  return kind === 'chat' ? chatScore(text, input.effort) : labScore(text)
}

function chatScore(text: string, effort?: string): RestateDecision {
  const reasons: string[] = []
  let score = 0
  const actions = uniq(text.match(ACTIONS))
  const files = uniq(text.match(FILES))
  const items = (text.match(LIST_ITEM) ?? []).length
  const joiners = (text.match(JOINERS) ?? []).length
  const vague = uniq(text.match(VAGUE))
  const scope = uniq(text.match(SCOPE))
  if (text.length > 280) {
    score += text.length > 700 ? 2 : 1
    reasons.push('long request')
  }
  if (actions.size >= 2) {
    score += actions.size >= 3 ? 2 : 1
    reasons.push(`${actions.size} actions`)
  }
  if (files.size >= 2) {
    score += files.size >= 3 ? 2 : 1
    reasons.push(`${files.size} files`)
  }
  if (items >= 3) {
    score += 3
    reasons.push(`${items} listed steps`)
  }
  if (joiners >= 2) {
    score += 1
    reasons.push('chained steps')
  }
  if (vague.size) {
    score += 1
    reasons.push(`open-ended (${[...vague][0]})`)
  }
  if (scope.size) {
    score += 1
    reasons.push(`scope (${[...scope][0]})`)
  }
  if (text.length < 160 && !text.includes('\n') && QUESTION.test(text)) {
    score -= 3
    reasons.push('short question')
  }
  if (effort === 'low' || effort === 'minimal') {
    score -= 2
    reasons.push(`effort ${effort}`)
  } else if (effort === 'high' || effort === 'xhigh' || effort === 'max') {
    score += 1
    reasons.push(`effort ${effort}`)
  }
  const restate = score >= CHAT_THRESHOLD
  return { restate, score, reason: reasons.length ? `${restate ? 'big task' : 'small task'}: ${reasons.join(', ')}` : 'small task' }
}

function labScore(text: string): RestateDecision {
  const reasons: string[] = []
  let score = 0
  const stages = uniq(text.match(STAGES))
  const like = (text.match(LIKE) ?? []).length
  const parts = (text.match(/,|\band\b/gi) ?? []).length
  const vague = uniq(text.match(VAGUE))
  if (text.length > 80) {
    score += text.length > 200 ? 2 : 1
    reasons.push('long brief')
  }
  if (stages.size >= 2) {
    score += 1
    reasons.push(`${stages.size} stages`)
  }
  if (parts >= 3) {
    score += 1
    reasons.push('several parts')
  }
  if (like) {
    score += 1
    reasons.push('refers to a style')
  }
  if (vague.size) {
    score += 1
    reasons.push(`open-ended (${[...vague][0]})`)
  }
  if (text.split(/\s+/).length <= 3) {
    score -= 2
    reasons.push('short brief')
  }
  const restate = score >= LAB_THRESHOLD
  return { restate, score, reason: reasons.length ? `${restate ? 'detailed brief' : 'simple brief'}: ${reasons.join(', ')}` : 'simple brief' }
}
