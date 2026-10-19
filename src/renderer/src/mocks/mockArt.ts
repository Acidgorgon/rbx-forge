// Browser-preview mock of ArtApi: placeholder "generated" images as inline SVG data URLs, so the
// Art page and its gallery render without Electron, OpenAI or Roblox.
import type { ArtApi, ArtCostEstimate, ArtGenerateInput, ArtItem, ArtLayerManifest, ArtLayerSpec, ArtRegistryEntry, ArtSettings, ArtStatus, ArtStylePreset, HarnessEvents, ModelInboxStatus } from '@shared/types'
import { conceptLayerName, layerName, layersDir, normalizeLayerSpecs } from '@shared/artLayers'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

const STYLES: ArtStylePreset[] = [
  { id: 'none', label: 'No preset', direction: '' },
  { id: 'roblox-ui-flat', label: 'Roblox UI flat', direction: 'Flat game UI element…', size: '1024x1024', transparent: true },
  { id: 'stylized-icon', label: 'Stylized icon', direction: 'Stylized 3D-rendered game icon…', size: '1024x1024', transparent: true },
  { id: 'cartoon-key-art', label: 'Cartoon key art', direction: 'Vibrant cartoon key art…', size: '1536x1024' },
  { id: 'thumbnail-16x9', label: 'Thumbnail 16:9', direction: 'Roblox experience thumbnail…', size: '1920x1088' },
  { id: 'game-icon-512', label: 'Game icon 512', direction: 'Roblox experience icon…', size: '1024x1024' }
]

const PER_IMAGE: Record<string, number> = { low: 0.0059, medium: 0.0132, high: 0.0527, xhigh: 0.0937, max: 0.2107, auto: 0.0527 }

let settings: ArtSettings = { model: 'gpt-image-2.5-flare', quality: 'high', gitPolicy: 'track-small', dailyCapUsd: 5, assetType: 'Image', creatorUserId: 1234567 }
let robloxKey = false
const INBOX_DEFAULT = '/Users/you/Documents/ForgeModels/_upload_inbox'
let inbox = { enabled: false, insert: false, dir: null as string | null }
const inboxStatus = (): ModelInboxStatus => ({
  enabled: inbox.enabled,
  dir: inbox.dir ?? INBOX_DEFAULT,
  defaultDir: INBOX_DEFAULT,
  modelsDir: '/Users/you/Documents/ForgeModels',
  robloxKey,
  creator: !!(settings.creatorUserId || settings.creatorGroupId),
  watching: inbox.enabled || inbox.insert,
  insertEnabled: inbox.insert,
  recent: inbox.enabled ? [{ id: 'emberstag-head', name: 'EmberstagHead', status: 'done', assetId: 18_200_000_123, at: new Date().toISOString() }] : []
})

