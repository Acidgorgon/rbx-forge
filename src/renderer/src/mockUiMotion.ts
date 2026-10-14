// Browser-preview mock of UiMotionApi: an imported "PlayButton" (the Figma fixture mapped with the
// real shared mapper), a few stacks from the presets, compose from the brief's words, the critique
// with the real UI principle checks, and a live lab story for the UI Preview mock: the component's
// tree in 1-3 slots, driven by the shared MotionEngine (the same springs the Luau runtime runs) on
// hover / press / move input from the Stage.
import type { FigmaImportResult, HarnessEvents, MotionSpec, UiComponentRef, UiInput, UiMotionApi, UiMotionEntry, UiNode, UiOp, UiOpenRequest, UiPreviewEvent, UiSessionState, UiValue } from '@shared/types'
import { mapFigmaNode, walkInst, type UiInst, type MappingReport } from '@shared/uimotion/figma/map'
import { parseFigmaUrl } from '@shared/uimotion/figma/rest'
import { parseForgeFigmaDoc, type FigmaNode } from '@shared/uimotion/figma/types'
import { describeSpec, luauName, normalizeSpec, presetSpec, type MotionEffect } from '@shared/uimotion/spec'
import { applyChanges, heuristicStack, type UiMotionChange, type UiMotionVision } from '@shared/uimotion/ai'
import { buildCritique } from '@shared/uimotion/critique'
import { MotionEngine, type MotionValues } from '@shared/uimotion/engine'
import { LAB_HOLDER } from '@shared/uimotion/compile'
import { mockImages, mockStorySources } from './mockUiPreview'
import { mockPrincipleWeights, recordPrincipleRating } from './mockPrinciples'
import figma from './mockUiMotionFigma.json'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.UTC(2026, 9, 13, 16, 0)

const ICON_SVG = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><path d="M20 12 L52 32 L20 52 Z" fill="#fff"/></svg>')}`

interface MockComponent {
  ref: UiComponentRef
  inst: UiInst
  report: MappingReport
}

function importNode(root: FigmaNode, name: string | undefined, source: UiComponentRef['source'], from: string, at: number): MockComponent {
  const nm = luauName(name || root.name || 'Component', 'Component')
  const { root: inst, report } = mapFigmaNode(root, { name: nm, imageDir: `art/ui/${nm}` })
  for (const img of report.images) mockImages[img.file] = ICON_SVG
  const elements: UiComponentRef['elements'] = []
  walkInst(inst, (i, path) => {
    if (!/^UI[A-Z]/.test(i.className)) elements.push({ path, className: i.className })
  })
  const dir = 'src/shared/Interface'
  return {
    ref: { name: nm, module: `${dir}/Components/${nm}.luau`, story: `${dir}/Stories/${nm}.story.luau`, instance: ['ReplicatedStorage', 'Shared', 'Interface', 'Components', nm], elements, source, from, importedAt: at, summary: report.summary },
    inst,
    report
  }
}

// ---------------------------------------------------------------- the live lab story

const udim2 = (v: number[]): UiValue => ({ t: 'UDim2', v: v.map((x) => Math.round(x * 10000) / 10000) as [number, number, number, number] })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

interface SlotTarget {
  path: string
  id: number
  basePos: number[]
  baseSize: number[]
  baseRot: number
  scaleId: number
  glowId?: number
  shineId?: number
  shineGradId?: number
  fx: MotionEffect[]
  ripples: number[]
}
interface Slot {
  frame: number
  fade: number
  root: number
  engine: MotionEngine
  targets: SlotTarget[]
  hovered: boolean
}

class LabSession {
  private nodes = new Map<number, UiNode>()
  private next = 1
  private slots: Slot[] = []
  private rects = new Map<number, [number, number, number, number]>()
  private timer: ReturnType<typeof setInterval> | null = null
  private last = performance.now()
  private mouse = { x: 0, y: 0 }
  private pressed: Slot | null = null
  values: Record<string, unknown>
  private holder = 0
  constructor(
    private comp: MockComponent,
    private session: number,
    private send: (e: UiPreviewEvent) => void,
    values: Record<string, unknown>
  ) {
    this.values = { Slots: 1, Spec1: '', Spec2: '', Spec3: '', Label1: '', Label2: '', Label3: '', Trigger: '', Reduced: false, ...values }
    const gui = this.add('ScreenGui', 'ForgePreview', null, { IgnoreGuiInset: true, Enabled: true })
    const target = this.add('Frame', 'StoryTarget', gui, { Size: udim2([1, 0, 1, 0]), BackgroundTransparency: 1 })
    this.holder = this.add('Frame', LAB_HOLDER, target, { Size: udim2([1, 0, 1, 0]), BackgroundTransparency: 1 })
    this.build([])
    this.timer = setInterval(() => this.tick(), 33)
  }

