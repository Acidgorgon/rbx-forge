import type { FetchLike, NotifyEvent, ReleaseRecord, Sleep } from './types.ts'

// Discord webhooks. Verified against the official docs (docs.discord.com, October 2026):
//  - Execute Webhook: POST /webhooks/{webhook.id}/{webhook.token}; JSON params content (≤2000 chars),
//    username, avatar_url, embeds (≤10), allowed_mentions; at least one of content/embeds/components/
//    file/poll. Without ?wait=true the response is 204 No Content.
//    https://docs.discord.com/developers/resources/webhook#execute-webhook
//  - Embed limits: title 256, description 4096, ≤25 fields, field.name 256, field.value 1024,
//    footer.text 2048, author.name 256, 6000 characters across all embeds of a message; color is an
//    integer, timestamp ISO8601; webhook embeds are type "rich". allowed_mentions {parse: []} suppresses
//    all mentions. https://docs.discord.com/developers/resources/message#embed-object
//  - Rate limits: a 429 body has message, retry_after (float seconds), global, optional code; also the
//    Retry-After header. "If a webhook returns a 404 status you should not attempt to use it again."
//    https://docs.discord.com/developers/topics/rate-limits

export const EMBED_LIMITS = {
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  author: 256,
  total: 6000,
  embedsPerMessage: 10,
  content: 2000
} as const

export const COLORS = {
  release: 0x3ba55c,
  publish: 0x5865f2,
  pending: 0xfaa61a,
  sync: 0x4f9dde,
  push: 0x9b59b6,
  failure: 0xed4245
} as const

export interface EmbedField {
  name: string
  value: string
  inline?: boolean
}

export interface DiscordEmbed {
  type?: 'rich'
  title?: string
  description?: string
  url?: string
  timestamp?: string
  color?: number
  footer?: { text: string }
  author?: { name: string }
  fields?: EmbedField[]
}

export interface WebhookPayload {
  content?: string
  username?: string
  avatar_url?: string
  embeds?: DiscordEmbed[]
  allowed_mentions: { parse: string[] }
}

const WEBHOOK_URL = /^https:\/\/(?:(?:ptb|canary)\.)?(?:discord\.com|discordapp\.com)\/api(?:\/v\d+)?\/webhooks\/(\d{15,25})\/([A-Za-z0-9._-]{20,})\/?$/

export function isWebhookUrl(value: string): boolean {
  return WEBHOOK_URL.test(value.trim())
}

// For logs and the UI: never show the token part.
export function redactWebhookUrl(value: string): string {
  const match = WEBHOOK_URL.exec(value.trim())
  return match ? `https://discord.com/api/webhooks/${match[1]}/…` : '(invalid webhook URL)'
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - 1)) + '…'
}

function embedLength(embed: DiscordEmbed): number {
  let n = (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.footer?.text.length ?? 0) + (embed.author?.name.length ?? 0)
  for (const field of embed.fields ?? []) n += field.name.length + field.value.length
  return n
}

// Applies every per-field limit, then trims the description (and drops trailing fields) until the
// whole message fits the 6000-character total.
export function clampEmbed(embed: DiscordEmbed): DiscordEmbed {
  const out: DiscordEmbed = { ...embed, type: 'rich' }
  if (out.title !== undefined) out.title = truncate(out.title, EMBED_LIMITS.title)
  if (out.description !== undefined) out.description = truncate(out.description, EMBED_LIMITS.description)
  if (out.footer) out.footer = { text: truncate(out.footer.text, EMBED_LIMITS.footer) }
  if (out.author) out.author = { name: truncate(out.author.name, EMBED_LIMITS.author) }
  if (out.fields) {
    out.fields = out.fields
      .filter((f) => f.name.trim() && f.value.trim())
      .slice(0, EMBED_LIMITS.fields)
      .map((f) => ({ name: truncate(f.name, EMBED_LIMITS.fieldName), value: truncate(f.value, EMBED_LIMITS.fieldValue), ...(f.inline ? { inline: true } : {}) }))
  }
  let over = embedLength(out) - EMBED_LIMITS.total
  if (over > 0 && out.description) {
    out.description = truncate(out.description, Math.max(0, out.description.length - over))
    over = embedLength(out) - EMBED_LIMITS.total
  }
  while (over > 0 && out.fields?.length) {
    out.fields.pop()
    over = embedLength(out) - EMBED_LIMITS.total
  }
  return out
}

export function payload(embeds: DiscordEmbed[], username = 'RBX Forge'): WebhookPayload {
  return {
    username,
    embeds: embeds.slice(0, EMBED_LIMITS.embedsPerMessage).map(clampEmbed),
    // Commit subjects and changelogs are user text: never let them ping @everyone or roles.
    allowed_mentions: { parse: [] }
  }
}

function bulletList(lines: string[], max: number): string {
  const shown = lines.slice(0, max).map((l) => `• ${l}`)
  if (lines.length > max) shown.push(`…and ${lines.length - max} more`)
  return shown.join('\n')
}

function title(game: string | undefined, text: string): string {
  return game ? `${game}: ${text}` : text
}

