// Per-chat reasoning effort: a "Med ▾" pill next to the model pill, and the routed summary
// ("auto → sonnet · med") so the person can see what the router picked.
import { useEffect, useState } from 'react'
import type { ChatSession, EffortChoice, ModelChoice } from '@shared/types'
import { EFFORT_LABEL, EFFORT_SHORT, effortSupport, routeSummary, supportsVision } from '@shared/modelCaps'
import { useActions, useStore } from '../store'
import { useMenu } from '../components/Menu'
import { errorText } from '../lib/format'

const HINT: Record<EffortChoice, string> = {
  auto: 'Router decides: low for quick questions, high for big tasks',
  low: 'Fastest, least thinking',
  medium: 'Balanced',
  high: 'Thinks harder on complex work',
  xhigh: 'Extra-high: long reasoning for hard problems',
  max: 'Deepest reasoning, slowest and most tokens'
}

// Runtime metadata the main process reported for a model (OpenRouter, Ollama).
export function useModelMeta(choice: ModelChoice | null) {
  const { state } = useStore()
  if (!choice) return undefined
  return state.providers?.find((p) => p.id === choice.provider)?.meta?.[choice.model]
}

export function useVision(choice: ModelChoice | null): boolean {
  const meta = useModelMeta(choice)
  return !!choice && supportsVision(choice.provider, choice.model, meta)
}

export function EffortPicker({ chat, choice }: { chat?: ChatSession; choice: ModelChoice | null }) {
  const { state, actions } = useStore()
  const menu = useMenu()
  const meta = useModelMeta(choice)
  if (!choice) return null
  const support = effortSupport(choice.provider, choice.model, meta)
  if (!support.levels.length) return null
  const value: EffortChoice = chat ? chat.effort ?? 'auto' : state.pendingEffort ?? 'auto'

  const set = async (e: EffortChoice) => {
    if (!chat) {
      actions.set({ pendingEffort: e })
      return
    }
    actions.set({ chats: state.chats.map((c) => (c.id === chat.id ? { ...c, effort: e === 'auto' ? undefined : e } : c)) })
    try {
      // chat:updated brings the saved session back.
      await window.harness.setChatEffort(chat.id, e)
    } catch (err) {
      actions.toast({ text: 'Could not change the effort', detail: errorText(err), kind: 'err' })
    }
  }

  const open = (el: HTMLElement) =>
    menu.openUnder(
      el,
      [
        { header: 'Reasoning effort' },
        ...(['auto', ...support.levels] as EffortChoice[]).map((e) => ({
          label: EFFORT_LABEL[e] + (e !== 'auto' && e === support.default ? '  (model default)' : ''),
          sub: HINT[e],
          checked: e === value,
          onSelect: () => void set(e)
        }))
      ],
      { minWidth: 260 }
    )

  return (
    <>
      <button type="button" className="pill" onClick={(e) => open(e.currentTarget)} title={`Reasoning effort: ${EFFORT_LABEL[value]}`} aria-label={`Reasoning effort: ${EFFORT_LABEL[value]}`}>
        <GaugeGlyph /> {EFFORT_SHORT[value]} <span className="caret">▼</span>
      </button>
      {menu.node}
    </>
  )
}

// Small dial in the icon set's style, so the effort pill does not read like the mode pill.
function GaugeGlyph() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden style={{ color: 'var(--fg-faint)', flex: 'none' }}>
      <path d="M2.5 11.5a5.5 5.5 0 1 1 11 0" />
      <path d="M8 11.5 10.6 6.8" />
    </svg>
  )
}

// "auto → sonnet · med" for the last turn (what the router actually ran).
export function RouteSummary({ chat }: { chat?: ChatSession }) {
  if (!chat?.route) return null
  const support = effortSupport(chat.provider, chat.route.model)
  const text = routeSummary(chat.route, chat.effort ?? 'auto', support.default)
  if (!text) return null
  return (
    <span className="eff-route ellipsis" title={`Last turn: ${chat.route.model}${chat.route.effort ? ` · effort ${chat.route.effort}` : ''}\n${chat.route.reason}`}>
      {text}
    </span>
  )
}

// Settings row: the effort new chats start with.
export function DefaultEffortSetting() {
  const actions = useActions()
  const [value, setValue] = useState<EffortChoice | null>(null)
  useEffect(() => {
    void window.harness
      .getDefaultEffort()
      .then(setValue)
      .catch(() => setValue('auto'))
  }, [])
  const options: EffortChoice[] = ['auto', 'low', 'medium', 'high', 'max']
  const pick = async (e: EffortChoice) => {
    setValue(e)
    try {
      await window.harness.setDefaultEffort(e)
    } catch (err) {
      actions.toast({ text: 'Could not save the default effort', detail: errorText(err), kind: 'err' })
    }
  }
  return (
    <div className="set-row" id="set-effort">
      <div className="set-text">
        <div className="set-title">Reasoning effort</div>
        <div className="note">Default for new chats. Auto lets the router pick (low for quick questions, high for big tasks); each chat can override it from the pill next to the model. Levels a model lacks fall back to the nearest one it has.</div>
      </div>
      <div className="set-ctl">
        <div className="seg" role="radiogroup" aria-label="Default reasoning effort">
          {options.map((e) => (
            <button key={e} type="button" role="radio" aria-checked={value === e} className={value === e ? 'on' : ''} disabled={value === null} onClick={() => void pick(e)}>
              {EFFORT_SHORT[e]}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
