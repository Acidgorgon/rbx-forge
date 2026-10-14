// Parser for Roblox's .mesh files (what the asset delivery API returns for a MeshId), versions:
//   1.00 / 1.01  text: face count, then [px,py,pz][nx,ny,nz][u,v,w] x 3 per face; 1.00 positions
//                are double size (scaled by 0.5 here)
//   2.00         binary: header {u16 headerSize, u8 vertexSize (36|40), u8 faceSize, u32 verts,
//                u32 faces}, vertices, faces
//   3.00 / 3.01  2.00 + {u16 lodSize, u16 lodCount} in the header and LOD offsets after the faces
//   4.00 / 4.01  header {u16 headerSize, u16 lodType, u32 verts, u32 faces, u16 lods, u16 bones,
//                u32 boneNamesSize, u16 subsets, u8 hqLods, u8 pad}; vertices (40 bytes),
//                skinning (8 bytes per vertex when bones > 0), faces, LOD offsets, ...
//   5.00         4.00 + {u32 facsFormat, u32 facsSize} in the header (FACS data at the end)
//   6.00 / 7.00  chunks {char[8] type, u32 version, u32 size, data}: COREMESH v1 (plain vertices
//                and faces) and LODS v1 are read; COREMESH v2 is Draco-compressed: unsupported
// Binary vertex (all binary versions): position f32x3, normal f32x3, uv f32x2, tangent i8x4, then
// RGBA u8x4 when the vertex size is 40. Faces are u32x3. Little-endian throughout. Only the
// highest-detail LOD (faces[lod0 .. lod1]) is kept.
//
// Sources: the community-maintained Roblox mesh format notes (MaximumADHD's Roblox-File-Format
// "Mesh Format" document and the Roblox DevForum "Roblox Mesh Format" thread), read 2026-10-14.
// UVs: binary files store Direct3D-style v (top-left origin) and are flipped to OpenGL (1 - v);
// version 1 text files already use bottom-left v. Pure code.

import { finishMesh, MeshError, type MeshData } from './data.ts'

const enc = new TextDecoder('latin1')

export function meshVersion(bytes: Uint8Array): string | null {
  const head = enc.decode(bytes.subarray(0, Math.min(16, bytes.length)))
  const m = /^version (\d+\.\d+)/.exec(head)
  return m ? m[1] : null
}

export function parseRobloxMesh(input: Uint8Array | ArrayBuffer): MeshData {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const version = meshVersion(bytes)
  if (!version) throw new MeshError('corrupt', 'not a Roblox mesh file (no "version" header)')
  const major = Number(version.split('.')[0])
  const nl = bytes.indexOf(0x0a)
  if (nl < 0) throw new MeshError('corrupt', 'truncated header')
  const body = bytes.subarray(nl + 1)
  const fmt = `version ${version}`
  if (major === 1) return parseV1(enc.decode(body), version === '1.00', fmt)
  if (major === 2 || major === 3) return parseV2V3(body, major, fmt)
  if (major === 4 || major === 5) return parseV4V5(body, fmt)
  if (major === 6 || major === 7) return parseChunked(body, fmt)
  throw new MeshError('unsupported', `mesh ${fmt} is not supported`)
}

// ------------------------------------------------------------------ v1 (text)

function parseV1(text: string, halve: boolean, format: string): MeshData {
  const lines = text.split(/\r?\n/)
  const faces = Number(lines[0]?.trim())
  if (!Number.isInteger(faces) || faces < 0) throw new MeshError('corrupt', 'bad face count')
  const rest = lines.slice(1).join('')
  const vecs = [...rest.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1].split(',').map((x) => Number(x.trim())))
  if (vecs.length < faces * 9) throw new MeshError('corrupt', `expected ${faces * 9} vectors, found ${vecs.length}`)
  const nv = faces * 3
  const positions = new Float32Array(nv * 3)
  const normals = new Float32Array(nv * 3)
  const uvs = new Float32Array(nv * 2)
  const s = halve ? 0.5 : 1
  for (let v = 0; v < nv; v++) {
    const [p, n, t] = [vecs[v * 3], vecs[v * 3 + 1], vecs[v * 3 + 2]]
    for (let k = 0; k < 3; k++) {
      positions[v * 3 + k] = (p[k] || 0) * s
      normals[v * 3 + k] = n[k] || 0
    }
    uvs[v * 2] = t[0] || 0
    uvs[v * 2 + 1] = t[1] || 0
  }
  const indices = new Uint32Array(nv)
  for (let i = 0; i < nv; i++) indices[i] = i
  return finishMesh({ positions, normals, uvs, indices, format })
}

// ------------------------------------------------------------------ binary helpers

class Reader {
  readonly view: DataView
  readonly bytes: Uint8Array
  pos = 0
  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  need(n: number, what: string): void {
    if (this.pos + n > this.bytes.length) throw new MeshError('corrupt', `truncated ${what}`)
  }
  u8(): number {
    this.need(1, 'header')
    return this.view.getUint8(this.pos++)
  }
  u16(): number {
    this.need(2, 'header')
    const v = this.view.getUint16(this.pos, true)
    this.pos += 2
    return v
  }
  u32(): number {
    this.need(4, 'header')
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }
}

