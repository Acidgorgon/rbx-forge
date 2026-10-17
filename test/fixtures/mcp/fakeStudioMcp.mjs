// A fake Roblox Studio MCP server (stdio, newline-delimited JSON-RPC) for test/studioMcp.test.ts.
//   node fakeStudioMcp.mjs              answers initialize, tools/list (two pages) and tools/call
//   node fakeStudioMcp.mjs --fail       prints an error on stderr and exits before answering
//   node fakeStudioMcp.mjs --log FILE   appends every request method to FILE
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
if (argv.includes('--fail')) {
  process.stderr.write('Studio MCP server is disabled in Roblox Studio\n')
  process.exit(3)
}
const logAt = argv.indexOf('--log')
const logFile = logAt >= 0 ? argv[logAt + 1] : null
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const page1 = [
  { name: 'execute_luau', description: 'Run Luau in Studio', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { studio_id: { type: 'string' }, datamodel_type: { type: 'string', enum: ['Edit', 'Server', 'Client'] }, code: { type: 'string' } }, required: ['code'] } },
  { name: 'start_stop_play', description: 'Start or stop a playtest', inputSchema: { type: 'object', properties: { studio_id: { type: 'string' } } } }
]
const page2 = [
  { name: 'list_roblox_studios', description: 'List open Studios', inputSchema: { type: 'object' } },
  { name: 'screen_capture', description: 'Capture the viewport', inputSchema: { type: 'object', properties: {} } }
]
let pinged = false
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const m = JSON.parse(line)
  if (logFile && m.method) appendFileSync(logFile, m.method + '\n')
  // The client's answer to our ping.
  if (m.id === 'srv-ping') return
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'FakeStudioMCP', version: '1.0' } } })
  if (m.method === 'tools/list') {
    // A server-to-client request and a notification in between, as real servers send.
    if (!pinged) {
      pinged = true
      send({ jsonrpc: '2.0', id: 'srv-ping', method: 'ping' })
      send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hello' } })
    }
    return send({ jsonrpc: '2.0', id: m.id, result: m.params?.cursor === 'p2' ? { tools: page2 } : { tools: page1, nextCursor: 'p2' } })
  }
  if (m.method === 'tools/call') {
    const { name, arguments: args = {} } = m.params
    if (name === 'list_roblox_studios') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'studio_id abc: MyGame (PlaceId 42)' }] } })
    if (name === 'execute_luau') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `ran ${args.code} in ${args.datamodel_type ?? 'Edit'}` }] } })
    if (name === 'screen_capture') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] } })
    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `no such tool ${name}` }], isError: true } })
  }
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } })
})