export function releaseEmbed(record: ReleaseRecord, game?: string): DiscordEmbed {
  const fields: EmbedField[] = [
    { name: 'Version', value: record.version, inline: true },
    { name: 'Released by', value: record.by || 'unknown', inline: true }
  ]
  if (record.mode === 'studio') {
    fields.push({ name: 'Roblox', value: record.studioPublishPending === false ? 'Published from Studio' : 'Publishing from Studio (pending)', inline: true })
  } else if (record.placeVersion !== undefined) {
    fields.push({ name: 'Roblox', value: `${record.versionType === 'Saved' ? 'Saved' : 'Published'} place version ${record.placeVersion}`, inline: true })
  }
  return {
    title: title(game, `Release ${record.tag}`),
    description: record.changelog.trim() || '_No changes listed._',
    color: record.mode === 'studio' && record.studioPublishPending !== false ? COLORS.pending : COLORS.release,
    timestamp: new Date(record.at).toISOString(),
    fields,
    footer: { text: `RBX Forge · ${record.mode === 'rojo' ? 'Rojo build via Open Cloud' : record.mode === 'file' ? 'Exported place via Open Cloud' : 'Studio publish'}` }
  }
}

export function eventEmbed(event: NotifyEvent, now = Date.now()): DiscordEmbed {
  const timestamp = new Date(now).toISOString()
  switch (event.kind) {
    case 'release':
      return releaseEmbed(event.record, event.game)
    case 'publish':
      return {
        title: title(event.game, `${event.version} is live on Roblox`),
        description: event.studio ? `${event.by} published from Studio.` : `${event.by} published place version ${event.placeVersion ?? '?'}.`,
        color: COLORS.publish,
        timestamp,
        fields: event.placeId ? [{ name: 'Place', value: String(event.placeId), inline: true }] : undefined
      }
    case 'sync':
      return {
        title: title(event.game, `${event.by} synced${event.branch ? ` ${event.branch}` : ''}`),
        description: [
          event.pushed ? `Shared ${event.pushed} commit${event.pushed === 1 ? '' : 's'}.` : '',
          event.pulled ? `Brought in ${event.pulled} commit${event.pulled === 1 ? '' : 's'} from teammates.` : '',
          event.subjects?.length ? bulletList(event.subjects, 10) : ''
        ]
          .filter(Boolean)
          .join('\n'),
        color: COLORS.sync,
        timestamp
      }
    case 'push':
      return {
        title: title(event.game, `${event.by} pushed ${event.commits} commit${event.commits === 1 ? '' : 's'} to ${event.branch}`),
        description: event.subjects?.length ? bulletList(event.subjects, 10) : undefined,
        color: COLORS.push,
        timestamp
      }
    case 'test-failure':
      return {
        title: title(event.game, `Test failed: ${event.scenario}`),
        description: event.summary,
        color: COLORS.failure,
        timestamp,
        fields: [
          { name: 'Run by', value: event.by, inline: true },
          ...(event.details ? [{ name: 'Details', value: '```\n' + truncate(event.details, EMBED_LIMITS.fieldValue - 8) + '\n```' }] : [])
        ]
      }
  }
}

export class WebhookError extends Error {
  readonly status?: number
  // 404/401: the webhook was deleted or the URL is wrong; stop using it (per Discord's docs).
  readonly gone: boolean
  constructor(message: string, status?: number, gone = false) {
    super(message)
    this.name = 'WebhookError'
    this.status = status
    this.gone = gone
  }
}

export interface PostOptions {
  fetch?: FetchLike
  sleep?: Sleep
  // Attempts after 429s (default 3). Waits longer than maxWaitMs fail instead of blocking.
  retries?: number
  maxWaitMs?: number
}

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// retry_after (float seconds) from the body, else the Retry-After header, else 1 s.
export function retryAfterMs(body: string, header: string | null): number {
  try {
    const json = JSON.parse(body) as { retry_after?: unknown }
    if (typeof json.retry_after === 'number' && json.retry_after >= 0) return Math.ceil(json.retry_after * 1000)
  } catch {
    // fall through
  }
  const seconds = header ? Number(header) : NaN
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : 1000
}

export async function postWebhook(url: string, body: WebhookPayload, options: PostOptions = {}): Promise<void> {
  if (!isWebhookUrl(url)) throw new WebhookError('That is not a Discord webhook URL (https://discord.com/api/webhooks/…)')
  const fetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike)
  const sleep = options.sleep ?? defaultSleep
  const maxWait = options.maxWaitMs ?? 60_000
  let retries = options.retries ?? 3
  const json = JSON.stringify(body)
  for (;;) {
    let response: Awaited<ReturnType<FetchLike>>
    try {
      response = await fetch(url.trim(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: json })
    } catch (error) {
      throw new WebhookError(`Could not reach Discord: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (response.ok) return
    const text = await response.text().catch(() => '')
    if (response.status === 429) {
      const wait = retryAfterMs(text, response.headers.get('retry-after'))
      if (retries > 0 && wait <= maxWait) {
        retries--
        await sleep(wait)
        continue
      }
      throw new WebhookError(`Discord is rate limiting this webhook; retry in ${Math.ceil(wait / 1000)} s`, 429)
    }
    if (response.status === 404 || response.status === 401) throw new WebhookError('Discord says this webhook no longer exists. Paste a new webhook URL.', response.status, true)
    let detail = ''
    try {
      const parsed = JSON.parse(text) as { message?: string }
      if (parsed.message) detail = `: ${parsed.message}`
    } catch {
      // ignore
    }
    throw new WebhookError(`Discord rejected the message (${response.status})${detail}`, response.status)
  }
}
