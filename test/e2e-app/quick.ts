// Quick updates end to end against the built app (out/): a local feed serves signed bundles, and the
// app is launched again and again in an isolated HOME. Not part of npm test or run.ts.
//
//   npm run build
//   xvfb-run -a -s "-screen 0 1920x1080x24" node --experimental-strip-types test/e2e-app/quick.ts
//
// The app honours FORGE_QUICK_DEV / FORGE_QUICK_FEED / FORGE_QUICK_TEST_KEY only when it is not
// packaged (src/main/bootstrap.ts), so this test signs with a throwaway key. It checks that:
//   1. a manifest signed by another key and a zip that differs from its signed sha256 are refused,
//   2. a good bundle is downloaded, unpacked into userData/code/<version>, and runs at the next
//      launch (its marker line is printed, Settings reports quick code, the boot marker is cleared),
//   3. a file changed on disk after install makes the next launch run the installed code,
//   4. a bundle that throws while loading is marked bad, Forge relaunches into the installed code,
//      and the leftover version folders are removed.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appEnv, loadPlaywright, makeSandbox, REPO, seedSettings } from './lib/app.ts'
import { makeQuickBundle } from '../../build/quick-bundle.ts'
import { publicKeyBase64 } from '../../src/main/services/quick/manifest.ts'
import { shellInfoFromLock } from '../../src/main/services/quick/shellInfo.ts'
import { readCodeState } from '../../src/main/services/quick/codeState.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
const shell = shellInfoFromLock(JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8')))
const key = generateKeyPairSync('ed25519')
const foreignKey = generateKeyPairSync('ed25519')
const work = mkdtempSync(join(tmpdir(), 'forge-quick-e2e-'))

function variant(name: string, edit: (dir: string) => void): string {
  const dir = join(work, name)
  cpSync(join(REPO, 'out'), dir, { recursive: true })
  edit(dir)
  return dir
}
const v1 = `${pkg.version}-quick.1`
const v2 = `${pkg.version}-quick.2`
const good = makeQuickBundle({
  from: variant('good', (d) => {
    const f = join(d, 'main', 'app.js')
    writeFileSync(f, readFileSync(f, 'utf8').replace('"use strict";', '"use strict";\nglobalThis.__quickE2E = __dirname;'))
  }),
  version: v1,
  channel: 'stable',
  commit: 'e2e0001',
  key: key.privateKey,
  shell
})
const forged = makeQuickBundle({ from: join(work, 'good'), version: v1, channel: 'stable', commit: 'e2e0001', key: foreignKey.privateKey, shell })
const broken = makeQuickBundle({
  from: variant('broken', (d) => writeFileSync(join(d, 'main', 'app.js'), 'throw new Error("[quick-e2e] this bundle is broken")\n')),
  version: v2,
  channel: 'stable',
  commit: 'e2e0002',
  key: key.privateKey,
  shell
})

// The feed: name -> body, swapped between steps.
let feed: Record<string, Buffer | string> = {}
const server = createServer((req, res) => {
  const name = (req.url ?? '').split('?')[0].replace(/^\/+/, '')
  const body = feed[name]
  if (body === undefined) {
    res.writeHead(404).end('not found')
    return
  }
  res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body)
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port

const sandbox = makeSandbox()
seedSettings(sandbox, { toolchainSetup: 'skipped' })
const codeRoot = join(sandbox.userData, 'code')
const env = { ...appEnv(sandbox.home), FORGE_QUICK_DEV: '1', FORGE_QUICK_FEED: `http://127.0.0.1:${port}`, FORGE_QUICK_TEST_KEY: publicKeyBase64(key.publicKey) }
const electron = join(REPO, 'node_modules', 'electron', 'dist', 'electron')
const ARGS = [REPO, '--no-sandbox', '--disable-gpu-sandbox']

async function launch(): Promise<{ app: any; page: any; log: string[] }> {
  const { _electron } = await loadPlaywright()
  const log: string[] = []
  const app = await _electron.launch({ executablePath: electron, args: ARGS, cwd: REPO, env, timeout: 60_000 })
  app.process().stdout?.on('data', (c: Buffer) => log.push(...c.toString().split('\n').filter(Boolean)))
  app.process().stderr?.on('data', (c: Buffer) => log.push(...c.toString().split('\n').filter(Boolean)))
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!(window as any).harness && (document.getElementById('root')?.childElementCount ?? 0) > 0, null, { timeout: 60_000 })
  return { app, page, log }
}
const state = (page: any) => page.evaluate(() => (window as any).harness.updateGetState())
const check = (page: any) => page.evaluate(() => (window as any).harness.updateCheck())
const versions = () => (existsSync(codeRoot) ? readdirSync(codeRoot).filter((n) => n !== 'state.json').sort() : [])
const results: string[] = []
const pass = (line: string) => {
  results.push(`ok - ${line}`)
  console.log(`ok - ${line}`)
}

try {
  // 1. Refusals, then a good download.
  let { app, page } = await launch()
  let s = await state(page)
  assert.equal(s.quick.running.source, 'bundled')
  assert.equal(s.quick.phase === 'idle' || s.quick.phase === 'none', true, `phase ${s.quick.phase}: ${s.quick.note ?? ''}`)

  feed = { 'quick-stable.json': forged.envelope, [forged.manifest.zip.name]: forged.zip }
  s = await check(page)
  assert.equal(s.quick.phase, 'error')
  assert.match(s.quick.message, /signature does not verify/)
  assert.deepEqual(versions(), [])
  pass('a manifest signed with another key is refused before anything is downloaded')

  const tampered = Buffer.from(good.zip)
  tampered[tampered.length >> 1] ^= 0xff
  feed = { 'quick-stable.json': good.envelope, [good.manifest.zip.name]: tampered }
  s = await check(page)
  assert.equal(s.quick.phase, 'error')
  assert.match(s.quick.message, /sha256/)
  assert.deepEqual(versions(), [])
  pass('a zip that differs from its signed sha256 is refused and nothing is unpacked')

  feed = { 'quick-stable.json': good.envelope, [good.manifest.zip.name]: good.zip }
  s = await check(page)
  assert.equal(s.quick.phase, 'ready', JSON.stringify(s.quick))
  assert.equal(s.quick.version, v1)
  assert.deepEqual(versions(), [v1])
  await page.screenshot({ path: join(work, 'ready.png') })
  pass(`a signed bundle is downloaded, verified and unpacked into code/${v1}`)
  await app.close()

  // 2. The next launch runs it.
  let log: string[]
  ;({ app, page, log } = await launch())
  s = await state(page)
  assert.equal(s.quick.running.source, 'quick')
  assert.equal(s.quick.running.version, v1)
  // The marker the test put into this bundle's main/app.js ran, from the unpacked folder.
  assert.equal(await app.evaluate(() => (globalThis as any).__quickE2E), join(codeRoot, v1, 'main'))
  for (let i = 0; i < 40 && readCodeState(join(codeRoot, 'state.json')).booting; i++) await sleep(250)
  assert.equal(readCodeState(join(codeRoot, 'state.json')).booting, undefined, 'boot marker cleared')
  // The hot main process still finds the installed app's packages (zod, the agent SDK...).
  assert.ok(!log.some((l) => /Cannot find module/.test(l)), log.join('\n'))
  pass(`the next launch runs ${v1} from userData/code and clears the boot marker`)
  await page.keyboard.press('Control+,')
  await page.locator('nav.set-nav button', { hasText: 'Updates' }).first().click({ timeout: 15_000 })
  await page.waitForSelector('#set-updates', { timeout: 15_000 })
  await page.evaluate(() => document.getElementById('set-updates')?.scrollIntoView({ block: 'start' }))
  await sleep(500)
  assert.match(await page.locator('#set-updates').evaluate((e: HTMLElement) => e.parentElement?.innerText ?? ''), new RegExp(`quick update ${v1.replace(/\./g, '\\.')} on the installed app`))
  await page.screenshot({ path: join(work, 'settings.png') })
  pass('Settings > Updates says which code runs')
  await app.close()

  // 3. A file changed after install: back to the installed code.
  appendFileSync(join(codeRoot, v1, 'renderer', 'index.html'), '<!-- changed -->')
  ;({ app, page, log } = await launch())
  s = await state(page)
  assert.equal(s.quick.running.source, 'bundled')
  assert.match(readCodeState(join(codeRoot, 'state.json')).bad[v1]?.reason ?? '', /changed after it was installed/)
  assert.equal(await app.evaluate(() => (globalThis as any).__quickE2E), undefined)
  pass('a bundle changed on disk is marked bad and the installed code runs')

  // 4. A broken bundle: marked bad at once, Forge relaunches into the installed code.
  feed = { 'quick-stable.json': broken.envelope, [broken.manifest.zip.name]: broken.zip }
  s = await check(page)
  assert.equal(s.quick.phase, 'ready', JSON.stringify(s.quick))
  assert.equal(s.quick.version, v2)
  await app.close()
  // Plain spawn: the bootstrap relaunches, which a Playwright session would not follow.
  const child = spawn(electron, ARGS, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const out: string[] = []
  child.stdout.on('data', (c: Buffer) => out.push(c.toString()))
  child.stderr.on('data', (c: Buffer) => out.push(c.toString()))
  await new Promise((r) => child.once('exit', r))
  assert.match(out.join(''), /\[quick-e2e\] this bundle is broken/)
  assert.match(readCodeState(join(codeRoot, 'state.json')).bad[v2]?.reason ?? '', /failed to load/)
  // The relaunched instance runs the installed code; stop it before the next launch.
  for (let i = 0; i < 40 && !sandboxProcesses(sandbox.home).length; i++) await sleep(250)
  assert.ok(sandboxProcesses(sandbox.home).length > 0, 'Forge relaunched itself')
  await sleep(8000)
  await stopSandboxApp(sandbox.home)
  ;({ app, page, log } = await launch())
  s = await state(page)
  assert.equal(s.quick.running.source, 'bundled')
  pass(`a bundle that throws while loading is marked bad, and Forge relaunches into the installed code`)
  // Folders that can never run again are removed shortly after startup.
  for (let i = 0; i < 40 && versions().length; i++) await sleep(500)
  assert.deepEqual(versions(), [])
  pass('bad and superseded version folders are removed')
  await app.close()
} finally {
  killSandboxProcesses(sandbox.home)
  server.close()
}
console.log(`\n${results.length} checks passed. Work folder: ${work}`)

// This test's Electron processes: started with HOME=<sandbox>, or (Chromium rewrites the process
// title over the environment block) a main process for this checkout, plus their children.
function sandboxProcesses(home: string): number[] {
  const procs = new Map<number, { ppid: number; ours: boolean }>()
  for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ')
      const ppid = Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[1])
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
      const ours = env.includes(`HOME=${home}`) || (/electron/.test(cmd) && cmd.includes(` ${REPO}`) && !cmd.includes('--type='))
      procs.set(Number(pid), { ppid, ours })
    } catch {
      // gone or not readable
    }
  }
  const out = new Set<number>()
  for (const [pid, p] of procs) if (p.ours) out.add(pid)
  for (let grew = true; grew; ) {
    grew = false
    for (const [pid, p] of procs) {
      if (!out.has(pid) && out.has(p.ppid)) {
        out.add(pid)
        grew = true
      }
    }
  }
  return [...out]
}

// Quit the relaunched app the way a user would (SIGTERM to its main process), so it releases the
// single-instance lock, then clean up whatever is left.
async function stopSandboxApp(home: string): Promise<void> {
  for (const pid of sandboxProcesses(home)) {
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type=')) process.kill(pid, 'SIGTERM')
    } catch {
      // gone
    }
  }
  for (let i = 0; i < 60 && sandboxProcesses(home).length; i++) await sleep(250)
  killSandboxProcesses(home)
  await sleep(500)
}

function killSandboxProcesses(home: string): void {
  for (const pid of sandboxProcesses(home)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}
