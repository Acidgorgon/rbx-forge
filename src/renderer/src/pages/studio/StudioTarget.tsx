// Studio target picker, shared by the VFX Lab header (next to Live in Studio) and the labs' Studio tab
// (VFX Lab, Animation Lab, Ability Composer): with two or more Roblox Studio places connected to the
// Forge Bridge, "Test in: <place>" picks the one that gets Live in Studio, Loop, Studio checks and
// Studio imports. Hidden with zero or one place. Main keeps the choice per project
// (services/studio/wire.ts studioTargets); a chosen place that disconnects falls back to any Studio
// window, with one toast. One shared poll however many pickers are mounted.
import { useSyncExternalStore } from 'react'
import type { StudioPlaces, StudioTarget } from '@shared/types'
import { placeLabel, targetKey } from '@shared/studio/target'
import { useStore, type ToastInput } from '../../store'
import { errorText } from '../../lib/format'
import './studio.css'

const POLL_MS = 3000

let snapshot: StudioPlaces | null = null
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let offBridge: (() => void) | null = null
let toast: ((t: ToastInput) => void) | null = null
// The chosen place already reported as gone (one toast per disconnect).
let lostKey: string | null = null

function publish(next: StudioPlaces): void {
  const prev = snapshot
  snapshot = next
  if (next.chosen && next.why === 'lost') {
    const k = targetKey(next.chosen)
    if (prev?.why === 'chosen' && lostKey !== k) {
      lostKey = k
      toast?.({ text: `${placeLabel(next.chosen)} disconnected`, detail: 'Studio jobs go to any open Studio window until it is back (or pick another place in "Test in").', kind: 'info', ms: 7000 })
    }
  } else lostKey = null
  for (const l of listeners) l()
}

async function refresh(): Promise<void> {
  const next = await window.harness.studioPlaces?.().catch(() => null)
  if (next) publish(next)
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  if (!timer) {
    void refresh()
    timer = setInterval(() => void refresh(), POLL_MS)
    offBridge = window.harness.on?.('studio:bridge', () => void refresh()) ?? null
  }
  return () => {
    listeners.delete(l)
    if (listeners.size || !timer) return
    clearInterval(timer)
    timer = null
    offBridge?.()
    offBridge = null
  }
}

export function useStudioPlaces(): StudioPlaces | null {
  return useSyncExternalStore(subscribe, () => snapshot)
}

export function StudioTargetPicker({ className = '' }: { className?: string }) {
  const { actions } = useStore()
  toast = actions.toast
  const v = useStudioPlaces()
  if (!v || v.places.length < 2) return null
  const pick = (key: string) => {
    const p = v.places.find((x) => x.key === key)
    const t: StudioTarget | null = p ? { ...(p.placeId ? { placeId: p.placeId } : {}), ...(p.place ? { place: p.place } : {}) } : null
    window.harness
      .studioSetTarget(t)
      .then(publish)
      .catch((e) => actions.toast({ text: 'Could not change the Studio target', detail: errorText(e), kind: 'err' }))
  }
  return (
    <label className={`studio-target ${className}`} title="Several Roblox Studio places are connected: the one that gets Live in Studio, Loop, Studio checks and imports from Studio (kept for this project)">
      <span>Test in</span>
      <select className="input" value={v.target ?? ''} onChange={(e) => pick(e.target.value)} aria-label="Studio place to test in" data-testid="studio-target">
        {v.places.map((p) => (
          <option key={p.key} value={p.key}>
            {placeLabel(p)}
            {p.linked ? ' · this project' : ''}
          </option>
        ))}
        {v.target === null && <option value="">any Studio window</option>}
      </select>
    </label>
  )
}
