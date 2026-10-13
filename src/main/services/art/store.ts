// Files under <project>/art: concepts/<yyyy-mm-dd>/<slug>-<n>.png plus <slug>-<n>.json sidecars,
// ui/<Name>.png for "Save to project", and art/.gitignore for the git policy. No electron imports.

import { mkdir, readdir, readFile, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ArtGitPolicy, ArtItem } from '../../../shared/artTypes.ts'

export const ART_DIR = 'art'
export const CONCEPTS_DIR = 'art/concepts'
export const UI_DIR = 'art/ui'
export const LARGE_FILE_BYTES = 5 * 1024 * 1024

const toPosix = (p: string) => p.split(sep).join('/')

// Local calendar day, yyyy-mm-dd.
export function dayOf(t: number | Date): string {
  const d = typeof t === 'number' ? new Date(t) : t
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Project-relative path inside root, or null when it escapes.
export function insideRoot(root: string, path: string): string | null {
  const abs = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const rel = relative(resolve(root), abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return toPosix(rel)
}

export function conceptPath(root: string, rel: string): string {
  const r = insideRoot(root, rel)
  if (!r || !r.startsWith(`${ART_DIR}/`)) throw new Error(`not an art file: ${rel}`)
  return join(root, ...r.split('/'))
}

export const sidecarOf = (imagePath: string) => imagePath.replace(/\.(png|webp|jpe?g)$/i, '.json')

// Next free index for <slug>-<n> in a day folder.
export async function nextIndex(dir: string, slug: string): Promise<number> {
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    return 1
  }
  const re = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)\\.(png|webp|jpe?g|json)$`)
  let max = 0
  for (const n of names) {
    const m = re.exec(n)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

export async function writeConcept(root: string, item: Omit<ArtItem, 'absPath'>, bytes: Uint8Array): Promise<ArtItem> {
  const abs = join(root, ...item.path.split('/'))
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, bytes)
  await writeSidecar(root, { ...item, absPath: abs })
  return { ...item, absPath: abs }
}

export async function writeSidecar(root: string, item: ArtItem): Promise<void> {
  const { absPath: _abs, ...rest } = item
  void _abs
  await writeFile(sidecarOf(join(root, ...item.path.split('/'))), JSON.stringify(rest, null, 2) + '\n')
}

export async function readItem(root: string, rel: string): Promise<ArtItem | null> {
  const abs = conceptPath(root, rel)
  try {
    const meta = JSON.parse(await readFile(sidecarOf(abs), 'utf8')) as Omit<ArtItem, 'absPath'>
    return { ...meta, path: insideRoot(root, abs)!, absPath: abs }
  } catch {
    try {
      const s = await stat(abs)
      const name = abs.split(sep).pop()!.replace(/\.[^.]+$/, '')
      const m = /^(.*)-(\d+)$/.exec(name)
      return {
        path: insideRoot(root, abs)!,
        absPath: abs,
        date: dayOf(s.mtime),
        slug: m?.[1] ?? name,
        index: Number(m?.[2] ?? 1),
        prompt: '',
        fullPrompt: '',
        style: 'none',
        model: 'unknown',
        size: '',
        quality: '',
        background: 'auto',
        outputFormat: 'png',
        mode: 'generate',
        seed: null,
        costUsd: 0,
        createdAt: s.mtime.toISOString(),
        bytes: s.size,
        source: 'page'
      }
    } catch {
      return null
    }
  }
}

// Every concept, newest first.
export async function listConcepts(root: string): Promise<ArtItem[]> {
  const base = join(root, ...CONCEPTS_DIR.split('/'))
  let days: string[] = []
  try {
    days = (await readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name)).map((d) => d.name)
  } catch {
    return []
  }
  const items: ArtItem[] = []
  for (const day of days) {
    const names = await readdir(join(base, day)).catch(() => [] as string[])
    for (const n of names) {
      if (!/\.(png|webp|jpe?g)$/i.test(n)) continue
      const item = await readItem(root, `${CONCEPTS_DIR}/${day}/${n}`)
      if (item) items.push(item)
    }
  }
  return items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.index - a.index))
}

// Moves an image and its sidecar into trashDir/<id>/ so it can be restored.
export async function trashConcept(root: string, rel: string, trashDir: string, id: string): Promise<{ from: string; files: string[] }> {
  const abs = conceptPath(root, rel)
  const dir = join(trashDir, id)
  await mkdir(dir, { recursive: true })
  const files: string[] = []
  for (const f of [abs, sidecarOf(abs)]) {
    try {
      await stat(f)
    } catch {
      continue
    }
    const to = join(dir, f.split(sep).pop()!)
    await rename(f, to).catch(async () => {
      await copyFile(f, to)
      await rm(f, { force: true })
    })
    files.push(f)
  }
  if (!files.length) throw new Error(`${rel} does not exist`)
  return { from: abs, files }
}

export async function restoreConcept(trashDir: string, id: string, files: string[]): Promise<void> {
  for (const f of files) {
    await mkdir(dirname(f), { recursive: true })
    const from = join(trashDir, id, f.split(sep).pop()!)
    await rename(from, f).catch(async () => {
      await copyFile(from, f)
      await rm(from, { force: true })
    })
  }
  await rm(join(trashDir, id), { recursive: true, force: true })
}

// ---------------------------------------------------------------- git policy (art/.gitignore)

const HEADER = '# Managed by RBX Forge (Art page > git policy). Edits outside the marked block are kept.'
const BEGIN = '# forge:begin'
const END = '# forge:end'

export async function largeFiles(root: string, limit = LARGE_FILE_BYTES): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile() && e.name !== '.gitignore') {
        const s = await stat(p).catch(() => null)
        if (s && s.size > limit) out.push(toPosix(relative(join(root, ART_DIR), p)))
      }
    }
  }
  await walk(join(root, ART_DIR))
  return out.sort()
}

export function gitignoreBlock(policy: ArtGitPolicy, large: string[]): string[] {
  if (policy === 'ignore') return ['*', '!.gitignore']
  if (policy === 'track') return []
  return large.map((p) => `/${p}`)
}

export function mergeGitignore(existing: string | null, block: string[]): string {
  let before: string[] = []
  let after: string[] = []
  if (existing) {
    const lines = existing.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').filter((l) => l !== HEADER)
    const b = lines.indexOf(BEGIN)
    const e = lines.indexOf(END)
    if (b >= 0 && e > b) {
      before = lines.slice(0, b)
      after = lines.slice(e + 1)
    } else before = lines
  }
  return [HEADER, ...before, BEGIN, ...block, END, ...after].join('\n') + '\n'
}

export async function applyGitPolicy(root: string, policy: ArtGitPolicy): Promise<{ path: string; changed: boolean }> {
  const path = join(root, ART_DIR, '.gitignore')
  const existing = await readFile(path, 'utf8').catch(() => null)
  const next = mergeGitignore(existing, gitignoreBlock(policy, policy === 'track-small' ? await largeFiles(root) : []))
  if (next === existing) return { path: `${ART_DIR}/.gitignore`, changed: false }
  await mkdir(join(root, ART_DIR), { recursive: true })
  await writeFile(path, next)
  return { path: `${ART_DIR}/.gitignore`, changed: true }
}
