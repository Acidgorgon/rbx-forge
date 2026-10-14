// Chat mode pill (Ask / Plan / Edit with approval / Auto-accept edits) for the composer, the mode
// state of the active chat (persisted in main per chat; a pending choice before the chat exists),
// and the small mode badge shown on messages.
import { useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { CHAT_MODES, DEFAULT_CHAT_MODE, modeLabel, nextChatMode, type ChatMode } from '@shared/chatModes'
import { useStore } from '../../store'
import { useMenu } from '../../components/Menu'
import { errorText } from '../../lib/format'
import { useActiveChat } from '../GroupChat'
import './modes.css'

const GLYPH: Record<ChatMode, string> = { ask: '?', plan: '◇', edit: '±', auto: '»' }

// Mode picked before the first message of a new chat (no chat id yet).
let pending: ChatMode = DEFAULT_CHAT_MODE
const listeners = new Set<() => void>()
const setPending = (m: ChatMode) => {
  pending = m
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))

export function useChatMode(): { mode: ChatMode; setMode: (m: ChatMode) => void; pendingMode: ChatMode | null } {
  const { state, actions } = useStore()
  const chat = useActiveChat()
  const pend = useSyncExternalStore(subscribe, () => pending)
  const id = state.activeChatId

  // A chat just created from the composer takes the mode picked before it existed.
  useEffect(() => {
    if (!id || pending === DEFAULT_CHAT_MODE) return
    const m = pending
    setPending(DEFAULT_CHAT_MODE)
    void window.harness.setChatMode(id, m).catch(() => undefined)
  }, [id])

  const mode: ChatMode = chat ? chat.chatMode ?? DEFAULT_CHAT_MODE : pend
  const setMode = (m: ChatMode) => {
    if (!id) return setPending(m)
    actions.set({ chats: state.chats.map((c) => (c.id === id ? { ...c, chatMode: m } : c)) })
    void window.harness.setChatMode(id, m).catch((e) => actions.toast({ text: 'Could not change the mode', detail: errorText(e), kind: 'err' }))
  }
  return { mode, setMode, pendingMode: id ? null : pend !== DEFAULT_CHAT_MODE ? pend : null }
}

export function ModePill({ mode, setMode }: { mode: ChatMode; setMode: (m: ChatMode) => void }) {
  const menu = useMenu()
  const info = CHAT_MODES.find((m) => m.id === mode) ?? CHAT_MODES[2]
  return (
    <>
      <button
        type="button"
        className={`cm-pill cm-${mode}`}
        title={`${info.hint} · Shift+Tab cycles`}
        aria-label={`Chat mode: ${info.label}`}
        onClick={(e) =>
          menu.openAbove(e.currentTarget, [{ header: 'Chat mode' }, ...CHAT_MODES.map((m) => ({ label: m.label, sub: m.hint, checked: m.id === mode, onSelect: () => setMode(m.id) }))], { minWidth: 290 })
        }
      >
        <span className="cm-glyph" aria-hidden>
          {GLYPH[mode]}
        </span>
        {info.label.toLowerCase()}
      </button>
      {menu.node && createPortal(menu.node, document.body)}
    </>
  )
}

export function cycleMode(mode: ChatMode, setMode: (m: ChatMode) => void): void {
  setMode(nextChatMode(mode))
}

export function ModeBadge({ mode }: { mode?: ChatMode }) {
  if (!mode) return null
  return (
    <span className={`cm-badge cm-${mode}`} title={`Sent in ${modeLabel(mode)} mode`}>
      {CHAT_MODES.find((m) => m.id === mode)?.short ?? mode}
    </span>
  )
}
