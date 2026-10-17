// "Split into layers": a UI mockup concept -> the image layers worth keeping as images, proposed by
// the vision model (the Labs critic tier), edited by the person or agent, generated one by one on the
// Art page's image backend with the concept as the reference image (so style, palette and lighting
// match), saved to art/ui/<ConceptName>/layers/<Layer>.png with the manifest layers.json, and
// imported to Roblox as Open Cloud Image assets (ids recorded in the manifest). Text and buttons are
// rebuilt as real Roblox UI, never cut out. Pure parts live in shared/artLayers.ts.
// No electron imports; test/artLayers.test.ts drives it with fake backends.

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ArtItem, ArtLayer, ArtLayerManifest, ArtLayerProposal, ArtLayerSpec, ArtLayersEstimate, ArtLayersImportResult, ArtLayersInput } from '../../../shared/artTypes.ts'
import { CODEX_IMAGE_NOTE } from '../../../shared/artTypes.ts'
import {
  conceptLayerName,
  defaultLayerSpecs,
  LAYER_SYSTEM,
  layerName,
  layerPrompt,
  layerProposalPrompt,
  layersDir,
  layersManifestPath,
  LAYERS_FILE,
  normalizeLayerSpecs,
  parseLayerProposal,
  themeSnippet
} from '../../../shared/artLayers.ts'
import { keyOutBackground } from '../../../shared/thumbs/uiart.ts'
import { isOpaque } from '../../../shared/vfx/tex/image.ts'
import { decodePng, encodePng } from '../vfx/textures/png.ts'
import { mimeOf, pngSize } from './openaiImages.ts'
import { formatUsd, round } from './pricing.ts'
import { applyGitPolicy, dayOf, insideRoot, readItem, UI_DIR } from './store.ts'
import type { ArtService, ArtVision } from './service.ts'

export interface ArtLayerDeps {
  vision?: ArtVision
  // Downscale for the vision call (electron nativeImage); absent in tests.
  thumbnail?: (bytes: Buffer, width: number) => Promise<Buffer | null>
  now: () => number
  onProgress?: (p: { id: string; stage: string; detail?: string }) => void
  onChanged?: (root: string) => void
}

// Spend per local day, kept in the manifest so regenerated layers still count toward the budget.
type Manifest = ArtLayerManifest & { spend?: Record<string, number> }

const VISION_WIDTH = 1024

async function readManifestAt(abs: string): Promise<Manifest | null> {
  try {
    const m = JSON.parse(await readFile(abs, 'utf8')) as Manifest
    return m && Array.isArray(m.layers) && typeof m.name === 'string' ? m : null
  } catch {
    return null
  }
}

