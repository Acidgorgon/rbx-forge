import { findTool, outputLines, run, toolEnv, type RunResult } from '../tools.ts'

// Shared plumbing for the collaboration services: one way to run git (and other CLIs) with no
// prompts, no editors, no pager and stable (unquoted) paths.

export interface CollabDeps {
  // Full path to git; defaults to findTool('git').
  git?: string
  // Environment for every spawned tool; defaults to toolEnv() plus no prompts.
  env?: NodeJS.ProcessEnv
  // Finds a tool binary (rokit/wally/selene/stylua/gh). Defaults to tools.findTool (rokit bin first).
  findTool?: (name: string) => string | null
}

export function collabEnv(deps: CollabDeps = {}): NodeJS.ProcessEnv {
  return {
    ...(deps.env || toolEnv()),
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
    GIT_PAGER: 'cat',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1'
  }
}

export function locate(name: string, deps: CollabDeps = {}): string | null {
  return (deps.findTool || ((n: string) => findTool(n)))(name)
}

export function gitBinary(deps: CollabDeps = {}): string {
  return deps.git || locate('git', deps) || 'git'
}

// Runs git in root. Never rejects.
export function git(root: string, args: string[], deps: CollabDeps = {}): Promise<RunResult> {
  return run(gitBinary(deps), ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], root, collabEnv(deps))
}

export function firstError(result: RunResult): string {
  const lines = outputLines((result.stderr || result.stdout).trim())
  return lines.find((line) => /^(error|fatal)/i.test(line)) || lines[0] || ''
}

export async function isRepo(root: string, deps: CollabDeps = {}): Promise<boolean> {
  const result = await git(root, ['rev-parse', '--is-inside-work-tree'], deps)
  return result.code === 0 && result.stdout.trim() === 'true'
}

export async function upstreamRef(root: string, deps: CollabDeps = {}): Promise<string | null> {
  const result = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], deps)
  return result.code === 0 ? result.stdout.trim() : null
}

export async function headCommit(root: string, deps: CollabDeps = {}): Promise<string | null> {
  const result = await git(root, ['rev-parse', 'HEAD'], deps)
  return result.code === 0 ? result.stdout.trim() : null
}

export async function currentBranch(root: string, deps: CollabDeps = {}): Promise<string | null> {
  const result = await git(root, ['symbolic-ref', '--short', 'HEAD'], deps)
  return result.code === 0 ? result.stdout.trim() : null
}

export async function hasRemote(root: string, deps: CollabDeps = {}): Promise<boolean> {
  const result = await git(root, ['remote'], deps)
  return outputLines(result.stdout).length > 0
}

// git config user.name, falling back to the OS user so claims always have a name.
export async function userName(root: string, deps: CollabDeps = {}): Promise<string> {
  const result = await git(root, ['config', 'user.name'], deps)
  const name = result.stdout.trim()
  if (name) return name
  return process.env.USER || process.env.USERNAME || 'Someone'
}

// Field and record separators for --format strings (unit separator, record separator).
export const US = '\x1f'
export const RS = '\x1e'
