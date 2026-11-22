// Unlimited-size Markdown / Rules / Pipeline document importer dialog on the Memory page.
// Zero external brand labels: neutral "Import Memory / Rules (.md)" UI.

import { useEffect, useState } from 'react'
import type { MarkdownImportItem, MemoryKind, MemoryScope } from '@shared/types'
import { Icon } from '../../components/Icons'
import { Dialog } from '../../shell/Overlays'
import { errorText } from '../../lib/format'
import { useActions } from '../../store'

const formatSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

export function MarkdownImportDialog({ projectOpen, onClose, onImported }: { projectOpen: boolean; onClose: () => void; onImported: () => void }) {
  const actions = useActions()
  const h = window.harness
  const [scope, setScope] = useState<MemoryScope>(projectOpen ? 'project' : 'user')
  const [defaultKind, setDefaultKind] = useState<MemoryKind>('memory')
  const [splitByHeadings, setSplitByHeadings] = useState(true)
  const [fileName, setFileName] = useState('')
  const [content, setContent] = useState('')
  const [items, setItems] = useState<MarkdownImportItem[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!content.trim()) {
      setItems([])
      return
    }
    let cancelled = false
    void h
      .memoryPreviewMarkdownImport({ content, fileName: fileName || undefined, splitByHeadings, defaultKind })
      .then((res) => {
        if (!cancelled) {
          setItems(res)
          setErr(null)
        }
      })
      .catch((e) => {
        if (!cancelled) setErr(errorText(e))
      })
    return () => {
      cancelled = true
    }
  }, [h, content, fileName, splitByHeadings, defaultKind])

  const onFilePick = async (files: FileList | null) => {
    const f = files?.[0]
    if (!f) return
    setFileName(f.name)
    setContent(await f.text())
  }

  const commit = async () => {
    if (!items.length) return
    setBusy(true)
    setErr(null)
    try {
      const res = await h.memoryCommitMarkdownImport(scope, items)
      const count = res.imported.length + res.updated.length
      actions.toast({
        text: `Imported ${count} ${count === 1 ? 'entry' : 'entries'} (${scope})`,
        detail: res.updated.length ? `${res.updated.length} updated` : undefined,
        kind: 'ok'
      })
      onImported()
      onClose()
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title="Import Memory / Rules (.md)" width={640} onClose={onClose}>
      <div className="pack-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="mini-btn" style={{ cursor: 'pointer' }}>
            <Icon name="upload" size={13} /> Choose .md file
            <input type="file" accept=".md,.markdown,.txt" style={{ display: 'none' }} onChange={(e) => void onFilePick(e.target.files)} />
          </label>
          {fileName && <span className="note mono">{fileName}</span>}
          <span className="grow" />
          <div className="seg" role="radiogroup" aria-label="Target scope">
            {(['project', 'user'] as MemoryScope[]).map((s) => (
              <button
                key={s}
                role="radio"
                aria-checked={scope === s}
                className={scope === s ? 'on' : ''}
                disabled={s === 'project' && !projectOpen}
                onClick={() => setScope(s)}
              >
                {s === 'project' ? 'Project' : 'User'}
              </button>
            ))}
          </div>
          <div className="seg" role="radiogroup" aria-label="Import kind">
            {(['memory', 'skill'] as MemoryKind[]).map((k) => (
              <button key={k} role="radio" aria-checked={defaultKind === k} className={defaultKind === k ? 'on' : ''} onClick={() => setDefaultKind(k)}>
                {k === 'memory' ? 'Memory' : 'Skill'}
              </button>
            ))}
          </div>
        </div>

        <label className="row" style={{ gap: 8, alignItems: 'center', fontSize: 12 }}>
          <input type="checkbox" checked={splitByHeadings} onChange={(e) => setSplitByHeadings(e.target.checked)} />
          <span>Split into separate entries by <code>## </code> headings</span>
          <span className="note">(uncheck to keep full document intact; no length limit)</span>
        </label>

        <textarea
          className="input mono"
          rows={7}
          value={content}
          placeholder="Paste MEMORY.md, rules, or pipeline documentation here, or pick a .md file above…"
          onChange={(e) => setContent(e.target.value)}
        />

        {items.length > 0 && (
          <div style={{ maxHeight: 190, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 6, padding: 8 }}>
            <div className="note" style={{ marginBottom: 6 }}>
              Preview: <strong>{items.length}</strong> {items.length === 1 ? 'entry' : 'entries'} ·{' '}
              {formatSize(items.reduce((sum, x) => sum + x.chars, 0))} total
            </div>
            {items.map((it) => (
              <div key={it.name} style={{ padding: '4px 0', borderTop: '1px solid var(--line)', fontSize: 12 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <code className="mono">{it.name}</code>
                  <span className="tag">{it.kind}</span>
                  <span className="faint" style={{ marginLeft: 'auto' }}>{formatSize(it.chars)}</span>
                </div>
                <div className="note ellipsis">{it.description}</div>
              </div>
            ))}
          </div>
        )}

        {err && <div className="callout err">{err}</div>}

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={() => void commit()} disabled={busy || !items.length}>
            <Icon name="check" size={13} /> Import {items.length || ''}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