  private add(cls: string, name: string, parent: number | null, props: Record<string, UiValue>, ops?: UiOp[]): number {
    const id = this.next++
    const p = parent != null ? this.nodes.get(parent) : null
    const path = p ? `${p.path}.${name}` : `Players.Player1.PlayerGui.${name}`
    this.nodes.set(id, { id, cls, name, parent, props: { ...props }, children: [], path })
    if (p) p.children.push(id)
    ops?.push({ op: 'create', id, cls, name, parent, props: { ...props }, path })
    return id
  }

  private remove(id: number, ops: UiOp[]): void {
    const n = this.nodes.get(id)
    if (!n) return
    for (const c of [...n.children]) this.remove(c, ops)
    this.nodes.delete(id)
    const p = n.parent != null ? this.nodes.get(n.parent) : null
    if (p) p.children = p.children.filter((c) => c !== id)
    ops.push({ op: 'destroy', id })
  }

  private set(id: number, k: string, v: UiValue, ops: UiOp[]): void {
    const n = this.nodes.get(id)
    if (!n || same(n.props[k], v)) return
    n.props[k] = v
    ops.push({ op: 'set', id, k, v })
  }

  snapshot(): UiSessionState['tree'] {
    return { root: 1, nodes: [...this.nodes.values()].map((n) => structuredClone(n)) }
  }

  private mount(inst: UiInst, parent: number, ops?: UiOp[]): number {
    const id = this.add(inst.className, inst.name, parent, inst.props, ops)
    for (const c of inst.children) this.mount(c, id, ops)
    return id
  }

  private find(root: number, path: string): number | null {
    let cur: number | null = root
    for (const part of path ? path.split('.') : []) {
      const n: UiNode | undefined = cur != null ? this.nodes.get(cur) : undefined
      cur = n?.children.find((c) => this.nodes.get(c)?.name === part) ?? null
      if (cur == null) return null
    }
    return cur
  }

