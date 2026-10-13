#!/usr/bin/env node
// Downloads the pinned rokit release binary for each platform/arch we package, so the app ships
// its own toolchain manager (first-run setup runs `rokit self-install` from it; see
// src/main/services/setup/toolchain.ts).
//
// Assets come from https://github.com/rojo-rbx/rokit/releases (named rokit-<version>-<os>-<arch>.zip
// by rokit's .github/workflows/release.yaml; each zip holds a single rokit / rokit.exe). Every
// download is checked against the SHA-256 pinned below, then unpacked to
// resources/rokit/<os>-<arch>/, where <os>-<arch> are electron-builder's ${os} and ${arch} macros
// (mac|win|linux, x64|arm64). electron-builder.yml copies the target's folder to <resources>/rokit,
// and build/afterPack.cjs fails the build if it is missing.
//
//   node build/rokit-binaries.mjs                       # this machine's platform and arch
//   node build/rokit-binaries.mjs --platform darwin --arch arm64,x64
//   node build/rokit-binaries.mjs --platform win32 --arch x64,arm64

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Keep in sync with ROKIT_VERSION in src/main/services/setup/toolchain.ts.
export const ROKIT_VERSION = '1.2.0'

// <node platform>-<node arch> -> [rokit asset suffix, electron-builder ${os}, sha256 of the zip]
export const TARGETS = {
  'darwin-arm64': ['macos-aarch64', 'mac', 'eb8e6b4f8026db2b80ad0887c50f342958ecdbacbdeda2fd6028b3c4f774a3ee'],
  'darwin-x64': ['macos-x86_64', 'mac', '9643ca30421e9c3dda1f4996bb03b3a43b08dfdc17c28198843e2233e446ba10'],
  'win32-x64': ['windows-x86_64', 'win', 'f9ba1704014ff67d51e8005f605955c7c26d2429a5312a9419dc477fc310e96d'],
  'win32-arm64': ['windows-aarch64', 'win', 'aff0e76e304fdc938cffa5b7ee1e183a052acac541868b4271192f20c734282a'],
  'linux-x64': ['linux-x86_64', 'linux', '951a7f3ec3d2a5e021fd1867d32f69f010ee4c2927f644b759578afc59c65fc0'],
  'linux-arm64': ['linux-aarch64', 'linux', 'b9ba200dd70620d9dbc11bbb0b368a62c6891328e6bc5fab4b7f68200089553a']
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

export function assetUrl(platform, arch, version = ROKIT_VERSION) {
  const target = TARGETS[`${platform}-${arch}`]
  if (!target) throw new Error(`rokit-binaries: no rokit build for ${platform}-${arch}`)
  return `https://github.com/rojo-rbx/rokit/releases/download/v${version}/rokit-${version}-${target[0]}.zip`
}

export function outputDir(platform, arch, base = join(root, 'resources', 'rokit')) {
  return join(base, `${TARGETS[`${platform}-${arch}`][1]}-${arch}`)
}

// The one file inside rokit's release zip (central directory lookup; stored or deflate).
function unzipOne(buffer, wanted) {
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('rokit-binaries: not a zip archive')
  let offset = buffer.readUInt32LE(eocd + 16)
  for (let n = buffer.readUInt16LE(eocd + 10); n > 0; n--) {
    const method = buffer.readUInt16LE(offset + 10)
    const size = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const local = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32)
    if (name.split('/').pop() !== wanted) continue
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
    const raw = buffer.subarray(start, start + size)
    return method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
  }
  throw new Error(`rokit-binaries: ${wanted} not found in the archive`)
}

export async function ensure(platform, arch, base) {
  const dir = outputDir(platform, arch, base)
  const file = join(dir, platform === 'win32' ? 'rokit.exe' : 'rokit')
  const stamp = join(dir, 'VERSION')
  const sha = TARGETS[`${platform}-${arch}`][2]
  if (existsSync(file) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === `${ROKIT_VERSION} ${sha}`) {
    console.log(`rokit-binaries: rokit ${ROKIT_VERSION} for ${platform}-${arch} present`)
    return file
  }
  const url = assetUrl(platform, arch)
  console.log(`rokit-binaries: fetching ${url}`)
  let response
  for (let attempt = 1; ; attempt++) {
    try {
      response = await fetch(url, { redirect: 'follow' })
      if (response.ok) break
      throw new Error(`${response.status} ${response.statusText}`)
    } catch (error) {
      if (attempt >= 3) throw new Error(`rokit-binaries: download failed for ${url}: ${error.message}`)
      await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
  const zip = Buffer.from(await response.arrayBuffer())
  const actual = createHash('sha256').update(zip).digest('hex')
  if (actual !== sha) throw new Error(`rokit-binaries: SHA-256 mismatch for ${url}\n  expected ${sha}\n  got      ${actual}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, unzipOne(zip, platform === 'win32' ? 'rokit.exe' : 'rokit'))
  chmodSync(file, 0o755)
  writeFileSync(stamp, `${ROKIT_VERSION} ${sha}\n`)
  console.log(`rokit-binaries: wrote ${file}`)
  return file
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const platform = arg('platform', process.platform)
  const arches = arg('arch', process.arch).split(',').map((a) => a.trim()).filter(Boolean)
  for (const arch of arches) await ensure(platform, arch)
}
