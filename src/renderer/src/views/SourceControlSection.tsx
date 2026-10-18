// Source control (top of the Source control & Sync view): the branch, its upstream and ahead/behind
// with Fetch / Pull / Push, the commit message box (Commit, Ctrl/Cmd+Enter; Commit & Push), and the
// changed files as Merge conflicts / Staged changes / Changes, VS Code style. A row opens its diff;
// its buttons open the file, stage, unstage or discard (asks first, keeps a copy in .forge/sync/trash).
// State and flows: scmState.ts (shared with the palette's "Git: …" commands).
import { useEffect, useRef, useState } from 'react'
import type { ScmFile } from '@shared/types'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { FileGlyph } from '../components/ClassIcon'
import { keyHint } from '../lib/format'
import { basename, dirname } from '../lib/roblox'
import { commit, discard, fetchRemote, pull, push, refreshScm, setMessage, stage, startScm, unstage, useScm } from './scmState'

type Group = 'conflicts' | 'staged' | 'changes'

// Rows shown per group before "show all" (a first sync can list thousands of files).
const ROWS = 200

let focusedNonce = 0

const LETTER_CLASS: Record<ScmFile['letter'], string> = { M: 'warn', T: 'warn', A: 'ok', U: 'ok', C: 'ok', D: 'err', R: 'info', '!': 'err' }

