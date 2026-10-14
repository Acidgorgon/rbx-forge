// Reads part tweens out of an imported effect's scripts, so slash meshes, shockwave rings and
// spheres that grow, fade and move in game do the same in the preview. A small, forgiving reader for
// the common patterns, not a Luau interpreter:
//
//   TweenService:Create(part, TweenInfo.new(0.4, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
//     { Size = Vector3.new(10, 0.2, 10), Transparency = 1, CFrame = part.CFrame * CFrame.Angles(0, math.rad(180), 0) }):Play()
//   local tw = TS:Create(ring.Mesh, info, goal); ...; tw:Play()
//   part.Transparency = 0          (an instant 'set')
//   task.wait(0.2) / wait(0.2)     (advances the clock)
//   task.delay(0.3, function() ... end), task.spawn(function() ... end)   (own clock, restored after)
//   for _, v in model:GetDescendants() do ... end    (v = every descendant; goals apply where the
//                                                     class can take them, e.g. BaseParts)
// Targets resolve through script.Parent / .Parent / names / FindFirstChild / WaitForChild / :Clone()
// and locals. Values: numbers with + - * / ^ and math.*, Vector3.new / .one / .zero, Color3.new /
// fromRGB / fromHSV, CFrame.new / Angles / fromEulerAnglesXYZ / fromOrientation, and a node's own
// Size / CFrame / Position / Transparency / Color. Anything else is skipped (never guessed).
// TweenInfo: time, style, direction, repeatCount (ignored), reverses (ignored), delayTime.
// Pure code.

import { mul, point, rotate } from './cframe.ts'
import { SCRIPT_CLASSES } from './schema.ts'
import { easingDirection, easingStyle, tweenKind, VIRTUAL_PROPS } from './timeline.ts'
import type { CFrameArr, EasingDirection, EasingStyle, PropValue, Rgb, Vec3, VfxCue, VfxNode } from './types.ts'

type Val =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'vec3'; v: Vec3 }
  | { k: 'cf'; v: CFrameArr }
  | { k: 'color'; v: Rgb }
  | { k: 'enum'; v: string }
  | { k: 'nodes'; v: VfxNode[] }
  | { k: 'info'; duration: number; style: EasingStyle; direction: EasingDirection; delay: number }
  | { k: 'table'; v: Map<string, Val> }
  | { k: 'tween'; targets: VfxNode[]; info: Extract<Val, { k: 'info' }>; goal: Map<string, Val> }
  | { k: 'path'; v: string[] }
  | { k: 'unknown' }

const UNKNOWN: Val = { k: 'unknown' }

// ------------------------------------------------------------------ tokens

type Tok = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'id'; v: string } | { t: 'op'; v: string }

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    const num = /^(?:0x[0-9a-f]+|\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)/i.exec(src.slice(i))
    if (num) {
      out.push({ t: 'num', v: Number(num[0]) })
      i += num[0].length
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let s = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++
        s += src[j] ?? ''
        j++
      }
      out.push({ t: 'str', v: s })
      i = j + 1
      continue
    }
    const id = /^[A-Za-z_]\w*/.exec(src.slice(i))
    if (id) {
      out.push({ t: 'id', v: id[0] })
      i += id[0].length
      continue
    }
    const op = /^(?:==|~=|<=|>=|\.\.|::|[-+*/^%(),.:[\]{}=;#<>])/.exec(src.slice(i))
    out.push({ t: 'op', v: op ? op[0] : c })
    i += op ? op[0].length : 1
  }
  return out
}

// ------------------------------------------------------------------ math helpers

