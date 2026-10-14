// Mesh geometry for the previews (VFX Lab, Ability Composer, captures): asks the main process for
// cached meshes (window.harness.vfxMeshGet), decodes them once and keeps three.js geometry per
// asset id. Missing meshes resolve to null (the layer keeps its proxy shape); when the cache gets
// new meshes ('vfx:meshes'), forget() drops the misses so the next load picks them up.
import * as THREE from 'three'
import { fromWire, meshAssetId, type MeshData } from '@shared/vfx/mesh/data'
import { partMeshNormalize } from '@shared/vfx/mesh/fit'

export type MeshFn = (ref: string) => Promise<MeshGeometry | null>

export interface MeshGeometry {
  data: MeshData
  // MeshPart: centred on the bounding box and divided by its size (unit box; scale by Size).
  fitted: THREE.BufferGeometry
  // SpecialMesh FileMesh: the mesh's own coordinates (scale by Scale, move by Offset).
  raw: THREE.BufferGeometry
}

function build(data: MeshData): MeshGeometry {
  const raw = new THREE.BufferGeometry()
  raw.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
  if (data.uvs) raw.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2))
  raw.setIndex(new THREE.BufferAttribute(data.indices, 1))
  if (data.normals) raw.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3))
  else raw.computeVertexNormals()
  raw.computeBoundingSphere()
  const { centre, extent } = partMeshNormalize(data.min, data.max)
  const fitted = raw.clone()
  fitted.translate(-centre[0], -centre[1], -centre[2])
  fitted.scale(1 / extent[0], 1 / extent[1], 1 / extent[2])
  // Non-uniform scaling bends normals: recompute them only when the mesh had none.
  if (!data.normals) fitted.computeVertexNormals()
  fitted.computeBoundingSphere()
  return { data, fitted, raw }
}

export class MeshCache {
  private hits = new Map<string, Promise<MeshGeometry | null>>()
  private pending = new Map<string, ((g: MeshGeometry | null) => void)[]>()
  private timer: ReturnType<typeof setTimeout> | null = null

  get: MeshFn = (ref) => {
    const id = meshAssetId(ref)
    const api = (globalThis as { harness?: { vfxMeshGet?: (refs: string[]) => Promise<Record<string, unknown>> } }).harness
    if (!id || !api?.vfxMeshGet) return Promise.resolve(null)
    let p = this.hits.get(id)
    if (!p) {
      p = new Promise((resolve) => {
        this.pending.set(id, [...(this.pending.get(id) ?? []), resolve])
        // One IPC call for all meshes asked for in the same tick.
        this.timer ??= setTimeout(() => void this.flush(), 0)
      })
      this.hits.set(id, p)
    }
    return p
  }

  private async flush(): Promise<void> {
    this.timer = null
    const batch = new Map(this.pending)
    this.pending.clear()
    const api = (globalThis as { harness?: { vfxMeshGet?: (refs: string[]) => Promise<Record<string, unknown>> } }).harness
    let got: Record<string, unknown> = {}
    try {
      got = (await api?.vfxMeshGet?.([...batch.keys()])) ?? {}
    } catch {
      got = {}
    }
    for (const [id, waiters] of batch) {
      let g: MeshGeometry | null = null
      try {
        const w = got[id]
        if (w) g = build(fromWire(w as never))
      } catch {
        g = null
      }
      if (!g) this.hits.delete(id)
      for (const r of waiters) r(g)
    }
  }

  // Ids that just arrived in the main cache (or all misses).
  forget(ids?: string[]): void {
    for (const id of ids ?? [...this.hits.keys()]) this.hits.delete(id)
  }
}

// One cache for every preview in the window.
export const sharedMeshes = new MeshCache()
