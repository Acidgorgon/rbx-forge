// Multi-agent testing: one SDK query per scenario, run concurrently up to 'maxParallelAgents'.
//
// Studio concurrency: one Roblox Studio instance cannot play-test several things at once. Rather
// than giving agents lock/unlock tools (which a model can forget to release), the scheduler owns a
// single "Studio slot". An agent that starts while the slot is free gets the Studio MCP tools and
// may play-test; agents that start while it is taken run as static reviewers (read the code, reason
// about the scenario). The slot frees when its agent finishes. Without a Studio MCP configured,
// every agent is a static reviewer.
//
// Every agent must end by calling report_result(status, summary); that call decides passed/failed.
//
// A run uses one provider/model for all its agents. On anthropic each agent is an Agent SDK query;
// on the other providers it is runOpenAiLoop with the read-only gentree tools plus report_result.
// Studio MCP tools are only wired into the SDK path, so non-anthropic agents are static reviewers.

import { randomUUID } from 'node:crypto'
import type { McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ChatMessage, ModelChoice, TestAgent } from '@shared/types'
import type { HarnessContext } from '../context.ts'
import type { AnthropicAuth } from './credentials.ts'
import { runOpenAiLoop, type FetchFn } from './openaiLoop.ts'
import { extraBody, isProviderId, type Providers } from './providers.ts'
import { runResponsesLoop, usesResponsesApi } from './responsesLoop.ts'
import {
  allowServer,
  executableOption,
  model,
  OPENAI_TOOLS_NOTE,
  sdkQuery,
  studioMcp,
  STUDIO_SERVER,
  SYSTEM_PROMPT,
  systemMessage,
  toChatMessages,
  type QueryFn
} from './sdk.ts'
import { routeModel } from './budget/budget.ts'
import { SdkUsageTracker } from './budget/usage.ts'
import type { Meter } from './meter.ts'
import { toSummary } from './meter.ts'
import { withRules } from './projectRules.ts'
import { defineTool, gentreeTools, mcpToolName, SERVER_NAME, wrapInSdkServer, type GentreeTool, type ToolFs } from './tools.ts'

const MAX_KEPT = 50
const MAX_MESSAGES = 300

export interface TestAgentDeps {
  queryFn?: QueryFn
  // Anthropic auth (env for the SDK subprocess); without it the SDK inherits process.env.
  credentials?: { anthropicAuth(): Promise<AnthropicAuth> }
  // Wraps tool definitions in an MCP server (tests capture the tools to call report_result).
  makeServer?: (tools: GentreeTool<any>[]) => McpServerConfig
  providers?: Providers
  fetchFn?: FetchFn
  toolFs?: ToolFs
  // Project instructions block (.forge aiRules + AGENTS.md).
  rules?: () => Promise<string>
  meter?: Meter
}

interface Run {
  agent: TestAgent
  abort: AbortController
  messages: ChatMessage[]
  report?: { status: 'passed' | 'failed'; summary: string }
  usesStudio: boolean
  choice: ModelChoice
  rules?: string
}

// Headless-first testing (Lune), for test/QA agents.
export const HEADLESS_FIRST =
  'Test logic headless first: call run_tests (and create_spec for untested modules) before any Studio tool. Use Studio only for what needs the engine: physics, rendering/UI layout, replication between real clients, DataStores/HTTP against live services, and playtesting.'

function agentPrompt(role: 'playtester' | 'reviewer', openai = false, rules = ''): string {
  const how =
    role === 'playtester'
      ? 'You have the live Roblox Studio tools (mcp__studio__*). Use them to run the game or Luau and observe behaviour, alongside reading the code.'
      : 'You are a static reviewer: no live Studio access. Read the relevant code and reason carefully about whether the scenario works, citing file paths and lines.'
  const report = openai ? 'report_result' : mcpToolName('report_result')
  return `${SYSTEM_PROMPT}${openai ? OPENAI_TOOLS_NOTE : ''}

You are a test agent. You will be given one scenario to verify. You cannot edit files. ${how}
${HEADLESS_FIRST} create_spec only adds a new *.spec.luau next to a module; it never changes game code.
Stay focused on the scenario and keep tool calls few. When done, call ${report} exactly once with status "passed" or "failed" and a short summary (what you checked, evidence, and the cause of any failure).${rules}`
}

