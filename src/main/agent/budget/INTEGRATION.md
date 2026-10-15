# Token budget layer: integration guide

Everything in `src/main/agent/budget/` is pure TypeScript (no Electron, no SDK runtime imports;
`usage.ts` only imports SDK *types*). Tests: `test/tokens*.test.ts` on the fixture
`test/fixtures/gentree-tokens/` (copied from the GenTree template).

| Module | Main exports |
| --- | --- |
| `tokens.ts` | `estimateTokens`, `estimateMessagesTokens`, `estimateJsonTokens`, `formatTokens` |
| `projectMap.ts` | `ProjectMap` (`refresh`, `render`, `findSymbol`, `entries`, `version`), `parseLuau`, `formatSymbolHits` |
| `searchCode.ts` | `searchCode`, `findSymbol`, `blinkOutputs`, `realmFromPath` |
| `usage.ts` | `fromAnthropicUsage`, `fromModelUsage`, `fromOpenAiUsage`, `PRICES`, `priceFor`, `estimateCost`, `priced`, `SdkUsageTracker`, `UsageLedger`, `formatUsd` |
| `budget.ts` | `readLimits`, `checkAgent`, `checkChat`, `BudgetGuard`, `routeModel`, `TIER_DEFAULTS` |
| `compact.ts` | `compactHistory`, `needsCompaction`, `truncateToolOutput`, `SUMMARY_INSTRUCTIONS` |
| `tools.ts` | `budgetTools({ map, fs, realmOf })`, `mapSource(ctx)`, `realmLookup(ctx)` |

Order of wins, biggest first: (1) prompt caching (stable prefix), (2) cheap model for test agents
and simple asks, (3) fewer round trips (project_map / search_code / find_symbol instead of
list+read), (4) bounded tool output, (5) compaction of long OpenAI-loop histories, (6) caps.

---

## 1. One ProjectMap per open project

Create it where the HarnessContext is built (main/index.ts or agent/index.ts) and drop it when the
project closes:

```ts
import { ProjectMap } from './budget/projectMap.ts'
import { mapSource, realmLookup } from './budget/tools.ts'
const projectMap = new ProjectMap(mapSource(ctx))   // stat-based incremental refresh
void projectMap.refresh()                            // warm it; tools call refresh() themselves
// On Project.watch() change events with change.scripts === true: void projectMap.refresh()
```

`refresh()` only re-reads files whose mtime/size changed; `render()` is memoized per options and
`version`, so calls are cheap and the text is byte-identical while nothing changed.

## 2. Tools (tools.ts)

Add the three tools to the read set in `gentreeTools()` (both providers use that list):

```ts
import { budgetTools } from './budget/tools.ts'
// inside gentreeTools(ctx, opts), after `read` is built:
const extra = opts.projectMap ? budgetTools({ map: opts.projectMap, fs: ctx, realmOf: realmLookup(ctx) }) : []
const read = [...readTools, ...extra]          // keep a FIXED order: tool list is part of the cached prefix
```

`BudgetTool` is structurally a `GentreeTool<any>` (`{ name, description, inputSchema, handler }`),
so `wrapInSdkServer`, `toFunctionSpecs` and `runTool` accept them unchanged. They are read-only, so
test agents (`readOnly: true`) get them too. Names the model sees: `mcp__gentree__project_map`,
`mcp__gentree__search_code`, `mcp__gentree__find_symbol`.

| Tool | Input | Output |
| --- | --- | --- |
| `project_map` | `path?`, `realm?`, `category?`, `maxTokens?` (200-20000, default 2500) | one line per script, grouped by folder; collapses folders when over budget |
| `search_code` | `query`, `regex?`, `caseSensitive?`, `path?`, `realm?`, `maxResults?` (≤200, default 30), `context?` (0-5, default 1), `includeIgnored?` | `path:line: text`, context as `path-line- text`, `--` between hunks; ≤3k tokens |
| `find_symbol` | `name` (`Name`, `Table.Name`, `Table:Name`) | `path:line kind Table.name`, falls back to a definition-shaped search |

Prompt changes (sdk.ts `SYSTEM_PROMPT`, "Working rules"): replace the "project_overview to orient,
list_scripts/..." line with: *"Orient with project_map (or the map below); locate code with
find_symbol / search_code; read only the line ranges you need with read_script from/to."*

Consider removing the SDK's built-in `Glob`/`Grep` from `tools` in chat/test agents once
`search_code` is in: every tool schema is re-sent (cached) each request, and the built-ins'
descriptions are long. Keep `Read` only if the model needs non-script files.

