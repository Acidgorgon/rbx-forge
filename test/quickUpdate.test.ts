// Quick updates (src/main/services/quick): version order, signed manifests, compatibility with the
// installed app, bad-version bookkeeping, zip path safety, unpacking, the launch-time choice and the
// check/download state machine against a fake feed. Plus the CI bundler's zip writer.
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { compareVersions, isNewer, isQuickVersion, parseVersion } from '../src/main/services/quick/version.ts'
import { parseAndVerify, parseEnvelope, privateKeyFrom, publicKeyBase64, QuickError, sha256Hex, signManifest, validateManifest, zipNameFor, type QuickManifest } from '../src/main/services/quick/manifest.ts'
import { checkCompat, shellInfoFromLock, type ShellInfo } from '../src/main/services/quick/shellInfo.ts'
import { beginBoot, emptyCodeState, finishBoot, isBad, markBad, parseCodeState, readCodeState, recoverInterruptedBoot, setDisabled, writeCodeState } from '../src/main/services/quick/codeState.ts'
import { checkFileList, checkZipEntries, safeZipPath } from '../src/main/services/quick/zipPath.ts'
import { githubQuickFeed, isAllowedUrl, localQuickFeed } from '../src/main/services/quick/feed.ts'
import { installBundle } from '../src/main/services/quick/install.ts'
import { planBoot, verifyInstalled } from '../src/main/services/quick/boot.ts'
import { QuickUpdater, type FetchResult, type QuickUpdaterDeps } from '../src/main/services/quick/updater.ts'
import { readZip, writeZip } from '../src/main/services/setup/unzip.ts'
import { writeDeflateZip } from '../build/quick-bundle.ts'
import type { QuickUpdateState } from '../src/shared/updateTypes.ts'

const keys = generateKeyPairSync('ed25519')
const PUB = publicKeyBase64(keys.publicKey)
const other = generateKeyPairSync('ed25519')

const SHELL: ShellInfo = { electron: '44.7.0', native: { 'node-pty': '1.1.0' }, deps: { 'node-pty': '1.1.0', zod: '4.1.0', 'electron-updater': '6.8.10' } }

function bundleFiles(tag = 'v1'): Record<string, string> {
  return {
    'main/app.js': `console.log("${tag}")`,
    'main/chunks/x.js': 'module.exports = 1',
    'preload/index.js': '// preload',
    'renderer/index.html': '<div id="root"></div>',
    'renderer/assets/app.js': `// renderer ${tag}`
  }
}

function makeBundle(version: string, opts: { files?: Record<string, string>; shell?: ShellInfo; channel?: 'stable' | 'beta'; key?: typeof keys.privateKey; extraZip?: { name: string; data: string }[] } = {}) {
  const files = opts.files ?? bundleFiles(version)
  const zip = writeDeflateZip([...Object.entries(files).map(([n, d]) => [n, Buffer.from(d)] as [string, Buffer]), ...(opts.extraZip ?? []).map((e) => [e.name, Buffer.from(e.data)] as [string, Buffer])])
  const manifest: QuickManifest = validateManifest({
    schema: 1,
    version,
    channel: opts.channel ?? 'stable',
    commit: '4aa6a4f0',
    createdAt: '2026-10-14T10:00:00.000Z',
    ...(opts.shell ?? SHELL),
    zip: { name: zipNameFor(version), size: zip.length, sha256: sha256Hex(zip) },
    files: Object.fromEntries(Object.entries(files).map(([n, d]) => [n, sha256Hex(Buffer.from(d))]))
  })
  const text = signManifest(manifest, opts.key ?? keys.privateKey)
  return { manifest, text, zip }
}

