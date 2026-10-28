// Editor area (SPEC §7.4): editor groups (split editor, up to four, VS Code style), each with its
// tabs, Roblox-path breadcrumbs, notices, then its active view. Drag a tab onto a group's edge to
// split, into a tab strip to move / reorder it (Alt or Ctrl: keep a copy of a file). Layout logic is
// pure in @shared/editorGroups; copy-vs-move rules in ./groupActions.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useStore, type Actions, type State, type Tab } from '../store'
import * as EG from '@shared/editorGroups'
import type { EditorGroup, LayoutNode } from '@shared/editorGroups'
import { dropTab, moveToOtherGroup, splitTab, canDuplicate, type DropTarget } from './groupActions'
import { Icon, type IconName } from '../components/Icons'
import { ClassIcon } from '../components/ClassIcon'
import { useMenu, type MenuEntry } from '../components/Menu'
import { CodeEditor, useEditorServices } from './CodeEditor'
import './editorGroups.css'
import { useProblems } from './problems'
import { instancePathOfFile, kindOfFile, realmOfFile, requireExpression, findNode } from '../lib/roblox'
import type { TreeNode } from '@shared/types'
import { keyHint } from '../lib/format'
import { ForgePage } from '../pages/ForgePage'
import { SettingsPage } from '../pages/settings/SettingsPage'
import { PackagesPage } from '../pages/PackagesPage'
import { ReleasePage } from '../pages/ReleasePage'
import { AnalyticsPage } from '../pages/AnalyticsPage'
import { ArtPage } from '../pages/art/ArtPage'
import { VfxLabPage } from '../pages/vfx/VfxLabPage'
import { ThumbLabPage } from '../pages/thumbs/ThumbLabPage'
import { AnimLabPage } from '../pages/anim/AnimLabPage'
import { AbilityPage } from '../pages/ability/AbilityPage'
import { UiMotionLabPage } from '../pages/uimotion/UiMotionLabPage'
import { ModelLabPage } from '../pages/model/ModelLabPage'
import { UiPreviewPage } from '../pages/uipreview/UiPreviewPage'
import { MemoryPage } from '../pages/memory/MemoryPage'
import { GroupChatsPage } from '../assistant/GroupChatsPage'
import { ConflictPage } from '../pages/ConflictPage'
import { GitDiffPage } from '../pages/GitDiffPage'
import { TranscriptPage } from '../pages/TranscriptPage'

const PAGE_ICON: Record<string, IconName> = { forge: 'hammer', settings: 'gear', packages: 'package', release: 'rocket', analytics: 'chart', art: 'image', vfx: 'sparkle', anim: 'figure', ability: 'bolt', thumbs: 'thumbnail', uimotion: 'tap', model: 'cube', uipreview: 'monitor', memory: 'memory', groups: 'round', conflict: 'diff', gitdiff: 'diff', transcript: 'bot' }

function TabGlyph({ tab }: { tab: Tab }) {
  if (tab.kind === 'file' && tab.path) {
    const kind = kindOfFile(tab.path)
    if (kind === 'File') return <Icon name="file" size={14} />
    return <ClassIcon className={kind === 'Blink' ? 'Blink' : kind} realm={realmOfFile(tab.path)} size={14} />
  }
  return <Icon name={PAGE_ICON[tab.kind] ?? 'file'} size={14} style={tab.kind === 'forge' ? { color: 'var(--ember-text)' } : undefined} />
}

// ---------------------------------------------------------------- tab dragging

interface DragState {
  tabId: string
  from: string
  title: string
  tab: Tab
  x: number
  y: number
  copy: boolean
  target: DropTarget | null
  // Screen box to highlight (zone) or the insertion bar (strip).
  box: { left: number; top: number; width: number; height: number } | null
}

let drag: DragState | null = null
const dragListeners = new Set<() => void>()
function setDrag(next: DragState | null): void {
  drag = next
  for (const l of dragListeners) l()
}
const subscribeDrag = (l: () => void) => {
  dragListeners.add(l)
  return () => dragListeners.delete(l)
}
// The click that ends a drag (pointer capture sends it to the dragged tab) is not a tab click.
let suppressClickUntil = 0

const ZONE_LABEL: Record<EG.DropZone, string> = { left: 'Split left', right: 'Split right', top: 'Split up', bottom: 'Split down', center: 'Move here' }

