// The orchestration engine: lead plans (submit_plan) -> validated DAG of specialist tasks run with
// bounded parallelism, file claims and budgets -> lead integrates from compact results
// (submit_result), optionally re-plans (maxRounds) -> final answer.
//
// Provider-agnostic: every agent run goes through the injected runAgent(spec). The engine owns the
// tools that carry structure (submit_plan, submit_result, claim_files, request_change, run_diff)
// and wraps the base write tools with the lock guard, so enforcement does not depend on the model
// or the provider. The lead never sees a specialist's transcript: only its submit_result summary
// (clipped to maxSummaryTokens). Transcripts are kept per task for the UI (transcript()).

import { randomUUID } from 'node:crypto'
import type { ChatMessage, ProviderId } from '../../../shared/types.ts'
import { claimFilesTool, defaultWriteTargets, fail, guardWriteTool, ok, requestChangeTool, runDiffTool, submitPlanTool, submitResultTool, type WriteTargets } from './agentTools.ts'
import { addUsage, capsBudget, countTokens, emptyUsage } from './budget.ts'
import { LEAD_OWNER, LockManager } from './locks.ts'
import { planErrorText, planSummary, topoOrder, validatePlan } from './plan.ts'
import { classifyTool, mergeSettings, ROLE_DEFAULTS, roleMaxTurns, roleModel, toolsForRole, type TierModels } from './roles.ts'
import type {
  AgentEvent,
  AgentSpec,
  BoardView,
  BudgetChecker,
  ChangeRequest,
  OrchestratorEvent,
  OrchestratorSettings,
  OrchTool,
  Plan,
  PlanTask,
  Role,
  RunAgent,
  RunResult,
  RunState,
  TaskResult,
  TaskView,
  ToolClass,
  ToolFactory,
  ToolResult,
  Usage
} from './types.ts'

export interface OrchestratorDeps {
  runAgent: RunAgent
  // Base tools (gentree read/write, project map, search, Lune...) for one agent.
  tools: ToolFactory
  budget?: BudgetChecker
  emit?: (e: OrchestratorEvent) => void
  settings?: Partial<OrchestratorSettings> | (() => Partial<OrchestratorSettings> | undefined)
  classify?: (name: string) => ToolClass
  writeTargets?: WriteTargets
  // Unified diff of the given files (e.g. git diff); used by run_diff.
  diff?: (files: string[]) => Promise<string>
  now?: () => number
}

export interface StartOptions {
  request: string
  // The chat's chosen model: used for roles when no tier models are known (ollama, custom).
  model: string
  provider?: ProviderId
  // Cheap/big models for the provider (budget/budget.ts tiersFor()).
  tiers?: TierModels | null
  // Short project context for the lead's first prompt (e.g. the rendered project map).
  projectContext?: string
  runId?: string
}

export interface RunHandle {
  runId: string
  done: Promise<RunResult>
}

const MAX_RUNS = 20
const MAX_TRANSCRIPT = 400
const TOOL_PREVIEW_CHARS = 2000
const REQUEST_IN_TASK_CHARS = 2000

interface TaskRec {
  view: TaskView
  plan?: PlanTask
  abort: AbortController
  stopReason?: string
  transcript: ChatMessage[]
  usage: Usage
  result?: TaskResult
  lastText?: string
  finalText?: string
  error?: string
  warned?: boolean
  changed: Set<string>
}

interface RunRec {
  board: BoardView
  opts: StartOptions
  settings: OrchestratorSettings
  locks: LockManager
  tasks: Map<string, TaskRec>
  abort: AbortController
  cancelReason?: string
  cancelState?: 'cancelled' | 'failed'
  usage: Usage
  runWarned?: boolean
  changes: { file: string; taskId: string }[]
  boardQueued?: boolean
  done: Promise<RunResult>
}

// Rough token estimate (chars/4, rounded up) for clipping summaries.
export function clipToTokens(text: string, maxTokens: number): string {
  const max = Math.max(16, maxTokens) * 4
  const t = text.trim().replace(/\n{3,}/g, '\n\n')
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…'
}

