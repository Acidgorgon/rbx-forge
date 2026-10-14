// Settings > Labs: per-task model tiers shared by the VFX Lab, Animation Lab and Ability Composer
// (stored in the settings store as labs.models). Empty = automatic. Style statistics never use a model.
import { useEffect, useState } from 'react'
import { LAB_TIERS, LAB_TIER_INFO, type LabModels, type LabTier } from '@shared/labModels'
import { useStore } from '../../store'
import { errorText } from '../../lib/format'
import { GatingSettings } from '../gating/LabGating'

export function LabsSettings() {
  const { actions } = useStore()
  const [saved, setSaved] = useState<LabModels | null>(null)
  const [draft, setDraft] = useState<LabModels>({})

  useEffect(() => {
    void window.harness
      .getLabModels()
      .then((m) => (setSaved(m), setDraft(m)))
      .catch(() => (setSaved({}), setDraft({})))
  }, [])

  const save = async (tier: LabTier) => {
    if (!saved || (draft[tier] ?? '') === (saved[tier] ?? '')) return
    try {
      const next = await window.harness.setLabModels({ ...saved, [tier]: (draft[tier] ?? '').trim() })
      setSaved(next)
      setDraft(next)
      actions.toast({ text: `Labs ${LAB_TIER_INFO[tier].label.toLowerCase()} model: ${next[tier] || 'auto'}`, kind: 'ok', ms: 2200 })
    } catch (e) {
      actions.toast({ text: 'Could not save the Labs models', detail: errorText(e), kind: 'err' })
    }
  }

  return (
    <>
      <p className="note">
        The VFX Lab, Animation Lab and Ability Composer pick a model per task. Leave a field empty for automatic. Model ids are for the provider of your
        default model. Style statistics (timing, easing, poses) are measured in code and never call a model.
      </p>
      {LAB_TIERS.map((tier) => {
        const info = LAB_TIER_INFO[tier]
        return (
          <div className="set-row" key={tier}>
            <div className="set-text">
              <div className="set-title">{info.label}</div>
              <div className="note">{info.uses}</div>
            </div>
            <div className="set-ctl">
              <input
                className="input mono"
                style={{ width: 260 }}
                value={draft[tier] ?? ''}
                disabled={!saved}
                placeholder={`auto · ${info.auto}`}
                aria-label={`${info.label} model for the Labs`}
                onChange={(e) => setDraft({ ...draft, [tier]: e.target.value })}
                onBlur={() => void save(tier)}
                onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
              />
            </div>
          </div>
        )
      })}
      <GatingSettings />
    </>
  )
}
