// IPC types for the Ability Composer (main/services/ability). HarnessApi / HarnessEvents extend these.
// Animation Lab clips (listAnimClips / getAnimPose) are the Animation Lab's API; the composer only
// reads them.

import type { Restatement } from './restate/types.ts'
import type { Ability, AbilityComposeResult, AbilityCritique, AbilityEntry, AbilityExportResult, AbilityScope, AbilityStatus } from './ability/types.ts'

export type * from './ability/types.ts'

export interface AbilityApi {
  abilityStatus(): Promise<AbilityStatus>
  abilityList(): Promise<AbilityEntry[]>
  abilityGet(id: string): Promise<AbilityEntry>
  // Create (no id) or replace an ability; the result is normalised (AbilityError on bad input).
  abilitySave(ability: Ability, opts?: { id?: string; origin?: string; scope?: AbilityScope }): Promise<AbilityEntry>
  abilityDelete(id: string): Promise<boolean>
  // Thumbs up saves the move as an example (memory skill ability-example-<Name>); down as "avoid".
  abilityRate(id: string, rating: 'up' | 'down' | null): Promise<AbilityEntry>
  // restatement: the reading of the brief the user confirmed ("Restate first").
  abilityCompose(request: string, opts?: { restatement?: Restatement }): Promise<AbilityComposeResult>
  // Timing rules (+ vision critic on frames at the key beats when available); apply: fix the timings.
  abilityCritique(id: string, opts?: { vision?: boolean; apply?: boolean }): Promise<{ entry: AbilityEntry; critique: AbilityCritique; applied: string[] }>
  abilityExport(id: string): Promise<AbilityExportResult>
  abilityExamples(): Promise<{ key: string; name: string; description: string; tags: string[] }[]>
  abilityAddExample(key: string): Promise<AbilityEntry>
  // An entry file (frames/..., thumbs/...) as a data URL.
  abilityFile(id: string, file: string): Promise<string | null>
  abilitySaveThumb(id: string, pngDataUrl: string): Promise<AbilityEntry>
  // Native picker for local sound files ([] when cancelled); a local sound as a data URL for the preview.
  abilityChooseSounds(): Promise<string[]>
  abilitySoundUrl(path: string): Promise<string | null>
}

export interface AbilityEvents {
  'ability:changed': { at: number }
}
