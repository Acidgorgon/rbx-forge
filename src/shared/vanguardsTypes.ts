// Vanguards CLI (ror, rur, ree) & FM offline build pipeline types.
// Strict GPL boundary: RBX Forge only invokes external CLI executables/scripts as subprocesses.

export const FORBIDDEN_FCM_PLACE_ID = 125988560196910

export const DEFAULT_VANGUARDS_BIN_DIR = 'C:\\tools\\vanguards\\bin'
export const DEFAULT_VANGUARDS_FM_DIR = 'C:\\tools\\vanguards\\fm'
export const DEFAULT_VANGUARDS_PACKS_DIR = 'C:\\tools\\packs'
export const DEFAULT_VANGUARDS_MCP_PORT = 7655

export const VANGUARDS_SETTINGS_KEYS = {
  binDir: 'vanguards.binDir',
  fmDir: 'vanguards.fmDir',
  packsDir: 'vanguards.packsDir'
} as const

export type VanguardsToolId = 'ror' | 'rur' | 'ree' | 'python' | 'lune'

export interface VanguardsToolInfo {
  id: VanguardsToolId
  found: boolean
  path?: string
  version?: string
  source?: 'configured' | 'default' | 'path'
}

export type FmScriptId = 'envbuild' | 'modelpreview' | 'insert_rbxm' | 'mcp_bridge'

export interface VanguardsPackInfo {
  name: string
  path: string
  files?: number
}

export interface VanguardsSettings {
  binDir: string
  fmDir: string
  packsDir: string
}

export interface VanguardsStatus {
  binDir: string
  fmDir: string
  packsDir: string
  tools: Record<VanguardsToolId, VanguardsToolInfo>
  fmScripts: Record<FmScriptId, { found: boolean; path?: string }>
  packs: VanguardsPackInfo[]
  mcpBridge: {
    running: boolean
    port: number
    pid?: number
    lastError?: string
  }
}

export interface VanguardsRunResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
  durationMs: number
  images?: string[]
  outputPath?: string
  error?: string
}

export interface RorRunRequest {
  args: string[]
  cwd?: string
  timeoutMs?: number
  outDir?: string
}

export interface RurRunRequest {
  args: string[]
  cwd?: string
  timeoutMs?: number
  outDir?: string
}

export interface ReeRunRequest {
  args: string[]
  cwd?: string
  timeoutMs?: number
}

export interface FmEnvbuildRequest {
  module: string
  fn?: string
  argsJson?: string
  time?: number
  views?: string
  focus?: string
  cameraJson?: string
  size?: string
  outDir?: string
  lightingFrom?: string
  timeoutMs?: number
}

export interface FmModelpreviewRequest {
  modelPath: string
  views?: string
  size?: string
  focus?: string
  background?: string
  ids?: boolean
  outDir?: string
  timeoutMs?: number
}

export interface FmInsertRbxmRequest {
  studioId: string
  filePath: string
  parent?: string
  at?: string
  replace?: boolean
  select?: boolean
  placeId?: number
  timeoutMs?: number
}

export interface VanguardsEvents {
  'vanguards:status': VanguardsStatus
  'vanguards:log': { stream: 'stdout' | 'stderr' | 'info'; text: string; at: number }
}

export interface VanguardsApi {
  vanguardsStatus(): Promise<VanguardsStatus>
  vanguardsRefresh(): Promise<VanguardsStatus>
  vanguardsSetSettings(patch: Partial<VanguardsSettings>): Promise<VanguardsStatus>
  vanguardsRunRor(req: RorRunRequest): Promise<VanguardsRunResult>
  vanguardsRunRur(req: RurRunRequest): Promise<VanguardsRunResult>
  vanguardsRunRee(req: ReeRunRequest): Promise<VanguardsRunResult>
  vanguardsFmEnvbuild(req: FmEnvbuildRequest): Promise<VanguardsRunResult>
  vanguardsFmModelpreview(req: FmModelpreviewRequest): Promise<VanguardsRunResult>
  vanguardsFmInsertRbxm(req: FmInsertRbxmRequest): Promise<VanguardsRunResult>
  vanguardsStartMcpBridge(port?: number): Promise<VanguardsStatus>
  vanguardsStopMcpBridge(): Promise<VanguardsStatus>
}
