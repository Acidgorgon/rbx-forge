// Electron shell for the mock-renderer suite (test/e2e-app/mock.ts): opens the built renderer
// (out/renderer/index.html) in a window WITHOUT the preload bridge, so main.tsx installs the browser
// mocks (src/renderer/src/mocks). No app main process, no keys, no network.
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')

if (process.env.FORGE_MOCK_USERDATA) app.setPath('userData', process.env.FORGE_MOCK_USERDATA)

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1400, height: 900, webPreferences: { contextIsolation: true, sandbox: true } })
  void win.loadFile(join(process.env.FORGE_RENDERER_DIR, 'index.html'))
})
app.on('window-all-closed', () => app.quit())
