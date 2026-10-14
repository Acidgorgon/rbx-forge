// Per-chat composer draft and scroll position, kept in the session file (sessionStore.ts).
import { useLayoutEffect, useRef, type RefObject } from 'react'
import { chatView, rememberChat, useSessionVersion } from './sessionStore'

export { useChatDraft } from './sessionStore'

let scrollTimer: ReturnType<typeof setTimeout> | null = null

export function rememberChatScroll(id: string | null, scroll: number, atBottom: boolean): void {
  if (!id) return
  if (scrollTimer) clearTimeout(scrollTimer)
  scrollTimer = setTimeout(() => rememberChat(id, atBottom ? { atBottom: true, scroll: undefined } : { atBottom: false, scroll }), 300)
}

// Once per chat per app session: go back to where the user was reading (unless they were at the bottom).
export function useChatScroll(id: string | null, scroller: RefObject<HTMLDivElement | null>, stick: { current: boolean }, count: number): void {
  const done = useRef(new Set<string>())
  const v = useSessionVersion()
  useLayoutEffect(() => {
    const el = scroller.current
    if (!id || !el || !count || done.current.has(id)) return
    const view = chatView(id)
    if (!view) return
    done.current.add(id)
    if (view.atBottom !== false || view.scroll === undefined) return
    stick.current = false
    el.scrollTop = Math.min(view.scroll, el.scrollHeight)
  }, [id, count, v])
}
