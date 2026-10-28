// Chat header pill: Roblox Studio tools (MCP) are attached to this chat's turns. Green once a chat or
// Test connection reached the server, red when it failed. Opens Settings > Studio tools.
import { isReadOnlyMode, type ChatMode } from '@shared/chatModes'
import { useActions } from '../store'
import { studioMcpLabel, useStudioMcp } from '../pages/settings/StudioMcpSettings'
import { showSettingsSection } from '../pages/settings/settingsNav'
import { formatCommand } from '@shared/studioMcp'

export function StudioPill({ mode }: { mode: ChatMode }) {
  const actions = useActions()
  const s = useStudioMcp()
  if (!s?.active) return null
  const label = studioMcpLabel(s)
  const readOnly = isReadOnlyMode(mode)
  const title = readOnly
    ? 'Roblox Studio tools are off in Ask and Plan (they can change the place). Switch to Edit or Auto to use them.'
    : `Roblox Studio tools attached: ${label.text}\n${formatCommand(s.active)}\nClick for Settings > Studio tools.`
  return (
    <button
      className="pill"
      style={readOnly ? { opacity: 0.55 } : undefined}
      title={title}
      aria-label={`Studio tools: ${readOnly ? 'off in this mode' : label.text}`}
      data-testid="studio-pill"
      onClick={() => (actions.openPage('settings'), showSettingsSection('studio-mcp'))}
    >
      <span className={`led ${readOnly ? 'idle' : label.led}`} aria-hidden />
      Studio
    </button>
  )
}
