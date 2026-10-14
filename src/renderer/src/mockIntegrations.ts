// Browser-preview mock of the integrated services in HarnessApi (IntegrationApi): collaboration,
// release, Lune tests, analytics, token usage, orchestrator and feature rename. mock.ts spreads it
// into its api object. All data is fake but shaped like the real services' results.
import type {
  AnalyticsSeries,
  AnalyticsSignal,
  AnalyticsStatus,
  BoardView,
  BudgetLimits,
  ChatMessage,
  ClaimView,
  CheckResult,
  HarnessEvents,
  IntegrationApi,
  OrchestrateMode,
  PreflightReport,
  ReleaseHistoryEntry,
  ReleasePlan,
  ReleaseSecretsStatus,
  ReleaseUserSettings,
  RunSummary,
  SpecFile,
  TaskView,
  TestCaseResult,
  UsageSnapshot,
  UsageSummary
} from '@shared/types'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const DAY = 86_400_000
const now = () => Date.now()
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10)

// ---------------------------------------------------------------- collab data

let claims: ClaimView[] = [
  { who: 'Sam Lee', what: 'feature:Shop', since: new Date(now() - 3 * 3600_000).toISOString(), note: 'new sword tiers', stale: false, contested: false, others: [] },
  { who: 'Jordan', what: 'src/server/Features/Data', since: new Date(now() - 5 * DAY).toISOString(), stale: true, contested: false, others: [] }
]

let forgeConfig = {
  conventions: 'Services end in Service, controllers in Controller. Configs live in src/shared/Configs.',
  aiRules: 'Never change prices in Configs without asking. Keep remotes in events.blink.',
  testScenarios: [{ name: 'Buy a sword', steps: ['Join', 'Open shop', 'Buy Starter Sword'] }],
  lint: { selene: true, stylua: false },
  branchPrefix: 'feature/',
  version: '1.4.2',
  publish: { mode: 'studio' as const, placeId: 1234567, universeId: 7654321 }
}

// ---------------------------------------------------------------- release data

const releaseHistory: ReleaseHistoryEntry[] = [
  { tag: 'v1.4.2', version: '1.4.2', at: now() - 2 * DAY, by: 'Alex', mode: 'studio', changelog: '### Features\n- Shop: sword tiers\n\n### Fixes\n- Data: save on leave', notified: true },
  { tag: 'v1.4.1', version: '1.4.1', at: now() - 9 * DAY, by: 'Sam Lee', mode: 'studio', changelog: '### Fixes\n- Inventory: stack overflow on 999 items', notified: true }
]
const secretsState: ReleaseSecretsStatus = { openCloudApiKey: false, discordWebhook: true, webhookHint: 'discord.com/api/webhooks/1234…/…9xQ' }
let releaseSettings: ReleaseUserSettings = { notifications: { release: true, publish: true, sync: false, push: false, 'test-failure': true } }

