/// <reference types="vite/client" />
import type { HarnessApi } from '@shared/types'

declare global {
  interface Window {
    harness: HarnessApi
    // Preload helper: absolute path of a dropped File (missing in the browser preview).
    forgeFiles?: { pathFor(file: File): string; setTitlebarTheme?(theme: 'dark' | 'light'): void }
  }
}
