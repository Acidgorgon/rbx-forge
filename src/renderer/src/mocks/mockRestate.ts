// Browser-preview mock of "Restate first" (main/agent/restate.ts): the setting, the shared
// heuristic deciding when to restate, canned restatements standing in for the cheap-tier model,
// chat cards and their confirmation. ?restate=always|never sets both scopes.
import type { ChatMessage, HarnessApi, HarnessEvents, RestateKind, RestateSettings, Restatement } from '@shared/types'
import { decideRestate, parseRestateCommand } from '@shared/restate/heuristic'
import { formatRestatement, isSubstantialEdit, sameRestatement, withRestatement } from '@shared/restate/prompt'
import { isRestateMode, normalizeRestatement, normalizeRestateSettings } from '@shared/restate/types'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

interface Deps {
  emit: Emit
  messages: Record<string, ChatMessage[]>
  // Runs the chat reply for a request (mock.ts streamReply).
  reply: (sessionId: string, text: string) => Promise<void>
  log: (text: string) => void
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
let seq = 0
const uid = () => `00000000-0000-4000-9000-${(Date.now() + seq++).toString(16).padStart(12, '0').slice(-12)}`

// Canned readings for the demo requests; anything else gets a generic one built from the text.
export function mockRestatement(kind: RestateKind, request: string): Restatement {
  const t = request.toLowerCase()
  if (kind === 'chat' && /daily|reward|streak/.test(t))
    return {
      goal: 'Players get a daily login reward that grows with their streak, claimed from a small popup, saved with their data.',
      problem: 'Day-2 retention is low; players have no reason to come back tomorrow.',
      assumptions: ['Rewards are coins only for now (no items)', 'The streak resets after 48 h without a claim', 'Reuse the existing DataService and Notify UI']
    }
  if (kind === 'vfx')
    return {
      goal: 'A purple slash that charges for a beat, releases as one wide arc with sparks and leaves a short-lived trail.',
      problem: 'The current sword hit reads weak: there is no wind-up and nothing lingers after the swing.',
      assumptions: ['About 0.8 s from charge to fade', 'Sparks follow the blade, not the target', 'Mobile-friendly particle counts']
    }
  if (kind === 'anim')
    return {
      goal: 'A heavy overhead punch: a slow wind-up with the arm cocked back, a fast drop and a settling recovery.',
      problem: 'The current punch has no weight; the hit lands without any anticipation.',
      assumptions: ['R15 rig, about 1.1 s long', 'Feet stay planted (no root motion)', 'Hold the impact pose for 2 to 3 frames']
    }
  if (kind === 'ability')
    return {
      goal: 'A charged palm blast: the caster braces, a purple orb grows in the palm, then a beam fires and knocks the caster back.',
      problem: 'Ultimates feel flat because animation, VFX and camera do not hit on the same beat.',
      assumptions: ['Camera shake and a short hit-stop on release', 'Reuse the library beam effect if it fits', 'About 1.5 s total']
    }
  const first = request.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0].slice(0, 160)
  return {
    goal: first.charAt(0).toUpperCase() + first.slice(1),
    problem: 'The current behaviour does not do this yet.',
    assumptions: ['Keep the existing project structure', 'Touch only the modules this needs']
  }
}

export function restateMock(d: Deps) {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('restate') : null
  let settings: RestateSettings = normalizeRestateSettings(isRestateMode(q) ? { chat: q, labs: q } : {})

  const push = (sessionId: string, m: ChatMessage) => {
    const list = (d.messages[sessionId] ??= [])
    const i = list.findIndex((x) => x.id === m.id)
    if (i >= 0) list[i] = m
    else list.push(m)
    d.emit('chat:message', { ...m, sessionId })
  }

  // sendChat: true when the message became a restatement card (no reply yet).
  const intercept = async (sessionId: string, raw: string): Promise<boolean> => {
    for (const m of d.messages[sessionId] ?? []) if (m.restate?.state === 'pending') push(sessionId, { ...m, restate: { ...m.restate, state: 'dismissed' } })
    const cmd = parseRestateCommand(raw)
    const decision = decideRestate(cmd.text, { mode: settings.chat, kind: 'chat', force: cmd.forced })
    if (!decision.restate) return false
    d.emit('chat:busy', { sessionId, busy: true })
    await delay(700)
    const draft = mockRestatement('chat', cmd.text)
    const user = [...(d.messages[sessionId] ?? [])].reverse().find((m) => m.role === 'user')
    push(sessionId, { id: uid(), role: 'assistant', text: formatRestatement(draft), at: Date.now(), agentId: 'main', sessionId, card: 'restate', restate: { request: cmd.text, draft, state: 'pending', reason: decision.reason, ...(user ? { userMessageId: user.id } : {}) } })
    d.emit('chat:busy', { sessionId, busy: false })
    return true
  }

  const confirm = (draft: Restatement, edited?: Restatement) => {
    const confirmed = normalizeRestatement(edited) ?? draft
    const changed = !sameRestatement(draft, confirmed)
    const substantial = changed && isSubstantialEdit(draft, confirmed)
    if (substantial) d.log('restate: correction noted in memory (restate-corrections)')
    return { confirmed, edited: changed, substantial, noted: substantial }
  }

  const api: Pick<HarnessApi, 'getRestateSettings' | 'setRestateSettings' | 'restateBrief' | 'restateConfirm' | 'confirmChatRestate'> = {
    async getRestateSettings() {
      return { ...settings }
    },
    async setRestateSettings(patch) {
      settings = normalizeRestateSettings({ ...settings, ...patch })
      return { ...settings }
    },
    async restateBrief(lab, brief, opts) {
      const decision = decideRestate(brief, { mode: settings.labs, kind: lab, force: opts?.force })
      if (!decision.restate) return { skipped: decision.reason }
      await delay(600)
      return { restatement: mockRestatement(lab, brief), reason: decision.reason }
    },
    async restateConfirm(input) {
      return confirm(input.draft, input.confirmed)
    },
    async confirmChatRestate(sessionId, messageId, edited) {
      const card = d.messages[sessionId]?.find((m) => m.id === messageId)
      if (!card?.restate || card.restate.state !== 'pending') throw new Error('no restatement waiting')
      const r = confirm(card.restate.draft, edited)
      push(sessionId, { ...card, text: formatRestatement(r.confirmed), restate: { ...card.restate, state: 'confirmed', confirmed: r.confirmed, ...(r.edited ? { edited: true } : {}), ...(r.substantial ? { substantial: true } : {}) } })
      void d.reply(sessionId, withRestatement(card.restate.request, r.confirmed, r.edited))
    }
  }
  return { api, intercept }
}
