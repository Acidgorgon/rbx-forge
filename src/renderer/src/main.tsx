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
  const { App } = await import('./App')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void boot()