export class Orchestrator {
  private deps: OrchestratorDeps
  private runs = new Map<string, RunRec>()
  private budget: BudgetChecker

  constructor(deps: OrchestratorDeps) {
    this.deps = deps
    this.budget = deps.budget ?? capsBudget()
  }

  // ------------------------------------------------------------------------------------------
  // Public API

  start(opts: StartOptions): RunHandle {
    const runId = opts.runId ?? `o-${randomUUID().slice(0, 8)}`
    if (this.runs.has(runId)) throw new Error(`run ${runId} exists`)
    const settings = mergeSettings(typeof this.deps.settings === 'function' ? this.deps.settings() : this.deps.settings)
    const run: RunRec = {
      board: { runId, request: opts.request, state: 'planning', round: 0, tasks: [], changeRequests: [], tokens: 0, costUsd: 0, startedAt: this.now() },
      opts,
      settings,
      locks: new LockManager(settings.hotFiles),
      tasks: new Map(),
      abort: new AbortController(),
      usage: emptyUsage(),
      changes: [],
      done: Promise.resolve(null as unknown as RunResult)
    }
    this.runs.set(runId, run)
    this.trim()
    run.done = this.drive(run)
    this.emitBoard(run)
    return { runId, done: run.done }
  }

  cancel(runId: string, reason = 'cancelled'): void {
    const run = this.runs.get(runId)
    if (run) this.cancelRun(run, reason, 'cancelled')
  }

  cancelAll(): void {
    for (const run of this.runs.values()) this.cancelRun(run, 'cancelled', 'cancelled')
  }

  // Cancels one specialist task (its dependents are cancelled too). Cancelling a lead task
  // cancels the run.
  cancelTask(runId: string, taskId: string): void {
    const run = this.runs.get(runId)
    const rec = run?.tasks.get(taskId)
    if (!run || !rec) return
    if (rec.view.role === 'lead') return this.cancelRun(run, 'cancelled', 'cancelled')
    if (rec.view.state === 'queued' || rec.view.state === 'blocked') {
      this.finishTask(run, rec, 'cancelled', 'cancelled by user')
      return
    }
    this.abortTask(rec, 'cancelled by user')
  }

  board(runId: string): BoardView | null {
    const run = this.runs.get(runId)
    return run ? this.snapshot(run) : null
  }

  list(): BoardView[] {
    return [...this.runs.values()].map((r) => this.snapshot(r))
  }

  // Full transcript of one task, for the UI on demand. Never fed to the lead.
  transcript(runId: string, taskId: string): ChatMessage[] | null {
    const rec = this.runs.get(runId)?.tasks.get(taskId)
    return rec ? rec.transcript.map((m) => ({ ...m })) : null
  }

  // ------------------------------------------------------------------------------------------
  // Run driver

  private async drive(run: RunRec): Promise<RunResult> {
    const s = run.settings
    try {
      run.board.round = 1
      const first = await this.leadPhase(run, 'plan', 1, true)
      if (this.isCancelled(run)) return this.finishRun(run, run.cancelState!, undefined, run.cancelReason)
      if (first.error) return this.finishRun(run, 'failed', first.answer, first.error)
      let plan = first.plan
      let answer = first.answer
      for (let round = 1; plan && round <= s.maxRounds; round++) {
        run.board.round = round
        this.setRunState(run, 'running')
        await this.executeRound(run, plan, round)
        if (this.isCancelled(run)) return this.finishRun(run, run.cancelState!, undefined, run.cancelReason)
        this.setRunState(run, 'integrating')
        const next = await this.leadPhase(run, 'integrate', round, round < s.maxRounds)
        if (this.isCancelled(run)) return this.finishRun(run, run.cancelState!, undefined, run.cancelReason)
        if (next.error) return this.finishRun(run, 'failed', next.answer, next.error)
        answer = next.answer
        plan = next.plan
      }
      return this.finishRun(run, 'done', answer)
    } catch (e) {
      return this.finishRun(run, 'failed', undefined, (e as Error).message)
    }
  }

