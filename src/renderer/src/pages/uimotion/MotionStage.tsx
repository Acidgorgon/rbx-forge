// The live lab preview: the scratch lab story (main writes it; Lune runs the generated Luau runtime,
// the browser preview runs the TS engine) drawn by the UI Preview Stage. Hover and click in it drive
// the effects for real; specs, labels and reduced motion go in as story controls so slider edits
// apply without a reload. Select mode picks an element (its path under the component root).
// A story source ("From a story") renders the user's UI Labs story in each slot instead; paths are
// then under the slot ("RacingHud.BOOSTButton"), select mode picks the enclosing button / frame, and
// the stage reports the buttons and frames it can target.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react'
import type { UiComponentRef } from '@shared/types'
import type { LayoutResult } from '@shared/uiPreview/layout'
import { absoluteRequire } from '@shared/uimotion/codegen'
import { LAB_HOLDER } from '@shared/uimotion/compile'
import { pickTarget, storyTargets, type StoryTarget } from '@shared/uimotion/story'
import { Stage, type StageMode } from '../uipreview/Stage'
import { useSession } from '../uipreview/useSession'
import { errorText } from '../../lib/format'
import '../uipreview/uipreview.css'

export interface StageSlot {
  spec: string
  label: string
}

export interface MotionStageHandle {
  // Scripted interaction on slot 1's element + snapshots (critique frames).
  capture(): Promise<{ frames: string[]; labels: string[] }>
  // Replays a hover / press / release / leave sequence on every slot.
  replay(): void
  trigger(action: 'appear' | 'disappear'): void
}

// A UI Labs story the lab renders (from the UI Preview's story list).
export interface StorySubject {
  file: string
  name: string
  // DataModel path of the story module.
  path: string[]
}

interface Props {
  component: UiComponentRef | null
  story?: StorySubject | null
  // Story source: the element capture / replay drive (the first target with effects).
  focusPath?: string | null
  onTargets?: (targets: StoryTarget[]) => void
  // Shown when there is no subject (the source choice).
  empty?: ReactNode
  slots: StageSlot[]
  reduced: boolean
  mode: StageMode
  selectedPath: string | null
  onSelectPath: (path: string) => void
  onStatus?: (text: string | null) => void
}

