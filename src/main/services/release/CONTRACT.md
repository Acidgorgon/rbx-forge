# Release service: integration contract

"Publish to Roblox" and team notifications for GenTree games. Main process only. Nothing here imports
electron; everything is exported from `src/main/services/release/index.ts`. Tests:
`test/releaseCloud.test.ts` (fake fetch: Open Cloud, Discord, notifier, secrets) and
`test/releaseFlow.test.ts` (temp git repos with a bare remote: changelog, version, preflight, full
studio/rojo/file runs).

## Why there are three modes

`rojo build` makes a place that holds **only** what `default.project.json` maps. GenTree marks its code
folders `$ignoreUnknownInstances` because maps, models, GUIs, lighting and terrain live only in the
Studio place. Publishing a Rojo build would replace the live place and **wipe all of that**. So:

| Mode | When | What Forge does |
|---|---|---|
| `studio` (default) | every GenTree game | checks → changelog → version bump → annotated tag → push → Discord → tells the person **"Publish from Studio now (File > Publish to Roblox)."** |
| `rojo` | only if `.forge/project.json` has `publish.mode: "rojo"`, or the project is detected fully managed (maps Workspace, no `$ignoreUnknownInstances`, no `tools/studio-sync.json`) | checks → **blocking confirm** listing what the build contains and what gets wiped → `rojo build <project> -o <tmp>.rbxl` → Open Cloud publish → version/tag/push → Discord |
| `file` | the person exported the place (File > Save to File As…) and set its path | checks → Open Cloud publish of that `.rbxl`/`.rbxlx` → version/tag/push → Discord |

The service enforces this, not just the UI: `run({mode:'rojo'})` is refused unless detection says
`rojo`, and it needs `confirmToken` equal to `plan.rojo.confirmToken` (a hash of HEAD + the build's
mappings, so it goes stale if the code or project file changes). Publishing happens **before**
tagging, so a rejected upload leaves no tag.

## Files

| File | What it does |
|---|---|
| `types.ts` | All data types (mirror into shared types, below) and the injection interfaces `FetchLike`, `SecretStore`, `KeyValueStore` |
| `openCloud.ts` | `lookupUniverseId(placeId)`, `publishPlace({...})`, `OpenCloudError` (`kind`: invalid-request/unauthorized/forbidden/not-found/conflict/rate-limited/server/network/invalid-input), `contentTypeFor`, `parseVersionNumber`, `looksLikeApiKey` |
| `discord.ts` | `payload(embeds)`, `releaseEmbed`, `eventEmbed`, `clampEmbed` (all documented limits), `postWebhook` (429 `retry_after` handling, 404 = gone), `isWebhookUrl`, `redactWebhookUrl` |
| `notify.ts` | `Notifier.notify(event)` / `.test(by)`, `NotificationTogglesSchema` (zod), `defaultToggles`, `parseToggles` |
| `secrets.ts` | `secretKey(kind, root?)`, `readSecret` (project → global fallback), `MemorySecretStore`, `createEncryptedSecretStore(safeStorage, settings)` |
| `version.ts` | semver parse/compare/bump, `suggestBump`, `listReleaseTags`, `lastReleaseTag`, `versionInfo`, `tagFor` |
| `changelog.ts` | `buildChangelog(root, {since})`: commits since the last tag (conventional prefixes or verb guess, GenTree feature per commit, Forge auto-sync commits folded) + `.studio-sync/sync.log` activity → Markdown |
| `preflight.ts` | `runPreflight(checks)`, `gitCheck`, `studioConflictsCheck`, `blinkCheck`, `luneTestsCheck`, `seleneCheck`, `customCheck`, `defaultChecks(root, deps)` |
| `rojo.ts` | `detectMode`, `summarizeRojoProject`, `loadRojoSummary`, `rojoBuild` |
| `config.ts` | `readReleaseConfig` (`publish` + `version` from `.forge/project.json`), `writeProjectVersion`, `studioSyncPlaceIds`, `PublishConfigSchema`, `ReleaseProjectFields` |
| `release.ts` | `ReleaseService`: `plan`, `run`, `preflight`, `history`, `teamHistory`, `markStudioPublished`; `placeFileInfo` |

## 1. `.forge/project.json` (team settings, committed, never secrets)

