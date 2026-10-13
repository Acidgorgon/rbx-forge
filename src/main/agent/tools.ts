// The "gentree" in-process MCP server: a small set of compact tools over HarnessContext.
// Outputs are terse text (or one-line JSON) and truncated, so a typical call costs few tokens.

import { mkdir, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z, type ZodRawShape } from 'zod'
import type { ServiceId, TreeNode } from '@shared/types'
import { robloxPaths } from '../../shared/robloxPath.ts'
import type { HarnessContext } from '../context.ts'

export const SERVER_NAME = 'gentree'

// Tools that change the project. Test agents never get these.
export const WRITE_TOOLS = [
  'write_script',
  'edit_script',
  'new_feature',
  'sync_collaborators',
  'resolve_studio_conflict',
  'restart_service'
] as const

const SERVICE_IDS = ['dev', 'rojo', 'lsp', 'studioSync'] as const
const LOG_SOURCES = [...SERVICE_IDS, 'git', 'agent', 'harness'] as const

// Output caps.
const MAX_READ_LINES = 400
const MAX_TEXT_CHARS = 24_000
const MAX_LIST = 300
const MAX_TREE_LINES = 400

// Filesystem operations the tools need beyond HarnessContext (which has no mkdir/exists).
// Injected so tests can run without touching a real project.
export interface ToolFs {
  exists(relPath: string): Promise<boolean>
  mkdir(relDir: string): Promise<void>
}

export function nodeFs(ctx: HarnessContext): ToolFs {
  const abs = (rel: string) => {
    const root = ctx.project()?.root
    if (!root) throw new Error('no project open')
    return join(root, ...rel.split('/'))
  }
  return {
    async exists(rel) {
      try {
        await stat(abs(rel))
        return true
      } catch {
        return false
      }
    },
    async mkdir(rel) {
      await mkdir(abs(rel), { recursive: true })
    }
  }
}

export interface GentreeToolOptions {
  // Only the read tools (no WRITE_TOOLS).
  readOnly?: boolean
  fs?: ToolFs
}

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

// A gentree tool: name, description, zod input shape and handler. Structurally the same object the
// Agent SDK's tool() builds, so the SDK path wraps these in an MCP server unchanged, while the
// OpenAI-compatible loop calls handlers directly with toFunctionSpecs() schemas.
export interface GentreeTool<S extends ZodRawShape = ZodRawShape> {
  name: string
  description: string
  inputSchema: S
  handler: (args: z.infer<z.ZodObject<S>>, extra: unknown) => Promise<ToolResult>
}

export function defineTool<S extends ZodRawShape>(
  name: string,
  description: string,
  inputSchema: S,
  handler: (args: z.infer<z.ZodObject<S>>, extra: unknown) => Promise<ToolResult>
): GentreeTool<S> {
  return { name, description, inputSchema, handler }
}

// Same identifier, so the definitions below read like the SDK's tool() calls.
const tool = defineTool

// JSON Schema for a tool's input (zod 4's z.toJSONSchema), trimmed for function-calling APIs:
// no $schema, and no safe-integer bounds zod adds to every .int().
export function toolJsonSchema(shape: ZodRawShape): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(shape)) as Record<string, unknown>
  delete schema.$schema
  const clean = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(clean)
    const o = node as Record<string, unknown>
    if (o.maximum === Number.MAX_SAFE_INTEGER) delete o.maximum
    if (o.minimum === Number.MIN_SAFE_INTEGER) delete o.minimum
    for (const v of Object.values(o)) clean(v)
  }
  clean(schema)
  return schema
}

// OpenAI-style function definitions for a tool list.
export function toFunctionSpecs(tools: GentreeTool<any>[]): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: toolJsonSchema(t.inputSchema) } }))
}

// Validates model-supplied arguments against the tool's zod shape, then runs the handler.
// The SDK's MCP server does the same validation on the anthropic path.
export async function runTool(t: GentreeTool<any>, args: unknown): Promise<ToolResult> {
  const parsed = z.object(t.inputSchema).safeParse(args ?? {})
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')
    return fail(`invalid arguments for ${t.name}: ${issues}`)
  }
  try {
    return await t.handler(parsed.data, {})
  } catch (e) {
    return fail(`${t.name} failed: ${(e as Error).message}`)
  }
}

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

