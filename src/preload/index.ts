import { contextBridge, ipcRenderer } from 'electron'
import { INVOKE_PREFIX, type HarnessApi, type HarnessEvents } from '@shared/types'

const methods = [
  'openProject', 'getProject', 'getTree', 'getScripts', 'readFile', 'writeFile',
  'getServices', 'startService', 'stopService', 'restartService', 'getLogs',
  'getGitStatus', 'syncNow', 'initGit', 'getSyncSettings', 'setSyncSettings',
  'getStudioConflicts', 'resolveStudioConflict',
  'listChats', 'newChat', 'getChat', 'sendChat', 'stopChat', 'hasApiKey', 'setApiKey',
  'getAgents', 'runAgents', 'cancelAgent',
  'lspStart'
] as const

const api: Record<string, unknown> = {}
for (const name of methods) {
  api[name] = (...args: unknown[]) => ipcRenderer.invoke(INVOKE_PREFIX + name, ...args)
}
// Fire-and-forget: LSP traffic is high-volume and needs no reply from main.
api.lspSend = (message: unknown) => ipcRenderer.send(INVOKE_PREFIX + 'lspSend', message)
api.on = <K extends keyof HarnessEvents>(event: K, handler: (payload: HarnessEvents[K]) => void) => {
  const listener = (_: unknown, payload: HarnessEvents[K]) => handler(payload)
  ipcRenderer.on(event, listener)
  return () => ipcRenderer.removeListener(event, listener)
}

contextBridge.exposeInMainWorld('harness', api as unknown as HarnessApi)
