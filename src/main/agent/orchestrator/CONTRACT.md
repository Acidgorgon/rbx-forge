# Orchestrator contract (for the integrator)

Multi-agent orchestration for the Forge AI layer. Everything here lives in
`src/main/agent/orchestrator/` and is new; no existing file was changed. The engine is
provider-agnostic and Electron-free (tests: `test/orchestrator.test.ts`,
`test/orchestratorAdapters.test.ts`).

## 1. Files

| File | What |
|---|---|
| `types.ts` | All public types: `Role`, `AgentSpec`, `AgentEvent`, `RunAgent`, `OrchTool`, `ToolFactory`, `Plan`/`PlanTask`, `TaskView`, `BoardView`, `OrchestratorEvent`, `BudgetChecker`, `OrchestratorSettings`. |
| `engine.ts` | `Orchestrator` class: lead planning, DAG execution, integration rounds, budgets, cancel/timeout, events, transcripts. |
| `plan.ts` | `validatePlan`, `findCycle`, `topoOrder`, `ancestors`. |
| `locks.ts` | `LockManager` (in-process file claims, hot files), `normalizePath`. |
| `agentTools.ts` | Engine tools `submit_plan`, `submit_result`, `claim_files`, `request_change`, `run_diff`; `guardWriteTool` (lock-checked wrapper for base write tools). |
| `roles.ts` | Role defaults (tier, tool classes, max turns), the byte-stable role prompts, `classifyTool`, `toolsForRole`, `roleModel`, default settings. |
| `budget.ts` | `capsBudget()` default checker (per-task and per-run token/cost caps). |
| `heuristic.ts` | `shouldOrchestrate(request, projectHint, mode)` for auto mode. |
| `adapters.ts` | `sdkRunAgent` (Claude Agent SDK) and `openAiRunAgent` (OpenAI-compatible loop) adapters; `sdkToEvents`; `channel`. |
| `index.ts` | Re-exports. |

## 2. How a run works

1. **Plan.** Task `lead-plan` (role lead, big model) gets read tools, `run_diff` and `submit_plan`.
   It either answers directly (no plan: the run ends `done` with that answer) or calls
   `submit_plan({tasks:[{id, role, goal, files, dependsOn}], notes?})`. Invalid plans are returned
   to the lead as a tool error listing every problem; after `maxPlanAttempts` invalid plans the run
   fails.
2. **Validate.** Specialist roles only; unique ids; non-empty goals; known deps; no cycles
   (reported as `a -> c -> b -> a`); writer roles (builder, tester) may not list hot files;
   builders need ≥1 file; **two writer tasks whose files overlap are rejected unless one
   (transitively) depends on the other** (claims are held for a task's whole run, so ordered
   overlap is safe). Paths are normalized; `../` and absolute paths are rejected; a trailing `/`
   is a folder claim.
3. **Execute.** Topological order, at most `maxParallel` tasks at once. Tasks with unmet deps are
   `blocked` ("waiting on a, b"). Writer tasks claim their files when they start (all-or-nothing);
   a claim conflict leaves the task `blocked` ("waiting for lock on …") until the owner finishes.
   A failed/cancelled task cancels its dependents ("dependency a failed"); independent tasks go on.
   Each specialist's prompt = its goal, its claimed files, a clipped copy of the user request, and
   the compact results of the tasks it depends on.
4. **Results.** A specialist ends with `submit_result({status: done|partial|failed, summary,
   filesChanged?, followups?})`. The summary is clipped to `maxSummaryTokens` (≈4 chars/token),
   followups to 8 × ~60 tokens. No `submit_result` → status `partial` with its last text, clipped.
   `filesChanged` on the board comes from the write guard (what was actually written), not from
   the model's claim.
5. **Integrate.** Task `lead-int-<round>` gets ONLY the compact result lines and the queued change
   requests (never transcripts), read tools, `run_diff`, and lock-guarded write tools as owner
   `lead` (may edit hot files; nothing else is running). It may call `submit_plan` again (new ids;
   deps on earlier tasks allowed) while `round < maxRounds`; otherwise it finishes and its last
   text is the run's `answer`.

Lead runs share `spec.thread = "lead:<runId>"`; prompts are self-contained, so adapters need not
resume (the SDK adapter can, with `resumeThreads: true`).

## 3. Roles (defaults; override model/maxTurns per role in settings)