export class TestAgentRunner {
  private ctx: HarnessContext
  private deps: TestAgentDeps
  private runs: Run[] = []
  private queue: Run[] = []
  private active = 0
  private studioBusy = false

  constructor(ctx: HarnessContext, deps: TestAgentDeps = {}) {
    this.ctx = ctx
    this.deps = deps
  }

  list(): TestAgent[] {
    const meter = this.deps.meter
    return this.runs.map((r) => {
      if (!meter) return { ...r.agent }
      const t = meter.ledger.agent(r.agent.id)
      return t.requests ? { ...r.agent, usage: toSummary(t) } : { ...r.agent }
    })
  }

  messages(id: string): ChatMessage[] | null {
    return this.runs.find((r) => r.agent.id === id)?.messages ?? null
  }

  // Queues one agent per scenario and returns their initial state; they run in the background.
  run(scenarios: string[], choice?: ModelChoice): TestAgent[] {
    const pick: ModelChoice =
      choice && isProviderId(choice.provider) && typeof choice.model === 'string' && choice.model.trim()
        ? { provider: choice.provider, model: choice.model.trim() }
        : this.routed(scenarios.join('\n'))
    const created: Run[] = []
    for (const scenario of scenarios.map((s) => s.trim()).filter(Boolean)) {
      const run: Run = {
        agent: { id: `t-${randomUUID().slice(0, 8)}`, scenario, state: 'queued', provider: pick.provider, model: pick.model },
        abort: new AbortController(),
        messages: [],
        usesStudio: false,
        choice: pick
      }
      created.push(run)
      this.runs.push(run)
      this.queue.push(run)
    }
    this.trim()
    this.changed()
    this.pump()
    return created.map((r) => ({ ...r.agent }))
  }

  // No explicit model: the default provider's cheap tier (budget/budget.ts routeModel, task 'agent').
  private routed(text: string): ModelChoice {
    const base = this.deps.providers?.defaultModel() ?? { provider: 'anthropic' as const, model: model(this.ctx) }
    const r = routeModel({
      task: 'agent',
      text,
      settings: { provider: base.provider, model: base.model, autoRoute: this.ctx.getSetting<boolean>('autoRoute', true) !== false, tiers: this.ctx.getSetting('modelTiers', undefined) }
    })
    return { provider: base.provider, model: r.model }
  }

  cancel(id: string): void {
    const run = this.runs.find((r) => r.agent.id === id)
    if (!run) return
    if (run.agent.state === 'queued') {
      this.queue = this.queue.filter((r) => r !== run)
      this.finish(run, 'cancelled', 'Cancelled before start')
    } else if (run.agent.state === 'running') {
      run.abort.abort()
    }
  }

  dispose(): void {
    for (const r of this.queue) r.agent.state = 'cancelled'
    this.queue = []
    for (const r of this.runs) if (r.agent.state === 'running') r.abort.abort()
  }

  // Resolves when nothing is queued or running (used by tests).
  async idle(): Promise<void> {
    while (this.active > 0 || this.queue.length > 0) await new Promise((r) => setTimeout(r, 5))
  }

  private maxParallel(): number {
    const n = Number(this.ctx.getSetting('maxParallelAgents', 3))
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3
  }

  private pump(): void {
    while (this.active < this.maxParallel() && this.queue.length > 0) {
      const run = this.queue.shift()!
      this.active++
      void this.execute(run).finally(() => {
        this.active--
        if (run.usesStudio) this.studioBusy = false
        this.pump()
      })
    }
  }

