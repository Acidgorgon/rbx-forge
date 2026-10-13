// Live preview session state: the streamed PreviewTree, story kind and controls, console, loaded
// modules, image URLs and font loading. Talks to UiPreviewApi / 'uiPreview:event'.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiConsoleEntry, UiControl, UiDevice, UiImageInfo, UiInput, UiSessionStatus, UiStoryKind } from '@shared/types'
import { isTagged, PreviewTree, type FontValue } from '@shared/uiPreview/protocol'
import { loadTreeFonts } from './measure'

export interface SessionView {
  session: number
  file: string | null
  status: UiSessionStatus | 'idle'
  kind?: UiStoryKind
  message?: string
  controls: UiControl[]
  values: Record<string, unknown>
  console: UiConsoleEntry[]
  modules: string[]
  reloads: number
}

const EMPTY: SessionView = { session: 0, file: null, status: 'idle', controls: [], values: {}, console: [], modules: [], reloads: 0 }

const defaultsOf = (controls: UiControl[]) => Object.fromEntries(controls.map((c) => [c.group ? `${c.group}/${c.key}` : c.key, c.value]))

export function imageRefsOf(tree: PreviewTree): string[] {
  const out = new Set<string>()
  for (const n of tree.nodes.values()) for (const k of ['Image', 'HoverImage', 'PressedImage']) if (typeof n.props[k] === 'string' && n.props[k]) out.add(n.props[k] as string)
  return [...out]
}

function fontsOf(tree: PreviewTree): (FontValue | undefined)[] {
  const out: (FontValue | undefined)[] = []
  for (const n of tree.nodes.values()) if (isTagged(n.props.FontFace, 'Font')) out.push(n.props.FontFace)
  return out
}

export function useSession() {
  const h = window.harness
  const treeRef = useRef(new PreviewTree())
  const [version, setVersion] = useState(0)
  const [view, setView] = useState<SessionView>(EMPTY)
  const [images, setImages] = useState<Record<string, UiImageInfo>>({})
  const [fontsVersion, setFontsVersion] = useState(0)
  const sessionRef = useRef(0)
  const pending = useRef<number | null>(null)
  const requested = useRef(new Set<string>())

  const bump = useCallback(() => {
    if (pending.current != null) return
    pending.current = requestAnimationFrame(() => {
      pending.current = null
      setVersion((v) => v + 1)
    })
  }, [])

  useEffect(() => {
    return h.on('uiPreview:event', (ev) => {
      if (ev.session < sessionRef.current) return
      switch (ev.type) {
        case 'reset':
          sessionRef.current = ev.session
          treeRef.current = new PreviewTree()
          bump()
          setView((v) => ({
            ...v,
            session: ev.session,
            file: ev.file,
            status: ev.status,
            message: undefined,
            console: ev.reason === 'reload' ? [...v.console.slice(-200), { at: Date.now(), level: 'print', text: '— hot reload —' }] : [],
            reloads: v.reloads + (ev.reason === 'reload' ? 1 : 0)
          }))
          return
        case 'ops':
          if (ev.session !== sessionRef.current) return
          treeRef.current.apply(ev.ops)
          bump()
          return
        case 'story':
          setView((v) => ({ ...v, kind: ev.kind, controls: ev.controls, values: { ...defaultsOf(ev.controls), ...v.values } }))
          return
        case 'console':
          setView((v) => ({ ...v, console: [...v.console.slice(-499), ev.entry] }))
          return
        case 'status':
          setView((v) => ({ ...v, status: ev.status, message: ev.message }))
          return
        case 'modules':
          setView((v) => ({ ...v, modules: ev.files }))
          return
      }
    })
  }, [bump])

  // Images: resolve refs the tree uses that we have not asked about yet.
  useEffect(() => {
    const refs = imageRefsOf(treeRef.current).filter((r) => !requested.current.has(r))
    if (!refs.length) return
    for (const r of refs) requested.current.add(r)
    let live = true
    h.uiPreviewImages(refs)
      .then((found) => live && setImages((cur) => ({ ...cur, ...found })))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [version])

  // Fonts: load the faces the tree uses, then measure again.
  useEffect(() => {
    let live = true
    void loadTreeFonts(fontsOf(treeRef.current)).then((loaded) => {
      if (loaded && live) setFontsVersion((n) => n + 1)
    })
    return () => {
      live = false
    }
  }, [version])

  const open = useCallback(async (file: string, size: { width: number; height: number; device: UiDevice }, controls?: Record<string, unknown>) => {
    setView((v) => ({ ...EMPTY, file, status: 'starting', values: v.file === file ? v.values : {} }))
    const state = await h.uiPreviewOpen({ file, ...size, ...(controls ? { controls } : {}) })
    if (state.session < sessionRef.current) return state
    sessionRef.current = state.session
    if (treeRef.current.nodes.size === 0 && state.tree.nodes.length) {
      treeRef.current = PreviewTree.from(state.tree)
      bump()
    }
    setView((v) => ({
      ...v,
      session: state.session,
      file: state.file,
      status: v.status === 'starting' || v.status === 'idle' ? state.status : v.status,
      ...(state.kind ? { kind: state.kind } : {}),
      message: state.message ?? v.message,
      controls: state.controls.length ? state.controls : v.controls,
      values: { ...defaultsOf(state.controls), ...state.values, ...v.values },
      console: v.console.length ? v.console : state.console,
      modules: state.modules.length ? state.modules : v.modules
    }))
    return state
  }, [bump])

  const input = useCallback((message: UiInput) => {
    if (message.type === 'control') setView((v) => ({ ...v, values: { ...v.values, [message.group ? `${message.group}/${message.key}` : message.key]: message.value } }))
    void h.uiPreviewInput(message).catch(() => undefined)
  }, [])

  const close = useCallback(() => {
    void h.uiPreviewClose().catch(() => undefined)
  }, [])

  const clearConsole = useCallback(() => setView((v) => ({ ...v, console: [] })), [])

  return { tree: treeRef.current, version, view, images, fontsVersion, open, input, close, clearConsole }
}
