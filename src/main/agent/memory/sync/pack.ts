// .forgepack export and import: a zip of Forge's learned memory so it can move to another device.
//
//   manifest.json                      format, version, created, source device, counts, item list
//   user/<name>.md                     user memories (same files as userData/memory)
//   user/skills/<name>/SKILL.md        user skills (plus any other files in the skill folder)
//   project/...                        project memory (.forge/memory), only when chosen
//   extra/<id>/<entry>[/...]           registered extra sections (sections.ts), e.g. the VFX library
//
// Export re-runs the memory secret scanner over every text file right before writing and refuses
// the pack if anything trips it. Import validates every zip path (zip-slip), re-scans, previews
// each item against this device (new / same / conflict / similar) and applies a per-item choice:
// keep mine, take theirs, or keep both (the pack copy renamed). Memories and skills are written
// through MemoryStore.save, so its validation and near-duplicate dedupe apply. No electron.

import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readZip } from '../../../services/setup/unzip.ts'
import { parseFrontmatter } from '../frontmatter.ts'
import { similarity } from '../rank.ts'
import { unsafeReason } from '../safety.ts'
import { DEDUPE_THRESHOLD, LIMITS, SKILL_FILE, SKILLS_DIR, slugify, type MemoryStore } from '../store.ts'
import type { MemoryEntry, MemoryKind, MemoryScope, MemoryType } from '../types.ts'
import { isText, PackError, readMaybe, safeJoin, safeRel, updatedOf, walkFiles } from './files.ts'
import { packSections, type PackSection } from './sections.ts'
import {
  PACK_FORMAT,
  PACK_VERSION,
  type ExportCandidate,
  type ExportCandidates,
  type ImportChoice,
  type ImportPreview,
  type ImportPreviewItem,
  type ImportResult,
  type PackItemInfo,
  type PackManifest,
  type PackSectionId
} from './types.ts'
import { writeDeflatedZip, type ZipInput } from './zipWrite.ts'

export { PackError }

export const MANIFEST = 'manifest.json'
export const PACK_EXT = '.forgepack'
// A pack is memory, not a backup of the world: refuse absurd archives before inflating further.
const MAX_PACK_BYTES = 200 * 1024 * 1024
const MAX_ENTRIES = 20_000

export interface PackDeps {
  user: MemoryStore
  project: () => MemoryStore | null
  sections?: () => PackSection[]
  device: string
  app?: string
  now?: () => number
}

interface PackFile {
  rel: string // path inside the item (memory: "<name>.md"; skill: "SKILL.md", "ref.md"; extra: "entry.json")
  data: Buffer
}

interface PackItem extends PackItemInfo {
  payload: PackFile[]
}

const sectionLabel = (id: string, sections: PackSection[]): string =>
  id === 'user' ? 'User memory' : id === 'project' ? 'Project memory' : (sections.find((s) => s.id === id)?.label ?? id)

function sectionsOf(deps: PackDeps): PackSection[] {
  return (deps.sections ?? packSections)()
}

// ------------------------------------------------------------------ collecting (export side)

async function storeItems(section: 'user' | 'project', store: MemoryStore): Promise<PackItem[]> {
  store.invalidate()
  const out: PackItem[] = []
  for (const e of await store.list()) {
    const payload: PackFile[] = []
    if (e.kind === 'memory') {
      const data = await readMaybe(join(store.dir, `${e.name}.md`))
      if (data) payload.push({ rel: `${e.name}.md`, data })
    } else {
      for (const f of await walkFiles(join(store.dir, SKILLS_DIR, e.name))) {
        const data = await readMaybe(f.abs)
        if (data) payload.push({ rel: f.rel, data })
      }
    }
    if (!payload.length) continue
    out.push(itemOf(section, e.kind, e.name, e.description, e.updated ?? e.created, payload))
  }
  return out
}

async function extraItems(section: PackSection): Promise<PackItem[]> {
  const dir = section.dir()
  if (!dir) return []
  const files = await walkFiles(dir)
  const groups = new Map<string, { rel: string; abs: string; mtime: number }[]>()
  for (const f of files) {
    const [top, ...rest] = f.rel.split('/')
    const list = groups.get(top) ?? []
    list.push({ rel: rest.length ? rest.join('/') : top, abs: f.abs, mtime: f.mtime })
    groups.set(top, list)
  }
  const out: PackItem[] = []
  for (const [name, list] of groups) {
    const payload: PackFile[] = []
    let updated = 0
    for (const f of list) {
      const data = await readMaybe(f.abs)
      if (!data) continue
      payload.push({ rel: f.rel, data })
      updated = Math.max(updated, f.mtime)
    }
    // A folder entry is stored as <name>/<rel>; a single file entry as just <name>.
    const isFile = list.length === 1 && list[0].rel === name && !files.some((x) => x.rel.startsWith(`${name}/`))
    out.push(itemOf(section.id, 'extra', name, describeExtra(payload), updated, payload, isFile))
  }
  return out
}

