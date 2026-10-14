// Browser-preview mock of the VFX mesh cache: two demo mesh ids "exist in Studio" with procedural
// geometry (a crescent slash and a shockwave ring), so the VFX Lab's "Load meshes" flow and real
// mesh drawing can be seen without Electron. Everything else is reported as not accessible.
import { finishMesh, toWire, meshAssetId, type MeshData, type MeshWire } from '@shared/vfx/mesh/data'
import type { MeshLoadReport } from '@shared/vfxMeshTypes'

export const MOCK_SLASH_MESH = '7001001'
export const MOCK_RING_MESH = '7001002'

// A flat crescent in the XZ plane (outer radius 1, thick in the middle, pointed ends).
function crescent(): MeshData {
  const p: number[] = []
  const uv: number[] = []
  const n: number[] = []
  const idx: number[] = []
  const N = 48
  for (let i = 0; i <= N; i++) {
    const u = i / N
    const a = -Math.PI * 0.8 + u * Math.PI * 1.6
    const w = Math.sin(u * Math.PI) * 0.35
    for (const r of [1, 1 - w]) {
      p.push(Math.cos(a) * r, 0, Math.sin(a) * r)
      n.push(0, 1, 0)
      uv.push(u, r === 1 ? 1 : 0)
    }
    if (i < N) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2)
  }
  return finishMesh({ positions: Float32Array.from(p), normals: Float32Array.from(n), uvs: Float32Array.from(uv), indices: Uint32Array.from(idx), format: 'editablemesh' })
}

// A torus (ring) around Y.
function ring(): MeshData {
  const p: number[] = []
  const n: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const A = 48
  const B = 10
  for (let i = 0; i <= A; i++) {
    const a = (i / A) * Math.PI * 2
    for (let j = 0; j <= B; j++) {
      const b = (j / B) * Math.PI * 2
      const r = 1 + 0.12 * Math.cos(b)
      p.push(Math.cos(a) * r, 0.12 * Math.sin(b), Math.sin(a) * r)
      n.push(Math.cos(a) * Math.cos(b), Math.sin(b), Math.sin(a) * Math.cos(b))
      uv.push(i / A, j / B)
      if (i < A && j < B) {
        const k = i * (B + 1) + j
        idx.push(k, k + 1, k + B + 1, k + 1, k + B + 2, k + B + 1)
      }
    }
  }
  return finishMesh({ positions: Float32Array.from(p), normals: Float32Array.from(n), uvs: Float32Array.from(uv), indices: Uint32Array.from(idx), format: 'editablemesh' })
}

const STUDIO: Record<string, () => MeshData> = { [MOCK_SLASH_MESH]: crescent, [MOCK_RING_MESH]: ring }
const cache = new Map<string, MeshWire>()

export function mockMeshGet(refs: string[]): Record<string, MeshWire> {
  const out: Record<string, MeshWire> = {}
  for (const r of refs) {
    const id = meshAssetId(r)
    const w = id ? cache.get(id) : undefined
    if (id && w) out[id] = w
  }
  return out
}

export function mockMeshLoad(refs: string[], opts?: { studio?: boolean }): MeshLoadReport {
  const ids = [...new Set(refs.map(meshAssetId).filter((x): x is string => !!x))]
  return {
    results: ids.map((id) => {
      const c = cache.get(id)
      if (c) return { id, state: 'cached' as const, source: c.source, verts: c.verts, tris: c.tris }
      const make = STUDIO[id]
      if (!make || opts?.studio === false) return { id, state: 'failed' as const, reason: 'Studio: Failed to load mesh: asset is not owned by you or your group; Open Cloud: no API key' }
      const w = toWire(id, make(), 'studio')
      cache.set(id, w)
      return { id, state: 'loaded' as const, source: 'studio' as const, verts: w.verts, tris: w.tris }
    }),
    notes: ['No Open Cloud API key (Art page): meshes were not downloaded. A key with the legacy-asset:manage scope lets Forge download mesh files.'],
    studio: true,
    at: Date.now()
  }
}
