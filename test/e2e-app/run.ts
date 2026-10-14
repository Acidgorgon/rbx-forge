// RBX Forge real-app click-through suite (see README.md next to this file).
//
//   npm run test:app                        build, then run every flow under xvfb
//   node --experimental-strip-types test/e2e-app/run.ts --only=vfx-lab,anim-lab   (inside xvfb-run -a)
//   ... --list                              print the flows
//
// One app instance runs the flows in order (relaunched if it dies). Each flow is a separate result
// with its own console / uncaught-error attribution; a failed flow saves a screenshot to
// test/e2e-app/out/fail-<flow>.png. Results go to out/summary.json and out/summary.md.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BRIDGE_PORT, launchApp, mainErrors, makeSandbox, portFree, seedSettings, type AppError, type Launched } from './lib/app.ts'
import { startFakeProvider, type FakeProvider } from './lib/fakeProvider.ts'
import { makeAppProject } from './lib/project.ts'
import { SkipFlow } from './lib/ui.ts'
import { FLOWS, type FlowCtx } from './flows/index.ts'

const OUT = resolve(import.meta.dirname, 'out')

interface Result {
  flow: string
  title: string
  status: 'pass' | 'fail' | 'skip'
  ms: number
  notes: string[]
  error?: string
  errors: AppError[]
  screenshot?: string
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return undefined
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : 'true'
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([p, t])
  } finally {
    clearTimeout(timer)
  }
}

