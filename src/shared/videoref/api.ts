// IPC types for video references (main/services/videoref). HarnessApi / HarnessEvents extend these.
// A video reference is a library entry of kind 'media' in the VFX Lab or the Animation Lab; tags,
// notes, ratings and delete go through vfxUpdate / animUpdate, vfxRate / animRate, vfxDelete /
// animDelete. "Make it like this" is vfxCompose / animCompose with { reference: id }.

import type { RefEntry, RefLab, RefProgress, RefSaveInput } from './types.ts'

export type * from './types.ts'

export interface RefApi {
  // Saves a clip the renderer decoded and analysed (pages/videoref): files, analysis, library entry.
  // The vision summary runs in the background when a model is set up (ref:progress).
  refSave(input: RefSaveInput): Promise<RefEntry>
  refList(lab?: RefLab): Promise<RefEntry[]>
  refGet(id: string): Promise<RefEntry>
  // Runs (or re-runs) the vision summary (critic tier) and waits for it.
  refDescribe(id: string): Promise<RefEntry>
  // A file of a reference (ref/sheet.png, ref/key-*.png, media/*) as a data URL.
  refFile(id: string, file: string): Promise<string | null>
  // The offscreen decoder (ref_import): the bytes of a file main registered under `token`.
  refDecodeSource(token: string): Promise<{ name: string; mime: string; bytes: Uint8Array } | null>
}

export interface RefEvents {
  'ref:progress': RefProgress
}
