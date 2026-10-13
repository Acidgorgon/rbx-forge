// Ready-made tool definitions for the token-saving tools: project_map, search_code, find_symbol.
// Structurally identical to tools.ts's GentreeTool ({ name, description, inputSchema, handler }),
// so they can be appended to gentreeTools() output (SDK MCP server and OpenAI loop alike) without
// this module importing tools.ts.

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { HarnessContext } from '../../context.ts'
import { formatSymbolHits, ProjectMap, type MapSource } from './projectMap.ts'
import { findSymbol, searchCode, type Realm, type SearchFs } from './searchCode.ts'

export type BudgetToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

export interface BudgetTool {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  handler: (args: any, extra: unknown) => Promise<BudgetToolResult>
}

const ok = (text: string): BudgetToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): BudgetToolResult => ({ content: [{ type: 'text', text }], isError: true })

// MapSource over HarnessContext, with fs.stat on the project root so refresh() skips unchanged files.
export function mapSource(ctx: Pick<HarnessContext, 'scripts' | 'readFile' | 'project'>): MapSource {
  return {
    scripts: () => ctx.scripts(),
    readFile: (p) => ctx.readFile(p),
    async stat(p) {
      const root = ctx.project()?.root
      if (!root) throw new Error('no project open')
      const s = await stat(join(root, ...p.split('/')))
      return { mtimeMs: s.mtimeMs, size: s.size }
    }
  }
}

// Realm lookup from the script list (falls back to the src/<realm> convention inside searchCode).
export function realmLookup(ctx: Pick<HarnessContext, 'scripts'>): (path: string) => Realm | undefined {
  return (path) => {
    for (const g of ctx.scripts()) for (const s of g.scripts) if (s.path === path) return s.realm
    if (path.startsWith('src/shared/')) return 'shared'
    if (path.startsWith('src/server/') || path.startsWith('src/ServerStorage/')) return 'server'
    if (path.startsWith('src/client/')) return 'client'
    return undefined
  }
}

export interface BudgetToolDeps {
  map: ProjectMap
  fs: SearchFs
  realmOf?: (path: string) => Realm | undefined
  // Default token budget for project_map output. Default 2500.
  mapTokens?: number
}

const REALM = z.enum(['shared', 'server', 'client'])

export function budgetTools(deps: BudgetToolDeps): BudgetTool[] {
  return [
    {
      name: 'project_map',
      description:
        'Compact map of every script: file, category, line count, top-level requires, exports, Init/Start. Use it first instead of listing and reading files. Filter with path (folder prefix), realm or category.',
      inputSchema: {
        path: z.string().optional(),
        realm: REALM.optional(),
        category: z.string().optional(),
        maxTokens: z.number().int().min(200).max(20000).optional()
      },
      async handler(args: { path?: string; realm?: Realm; category?: string; maxTokens?: number }) {
        await deps.map.refresh()
        const r = deps.map.render({ path: args.path, realm: args.realm, category: args.category, maxTokens: args.maxTokens ?? deps.mapTokens ?? 2500 })
        return ok(r.text)
      }
    },
    {
      name: 'search_code',
      description:
        'Search project code; returns "path:line: text" with context lines. Literal and case-insensitive unless regex/caseSensitive. Skips Packages/ and Blink-generated files unless includeIgnored. Prefer this over reading whole files.',
      inputSchema: {
        query: z.string().min(1),
        regex: z.boolean().optional(),
        caseSensitive: z.boolean().optional(),
        path: z.string().optional(),
        realm: REALM.optional(),
        maxResults: z.number().int().min(1).max(200).optional(),
        context: z.number().int().min(0).max(5).optional(),
        includeIgnored: z.boolean().optional()
      },
      async handler(args: { query: string; regex?: boolean; caseSensitive?: boolean; path?: string; realm?: Realm; maxResults?: number; context?: number; includeIgnored?: boolean }) {
        try {
          const r = await searchCode(deps.fs, { ...args, realmOf: deps.realmOf })
          return ok(r.text)
        } catch (e) {
          return fail((e as Error).message)
        }
      }
    },
    {
      name: 'find_symbol',
      description: 'Where a module, function, method or field is defined: "path:line kind Table.name". Accepts Name, Table.Name or Table:Name.',
      inputSchema: { name: z.string().min(1) },
      async handler(args: { name: string }) {
        await deps.map.refresh()
        const full = deps.map.findSymbol(args.name)
        if (full.length) return ok(formatSymbolHits(full))
        // "Table:Name" spelled with the wrong separator, or an unexported local: search by the last segment.
        const name = args.name.split(/[.:]/).pop() || args.name
        const r = await findSymbol(deps.map, deps.fs, name)
        return ok(r.text)
      }
    }
  ]
}

export const BUDGET_TOOL_NAMES = ['project_map', 'search_code', 'find_symbol'] as const