test('quick versions sort after the release they patch, before the next one', () => {
  const order = ['0.6.0-beta.2', '0.6.0', '0.6.0-quick.1', '0.6.0-quick.2', '0.6.0-quick.10', '0.6.1-beta.3', '0.6.1', '0.6.1-quick.1', '1.0.0']
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) assert.equal(Math.sign(compareVersions(order[i], order[j])), Math.sign(i - j), `${order[i]} vs ${order[j]}`)
  }
  assert.equal(compareVersions('v0.6.0', '0.6.0'), 0)
  assert.ok(isNewer('0.6.0-quick.3', '0.6.0'))
  assert.ok(!isNewer('0.6.0-quick.3', '0.6.1-beta.1'))
  assert.equal(parseVersion('0.6.0-quick.7')?.quick, 7)
  assert.equal(parseVersion('nope'), null)
  assert.throws(() => compareVersions('x', '1.0.0'))
  assert.ok(isQuickVersion('0.6.0-quick.12'))
  for (const bad of ['0.6.0', '0.6.0-quick', '0.6.0-quick.1.2', '../0.6.0-quick.1', '0.6.0-beta.1-quick.2', '0.6.0-quick.1 ']) assert.ok(!isQuickVersion(bad), bad)
})

test('manifest: a signed envelope verifies; any change to it does not', () => {
  const { text, manifest } = makeBundle('0.6.0-quick.3')
  assert.deepEqual(parseAndVerify(text, PUB), manifest)
  const env = parseEnvelope(text)
  // Changed manifest text (one file hash swapped), same signature.
  const tampered = { ...env, manifest: env.manifest.replace(manifest.zip.sha256, '0'.repeat(64)) }
  assert.throws(() => parseAndVerify(JSON.stringify(tampered), PUB), (e: unknown) => e instanceof QuickError && e.kind === 'signature')
  // Signature from another key, and a mangled signature.
  const foreign = makeBundle('0.6.0-quick.3', { key: other.privateKey }).text
  assert.throws(() => parseAndVerify(foreign, PUB), /does not verify/)
  assert.throws(() => parseAndVerify(JSON.stringify({ ...env, signature: 'AAAA' }), PUB), /does not verify/)
  // Not an envelope, or no key in the build.
  assert.throws(() => parseAndVerify('{"manifest":"{}"}', PUB), /unknown format/)
  assert.throws(() => parseAndVerify('not json', PUB), /not JSON/)
  assert.throws(() => parseAndVerify(text, ''), /no quick update key/)
  // An RSA key is refused as the embedded key.
  const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  assert.throws(() => parseAndVerify(text, rsa), /not an Ed25519 key/)
})

test('manifest: shape checks run after the signature', () => {
  const base = makeBundle('0.6.0-quick.3').manifest
  const signed = (m: unknown) => {
    const text = JSON.stringify(m)
    return JSON.stringify({ format: 'rbx-forge-quick/1', manifest: text, signature: sign(null, Buffer.from(text), keys.privateKey).toString('base64') })
  }
  assert.throws(() => parseAndVerify(signed({ ...base, version: '0.6.0' }), PUB), /version/)
  assert.throws(() => parseAndVerify(signed({ ...base, zip: { ...base.zip, name: '../x.zip' } }), PUB), /zip name/)
  assert.throws(() => parseAndVerify(signed({ ...base, files: { ...base.files, '../evil.js': 'a'.repeat(64) } }), PUB), /Unsafe path/)
  assert.throws(() => parseAndVerify(signed({ ...base, files: { 'renderer/index.html': 'a'.repeat(64) } }), PUB), /main\/app.js/)
  assert.throws(() => parseAndVerify(signed({ ...base, channel: 'nightly' }), PUB), /channel/)
  assert.throws(() => parseAndVerify(signed({ ...base, schema: 2 }), PUB), /schema/)
})

test('signing keys: PEM or base64 DER, Ed25519 only', () => {
  const pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const der = keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  assert.equal(publicKeyBase64(privateKeyFrom(pem)), PUB)
  assert.equal(publicKeyBase64(privateKeyFrom(`${der}\n`)), PUB)
  assert.throws(() => privateKeyFrom(''), /No signing key/)
  const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  assert.throws(() => privateKeyFrom(rsa), /not ed25519/)
})

