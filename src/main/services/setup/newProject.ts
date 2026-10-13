import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { findTool, toolEnv } from '../tools.ts'
import { errorLine, spawnRunner, type CommandRunner } from './runner.ts'
import { extractZip } from './unzip.ts'
import { KNOWN_TOOL_IDS, parseRokitToml } from './toolchain.ts'

// "New project": fetch a template (the GenTree template, or a generated empty Rojo project), make it
// the person's own (drop the template's .git, rename, fresh `git init` + first commit, optional
// collaborator remote), then the first setup (`rokit install`, `wally install`, Blink compile).
//
// Forge removes the template's .git itself: the template's ./dev deletes .git when origin is the
// template repo (tools/dev.sh disconnect_template_git), so a clone that kept it would lose its
// history the first time the dev loop starts.

export const GENTREE_REPO = 'https://github.com/Acidgorgon/MyTemplate-Legacy.git'
export const GENTREE_BRANCH = 'master'
export const GENTREE_ZIP = `https://codeload.github.com/Acidgorgon/MyTemplate-Legacy/zip/refs/heads/${GENTREE_BRANCH}`
// The name the template ships with (default.project.json, README title, .gitignore place file).
const TEMPLATE_NAME = 'GenTree'

export type TemplateId = 'gentree' | 'empty'

export interface NewProjectInput {
  name: string
  parentDir: string
  template: TemplateId
  // Collaborator remote (origin) for the fresh repository; optional.
  remoteUrl?: string
  initGit: boolean
  // rokit install + wally install + Blink compile.
  firstSetup: boolean
}

export type NewProjectStepId = 'fetch' | 'prepare' | 'rename' | 'git' | 'rokit' | 'wally' | 'blink'

export interface NewProjectProgress {
  step: NewProjectStepId
  state: 'running' | 'done' | 'skipped' | 'failed'
  message?: string
  percent?: number
}

export interface NewProjectStepResult {
  step: NewProjectStepId
  state: 'done' | 'skipped' | 'failed'
  note?: string
}

export interface NewProjectResult {
  root: string
  projectName: string
  // How the template arrived.
  via: 'git' | 'zip' | 'local' | 'generated'
  steps: NewProjectStepResult[]
  notes: string[]
}

// Puts a template's files into dest (which exists and is empty). Returns how.
export type TemplateFetcher = (dest: string, report: (line: string, percent?: number) => void) => Promise<'git' | 'zip' | 'local'>

export interface NewProjectDeps {
  // GenTree template source; default: git clone --depth 1, else the codeload zip.
  fetcher?: TemplateFetcher
  runner?: CommandRunner
  findTool?: (name: string) => string | null
  env?: NodeJS.ProcessEnv
  // Wally scope when no remote owner is known (the OS user name, say).
  defaultScope?: string
  // Identity for the first commit when git has none configured.
  fallbackAuthor?: { name: string; email: string }
  onProgress?: (progress: NewProjectProgress) => void
  timeoutMs?: number
}

// ---------------------------------------------------------------- naming

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

export function validateProjectName(name: string): string | null {
  const value = name.trim()
  if (!value) return 'Give the project a name.'
  if (value.length > 80) return 'Keep the name under 80 characters.'
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(value)) return 'The name cannot contain < > : " / \\ | ? or *.'
  if (value === '.' || value === '..' || /[. ]$/.test(value) || RESERVED.test(value)) return 'That name cannot be used as a folder name.'
  return null
}

// Wally scope/name piece: lower-case letters, digits and dashes, 1–64 chars (wally
// src/package_name.rs validate_scope / validate_name).
export function wallyPart(value: string, fallback = 'game', splitCamel = true): string {
  const out = (splitCamel ? value.replace(/([a-z0-9])([A-Z])/g, '$1-$2') : value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
    .replace(/-$/, '')
  return out || fallback
}

// Owner of a GitHub/GitLab-style remote ("https://github.com/Team/Game.git", "git@github.com:Team/Game").
export function remoteOwner(url: string | undefined): string | null {
  if (!url) return null
  const m = /[:/]([^/:]+)\/[^/]+?(?:\.git)?\/?$/.exec(url.trim())
  return m && !/^(https?|ssh|git)$/i.test(m[1]) && !m[1].includes('.') ? m[1] : null
}

// default.project.json "name". Keeps the file's formatting when the first "name" key is the top-level one.
export function renameProjectJson(text: string, name: string): string {
  const json = JSON.parse(text)
  const match = /("name"\s*:\s*)"((?:[^"\\]|\\.)*)"/.exec(text)
  if (match && JSON.parse(`"${match[2]}"`) === json.name) {
    return text.slice(0, match.index) + match[1] + JSON.stringify(name) + text.slice(match.index + match[0].length)
  }
  return JSON.stringify({ ...json, name }, null, 2) + '\n'
}

