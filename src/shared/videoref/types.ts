// Plain-data types of video references (VFX Lab and Animation Lab): a clip or GIF the user drops in
// ("make it like this"), decoded in the renderer into small frames, measured in pure code
// (analyze.ts) and described by the vision model (prompt.ts). Stored on library entries of kind
// 'media' (VfxEntry.video / AnimEntry.video). No electron or React imports.

export type RefLab = 'vfx' | 'anim'

// The four beats of an effect (and of a move, read as anticipation / action / recovery).
export const REF_BEATS = ['anticipation', 'release', 'impact', 'dissipate'] as const
export type RefBeatLabel = (typeof REF_BEATS)[number]

// Normalised crop of the source frame (0..1 of width / height).
export interface RefCrop {
  x: number
  y: number
  w: number
  h: number
}

// One decoded, downscaled frame (RGBA, row-major). Times are seconds from the trim start.
export interface RgbaFrame {
  t: number
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array
}

export interface PaletteColor {
  hex: string
  // Share of the (weighted) pixels this colour stands for, 0..1.
  share: number
}

// Per sampled frame: what the beat detection works from.
export interface RefFrameStat {
  t: number
  // Mean absolute luminance change from the previous frame (0..1).
  motion: number
  // Mean luminance (0..1).
  brightness: number
  // Share of near-white pixels (luma > 0.8).
  bright: number
  // Share of the frame that changed (|diff| above the noise floor).
  active: number
}

export interface RefSegment {
  label: RefBeatLabel
  start: number
  end: number
  // Time of the strongest frame inside the segment.
  peak: number
  // Mean motion energy inside the segment, relative to the clip's peak (0..1).
  energy: number
  palette: PaletteColor[]
}

// A peak in motion energy (a hit, a swing, a burst).
export interface RefBeatPeak {
  t: number
  strength: number
}

// Animation Lab: where the motion holds and where it is fast.
export interface RefTimelineSpan {
  kind: 'hold' | 'move' | 'fast'
  start: number
  end: number
}

export interface RefGlow {
  // 0..1: how much soft halo surrounds the brightest parts (bloom).
  bloom: number
  // Peak share of near-white pixels in one frame.
  peakBright: number
  level: 'none' | 'soft' | 'strong'
}

export type RefDirection = 'left' | 'right' | 'up' | 'down' | 'outward' | 'inward' | 'still'

export interface RefMotion {
  direction: RefDirection
  // Screen-space angle of the travel (degrees; 0 = right, 90 = up), null when there is no travel.
  angle: number | null
  // Share of the frame the moving part covers at the peak and on average.
  peakCoverage: number
  meanCoverage: number
  // Bounding box of the motion at the peak (normalised).
  bbox: RefCrop | null
  // Travel of the motion centroid across the clip, as a share of the frame diagonal.
  travel: number
}

export interface RefKeyFrame {
  t: number
  label: string
  // Index into the sampled frames.
  index: number
  // PNG file inside the entry folder (set when stored).
  file?: string
}

export interface VideoRefAnalysis {
  version: 1
  duration: number
  // Sampling rate of the analysed frames.
  fps: number
  width: number
  height: number
  frames: RefFrameStat[]
  peaks: RefBeatPeak[]
  // Times of brightness spikes (flash / impact frames).
  flashes: number[]
  segments: RefSegment[]
  palette: PaletteColor[]
  glow: RefGlow
  motion: RefMotion
  timeline: RefTimelineSpan[]
  keyFrames: RefKeyFrame[]
}

// The vision model's structured description (critic tier).
export interface RefVision {
  summary: string
  // VFX: what it is made of.
  effect?: string
  layers?: { name: string; shape?: string; color?: string; motion?: string; timing?: string }[]
  shapes?: string[]
  motion?: string
  colors?: string
  roblox?: string
  // Animation: the pose at each beat and the timing feel.
  poses?: { beat: string; pose: string }[]
  timing?: string
  model?: string
  at: number
}

export interface VideoRef {
  lab: RefLab
  source: { name: string; mime: string; bytes: number; width: number; height: number; duration: number; file?: string }
  trim: { start: number; end: number }
  crop?: RefCrop
  analysis: VideoRefAnalysis
  // Contact sheet PNG inside the entry folder.
  sheet: string
  vision?: RefVision
}

// A video reference as the Ref API returns it (either lab).
export interface RefEntry {
  id: string
  lab: RefLab
  scope: 'user' | 'project'
  name: string
  description: string
  tags: string[]
  notes: string
  rating?: 'up' | 'down'
  quality?: 'reference' | 'good' | 'avoid'
  createdAt: number
  updatedAt: number
  thumbs: string[]
  video: VideoRef
}

// What the renderer sends after decoding and analysing a clip.
export interface RefSaveInput {
  lab: RefLab
  scope?: 'user' | 'project'
  name: string
  tags?: string[]
  notes?: string
  source: { name: string; mime: string; bytes: number; width: number; height: number; duration: number }
  // The original file (kept in media/ when small enough); omitted for large clips.
  sourceData?: Uint8Array
  trim: { start: number; end: number }
  crop?: RefCrop
  analysis: VideoRefAnalysis
  // PNG data URLs.
  sheet: string
  keyFrames: { t: number; label: string; index: number; png: string }[]
  // Run the vision summary in the background after saving (default true when a model is set up).
  describe?: boolean
}

// Decode options shared by the review UI and the offscreen decoder (ref_import).
export interface RefDecodeOptions {
  start?: number
  end?: number
  crop?: RefCrop
  maxSide?: number
  maxFrames?: number
}

export interface RefProgress {
  id: string
  phase: 'describe' | 'done' | 'error'
  message?: string
}
