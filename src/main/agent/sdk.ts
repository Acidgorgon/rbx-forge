// Shared pieces for building Agent SDK queries: settings, the system prompt, Studio MCP config,
// and mapping SDK messages to ChatMessages.

import { randomUUID } from 'node:crypto'
import type { McpStdioServerConfig, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatMessage } from '@shared/types'
import type { HarnessContext } from '../context.ts'
import { bundledClaudeExecutable } from '../services/sdkBinary.ts'
import { extractImageMarkers, imageMarker } from './chatImages.ts'

export const DEFAULT_MODEL = 'claude-opus-5-5'
export const STUDIO_SERVER = 'studio'

// The query function, injectable for tests. Defaults to the SDK's query(), loaded lazily.
// A prompt with images uses the SDK's streaming input (an iterable of SDKUserMessage).
export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>

export const sdkQuery: QueryFn = (params) => {
  // Lazy import keeps the SDK out of module load for code paths that never query.
  const iter = async function* () {
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    yield* query(params)
  }
  return iter()
}

// Packaged builds: the SDK's CLI binary is unpacked outside app.asar (see services/sdkBinary.ts).
export function executableOption(): Pick<Options, 'pathToClaudeCodeExecutable'> {
  const exe = bundledClaudeExecutable()
  return exe ? { pathToClaudeCodeExecutable: exe } : {}
}

export interface StudioMcpSetting {
  command: string
  args: string[]
}

export function model(ctx: HarnessContext): string {
  return ctx.getSetting<string>('model', DEFAULT_MODEL) || DEFAULT_MODEL
}

// Roblox Studio's MCP server (external stdio process), when the user configured one.
export function studioMcp(ctx: HarnessContext): McpStdioServerConfig | null {
  const s = ctx.getSetting<StudioMcpSetting | null>('studioMcp', null)
  if (!s || typeof s.command !== 'string' || !s.command.trim()) return null
  return { type: 'stdio', command: s.command, args: Array.isArray(s.args) ? s.args : [] }
}

// Allow rules for every tool of an MCP server. Claude Code permission rules accept the bare
// server name ("mcp__server") as "all tools from this server"; the SDK docs also list
// "mcp__server__*" as a server-level spec, so both are given.
export function allowServer(server: string): string[] {
  return [`mcp__${server}`, `mcp__${server}__*`]
}

export const SYSTEM_PROMPT = `You are the coding assistant inside the GenTree dev harness for a Roblox game built with Rojo.

Project layout (Rojo, see default.project.json):
- src/shared -> ReplicatedStorage.Shared; src/server -> ServerScriptService.Server; src/client -> StarterPlayer.StarterPlayerScripts.Client; src/ServerStorage -> ServerStorage. Packages/ -> ReplicatedStorage.Packages (Wally; never edit).
- Features: src/shared/Features/<Name> holds the shared config for a feature. src/server/Features/<Name> is its server Service. src/client/Client/Controllers/<Name>Controller is its client Controller. Creating the shared folder (new_feature) makes the ./dev watcher scaffold the Service and Controller; deleting it removes them. Server-only Features live only in src/server/Features.
- ModuleLoader requires every Service/Controller, calls module:Init(janitor) on all, then module:Start() on all. Put cross-module wiring in Start, not Init.
- Networking uses Blink: events are declared in events.blink at the repo root; ./dev regenerates src/shared/events/client.luau and server.luau from it, so edit events.blink, never those generated files.
- Scripts are Luau (.luau). *.server.luau = Script, *.client.luau = LocalScript, others = ModuleScript; init.luau makes the folder the script.

Working rules:
- Prefer the gentree tools (mcp__gentree__*); they are cheaper than generic file tools. Orient with project_map (or project_overview); locate code with find_symbol / search_code (explorer_tree / find_instance for instances); read only the line ranges you need with read_script from/to; edit_script for small changes, write_script for new files.
- Networking: blink_events lists events, add_blink_event adds one (compile-checked), blink_check validates events.blink. Packages: wally_search / wally_info, add_wally_package. Rename a feature only with rename_feature (it moves the shared, server and client parts together).
- Test logic headless first: run_tests (Lune, seconds, no Studio) after changing a module, create_spec for untested modules.
- For questions about how the game is doing (players, retention, revenue, acquisition), call analytics_overview first, then drill down with analytics_series / acquisition_report.
- Users paste Roblox paths like game.ReplicatedStorage.Assets.Sword or game:GetService("Workspace").Map; resolve them with find_instance or explorer_tree. Nodes marked * exist only in Studio (assets, models, sounds, GUIs), not in the repo.
- Never edit Packages/ or generated files. Keep edits minimal and in the existing style.
- Studio edits sync back into the repo via studio-sync; conflicts are listed by studio_conflicts.
- If mcp__studio__* tools are available they act on the live Roblox Studio (run Luau, play tests).
- A message may end with [Confirmed restatement ...]: Forge restated a big request and the user approved (or corrected) that reading. Treat it as the agreed goal, problem and assumptions; do not restate it again, start the work.
- Be concise in replies.`

