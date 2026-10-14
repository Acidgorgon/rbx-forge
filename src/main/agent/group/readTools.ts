// Read-only project tools for group chats: git_diff and read_diagnostics (the rest of the guest set
// comes from gentreeTools(readOnly) and the services' read tools), plus the guard that keeps every
// guest tool list read-only no matter what is passed in.

import { z } from 'zod'
import type { HarnessContext } from '../../context.ts'
import { defineTool, WRITE_TOOLS, type GentreeTool, type ToolResult } from '../tools.ts'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface Diagnostic {
  path: string
  line: number
  col?: number
  severity: 'error' | 'warning' | 'info'
  message: string
  code?: string
}

// I/O the tools need; main wires git and selene, tests pass fakes.
export interface GroupIo {
  git(root: string, args: string[]): Promise<RunResult>
  // Lint/type problems for the paths (or the changed files when none are given).
  diagnostics?(root: string, paths?: string[]): Promise<{ ran: boolean; problems: Diagnostic[]; note?: string }>
}

// Caps (the same budget as the host's read tools: ~12k chars per result).
export const DIFF_CHARS = 12_000
export const DIAG_MAX = 40

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + `\n… (${text.length - max} more chars; narrow with path)`
}

// Paths a tool may pass to git: repo-relative, no option injection, no "..".
export function safeRelPath(p: string): boolean {
  return !!p && !p.startsWith('-') && !p.startsWith('/') && !/^[a-z]:/i.test(p) && !p.split(/[\\/]/).includes('..')
}

export function groupReadTools(ctx: HarnessContext, io: GroupIo | undefined): GentreeTool<any>[] {
  if (!io) return []
  const root = () => ctx.project()?.root ?? null
  return [
    defineTool(
      'git_diff',
      'Uncommitted changes in the project as a unified diff (working tree vs HEAD), optionally for one path or folder. Untracked files are listed. Read-only.',
      { path: z.string().optional(), staged: z.boolean().optional() },
      async (args) => {
        const r = root()
        if (!r) return fail('no project open')
        if (args.path && !safeRelPath(args.path)) return fail('path must be repo-relative')
        const diff = await io.git(r, ['diff', '--no-color', '--no-ext-diff', ...(args.staged ? ['--cached'] : []), ...(args.path ? ['--', args.path] : [])])
        if (diff.code !== 0) return fail((diff.stderr || 'git diff failed').trim().slice(0, 500))
        const untracked = await io.git(r, ['ls-files', '--others', '--exclude-standard', ...(args.path ? ['--', args.path] : [])])
        const extra = untracked.code === 0 && untracked.stdout.trim() ? `\n\nUntracked (new) files:\n${untracked.stdout.trim().split('\n').slice(0, 40).join('\n')}` : ''
        const body = diff.stdout.trim()
        return ok(clip(body || '(no uncommitted changes)', DIFF_CHARS) + extra)
      }
    ),
    defineTool(
      'read_diagnostics',
      'Lint and analysis problems (selene) for the given Luau files, or for the files changed locally, plus recent error lines from the dev services (rojo, lsp). Read-only.',
      { paths: z.array(z.string()).max(20).optional() },
      async (args) => {
        const r = root()
        if (!r) return fail('no project open')
        const paths = (args.paths ?? []).filter(safeRelPath)
        const lines: string[] = []
        if (io.diagnostics) {
          const d = await io.diagnostics(r, paths.length ? paths : undefined)
          if (!d.ran) lines.push(`(lint not run: ${d.note ?? 'unavailable'})`)
          else if (!d.problems.length) lines.push('No lint problems.')
          for (const p of d.problems.slice(0, DIAG_MAX)) lines.push(`${p.severity} ${p.path}:${p.line}${p.col ? `:${p.col}` : ''} ${p.message}${p.code ? ` [${p.code}]` : ''}`)
          if (d.problems.length > DIAG_MAX) lines.push(`… ${d.problems.length - DIAG_MAX} more`)
        }
        const errs = ctx
          .logs(undefined, 200)
          .filter((l) => l.stream === 'stderr' && ['rojo', 'lsp', 'dev', 'studioSync'].includes(l.service as string) && /error|warn|fail/i.test(l.text))
          .slice(-15)
          .map((l) => `[${l.service}] ${l.text.trim().slice(0, 200)}`)
        if (errs.length) lines.push('', 'Recent service errors:', ...errs)
        return ok(clip(lines.join('\n') || 'No problems found.', DIFF_CHARS))
      }
    )
  ]
}

const NEVER = new Set<string>([...WRITE_TOOLS, 'write_script', 'edit_script', 'create_spec', 'run_in_terminal', 'add_blink_event', 'add_wally_package', 'consult_model', 'invite_model', 'consult_until_agreed'])

// Keeps only allow-listed read tools and never a write tool, whatever the input list holds.
export function guardReadOnly(tools: GentreeTool<any>[], allow: readonly string[]): GentreeTool<any>[] {
  const allowed = new Set(allow)
  const seen = new Set<string>()
  return tools.filter((t) => {
    if (NEVER.has(t.name) || !allowed.has(t.name) || seen.has(t.name)) return false
    seen.add(t.name)
    return true
  })
}

export function isWriteTool(name: string): boolean {
  return NEVER.has(name.replace(/^mcp__.+?__/, ''))
}
