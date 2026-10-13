// New project: name, parent folder (picker), template (GenTree or an empty Rojo project), optional
// collaborator remote, git and first-setup options; live steps while main/setup.ts creates it, then
// the new project opens.
import { useEffect, useState } from 'react'
import type { NewProjectProgress, NewProjectStepId, TemplateId } from '@shared/types'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { Dialog } from '../shell/Overlays'
import { errorText, keyHint } from '../lib/format'
import './setup.css'

const STEPS: { id: NewProjectStepId; label: string }[] = [
  { id: 'fetch', label: 'Fetch the template' },
  { id: 'prepare', label: 'Remove the template history' },
  { id: 'rename', label: 'Name the project' },
  { id: 'git', label: 'git init + first commit' },
  { id: 'rokit', label: 'Install pinned tools (rokit)' },
  { id: 'wally', label: 'Install packages (wally)' },
  { id: 'blink', label: 'Compile network events (Blink)' }
]

// Same rules as main's validateProjectName (services/setup/newProject.ts).
export function projectNameProblem(name: string): string | null {
  const value = name.trim()
  if (!value) return null
  if (value.length > 80) return 'Keep the name under 80 characters.'
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(value)) return 'The name cannot contain < > : " / \\ | ? or *.'
  if (value === '.' || value === '..' || /[. ]$/.test(value) || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(value)) return 'That name cannot be used as a folder name.'
  return null
}

