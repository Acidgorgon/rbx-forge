# Collaboration services: integration contract

Main-process only, plain `git` CLI + filesystem. Everything is exported from
`src/main/services/collab/index.ts`. Nothing here imports electron. Tests: `test/collab.test.ts`
(real temp repos: a bare remote with clones for "Alex" and "Sam Lee") and `test/collabParsers.test.ts`
(fixtures in `test/fixtures/collab/`).

| File | What it does |
|---|---|
| `git.ts` | `git()` runner (no prompts/editor/pager, `core.quotepath=false`), `CollabDeps` injection (`git`, `env`, `findTool`) |
| `classify.ts` | `classifyPath` / `groupByFeature`: GenTree feature + Scripts-panel category from a path (uses `project.ts` `categorize`) |
| `join.ts` | `joinProject` clone → `rokit install` → `wally install` → validate `default.project.json`, with progress. Never runs `./dev` |
| `incoming.ts` | `incomingChanges`: fetch, commits on `@{u}` not in HEAD, files (stats, capped diffs, grouped), local changes, overlap, optional `summarize` hook |
| `activity.ts` | `activityFeed`: git log + `.studio-sync/sync.log` in one timeline |
| `blame.ts` | `blame` (`git blame --line-porcelain <HEAD>`; LRU cached by HEAD+path), `fileHistory` (`git log --follow`) |
| `config.ts` | `.forge/project.json` zod schema, read/validate/write, defaults, `.forge/README.md` text |
| `branches.ts` | `startFeatureBranch`, `openPullRequest` (gh, else GitHub compare URL), `listOpenPRs` |
| `claims.ts` | `.forge/claims.json` "working on" markers: claim/release/list, stale (>3 days) + contested flags, `stageClaims` / `commitClaims` (that file only) |
| `quality.ts` | `runSelene` (json2), `runStylua` (`--check --output-format=json`), `preSyncCheck` on changed Luau files |

## 1. Add to `src/shared/types.ts`

These mirror the service types structurally, so the service results can be returned as is.