async function main(): Promise<void> {
  if (arg('list')) {
    for (const f of FLOWS) console.log(`${f.name.padEnd(22)} ${f.title}`)
    return
  }
  const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean)
  const flows = only ? FLOWS.filter((f) => only.includes(f.name)) : FLOWS
  if (only && flows.length !== only.length) throw new Error(`unknown flow in --only (have: ${FLOWS.map((f) => f.name).join(', ')})`)

  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(join(OUT, 'shots'), { recursive: true })

  const fake: FakeProvider = await startFakeProvider()
  const bridgeFree = await portFree(BRIDGE_PORT)
  const sandbox = makeSandbox()
  const root = makeAppProject(sandbox.projectsDir)
  // LUNE_PATH (optional): the UI Preview stories and Lune-backed lab features run with it.
  const lune = process.env.LUNE_PATH || null
  seedSettings(sandbox, { toolchainSetup: 'skipped', lastProject: root, ...(lune ? { 'tests.lunePath': lune } : {}) })
  console.log(`# sandbox ${sandbox.home}\n# project ${root}\n# fake provider ${fake.baseUrl}\n# bridge port ${BRIDGE_PORT} ${bridgeFree ? 'free' : 'IN USE'}\n# lune ${lune ?? 'not set (LUNE_PATH)'}`)

  let launched: Launched | null = null
  const ensureApp = async (): Promise<Launched> => {
    const cur = launched as Launched | null
    if (cur && !cur.page.isClosed() && cur.webgl) return cur
    if (cur) {
      cur.mainLog.length && mainLogs.push(...cur.mainLog)
      await cur.app.close().catch(() => undefined)
    }
    launched = await launchApp(sandbox, { width: 1400, height: 900 })
    return launched
  }
  const mainLogs: string[] = []

  const results: Result[] = []
  for (const flow of flows) {
    const started = Date.now()
    const result: Result = { flow: flow.name, title: flow.title, status: 'pass', ms: 0, notes: [], errors: [] }
    results.push(result)
    const missing = (flow.needs ?? []).filter((n) => n === 'bridgePort' && !bridgeFree)
    if (missing.length) {
      result.status = 'skip'
      result.notes.push(`port ${BRIDGE_PORT} is in use (another Forge or Studio bridge); free it to run this flow`)
      console.log(`- ${flow.name}: skip`)
      continue
    }
    let l: Launched | null = null
    try {
      l = await ensureApp()
      l.currentFlow.name = flow.name
      // Errors since the previous flow ended (startup errors land on the first flow, 'launch').
      let errorsBefore = l.seen.errors
      let mainBefore = l.seen.main
      const ctx: FlowCtx = {
        app: l.app,
        page: l.page,
        launched: l,
        root,
        sandbox,
        fake,
        note: (m) => result.notes.push(m),
        shot: async (name) => {
          const path = join(OUT, 'shots', `${flow.name}-${name}.png`)
          await l!.page.screenshot({ path })
          return path
        },
        relaunch: async (opts) => {
          const old = l!
          mainLogs.push(...old.mainLog)
          await old.app.close().catch(() => undefined)
          l = launched = await launchApp(sandbox, { width: 1400, height: 900, ...opts })
          l.currentFlow.name = flow.name
          errorsBefore = 0
          mainBefore = 0
          return l
        }
      }
      await withTimeout(flow.run(ctx), flow.timeoutMs ?? 60_000, flow.name)
      await l.page.waitForTimeout(250)
      const fresh = l.errors.slice(errorsBefore).filter((e) => !(flow.allowErrors ?? []).some((r) => r.test(e.text)))
      const mainAll = await mainErrors(l.app)
      const mainFresh = mainAll.slice(mainBefore)
      l.seen = { errors: l.errors.length, main: mainAll.length }
      for (const m of mainFresh) fresh.push({ source: 'main', text: m, at: Date.now(), flow: flow.name })
      result.errors = fresh
      if (fresh.length) throw new Error(`${fresh.length} console / uncaught error(s): ${fresh[0].text.split('\n')[0].slice(0, 300)}`)
    } catch (e) {
      if (l && !l.page.isClosed()) {
        const mainAll = await mainErrors(l.app).catch(() => [] as string[])
        const fresh = l.errors.slice(l.seen.errors)
        if (fresh.length || mainAll.length > l.seen.main) {
          result.errors = [...fresh, ...mainAll.slice(l.seen.main).map((text) => ({ source: 'main' as const, text, at: Date.now(), flow: flow.name }))]
        }
        l.seen = { errors: l.errors.length, main: mainAll.length }
      }
      if (e instanceof SkipFlow) {
        result.status = 'skip'
        result.notes.push(e.message)
        continue
      }
      result.status = 'fail'
      result.error = (e as Error).message.split('\n').slice(0, 6).join('\n')
      try {
        if (l && !l.page.isClosed()) {
          result.screenshot = join(OUT, `fail-${flow.name}.png`)
          await l.page.screenshot({ path: result.screenshot })
          // Leave the app in a neutral state for the next flow.
          await l.page.keyboard.press('Escape').catch(() => undefined)
        }
      } catch {
        // window gone
      }
    } finally {
      if (l) l.currentFlow.name = undefined
      result.ms = Date.now() - started
      console.log(`- ${flow.name}: ${result.status}${result.error ? ` — ${result.error.split('\n')[0]}` : ''} (${result.ms} ms)`)
    }
  }

  const final = launched as Launched | null
  if (final) {
    writeFileSync(join(OUT, 'main.log'), [...mainLogs, ...final.mainLog].join('\n'))
    // The app's own log panel (services, harness, agent), for spotting noisy services.
    const logs = await final.page.evaluate(() => window.harness.getLogs()).catch(() => [])
    writeFileSync(join(OUT, 'app-logs.json'), JSON.stringify(logs, null, 1))
    await final.app.close().catch(() => undefined)
  }
  await fake.close()
  writeFileSync(join(OUT, 'fake-provider-requests.json'), JSON.stringify(fake.requests.map((r) => ({ rule: r.rule, model: r.model, tools: r.tools, user: r.user.slice(0, 200) })), null, 2))
  const summary = {
    at: new Date().toISOString(),
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    skipped: results.filter((r) => r.status === 'skip').length,
    results
  }
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2))
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const md = [
    `| flow | result | notes |`,
    `| --- | --- | --- |`,
    ...results.map((r) => `| ${r.flow} | ${r.status} | ${cell([r.error, ...r.notes].filter(Boolean).join('; '))} |`)
  ].join('\n')
  writeFileSync(join(OUT, 'summary.md'), md + '\n')
  console.log(`\n${md}\n\n${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped. Output: ${OUT}`)
  if (!arg('keep')) rmSync(sandbox.home, { recursive: true, force: true })
  process.exitCode = summary.failed ? 1 : 0
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 2
})
