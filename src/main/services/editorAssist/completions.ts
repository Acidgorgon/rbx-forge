// AI inline completions (ghost text): picks a fast model the user has set up and asks it for the
// text at the cursor. No electron imports.
//
// Backends, in order:
//   1. OpenAI API key       -> gpt-6-luna on Chat Completions (reasoning_effort none: no thinking delay)
//   2. Anthropic API key    -> claude-haiku-5-5 on the Messages API, called directly (no CLI)
//   3. deps.extraBackends() -> a seam for more (the Codex / ChatGPT sign-in, branch codex-provider)
// The Claude Code login alone is NOT used: every Agent SDK query starts the Claude Code CLI as a
// subprocess, which costs seconds per request, far too slow for suggestions while typing. The
// status then says what to add instead.
//
// Every call is charged to the usage ledger (source 'completions', so the Usage page lists it) and
// refused while the spending cap or the daily budget is reached.

import type { CompletionProviderStatus, InlineCompletionRequest, InlineCompletionResult } from '../../../shared/editorAssist/types.ts'
import { buildCompletionPrompt, cleanCompletion, isSecretPath, looksSecret, MAX_COMPLETION_TOKENS } from '../../../shared/editorAssist/completion.ts'
import { fromAnthropicUsage, fromOpenAiUsage, priced, type Usage, type UsageRecord } from '../../agent/budget/usage.ts'

export type FetchFn = typeof fetch

export const OPENAI_COMPLETION_MODEL = 'gpt-6-luna'
export const ANTHROPIC_COMPLETION_MODEL = 'claude-haiku-5-5'
export const COMPLETION_TIMEOUT_MS = 8000

export interface CompletionPrompt {
  system: string
  user: string
}

export interface CompletionBackend {
  // 'openai' | 'anthropic' | 'codex' ...
  id: string
  label: string
  model: string
  complete(prompt: CompletionPrompt, signal: AbortSignal): Promise<{ text: string; usage?: Usage }>
}

export interface CompletionDeps {
  // API keys (stored or from the environment); never the Claude Code login.
  getKey(provider: 'openai' | 'anthropic'): Promise<string | null>
  // Whether only the Claude Code login is set up (for the status text).
  claudeLoginOnly?(): Promise<boolean>
  // Seam for more backends (Codex / ChatGPT sign-in). Return null when not signed in.
  extraBackends?(): Promise<CompletionBackend | null>
  // Refusal text while the spending cap or the daily budget is reached, else null.
  blocked(): string | null
  // Charges one call (usage ledger -> meter, spending cap).
  record(r: UsageRecord): void
  fetchFn?: FetchFn
  log?(text: string): void
}

export const NEEDS_PROVIDER = 'AI completions need an OpenAI or Anthropic API key, or a ChatGPT/Codex sign-in (Settings > Providers).'

export function openAiBackend(key: string, fetchFn: FetchFn, baseUrl = 'https://api.openai.com/v1'): CompletionBackend {
  const model = OPENAI_COMPLETION_MODEL
  return {
    id: 'openai',
    label: 'OpenAI',
    model,
    async complete(p, signal) {
      const res = await fetchFn(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: p.system },
            { role: 'user', content: p.user }
          ],
          max_completion_tokens: MAX_COMPLETION_TOKENS,
          reasoning_effort: 'none',
          stream: false
        }),
        signal
      })
      if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
      const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[]; usage?: unknown }
      const content = body.choices?.[0]?.message?.content
      return { text: typeof content === 'string' ? content : '', usage: fromOpenAiUsage(body.usage) ?? undefined }
    }
  }
}

export function anthropicBackend(key: string, fetchFn: FetchFn, baseUrl = 'https://api.anthropic.com'): CompletionBackend {
  const model = ANTHROPIC_COMPLETION_MODEL
  return {
    id: 'anthropic',
    label: 'Anthropic',
    model,
    async complete(p, signal) {
      const res = await fetchFn(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: MAX_COMPLETION_TOKENS, system: p.system, messages: [{ role: 'user', content: p.user }] }),
        signal
      })
      if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
      const body = (await res.json()) as { content?: { type?: string; text?: string }[]; usage?: unknown }
      const text = (body.content ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
      return { text, usage: fromAnthropicUsage(body.usage as Record<string, unknown>) }
    }
  }
}