function clip(text: string, max = MAX_TEXT_CHARS): string {
  return text.length <= max ? text : text.slice(0, max) + `\n…[truncated ${text.length - max} chars]`
}

// Normalizes a model-supplied repo-relative path. Returns null when it escapes the root.
export function normalizeRepoPath(input: string): string | null {
  const p = input.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null
  const norm = posix.normalize(p)
  if (norm === '..' || norm.startsWith('../') || norm === '.') return null
  return norm
}

// Rojo $path folders from default.project.json (excluding Packages), e.g. ["src/shared", ...].
async function rojoFolders(ctx: HarnessContext): Promise<string[]> {
  const fallback = ['src/shared', 'src/server', 'src/client', 'src/ServerStorage']
  try {
    const project = JSON.parse(await ctx.readFile('default.project.json'))
    const out: string[] = []
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === '$path' && typeof value === 'string') out.push(posix.normalize(value.replace(/\\/g, '/')))
        else if (!key.startsWith('$')) walk(value)
      }
    }
    walk(project.tree)
    const filtered = out.filter((p) => p !== 'Packages' && !p.startsWith('Packages/'))
    return filtered.length ? filtered : fallback
  } catch {
    return fallback
  }
}

// Decides whether the agent may write `path`. Returns the normalized path or an error message.
export async function checkWritable(ctx: HarnessContext, fs: ToolFs, input: string): Promise<{ path: string } | { error: string }> {
  const path = normalizeRepoPath(input)
  if (!path) return { error: `refused: ${input} is outside the project` }
  if (path === 'events.blink') return { path }
  if (path.startsWith('Packages/')) return { error: 'refused: Packages/ is managed by Wally, never edit it' }
  if (!path.startsWith('src/')) return { error: 'refused: only files under src/ (or events.blink) can be written' }
  const folders = await rojoFolders(ctx)
  const folder = folders.find((f) => path.startsWith(f + '/'))
  if (!folder) return { error: `refused: ${path} is not inside a Rojo folder (${folders.join(', ')})` }
  if (!(await fs.exists(folder))) return { error: `refused: Rojo folder ${folder} does not exist` }
  return { path }
}

function serviceName(id: string): ServiceId | null {
  return (SERVICE_IDS as readonly string[]).includes(id) ? (id as ServiceId) : null
}

// Optional extra properties a Studio snapshot may attach to nodes.
type TreeNodeWithProps = TreeNode & { props?: Record<string, unknown> }