function rx(a: number): CFrameArr {
  const c = Math.cos(a), s = Math.sin(a)
  return [0, 0, 0, 1, 0, 0, 0, c, -s, 0, s, c]
}
function ry(a: number): CFrameArr {
  const c = Math.cos(a), s = Math.sin(a)
  return [0, 0, 0, c, 0, s, 0, 1, 0, -s, 0, c]
}
function rz(a: number): CFrameArr {
  const c = Math.cos(a), s = Math.sin(a)
  return [0, 0, 0, c, -s, 0, s, c, 0, 0, 0, 1]
}
// CFrame.Angles / fromEulerAnglesXYZ: X * Y * Z.
export function anglesXYZ(x: number, y: number, z: number): CFrameArr {
  return mul(mul(rx(x), ry(y)), rz(z))
}
// CFrame.fromOrientation / fromEulerAnglesYXZ: Y * X * Z.
export function anglesYXZ(x: number, y: number, z: number): CFrameArr {
  return mul(mul(ry(y), rx(x)), rz(z))
}

function hsv(h: number, s: number, v: number): Rgb {
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s)
  const m = ((i % 6) + 6) % 6
  return ([[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][m] as Rgb)
}

// ------------------------------------------------------------------ scope

interface Scope {
  vars: Map<string, Val>
  script: VfxNode
  parentOf: Map<string, VfxNode | null>
  all: VfxNode[]
}

function byName(nodes: VfxNode[], name: string, deep: boolean): VfxNode[] {
  const out: VfxNode[] = []
  for (const n of nodes) {
    const direct = n.children.filter((c) => c.name === name)
    if (direct.length) out.push(...direct)
    else if (deep) {
      const walk = (x: VfxNode) => x.children.forEach((c) => (c.name === name ? out.push(c) : walk(c)))
      walk(n)
    }
  }
  return out
}

function descendants(nodes: VfxNode[]): VfxNode[] {
  const out: VfxNode[] = []
  const walk = (n: VfxNode) => n.children.forEach((c) => (out.push(c), walk(c)))
  nodes.forEach(walk)
  return out
}

