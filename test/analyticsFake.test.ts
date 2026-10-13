// Shared fakes for the analytics tests (a .test.ts name so it stays inside the analytics* test files;
// it contains one sanity test so node --test does not report it as empty).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FetchLike } from '../src/main/services/analytics/types.ts'

export interface FakeCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> }
type Route = { method: string; match: RegExp; replies: (Reply | ((call: FakeCall) => Reply))[] }

// fetch fake: routes match method + URL regex; each route replays its replies in order and repeats the
// last one. Unmatched requests return 599 so a test fails loudly.
export function fakeFetch() {
  const routes: Route[] = []
  const calls: FakeCall[] = []
  const fetch: FetchLike = async (url, init = {}) => {
    const call: FakeCall = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body }
    calls.push(call)
    const route = routes.find((r) => r.method === call.method && r.match.test(url))
    let reply: Reply = { status: 599, body: { message: `no fake route for ${call.method} ${url}` } }
    if (route) {
      const next = route.replies.length > 1 ? route.replies.shift()! : route.replies[0]
      reply = typeof next === 'function' ? next(call) : next
    }
    const status = reply.status ?? 200
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {})
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name: string) => reply.headers?.[name.toLowerCase()] ?? null },
      text: async () => text
    }
  }
  return {
    fetch,
    calls,
    on(method: string, match: RegExp, ...replies: Route['replies']) {
      routes.push({ method, match, replies })
      return this
    }
  }
}

// A deterministic clock whose sleep advances time.
export function fakeClock(start = Date.parse('2026-10-13T12:00:00Z')) {
  let now = start
  const sleeps: number[] = []
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      now += ms
    },
    advance: (ms: number) => (now += ms),
    sleeps
  }
}

// Daily API values payload.
export function apiValues(start: string, values: number[], breakdowns: { dimension: string; value: string; displayValue?: string }[] = []) {
  const t0 = Date.parse(start + 'T00:00:00Z')
  return { breakdowns, dataPoints: values.map((value, i) => ({ time: new Date(t0 + i * 86_400_000).toISOString(), value })) }
}

export function done(values: unknown[], path = 'v1/universes/1/operations/metrics/op1') {
  return { path, done: true, metadata: { createdTime: '2026-10-13T00:00:00Z' }, response: { values } }
}

test('fake fetch replays routes in order', async () => {
  const f = fakeFetch().on('GET', /x/, { body: { a: 1 } }, { body: { a: 2 } })
  assert.equal(await (await f.fetch('https://x')).text(), '{"a":1}')
  assert.equal(await (await f.fetch('https://x')).text(), '{"a":2}')
  assert.equal(await (await f.fetch('https://x')).text(), '{"a":2}')
  assert.equal((await f.fetch('https://y')).status, 599)
})
