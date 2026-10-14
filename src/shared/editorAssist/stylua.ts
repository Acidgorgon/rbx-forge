// StyLua command line for formatting one buffer through stdin. Pure.
//
// `stylua --stdin-filepath <repo path> --respect-ignores -` run in the project root:
//   - the config is found the usual way (stylua.toml / .stylua.toml in the project root, then the
//     user's config dir), so the project's settings apply exactly as `stylua src` would use them;
//   - --stdin-filepath makes .styluaignore and the file's syntax (Luau vs Lua) apply;
//   - --respect-ignores (StyLua 0.17+) echoes an ignored file back unchanged.
// Exit 0 with the formatted text on stdout; non-zero with a parse error on stderr.

export interface StyluaArgOptions {
  // Older StyLua without --respect-ignores (retried without it).
  respectIgnores?: boolean
  // An explicit config file (absolute), when the caller found one StyLua would not search.
  configPath?: string
}

export function styluaArgs(repoPath: string, o: StyluaArgOptions = {}): string[] {
  const p = repoPath.replace(/\\/g, '/').replace(/^\.\//, '')
  const args = ['--stdin-filepath', p]
  if (o.configPath) args.push('--config-path', o.configPath)
  if (o.respectIgnores !== false) args.push('--respect-ignores')
  args.push('-')
  return args
}

// clap's message for a flag the installed StyLua does not know.
export function isUnknownFlag(stderr: string, flag: string): boolean {
  return stderr.includes(flag) && /unexpected argument|unrecognized|Found argument .* which wasn't expected/i.test(stderr)
}

// First useful line of StyLua's stderr ("error: could not format from stdin: failed to format from
// stdin: error parsing: \n - unexpected token ..." -> "unexpected token `(` (1:11 to 1:12) ...").
export function styluaError(stderr: string, code: number): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const detail = lines.find((l) => l.startsWith('- '))
  if (detail) return `StyLua could not parse the file: ${detail.slice(2)}`
  const first = lines[0]?.replace(/^error:\s*/i, '')
  return first ? `StyLua: ${first}` : `StyLua exited with code ${code}`
}
