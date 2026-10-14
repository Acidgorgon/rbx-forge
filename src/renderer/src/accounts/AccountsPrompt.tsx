// Chat empty state when nothing can answer: no provider is ready, or the chat's provider stopped
// working (e.g. the Claude sign-in expired). Links to Settings > Accounts.
import type { ProviderInfo } from '@shared/types'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import './accounts.css'

export function AccountsPrompt({ providers, current }: { providers: ProviderInfo[] | null; current?: ProviderInfo }) {
  const { actions } = useStore()
  if (!providers || !providers.length) return null
  const none = !providers.some((p) => p.ready)
  if (none) {
    return (
      <div className="vbox acct-prompt" data-testid="accounts-prompt">
        <div>No model provider is set up.</div>
        <div className="note">Sign in with your Claude subscription, or add an API key for OpenAI, OpenRouter or Gemini, or run Ollama locally.</div>
        <div className="acct-actions">
          <button className="btn primary" onClick={() => actions.openSettings('anthropic')}>Sign in with Claude</button>
          <button className="btn" onClick={() => actions.openSettings()}><Icon name="gear" size={12} /> Other providers</button>
        </div>
      </div>
    )
  }
  // The chosen provider is set up but its last request failed to authenticate.
  if (current && !current.ready && /expired|rejected/i.test(current.detail ?? '')) {
    return (
      <div className="vbox acct-prompt" data-testid="accounts-prompt">
        <div>{current.detail}.</div>
        <div className="acct-actions">
          <button className="btn primary small" onClick={() => actions.openSettings(current.id)}>Fix in Accounts</button>
        </div>
      </div>
    )
  }
  return null
}