// What the pointer is over: a tab strip (insertion index) or a group's body (edge = split, centre =
// move). Null when the drop would change nothing.
function hitTest(state: State, x: number, y: number, tabId: string, from: string, copyKey: boolean): { target: DropTarget; box: DragState['box'] } | null {
  const tab = state.tabs.find((t) => t.id === tabId)
  const copy = copyKey && canDuplicate(tab)
  for (const el of document.querySelectorAll<HTMLElement>('.eg-group[data-group-id]')) {
    const r = el.getBoundingClientRect()
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue
    const gid = el.dataset.groupId!
    const group = EG.getGroup(state.editor, gid)
    if (!group) return null
    const strip = el.querySelector<HTMLElement>('.tabs')
    const sr = strip?.getBoundingClientRect()
    if (strip && sr && y <= sr.bottom) {
      const tabs = [...strip.querySelectorAll<HTMLElement>('.tab[data-tab-id]')]
      let index = tabs.findIndex((t) => {
        const tr = t.getBoundingClientRect()
        return x < tr.left + tr.width / 2
      })
      if (index < 0) index = tabs.length
      if (gid === from) {
        const cur = group.tabs.indexOf(tabId)
        if (index === cur || index === cur + 1) return null
      }
      const ref = tabs[index]?.getBoundingClientRect()
      const last = tabs[tabs.length - 1]?.getBoundingClientRect()
      const bx = ref ? ref.left : last ? last.right : sr.left + 2
      return { target: { kind: 'strip', group: gid, index }, box: { left: Math.max(sr.left, bx - 1), top: sr.top + 4, width: 2, height: sr.height - 8 } }
    }
    const top = sr ? sr.bottom : r.top
    const bw = r.width
    const bh = r.bottom - top
    if (bw <= 0 || bh <= 0) return null
    let zone = EG.dropZoneAt((x - r.left) / bw, (y - top) / bh)
    if (zone !== 'center') {
      const splitsItself = gid === from && !copy && group.tabs.length === 1
      if (splitsItself || !EG.canSplit(state.editor, { from, tabId, copy })) zone = 'center'
    }
    if (zone === 'center' && gid === from) return null
    const half = { left: r.left, top, width: bw, height: bh }
    if (zone === 'left') half.width = bw / 2
    if (zone === 'right') (half.left = r.left + bw / 2), (half.width = bw / 2)
    if (zone === 'top') half.height = bh / 2
    if (zone === 'bottom') (half.top = top + bh / 2), (half.height = bh / 2)
    const inset = 4
    return { target: { kind: 'zone', group: gid, zone }, box: { left: half.left + inset, top: half.top + inset, width: half.width - inset * 2, height: half.height - inset * 2 } }
  }
  return null
}

// Starts tracking a possible drag on pointer down; it becomes a drag after a few pixels.
function beginTabDrag(e: React.PointerEvent<HTMLElement>, tab: Tab, groupId: string, live: { current: { state: State; actions: Actions } }): void {
  if (e.button !== 0 || (e.target as HTMLElement).closest('.x')) return
  const el = e.currentTarget
  const pointerId = e.pointerId
  const sx = e.clientX
  const sy = e.clientY
  let started = false
  const update = (ev: PointerEvent | KeyboardEvent, x: number, y: number) => {
    const copy = ev.altKey || ev.ctrlKey || ev.metaKey
    const hit = hitTest(live.current.state, x, y, tab.id, groupId, copy)
    setDrag({ tabId: tab.id, from: groupId, title: tab.title, tab, x, y, copy: copy && canDuplicate(tab), target: hit?.target ?? null, box: hit?.box ?? null })
  }
  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return
      started = true
      try {
        el.setPointerCapture(pointerId)
      } catch {
        // Pointer already gone.
      }
      el.classList.add('drag-src')
      document.body.classList.add('eg-dragging')
    }
    update(ev, ev.clientX, ev.clientY)
  }
  const key = (ev: KeyboardEvent) => {
    if (!started) return
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      end()
    } else if (drag) update(ev, drag.x, drag.y)
  }
  const end = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', end)
    window.removeEventListener('keydown', key, true)
    window.removeEventListener('keyup', key, true)
    el.classList.remove('drag-src')
    document.body.classList.remove('eg-dragging')
    if (started) suppressClickUntil = Date.now() + 250
    setDrag(null)
  }
  const up = () => {
    const d = drag
    end()
    if (started && d?.target) dropTab(live.current.state, live.current.actions, d.tabId, d.from, d.target, d.copy)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', end)
  window.addEventListener('keydown', key, true)
  window.addEventListener('keyup', key, true)
}