## 3. Prompt caching: keep the prefix byte-stable and first

Cache order is `tools -> system -> messages`; any byte change invalidates everything after it.
Minimum cacheable prefix on current Claude models: 512 tokens; OpenAI GPT-5.6+: 1024 tokens.

- **System prompt**: a constant string (it is now). Never put timestamps, git status, service
  states or counts in it. Per-chat context goes in the first user message.
- **Project map in the prefix (optional)**: render it once per chat at chat creation and store
  the text on the chat (`chat.mapSnapshot`); reuse that exact text on every turn of that chat even
  if the project changes (the tools give fresh data). Anthropic SDK path:
  ```ts
  import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk'
  systemPrompt: [SYSTEM_PROMPT, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, `Project map (snapshot):\n${chat.mapSnapshot}`]
  ```
  Blocks before the boundary are cached across sessions; the map block after it is cached within
  the session. OpenAI path: `system: SYSTEM_PROMPT + OPENAI_TOOLS_NOTE + '\n\nProject map (snapshot):\n' + chat.mapSnapshot`.
  Use `maxTokens: 1500-2500` for the snapshot. Skip it for test agents (one short query each: the
  map tool is cheaper than a cache write on every agent).
- **Tools**: a fixed list in a fixed order per agent kind. Do not add/remove the Studio MCP
  server mid-chat (it changes the tool list); decide it at chat creation.
- **Model**: caches are per model. `routeModel` never downgrades an ongoing chat for this reason.
- **Agent SDK knobs**: the SDK applies Anthropic `cache_control` itself; there is no per-block
  API. Available controls: `systemPrompt` as `string[]` with `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`
  (above); `systemPrompt: { type: 'custom', prompt, snapshot: true }` (default) records the prompt
  per session so resumes reuse it verbatim; `Options.settings: { promptCacheTtl: '5m' | '1h' }`
  (main conversation; unset = 5m on API keys, 1h on a Claude subscription; 1h writes cost 2x
  input vs 1.25x) and `subagentPromptCacheTtl`. Env `CLAUDE_CODE_PROMPT_CACHE_TTL` overrides.
  Recommendation: leave the TTL automatic for chats (users pause), force `'5m'` for test agents.
- **OpenAI**: caching is automatic for prefixes ≥1024 tokens. Optionally send
  `prompt_cache_key: chatId` (openai provider only) so related requests share cache routing.
  GPT-5.6+ bills cache writes at 1.25x input (`prompt_tokens_details.cache_write_tokens`).

## 4. Usage metering

### Shared ledger

```ts
import { UsageLedger } from './budget/usage.ts'
import { BudgetGuard, readLimits } from './budget/budget.ts'
const ledger = new UsageLedger(ctx)                       // persists under the 'usage' setting, 1s debounce
const guard = new BudgetGuard(ledger, () => readLimits(ctx.getSetting.bind(ctx)))
ledger.onRecord((r) => ctx.emit('usage:changed', snapshotFor(r)))   // see §7
// on app quit: ledger.flush()
```

### chat.ts, Anthropic path (`runSdk`)

```ts
const tracker = new SdkUsageTracker(modelId, chat.sdkSessionId ? ledger.sdkBaseline(chat.sdkSessionId) : {})
for await (const m of queryFn(...)) {
  ...existing code...
  ledger.recordAll(tracker.onMessage(m), { chatId: chat.id })
  if (m.type === 'result' && chat.sdkSessionId) ledger.setSdkBaseline(chat.sdkSessionId, tracker.snapshot())
  if (m.type === 'assistant') emitLive(chat.id, tracker.live())          // optional live meter
}
// finally (also on abort/error):
ledger.recordAll(tracker.finish(), { chatId: chat.id })
```

Why the baseline: `result.modelUsage` / `total_cost_usd` are cumulative per query, and a
**resumed** session's first result already includes the earlier turns from its transcript. The
tracker records `current - baseline` per model. `modelUsage` is the authoritative field (it covers
subagents and internal calls such as compaction; `result.usage` is main-loop only). Streamed
assistant messages repeat the same `message.id`/usage; the tracker de-duplicates them for the live
meter. `costBasis: 'unknown'` entries are re-priced from `PRICES` or marked cost-unknown.
When the provider was switched mid-chat (the `chat.lastProvider` branch that clears
`sdkSessionId`), start with an empty baseline.

### chat.ts / testAgents.ts, OpenAI-compatible path (`runOpenAiLoop`)

Two changes in `openaiLoop.ts`:

1. Request body: add `stream_options: { include_usage: true }` next to `stream: true`. The last
   SSE chunk then carries `usage` with `choices: []`. (Ollama, Gemini and OpenRouter accept it;
   OpenRouter always sends usage, including `usage.cost` in USD.) If a custom endpoint rejects the
   field with 400, retry once without it and remember that per base URL.
2. `readTurn`: capture usage **before** the `if (!choice) continue` line, and in the JSON branch:
   ```ts
   if (chunk.usage) usage = chunk.usage            // SSE
   if (json?.usage) usage = json.usage             // non-streamed
   ```
   return it on `Turn`, and expose it through a new `LoopOptions.onUsage?(usage: unknown, model: string)`
   called once per request. Callers:
   ```ts
   onUsage: (u) => { const r = ledger.recordOpenAi(u, { provider, model: modelId, chatId: chat.id }); if (r) live = addUsage(live, r) }
   ```
   (`agentId: run.agent.id` instead of `chatId` for test agents.)

`fromOpenAiUsage` handles `prompt_tokens` (which INCLUDES cached tokens), `completion_tokens`,
`prompt_tokens_details.cached_tokens` / `cache_write_tokens`, Responses-style `input_tokens*`,
and OpenRouter `cost`. Reasoning tokens are part of `completion_tokens` already.

### Pricing

`PRICES` (USD/MTok) from the official pages, checked 2026-10-13:

| Model | in | out | cache read | cache write |
| --- | --- | --- | --- | --- |
| claude-opus-5-5 | 4 | 20 | 0.20 | 5 (5m) |
| claude-sonnet-5-5 | 2 | 10 | 0.10 | 2.50 |
| claude-haiku-5-5 (≤100k prompt / >100k) | 0.10 / 0.50 | 0.50 / 2.50 | 0.01 / 0.05 | 0.125 / 0.625 |
| gpt-6-astra | 10 | 50 | 1 | 12.5 |
| gpt-6.1-sol | 2 | 10 | 0.10 | 2.5 |
| gpt-6-luna | 0.10 | 0.50 | 0.01 | 0.125 |
| gemini-3.8-flash (to 2026-12-31 / from 2027-01-01) | 0.75 / 1.50 | 3.75 / 7.50 | 0.075 / 0.15 | — |
| gemini-3.5-flash-lite | 0.30 | 2.50 | 0.03 | — |
| gemini-3.1-pro-preview (≤200k / >200k) | 2 / 4 | 12 / 18 | 0.20 / 0.40 | — |

Plus older Claude models, gpt-5.3-codex, gemini-3.6-flash, gemini-3.1-flash-lite,
gemini-3-flash-preview. **Unknown models (e.g. `gpt-5.6-terra`, any Ollama/custom model not
listed) are cost-unknown** (`costSource: 'unknown'`, counted in `unpricedRequests`); Ollama is
priced at $0. Not modeled: OpenAI's long-context column (the page gives no threshold), Gemini
cache storage per hour, batch/flex tiers, Anthropic fast mode and `inference_geo` 1.1x.
Sources: platform.claude.com/docs/en/about-claude/pricing,
developers.openai.com/api/docs/pricing (+ /docs/guides/prompt-caching),
ai.google.dev/gemini-api/docs/pricing. Update the table when providers.ts defaults change.

## 5. Budgets

Settings key `budget` (all optional; ≤0 or null disables a cap):
`{ agentMaxTokens: 400000, agentMaxCostUsd: 1, chatSoftTokens: 300000, chatSoftCostUsd: 2,
chatMaxCostUsd?, dailyMaxCostUsd?, warnAt: 0.8, tokenMetric: 'effective' | 'total' }`.
"Effective" tokens = input + cache writes + output + 10% of cache reads.

- **Test agents, SDK path** (`testAgents.buildOptions`): add `...guard.sdkOptions('agent')`
  (sets `maxBudgetUsd`; the SDK ends with `subtype: 'error_max_budget_usd'`, map that to a
  failed/error summary "budget cap reached"). For the token cap, in the `for await` loop:
  `if (guard.check({ agentId }, tracker.live()).level === 'stop') run.abort.abort()` and finish
  with `check.reason`.
- **Test agents, OpenAI path**: `stop: () => !!run.report || guard.stopWhen({ agentId: run.agent.id }, () => live)()`.
- **Chat**: before `send()` starts a turn, `const c = guard.check({ chatId })`: `stop` -> push a
  system message with `c.reason` and do not run; `warn` -> run, and push a one-line system note
  (once per threshold crossing) suggesting a new chat or `/compact`.