```json
{
  "version": "1.4.2",
  "publish": { "mode": "studio", "placeId": 1234567, "universeId": 7654321, "versionType": "Published",
               "placeFile": "exports/game.rbxl", "rojoProject": "default.project.json", "tagPrefix": "v" }
}
```

All optional. `version` present → each release also commits the bump (`Release vX.Y.Z`, that file
only). Absent → the version lives only in tags `vX.Y.Z`. `placeId` falls back to
`tools/studio-sync.json` `placeIds` (when exactly one). `universeId` falls back to the lookup.

**Required change in `collab/config.ts`:** `ProjectConfigSchema` is a plain `z.object`, which strips
unknown keys, so saving team settings from the collab UI would delete `version` and `publish`. Change it
to `z.object({...existing, ...ReleaseProjectFields})` (import from `../release/config.ts`), and add both
keys to the `FORGE_README` text. Until then `release/config.ts` reads/writes raw JSON so it never drops
keys itself.

## 2. Add to `src/shared/types.ts`

Copy these from `release/types.ts` verbatim (they are plain data): `ReleaseMode`, `VersionType`,
`PublishConfig`, `ModeDetection`, `RojoBuildSummary`, `CheckStatus`, `CheckOutcome`, `CheckResult`,
`PreflightReport`, `ChangeKind`, `ChangelogCommit`, `StudioActivity`, `Changelog`, `BumpKind`,
`VersionInfo`, `ReleasePlan`, `PlaceFileInfo`, `ReleaseRunInput`, `ReleaseStepId`, `ReleaseStep`,
`ReleaseRecord`, `ReleaseResult`, `ReleaseUserSettings`, `NotifyEventKind`, `NotifyEvent`, `NotificationToggles`,
`NotifyResult`. Plus:

```ts
export interface ReleaseSecretsStatus { openCloudApiKey: boolean; discordWebhook: boolean; webhookHint?: string } // hint = redactWebhookUrl()
export interface ReleaseHistoryEntry { tag: string; version: string; at: number; by: string; changelog: string; mode?: ReleaseMode; placeVersion?: number; versionType?: VersionType; studioPublishPending?: boolean; notified?: boolean }
```

## 3. Wiring in `main/index.ts`

```ts
import { safeStorage } from 'electron'
import * as release from './services/release'
import { checkBlink } from './services/blink'
import { runSelene } from './services/collab'

const secrets = release.createEncryptedSecretStore(safeStorage, settings)          // Settings instance
const userRelease = (root: string): ReleaseUserSettings => {
  const v = settings.get<Partial<ReleaseUserSettings>>(`release.user.${release.projectScope(root)}`, {})
  return { placeFile: v.placeFile, notifications: release.parseToggles(v.notifications) }
}
const notifiers = new Map<string, release.Notifier>()
const notifierFor = (root: string) => notifiers.get(root) ?? notifiers.set(root, new release.Notifier({
  root, secrets, toggles: () => userRelease(root).notifications,
  game: () => projectInfo(root)?.name,                       // Rojo project name
  log: (t) => logs.add('release', t),
  onWebhookGone: () => send('release:webhookGone', { root }),
})).get(root)!
const releases = new release.ReleaseService({
  secrets, store: settings,
  checks: (root) => release.defaultChecks(root, {
    studioConflicts: () => new StudioConflicts(root).list(),
    blink: () => checkBlink(root),
    selene: () => runSelene(root),                           // respect config.lint.selene: omit when off
    lune: luneRunnerFor(root),                               // omit when the project has no Lune tests
  }),
  notify: (root, event) => notifierFor(root).notify(event),
  userPlaceFile: (root) => userRelease(root).placeFile,
  onStep: (root, step) => send('release:step', { root, step }),
  onCheck: (root, result) => send('release:check', { root, result }),
})
```

