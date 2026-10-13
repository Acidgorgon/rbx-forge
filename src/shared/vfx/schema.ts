// Which Roblox properties the VFX Lab understands, their value kinds, enum tables and defaults.
//
// Sources (read 2026-10-13): Roblox Creator Hub API reference for ParticleEmitter, Beam, Trail,
// NumberSequenceKeypoint and the ParticleEmitter enums (github.com/Roblox/creator-docs,
// content/en-us/reference/engine/...), and Lune 0.11's reflection database (enum values checked
// with `roblox.Enum.X:GetEnumItems()`). Defaults are the Instance.new() values (LightInfluence is 0
// from Instance.new() and 1 when inserted with Studio tools, per the LightInfluence docs).

import type { PropValue } from './types.ts'

export type PropKind = 'number' | 'int' | 'bool' | 'string' | 'content' | 'vec2' | 'vec3' | 'color3' | 'range' | 'nseq' | 'cseq' | 'ref' | 'cframe' | `enum:${string}`

export interface PropSpec {
  kind: PropKind
  default?: PropValue
  // Editor hints: min / max / step for numbers and ranges.
  min?: number
  max?: number
  step?: number
  // Shown in the parameter editor (otherwise advanced).
  main?: boolean
}

export const ENUMS: Record<string, Record<string, number>> = {
  NormalId: { Right: 0, Top: 1, Back: 2, Left: 3, Bottom: 4, Front: 5 },
  ParticleEmitterShape: { Box: 0, Sphere: 1, Cylinder: 2, Disc: 3 },
  ParticleEmitterShapeStyle: { Volume: 0, Surface: 1 },
  ParticleEmitterShapeInOut: { Outward: 0, Inward: 1, InAndOut: 2 },
  ParticleOrientation: { FacingCamera: 0, FacingCameraWorldUp: 1, VelocityParallel: 2, VelocityPerpendicular: 3 },
  ParticleFlipbookLayout: { None: 0, Grid2x2: 1, Grid4x4: 2, Grid8x8: 3, Custom: 4 },
  ParticleFlipbookMode: { Loop: 0, OneShot: 1, PingPong: 2, Random: 3 },
  TextureMode: { Stretch: 0, Wrap: 1, Static: 2 },
  HighlightDepthMode: { AlwaysOnTop: 0, Occluded: 1 },
  MeshType: { Head: 0, Torso: 1, Wedge: 2, Sphere: 3, Cylinder: 4, FileMesh: 5, Brick: 6, Prism: 7, Pyramid: 8, ParallelRamp: 9, RightAngleRamp: 10, CornerWedge: 11 },
  PartType: { Ball: 0, Block: 1, Cylinder: 2, Wedge: 3, CornerWedge: 4 },
  // Enum.Material (the few the Lab draws: Neon glows, ForceField is a rim-lit shell).
  Material: { Plastic: 256, SmoothPlastic: 272, Neon: 288, Glass: 1568, ForceField: 1584 }
}

export function enumName(enumType: string, value: number): string | undefined {
  const t = ENUMS[enumType]
  if (!t) return undefined
  return Object.keys(t).find((k) => t[k] === value)
}

const WHITE = [{ t: 0, c: [1, 1, 1] as [number, number, number] }, { t: 1, c: [1, 1, 1] as [number, number, number] }]
const seq = (v: number) => [
  { t: 0, v },
  { t: 1, v }
]

const LIGHT_COMMON: Record<string, PropSpec> = {
  Brightness: { kind: 'number', default: 1, min: 0, max: 40, step: 0.1, main: true },
  Color: { kind: 'color3', default: [1, 1, 1], main: true },
  Enabled: { kind: 'bool', default: true },
  Shadows: { kind: 'bool', default: false },
  Range: { kind: 'number', default: 8, min: 0, max: 60, step: 0.5, main: true }
}

