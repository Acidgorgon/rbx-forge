// Launch-time choice of the code to run (no electron imports; src/main/bootstrap.ts calls it).
//
// userData/code/<version>/ holds an unpacked quick bundle: main/, preload/, renderer/ and the signed
// quick.json it was installed from. At every launch the newest folder that
//   - is a quick version newer than the installed app (a newer full installer wins),
//   - is not marked bad (state.json),
//   - still verifies: quick.json's signature against the key built into the installed app, and the
//     sha256 of every file it lists,
//   - matches the installed app's Electron and package versions,
// is loaded; otherwise the installed app's own code. Folders that can never run again (older than
// the installed app, superseded, bad, half-written) are returned in `remove`.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parseAndVerify, sha256Hex, type QuickManifest } from './manifest.ts'
import { checkCompat, type ShellInfo } from './shellInfo.ts'
import { beginBoot, isBad, markBad, readCodeState, recoverInterruptedBoot, writeCodeState, type CodeState } from './codeState.ts'
import { compareVersions, isQuickVersion } from './version.ts'

export const STATE_FILE = 'state.json'
export const MANIFEST_FILE = 'quick.json'
export const ENTRY = 'main/app.js'

export interface BootOptions {
  codeRoot: string
  shellVersion: string
  shell: ShellInfo
  publicKey: string
  now?: () => number
  log?: (line: string) => void
}

export interface BootChoice {
  version: string
  dir: string
  manifest: QuickManifest
}

export interface BootPlan {
  choice: BootChoice | null
  state: CodeState
  // Folders to delete (after the app has started).
  remove: string[]
}

// Re-checks an installed bundle: signature, version, every file's sha256. Throws on any mismatch.
export function verifyInstalled(dir: string, version: string, publicKey: string): QuickManifest {
  const manifest = parseAndVerify(readFileSync(join(dir, MANIFEST_FILE), 'utf8'), publicKey)
  if (manifest.version !== version) throw new Error(`quick.json is for ${manifest.version}, not ${version}`)
  for (const [path, sha] of Object.entries(manifest.files)) {
    let data: Buffer
    try {
      data = readFileSync(join(dir, ...path.split('/')))
    } catch {
      throw new Error(`${path} is missing`)
    }
    if (sha256Hex(data) !== sha) throw new Error(`${path} was changed after it was installed`)
  }
  return manifest
}

export function planBoot(opts: BootOptions): BootPlan {
  const now = opts.now ?? Date.now
  const log = opts.log ?? (() => undefined)
  const stateFile = join(opts.codeRoot, STATE_FILE)
  if (!existsSync(opts.codeRoot)) return { choice: null, state: readCodeState(stateFile), remove: [] }
  const recovered = recoverInterruptedBoot(readCodeState(stateFile), now())
  let state = recovered.state
  if (recovered.failed) log(`quick update ${recovered.failed} did not finish starting last time; marked bad`)

  const remove: string[] = []
  const candidates: string[] = []
  for (const name of readdirSync(opts.codeRoot)) {
    if (name === STATE_FILE || name.startsWith(`${STATE_FILE}.`)) continue
    const dir = join(opts.codeRoot, name)
    if (!isQuickVersion(name)) {
      remove.push(dir) // half-written temp folders and anything else
      continue
    }
    if (state.disabled || isBad(state, name) || compareVersions(name, opts.shellVersion) <= 0) remove.push(dir)
    else candidates.push(name)
  }
  candidates.sort((a, b) => compareVersions(b, a))

  let choice: BootChoice | null = null
  for (const version of candidates) {
    const dir = join(opts.codeRoot, version)
    if (choice) {
      remove.push(dir) // older than the one that runs
      continue
    }
    let manifest: QuickManifest
    try {
      manifest = verifyInstalled(dir, version, opts.publicKey)
    } catch (e) {
      log(`quick update ${version} failed verification: ${(e as Error).message}; marked bad`)
      state = markBad(state, version, `failed verification: ${(e as Error).message}`, now())
      remove.push(dir)
      continue
    }
    const compat = checkCompat(manifest, opts.shell)
    if (!compat.ok) {
      log(`quick update ${version} does not fit this install (${compat.reasons.join('; ')})`)
      remove.push(dir)
      continue
    }
    choice = { version, dir, manifest }
  }
  if (choice) state = beginBoot(state, choice.version, now())
  if (choice || recovered.failed || remove.length) {
    try {
      writeCodeState(stateFile, state)
    } catch (e) {
      // Without the marker a broken version could not be caught: run the installed code instead.
      log(`could not write ${stateFile}: ${(e as Error).message}`)
      return { choice: null, state, remove: [] }
    }
  }
  return { choice, state, remove }
}

export async function removeDirs(dirs: string[], log?: (line: string) => void): Promise<void> {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch((e: Error) => log?.(`could not remove ${dir}: ${e.message}`))
  }
}
