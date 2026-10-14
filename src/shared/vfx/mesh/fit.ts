// How Roblox places a mesh file on its part, as plain math the preview and tests share.
//
//   MeshPart   the mesh is centred on its bounding box and stretched per axis so the box matches
//              the part's Size (MeshPart.MeshSize is that box: Size / MeshSize is the scale).
//              A flat axis (a slash plane, MeshSize ~ 0 on that axis) stays flat.
//   SpecialMesh (MeshType FileMesh) the mesh keeps its own size and origin (not re-centred, not
//              fitted to the part): vertex * Scale + Offset, in the parent part's space; VertexColor
//              tints the texture. Primitive MeshTypes (Sphere, Brick, Cylinder, Head, Wedge) scale
//              the part's Size by Scale instead (simulate.ts meshShape).
// Sources: Creator Hub MeshPart (MeshSize, Size), SpecialMesh (Scale, Offset, VertexColor),
// DataModelMesh, read 2026-10-14.

import type { Vec3 } from '../types.ts'

const FLAT = 1e-4

// Geometry transform for a MeshPart: subtract `centre`, divide by `extent` -> a unit box; the
// preview then scales the unit geometry by the (tweened) Size every frame.
export function partMeshNormalize(min: Vec3, max: Vec3): { centre: Vec3; extent: Vec3 } {
  const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  // A flat axis: divide by 1 (its vertices sit at ~0 after centring and stay flat).
  const extent: Vec3 = [0, 1, 2].map((k) => (max[k] - min[k] > FLAT ? max[k] - min[k] : 1)) as Vec3
  return { centre, extent }
}

// Stretch Roblox applies to a MeshPart's mesh: Size / MeshSize per axis (1 on flat axes).
export function partMeshScale(size: Vec3, meshSize: Vec3): Vec3 {
  return [0, 1, 2].map((k) => (meshSize[k] > FLAT ? size[k] / meshSize[k] : 1)) as Vec3
}

// A mesh vertex -> the part's local space.
export function partMeshVertex(v: Vec3, size: Vec3, min: Vec3, max: Vec3): Vec3 {
  const { centre, extent } = partMeshNormalize(min, max)
  return [0, 1, 2].map((k) => ((v[k] - centre[k]) / extent[k]) * size[k]) as Vec3
}

export function specialMeshVertex(v: Vec3, scale: Vec3, offset: Vec3): Vec3 {
  return [v[0] * scale[0] + offset[0], v[1] * scale[1] + offset[1], v[2] * scale[2] + offset[2]]
}
