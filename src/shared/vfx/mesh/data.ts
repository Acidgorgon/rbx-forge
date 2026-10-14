// Mesh geometry for the VFX Lab preview: the in-memory form (typed arrays) and the JSON wire / cache
// form (base64 of the little-endian arrays). Pure code: the main process caches and serves it, the
// renderer builds three.js geometry from it, tests check it.
//
// Conventions (whatever the source):
//   positions  studs, the mesh's own coordinates (not re-centred; see fit.ts for MeshPart / SpecialMesh)
//   normals    unit vectors per vertex (may be missing: the renderer computes them)
//   uvs        OpenGL convention (v = 0 at the bottom of the image), i.e. already flipped from
//              Roblox's top-left origin
//   indices    triangles, counter-clockwise front faces (Roblox and three.js agree)

import type { Vec3 } from '../types.ts'

export interface MeshData {
  positions: Float32Array
  normals?: Float32Array
  uvs?: Float32Array
  indices: Uint32Array
  min: Vec3
  max: Vec3
  // Where it came from: the .mesh header ("version 4.00") or "editablemesh" (Studio).
  format: string
}

export type MeshSource = 'studio' | 'cloud'

export interface MeshWire {
  id: string
  format: string
  source: MeshSource
  // base64 of Float32Array / Uint32Array (little-endian).
  p: string
  n?: string
  uv?: string
  i: string
  min: Vec3
  max: Vec3
  verts: number
  tris: number
  at: number
}

// Limits for what the preview keeps (a VFX mesh is a few thousand triangles; anything far beyond
// is probably a whole model and not worth the memory).
export const MESH_MAX_VERTS = 200_000
export const MESH_MAX_TRIS = 200_000

export class MeshError extends Error {
  readonly code: 'unsupported' | 'corrupt' | 'too-big'
  constructor(code: MeshError['code'], message: string) {
    super(message)
    this.code = code
  }
}

export function bounds(positions: Float32Array): { min: Vec3; max: Vec3 } {
  if (!positions.length) return { min: [0, 0, 0], max: [0, 0, 0] }
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k]
      if (v < min[k]) min[k] = v
      if (v > max[k]) max[k] = v
    }
  }
  return { min, max }
}

// Drops triangles that point past the vertex list (corrupt files) and checks the limits.
export function finishMesh(m: Omit<MeshData, 'min' | 'max'>): MeshData {
  const nv = m.positions.length / 3
  if (nv > MESH_MAX_VERTS || m.indices.length / 3 > MESH_MAX_TRIS) throw new MeshError('too-big', `mesh has ${nv} vertices / ${m.indices.length / 3} triangles (preview limit ${MESH_MAX_VERTS})`)
  let indices = m.indices
  let bad = false
  for (let i = 0; i < indices.length; i++) if (indices[i] >= nv) bad = true
  if (bad) {
    const keep: number[] = []
    for (let i = 0; i + 2 < indices.length; i += 3) if (indices[i] < nv && indices[i + 1] < nv && indices[i + 2] < nv) keep.push(indices[i], indices[i + 1], indices[i + 2])
    indices = Uint32Array.from(keep)
  }
  if (!indices.length || !nv) throw new MeshError('corrupt', 'mesh has no triangles')
  return { ...m, indices, ...bounds(m.positions) }
}

// ------------------------------------------------------------------ base64

function toB64(bytes: Uint8Array): string {
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH))
  return btoa(s)
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

const LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

function arrB64(a: Float32Array | Uint32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
  if (LE) return toB64(bytes)
  const copy = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i += 4) for (let k = 0; k < 4; k++) copy[i + k] = bytes[i + 3 - k]
  return toB64(copy)
}

function b64Arr<T extends Float32Array | Uint32Array>(b64: string, Ctor: { new (buf: ArrayBuffer): T }): T {
  const bytes = fromB64(b64)
  if (bytes.length % 4) throw new MeshError('corrupt', 'bad array length')
  const buf = new ArrayBuffer(bytes.length)
  const view = new Uint8Array(buf)
  if (LE) view.set(bytes)
  else for (let i = 0; i < bytes.length; i += 4) for (let k = 0; k < 4; k++) view[i + k] = bytes[i + 3 - k]
  return new Ctor(buf)
}

export function toWire(id: string, m: MeshData, source: MeshSource, at = Date.now()): MeshWire {
  return {
    id,
    format: m.format,
    source,
    p: arrB64(m.positions),
    ...(m.normals ? { n: arrB64(m.normals) } : {}),
    ...(m.uvs ? { uv: arrB64(m.uvs) } : {}),
    i: arrB64(m.indices),
    min: m.min,
    max: m.max,
    verts: m.positions.length / 3,
    tris: m.indices.length / 3,
    at
  }
}

export function fromWire(w: MeshWire): MeshData {
  const positions = b64Arr(w.p, Float32Array)
  const nv = positions.length / 3
  const normals = w.n ? b64Arr(w.n, Float32Array) : undefined
  const uvs = w.uv ? b64Arr(w.uv, Float32Array) : undefined
  return {
    positions,
    normals: normals && normals.length === nv * 3 ? normals : undefined,
    uvs: uvs && uvs.length === nv * 2 ? uvs : undefined,
    indices: b64Arr(w.i, Uint32Array),
    min: w.min,
    max: w.max,
    format: w.format
  }
}

export function isMeshWire(v: unknown): v is MeshWire {
  const w = v as MeshWire
  return !!w && typeof w === 'object' && typeof w.id === 'string' && typeof w.p === 'string' && typeof w.i === 'string' && Array.isArray(w.min) && Array.isArray(w.max)
}

// ------------------------------------------------------------------ asset ids

// rbxassetid://123, http(s)://www.roblox.com/asset/?id=123, roblox.com/asset?id=123, a bare number
// -> "123"; anything else (rbxasset:// built-ins, empty) -> null.
export function meshAssetId(ref: unknown): string | null {
  const s = String(ref ?? '').trim()
  if (!s) return null
  if (/^\d{1,20}$/.test(s)) return s
  const m = /^rbxassetid:\/\/(\d{1,20})$/i.exec(s) ?? /^(?:https?:\/\/)?(?:www\.)?roblox\.com\/asset\/?\?id=(\d{1,20})/i.exec(s) ?? /^(?:https?:\/\/)?assetdelivery\.roblox\.com\/v1\/asset\/?\?id=(\d{1,20})/i.exec(s)
  return m ? m[1] : null
}

// The cache file name for a mesh (one per asset id; ids are digits only).
export function meshCacheKey(ref: unknown): string | null {
  const id = meshAssetId(ref)
  return id ? `${id}.json` : null
}
