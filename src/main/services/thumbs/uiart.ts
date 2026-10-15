// UI art in the Thumbnail Lab (main process): buttons, panels, icons, icon sets and HUD mockups made
// through the same image backend, key and budget as thumbnails (OpenAI Images API or the ChatGPT plan
// through the official Codex CLI). Pick-from-N with one cheap vision call that ranks every candidate
// against the brief (code checks when there is no model), transparent PNGs (keyed out in code when
// the model ignored it), 9-slice SliceCenter for buttons and panels, icon sets anchored on the best
// first icon, a style kit learned from kept / +1 assets that later prompts carry (palette, look and
// the pinned / kept images as edit references), export into the project and Open Cloud upload.
// No electron imports: ThumbService hands in everything through UiArtHost (test/thumbsUiArt.test.ts
// drives it with fake backends).

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { editImages, generateImages, toDataUrl, type ArtFetch, type Sleep } from '../art/openaiImages.ts'
import { estimateImageUsd, formatUsd, REFERENCE_IMAGE_USD, round } from '../art/pricing.ts'
import { uploadImageAsset } from '../art/robloxAssets.ts'
import { slugify } from '../art/styles.ts'
import { decodePng, encodePng } from '../vfx/textures/png.ts'
import { isOpaque, type Rgba } from '../../../shared/vfx/tex/image.ts'
import { buildSections, isUiKind, normalizeSections, splitNames, uiGenSize, uiPrompt, UI_KINDS, MAX_SET_ICONS } from '../../../shared/thumbs/builder.ts'
import { toThumbnail } from '../../../shared/thumbs/stats.ts'
import {
  blendCritique,
  codeCritique,
  contentFill,
  fitAlpha,
  keyOutBackground,
  learnUiKit,
  onGrey,
  parseUiRanking,
  pickBestUi,
  scaleSlice,
  sliceCenter,
  squareIcon,
  trimToContent,
  uiAssetStats,
  uiChecks,
  uiLuau,
  uiRankPrompt,
  UI_RANK_SYSTEM
} from '../../../shared/thumbs/uiart.ts'
import { CODEX_IMAGE_MODEL } from '../../../shared/artTypes.ts'
import type { PromptSection, ThumbEstimate, ThumbScope, ThumbSettings, UiAsset, UiAssetKind, UiBatchResult, UiGenerateInput, UiKit } from '../../../shared/thumbs/types.ts'
import type { CodexImages } from '../art/imageBackend.ts'
import { ThumbError, type ThumbStore } from './store.ts'
import type { ImagePayload, ThumbMemory, ThumbTier, VisionFn } from './service.ts'

export interface UiArtHost {
  stores(): ThumbStore[]
  storeFor(scope?: ThumbScope): ThumbStore
  decode(bytes: Buffer): Promise<Rgba>
  settings(): ThumbSettings
  codex(): CodexImages | null
  openAiKey(): Promise<string | null>
  cap(): number
  spentToday(): Promise<number>
  vision(tier: ThumbTier): VisionFn | null
  gameName(): string | undefined
  projectRoot(): string | null
  robloxKey(): Promise<string | null>
  creator(): { userId?: number; groupId?: number }
  chargeImage?: (usd: number) => void
  memory?: ThumbMemory
  fetch?: ArtFetch
  sleep?: Sleep
  now(): number
  changed(): void
  progress(batchId: string, stage: string, detail?: string, extra?: { done?: boolean; error?: boolean }): void
  log(text: string, stream?: 'info' | 'stderr'): void
}

const QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max', 'auto']
// Kit references attached to every UI call (edits take up to 16 images; Codex up to 5).
const MAX_KIT_REFS = 2
export const AGENT_MAX_UI = 4
export const NO_BACKEND =
  'No image backend: add an OpenAI API key on the Art page (Settings > Providers > OpenAI), or choose "ChatGPT plan (Codex)" as the image backend on the Art page and sign in through the Codex CLI.'

export class UiArtService {
  private h: UiArtHost

  constructor(host: UiArtHost) {
    this.h = host
  }

  // ------------------------------------------------------------ library