- Also lower `agentMaxTurns` default from 40 to ~25: with report_result, most scenarios finish in
  <15 turns, and every turn re-sends the whole context.

## 6. Model routing

```ts
const route = routeModel({
  task: 'chat' | 'agent' | 'summary',
  text,                                            // user message / scenario
  settings: { provider, model: chosenModel, autoRoute: ctx.getSetting('autoRoute', true), tiers: ctx.getSetting('modelTiers', undefined) },
  override,                                        // model picked explicitly for this message
  previousModel: chat.lastModel                    // never downgrade mid-chat
})
// route.model, route.tier, route.reason ("short, simple question", "asks for \"refactor\"", ...)
```

Defaults (`TIER_DEFAULTS`): anthropic haiku-5-5 / opus-5-5; openai gpt-6-luna / gpt-6-astra;
gemini 3.5-flash-lite / 3.1-pro-preview; openrouter anthropic/claude-haiku-5.5 /
anthropic/claude-opus-5.5; ollama/custom: no routing. Wire it in `ChatManager.choice()` /
`send()` (chat) and in `TestAgentRunner.run()` (agents: `task: 'agent'` -> cheap). Show
`route.reason` next to the model badge so the choice is explainable; a picker change is an
`override`. Remember `extraBody()` for the routed model (gpt-6-luna needs `reasoning_effort: 'none'`
for tools).

Agent SDK extras for the cheap path: `effort: 'low'` for test agents and summaries
(`Options.effort`; Haiku 5.5 / Opus 5.5 default to `medium`), keep `persistSession: false`,
`settingSources: []`, `strictMcpConfig: true`, a minimal `tools` list, and `maxTurns`.
`taskBudget: { total }` (alpha, min 20k) makes the model pace itself; optional.

## 7. Compaction (OpenAI-compatible chats)

The SDK auto-compacts its own sessions (`Options.settings: { autoCompactWindow }` tunes it).
For `runOpenAi` in chat.ts, before calling the loop:

```ts
const window = 120_000                                   // or a per-model setting
if (needsCompaction(history, 0.8 * window)) {
  const r = await compactHistory(history, {
    budgetTokens: 0.4 * window, keepTurns: 4, toolMaxTokens: 2000,
    summarize: (t) => summarizeWithCheapModel(SUMMARY_INSTRUCTIONS, t)   // routeModel({ task: 'summary' })
  })
  history = r.messages                                   // OaiMessage[] in, OaiMessage[] out
}
```

Compact in big steps (80% trigger -> 40% target): each compaction is a cache miss. Also apply
`truncateToolOutput(text, 2000)` to tool results before they enter `history` in openaiLoop.ts
(the UI preview there is already cut separately), and to oversized gentree tool outputs.

## 8. IPC / UI fields for the meter

Add to `src/shared/types.ts`:

```ts
export interface UsageSummary {
  input: number; output: number; cacheRead: number; cacheWrite: number
  costUsd: number            // priced part only
  unpricedRequests: number   // >0 -> show "+ unpriced" / "cost partly unknown"
  requests: number
}
export interface UsageSnapshot {
  scope: 'chat' | 'agent' | 'day'
  id: string                 // chat id, agent id, or YYYY-MM-DD
  totals: UsageSummary
  live?: UsageSummary        // in-flight query, not yet in totals
  budget?: { level: 'ok' | 'warn' | 'stop'; fraction: number; reason?: string }
  model?: string; provider?: ProviderId
  route?: { tier: 'cheap' | 'big' | 'chosen'; reason: string }
}
// HarnessEvents: 'usage:changed': UsageSnapshot
// HarnessApi:
//   getUsage(scope: 'chat' | 'agent' | 'day', id?: string): Promise<UsageSnapshot>
//   getUsageHistory(days: number): Promise<{ day: string; totals: UsageSummary }[]>   // ledger.days(n)
//   getBudget(): Promise<BudgetLimits>; setBudget(l: Partial<BudgetLimits>): Promise<void>
```

`TestAgent` gains `usage?: UsageSummary` (fill from `ledger.agent(id)` in `list()`), and
`ChatSession` gains `usage?: UsageSummary` and `route?` for the header badge. Meter UI: tokens as
`formatTokens(effective)`, cost as `formatUsd(costUsd)`, cache hit rate =
`cacheRead / (input + cacheRead + cacheWrite)` (the number that proves caching works), and the
budget bar from `budget.fraction` (amber at warn, red at stop).
