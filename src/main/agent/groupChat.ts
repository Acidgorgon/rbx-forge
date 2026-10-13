// Group chat: one chat, several models. The host is the chat's own model (it has the project
// tools and is the only one that edits files); guests are other models the user has ready, invited
// as read-only advisers.
//
// Three ways to talk to guests:
// - Ask/debate: the host calls consult_model (or invite_model) itself, e.g. after "communicate with
//   openai sol 6.1 and come up with a plan". send() also spots that phrasing, invites the model up
//   front and tells the host whom to consult.
// - Direct: "@sol what do you think?" goes straight to that guest; the host is not run.
// - Roundtable: models take turns on a topic for N rounds, each seeing the shared transcript, then
//   the host writes a plan card (agreements, disagreements, recommendation).
//
// Token thrift: a guest never gets the chat history. Each call gets a context pack (the ask, a
// one-paragraph project summary, the last K group messages, all clipped to a character budget),
// a small output cap, and at most a few read-only tool turns (or none). The host learns what was
// said outside its own turns through short notes prepended to its next prompt.

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ChatImage, ChatMessage, GroupParticipant, GroupUsage, ModelChoice, ProviderId, Speaker } from '@shared/types'
import type { HarnessContext } from '../context.ts'
import { fromAnthropicUsage, fromOpenAiUsage } from './budget/usage.ts'
import type { Credentials } from './credentials.ts'
import { makeParticipant, resolveModel, sameModel, type Resolution } from '../../shared/modelResolve.ts'
import { runOpenAiLoop, type FetchFn } from './openaiLoop.ts'
import { extraBody, type Providers } from './providers.ts'
import { runResponsesLoop, usesResponsesApi } from './responsesLoop.ts'
import { allowServer, executableOption, sdkQuery, toChatMessages, type QueryFn } from './sdk.ts'
import { chatImageStore, hasChatImageStore } from './chatImages.ts'
import { anthropicPrompt, chatCompletionsContent, type ImagePayload } from './imageParts.ts'
import { supportsVision } from '../../shared/modelCaps.ts'
import { defineTool, gentreeTools, runTool, SERVER_NAME, wrapInSdkServer, type GentreeTool, type ToolFs } from './tools.ts'

// Read tools a guest may use, when guest tools are on. Never any of WRITE_TOOLS.
export const GUEST_TOOLS = ['project_overview', 'list_scripts', 'read_script', 'explorer_tree', 'find_instance', 'search_code', 'project_map', 'find_symbol', 'blink_events', 'recall', 'use_skill'] as const
// Lines per read_script call for guests (the host gets 400).
export const GUEST_READ_LINES = 120

export const DEFAULTS = {
  // Messages of the group transcript a guest sees.
  recentMessages: 8,
  // Character budget of the whole context pack (~2k tokens).
  packChars: 8000,
  // Per message in the pack.
  messageChars: 1500,
  // Output token cap per guest call (reasoning models count thinking against it).
  guestMaxTokens: 4000,
  // Tool turns per guest call when tools are on.
  guestMaxTurns: 6,
  rounds: 2,
  maxRounds: 4,
  // consult_model result handed back to the host.
  replyChars: 6000
}

export type GroupMode = 'ask' | 'debate' | 'direct' | 'roundtable' | 'synthesis'

// What the engine needs from a chat. ChatManager builds one per run; tests build a plain object.
export interface Room {
  id: string
  host: GroupParticipant
  guests: GroupParticipant[]
  guestTools: boolean
  messages: ChatMessage[]
  signal: AbortSignal
  push(m: ChatMessage): void
  addGuest(p: GroupParticipant): void
  recordUsage(speaker: Speaker, usage: { input: number; output: number }): void
  // Something the host did not see (direct answers, roundtable turns): shown on its next turn.
  note(text: string): void
  // Images of the latest user message; guests that read images get them with an ask.
  images?: ChatImage[]
}

