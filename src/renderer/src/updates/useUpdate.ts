// Shared self-update state for the status bar pill and Settings > Updates. One subscription to
// 'update:state' for the whole renderer; components read it with useUpdate().
import { useCallback, useSyncExternalStore } from 'react'
import type { UpdateState } from '@shared/types'
import { useStore } from '../store'
import { errorText } from '../lib/format'
import { restartBlockers } from './blockers'

let current: UpdateState | null = null
const listeners = new Set<() => void>()
let started = false

function publish(next: UpdateState): void {
  current = next
  for (const l of listeners) l()
}

function ensureStarted(): void {
  if (started || typeof window === 'undefined' || !window.harness) return
  started = true
  window.harness.on('update:state', publish)
  void window.harness.updateGetState().then((s) => current ?? publish(s)).catch(() => undefined)
}

function subscribe(listener: () => void): () => void {
  ensureStarted()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useUpdate(): UpdateState | null {
  return useSyncExternalStore(subscribe, () => current, () => null)
}

export function setUpdateState(next: UpdateState): void {
  publish(next)
}

// Restart into a downloaded update; asks first when that would interrupt work.
export function useRestartForUpdate(): () => void {
  const { state, actions } = useStore()
  return useCallback(() => {
    const version = current?.offer?.version ?? 'the update'
    const go = () => {
      actions.toast({ text: `Restarting into ${version}...`, kind: 'info', ms: 4000 })
      void window.harness.updateInstall().catch((e) => actions.toast({ text: 'Could not install the update', detail: errorText(e), kind: 'err' }))
    }
    const blockers = restartBlockers({ files: state.files, busy: state.busy, agents: state.agents, boards: state.boards, testsRunning: state.tests.running })
    if (!blockers.length) return go()
    actions.openDialog({
      kind: 'confirm',
      title: `Restart into ${version} now?`,
      body: `${blockers.join('; ')}. Restarting stops running work and drops unsaved edits. You can also keep working: the update installs the next time you quit Forge.`,
      confirm: 'Restart anyway',
      danger: true,
      run: go
    })
  }, [state.files, state.busy, state.agents, state.boards, state.tests.running, actions])
}