// Reading a property of a node (one node: its value; several: unknown).
function nodeProp(nodes: VfxNode[], key: string, scope: Scope): Val {
  if (key === 'Parent') {
    const ps = [...new Set(nodes.map((n) => scope.parentOf.get(n.id)).filter((x): x is VfxNode => !!x))]
    return ps.length ? { k: 'nodes', v: ps } : UNKNOWN
  }
  if (nodes.length === 1) {
    const p = nodes[0].props
    const v = p[key]
    if (key === 'Position' && Array.isArray(p.CFrame)) return { k: 'vec3', v: (p.CFrame as number[]).slice(0, 3) as Vec3 }
    if (key === 'CFrame') return { k: 'cf', v: Array.isArray(v) && v.length === 12 ? (v as CFrameArr) : [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }
    if ((key === 'Size' || key === 'Scale' || key === 'Offset' || key === 'VertexColor') && Array.isArray(v) && v.length === 3) return { k: 'vec3', v: v as Vec3 }
    if (key === 'Size' && v === undefined) return { k: 'vec3', v: nodes[0].className === 'Part' ? [4, 1, 2] : [1, 1, 1] }
    if (key === 'Scale' && v === undefined) return { k: 'vec3', v: [1, 1, 1] }
    if (key === 'Offset' && v === undefined) return { k: 'vec3', v: [0, 0, 0] }
    if (key === 'Color' && Array.isArray(v) && v.length === 3 && typeof v[0] === 'number') return { k: 'color', v: v as Rgb }
    if (typeof v === 'number') return { k: 'num', v }
    if (key === 'Transparency' && v === undefined) return { k: 'num', v: 0 }
  }
  // A child by name (part.Mesh, model.Ring).
  const kids = byName(nodes, key, false)
  return kids.length ? { k: 'nodes', v: kids } : UNKNOWN
}

// ------------------------------------------------------------------ expressions

class Parser {
  private toks: Tok[]
  private i = 0
  private scope: Scope
  constructor(toks: Tok[], scope: Scope) {
    this.toks = toks
    this.scope = scope
  }
  get done(): boolean {
    return this.i >= this.toks.length
  }
  peek(o = 0): Tok | undefined {
    return this.toks[this.i + o]
  }
  isOp(v: string, o = 0): boolean {
    const t = this.peek(o)
    return !!t && t.t === 'op' && t.v === v
  }
  isId(v: string, o = 0): boolean {
    const t = this.peek(o)
    return !!t && t.t === 'id' && t.v === v
  }
  eat(v: string): boolean {
    if (this.isOp(v)) {
      this.i++
      return true
    }
    return false
  }
  next(): Tok | undefined {
    return this.toks[this.i++]
  }
  rest(): Tok[] {
    return this.toks.slice(this.i)
  }

  expr(): Val {
    let a = this.term()
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next()!.v as string
      a = arith(op, a, this.term())
    }
    return a
  }
  term(): Val {
    let a = this.unary()
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next()!.v as string
      a = arith(op, a, this.unary())
    }
    return a
  }
  unary(): Val {
    if (this.eat('-')) {
      const v = this.unary()
      return arith('*', v, { k: 'num', v: -1 })
    }
    if (this.isId('not')) {
      this.i++
      this.unary()
      return UNKNOWN
    }
    const base = this.postfix()
    if (this.eat('^')) {
      const e = this.unary()
      return base.k === 'num' && e.k === 'num' ? { k: 'num', v: Math.pow(base.v, e.v) } : UNKNOWN
    }
    return base
  }
  args(close: string): Val[] {
    const out: Val[] = []
    if (this.eat(close)) return out
    for (let guard = 0; guard < 64 && !this.done; guard++) {
      out.push(this.expr())
      if (this.eat(',')) continue
      this.eat(close)
      break
    }
    return out
  }
  table(): Val {
    const m = new Map<string, Val>()
    let n = 1
    for (let guard = 0; guard < 128 && !this.done; guard++) {
      if (this.eat('}')) break
      if (this.peek()?.t === 'id' && this.isOp('=', 1)) {
        const key = String(this.next()!.v)
        this.i++
        m.set(key, this.expr())
      } else if (this.isOp('[') && this.peek(1)?.t === 'str' && this.isOp(']', 2) && this.isOp('=', 3)) {
        const key = String(this.peek(1)!.v)
        this.i += 4
        m.set(key, this.expr())
      } else m.set(String(n++), this.expr())
      if (!this.eat(',') && !this.eat(';')) {
        this.eat('}')
        break
      }
    }
    return { k: 'table', v: m }
  }
  primary(): Val {
    const t = this.next()
    if (!t) return UNKNOWN
    if (t.t === 'num') return { k: 'num', v: t.v }
    if (t.t === 'str') return { k: 'str', v: t.v }
    if (t.t === 'op' && t.v === '(') {
      const v = this.expr()
      this.eat(')')
      return v
    }
    if (t.t === 'op' && t.v === '{') return this.table()
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') return { k: 'bool', v: t.v === 'true' }
      if (t.v === 'nil') return UNKNOWN
      if (t.v === 'function') {
        // Skip an inline function body: unknown value.
        this.i = this.toks.length
        return UNKNOWN
      }
      if (t.v === 'script') return { k: 'nodes', v: [this.scope.script] }
      const local = this.scope.vars.get(t.v)
      if (local) return local
      return { k: 'path', v: [t.v] }
    }
    return UNKNOWN
  }
  postfix(): Val {
    let v = this.primary()
    for (let guard = 0; guard < 64; guard++) {
      if (this.isOp('.') && this.peek(1)?.t === 'id') {
        this.i++
        const key = String(this.next()!.v)
        v = member(v, key, this.scope)
      } else if (this.isOp(':') && this.peek(1)?.t === 'id' && this.isOp('(', 2)) {
        this.i++
        const name = String(this.next()!.v)
        this.i++
        v = method(v, name, this.args(')'), this.scope)
      } else if (this.isOp('(')) {
        this.i++
        v = call(v, this.args(')'))
      } else if (this.isOp('[')) {
        this.i++
        const k = this.expr()
        this.eat(']')
        v = k.k === 'str' ? member(v, k.v, this.scope) : UNKNOWN
      } else break
    }
    return v
  }
}

