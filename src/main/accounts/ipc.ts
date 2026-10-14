// IPC for Settings > Accounts (shared/accountTypes.ts AccountsApi). Registered by registerAgentIpc,
// which owns Credentials and Providers.

import type { IpcMain } from 'electron'
import { ACCOUNT_IDS, type AccountId } from '../../shared/accountTypes.ts'
import { INVOKE_PREFIX } from '../../shared/types.ts'
import type { HarnessContext } from '../context.ts'
import type { Credentials } from '../agent/credentials.ts'
import type { Providers } from '../agent/providers.ts'
import { codexService } from '../agent/codex/service.ts'
import { ClaudeAccount } from './claude.ts'
import { codexAccountProvider } from './codex.ts'
import { applyCodexDefaults } from './codexDefaults.ts'
import type { ArtSettings } from '../../shared/artTypes.ts'
import { accountRegistry, type AccountRegistry } from './registry.ts'
import { AccountsService, keyCheckMessage } from './service.ts'

export function accountId(v: unknown): AccountId {
  if (typeof v === 'string' && (ACCOUNT_IDS as string[]).includes(v)) return v as AccountId
  throw new Error(`unknown account ${String(v)}`)
}

// The Claude sign-in method wired to Credentials; its `auth status` answers feed Credentials too.
export function claudeAccount(credentials: Credentials, env: NodeJS.ProcessEnv = process.env): ClaudeAccount {
  const claude = new ClaudeAccount({
    env: () => env,
    useLogin: () => credentials.useClaudeLogin(),
    setUseLogin: (on) => credentials.setUseClaudeLogin(on),
    failed: () => credentials.health.failed('claudeLogin'),
    record: (ok, message) => credentials.health.record('claudeLogin', ok, message)
  })
  credentials.setLoginProbe(() => claude.cachedLogin())
  return claude
}

export function registerAccountsIpc(
  ctx: HarnessContext,
  ipcMain: IpcMain,
  deps: { credentials: Credentials; providers: Providers; providersChanged: () => Promise<void>; registry?: AccountRegistry; fetchFn?: typeof fetch }
): { service: AccountsService; dispose(): void } {
  const registry = deps.registry ?? accountRegistry
  const claude = claudeAccount(deps.credentials)
  const unregisterClaude = registry.register(claude)
  // Replaces the Codex placeholder on the OpenAI card (codexService() is configured before this runs).
  const unregisterCodex = registry.register(codexAccountProvider(codexService, { afterSignIn: () => codexDefaults(ctx, deps) }))
  const service = new AccountsService({
    credentials: deps.credentials,
    providers: deps.providers,
    registry,
    emit: (event, payload) => ctx.emit(event as never, payload as never),
    providersChanged: deps.providersChanged,
    log: (text) => ctx.log({ service: 'agent', stream: 'info', text })
  })
  // A request that fails (or recovers) authentication updates the cards and provider status.
  const offHealth = deps.credentials.health.onChange(() => void service.changed())
  // A method registered later (Codex) shows up without a restart.
  const offRegistry = registry.onChange(() => void service.changed())
  // First look at the Claude login in the background, so the first query knows about the Keychain.
  void claude.refresh().catch(() => undefined)

  const handlers: Record<string, (...args: any[]) => unknown> = {
    accountsList: (o?: { refresh?: unknown }) => service.list({ refresh: o?.refresh === true }),
    accountsSignIn: (id: unknown) => service.signIn(accountId(id)),
    accountsCancelSignIn: (id: unknown) => service.cancelSignIn(accountId(id)),
    accountsSubmitCode: (id: unknown, code: unknown) => service.submitCode(accountId(id), String(code ?? '')),
    accountsSignOut: (id: unknown, o?: { cliLogout?: unknown }) => service.signOut(accountId(id), { cliLogout: o?.cliLogout === true }),
    accountsUseExistingLogin: (id: unknown) => service.useExisting(accountId(id)),
    accountsTest: (id: unknown) => service.test(accountId(id)),
    accountsCancelTest: (id: unknown) => service.cancelTest(accountId(id))
  }
  for (const [name, fn] of Object.entries(handlers)) ipcMain.handle(INVOKE_PREFIX + name, (_event, ...args) => fn(...args))

  return {
    service,
    dispose() {
      for (const name of Object.keys(handlers)) ipcMain.removeHandler(INVOKE_PREFIX + name)
      offHealth()
      offRegistry()
      unregisterClaude()
      unregisterCodex()
      service.dispose()
    }
  }
}

// After a ChatGPT sign-in: Codex becomes the default chat model / image backend when no OpenAI API
// key works (codexDefaults.ts). The key check is the same GET /models the card's test runs.
async function codexDefaults(ctx: HarnessContext, deps: { credentials: Credentials; providers: Providers; fetchFn?: typeof fetch }): Promise<string | null> {
  const r = await applyCodexDefaults({
    openAiKeyWorks: async () => {
      if (!(await deps.credentials.getKey('openai'))) return false
      const ep = await deps.providers.endpoint('openai')
      if ('error' in ep) return false
      try {
        const res = await (deps.fetchFn ?? fetch)(`${ep.baseUrl}/models`, { headers: ep.headers, signal: AbortSignal.timeout(8000) })
        await res.arrayBuffer().catch(() => undefined)
        if (res.status === 401 || res.status === 403) return false
        return keyCheckMessage(res.status).ok ? true : null
      } catch {
        return null
      }
    },
    defaultModel: () => deps.providers.defaultModel(),
    providerReady: (p) => deps.providers.ready(p),
    setDefaultModel: (c) => deps.providers.setDefaultModel(c.provider, c.model),
    imageBackend: () => ctx.getSetting<Partial<ArtSettings>>('art.settings', {})?.backend,
    setImageBackend: (backend) => ctx.setSetting('art.settings', { ...ctx.getSetting<Partial<ArtSettings>>('art.settings', {}), backend })
  })
  if (r.message) ctx.log({ service: 'agent', stream: 'info', text: `[codex] ${r.message}` })
  return r.message
}
