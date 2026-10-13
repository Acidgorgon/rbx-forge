// Chat sessions with the main harness agent.
// Sessions and their messages persist in the 'chats' setting. Each chat has a provider and model.
// On anthropic it runs through the Agent SDK and remembers its SDK session id so follow-ups resume
// the conversation; on the other providers it runs runOpenAiLoop and keeps the OpenAI-format
// history itself. Switching provider mid-chat hands the visible transcript to the new provider.

import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { CanUseTool, McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk'
import type { ChatMessage, ChatSession, GroupParticipant, ModelChoice, ProviderId, Speaker } from '@shared/types'
import type { HarnessContext } from '../context.ts'
import type { Credentials } from './credentials.ts'
import { fromAnthropicUsage, fromOpenAiUsage, SdkUsageTracker, type Usage } from './budget/usage.ts'
import { routeModel, type Route } from './budget/budget.ts'
import { compactHistory, needsCompaction, SUMMARY_INSTRUCTIONS } from './budget/compact.ts'
import { shouldOrchestrate, type OrchestrateMode } from './orchestrator/heuristic.ts'
import type { Meter } from './meter.ts'
import { toSummary } from './meter.ts'
import { withRules } from './projectRules.ts'
import { GroupChat, planChecklist, type Room } from './groupChat.ts'
import { consultPhrase, makeParticipant, modelLabel, parseMentions, sameModel } from '../../shared/modelResolve.ts'
import { runOpenAiLoop, trimHistory, type FetchFn, type OaiMessage } from './openaiLoop.ts'
import { runResponsesLoop, usesResponsesApi } from './responsesLoop.ts'
import { extraBody, isProviderId, PROVIDERS, type Providers } from './providers.ts'
import {
  allowServer,
  model,
  executableOption,
  OPENAI_TOOLS_NOTE,
  sdkQuery,
  studioMcp,
  STUDIO_SERVER,
  SYSTEM_PROMPT,
  systemMessage,
  toChatMessages,
  userMessage,
  type QueryFn
} from './sdk.ts'
import { createGentreeServer, gentreeTools, SERVER_NAME, type ToolFs } from './tools.ts'

const SETTING = 'chats'
const MAX_MESSAGES = 500
const MAX_CHATS = 100

const MAX_TRANSCRIPT_CHARS = 12_000

interface StoredChat extends Omit<ChatSession, 'provider' | 'model'> {
  // Unset on chats saved by older versions: the default model applies.
  provider?: ProviderId
  model?: string
  sdkSessionId?: string
  // OpenAI-format conversation for non-anthropic providers.
  oaiHistory?: OaiMessage[]
  // Provider of the last turn, to notice switches.
  lastProvider?: ProviderId
  messages: ChatMessage[]
  // Group chat: what guests said outside the host's turns, prepended to its next prompt.
  groupNotes?: string[]
  // Model actually used by the last turn (routing never downgrades mid-chat).
  lastModel?: string
  // The person picked this chat's model explicitly: no automatic routing.
  modelPinned?: boolean
  route?: { model: string; tier: Route['tier']; reason: string }
  orchestrate?: OrchestrateMode
  orchestrations?: string[]
  // Last budget warning shown, so it is not repeated every turn.
  budgetWarned?: string
}

// Runs a multi-agent orchestration for a chat message (agent/index.ts wires the Orchestrator).
export type TeamRunner = (req: { chatId: string; text: string; choice: ModelChoice; signal: AbortSignal; onStart: (runId: string) => void }) => Promise<{
  state: 'done' | 'failed' | 'cancelled'
  answer?: string
  detail?: string
}>

type GroupRoute = { kind: 'host'; hint?: string } | { kind: 'direct'; guests: GroupParticipant[] } | { kind: 'asked' }

export interface ChatDeps {
  queryFn?: QueryFn
  credentials: Credentials
  // Builds the gentree MCP server for one query (tests can stub it).
  makeServer?: (ctx: HarnessContext) => McpServerConfig
  // Provider catalogue; without it only anthropic is available.
  providers?: Providers
  // fetch for the OpenAI-compatible loop (tests pass a fake).
  fetchFn?: FetchFn
  toolFs?: ToolFs
  // Project instructions block (.forge aiRules + AGENTS.md), appended to the system prompt.
  rules?: () => Promise<string>
  // Usage ledger + budget guard.
  meter?: Meter
  // Team mode (orchestrator); without it every message runs on the single chat agent.
  team?: TeamRunner
}

// OpenAI-compatible chats: compact the history at 80% of this window, down to 40%.
const COMPACT_WINDOW = 120_000

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// Decides tool use for the chat agent: gentree/studio tools are pre-allowed via allowedTools;
// built-in edits only inside the project (never Packages/); Bash only with the allowBash setting.
export function chatPermissions(ctx: HarnessContext): CanUseTool {
  return async (toolName, input) => {
    const root = ctx.project()?.root
    if (!root) return { behavior: 'deny', message: 'no project open' }
    if (toolName === 'Bash') {
      return ctx.getSetting('allowBash', false)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Bash is disabled in the harness settings' }
    }
    const file = (input.file_path ?? input.notebook_path ?? input.path) as string | undefined
    if (EDIT_TOOLS.has(toolName) || ['Read', 'Glob', 'Grep'].includes(toolName)) {
      if (!file) return { behavior: 'allow', updatedInput: input }
      const abs = isAbsolute(file) ? file : resolve(root, file)
      const rel = relative(root, abs)
      if (rel.startsWith('..') || isAbsolute(rel)) return { behavior: 'deny', message: 'outside the project' }
      if (EDIT_TOOLS.has(toolName) && (rel === 'Packages' || rel.startsWith('Packages' + sep))) {
        return { behavior: 'deny', message: 'Packages/ is managed by Wally' }
      }
      return { behavior: 'allow', updatedInput: input }
    }
    return { behavior: 'deny', message: `${toolName} is not available in the harness` }
  }
}

export class ChatManager {
  private ctx: HarnessContext
  private deps: ChatDeps
  private chats: StoredChat[]
  private running = new Map<string, AbortController>()
  private saveTimer: NodeJS.Timeout | null = null
  private group: GroupChat
  // Group-chat room of each running chat (host tools look it up).
  private rooms = new Map<string, Room>()

  constructor(ctx: HarnessContext, deps: ChatDeps) {
    this.ctx = ctx
    this.deps = deps
    this.group = new GroupChat(ctx, deps)
    const stored = ctx.getSetting<{ sessions?: StoredChat[] } | null>(SETTING, null)
    this.chats = Array.isArray(stored?.sessions) ? stored.sessions : []
  }

  list(): ChatSession[] {
    return this.chats.map((c) => this.session(c))
  }

  create(choice?: ModelChoice): ChatSession {
    const pick = choice && isProviderId(choice.provider) && choice.model?.trim() ? choice : this.defaultChoice()
    const chat: StoredChat = {
      id: randomUUID(),
      title: 'New chat',
      createdAt: Date.now(),
      provider: pick.provider,
      model: pick.model.trim(),
      messages: [],
      // A model picked for this chat is an explicit choice: routing keeps it. Chats on the default
      // model are routed (cheap tier for simple asks, big tier for large tasks).
      ...(pick === choice ? { modelPinned: true } : {})
    }
    this.chats.unshift(chat)
    if (this.chats.length > MAX_CHATS) this.chats.length = MAX_CHATS
    this.save()
    return this.session(chat)
  }

  setModel(id: string, provider: ProviderId, model: string): ChatSession {
    const chat = this.find(id)
    if (!chat) throw new Error(`unknown chat ${id}`)
    if (!isProviderId(provider) || !model?.trim()) throw new Error('invalid model choice')
    chat.provider = provider
    chat.model = model.trim()
    // An explicit pick is an override: routing keeps this model.
    chat.modelPinned = true
    this.save()
    return this.session(chat)
  }

  private defaultChoice(): ModelChoice {
    return this.deps.providers?.defaultModel() ?? { provider: 'anthropic', model: model(this.ctx) }
  }

  private choice(chat: StoredChat): ModelChoice {
    if (chat.provider && isProviderId(chat.provider) && chat.model) return { provider: chat.provider, model: chat.model }
    return this.defaultChoice()
  }

  private session(c: StoredChat): ChatSession {
    const { provider, model } = this.choice(c)
    const s: ChatSession = { id: c.id, title: c.title, createdAt: c.createdAt, provider, model }
    if (c.guests?.length) s.guests = c.guests
    if (c.guestTools === false) s.guestTools = false
    if (c.usage?.length) s.usage = c.usage
    if (this.deps.meter) {
      const t = this.deps.meter.ledger.chat(c.id)
      if (t.requests) s.meter = toSummary(t)
    }
    if (c.route) s.route = c.route
    if (c.orchestrate && c.orchestrate !== 'auto') s.orchestrate = c.orchestrate
    if (c.orchestrations?.length) s.orchestrations = c.orchestrations
    return s
  }

  messages(id: string): ChatMessage[] | null {
    return this.find(id)?.messages ?? null
  }

  busy(id: string): boolean {
    return this.running.has(id)
  }

  // Starts a turn and returns once it is underway; progress arrives as chat:message events.
  async send(id: string, text: string): Promise<void> {
    const chat = this.find(id)
    if (!chat) throw new Error(`unknown chat ${id}`)
    if (this.running.has(id)) throw new Error('chat is busy')
    const root = this.ctx.project()?.root
    this.push(chat, userMessage('main', text))
    if (chat.title === 'New chat') chat.title = text.replace(/\s+/g, ' ').trim().slice(0, 48) || 'Chat'
    if (!root) {
      this.push(chat, systemMessage('main', 'Open a project first.'))
      return
    }

    // Budget: a hard cap stops the turn; a soft cap adds a one-time note.
    const meter = this.deps.meter
    if (meter) {
      const check = meter.checkChat(chat.id)
      if (check.level === 'stop') {
        this.push(chat, systemMessage('main', `Budget: ${check.reason ?? 'limit reached'}. Raise the limit in settings or start a new chat.`))
        return
      }
      if (check.level === 'warn' && check.reason && chat.budgetWarned !== check.reason) {
        chat.budgetWarned = check.reason
        this.push(chat, systemMessage('main', `Budget: ${check.reason}.`))
      }
    }

    const picked = this.choice(chat)
    const { provider } = picked
    const modelId = this.routeTurn(chat, text)
    let start: () => Promise<void>
    const abort = new AbortController()
    const rules = (await this.deps.rules?.().catch(() => '')) ?? ''

    // Group chat: "@sol ..." goes straight to that guest; "talk to sol 6.1 ..." invites it and
    // tells the host to consult it.
    const route = await this.routeGroup(chat, text)
    if (route.kind === 'asked') return
    if (route.kind === 'direct') {
      const room = this.room(chat, abort.signal)
      this.runExclusive(chat, abort, async () => {
        for (const g of route.guests) {
          if (abort.signal.aborted) break
          await this.group.ask(room, g, text, 'direct', 'User')
        }
        if (abort.signal.aborted) this.push(chat, systemMessage('main', 'Stopped.'))
      })
      return
    }
    // Team mode: big multi-part requests go to the orchestrator (lead + specialists).
    if (this.deps.team && !route.hint && !chat.guests?.length) {
      const mode = chat.orchestrate ?? 'auto'
      const scriptCount = this.ctx.scripts().reduce((n, g) => n + g.scripts.length, 0)
      const decision = shouldOrchestrate(text, { scriptCount }, mode)
      if (decision.orchestrate) {
        this.push(chat, systemMessage('main', `Team mode: ${decision.reason}`))
        this.runExclusive(chat, abort, async () => {
          const r = await this.deps.team!({
            chatId: chat.id,
            text,
            choice: picked,
            signal: abort.signal,
            onStart: (runId) => {
              chat.orchestrations = [...(chat.orchestrations ?? []), runId].slice(-20)
              this.updated(chat)
            }
          })
          if (r.answer) this.push(chat, { id: randomUUID(), role: 'assistant', text: r.answer, at: Date.now(), agentId: 'main' })
          if (r.state !== 'done') this.push(chat, systemMessage('main', r.state === 'cancelled' ? 'Stopped.' : `Team run failed: ${r.detail ?? 'unknown error'}`))
        })
        return
      }
    }

    text = this.hostPrompt(chat, text, route.hint)
    this.rooms.set(id, this.room(chat, abort.signal))

    if (provider === 'anthropic') {
      const auth = await this.deps.credentials.anthropicAuth()
      if (!auth.ready) {
        this.push(chat, systemMessage('main', auth.error ?? 'Anthropic is not set up.'))
        return
      }
      start = () => this.runSdk(chat, text, root, abort, modelId, auth.env, rules)
    } else {
      const ep = this.deps.providers ? await this.deps.providers.endpoint(provider) : { error: 'Providers are not available.' }
      if ('error' in ep) {
        this.push(chat, systemMessage('main', ep.error))
        return
      }
      start = () => this.runOpenAi(chat, text, abort, ep.baseUrl, ep.headers, provider, modelId, rules)
    }

    this.running.set(id, abort)
    this.ctx.emit('chat:busy', { sessionId: id, busy: true })
    void start().finally(() => {
      chat.lastProvider = provider
      chat.lastModel = modelId
      this.deps.meter?.setLive(chat.id, null)
      this.rooms.delete(id)
      this.running.delete(id)
      this.ctx.emit('chat:busy', { sessionId: id, busy: false })
      this.save()
    })
  }

  stop(id: string): void {
    this.running.get(id)?.abort()
  }

  dispose(): void {
    for (const a of this.running.values()) a.abort()
    this.flush()
  }

  // Model for this turn: the chat's model, or a cheaper/bigger tier picked by routeModel when the
  // person did not pin one. Never downgrades mid-chat (the prompt cache is per model).
  private routeTurn(chat: StoredChat, text: string): string {
    const { provider, model: chosen } = this.choice(chat)
    const r = routeModel({
      task: 'chat',
      text,
      settings: { provider, model: chosen, autoRoute: this.ctx.getSetting<boolean>('autoRoute', true) !== false, tiers: this.ctx.getSetting('modelTiers', undefined) },
      override: chat.modelPinned ? chosen : undefined,
      previousModel: chat.lastProvider === provider ? chat.lastModel : undefined
    })
    chat.route = { model: r.model, tier: r.tier, reason: r.reason }
    return r.model
  }

  setOrchestrateMode(id: string, mode: OrchestrateMode): ChatSession {
    const chat = this.find(id)
    if (!chat) throw new Error(`unknown chat ${id}`)
    if (!['auto', 'single', 'team'].includes(mode)) throw new Error(`invalid mode ${mode}`)
    chat.orchestrate = mode === 'auto' ? undefined : mode
    this.updated(chat)
    return this.session(chat)
  }

  orchestrateMode(id: string): OrchestrateMode {
    const chat = this.find(id)
    if (!chat) throw new Error(`unknown chat ${id}`)
    return chat.orchestrate ?? 'auto'
  }

  buildOptions(chat: StoredChat, root: string, abort: AbortController, modelId = this.choice(chat).model, env?: Record<string, string | undefined>, rules = ''): Options {
    const allowBash = this.ctx.getSetting('allowBash', false)
    const mcpServers: Record<string, McpServerConfig> = {
      [SERVER_NAME]: (this.deps.makeServer ?? ((c) => createGentreeServer(c, { extraTools: this.group.hostTools(() => this.rooms.get(chat.id) ?? null) })))(this.ctx)
    }
    const allowedTools = [...allowServer(SERVER_NAME), 'Read', 'Glob', 'Grep']
    const studio = studioMcp(this.ctx)
    if (studio) {
      mcpServers[STUDIO_SERVER] = studio
      allowedTools.push(...allowServer(STUDIO_SERVER))
    }
    return {
      cwd: root,
      model: modelId,
      systemPrompt: withRules(SYSTEM_PROMPT, rules),
      ...(env ? { env } : {}),
      ...(this.deps.meter?.guard.sdkOptions('chat') ?? {}),
      ...executableOption(),
      abortController: abort,
      mcpServers,
      // Only our servers, not the user's global MCP config, to keep the tool list (and tokens) small.
      strictMcpConfig: true,
      // Base built-in tool set; anything else is not even shown to the model.
      tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', ...(allowBash ? ['Bash'] : [])],
      allowedTools,
      // 'default' routes anything not pre-allowed to canUseTool, which enforces project bounds.
      permissionMode: 'default',
      canUseTool: chatPermissions(this.ctx),
      // Do not pick up user/project settings files whose permission rules could widen access.
      settingSources: [],
      ...(chat.sdkSessionId ? { resume: chat.sdkSessionId } : {})
    }
  }

  private async runSdk(
    chat: StoredChat,
    text: string,
    root: string,
    abort: AbortController,
    modelId: string,
    env?: Record<string, string | undefined>,
    rules = ''
  ): Promise<void> {
    const queryFn = this.deps.queryFn ?? sdkQuery
    const meter = this.deps.meter
    // Coming from another provider: the SDK session does not know those turns, so start a fresh
    // session that carries the visible transcript.
    let prompt = text
    if (chat.lastProvider && chat.lastProvider !== 'anthropic') {
      chat.sdkSessionId = undefined
      const transcript = transcriptText(chat.messages.slice(0, -1), this.choice(chat))
      if (transcript) prompt = `Earlier in this conversation (another model):\n${transcript}\n\nNew message:\n${text}`
    }
    // Ledger: per-model deltas of the SDK's cumulative modelUsage (baseline per SDK session).
    const tracker = new SdkUsageTracker(modelId, chat.sdkSessionId && meter ? meter.ledger.sdkBaseline(chat.sdkSessionId) : {})
    try {
      for await (const m of queryFn({ prompt, options: this.buildOptions(chat, root, abort, modelId, env, rules) })) {
        if ('session_id' in m && m.session_id && chat.sdkSessionId !== m.session_id) chat.sdkSessionId = m.session_id
        for (const cm of toChatMessages(m, 'main')) this.push(chat, cm)
        if (m.type === 'result' && m.usage) this.recordUsage(chat, this.hostSpeaker(chat), fromAnthropicUsage(m.usage as any))
        if (meter) {
          meter.ledger.recordAll(tracker.onMessage(m), { chatId: chat.id })
          if (m.type === 'result' && chat.sdkSessionId) meter.ledger.setSdkBaseline(chat.sdkSessionId, tracker.snapshot())
          if (m.type === 'assistant') {
            meter.setLive(chat.id, tracker.live())
            meter.changed('chat', chat.id, { model: modelId, provider: 'anthropic', ...(chat.route ? { route: { tier: chat.route.tier, reason: chat.route.reason } } : {}) })
          }
        }
      }
    } catch (e) {
      if (abort.signal.aborted) this.push(chat, systemMessage('main', 'Stopped.'))
      else this.push(chat, systemMessage('main', `Error: ${(e as Error).message}`))
    } finally {
      if (meter) {
        meter.ledger.recordAll(tracker.finish(), { chatId: chat.id })
        meter.setLive(chat.id, null)
      }
    }
  }

  private async runOpenAi(
    chat: StoredChat,
    text: string,
    abort: AbortController,
    baseUrl: string,
    headers: Record<string, string>,
    provider: ProviderId,
    modelId: string,
    rules = ''
  ): Promise<void> {
    // Same provider as last turn: continue its history (tool calls and all). Otherwise seed with the
    // visible transcript; tool-call history is provider-specific (e.g. Gemini thought signatures).
    let history: OaiMessage[] = chat.lastProvider === provider && chat.oaiHistory ? chat.oaiHistory : transcriptHistory(chat.messages.slice(0, -1), this.choice(chat))
    // Long histories: summarize the older turns with the cheap model (80% -> 40% of the window).
    history = await this.compact(history, baseUrl, headers, provider, modelId, abort.signal)
    history = [...history, { role: 'user', content: text }]
    const meter = this.deps.meter
    const maxTurns = Number(this.ctx.getSetting('chatMaxTurns', 50)) || 50
    const result = await (usesResponsesApi(provider, modelId) ? runResponsesLoop : runOpenAiLoop)({
      baseUrl,
      headers,
      model: modelId,
      system: withRules(SYSTEM_PROMPT + OPENAI_TOOLS_NOTE, rules),
      history,
      tools: [...gentreeTools(this.ctx, this.deps.toolFs ? { fs: this.deps.toolFs } : {}), ...this.group.hostTools(() => this.rooms.get(chat.id) ?? null)],
      maxTurns,
      signal: abort.signal,
      agentId: 'main',
      emit: (m) => this.push(chat, m),
      extraBody: extraBody(provider, modelId),
      fetchFn: this.deps.fetchFn,
      onUsage: (raw) => {
        const u = fromOpenAiUsage(raw)
        if (u) this.recordUsage(chat, this.hostSpeaker(chat), u)
        meter?.ledger.recordOpenAi(raw, { provider, model: modelId, chatId: chat.id })
      },
      // Hard caps (chatMaxCostUsd, daily) end the loop between requests.
      stop: meter ? () => meter.checkChat(chat.id).level === 'stop' : undefined
    })
    chat.oaiHistory = trimHistory(result.history)
    if (result.outcome === 'aborted') this.push(chat, systemMessage('main', 'Stopped.'))
    if (result.outcome === 'error') this.ctx.log({ service: 'agent', stream: 'stderr', text: `${PROVIDERS[provider].label}: ${result.error}` })
  }

  // Summarizes old turns when the history nears the window. Errors keep the history as is.
  private async compact(history: OaiMessage[], baseUrl: string, headers: Record<string, string>, provider: ProviderId, modelId: string, signal: AbortSignal): Promise<OaiMessage[]> {
    const window = Number(this.ctx.getSetting('compactWindowTokens', COMPACT_WINDOW)) || COMPACT_WINDOW
    if (!needsCompaction(history as any, 0.8 * window)) return history
    const cheap = routeModel({ task: 'summary', text: '', settings: { provider, model: modelId, tiers: this.ctx.getSetting('modelTiers', undefined) } }).model
    try {
      const r = await compactHistory(history as any, {
        budgetTokens: 0.4 * window,
        keepTurns: 4,
        toolMaxTokens: 2000,
        summarize: async (t: string) => {
          let out = ''
          const res = await (usesResponsesApi(provider, cheap) ? runResponsesLoop : runOpenAiLoop)({
            baseUrl,
            headers,
            model: cheap,
            system: SUMMARY_INSTRUCTIONS,
            history: [{ role: 'user', content: t }],
            tools: [],
            maxTurns: 1,
            signal,
            agentId: 'compact',
            emit: (m) => {
              if (m.role === 'assistant') out = m.text
            },
            extraBody: extraBody(provider, cheap),
            fetchFn: this.deps.fetchFn
          })
          if (res.outcome === 'error' || !out.trim()) throw new Error(res.error ?? 'empty summary')
          return out
        }
      })
      return r.messages as OaiMessage[]
    } catch (e) {
      this.ctx.log({ service: 'agent', stream: 'stderr', text: `compaction skipped: ${(e as Error).message}` })
      return history
    }
  }

  // ---- group chat ----

  private hostSpeaker(chat: StoredChat): Speaker {
    const c = this.choice(chat)
    return { provider: c.provider, model: c.model, label: modelLabel(c.model) }
  }

  private room(chat: StoredChat, signal: AbortSignal): Room {
    const host = makeParticipant(this.choice(chat), 'host')
    return {
      id: chat.id,
      host,
      get guests() {
        return chat.guests ?? []
      },
      guestTools: chat.guestTools !== false,
      get messages() {
        return chat.messages
      },
      signal,
      push: (m) => this.push(chat, m),
      addGuest: (p) => {
        chat.guests = [...(chat.guests ?? []).filter((g) => !sameModel(g, p)), p]
        this.updated(chat)
      },
      recordUsage: (speaker, u) => this.recordUsage(chat, speaker, u),
      note: (t) => {
        const notes = (chat.groupNotes ??= [])
        notes.push(t)
        if (notes.length > 20) notes.splice(0, notes.length - 20)
      }
    }
  }

  private updated(chat: StoredChat): void {
    this.ctx.emit('chat:updated', this.session(chat))
    this.save()
  }

  private recordUsage(chat: StoredChat, speaker: Speaker, u: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): void {
    const input = u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)
    if (!input && !u.output) return
    const list = (chat.usage ??= [])
    let row = list.find((r) => r.provider === speaker.provider && r.model === speaker.model)
    if (!row) list.push((row = { provider: speaker.provider, model: speaker.model, label: speaker.label, input: 0, output: 0, calls: 0 }))
    row.input += input
    row.output += u.output
    row.calls++
    this.updated(chat)
  }

  // Decides who answers a user message in a group chat.
  private async routeGroup(chat: StoredChat, text: string): Promise<GroupRoute> {
    const mentions = parseMentions(text)
    const phrase = mentions.length ? null : consultPhrase(text)
    if (!mentions.length && !phrase) return { kind: 'host' }
    const room = this.room(chat, new AbortController().signal)
    const askWhich = (name: string, options: ModelChoice[]) => {
      this.push(chat, systemMessage('main', `Which model did you mean by “${name}”? ${options.map((o) => `${o.provider}/${o.model}`).join(', ')}. Reply with an @mention or the full id.`))
      return { kind: 'asked' } as const
    }
    if (mentions.length) {
      let hostMentioned = false
      const guests: GroupParticipant[] = []
      for (const name of mentions) {
        const r = await this.group.resolve(name, room)
        if (r.kind === 'ambiguous') return askWhich(`@${name}`, r.options)
        if (r.kind !== 'ok') continue
        const p = this.group.ensureGuest(room, r.choice)
        if (p.role === 'host') hostMentioned = true
        else if (!guests.includes(p)) guests.push(p)
      }
      if (!guests.length) return { kind: 'host' }
      if (!hostMentioned) return { kind: 'direct', guests }
      return { kind: 'host', hint: `The user mentioned ${guests.map((g) => `@${g.alias} (${g.label})`).join(', ')}: use the consult_model tool to talk to them.` }
    }
    const r = await this.group.resolve(phrase!, room)
    if (r.kind === 'ambiguous') return askWhich(phrase!, r.options)
    if (r.kind !== 'ok') return { kind: 'host' }
    const p = this.group.ensureGuest(room, r.choice)
    if (p.role === 'host') return { kind: 'host' }
    return {
      kind: 'host',
      hint: `The user wants you to work with ${p.label}. Call the consult_model tool with model "${p.alias}" (mode "debate" to have it challenge your proposal; call again to go back and forth), then give the user the combined result.`
    }
  }

  // The host's prompt: group notes since its last turn, the user's text, and a routing hint.
  private hostPrompt(chat: StoredChat, text: string, hint?: string): string {
    const notes = chat.groupNotes ?? []
    chat.groupNotes = []
    if (!notes.length && !hint) return text
    let pre = notes.length ? `Group chat since your last turn:\n${notes.join('\n')}`.slice(-6000) + '\n\n' : ''
    if (pre) pre += 'User:\n'
    return `${pre}${text}${hint ? `\n\n[Group chat: ${hint}]` : ''}`
  }

  // Runs group work (direct answers, roundtables) under the chat's busy flag.
  private runExclusive(chat: StoredChat, abort: AbortController, fn: () => Promise<void>): void {
    this.running.set(chat.id, abort)
    this.ctx.emit('chat:busy', { sessionId: chat.id, busy: true })
    void fn()
      .catch((e) => this.push(chat, systemMessage('main', `Error: ${(e as Error).message}`)))
      .finally(() => {
        this.running.delete(chat.id)
        this.ctx.emit('chat:busy', { sessionId: chat.id, busy: false })
        this.save()
      })
  }

  addGuest(id: string, choice: ModelChoice): ChatSession {
    const chat = this.find(id)
    if (!chat) throw new Error(`unknown chat ${id}`)
    if (!isProviderId(choice?.provider) || !choice.model?.trim()) throw new Error('invalid model choice')
    const p = this.group.ensureGuest(this.room(chat, new AbortController().signal), { provider: choice.provider, model: choice.model.trim() })
    if (p.role === 'host') throw new Error('that model is already the host of this chat')
    return this.session(chat)
  }

  removeGuest(id: string, key: string): ChatSession {
    const chat = this.find(id)
    if (!chat) throw new Error(`unknown chat ${id}`)
    const k = String(key ?? '').toLowerCase()
    chat.guests = (chat.guests ?? []).filter((g) => g.alias.toLowerCase() !== k && `${g.provider}/${g.model}`.toLowerCase() !== k)
    this.updated(chat)
    return this.session(chat)
  }

  setGuestTools(id: string, on: boolean): ChatSession {
    const chat = this.find(id)
    if (!chat) throw new Error(`unknown chat ${id}`)
    chat.guestTools = on ? undefined : false
    this.updated(chat)
    return this.session(chat)
  }

  // Starts a roundtable; progress arrives as chat:message events.
  async roundtable(id: string, topic: string, rounds?: number): Promise<void> {
    const chat = this.find(id)
    if (!chat) throw new Error(`unknown chat ${id}`)
    if (this.running.has(id)) throw new Error('chat is busy')
    const t = String(topic ?? '').trim()
    if (!t) throw new Error('a roundtable needs a topic')
    if (!chat.guests?.length) throw new Error('add a guest model first')
    if (chat.title === 'New chat') chat.title = `Roundtable: ${t}`.replace(/\s+/g, ' ').slice(0, 48)
    this.push(chat, userMessage('main', `Roundtable: ${t}`))
    const abort = new AbortController()
    const room = this.room(chat, abort.signal)
    this.runExclusive(chat, abort, async () => {
      await this.group.roundtable(room, t, rounds)
      if (abort.signal.aborted) this.push(chat, systemMessage('main', 'Stopped.'))
    })
  }

  // Posts a plan card's steps as a checklist message.
  planToChecklist(id: string, messageId: string): ChatMessage {
    const chat = this.find(id)
    if (!chat) throw new Error(`unknown chat ${id}`)
    const plan = chat.messages.find((m) => m.id === messageId)
    if (!plan) throw new Error('message not found')
    const m: ChatMessage = { id: randomUUID(), role: 'assistant', text: planChecklist(plan.text), at: Date.now(), agentId: 'main', card: 'checklist' }
    if (plan.speaker) m.speaker = plan.speaker
    this.push(chat, m)
    return m
  }

  private find(id: string): StoredChat | undefined {
    return this.chats.find((c) => c.id === id)
  }

  // Adds a message, or replaces one with the same id (streamed assistant text, tool results).
  private push(chat: StoredChat, m: ChatMessage): void {
    // In a group chat the host's own messages carry its name too.
    if (chat.guests?.length && !m.speaker && m.agentId === 'main' && (m.role === 'assistant' || m.role === 'tool')) m = { ...m, speaker: this.hostSpeaker(chat) }
    const i = chat.messages.findIndex((x) => x.id === m.id)
    if (i >= 0) {
      chat.messages[i] = m
      this.ctx.emit('chat:message', { ...m, sessionId: chat.id } as ChatMessage)
      this.save()
      return
    }
    chat.messages.push(m)
    if (chat.messages.length > MAX_MESSAGES) chat.messages.splice(0, chat.messages.length - MAX_MESSAGES)
    this.ctx.emit('chat:message', { ...m, sessionId: chat.id } as ChatMessage)
    this.save()
  }

  // Debounced persistence: settings writes hit disk.
  private save(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => this.flush(), 500)
    this.saveTimer.unref?.()
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.ctx.setSetting(SETTING, { sessions: this.chats })
  }
}

// The visible conversation as plain user/assistant turns (tool chips and notices left out).
function transcriptHistory(messages: ChatMessage[], host?: ModelChoice): OaiMessage[] {
  const out: OaiMessage[] = []
  let size = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.agentId !== 'main' || (m.role !== 'user' && m.role !== 'assistant') || !m.text.trim()) continue
    // Group chat: other models' messages are labelled with their name.
    const text = m.speaker && !(host && sameModel(m.speaker, host)) ? `[${m.speaker.label}] ${m.text}` : m.text
    size += text.length
    if (size > MAX_TRANSCRIPT_CHARS) break
    const prev = out[0]
    // Merge consecutive same-role entries so roles alternate.
    if (prev && prev.role === m.role) prev.content = `${text}\n\n${prev.content}`
    else out.unshift({ role: m.role, content: text } as OaiMessage)
  }
  while (out.length && out[0].role !== 'user') out.shift()
  return out
}

function transcriptText(messages: ChatMessage[], host?: ModelChoice): string {
  return transcriptHistory(messages, host)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')
}