```ts
// ---- Collaboration (main/services/collab) ----

export type CollabCategory = ScriptCategory | 'Project'

export interface JoinProjectInput {
  repoUrl: string
  parentDir: string
  name?: string
  // Pass --no-trust-check to rokit after the person agreed to trust the game's pinned tools.
  trustTools?: boolean
}
export type JoinStepId = 'clone' | 'rokit' | 'wally' | 'validate'
export interface JoinProgress {
  step: JoinStepId
  state: 'running' | 'done' | 'skipped' | 'failed'
  message?: string
  percent?: number
}
export interface JoinResult {
  root: string
  projectName: string
  steps: { step: JoinStepId; state: 'done' | 'skipped' | 'failed'; note?: string }[]
  notes: string[]
}

export type FileChangeStatus =
  | 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked' | 'conflicted' | 'unknown'
export interface ChangedFile {
  path: string
  status: FileChangeStatus
  added: number
  deleted: number
  binary: boolean
  feature?: string
  category: CollabCategory
  diff?: string
  diffTruncated?: boolean
}
export interface IncomingCommit {
  hash: string
  author: string
  email: string
  at: number
  subject: string
}
export interface ChangeGroup {
  key: string // "feature:Shop" | "category:Services"
  label: string
  feature?: string
  category?: CollabCategory
  items: ChangedFile[]
}
export interface IncomingChanges {
  isRepo: boolean
  upstream: string | null
  fetched: boolean
  fetchError?: string
  commits: IncomingCommit[]
  files: ChangedFile[]
  groups: ChangeGroup[]
  local: ChangedFile[]
  overlap: string[] // changed upstream AND locally: a merge may conflict
  truncatedFiles?: number
  summary?: string
  summaryError?: string
  note?: string
}

export interface ActivityEntry {
  at: number
  who: string // git author, or 'Studio'
  kind: 'commit' | 'studio'
  files: { path: string; change: string }[]
  message: string
  commit?: string
  studioAction?: 'pull' | 'new' | 'conflict'
}
export interface ActivityQuery {
  since?: number
  until?: number
  author?: string // substring; 'Studio' = Studio entries only
  feature?: string
  limit?: number
}

export interface BlameLine {
  line: number
  author: string
  at: number
  commit: string
  summary: string
  content: string
}
export interface BlameResult {
  path: string
  head: string
  lines: BlameLine[]
}
export interface FileHistoryEntry {
  commit: string
  author: string
  at: number
  subject: string
  path: string
  change: string
}

export interface ForgeProjectConfig {
  conventions: string
  aiRules: string
  testScenarios: { name: string; steps: string[] }[]
  lint: { selene: boolean; stylua: boolean }
  branchPrefix?: string
}
export interface ForgeProjectConfigRead {
  exists: boolean
  config: ForgeProjectConfig
  issues?: { path: string; message: string }[]
}

export interface StartBranchResult {
  branch: string
  from: string | null
  synced: boolean
  note?: string
}
export interface PullRequestInput {
  title: string
  body?: string
  base?: string
  draft?: boolean
}
export type PullRequestResult =
  | { kind: 'created'; url: string; branch: string; base: string }
  | { kind: 'browser'; url: string; branch: string; base: string; reason: string }
export interface OpenPullRequest {
  number: number
  title: string
  url: string
  author: string
  branch: string
  draft: boolean
  updatedAt: string
}
export interface OpenPullRequests {
  available: boolean
  prs: OpenPullRequest[]
  reason?: string
}

export interface ClaimView {
  who: string
  what: string // repo path or "feature:<Name>"
  since: string // ISO
  note?: string
  stale: boolean // older than 3 days
  contested: boolean // someone else claims the same/overlapping thing
  others: string[]
  mine?: boolean
}

export interface Problem {
  path: string
  line: number // 1-based
  col: number // 1-based
  endLine?: number
  endCol?: number
  severity: 'error' | 'warning' | 'info'
  message: string
  source: 'selene' | 'stylua'
  code?: string
}
export interface ToolRun {
  ran: boolean
  problems: Problem[]
  note?: string
  exitCode?: number
}
export interface PreSyncReport {
  files: string[]
  problems: Problem[]
  errors: number
  warnings: number
  ok: boolean // no error-level problems
  selene?: ToolRun
  stylua?: ToolRun
  notes: string[]
}
```

Add to `HarnessEvents`:

```ts
  'collab:joinProgress': JoinProgress
  // .forge/claims.json changed (after claim/release, or a sync that pulled teammates' claims).
  'collab:claims': ClaimView[]
```

Add to `HarnessApi`:

```ts
  // Collaboration
  joinProject(input: JoinProjectInput): Promise<JoinResult>
  incomingChanges(options?: { summarize?: boolean }): Promise<IncomingChanges>
  activityFeed(query?: ActivityQuery): Promise<ActivityEntry[]>
  blameFile(path: string): Promise<BlameResult>
  fileHistory(path: string, limit?: number): Promise<FileHistoryEntry[]>
  getForgeConfig(): Promise<ForgeProjectConfigRead>
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
```

## 2. Add to `src/preload/index.ts` `methods`

```ts
  'joinProject', 'incomingChanges', 'activityFeed', 'blameFile', 'fileHistory',
  'getForgeConfig', 'setForgeConfig', 'startFeatureBranch', 'openPullRequest', 'listOpenPRs',
  'listClaims', 'claim', 'releaseClaim', 'runLint', 'formatFiles', 'preSyncCheck',
```

## 3. Add to the `handlers` object in `src/main/index.ts`

