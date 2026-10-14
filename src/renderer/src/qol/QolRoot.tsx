// Quality-of-life layer mounted once in the shell: renderer error capture, session save/restore,
// notification clicks, the bug report dialog and the "since you were away" digest.
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Digest } from '@shared/types'
import { restorePlan } from '@shared/qol/session'
import { useStore, type Layout, type PageKind } from '../store'
import { BugReportDialog } from './BugReportDialog'
import { AwayDigest } from './AwayDigest'
import { KNOWN_PAGES, navigate } from './navigate'
import { loadSession, setActiveChat, setLayoutState, setRoot, updateProject } from './sessionStore'
import './qol.css'

export const IDLE_MS = 60 * 60 * 1000
const SEEN_EVERY_MS = 5 * 60 * 1000

// Opens the bug report dialog from anywhere (titlebar, palette, Help menu): no import needed.
export function requestBugReport(): void {
  window.dispatchEvent(new CustomEvent('forge:report-bug'))
}

export function requestDigest(): void {
  window.dispatchEvent(new CustomEvent('forge:show-digest'))
}

function useErrorCapture(): void {
  useEffect(() => {
    let sent = 0
    let windowStart = Date.now()
    const report = (message: string, stack?: string) => {
      const now = Date.now()
      if (now - windowStart > 60_000) {
        windowStart = now
        sent = 0
      }
      if (++sent > 20) return
      void window.harness.qolReportError({ message, stack }).catch(() => undefined)
    }
    const onError = (e: ErrorEvent) => report(e.message || String(e.error), e.error?.stack)
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason
      report(`Unhandled rejection: ${r instanceof Error ? r.message : String(r)}`, r instanceof Error ? r.stack : undefined)
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])
}

// Restore once on start (first project), then keep the session file in step with the workbench.
function useSessionRestore(): void {
  const { state, actions } = useStore()
  const restored = useRef<'pending' | 'running' | 'done'>('pending')
  const [ready, setReady] = useState(false)
  const chatRestored = useRef(false)
  const root = state.project?.root ?? null

  useEffect(() => {
    setRoot(root)
  }, [root])

  useEffect(() => {
    if (restored.current !== 'pending') return
    // Wait for the first project (or a moment without one).
    const run = async () => {
      if (restored.current !== 'pending') return
      restored.current = 'running'
      try {
        const [session, settings] = await Promise.all([loadSession(), window.harness.qolGetSettings()])
        if (!settings.restore) return
        if (session.layout) actions.setLayout(session.layout as Partial<Layout>)
        const ps = root ? session.projects[root] : null
        if (!ps || !ps.tabs.length) return
        const files = ps.tabs.filter((t) => t.kind === 'file' && t.path).map((t) => t.path!)
        const checks = await Promise.all(files.map((p) => window.harness.readFile(p).then(() => p, () => null)))
        const exists = new Set(checks.filter((p): p is string => !!p))
        const cursorPaths = Object.keys(ps.cursors).filter((p) => !exists.has(p))
        // Cursors of files that are not open as tabs: keep them only when the file still exists.
        const cursorChecks = await Promise.all(cursorPaths.slice(0, 50).map((p) => window.harness.readFile(p).then(() => p, () => null)))
        for (const p of cursorChecks) if (p) exists.add(p)
        const plan = restorePlan(ps, { fileExists: (p) => exists.has(p), knownPages: KNOWN_PAGES, conflicts: new Set(state.studioConflicts.map((c) => c.path)) })
        updateProject({ cursors: plan.cursors })
        for (const t of plan.tabs) {
          if (t.kind === 'file') await actions.openFile(t.path!)
          else if (t.kind === 'conflict') actions.openConflict(t.path!)
          else actions.openPage(t.kind as PageKind)
        }
        if (plan.tabs.length && !plan.tabs.some((t) => t.id === 'forge')) actions.closeTab('forge')
        actions.activateTab(plan.activeTab)
      } catch {
        // A broken state file never blocks startup.
      } finally {
        restored.current = 'done'
        setReady(true)
      }
    }
    if (root) void run()
    else {
      // Main reopens the last project at startup; give it time before restoring without one.
      const t = setTimeout(() => void run(), 10_000)
      return () => clearTimeout(t)
    }
  }, [root])

  // The last chat comes back once the chat list is known.
  useEffect(() => {
    if (chatRestored.current || !state.chats.length) return
    chatRestored.current = true
    void loadSession().then(async (s) => {
      const settings = await window.harness.qolGetSettings().catch(() => null)
      if (settings?.restore === false) return
      const id = s.activeChatId
      if (id && !stateActiveChat() && state.chats.some((c) => c.id === id)) void actions.selectChat(id)
    })
  }, [state.chats.length])
  const activeChat = useRef(state.activeChatId)
  activeChat.current = state.activeChatId
  const stateActiveChat = () => activeChat.current

  useEffect(() => {
    if (!ready) return
    updateProject({ tabs: state.tabs.map((t) => ({ id: t.id, kind: t.kind, title: t.title, ...(t.path ? { path: t.path } : {}), ...(t.agentId ? { agentId: t.agentId } : {}) })), activeTab: state.activeTab })
  }, [state.tabs, state.activeTab, ready])

  useEffect(() => {
    if (!ready) return
    setLayoutState({ ...state.layout })
  }, [state.layout, ready])

  useEffect(() => {
    if (chatRestored.current) setActiveChat(state.activeChatId)
  }, [state.activeChatId])
}