  private build(ops: UiOp[] | null): void {
    const o = ops ?? undefined
    for (const s of this.slots) if (ops) this.remove(s.frame, ops)
    this.slots = []
    const n = Math.max(1, Math.min(3, Math.floor(Number(this.values.Slots) || 1)))
    for (let i = 1; i <= n; i++) {
      const frame = this.add('Frame', `Slot${i}`, this.holder, { AnchorPoint: { t: 'Vector2', v: [0.5, 0.5] }, Position: udim2([(i - 0.5) / n, 0, 0.5, 0]), Size: udim2([1 / n, 0, 1, 0]), BackgroundTransparency: 1 }, o)
      const label = this.values[`Label${i}`]
      if (n > 1 && typeof label === 'string' && label)
        this.add('TextLabel', 'ForgeMotionLabel', frame, { AnchorPoint: { t: 'Vector2', v: [0.5, 1] }, Position: udim2([0.5, 0, 1, -24]), Size: udim2([0, 240, 0, 24]), BackgroundTransparency: 1, Text: label, TextSize: 18, TextColor3: { t: 'Color3', v: [0.59, 0.62, 0.67] }, FontFace: { t: 'Font', family: 'rbxasset://fonts/families/RobotoMono.json', weight: 'Regular', style: 'Normal' } }, o)
      const fade = this.add('CanvasGroup', 'ForgeMotionFade', frame, { Size: udim2([1, 0, 1, 0]), BackgroundTransparency: 1, GroupTransparency: 0 }, o)
      const inst = structuredClone(this.comp.inst)
      inst.props.AnchorPoint = { t: 'Vector2', v: [0.5, 0.5] }
      inst.props.Position = udim2([0.5, 0, 0.5, 0])
      const root = this.mount(inst, fade, o)
      let spec: MotionSpec | null = null
      try {
        spec = typeof this.values[`Spec${i}`] === 'string' && this.values[`Spec${i}`] ? normalizeSpec(JSON.parse(String(this.values[`Spec${i}`]))) : null
      } catch {
        spec = null
      }
      const engine = new MotionEngine(spec ?? normalizeSpec({}), { reduced: this.values.Reduced === true })
      const targets: SlotTarget[] = []
      for (const t of spec?.targets ?? []) {
        const id = this.find(root, t.path)
        if (id == null || !t.effects.length) continue
        const node = this.nodes.get(id)!
        const pos = (node.props.Position as { v?: number[] } | undefined)?.v ?? [0, 0, 0, 0]
        const size = (node.props.Size as { v?: number[] } | undefined)?.v ?? [0, 100, 0, 40]
        const st: SlotTarget = { path: t.path, id, basePos: [...pos], baseSize: [...size], baseRot: Number(node.props.Rotation) || 0, scaleId: this.add('UIScale', 'ForgeMotionScale', id, { Scale: 1 }, o), fx: t.effects, ripples: [] }
        const glow = t.effects.find((e) => e.kind === 'glow')
        if (glow && glow.kind === 'glow') st.glowId = this.add('UIStroke', 'ForgeMotionGlow', id, { ApplyStrokeMode: { t: 'Enum', e: 'ApplyStrokeMode', v: 'Border' }, Color: { t: 'Color3', v: glow.color }, Thickness: 0, Transparency: 1 }, o)
        const shine = t.effects.find((e) => e.kind === 'shine')
        if (shine && shine.kind === 'shine') {
          st.shineId = this.add('Frame', 'ForgeMotionShine', id, { Size: udim2([1, 0, 1, 0]), BackgroundColor3: { t: 'Color3', v: shine.color }, BackgroundTransparency: 0, ZIndex: 5, Visible: false }, o)
          const corner = node.children.map((c) => this.nodes.get(c)).find((c) => c?.cls === 'UICorner')
          if (corner) this.add('UICorner', 'UICorner', st.shineId, corner.props, o)
          const w = shine.width / 2
          const a = 1 - shine.intensity
          st.shineGradId = this.add('UIGradient', 'UIGradient', st.shineId, { Rotation: shine.angle, Offset: { t: 'Vector2', v: [-1, 0] }, Transparency: { t: 'NumberSequence', v: [[0, 1], [Math.max(0.001, 0.5 - w), 1], [0.5, a], [Math.min(0.999, 0.5 + w), 1], [1, 1]] } }, o)
        }
        targets.push(st)
      }
      if (spec?.targets.some((t) => t.effects.some((e) => e.kind === 'appear'))) engine.play('appear')
      this.slots.push({ frame, fade, root, engine, targets, hovered: false })
    }
  }

  private tick(): void {
    const now = performance.now()
    const dt = Math.min(0.1, (now - this.last) / 1000)
    this.last = now
    const ops: UiOp[] = []
    for (const s of this.slots) {
      s.engine.step(dt)
      let alpha = 1
      for (const t of s.targets) {
        const v = s.engine.values(t.path)
        alpha = Math.min(alpha, v.alpha)
        this.apply(s, t, v, ops)
      }
      this.set(s.fade, 'GroupTransparency', Math.round((1 - alpha) * 1000) / 1000, ops)
    }
    if (ops.length) this.send({ session: this.session, type: 'ops', ops })
  }

