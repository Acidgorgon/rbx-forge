// Studio conflict as an editor tab: repo vs Studio side by side, Keep repo / Use Studio. Forge Sync
// conflicts also carry the base (last version Studio and disk agreed on): a 3-way toggle compares
// base -> disk (your change), base -> Studio (the teammate's) or disk vs Studio.
import { useEffect, useRef, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { monaco } from '../monaco'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { useTheme } from '../theme'
import { errorText } from '../lib/format'

export function ConflictPage({ path }: { path: string }) {
  const { state, actions } = useStore()
  const theme = useTheme()
  const c = state.studioConflicts.find((x) => x.path === path)
  const [busy, setBusy] = useState<null | 'studio' | 'repo'>(null)
  const [view, setView] = useState<'disk-studio' | 'base-disk' | 'base-studio'>('disk-studio')
  const repoUri = `inmemory://conflict/${view}/left/${path}`
  const studioUri = `inmemory://conflict/${view}/right/${path}`
  // The diff wrapper keeps the models; dispose them once the widget is really gone. StrictMode runs
  // cleanup then the effect again on mount, so the timer checks that no remount happened.
  const mounted = useRef(0)
  useEffect(() => {
    const gen = ++mounted.current
    return () => {
      setTimeout(() => {
        if (mounted.current !== gen) return
        for (const v of ['disk-studio', 'base-disk', 'base-studio']) {
          for (const side of ['left', 'right']) monaco.editor.getModel(monaco.Uri.parse(`inmemory://conflict/${v}/${side}/${path}`))?.dispose()
        }
      }, 0)
    }
  }, [path])
  const resolve = async (take: 'studio' | 'repo') => {
    setBusy(take)
    try {
      await window.harness.resolveStudioConflict(path, take, c?.placeKey)
      actions.toast({ text: take === 'studio' ? 'Using the Studio version' : 'Kept the repo version', detail: path, kind: 'ok' })
      await actions.refreshSync()
      await actions.reloadFile(path)
      actions.closeTab(`conflict:${path}`)
    } catch (e) {
      actions.toast({ text: 'Could not resolve the conflict', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }
  if (!c) {
    return (
      <div className="page">
        <div className="empty" style={{ height: '100%' }}>
          <Icon name="check" style={{ color: 'var(--ok)' }} />
          <span>This conflict is resolved.</span>
          <button className="btn" onClick={() => void actions.openFile(path)}>Open {path.split('/').pop()}</button>
        </div>
      </div>
    )
  }
  const forge = !!c.placeKey
  const base = c.base ?? ''
  const hasBase = forge && c.base !== null && c.base !== undefined
  const [left, right, leftLabel, rightLabel] =
    hasBase && view === 'base-disk'
      ? [base, c.repoSource, 'base (last agreed)', 'disk (your change)']
      : hasBase && view === 'base-studio'
        ? [base, c.studioSource, 'base (last agreed)', 'studio (teammate change)']
        : [c.repoSource, c.studioSource, forge ? 'disk' : 'repo', 'studio']
  return (
    <div className="conflict">
      <div className="conflict-bar">
        <span className="badge-o warn">studio conflict</span>
        <span className="grow ellipsis mono" title={path}>{path}</span>
        {hasBase && (
          <div className="seg" role="tablist" aria-label="Compare">
            <button className={view === 'disk-studio' ? 'on' : ''} onClick={() => setView('disk-studio')}>disk ⇄ studio</button>
            <button className={view === 'base-disk' ? 'on' : ''} onClick={() => setView('base-disk')}>base → disk</button>
            <button className={view === 'base-studio' ? 'on' : ''} onClick={() => setView('base-studio')}>base → studio</button>
          </div>
        )}
        <button className="btn" disabled={!!busy} onClick={() => void resolve('repo')}>{busy === 'repo' ? 'Keeping…' : forge ? 'Take disk' : 'Keep repo'}</button>
        <button className="btn primary" disabled={!!busy} onClick={() => void resolve('studio')}>{busy === 'studio' ? 'Applying…' : forge ? 'Take Studio' : 'Use Studio'}</button>
      </div>
      {forge && (
        <div className="conflict-why">
          {c.note
            ? `Held: ${c.note}.`
            : c.reason === 'first-run'
              ? 'First sync for this place: Studio and disk differ and there is no shared version yet.'
              : c.reason === 'deleted-vs-edited'
                ? 'One side deleted this script while the other edited it.'
                : 'Changed in Studio and on disk since they last agreed, and the edits overlap.'}
          {c.reason === 'duplicate' ? ' Pick the copy to keep on disk, then delete the extra one in Studio.' : ''}
          {' '}Rojo waits for this place until you pick a side.
          {c.instancePath?.length ? <span className="mono"> · {c.instancePath.join('.')}</span> : null}
        </div>
      )}
      <div className="conflict-labels">
        <span>{leftLabel}</span>
        <span>{rightLabel}</span>
      </div>
      <div className="conflict-diff">
        <DiffEditor
          original={left}
          modified={right}
          language="luau"
          originalModelPath={repoUri}
          modifiedModelPath={studioUri}
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          theme={theme === 'dark' ? 'forge-dark' : 'forge-light'}
          options={{
            readOnly: true,
            originalEditable: false,
            renderSideBySide: true,
            useInlineViewWhenSpaceIsLimited: false,
            minimap: { enabled: false },
            fontSize: 12.5,
            lineHeight: 20,
            fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
            scrollBeyondLastLine: false,
            renderOverviewRuler: false,
            hideUnchangedRegions: { enabled: false },
            automaticLayout: true
          }}
        />
      </div>
    </div>
  )
}
