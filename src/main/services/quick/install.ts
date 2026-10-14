// Unpacks a downloaded quick bundle into userData/code/<version>/ (no electron imports; tested).
// The zip's sha256 and size must match the signed manifest, every entry must be a safe path the
// manifest lists, and every file's sha256 must match before anything is written. Files go into a
// temp folder next to the target, which is then renamed into place, so a crash never leaves a
// half-written version that the bootstrap could pick (it ignores and removes the temp folders).
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { readZip } from '../setup/unzip.ts'
import { renameRetry } from '../fs/renameRetry.ts'
import { sha256Hex, type QuickManifest } from './manifest.ts'
import { checkZipEntries } from './zipPath.ts'
import { MANIFEST_FILE, verifyInstalled } from './boot.ts'

export interface InstallOptions {
  codeRoot: string
  manifest: QuickManifest
  // The signed envelope text exactly as downloaded (stored as quick.json for the boot check).
  envelopeText: string
  zip: Buffer
  publicKey: string
}

export async function installBundle(opts: InstallOptions): Promise<string> {
  const { manifest, zip } = opts
  if (zip.length !== manifest.zip.size) throw new Error(`The bundle is ${zip.length} bytes, the manifest says ${manifest.zip.size}`)
  if (sha256Hex(zip) !== manifest.zip.sha256) throw new Error('The bundle does not match the sha256 in its signed manifest')
  const entries = readZip(zip)
  checkZipEntries(entries, manifest.files)
  for (const entry of entries) {
    if (entry.directory) continue
    const path = entry.name.endsWith('/') ? entry.name.slice(0, -1) : entry.name
    if (sha256Hex(entry.data) !== manifest.files[path]) throw new Error(`${path} does not match its sha256 in the signed manifest`)
  }

  await mkdir(opts.codeRoot, { recursive: true })
  const root = resolve(opts.codeRoot)
  const target = join(root, manifest.version)
  const tmp = join(root, `.tmp-${manifest.version}-${randomBytes(4).toString('hex')}`)
  try {
    await mkdir(tmp)
    for (const entry of entries) {
      if (entry.directory) continue
      const file = resolve(tmp, ...entry.name.split('/'))
      if (!file.startsWith(tmp + sep)) throw new Error(`Unsafe path in the bundle: ${entry.name}`)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, entry.data)
    }
    await writeFile(join(tmp, MANIFEST_FILE), opts.envelopeText)
    // What the bootstrap will check at the next launch must pass now.
    verifyInstalled(tmp, manifest.version, opts.publicKey)
    if (existsSync(target)) await rm(target, { recursive: true, force: true, maxRetries: 5 })
    await renameRetry(tmp, target)
    return target
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    throw e
  }
}