  // Read-only gentree tools plus report_result, which records the verdict on the run.
  private agentTools(run: Run): GentreeTool<any>[] {
    const reportTool = defineTool(
      'report_result',
      'Finish the test: report whether the scenario passed or failed, with a short summary.',
      { status: z.enum(['passed', 'failed']), summary: z.string() },
      async (args) => {
        run.report = { status: args.status, summary: args.summary }
        return { content: [{ type: 'text', text: 'recorded; stop now' }] }
      }
    )
    // Read tools + run_tests + create_spec (one new spec file; never game code).
    return [...gentreeTools(this.ctx, { readOnly: true, specs: true, ...(this.deps.toolFs ? { fs: this.deps.toolFs } : {}) }), reportTool]
  }

  private buildOptions(run: Run, root: string, env?: Record<string, string | undefined>): Options {
    const tools = this.agentTools(run)
    const makeServer = this.deps.makeServer ?? wrapInSdkServer

    const mcpServers: Record<string, McpServerConfig> = { [SERVER_NAME]: makeServer(tools) }
    const allowedTools = [...allowServer(SERVER_NAME), 'Read', 'Glob', 'Grep']
    const studio = studioMcp(this.ctx)
    if (studio && !this.studioBusy) {
      this.studioBusy = true
      run.usesStudio = true
      mcpServers[STUDIO_SERVER] = studio
      allowedTools.push(...allowServer(STUDIO_SERVER))
    }
    return {
      cwd: root,
      model: run.choice.model,
      systemPrompt: agentPrompt(run.usesStudio ? 'playtester' : 'reviewer', false, run.rules ?? ''),
      ...(env ? { env } : {}),
      ...(this.deps.meter?.guard.sdkOptions('agent') ?? {}),
      ...executableOption(),
      abortController: run.abort,
      mcpServers,
      strictMcpConfig: true,
      tools: ['Read', 'Glob', 'Grep'],
      allowedTools,
      // Headless: anything not pre-allowed is denied instead of prompting.
      permissionMode: 'dontAsk',
      settingSources: [],
      persistSession: false,
      maxTurns: this.maxTurns()
    }
  }

  private maxTurns(): number {
    return Number(this.ctx.getSetting('agentMaxTurns', 25)) || 25
  }

  private async execute(run: Run): Promise<void> {
    if (run.agent.state !== 'queued') return
    const root = this.ctx.project()?.root
    if (!root) return this.finish(run, 'error', 'No project open')
    run.agent.state = 'running'
    run.agent.startedAt = Date.now()
    run.rules = (await this.deps.rules?.().catch(() => '')) ?? ''
    const prompt = `Scenario to verify:\n${run.agent.scenario}`
    if (run.choice.provider !== 'anthropic') {
      this.changed()
      const error = await this.executeOpenAi(run, prompt)
      if (error !== null && !run.abort.signal.aborted && !run.report) return this.finish(run, 'error', error)
    } else {
      let env: Record<string, string | undefined> | undefined
      if (this.deps.credentials) {
        const auth = await this.deps.credentials.anthropicAuth()
        if (!auth.ready) return this.finish(run, 'error', auth.error ?? 'Anthropic is not set up')
        env = auth.env
      }
      const options = this.buildOptions(run, root, env)
      this.changed()
      const queryFn = this.deps.queryFn ?? sdkQuery
      const meter = this.deps.meter
      const tracker = new SdkUsageTracker(run.choice.model)
      let budgetStop: string | undefined
      try {
        for await (const m of queryFn({ prompt, options })) {
          for (const cm of toChatMessages(m, run.agent.id)) this.push(run, cm)
          if (meter) {
            meter.ledger.recordAll(tracker.onMessage(m), { agentId: run.agent.id })
            meter.setLive(run.agent.id, tracker.live())
            const check = meter.checkAgent(run.agent.id)
            if (check.level === 'stop' && !run.report) {
              budgetStop = `budget cap reached: ${check.reason ?? ''}`.trim()
              run.abort.abort()
              break
            }
          }
          if (m.type === 'result') {
            if ((m as { subtype?: string }).subtype === 'error_max_budget_usd') budgetStop = 'budget cap reached (cost)'
            break
          }
        }
      } catch (e) {
        if (!run.abort.signal.aborted) return this.finish(run, 'error', (e as Error).message)
      } finally {
        if (meter) {
          meter.ledger.recordAll(tracker.finish(), { agentId: run.agent.id })
          meter.setLive(run.agent.id, null)
        }
      }
      if (budgetStop && !run.report) return this.finish(run, 'error', budgetStop)
    }
    if (run.abort.signal.aborted) return this.finish(run, 'cancelled', 'Cancelled')
    if (run.report) return this.finish(run, run.report.status, run.report.summary)
    this.finish(run, 'error', 'Agent finished without calling report_result')
  }

