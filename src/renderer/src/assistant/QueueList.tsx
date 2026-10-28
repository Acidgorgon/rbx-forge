// Queued prompts above the composer (assistant/queue.ts holds the rules, the store sends them):
// one compact row each, labelled Queued, with edit / send now / remove, and a "Resume queue" line
// when a turn ended with an error, was stopped, or waits for an answer.
import { useState, type KeyboardEvent } from 'react'
import { useActions, useStore } from '../store'
import { Icon } from '../components/Icons'
import { PAUSE_TEXT, type QueuedPrompt } from './queue'
import './queue.css'

function Row({ chatId, item, n, busy }: { chatId: string; item: QueuedPrompt; n: number; busy: boolean }) {
  const actions = useActions()
  const [draft, setDraft] = useState<string | null>(null)
  const save = () => {
    if (draft !== null && draft.trim() !== item.text.trim()) actions.editQueued(chatId, item.id, draft)
    setDraft(null)
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      setDraft(null)
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      save()
    }
  }
  const one = item.text.replace(/\s+/g, ' ').trim()
  return (
    <div className={`cq-row${draft !== null ? ' editing' : ''}`} data-testid="queued-prompt">
      <span className="cq-n" aria-hidden>{n}</span>
      {draft !== null ? (
        <textarea
          className="cq-edit"
          value={draft}
          rows={Math.min(6, Math.max(1, draft.split('\n').length))}
          autoFocus
          aria-label="Edit queued message"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={save}
          spellCheck={false}
        />
      ) : (
        <button type="button" className="cq-text ellipsis" title={`${item.text}${item.context ? `\n\n${item.context}` : ''}\n\nClick to edit`} onClick={() => setDraft(item.text)}>
          {one || (item.images.length ? '(images only)' : '(empty)')}
        </button>
      )}
      {item.images.length > 0 && <span className="cq-tag" title={`${item.images.length} image${item.images.length === 1 ? '' : 's'} attached`}>{item.images.length} img</span>}
      {item.context && <span className="cq-tag" title={item.context}>ctx</span>}
      {draft === null && (
        <>
          <button type="button" className="cq-act" aria-label="Edit queued message" title="Edit" onClick={() => setDraft(item.text)}>
            <Icon name="pencil" size={11} />
          </button>
          <button type="button" className="cq-act cq-now" aria-label="Send now" title={busy ? 'Send now: stop the current turn and send this next' : 'Send now'} onClick={() => void actions.sendQueuedNow(chatId, item.id)}>
            <Icon name="arrowUp" size={11} />
          </button>
          <button type="button" className="cq-act" aria-label="Remove queued message" title="Remove" onClick={() => actions.removeQueued(chatId, item.id)}>
            <Icon name="x" size={11} />
          </button>
        </>
      )}
    </div>
  )
}

export function QueueList({ chatId }: { chatId: string | null }) {
  const { state, actions } = useStore()
  const q = chatId ? state.queues[chatId] ?? [] : []
  if (!chatId || !q.length) return null
  const paused = state.queuePaused[chatId]
  const busy = !!state.busy[chatId]
  return (
    <div className="cmp-queue" role="list" aria-label={`Queued: ${q.length}`} onMouseDown={(e) => e.stopPropagation()}>
      <div className="cq-head">
        <span className="cq-label">Queued</span>
        <span className="faint">· {q.length}{busy && !paused ? ' · sends when this turn ends' : ''}</span>
        <span className="grow" />
        <button type="button" className="link-btn cq-clear" onClick={() => actions.clearQueue(chatId)}>clear</button>
      </div>
      {q.map((item, i) => (
        <Row key={item.id} chatId={chatId} item={item} n={i + 1} busy={busy} />
      ))}
      {paused && (
        <div className="cq-paused" role="status">
          <span className="grow">paused: {PAUSE_TEXT[paused]}</span>
          <button type="button" className="btn small" onClick={() => actions.resumeQueue(chatId)} title={busy ? 'Send the next queued message when this turn ends' : 'Send the next queued message'}>
            Resume queue
          </button>
        </div>
      )}
    </div>
  )
}
