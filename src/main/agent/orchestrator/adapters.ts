// runAgent adapters: the Claude Agent SDK (anthropic) and an OpenAI-compatible loop (others).
// Both are dependency-injected so this file imports no runtime code from the rest of the agent
// layer (which is being refactored in parallel) and nothing from Electron.
//
// Anthropic: one SDK query() per task. The engine's tools are wrapped into an in-process MCP
// server by the injected makeServer (tools.ts wrapInSdkServer works: same tool shape). SDK-native
// subagents are deliberately disabled (Agent/Task disallowed): the engine schedules tasks itself so
// it controls models, budgets, locks and parallelism (see CONTRACT.md).

import type { McpServerConfig, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatMessage } from '../../../shared/types.ts'
import type { AgentEvent, AgentSpec, OrchTool, RunAgent, Usage } from './types.ts'
import { runOpenAiLoop } from '../openaiLoop.ts'
import { runResponsesLoop, usesResponsesApi } from '../responsesLoop.ts'
import { fromOpenAiUsage } from '../budget/usage.ts'

// ---------------------------------------------------------------------------------------------
// A tiny async queue: turns callback-style producers into an AsyncIterable.

export function channel<T>(): { push(v: T): void; end(err?: unknown): void; iterable: AsyncIterable<T> } {
  const buf: T[] = []
  let done = false
  let error: unknown
  let wake: (() => void) | null = null
  const notify = () => {
    const w = wake
    wake = null
    w?.()
  }
  return {
    push(v) {
      if (done) return
      buf.push(v)
      notify()
    },
    end(err) {
      if (done) return
      done = true
      error = err
      notify()
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (buf.length) {
            yield buf.shift()!
            continue
          }
          if (done) {
            if (error) throw error
            return
          }
          await new Promise<void>((r) => (wake = r))
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Claude Agent SDK

export const ORCH_SERVER = 'forge'

export interface SdkAdapterDeps {
  query: (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>
  // Wraps the spec's tools in an in-process MCP server (one per query).
  makeServer: (tools: OrchTool<any>[]) => McpServerConfig
  // cwd, env (auth), pathToClaudeCodeExecutable, extra MCP servers (studio for testers)...
  baseOptions?: (spec: AgentSpec) => Partial<Options>
  serverName?: string
  // Resume the previous SDK session of the same spec.thread (lead runs). Off by default: engine
  // prompts are self-contained, and a fresh session keeps the lead's context small.
  resumeThreads?: boolean
}

// Built-in tools no orchestrated agent gets: writes go through the guarded MCP tools only, and
// subagents are the engine's job.
export const SDK_DISALLOWED = ['Agent', 'Task', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch']

export function sdkOptionsFor(spec: AgentSpec, deps: SdkAdapterDeps, abort: AbortController, resume?: string): Options {
  const name = deps.serverName ?? ORCH_SERVER
  const base = deps.baseOptions?.(spec) ?? {}
  return {
    ...base,
    model: spec.model,
    systemPrompt: spec.system,
    abortController: abort,
    maxTurns: spec.maxTurns,
    mcpServers: { ...(base.mcpServers ?? {}), [name]: deps.makeServer(spec.tools) },
    strictMcpConfig: true,
    tools: ['Read', 'Glob', 'Grep'],
    allowedTools: [`mcp__${name}`, `mcp__${name}__*`, 'Read', 'Glob', 'Grep', ...(base.allowedTools ?? [])],
    disallowedTools: [...SDK_DISALLOWED, ...(base.disallowedTools ?? [])],
    permissionMode: 'default',
    canUseTool:
      base.canUseTool ??
      (async (toolName) => ({ behavior: 'deny', message: `${toolName} is not available to orchestrated agents` })),
    settingSources: [],
    ...(resume ? { resume } : {})
  }
}

// Usage delta tracking for streamed assistant messages: several messages can share message.id,
// each with a non-final usage; emit only the growth.
export class SdkUsageDelta {
  private seen = new Map<string, Usage>()
  private cost = 0

  assistant(messageId: string, u: Record<string, unknown> | undefined): Usage | null {
    if (!u) return null
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
    const cur: Usage = { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) }
    const prev = this.seen.get(messageId) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const d: Usage = {
      input: Math.max(0, cur.input - prev.input),
      output: Math.max(0, cur.output - prev.output),
      cacheRead: Math.max(0, cur.cacheRead - prev.cacheRead),
      cacheWrite: Math.max(0, cur.cacheWrite - prev.cacheWrite)
    }
    this.seen.set(messageId, { input: Math.max(prev.input, cur.input), output: Math.max(prev.output, cur.output), cacheRead: Math.max(prev.cacheRead, cur.cacheRead), cacheWrite: Math.max(prev.cacheWrite, cur.cacheWrite) })
    return d.input || d.output || d.cacheRead || d.cacheWrite ? d : null
  }

  // total_cost_usd on result messages is cumulative for the query.
  result(totalCostUsd: unknown): Usage | null {
    if (typeof totalCostUsd !== 'number' || !Number.isFinite(totalCostUsd) || totalCostUsd <= this.cost) return null
    const d = totalCostUsd - this.cost
    this.cost = totalCostUsd
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: d }
  }
}

// Maps one SDK message to AgentEvents. Subagent traffic (parent_tool_use_id) is ignored.
export function sdkToEvents(m: SDKMessage, usage: SdkUsageDelta): AgentEvent[] {
  const out: AgentEvent[] = []
  if (m.type === 'assistant') {
    if (m.parent_tool_use_id) return out
    const msg = m.message as unknown as { id?: string; content?: any[]; usage?: Record<string, unknown> }
    const mid = msg.id ?? m.uuid
    for (const [i, block] of (msg.content ?? []).entries()) {
      if (block?.type === 'text' && block.text?.trim()) out.push({ type: 'text', text: block.text, id: `${mid}:${i}` })
      else if (block?.type === 'tool_use') out.push({ type: 'tool_call', name: String(block.name).replace(/^mcp__[^_]+(?:_[^_]+)*__/, ''), input: block.input })
    }
    if (m.error) out.push({ type: 'error', message: `API error: ${m.error}` })
    const d = usage.assistant(mid, msg.usage)
    if (d) out.push({ type: 'usage', usage: d })
    return out
  }
  if (m.type === 'user') {
    if (m.parent_tool_use_id) return out
    const content = (m.message as { content?: unknown }).content
    if (Array.isArray(content)) {
      for (const b of content as any[]) {
        if (b?.type !== 'tool_result' || !b.is_error) continue
        const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => c?.text ?? '').join('') : ''
        out.push({ type: 'tool_result', text, isError: true })
      }
    }
    return out
  }
  if (m.type === 'result') {
    const d = usage.result((m as { total_cost_usd?: unknown }).total_cost_usd)
    if (d) out.push({ type: 'usage', usage: d })
    if (m.subtype === 'success' && !m.is_error) out.push({ type: 'done', text: m.result })
    else out.push({ type: 'error', message: m.subtype === 'success' ? m.result : (m.errors?.join('; ') || m.subtype) })
  }
  return out
}

export function sdkRunAgent(deps: SdkAdapterDeps): RunAgent {
  const sessions = new Map<string, string>()
  return (spec) => ({
    async *[Symbol.asyncIterator]() {
      const abort = new AbortController()
      const onAbort = () => abort.abort()
      if (spec.signal.aborted) return
      spec.signal.addEventListener('abort', onAbort, { once: true })
      const resume = deps.resumeThreads && spec.thread ? sessions.get(spec.thread) : undefined
      const usage = new SdkUsageDelta()
      try {
        for await (const m of deps.query({ prompt: spec.prompt, options: sdkOptionsFor(spec, deps, abort, resume) })) {
          if (spec.thread && 'session_id' in m && m.session_id) sessions.set(spec.thread, m.session_id)
          for (const e of sdkToEvents(m, usage)) yield e
        }
      } finally {
        spec.signal.removeEventListener('abort', onAbort)
      }
    }
  })
}

// ---------------------------------------------------------------------------------------------
// OpenAI-compatible loop (runOpenAiLoop or its refactored successor).

export interface OpenAiLoopLike {
  (opts: {
    baseUrl: string
    headers?: Record<string, string>
    model: string
    system: string
    history: { role: 'user'; content: string }[]
    tools: OrchTool<any>[]
    maxTurns: number
    signal: AbortSignal
    agentId: string
    emit: (m: ChatMessage) => void
    extraBody?: Record<string, unknown>
    stop?: () => boolean
    // Per-request usage: the real loops pass the provider's raw usage object (normalized with
    // normalizeUsage below); test loops may pass an already-normalized Usage.
    onUsage?: (u: any) => void
  }): Promise<{ outcome: string; error?: string }>
}

export interface OpenAiAdapterDeps {
  // Defaults to the provider's loop: runResponsesLoop when usesResponsesApi(provider, model)
  // (OpenAI GPT-6 family), else runOpenAiLoop (Chat Completions).
  loop?: OpenAiLoopLike
  endpoint: (spec: AgentSpec) => Promise<{ baseUrl: string; headers?: Record<string, string>; extraBody?: Record<string, unknown> } | { error: string }>
  // Appended to the role prompt (tools.ts OPENAI_TOOLS_NOTE). Constant, so caching still works.
  systemSuffix?: string
  // Raw usage -> Usage (default: fromOpenAiUsage for raw provider objects, pass-through for
  // objects already in the normalized shape).
  normalizeUsage?: (raw: unknown) => Usage | null
}

function defaultNormalize(raw: unknown): Usage | null {
  const o = raw as Partial<Usage> | null
  if (o && typeof o === 'object' && typeof o.input === 'number' && typeof o.output === 'number' && typeof o.cacheRead === 'number') return o as Usage
  return fromOpenAiUsage(raw)
}

// The loop for a spec's provider/model.
export function loopFor(spec: Pick<AgentSpec, 'provider' | 'model'>): OpenAiLoopLike {
  const responses = !!spec.provider && usesResponsesApi(spec.provider, spec.model)
  return (responses ? runResponsesLoop : runOpenAiLoop) as unknown as OpenAiLoopLike
}

// Ends the loop right after submit_result / an accepted submit_plan, saving a model turn.
const FINAL_TOOLS = new Set(['submit_result', 'submit_plan'])

export function openAiRunAgent(deps: OpenAiAdapterDeps): RunAgent {
  return (spec) => {
    const ch = channel<AgentEvent>()
    let finished = false
    const tools = spec.tools.map((t) =>
      FINAL_TOOLS.has(t.name)
        ? {
            ...t,
            handler: async (args: any, extra: unknown) => {
              const r = await t.handler(args, extra)
              if (!r.isError) finished = true
              return r
            }
          }
        : t
    )
    void (async () => {
      const ep = await deps.endpoint(spec)
      if ('error' in ep) return ch.end(new Error(ep.error))
      const loop = deps.loop ?? loopFor(spec)
      const normalize = deps.normalizeUsage ?? defaultNormalize
      const res = await loop({
        baseUrl: ep.baseUrl,
        headers: ep.headers,
        model: spec.model,
        system: spec.system + (deps.systemSuffix ?? ''),
        history: [{ role: 'user', content: spec.prompt }],
        tools,
        maxTurns: spec.maxTurns,
        signal: spec.signal,
        agentId: `orch:${spec.runId}:${spec.taskId}`,
        emit: (m) => {
          if (m.role === 'assistant') ch.push({ type: 'text', text: m.text, id: m.id })
          else if (m.role === 'tool') ch.push({ type: 'tool_call', name: m.tool?.name ?? m.text, input: m.tool?.input })
          else if (m.role === 'system') ch.push({ type: 'tool_result', text: m.text, isError: true })
        },
        ...(ep.extraBody ? { extraBody: ep.extraBody } : {}),
        stop: () => finished,
        onUsage: (raw) => {
          const u = normalize(raw)
          if (u) ch.push({ type: 'usage', usage: u })
        }
      })
      if (res.outcome === 'error') ch.push({ type: 'error', message: res.error ?? 'error' })
      else ch.push({ type: 'done' })
      ch.end()
    })().catch((e) => ch.end(e))
    return ch.iterable
  }
}
