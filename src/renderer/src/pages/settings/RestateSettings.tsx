// Settings rows for "Restate first": Chat (the chat agent) and Labs (VFX Lab, Animation Lab,
// Ability Composer) each pick always / big tasks / never. Stored in main (agent/restate.ts).
import { useEffect, useState } from 'react'
import type { RestateMode, RestateScope, RestateSettings } from '@shared/types'
import { useStore } from '../../store'
import { errorText } from '../../lib/format'

const OPTIONS: [RestateMode, string][] = [
  ['always', 'Always'],
  ['big', 'Big tasks'],
  ['never', 'Never']
]

const TEXT: Record<RestateScope, { title: string; desc: string }> = {
  chat: {
    title: 'Restate goals before big tasks',
    desc: 'Forge first replies with its reading of the request (goal, problem, assumptions) and waits for "Yes, go" or your edit. Big tasks: long, multi-step, open-ended or multi-file requests. /restate forces it for one message.'
  },
  labs: {
    title: 'Restate the brief before compose',
    desc: 'The VFX Lab, Animation Lab and Ability Composer show their reading of a brief (cheap tier) before composing; the confirmed reading goes into the compose prompt and the critic judges against it.'
  }
}

export function RestateSettingRow({ scope }: { scope: RestateScope }) {
  const { actions } = useStore()
  const [settings, setSettings] = useState<RestateSettings | null>(null)
  useEffect(() => {
    void window.harness
      .getRestateSettings()
      .then(setSettings)
      .catch(() => setSettings({ chat: 'big', labs: 'big' }))
  }, [])
  const choose = async (mode: RestateMode) => {
    try {
      setSettings(await window.harness.setRestateSettings({ [scope]: mode }))
    } catch (e) {
      actions.toast({ text: 'Could not save the setting', detail: errorText(e), kind: 'err' })
    }
  }
  const t = TEXT[scope]
  return (
    <div className="set-row" id={`set-restate-${scope}`}>
      <div className="set-text">
        <div className="set-title">{t.title}</div>
        <div className="note">{t.desc}</div>
      </div>
      <div className="set-ctl">
        <div className="seg" role="radiogroup" aria-label={t.title}>
          {OPTIONS.map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={settings?.[scope] === v} className={settings?.[scope] === v ? 'on' : ''} disabled={!settings} onClick={() => void choose(v)}>
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
