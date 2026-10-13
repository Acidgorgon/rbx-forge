// UI preview protocol: the JSON lines resources/lune/preview.luau prints, the input messages it
// reads, and PreviewTree, which folds ops into an instance tree. Pure; used by main (session state,
// the preview_ui tool) and the renderer (the UI Preview page).

export const UI_PROTOCOL = 1

export type UDim2Value = { t: 'UDim2'; v: [number, number, number, number] }
export type UDimValue = { t: 'UDim'; v: [number, number] }
export type Vector2Value = { t: 'Vector2'; v: [number, number] }
export type Vector3Value = { t: 'Vector3'; v: [number, number, number] }
export type Color3Value = { t: 'Color3'; v: [number, number, number] }
export type EnumValue = { t: 'Enum'; e: string; v: string }
export type FontValue = { t: 'Font'; family: string; weight: string; style: string }
export type ColorSequenceValue = { t: 'ColorSequence'; v: [number, number, number, number][] }
export type NumberSequenceValue = { t: 'NumberSequence'; v: [number, number][] }
export type RectValue = { t: 'Rect'; v: [number, number, number, number] }
export type InstanceRef = { t: 'Instance'; id: number }

export type UiValue =
  | number
  | string
  | boolean
  | UDim2Value
  | UDimValue
  | Vector2Value
  | Vector3Value
  | Color3Value
  | EnumValue
  | FontValue
  | ColorSequenceValue
  | NumberSequenceValue
  | RectValue
  | InstanceRef

export type UiProps = Record<string, UiValue>

export interface UiNode {
  id: number
  cls: string
  name: string
  parent: number | null
  props: UiProps
  // Child ids in the order they were parented (Roblox's GetChildren order).
  children: number[]
  // Full name from the DataModel, e.g. Players.Player1.PlayerGui.ForgePreview.StoryTarget.RacingHud
  path?: string
}

export type UiOp =
  | { op: 'create'; id: number; cls: string; name: string; parent?: number | null; props?: UiProps; path?: string }
  | { op: 'set'; id: number; k: string; v: UiValue }
  | { op: 'parent'; id: number; parent?: number | null }
  | { op: 'destroy'; id: number }

export type UiControlType = 'String' | 'Number' | 'Boolean' | 'Color3' | 'Slider' | 'Choose' | 'EnumList' | 'RGBA' | 'Object' | 'Unsupported'

export interface UiControl {
  key: string
  group?: string
  type: UiControlType
  // String/Number/Boolean/Slider: the literal; Color3: Color3Value; Choose: 1-based index;
  // EnumList: option key; RGBA: { color, transparency }.
  value?: unknown
  min?: number
  max?: number
  step?: number
  options?: string[]
  order?: number
}

export type UiStoryKind = 'vide' | 'function' | 'generic' | 'unsupported' | 'error'

export interface UiErrorLocation {
  file: string
  line: number
}

export type UiPreviewLine =
  | { type: 'story'; kind: UiStoryKind; file: string; controls: UiControl[]; path?: string }
  | { type: 'ops'; ops: UiOp[] }
  | { type: 'log'; level: 'print' | 'warn' | 'error'; text: string }
  | { type: 'error'; message: string; traceback?: string }
  | { type: 'frame'; n: number }
  | { type: 'modules'; files: string[] }
  | { type: 'storybooks'; storybooks: RawStorybook[]; stories: RawStory[] }
  | { type: 'fatal'; message: string }

export interface RawStorybook {
  file: string
  path: string[]
  name?: string
  groupRoots?: boolean
  roots?: string[]
  error?: string
}

export interface RawStory {
  file: string
  path: string[]
}

// Messages Forge writes to the preview's stdin.
export type UiInput =
  | { type: 'click' | 'rightclick'; id: number; x?: number; y?: number }
  | { type: 'down' | 'up'; id?: number; x?: number; y?: number }
  | { type: 'enter' | 'leave' | 'move'; id?: number; x?: number; y?: number }
  | { type: 'focus'; id: number }
  | { type: 'blur'; id: number; enter?: boolean }
  | { type: 'text'; id: number; text: string }
  | { type: 'scroll'; id: number; x: number; y: number }
  | { type: 'key'; key: string; down: boolean }
  | { type: 'resize'; width: number; height: number }
  | { type: 'device'; device: string }
  | { type: 'layout'; rects: Record<string, [number, number, number, number]> }
  | { type: 'control'; key: string; group?: string; value: unknown }
  | { type: 'set'; id: number; k: string; v: UiValue }
  | { type: 'quit' }

function isObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x)
}

// One stdout line -> event, or null for anything that is not a protocol line.
export function parsePreviewLine(line: string): UiPreviewLine | null {
  const text = line.trim()
  if (!text.startsWith('{')) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(raw) || raw.forge !== UI_PROTOCOL || typeof raw.type !== 'string') return null
  switch (raw.type) {
    case 'ops':
      return { type: 'ops', ops: Array.isArray(raw.ops) ? (raw.ops.filter(isObject) as unknown as UiOp[]) : [] }
    case 'story':
      return {
        type: 'story',
        kind: (['vide', 'function', 'generic', 'unsupported', 'error'].includes(String(raw.kind)) ? raw.kind : 'error') as UiStoryKind,
        file: String(raw.file ?? ''),
        controls: Array.isArray(raw.controls) ? (raw.controls.filter(isObject) as unknown as UiControl[]) : [],
        ...(typeof raw.path === 'string' ? { path: raw.path } : {})
      }
    case 'log':
      return { type: 'log', level: raw.level === 'warn' ? 'warn' : raw.level === 'error' ? 'error' : 'print', text: String(raw.text ?? '') }
    case 'error':
      return { type: 'error', message: String(raw.message ?? ''), ...(typeof raw.traceback === 'string' ? { traceback: raw.traceback } : {}) }
    case 'frame':
      return { type: 'frame', n: typeof raw.n === 'number' ? raw.n : 0 }
    case 'modules':
      return { type: 'modules', files: Array.isArray(raw.files) ? raw.files.map(String) : [] }
    case 'storybooks':
      return {
        type: 'storybooks',
        storybooks: Array.isArray(raw.storybooks) ? (raw.storybooks.filter(isObject) as unknown as RawStorybook[]) : [],
        stories: Array.isArray(raw.stories) ? (raw.stories.filter(isObject) as unknown as RawStory[]) : []
      }
    case 'fatal':
      return { type: 'fatal', message: String(raw.message ?? '') }
  }
  return null
}

