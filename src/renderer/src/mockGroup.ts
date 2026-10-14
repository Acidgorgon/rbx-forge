// Browser-preview mock of the group chat (see mock.ts): a seeded Claude + Sol + Gemini exchange
// ending in a plan card, and canned replies for @mentions, "talk to X", roundtables and
// "Make this a task list".
import type { ChatMessage, ChatSession, GroupParticipant, GroupUsage, HarnessApi, HarnessEvents, ModelChoice, ProviderId, Speaker } from '@shared/types'
import { consultPhrase, makeParticipant, parseMentions, resolveModel, sameModel } from '@shared/modelResolve'
import { groupV2Mock, seedConsultChat } from './mockGroupV2'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

interface Deps {
  emit: Emit
  chats: ChatSession[]
  messages: Record<string, ChatMessage[]>
  // Every model the preview knows (ready or not).
  models: () => Promise<ModelChoice[]>
  // Models of ready providers (group chat v2: "not set up" notices).
  readyModels?: () => Promise<ModelChoice[]>
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
let seq = 0
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`

const speaker = (p: Pick<GroupParticipant, 'provider' | 'model' | 'label'>): Speaker => ({ provider: p.provider, model: p.model, label: p.label })

const SOL = makeParticipant({ provider: 'openai', model: 'gpt-6.1-sol' }, 'guest', ['opus'])
const GEMINI = makeParticipant({ provider: 'gemini', model: 'gemini-3.1-pro-preview' }, 'guest', ['opus', 'sol'])
const HOST = makeParticipant({ provider: 'anthropic', model: 'claude-opus-5-5' }, 'host')

const DEMO_PLAN = `## Agreements
- The exploit is a **race**: \`ShopService:Purchase\` yields on the DataStore save before it deducts coins, so 20 quick clicks all pass the balance check.
- Deduct first, save after, and keep the server as the only source of truth for prices.

## Disagreements
- **Sol** wants a per-player purchase lock; **Gemini** prefers a 0.5 s client debounce plus a server rate limit. Claude sides with Sol: a debounce alone does not stop a modified client.

## Recommendation
1. Add a per-player \`purchasing\` lock in \`src/server/Features/Shop/ShopService.luau\` and release it in a \`finally\`-style janitor task
2. Move the coin deduction above the \`PlayerData.save\` call
3. Read prices from \`src/shared/Features/Shop/Prices.luau\` on the server, ignore the client's price
4. Debounce the buy button in \`ShopController\` (UX only)
5. Re-run the "spam the buy button" test agent`

export function seedGroupChat(d: Deps): void {
  const now = Date.now()
  const at = (min: number) => now - 3600_000 * 2 + min * 60_000
  const chat: ChatSession = {
    id: 'chat-group',
    title: 'Shop exploit: plan with Sol + Gemini',
    createdAt: at(0),
    provider: HOST.provider,
    model: HOST.model,
    guests: [SOL, GEMINI],
    usage: [
      { provider: HOST.provider, model: HOST.model, label: HOST.label, input: 18_420, output: 1_210, calls: 4 },
      { provider: SOL.provider, model: SOL.model, label: SOL.label, input: 6_130, output: 940, calls: 2 },
      { provider: GEMINI.provider, model: GEMINI.model, label: GEMINI.label, input: 4_310, output: 610, calls: 2 }
    ]
  }
  const h = speaker(HOST)
  const s = speaker(SOL)
  const g = speaker(GEMINI)
  const m = (role: ChatMessage['role'], text: string, min: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: uid('g'), role, text, at: at(min), agentId: 'main', sessionId: chat.id, ...extra })
  d.messages[chat.id] = [
    m('user', 'Communicate with openai sol 6.1 and come up with a plan for the shop exploit. Players get free swords by spamming the buy button.', 0),
    m('system', 'GPT-6.1 Sol joined the chat as a guest (@sol).', 0),
    m('tool', '', 1, { tool: { name: 'read_script', input: 'path=src/server/Features/Shop/ShopService.luau' }, speaker: h }),
    m('tool', '', 1, { tool: { name: 'consult_model', input: 'model=sol mode=debate message=Purchase yields on save before deducting…' }, speaker: h }),
    m(
      'assistant',
      "Agree it's a race, but a debounce won't hold: an exploiter fires `ShopPurchase` directly. Two changes I'd insist on:\n\n- a per-player `purchasing` lock on the server, checked **before** any yield\n- deduct coins first, then save; on save failure, refund\n\nAlso: the client sends `price` in the event payload. Ignore it and read `Prices.luau` server-side.",
      2,
      { speaker: s }
    ),
    m('assistant', "Sol and I agree on the race and the fix order. I'll hold off on edits until you've seen the plan. Want a third opinion on the client side?", 3, { speaker: h }),
    m('user', '@gemini can you sanity-check this from the client side?', 5),
    m('system', 'Gemini 3.1 Pro joined the chat as a guest (@gemini).', 5),
    m(
      'assistant',
      'Client side looks fine once the server lock lands. I would still debounce the button in `ShopController` for UX (0.5 s) and show a pending state, so honest players don\'t double-click into an error toast. Rate-limit `ShopPurchase` to ~4/s per player as a backstop.',
      6,
      { speaker: g }
    ),
    m('user', 'Roundtable: Fix the shop purchase exploit', 8),
    m('system', 'Roundtable: Fix the shop purchase exploit · 1 round · Claude Opus 5.5, GPT-6.1 Sol, Gemini 3.1 Pro', 8),
    m('assistant', 'Lock + deduct-first in `ShopService`, prices from `Prices.luau`. Debounce is nice-to-have.', 9, { speaker: h }),
    m('assistant', "Same. The lock must be released on every path, including errors, or a failed save bricks the player's shop.", 9, { speaker: s }),
    m('assistant', 'Agree on the server fix. I still want the rate limit: locks stop the race, not spam.', 10, { speaker: g }),
    m('assistant', DEMO_PLAN, 11, { speaker: h, card: 'plan' })
  ]
  d.chats.unshift(chat)
  seedConsultChat(d)
}