function arith(op: string, a: Val, b: Val): Val {
  if (a.k === 'num' && b.k === 'num') {
    const r = op === '+' ? a.v + b.v : op === '-' ? a.v - b.v : op === '*' ? a.v * b.v : op === '/' ? a.v / b.v : a.v % b.v
    return Number.isFinite(r) ? { k: 'num', v: r } : UNKNOWN
  }
  const vec = (x: Vec3, y: Vec3, f: (p: number, q: number) => number): Val => ({ k: 'vec3', v: [f(x[0], y[0]), f(x[1], y[1]), f(x[2], y[2])] })
  const fn = (p: number, q: number) => (op === '+' ? p + q : op === '-' ? p - q : op === '*' ? p * q : op === '/' ? p / q : NaN)
  if (a.k === 'vec3' && b.k === 'vec3') return vec(a.v, b.v, fn)
  if (a.k === 'vec3' && b.k === 'num' && (op === '*' || op === '/')) return vec(a.v, [b.v, b.v, b.v], fn)
  if (a.k === 'num' && b.k === 'vec3' && op === '*') return vec([a.v, a.v, a.v], b.v, fn)
  if (a.k === 'cf' && b.k === 'cf' && op === '*') return { k: 'cf', v: mul(a.v, b.v) }
  if (a.k === 'cf' && b.k === 'vec3' && op === '*') return { k: 'vec3', v: point(a.v, b.v) }
  if (a.k === 'cf' && b.k === 'vec3' && (op === '+' || op === '-')) {
    const s = op === '+' ? 1 : -1
    return { k: 'cf', v: [a.v[0] + s * b.v[0], a.v[1] + s * b.v[1], a.v[2] + s * b.v[2], ...a.v.slice(3)] }
  }
  if (a.k === 'color' && b.k === 'num' && op === '*') return { k: 'color', v: a.v.map((c) => c * b.v) as Rgb }
  return UNKNOWN
}

const GLOBALS = new Set(['game', 'workspace', 'Workspace', 'Vector3', 'CFrame', 'Color3', 'TweenInfo', 'Enum', 'math', 'task', 'TweenService', 'Instance', 'NumberSequence', 'ColorSequence'])

function member(v: Val, key: string, scope: Scope): Val {
  if (v.k === 'nodes') return nodeProp(v.v, key, scope)
  if (v.k === 'path') {
    const p = v.v
    if (p.length === 1 && p[0] === 'math') {
      if (key === 'pi') return { k: 'num', v: Math.PI }
      if (key === 'huge') return { k: 'num', v: 1e9 }
    }
    if (p[0] === 'Vector3' && p.length === 1) {
      if (key === 'one') return { k: 'vec3', v: [1, 1, 1] }
      if (key === 'zero') return { k: 'vec3', v: [0, 0, 0] }
      if (key === 'xAxis') return { k: 'vec3', v: [1, 0, 0] }
      if (key === 'yAxis') return { k: 'vec3', v: [0, 1, 0] }
      if (key === 'zAxis') return { k: 'vec3', v: [0, 0, 1] }
    }
    if (p[0] === 'CFrame' && p.length === 1 && key === 'identity') return { k: 'cf', v: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }
    if (p[0] === 'Enum' && p.length === 2) return { k: 'enum', v: key }
    // An unknown global name followed by a member: a path (Enum.EasingStyle, workspace.Fx...).
    if (p.length === 1 && !GLOBALS.has(p[0])) {
      // A bare name nobody declared: an instance by that name anywhere in the effect.
      const hits = scope.all.filter((n) => n.name === p[0])
      if (hits.length) return member({ k: 'nodes', v: hits }, key, scope)
    }
    if ((p[0] === 'workspace' || p[0] === 'Workspace') && p.length === 1) {
      const hits = scope.all.filter((n) => n.name === key)
      return hits.length ? { k: 'nodes', v: hits } : { k: 'path', v: [...p, key] }
    }
    return { k: 'path', v: [...p, key] }
  }
  if (v.k === 'cf') {
    if (key === 'Position' || key === 'p') return { k: 'vec3', v: [v.v[0], v.v[1], v.v[2]] }
    if (key === 'LookVector') return { k: 'vec3', v: rotate(v.v, [0, 0, -1]) }
    if (key === 'UpVector') return { k: 'vec3', v: rotate(v.v, [0, 1, 0]) }
    if (key === 'RightVector') return { k: 'vec3', v: rotate(v.v, [1, 0, 0]) }
  }
  if (v.k === 'vec3') {
    const i = ['X', 'Y', 'Z'].indexOf(key)
    if (i >= 0) return { k: 'num', v: v.v[i] }
    if (key === 'Magnitude') return { k: 'num', v: Math.hypot(...v.v) }
  }
  if (v.k === 'table') return v.v.get(key) ?? UNKNOWN
  return UNKNOWN
}