function useDigest(): [Digest | null, () => void] {
  const { state } = useStore()
  const [digest, setDigest] = useState<Digest | null>(null)
  const root = state.project?.root ?? null
  const lastActive = useRef(Date.now())
  const lastSeen = useRef(0)
  const shownFor = useRef<string | null>(null)

  const show = async (reason: 'open' | 'idle', since?: number, again?: boolean) => {
    const d = await window.harness.qolDigest({ reason, since, again }).catch(() => null)
    setDigest(d)
  }
  const dismiss = () => {
    setDigest(null)
    lastSeen.current = Date.now()
    void window.harness.qolSeen().catch(() => undefined)
  }

  // Project open: give Forge Sync a few seconds to pull Studio first.
  useEffect(() => {
    if (!root || shownFor.current === root) return
    shownFor.current = root
    setDigest(null)
    const t = setTimeout(() => void show('open'), 3500)
    return () => clearTimeout(t)
  }, [root])

  // New Studio pulls while the card is up refresh it.
  useEffect(() => {
    if (!digest) return
    let t: ReturnType<typeof setTimeout> | null = null
    const off = window.harness.on('sync:entry', () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => void show(digest.reason, digest.reason === 'idle' ? digest.since : undefined, true), 2000)
    })
    return () => {
      off()
      if (t) clearTimeout(t)
    }
  }, [digest])

  // Back after an hour idle: show what happened meanwhile. Activity also moves "last seen" (throttled).
  useEffect(() => {
    const onActive = () => {
      const now = Date.now()
      const idleSince = lastActive.current
      lastActive.current = now
      if (!root) return
      if (now - idleSince > IDLE_MS) {
        void show('idle', idleSince)
        return
      }
      if (!digest && now - lastSeen.current > SEEN_EVERY_MS) {
        lastSeen.current = now
        void window.harness.qolSeen().catch(() => undefined)
      }
    }
    const events = ['pointerdown', 'keydown', 'wheel', 'focus'] as const
    for (const e of events) window.addEventListener(e, onActive, { passive: true })
    const onShow = () => void show('open', undefined, true)
    window.addEventListener('forge:show-digest', onShow)
    return () => {
      for (const e of events) window.removeEventListener(e, onActive)
      window.removeEventListener('forge:show-digest', onShow)
    }
  }, [root, digest])

  return [digest, dismiss]
}

// The digest is an inline banner at the top of the editor area (EditorArea's .qol-digest-slot), so
// it pushes the page down instead of covering its buttons. Floating card only if there is no slot.
function digestCard(card: ReactElement): ReactNode {
  const slot = document.querySelector('.qol-digest-slot')
  return slot ? createPortal(card, slot) : card
}

export function QolRoot() {
  const { actions } = useStore()
  const [bug, setBug] = useState<{ screenshot: boolean } | null>(null)
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  useErrorCapture()
  useSessionRestore()
  const [digest, dismiss] = useDigest()

  useEffect(() => {
    const open = async () => {
      // Screenshot first, so it shows the page and not this dialog.
      const r = await window.harness.qolBugReportStart().catch(() => ({ screenshot: false }))
      setBug(r)
    }
    const onEvent = () => void open()
    window.addEventListener('forge:report-bug', onEvent)
    const offs = [window.harness.on('qol:bugReport', onEvent), window.harness.on('qol:navigate', (target) => navigate(target, actionsRef.current))]
    return () => {
      window.removeEventListener('forge:report-bug', onEvent)
      offs.forEach((off) => off())
    }
  }, [])

  return (
    <>
      {digest && !bug && digestCard(<AwayDigest digest={digest} onDismiss={dismiss} />)}
      {bug && <BugReportDialog screenshot={bug.screenshot} onClose={() => setBug(null)} />}
    </>
  )
}
