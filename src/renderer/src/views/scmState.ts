// Source control panel state and flows, outside React so the commit message survives switching side
// views and the palette's "Git: …" commands share them: the status (Staged / Changes / Merge
// conflicts), the commit message draft (kept per project in localStorage; main hears whether it is
// empty, so the auto-sync skips its commit while you type one), the step running, and the last error
// (the first line of git's output). Confirms go through the app's dialog, never window.confirm.
import { useSyncExternalStore } from 'react'
import type { ScmCommitOptions, ScmFile, ScmHeld, ScmResult, ScmStatus } from '@shared/types'
import type { Actions } from '../store'
import { errorText } from '../lib/format'
import { basename } from '../lib/roblox'

export type ScmStep = 'refresh' | 'stage' | 'unstage' | 'discard' | 'commit' | 'pull' | 'push' | 'fetch'

export interface ScmState {
  status: ScmStatus | null
  message: string
  busy: ScmStep | null
  error: string | null
  // Bumped to focus the message box (palette "Git: Commit" with no message).
  focusNonce: number
}

let state: ScmState = { status: null, message: '', busy: null, error: null, focusNonce: 0 }
const listeners = new Set<() => void>()
let root: string | null = null
let draftSent: boolean | null = null

function set(patch: Partial<ScmState>): void {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export const scmStore = {
  get: () => state,
  subscribe: (l: () => void) => {
    listeners.add(l)
    return () => listeners.delete(l)
  }
}

export function useScm(): ScmState {
  return useSyncExternalStore(scmStore.subscribe, scmStore.get)
}

const messageKey = (r: string) => `forge.scm.message:${r}`

// Main only hears whether the box is empty, and only when that changes.
function sendDraft(): void {
  const on = state.message.trim().length > 0
  if (draftSent === on) return
  draftSent = on
  void window.harness.scmSetDraft(on).catch(() => undefined)
}

export function setMessage(message: string): void {
  set({ message })
  try {
    if (root) {
      if (message) localStorage.setItem(messageKey(root), message)
      else localStorage.removeItem(messageKey(root))
    }
  } catch {
    // storage unavailable: the draft lives until the window closes
  }
  sendDraft()
}

let timer: ReturnType<typeof setTimeout> | null = null
let started = false

export async function refreshScm(): Promise<ScmStatus | null> {
  try {
    const status = await window.harness.scmStatus()
    set({ status })
    return status
  } catch {
    return state.status
  }
}

// Debounced: file watcher bursts and git:status pushes come in groups.
function soon(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    if (listeners.size) void refreshScm()
  }, 300)
}

function openProject(next: string | null): void {
  if (next === root) return
  root = next
  let message = ''
  try {
    message = next ? localStorage.getItem(messageKey(next)) ?? '' : ''
  } catch {
    message = ''
  }
  // A new GitSync starts without a draft: tell it again.
  draftSent = null
  set({ message, error: null, status: null })
  if (next) sendDraft()
  void refreshScm()
}

// Once per window: follows the project, git pushes and file changes.
export function startScm(): void {
  if (started) return
  started = true
  const h = window.harness
  void h.getProject().then((p) => openProject(p?.root ?? null)).catch(() => undefined)
  h.on('project:changed', (p) => openProject(p?.root ?? null))
  h.on('git:status', soon)
  h.on('files:changed', soon)
  window.addEventListener('focus', soon)
}

function apply(result: ScmResult): ScmResult {
  set({ status: result.status, error: result.error ?? null })
  return result
}

