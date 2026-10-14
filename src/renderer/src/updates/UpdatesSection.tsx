// Settings > Updates: auto-check, channel, Check now, the current version and the offered
// release's notes. Errors (a private feed repo, offline) are explained here, never as popups.
import type { ReactNode } from 'react'
import type { QuickUpdateState, UpdateChannel, UpdateState } from '@shared/types'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { ago, errorText } from '../lib/format'
import { setUpdateState, useRestartForUpdate, useUpdate } from './useUpdate'
import './updates.css'

function statusLine(u: UpdateState): { text: ReactNode; badge?: { cls: string; label: string } } {
  const v = u.offer?.version
  switch (u.phase) {
    case 'disabled':
      return { text: u.note ?? 'Updates are off for this build.', badge: { cls: '', label: 'off' } }
    case 'idle':
      return { text: u.autoCheck ? 'Checks shortly after launch, then every 4 hours.' : 'Automatic checks are off.' }
    case 'checking':
      return { text: 'Checking GitHub Releases...', badge: { cls: 'info', label: 'checking' } }
    case 'none':
      return { text: `You're on the newest ${u.channel === 'beta' ? 'release or beta' : 'release'}.`, badge: { cls: 'ok', label: 'up to date' } }
    case 'available':
      return { text: u.mode === 'manual' ? `${v} is out. Download it from the release page.` : `${v} is available.`, badge: { cls: 'hot', label: `${v} available` } }
    case 'downloading':
      return { text: `Downloading ${v} in the background.`, badge: { cls: 'info', label: `${u.percent ?? 0}%` } }
    case 'ready':
      return { text: `${v} is downloaded. Restart to install it, or it installs the next time you quit Forge.`, badge: { cls: 'hot', label: `${v} ready` } }
    case 'error':
      return { text: u.error?.message ?? 'The update check failed.', badge: { cls: 'err', label: u.error?.kind === 'private' ? 'feed not reachable' : 'check failed' } }
  }
}

function quickLine(q: QuickUpdateState): { text: string; badge?: { cls: string; label: string } } {
  switch (q.phase) {
    case 'unavailable':
      return { text: q.note ?? 'Quick updates are not available in this build.', badge: { cls: '', label: 'off' } }
    case 'off':
      return { text: 'Off. Forge runs the code that came with the installer and only gets fixes through full updates.' }
    case 'idle':
      return { text: 'Checks with the full update check.' }
    case 'checking':
      return { text: 'Checking for a quick update...', badge: { cls: 'info', label: 'checking' } }
    case 'none':
      return { text: 'No newer quick update.', badge: { cls: 'ok', label: 'up to date' } }
    case 'downloading':
      return { text: `Downloading and verifying quick update ${q.version}.`, badge: { cls: 'info', label: 'downloading' } }
    case 'ready':
      return { text: `Quick update ${q.version} ready, restart to apply. It is verified and applies the next time Forge starts.`, badge: { cls: 'hot', label: `${q.version} ready` } }
    case 'needsFull':
      return { text: q.message ?? `Quick update ${q.version} needs a full update.`, badge: { cls: '', label: 'needs full update' } }
    case 'error':
      return { text: q.message ?? 'The quick update check failed.', badge: { cls: 'err', label: 'check failed' } }
  }
}