export function SourceControlSection() {
  const { actions } = useStore()
  const scm = useScm()
  const s = scm.status
  const box = useRef<HTMLTextAreaElement>(null)
  const [open, setOpen] = useState<Record<Group, boolean>>({ conflicts: true, staged: true, changes: true })
  const [all, setAll] = useState<Record<Group, boolean>>({ conflicts: false, staged: false, changes: false })

  useEffect(() => {
    startScm()
    void refreshScm()
  }, [])
  // A focus request (palette "Git: Commit" with no message) is handled once, also when it mounted this view.
  useEffect(() => {
    if (!scm.focusNonce || scm.focusNonce === focusedNonce || !box.current) return
    focusedNonce = scm.focusNonce
    box.current.focus()
  })

  if (!s?.isRepo) return null
  const busy = scm.busy
  const total = s.staged.length + s.changes.length + s.conflicts.length

  const openRow = (f: ScmFile, group: Group, pin = false) => {
    if (group === 'conflicts') void actions.openFile(f.path, { preview: !pin })
    else actions.openGitDiff(f.path, group === 'staged', { preview: !pin })
  }

  const row = (f: ScmFile, group: Group) => (
    <div
      key={`${group}:${f.path}`}
      className="lrow scm-row"
      title={`${f.from ? `${f.from} → ` : ''}${f.path}\n${f.label}`}
      onClick={() => openRow(f, group)}
      onDoubleClick={() => openRow(f, group, true)}
    >
      <FileGlyph path={f.path} size={14} />
      <span className={`scm-name ellipsis${f.letter === 'D' ? ' gone' : ''}`}>{basename(f.path)}</span>
      <span className="sub ellipsis grow">{f.from ? `${basename(f.from)} → ` : ''}{dirname(f.path)}</span>
      <span className="scm-acts" onClick={(e) => e.stopPropagation()}>
        {f.letter !== 'D' && (
          <button className="row-act" title="Open file" aria-label={`Open ${f.path}`} onClick={() => void actions.openFile(f.path)}>
            <Icon name="file" size={13} />
          </button>
        )}
        {group === 'conflicts' && (
          <button className="row-act" title="Ask the assistant to help resolve it" aria-label={`Ask about ${f.path}`} onClick={() => actions.ask(`Help me resolve the merge conflict in \`${f.path}\` `)}>
            <Icon name="bot" size={13} />
          </button>
        )}
        {group === 'changes' && (
          <button className="row-act" title="Discard changes" aria-label={`Discard ${f.path}`} disabled={!!busy} onClick={() => discard(actions, [f])}>
            <Icon name="undo" size={13} />
          </button>
        )}
        {group === 'staged' ? (
          <button className="row-act" title="Unstage" aria-label={`Unstage ${f.path}`} disabled={!!busy} onClick={() => void unstage([f.path])}>
            <Icon name="minus" size={13} />
          </button>
        ) : (
          <button className="row-act" title={group === 'conflicts' ? 'Stage (mark resolved)' : 'Stage'} aria-label={`Stage ${f.path}`} disabled={!!busy} onClick={() => void stage(actions, [f.path])}>
            <Icon name="plus" size={13} />
          </button>
        )}
      </span>
      <span className={`scm-letter ${LETTER_CLASS[f.letter]}`} aria-label={f.label}>{f.letter}</span>
    </div>
  )

  const group = (id: Group, title: string, files: ScmFile[], head?: React.ReactNode) => {
    if (!files.length) return null
    const shown = all[id] ? files : files.slice(0, ROWS)
    return (
      <div className="scm-group" data-group={id}>
        <div className="lrow static scm-ghead" onClick={() => setOpen({ ...open, [id]: !open[id] })}>
          <Icon name={open[id] ? 'chevDown' : 'chev'} size={12} />
          <span className="grow">{title}</span>
          <span className="scm-acts" onClick={(e) => e.stopPropagation()}>{head}</span>
          <span className="count">{files.length}</span>
        </div>
        {open[id] && shown.map((f) => row(f, id))}
        {open[id] && shown.length < files.length && (
          <button className="link-btn scm-more" onClick={() => setAll({ ...all, [id]: true })}>Show all {files.length}</button>
        )}
      </div>
    )
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
      e.preventDefault()
      e.stopPropagation()
      void commit(actions, { push: e.shiftKey })
    }
  }
  const nothing = !s.staged.length && !s.changes.length && !s.merging
  const pushLabel = s.upstream ? (s.ahead ? `Push ${s.ahead} commit${s.ahead === 1 ? '' : 's'} to ${s.upstream}` : `Push to ${s.upstream}`) : 'Publish this branch to origin'

  return (
    <section className="vsec scm" aria-label="Source control">
      <div className="scm-branch">
        <Icon name="branch" size={13} />
        <span className="mono ellipsis scm-bname" title={s.head ? `HEAD ${s.head}` : 'No commits yet'}>{s.branch ?? `detached${s.head ? ` at ${s.head}` : ''}`}</span>
        {s.upstream ? <span className="sub ellipsis scm-up" title={`Upstream: ${s.upstream}`}>→ {s.upstream}</span> : <span className="sub ellipsis scm-up">{s.hasRemote ? 'not published' : 'no remote'}</span>}
        <span className="grow" />
        {s.upstream && <span className="sub mono scm-ab" title={`${s.behind} to pull, ${s.ahead} to push`}>↓{s.behind} ↑{s.ahead}</span>}
        <button className="icon-btn" title="Fetch" aria-label="Fetch" disabled={!!busy || !s.hasRemote} onClick={() => void fetchRemote()}>
          <Icon name="sync" size={13} className={busy === 'fetch' ? 'spin' : undefined} />
        </button>
        <button className="icon-btn" title={s.staged.length ? 'Pull (fast-forward only while files are staged)' : 'Pull'} aria-label="Pull" disabled={!!busy || !s.hasRemote} onClick={() => void pull(actions)}>
          {busy === 'pull' ? <span className="spinner" /> : <Icon name="arrowDown" size={13} />}
        </button>
        <button className="icon-btn" title={pushLabel} aria-label="Push" disabled={!!busy || !s.hasRemote} onClick={() => void push(actions)}>
          {busy === 'push' ? <span className="spinner" /> : <Icon name="arrowUp" size={13} />}
        </button>
      </div>
      {(s.merging || s.rebasing) && <div className="note scm-line">{s.rebasing ? 'A rebase is in progress.' : 'Merging: fix the conflicts, stage them, then commit.'}</div>}
      <div className="textarea-box scm-box">
        <textarea
          ref={box}
          className="input"
          rows={2}
          value={scm.message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={onKey}
          placeholder={`Message (${keyHint('mod+enter')} to commit on ${s.branch ?? 'HEAD'})`}
          aria-label="Commit message"
          spellCheck
        />
        <div className="row scm-commit">
          <button className="btn primary grow" disabled={!!busy || nothing || !scm.message.trim()} onClick={() => void commit(actions)} title={`Commit${s.staged.length ? ` ${s.staged.length} staged file${s.staged.length === 1 ? '' : 's'}` : ''} (${keyHint('mod+enter')})`}>
            {busy === 'commit' ? <span className="spinner" /> : <Icon name="check" size={12} />} Commit
          </button>
          <button className="btn" disabled={!!busy || nothing || !scm.message.trim() || !s.hasRemote} onClick={() => void commit(actions, { push: true })} title={`Commit, then push (${keyHint('mod+shift+enter')})`}>
            Commit &amp; Push
          </button>
        </div>
        {scm.error && <div className="err-text scm-line" role="alert">{scm.error}</div>}
        {s.autoSync && <div className="note scm-line">{s.autoSync}</div>}
      </div>
      {group('conflicts', 'Merge conflicts', s.conflicts)}
      {group('staged', 'Staged changes', s.staged, (
        <button className="row-act" title="Unstage all" aria-label="Unstage all" disabled={!!busy} onClick={() => void unstage('all')}>
          <Icon name="minus" size={13} />
        </button>
      ))}
      {group('changes', 'Changes', s.changes, (
        <>
          <button className="row-act" title="Discard all changes" aria-label="Discard all changes" disabled={!!busy} onClick={() => discard(actions, s.changes)}>
            <Icon name="undo" size={13} />
          </button>
          <button className="row-act" title="Stage all changes" aria-label="Stage all changes" disabled={!!busy} onClick={() => void stage(actions, 'all')}>
            <Icon name="plus" size={13} />
          </button>
        </>
      ))}
      {!total && <div className="note scm-line">No changes.</div>}
    </section>
  )
}