| Role | Tier | Tools | Writes | Max turns |
|---|---|---|---|---|
| lead | big | read, diff, `run_diff`, `submit_plan`; at integration also all write tools (owner `lead`) | integration only | 40 |
| scout | cheap | read (project map, search, read) + `submit_result` | no | 20 |
| builder | big | read + all write-class tools (guarded) + `claim_files`, `request_change`, `submit_result` | claimed files | 40 |
| tester | cheap | read + test (`run_tests`, `lune_*`) + `create_spec` only (guarded) + `claim_files`, `request_change`, `submit_result` | claimed spec files | 25 |
| reviewer | cheap | read + diff + `run_diff` + `submit_result` | no | 15 |

Model per role: `settings.roles[role].model` → tier model from `StartOptions.tiers` (use
`budget/budget.ts tiersFor()`; Anthropic = Haiku 5.5 / Opus 5.5) → the chat's chosen model
(ollama/custom).

Role prompts (`LEAD_PROMPT`, `SCOUT_PROMPT`, …) are constants: identical bytes on every run, and
tools are handed out name-sorted, so the system prefix + tool list are cacheable per role. All
per-request content is in the user prompt. Do not interpolate dates/paths into them.

Tool classes come from `classifyTool(name)` (prefix-insensitive): `write` = write_script,
edit_script, new_feature, create_spec, Write/Edit/MultiEdit/NotebookEdit; `admin` = sync_collaborators,
resolve_studio_conflict, restart_service, Bash (given to no orchestrated agent); `test` = run_tests,
run_spec, list_specs, `lune_*`; `diff` = diff, git_diff, changed_files; everything else `read`.
**Any new mutating tool must be classified** (pass `deps.classify`) or it would be handed out as read.

## 4. Locks and hot files

- `LockManager(hotFiles)`; default hot files: `events.blink`, `wally.toml`, `default.project.json`
  (setting `hotFiles`). Only owner `lead` writes them; tasks use `request_change(file, change)`,
  which queues a `ChangeRequest` (board + `change_request` event) for the lead's integration prompt.
- Base write tools are wrapped by `guardWriteTool`: targets come from `deps.writeTargets`
  (default: `path` / `file_path` / `file` / `notebook_path`; `new_feature{name}` →
  `src/shared/Features/<Name>/`). Unknown targets are refused (fail closed). **If the Lune worker's
  `create_spec` names its file differently, pass a `writeTargets` that maps it.**
- `claim_files(files)` lets a builder/tester take NEW files nobody owns (not hot files).
- The guard runs before the base tool's own checks (`checkWritable`: src/ only, no Packages/), so
  both apply.
- Claims are released when the task ends (any state) and all at run end.

## 5. Budgets, cancel, timeout

- `deps.budget: BudgetChecker` — `check(usage, scope) → {level: ok|warn|stop, reason?}` with
  `scope = {kind:'task', runId, taskId, role, model} | {kind:'run', runId}` and `usage` the scope's
  cumulative usage (same shape as `budget/usage.ts Usage`). Called on every `usage` event.
  Task `stop` → that task aborts and ends `failed` ("budget: …"); run `stop` → every task aborts,
  run ends `failed` with no integration. `warn` emits one `budget` event per scope.
- Default: `capsBudget({taskMaxTokens: 400k, taskMaxCostUsd: 2, runMaxTokens: 2M, runMaxCostUsd: 10, warnAt: 0.8})`, effective-token metric as in `budget/budget.ts`.
- To use the token worker's ledger instead: record usage events to the `UsageLedger` with
  `agentId = "orch:<runId>:<taskId>"` and wrap `BudgetGuard.check({agentId}, live)` (task scope)
  plus a run-level cap; map `BudgetCheck.level/reason` 1:1. Also pass
  `guard.sdkOptions('agent')` (`maxBudgetUsd`) through `baseOptions` for a native SDK cost stop.
- `taskTimeoutMs` (default 10 min) aborts a task ("timeout after Ns", state `failed`). The engine
  stops reading an agent that ignores its abort signal (iterator abandoned, `return()` called).
- `cancel(runId)`, `cancelTask(runId, taskId)` (dependents cancelled; cancelling a lead task
  cancels the run), `cancelAll()` (call from `AgentLayer.dispose`).

## 6. Wiring (main process)

```ts
import { Orchestrator, sdkRunAgent, openAiRunAgent, shouldOrchestrate, capsBudget } from './orchestrator/index.ts'

const runAgent: RunAgent = (spec) =>
  spec.provider === 'anthropic' || !spec.provider
    ? sdkRunAgent({
        query: deps.queryFn ?? sdkQuery,
        makeServer: (tools) => wrapInSdkServer(tools),          // tools.ts; server key must match serverName ('forge' default) – pass serverName: SERVER_NAME if you reuse 'gentree'
        baseOptions: (spec) => ({ cwd: root, env: auth.env, ...executableOption(), ...guard.sdkOptions('agent') }),
      })(spec)
    : openAiRunAgent({ loop: runOpenAiLoop, endpoint: (s) => providers.endpoint(s.provider!), systemSuffix: OPENAI_TOOLS_NOTE })(spec)

const orchestrator = new Orchestrator({
  runAgent,
  tools: ({ role }) => [...gentreeTools(ctx, { fs }), ...projectMapTools, ...searchTools, ...luneTools],
  budget: capsBudget(ctx.getSetting('orchestratorCaps', {})),
  settings: () => ctx.getSetting('orchestrator', {}),
  diff: (files) => git.diff(files),                         // optional; run_diff lists files without it
  emit: (e) => ctx.emit('orchestrator:event', e),
})
```

