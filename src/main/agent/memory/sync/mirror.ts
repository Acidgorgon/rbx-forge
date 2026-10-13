// Two-way mirror between this device's stores and a shared folder (a sync folder in Dropbox /
// OneDrive / iCloud Drive, or the working tree of the forge-brain git repo).
//
// Per file, against `base` (each file's hash when the two sides last agreed):
//   only local changed   -> copy local to the shared side (or delete it there)
//   only shared changed  -> copy to local (or delete locally)
//   both changed         -> the newer `updated` frontmatter wins (file mtime for non-markdown);
//                           the losing version is kept locally as "<file>.conflict"
//   edited on one side, deleted on the other -> the edit wins (nothing is lost)
// Local text files that trip the secret scanner are never copied out (`held`).
// No electron; plain fs.

import { createHash } from 'node:crypto'
import { mkdir, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { unsafeReason } from '../safety.ts'
import { CONFLICT_SUFFIX, isText, readMaybe, safeJoin, updatedOf, walkFiles } from './files.ts'

export interface MirrorRoot {
  // Folder in the shared tree: "memory" or "extra/<id>".
  prefix: string
  // This device's folder.
  dir: string
  // Files never synced (e.g. the regenerated MEMORY.md index).
  exclude?: (rel: string) => boolean
}

// key "<prefix>/<rel>" -> sha1 of the content both sides last agreed on.
export type MirrorBase = Record<string, string>

export interface MirrorResult {
  pulled: number
  pushed: number
  conflicts: number
  // Local files not sent because the secret scanner refused them.
  held: string[]
  base: MirrorBase
  // Something on this device changed (stores need re-reading).
  localChanged: boolean
}

interface Side {
  hash: string
  data: Buffer
  updated: number
}

const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex')

async function snapshot(dir: string, exclude?: (rel: string) => boolean): Promise<Map<string, Side>> {
  const out = new Map<string, Side>()
  for (const f of await walkFiles(dir)) {
    if (exclude?.(f.rel)) continue
    const data = await readMaybe(f.abs)
    if (!data) continue
    out.set(f.rel, { hash: sha1(data), data, updated: updatedOf(f.rel, data, f.mtime) })
  }
  return out
}

async function put(base: string, rel: string, data: Buffer): Promise<void> {
  const target = safeJoin(base, rel)
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, data)
  try {
    await rename(tmp, target)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}

async function del(base: string, rel: string): Promise<void> {
  const target = safeJoin(base, rel)
  await rm(target, { force: true })
  // Prune now-empty folders (a deleted skill's folder) up to base.
  const stop = resolve(base)
  let dir = dirname(target)
  while (dir.startsWith(stop + sep)) {
    try {
      if ((await readdir(dir)).length) break
      await rmdir(dir)
    } catch {
      break
    }
    dir = dirname(dir)
  }
}

export async function mirror(roots: MirrorRoot[], shared: string, base: MirrorBase): Promise<MirrorResult> {
  const result: MirrorResult = { pulled: 0, pushed: 0, conflicts: 0, held: [], base: {}, localChanged: false }
  for (const root of roots) {
    const remoteDir = join(shared, ...root.prefix.split('/'))
    await mkdir(root.dir, { recursive: true })
    const local = await snapshot(root.dir, root.exclude)
    const remote = await snapshot(remoteDir, root.exclude)
    const keys = new Set([...local.keys(), ...remote.keys()])
    for (const rel of [...keys].sort()) {
      const key = `${root.prefix}/${rel}`
      const L = local.get(rel)
      const R = remote.get(rel)
      const B = base[key]
      const blocked = L && isText(L.data) ? unsafeReason(L.data.toString('utf8')) : null
      const push = async () => {
        if (blocked) {
          result.held.push(key)
          return false
        }
        await put(remoteDir, rel, L!.data)
        result.pushed++
        return true
      }
      const pull = async () => {
        await put(root.dir, rel, R!.data)
        result.pulled++
        result.localChanged = true
      }

      if (L && R && L.hash === R.hash) {
        result.base[key] = L.hash
        continue
      }
      if (!L && !R) continue
      const localChanged = (L?.hash ?? undefined) !== B
      const remoteChanged = (R?.hash ?? undefined) !== B

      if (localChanged && !remoteChanged) {
        if (L) {
          if (await push()) result.base[key] = L.hash
          else if (B) result.base[key] = B
        } else {
          await del(remoteDir, rel)
          result.pushed++
        }
        continue
      }
      if (remoteChanged && !localChanged) {
        if (R) {
          await pull()
          result.base[key] = R.hash
        } else {
          await del(root.dir, rel)
          result.pulled++
          result.localChanged = true
        }
        continue
      }
      // Both changed.
      if (!R) {
        // Deleted on the shared side, edited here: keep the edit.
        if (await push()) result.base[key] = L!.hash
        continue
      }
      if (!L) {
        await pull()
        result.base[key] = R.hash
        continue
      }
      result.conflicts++
      const localWins = L.updated > R.updated
      if (localWins) {
        await put(root.dir, `${rel}${CONFLICT_SUFFIX}`, R.data)
        result.localChanged = true
        if (await push()) result.base[key] = L.hash
      } else {
        await put(root.dir, `${rel}${CONFLICT_SUFFIX}`, L.data)
        await pull()
        result.base[key] = R.hash
      }
    }
  }
  return result
}
