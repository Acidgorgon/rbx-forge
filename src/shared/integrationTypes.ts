// IPC types for the integrated services (collab, release, Lune tests, analytics, token usage,
// orchestrator, feature rename). Re-exported from types.ts; HarnessApi / HarnessEvents extend the
// interfaces at the bottom.
//
// The data types are type-only re-exports of the services' own plain-data types (no runtime
// imports), so a service result is returned over IPC as is and the two can never drift apart.

import type { ChatMessage, ModelChoice, ProviderId } from './types.ts'

// ---- Collaboration (main/services/collab) ----
export type { JoinProgress, JoinResult, JoinStepId } from '../main/services/collab/join.ts'
export type { ChangedFile, FileChangeStatus, IncomingChanges, IncomingCommit } from '../main/services/collab/incoming.ts'
export type { ActivityEntry } from '../main/services/collab/activity.ts'
export type { BlameLine, BlameResult, FileHistoryEntry } from '../main/services/collab/blame.ts'
export type { StartBranchResult, PullRequestInput, PullRequestResult, OpenPullRequest } from '../main/services/collab/branches.ts'
export type { ClaimView } from '../main/services/collab/claims.ts'
export type { Problem, ToolRun, PreSyncReport } from '../main/services/collab/quality.ts'
export type { ChangeCategory as CollabCategory } from '../main/services/collab/classify.ts'
import type { ProjectConfig, ConfigIssue } from '../main/services/collab/config.ts'
import type { JoinProgress, JoinResult } from '../main/services/collab/join.ts'
import type { IncomingChanges } from '../main/services/collab/incoming.ts'
import type { ActivityEntry } from '../main/services/collab/activity.ts'
import type { BlameResult, FileHistoryEntry } from '../main/services/collab/blame.ts'
import type { StartBranchResult, PullRequestInput, PullRequestResult, OpenPullRequest } from '../main/services/collab/branches.ts'
import type { ClaimView } from '../main/services/collab/claims.ts'
import type { ToolRun, PreSyncReport } from '../main/services/collab/quality.ts'

export interface JoinProjectInput {
  repoUrl: string
  parentDir: string
  name?: string
  // Pass --no-trust-check to rokit after the person agreed to trust the game's pinned tools.
  trustTools?: boolean
}
export interface ActivityQuery {
  since?: number
  until?: number
  author?: string // substring; 'Studio' = Studio entries only
  feature?: string
  limit?: number
}
// .forge/project.json (team settings, committed; never secrets). Includes the release fields.
export type ForgeProjectConfig = ProjectConfig
export interface ForgeProjectConfigRead {
  exists: boolean
  config: ForgeProjectConfig
  issues?: ConfigIssue[]
}
export interface OpenPullRequests {
  available: boolean
  prs: OpenPullRequest[]
  reason?: string
}

// ---- Release (main/services/release) ----
export type {
  ReleaseMode,
  VersionType,
  PublishConfig,
  ModeDetection,
  RojoBuildSummary,
  CheckStatus,
  CheckOutcome,
  CheckResult,
  PreflightReport,
  ChangeKind,
  ChangelogCommit,
  StudioActivity,
  Changelog,
  BumpKind,
  VersionInfo,
  ReleasePlan,
  PlaceFileInfo,
  ReleaseRunInput,
  ReleaseStepId,
  ReleaseStep,
  ReleaseRecord,
  ReleaseResult,
  ReleaseUserSettings,
  NotifyEventKind,
  NotifyEvent,
  NotificationToggles,
  NotifyResult
} from '../main/services/release/types.ts'
import type {
  CheckResult,
  PreflightReport,
  PublishConfig,
  ReleaseMode,
  ReleasePlan,
  ReleaseResult,
  ReleaseRunInput,
  ReleaseStep,
  ReleaseUserSettings,
  NotifyResult,
  VersionType
} from '../main/services/release/types.ts'

export interface ReleaseSecretsStatus {
  openCloudApiKey: boolean
  discordWebhook: boolean
  // redactWebhookUrl() of the stored webhook; never the secret itself.
  webhookHint?: string
}
export interface ReleaseHistoryEntry {
  tag: string
  version: string
  at: number
  by: string
  changelog: string
  mode?: ReleaseMode
  placeVersion?: number
  versionType?: VersionType
  studioPublishPending?: boolean
  notified?: boolean
}
export type ReleaseSecretKind = 'openCloudApiKey' | 'discordWebhook'
export type SecretScope = 'project' | 'global'

// ---- Headless Luau tests (main/services/tests) ----
export type {
  TestStatus,
  TestError,
  TestCaseResult,
  TestLog,
  Realm as TestRealm,
  SpecFile,
  RunScope,
  RunRequest,
  RunState,
  RunSummary,
  LuneStatus,
  TestProgress,
  CreateSpecResult
} from '../main/services/tests/types.ts'
import type { CreateSpecResult, LuneStatus, RunRequest, RunSummary, SpecFile, TestProgress } from '../main/services/tests/types.ts'

