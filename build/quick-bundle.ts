// Quick update bundle for .github/workflows/quick.yml (README "Quick updates").
//
//   node --experimental-strip-types build/quick-bundle.ts check-key
//     Fails unless QUICK_UPDATE_SIGNING_KEY is set, is an Ed25519 private key, and matches the public
//     key built into the app (src/main/services/quick/publicKey.ts). Never prints the key.
//   node --experimental-strip-types build/quick-bundle.ts bundle --version 0.6.0-quick.12 --channel stable --commit <sha> --out quick
//     Zips out/main, out/preload and out/renderer (no source maps) into <out>/forge-code-<version>.zip
//     and writes <out>/quick-<channel>.json: the manifest (version, Electron and package versions
//     from package-lock.json, the zip's sha256 and every file's sha256) signed with the key.
import type { KeyObject } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { privateKeyFrom, publicKeyBase64, sha256Hex, signManifest, validateManifest, zipNameFor, type QuickChannel, type QuickManifest } from '../src/main/services/quick/manifest.ts'
import { shellInfoFromLock, type ShellInfo } from '../src/main/services/quick/shellInfo.ts'
import { QUICK_UPDATE_PUBLIC_KEY } from '../src/main/services/quick/publicKey.ts'
import { BUNDLE_ROOTS } from '../src/main/services/quick/zipPath.ts'

const ROOT = resolve(import.meta.dirname, '..')

function fail(message: string): never {
  // GitHub Actions shows ::error:: lines as annotations on the run.
  console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : message)
  process.exit(1)
}

function signingKey(): KeyObject {
  const secret = process.env.QUICK_UPDATE_SIGNING_KEY ?? ''
  if (!secret.trim()) {
    fail('QUICK_UPDATE_SIGNING_KEY is not set, so nothing is published (quick bundles are never unsigned). Create the key and add the secret as README "Quick updates" describes.')
  }
  let key: KeyObject
  try {
    key = privateKeyFrom(secret)
  } catch (e) {
    fail(`QUICK_UPDATE_SIGNING_KEY is not a readable Ed25519 private key (${(e as Error).message.split('\n')[0]}). Create it with the command in README "Quick updates".`)
  }
  const pub = publicKeyBase64(key)
  if (!QUICK_UPDATE_PUBLIC_KEY) {
    fail(`The app has no quick update public key yet. Put this public key into src/main/services/quick/publicKey.ts, commit it and ship a full release first: ${pub}`)
  }
  if (pub !== QUICK_UPDATE_PUBLIC_KEY) {
    fail(`QUICK_UPDATE_SIGNING_KEY does not match the public key in src/main/services/quick/publicKey.ts (the secret's public key is ${pub}). Apps would refuse this bundle.`)
  }
  return key
}

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listFiles(full))
    else if (!name.endsWith('.map')) out.push(full)
  }
  return out
}

// Deflate zip (with CRCs) of [path, data] pairs, in the given order, with a fixed timestamp.
export function writeDeflateZip(files: [string, Buffer][]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  const DOS_TIME = 0
  const DOS_DATE = (2020 - 1980) << 9 | 1 << 5 | 1
  for (const [path, data] of files) {
    const name = Buffer.from(path, 'utf8')
    const packed = deflateRawSync(data, { level: 9 })
    const stored = packed.length >= data.length
    const body = stored ? data : packed
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(stored ? 0 : 8, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += 30 + name.length + body.length
  }
  const size = centrals.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(size, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

function arg(args: string[], name: string): string {
  const i = args.indexOf(`--${name}`)
  const value = i >= 0 ? args[i + 1] : undefined
  if (!value) fail(`missing --${name}`)
  return value
}

export interface BundleOptions {
  // The electron-vite output folder (out/).
  from: string
  version: string
  channel: QuickChannel
  commit: string
  key: KeyObject
  shell: ShellInfo
}

// The zip and its signed envelope (quick-<channel>.json text).
export function makeQuickBundle(opts: BundleOptions): { zip: Buffer; manifest: QuickManifest; envelope: string } {
  const built = resolve(opts.from)
  const files: [string, Buffer][] = []
  for (const top of BUNDLE_ROOTS) {
    for (const full of listFiles(join(built, top))) files.push([relative(built, full).split(sep).join('/'), readFileSync(full)])
  }
  if (files.length > 0xffff) throw new Error(`${files.length} files is more than a plain zip holds`)
  const zip = writeDeflateZip(files)
  const manifest: QuickManifest = validateManifest({
    schema: 1,
    version: opts.version,
    channel: opts.channel,
    commit: opts.commit,
    createdAt: new Date().toISOString(),
    electron: opts.shell.electron,
    native: opts.shell.native,
    deps: opts.shell.deps,
    zip: { name: zipNameFor(opts.version), size: zip.length, sha256: sha256Hex(zip) },
    files: Object.fromEntries(files.map(([path, data]) => [path, sha256Hex(data)]))
  })
  return { zip, manifest, envelope: signManifest(manifest, opts.key) }
}

function bundle(args: string[]): void {
  const key = signingKey()
  const channel = arg(args, 'channel') as QuickChannel
  const outDir = resolve(arg(args, 'out'))
  const shell = shellInfoFromLock(JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')))
  const { zip, manifest, envelope } = makeQuickBundle({ from: join(ROOT, 'out'), version: arg(args, 'version'), channel, commit: arg(args, 'commit'), key, shell })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, manifest.zip.name), zip)
  writeFileSync(join(outDir, `quick-${channel}.json`), envelope)
  console.log(`quick ${manifest.version} (${channel}): ${Object.keys(manifest.files).length} files, zip ${(zip.length / 1e6).toFixed(1)} MB, sha256 ${manifest.zip.sha256}`)
  console.log(`Electron ${shell.electron}, ${Object.keys(shell.deps).length} packages, native ${JSON.stringify(shell.native)}`)
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'check-key') {
    signingKey()
    console.log('QUICK_UPDATE_SIGNING_KEY matches the app\'s public key.')
  } else if (command === 'bundle') bundle(rest)
  else fail('usage: quick-bundle.ts check-key | bundle --version <v> --channel stable|beta --commit <sha> --out <dir>')
}
