// Agent loop over OpenAI's Responses API (POST {baseUrl}/responses), for models whose function
// calling is only available there.
//
// Facts this relies on (developers.openai.com, checked 2026-10-13):
// - gpt-6.1-sol: Chat Completions is supported "but without tool calling"; Responses supports
//   tool calling (api/docs/models/gpt-6.1-sol). Reasoning effort low|medium(default)|high|xhigh|max,
//   "none"/"minimal" unsupported, so the luna-style reasoning_effort:"none" must never be sent.
// - Function tools are flat: { type: "function", name, description, parameters, strict }
//   (api/docs/guides/function-calling). strict is sent as false because the gentree schemas have
//   optional properties, which strict mode rejects.
// - The model returns output items { type: "function_call", call_id, name, arguments, id? }; results
//   go back as { type: "function_call_output", call_id, output }. Reasoning items returned with tool
//   calls must be passed back too, so within one run every output item is appended to `input`
//   verbatim, as the guide's JavaScript example does with response.output.
// - Streaming (stream: true) sends SSE events with a `type`: response.output_text.delta (`delta`),
//   response.output_item.done (`item`, `output_index`), response.completed (`response` with
//   `output` and `usage`), response.failed (`response.error`), response.incomplete
//   (`response.incomplete_details.reason`) and `error` (`message`)
//   (api/docs/guides/streaming-responses, api/reference/resources/responses/streaming-events).
//   Function-call arguments also stream as response.function_call_arguments.delta, but the complete
//   call arrives in response.output_item.done, which is what this loop uses.
// - usage: input_tokens, output_tokens, input_tokens_details.cached_tokens (and cache_write_tokens),
//   output_tokens_details.reasoning_tokens.
//
// Earlier turns of a stored chat are converted from the OpenAI chat format (OaiMessage), so a chat
// can switch between this loop and the Chat Completions loop. Converted function_call items carry
// no `id`, so the API does not ask for their (dropped) reasoning items.

import { randomUUID } from 'node:crypto'
import type { ProviderId } from '@shared/types'
import {
  chatMessage,
  errorMessage,
  httpError,
  type FetchFn,
  type LoopOptions,
  type LoopResult,
  type OaiMessage,
  type OaiToolCall
} from './openaiLoop.ts'
import { summarizeInput } from './sdk.ts'
import { resolveHistoryImages, responsesContent } from './imageParts.ts'
import { runTool, toolParameters, type GentreeTool } from './tools.ts'

// Models that need the Responses API for tools. OpenAI only (OpenRouter and others normalize
// everything to Chat Completions).
const RESPONSES_MODELS = /^gpt-6\.1-sol\b/

export function usesResponsesApi(provider: ProviderId, model: string): boolean {
  return provider === 'openai' && RESPONSES_MODELS.test(model)
}

export type ResponsesItem = Record<string, any>

export function responsesToolSpecs(tools: GentreeTool<any>[]): { type: 'function'; name: string; description: string; parameters: Record<string, unknown>; strict: false }[] {
  return tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: toolParameters(t), strict: false }))
}

// Chat-format history to Responses input items.
export function toResponsesInput(history: OaiMessage[]): ResponsesItem[] {
  const out: ResponsesItem[] = []
  for (const m of history) {
    if (m.role === 'system') out.push({ role: 'developer', content: m.content })
    else if (m.role === 'user') out.push({ role: 'user', content: responsesContent(m.content) })
    else if (m.role === 'assistant') {
      if (m.content) out.push({ role: 'assistant', content: m.content })
      for (const c of m.tool_calls ?? []) out.push({ type: 'function_call', call_id: c.id, name: c.function.name, arguments: c.function.arguments || '{}' })
    } else if (m.role === 'tool') out.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content })
  }
  return out
}

const TOOL_RESULT_PREVIEW = 4000

