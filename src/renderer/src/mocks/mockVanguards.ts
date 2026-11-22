import type { HarnessEvents, VanguardsApi, VanguardsRepoId, VanguardsRepoUpdateInfo, VanguardsStatus } from '@shared/types'
import {
  DEFAULT_VANGUARDS_BIN_DIR,
  DEFAULT_VANGUARDS_FM_DIR,
  DEFAULT_VANGUARDS_MCP_PORT,
  DEFAULT_VANGUARDS_PACKS_DIR,
  FORBIDDEN_FCM_PLACE_ID
} from '@shared/vanguardsTypes'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

const MOCK_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

export function vanguardsMock(emit: Emit): VanguardsApi {
  let repos: Record<VanguardsRepoId, VanguardsRepoUpdateInfo> = {
    ror: { id: 'ror', repoDir: 'C:\\tools\\vanguards\\roblox-object-renderer', found: true, branch: 'main', localSha: 'a1b2c3d', remoteSha: 'a1b2c3d', behind: 0, dirty: false, status: 'up-to-date' },
    rur: { id: 'rur', repoDir: 'C:\\tools\\vanguards\\roblox-ui-renderer', found: true, branch: 'main', localSha: 'e4f5a6b', remoteSha: 'e4f5a6b', behind: 0, dirty: false, status: 'up-to-date' },
    ree: { id: 'ree', repoDir: 'C:\\tools\\vanguards\\roblox-engine-emulator', found: true, branch: 'main', localSha: '1234abc', remoteSha: '1234abc', behind: 0, dirty: false, status: 'up-to-date' }
  }

  let state: VanguardsStatus = {
    binDir: DEFAULT_VANGUARDS_BIN_DIR,
    fmDir: DEFAULT_VANGUARDS_FM_DIR,
    packsDir: DEFAULT_VANGUARDS_PACKS_DIR,
    autoUpdateRepos: false,
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
    },
    repos
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
        ...(patch.packsDir !== undefined ? { packsDir: patch.packsDir || DEFAULT_VANGUARDS_PACKS_DIR } : {}),
        ...(patch.autoUpdateRepos !== undefined ? { autoUpdateRepos: patch.autoUpdateRepos } : {})
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
      outputPath: 'out/final.rbxm',
      images: ['out/sheet.jpg']
    }),
    vanguardsFmModelpreview: async (req) => ({
      ok: true,
      code: 0,
      stdout: `[mock modelpreview] rendered ${req.modelPath}`,
      stderr: '',
      durationMs: 88,
      images: ['out/sheet.jpg', 'out/iso.png']
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
    },
    vanguardsReadImage: async (filePath) => ({
      path: filePath,
      name: filePath.split(/[\\/]/).pop() || 'preview.png',
      mime: 'image/png',
      bytes: 67,
      width: 1,
      height: 1,
      dataUrl: MOCK_PNG_DATA_URL
    }),
    vanguardsListRurStories: async () => ({
      ok: true,
      stories: ['src/ReplicatedStorage/Stories/Button.story.luau', 'src/ReplicatedStorage/Stories/Card.story.luau']
    }),
    vanguardsRenderRurStory: async (req) => ({
      ok: true,
      code: 0,
      stdout: JSON.stringify({ story: req.story, width: req.width ?? 1920, height: req.height ?? 1080 }),
      stderr: '',
      durationMs: 55,
      images: [req.compare ? 'out/diff.png' : 'out/render.png']
    }),
    vanguardsLaunchRurNative: async () => ({ ok: true, pid: 49200 }),
    vanguardsRenderRorPreview: async (req) => ({
      ok: true,
      code: 0,
      stdout: `[mock ror ${req.subcommand ?? 'render'}] ${req.modelPath}`,
      stderr: '',
      durationMs: 75,
      images: [req.subcommand === 'cost' ? 'out/default.heat.png' : 'out/default.png']
    }),
    vanguardsCheckUpdates: async () => {
      emit('vanguards:updates', repos)
      return repos
    },
    vanguardsUpdateTools: async (target) => {
      const ids: VanguardsRepoId[] = target === 'all' ? ['ror', 'rur', 'ree'] : [target]
      const results = ids.map((id) => ({ id, updated: false, rebuilt: false, message: 'Already up to date' }))
      emit('vanguards:updates', repos)
      return { ok: true, results, repos }
    }
  }
}