// ---- Analytics (main/services/analytics) ----
export type {
  Granularity as AnalyticsGranularity,
  SeriesSource as AnalyticsSource,
  SeriesPoint as AnalyticsPoint,
  Series as AnalyticsSeries,
  DateRange as AnalyticsRange,
  Signal as AnalyticsSignal,
  KpiDelta as AnalyticsKpi,
  PublicStats as AnalyticsPublicStats,
  PublicSnapshot as AnalyticsSnapshot,
  ImportSummary as AnalyticsImportSummary,
  AnalyticsStatus,
  CatalogItem as AnalyticsCatalogItem,
  CsvImportResult as AnalyticsCsvImportResult,
  MetricFilter as AnalyticsMetricFilter
} from '../main/services/analytics/types.ts'
export type {
  OverviewResult as AnalyticsOverview,
  SeriesResult as AnalyticsSeriesResult,
  CompareResult as AnalyticsCompare,
  AcquisitionResult as AnalyticsAcquisition
} from '../main/services/analytics/service.ts'
export type { Snippet as AnalyticsSnippet, SnippetKind as AnalyticsSnippetKind, SnippetOptions as AnalyticsSnippetOptions } from '../main/services/analytics/snippets.ts'
import type { AnalyticsStatus, CatalogItem, CsvImportResult, Granularity, MetricFilter, PublicSnapshot, SeriesSource } from '../main/services/analytics/types.ts'
import type { AcquisitionResult, CompareResult, OverviewResult, SeriesResult } from '../main/services/analytics/service.ts'
import type { Snippet, SnippetKind, SnippetOptions } from '../main/services/analytics/snippets.ts'

export interface AnalyticsSeriesQuery {
  metric: string
  range?: string
  granularity?: Granularity
  breakdown?: string[]
  filter?: MetricFilter[]
  limit?: number
  source?: 'auto' | SeriesSource
}

// ---- Token usage and budgets (main/agent/budget) ----
export type { BudgetLimits } from '../main/agent/budget/budget.ts'
import type { BudgetLimits } from '../main/agent/budget/budget.ts'

export interface UsageSummary {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  // Priced part only.
  costUsd: number
  // >0: show "cost partly unknown".
  unpricedRequests: number
  requests: number
}
export interface UsageSnapshot {
  scope: 'chat' | 'agent' | 'day'
  // Chat id, agent id, or YYYY-MM-DD.
  id: string
  totals: UsageSummary
  // In-flight query, not yet in totals.
  live?: UsageSummary
  budget?: { level: 'ok' | 'warn' | 'stop'; fraction: number; reason?: string }
  model?: string
  provider?: ProviderId
  route?: { tier: 'cheap' | 'big' | 'chosen'; reason: string }
}

// ---- Orchestrator (main/agent/orchestrator) ----
export type {
  Role as OrchestratorRole,
  TaskState,
  RunState as OrchestratorRunState,
  TaskView,
  BoardView,
  ChangeRequest,
  OrchestratorEvent,
  OrchestratorSettings
} from '../main/agent/orchestrator/types.ts'
import type { BoardView, OrchestratorEvent } from '../main/agent/orchestrator/types.ts'
export type OrchestrateMode = 'auto' | 'single' | 'team'

// ---- Feature folders (main/services/featureOps) ----
export interface FeatureRenameResult {
  from: string
  to: string
  // Repo-relative moves that were made, in order.
  moved: { from: string; to: string }[]
  // Files whose `require(...Features.<Old>...)` / `<Old>Controller` references were updated.
  updated: string[]
  notes: string[]
}

// ---- Events and API added to HarnessEvents / HarnessApi ----

export interface IntegrationEvents {
  'collab:joinProgress': JoinProgress
  // .forge/claims.json changed (after claim/release, or a sync that pulled teammates' claims).
  'collab:claims': ClaimView[]
  'release:step': { root: string; step: ReleaseStep }
  'release:check': { root: string; result: CheckResult }
  'release:webhookGone': { root: string }
  'tests:progress': TestProgress
  'analytics:snapshot': PublicSnapshot
  'usage:changed': UsageSnapshot
  'orchestrator:event': OrchestratorEvent
  'features:renamed': FeatureRenameResult
}

export interface IntegrationApi {
  // Collaboration (main/services/collab)
  joinProject(input: JoinProjectInput): Promise<JoinResult>
  incomingChanges(options?: { summarize?: boolean }): Promise<IncomingChanges>
  activityFeed(query?: ActivityQuery): Promise<ActivityEntry[]>
  blameFile(path: string): Promise<BlameResult>
  fileHistory(path: string, limit?: number): Promise<FileHistoryEntry[]>
  getForgeConfig(): Promise<ForgeProjectConfigRead>
  // Rejects values that look like secrets (webhook URLs, API keys).
  setForgeConfig(config: ForgeProjectConfig): Promise<ForgeProjectConfig>
  startFeatureBranch(name: string): Promise<StartBranchResult>
  openPullRequest(input: PullRequestInput): Promise<PullRequestResult>
  listOpenPRs(): Promise<OpenPullRequests>
  listClaims(): Promise<ClaimView[]>
  claim(what: string, note?: string): Promise<ClaimView[]>
  releaseClaim(what: string): Promise<ClaimView[]>
  runLint(paths?: string[]): Promise<{ selene: ToolRun; stylua: ToolRun }>
  formatFiles(paths: string[]): Promise<ToolRun>
  preSyncCheck(): Promise<PreSyncReport>

