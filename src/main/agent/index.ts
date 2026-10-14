// IPC entry point for the agent layer. main/index.ts calls registerAgentIpc once.

import type { IpcMain } from 'electron'
import type { ChatMessage, CodexAccount, ModelChoice, OrchestrateMode, ProviderId, ProviderInfo } from '@shared/types'
import { INVOKE_PREFIX } from '../../shared/types.ts'
import type { NewChatOptions } from '@shared/types'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { noProjectDir } from './noProjectDir.ts'
import { isEffortChoice } from '../../shared/modelCaps.ts'
import { ChatImageStore, chatImageStore, setChatImageStore } from './chatImages.ts'
import type { HarnessContext } from '../context.ts'
import { routeModel, tiersFor } from './budget/budget.ts'
import { LAB_MODELS_SETTING, LAST_CHAT_MODEL_SETTING, resolveLabModel, type LabTier } from '../../shared/labModels.ts'
import { runOpenAiLoop } from './openaiLoop.ts'
import { runResponsesLoop, usesResponsesApi } from './responsesLoop.ts'
import { ChatManager, type TeamRunner } from './chat.ts'
import { Credentials } from './credentials.ts'
import { Meter } from './meter.ts'
import { estimateCost, fromOpenAiUsage, priced, SdkUsageTracker, type Usage } from './budget/usage.ts'
import { assertSpend, chargeSpend, sourceOfRecord, spendBlock } from '../services/spend/gate.ts'
import type { FetchFn } from './openaiLoop.ts'
import { capsBudget, classifyTool, defaultWriteTargets, openAiRunAgent, Orchestrator, sdkRunAgent, type AgentEvent, type RunAgent, type ToolClass, type WriteTargets } from './orchestrator/index.ts'
import { projectRulesLoader, withRules } from './projectRules.ts'
import { withMemoryLoader, type MemoryHooks } from './memory/hooks.ts'
import { extraBody, isProviderId, Providers } from './providers.ts'
import { anthropicPrompt, chatCompletionsContent, type ImagePayload } from './imageParts.ts'
import { executableOption, OPENAI_TOOLS_NOTE, sdkQuery, type QueryFn } from './sdk.ts'
import { SERVICE_WRITE_TOOLS } from './serviceTools.ts'
import { TestAgentRunner } from './testAgents.ts'
import { CodexService, codexService, setCodexService, type CodexStatus } from './codex/service.ts'
import { privateCodexPrefix } from './codex/install.ts'
import { defaultGroupIo } from './group/io.ts'
import { Restater } from './restate.ts'
import { normalizeRestatement, type RestateLab } from '../../shared/restate/types.ts'
import { gentreeTools, runTool, SERVER_NAME, wrapInSdkServer, type ToolFs } from './tools.ts'
import { chatModeHandlers, memoryNote } from './modesIpc.ts'
import type { GatingCostRow } from './commands/index.ts'
import { watchAnthropicAuth } from '../accounts/authHealth.ts'
import { registerAccountsIpc } from '../accounts/ipc.ts'

export interface AgentLayer {
  chats: ChatManager
  agents: TestAgentRunner
  credentials: Credentials
  providers: Providers
  meter: Meter
  orchestrator: Orchestrator
  // Starts an orchestration for a chat message (also used by ChatManager's team mode).
  team: TeamRunner
  // "Restate first" (chat cards and Labs briefs).
  restater: Restater
  // One-shot, tool-less answer from the default provider's cheap tier (summaries).
  oneShot(system: string, prompt: string, opts?: { tier?: LabTier }): Promise<string>
  // One-shot answer about images (VFX critique) on the default model, which should see images.
  // opts.tier picks a Labs model tier instead (shared/labModels.ts: cheap / default / critic).
  visionShot(system: string, prompt: string, images: ImagePayload[], opts?: ShotOptions): Promise<string>
  dispose(): void
}

// One-shot options: a Labs tier, and a callback with the call's usage (lab gating: cost per kept).
export interface ShotOptions {
  tier?: LabTier
  onUsage?: (u: { model: string; input: number; output: number; costUsd?: number }) => void
}

// Orchestrator tool classes for tools the default classifier does not know: the service write
// tools edit hot files (events.blink, wally.toml), so no orchestrated agent gets them ('admin');
// tasks ask the lead with request_change instead.
export function classifyForgeTool(name: string): ToolClass {
  const bare = name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '')
  if ((SERVICE_WRITE_TOOLS as readonly string[]).includes(bare)) return 'admin'
  return classifyTool(bare)
}

