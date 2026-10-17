// Roblox Studio's MCP server (live Studio tools for the Assistant): settings, status and the IPC
// surface for Settings > Studio & sync > Studio tools. Main side: src/main/agent/studioMcp.ts.

// The command an MCP client spawns (stdio transport).
export interface StudioMcpCommand {
  command: string
  args: string[]
}

// Where a detected launcher came from:
//   studio  Studio's built-in MCP server launcher (%LOCALAPPDATA%\Roblox\mcp.bat, StudioMCP on macOS)
//   client  a Roblox_Studio entry in another MCP client's config (Claude Desktop, Cursor, Antigravity)
//   legacy  the archived standalone rbx-studio-mcp server (github.com/Roblox/studio-rust-mcp-server)
export type StudioMcpKind = 'studio' | 'client' | 'legacy'

export interface StudioMcpCandidate extends StudioMcpCommand {
  kind: StudioMcpKind
  // The file that was found (the launcher, or the client config the entry came from).
  path: string
}

// What chats use: manual (the override) > auto (detected) > none; off = turned off in Settings.
export type StudioMcpSource = 'manual' | 'auto' | 'none' | 'off'

export interface StudioMcpConnection {
  state: 'connected' | 'failed' | 'pending'
  at: number
  // Studio tools the server listed.
  tools?: number
  detail?: string
  via: 'chat' | 'test'
}

export interface StudioMcpStatus {
  enabled: boolean
  source: StudioMcpSource
  // The command chats attach (null when off / none).
  active: StudioMcpCommand | null
  detected: StudioMcpCandidate | null
  manual: StudioMcpCommand | null
  // The last time a chat or Test connection talked to the server.
  connection: StudioMcpConnection | null
  platform: string
}

export interface StudioMcpTestResult {
  ok: boolean
  tools: string[]
  server?: string
  ms: number
  error?: string
  // Server stderr (last lines), for "why did it fail".
  stderr?: string
  // What list_roblox_studios answered (the open Studio windows), when the server has that tool.
  studios?: string
}

export interface StudioMcpSettingsPatch {
  enabled?: boolean
  // null clears the override (back to auto-detect).
  manual?: StudioMcpCommand | null
}

export interface StudioMcpApi {
  studioMcpStatus(): Promise<StudioMcpStatus>
  studioMcpSetSettings(patch: StudioMcpSettingsPatch): Promise<StudioMcpStatus>
  // Spawns the command (the given one, else the active one), runs MCP initialize + tools/list, kills it.
  studioMcpTest(cmd?: StudioMcpCommand): Promise<StudioMcpTestResult>
  // File picker for the manual command.
  studioMcpBrowse(): Promise<string | null>
}

export interface StudioMcpEvents {
  'studioMcp:status': StudioMcpStatus
}

export const STUDIO_MCP_SETTING = 'studioMcp'
export const STUDIO_MCP_ENABLED_SETTING = 'studioMcpEnabled'

// Studio's side, from create.roblox.com/docs/studio/mcp ("Enable in Studio").
export const STUDIO_MCP_HELP = 'In Roblox Studio open Assistant, click … > Manage MCP Servers and turn on "Enable Studio as MCP server". Keep Studio open with your place while the Assistant uses it.'

// Splits an args field the way a shell would for simple cases: whitespace separates, "double" or
// 'single' quotes keep spaces (Windows paths). No escapes, so backslashes stay as typed.
export function parseArgs(text: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let last = -1
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const part = m[1] ?? m[2] ?? m[3] ?? ''
    // Adjacent pieces (a"b c") join into one argument.
    if (last === m.index && out.length) out[out.length - 1] += part
    else out.push(part)
    last = m.index + m[0].length
  }
  return out
}

// The inverse, for showing a command on one line.
export function formatArgs(args: string[]): string {
  return args.map((a) => (a === '' || /\s/.test(a) ? `"${a}"` : a)).join(' ')
}

export function formatCommand(c: StudioMcpCommand | null | undefined): string {
  if (!c) return ''
  const cmd = /\s/.test(c.command) ? `"${c.command}"` : c.command
  return c.args.length ? `${cmd} ${formatArgs(c.args)}` : cmd
}

export function cleanCommand(v: unknown): StudioMcpCommand | null {
  if (!v || typeof v !== 'object') return null
  const o = v as { command?: unknown; args?: unknown }
  if (typeof o.command !== 'string' || !o.command.trim()) return null
  const args = Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === 'string') : []
  return { command: o.command.trim().slice(0, 2000), args: args.slice(0, 50).map((a) => a.slice(0, 2000)) }
}
