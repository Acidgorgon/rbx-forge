import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  contentTypeFor,
  errorDetail,
  lookupUniverseId,
  OpenCloudError,
  parseRetryAfter,
  parseVersionNumber,
  publishPlace,
  publishUrl
} from '../src/main/services/release/openCloud.ts'
import {
  clampEmbed,
  EMBED_LIMITS,
  eventEmbed,
  isWebhookUrl,
  payload,
  postWebhook,
  redactWebhookUrl,
  releaseEmbed,
  retryAfterMs,
  WebhookError
} from '../src/main/services/release/discord.ts'
import { Notifier, defaultToggles, parseToggles } from '../src/main/services/release/notify.ts'
import { MemorySecretStore, createEncryptedSecretStore, readSecret, secretKey } from '../src/main/services/release/secrets.ts'
import type { FetchLike, ReleaseRecord } from '../src/main/services/release/types.ts'

interface Call {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
}

type Reply = { status: number; body?: string; headers?: Record<string, string> }

function fakeFetch(replies: Reply[] | ((call: Call) => Reply)): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  let i = 0
  const fetch: FetchLike = async (url, init = {}) => {
    const call = { url, ...init }
    calls.push(call)
    const reply = typeof replies === 'function' ? replies(call) : replies[Math.min(i++, replies.length - 1)]
    const headers = Object.fromEntries(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    return {
      status: reply.status,
      ok: reply.status >= 200 && reply.status < 300,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => reply.body ?? ''
    }
  }
  return { fetch, calls }
}

const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789_-ABCD'

// ---------------------------------------------------------------- Open Cloud

test('lookupUniverseId calls the public universe endpoint and reads universeId', async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: '{"universeId":13058}' }])
  assert.equal(await lookupUniverseId(1818, { fetch }), 13058)
  assert.equal(calls[0].url, 'https://apis.roblox.com/universes/v1/places/1818/universe')
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].headers?.['x-api-key'], undefined, 'no API key is sent to the public lookup')
})

test('lookupUniverseId retries once after 429 with Retry-After, and maps 404 / null', async () => {
  const waits: number[] = []
  const { fetch, calls } = fakeFetch([{ status: 429, headers: { 'Retry-After': '3' } }, { status: 200, body: '{"universeId":"42"}' }])
  assert.equal(await lookupUniverseId('7', { fetch, sleep: async (ms) => void waits.push(ms) }), 42)
  assert.equal(calls.length, 2)
  assert.deepEqual(waits, [3000])

  const missing = fakeFetch([{ status: 404, body: '{"errors":[{"code":0,"message":"Not Found"}]}' }])
  await assert.rejects(lookupUniverseId(1, { fetch: missing.fetch }), (e: OpenCloudError) => e.kind === 'not-found')
  const none = fakeFetch([{ status: 200, body: '{"universeId":null}' }])
  await assert.rejects(lookupUniverseId(1, { fetch: none.fetch }), (e: OpenCloudError) => e.kind === 'not-found')
  await assert.rejects(lookupUniverseId('abc', { fetch: none.fetch }), (e: OpenCloudError) => e.kind === 'invalid-input')
})

test('publishPlace sends the documented request shape', async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: '{"versionNumber":7}' }])
  const body = new Uint8Array([0x3c, 0x72, 0x6f, 0x62])
  const out = await publishPlace({ universeId: 456, placeId: '123', apiKey: ' key-abc ', versionType: 'Saved', body, format: 'rbxl', fetch })
  assert.deepEqual(out, { versionNumber: 7, versionType: 'Saved', placeId: 123, universeId: 456 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://apis.roblox.com/universes/v1/456/places/123/versions?versionType=Saved')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers?.['x-api-key'], 'key-abc')
  assert.equal(calls[0].headers?.['content-type'], 'application/octet-stream')
  assert.equal(calls[0].body, body, 'the place bytes are the request body')
  assert.equal(contentTypeFor('rbxlx'), 'application/xml')
  assert.equal(publishUrl(1, 2, 'Published'), 'https://apis.roblox.com/universes/v1/1/places/2/versions?versionType=Published')
})

test('publishPlace accepts a plain version number body too', async () => {
  assert.equal(parseVersionNumber('12'), 12)
  assert.equal(parseVersionNumber('"13"'), 13)
  assert.equal(parseVersionNumber('{"versionNumber":"14"}'), 14)
  assert.equal(parseVersionNumber('{}'), undefined)
  const { fetch } = fakeFetch([{ status: 200, body: '9' }])
  const out = await publishPlace({ universeId: 1, placeId: 2, apiKey: 'k', versionType: 'Published', body: new Uint8Array([1]), format: 'rbxlx', fetch })
  assert.equal(out.versionNumber, 9)
})

