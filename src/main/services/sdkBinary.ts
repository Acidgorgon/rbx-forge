import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Path of the Claude Agent SDK's native CLI in a packaged app, or undefined in development.
//
// The SDK finds its CLI with require.resolve('@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude'),
// which inside a packaged app points into app.asar. A binary cannot be executed from inside an asar
// archive, so electron-builder unpacks those packages (asarUnpack in electron-builder.yml) to
// resources/app.asar.unpacked, and the agent passes this path as options.pathToClaudeCodeExecutable.
export function bundledClaudeExecutable(
  resourcesPath: string | undefined = (process as { resourcesPath?: string }).resourcesPath,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  exists: (path: string) => boolean = existsSync
): string | undefined {
  if (!resourcesPath) return undefined
  const base = join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@anthropic-ai')
  const names = platform === 'linux' ? [`linux-${arch}`, `linux-${arch}-musl`] : [`${platform}-${arch}`]
  const file = platform === 'win32' ? 'claude.exe' : 'claude'
  for (const name of names) {
    const candidate = join(base, `claude-agent-sdk-${name}`, file)
    if (exists(candidate)) return candidate
  }
  return undefined
}
