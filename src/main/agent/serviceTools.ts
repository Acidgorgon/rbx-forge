// Agent tools over the integrated services that have no tool module of their own: Blink
// (events.blink) and Wally packages. Same shape as tools.ts GentreeTool. No electron imports.
//
//   blink_events     read   list events/functions (filterable), one line each
//   blink_check      read   compile a temp copy of events.blink; diagnostics or "ok"
//   add_blink_event  write  append an event/function to events.blink, compile-checked, reverted on error
//   wally_search     read   search the public Wally registry
//   wally_info       read   one package: versions, realm, description
//   add_wally_package write add a dependency to wally.toml (installs in the background)

import { z } from 'zod'
import type { BlinkEvent, WallyAddSpec, WallyDependency, WallyPackage, WallyRealm } from '@shared/types'
import type { ServiceTool } from '../context.ts'
import type { BlinkEventSpec } from '../../shared/blinkParser.ts'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

// Mutating service tools. Not in the orchestrator's write set: they edit hot files (events.blink,
// wally.toml) or move whole feature folders, which no claimed-file task may do, so orchestrated
// agents use request_change instead.
export const SERVICE_WRITE_TOOLS = [
  'add_blink_event',
  'add_wally_package',
  'rename_feature',
  // services/art/tools.ts: spend money (OpenAI images), upload to Roblox and edit Images.luau.
  'generate_image',
  'import_image_to_roblox',
  'list_art'
] as const

// ---------------------------------------------------------------- Blink

export interface BlinkToolDeps {
  root: () => string | null
  listEvents: (root: string) => Promise<BlinkEvent[]>
  describeEvent: (ev: BlinkEvent) => string
  check: (root: string) => Promise<{ ok: boolean; diagnostics: { file: string; line: number; column?: number; message: string; code?: string; severity?: string }[]; skipped?: string }>
  addEvent: (
    root: string,
    spec: BlinkEventSpec,
    options: { revertOnError?: boolean }
  ) => Promise<{ declaration: string; check: { ok: boolean; diagnostics: { file: string; line: number; message: string }[]; skipped?: string } }>
}

const MAX_EVENTS = 200

function diagText(d: { file: string; line: number; column?: number; message: string; code?: string }): string {
  return `${d.file}:${d.line}${d.column ? `:${d.column}` : ''} ${d.code ? `[${d.code}] ` : ''}${d.message}`
}

export function blinkTools(deps: BlinkToolDeps): { read: ServiceTool[]; write: ServiceTool[] } {
  const root = () => {
    const r = deps.root()
    if (!r) throw new Error('no project open')
    return r
  }
  const read: ServiceTool[] = [
    {
      name: 'blink_events',
      description:
        'List the Blink networking events and functions declared in events.blink (and its imports): name, direction (Server->Client / Client->Server), Reliable/Unreliable, Call, Data and file:line. Optional filter = substring of the scoped name. Edit events.blink, never the generated src/shared/events files.',
      inputSchema: { filter: z.string().optional() },
      handler: async (args: { filter?: string }) => {
        const events = await deps.listEvents(root())
        const q = args.filter?.toLowerCase()
        const hits = q ? events.filter((e) => [...e.scope, e.name].join('.').toLowerCase().includes(q)) : events
        if (!hits.length) return ok(events.length ? '(no matches)' : '(no events: events.blink is missing or empty)')
        const lines = hits.slice(0, MAX_EVENTS).map(deps.describeEvent)
        if (hits.length > MAX_EVENTS) lines.push(`…${hits.length - MAX_EVENTS} more; filter further`)
        return ok(lines.join('\n'))
      }
    },
    {
      name: 'blink_check',
      description: 'Compile a temporary copy of events.blink with the project\'s blink and report errors as file:line [code] message, or "ok". Writes nothing in the project.',
      inputSchema: {},
      handler: async () => {
        const r = await deps.check(root())
        if (r.skipped) return ok(`skipped: ${r.skipped}`)
        if (r.ok) return ok('ok')
        return fail(r.diagnostics.slice(0, 20).map(diagText).join('\n'))
      }
    }
  ]
  const write: ServiceTool[] = [
    {
      name: 'add_blink_event',
      description:
        'Append an event (default) or function to events.blink, then compile-check it; on a compile error the file is restored and the errors are returned. Events: from Server|Client, type Reliable|Unreliable, call SingleSync|SingleAsync|ManySync|ManyAsync|Polling, data e.g. "(Instance(Player), u8)". Functions: yield Coroutine|Future|Promise, data, return. scope = existing or new scope name. ./dev regenerates the Luau outputs.',
      inputSchema: {
        name: z.string().min(1),
        kind: z.enum(['event', 'function']).optional(),
        from: z.enum(['Server', 'Client']).optional(),
        type: z.enum(['Reliable', 'Unreliable']).optional(),
        call: z.enum(['SingleSync', 'SingleAsync', 'ManySync', 'ManyAsync', 'Polling']).optional(),
        poll: z.boolean().optional(),
        yield: z.enum(['Coroutine', 'Future', 'Promise']).optional(),
        data: z.string().optional(),
        return: z.string().optional(),
        scope: z.string().optional()
      },
      handler: async (args: BlinkEventSpec) => {
        const r = await deps.addEvent(root(), args, { revertOnError: true })
        if (!r.check.ok) return fail(`not added (events.blink restored):\n${r.check.diagnostics.slice(0, 10).map(diagText).join('\n')}`)
        return ok(`added to events.blink${r.check.skipped ? ` (not compile-checked: ${r.check.skipped})` : ''}:\n${r.declaration}`)
      }
    }
  ]
  return { read, write }
}

