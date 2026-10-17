// Roblox Studio's MCP server for the Assistant: finding the launcher, the settings precedence
// (manual > auto-detected > none), the last connection state, Settings IPC, and the bridges for
// providers that are not the Agent SDK (OpenAI-compatible loop, Codex CLI). No electron imports.
//
// How Studio's server is launched (create.roblox.com/docs/studio/mcp, "JSON configuration", Oct 2026):
//   Windows: command "cmd.exe", args ["/c", "%LOCALAPPDATA%\\Roblox\\mcp.bat"]
//   macOS:   command "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP"
// and in Studio: Assistant > ... > Manage MCP Servers > "Enable Studio as MCP server". Transport is
// stdio. Every tool takes a studio_id; list_roblox_studios lists the open Studio windows.
//
// The older standalone server (github.com/Roblox/studio-rust-mcp-server, archived in favour of the
// built-in one) runs as `rbx-studio-mcp --stdio`: macOS /Applications/RobloxStudioMCP.app/Contents/
// MacOS/rbx-studio-mcp, Windows wherever rbx-studio-mcp.exe was downloaded. Its installer writes a
// "Roblox_Studio" entry into Claude Desktop (%APPDATA%\Claude\claude_desktop_config.json, macOS
// ~/Library/Application Support/Claude/...), Cursor (~/.cursor/mcp.json) and Antigravity
// (~/.gemini/antigravity/mcp_config.json) (src/install.rs); Studio's "Quick connect" writes the
// same kind of entry, so those configs are read too.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import {
  cleanCommand,
  STUDIO_MCP_ENABLED_SETTING,
  STUDIO_MCP_SETTING,
  type StudioMcpCandidate,
  type StudioMcpCommand,
  type StudioMcpConnection,
  type StudioMcpSettingsPatch,
  type StudioMcpSource,
  type StudioMcpStatus,
  type StudioMcpTestResult
} from '../../shared/studioMcp.ts'
import { McpStdioClient, type McpContent } from './mcpStdio.ts'
import type { GentreeTool, ToolResult } from './tools.ts'
import { chatImageStore, hasChatImageStore, imageMarker } from './chatImages.ts'

// How to use the Studio tools well; part of the chat system prompt (sdk.ts SYSTEM_PROMPT) and of the
// Codex brief when Studio is attached (codex/chat.ts).
export const STUDIO_GUIDE = `  - Every call takes a studio_id: call list_roblox_studios first and use the Studio whose place matches this project's place (PlaceId / name; get_studio_state), not just the first one.
  - execute_luau: datamodel_type "Edit" while stopped; during a playtest "Server" for server state and "Client" for the player's side. Keep snippets short and return a compact result. Never paste big data (file contents, long tables, base64) into the code; scripts come from the repo through Rojo, so change code in the repo files (gentree tools where you have them), not with multi_edit, except for Studio-only instances (marked *).
  - Playtest loop: start_stop_play to start, wait briefly, get_console_output for errors and prints, screen_capture to see the game, character_navigation / user_keyboard_input / user_mouse_input to act as the player, check again, then start_stop_play to stop. Always stop the playtest you started, also after a failure.
  - search_game_tree / inspect_instance read the live tree. Do not save, publish or delete what you did not create. If Studio says its MCP server is off, ask the user to turn on Assistant > ... > Manage MCP Servers > "Enable Studio as MCP server".`

// ---------------------------------------------------------------- detection

export interface DetectEnv {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  home: string
  exists(path: string): boolean
  readText(path: string): string | null
  listDir(path: string): string[]
}

export function nodeDetectEnv(): DetectEnv {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    exists: (p) => {
      try {
        return existsSync(p)
      } catch {
        return false
      }
    },
    readText: (p) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return null
      }
    },
    listDir: (p) => {
      try {
        return readdirSync(p)
      } catch {
        return []
      }
    }
  }
}

const ROBLOX_COMMAND = /mcp\.bat|StudioMCP|rbx-studio-mcp/i
const ROBLOX_KEY = /^roblox[ _-]?studio$/i

