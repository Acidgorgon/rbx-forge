// Tools the engine adds to orchestrated agents: submit_plan (lead), submit_result (specialists),
// claim_files / request_change (writer roles), run_diff (reviewer, lead), and the write guard that
// wraps base write tools so they refuse files the task has not claimed.

import { z } from 'zod'
import { covers, LEAD_OWNER, LockManager, normalizePath } from './locks.ts'
import type { OrchTool, ResultStatus, ToolResult } from './types.ts'

export const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
export const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

function tool<S extends z.ZodRawShape>(name: string, description: string, inputSchema: S, handler: OrchTool<S>['handler']): OrchTool<S> {
  return { name, description, inputSchema, handler }
}

const ROLE_ENUM = ['scout', 'builder', 'tester', 'reviewer'] as const

export function submitPlanTool(onPlan: (plan: unknown) => ToolResult | Promise<ToolResult>): OrchTool<any> {
  return tool(
    'submit_plan',
    'Submit the task plan. Each task: id (short, unique), role (scout | builder | tester | reviewer), goal (self-contained), files (planned files; builders/testers get exactly these claimed), dependsOn (ids that must finish first). After it is accepted, end your turn.',
    {
      tasks: z
        .array(
          z.object({
            id: z.string(),
            role: z.enum(ROLE_ENUM),
            goal: z.string(),
            files: z.array(z.string()).optional(),
            dependsOn: z.array(z.string()).optional()
          })
        )
        .min(1),
      notes: z.string().optional()
    },
    async (args) => onPlan(args)
  )
}

export interface SubmittedResult {
  status: ResultStatus
  summary: string
  filesChanged: string[]
  followups: string[]
}

export function submitResultTool(onResult: (r: SubmittedResult) => ToolResult | Promise<ToolResult>): OrchTool<any> {
  return tool(
    'submit_result',
    'Report your result to the lead (call once, at the end). summary: a few sentences with file paths, no code.',
    {
      status: z.enum(['done', 'partial', 'failed']),
      summary: z.string(),
      filesChanged: z.array(z.string()).optional(),
      followups: z.array(z.string()).optional()
    },
    async (args) =>
      onResult({
        status: args.status,
        summary: String(args.summary ?? ''),
        filesChanged: (args.filesChanged ?? []).filter((f: unknown): f is string => typeof f === 'string'),
        followups: (args.followups ?? []).filter((f: unknown): f is string => typeof f === 'string')
      })
  )
}

export function requestChangeTool(onRequest: (file: string, change: string) => ToolResult): OrchTool<any> {
  return tool(
    'request_change',
    'Ask the lead to edit a file you may not write (events.blink, wally.toml, default.project.json, or a file owned by another task). Describe the exact change. The lead applies it after your task; continue without it.',
    { file: z.string(), change: z.string() },
    async (args) => {
      const file = normalizePath(args.file)
      if (!file) return fail(`refused: ${args.file} is not a path inside the project`)
      if (!args.change?.trim()) return fail('describe the change')
      return onRequest(file, args.change.trim())
    }
  )
}

export function claimFilesTool(locks: LockManager, owner: string, onClaimed: (files: string[]) => void): OrchTool<any> {
  return tool(
    'claim_files',
    'Claim additional NEW files for this task before writing them. Fails if any is a shared file or owned by another task.',
    { files: z.array(z.string()).min(1) },
    async (args) => {
      const r = locks.claim(owner, args.files)
      if (!r.ok) {
        const parts = [
          ...r.invalid.map((p) => `${p} is not a path inside the project`),
          ...r.hot.map((p) => `${p} is a shared file (use request_change)`),
          ...r.conflicts.map((c) => `${c.path} is claimed by task ${c.owner} (use request_change)`)
        ]
        return fail(`refused: ${parts.join('; ')}`)
      }
      const files = args.files.map((f: string) => normalizePath(f)!).filter(Boolean)
      onClaimed(files)
      return ok(`claimed ${files.join(', ')}`)
    }
  )
}

export function runDiffTool(changed: () => { file: string; taskId: string }[], diff?: (files: string[]) => Promise<string>): OrchTool<any> {
  return tool('run_diff', 'Files changed so far in this orchestration (with the task that changed each) and their diff when available.', {}, async () => {
    const list = changed()
    if (!list.length) return ok('no files changed')
    const head = list.map((c) => `${c.file} (${c.taskId})`).join('\n')
    if (!diff) return ok(head)
    try {
      const d = await diff([...new Set(list.map((c) => c.file))])
      const max = 24_000
      return ok(`${head}\n\n${d.length > max ? d.slice(0, max) + `\n…[truncated ${d.length - max} chars]` : d}`)
    } catch (e) {
      return ok(`${head}\n\n(diff unavailable: ${(e as Error).message})`)
    }
  })
}

// Files a write tool call would touch, or null when unknown (the guard then refuses).
export type WriteTargets = (toolName: string, args: Record<string, unknown>) => string[] | null

export const defaultWriteTargets: WriteTargets = (name, args) => {
  const bare = name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '')
  if (bare === 'new_feature' && typeof args.name === 'string') return [`src/shared/Features/${args.name.trim()}/`]
  for (const k of ['path', 'file_path', 'file', 'notebook_path']) if (typeof args[k] === 'string') return [args[k] as string]
  return null
}

// Wraps a write tool: every target must be writable by `owner` per the lock manager. Successful
// writes are reported to onWrite (the engine's filesChanged tracking).
export function guardWriteTool(
  base: OrchTool<any>,
  owner: string,
  locks: LockManager,
  targets: WriteTargets,
  onWrite: (files: string[]) => void
): OrchTool<any> {
  return {
    name: base.name,
    description: base.description,
    inputSchema: base.inputSchema,
    handler: async (args, extra) => {
      const files = targets(base.name, (args ?? {}) as Record<string, unknown>)
      if (!files || !files.length) return fail(`refused: cannot tell which file ${base.name} writes`)
      const ok: string[] = []
      for (const f of files) {
        if (f.endsWith('/')) {
          // Folder-creating tools (new_feature): nobody else may hold an overlapping claim, and a
          // task must have claimed the folder (or a parent folder) itself.
          const n = normalizePath(f)
          if (!n) return fail(`refused: ${f} is not a path inside the project`)
          const others = locks.othersOverlapping(owner, n)
          if (others.length) return fail(`refused: ${n} overlaps files claimed by task ${others.join(', ')}; call request_change`)
          if (owner !== LEAD_OWNER && (locks.isHot(n) || !locks.claimsOf(owner).some((c) => covers(c, n)))) {
            return fail(`refused: ${n} is not claimed by this task; call claim_files first`)
          }
          ok.push(n)
          continue
        }
        const r = locks.canWrite(owner, f)
        if (!r.ok) return fail(r.reason)
        ok.push(r.path)
      }
      const res = await base.handler(args, extra)
      if (!res.isError) onWrite(ok)
      return res
    }
  }
}
