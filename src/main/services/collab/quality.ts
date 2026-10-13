import { existsSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { run, toRepoPath } from '../tools.ts'
import { readProjectConfig, type ProjectConfig } from './config.ts'
import { collabEnv, git, locate, upstreamRef, type CollabDeps } from './git.ts'
import { parsePorcelainZ } from './incoming.ts'

// Selene (lint) and StyLua (format check) over the project, results as editor Problems.
//
// selene --display-style=json2 prints one JSON object per line, tagged by "type":
//   {"type":"Diagnostic","severity":"Error"|"Warning"|…,"code":"unused_variable","message":…,
//    "primary_label":{"filename":…,"span":{"start_line":0,"start_column":4,…},"message":…},
//    "notes":[…],"secondary_labels":[…]}
//   {"type":"Summary","errors":0,"warnings":1,"parse_errors":0}
// Lines and columns are 0-based (codespan Location). Exit code is non-zero when errors are found.
//
// stylua --check --output-format=json prints one object per unformatted file:
//   {"file":"src/a.luau","mismatches":[{"original_start_line":0,"original_end_line":1,
//     "expected_start_line":0,"expected_end_line":1,"original":"…","expected":"…"}]}
// with 0-based lines (from the `similar` diff ops). Parse errors go to stderr as a JSON array:
//   [{"type":"parse_error","message":…,"filename":…,"location":{"start_line":1,"start_column":5,…}}]
// with full-moon positions (1-based). Exit 1 when any file is not formatted.

export type ProblemSeverity = 'error' | 'warning' | 'info'

export interface Problem {
  path: string
  line: number // 1-based
  col: number // 1-based
  endLine?: number
  endCol?: number
  severity: ProblemSeverity
  message: string
  source: 'selene' | 'stylua'
  code?: string
}

export interface ToolRun {
  ran: boolean
  problems: Problem[]
  // Why the tool did not run, or the stderr of a failed run.
  note?: string
  exitCode?: number
}

const LUA_FILE = /\.(luau|lua)$/

function relPath(root: string, file: string): string {
  return toRepoPath(isAbsolute(file) ? relative(root, file) : file)
}

function seleneSeverity(value: unknown): ProblemSeverity {
  if (value === 'Error' || value === 'Bug') return 'error'
  if (value === 'Warning') return 'warning'
  return 'info'
}

export function parseSeleneJson2(stdout: string, root = ''): Problem[] {
  const out: Problem[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let item: Record<string, any>
    try {
      item = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (item.type !== 'Diagnostic') continue
    const label = item.primary_label || {}
    const span = label.span || {}
    const notes: string[] = Array.isArray(item.notes) ? item.notes : []
    const message = [item.message, label.message, ...notes].filter((s) => typeof s === 'string' && s).join(' — ')
    const problem: Problem = {
      path: relPath(root, String(label.filename ?? '')),
      line: (Number(span.start_line) || 0) + 1,
      col: (Number(span.start_column) || 0) + 1,
      endLine: (Number(span.end_line) || 0) + 1,
      endCol: (Number(span.end_column) || 0) + 1,
      severity: seleneSeverity(item.severity),
      message,
      source: 'selene'
    }
    if (item.code) problem.code = String(item.code)
    out.push(problem)
  }
  return out
}

// Splits concatenated JSON values ("[..][..]" or "{..}\n{..}") without trusting newlines.
export function splitJsonValues(text: string): unknown[] {
  const out: unknown[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)))
        } catch {
          // ignore malformed chunk
        }
        start = -1
      }
      if (depth < 0) depth = 0
    }
  }
  return out
}

export function parseStyluaJson(stdout: string, stderr = '', root = ''): Problem[] {
  const out: Problem[] = []
  for (const value of splitJsonValues(stdout)) {
    const item = value as Record<string, any>
    if (!item || typeof item !== 'object' || !Array.isArray(item.mismatches)) continue
    const path = relPath(root, String(item.file ?? ''))
    for (const m of item.mismatches) {
      const first = String(m.expected ?? '').split('\n')[0]
      out.push({
        path,
        line: (Number(m.original_start_line) || 0) + 1,
        col: 1,
        endLine: (Number(m.original_end_line) || 0) + 1,
        severity: 'warning',
        message: first ? `Not formatted (StyLua). Expected: ${first.trim()}` : 'Not formatted (StyLua): extra lines',
        source: 'stylua',
        code: 'format'
      })
    }
  }
  for (const value of splitJsonValues(stderr)) {
    const list = Array.isArray(value) ? value : [value]
    for (const item of list as Array<Record<string, any>>) {
      if (!item || item.type !== 'parse_error') continue
      const loc = item.location || {}
      out.push({
        path: relPath(root, String(item.filename ?? '')),
        line: Math.max(1, Number(loc.start_line) || 1),
        col: Math.max(1, Number(loc.start_column) || 1),
        endLine: Number(loc.end_line) || undefined,
        endCol: Number(loc.end_column) || undefined,
        severity: 'error',
        message: String(item.message ?? 'Parse error'),
        source: 'stylua',
        code: 'parse_error'
      })
    }
  }
  return out
}

