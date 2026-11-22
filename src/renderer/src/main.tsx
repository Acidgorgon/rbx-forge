import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { initAppearance } from './theme'

initAppearance()

async function boot(): Promise<void> {
  // Browser preview (no Electron preload): install the mock API first.
  if (!window.harness) {
    await import('./mocks')
  }
  // Offscreen capture window for the preview_ui agent tool: only the UI preview stage.
  if (new URLSearchParams(location.search).has('uipreview-capture')) {
    const { CaptureView } = await import('./pages/uipreview/CaptureView')
    createRoot(document.getElementById('root')!).render(<CaptureView />)
    return
  }
  // Offscreen capture window for the Model Lab critic: only the block-model preview.
  if (new URLSearchParams(location.search).has('model-capture')) {
    const { ModelCapture } = await import('./pages/model/ModelCapture')
    createRoot(document.getElementById('root')!).render(<ModelCapture />)
    return
  }
  // Hidden capture window for the Studio check: the live stream of the Roblox Studio window.
  if (new URLSearchParams(location.search).has('studio-capture')) {
    const { StudioCapture } = await import('./pages/studio/StudioCapture')
    createRoot(document.getElementById('root')!).render(<StudioCapture />)
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