  private apply(s: Slot, t: SlotTarget, v: MotionValues, ops: UiOp[]): void {
    const r3 = (x: number) => Math.round(x * 1000) / 1000
    this.set(t.scaleId, 'Scale', r3(v.scale), ops)
    this.set(t.id, 'Position', udim2([t.basePos[0], t.basePos[1] + v.dx, t.basePos[2], t.basePos[3] + v.dy]), ops)
    this.set(t.id, 'Size', udim2([t.baseSize[0] * v.sx, t.baseSize[1] * v.sx, t.baseSize[2] * v.sy, t.baseSize[3] * v.sy]), ops)
    this.set(t.id, 'Rotation', r3(t.baseRot + v.rot), ops)
    const glow = t.fx.find((e) => e.kind === 'glow')
    if (t.glowId && glow && glow.kind === 'glow') {
      const g = Math.min(1, v.glow)
      this.set(t.glowId, 'Thickness', r3(glow.thickness * v.glow), ops)
      this.set(t.glowId, 'Transparency', r3(1 - g * glow.opacity), ops)
    }
    if (t.shineId && t.shineGradId) {
      this.set(t.shineId, 'Visible', v.shine != null, ops)
      if (v.shine != null) this.set(t.shineGradId, 'Offset', { t: 'Vector2', v: [r3(v.shine), 0] }, ops)
    }
    const ripple = t.fx.find((e) => e.kind === 'ripple')
    if (ripple && ripple.kind === 'ripple') {
      while (t.ripples.length < v.ripples.length) {
        const id = this.add('Frame', 'ForgeMotionRipple', t.id, { AnchorPoint: { t: 'Vector2', v: [0.5, 0.5] }, BackgroundColor3: { t: 'Color3', v: ripple.color }, BackgroundTransparency: 1, Size: udim2([0, 0, 0, 0]), ZIndex: 6 }, ops)
        this.add('UICorner', 'UICorner', id, { CornerRadius: { t: 'UDim', v: [0.5, 0] } }, ops)
        t.ripples.push(id)
        this.set(t.id, 'ClipsDescendants', true, ops)
      }
      while (t.ripples.length > v.ripples.length) this.remove(t.ripples.shift()!, ops)
      v.ripples.forEach((r, i) => {
        const id = t.ripples[i]
        this.set(id, 'Position', udim2([0, r.x, 0, r.y]), ops)
        this.set(id, 'Size', udim2([0, r.d, 0, r.d]), ops)
        this.set(id, 'BackgroundTransparency', r3(1 - r.a), ops)
      })
      if (!v.ripples.length && t.ripples.length === 0) this.set(t.id, 'ClipsDescendants', false, ops)
    }
    void s
  }

  private rectOf(id: number): { x: number; y: number; w: number; h: number } | null {
    const r = this.rects.get(id)
    return r ? { x: r[0], y: r[1], w: r[2], h: r[3] } : null
  }