const nums = (args: Val[], n: number, dflt = 0): number[] => Array.from({ length: n }, (_, i) => (args[i]?.k === 'num' ? (args[i] as { v: number }).v : dflt))
const allNum = (args: Val[], n: number) => args.length >= n && args.slice(0, n).every((a) => a.k === 'num')

function call(fn: Val, args: Val[]): Val {
  if (fn.k !== 'path') return UNKNOWN
  const name = fn.v.join('.')
  switch (name) {
    case 'Vector3.new':
      return args.every((a) => a.k === 'num') ? { k: 'vec3', v: nums(args, 3) as Vec3 } : UNKNOWN
    case 'Color3.new':
      return args.every((a) => a.k === 'num') ? { k: 'color', v: nums(args, 3) as Rgb } : UNKNOWN
    case 'Color3.fromRGB':
      return args.every((a) => a.k === 'num') ? { k: 'color', v: nums(args, 3).map((c) => c / 255) as Rgb } : UNKNOWN
    case 'Color3.fromHSV':
      return allNum(args, 3) ? { k: 'color', v: hsv(...(nums(args, 3) as [number, number, number])) } : UNKNOWN
    case 'Color3.fromHex': {
      const s = args[0]?.k === 'str' ? args[0].v.replace('#', '') : ''
      return /^[0-9a-f]{6}$/i.test(s) ? { k: 'color', v: [0, 2, 4].map((o) => parseInt(s.slice(o, o + 2), 16) / 255) as Rgb } : UNKNOWN
    }
    case 'CFrame.new':
      if (!args.length) return { k: 'cf', v: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }
      if (args.length === 1 && args[0].k === 'vec3') return { k: 'cf', v: [...args[0].v, 1, 0, 0, 0, 1, 0, 0, 0, 1] }
      if (allNum(args, 12)) return { k: 'cf', v: nums(args, 12) }
      if (allNum(args, 3) && args.length === 3) return { k: 'cf', v: [...nums(args, 3), 1, 0, 0, 0, 1, 0, 0, 0, 1] }
      return UNKNOWN
    case 'CFrame.Angles':
    case 'CFrame.fromEulerAnglesXYZ':
      return allNum(args, 3) ? { k: 'cf', v: anglesXYZ(...(nums(args, 3) as [number, number, number])) } : UNKNOWN
    case 'CFrame.fromOrientation':
    case 'CFrame.fromEulerAnglesYXZ':
      return allNum(args, 3) ? { k: 'cf', v: anglesYXZ(...(nums(args, 3) as [number, number, number])) } : UNKNOWN
    case 'CFrame.fromAxisAngle':
      return UNKNOWN
    case 'TweenInfo.new': {
      const d = args[0]?.k === 'num' ? args[0].v : 1
      const style = args[1]?.k === 'enum' ? easingStyle(args[1].v) : 'Quad'
      const direction = args[2]?.k === 'enum' ? easingDirection(args[2].v) : 'Out'
      const delay = args[5]?.k === 'num' ? Math.max(0, args[5].v) : 0
      return { k: 'info', duration: Math.max(0, d), style, direction, delay }
    }
    case 'math.rad':
      return args[0]?.k === 'num' ? { k: 'num', v: (args[0].v * Math.PI) / 180 } : UNKNOWN
    case 'math.deg':
      return args[0]?.k === 'num' ? { k: 'num', v: (args[0].v * 180) / Math.PI } : UNKNOWN
    case 'math.sin':
    case 'math.cos':
    case 'math.abs':
    case 'math.sqrt':
    case 'math.floor':
    case 'math.ceil':
      return args[0]?.k === 'num' ? { k: 'num', v: (Math as any)[name.slice(5)](args[0].v) } : UNKNOWN
    case 'math.min':
    case 'math.max':
      return args.length && args.every((a) => a.k === 'num') ? { k: 'num', v: (Math as any)[name.slice(5)](...args.map((a) => (a as { v: number }).v)) } : UNKNOWN
    default:
      return UNKNOWN
  }
}

