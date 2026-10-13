// IPC entry point for the agent layer. main/index.ts calls registerAgentIpc once.

import type { IpcMain } from 'electron'
import type { ModelChoice, ProviderId } from '@shared/types'
import { INVOKE_PREFIX } from '../../shared/types.ts'
import type { HarnessContext } from '../context.ts'
import { ChatManager } from './chat.ts'
import { Credentials } from './credentials.ts'
import type { FetchFn } from './openaiLoop.ts'
import { isProviderId, Providers } from './providers.ts'
import type { QueryFn } from './sdk.ts'
import { TestAgentRunner } from './testAgents.ts'

export interface AgentLayer {
  chats: ChatManager
  agents: TestAgentRunner
  credentials: Credentials
  providers: Providers
  dispose(): void
}

// Builds the agent layer without Electron (tests pass a stub query function and fetch).
export function createAgentLayer(
  ctx: HarnessContext,
  opts: { queryFn?: QueryFn; credentials?: Credentials; fetchFn?: FetchFn } = {}
): AgentLayer {
  const credentials = opts.credentials ?? new Credentials(ctx)
  const providers = new Providers(ctx, credentials, opts.fetchFn)
  const chats = new ChatManager(ctx, { queryFn: opts.queryFn, credentials, providers, fetchFn: opts.fetchFn })
  const agents = new TestAgentRunner(ctx, { queryFn: opts.queryFn, credentials, providers, fetchFn: opts.fetchFn })
  return {
    chats,
    agents,
    credentials,
    providers,
    dispose() {
      chats.dispose()
      agents.dispose()
    }
  }
}

function provider(p: unknown): ProviderId {
  if (!isProviderId(p)) throw new Error(`unknown provider ${String(p)}`)
  return p
}

function choice(c: unknown): ModelChoice | undefined {
  if (!c || typeof c !== 'object') return undefined
  const { provider: p, model } = c as Partial<ModelChoice>
  return isProviderId(p) && typeof model === 'string' && model.trim() ? { provider: p, model } : undefined
}

export function registerAgentIpc(ctx: HarnessContext, ipcMain: IpcMain): { dispose(): void } {
  const layer = createAgentLayer(ctx)
  const { chats, agents, credentials, providers } = layer

  const providersChanged = async () => {
    providers.forgetReachability()
    ctx.emit('providers:changed', await providers.list())
  }

  const handlers: Record<string, (...args: any[]) => unknown> = {
    listChats: () => chats.list(),
    newChat: (c?: unknown) => chats.create(choice(c)),
    // Test agent ids work here too, so the UI can open an agent's transcript like a chat.
    getChat: (id: string) => chats.messages(id) ?? agents.messages(id) ?? [],
    sendChat: (id: string, text: string) => chats.send(id, text),
    stopChat: (id: string) => chats.stop(id),
    // Group chat.
    addGuest: (id: string, c: unknown) => {
      const pick = choice(c)
      if (!pick) throw new Error('invalid model choice')
      return chats.addGuest(id, pick)
    },
    removeGuest: (id: string, guest: unknown) => chats.removeGuest(id, String(guest ?? '')),
    setGuestTools: (id: string, on: unknown) => chats.setGuestTools(id, on === true),
    startRoundtable: (id: string, topic: unknown, rounds?: unknown) => chats.roundtable(id, String(topic ?? ''), typeof rounds === 'number' ? rounds : undefined),
    planToChecklist: async (id: string, messageId: unknown) => {
      chats.planToChecklist(id, String(messageId ?? ''))
    },
    hasApiKey: () => credentials.hasApiKey(),
    setApiKey: async (key: string) => {
      await credentials.setKey('anthropic', String(key ?? ''))
      await providersChanged()
    },

    listProviders: () => providers.list(),
    setProviderKey: async (p: unknown, key: unknown) => {
      await credentials.setKey(provider(p), String(key ?? ''))
      await providersChanged()
    },
    setProviderConfig: async (p: unknown, config: { baseUrl?: string } | undefined) => {
      providers.setConfig(provider(p), { baseUrl: typeof config?.baseUrl === 'string' ? config.baseUrl : undefined })
      await providersChanged()
    },
    listModels: (p: unknown) => providers.models(provider(p)),
    setChatModel: (id: string, p: unknown, model: string) => {
      chats.setModel(id, provider(p), String(model ?? ''))
    },
    getDefaultModel: () => providers.defaultModel(),
    setDefaultModel: (p: unknown, model: string) => providers.setDefaultModel(provider(p), String(model ?? '')),
    getAnthropicUseClaudeLogin: () => credentials.useClaudeLogin(),
    setAnthropicUseClaudeLogin: async (on: unknown) => {
      credentials.setUseClaudeLogin(on === true)
      await providersChanged()
    },

    getAgents: () => agents.list(),
    runAgents: (scenarios: string[], c?: unknown) => agents.run(Array.isArray(scenarios) ? scenarios : [], choice(c)),
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
