import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { git, userName, type CollabDeps } from '../collab/git.ts'
import { buildChangelog } from './changelog.ts'
import { readReleaseConfig, studioSyncPlaceIds, writeProjectVersion } from './config.ts'
import { lookupUniverseId, OpenCloudError, placeFormat, publishPlace } from './openCloud.ts'
import { runPreflight } from './preflight.ts'
import { DEFAULT_ROJO_PROJECT, detectMode, loadRojoSummary, rojoBuild, type RojoBuildOptions } from './rojo.ts'
import { projectScope, readSecret } from './secrets.ts'
import { bumpSemver, lastReleaseTag, listReleaseTags, parseSemver, formatSemver, suggestBump, tagFor, versionInfo } from './version.ts'
import type {
  CheckResult,
  FetchLike,
  KeyValueStore,
  NotifyEvent,
  NotifyResult,
  PlaceFileInfo,
  PreflightReport,
  ReleaseCheck,
  ReleasePlan,
  ReleaseRecord,
  ReleaseResult,
  ReleaseRunInput,
  ReleaseStep,
  ReleaseStepId,
  SecretStore
} from './types.ts'

// Release orchestration. Three modes (see types.ts ReleaseMode):
//   studio (default)  checks -> version -> tag -> push -> Discord -> "Publish from Studio now"
//   rojo   (opt-in)   checks -> confirm -> rojo build -> Open Cloud publish -> version/tag/push -> Discord
//   file              checks -> Open Cloud publish of an exported .rbxl/.rbxlx -> version/tag/push -> Discord
// Publishing happens before tagging so a rejected upload leaves no tag behind.

export const STUDIO_NEXT_ACTION = 'Publish from Studio now (File > Publish to Roblox).'

// Instance classes the Place Publishing API does not update (usage-place-publishing guide).
export const OPEN_CLOUD_UNSUPPORTED_CLASSES = ['EditableImage', 'EditableMesh', 'PartOperation', 'SurfaceAppearance', 'BaseWrap', 'WrapLayer', 'WrapTarget', 'WrapDeformer']

const HISTORY_LIMIT = 50

export interface ReleaseServiceDeps extends CollabDeps {
  secrets: SecretStore
  // Per-user store for history and settings (the app's Settings instance).
  store: KeyValueStore
  // The project's pre-flight checks (wire with preflight.ts defaultChecks).
  checks: (root: string) => ReleaseCheck[]
  notify?: (root: string, event: NotifyEvent) => Promise<NotifyResult>
  fetch?: FetchLike
  rojo?: RojoBuildOptions
  // Per-user placeFile override (from release user settings).
  userPlaceFile?: (root: string) => string | undefined
  now?: () => number
  onStep?: (root: string, step: ReleaseStep) => void
  onCheck?: (root: string, result: CheckResult) => void
}

export class ReleaseError extends Error {}

async function head(root: string, deps: CollabDeps): Promise<string> {
  return (await git(root, ['rev-parse', 'HEAD'], deps)).stdout.trim()
}

export function confirmTokenFor(headCommit: string, summary: { contains: string[]; services: string[] }): string {
  return createHash('sha256').update(JSON.stringify([headCommit, summary.contains, summary.services])).digest('hex').slice(0, 16)
}

export async function placeFileInfo(root: string, path: string, latestCommitAt?: number): Promise<PlaceFileInfo> {
  const full = isAbsolute(path) ? path : resolve(root, path)
  const format = placeFormat(full) ?? undefined
  try {
    const info = await stat(full)
    if (!info.isFile()) return { path: full, exists: false, format }
    const out: PlaceFileInfo = { path: full, exists: true, format, sizeBytes: info.size, modifiedAt: info.mtimeMs }
    if (latestCommitAt !== undefined) out.stale = info.mtimeMs < latestCommitAt
    // XML places name classes in plain text; binary places compress their chunks, so only .rbxlx is scanned.
    if (format === 'rbxlx' && info.size < 512 * 1024 * 1024) {
      const text = await readFile(full, 'utf8')
      const found = OPEN_CLOUD_UNSUPPORTED_CLASSES.filter((c) => text.includes(`class="${c}"`))
      if (found.length) out.unsupportedClasses = found
    }
    return out
  } catch {
    return { path: full, exists: false, format }
  }
}

export class ReleaseService {
  private deps: ReleaseServiceDeps
  private running = new Set<string>()