// create_spec writes <Module>.spec.luau next to the module it is given: claim that file.
export const forgeWriteTargets: WriteTargets = (name, args) => {
  const bare = name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '')
  if (bare === 'create_spec' && typeof args.path === 'string') {
    const p = args.path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
    if (/\.spec\.(luau|lua)$/.test(p)) return [p]
    const m = /^(.*\/)?([^/]+)\.(luau|lua)$/.exec(p)
    if (!m) return null
    const dir = m[1] ?? ''
    const base = m[2] === 'init' ? (dir.replace(/\/$/, '').split('/').pop() ?? 'init') : m[2]
    return [`${dir}${base}.spec.${m[3]}`]
  }
  return defaultWriteTargets(name, args)
}

// Builds the agent layer without Electron (tests pass a stub query function and fetch).
export function createAgentLayer(
  ctx: HarnessContext,
  opts: { queryFn?: QueryFn; credentials?: Credentials; fetchFn?: FetchFn; toolFs?: ToolFs; meterSaveDelayMs?: number; memory?: MemoryHooks; userCommandsDir?: string; gating?: () => Promise<GatingCostRow[] | null> } = {}
): AgentLayer {
  const credentials = opts.credentials ?? new Credentials(ctx)
  // Every Agent SDK query reports authentication failures and successes (Settings > Accounts shows
  // "Sign-in expired" until a request or a test succeeds).
  opts = { ...opts, queryFn: watchAnthropicAuth(opts.queryFn ?? sdkQuery, credentials.health) }
  const providers = new Providers(ctx, credentials, opts.fetchFn)
  // Base prompt + project rules + memory index (agent/memory/prompt.ts): the memory block comes last,
  // after the stable prefix, so prompt caching keeps working for chat, the group host, test agents
  // and orchestrator roles alike.
  const rules = withMemoryLoader(projectRulesLoader(ctx), opts.memory)
  const meter = new Meter(ctx, { saveDelayMs: opts.meterSaveDelayMs })
  // Every ledger record (chat, test agents, one-shot Labs calls) also charges the spending cap.
  meter.ledger.onRecord((r) => chargeSpend({ provider: r.provider, source: sourceOfRecord(r), costUsd: r.costUsd, at: r.at }))
  const orchestrator = createOrchestrator(ctx, { ...opts, credentials, providers, rules, meter })
  const team = teamRunner(ctx, orchestrator)
  let chats: ChatManager
  // Restatements are written on the Labs cheap tier (layer is assigned below, before any call).
  let layer: AgentLayer
  const restater = new Restater({
    getSetting: (k, f) => ctx.getSetting(k, f),
    setSetting: (k, v) => ctx.setSetting(k, v),
    oneShot: (system, prompt) => layer.oneShot(system, prompt, { tier: 'cheap' }),
    ...(opts.memory?.remember ? { remember: (input, source) => opts.memory!.remember!(input, source) } : {}),
    log: (text, stream = 'info') => ctx.log({ service: 'agent', stream, text })
  })
  // Background reflection: a chat that goes idle is reviewed by the memory layer (debounced there).
  const chatCtx = opts.memory ? tapChatBusy(ctx, opts.memory, (id) => chats.messages(id) ?? null) : ctx
  chats = new ChatManager(chatCtx, {
    queryFn: opts.queryFn, credentials, providers, fetchFn: opts.fetchFn, toolFs: opts.toolFs, rules, meter, team, restater, groupIo: defaultGroupIo(),
    // Slash commands (agent/commands): /compact on the cheap tier, /memory notes, /cost Labs rows.
    oneShot: (system, prompt) => layer.oneShot(system, prompt, { tier: 'cheap' }),
    remember: memoryNote(opts.memory),
    ...(opts.userCommandsDir ? { userCommandsDir: opts.userCommandsDir } : {}),
    ...(opts.gating ? { gating: opts.gating } : {})
  })
  const agents = new TestAgentRunner(ctx, { queryFn: opts.queryFn, credentials, providers, fetchFn: opts.fetchFn, toolFs: opts.toolFs, rules, meter })
  layer = {
    chats,
    restater,
    agents,
    credentials,
    providers,
    meter,
    orchestrator,
    team,
    oneShot: (system, prompt, o) => oneShot(ctx, { queryFn: opts.queryFn, fetchFn: opts.fetchFn, credentials, providers, meter }, system, prompt, [], o?.tier),
    visionShot: (system, prompt, images, o) => oneShot(ctx, { queryFn: opts.queryFn, fetchFn: opts.fetchFn, credentials, providers, meter }, system, prompt, images, o?.tier, o?.onUsage),
    dispose() {
      orchestrator.cancelAll()
      chats.dispose()
      agents.dispose()
      meter.flush()
      opts.memory?.setModel(null)
    }
  }
  // Reflection and the style pass run on the cheap tier through oneShot.
  opts.memory?.setModel((system, prompt) => layer.oneShot(system, prompt))
  return layer
}

