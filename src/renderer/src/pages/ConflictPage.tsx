// Studio conflict as an editor tab: repo vs Studio side by side, Keep repo / Use Studio.
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
  const repoUri = `inmemory://conflict/repo/${path}`
  const studioUri = `inmemory://conflict/studio/${path}`
  // The diff wrapper keeps the models; dispose them once the widget is really gone. StrictMode runs
  // cleanup then the effect again on mount, so the timer checks that no remount happened.
  const mounted = useRef(0)
  useEffect(() => {
    const gen = ++mounted.current
    return () => {
      setTimeout(() => {
        if (mounted.current !== gen) return
        for (const u of [repoUri, studioUri]) monaco.editor.getModel(monaco.Uri.parse(u))?.dispose()
      }, 0)
    }
  }, [repoUri, studioUri])
  const resolve = async (take: 'studio' | 'repo') => {
    setBusy(take)
    try {
      await window.harness.resolveStudioConflict(path, take)
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
  return (
    <div className="conflict">
      <div className="conflict-bar">
        <span className="badge-o warn">studio conflict</span>
        <span className="grow ellipsis mono" title={path}>{path}</span>
        <button className="btn" disabled={!!busy} onClick={() => void resolve('repo')}>{busy === 'repo' ? 'Keeping…' : 'Keep repo'}</button>
        <button className="btn primary" disabled={!!busy} onClick={() => void resolve('studio')}>{busy === 'studio' ? 'Applying…' : 'Use Studio'}</button>
      </div>
      <div className="conflict-labels">
        <span>repo</span>
        <span>studio</span>
      </div>
      <div className="conflict-diff">
        <DiffEditor
          original={c.repoSource}
          modified={c.studioSource}
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
