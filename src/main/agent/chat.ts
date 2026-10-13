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
import { fromAnthropicUsage, fromOpenAiUsage } from './budget/usage.ts'
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
}

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
}

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
      messages: []
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

    const { provider, model: modelId } = this.choice(chat)
    let start: () => Promise<void>
    const abort = new AbortController()

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
    text = this.hostPrompt(chat, text, route.hint)
    this.rooms.set(id, this.room(chat, abort.signal))

    if (provider === 'anthropic') {
      const auth = await this.deps.credentials.anthropicAuth()
      if (!auth.ready) {
        this.push(chat, systemMessage('main', auth.error ?? 'Anthropic is not set up.'))
        return
      }
      start = () => this.runSdk(chat, text, root, abort, modelId, auth.env)
    } else {
      const ep = this.deps.providers ? await this.deps.providers.endpoint(provider) : { error: 'Providers are not available.' }
      if ('error' in ep) {
        this.push(chat, systemMessage('main', ep.error))
        return
      }
      start = () => this.runOpenAi(chat, text, abort, ep.baseUrl, ep.headers, provider, modelId)
    }

    this.running.set(id, abort)
    this.ctx.emit('chat:busy', { sessionId: id, busy: true })
    void start().finally(() => {
      chat.lastProvider = provider
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

  buildOptions(chat: StoredChat, root: string, abort: AbortController, modelId = this.choice(chat).model, env?: Record<string, string | undefined>): Options {
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
      systemPrompt: SYSTEM_PROMPT,
      ...(env ? { env } : {}),
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
    env?: Record<string, string | undefined>
  ): Promise<void> {
    const queryFn = this.deps.queryFn ?? sdkQuery
    // Coming from another provider: the SDK session does not know those turns, so start a fresh
    // session that carries the visible transcript.
    let prompt = text
    if (chat.lastProvider && chat.lastProvider !== 'anthropic') {
      chat.sdkSessionId = undefined
      const transcript = transcriptText(chat.messages.slice(0, -1), this.choice(chat))
      if (transcript) prompt = `Earlier in this conversation (another model):\n${transcript}\n\nNew message:\n${text}`
    }
    try {
      for await (const m of queryFn({ prompt, options: this.buildOptions(chat, root, abort, modelId, env) })) {
        if ('session_id' in m && m.session_id && chat.sdkSessionId !== m.session_id) chat.sdkSessionId = m.session_id
        for (const cm of toChatMessages(m, 'main')) this.push(chat, cm)
        if (m.type === 'result' && m.usage) this.recordUsage(chat, this.hostSpeaker(chat), fromAnthropicUsage(m.usage as any))
      }
    } catch (e) {
      if (abort.signal.aborted) this.push(chat, systemMessage('main', 'Stopped.'))
      else this.push(chat, systemMessage('main', `Error: ${(e as Error).message}`))
    }
  }

  private async runOpenAi(
    chat: StoredChat,
    text: string,
    abort: AbortController,
    baseUrl: string,
    headers: Record<string, string>,
    provider: ProviderId,
    modelId: string
  ): Promise<void> {
    // Same provider as last turn: continue its history (tool calls and all). Otherwise seed with the
    // visible transcript; tool-call history is provider-specific (e.g. Gemini thought signatures).
    let history: OaiMessage[] = chat.lastProvider === provider && chat.oaiHistory ? chat.oaiHistory : transcriptHistory(chat.messages.slice(0, -1), this.choice(chat))
    history = [...history, { role: 'user', content: text }]
    const maxTurns = Number(this.ctx.getSetting('chatMaxTurns', 50)) || 50
    const result = await (usesResponsesApi(provider, modelId) ? runResponsesLoop : runOpenAiLoop)({
      baseUrl,
      headers,
      model: modelId,
      system: SYSTEM_PROMPT + OPENAI_TOOLS_NOTE,
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
      }
    })
    chat.oaiHistory = trimHistory(result.history)
    if (result.outcome === 'aborted') this.push(chat, systemMessage('main', 'Stopped.'))
    if (result.outcome === 'error') this.ctx.log({ service: 'agent', stream: 'stderr', text: `${PROVIDERS[provider].label}: ${result.error}` })
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
