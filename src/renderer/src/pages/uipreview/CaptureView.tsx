// Offscreen capture view for the preview_ui agent tool (main/services/uiPreview/electron.ts loads
// the renderer with ?uipreview-capture=1). It renders only the Stage, so the window is exactly the
// device viewport, and exposes window.__uiPreviewCapture(payload), which draws the snapshot and
// resolves once fonts and images are ready.
import { useEffect, useState } from 'react'
import type { UiDevice, UiImageInfo, UiTreeSnapshot } from '@shared/types'
import { PreviewTree } from '@shared/uiPreview/protocol'
import { Stage } from './Stage'
import { loadTreeFonts } from './measure'
import { isTagged } from '@shared/uiPreview/protocol'
import './fonts'
import './uipreview.css'

interface Payload {
  tree: UiTreeSnapshot
  width: number
  height: number
  device: UiDevice
  images: Record<string, UiImageInfo>
}

declare global {
  interface Window {
    __uiPreviewCapture?: (payload: Payload) => Promise<boolean>
  }
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

async function imagesReady(urls: string[]): Promise<void> {
  await Promise.all(
    urls.map(
      (url) =>
        new Promise<void>((resolve) => {
          const img = new Image()
          const done = () => resolve()
          img.onload = done
          img.onerror = done
          setTimeout(done, 5000)
          img.src = url
        })
    )
  )
}

export function CaptureView() {
  const [payload, setPayload] = useState<{ p: Payload; tree: PreviewTree; fonts: number } | null>(null)
  useEffect(() => {
    document.documentElement.classList.add('uip-capture-doc')
    window.__uiPreviewCapture = async (p) => {
      // Load the faces this tree uses before measuring any text.
      await loadTreeFonts(p.tree.nodes.map((n) => (isTagged(n.props.FontFace, 'Font') ? n.props.FontFace : undefined)))
      await document.fonts.ready
      await imagesReady(Object.values(p.images).flatMap((i) => (i.url ? [i.url] : [])))
      setPayload({ p, tree: PreviewTree.from(p.tree), fonts: 1 })
      await frame()
      await frame()
      return true
    }
    return () => {
      delete window.__uiPreviewCapture
    }
  }, [])
  if (!payload) return <div className="uip-capture" />
  const { p, tree, fonts } = payload
  return (
    <div className="uip-capture" style={{ width: p.width, height: p.height }}>
      <Stage tree={tree} version={tree.version} width={p.width} height={p.height} images={p.images} mode="static" fontsVersion={fonts} />
    </div>
  )
}