  // Release (main/services/release). Secrets are write-only from the renderer.
  releasePlan(options?: { skipPreflight?: boolean }): Promise<ReleasePlan>
  releasePreflight(): Promise<PreflightReport>
  releaseRun(input: ReleaseRunInput): Promise<ReleaseResult>
  releaseMarkStudioPublished(tag: string): Promise<ReleaseHistoryEntry>
  releaseHistory(): Promise<ReleaseHistoryEntry[]>
  releaseSecretsStatus(): Promise<ReleaseSecretsStatus>
  releaseSetSecret(kind: ReleaseSecretKind, value: string, scope: SecretScope): Promise<ReleaseSecretsStatus>
  releaseClearSecret(kind: ReleaseSecretKind, scope: SecretScope): Promise<ReleaseSecretsStatus>
  releaseGetSettings(): Promise<ReleaseUserSettings>
  releaseSetSettings(settings: Partial<ReleaseUserSettings>): Promise<ReleaseUserSettings>
  // Writes "publish" into .forge/project.json (validated); committed by the normal sync.
  releaseSetProjectPublish(config: PublishConfig): Promise<PublishConfig>
  releaseTestNotify(): Promise<NotifyResult>
  releaseChoosePlaceFile(): Promise<string | null>

  // Headless Luau tests with Lune (main/services/tests)
  testsStatus(): Promise<LuneStatus>
  testsDiscover(): Promise<SpecFile[]>
  testsRun(request: RunRequest): Promise<RunSummary>
  testsCancel(): Promise<boolean>
  testsWatch(on: boolean): Promise<boolean>
  testsCreateSpec(modulePath: string): Promise<CreateSpecResult>
  testsLast(): Promise<RunSummary | null>

  // Analytics (main/services/analytics)
  analyticsStatus(): Promise<AnalyticsStatus>
  analyticsSetApiKey(key: string, scope?: SecretScope): Promise<AnalyticsStatus>
  analyticsClearApiKey(scope?: SecretScope): Promise<AnalyticsStatus>
  analyticsSetExperience(ids: { placeId?: number; universeId?: number }): Promise<AnalyticsStatus>
  analyticsOverview(options?: { range?: string; metrics?: string[] }): Promise<OverviewResult>
  analyticsSeries(query: AnalyticsSeriesQuery): Promise<SeriesResult>
  analyticsCompare(options: { metrics: string[]; a: string; b?: string }): Promise<CompareResult>
  analyticsAcquisition(options?: { range?: string }): Promise<AcquisitionResult>
  analyticsImportCsv(input: { path: string; metricHint?: string }): Promise<CsvImportResult>
  analyticsRemoveImport(input: { metric: string; breakdown?: Record<string, string> }): Promise<boolean>
  analyticsPoller(running: boolean): Promise<AnalyticsStatus>
  analyticsPollNow(): Promise<PublicSnapshot | undefined>
  analyticsCatalog(): Promise<{ items: CatalogItem[]; notes: string[] }>
  analyticsSnippet(input: { kind: SnippetKind } & SnippetOptions): Promise<Snippet>

  // Token usage meter and budgets (main/agent/budget)
  getUsage(scope: 'chat' | 'agent' | 'day', id?: string): Promise<UsageSnapshot>
  getUsageHistory(days: number): Promise<{ day: string; totals: UsageSummary }[]>
  getBudget(): Promise<BudgetLimits>
  setBudget(limits: Partial<BudgetLimits>): Promise<BudgetLimits>

  // Multi-agent orchestration (main/agent/orchestrator)
  startOrchestration(chatId: string, text: string, choice?: ModelChoice): Promise<BoardView>
  getOrchestrations(): Promise<BoardView[]>
  getOrchestration(runId: string): Promise<BoardView | null>
  getTaskTranscript(runId: string, taskId: string): Promise<ChatMessage[]>
  cancelOrchestration(runId: string): Promise<void>
  cancelOrchestrationTask(runId: string, taskId: string): Promise<void>
  getOrchestrateMode(chatId: string): Promise<OrchestrateMode>
  setOrchestrateMode(chatId: string, mode: OrchestrateMode): Promise<void>

  // Feature folders: renames src/shared/Features/<From> and its server Feature and client
  // <From>Controller together, with the ./dev watcher's reaction suppressed while it happens.
  renameFeature(from: string, to: string): Promise<FeatureRenameResult>
}
