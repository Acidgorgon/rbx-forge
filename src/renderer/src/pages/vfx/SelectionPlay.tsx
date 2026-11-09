// VFX Lab header: "Play Studio selection" (Roblox Studio plays its selected attribute-driven effects
// with ForgeVFX, once or looped) and "Install ForgeVFX" (writes src/shared/VFX/ForgeVFX.luau into the
// project). Main: services/vfx/selectionPlay.ts and VfxService.installEmitRuntime.
import { useEffect, useRef, useState } from 'react'
import type { SelectionPlayStatus } from '@shared/types'
import { useActions } from '../../store'
import { Icon } from '../../components/Icons'
import { errorText } from '../../lib/format'
import { usePersisted } from '../../qol/sessionStore'

export function selectionLine(st: SelectionPlayStatus | null): string | null {
  if (!st || st.state === 'off') return null
  if (st.state === 'starting') return 'Starting the play in Studio…'
  const what = st.names.length ? `${st.names.join(', ')}${st.count > st.names.length ? ` +${st.count - st.names.length}` : ''}` : 'the Studio selection'
  return `${st.loop ? 'Looping' : 'Playing'} ${what} in Studio${st.loop && st.plays ? ` · ${st.plays} plays` : ''}`
}

export function SelectionPlayControls({ projectOpen }: { projectOpen: boolean }) {
  const actions = useActions()
  const h = window.harness
  const [st, setSt] = useState<SelectionPlayStatus | null>(null)
  const [loop, setLoop] = usePersisted<boolean>('vfx.selectionLoop', false)
  const lastError = useRef<string | null>(null)
  useEffect(() => {
    void h.vfxSelectionStatus().then(setSt, () => undefined)
    return h.on('vfx:selection', (s) => {
      setSt(s)
      if (s.error && s.error !== lastError.current) actions.toast({ text: 'Play Studio selection', detail: s.error, kind: 'err', ms: 6000 })
      lastError.current = s.error ?? null
    })
  }, [])
  const on = !!st && st.state !== 'off'
  const play = async () => {
    try {
      lastError.current = null
      setSt(await h.vfxPlaySelection({ loop, gap: st?.gap }))
    } catch (e) {
      actions.toast({ text: 'Play Studio selection', detail: errorText(e), kind: 'err', ms: 6000 })
    }
  }
  const install = async () => {
    try {
      const r = await h.vfxInstallEmitRuntime()
      actions.toast(
        r.status === 'kept'
          ? { text: 'ForgeVFX not installed', detail: `${r.path} exists and is not Forge's; it was left alone.`, kind: 'err', ms: 6000 }
          : { text: r.status === 'written' ? 'ForgeVFX installed' : 'ForgeVFX is up to date', detail: `${r.path} (require it from ReplicatedStorage.Shared.VFX.ForgeVFX)`, kind: 'ok', ms: 4000 }
      )
    } catch (e) {
      actions.toast({ text: 'Could not install ForgeVFX', detail: errorText(e), kind: 'err' })
    }
  }
  return (
    <span className={`vfx-live${on ? ' on' : ''}`} data-testid="vfx-selection-play">
      {on && st?.loop ? (
        <button className="btn on" aria-pressed onClick={() => void h.vfxStopSelection().then(setSt)} title={selectionLine(st) ?? 'Stop playing the Studio selection'}>
          <Icon name="stop" size={12} /> Stop selection
        </button>
      ) : (
        <button
          className="btn"
          onClick={() => void play()}
          title="Play the effects selected in Roblox Studio with ForgeVFX: their attributes (EmitDelay, EmitCount, EmitDuration, Start/End mesh effects…) drive the play. Clones go into Workspace.ForgeLivePreview and are removed afterwards. Uses the Forge Bridge plugin."
        >
          <Icon name="play" size={12} /> {on ? 'Playing in Studio…' : 'Play Studio selection'}
        </button>
      )}
      <label className="vfx-live-opt" title="Replay the selection until Stop">
        <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} aria-label="Loop the Studio selection" /> loop
      </label>
      {loop && on && (
        <label className="vfx-live-opt" title="Pause between replays (seconds)">
          gap
          <input className="input mono" type="number" min={0} max={10} step={0.25} value={st?.gap ?? 0.75} onChange={(e) => void h.vfxSelectionGap(Number(e.target.value)).then(setSt)} aria-label="Gap between selection replays" />
        </label>
      )}
      <button className="btn" onClick={() => void install()} disabled={!projectOpen} title={projectOpen ? 'Write src/shared/VFX/ForgeVFX.luau into this project: ForgeVFX.emit(template, at) plays an attribute-driven effect in game.' : 'Open a game project first'}>
        <Icon name="download" size={12} /> Install ForgeVFX
      </button>
    </span>
  )
}