  input(m: UiInput): void {
    if (m.type === 'layout') {
      for (const [k, r] of Object.entries(m.rects)) this.rects.set(Number(k), r)
      for (const s of this.slots) for (const t of s.targets) {
        const r = this.rectOf(t.id)
        if (r) s.engine.setRect(t.path, r)
      }
      return
    }
    if (m.type === 'control') {
      this.values[m.key] = m.value
      if (m.key === 'Trigger') {
        const action = /^(appear|disappear)/.exec(String(m.value))?.[1] as 'appear' | 'disappear' | undefined
        if (action) for (const s of this.slots) s.engine.play(action)
        return
      }
      const ops: UiOp[] = []
      this.build(ops)
      this.send({ session: this.session, type: 'ops', ops })
      return
    }
    const at = 'x' in m && typeof m.x === 'number' && typeof m.y === 'number'
    if (at) this.mouse = { x: (m as { x: number }).x, y: (m as { y: number }).y }
    if (m.type === 'move' || m.type === 'enter' || m.type === 'leave') {
      for (const s of this.slots) {
        s.engine.move(this.mouse.x, this.mouse.y)
        const r = this.rectOf(s.root)
        // A leave with no position: the pointer left the stage.
        s.hovered = !at ? false : !!r && this.mouse.x >= r.x && this.mouse.x <= r.x + r.w && this.mouse.y >= r.y && this.mouse.y <= r.y + r.h
        for (const t of s.targets) s.engine.hover(t.path, s.hovered)
      }
      return
    }
    if (m.type === 'down') {
      const s = this.slots.find((x) => x.hovered)
      if (!s) return
      this.pressed = s
      for (const t of s.targets) s.engine.press(t.path, true)
      return
    }
    if (m.type === 'up') {
      const s = this.pressed
      this.pressed = null
      if (s) for (const t of s.targets) s.engine.press(t.path, false)
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

// ---------------------------------------------------------------- frames for the mock critique

function frameSvg(v: MotionValues, label: string): string {
  const w = 220 * v.scale * v.sx
  const h = 64 * v.scale * v.sy
  const x = 160 - w / 2 + v.dx
  const y = 100 - h / 2 + v.dy
  const glow = v.glow > 0.05 ? `<rect x="${x - 3}" y="${y - 3}" width="${w + 6}" height="${h + 6}" rx="${h / 2 + 3}" fill="none" stroke="#ffd36b" stroke-opacity="${Math.min(1, v.glow)}" stroke-width="${3 * v.glow}"/>` : ''
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="#0b0d10"/>${glow}<g transform="rotate(${v.rot} 160 100)"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="#2f9bff"/><text x="160" y="${106 + v.dy}" text-anchor="middle" font-family="monospace" font-weight="700" font-size="${18 * v.scale}" fill="#fff">PLAY</text></g><text x="10" y="190" font-family="monospace" font-size="11" fill="#888">${label}</text></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

export function uiMotionMock(emit: Emit): UiMotionApi {
  const changed = () => emit('uimotion:changed', { at: Date.now() })
  const components: MockComponent[] = [importNode(figma.document as unknown as FigmaNode, 'PlayButton', 'figma-plugin', 'Figma plugin: Shop UI / Play Button', t0)]
  const entries: UiMotionEntry[] = []
  const files = new Map<string, string>()
  let token = false

  const find = (id: string) => {
    const e = entries.find((x) => x.id === id)
    if (!e) throw new Error(`no motion stack "${id}"`)
    return e
  }
  const put = (spec: MotionSpec, opts: { id?: string; origin?: string; scope?: 'user' | 'project'; component?: string; name?: string } = {}): UiMotionEntry => {
    const prev = opts.id ? find(opts.id) : null
    const s = normalizeSpec(spec, opts.name ?? prev?.name ?? 'Motion')
    if (opts.name) s.name = luauName(opts.name)
    const now = Math.max(Date.now(), t0 + entries.length * 3_600_000)
    const entry: UiMotionEntry = {
      ...(prev ?? { createdAt: now, thumbs: [], tags: [], origin: opts.origin ?? 'manual' }),
      id: prev?.id ?? `${s.name.toLowerCase()}-${(entries.length + 1).toString(36)}`,
      scope: prev?.scope ?? opts.scope ?? 'project',
      name: s.name,
      description: describeSpec(s).slice(0, 300),
      updatedAt: now,
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.component ? { component: opts.component } : {}),
      spec: s
    } as UiMotionEntry
    if (prev) entries.splice(entries.indexOf(prev), 1, entry)
    else entries.unshift(entry)
    return entry
  }
  const critiqueOf = (e: UiMotionEntry, vision?: UiMotionVision, frames: string[] = []) => buildCritique(e.spec, e.origin === 'manual' ? '' : e.origin, { at: Date.now(), vision, weights: mockPrincipleWeights(), frames })

  // Seed: three stacks on the imported button.
  {
    const a = put(presetSpec('bouncy', '', 'PlayBouncy'), { origin: 'playful play button that bounces when clicked', component: 'PlayButton', scope: 'project' })
    a.critique = critiqueOf(a)
    a.rating = 'up'
    a.quality = 'good'
    const b = put(presetSpec('juicy', '', 'ShopJuicy'), { origin: 'juicy shop buy button with shine and glow', component: 'PlayButton', scope: 'project' })
    b.critique = critiqueOf(b)
    put(presetSpec('soft', '', 'MenuSoft'), { origin: 'calm menu button', component: 'PlayButton', scope: 'user' })
  }

  // The lab story for the UI Preview mock.
  mockStorySources.push({
    current: null as LabSession | null,
    open(request: UiOpenRequest, session: number, send: (e: UiPreviewEvent) => void): UiSessionState | null {
      const m = /^\.forge\/uimotion\/lab\/([A-Za-z0-9_]+)\.story\.luau$/.exec(request.file)
      if (!m) return null
      const comp = components.find((c) => c.ref.name === m[1]) ?? components[0]
      this.current?.close()
      const lab = new LabSession(comp, session, send, request.controls ?? {})
      this.current = lab
      return {
        session,
        file: request.file,
        status: 'running',
        kind: 'generic',
        controls: ['Slots', 'Spec1', 'Spec2', 'Spec3', 'Label1', 'Label2', 'Label3', 'Trigger', 'Reduced'].map((key) => ({ key, type: key === 'Slots' ? 'Number' : key === 'Reduced' ? 'Boolean' : 'String', value: lab.values[key] }) as UiSessionState['controls'][number]),
        values: { ...lab.values },
        tree: lab.snapshot(),
        console: [{ at: Date.now(), level: 'print', text: `[motion lab] ${comp.ref.name}: browser preview (TS spring engine; the desktop app runs the generated Luau in Lune)` }],
        modules: [request.file, comp.ref.module]
      }
    },
    input(message: UiInput) {
      this.current?.input(message)
    },
    close() {
      this.current?.close()
      this.current = null
    }
  } as { current: LabSession | null } & (typeof mockStorySources)[number])

  const importResult = (c: MockComponent): FigmaImportResult => ({
    component: c.ref,
    files: [...c.report.images.map((i) => i.file), c.ref.module, c.ref.story!],
    report: c.report,
    warnings: []
  })

  return {
    async uiMotionStatus() {
      return { projectRoot: '/mock/project', compose: true, vision: true, lune: true, figmaToken: token, entries: { user: entries.filter((e) => e.scope === 'user').length, project: entries.filter((e) => e.scope === 'project').length }, uiDir: 'src/shared/Interface' }
    },
    async uiMotionList() {
      return structuredClone(entries)
    },
    async uiMotionGet(id) {
      return structuredClone(find(id))
    },
    async uiMotionSave(spec, opts) {
      const e = put(spec, opts ?? {})
      changed()
      return structuredClone(e)
    },
    async uiMotionDelete(id) {
      const i = entries.findIndex((e) => e.id === id)
      if (i >= 0) entries.splice(i, 1)
      changed()
      return i >= 0
    },
    async uiMotionRate(id, rating) {
      const e = find(id)
      if (rating) e.rating = rating
      else delete e.rating
      e.quality = rating === 'up' ? 'good' : rating === 'down' ? 'avoid' : undefined
      recordPrincipleRating('uimotion', e.id, e.name, rating, e.critique?.principles ?? critiqueOf(e).principles)
      changed()
      return structuredClone(e)
    },
    async uiMotionComponents() {
      return components.map((c) => structuredClone(c.ref))
    },
    async uiMotionImportFigmaDoc(json, opts) {
      await delay(400)
      const doc = parseForgeFigmaDoc(json)
      const c = importNode(doc.root, opts?.name, 'figma-plugin', `Figma plugin: ${doc.source.nodeName}`, Date.now())
      components.splice(0, components.length, c, ...components.filter((x) => x.ref.name !== c.ref.name))
      changed()
      return importResult(c)
    },
    async uiMotionImportFigmaUrl(url, opts) {
      const link = parseFigmaUrl(url)
      if (!link) throw new Error('Not a Figma link. Copy it with right-click > Copy/Paste as > Copy link to selection.')
      if (!link.nodeId) throw new Error('The link has no node-id: select the frame or component in Figma and use "Copy link to selection".')
      if (!token) throw new Error('No Figma token: add one under Settings > Integrations > Figma (or use the Figma plugin and paste its JSON).')
      await delay(700)
      // The browser preview has no network: the link imports the fixture button under its name.
      const c = importNode(figma.document as unknown as FigmaNode, opts?.name || link.name || 'PlayButton', 'figma-link', `Figma file ${link.fileKey}, node ${link.nodeId}`, Date.now())
      components.splice(0, components.length, c, ...components.filter((x) => x.ref.name !== c.ref.name))
      changed()
      return importResult(c)
    },
    async uiMotionFigmaToken() {
      return { set: token, canStore: true }
    },
    async uiMotionSetFigmaToken(t) {
      if (!/^[A-Za-z0-9_-]{20,200}$/.test(String(t).trim())) throw new Error('That does not look like a Figma personal access token (figd_...).')
      token = true
      changed()
      return { set: true, canStore: true }
    },
    async uiMotionClearFigmaToken() {
      token = false
      changed()
      return { set: false, canStore: true }
    },
    async uiMotionTestFigmaToken() {
      await delay(300)
      return token ? { ok: true, message: 'Token works (signed in as mock-designer).' } : { ok: false, message: 'No Figma token set.' }
    },
    async uiMotionLabStory(subject) {
      return { file: `.forge/uimotion/lab/${luauName(subject.name)}.story.luau` }
    },
    async uiMotionCompose(brief, opts) {
      await delay(900)
      const h = heuristicStack(brief)
      const comp = opts?.component ? components.find((c) => c.ref.name === opts.component) : null
      const e = put({ ...h.spec, name: luauName(`${comp?.ref.name ?? ''} ${brief.split(/\s+/).slice(0, 2).join(' ')}`) }, { origin: brief, ...(comp ? { component: comp.ref.name } : {}) })
      if (opts?.restatement) e.restatement = opts.restatement
      changed()
      return { entry: structuredClone(e), source: 'model', notes: [`started from the ${h.preset} preset; tuned for "${brief}"`] }
    },
    async uiMotionCritique(id, opts) {
      await delay(1100)
      const e = find(id)
      const checks = critiqueOf(e).checks
      const changes: UiMotionChange[] = []
      for (const c of checks) {
        if (c.score >= 7) continue
        const fx = (k: string) => e.spec.targets[0]?.effects.find((x) => x.kind === k) as (MotionEffect & Record<string, number>) | undefined
        if (c.id === 'ui-overshoot') for (const k of ['pop', 'hover', 'press']) if (fx(k) && fx(k)!.damping < 0.55) changes.push({ path: '', kind: k as UiMotionChange['kind'], field: 'damping', value: 0.6, principle: c.id, why: 'settle in one bounce' })
        if (c.id === 'ui-responsiveness' && fx('hover')) changes.push({ path: '', kind: 'hover', field: 'frequency', value: Math.max(4, fx('hover')!.frequency + 1.5), principle: c.id, why: 'half-response under 100 ms' })
        if (c.id === 'ui-anticipation') changes.push({ path: '', kind: 'press', field: 'add', value: { scale: 0.94 }, principle: c.id, why: 'press in before the release' })
      }
      const avg = checks.reduce((s, c) => s + c.score, 0) / Math.max(1, checks.length)
      const eng = new MotionEngine(e.spec)
      const path = e.spec.targets[0]?.path ?? ''
      eng.setRect(path, { x: 50, y: 68, w: 220, h: 64 })
      eng.move(200, 90)
      const shots: string[] = []
      const labels = ['rest', 'hover', 'pressed', 'released', 'settled']
      const steps: [number, () => void][] = [[0.3, () => undefined], [0.25, () => eng.hover(path, true)], [0.12, () => eng.press(path, true)], [0.07, () => eng.press(path, false)], [0.6, () => undefined]]
      steps.forEach(([t, act], i) => {
        act()
        for (let k = 0; k < t * 120; k++) eng.step(1 / 120)
        shots.push(`frames/critique-${i + 1}.png`)
        files.set(`${id}/frames/critique-${i + 1}.png`, frameSvg(eng.values(path), labels[i]))
      })
      const vision: UiMotionVision = {
        overall: Math.round(Math.min(9.2, avg * 0.9 + 0.6) * 10) / 10,
        summary: changes.length ? 'Readable and quick on hover, but the release rings longer than a button should; the label wobbles for several frames after the click.' : 'Crisp feedback on hover and press, a single small overshoot and the label stays readable throughout.',
        scores: { feedback: Math.round(checks.find((c) => c.id === 'ui-responsiveness')!.score * 10) / 10, feel: 7.8, restraint: Math.round(checks.find((c) => c.id === 'ui-overshoot')!.score * 10) / 10, polish: 7.2 },
        changes
      }
      const critique = critiqueOf(e, vision, shots)
      let applied: string[] = []
      if (opts?.apply && critique.vision?.changes.length) {
        const r = applyChanges(e.spec, critique.vision.changes)
        e.spec = r.spec
        e.description = describeSpec(r.spec)
        applied = r.applied
      }
      e.critique = critique
      e.thumbs = [shots[1]]
      changed()
      return { entry: structuredClone(e), critique, applied }
    },
    async uiMotionExport(id, opts) {
      await delay(300)
      const e = find(id)
      const comp = opts?.component ?? e.component
      const module = `src/shared/Interface/Motion/${e.name}Effects.luau`
      const story = comp ? `src/shared/Interface/Stories/${comp}${e.name}.story.luau` : undefined
      e.written = { module, ...(story ? { story } : {}), at: Date.now() }
      changed()
      return { files: [module, ...(story ? [story] : [])], module, ...(story ? { story } : {}), requirePath: `game:GetService("ReplicatedStorage").Shared.Interface.Motion.${e.name}Effects`, warnings: [] }
    },
    async uiMotionSnap() {
      return null
    },
    async uiMotionFile(id, file) {
      return files.get(`${id}/${file}`) ?? null
    }
  }
}
