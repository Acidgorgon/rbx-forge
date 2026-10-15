// Browser-preview mock of the UI Preview (UiPreviewApi). mock.ts spreads it into its api object.
// The trees are real: mockUiPreviewData.json was recorded from Lune running the fixture stories in
// test/fixtures/ui-preview-project (initial tree plus prop diffs after scripted clicks). Clicks
// replay those recordings; a few fixture controls are mirrored by hand.
import type { HarnessApi, HarnessEvents, UiConsoleEntry, UiControl, UiInput, UiOp, UiOpenRequest, UiPreviewEvent, UiSessionState, UiStoryList, UiTreeSnapshot, UiValue } from '@shared/types'
import data from './mockUiPreviewData.json'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void
type Diff = Record<string, Record<string, UiValue | null>>
interface Recording {
  kind: UiSessionState['kind']
  controls: UiControl[]
  values: Record<string, unknown>
  modules: string[]
  console: UiConsoleEntry[]
  initial: UiTreeSnapshot
  after: Record<string, Diff>
}

const recordings = (data as unknown as { records: Record<string, Recording> }).records
const storyList = (data as unknown as { stories: UiStoryList }).stories
// Fixture sources, so Edit mode can rewrite literals in the browser preview (seeded into mock files).
export const uiPreviewMockSources = (data as unknown as { sources: Record<string, string> }).sources

// Live story sources from other mocks (the UI Motion Lab's lab story, mockUiMotion.ts): open()
// returns a session state for files they own, then input() gets that session's input.
export interface MockStorySource {
  open(request: UiOpenRequest, session: number, send: (event: UiPreviewEvent) => void): UiSessionState | null
  input(message: UiInput): void
  close(): void
}
export const mockStorySources: MockStorySource[] = []
// Project images other mocks provide (Figma import PNGs), by content string.
export const mockImages: Record<string, string> = {}

type Methods = 'uiPreviewStories' | 'uiPreviewOpen' | 'uiPreviewClose' | 'uiPreviewInput' | 'uiPreviewState' | 'uiPreviewImages' | 'uiPreviewSaveExport'

