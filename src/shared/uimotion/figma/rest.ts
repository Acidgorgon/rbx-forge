// Figma REST client for "paste a Figma link": the node JSON of one frame / component and PNG renders
// of the parts Forge cannot rebuild (icons, vectors, image fills). Only the main process runs it; the
// personal access token comes from the secret store and never reaches the renderer. fetch is
// injected (tests pass a fake). No node or electron imports.
//
// Endpoints (Figma REST API docs, https://developers.figma.com/docs/rest-api/, checked 2026-10):
//   Auth: personal access token in the X-Figma-Token header (Authentication page)
//   File endpoints, https://developers.figma.com/docs/rest-api/file-endpoints/ (scope file_content:read):
//     GET /v1/files/:key/nodes?ids=1:2,1:3   -> { name, nodes: { "1:2": { document, components, styles } | null } }
//     GET /v1/images/:key?ids=...&format=png&scale=2   -> { err, images: { "1:2": url | null } } (URLs expire after 30 days)
//     GET /v1/files/:key/images   -> { images | meta.images: { imageRef: url } } (URLs expire, <= 14 days)
//   Users endpoints, https://developers.figma.com/docs/rest-api/users-endpoints/: GET /v1/me (scope current_user:read)
//   Rate limits: 429 with a Retry-After header in seconds (https://developers.figma.com/docs/rest-api/rate-limits/)

import type { FigmaNode } from './types.ts'

export const FIGMA_API = 'https://api.figma.com'

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}>

export class FigmaRestError extends Error {
  readonly status: number
  readonly retryAfter: number | null
  constructor(message: string, status: number, retryAfter: number | null = null) {
    super(message)
    this.status = status
    this.retryAfter = retryAfter
  }
}

export interface FigmaLink {
  fileKey: string
  // Colon form ("1:2") as the API wants it; null when the link names no node.
  nodeId: string | null
  // Branch key when the link points into a branch (requests then use the branch key).
  branchKey?: string
  name?: string
}

// figma.com/file|design|proto|board/<key>/<name>?node-id=1-2 (dash or %3A colon), branch links
// (/design/<key>/branch/<branchKey>/...), and bare "<key>" / "<key> 1:2".
export function parseFigmaUrl(input: string): FigmaLink | null {
  const text = String(input ?? '').trim()
  if (!text) return null
  let url: URL | null = null
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    url = null
  }
  if (url && /(^|\.)figma\.com$/i.test(url.hostname)) {
    const parts = url.pathname.split('/').filter(Boolean)
    const at = parts.findIndex((p) => ['file', 'design', 'proto', 'board', 'make'].includes(p))
    if (at < 0 || !parts[at + 1]) return null
    const fileKey = parts[at + 1]
    if (!/^[A-Za-z0-9]{10,64}$/.test(fileKey)) return null
    let branchKey: string | undefined
    let nameAt = at + 2
    if (parts[at + 2] === 'branch' && parts[at + 3] && /^[A-Za-z0-9]{10,64}$/.test(parts[at + 3])) {
      branchKey = parts[at + 3]
      nameAt = at + 4
    }
    const raw = url.searchParams.get('node-id') ?? url.searchParams.get('starting-point-node-id')
    const nodeId = raw ? normalizeNodeId(raw) : null
    const name = parts[nameAt] ? decodeURIComponent(parts[nameAt]).replace(/-/g, ' ') : undefined
    return { fileKey, nodeId, ...(branchKey ? { branchKey } : {}), ...(name ? { name } : {}) }
  }
  const bare = /^([A-Za-z0-9]{10,64})(?:\s+([0-9]+[:-][0-9]+))?$/.exec(text)
  return bare ? { fileKey: bare[1], nodeId: bare[2] ? normalizeNodeId(bare[2]) : null } : null
}

// "1-2" (URL form) and "1%3A2" -> "1:2". Instance sublayers ("I1:2;3:4") are kept.
export function normalizeNodeId(raw: string): string | null {
  let id = raw
  try {
    id = decodeURIComponent(raw)
  } catch {
    id = raw
  }
  id = id.trim()
  if (/^[0-9]+-[0-9]+$/.test(id)) id = id.replace('-', ':')
  return /^I?[0-9]+:[0-9]+(;[0-9]+:[0-9]+)*$/.test(id) ? id : null
}

export interface FigmaNodesResult {
  name: string
  lastModified?: string
  document: FigmaNode
}

export interface FigmaRestOptions {
  token: string
  fetch: FetchLike
  base?: string
  // Max retries on 429 (each waits Retry-After, capped by maxWaitMs).
  retries?: number
  maxWaitMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  // Response cache lifetime (Figma rate limits are low on View / Collab seats).
  cacheMs?: number
}

interface CacheHit {
  at: number
  value: unknown
}

export class FigmaRest {
  private opts: Required<Omit<FigmaRestOptions, 'base'>> & { base: string }
  private cache = new Map<string, CacheHit>()

  constructor(opts: FigmaRestOptions) {
    if (!opts.token || !opts.token.trim()) throw new FigmaRestError('No Figma token: add one under Settings > Integrations > Figma.', 401)
    this.opts = {
      token: opts.token.trim(),
      fetch: opts.fetch,
      base: (opts.base ?? FIGMA_API).replace(/\/+$/, ''),
      retries: opts.retries ?? 1,
      maxWaitMs: opts.maxWaitMs ?? 15_000,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: opts.now ?? Date.now,
      cacheMs: opts.cacheMs ?? 5 * 60_000
    }
  }