// %VAR% (Windows) and $VAR / ${VAR} / leading ~ (macOS) in a path from a client config.
function expand(p: string, e: DetectEnv): string {
  let out = p.replace(/%([A-Za-z_][\w]*)%/g, (m, name: string) => {
    const hit = Object.keys(e.env).find((k) => k.toLowerCase() === name.toLowerCase())
    return hit ? (e.env[hit] ?? m) : m
  })
  if (e.platform !== 'win32') out = out.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, name: string) => e.env[name] ?? m).replace(/^~(?=\/|$)/, e.home)
  return out
}

const isAbsolute = (p: string, platform: NodeJS.Platform) => (platform === 'win32' ? win32.isAbsolute(p) : posix.isAbsolute(p))

// A Roblox Studio entry of one client config (mcpServers.<name>: {command, args}), when the file it
// launches exists.
export function fromClientConfig(text: string, path: string, e: DetectEnv): StudioMcpCandidate | null {
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  const servers = json && typeof json === 'object' ? (json.mcpServers ?? json.servers) : null
  if (!servers || typeof servers !== 'object') return null
  const entries = Object.entries(servers as Record<string, unknown>)
  // A named Roblox_Studio entry first, then any entry that launches a Roblox server.
  entries.sort(([a], [b]) => Number(ROBLOX_KEY.test(b)) - Number(ROBLOX_KEY.test(a)))
  for (const [, v] of entries) {
    const cmd = cleanCommand(v)
    if (!cmd) continue
    const line = [cmd.command, ...cmd.args].join(' ')
    // Only Roblox's own launchers (a third-party "roblox-studio" server has other tools).
    if (!ROBLOX_COMMAND.test(line)) continue
    // The file that runs: the command, or the script cmd.exe /c runs.
    const target = /^cmd(\.exe)?$/i.test(cmd.command) ? cmd.args.find((a) => ROBLOX_COMMAND.test(a)) : cmd.command
    if (target) {
      const full = expand(target, e)
      if (isAbsolute(full, e.platform) && !e.exists(full)) continue
    }
    return { ...cmd, kind: /rbx-studio-mcp/i.test(line) ? 'legacy' : 'client', path }
  }
  return null
}