// Drop preview: the highlighted half (or whole group), the insertion bar in a strip, and a chip
// following the pointer.
function DragLayer() {
  const d = useSyncExternalStore(subscribeDrag, () => drag)
  const [last, setLast] = useState<DragState['box']>(null)
  useEffect(() => {
    if (d?.box && d.target?.kind === 'zone') setLast(d.box)
  }, [d?.box?.left, d?.box?.top, d?.box?.width, d?.box?.height, d?.target?.kind])
  if (!d) return null
  const zone = d.target?.kind === 'zone' ? d.target.zone : null
  const box = zone ? d.box : last
  return createPortal(
    <>
      {box && (
        <div className={`eg-drop${zone ? ' on' : ''}`} style={{ left: box.left, top: box.top, width: box.width, height: box.height }} data-zone={zone ?? ''}>
          {zone && <span className="lbl">{d.copy && zone !== 'center' ? `${ZONE_LABEL[zone]} (copy)` : d.copy ? 'Open here too' : ZONE_LABEL[zone]}</span>}
        </div>
      )}
      {d.target?.kind === 'strip' && d.box && <div className="eg-insert" style={{ left: d.box.left, top: d.box.top, height: d.box.height }} />}
      <div className="eg-ghost" style={{ transform: `translate(${d.x + 14}px, ${d.y + 12}px)` }}>
        <TabGlyph tab={d.tab} />
        <span>{d.title}</span>
        {d.copy && <span className="plus">+</span>}
      </div>
    </>,
    document.body
  )
}

// ---------------------------------------------------------------- tab strip