  private isCancelled(run: RunRec): boolean {
    return run.abort.signal.aborted
  }

  // One lead run. 'plan': read tools + submit_plan. 'integrate': read + guarded write tools
  // (lead owner: may edit hot files) + submit_plan when another round is allowed.
  private async leadPhase(run: RunRec, phase: 'plan' | 'integrate', round: number, allowPlan: boolean): Promise<{ plan?: Plan; answer?: string; error?: string }> {
    const s = run.settings
    const id = phase === 'plan' ? 'lead-plan' : `lead-int-${round}`
    const rec = this.newTask(run, { id, role: 'lead', goal: phase === 'plan' ? 'Plan the work' : `Integrate round ${round}`, files: [], dependsOn: [] }, round)
    let accepted: Plan | undefined
    let attempts = 0
    let exhausted = false

    const base = this.deps.tools({ runId: run.board.runId, taskId: id, role: 'lead' })
    const tools: OrchTool<any>[] = toolsForRole('lead', base, this.classify)
    if (phase === 'integrate') tools.push(...this.writeTools(run, rec, LEAD_OWNER, base, 'lead-all'))
    tools.push(runDiffTool(() => [...run.changes], this.deps.diff))
    if (allowPlan) {
      tools.push(
        submitPlanTool((input) => {
          if (accepted) return fail('a plan was already accepted; end your turn')
          if (exhausted) return fail('too many invalid plans; end your turn')
          const v = validatePlan(input, { maxTasks: s.maxTasks, hotFiles: s.hotFiles, takenIds: run.tasks.keys() })
          if (!v.ok) {
            attempts++
            if (attempts >= s.maxPlanAttempts) exhausted = true
            return fail(planErrorText(v.errors) + (exhausted ? '\nNo attempts left.' : ''))
          }
          accepted = v.plan
          return ok(`Plan accepted (${v.plan.tasks.length} tasks, order ${v.order.join(', ')}). End your turn now; you will get each task's result.`)
        })
      )
    }

    const prompt = phase === 'plan' ? this.planPrompt(run) : this.integratePrompt(run, round, allowPlan)
    this.markRunning(run, rec)
    const out = await this.consume(run, rec, this.spec(run, rec, 'lead', tools, prompt))
    const answer = rec.finalText ?? rec.lastText
    if (rec.stopReason) {
      this.finishTask(run, rec, rec.stopReason === 'cancelled' ? 'cancelled' : 'failed', rec.stopReason)
      return { error: `lead ${phase}: ${rec.stopReason}`, answer }
    }
    const err = out.error ?? rec.error
    if (err && !accepted) {
      this.finishTask(run, rec, 'failed', err)
      return { error: `lead ${phase}: ${err}`, answer }
    }
    if (exhausted && !accepted && phase === 'plan') {
      this.finishTask(run, rec, 'failed', 'no valid plan')
      return { error: 'the lead could not produce a valid plan', answer }
    }
    rec.view.summary = accepted ? clipToTokens(planSummary(accepted), s.maxSummaryTokens) : answer ? clipToTokens(answer, s.maxSummaryTokens) : undefined
    this.finishTask(run, rec, 'done')
    return { plan: accepted, answer }
  }