export interface GroupDeps {
  credentials: Credentials
  providers?: Providers
  queryFn?: QueryFn
  fetchFn?: FetchFn
  toolFs?: ToolFs
  // Extra read tools offered to guests (e.g. the budget layer's search_code), filtered by GUEST_TOOLS.
  extraReadTools?: (ctx: HarnessContext) => GentreeTool<any>[]
  // Project instructions block (.forge aiRules + AGENTS.md), appended to the host's system prompt.
  rules?: () => Promise<string>
}

export interface ContextPackInput {
  ask: string
  projectSummary?: string
  transcript: ChatMessage[]
  host: Speaker
  recent?: number
  maxChars?: number
  messageChars?: number
}

function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length <= max ? t : t.slice(0, Math.max(0, max - 1)).trimEnd() + '…'
}

export function speakerOf(p: Speaker): Speaker {
  return { provider: p.provider, model: p.model, label: p.label }
}

// Name shown for a transcript message.
function who(m: ChatMessage, host: Speaker): string {
  if (m.role === 'user') return 'User'
  return m.speaker?.label ?? host.label
}

// The compact context a guest gets instead of the chat history. Never longer than maxChars:
// the ask and summary are clipped first, then the oldest messages are dropped.
export function buildContextPack(input: ContextPackInput): string {
  const maxChars = input.maxChars ?? DEFAULTS.packChars
  const per = input.messageChars ?? DEFAULTS.messageChars
  const ask = `## Ask\n${clip(input.ask, Math.min(1500, Math.floor(maxChars / 4)))}`
  const project = input.projectSummary ? `## Project\n${clip(input.projectSummary, Math.min(1000, Math.floor(maxChars / 6)))}` : ''
  const head = [ask, project].filter(Boolean).join('\n\n')

  const lines = input.transcript
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim())
    .slice(-(input.recent ?? DEFAULTS.recentMessages))
    .map((m) => `[${who(m, input.host)}]: ${clip(m.text, per)}`)
  const title = '\n\n## Recent group messages\n'
  let budget = maxChars - head.length - title.length
  const kept: string[] = []
  for (let i = lines.length - 1; i >= 0 && budget > 0; i--) {
    const l = lines[i]
    if (l.length + 2 > budget) {
      // Room for the tail of the newest message only.
      if (!kept.length && budget > 80) kept.unshift(clip(l, budget - 2))
      break
    }
    kept.unshift(l)
    budget -= l.length + 2
  }
  const out = kept.length ? head + title + kept.join('\n\n') : head
  return out.length <= maxChars ? out : clip(out, maxChars)
}