test('compatibility: Electron, native modules and every package must match', () => {
  assert.deepEqual(checkCompat(SHELL, SHELL), { ok: true })
  const r = checkCompat({ ...SHELL, electron: '44.8.0', native: { 'node-pty': '1.2.0' }, deps: { ...SHELL.deps, 'node-pty': '1.2.0', zod: '4.2.0' } }, SHELL)
  assert.equal(r.ok, false)
  assert.deepEqual(!r.ok && r.reasons, ['Electron 44.7.0 -> 44.8.0', 'node-pty 1.1.0 -> 1.2.0', 'zod 4.1.0 -> 4.2.0'])
  const many = checkCompat({ ...SHELL, deps: { ...SHELL.deps, a: '1', b: '1', c: '1', d: '1' } }, SHELL)
  assert.deepEqual(!many.ok && many.reasons, ['a missing -> 1, b missing -> 1, c missing -> 1 and 1 more packages'])
  // From a lockfile: production packages only, nested installs by path.
  const info = shellInfoFromLock({
    packages: {
      '': { version: '0.6.0' },
      'node_modules/electron': { version: '44.7.0', dev: true },
      'node_modules/node-pty': { version: '1.1.0' },
      'node_modules/zod': { version: '4.1.0' },
      'node_modules/vite': { version: '7.3.7', dev: true },
      'node_modules/a/node_modules/semver': { version: '7.7.4' }
    }
  })
  assert.deepEqual(info, { electron: '44.7.0', native: { 'node-pty': '1.1.0' }, deps: { 'a/node_modules/semver': '7.7.4', 'node-pty': '1.1.0', zod: '4.1.0' } })
  assert.throws(() => shellInfoFromLock({ packages: {} }), /electron/)
})

test('bad-version bookkeeping: an unfinished boot marks the version bad', () => {
  let s = emptyCodeState()
  s = beginBoot(s, '0.6.0-quick.2', 1)
  assert.equal(s.booting?.version, '0.6.0-quick.2')
  assert.deepEqual(finishBoot(s, '0.6.0-quick.9'), s, 'another version leaves the marker')
  assert.equal(finishBoot(s, '0.6.0-quick.2').booting, undefined)
  const r = recoverInterruptedBoot(s, 5)
  assert.equal(r.failed, '0.6.0-quick.2')
  assert.ok(isBad(r.state, '0.6.0-quick.2'))
  assert.equal(r.state.booting, undefined)
  assert.equal(recoverInterruptedBoot(r.state, 6).failed, null)
  // Bounded, newest kept.
  let many = emptyCodeState()
  for (let i = 0; i < 60; i++) many = markBad(many, `0.6.0-quick.${i}`, 'x', i)
  assert.equal(Object.keys(many.bad).length, 50)
  assert.ok(isBad(many, '0.6.0-quick.59') && !isBad(many, '0.6.0-quick.0'))
  assert.equal(setDisabled(s, true).disabled, true)
  assert.equal(setDisabled(setDisabled(s, true), false).disabled, undefined)
  // Garbage on disk reads as empty; a round trip keeps everything.
  assert.deepEqual(parseCodeState('{nope'), emptyCodeState())
  assert.deepEqual(parseCodeState('[1]'), emptyCodeState())
  const dir = mkdtempSync(join(tmpdir(), 'quick-state-'))
  const file = join(dir, 'code', 'state.json')
  assert.deepEqual(readCodeState(file), emptyCodeState())
  writeCodeState(file, r.state)
  assert.deepEqual(readCodeState(file), r.state)
})

test('zip paths: only main/, preload/, renderer/ and nothing that escapes', () => {
  assert.equal(safeZipPath('main/app.js'), 'main/app.js')
  assert.equal(safeZipPath('renderer/assets/'), 'renderer/assets')
  for (const bad of ['../main/app.js', 'main/../../x.js', '/main/app.js', 'main\\app.js', 'C:/main/app.js', 'main/a:b.js', 'other/x.js', 'main//x.js', 'main/./x.js', 'main/CON', 'main/nul.txt', 'main/x.js.', 'main/x ', 'main/a\0b', 'main/a\nb', '', 'x'.repeat(300)]) {
    assert.equal(safeZipPath(bad), null, JSON.stringify(bad))
  }
  const files = { 'main/app.js': 'a'.repeat(64), 'renderer/index.html': 'b'.repeat(64) }
  checkZipEntries([{ name: 'main/', directory: true }, { name: 'main/app.js', directory: false }, { name: 'renderer/index.html', directory: false }], files)
  assert.throws(() => checkZipEntries([{ name: '../main/app.js', directory: false }], files), /Unsafe path/)
  assert.throws(() => checkZipEntries([{ name: 'main/app.js', directory: false }], files), /missing renderer\/index.html/)
  assert.throws(() => checkZipEntries([{ name: 'main/app.js', directory: false }, { name: 'renderer/index.html', directory: false }, { name: 'main/extra.js', directory: false }], files), /does not list/)
  assert.throws(() => checkZipEntries([{ name: 'main/app.js', directory: false }, { name: 'main/app.js', directory: false }, { name: 'renderer/index.html', directory: false }], files), /twice/)
  assert.throws(() => checkFileList({ 'main/a.js': 'a'.repeat(64), 'main/A.js': 'a'.repeat(64) }), /twice/)
  assert.throws(() => checkFileList({ main: 'a'.repeat(64) }), /Unsafe/)
  assert.throws(() => checkFileList({ 'main/a.js': 'xyz' }), /sha256/)
})