const W = 960
const FIGMA_H = 300
// A story is usually a whole screen (a HUD): 16:9.
const STORY_H = 540
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const MotionStage = forwardRef<MotionStageHandle, Props>(function MotionStage({ component, story = null, focusPath = null, onTargets, empty, slots, reduced, mode, selectedPath, onSelectPath, onStatus }, ref) {
  const H = story ? STORY_H : FIGMA_H
  const h = window.harness
  const session = useSession()
  const { tree, version, view, images, fontsVersion, input, open } = session
  const wrapRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const layoutRef = useRef<LayoutResult | null>(null)
  const [scale, setScale] = useState(1)
  const [file, setFile] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sent = useRef<Record<string, unknown>>({})
  const controls = useCallback((): Record<string, unknown> => {
    const c: Record<string, unknown> = { Slots: Math.max(1, slots.length), Reduced: reduced }
    slots.forEach((s, i) => {
      c[`Spec${i + 1}`] = s.spec
      c[`Label${i + 1}`] = s.label
    })
    return c
  }, [slots, reduced])

  // Fit the fixed-size stage to the panel width.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setScale(Math.min(1.25, Math.max(0.3, el.clientWidth / W))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Write + open the lab story when the subject changes.
  useEffect(() => {
    if (!story && !component?.instance) {
      setFile(null)
      return
    }
    let live = true
    setError(null)
    const subject = story ? { kind: 'story' as const, require: absoluteRequire(story.path), name: story.name } : { kind: 'component' as const, require: absoluteRequire(component!.instance!), name: component!.name }
    h.uiMotionLabStory(subject)
      .then(async (r) => {
        if (!live) return
        setFile(r.file)
        const c = controls()
        sent.current = { ...c }
        await open(r.file, { width: W, height: H, device: 'desktop' }, c)
      })
      .catch((e) => live && setError(errorText(e)))
    return () => {
      live = false
    }
  }, [story?.file, component?.name, component?.module, component?.importedAt])

  // Live control updates (only what changed).
  useEffect(() => {
    if (!file) return
    const t = setTimeout(() => {
      const c = controls()
      for (const [k, v] of Object.entries(c)) {
        if (sent.current[k] === v) continue
        sent.current[k] = v
        input({ type: 'control', key: k, value: v })
      }
    }, 90)
    return () => clearTimeout(t)
  }, [controls, file])

  useEffect(() => () => void h.uiPreviewClose().catch(() => undefined), [])

  useEffect(() => {
    const err = view.console.filter((c) => c.level === 'error').slice(-1)[0]
    onStatus?.(error ?? (view.status === 'error' ? (view.message ?? 'preview error') : err ? err.text : null))
  }, [view.status, view.message, view.console.length, error])

  const slotFrame = useCallback(
    (i: number): number | null => {
      const holder = [...tree.nodes.values()].find((n) => n.name === LAB_HOLDER)
      return holder?.children.map((c) => tree.get(c)).find((n) => n?.name === `Slot${i}`)?.id ?? null
    },
    [tree, version]
  )

  // Slot i's component root (first GuiObject under SlotN that is not the label / fade wrapper); for
  // a story, the slot itself (the story renders into it and the runtime attaches there).
  const slotRoot = useCallback(
    (i: number): number | null => {
      const id = slotFrame(i)
      if (story || id == null) return id
      const slot = tree.get(id)
      if (!slot) return null
      const queue = [...slot.children]
      while (queue.length) {
        const n = tree.get(queue.shift()!)
        if (!n || n.name === 'ForgeMotionLabel' || /^UI[A-Z]/.test(n.cls)) continue
        if (n.name === 'ForgeMotionFade') {
          queue.unshift(...n.children)
          continue
        }
        return n.id
      }
      return null
    },
    [tree, version, slotFrame, story]
  )

  // The story's targetable elements (slot 1), reported when the tree changes shape.
  const targets = useMemo(() => (story ? storyTargets(tree.nodes, slotFrame(1)) : []), [story, tree, version, slotFrame])
  const targetsKey = targets.map((t) => `${t.path}:${t.className}:${t.hidden ? 1 : 0}`).join('|')
  useEffect(() => onTargets?.(targets), [targetsKey])

  const pathOf = useCallback(
    (id: number): string | null => {
      if (story) {
        for (const i of [1, 2, 3]) {
          const p = pickTarget(tree.nodes, id, slotFrame(i))
          if (p != null) return p
        }
        return null
      }
      const roots = [1, 2, 3].map(slotRoot).filter((x): x is number => x != null)
      const parts: string[] = []
      let cur = tree.get(id)
      while (cur && !roots.includes(cur.id)) {
        parts.unshift(cur.name)
        cur = cur.parent != null ? tree.get(cur.parent) : undefined
      }
      return cur ? parts.join('.') : null
    },
    [tree, version, slotRoot, slotFrame, story]
  )

  const idOfPath = (path: string | null, slot = 1): number | null => {
    let cur = slotRoot(slot)
    if (cur == null || path == null) return cur
    for (const part of path ? path.split('.') : []) {
      const n = tree.get(cur!)
      cur = n?.children.find((c) => tree.get(c)?.name === part) ?? null
      if (cur == null) return null
    }
    return cur
  }

  const centerOf = (id: number) => {
    const b = layoutRef.current?.boxes.get(id)
    return b ? { x: Math.round(b.x + b.w * 0.7), y: Math.round(b.y + b.h * 0.4) } : null
  }

  const snap = async (): Promise<string | null> => {
    const el = stageRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    return h.uiMotionSnap({ x: r.left, y: r.top, width: r.width, height: r.height }).catch(() => null)
  }

  // The element hover / press drive: the component root, or a story's focused target.
  const driven = (slot: number): number | null => (story ? (focusPath ? idOfPath(focusPath, slot) : null) : slotRoot(slot))

  useImperativeHandle(ref, () => ({
    async capture() {
      const id = driven(1)
      const at = id != null ? centerOf(id) : null
      const frames: string[] = []
      const labels: string[] = []
      const shot = async (label: string) => {
        const f = await snap()
        if (f) (frames.push(f), labels.push(label))
      }
      if (id == null || !at) return { frames, labels }
      input({ type: 'leave', id })
      await sleep(400)
      await shot('rest')
      input({ type: 'move', ...at })
      input({ type: 'enter', id, ...at })
      await sleep(220)
      await shot('hover +220ms')
      input({ type: 'down', id, ...at })
      await sleep(110)
      await shot('pressed +110ms')
      input({ type: 'up', id, ...at })
      input({ type: 'click', id, ...at })
      await sleep(70)
      await shot('released +70ms')
      await sleep(500)
      await shot('settled +570ms')
      input({ type: 'leave', id })
      return { frames, labels }
    },
    replay() {
      const ids = [1, 2, 3].map(driven).filter((x): x is number => x != null)
      const pts = ids.map((id) => ({ id, at: centerOf(id) })).filter((p) => p.at)
      const run = (delay: number, fn: () => void) => setTimeout(fn, delay)
      for (const p of pts) {
        run(0, () => (input({ type: 'move', ...p.at! }), input({ type: 'enter', id: p.id, ...p.at! })))
        run(700, () => input({ type: 'down', id: p.id, ...p.at! }))
        run(950, () => (input({ type: 'up', id: p.id, ...p.at! }), input({ type: 'click', id: p.id, ...p.at! })))
        run(1800, () => input({ type: 'leave', id: p.id }))
      }
    },
    trigger(action) {
      input({ type: 'control', key: 'Trigger', value: `${action}:${Date.now()}` })
    }
  }))

  const selectedId = mode === 'edit' ? idOfPath(selectedPath) : null

  return (
    <div className="um-stage-wrap" ref={wrapRef}>
      <div className={`um-stage${!component && !story ? ' empty' : ''}`} style={!component && !story ? undefined : { height: H * scale }}>
        <div className="um-scaler" ref={stageRef} style={{ width: W, height: H, transform: `scale(${scale})` }}>
          <Stage
            tree={tree}
            version={version}
            width={W}
            height={H}
            images={images}
            mode={mode}
            selected={selectedId}
            fontsVersion={fontsVersion}
            onInput={input}
            onSelect={(id) => {
              if (id == null) return
              const p = pathOf(id)
              if (p != null) onSelectPath(p)
            }}
            onLayout={(l) => (layoutRef.current = l)}
          />
        </div>
        {!component && !story && <div className="um-stage-empty">{empty ?? <span className="mono">Import a Figma frame or component, or pick one of your UI Labs stories, to preview it here.</span>}</div>}
        {!story && component && !component.instance && <div className="um-stage-empty mono">{component.module} is not mapped in the project file, so the preview cannot require it.</div>}
        {view.status === 'starting' && <div className="um-stage-busy mono"><span className="spinner" aria-hidden /> starting preview…</div>}
      </div>
    </div>
  )
})
