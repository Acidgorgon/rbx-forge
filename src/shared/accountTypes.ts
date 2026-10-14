// Settings > Accounts: one card per AI provider with its sign-in status and the easiest way to set
// it up (main/accounts). Keys and tokens never reach the renderer: only masked hints and states.

import type { ProviderId } from './types.ts'

// The cards, in display order. Each maps to one chat provider (custom stays under Providers).
export type AccountId = 'claude' | 'openai' | 'gemini' | 'openrouter' | 'ollama'
export const ACCOUNT_IDS: AccountId[] = ['claude', 'openai', 'gemini', 'openrouter', 'ollama']
export const ACCOUNT_PROVIDER: Record<AccountId, ProviderId> = {
  claude: 'anthropic',
  openai: 'openai',
  gemini: 'gemini',
  openrouter: 'openrouter',
  ollama: 'ollama'
}

// A sign-in method plugged into a card ("Sign in with Claude", "Sign in with ChatGPT (Codex)").
// signedIn: a login exists and is in use (or can be used); signedOut: available but not signed in;
// expired: a request failed with an auth error, sign in again; unavailable: the tool it needs is
// missing (see needs); unknown: could not be checked (e.g. the CLI timed out).
export type SignInState = 'signedIn' | 'signedOut' | 'expired' | 'unavailable' | 'unknown'

export interface SignInStatus {
  // Registry id of the method: 'claude' or 'codex'.
  method: string
  // Button text, e.g. "Sign in with Claude".
  label: string
  state: SignInState
  // Login found on this computer but the app is not using it yet (Claude: the setting is off).
  foundButOff?: boolean
  // Who is signed in, when the tool reports it ("you@example.com · Max"). Never a token.
  account?: string
  // One line for the card ("Claude Code login on this computer", "Needs the Codex CLI").
  detail?: string
  // What is missing when unavailable, e.g. "Codex CLI".
  needs?: string
  // Where to get it, when unavailable.
  needsUrl?: string
  // The method's tool supports logging out of the tool itself (asked before running it).
  canCliLogout?: boolean
  // Signing out always means logging the tool out (Codex: Forge holds no login of its own), so
  // the sign-out dialog offers only the CLI logout.
  cliLogoutOnly?: boolean
  // Last check time (ms).
  checkedAt?: number
}

// What a card shows as its headline.
//   subscription: signed in with a subscription login (Claude / ChatGPT)
//   apiKey: an API key (stored or from the environment)
//   cloud: Bedrock / Vertex / Foundry or a gateway token from the environment (Claude only)
//   local: Ollama server reachable
//   expired: the login in use failed to authenticate
//   none: not set up
export type AccountState = 'subscription' | 'apiKey' | 'cloud' | 'local' | 'expired' | 'none'

export interface AccountCheck {
  ok: boolean
  // "Connected", "Key rejected (HTTP 401)", "Sign-in expired"...
  message: string
  at: number
  // What was tested.
  via?: 'subscription' | 'apiKey' | 'local'
}

export interface AccountSummary {
  id: AccountId
  provider: ProviderId
  label: string
  state: AccountState
  // Headline: "Signed in with Claude subscription", "Using API key …3f9a", "Not set up".
  statusText: string
  ready: boolean
  keySource?: 'stored' | 'env'
  keyHint?: string
  envName?: string
  // Where to get an API key.
  keyUrl?: string
  // Sign-in method for this card (Claude, Codex), when there is one.
  signIn?: SignInStatus
  // Ollama: the server URL.
  baseUrl?: string
  lastCheck?: AccountCheck
}

export type SignInPhase = 'starting' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'timeout'

// Progress of a running sign-in (event 'accounts:signin').
export interface SignInProgress {
  account: AccountId
  method: string
  phase: SignInPhase
  // The sign-in page, when the tool printed one (shown as a fallback link).
  url?: string
  // The tool may ask for a code shown in the browser (Claude: "Paste code here if prompted").
  acceptsCode?: boolean
  message?: string
}

export interface AccountsEvents {
  'accounts:changed': AccountSummary[]
  'accounts:signin': SignInProgress
}

export interface AccountsApi {
  accountsList(opts?: { refresh?: boolean }): Promise<AccountSummary[]>
  // Starts the card's sign-in method; progress arrives as 'accounts:signin'. Resolves when it ends.
  accountsSignIn(account: AccountId): Promise<SignInProgress>
  accountsCancelSignIn(account: AccountId): Promise<void>
  // Sends a code the browser showed to the running sign-in.
  accountsSubmitCode(account: AccountId, code: string): Promise<void>
  // Stops using the login in Forge; cliLogout also logs the tool itself out (asked first).
  accountsSignOut(account: AccountId, opts?: { cliLogout?: boolean }): Promise<AccountSummary[]>
  // Uses a login that already exists on this computer (turns the Claude login setting on).
  accountsUseExistingLogin(account: AccountId): Promise<AccountSummary[]>
  // Tiny request with what the card would use now.
  accountsTest(account: AccountId): Promise<AccountCheck>
  // Stops a running test (the automatic one when Accounts opens).
  accountsCancelTest(account: AccountId): Promise<void>
}
