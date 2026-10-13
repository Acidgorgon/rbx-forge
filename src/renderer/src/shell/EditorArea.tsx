// Editor area (SPEC §7.4): tabs, Roblox-path breadcrumbs, notices, then the active view.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useStore, type Tab } from '../store'
import { Icon, type IconName } from '../components/Icons'
import { ClassIcon } from '../components/ClassIcon'
import { useMenu, type MenuEntry } from '../components/Menu'
import { CodeEditor } from './CodeEditor'
import { useProblems } from './problems'
import { instancePathOfFile, kindOfFile, realmOfFile, requireExpression, findNode } from '../lib/roblox'
import { keyHint } from '../lib/format'
import { ForgePage } from '../pages/ForgePage'
import { SettingsPage } from '../pages/SettingsPage'
import { PackagesPage } from '../pages/PackagesPage'
import { ReleasePage } from '../pages/ReleasePage'
import { AnalyticsPage } from '../pages/AnalyticsPage'
import { ArtPage } from '../pages/art/ArtPage'
import { VfxLabPage } from '../pages/vfx/VfxLabPage'
import { UiPreviewPage } from '../pages/uipreview/UiPreviewPage'
import { MemoryPage } from '../pages/memory/MemoryPage'
import { GroupChatsPage } from '../assistant/GroupChatsPage'
import { ConflictPage } from '../pages/ConflictPage'
import { TranscriptPage } from '../pages/TranscriptPage'

const PAGE_ICON: Record<string, IconName> = { forge: 'hammer', settings: 'gear', packages: 'package', release: 'rocket', analytics: 'chart', art: 'image', vfx: 'sparkle', uipreview: 'monitor', memory: 'memory', groups: 'round', conflict: 'diff', transcript: 'bot' }

function TabGlyph({ tab }: { tab: Tab }) {
  if (tab.kind === 'file' && tab.path) {
    const kind = kindOfFile(tab.path)
    if (kind === 'File') return <Icon name="file" size={14} />
    return <ClassIcon className={kind === 'Blink' ? 'Blink' : kind} realm={realmOfFile(tab.path)} size={14} />
  }
  return <Icon name={PAGE_ICON[tab.kind] ?? 'file'} size={14} style={tab.kind === 'forge' ? { color: 'var(--ember-text)' } : undefined} />
}

