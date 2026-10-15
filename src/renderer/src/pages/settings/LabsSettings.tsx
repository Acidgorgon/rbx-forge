// Settings > Labs: per-task model tiers shared by the VFX Lab, Animation Lab and Ability Composer
// (stored in the settings store as labs.models). Empty = automatic. Style statistics never use a model.
// Each tier is a dropdown (LabModelSelect): Auto, the ready providers' models, or Custom… for any id.
import { useCallback, useEffect, useState } from 'react'
import { LAB_TIERS, LAB_TIER_INFO, smallModelHint, type LabModelInfo, type LabModels, type LabTier } from '@shared/labModels'
import { useStore } from '../../store'
import { errorText } from '../../lib/format'
import { GatingSettings } from '../gating/LabGating'
import { LabModelSelect } from './LabModelSelect'

export function LabsSettings() {
  const { state, actions } = useStore()
  const [saved, setSaved] = useState<LabModels | null>(null)
  const [info, setInfo] = useState<LabModelInfo | null>(null)

  useEffect(() => {
    void window.harness
      .getLabModels()
      .then(setSaved)
      .catch(() => setSaved({}))
  }, [])

  // What auto resolves to and recent rejections: on mount, when the default model changes, and each
  // time a dropdown opens (a Labs call may have been refused since).
  const refreshInfo = useCallback(() => {
    void window.harness
      .getLabModelInfo()
      .then(setInfo)
      .catch(() => {})
  }, [])
  const defaultKey = `${state.defaultModel?.provider}:${state.defaultModel?.model}`
  useEffect(refreshInfo, [refreshInfo, defaultKey])

  const save = async (tier: LabTier, value: string) => {
    if (!saved || value.trim() === (saved[tier] ?? '')) return
    try {
      const next = await window.harness.setLabModels({ ...saved, [tier]: value.trim() })
      setSaved(next)
      actions.toast({ text: `Labs ${LAB_TIER_INFO[tier].label.toLowerCase()} model: ${next[tier] || 'auto'}`, kind: 'ok', ms: 2200 })
    } catch (e) {
      actions.toast({ text: 'Could not save the Labs models', detail: errorText(e), kind: 'err' })
    }
  }

  return (
    <>
      <p className="note">
        The VFX Lab, Animation Lab and Ability Composer pick a model per task. Auto follows your default model&apos;s provider; a model from another
        provider is used only while your default model is on that provider. Style statistics (timing, easing, poses) are measured in code and never call a model.
      </p>
      {LAB_TIERS.map((tier) => {
        const info_ = LAB_TIER_INFO[tier]
        // The model this tier uses now: its setting, else what auto resolves to (the default tier's
        // auto is the chat model; the critic's is the provider's flagship, or the chat model without one).
        const effective = (saved?.[tier] ?? '').trim() || info?.auto[tier] || (tier === 'default' ? state.defaultModel?.model : '')
        const hint = smallModelHint(tier, effective)
        return (
          <div className="set-row" key={tier}>
            <div className="set-text">
              <div className="set-title">{info_.label}</div>
              <div className="note">{info_.uses}</div>
              {hint && (
                <div className="note warn" role="note" data-testid={`labs-small-model-${tier}`}>
                  {hint}
                </div>
              )}
            </div>
            <div className="set-ctl">
              <LabModelSelect
                tier={tier}
                label={info_.label}
                autoNote={info_.auto}
                value={saved?.[tier] ?? ''}
                info={info}
                providers={state.providers}
                disabled={!saved}
                onOpen={refreshInfo}
                onChange={(v) => void save(tier, v)}
              />
            </div>
          </div>
        )
      })}
      <GatingSettings />
    </>
  )
}
