import { z } from 'zod'
import { eventEmbed, payload, postWebhook, WebhookError, type PostOptions } from './discord.ts'
import { readSecret } from './secrets.ts'
import type { NotificationToggles, NotifyEvent, NotifyEventKind, NotifyResult, SecretStore } from './types.ts'

// Team notifications to Discord. One notify(event) entry point; each event kind has a per-user toggle.
// Releases are on by default; chatty kinds (sync, push) are off until someone turns them on.

export const NotificationTogglesSchema = z.object({
  release: z.boolean().default(true),
  publish: z.boolean().default(true),
  sync: z.boolean().default(false),
  push: z.boolean().default(false),
  'test-failure': z.boolean().default(true)
})

export function defaultToggles(): NotificationToggles {
  return NotificationTogglesSchema.parse({})
}

export function parseToggles(value: unknown): NotificationToggles {
  const parsed = NotificationTogglesSchema.safeParse(value ?? {})
  return parsed.success ? parsed.data : defaultToggles()
}

export interface NotifierOptions {
  root: string
  secrets: SecretStore
  toggles: () => NotificationToggles
  // Shown in embed titles, e.g. the Rojo project name.
  game?: () => string | undefined
  post?: PostOptions
  // Minimum gap between two posts of the same chatty kind (sync, push), default 2 minutes.
  throttleMs?: number
  now?: () => number
  log?: (text: string) => void
  // Called when Discord says the webhook is gone, so the UI can ask for a new one.
  onWebhookGone?: () => void
}

const THROTTLED: NotifyEventKind[] = ['sync', 'push']

export class Notifier {
  private options: NotifierOptions
  private last = new Map<NotifyEventKind, number>()

  constructor(options: NotifierOptions) {
    this.options = options
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  async notify(event: NotifyEvent): Promise<NotifyResult> {
    const toggles = this.options.toggles()
    if (!toggles[event.kind]) return { sent: false, skipped: `${event.kind} notifications are off` }
    if (event.kind === 'sync' && event.pulled === 0 && event.pushed === 0) return { sent: false, skipped: 'Nothing moved' }
    if (event.kind === 'push' && event.commits === 0) return { sent: false, skipped: 'Nothing pushed' }
    const throttle = this.options.throttleMs ?? 120_000
    const previous = this.last.get(event.kind)
    if (THROTTLED.includes(event.kind) && previous !== undefined && this.now() - previous < throttle) return { sent: false, skipped: 'Throttled' }
    const url = await readSecret(this.options.secrets, 'discordWebhook', this.options.root)
    if (!url) return { sent: false, skipped: 'No Discord webhook set' }
    const game = 'game' in event && event.game ? event.game : this.options.game?.()
    const withGame = { ...event, game } as NotifyEvent
    try {
      await postWebhook(url, payload([eventEmbed(withGame, this.now())]), this.options.post)
      this.last.set(event.kind, this.now())
      return { sent: true }
    } catch (error) {
      if (error instanceof WebhookError && error.gone) this.options.onWebhookGone?.()
      const message = error instanceof Error ? error.message : String(error)
      this.options.log?.(`Discord notification failed: ${message}`)
      return { sent: false, error: message }
    }
  }

  // Sends a sample message so the person can check the webhook from the settings UI. Ignores toggles.
  async test(by: string): Promise<NotifyResult> {
    const url = await readSecret(this.options.secrets, 'discordWebhook', this.options.root)
    if (!url) return { sent: false, skipped: 'No Discord webhook set' }
    try {
      await postWebhook(url, payload([{ title: 'RBX Forge is connected', description: `${by} connected this channel to ${this.options.game?.() ?? 'the game'}'s releases.`, color: 0x5865f2 }]), this.options.post)
      return { sent: true }
    } catch (error) {
      return { sent: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