function propsText(node: TreeNodeWithProps): string {
  if (!node.props) return ''
  const parts = Object.entries(node.props)
    .slice(0, 4)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`.slice(0, 60))
  return parts.length ? ` {${parts.join(' ')}}` : ''
}

// Top-level instances (services). Skips a DataModel wrapper node if the tree has one.
function topLevel(tree: TreeNode[]): TreeNode[] {
  if (tree.length === 1 && tree[0].className === 'DataModel') return tree[0].children
  return tree
}

// Splits "game.ReplicatedStorage.Assets", "ReplicatedStorage/Assets" or game:GetService("X").Y into names.
export function parseInstancePath(input: string): string[] {
  let s = input.trim()
  s = s.replace(/^game:GetService\(\s*["']([^"']+)["']\s*\)/, '$1')
  s = s.replace(/:WaitForChild\(\s*["']([^"']+)["']\s*\)/g, '.$1')
  s = s.replace(/\[\s*["']([^"']+)["']\s*\]/g, '.$1')
  const parts = s.split(/[./]/).map((p) => p.trim()).filter(Boolean)
  if (parts[0] === 'game') parts.shift()
  return parts
}

// Renders the tree as indented lines: `Name Class -> file` plus `*` for Studio-only nodes.
export function renderTree(tree: TreeNode[], prefix: string[], depth: number, maxLines = MAX_TREE_LINES): string {
  let nodes = topLevel(tree)
  for (const name of prefix) {
    const next = nodes.find((n) => n.name === name)
    if (!next) return `not found: ${name} (have: ${nodes.map((n) => n.name).slice(0, 30).join(', ')})`
    nodes = [next]
    if (name !== prefix[prefix.length - 1]) nodes = next.children
  }
  const lines: string[] = []
  let cut = 0
  const walk = (list: TreeNode[], level: number) => {
    for (const node of list) {
      if (lines.length >= maxLines) {
        cut++
        continue
      }
      const n = node as TreeNodeWithProps
      const star = n.origin === 'studio' ? '*' : ''
      const file = n.filePath ? ` -> ${n.filePath}` : ''
      const more = level + 1 >= depth && n.children.length ? ` (+${n.children.length})` : ''
      lines.push(`${'  '.repeat(level)}${n.name}${star} ${n.className}${file}${propsText(n)}${more}`)
      if (level + 1 < depth) walk(n.children, level + 1)
    }
  }
  walk(nodes, 0)
  if (cut) lines.push(`…${cut} more nodes; narrow with path or lower depth`)
  return lines.join('\n') + (lines.some((l) => l.includes('*')) ? '\n(* = only in Studio, not in repo)' : '')
}

// Finds instances whose name or class contains `query` (case-insensitive).
export function findInstances(tree: TreeNode[], query: string, service?: string, limit = 30): string[] {
  const q = query.toLowerCase()
  const out: string[] = []
  const walk = (node: TreeNode, path: string[]) => {
    if (out.length >= limit) return
    const here = [...path, node.name]
    if (path.length && (node.name.toLowerCase().includes(q) || node.className.toLowerCase().includes(q))) {
      const n = node as TreeNodeWithProps
      const star = n.origin === 'studio' ? '*' : ''
      const file = n.filePath ? ` -> ${n.filePath}` : ''
      out.push(`${robloxPaths(here).dot} (${n.className})${star}${file}`)
    }
    for (const child of node.children) walk(child, here)
  }
  for (const svc of topLevel(tree)) {
    if (service && svc.name.toLowerCase() !== service.toLowerCase()) continue
    if (svc.name.toLowerCase().includes(q) || svc.className.toLowerCase().includes(q)) {
      if (out.length < limit) out.push(`${robloxPaths([svc.name]).dot} (${svc.className})`)
    }
    for (const child of svc.children) walk(child, [svc.name])
  }
  return out
}

// Builds the tool definitions. Exported separately from the server so tests can call handlers directly.
export function gentreeTools(ctx: HarnessContext, opts: GentreeToolOptions = {}): GentreeTool<any>[] {
  const fs = opts.fs ?? nodeFs(ctx)

  const read = [
    tool(
      'project_overview',
      'One-call orientation: project name, place ids, service states, git summary, conflict counts, script counts per category.',
      {},
      async () => {
        const project = ctx.project()
        if (!project) return fail('no project open')
        const git = await ctx.gitStatus().catch((e: Error) => e)
        const studio = await ctx.studioConflicts().catch(() => [])
        const counts: Record<string, number> = {}
        for (const g of ctx.scripts()) counts[g.category] = g.scripts.length
        const overview = {
          name: project.name,
          root: project.root,
          placeIds: project.placeIds,
          services: Object.fromEntries(ctx.services().map((s) => [s.id, s.detail ? `${s.state} (${s.detail})` : s.state])),
          git:
            git instanceof Error
              ? { error: git.message }
              : git.isRepo
                ? {
                    branch: git.branch,
                    ahead: git.ahead,
                    behind: git.behind,
                    dirty: git.dirty,
                    mergeConflicts: git.conflicts.length,
                    remote: git.hasRemote,
                    ...(git.error ? { error: git.error } : {})
                  }
                : 'not a git repo',
          studioConflicts: studio.length,
          scripts: counts
        }
        return ok(JSON.stringify(overview))
      }
    ),

    tool(
      'list_scripts',
      'List script paths (repo-relative), optionally filtered. Categories: Configs, Data, Services, Controllers, Modules, Events, UI, Entry points, Other.',
      {
        category: z.string().optional(),
        feature: z.string().optional(),
        realm: z.enum(['shared', 'server', 'client']).optional()
      },
      async (args) => {
        const paths: string[] = []
        for (const group of ctx.scripts()) {
          if (args.category && group.category.toLowerCase() !== args.category.toLowerCase()) continue
          for (const s of group.scripts) {
            if (args.feature && s.feature?.toLowerCase() !== args.feature.toLowerCase()) continue
            if (args.realm && s.realm !== args.realm) continue
            paths.push(s.path)
          }
        }
        if (!paths.length) return ok('(none)')
        const extra = paths.length > MAX_LIST ? `\n…${paths.length - MAX_LIST} more; filter further` : ''
        return ok(paths.slice(0, MAX_LIST).join('\n') + extra)
      }
    ),

    tool(
      'read_script',
      `Read a project file with line numbers. Optional 1-based inclusive line range; at most ${MAX_READ_LINES} lines per call.`,
      { path: z.string(), from: z.number().int().min(1).optional(), to: z.number().int().min(1).optional() },
      async (args) => {
        const path = normalizeRepoPath(args.path)
        if (!path) return fail(`refused: ${args.path} is outside the project`)
        let text: string
        try {
          text = await ctx.readFile(path)
        } catch (e) {
          return fail(`cannot read ${path}: ${(e as Error).message}`)
        }
        const lines = text.split(/\r?\n/)
        const from = args.from ?? 1
        const to = Math.min(args.to ?? lines.length, lines.length, from + MAX_READ_LINES - 1)
        const width = String(to).length
        const body = lines
          .slice(from - 1, to)
          .map((l, i) => `${String(from + i).padStart(width)}|${l}`)
          .join('\n')
        const tail = to < lines.length ? `\n…lines ${to + 1}-${lines.length} not shown` : ''
        return ok(clip(body + tail))
      }
    ),

    tool(
      'explorer_tree',
      'Roblox explorer tree as indented "Name Class -> file" lines. `path` accepts game.ReplicatedStorage.Shared, ReplicatedStorage/Shared, etc. Default depth 3. Trailing * = only in Studio.',
      { path: z.string().optional(), depth: z.number().int().min(1).max(10).optional() },
      async (args) => ok(renderTree(ctx.tree(), args.path ? parseInstancePath(args.path) : [], args.depth ?? 3))
    ),

    tool(
      'find_instance',
      'Find instances by name or class substring (case-insensitive). Use it to resolve Roblox paths users paste, e.g. game.ReplicatedStorage.Assets.Sword. Returns game.* paths with class.',
      { query: z.string().min(1), service: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
      async (args) => {
        // A full pasted path: search by its last segment, prefer exact path matches.
        const parts = parseInstancePath(args.query)
        const needle = parts.length > 1 ? parts[parts.length - 1] : args.query.replace(/^game\./, '')
        const hits = findInstances(ctx.tree(), needle, args.service ?? (parts.length > 1 ? parts[0] : undefined), args.limit ?? 30)
        return ok(hits.length ? hits.join('\n') : '(no matches)')
      }
    ),

    tool('studio_conflicts', 'Scripts edited both in Studio and the repo, held by studio-sync.', {}, async () => {
      const list = await ctx.studioConflicts()
      if (!list.length) return ok('(none)')
      return ok(
        list
          .map((c) => {
            const a = c.repoSource.split('\n')
            const b = c.studioSource.split('\n')
            let first = 0
            while (first < a.length && first < b.length && a[first] === b[first]) first++
            return `${c.path} repo:${a.length}L studio:${b.length}L firstDiff:L${first + 1}`
          })
          .join('\n')
      )
    }),

    tool(
      'service_logs',
      'Last N log lines of a harness service (dev, rojo, lsp, studioSync) or git/agent/harness.',
      { service: z.enum(LOG_SOURCES), lines: z.number().int().min(1).max(200).optional() },
      async (args) => {
        const logs = ctx.logs(args.service, args.lines ?? 40)
        if (!logs.length) return ok('(no output)')
        return ok(clip(logs.map((l) => (l.stream === 'stderr' ? '! ' : '') + l.text).join('\n'), 12_000))
      }
    )
  ]

  if (opts.readOnly) return read

  const write = [
    tool(
      'write_script',
      'Create or overwrite a file under src/ (inside a Rojo folder) or events.blink, with full contents. Prefer edit_script for small changes.',
      { path: z.string(), contents: z.string() },
      async (args) => {
        const check = await checkWritable(ctx, fs, args.path)
        if ('error' in check) return fail(check.error)
        const dir = posix.dirname(check.path)
        if (dir !== '.' && !(await fs.exists(dir))) await fs.mkdir(dir)
        await ctx.writeFile(check.path, args.contents)
        return ok(`wrote ${check.path} (${args.contents.split('\n').length} lines)`)
      }
    ),

    tool(
      'edit_script',
      'Replace old_string with new_string in a file. old_string must occur exactly once (include surrounding lines to disambiguate).',
      { path: z.string(), old_string: z.string().min(1), new_string: z.string() },
      async (args) => {
        const check = await checkWritable(ctx, fs, args.path)
        if ('error' in check) return fail(check.error)
        let text: string
        try {
          text = await ctx.readFile(check.path)
        } catch (e) {
          return fail(`cannot read ${check.path}: ${(e as Error).message}`)
        }
        const first = text.indexOf(args.old_string)
        if (first < 0) return fail('old_string not found; read_script the file and copy the text exactly')
        if (text.indexOf(args.old_string, first + 1) >= 0) return fail('old_string occurs more than once; include more context')
        const next = text.slice(0, first) + args.new_string + text.slice(first + args.old_string.length)
        await ctx.writeFile(check.path, next)
        const line = text.slice(0, first).split('\n').length
        return ok(`edited ${check.path} at line ${line}`)
      }
    ),

    tool(
      'new_feature',
      'Create src/shared/Features/<Name>/. The ./dev watcher then scaffolds the server Feature (Service) and <Name>Controller. Name must be PascalCase.',
      { name: z.string() },
      async (args) => {
        const name = args.name.trim()
        if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) return fail(`refused: "${name}" is not PascalCase (e.g. Inventory)`)
        const dir = `src/shared/Features/${name}`
        if (await fs.exists(dir)) return fail(`${dir} already exists`)
        if (!(await fs.exists('src/shared/Features'))) return fail('src/shared/Features does not exist')
        await fs.mkdir(dir)
        const dev = ctx.services().find((s) => s.id === 'dev')
        const note =
          dev?.state === 'running'
            ? 'dev watcher is running; it will create the server Feature and Controller'
            : 'dev service is not running; start it so the watcher scaffolds the server Feature and Controller'
        return ok(`created ${dir}; ${note}`)
      }
    ),

    tool('sync_collaborators', 'Git sync with collaborators now (commit, pull, push). Returns a summary.', {}, async () => {
      const g = await ctx.syncNow()
      if (g.error) return fail(`sync failed: ${g.error}`)
      const conflicts = g.conflicts.length ? ` conflicts: ${g.conflicts.join(', ')}` : ''
      return ok(`branch ${g.branch ?? '?'} ahead ${g.ahead} behind ${g.behind} dirty ${g.dirty}${conflicts}`)
    }),

    tool(
      'resolve_studio_conflict',
      'Resolve a held studio-sync conflict by keeping the Studio or the repo version.',
      { path: z.string(), take: z.enum(['studio', 'repo']) },
      async (args) => {
        const path = normalizeRepoPath(args.path)
        if (!path) return fail(`refused: ${args.path} is outside the project`)
        await ctx.resolveStudioConflict(path, args.take)
        return ok(`resolved ${path}: kept ${args.take}`)
      }
    ),

    tool(
      'restart_service',
      'Restart a harness service: dev (watcher+Blink+sourcemap), rojo, lsp, studioSync.',
      { service: z.enum(SERVICE_IDS) },
      async (args) => {
        const id = serviceName(args.service)
        if (!id) return fail('unknown service')
        await ctx.restartService(id)
        const s = ctx.services().find((x) => x.id === id)
        return ok(`${id}: ${s?.state ?? 'unknown'}`)
      }
    )
  ]

  return [...read, ...write]
}

// Wraps tools in a fresh in-process MCP server. Create one per query: an McpServer instance
// connects to a single transport, so concurrent queries must not share one.
export function createGentreeServer(
  ctx: HarnessContext,
  opts: GentreeToolOptions & { extraTools?: GentreeTool<any>[] } = {}
): McpSdkServerConfigWithInstance {
  return wrapInSdkServer([...gentreeTools(ctx, opts), ...(opts.extraTools ?? [])])
}

export function wrapInSdkServer(tools: GentreeTool<any>[]): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: SERVER_NAME,
    version: '1.0.0',
    // Few small tools: keep them all in the prompt instead of behind tool search.
    alwaysLoad: true,
    tools: tools as unknown as SdkMcpToolDefinition<any>[]
  })
}

// Fully qualified tool names as the model sees them.
export function mcpToolName(name: string, server = SERVER_NAME): string {
  return `mcp__${server}__${name}`
}
