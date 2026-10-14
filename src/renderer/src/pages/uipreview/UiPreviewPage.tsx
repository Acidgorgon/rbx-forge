// UI Preview: UI Labs-style story preview without Studio. Stories (*.story.luau, grouped by
// *.storybook.luau) run in Lune with the real Vide from Packages (resources/lune/preview.luau); the
// instance tree streams here and Stage.tsx draws it with Roblox layout rules. Interact mode sends
// clicks, hover, typing and keys back to the story; Edit mode selects elements and rewrites literal
// properties in the source (hot reload follows). Export to SVG / Forge JSON and import changes back
// from the Figma plugin (figma-plugin/).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { UiControl, UiDevice, UiNode, UiStoryEntry, UiStoryList, UiValue } from '@shared/types'
import type { LayoutResult } from '@shared/uiPreview/layout'
import { luauLiteral } from '@shared/uiPreview/protocol'
import { askAiPrompt } from '@shared/uiPreview/edit'
import { storyFilesKey } from '@shared/storyTemplates'
import { describeChange, diffDocs, forgeDoc, forgeSvg, parseForgeDoc, type DocDiff, type PropChange } from '@shared/uiPreview/figma'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { useMenu } from '../../components/Menu'
import { errorText } from '../../lib/format'
import { Stage, type StageMode } from './Stage'
import { useSession } from './useSession'
import { Inspector } from './Inspector'
import { ControlsPanel } from './ControlsPanel'
import { applyPropertyEdit, candidateFiles, undoEdit, type AppliedEdit } from './editApply'
import './fonts'
import './uipreview.css'

export const DEVICES: Record<UiDevice, { label: string; width: number; height: number; note: string }> = {
  phone: { label: 'Phone', width: 844, height: 390, note: '844×390 landscape, notch on the left' },
  tablet: { label: 'Tablet', width: 1180, height: 820, note: '1180×820' },
  desktop: { label: 'Desktop', width: 1920, height: 1080, note: '1920×1080' },
  console: { label: 'Console', width: 1920, height: 1080, note: '10-foot: GuiService:IsTenFootInterface() is true; dashed line = TV safe area' }
}
const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2]

export const FIDELITY_NOTE =
  'Approximate: substitute fonts (Montserrat for Gotham, Source Sans 3 for Source Sans Pro / Builder Sans, Fredoka for Fredoka One) and browser text metrics, so TextScaled and AutomaticSize around text can be a few pixels off. ViewportFrame 3D, VideoFrame, physics and particles are not drawn. Roblox images come from the public thumbnails API (420px max) or Art concepts; others show a placeholder with the id. Check final layouts in Studio.'

const read = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key)
    return v == null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable */
  }
}

const storyBase = (file: string) => file.split('/').pop()!.replace(/\.story\.luau?$/, '')

