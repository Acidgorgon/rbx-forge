// Wires the finished main-process services into the app: IPC handlers (HarnessApi / IntegrationApi),
// agent tools (HarnessContext.serviceTools), and the project lifecycle (open / scripts changed /
// close / quit). main/index.ts constructs this once and passes in the Electron pieces, so this file
// imports no electron and can be exercised in tests with fakes.
//
// Secrets (Open Cloud API keys, Discord webhooks, analytics keys) go only through one
// safeStorage-encrypted SecretStore in userData; nothing secret is written to the repo or .forge/,
// and no handler returns a secret value.

import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type {
  ActivityQuery,
  AnalyticsSeriesQuery,
  ForgeProjectConfig,
  JoinProjectInput,
  LogLine,
  PublishConfig,
  PullRequestInput,
  ReleaseHistoryEntry,
  ReleaseSecretKind,
  ReleaseSecretsStatus,
  ReleaseUserSettings,
  RunRequest,
  SecretScope,
  ServiceId,
  ServiceStatus
} from '@shared/types'
import type { HarnessContext, ServiceTool, ServiceToolSets } from './context.ts'
import { budgetTools, mapSource, realmLookup } from './agent/budget/tools.ts'
import { ProjectMap } from './agent/budget/projectMap.ts'
import { blinkTools, packageTools, type PackagesLike } from './agent/serviceTools.ts'
import * as analyticsSvc from './services/analytics/index.ts'
import { addEvent, checkBlink, describeEvent, listEvents } from './services/blink.ts'
import * as collab from './services/collab/index.ts'
import { git as runGit } from './services/collab/git.ts'
import { renameFeature, FEATURE_NAME } from './services/featureOps.ts'
import * as release from './services/release/index.ts'
import { createArtWiring, type ArtWireDeps } from './services/art/wire.ts'
import { setCodexConceptSaver } from './agent/codex/imageSink.ts'
import { backendOf, type CodexImages } from './services/art/imageBackend.ts'
import { codexImages } from './agent/codex/images.ts'
import type { ImageBackend, ModelInboxStatus } from '../shared/artTypes.ts'
import { createModelUploader, inboxDirs, ModelInbox, modelUploadTools, NO_CREATOR_ERROR, NO_KEY_ERROR } from './services/art/modelInbox.ts'
import { InsertInbox, type InsertBridge } from './services/art/modelInsert.ts'
import type { InsertProjectPlace } from '../shared/studio/insert.ts'
import { Credentials } from './agent/credentials.ts'
import { TestService, testTools } from './services/tests/index.ts'
import { createUiPreviewWiring, type UiPreviewWireDeps } from './services/uiPreview/wire.ts'
import { withPreviewTools } from './agent/serviceTools.ts'

