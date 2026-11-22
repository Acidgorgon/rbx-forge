// Harbor Family Stack service (Current, Ripple, Anchor, Tide, Lighthouse).
// Handles project detection, lossless LibsConfig.luau toggling, schema codegen, scaffolding, and
// debounced schema watchers with clean disposal (persistent: false + close()). No electron imports.

import { watch, existsSync, type FSWatcher } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  HarborGenerateResult,
  HarborLibId,
  HarborScaffoldResult,
  HarborStatus
} from '../../../shared/harborTypes.ts'
import { blinkCommands } from '../../../shared/blink/compiler.ts'
import { parseRokitToml, aliasPath, rokitPaths } from '../setup/toolchain.ts'
import { defaultContext, findTool, run, toolEnv, type ToolContext } from '../tools.ts'
import { detectHarborProject } from './detect.ts'
import { findLibsConfigFile, writeLibsConfigToggle } from './libsConfig.ts'

export interface HarborServiceDeps {
  emit?: (event: 'harbor:status' | 'harbor:generated', payload: unknown) => void
  log?: (text: string, stream?: 'stdout' | 'stderr' | 'info') => void
  toolCtx?: ToolContext
  debounceMs?: number
  watch?: boolean
  autoGenerateOnChange?: boolean
  onWatchChange?: (files: string[]) => void | Promise<void>
}

const STARTER_LIBS_CONFIG = `-- Shared Harbor Library configuration
return {
\tUseCurrent = true,
\tUseRipple = true,
\tUseAnchor = true,
\tUseTide = true,
\tUseLighthouse = true,
}
`

const STARTER_CURRENT_SCHEMA = `-- Current networking schema
option Casing = "Camel"
option ClientOutput = "src/shared/events/client.luau"
option ServerOutput = "src/shared/events/server.luau"
`

const STARTER_RIPPLE_SCHEMA = `-- Ripple ECS / Sync schema starter
-- Define synced components and messages here.
`