// wally.toml [package] name = "scope/name".
export function renameWallyToml(text: string, scope: string, name: string): string {
  let inPackage = false
  return text
    .split(/(\r?\n)/)
    .map((part) => {
      const table = /^\s*\[\s*([^\]]+?)\s*\]/.exec(part)
      if (table) inPackage = table[1] === 'package'
      if (inPackage && /^\s*name\s*=/.test(part)) return part.replace(/=\s*["'][^"']*["']/, `= "${wallyPart(scope, 'me', false)}/${wallyPart(name)}"`)
      return part
    })
    .join('')
}

// README: the "# GenTree" title becomes "# <name>". Nothing else changes (the body explains the
// template layout, which still applies).
export function renameReadme(text: string, from: string, name: string): string {
  return text.replace(new RegExp(`^#[ \\t]+${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm'), `# ${name}`)
}

// .gitignore lists the template's place file (/GenTree.rbxlx); point it at the new name.
export function renameGitignore(text: string, from: string, name: string): string {
  return text.replace(new RegExp(`^/${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.rbxl(x?)$`, 'gm'), `/${name}.rbxl$1`)
}

// ---------------------------------------------------------------- templates

export interface GithubFetcherOptions {
  runner?: CommandRunner
  findTool?: (name: string) => string | null
  env?: NodeJS.ProcessEnv
  download?: (url: string) => Promise<Buffer>
  repo?: string
  branch?: string
  zipUrl?: string
}

async function httpDownload(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Download failed (${response.status} ${response.statusText})`)
  return Buffer.from(await response.arrayBuffer())
}

// git clone --depth 1 when git works, else (or when the clone fails) the codeload zip.
export function githubTemplateFetcher(options: GithubFetcherOptions = {}): TemplateFetcher {
  const runner = options.runner ?? spawnRunner
  const locate = options.findTool ?? ((name: string) => findTool(name))
  return async (dest, report) => {
    const git = locate('git')
    let gitError = ''
    if (git) {
      const out = await runner(
        git,
        ['clone', '--depth', '1', '--branch', options.branch ?? GENTREE_BRANCH, '--single-branch', '--progress', options.repo ?? GENTREE_REPO, dest],
        {
          cwd: resolve(dest, '..'),
          env: { ...(options.env ?? toolEnv()), GIT_TERMINAL_PROMPT: '0' },
          onLine: (line) => {
            const percent = /(\d{1,3})%/.exec(line)
            report(line, percent ? Number(percent[1]) : undefined)
          }
        }
      )
      if (out.code === 0) return 'git'
      gitError = errorLine(out.output)
      report(`git clone failed (${gitError}); downloading the zip instead`)
      await rm(dest, { recursive: true, force: true })
      await mkdir(dest, { recursive: true })
    } else {
      report('git not found; downloading the template zip')
    }
    try {
      const zip = await (options.download ?? httpDownload)(options.zipUrl ?? GENTREE_ZIP)
      report(`Unpacking ${Math.round(zip.length / 1024)} KB`)
      extractZip(zip, dest)
      return 'zip'
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      throw new Error(`Could not download the template: ${why}${gitError ? ` (git clone: ${gitError})` : ''}. Check your connection and try again.`)
    }
  }
}

// Copies a local folder (tests, or a template kept on disk).
export function localTemplateFetcher(source: string, fs: { cp: (from: string, to: string) => Promise<void> }): TemplateFetcher {
  return async (dest, report) => {
    report(`Copying ${source}`)
    await fs.cp(source, dest)
    return 'local'
  }
}

// An empty Rojo project, the same shape `rojo init` makes, plus a rokit.toml pinning rojo.
export function emptyProjectFiles(name: string, rojoVersion = '7.7.0'): Record<string, string> {
  const project = {
    name,
    tree: {
      $className: 'DataModel',
      ReplicatedStorage: { Shared: { $path: 'src/shared' } },
      ServerScriptService: { Server: { $path: 'src/server' } },
      StarterPlayer: { StarterPlayerScripts: { Client: { $path: 'src/client' } } }
    }
  }
  return {
    'default.project.json': JSON.stringify(project, null, 2) + '\n',
    'rokit.toml': `# Tools for this project. After clone: rokit install\n[tools]\nrojo = "rojo-rbx/rojo@${rojoVersion}"\n`,
    '.gitignore': `/${name}.rbxlx\n/*.rbxlx.lock\n/*.rbxl.lock\nsourcemap.json\nPackages/\nServerPackages/\n.studio-sync/\n`,
    'README.md': `# ${name}\n\nA Rojo project. Serve it with \`rojo serve\` and connect from the Rojo plugin in Studio.\n`,
    'src/shared/Hello.luau': 'return function()\n\tprint("Hello, world!")\nend\n',
    'src/server/init.server.luau': 'print("Hello world, from server!")\n',
    'src/client/init.client.luau': 'print("Hello world, from client!")\n'
  }
}

// ---------------------------------------------------------------- flow

export async function createProject(input: NewProjectInput, deps: NewProjectDeps = {}): Promise<NewProjectResult> {
  const progress = deps.onProgress ?? (() => {})
  const runner = deps.runner ?? spawnRunner
  const locate = deps.findTool ?? ((name: string) => findTool(name))
  const env = { ...(deps.env ?? toolEnv()), GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', CLICOLOR: '0', TERM: 'dumb' }
  const timeoutMs = deps.timeoutMs ?? 10 * 60 * 1000

  const nameError = validateProjectName(input.name)
  if (nameError) throw new Error(nameError)
  if (!input.parentDir?.trim()) throw new Error('Choose a parent folder.')
  const name = input.name.trim()
  const parent = resolve(input.parentDir.trim())
  const root = join(parent, name)
  if (existsSync(root) && readdirSync(root).length > 0) throw new Error(`${root} already exists and is not empty. Pick another name or folder.`)
  const remote = input.remoteUrl?.trim() || undefined
  if (remote && !/^(https?:\/\/|ssh:\/\/|git@|file:\/\/|\/|[A-Za-z]:\\)/.test(remote)) throw new Error('The remote should be a git URL such as https://github.com/team/game.git.')
  const created = !existsSync(root)
  await mkdir(root, { recursive: true })
  // Leave nothing half-made behind when the template never arrived.
  const cleanup = () => (created ? rm(root, { recursive: true, force: true }) : Promise.resolve()).catch(() => undefined)

  const steps: NewProjectStepResult[] = []
  const notes: string[] = []
  const finish = (step: NewProjectStepId, state: NewProjectStepResult['state'], note?: string) => {
    steps.push({ step, state, note })
    progress({ step, state, message: note })
    if (note && state !== 'done') notes.push(note)
  }
  const run = (file: string, args: string[], step: NewProjectStepId, cwd = root) =>
    runner(file, args, { cwd, env, timeoutMs, onLine: (line) => progress({ step, state: 'running', message: line }) })

  // 1. fetch
  let via: NewProjectResult['via'] = 'generated'
  progress({ step: 'fetch', state: 'running', message: input.template === 'gentree' ? 'Fetching the GenTree template' : 'Writing an empty Rojo project' })
  try {
    if (input.template === 'gentree') {
      const fetcher = deps.fetcher ?? githubTemplateFetcher({ runner, findTool: locate, env })
      via = await fetcher(root, (line, percent) => progress({ step: 'fetch', state: 'running', message: line, percent }))
    } else {
      for (const [file, text] of Object.entries(emptyProjectFiles(name))) {
        await mkdir(join(root, file, '..'), { recursive: true })
        await writeFile(join(root, file), text)
      }
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    progress({ step: 'fetch', state: 'failed', message: why })
    await cleanup()
    throw new Error(why)
  }
  if (!existsSync(join(root, 'default.project.json'))) {
    progress({ step: 'fetch', state: 'failed', message: 'The template has no default.project.json' })
    await cleanup()
    throw new Error('The template has no default.project.json.')
  }
  finish('fetch', 'done', via === 'zip' ? 'Downloaded the template zip (git was not available)' : undefined)

  // 2. prepare: the template's history is not the new game's.
  progress({ step: 'prepare', state: 'running', message: 'Removing the template .git' })
  await rm(join(root, '.git'), { recursive: true, force: true })
  await rm(join(root, '.keep-git'), { force: true })
  finish('prepare', 'done')

  // 3. rename
  progress({ step: 'rename', state: 'running', message: `Naming the project ${name}` })
  const renamed: string[] = []
  const edit = async (file: string, change: (text: string) => string) => {
    const full = join(root, file)
    if (!existsSync(full)) return
    const before = await readFile(full, 'utf8')
    const after = change(before)
    if (after !== before) {
      await writeFile(full, after)
      renamed.push(file)
    }
  }
  let oldName = TEMPLATE_NAME
  try {
    oldName = JSON.parse(await readFile(join(root, 'default.project.json'), 'utf8')).name || TEMPLATE_NAME
    await edit('default.project.json', (t) => renameProjectJson(t, name))
  } catch (error) {
    finish('rename', 'failed', `default.project.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  const scope = remoteOwner(remote) ?? deps.defaultScope ?? 'me'
  await edit('wally.toml', (t) => renameWallyToml(t, scope, name))
  await edit('README.md', (t) => renameReadme(t, oldName, name))
  await edit('.gitignore', (t) => renameGitignore(t, oldName, name))
  if (!steps.some((s) => s.step === 'rename')) finish('rename', 'done', renamed.length ? `Updated ${renamed.join(', ')}` : undefined)

  // 4. git init + first commit (+ remote)
  if (!input.initGit) {
    finish('git', 'skipped', 'Git was not set up. Use Sync > Set up git when you are ready.')
  } else {
    const git = locate('git')
    if (!git) {
      finish('git', 'skipped', 'Git is not installed, so the project is not a repository yet. Install git, then use Sync > Set up git.')
    } else {
      progress({ step: 'git', state: 'running', message: 'git init' })
      let init = await run(git, ['init', '-b', 'main'], 'git')
      // git before 2.28 has no -b.
      if (init.code !== 0) {
        init = await run(git, ['init'], 'git')
        if (init.code === 0) await run(git, ['symbolic-ref', 'HEAD', 'refs/heads/main'], 'git')
      }
      if (init.code !== 0) {
        finish('git', 'failed', `git init failed: ${errorLine(init.output)}`)
      } else {
        const identity: string[] = []
        const email = await run(git, ['config', 'user.email'], 'git')
        if (email.code !== 0 || !email.output.trim()) {
          const author = deps.fallbackAuthor ?? { name: 'RBX Forge', email: 'forge@localhost' }
          identity.push('-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`)
          notes.push(`Git has no user.name/user.email, so the first commit is by "${author.name}". Set yours with git config --global user.name / user.email.`)
        }
        await run(git, ['add', '-A'], 'git')
        const label = input.template === 'gentree' ? 'the GenTree template' : 'an empty Rojo project'
        const commit = await run(git, [...identity, 'commit', '-q', '-m', `Create ${name} from ${label}`], 'git')
        let failed = commit.code !== 0 ? `First commit failed: ${errorLine(commit.output)}` : ''
        if (!failed && remote) {
          const added = await run(git, ['remote', 'add', 'origin', remote], 'git')
          if (added.code !== 0) failed = `Could not add the remote: ${errorLine(added.output)}`
        }
        if (failed) finish('git', 'failed', failed)
        else finish('git', 'done', remote ? `origin = ${remote} (push when you are ready)` : 'Initial commit on main')
      }
    }
  }

  // 5–7. first setup
  if (!input.firstSetup) {
    for (const step of ['rokit', 'wally', 'blink'] as const) finish(step, 'skipped', step === 'rokit' ? 'First setup was turned off.' : undefined)
  } else {
    // rokit install: the template's pins are tools Forge knows, so no trust prompt is needed.
    const pins = parseRokitToml(existsSync(join(root, 'rokit.toml')) ? await readFile(join(root, 'rokit.toml'), 'utf8') : '')
    if (!pins.size) {
      finish('rokit', 'skipped', 'No rokit.toml.')
    } else {
      const rokit = locate('rokit')
      if (!rokit) {
        finish('rokit', 'skipped', 'rokit is not installed. Run the toolchain setup (Settings > Toolchain), then reopen the project.')
      } else {
        const unknown = [...pins.values()].filter((spec) => !KNOWN_TOOL_IDS.has(spec.id.toLowerCase()))
        progress({ step: 'rokit', state: 'running', message: 'rokit install' })
        const out = await run(rokit, unknown.length ? ['install'] : ['install', '--no-trust-check'], 'rokit')
        finish('rokit', out.code === 0 ? 'done' : 'failed', out.code === 0 ? undefined : `rokit install failed: ${errorLine(out.output)}`)
      }
    }
    if (!existsSync(join(root, 'wally.toml'))) {
      finish('wally', 'skipped', undefined)
    } else {
      const wally = locate('wally')
      if (!wally) finish('wally', 'skipped', 'wally is not installed, so Packages/ is missing. The dev loop installs it once wally is available.')
      else {
        progress({ step: 'wally', state: 'running', message: 'wally install' })
        const out = await run(wally, ['install'], 'wally')
        finish('wally', out.code === 0 ? 'done' : 'failed', out.code === 0 ? undefined : `wally install failed: ${errorLine(out.output)}`)
      }
    }
    if (!existsSync(join(root, 'events.blink'))) {
      finish('blink', 'skipped', undefined)
    } else {
      const blink = locate('blink')
      if (!blink) finish('blink', 'skipped', 'blink is not installed; the dev loop compiles events.blink once it is.')
      else {
        progress({ step: 'blink', state: 'running', message: 'blink events.blink' })
        const out = await run(blink, ['events.blink', '--yes'], 'blink')
        const ok = out.code === 0 && !/\[E\d{4}\]/.test(out.output)
        finish('blink', ok ? 'done' : 'failed', ok ? undefined : `Blink compile failed: ${errorLine(out.output)}`)
      }
    }
  }

  return { root, projectName: name || basename(root), via, steps, notes }
}

