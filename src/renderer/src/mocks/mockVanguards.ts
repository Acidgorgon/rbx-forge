import type { HarnessEvents, VanguardsApi, VanguardsStatus } from '@shared/types'
import {
  DEFAULT_VANGUARDS_BIN_DIR,
  DEFAULT_VANGUARDS_FM_DIR,
  DEFAULT_VANGUARDS_MCP_PORT,
  DEFAULT_VANGUARDS_PACKS_DIR,
  FORBIDDEN_FCM_PLACE_ID
} from '@shared/vanguardsTypes'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

export function vanguardsMock(emit: Emit): VanguardsApi {
  let state: VanguardsStatus = {
    binDir: DEFAULT_VANGUARDS_BIN_DIR,
    fmDir: DEFAULT_VANGUARDS_FM_DIR,
    packsDir: DEFAULT_VANGUARDS_PACKS_DIR,
    tools: {
      ror: { id: 'ror', found: true, path: `${DEFAULT_VANGUARDS_BIN_DIR}\\ror.cmd`, source: 'default' },
      rur: { id: 'rur', found: true, path: `${DEFAULT_VANGUARDS_BIN_DIR}\\rur.cmd`, source: 'default' },
      ree: { id: 'ree', found: true, path: `${DEFAULT_VANGUARDS_BIN_DIR}\\ree.cmd`, source: 'default' },
      python: { id: 'python', found: true, path: 'py', source: 'path' },
      lune: { id: 'lune', found: true, path: 'lune', source: 'path' }
    },
    fmScripts: {
      envbuild: { found: true, path: `${DEFAULT_VANGUARDS_FM_DIR}\\envbuild.py` },
      modelpreview: { found: true, path: `${DEFAULT_VANGUARDS_FM_DIR}\\modelpreview.py` },
      insert_rbxm: { found: true, path: `${DEFAULT_VANGUARDS_FM_DIR}\\insert_rbxm.py` },
      mcp_bridge: { found: true, path: `${DEFAULT_VANGUARDS_FM_DIR}\\mcp_bridge.py` }
    },
    packs: [
      { name: 'city-buildkit', path: `${DEFAULT_VANGUARDS_PACKS_DIR}\\city-buildkit`, files: 42 },
      { name: 'fcity-kit', path: `${DEFAULT_VANGUARDS_PACKS_DIR}\\fcity-kit`, files: 19 }
    ],
    mcpBridge: {
      running: false,
      port: DEFAULT_VANGUARDS_MCP_PORT
    }
  }

  return {
    vanguardsStatus: async () => state,
    vanguardsRefresh: async () => {
      emit('vanguards:status', state)
      return state
    },
    vanguardsSetSettings: async (patch) => {
      state = {
        ...state,
        ...(patch.binDir !== undefined ? { binDir: patch.binDir || DEFAULT_VANGUARDS_BIN_DIR } : {}),
        ...(patch.fmDir !== undefined ? { fmDir: patch.fmDir || DEFAULT_VANGUARDS_FM_DIR } : {}),
        ...(patch.packsDir !== undefined ? { packsDir: patch.packsDir || DEFAULT_VANGUARDS_PACKS_DIR } : {})
      }
      emit('vanguards:status', state)
      return state
    },
    vanguardsRunRor: async (req) => ({
      ok: true,
      code: 0,
      stdout: `[mock ror] ROR_BACKEND=dx12 ROR_MEMORY_FLOOR_GB=2 args=${req.args.join(' ')}`,
      stderr: '',
      durationMs: 42
    }),
    vanguardsRunRur: async (req) => ({
      ok: true,
      code: 0,
      stdout: `[mock rur] args=${req.args.join(' ')}`,
      stderr: '',
      durationMs: 38
    }),
    vanguardsRunRee: async (req) => ({
      ok: true,
      code: 0,
      stdout: `[mock ree] args=${req.args.join(' ')}`,
      stderr: '',
      durationMs: 31
    }),
    vanguardsFmEnvbuild: async (req) => ({
      ok: true,
      code: 0,
      stdout: `[mock envbuild] built ${req.module}`,
      stderr: '',
      durationMs: 120,
      outputPath: 'out/final.rbxm'
    }),
    vanguardsFmModelpreview: async (req) => ({
      ok: true,
      code: 0,
      stdout: `[mock modelpreview] rendered ${req.modelPath}`,
      stderr: '',
      durationMs: 88
    }),
    vanguardsFmInsertRbxm: async (req) => {
      if (req.placeId === FORBIDDEN_FCM_PLACE_ID || req.studioId.includes(String(FORBIDDEN_FCM_PLACE_ID))) {
        const msg = `Refused: place ${FORBIDDEN_FCM_PLACE_ID} is Forge-Sync linked; changes go through its repo`
        return { ok: false, code: 1, stdout: '', stderr: msg, durationMs: 0, error: msg }
      }
      return {
        ok: true,
        code: 0,
        stdout: `[mock insert_rbxm] inserted ${req.filePath} -> ${req.parent ?? 'Workspace'}`,
        stderr: '',
        durationMs: 65
      }
    },
    vanguardsStartMcpBridge: async (port) => {
      state = { ...state, mcpBridge: { running: true, port: port ?? state.mcpBridge.port, pid: 48120 } }
      emit('vanguards:status', state)
      return state
    },
    vanguardsStopMcpBridge: async () => {
      state = { ...state, mcpBridge: { running: false, port: state.mcpBridge.port } }
      emit('vanguards:status', state)
      return state
    }
  }
}
