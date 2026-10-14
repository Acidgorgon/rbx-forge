// Settings > Notifications (done notifications per category, sound, when) and the quality-of-life
// switches: "since you were away" digest and reopening tabs/drafts on start.
import { useEffect, useState, type ReactNode } from 'react'
import type { NotifyCategory, NotifyMode, QolSettings as Settings, QolSettingsPatch } from '@shared/types'
import { useStore } from '../store'
import { errorText } from '../lib/format'
import { Icon } from '../components/Icons'
import { showSettingsSection } from '../pages/settings/settingsNav'
import { requestBugReport } from './QolRoot'

const MODES: [NotifyMode, string][] = [
  ['unfocused', 'In background'],
  ['always', 'Always'],
  ['off', 'Off']
]

const CATEGORIES: { id: NotifyCategory; title: string; desc: string }[] = [
  { id: 'labs', title: 'Lab runs', desc: 'Compose, refine and critique in the VFX Lab, Animation Lab, Ability Composer and other labs.' },
  { id: 'team', title: 'Team runs', desc: 'An orchestrated team run finished, or waits for your decision on a change.' },
  { id: 'chat', title: 'Long chat replies', desc: 'A chat turn that took over 30 seconds, only while Forge is in the background.' },
  { id: 'builds', title: 'Tests and releases', desc: 'Lune test runs, test agents and releases.' },
  { id: 'sync', title: 'Forge Sync conflicts', desc: 'A Studio edit conflicts with disk and rojo serve is held.' }
]

function Row({ title, desc, children, id }: { title: string; desc?: string; children: ReactNode; id?: string }) {
  return (
    <div className="set-row" id={id}>
      <div className="set-text">
        <div className="set-title">{title}</div>
        {desc && <div className="note">{desc}</div>}
      </div>
      <div className="set-ctl">{children}</div>
    </div>
  )
}

export function openNotificationSettings(openSettings: () => void): void {
  openSettings()
  showSettingsSection('notifications')
}

export function QolSettings() {
  const { actions } = useStore()
  const [s, setS] = useState<Settings | null>(null)
  useEffect(() => {
    void window.harness.qolGetSettings().then(setS).catch(() => undefined)
  }, [])
  const save = async (patch: QolSettingsPatch) => {
    try {
      setS(await window.harness.qolSetSettings(patch))
    } catch (e) {
      actions.toast({ text: 'Could not save the setting', detail: errorText(e), kind: 'err' })
    }
  }
  if (!s) return <div className="note">Loading...</div>
  const off = s.notify.mode === 'off'
  return (
    <>
      <Row title="Show notifications" desc="When a long task finishes or needs you. Clicking one brings Forge forward on the right page.">
        <div className="seg" role="radiogroup" aria-label="Show notifications">
          {MODES.map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={s.notify.mode === v} className={s.notify.mode === v ? 'on' : ''} onClick={() => void save({ notify: { mode: v } })}>
              {label}
            </button>
          ))}
        </div>
      </Row>
      {CATEGORIES.map((c) => (
        <Row key={c.id} title={c.title} desc={c.desc}>
          <input type="checkbox" className="switch" checked={s.notify.categories[c.id]} disabled={off} onChange={(e) => void save({ notify: { categories: { [c.id]: e.target.checked } } })} aria-label={c.title} />
        </Row>
      ))}
      <Row title="Sound" desc="Play the system notification sound.">
        <input type="checkbox" className="switch" checked={s.notify.sound} disabled={off} onChange={(e) => void save({ notify: { sound: e.target.checked } })} aria-label="Notification sound" />
      </Row>
      <Row title="Test" desc="Shows one notification now, whatever the settings above.">
        <button className="btn small" onClick={() => void window.harness.qolTestNotify().catch((e) => actions.toast({ text: 'Notifications are not available', detail: errorText(e), kind: 'err' }))}>
          <Icon name="bell" size={12} /> Send a test
        </button>
      </Row>
      <h3 className="set-sub">Coming back</h3>
      <Row title="Since you were away" desc="On project open and after an hour idle: teammate Studio edits, new commits by others, finished lab runs, conflicts and failing tests.">
        <input type="checkbox" className="switch" checked={s.digest} onChange={(e) => void save({ digest: e.target.checked })} aria-label="Since you were away" />
      </Row>
      <Row title="Pick up where you left off" desc="Reopen tabs, the active page, panel sizes, chat drafts and scroll, lab selections and cursor positions on start and after an update.">
        <input type="checkbox" className="switch" checked={s.restore} onChange={(e) => void save({ restore: e.target.checked })} aria-label="Pick up where you left off" />
      </Row>
      <Row title="Bug reports" desc="Screenshot, recent errors and logs (keys and tokens redacted), saved on this computer and copied. Nothing is uploaded.">
        <button className="btn small" onClick={requestBugReport}>
          <Icon name="bug" size={12} /> Report a bug
        </button>
      </Row>
    </>
  )
}
