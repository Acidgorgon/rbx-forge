// Mock-renderer click-through: the built renderer (out/renderer) in Electron WITHOUT the preload
// bridge, so it runs on the browser mocks (src/renderer/src/mocks). Flows that need fake backends no
// real-app run has (a vision model, an image backend, Open Cloud) live here. Not part of npm test.
//
//   npm run build
//   xvfb-run -a -s "-screen 0 1920x1080x24" node --experimental-strip-types test/e2e-app/mock.ts [--only=art-split-layers]
//
// Each flow fails on its own checks and on any renderer console error / page error while it ran.
// Screenshots: test/e2e-app/out/shots/mock-<flow>-<name>.png; failures: out/fail-mock-<flow>.png.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { appEnv, IGNORED_ERRORS, loadPlaywright, REPO } from './lib/app.ts'
import { mockArtFlows } from './flows/mockArt.ts'
import { mockScmFlows } from './flows/mockScm.ts'
import { mockSearchFlows } from './flows/mockSearch.ts'

const OUT = resolve(import.meta.dirname, 'out')
const FLOWS = [...mockArtFlows, ...mockScmFlows, ...mockSearchFlows]

async function main(): Promise<void> {
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',').filter(Boolean)
  const flows = only ? FLOWS.filter((f) => only.includes(f.name)) : FLOWS
  if (!flows.length) throw new Error(`no flow matches (have: ${FLOWS.map((f) => f.name).join(', ')})`)
  const rendererDir = join(REPO, 'out', 'renderer')
  if (!existsSync(join(rendererDir, 'index.html'))) throw new Error('out/renderer is missing: run npm run build first')
  mkdirSync(join(OUT, 'shots'), { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'forge-mock-e2e-'))
  const { _electron } = await loadPlaywright()
  const app = await _electron.launch({
    executablePath: join(REPO, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [join(import.meta.dirname, 'lib', 'mockMain.cjs'), '--no-sandbox', '--disable-gpu-sandbox'],
    cwd: REPO,
    env: { ...appEnv(home), FORGE_RENDERER_DIR: rendererDir, FORGE_MOCK_USERDATA: join(home, 'userData') },
    timeout: 60_000
  })
  const page = await app.firstWindow({ timeout: 60_000 })
  const errors: string[] = []
  page.on('console', (m: { type(): string; text(): string }) => m.type() === 'error' && !IGNORED_ERRORS.some((r) => r.test(m.text())) && errors.push(m.text()))
  page.on('pageerror', (e: Error) => errors.push(`${e.message}\n${e.stack ?? ''}`))
  await page.waitForLoadState('domcontentloaded')
  await page.locator('nav.activity').waitFor({ state: 'visible', timeout: 30_000 })
  let failed = 0
  try {
    for (const f of flows) {
      const seen = errors.length
      const notes: string[] = []
      const t0 = Date.now()
      try {
        await f.run({ page, note: (n) => void notes.push(n), shot: async (name) => {
          const p = join(OUT, 'shots', `mock-${f.name}-${name}.png`)
          await page.screenshot({ path: p })
          return p
        } })
        const errs = errors.slice(seen)
        if (errs.length) throw new Error(`console errors:\n${errs.join('\n')}`)
        console.log(`pass  ${f.name} (${Date.now() - t0} ms)${notes.length ? ` - ${notes.join('; ')}` : ''}`)
      } catch (error) {
        failed++
        await page.screenshot({ path: join(OUT, `fail-mock-${f.name}.png`) }).catch(() => undefined)
        console.log(`FAIL  ${f.name}: ${(error as Error).message}`)
      }
    }
  } finally {
    await app.close().catch(() => undefined)
    rmSync(home, { recursive: true, force: true })
  }
  if (failed) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
