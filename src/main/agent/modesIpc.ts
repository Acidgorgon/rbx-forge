// IPC handlers for chat modes and slash commands (ChatModesApi), registered by registerAgentIpc.

import type { ChatManager } from './chat.ts'
import { isChatMode, type RewindWhat } from '../../shared/chatModes.ts'
import type { MemoryHooks } from './memory/hooks.ts'

export function chatModeHandlers(chats: ChatManager): Record<string, (...args: any[]) => unknown> {
  const id = (v: unknown) => String(v ?? '')
  return {
    setChatMode: (sessionId: unknown, mode: unknown) => {
      if (!isChatMode(mode)) throw new Error(`invalid mode ${String(mode)}`)
      return chats.setMode(id(sessionId), mode)
    },
    sendChatMode: (sessionId: unknown, text: unknown, mode: unknown, images?: unknown) => {
      if (!isChatMode(mode)) throw new Error(`invalid mode ${String(mode)}`)
      return chats.send(id(sessionId), String(text ?? ''), Array.isArray(images) ? images.filter((x): x is string => typeof x === 'string') : [], { mode })
    },
    reviewChatEdit: (sessionId: unknown, messageId: unknown, d: unknown) => {
      const v = (d && typeof d === 'object' ? d : {}) as { accept?: unknown; hunks?: unknown; note?: unknown }
      return chats.reviewEdit(id(sessionId), id(messageId), {
        accept: v.accept === true,
        ...(Array.isArray(v.hunks) ? { hunks: v.hunks.filter((h): h is number => typeof h === 'number') } : {}),
        ...(typeof v.note === 'string' && v.note.trim() ? { note: v.note.trim().slice(0, 500) } : {})
      })
    },
    planCardAction: (sessionId: unknown, messageId: unknown, action: unknown, opts?: { runMode?: unknown; text?: unknown }) => {
      if (action !== 'approve' && action !== 'keep' && action !== 'edit') throw new Error(`invalid action ${String(action)}`)
      return chats.planAction(id(sessionId), id(messageId), action, {
        ...(opts?.runMode === 'auto' || opts?.runMode === 'edit' ? { runMode: opts.runMode } : {}),
        ...(typeof opts?.text === 'string' ? { text: opts.text } : {})
      })
    },
    listChatCommands: () => chats.commands(),
    runChatCommand: (sessionId: unknown, name: unknown, args?: unknown) => chats.command(id(sessionId), String(name ?? ''), String(args ?? '')),
    listChatCheckpoints: (sessionId: unknown) => chats.checkpointsOf(id(sessionId)),
    rewindChat: (sessionId: unknown, checkpointId: unknown, what?: unknown) =>
      chats.rewind(id(sessionId), id(checkpointId), (what === 'files' || what === 'chat' ? what : 'both') as RewindWhat)
  }
}

// /memory <note>: a project memory note through the memory service.
export function memoryNote(memory: MemoryHooks | undefined): ((note: string) => Promise<unknown>) | undefined {
  if (!memory?.remember) return undefined
  return (note) => {
    const name = `note-${note.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || Date.now()}`
    return memory.remember!({ scope: 'project', kind: 'memory', type: 'project', name, description: note.slice(0, 120), body: note }, 'user')
  }
}
