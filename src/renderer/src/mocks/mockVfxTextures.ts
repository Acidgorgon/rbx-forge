// Browser-preview mock of VfxTextureApi: a small texture library drawn with the real procedural
// generators (shared/vfx/tex), PNGs made on a canvas, fake AI generation (procedural stand-ins),
// fake upload with a moderation state that clears on "Check".
import type { HarnessEvents, TextureGenerateInput, TextureImportRow, TextureImportScan, TexturePolicy, TextureStatus, VfxTexture, VfxTextureApi } from '@shared/types'
import { generateProcedural, PROCEDURAL_INFO, PROCEDURAL_TYPES, type ProceduralType } from '@shared/vfx/tex/procedural'
import { premultipliedPreview, type Rgba } from '@shared/vfx/tex/image'
import { kindFromText, parseTexRef, texturePreset, type TextureKind } from '@shared/vfx/tex/textures'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function dataUrl(img: Rgba): string {
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d')!
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0)
  return c.toDataURL('image/png')
}

const files = new Map<string, { texture: string; preview: string }>()
const items: VfxTexture[] = []
const t0 = Date.UTC(2026, 9, 13, 9, 0)
let n = 0

function addProcedural(type: ProceduralType, o: { name?: string; seed?: number; params?: Record<string, number>; frames?: number; tint?: 'white' | 'grey'; scope?: 'user' | 'project'; rating?: 'up' | 'down'; uploaded?: 'Approved' | 'Reviewing'; kind?: TextureKind; id?: string } = {}): VfxTexture {
  const r = generateProcedural({ type, seed: o.seed ?? 1, params: o.params, frames: o.frames, tint: o.tint ?? (type === 'smoke' ? 'grey' : 'white'), size: o.frames && o.frames > 1 ? 512 : 256 })
  const id = o.id ?? `${type}-${(n++).toString(36)}${n}`
  const t: VfxTexture = {
    id,
    scope: o.scope ?? 'user',
    name: o.name ?? `${PROCEDURAL_INFO[type].label}${r.layout ? ` ${r.layout}` : ''}`,
    kind: o.kind ?? (type as TextureKind),
    description: `Procedural ${PROCEDURAL_INFO[type].label.toLowerCase()} (${PROCEDURAL_INFO[type].use}).`,
    tags: [type, 'procedural', ...(r.layout ? ['flipbook'] : [])],
    source: 'procedural',
    procedural: { type, params: r.params, seed: r.seed },
    tint: o.tint ?? (type === 'smoke' ? 'grey' : 'white'),
    size: r.image.width,
    ...(r.layout ? { flipbook: { layout: r.layout, frames: r.frames } } : {}),
    createdAt: t0 + n * 60_000,
    updatedAt: t0 + n * 60_000,
    ...(o.rating ? { rating: o.rating } : {}),
    ...(o.uploaded ? { roblox: { assetId: String(18800000000 + n * 7919), uri: `rbxassetid://${18800000000 + n * 7919}`, uploadedAt: t0, moderation: o.uploaded } } : {}),
    file: 'texture.png',
    preview: 'preview.png'
  }
  files.set(id, { texture: dataUrl(r.image), preview: dataUrl(premultipliedPreview(r.image)) })
  items.unshift(t)
  return t
}

let seeded = false
function seed(): void {
  if (seeded) return
  seeded = true
  addProcedural('glow', { name: 'Soft core glow', rating: 'up', uploaded: 'Approved', id: 'soft-core-glow-a1' })
  addProcedural('ring', { name: 'Thin shockwave ring', params: { thickness: 0.06, breakup: 0.4 }, uploaded: 'Reviewing', kind: 'shockwave', id: 'thin-shockwave-ring-b2' })
  addProcedural('spark', { name: 'Needle spark' })
  addProcedural('smoke', { name: 'Grey smoke puff', seed: 3, scope: 'project' })
  addProcedural('crack', { name: 'Ground crack', seed: 4, scope: 'project', id: 'ground-crack-c3' })
  addProcedural('star', { name: 'Four-point glint', rating: 'up' })
  addProcedural('slash', { name: 'Slash crescent', params: { arc: 200 } })
  addProcedural('smoke', { name: 'Smoke dissolve', frames: 16, seed: 5, rating: 'down' })
  addProcedural('ring', { name: 'Shockwave expand', frames: 16, scope: 'project', id: 'shockwave-expand-d4' })
}

const genCache = new Map<string, string>()

// forgetex:// for the VFX preview mock (mockVfx.vfxResolveTexture).
export async function mockResolveTexture(ref: string): Promise<string | null> {
  seed()
  const p = parseTexRef(ref)
  if (!p) return null
  if (p.kind === 'id') return files.get(p.id)?.texture ?? null
  if (!genCache.has(ref)) genCache.set(ref, dataUrl(generateProcedural({ type: p.type, params: p.params, seed: p.seed, frames: p.frames, tint: p.tint, size: p.frames > 1 ? 512 : 256 }).image))
  return genCache.get(ref)!
}

