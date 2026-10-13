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
  // Offscreen capture window for the Animation Lab critic: only the R15 preview.
  if (new URLSearchParams(location.search).has('anim-capture')) {
    const { AnimCapture } = await import('./pages/anim/AnimCapture')
    createRoot(document.getElementById('root')!).render(<AnimCapture />)
    return
  }
  // Offscreen decoder for ref_import: decodes and analyses a video reference (no UI).
  if (new URLSearchParams(location.search).has('ref-decode')) {
    const { RefDecode } = await import('./pages/videoref/RefDecode')
    createRoot(document.getElementById('root')!).render(<RefDecode />)
    return
  }
  // Offscreen capture window for the Ability Composer critic: only the ability preview.
  if (new URLSearchParams(location.search).has('ability-capture')) {
    const { AbilityCapture } = await import('./pages/ability/AbilityCapture')
    createRoot(document.getElementById('root')!).render(<AbilityCapture />)
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