// entry.json { name|title, description } when present, for a friendlier list.
function describeExtra(payload: PackFile[]): string {
  const meta = payload.find((p) => p.rel === 'entry.json')
  if (!meta) return ''
  try {
    const j = JSON.parse(meta.data.toString('utf8')) as Record<string, unknown>
    const title = typeof j.name === 'string' ? j.name : typeof j.title === 'string' ? j.title : ''
    const desc = typeof j.description === 'string' ? j.description : ''
    return [title, desc].filter(Boolean).join(' — ').slice(0, 200)
  } catch {
    return ''
  }
}

function itemOf(section: PackSectionId, kind: 'memory' | 'skill' | 'extra', name: string, description: string, updated: number, payload: PackFile[], singleFile = false): PackItem {
  const item: PackItem = {
    key: `${section}/${kind}/${name}`,
    section,
    kind,
    name,
    description,
    updated: Math.round(updated) || 0,
    files: payload.length,
    bytes: payload.reduce((n, p) => n + p.data.length, 0),
    payload
  }
  if (singleFile) (item as PackItem & { single?: boolean }).single = true
  return item
}

function zipPaths(item: PackItem): ZipInput[] {
  const single = (item as PackItem & { single?: boolean }).single
  return item.payload.map((p) => {
    if (item.kind === 'memory') return { name: `${item.section}/${p.rel}`, data: p.data }
    if (item.kind === 'skill') return { name: `${item.section}/${SKILLS_DIR}/${item.name}/${p.rel}`, data: p.data }
    return { name: single ? `extra/${item.section}/${item.name}` : `extra/${item.section}/${item.name}/${p.rel}`, data: p.data }
  })
}

// The secret scanner over an item's text files; the first problem found, or null.
function scanItem(item: { name: string; description: string; payload: PackFile[] }): string | null {
  const head = unsafeReason(`${item.name}\n${item.description}`)
  if (head) return head
  for (const p of item.payload) {
    if (!isText(p.data)) continue
    const r = unsafeReason(p.data.toString('utf8'))
    if (r) return `${p.rel}: ${r}`
  }
  return null
}

async function collect(deps: PackDeps, includeProject: boolean): Promise<PackItem[]> {
  const items = await storeItems('user', deps.user)
  const project = deps.project()
  if (includeProject && project) items.push(...(await storeItems('project', project)))
  for (const s of sectionsOf(deps)) items.push(...(await extraItems(s)))
  return items
}

const strip = (i: PackItem): PackItemInfo => ({ key: i.key, section: i.section, kind: i.kind, name: i.name, description: i.description, updated: i.updated, files: i.files, bytes: i.bytes })

export async function exportCandidates(deps: PackDeps): Promise<ExportCandidates> {
  const sections = sectionsOf(deps)
  const items = await collect(deps, true)
  const out: ExportCandidate[] = items.map((i) => {
    const blocked = scanItem(i)
    return { ...strip(i), ...(blocked ? { blocked } : {}) }
  })
  const ids: PackSectionId[] = ['user', ...(deps.project() ? ['project'] : []), ...sections.map((s) => s.id)]
  return { items: out, sections: ids.map((id) => ({ id, label: sectionLabel(id, sections) })), projectOpen: !!deps.project(), device: deps.device }
}