  async list(): Promise<UiAsset[]> {
    const out: UiAsset[] = []
    for (const s of this.h.stores()) out.push(...(await s.list<UiAsset>('ui')))
    return out.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  }

  private async find(id: string): Promise<{ item: UiAsset; store: ThumbStore } | null> {
    for (const s of this.h.stores()) {
      const item = await s.read<UiAsset>('ui', id).catch(() => null)
      if (item) return { item, store: s }
    }
    return null
  }

  private async must(id: string): Promise<{ item: UiAsset; store: ThumbStore }> {
    const hit = await this.find(String(id ?? ''))
    if (!hit) throw new ThumbError(`no UI asset "${id}"`)
    return hit
  }

  async kit(kind?: UiAssetKind): Promise<UiKit> {
    return learnUiKit(await this.list(), { kind })
  }

  // ------------------------------------------------------------ requests

  private request(input: UiGenerateInput) {
    const s = this.h.settings()
    const kind: UiAssetKind = isUiKind(input.kind) ? input.kind : 'button'
    const quality = input.quality && QUALITIES.includes(input.quality) ? input.quality : s.quality
    const max = input.source === 'agent' ? AGENT_MAX_UI : 10
    const codexMax = this.h.codex() ? 4 : max
    const n = Math.max(1, Math.min(max, codexMax, Math.floor(Number(input.n) || UI_KINDS[kind].n)))
    const names = kind === 'icon-set' ? (input.names?.length ? input.names.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : splitNames(input.ask)).slice(0, MAX_SET_ICONS) : []
    const shape = input.shape === 'wide' || input.shape === 'tall' ? input.shape : 'square'
    return { kind, model: s.model, quality, n, names, shape, genSize: uiGenSize(kind, s.model, shape), transparent: UI_KINDS[kind].transparent }
  }

  sections(input: { ask: string; kind: UiAssetKind; names?: string[]; shape?: 'square' | 'wide' | 'tall'; kit?: UiKit | null }): { sections: PromptSection[]; names: string[]; size: string } {
    const q = this.request({ ask: input.ask, kind: input.kind, names: input.names, shape: input.shape })
    return { sections: buildSections({ ask: input.ask, mode: q.kind, gameName: this.h.gameName(), kit: input.kit, names: q.names, size: q.genSize }), names: q.names, size: q.genSize }
  }

  async estimate(input: UiGenerateInput): Promise<ThumbEstimate> {
    const q = this.request(input)
    const spent = await this.h.spentToday()
    if (this.h.codex()) return { n: q.n + Math.max(0, q.names.length - 1), model: CODEX_IMAGE_MODEL, quality: 'auto', genSize: 'auto', perImageUsd: 0, totalUsd: 0, spentTodayUsd: spent, dailyCapUsd: 0, overCap: false }
    const per = estimateImageUsd(q.model, q.quality, q.genSize)
    const kit = input.useKit === false ? null : await this.kit(q.kind)
    const refs = Math.min(MAX_KIT_REFS, kit?.refIds.length ?? 0)
    const rest = Math.max(0, q.names.length - 1)
    const images = q.n + rest
    const totalUsd = round(per * images + refs * REFERENCE_IMAGE_USD * (1 + rest) + rest * REFERENCE_IMAGE_USD)
    const cap = this.h.cap()
    return { n: images, model: q.model, quality: q.quality, genSize: q.genSize, perImageUsd: per, totalUsd, spentTodayUsd: spent, dailyCapUsd: cap, overCap: cap > 0 && spent + totalUsd > cap }
  }

  // One image call on the chosen backend.
  private async images(q: ReturnType<UiArtService['request']>, prompt: string, n: number, refs: string[]): Promise<{ images: Buffer[]; notes: string[] }> {
    const codex = this.h.codex()
    if (codex) return codex.generate({ prompt, n, size: q.genSize, transparent: q.transparent, references: refs })
    const key = await this.h.openAiKey()
    if (!key) throw new ThumbError(NO_BACKEND)
    const req = { model: q.model, prompt, n, size: q.genSize, quality: q.quality, background: q.transparent ? ('transparent' as const) : ('auto' as const), outputFormat: 'png' as const }
    const client = { apiKey: key, fetch: this.h.fetch, sleep: this.h.sleep }
    const res = refs.length ? await editImages({ ...req, images: refs.slice(0, 16) }, client) : await generateImages(req, client)
    return { images: res.images, notes: [] }
  }

