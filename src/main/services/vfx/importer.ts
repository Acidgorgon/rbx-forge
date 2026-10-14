// Bulk VFX import with a review step: files dropped on the VFX Lab, or the current Roblox Studio
// selection (or a VFX folder picked in Studio) read through a read-only Forge Bridge job
// (shared/vfx/studioImport.ts). scan -> rows (names, layer counts, "already in library") -> commit.
// Studio nodes go through the same normalisation as Lune's .rbxm output (normalizeLuneNode), the
// same split (shared/vfx/split.ts) and the same entry builder (VfxService.addEffect); after a Studio
// import the meshes the effects use are read for the preview. No electron imports.

import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { allNodes, effectFromNodes, effectStats } from '../../../shared/vfx/analyze.ts'
import { effectHash } from '../../../shared/vfx/fingerprint.ts'
import { meshAssetId } from '../../../shared/vfx/mesh/data.ts'
import { writeRbxmx } from '../../../shared/vfx/rbxmx.ts'
import { PART_CLASSES } from '../../../shared/vfx/schema.ts'
import { dedupeNames, splitEffects, type EffectGroup } from '../../../shared/vfx/split.ts'
import { collectStudioImport, parseSelChunk, parseSelProgress, studioImportJob, type StudioPath } from '../../../shared/vfx/studioImport.ts'
import type { VfxEntry, VfxImportCommit, VfxImportProgress, VfxImportResult, VfxImportRow, VfxImportScan, VfxNode, VfxScope } from '../../../shared/vfx/types.ts'
import { normalizeLuneNode } from './lune.ts'
import type { MeshBridge } from './meshes.ts'
import { VfxError, type VfxService } from './service.ts'

const SCAN_TTL_MS = 30 * 60_000
const MAX_SCANS = 4
const KEEP_FILE_BYTES = 20 * 1024 * 1024
const MESH_BATCH = 40

interface ScanRow {
  row: VfxImportRow
  group: EffectGroup
  // The model file kept with the entry (re-import): the dropped file, or the Studio nodes as .rbxmx.
  file: { name: string; bytes: Buffer | string } | null
  tagHint: string
}

interface StoredScan {
  at: number
  scan: VfxImportScan
  rows: Map<string, ScanRow>
  mediaPaths: string[]
}

export interface ImporterDeps {
  service: VfxService
  bridge?: () => MeshBridge | undefined
  // Mesh files for the preview after a Studio import (MeshService.load).
  loadMeshes?: (refs: string[]) => Promise<{ results: { state: string }[] }>
  emit?: (event: 'vfx:import', payload: VfxImportProgress) => void
  now?: () => number
}

function rowStats(effectNodes: VfxNode[], effect: ReturnType<typeof effectFromNodes>): VfxImportRow['stats'] {
  const s = effectStats(effect)
  return { emitters: s.emitters, beams: s.beams, trails: s.trails, lights: s.lights, meshes: s.meshes, scripts: s.scripts, parts: allNodes(effectNodes).filter((n) => PART_CLASSES.has(n.className)).length }
}

export class VfxImporter {
  private deps: ImporterDeps
  private scans = new Map<string, StoredScan>()
  private now: () => number

