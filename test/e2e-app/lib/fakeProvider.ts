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
  toolNames: string[]
  // Role of the last message ('tool' when the app sent back a tool result) and that result's text.
  lastRole: string
  lastTool: string
}

// A rule answers with text, or with one tool call (the app runs it and calls again with the result).
export type FakeReply = string | { tool: string; args: Record<string, unknown> }

export interface FakeRule {
  name: string
  match: (r: FakeRequest) => boolean
  reply: (r: FakeRequest) => FakeReply
}

export const FAKE_MODEL = 'fake-forge-model'

// Flows that need a write attempt put this marker in their message.
export const WRITE_MARKER = 'E2E-WRITE'

export const DEFAULT_RULES: FakeRule[] = [
  {
    // First round: try to write a script; second round: echo what the app answered.
    name: 'write-attempt',
    match: (r) => r.user.includes(WRITE_MARKER),
    reply: (r) =>
      r.lastRole === 'tool'
        ? `FAKE-TOOL-RESULT: ${r.lastTool.slice(0, 300)}`
        : { tool: r.toolNames.find((n) => /(^|__)write_script$/.test(n)) ?? 'write_script', args: { path: 'src/server/Features/Inventory/InventoryService.luau', contents: '-- overwritten by the fake model\nreturn {}\n' } }
  },
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
  // Reported in usage.cost (USD, OpenRouter style) on every answer; 0 = not reported.
  costUsd: number
  requests: (FakeRequest & { rule: string })[]
  rules: FakeRule[]
  close(): Promise<void>
}

export async function startFakeProvider(rules: FakeRule[] = DEFAULT_RULES): Promise<FakeProvider> {
  const requests: (FakeRequest & { rule: string })[] = []
  const state = { costUsd: 0 }
  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? ''
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: FAKE_MODEL, object: 'model' }] }))
      return
    }
    if (req.method === 'POST' && url.endsWith('/chat/completions')) {
      let parsed: { model?: string; stream?: boolean; tools?: { function?: { name?: string } }[]; messages?: { role: string; content: unknown }[] } = {}
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
        tools: parsed.tools?.length ?? 0,
        toolNames: (parsed.tools ?? []).map((t) => String(t.function?.name ?? '')),
        lastRole: messages.at(-1)?.role ?? '',
        lastTool: messages.at(-1)?.role === 'tool' ? text(messages.at(-1)?.content) : ''
      }
      const rule = rules.find((x) => x.match(r)) ?? DEFAULT_RULES[DEFAULT_RULES.length - 1]
      requests.push({ ...r, rule: rule.name })
      const reply = rule.reply(r)
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, ...(state.costUsd ? { cost: state.costUsd } : {}) }
      const call = typeof reply === 'string' ? null : { id: `call_${requests.length}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }
      const content = typeof reply === 'string' ? reply : null
      const finish = call ? 'tool_calls' : 'stop'
      if (r.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const chunk = (delta: object, fin: string | null) =>
          `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', model: r.model, choices: [{ index: 0, delta, finish_reason: fin }] })}\n\n`
        res.write(chunk(call ? { role: 'assistant', content: null, tool_calls: [{ index: 0, ...call }] } : { role: 'assistant', content }, null))
        res.write(chunk({}, finish))
        res.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', choices: [], usage })}\n\n`)
        res.end('data: [DONE]\n\n')
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', model: r.model, choices: [{ index: 0, message: { role: 'assistant', content, ...(call ? { tool_calls: [call] } : {}) }, finish_reason: finish }], usage }))
      }
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":{"message":"not found"}}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    get costUsd() {
      return state.costUsd
    },
    set costUsd(v: number) {
      state.costUsd = v
    },
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    rules,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