// Appended to SYSTEM_PROMPT on OpenAI-compatible providers, where tools have bare names.
export const OPENAI_TOOLS_NOTE = `
On this provider the gentree tools are named without the mcp__gentree__ prefix (project_overview, read_script, edit_script, ...). There are no generic file tools, no shell and no Studio tools.`

// Short, one-line summary of a tool call's input for the UI.
export function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    let s = typeof v === 'string' ? v : JSON.stringify(v)
    if (s === undefined) continue
    s = s.replace(/\s+/g, ' ')
    if (s.length > 60) s = s.slice(0, 57) + '...'
    parts.push(`${k}=${s}`)
    if (parts.join(' ').length > 160) break
  }
  return parts.join(' ').slice(0, 200)
}

// Strips the mcp__server__ prefix for display.
export function displayToolName(name: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name)
  return m ? (m[1] === 'gentree' ? m[2] : `${m[1]}:${m[2]}`) : name
}

function msg(agentId: string, role: ChatMessage['role'], text: string, tool?: ChatMessage['tool']): ChatMessage {
  return { id: randomUUID(), role, text, at: Date.now(), agentId, ...(tool ? { tool } : {}) }
}

// Maps one SDK message to zero or more ChatMessages. Subagent traffic (parent_tool_use_id set) is skipped.
export function toChatMessages(m: SDKMessage, agentId: string): ChatMessage[] {
  if (m.type === 'assistant') {
    if (m.parent_tool_use_id) return []
    const out: ChatMessage[] = []
    if (m.error) out.push(msg(agentId, 'system', errorText(m.error)))
    const text: string[] = []
    for (const block of m.message.content as any[]) {
      if (block.type === 'text' && block.text?.trim()) text.push(block.text)
      else if (block.type === 'tool_use') {
        if (text.length) out.push(msg(agentId, 'assistant', text.splice(0).join('\n')))
        const name = displayToolName(block.name)
        out.push(msg(agentId, 'tool', name, { name, input: summarizeInput(block.input) }))
      }
    }
    if (text.length && !m.error) out.push(msg(agentId, 'assistant', text.join('\n')))
    return out
  }
  // Tool results are not shown, except images a tool produced (forge-image markers).
  if (m.type === 'user' && !m.parent_tool_use_id && Array.isArray((m.message as any)?.content)) {
    const ids: { id: string; name?: string }[] = []
    for (const block of (m.message as any).content as any[]) {
      if (block?.type !== 'tool_result') continue
      const parts = typeof block.content === 'string' ? [block.content] : Array.isArray(block.content) ? block.content.map((c: any) => (c?.type === 'text' ? c.text : '')) : []
      for (const t of parts) for (const x of extractImageMarkers(String(t ?? '')).ids) if (!ids.some((y) => y.id === x.id)) ids.push(x)
    }
    return ids.length ? [msg(agentId, 'assistant', ids.map((x) => imageMarker(x)).join('\n'))] : []
  }
  if (m.type === 'result' && (m.is_error || m.subtype !== 'success')) {
    const detail = m.subtype === 'success' ? m.result : m.errors?.join('; ') || m.subtype
    // The assistant message already carried a friendly auth error; don't repeat the raw one.
    if (isAuthError(String(detail ?? ''))) return []
    return [msg(agentId, 'system', `Error: ${detail}`)]
  }
  if (m.type === 'auth_status' && m.error) return [msg(agentId, 'system', `Auth: ${m.error}`)]
  return []
}

export const AUTH_HELP = 'Claude sign-in failed or expired. Open Settings > Accounts and click Sign in with Claude (or use an API key there).'

export function isAuthError(text: string): boolean {
  return /Failed to authenticate|OAuth session|authentication_failed|invalid x-api-key/i.test(text)
}

function errorText(code: string): string {
  switch (code) {
    case 'authentication_failed':
      return AUTH_HELP
    case 'billing_error':
      return 'Billing error on the Anthropic account.'
    case 'rate_limit':
      return 'Rate limited; try again shortly.'
    case 'model_not_found':
      return 'Model not found; check the "model" setting.'
    default:
      return `API error: ${code}`
  }
}

export function systemMessage(agentId: string, text: string): ChatMessage {
  return msg(agentId, 'system', text)
}

export function userMessage(agentId: string, text: string): ChatMessage {
  return msg(agentId, 'user', text)
}