function luaPaths(paths: string[] | undefined, fallback: string[]): string[] {
  if (!paths || paths.length === 0) return fallback
  return paths.map(toRepoPath).filter((p) => LUA_FILE.test(p) || !/\.[a-z0-9]+$/i.test(p))
}

export async function runSelene(root: string, paths?: string[], deps: CollabDeps = {}): Promise<ToolRun> {
  const selene = locate('selene', deps)
  if (!selene) return { ran: false, problems: [], note: 'selene not found. Add it to rokit.toml (selene = "Kampfkarren/selene@…") and run rokit install.' }
  const targets = luaPaths(paths, ['src'])
  if (targets.length === 0) return { ran: false, problems: [], note: 'No Luau files to lint.' }
  const result = await run(selene, ['--display-style=json2', '--no-summary', ...targets], root, collabEnv(deps))
  const problems = parseSeleneJson2(result.stdout, root)
  const tool: ToolRun = { ran: true, problems, exitCode: result.code }
  if (result.code !== 0 && problems.length === 0) tool.note = (result.stderr || result.stdout).trim().slice(0, 2000) || `selene exited ${result.code}`
  return tool
}

export interface StyluaOptions extends CollabDeps {
  // true: report unformatted files only. false: format the files in place.
  check?: boolean
}

export async function runStylua(root: string, paths?: string[], options: StyluaOptions = {}): Promise<ToolRun> {
  const stylua = locate('stylua', options)
  if (!stylua) return { ran: false, problems: [], note: 'stylua not found. Add it to rokit.toml (stylua = "JohnnyMorganz/StyLua@…") and run rokit install.' }
  const targets = luaPaths(paths, ['src'])
  if (targets.length === 0) return { ran: false, problems: [], note: 'No Luau files to format.' }
  const check = options.check !== false
  const args = check ? ['--check', '--output-format=json', ...targets] : [...targets]
  const result = await run(stylua, args, root, collabEnv(options))
  const problems = check ? parseStyluaJson(result.stdout, result.stderr, root) : parseStyluaJson('', result.stderr, root)
  const tool: ToolRun = { ran: true, problems, exitCode: result.code }
  if (result.code !== 0 && problems.length === 0) tool.note = (result.stderr || result.stdout).trim().slice(0, 2000) || `stylua exited ${result.code}`
  return tool
}

// Luau files changed locally: uncommitted (incl. untracked) plus committed-but-unpushed. Existing files only.
export async function changedLuaFiles(root: string, deps: CollabDeps = {}): Promise<string[]> {
  const files = new Set<string>()
  const porcelain = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], deps)
  for (const entry of parsePorcelainZ(porcelain.stdout)) if (entry.status !== 'deleted') files.add(entry.path)
  if (await upstreamRef(root, deps)) {
    const ahead = await git(root, ['diff', '--name-only', '--no-renames', '--diff-filter=d', '@{u}...HEAD'], deps)
    for (const line of ahead.stdout.split(/\r?\n/)) if (line.trim()) files.add(toRepoPath(line.trim()))
  }
  return [...files].filter((p) => LUA_FILE.test(p) && !/^(Server)?Packages\//.test(p) && existsSync(join(root, p))).sort()
}

export interface PreSyncReport {
  files: string[]
  problems: Problem[]
  errors: number
  warnings: number
  // false when an error-level problem was found; warnings never block.
  ok: boolean
  selene?: ToolRun
  stylua?: ToolRun
  notes: string[]
}

export async function preSyncCheck(root: string, options: CollabDeps & { config?: ProjectConfig; files?: string[] } = {}): Promise<PreSyncReport> {
  const config = options.config ?? (await readProjectConfig(root)).config
  const files = options.files ?? (await changedLuaFiles(root, options))
  const report: PreSyncReport = { files, problems: [], errors: 0, warnings: 0, ok: true, notes: [] }
  if (files.length === 0) {
    report.notes.push('No changed Luau files.')
    return report
  }
  if (config.lint.selene) {
    report.selene = await runSelene(root, files, options)
    if (report.selene.note) report.notes.push(report.selene.note)
    report.problems.push(...report.selene.problems)
  }
  if (config.lint.stylua) {
    report.stylua = await runStylua(root, files, { ...options, check: true })
    if (report.stylua.note) report.notes.push(report.stylua.note)
    report.problems.push(...report.stylua.problems)
  }
  if (!config.lint.selene && !config.lint.stylua) report.notes.push('Linting is off in .forge/project.json.')
  report.errors = report.problems.filter((p) => p.severity === 'error').length
  report.warnings = report.problems.filter((p) => p.severity === 'warning').length
  report.ok = report.errors === 0
  return report
}