  private planPrompt(run: RunRec): string {
    const s = run.settings
    const ctx = run.opts.projectContext?.trim()
    return [
      `User request:\n${run.opts.request.trim()}`,
      ctx ? `Project context:\n${ctx}` : '',
      `Plan with submit_plan (at most ${s.maxTasks} tasks; up to ${s.maxParallel} run at once), or answer directly if no delegation is needed.`
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  private integratePrompt(run: RunRec, round: number, allowPlan: boolean): string {
    const lines: string[] = [`User request:\n${run.opts.request.trim()}`, `Results so far (compact summaries; specialist transcripts are not available):`]
    for (const rec of run.tasks.values()) {
      if (rec.view.role === 'lead') continue
      lines.push(this.resultLine(rec))
    }
    const crs = run.board.changeRequests
    if (crs.length) {
      lines.push(`Change requests for you to apply:`)
      for (const c of crs) lines.push(`- ${c.id} from ${c.taskId}: ${c.file}: ${c.change}`)
    }
    lines.push(
      `Round ${round} finished. Apply the change requests, fix small gaps yourself (no task is running, so you may edit any file), then answer the user briefly.` +
        (allowPlan ? ' Call submit_plan with NEW task ids only if substantial work remains.' : ' No more rounds: finish the remaining work yourself.')
    )
    return lines.join('\n')
  }

  // The compact line the lead sees for one task.
  private resultLine(rec: TaskRec): string {
    const v = rec.view
    const status = v.resultStatus ?? v.state
    const parts = [`- ${v.id} [${v.role}] ${status}${v.detail && v.state !== 'done' ? ` (${v.detail})` : ''}: ${v.summary ?? '(no summary)'}`]
    if (v.filesChanged.length) parts.push(`  changed: ${v.filesChanged.join(', ')}`)
    if (v.followups?.length) parts.push(`  followups: ${v.followups.join('; ')}`)
    return parts.join('\n')
  }

  // ------------------------------------------------------------------------------------------
  // DAG execution

  private executeRound(run: RunRec, plan: Plan, round: number): Promise<void> {
    const order = topoOrder(plan.tasks)
    const byId = new Map(plan.tasks.map((t) => [t.id, t]))
    const recs = order.map((id) => this.newTask(run, byId.get(id)!, round))
    for (const rec of recs) {
      const waiting = rec.view.dependsOn.filter((d) => recs.some((r) => r.view.id === d))
      if (waiting.length) this.setTask(run, rec, { state: 'blocked', detail: `waiting on ${waiting.join(', ')}` })
    }
    let active = 0
    return new Promise<void>((resolve) => {
      const pump = () => {
        const cancelled = this.isCancelled(run)
        for (const rec of recs) {
          const st = rec.view.state
          if (st !== 'queued' && st !== 'blocked') continue
          if (cancelled) {
            this.finishTask(run, rec, 'cancelled', run.cancelReason ?? 'cancelled')
            continue
          }
          const deps = rec.view.dependsOn.map((d) => run.tasks.get(d)).filter((d): d is TaskRec => !!d)
          const bad = deps.find((d) => d.view.state === 'failed' || d.view.state === 'cancelled')
          if (bad) {
            this.finishTask(run, rec, 'cancelled', `dependency ${bad.view.id} ${bad.view.state}`)
            continue
          }
          const pending = deps.filter((d) => d.view.state !== 'done').map((d) => d.view.id)
          if (pending.length) {
            const detail = `waiting on ${pending.join(', ')}`
            if (st !== 'blocked' || rec.view.detail !== detail) this.setTask(run, rec, { state: 'blocked', detail })
          } else if (st === 'blocked' && rec.view.detail?.startsWith('waiting on ')) {
            this.setTask(run, rec, { state: 'queued', detail: undefined })
          }
        }
        if (!cancelled) {
          for (const rec of recs) {
            if (active >= run.settings.maxParallel) break
            const lockWait = rec.view.state === 'blocked' && rec.view.detail?.startsWith('waiting for lock')
            if (rec.view.state !== 'queued' && !lockWait) continue
            if (ROLE_DEFAULTS[rec.view.role].writer && rec.view.files.length) {
              const c = run.locks.claim(rec.view.id, rec.view.files)
              if (!c.ok) {
                const why = [...c.conflicts.map((x) => `${x.path} (${x.owner})`), ...c.hot, ...c.invalid].join(', ')
                const detail = `waiting for lock on ${why}`
                if (rec.view.detail !== detail) this.setTask(run, rec, { state: 'blocked', detail })
                continue
              }
            }
            active++
            void this.runSpecialist(run, rec)
              .catch((e) => this.finishTask(run, rec, 'failed', (e as Error)?.message ?? String(e)))
              .finally(() => {
              active--
              run.locks.release(rec.view.id)
              pump()
            })
          }
        }
        const open = recs.filter((r) => ['queued', 'blocked', 'running'].includes(r.view.state))
        if (active === 0 && open.length) {
          // Nothing running yet tasks remain: only possible with a lock held outside this round.
          for (const r of open) this.finishTask(run, r, 'failed', `could not start: ${r.view.detail ?? 'deadlock'}`)
        }
        if (active === 0) resolve()
      }
      pump()
    })
  }

  private async runSpecialist(run: RunRec, rec: TaskRec): Promise<void> {
    const role = rec.view.role as Exclude<Role, 'lead'>
    const d = ROLE_DEFAULTS[role]
    const base = this.deps.tools({ runId: run.board.runId, taskId: rec.view.id, role })
    const tools: OrchTool<any>[] = toolsForRole(role, base, this.classify).filter((t) => this.classify(t.name) !== 'write')
    if (d.writer) {
      tools.push(...this.writeTools(run, rec, rec.view.id, base, role))
      tools.push(claimFilesTool(run.locks, rec.view.id, (files) => this.setTask(run, rec, { files: [...new Set([...rec.view.files, ...files])] })))
      tools.push(
        requestChangeTool((file, change) => {
          const cr: ChangeRequest = { id: `cr${run.board.changeRequests.length + 1}`, taskId: rec.view.id, file, change, at: this.now() }
          run.board.changeRequests.push(cr)
          this.emit({ type: 'change_request', runId: run.board.runId, request: { ...cr } })
          this.emitBoard(run)
          return ok(`queued ${cr.id} for the lead; continue without it`)
        })
      )
    }
    if (d.classes.includes('diff')) tools.push(runDiffTool(() => [...run.changes], this.deps.diff))
    tools.push(
      submitResultTool((r) => {
        if (rec.result) return fail('result already submitted; end your turn')
        rec.result = { status: r.status, summary: clipToTokens(r.summary, run.settings.maxSummaryTokens), filesChanged: r.filesChanged, followups: r.followups.slice(0, 8).map((f) => clipToTokens(f, 60)) }
        return ok('result recorded; end your turn')
      })
    )

    this.markRunning(run, rec)
    const out = await this.consume(run, rec, this.spec(run, rec, role, tools, this.taskPrompt(run, rec)))
    if (rec.stopReason) return this.finishTask(run, rec, rec.stopReason === 'cancelled' || rec.stopReason === 'cancelled by user' ? 'cancelled' : 'failed', rec.stopReason)
    const err = out.error ?? rec.error
    if (err && !rec.result) return this.finishTask(run, rec, 'failed', err)
    if (!rec.result) {
      const text = rec.finalText ?? rec.lastText ?? ''
      rec.result = { status: 'partial', summary: clipToTokens(text || 'ended without submit_result', run.settings.maxSummaryTokens), filesChanged: [], followups: [] }
    }
    const r = rec.result
    rec.view.summary = r.summary
    rec.view.resultStatus = r.status
    rec.view.followups = r.followups
    this.finishTask(run, rec, r.status === 'failed' ? 'failed' : 'done', r.status === 'failed' ? 'reported failure' : undefined)
  }

  private taskPrompt(run: RunRec, rec: TaskRec): string {
    const v = rec.view
    const writer = ROLE_DEFAULTS[v.role].writer
    const req = run.opts.request.trim()
    const lines = [
      `Task ${v.id} (${v.role}).`,
      `User request, for context only:\n${req.length > REQUEST_IN_TASK_CHARS ? req.slice(0, REQUEST_IN_TASK_CHARS) + '…' : req}`,
      `Your goal:\n${v.goal}`
    ]
    if (v.files.length) lines.push(writer ? `Files claimed for you (the only files you may write): ${v.files.join(', ')}` : `Files of interest: ${v.files.join(', ')}`)
    const deps = v.dependsOn.map((d) => run.tasks.get(d)).filter((d): d is TaskRec => !!d)
    if (deps.length) lines.push(`Results of the tasks you depend on:\n${deps.map((d) => this.resultLine(d)).join('\n')}`)
    return lines.join('\n\n')
  }

  // Base write tools wrapped with the lock guard for owner. 'lead-all' gives every write tool.
  private writeTools(run: RunRec, rec: TaskRec, owner: string, base: OrchTool<any>[], role: Role | 'lead-all'): OrchTool<any>[] {
    const allow = role === 'lead-all' ? undefined : ROLE_DEFAULTS[role].writeTools
    return base
      .filter((t) => this.classify(t.name) === 'write' && (!allow || allow.includes(t.name)))
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((t) =>
        guardWriteTool(t, owner, run.locks, this.deps.writeTargets ?? defaultWriteTargets, (files) => {
          for (const f of files) {
            rec.changed.add(f)
            if (!run.changes.some((c) => c.file === f && c.taskId === rec.view.id)) run.changes.push({ file: f, taskId: rec.view.id })
          }
          this.setTask(run, rec, { filesChanged: [...rec.changed] })
        })
      )
  }

  // ------------------------------------------------------------------------------------------
  // Agent runs

  private spec(run: RunRec, rec: TaskRec, role: Role, tools: OrchTool<any>[], prompt: string): AgentSpec {
    return {
      runId: run.board.runId,
      taskId: rec.view.id,
      role,
      ...(run.opts.provider ? { provider: run.opts.provider } : {}),
      model: rec.view.model,
      system: ROLE_DEFAULTS[role].system,
      prompt,
      tools,
      maxTurns: roleMaxTurns(role, run.settings),
      signal: rec.abort.signal,
      ...(role === 'lead' ? { thread: `lead:${run.board.runId}` } : {})
    }
  }

  // Drains runAgent's events with timeout, budget checks and cancellation. A runner that ignores
  // the abort signal is abandoned (its iterator's return() is called, not awaited).
  private async consume(run: RunRec, rec: TaskRec, spec: AgentSpec): Promise<{ error?: string }> {
    const signal = rec.abort.signal
    const timer = setTimeout(() => this.abortTask(rec, `timeout after ${Math.round(run.settings.taskTimeoutMs / 1000)}s`), run.settings.taskTimeoutMs)
    const aborted = new Promise<'aborted'>((res) => {
      if (signal.aborted) res('aborted')
      else signal.addEventListener('abort', () => res('aborted'), { once: true })
    })
    let iter: AsyncIterator<AgentEvent> | undefined
    try {
      iter = this.deps.runAgent(spec)[Symbol.asyncIterator]()
      while (true) {
        const next = iter.next()
        next.catch(() => {})
        const r = await Promise.race([next, aborted])
        if (r === 'aborted') {
          void Promise.resolve(iter.return?.()).catch(() => {})
          return {}
        }
        if (r.done) return {}
        this.onEvent(run, rec, r.value)
        if (signal.aborted) {
          void Promise.resolve(iter.return?.()).catch(() => {})
          return {}
        }
      }
    } catch (e) {
      if (signal.aborted) return {}
      const message = (e as Error)?.message ?? String(e)
      this.pushMessage(rec, 'system', `Error: ${message}`)
      return { error: message }
    } finally {
      clearTimeout(timer)
    }
  }

  private onEvent(run: RunRec, rec: TaskRec, e: AgentEvent): void {
    switch (e.type) {
      case 'text': {
        if (!e.text?.trim()) return
        rec.lastText = e.text
        this.pushMessage(rec, 'assistant', e.text, undefined, e.id ? `${rec.view.id}:${e.id}` : undefined)
        return
      }
      case 'tool_call':
        this.pushMessage(rec, 'tool', e.name, { name: e.name, input: preview(e.input) })
        return
      case 'tool_result':
        if (e.isError) this.pushMessage(rec, 'system', `${e.name ?? 'tool'}: ${String(e.text).slice(0, TOOL_PREVIEW_CHARS)}`)
        return
      case 'error':
        rec.error = e.message
        this.pushMessage(rec, 'system', `Error: ${e.message}`)
        return
      case 'done':
        if (e.text?.trim()) {
          rec.finalText = e.text
          if (e.text !== rec.lastText) this.pushMessage(rec, 'assistant', e.text)
        }
        return
      case 'usage':
        return this.onUsage(run, rec, e.usage)
    }
  }

  private onUsage(run: RunRec, rec: TaskRec, delta: Usage): void {
    rec.usage = addUsage(rec.usage, delta)
    run.usage = addUsage(run.usage, delta)
    rec.view.tokens = countTokens(rec.usage)
    rec.view.costUsd = rec.usage.costUsd ?? 0
    run.board.tokens = countTokens(run.usage)
    run.board.costUsd = run.usage.costUsd ?? 0
    this.emitTask(run, rec)

    const t = this.budget.check(rec.usage, { kind: 'task', runId: run.board.runId, taskId: rec.view.id, role: rec.view.role, model: rec.view.model })
    if (t.level === 'stop') {
      const reason = `budget: ${t.reason ?? 'task cap reached'}`
      this.emit({ type: 'budget', runId: run.board.runId, taskId: rec.view.id, level: 'stop', reason })
      this.abortTask(rec, reason)
    } else if (t.level === 'warn' && !rec.warned) {
      rec.warned = true
      this.emit({ type: 'budget', runId: run.board.runId, taskId: rec.view.id, level: 'warn', reason: t.reason ?? 'task near its cap' })
    }
    const r = this.budget.check(run.usage, { kind: 'run', runId: run.board.runId })
    if (r.level === 'stop') {
      const reason = `budget: ${r.reason ?? 'run cap reached'}`
      this.emit({ type: 'budget', runId: run.board.runId, level: 'stop', reason })
      this.cancelRun(run, reason, 'failed')
    } else if (r.level === 'warn' && !run.runWarned) {
      run.runWarned = true
      this.emit({ type: 'budget', runId: run.board.runId, level: 'warn', reason: r.reason ?? 'run near its cap' })
    }
  }

  // ------------------------------------------------------------------------------------------
  // State helpers

  private newTask(run: RunRec, t: PlanTask | (Omit<PlanTask, 'role'> & { role: 'lead' }), round: number): TaskRec {
    const role = t.role as Role
    const rec: TaskRec = {
      view: {
        id: t.id,
        runId: run.board.runId,
        role,
        goal: t.goal,
        state: 'queued',
        model: roleModel(role, run.settings, run.opts.tiers ?? null, run.opts.model),
        round,
        dependsOn: [...t.dependsOn],
        files: [...t.files],
        filesChanged: [],
        tokens: 0,
        costUsd: 0
      },
      ...(role !== 'lead' ? { plan: t as PlanTask } : {}),
      abort: new AbortController(),
      transcript: [],
      usage: emptyUsage(),
      changed: new Set()
    }
    const onRunAbort = () => this.abortTask(rec, run.cancelReason ?? 'cancelled')
    run.abort.signal.addEventListener('abort', onRunAbort, { once: true })
    run.tasks.set(t.id, rec)
    this.emitTask(run, rec)
    return rec
  }

  private abortTask(rec: TaskRec, reason: string): void {
    if (rec.abort.signal.aborted) return
    rec.stopReason ??= reason
    rec.abort.abort()
  }

  private cancelRun(run: RunRec, reason: string, state: 'cancelled' | 'failed'): void {
    if (run.abort.signal.aborted || ['done', 'failed', 'cancelled'].includes(run.board.state)) return
    run.cancelReason = reason
    run.cancelState = state
    run.abort.abort()
  }

  private markRunning(run: RunRec, rec: TaskRec): void {
    this.setTask(run, rec, { state: 'running', detail: undefined, startedAt: this.now() })
  }

  private finishTask(run: RunRec, rec: TaskRec, state: 'done' | 'failed' | 'cancelled', detail?: string): void {
    run.locks.release(rec.view.id)
    this.setTask(run, rec, { state, detail, finishedAt: this.now() })
  }

  private setTask(run: RunRec, rec: TaskRec, patch: Partial<TaskView>): void {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete (rec.view as unknown as Record<string, unknown>)[k]
      else (rec.view as unknown as Record<string, unknown>)[k] = v
    }
    this.emitTask(run, rec)
  }

  private setRunState(run: RunRec, state: RunState, detail?: string): void {
    run.board.state = state
    if (detail) run.board.detail = detail
    else delete run.board.detail
    this.emitBoard(run)
  }

  private finishRun(run: RunRec, state: RunResult['state'], answer?: string, detail?: string): RunResult {
    // Any task still open (e.g. lead aborted mid-round) ends as cancelled.
    for (const rec of run.tasks.values()) {
      if (['queued', 'blocked', 'running'].includes(rec.view.state)) this.finishTask(run, rec, 'cancelled', detail ?? 'run ended')
    }
    run.locks.releaseAll()
    if (answer?.trim()) run.board.answer = answer.trim()
    run.board.finishedAt = this.now()
    this.setRunState(run, state, detail)
    const board = this.snapshot(run)
    this.emit({ type: 'finished', runId: run.board.runId, board })
    return { runId: run.board.runId, state, ...(board.answer ? { answer: board.answer } : {}), ...(detail ? { detail } : {}), board }
  }

  private pushMessage(rec: TaskRec, role: ChatMessage['role'], text: string, tool?: ChatMessage['tool'], id?: string): void {
    const m: ChatMessage = { id: id ?? randomUUID(), role, text, at: this.now(), agentId: `orch:${rec.view.runId}:${rec.view.id}`, ...(tool ? { tool } : {}) }
    const i = id ? rec.transcript.findIndex((x) => x.id === id) : -1
    if (i >= 0) rec.transcript[i] = m
    else {
      rec.transcript.push(m)
      if (rec.transcript.length > MAX_TRANSCRIPT) rec.transcript.splice(0, rec.transcript.length - MAX_TRANSCRIPT)
    }
  }

  private snapshot(run: RunRec): BoardView {
    return {
      ...run.board,
      tasks: [...run.tasks.values()].map((r) => ({ ...r.view, dependsOn: [...r.view.dependsOn], files: [...r.view.files], filesChanged: [...r.view.filesChanged] })),
      changeRequests: run.board.changeRequests.map((c) => ({ ...c }))
    }
  }

  private emitTask(run: RunRec, rec: TaskRec): void {
    this.emit({ type: 'task', runId: run.board.runId, task: { ...rec.view, dependsOn: [...rec.view.dependsOn], files: [...rec.view.files], filesChanged: [...rec.view.filesChanged] } })
    this.emitBoard(run)
  }

  // Board snapshots are coalesced to one per microtask.
  private emitBoard(run: RunRec): void {
    if (run.boardQueued) return
    run.boardQueued = true
    queueMicrotask(() => {
      run.boardQueued = false
      this.emit({ type: 'board', board: this.snapshot(run) })
    })
  }

  private emit(e: OrchestratorEvent): void {
    try {
      this.deps.emit?.(e)
    } catch {
      // A UI listener must not break the run.
    }
  }

  private classify = (name: string): ToolClass => (this.deps.classify ?? classifyTool)(name)

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private trim(): void {
    if (this.runs.size <= MAX_RUNS) return
    for (const [id, r] of this.runs) {
      if (this.runs.size <= MAX_RUNS) break
      if (['done', 'failed', 'cancelled'].includes(r.board.state)) this.runs.delete(id)
    }
  }
}

function preview(input: unknown): string {
  if (input === undefined) return ''
  let s: string
  try {
    s = typeof input === 'string' ? input : JSON.stringify(input)
  } catch {
    s = String(input)
  }
  s = (s ?? '').replace(/\s+/g, ' ')
  return s.length > 200 ? s.slice(0, 197) + '...' : s
}

export type { ToolResult }
