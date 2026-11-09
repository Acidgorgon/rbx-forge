// Mapped folders ($path values) as watch roots: repo-relative, posix, without "./" or a trailing
// slash ("" is the root), and only the top-most of nested ones (src covers src/shared), so no folder
// is watched recursively twice.
export function normalizeWatchDirs(dirs: string[]): string[] {
  const clean = [...new Set(dirs.map((d) => d.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '').replace(/^\.$/, '')))].sort()
  if (clean.includes('')) return ['']
  const out: string[] = []
  for (const dir of clean) if (!out.some((d) => dir === d || dir.startsWith(d + '/'))) out.push(dir)
  return out
}
