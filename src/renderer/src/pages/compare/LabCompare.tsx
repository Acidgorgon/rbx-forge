// "Compare" for the VFX Lab, the Animation Lab and the Ability Composer: the lab's own preview scenes
// (VfxScene, AnimScene, AbilityScene) inside the generic CompareDialog, fed with the entry's current
// version, its iterations and the rest of the library (shared/compare/labs.ts).
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AbilityEntry, AnimClip, AnimEntry, VfxEffect, VfxEntry } from '@shared/types'
import type { Ability } from '@shared/ability/types'
import { abilityCompareItems, animCompareItems, vfxCompareItems, type AbilityPayload, type AnimPayload, type VfxPayload } from '@shared/compare/labs'
import type { CompareItem } from '@shared/compare/types'
import { CompareDialog, type PaneContext } from '../../components/compare/CompareView'
import { ScenePane } from '../../components/compare/ScenePane'
import { Icon } from '../../components/Icons'
import { VfxScene } from '../vfx/preview/scene'
import { AnimScene } from '../anim/preview/rig'
import { AbilityScene } from '../ability/preview/abilityScene'
import { applyScreen, type ScreenEls } from '../ability/preview/screenFx'
import { ScreenLayers } from '../ability/AbilityPreview'
import { prefersReducedMotion } from '../vfx/motion'

const resolver = (ref: string) => window.harness.vfxResolveTexture(ref)

export function CompareButton({ onClick, count }: { onClick: () => void; count?: number }) {
  return (
    <button className="btn small" onClick={onClick} title="Compare any two versions side by side: synced playback, A/B flip, score and parameter deltas">
      <Icon name="diff" size={11} /> Compare{count ? ` · ${count}` : ''}
    </button>
  )
}

// The library list for the pickers (loaded once when the compare opens).
function useLibrary<T>(load: () => Promise<T[]>): T[] | null {
  const [list, setList] = useState<T[] | null>(null)
  useEffect(() => {
    let live = true
    load().then((l) => live && setList(l)).catch(() => live && setList([]))
    return () => void (live = false)
  }, [])
  return list
}

function VfxPane({ item, ctx }: { item: CompareItem<VfxPayload>; ctx: PaneContext }) {
  return <ScenePane ctx={ctx} label={`${item.label}: 3D preview`} create={(c) => new VfxScene(c, { resolver })} load={(s) => s.load(item.payload.effect)} loadKey={item.id} />
}

export function VfxCompare({ entry, onClose, onUse }: { entry: VfxEntry; onClose: () => void; onUse?: (effect: VfxEffect, label: string) => void }) {
  const lib = useLibrary(() => window.harness.vfxList())
  const items = useMemo(() => (lib ? vfxCompareItems(entry, lib) : null), [entry, lib])
  if (!items) return null
  return (
    <CompareDialog<VfxPayload>
      title={`Compare · ${entry.name}`}
      items={items}
      focus={entry.id}
      onClose={onClose}
      renderPane={(item, ctx) => <VfxPane item={item} ctx={ctx} />}
      onUse={onUse ? (it) => (onUse(it.payload.effect, it.label), onClose()) : undefined}
      useLabel={(it) => (it.entryId === entry.id && !it.current ? `Use ${it.label}` : null)}
    />
  )
}

function AnimPane({ item, ctx }: { item: CompareItem<AnimPayload>; ctx: PaneContext }) {
  return <ScenePane ctx={ctx} label={`${item.label}: 3D preview`} create={(c) => new AnimScene(c)} load={(s) => s.setClip(item.payload.clip)} loadKey={item.id} />
}

export function AnimCompare({ entry, onClose, onUse }: { entry: AnimEntry; onClose: () => void; onUse?: (clip: AnimClip, label: string) => void }) {
  const lib = useLibrary(() => window.harness.animList())
  const items = useMemo(() => (lib ? animCompareItems(entry, lib) : null), [entry, lib])
  if (!items) return null
  return (
    <CompareDialog<AnimPayload>
      title={`Compare · ${entry.name}`}
      items={items}
      focus={entry.id}
      onClose={onClose}
      renderPane={(item, ctx) => <AnimPane item={item} ctx={ctx} />}
      onUse={onUse ? (it) => (onUse(it.payload.clip, it.label), onClose()) : undefined}
      useLabel={(it) => (it.entryId === entry.id && !it.current ? `Use ${it.label}` : null)}
    />
  )
}

// AbilityScene plus its CSS screen effects (flash, tint, bloom) on this pane's overlays.
class AbilityPaneScene {
  scene: AbilityScene
  els: { current: Partial<ScreenEls> }
  canvas: HTMLCanvasElement
  reduced = prefersReducedMotion()
  constructor(canvas: HTMLCanvasElement, els: { current: Partial<ScreenEls> }) {
    this.canvas = canvas
    this.els = els
    this.scene = new AbilityScene(canvas, { resolver })
    this.scene.shakeEnabled = !this.reduced
  }
  load(ability: Ability, effects: Record<string, VfxEffect>): Promise<void> {
    return this.scene.load(ability, effects)
  }
  setTime(t: number): void {
    const f = this.scene.setTime(t)
    const e = this.els.current
    if (e.tint && e.bloom && e.flash) {
      const screen = this.reduced ? { ...f.screen, flash: { ...f.screen.flash, opacity: f.screen.flash.opacity * 0.4 } } : f.screen
      applyScreen({ canvas: this.canvas, tint: e.tint, bloom: e.bloom, flash: e.flash }, screen)
    }
  }
  render(): void {
    this.scene.render()
  }
  resize(w: number, h: number): void {
    this.scene.resize(w, h)
  }
  dispose(): void {
    this.scene.dispose()
  }
}

function AbilityPane({ item, ctx, effects }: { item: CompareItem<AbilityPayload>; ctx: PaneContext; effects: Record<string, VfxEffect> }) {
  const refs = useRef<Partial<ScreenEls>>({})
  return (
    <ScenePane ctx={ctx} label={`${item.label}: 3D preview`} create={(c) => new AbilityPaneScene(c, refs)} load={(s) => s.load(item.payload.ability, effects)} loadKey={item.id}>
      <ScreenLayers refs={refs} />
    </ScenePane>
  )
}

export function AbilityCompare({ entry, onClose }: { entry: AbilityEntry; onClose: () => void }) {
  const lib = useLibrary(() => window.harness.abilityList())
  const fx = useLibrary(() => window.harness.vfxList())
  const items = useMemo(() => (lib ? abilityCompareItems(entry, lib) : null), [entry, lib])
  const effects = useMemo(() => Object.fromEntries((fx ?? []).flatMap((e) => (e.effect ? [[e.id, e.effect] as const] : []))), [fx])
  if (!items || !fx) return null
  return <CompareDialog<AbilityPayload> title={`Compare · ${entry.name}`} items={items} focus={entry.id} onClose={onClose} renderPane={(item, ctx) => <AbilityPane item={item} ctx={ctx} effects={effects} />} />
}
