// Studio check: play a VFX Lab effect, Animation Lab clip or Ability Composer move in the user's real
// Roblox Studio (through the Forge Bridge plugin), capture the Studio window at the key beats and feed
// those frames to the critic. Plain data shared by main, preload and renderer. No electron imports.

import type { StudioPlaces, StudioTarget } from './target.ts'
export type { StudioPlace, StudioPlaces, StudioTarget } from './target.ts'

export type StudioCheckKind = 'vfx' | 'anim' | 'ability'

// Settings key: when on, the labs' render step (refine loops, ability critique) uses Studio frames
// whenever Studio is connected, and falls back to the preview otherwise.
export const STUDIO_PREFER_SETTING = 'studio.critiqueInStudio'

// Localhost port of Forge's bridge server (the template's studio-sync uses 34873).
export const BRIDGE_PORT = 34877

// Overall state, in the order the UI explains them.
export type StudioState =
  | 'ready'
  | 'no-plugin' // the Forge Bridge plugin is not in the Studio plugins folder
  | 'plugin-outdated'
  | 'studio-offline' // the plugin has not polled recently (Studio closed, or plugin disabled)
  | 'no-capture' // the Studio window is not visible to screen capture (minimised, permission)
  | 'busy'
  | 'server-error' // Forge could not listen on the bridge port
  | 'unsupported' // no Roblox Studio on this OS

export interface StudioStatus {
  state: StudioState
  message: string
  server: { port: number; listening: boolean; error?: string }
  plugin: { installed: boolean; dir: string | null; file?: string; version?: number; bundled: number; outdated?: boolean }
  studio: { connected: boolean; lastSeen?: number; place?: string; placeId?: number; pluginVersion?: number }
  capture: { available: boolean; window?: string; hint?: string }
  // Rojo is not needed (jobs carry their modules), shown for information.
  rojo?: 'running' | 'stopped'
  prefer: boolean
  busy?: { kind: StudioCheckKind; id: string; phase: StudioPhase }
}

export type StudioPhase = 'queued' | 'waiting' | 'staging' | 'capturing' | 'preview' | 'critique' | 'done' | 'error'

export interface StudioProgress {
  kind: StudioCheckKind
  id: string
  phase: StudioPhase
  message?: string
}

export interface StudioFrame {
  beat: number
  label: string
  // Seconds into the effect / clip / move.
  t: number
  // Entry files (studio/beat-N.png, studio/preview-N.png).
  file: string
  preview?: string
  // How far the captured frame was from the target time (realtime capture), in ms.
  offsetMs?: number
}

export interface StudioMark {
  label: string
  t: number
}

export interface StudioCheckRecord {
  kind: StudioCheckKind
  id: string
  name: string
  at: number
  ok: boolean
  mode: 'realtime' | 'stepped'
  frames: StudioFrame[]
  // Stage / marker times reported by the plugin while it played (realtime jobs).
  marks: StudioMark[]
  // Planned vs played stage times (seconds), when the plugin reported stages.
  drift?: { label: string; planned: number; actual: number }[]
  window?: string
  place?: string
  crop?: { x: number; y: number; width: number; height: number } | null
  critique?: { overall: number; summary: string }
  error?: string
  ms: number
  // Absolute paths of the Studio frames (returned by a check, not stored).
  abs?: string[]
}

export interface StudioCheckOptions {
  // Run the lab's critic on the Studio frames (with the preview frames for comparison).
  critique?: boolean
  // Also render the preview at the same times (side by side in the UI). Default true.
  preview?: boolean
}

export interface StudioApi {
  studioStatus(): Promise<StudioStatus>
  // Writes the Forge Bridge plugin into the local Studio plugins folder (Studio loads it on restart
  // or when the folder changes).
  studioInstallPlugin(): Promise<StudioStatus>
  studioOpenPluginsFolder(): Promise<void>
  studioSetPrefer(on: boolean): Promise<StudioStatus>
  studioCheck(kind: StudioCheckKind, id: string, opts?: StudioCheckOptions): Promise<StudioCheckRecord>
  studioLastCheck(kind: StudioCheckKind, id: string): Promise<StudioCheckRecord | null>
  // A Studio check file (studio/beat-N.png...) as a data URL.
  studioFile(kind: StudioCheckKind, id: string, file: string): Promise<string | null>
  // Studio target (several places open): the connected places and where jobs go; the choice is kept
  // per project (null: any Studio window).
  studioPlaces(): Promise<StudioPlaces>
  studioSetTarget(target: StudioTarget | null): Promise<StudioPlaces>
}

export interface StudioEvents {
  'studio:bridge': StudioStatus
  'studio:progress': StudioProgress
  // Startup put the bundled plugin into Studio's plugins folder (it was missing or older).
  'studio:pluginAuto': { action: 'installed' | 'updated' }
}
