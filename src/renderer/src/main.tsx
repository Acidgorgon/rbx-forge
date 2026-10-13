import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { initAppearance } from './theme'

initAppearance()

async function boot(): Promise<void> {
  // Browser preview (no Electron preload): install the mock API first.
  if (!window.harness) {
    await import('./mock')
  }
  // Offscreen capture window for the preview_ui agent tool: only the UI preview stage.
  if (new URLSearchParams(location.search).has('uipreview-capture')) {
    const { CaptureView } = await import('./pages/uipreview/CaptureView')
    createRoot(document.getElementById('root')!).render(<CaptureView />)
    return
  }
  // Offscreen capture window for vfx_render and the VFX refine loop: only the 3D preview.
  if (new URLSearchParams(location.search).has('vfx-capture')) {
    const { VfxCapture } = await import('./pages/vfx/VfxCapture')
    createRoot(document.getElementById('root')!).render(<VfxCapture />)
    return
  }
  const { App } = await import('./App')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void boot()