function checks(): CheckResult[] {
  return [
    { id: 'git', label: 'Git is clean and up to date', blocking: true, status: 'pass', summary: 'main is up to date with origin/main', durationMs: 420 },
    { id: 'studio-sync', label: 'No Studio conflicts', blocking: true, status: 'pass', summary: 'No held conflicts', durationMs: 3 },
    { id: 'blink', label: 'events.blink compiles', blocking: true, status: 'pass', summary: '12 events, 2 functions', durationMs: 310 },
    { id: 'lune', label: 'Headless tests (Lune)', blocking: true, status: 'pass', summary: '24 passed (6 files, 180 ms)', durationMs: 900 },
    { id: 'selene', label: 'Selene', blocking: false, status: 'warn', summary: '2 warnings', details: ['src/server/Features/Shop/init.luau:41 unused_variable: `price`'], durationMs: 650 }
  ]
}
function preflight(): PreflightReport {
  return { ok: true, checks: checks(), blockers: [] }
}
function plan(): ReleasePlan {
  return {
    root: '/Users/you/Games/SwordFight',
    detection: { mode: 'studio', source: 'default', fullyManaged: false, reasons: ['Code folders are $ignoreUnknownInstances: maps and models live only in Studio.'] },
    mode: 'studio',
    placeId: 1234567,
    universeId: 7654321,
    placeIdChoices: [1234567],
    versionType: 'Published',
    version: { current: '1.4.2', latestTag: 'v1.4.2', projectVersion: '1.4.2', storage: 'project', suggestedBump: 'minor', next: { patch: '1.4.3', minor: '1.5.0', major: '2.0.0' } },
    changelog: {
      since: 'v1.4.2',
      commits: [
        { hash: 'a1b2c3d', author: 'Sam Lee', at: now() - DAY, subject: 'feat(shop): legendary tier', kind: 'feature', scope: 'shop', breaking: false, features: ['Shop'] },
        { hash: 'd4e5f6a', author: 'Alex', at: now() - 3600_000, subject: 'fix(data): retry DataStore on throttle', kind: 'fix', scope: 'data', breaking: false, features: ['Data'] }
      ],
      studio: [{ at: now() - 7200_000, path: 'src/client/UI/ShopFrame.luau', action: 'pull' }],
      authors: ['Alex', 'Sam Lee'],
      markdown: '## v1.5.0\n\n### Features\n- Shop: legendary tier (Sam Lee)\n\n### Fixes\n- Data: retry DataStore on throttle (Alex)\n\n_Studio: 1 script synced._'
    },
    preflight: preflight(),
    hasOpenCloudKey: secretsState.openCloudApiKey,
    hasDiscordWebhook: secretsState.discordWebhook,
    warnings: []
  }
}

// ---------------------------------------------------------------- tests data

const specs: SpecFile[] = [
  { file: 'src/shared/Modules/Inventory.spec.luau', instancePath: ['ReplicatedStorage', 'Shared', 'Modules', 'Inventory.spec'], realm: 'server' },
  { file: 'src/shared/Modules/Currency.spec.luau', instancePath: ['ReplicatedStorage', 'Shared', 'Modules', 'Currency.spec'], realm: 'server' },
  { file: 'src/server/Features/Shop/Shop.spec.luau', instancePath: ['ServerScriptService', 'Server', 'Features', 'Shop', 'Shop.spec'], realm: 'server' },
  { file: 'src/client/Client/Controllers/ShopController.spec.luau', instancePath: ['StarterPlayer', 'StarterPlayerScripts', 'Client', 'Controllers', 'ShopController.spec'], realm: 'client' }
]
let lastRun: RunSummary | null = null
let watching = false
let runSeq = 1

function fakeResults(): TestCaseResult[] {
  const r: TestCaseResult[] = []
  for (const s of specs) {
    const base = s.file.split('/').pop()!.replace('.spec.luau', '')
    r.push({ file: s.file, suite: base, test: 'starts empty', status: 'pass', ms: 0.4 })
    r.push({ file: s.file, suite: base, test: 'adds and removes', status: 'pass', ms: 0.9 })
  }
  r.push({
    file: 'src/server/Features/Shop/Shop.spec.luau',
    suite: 'Shop > Purchase',
    test: 'rejects when coins are short',
    status: 'fail',
    ms: 1.7,
    error: { message: 'expected -200 to be greater than or equal to 0', line: 37, stack: 'src/server/Features/Shop/init.luau:52' }
  })
  r.push({ file: 'src/shared/Modules/Currency.spec.luau', suite: 'Currency', test: 'formats millions', status: 'todo', ms: 0 })
  return r
}

// ---------------------------------------------------------------- analytics data

function series(metric: string, days: number, base: number, unit = 'users'): AnalyticsSeries {
  const points = Array.from({ length: days }, (_, i) => {
    const t = now() - (days - i) * DAY
    const wave = Math.sin(i / 2.3) * base * 0.08 + (i / days) * base * 0.12
    return { t: isoDay(t), v: Math.round(base + wave), ...(i === days - 1 ? { flag: 'projected' as const } : {}) }
  })
  return { metric, source: 'api', granularity: 'day', unit, aggregation: 'sum', points }
}

