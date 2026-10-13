// Packages: Wally dependencies (wally.toml) and Rokit tools (rokit.toml).
//
// - Wally search and metadata come from the public registry API behind wally.run:
//     GET https://api.wally.run/v1/package-search?query=<q>      -> [{ scope, name, description, versions }]
//     GET https://api.wally.run/v1/package-metadata/<scope>/<name> -> { versions: [{ package: { version, realm, ... } }] }
// - wally.toml and rokit.toml are edited line by line, so comments, order and spacing survive.
// - After a wally.toml change the game's ./dev loop runs `wally install` (it polls the file's mtime).
//   When the dev loop is not running, or nothing shows up in Packages/ after a while, Forge runs
//   `wally install` itself and streams the output to the logs.
// - Latest tool versions come from the GitHub releases API (unauthenticated unless GITHUB_TOKEN is
//   set), cached, and skipped while rate limited.
//
// The plain functions near the top (searchWally, listWallyDependencies, addWallyDependency,
// removeWallyDependency, ...) take a project root and need no Electron, so they can be wrapped as
// AI tools later.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  LogLine,
  PackagesChanged,
  RokitTool,
  WallyAddSpec,
  WallyDependency,
  WallyPackage,
  WallyRealm
} from '../../shared/types.ts'
import { findTool, toolEnv } from './tools.ts'

export const WALLY_API = 'https://api.wally.run/v1'
const GITHUB_API = 'https://api.github.com'
const META_TTL_MS = 10 * 60_000
const RELEASE_TTL_MS = 60 * 60_000
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

type FetchFn = typeof fetch

// ------------------------------------------------------------------ semver

export interface SemVer {
  major: number
  minor: number
  patch: number
  pre: string
}

// Parses "1.2.3", "v1.2.3", "1.2.3-rc.1+build", "1.2" (missing parts are 0). Null when no number.
export function parseVersion(text: string): SemVer | null {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(text)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0), pre: m[4] ?? '' }
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return x ? 1 : y ? -1 : 0
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (x[key] !== y[key]) return x[key] - y[key]
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}

// Highest stable version, or the highest prerelease when nothing is stable.
export function latestVersion(versions: string[]): string {
  const sorted = [...versions].sort((a, b) => compareVersions(b, a))
  return sorted.find((v) => !parseVersion(v)?.pre) ?? sorted[0] ?? ''
}

// The bare version inside a requirement: "^1.2.0" -> "1.2.0", "=0.4.1" -> "0.4.1".
export function requirementBase(req: string): string {
  const m = /\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?/.exec(req)
  return m ? m[0] : req.trim()
}

// Swaps the version in a requirement and keeps a simple operator: "^1.2.0" -> "^2.0.0".
export function replaceRequirement(req: string, version: string): string {
  const m = /^\s*(\^|=|~)?\s*\d/.exec(req)
  return (m?.[1] ?? '') + version
}

// GitHub release tag to a version: "v0.18.9" -> "0.18.9", "0.32.0" stays,
// "v0.7.4+registry.0.2.3" -> "0.7.4+registry.0.2.3" (Rokit keeps build metadata).
export function tagToVersion(tag: string): string {
  const m = /\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/.exec(tag)
  return m ? m[0] : tag.replace(/^v/i, '')
}

// ------------------------------------------------------------------ TOML lines
//
// wally.toml and rokit.toml only use `[section]` headers and `key = "string"` lines, so a line
// editor is enough and keeps everything it does not touch byte-for-byte.

export interface TomlEntry {
  section: string
  key: string
  value: string
  // 0-based line index.
  line: number
}