export const SCHEMA: Record<string, Record<string, PropSpec>> = {
  ParticleEmitter: {
    Enabled: { kind: 'bool', default: true, main: true },
    Rate: { kind: 'number', default: 20, min: 0, max: 400, step: 1, main: true },
    Lifetime: { kind: 'range', default: [5, 10], min: 0, max: 20, step: 0.05, main: true },
    Speed: { kind: 'range', default: [5, 5], min: -100, max: 200, step: 0.5, main: true },
    SpreadAngle: { kind: 'vec2', default: [0, 0], min: 0, max: 360, step: 1, main: true },
    Acceleration: { kind: 'vec3', default: [0, 0, 0], min: -200, max: 200, step: 0.5, main: true },
    Drag: { kind: 'number', default: 0, min: -10, max: 30, step: 0.1, main: true },
    EmissionDirection: { kind: 'enum:NormalId', default: 'Top', main: true },
    Shape: { kind: 'enum:ParticleEmitterShape', default: 'Box' },
    ShapeStyle: { kind: 'enum:ParticleEmitterShapeStyle', default: 'Volume' },
    ShapeInOut: { kind: 'enum:ParticleEmitterShapeInOut', default: 'Outward' },
    ShapePartial: { kind: 'number', default: 1, min: 0, max: 1, step: 0.05 },
    Size: { kind: 'nseq', default: seq(1), min: 0, max: 50, main: true },
    Transparency: { kind: 'nseq', default: seq(0), min: 0, max: 1, main: true },
    Squash: { kind: 'nseq', default: seq(0), min: -3, max: 3 },
    Color: { kind: 'cseq', default: WHITE, main: true },
    LightEmission: { kind: 'number', default: 0, min: 0, max: 1, step: 0.05, main: true },
    LightInfluence: { kind: 'number', default: 0, min: 0, max: 1, step: 0.05 },
    Brightness: { kind: 'number', default: 1, min: 0, max: 40, step: 0.1, main: true },
    Texture: { kind: 'content', default: 'rbxasset://textures/particles/sparkles_main.dds', main: true },
    FlipbookLayout: { kind: 'enum:ParticleFlipbookLayout', default: 'None' },
    FlipbookMode: { kind: 'enum:ParticleFlipbookMode', default: 'Loop' },
    FlipbookFramerate: { kind: 'range', default: [1, 1], min: 0, max: 30, step: 1 },
    FlipbookStartRandom: { kind: 'bool', default: false },
    FlipbookSizeX: { kind: 'int', default: 0, min: 0, max: 16 },
    FlipbookSizeY: { kind: 'int', default: 0, min: 0, max: 16 },
    FlipbookBlendFrames: { kind: 'bool', default: true },
    Rotation: { kind: 'range', default: [0, 0], min: -360, max: 360, step: 1 },
    RotSpeed: { kind: 'range', default: [0, 0], min: -1000, max: 1000, step: 5 },
    Orientation: { kind: 'enum:ParticleOrientation', default: 'FacingCamera' },
    ZOffset: { kind: 'number', default: 0, min: -10, max: 10, step: 0.1 },
    LockedToPart: { kind: 'bool', default: false },
    TimeScale: { kind: 'number', default: 1, min: 0, max: 1, step: 0.05 },
    VelocityInheritance: { kind: 'number', default: 0, min: 0, max: 1, step: 0.05 },
    WindAffectsDrag: { kind: 'bool', default: false }
  },
  Beam: {
    Attachment0: { kind: 'ref' },
    Attachment1: { kind: 'ref' },
    Enabled: { kind: 'bool', default: true, main: true },
    Color: { kind: 'cseq', default: WHITE, main: true },
    Transparency: { kind: 'nseq', default: seq(0.5), min: 0, max: 1, main: true },
    Width0: { kind: 'number', default: 1, min: 0, max: 50, step: 0.1, main: true },
    Width1: { kind: 'number', default: 1, min: 0, max: 50, step: 0.1, main: true },
    CurveSize0: { kind: 'number', default: 0, min: -50, max: 50, step: 0.1 },
    CurveSize1: { kind: 'number', default: 0, min: -50, max: 50, step: 0.1 },
    Segments: { kind: 'int', default: 10, min: 1, max: 1000 },
    FaceCamera: { kind: 'bool', default: false },
    LightEmission: { kind: 'number', default: 0, min: 0, max: 1, step: 0.05, main: true },
    LightInfluence: { kind: 'number', default: 0, min: 0, max: 1, step: 0.05 },
    Brightness: { kind: 'number', default: 1, min: 0, max: 40, step: 0.1 },
    Texture: { kind: 'content', default: '', main: true },
    TextureLength: { kind: 'number', default: 1, min: 0.01, max: 100, step: 0.1 },
    TextureMode: { kind: 'enum:TextureMode', default: 'Stretch' },
    TextureSpeed: { kind: 'number', default: 1, min: -20, max: 20, step: 0.1 },
    ZOffset: { kind: 'number', default: 0, min: -10, max: 10, step: 0.1 }
  },
  Trail: {
    Attachment0: { kind: 'ref' },
    Attachment1: { kind: 'ref' },
    Enabled: { kind: 'bool', default: true, main: true },
    Color: { kind: 'cseq', default: WHITE, main: true },
    Transparency: { kind: 'nseq', default: seq(0.5), min: 0, max: 1, main: true },
    WidthScale: { kind: 'nseq', default: seq(1), min: 0, max: 1, main: true },
    Lifetime: { kind: 'number', default: 2, min: 0.01, max: 20, step: 0.05, main: true },
    MinLength: { kind: 'number', default: 0.1, min: 0, max: 10, step: 0.05 },
    MaxLength: { kind: 'number', default: 0, min: 0, max: 200, step: 0.5 },
    FaceCamera: { kind: 'bool', default: false },
    LightEmission: { kind: 'number', default: 0, min: 0, max: 1, step: 0.05, main: true },
    LightInfluence: { kind: 'number', default: 0, min: 0, max: 1, step: 0.05 },
    Brightness: { kind: 'number', default: 1, min: 0, max: 40, step: 0.1 },
    Texture: { kind: 'content', default: '', main: true },
    TextureLength: { kind: 'number', default: 1, min: 0.01, max: 100, step: 0.1 },
    TextureMode: { kind: 'enum:TextureMode', default: 'Stretch' }
  },
  Attachment: {
    CFrame: { kind: 'cframe', default: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
    Visible: { kind: 'bool', default: false }
  },
  PointLight: { ...LIGHT_COMMON },
  SpotLight: { ...LIGHT_COMMON, Angle: { kind: 'number', default: 90, min: 0, max: 180, step: 1 }, Face: { kind: 'enum:NormalId', default: 'Front' } },
  SurfaceLight: { ...LIGHT_COMMON, Angle: { kind: 'number', default: 90, min: 0, max: 180, step: 1 }, Face: { kind: 'enum:NormalId', default: 'Front' } },
  Highlight: {
    Enabled: { kind: 'bool', default: true, main: true },
    FillColor: { kind: 'color3', default: [1, 0, 0], main: true },
    FillTransparency: { kind: 'number', default: 0.5, min: 0, max: 1, step: 0.05, main: true },
    OutlineColor: { kind: 'color3', default: [1, 1, 1], main: true },
    OutlineTransparency: { kind: 'number', default: 0, min: 0, max: 1, step: 0.05 },
    DepthMode: { kind: 'enum:HighlightDepthMode', default: 'AlwaysOnTop' },
    Adornee: { kind: 'ref' }
  },
  Part: {
    CFrame: { kind: 'cframe', default: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
    Size: { kind: 'vec3', default: [4, 1, 2], main: true },
    Color: { kind: 'color3', default: [0.639, 0.635, 0.647] },
    Transparency: { kind: 'number', default: 0, min: 0, max: 1, step: 0.05, main: true },
    Anchored: { kind: 'bool', default: false },
    CanCollide: { kind: 'bool', default: true },
    Shape: { kind: 'enum:PartType', default: 'Block' },
    Material: { kind: 'enum:Material', default: 'Plastic', main: true },
    CastShadow: { kind: 'bool', default: true }
  },
  MeshPart: {
    CFrame: { kind: 'cframe', default: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
    Size: { kind: 'vec3', default: [1, 1, 1], main: true },
    Color: { kind: 'color3', default: [0.639, 0.635, 0.647] },
    Transparency: { kind: 'number', default: 0, min: 0, max: 1, step: 0.05, main: true },
    MeshId: { kind: 'content', default: '' },
    TextureID: { kind: 'content', default: '', main: true },
    Material: { kind: 'enum:Material', default: 'Plastic', main: true },
    Anchored: { kind: 'bool', default: false },
    CanCollide: { kind: 'bool', default: true }
  },
  SpecialMesh: {
    MeshType: { kind: 'enum:MeshType', default: 'Head' },
    MeshId: { kind: 'content', default: '' },
    TextureId: { kind: 'content', default: '', main: true },
    Scale: { kind: 'vec3', default: [1, 1, 1], main: true },
    Offset: { kind: 'vec3', default: [0, 0, 0] },
    VertexColor: { kind: 'vec3', default: [1, 1, 1] }
  },
  Model: {},
  Folder: {},
  Script: { Enabled: { kind: 'bool', default: true } },
  LocalScript: { Enabled: { kind: 'bool', default: true } },
  ModuleScript: {}
}

// Classes the importer keeps (everything else is dropped unless it holds one of these).
export const VFX_CLASSES = new Set(['ParticleEmitter', 'Beam', 'Trail', 'Attachment', 'PointLight', 'SpotLight', 'SurfaceLight', 'Highlight', 'MeshPart', 'SpecialMesh'])
export const CONTAINER_CLASSES = new Set(['Model', 'Folder', 'Part', 'MeshPart', 'Attachment', 'Configuration', 'WedgePart', 'UnionOperation'])
export const SCRIPT_CLASSES = new Set(['Script', 'LocalScript', 'ModuleScript'])

export function propSpec(className: string, prop: string): PropSpec | undefined {
  return SCHEMA[className]?.[prop]
}

// A property value or its Roblox default.
export function prop<T extends PropValue>(node: { className: string; props: Record<string, PropValue> }, name: string): T {
  const v = node.props[name]
  if (v !== undefined) return v as T
  return SCHEMA[node.className]?.[name]?.default as T
}
