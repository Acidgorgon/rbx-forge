// Shared by main (group chat routing) and the renderer (@mention autocomplete).
// Model names in plain words: labels and @aliases for participants, @mention parsing, "talk to X"
// intent detection, and fuzzy resolution of phrases like "openai sol 6.1", "gpt 6.1 sol",
// "gemini pro" or "opus" to a provider/model the user has ready. Pure functions (no I/O).

import type { GroupParticipant, ModelChoice, ProviderId } from './types'

// Words that name a provider (or a model family sold by it).
const PROVIDER_WORDS: Record<string, ProviderId> = {
  openai: 'openai',
  gpt: 'openai',
  chatgpt: 'openai',
  anthropic: 'anthropic',
  claude: 'anthropic',
  google: 'gemini',
  gemini: 'gemini',
  openrouter: 'openrouter',
  ollama: 'ollama',
  local: 'ollama'
}

// Ignored in phrases.
const FILLER = new Set(['the', 'a', 'an', 'model', 'models', 'with', 'and', 'to', 'of', 'llm', 'ai', 'please', 'version', 'v'])

// Not distinctive enough for an alias.
const GENERIC = new Set(['preview', 'latest', 'mini', 'instruct', 'chat', 'exp', 'experimental', 'it', 'coder', 'flash', 'lite', 'pro'])

// "claude-opus-5-5" -> ["claude", "opus", "5.5"]; "gpt-6.1-sol" -> ["gpt", "6.1", "sol"];
// "openai/gpt-6-astra" -> ["openai", "gpt", "6", "astra"]; "gpt6" -> ["gpt", "6"].
export function tokenize(s: string): string[] {
  const norm = s
    .toLowerCase()
    .replace(/(\d)[-_ ](?=\d\b)/g, '$1.')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
  return norm
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean)
}

const isNum = (t: string) => /^\d+(\.\d+)*$/.test(t)

const CAP: Record<string, string> = { gpt: 'GPT', claude: 'Claude', gemini: 'Gemini', llama: 'Llama', qwen: 'Qwen', deepseek: 'DeepSeek', glm: 'GLM' }

// Display name: "claude-opus-5-5" -> "Claude Opus 5.5", "gpt-6.1-sol" -> "GPT-6.1 Sol",
// "gemini-3.1-pro-preview" -> "Gemini 3.1 Pro", "anthropic/claude-sonnet-5.5" -> "Claude Sonnet 5.5".
export function modelLabel(model: string): string {
  const bare = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
  const tokens = tokenize(bare.replace(/:latest$/, '')).filter((t) => t !== 'preview' && t !== 'latest')
  if (!tokens.length) return model
  const words = tokens.map((t) => CAP[t] ?? (isNum(t) ? t : t[0].toUpperCase() + t.slice(1)))
  // Claude/Gemini put the version after the variant; keep the id's order otherwise.
  if (tokens[0] === 'claude') {
    const nums = words.filter((_, i) => isNum(tokens[i]))
    const rest = words.filter((_, i) => !isNum(tokens[i]))
    return [...rest, ...nums].join(' ')
  }
  if (tokens[0] === 'gpt' && tokens[1] && isNum(tokens[1])) return [`GPT-${tokens[1]}`, ...words.slice(2)].join(' ')
  return words.join(' ')
}

// Short @handle: the distinctive word of the id ("opus", "sol", "astra"), "gemini" for Gemini.
export function modelAlias(model: string): string {
  const bare = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
  const tokens = tokenize(bare)
  if (tokens[0] === 'gemini') return 'gemini'
  const word = tokens.find((t) => !isNum(t) && !PROVIDER_WORDS[t] && !GENERIC.has(t))
  return word ?? tokens[0] ?? 'model'
}

// A participant for a choice, with an alias that does not clash with `taken`.
export function makeParticipant(choice: ModelChoice, role: 'host' | 'guest', taken: string[] = []): GroupParticipant {
  let alias = modelAlias(choice.model)
  const used = new Set(taken.map((a) => a.toLowerCase()))
  if (used.has(alias)) {
    let n = 2
    while (used.has(`${alias}${n}`)) n++
    alias = `${alias}${n}`
  }
  return { provider: choice.provider, model: choice.model, label: modelLabel(choice.model), alias, role }
}

export function sameModel(a: ModelChoice, b: ModelChoice): boolean {
  return a.provider === b.provider && a.model === b.model
}

// @mentions in a message, lowercased, without the @ ("@sol", "@gemini-pro", "@gpt-6.1-sol").
// Emails and code like `x@y` are not mentions (the @ must start a word).
export function parseMentions(text: string): string[] {
  const out: string[] = []
  const re = /(^|[\s(,;])@([A-Za-z][\w.\-/]*[\w])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const t = m[2].toLowerCase()
    if (!out.includes(t)) out.push(t)
  }
  return out
}