// A HarnessContext whose emit also tells the memory layer when a chat starts or stops a turn.
function tapChatBusy(ctx: HarnessContext, memory: MemoryHooks, messages: (id: string) => ChatMessage[] | null): HarnessContext {
  const tapped = Object.create(ctx) as HarnessContext
  tapped.emit = (event, payload) => {
    ctx.emit(event, payload)
    if (event !== 'chat:busy') return
    const p = payload as { sessionId: string; busy: boolean }
    if (p.busy) memory.onChatBusy(p.sessionId)
    else memory.onChatIdle(p.sessionId, () => messages(p.sessionId))
  }
  return tapped
}

function report(cb: NonNullable<ShotOptions['onUsage']>, model: string, u: Usage): void {
  try {
    cb({ model, input: u.input + u.cacheRead + u.cacheWrite, output: u.output, ...(u.costUsd !== undefined ? { costUsd: u.costUsd } : {}) })
  } catch {
    // accounting must never break the call
  }
}

// The last chat model that answered (LAST_CHAT_MODEL_SETTING, kept by ChatManager). Labs and other
// one-shot calls fall back to it when the default model's provider or a tier model does not work (a
// Claude subscription without the flagship model, a default model on a provider with no key, Codex
// not signed in, ...).
export function lastChatModel(ctx: Pick<HarnessContext, 'getSetting'>): ModelChoice | null {
  const v = ctx.getSetting<{ provider?: unknown; model?: unknown } | null>(LAST_CHAT_MODEL_SETTING, null)
  return v && isProviderId(v.provider) && typeof v.model === 'string' && v.model.trim() ? { provider: v.provider, model: v.model.trim() } : null
}

// Errors that say nothing about whether a model works (retrying another model would not help, or
// the next call on this one may well succeed): they are not remembered as "this model fails".
const TRANSIENT = /overloaded|rate.?limit|\b429\b|\b529\b|timed? ?out|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|aborted/i
// Models that failed recently (provider:model -> error), skipped while others remain.
const FAILED_TTL = 10 * 60_000
const failedModels = new Map<string, { message: string; until: number }>()

export function resetLabModelFailures(): void {
  failedModels.clear()
}

export interface ShotAttempt {
  provider: ProviderId
  model: string
}

// The models a one-shot call tries, in order: the tier's model on the default provider, the default
// model itself, then the same for the last chat model that answered (so the Labs use what chat uses).
export function shotAttempts(
  bases: ModelChoice[],
  pick: (base: ModelChoice) => string
): ShotAttempt[] {
  const out: ShotAttempt[] = []
  const add = (provider: ProviderId, model: string) => {
    if (model && !out.some((a) => a.provider === provider && a.model === model)) out.push({ provider, model })
  }
  for (const b of bases) {
    add(b.provider, pick(b))
    add(b.provider, b.model)
  }
  return out
}

function shotLabel(a: ShotAttempt): string {
  return a.provider === 'anthropic' ? a.model : `${a.provider} ${a.model}`
}

