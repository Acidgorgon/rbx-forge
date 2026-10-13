import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findTool, run, type RunResult } from '../tools.ts'
import type { ModeDetection, PublishConfig, ReleaseMode, RojoBuildSummary } from './types.ts'

// Rojo-managed publishing and the safety analysis around it.
//
// A place built with `rojo build` contains ONLY what the project file maps. Publishing it replaces the
// live place, so in a GenTree game (code folders marked $ignoreUnknownInstances, maps/models/GUIs living
// only in the Studio place) it would wipe every Studio-only asset. Forge therefore publishes a Rojo
// build only when the project opts in (.forge/project.json publish.mode = "rojo") or the project file
// is detected as fully managed, and even then the run needs a confirm token from the plan.

export const DEFAULT_ROJO_PROJECT = 'default.project.json'

// Services a playable place normally has content in. A fully managed project maps Workspace at least.
const CONTENT_SERVICES = ['Workspace', 'Lighting', 'StarterGui', 'ReplicatedStorage', 'ServerStorage', 'ServerScriptService', 'StarterPlayer', 'StarterPack', 'SoundService', 'Teams']

type TreeNode = Record<string, unknown>

function isNode(value: unknown): value is TreeNode {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

interface Walked {
  mappings: string[]
  ignoreUnknown: string[]
  services: string[]
}

function walk(node: TreeNode, path: string[], out: Walked): void {
  if (typeof node.$path === 'string' || (isNode(node.$path) && typeof (node.$path as TreeNode).optional === 'string')) {
    const source = typeof node.$path === 'string' ? node.$path : String((node.$path as TreeNode).optional)
    out.mappings.push(`${path.join('.') || 'DataModel'} <- ${source}`)
  }
  if (node.$ignoreUnknownInstances === true) out.ignoreUnknown.push(path.join('.') || 'DataModel')
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('$') || !isNode(child)) continue
    if (path.length === 0) out.services.push(key)
    walk(child, [...path, key], out)
  }
}

export function summarizeRojoProject(project: { name?: string; tree?: unknown }, projectFile = DEFAULT_ROJO_PROJECT): RojoBuildSummary & { ignoreUnknown: string[] } {
  const out: Walked = { mappings: [], ignoreUnknown: [], services: [] }
  if (isNode(project.tree)) walk(project.tree, [], out)
  const warnings: string[] = []
  const missing = CONTENT_SERVICES.filter((s) => !out.services.includes(s))
  if (out.ignoreUnknown.length) {
    warnings.push(
      `${out.ignoreUnknown.join(', ')} ${out.ignoreUnknown.length === 1 ? 'is' : 'are'} marked $ignoreUnknownInstances: the live place keeps content there that Rojo does not know about. A Rojo build will NOT include it, so publishing replaces it with nothing.`
    )
  }
  if (!out.services.includes('Workspace')) warnings.push('Workspace is not in the project: the published place will have an empty Workspace (no map, no spawn).')
  if (missing.length) warnings.push(`Not managed by Rojo (published empty or default): ${missing.join(', ')}.`)
  warnings.push('Anything made only in Studio (maps, models, GUIs, lighting, terrain, packages inserted in Studio) is lost in the published version.')
  return { project: projectFile, contains: out.mappings, services: out.services, warnings, ignoreUnknown: out.ignoreUnknown }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

// Fully managed = the project maps Workspace, nothing uses $ignoreUnknownInstances, and the Studio
// script sync (tools/studio-sync.json) is not set up. Anything less defaults to Studio publishing.
export async function detectMode(root: string, publish: PublishConfig | undefined): Promise<ModeDetection> {
  const projectFile = publish?.rojoProject || DEFAULT_ROJO_PROJECT
  const project = await readJson(join(root, projectFile))
  const reasons: string[] = []
  let fullyManaged = false
  if (!isNode(project)) {
    reasons.push(`No readable ${projectFile}.`)
  } else {
    const summary = summarizeRojoProject(project as { tree?: unknown }, projectFile)
    const studioSync = await readJson(join(root, 'tools', 'studio-sync.json'))
    if (summary.ignoreUnknown.length) reasons.push(`$ignoreUnknownInstances on ${summary.ignoreUnknown.join(', ')}: the place has content Rojo does not manage.`)
    if (!summary.services.includes('Workspace')) reasons.push('Workspace is not mapped by Rojo: the map lives in the Studio place.')
    if (studioSync !== undefined) reasons.push('tools/studio-sync.json is present: scripts are edited in Studio too.')
    fullyManaged = reasons.length === 0
    if (fullyManaged) reasons.push(`${projectFile} maps Workspace and nothing keeps unknown instances: the Rojo build is the whole place.`)
  }
  const optIn = publish?.mode
  let mode: ReleaseMode
  let source: ModeDetection['source']
  if (optIn) {
    mode = optIn
    source = 'project'
  } else if (fullyManaged) {
    mode = 'rojo'
    source = 'detected'
  } else {
    mode = 'studio'
    source = 'default'
  }
  return { mode, source, fullyManaged, reasons }
}

export async function loadRojoSummary(root: string, projectFile = DEFAULT_ROJO_PROJECT): Promise<RojoBuildSummary> {
  const project = await readJson(join(root, projectFile))
  if (!isNode(project)) throw new Error(`Cannot read ${projectFile}`)
  const { ignoreUnknown: _ignored, ...summary } = summarizeRojoProject(project as { tree?: unknown }, projectFile)
  return summary
}

export interface RojoBuildOptions {
  projectFile?: string
  rojo?: string | null
  runner?: (file: string, args: string[], cwd: string) => Promise<RunResult>
}

// rojo build <project> -o <out>. cwd is the project root so rokit's shim uses the pinned version.
export async function rojoBuild(root: string, outFile: string, options: RojoBuildOptions = {}): Promise<void> {
  const binary = options.rojo === undefined ? findTool('rojo') : options.rojo
  if (!binary) throw new Error('rojo not found. Run rokit install.')
  const runner = options.runner ?? ((file, args, cwd) => run(file, args, cwd))
  const result = await runner(binary, ['build', options.projectFile || DEFAULT_ROJO_PROJECT, '-o', outFile], root)
  if (result.code !== 0) throw new Error(`rojo build failed: ${(result.stderr || result.stdout).trim().split(/\r?\n/).slice(-5).join('\n')}`)
}