// Every layers.json under art/ui/<Name>/layers.
export async function listManifests(root: string): Promise<Manifest[]> {
  const base = join(root, ...UI_DIR.split('/'))
  const dirs = await readdir(base, { withFileTypes: true }).catch(() => [])
  const out: Manifest[] = []
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const m = await readManifestAt(join(base, d.name, 'layers', LAYERS_FILE))
    if (m) out.push(m)
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

// Image spend on layers for one local day (ArtService.spentToday adds it to the concepts').
export async function layersSpent(root: string, day: string): Promise<number> {
  return round((await listManifests(root)).reduce((s, m) => s + (m.spend?.[day] ?? 0), 0))
}

// A transparent layer that came back opaque (Codex, or a model that ignored it): key out the backdrop.
function ensureAlpha(bytes: Buffer): Buffer {
  if (mimeOf(bytes) !== 'image/png') return bytes
  try {
    const img = decodePng(bytes)
    if (!isOpaque(img)) return bytes
    const k = keyOutBackground(img)
    return k.keyed ? encodePng(k.img) : bytes
  } catch {
    return bytes
  }
}

const extOf = (bytes: Buffer) => {
  const m = mimeOf(bytes)
  return m === 'image/jpeg' ? 'jpg' : m === 'image/webp' ? 'webp' : 'png'
}

export class ArtLayerService {
  private art: ArtService
  private deps: ArtLayerDeps

  constructor(art: ArtService, deps: ArtLayerDeps) {
    this.art = art
    this.deps = deps
  }

  private async concept(root: string, rel: string): Promise<ArtItem> {
    const path = String(rel ?? '').trim()
    if (!path) throw new Error('Pick a concept to split')
    const item = await readItem(root, path)
    if (!item) throw new Error(`${path} does not exist`)
    if (!/\.(png|jpe?g|webp)$/i.test(item.path)) throw new Error(`${path} is not an image`)
    return item
  }

  private manifestAbs(root: string, name: string): string {
    return join(root, ...layersManifestPath(name).split('/'))
  }

  private async write(root: string, m: Manifest): Promise<void> {
    const abs = this.manifestAbs(root, m.name)
    await mkdir(dirname(abs), { recursive: true })
    const tmp = `${abs}.${randomUUID().slice(0, 6)}.tmp`
    await writeFile(tmp, JSON.stringify(m, null, 2) + '\n')
    await rename(tmp, abs)
  }

  // The manifest cut from a concept (by its path).
  private async forConcept(root: string, concept: string): Promise<Manifest | null> {
    return (await listManifests(root)).find((m) => m.concept === concept) ?? null
  }

  // A concept path ("art/concepts/...png") or a ConceptName.
  async get(conceptOrName: string): Promise<ArtLayerManifest | null> {
    const root = this.art.root()
    const q = String(conceptOrName ?? '').trim()
    if (!q) return null
    if (/[\\/]/.test(q)) {
      const rel = insideRoot(root, q)
      return rel ? this.forConcept(root, rel) : null
    }
    return readManifestAt(this.manifestAbs(root, layerName(q, 'Concept')))
  }

  async list(): Promise<ArtLayerManifest[]> {
    return listManifests(this.art.root())
  }

  // ------------------------------------------------------------ propose

  async propose(concept: string, opts: { hint?: string } = {}): Promise<ArtLayerProposal> {
    const root = this.art.root()
    const item = await this.concept(root, concept)
    const existing = await this.forConcept(root, item.path)
    const base = { concept: item.path, name: existing?.name ?? conceptLayerName(item.slug, item.index), ...(existing ? { existing } : {}) }
    const fallback = (note: string): ArtLayerProposal => ({ ...base, layers: defaultLayerSpecs(item), source: 'default', note })
    const vision = this.deps.vision
    if (!vision) return fallback('No vision model is set up (Settings > Providers, Settings > Labs), so this is a starter list. Edit it to match the concept.')
    const job = randomUUID().slice(0, 8)
    this.deps.onProgress?.({ id: job, stage: 'proposing layers', detail: item.path })
    let raw: string
    try {
      const bytes = await readFile(item.absPath)
      const small = (await this.deps.thumbnail?.(bytes, VISION_WIDTH).catch(() => null)) ?? bytes
      raw = await vision(LAYER_SYSTEM, layerProposalPrompt({ conceptPrompt: item.prompt, width: item.width, height: item.height, hint: opts.hint }), [{ mime: mimeOf(small) ?? 'image/png', base64: small.toString('base64') }])
    } catch (error) {
      this.deps.onProgress?.({ id: job, stage: 'done', detail: 'vision failed' })
      return fallback(`The vision model failed (${(error as Error).message}), so this is a starter list. Edit it to match the concept.`)
    }
    this.deps.onProgress?.({ id: job, stage: 'done', detail: 'layers proposed' })
    let layers = normalizeLayerSpecs(parseLayerProposal(raw), item)
    if (!layers.length) return fallback('The vision model gave no layer list, so this is a starter list. Edit it to match the concept.')
    // One background plate, first.
    const bg = layers.filter((l) => l.kind === 'background')
    if (!bg.length) layers = [...defaultLayerSpecs(item).filter((l) => l.kind === 'background' && !layers.some((x) => x.name === l.name)), ...layers]
    else layers = [bg[0], ...layers.filter((l) => l.kind !== 'background')]
    return { ...base, layers, source: 'vision' }
  }

  // ------------------------------------------------------------ estimate / generate

  private specs(input: ArtLayersInput, item: ArtItem): ArtLayerSpec[] {
    const specs = normalizeLayerSpecs(input.layers, item)
    if (!specs.length) throw new Error('Add at least one layer')
    return specs
  }

  async estimate(input: ArtLayersInput): Promise<ArtLayersEstimate> {
    const root = this.art.root()
    const item = await this.concept(root, input.concept)
    const specs = this.specs(input, item)
    const codex = this.art.usesCodex()
    const per = specs.map((s) => ({ name: s.name, ...this.art.estimateOne({ size: s.size ?? '1024x1024', quality: input.quality, references: 1 }) }))
    const totalUsd = round(per.reduce((s, p) => s + p.usd, 0))
    const spentTodayUsd = await this.art.spentToday()
    const dailyCapUsd = codex ? 0 : this.art.settings(root).dailyCapUsd
    return {
      layers: per.map((p) => ({ name: p.name, size: p.size, usd: p.usd })),
      totalUsd,
      spentTodayUsd,
      dailyCapUsd,
      model: per[0].model,
      quality: per[0].quality,
      overCap: dailyCapUsd > 0 && spentTodayUsd + totalUsd > dailyCapUsd,
      note: codex ? CODEX_IMAGE_NOTE : `${specs.length} edit${specs.length === 1 ? '' : 's'} with the concept as the reference. Estimate from OpenAI per-image token prices; actual billing can differ.`
    }
  }

  async generate(input: ArtLayersInput): Promise<ArtLayerManifest> {
    const root = this.art.root()
    const item = await this.concept(root, input.concept)
    const specs = this.specs(input, item)
    const existing = await this.forConcept(root, item.path)
    const name = layerName(input.name || existing?.name || conceptLayerName(item.slug, item.index), 'Concept')
    const prior = await readManifestAt(this.manifestAbs(root, name))
    if (prior && prior.concept !== item.path) throw new Error(`${layersDir(name)} already holds the layers of ${prior.concept}. Pick another name.`)
    const est = await this.estimate({ ...input, layers: specs })
    if (est.overCap) {
      throw new Error(`This would pass today's art budget (${formatUsd(est.spentTodayUsd)} spent + ${formatUsd(est.totalUsd)} > ${formatUsd(est.dailyCapUsd)}). Raise it on the Art page or drop some layers.`)
    }
    const now = () => new Date(this.deps.now()).toISOString()
    const m: Manifest = prior ?? { version: 1, name, concept: item.path, createdAt: now(), updatedAt: now(), layers: [] }
    const job = randomUUID().slice(0, 8)
    const done: string[] = []
    try {
      for (const [i, spec] of specs.entries()) {
        this.deps.onProgress?.({ id: job, stage: 'generating layers', detail: `${i + 1}/${specs.length} · ${spec.name}` })
        const r = await this.art.renderImage({ prompt: layerPrompt(spec), size: spec.size ?? '1024x1024', quality: input.quality, transparent: spec.transparent, referencePaths: [item.path] })
        const bytes = spec.transparent ? ensureAlpha(r.bytes) : r.bytes
        const file = `${layersDir(name)}/${spec.name}.${extOf(bytes)}`
        const abs = join(root, ...file.split('/'))
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, bytes)
        const px = pngSize(bytes)
        const layer: ArtLayer = { ...spec, file, size: px ? `${px.width}x${px.height}` : (spec.size ?? r.size), model: r.model, costUsd: r.costUsd, createdAt: now() }
        const at = m.layers.findIndex((l) => l.name === spec.name)
        if (at >= 0) m.layers[at] = layer
        else m.layers.push(layer)
        const day = dayOf(this.deps.now())
        m.spend = { ...(m.spend ?? {}), [day]: round((m.spend?.[day] ?? 0) + r.costUsd) }
        m.updatedAt = now()
        await this.write(root, m)
        done.push(spec.name)
      }
    } catch (error) {
      this.deps.onProgress?.({ id: job, stage: 'failed', detail: (error as Error).message })
      if (done.length) this.deps.onChanged?.(root)
      const kept = done.length ? ` (${done.length} of ${specs.length} layers saved: ${done.join(', ')})` : ''
      throw new Error(`Layer ${specs[done.length]?.name ?? ''} failed: ${(error as Error).message}${kept}`)
    }
    await applyGitPolicy(root, this.art.settings(root).gitPolicy).catch(() => undefined)
    this.deps.onProgress?.({ id: job, stage: 'done', detail: `${specs.length} layer${specs.length === 1 ? '' : 's'}` })
    this.deps.onChanged?.(root)
    return m
  }

  // ------------------------------------------------------------ import

  // Uploads each layer without an id (all with force) and records the ids in layers.json.
  async importAll(name: string, opts: { force?: boolean; only?: string[] } = {}): Promise<ArtLayersImportResult> {
    const root = this.art.root()
    const m = await readManifestAt(this.manifestAbs(root, layerName(name, 'Concept')))
    if (!m) throw new Error(`No layers for ${name}. Split the concept into layers first.`)
    const key = await this.art.requireRobloxKey()
    const s = this.art.settings(root)
    if (!s.creatorUserId && !s.creatorGroupId) throw new Error('Set the Roblox creator (your user ID or a group ID) under Roblox import on the Art page first.')
    const imported: string[] = []
    const failed: { name: string; error: string }[] = []
    const job = randomUUID().slice(0, 8)
    const todo = m.layers.filter((l) => (opts.force || !l.uri) && (!opts.only?.length || opts.only.includes(l.name)))
    for (const [i, l] of todo.entries()) {
      this.deps.onProgress?.({ id: job, stage: 'importing layers', detail: `${i + 1}/${todo.length} · ${l.name}` })
      try {
        const bytes = await readFile(join(root, ...l.file.split('/')))
        const r = await this.art.uploadBytes({ key, bytes, fileName: l.file.split('/').pop()!, name: `${m.name}${l.name}`, description: `${m.name} ${l.kind} layer: ${l.prompt}`, job })
        Object.assign(l, { assetId: r.assetId, uri: r.uri, uploadedAt: new Date(this.deps.now()).toISOString() }, r.moderation ? { moderation: r.moderation } : {})
        m.updatedAt = new Date(this.deps.now()).toISOString()
        await this.write(root, m)
        imported.push(l.name)
      } catch (error) {
        failed.push({ name: l.name, error: (error as Error).message })
        // Same cause for the rest (no creator, bad key): stop after the first two.
        if (failed.length >= 2 && !imported.length) break
      }
    }
    this.deps.onProgress?.({ id: job, stage: failed.length && !imported.length ? 'failed' : 'done', detail: `${imported.length} imported${failed.length ? `, ${failed.length} failed` : ''}` })
    this.deps.onChanged?.(root)
    return { manifest: m, imported, failed }
  }
}

// One manifest as agent-readable text: each layer with its file, size and id, then the theme table.
export function manifestText(m: ArtLayerManifest): string {
  const lines = [`${m.name}: ${m.layers.length} layer${m.layers.length === 1 ? '' : 's'} from ${m.concept} (${layersManifestPath(m.name)})`]
  for (const l of m.layers) lines.push(`- ${l.name} [${l.kind}${l.transparent ? ', transparent' : ''}] ${l.file} ${l.size} ${l.uri ?? 'not imported'}`)
  lines.push('', `Theme (Luau): ${themeSnippet(m)}`)
  return lines.join('\n')
}