// ---------------------------------------------------------------- Wally packages

export interface PackagesLike {
  search(query: string): Promise<WallyPackage[]>
  metadata(id: string): Promise<WallyPackage>
  addDep(spec: WallyAddSpec): Promise<WallyDependency[]>
}

function packageLine(p: WallyPackage): string {
  const realm = p.realm ? ` [${p.realm}]` : ''
  const desc = p.description ? ` - ${p.description.replace(/\s+/g, ' ').slice(0, 120)}` : ''
  return `${p.scope}/${p.name}@${p.latest}${realm}${desc}`
}

export function packageTools(packages: PackagesLike): { read: ServiceTool[]; write: ServiceTool[] } {
  const read: ServiceTool[] = [
    {
      name: 'wally_search',
      description: 'Search the public Wally registry (Roblox packages). Returns scope/name@latest [realm] - description, best matches first.',
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(30).optional() },
      handler: async (args: { query: string; limit?: number }) => {
        const hits = await packages.search(args.query)
        if (!hits.length) return ok('(no packages found)')
        return ok(hits.slice(0, args.limit ?? 10).map(packageLine).join('\n'))
      }
    },
    {
      name: 'wally_info',
      description: 'Details of one Wally package ("scope/name"): latest version, recent versions, realm, license, repository.',
      inputSchema: { id: z.string().regex(/^[\w-]+\/[\w-]+$/, 'use scope/name') },
      handler: async (args: { id: string }) => {
        const p = await packages.metadata(args.id)
        const lines = [packageLine(p), `versions: ${p.versions.slice(0, 12).join(', ')}${p.versions.length > 12 ? ', …' : ''}`]
        if (p.license) lines.push(`license: ${p.license}`)
        if (p.repository) lines.push(`repository: ${p.repository}`)
        if (p.authors?.length) lines.push(`authors: ${p.authors.join(', ')}`)
        return ok(lines.join('\n'))
      }
    }
  ]
  const write: ServiceTool[] = [
    {
      name: 'add_wally_package',
      description:
        'Add a Wally dependency to wally.toml ("scope/name"; version defaults to the latest; realm shared|server|dev defaults to the package\'s own realm). Installs in the background; the package is then required from ReplicatedStorage.Packages (or ServerPackages). Never edit Packages/ by hand.',
      inputSchema: {
        id: z.string().regex(/^[\w-]+\/[\w-]+$/, 'use scope/name'),
        version: z.string().optional(),
        realm: z.enum(['shared', 'server', 'dev']).optional(),
        alias: z.string().regex(/^[A-Za-z_][\w]*$/).optional()
      },
      handler: async (args: { id: string; version?: string; realm?: WallyRealm; alias?: string }) => {
        const [scope, name] = args.id.toLowerCase().split('/')
        let version = args.version
        let realm = args.realm
        if (!version || !realm) {
          const meta = await packages.metadata(args.id)
          version ??= meta.latest
          realm ??= meta.realm === 'server' ? 'server' : 'shared'
        }
        const deps = await packages.addDep({ scope, name, version, realm, ...(args.alias ? { alias: args.alias } : {}) })
        const added = deps.find((d) => d.scope === scope && d.name === name && d.realm === realm)
        return ok(`added ${scope}/${name}@${version} as ${added?.alias ?? name} (${realm}); installing in the background`)
      }
    }
  ]
  return { read, write }
}

// ---------------------------------------------------------------- Memory and skills (agent/memory)

export { memoryTools, MEMORY_READ_TOOLS, MEMORY_WRITE_TOOLS } from './memory/tools.ts'

// Appends the memory tools to a service tool set, after the others (fixed order: the tool list is
// part of the cached prompt prefix). recall/use_skill are read tools (every agent; guests through
// GUEST_TOOLS); remember/forget/save_skill go with the write tools. They write memory files, not
// project source, so they are not SERVICE_WRITE_TOOLS (the orchestrator does not treat them as admin).
export function withMemoryTools<T extends { read: ServiceTool[]; write: ServiceTool[] }>(sets: T, memory: { read: ServiceTool[]; write: ServiceTool[] } | null): T {
  if (!memory) return sets
  return { ...sets, read: [...sets.read, ...memory.read], write: [...sets.write, ...memory.write] }
}
