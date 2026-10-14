// IPC types for the UI Motion Lab (main/services/uimotion) and the Figma import. HarnessApi /
// HarnessEvents extend these (types.ts). The Figma token never crosses IPC: only whether one is set.

import type { Restatement } from './restate/types.ts'
import type { PrincipleCheck, PrincipleScore } from './principles/types.ts'
import type { MappingReport } from './uimotion/figma/map.ts'
import type { LabSubject } from './uimotion/compile.ts'
import type { MotionSpec } from './uimotion/spec.ts'
import type { UiMotionVision } from './uimotion/ai.ts'

export type { MotionSpec, MotionEffect, EffectKind, MotionTarget } from './uimotion/spec.ts'
export type { MappingReport, MappingNote } from './uimotion/figma/map.ts'
export type { LabSubject } from './uimotion/compile.ts'
export type { UiMotionVision, UiMotionChange } from './uimotion/ai.ts'

export type UiMotionScope = 'user' | 'project'

// A UI element the lab can preview: an imported (or generated) component module in the project.
export interface UiComponentRef {
  name: string
  // Repo-relative files.
  module: string
  story?: string
  // DataModel path of the module (null when the folder is not mapped in the project file).
  instance: string[] | null
  // Paths under the component root ("" = root), with classes: what effects can target.
  elements: { path: string; className: string }[]
  source: 'figma-plugin' | 'figma-link' | 'project'
  // "Figma file abc, node 1:2" / "plugin: Play Button".
  from?: string
  importedAt: number
  // The mapping report summary ("approximated: drop shadow · dropped: layer blur").
  summary?: string
}

export interface UiMotionCritique {
  at: number
  overall: number
  summary: string
  // Code checks (UI principles) on the simulated timeline.
  checks: PrincipleCheck[]
  vision?: UiMotionVision
  principles?: PrincipleScore[]
  principleScore?: number
  focus?: string[]
  // Entry files (frames/critique-N.png).
  frames: string[]
}

export interface UiMotionEntry {
  id: string
  scope: UiMotionScope
  name: string
  description: string
  // The brief, "manual", or "preset:<key>".
  origin: string
  tags: string[]
  createdAt: number
  updatedAt: number
  spec: MotionSpec
  // The component it was designed on (name), when any.
  component?: string
  rating?: 'up' | 'down'
  quality?: 'good' | 'avoid'
  restatement?: Restatement
  critique?: UiMotionCritique
  thumbs: string[]
  written?: { module: string; story?: string; at: number }
}

export interface UiMotionStatus {
  projectRoot: string | null
  // Default-tier model for "describe the feel" / critic-tier model for the critique.
  compose: boolean
  vision: boolean
  lune: boolean
  figmaToken: boolean
  entries: { user: number; project: number }
  // Where imports / exports go (repo-relative), when a project is open.
  uiDir: string | null
}

export interface FigmaImportResult {
  component: UiComponentRef
  files: string[]
  report: MappingReport
  warnings: string[]
}

export interface UiMotionComposeResult {
  entry: UiMotionEntry
  source: 'model' | 'heuristic'
  notes: string[]
}

export interface UiMotionExportResult {
  files: string[]
  module: string
  story?: string
  requirePath: string | null
  warnings: string[]
}

export interface FigmaTokenStatus {
  set: boolean
  // Encryption available on this computer (safeStorage).
  canStore: boolean
}

export interface UiMotionApi {
  uiMotionStatus(): Promise<UiMotionStatus>
  uiMotionList(): Promise<UiMotionEntry[]>
  uiMotionGet(id: string): Promise<UiMotionEntry>
  // Create (no id) or replace a stack; the spec is normalised.
  uiMotionSave(spec: MotionSpec, opts?: { id?: string; origin?: string; scope?: UiMotionScope; component?: string; name?: string }): Promise<UiMotionEntry>
  uiMotionDelete(id: string): Promise<boolean>
  // Thumbs up: library "good" + memory skill; down: "avoid" + feedback memory. Both teach the UI principles.
  uiMotionRate(id: string, rating: 'up' | 'down' | null): Promise<UiMotionEntry>
  // Components the lab can preview (imported from Figma into this project).
  uiMotionComponents(): Promise<UiComponentRef[]>
  // The plugin's "Send selection to Forge" JSON (paste or file contents).
  uiMotionImportFigmaDoc(json: string, opts?: { name?: string }): Promise<FigmaImportResult>
  // A Figma link (figma.com/design/<key>/...?node-id=1-2), fetched with the stored token.
  uiMotionImportFigmaUrl(url: string, opts?: { name?: string }): Promise<FigmaImportResult>
  uiMotionFigmaToken(): Promise<FigmaTokenStatus>
  uiMotionSetFigmaToken(token: string): Promise<FigmaTokenStatus>
  uiMotionClearFigmaToken(): Promise<FigmaTokenStatus>
  uiMotionTestFigmaToken(): Promise<{ ok: boolean; message: string }>
  // Writes the scratch lab story for a subject (in .forge/uimotion/lab/, git-ignored); returns its
  // repo-relative file for uiPreviewOpen.
  uiMotionLabStory(subject: LabSubject): Promise<{ file: string }>
  // restatement: the reading of the brief the user confirmed ("Restate first").
  uiMotionCompose(brief: string, opts?: { restatement?: Restatement; component?: string; current?: MotionSpec }): Promise<UiMotionComposeResult>
  // frames: PNG data URLs captured from the live preview (rest, hover, press, release, settle).
  uiMotionCritique(id: string, opts?: { frames?: string[]; labels?: string[]; apply?: boolean }): Promise<{ entry: UiMotionEntry; critique: UiMotionCritique; applied: string[] }>
  // Writes <Name>Effects.luau (and a story for the component) into the project.
  uiMotionExport(id: string, opts?: { component?: string }): Promise<UiMotionExportResult>
  // A screenshot of a rectangle of the Forge window (CSS pixels) as a PNG data URL.
  uiMotionSnap(rect: { x: number; y: number; width: number; height: number }): Promise<string | null>
  // An entry file (frames/...) as a data URL.
  uiMotionFile(id: string, file: string): Promise<string | null>
}

export interface UiMotionEvents {
  'uimotion:changed': { at: number }
}
