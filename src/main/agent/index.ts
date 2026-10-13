// IPC entry point for the agent layer. main/index.ts calls registerAgentIpc once.

import type { IpcMain } from 'electron'
import { INVOKE_PREFIX } from '../../shared/types.ts'
import type { HarnessContext } from '../context.ts'
import { ChatManager } from './chat.ts'
import { Credentials } from './credentials.ts'
import type { QueryFn } from './sdk.ts'
import { TestAgentRunner } from './testAgents.ts'

export interface AgentLayer {
  chats: ChatManager
  agents: TestAgentRunner
  credentials: Credentials
  dispose(): void
}

// Builds the agent layer without Electron (tests pass a stub query function).
export function createAgentLayer(ctx: HarnessContext, opts: { queryFn?: QueryFn; credentials?: Credentials } = {}): AgentLayer {
  const credentials = opts.credentials ?? new Credentials(ctx)
  const chats = new ChatManager(ctx, { queryFn: opts.queryFn, credentials })
  const agents = new TestAgentRunner(ctx, { queryFn: opts.queryFn, credentials })
  return {
    chats,
    agents,
    credentials,
    dispose() {
      chats.dispose()
      agents.dispose()
    }
  }
}

export function registerAgentIpc(ctx: HarnessContext, ipcMain: IpcMain): { dispose(): void } {
  const layer = createAgentLayer(ctx)
  const { chats, agents, credentials } = layer

  const handlers: Record<string, (...args: any[]) => unknown> = {
    listChats: () => chats.list(),
    newChat: () => chats.create(),
    // Test agent ids work here too, so the UI can open an agent's transcript like a chat.
    getChat: (id: string) => chats.messages(id) ?? agents.messages(id) ?? [],
    sendChat: (id: string, text: string) => chats.send(id, text),
    stopChat: (id: string) => chats.stop(id),
    hasApiKey: () => credentials.hasApiKey(),
    setApiKey: (key: string) => credentials.setApiKey(key),
    getAgents: () => agents.list(),
    runAgents: (scenarios: string[]) => agents.run(Array.isArray(scenarios) ? scenarios : []),
    cancelAgent: (id: string) => agents.cancel(id)
  }

  for (const [name, fn] of Object.entries(handlers)) {
    ipcMain.handle(INVOKE_PREFIX + name, (_event, ...args) => fn(...args))
  }

  return {
    dispose() {
      for (const name of Object.keys(handlers)) ipcMain.removeHandler(INVOKE_PREFIX + name)
      layer.dispose()
    }
  }
}
