import { useEffect, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { monaco } from '../monaco'
import type { StudioConflict, SyncSettings } from '@shared/types'
import { useStore } from '../store'
import { Drawer } from '../components/Drawer'
import { IconAlert, IconCheck, IconGit, IconSync } from '../components/Icons'
import { useTheme } from '../theme'

function ago(t?: number): string {
  if (!t) return 'never'
  const d = Math.round((Date.now() - t) / 60000)
  if (d < 1) return 'just now'
  if (d < 60) return `${d} min ago`
  return `${Math.round(d / 60)} h ago`
}

function StudioConflictCard({ c }: { c: StudioConflict }) {
  const { actions } = useStore()
  const theme = useTheme()
  const [busy, setBusy] = useState<null | 'studio' | 'repo'>(null)
  const repoUri = `inmemory://conflict/repo/${c.path}`
  const studioUri = `inmemory://conflict/studio/${c.path}`
  // The wrapper keeps the models (disposing them while the diff widget still
  // holds them throws); dispose them ourselves after the widget is gone.
  useEffect(
    () => () => {
      setTimeout(() => {
        for (const u of [repoUri, studioUri]) monaco.editor.getModel(monaco.Uri.parse(u))?.dispose()
      }, 0)
    },
    [repoUri, studioUri]
  )
  const resolve = async (take: 'studio' | 'repo') => {
    setBusy(take)
    try {
      await window.harness.resolveStudioConflict(c.path, take)
      actions.toast(take === 'studio' ? 'Using the Studio version' : 'Kept the repo version')
      await actions.refreshSync()
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="conflict-card">
      <div className="conflict-head">
        <IconAlert size={15} />
        <span className="conflict-path" title={c.path}>{c.path}</span>
      </div>
      <div className="diff-labels">
        <span>Repo version</span>
        <span>Studio version</span>
      </div>
      <div className="diff-host">
        <DiffEditor
          original={c.repoSource}
          modified={c.studioSource}
          language="luau"
          originalModelPath={repoUri}
          modifiedModelPath={studioUri}
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          theme={theme === 'dark' ? 'harness-dark' : 'harness-light'}
          options={{
            readOnly: true,
            originalEditable: false,
            renderSideBySide: true,
            useInlineViewWhenSpaceIsLimited: false,
            minimap: { enabled: false },
            fontSize: 12,
            lineHeight: 18,
            fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
            scrollBeyondLastLine: false,
            renderOverviewRuler: false,
            hideUnchangedRegions: { enabled: true, contextLineCount: 2, minimumLineCount: 3 },
            automaticLayout: true
          }}
        />
      </div>
      <div className="conflict-actions">
        <button className="btn" disabled={!!busy} onClick={() => void resolve('repo')}>
          {busy === 'repo' ? 'Keeping…' : 'Keep repo version'}
        </button>
        <button className="btn primary" disabled={!!busy} onClick={() => void resolve('studio')}>
          {busy === 'studio' ? 'Applying…' : 'Use Studio version'}
        </button>
      </div>
    </div>
  )
}

export function SyncDrawer() {
  const { state, actions } = useStore()
  const git = state.git
  const [syncing, setSyncing] = useState(false)
  const [remote, setRemote] = useState('')
  const [settings, setSettings] = useState<SyncSettings | null>(state.syncSettings)

  useEffect(() => {
    void actions.refreshSync()
  }, [actions])
  useEffect(() => setSettings(state.syncSettings), [state.syncSettings])

  const save = (s: SyncSettings) => {
    setSettings(s)
    void window.harness.setSyncSettings(s).then(() => actions.set({ syncSettings: s }))
  }

  const syncNow = async () => {
    setSyncing(true)
    try {
      const g = await window.harness.syncNow()
      actions.set({ git: g })
    } catch (e) {
      actions.toast(`Sync failed: ${(e as Error).message}`)
    } finally {
      setSyncing(false)
    }
  }

  const inSync = git && git.isRepo && !git.behind && !git.ahead && !git.conflicts.length && !git.error

  return (
    <Drawer
      title="Collaborator sync"
      icon={<IconSync />}
      subtitle={git?.isRepo ? `${git.branch ?? 'detached'} · last sync ${ago(git.lastSync)}` : 'Git is not set up'}
      width={920}
      onClose={() => actions.set({ drawer: null })}
      actions={
        git?.isRepo && (
          <button className="btn primary" onClick={() => void syncNow()} disabled={syncing || !git.hasRemote}>
            <IconSync size={14} className={syncing ? 'spin' : ''} />
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        )
      }
    >
      {git && !git.isRepo ? (
        <section className="card">
          <h3>Set up git</h3>
          <p className="muted">This project is not a git repository yet. Add your team's remote so the harness can pull and push for you.</p>
          <form
            className="row-form"
            onSubmit={async (e) => {
              e.preventDefault()
              actions.set({ git: await window.harness.initGit(remote.trim() || undefined) })
            }}
          >
            <input placeholder="https://github.com/you/your-game.git (optional)" value={remote} onChange={(e) => setRemote(e.target.value)} spellCheck={false} />
            <button className="btn primary">Init git</button>
          </form>
        </section>
      ) : (
        git && (
          <section className="card stat-card">
            <div className={`sync-state ${inSync ? 'ok' : git.conflicts.length || git.error ? 'bad' : 'warn'}`}>
              {inSync ? <IconCheck size={18} /> : <IconGit size={18} />}
            </div>
            <div className="sync-main">
              <div className="sync-title">
                {git.conflicts.length ? 'Merge needs your decision' : git.error ? 'Last sync failed' : inSync ? "You're in sync" : 'Updates available'}
              </div>
              <div className="muted">{git.error ?? (git.hasRemote ? `origin/${git.branch ?? 'main'}` : 'No remote configured')}</div>
            </div>
            <div className="stats">
              <div><b>{git.behind}</b><span>behind</span></div>
              <div><b>{git.ahead}</b><span>ahead</span></div>
              <div><b>{git.dirty}</b><span>changed</span></div>
            </div>
          </section>
        )
      )}

      {git && git.conflicts.length > 0 && (
        <section className="card">
          <h3>Git conflicts</h3>
          <p className="muted">These files changed on both sides. Ask Claude to merge them, or fix them in the editor and sync again.</p>
          <ul className="file-list">
            {git.conflicts.map((f) => (
              <li key={f}>
                <button className="link" onClick={() => void actions.openFile(f)}>{f}</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="section">
        <div className="section-head">
          <h3>Studio conflicts</h3>
          <span className="count">{state.studioConflicts.length}</span>
        </div>
        {state.studioConflicts.length === 0 ? (
          <p className="muted small">Nothing held. Scripts edited in Studio flow into the repo automatically.</p>
        ) : (
          <>
            <p className="muted small">A collaborator edited these scripts in Studio while they also changed here. Pick which version to keep.</p>
            {state.studioConflicts.map((c) => (
              <StudioConflictCard key={c.path} c={c} />
            ))}
          </>
        )}
      </section>

      {settings && (
        <section className="section">
          <div className="section-head">
            <h3>Settings</h3>
          </div>
          <div className="settings">
            <label className="setting">
              <div>
                <div className="setting-title">Auto sync</div>
                <div className="muted small">Pull and push on a timer. 0 turns it off.</div>
              </div>
              <div className="num">
                <input type="number" min={0} max={120} value={settings.autoSyncMinutes} onChange={(e) => save({ ...settings, autoSyncMinutes: Math.max(0, Number(e.target.value) || 0) })} />
                <span>min</span>
              </div>
            </label>
            <label className="setting">
              <div>
                <div className="setting-title">Auto-commit before sync</div>
                <div className="muted small">Commits local work as “harness: sync” before pulling.</div>
              </div>
              <input type="checkbox" className="switch" checked={settings.autoCommit} onChange={(e) => save({ ...settings, autoCommit: e.target.checked })} />
            </label>
          </div>
        </section>
      )}
    </Drawer>
  )
}
