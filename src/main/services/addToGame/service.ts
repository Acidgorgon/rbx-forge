// "Add to game" service: places a lab item into the game repo through the lab's own exporter
// (adapters.ts), at the disk path Rojo maps the chosen folder to (Forge Sync's mapping), with a
// diff confirm before any existing file changes. Labs register an adapter; UI Motion / Thumbnail
// labs can register theirs later with registerAdapter. No electron imports.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { unifiedDiff } from '../../../shared/addToGame/diff.ts'
import { orderPlaces, pickSuggestion, suggestTargets } from '../../../shared/addToGame/suggest.ts'
import type { AddTargetOption, AddToGameFile, AddToGameOptions, AddToGamePlan, AddToGameRealm, AddToGameResult, AddToGameTarget } from '../../../shared/addToGame/types.ts'
import { fromDisk, fsProbe, insideMappedRoots, toDisk, type DiskProbe, type PlaceMap } from '../sync/mapping.ts'

export class AddToGameError extends Error {}

export interface AdapterFile {
  // Repo-relative, forward slashes.
  path: string
  content: string
  role: string
  // Overwrite an existing file only when this says yes (shared runtimes a person may have replaced).
  owned?: (current: string) => boolean
  // Only rewrite the file when it already exists.
  onlyIfExists?: boolean
}

export interface AdapterCtx {
  root: string
  place: PlaceMap
  // The chosen folder's instance path and its repo-relative directory.
  folder: string[]
  dir: string
  probe: DiskProbe
  // mapping.toDisk / fromDisk bound to this place.
  toDisk(instance: string[], className: string, hasChildren?: boolean): string | null
  fromDisk(file: string): string[] | null
  // Suggested folder for another lab in this place (the Ability Composer places missing VFX).
  suggestFolder(lab: string): AddToGameTarget | null
}

export interface AddToGameAdapter {
  lab: string
  label: string
  realm: AddToGameRealm
  // The folder created under a mapped root ("VFX", "Animations", "Abilities").
  folderName: string
  describe(id: string): Promise<{ name: string; currentFolder?: string | null; notes?: string[]; uploads?: { id: string; label: string }[] }>
  files(id: string, ctx: AdapterCtx): Promise<{ files: AdapterFile[]; warnings?: string[]; instance?: string[]; requirePath?: string | null; command?: string | null }>
  // After a successful write: the lab records where the item lives now.
  committed?(id: string, ctx: AdapterCtx, written: string[]): Promise<void>
}

export interface AddToGameDeps {
  root(): string | null
  loadPlaces(root: string): Promise<PlaceMap[]>
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
  probe?: (root: string) => DiskProbe
  log?: (text: string) => void
}

export const REMEMBER_SETTING = 'addToGame.last'
const MAX_DIFF_LINES = 300

export class AddToGameService {
  private deps: AddToGameDeps
  private adapters = new Map<string, AddToGameAdapter>()

  constructor(deps: AddToGameDeps) {
    this.deps = deps
  }

  registerAdapter(adapter: AddToGameAdapter): () => void {
    this.adapters.set(adapter.lab, adapter)
    return () => this.adapters.delete(adapter.lab)
  }

  labs(): string[] {
    return [...this.adapters.keys()]
  }

  private adapter(lab: string): AddToGameAdapter {
    const a = this.adapters.get(String(lab))
    if (!a) throw new AddToGameError(`No "Add to game" support for ${lab}.`)
    return a
  }

  private root(): string {
    const r = this.deps.root()
    if (!r) throw new AddToGameError('Open the game project first.')
    return r
  }

  private async places(root: string): Promise<PlaceMap[]> {
    const maps = await this.deps.loadPlaces(root)
    if (!maps.length) throw new AddToGameError('No *.project.json at the project root: nothing tells Rojo where files go.')
    const order = orderPlaces(maps.map((m) => ({ file: m.projectFile }))).map((p) => p.file)
    return [...maps].sort((a, b) => order.indexOf(a.projectFile) - order.indexOf(b.projectFile))
  }

