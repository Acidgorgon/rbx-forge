// Settings > Studio & sync > Studio tools: Roblox Studio's MCP server for the Assistant (run Luau,
// playtests, console output, screen capture). Forge finds Studio's launcher by itself; a manual
// command overrides it, and the switch turns Studio tools off. Main side: agent/studioMcp.ts.
import { useEffect, useState } from 'react'
import type { StudioMcpStatus, StudioMcpTestResult } from '@shared/types'
import { formatArgs, formatCommand, parseArgs, STUDIO_MCP_HELP } from '@shared/studioMcp'
import { useStore } from '../../store'
import { errorText } from '../../lib/format'

// The live status (Settings and the chat's Studio pill share it).
export function useStudioMcp(): StudioMcpStatus | null {
  const [s, setS] = useState<StudioMcpStatus | null>(null)
  useEffect(() => {
    let live = true
    void window.harness
      .studioMcpStatus()
      .then((v) => live && setS(v))
      .catch(() => undefined)
    const off = window.harness.on('studioMcp:status', (v) => setS(v))
    return () => {
      live = false
      off()
    }
  }, [])
  return s
}

const KIND: Record<string, string> = { studio: "Roblox Studio's MCP server", client: 'from another MCP client config', legacy: 'standalone rbx-studio-mcp (archived)' }

export function studioMcpLabel(s: StudioMcpStatus): { text: string; led: 'ok' | 'err' | 'warn' | 'idle' } {
  if (s.source === 'off') return { text: 'Off', led: 'idle' }
  if (s.source === 'none') return { text: 'Not found', led: 'idle' }
  const c = s.connection
  if (c?.state === 'connected') return { text: `Connected${c.tools ? ` · ${c.tools} tools` : ''}`, led: 'ok' }
  if (c?.state === 'failed') return { text: 'Could not connect', led: 'err' }
  return { text: s.source === 'manual' ? 'Manual command' : 'Found', led: 'idle' }
}