test('feed: https GitHub release URLs only (plus localhost for the dev test feed)', () => {
  const feed = githubQuickFeed('Acidgorgon', 'rbx-forge')
  assert.equal(feed.manifestUrl('stable'), 'https://github.com/Acidgorgon/rbx-forge/releases/download/quick/quick-stable.json')
  assert.equal(feed.zipUrl('forge-code-0.6.0-quick.1.zip'), 'https://github.com/Acidgorgon/rbx-forge/releases/download/quick/forge-code-0.6.0-quick.1.zip')
  assert.throws(() => feed.zipUrl('../x'), /Bad bundle name/)
  assert.throws(() => githubQuickFeed('a/b', 'c'), /Bad feed/)
  for (const ok of ['https://github.com/a/b/releases/download/quick/x', 'https://objects.githubusercontent.com/x?sig=1', 'https://release-assets.githubusercontent.com/x']) assert.ok(isAllowedUrl(ok), ok)
  for (const bad of ['http://github.com/x', 'https://github.com.evil.com/x', 'https://evil.com/github.com', 'https://user:pw@github.com/x', 'https://github.com:8443/x', 'file:///etc/passwd', 'http://127.0.0.1:8080/x', 'nonsense']) assert.ok(!isAllowedUrl(bad), bad)
  assert.ok(isAllowedUrl('http://127.0.0.1:8080/x', true))
  assert.ok(!isAllowedUrl('http://10.0.0.1:8080/x', true))
  assert.equal(localQuickFeed('http://127.0.0.1:9/').manifestUrl('beta'), 'http://127.0.0.1:9/quick-beta.json')
  assert.throws(() => localQuickFeed('https://evil.com'), /FORGE_QUICK_FEED/)
})

test('the CI zip writer produces zips the app reads back byte for byte', () => {
  const files: [string, Buffer][] = [['main/app.js', Buffer.from('x'.repeat(5000))], ['renderer/a.bin', Buffer.from([0, 1, 2])]]
  const entries = readZip(writeDeflateZip(files))
  assert.deepEqual(entries.map((e) => [e.name, e.data.toString('hex')]), files.map(([n, d]) => [n, d.toString('hex')]))
})