export interface IntegrationDeps {
  ctx: HarnessContext
  // The app's Settings (also the KeyValueStore behind the encrypted secret store).
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  safeStorage: release.SafeStorageLike
  userDataDir: string
  emit: HarnessContext['emit']
  log: (line: Omit<LogLine, 'at'>) => void
  // Current project root, its active place's project file, and the Rojo project name.
  root: () => string | null
  projectFile: () => string | null
  projectName: () => string | undefined
  packages: PackagesLike
  // Git sync of the open project (GitSync), when there is one.
  git: () => { syncNow(): Promise<{ error?: string }>; refresh(): Promise<unknown> } | null
  studioConflicts: () => Promise<{ path: string }[]>
  // Project watcher pause (Project.pause/resume) and the dev service, for feature renames.
  pauseProjectWatch: () => void
  resumeProjectWatch: () => void
  services: () => ServiceStatus[]
  startService: (id: ServiceId) => Promise<void>
  stopService: (id: ServiceId) => Promise<void>
  // Runs a folder operation with rojo serve stopped (rojoRestart.ts RojoPause); optional.
  withRojoPaused?: <T>(fn: () => Promise<T>, reason?: string) => Promise<T>
  openExternal: (url: string) => void
  choosePlaceFile: () => Promise<string | null>
  // One-shot model call for "summarize incoming changes" (agent layer); optional.
  summarize?: (prompt: string) => Promise<string>
  // Art page: Electron nativeImage thumbnailer, image file picker, chat image bridge (optional).
  art?: Pick<ArtWireDeps, 'thumbnail' | 'chooseImages' | 'reveal' | 'chatImage' | 'resolveReference' | 'vision'>
  // UI Preview: the offscreen screenshot for preview_ui (Electron).
  uiPreview?: Pick<UiPreviewWireDeps, 'capture'>
  // FBX upload inbox: the OS Documents folder and a folder picker. Without it the inbox never runs.
  modelInbox?: { documentsDir: string; chooseFolder?: (title: string, defaultPath?: string) => Promise<string | null> }
  // The Forge Bridge (studio wiring, created after this), for the inbox's Studio inserts.
  studioBridge?: () => InsertBridge | null
  // The open project's places and how Forge links them to Studio (servePlaceIds, Source Control
  // links): inserts only go to a Studio window of one of these. Absent / null: no project open.
  insertPlaces?: () => InsertProjectPlace[] | null
}

export interface Integrations {
  handlers: Record<string, (...args: any[]) => unknown>
  serviceTools(): ServiceToolSets
  notifyTestFailure(event: { scenario: string; summary: string; details?: string }): void
  onProjectOpen(root: string): Promise<void>
  onActivePlaceChanged(): void
  onScriptsChanged(): void
  onProjectClose(): void
  dispose(): void
  tests: TestService
  analytics: analyticsSvc.AnalyticsService
  releases: release.ReleaseService
  secrets: release.SecretStore
  // Open Cloud asset uploads outside the Art page (Animation Lab): the key and creator set there.
  openCloud: { key(): Promise<string | null>; creator(): { userId?: number; groupId?: number } }
  // FBX upload inbox and Studio insert watchers: start() after launch (and again on settings changes, done here).
  modelInbox: { start(): Promise<void> }
  // OpenAI image generation outside the Art page (VFX Lab textures): the key, model and budget set there.
  images: { openAiKey(): Promise<string | null>; settings(): { model: string; quality: string; dailyCapUsd: number; backend?: ImageBackend }; spentToday(): Promise<number>; codex?: CodexImages }
}

const SECRET_KINDS: ReleaseSecretKind[] = ['openCloudApiKey', 'discordWebhook']

