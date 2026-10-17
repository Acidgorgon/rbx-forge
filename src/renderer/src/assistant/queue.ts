// Queued prompts (pure: no React, no DOM). While a turn runs, Enter puts the message in the chat's
// queue instead of being refused; when the turn ends the store sends the next one, one at a time
// and in order. A turn that ended with an error, was stopped, or left a question for the person
// (restate / plan card) pauses the queue until "Resume queue". "Send now" moves a prompt to the
// front and stops the running turn so it goes next. Queues live in renderer state only (an app
// restart drops them).

import type { ChatImage, ChatMessage } from '../../../shared/types.ts'
import { isBuiltin, parseSlash } from '../../../shared/chatCommands.ts'
import { SPEND_CAP_PREFIX } from '../../../shared/spend/types.ts'

export interface QueuedPrompt {
  id: string
  // As typed (editable): a message or a slash command line.
  text: string
  // Attached images, sent with it.
  images: ChatImage[]
  // Context chips taken when it was queued (current file, problems), appended to a message at send.
  context?: string
  at: number
}

// Why a queue waits for "Resume queue".
export type QueuePause = 'error' | 'stopped' | 'waiting'

export type TurnOutcome = 'done' | QueuePause

export const PAUSE_TEXT: Record<QueuePause, string> = {
  error: 'the last turn ended with an error',
  stopped: 'the last turn was stopped',
  waiting: 'the assistant is waiting for your answer'
}

// Built-in commands that start a turn or change the conversation wait in the queue. The other
// built-ins (help, cost, context, todos, model, effort, memory, resume, rewind, export, new, tests,
// lint, sync, agents) only read or open UI, so they run at once even mid-turn. Custom commands
// become messages: queued.
const QUEUED_COMMANDS = new Set(['clear', 'compact', 'ask', 'plan', 'init', 'review', 'restate', 'team', 'roundtable'])

// true: while busy this text goes to the queue; false: it runs now.
export function queueWhenBusy(text: string): boolean {
  const cmd = parseSlash(text)
  if (!cmd) return true
  return QUEUED_COMMANDS.has(cmd.name) || !isBuiltin(cmd.name)
}

// ---------------------------------------------------------------- list operations

export function enqueue(q: readonly QueuedPrompt[], item: QueuedPrompt): QueuedPrompt[] {
  return [...q, item]
}

export function editQueued(q: readonly QueuedPrompt[], id: string, text: string): QueuedPrompt[] {
  return q.map((x) => (x.id === id ? { ...x, text } : x))
}

export function removeQueued(q: readonly QueuedPrompt[], id: string): QueuedPrompt[] {
  return q.filter((x) => x.id !== id)
}

// "Send now": that prompt goes first, the rest keep their order.
export function moveToFront(q: readonly QueuedPrompt[], id: string): QueuedPrompt[] {
  const hit = q.find((x) => x.id === id)
  return hit ? [hit, ...q.filter((x) => x !== hit)] : q.slice()
}

// The text a queued prompt is sent as: a message gets its context chips; a command goes as typed.
export function outgoingText(item: QueuedPrompt): string {
  const t = item.text.trim()
  const cmd = t.startsWith('/') ? parseSlash(t) : null
  const takesContext = !cmd || cmd.name === 'restate'
  return takesContext && item.context ? `${t}\n\n${item.context}` : t
}

// ---------------------------------------------------------------- turn end

const ERROR_TEXT = /^(error\b|api error|auth:|could not\b|team run failed|cross-check fix not started|rate limited|billing error|model not found|open a project first|your account can't use|claude sign-in failed)/i

function errorNotice(m: ChatMessage): boolean {
  if (m.role !== 'system' || m.command || m.compact) return false
  const t = m.text.trim()
  // A hard budget stop says how to go on; the soft-cap note ("Budget: chat is at ...") is not one.
  return ERROR_TEXT.test(t) || t.includes(SPEND_CAP_PREFIX) || (/^Budget: /.test(t) && /Raise the limit/.test(t)) || !!m.settingsLink
}

// How the turn that just ended went, from the messages after the newest user message.
export function turnOutcome(messages: readonly ChatMessage[]): TurnOutcome {
  let from = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && messages[i].agentId === 'main') {
      from = i + 1
      break
    }
  }
  const turn = messages.slice(from)
  if (turn.some((m) => m.role === 'system' && !m.command && /^Stopped\.?$/.test(m.text.trim()))) return 'stopped'
  if (turn.some(errorNotice)) return 'error'
  if (turn.some((m) => m.restate?.state === 'pending' || m.planMode?.state === 'pending')) return 'waiting'
  return 'done'
}

// What the store does when a chat's turn ends: send the next prompt, or pause.
// stopRequested: Stop was pressed on that turn. sendNow: it was stopped by "Send now" (the chosen
// prompt is at the front and goes next). paused: the queue was already paused.
export function afterTurn(o: { queued: number; outcome: TurnOutcome; stopRequested?: boolean; sendNow?: boolean; paused?: QueuePause | null }): { send: boolean; pause?: QueuePause } {
  if (o.queued <= 0) return { send: false }
  if (o.sendNow) return { send: true }
  if (o.paused) return { send: false, pause: o.paused }
  if (o.stopRequested) return { send: false, pause: 'stopped' }
  if (o.outcome !== 'done') return { send: false, pause: o.outcome }
  return { send: true }
}
