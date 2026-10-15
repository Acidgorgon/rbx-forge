// Browser-preview mock of the chat additions (see mock.ts): per-chat effort with a routed
// "auto → model · effort" summary, the chat image store (data URLs kept in memory), group chats
// created with guests up front, and a demo image in the seeded chat.
import type { ChatImage, ChatImageInput, ChatMessage, ChatSession, EffortChoice, HarnessApi, HarnessEvents, ModelChoice, NewChatOptions } from '@shared/types'
import { autoEffort, clampEffort, effortSupport, isEffortChoice, type EffortLevel } from '@shared/modelCaps'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

interface Deps {
  emit: Emit
  chats: ChatSession[]
  messages: Record<string, ChatMessage[]>
  addGuest: (sessionId: string, choice: ModelChoice) => Promise<ChatSession>
}

let seq = 0
const uid = () => `00000000-0000-4000-8000-${(Date.now() + seq++).toString(16).padStart(12, '0').slice(-12)}`

// A small generated image (a sword icon on a dotted grid) for the preview.
function demoImage(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#141414"/><g fill="#2a2a2a">${Array.from({ length: 160 }, (_, i) => `<circle cx="${(i % 20) * 32 + 16}" cy="${Math.floor(i / 20) * 50 + 25}" r="1.5"/>`).join('')}</g><g transform="rotate(-35 320 200)"><rect x="300" y="70" width="40" height="200" rx="4" fill="#c8ccd2"/><rect x="250" y="262" width="140" height="22" rx="6" fill="#d2753a"/><rect x="308" y="284" width="24" height="70" rx="4" fill="#7b4a2a"/></g><text x="24" y="376" font-family="monospace" font-size="18" fill="#8a8a8a">StarterSword · shop icon</text></svg>`
  return `data:image/svg+xml;base64,${btoa(svg)}`
}

export function chatExtrasMock(d: Deps) {
  const images = new Map<string, { ref: ChatImage; url: string }>()
  let defaultEffort: EffortChoice = 'auto'

  const route = (c: ChatSession, text: string) => {
    const explicit = c.effort && c.effort !== 'auto' ? c.effort : undefined
    const big = /refactor|architecture|think hard|every|across/i.test(text)
    const simple = !big && text.length < 120 && /^(what|where|which|how|show|list|explain)\b/i.test(text.trim())
    const tier: 'cheap' | 'big' | 'chosen' = explicit ? 'chosen' : big ? 'big' : simple ? 'cheap' : 'chosen'
    const tiers: Partial<Record<string, { cheap: string; big: string }>> = {
      anthropic: { cheap: 'claude-haiku-5-5', big: 'claude-opus-5-5' },
      openai: { cheap: 'gpt-6-luna', big: 'gpt-6-astra' },
      gemini: { cheap: 'gemini-3.5-flash-lite', big: 'gemini-3.1-pro-preview' }
    }
    const t = tiers[c.provider]
    const model = tier === 'chosen' || !t ? c.model : t[tier]
    const support = effortSupport(c.provider, model)
    const effort: EffortLevel | undefined = explicit ? clampEffort(explicit, support.levels) : autoEffort(tier, support)
    c.route = { model, tier, reason: explicit ? `effort set to ${explicit}` : tier === 'big' ? 'large task' : tier === 'cheap' ? 'short, simple question' : 'default model', ...(effort ? { effort } : {}) }
    d.emit('chat:updated', { ...c })
  }

  // Seed: the shop chat shows an attached screenshot and a routed turn.
  const seedId = uid()
  images.set(seedId, { ref: { id: seedId, mime: 'image/png', name: 'shop-icon', width: 640, height: 400 }, url: demoImage() })
  const shop = d.chats.find((c) => c.id === 'chat-3')
  if (shop) {
    shop.route = { model: 'claude-sonnet-5-5', tier: 'chosen', reason: 'default model', effort: 'medium' }
    shop.model = 'claude-sonnet-5-5'
    d.messages['chat-3'] = [
      { id: 'img-u1', role: 'user', text: 'The buy button looks off next to this icon. Can you match the icon colours?', at: Date.now() - 3600_000 * 5, agentId: 'main', images: [images.get(seedId)!.ref] },
      { id: 'img-a1', role: 'assistant', text: 'The icon uses a warm orange guard (#d2753a) on a near-black tile. I\'d tint `BuyButton` with the same orange at 85% and drop its gradient so the two read as one set.', at: Date.now() - 3600_000 * 5 + 60_000, agentId: 'main' }
    ]
  }

  const api: Pick<HarnessApi, 'setChatEffort' | 'getDefaultEffort' | 'setDefaultEffort' | 'addChatImage' | 'getChatImage'> = {
    async setChatEffort(sessionId, effort) {
      const c = d.chats.find((x) => x.id === sessionId)
      if (!c) throw new Error('unknown chat')
      if (!isEffortChoice(effort)) throw new Error('invalid effort')
      c.effort = effort === 'auto' ? undefined : effort
      d.emit('chat:updated', { ...c })
      return { ...c }
    },
    async getDefaultEffort() {
      return defaultEffort
    },
    async setDefaultEffort(effort) {
      if (isEffortChoice(effort)) defaultEffort = effort
    },
    async addChatImage(input: ChatImageInput) {
      const id = uid()
      const url = input.dataUrl ?? demoImage()
      const mime = (/^data:(image\/(?:png|jpeg|webp|gif))/.exec(url)?.[1] ?? 'image/png') as ChatImage['mime']
      const ref: ChatImage = { id, mime, name: input.name ?? (input.path ? input.path.split(/[\\/]/).pop() : 'image') }
      images.set(id, { ref, url })
      return ref
    },
    async getChatImage(id) {
      const hit = images.get(id)
      if (!hit) throw new Error('image not found')
      return hit.url
    }
  }

  return {
    api,
    refs: (ids: string[] | undefined) => (ids ?? []).map((id) => images.get(id)?.ref).filter((x): x is ChatImage => !!x),
    route,
    defaultEffort: () => defaultEffort,
    // newChat options: effort and guests up front.
    async applyOptions(c: ChatSession, options: NewChatOptions | undefined) {
      const effort = options?.effort ?? defaultEffort
      if (effort !== 'auto') c.effort = effort
      if (options?.title) c.title = options.title
      for (const g of options?.guests ?? []) await d.addGuest(c.id, g)
    }
  }
}
