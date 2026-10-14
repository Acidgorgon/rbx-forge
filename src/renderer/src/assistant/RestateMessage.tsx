// A chat restatement card (ChatMessage.card === 'restate'): "Yes, go" or an edit runs the request
// with the confirmed reading (confirmChatRestate in main).
import { useState } from 'react'
import type { ChatMessage, Restatement } from '@shared/types'
import { useStore } from '../store'
import { errorText } from '../lib/format'
import { RestateCard } from '../components/RestateCard'

export function RestateMessage({ m }: { m: ChatMessage }) {
  const { state, actions } = useStore()
  const [sending, setSending] = useState(false)
  const r = m.restate!
  const sessionId = m.sessionId ?? state.activeChatId
  const busy = sending || (sessionId ? !!state.busy[sessionId] : false)
  const confirm = async (edited?: Restatement) => {
    if (!sessionId) return
    setSending(true)
    try {
      await window.harness.confirmChatRestate(sessionId, m.id, edited)
    } catch (e) {
      actions.toast({ text: 'Could not confirm the restatement', detail: errorText(e), kind: 'err' })
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="m-restate">
      <RestateCard restatement={r.confirmed ?? r.draft} kind="chat" state={r.state} edited={r.edited} reason={r.reason} busy={busy} onConfirm={r.state === 'pending' ? (e) => void confirm(e) : undefined} />
    </div>
  )
}