test('publishPlace maps 400/401/403/404/409/429/500 and never retries', async () => {
  const cases: [number, string, string | undefined][] = [
    [400, 'invalid-request', undefined],
    [401, 'unauthorized', undefined],
    [403, 'forbidden', undefined],
    [404, 'not-found', undefined],
    [409, 'conflict', undefined],
    [429, 'rate-limited', '12'],
    [500, 'server', undefined],
    [503, 'server', undefined]
  ]
  for (const [status, kind, retryAfter] of cases) {
    const { fetch, calls } = fakeFetch([{ status, body: JSON.stringify({ code: 'X', message: `msg ${status}` }), headers: retryAfter ? { 'retry-after': retryAfter } : {} }])
    await assert.rejects(
      publishPlace({ universeId: 1, placeId: 2, apiKey: 'k', versionType: 'Published', body: new Uint8Array([1]), format: 'rbxl', fetch }),
      (e: OpenCloudError) => {
        assert.equal(e.kind, kind, `status ${status}`)
        assert.equal(e.status, status)
        assert.match(e.message, new RegExp(`msg ${status}`))
        if (status === 429) assert.equal(e.retryAfterSeconds, 12)
        if (status === 403) assert.match(e.message, /universe-places:write/)
        return true
      }
    )
    assert.equal(calls.length, 1, `no retry for ${status}`)
  }
})

test('publishPlace validates input before any request', async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: '1' }])
  const base = { universeId: 1, placeId: 2, apiKey: 'k', versionType: 'Published' as const, body: new Uint8Array([1]), format: 'rbxl' as const, fetch }
  await assert.rejects(publishPlace({ ...base, apiKey: '  ' }), (e: OpenCloudError) => e.kind === 'invalid-input')
  await assert.rejects(publishPlace({ ...base, body: new Uint8Array() }), (e: OpenCloudError) => e.kind === 'invalid-input')
  await assert.rejects(publishPlace({ ...base, placeId: -1 }), (e: OpenCloudError) => e.kind === 'invalid-input')
  await assert.rejects(publishPlace({ ...base, versionType: 'Live' as never }), (e: OpenCloudError) => e.kind === 'invalid-input')
  assert.equal(calls.length, 0)
  const offline: FetchLike = async () => {
    throw new Error('ECONNRESET')
  }
  await assert.rejects(publishPlace({ ...base, fetch: offline }), (e: OpenCloudError) => e.kind === 'network')
})

test('errorDetail reads every documented v1/v2/gateway error shape', () => {
  assert.equal(errorDetail('{"errors":[{"code":0,"message":"Invalid API Key"}]}'), 'Invalid API Key')
  assert.equal(errorDetail('{"code":"PERMISSION_DENIED","message":"nope"}'), 'nope')
  assert.equal(errorDetail('{"error":"INVALID_ARGUMENT","message":"bad","errorDetails":[]}'), 'bad')
  assert.equal(errorDetail('{"type":"x","title":"One or more validation errors occurred.","status":400,"errors":{"placeId":["bad id"]}}'), 'bad id')
  assert.equal(errorDetail(''), undefined)
  assert.equal(parseRetryAfter('2.5'), 2.5)
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6)
})

// ---------------------------------------------------------------- Discord

test('webhook URL validation and redaction', () => {
  assert.ok(isWebhookUrl(WEBHOOK))
  assert.ok(isWebhookUrl('https://canary.discordapp.com/api/v10/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz'))
  assert.ok(!isWebhookUrl('http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz'))
  assert.ok(!isWebhookUrl('https://evil.example/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz'))
  assert.equal(redactWebhookUrl(WEBHOOK), 'https://discord.com/api/webhooks/123456789012345678/…')
})

const record: ReleaseRecord = {
  version: '1.3.0',
  tag: 'v1.3.0',
  mode: 'studio',
  at: Date.UTC(2026, 9, 13, 12),
  by: 'Alex',
  changelog: '### New\n- Shop @everyone',
  studioPublishPending: true,
  notified: false
}

