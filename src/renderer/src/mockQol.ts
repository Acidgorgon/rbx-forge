// Browser-preview mock of the quality-of-life features (main/services/qol): bug report assembly with
// the shared redactor, settings, a localStorage session file and a seeded "since you were away"
// digest. ?digest=none hides the digest; ?bugreport=1 opens the bug report dialog on load.
import type { BugReportInput, Digest, ErrorRecord, HarnessApi, HarnessEvents, LogLine, QolApi, QolSettings } from '@shared/types'
import { assembleBugReport } from '@shared/qol/bugReport'
import { buildDigest } from '@shared/qol/digest'
import { parseSession, serializeSession } from '@shared/qol/session'
import { DEFAULT_QOL_SETTINGS } from '@shared/qol/types'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

const SESSION_KEY = 'forge.mock.session'

export function qolMock(emit: Emit, logs: () => LogLine[], project: () => { name: string; root: string } | null): Pick<HarnessApi, keyof QolApi> {
  let settings: QolSettings = JSON.parse(JSON.stringify(DEFAULT_QOL_SETTINGS))
  const params = new URLSearchParams(location.search)
  const errors: ErrorRecord[] = [{ origin: 'renderer', message: "TypeError: Cannot read properties of undefined (reading 'id')", stack: "TypeError: Cannot read properties of undefined (reading 'id')\n    at Detail (VfxLabPage.tsx:212:31)\n    at renderWithHooks", at: Date.now() - 95_000 }]
  // Seed a couple of lines that the redactor must catch.
  const seeded: LogLine[] = [
    { service: 'agent', stream: 'info', text: 'provider anthropic ready (key sk-ant-api03-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz9Xc8Vb7Nm6)', at: Date.now() - 120_000 },
    { service: 'harness', stream: 'stderr', text: 'release: webhook https://discord.com/api/webhooks/1234567890/AbCdEfGhIjKlMnOpQrStUvWxYz012345 returned 404', at: Date.now() - 80_000 }
  ]
  const facts = (input: BugReportInput, shot: boolean) => ({
    what: input.what,
    expected: input.expected,
    at: Date.now(),
    app: { version: '0.5.0', electron: '38.2.0', chrome: '140.0.7339.133', node: '22.19.0', packaged: false },
    os: { platform: /Mac/.test(navigator.platform) ? 'darwin' : /Win/.test(navigator.platform) ? 'win32' : 'linux', release: 'browser preview', arch: 'x64' },
    page: input.page,
    tab: input.tab,
    project: project(),
    includePath: input.includePath,
    homeDir: '/Users/dev',
    logs: [...seeded, ...logs()],
    errors,
    screenshot: shot ? 'screenshot.png' : null
  })
  if (params.get('bugreport')) setTimeout(() => window.dispatchEvent(new CustomEvent('forge:report-bug')), 1200)

  return {
    async qolGetSettings() {
      return settings
    },
    async qolSetSettings(patch) {
      settings = { ...settings, ...patch, notify: { ...settings.notify, ...(patch.notify ?? {}), categories: { ...settings.notify.categories, ...(patch.notify?.categories ?? {}) } } }
      return settings
    },
    async qolBugReportStart() {
      return { screenshot: true }
    },
    async qolBugReportPreview(input) {
      return assembleBugReport(facts(input, input.includeScreenshot)).markdown
    },
    async qolBugReport(input) {
      const { markdown, redactions } = assembleBugReport(facts(input, input.includeScreenshot))
      const dir = `/Users/dev/Library/Application Support/rbx-forge/bug-reports/${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`
      await navigator.clipboard?.writeText(markdown).catch(() => undefined)
      return { dir, reportPath: `${dir}/report.md`, screenshotPath: input.includeScreenshot ? `${dir}/screenshot.png` : null, markdown, redactions }
    },
    async qolRevealPath() {},
    async qolReportError(error) {
      errors.push({ origin: 'renderer', message: error.message, stack: error.stack, at: Date.now() })
    },
    async qolLoadSession() {
      try {
        return parseSession(localStorage.getItem(SESSION_KEY))
      } catch {
        return parseSession(null)
      }
    },
    async qolSaveSession(state) {
      try {
        localStorage.setItem(SESSION_KEY, serializeSession({ ...state, savedAt: Date.now() }))
      } catch {
        // Not persisted.
      }
    },
    async qolDigest(request): Promise<Digest | null> {
      if (!settings.digest || params.get('digest') === 'none' || !project()) return null
      const now = Date.now()
      const since = request.since ?? now - 14 * 3600_000
      const digest = buildDigest({
        reason: request.reason,
        since,
        project: project()!.name,
        syncEntries: [
          { file: 'src/server/Features/Combat/CombatService.luau', action: 'pulled', instancePath: ['ServerScriptService', 'Server', 'Features', 'Combat', 'CombatService'], at: now - 3 * 3600_000 },
          { file: 'src/shared/Features/Shop/Catalog.luau', action: 'merged', instancePath: ['ReplicatedStorage', 'Shared', 'Features', 'Shop', 'Catalog'], at: now - 5 * 3600_000 },
          { file: 'src/client/UI/HudController.luau', action: 'created', instancePath: ['StarterPlayer', 'StarterPlayerScripts', 'UI', 'HudController'], at: now - 6 * 3600_000 }
        ],
        commits: [
          { hash: '9f2c1e7a3b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f', author: 'mira', email: 'mira@example.com', at: now - 2 * 3600_000, subject: 'Shop: weekly rotation and price table' },
          { hash: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b', author: 'jun', email: 'jun@example.com', at: now - 7 * 3600_000, subject: 'Fix double hit on parry window' }
        ],
        labRuns: [{ lab: 'vfx', label: 'VFX Lab run', name: 'Purple slash', ok: true, at: now - 40 * 60_000, target: { kind: 'page', page: 'vfx' } }],
        syncStatus: null,
        studioConflicts: [{ path: 'src/server/Features/Inventory/InventoryService.luau', repoSource: '', studioSource: '', reason: 'both-changed' }],
        gitConflicts: [],
        tests: { failed: 2, total: 31, failing: [{ file: 'src/shared/Features/Shop/Catalog.spec.luau', name: 'Catalog > rotates weekly' }, { file: 'src/shared/Features/Combat/Parry.spec.luau', name: 'Parry > blocks once' }] }
      })
      emit('log:line', { service: 'harness', stream: 'info', text: `[qol] digest (${request.reason}): ${digest.items.length} items`, at: now })
      return digest.items.length ? digest : null
    },
    async qolSeen() {},
    async qolTestNotify() {
      if ('Notification' in window && Notification.permission !== 'denied') {
        const ok = Notification.permission === 'granted' || (await Notification.requestPermission()) === 'granted'
        if (ok) new Notification('RBX Forge notifications work', { body: 'Click to come back to Forge.' })
      }
    }
  }
}