// Builds the pack for the chosen keys ('all' = every user item, skill and extra; project only when
// includeProject). Throws PackError when the scanner finds anything in the chosen items.
export async function buildPack(deps: PackDeps, opts: { keys?: string[] | 'all'; includeProject?: boolean } = {}): Promise<{ zip: Buffer; manifest: PackManifest }> {
  const keys = opts.keys ?? 'all'
  const wantProject = opts.includeProject === true || (Array.isArray(keys) && keys.some((k) => k.startsWith('project/')))
  let items = await collect(deps, wantProject)
  if (keys === 'all') items = items.filter((i) => i.section !== 'project' || opts.includeProject === true)
  else {
    const set = new Set(keys)
    items = items.filter((i) => set.has(i.key))
  }
  if (!items.length) throw new PackError('nothing selected to export')
  const files = items.flatMap(zipPaths)
  // Scanner, again, over exactly the bytes about to be written.
  const refused: string[] = []
  for (const item of items) {
    const r = scanItem(item)
    if (r) refused.push(`${item.key} (${r})`)
  }
  if (refused.length) throw new PackError(`export refused: ${refused.length === 1 ? 'an item looks' : `${refused.length} items look`} like it contains secrets or unsafe text: ${refused.join('; ')}. Deselect or edit it and try again.`)
  for (const f of files) {
    const name = safeRel(f.name)
    if (!name) throw new PackError(`refused unsafe path ${f.name}`)
  }
  const count = (section: string, kind: string) => items.filter((i) => i.section === section && i.kind === kind).length
  const extra: Record<string, number> = {}
  for (const i of items) if (i.kind === 'extra') extra[i.section] = (extra[i.section] ?? 0) + 1
  const manifest: PackManifest = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    created: (deps.now ?? Date.now)(),
    device: deps.device,
    ...(deps.app ? { app: deps.app } : {}),
    counts: { userMemories: count('user', 'memory'), userSkills: count('user', 'skill'), projectMemories: count('project', 'memory'), projectSkills: count('project', 'skill'), extra },
    items: items.map(strip)
  }
  const zip = writeDeflatedZip([{ name: MANIFEST, data: JSON.stringify(manifest, null, 2) }, ...files], manifest.created)
  return { zip, manifest }
}

// ------------------------------------------------------------------ reading (import side)

export interface ParsedPack {
  manifest: PackManifest
  items: PackItem[]
}

// Reads and validates a pack. Any unsafe path refuses the whole pack (zip-slip).
export function parsePack(buffer: Buffer): ParsedPack {
  if (buffer.length > MAX_PACK_BYTES) throw new PackError('pack is too large')
  let entries: ReturnType<typeof readZip>
  try {
    entries = readZip(buffer)
  } catch (e) {
    throw new PackError(`not a .forgepack file (${(e as Error).message})`)
  }
  if (entries.length > MAX_ENTRIES) throw new PackError('pack has too many files')
  for (const e of entries) {
    if (!safeRel(e.name)) throw new PackError(`refused pack: unsafe path "${e.name}" would escape the store folder`)
  }
  const files = entries.filter((e) => !e.directory)
  const man = files.find((e) => e.name === MANIFEST)
  if (!man) throw new PackError('not a .forgepack file (no manifest.json)')
  let manifest: PackManifest
  try {
    manifest = JSON.parse(man.data.toString('utf8')) as PackManifest
  } catch {
    throw new PackError('manifest.json is not valid JSON')
  }
  if (manifest?.format !== PACK_FORMAT) throw new PackError('not a .forgepack file (wrong format)')
  if (typeof manifest.version !== 'number' || manifest.version > PACK_VERSION) throw new PackError(`this pack is version ${manifest.version}; update Forge to import it`)
  const metaByKey = new Map((Array.isArray(manifest.items) ? manifest.items : []).map((i) => [i.key, i]))

  const groups = new Map<string, { section: string; kind: 'memory' | 'skill' | 'extra'; name: string; payload: PackFile[]; single?: boolean }>()
  const add = (section: string, kind: 'memory' | 'skill' | 'extra', name: string, rel: string, data: Buffer, single = false) => {
    const key = `${section}/${kind}/${name}`
    const g = groups.get(key) ?? { section, kind, name, payload: [], single }
    g.payload.push({ rel, data })
    groups.set(key, g)
  }
  for (const e of files) {
    if (e.name === MANIFEST) continue
    const segs = e.name.split('/')
    if ((segs[0] === 'user' || segs[0] === 'project') && segs.length === 2 && segs[1].endsWith('.md') && segs[1] !== 'MEMORY.md') {
      add(segs[0], 'memory', segs[1].slice(0, -3), segs[1], e.data)
    } else if ((segs[0] === 'user' || segs[0] === 'project') && segs[1] === SKILLS_DIR && segs.length >= 4) {
      add(segs[0], 'skill', segs[2], segs.slice(3).join('/'), e.data)
    } else if (segs[0] === 'extra' && segs.length === 3) {
      add(segs[1], 'extra', segs[2], segs[2], e.data, true)
    } else if (segs[0] === 'extra' && segs.length >= 4) {
      add(segs[1], 'extra', segs[2], segs.slice(3).join('/'), e.data)
    }
    // Anything else (MEMORY.md, unknown folders) is ignored.
  }

  const items: PackItem[] = []
  for (const [key, g] of groups) {
    let description = metaByKey.get(key)?.description ?? ''
    let updated = Number(metaByKey.get(key)?.updated) || 0
    if (g.kind !== 'extra') {
      const main = g.payload.find((p) => p.rel === (g.kind === 'memory' ? `${g.name}.md` : SKILL_FILE))
      if (!main) continue
      const { data } = parseFrontmatter(main.data.toString('utf8'))
      description = String(data.description ?? description)
      updated = updatedOf(main.rel, main.data, updated || Number(manifest.created) || 0)
    } else if (!description) description = describeExtra(g.payload)
    const item = itemOf(g.section, g.kind, g.name, description, updated, g.payload, g.single)
    items.push(item)
  }
  items.sort((a, b) => a.key.localeCompare(b.key))
  return { manifest, items }
}

