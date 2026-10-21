// FBX upload inbox settings (main/services/art/modelInbox.ts): the opt-in toggle, the sibling opt-in
// for Studio inserts from the same folder (modelInsert.ts), the folder with a Browse button, and the
// last few uploads and inserts. Shown in Art > Roblox import under the Open Cloud key and
// in Settings > Integrations. The key itself never reaches this page; it only learns whether one is set.
import { useEffect, useState } from 'react'
import type { ModelInboxStatus } from '@shared/types'
import { useStore } from '../../store'
import { errorText } from '../../lib/format'

// refresh: changes when the Open Cloud key or creator may have changed (the Art page passes its status).
export function ModelInboxSettings({ refresh }: { refresh?: unknown }) {
  const h = window.harness
  const { actions } = useStore()
  const [status, setStatus] = useState<ModelInboxStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void h.fbxInboxStatus().then(setStatus).catch(() => setStatus(null))
    // Recent uploads update as they finish.
    return h.on('fbxInbox:upload', () => void h.fbxInboxStatus().then(setStatus).catch(() => undefined))
  }, [refresh])

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

  if (!status) return null
  const custom = status.dir !== status.defaultDir
  return (
    <>
      <div className="set-row" id="set-model-inbox">
        <div className="set-text">
          <div className="set-title">Upload files dropped in the inbox</div>
          <div className="note">
            A <span className="mono">&lt;id&gt;.request.json</span> dropped in the inbox with its file is uploaded owned by the creator set
            in Art › Roblox import: <span className="mono">.fbx</span> as a Model, <span className="mono">.mp3 .ogg .wav .flac</span> as Audio, <span className="mono">.png .jpg .bmp .tga</span> as an Image (or a Decal with <span className="mono">"assetType": "Decal"</span>).
            Forge writes <span className="mono">&lt;id&gt;.result.json</span> with the asset id. Uploads go through Roblox moderation. Claude or other agents that can
            write to this folder can drop files there, so leave this off unless you want that.
          </div>
          {!status.robloxKey && <div className="note warn">Needs an Open Cloud API key (Art › Roblox import).</div>}
          {status.robloxKey && !status.creator && <div className="note warn">Set the creator (Art › Roblox import) or every upload fails.</div>}
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
            <span className="mono">ServerStorage.RBX_ANIMSAVES</span>) is inserted into the linked Studio place by the Forge Bridge plugin; Ctrl+Z in Studio undoes it. Forge writes{' '}
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
