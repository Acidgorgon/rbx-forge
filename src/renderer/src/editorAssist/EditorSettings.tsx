// Settings > Editor: format on save (StyLua), autosave, AI inline completions, delete confirmations.
import type { ReactNode } from 'react'
import type { AutoSaveMode } from '@shared/types'
import { useStore } from '../store'
import { openDoctor } from '../pages/qolc/events'
import { setEditorAssist, useEditorAssist } from './state'

function Row({ title, desc, children }: { title: ReactNode; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-title">{title}</div>
        {desc && <div className="note">{desc}</div>}
      </div>
      {children && <div className="set-ctl">{children}</div>}
    </div>
  )
}

const AUTO_SAVE: [AutoSaveMode, string][] = [
  ['off', 'Off'],
  ['afterDelay', 'After delay'],
  ['onFocusChange', 'On focus change']
]

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

export function EditorSettingsSection() {
  const { state, actions } = useStore()
  const app = state.appSettings
  const bin = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows') ? 'Recycle Bin' : 'Trash'
  const s = useEditorAssist()
  const save = (patch: Parameters<typeof setEditorAssist>[0]) =>
    void setEditorAssist(patch).catch((e) => actions.toast({ text: 'Could not save the editor settings', detail: (e as Error).message, kind: 'err' }))
  const stylua = s?.stylua.found
  const ready = s?.completions.ready
  return (
    <section className="set-sec" id="set-editor">
      <h2>Editor</h2>
      <Row
        title="Format on save"
        desc={
          <>
            Runs the project's StyLua (stylua.toml) on Luau files when you save. Format Document anytime with {isMac ? '⇧⌥F' : 'Shift+Alt+F'} or right-click.{' '}
            {s && !stylua && (
              <>
                StyLua is not installed.{' '}
                <button className="link-btn" onClick={openDoctor}>
                  Open Doctor
                </button>
              </>
            )}
          </>
        }
      >
        <input type="checkbox" className="switch" checked={!!s?.effective.formatOnSave} disabled={!s} onChange={(e) => save({ formatOnSave: e.target.checked })} aria-label="Format on save" />
      </Row>
      <Row title="Autosave" desc="On focus change saves when you switch tabs, leave the editor or switch to another app (like VS Code). Files with a held Studio conflict are never autosaved.">
        <div className="seg" role="radiogroup" aria-label="Autosave">
          {AUTO_SAVE.map(([v, label]) => (
            <button key={v} role="radio" aria-checked={s?.settings.autoSave === v} className={s?.settings.autoSave === v ? 'on' : ''} disabled={!s} onClick={() => save({ autoSave: v })}>
              {label}
            </button>
          ))}
        </div>
      </Row>
      <Row title="Format on autosave" desc="Off by default (VS Code's behaviour): autosave writes the text as typed; Ctrl+S formats.">
        <input type="checkbox" className="switch" checked={!!s?.settings.formatOnAutoSave} disabled={!s} onChange={(e) => save({ formatOnAutoSave: e.target.checked })} aria-label="Format on autosave" />
      </Row>
      <Row
        title="AI completions"
        desc={
          s
            ? ready
              ? `Ghost text while you type in Luau files (Tab accepts, Esc dismisses). ${s.completions.detail}. Counts toward your usage and spending cap; .env and secret files are never sent.`
              : s.completions.detail
            : 'Loading...'
        }
      >
        <input type="checkbox" className="switch" checked={!!s?.effective.aiCompletions} disabled={!s || !ready} onChange={(e) => save({ aiCompletions: e.target.checked })} aria-label="AI completions" />
      </Row>
      <Row title="Confirm file deletes" desc={`Ask before Delete moves a file, folder or feature to the ${bin} (you can restore it from there). Deletes that would lose unsaved changes always ask.`}>
        <input type="checkbox" className="switch" checked={app?.confirmFileDelete !== false} disabled={!app} onChange={(e) => void actions.setAppSettings({ confirmFileDelete: e.target.checked })} aria-label="Confirm file deletes" />
      </Row>
      <Row title="Confirm Delete in Studio" desc="Ask before the Game tab deletes a Studio-only instance in the open place (Ctrl+Z in Studio brings it back).">
        <input type="checkbox" className="switch" checked={app?.confirmStudioDelete !== false} disabled={!app} onChange={(e) => void actions.setAppSettings({ confirmStudioDelete: e.target.checked })} aria-label="Confirm Delete in Studio" />
      </Row>
    </section>
  )
}
