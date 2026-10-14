// Settings > Sync: which Studio -> disk sync runs (Forge Sync, the project's own script, or none) and
// whether rojo serve waits for the Studio check.
import { useEffect, useState } from 'react'
import type { ForgeSyncSettings as Settings, SyncEngineChoice } from '@shared/types'
import { useStore } from '../store'
import { errorText } from '../lib/format'

const ENGINES: [SyncEngineChoice, string][] = [
  ['forge', 'Forge (recommended)'],
  ['project', 'Project script'],
  ['off', 'Off']
]

const ENGINE_NOTE: Record<SyncEngineChoice, string> = {
  forge: 'Forge reads Studio first through the Forge Bridge plugin, writes teammate edits to disk (new folders and non-script instances too), and only then lets Rojo serve. Every place, every Rojo project.',
  project: "The project's tools/studio-sync.py and its Studio plugin, started by ./dev. Rojo is not held back.",
  off: 'No Studio -> disk sync. Edits made in Studio stay in Studio until someone saves them to files.'
}

export function ForgeSyncSettings() {
  const { actions } = useStore()
  const [s, setS] = useState<Settings | null>(null)
  useEffect(() => {
    void window.harness.forgeSyncSettings().then(setS).catch(() => undefined)
  }, [])
  const save = async (patch: Partial<Settings>) => {
    if (s) setS({ ...s, ...patch })
    try {
      setS(await window.harness.setForgeSyncSettings(patch))
    } catch (e) {
      actions.toast({ text: 'Could not save the sync setting', detail: errorText(e), kind: 'err' })
    }
  }
  if (!s) return null
  return (
    <>
      <div className="set-row">
        <div className="set-text">
          <div className="set-title">Studio sync</div>
          <div className="note">{ENGINE_NOTE[s.engine]}</div>
        </div>
        <div className="set-ctl">
          <div className="seg" role="radiogroup" aria-label="Studio sync engine">
            {ENGINES.map(([v, label]) => (
              <button key={v} role="radio" aria-checked={s.engine === v} className={s.engine === v ? 'on' : ''} onClick={() => void save({ engine: v })}>{label}</button>
            ))}
          </div>
        </div>
      </div>
      {s.engine === 'forge' && (
        <div className="set-row">
          <div className="set-text">
            <div className="set-title">Check Studio before Rojo serves</div>
            <div className="note">Rojo waits for a place until Forge has pulled that place's Studio edits, so connecting Rojo never reverts a teammate's work. Conflicts hold it until you pick a side.</div>
          </div>
          <div className="set-ctl">
            <input type="checkbox" className="switch" checked={s.gateRojo} onChange={(e) => void save({ gateRojo: e.target.checked })} aria-label="Check Studio before Rojo serves" />
          </div>
        </div>
      )}
    </>
  )
}