function clientConfigs(e: DetectEnv): string[] {
  if (e.platform === 'win32') {
    const appData = e.env.APPDATA || win32.join(e.home, 'AppData', 'Roaming')
    const local = e.env.LOCALAPPDATA || win32.join(e.home, 'AppData', 'Local')
    const packages = win32.join(local, 'Packages')
    // Claude Desktop from the Microsoft Store keeps its config under its package folder.
    const store = e
      .listDir(packages)
      .filter((d) => /^Claude_/i.test(d))
      .map((d) => win32.join(packages, d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'))
    return [win32.join(appData, 'Claude', 'claude_desktop_config.json'), ...store, win32.join(e.home, '.cursor', 'mcp.json'), win32.join(e.home, '.gemini', 'antigravity', 'mcp_config.json')]
  }
  if (e.platform === 'darwin') {
    return [posix.join(e.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), posix.join(e.home, '.cursor', 'mcp.json'), posix.join(e.home, '.gemini', 'antigravity', 'mcp_config.json')]
  }
  return []
}

// Every launcher found, best first: Studio's built-in server, a Roblox entry in a client config,
// then the legacy standalone server at its usual place. Studio runs only on Windows and macOS.
export function detectStudioMcpAll(e: DetectEnv): StudioMcpCandidate[] {
  const out: StudioMcpCandidate[] = []
  if (e.platform === 'win32') {
    const local = e.env.LOCALAPPDATA || win32.join(e.home, 'AppData', 'Local')
    const bat = win32.join(local, 'Roblox', 'mcp.bat')
    if (e.exists(bat)) out.push({ kind: 'studio', command: 'cmd.exe', args: ['/c', bat], path: bat })
  } else if (e.platform === 'darwin') {
    for (const app of ['/Applications/RobloxStudio.app', posix.join(e.home, 'Applications', 'RobloxStudio.app')]) {
      const exe = posix.join(app, 'Contents', 'MacOS', 'StudioMCP')
      if (e.exists(exe)) {
        out.push({ kind: 'studio', command: exe, args: [], path: exe })
        break
      }
    }
  } else return out
  for (const file of clientConfigs(e)) {
    const text = e.readText(file)
    const hit = text ? fromClientConfig(text, file, e) : null
    if (hit) out.push(hit)
  }
  const legacy =
    e.platform === 'win32'
      ? [win32.join(e.home, 'Downloads', 'rbx-studio-mcp.exe')]
      : ['/Applications/RobloxStudioMCP.app/Contents/MacOS/rbx-studio-mcp', posix.join(e.home, 'Applications', 'RobloxStudioMCP.app', 'Contents', 'MacOS', 'rbx-studio-mcp')]
  for (const exe of legacy) {
    if (e.exists(exe)) {
      out.push({ kind: 'legacy', command: exe, args: ['--stdio'], path: exe })
      break
    }
  }
  return out
}

export function detectStudioMcp(e: DetectEnv): StudioMcpCandidate | null {
  return detectStudioMcpAll(e)[0] ?? null
}

// Detection is a few stat() calls and small JSON reads; buildOptions runs it every turn, so a short
// cache keeps it off the hot path. Tests swap the environment.
const DETECT_TTL_MS = 15_000
let detectEnv: () => DetectEnv = nodeDetectEnv
let cached: { at: number; hit: StudioMcpCandidate | null } | null = null

export function setStudioDetectEnv(env: DetectEnv | null): void {
  detectEnv = env ? () => env : nodeDetectEnv
  cached = null
}

export function detectedStudioMcp(refresh = false): StudioMcpCandidate | null {
  if (!refresh && cached && Date.now() - cached.at < DETECT_TTL_MS) return cached.hit
  cached = { at: Date.now(), hit: detectStudioMcp(detectEnv()) }
  return cached.hit
}

// ---------------------------------------------------------------- settings precedence

type GetSetting = <T>(key: string, fallback: T) => T

export interface StudioMcpResolved {
  enabled: boolean
  source: StudioMcpSource
  active: StudioMcpCommand | null
  manual: StudioMcpCommand | null
  detected: StudioMcpCandidate | null
}

// manual (studioMcp setting) > auto (detected) > none; studioMcpEnabled false turns both off.
export function resolveStudioMcp(getSetting: GetSetting, detected: StudioMcpCandidate | null = detectedStudioMcp()): StudioMcpResolved {
  const enabled = getSetting<boolean>(STUDIO_MCP_ENABLED_SETTING, true) !== false
  const manual = cleanCommand(getSetting<unknown>(STUDIO_MCP_SETTING, null))
  if (!enabled) return { enabled, source: 'off', active: null, manual, detected }
  if (manual) return { enabled, source: 'manual', active: manual, manual, detected }
  if (detected) return { enabled, source: 'auto', active: { command: detected.command, args: detected.args }, manual, detected }
  return { enabled, source: 'none', active: null, manual, detected }
}

// ---------------------------------------------------------------- connection state

let connection: StudioMcpConnection | null = null
const listeners = new Set<() => void>()

export function studioConnection(): StudioMcpConnection | null {
  return connection
}

export function noteStudioConnection(c: Omit<StudioMcpConnection, 'at'> | null): void {
  connection = c ? { ...c, at: Date.now() } : null
  for (const l of listeners) l()
}

export function onStudioConnection(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// The SDK's init message lists each MCP server's state and every tool name.
export function noteSdkInit(m: { mcp_servers?: { name: string; status: string }[]; tools?: string[] }, server: string): void {
  const s = m.mcp_servers?.find((x) => x.name === server)
  if (!s) return
  const tools = (m.tools ?? []).filter((t) => t.startsWith(`mcp__${server}__`)).length
  if (s.status === 'connected') noteStudioConnection({ state: 'connected', tools, via: 'chat' })
  else if (s.status === 'failed') noteStudioConnection({ state: 'failed', detail: 'The Studio MCP server did not start.', via: 'chat' })
  else if (s.status === 'pending' && connection?.state !== 'connected') noteStudioConnection({ state: 'pending', via: 'chat' })
}

export function studioMcpStatus(getSetting: GetSetting, refresh = false): StudioMcpStatus {
  const r = resolveStudioMcp(getSetting, detectedStudioMcp(refresh))
  return { ...r, connection, platform: process.platform }
}

// ---------------------------------------------------------------- Settings IPC

export interface StudioMcpHandlerDeps {
  getSetting: GetSetting
  setSetting(key: string, value: unknown): void
  emit(status: StudioMcpStatus): void
  browse(): Promise<string | null>
}

export function studioMcpHandlers(deps: StudioMcpHandlerDeps) {
  const status = (refresh = false) => studioMcpStatus(deps.getSetting, refresh)
  onStudioConnection(() => deps.emit(status()))
  return {
    studioMcpStatus: async () => status(true),
    studioMcpSetSettings: async (patch: StudioMcpSettingsPatch) => {
      const p = patch && typeof patch === 'object' ? patch : {}
      if (typeof p.enabled === 'boolean') deps.setSetting(STUDIO_MCP_ENABLED_SETTING, p.enabled)
      if (p.manual !== undefined) deps.setSetting(STUDIO_MCP_SETTING, cleanCommand(p.manual))
      // A different command: the old connection result no longer says anything.
      if (p.manual !== undefined || p.enabled === false) connection = null
      const s = status(true)
      deps.emit(s)
      return s
    },
    studioMcpTest: async (cmd?: unknown): Promise<StudioMcpTestResult> => {
      const target = cleanCommand(cmd) ?? status(true).active ?? status().detected
      if (!target) return { ok: false, tools: [], ms: 0, error: 'No Studio MCP command: none was found on this computer and none is set.' }
      const r = await testStudioMcp(target)
      noteStudioConnection(r.ok ? { state: 'connected', tools: r.tools.length, via: 'test', ...(r.studios ? { detail: r.studios } : {}) } : { state: 'failed', detail: r.error, via: 'test' })
      return r
    },
    studioMcpBrowse: () => deps.browse()
  }
}

// Test connection: initialize + tools/list, and the open Studio windows when the server lists them.
export async function testStudioMcp(cmd: StudioMcpCommand, opts: { timeoutMs?: number } = {}): Promise<StudioMcpTestResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000
  const started = Date.now()
  let client: McpStdioClient | null = null
  try {
    client = await McpStdioClient.connect(cmd, { timeoutMs })
    const tools = (await client.listTools(timeoutMs)).map((t) => t.name)
    let studios: string | undefined
    if (tools.includes('list_roblox_studios')) {
      try {
        const r = await client.callTool('list_roblox_studios', {}, { timeoutMs: 10_000 })
        studios = r.content.map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n').trim().slice(0, 600) || undefined
      } catch (e) {
        studios = `list_roblox_studios: ${(e as Error).message}`
      }
    }
    const info = client.serverInfo
    return { ok: true, tools, ms: Date.now() - started, ...(info.name ? { server: info.version ? `${info.name} ${info.version}` : info.name } : {}), ...(studios ? { studios } : {}) }
  } catch (e) {
    const stderr = (client?.stderr ?? (e as { stderr?: string }).stderr ?? '').trim().split(/\r?\n/).slice(-12).join('\n').slice(-1500)
    return { ok: false, tools: [], ms: Date.now() - started, error: (e as Error).message, ...(stderr ? { stderr } : {}) }
  } finally {
    await client?.close()
  }
}

// ---------------------------------------------------------------- OpenAI-compatible bridge

// Tool names on the bridge match the Agent SDK's, so one system prompt covers both paths.
export const STUDIO_TOOL_PREFIX = 'mcp__studio__'
const MAX_RESULT_CHARS = 24_000

export interface StudioBridge {
  tools: GentreeTool<any>[]
  close(): Promise<void>
}

// Starts the Studio server for one OpenAI-loop turn and wraps each of its tools as a GentreeTool
// (JSON Schema passed through). Null when it cannot start; the turn then runs without Studio.
export async function openStudioBridge(cmd: StudioMcpCommand, opts: { signal?: AbortSignal; log?: (text: string) => void; timeoutMs?: number } = {}): Promise<StudioBridge | null> {
  let client: McpStdioClient
  try {
    client = await McpStdioClient.connect(cmd, { timeoutMs: opts.timeoutMs ?? 15_000, signal: opts.signal })
  } catch (e) {
    opts.log?.(`Studio MCP did not start: ${(e as Error).message}`)
    noteStudioConnection({ state: 'failed', detail: (e as Error).message, via: 'chat' })
    return null
  }
  try {
    const list = await client.listTools(opts.timeoutMs ?? 15_000)
    noteStudioConnection({ state: 'connected', tools: list.length, via: 'chat' })
    const tools: GentreeTool<any>[] = list.map((t) => ({
      name: `${STUDIO_TOOL_PREFIX}${t.name}`.slice(0, 64),
      description: (t.description ?? t.name).slice(0, 2000),
      inputSchema: {},
      jsonSchema: objectSchema(t.inputSchema),
      handler: async (args: Record<string, unknown>) => {
        const r = await client.callTool(t.name, args ?? {}, { signal: opts.signal })
        return await toToolResult(r.content, !!r.isError)
      }
    }))
    return { tools, close: () => client.close() }
  } catch (e) {
    opts.log?.(`Studio MCP tools/list failed: ${(e as Error).message}`)
    noteStudioConnection({ state: 'failed', detail: (e as Error).message, via: 'chat' })
    await client.close()
    return null
  }
}

function objectSchema(s: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!s || s.type !== 'object') return { type: 'object', properties: {} }
  const { $schema: _drop, ...rest } = s
  return rest.properties ? rest : { ...rest, properties: {} }
}

// MCP content blocks -> text. Images (screen_capture) go to the chat image store, so the person sees
// them in the chat; the model gets a note, since tool results on this path are text only.
async function toToolResult(content: McpContent[], isError: boolean): Promise<ToolResult> {
  const parts: string[] = []
  for (const c of content) {
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text)
    else if (c.type === 'image' && typeof c.data === 'string') {
      if (hasChatImageStore()) {
        try {
          const img = await chatImageStore().add({ dataUrl: `data:${c.mimeType || 'image/png'};base64,${c.data}`, name: 'studio-capture' })
          parts.push(`${imageMarker(img)}\n[Image shown to the user in the chat. This provider's tool results are text only, so you cannot see it; check state with get_console_output or execute_luau instead.]`)
          continue
        } catch {
          // fall through to the note
        }
      }
      parts.push('[image result: not viewable on this provider]')
    } else if (c.type === 'resource' && c.resource && typeof c.resource === 'object') {
      const r = c.resource as { text?: unknown; uri?: unknown }
      parts.push(typeof r.text === 'string' ? r.text : `[resource ${String(r.uri ?? '')}]`)
    } else parts.push(JSON.stringify(c).slice(0, 500))
  }
  let text = parts.join('\n')
  if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + `\n…[truncated ${text.length - MAX_RESULT_CHARS} chars]`
  return { content: [{ type: 'text', text: text || '(no output)' }], ...(isError ? { isError: true } : {}) }
}