  private probe(root: string): DiskProbe {
    return (this.deps.probe ?? fsProbe)(root)
  }

  private resolver(maps: PlaceMap[], probe: DiskProbe) {
    return (placeFile: string, instance: string[]): { dir: string; exists: boolean } | null => {
      const map = maps.find((m) => m.projectFile === placeFile)
      if (!map) return null
      const mf = toDisk(map, { path: instance, className: 'Folder' }, probe)
      if (!mf || mf.kind !== 'folder') return null
      return { dir: mf.file, exists: probe.isDir(mf.file) }
    }
  }

  private targets(adapter: { realm: AddToGameRealm; folderName: string }, maps: PlaceMap[], probe: DiskProbe): AddTargetOption[] {
    return suggestTargets(
      maps.map((m) => ({ projectFile: m.projectFile, name: m.name, roots: m.roots })),
      adapter.realm,
      adapter.folderName,
      this.resolver(maps, probe)
    )
  }

  private remembered(root: string, lab: string): AddToGameTarget | null {
    const all = this.deps.getSetting<Record<string, Record<string, AddToGameTarget>>>(REMEMBER_SETTING, {})
    const t = all?.[root]?.[lab]
    return t && typeof t.placeFile === 'string' && Array.isArray(t.instance) ? t : null
  }

  private remember(root: string, lab: string, target: AddToGameTarget): void {
    const all = { ...this.deps.getSetting<Record<string, Record<string, AddToGameTarget>>>(REMEMBER_SETTING, {}) }
    all[root] = { ...(all[root] ?? {}), [lab]: { placeFile: target.placeFile, instance: [...target.instance] } }
    this.deps.setSetting(REMEMBER_SETTING, all)
  }

  async options(lab: string, id: string): Promise<AddToGameOptions> {
    const adapter = this.adapter(lab)
    const root = this.root()
    const maps = await this.places(root)
    const probe = this.probe(root)
    const info = await adapter.describe(String(id))
    let targets = this.targets(adapter, maps, probe)
    // Where the item lives now is offered first (re-adding updates it in place).
    if (info.currentFolder) {
      for (const map of maps) {
        const inst = fromDisk(map, `${info.currentFolder}/init.luau`)
        if (!inst) continue
        const key = `${map.projectFile}|${inst.join('/')}`
        targets = targets.filter((t) => `${t.placeFile}|${t.instance.join('/')}` !== key)
        for (const t of targets) if (t.placeFile === map.projectFile) t.recommended = false
        targets.unshift({ placeFile: map.projectFile, instance: inst, dir: info.currentFolder, exists: true, label: inst.join('.'), recommended: true, reason: 'where it is now' })
      }
    }
    const order = maps.map((m) => m.projectFile)
    const pick = pickSuggestion(targets, this.remembered(root, adapter.lab), order)
    return {
      lab: adapter.lab,
      id: String(id),
      name: info.name,
      realm: adapter.realm,
      places: maps.map((m) => ({ file: m.projectFile, name: m.name, isDefault: m.projectFile === 'default.project.json' })),
      targets,
      suggested: pick.target,
      remembered: pick.remembered,
      notes: info.notes ?? [],
      ...(info.uploads?.length ? { uploads: info.uploads } : {})
    }
  }

  private ctxFor(root: string, maps: PlaceMap[], probe: DiskProbe, target: AddToGameTarget): AdapterCtx {
    const map = maps.find((m) => m.projectFile === target.placeFile)
    if (!map) throw new AddToGameError(`${target.placeFile} is not a place in this project.`)
    const folder = this.resolver(maps, probe)(target.placeFile, target.instance)
    if (!folder) throw new AddToGameError(`${target.instance.join('.')} is not a folder Rojo maps to disk in ${target.placeFile}.`)
    return {
      root,
      place: map,
      folder: [...target.instance],
      dir: folder.dir,
      probe,
      toDisk: (instance, className, hasChildren) => toDisk(map, { path: instance, className, hasChildren }, probe)?.file ?? null,
      fromDisk: (file) => fromDisk(map, file),
      suggestFolder: (lab) => {
        const a = this.adapters.get(lab)
        if (!a) return null
        const remembered = this.remembered(root, lab)
        const t = this.targets(a, [map], probe)
        return pickSuggestion(t, remembered && remembered.placeFile === map.projectFile ? remembered : null, [map.projectFile]).target
      }
    }
  }