function StoryList({ list, file, onPick, onRefresh }: { list: UiStoryList | null; file: string | null; onPick: (s: UiStoryEntry) => void; onRefresh: () => void }) {
  const [filter, setFilter] = useState('')
  const q = filter.trim().toLowerCase()
  return (
    <aside className="uip-side" aria-label="Stories">
      <div className="uip-side-head">
        <span className="uip-title">Stories</span>
        <button className="icon-btn" onClick={onRefresh} title="Rescan stories" aria-label="Rescan stories">
          <Icon name="restart" size={13} />
        </button>
      </div>
      <input className="input uip-filter" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter stories" />
      <div className="uip-books">
        {!list && (
          <div className="note">
            <span className="spinner" aria-hidden /> scanning…
          </div>
        )}
        {list && !list.storybooks.length && (
          <div className="empty">
            <Icon name="monitor" size={22} className="i" />
            No stories yet. Add <span className="mono">Name.story.luau</span> returning <span className="mono">{'{ vide = Vide, story = function(props) … end }'}</span>, and a <span className="mono">.storybook.luau</span> with <span className="mono">storyRoots</span>.
          </div>
        )}
        {list?.storybooks.map((b) => {
          const stories = b.stories.filter((s) => !q || s.name.toLowerCase().includes(q) || s.file.toLowerCase().includes(q))
          if (!stories.length && q) return null
          let folder: string | undefined
          return (
            <div key={b.name + (b.file ?? '')} className="uip-book">
              <div className="uip-book-name" title={b.file}>
                <Icon name="board" size={12} /> {b.name}
              </div>
              {b.error && <div className="note err-text">{b.error}</div>}
              {stories.map((s) => {
                const head = s.folder !== folder ? ((folder = s.folder), s.folder ? <div key={`f:${s.folder}`} className="uip-folder faint">{s.folder}</div> : null) : null
                return (
                  <div key={s.file}>
                    {head}
                    <button className={`uip-story${s.file === file ? ' on' : ''}${s.folder ? ' nested' : ''}`} onClick={() => onPick(s)} title={s.file}>
                      <Icon name="file" size={12} /> {s.name}
                    </button>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      {list && !list.luneAvailable && <div className="uip-hint note warn-text">{list.hint ?? 'Lune was not found. Set Settings > Tests > Lune path to run stories.'}</div>}
    </aside>
  )
}

function FigmaPanel({ diff, busy, onApply, onAsk, onClose }: { diff: DocDiff; busy: boolean; onApply: (changes: PropChange[]) => void; onAsk: () => void; onClose: () => void }) {
  const [skip, setSkip] = useState<Set<number>>(new Set())
  const chosen = diff.literal.filter((_, i) => !skip.has(i))
  return (
    <div className="uip-figma">
      <div className="uip-panel-head">
        <span className="uip-title">From Figma</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="x" size={12} />
        </button>
      </div>
      {!diff.literal.length && !diff.structural.length && <div className="note">No differences from the current preview.</div>}
      {diff.literal.length > 0 && (
        <>
          <div className="set-sub">Literal changes · applied to the source</div>
          {diff.literal.map((c, i) => (
            <label key={i} className="uip-change">
              <input type="checkbox" checked={!skip.has(i)} onChange={() => setSkip((s) => (s.has(i) ? new Set([...s].filter((x) => x !== i)) : new Set([...s, i])))} />
              <span className="mono">{describeChange(c, luauLiteral)}</span>
            </label>
          ))}
          <button className="btn small primary" disabled={busy || !chosen.length} onClick={() => onApply(chosen)}>
            {busy ? <span className="spinner" aria-hidden /> : <Icon name="check" size={11} />} Apply {chosen.length}
          </button>
        </>
      )}
      {diff.structural.length > 0 && (
        <>
          <div className="set-sub">Structural · needs code changes</div>
          <ul className="uip-structural">
            {diff.structural.map((s, i) => (
              <li key={i} className="mono">
                {s}
              </li>
            ))}
          </ul>
          <button className="btn small" onClick={onAsk}>
            <Icon name="bot" size={11} /> Ask AI to make these
          </button>
        </>
      )}
    </div>
  )
}

export function UiPreviewPage() {
  const { state, actions } = useStore()
  const h = window.harness
  const menu = useMenu()
  const session = useSession()
  const { tree, version, view, images, fontsVersion } = session
  const [list, setList] = useState<UiStoryList | null>(null)
  const [file, setFile] = useState<string | null>(() => read<string | null>('uip.story', null))
  const [device, setDevice] = useState<UiDevice>(() => read<UiDevice>('uip.device', 'desktop'))
  const [zoom, setZoom] = useState<number | 'fit'>(() => read<number | 'fit'>('uip.zoom', 'fit'))
  const [mode, setMode] = useState<StageMode>('interact')
  const [tab, setTab] = useState<'controls' | 'inspect'>('controls')
  // Narrow editor area (below 720px, e.g. 900px window with the Assistant open): one pane at a time.
  const [pane, setPane] = useState<'stories' | 'stage' | 'panel'>(() => (file ? 'stage' : 'stories'))
  const [hovered, setHovered] = useState<number | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [consoleOpen, setConsoleOpen] = useState(true)
  const [history, setHistory] = useState<AppliedEdit[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [figma, setFigma] = useState<{ diff: DocDiff; saved: string | null } | null>(null)
  const [fit, setFit] = useState(1)
  const canvasRef = useRef<HTMLDivElement>(null)
  const layoutRef = useRef<LayoutResult | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const dims = DEVICES[device]
  const scale = zoom === 'fit' ? fit : zoom

  const refresh = useCallback(async () => {
    try {
      setList(await h.uiPreviewStories())
    } catch (e) {
      actions.toast({ text: 'Could not list stories', detail: errorText(e), kind: 'err' })
      setList({ storybooks: [], luneAvailable: false })
    }
  }, [])

  useEffect(() => {
    void refresh()
    return () => session.close()
  }, [state.project?.root])

  // New, renamed or removed story files (Explorer > New > Story) show up without a manual refresh.
  const storiesKey = useMemo(() => storyFilesKey(state.tree), [state.tree])
  const seenStories = useRef(storiesKey)
  useEffect(() => {
    if (seenStories.current === storiesKey) return
    seenStories.current = storiesKey
    void refresh()
  }, [storiesKey])

  // Open the chosen story (or the first one) once the list is in.
  useEffect(() => {
    if (!list) return
    const all = list.storybooks.flatMap((b) => b.stories)
    const target = all.find((s) => s.file === file)?.file ?? all[0]?.file ?? null
    if (target && target !== view.file) {
      setFile(target)
      void session.open(target, { width: dims.width, height: dims.height, device }).catch((e) => actions.toast({ text: 'Could not start the preview', detail: errorText(e), kind: 'err' }))
    }
  }, [list, file])

  useEffect(() => write('uip.story', file), [file])
  useEffect(() => write('uip.device', device), [device])
  useEffect(() => write('uip.zoom', zoom), [zoom])

  // Fit zoom follows the canvas size.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const measure = () => {
      const pad = 48
      setFit(Math.max(0.1, Math.min(1, (el.clientWidth - pad) / dims.width, (el.clientHeight - pad) / dims.height)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [dims.width, dims.height])

  const pick = (s: UiStoryEntry) => {
    setPane('stage')
    setSelected(null)
    setHovered(null)
    setHistory([])
    setFigma(null)
    setFile(s.file)
    void session.open(s.file, { width: dims.width, height: dims.height, device })
  }

  const changeDevice = (d: UiDevice) => {
    const next = DEVICES[d]
    const reopen = (d === 'console') !== (device === 'console')
    setDevice(d)
    if (!view.file) return
    if (reopen) void session.open(view.file, { width: next.width, height: next.height, device: d }, view.values)
    else {
      session.input({ type: 'device', device: d })
      session.input({ type: 'resize', width: next.width, height: next.height })
    }
  }

  const reload = () => view.file && void session.open(view.file, { width: dims.width, height: dims.height, device }, view.values)

  const onControl = (c: UiControl, v: unknown) => session.input({ type: 'control', key: c.key, ...(c.group ? { group: c.group } : {}), value: v })
  const resetControls = () => {
    for (const c of view.controls) session.input({ type: 'control', key: c.key, ...(c.group ? { group: c.group } : {}), value: c.value })
  }

  const storeBits = useMemo(() => ({ files: state.files, editFile: actions.editFile, saveFile: actions.saveFile }), [state.files])
  const candidates = view.file ? candidateFiles(view.file, view.modules) : []

  const ask = (node: UiNode, extra?: { prop?: string; from?: UiValue; to?: UiValue; reason?: string }) => {
    if (!view.file) return
    actions.ask(
      askAiPrompt({
        file: view.file,
        path: tree.relativePath(node.id),
        cls: node.cls,
        ...(extra?.prop ? { prop: extra.prop } : {}),
        ...(extra?.from !== undefined ? { from: luauLiteral(extra.from) ?? JSON.stringify(extra.from) } : {}),
        ...(extra?.to !== undefined ? { to: luauLiteral(extra.to) ?? JSON.stringify(extra.to) } : {}),
        ...(extra?.reason ? { reason: extra.reason } : {})
      })
    )
  }

  const editProp = async (node: UiNode, prop: string, value: UiValue) => {
    if (!view.file) return
    setBusy(`writing ${node.name}.${prop}…`)
    try {
      const current = node.props[prop]
      const out = await applyPropertyEdit({ files: candidates, name: node.name, cls: node.cls, prop, current, value, store: storeBits })
      if (out.ok) {
        session.input({ type: 'set', id: node.id, k: prop, v: value })
        setHistory((hs) => [...hs.slice(-49), out.edit])
        actions.toast({
          text: `${out.edit.how === 'insert' ? 'Added' : 'Set'} ${node.name}.${prop} = ${luauLiteral(value)}`,
          detail: `${out.edit.file}:${out.edit.line}${out.edit.viaEditor ? ' (editor undo works too)' : ''}`,
          kind: 'ok',
          ms: 3200,
          action: { label: 'Show', run: () => void actions.openFileAt(out.edit.file, out.edit.line) }
        })
      } else {
        actions.toast({ text: `Can't write ${node.name}.${prop} directly`, detail: `${out.reason}${out.expression ? `: ${out.expression.split('\n')[0]}` : ''}. Prefilled the chat instead.`, kind: 'info', ms: 5000 })
        ask(node, { prop, from: current, to: value, reason: `${out.reason}${out.file && out.line ? ` at ${out.file}:${out.line}` : ''}` })
      }
    } catch (e) {
      actions.toast({ text: 'Edit failed', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
      setRevision((r) => r + 1)
    }
  }

  const undo = async () => {
    const last = history[history.length - 1]
    if (!last) return
    const ok = await undoEdit(last, storeBits)
    setHistory((hs) => hs.slice(0, -1))
    actions.toast(ok ? { text: `Undid ${last.label}`, detail: `${last.file}:${last.line}`, kind: 'ok', ms: 2400 } : { text: `Can't undo ${last.label}`, detail: 'The file changed since.', kind: 'err' })
  }

  const jump = async (node: UiNode) => {
    const pattern = new RegExp(String.raw`\bName\s*=\s*["']${node.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`)
    for (const f of candidates) {
      let src: string
      try {
        src = state.files.find((x) => x.path === f && !x.loading)?.current ?? (await h.readFile(f))
      } catch {
        continue
      }
      const m = pattern.exec(src)
      if (m) return void actions.openFileAt(f, src.slice(0, m.index).split('\n').length)
    }
    if (view.file) void actions.openFile(view.file)
    actions.toast({ text: `No Name = "${node.name}" literal found`, detail: 'Opened the story file.', kind: 'info', ms: 3000 })
  }

  // ---- export / import

  const currentDoc = () => {
    if (!layoutRef.current || !view.file) return null
    return forgeDoc(tree, layoutRef.current, { story: view.file, device, viewport: { w: dims.width, h: dims.height }, images, now: new Date().toISOString() })
  }

  const exportAs = async (kind: 'svg' | 'json' | 'copy') => {
    const doc = currentDoc()
    if (!doc || !view.file) return
    const name = storyBase(view.file)
    try {
      if (kind === 'copy') return void (await actions.copy(JSON.stringify(doc), 'Forge JSON'))
      const path = await h.uiPreviewSaveExport(kind === 'svg' ? `${name}.svg` : `${name}.forge-ui.json`, kind === 'svg' ? forgeSvg(doc) : JSON.stringify(doc, null, 2))
      actions.toast({ text: `Exported ${path}`, detail: kind === 'json' ? 'Figma: Plugins > Development > Forge UI > Import Forge JSON.' : 'Drop it into Figma or any SVG editor.', kind: 'ok', ms: 4200, action: { label: 'Copy path', run: () => void actions.copy(path) } })
    } catch (e) {
      actions.toast({ text: 'Export failed', detail: errorText(e), kind: 'err' })
    }
  }

  const importText = async (text: string) => {
    try {
      const incoming = parseForgeDoc(text)
      const base = currentDoc()
      if (!base) throw new Error('Open a story first.')
      if (view.file && incoming.story !== view.file) actions.toast({ text: `This frame was exported from ${incoming.story}`, detail: `Comparing it with ${view.file}.`, kind: 'info' })
      const diff = diffDocs(base, incoming)
      let saved: string | null = null
      if (diff.structural.length) saved = await h.uiPreviewSaveExport(`${storyBase(view.file!)}.from-figma.json`, JSON.stringify(incoming, null, 2)).catch(() => null)
      setFigma({ diff, saved })
      setTab('inspect')
    } catch (e) {
      actions.toast({ text: 'Import from Figma failed', detail: errorText(e), kind: 'err' })
    }
  }

  const applyFigma = async (changes: PropChange[]) => {
    const failed: string[] = []
    let done = 0
    setBusy(`applying ${changes.length} changes…`)
    for (const c of changes) {
      const node = tree.get(c.id) ?? [...tree.nodes.values()].find((n) => tree.relativePath(n.id) === c.path)
      if (!node) {
        failed.push(`${c.path}.${c.prop} (element not in the preview)`)
        continue
      }
      const out = await applyPropertyEdit({ files: candidates, name: node.name, cls: node.cls, prop: c.prop, current: node.props[c.prop], value: c.to, store: storeBits })
      if (out.ok) {
        done++
        session.input({ type: 'set', id: node.id, k: c.prop, v: c.to })
        setHistory((hs) => [...hs.slice(-49), out.edit])
      } else failed.push(`${describeChange(c, luauLiteral)} (${out.reason})`)
    }
    setBusy(null)
    actions.toast({ text: `Applied ${done} of ${changes.length} changes from Figma`, kind: failed.length ? 'info' : 'ok' })
    setFigma((f) => (f ? { ...f, diff: { literal: [], structural: [...f.diff.structural, ...failed] } } : f))
  }

  const askFigma = () => {
    if (!figma || !view.file) return
    actions.ask(
      [
        `Apply these changes from Figma to the UI story ${view.file}${figma.saved ? ` (full frame: ${figma.saved})` : ''}:`,
        ...figma.diff.structural.map((s) => `- ${s}`),
        'Keep Vide style and existing components; check the result with preview_ui.'
      ].join('\n')
    )
  }

  const openStudioMenu = (el: HTMLElement) => {
    const story = list?.storybooks.flatMap((b) => b.stories).find((s) => s.file === view.file)
    menu.openUnder(el, [
      { header: 'Check in Studio with UI Labs' },
      { label: 'Copy story instance path', sub: story ? story.path.join('.') : 'no story', disabled: !story, icon: <Icon name="copy" size={12} />, onSelect: () => story && void actions.copy(story.path.join('.'), 'story path') },
      { label: 'Steps', sub: 'Sync with Rojo, open UI Labs (Plugins tab), pick the story', icon: <Icon name="studio" size={12} />, disabled: true },
      { label: 'UI Labs on GitHub', icon: <Icon name="external" size={12} />, onSelect: () => window.open('https://github.com/PepeElToro41/ui-labs', '_blank', 'noopener') }
    ])
  }

  const target = mode === 'edit' ? selected : hovered
  const statusText = view.status === 'starting' ? 'starting Lune…' : view.status === 'reloading' ? 'reloading…' : view.status === 'exited' ? 'stopped' : view.status === 'error' ? 'error' : view.status === 'running' ? (view.kind ?? 'running') : ''
  const errors = view.console.filter((c) => c.level === 'error').length
  const storyTitle = view.file ? storyBase(view.file) : 'No story'

  let overlay: ReactNode = null
  if (view.status === 'error' || view.kind === 'unsupported' || view.kind === 'error') {
    overlay = (
      <div className="uip-overlay err">
        <Icon name="err" size={16} />
        <div>
          <b>{view.kind === 'unsupported' ? 'This story type is not supported in Forge yet' : 'The story failed'}</b>
          <div className="note">{view.message ?? view.console.filter((c) => c.level === 'error').slice(-1)[0]?.text.split('\n')[0] ?? 'See the console.'}</div>
          <div className="note faint">Vide, function and generic UI Labs stories run here; React/Roact/Fusion/Iris stories need Studio.</div>
        </div>
      </div>
    )
  } else if (view.status === 'starting' && tree.nodes.size === 0) {
    overlay = (
      <div className="uip-overlay">
        <span className="spinner" aria-hidden /> starting Lune…
      </div>
    )
  }

  return (
    <div className="uip-wrap">
      <div className="uip-page" data-pane={pane}>
        <div className="seg uip-narrow-tabs" role="tablist" aria-label="UI Preview panes">
          {(
            [
              ['stories', 'Stories'],
              ['stage', 'Preview'],
              ['panel', tab === 'inspect' ? 'Inspector' : 'Controls']
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={pane === id} className={pane === id ? 'on' : ''} onClick={() => setPane(id)}>
              {label}
            </button>
          ))}
        </div>
        <StoryList list={list} file={view.file ?? file} onPick={pick} onRefresh={() => void refresh()} />
        <section className="uip-main">
          <div className="uip-toolbar">
            <span className="uip-story-name" title={view.file ?? ''}>
              {storyTitle}
              {statusText && <span className={`uip-status s-${view.status}`}>{statusText}</span>}
            </span>
            <div className="seg" role="group" aria-label="Mode">
              <button className={mode === 'interact' ? 'on' : ''} onClick={() => (setMode('interact'), setSelected(null))} title="Click, hover and type into the story">
                Interact
              </button>
              <button className={mode === 'edit' ? 'on' : ''} onClick={() => (setMode('edit'), setTab('inspect'))} title="Select elements and edit their properties">
                Edit
              </button>
            </div>
            <div className="seg" role="group" aria-label="Device">
              {(Object.keys(DEVICES) as UiDevice[]).map((d) => (
                <button key={d} className={device === d ? 'on' : ''} onClick={() => changeDevice(d)} title={DEVICES[d].note}>
                  {DEVICES[d].label}
                </button>
              ))}
            </div>
            <select className="input uip-zoom" value={String(zoom)} onChange={(e) => setZoom(e.target.value === 'fit' ? 'fit' : Number(e.target.value))} aria-label="Zoom">
              <option value="fit">Fit {Math.round(fit * 100)}%</option>
              {ZOOMS.map((z) => (
                <option key={z} value={z}>
                  {z * 100}%
                </option>
              ))}
            </select>
            <span className="grow" />
            <button className="icon-btn" onClick={reload} disabled={!view.file} title="Reload story (state resets)" aria-label="Reload story">
              <Icon name="restart" size={14} />
            </button>
            <button className="icon-btn" onClick={() => void undo()} disabled={!history.length} title={history.length ? `Undo ${history[history.length - 1].label}` : 'Nothing to undo'} aria-label="Undo edit">
              <Icon name="undo" size={14} />
            </button>
            <button
              className="btn small ghost"
              disabled={!view.file}
              onClick={(e) =>
                menu.openUnder(e.currentTarget, [
                  { header: 'Export frame' },
                  { label: 'SVG', sub: 'art/ui-exports/<story>.svg', icon: <Icon name="download" size={12} />, onSelect: () => void exportAs('svg') },
                  { label: 'Forge JSON (for Figma)', sub: 'art/ui-exports/<story>.forge-ui.json', icon: <Icon name="download" size={12} />, onSelect: () => void exportAs('json') },
                  { label: 'Copy Forge JSON', icon: <Icon name="copy" size={12} />, onSelect: () => void exportAs('copy') },
                  'separator',
                  { label: 'Import from Figma…', sub: 'JSON from the Forge Figma plugin', icon: <Icon name="upload" size={12} />, onSelect: () => fileInput.current?.click() },
                  { label: 'Paste from Figma', sub: 'Forge JSON on the clipboard', icon: <Icon name="upload" size={12} />, onSelect: () => void navigator.clipboard.readText().then(importText, () => actions.toast({ text: 'Clipboard is not available', kind: 'err' })) }
                ])
              }
            >
              <Icon name="board" size={12} /> Figma
            </button>
            <button className="btn small ghost" onClick={(e) => openStudioMenu(e.currentTarget)} disabled={!view.file}>
              <Icon name="studio" size={12} /> Open in Studio
            </button>
            <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void f.text().then(importText)
            }} />
          </div>
          <div className="uip-canvas" ref={canvasRef}>
            <div className={`uip-device d-${device}`} style={{ width: dims.width * scale, height: dims.height * scale }}>
              <div className="uip-scaler" style={{ width: dims.width, height: dims.height, transform: `scale(${scale})` }}>
                <Stage
                  tree={tree}
                  version={version}
                  width={dims.width}
                  height={dims.height}
                  images={images}
                  mode={mode}
                  selected={mode === 'edit' ? selected : null}
                  hovered={hovered}
                  fontsVersion={fontsVersion}
                  onInput={session.input}
                  onHover={setHovered}
                  onSelect={(id) => {
                    setSelected(id)
                    setTab('inspect')
                  }}
                  onLayout={(l) => (layoutRef.current = l)}
                />
                {device === 'phone' && <div className="uip-notch" aria-hidden />}
                {device === 'console' && <div className="uip-safe" aria-hidden><span>TV safe area</span></div>}
              </div>
              {overlay}
            </div>
            <div className="uip-canvas-meta faint mono">
              {dims.width}×{dims.height} · {Math.round(scale * 100)}%{view.reloads ? ` · hot reloads ${view.reloads}` : ''}
            </div>
          </div>
          <div className={`uip-console${consoleOpen ? ' open' : ''}`}>
            <button className="uip-console-head" onClick={() => setConsoleOpen(!consoleOpen)} aria-expanded={consoleOpen}>
              <Icon name={consoleOpen ? 'chevDown' : 'chev'} size={11} /> Console
              {errors > 0 && <span className="badge err">{errors}</span>}
              <span className="grow" />
              <span className="faint">{view.console.length} lines</span>
              <span className="uip-link" role="button" tabIndex={0} onClick={(e) => (e.stopPropagation(), session.clearConsole())}>
                clear
              </span>
            </button>
            {consoleOpen && (
              <div className="uip-console-body mono">
                {!view.console.length && <div className="faint">print(), warn() and errors from the story show here, with file:line links.</div>}
                {view.console.map((c, i) => (
                  <div key={i} className={`uip-line l-${c.level}`}>
                    {c.file && (
                      <button className="uip-loc" onClick={() => void actions.openFileAt(c.file!, c.line ?? 1)}>
                        {c.file}:{c.line}
                      </button>
                    )}
                    <span className="uip-msg">{c.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
        <aside className="uip-right" aria-label="Story panel">
          <div className="seg uip-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'controls'} className={tab === 'controls' ? 'on' : ''} onClick={() => setTab('controls')}>
              Controls{view.controls.length ? ` ${view.controls.length}` : ''}
            </button>
            <button role="tab" aria-selected={tab === 'inspect'} className={tab === 'inspect' ? 'on' : ''} onClick={() => setTab('inspect')}>
              Inspector
            </button>
          </div>
          <div className="uip-right-body">
            {figma && <FigmaPanel diff={figma.diff} busy={!!busy} onApply={(c) => void applyFigma(c)} onAsk={askFigma} onClose={() => setFigma(null)} />}
            {tab === 'controls' ? (
              <ControlsPanel controls={view.controls} values={view.values} onChange={onControl} onReset={resetControls} />
            ) : (
              <Inspector
                tree={tree}
                id={target}
                box={target != null ? layoutRef.current?.boxes.get(target) : undefined}
                pinned={mode === 'edit' && selected != null}
                editMode={mode === 'edit'}
                busy={busy}
                revision={revision}
                onEdit={(n, p, v) => void editProp(n, p, v)}
                onJump={(n) => void jump(n)}
                onAsk={(n) => ask(n)}
                onSelect={setSelected}
              />
            )}
          </div>
          <details className="uip-fidelity">
            <summary>Fidelity</summary>
            <p className="note">{FIDELITY_NOTE}</p>
          </details>
        </aside>
        {menu.node}
      </div>
    </div>
  )
}