async function step(name: ScmStep, fn: () => Promise<ScmResult>): Promise<ScmResult | null> {
  if (state.busy && name !== 'refresh') return null
  set({ busy: name, error: null })
  try {
    return apply(await fn())
  } catch (e) {
    set({ error: errorText(e) })
    return null
  } finally {
    set({ busy: null })
  }
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const SHOWN = 12
const listOf = (paths: string[]) => (paths.length > SHOWN ? [...paths.slice(0, SHOWN), `… and ${paths.length - SHOWN} more`] : paths)

// The same warning the auto-commit logs: a guarded script left the disk outside Forge.
function heldBody(held: ScmHeld[], what: string): string {
  const one = held.length === 1
  return `${one ? `${held[0].path} (${held[0].why}) was` : `${held.length} guarded scripts were`} deleted outside Forge, with no copy in .forge/sync/trash. The auto-sync never commits ${one ? 'that delete' : 'those deletes'} on its own. ${what} To keep ${one ? 'the file' : 'them'}, cancel and Discard the change instead (restores it from git).`
}

export async function stage(actions: Actions, paths: string[] | 'all'): Promise<void> {
  const r = await step('stage', () => window.harness.scmStage(paths))
  if (!r?.held?.length) return
  const held = r.held
  actions.openDialog({
    kind: 'confirm',
    title: held.length === 1 ? `Stage the delete of ${basename(held[0].path)}?` : `Stage ${held.length} held deletes?`,
    body: heldBody(held, 'Staging it confirms the delete, like git rm.'),
    list: held.map((h) => `${h.path} (${h.why})`),
    confirm: 'Stage the delete',
    danger: true,
    run: () => void step('stage', () => window.harness.scmStage(held.map((h) => h.path), true))
  })
}

export function unstage(paths: string[] | 'all'): Promise<ScmResult | null> {
  return step('unstage', () => window.harness.scmUnstage(paths))
}

// Asks first; the copies land in .forge/sync/trash before anything is touched.
export function discard(actions: Actions, files: ScmFile[]): void {
  if (!files.length) return
  const untracked = files.filter((f) => f.letter === 'U').length
  const one = files.length === 1
  actions.openDialog({
    kind: 'confirm',
    title: one ? `Discard changes in ${basename(files[0].path)}?` : `Discard ${count(files.length, 'change')}?`,
    body: `${one ? (untracked ? 'This untracked file is removed.' : 'The file goes back to its last staged or committed version.') : `${untracked ? `${count(untracked, 'untracked file')} ${untracked === 1 ? 'is' : 'are'} removed; the` : 'The'} rest go back to their last staged or committed version.`} Forge keeps a copy of ${one ? 'it' : 'each file'} in .forge/sync/trash first. Staged changes stay.`,
    list: one ? undefined : listOf(files.map((f) => f.path)),
    confirm: one ? 'Discard' : `Discard ${files.length}`,
    danger: true,
    run: () =>
      void step('discard', () => window.harness.scmDiscard(files.map((f) => f.path))).then((r) => {
        if (r && !r.error && r.backups?.length) actions.toast({ text: `Discarded ${count(files.length, 'change')}`, detail: `Copies in ${r.backups.length === 1 ? r.backups[0] : `${r.backups[0].split('/').slice(0, 4).join('/')}/`}`, kind: 'ok', ms: 5000 })
      })
  })
}

async function commitNow(actions: Actions, message: string, options: ScmCommitOptions): Promise<void> {
  const r = await step('commit', () => window.harness.scmCommit(message, options))
  if (!r) return
  if (r.held?.length) {
    const held = r.held
    actions.openDialog({
      kind: 'confirm',
      title: held.length === 1 ? `Commit the delete of ${basename(held[0].path)}?` : `Commit ${held.length} held deletes?`,
      body: heldBody(held, 'Committing all changes includes the delete.'),
      list: held.map((h) => `${h.path} (${h.why})`),
      confirm: 'Commit with the delete',
      danger: true,
      run: () => void commitNow(actions, message, { ...options, confirmHeld: true })
    })
    return
  }
  if (!r.commit) return
  setMessage('')
  actions.toast({ text: `Committed ${r.commit}${options.push && !r.error ? ' and pushed' : ''}`, detail: message.split('\n')[0], kind: r.error ? 'info' : 'ok', ms: 3500 })
}

// Commit (Ctrl+Enter). Nothing staged: asks whether to commit every change.
export async function commit(actions: Actions, options: { push?: boolean } = {}): Promise<void> {
  const message = state.message.trim()
  if (!message) {
    set({ error: 'Type a commit message first.', focusNonce: state.focusNonce + 1 })
    return
  }
  const status = state.status ?? (await refreshScm())
  if (status && !status.staged.length && !status.conflicts.length && !status.merging) {
    if (!status.changes.length) {
      set({ error: 'No changes to commit.' })
      return
    }
    const n = status.changes.length
    actions.openDialog({
      kind: 'confirm',
      title: 'Commit all changes?',
      body: `Nothing is staged. Stage ${n === 1 ? 'the 1 change' : `all ${n} changes`} and commit ${n === 1 ? 'it' : 'them'}${options.push ? ', then push' : ''}?`,
      list: listOf(status.changes.map((f) => f.path)),
      confirm: options.push ? 'Commit all & push' : 'Commit all',
      run: () => void commitNow(actions, message, { all: true, push: options.push })
    })
    return
  }
  await commitNow(actions, message, { push: options.push })
}

export function focusMessage(): void {
  set({ focusNonce: state.focusNonce + 1 })
}

export async function pull(actions: Actions): Promise<void> {
  const r = await step('pull', () => window.harness.scmPull())
  if (r && !r.error) actions.toast({ text: 'Pulled', detail: r.status.upstream, kind: 'ok', ms: 2500 })
}

export async function push(actions: Actions): Promise<void> {
  const r = await step('push', () => window.harness.scmPush())
  if (r && !r.error) actions.toast({ text: 'Pushed', detail: r.status.upstream ?? r.status.branch, kind: 'ok', ms: 2500 })
}

export function fetchRemote(): Promise<ScmResult | null> {
  return step('fetch', () => window.harness.scmFetch())
}