`luneRunnerFor` must return `() => Promise<LuneTestRun>` (`{ ran, passed, failed, note?, failures? }`);
return `ran: false` with a note when there is no Lune or no tests, so the check shows **skipped**, not
passed. Only `fetch` is optional (defaults to the global fetch in Electron's main process).

### Notification hooks (call `notifierFor(root).notify(event)`, fire-and-forget, never block)

| Event | Where | Payload |
|---|---|---|
| `sync` | after `GitSync.sync()` resolves | `{ kind:'sync', by: userName, pulled, pushed, branch, subjects? }` — pass the counts that actually moved; zero/zero is never posted; throttled to one per 2 min |
| `push` | after an explicit push (e.g. feature branch push) | `{ kind:'push', by, branch, commits, subjects? }` |
| `test-failure` | the test agent finishes a scenario with a failure | `{ kind:'test-failure', scenario, summary, by, details? }` (details is put in a code block, truncated) |
| `release` / `publish` | sent by `ReleaseService` itself | — |

Defaults: release, publish, test-failure **on**; sync, push **off**.

## 4. IPC (all `ipcMain.handle`, `root` = current project root)

| Channel | Args | Returns | Notes |
|---|---|---|---|
| `release:plan` | `{ skipPreflight?: boolean }` | `ReleasePlan` | Runs pre-flight unless skipped; emits `release:check` per check |
| `release:preflight` | — | `PreflightReport` | Re-run checks only |
| `release:run` | `ReleaseRunInput` | `ReleaseResult` | Emits `release:step`; one run per project at a time |
| `release:markStudioPublished` | `{ tag }` | `ReleaseHistoryEntry` | Studio mode: "I published it" → posts `publish` |
| `release:history` | — | `ReleaseHistoryEntry[]` | `teamHistory(root)` (tags from every teammate + local publish details) |
| `release:secrets:status` | — | `ReleaseSecretsStatus` | **Never returns secret values** |
| `release:secrets:set` | `{ kind: 'openCloudApiKey'\|'discordWebhook', value: string, scope: 'project'\|'global' }` | `ReleaseSecretsStatus` | Validate with `looksLikeApiKey` / `isWebhookUrl` first; `secrets.set(secretKey(kind, scope==='project' ? root : undefined), value)` |
| `release:secrets:clear` | `{ kind, scope }` | `ReleaseSecretsStatus` | |
| `release:settings:get` / `release:settings:set` | — / `Partial<ReleaseUserSettings>` | `ReleaseUserSettings` | Per-user; stored in Settings, not in the repo |
| `release:project:set` | `PublishConfig` | `PublishConfig` | Writes `publish` into `.forge/project.json` (validate with `PublishConfigSchema`); the person commits it via normal sync |
| `release:notify:test` | — | `NotifyResult` | `notifierFor(root).test(userName)` |
| `release:choosePlaceFile` | — | `string \| null` | `dialog.showOpenDialog` filters `rbxl`, `rbxlx` |

Events (main → renderer): `release:step` `{ root, step: ReleaseStep }`, `release:check`
`{ root, result: CheckResult }`, `release:webhookGone` `{ root }`.

Preload: `window.harness.release = { plan, preflight, run, markStudioPublished, history, secretsStatus,
setSecret, clearSecret, getSettings, setSettings, setProjectPublish, testNotify, choosePlaceFile }`
plus the three events through the existing `on()`.

## 5. UI: Release drawer

Opened from a **Release** button in the top bar (and the command palette: "Release…").

1. **Header**: current version (`plan.version.current` or "No releases yet"), mode pill
   (`Studio publish` / `Rojo build` / `Exported file`) with `detection.reasons` in a tooltip. Mode picker:
   Studio (always), Exported file (always), Rojo build (disabled with the reasons unless
   `detection.mode === 'rojo'`).
2. **Checklist** (`plan.preflight.checks`, live via `release:check`): icon per status (pass ✓, warn !,
   fail ✕, skip –), label, summary, expandable `details`. Each failing check gets a fix action:
   git → "Sync now", studio-sync → open the Studio conflicts panel, blink → open events.blink at the first
   diagnostic, selene → open Problems, lune → open test output. "Re-check" button. The Release button is
   disabled while any blocking check fails.
3. **Version**: radio Patch / Minor / Major showing `plan.version.next[kind]`, preselect
   `suggestedBump`; "Custom…" text field validated as semver. Note under it: "Saved as tag vX.Y.Z" or
   "Also updates .forge/project.json".
4. **Changelog editor**: Monaco (markdown) or textarea prefilled with `plan.changelog.markdown`;
   "Regenerate" reloads the plan's text. Small caption: "N commits by A, B since vX.Y.Z; Studio: M
   scripts". Sent as `ReleaseRunInput.changelog`. Show a 4096-char counter (Discord description limit;
   longer text is truncated in Discord only, the tag keeps it all).
