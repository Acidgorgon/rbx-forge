// IPC types for VFX Lab meshes (main/services/vfx/meshes.ts). VfxApi extends these.

import type { MeshSource, MeshWire } from './vfx/mesh/data.ts'

export type { MeshWire, MeshSource }

export interface MeshLoadResult {
  id: string
  state: 'cached' | 'loaded' | 'failed'
  source?: MeshSource | 'none'
  verts?: number
  tris?: number
  reason?: string
}

export interface MeshLoadReport {
  results: MeshLoadResult[]
  notes: string[]
  studio: boolean
  at: number
}

export interface MeshStatus {
  // Forge Bridge plugin connected (meshes can be read from Studio).
  studio: boolean
  // An Open Cloud key is set (whether it has the scope shows on first use).
  cloudKey: boolean
}

export interface VfxMeshApi {
  // Cached geometry by asset id (rbxassetid refs accepted); missing ids are left out.
  vfxMeshGet(refs: string[]): Promise<Record<string, MeshWire>>
  // Loads what is not cached: Studio (EditableMesh) first, then Open Cloud asset delivery.
  vfxMeshLoad(refs: string[], opts?: { studio?: boolean; cloud?: boolean; retry?: boolean }): Promise<MeshLoadReport>
  vfxMeshStatus(): Promise<MeshStatus>
}