function method(self: Val, name: string, args: Val[], scope: Scope): Val {
  if (self.k === 'nodes') {
    if ((name === 'FindFirstChild' || name === 'WaitForChild' || name === 'FindFirstChildOfClass' || name === 'FindFirstChildWhichIsA') && args[0]?.k === 'str') {
      const key = args[0].v
      if (name === 'FindFirstChild' || name === 'WaitForChild') {
        const deep = args[1]?.k === 'bool' && args[1].v
        const hit = byName(self.v, key, deep)
        if (hit.length) return { k: 'nodes', v: hit.slice(0, 1) }
        const anywhere = scope.all.filter((n) => n.name === key)
        return anywhere.length ? { k: 'nodes', v: anywhere.slice(0, 1) } : UNKNOWN
      }
      const hit = self.v.flatMap((n) => n.children.filter((c) => c.className === key)).slice(0, 1)
      return hit.length ? { k: 'nodes', v: hit } : UNKNOWN
    }
    if (name === 'Clone') return self
    if (name === 'GetDescendants') return { k: 'nodes', v: descendants(self.v) }
    if (name === 'GetChildren') return { k: 'nodes', v: self.v.flatMap((n) => n.children) }
    return UNKNOWN
  }
  if (self.k === 'path') {
    if (name === 'GetService' && args[0]?.k === 'str') return { k: 'path', v: [args[0].v] }
    if (name === 'Create' && args.length >= 3) {
      const [target, info, goal] = args
      if (target.k === 'nodes' && info.k === 'info' && goal.k === 'table') return { k: 'tween', targets: target.v, info, goal: goal.v }
      return UNKNOWN
    }
  }
  if (self.k === 'cf') {
    if (name === 'Lerp' && args[0]?.k === 'cf' && args[1]?.k === 'num') return UNKNOWN
    if (name === 'Inverse') return UNKNOWN
    if (name === 'PointToWorldSpace' && args[0]?.k === 'vec3') return { k: 'vec3', v: point(self.v, args[0].v) }
  }
  return UNKNOWN
}

// ------------------------------------------------------------------ statements

// A tween / set goal -> the normalised property value for that node's class (null = cannot use).
export function goalValue(node: VfxNode, key: string, v: Val): PropValue | null {
  if (VIRTUAL_PROPS.has(key)) return null
  const kind = tweenKind(node.className, key)
  if (!kind) return null
  if (kind === 'number') return v.k === 'num' ? v.v : v.k === 'bool' ? (v.v ? 1 : 0) : null
  if (kind === 'vec3') return v.k === 'vec3' ? [...v.v] : v.k === 'color' && key === 'VertexColor' ? [...v.v] : null
  if (kind === 'color3' || kind === 'tint') return v.k === 'color' ? [...v.v] : null
  if (kind === 'cframe') return v.k === 'cf' ? [...v.v] : v.k === 'vec3' ? [...v.v, 1, 0, 0, 0, 1, 0, 0, 0, 1] : null
  return null
}