interface Raw {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
}

function readVertices(r: Reader, count: number, size: number): Raw {
  if (size < 32) throw new MeshError('corrupt', `vertex size ${size} is too small`)
  r.need(count * size, 'vertices')
  const positions = new Float32Array(count * 3)
  const normals = new Float32Array(count * 3)
  const uvs = new Float32Array(count * 2)
  for (let i = 0; i < count; i++) {
    const o = r.pos + i * size
    for (let k = 0; k < 3; k++) {
      positions[i * 3 + k] = r.view.getFloat32(o + k * 4, true)
      normals[i * 3 + k] = r.view.getFloat32(o + 12 + k * 4, true)
    }
    uvs[i * 2] = r.view.getFloat32(o + 24, true)
    uvs[i * 2 + 1] = 1 - r.view.getFloat32(o + 28, true)
  }
  r.pos += count * size
  return { positions, normals, uvs }
}

function readFaces(r: Reader, count: number, size = 12): Uint32Array {
  if (size < 12) throw new MeshError('corrupt', `face size ${size} is too small`)
  r.need(count * size, 'faces')
  const out = new Uint32Array(count * 3)
  for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = r.view.getUint32(r.pos + i * size + k * 4, true)
  r.pos += count * size
  return out
}

function readLods(r: Reader, count: number, size = 4): number[] {
  if (!count) return []
  r.need(count * size, 'LODs')
  const out: number[] = []
  for (let i = 0; i < count; i++) out.push(r.view.getUint32(r.pos + i * size, true))
  r.pos += count * size
  return out
}

// Faces of the highest-detail LOD: [lods[0], lods[1]) when the table makes sense, else all.
function lod0(faces: Uint32Array, lods: number[]): Uint32Array {
  const n = faces.length / 3
  if (lods.length >= 2 && lods[1] > lods[0] && lods[1] <= n) return faces.subarray(lods[0] * 3, lods[1] * 3)
  return faces
}

function finish(raw: Raw, faces: Uint32Array, format: string): MeshData {
  return finishMesh({ ...raw, indices: Uint32Array.from(faces), format })
}

// ------------------------------------------------------------------ v2 / v3

function parseV2V3(body: Uint8Array, major: number, format: string): MeshData {
  const r = new Reader(body)
  const headerSize = r.u16()
  const vertexSize = r.u8()
  const faceSize = r.u8()
  let lodSize = 4
  let lodCount = 0
  if (major === 3) {
    lodSize = r.u16()
    lodCount = r.u16()
  }
  const nv = r.u32()
  const nf = r.u32()
  r.pos = headerSize
  const raw = readVertices(r, nv, vertexSize)
  const faces = readFaces(r, nf, faceSize)
  const lods = major === 3 ? readLods(r, lodCount, lodSize) : []
  return finish(raw, lod0(faces, lods), format)
}

// ------------------------------------------------------------------ v4 / v5

function parseV4V5(body: Uint8Array, format: string): MeshData {
  const r = new Reader(body)
  const headerSize = r.u16()
  r.u16() // lodType
  const nv = r.u32()
  const nf = r.u32()
  const lodCount = r.u16()
  const bones = r.u16()
  r.pos = headerSize
  const raw = readVertices(r, nv, 40)
  if (bones > 0) {
    r.need(nv * 8, 'skinning')
    r.pos += nv * 8
  }
  const faces = readFaces(r, nf)
  const lods = readLods(r, lodCount)
  return finish(raw, lod0(faces, lods), format)
}

// ------------------------------------------------------------------ v6 / v7 (chunks)

function parseChunked(body: Uint8Array, format: string): MeshData {
  const r = new Reader(body)
  let core: { raw: Raw; faces: Uint32Array } | null = null
  let lods: number[] = []
  while (r.pos + 16 <= body.length) {
    const type = enc.decode(body.subarray(r.pos, r.pos + 8)).replace(/\0+$/, '')
    r.pos += 8
    const version = r.u32()
    const size = r.u32()
    r.need(size, `${type} chunk`)
    const end = r.pos + size
    const c = new Reader(body.subarray(r.pos, end))
    if (type === 'COREMESH') {
      if (version !== 1) throw new MeshError('unsupported', `mesh ${format} uses Draco-compressed geometry (COREMESH v${version}), which the preview cannot decode yet`)
      const nv = c.u32()
      const raw = readVertices(c, nv, 40)
      const nf = c.u32()
      core = { raw, faces: readFaces(c, nf) }
    } else if (type === 'LODS' && version === 1) {
      c.u16() // lodType
      c.u8() // hq lods
      const n = c.u32()
      lods = readLods(c, n)
    }
    r.pos = end
  }
  if (!core) throw new MeshError('corrupt', `mesh ${format} has no COREMESH chunk`)
  return finish(core.raw, lod0(core.faces, lods), format)
}
