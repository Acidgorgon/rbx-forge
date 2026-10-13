// Agent loop for OpenAI-compatible providers (OpenAI, OpenRouter, Gemini, Ollama, custom).
//
// Plain fetch to POST {baseUrl}/chat/completions with stream: true and function tools. Each turn
// streams assistant text (emitted as one ChatMessage per text segment, updated in place under a
// stable id), collects tool calls, runs them through the same gentree handlers the Agent SDK path
// uses, appends the results as role "tool" messages and asks again, until the model answers
// without tool calls, maxTurns is reached, the stop() predicate holds, or the signal aborts.
//
// Compatibility notes:
// - SSE comment lines (": OPENROUTER PROCESSING") are ignored; a chunk with a top-level `error`
//   ends the turn with that error (OpenRouter reports mid-stream errors that way).
// - Gemini's OpenAI endpoint may omit `index` on streamed tool calls; calls are then matched by id.
// - Unknown fields on tool calls (Gemini's extra_content.google.thought_signature) are kept and
//   sent back on the assistant message, which Gemini 3 needs for multi-turn tool calling.
// - A server that ignores `stream` and answers with plain JSON is handled too.

import { randomUUID } from 'node:crypto'
import type { ChatMessage } from '@shared/types'
import { runTool, toFunctionSpecs, type GentreeTool } from './tools.ts'
import { summarizeInput } from './sdk.ts'

export type FetchFn = typeof fetch

export interface OaiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
  [extra: string]: unknown
}

export type OaiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OaiToolCall[]; [extra: string]: unknown }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface LoopOptions {
  baseUrl: string
  headers?: Record<string, string>
  model: string
  system: string
  // Conversation so far, ending with the new user message. Not mutated.
  history: OaiMessage[]
  tools: GentreeTool<any>[]
  maxTurns: number
  signal: AbortSignal
  agentId: string
  // Receives every ChatMessage; assistant text arrives repeatedly under the same id as it grows.
  emit: (m: ChatMessage) => void
  // Extra request body fields (e.g. reasoning_effort for some models).
  extraBody?: Record<string, unknown>
  // Checked after each batch of tool calls; true ends the loop (test agents after report_result).
  stop?: () => boolean
  fetchFn?: FetchFn
  // Minimum ms between streamed text updates (the final text is always emitted).
  throttleMs?: number
  // Raw provider usage object, once per request that reports one (chunk.usage on Chat Completions,
  // response.usage on the Responses API). Normalize with budget/usage.ts fromOpenAiUsage.
  onUsage?: (raw: unknown) => void
}

export interface LoopResult {
  // History including everything this run added (assistant and tool messages).
  history: OaiMessage[]
  outcome: 'done' | 'stopped' | 'max_turns' | 'aborted' | 'error'
  error?: string
  turns: number
}

const TOOL_RESULT_PREVIEW = 4000

export function chatMessage(agentId: string, role: ChatMessage['role'], text: string, tool?: ChatMessage['tool'], id = randomUUID()): ChatMessage {
  return { id, role, text, at: Date.now(), agentId, ...(tool ? { tool } : {}) }
}

