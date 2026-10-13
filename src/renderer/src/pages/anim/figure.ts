// A flat SVG drawing of the R15 or R6 dummy (the clip's rig) at a time in a clip (projected part boxes, painter-sorted).
// Used for library cards, onion-free thumbnails and the browser mock's "rendered" frames; the live
// preview is three.js (AnimPreview).

import type { AnimClip } from '@shared/anim/model'
import type { R15Part } from '@shared/anim/r15'
import { posedParts, type PartRole } from '@shared/anim/posed'
import { vcross, vdot, vnorm, xpoint, type V3 } from '@shared/anim/math'

export type FigureView = 'three' | 'front' | 'side'

const CAMS: Record<FigureView, V3> = { three: [0.62, 0.22, -1], front: [0, 0.1, -1], side: [1, 0.1, 0] }

const SHADE: Partial<Record<R15Part, string>> = {
  Head: '#d8d4cc',
  UpperTorso: '#5f8fd6',
  LowerTorso: '#4a73b3',
  LeftUpperArm: '#c9c3b8',
  RightUpperArm: '#c9c3b8',
  LeftLowerArm: '#d8d4cc',
  RightLowerArm: '#d8d4cc',
  LeftHand: '#e6e1d8',
  RightHand: '#e6e1d8',
  LeftUpperLeg: '#3f4a5c',
  RightUpperLeg: '#3f4a5c',
  LeftLowerLeg: '#4a576c',
  RightLowerLeg: '#4a576c',
  LeftFoot: '#2e3542',
  RightFoot: '#2e3542'
}

// R6 parts are shaded by role (the Torso like UpperTorso, whole arms / legs like the upper segments).
const ROLE_SHADE: Partial<Record<PartRole, string>> = { head: '#d8d4cc', torso: '#5f8fd6', arm: '#c9c3b8', leg: '#3f4a5c' }

function hull(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lo: [number, number][] = []
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop()
    lo.push(q)
  }
  const up: [number, number][] = []
  for (const q of [...p].reverse()) {
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop()
    up.push(q)
  }
  return [...lo.slice(0, -1), ...up.slice(0, -1)]
}

export interface FigureOptions {
  view?: FigureView
  width?: number
  height?: number
  background?: string | null
  ghost?: AnimClip | null
  label?: string
  // Keep the root's travel (true) or pin the character to the frame centre (false).
  travel?: boolean
}

function partsSvg(clip: AnimClip, t: number, view: FigureView, scale: number, cx: number, cy: number, opacity: number, mono: string | null, travel: boolean): string {
  const cam = vnorm(CAMS[view])
  const f: V3 = [-cam[0], -cam[1], -cam[2]]
  const r = vnorm(vcross(f, [0, 1, 0]))
  const u = vcross(r, f)
  const polys: { depth: number; d: string; fill: string }[] = []
  for (const part of posedParts(clip, t, travel)) {
    const s = part.size
    const pts: [number, number][] = []
    let depth = 0
    for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) {
      const w = xpoint(part.x, [x * s[0], y * s[1], z * s[2]])
      pts.push([cx + vdot(w, r) * scale, cy - vdot(w, u) * scale])
      depth += vdot(w, f)
    }
    const h = hull(pts)
    polys.push({ depth: depth / 8, d: `M${h.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}Z`, fill: mono ?? SHADE[part.name as R15Part] ?? ROLE_SHADE[part.role] ?? '#bbb' })
  }
  polys.sort((a, b) => b.depth - a.depth)
  return `<g opacity="${opacity}">${polys.map((p) => `<path d="${p.d}" fill="${p.fill}" stroke="#0b0d10" stroke-width="1.2" stroke-linejoin="round"/>`).join('')}</g>`
}

export function figureSvg(clip: AnimClip, t: number, opts: FigureOptions = {}): string {
  const W = opts.width ?? 240
  const H = opts.height ?? 200
  const view = opts.view ?? 'three'
  const scale = H / 7.2
  const cx = W / 2
  const cy = H * 0.86
  const grid = Array.from({ length: 9 }, (_, i) => {
    const x = cx + (i - 4) * scale
    return `<line x1="${x.toFixed(1)}" y1="${(cy + 2).toFixed(1)}" x2="${(cx + (i - 4) * scale * 1.6).toFixed(1)}" y2="${H}" stroke="#2a2f37" stroke-width="1"/>`
  }).join('')
  const floor = `<line x1="0" y1="${cy.toFixed(1)}" x2="${W}" y2="${cy.toFixed(1)}" stroke="#3a414c" stroke-width="1"/>${grid}`
  const ghost = opts.ghost ? partsSvg(opts.ghost, Math.min(t, opts.ghost.duration), view, scale, cx, cy, 0.28, '#7fd1c7', opts.travel ?? true) : ''
  const body = partsSvg(clip, t, view, scale, cx, cy, 1, null, opts.travel ?? true)
  const bg = opts.background === null ? '' : `<rect width="${W}" height="${H}" fill="${opts.background ?? '#101317'}"/>`
  const label = opts.label ? `<text x="8" y="${H - 8}" font-family="monospace" font-size="11" fill="#8a929e">${opts.label.replace(/[<&]/g, '')}</text>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${bg}${floor}${ghost}${body}${label}</svg>`
}

export function figureDataUrl(clip: AnimClip, t: number, opts: FigureOptions = {}): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(figureSvg(clip, t, opts))}`
}
