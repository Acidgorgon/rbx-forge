// Merges electron-builder update-info files (latest.yml, latest-mac.yml) built by separate CI jobs.
//
// electron-builder only merges the `files` of one channel file across the archs it builds in a
// single run (app-builder-lib publish/updateInfoBuilder.js writeUpdateInfoFiles). build.yml builds
// each arch on its own runner, so every job writes a latest*.yml that lists only its own installer,
// and uploading them side by side would let the last one win: the other arch would be offered the
// wrong installer (electron-updater's findFile falls back to the first file when none matches
// process.arch). This concatenates the `files` lists the same way electron-builder does: zip
// first, then by arch (x64 before arm64), with the legacy top-level path/sha512 taken from the
// first file.
//
// Usage: node build/merge-update-info.mjs --out <dir> <jobDir> [<jobDir>...]
// Every latest*.yml / beta*.yml / alpha*.yml directly inside a jobDir is merged by file name.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const ARCH_ORDER = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

function archRank(url) {
  const name = basename(url).toLowerCase()
  // Longest match first so "arm64" is not read as "x64"-less "arm".
  for (const arch of ['universal', 'arm64', 'armv7l', 'ia32', 'x64']) {
    if (new RegExp(`[-_.]${arch}[-_.]`).test(name)) return ARCH_ORDER.indexOf(arch)
  }
  return -1 // no arch in the name: a universal installer, listed first like electron-builder does
}

function fileRank(file) {
  return (file.url.toLowerCase().endsWith('.zip') ? 0 : 100) + archRank(file.url)
}

// infos: parsed update-info objects for one channel file name. Returns the merged object.
export function mergeUpdateInfos(infos) {
  if (!infos.length) throw new Error('nothing to merge')
  const versions = [...new Set(infos.map((i) => i.version))]
  if (versions.length !== 1) throw new Error(`update infos disagree on version: ${versions.join(', ')}`)
  const byUrl = new Map()
  for (const info of infos) {
    if (!Array.isArray(info.files) || !info.files.length) throw new Error(`update info ${info.version} has no files`)
    for (const file of info.files) {
      const seen = byUrl.get(file.url)
      if (seen && seen.sha512 !== file.sha512) throw new Error(`${file.url} appears twice with different checksums`)
      if (!seen) byUrl.set(file.url, file)
    }
  }
  const files = [...byUrl.values()].sort((a, b) => fileRank(a) - fileRank(b) || a.url.localeCompare(b.url))
  const dates = infos.map((i) => i.releaseDate).filter(Boolean).sort()
  const merged = { ...infos[0], version: versions[0], files, path: files[0].url, sha512: files[0].sha512 }
  if (dates.length) merged.releaseDate = dates[dates.length - 1]
  // Keep electron-builder's key order: version, files, path, sha512, then the rest.
  const { version, files: f, path, sha512, ...rest } = merged
  return { version, files: f, path, sha512, ...rest }
}

export function parseUpdateInfo(text) {
  return yaml.load(text)
}

// Same options as electron-builder's serializeToYaml (builder-util).
export function serializeUpdateInfo(info) {
  return yaml.dump(info, { lineWidth: 8000, noRefs: true })
}

const CHANNEL_FILE = /^(latest|beta|alpha)(-[a-z0-9-]+)?\.yml$/

export function mergeDirs(outDir, dirs) {
  const groups = new Map()
  for (const dir of dirs) {
    if (!existsSync(dir)) throw new Error(`no such directory: ${dir}`)
    for (const name of readdirSync(dir)) {
      if (!CHANNEL_FILE.test(name)) continue
      const list = groups.get(name) ?? []
      list.push(parseUpdateInfo(readFileSync(join(dir, name), 'utf8')))
      groups.set(name, list)
    }
  }
  mkdirSync(outDir, { recursive: true })
  const written = []
  for (const [name, infos] of groups) {
    const merged = mergeUpdateInfos(infos)
    writeFileSync(join(outDir, name), serializeUpdateInfo(merged))
    written.push({ name, files: merged.files.map((f) => f.url) })
  }
  return written
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const outAt = args.indexOf('--out')
  if (outAt < 0 || !args[outAt + 1]) {
    console.error('usage: node build/merge-update-info.mjs --out <dir> <jobDir> [<jobDir>...]')
    process.exit(2)
  }
  const outDir = args[outAt + 1]
  const dirs = args.filter((_, i) => i !== outAt && i !== outAt + 1)
  const written = mergeDirs(outDir, dirs)
  if (!written.length) {
    console.error('no latest*.yml found in', dirs.join(', '))
    process.exit(1)
  }
  for (const w of written) console.log(`${w.name}: ${w.files.join(', ')}`)
}