export async function runOpenAiLoop(opts: LoopOptions): Promise<LoopResult> {
  const history = opts.history.slice()
  const fetchFn = opts.fetchFn ?? ((...a: Parameters<FetchFn>) => fetch(...a))
  const tools = new Map(opts.tools.map((t) => [t.name, t]))
  const specs = toFunctionSpecs(opts.tools)
  let turns = 0

  try {
    while (true) {
      if (opts.signal.aborted) return { history, outcome: 'aborted', turns }
      if (turns >= opts.maxTurns) {
        opts.emit(chatMessage(opts.agentId, 'system', `Stopped after ${opts.maxTurns} turns (max turns).`))
        return { history, outcome: 'max_turns', turns }
      }
      turns++
      const body = {
        model: opts.model,
        messages: [{ role: 'system', content: opts.system }, ...history],
        ...(specs.length ? { tools: specs } : {}),
        stream: true,
        ...(opts.extraBody ?? {})
      }
      const res = await fetchFn(`${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(opts.headers ?? {}) },
        body: JSON.stringify(body),
        signal: opts.signal
      })
      if (!res.ok) throw new Error(await httpError(res))

      const turn = await readTurn(res, opts)
      const assistant: OaiMessage = { role: 'assistant', content: turn.text || null, ...turn.extra }
      if (turn.calls.length) assistant.tool_calls = turn.calls
      history.push(assistant)
      if (!turn.calls.length) return { history, outcome: 'done', turns }

      for (const call of turn.calls) {
        if (opts.signal.aborted) {
          // Keep the history valid: every tool call needs a result.
          history.push({ role: 'tool', tool_call_id: call.id, content: 'cancelled' })
          continue
        }
        const name = call.function.name
        let args: unknown = {}
        let parseError: string | null = null
        try {
          args = call.function.arguments?.trim() ? JSON.parse(call.function.arguments) : {}
        } catch (e) {
          parseError = `arguments are not valid JSON: ${(e as Error).message}`
        }
        const chip = chatMessage(opts.agentId, 'tool', '', { name, input: summarizeInput(args) })
        opts.emit(chip)
        const t = tools.get(name)
        let text: string
        let isError = false
        if (parseError) [text, isError] = [parseError, true]
        else if (!t) [text, isError] = [`unknown tool ${name}`, true]
        else {
          const r = await runTool(t, args)
          text = r.content.map((c) => c.text).join('\n')
          isError = !!r.isError
        }
        history.push({ role: 'tool', tool_call_id: call.id, content: isError ? `Error: ${text}` : text })
        const preview = text.length > TOOL_RESULT_PREVIEW ? text.slice(0, TOOL_RESULT_PREVIEW) + '\n…' : text
        opts.emit({ ...chip, text: isError ? `Error: ${preview}` : preview })
      }
      if (opts.signal.aborted) return { history, outcome: 'aborted', turns }
      if (opts.stop?.()) return { history, outcome: 'stopped', turns }
    }
  } catch (e) {
    if (opts.signal.aborted || (e as Error).name === 'AbortError') return { history, outcome: 'aborted', turns }
    const error = (e as Error).message
    opts.emit(chatMessage(opts.agentId, 'system', `Error: ${error}`))
    return { history, outcome: 'error', error, turns }
  }
}

interface Turn {
  text: string
  calls: OaiToolCall[]
  // Extra assistant-message fields to echo back (Gemini's extra_content).
  extra: Record<string, unknown>
}

// Reads one streamed (or plain JSON) completion, emitting text as it grows.
async function readTurn(res: Response, opts: LoopOptions): Promise<Turn> {
  const textId = randomUUID()
  let text = ''
  let lastEmit = 0
  let emitted = ''
  const throttle = opts.throttleMs ?? 60
  const calls: OaiToolCall[] = []
  const extra: Record<string, unknown> = {}

  const flush = (force: boolean) => {
    if (!text.trim() || text === emitted) return
    const now = Date.now()
    if (!force && now - lastEmit < throttle) return
    lastEmit = now
    emitted = text
    opts.emit(chatMessage(opts.agentId, 'assistant', text, undefined, textId))
  }

  const applyDelta = (delta: any) => {
    if (!delta || typeof delta !== 'object') return
    if (typeof delta.content === 'string') text += delta.content
    if (delta.extra_content) extra.extra_content = delta.extra_content
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) mergeToolCall(calls, tc)
    }
  }

  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('text/event-stream') && type.includes('application/json')) {
    const json = (await res.json()) as any
    if (json?.error) throw new Error(errorMessage(json.error))
    if (json?.usage) opts.onUsage?.(json.usage)
    const msg = json?.choices?.[0]?.message
    applyDelta(msg)
    flush(true)
    return finishTurn(text, calls, extra)
  }

  if (!res.body) throw new Error('empty response body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let done = false
  try {
    while (!done) {
      const r = await reader.read()
      if (r.done) break
      buf += decoder.decode(r.value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (!line || line.startsWith(':')) continue
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') {
          done = true
          break
        }
        let chunk: any
        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }
        if (chunk.error) throw new Error(errorMessage(chunk.error))
        // With stream_options.include_usage the last chunk has `choices: []` and the usage.
        if (chunk.usage) opts.onUsage?.(chunk.usage)
        const choice = chunk.choices?.[0]
        if (!choice) continue
        applyDelta(choice.delta ?? choice.message)
        flush(false)
      }
    }
  } finally {
    if (done) void reader.cancel().catch(() => {})
  }
  flush(true)
  return finishTurn(text, calls, extra)
}

function finishTurn(text: string, calls: OaiToolCall[], extra: Record<string, unknown>): Turn {
  // Some servers omit ids; tool results must reference one.
  for (const c of calls) if (!c.id) c.id = `call_${randomUUID().slice(0, 12)}`
  return { text, calls: calls.filter((c) => c.function.name), extra }
}

// Accumulates a streamed tool-call fragment. Fragments carry `index` (OpenAI); without it they
// are matched by id, or continue the last call.
export function mergeToolCall(calls: OaiToolCall[], tc: any): void {
  if (!tc || typeof tc !== 'object') return
  let target: OaiToolCall | undefined
  if (typeof tc.index === 'number') {
    target = calls[tc.index]
    if (!target) {
      target = { id: '', type: 'function', function: { name: '', arguments: '' } }
      calls[tc.index] = target
    }
  } else {
    target = (tc.id && calls.find((c) => c.id === tc.id)) || (!tc.id ? calls[calls.length - 1] : undefined)
    if (!target) {
      target = { id: '', type: 'function', function: { name: '', arguments: '' } }
      calls.push(target)
    }
  }
  if (tc.id) target.id = tc.id
  const fn = tc.function ?? {}
  // The name arrives whole in the first fragment (some servers repeat it; never concatenate).
  if (typeof fn.name === 'string' && fn.name && !target.function.name) target.function.name = fn.name
  if (typeof fn.arguments === 'string') target.function.arguments += fn.arguments
  else if (fn.arguments && typeof fn.arguments === 'object') target.function.arguments = JSON.stringify(fn.arguments)
  for (const [k, v] of Object.entries(tc)) {
    if (k !== 'index' && k !== 'id' && k !== 'function' && k !== 'type' && v !== undefined) target[k] = v
  }
}

export async function httpError(res: Response): Promise<string> {
  let detail = ''
  try {
    const raw = await res.text()
    try {
      const j = JSON.parse(raw)
      detail = errorMessage(Array.isArray(j) ? j[0]?.error : j.error ?? j)
    } catch {
      detail = raw.slice(0, 300)
    }
  } catch {
    // no body
  }
  const hint = res.status === 401 || res.status === 403 ? ' (check the API key in Settings)' : res.status === 404 ? ' (check the model name and base URL)' : ''
  return `HTTP ${res.status}${detail ? `: ${detail}` : ''}${hint}`
}

export function errorMessage(err: unknown): string {
  if (!err) return 'unknown error'
  if (typeof err === 'string') return err
  const e = err as { message?: string; code?: unknown; metadata?: { raw?: string } }
  return e.message ?? JSON.stringify(err).slice(0, 300)
}

// Keeps a stored history bounded: at most `max` messages, starting at a user message so no
// tool result is left without its call.
export function trimHistory(history: OaiMessage[], max = 200): OaiMessage[] {
  if (history.length <= max) return history
  let start = history.length - max
  while (start < history.length && history[start].role !== 'user') start++
  return history.slice(start)
}