// ------------------------------------------------------------------ preview + apply

interface Planned extends ImportPreviewItem {
  item: PackItem
  input?: { kind: MemoryKind; type?: MemoryType; name: string; description: string; body: string }
  store?: MemoryStore
  extraDir?: string
}

function freeName(base: string, taken: (n: string) => boolean, file = false): string {
  const dot = file ? base.lastIndexOf('.') : -1
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`
    const candidate = `${stem.slice(0, LIMITS.name - suffix.length)}${suffix}${ext}`
    if (!taken(candidate)) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}

function sameBody(a: string, b: string): boolean {
  return a.replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim()
}

async function plan(deps: PackDeps, parsed: ParsedPack): Promise<Planned[]> {
  const sections = sectionsOf(deps)
  const out: Planned[] = []
  const listings = new Map<MemoryStore, MemoryEntry[]>()
  const listOf = async (s: MemoryStore) => {
    if (!listings.has(s)) {
      s.invalidate()
      listings.set(s, await s.list())
    }
    return listings.get(s)!
  }
  for (const item of parsed.items) {
    const base: Planned = { ...strip(item), status: 'new', item }
    if (item.kind === 'extra') {
      const section = sections.find((s) => s.id === item.section)
      const dir = section?.dir() ?? null
      const single = (item as PackItem & { single?: boolean }).single === true
      if (!section || !dir) {
        out.push({ ...base, status: 'blocked', reason: `this device has no "${item.section}" library` })
        continue
      }
      const unsafe = scanItem(item)
      if (unsafe) {
        out.push({ ...base, status: 'blocked', reason: unsafe })
        continue
      }
      base.extraDir = dir
      const localFiles = single ? [] : await walkFiles(dir, item.name).catch(() => [])
      const localSingle = single ? await readMaybe(safeJoin(dir, item.name)) : null
      const exists = single ? !!localSingle : localFiles.length > 0
      if (exists) {
        let same: boolean
        if (single) same = !!localSingle && localSingle.equals(item.payload[0].data)
        else {
          same = localFiles.length === item.payload.length
          for (const p of item.payload) {
            if (!same) break
            const local = await readMaybe(safeJoin(dir, `${item.name}/${p.rel}`))
            same = !!local && local.equals(p.data)
          }
        }
        const updated = single ? 0 : Math.max(0, ...localFiles.map((f) => f.mtime))
        const taken = (n: string) => parsed.items.some((x) => x.section === item.section && x.name === n)
        const renameTo = freeName(item.name, (n) => taken(n) || existsSyncSafe(dir, n), single)
        out.push({ ...base, status: same ? 'same' : 'conflict', local: { name: item.name, updated }, ...(same ? {} : { renameTo }) })
      } else out.push(base)
      continue
    }

    const scope: MemoryScope = item.section === 'project' ? 'project' : 'user'
    const store = scope === 'user' ? deps.user : deps.project()
    if (!store) {
      out.push({ ...base, status: 'blocked', reason: 'open a project to import project memory' })
      continue
    }
    const main = item.payload.find((p) => p.rel === (item.kind === 'memory' ? `${item.name}.md` : SKILL_FILE))!
    const { data, body } = parseFrontmatter(main.data.toString('utf8'))
    const kind = item.kind as MemoryKind
    const name = slugify(item.name)
    const input = { kind, ...(kind === 'memory' && typeof data.type === 'string' ? { type: data.type as MemoryType } : {}), name, description: String(data.description ?? '').replace(/\s+/g, ' ').trim(), body }
    const unsafe = scanItem(item)
    if (unsafe || !name || !input.description || !body) {
      out.push({ ...base, status: 'blocked', reason: unsafe ?? 'missing name, description or body' })
      continue
    }
    const entries = (await listOf(store)).filter((e) => e.kind === kind)
    const local = entries.find((e) => e.name === name)
    const planned: Planned = { ...base, name, input, store }
    if (local) {
      if (sameBody(local.body, body) && local.description === input.description) out.push({ ...planned, status: 'same', local: { name: local.name, updated: local.updated ?? local.created } })
      else {
        const renameTo = freeName(name, (n) => entries.some((e) => e.name === n) || parsed.items.some((x) => x.section === item.section && x.kind === item.kind && x.name === n))
        out.push({ ...planned, status: 'conflict', local: { name: local.name, updated: local.updated ?? local.created, description: local.description }, renameTo })
      }
      continue
    }
    let best: { e: MemoryEntry; s: number } | null = null
    for (const e of entries) {
      const s = similarity({ name, description: input.description }, e)
      if (s >= DEDUPE_THRESHOLD && (!best || s > best.s)) best = { e, s }
    }
    if (best) out.push({ ...planned, status: 'similar', local: { name: best.e.name, updated: best.e.updated ?? best.e.created, description: best.e.description } })
    else out.push(planned)
  }
  return out
}

function existsSyncSafe(dir: string, name: string): boolean {
  try {
    return existsSync(safeJoin(dir, name))
  } catch {
    return false
  }
}

export async function previewPack(deps: PackDeps, parsed: ParsedPack, token: string, file: string): Promise<ImportPreview> {
  const planned = await plan(deps, parsed)
  const sections = sectionsOf(deps)
  const ids = [...new Set(parsed.items.map((i) => i.section))]
  return {
    token,
    file,
    manifest: parsed.manifest,
    items: planned.map(({ item: _i, input: _in, store: _s, extraDir: _d, ...rest }) => rest),
    sections: ids.map((id) => ({ id, label: sectionLabel(id, sections) }))
  }
}

// Default per status: new -> theirs, similar -> theirs (dedupe merges it), conflict -> mine.
export function defaultChoice(status: ImportPreviewItem['status']): ImportChoice {
  return status === 'new' || status === 'similar' ? 'theirs' : status === 'conflict' ? 'mine' : 'skip'
}

export async function applyImport(deps: PackDeps, parsed: ParsedPack, choices: Record<string, ImportChoice> = {}): Promise<ImportResult> {
  const planned = await plan(deps, parsed)
  const result: ImportResult = { added: 0, replaced: 0, renamed: 0, merged: 0, skipped: 0, errors: [] }
  for (const p of planned) {
    const choice = choices[p.key] ?? defaultChoice(p.status)
    if (p.status === 'blocked' || p.status === 'same' || choice === 'mine' || choice === 'skip') {
      result.skipped++
      continue
    }
    try {
      if (p.kind === 'extra') await applyExtra(p, choice, result)
      else await applyMemory(p, choice, result)
    } catch (e) {
      result.errors.push({ key: p.key, error: (e as Error).message })
    }
  }
  return result
}

async function applyMemory(p: Planned, choice: ImportChoice, result: ImportResult): Promise<void> {
  const store = p.store!
  const input = p.input!
  const scope = store.scope
  let name = input.name
  let dedupe = true
  if (p.status === 'conflict' && choice === 'theirs') dedupe = false
  else if (p.status === 'conflict' && choice === 'both') {
    name = p.renameTo!
    dedupe = false
  } else if (p.status === 'similar' && choice === 'both') dedupe = false
  const r = await store.save({ scope, ...input, name }, { dedupe })
  // Other files of a skill folder (references, scripts) go next to SKILL.md.
  if (input.kind === 'skill') {
    for (const f of p.item.payload) {
      if (f.rel === SKILL_FILE) continue
      const target = safeJoin(store.dir, `${SKILLS_DIR}/${r.entry.name}/${f.rel}`)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, f.data)
    }
  }
  if (r.action === 'merged') result.merged++
  else if (p.status === 'conflict' && choice === 'both') result.renamed++
  else if (p.status === 'conflict') result.replaced++
  else result.added++
}

async function applyExtra(p: Planned, choice: ImportChoice, result: ImportResult): Promise<void> {
  const dir = p.extraDir!
  const single = (p.item as PackItem & { single?: boolean }).single === true
  let name = p.item.name
  if (p.status === 'conflict' && choice === 'both') name = p.renameTo!
  else if (p.status === 'conflict' && choice === 'theirs') await rm(safeJoin(dir, name), { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  for (const f of p.item.payload) {
    const target = single ? safeJoin(dir, name) : safeJoin(dir, `${name}/${f.rel}`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, f.data)
  }
  if (p.status === 'conflict' && choice === 'both') result.renamed++
  else if (p.status === 'conflict') result.replaced++
  else result.added++
}