test('release payload: rich embed, fields, ISO timestamp, mentions suppressed', () => {
  const body = payload([releaseEmbed(record, 'GenTree')])
  assert.equal(body.username, 'RBX Forge')
  assert.deepEqual(body.allowed_mentions, { parse: [] })
  assert.equal(body.embeds?.length, 1)
  const embed = body.embeds![0]
  assert.equal(embed.type, 'rich')
  assert.equal(embed.title, 'GenTree: Release v1.3.0')
  assert.equal(embed.description, record.changelog)
  assert.equal(embed.timestamp, '2026-10-13T12:00:00.000Z')
  assert.equal(typeof embed.color, 'number')
  assert.deepEqual(embed.fields?.map((f) => f.name), ['Version', 'Released by', 'Roblox'])
  assert.match(embed.fields![2].value, /pending/)
  const cloud = releaseEmbed({ ...record, mode: 'rojo', placeVersion: 8, versionType: 'Published', studioPublishPending: undefined })
  assert.equal(cloud.fields![2].value, 'Published place version 8')
})

test('clampEmbed enforces the documented limits', () => {
  const huge = clampEmbed({
    title: 't'.repeat(400),
    description: 'd'.repeat(5000),
    footer: { text: 'f'.repeat(3000) },
    fields: Array.from({ length: 30 }, (_, i) => ({ name: `n${i}`.repeat(200), value: 'v'.repeat(2000) }))
  })
  assert.equal(huge.title!.length, EMBED_LIMITS.title)
  assert.ok(huge.description!.length <= EMBED_LIMITS.description)
  assert.ok(huge.footer!.text.length <= EMBED_LIMITS.footer)
  assert.ok(huge.fields!.length <= EMBED_LIMITS.fields)
  for (const f of huge.fields!) {
    assert.ok(f.name.length <= EMBED_LIMITS.fieldName)
    assert.ok(f.value.length <= EMBED_LIMITS.fieldValue)
  }
  const total = huge.title!.length + huge.description!.length + huge.footer!.text.length + huge.fields!.reduce((n, f) => n + f.name.length + f.value.length, 0)
  assert.ok(total <= EMBED_LIMITS.total, `total ${total}`)
  assert.equal(payload(Array.from({ length: 12 }, () => ({ title: 'x' }))).embeds!.length, 10)
})

test('postWebhook posts JSON and honours 429 retry_after (seconds, float)', async () => {
  const waits: number[] = []
  const { fetch, calls } = fakeFetch([
    { status: 429, body: '{"message":"You are being rate limited.","retry_after":1.25,"global":false}', headers: { 'retry-after': '2' } },
    { status: 204 }
  ])
  await postWebhook(WEBHOOK, payload([releaseEmbed(record)]), { fetch, sleep: async (ms) => void waits.push(ms) })
  assert.equal(calls.length, 2)
  assert.deepEqual(waits, [1250], 'body retry_after wins over the header')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers?.['content-type'], 'application/json')
  const sent = JSON.parse(String(calls[0].body))
  assert.equal(sent.embeds[0].title, 'Release v1.3.0')
  assert.equal(retryAfterMs('', '3'), 3000)
  assert.equal(retryAfterMs('not json', null), 1000)
})

test('postWebhook gives up on repeated 429s, long waits, and marks 404 as gone', async () => {
  const limited = fakeFetch([{ status: 429, body: '{"retry_after":0.1}' }])
  await assert.rejects(postWebhook(WEBHOOK, payload([{ title: 'x' }]), { fetch: limited.fetch, sleep: async () => {}, retries: 2 }), (e: WebhookError) => e.status === 429)
  assert.equal(limited.calls.length, 3)
  const longWait = fakeFetch([{ status: 429, body: '{"retry_after":600}' }])
  await assert.rejects(postWebhook(WEBHOOK, payload([{ title: 'x' }]), { fetch: longWait.fetch, sleep: async () => assert.fail('should not wait') }), /rate limiting/)
  const gone = fakeFetch([{ status: 404, body: '{"message":"Unknown Webhook","code":10015}' }])
  await assert.rejects(postWebhook(WEBHOOK, payload([{ title: 'x' }]), { fetch: gone.fetch }), (e: WebhookError) => e.gone)
  const bad = fakeFetch([{ status: 400, body: '{"message":"Invalid Form Body"}' }])
  await assert.rejects(postWebhook(WEBHOOK, payload([{ title: 'x' }]), { fetch: bad.fetch }), /Invalid Form Body/)
  await assert.rejects(postWebhook('https://example.com/hook', payload([{ title: 'x' }]), { fetch: bad.fetch }), /not a Discord webhook/)
})

test('eventEmbed covers every notification kind', () => {
  assert.match(eventEmbed({ kind: 'sync', by: 'Sam', pulled: 2, pushed: 1, branch: 'main', subjects: ['a', 'b'] }).description!, /Shared 1 commit\.\nBrought in 2 commits/)
  assert.equal(eventEmbed({ kind: 'push', by: 'Sam', branch: 'main', commits: 3 }).title, 'Sam pushed 3 commits to main')
  const failure = eventEmbed({ kind: 'test-failure', scenario: 'Buy a sword', summary: 'Shop never opened', by: 'Sam', details: 'stack' })
  assert.equal(failure.title, 'Test failed: Buy a sword')
  assert.equal(failure.fields![1].name, 'Details')
  assert.match(eventEmbed({ kind: 'publish', version: 'v1.0.0', by: 'Sam', studio: true }).description!, /from Studio/)
})