// Top-level `a = b` split (not inside brackets, not ==, ~=, <=, >=).
function splitAssign(toks: Tok[]): [Tok[], Tok[]] | null {
  let depth = 0
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.t !== 'op') continue
    if (t.v === '(' || t.v === '{' || t.v === '[') depth++
    else if (t.v === ')' || t.v === '}' || t.v === ']') depth--
    else if (t.v === '=' && depth === 0) return [toks.slice(0, i), toks.slice(i + 1)]
  }
  return null
}

interface Frame {
  restore: number | null
}

// Logical statements: lines joined while brackets are open; comments and strings handled.
function statements(source: string): string[] {
  const raw = source.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, '').split('\n')
  const out: string[] = []
  let buf = ''
  let depth = 0
  for (const line of raw) {
    let clean = ''
    let quote: string | null = null
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (quote) {
        clean += c
        if (c === '\\') clean += line[++i] ?? ''
        else if (c === quote) quote = null
        continue
      }
      if (c === '-' && line[i + 1] === '-') break
      if (c === '"' || c === "'") quote = c
      if ('({['.includes(c)) depth++
      if (')}]'.includes(c)) depth = Math.max(0, depth - 1)
      clean += c
    }
    buf += (buf ? ' ' : '') + clean.trim()
    // A line that ends in a function header (task.delay(0.2, function()) ends the statement: its
    // body follows on its own lines.
    if (/\bfunction\s*\([^)]*\)\s*$/.test(clean)) depth = 0
    if (depth === 0) {
      if (buf.trim()) out.push(buf.trim())
      buf = ''
    }
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