let analyticsStatus: AnalyticsStatus = {
  universeId: 7654321,
  placeId: 1234567,
  hasApiKey: true,
  poller: { running: true, intervalMinutes: 15, snapshots: 214, lastAt: new Date(now() - 6 * 60_000).toISOString() },
  imports: [{ metric: 'Revenue', label: 'Revenue (Robux)', points: 28, first: isoDay(now() - 30 * DAY), last: isoDay(now() - 2 * DAY), importedAt: new Date(now() - DAY).toISOString(), file: 'revenue.csv' }]
}

// ---------------------------------------------------------------- usage data

const zero: UsageSummary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpricedRequests: 0, requests: 0 }
let budget: BudgetLimits = { agentMaxTokens: 400_000, agentMaxCostUsd: 1, chatSoftTokens: 300_000, chatSoftCostUsd: 2, warnAt: 0.8, tokenMetric: 'effective' }

function usage(scope: UsageSnapshot['scope'], id: string): UsageSnapshot {
  const totals: UsageSummary =
    scope === 'day'
      ? { input: 182_000, output: 41_000, cacheRead: 1_240_000, cacheWrite: 96_000, costUsd: 1.84, unpricedRequests: 0, requests: 63 }
      : scope === 'agent'
        ? { input: 21_000, output: 3_400, cacheRead: 88_000, cacheWrite: 12_000, costUsd: 0.04, unpricedRequests: 0, requests: 9 }
        : { input: 38_000, output: 9_100, cacheRead: 412_000, cacheWrite: 24_000, costUsd: 0.61, unpricedRequests: 0, requests: 14 }
  return {
    scope,
    id,
    totals,
    budget: { level: 'ok', fraction: scope === 'agent' ? 0.12 : 0.27 },
    model: 'claude-opus-5-5',
    provider: 'anthropic',
    ...(scope === 'chat' ? { route: { tier: 'chosen' as const, reason: 'default model' } } : {})
  }
}

// ---------------------------------------------------------------- orchestrator data

const boards: BoardView[] = []
const modes = new Map<string, OrchestrateMode>()

function task(runId: string, id: string, role: TaskView['role'], goal: string, state: TaskView['state'], extra: Partial<TaskView> = {}): TaskView {
  return { id, runId, role, goal, state, model: role === 'lead' || role === 'builder' ? 'claude-opus-5-5' : 'claude-haiku-5-5', round: 1, dependsOn: [], files: [], filesChanged: [], tokens: 0, costUsd: 0, ...extra }
}

function demoBoard(request: string): BoardView {
  const runId = `o-${Math.random().toString(16).slice(2, 10)}`
  return {
    runId,
    request,
    state: 'running',
    round: 1,
    tasks: [
      task(runId, 'lead-plan', 'lead', 'Plan the work', 'done', { summary: '3 tasks: scout the shop flow, build the tier, test it', resultStatus: 'done', tokens: 14_200, costUsd: 0.09 }),
      task(runId, 's1', 'scout', 'Find where purchases are validated', 'done', { summary: 'ShopService.Purchase validates coins in src/server/Features/Shop/init.luau:40-61', resultStatus: 'done', tokens: 8_100, costUsd: 0.004 }),
      task(runId, 'b1', 'builder', 'Add the legendary tier to Shop config and service', 'running', { dependsOn: ['s1'], files: ['src/shared/Features/Shop/Config.luau', 'src/server/Features/Shop/init.luau'], tokens: 22_500, costUsd: 0.18 }),
      task(runId, 't1', 'tester', 'Spec the purchase rules', 'blocked', { dependsOn: ['b1'], detail: 'waiting on b1', files: ['src/server/Features/Shop/Shop.spec.luau'] })
    ],
    changeRequests: [{ id: 'cr1', taskId: 'b1', file: 'events.blink', change: 'add event ShopTierUnlocked (Server -> Client, Reliable, Data: u8)', at: now() }],
    tokens: 44_800,
    costUsd: 0.27,
    startedAt: now() - 40_000
  }
}

