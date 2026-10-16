// Model Lab assets (BlockyKit, the preview sandbox, the template scripts) and the Lune run of a build
// script: `lune run model_build.luau <BlockyKit.luau> <build.luau> <name>` prints one JSON line with
// every recorded part (shared/model/checks.ts parseBuildOutput). No electron imports.

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseBuildOutput } from '../../../shared/model/checks.ts'
import type { ModelBuild, ModelTemplateId } from '../../../shared/model/types.ts'
import { runtimeDirCandidates } from '../tests/lune.ts'
import { runWithTimeout, type LuneRun } from '../vfx/lune.ts'

export const KIT_FILE = 'BlockyKit.luau'
export const SANDBOX_FILE = 'model_build.luau'
export const TEMPLATE_DIR = 'model_templates'
export const BUNDLED_MODEL_DIR = 'model'
export const BUILD_TIMEOUT_MS = 20_000

export interface ModelAssets {
  dir: string
  kit: string
  sandbox: string
  templates: string
}

// Best first: next to the main bundle (out/main/model, emitted by electron.vite.config.ts so a quick
// update ships kit fixes), then the Lune runtime folder (packaged resources/lune, or the repo copy).
export function modelAssetCandidates(here: string = import.meta.dirname ?? process.cwd()): string[] {
  return [join(here, BUNDLED_MODEL_DIR), ...runtimeDirCandidates(), resolve(process.cwd(), 'resources', 'lune')]
}

export function findModelAssets(candidates: string[] = modelAssetCandidates()): ModelAssets | null {
  for (const dir of candidates) {
    if (existsSync(join(dir, KIT_FILE)) && existsSync(join(dir, SANDBOX_FILE))) return { dir, kit: join(dir, KIT_FILE), sandbox: join(dir, SANDBOX_FILE), templates: join(dir, TEMPLATE_DIR) }
  }
  return null
}

export function readKit(assets: ModelAssets): Promise<string> {
  return readFile(assets.kit, 'utf8')
}

export function readTemplate(assets: ModelAssets, id: ModelTemplateId): Promise<string> {
  return readFile(join(assets.templates, `${id}.luau`), 'utf8')
}

export async function luneModelBuild(script: string, opts: { lune: string; assets: ModelAssets; name?: string; run?: LuneRun; timeoutMs?: number }): Promise<ModelBuild> {
  const tmp = await mkdtemp(join(tmpdir(), 'forge-model-'))
  const file = join(tmp, 'build.luau')
  const limit = opts.timeoutMs ?? BUILD_TIMEOUT_MS
  const started = Date.now()
  try {
    await writeFile(file, String(script ?? ''), 'utf8')
    const args = ['run', opts.assets.sandbox, opts.assets.kit, file, (opts.name || 'BlockModel').slice(0, 80)]
    const res = opts.run ? { ...(await opts.run(opts.lune, args, opts.assets.dir)), timedOut: false } : await runWithTimeout(opts.lune, args, opts.assets.dir, limit)
    if (res.timedOut) return { ok: false, parts: [], prints: [], warnings: [], error: { message: `the build ran for more than ${Math.round(limit / 1000)} s (an endless loop?)` } }
    return { ...parseBuildOutput(res.stdout, res.stderr, res.code), ms: Date.now() - started }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}
