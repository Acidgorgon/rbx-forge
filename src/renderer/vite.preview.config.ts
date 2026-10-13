// Browser preview of the renderer with the mock API (no Electron).
// npx vite --config src/renderer/vite.preview.config.ts
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve(__dirname),
  plugins: [react()],
  resolve: { alias: { '@shared': resolve(__dirname, '../shared') } }
})