export function vfxTexturesMock(emit: Emit): VfxTextureApi {
  const changed = () => emit('vfx:textures', { at: Date.now() })
  const find = (id: string) => {
    seed()
    const t = items.find((x) => x.id === id)
    if (!t) throw new Error(`No texture ${id}`)
    return t
  }
  let spent = 0.42
  let policy: TexturePolicy = 'library-first'
  // Browser mock of an import review: three procedural "files", one a 4x4 flipbook.
  const mockScan = (from: TextureImportRow['from'], n: number): TextureImportScan => ({
    scanId: `scan-${Date.now()}`,
    notes: from === 'studio' ? ['Mock: ids as Studio would report them.'] : [],
    rows: Array.from({ length: n }, (_, i) => {
      const type = (['smoke', 'spark', 'ring', 'glow'] as ProceduralType[])[i % 4]
      const fb = from === 'file' && i === 0
      return {
        key: `m${i}`,
        from,
        label: from === 'file' ? `pack/${type}_${i}${fb ? '_4x4' : ''}.png` : String(1234567 + i),
        name: `${type[0].toUpperCase()}${type.slice(1)} ${i + 1}`,
        kind: type as TextureKind,
        tags: [type, 'white', 'soft', from === 'file' ? 'imported' : 'asset'],
        description: `White ${type}, soft edges.`,
        flipbook: fb ? { layout: 'Grid4x4' as const, frames: 16, cols: 4, rows: 4, source: 'name' } : null,
        preview: dataUrl(premultipliedPreview(generateProcedural({ type, size: 96, frames: fb ? 16 : 1, tint: 'white' }).image)),
        notes: [],
        ...(from !== 'file' ? { assetId: String(1234567 + i) } : {}),
        ...(i === 2 ? { duplicateOf: items[0]?.id ?? 'glow' } : {})
      }
    })
  })
  return {
    async vfxTexImportPick() {
      return ['/mock/textures']
    },
    async vfxTexImportScan(paths) {
      await delay(400)
      return mockScan('file', Math.min(6, 3 + paths.length))
    },
    async vfxTexImportIds(text) {
      await delay(400)
      return mockScan('asset', Math.max(1, Math.min(4, text.split(/[\s,]+/).filter(Boolean).length)))
    },
    async vfxTexImportStudio() {
      await delay(600)
      return mockScan('studio', 3)
    },
    async vfxTexImportCommit(input) {
      const out: VfxTexture[] = []
      for (const r of input.rows) {
        const t = addProcedural('glow', { name: r.name, scope: input.scope ?? 'project', kind: r.kind })
        Object.assign(t, { source: 'imported', tags: r.tags ?? t.tags, description: r.description ?? '' })
        out.push(t)
      }
      changed()
      return out
    },
    async vfxTexSetPolicy(p) {
      policy = p
      changed()
      return p
    },
    async vfxTexStatus(): Promise<TextureStatus> {
      seed()
      return { project: true, openaiKey: true, robloxKey: true, creator: true, model: 'gpt-image-2.5-flare', perImageUsd: 0.013, spentTodayUsd: spent, dailyCapUsd: 5, counts: { user: items.filter((t) => t.scope === 'user').length, project: items.filter((t) => t.scope === 'project').length }, policy, vision: true, studio: { connected: true, liveTree: false } }
    },
    async vfxTexList() {
      seed()
      return [...items]
    },
    async vfxTexGenerate(input: TextureGenerateInput) {
      seed()
      await delay(input.ai ? 900 : 200)
      const kind = input.kind ?? kindFromText(input.description ?? '')
      const type = (input.procedural?.type ?? texturePreset(kind).procedural ?? 'glow') as ProceduralType
      if (!PROCEDURAL_TYPES.includes(type)) throw new Error('unknown type')
      const count = input.ai && (!input.frames || input.frames === 1) ? Math.max(1, Math.min(4, input.n ?? 1)) : 1
      const out: VfxTexture[] = []
      for (let i = 0; i < count; i++) {
        const t = addProcedural(type, { name: input.name || (input.ai ? (input.description || kind).slice(0, 40) + (count > 1 ? ` ${i + 1}` : '') : undefined), seed: (input.procedural?.seed ?? 1) + i * (input.ai ? 13 : 0), params: input.procedural?.params, frames: input.frames, tint: input.tint === 'grey' ? 'grey' : 'white', scope: input.scope ?? 'project', kind })
        if (input.ai) Object.assign(t, { source: 'ai', prompt: input.description, model: 'gpt-image-2.5-flare', costUsd: 0.013, tags: [kind, 'ai'], description: input.description ?? '' })
        if (input.ai) spent += 0.013
        out.push(t)
      }
      changed()
      return out
    },
    async vfxTexPreview(input) {
      const frames = [4, 16, 64].includes(Number(input.frames)) ? Number(input.frames) : 1
      return dataUrl(premultipliedPreview(generateProcedural({ type: input.type, params: input.params, seed: input.seed, tint: input.tint, frames, size: frames > 1 ? 512 : 192 }).image))
    },
    async vfxTexUpdate(id, patch) {
      const t = find(id)
      if (patch.name?.trim()) t.name = patch.name.trim()
      if (typeof patch.description === 'string') t.description = patch.description
      if (patch.tags) t.tags = patch.tags
      t.updatedAt = Date.now()
      changed()
      return t
    },
    async vfxTexRate(id, rating) {
      const t = find(id)
      if (rating) t.rating = rating
      else delete t.rating
      changed()
      return t
    },
    async vfxTexDelete(id) {
      const i = items.findIndex((x) => x.id === id)
      if (i < 0) return false
      items.splice(i, 1)
      changed()
      return true
    },
    async vfxTexUpload(id) {
      const t = find(id)
      await delay(700)
      const assetId = String(18900000000 + Math.floor(Math.random() * 9e6))
      t.roblox = { assetId, uri: `rbxassetid://${assetId}`, uploadedAt: Date.now(), moderation: 'Reviewing' }
      changed()
      return t
    },
    async vfxTexCheck(id) {
      const t = find(id)
      await delay(300)
      if (t.roblox) t.roblox = { ...t.roblox, moderation: 'Approved', checkedAt: Date.now() }
      changed()
      return t
    },
    async vfxTexFile(id, which) {
      seed()
      const f = files.get(id)
      return f ? (which === 'preview' ? f.preview : f.texture) : null
    }
  }
}
