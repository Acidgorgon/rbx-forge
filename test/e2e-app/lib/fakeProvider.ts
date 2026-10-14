// A tiny OpenAI-compatible server (GET /models, POST /chat/completions) for the click-through suite.
// The app's "Custom (OpenAI-compatible)" provider is pointed at it, so chat, restate and the labs'
// model calls run end to end without real keys. Answers are canned and chosen by a list of rules
// (first match on the system + last user message wins); add a rule to cover a new flow.

import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeRequest {
  model: string
  system: string
  user: string
  stream: boolean
  tools: number
}

export interface FakeRule {
  name: string
  match: (r: FakeRequest) => boolean
  reply: (r: FakeRequest) => string
}

export const FAKE_MODEL = 'fake-forge-model'

export const DEFAULT_RULES: FakeRule[] = [
  {
    name: 'restate',
    match: (r) => /You restate/i.test(r.system),
    reply: () =>
      JSON.stringify({
        goal: 'FAKE-RESTATE goal: an inventory system with stacking, drag and drop and persistence.',
        problem: 'FAKE-RESTATE problem: players lose items between sessions.',
        assumptions: ['Uses the existing Inventory feature folder', 'DataStore for persistence']
      })
  },
  { name: 'title', match: (r) => /title/i.test(r.system) && r.user.length < 2000 && !r.tools, reply: () => 'Fake chat title' },
  { name: 'default', match: () => true, reply: (r) => `FAKE-REPLY: ok (${r.user.slice(0, 40).replace(/\s+/g, ' ')})` }
]

function text(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('\n')
  return ''
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export interface FakeProvider {
  baseUrl: string
  requests: (FakeRequest & { rule: string })[]
  rules: FakeRule[]
  close(): Promise<void>
}

export async function startFakeProvider(rules: FakeRule[] = DEFAULT_RULES): Promise<FakeProvider> {
  const requests: (FakeRequest & { rule: string })[] = []
  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? ''
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: FAKE_MODEL, object: 'model' }] }))
      return
    }
    if (req.method === 'POST' && url.endsWith('/chat/completions')) {
      let parsed: { model?: string; stream?: boolean; tools?: unknown[]; messages?: { role: string; content: unknown }[] } = {}
      try {
        parsed = JSON.parse(await body(req))
      } catch {
        res.writeHead(400).end('{"error":{"message":"bad json"}}')
        return
      }
      const messages = parsed.messages ?? []
      const r: FakeRequest = {
        model: parsed.model ?? '',
        system: messages.filter((m) => m.role === 'system').map((m) => text(m.content)).join('\n'),
        user: text([...messages].reverse().find((m) => m.role === 'user')?.content),
        stream: parsed.stream === true,
        tools: parsed.tools?.length ?? 0
      }
      const rule = rules.find((x) => x.match(r)) ?? DEFAULT_RULES[DEFAULT_RULES.length - 1]
      requests.push({ ...r, rule: rule.name })
      const content = rule.reply(r)
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      if (r.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', model: r.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        res.write(chunk({ role: 'assistant', content }, null))
        res.write(chunk({}, 'stop'))
        res.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', choices: [], usage })}\n\n`)
        res.end('data: [DONE]\n\n')
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', model: r.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage }))
      }
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":{"message":"not found"}}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    rules,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