// ---------------------------------------------------------------- notifier and secrets

test('Notifier respects toggles, quiet syncs, throttling and missing webhook', async () => {
  const root = '/games/gentree'
  const secrets = new MemorySecretStore()
  const { fetch, calls } = fakeFetch([{ status: 204 }])
  let now = 1_000_000
  const toggles = { ...defaultToggles(), sync: true }
  const notifier = new Notifier({ root, secrets, toggles: () => toggles, game: () => 'GenTree', post: { fetch }, now: () => now })
  assert.deepEqual(await notifier.notify({ kind: 'test-failure', scenario: 's', summary: 'x', by: 'a' }), { sent: false, skipped: 'No Discord webhook set' })
  await secrets.set(secretKey('discordWebhook', root), WEBHOOK)
  assert.equal((await notifier.notify({ kind: 'push', by: 'a', branch: 'main', commits: 1 })).skipped, 'push notifications are off')
  assert.equal((await notifier.notify({ kind: 'sync', by: 'a', pulled: 0, pushed: 0 })).skipped, 'Nothing moved')
  assert.deepEqual(await notifier.notify({ kind: 'sync', by: 'a', pulled: 1, pushed: 0 }), { sent: true })
  assert.equal((await notifier.notify({ kind: 'sync', by: 'a', pulled: 1, pushed: 0 })).skipped, 'Throttled')
  now += 121_000
  assert.deepEqual(await notifier.notify({ kind: 'sync', by: 'a', pulled: 0, pushed: 2 }), { sent: true })
  assert.deepEqual(await notifier.notify({ kind: 'release', record }), { sent: true })
  assert.equal(calls.length, 3)
  assert.equal(JSON.parse(String(calls[2].body)).embeds[0].title, 'GenTree: Release v1.3.0')
})

test('Notifier reports a deleted webhook', async () => {
  const root = '/g'
  const secrets = new MemorySecretStore()
  await secrets.set(secretKey('discordWebhook'), WEBHOOK)
  let gone = false
  const { fetch } = fakeFetch([{ status: 404 }])
  const notifier = new Notifier({ root, secrets, toggles: defaultToggles, post: { fetch }, onWebhookGone: () => (gone = true) })
  const result = await notifier.notify({ kind: 'release', record })
  assert.equal(result.sent, false)
  assert.match(result.error!, /no longer exists/)
  assert.ok(gone)
})

test('toggle schema defaults and parsing', () => {
  assert.deepEqual(defaultToggles(), { release: true, publish: true, sync: false, push: false, 'test-failure': true })
  assert.deepEqual(parseToggles({ sync: true }), { ...defaultToggles(), sync: true })
  assert.deepEqual(parseToggles({ sync: 'yes' }), defaultToggles())
})

test('secret store: project scope falls back to global; encrypted store never writes plain text', async () => {
  const store = new MemorySecretStore()
  await store.set(secretKey('openCloudApiKey'), 'global-key')
  assert.equal(await readSecret(store, 'openCloudApiKey', '/a'), 'global-key')
  await store.set(secretKey('openCloudApiKey', '/a'), 'project-key')
  assert.equal(await readSecret(store, 'openCloudApiKey', '/a'), 'project-key')
  assert.ok(!secretKey('openCloudApiKey', '/home/me/secret-game').includes('secret-game'))

  const kv = new Map<string, unknown>()
  const settings = { get: <T>(k: string, f: T) => (kv.has(k) ? (kv.get(k) as T) : f), set: (k: string, v: unknown) => void kv.set(k, v) }
  const safe = {
    available: true,
    isEncryptionAvailable() {
      return this.available
    },
    encryptString: (s: string) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)),
    decryptString: (b: Buffer) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString()
  }
  const encrypted = createEncryptedSecretStore(safe, settings)
  await encrypted.set('k', 'hunter2-webhook')
  assert.ok(!JSON.stringify([...kv]).includes('hunter2'))
  assert.equal(await encrypted.get('k'), 'hunter2-webhook')
  await encrypted.delete('k')
  assert.equal(await encrypted.get('k'), undefined)
  safe.available = false
  await assert.rejects(encrypted.set('k', 'v'), /cannot encrypt/)
})