const SECTION_RE = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/
const ENTRY_RE = /^(\s*)("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)(\s*=\s*)"((?:[^"\\]|\\.)*)"(.*)$/

function unquoteKey(key: string): string {
  return key.startsWith('"') ? key.slice(1, -1) : key
}

function splitLines(text: string): { lines: string[]; eol: string } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return { lines: text.split(/\r?\n/), eol }
}

export function tomlEntries(text: string): TomlEntry[] {
  const out: TomlEntry[] = []
  let section = ''
  splitLines(text).lines.forEach((raw, line) => {
    const header = SECTION_RE.exec(raw)
    if (header) {
      section = header[1]
      return
    }
    const m = ENTRY_RE.exec(raw)
    if (m) out.push({ section, key: unquoteKey(m[2]), value: m[4], line })
  })
  return out
}

function formatKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
}

// Sets `key = "value"` in [section]. Replaces the value in place when the key exists (keeping its
// spacing and any trailing comment); otherwise inserts after the section's last entry, or adds
// the section at the end of the file.
export function tomlSet(text: string, section: string, key: string, value: string): string {
  const { lines, eol } = splitLines(text)
  const existing = tomlEntries(text).find((e) => e.section === section && e.key === key)
  if (existing) {
    const m = ENTRY_RE.exec(lines[existing.line]) as RegExpExecArray
    lines[existing.line] = `${m[1]}${m[2]}${m[3]}"${value}"${m[5]}`
    return lines.join(eol)
  }
  const newLine = `${formatKey(key)} = "${value}"`
  let current = ''
  let headerLine = -1
  let lastEntry = -1
  lines.forEach((raw, i) => {
    const header = SECTION_RE.exec(raw)
    if (header) {
      current = header[1]
      if (current === section) headerLine = i
      return
    }
    if (current === section && ENTRY_RE.test(raw)) lastEntry = i
  })
  if (headerLine >= 0) {
    const at = (lastEntry >= 0 ? lastEntry : headerLine) + 1
    // Match the indentation of the section's other entries.
    const indent = lastEntry >= 0 ? (/^\s*/.exec(lines[lastEntry]) as RegExpExecArray)[0] : ''
    lines.splice(at, 0, indent + newLine)
    return lines.join(eol)
  }
  // New section at the end, separated by a blank line.
  const trailing = lines.length > 0 && lines[lines.length - 1] === ''
  if (trailing) lines.pop()
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  if (lines.length) lines.push('')
  lines.push(`[${section}]`, newLine)
  if (trailing) lines.push('')
  return lines.join(eol)
}

export function tomlRemove(text: string, section: string, key: string): string {
  const entry = tomlEntries(text).find((e) => e.section === section && e.key === key)
  if (!entry) return text
  const { lines, eol } = splitLines(text)
  lines.splice(entry.line, 1)
  return lines.join(eol)
}

// ------------------------------------------------------------------ wally.toml

export const WALLY_SECTIONS: Record<WallyRealm, string> = {
  shared: 'dependencies',
  server: 'server-dependencies',
  dev: 'dev-dependencies'
}
const PACKAGE_DIRS: Record<WallyRealm, string> = { shared: 'Packages', server: 'ServerPackages', dev: 'DevPackages' }

function realmOfSection(section: string): WallyRealm | null {
  for (const [realm, name] of Object.entries(WALLY_SECTIONS)) if (name === section) return realm as WallyRealm
  return null
}

// "scope/name@version" -> parts. Null for anything else (git deps, typos).
export function parsePackageSpec(spec: string): { scope: string; name: string; version: string } | null {
  const m = /^\s*([a-z0-9_-]+)\/([a-z0-9_-]+)@(.+?)\s*$/i.exec(spec)
  return m ? { scope: m[1].toLowerCase(), name: m[2].toLowerCase(), version: m[3] } : null
}

export interface ManifestDependency {
  alias: string
  scope: string
  name: string
  version: string
  realm: WallyRealm
  line: number
}

export function parseWallyManifest(text: string): ManifestDependency[] {
  const out: ManifestDependency[] = []
  for (const e of tomlEntries(text)) {
    const realm = realmOfSection(e.section)
    const spec = realm && parsePackageSpec(e.value)
    if (realm && spec) out.push({ alias: e.key, realm, line: e.line, ...spec })
  }
  return out
}

function words(name: string): string[] {
  return name.split(/[^A-Za-z0-9]+/).filter(Boolean)
}

// "vide-charm" -> "VideCharm"
export function pascalAlias(name: string): string {
  return words(name)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('')
}

// "vide-charm" -> "Videcharm" (the style `wally` scaffolding and the GenTree template use).
export function capitalizedAlias(name: string): string {
  const joined = words(name).join('').toLowerCase()
  return joined ? joined[0].toUpperCase() + joined.slice(1) : ''
}

// Default alias for a package, following the file's existing style: when a multi-word package is
// already aliased as "Videcharm" use that style, otherwise PascalCase ("VideCharm").
export function defaultAlias(name: string, existing: ManifestDependency[]): string {
  const multi = existing.filter((d) => words(d.name).length > 1)
  const capitalized = multi.some((d) => d.alias === capitalizedAlias(d.name) && d.alias !== pascalAlias(d.name))
  return capitalized ? capitalizedAlias(name) : pascalAlias(name)
}

export class PackageError extends Error {}

// Returns the new wally.toml text. Throws PackageError on an alias collision or a package that is
// already added under another alias in the same realm. Re-adding the same alias for the same
// package and realm updates its version.
export function wallyAdd(text: string, spec: WallyAddSpec): { text: string; alias: string } {
  const scope = spec.scope.trim().toLowerCase()
  const name = spec.name.trim().toLowerCase()
  const version = spec.version.trim()
  if (!/^[a-z0-9_-]+$/.test(scope) || !/^[a-z0-9_-]+$/.test(name)) throw new PackageError(`Not a Wally package: ${scope}/${name}`)
  if (!version) throw new PackageError('Pick a version.')
  const deps = parseWallyManifest(text)
  const alias = (spec.alias?.trim() || defaultAlias(name, deps)).trim()
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(alias)) throw new PackageError(`"${alias}" is not a valid alias. Use letters, digits, - and _.`)
  const clash = deps.find((d) => d.alias.toLowerCase() === alias.toLowerCase())
  if (clash) {
    const same = clash.scope === scope && clash.name === name
    if (!same) {
      throw new PackageError(
        `The alias ${clash.alias} is already used by ${clash.scope}/${clash.name} in [${WALLY_SECTIONS[clash.realm]}]. Pick another alias.`
      )
    }
    if (clash.realm !== spec.realm) {
      throw new PackageError(`${scope}/${name} is already in [${WALLY_SECTIONS[clash.realm]}] as ${clash.alias}. Remove it there first.`)
    }
  } else {
    const dup = deps.find((d) => d.scope === scope && d.name === name && d.realm === spec.realm)
    if (dup) throw new PackageError(`${scope}/${name} is already added as ${dup.alias}.`)
  }
  const key = clash ? clash.alias : alias
  return { text: tomlSet(text, WALLY_SECTIONS[spec.realm], key, `${scope}/${name}@${version}`), alias: key }
}

export function wallyRemove(text: string, alias: string, realm: WallyRealm): string {
  const dep = parseWallyManifest(text).find((d) => d.alias === alias && d.realm === realm)
  if (!dep) throw new PackageError(`${alias} is not in [${WALLY_SECTIONS[realm]}].`)
  return tomlRemove(text, WALLY_SECTIONS[realm], alias)
}

// Resolved versions from wally.lock: alias -> "scope/name@version" of the root package's deps.
export function parseWallyLock(text: string, rootName?: string): Map<string, string> {
  const out = new Map<string, string>()
  const blocks = text.split(/^\[\[package\]\]\s*$/m).slice(1)
  for (const block of blocks) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1]
    if (rootName && name !== rootName) continue
    const deps = /^dependencies\s*=\s*(\[.*\])\s*$/m.exec(block)?.[1]
    if (!deps) continue
    try {
      const list = JSON.parse(deps) as [string, string][]
      if (!rootName && list.length === 0) continue
      for (const [alias, id] of list) out.set(alias, id)
    } catch {
      // not JSON-compatible; ignore
    }
    if (rootName) break
  }
  return out
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// wally.toml deps with install state (Packages/ folders and wally.lock), without registry data.
export function listWallyDependencies(root: string): WallyDependency[] {
  const manifest = readText(join(root, 'wally.toml'))
  if (manifest === null) return []
  const rootName = tomlEntries(manifest).find((e) => e.section === 'package' && e.key === 'name')?.value
  const lockText = readText(join(root, 'wally.lock'))
  const lock = lockText ? parseWallyLock(lockText, rootName) : new Map<string, string>()
  return parseWallyManifest(manifest).map((d) => {
    const locked = parsePackageSpec(lock.get(d.alias) ?? '')
    const installed = existsSync(join(root, PACKAGE_DIRS[d.realm], `${d.alias}.lua`))
    const dep: WallyDependency = {
      alias: d.alias,
      scope: d.scope,
      name: d.name,
      version: d.version,
      realm: d.realm,
      installed,
      updateAvailable: false
    }
    if (installed && locked && locked.scope === d.scope && locked.name === d.name) dep.installedVersion = locked.version
    return dep
  })
}