export function createIntegrations(deps: IntegrationDeps): Integrations {
  const { settings, emit, log } = deps
  const root = () => {
    const r = deps.root()
    if (!r) throw new Error('No project open')
    return r
  }
  const userName = () => {
    try {
      return settings.get<string>('userName', '') || process.env.USER || process.env.USERNAME || 'someone'
    } catch {
      return 'someone'
    }
  }

  // ---------------------------------------------------------------- secrets (one encrypted store)
  const secrets = release.createEncryptedSecretStore(deps.safeStorage, settings)

  // ---------------------------------------------------------------- art (OpenAI images, Roblox import)
  let credentials: Credentials | null = null
  // Image backend 'codex': the ChatGPT plan through the user's Codex CLI.
  const imageCodex = codexImages()
  const art = createArtWiring({
    root: deps.root,
    settings,
    secrets,
    userDataDir: deps.userDataDir,
    openAiKey: () => (credentials ??= new Credentials(deps.ctx)).getKey('openai'),
    codex: imageCodex,
    emit,
    ...(deps.art ?? {})
  })

  // Images Codex makes in a chat land in art/concepts too (agent/codex/imageSink.ts).
  setCodexConceptSaver(async ({ images, prompt }) => (await art.service.saveGenerated({ images, prompt })).map((i) => i.path))

  // Open Cloud uploads outside the Art page use the key and creator set there.
  const openCloud: Integrations['openCloud'] = {
    key: async () => (await art.robloxKey().catch(() => null))?.key ?? null,
    creator: () => {
      const s = art.service.settings()
      return { ...(s.creatorUserId ? { userId: s.creatorUserId } : {}), ...(s.creatorGroupId ? { groupId: s.creatorGroupId } : {}) }
    }
  }

  // ---------------------------------------------------------------- FBX upload inbox (Model assets)
  // Opt-in (modelInbox.enabled, off by default). See services/art/modelInbox.ts for the file formats.
  const inboxPaths = inboxDirs(deps.modelInbox?.documentsDir ?? join(deps.userDataDir, 'Documents'))
  const inboxDir = () => settings.get<string | null>('modelInbox.dir', null) || inboxPaths.inboxDir
  const inboxEnabled = () => !!deps.modelInbox && settings.get<boolean>('modelInbox.enabled', false) === true
  const hasCreator = () => {
    const c = openCloud.creator()
    return !!(c.userId || c.groupId)
  }
  const uploadModel = createModelUploader({ key: openCloud.key, creator: openCloud.creator })
  const modelInbox = new ModelInbox({
    dir: inboxDir,
    modelsDir: () => inboxPaths.modelsDir,
    enabled: inboxEnabled,
    upload: uploadModel,
    blocked: async () => (!(await openCloud.key()) ? NO_KEY_ERROR : !hasCreator() ? NO_CREATOR_ERROR : null),
    log: (text, stream = 'info') => log({ service: 'harness', stream, text }),
    onResult: (entry) => emit('fbxInbox:upload', entry)
  })
  // Studio inserts (<id>.insert.json in the same folder): their own opt-in (modelInbox.insertEnabled,
  // off by default); no Open Cloud key involved. See services/art/modelInsert.ts.
  const insertEnabled = () => !!deps.modelInbox && settings.get<boolean>('modelInbox.insertEnabled', false) === true
  const insertInbox = new InsertInbox({
    dir: inboxDir,
    modelsDir: () => inboxPaths.modelsDir,
    enabled: insertEnabled,
    bridge: () => deps.studioBridge?.() ?? null,
    projectPlaces: () => deps.insertPlaces?.() ?? null,
    log: (text, stream = 'info') => log({ service: 'harness', stream, text }),
    onResult: (entry) => emit('fbxInbox:upload', entry)
  })
  const startInboxes = async () => {
    await modelInbox.start()
    await insertInbox.start()
  }
  const inboxStatus = async (): Promise<ModelInboxStatus> => ({
    enabled: inboxEnabled(),
    dir: inboxDir(),
    defaultDir: inboxPaths.inboxDir,
    modelsDir: inboxPaths.modelsDir,
    robloxKey: !!(await openCloud.key()),
    creator: hasCreator(),
    watching: modelInbox.watching() || insertInbox.watching(),
    insertEnabled: insertEnabled(),
    recent: [...modelInbox.recent(), ...insertInbox.recent()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10)
  })

  // ---------------------------------------------------------------- Lune tests
  const tests = new TestService({
    onProgress: (event) => emit('tests:progress', event),
    log: (text, stream = 'info') => log({ service: 'harness', stream, text: `[tests] ${text}` }),
    lunePath: () => settings.get<string | null>('tests.lunePath', null),
    projectFile: () => deps.projectFile()
  })
  // ---------------------------------------------------------------- UI Preview (UI Labs stories)
  const uiPreview = createUiPreviewWiring({
    root: deps.root,
    projectFile: deps.projectFile,
    lunePath: () => settings.get<string | null>('tests.lunePath', null),
    emit: (event) => emit('uiPreview:event', event),
    log: (text, stream = 'info') => log({ service: 'harness', stream, text }),
    ...(deps.uiPreview ?? {})
  })
  const luneRunner = async (): Promise<release.LuneTestRun> => {
    const s = await tests.run({ scope: { kind: 'all' } })
    if (s.state === 'passed' || s.state === 'failed') {
      return {
        ran: true,
        passed: s.passed,
        failed: s.failed,
        failures: s.results.filter((r) => r.status === 'fail').slice(0, 10).map((r) => `${r.file}: ${[r.suite, r.test].filter(Boolean).join(' > ')}`)
      }
    }
    return { ran: false, passed: 0, failed: 0, note: s.message ?? s.state }
  }

  // ---------------------------------------------------------------- release + notifications
  const userRelease = (r: string): ReleaseUserSettings => {
    const v = settings.get<Partial<ReleaseUserSettings>>(`release.user.${release.projectScope(r)}`, {})
    return { ...(v.placeFile ? { placeFile: v.placeFile } : {}), notifications: release.parseToggles(v.notifications) }
  }
  const notifiers = new Map<string, release.Notifier>()
  const notifierFor = (r: string): release.Notifier => {
    let n = notifiers.get(r)
    if (!n) {
      n = new release.Notifier({
        root: r,
        secrets,
        toggles: () => userRelease(r).notifications,
        game: () => deps.projectName(),
        log: (t) => log({ service: 'harness', stream: 'info', text: `[release] ${t}` }),
        onWebhookGone: () => emit('release:webhookGone', { root: r })
      })
      notifiers.set(r, n)
    }
    return n
  }
  const releases = new release.ReleaseService({
    secrets,
    store: settings,
    checks: (r) =>
      release.defaultChecks(r, {
        studioConflicts: () => deps.studioConflicts(),
        blink: () => checkBlink(r),
        selene: async () => {
          const cfg = await collab.readProjectConfig(r)
          return cfg.config.lint.selene ? collab.runSelene(r) : { ran: false, problems: [], note: 'Selene is off in .forge/project.json' }
        },
        lune: luneRunner
      }),
    notify: (r, event) => notifierFor(r).notify(event),
    userPlaceFile: (r) => userRelease(r).placeFile,
    onStep: (r, step) => emit('release:step', { root: r, step }),
    onCheck: (r, result) => emit('release:check', { root: r, result })
  })
  const secretsStatus = async (): Promise<ReleaseSecretsStatus> => {
    const r = root()
    const key = await release.readSecret(secrets, 'openCloudApiKey', r)
    const hook = await release.readSecret(secrets, 'discordWebhook', r)
    return { openCloudApiKey: !!key, discordWebhook: !!hook, ...(hook ? { webhookHint: release.redactWebhookUrl(hook) } : {}) }
  }
  const history = async (): Promise<ReleaseHistoryEntry[]> => (await releases.teamHistory(root())) as ReleaseHistoryEntry[]

  // ---------------------------------------------------------------- analytics
  const releaseMarkers = async (): Promise<{ tag: string; at: string }[]> => {
    const r = deps.root()
    if (!r) return []
    const prefix = (await release.readReleaseConfig(r).catch(() => null))?.publish.tagPrefix ?? 'v'
    const res = await runGit(r, ['for-each-ref', '--sort=creatordate', '--format=%(refname:short) %(creatordate:iso-strict)', `refs/tags/${prefix}*`])
    if (res.code !== 0) return []
    return res.stdout
      .split('\n')
      .map((l: string) => l.trim().split(' '))
      .filter((p: string[]) => p.length === 2 && p[0] && p[1])
      .map(([tag, at]: string[]) => ({ tag, at }))
  }
  const analytics = new analyticsSvc.AnalyticsService({
    secrets,
    dataDir: join(deps.userDataDir, 'analytics'),
    getReleases: releaseMarkers,
    pollIntervalMinutes: settings.get<number>('analytics.pollMinutes', 15),
    publicWithoutKey: () => settings.get<boolean>('analytics.publicWithoutKey', false) === true,
    onSnapshot: (snapshot) => emit('analytics:snapshot', snapshot)
  })
  const configureAnalytics = async (r: string | null) => {
    analytics.stopPoller()
    if (!r) return analytics.configure({ root: undefined, placeId: undefined, universeId: undefined })
    const cfg = await release.readReleaseConfig(r).catch(() => null)
    const ids = settings.get<{ placeId?: number; universeId?: number }>(`analytics.ids.${release.projectScope(r)}`, {})
    const placeId = cfg?.publish.placeId ?? ids.placeId ?? (await release.studioSyncPlaceIds(r).catch(() => []))[0]
    const universeId = cfg?.publish.universeId ?? ids.universeId
    analytics.configure({ root: r, placeId, universeId })
    if (settings.get('analytics.poller', true) && (placeId || universeId) && !(await analytics.keyless())) {
      try {
        ;(await analytics.publicPoller()).start()
      } catch (error) {
        log({ service: 'harness', stream: 'stderr', text: `[analytics] poller: ${(error as Error).message}` })
      }
    }
  }

  // ---------------------------------------------------------------- agent tools
  const projectMap = new ProjectMap(mapSource(deps.ctx))
  let toolSets: ServiceToolSets | null = null
  const serviceTools = (): ServiceToolSets => {
    if (toolSets) return toolSets
    const budget = budgetTools({ map: projectMap, fs: deps.ctx, realmOf: realmLookup(deps.ctx) }) as ServiceTool[]
    const blink = blinkTools({
      root: deps.root,
      listEvents: (r) => listEvents(r),
      describeEvent,
      check: (r) => checkBlink(r),
      addEvent: (r, spec, o) => addEvent(r, spec, o)
    })
    const pkgs = packageTools(deps.packages)
    const renameTool: ServiceTool = {
      name: 'rename_feature',
      description:
        'Rename a GenTree feature everywhere at once: src/shared/Features/<From>, its server Feature and its <From>Controller, plus Features.<From> / <From>Controller references in src/. Pauses the ./dev watcher during the move so it does not delete or re-scaffold anything. Names are PascalCase.',
      inputSchema: { from: z.string().regex(FEATURE_NAME), to: z.string().regex(FEATURE_NAME) },
      handler: async (args: { from: string; to: string }) => {
        const r = await doRename(args.from, args.to)
        const lines = [`renamed ${r.from} -> ${r.to}`, ...r.moved.map((m) => `moved ${m.from} -> ${m.to}`), ...(r.updated.length ? [`updated references in: ${r.updated.join(', ')}`] : []), ...r.notes]
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
    }
    toolSets = withPreviewTools({
      // Fixed order: the tool list is part of the cached prompt prefix.
      read: [...budget, ...blink.read, ...pkgs.read, ...(analyticsSvc.createAnalyticsTools(analytics) as ServiceTool[])],
      tests: testTools(tests) as ServiceTool[],
      write: [
        ...blink.write,
        ...pkgs.write,
        renameTool,
        ...(art.tools() as ServiceTool[]),
        ...(modelUploadTools({ upload: uploadModel, roots: () => [inboxDir(), inboxPaths.modelsDir], projectRoot: deps.root }) as unknown as ServiceTool[])
      ]
    }, uiPreview.tools() as unknown as ServiceTool[])
    return toolSets
  }

  // ---------------------------------------------------------------- feature rename
  const doRename = async (from: string, to: string) => {
    const rename = () => renameFeature(root(), from, to, {
      devRunning: () => deps.services().some((s) => s.id === 'dev' && (s.state === 'running' || s.state === 'starting')),
      stopDev: () => deps.stopService('dev'),
      startDev: () => deps.startService('dev'),
      pauseProjectWatch: deps.pauseProjectWatch,
      resumeProjectWatch: deps.resumeProjectWatch,
      log: (text) => log({ service: 'harness', stream: 'info', text })
    })
    const result = deps.withRojoPaused ? await deps.withRojoPaused(rename, 'feature rename') : await rename()
    emit('features:renamed', result)
    void deps.git()?.refresh()
    return result
  }

  // ---------------------------------------------------------------- IPC handlers
  const claimsChanged = async (list: collab.ClaimView[]) => {
    emit('collab:claims', list)
    return list
  }

  const handlers: Record<string, (...args: any[]) => unknown> = {
    // Collaboration
    joinProject: (input: JoinProjectInput) =>
      collab.joinProject(input, { trustTools: input?.trustTools, onProgress: (p) => emit('collab:joinProgress', p) }),
    incomingChanges: (options?: { summarize?: boolean }) =>
      collab.incomingChanges(root(), {
        ...(options?.summarize && deps.summarize ? { summarize: (input: collab.IncomingSummaryInput) => deps.summarize!(collab.incomingPrompt(input)) } : {})
      }),
    activityFeed: (query?: ActivityQuery) => collab.activityFeed(root(), query ?? { since: Date.now() - 14 * 864e5 }),
    fileHistory: (path: string, limit?: number) => collab.fileHistory(root(), String(path), { limit }),
    getForgeConfig: () => collab.readProjectConfig(root()),
    setForgeConfig: (config: ForgeProjectConfig) => collab.writeProjectConfig(root(), config),
    startFeatureBranch: async (name: string) => {
      const g = deps.git()
      const result = await collab.startFeatureBranch(root(), String(name), {
        sync: g ? async () => ({ error: (await g.syncNow()).error }) : undefined
      })
      await g?.refresh()
      return result
    },
    openPullRequest: async (input: PullRequestInput) => {
      const result = await collab.openPullRequest(root(), input)
      if (result.kind === 'browser') deps.openExternal(result.url)
      await deps.git()?.refresh()
      return result
    },
    listOpenPRs: () => collab.listOpenPRs(root()),
    listClaims: () => collab.listClaims(root()),
    claim: async (what: string, note?: string) => {
      const r = root()
      const list = await collab.claim(r, String(what), { note })
      await collab.commitClaims(r, `forge: claim ${what}`)
      void deps.git()?.syncNow()
      return claimsChanged(list)
    },
    releaseClaim: async (what: string) => {
      const r = root()
      const list = await collab.release(r, String(what))
      await collab.commitClaims(r, `forge: release ${what}`)
      void deps.git()?.syncNow()
      return claimsChanged(list)
    },
    runLint: async (paths?: string[]) => {
      const r = root()
      return { selene: await collab.runSelene(r, paths), stylua: await collab.runStylua(r, paths, { check: true }) }
    },
    preSyncCheck: () => collab.preSyncCheck(root()),

    // Release
    releasePlan: (options?: { skipPreflight?: boolean }) => releases.plan(root(), { skipPreflight: options?.skipPreflight === true }),
    releasePreflight: () => releases.preflight(root()),
    releaseRun: (input: unknown) => releases.run(root(), (input ?? {}) as any),
    releaseMarkStudioPublished: (tag: string) => releases.markStudioPublished(root(), String(tag)),
    releaseHistory: () => history(),
    releaseSecretsStatus: () => secretsStatus(),
    releaseSetSecret: async (kind: ReleaseSecretKind, value: string, scope: SecretScope) => {
      if (!SECRET_KINDS.includes(kind)) throw new Error(`unknown secret ${String(kind)}`)
      const v = String(value ?? '').trim()
      if (kind === 'openCloudApiKey' && !release.looksLikeApiKey(v)) throw new Error('That does not look like an Open Cloud API key.')
      if (kind === 'discordWebhook' && !release.isWebhookUrl(v)) throw new Error('That is not a Discord webhook URL (https://discord.com/api/webhooks/...).')
      await secrets.set(release.secretKey(kind, scope === 'global' ? undefined : root()), v)
      return secretsStatus()
    },
    releaseClearSecret: async (kind: ReleaseSecretKind, scope: SecretScope) => {
      if (!SECRET_KINDS.includes(kind)) throw new Error(`unknown secret ${String(kind)}`)
      await secrets.delete(release.secretKey(kind, scope === 'global' ? undefined : root()))
      return secretsStatus()
    },
    releaseGetSettings: () => userRelease(root()),
    releaseSetSettings: (next: Partial<ReleaseUserSettings>) => {
      const r = root()
      const cur = userRelease(r)
      const merged: ReleaseUserSettings = {
        ...cur,
        ...(next && 'placeFile' in next ? { placeFile: next.placeFile ? String(next.placeFile) : undefined } : {}),
        notifications: release.parseToggles({ ...cur.notifications, ...(next?.notifications ?? {}) })
      }
      settings.set(`release.user.${release.projectScope(r)}`, merged)
      return merged
    },
    releaseSetProjectPublish: async (config: PublishConfig) => {
      const r = root()
      const parsed = release.PublishConfigSchema.safeParse(config ?? {})
      if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || 'publish'}: ${i.message}`).join('; '))
      let raw: Record<string, unknown> = {}
      try {
        const json = JSON.parse(await readFile(join(r, collab.PROJECT_CONFIG_PATH), 'utf8'))
        if (json && typeof json === 'object' && !Array.isArray(json)) raw = json
      } catch {
        // new file
      }
      await collab.writeProjectConfig(r, { ...raw, publish: parsed.data })
      await configureAnalytics(r)
      return parsed.data
    },
    releaseTestNotify: () => notifierFor(root()).test(userName()),
    releaseChoosePlaceFile: () => deps.choosePlaceFile(),

    // Lune tests
    testsStatus: () => tests.status(),
    testsDiscover: () => tests.discover(),
    testsRun: (request?: RunRequest) => tests.run(request ?? { scope: { kind: 'all' } }),
    testsCancel: () => tests.cancel(),
    testsWatch: (on: boolean) => {
      if (on) tests.startWatch()
      else tests.stopWatch()
      settings.set('tests.watch', !!on)
      return tests.watching()
    },
    testsCreateSpec: (modulePath: string) => tests.createSpec(String(modulePath)),
    testsLast: () => tests.last(),

    // Analytics
    analyticsStatus: () => analytics.status(),
    analyticsSetApiKey: async (key: string, scope?: SecretScope) => {
      const k = String(key ?? '').trim()
      if (!release.looksLikeApiKey(k)) throw new Error('That does not look like an Open Cloud API key.')
      await analytics.setApiKey(k, scope === 'global' ? 'global' : 'project')
      // A first key starts public tracking too (it waited for the key or the opt-in).
      await configureAnalytics(deps.root()).catch(() => undefined)
      return analytics.status()
    },
    analyticsClearApiKey: async (scope?: SecretScope) => {
      await analytics.clearApiKey(scope === 'global' ? 'global' : 'project')
      return analytics.status()
    },
    analyticsSetExperience: async (ids: { placeId?: number; universeId?: number }) => {
      const r = root()
      const clean = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined)
      const next = { placeId: clean(ids?.placeId), universeId: clean(ids?.universeId) }
      settings.set(`analytics.ids.${release.projectScope(r)}`, next)
      analytics.configure({ root: r, ...next })
      return analytics.status()
    },
    analyticsOverview: (options?: { range?: string; metrics?: string[] }) => analytics.overview(options ?? {}),
    analyticsSeries: (query: AnalyticsSeriesQuery) => analytics.series(query),
    analyticsAcquisition: (options?: { range?: string }) => analytics.acquisition(options ?? {}),
    analyticsImportCsv: (input: { path: string; metricHint?: string }) => analytics.importCsv({ path: String(input?.path ?? ''), metricHint: input?.metricHint }),
    analyticsRemoveImport: async (input: { metric: string; breakdown?: Record<string, string> }) => (await analytics.importStore()).remove(String(input?.metric ?? ''), input?.breakdown),
    analyticsPoller: async (running: boolean) => {
      settings.set('analytics.poller', !!running)
      // Turning public tracking on is the opt-in to keyless Roblox calls.
      if (running) settings.set('analytics.publicWithoutKey', true)
      if (running) (await analytics.publicPoller()).start()
      else analytics.stopPoller()
      return analytics.status()
    },
    analyticsPollNow: async () => (await analytics.publicPoller()).pollNow(true),
    analyticsCatalog: () => analytics.catalog(),
    analyticsSnippet: (input: { kind: analyticsSvc.SnippetKind } & analyticsSvc.SnippetOptions) => {
      const { kind, ...rest } = input ?? ({ kind: 'setup' } as any)
      return analyticsSvc.analyticsSnippet(kind, rest)
    },

    // Feature folders
    renameFeature: (from: string, to: string) => doRename(String(from ?? ''), String(to ?? '')),

    // Art concepts
    ...art.handlers,

    // FBX upload inbox
    fbxInboxStatus: () => inboxStatus(),
    fbxInboxSetSettings: async (patch?: { enabled?: boolean; insert?: boolean; dir?: string | null }) => {
      if (patch && 'dir' in patch) {
        const d = typeof patch.dir === 'string' ? patch.dir.trim() : ''
        if (d && !isAbsolute(d)) throw new Error('The inbox must be an absolute folder path.')
        settings.set('modelInbox.dir', d || null)
      }
      if (typeof patch?.enabled === 'boolean') {
        if (patch.enabled && !(await openCloud.key())) throw new Error('Add an Open Cloud API key (Art page > Roblox import) before turning on the inbox.')
        settings.set('modelInbox.enabled', patch.enabled)
      }
      if (typeof patch?.insert === 'boolean') settings.set('modelInbox.insertEnabled', patch.insert)
      await startInboxes()
      return inboxStatus()
    },
    fbxInboxChooseFolder: async () => {
      const picked = await deps.modelInbox?.chooseFolder?.('Choose the FBX upload inbox', inboxDir())
      if (picked) {
        settings.set('modelInbox.dir', picked)
        await startInboxes()
      }
      return inboxStatus()
    },

    // UI Preview
    ...uiPreview.handlers
  }

  return {
    handlers,
    serviceTools,
    openCloud,
    modelInbox: { start: startInboxes },
    images: {
      openAiKey: () => (credentials ??= new Credentials(deps.ctx)).getKey('openai'),
      settings: () => {
        const s = art.service.settings()
        return { model: s.model, quality: s.quality, dailyCapUsd: s.dailyCapUsd, backend: backendOf(s.backend) }
      },
      spentToday: () => art.service.spentToday(),
      codex: imageCodex
    },
    notifyTestFailure: (event) => {
      const r = deps.root()
      if (!r) return
      void notifierFor(r)
        .notify({ kind: 'test-failure', scenario: event.scenario, summary: event.summary, by: userName(), ...(event.details ? { details: event.details } : {}) })
        .catch(() => undefined)
    },
    async onProjectOpen(r: string) {
      tests.setRoot(r)
      uiPreview.onProjectOpen(r)
      if (settings.get('tests.watch', false)) tests.startWatch()
      void projectMap.refresh().catch(() => undefined)
      await configureAnalytics(r).catch((error) => log({ service: 'harness', stream: 'stderr', text: `[analytics] ${(error as Error).message}` }))
    },
    onActivePlaceChanged() {
      // The Lune sourcemap is rebuilt per run from the active place; a running watch keeps going.
      void projectMap.refresh().catch(() => undefined)
    },
    onScriptsChanged() {
      void projectMap.refresh().catch(() => undefined)
    },
    onProjectClose() {
      tests.setRoot(null)
      uiPreview.onProjectClose()
      analytics.stopPoller()
      notifiers.clear()
    },
    dispose() {
      setCodexConceptSaver(null)
      modelInbox.stop()
      insertInbox.stop()
      uiPreview.dispose()
      tests.stopWatch()
      tests.cancel()
      analytics.stopPoller()
    },
    tests,
    analytics,
    releases,
    secrets
  }
}