  // Runs one agent through the OpenAI-compatible loop. Returns an error message, or null.
  private async executeOpenAi(run: Run, prompt: string): Promise<string | null> {
    const { provider, model: modelId } = run.choice
    const ep = this.deps.providers ? await this.deps.providers.endpoint(provider) : { error: 'Providers are not available.' }
    if ('error' in ep) return ep.error
    const result = await (usesResponsesApi(provider, modelId) ? runResponsesLoop : runOpenAiLoop)({
      baseUrl: ep.baseUrl,
      headers: ep.headers,
      model: modelId,
      system: agentPrompt('reviewer', true, run.rules ?? ''),
      history: [{ role: 'user', content: prompt }],
      tools: this.agentTools(run),
      maxTurns: this.maxTurns(),
      signal: run.abort.signal,
      agentId: run.agent.id,
      emit: (m) => this.push(run, m),
      extraBody: extraBody(provider, modelId),
      stop: () => !!run.report || (this.deps.meter ? this.deps.meter.checkAgent(run.agent.id).level === 'stop' : false),
      fetchFn: this.deps.fetchFn,
      onUsage: (raw) => {
        this.deps.meter?.ledger.recordOpenAi(raw, { provider, model: modelId, agentId: run.agent.id })
      }
    })
    if (result.outcome === 'error') return result.error ?? 'request failed'
    if (result.outcome === 'max_turns') return 'Agent hit the turn limit without calling report_result'
    return null
  }

  private finish(run: Run, state: TestAgent['state'], summary: string): void {
    run.agent.state = state
    run.agent.summary = summary
    run.agent.finishedAt = Date.now()
    // The loop already posted its own error line; do not repeat it.
    const last = run.messages[run.messages.length - 1]
    const repeated = last?.role === 'system' && last.text.includes(summary)
    if ((state === 'error' || state === 'cancelled') && !repeated) this.push(run, systemMessage(run.agent.id, summary))
    // Team notification (Discord, when the person turned it on); fire-and-forget.
    if (state === 'failed') {
      try {
        this.ctx.notifyTestFailure?.({ scenario: run.agent.scenario, summary })
      } catch {
        // never block the agent on a notification
      }
    }
    this.changed()
  }

  private push(run: Run, m: ChatMessage): void {
    const i = run.messages.findIndex((x) => x.id === m.id)
    if (i >= 0) run.messages[i] = m
    else run.messages.push(m)
    if (run.messages.length > MAX_MESSAGES) run.messages.shift()
    this.ctx.emit('chat:message', m)
  }

  // Drops the oldest finished agents beyond MAX_KEPT.
  private trim(): void {
    while (this.runs.length > MAX_KEPT) {
      const i = this.runs.findIndex((r) => r.agent.state !== 'queued' && r.agent.state !== 'running')
      if (i < 0) break
      this.runs.splice(i, 1)
    }
  }

  private changed(): void {
    this.ctx.emit('agents:changed', this.list())
  }
}