  private async refData(id: string): Promise<string | null> {
    const hit = await this.find(id)
    if (!hit) return null
    const bytes = await hit.store.readFile('ui', id, hit.item.file).catch(() => null)
    if (!bytes) return null
    const img = decodePng(bytes)
    return toDataUrl(img.width > 1024 || img.height > 1024 ? encodePng(fitAlpha(img, 1024)) : bytes)
  }

  // Generated bytes -> the asset image (keyed, trimmed / squared) and what happened to the background.
  private async process(bytes: Buffer, kind: UiAssetKind): Promise<{ img: Rgba; background: 'transparent' | 'keyed' | 'opaque'; fill: number }> {
    const raw = await this.h.decode(bytes)
    if (!UI_KINDS[kind].transparent) return { img: toThumbnail(raw), background: 'opaque', fill: 1 }
    let img = raw
    let background: 'transparent' | 'keyed' | 'opaque' = 'transparent'
    if (isOpaque(raw)) {
      const k = keyOutBackground(raw)
      if (k.keyed) (img = k.img), (background = 'keyed')
      else background = 'opaque'
    }
    const fill = background === 'opaque' ? 1 : contentFill(img)
    if (background === 'opaque') return { img: fitAlpha(img, 1024), background, fill }
    return { img: kind === 'icon' || kind === 'icon-set' ? squareIcon(img, 512) : fitAlpha(trimToContent(img, 0.02), 1024), background, fill }
  }

  private async save(store: ThumbStore, img: Rgba, base: Omit<UiAsset, 'scope' | 'file' | 'width' | 'height' | 'stats' | 'slice' | 'checks' | 'critique' | 'createdAt' | 'updatedAt'>, extra: { background: 'transparent' | 'keyed' | 'opaque'; fill: number; kit: UiKit | null }): Promise<UiAsset> {
    const stats = uiAssetStats(img)
    const slice = base.kind === 'button' || base.kind === 'panel' ? (sliceCenter(img) ?? undefined) : undefined
    const checks = uiChecks({ kind: base.kind, img, stats, background: extra.background, fill: extra.fill, slice, kitPalette: extra.kit?.palette })
    const now = this.h.now()
    const asset: UiAsset = { ...base, scope: store.scope, file: 'image.png', width: img.width, height: img.height, stats, ...(slice ? { slice } : {}), checks, critique: codeCritique(checks, now), ...(extra.background === 'keyed' ? { keyed: true } : {}), createdAt: now, updatedAt: now }
    await store.writeFile('ui', asset.id, 'image.png', encodePng(img))
    return store.save('ui', asset)
  }

  // One cheap vision call ranks every candidate against the brief (and the kit); without a model, or
  // when it fails, the code checks stand.
  private async rank(store: ThumbStore, assets: UiAsset[], imgs: Rgba[], brief: string, kit: UiKit | null, notes: string[], tier: ThumbTier = 'cheap'): Promise<UiAsset[]> {
    const vision = this.h.vision(tier) ?? (tier === 'cheap' ? this.h.vision('default') : null)
    if (!vision || !assets.length) return assets
    try {
      const prompt = uiRankPrompt({ brief, kind: assets[0].kind, count: assets.length, kit: kit?.lines, measured: assets.map((a) => a.checks.map((c) => `${c.label} ${c.score.toFixed(0)}`).join(', ')) })
      const payload: ImagePayload[] = imgs.map((img) => ({ mime: 'image/png', base64: encodePng(onGrey(img)).toString('base64') }))
      const parsed = parseUiRanking(await vision(UI_RANK_SYSTEM, prompt, payload), assets.length)
      if (!parsed) throw new Error('the critic did not answer with JSON')
      const out: UiAsset[] = []
      for (const [i, a] of assets.entries()) {
        const r = parsed[i]
        out.push(r ? await store.save('ui', { ...a, critique: blendCritique(r, a.checks, this.h.now()), ...(r.look && Object.values(r.look).some(Boolean) ? { look: r.look } : {}), updatedAt: this.h.now() }) : a)
      }
      return out
    } catch (e) {
      const msg = (e as Error).message
      notes.push(`Ranked by the code checks only (critic: ${msg.slice(0, 160)}).`)
      this.h.log(`thumbs: ui critic: ${msg}`, 'stderr')
      return assets
    }
  }