  constructor(deps: ReleaseServiceDeps) {
    this.deps = deps
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private historyKey(root: string): string {
    return `release.history.${projectScope(root)}`
  }

  history(root: string): ReleaseRecord[] {
    return this.deps.store.get<ReleaseRecord[]>(this.historyKey(root), [])
  }

  private saveRecord(root: string, record: ReleaseRecord): void {
    const list = this.history(root).filter((r) => r.tag !== record.tag)
    list.unshift(record)
    this.deps.store.set(this.historyKey(root), list.slice(0, HISTORY_LIMIT))
  }

  async preflight(root: string): Promise<PreflightReport> {
    return runPreflight(this.deps.checks(root), { onProgress: (r) => this.deps.onCheck?.(root, r) })
  }

  async plan(root: string, options: { skipPreflight?: boolean } = {}): Promise<ReleasePlan> {
    const config = await readReleaseConfig(root)
    const prefix = config.publish.tagPrefix ?? 'v'
    const detection = await detectMode(root, config.publish)
    const since = await lastReleaseTag(root, prefix, this.deps)
    const changelog = await buildChangelog(root, { ...this.deps, since })
    const allTags = await listReleaseTags(root, prefix, this.deps)
    const latestTag = allTags[0] ?? since
    const current = latestTag ? latestTag.slice(prefix.length) : config.version
    const version = versionInfo(latestTag, config.version, suggestBump(changelog.commits, current), prefix)
    const placeIdChoices = config.publish.placeId ? [config.publish.placeId] : await studioSyncPlaceIds(root)
    const preflight: PreflightReport = options.skipPreflight ? { ok: true, checks: [], blockers: [] } : await this.preflight(root)
    const warnings = [...config.issues]
    const mode = detection.mode
    const plan: ReleasePlan = {
      root,
      detection,
      mode,
      placeId: placeIdChoices.length === 1 ? placeIdChoices[0] : undefined,
      universeId: config.publish.universeId,
      placeIdChoices,
      versionType: config.publish.versionType ?? 'Published',
      version,
      changelog,
      preflight,
      hasOpenCloudKey: Boolean(await readSecret(this.deps.secrets, 'openCloudApiKey', root)),
      hasDiscordWebhook: Boolean(await readSecret(this.deps.secrets, 'discordWebhook', root)),
      warnings
    }
    if (mode === 'rojo') {
      const summary = await loadRojoSummary(root, config.publish.rojoProject || DEFAULT_ROJO_PROJECT)
      plan.rojo = { ...summary, confirmToken: confirmTokenFor(await head(root, this.deps), summary) }
      if (!detection.fullyManaged) warnings.push('This project is NOT fully managed by Rojo. Publishing the Rojo build will wipe everything that exists only in the Studio place.')
    }
    if (mode === 'file') {
      const path = this.deps.userPlaceFile?.(root) || config.publish.placeFile
      if (!path) warnings.push('No exported place file set. In Studio use File > Save to File As… and choose the .rbxl here.')
      else {
        const latest = Number((await git(root, ['log', '-1', '--format=%ct'], this.deps)).stdout.trim()) * 1000
        plan.placeFile = await placeFileInfo(root, path, Number.isFinite(latest) && latest > 0 ? latest : undefined)
        if (!plan.placeFile.exists) warnings.push(`Place file not found: ${plan.placeFile.path}`)
        else if (!plan.placeFile.format) warnings.push('The place file must be .rbxl or .rbxlx')
        if (plan.placeFile.stale) warnings.push('The exported place is older than the latest commit: re-export it from Studio so it has the newest scripts.')
        if (plan.placeFile.unsupportedClasses?.length) warnings.push(`Open Cloud will not update ${plan.placeFile.unsupportedClasses.join(', ')} instances in this place; publish from Studio if you changed them.`)
      }
    }
    if ((mode === 'rojo' || mode === 'file') && !plan.hasOpenCloudKey) warnings.push('No Open Cloud API key set (needs universe-places:write on this experience).')
    if ((mode === 'rojo' || mode === 'file') && !plan.placeId) warnings.push(placeIdChoices.length > 1 ? 'Several place IDs are configured: pick one.' : 'No place ID: set publish.placeId in .forge/project.json or placeIds in tools/studio-sync.json.')
    return plan
  }

  async run(root: string, input: ReleaseRunInput): Promise<ReleaseResult> {
    if (this.running.has(root)) return { ok: false, steps: [], error: 'A release is already running for this project' }
    this.running.add(root)
    const steps: ReleaseStep[] = []
    const step = (id: ReleaseStepId, state: ReleaseStep['state'], message?: string) => {
      const existing = steps.find((s) => s.id === id)
      const next = { id, state, message }
      if (existing) Object.assign(existing, next)
      else steps.push(next)
      this.deps.onStep?.(root, next)
    }
    let tempDir: string | undefined
    let record: ReleaseRecord | undefined
    let current: ReleaseStepId = 'preflight'
    try {
      const config = await readReleaseConfig(root)
      const prefix = config.publish.tagPrefix ?? 'v'
      const mode = input.mode

      // 1. Pre-flight (always fresh; blocking failures stop everything).
      step('preflight', 'running')
      const report = await this.preflight(root)
      if (!report.ok) {
        step('preflight', 'failed', report.blockers.join('\n'))
        return { ok: false, steps, error: `Pre-flight failed:\n${report.blockers.join('\n')}` }
      }
      step('preflight', 'done', report.checks.filter((c) => c.status === 'warn').map((c) => `${c.label}: ${c.summary}`).join('\n') || undefined)

      // 2. Version and changelog.
      const since = await lastReleaseTag(root, prefix, this.deps)
      const tags = await listReleaseTags(root, prefix, this.deps)
      const changelog = input.changelog ?? (await buildChangelog(root, { ...this.deps, since })).markdown
      const latestText = tags[0] ? tags[0].slice(prefix.length) : null
      const info = versionInfo(tags[0] ?? null, config.version, 'patch', prefix)
      let version: string
      if (input.version) {
        const parsed = parseSemver(input.version)
        if (!parsed) throw new ReleaseError(`"${input.version}" is not a semantic version like 1.2.3`)
        version = formatSemver(parsed)
      } else version = bumpSemver(info.current ?? latestText, input.bump ?? 'patch')
      const tag = tagFor(version, prefix)
      if (tags.includes(tag) || (await git(root, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], this.deps)).code === 0) throw new ReleaseError(`Tag ${tag} already exists. Pick a higher version.`)
      const by = await userName(root, this.deps)
      record = { version, tag, mode, at: this.now(), by, changelog, notified: false }

      // 3. Publish (Open Cloud modes).
      if (mode === 'rojo' || mode === 'file') {
        const syncIds = await studioSyncPlaceIds(root)
        const placeId = input.placeId ?? config.publish.placeId ?? (syncIds.length === 1 ? syncIds[0] : undefined)
        if (!placeId) throw new ReleaseError('No place ID to publish to')
        const apiKey = await readSecret(this.deps.secrets, 'openCloudApiKey', root)
        if (!apiKey) throw new ReleaseError('No Open Cloud API key set')
        let body: Uint8Array
        let format: 'rbxl' | 'rbxlx'
        if (mode === 'rojo') {
          current = 'build'
          const detection = await detectMode(root, config.publish)
          if (detection.mode !== 'rojo') throw new ReleaseError('Rojo publishing is off for this project: the Rojo build would wipe Studio-only content. Opt in with publish.mode "rojo" in .forge/project.json only if Rojo manages the whole place.')
          const projectFile = config.publish.rojoProject || DEFAULT_ROJO_PROJECT
          const summary = await loadRojoSummary(root, projectFile)
          const expected = confirmTokenFor(await head(root, this.deps), summary)
          if (!input.confirmToken || input.confirmToken !== expected) throw new ReleaseError('The Rojo publish was not confirmed for this exact build. Review what the build contains and confirm again.')
          step('build', 'running', `rojo build ${projectFile}`)
          tempDir = await mkdtemp(join(tmpdir(), 'forge-release-'))
          const out = join(tempDir, 'place.rbxl')
          await rojoBuild(root, out, { ...this.deps.rojo, projectFile })
          body = await readFile(out)
          format = 'rbxl'
          step('build', 'done', `${(body.byteLength / 1024).toFixed(0)} KB`)
        } else {
          step('build', 'skipped', 'Using the exported place file')
          const path = this.deps.userPlaceFile?.(root) || config.publish.placeFile
          if (!path) throw new ReleaseError('No exported place file set')
          const full = isAbsolute(path) ? path : resolve(root, path)
          const fmt = placeFormat(full)
          if (!fmt) throw new ReleaseError('The place file must be .rbxl or .rbxlx')
          format = fmt
          body = await readFile(full).catch(() => {
            throw new ReleaseError(`Cannot read ${full}`)
          })
        }
        current = 'publish'
        step('publish', 'running')
        const universeId = input.universeId ?? config.publish.universeId ?? (await lookupUniverseId(placeId, { fetch: this.deps.fetch }))
        const versionType = input.versionType ?? config.publish.versionType ?? 'Published'
        const published = await publishPlace({ universeId, placeId, apiKey, versionType, body, format, fetch: this.deps.fetch })
        Object.assign(record, { placeVersion: published.versionNumber, versionType, placeId })
        step('publish', 'done', `${versionType} place version ${published.versionNumber}`)
      } else {
        step('build', 'skipped')
        step('publish', 'skipped', 'Publish from Studio after the release')
        record.studioPublishPending = true
      }

      // 4. Version commit (only when .forge/project.json carries a version).
      current = 'version'
      let committed = false
      if (config.version !== null) {
        step('version', 'running')
        await writeProjectVersion(root, version)
        const add = await git(root, ['add', '--', '.forge/project.json'], this.deps)
        const commit = add.code === 0 ? await git(root, ['commit', '--only', '-m', `Release ${tag}`, '--', '.forge/project.json'], this.deps) : add
        if (commit.code !== 0) throw new ReleaseError(`Could not commit the version bump: ${(commit.stderr || commit.stdout).trim()}`)
        committed = true
        step('version', 'done', `.forge/project.json -> ${version}`)
      } else step('version', 'skipped', 'Version lives in the git tag')

      // 5. Annotated tag: the message carries the changelog, so every clone has the history.
      current = 'tag'
      step('tag', 'running')
      const tagged = await git(root, ['tag', '-a', '--cleanup=whitespace', tag, '-m', `Release ${tag}\n\n${changelog}`], this.deps)
      if (tagged.code !== 0) throw new ReleaseError(`git tag failed: ${(tagged.stderr || tagged.stdout).trim()}`)
      step('tag', 'done', tag)

      // 6. Push the commit (if any) and the tag.
      current = 'push'
      if (input.push === false) step('push', 'skipped', 'Not pushed: teammates will not see the tag until you push it')
      else {
        step('push', 'running')
        const branch = (await git(root, ['symbolic-ref', '--short', 'HEAD'], this.deps)).stdout.trim()
        const remote = (await git(root, ['config', `branch.${branch}.remote`], this.deps)).stdout.trim() || 'origin'
        if (committed) {
          const pushed = await git(root, ['push', remote, 'HEAD'], this.deps)
          if (pushed.code !== 0) throw new ReleaseError(`Push failed: ${(pushed.stderr || pushed.stdout).trim()}`)
        }
        const pushedTag = await git(root, ['push', remote, `refs/tags/${tag}`], this.deps)
        if (pushedTag.code !== 0) throw new ReleaseError(`Pushing ${tag} failed: ${(pushedTag.stderr || pushedTag.stdout).trim()}`)
        step('push', 'done', `${remote} ${tag}`)
      }

      // 7. Discord.
      current = 'notify'
      if (input.notify === false || !this.deps.notify) step('notify', 'skipped')
      else {
        step('notify', 'running')
        const result = await this.deps.notify(root, { kind: 'release', record })
        record.notified = result.sent
        step('notify', result.sent ? 'done' : result.error ? 'failed' : 'skipped', result.error ?? result.skipped)
      }

      this.saveRecord(root, record)
      return { ok: true, record, steps, nextAction: mode === 'studio' ? STUDIO_NEXT_ACTION : undefined }
    } catch (error) {
      const message = error instanceof OpenCloudError || error instanceof ReleaseError || error instanceof Error ? error.message : String(error)
      step(current, 'failed', message)
      // A publish that succeeded is still worth remembering even if tagging failed afterwards.
      if (record?.placeVersion !== undefined) this.saveRecord(root, record)
      return { ok: false, record, steps, error: message }
    } finally {
      this.running.delete(root)
      if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  // Studio mode: the person says they published from Studio; marks the record and tells the team.
  async markStudioPublished(root: string, tag: string): Promise<ReleaseRecord> {
    const record = this.history(root).find((r) => r.tag === tag)
    if (!record) throw new ReleaseError(`No release ${tag} in this computer's history`)
    record.studioPublishPending = false
    this.saveRecord(root, record)
    await this.deps.notify?.(root, { kind: 'publish', version: record.tag, by: record.by, studio: true })
    return record
  }

  // Team-wide history from annotated tags (any teammate's releases), merged with local records.
  async teamHistory(root: string, limit = 30): Promise<(Pick<ReleaseRecord, 'tag' | 'version' | 'at' | 'by' | 'changelog'> & Partial<ReleaseRecord>)[]> {
    const config = await readReleaseConfig(root)
    const prefix = config.publish.tagPrefix ?? 'v'
    const result = await git(root, ['for-each-ref', `refs/tags/${prefix}*`, '--sort=-version:refname', `--count=${limit}`, '--format=%1e%(refname:short)%1f%(creatordate:iso-strict)%1f%(taggername)%1f%(contents)'], this.deps)
    const local = new Map(this.history(root).map((r) => [r.tag, r]))
    const out: (Pick<ReleaseRecord, 'tag' | 'version' | 'at' | 'by' | 'changelog'> & Partial<ReleaseRecord>)[] = []
    for (const chunk of result.stdout.split('\x1e')) {
      if (!chunk.trim()) continue
      const [tag, date, tagger, contents = ''] = chunk.split('\x1f')
      const semver = parseSemver(tag.slice(prefix.length))
      if (!semver) continue
      const changelog = contents.replace(/^Release [^\n]*\n\n?/, '').trim()
      out.push({ ...local.get(tag), tag, version: formatSemver(semver), at: Date.parse(date) || 0, by: tagger || local.get(tag)?.by || '', changelog })
    }
    return out
  }
}