// The model phrase in "communicate with openai sol 6.1 and come up with a plan",
// "ask gemini pro what it thinks", "get opus's opinion on this". Null when there is none.
export function consultPhrase(text: string): string | null {
  const stop = String.raw`(?=\s+(?:and|to|about|on|for|so|then|regarding|what|whether|if|how|why|which|before|after|while)\b|[,;:!?\n]|\.(?:\s|$)|$)`
  const patterns = [
    new RegExp(String.raw`\bget\s+(.+?)'s\s+(?:opinion|take|input|view|thoughts|review)`, 'i'),
    new RegExp(String.raw`\b(?:communicate|talk|speak|consult|confer|discuss|chat|collaborate|work|brainstorm|debate|team\s+up|coordinate|check|pair|plan)\s+(?:it\s+)?(?:with|to|together\s+with)\s+(.+?)` + stop, 'i'),
    new RegExp(String.raw`\b(?:consult|ask|loop\s+in|bring\s+in|invite|involve)\s+(?!me\b|you\b|it\b|them\b|us\b|the\s+user\b)(.+?)` + stop, 'i'),
    new RegExp(String.raw`\b(?:what\s+does|what\s+would)\s+(.+?)\s+(?:think|say)`, 'i')
  ]
  for (const re of patterns) {
    const m = re.exec(text)
    const phrase = m?.[1]?.trim().replace(/^(?:the|a|an)\s+/i, '').replace(/\s+(?:model|too|as well)$/i, '')
    if (phrase && phrase.length <= 60 && tokenize(phrase).length <= 6) return phrase
  }
  return null
}

export type Resolution<T extends ModelChoice = ModelChoice> =
  | { kind: 'ok'; choice: T }
  | { kind: 'ambiguous'; options: T[] }
  | { kind: 'none' }

// Score of a candidate for the phrase tokens, or -1 when a distinctive word does not match.
function score(phrase: string[], c: ModelChoice, alias?: string): number {
  // OpenRouter ids carry the vendor as a prefix ("openai/gpt-6.1-sol"); it counts like a provider.
  const slash = c.model.lastIndexOf('/')
  const id = tokenize(slash >= 0 ? c.model.slice(slash + 1) : c.model)
  const vendor = slash >= 0 ? c.model.slice(0, slash).toLowerCase() : ''
  let s = 0
  let matchedModelWord = false
  for (const t of phrase) {
    if (FILLER.has(t)) continue
    if (alias && t === alias.toLowerCase()) {
      s += 6
      matchedModelWord = true
      continue
    }
    const prov = PROVIDER_WORDS[t]
    if (prov) {
      // "gpt"/"claude"/"gemini" are also model-id words.
      if (id.includes(t)) {
        s += 3
        matchedModelWord = true
      } else if (c.provider === prov || vendor === t || PROVIDER_WORDS[vendor] === prov) s += 2
      else if (t === 'openrouter' || c.provider !== 'openrouter') return -1
      continue
    }
    if (isNum(t)) {
      const exact = id.includes(t)
      const prefix = id.some((x) => isNum(x) && (x.startsWith(t + '.') || t.startsWith(x + '.')))
      if (exact) s += 4
      else if (prefix) s += 1
      else return -1
      matchedModelWord = true
      continue
    }
    if (id.includes(t)) s += 4
    else if (t.length >= 3 && id.some((x) => x.startsWith(t))) s += 2
    else return -1
    matchedModelWord = true
  }
  return matchedModelWord ? s : s > 0 ? 0.5 : -1
}

// Same model behind two providers (claude-opus-5-5 on anthropic, anthropic/claude-opus-5.5 on
// OpenRouter) counts as one: the native provider wins.
function modelKey(c: ModelChoice): string {
  const bare = c.model.includes('/') ? c.model.slice(c.model.lastIndexOf('/') + 1) : c.model
  return tokenize(bare).join(' ')
}

