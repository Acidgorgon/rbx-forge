// electron-builder afterPack hook: keep only the Claude Agent SDK CLI that matches the target.
//
// node_modules may hold several @anthropic-ai/claude-agent-sdk-<platform>-<arch> packages (the host's,
// plus any fetched by build/sdk-binaries.mjs for cross-arch builds). Each is ~250 MB and is unpacked
// from the asar, so ship only the one the target needs, and fail the build if it is missing.
const { existsSync, readdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

function unpackedDir(context) {
  const { appOutDir, electronPlatformName, packager } = context
  const resources =
    electronPlatformName === 'darwin' || electronPlatformName === 'mas'
      ? join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(appOutDir, 'resources')
  return join(resources, 'app.asar.unpacked', 'node_modules', '@anthropic-ai')
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName === 'mas' ? 'darwin' : context.electronPlatformName
  const arch = ARCH[context.arch] ?? String(context.arch)
  if (arch === 'universal') throw new Error('Universal mac builds are not supported; build arm64 and x64 separately.')
  // Linux keeps the glibc build only (the SDK prefers it on glibc systems, which AppImage targets).
  const keep = [`${platform}-${arch}`]
  const dir = unpackedDir(context)
  const present = existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith('claude-agent-sdk-')) : []
  for (const name of present) {
    if (!keep.includes(name.slice('claude-agent-sdk-'.length))) {
      rmSync(join(dir, name), { recursive: true, force: true })
      console.log(`  • afterPack: removed ${name} (not for ${platform}-${arch})`)
    }
  }
  const binary = platform === 'win32' ? 'claude.exe' : 'claude'
  const found = keep.some((name) => existsSync(join(dir, `claude-agent-sdk-${name}`, binary)))
  if (!found) {
    throw new Error(
      `Claude Agent SDK CLI for ${platform}-${arch} is not in the package (${dir}). ` +
        `Run: node build/sdk-binaries.mjs --platform ${platform} --arch ${arch}`
    )
  }
}
