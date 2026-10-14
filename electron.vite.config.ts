import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { PRODUCTION_CSP } from './src/main/csp.ts'
import { shellInfoFromLock } from './src/main/services/quick/shellInfo.ts'

// The installed app's Electron and package versions, for the quick update compatibility check
// (src/main/services/quick/shellInfo.ts). npm ci installs exactly package-lock.json.
const shellInfo = shellInfoFromLock(JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8')))

// Production builds get the CSP as a <meta> tag; the dev server (HMR, inline preamble) does not.
function cspMeta(): Plugin {
  return {
    name: 'rbx-forge-csp',
    apply: 'build',
    transformIndexHtml: (html: string) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`)
  }
}

// The Forge Bridge plugin template next to the main bundle (out/main/studio/ForgeBridge.luau), so a
// quick update (out/main, out/preload, out/renderer only) ships plugin fixes too. Forge reads this copy
// first (services/studio/wire.ts readPluginTemplate); resources/studio stays the installer's fallback.
function forgeBridgeTemplate(): Plugin {
  return {
    name: 'rbx-forge-bridge-template',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'studio/ForgeBridge.luau', source: readFileSync(resolve('resources/studio/ForgeBridge.luau'), 'utf8') })
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), forgeBridgeTemplate()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    define: { __FORGE_SHELL__: JSON.stringify(shellInfo) },
    build: {
      rollupOptions: {
        // index.js: the bootstrap (package.json main), which loads app.js or a quick update's
        // userData/code/<version>/main/app.js (src/main/bootstrap.ts).
        input: { index: resolve('src/main/bootstrap.ts'), app: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), cspMeta()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  }
})