Notes:
- Build ONE runAgent per run (auth/env resolved once); the SDK adapter keeps a thread→session map.
- The SDK adapter sets `tools: ['Read','Glob','Grep']`, disallows `Agent, Task, Edit, Write,
  MultiEdit, NotebookEdit, Bash, WebFetch, WebSearch`, `strictMcpConfig`, `settingSources: []`, and
  a `canUseTool` that denies anything not pre-allowed. Studio MCP for testers: add it via
  `baseOptions` (`mcpServers` + `allowedTools`) for the tester role only, and respect the existing
  single "Studio slot" idea from `testAgents.ts` if testers run in parallel.
- `openAiRunAgent` passes `onUsage` to the loop; today's `runOpenAiLoop` ignores it, so until the
  loop reports usage, OpenAI-path budgets only see timeouts/turn caps. It also passes
  `stop: () => submitted` so the loop ends right after `submit_result` / an accepted `submit_plan`.
- `deps.tools` is called once per agent run; return fresh tool objects if they hold state.

## 7. Auto mode (chat integration)

`shouldOrchestrate(text, { scriptCount }, mode)` → `{orchestrate, reason, score}`.
- `mode`: `'team'` / `'single'` override (UI toggle, per chat); `'auto'` (default) uses rules.
- Wording overrides: "orchestrate", "use a team/agents", "multi-agent", "in parallel" → team;
  "single agent", "no team", "just you", "solo" → single.
- Score: ≥3 list items (+3/+4), ≥3 distinct action verbs (+2..3), ≥3 file/module mentions (+2/+3),
  scope words like system/feature/end-to-end/every service (+1..2), chained steps (+1), long
  request (+1/+2); short question (−3); project with <8 scripts (−1). Team at score ≥ 4.

Suggested `ChatManager.send` flow: if `shouldOrchestrate(...).orchestrate`, push a system
message `Team mode: <reason>` and start a run; post board updates via events, and when `finished`
arrives push the `answer` (or the failure detail) as the chat's assistant message. Store
`{runId}` on the chat so the UI can show the board inline. Remember the mode per chat
(`ChatSession.orchestrate?: 'auto' | 'single' | 'team'`).

## 8. Shared types / IPC / events to add (src/shared/types.ts, agent/index.ts, preload)

Re-export from shared (copy the types or move `orchestrator/types.ts` board types into shared):
`Role`, `TaskState`, `RunState`, `TaskView`, `BoardView`, `ChangeRequest`, `OrchestratorEvent`,
`OrchestratorSettings`.

HarnessEvents:
```ts
'orchestrator:event': OrchestratorEvent   // board snapshots (coalesced per microtask), task updates, budget warn/stop, change requests, finished
```

HarnessApi (IPC `harness:<name>`):
```ts
startOrchestration(chatId: string, text: string, choice?: ModelChoice): Promise<BoardView>  // or via sendChat when auto mode picks team
getOrchestrations(): Promise<BoardView[]>
getTaskTranscript(runId: string, taskId: string): Promise<ChatMessage[]>   // on demand only
cancelOrchestration(runId: string): Promise<void>
cancelOrchestrationTask(runId: string, taskId: string): Promise<void>
getOrchestrateMode(chatId: string): Promise<'auto' | 'single' | 'team'>
setOrchestrateMode(chatId: string, mode: 'auto' | 'single' | 'team'): Promise<void>
```
Map 1:1 to `orchestrator.start/list/board/transcript/cancel/cancelTask`. `getChat(id)` could also
accept `orch:<runId>:<taskId>` (transcript messages carry that `agentId`).

Settings keys: `orchestrator` (`Partial<OrchestratorSettings>`: maxParallel 3, maxRounds 2,
maxTasks 12, maxPlanAttempts 3, taskTimeoutMs 600000, maxSummaryTokens 300, hotFiles, roles
{[role]: {model?, maxTurns?}}), `orchestratorCaps` (`OrchestratorCaps`), and per-chat mode.

## 9. UI spec (task board)

- Header: request (1 line), run state chip (planning / running / integrating / done / failed /
  cancelled), round, total tokens + cost, **Cancel all**.