export async function runResponsesLoop(opts: LoopOptions): Promise<LoopResult> {
  const history = opts.history.slice()
  const input = toResponsesInput(await resolveHistoryImages(opts.history, opts.resolveImage))
  const fetchFn = opts.fetchFn ?? ((...a: Parameters<FetchFn>) => fetch(...a))
  const tools = new Map(opts.tools.map((t) => [t.name, t]))
  const specs = responsesToolSpecs(opts.tools)
  // Chat Completions-only fields from extraBody() do not belong here.
  const { reasoning_effort, stream_options, max_tokens, max_completion_tokens, ...extra } = opts.extraBody ?? {}
  void stream_options
  void max_tokens
  if (typeof reasoning_effort === 'string' && reasoning_effort !== 'none' && reasoning_effort !== 'minimal' && !extra.reasoning) extra.reasoning = { effort: reasoning_effort }
  if (typeof max_completion_tokens === 'number' && extra.max_output_tokens === undefined) extra.max_output_tokens = max_completion_tokens
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
        instructions: opts.system,
        input,
        ...(specs.length ? { tools: specs } : {}),
        stream: true,
        ...extra
      }
      const res = await fetchFn(`${opts.baseUrl.replace(/\/+$/, '')}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(opts.headers ?? {}) },
        body: JSON.stringify(body),
        signal: opts.signal
      })
      if (!res.ok) throw new Error(await httpError(res))

      const turn = await readResponse(res, opts)
      // Everything the model produced goes back verbatim (reasoning items included).
      input.push(...turn.items)
      const calls: OaiToolCall[] = turn.calls.map((c) => ({ id: c.call_id, type: 'function', function: { name: c.name, arguments: c.arguments ?? '' } }))
      const assistant: OaiMessage = { role: 'assistant', content: turn.text || null }
      if (calls.length) assistant.tool_calls = calls
      history.push(assistant)
      if (turn.incomplete) opts.emit(chatMessage(opts.agentId, 'system', `Response incomplete (${turn.incomplete}).`))
      if (!calls.length) return { history, outcome: 'done', turns }

      for (const call of calls) {
        if (opts.signal.aborted) {
          history.push({ role: 'tool', tool_call_id: call.id, content: 'cancelled' })
          input.push({ type: 'function_call_output', call_id: call.id, output: 'cancelled' })
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
        else if (!t) [text, isError] = [opts.refuseTool?.(name) ?? `unknown tool ${name}`, true]
        else {
          const r = await runTool(t, args)
          text = r.content.map((c) => c.text).join('\n')
          isError = !!r.isError
        }
        const output = isError ? `Error: ${text}` : text
        history.push({ role: 'tool', tool_call_id: call.id, content: output })
        input.push({ type: 'function_call_output', call_id: call.id, output })
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

interface ResponseTurn {
  text: string
  items: ResponsesItem[]
  calls: { call_id: string; name: string; arguments: string }[]
  incomplete?: string
}

function finish(text: string, items: ResponsesItem[], incomplete?: string): ResponseTurn {
  const calls = items
    .filter((i) => i?.type === 'function_call' && typeof i.name === 'string' && i.name)
    .map((i) => {
      if (!i.call_id) i.call_id = `call_${randomUUID().slice(0, 12)}`
      return { call_id: String(i.call_id), name: String(i.name), arguments: typeof i.arguments === 'string' ? i.arguments : JSON.stringify(i.arguments ?? {}) }
    })
  // Text from the final message items when nothing streamed (plain JSON reply, or a server that
  // only sends output_item.done).
  if (!text) {
    text = items
      .filter((i) => i?.type === 'message')
      .flatMap((i) => (Array.isArray(i.content) ? i.content : []))
      .filter((c: any) => c?.type === 'output_text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('')
  }
  return { text, items, calls, ...(incomplete ? { incomplete } : {}) }
}

async function readResponse(res: Response, opts: LoopOptions): Promise<ResponseTurn> {
  const textId = randomUUID()
  let text = ''
  let emitted = ''
  let lastEmit = 0
  const throttle = opts.throttleMs ?? 60
  const flush = (force: boolean) => {
    if (!text.trim() || text === emitted) return
    const now = Date.now()
    if (!force && now - lastEmit < throttle) return
    lastEmit = now
    emitted = text
    opts.emit(chatMessage(opts.agentId, 'assistant', text, undefined, textId))
  }

  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('text/event-stream') && type.includes('application/json')) {
    const json = (await res.json()) as any
    if (json?.error) throw new Error(errorMessage(json.error))
    if (json?.usage) opts.onUsage?.(json.usage)
    const turn = finish('', Array.isArray(json?.output) ? json.output : [], json?.incomplete_details?.reason)
    text = turn.text
    flush(true)
    return turn
  }

  if (!res.body) throw new Error('empty response body')
  // Done items by output_index, so the order matches the model's output.
  const done: ResponsesItem[] = []
  let completed: ResponsesItem[] | null = null
  let incomplete: string | undefined
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let finished = false
  try {
    while (!finished) {
      const r = await reader.read()
      if (r.done) break
      buf += decoder.decode(r.value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        let ev: any
        try {
          ev = JSON.parse(data)
        } catch {
          continue
        }
        switch (ev?.type) {
          case 'response.output_text.delta':
            if (typeof ev.delta === 'string') {
              text += ev.delta
              flush(false)
            }
            break
          case 'response.output_item.done':
            if (ev.item && typeof ev.item === 'object') {
              const at = typeof ev.output_index === 'number' ? ev.output_index : done.length
              done[at] = ev.item
            }
            break
          case 'response.completed':
          case 'response.incomplete':
            if (ev.response?.usage) opts.onUsage?.(ev.response.usage)
            if (Array.isArray(ev.response?.output) && ev.response.output.length) completed = ev.response.output
            if (ev.type === 'response.incomplete') incomplete = ev.response?.incomplete_details?.reason ?? 'unknown reason'
            finished = true
            break
          case 'response.failed':
            throw new Error(errorMessage(ev.response?.error ?? 'response failed'))
          case 'error':
            throw new Error(errorMessage(ev.error ?? ev))
        }
        if (finished) break
      }
    }
  } finally {
    if (finished) void reader.cancel().catch(() => {})
  }
  flush(true)
  // response.completed carries the full output; fall back to the items collected one by one.
  return finish(text, completed ?? done.filter(Boolean), incomplete)
}