  async generate(input: UiGenerateInput): Promise<UiBatchResult> {
    const ask = String(input.ask ?? '').trim().slice(0, 2000)
    if (!ask) throw new ThumbError('Describe the UI asset, e.g. "a green BUY button, glossy".')
    const q = this.request(input)
    if (q.kind === 'icon-set' && q.names.length < 2) throw new ThumbError('Name at least two icons for a set, e.g. "coin, gem, heart, key".')
    const codex = this.h.codex()
    if (!codex && !(await this.h.openAiKey())) throw new ThumbError(NO_BACKEND)
    const est = await this.estimate(input)
    if (est.overCap) throw new ThumbError(`This would pass today's image budget (${formatUsd(est.spentTodayUsd)} spent + ${formatUsd(est.totalUsd)} > ${formatUsd(est.dailyCapUsd)}). Raise it on the Art page.`)
    const kit = input.useKit === false ? null : await this.kit(q.kind)
    const usable = kit && kit.samples + kit.refIds.length > 0 ? kit : null
    const sections = normalizeSections(input.sections) ?? buildSections({ ask, mode: q.kind, gameName: this.h.gameName(), kit: usable, names: q.names, size: q.genSize })
    const kitRefs = (await Promise.all((usable?.refIds ?? []).slice(0, MAX_KIT_REFS).map((id) => this.refData(id).then((d) => (d ? { id, d } : null))))).filter((r): r is { id: string; d: string } => !!r)
    const batchId = `ua-${this.h.now().toString(36)}${randomBytes(2).toString('hex')}`
    const store = this.h.storeFor(input.scope)
    const notes: string[] = []
    const perImage = codex ? 0 : round(estimateImageUsd(q.model, q.quality, q.genSize))
    const model = codex ? CODEX_IMAGE_MODEL : q.model
    const genSize = codex ? 'auto' : q.genSize
    const quality = codex ? 'auto' : q.quality
    const gameName = this.h.gameName()
    const first = q.kind === 'icon-set' ? q.names[0] : undefined
    const prompt = uiPrompt(sections, { kind: q.kind, gameName, icon: first, kitRefs: kitRefs.length })
    let k = 0
    const made: { asset: UiAsset; img: Rgba }[] = []
    const failed: string[] = []

    const run = async (p: string, n: number, refs: string[], meta: Partial<UiAsset> & { name: string }): Promise<{ asset: UiAsset; img: Rgba }[]> => {
      let res
      try {
        res = await this.images(q, p, n, refs)
      } catch (e) {
        this.h.progress(batchId, 'failed', (e as Error).message, { done: true, error: true })
        throw e
      }
      notes.push(...res.notes)
      const cost = codex ? 0 : round(perImage * n + refs.length * REFERENCE_IMAGE_USD)
      if (!codex) this.h.chargeImage?.(cost)
      const out: { asset: UiAsset; img: Rgba }[] = []
      for (const [i, bytes] of res.images.entries()) {
        try {
          const pr = await this.process(bytes, q.kind)
          k++
          const asset = await this.save(
            store,
            pr.img,
            {
              id: `${batchId}-${k}`,
              batchId,
              kind: q.kind,
              ask,
              prompt: p,
              sections,
              model,
              genSize,
              quality,
              costUsd: round(cost / res.images.length),
              transparent: q.transparent,
              refIds: refs.length ? [...(meta.refIds ?? []), ...kitRefs.map((r) => r.id)] : [],
              ...meta,
              name: res.images.length > 1 ? `${meta.name} ${i + 1}` : meta.name
            },
            { background: pr.background, fill: pr.fill, kit: usable }
          )
          out.push({ asset, img: pr.img })
        } catch (e) {
          failed.push(`#${i + 1}: ${(e as Error).message}`)
          this.h.log(`thumbs: ui ${batchId} image ${i + 1}: ${(e as Error).message}`, 'stderr')
        }
      }
      return out
    }

    this.h.progress(batchId, 'generating', `${q.n} × ${UI_KINDS[q.kind].label.toLowerCase()}${first ? ` (${first})` : ''}`)
    const cands = await run(prompt, q.n, kitRefs.map((r) => r.d), { name: first ?? ask.slice(0, 40), ...(q.kind === 'icon-set' ? { setName: ask.slice(0, 60), setIndex: 0 } : {}) })
    made.push(...cands)
    if (!cands.length) {
      const msg = `${codex ? 'Codex' : 'OpenAI'} answered, but no image could be read (${failed.join('; ').slice(0, 300)})`
      this.h.progress(batchId, 'failed', msg, { done: true, error: true })
      throw new ThumbError(msg)
    }
    this.h.changed()
    this.h.progress(batchId, 'critique', `${cands.length} candidate${cands.length === 1 ? '' : 's'}`)
    const ranked = await this.rank(store, cands.map((c) => c.asset), cands.map((c) => c.img), ask, usable, notes)
    const bestId = pickBestUi(ranked)
    const assets = [...ranked]
    let set: string[] | undefined
    if (q.kind === 'icon-set' && bestId) {
      // The best first icon anchors the rest: it goes first in every call.
      const anchor = ranked.find((a) => a.id === bestId)!
      const anchorData = toDataUrl(encodePng(cands.find((c) => c.asset.id === bestId)!.img))
      set = [anchor.id]
      const members: { asset: UiAsset; img: Rgba }[] = [cands.find((c) => c.asset.id === bestId)!]
      for (const [i, name] of q.names.slice(1).entries()) {
        this.h.progress(batchId, 'set', `${i + 2}/${q.names.length}: ${name}`)
        const p = uiPrompt(sections, { kind: q.kind, gameName, icon: name, anchor: true, kitRefs: kitRefs.length })
        const got = await run(p, 1, [anchorData, ...kitRefs.map((r) => r.d)], { name, setName: ask.slice(0, 60), setIndex: i + 1, refIds: [anchor.id] })
        if (!got.length) {
          notes.push(`No image for "${name}".`)
          continue
        }
        members.push(got[0])
        set.push(got[0].asset.id)
        this.h.changed()
      }
      // One more cheap call scores the whole set for consistency (the anchor keeps its own critique).
      if (members.length > 1) {
        const rankedSet = await this.rank(store, members.map((m) => m.asset), members.map((m) => m.img), `${ask} (a matching icon set: judge consistency with the first icon)`, usable, notes)
        assets.push(...rankedSet.slice(1))
      }
    }
    if (failed.length) notes.push(`Unreadable: ${failed.join('; ').slice(0, 200)}`)
    this.h.changed()
    this.h.progress(batchId, 'done', bestId ? `best: #${bestId.split('-').pop()}` : undefined, { done: true })
    return { id: batchId, assets, ...(bestId ? { bestId } : {}), ...(set ? { set } : {}), notes: [...new Set(notes)] }
  }

