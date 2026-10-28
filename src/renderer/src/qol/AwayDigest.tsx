// "Since you were away" card: teammate Studio edits, commits by others, finished lab runs, open
// conflicts / blockers and failing tests. Each line opens its place in Forge. Dismissible.
import type { Digest, DigestItem } from '@shared/types'
import { digestSummary } from '@shared/qol/digest'
import { useActions } from '../store'
import { Icon, type IconName } from '../components/Icons'
import { navigate } from './navigate'

const KIND: Record<DigestItem['kind'], { icon: IconName; tone: string; label: string }> = {
  conflict: { icon: 'diff', tone: 'warn', label: 'conflict' },
  blocker: { icon: 'warn', tone: 'warn', label: 'blocked' },
  studio: { icon: 'studio', tone: '', label: 'studio' },
  commit: { icon: 'branch', tone: '', label: 'commit' },
  lab: { icon: 'sparkle', tone: 'ok', label: 'lab' },
  tests: { icon: 'flask', tone: 'err', label: 'tests' }
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function AwayDigest({ digest, onDismiss }: { digest: Digest; onDismiss: () => void }) {
  const actions = useActions()
  const since = digest.since > 0 ? ago(digest.since) : null
  return (
    <section className="qol-digest" role="region" aria-label="Since you were away">
      <header className="qol-digest-head">
        <Icon name="clock" size={13} />
        <div className="grow">
          <div className="qol-digest-title">{digest.reason === 'idle' ? 'While you were away' : `Since your last session${since ? ` · ${since}` : ''}`}</div>
          <div className="qol-digest-sub">{digest.project} · {digestSummary(digest)}</div>
        </div>
        <button className="icon-btn" onClick={onDismiss} title="Dismiss" aria-label="Dismiss">
          <Icon name="x" size={13} />
        </button>
      </header>
      <ul className="qol-digest-list">
        {digest.items.map((item) => {
          const k = KIND[item.kind]
          const sub = item.id.startsWith('test:') || item.id.endsWith(':more')
          return (
            <li key={item.id} className={sub ? 'sub' : undefined}>
              <button className="qol-digest-row" disabled={!item.target} onClick={() => item.target && navigate(item.target, actions)} title={item.detail ?? item.text}>
                {!sub && <span className={`qol-kind ${k.tone}`}><Icon name={k.icon} size={11} />{k.label}</span>}
                <span className="qol-digest-text">{item.text}</span>
                {item.detail && !sub && <span className="qol-digest-detail mono">{item.detail}</span>}
                {item.at && <span className="qol-digest-at">{ago(item.at)}</span>}
              </button>
            </li>
          )
        })}
      </ul>
      <footer className="qol-digest-foot">
        <button className="link-btn" onClick={() => actions.openPage('settings')}>Settings</button>
        <span className="grow" />
        <button className="btn small" onClick={onDismiss}>Got it</button>
      </footer>
    </section>
  )
}
