#!/usr/bin/env node
// Makes sure node_modules holds the Claude Agent SDK native CLI for each platform/arch we package.
//
// The SDK spawns a platform-specific binary from @anthropic-ai/claude-agent-sdk-<platform>-<arch>,
// an optionalDependency. npm only installs the one matching the machine running `npm ci`, so a
// cross-arch build (mac x64 on an Apple Silicon runner, Windows arm64 on an x64 runner) would ship
// without its CLI. This script downloads any missing package with `npm pack` (same version as the
// SDK, from the npm registry) and unpacks it into node_modules. build/afterPack.cjs then removes
// the binaries that do not match the target, and fails the build if the matching one is missing.
//
//   node build/sdk-binaries.mjs                       # this machine's platform and arch
//   node build/sdk-binaries.mjs --platform darwin --arch arm64,x64
//   node build/sdk-binaries.mjs --platform win32 --arch x64,arm64

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SDK = '@anthropic-ai/claude-agent-sdk'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

export function packageName(platform, arch) {
  return `${SDK}-${platform}-${arch}`
}

export function binaryPath(nodeModules, platform, arch) {
  return join(nodeModules, packageName(platform, arch), platform === 'win32' ? 'claude.exe' : 'claude')
}

// Minimal ustar reader: enough for npm tarballs (regular files under package/).
function untar(buffer, dest) {
  let offset = 0
  let longName = null
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
    let name = field(0, 100)
    const prefix = field(345, 155)
    if (prefix) name = `${prefix}/${name}`
    if (longName) {
      name = longName
      longName = null
    }
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const mode = parseInt(field(100, 8).trim() || '644', 8)
    const type = String.fromCharCode(header[156] || 48)
    const body = buffer.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '')
      continue
    }
    if (type !== '0' && type !== '\0') continue
    const relative = name.replace(/^package\//, '')
    if (!relative || relative.split('/').includes('..')) continue
    const target = join(dest, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
    chmodSync(target, mode & 0o111 ? 0o755 : 0o644)
  }
}

export function ensure(platform, arch, nodeModules = join(root, 'node_modules')) {
  const binary = binaryPath(nodeModules, platform, arch)
  if (existsSync(binary)) {
    console.log(`sdk-binaries: ${packageName(platform, arch)} present`)
    return binary
  }
  const sdkPackage = JSON.parse(readFileSync(join(nodeModules, SDK, 'package.json'), 'utf8'))
  const name = packageName(platform, arch)
  const version = sdkPackage.optionalDependencies?.[name]
  if (!version) throw new Error(`${SDK}@${sdkPackage.version} has no optional dependency ${name}`)
  const temp = mkdtempSync(join(tmpdir(), 'sdk-bin-'))
  try {
    console.log(`sdk-binaries: fetching ${name}@${version}`)
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const out = execFileSync(npm, ['pack', `${name}@${version}`, '--pack-destination', temp, '--json', '--silent'], {
      encoding: 'utf8',
      // npm.cmd is a batch file; Node refuses to spawn those without a shell. Arguments are fixed strings.
      shell: process.platform === 'win32'
    })
    const filename = JSON.parse(out)[0].filename
    const dest = join(nodeModules, name)
    rmSync(dest, { recursive: true, force: true })
    untar(gunzipSync(readFileSync(join(temp, filename))), dest)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
  if (!existsSync(binary)) throw new Error(`sdk-binaries: ${binary} missing after unpacking ${name}`)
  return binary
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const platform = arg('platform', process.platform)
  const arches = arg('arch', process.arch).split(',').map((a) => a.trim()).filter(Boolean)
  for (const arch of arches) ensure(platform, arch)
}