// Resolves a phrase ("openai sol 6.1", "gemini pro", "opus", "@sol", "openai/gpt-6.1-sol") to one
// of `candidates`. Exact "provider/model" or model ids win outright. Ambiguous when the best
// distinct models tie (or are within a point of each other with no distinctive word separating them).
export function resolveModel<T extends ModelChoice & { alias?: string }>(phrase: string, candidates: T[], prefer?: ModelChoice): Resolution<T> {
  const raw = phrase.trim().replace(/^@/, '')
  if (!raw || !candidates.length) return { kind: 'none' }
  const lower = raw.toLowerCase()
  const exact =
    candidates.find((c) => `${c.provider}/${c.model}`.toLowerCase() === lower) ??
    candidates.find((c) => c.alias?.toLowerCase() === lower) ??
    candidates.find((c) => c.model.toLowerCase() === lower)
  if (exact) return { kind: 'ok', choice: exact }

  const tokens = tokenize(raw).filter((t) => !FILLER.has(t))
  if (!tokens.length) return { kind: 'none' }
  const scored = candidates
    .map((c) => ({ c, s: score(tokens, c, c.alias) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
  if (!scored.length) return { kind: 'none' }

  // Best candidate per distinct model; native provider over OpenRouter, then the preferred provider.
  const best = new Map<string, { c: T; s: number }>()
  for (const x of scored) {
    const k = modelKey(x.c)
    const cur = best.get(k)
    const rank = (y: { c: T; s: number }) => y.s * 10 + (y.c.provider !== 'openrouter' ? 2 : 0) + (prefer && y.c.provider === prefer.provider ? 1 : 0)
    if (!cur || rank(x) > rank(cur)) best.set(k, x)
  }
  const ranked = [...best.values()].sort((a, b) => b.s - a.s || a.c.model.length - b.c.model.length)
  const top = ranked[0]
  const ties = ranked.filter((x) => x.s === top.s)
  if (ties.length > 1) {
    // "terra" picks gpt-5.6-terra over gpt-5.6-terra-mini: the base id when the others extend it.
    const keys = ties.map((x) => modelKey(x.c).split(' '))
    const shortest = keys.reduce((a, b) => (b.length < a.length ? b : a))
    const base = ties.filter((_, i) => keys[i].length === shortest.length)
    if (base.length === 1 && keys.every((k) => shortest.every((t) => k.includes(t)))) return { kind: 'ok', choice: base[0].c }
    return { kind: 'ambiguous', options: ties.slice(0, 5).map((x) => x.c) }
  }
  return { kind: 'ok', choice: top.c }
}

// ---------------------------------------------------------------- consults: flagship + not set up

// Variant rank within a family: the flagship wins when a bare family name ("gemini", "claude")
// matches several models. Lower-tier words lose; unknown words are neutral.
const TIER_WORDS: Record<string, number> = { opus: 3, ultra: 3, pro: 3, max: 3, sonnet: 2, plus: 2, flash: 1, haiku: 0, mini: 0, lite: 0, nano: 0, small: 0, tiny: 0 }

function tierOf(model: string): number {
  const bare = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
  const ranks = tokenize(bare)
    .map((t) => TIER_WORDS[t])
    .filter((x): x is number => x !== undefined)
  return ranks.length ? Math.min(...ranks) : 1.5
}

function versionOf(model: string): number[] {
  const n = tokenize(model).find(isNum)
  return n ? n.split('.').map(Number) : [0]
}

function cmpVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d
  }
  return 0
}

// One clear flagship among ambiguous options (highest tier, then newest version), else null.
export function pickFlagship<T extends ModelChoice>(options: T[]): T | null {
  if (options.length < 2) return options[0] ?? null
  const ranked = [...options].sort((a, b) => tierOf(b.model) - tierOf(a.model) || cmpVersion(versionOf(b.model), versionOf(a.model)))
  const [a, b] = ranked
  if (tierOf(a.model) === tierOf(b.model) && cmpVersion(versionOf(a.model), versionOf(b.model)) === 0) return null
  return a
}

export type ConsultResolution<T extends ModelChoice = ModelChoice> =
  | Resolution<T>
  // A model that matches, but its provider is not set up (no key / not running).
  | { kind: 'unconfigured'; choice: ModelChoice; provider: ProviderId }

// Resolves a consult phrase: against the room and ready models first (a bare family name picks the
// flagship), then against every known model so "gpt 6.1 sol" without an OpenAI key says so.
export function resolveConsultModel<T extends ModelChoice & { alias?: string }>(phrase: string, ready: T[], known: ModelChoice[] = [], prefer?: ModelChoice): ConsultResolution<T> {
  const r = resolveModel(phrase, ready, prefer)
  if (r.kind === 'ok') return r
  if (r.kind === 'ambiguous') {
    const top = pickFlagship(r.options)
    return top ? { kind: 'ok', choice: top } : r
  }
  const readyKeys = new Set(ready.map((c) => `${c.provider}/${c.model}`))
  const rest = known.filter((c) => !readyKeys.has(`${c.provider}/${c.model}`))
  const k = resolveModel(phrase, rest, prefer)
  if (k.kind === 'ok') return { kind: 'unconfigured', choice: k.choice, provider: k.choice.provider }
  if (k.kind === 'ambiguous') {
    const top = pickFlagship(k.options) ?? k.options[0]
    return { kind: 'unconfigured', choice: top, provider: top.provider }
  }
  return { kind: 'none' }
}

const PROVIDER_NAMES: Record<ProviderId, string> = { anthropic: 'Anthropic', openai: 'OpenAI', openrouter: 'OpenRouter', gemini: 'Google Gemini', ollama: 'Ollama', custom: 'the custom provider', codex: 'Codex' }

export function providerName(id: ProviderId): string {
  return PROVIDER_NAMES[id] ?? id
}

// The chat notice for a model whose provider is not set up.
export function unconfiguredText(choice: ModelChoice): string {
  const p = providerName(choice.provider)
  const a = /^[aeiou]/i.test(p) ? 'an' : 'a'
  const how = choice.provider === 'ollama' ? 'Start Ollama, or pick another model' : choice.provider === 'custom' ? 'Set its base URL' : choice.provider === 'codex' ? 'Sign in with ChatGPT' : `Add ${a} ${p} API key`
  return `${modelLabel(choice.model)} is ${a} ${p} model, and ${p} isn't set up in Forge yet. ${how} in Settings → Providers, then ask again.`
}