test('install: verified bundles unpack into code/<version>; tampered or unsafe ones never do', async () => {
  const codeRoot = join(mkdtempSync(join(tmpdir(), 'quick-install-')), 'code')
  const b = makeBundle('0.6.0-quick.4')
  const dir = await installBundle({ codeRoot, manifest: b.manifest, envelopeText: b.text, zip: b.zip, publicKey: PUB })
  assert.equal(dir, join(codeRoot, '0.6.0-quick.4'))
  assert.equal(readFileSync(join(dir, 'main', 'app.js'), 'utf8'), 'console.log("0.6.0-quick.4")')
  assert.equal(verifyInstalled(dir, '0.6.0-quick.4', PUB).version, '0.6.0-quick.4')
  // Reinstalling the same version replaces it.
  await installBundle({ codeRoot, manifest: b.manifest, envelopeText: b.text, zip: b.zip, publicKey: PUB })

  const flipped = Buffer.from(b.zip)
  flipped[40] ^= 1
  await assert.rejects(installBundle({ codeRoot, manifest: b.manifest, envelopeText: b.text, zip: flipped, publicKey: PUB }), /sha256/)
  // A zip-slip entry: the manifest cannot even list it, and an unlisted entry is refused.
  const slip = writeZip([...Object.entries(bundleFiles()).map(([name, data]) => ({ name, data })), { name: '../../evil.js', data: 'pwned' }])
  const slipManifest = { ...makeBundle('0.6.0-quick.5', { files: bundleFiles() }).manifest, zip: { name: zipNameFor('0.6.0-quick.5'), size: slip.length, sha256: sha256Hex(slip) } }
  await assert.rejects(installBundle({ codeRoot, manifest: slipManifest, envelopeText: '', zip: slip, publicKey: PUB }), /Unsafe path/)
  assert.ok(!existsSync(join(codeRoot, '..', '..', 'evil.js')))
  // A file whose content differs from the signed list.
  const files = bundleFiles()
  const swapped = writeZip(Object.entries({ ...files, 'main/app.js': 'evil()' }).map(([name, data]) => ({ name, data })))
  const swappedManifest = { ...makeBundle('0.6.0-quick.6', { files }).manifest, zip: { name: zipNameFor('0.6.0-quick.6'), size: swapped.length, sha256: sha256Hex(swapped) } }
  await assert.rejects(installBundle({ codeRoot, manifest: swappedManifest, envelopeText: '', zip: swapped, publicKey: PUB }), /main\/app.js does not match/)
  // No temp folders are left behind.
  assert.deepEqual(readdirSync(codeRoot).sort(), ['0.6.0-quick.4'])
})

async function installed(codeRoot: string, version: string, opts: Parameters<typeof makeBundle>[1] = {}) {
  const b = makeBundle(version, opts)
  return installBundle({ codeRoot, manifest: b.manifest, envelopeText: b.text, zip: b.zip, publicKey: PUB })
}

test('boot: newest verified, compatible, not-bad version newer than the app wins', async () => {
  const codeRoot = join(mkdtempSync(join(tmpdir(), 'quick-boot-')), 'code')
  const log: string[] = []
  const plan = (shellVersion = '0.6.0') => planBoot({ codeRoot, shellVersion, shell: SHELL, publicKey: PUB, now: () => 100, log: (l) => log.push(l) })
  assert.equal(plan().choice, null, 'no code folder yet')

  await installed(codeRoot, '0.6.0-quick.1')
  await installed(codeRoot, '0.6.0-quick.2')
  await installed(codeRoot, '0.6.0-quick.3', { shell: { ...SHELL, electron: '45.0.0' } })
  mkdirSync(join(codeRoot, '.tmp-0.6.0-quick.9-abcd'))
  let p = plan()
  assert.equal(p.choice?.version, '0.6.0-quick.2')
  assert.equal(p.state.booting?.version, '0.6.0-quick.2')
  assert.deepEqual(p.remove.map((d) => d.slice(codeRoot.length + 1)).sort(), ['.tmp-0.6.0-quick.9-abcd', '0.6.0-quick.1', '0.6.0-quick.3'])
  assert.equal(readCodeState(join(codeRoot, 'state.json')).booting?.version, '0.6.0-quick.2')

  // The window never loaded: the next launch marks it bad and falls back to 0.6.0-quick.1.
  p = plan()
  assert.ok(isBad(p.state, '0.6.0-quick.2'))
  assert.equal(p.choice?.version, '0.6.0-quick.1')
  assert.ok(log.some((l) => /0.6.0-quick.2 did not finish starting/.test(l)))

  // A file changed on disk after install: bad, not loaded.
  writeCodeState(join(codeRoot, 'state.json'), emptyCodeState())
  writeFileSync(join(codeRoot, '0.6.0-quick.2', 'renderer', 'assets', 'app.js'), '// changed')
  p = plan()
  assert.equal(p.choice?.version, '0.6.0-quick.1')
  assert.match(p.state.bad['0.6.0-quick.2'].reason, /changed after it was installed/)

  // quick.json signed by someone else: bad.
  writeCodeState(join(codeRoot, 'state.json'), emptyCodeState())
  await installed(codeRoot, '0.6.0-quick.7')
  writeFileSync(join(codeRoot, '0.6.0-quick.7', 'quick.json'), makeBundle('0.6.0-quick.7', { key: other.privateKey }).text)
  p = plan()
  assert.equal(p.choice?.version, '0.6.0-quick.1')
  assert.match(p.state.bad['0.6.0-quick.7'].reason, /signature/)

  // A newer full installer wins over every quick version, which are all removed.
  writeCodeState(join(codeRoot, 'state.json'), emptyCodeState())
  p = plan('0.6.1')
  assert.equal(p.choice, null)
  assert.ok(p.remove.some((d) => d.endsWith('0.6.0-quick.1')))
  // Quick updates switched off: installed code, everything removed.
  writeCodeState(join(codeRoot, 'state.json'), setDisabled(emptyCodeState(), true))
  p = plan()
  assert.equal(p.choice, null)
  assert.ok(p.remove.some((d) => d.endsWith('0.6.0-quick.1')))
})