export function groupMock(d: Deps) {
  const chat = (id: string) => {
    const c = d.chats.find((x) => x.id === id)
    if (!c) throw new Error(`unknown chat ${id}`)
    return c
  }
  const host = (c: ChatSession) => makeParticipant({ provider: c.provider, model: c.model }, 'host')
  const updated = (c: ChatSession) => d.emit('chat:updated', { ...c })
  const push = (id: string, msg: ChatMessage) => {
    const list = (d.messages[id] ??= [])
    const i = list.findIndex((x) => x.id === msg.id)
    if (i >= 0) list[i] = msg
    else list.push(msg)
    d.emit('chat:message', msg)
  }
  const sys = (id: string, text: string) => push(id, { id: uid('s'), role: 'system', text, at: Date.now(), agentId: 'main', sessionId: id })
  const invite = (c: ChatSession, choice: ModelChoice): GroupParticipant => {
    const h = host(c)
    if (sameModel(choice, h)) return h
    const found = c.guests?.find((x) => sameModel(x, choice))
    if (found) return found
    const p = makeParticipant(choice, 'guest', [h.alias, ...(c.guests ?? []).map((x) => x.alias)])
    c.guests = [...(c.guests ?? []), p]
    updated(c)
    sys(c.id, `${p.label} joined the chat as a guest (@${p.alias}).`)
    return p
  }
  const use = (c: ChatSession, p: Speaker, input: number, output: number) => {
    const list: GroupUsage[] = (c.usage ??= [])
    let row = list.find((u) => u.provider === p.provider && u.model === p.model)
    if (!row) list.push((row = { provider: p.provider as ProviderId, model: p.model, label: p.label, input: 0, output: 0, calls: 0 }))
    row.input += input
    row.output += output
    row.calls++
    updated(c)
  }
  // Streams text word by word under one id, as the real loops do.
  const say = async (c: ChatSession, p: Speaker, text: string, card?: ChatMessage['card']) => {
    const id = uid('a')
    const words = text.split(/(?<=\s)/)
    let acc = ''
    for (let i = 0; i < words.length; i++) {
      acc += words[i]
      if (i % 4 === 0 || i === words.length - 1) {
        push(c.id, { id, role: 'assistant', text: acc, at: Date.now(), agentId: 'main', sessionId: c.id, speaker: p, ...(card ? { card } : {}) })
        await delay(22)
      }
    }
    use(c, p, 900 + text.length, Math.round(text.length / 4))
  }
  const reply = (p: Speaker, about: string) =>
    `**${p.label}** here. On "${about.slice(0, 60)}": I'd keep the server authoritative, change one thing at a time, and add a test agent run for the edge case before shipping.`
  const busy = (id: string, on: boolean) => d.emit('chat:busy', { sessionId: id, busy: on })
  const v2 = groupV2Mock({ chat, host, invite, push, sys, say, busy, updated, messages: d.messages, models: d.models, ready: d.readyModels ?? d.models })

  // Returns true when the message was a group-chat message (handled here).
  async function handleSend(id: string, text: string): Promise<boolean> {
    const c = chat(id)
    const all = await d.models()
    const room = [host(c), ...(c.guests ?? [])]
    const mentions = parseMentions(text)
    const guests: GroupParticipant[] = []
    for (const name of mentions) {
      const r = resolveModel(name, room)
      const hit = r.kind === 'ok' ? r : resolveModel(name, all)
      if (hit.kind === 'ambiguous') {
        sys(id, `Which model did you mean by “@${name}”? ${hit.options.map((o) => `${o.provider}/${o.model}`).join(', ')}.`)
        return true
      }
      if (hit.kind === 'ok') {
        const p = invite(c, hit.choice)
        if (p.role === 'guest') guests.push(p)
      }
    }
    if (guests.length) {
      busy(id, true)
      for (const g of guests) {
        await delay(500)
        await say(c, speaker(g), reply(g, text.replace(/@\S+\s*/g, '')))
      }
      busy(id, false)
      return true
    }
    if (await v2.handle(id, text)) return true
    const phrase = consultPhrase(text)
    const r = phrase ? resolveModel(phrase, all) : null
    if (!r || r.kind === 'none') return false
    if (r.kind === 'ambiguous') {
      sys(id, `Which model did you mean by “${phrase}”? ${r.options.map((o) => `${o.provider}/${o.model}`).join(', ')}.`)
      return true
    }
    const g = invite(c, r.choice)
    if (g.role === 'host') return false
    busy(id, true)
    const h = speaker(host(c))
    await delay(400)
    push(id, { id: uid('t'), role: 'tool', text: '', tool: { name: 'consult_model', input: `model=${g.alias} mode=debate` }, at: Date.now(), agentId: 'main', sessionId: id, speaker: h })
    await delay(600)
    await say(c, speaker(g), reply(g, text))
    await say(c, h, `I talked it through with ${g.label}. We agree on keeping the server authoritative; I'll start with the smallest change and check in before touching more files.`)
    busy(id, false)
    return true
  }

  const api: Pick<HarnessApi, 'addGuest' | 'removeGuest' | 'setGuestTools' | 'startRoundtable' | 'planToChecklist' | keyof typeof v2.api> = {
    ...v2.api,
    async addGuest(id, choice) {
      const c = chat(id)
      invite(c, choice)
      return { ...c }
    },
    async removeGuest(id, alias) {
      const c = chat(id)
      c.guests = (c.guests ?? []).filter((g) => g.alias !== alias && `${g.provider}/${g.model}` !== alias)
      updated(c)
      return { ...c }
    },
    async setGuestTools(id, on) {
      const c = chat(id)
      c.guestTools = on ? undefined : false
      updated(c)
      return { ...c }
    },
    async startRoundtable(id, topic, rounds = 2) {
      const c = chat(id)
      const people = [host(c), ...(c.guests ?? [])]
      push(id, { id: uid('u'), role: 'user', text: `Roundtable: ${topic}`, at: Date.now(), agentId: 'main', sessionId: id })
      busy(id, true)
      void (async () => {
        sys(id, `Roundtable: ${topic} · ${rounds} round${rounds > 1 ? 's' : ''} · ${people.map((p) => p.label).join(', ')}`)
        for (let r = 1; r <= rounds; r++) {
          for (const p of people) {
            await delay(350)
            await say(c, speaker(p), r === rounds ? `Final position: ${reply(p, topic)}` : reply(p, topic))
          }
        }
        await delay(400)
        const plan = `## Agreements\n- Keep the server authoritative for "${topic}".\n\n## Disagreements\n- How much to do client-side.\n\n## Recommendation\n1. Make the smallest server change first\n2. Add a test agent scenario for the edge case\n3. Polish the client afterwards`
        await say(c, speaker(people[0]), plan, 'plan')
        busy(id, false)
      })()
    },
    async planToChecklist(id, messageId) {
      const plan = d.messages[id]?.find((x) => x.id === messageId)
      if (!plan) return
      const rec = plan.text.split(/\n(?=#+\s)/).find((sec) => /^#+\s*recommendation/i.test(sec)) ?? plan.text
      const items = rec
        .split('\n')
        .map((l) => /^\s*(?:[-*]|\d+[.)])\s+(.+)$/.exec(l)?.[1])
        .filter((x): x is string => !!x)
      push(id, { id: uid('c'), role: 'assistant', text: items.map((t) => `- [ ] ${t.replace(/\*\*/g, '')}`).join('\n'), at: Date.now(), agentId: 'main', sessionId: id, card: 'checklist', speaker: plan.speaker })
    }
  }
  return { api, handleSend }
}
