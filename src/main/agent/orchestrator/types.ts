// Types for the multi-agent orchestrator. Provider-agnostic: the engine never talks to a model
// directly; it calls an injected runAgent(spec) that yields AgentEvents (see adapters.ts for the
// Claude Agent SDK and OpenAI-compatible loop adapters). See CONTRACT.md for the IPC/UI contract.

import type { z, ZodRawShape } from 'zod'
import type { ProviderId } from '../../../shared/types.ts'

export type Role = 'lead' | 'scout' | 'builder' | 'tester' | 'reviewer'
export const ROLES: readonly Role[] = ['lead', 'scout', 'builder', 'tester', 'reviewer']
export const SPECIALIST_ROLES: readonly Exclude<Role, 'lead'>[] = ['scout', 'builder', 'tester', 'reviewer']

// ---------------------------------------------------------------------------------------------
// Tools. Structurally identical to tools.ts GentreeTool (and the SDK's tool() objects), so the
// adapters can hand them to wrapInSdkServer / runOpenAiLoop unchanged.

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

export interface OrchTool<S extends ZodRawShape = ZodRawShape> {
  name: string
  description: string
  inputSchema: S
  handler: (args: z.infer<z.ZodObject<S>>, extra: unknown) => Promise<ToolResult>
}

// How the engine treats a base tool. 'admin' tools (git sync, service restarts, shell) are given
// to no orchestrated agent.
export type ToolClass = 'read' | 'write' | 'test' | 'diff' | 'admin'

// Supplies the base tools (gentree read/write, project map, search, Lune...) for one agent.
// The engine filters them by role and wraps the write tools with the lock guard.
export type ToolFactory = (req: { runId: string; taskId: string; role: Role }) => OrchTool<any>[]

// ---------------------------------------------------------------------------------------------
// Usage and budgets. Usage is the same shape as budget/usage.ts Usage.

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUsd?: number
}

export type BudgetLevel = 'ok' | 'warn' | 'stop'

export type BudgetScope =
  | { kind: 'task'; runId: string; taskId: string; role: Role; model: string }
  | { kind: 'run'; runId: string }

// check(usage, scope): usage is the scope's cumulative usage so far. Compatible with the budget
// worker's BudgetGuard: wrap guard.check({ agentId }, live) and map BudgetCheck.level/reason.
export interface BudgetChecker {
  check(usage: Usage, scope: BudgetScope): { level: BudgetLevel; reason?: string }
}

// ---------------------------------------------------------------------------------------------
// The injected agent runner.

export interface AgentSpec {
  runId: string
  taskId: string
  role: Role
  provider?: ProviderId
  model: string
  // Byte-stable per role (prompt-cache friendly). All per-request content goes in `prompt`.
  system: string
  prompt: string
  tools: OrchTool<any>[]
  maxTurns: number
  signal: AbortSignal
  // Conversation key: lead runs of one orchestration share 'lead:<runId>'. An adapter MAY resume
  // the previous conversation with the same key (SDK `resume`), but prompts are self-contained.
  thread?: string
}

export type AgentEvent =
  // Assistant text. Events with the same id replace each other (streaming).
  | { type: 'text'; text: string; id?: string }
  | { type: 'tool_call'; name: string; input?: unknown }
  | { type: 'tool_result'; name?: string; text: string; isError?: boolean }
  // Usage DELTA since the previous usage event of this agent run.
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; message: string }
  // Final answer, when the adapter knows it (otherwise the last text is used).
  | { type: 'done'; text?: string }

export type RunAgent = (spec: AgentSpec) => AsyncIterable<AgentEvent>

// ---------------------------------------------------------------------------------------------
// Plans.

export interface PlanTask {
  id: string
  role: Exclude<Role, 'lead'>
  goal: string
  // Planned files. For writer roles (builder, tester) these are claimed (locked) when the task
  // starts; a path ending in "/" claims a folder. For read-only roles they are hints.
  files: string[]
  dependsOn: string[]
}

export interface Plan {
  tasks: PlanTask[]
  notes?: string
}

export type PlanValidation = { ok: true; plan: Plan; order: string[] } | { ok: false; errors: string[] }

// ---------------------------------------------------------------------------------------------
// Results and the task board.

export type ResultStatus = 'done' | 'partial' | 'failed'

// What a specialist reports (submit_result). This, never the transcript, is what the lead sees.
export interface TaskResult {
  status: ResultStatus
  summary: string
  filesChanged: string[]
  followups: string[]
}

export type TaskState = 'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled'

export interface TaskView {
  id: string
  runId: string
  role: Role
  goal: string
  state: TaskState
  // Why blocked/failed/cancelled, e.g. "waiting on t1", "timeout", "budget: ...".
  detail?: string
  model: string
  round: number
  dependsOn: string[]
  files: string[]
  // Files this task actually wrote (tracked by the write guard).
  filesChanged: string[]
  tokens: number
  costUsd: number
  summary?: string
  resultStatus?: ResultStatus
  followups?: string[]
  startedAt?: number
  finishedAt?: number
}

export type RunState = 'planning' | 'running' | 'integrating' | 'done' | 'failed' | 'cancelled'

export interface ChangeRequest {
  id: string
  taskId: string
  file: string
  change: string
  at: number
}

export interface BoardView {
  runId: string
  request: string
  state: RunState
  detail?: string
  round: number
  tasks: TaskView[]
  changeRequests: ChangeRequest[]
  tokens: number
  costUsd: number
  // Lead's final answer once done.
  answer?: string
  startedAt: number
  finishedAt?: number
}

export type OrchestratorEvent =
  | { type: 'board'; board: BoardView }
  | { type: 'task'; runId: string; task: TaskView }
  | { type: 'budget'; runId: string; taskId?: string; level: 'warn' | 'stop'; reason: string }
  | { type: 'change_request'; runId: string; request: ChangeRequest }
  | { type: 'finished'; runId: string; board: BoardView }

export interface RunResult {
  runId: string
  state: Extract<RunState, 'done' | 'failed' | 'cancelled'>
  answer?: string
  detail?: string
  board: BoardView
}

// ---------------------------------------------------------------------------------------------
// Settings.

export interface RoleSettings {
  model?: string
  maxTurns?: number
}

export interface OrchestratorSettings {
  maxParallel: number
  // Plan/execute/integrate rounds (the lead may re-plan after seeing results).
  maxRounds: number
  maxTasks: number
  // Invalid submit_plan calls the lead may retry before the run fails.
  maxPlanAttempts: number
  taskTimeoutMs: number
  // Cap on a specialist's summary as seen by the lead.
  maxSummaryTokens: number
  hotFiles: string[]
  roles: Partial<Record<Role, RoleSettings>>
}
