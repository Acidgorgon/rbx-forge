import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toRepoPath } from '../tools.ts'
import { FORGE_DIR } from './config.ts'
import { git, userName, type CollabDeps } from './git.ts'

// "Working on" markers without a server: .forge/claims.json in the repo, carried by normal git sync.
// The file is written one claim per line and marked merge=union in .gitattributes, so two people
// claiming at the same time merge cleanly; the reader tolerates the duplicate lines and stray commas
// a union merge can leave, and the next write normalises the file.

export const CLAIMS_PATH = '.forge/claims.json'
export const STALE_DAYS = 3
const ATTRIBUTE_LINE = `${CLAIMS_PATH} merge=union`

export interface Claim {
  who: string
  // A repo path (file or folder) or a feature name such as "feature:Inventory".
  what: string
  // ISO time the claim was made.
  since: string
  note?: string
}

export interface ClaimView extends Claim {
  stale: boolean
  // Someone else claims the same thing (or a path inside/around it).
  contested: boolean
  others: string[]
  mine?: boolean
}

export interface ClaimOptions extends CollabDeps {
  who?: string
  now?: number
  note?: string
}

function normaliseWhat(what: string): string {
  const trimmed = what.trim()
  if (/^feature:/i.test(trimmed)) return 'feature:' + trimmed.slice('feature:'.length).trim()
  return toRepoPath(trimmed).replace(/\/+$/, '')
}

function isClaim(value: unknown): value is Claim {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.who === 'string' && typeof v.what === 'string' && typeof v.since === 'string' && (v.note === undefined || typeof v.note === 'string')
}

// Accepts a proper JSON array, or a union-merged / hand-edited file (one object per line, conflict
// markers, missing or doubled commas). Duplicates (same who+what) keep the earliest since.
export function parseClaims(text: string): Claim[] {
  let items: unknown[] = []
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) items = parsed
  } catch {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim().replace(/,$/, '').replace(/^,/, '')
      if (!line.startsWith('{')) continue
      try {
        items.push(JSON.parse(line))
      } catch {
        // skip a broken line
      }
    }
  }
  const byKey = new Map<string, Claim>()
  for (const item of items) {
    if (!isClaim(item)) continue
    const claim: Claim = { who: item.who, what: normaliseWhat(item.what), since: item.since }
    if (item.note) claim.note = item.note
    const key = `${claim.who}\0${claim.what}`
    const prior = byKey.get(key)
    if (!prior || Date.parse(claim.since) < Date.parse(prior.since)) byKey.set(key, prior?.note && !claim.note ? { ...claim, note: prior.note } : claim)
  }
  return [...byKey.values()].sort((a, b) => a.what.localeCompare(b.what) || a.since.localeCompare(b.since))
}

export function serialiseClaims(claims: Claim[]): string {
  if (claims.length === 0) return '[\n]\n'
  return '[\n' + claims.map((c) => JSON.stringify(c)).join(',\n') + '\n]\n'
}

// a and b overlap when equal, or one path contains the other.
export function overlaps(a: string, b: string): boolean {
  if (a === b) return true
  if (a.startsWith('feature:') || b.startsWith('feature:')) return a.toLowerCase() === b.toLowerCase()
  return a.startsWith(b + '/') || b.startsWith(a + '/')
}

export function viewClaims(claims: Claim[], now = Date.now(), me?: string, staleDays = STALE_DAYS): ClaimView[] {
  return claims.map((claim) => {
    const others = [...new Set(claims.filter((c) => c.who !== claim.who && overlaps(c.what, claim.what)).map((c) => c.who))]
    const view: ClaimView = {
      ...claim,
      stale: now - Date.parse(claim.since) > staleDays * 24 * 60 * 60 * 1000,
      contested: others.length > 0,
      others
    }
    if (me !== undefined) view.mine = claim.who === me
    return view
  })
}

