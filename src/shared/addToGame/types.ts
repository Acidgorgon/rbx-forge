// "Add to game": put a lab result (VFX effect, animation clip, ability, and later UI Motion /
// thumbnails) into the game repo. Pick the place (*.project.json) and folder (suggested from the
// project layout), see the exact files, confirm a diff before anything existing changes. Files land
// where Rojo maps them (Forge Sync's mapping.toDisk / fromDisk).

// Built-in labs; other labs register an adapter under their own id (main/services/addToGame).
export type AddToGameLab = 'vfx' | 'anim' | 'ability' | (string & {})

// Where the module belongs in a Roblox game.
//   shared: required by client and server code (ReplicatedStorage)
//   client: client-only runners (StarterPlayerScripts / a client tree under ReplicatedStorage)
//   server: ServerScriptService / ServerStorage
export type AddToGameRealm = 'shared' | 'client' | 'server'

export interface AddToGameTarget {
  // *.project.json file name.
  placeFile: string
  // Instance path of the folder the item goes into, e.g. ["ReplicatedStorage", "Shared", "VFX"].
  instance: string[]
}

export interface AddTargetOption extends AddToGameTarget {
  // Repo-relative directory Rojo maps to `instance`.
  dir: string
  label: string
  recommended: boolean
  reason: string
  // The folder exists on disk already.
  exists: boolean
}

export interface AddToGamePlace {
  file: string
  name: string
  isDefault: boolean
}

export interface AddToGameOptions {
  lab: AddToGameLab
  id: string
  name: string
  realm: AddToGameRealm
  places: AddToGamePlace[]
  // Per place, best first.
  targets: AddTargetOption[]
  // The suggestion (remembered choice for this lab + project when still valid, else the top option).
  suggested: AddToGameTarget | null
  remembered: boolean
  // Things to know before adding (no asset id yet, textures not uploaded ...).
  notes: string[]
  // Texture ids to upload first (VFX); the dialog offers to upload them.
  uploads?: { id: string; label: string }[]
}

export type AddFileStatus = 'new' | 'same' | 'changed' | 'kept'

export interface AddToGameFile {
  path: string
  role: string
  status: AddFileStatus
  bytes: number
  // Unified diff for 'changed' (capped), and why a file is 'kept' (edited by hand, left alone).
  diff?: string
  note?: string
}

export interface AddToGamePlan {
  lab: AddToGameLab
  id: string
  target: AddToGameTarget
  dir: string
  // Instance path of the item itself.
  instance: string[]
  files: AddToGameFile[]
  warnings: string[]
  requirePath: string | null
}

export interface AddToGameResult {
  written: string[]
  // Changed files the user did not confirm, and kept (hand-edited) files.
  skipped: string[]
  requirePath: string | null
  command: string | null
}

export interface AddToGameApi {
  addToGameOptions(lab: AddToGameLab, id: string): Promise<AddToGameOptions>
  addToGamePreview(lab: AddToGameLab, id: string, target: AddToGameTarget): Promise<AddToGamePlan>
  // Writes new files, and the 'changed' files listed in `confirmed` (after the diff confirm).
  addToGameApply(lab: AddToGameLab, id: string, target: AddToGameTarget, confirmed: string[]): Promise<AddToGameResult>
}
