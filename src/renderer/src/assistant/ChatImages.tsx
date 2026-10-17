// Image thumbnails for chat messages and composer attachments; a message's images open in the
// fullscreen viewer (components/Lightbox.tsx).
import { useEffect, useMemo, useState } from 'react'
import type { ChatImage } from '@shared/types'
import { Icon } from '../components/Icons'
import { Lightbox, type LightboxItem } from '../components/Lightbox'
import { attachStoredImage, chatImageUrl } from './attachments'
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

const loadChatImage = (it: LightboxItem) => chatImageUrl(it.key)

// attachable: a model's images get "Attach to message" in the viewer, to ask for changes to one.
export function MessageImages({ images, size = 'md', attachable = false }: { images: ChatImage[]; size?: 'sm' | 'md' | 'lg'; attachable?: boolean }) {
  const [open, setOpen] = useState<number | null>(null)
  const items = useMemo<LightboxItem[]>(() => images.map((i) => ({ key: i.id, name: i.name ?? 'image', detail: sizeLabel(i.bytes) || undefined })), [images])
  if (!images.length) return null
  return (
    <div className={`ci-row${images.length === 1 ? ' single' : ''}`}>
      {images.map((i, k) => (
        <ImageThumb key={i.id} img={i} size={images.length === 1 && size === 'md' ? 'lg' : size} onOpen={() => setOpen(k)} />
      ))}
      {open !== null && (
        <Lightbox
          items={items}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          load={loadChatImage}
          actions={
            attachable
              ? (it) => {
                  const ref = images.find((i) => i.id === it.key)
                  return ref ? (
                    <button
                      className="btn small ghost"
                      onClick={() => {
                        attachStoredImage(ref)
                        setOpen(null)
                      }}
                      title="Attach this image to the message you are writing, to ask for changes to it"
                    >
                      <Icon name="at" size={12} /> Attach to message
                    </button>
                  ) : null
                }
              : undefined
          }
        />
      )}
    </div>
  )
}
