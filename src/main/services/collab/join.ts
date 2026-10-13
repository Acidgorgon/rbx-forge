import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { spawnTool } from '../tools.ts'
import { collabEnv, gitBinary, locate, type CollabDeps } from './git.ts'

// "Join a teammate's game": clone, install pinned tools (rokit) and packages (wally), check the
// Rojo project. Never runs ./dev: in a clone it would delete .git (the template's first-run step).

export type JoinStepId = 'clone' | 'rokit' | 'wally' | 'validate'

export interface JoinProgress {
  step: JoinStepId
  state: 'running' | 'done' | 'skipped' | 'failed'
  // A line of tool output, or a human note.
  message?: string
  // 0–100 when the tool reports it (git clone does).
  percent?: number
}

export interface JoinStepResult {
  step: JoinStepId
  state: 'done' | 'skipped' | 'failed'
  note?: string
}

export interface JoinInput {
  repoUrl: string
  parentDir: string
  name?: string
}

export interface JoinOptions extends CollabDeps {
  onProgress?: (progress: JoinProgress) => void
  // Pass --no-trust-check to rokit. rokit asks on a terminal before installing a tool it has not
  // seen; Forge has no terminal, so the UI should ask the person and set this when they agree.
  trustTools?: boolean
  // Per-command timeout (default 10 minutes).
  timeoutMs?: number
}

export interface JoinResult {
  root: string
  projectName: string
  steps: JoinStepResult[]
  // Things the person should know (skipped installs, validation warnings).
  notes: string[]
}

export function repoNameFromUrl(url: string): string {
  const cleaned = url.trim().replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
  const last = cleaned.split(/[/:\\]/).filter(Boolean).pop() || 'game'
  return last.replace(/[^A-Za-z0-9._-]/g, '-') || 'game'
}

function streamCommand(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  onLine: (line: string) => void,
  timeoutMs: number
): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise) => {
    let output = ''
    let pending = ''
    const child = spawnTool(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    const feed = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      output += text
      if (output.length > 200_000) output = output.slice(-100_000)
      pending += text
      // git progress rewrites lines with \r.
      const parts = pending.split(/\r\n|\r|\n/)
      pending = parts.pop() ?? ''
      for (const part of parts) if (part.trim()) onLine(part.trim())
    }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ code: 127, output: output + String(error.message) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (pending.trim()) onLine(pending.trim())
      resolvePromise({ code: code ?? 1, output })
    })
  })
}

function lastLine(output: string): string {
  const lines = output.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean)
  return lines.find((l) => /^(error|fatal)/i.test(l)) || lines[lines.length - 1] || ''
}

export interface ProjectValidation {
  ok: boolean
  name?: string
  problems: string[]
  warnings: string[]
}

