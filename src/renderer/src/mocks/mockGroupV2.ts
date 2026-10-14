// Browser-preview mock of group chat v2 (see mockGroup.ts): a seeded consult chat (Opus ↔ Sol)
// ending in a Conclusion card, a patch proposal and a cross-check review, a filled Board, and a
// canned converging consult for "ask <model> ... and report back" / "check with X".
import type { BoardItem, ChatMessage, ChatSession, ConclusionData, GroupParticipant, GroupSettings, HarnessApi, ModelChoice, Speaker } from '@shared/types'
import { GROUP_SETTINGS_DEFAULTS } from '@shared/group/types'
import { makeParticipant, resolveConsultModel, unconfiguredText } from '@shared/modelResolve'
import { conclusionMarkdown, looksLikeModel, parseConsultTrigger } from '@shared/group/consult'
import { boardFromConclusion, normalizeBoard } from '@shared/group/board'
import { mergeGroupSettings, normalizeGroupSettings } from '@shared/group/settings'

export interface V2Helpers {
  chat(id: string): ChatSession
  host(c: ChatSession): GroupParticipant
  invite(c: ChatSession, choice: ModelChoice): GroupParticipant
  push(id: string, m: ChatMessage): void
  sys(id: string, text: string): void
  say(c: ChatSession, p: Speaker, text: string, card?: ChatMessage['card']): Promise<void>
  busy(id: string, on: boolean): void
  updated(c: ChatSession): void
  messages: Record<string, ChatMessage[]>
  models(): Promise<ModelChoice[]>
  ready(): Promise<ModelChoice[]>
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
let seq = 0
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`
const speaker = (p: Pick<GroupParticipant, 'provider' | 'model' | 'label'>): Speaker => ({ provider: p.provider, model: p.model, label: p.label })

const HOST = makeParticipant({ provider: 'anthropic', model: 'claude-opus-5-5' }, 'host')
const SOL = makeParticipant({ provider: 'openai', model: 'gpt-6.1-sol' }, 'guest', ['opus'])
const GEMINI = makeParticipant({ provider: 'gemini', model: 'gemini-3.1-pro-preview' }, 'guest', ['opus', 'sol'])

const DIFF = `--- a/src/server/Features/Shop/ShopService.luau
+++ b/src/server/Features/Shop/ShopService.luau
@@ -18,9 +18,15 @@ function ShopService:Purchase(player: Player, itemId: string)
-\tlocal price = payload.price
+\tif self._purchasing[player] then
+\t\treturn false, "busy"
+\tend
+\tself._purchasing[player] = true
+\tlocal price = Prices[itemId]
 \tlocal data = PlayerData.get(player)
 \tif data.coins < price then
+\t\tself._purchasing[player] = nil
 \t\treturn false, "poor"
 \tend
-\tPlayerData.save(player)
 \tdata.coins -= price
+\tlocal ok = PlayerData.save(player)
+\tself._purchasing[player] = nil
+\treturn ok
 end`

function demoConclusion(): ConclusionData {
  return {
    question: 'Ask gpt 6.1 sol how to stop the shop double-purchase, come up with a conclusion and report back',
    answer: 'It is a race in `ShopService:Purchase`: the save yields before coins are deducted. Add a per-player `_purchasing` lock taken **before** any yield, deduct first, then save, and read prices from `Prices.luau` on the server.',
    agreed: [
      { text: 'The exploit is a yield-before-deduct race, not a client bug' },
      { text: 'Server reads the price from `Prices.luau`; ignore `payload.price`' },
      { text: 'The lock must be released on every path, including the "poor" early return' }
    ],
    disagreed: [{ text: 'Refund on save failure: **GPT-6.1 Sol** wants an immediate refund; **Claude Opus 5.5** prefers retrying the save once first', by: ['GPT-6.1 Sol', 'Claude Opus 5.5'] }],
    confidence: 'high',
    confidenceWhy: 'both read ShopService.luau and found the same yield at line 23',
    checks: [
      { label: 'Claude Opus 5.5', checked: ['read_script src/server/Features/Shop/ShopService.luau', 'find_symbol PlayerData.save', 'git_diff'] },
      { label: 'GPT-6.1 Sol', checked: ['search_code payload.price', 'read_script src/server/Features/Shop/ShopService.luau', 'read_diagnostics'] }
    ],
    participants: [speaker(HOST), speaker(SOL)].map((s) => ({ label: s.label, provider: s.provider, model: s.model })),
    turns: 2,
    maxTurns: 3,
    ended: 'agreed',
    tokens: 18_640,
    costUsd: 0.21
  }
}

export function seedConsultChat(d: { chats: ChatSession[]; messages: Record<string, ChatMessage[]> }): void {
  const now = Date.now()
  const at = (min: number) => now - 3600_000 + min * 60_000
  const c = demoConclusion()
  const chat: ChatSession = {
    id: 'chat-consult',
    title: 'Shop race: consult with Sol',
    createdAt: at(0),
    provider: HOST.provider,
    model: HOST.model,
    guests: [SOL, GEMINI],
    usage: [
      { provider: HOST.provider, model: HOST.model, label: HOST.label, input: 21_300, output: 2_140, calls: 5, costUsd: 0.16 },
      { provider: SOL.provider, model: SOL.model, label: SOL.label, input: 8_420, output: 1_310, calls: 3, costUsd: 0.07 },
      { provider: GEMINI.provider, model: GEMINI.model, label: GEMINI.label, input: 5_100, output: 380, calls: 1, costUsd: 0.01 }
    ]
  }
  const h = speaker(HOST)
  const s = speaker(SOL)
  const g = speaker(GEMINI)
  const m = (role: ChatMessage['role'], text: string, min: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: uid('v'), role, text, at: at(min), agentId: 'main', sessionId: chat.id, ...extra })
  const card = m('assistant', conclusionMarkdown(c), 9, { speaker: h, card: 'conclusion', conclusion: c })
  d.messages[chat.id] = [
    m('user', c.question, 0),
    m('system', 'GPT-6.1 Sol joined the chat as a guest (@sol).', 0),
    m('system', 'Consult: Claude Opus 5.5 ↔ GPT-6.1 Sol · up to 3 exchanges · cap 120k tokens / $0.75', 0),
    m('tool', '', 1, { tool: { name: 'search_code', input: 'query=payload.price' }, speaker: s }),
    m('tool', '', 1, { tool: { name: 'read_script', input: 'path=src/server/Features/Shop/ShopService.luau from=1 to=60' }, speaker: s }),
    m('assistant', "It's a race: `Purchase` calls `PlayerData.save` (yields) before `data.coins -= price`, so 20 fast clicks all pass the balance check. Fix: a per-player lock before any yield, deduct before saving, and stop trusting `payload.price`. Patch below.", 2, { speaker: s }),
    m('assistant', 'GPT-6.1 Sol proposed a patch to 1 file: src/server/Features/Shop/ShopService.luau', 2, {
      speaker: s,
      card: 'patch',
      patch: { diff: DIFF + '\n', files: [{ path: 'src/server/Features/Shop/ShopService.luau', added: 10, removed: 2 }], by: { label: s.label, provider: s.provider, model: s.model }, state: 'proposed' }
    }),
    m('tool', '', 3, { tool: { name: 'read_script', input: 'path=src/server/Features/Shop/ShopService.luau' }, speaker: h }),
    m('assistant', "Sol, agreed on the race and the lock. One gap: your patch doesn't release the lock if `PlayerData.save` errors. I'd also retry the save once before refunding.\n\nSTANCE: partial", 4, { speaker: h }),
    m('assistant', 'Fair on the error path: wrap the save in `pcall` and always clear `_purchasing`. I still prefer refunding immediately; a retry doubles the window for a second exploit.\n\nSTANCE: agree', 6, { speaker: s }),
    m('assistant', 'Agreed on everything except refund timing; noting that as open.\n\nSTANCE: agree', 8, { speaker: h }),
    card,
    m('user', 'Go ahead with the conclusion above.', 12),
    m('tool', '', 13, { tool: { name: 'edit_script', input: 'path=src/server/Features/Shop/ShopService.luau' }, speaker: h }),
    m('tool', '', 13, { tool: { name: 'edit_script', input: 'path=src/client/Controllers/ShopController.luau' }, speaker: h }),
    m('assistant', 'Done: lock + deduct-first in `ShopService`, prices from `Prices.luau`, and the buy button shows a pending state.', 14, { speaker: h }),
    m('assistant', 'Cross-check by Gemini 3.1 Pro: 1 blocking finding', 15, {
      speaker: g,
      card: 'review',
      review: {
        reviewer: { label: g.label, provider: g.provider, model: g.model },
        files: ['src/server/Features/Shop/ShopService.luau', 'src/client/Controllers/ShopController.luau'],
        verdict: 'changes',
        findings: [
          { severity: 'blocking', file: 'src/server/Features/Shop/ShopService.luau', line: 31, text: '`_purchasing[player]` is never cleared on `PlayerRemoving`, so the table leaks one entry per player' },
          { severity: 'note', file: 'src/client/Controllers/ShopController.luau', line: 12, text: 'the pending state never resets if the remote errors' }
        ],
        state: 'addressed'
      }
    }),
    m('assistant', 'Fixed: `PlayerRemoving` now clears `_purchasing`, and the controller resets the pending state on error.', 17, { speaker: h })
  ]
  let board: BoardItem[] = boardFromConclusion([], card.id, c, at(9))
  board = [...board, { id: 'u-q2', kind: 'question', text: 'Rate-limit `ShopPurchase` to 4/s as a backstop?', at: at(10), edited: true }]
  chat.board = board
  d.chats.unshift(chat)
}

export function groupV2Mock(h: V2Helpers) {
  let settings: GroupSettings = { ...GROUP_SETTINGS_DEFAULTS }

  const setCard = (id: string, messageId: string, patch: (m: ChatMessage) => ChatMessage) => {
    const m = h.messages[id]?.find((x) => x.id === messageId)
    if (m) h.push(id, patch(m))
  }

  // "ask <model> ... report back": a canned two-exchange consult and a Conclusion card. Returns
  // true when handled.
  async function handle(id: string, text: string): Promise<boolean> {
    const t = parseConsultTrigger(text)
    if (!t?.converge) return false
    const c = h.chat(id)
    const inRoom = resolveConsultModel(t.phrase, [h.host(c), ...(c.guests ?? [])])
    const r = inRoom.kind === 'ok' ? inRoom : resolveConsultModel(t.phrase, await h.ready(), await h.models())
    if (r.kind === 'none' && looksLikeModel(t.phrase)) {
      h.push(id, { id: uid('s'), role: 'system', text: `No model called “${t.phrase}” is set up. Add providers in Settings → Providers.`, at: Date.now(), agentId: 'main', sessionId: id, settingsLink: 'openai' })
      h.busy(id, false)
      return true
    }
    if (r.kind === 'unconfigured') {
      h.push(id, { id: uid('s'), role: 'system', text: unconfiguredText(r.choice), at: Date.now(), agentId: 'main', sessionId: id, settingsLink: r.choice.provider })
      h.busy(id, false)
      return true
    }
    if (r.kind !== 'ok') return false
    const g = h.invite(c, r.choice)
    if (g.role === 'host') return false
    const host = h.host(c)
    h.busy(id, true)
    h.sys(id, `Consult: ${host.label} ↔ ${g.label} · up to ${settings.consultTurns} exchanges · cap ${Math.round(settings.consultMaxTokens / 1000)}k tokens / $${settings.consultMaxUsd.toFixed(2)}`)
    await delay(300)
    h.push(id, { id: uid('t'), role: 'tool', text: '', tool: { name: 'search_code', input: 'query=Purchase' }, at: Date.now(), agentId: 'main', sessionId: id, speaker: speaker(g) })
    await h.say(c, speaker(g), `My take: keep the server authoritative and fix the smallest thing first. I checked \`ShopService.luau\`; the yield before the deduct is the bug.`)
    await h.say(c, speaker(host), `${g.label}, agreed on the cause. I'd also release the lock on the early return.\n\nSTANCE: partial`)
    await h.say(c, speaker(g), 'Good catch, agreed.\n\nSTANCE: agree')
    await h.say(c, speaker(host), 'Then we agree.\n\nSTANCE: agree')
    const conclusion: ConclusionData = {
      ...demoConclusion(),
      question: text,
      participants: [speaker(host), speaker(g)].map((s) => ({ label: s.label, provider: s.provider, model: s.model })),
      checks: [
        { label: host.label, checked: ['read_script src/server/Features/Shop/ShopService.luau'] },
        { label: g.label, checked: ['search_code Purchase'] }
      ],
      disagreed: [],
      tokens: 9_870,
      costUsd: 0.09
    }
    const card: ChatMessage = { id: uid('c'), role: 'assistant', text: conclusionMarkdown(conclusion), at: Date.now(), agentId: 'main', sessionId: id, speaker: speaker(host), card: 'conclusion', conclusion }
    h.push(id, card)
    c.board = boardFromConclusion(c.board ?? [], card.id, conclusion)
    h.updated(c)
    h.busy(id, false)
    return true
  }

  const api: Pick<HarnessApi, 'getGroupSettings' | 'setGroupSettings' | 'applyPatchProposal' | 'mergePatchProposal' | 'dismissPatchProposal' | 'saveBoard'> = {
    async getGroupSettings() {
      return settings
    },
    async setGroupSettings(next) {
      settings = normalizeGroupSettings(mergeGroupSettings(settings, next))
      return settings
    },
    async applyPatchProposal(id, messageId) {
      setCard(id, messageId, (m) => ({ ...m, patch: { ...m.patch!, state: 'applied', detail: `applied by ${h.host(h.chat(id)).label}: ${m.patch!.files.map((f) => f.path).join(', ')}` } }))
    },
    async mergePatchProposal(id, messageId) {
      setCard(id, messageId, (m) => ({ ...m, patch: { ...m.patch!, state: 'merging' } }))
    },
    async dismissPatchProposal(id, messageId) {
      setCard(id, messageId, (m) => ({ ...m, patch: { ...m.patch!, state: 'dismissed' } }))
    },
    async saveBoard(id, items) {
      const c = h.chat(id)
      c.board = normalizeBoard(items)
      h.updated(c)
      return c.board
    }
  }
  return { api, handle }
}