export async function readClaims(root: string): Promise<Claim[]> {
  try {
    return parseClaims(await readFile(join(root, CLAIMS_PATH), 'utf8'))
  } catch {
    return []
  }
}

async function writeClaims(root: string, claims: Claim[]): Promise<void> {
  await mkdir(join(root, FORGE_DIR), { recursive: true })
  await writeFile(join(root, CLAIMS_PATH), serialiseClaims(claims), 'utf8')
}

// Adds "<claims path> merge=union" to .gitattributes when missing. Returns true when it changed the file.
export async function ensureClaimsAttributes(root: string): Promise<boolean> {
  const file = join(root, '.gitattributes')
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    // new file
  }
  if (text.split(/\r?\n/).some((l) => l.trim() === ATTRIBUTE_LINE)) return false
  await writeFile(file, text + (text && !text.endsWith('\n') ? '\n' : '') + ATTRIBUTE_LINE + '\n', 'utf8')
  return true
}

export async function listClaims(root: string, options: ClaimOptions & { staleDays?: number } = {}): Promise<ClaimView[]> {
  const me = options.who ?? (await userName(root, options))
  return viewClaims(await readClaims(root), options.now ?? Date.now(), me, options.staleDays)
}

// Claims `what` for the current git user. Re-claiming keeps the original since and updates the note.
export async function claim(root: string, what: string, options: ClaimOptions = {}): Promise<ClaimView[]> {
  const target = normaliseWhat(what)
  if (!target) throw new Error('Say what you are working on.')
  const who = options.who ?? (await userName(root, options))
  const now = options.now ?? Date.now()
  const claims = await readClaims(root)
  const existing = claims.find((c) => c.who === who && c.what === target)
  if (existing) {
    if (options.note !== undefined) existing.note = options.note || undefined
    if (!existing.note) delete existing.note
  } else {
    const entry: Claim = { who, what: target, since: new Date(now).toISOString() }
    if (options.note) entry.note = options.note
    claims.push(entry)
  }
  await ensureClaimsAttributes(root)
  await writeClaims(root, parseClaims(JSON.stringify(claims)))
  return viewClaims(await readClaims(root), now, who)
}

// Releases the current user's claim on `what` (or, with all, every claim of theirs).
export async function release(root: string, what: string | { all: true }, options: ClaimOptions = {}): Promise<ClaimView[]> {
  const who = options.who ?? (await userName(root, options))
  const target = typeof what === 'string' ? normaliseWhat(what) : null
  const claims = (await readClaims(root)).filter((c) => !(c.who === who && (target === null || c.what === target)))
  await writeClaims(root, claims)
  return viewClaims(claims, options.now ?? Date.now(), who)
}

// Stages only the claims file (and .gitattributes when it holds the union rule), leaving the rest
// of the working tree alone. The next normal sync commits and pushes it.
export async function stageClaims(root: string, deps: CollabDeps = {}): Promise<void> {
  const paths = [CLAIMS_PATH]
  const attrs = await git(root, ['status', '--porcelain', '--', '.gitattributes'], deps)
  if (attrs.stdout.trim()) paths.push('.gitattributes')
  const result = await git(root, ['add', '--', ...paths], deps)
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'git add failed')
}

// Commits only the claims file (git commit --only), so other staged or unstaged work is untouched.
// Returns false when there was nothing to commit.
export async function commitClaims(root: string, message = 'forge: update claims', deps: CollabDeps = {}): Promise<boolean> {
  await stageClaims(root, deps)
  const staged = await git(root, ['diff', '--cached', '--name-only', '--', CLAIMS_PATH, '.gitattributes'], deps)
  const paths = staged.stdout.split(/\r?\n/).map((p) => p.trim()).filter(Boolean)
  if (paths.length === 0) return false
  const result = await git(root, ['commit', '--only', '-m', message, '--', ...paths], deps)
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'git commit failed')
  return true
}