export function addWallyDependency(root: string, spec: WallyAddSpec): string {
  const path = join(root, 'wally.toml')
  const text = readText(path)
  if (text === null) throw new PackageError('This project has no wally.toml.')
  const result = wallyAdd(text, spec)
  if (result.text !== text) writeFileSync(path, result.text)
  return result.alias
}

export function removeWallyDependency(root: string, alias: string, realm: WallyRealm): void {
  const path = join(root, 'wally.toml')
  const text = readText(path)
  if (text === null) throw new PackageError('This project has no wally.toml.')
  writeFileSync(path, wallyRemove(text, alias, realm))
}

// ------------------------------------------------------------------ Wally registry

export interface WallySearchHit {
  scope: string
  name: string
  description?: string | null
  versions: string[]
}

// Authors of widely used packages. The registry has many re-uploads of popular packages under
// other scopes (search returns them in arbitrary order), so these rank first among equal names.
export const WELL_KNOWN_SCOPES = new Set([
  'sleitnick', 'howmanysmall', 'centau', 'littensy', 'ukendio', 'evaera', 'roblox', 'jsdotlua', 'stravant',
  'osyrisrblx', 'csqrl', 'red-blox', '1foreverhd', 'pepeeltoro41', 'alicesaidhi', 'solarhorizon', 'kampfkarren',
  'elttob', 'dphfox', 'nezuo', 'ffrostflame', 'quenty', 'validark', 'reselim', 'nightrains', 'mark-marks'
])

