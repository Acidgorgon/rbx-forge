// Browser-preview mock of the toolchain setup and the New project flow (SetupApi). mock.ts spreads
// it into its api object. ?toolchain=fresh in the URL starts with nothing installed (the first-run
// screen shows); ?toolchain=offline also makes one download fail, to show the retry path.
import type { HarnessApi, HarnessEvents, NewProjectProgress, NewProjectStepId, SetupProgress, ToolStatus, ToolchainStatus } from '@shared/types'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

const PINS: [string, string, string, string][] = [
  ['rojo', 'rojo-rbx/rojo', '7.7.0', 'Syncs files into Studio'],
  ['wally', 'UpliftGames/wally', '0.3.2', 'Package manager'],
  ['blink', '1Axen/blink', '0.18.1', 'Network event compiler'],
  ['lune', 'lune-org/lune', '0.11.0', 'Runs Luau tests'],
  ['luau-lsp', 'JohnnyMorganz/luau-lsp', '1.69.0', 'Editor language server'],
  ['selene', 'Kampfkarren/selene', '0.32.0', 'Linter'],
  ['stylua', 'JohnnyMorganz/StyLua', '2.5.2', 'Formatter'],
  ['wally-package-types', 'JohnnyMorganz/wally-package-types', '1.6.2', 'Types for Wally packages']
]

export function setupMock(emit: Emit, log: (text: string) => void): Pick<
  HarnessApi,
  'toolchainStatus' | 'toolchainSetup' | 'toolchainCancel' | 'toolchainSkip' | 'newProjectDefaults' | 'chooseFolder' | 'createProject'
> {
  const query = new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get('toolchain')
  const fresh = query === 'fresh' || query === 'offline'
  let offline = query === 'offline'
  let rokit = !fresh
  let record: ToolchainStatus['record'] = fresh ? 'never' : 'done'
  const tools: ToolStatus[] = PINS.map(([alias, id, pinned, purpose]) => ({
    alias,
    id,
    pinned,
    purpose,
    version: fresh ? null : pinned,
    state: fresh ? 'missing' : 'ok',
    path: fresh ? null : `/Users/you/.rokit/bin/${alias}`
  }))
  let cancel = false

  const status = (): ToolchainStatus => ({
    platform: 'darwin',
    rokit: { installed: rokit, path: rokit ? '/Users/you/.rokit/bin/rokit' : null, version: rokit ? '1.2.0' : null, bundled: true, bundledVersion: '1.2.0', binDir: '/Users/you/.rokit/bin' },
    tools: tools.map((t) => ({ ...t })),
    git: { available: true, path: '/usr/bin/git', version: '2.50.1' },
    needsSetup: !rokit || tools.some((t) => t.state === 'missing' || t.state === 'broken'),
    record
  })

  return {
    async toolchainStatus() {
      await delay(120)
      return status()
    },
    async toolchainSetup(options) {
      const mode = options?.mode ?? 'install'
      cancel = false
      const steps: { step: string; state: 'done' | 'skipped' | 'failed'; message?: string }[] = []
      const send = (p: SetupProgress) => {
        emit('toolchain:progress', p)
        if (p.state !== 'running') steps.push({ step: p.step, state: p.state, message: p.message })
      }
      send({ step: 'rokit', state: 'running', message: 'rokit 1.2.0 self-install' })
      await delay(700)
      rokit = true
      send({ step: 'rokit', state: 'done', message: 'rokit 1.2.0 in /Users/you/.rokit/bin' })
      let network = false
      for (const t of tools.filter((x) => !options?.tools || options.tools.includes(x.alias))) {
        if (cancel) {
          send({ step: t.alias, state: 'skipped', message: 'Cancelled' })
          continue
        }
        if (mode === 'install' && t.state === 'ok') {
          send({ step: t.alias, state: 'skipped', message: `${t.version} already installed` })
          continue
        }
        send({ step: t.alias, state: 'running', message: `Fetching ${t.id}@${t.pinned}` })
        await delay(350)
        send({ step: t.alias, state: 'running', message: 'Installing' })
        await delay(350)
        if (offline && t.alias === 'lune') {
          offline = false
          network = true
          send({ step: t.alias, state: 'failed', message: 'Could not reach GitHub to download the tool. Check your internet connection or proxy, then press Retry.' })
          continue
        }
        t.state = 'ok'
        t.version = mode === 'update' ? t.pinned.replace(/\d+$/, (n) => String(Number(n) + 1)) : t.pinned
        if (mode === 'update') t.state = 'other'
        t.path = `/Users/you/.rokit/bin/${t.alias}`
        send({ step: t.alias, state: 'done', message: `${t.version} installed` })
      }
      const ok = steps.every((s) => s.state !== 'failed')
      if (ok && !options?.tools) record = 'done'
      log(`toolchain: ${mode} ${ok ? 'finished' : 'finished with errors'}`)
      return { ok, cancelled: cancel, network, steps }
    },
    async toolchainCancel() {
      cancel = true
    },
    async toolchainSkip() {
      cancel = true
      record = 'skipped'
    },
    async newProjectDefaults() {
      return { parentDir: '/Users/you/Roblox', gitAvailable: true }
    },
    async chooseFolder() {
      await delay(150)
      return '/Users/you/Games'
    },
    async createProject(input) {
      const root = `${input.parentDir.replace(/\/+$/, '')}/${input.name}`
      const steps: { step: NewProjectStepId; state: 'done' | 'skipped' | 'failed'; note?: string }[] = []
      const send = (p: NewProjectProgress) => {
        emit('newProject:progress', p)
        if (p.state !== 'running') steps.push({ step: p.step, state: p.state, note: p.message })
      }
      if (input.template === 'gentree') {
        for (const pct of [12, 47, 88, 100]) {
          send({ step: 'fetch', state: 'running', message: `Receiving objects: ${pct}%`, percent: pct })
          await delay(220)
        }
      }
      send({ step: 'fetch', state: 'done' })
      send({ step: 'prepare', state: 'running', message: 'Removing the template .git' })
      await delay(200)
      send({ step: 'prepare', state: 'done' })
      send({ step: 'rename', state: 'done', message: 'Updated default.project.json, wally.toml, README.md' })
      if (input.initGit) {
        send({ step: 'git', state: 'running', message: 'git init' })
        await delay(300)
        send({ step: 'git', state: 'done', message: input.remoteUrl ? `origin = ${input.remoteUrl}` : 'Initial commit on main' })
      } else send({ step: 'git', state: 'skipped', message: 'Git was not set up.' })
      for (const step of ['rokit', 'wally', 'blink'] as const) {
        if (!input.firstSetup || (input.template === 'empty' && step !== 'rokit')) {
          send({ step, state: 'skipped' })
          continue
        }
        send({ step, state: 'running', message: step === 'blink' ? 'blink events.blink' : `${step} install` })
        await delay(500)
        send({ step, state: 'done' })
      }
      log(`new project: ${root}`)
      return { root, projectName: input.name, via: input.template === 'gentree' ? 'git' : 'generated', steps, notes: [] }
    }
  }
}
