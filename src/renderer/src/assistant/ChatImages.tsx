// Image thumbnails for chat messages and composer attachments, and a full-size viewer.
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatImage } from '@shared/types'
import { Icon } from '../components/Icons'
import { chatImageUrl } from './attachments'
import { sizeLabel } from './imageScale'

export function useChatImageUrl(id: string): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setUrl(null)
    chatImageUrl(id)
      .then((u) => live && setUrl(u))
      .catch(() => live && setUrl(''))
    return () => {
      live = false
    }
  }, [id])
  return url
}

// Paperclip glyph in the icon set's style (16px grid, 1.2 stroke).
export function AttachGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12.6 7.6 7.9 12.3a3 3 0 0 1-4.2-4.2l5-5a2 2 0 0 1 2.8 2.8l-5 5a1 1 0 0 1-1.4-1.4l4.6-4.6" />
    </svg>
  )
}

export function ImageThumb({ img, onRemove, onOpen, size = 'md' }: { img: ChatImage; onRemove?: () => void; onOpen?: () => void; size?: 'sm' | 'md' | 'lg' }) {
  const url = useChatImageUrl(img.id)
  const label = img.name ?? 'image'
  const tip = [label, sizeLabel(img.bytes, img.width, img.height)].filter(Boolean).join(' · ')
  return (
    <span className={`ci-thumb ci-${size}${url === '' ? ' gone' : ''}`} title={tip}>
      <button type="button" className="ci-open" onClick={onOpen} disabled={!onOpen || !url} aria-label={`Open ${label}`}>
        {url ? <img src={url} alt={label} draggable={false} /> : url === '' ? <span className="ci-missing">image unavailable</span> : <span className="ci-loading" />}
      </button>
      {onRemove && (
        <button type="button" className="ci-x" onClick={onRemove} aria-label={`Remove ${label}`}>
          <Icon name="x" size={10} />
        </button>
      )}
    </span>
  )
}

function Viewer({ img, onClose }: { img: ChatImage; onClose: () => void }) {
  const url = useChatImageUrl(img.id)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])
  return createPortal(
    <div className="ci-viewer" role="dialog" aria-label={img.name ?? 'Image'} onClick={onClose}>
      <div className="ci-viewer-box" onClick={(e) => e.stopPropagation()}>
        <div className="ci-viewer-head">
          <span className="ellipsis">{img.name ?? 'image'}</span>
          <span className="faint">{sizeLabel(img.bytes, img.width, img.height)}</span>
          <span className="grow" />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </div>
        {url ? <img src={url} alt={img.name ?? 'image'} /> : <div className="ci-loading big" />}
      </div>
    </div>,
    document.body
  )
}

export function MessageImages({ images, size = 'md' }: { images: ChatImage[]; size?: 'sm' | 'md' | 'lg' }) {
  const [open, setOpen] = useState<ChatImage | null>(null)
  if (!images.length) return null
  return (
    <div className={`ci-row${images.length === 1 ? ' single' : ''}`}>
      {images.map((i) => (
        <ImageThumb key={i.id} img={i} size={images.length === 1 && size === 'md' ? 'lg' : size} onOpen={() => setOpen(i)} />
      ))}
      {open && <Viewer img={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
