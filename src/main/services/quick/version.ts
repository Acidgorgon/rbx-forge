// Version order for quick updates (pure; tested in test/quickUpdate.test.ts).
//
// A quick build is the code of package.json's version plus later commits, published as
// <version>-quick.<run number>. Plain semver would sort 0.6.0-quick.12 BEFORE the 0.6.0 release it
// patches, so here "-quick.N" is a post-release suffix:
//
//   0.6.1-beta.3  <  0.6.1  <  0.6.1-quick.1  <  0.6.1-quick.2  <  0.6.2-beta.1  <  0.6.2
//
// Other prereleases (the Beta channel's -beta.N installers) keep their semver order, before the
// release. A full installer with a newer x.y.z therefore always beats a quick build of an older one.

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  // Semver prerelease identifiers (empty for a release or a quick build).
  pre: (string | number)[]
  // N of "-quick.N", or null.
  quick: number | null
}

const VERSION_RE = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/
// What a quick build's version (and its folder name under userData/code) must look like.
export const QUICK_VERSION_RE = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})-quick\.(\d{1,9})$/

export function parseVersion(text: string): ParsedVersion | null {
  if (typeof text !== 'string') return null
  const m = VERSION_RE.exec(text.trim())
  if (!m) return null
  const pre = m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : []
  let quick: number | null = null
  if (pre.length === 2 && pre[0] === 'quick' && typeof pre[1] === 'number') {
    quick = pre[1]
    pre.length = 0
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre, quick }
}

export function isQuickVersion(text: string): boolean {
  return QUICK_VERSION_RE.test(text)
}

// 0 prerelease, 1 release, 2 quick build of that release.
function rank(v: ParsedVersion): number {
  if (v.quick !== null) return 2
  return v.pre.length ? 0 : 1
}

function comparePre(a: (string | number)[], b: (string | number)[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1
    if (i >= b.length) return 1
    const x = a[i]
    const y = b[i]
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

// <0 when a is older, 0 when equal, >0 when a is newer. Throws on a malformed version.
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x) throw new Error(`Not a version: ${a}`)
  if (!y) throw new Error(`Not a version: ${b}`)
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1
  }
  const r = rank(x) - rank(y)
  if (r !== 0) return r
  if (x.quick !== null && y.quick !== null) return x.quick === y.quick ? 0 : x.quick < y.quick ? -1 : 1
  return comparePre(x.pre, y.pre)
}

export function isNewer(a: string, b: string): boolean {
  return compareVersions(a, b) > 0
}