async function oneShot(
  ctx: HarnessContext,
  w: { queryFn?: QueryFn; fetchFn?: FetchFn; credentials: Credentials; providers: Providers; meter: Meter },
  system: string,
  prompt: string,
  // With images: the default model (not the cheap tier), images sent inline.
  images: ImagePayload[] = [],
  // A Labs tier (cheap / default / critic) overrides the rule above.
  tier?: LabTier,
  onUsage?: ShotOptions['onUsage']
): Promise<string> {
  const primary = w.providers.defaultModel()
  const chat = lastChatModel(ctx)
  const bases = chat && !(chat.provider === primary.provider && chat.model === primary.model) ? [primary, chat] : [primary]
  const tiers = ctx.getSetting('modelTiers', undefined)
  const labs = ctx.getSetting(LAB_MODELS_SETTING, {})
  const attempts = shotAttempts(bases, (b) =>
    b.provider === 'codex'
      ? b.model
      : tier
        ? resolveLabModel(tier, labs, b.model, tiersFor({ provider: b.provider, model: b.model, tiers }))
        : images.length
          ? b.model
          : routeModel({ task: 'summary', text: prompt, settings: { provider: b.provider, model: b.model, tiers } }).model
  )
  const now = Date.now()
  const known = (a: ShotAttempt) => {
    const f = failedModels.get(`${a.provider}:${a.model}`)
    return f && f.until > now ? f : null
  }
  // Skip models that failed a moment ago, unless nothing else is left.
  const fresh = attempts.filter((a) => !known(a))
  const order = fresh.length ? fresh : attempts
  const errors: string[] = attempts.filter((a) => known(a) && fresh.length).map((a) => `${shotLabel(a)}: ${known(a)!.message}`)
  for (const [i, a] of order.entries()) {
    // Spending cap (Settings > Usage): refuse before an API call (Codex runs on the ChatGPT plan).
    if (a.provider !== 'codex') assertSpend('labs')
    try {
      const out = await shotOnce(ctx, w, a, system, prompt, images, onUsage)
      if (i > 0 || errors.length) ctx.log({ service: 'agent', stream: 'info', text: `[labs] used ${shotLabel(a)}${tier ? ` for the ${tier} tier` : ''} (${errors.join('; ')})` })
      return out
    } catch (e) {
      const message = ((e as Error).message || String(e)).replace(/\s+/g, ' ').trim().slice(0, 400)
      if (!TRANSIENT.test(message)) failedModels.set(`${a.provider}:${a.model}`, { message, until: Date.now() + FAILED_TTL })
      errors.push(`${shotLabel(a)}: ${message}`)
      ctx.log({ service: 'agent', stream: 'stderr', text: `[labs] ${shotLabel(a)} failed: ${message}` })
    }
  }
  throw new Error(errors.length > 1 ? `no model answered (${errors.join('; ')})` : errors[0] ?? 'no model is set up')
}

async function shotOnce(
  ctx: HarnessContext,
  w: { queryFn?: QueryFn; fetchFn?: FetchFn; credentials: Credentials; providers: Providers; meter: Meter },
  a: ShotAttempt,
  system: string,
  prompt: string,
  images: ImagePayload[],
  onUsage?: ShotOptions['onUsage']
): Promise<string> {
  const { provider, model } = a
  // Codex: the ChatGPT plan through the CLI (no API spend).
  if (provider === 'codex') return codexService().oneShot(system, prompt, { images, model })
  if (provider === 'anthropic') {
    const auth = await w.credentials.anthropicAuth()
    if (!auth.ready) throw new Error(auth.error ?? 'Anthropic is not set up.')
    let out = ''
    let answered = false
    const tracker = new SdkUsageTracker(model)
    for await (const m of (w.queryFn ?? sdkQuery)({
      prompt: images.length ? anthropicPrompt(prompt, images) : prompt,
      options: {
        cwd: ctx.project()?.root ?? noProjectDir(),
        model,
        systemPrompt: system,
        ...(auth.env ? { env: auth.env } : {}),
        ...executableOption(),
        mcpServers: {},
        strictMcpConfig: true,
        tools: [],
        permissionMode: 'dontAsk',
        settingSources: [],
        persistSession: false,
        maxTurns: 1
      }
    })) {
      const records = tracker.onMessage(m as never)
      // One-shot calls go into the usage ledger too (day totals and the spending cap).
      w.meter.ledger.recordAll(records)
      if (onUsage) for (const r of records) report(onUsage, r.model, r)
      if (m.type === 'result') {
        answered = true
        if (m.subtype === 'success' && !m.is_error) out = m.result
        else throw new Error(m.subtype === 'success' ? m.result || 'the model returned an error' : m.errors?.join('; ') || m.subtype)
      }
    }
    if (!answered) throw new Error('the Claude CLI ended without an answer')
    return out.trim()
  }
  const ep = await w.providers.endpoint(provider)
  if ('error' in ep) throw new Error(ep.error)
  let out = ''
  const res = await (usesResponsesApi(provider, model) ? runResponsesLoop : runOpenAiLoop)({
    baseUrl: ep.baseUrl,
    headers: ep.headers,
    model,
    system,
    history: [{ role: 'user', content: chatCompletionsContent(prompt, images) }],
    tools: [],
    maxTurns: 1,
    signal: new AbortController().signal,
    agentId: 'summary',
    emit: (m) => {
      if (m.role === 'assistant') out = m.text
    },
    extraBody: extraBody(provider, model),
    fetchFn: w.fetchFn,
    onUsage: (raw) => {
      w.meter.ledger.recordOpenAi(raw, { provider, model })
      const u = onUsage ? fromOpenAiUsage(raw) : null
      if (u && onUsage) report(onUsage, model, priced(model, u, { provider }).usage)
    }
  })
  if (res.outcome === 'error') throw new Error(res.error ?? 'request failed')
  return out.trim()
}

