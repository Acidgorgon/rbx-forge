// "Sign in with ChatGPT (Codex)" on the OpenAI card: the Codex service (agent/codex/service.ts)
// plugged into the Accounts registry. The Codex CLI keeps the login; Forge only asks it. When the
// CLI is missing the same button installs a private copy first (agent/codex/install.ts).

import type { AccountCheck, SignInStatus } from '../../shared/accountTypes.ts'
import type { CodexService, CodexStatus } from '../agent/codex/service.ts'
import type { AccountProvider } from './registry.ts'

export const CODEX_LABEL = 'Sign in with ChatGPT (Codex)'
export const CODEX_DOCS_URL = 'https://developers.openai.com/codex/cli'

type CodexLike = Pick<CodexService, 'status' | 'signIn' | 'signOut'>

export interface CodexAccountOptions {
  // After a successful sign-in: make Codex the default where OpenAI would be used and no OpenAI API
  // key works (codexDefaults.ts). Returns a sentence for the card, or null when nothing changed.
  afterSignIn?: () => Promise<string | null>
}

// CodexStatus -> card status. Pure, for tests.
export function codexSignInStatus(s: CodexStatus): SignInStatus {
  // Codex has no "stop using it in Forge": the provider uses whatever the CLI is logged in with,
  // so the only way out is `codex logout`.
  const base = { method: 'codex', label: CODEX_LABEL, needs: 'Codex CLI', canCliLogout: s.installed, cliLogoutOnly: true, checkedAt: s.checkedAt }
  // Missing but installable: the sign-in button installs it first.
  if (!s.installed && s.canInstall) return { ...base, state: 'signedOut', detail: s.detail }
  if (!s.installed) return { ...base, state: 'unavailable', needs: 'Codex CLI (or Node.js so Forge can install it)', needsUrl: CODEX_DOCS_URL, detail: s.detail || 'Needs the Codex CLI. Use an API key for now.' }
  const version = s.version ? ` · codex ${s.version}${s.privateInstall ? ' (installed by Forge)' : ''}` : ''
  if (s.loggedIn) {
    const account = s.method === 'apikey' ? 'Codex API key login (billed to the API, not your ChatGPT plan)' : s.method === 'chatgpt' ? 'ChatGPT plan' : s.detail
    return { ...base, state: 'signedIn', account: `${account}${version}`, detail: s.detail }
  }
  return { ...base, state: 'signedOut', detail: `Codex CLI found${version}. ${s.detail}`.trim() }
}

export function codexAccountProvider(codex: () => CodexLike, opts: CodexAccountOptions = {}): AccountProvider {
  return {
    method: 'codex',
    account: 'openai',
    label: CODEX_LABEL,
    // Install (up to 5 minutes) plus the device code's 15 minutes.
    timeoutMs: 21 * 60_000,
    status: async (o) => codexSignInStatus(await codex().status({ refresh: o?.refresh === true })),
    signIn: async (ctl) => {
      const r = await codex().signIn({ signal: ctl.signal, progress: (u) => ctl.progress(u) })
      if (!r.ok || !opts.afterSignIn) return r
      const extra = await opts.afterSignIn().catch(() => null)
      return extra ? { ...r, message: `${r.message ?? 'Signed in.'} ${extra}` } : r
    },
    // Only `codex logout` signs out (see cliLogoutOnly); without it there is nothing Forge holds.
    signOut: async ({ cliLogout }) => {
      if (cliLogout) await codex().signOut()
    },
    // Whether the CLI still reports a login (a real request would spend plan usage).
    test: async (): Promise<AccountCheck> => {
      const s = await codex().status({ refresh: true })
      return s.loggedIn
        ? { ok: true, message: 'Codex CLI is signed in', at: Date.now(), via: 'subscription' }
        : { ok: false, message: s.installed ? 'Codex is not signed in. Sign in again.' : 'Codex CLI not found', at: Date.now(), via: 'subscription' }
    }
  }
}
