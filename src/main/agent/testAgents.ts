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

import { randomUUID } from 'node:crypto'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig, Options, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ChatMessage, TestAgent } from '@shared/types'
import type { HarnessContext } from '../context.ts'
import type { Credentials } from './credentials.ts'
import { allowServer, model, sdkQuery, studioMcp, STUDIO_SERVER, SYSTEM_PROMPT, systemMessage, toChatMessages, type QueryFn } from './sdk.ts'
import { gentreeTools, mcpToolName, SERVER_NAME } from './tools.ts'

const MAX_KEPT = 50
const MAX_MESSAGES = 300

export interface TestAgentDeps {
  queryFn?: QueryFn
  credentials?: Pick<Credentials, 'apply'>
  // Wraps tool definitions in an MCP server (tests capture the tools to call report_result).
  makeServer?: (tools: SdkMcpToolDefinition<any>[]) => McpServerConfig
}

interface Run {
  agent: TestAgent
  abort: AbortController
  messages: ChatMessage[]
  report?: { status: 'passed' | 'failed'; summary: string }
  usesStudio: boolean
}

function agentPrompt(role: 'playtester' | 'reviewer'): string {
  const how =
    role === 'playtester'
      ? 'You have the live Roblox Studio tools (mcp__studio__*). Use them to run the game or Luau and observe behaviour, alongside reading the code.'
      : 'You are a static reviewer: no live Studio access. Read the relevant code and reason carefully about whether the scenario works, citing file paths and lines.'
  return `${SYSTEM_PROMPT}

You are a test agent. You will be given one scenario to verify. You cannot edit files. ${how}
Stay focused on the scenario and keep tool calls few. When done, call ${mcpToolName('report_result')} exactly once with status "passed" or "failed" and a short summary (what you checked, evidence, and the cause of any failure).`
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
    return this.runs.map((r) => ({ ...r.agent }))
  }

  messages(id: string): ChatMessage[] | null {
    return this.runs.find((r) => r.agent.id === id)?.messages ?? null
  }

  // Queues one agent per scenario and returns their initial state; they run in the background.
  run(scenarios: string[]): TestAgent[] {
    const created: Run[] = []
    for (const scenario of scenarios.map((s) => s.trim()).filter(Boolean)) {
      const run: Run = {
        agent: { id: `t-${randomUUID().slice(0, 8)}`, scenario, state: 'queued' },
        abort: new AbortController(),
        messages: [],
        usesStudio: false
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

  private buildOptions(run: Run, root: string): Options {
    const reportTool = tool(
      'report_result',
      'Finish the test: report whether the scenario passed or failed, with a short summary.',
      { status: z.enum(['passed', 'failed']), summary: z.string() },
      async (args) => {
        run.report = { status: args.status, summary: args.summary }
        return { content: [{ type: 'text', text: 'recorded; stop now' }] }
      }
    )
    const tools = [...gentreeTools(this.ctx, { readOnly: true }), reportTool]
    const makeServer =
      this.deps.makeServer ??
      ((t: SdkMcpToolDefinition<any>[]) => createSdkMcpServer({ name: SERVER_NAME, version: '1.0.0', alwaysLoad: true, tools: t }))

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
      model: model(this.ctx),
      systemPrompt: agentPrompt(run.usesStudio ? 'playtester' : 'reviewer'),
      abortController: run.abort,
      mcpServers,
      strictMcpConfig: true,
      tools: ['Read', 'Glob', 'Grep'],
      allowedTools,
      // Headless: anything not pre-allowed is denied instead of prompting.
      permissionMode: 'dontAsk',
      settingSources: [],
      persistSession: false,
      maxTurns: Number(this.ctx.getSetting('agentMaxTurns', 40)) || 40
    }
  }

  private async execute(run: Run): Promise<void> {
    if (run.agent.state !== 'queued') return
    const root = this.ctx.project()?.root
    if (!root) return this.finish(run, 'error', 'No project open')
    run.agent.state = 'running'
    run.agent.startedAt = Date.now()
    const options = this.buildOptions(run, root)
    this.changed()
    const queryFn = this.deps.queryFn ?? sdkQuery
    try {
      await this.deps.credentials?.apply()
      const prompt = `Scenario to verify:\n${run.agent.scenario}`
      for await (const m of queryFn({ prompt, options })) {
        for (const cm of toChatMessages(m, run.agent.id)) this.push(run, cm)
        if (m.type === 'result') break
      }
    } catch (e) {
      if (!run.abort.signal.aborted) return this.finish(run, 'error', (e as Error).message)
    }
    if (run.abort.signal.aborted) return this.finish(run, 'cancelled', 'Cancelled')
    if (run.report) return this.finish(run, run.report.status, run.report.summary)
    this.finish(run, 'error', 'Agent finished without calling report_result')
  }

  private finish(run: Run, state: TestAgent['state'], summary: string): void {
    run.agent.state = state
    run.agent.summary = summary
    run.agent.finishedAt = Date.now()
    if (state === 'error' || state === 'cancelled') this.push(run, systemMessage(run.agent.id, summary))
    this.changed()
  }

  private push(run: Run, m: ChatMessage): void {
    run.messages.push(m)
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
