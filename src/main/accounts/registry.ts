// Sign-in methods for the Settings > Accounts cards, by method id.
//
// Plug-in point for other services: the Codex service registers its "Sign in with ChatGPT (Codex)"
// method here, replacing the placeholder, without touching the Accounts code:
//
//   import { accountRegistry } from '../accounts/registry.ts'
//   accountRegistry.register({
//     method: 'codex', account: 'openai', label: 'Sign in with ChatGPT (Codex)',
//     status: async ({ refresh }) => ({ method: 'codex', label: 'Sign in with ChatGPT (Codex)', state: 'signedIn', account: 'you@example.com' }),
//     signIn: async (ctl) => { ...spawn `codex login`, ctl.progress({ url }), honour ctl.signal...; return { ok: true } },
//     signOut: async ({ cliLogout }) => { ...stop using it; run `codex logout` only when cliLogout },
//     test: async (signal) => ({ ok: true, message: 'Connected', at: Date.now(), via: 'subscription' })
//   })
//
// AccountsService (service.ts) runs one sign-in per card at a time, applies the timeout, forwards
// progress to the renderer, and refreshes provider status afterwards. A card's headline says
// "Signed in with ..." when its method reports state 'signedIn' (and not foundButOff).

import type { AccountCheck, AccountId, SignInStatus } from '../../shared/accountTypes.ts'

export interface SignInControl {
  // Aborted on cancel or timeout: stop the subprocess.
  signal: AbortSignal
  // url: the sign-in page (shown as a fallback link); acceptsCode: the tool asks for a pasted code.
  progress(update: { url?: string; message?: string; acceptsCode?: boolean }): void
  // Codes the user pastes from the browser, for tools that ask for one.
  onCode(handler: (code: string) => void): void
}

export interface AccountProvider {
  // Registry id ('claude', 'codex').
  method: string
  // The card it belongs to.
  account: AccountId
  label: string
  status(opts?: { refresh?: boolean }): Promise<SignInStatus>
  signIn(ctl: SignInControl): Promise<{ ok: boolean; message?: string }>
  // Stop using the login in Forge; cliLogout (asked first) also logs the tool itself out.
  signOut(opts: { cliLogout: boolean }): Promise<void>
  // Use a login that already exists on this computer.
  useExisting?(): Promise<void>
  // A tiny request on this login.
  test?(signal: AbortSignal): Promise<AccountCheck>
}

export class AccountRegistry {
  private methods = new Map<string, AccountProvider>()
  private listeners = new Set<() => void>()

  register(p: AccountProvider): () => void {
    this.methods.set(p.method, p)
    for (const fn of this.listeners) fn()
    return () => {
      if (this.methods.get(p.method) === p) {
        this.methods.delete(p.method)
        for (const fn of this.listeners) fn()
      }
    }
  }

  get(method: string): AccountProvider | undefined {
    return this.methods.get(method)
  }

  // The sign-in method for a card (the last one registered for it).
  forAccount(account: AccountId): AccountProvider | undefined {
    let found: AccountProvider | undefined
    for (const p of this.methods.values()) if (p.account === account) found = p
    return found
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

// Placeholder for the OpenAI card until the Codex service registers its method.
export const CODEX_PLACEHOLDER: AccountProvider = {
  method: 'codex',
  account: 'openai',
  label: 'Sign in with ChatGPT (Codex)',
  status: async () => ({
    method: 'codex',
    label: 'Sign in with ChatGPT (Codex)',
    state: 'unavailable',
    needs: 'Codex CLI',
    needsUrl: 'https://developers.openai.com/codex/cli',
    detail: 'Needs the Codex CLI. Use an API key for now.'
  }),
  signIn: async () => ({ ok: false, message: 'Sign in with ChatGPT needs the Codex CLI, which this version of Forge does not use yet.' }),
  signOut: async () => undefined
}

// The app-wide registry (main process). Tests make their own AccountRegistry.
export const accountRegistry = new AccountRegistry()
accountRegistry.register(CODEX_PLACEHOLDER)