```ts
import { shell } from 'electron'
import * as collab from './services/collab/index.ts'

// Helper next to requireProject():
const root = () => requireProject().root

  joinProject: async (input: JoinProjectInput) => {
    const result = await collab.joinProject(input, {
      trustTools: input.trustTools,
      onProgress: (p) => emit('collab:joinProgress', p)
    })
    // Optional: open it right away (supervisor will start ./dev etc. as for any opened project).
    // await openProject(result.root)
    return result
  },
  incomingChanges: (options?: { summarize?: boolean }) =>
    collab.incomingChanges(root(), {
      // Wire to a one-shot model call (agent layer) when the person asks for a summary:
      // summarize: options?.summarize ? (input) => summarizeWithModel(collab.incomingPrompt(input)) : undefined
    }),
  activityFeed: (query?: ActivityQuery) => collab.activityFeed(root(), query ?? { since: Date.now() - 14 * 864e5 }),
  blameFile: (path: string) => collab.blame(root(), path),
  fileHistory: (path: string, limit?: number) => collab.fileHistory(root(), path, { limit }),
  getForgeConfig: () => collab.readProjectConfig(root()),
  setForgeConfig: (config: ForgeProjectConfig) => collab.writeProjectConfig(root(), config),
  startFeatureBranch: async (name: string) => {
    // Reuse the app's sync (commit + pull --rebase + push) before branching.
    const result = await collab.startFeatureBranch(root(), name, {
      sync: git ? async () => ({ error: (await git!.syncNow()).error }) : undefined
    })
    await git?.refresh()
    return result
  },
  openPullRequest: async (input: PullRequestInput) => {
    const result = await collab.openPullRequest(root(), input)
    if (result.kind === 'browser') void shell.openExternal(result.url)
    await git?.refresh()
    return result
  },
  listOpenPRs: () => collab.listOpenPRs(root()),
  listClaims: () => collab.listClaims(root()),
  claim: async (what: string, note?: string) => {
    const list = await collab.claim(root(), what, { note })
    await collab.commitClaims(root(), `forge: claim ${what}`) // only .forge/claims.json (+ .gitattributes)
    void git?.syncNow()
    emit('collab:claims', list)
    return list
  },
  releaseClaim: async (what: string) => {
    const list = await collab.release(root(), what)
    await collab.commitClaims(root(), `forge: release ${what}`)
    void git?.syncNow()
    emit('collab:claims', list)
    return list
  },
  runLint: async (paths?: string[]) => ({
    selene: await collab.runSelene(root(), paths),
    stylua: await collab.runStylua(root(), paths, { check: true })
  }),
  formatFiles: (paths: string[]) => collab.runStylua(root(), paths, { check: false }),
  preSyncCheck: () => collab.preSyncCheck(root()),
```

Notes for the integrator:

- `GitSync.syncNow()` commits with `git add -A`, which also picks up claims; `commitClaims` exists so a
  claim reaches teammates even when auto-commit is off. After a sync that pulled, re-emit
  `collab:claims` (`collab.listClaims(root)`) so the panel shows teammates' new claims.
- Optional gate: before `syncNow`, call `preSyncCheck()` and warn (not block) on `errors > 0`.
- `GitSync.status()` is unchanged; `incomingChanges` does its own `git fetch`.
- `.forge/project.json` `aiRules` / `conventions` are meant to be appended to the agent system prompt,
  and `testScenarios` to seed the Test agents panel (agent/ owners).
- `joinProject` never runs `./dev`. rokit asks for trust on a TTY before installing a tool it has not
  seen; Forge has no TTY, so the UI should ask once ("Trust the tools pinned in rokit.toml?") and pass
  `trustTools: true`, which adds `--no-trust-check`. Without it a failed install is reported with a
  note, not thrown.
- The template's `rokit.toml` pins rojo, wally and blink only, although its README says Selene; selene
  and stylua are looked up with `findTool` (rokit's bin first) and reported as "not found" with a fix
  when absent. Suggest adding `selene = "Kampfkarren/selene@…"` / `stylua = "JohnnyMorganz/StyLua@…"`
  to the template.
