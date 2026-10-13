// Agent tools over the memory + skills layer (ServiceTool shape, see agent/serviceTools.ts).
//
//   recall      read   BM25 search over names, descriptions and bodies; returns the top bodies
//   use_skill   read   loads one skill's steps (exact name, or best match)
//   remember    write  save/update a memory (deduplicated; secrets refused)
//   forget      write  remove a memory or skill by name
//   save_skill  write  save/update a reusable procedure
//
// Read tools go to every agent (guests included, via GUEST_TOOLS); write tools only to agents that
// may change things. They write memory files, never project source, so the orchestrator treats
// them as ordinary tools (not in SERVICE_WRITE_TOOLS).

import { z } from 'zod'
import type { ServiceTool } from '../../context.ts'
import type { MemoryService } from './service.ts'
import type { MemoryEntry, SaveResult } from './types.ts'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

export const MEMORY_READ_TOOLS = ['recall', 'use_skill'] as const
export const MEMORY_WRITE_TOOLS = ['remember', 'forget', 'save_skill'] as const

const BODY_CHARS = 1500

function header(e: MemoryEntry): string {
  return `## ${e.name} (${e.scope} ${e.kind === 'skill' ? 'skill' : e.type})\n${e.description}`
}

function saved(r: SaveResult, what: string): string {
  const where = r.entry.scope === 'project' ? `.forge/memory/${r.entry.file}` : `user memory (${r.entry.file})`
  if (r.action === 'merged') return `updated the existing ${what} "${r.entry.name}" (near-duplicate of "${r.mergedFrom}") in ${where}`
  return `${r.action} ${what} "${r.entry.name}" in ${where}`
}

async function guard(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return ok(await fn())
  } catch (e) {
    return fail((e as Error).message)
  }
}

export function memoryTools(memory: Pick<MemoryService, 'recall' | 'skill' | 'remember' | 'forget'>): { read: ServiceTool[]; write: ServiceTool[] } {
  const read: ServiceTool[] = [
    {
      name: 'recall',
      description:
        'Search persistent memory (user + project memories and skills) for facts, preferences, conventions and past decisions. Keyword query; returns the best matches with their bodies. Use before tasks where a stored preference or convention may apply.',
      inputSchema: {
        query: z.string().min(1),
        scope: z.enum(['user', 'project', 'all']).optional(),
        kind: z.enum(['memory', 'skill', 'all']).optional(),
        limit: z.number().int().min(1).max(10).optional()
      },
      handler: (args: { query: string; scope?: 'user' | 'project' | 'all'; kind?: 'memory' | 'skill' | 'all'; limit?: number }) =>
        guard(async () => {
          const hits = await memory.recall(args.query, { scope: args.scope, kind: args.kind, limit: args.limit ?? 5 })
          if (!hits.length) return '(nothing in memory matches; it may simply not be known yet)'
          return hits
            .map((h) => {
              const body = h.entry.kind === 'skill' ? `(skill: call use_skill {"name":"${h.entry.name}"} for the steps)` : h.entry.body.length > BODY_CHARS ? h.entry.body.slice(0, BODY_CHARS) + '\n…' : h.entry.body
              return `${header(h.entry)}\n${body}`
            })
            .join('\n\n')
        })
    },
    {
      name: 'use_skill',
      description: 'Load a saved skill (a reusable, proven procedure) by name, from the Skills index. Follow its steps, adapting them to the task.',
      inputSchema: { name: z.string().min(1) },
      handler: (args: { name: string }) =>
        guard(async () => {
          const s = await memory.skill(args.name)
          if (!s) throw new Error(`no skill matches "${args.name}"`)
          return `${header(s)}\n\n${s.body}`
        })
    }
  ]
  const write: ServiceTool[] = [
    {
      name: 'remember',
      description:
        'Save a durable memory. scope user = about the person, across projects (style, naming, preferred models, how they like answers); scope project = this game, shared with the team (conventions, decisions + why, architecture facts). type: user | project | feedback (a correction) | reference (where something lives). name = short kebab-case (reuse an existing name to update it); description = one line; body = the fact, with the why. Never secrets or one-off task state.',
      inputSchema: {
        scope: z.enum(['user', 'project']),
        type: z.enum(['user', 'project', 'feedback', 'reference']),
        name: z.string().min(1).max(80),
        description: z.string().min(1).max(200),
        body: z.string().min(1)
      },
      handler: (args: { scope: 'user' | 'project'; type: 'user' | 'project' | 'feedback' | 'reference'; name: string; description: string; body: string }) =>
        guard(async () => saved(await memory.remember({ ...args, kind: 'memory' }), 'memory'))
    },
    {
      name: 'forget',
      description: 'Delete a memory or skill that is wrong or obsolete, by name. Pass scope/kind when the name exists in both stores.',
      inputSchema: { name: z.string().min(1), scope: z.enum(['user', 'project']).optional(), kind: z.enum(['memory', 'skill']).optional() },
      handler: (args: { name: string; scope?: 'user' | 'project'; kind?: 'memory' | 'skill' }) =>
        guard(async () => {
          const e = await memory.forget(args.name, { scope: args.scope, kind: args.kind })
          return `forgot ${e.scope} ${e.kind} "${e.name}"`
        })
    },
    {
      name: 'save_skill',
      description:
        'Save a reusable procedure that just worked and will recur (e.g. "add a GenTree feature with Blink events", "make a Vide UI component in this project\'s style"). description = when to use it (one line); steps = numbered markdown steps with the exact tools, files and pitfalls. scope project for this game\'s procedures, user for general ones. Reuse a name to improve an existing skill.',
      inputSchema: {
        scope: z.enum(['user', 'project']),
        name: z.string().min(1).max(80),
        description: z.string().min(1).max(200),
        steps: z.string().min(1)
      },
      handler: (args: { scope: 'user' | 'project'; name: string; description: string; steps: string }) =>
        guard(async () => saved(await memory.remember({ scope: args.scope, kind: 'skill', name: args.name, description: args.description, body: args.steps }), 'skill'))
    }
  ]
  return { read, write }
}
