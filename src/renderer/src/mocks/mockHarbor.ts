import type { HarborApi, HarborLibId, HarborStatus, HarnessEvents } from '@shared/types'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

export function harborMock(emit: Emit): HarborApi {
  let state: HarborStatus = {
    projectRoot: 'E:/Roblox/SampleGame',
    libsConfigPath: 'src/shared/Modules/LibsConfig.luau',
    watcherActive: true,
    toggles: [
      { key: 'UseCurrent', value: true, line: 3, libId: 'current' },
      { key: 'UseRipple', value: true, line: 4, libId: 'ripple' },
      { key: 'UseAnchor', value: false, line: 5, libId: 'anchor' },
      { key: 'UseTide', value: true, line: 6, libId: 'tide' },
      { key: 'UseLighthouse', value: false, line: 7, libId: 'lighthouse' }
    ],
    libs: {
      current: {
        id: 'current',
        name: 'Current',
        detected: true,
        enabled: true,
        version: '0.1.2',
        cliPath: 'current',
        sourcePaths: ['src/shared/Current'],
        schemaFiles: ['tools/current-schema.luau', 'events.blink'],
        configKey: 'UseCurrent'
      },
      ripple: {
        id: 'ripple',
        name: 'Ripple',
        detected: true,
        enabled: true,
        sourcePaths: ['src/shared/Ripple'],
        schemaFiles: ['src/shared/Ripple/clubsync.ripple'],
        configKey: 'UseRipple'
      },
      anchor: {
        id: 'anchor',
        name: 'Anchor',
        detected: true,
        enabled: false,
        sourcePaths: ['src/shared/Anchor'],
        schemaFiles: [],
        configKey: 'UseAnchor'
      },
      tide: {
        id: 'tide',
        name: 'Tide',
        detected: true,
        enabled: true,
        sourcePaths: ['src/shared/Tide'],
        schemaFiles: [],
        configKey: 'UseTide'
      },
      lighthouse: {
        id: 'lighthouse',
        name: 'Lighthouse',
        detected: true,
        enabled: false,
        sourcePaths: ['src/shared/Lighthouse'],
        schemaFiles: [],
        configKey: 'UseLighthouse'
      }
    }
  }

  return {
    harborStatus: async () => state,
    harborRefresh: async () => {
      emit('harbor:status', state)
      return state
    },
    harborToggleLib: async (key, enabled) => {
      const nextToggles = state.toggles.map((t) => (t.key === key ? { ...t, value: enabled } : t))
      const nextLibs = { ...state.libs }
      const hit = nextToggles.find((t) => t.key === key)
      if (hit?.libId) {
        nextLibs[hit.libId] = { ...nextLibs[hit.libId], enabled }
      }
      state = { ...state, toggles: nextToggles, libs: nextLibs }
      emit('harbor:status', state)
      return state
    },
    harborGenerate: async (lib: HarborLibId) => {
      const res = {
        ok: true,
        lib,
        code: 0,
        output: `[mock] ${state.libs[lib].name} schema checked/generated`,
        ranCli: state.libs[lib].cliPath
      }
      state = { ...state, lastGenerate: { lib, at: Date.now(), ok: true, output: res.output } }
      emit('harbor:generated', res)
      emit('harbor:status', state)
      return res
    },
    harborScaffold: async (lib: HarborLibId) => {
      emit('harbor:status', state)
      return { ok: true, lib, created: [], message: `[mock] Scaffolded ${state.libs[lib].name}` }
    }
  }
}
