// In-process file claims. A claim is a normalized repo-relative path; one ending in "/" covers a
// folder. Claims are all-or-nothing per call and released when the owning task ends.
//
// Hot files (events.blink, wally.toml, default.project.json) are never claimable by tasks: only
// the lead (owner LEAD_OWNER) writes them, during integration, when no task is running.

import { posix } from 'node:path'

export const LEAD_OWNER = 'lead'

// Normalizes a model-supplied repo-relative path; null when it escapes the root or is absolute.
// Keeps a trailing "/" (folder claim).
export function normalizePath(input: string): string | null {
  if (typeof input !== 'string') return null
  const raw = input.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null
  const dir = raw.endsWith('/')
  const norm = posix.normalize(raw)
  if (norm === '..' || norm.startsWith('../') || norm === '.' || norm === './') return null
  const out = norm.replace(/\/+$/, '')
  return dir ? out + '/' : out
}

// True when two claims cover a common path.
export function overlaps(a: string, b: string): boolean {
  if (a === b) return true
  if (a.endsWith('/') && (b.startsWith(a) || b + '/' === a)) return true
  if (b.endsWith('/') && (a.startsWith(b) || a + '/' === b)) return true
  return false
}

// True when `claim` covers `file`.
export function covers(claim: string, file: string): boolean {
  if (claim === file) return true
  return claim.endsWith('/') && (file.startsWith(claim) || file + '/' === claim)
}

export type ClaimResult = { ok: true } | { ok: false; conflicts: { path: string; owner: string }[]; hot: string[]; invalid: string[] }

export class LockManager {
  private claims = new Map<string, string>() // path -> owner
  private hot: string[]

  constructor(hotFiles: string[]) {
    this.hot = hotFiles.map((f) => normalizePath(f)).filter((f): f is string => !!f)
  }

  isHot(path: string): boolean {
    return this.hot.some((h) => overlaps(h, path))
  }

  hotFiles(): string[] {
    return [...this.hot]
  }

  // Claims every path for owner, or none. Re-claiming one's own path is fine. Only the lead may
  // claim hot files.
  claim(owner: string, paths: string[]): ClaimResult {
    const conflicts: { path: string; owner: string }[] = []
    const hot: string[] = []
    const invalid: string[] = []
    const norm: string[] = []
    for (const p of paths) {
      const n = normalizePath(p)
      if (!n) {
        invalid.push(p)
        continue
      }
      if (owner !== LEAD_OWNER && this.isHot(n)) hot.push(n)
      for (const [held, who] of this.claims) if (who !== owner && overlaps(held, n)) conflicts.push({ path: n, owner: who })
      norm.push(n)
    }
    if (conflicts.length || hot.length || invalid.length) return { ok: false, conflicts, hot, invalid }
    for (const n of norm) this.claims.set(n, owner)
    return { ok: true }
  }

  release(owner: string): void {
    for (const [p, who] of this.claims) if (who === owner) this.claims.delete(p)
  }

  releaseAll(): void {
    this.claims.clear()
  }

  // Owner of a file: the owner of a claim covering it.
  ownerOf(file: string): string | undefined {
    const n = normalizePath(file)
    if (!n) return undefined
    for (const [held, who] of this.claims) if (covers(held, n)) return who
    return undefined
  }

  // Owners other than `owner` holding a claim that overlaps `path`.
  othersOverlapping(owner: string, path: string): string[] {
    const out = new Set<string>()
    for (const [held, who] of this.claims) if (who !== owner && overlaps(held, path)) out.add(who)
    return [...out]
  }

  claimsOf(owner: string): string[] {
    return [...this.claims].filter(([, who]) => who === owner).map(([p]) => p)
  }

  // May owner write file? The lead may write anything not claimed by a task (and hot files);
  // a task only what it has claimed.
  canWrite(owner: string, file: string): { ok: true; path: string } | { ok: false; reason: string } {
    const n = normalizePath(file)
    if (!n || n.endsWith('/')) return { ok: false, reason: `refused: ${file} is not a file path inside the project` }
    const who = this.ownerOf(n)
    if (owner === LEAD_OWNER) {
      return who && who !== LEAD_OWNER ? { ok: false, reason: `refused: ${n} is claimed by task ${who}` } : { ok: true, path: n }
    }
    if (this.isHot(n)) return { ok: false, reason: `refused: ${n} is a shared file only the lead edits; call request_change` }
    if (who === owner) return { ok: true, path: n }
    if (who) return { ok: false, reason: `refused: ${n} is claimed by task ${who}; call request_change` }
    const mine = this.claimsOf(owner)
    return { ok: false, reason: `refused: ${n} is not claimed by this task (claimed: ${mine.join(', ') || 'none'}); call claim_files for a new file or request_change` }
  }
}