function joinPath(dir: string, name: string): string {
  if (!dir) return name
  const sep = /\\/.test(dir) && !/\//.test(dir) ? '\\' : '/'
  return dir.replace(/[\\/]+$/, '') + sep + name
}

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const { actions } = useStore()
  const [name, setName] = useState('')
  const [parentDir, setParentDir] = useState('')
  const [template, setTemplate] = useState<TemplateId>('gentree')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [initGit, setInitGit] = useState(true)
  const [firstSetup, setFirstSetup] = useState(true)
  const [gitAvailable, setGitAvailable] = useState(true)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<Partial<Record<NewProjectStepId, NewProjectProgress>>>({})
  const [notes, setNotes] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.harness.newProjectDefaults().then((d) => {
      setParentDir((p) => p || d.parentDir)
      setGitAvailable(d.gitAvailable)
      if (!d.gitAvailable) setInitGit(false)
    }).catch(() => undefined)
    return window.harness.on('newProject:progress', (p) => setProgress((x) => ({ ...x, [p.step]: p })))
  }, [])

  const problem = projectNameProblem(name)
  const ready = !!name.trim() && !problem && !!parentDir.trim() && !running
  const browse = async () => {
    const picked = await window.harness.chooseFolder('Where should the project folder go?', parentDir || undefined).catch(() => null)
    if (picked) setParentDir(picked)
  }
  const submit = async () => {
    if (!ready) return
    setRunning(true)
    setError(null)
    setNotes(null)
    setProgress({})
    try {
      const r = await window.harness.createProject({ name: name.trim(), parentDir: parentDir.trim(), template, remoteUrl: remoteUrl.trim() || undefined, initGit, firstSetup })
      setNotes(r.notes)
      await window.harness.openProject(r.root)
      actions.openPage('forge')
      actions.toast({ text: `Created ${r.projectName}`, detail: r.notes.length ? r.notes.join(' ') : r.root, kind: 'ok', ms: r.notes.length ? 0 : 6000 })
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setRunning(false)
    }
  }

  const started = running || Object.keys(progress).length > 0
  return (
    <Dialog title="New project" onClose={running ? () => undefined : onClose} width={540}>
      <p>Creates a Roblox game folder from a template, makes it your own repository and installs its tools.</p>
      <div className="col-form" onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && void submit()}>
        <div className="grid2">
          <label className="field">
            <span>Project name</span>
            <input className="input" autoFocus value={name} placeholder="MyGame" onChange={(e) => setName(e.target.value)} disabled={running} spellCheck={false} aria-invalid={!!problem} />
          </label>
          <label className="field">
            <span>Parent folder</span>
            <div className="np-pick">
              <input className="input mono" value={parentDir} placeholder="~/Roblox" onChange={(e) => setParentDir(e.target.value)} disabled={running} spellCheck={false} />
              <button type="button" className="btn" onClick={() => void browse()} disabled={running} title="Choose a folder"><Icon name="folder" size={13} /></button>
            </div>
          </label>
        </div>
        {problem ? <div className="err-text">{problem}</div> : name.trim() && parentDir.trim() ? <div className="np-path mono">{joinPath(parentDir.trim(), name.trim())}</div> : null}
        <div className="field">
          <span>Template</span>
          <div className="np-templates" role="radiogroup" aria-label="Template">
            <button type="button" role="radio" aria-checked={template === 'gentree'} className={`np-template${template === 'gentree' ? ' on' : ''}`} onClick={() => setTemplate('gentree')} disabled={running}>
              <span className="np-t"><Icon name="trio" size={13} /> GenTree</span>
              <span className="np-d">Features, Controllers, ModuleLoader, Blink events, Wally packages and the dev loop.</span>
            </button>
            <button type="button" role="radio" aria-checked={template === 'empty'} className={`np-template${template === 'empty' ? ' on' : ''}`} onClick={() => setTemplate('empty')} disabled={running}>
              <span className="np-t"><Icon name="folder" size={13} /> Empty Rojo project</span>
              <span className="np-d">shared / server / client folders and a rokit.toml pinning rojo. Nothing else.</span>
            </button>
          </div>
        </div>
        <label className="field">
          <span>Collaborator git remote (optional)</span>
          <input className="input mono" value={remoteUrl} placeholder="https://github.com/team/game.git" onChange={(e) => setRemoteUrl(e.target.value)} disabled={running || !initGit} spellCheck={false} />
        </label>
        <div className="np-opts">
          <label>
            <input type="checkbox" checked={initGit} onChange={(e) => setInitGit(e.target.checked)} disabled={running || !gitAvailable} />
            Set up git (new repository, first commit{remoteUrl.trim() ? ', origin remote' : ''})
          </label>
          {!gitAvailable && <div className="note">Git is not installed. See Settings &gt; Toolchain.</div>}
          <label>
            <input type="checkbox" checked={firstSetup} onChange={(e) => setFirstSetup(e.target.checked)} disabled={running} />
            Run first setup (rokit install, wally install, Blink compile)
          </label>
        </div>
      </div>
      {started && (
        <div className="steps" aria-live="polite">
          {STEPS.filter((s) => template === 'gentree' || (s.id !== 'wally' && s.id !== 'blink')).map((s) => {
            const p = progress[s.id]
            return (
              <div key={s.id} className={`step ${p?.state ?? 'idle'}`}>
                {p?.state === 'running' ? <span className="spinner" /> : p?.state === 'done' ? <Icon name="check" size={14} /> : p?.state === 'failed' ? <Icon name="err" size={14} /> : p?.state === 'skipped' ? <Icon name="arrowRight" size={14} /> : <span className="led idle" />}
                <span className="grow">{s.label}</span>
                {p?.message && <span className="faint mono ellipsis" style={{ maxWidth: 230, fontSize: 11 }} title={p.message}>{p.message}</span>}
                {p?.state === 'running' && p.percent !== undefined && <span className="np-pct mono">{p.percent}%</span>}
              </div>
            )
          })}
        </div>
      )}
      {notes && notes.length > 0 && <div className="note">{notes.map((n, i) => <div key={i}>{n}</div>)}</div>}
      {error && <div className="err-text" style={{ marginTop: 8 }}>{error}</div>}
      <div className="actions">
        <button className="btn ghost" onClick={onClose} disabled={running}>Cancel</button>
        <button className="btn primary" disabled={!ready} onClick={() => void submit()}>
          {running && <span className="spinner" />} Create project <kbd>{keyHint('mod+enter')}</kbd>
        </button>
      </div>
    </Dialog>
  )
}