function fakeDeps(feed: Record<string, FetchResult | (() => FetchResult)>, extra: Partial<QuickUpdaterDeps> = {}) {
  const codeRoot = join(mkdtempSync(join(tmpdir(), 'quick-upd-')), 'code')
  const store = new Map<string, unknown>()
  const states: QuickUpdateState[] = []
  const logs: string[] = []
  const requested: string[] = []
  let relaunched = 0
  const deps: QuickUpdaterDeps = {
    running: { source: 'bundled', version: '0.6.0', appVersion: '0.6.0' },
    shell: SHELL,
    publicKey: PUB,
    codeRoot,
    feed: githubQuickFeed('Acidgorgon', 'rbx-forge'),
    get: async (url) => {
      requested.push(url)
      const name = url.split('/').pop()!
      const r = feed[name]
      if (!r) return { status: 404, body: Buffer.alloc(0) }
      return typeof r === 'function' ? r() : r
    },
    settings: { get: <T>(k: string, f: T) => (store.has(k) ? (store.get(k) as T) : f), set: (k, v) => void store.set(k, v) },
    emit: (s) => states.push(s),
    log: (t) => logs.push(t),
    relaunch: () => relaunched++,
    setTimer: () => 0,
    clearTimer: () => undefined,
    setRepeat: () => 0,
    clearRepeat: () => undefined,
    ...extra
  }
  return { deps, codeRoot, store, states, logs, requested, relaunched: () => relaunched }
}

const ok = (body: string | Buffer): FetchResult => ({ status: 200, body: Buffer.isBuffer(body) ? body : Buffer.from(body) })

test('updater: downloads, verifies and unpacks a newer quick build, then offers a restart', async () => {
  const b = makeBundle('0.6.0-quick.8')
  const f = fakeDeps({ 'quick-stable.json': ok(b.text), [b.manifest.zip.name]: ok(b.zip) })
  const q = new QuickUpdater(f.deps)
  q.start()
  const s = await q.check()
  assert.equal(s.phase, 'ready')
  assert.equal(s.version, '0.6.0-quick.8')
  assert.ok(f.states.some((x) => x.phase === 'downloading'))
  assert.ok(existsSync(join(f.codeRoot, '0.6.0-quick.8', 'main', 'app.js')))
  assert.equal(f.requested.filter((u) => u.endsWith('.zip')).length, 1)
  // A later check with nothing newer keeps the offer and downloads nothing again.
  assert.equal((await q.check()).phase, 'ready')
  assert.equal(f.requested.filter((u) => u.endsWith('.zip')).length, 1)
  q.restart()
  assert.equal(f.relaunched(), 1)
})

