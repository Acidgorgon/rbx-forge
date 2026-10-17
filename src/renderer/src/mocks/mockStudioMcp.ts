// Browser-preview mock for Settings > Studio tools (Roblox Studio's MCP server).
//   ?studiomcp=none   no launcher found on this computer
import type { HarnessEvents, StudioMcpApi, StudioMcpCommand, StudioMcpStatus } from '@shared/types'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

export function studioMcpMock(emit: Emit): StudioMcpApi {
  const found = new URLSearchParams(location.search).get('studiomcp') !== 'none'
  const bat = 'C:\\Users\\you\\AppData\\Local\\Roblox\\mcp.bat'
  let enabled = true
  let manual: StudioMcpCommand | null = null
  let connection: StudioMcpStatus['connection'] = null
  const status = (): StudioMcpStatus => {
    const detected = found ? { kind: 'studio' as const, command: 'cmd.exe', args: ['/c', bat], path: bat } : null
    const source = !enabled ? 'off' : manual ? 'manual' : detected ? 'auto' : 'none'
    const active = source === 'manual' ? manual : source === 'auto' && detected ? { command: detected.command, args: detected.args } : null
    return { enabled, source, active, detected, manual, connection, platform: 'win32' }
  }
  return {
    async studioMcpStatus() {
      return status()
    },
    async studioMcpSetSettings(patch) {
      if (typeof patch.enabled === 'boolean') enabled = patch.enabled
      if (patch.manual !== undefined) manual = patch.manual
      const s = status()
      emit('studioMcp:status', s)
      return s
    },
    async studioMcpTest() {
      await new Promise((r) => setTimeout(r, 300))
      if (!status().active) return { ok: false, tools: [], ms: 0, error: 'No Studio MCP command: none was found on this computer and none is set.' }
      const tools = ['execute_luau', 'start_stop_play', 'get_console_output', 'screen_capture', 'list_roblox_studios', 'search_game_tree', 'inspect_instance']
      connection = { state: 'connected', tools: tools.length, at: Date.now(), via: 'test' }
      emit('studioMcp:status', status())
      return { ok: true, tools, ms: 300, server: 'StudioMCP (mock)', studios: 'studio_id 1: MyGame (PlaceId 123456)' }
    },
    async studioMcpBrowse() {
      return 'C:\\Tools\\rbx-studio-mcp.exe'
    }
  }
}