  // A fresh critique of one asset on the critic tier (code checks when there is no model).
  async critique(id: string): Promise<{ id: string; asset: UiAsset }> {
    const { item, store } = await this.must(id)
    const img = decodePng(await store.readFile('ui', id, item.file))
    const kit = await this.kit(item.kind)
    const notes: string[] = []
    const [out] = await this.rank(store, [item], [img], item.ask, kit.samples ? kit : null, notes, 'critic')
    if (notes.length) this.h.log(`thumbs: ${notes.join(' ')}`)
    this.h.changed()
    return { id: item.batchId, asset: out }
  }

  // ------------------------------------------------------------ labels

  private async update(id: string, fn: (a: UiAsset) => UiAsset): Promise<UiAsset> {
    const { item, store } = await this.must(id)
    const saved = await store.save('ui', { ...fn({ ...item }), updatedAt: this.h.now() })
    this.h.changed()
    return saved
  }

  async rate(id: string, rating: 'up' | 'down' | null): Promise<UiAsset> {
    const a = await this.update(id, (x) => {
      if (rating) x.rating = rating
      else delete x.rating
      return x
    })
    await this.learn().catch(() => undefined)
    return a
  }

  async keep(id: string, keep: boolean): Promise<UiAsset> {
    const a = await this.update(id, (x) => ({ ...x, keep: !!keep }))
    await this.learn().catch(() => undefined)
    return a
  }

