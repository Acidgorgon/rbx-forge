// Browser-preview mocks for Forge Doctor and the spending cap, built on the real
// shared code (doctor/checks.ts, spend/cap.ts).
//   ?doctor=ok|issues   (default issues)   ?spend=ok|warn|stop   (default warn)
import type { DoctorApi, DoctorInputs, HarnessEvents, SpendApi, SpendSettings } from '@shared/types'
import { runChecks, summarize } from '@shared/doctor/checks'
import { emptyBook, newAlerts, alertText, normalizeSettings, raiseToday, recordSpend, refusal, spendState, clearOverride } from '@shared/spend/cap'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

const q = () => new URLSearchParams(location.search)

function doctorInputs(): DoctorInputs {
  const issues = q().get('doctor') !== 'ok'
  const tools = ['rojo', 'lune', 'luau-lsp', 'wally', 'blink', 'selene', 'stylua'].map((alias) => ({ alias, pinned: '1.0.0', version: '1.0.0', state: 'ok' as const }))
  if (issues) tools[2] = { alias: 'luau-lsp', pinned: '1.69.0', version: '1.66.1', state: 'other' as never }
  return {
    platform: 'darwin',
    appVersion: '0.6.0',
    isPackaged: true,
    toolchain: { rokit: { installed: true, version: '1.2.0' }, tools },
    git: { available: true, version: '2.47.1' },
    gh: issues ? { available: true, version: '2.61.0', authed: false } : { available: true, version: '2.61.0', authed: true },
    python: null,
    studioInstall: { installed: true, path: '/Applications/RobloxStudio.app' },
    bridge: { port: 34880, listening: true, plugin: { installed: true, version: issues ? 2 : 3, bundled: 3, dir: '~/Documents/Roblox/Plugins', ...(issues ? { outdated: true } : {}) }, studio: { connected: !issues, place: 'GenTree', pluginVersion: issues ? undefined : 3, lastSeen: Date.now() - 4 * 60_000 } },
    legacyPlugins: issues ? ['StudioSync.rbxmx'] : [],
    ports: [
      { port: 34872, label: 'rojo serve (GenTree)', state: 'ours', expected: true },
      { port: 34875, label: 'rojo serve (menu)', state: issues ? 'other' : 'free', expected: false }
    ],
    rojo: 'running',
    sync: { engine: 'forge', places: [{ projectFile: 'default.project.json', gate: issues ? 'blocked' : 'clear', conflicts: issues ? 1 : 0, connected: true }], pendingStudioEdits: issues ? 2 : 0 },
    keys: [
      { provider: 'anthropic', label: 'Anthropic', set: true, isDefault: true },
      { provider: 'openai', label: 'OpenAI', set: true, isDefault: false },
      { provider: 'gemini', label: 'Google Gemini', set: false, isDefault: false },
      { provider: 'ollama', label: 'Ollama', set: false, isDefault: false, local: true }
    ],
    openCloud: { set: true, introspect: { enabled: true, expired: false, scopes: issues ? ['asset:read'] : ['asset:read', 'asset:write'] } },
    openAiKey: true,
    disk: [
      { label: 'App data', path: '~/Library/Application Support/rbx-forge', freeBytes: 182 * 1024 ** 3 },
      { label: 'Project', path: '~/Roblox/GenTree', freeBytes: issues ? 3.4 * 1024 ** 3 : 182 * 1024 ** 3 }
    ],
    project: { root: '~/Roblox/GenTree', projectFiles: [{ file: 'default.project.json', ok: true, servePort: 34872 }, { file: 'menu.project.json', ok: true, servePort: 34875 }], wallyToml: true, packagesInstalled: !issues, rokitToml: true, projectToolsMissing: [], sourcemap: { exists: true, ageMs: 40 * 60_000 } },
    updater: { state: 'none' },
    screenRecording: issues ? 'denied' : 'granted'
  }
}

export function doctorMock(emit: Emit): DoctorApi {
  let last: ReturnType<typeof summarize> | null = null
  return {
    async doctorRun() {
      await new Promise((r) => setTimeout(r, 650))
      const now = Date.now()
      last = summarize(runChecks(doctorInputs(), now), { at: now, ms: 642, appVersion: '0.6.0', platform: 'darwin' })
      emit('doctor:report', last)
      return last
    },
    async doctorLast() {
      return last
    },
    async doctorFix(action) {
      await new Promise((r) => setTimeout(r, 400))
      return { ok: true, message: `Mock: ran ${action}.` }
    }
  }
}

export function spendMock(emit: Emit): SpendApi & { chargeMock(cost: number): void } {
  const mode = q().get('spend') ?? 'warn'
  let settings: SpendSettings = normalizeSettings({ dailyUsd: 5, monthlyUsd: 60 })
  const book = emptyBook()
  const now = Date.now()
  const day = 86_400_000
  for (let i = 13; i >= 1; i--) {
    recordSpend(book, { at: now - i * day, provider: 'anthropic', source: 'chat', costUsd: 0.6 + ((i * 37) % 10) / 10 })
    recordSpend(book, { at: now - i * day, provider: 'openai', source: i % 3 ? 'labs' : 'images', costUsd: 0.2 + ((i * 13) % 7) / 10 })
  }
  const today = mode === 'stop' ? 5.08 : mode === 'ok' ? 1.2 : 4.12
  recordSpend(book, { at: now - 3600_000, provider: 'anthropic', source: 'chat', costUsd: today * 0.55 })
  recordSpend(book, { at: now - 3000_000, provider: 'anthropic', source: 'labs', costUsd: today * 0.2 })
  recordSpend(book, { at: now - 2000_000, provider: 'openai', source: 'images', costUsd: today * 0.17 })
  recordSpend(book, { at: now - 1000_000, provider: 'openai', source: 'orchestrator', costUsd: today * 0.08 })
  newAlerts(book, settings, now)
  const state = () => spendState(book, settings, Date.now())
  const changed = () => emit('spend:changed', state())
  return {
    async spendState() {
      return state()
    },
    async spendSetSettings(patch) {
      settings = normalizeSettings({ ...settings, ...patch })
      changed()
      return state()
    },
    async spendRaiseToday(amount) {
      raiseToday(book, amount ?? state().raiseStep, Date.now())
      changed()
      return state()
    },
    async spendClearOverride() {
      clearOverride(book, Date.now())
      changed()
      return state()
    },
    chargeMock(cost) {
      const block = refusal(book, settings, Date.now())
      if (block) {
        emit('spend:alert', { level: 'stop', window: 'day', text: block, refused: true })
        return
      }
      recordSpend(book, { at: Date.now(), provider: 'anthropic', source: 'chat', costUsd: cost })
      for (const a of newAlerts(book, settings, Date.now())) emit('spend:alert', { level: a.level, window: a.window.kind, text: alertText(a.level, a.window) })
      changed()
    }
  }
}
