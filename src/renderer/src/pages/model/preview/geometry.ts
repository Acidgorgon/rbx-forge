// Unit geometries for the Roblox part shapes the Model Lab draws (1 x 1 x 1, centred like a Part,
// scaled by Size per instance). Roblox local axes: +Y up, -Z front.
//   WedgePart: full height at +Z, zero height at -Z (the slope faces up and to the front).
//   CornerWedgePart: apex over the (+X, -Z) corner; vertical faces on x = +0.5 and z = -0.5.
// Faces are flat-shaded (each triangle has its own normals) so the blocky look reads.

import * as THREE from 'three'

type V = [number, number, number]

// Triangles of a convex solid; the winding is fixed so every face points away from the centre.
export function convexGeometry(tris: [V, V, V][]): THREE.BufferGeometry {
  const pts = tris.flat()
  const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length, a[2] + p[2] / pts.length] as V, [0, 0, 0] as V)
  const pos: number[] = []
  for (const [a, b, d] of tris) {
    const u = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    const v = new THREE.Vector3(d[0] - a[0], d[1] - a[1], d[2] - a[2])
    const n = u.cross(v)
    const out = new THREE.Vector3((a[0] + b[0] + d[0]) / 3 - c[0], (a[1] + b[1] + d[1]) / 3 - c[1], (a[2] + b[2] + d[2]) / 3 - c[2])
    const tri = n.dot(out) >= 0 ? [a, b, d] : [a, d, b]
    for (const p of tri) pos.push(...p)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  return g
}

const quad = (a: V, b: V, c: V, d: V): [V, V, V][] => [
  [a, b, c],
  [a, c, d]
]

export function wedgeGeometry(): THREE.BufferGeometry {
  const h = 0.5
  // bottom corners
  const b0: V = [-h, -h, -h]
  const b1: V = [h, -h, -h]
  const b2: V = [h, -h, h]
  const b3: V = [-h, -h, h]
  // top edge at the back (+Z)
  const t2: V = [h, h, h]
  const t3: V = [-h, h, h]
  return convexGeometry([...quad(b0, b1, b2, b3), ...quad(b3, b2, t2, t3), ...quad(b0, b1, t2, t3), [b1, b2, t2], [b0, b3, t3]])
}

export function cornerWedgeGeometry(): THREE.BufferGeometry {
  const h = 0.5
  const b0: V = [-h, -h, -h]
  const b1: V = [h, -h, -h]
  const b2: V = [h, -h, h]
  const b3: V = [-h, -h, h]
  const apex: V = [h, h, -h]
  return convexGeometry([...quad(b0, b1, b2, b3), [b1, b2, apex], [b1, b0, apex], [b0, b3, apex], [b3, b2, apex]])
}

export function boxGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1, 1, 1)
}

// Roblox cylinders run along local X.
export function cylinderGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 20, 1)
  g.rotateZ(Math.PI / 2)
  return g
}

export function ballGeometry(): THREE.BufferGeometry {
  return new THREE.SphereGeometry(0.5, 20, 14)
}

export type ShapeKey = 'box' | 'wedge' | 'corner' | 'cylinder' | 'ball'

export function shapeOf(k: string, sh?: string): ShapeKey {
  if (k === 'W' || sh === 'Wedge') return 'wedge'
  if (k === 'C' || sh === 'CornerWedge') return 'corner'
  if (sh === 'Ball') return 'ball'
  if (sh === 'Cylinder') return 'cylinder'
  return 'box'
}

export function shapeGeometry(key: ShapeKey): THREE.BufferGeometry {
  switch (key) {
    case 'wedge':
      return wedgeGeometry()
    case 'corner':
      return cornerWedgeGeometry()
    case 'cylinder':
      return cylinderGeometry()
    case 'ball':
      return ballGeometry()
    default:
      return boxGeometry()
  }
}