// First "path/file.luau:12" in an error message or traceback, skipping Forge's own runtime and
// (when possible) Wally packages, so the console links to the user's code.
export function errorLocation(text: string): UiErrorLocation | null {
  const re = /([A-Za-z0-9_@.\-/\\ ]+?\.luau?):(\d+)/g
  let fallback: UiErrorLocation | null = null
  for (const m of text.matchAll(re)) {
    const file = m[1].trim().replace(/\\/g, '/').replace(/^\.\//, '')
    if (/resources\/lune\/|^\/.*\/(preview|world|gui)$|forge\/(world|gui|signal)/.test(file)) continue
    const loc = { file, line: Number(m[2]) }
    if (/^(Server)?Packages\//.test(file)) {
      fallback ??= loc
      continue
    }
    return loc
  }
  return fallback
}

// The instance tree, folded from ops.
export class PreviewTree {
  nodes = new Map<number, UiNode>()
  root: number | null = null
  // Bumped on every applied batch; the renderer memoizes layout on it.
  version = 0

  apply(ops: UiOp[]): void {
    for (const op of ops) this.applyOne(op)
    this.version++
  }

  private detach(node: UiNode): void {
    if (node.parent == null) return
    const parent = this.nodes.get(node.parent)
    if (parent) parent.children = parent.children.filter((c) => c !== node.id)
    node.parent = null
  }

  private applyOne(op: UiOp): void {
    switch (op.op) {
      case 'create': {
        const existing = this.nodes.get(op.id)
        if (existing) this.removeSubtree(existing)
        const node: UiNode = { id: op.id, cls: op.cls, name: op.name, parent: null, props: { ...(op.props ?? {}) }, children: [], ...(op.path ? { path: op.path } : {}) }
        this.nodes.set(op.id, node)
        if (op.parent != null && this.nodes.has(op.parent)) {
          node.parent = op.parent
          this.nodes.get(op.parent)!.children.push(op.id)
        } else if (this.root == null) {
          this.root = op.id
        }
        return
      }
      case 'set': {
        const node = this.nodes.get(op.id)
        if (!node) return
        if (op.k === 'Name') node.name = String(op.v)
        else node.props[op.k] = op.v
        return
      }
      case 'parent': {
        const node = this.nodes.get(op.id)
        if (!node) return
        this.detach(node)
        if (op.parent != null && this.nodes.has(op.parent)) {
          node.parent = op.parent
          this.nodes.get(op.parent)!.children.push(op.id)
        }
        return
      }
      case 'destroy': {
        const node = this.nodes.get(op.id)
        if (node) this.removeSubtree(node)
        return
      }
    }
  }

  private removeSubtree(node: UiNode): void {
    this.detach(node)
    const stack = [node]
    while (stack.length) {
      const n = stack.pop()!
      this.nodes.delete(n.id)
      for (const c of n.children) {
        const child = this.nodes.get(c)
        if (child) stack.push(child)
      }
    }
  }

  get(id: number): UiNode | undefined {
    return this.nodes.get(id)
  }

  // Path from the story target down ("RacingHud.Speedometer.Speed"), the way users name things.
  relativePath(id: number): string {
    const parts: string[] = []
    let node = this.nodes.get(id)
    while (node && node.parent != null) {
      const parent = this.nodes.get(node.parent)
      if (!parent) break
      parts.unshift(node.name)
      if (parent.name === 'StoryTarget' && parent.parent === this.root) break
      node = parent
    }
    return parts.join('.')
  }

  snapshot(): UiTreeSnapshot {
    return { root: this.root, nodes: [...this.nodes.values()].map((n) => ({ ...n, props: { ...n.props }, children: [...n.children] })) }
  }

  static from(snapshot: UiTreeSnapshot): PreviewTree {
    const tree = new PreviewTree()
    tree.root = snapshot.root
    for (const n of snapshot.nodes) tree.nodes.set(n.id, { ...n, props: { ...n.props }, children: [...n.children] })
    tree.version = 1
    return tree
  }
}

export interface UiTreeSnapshot {
  root: number | null
  nodes: UiNode[]
}

// ---- value helpers

export const isTagged = <T extends Exclude<UiValue, number | string | boolean>['t']>(v: UiValue | undefined, t: T): v is Extract<UiValue, { t: T }> =>
  !!v && typeof v === 'object' && (v as { t?: string }).t === t

export function num(v: UiValue | undefined, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export function bool(v: UiValue | undefined, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback
}

export function str(v: UiValue | undefined, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

export function enumName(v: UiValue | undefined, fallback: string): string {
  return isTagged(v, 'Enum') ? v.v : fallback
}

export function udim2(v: UiValue | undefined): [number, number, number, number] {
  return isTagged(v, 'UDim2') ? v.v : [0, 0, 0, 0]
}

export function udim(v: UiValue | undefined): [number, number] {
  return isTagged(v, 'UDim') ? v.v : [0, 0]
}

export function vec2(v: UiValue | undefined, fallback: [number, number] = [0, 0]): [number, number] {
  return isTagged(v, 'Vector2') ? v.v : fallback
}

export function color(v: UiValue | undefined, fallback: [number, number, number] = [1, 1, 1]): [number, number, number] {
  return isTagged(v, 'Color3') ? v.v : fallback
}

// Luau source text for a value (Edit mode writes these into .luau files).
export function luauLiteral(v: UiValue): string | null {
  const n = (x: number) => {
    const r = Math.round(x * 1000) / 1000
    return Object.is(r, -0) ? '0' : String(r)
  }
  if (typeof v === 'number') return n(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'string') return JSON.stringify(v).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => `\\u{${h}}`)
  switch (v.t) {
    case 'UDim2': {
      const [xs, xo, ys, yo] = v.v
      if (xs === 0 && ys === 0) return `UDim2.fromOffset(${n(xo)}, ${n(yo)})`
      if (xo === 0 && yo === 0) return `UDim2.fromScale(${n(xs)}, ${n(ys)})`
      return `UDim2.new(${n(xs)}, ${n(xo)}, ${n(ys)}, ${n(yo)})`
    }
    case 'UDim':
      return `UDim.new(${n(v.v[0])}, ${n(v.v[1])})`
    case 'Vector2':
      return `Vector2.new(${n(v.v[0])}, ${n(v.v[1])})`
    case 'Color3': {
      const [r, g, b] = v.v.map((c) => Math.round(c * 255))
      return `Color3.fromRGB(${r}, ${g}, ${b})`
    }
    case 'Enum':
      return `Enum.${v.e}.${v.v}`
  }
  return null
}