// ---------------------------------------------------------------- Codex CLI

// Studio tools that only look (no edits, no playtest, no input): what a read-only Codex guest gets.
export const STUDIO_READ_TOOLS = ['list_roblox_studios', 'get_studio_state', 'search_game_tree', 'inspect_instance', 'script_read', 'script_grep', 'script_search', 'get_console_output', 'screen_capture'] as const

// `codex exec -c key=value` overrides that add the Studio server for one run. Codex parses each value
// as TOML (a JSON string or array of strings is valid TOML). Keys from the Codex MCP docs
// (learn.chatgpt.com/docs/extend/mcp, "[mcp_servers.<name>]"): command, args, startup_timeout_sec
// (default 10), tool_timeout_sec (default 60; a playtest step can take longer),
// default_tools_approval_mode (auto | prompt | writes | approve) and enabled_tools (allow list).
// `codex exec` cannot answer an approval prompt (github.com/openai/codex/issues/24135: MCP calls end
// as "user cancelled"), so the host's run pre-approves the Studio tools; a read-only guest only gets
// STUDIO_READ_TOOLS. Forge never reads or edits the person's own Codex config: these flags apply to
// this run only.
export function codexStudioConfig(cmd: StudioMcpCommand | null, opts: { readOnly?: boolean } = {}): string[] {
  if (!cmd) return []
  const key = 'mcp_servers.studio'
  return [
    `${key}.command=${JSON.stringify(cmd.command)}`,
    `${key}.args=${JSON.stringify(cmd.args)}`,
    `${key}.startup_timeout_sec=30`,
    `${key}.tool_timeout_sec=300`,
    `${key}.default_tools_approval_mode="approve"`,
    ...(opts.readOnly ? [`${key}.enabled_tools=${JSON.stringify(STUDIO_READ_TOOLS)}`] : [])
  ]
}