interface OrchestratorWiring {
  queryFn?: QueryFn
  fetchFn?: FetchFn
  toolFs?: ToolFs
  credentials: Credentials
  providers: Providers
  rules: () => Promise<string>
  meter: Meter
}

// The Orchestrator with Forge's tools, models, budgets and both provider adapters.
function createOrchestrator(ctx: HarnessContext, w: OrchestratorWiring): Orchestrator {
  // Adapters are built per spec: auth/endpoint are resolved when a task starts. The project rules
  // block is appended to each role's constant prompt (constant per project, so still cacheable).
  const runAgent: RunAgent = (spec) => withSpendCharges(inner, spec)
  const inner: RunAgent = (spec) => ({
    async *[Symbol.asyncIterator]() {
      const block = spendBlock()
      if (block) {
        yield { type: 'error' as const, message: block }
        return
      }
      const rules = await w.rules().catch(() => '')
      const withRulesSpec = { ...spec, system: withRules(spec.system, rules) }
      const provider = spec.provider ?? 'anthropic'
      if (provider === 'anthropic') {
        const auth = await w.credentials.anthropicAuth()
        if (!auth.ready) {
          yield { type: 'error' as const, message: auth.error ?? 'Anthropic is not set up.' }
          return
        }
        const root = ctx.project()?.root ?? noProjectDir()
        yield* sdkRunAgent({
          query: w.queryFn ?? sdkQuery,
          makeServer: (tools) => wrapInSdkServer(tools as any),
          serverName: SERVER_NAME,
          baseOptions: () => ({ cwd: root, ...(auth.env ? { env: auth.env } : {}), ...executableOption(), ...w.meter.guard.sdkOptions('agent'), persistSession: false })
        })(withRulesSpec)
        return
      }
      yield* openAiRunAgent({
        endpoint: async (s) => {
          const ep = await w.providers.endpoint(provider)
          return 'error' in ep ? ep : { baseUrl: ep.baseUrl, headers: ep.headers, extraBody: extraBody(provider, s.model) }
        },
        systemSuffix: OPENAI_TOOLS_NOTE
      })(withRulesSpec)
    }
  })

  return new Orchestrator({
    runAgent,
    // Full gentree set (+ service tools). The engine filters by role and guards write tools.
    tools: () => gentreeTools(ctx, { ...(w.toolFs ? { fs: w.toolFs } : {}) }),
    classify: classifyForgeTool,
    writeTargets: forgeWriteTargets,
    budget: capsBudget(ctx.getSetting('orchestratorCaps', {})),
    settings: () => ctx.getSetting('orchestrator', {}),
    emit: (e) => {
      ctx.emit('orchestrator:event', e)
    }
  })
}

// Orchestrated runs are not in the usage ledger: their usage events charge the spending cap.
// Anthropic (SDK) runs report tokens without cost and the cost on the result (cost-only delta), so
// only explicit costs count there; other providers are priced from the table when no cost is given.
export function orchestratorCharge(provider: ProviderId, model: string, u: Usage): number {
  if (u.costUsd !== undefined) return u.costUsd
  if (provider === 'anthropic') return 0
  return estimateCost(model, u, { provider }) ?? 0
}

export function withSpendCharges(run: RunAgent, spec: Parameters<RunAgent>[0]): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      const provider = spec.provider ?? 'anthropic'
      for await (const e of run(spec)) {
        if (e.type === 'usage') {
          const cost = orchestratorCharge(provider, spec.model, e.usage)
          if (cost > 0) chargeSpend({ provider, source: 'orchestrator', costUsd: cost })
        }
        yield e
      }
    }
  }
}