  async pin(id: string, pinned: boolean): Promise<UiAsset> {
    return this.update(id, (x) => ({ ...x, pinned: !!pinned }))
  }

  async remove(id: string): Promise<boolean> {
    const hit = await this.find(id)
    if (!hit) return false
    const ok = await hit.store.remove('ui', id)
    this.h.changed()
    return ok
  }

  // Memory: the learned UI kit, so chat and agents describe the game's UI the same way.
  private async learn(): Promise<void> {
    if (!this.h.memory) return
    const kit = await this.kit()
    if (!kit.samples) return
    const body = [`Roblox UI style kit learned in the Thumbnail Lab (UI art) from ${kit.samples} kept or liked asset${kit.samples === 1 ? '' : 's'}.`, ...kit.lines.map((l) => `- ${l}`), ...kit.avoid.map((l) => `- ${l}`)].join('\n')
    await this.h.memory.remember({ scope: 'project', kind: 'skill', name: 'ui-style-kit', description: "The game's UI look (palette, outline, corners, shading, lettering) from kept UI art", body: body.slice(0, 7900) }, 'user')
  }

  // ------------------------------------------------------------ out

  async file(id: string): Promise<string | null> {
    const hit = await this.find(id).catch(() => null)
    if (!hit) return null
    const bytes = await hit.store.readFile('ui', id, hit.item.file).catch(() => null)
    return bytes ? toDataUrl(bytes) : null
  }

  // Into the project: art/ui/<kind>s/<name>.png (at most 1024 px, Roblox's image limit) + the Luau
  // to use it (SliceCenter scaled to the exported size).
  async export(id: string): Promise<{ path: string; luau: string }> {
    const root = this.h.projectRoot()
    if (!root) throw new ThumbError('Open the game project first: UI art is exported into it.')
    const { item, store } = await this.must(id)
    const img = decodePng(await store.readFile('ui', id, item.file))
    const out = fitAlpha(img, 1024)
    const folder = item.kind === 'icon-set' ? 'icons' : item.kind === 'hud' ? 'mockups' : `${item.kind}s`
    const base = slugify(item.setName && item.kind === 'icon-set' ? `${item.setName.split(/[,:]/)[0]} ${item.name}` : item.name)
    const dir = join(root, 'art', 'ui', folder)
    await mkdir(dir, { recursive: true })
    let name = `${base}.png`
    for (let i = 2; await stat(join(dir, name)).then(() => true, () => false); i++) name = `${base}-${i}.png`
    await writeFile(join(dir, name), encodePng(out))
    const rel = ['art', 'ui', folder, name].join('/')
    const slice = item.slice ? scaleSlice(item.slice, img, out) : undefined
    const saved = await store.save('ui', { ...item, exportedTo: rel, updatedAt: this.h.now() })
    this.h.changed()
    return { path: rel, luau: uiLuau({ ...saved, ...(slice ? { slice } : {}) }, { width: out.width, height: out.height }) }
  }

  async upload(id: string): Promise<UiAsset> {
    const { item, store } = await this.must(id)
    const key = await this.h.robloxKey()
    if (!key) throw new ThumbError('No Open Cloud API key with asset:read + asset:write. Add one on the Art page.')
    const img = decodePng(await store.readFile('ui', id, item.file))
    const r = await uploadImageAsset({
      apiKey: key,
      bytes: encodePng(fitAlpha(img, 1024)),
      fileName: `${id}.png`,
      displayName: `UI ${item.name}`.slice(0, 50),
      description: `UI art from RBX Forge: ${item.ask}`.slice(0, 900),
      assetType: 'Image',
      contentType: 'image/png',
      creator: this.h.creator(),
      fetch: this.h.fetch,
      sleep: this.h.sleep,
      now: () => this.h.now()
    })
    return this.update(id, (x) => ({ ...x, roblox: { assetId: r.assetId, uri: r.uri, uploadedAt: this.h.now(), ...(r.moderation ? { moderation: r.moderation } : {}) } }))
  }
}