test('updater: refuses bad signatures, tampered zips, old and bad versions; flags full updates', async () => {
  // Signed by another key.
  const foreign = makeBundle('0.6.0-quick.8', { key: other.privateKey })
  let f = fakeDeps({ 'quick-stable.json': ok(foreign.text), [foreign.manifest.zip.name]: ok(foreign.zip) })
  let s = await new QuickUpdater(f.deps).check()
  assert.equal(s.phase, 'error')
  assert.match(s.message!, /Rejected a quick update: The quick update signature does not verify/)
  assert.ok(!f.requested.some((u) => u.endsWith('.zip')), 'nothing downloaded after a bad signature')

  // The zip on the server differs from the signed sha256.
  const b = makeBundle('0.6.0-quick.9')
  const evil = Buffer.from(b.zip)
  evil[50] ^= 0xff
  f = fakeDeps({ 'quick-stable.json': ok(b.text), [b.manifest.zip.name]: ok(evil) })
  s = await new QuickUpdater(f.deps).check()
  assert.equal(s.phase, 'error')
  assert.match(s.message!, /sha256/)
  assert.ok(!existsSync(join(f.codeRoot, '0.6.0-quick.9')))

  // Not newer than the running quick code.
  f = fakeDeps({ 'quick-stable.json': ok(b.text) }, { running: { source: 'quick', version: '0.6.0-quick.9', appVersion: '0.6.0' } })
  assert.equal((await new QuickUpdater(f.deps).check()).phase, 'none')
  // Older than the installed app (a newer full release is installed).
  f = fakeDeps({ 'quick-stable.json': ok(b.text) }, { running: { source: 'bundled', version: '0.6.1', appVersion: '0.6.1' } })
  assert.equal((await new QuickUpdater(f.deps).check()).phase, 'none')
  // Marked bad before.
  f = fakeDeps({ 'quick-stable.json': ok(b.text), [b.manifest.zip.name]: ok(b.zip) })
  writeCodeState(join(f.codeRoot, 'state.json'), markBad(emptyCodeState(), '0.6.0-quick.9', 'x', 1))
  assert.equal((await new QuickUpdater(f.deps).check()).phase, 'none')
  // Built for another Electron: needs a full update, nothing downloaded.
  const newer = makeBundle('0.6.0-quick.10', { shell: { ...SHELL, electron: '45.0.0' } })
  f = fakeDeps({ 'quick-stable.json': ok(newer.text), [newer.manifest.zip.name]: ok(newer.zip) })
  s = await new QuickUpdater(f.deps).check()
  assert.equal(s.phase, 'needsFull')
  assert.match(s.message!, /Electron 44.7.0 -> 45.0.0/)
  assert.ok(!f.requested.some((u) => u.endsWith('.zip')))
  // Nothing published yet.
  f = fakeDeps({})
  assert.equal((await new QuickUpdater(f.deps).check()).phase, 'none')
  // A beta build in the stable file is refused.
  const mislabeled = makeBundle('0.6.0-quick.11', { channel: 'beta' })
  f = fakeDeps({ 'quick-stable.json': ok(mislabeled.text) })
  assert.match((await new QuickUpdater(f.deps).check()).message!, /holds a beta build/)
})

test('updater: channels and the Quick updates switch', async () => {
  const stable = makeBundle('0.6.0-quick.3')
  const beta = makeBundle('0.6.0-quick.5', { channel: 'beta' })
  const feed = { 'quick-stable.json': ok(stable.text), 'quick-beta.json': ok(beta.text), [stable.manifest.zip.name]: ok(stable.zip), [beta.manifest.zip.name]: ok(beta.zip) }
  // Stable never reads the beta file.
  let f = fakeDeps(feed)
  assert.equal((await new QuickUpdater(f.deps).check()).version, '0.6.0-quick.3')
  assert.ok(!f.requested.some((u) => u.includes('quick-beta')))
  // Beta takes the newest of both.
  f = fakeDeps(feed)
  f.store.set('updates', { channel: 'beta' })
  assert.equal((await new QuickUpdater(f.deps).check()).version, '0.6.0-quick.5')
  // Off: no checks, and the bootstrap is told through state.json.
  f = fakeDeps(feed)
  const q = new QuickUpdater(f.deps)
  q.start()
  f.store.set('updates', { quick: false })
  q.settingsChanged()
  assert.equal(q.current.phase, 'off')
  assert.equal(readCodeState(join(f.codeRoot, 'state.json')).disabled, true)
  assert.equal((await q.check()).phase, 'off')
  assert.equal(f.requested.length, 0)
  f.store.set('updates', { quick: true })
  q.settingsChanged()
  assert.equal(readCodeState(join(f.codeRoot, 'state.json')).disabled, undefined)
  // Unavailable builds never check.
  f = fakeDeps(feed, { unavailable: 'Development build.' })
  assert.equal((await new QuickUpdater(f.deps).check()).phase, 'unavailable')
  assert.equal(f.requested.length, 0)
})
