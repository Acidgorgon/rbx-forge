// Model / Media Inbox & Open Cloud settings (main/services/inbox/): Open Cloud API key (project
// or global), Roblox Creator ID (User ID or Group ID), upload inbox toggle, Studio insert toggle,
// inbox folder picker, and recent requests. Shown in Settings > Integrations.
import { useEffect, useState } from 'react'
import type { InboxCloudStatus, ModelInboxStatus } from '@shared/types'
import { useActions, useStorePick } from '../../store'
import { errorText } from '../../lib/format'

export function ModelInboxSettings({ refresh }: { refresh?: unknown }) {
  const h = window.harness
  const actions = useActions()
  const { project } = useStorePick('project')
  const [status, setStatus] = useState<ModelInboxStatus | null>(null)
  const [cloud, setCloud] = useState<InboxCloudStatus | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [scope, setScope] = useState<'global' | 'project'>(project ? 'project' : 'global')
  const [creatorKind, setCreatorKind] = useState<'user' | 'group'>('user')
  const [creatorIdInput, setCreatorIdInput] = useState('')
  const [busy, setBusy] = useState(false)

  const reloadAll = async () => {
    const [st, cl] = await Promise.all([
      h.fbxInboxStatus().catch(() => null),
      h.inboxCloudStatus().catch(() => null)
    ])
    setStatus(st)
    setCloud(cl)
    if (cl) {
      if (cl.creatorGroupId) {
        setCreatorKind('group')
        setCreatorIdInput(String(cl.creatorGroupId))
      } else if (cl.creatorUserId) {
        setCreatorKind('user')
        setCreatorIdInput(String(cl.creatorUserId))
      } else {
        setCreatorIdInput('')
      }
    }
  }

  useEffect(() => {
    void reloadAll()
    return h.on('fbxInbox:upload', () => void h.fbxInboxStatus().then(setStatus).catch(() => undefined))
  }, [refresh, project?.root])

  const act = async (fn: () => Promise<ModelInboxStatus>) => {
    setBusy(true)
    try {
      setStatus(await fn())
    } catch (e) {
      actions.toast({ text: 'FBX upload inbox', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }

  const saveKey = async () => {
    const k = keyInput.trim()
    if (!k) return
    setBusy(true)
    try {
      const next = await h.inboxSetRobloxKey(k, project ? scope : 'global')
      setCloud(next)
      setKeyInput('')
      setStatus(await h.fbxInboxStatus().catch(() => status))
      actions.toast({ text: 'Open Cloud API key saved', kind: 'ok', ms: 2000 })
    } catch (e) {
      actions.toast({ text: 'Could not save Open Cloud API key', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }

  const clearKey = async (target: 'project' | 'global') => {
    setBusy(true)
    try {
      const next = await h.inboxClearRobloxKey(target)
      setCloud(next)
      setStatus(await h.fbxInboxStatus().catch(() => status))
      actions.toast({ text: `Cleared ${target} Open Cloud API key`, kind: 'ok', ms: 2000 })
    } catch (e) {
      actions.toast({ text: 'Could not clear Open Cloud API key', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }

  const saveCreator = async () => {
    const raw = creatorIdInput.trim()
    const num = raw ? Number(raw) : null
    if (raw && (!Number.isInteger(num) || (num ?? 0) <= 0)) {
      actions.toast({ text: 'Invalid Creator ID', detail: 'Enter a positive whole number.', kind: 'err' })
      return
    }
    setBusy(true)
    try {
      const next = await h.inboxSetCreator(creatorKind === 'group' ? { groupId: num, userId: null } : { userId: num, groupId: null })
      setCloud(next)
      setStatus(await h.fbxInboxStatus().catch(() => status))
      actions.toast({ text: num ? 'Roblox creator saved' : 'Roblox creator cleared', kind: 'ok', ms: 2000 })
    } catch (e) {
      actions.toast({ text: 'Could not save creator ID', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }

  if (!status) return null
  const custom = status.dir !== status.defaultDir
  return (
    <>
      <div className="set-row" id="set-open-cloud-inbox">
        <div className="set-text">
          <div className="set-title">
            Roblox Open Cloud Assets key{' '}
            {cloud?.robloxKey && (
              <span className="badge-o ok" style={{ marginLeft: 6 }}>
                {cloud.robloxKeySource === 'release' ? 'from Release' : 'set'}
              </span>
            )}
          </div>
          <div className="note">
            Used for FBX, audio, image, and decal inbox uploads (needs <span className="mono">asset:read</span> + <span className="mono">asset:write</span>). Stored in the OS keychain; falls back to the Release Open Cloud key if unset.
          </div>
          <form
            className="row"
            style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}
            onSubmit={(e) => {
              e.preventDefault()
              void saveKey()
            }}
          >
            <input
              type="password"
              className="input grow"
              style={{ minWidth: 200 }}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="Paste Open Cloud API key..."
              spellCheck={false}
              autoComplete="off"
              aria-label="Inbox Open Cloud API key"
            />
            {project && (
              <select className="input" value={scope} onChange={(e) => setScope(e.target.value as 'project' | 'global')} aria-label="Open Cloud key scope">
                <option value="project">This project</option>
                <option value="global">Global</option>
              </select>
            )}
            <button type="submit" className="btn small primary" disabled={busy || !keyInput.trim()}>
              Save key
            </button>
            {cloud?.robloxKey && cloud.robloxKeySource === 'inbox' && (
              <>
                {project && (
                  <button type="button" className="btn small danger" disabled={busy} onClick={() => void clearKey('project')}>
                    Clear project
                  </button>
                )}
                <button type="button" className="btn small danger" disabled={busy} onClick={() => void clearKey('global')}>
                  Clear global
                </button>
              </>
            )}
          </form>
        </div>
      </div>

      <div className="set-row" id="set-open-cloud-creator">
        <div className="set-text">
          <div className="set-title">Roblox asset creator</div>
          <div className="note">Owner of uploaded Model/Audio/Image/Decal assets (your Roblox User ID or Group ID). Saved per project with global fallback.</div>
          <form
            className="row"
            style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}
            onSubmit={(e) => {
              e.preventDefault()
              void saveCreator()
            }}
          >
            <select className="input" value={creatorKind} onChange={(e) => setCreatorKind(e.target.value as 'user' | 'group')} aria-label="Creator type">
              <option value="user">User ID</option>
              <option value="group">Group ID</option>
            </select>
            <input
              type="text"
              className="input grow"
              style={{ minWidth: 160 }}
              value={creatorIdInput}
              onChange={(e) => setCreatorIdInput(e.target.value)}
              placeholder={creatorKind === 'group' ? 'e.g. 12345678' : 'e.g. 987654321'}
              spellCheck={false}
              aria-label="Roblox Creator ID"
            />
            <button type="submit" className="btn small" disabled={busy}>
              Save creator
            </button>
          </form>
        </div>
      </div>

      <div className="set-row" id="set-model-inbox">
        <div className="set-text">
          <div className="set-title">Upload files dropped in the inbox</div>
          <div className="note">
            A <span className="mono">&lt;id&gt;.request.json</span> dropped in the inbox with its file is uploaded owned by the Roblox asset creator above:{' '}
            <span className="mono">.fbx</span> as a Model, <span className="mono">.mp3 .ogg .wav .flac</span> as Audio, <span className="mono">.png .jpg .bmp .tga</span> as an Image (or a Decal with <span className="mono">"assetType": "Decal"</span>).
            Forge writes <span className="mono">&lt;id&gt;.result.json</span> with the asset id. Uploads go through Roblox moderation. Agents that can write to this folder can drop files there, so leave this off unless you want that.
          </div>
          {!status.robloxKey && <div className="note warn">Needs an Open Cloud API key (set above or in Release).</div>}
          {status.robloxKey && !status.creator && <div className="note warn">Set the Roblox asset creator ID above or every upload fails.</div>}
        </div>
        <div className="set-ctl">
          <input
            type="checkbox"
            className="switch"
            checked={status.enabled}
            disabled={busy || (!status.enabled && !status.robloxKey)}
            onChange={(e) => void act(() => h.fbxInboxSetSettings({ enabled: e.target.checked }))}
            aria-label="Upload files dropped in the inbox"
          />
        </div>
      </div>
      <div className="set-row" id="set-model-insert">
        <div className="set-text">
          <div className="set-title">Insert models dropped in the inbox into Studio</div>
          <div className="note">
            A <span className="mono">&lt;id&gt;.insert.json</span> naming an <span className="mono">.rbxm</span> or <span className="mono">.rbxmx</span> (and a parent such as{' '}
            <span className="mono">ServerStorage.Models</span>) is inserted into the linked Studio place by the Forge Bridge plugin; Ctrl+Z in Studio undoes it. Forge writes{' '}
            <span className="mono">&lt;id&gt;.insert.result.json</span> with the inserted paths. No Open Cloud key needed. Agents that can write to this folder can change your place, so
            leave this off unless you want that.
          </div>
        </div>
        <div className="set-ctl">
          <input
            type="checkbox"
            className="switch"
            checked={status.insertEnabled}
            disabled={busy}
            onChange={(e) => void act(() => h.fbxInboxSetSettings({ insert: e.target.checked }))}
            aria-label="Insert models dropped in the inbox into Studio"
          />
        </div>
      </div>
      <div className="set-row">
        <div className="set-text">
          <div className="set-title">Inbox folder</div>
          <div className="note mono" title={status.dir} style={{ overflowWrap: 'anywhere' }}>
            {status.dir}
          </div>
          <div className="note">Uploaded and inserted files must be in this folder or in {status.modelsDir}. Up to 20 MB each, one at a time.</div>
        </div>
        <div className="set-ctl row">
          <button className="btn small" disabled={busy} onClick={() => void act(() => h.fbxInboxChooseFolder())}>
            Browse…
          </button>
          {custom && (
            <button className="btn small" disabled={busy} onClick={() => void act(() => h.fbxInboxSetSettings({ dir: null }))} title={status.defaultDir}>
              Default
            </button>
          )}
        </div>
      </div>
      {status.recent.length > 0 && (
        <div className="set-row">
          <div className="set-text">
            <div className="set-title">Recent inbox requests</div>
            {status.recent.slice(0, 5).map((e) => (
              <div key={`${e.kind ?? 'upload'}-${e.id}-${e.at}`} className={`note${e.status === 'error' ? ' err' : ''}`}>
                <span className="mono">{e.name ?? e.id}</span>{' '}
                {e.status === 'error' ? `failed: ${e.error}` : e.kind === 'insert' ? `→ Studio ${(e.paths ?? []).join(', ')}` : `→ ${e.assetId}`}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
