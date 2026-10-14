// Settings > Integrations > Figma: the personal access token the UI Motion Lab uses to import a
// Figma link. It is written once into main's encrypted secret store (safeStorage) and never comes
// back to the renderer: this page only learns whether one is set.
import { useEffect, useState } from 'react'
import type { FigmaTokenStatus } from '@shared/types'
import { useStore } from '../store'
import { errorText } from '../lib/format'

export function FigmaTokenSettings() {
  const h = window.harness
  const { actions } = useStore()
  const [status, setStatus] = useState<FigmaTokenStatus | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    void h.uiMotionFigmaToken().then(setStatus).catch(() => setStatus({ set: false, canStore: false }))
  }, [])

  const act = async (what: string, fn: () => Promise<void>) => {
    setBusy(what)
    try {
      await fn()
    } catch (e) {
      actions.toast({ text: 'Figma token', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="set-row" id="set-figma">
      <div className="set-text">
        <div className="set-title">Figma token</div>
        <div className="note">
          A personal access token (Figma › Settings › Security › Personal access tokens, scope <span className="mono">file_content:read</span>) lets the UI Motion Lab import
          a pasted Figma link. Stored encrypted in this computer's keychain, never in the project or a pack. The Figma plugin needs no token.
        </div>
        {result && <div className={`note ${result.ok ? 'ok' : 'err'}`}>{result.message}</div>}
      </div>
      <div className="set-ctl row">
        {status?.set ? (
          <>
            <span className="tag ok">set</span>
            <button className="btn small" disabled={!!busy} onClick={() => void act('test', async () => setResult(await h.uiMotionTestFigmaToken()))}>
              {busy === 'test' ? <span className="spinner" aria-hidden /> : null} Test
            </button>
            <button className="btn small danger" disabled={!!busy} onClick={() => void act('clear', async () => (setStatus(await h.uiMotionClearFigmaToken()), setResult(null)))}>
              Remove
            </button>
          </>
        ) : (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              if (draft.trim())
                void act('save', async () => {
                  setStatus(await h.uiMotionSetFigmaToken(draft.trim()))
                  setDraft('')
                  setResult(null)
                  actions.toast({ text: 'Figma token saved (encrypted)', kind: 'ok', ms: 2200 })
                })
            }}
          >
            <input className="input mono" type="password" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="figd_..." aria-label="Figma personal access token" disabled={status ? !status.canStore : false} />
            <button className="btn small" disabled={!draft.trim() || !!busy}>
              Save
            </button>
          </form>
        )}
        {status && !status.canStore && <span className="note warn">No OS keychain: Forge will not store tokens.</span>}
      </div>
    </div>
  )
}
