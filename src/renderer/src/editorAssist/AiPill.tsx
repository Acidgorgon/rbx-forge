// Status bar toggle for AI inline completions: click turns them on / off; without a ready provider
// it opens Settings > Providers.
import { useSyncExternalStore } from 'react'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { setEditorAssist, useEditorAssist } from './state'
import { completionNote, onCompletionNote } from './inline'

export function AiCompletionsPill() {
  const { state, actions } = useStore()
  const s = useEditorAssist()
  const note = useSyncExternalStore(onCompletionNote, completionNote)
  if (!s || !state.activeFile) return null
  const ready = s.completions.ready
  const on = ready && s.effective.aiCompletions
  const paused = s.completions.paused || (on && note && /paused|cap|budget/i.test(note) ? note : '')
  const led = !on ? 'idle' : paused ? 'warn' : 'ok'
  const title = !ready
    ? `AI completions: off. ${s.completions.detail}\nClick: Settings > Providers`
    : `AI completions: ${on ? 'on' : 'off'} · ${s.completions.detail}${paused ? `\n${paused}` : note && on ? `\nLast: ${note}` : ''}\nTab accepts, Esc dismisses. Click to turn ${on ? 'off' : 'on'}.`
  const click = () => {
    if (!ready) {
      actions.openPage('settings')
      setTimeout(() => document.getElementById('set-providers')?.scrollIntoView({ block: 'start' }), 80)
      return
    }
    void setEditorAssist({ aiCompletions: !on }).catch((e) => actions.toast({ text: 'Could not change AI completions', detail: (e as Error).message, kind: 'err' }))
  }
  return (
    <span className="sb opt-1 ai-pill" role="switch" aria-checked={on} aria-label="AI completions" title={title} onClick={click}>
      <span className={`led ${led}`} />
      <Icon name="bolt" size={12} />
      {on ? 'AI' : 'AI off'}
    </span>
  )
}
