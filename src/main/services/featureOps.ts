// Feature folder operations Forge performs itself (no electron imports).
//
// renameFeature: GenTree keeps a feature in up to three places:
//   src/shared/Features/<Name>/                    shared config (the watcher's trigger)
//   src/server/Features/<Name>(/ | .luau ...)      server Service
//   src/client/**/Controllers/<Name>Controller(/ | .luau ...)   client Controller
// The template's ./dev watcher reacts to the shared folder: a new folder makes it scaffold a
// Service and Controller, a deleted one makes it DELETE them. A plain rename of the shared folder
// looks like delete + create to it, so it would delete the server/client files (or scaffold empty
// ones next to the renamed ones).
//
// So Forge renames all counterparts itself, as one operation:
//   1. stop the dev service if it is running (that is the watcher; there is no pause switch in the
//      template), and pause Forge's own project watcher (Project.pause) so the explorer, script
//      list and LSP never see the half-renamed state;
//   2. check every target is free, then move each path; on any failure, move back what was moved;
//   3. rewrite references (Features.<Old>, <Old>Controller) in Luau files under src/;
//   4. resume the project watcher (one refresh) and restart the dev service; on start the watcher
//      finds every feature already has its Service and Controller, so it changes nothing.

import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { FeatureRenameResult } from '@shared/types'

export const FEATURE_NAME = /^[A-Z][A-Za-z0-9]*$/

export interface RenameDeps {
  // Watcher control. All optional: tests run without them.
  devRunning?: () => boolean
  stopDev?: () => Promise<void>
  startDev?: () => Promise<void>
  pauseProjectWatch?: () => void
  resumeProjectWatch?: () => void
  log?: (text: string) => void
}

async function exists(path: string): Promise<boolean> {
  return !!(await stat(path).catch(() => null))
}

async function listDir(path: string): Promise<{ name: string; dir: boolean }[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).map((d) => ({ name: d.name, dir: d.isDirectory() }))
  } catch {
    return []
  }
}

// Entries in `dir` named `base` exactly (folder) or `base.<ext>` (file: .luau, .server.luau, ...).
async function matching(root: string, dir: string, base: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await listDir(join(root, ...dir.split('/')))) {
    const stem = e.dir ? e.name : e.name.replace(/(\.(server|client))?\.(luau|lua)$/, '')
    if (stem === base && (e.dir || stem !== e.name)) out.push(posix.join(dir, e.name))
  }
  return out
}

// Folders named Controllers under src/client (any depth up to 6).
async function controllerDirs(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (rel: string, depth: number) => {
    if (depth > 6) return
    for (const e of await listDir(join(root, ...rel.split('/')))) {
      if (!e.dir || e.name === 'Packages' || e.name.startsWith('.')) continue
      const child = posix.join(rel, e.name)
      if (e.name === 'Controllers') out.push(child)
      await walk(child, depth + 1)
    }
  }
  await walk('src/client', 0)
  return out
}

// Every path to move for a feature rename, from -> to.
export async function featureMoves(root: string, from: string, to: string): Promise<{ from: string; to: string }[]> {
  const moves: { from: string; to: string }[] = []
  const swap = (path: string, oldBase: string, newBase: string) => {
    const dir = posix.dirname(path)
    const name = posix.basename(path)
    return posix.join(dir, newBase + name.slice(oldBase.length))
  }
  for (const p of await matching(root, 'src/shared/Features', from)) moves.push({ from: p, to: swap(p, from, to) })
  for (const p of await matching(root, 'src/server/Features', from)) moves.push({ from: p, to: swap(p, from, to) })
  for (const dir of await controllerDirs(root)) {
    for (const p of await matching(root, dir, `${from}Controller`)) moves.push({ from: p, to: swap(p, `${from}Controller`, `${to}Controller`) })
  }
  return moves
}