  constructor(deps: ImporterDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  private progress(p: VfxImportProgress): void {
    this.deps.emit?.('vfx:import', p)
  }

  studioConnected(): boolean {
    const b = this.deps.bridge?.()
    return !!(b?.listening && b.connected())
  }

  // Groups -> review rows, with duplicates against both libraries and within the scan.
  private async rows(entries: { group: EffectGroup; origin: string; source: 'file' | 'studio'; file: ScanRow['file']; tagHint: string }[]): Promise<Map<string, ScanRow>> {
    const svc = this.deps.service
    const index = new Map<string, VfxEntry[]>()
    for (const e of await svc.list()) {
      const h = svc.entryHash(e)
      if (h) index.set(h, [...(index.get(h) ?? []), e])
    }
    const out = new Map<string, ScanRow>()
    const first = new Map<string, string>()
    let k = 0
    for (const x of entries) {
      const effect = effectFromNodes(x.group.name, x.group.nodes)
      const hash = effectHash(effect)
      const key = `r${k++}`
      const notes: string[] = []
      const stats = rowStats(x.group.nodes, effect)
      if (stats.scripts) notes.push('script cues read')
      if (stats.meshes) notes.push(`${stats.meshes} mesh${stats.meshes === 1 ? '' : 'es'}`)
      const row: VfxImportRow = {
        key,
        name: x.group.name,
        origin: x.origin,
        source: x.source,
        stats,
        notes,
        hash,
        duplicates: (index.get(hash) ?? []).map((e) => ({ scope: e.scope, id: e.id, name: e.name })),
        ...(first.has(hash) ? { sameAs: first.get(hash) } : {})
      }
      if (!first.has(hash)) first.set(hash, key)
      out.set(key, { row, group: x.group, file: x.file, tagHint: x.tagHint })
    }
    return out
  }

  private store(scan: VfxImportScan, rows: Map<string, ScanRow>, mediaPaths: string[]): VfxImportScan {
    const now = this.now()
    for (const [id, s] of this.scans) if (now - s.at > SCAN_TTL_MS) this.scans.delete(id)
    while (this.scans.size >= MAX_SCANS) this.scans.delete(this.scans.keys().next().value!)
    this.scans.set(scan.scanId, { at: now, scan, rows, mediaPaths })
    return scan
  }

  // ------------------------------------------------------------ files

  async scanFiles(paths: string[]): Promise<VfxImportScan> {
    const svc = this.deps.service
    const scanId = `scan-${randomBytes(5).toString('hex')}`
    const files = await svc.expand(paths)
    const models = files.filter((f) => /\.(rbxm|rbxmx|rbxl|rbxlx)$/i.test(f))
    const media = files.filter((f) => !models.includes(f))
    this.progress({ scanId, phase: 'reading', done: 0, total: models.length })
    const extracted = await svc.extractModels(models)
    const skipped: VfxImportScan['skipped'] = []
    const notes: string[] = []
    const items: Parameters<VfxImporter['rows']>[0] = []
    for (const f of models) {
      const r = extracted.get(f)
      if (!r?.roots) {
        skipped.push({ file: f, reason: r?.error ?? 'unreadable' })
        continue
      }
      const groups = r.place ? splitEffects(r.roots, { packs: true }) : splitEffects(r.roots)
      if (!groups.length) {
        skipped.push({ file: f, reason: r.place ? 'no VFX folder found (a Folder with 3+ effects in Workspace, ReplicatedStorage or ServerStorage)' : 'no ParticleEmitter, Beam, Trail, light or visible part found' })
        continue
      }
      if (r.place && r.packs?.length) notes.push(`${basename(f)}: VFX folders read: ${r.packs.slice(0, 6).join(', ')}${r.packs.length > 6 ? ` and ${r.packs.length - 6} more` : ''}`)
      const bytes = r.place ? null : await readFile(f)
      const file = bytes && bytes.length < KEEP_FILE_BYTES ? { name: basename(f), bytes } : null
      for (const g of groups) items.push({ group: { ...g, name: groups.length > 1 || r.place ? g.name : basename(f, extname(f)) }, origin: basename(f), source: 'file', file, tagHint: basename(f) })
    }
    const named = dedupeNames(items.map((i) => i.group))
    named.forEach((g, i) => (items[i].group = g))
    const rows = await this.rows(items)
    this.progress({ scanId, phase: 'done', done: models.length, total: models.length })
    return this.store({ scanId, source: 'files', rows: [...rows.values()].map((r) => r.row), media: media.map((m) => basename(m)), skipped, notes }, rows, media)
  }

  // ------------------------------------------------------------ Studio

  // The current Studio selection; with nothing selected, the folders that look like VFX packs
  // (scan.packs, no rows). `packs` reads those folders instead.
  async scanStudio(opts: { packs?: StudioPath[] } = {}): Promise<VfxImportScan> {
    const b = this.deps.bridge?.()
    if (!b?.listening || !b.connected()) throw new VfxError('Roblox Studio is not connected. Open the place in Studio with the Forge Bridge plugin on (Studio tab), then try again.')
    const scanId = `scan-${randomBytes(5).toString('hex')}`
    const jobId = `job-vfxsel-${randomBytes(5).toString('hex')}`
    const messages: string[] = []
    this.progress({ scanId, phase: 'reading', done: 0, total: 0, label: opts.packs?.length ? 'reading the folders' : 'reading the selection' })
    try {
      await b.run(
        studioImportJob({ id: jobId, port: b.port, paths: opts.packs }),
        (ev) => {
          if (ev.type === 'log' && typeof ev.message === 'string') {
            messages.push(ev.message)
            const p = parseSelProgress(ev.message)
            if (p) this.progress({ scanId, phase: 'reading', done: p.done, total: p.total, label: p.label })
            const c = parseSelChunk(ev.message)
            if (c && c.total > 1) this.progress({ scanId, phase: 'receiving', done: c.index, total: c.total })
          }
          return {}
        },
        { acceptTimeoutMs: 12_000, timeoutMs: 600_000 }
      )
    } catch (e) {
      if (!collectStudioImport(messages)) throw new VfxError(`Studio could not read the selection: ${(e as Error).message}`)
    }
    const payload = collectStudioImport(messages)
    if (!payload) throw new VfxError('Studio ran the read but the data did not arrive (the plugin may lack HTTP permission for its own module, or the selection is too large).')
    if (payload.kind === 'error') throw new VfxError(`Studio: ${payload.error}`)
    if (payload.kind === 'packs') {
      this.progress({ scanId, phase: 'done', done: 0, total: 0 })
      const notes = payload.packs.length ? ['Nothing is selected in Studio: pick the VFX folders to import (or select the effects in Studio and try again).'] : ['Nothing is selected in Studio and no VFX folder was found (a Folder with 3+ effects in Workspace, ReplicatedStorage or ServerStorage). Select the effects in Studio and try again.']
      return this.store({ scanId, source: 'studio', rows: [], packs: payload.packs, media: [], skipped: [], notes }, new Map(), [])
    }
    const roots = payload.roots.map(normalizeLuneNode)
    const notes: string[] = []
    if (payload.truncated) notes.push(`Studio sent the first ${payload.count} instances only (the selection is very large).`)
    // Each chosen folder is a pack (its children are the effects); a selection is split as usual.
    const groups = opts.packs?.length ? splitEffects(roots, { packs: true }) : splitEffects(roots)
    const pathOf = new Map<VfxNode, string>()
    roots.forEach((r, i) => pathOf.set(r, payload.paths[i] ?? r.name))
    const origin = (g: EffectGroup) => {
      const top = roots.find((r) => g.nodes[0] === r || allNodes([r]).includes(g.nodes[0]))
      const base = top ? pathOf.get(top)! : 'Studio'
      return top && top !== g.nodes[0] ? `${base}.${g.nodes[0].name}` : base
    }
    const items = groups.map((g) => ({ group: g, origin: origin(g), source: 'studio' as const, file: { name: `${g.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'effect'}.rbxmx`, bytes: writeRbxmx(g.nodes) }, tagHint: origin(g) }))
    const rows = await this.rows(items)
    if (!rows.size) notes.push('No ParticleEmitter, Beam, Trail, light or visible part in what is selected.')
    this.progress({ scanId, phase: 'done', done: rows.size, total: rows.size })
    return this.store({ scanId, source: 'studio', rows: [...rows.values()].map((r) => r.row), media: [], skipped: [], notes }, rows, [])
  }

  // ------------------------------------------------------------ commit

  async commit(input: VfxImportCommit): Promise<VfxImportResult> {
    const s = this.scans.get(String(input?.scanId ?? ''))
    if (!s) throw new VfxError('This import review expired; scan again.')
    const svc = this.deps.service
    const scope: VfxScope = input.scope === 'project' ? 'project' : 'user'
    const store = svc.store(scope)
    const result: VfxImportResult = { added: [], skipped: [...s.scan.skipped] }
    const chosen = (Array.isArray(input.rows) ? input.rows : []).filter((r) => s.rows.has(String(r?.key)))
    const total = chosen.length
    let done = 0
    for (const pick of chosen) {
      const r = s.rows.get(String(pick.key))!
      const name = String(pick.name ?? '').trim().slice(0, 80) || r.row.name
      const { entry, notes } = await svc.addEffect(store, { name, nodes: r.group.nodes }, { origin: r.row.origin, tagHint: r.tagHint, file: r.file })
      if (notes.length) (result.notes ??= []).push({ file: r.row.origin, notes })
      result.added.push(entry)
      done++
      this.progress({ scanId: s.scan.scanId, phase: 'importing', done, total, label: name })
    }
    if (input.media !== false && s.mediaPaths.length) {
      const media = await svc.import(s.mediaPaths, scope, { force: true })
      result.added.push(...media.added)
      result.skipped.push(...media.skipped)
    }
    this.scans.delete(s.scan.scanId)
    svc.notifyChanged()
    // Studio imports: read the meshes now (Studio is connected), so the previews draw them.
    if (s.scan.source === 'studio' && this.deps.loadMeshes) {
      const refs = [...new Set(result.added.flatMap((e) => (e.effect ? allNodes(e.effect.roots) : [])).map((n) => meshAssetId(n.props.MeshId)).filter((x): x is string => !!x))]
      if (refs.length) {
        let loaded = 0
        let failed = 0
        for (let i = 0; i < refs.length; i += MESH_BATCH) {
          this.progress({ scanId: s.scan.scanId, phase: 'meshes', done: i, total: refs.length })
          const r = await this.deps.loadMeshes(refs.slice(i, i + MESH_BATCH)).catch(() => null)
          for (const x of r?.results ?? []) x.state === 'failed' ? failed++ : loaded++
        }
        result.meshes = { total: refs.length, loaded, failed }
      }
    }
    this.progress({ scanId: s.scan.scanId, phase: 'done', done: total, total })
    return result
  }
}