export function uiPreviewMock(emit: Emit, log: (text: string) => void): Pick<HarnessApi, Methods> {
  let session = 0
  let state: UiSessionState | null = null
  let rec: Recording | null = null
  // Clicks so far, as recorded ("BOOSTButton>DRIFTButton").
  let path: string[] = []
  let props = new Map<number, Record<string, UiValue>>()
  let timer: ReturnType<typeof setInterval> | null = null
  let live: MockStorySource | null = null
  const send = (event: UiPreviewEvent) => emit('uiPreview:event', event)

  const materialize = (keys: string[]): Map<number, Record<string, UiValue>> => {
    const out = new Map(rec!.initial.nodes.map((n) => [n.id, { ...n.props }]))
    const diff = rec!.after[keys.join('>')] ?? {}
    for (const [id, changes] of Object.entries(diff)) {
      const p = out.get(Number(id))
      if (!p) continue
      for (const [k, v] of Object.entries(changes)) {
        if (v == null) delete p[k]
        else p[k] = v
      }
    }
    return out
  }
  const setOps = (next: Map<number, Record<string, UiValue>>): UiOp[] => {
    const ops: UiOp[] = []
    for (const [id, p] of next) {
      const cur = props.get(id) ?? {}
      for (const k of Object.keys(p)) if (JSON.stringify(p[k]) !== JSON.stringify(cur[k])) ops.push({ op: 'set', id, k, v: p[k] })
    }
    props = next
    return ops
  }
  const apply = (ops: UiOp[]) => {
    if (!ops.length || !state) return
    for (const op of ops) if (op.op === 'set') {
      const node = state.tree.nodes.find((n) => n.id === op.id)
      if (node) node.props[op.k] = op.v
    }
    send({ session, type: 'ops', ops })
  }
  const byName = (name: string) => state?.tree.nodes.find((n) => n.name === name)
  const setText = (name: string, text: string): UiOp[] => {
    const node = byName(name)
    return node ? [{ op: 'set', id: node.id, k: 'Text', v: text }] : []
  }

  const stop = () => {
    if (timer) clearInterval(timer)
    timer = null
  }

  return {
    async uiPreviewStories() {
      return structuredClone(storyList)
    },
    async uiPreviewOpen(request) {
      stop()
      session++
      live?.close()
      live = null
      for (const src of mockStorySources) {
        const st = src.open(request, session, send)
        if (!st) continue
        live = src
        state = st
        rec = null
        send({ session, type: 'reset', file: request.file, status: st.status, reason: 'open' })
        return structuredClone(st)
      }
      rec = recordings[request.file] ?? null
      path = []
      const tree: UiTreeSnapshot = rec ? structuredClone(rec.initial) : { root: null, nodes: [] }
      props = new Map(tree.nodes.map((n) => [n.id, { ...n.props }]))
      state = {
        session,
        file: request.file,
        status: rec ? 'running' : 'error',
        ...(rec ? { kind: rec.kind } : {}),
        controls: structuredClone(rec?.controls ?? []),
        values: { ...(rec?.values ?? {}), ...(request.controls ?? {}) },
        tree,
        console: structuredClone(rec?.console ?? []),
        modules: [...(rec?.modules ?? [])],
        ...(rec ? {} : { message: 'The browser preview has recordings for the fixture stories only. Run the desktop app to preview this story with Lune.' })
      }
      send({ session, type: 'reset', file: request.file, status: state.status, reason: 'open' })
      log(`ui preview: ${request.file} (recorded)`)
      // The HUD's lap timer ticks once a second, as the Lune session does.
      const time = byName('Time')
      if (time && typeof time.props.Text === 'string') {
        let seconds = 103
        timer = setInterval(() => {
          seconds++
          apply([{ op: 'set', id: time.id, k: 'Text', v: `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` }])
        }, 1000)
      }
      return structuredClone(state)
    },
    async uiPreviewClose() {
      stop()
      live?.close()
      live = null
      state = null
      rec = null
    },
    async uiPreviewInput(message) {
      if (live) return live.input(message)
      if (!state || !rec) return
      if (message.type === 'click') {
        const node = state.tree.nodes.find((n) => n.id === message.id)
        if (!node) return
        const forward = [...path, node.name]
        const toggled = path.filter((p) => p !== node.name)
        const next = forward.join('>') in rec.after ? forward : path.includes(node.name) && (toggled.length === 0 || toggled.join('>') in rec.after) ? toggled : null
        if (next) {
          path = next
          apply(setOps(materialize(path)))
        } else if (typeof node.props.Text === 'string' && /\d+$/.test(node.props.Text)) {
          // Counter-style buttons past the recorded clicks.
          apply([{ op: 'set', id: node.id, k: 'Text', v: node.props.Text.replace(/\d+$/, (n) => String(Number(n) + 1)) }])
        }
        return
      }
      if (message.type === 'set') {
        apply([{ op: 'set', id: message.id, k: message.k, v: message.v }])
        return
      }
      if (message.type === 'control') {
        state.values[message.key] = message.value
        const counter = byName('CounterButton')
        if (message.key === 'Label' && counter) apply(setText('CounterButton', String(counter.props.Text).replace(/^[^:]*/, String(message.value))))
        if (message.key === 'Speed') apply(setText('Speed', String(Math.round(Number(message.value)))))
        if (message.key === 'Backdrop') {
          const hud = byName('RacingHud')
          if (hud) apply([{ op: 'set', id: hud.id, k: 'BackgroundTransparency', v: message.value ? 0 : 1 }])
        }
      }
    },
    async uiPreviewState() {
      return state ? structuredClone(state) : null
    },
    async uiPreviewImages(refs) {
      // No network in the browser preview: every Roblox image is a placeholder showing its id.
      return Object.fromEntries(refs.map((r) => [r, mockImages[r] ? { state: 'ok' as const, url: mockImages[r] } : { state: 'placeholder' as const, reason: 'browser preview' }]))
    },
    async uiPreviewSaveExport(name) {
      log(`ui preview: exported art/ui-exports/${name}`)
      return `art/ui-exports/${name}`
    }
  }
}
