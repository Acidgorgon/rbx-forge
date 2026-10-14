// "Sign in with ChatGPT (Codex)" on the OpenAI card: the Codex service (agent/codex/service.ts)
// plugged into the Accounts registry. The Codex CLI keeps the login; Forge only asks it.

import type { AccountCheck, SignInStatus } from '../../shared/accountTypes.ts'
import type { CodexService, CodexStatus } from '../agent/codex/service.ts'
import type { AccountProvider } from './registry.ts'

export const CODEX_LABEL = 'Sign in with ChatGPT (Codex)'
export const CODEX_DOCS_URL = 'https://developers.openai.com/codex/cli'

type CodexLike = Pick<CodexService, 'status' | 'signIn' | 'signOut'>

// CodexStatus -> card status. Pure, for tests.
export function codexSignInStatus(s: CodexStatus): SignInStatus {
  // Codex has no "stop using it in Forge": the provider uses whatever the CLI is logged in with,
  // so the only way out is `codex logout`.
  const base = { method: 'codex', label: CODEX_LABEL, needs: 'Codex CLI', canCliLogout: s.installed, cliLogoutOnly: true, checkedAt: s.checkedAt }
  if (!s.installed) return { ...base, state: 'unavailable', needsUrl: CODEX_DOCS_URL, detail: 'Needs the Codex CLI. Use an API key for now.' }
  const version = s.version ? ` · codex ${s.version}` : ''
  if (s.loggedIn) {
    const account = s.method === 'apikey' ? 'Codex API key login (billed to the API, not your ChatGPT plan)' : s.method === 'chatgpt' ? 'ChatGPT plan' : s.detail
    return { ...base, state: 'signedIn', account: `${account}${version}`, detail: s.detail }
  }
  return { ...base, state: 'signedOut', detail: `Codex CLI found${version}. ${s.detail}`.trim() }
}

export function codexAccountProvider(codex: () => CodexLike): AccountProvider {
  return {
    method: 'codex',
    account: 'openai',
    label: CODEX_LABEL,
    status: async (opts) => codexSignInStatus(await codex().status({ refresh: opts?.refresh === true })),
    signIn: (ctl) => codex().signIn({ signal: ctl.signal, progress: (u) => ctl.progress(u) }),
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