function Tabs() {
  const { state, actions } = useStore()
  const menu = useMenu()
  const [closing, setClosing] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const isDirty = (t: Tab) => {
    if (t.kind !== 'file') return false
    const f = state.files.find((x) => x.path === t.path)
    return !!f && f.current !== f.saved
  }

  const close = (t: Tab) => {
    const doClose = () => {
      setClosing(t.id)
      setTimeout(() => {
        setClosing(null)
        actions.closeTab(t.id)
      }, 140)
    }
    if (isDirty(t)) {
      actions.openDialog({ kind: 'confirm', title: `Close ${t.title} without saving?`, body: 'Your changes to this file will be lost.', confirm: 'Close without saving', danger: true, run: doClose })
    } else doClose()
  }

  // Keep the active tab in view.
  useEffect(() => {
    const el = scrollRef.current?.querySelector('.tab.on') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [state.activeTab])

  const tabMenu = (e: React.MouseEvent, t: Tab) => {
    const items: MenuEntry[] = [
      { label: 'Close', hint: keyHint('mod+w'), onSelect: () => close(t) },
      { label: 'Close others', onSelect: () => state.tabs.filter((x) => x.id !== t.id && !isDirty(x)).forEach((x) => actions.closeTab(x.id)) },
      { label: 'Close saved', onSelect: () => state.tabs.filter((x) => !isDirty(x)).forEach((x) => actions.closeTab(x.id)) }
    ]
    if (t.preview) items.push({ label: 'Keep open', onSelect: () => actions.pinTab(t.id) })
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
    menu.openUnder(el, [{ header: 'Open tabs' }, ...state.tabs.map((t) => ({ label: t.title, sub: t.path, checked: t.id === state.activeTab, onSelect: () => actions.activateTab(t.id) }))], { minWidth: 260 })
  }

  return (
    <div className="tabs" role="tablist">
      <div className="tabs-scroll" ref={scrollRef}>
        {state.tabs.map((t) => {
          const dirty = isDirty(t)
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === state.activeTab}
              className={`tab${t.id === state.activeTab ? ' on' : ''}${dirty ? ' dirty' : ''}${t.preview ? ' preview' : ''}${closing === t.id ? ' closing' : ''}`}
              title={t.path ?? t.title}
              onClick={() => actions.activateTab(t.id)}
              onDoubleClick={() => t.preview && actions.pinTab(t.id)}
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
              {!(t.kind === 'forge' && state.tabs.length === 1) && (
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
        {state.tabs.length > 4 && (
          <button className="icon-btn" title="All open tabs" onClick={(e) => overflow(e.currentTarget)}>
            <Icon name="chevDown" size={14} />
          </button>
        )}
        <button className="icon-btn" title={`Forge tab (${keyHint('mod+shift+h')})`} onClick={() => actions.openPage('forge')}>
          <Icon name="hammer" size={14} />
        </button>
      </div>
      {menu.node}
    </div>
  )
}

function Crumbs({ path }: { path: string }) {
  const { state, actions } = useStore()
  const problems = useProblems()
  const menu = useMenu()
  const file = state.files.find((f) => f.path === path)
  const ip = instancePathOfFile(state.tree, path)
  const realm = path.endsWith('.blink') ? 'blink' : realmOfFile(path)
  const dirty = !!file && file.current !== file.saved
  const segs: { label: string; node?: ReactNode; ip?: string[] }[] = ip
    ? [{ label: 'game' }, ...ip.map((name, i) => ({ label: name, ip: ip.slice(0, i + 1) }))]
    : path.split('/').map((p) => ({ label: p }))

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
    <div className="crumbs">
      <div className="trail" title={path}>
        {segs.map((s, i) => {
          const last = i === segs.length - 1
          const node = s.ip ? findNode(state.tree, s.ip) : null
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
        <button className={`badge-o ${errs ? 'err' : fileProblems.length ? 'warn' : ''}`} onClick={() => actions.showBottom('problems')} title={`${fileProblems.length} problem(s) in this file`}>
          {lang} {fileProblems.length}
        </button>
        <span className={`badge-o ${dirty ? 'warn' : 'ok'}`}>{dirty ? 'Unsaved' : 'Saved'}</span>
        <button className="badge-o" onClick={() => void actions.saveFile(path)} disabled={!dirty} title={`Save (${keyHint('mod+s')})`} aria-label="Save">
          <Icon name="download" size={12} />
        </button>
        <button className="badge-o" onClick={() => void actions.copy(path, 'file path')} title={`Copy ${path}`} aria-label="Copy file path">
          <Icon name="copy" size={12} />
        </button>
        {tab && (
          <button className="badge-o" onClick={() => actions.closeTab(tab.id)} title={`Close (${keyHint('mod+w')})`}>
            Close
          </button>
        )}
      </span>
      {menu.node}
    </div>
  )
}

export function EditorArea() {
  const { state, actions } = useStore()
  const tab = state.tabs.find((t) => t.id === state.activeTab) ?? state.tabs[0]
  // The last file shown stays mounted under page tabs.
  const [shownPath, setShownPath] = useState<string | null>(null)
  useEffect(() => {
    if (state.activeFile) setShownPath(state.activeFile)
    else if (shownPath && !state.files.some((f) => f.path === shownPath)) setShownPath(state.files[0]?.path ?? null)
  }, [state.activeFile, state.files])
  const filePath = state.activeFile ?? (shownPath && state.files.some((f) => f.path === shownPath) ? shownPath : null)
  const fileVisible = tab?.kind === 'file'

  const outputs = state.blink?.files?.flatMap((m) => (m.outputs ? [{ src: m.file, ...m.outputs }] : [])) ?? (state.blink?.outputs ? [{ src: state.blink.file, ...state.blink.outputs }] : [])
  const generatedBy = filePath ? outputs.find((o) => o.client === filePath || o.server === filePath || o.types === filePath)?.src ?? null : null
  const conflict = filePath ? state.studioConflicts.find((c) => c.path === filePath) : undefined

  let page: ReactNode = null
  if (tab && !fileVisible) {
    switch (tab.kind) {
      case 'forge':
        page = <ForgePage />
        break
      case 'settings':
        page = <SettingsPage />
        break
      case 'packages':
        page = <PackagesPage />
        break
      case 'release':
        page = <ReleasePage />
        break
      case 'analytics':
        page = <AnalyticsPage />
        break
      case 'art':
        page = <ArtPage />
        break
      case 'vfx':
        page = <VfxLabPage />
        break
      case 'uipreview':
        page = <UiPreviewPage />
        break
      case 'memory':
        page = <MemoryPage />
        break
      case 'groups':
        page = <GroupChatsPage />
        break
      case 'conflict':
        page = <ConflictPage path={tab.path!} />
        break
      case 'transcript':
        page = <TranscriptPage agentId={tab.agentId!} title={tab.title} />
        break
    }
  }

  return (
    <div className="editor-area">
      <Tabs />
      {fileVisible && filePath && <Crumbs path={filePath} />}
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
            <CodeEditor path={filePath} visible={fileVisible} readOnlyReason={generatedBy ? `Generated by Blink. Edit ${generatedBy} instead.` : null} />
          </div>
        </div>
      )}
      {page && (
        <div className="view" key={tab.id}>
          {page}
        </div>
      )}
    </div>
  )
}