// Splits "if x then a end" / "for ... do a end" into keyword-aware pieces.
function pieces(stmt: string): string[] {
  // Keep `function(...)` openers attached to their call (task.delay(0.3, function() ...).
  return stmt
    .split(/\b(then|do|else|end)\b/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export interface ScriptTweenOptions {
  // Upper bound on cues per script (runaway loops).
  maxCues?: number
}

// Tween / set cues for every script in the tree.
export function tweenCuesFromScripts(roots: VfxNode[], opts: ScriptTweenOptions = {}): VfxCue[] {
  const parentOf = new Map<string, VfxNode | null>()
  const all: VfxNode[] = []
  const walk = (n: VfxNode, p: VfxNode | null) => {
    parentOf.set(n.id, p)
    all.push(n)
    n.children.forEach((c) => walk(c, n))
  }
  roots.forEach((r) => walk(r, null))
  const cues: VfxCue[] = []
  const max = opts.maxCues ?? 400
  for (const s of all.filter((n) => SCRIPT_CLASSES.has(n.className) && n.source)) {
    const scope: Scope = { vars: new Map(), script: s, parentOf, all }
    let clock = 0
    const frames: Frame[] = []
    const at = () => Math.round(clock * 1000) / 1000
    const play = (tw: Extract<Val, { k: 'tween' }>) => {
      for (const node of tw.targets) {
        const props: Record<string, PropValue> = {}
        for (const [k, v] of tw.goal) {
          const g = goalValue(node, k, v)
          if (g !== null) props[k] = g
        }
        if (!Object.keys(props).length || cues.length >= max) continue
        cues.push({ at: Math.round((clock + tw.info.delay) * 1000) / 1000, target: node.id, action: 'tween', props, duration: tw.info.duration, style: tw.info.style, direction: tw.info.direction })
      }
    }
    let afterElseif = false
    const run = (piece: string): void => {
      if (piece === 'then' || piece === 'do' || piece === 'else') {
        if (piece !== 'else' && !afterElseif) frames.push({ restore: null })
        afterElseif = false
        return
      }
      afterElseif = false
      if (piece === 'end' || /^until\b/.test(piece)) {
        const f = frames.pop()
        if (f && f.restore !== null) clock = f.restore
        return
      }
      if (/^elseif\b/.test(piece)) {
        afterElseif = true
        return
      }
      const toks = tokenize(piece)
      if (!toks.length) return
      // task.delay(t, function() ...) / task.spawn(function() ...): the body runs on its own clock
      // (delayed by t), and the caller's clock continues after the block.
      const delay = /^(?:task\.)?delay\s*\(\s*([^,]+),\s*function\s*\([^)]*\)\s*(.*)$/.exec(piece)
      const spawn = /^(?:task\.spawn|task\.defer|spawn|coroutine\.wrap)\s*\(\s*function\s*\([^)]*\)\s*(.*)$/.exec(piece)
      if (delay || spawn) {
        const d = delay ? new Parser(tokenize(delay[1]), scope).expr() : UNKNOWN
        frames.push({ restore: clock })
        clock += d.k === 'num' ? Math.max(0, Math.min(30, d.v)) : 0
        const rest = (delay ? delay[2] : spawn![1]).trim()
        if (rest) run(rest)
        return
      }
      if (/:Connect\s*\(\s*function\b/.test(piece) || /^(?:local\s+)?function\b/.test(piece) || /=\s*function\b/.test(piece)) {
        // Event handlers and function definitions: unknown timing; their bodies run on a clock
        // that is restored after the block.
        frames.push({ restore: clock })
        return
      }
      // for _, v in X:GetDescendants() / ipairs(...) / pairs(...)
      const forIn = /^for\s+(?:(\w+)\s*,\s*)?(\w+)\s+in\s+(.+)$/.exec(piece)
      if (forIn) {
        const src = forIn[3].trim().replace(/^(?:ipairs|pairs)\s*\(([\s\S]*)\)$/, '$1')
        const v = new Parser(tokenize(src), scope).expr()
        scope.vars.set(forIn[2], v.k === 'nodes' ? v : UNKNOWN)
        return
      }
      if (/^(?:for|while|if|repeat|return|break|continue)\b/.test(piece)) {
        if (/^repeat\b/.test(piece)) frames.push({ restore: null })
        return
      }
      const wait = /^(?:task\.)?wait\s*\(\s*([^)]*)\)/.exec(piece)
      if (wait) {
        const v = new Parser(tokenize(wait[1] || '0.03'), scope).expr()
        clock += v.k === 'num' ? Math.max(0, Math.min(30, v.v)) : 0.03
        return
      }
      // local a = expr / a = expr / x.Prop = expr
      const body = tokenize(piece.replace(/^local\s+/, ''))
      const split = splitAssign(body)
      if (split) {
        const [lhs, rhs] = split
        const value = new Parser(rhs, scope).expr()
        if (lhs.length === 1 && lhs[0].t === 'id') {
          scope.vars.set(String(lhs[0].v), value)
          return
        }
        // x.y.Prop = value: a 'set' on the target nodes.
        if (lhs.length >= 3 && lhs[lhs.length - 2].t === 'op' && lhs[lhs.length - 2].v === '.' && lhs[lhs.length - 1].t === 'id') {
          const key = String(lhs[lhs.length - 1].v)
          const target = new Parser(lhs.slice(0, -2), scope).expr()
          if (target.k === 'nodes')
            for (const node of target.v) {
              const g = goalValue(node, key, value)
              if (g !== null && cues.length < max) cues.push({ at: at(), target: node.id, action: 'set', props: { [key]: g } })
            }
        }
        return
      }
      // Expression statement: :Play() on a tween (inline or a local).
      if (/:\s*Play\s*\(\s*\)\s*;?\s*$/.test(piece)) {
        const head = piece.replace(/:\s*Play\s*\(\s*\)\s*;?\s*$/, '')
        const tw = new Parser(tokenize(head), scope).expr()
        if (tw.k === 'tween') play(tw)
      }
    }
    for (const stmt of statements(s.source!)) for (const piece of pieces(stmt)) run(piece)
  }
  return cues
}

// Parts that are fully transparent as authored but that a cue makes visible at some point
// (a tween or set of Transparency below 1). Used by the importer to keep them.
export function revealedByCues(cues: VfxCue[]): Set<string> {
  const out = new Set<string>()
  for (const c of cues) {
    const t = c.props?.Transparency
    if ((c.action === 'tween' || c.action === 'set') && typeof t === 'number' && t < 0.999) out.add(c.target)
  }
  return out
}