// The checklist for "Make this a task list": list items of the Recommendation (or Plan/Steps)
// section, else every list item, else every sentence-ish line.
export function planChecklist(plan: string): string {
  const sections = plan.split(/\n(?=#{1,4}\s)/)
  const pick = sections.find((s) => /^#{1,4}\s*(final\s+)?(recommendation|plan|steps|next steps|tasks)/i.test(s.trim()))
  const source = pick ?? plan
  const items = source
    .split('\n')
    .map((l) => /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(l)?.[1]?.trim())
    .filter((x): x is string => !!x)
  const list = items.length
    ? items
    : source
        .split('\n')
        .map((l) => l.replace(/^#+\s*/, '').trim())
        .filter((l) => l && !/^(recommendation|plan|steps)$/i.test(l))
  return list.map((t) => `- [ ] ${t.replace(/\*\*/g, '')}`).join('\n')
}

const GUEST_SYSTEM = (me: Speaker, host: Speaker, tools: boolean) => `You are ${me.label}, a guest adviser in a group chat inside RBX Forge, a desktop harness for a Roblox game (Luau, Rojo, Wally packages, Blink networking; Features live in src/shared/Features, src/server/Features and client Controllers).
The host model, ${host.label}, owns the project and is the only participant that edits files. You are read-only: advise, critique, plan.
${tools ? 'You may use the read-only project tools sparingly (a few calls at most) when a fact matters; never guess file contents you could check.' : 'You have no tools; reason from the context given.'}
Be concrete and brief (under 250 words unless asked for more). Name files and functions. Address other participants by name when you agree or disagree. Do not repeat the context back.`

const HOST_SYSTEM = (me: Speaker) => `You are ${me.label}, the host of a group chat inside RBX Forge, a desktop harness for a Roblox game (Luau, Rojo). Other models advise you; you own the project. In this turn you only talk (no edits).
Be concrete and brief (under 250 words). Name files and functions. Address other participants by name.`

function modeInstruction(mode: GroupMode, from: string, message: string, extra: { round?: number; rounds?: number; topic?: string } = {}): string {
  switch (mode) {
    case 'ask':
      return `${from} asks you:\n${message}\n\nAnswer directly.`
    case 'debate':
      return `${from} proposes:\n${message}\n\nChallenge it: point out risks, missing cases and better alternatives, then give your own concrete recommendation. Disagree where you genuinely disagree; agree briefly where you agree.`
    case 'direct':
      return `The user addressed you directly:\n${message}`
    case 'roundtable': {
      const last = extra.round === extra.rounds
      return `Roundtable on: ${extra.topic}\nRound ${extra.round} of ${extra.rounds}. Read the discussion so far, respond to the others by name, and add what is missing.${last ? ' This is the last round: state your final position in a few bullet points.' : ''}`
    }
    case 'synthesis':
      return `The roundtable on "${extra.topic}" is over. Write the plan for the user from it, using exactly these sections:\n## Agreements\n## Disagreements\n## Recommendation\nUnder Recommendation give a numbered list of concrete steps (files to touch, in order). Attribute positions to participants by name. Under 350 words.`
  }
}

export class GroupChat {
  private ctx: HarnessContext
  private deps: GroupDeps
  private summaryCache: { at: number; text: string } | null = null

  constructor(ctx: HarnessContext, deps: GroupDeps) {
    this.ctx = ctx
    this.deps = deps
  }

  private setting<T>(key: keyof typeof DEFAULTS): T {
    const v = this.ctx.getSetting<Partial<typeof DEFAULTS>>('groupChat', {})?.[key]
    return (typeof v === 'number' && v > 0 ? v : DEFAULTS[key]) as T
  }

  // Every model the user can call now: ready providers' model lists (cached; no network for ids
  // that are already known).
  async available(): Promise<ModelChoice[]> {
    const p = this.deps.providers
    if (!p) return []
    const infos = await p.list()
    const out: ModelChoice[] = []
    for (const info of infos) {
      if (!info.ready) continue
      const models = info.id === 'anthropic' ? info.models : await p.models(info.id).catch(() => info.models)
      for (const model of models) out.push({ provider: info.id, model })
    }
    return out
  }

  // Resolves a name to a participant (by alias or fuzzy) or to a model the user has ready.
  async resolve(phrase: string, room: Pick<Room, 'host' | 'guests'>): Promise<Resolution<ModelChoice & { alias?: string }>> {
    const people = [room.host, ...room.guests]
    const inRoom = resolveModel(phrase, people, room.host)
    if (inRoom.kind === 'ok') return inRoom
    const all = await this.available()
    const r = resolveModel(phrase, all, room.host)
    if (r.kind === 'ok') return { kind: 'ok', choice: people.find((p) => sameModel(p, r.choice)) ?? r.choice }
    return inRoom.kind === 'ambiguous' ? inRoom : r
  }

  // The participant for a choice, inviting it as a guest when it is not in the room yet.
  ensureGuest(room: Room, choice: ModelChoice): GroupParticipant {
    if (sameModel(choice, room.host)) return room.host
    const existing = room.guests.find((g) => sameModel(g, choice))
    if (existing) return existing
    const p = makeParticipant(choice, 'guest', [room.host.alias, ...room.guests.map((g) => g.alias)])
    room.addGuest(p)
    room.push({ id: randomUUID(), role: 'system', text: `${p.label} joined the chat as a guest (@${p.alias}).`, at: Date.now(), agentId: 'main' })
    return p
  }

  // Read tools for a guest: the GUEST_TOOLS subset, with read_script capped to GUEST_READ_LINES.
  guestTools(): GentreeTool<any>[] {
    const base = [...gentreeTools(this.ctx, { readOnly: true, ...(this.deps.toolFs ? { fs: this.deps.toolFs } : {}) }), ...(this.deps.extraReadTools?.(this.ctx) ?? [])]
    const allowed = new Set<string>(GUEST_TOOLS)
    return base
      .filter((t) => allowed.has(t.name))
      .map((t) => {
        if (t.name !== 'read_script') return t
        const capped: GentreeTool<any> = {
          ...t,
          description: `Read a project file with line numbers. Optional 1-based inclusive line range; at most ${GUEST_READ_LINES} lines per call.`,
          handler: async (args: any, extra: unknown) => {
            const from = args.from ?? 1
            const to = Math.min(args.to ?? from + GUEST_READ_LINES - 1, from + GUEST_READ_LINES - 1)
            return t.handler({ ...args, from, to }, extra)
          }
        }
        return capped
      })
  }

  // One-paragraph project summary from project_overview (cached for a minute).
  async projectSummary(): Promise<string> {
    if (this.summaryCache && Date.now() - this.summaryCache.at < 60_000) return this.summaryCache.text
    let text = ''
    try {
      const t = gentreeTools(this.ctx, { readOnly: true, ...(this.deps.toolFs ? { fs: this.deps.toolFs } : {}) }).find((x) => x.name === 'project_overview')
      const r = t ? await runTool(t, {}) : null
      const raw = r && !r.isError ? r.content.map((c) => c.text).join('') : ''
      const o = raw ? (JSON.parse(raw) as Record<string, any>) : null
      if (o) {
        const scripts = Object.entries(o.scripts ?? {})
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')
        const git = typeof o.git === 'object' && o.git?.branch ? `git ${o.git.branch}${o.git.dirty ? `, ${o.git.dirty} dirty` : ''}` : ''
        text = [`Roblox project "${o.name}" (Rojo)`, scripts && `scripts: ${scripts}`, git].filter(Boolean).join('; ') + '.'
      }
    } catch {
      text = ''
    }
    this.summaryCache = { at: Date.now(), text }
    return text
  }

  async contextPack(room: Room, ask: string, recent = this.setting<number>('recentMessages')): Promise<string> {
    return buildContextPack({
      ask,
      projectSummary: await this.projectSummary(),
      transcript: room.messages,
      host: room.host,
      recent,
      maxChars: this.setting<number>('packChars'),
      messageChars: this.setting<number>('messageChars')
    })
  }

  // Runs one participant on a prompt; its messages stream into the room under its speaker.
  // Returns the participant's final text.
  // Image bytes for a participant: only when its model reads images.
  async imagesFor(p: GroupParticipant, images: ChatImage[] | undefined): Promise<ImagePayload[]> {
    if (!images?.length || !hasChatImageStore()) return []
    const meta = await this.deps.providers?.modelMeta(p.provider, p.model).catch(() => undefined)
    if (!supportsVision(p.provider, p.model, meta)) return []
    const out: ImagePayload[] = []
    for (const i of images) {
      const b = await chatImageStore()
        .base64(i.id)
        .catch(() => null)
      if (b) out.push(b)
    }
    return out
  }

  async speak(room: Room, p: GroupParticipant, prompt: string, opts: { system?: string; tools?: boolean; card?: ChatMessage['card']; images?: ChatImage[] } = {}): Promise<string> {
    const speaker = speakerOf(p)
    const tools = opts.tools ?? room.guestTools
    const rules = p.role === 'host' && !opts.system ? ((await this.deps.rules?.().catch(() => '')) ?? '') : ''
    const system = opts.system ?? (p.role === 'host' ? HOST_SYSTEM(speaker) + rules : GUEST_SYSTEM(speaker, room.host, tools))
    const texts = new Map<string, string>()
    const emit = (m: ChatMessage) => {
      if (m.role === 'assistant') texts.set(m.id, m.text)
      room.push({ ...m, agentId: 'main', speaker, ...(opts.card && m.role === 'assistant' ? { card: opts.card } : {}) })
    }
    const usage = (u: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null) => {
      if (u) room.recordUsage(speaker, { input: u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0), output: u.output })
    }
    const toolList = tools ? this.guestTools() : []
    const maxTokens = this.setting<number>('guestMaxTokens')
    const maxTurns = tools ? this.setting<number>('guestMaxTurns') : 1
    const images = await this.imagesFor(p, opts.images)

    if (p.provider === 'anthropic') {
      const auth = await this.deps.credentials.anthropicAuth()
      if (!auth.ready) {
        emit({ id: randomUUID(), role: 'system', text: `${p.label}: ${auth.error ?? 'Anthropic is not set up.'}`, at: Date.now(), agentId: 'main' })
        return ''
      }
      const abort = new AbortController()
      const onAbort = () => abort.abort()
      room.signal.addEventListener('abort', onAbort)
      const root = this.ctx.project()?.root ?? process.cwd()
      try {
        const queryFn = this.deps.queryFn ?? sdkQuery
        for await (const m of queryFn({
          prompt: images.length ? anthropicPrompt(prompt, images) : prompt,
          options: {
            cwd: root,
            model: p.model,
            systemPrompt: system,
            env: { ...(auth.env ?? {}), CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) },
            ...executableOption(),
            abortController: abort,
            mcpServers: toolList.length ? { [SERVER_NAME]: wrapInSdkServer(toolList) } : {},
            strictMcpConfig: true,
            // No built-in tools at all; only the read-only gentree subset above.
            tools: [],
            allowedTools: toolList.length ? allowServer(SERVER_NAME) : [],
            permissionMode: 'default',
            canUseTool: async () => ({ behavior: 'deny', message: 'guests are read-only' }),
            settingSources: [],
            maxTurns,
            persistSession: false
          }
        })) {
          for (const cm of toChatMessages(m, 'main')) emit(cm)
          if (m.type === 'result') usage(fromAnthropicUsage(m.usage as any))
        }
      } catch (e) {
        if (!room.signal.aborted) emit({ id: randomUUID(), role: 'system', text: `${p.label}: ${(e as Error).message}`, at: Date.now(), agentId: 'main' })
      } finally {
        room.signal.removeEventListener('abort', onAbort)
      }
      return [...texts.values()].join('\n\n').trim()
    }

    const ep = this.deps.providers ? await this.deps.providers.endpoint(p.provider) : { error: 'Providers are not available.' }
    if ('error' in ep) {
      emit({ id: randomUUID(), role: 'system', text: `${p.label}: ${ep.error}`, at: Date.now(), agentId: 'main' })
      return ''
    }
    const responses = usesResponsesApi(p.provider, p.model)
    const cap = responses ? { max_output_tokens: maxTokens } : outputCap(p.provider, maxTokens)
    const result = await (responses ? runResponsesLoop : runOpenAiLoop)({
      baseUrl: ep.baseUrl,
      headers: ep.headers,
      model: p.model,
      system,
      history: [{ role: 'user', content: chatCompletionsContent(prompt, images) }],
      tools: toolList,
      maxTurns,
      signal: room.signal,
      agentId: 'main',
      emit,
      extraBody: { ...extraBody(p.provider, p.model), ...cap },
      fetchFn: this.deps.fetchFn,
      onUsage: (raw) => usage(fromOpenAiUsage(raw))
    })
    if (result.outcome === 'error') this.ctx.log({ service: 'agent', stream: 'stderr', text: `group chat ${p.label}: ${result.error}` })
    return [...texts.values()].join('\n\n').trim()
  }

  // Ask mode (consult_model) and direct mode (@mention): one guest answers.
  async ask(room: Room, guest: GroupParticipant, message: string, mode: 'ask' | 'debate' | 'direct', from = room.host.label): Promise<string> {
    const pack = await this.contextPack(room, message)
    const prompt = `${pack}\n\n---\n${modeInstruction(mode, from, message)}`
    const text = await this.speak(room, guest, prompt, { images: room.images })
    if (mode === 'direct' && text) room.note(`${guest.label} (to the user): ${clip(text, 1200)}`)
    return text
  }

  // Roundtable: host then guests, `rounds` times, then the host's plan card. Returns the plan text.
  async roundtable(room: Room, topic: string, rounds = this.setting<number>('rounds')): Promise<string> {
    const n = Math.max(1, Math.min(DEFAULTS.maxRounds, Math.floor(rounds) || DEFAULTS.rounds))
    const people = [room.host, ...room.guests]
    if (people.length < 2) {
      room.push({ id: randomUUID(), role: 'system', text: 'Add at least one guest model for a roundtable.', at: Date.now(), agentId: 'main' })
      return ''
    }
    room.push({
      id: randomUUID(),
      role: 'system',
      text: `Roundtable: ${topic} · ${n} round${n > 1 ? 's' : ''} · ${people.map((p) => p.label).join(', ')}`,
      at: Date.now(),
      agentId: 'main'
    })
    const recent = Math.max(this.setting<number>('recentMessages'), people.length * 2)
    for (let round = 1; round <= n; round++) {
      for (const p of people) {
        if (room.signal.aborted) return ''
        const pack = await this.contextPack(room, topic, recent)
        const text = await this.speak(room, p, `${pack}\n\n---\n${modeInstruction('roundtable', '', topic, { round, rounds: n, topic })}`)
        if (text) room.note(`${p.label} (roundtable, round ${round}): ${clip(text, 600)}`)
      }
    }
    if (room.signal.aborted) return ''
    const pack = await this.contextPack(room, topic, people.length * n + 1)
    const plan = await this.speak(room, room.host, `${pack}\n\n---\n${modeInstruction('synthesis', '', topic, { topic })}`, { tools: false, card: 'plan' })
    if (plan) room.note(`Your roundtable plan (shown to the user as a plan card): ${clip(plan, 1500)}`)
    return plan
  }

  // Tools the host gets in a chat: consult_model and invite_model.
  hostTools(getRoom: () => Room | null): GentreeTool<any>[] {
    const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })
    const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })
    const find = async (room: Room, name: string) => {
      const r = await this.resolve(name, room)
      if (r.kind === 'none') return { error: `No ready model matches "${name}". Ready providers' models can be listed in the model picker; ask the user which model they mean.` }
      if (r.kind === 'ambiguous') return { error: `"${name}" is ambiguous: ${r.options.map((o) => `${o.provider}/${o.model}`).join(', ')}. Ask the user which one they mean.` }
      return { choice: r.choice }
    }
    return [
      defineTool(
        'consult_model',
        'Ask another AI model in this group chat for advice, a second opinion or a critique, and get its answer. `model` is an @alias of a participant ("sol", "gemini") or a name like "openai sol 6.1", "gemini pro", "opus", or provider/model. mode "ask" answers a question; "debate" makes it challenge your proposal and counter-propose. The model is read-only (it cannot edit files); its reply is also shown to the user. Call it again to continue the exchange.',
        { model: z.string().min(1), message: z.string().min(1), mode: z.enum(['ask', 'debate']).optional() },
        async (args) => {
          const room = getRoom()
          if (!room) return fail('group chat is not available here')
          const hit = await find(room, args.model)
          if ('error' in hit) return fail(hit.error!)
          const guest = this.ensureGuest(room, hit.choice!)
          if (guest === room.host) return fail('that is you; consult another model')
          const text = await this.ask(room, guest, args.message, args.mode ?? 'ask')
          if (room.signal.aborted) return fail('cancelled')
          if (!text) return fail(`${guest.label} gave no answer (see the chat for errors).`)
          return ok(`${guest.label} (@${guest.alias}) replied:\n${clip(text, DEFAULTS.replyChars)}`)
        }
      ),
      defineTool(
        'invite_model',
        'Add another AI model to this group chat as a read-only guest adviser, so the user and you can @mention it. `model` is a name like "openai sol 6.1", "gemini pro", "opus", or provider/model.',
        { model: z.string().min(1) },
        async (args) => {
          const room = getRoom()
          if (!room) return fail('group chat is not available here')
          const hit = await find(room, args.model)
          if ('error' in hit) return fail(hit.error!)
          const guest = this.ensureGuest(room, hit.choice!)
          return ok(`${guest.label} is in the chat as @${guest.alias}.`)
        }
      )
    ]
  }
}

// Output token cap per provider's Chat Completions dialect.
function outputCap(provider: ProviderId, max: number): Record<string, unknown> {
  // OpenAI deprecated max_tokens for max_completion_tokens (reasoning models reject max_tokens).
  if (provider === 'openai') return { max_completion_tokens: max }
  return { max_tokens: max }
}