5. **Mode-specific block**
   - Studio: info box "After Forge tags the release, open the place in Studio and use File > Publish to
     Roblox. Maps, models and UI only exist there."
   - Exported file: path field + Browse (`release:choosePlaceFile`), show size/modified time, warnings
     for `stale` and `unsupportedClasses`; Place ID (select from `placeIdChoices` or input), Universe ID
     (optional, "looked up automatically"), Saved / Published toggle (`versionType`).
   - Rojo build: same Place/Universe/Saved-Published fields, then the **blocking confirm**: a red panel
     listing `plan.rojo.contains` and every `plan.rojo.warnings` line, a checkbox "I understand the
     published place will contain only this, and everything else in the live place is replaced", and the
     Release button is labelled "Build and publish". Pass `confirmToken` only after the checkbox is
     ticked.
6. **Keys** (collapsible "Connections"):
   - Open Cloud API key: password field, "Saved ✓ / Not set" from `secretsStatus`, scope radio
     (this game / all my games), Save / Remove, help text: "Create at create.roblox.com/dashboard/credentials.
     Add the universe-places API with Write for this experience. Stored encrypted on this computer only."
     Shown only for Rojo/file modes.
   - Discord webhook URL: password field, hint shows `webhookHint`, Save / Remove / "Send test".
   - Notification toggles (labels in ReleasePage.tsx `NOTIFY_LABEL`), bound to `release:settings`.
7. **Release button** → `release:run`; progress list from `release:step` (preflight, build, publish,
   version, tag, push, notify). On success in Studio mode show a prominent card with `nextAction` and a
   button "I've published it" → `release:markStudioPublished`. On failure show `error` and the failed
   step; Open Cloud errors already contain the fix in plain words (e.g. 403 names the scope).
8. **History** tab: `release:history` list (tag, date, who, mode badge, place version, "Studio publish
   pending" badge with the "I've published it" action), expandable changelog.

`plan.warnings` render as a yellow list above the Release button.

## 6. Verified API facts (sources)

- Place Publishing: `POST https://apis.roblox.com/universes/v1/{universeId}/places/{placeId}/versions?versionType=Saved|Published`,
  `x-api-key` header, body = place file, `Content-Type: application/octet-stream` (.rbxl) or
  `application/xml` (.rbxlx); success body `{"versionNumber": N}` (guide) — the reference types it as a
  string, so both are parsed. Scope `universe-places:write`. 400 invalid request/file, 401 key not valid
  for the operation, 403 publish not allowed (scope), 404 place/universe missing, 409 place not in that
  universe, 500 server. Rate limit 30 requests/minute per API key owner. Beta. Not updated by the API:
  EditableImage, EditableMesh, PartOperation, SurfaceAppearance, BaseWrap.
  https://create.roblox.com/docs/cloud/guides/usage-place-publishing ·
  https://create.roblox.com/docs/cloud/reference/features/places
- Errors: 429 = RESOURCE_EXHAUSTED; v1 error bodies vary (`errors[]`, `code/message`,
  `error/message/errorDetails`, validation problem). https://create.roblox.com/docs/cloud/reference/errors
- Place → universe: `GET https://apis.roblox.com/universes/v1/places/{placeId}/universe` → `{"universeId":N}`,
  no auth. **Not on create.roblox.com's reference**; community-documented (devforum thread 780807) and
  verified live (place 1818 → 13058). `publish.universeId` overrides it.
- Discord Execute Webhook: `POST /webhooks/{id}/{token}`, `embeds` ≤ 10, `allowed_mentions`, 204 without
  `?wait=true`; embed limits title 256 / description 4096 / 25 fields / name 256 / value 1024 / footer 2048 /
  author 256 / 6000 total; 429 body `retry_after` float seconds + `Retry-After` header; a 404 webhook must
  not be reused. https://docs.discord.com/developers/resources/webhook ·
  https://docs.discord.com/developers/resources/message · https://docs.discord.com/developers/topics/rate-limits

## 7. Security rules

- Secrets only through `SecretStore` (safeStorage-encrypted in userData). Never in the repo, `.forge/`,
  logs, IPC results, the changelog or Discord messages. The renderer can set/clear but never read them.
- `createEncryptedSecretStore` refuses to store when `safeStorage.isEncryptionAvailable()` is false.
- Webhook messages use `allowed_mentions: { parse: [] }` so commit text cannot ping `@everyone`.
- `publishPlace` is never retried automatically (a retry after an ambiguous failure could publish twice).
