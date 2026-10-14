// "Restate first" for the Labs: before compose, the brief's restatement (cheap tier) is shown as a
// card under the Make row; compose waits for "Yes, go" / an edit, or stops on Cancel. Briefs the
// setting or the heuristic skip go straight through.
import { useRef, useState, type ReactNode } from 'react'
import type { RestateLab, Restatement } from '@shared/types'
import { useStore } from '../store'
import { RestateCard } from './RestateCard'

// null = cancelled; {} = no card (skipped); { restatement } = confirmed.
export type GateResult = { restatement?: Restatement } | null

interface Pending {
  brief: string
  restatement: Restatement
  reason?: string
}

export function useRestateGate(lab: RestateLab): { gate: (brief: string) => Promise<GateResult>; node: ReactNode; waiting: boolean } {
  const { actions } = useStore()
  const [pending, setPending] = useState<Pending | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const resolver = useRef<((r: GateResult) => void) | null>(null)

  const finish = (r: GateResult) => {
    resolver.current?.(r)
    resolver.current = null
    setPending(null)
    setBusy(false)
  }

  const gate = async (brief: string): Promise<GateResult> => {
    setLoading(true)
    let restatement: Restatement | undefined
    let reason: string | undefined
    try {
      const r = await window.harness.restateBrief(lab, brief)
      restatement = r.restatement
      reason = r.reason
    } catch {
      restatement = undefined
    } finally {
      setLoading(false)
    }
    if (!restatement) return {}
    return new Promise<GateResult>((resolve) => {
      resolver.current?.(null)
      resolver.current = resolve
      setPending({ brief, restatement: restatement!, ...(reason ? { reason } : {}) })
    })
  }

  const confirm = async (edited?: Restatement) => {
    if (!pending) return
    setBusy(true)
    try {
      const r = await window.harness.restateConfirm({ kind: lab, request: pending.brief, draft: pending.restatement, ...(edited ? { confirmed: edited } : {}) })
      if (r.noted) actions.toast({ text: 'Noted your correction', detail: 'Saved to memory (restate-corrections-labs), so the next reading follows your phrasing.', kind: 'info', ms: 3500 })
      finish({ restatement: r.confirmed })
    } catch {
      finish({ restatement: edited ?? pending.restatement })
    }
  }

  const node = pending ? (
    <div className="rs-gate">
      <RestateCard restatement={pending.restatement} kind={lab} reason={pending.reason} busy={busy} onConfirm={(e) => void confirm(e)} onCancel={() => finish(null)} />
    </div>
  ) : loading ? (
    <div className="rs-gate rs-loading note" role="status">
      <span className="spinner" aria-hidden /> reading the brief…
    </div>
  ) : null

  return { gate, node, waiting: !!pending || loading }
}
