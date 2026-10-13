// Texture property editor with a picker: the current texture as a thumbnail, the raw reference, and
// a panel listing the texture library (liked first), free procedural shapes (forgetex://gen/...) and
// Roblox's built-ins. Picking a flipbook texture also sets FlipbookLayout on the emitter.
import { useEffect, useState } from 'react'
import type { VfxTexture } from '@shared/types'
import { PROCEDURAL_INFO, PROCEDURAL_TYPES } from '@shared/vfx/tex/procedural'
import { BUILTIN_SMOKE, BUILTIN_SPARKLES, genRef, isTexRef, texRef } from '@shared/vfx/tex/textures'
import { Icon } from '../../components/Icons'
import { useTextureUrl, UploadBadge } from './TextureLab'

const resolved = new Map<string, string | null>()

function useResolved(ref: string): string | null {
  const [url, setUrl] = useState<string | null>(resolved.get(ref) ?? null)
  useEffect(() => {
    if (!ref) return setUrl(null)
    if (resolved.has(ref)) return setUrl(resolved.get(ref) ?? null)
    let live = true
    window.harness
      .vfxResolveTexture(ref)
      .then((u) => {
        if (!isTexRef(ref) || ref.includes('/gen/')) resolved.set(ref, u)
        if (live) setUrl(u)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [ref])
  return url
}

function LibTile({ t, on, onPick }: { t: VfxTexture; on: boolean; onPick: () => void }) {
  const url = useTextureUrl(t)
  return (
    <button type="button" className={`tex-pick-tile${on ? ' on' : ''}`} onClick={onPick} title={`${t.name}\n${texRef(t.id)}${t.flipbook ? `\nflipbook ${t.flipbook.layout}` : ''}`} aria-pressed={on}>
      <span className="tex-pick-img">{url ? <img src={url} alt="" draggable={false} /> : null}</span>
      <span className="tex-pick-name">{t.name}</span>
      <span className="tex-pick-meta">
        {t.rating === 'up' && <span className="tag ok">+1</span>}
        {t.flipbook && <span className="faint mono">{t.flipbook.layout.replace('Grid', '')}</span>}
        <UploadBadge t={t} />
      </span>
    </button>
  )
}

function GenTile({ type, on, onPick }: { type: (typeof PROCEDURAL_TYPES)[number]; on: boolean; onPick: () => void }) {
  const ref = genRef(type, {}, { tint: type === 'smoke' ? 'grey' : undefined })
  const url = useResolved(ref)
  return (
    <button type="button" className={`tex-pick-tile${on ? ' on' : ''}`} onClick={onPick} title={`${PROCEDURAL_INFO[type].label}: ${PROCEDURAL_INFO[type].use}\nfree, made when the effect is saved`} aria-pressed={on}>
      <span className="tex-pick-img">{url ? <img src={url} alt="" draggable={false} /> : null}</span>
      <span className="tex-pick-name">{type}</span>
      <span className="tex-pick-meta">
        <span className="faint mono">free</span>
      </span>
    </button>
  )
}

export function TexturePicker({ value, className, onChange, onPick }: { value: string; className: string; onChange: (v: string) => void; onPick: (ref: string, flipbook?: VfxTexture['flipbook']) => void }) {
  const [open, setOpen] = useState(false)
  const [lib, setLib] = useState<VfxTexture[] | null>(null)
  const thumb = useResolved(value)
  useEffect(() => {
    if (!open) return
    let live = true
    const load = () =>
      window.harness
        .vfxTexList()
        .then((l) => live && setLib([...l].filter((t) => t.rating !== 'down').sort((a, b) => (b.rating === 'up' ? 1 : 0) - (a.rating === 'up' ? 1 : 0))))
        .catch(() => live && setLib([]))
    void load()
    const off = window.harness.on('vfx:textures', () => void load())
    return () => {
      live = false
      off()
    }
  }, [open])
  const isEmitter = className === 'ParticleEmitter'
  const pick = (ref: string, fb?: VfxTexture['flipbook']) => {
    onPick(ref, fb)
    setOpen(false)
  }
  return (
    <div className="tex-field">
      <div className="tex-field-row">
        <span className="tex-field-thumb" aria-hidden>
          {thumb ? <img src={thumb} alt="" draggable={false} /> : <Icon name="image" size={11} />}
        </span>
        <input className="input mono vfx-text" value={value} onChange={(e) => onChange(e.target.value)} placeholder="rbxassetid://…, forgetex://… or art/…png" spellCheck={false} aria-label="Texture" />
        <button type="button" className={`btn small${open ? ' on' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} title="Pick a texture from the library, a free procedural shape or a built-in">
          <Icon name="image" size={11} /> Pick
        </button>
      </div>
      {open && (
        <div className="tex-pick" role="dialog" aria-label="Pick a texture">
          <div className="tex-pick-sec">
            <span className="faint mono">library</span>
            {lib === null && <span className="spinner" aria-hidden />}
            {lib?.length === 0 && <span className="note">No textures yet: make some in the textures tab, or pick a free shape below.</span>}
            <div className="tex-pick-grid">
              {lib?.map((t) => (
                <LibTile key={t.id} t={t} on={value === texRef(t.id)} onPick={() => pick(texRef(t.id), isEmitter ? t.flipbook : undefined)} />
              ))}
            </div>
          </div>
          <div className="tex-pick-sec">
            <span className="faint mono">procedural · free</span>
            <div className="tex-pick-grid">
              {PROCEDURAL_TYPES.map((t) => {
                const ref = genRef(t, {}, { tint: t === 'smoke' ? 'grey' : undefined })
                return <GenTile key={t} type={t} on={value === ref} onPick={() => pick(ref)} />
              })}
            </div>
          </div>
          <div className="tex-pick-sec">
            <span className="faint mono">built-in</span>
            <div className="row tex-pick-builtins">
              {isEmitter ? (
                <>
                  <button type="button" className="badge-o" onClick={() => pick(BUILTIN_SPARKLES)}>
                    sparkles
                  </button>
                  <button type="button" className="badge-o" onClick={() => pick(BUILTIN_SMOKE)}>
                    smoke
                  </button>
                </>
              ) : (
                <button type="button" className="badge-o" onClick={() => pick('')}>
                  none (solid)
                </button>
              )}
            </div>
          </div>
          <p className="note">Textures are white so Color tints them. Library textures preview now and become rbxassetid:// in the project once uploaded.</p>
        </div>
      )}
    </div>
  )
}
