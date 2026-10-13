// File helpers shared by pack export/import and device sync: path validation (zip-slip), a walker
// that skips temp/conflict files, the text sniff for the secret scanner, and `updated` lookup.
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { parseFrontmatter } from '../frontmatter.ts'

export class PackError extends Error {}

export const CONFLICT_SUFFIX = '.conflict'

// A relative path inside a pack or sync folder: forward slashes, no empty, "." or ".." segments,
// no absolute paths, drive letters, backslashes or control characters. Returns null when unsafe.
export function safeRel(name: string): string | null {
  if (!name || name.length > 512) return null
  if (/[\\\0-\x1f:]/.test(name)) return null
  if (name.startsWith('/')) return null
  const segs = name.replace(/\/+$/, '').split('/')
  for (const s of segs) if (!s || s === '.' || s === '..' || s.length > 200) return null
  return segs.join('/')
}

// Joins and re-checks that the result stays inside base (second line of defence after safeRel).
export function safeJoin(base: string, rel: string): string {
  const clean = safeRel(rel)
  if (!clean) throw new PackError(`refused unsafe path "${rel}"`)
  const root = resolve(base)
  const target = resolve(root, ...clean.split('/'))
  if (!target.startsWith(root + sep)) throw new PackError(`refused path "${rel}": it leaves the store folder`)
  return target
}

export function ignoredName(name: string): boolean {
  return name.startsWith('.') || name.endsWith(CONFLICT_SUFFIX) || name.endsWith('.tmp')
}

export interface WalkedFile {
  rel: string
  abs: string
  mtime: number
  size: number
}

// Files under dir (relative paths with "/"), skipping dotfiles, temp files and conflict copies.
export async function walkFiles(dir: string, prefix = ''): Promise<WalkedFile[]> {
  const out: WalkedFile[] = []
  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (depth > 12) return
    let ents: import('node:fs').Dirent[]
    try {
      ents = await readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    ents.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of ents) {
      if (ignoredName(e.name)) continue
      const childAbs = join(abs, e.name)
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(childAbs, childRel, depth + 1)
      else if (e.isFile()) {
        try {
          const st = await stat(childAbs)
          out.push({ rel: childRel, abs: childAbs, mtime: Math.round(st.mtimeMs), size: st.size })
        } catch {
          // vanished
        }
      }
    }
  }
  await walk(prefix ? join(dir, ...prefix.split('/')) : dir, prefix, 0)
  return out
}

// Text files are secret-scanned; binaries (images) are not (a NUL byte in the first 8 KB = binary).
export function isText(data: Buffer): boolean {
  return !data.subarray(0, 8192).includes(0)
}

// The `updated` time of a file: frontmatter `updated` (then `created`) for markdown, else mtime.
export function updatedOf(rel: string, data: Buffer, mtime: number): number {
  if (rel.endsWith('.md') && isText(data)) {
    const { data: fm } = parseFrontmatter(data.toString('utf8'))
    const u = Number(fm.updated) || Number(fm.created)
    if (u > 0) return Math.round(u)
  }
  return mtime
}

export async function readMaybe(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch {
    return null
  }
}