export function UpdatesSection() {
  const update = useUpdate()
  const { actions } = useStore()
  const restart = useRestartForUpdate()
  const restartQuick = useRestartForUpdate('quick')
  if (!update) return <div className="note">Loading...</div>
  const off = update.phase === 'disabled'
  const line = statusLine(update)

  const quick = update.quick
  const qline = quick ? quickLine(quick) : null
  // Quick updates can run where full updates cannot (an unsigned Mac, a development test build).
  const quickOn = !!quick && quick.phase !== 'unavailable' && quick.phase !== 'off'
  const save = async (patch: { autoCheck?: boolean; channel?: UpdateChannel; quick?: boolean }) => {
    try {
      setUpdateState(await window.harness.updateSetSettings(patch))
    } catch (e) {
      actions.toast({ text: 'Could not save the update settings', detail: errorText(e), kind: 'err' })
    }
  }
  const checkNow = async () => {
    try {
      setUpdateState(await window.harness.updateCheck())
    } catch (e) {
      actions.toast({ text: 'Update check failed', detail: errorText(e), kind: 'err' })
    }
  }

  return (
    <>
      <div className="set-row">
        <div className="set-text">
          <div className="set-title">
            RBX Forge <span className="mono">{update.currentVersion}</span>
          </div>
          <div className="note" title={update.error?.detail}>
            {line.text}
            {update.lastCheck && update.phase !== 'checking' ? ` Last checked ${ago(update.lastCheck)}.` : ''}
          </div>
        </div>
        <div className="set-ctl upd-status">
          {line.badge && <span className={`badge-o ${line.badge.cls}`}>{line.badge.label}</span>}
          {update.phase === 'downloading' && (
            <span className="upd-bar" role="progressbar" aria-valuenow={update.percent ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label="Download progress">
              <i style={{ width: `${update.percent ?? 0}%` }} />
            </span>
          )}
          {update.phase === 'ready' && update.mode === 'install' && (
            <button className="btn primary small" onClick={restart}>
              <Icon name="restart" size={12} /> Restart now
            </button>
          )}
          {update.mode === 'manual' && update.phase === 'available' && (
            <button className="btn primary small" onClick={() => void window.harness.updateOpenRelease()}>
              <Icon name="download" size={12} /> Download
            </button>
          )}
          <button className="btn small" disabled={(off && !quickOn) || update.phase === 'checking' || update.phase === 'downloading' || quick?.phase === 'checking'} onClick={() => void checkNow()}>
            {update.phase === 'checking' || quick?.phase === 'checking' ? 'Checking...' : 'Check now'}
          </button>
        </div>
      </div>
      {update.error?.kind === 'private' && (
        <div className="callout warn">
          Forge reads updates from public GitHub Releases. To keep the source private, publish the installers to a small public repository (for example{' '}
          <code>rbx-forge-releases</code>) and point <code>publish.repo</code> in <code>electron-builder.yml</code> at it.
        </div>
      )}
      <div className="set-row">
        <div className="set-text">
          <div className="set-title">Check for updates automatically</div>
          <div className="note">
            {update.mode === 'manual'
              ? 'At startup and every 4 hours. New versions show in the status bar with a link to the download page.'
              : 'At startup and every 4 hours. Updates download in the background and never restart Forge on their own.'}
          </div>
        </div>
        <div className="set-ctl">
          <input type="checkbox" className="switch" checked={update.autoCheck} disabled={off} onChange={(e) => void save({ autoCheck: e.target.checked })} aria-label="Check for updates automatically" />
        </div>
      </div>
      <div className="set-row">
        <div className="set-text">
          <div className="set-title">Channel</div>
          <div className="note">Beta also offers prereleases: newer, less tested builds. Back on Stable you keep the beta until a newer release comes out.</div>
        </div>
        <div className="set-ctl">
          <div className="seg" role="radiogroup" aria-label="Update channel">
            {(['stable', 'beta'] as const).map((c) => (
              <button key={c} role="radio" aria-checked={update.channel === c} className={update.channel === c ? 'on' : ''} disabled={off} onClick={() => update.channel !== c && void save({ channel: c })}>
                {c === 'stable' ? 'Stable' : 'Beta'}
              </button>
            ))}
          </div>
        </div>
      </div>
      {quick && qline && (
        <>
          <div className="set-row">
            <div className="set-text">
              <div className="set-title">Quick updates</div>
              <div className="note">Fixes reach Forge a few minutes after they are published, without a new installer. Each one is signature-checked before it is used; changes to Electron or bundled packages still come as full updates.</div>
              <div className="note upd-quick-status" title={quick.commit ? `Commit ${quick.commit}${quick.createdAt ? `, built ${new Date(quick.createdAt).toLocaleString()}` : ''}` : undefined}>
                {qline.text}
              </div>
            </div>
            <div className="set-ctl upd-status">
              {qline.badge && <span className={`badge-o ${qline.badge.cls}`}>{qline.badge.label}</span>}
              {quick.phase === 'ready' && (
                <button className="btn primary small" onClick={restartQuick}>
                  <Icon name="restart" size={12} /> Restart
                </button>
              )}
              <input type="checkbox" className="switch" checked={quick.enabled} disabled={quick.phase === 'unavailable'} onChange={(e) => void save({ quick: e.target.checked })} aria-label="Quick updates" />
            </div>
          </div>
          <div className="note upd-running">
            Running:{' '}
            {quick.running.source === 'quick' ? (
              <>
                quick update <span className="mono">{quick.running.version}</span> on the installed app <span className="mono">{quick.running.appVersion}</span>
              </>
            ) : (
              <>
                the installed app's own code <span className="mono">{quick.running.version}</span>
              </>
            )}
          </div>
        </>
      )}
      {update.note && !off && <div className="note upd-mode-note">{update.note}</div>}
      {update.offer?.notes && (
        <>
          <div className="upd-notes-head">
            <div className="set-title">What's new in {update.offer.version}</div>
            <span className="grow" />
            <button className="link-btn" onClick={() => void window.harness.updateOpenRelease()}>
              Release page <Icon name="external" size={11} />
            </button>
          </div>
          <pre className="upd-notes">{update.offer.notes}</pre>
        </>
      )}
      {update.feed && (
        <div className="note upd-feed">
          Feed: <span className="mono">github.com/{update.feed}/releases</span>
        </div>
      )}
    </>
  )
}