// Normalises a /v1/package-search response (each hit carries only its newest version) and ranks
// it: exact name matches, then name prefix matches, well-known scopes first among those.
export function parseSearchResponse(json: unknown, query: string): WallyPackage[] {
  if (!Array.isArray(json)) return []
  const q = query.trim().toLowerCase()
  const qName = q.includes('/') ? q.split('/')[1] : q
  const qScope = q.includes('/') ? q.split('/')[0] : ''
  const hits: WallyPackage[] = []
  for (const item of json as Partial<WallySearchHit>[]) {
    if (!item || typeof item.scope !== 'string' || typeof item.name !== 'string') continue
    const versions = (Array.isArray(item.versions) ? item.versions.filter((v) => typeof v === 'string') : []).sort((a, b) =>
      compareVersions(b, a)
    )
    if (!versions.length) continue
    const pkg: WallyPackage = { scope: item.scope, name: item.name, latest: latestVersion(versions), versions }
    if (item.description) pkg.description = String(item.description).trim()
    hits.push(pkg)
  }
  const score = (p: WallyPackage) => {
    let s = 0
    if (p.name === qName) s += 1000
    else if (p.name.startsWith(qName)) s += 400
    else if (p.name.includes(qName)) s += 150
    if (qScope && p.scope === qScope) s += 2000
    if (p.description) s += 20
    if (WELL_KNOWN_SCOPES.has(p.scope)) s += 300
    return s
  }
  return hits
    .map((p, i) => ({ p, i, s: score(p) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.p)
}

interface MetadataVersion {
  package?: {
    name?: string
    version?: string
    realm?: string
    description?: string | null
    authors?: string[]
    license?: string | null
    repository?: string | null
  }
}

// Normalises a /v1/package-metadata/<scope>/<name> response.
export function parseMetadataResponse(json: unknown, scope: string, name: string): WallyPackage {
  const list = (json as { versions?: MetadataVersion[] })?.versions
  if (!Array.isArray(list) || list.length === 0) throw new PackageError(`${scope}/${name} has no published versions.`)
  const versions = list
    .map((v) => v.package?.version)
    .filter((v): v is string => typeof v === 'string')
    .sort((a, b) => compareVersions(b, a))
  const latest = latestVersion(versions)
  const meta = list.find((v) => v.package?.version === latest)?.package ?? list[0].package ?? {}
  const pkg: WallyPackage = { scope, name, latest, versions }
  if (meta.description) pkg.description = meta.description.trim()
  if (meta.realm === 'server' || meta.realm === 'shared') pkg.realm = meta.realm
  if (meta.authors?.length) pkg.authors = meta.authors
  if (meta.license) pkg.license = meta.license
  if (meta.repository) pkg.repository = meta.repository
  return pkg
}

async function getJson(fetchFn: FetchFn, url: string, headers: Record<string, string> = {}, timeoutMs = 8000): Promise<unknown> {
  const response = await fetchFn(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) {
    const error = new Error(`${response.status} ${response.statusText || ''}`.trim()) as Error & { status?: number; headers?: Headers }
    error.status = response.status
    error.headers = response.headers
    throw error
  }
  return response.json()
}

export async function searchWally(query: string, fetchFn: FetchFn = fetch): Promise<WallyPackage[]> {
  const q = query.trim()
  if (!q) return []
  const json = await getJson(fetchFn, `${WALLY_API}/package-search?query=${encodeURIComponent(q)}`)
  return parseSearchResponse(json, q).slice(0, 40)
}

export async function wallyMetadata(id: string, fetchFn: FetchFn = fetch, timeoutMs = 8000): Promise<WallyPackage> {
  const parsed = /^\s*([a-z0-9_-]+)\/([a-z0-9_-]+)\s*$/i.exec(id)
  if (!parsed) throw new PackageError(`Expected scope/name, got "${id}"`)
  const scope = parsed[1].toLowerCase()
  const name = parsed[2].toLowerCase()
  try {
    const json = await getJson(fetchFn, `${WALLY_API}/package-metadata/${scope}/${name}`, {}, timeoutMs)
    return parseMetadataResponse(json, scope, name)
  } catch (error) {
    if ((error as { status?: number }).status === 404) throw new PackageError(`${scope}/${name} is not on the Wally registry.`)
    throw error
  }
}

// ------------------------------------------------------------------ Rokit

export interface CuratedTool {
  name: string
  repo: string
  description: string
}

// Repos checked against github.com/<repo>/releases/latest.
export const CURATED_TOOLS: CuratedTool[] = [
  { name: 'luau-lsp', repo: 'JohnnyMorganz/luau-lsp', description: 'Luau language server. Forge’s editor uses it for diagnostics, completion and hover.' },
  { name: 'rojo', repo: 'rojo-rbx/rojo', description: 'Syncs the repo into Studio and builds places.' },
  { name: 'wally', repo: 'UpliftGames/wally', description: 'Package manager for Roblox (wally.toml).' },
  { name: 'stylua', repo: 'JohnnyMorganz/StyLua', description: 'Opinionated Luau code formatter.' },
  { name: 'selene', repo: 'Kampfkarren/selene', description: 'Fast Luau linter (selene.toml).' },
  { name: 'blink', repo: '1Axen/blink', description: 'Networking IDL compiler (events.blink).' },
  { name: 'zap', repo: 'red-blox/zap', description: 'Alternative networking IDL compiler.' },
  { name: 'lune', repo: 'lune-org/lune', description: 'Standalone Luau runtime for scripts and tooling.' },
  { name: 'darklua', repo: 'seaofvoices/darklua', description: 'Transforms and bundles Luau code.' },
  { name: 'pesde', repo: 'pesde-pkg/pesde', description: 'Newer package manager for Luau.' }
]

export function parseRokitManifest(text: string): { name: string; repo: string; version: string; line: number }[] {
  const out: { name: string; repo: string; version: string; line: number }[] = []
  for (const e of tomlEntries(text)) {
    if (e.section !== 'tools') continue
    const m = /^\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@(.+?)\s*$/.exec(e.value)
    if (m) out.push({ name: e.key, repo: m[1], version: m[2], line: e.line })
  }
  return out
}

export function rokitSet(text: string, name: string, repo: string, version: string): string {
  // rokit.toml always has [tools]; tomlSet adds it when missing.
  return tomlSet(text, 'tools', name, `${repo}@${version}`)
}

export function rokitHome(): string {
  return process.env.ROKIT_ROOT || join(process.platform === 'win32' ? process.env.USERPROFILE || homedir() : homedir(), '.rokit')
}

// Rokit keeps binaries at <home>/tool-storage/<owner>/<repo>/<version>/<repo>[.exe], lowercased.
export function rokitInstalled(repo: string, version: string, home = rokitHome()): boolean {
  const [owner, name] = repo.split('/')
  const exe = process.platform === 'win32' ? '.exe' : ''
  for (const [o, n] of [
    [owner.toLowerCase(), name.toLowerCase()],
    [owner, name]
  ]) {
    if (existsSync(join(home, 'tool-storage', o, n, version, n + exe))) return true
  }
  return false
}

// ------------------------------------------------------------------ service

export interface PackagesOptions {
  root: () => string | null
  // The ./dev loop is running (it runs wally install when wally.toml changes).
  devRunning: () => boolean
  log: (line: Omit<LogLine, 'at'>) => void
  emit: (payload: PackagesChanged) => void
  fetch?: FetchFn
  findTool?: (name: string) => string | null
  rokitHome?: string
  // How long to wait for the dev loop's wally install before running it directly.
  devInstallWaitMs?: number
}

interface Cached<T> {
  at: number
  value: T
}

export class Packages {
  private options: PackagesOptions
  private meta = new Map<string, Cached<WallyPackage>>()
  private releases = new Map<string, Cached<string | null>>()
  private rateLimitedUntil = 0
  private installing: 'wally' | 'rokit' | null = null
  private wallyRun: Promise<void> | null = null
  private wallyAgain = false
  private lastError: string | undefined

  constructor(options: PackagesOptions) {
    this.options = options
  }

  private get fetchFn(): FetchFn {
    return this.options.fetch ?? fetch
  }

  private tool(name: string): string | null {
    return (this.options.findTool ?? findTool)(name)
  }

  private root(): string {
    const root = this.options.root()
    if (!root) throw new PackageError('No project open')
    return root
  }

  private log(text: string, stream: LogLine['stream'] = 'info'): void {
    this.options.log({ service: 'harness', stream, text })
  }

  // ---------------------------------------------------------------- wally

  async search(query: string): Promise<WallyPackage[]> {
    const results = await searchWally(query, this.fetchFn)
    // Realm (and a fuller description) only come with metadata; fetch it for the top hits.
    await Promise.all(
      results.slice(0, 10).map(async (hit, i) => {
        try {
          const meta = await this.metadata(`${hit.scope}/${hit.name}`, 4000)
          results[i] = { ...hit, ...meta, description: hit.description || meta.description }
        } catch {
          // keep the search hit as is
        }
      })
    )
    return results
  }

  async metadata(id: string, timeoutMs?: number): Promise<WallyPackage> {
    const key = id.trim().toLowerCase()
    const hit = this.meta.get(key)
    if (hit && Date.now() - hit.at < META_TTL_MS) return hit.value
    const value = await wallyMetadata(key, this.fetchFn, timeoutMs)
    this.meta.set(key, { at: Date.now(), value })
    return value
  }

  // Local state only (fast).
  localDeps(): WallyDependency[] {
    const root = this.options.root()
    return root ? this.withLatest(listWallyDependencies(root)) : []
  }

  private withLatest(deps: WallyDependency[]): WallyDependency[] {
    return deps.map((d) => {
      const latest = this.meta.get(`${d.scope}/${d.name}`)?.value.latest
      if (!latest) return d
      // Compare with whichever is newer: the requirement or what wally.lock resolved it to.
      const wanted = requirementBase(d.version)
      const have = d.installedVersion && compareVersions(d.installedVersion, wanted) > 0 ? d.installedVersion : wanted
      return { ...d, latest, updateAvailable: compareVersions(latest, have) > 0 }
    })
  }

  async listDeps(): Promise<WallyDependency[]> {
    const root = this.options.root()
    if (!root) return []
    const deps = listWallyDependencies(root)
    await mapLimit(deps, 6, async (d) => {
      try {
        await this.metadata(`${d.scope}/${d.name}`)
      } catch {
        // offline or unknown package: no update info
      }
    })
    return this.withLatest(deps)
  }

  async addDep(spec: WallyAddSpec): Promise<WallyDependency[]> {
    const root = this.root()
    // Server-only packages must live in [server-dependencies]; wally install refuses otherwise.
    if (spec.realm === 'shared') {
      const meta = await this.metadata(`${spec.scope}/${spec.name}`).catch(() => null)
      if (meta?.realm === 'server') {
        throw new PackageError(`${spec.scope}/${spec.name} is a server package. Add it as a server dependency.`)
      }
    }
    const alias = addWallyDependency(root, spec)
    this.log(`wally.toml: ${alias} = "${spec.scope}/${spec.name}@${spec.version}" in [${WALLY_SECTIONS[spec.realm]}]`)
    this.afterWallyChange({ alias, realm: spec.realm, present: true })
    return this.localDeps()
  }

  async removeDep(alias: string, realm: WallyRealm): Promise<WallyDependency[]> {
    const root = this.root()
    removeWallyDependency(root, alias, realm)
    this.log(`wally.toml: removed ${alias} from [${WALLY_SECTIONS[realm]}]`)
    this.afterWallyChange({ alias, realm, present: false })
    return this.localDeps()
  }

  async updateDep(alias: string, realm: WallyRealm, version?: string): Promise<WallyDependency[]> {
    const root = this.root()
    const dep = listWallyDependencies(root).find((d) => d.alias === alias && d.realm === realm)
    if (!dep) throw new PackageError(`${alias} is not in [${WALLY_SECTIONS[realm]}].`)
    const target = version || (await this.metadata(`${dep.scope}/${dep.name}`)).latest
    return this.addDep({ scope: dep.scope, name: dep.name, realm, alias, version: replaceRequirement(dep.version, target) })
  }

  // The dev loop notices wally.toml changes within a second or two and runs wally install. Wait
  // for Packages/ to reflect the change; if the dev loop is not running (or misses it), run
  // wally install directly.
  private afterWallyChange(expect: { alias: string; realm: WallyRealm; present: boolean }): void {
    const root = this.root()
    this.lastError = undefined
    this.setInstalling('wally')
    const marker = join(root, PACKAGE_DIRS[expect.realm], `${expect.alias}.lua`)
    const done = () => existsSync(marker) === expect.present
    void (async () => {
      if (this.options.devRunning()) {
        this.log('wally.toml changed; the dev loop will run wally install')
        const waitMs = this.options.devInstallWaitMs ?? 45_000
        const until = Date.now() + waitMs
        while (Date.now() < until && !done()) await sleep(750)
        // A version bump leaves the alias in place; give the dev loop a moment to finish.
        if (done() && expect.present) await sleep(1500)
        if (done()) {
          this.finishInstall()
          return
        }
        this.log('dev loop did not install in time; running wally install', 'stderr')
      }
      await this.wallyInstall()
    })().catch((error) => {
      this.lastError = String((error as Error)?.message ?? error)
      this.finishInstall()
    })
  }

  // Runs `wally install` in the project root, one at a time (a second request reruns it after).
  wallyInstall(): Promise<void> {
    if (this.wallyRun) {
      this.wallyAgain = true
      return this.wallyRun
    }
    this.setInstalling('wally')
    this.wallyRun = (async () => {
      do {
        this.wallyAgain = false
        const wally = this.tool('wally')
        if (!this.options.root()) break
        if (!wally) {
          this.lastError = 'wally not found. Add it with Tools → wally, or run rokit install.'
          this.log(this.lastError, 'stderr')
          break
        }
        const code = await this.stream(wally, ['install'], 'wally')
        if (code !== 0) this.lastError = `wally install failed (exit ${code}). See Logs.`
        else this.lastError = undefined
      } while (this.wallyAgain)
    })().finally(() => {
      this.wallyRun = null
      this.finishInstall()
    })
    return this.wallyRun
  }

  private setInstalling(kind: 'wally' | 'rokit' | null): void {
    this.installing = kind
    this.options.emit({ installing: kind, error: this.lastError, wally: kind === 'wally' ? this.localDeps() : undefined })
  }

  private finishInstall(): void {
    this.installing = null
    const payload: PackagesChanged = { installing: null, error: this.lastError }
    try {
      payload.wally = this.localDeps()
      payload.tools = this.localTools()
    } catch {
      // project closed meanwhile
    }
    this.options.emit(payload)
  }

  status(): { installing: 'wally' | 'rokit' | null; error?: string } {
    return { installing: this.installing, error: this.lastError }
  }

  private stream(file: string, args: string[], label: string): Promise<number> {
    const root = this.root()
    this.log(`$ ${label} ${args.join(' ')}`)
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(file, args, { cwd: root, env: toolEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      } catch (error) {
        this.log(`${label}: ${error}`, 'stderr')
        resolve(1)
        return
      }
      const pipe = (stream: 'stdout' | 'stderr') => {
        let buffer = ''
        return (chunk: Buffer) => {
          buffer += chunk.toString('utf8')
          const lines = buffer.split(/\r?\n|\r/)
          buffer = lines.pop() ?? ''
          for (const raw of lines) {
            const text = raw.replace(ANSI, '').trimEnd()
            if (text.trim()) this.options.log({ service: 'harness', stream, text: `${label}: ${text}` })
          }
        }
      }
      child.stdout?.on('data', pipe('stdout'))
      child.stderr?.on('data', pipe('stderr'))
      child.on('error', (error) => {
        this.log(`${label}: ${error.message}`, 'stderr')
        resolve(1)
      })
      child.on('close', (code) => resolve(code ?? 1))
    })
  }

  // ---------------------------------------------------------------- rokit

  // Latest release version for owner/repo, or null when unknown (offline, rate limited, no releases).
  async latestRelease(repo: string): Promise<string | null> {
    const key = repo.toLowerCase()
    const hit = this.releases.get(key)
    if (hit && Date.now() - hit.at < RELEASE_TTL_MS) return hit.value
    if (Date.now() < this.rateLimitedUntil) return hit?.value ?? null
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'rbx-forge' }
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
    try {
      const json = (await getJson(this.fetchFn, `${GITHUB_API}/repos/${repo}/releases/latest`, headers, 6000)) as { tag_name?: string }
      const value = json.tag_name ? tagToVersion(json.tag_name) : null
      this.releases.set(key, { at: Date.now(), value })
      return value
    } catch (error) {
      const e = error as { status?: number; headers?: Headers }
      if (e.status === 403 || e.status === 429) {
        const reset = Number(e.headers?.get('x-ratelimit-reset'))
        this.rateLimitedUntil = reset ? reset * 1000 : Date.now() + 10 * 60_000
        this.log(`GitHub API rate limit reached; tool update checks paused until ${new Date(this.rateLimitedUntil).toLocaleTimeString()}`)
      } else if (e.status === 404) {
        this.releases.set(key, { at: Date.now(), value: null })
      }
      return hit?.value ?? null
    }
  }

  private manifestText(): string {
    return readText(join(this.root(), 'rokit.toml')) ?? ''
  }

  private describe(name: string, repo: string, version: string, inManifest: boolean): RokitTool {
    const curated = CURATED_TOOLS.find((t) => t.repo.toLowerCase() === repo.toLowerCase())
    const home = this.options.rokitHome ?? rokitHome()
    const tool: RokitTool = {
      name,
      repo,
      version,
      inManifest,
      installed: inManifest && rokitInstalled(repo, version, home),
      onPath: !!this.tool(name),
      updateAvailable: false
    }
    if (curated) tool.description = curated.description
    const latest = this.releases.get(repo.toLowerCase())?.value
    if (latest) {
      tool.latest = latest
      tool.updateAvailable = inManifest && compareVersions(latest, version) > 0
    }
    return tool
  }

  localTools(): RokitTool[] {
    const root = this.options.root()
    if (!root) return []
    return parseRokitManifest(readText(join(root, 'rokit.toml')) ?? '').map((t) => this.describe(t.name, t.repo, t.version, true))
  }

  async listTools(): Promise<RokitTool[]> {
    if (!this.options.root()) return []
    const tools = parseRokitManifest(this.manifestText())
    await mapLimit(tools, 4, (t) => this.latestRelease(t.repo))
    return tools.map((t) => this.describe(t.name, t.repo, t.version, true))
  }

  async curated(): Promise<RokitTool[]> {
    const root = this.options.root()
    const manifest = root ? parseRokitManifest(this.manifestText()) : []
    await mapLimit(CURATED_TOOLS, 4, (t) => this.latestRelease(t.repo))
    return CURATED_TOOLS.map((c) => {
      const entry = manifest.find((m) => m.repo.toLowerCase() === c.repo.toLowerCase())
      return entry ? this.describe(entry.name, entry.repo, entry.version, true) : this.describe(c.name, c.repo, '', false)
    })
  }

  async addTool(repo: string, version?: string): Promise<RokitTool[]> {
    const root = this.root()
    const m = /^\s*([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\s*(?:@\s*(\S+))?\s*$/.exec(repo)
    if (!m) throw new PackageError(`Expected owner/repo, got "${repo}"`)
    const fullRepo = `${m[1]}/${m[2]}`
    const target = version || m[3] || (await this.latestRelease(fullRepo))
    if (!target) throw new PackageError(`Could not find a release for ${fullRepo}. Give a version, e.g. ${fullRepo}@1.0.0.`)
    const manifest = parseRokitManifest(this.manifestText())
    const existing = manifest.find((t) => t.repo.toLowerCase() === fullRepo.toLowerCase())
    if (existing) return this.setToolVersion(existing.name, existing.repo, target)
    const curated = CURATED_TOOLS.find((t) => t.repo.toLowerCase() === fullRepo.toLowerCase())
    const alias = curated?.name ?? m[2].toLowerCase()
    if (manifest.some((t) => t.name === alias)) throw new PackageError(`rokit.toml already has a tool named ${alias}.`)
    const rokit = this.tool('rokit')
    this.lastError = undefined
    this.setInstalling('rokit')
    try {
      if (rokit) {
        // rokit add edits rokit.toml, trusts the tool and installs it.
        const code = await this.stream(rokit, ['add', `${fullRepo}@${target}`, alias], 'rokit')
        if (code !== 0) throw new PackageError(`rokit add ${fullRepo}@${target} failed (exit ${code}). See Logs.`)
      } else {
        writeFileSync(join(root, 'rokit.toml'), rokitSet(this.manifestText(), alias, fullRepo, target))
        this.lastError = 'Added to rokit.toml, but rokit is not installed. Install Rokit, then run rokit install.'
        this.log(this.lastError, 'stderr')
      }
    } catch (error) {
      this.lastError = (error as Error).message
      throw error
    } finally {
      this.finishInstall()
    }
    return this.localTools()
  }

  async updateTool(name: string): Promise<RokitTool[]> {
    const tool = parseRokitManifest(this.manifestText()).find((t) => t.name === name)
    if (!tool) throw new PackageError(`${name} is not in rokit.toml.`)
    this.releases.delete(tool.repo.toLowerCase())
    const latest = await this.latestRelease(tool.repo)
    if (!latest) throw new PackageError(`Could not get the latest release of ${tool.repo} (offline or GitHub rate limit).`)
    return this.setToolVersion(tool.name, tool.repo, latest)
  }

  private async setToolVersion(name: string, repo: string, version: string): Promise<RokitTool[]> {
    const root = this.root()
    writeFileSync(join(root, 'rokit.toml'), rokitSet(this.manifestText(), name, repo, version))
    this.log(`rokit.toml: ${name} = "${repo}@${version}"`)
    const rokit = this.tool('rokit')
    this.lastError = undefined
    this.setInstalling('rokit')
    try {
      if (!rokit) {
        this.lastError = 'rokit is not installed. Install Rokit, then run rokit install.'
      } else {
        const code = await this.stream(rokit, ['install'], 'rokit')
        if (code !== 0) this.lastError = `rokit install failed (exit ${code}). See Logs.`
      }
    } finally {
      this.finishInstall()
    }
    if (this.lastError) throw new PackageError(this.lastError)
    return this.localTools()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}