export class HarborService {
  private deps: HarborServiceDeps
  private root: string | null = null
  private watchers: FSWatcher[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private changedFiles = new Set<string>()
  private lastGenerate: HarborStatus['lastGenerate']
  private closed = false
  private debounceMs: number

  constructor(deps: HarborServiceDeps = {}) {
    this.deps = deps
    this.debounceMs = deps.debounceMs ?? 250
  }

  private ctx(): ToolContext {
    return this.deps.toolCtx ?? defaultContext()
  }

  setProject(root: string | null): HarborStatus {
    this.root = root
    this.stopWatchers()
    if (!this.closed && root && this.deps.watch !== false) {
      this.startWatchers(root)
    }
    return this.refresh()
  }

  status(): HarborStatus {
    return detectHarborProject(this.root, {
      toolCtx: this.ctx(),
      watcherActive: this.watchers.length > 0,
      lastGenerate: this.lastGenerate
    })
  }

  refresh(): HarborStatus {
    const st = this.status()
    this.deps.emit?.('harbor:status', st)
    return st
  }

  async toggleLib(key: string, enabled: boolean): Promise<HarborStatus> {
    if (!this.root) throw new Error('No project open')
    const rel = findLibsConfigFile(this.root)
    if (!rel) throw new Error('LibsConfig.luau not found in project (scaffold or create src/shared/Modules/LibsConfig.luau)')
    const abs = join(this.root, ...rel.split('/'))
    await writeLibsConfigToggle(abs, key, enabled)
    this.deps.log?.(`Updated ${rel}: ${key} = ${enabled}`, 'info')
    return this.refresh()
  }

  private async resolveCurrentCompiler(root: string): Promise<{ cmd: string; name: string } | null> {
    const rokitText = await readFile(join(root, 'rokit.toml'), 'utf8').catch(() => '')
    const pinned = parseRokitToml(rokitText)
    const order = blinkCommands(pinned.keys())
    const ctx = this.ctx()
    const rokitBinDir = rokitPaths(ctx).bin.toLowerCase().replace(/[\\/]+$/, '')

    for (const cmd of order) {
      if (pinned.has(cmd)) {
        const shim = aliasPath(ctx, cmd)
        if (existsSync(shim)) return { cmd: shim, name: cmd }
        const onPath = findTool(cmd, ctx)
        if (onPath) return { cmd: onPath, name: cmd }
      } else {
        const onPath = findTool(cmd, ctx, {
          skipDir: (d) => d.toLowerCase().replace(/[\\/]+$/, '') === rokitBinDir
        })
        if (onPath) return { cmd: onPath, name: cmd }
        const shim = aliasPath(ctx, cmd)
        if (existsSync(shim)) return { cmd: shim, name: cmd }
      }
    }
    return null
  }

  async generate(lib: HarborLibId): Promise<HarborGenerateResult> {
    if (!this.root) {
      return { ok: false, lib, code: 1, output: 'No project open' }
    }
    const root = this.root
    const st = this.status()
    const info = st.libs[lib]
    const ctx = this.ctx()

    let res: HarborGenerateResult
    if (lib === 'current') {
      const compiler = await this.resolveCurrentCompiler(root)
      const schema =
        info.schemaFiles.find((f) => f.endsWith('.blink')) ??
        info.schemaFiles.find((f) => f === 'tools/current-schema.luau' || f === 'tools/current-schema.lua') ??
        info.schemaFiles[0]
      if (!schema) {
        res = { ok: false, lib, code: 1, output: 'No Current/Blink schema found (expected tools/current-schema.luau or *.blink)' }
      } else if (!compiler) {
        res = { ok: false, lib, code: 1, output: 'Neither `current` nor `blink` CLI was found in ~/.rokit/bin or PATH' }
      } else {
        const schemaAbs = join(root, ...schema.split('/'))
        const out = await run(compiler.cmd, [schemaAbs, '--yes'], root, toolEnv(ctx))
        const combined = [out.stdout, out.stderr].filter(Boolean).join('\n').trim()
        res = {
          ok: out.code === 0,
          lib,
          code: out.code,
          output: combined || (out.code === 0 ? `Generated outputs via ${compiler.name} (${schema})` : `Failed with exit code ${out.code}`),
          ranCli: compiler.name
        }
      }
    } else if (lib === 'ripple') {
      const cli = info.cliPath ?? findTool('ripple', ctx)
      if (cli && info.schemaFiles.length > 0) {
        const out = await run(cli, [join(root, ...info.schemaFiles[0].split('/'))], root, toolEnv(ctx))
        const combined = [out.stdout, out.stderr].filter(Boolean).join('\n').trim()
        res = {
          ok: out.code === 0,
          lib,
          code: out.code,
          output: combined || `Ran ripple on ${info.schemaFiles[0]}`,
          ranCli: 'ripple'
        }
      } else if (info.detected) {
        res = {
          ok: true,
          lib,
          code: 0,
          output: info.schemaFiles.length
            ? `Ripple detected with ${info.schemaFiles.length} schema file(s) (${info.schemaFiles.join(', ')}); vendored Luau runtime requires no external CLI binary.`
            : 'Ripple detected as vendored Luau runtime; no external CLI codegen step required.'
        }
      } else {
        res = { ok: false, lib, code: 1, output: 'Ripple not detected in project' }
      }
    } else {
      // anchor, tide, lighthouse: run optional CLI if installed, otherwise report runtime library status.
      const cli = info.cliPath ?? findTool(lib, ctx)
      if (cli) {
        const out = await run(cli, ['generate'], root, toolEnv(ctx))
        const combined = [out.stdout, out.stderr].filter(Boolean).join('\n').trim()
        res = { ok: out.code === 0, lib, code: out.code, output: combined || `Ran ${lib} generate`, ranCli: lib }
      } else if (info.detected) {
        res = {
          ok: true,
          lib,
          code: 0,
          output: `${info.name} detected (${info.sourcePaths.join(', ') || 'config/manifest'}); pure Luau library needs no external codegen.`
        }
      } else {
        res = { ok: false, lib, code: 1, output: `${info.name} not detected in project` }
      }
    }

    this.lastGenerate = { lib, at: Date.now(), ok: res.ok, output: res.output }
    this.deps.log?.(`[${lib}] ${res.output}`, res.ok ? 'info' : 'stderr')
    this.deps.emit?.('harbor:generated', res)
    this.refresh()
    return res
  }

  async scaffold(lib: HarborLibId): Promise<HarborScaffoldResult> {
    if (!this.root) throw new Error('No project open')
    const root = this.root
    const created: string[] = []

    const ensureFile = async (rel: string, content: string) => {
      const abs = join(root, ...rel.split('/'))
      if (existsSync(abs)) return
      await mkdir(resolve(abs, '..'), { recursive: true })
      await writeFile(abs, content, 'utf8')
      created.push(rel)
    }

    if (!findLibsConfigFile(root)) {
      await ensureFile('src/shared/Modules/LibsConfig.luau', STARTER_LIBS_CONFIG)
    }

    if (lib === 'current') {
      await ensureFile('tools/current-schema.luau', STARTER_CURRENT_SCHEMA)
    } else if (lib === 'ripple') {
      await ensureFile('src/shared/Ripple/init.ripple', STARTER_RIPPLE_SCHEMA)
    } else {
      const cap = lib.charAt(0).toUpperCase() + lib.slice(1)
      await ensureFile(`src/shared/${cap}/init.luau`, `--!strict\n-- ${cap} (Harbor Family Stack)\nlocal ${cap} = {}\nreturn ${cap}\n`)
    }

    this.refresh()
    return {
      ok: true,
      lib,
      created,
      message: created.length ? `Created ${created.join(', ')}` : `${lib} files already present (nothing overwritten)`
    }
  }

  private startWatchers(root: string): void {
    const targets = [root]
    for (const dir of targets) {
      if (!existsSync(dir)) continue
      try {
        const w = watch(
          dir,
          { recursive: process.platform === 'win32' || process.platform === 'darwin', persistent: false },
          (_ev, filename) => {
            const rel = typeof filename === 'string' ? filename.replace(/\\/g, '/') : ''
            if (!rel || rel.startsWith('.git/') || rel.startsWith('.forge/') || rel.startsWith('node_modules/')) return
            if (
              rel === 'rokit.toml' ||
              rel === 'wally.toml' ||
              rel === 'tools/current-schema.luau' ||
              rel === 'tools/current-schema.lua' ||
              rel.endsWith('.blink') ||
              rel.endsWith('.ripple') ||
              /LibsConfig\.luau?$/i.test(rel)
            ) {
              this.changedFiles.add(rel)
              this.scheduleWatchFlush()
            }
          }
        )
        ;(w as { unref?: () => void }).unref?.()
        w.on('error', () => undefined)
        this.watchers.push(w)
      } catch {
        // Ignore unwatchable directory
      }
    }
  }

  private scheduleWatchFlush(): void {
    if (this.closed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.closed) return
      const files = [...this.changedFiles]
      this.changedFiles.clear()
      void this.handleWatchFlush(files)
    }, this.debounceMs)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  private async handleWatchFlush(files: string[]): Promise<void> {
    if (this.closed) return
    this.refresh()
    await this.deps.onWatchChange?.(files)
    if (this.deps.autoGenerateOnChange) {
      if (files.some((f) => f === 'tools/current-schema.luau' || f === 'tools/current-schema.lua' || f.endsWith('.blink'))) {
        await this.generate('current').catch(() => undefined)
      }
      if (files.some((f) => f.endsWith('.ripple'))) {
        await this.generate('ripple').catch(() => undefined)
      }
    }
  }

  private stopWatchers(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.changedFiles.clear()
    for (const w of this.watchers) w.close()
    this.watchers = []
  }

  close(): void {
    this.closed = true
    this.stopWatchers()
  }

  dispose(): void {
    this.close()
  }
}