// One orchestration for a chat message; resolves when the run ends.
function teamRunner(ctx: HarnessContext, orchestrator: Orchestrator): TeamRunner {
  return async ({ chatId, text, choice, signal, onStart }) => {
    const handle = orchestrator.start({
      request: text,
      model: choice.model,
      provider: choice.provider,
      tiers: tiersFor({ provider: choice.provider, model: choice.model, tiers: ctx.getSetting('modelTiers', undefined) }),
      projectContext: await projectContext(ctx)
    })
    onStart(handle.runId)
    ctx.log({ service: 'agent', stream: 'info', text: `team run ${handle.runId} for chat ${chatId}` })
    const onAbort = () => orchestrator.cancel(handle.runId)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const r = await handle.done
      return { state: r.state, answer: r.answer, detail: r.detail }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

// The lead's orientation: a compact project map when the project_map tool is available.
async function projectContext(ctx: HarnessContext): Promise<string | undefined> {
  const tool = ctx.serviceTools?.().read.find((t) => t.name === 'project_map')
  if (!tool) return undefined
  try {
    const r = await runTool(tool as any, { maxTokens: 1500 })
    return r.isError ? undefined : r.content.map((c) => c.text).join('')
  } catch {
    return undefined
  }
}

function restateLab(v: unknown): RestateLab {
  if (v === 'vfx' || v === 'anim' || v === 'ability' || v === 'thumbs' || v === 'uimotion') return v
  throw new Error(`unknown lab ${String(v)}`)
}

function provider(p: unknown): ProviderId {
  if (!isProviderId(p)) throw new Error(`unknown provider ${String(p)}`)
  return p
}

function newChatOptions(o: unknown): NewChatOptions {
  if (!o || typeof o !== 'object') return {}
  const v = o as Record<string, unknown>
  const out: NewChatOptions = {}
  if (isEffortChoice(v.effort)) out.effort = v.effort
  if (Array.isArray(v.guests)) out.guests = v.guests.map(choice).filter((x): x is ModelChoice => !!x)
  if (typeof v.title === 'string') out.title = v.title
  return out
}

function choice(c: unknown): ModelChoice | undefined {
  if (!c || typeof c !== 'object') return undefined
  const { provider: p, model } = c as Partial<ModelChoice>
  return isProviderId(p) && typeof model === 'string' && model.trim() ? { provider: p, model } : undefined
}

function codexAccount(s: CodexStatus): CodexAccount {
  return { installed: s.installed, loggedIn: s.loggedIn, ...(s.method ? { method: s.method } : {}), ...(s.version ? { version: s.version } : {}), ...(s.path ? { path: s.path } : {}), ...(codexService().signingInNow() ? { signingIn: true } : {}) }
}

export function registerAgentIpc(
  ctx: HarnessContext,
  ipcMain: IpcMain,
  opts: { memory?: MemoryHooks; userDataDir?: string; gating?: () => Promise<GatingCostRow[] | null> } = {}
): { dispose(): void; summarize(prompt: string): Promise<string>; vision(system: string, prompt: string, images: ImagePayload[], opts?: ShotOptions): Promise<string>; providers(): Promise<ProviderInfo[]>; defaultProvider(): ProviderId; credentials: Credentials; meter: Meter } {
  // Codex CLI: an optional path from settings ('codexPath') wins over PATH lookup.
  setCodexService(
    new CodexService({
      binOverride: () => ctx.getSetting<string | null>('codexPath', null),
      // Forge's own copy, installed by "Sign in with ChatGPT" when the user has none (codex/install.ts).
      ...(opts.userDataDir ? { privatePrefix: () => privateCodexPrefix(opts.userDataDir!) } : {}),
      log: (text, stream = 'info') => ctx.log({ service: 'agent', stream, text: `[codex] ${text}` })
    })
  )
  const layer = createAgentLayer(ctx, { memory: opts.memory, ...(opts.userDataDir ? { userCommandsDir: join(opts.userDataDir, 'commands') } : {}), ...(opts.gating ? { gating: opts.gating } : {}) })
  // Chat images live under userData/chat-images (history keeps only references).
  setChatImageStore(new ChatImageStore(join(opts.userDataDir ?? join(tmpdir(), 'rbx-forge'), 'chat-images')))
  const { chats, agents, credentials, providers, meter, orchestrator, team, restater } = layer

  const providersChanged = async () => {
    providers.forgetReachability()
    ctx.emit('providers:changed', await providers.list())
  }
  // Settings > Accounts (sign in with Claude, Codex slot, key tests).
  const accounts = registerAccountsIpc(ctx, ipcMain, { credentials, providers, providersChanged })

  const handlers: Record<string, (...args: any[]) => unknown> = {
    listChats: () => chats.list(),
    newChat: (c?: unknown, o?: unknown) => chats.create(choice(c), newChatOptions(o)),
    // Test agent ids work here too, so the UI can open an agent's transcript like a chat.
    getChat: (id: string) => {
      const orch = /^orch:([^:]+):(.+)$/.exec(String(id ?? ''))
      if (orch) return orchestrator.transcript(orch[1], orch[2]) ?? []
      return chats.messages(id) ?? agents.messages(id) ?? []
    },
    sendChat: (id: string, text: string, images?: unknown) => chats.send(id, String(text ?? ''), Array.isArray(images) ? images.filter((x): x is string => typeof x === 'string') : []),
    setChatEffort: (id: unknown, effort: unknown) => {
      if (!isEffortChoice(effort)) throw new Error(`invalid effort ${String(effort)}`)
      return chats.setEffort(String(id ?? ''), effort)
    },
    getDefaultEffort: () => chats.defaultEffort(),
    setDefaultEffort: (effort: unknown) => {
      if (!isEffortChoice(effort)) throw new Error(`invalid effort ${String(effort)}`)
      chats.setDefaultEffort(effort)
    },
    addChatImage: (input: unknown) => {
      const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
      return chatImageStore().add({
        dataUrl: typeof i.dataUrl === 'string' ? i.dataUrl : undefined,
        path: typeof i.path === 'string' ? i.path : undefined,
        name: typeof i.name === 'string' ? i.name : undefined
      })
    },
    getChatImage: (id: unknown) => chatImageStore().dataUrl(String(id ?? '')),
    stopChat: (id: string) => chats.stop(id),
    // Group chat.
    addGuest: (id: string, c: unknown) => {
      const pick = choice(c)
      if (!pick) throw new Error('invalid model choice')
      return chats.addGuest(id, pick)
    },
    removeGuest: (id: string, guest: unknown) => chats.removeGuest(id, String(guest ?? '')),
    setGuestTools: (id: string, on: unknown) => chats.setGuestTools(id, on === true),
    startRoundtable: (id: string, topic: unknown, rounds?: unknown) => chats.roundtable(id, String(topic ?? ''), typeof rounds === 'number' ? rounds : undefined),
    planToChecklist: async (id: string, messageId: unknown) => {
      chats.planToChecklist(id, String(messageId ?? ''))
    },
    // Group chat v2 (agent/group/*).
    getGroupSettings: () => chats.getGroupSettings(),
    setGroupSettings: (next: unknown) => chats.setGroupSettings(next && typeof next === 'object' ? (next as Record<string, never>) : {}),
    applyPatchProposal: (id: unknown, messageId: unknown) => chats.applyPatchProposal(String(id ?? ''), String(messageId ?? '')),
    mergePatchProposal: (id: unknown, messageId: unknown) => chats.mergePatchProposal(String(id ?? ''), String(messageId ?? '')),
    dismissPatchProposal: async (id: unknown, messageId: unknown) => chats.dismissPatchProposal(String(id ?? ''), String(messageId ?? '')),
    saveBoard: async (id: unknown, items: unknown) => chats.saveBoard(String(id ?? ''), items),
    hasApiKey: () => credentials.hasApiKey(),
    setApiKey: async (key: string) => {
      await credentials.setKey('anthropic', String(key ?? ''))
      await providersChanged()
    },

    listProviders: () => providers.list(),
    setProviderKey: async (p: unknown, key: unknown) => {
      await credentials.setKey(provider(p), String(key ?? ''))
      await providersChanged()
    },
    setProviderConfig: async (p: unknown, config: { baseUrl?: string } | undefined) => {
      providers.setConfig(provider(p), { baseUrl: typeof config?.baseUrl === 'string' ? config.baseUrl : undefined })
      await providersChanged()
    },
    listModels: (p: unknown) => providers.models(provider(p)),
    setChatModel: (id: string, p: unknown, model: string) => {
      chats.setModel(id, provider(p), String(model ?? ''))
    },
    getDefaultModel: () => providers.defaultModel(),
    setDefaultModel: (p: unknown, model: string) => providers.setDefaultModel(provider(p), String(model ?? '')),
    getAnthropicUseClaudeLogin: () => credentials.useClaudeLogin(),
    setAnthropicUseClaudeLogin: async (on: unknown) => {
      credentials.setUseClaudeLogin(on === true)
      await providersChanged()
    },
    // Codex (ChatGPT plan): the CLI signs in and keeps the credentials (agent/codex/service.ts).
    codexStatus: async (refresh?: unknown) => codexAccount(await codexService().status({ refresh: refresh === true })),
    codexSignIn: async () => {
      const abort = new AbortController()
      const p = codexService().signIn({
        signal: abort.signal,
        progress: (u) => ctx.emit('codex:signin', u)
      })
      void providersChanged()
      const r = await p
      await providersChanged()
      return r
    },
    codexCancelSignIn: () => codexService().cancelSignIn(),
    codexSignOut: async () => {
      const s = await codexService().signOut()
      await providersChanged()
      return codexAccount(s)
    },

    // Token usage meter and budgets.
    getUsage: (scope: unknown, id?: unknown) => {
      const s = scope === 'agent' || scope === 'day' ? scope : 'chat'
      return meter.snapshot(s, typeof id === 'string' ? id : undefined)
    },
    getUsageHistory: (days: unknown) => {
      const n = Math.max(1, Math.min(120, Math.floor(Number(days) || 7)))
      return meter.ledger.days(n).map((d) => ({ day: d.day, totals: { ...d.totals } }))
    },
    getBudget: () => meter.limits(),
    setBudget: (limits: unknown) => meter.setLimits(limits && typeof limits === 'object' ? (limits as any) : {}),

    // Orchestrator (team mode).
    startOrchestration: async (chatId: unknown, text: unknown, c?: unknown) => {
      const t = String(text ?? '').trim()
      if (!t) throw new Error('empty request')
      const pick = choice(c) ?? providers.defaultModel()
      let runId = ''
      const started = new Promise<string>((resolve) => {
        void team({
          chatId: String(chatId ?? ''),
          text: t,
          choice: pick,
          signal: new AbortController().signal,
          onStart: (id) => {
            runId = id
            resolve(id)
          }
        }).catch((e) => ctx.log({ service: 'agent', stream: 'stderr', text: `team run failed: ${(e as Error).message}` }))
      })
      await started
      return orchestrator.board(runId)
    },
    getOrchestrations: () => orchestrator.list(),
    getOrchestration: (runId: unknown) => orchestrator.board(String(runId ?? '')),
    getTaskTranscript: (runId: unknown, taskId: unknown): ChatMessage[] => orchestrator.transcript(String(runId ?? ''), String(taskId ?? '')) ?? [],
    cancelOrchestration: (runId: unknown) => orchestrator.cancel(String(runId ?? '')),
    cancelOrchestrationTask: (runId: unknown, taskId: unknown) => orchestrator.cancelTask(String(runId ?? ''), String(taskId ?? '')),
    getOrchestrateMode: (chatId: unknown) => chats.orchestrateMode(String(chatId ?? '')),
    setOrchestrateMode: (chatId: unknown, mode: unknown) => {
      chats.setOrchestrateMode(String(chatId ?? ''), (['auto', 'single', 'team'].includes(String(mode)) ? mode : 'auto') as OrchestrateMode)
    },

    // Restate first (agent/restate.ts).
    getRestateSettings: () => restater.settings(),
    setRestateSettings: (patch: unknown) => restater.setSettings(patch && typeof patch === 'object' ? (patch as any) : {}),
    restateBrief: (lab: unknown, brief: unknown, o?: { force?: unknown }) => restater.brief(restateLab(lab), String(brief ?? ''), { force: o?.force === true }),
    restateConfirm: (input: unknown) => {
      const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
      const draft = normalizeRestatement(i.draft)
      if (!draft) throw new Error('nothing to confirm')
      const kind = i.kind === 'chat' ? 'chat' : restateLab(i.kind)
      return restater.confirm({ kind, request: String(i.request ?? ''), draft, confirmed: normalizeRestatement(i.confirmed) ?? undefined })
    },
    confirmChatRestate: (id: unknown, messageId: unknown, edited?: unknown) => chats.confirmRestate(String(id ?? ''), String(messageId ?? ''), normalizeRestatement(edited) ?? undefined),

    getAgents: () => agents.list(),
    runAgents: (scenarios: string[], c?: unknown) => agents.run(Array.isArray(scenarios) ? scenarios : [], choice(c)),
    cancelAgent: (id: string) => agents.cancel(id),

    // Chat modes + slash commands (agent/modesIpc.ts).
    ...chatModeHandlers(chats)
  }

  for (const [name, fn] of Object.entries(handlers)) {
    ipcMain.handle(INVOKE_PREFIX + name, (_event, ...args) => fn(...args))
  }

  return {
    vision: (system, prompt, images, o) => layer.visionShot(system, prompt, images, o),
    // Forge Doctor: which providers have a key (never the key itself).
    providers: () => providers.list(),
    defaultProvider: () => providers.defaultModel().provider,
    // Editor inline completions (services/editorAssist): API keys and the usage meter.
    credentials,
    meter,
    summarize: (prompt) =>
      layer.oneShot('Summarize these incoming git changes for a teammate on a Roblox (Luau, Rojo) game: what changed, by whom, which features are touched and anything that may conflict with local work. Terse bullet points, at most 200 words.', prompt),
    dispose() {
      for (const name of Object.keys(handlers)) ipcMain.removeHandler(INVOKE_PREFIX + name)
      accounts.dispose()
      codexService().cancelSignIn()
      layer.dispose()
    }
  }
}