// Rewrites Luau references to the old feature: `Features.Old` / `Features:WaitForChild("Old")` /
// `Features["Old"]` and the `OldController` identifier. Returns the new text, or null if unchanged.
export function rewriteReferences(text: string, from: string, to: string): string | null {
  const word = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let next = text
    .replace(new RegExp(`(\\bFeatures\\s*\\.\\s*)${word(from)}\\b`, 'g'), `$1${to}`)
    .replace(new RegExp(`(\\bFeatures\\s*:\\s*(?:WaitForChild|FindFirstChild)\\(\\s*["'])${word(from)}(["'])`, 'g'), `$1${to}$2`)
    .replace(new RegExp(`(\\bFeatures\\s*\\[\\s*["'])${word(from)}(["']\\s*\\])`, 'g'), `$1${to}$2`)
    .replace(new RegExp(`\\b${word(from)}Controller\\b`, 'g'), `${to}Controller`)
  return next === text ? null : next
}

async function luauFiles(root: string, rel: string, out: string[], depth = 0): Promise<void> {
  if (depth > 12) return
  for (const e of await listDir(join(root, ...rel.split('/')))) {
    if (e.name.startsWith('.') || e.name === 'Packages' || e.name === 'ServerPackages' || e.name === 'DevPackages') continue
    const child = posix.join(rel, e.name)
    if (e.dir) await luauFiles(root, child, out, depth + 1)
    else if (/\.(luau|lua)$/.test(e.name)) out.push(child)
  }
}

export async function renameFeature(root: string, from: string, to: string, deps: RenameDeps = {}): Promise<FeatureRenameResult> {
  from = from.trim()
  to = to.trim()
  if (!FEATURE_NAME.test(from)) throw new Error(`"${from}" is not a feature name`)
  if (!FEATURE_NAME.test(to)) throw new Error(`"${to}" is not PascalCase (e.g. Inventory)`)
  if (from === to) throw new Error('The new name is the same as the old one')
  if (!(await exists(join(root, 'src', 'shared', 'Features', from)))) throw new Error(`src/shared/Features/${from} does not exist`)

  const moves = await featureMoves(root, from, to)
  for (const m of moves) {
    if (await exists(join(root, ...m.to.split('/')))) throw new Error(`${m.to} already exists; pick another name`)
  }

  const notes: string[] = []
  const devWasRunning = deps.devRunning?.() ?? false
  deps.pauseProjectWatch?.()
  const moved: { from: string; to: string }[] = []
  const updated: string[] = []
  try {
    if (devWasRunning && deps.stopDev) {
      await deps.stopDev()
      notes.push('Paused the ./dev watcher during the rename so it would not delete or re-scaffold the Service/Controller.')
    }
    try {
      for (const m of moves) {
        await rename(join(root, ...m.from.split('/')), join(root, ...m.to.split('/')))
        moved.push(m)
      }
    } catch (error) {
      for (const m of [...moved].reverse()) await rename(join(root, ...m.to.split('/')), join(root, ...m.from.split('/'))).catch(() => undefined)
      moved.length = 0
      throw new Error(`Rename failed and was undone: ${(error as Error).message}`)
    }

    const files: string[] = []
    await luauFiles(root, 'src', files)
    for (const file of files) {
      const abs = join(root, ...file.split('/'))
      const text = await readFile(abs, 'utf8').catch(() => null)
      if (text === null) continue
      const next = rewriteReferences(text, from, to)
      if (next !== null) {
        await writeFile(abs, next, 'utf8')
        updated.push(file)
      }
    }
    if (!moves.some((m) => m.from.startsWith('src/server/'))) notes.push(`No server Feature for ${from} was found (server-less feature or not scaffolded yet).`)
    if (!moves.some((m) => m.from.startsWith('src/client/'))) notes.push(`No ${from}Controller was found.`)
  } finally {
    deps.resumeProjectWatch?.()
    if (devWasRunning && deps.startDev) {
      await deps.startDev().catch((error) => {
        notes.push(`Could not restart ./dev: ${(error as Error).message}`)
      })
    }
  }
  deps.log?.(`renamed feature ${from} -> ${to}: ${moved.length} paths moved, ${updated.length} files updated`)
  return { from, to, moved, updated, notes }
}
