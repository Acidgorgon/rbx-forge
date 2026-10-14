// Quick update manifest: what CI signs and what the app checks before it downloads, and again before
// every launch of, a quick bundle (pure; no electron imports; tested in test/quickUpdate.test.ts).
//
// The published file (quick-<channel>.json on the rolling "quick" GitHub release) is an envelope:
//
//   { "format": "rbx-forge-quick/1", "manifest": "<manifest JSON as a string>", "signature": "<base64>" }
//
// The signature is Ed25519 over the exact UTF-8 bytes of the "manifest" string, so nothing is
// re-serialized before it is checked. The app embeds only the public key (publicKey.ts); the private
// key is the QUICK_UPDATE_SIGNING_KEY secret of the GitHub repository (README "Quick updates").
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { checkFileList } from './zipPath.ts'
import { QUICK_VERSION_RE } from './version.ts'
import type { ShellInfo } from './shellInfo.ts'

export const ENVELOPE_FORMAT = 'rbx-forge-quick/1'
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
export const MAX_ZIP_BYTES = 300 * 1024 * 1024

export type QuickChannel = 'stable' | 'beta'

export interface QuickManifest extends ShellInfo {
  schema: 1
  // <package.json version>-quick.<run number>
  version: string
  channel: QuickChannel
  // The commit the bundle was built from.
  commit: string
  // ISO time of the build.
  createdAt: string
  zip: { name: string; size: number; sha256: string }
  // Every file in the zip: path relative to the bundle root ("main/app.js") -> sha256 (hex).
  files: Record<string, string>
}

export interface QuickEnvelope {
  format: string
  manifest: string
  signature: string
}

export type QuickErrorKind = 'format' | 'signature' | 'manifest'

export class QuickError extends Error {
  kind: QuickErrorKind
  constructor(kind: QuickErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

const HEX64 = /^[0-9a-f]{64}$/

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function zipNameFor(version: string): string {
  return `forge-code-${version}.zip`
}

export function parseEnvelope(text: string): QuickEnvelope {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new QuickError('format', 'The quick update manifest is missing or too large')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new QuickError('format', 'The quick update manifest is not JSON')
  }
  const env = raw as Partial<QuickEnvelope>
  if (!env || typeof env !== 'object' || env.format !== ENVELOPE_FORMAT || typeof env.manifest !== 'string' || typeof env.signature !== 'string') {
    throw new QuickError('format', 'The quick update manifest has an unknown format')
  }
  return { format: env.format, manifest: env.manifest, signature: env.signature }
}

// The embedded public key: base64 of the Ed25519 key's SPKI DER (44 bytes), as the README's key
// command prints it. Throws when it is empty or not an Ed25519 key.
export function publicKeyFrom(base64: string): KeyObject {
  if (!base64) throw new QuickError('signature', 'This build has no quick update key')
  let key: KeyObject
  try {
    key = createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' })
  } catch {
    throw new QuickError('signature', 'The quick update key in this build is not readable')
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new QuickError('signature', 'The quick update key in this build is not an Ed25519 key')
  return key
}

// A private key as stored in the secret: PEM ("-----BEGIN PRIVATE KEY-----") or base64 PKCS#8 DER.
export function privateKeyFrom(text: string): KeyObject {
  const trimmed = (text ?? '').trim()
  if (!trimmed) throw new Error('No signing key')
  const key = trimmed.startsWith('-----')
    ? createPrivateKey(trimmed)
    : createPrivateKey({ key: Buffer.from(trimmed.replace(/\s+/g, ''), 'base64'), format: 'der', type: 'pkcs8' })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`The signing key is ${key.asymmetricKeyType}, not ed25519`)
  return key
}

export function publicKeyBase64(key: KeyObject): string {
  const pub = key.type === 'private' ? createPublicKey(key) : key
  return pub.export({ type: 'spki', format: 'der' }).toString('base64')
}

export function signManifest(manifest: QuickManifest, privateKey: KeyObject): string {
  const text = JSON.stringify(manifest)
  const signature = sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64')
  return `${JSON.stringify({ format: ENVELOPE_FORMAT, manifest: text, signature } satisfies QuickEnvelope, null, 1)}\n`
}

// Signature first, then the manifest's shape. Returns the manifest only when both hold.
export function verifyEnvelope(env: QuickEnvelope, publicKey: KeyObject | string): QuickManifest {
  const key = typeof publicKey === 'string' ? publicKeyFrom(publicKey) : publicKey
  const signature = Buffer.from(env.signature, 'base64')
  let ok = false
  try {
    ok = signature.length === 64 && verify(null, Buffer.from(env.manifest, 'utf8'), key, signature)
  } catch {
    ok = false
  }
  if (!ok) throw new QuickError('signature', 'The quick update signature does not verify')
  let raw: unknown
  try {
    raw = JSON.parse(env.manifest)
  } catch {
    throw new QuickError('manifest', 'The signed manifest is not JSON')
  }
  return validateManifest(raw)
}

export function parseAndVerify(text: string, publicKey: KeyObject | string): QuickManifest {
  return verifyEnvelope(parseEnvelope(text), publicKey)
}

function stringMap(value: unknown, what: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QuickError('manifest', `The manifest has no ${what}`)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') throw new QuickError('manifest', `The manifest's ${what} has a bad entry for ${k}`)
    out[k] = v
  }
  return out
}

export function validateManifest(raw: unknown): QuickManifest {
  const m = raw as Partial<QuickManifest>
  const bad = (why: string): never => {
    throw new QuickError('manifest', `The quick update manifest is invalid: ${why}`)
  }
  if (!m || typeof m !== 'object') bad('not an object')
  if (m.schema !== 1) bad(`unknown schema ${String(m.schema)}`)
  if (typeof m.version !== 'string' || !QUICK_VERSION_RE.test(m.version)) bad(`version ${String(m.version)}`)
  if (m.channel !== 'stable' && m.channel !== 'beta') bad(`channel ${String(m.channel)}`)
  if (typeof m.commit !== 'string' || !/^[0-9a-f]{7,64}$/.test(m.commit)) bad('commit')
  if (typeof m.createdAt !== 'string' || Number.isNaN(Date.parse(m.createdAt))) bad('createdAt')
  if (typeof m.electron !== 'string' || !m.electron) bad('electron version')
  const native = stringMap(m.native, 'native modules')
  const deps = stringMap(m.deps, 'packages')
  const zip = m.zip
  if (!zip || typeof zip !== 'object') bad('zip')
  if (zip!.name !== zipNameFor(m.version!)) bad(`zip name ${String(zip!.name)}`)
  if (typeof zip!.size !== 'number' || !Number.isInteger(zip!.size) || zip!.size <= 0 || zip!.size > MAX_ZIP_BYTES) bad('zip size')
  if (typeof zip!.sha256 !== 'string' || !HEX64.test(zip!.sha256)) bad('zip sha256')
  const files = stringMap(m.files, 'file list')
  try {
    checkFileList(files)
  } catch (e) {
    bad((e as Error).message)
  }
  if (!files['main/app.js'] || !files['renderer/index.html']) bad('main/app.js or renderer/index.html is missing')
  return {
    schema: 1,
    version: m.version!,
    channel: m.channel!,
    commit: m.commit!,
    createdAt: m.createdAt!,
    electron: m.electron!,
    native,
    deps,
    zip: { name: zip!.name, size: zip!.size, sha256: zip!.sha256 },
    files
  }
}