export class InlineCompletions {
  private deps: CompletionDeps
  private inflight = new Map<string, AbortController>()
  // A backend that failed with an auth error stays off until the keys change (status refresh).
  private lastError: string | null = null

  constructor(deps: CompletionDeps) {
    this.deps = deps
  }

  // The backend to use right now, or null.
  async backend(): Promise<CompletionBackend | null> {
    const fetchFn = this.deps.fetchFn ?? ((...a: Parameters<FetchFn>) => fetch(...a))
    const openai = await this.deps.getKey('openai')
    if (openai) return openAiBackend(openai, fetchFn)
    const anthropic = await this.deps.getKey('anthropic')
    if (anthropic) return anthropicBackend(anthropic, fetchFn)
    return (await this.deps.extraBackends?.().catch(() => null)) ?? null
  }

  async status(): Promise<CompletionProviderStatus> {
    const b = await this.backend()
    const paused = this.deps.blocked() ?? undefined
    if (!b) {
      const loginOnly = await this.deps.claudeLoginOnly?.().catch(() => false)
      return { ready: false, detail: loginOnly ? `${NEEDS_PROVIDER} Your Claude Code login is too slow for suggestions while typing.` : NEEDS_PROVIDER }
    }
    return { ready: true, provider: b.id, model: b.model, detail: `${b.label} ${b.model}${this.lastError ? ` · last error: ${this.lastError}` : ''}`, ...(paused ? { paused } : {}) }
  }

  cancel(id: string): void {
    this.inflight.get(id)?.abort()
    this.inflight.delete(id)
  }

  async complete(req: InlineCompletionRequest): Promise<InlineCompletionResult> {
    const path = String(req.path ?? '')
    const prefix = String(req.prefix ?? '')
    const suffix = String(req.suffix ?? '')
    if (!path || isSecretPath(path)) return { text: '' }
    const prompt = buildCompletionPrompt({ path, languageId: String(req.languageId ?? 'luau'), prefix, suffix, requires: Array.isArray(req.requires) ? req.requires.map(String) : [] })
    // Never send a window that holds something shaped like a credential.
    if (looksSecret(prompt.user)) return { text: '' }
    const block = this.deps.blocked()
    if (block) return { text: '', note: block }
    const backend = await this.backend()
    if (!backend) return { text: '', note: NEEDS_PROVIDER }
    const id = String(req.id ?? '')
    this.cancel(id)
    const ctrl = new AbortController()
    this.inflight.set(id, ctrl)
    const timer = setTimeout(() => ctrl.abort(), COMPLETION_TIMEOUT_MS)
    try {
      const out = await backend.complete(prompt, ctrl.signal)
      if (out.usage) {
        const at = Date.now()
        const { usage, costSource } = priced(backend.model, out.usage, { provider: backend.id, at })
        this.deps.record({ ...usage, at, provider: backend.id, model: backend.model, costSource, source: 'completions' })
      }
      this.lastError = null
      return { text: cleanCompletion(out.text, { prefix, suffix }) }
    } catch (e) {
      if (ctrl.signal.aborted) return { text: '' }
      const msg = (e as Error).message
      if (msg !== this.lastError) this.deps.log?.(`inline completion failed: ${msg}`)
      this.lastError = msg
      return { text: '', note: msg }
    } finally {
      clearTimeout(timer)
      if (this.inflight.get(id) === ctrl) this.inflight.delete(id)
    }
  }
}

// Why completions are paused: the app-wide spending cap (Settings > Usage), else the daily budget
// (agent budget dailyMaxCostUsd). null = allowed.
export function completionBlock(spendBlock: string | null, daySpendUsd: number, dailyMaxUsd?: number): string | null {
  if (spendBlock) return `AI completions paused: ${spendBlock}`
  if (dailyMaxUsd && dailyMaxUsd > 0 && daySpendUsd >= dailyMaxUsd) return `AI completions paused: today's spend $${daySpendUsd.toFixed(2)} reached the $${dailyMaxUsd.toFixed(2)} daily budget.`
  return null
}