  private async build(lab: string, id: string, target: AddToGameTarget): Promise<{ plan: AddToGamePlan; adapter: AddToGameAdapter; ctx: AdapterCtx; contents: Map<string, string>; command: string | null }> {
    const adapter = this.adapter(lab)
    const root = this.root()
    const maps = await this.places(root)
    const probe = this.probe(root)
    const clean: AddToGameTarget = { placeFile: String(target?.placeFile ?? ''), instance: Array.isArray(target?.instance) ? target.instance.map(String) : [] }
    const ctx = this.ctxFor(root, maps, probe, clean)
    const out = await adapter.files(String(id), ctx)
    const warnings = [...(out.warnings ?? [])]
    const files: AddToGameFile[] = []
    const contents = new Map<string, string>()
    for (const f of out.files) {
      const abs = resolve(root, f.path)
      if (!abs.startsWith(resolve(root) + sep)) throw new AddToGameError(`${f.path} is outside the project`)
      const cur = await readFile(abs, 'utf8').catch(() => null)
      if (f.onlyIfExists && cur === null) continue
      if (!insideMappedRoots(ctx.place, f.path)) warnings.push(`${f.path} is not under a folder ${ctx.place.projectFile} maps, so Rojo will not sync it`)
      const bytes = Buffer.byteLength(f.content, 'utf8')
      if (cur === null) files.push({ path: f.path, role: f.role, status: 'new', bytes })
      else if (cur === f.content) files.push({ path: f.path, role: f.role, status: 'same', bytes })
      else if (f.owned && !f.owned(cur)) files.push({ path: f.path, role: f.role, status: 'kept', bytes, note: 'edited by hand; left as is' })
      else files.push({ path: f.path, role: f.role, status: 'changed', bytes, diff: unifiedDiff(f.path, cur, f.content, { maxLines: MAX_DIFF_LINES }) })
      contents.set(f.path, f.content)
    }
    const plan: AddToGamePlan = {
      lab: adapter.lab,
      id: String(id),
      target: clean,
      dir: ctx.dir,
      instance: out.instance ?? clean.instance,
      files,
      warnings,
      requirePath: out.requirePath ?? null
    }
    return { plan, adapter, ctx, contents, command: out.command ?? null }
  }

  async preview(lab: string, id: string, target: AddToGameTarget): Promise<AddToGamePlan> {
    return (await this.build(lab, id, target)).plan
  }

  // Writes 'new' files and the 'changed' files in `confirmed`; never touches anything else.
  async apply(lab: string, id: string, target: AddToGameTarget, confirmed: string[] = []): Promise<AddToGameResult> {
    const { plan, adapter, ctx, contents, command } = await this.build(lab, id, target)
    const ok = new Set((Array.isArray(confirmed) ? confirmed : []).map(String))
    const written: string[] = []
    const skipped: string[] = []
    let declined = false
    for (const f of plan.files) {
      if (f.status === 'same') continue
      if (f.status === 'kept' || (f.status === 'changed' && !ok.has(f.path))) {
        if (f.status === 'changed') declined = true
        skipped.push(f.path)
        continue
      }
      const abs = join(ctx.root, ...f.path.split('/'))
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, contents.get(f.path)!, 'utf8')
      written.push(f.path)
    }
    // The lab records the new location only when every changed file was confirmed.
    if (!declined) await adapter.committed?.(plan.id, ctx, written)
    this.remember(ctx.root, adapter.lab, plan.target)
    this.deps.log?.(`add to game (${adapter.lab} ${plan.id}): wrote ${written.length}, skipped ${skipped.length} in ${plan.dir}`)
    return { written, skipped, requirePath: plan.requirePath, command }
  }
}