// ---------------------------------------------------------------- api

export function integrationsMock(emit: Emit, log: (text: string) => void): IntegrationApi {
  return {
    // Collaboration
    async joinProject(input) {
      for (const step of ['clone', 'rokit', 'wally', 'validate'] as const) {
        emit('collab:joinProgress', { step, state: 'running', ...(step === 'clone' ? { percent: 40 } : {}) })
        await delay(350)
        emit('collab:joinProgress', { step, state: 'done' })
      }
      const name = input.name || input.repoUrl.split('/').pop()?.replace(/\.git$/, '') || 'game'
      return { root: `${input.parentDir}/${name}`, projectName: name, steps: [{ step: 'clone', state: 'done' }, { step: 'rokit', state: 'done' }, { step: 'wally', state: 'done' }, { step: 'validate', state: 'done' }], notes: [] }
    },
    async incomingChanges(options) {
      await delay(300)
      const files = [
        { path: 'src/server/Features/Shop/init.luau', status: 'modified' as const, added: 24, deleted: 6, binary: false, feature: 'Shop', category: 'Services' as const, diff: '@@ -40,6 +40,24 @@\n-local MAX_TIER = 3\n+local MAX_TIER = 4' },
        { path: 'src/shared/Features/Shop/Config.luau', status: 'modified' as const, added: 9, deleted: 0, binary: false, feature: 'Shop', category: 'Configs' as const }
      ]
      return {
        isRepo: true,
        upstream: 'origin/main',
        fetched: true,
        commits: [{ hash: 'a1b2c3d4', author: 'Sam Lee', email: 'sam@example.com', at: now() - 2 * 3600_000, subject: 'feat(shop): legendary tier' }],
        files,
        groups: [{ key: 'feature:Shop', label: 'Shop', feature: 'Shop', items: files }],
        local: [{ path: 'src/server/Features/Shop/init.luau', status: 'modified', added: 2, deleted: 1, binary: false, feature: 'Shop', category: 'Services' }],
        overlap: ['src/server/Features/Shop/init.luau'],
        ...(options?.summarize ? { summary: '- Sam added a legendary sword tier (Shop config + service).\n- Overlaps your local edit to ShopService: pull before you continue.' } : {})
      }
    },
    async activityFeed() {
      return [
        { at: now() - 2 * 3600_000, who: 'Sam Lee', kind: 'commit', files: [{ path: 'src/server/Features/Shop/init.luau', change: 'M' }], message: 'feat(shop): legendary tier', commit: 'a1b2c3d4' },
        { at: now() - 3 * 3600_000, who: 'Studio', kind: 'studio', files: [{ path: 'src/client/UI/ShopFrame.luau', change: 'pull' }], message: 'Studio edit synced', studioAction: 'pull' },
        { at: now() - DAY, who: 'Alex', kind: 'commit', files: [{ path: 'src/server/Features/Data/init.luau', change: 'M' }], message: 'fix(data): retry on throttle', commit: 'd4e5f6a7' }
      ]
    },
    async fileHistory(path, limit) {
      return [
        { commit: 'a1b2c3d4', author: 'Sam Lee', at: now() - 2 * 3600_000, subject: 'feat(shop): legendary tier', path, change: 'M' },
        { commit: 'beefcafe', author: 'Alex', at: now() - 12 * DAY, subject: 'chore: init', path, change: 'A' }
      ].slice(0, limit ?? 50)
    },
    async getForgeConfig() {
      return { exists: true, config: { ...forgeConfig } }
    },
    async setForgeConfig(config) {
      forgeConfig = { ...forgeConfig, ...(config as typeof forgeConfig) }
      return { ...forgeConfig }
    },
    async startFeatureBranch(name) {
      await delay(300)
      return { branch: `feature/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, from: 'main', synced: true }
    },
    async openPullRequest(input) {
      await delay(400)
      return { kind: 'created', url: 'https://github.com/example/swordfight/pull/42', branch: 'feature/legendary-tier', base: input.base ?? 'main' }
    },
    async listOpenPRs() {
      return { available: true, prs: [{ number: 41, title: 'Inventory stacking', url: 'https://github.com/example/swordfight/pull/41', author: 'Jordan', branch: 'feature/stacking', draft: false, updatedAt: new Date(now() - 5 * 3600_000).toISOString() }] }
    },
    async listClaims() {
      return claims
    },
    async claim(what, note) {
      claims = [...claims.filter((c) => !(c.what === what && c.who === 'Alex')), { who: 'Alex', what, since: new Date().toISOString(), ...(note ? { note } : {}), stale: false, contested: claims.some((c) => c.what === what), others: claims.filter((c) => c.what === what).map((c) => c.who), mine: true }]
      emit('collab:claims', claims)
      return claims
    },
    async releaseClaim(what) {
      claims = claims.filter((c) => !(c.what === what && (c.mine || c.who === 'Alex')))
      emit('collab:claims', claims)
      return claims
    },
    async runLint() {
      const problems = [{ path: 'src/server/Features/Shop/init.luau', line: 41, col: 8, severity: 'warning' as const, message: 'price is assigned a value, but never used', source: 'selene' as const, code: 'unused_variable' }]
      return { selene: { ran: true, problems }, stylua: { ran: false, problems: [], note: 'stylua not found: add JohnnyMorganz/StyLua to rokit.toml' } }
    },
    async preSyncCheck() {
      return { files: ['src/server/Features/Shop/init.luau'], problems: [], errors: 0, warnings: 0, ok: true, notes: [] }
    },

    // Release
    async releasePlan() {
      await delay(400)
      for (const c of checks()) emit('release:check', { root: plan().root, result: c })
      return plan()
    },
    async releasePreflight() {
      await delay(300)
      return preflight()
    },
    async releaseRun(input) {
      const steps = ['preflight', 'version', 'tag', 'push', 'notify'] as const
      for (const id of steps) {
        emit('release:step', { root: plan().root, step: { id, state: 'running' } })
        await delay(300)
        emit('release:step', { root: plan().root, step: { id, state: 'done' } })
      }
      const version = input.version ?? plan().version.next[input.bump ?? 'minor']
      const record = { version, tag: `v${version}`, mode: input.mode, at: now(), by: 'Alex', changelog: input.changelog ?? plan().changelog.markdown, notified: true, studioPublishPending: input.mode === 'studio' }
      releaseHistory.unshift(record)
      return { ok: true, record, steps: steps.map((id) => ({ id, state: 'done' as const })), ...(input.mode === 'studio' ? { nextAction: 'Publish from Studio now (File > Publish to Roblox).' } : {}) }
    },
    async releaseMarkStudioPublished(tag) {
      const entry = releaseHistory.find((h) => h.tag === tag) ?? releaseHistory[0]
      entry.studioPublishPending = false
      return entry
    },
    async releaseHistory() {
      return releaseHistory
    },
    async releaseSecretsStatus() {
      return { ...secretsState }
    },
    async releaseSetSecret(kind) {
      secretsState[kind] = true
      if (kind === 'discordWebhook') secretsState.webhookHint = 'discord.com/api/webhooks/1234…/…9xQ'
      return { ...secretsState }
    },
    async releaseClearSecret(kind) {
      secretsState[kind] = false
      if (kind === 'discordWebhook') delete secretsState.webhookHint
      return { ...secretsState }
    },
    async releaseGetSettings() {
      return releaseSettings
    },
    async releaseSetSettings(next) {
      releaseSettings = { ...releaseSettings, ...next, notifications: { ...releaseSettings.notifications, ...(next.notifications ?? {}) } }
      return releaseSettings
    },
    async releaseSetProjectPublish(config) {
      forgeConfig = { ...forgeConfig, publish: { ...forgeConfig.publish, ...(config as typeof forgeConfig.publish) } }
      return config
    },
    async releaseTestNotify() {
      await delay(300)
      return { sent: true }
    },
    async releaseChoosePlaceFile() {
      return '/Users/you/Exports/SwordFight.rbxl'
    },

    // Lune tests
    async testsStatus() {
      return { available: true, path: '~/.rokit/bin/lune', version: '0.11.0' }
    },
    async testsDiscover() {
      return specs
    },
    async testsRun(request) {
      const id = runSeq++
      const files = request.scope.kind === 'file' ? [request.scope.file] : specs.map((s) => s.file)
      emit('tests:progress', { runId: id, kind: 'start', files })
      const results = fakeResults().filter((r) => files.includes(r.file))
      for (const result of results) {
        await delay(40)
        emit('tests:progress', { runId: id, kind: 'test', result })
      }
      const failed = results.filter((r) => r.status === 'fail').length
      const passed = results.filter((r) => r.status === 'pass').length
      lastRun = { id, state: failed ? 'failed' : 'passed', passed, failed, skipped: results.length - passed - failed, total: results.length, ms: 180, files, results, logs: [{ file: files[0], test: 'Inventory > adds and removes', level: 'print', text: 'added Sword x1' }] }
      emit('tests:progress', { runId: id, kind: 'end', summary: lastRun })
      log(`[tests] ${failed ? `FAIL ${failed} failed` : 'PASS'}, ${passed} passed`)
      return lastRun
    },
    async testsCancel() {
      return false
    },
    async testsWatch(on) {
      watching = on
      return watching
    },
    async testsCreateSpec(modulePath) {
      const path = modulePath.replace(/\.luau$/, '.spec.luau')
      const name = modulePath.split('/').pop()!.replace(/\.luau$/, '')
      return { path, created: true, content: `local ${name} = require(script.Parent.${name})\n\ndescribe("${name}", function()\n\tit("works", function()\n\t\texpect(${name}).toBeTruthy()\n\tend)\nend)\n`, requirePath: `script.Parent.${name}` }
    },
    async testsLast() {
      return lastRun
    },

    // Analytics
    async analyticsStatus() {
      return analyticsStatus
    },
    async analyticsSetApiKey() {
      analyticsStatus = { ...analyticsStatus, hasApiKey: true }
      return analyticsStatus
    },
    async analyticsClearApiKey() {
      analyticsStatus = { ...analyticsStatus, hasApiKey: false }
      return analyticsStatus
    },
    async analyticsSetExperience(ids) {
      analyticsStatus = { ...analyticsStatus, placeId: ids.placeId ?? analyticsStatus.placeId, universeId: ids.universeId ?? analyticsStatus.universeId }
      return analyticsStatus
    },
    async analyticsOverview() {
      await delay(250)
      const range = { start: isoDay(now() - 8 * DAY), end: isoDay(now() - DAY) }
      const previous = { start: isoDay(now() - 15 * DAY), end: isoDay(now() - 8 * DAY) }
      return {
        range,
        previous,
        kpis: [
          { metric: 'DailyActiveUsers', label: 'DAU', unit: 'users', source: 'api', current: 4820, previous: 4410, change: 0.093 },
          { metric: 'D1Retention', label: 'D1 retention', unit: 'ratio', source: 'api', current: 0.214, previous: 0.238, change: -0.101 },
          { metric: 'AverageSessionLength', label: 'Session length', unit: 'seconds', source: 'api', current: 812, previous: 790, change: 0.028 },
          { metric: 'DailyRevenue', label: 'Revenue', unit: 'robux', source: 'api', current: 38_400, previous: 35_100, change: 0.094 }
        ],
        signals: <AnalyticsSignal[]>[
          { id: 'ret-drop', metric: 'D1Retention', severity: 'warn', text: 'D1 retention fell 2.4 points after v1.4.2 (onboarding changes in that release).', evidence: { before: 0.238, after: 0.214, release: 'v1.4.2' } },
          { id: 'dau-up', metric: 'DailyActiveUsers', severity: 'good', text: 'DAU up 9% week over week, mostly from Home recommendations.', evidence: { change: 0.093 } }
        ],
        live: { universeId: 7654321, rootPlaceId: 1234567, name: 'Sword Fight', visits: 1_284_331, playing: 212, favorites: 18_420, upVotes: 9_310, downVotes: 1_022, maxPlayers: 20 },
        notes: []
      }
    },
    async analyticsSeries(query) {
      await delay(200)
      return { range: { start: isoDay(now() - 29 * DAY), end: isoDay(now() - DAY) }, source: 'api', series: [series(query.metric, 28, 4500)], notes: [], releases: [{ tag: 'v1.4.2', at: new Date(now() - 2 * DAY).toISOString() }] }
    },
    async analyticsAcquisition() {
      const range = { start: isoDay(now() - 8 * DAY), end: isoDay(now() - DAY) }
      const previous = { start: isoDay(now() - 15 * DAY), end: isoDay(now() - 8 * DAY) }
      return {
        range,
        previous,
        bySource: [
          { source: 'HomeRecommendation', impressions: 412_000, impressionsPrev: 360_000, plays: 9_800, playsPrev: 8_100, qualifiedPlays: 7_200, playsPerImpression: 0.0238, playsPerImpressionPrev: 0.0225 },
          { source: 'Search', impressions: 52_000, impressionsPrev: 55_000, plays: 2_100, playsPrev: 2_250, qualifiedPlays: 1_700, playsPerImpression: 0.0404, playsPerImpressionPrev: 0.0409 }
        ],
        totals: { impressions: 464_000, plays: 11_900, qualifiedPlays: 8_900, impressionsChange: 0.11, playsChange: 0.15 },
        homeRecs: [{ metric: 'HomeRecommendationPlayThroughRate', label: 'Home recs PTR', current: 0.0238, previous: 0.0225, change: 0.058 }],
        newVsReturning: [
          { segment: 'new', dau: 1_900, change: 0.14 },
          { segment: 'returning', dau: 2_920, change: 0.06 }
        ],
        publicTrend: { newVisits: 61_200, newVisitsChange: 0.12, newFavorites: 640, likeRatio: 0.901 },
        rates: { qualifiedPlayRate: 0.748 },
        signals: [],
        notes: []
      }
    },
    async analyticsImportCsv(input) {
      await delay(300)
      return { series: [{ metric: 'Revenue', label: 'Revenue (Robux)', points: 28, importedAt: new Date().toISOString(), file: input.path.split('/').pop() }], warnings: [] }
    },
    async analyticsRemoveImport() {
      analyticsStatus = { ...analyticsStatus, imports: [] }
      return true
    },
    async analyticsPoller(running) {
      analyticsStatus = { ...analyticsStatus, poller: { ...analyticsStatus.poller, running } }
      return analyticsStatus
    },
    async analyticsPollNow() {
      const snapshot = { at: new Date().toISOString(), visits: 1_284_400, playing: 218, favorites: 18_421, up: 9_311, down: 1_022 }
      emit('analytics:snapshot', snapshot)
      return snapshot
    },
    async analyticsCatalog() {
      return {
        items: [
          { kind: 'gamePass', id: 11111, name: 'VIP', isForSale: true, priceRobux: 399 },
          { kind: 'developerProduct', id: 22222, name: '1,000 Coins', isForSale: true, priceRobux: 49 }
        ],
        notes: []
      }
    },
    async analyticsSnippet(input) {
      return {
        kind: input.kind,
        files: [{ path: 'src/server/Features/Telemetry/init.luau', code: 'local AnalyticsService = game:GetService("AnalyticsService")\n\nlocal Telemetry = {}\n\nreturn Telemetry\n' }],
        call: 'Telemetry.Custom(player, "ShopOpened")',
        notes: ['Custom events show up in the Creator Dashboard after about a day.']
      }
    },

    // Usage and budgets
    async getUsage(scope, id) {
      return usage(scope, id ?? (scope === 'day' ? isoDay(now()) : ''))
    },
    async getUsageHistory(days) {
      return Array.from({ length: days }, (_, i) => {
        const day = isoDay(now() - (days - 1 - i) * DAY)
        const k = (i % 5) + 1
        return { day, totals: i === days - 1 ? usage('day', day).totals : { ...zero, input: 30_000 * k, output: 7_000 * k, cacheRead: 200_000 * k, cacheWrite: 15_000 * k, costUsd: 0.31 * k, requests: 11 * k } }
      })
    },
    async getBudget() {
      return budget
    },
    async setBudget(limits) {
      budget = { ...budget, ...limits }
      return budget
    },

    // Orchestrator
    async startOrchestration(_chatId, text) {
      const board = demoBoard(text)
      boards.unshift(board)
      emit('orchestrator:event', { type: 'board', board })
      setTimeout(() => {
        const done: BoardView = {
          ...board,
          state: 'done',
          tasks: board.tasks.map((t) => (t.state === 'done' ? t : { ...t, state: 'done', resultStatus: 'done', summary: t.role === 'builder' ? 'Added tier 4 (Legendary) to Config and ShopService' : '3 specs pass', filesChanged: t.files })),
          answer: 'Added the legendary tier (Config + ShopService) with specs; events.blink change request applied by the lead.',
          finishedAt: now()
        }
        boards[boards.indexOf(board)] = done
        emit('orchestrator:event', { type: 'finished', runId: board.runId, board: done })
      }, 6000)
      return board
    },
    async getOrchestrations() {
      return boards
    },
    async getTaskTranscript(runId, taskId): Promise<ChatMessage[]> {
      const agentId = `orch:${runId}:${taskId}`
      return [
        { id: `${agentId}-1`, role: 'tool', text: 'find_symbol', tool: { name: 'find_symbol', input: 'name=ShopService.Purchase' }, at: now() - 30_000, agentId },
        { id: `${agentId}-2`, role: 'assistant', text: 'Purchase validates coins at src/server/Features/Shop/init.luau:40-61.', at: now() - 25_000, agentId }
      ]
    },
    async cancelOrchestration(runId) {
      const i = boards.findIndex((b) => b.runId === runId)
      if (i >= 0) {
        boards[i] = { ...boards[i], state: 'cancelled', finishedAt: now() }
        emit('orchestrator:event', { type: 'finished', runId, board: boards[i] })
      }
    },
    async cancelOrchestrationTask(runId, taskId) {
      const b = boards.find((x) => x.runId === runId)
      if (!b) return
      b.tasks = b.tasks.map((t) => (t.id === taskId ? { ...t, state: 'cancelled', detail: 'cancelled by user' } : t))
      emit('orchestrator:event', { type: 'board', board: b })
    },
    async getOrchestrateMode(chatId) {
      return modes.get(chatId) ?? 'auto'
    },
    async setOrchestrateMode(chatId, mode) {
      modes.set(chatId, mode)
    },

    // Feature folders
    async renameFeature(from, to) {
      await delay(300)
      const result = {
        from,
        to,
        moved: [
          { from: `src/shared/Features/${from}`, to: `src/shared/Features/${to}` },
          { from: `src/server/Features/${from}`, to: `src/server/Features/${to}` },
          { from: `src/client/Client/Controllers/${from}Controller.luau`, to: `src/client/Client/Controllers/${to}Controller.luau` }
        ],
        updated: ['src/client/UI/ShopFrame.luau'],
        notes: ['Paused the ./dev watcher during the rename so it would not delete or re-scaffold the Service/Controller.']
      }
      emit('features:renamed', result)
      log(`renamed feature ${from} -> ${to}`)
      return result
    }
  }
}