function Tabs({ group, active, first, multi }: { group: EditorGroup; active: boolean; first: boolean; multi: boolean }) {
  const { state, actions } = useStore()
  const menu = useMenu()
  const [closing, setClosing] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const live = useRef({ state, actions })
  live.current = { state, actions }
  const tabs = group.tabs.map((id) => state.tabs.find((t) => t.id === id)).filter((t): t is Tab => !!t)

  const isDirty = (t: Tab) => {
    if (t.kind !== 'file') return false
    const f = state.files.find((x) => x.path === t.path)
    return !!f && f.current !== f.saved
  }
  // Closing a dirty file loses edits only when no other group still shows it.
  const losesEdits = (t: Tab) => isDirty(t) && EG.groupsWithTab(state.editor, t.id).length <= 1

  const close = (t: Tab) => {
    const doClose = () => {
      setClosing(t.id)
      setTimeout(() => {
        setClosing(null)
        actions.closeTab(t.id, group.id)
      }, 140)
    }
    if (losesEdits(t)) {
      actions.openDialog({ kind: 'confirm', title: `Close ${t.title} without saving?`, body: 'Your changes to this file will be lost.', confirm: 'Close without saving', danger: true, run: doClose })
    } else doClose()
  }

  const closeGroup = () => {
    const lost = tabs.filter(losesEdits)
    const run = () => actions.editorGroups((gs) => EG.closeGroup(gs, group.id))
    if (lost.length) actions.openDialog({ kind: 'confirm', title: `Close this group without saving ${lost.length === 1 ? lost[0].title : `${lost.length} files`}?`, body: 'Unsaved changes in this group will be lost.', confirm: 'Close without saving', danger: true, run })
    else run()
  }

  // Keep the active tab in view.
  useEffect(() => {
    const el = scrollRef.current?.querySelector('.tab.on') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [group.active])

  const tabMenu = (e: React.MouseEvent, t: Tab) => {
    const canSplitHere = EG.canSplit(state.editor, { from: group.id, tabId: t.id, copy: canDuplicate(t) })
    const alone = group.tabs.length === 1
    const items: MenuEntry[] = [
      { label: 'Close', hint: keyHint('mod+w'), onSelect: () => close(t) },
      { label: 'Close others', onSelect: () => actions.editorGroups((gs) => EG.closeOthers(gs, group.id, t.id, (id) => !tabs.some((x) => x.id === id && losesEdits(x)))) },
      { label: 'Close saved', onSelect: () => tabs.filter((x) => !losesEdits(x)).forEach((x) => actions.closeTab(x.id, group.id)) }
    ]
    if (t.preview) items.push({ label: 'Keep open', onSelect: () => actions.pinTab(t.id) })
    items.push(
      'separator',
      { label: 'Split right', icon: <Icon name="split" />, hint: keyHint('mod+backslash'), disabled: !canSplitHere || (alone && !canDuplicate(t)), reason: canSplitHere ? 'The only tab in this group' : `Up to ${EG.MAX_GROUPS} groups`, onSelect: () => splitTab(state, actions, t.id, group.id, 'right') },
      { label: 'Split down', icon: <Icon name="split" style={{ transform: 'rotate(90deg)' }} />, disabled: !canSplitHere || (alone && !canDuplicate(t)), reason: canSplitHere ? 'The only tab in this group' : `Up to ${EG.MAX_GROUPS} groups`, onSelect: () => splitTab(state, actions, t.id, group.id, 'bottom') },
      { label: multi ? 'Move to other group' : 'Move to new group', icon: <Icon name="arrowRight" />, disabled: !multi && alone, onSelect: () => moveToOtherGroup(state, actions, t.id, group.id) }
    )
    if (multi) items.push({ label: 'Close group', onSelect: closeGroup })
    if (t.path) {
      items.push('separator', { label: 'Copy file path', icon: <Icon name="copy" />, onSelect: () => void actions.copy(t.path!, 'file path') })
      const ip = instancePathOfFile(state.tree, t.path)
      if (ip) {
        items.push({ label: 'Copy require(…)', icon: <Icon name="code" />, onSelect: () => void actions.copy(requireExpression(ip), 'require') })
        items.push({ label: 'Reveal in Explorer', icon: <Icon name="reveal" />, hint: keyHint('alt+mod+r'), onSelect: () => actions.revealInstance(ip) })
      }
    }
    menu.openAt(e, items)
  }

  const overflow = (el: HTMLElement) => {
    menu.openUnder(el, [{ header: 'Open tabs' }, ...tabs.map((t) => ({ label: t.title, sub: t.path, checked: t.id === group.active, onSelect: () => actions.activateTab(t.id, group.id) }))], { minWidth: 260 })
  }

  const lonelyForge = state.tabs.length === 1 && !multi

  return (
    <div className="tabs" role="tablist" aria-label={multi ? `Editor group ${EG.groupOrder(state.editor).indexOf(group.id) + 1}` : undefined}>
      <div className="tabs-scroll" ref={scrollRef}>
        {tabs.map((t) => {
          const dirty = isDirty(t)
          const on = t.id === group.active
          return (
            <div
              key={t.id}
              role="tab"
              data-tab-id={t.id}
              aria-selected={on}
              className={`tab${on ? ' on' : ''}${dirty ? ' dirty' : ''}${t.preview ? ' preview' : ''}${closing === t.id ? ' closing' : ''}`}
              title={t.path ?? t.title}
              onClick={() => Date.now() > suppressClickUntil && actions.activateTab(t.id, group.id)}
              onDoubleClick={() => t.preview && actions.pinTab(t.id)}
              onPointerDown={(e) => beginTabDrag(e, t, group.id, live)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  close(t)
                }
              }}
              onContextMenu={(e) => tabMenu(e, t)}
            >
              <TabGlyph tab={t} />
              <span className="tname">{t.title}</span>
              {!(t.kind === 'forge' && lonelyForge) && (
                <button
                  className="x"
                  aria-label={`Close ${t.title}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    close(t)
                  }}
                >
                  {dirty && <span className="dirty-dot" />}
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
          )
        })}
      </div>
      <div className="tabs-fill">
        {tabs.length > 4 && (
          <button className="icon-btn" title="All open tabs" onClick={(e) => overflow(e.currentTarget)}>
            <Icon name="chevDown" size={14} />
          </button>
        )}
        {active && group.active && (
          <button
            className="icon-btn"
            title={`Split right (${keyHint('mod+backslash')}) · Alt: split down`}
            aria-label="Split editor"
            onClick={(e) => group.active && splitTab(state, actions, group.active, group.id, e.altKey ? 'bottom' : 'right')}
          >
            <Icon name="split" size={14} />
          </button>
        )}
        {first && (
          <button className="icon-btn" title={`Forge tab (${keyHint('mod+shift+h')})`} onClick={() => actions.openPage('forge')}>
            <Icon name="hammer" size={14} />
          </button>
        )}
      </div>
      {menu.node}
    </div>
  )
}

function Crumbs({ path, groupId }: { path: string; groupId: string }) {
  const { state, actions } = useStore()
  const problems = useProblems()
  const menu = useMenu()
  const file = state.files.find((f) => f.path === path)
  // Walks the whole tree; only the tree or the file changing needs it, not every keystroke.
  const { ip, segs } = useMemo(() => {
    const ip = instancePathOfFile(state.tree, path)
    const segs: { label: string; node?: TreeNode | null; ip?: string[] }[] = ip
      ? [{ label: 'game' }, ...ip.map((name, i) => ({ label: name, ip: ip.slice(0, i + 1), node: findNode(state.tree, ip.slice(0, i + 1)) }))]
      : path.split('/').map((p) => ({ label: p }))
    return { ip, segs }
  }, [state.tree, path])
  const realm = path.endsWith('.blink') ? 'blink' : realmOfFile(path)
  const dirty = !!file && file.current !== file.saved

  const siblings = (el: HTMLElement, segIp: string[]) => {
    const parent = segIp.length > 1 ? findNode(state.tree, segIp.slice(0, -1)) : null
    const list = parent ? parent.children : []
    if (!list.length) return actions.revealInstance(segIp)
    menu.openUnder(
      el,
      list.slice(0, 40).map((n) => ({
        label: n.name,
        icon: <ClassIcon className={n.className} size={14} />,
        checked: n.name === segIp[segIp.length - 1],
        onSelect: () => (n.filePath ? void actions.openFile(n.filePath) : actions.revealInstance([...segIp.slice(0, -1), n.name]))
      })),
      { minWidth: 220 }
    )
  }

  const fileProblems = problems.filter((p) => p.path === path)
  const errs = fileProblems.filter((p) => p.severity === 'error').length
  const lang = path.endsWith('.blink') ? 'Blink' : 'Luau'
  const tab = state.tabs.find((t) => t.kind === 'file' && t.path === path)

  return (
    <>
      <div className="crumbs">
        <div className="trail" title={path}>
          {segs.map((s, i) => {
            const last = i === segs.length - 1
            const node = s.node ?? null
            return (
              <span key={i} style={{ display: 'contents' }}>
                {i > 0 && <span className="sep">{ip ? '/' : '/'}</span>}
                <span className={`crumb${s.ip ? ' click' : ''}${last ? ' last' : ''}`} onClick={(e) => s.ip && siblings(e.currentTarget, s.ip)}>
                  {last && node && <ClassIcon className={node.className} realm={realmOfFile(path)} size={13} />}
                  {s.label}
                </span>
              </span>
            )
          })}
          {realm && <span className={`tag ${realm}`}>{realm}</span>}
        </div>
        <span className="right-meta">
          <button className={`badge-o crumb-lang ${errs ? 'err' : fileProblems.length ? 'warn' : ''}`} onClick={() => actions.showBottom('problems')} title={`${fileProblems.length} problem(s) in this file`}>
            {lang} {fileProblems.length}
          </button>
          <span className={`badge-o ${dirty ? 'warn' : 'ok'}`}>{dirty ? 'Unsaved' : 'Saved'}</span>
          <button className="badge-o crumb-opt" onClick={() => void actions.saveFile(path)} disabled={!dirty} title={`Save (${keyHint('mod+s')})`} aria-label="Save">
            <Icon name="download" size={12} />
          </button>
          <button className="badge-o crumb-opt" onClick={() => void actions.copy(path, 'file path')} title={`Copy ${path}`} aria-label="Copy file path">
            <Icon name="copy" size={12} />
          </button>
          {tab && (
            <button className="badge-o crumb-opt" onClick={() => actions.closeTab(tab.id, groupId)} title={`Close (${keyHint('mod+w')})`}>
              Close
            </button>
          )}
        </span>
      </div>
      {menu.node}
    </>
  )
}

function pageFor(tab: Tab): ReactNode {
  switch (tab.kind) {
    case 'forge':
      return <ForgePage />
    case 'settings':
      return <SettingsPage />
    case 'packages':
      return <PackagesPage />
    case 'release':
      return <ReleasePage />
    case 'analytics':
      return <AnalyticsPage />
    case 'art':
      return <ArtPage />
    case 'vfx':
      return <VfxLabPage />
    case 'anim':
      return <AnimLabPage />
    case 'ability':
      return <AbilityPage />
    case 'thumbs':
      return <ThumbLabPage />
    case 'uimotion':
      return <UiMotionLabPage />
    case 'model':
      return <ModelLabPage />
    case 'uipreview':
      return <UiPreviewPage />
    case 'memory':
      return <MemoryPage />
    case 'groups':
      return <GroupChatsPage />
    case 'conflict':
      return <ConflictPage path={tab.path!} />
    case 'gitdiff':
      return <GitDiffPage key={tab.id} path={tab.path!} staged={!!tab.staged} />
    case 'transcript':
      return <TranscriptPage agentId={tab.agentId!} title={tab.title} />
    default:
      return null
  }
}

// One editor group: its tab strip, then breadcrumbs / notices and the active view. The group's editor
// stays mounted under page tabs while the group has a file open.
function GroupView({ group, active, first, multi }: { group: EditorGroup; active: boolean; first: boolean; multi: boolean }) {
  const { state, actions } = useStore()
  const tab = state.tabs.find((t) => t.id === group.active) ?? state.tabs.find((t) => group.tabs.includes(t.id))
  const groupFiles = group.tabs.flatMap((id) => {
    const t = state.tabs.find((x) => x.id === id)
    return t?.kind === 'file' && t.path ? [t.path] : []
  })
  const activeFile = tab?.kind === 'file' ? tab.path ?? null : null
  // The last file shown in this group stays mounted under page tabs.
  const shown = useRef<string | null>(null)
  const filePath = activeFile ?? (shown.current && groupFiles.includes(shown.current) ? shown.current : groupFiles[0] ?? null)
  shown.current = filePath
  const fileVisible = tab?.kind === 'file'

  const outputs = state.blink?.files?.flatMap((m) => (m.outputs ? [{ src: m.file, ...m.outputs }] : [])) ?? (state.blink?.outputs ? [{ src: state.blink.file, ...state.blink.outputs }] : [])
  const generatedBy = filePath ? outputs.find((o) => o.client === filePath || o.server === filePath || o.types === filePath)?.src ?? null : null
  const conflict = filePath ? state.studioConflicts.find((c) => c.path === filePath) : undefined
  const page = tab && !fileVisible ? pageFor(tab) : null

  const focus = () => {
    if (!active) actions.editorGroups((gs) => EG.focusGroup(gs, group.id))
  }

  return (
    <section className={`eg-group${active ? ' active' : ''}`} data-group-id={group.id} onMouseDownCapture={focus} onFocusCapture={focus} aria-label={multi ? `Editor group ${EG.groupOrder(state.editor).indexOf(group.id) + 1}` : undefined}>
      <Tabs group={group} active={active} first={first} multi={multi} />
      {first && <div className="qol-digest-slot" />}
      {fileVisible && filePath && <Crumbs path={filePath} groupId={group.id} />}
      {fileVisible && generatedBy && (
        <div className="notice-bar" role="note">
          <Icon name="lock" size={12} />
          <span>
            Generated by Blink. Edit{' '}
            <button className="link-btn" onClick={() => generatedBy && void actions.openFile(generatedBy)}>
              {generatedBy ?? 'events.blink'}
            </button>{' '}
            instead.
          </span>
          <span className="grow" />
          <span className="tag">read-only</span>
        </div>
      )}
      {fileVisible && conflict && (
        <div className="notice-bar warn" role="note">
          <Icon name="studio" size={12} />
          <span>Studio has a different version of this script.</span>
          <span className="grow" />
          <button className="mini-btn" onClick={() => actions.openConflict(conflict.path)}>
            Compare
          </button>
        </div>
      )}
      {filePath && (
        <div className="view" style={fileVisible ? undefined : { display: 'none' }} key="editor">
          <div className="editor-host">
            <CodeEditor path={filePath} visible={fileVisible} active={active} groupId={group.id} readOnlyReason={generatedBy ? `Generated by Blink. Edit ${generatedBy} instead.` : null} />
          </div>
        </div>
      )}
      {page && tab && (
        <div className="view" key={tab.id}>
          {page}
        </div>
      )}
      {!tab && <div className="view eg-empty">Drop a tab here</div>}
    </section>
  )
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

// Groups and sashes as boxes (fractions of the editor area), so every group is a sibling keyed by
// id: splitting or closing a neighbour never remounts a group's editor or page, and the boxes can
// animate to their new places.
function layoutBoxes(root: LayoutNode): { groups: (Box & { id: string })[]; sashes: { path: number[]; index: number; dir: EG.SplitDir; at: number; split: Box }[] } {
  const groups: (Box & { id: string })[] = []
  const sashes: { path: number[]; index: number; dir: EG.SplitDir; at: number; split: Box }[] = []
  const walk = (n: LayoutNode, b: Box, path: number[]) => {
    if (n.type === 'group') return void groups.push({ id: n.id, ...b })
    let offset = 0
    n.children.forEach((c, i) => {
      const share = n.sizes[i]
      const cb = n.dir === 'row' ? { x: b.x + offset * b.w, y: b.y, w: share * b.w, h: b.h } : { x: b.x, y: b.y + offset * b.h, w: b.w, h: share * b.h }
      if (i > 0) sashes.push({ path, index: i - 1, dir: n.dir, at: n.dir === 'row' ? cb.x : cb.y, split: b })
      walk(c, cb, [...path, i])
      offset += share
    })
  }
  walk(root, { x: 0, y: 0, w: 1, h: 1 }, [])
  return { groups, sashes }
}

const pct = (v: number) => `${(v * 100).toFixed(4)}%`

// Drag handle between two groups: 300ms hover delay before the line lights up (like the panel
// resizers), double-click evens that split out.
function Sash({ path, index, dir, at, split }: { path: number[]; index: number; dir: EG.SplitDir; at: number; split: Box }) {
  const { state, actions } = useStore()
  const ref = useRef<HTMLDivElement>(null)
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = ref.current
    const grid = el?.parentElement
    const node = EG.nodeAt(state.editor.root, path)
    if (!el || !grid || !node || node.type !== 'split') return
    const rect = grid.getBoundingClientRect()
    const total = dir === 'row' ? rect.width * split.w : rect.height * split.h
    if (total <= 0) return
    const start = dir === 'row' ? e.clientX : e.clientY
    const sizes = node.sizes.slice()
    // At least 160px (and MIN_SIZE) on each side.
    const min = Math.max(EG.MIN_SIZE, 160 / total)
    el.classList.add('dragging')
    document.body.classList.add('resizing')
    document.body.style.setProperty('--resize-cursor', dir === 'row' ? 'col-resize' : 'row-resize')
    const move = (ev: PointerEvent) => {
      const delta = ((dir === 'row' ? ev.clientX : ev.clientY) - start) / total
      const a = sizes[index]
      const b = sizes[index + 1]
      const d = Math.max(Math.min(0, min - a), Math.min(Math.max(0, b - min), delta))
      const next = sizes.slice()
      next[index] = a + d
      next[index + 1] = b - d
      actions.editorGroups((gs) => EG.resizeSplit(gs, path, next))
    }
    const up = () => {
      el.classList.remove('dragging')
      document.body.classList.remove('resizing')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const even = () => {
    const node = EG.nodeAt(state.editor.root, path)
    if (node?.type === 'split') actions.editorGroups((gs) => EG.resizeSplit(gs, path, node.children.map(() => 1)))
  }
  const style = dir === 'row' ? { left: pct(at), top: pct(split.y), height: pct(split.h) } : { top: pct(at), left: pct(split.x), width: pct(split.w) }
  return <div ref={ref} className={`eg-sash ${dir}`} style={style} onPointerDown={onDown} onDoubleClick={even} role="separator" aria-orientation={dir === 'row' ? 'vertical' : 'horizontal'} />
}

export function EditorArea() {
  const { state } = useStore()
  useEditorServices()
  const multi = state.editor.groups.length > 1
  const firstGroup = EG.groupOrder(state.editor)[0]
  const { groups, sashes } = layoutBoxes(state.editor.root)
  return (
    <div className={`editor-area${multi ? ' multi' : ''}`}>
      <div className="eg-grid">
        {/* Stable order (by id) so React never reorders / remounts a group when the layout changes. */}
        {[...groups]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((b) => {
            const group = EG.getGroup(state.editor, b.id)
            if (!group) return null
            return (
              <div key={b.id} className={`eg-cell${b.x > 0 ? ' edge-l' : ''}${b.y > 0 ? ' edge-t' : ''}`} style={{ left: pct(b.x), top: pct(b.y), width: pct(b.w), height: pct(b.h) }}>
                <GroupView group={group} active={state.editor.activeGroup === group.id} first={group.id === firstGroup} multi={multi} />
              </div>
            )
          })}
        {sashes.map((sh) => (
          <Sash key={`${sh.path.join('.')}:${sh.index}`} {...sh} />
        ))}
      </div>
      <DragLayer />
    </div>
  )
}