- One card per task (`board.tasks` order = creation order: lead-plan, round tasks in topo order,
  lead-int-N): role icon + id, goal (2 lines), state chip (queued grey, running blue spinner,
  blocked amber with `detail`, done green, failed red with `detail`, cancelled grey struck),
  model, tokens/cost (live), files (claimed) with changed files bolded, `summary` +
  `resultStatus` when finished, followups. Per-card **Cancel** (running/queued/blocked) and
  **Transcript** (opens `getTaskTranscript`, rendered with the chat message renderer).
- Optional DAG view: edges from `dependsOn`.
- Change requests list (file, from task, change) under the lead's integration card.
- Budget `warn` → amber toast; `stop` → red banner on the task/run.
- Final `answer` renders as the assistant reply in the chat.

## 10. Anthropic: SDK-native subagents vs engine tasks

**Decision: in orchestrated runs, every role (scouts included) runs as an engine task — one SDK
`query()` per task — and SDK-native subagents are disabled (`Agent`/`Task` disallowed). SDK
subagents are worth using only inside the single-agent chat, as an optional read-only `scout`.**

Findings from `@anthropic-ai/claude-agent-sdk` 0.3.296 (`sdk.d.ts`, `sdk-tools.d.ts`):
- `Options.agents: Record<string, AgentDefinition>`; `AgentDefinition` = `{description, prompt,
  tools?, disallowedTools?, model?, mcpServers?, maxTurns?, effort?, permissionMode?,
  background?, skills?, memory?, autoCompactWindow?, omitClaudeMd?, …}`. The model invokes them
  through the `Agent` (formerly `Task`) tool: `AgentInput {description, prompt, subagent_type?,
  model?: 'sonnet'|'opus'|'haiku'|'fable', run_in_background? (default true), name?, isolation?}`.
- Observability: subagent messages carry `parent_tool_use_id`; `system` messages `task_started` /
  `task_progress` (usage `{total_tokens, tool_uses, duration_ms}`) / `task_notification`
  (`completed|failed|stopped`, summary, usage); hooks `SubagentStart {agent_id, agent_type}` and
  `SubagentStop {agent_transcript_path, last_assistant_message}`; `canUseTool` receives
  `agentID` for calls made inside a subagent; `Query.stopTask(taskId)` stops one.
- Budget: `maxBudgetUsd` is per `query()` (whole tree), not per subagent; there is no token cap.

Why engine tasks win for orchestration:
- **Models:** per-task model is exact and provider-wide (the engine passes any model id; the
  `Agent` tool's `model` override is limited to aliases and chosen by the model).
- **Budgets:** per-task token/cost caps need per-task usage. SDK subagents only expose
  `task_progress.total_tokens` (no cost, no cache split) and share one `maxBudgetUsd`; the engine
  gets exact per-request usage per task and can stop one task without killing the tree.
- **Locks:** claims are per task. With SDK subagents the guard would have to map `agentID`
  (from `canUseTool`/hooks) back to a plan task, and the lead model decides what the subagent is
  told — it could not be held to a validated plan. Engine tasks get guarded tools bound to their
  task id at construction.
- **Parallelism and DAG:** the SDK parallelizes when the model issues several `Agent` calls (or
  backgrounds them); there is no `maxParallel`, dependency order or "cancel dependents". The
  engine enforces all of these.
- **Context hygiene:** a subagent's final report lands verbatim in the lead's context (free-form,
  unbounded); the engine feeds back only the clipped `submit_result`.
- **Provider parity:** the same engine runs on OpenAI/Gemini/OpenRouter/Ollama via the loop.
- **Caching:** each engine role has a constant system prompt + tool list, so repeated tasks of a
  role hit the provider cache; subagent prompts are model-written.

Cost of this choice: one CLI subprocess per running task (bounded by `maxParallel`), and the lead
cannot spontaneously spawn helpers mid-turn (it re-plans at integration instead).

Where SDK-native subagents DO fit: the existing single-agent chat on Anthropic may register
```ts
agents: { scout: { description: 'Cheap read-only codebase research', prompt: SCOUT_PROMPT_FOR_SDK,
  model: 'haiku', tools: ['Read','Glob','Grep', 'mcp__gentree__project_overview', /* read tools */],
  disallowedTools: ['Edit','Write','Bash','Agent'], maxTurns: 15 } }
```
Read-only (so no locks needed), covered by the chat's `maxBudgetUsd`, and it saves big-model
tokens on exploration. Note `sdk.ts toChatMessages` already drops subagent traffic; surface
`task_started/task_notification` as tool chips if desired, and count their usage via the result
message's `modelUsage` (which includes subagent models).