// Deterministic placeholder art: a soft gradient, a shape, a highlight.
function placeholder(seed: number, w: number, h: number, transparent: boolean): string {
  const hues = [42, 200, 330, 140, 270, 15, 180]
  const a = hues[seed % hues.length]
  const b = (a + 40 + (seed % 3) * 25) % 360
  const shape = seed % 4
  const cx = w / 2
  const cy = h / 2
  const r = Math.min(w, h) * 0.3
  const body =
    shape === 0
      ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#g)" stroke="#1b1d22" stroke-width="${r * 0.12}"/><circle cx="${cx}" cy="${cy}" r="${r * 0.62}" fill="none" stroke="hsl(${a} 90% 80%)" stroke-width="${r * 0.08}"/>`
      : shape === 1
        ? `<rect x="${cx - r * 1.3}" y="${cy - r * 0.55}" width="${r * 2.6}" height="${r * 1.1}" rx="${r * 0.3}" fill="url(#g)" stroke="#1b1d22" stroke-width="${r * 0.1}"/><rect x="${cx - r * 1.1}" y="${cy - r * 0.42}" width="${r * 2.2}" height="${r * 0.32}" rx="${r * 0.16}" fill="#fff" opacity=".35"/>`
        : shape === 2
          ? `<path d="M${cx} ${cy - r} L${cx + r * 0.95} ${cy - r * 0.3} L${cx + r * 0.6} ${cy + r * 0.85} L${cx - r * 0.6} ${cy + r * 0.85} L${cx - r * 0.95} ${cy - r * 0.3} Z" fill="url(#g)" stroke="#1b1d22" stroke-width="${r * 0.1}" stroke-linejoin="round"/>`
          : `<path d="M${cx - r} ${cy + r * 0.6} Q${cx} ${cy - r * 1.4} ${cx + r} ${cy + r * 0.6} Z" fill="url(#g)" stroke="#1b1d22" stroke-width="${r * 0.1}"/><circle cx="${cx + r * 0.9}" cy="${cy - r * 0.9}" r="${r * 0.25}" fill="hsl(${b} 90% 75%)"/>`
  const bg = transparent ? '' : `<rect width="${w}" height="${h}" fill="hsl(${b} 35% 16%)"/><circle cx="${w * 0.8}" cy="${h * 0.2}" r="${h * 0.5}" fill="hsl(${a} 50% 30%)" opacity=".45"/>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${a} 95% 68%)"/><stop offset="1" stop-color="hsl(${b} 85% 45%)"/></linearGradient></defs>${bg}${body}</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const dayOf = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const slugify = (t: string) =>
  t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').filter((w) => w && !['a', 'an', 'the', 'of', 'for', 'and', 'with'].includes(w)).join('-').slice(0, 40) || 'concept'

let seq = 0
function makeItem(prompt: string, at: number, index: number, opts: { size?: string; quality?: string; transparent?: boolean; style?: ArtItem['style']; uri?: string; source?: ArtItem['source'] } = {}): ArtItem {
  const date = dayOf(at)
  const slug = slugify(prompt)
  const size = opts.size ?? '1024x1024'
  const [w, h] = size.split('x').map(Number)
  seq++
  return {
    path: `art/concepts/${date}/${slug}-${index}.png`,
    absPath: `/Users/you/games/Bladefall/art/concepts/${date}/${slug}-${index}.png`,
    date,
    slug,
    index,
    prompt,
    fullPrompt: prompt,
    style: opts.style ?? 'none',
    model: settings.model,
    size,
    quality: opts.quality ?? 'high',
    background: opts.transparent ? 'transparent' : 'opaque',
    outputFormat: 'png',
    mode: 'generate',
    seed: null,
    costUsd: PER_IMAGE[opts.quality ?? 'high'],
    createdAt: new Date(at + index).toISOString(),
    bytes: 900_000 + ((seq * 7919) % 900_000),
    width: w || 1024,
    height: h || 1024,
    source: opts.source ?? 'page',
    ...(opts.uri ? { roblox: { assetId: opts.uri.replace(/\D/g, ''), uri: opts.uri, assetType: 'Image' as const, name: slug, uploadedAt: new Date(at).toISOString(), moderation: 'MODERATION_STATE_APPROVED' } } : {})
  }
}

const H = 3_600_000
const t0 = Date.now()
let items: ArtItem[] = [
  makeItem('Football game main menu, 16:9: stadium tunnel background, a striker, big headline, nav tabs and three cards (Quick Join, Ranked, Shop)', t0 - 0.5 * H, 1, { size: '1536x1024', style: 'cartoon-key-art' }),
  makeItem('Gold coin icon with a sword emblem, chunky outline', t0 - 1 * H, 1, { transparent: true, style: 'stylized-icon', uri: 'rbxassetid://18273645012' }),
  makeItem('Gold coin icon with a sword emblem, chunky outline', t0 - 1 * H, 2, { transparent: true, style: 'stylized-icon' }),
  makeItem('Shop button, green, rounded, glossy', t0 - 2 * H, 1, { transparent: true, style: 'roblox-ui-flat', source: 'agent' }),
  makeItem('Shop button, green, rounded, glossy', t0 - 2 * H, 2, { transparent: true, style: 'roblox-ui-flat', source: 'agent' }),
  makeItem('Shop button, green, rounded, glossy', t0 - 2 * H, 3, { transparent: true, style: 'roblox-ui-flat', source: 'agent' }),
  makeItem('Bladefall key art: two knights clash on a floating island at sunset', t0 - 26 * H, 1, { size: '1536x1024', style: 'cartoon-key-art' }),
  makeItem('Bladefall thumbnail, hero mid-swing, big impact sparks', t0 - 27 * H, 1, { size: '1920x1088', style: 'thumbnail-16x9', quality: 'medium' }),
  makeItem('Game icon: crossed swords over a glowing gem', t0 - 50 * H, 1, { style: 'game-icon-512' }),
  makeItem('Game icon: crossed swords over a glowing gem', t0 - 50 * H, 2, { style: 'game-icon-512' })
]
const thumbs = new Map<string, string>()
// Split into layers: manifests by ConceptName.
const layerSets = new Map<string, ArtLayerManifest & { spend?: number }>()
// What the mock "vision model" sees in a UI mockup.
const PROPOSAL: ArtLayerSpec[] = [
  { name: 'Background', kind: 'background', prompt: 'The stadium tunnel at night with floodlights and haze, every UI element, text, card and the striker removed.', transparent: false, size: '1536x1024' },
  { name: 'QuickJoinCard', kind: 'panel', prompt: 'The green Quick Join card background with the pitch-line pattern, no text or icons.', transparent: true, size: '1024x1536' },
  { name: 'RankedCard', kind: 'panel', prompt: 'The gold Ranked card background with the trophy glow, no text or icons.', transparent: true, size: '1024x1536' },
  { name: 'ShopIcon', kind: 'icon', prompt: 'The shopping bag icon with a football, glossy.', transparent: true, size: '1024x1024' },
  { name: 'GameLogo', kind: 'logo', prompt: 'The shield-shaped game logo with the ball emblem.', transparent: true, size: '1024x1024' },
  { name: 'Striker', kind: 'character', prompt: 'The striker in the red kit mid-celebration, full figure.', transparent: true, size: '1024x1536' }
]
const layerUsd = (size?: string, quality?: string) => PER_IMAGE[quality ?? settings.quality] * (size === '1024x1024' ? 1 : 0.78) + 0.008
const layersSpentToday = () => [...layerSets.values()].reduce((s, m) => s + (m.spend ?? 0), 0)
items.forEach((it, i) => thumbs.set(it.path, placeholder(i * 3 + it.index, it.width!, it.height!, it.background === 'transparent')))
let registry: ArtRegistryEntry[] = [{ name: 'GoldCoinIconSwordEmblem', uri: 'rbxassetid://18273645012' }]
const trash = new Map<string, ArtItem>()

const status = (): ArtStatus => ({
  project: true,
  openaiKey: true,
  robloxKey,
  ...(robloxKey ? { robloxKeySource: 'art' as const } : {}),
  settings,
  styles: STYLES,
  models: ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini']
})

const regName = (s: string) => s.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('').slice(0, 60) || 'Image'

function estimate(input: ArtGenerateInput): ArtCostEstimate {
  const preset = STYLES.find((s) => s.id === input.style)
  const quality = input.quality ?? settings.quality
  const n = Math.max(1, Math.min(10, input.n ?? 1))
  const size = input.size || preset?.size || '1024x1024'
  const per = PER_IMAGE[quality] * (size === '1024x1024' ? 1 : 0.78)
  const today = dayOf(Date.now())
  return {
    model: input.model ?? settings.model,
    quality,
    size,
    n,
    perImageUsd: per,
    totalUsd: per * n + (input.referencePaths?.length ?? 0) * 0.008,
    spentTodayUsd: items.filter((i) => i.date === today).reduce((s, i) => s + i.costUsd, 0) + layersSpentToday(),
    dailyCapUsd: settings.dailyCapUsd,
    note: 'Estimate from OpenAI per-image token prices; actual billing can differ.'
  }
}

export function artMock(emit: Emit): ArtApi {
  const changed = () => emit('art:changed', { root: '/Users/you/games/Bladefall' })
  return {
    async artStatus() {
      return status()
    },
    async artSetSettings(patch) {
      settings = { ...settings, ...patch }
      return status()
    },
    async artSetRobloxKey() {
      robloxKey = true
      return status()
    },
    async artClearRobloxKey() {
      robloxKey = false
      return status()
    },
    async artList() {
      return items.slice()
    },
    async artEstimate(input) {
      return estimate(input)
    },
    async artGenerate(input) {
      const id = Math.random().toString(36).slice(2, 8)
      const est = estimate(input)
      const preset = STYLES.find((s) => s.id === input.style)
      emit('art:progress', { id, stage: 'generating', detail: `${est.n} × ${est.size} ${est.quality}` })
      await delay(1400)
      const at = Date.now()
      const slug = slugify(input.slug || input.prompt)
      const existing = items.filter((i) => i.slug === slug && i.date === dayOf(at)).length
      const made = Array.from({ length: est.n }, (_, k) =>
        makeItem(input.prompt, at, existing + k + 1, { size: est.size, quality: est.quality, transparent: input.transparent ?? preset?.transparent, style: input.style ?? 'none' })
      )
      made.forEach((it, k) => {
        if (input.referencePaths?.length) Object.assign(it, { mode: 'edit', referencePaths: input.referencePaths })
        thumbs.set(it.path, placeholder(Math.floor(Math.random() * 50) + k, it.width!, it.height!, it.background === 'transparent'))
      })
      items = [...made, ...items]
      emit('art:progress', { id, stage: 'done', detail: `${made.length} images` })
      changed()
      return made
    },
    async artThumbnail(path) {
      return thumbs.get(path) ?? placeholder(1, 512, 512, false)
    },
    async artDelete(path) {
      const it = items.find((i) => i.path === path)
      if (!it) throw new Error(`${path} does not exist`)
      const undoId = Math.random().toString(36).slice(2)
      trash.set(undoId, it)
      items = items.filter((i) => i !== it)
      changed()
      return { undoId }
    },
    async artUndoDelete(undoId) {
      const it = trash.get(undoId)
      if (!it) return null
      trash.delete(undoId)
      items = [...items, it].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      changed()
      return it
    },
    async artImportToRoblox(input) {
      if (!robloxKey) throw new Error('No Open Cloud API key with asset:read + asset:write. Add one on the Art page.')
      const it = items.find((i) => i.path === input.path)
      if (!it) throw new Error(`${input.path} does not exist`)
      const id = Math.random().toString(36).slice(2, 8)
      emit('art:progress', { id, stage: 'uploading' })
      await delay(700)
      emit('art:progress', { id, stage: 'processing' })
      await delay(900)
      const assetId = String(18_000_000_000 + Math.floor(Math.random() * 999_999_999))
      const name = regName(input.name || it.slug)
      const uri = `rbxassetid://${assetId}`
      it.roblox = { assetId, uri, assetType: input.assetType ?? settings.assetType, name, uploadedAt: new Date().toISOString(), moderation: 'MODERATION_STATE_APPROVED' }
      const had = registry.some((e) => e.name === name && e.uri === uri)
      registry = [...registry.filter((e) => e.name !== name), { name, uri }].sort((a, b) => (a.name < b.name ? -1 : 1))
      emit('art:progress', { id, stage: 'done', detail: uri })
      changed()
      return { item: { ...it }, assetId, uri, ...(input.registry === false ? {} : { registry: { path: 'src/shared/Assets/Images.luau', name, changed: !had } }) }
    },
    async artSaveToProject(path, name) {
      const it = items.find((i) => i.path === path)
      if (!it) throw new Error(`${path} does not exist`)
      it.savedAs = `art/ui/${regName(name || it.slug)}.png`
      changed()
      return { ...it }
    },
    async artRegistry() {
      return registry.slice()
    },
    async artChooseReferences() {
      return ['/Users/you/Desktop/hud-screenshot.png']
    },
    async artReveal(path) {
      if (!items.some((i) => i.path === path)) throw new Error(`${path} does not exist`)
    },
    async artLayersPropose(concept) {
      const it = items.find((i) => i.path === concept)
      if (!it) throw new Error(`${concept} does not exist`)
      const id = Math.random().toString(36).slice(2, 8)
      emit('art:progress', { id, stage: 'proposing layers', detail: concept })
      await delay(600)
      emit('art:progress', { id, stage: 'done', detail: 'layers proposed' })
      const existing = [...layerSets.values()].find((m) => m.concept === concept)
      return { concept, name: existing?.name ?? conceptLayerName(it.slug, it.index), layers: PROPOSAL.map((l) => ({ ...l })), source: 'vision', ...(existing ? { existing } : {}) }
    },
    async artLayersEstimate(input) {
      const layers = normalizeLayerSpecs(input.layers)
      if (!layers.length) throw new Error('Add at least one layer')
      const codex = settings.backend === 'codex'
      const per = layers.map((l) => ({ name: l.name, size: l.size ?? '1024x1024', usd: codex ? 0 : layerUsd(l.size, input.quality) }))
      const totalUsd = per.reduce((s, p) => s + p.usd, 0)
      const spentTodayUsd = estimate({ prompt: '' }).spentTodayUsd
      const dailyCapUsd = codex ? 0 : settings.dailyCapUsd
      return { layers: per, totalUsd, spentTodayUsd, dailyCapUsd, model: codex ? 'codex-gpt-image-2' : settings.model, quality: codex ? 'auto' : (input.quality ?? settings.quality), overCap: dailyCapUsd > 0 && spentTodayUsd + totalUsd > dailyCapUsd, note: codex ? 'ChatGPT plan (Codex)' : `${layers.length} edits with the concept as the reference.` }
    },
    async artLayersGenerate(input) {
      const it = items.find((i) => i.path === input.concept)
      if (!it) throw new Error(`${input.concept} does not exist`)
      const est = await this.artLayersEstimate(input)
      if (est.overCap) throw new Error("This would pass today's art budget. Raise it on the Art page or drop some layers.")
      const name = layerName(input.name || conceptLayerName(it.slug, it.index), 'Concept')
      const now = new Date().toISOString()
      const m = layerSets.get(name) ?? { version: 1 as const, name, concept: it.path, createdAt: now, updatedAt: now, layers: [], spend: 0 }
      const id = Math.random().toString(36).slice(2, 8)
      const specs = normalizeLayerSpecs(input.layers)
      for (const [k, spec] of specs.entries()) {
        emit('art:progress', { id, stage: 'generating layers', detail: `${k + 1}/${specs.length} · ${spec.name}` })
        await delay(250)
        const file = `${layersDir(name)}/${spec.name}.png`
        const [w, h] = (spec.size ?? '1024x1024').split('x').map(Number)
        thumbs.set(file, placeholder(k * 5 + 2, w || 1024, h || 1024, spec.transparent))
        const usd = est.layers[k]?.usd ?? 0
        const layer = { ...spec, file, size: spec.size ?? '1024x1024', model: est.model, costUsd: usd, createdAt: new Date().toISOString() }
        const at = m.layers.findIndex((l) => l.name === spec.name)
        if (at >= 0) m.layers[at] = layer
        else m.layers.push(layer)
        m.spend = (m.spend ?? 0) + usd
      }
      m.updatedAt = new Date().toISOString()
      layerSets.set(name, m)
      emit('art:progress', { id, stage: 'done', detail: `${specs.length} layers` })
      changed()
      return JSON.parse(JSON.stringify(m))
    },
    async artLayersGet(q) {
      const m = q.includes('/') ? [...layerSets.values()].find((x) => x.concept === q) : layerSets.get(layerName(q, 'Concept'))
      return m ? JSON.parse(JSON.stringify(m)) : null
    },
    async artLayersImport(name, opts) {
      if (!robloxKey) throw new Error('No Open Cloud API key with asset:read + asset:write. Add one on the Art page.')
      const m = layerSets.get(name)
      if (!m) throw new Error(`No layers for ${name}. Split the concept into layers first.`)
      const id = Math.random().toString(36).slice(2, 8)
      const imported: string[] = []
      const todo = m.layers.filter((l) => opts?.force || !l.uri)
      for (const [k, l] of todo.entries()) {
        emit('art:progress', { id, stage: 'importing layers', detail: `${k + 1}/${todo.length} · ${l.name}` })
        await delay(200)
        l.assetId = String(18_100_000_000 + Math.floor(Math.random() * 999_999_999))
        l.uri = `rbxassetid://${l.assetId}`
        l.moderation = 'MODERATION_STATE_APPROVED'
        l.uploadedAt = new Date().toISOString()
        imported.push(l.name)
      }
      emit('art:progress', { id, stage: 'done', detail: `${imported.length} imported` })
      changed()
      return { manifest: JSON.parse(JSON.stringify(m)), imported, failed: [] }
    },
    async fbxInboxStatus() {
      return inboxStatus()
    },
    async fbxInboxSetSettings(patch) {
      if (patch.enabled && !robloxKey) throw new Error('Add an Open Cloud API key (Art page > Roblox import) before turning on the inbox.')
      inbox = { enabled: patch.enabled ?? inbox.enabled, insert: patch.insert ?? inbox.insert, dir: 'dir' in patch ? (patch.dir ?? null) : inbox.dir }
      return inboxStatus()
    },
    async fbxInboxChooseFolder() {
      inbox = { ...inbox, dir: '/Users/you/Desktop/fbx-inbox' }
      return inboxStatus()
    }
  }
}