// Checks default.project.json parses, has a tree, and its $path folders exist (Packages excepted
// until wally install has run).
export async function validateRojoProject(root: string): Promise<ProjectValidation> {
  const result: ProjectValidation = { ok: false, problems: [], warnings: [] }
  let json: any
  try {
    json = JSON.parse(await readFile(join(root, 'default.project.json'), 'utf8'))
  } catch (error) {
    result.problems.push(
      existsSync(join(root, 'default.project.json'))
        ? `default.project.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        : 'No default.project.json: this does not look like a Rojo game.'
    )
    return result
  }
  if (!json || typeof json !== 'object' || !json.tree || typeof json.tree !== 'object') {
    result.problems.push('default.project.json has no "tree".')
    return result
  }
  result.name = typeof json.name === 'string' ? json.name : undefined
  const walk = (node: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$path' && typeof value === 'string') {
        if (!existsSync(join(root, value)) && !/(^|\/)(Server)?Packages$/.test(value)) {
          result.warnings.push(`Rojo folder ${value} does not exist yet.`)
        }
      } else if (value && typeof value === 'object' && !key.startsWith('$')) {
        walk(value as Record<string, unknown>)
      }
    }
  }
  walk(json.tree)
  result.ok = true
  return result
}

export async function joinProject(input: JoinInput, options: JoinOptions = {}): Promise<JoinResult> {
  const progress = options.onProgress || (() => {})
  const timeout = options.timeoutMs ?? 10 * 60 * 1000
  const env = collabEnv(options)
  if (!input.repoUrl.trim()) throw new Error('Paste the game repository URL.')
  const name = (input.name?.trim() || repoNameFromUrl(input.repoUrl)).replace(/[\\/]/g, '-')
  const parent = resolve(input.parentDir)
  const root = join(parent, name)
  if (existsSync(root) && readdirSync(root).length > 0) throw new Error(`${root} already exists and is not empty.`)
  await mkdir(parent, { recursive: true })

  const steps: JoinStepResult[] = []
  const notes: string[] = []

  // 1. clone
  progress({ step: 'clone', state: 'running', message: `Cloning into ${root}` })
  const cloned = await streamCommand(
    gitBinary(options),
    ['clone', '--progress', input.repoUrl.trim(), root],
    parent,
    env,
    (line) => {
      const percent = /(\d{1,3})%/.exec(line)
      progress({ step: 'clone', state: 'running', message: line, ...(percent ? { percent: Number(percent[1]) } : {}) })
    },
    timeout
  )
  if (cloned.code !== 0) {
    const note = lastLine(cloned.output) || 'git clone failed'
    progress({ step: 'clone', state: 'failed', message: note })
    throw new Error(/Authentication|could not read Username|Permission denied/i.test(note)
      ? `${note}. Check you have access to the repository and are signed in to git.`
      : note)
  }
  steps.push({ step: 'clone', state: 'done' })
  progress({ step: 'clone', state: 'done' })

  // 2. rokit install
  if (existsSync(join(root, 'rokit.toml'))) {
    const rokit = locate('rokit', options)
    if (!rokit) {
      const note = 'rokit is not installed, so the pinned tools (rojo, wally, blink…) were not installed. Install rokit, then run "rokit install" in the game folder.'
      steps.push({ step: 'rokit', state: 'skipped', note })
      notes.push(note)
      progress({ step: 'rokit', state: 'skipped', message: note })
    } else {
      progress({ step: 'rokit', state: 'running', message: 'rokit install' })
      const args = ['install', ...(options.trustTools ? ['--no-trust-check'] : [])]
      const out = await streamCommand(rokit, args, root, env, (line) => progress({ step: 'rokit', state: 'running', message: line }), timeout)
      if (out.code === 0) {
        steps.push({ step: 'rokit', state: 'done' })
        progress({ step: 'rokit', state: 'done' })
      } else {
        const note = options.trustTools
          ? `rokit install failed: ${lastLine(out.output)}`
          : `rokit install needs you to trust the game's tools. Allow it in Forge, or run "rokit install" in a terminal. (${lastLine(out.output)})`
        steps.push({ step: 'rokit', state: 'failed', note })
        notes.push(note)
        progress({ step: 'rokit', state: 'failed', message: note })
      }
    }
  } else {
    steps.push({ step: 'rokit', state: 'skipped', note: 'No rokit.toml.' })
    progress({ step: 'rokit', state: 'skipped', message: 'No rokit.toml.' })
  }

  // 3. wally install (looked up after rokit so a freshly installed shim is found)
  if (existsSync(join(root, 'wally.toml'))) {
    const wally = locate('wally', options)
    if (!wally) {
      const note = 'wally is not installed, so Packages/ is missing. After rokit install, run "wally install".'
      steps.push({ step: 'wally', state: 'skipped', note })
      notes.push(note)
      progress({ step: 'wally', state: 'skipped', message: note })
    } else {
      progress({ step: 'wally', state: 'running', message: 'wally install' })
      const out = await streamCommand(wally, ['install'], root, env, (line) => progress({ step: 'wally', state: 'running', message: line }), timeout)
      if (out.code === 0) {
        steps.push({ step: 'wally', state: 'done' })
        progress({ step: 'wally', state: 'done' })
      } else {
        const note = `wally install failed: ${lastLine(out.output)}`
        steps.push({ step: 'wally', state: 'failed', note })
        notes.push(note)
        progress({ step: 'wally', state: 'failed', message: note })
      }
    }
  } else {
    steps.push({ step: 'wally', state: 'skipped', note: 'No wally.toml.' })
    progress({ step: 'wally', state: 'skipped', message: 'No wally.toml.' })
  }

  // 4. validate
  progress({ step: 'validate', state: 'running', message: 'Checking default.project.json' })
  const validation = await validateRojoProject(root)
  notes.push(...validation.warnings)
  if (!validation.ok) {
    steps.push({ step: 'validate', state: 'failed', note: validation.problems.join(' ') })
    notes.push(...validation.problems)
    progress({ step: 'validate', state: 'failed', message: validation.problems.join(' ') })
  } else {
    steps.push({ step: 'validate', state: 'done' })
    progress({ step: 'validate', state: 'done' })
  }
  return { root, projectName: validation.name || basename(root), steps, notes }
}
