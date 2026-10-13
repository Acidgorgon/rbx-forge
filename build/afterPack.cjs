// electron-builder afterPack hook: keep only the Claude Agent SDK CLI that matches the target.
//
// node_modules may hold several @anthropic-ai/claude-agent-sdk-<platform>-<arch> packages (the host's,
// plus any fetched by build/sdk-binaries.mjs for cross-arch builds). Each is ~250 MB and is unpacked
// from the asar, so ship only the one the target needs, and fail the build if it is missing.
// Same for node-pty's native prebuilds (integrated terminal), see checkNodePty.
const { chmodSync, existsSync, readdirSync, rmSync, statSync } = require('node:fs')
const { join } = require('node:path')

const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

function unpackedModules(context) {
  const { appOutDir, electronPlatformName, packager } = context
  const resources =
    electronPlatformName === 'darwin' || electronPlatformName === 'mas'
      ? join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(appOutDir, 'resources')
  return join(resources, 'app.asar.unpacked', 'node_modules')
}

function unpackedDir(context) {
  return join(unpackedModules(context), '@anthropic-ai')
}

// node-pty (integrated terminal): keep only prebuilds/<platform>-<arch>, make the macOS spawn-helper
// executable (the npm tarball stores it as 0644, and node-pty fails with "posix_spawnp failed"
// without it), and fail the build if the target's native binary is missing. Linux has no prebuild
// and uses build/Release from `npm install`.
function checkNodePty(context, platform, arch) {
  const root = join(unpackedModules(context), 'node-pty')
  const target = `${platform}-${arch}`
  const prebuilds = join(root, 'prebuilds')
  if (existsSync(prebuilds)) {
    for (const name of readdirSync(prebuilds)) {
      if (name !== target) {
        rmSync(join(prebuilds, name), { recursive: true, force: true })
        console.log(`  • afterPack: removed node-pty prebuilds/${name} (not for ${target})`)
      }
    }
  }
  const prebuilt = join(prebuilds, target)
  // node-pty loads build/Release before prebuilds; a host-compiled binary (another arch) must not
  // shadow the target's prebuild.
  if (existsSync(join(prebuilt, 'pty.node')) && existsSync(join(root, 'build'))) {
    rmSync(join(root, 'build'), { recursive: true, force: true })
    console.log('  • afterPack: removed node-pty build/ (the target prebuild is used)')
  }
  const dir = existsSync(join(prebuilt, 'pty.node')) ? prebuilt : join(root, 'build', 'Release')
  const required = platform === 'win32' ? ['pty.node', 'conpty.node', 'conpty_console_list.node', 'winpty-agent.exe', 'winpty.dll'] : platform === 'darwin' ? ['pty.node', 'spawn-helper'] : ['pty.node']
  const missing = required.filter((file) => !existsSync(join(dir, file)))
  if (missing.length) {
    throw new Error(
      `node-pty native files for ${target} are not in the package (${dir}): ${missing.join(', ')}. ` +
        'node-pty 1.1.0 ships prebuilds for darwin-arm64/x64 and win32-x64/arm64; run npm ci.'
    )
  }
  if (platform === 'darwin') {
    const helper = join(dir, 'spawn-helper')
    chmodSync(helper, statSync(helper).mode | 0o755)
  }
  console.log(`  • afterPack: node-pty ${target} binaries present (${dir.slice(root.length + 1)})`)
}

// Bundled rokit (first-run toolchain setup): build/rokit-binaries.mjs downloads it to
// resources/rokit/<os>-<arch>/ and electron-builder.yml copies the target's folder to
// <resources>/rokit. Fail the build when it is missing or not executable.
function checkRokit(context, platform, arch) {
  const { appOutDir, electronPlatformName, packager } = context
  const resources =
    electronPlatformName === 'darwin' || electronPlatformName === 'mas'
      ? join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(appOutDir, 'resources')
  const file = join(resources, 'rokit', platform === 'win32' ? 'rokit.exe' : 'rokit')
  if (!existsSync(file) || statSync(file).size < 1024 * 1024) {
    throw new Error(
      `rokit for ${platform}-${arch} is not in the package (${file}). ` +
        `Run: node build/rokit-binaries.mjs --platform ${platform} --arch ${arch}`
    )
  }
  if (platform !== 'win32' && (statSync(file).mode & 0o111) === 0) chmodSync(file, 0o755)
  console.log(`  • afterPack: rokit ${platform}-${arch} present (${Math.round(statSync(file).size / 1024 / 1024)} MB)`)
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
  checkNodePty(context, platform, arch)
  checkRokit(context, platform, arch)
  const binary = platform === 'win32' ? 'claude.exe' : 'claude'
  const found = keep.some((name) => existsSync(join(dir, `claude-agent-sdk-${name}`, binary)))
  if (!found) {
    throw new Error(
      `Claude Agent SDK CLI for ${platform}-${arch} is not in the package (${dir}). ` +
        `Run: node build/sdk-binaries.mjs --platform ${platform} --arch ${arch}`
    )
  }
}
