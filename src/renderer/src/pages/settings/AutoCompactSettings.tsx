// Settings rows for auto-compact (shared/autoCompact.ts): on/off and the share of the context window
// at which a chat's older turns are summarized. Stored in main (AppSettings autoCompact /
// autoCompactPct); every chat provider path Forge controls reads it on the next turn.
import { useEffect, useState } from 'react'
import { AUTO_COMPACT_DEFAULT, AUTO_COMPACT_MAX_PCT, AUTO_COMPACT_MIN_PCT, clampCompactPct } from '@shared/autoCompact'
import { useStore } from '../../store'

export function AutoCompactSettingRows() {
  const { state, actions } = useStore()
  const s = state.appSettings
  const pct = s?.autoCompactPct ?? AUTO_COMPACT_DEFAULT.pct
  // Typed value, saved on Enter / blur (saving each keystroke would clamp "6" before "65" arrives).
  const [draft, setDraft] = useState(String(pct))
  useEffect(() => setDraft(String(pct)), [pct])
  const commit = () => {
    const next = clampCompactPct(draft)
    setDraft(String(next))
    if (next !== pct) void actions.setAppSettings({ autoCompactPct: next })
  }
  return (
    <>
      <div className="set-row" id="set-autocompact">
        <div className="set-text">
          <div className="set-title">Auto-compact</div>
          <div className="note">
            When a chat's context reaches the share below of the model's window, its older turns are summarized and the chat goes on from the summary (a
            "Compacted" line shows in the chat). Claude compacts its own session at that point; the Codex CLI manages its own context. /compact runs it now.
          </div>
        </div>
        <div className="set-ctl">
          <input type="checkbox" className="switch" checked={s?.autoCompact !== false} disabled={!s} onChange={(e) => void actions.setAppSettings({ autoCompact: e.target.checked })} aria-label="Auto-compact" />
        </div>
      </div>
      <div className="set-row">
        <div className="set-text">
          <div className="set-title">Compact at</div>
          <div className="note">Percent of the context window ({AUTO_COMPACT_MIN_PCT} to {AUTO_COMPACT_MAX_PCT}). Each compaction re-reads the prompt once, so it runs rarely and halves the context.</div>
        </div>
        <div className="set-ctl">
          <div className="unit-input">
            <input
              className="input"
              type="number"
              min={AUTO_COMPACT_MIN_PCT}
              max={AUTO_COMPACT_MAX_PCT}
              step={5}
              value={draft}
              disabled={!s || s.autoCompact === false}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => e.key === 'Enter' && commit()}
              aria-label="Auto-compact threshold percent"
            />
            <span className="unit">%</span>
          </div>
        </div>
      </div>
    </>
  )
}