  private async get(path: string, params: Record<string, string | number | undefined> = {}): Promise<unknown> {
    const q = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v)).replace(/%3A/gi, ':').replace(/%2C/gi, ',')}`)
      .join('&')
    const url = `${this.opts.base}${path}${q ? `?${q}` : ''}`
    const hit = this.cache.get(url)
    if (hit && this.opts.now() - hit.at < this.opts.cacheMs) return hit.value
    for (let attempt = 0; ; attempt++) {
      const res = await this.opts.fetch(url, { method: 'GET', headers: { 'X-Figma-Token': this.opts.token, Accept: 'application/json' } })
      if (res.ok) {
        const value = await res.json()
        this.cache.set(url, { at: this.opts.now(), value })
        return value
      }
      const retryAfter = Number(res.headers.get('retry-after'))
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null
      if (res.status === 429 && attempt < this.opts.retries && wait !== null && wait * 1000 <= this.opts.maxWaitMs) {
        await this.opts.sleep(wait * 1000)
        continue
      }
      let detail = ''
      try {
        const body = (await res.json()) as { err?: string; message?: string }
        detail = String(body?.err ?? body?.message ?? '')
      } catch {
        detail = ''
      }
      throw new FigmaRestError(errorMessage(res.status, detail, wait), res.status, wait)
    }
  }

  // The node's document subtree (one node). depth is left unset so the whole subtree comes back.
  async getNode(fileKey: string, nodeId: string): Promise<FigmaNodesResult> {
    const id = normalizeNodeId(nodeId)
    if (!id) throw new FigmaRestError(`"${nodeId}" is not a Figma node id`, 400)
    const body = (await this.get(`/v1/files/${encodeURIComponent(fileKey)}/nodes`, { ids: id })) as { name?: string; lastModified?: string; nodes?: Record<string, { document?: FigmaNode } | null> }
    const entry = body?.nodes?.[id]
    if (!entry || !entry.document) throw new FigmaRestError(`Node ${id} was not found in the file (deleted, or the link points at another file).`, 404)
    return { name: String(body.name ?? ''), ...(body.lastModified ? { lastModified: body.lastModified } : {}), document: entry.document }
  }

  // PNG renders of nodes (scale 0.01..4). Missing / failed renders come back null.
  async renderImages(fileKey: string, ids: string[], opts: { scale?: number; format?: 'png' | 'jpg' | 'svg' } = {}): Promise<Record<string, string | null>> {
    const list = [...new Set(ids.map((i) => normalizeNodeId(i)).filter((x): x is string => !!x))]
    if (!list.length) return {}
    const out: Record<string, string | null> = {}
    // Keep URLs short: chunks of 50 ids.
    for (let i = 0; i < list.length; i += 50) {
      const chunk = list.slice(i, i + 50)
      const body = (await this.get(`/v1/images/${encodeURIComponent(fileKey)}`, { ids: chunk.join(','), format: opts.format ?? 'png', scale: Math.max(0.01, Math.min(4, opts.scale ?? 2)) })) as { err?: string | null; images?: Record<string, string | null> }
      if (body?.err) throw new FigmaRestError(`Figma could not render images: ${body.err}`, 400)
      for (const id of chunk) out[id] = body?.images?.[id] ?? null
    }
    return out
  }

  // Download URLs of every image fill in the file, keyed by imageRef. The docs show
  // { images: {...} }; live responses nest it under meta.images, so both are read.
  async imageFills(fileKey: string): Promise<Record<string, string>> {
    const body = (await this.get(`/v1/files/${encodeURIComponent(fileKey)}/images`)) as { images?: Record<string, string>; meta?: { images?: Record<string, string> } }
    const map = body?.meta?.images ?? body?.images ?? {}
    return Object.fromEntries(Object.entries(map).filter(([, v]) => typeof v === 'string' && v))
  }

  // Bytes of a render / image-fill URL (S3 links: no token header).
  async download(url: string): Promise<Uint8Array> {
    if (!/^https:\/\//i.test(url)) throw new FigmaRestError('not an https image URL', 400)
    const res = await this.opts.fetch(url, { method: 'GET' })
    if (!res.ok) throw new FigmaRestError(`image download failed (HTTP ${res.status})`, res.status)
    return new Uint8Array(await res.arrayBuffer())
  }

  // GET /v1/me: checks a token (Settings > Integrations > Test). Needs current_user:read; a token
  // with only file_content:read gets 403 here even though imports work.
  async me(): Promise<{ handle: string; email?: string }> {
    const body = (await this.get('/v1/me')) as { handle?: string; email?: string }
    return { handle: String(body?.handle ?? ''), ...(body?.email ? { email: body.email } : {}) }
  }
}

export function errorMessage(status: number, detail: string, retryAfter: number | null): string {
  const d = detail ? ` (${detail})` : ''
  if (status === 400) return `Figma rejected the request${d}.`
  if (status === 401) return 'Figma token is missing or invalid: set a new one under Settings > Integrations > Figma.'
  if (status === 403) return `Figma refused access${d}: the token needs the file_content:read scope and access to this file (or it has expired).`
  if (status === 404) return `Figma file or node not found${d}: check the link and that the token's account can open the file.`
  if (status === 429) return `Figma rate limit reached${retryAfter ? `: try again in ${retryAfter < 120 ? `${Math.ceil(retryAfter)} s` : `${Math.ceil(retryAfter / 60)} min`}` : ''}. View / Collab seats get very few file reads per month; the Figma plugin (paste or download) has no limit.`
  if (status >= 500) return `Figma is having trouble (HTTP ${status}); try again in a minute.`
  return `Figma request failed (HTTP ${status})${d}.`
}