export function StudioMcpSettings() {
  const { actions } = useStore()
  const s = useStudioMcp()
  const [cmd, setCmd] = useState('')
  const [args, setArgs] = useState('')
  const [dirty, setDirty] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<StudioMcpTestResult | null>(null)

  // The override fields show the manual command (or are empty for auto).
  useEffect(() => {
    if (!s || dirty) return
    setCmd(s.manual?.command ?? '')
    setArgs(s.manual ? formatArgs(s.manual.args) : '')
  }, [s?.manual?.command, s?.manual?.args.join('\u0000'), dirty])

  if (!s) return null
  const label = studioMcpLabel(s)
  const save = async (patch: Parameters<typeof window.harness.studioMcpSetSettings>[0]) => {
    try {
      await window.harness.studioMcpSetSettings(patch)
      setResult(null)
    } catch (e) {
      actions.toast({ text: 'Could not save the Studio tools setting', detail: errorText(e), kind: 'err' })
    }
  }
  const test = async () => {
    setTesting(true)
    setResult(null)
    try {
      // Unsaved override fields are tested as typed.
      setResult(await window.harness.studioMcpTest(dirty && cmd.trim() ? { command: cmd.trim(), args: parseArgs(args) } : undefined))
    } catch (e) {
      setResult({ ok: false, tools: [], ms: 0, error: errorText(e) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      <div className="set-row">
        <div className="set-text">
          <div className="set-title">Studio tools for the Assistant</div>
          <div className="note">
            Lets the Assistant work in your open Roblox Studio: run Luau, start and stop playtests, read the console, capture the screen and play as the character.
            Claude, OpenAI-compatible and Codex chats get them in Edit and Auto (not Ask or Plan).
          </div>
          <div className="note row" style={{ gap: 6, alignItems: 'center' }} data-testid="studio-mcp-state">
            <span className={`led ${label.led}`} aria-hidden />
            <span>{label.text}</span>
            {s.source !== 'off' && s.source !== 'none' && <span className="tag">{s.source === 'manual' ? 'manual' : 'auto'}</span>}
          </div>
          {s.detected ? (
            <div className="note">
              Found: <span className="mono">{formatCommand(s.detected)}</span> <span className="faint">({KIND[s.detected.kind] ?? s.detected.kind}{s.detected.kind === 'client' ? `: ${s.detected.path}` : ''})</span>
            </div>
          ) : (
            <div className="note">{s.manual ? 'Forge found no Studio MCP server on this computer; the command below is used.' : 'Not found on this computer. Install or update Roblox Studio, or set the command below.'}</div>
          )}
          {s.source === 'manual' && s.detected && <div className="note faint">The manual command below is used instead.</div>}
          {s.connection?.state === 'failed' && s.connection.detail && <div className="note err">{s.connection.detail}</div>}
        </div>
        <div className="set-ctl">
          <input type="checkbox" className="switch" checked={s.enabled} onChange={(e) => void save({ enabled: e.target.checked })} aria-label="Studio tools for the Assistant" />
        </div>
      </div>
      <div className="set-row">
        <div className="set-text">
          <div className="set-title">Studio MCP command</div>
          <div className="note">Leave empty to use the one Forge found. Windows: <span className="mono">cmd.exe</span> with args <span className="mono">/c %LOCALAPPDATA%\Roblox\mcp.bat</span>; macOS: <span className="mono">/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP</span>.</div>
          <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <input className="input mono" style={{ flex: '2 1 220px', minWidth: 0 }} value={cmd} placeholder={s.detected?.command ?? 'command'} onChange={(e) => (setCmd(e.target.value), setDirty(true))} aria-label="Studio MCP command" />
            <input className="input mono" style={{ flex: '1 1 160px', minWidth: 0 }} value={args} placeholder={s.detected ? formatArgs(s.detected.args) || 'args' : 'args'} onChange={(e) => (setArgs(e.target.value), setDirty(true))} aria-label="Studio MCP args" />
            <button
              className="btn small"
              onClick={async () => {
                const picked = await window.harness.studioMcpBrowse().catch(() => null)
                if (!picked) return
                // A .bat / .cmd runs through cmd.exe /c.
                if (/\.(bat|cmd)$/i.test(picked)) (setCmd('cmd.exe'), setArgs(formatArgs(['/c', picked])))
                else (setCmd(picked), setArgs(/rbx-studio-mcp/i.test(picked) ? '--stdio' : ''))
                setDirty(true)
              }}
            >
              Browse…
            </button>
            <button className="btn small" disabled={!dirty} onClick={() => void save({ manual: cmd.trim() ? { command: cmd.trim(), args: parseArgs(args) } : null }).then(() => setDirty(false))}>
              Save
            </button>
            {(s.manual || dirty) && (
              <button className="btn small ghost" onClick={() => void save({ manual: null }).then(() => (setDirty(false), setCmd(''), setArgs('')))}>
                Use auto
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="set-row">
        <div className="set-text">
          <div className="set-title">Test connection</div>
          <div className="note">Starts the server, asks it for its tools and stops it. {STUDIO_MCP_HELP}</div>
          {result && (
            <div className={`note ${result.ok ? 'ok' : 'err'}`} data-testid="studio-mcp-test">
              {result.ok ? `Connected: ${result.tools.length} tool${result.tools.length === 1 ? '' : 's'}${result.server ? ` from ${result.server}` : ''} (${(result.ms / 1000).toFixed(1)} s).` : `Failed: ${result.error}`}
            </div>
          )}
          {result?.ok && result.studios && <pre className="note mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{result.studios}</pre>}
          {result?.ok && result.tools.length > 0 && <div className="note faint mono" style={{ wordBreak: 'break-word' }}>{result.tools.join(', ')}</div>}
          {!result?.ok && result?.stderr && <pre className="note mono faint" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{result.stderr}</pre>}
        </div>
        <div className="set-ctl">
          <button className="btn small" disabled={testing || (!s.active && !s.detected && !(dirty && cmd.trim()))} onClick={() => void test()} aria-label="Test Studio MCP connection" data-search>
            {testing ? <span className="spinner" aria-hidden /> : null} Test connection
          </button>
        </div>
      </div>
    </>
  )
}
