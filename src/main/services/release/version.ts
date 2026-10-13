import { git, type CollabDeps } from '../collab/git.ts'
import type { BumpKind, ChangelogCommit, VersionInfo } from './types.ts'

// Semantic versions for releases: git tags vX.Y.Z are the shared record (they travel with fetch/push);
// .forge/project.json `version` is optional and, when present, is bumped in a release commit too.

export interface Semver {
  major: number
  minor: number
  patch: number
  prerelease?: string
}

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseSemver(value: string): Semver | null {
  const match = SEMVER.exec(value.trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] }
}

export function formatSemver(v: Semver): string {
  return `${v.major}.${v.minor}.${v.patch}${v.prerelease ? `-${v.prerelease}` : ''}`
}

export function compareSemver(a: Semver, b: Semver): number {
  for (const key of ['major', 'minor', 'patch'] as const) if (a[key] !== b[key]) return a[key] - b[key]
  // A prerelease sorts before its release.
  if (a.prerelease === b.prerelease) return 0
  if (!a.prerelease) return 1
  if (!b.prerelease) return -1
  return a.prerelease < b.prerelease ? -1 : 1
}

export function bumpSemver(value: string | null, kind: BumpKind): string {
  const v = (value && parseSemver(value)) || { major: 0, minor: 0, patch: 0 }
  // 1.2.3-rc.1 + patch = 1.2.3 (finishing the prerelease), like npm version.
  if (v.prerelease) {
    if (kind === 'patch' || (kind === 'minor' && v.patch === 0) || (kind === 'major' && v.minor === 0 && v.patch === 0)) return formatSemver({ ...v, prerelease: undefined })
  }
  if (kind === 'major') return formatSemver({ major: v.major + 1, minor: 0, patch: 0 })
  if (kind === 'minor') return formatSemver({ major: v.major, minor: v.minor + 1, patch: 0 })
  return formatSemver({ major: v.major, minor: v.minor, patch: v.patch + 1 })
}

export function tagFor(version: string, prefix = 'v'): string {
  return `${prefix}${formatSemver(parseSemver(version) ?? { major: 0, minor: 0, patch: 0 })}`
}

// Breaking change -> major (minor while < 1.0), any feature -> minor, else patch.
export function suggestBump(commits: Pick<ChangelogCommit, 'kind' | 'breaking'>[], current: string | null): BumpKind {
  const pre1 = !current || (parseSemver(current)?.major ?? 0) === 0
  if (commits.some((c) => c.breaking)) return pre1 ? 'minor' : 'major'
  if (commits.some((c) => c.kind === 'feature')) return 'minor'
  return 'patch'
}

// Release tags reachable or not; highest semver wins. Only tags with the prefix that parse.
export async function listReleaseTags(root: string, prefix = 'v', deps: CollabDeps = {}): Promise<string[]> {
  const result = await git(root, ['tag', '--list', `${prefix}*`], deps)
  if (result.code !== 0) return []
  return result.stdout
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter((t) => t.startsWith(prefix) && parseSemver(t.slice(prefix.length)))
    .sort((a, b) => compareSemver(parseSemver(b.slice(prefix.length))!, parseSemver(a.slice(prefix.length))!))
}

// The newest release tag that is an ancestor of HEAD: the changelog starts there.
export async function lastReleaseTag(root: string, prefix = 'v', deps: CollabDeps = {}): Promise<string | null> {
  const result = await git(root, ['describe', '--tags', '--abbrev=0', '--match', `${prefix}[0-9]*`, 'HEAD'], deps)
  if (result.code === 0 && result.stdout.trim()) return result.stdout.trim()
  return null
}

export function versionInfo(latestTag: string | null, projectVersion: string | null, bump: BumpKind, prefix = 'v'): VersionInfo {
  const fromTag = latestTag ? parseSemver(latestTag.slice(prefix.length)) : null
  const fromProject = projectVersion ? parseSemver(projectVersion) : null
  let current: Semver | null = fromTag
  if (fromProject && (!current || compareSemver(fromProject, current) > 0)) current = fromProject
  const currentText = current ? formatSemver(current) : null
  return {
    current: currentText,
    latestTag,
    projectVersion: fromProject ? formatSemver(fromProject) : null,
    storage: projectVersion !== null ? 'project' : 'tag',
    suggestedBump: bump,
    next: {
      major: bumpSemver(currentText, 'major'),
      minor: bumpSemver(currentText, 'minor'),
      patch: bumpSemver(currentText ?? '0.0.0', 'patch')
    }
  }
}
