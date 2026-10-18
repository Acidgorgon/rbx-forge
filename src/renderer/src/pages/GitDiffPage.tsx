// A changed file's diff as an editor tab (Source control): staged (HEAD -> staged) or working tree
// (staged or HEAD -> disk), read-only, with Open file and Stage / Unstage. Reloads when git or the
// file changes.
import { useEffect, useRef, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import type { ScmDiff } from '@shared/types'
import { monaco } from '../monaco'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { useTheme } from '../theme'
import { errorText } from '../lib/format'
import { stage, unstage, useScm } from '../views/scmState'

function languageOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return ext === 'luau' || ext === 'lua' ? 'luau' : ext === 'json' ? 'json' : ext === 'md' ? 'markdown' : ext === 'toml' ? 'ini' : 'plaintext'
}

export function GitDiffPage({ path, staged }: { path: string; staged: boolean }) {
  const { state, actions } = useStore()
  const theme = useTheme()
  const scm = useScm()
  const [diff, setDiff] = useState<ScmDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const side = staged ? 'staged' : 'work'
  const left = `inmemory://gitdiff/${side}/left/${path}`
  const right = `inmemory://gitdiff/${side}/right/${path}`

  // Reload on git pushes, status refreshes and file changes.
  useEffect(() => {
    let live = true
    window.harness.scmDiff(path, staged).then(
      (d) => live && (setDiff(d), setError(null)),
      (e) => live && setError(errorText(e))
    )
    return () => {
      live = false
    }
  }, [path, staged, state.git, scm.status])

  // The diff wrapper keeps the models; dispose them once the widget is really gone (see ConflictPage).
  const mounted = useRef(0)
  useEffect(() => {
    const gen = ++mounted.current
    return () => {
      setTimeout(() => {
        if (mounted.current !== gen) return
        for (const uri of [left, right]) monaco.editor.getModel(monaco.Uri.parse(uri))?.dispose()
      }, 0)
    }
  }, [left, right])

  const listed = scm.status ? (staged ? scm.status.staged : scm.status.changes).some((f) => f.path === path) : true
  return (
    <div className="conflict gitdiff">
      <div className="conflict-bar">
        <span className={`badge-o ${staged ? 'ok' : 'warn'}`}>{staged ? 'staged' : 'changes'}</span>
        <span className="grow ellipsis mono" title={path}>{path}</span>
        <button className="btn" onClick={() => void actions.openFile(path)}>
          <Icon name="file" size={12} /> Open file
        </button>
        {listed && (staged ? (
          <button className="btn" disabled={!!scm.busy} onClick={() => void unstage([path])}>
            <Icon name="minus" size={12} /> Unstage
          </button>
        ) : (
          <button className="btn primary" disabled={!!scm.busy} onClick={() => void stage(actions, [path])}>
            <Icon name="plus" size={12} /> Stage
          </button>
        ))}
      </div>
      {error ? (
        <div className="empty" style={{ height: '100%' }}><Icon name="warn" /><span>{error}</span></div>
      ) : !diff ? (
        <div className="empty" style={{ height: '100%' }}><span className="spinner" /></div>
      ) : diff.binary || diff.tooLarge ? (
        <div className="empty" style={{ height: '100%' }}>
          <Icon name="file" />
          <span>{diff.binary ? 'Binary file: no text diff.' : 'Too large to diff here.'}</span>
        </div>
      ) : (
        <>
          <div className="conflict-labels">
            <span>{diff.originalLabel}</span>
            <span>{diff.modifiedLabel}</span>
          </div>
          {!listed && <div className="conflict-why">No {staged ? 'staged' : 'unstaged'} change left in this file.</div>}
          <div className="conflict-diff">
            <DiffEditor
              original={diff.original}
              modified={diff.modified}
              language={languageOf(path)}
              originalModelPath={left}
              modifiedModelPath={right}
              keepCurrentOriginalModel
              keepCurrentModifiedModel
              theme={theme === 'dark' ? 'forge-dark' : 'forge-light'}
              options={{
                readOnly: true,
                originalEditable: false,
                renderSideBySide: true,
                useInlineViewWhenSpaceIsLimited: true,
                minimap: { enabled: false },
                fontSize: 12.5,
                lineHeight: 20,
                fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
                scrollBeyondLastLine: false,
                renderOverviewRuler: false,
                automaticLayout: true
              }}
            />
          </div>
        </>
      )}
    </div>
  )
}
