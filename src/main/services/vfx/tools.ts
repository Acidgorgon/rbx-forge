// Agent tools for the VFX Lab (ServiceTool shape: zod raw shape + handler).
//
//   vfx_search_library  read   closest library effects (compact parameters) + the learned recipe
//   vfx_create          write  spec -> library entry + src/shared/VFX/<Name>/init.luau + Effect.rbxmx
//   vfx_render          write  PNG frames from the offscreen preview (shown inline) + a critique
//   vfx_refine          write  render / critique / adjust loop until the score passes the threshold

import { z } from 'zod'
import { perfWarnings } from '../../../shared/vfx/analyze.ts'
import { compactEffect, SpecError, type VfxSpec } from '../../../shared/vfx/spec.ts'
import type { VfxEntry } from '../../../shared/vfx/types.ts'
import type { VfxService } from './service.ts'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

export interface VfxTool {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  handler: (args: any, extra: unknown) => Promise<ToolResult>
}

export const VFX_READ_TOOLS = ['vfx_search_library'] as const
export const VFX_WRITE_TOOLS = ['vfx_create', 'vfx_render', 'vfx_refine'] as const

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

async function guard(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return ok(await fn())
  } catch (e) {
    return fail(e instanceof SpecError ? `spec error: ${e.message}` : (e as Error).message)
  }
}

function line(e: VfxEntry): string {
  return `${e.id} [${e.scope} ${e.kind}${e.rating ? ` ${e.rating === 'up' ? 'liked' : 'disliked'}` : ''}] ${e.name} (${e.tags.join(', ')}): ${e.description}`
}

const SPEC_DOC = `spec = {"name","description","tags":[...],"duration":s,"motion":"static|swing|orbit|dash|rise","anchor":[x,y,z],
"layers":[{"name","class":"ParticleEmitter|Beam|Trail|PointLight|SpotLight|Highlight","props":{Roblox property: value},
"emit":[{"at":s,"count":n}] (bursts; the emitter starts disabled),"enable":[[from,to]],"shape":{"size":[x,y,z]} (emit from a part; set Shape/ShapeStyle),
"width":studs (Trail attachment spacing),"from":[x,y,z],"to":[x,y,z] (Beam ends)}]}
Values: ranges [min,max]; NumberSequence [[t,v],[t,v,envelope]]; ColorSequence ["#hex",...] or [[t,"#hex"],...]; vectors [x,y,z]; enums by name ("Top","VelocityParallel","Grid4x4","OneShot"); Texture "rbxassetid://<id>" (reuse ids from library references, never invent ids).`

export function vfxTools(service: VfxService, opts: { chatImage?: (absPath: string, name: string) => Promise<string | null> } = {}): { read: VfxTool[]; write: VfxTool[] } {
  const read: VfxTool[] = [
    {
      name: 'vfx_search_library',
      description:
        "Search the user's Roblox VFX reference library (effects imported from .rbxm/.rbxmx, reference images, liked results) by keywords or tags (fire, slash, impact, aura, magic...). Returns the closest effects with their full layer parameters and the learned recipe for the type. Call this before vfx_create and copy what the references do.",
      inputSchema: { query: z.string().min(1).max(200), limit: z.number().int().min(1).max(6).optional() },
      handler: (args: { query: string; limit?: number }) =>
        guard(async () => {
          const hits = await service.search(args.query, { limit: args.limit ?? 3 })
          const tags = args.query.toLowerCase().split(/\W+/).filter(Boolean)
          const recipe = await service.recipeFor(tags)
          const parts: string[] = []
          if (!hits.length) parts.push('(no library entries match; the user can import references on the VFX Lab page)')
          for (const e of hits) parts.push(`## ${line(e)}${e.effect ? `\n${JSON.stringify(compactEffect(e.effect))}` : ''}`)
          if (recipe) parts.push(`## Learned recipe "${recipe.tag}" (${recipe.samples} refs)\n${JSON.stringify({ layers: recipe.layers, ranges: recipe.ranges, notes: recipe.notes, avoid: recipe.avoid })}`)
          return parts.join('\n\n').slice(0, 14000)
        })
    }
  ]
  const write: VfxTool[] = [
    {
      name: 'vfx_create',
      description: `Create (or with id, replace) a Roblox VFX from a spec. Writes the effect into the project as src/shared/VFX/<Name>/init.luau (a module: require(...).play(target)) plus Effect.rbxmx (the instances; Rojo syncs both), and adds it to the VFX Lab library. Returns the entry id and performance warnings. Then vfx_render to look at it, or vfx_refine to iterate.\n${SPEC_DOC}`,
      inputSchema: { spec: z.record(z.string(), z.any()), id: z.string().optional(), prompt: z.string().max(500).optional() },
      handler: (args: { spec: VfxSpec; id?: string; prompt?: string }) =>
        guard(async () => {
          const { entry, warnings } = await service.create(args.spec, { id: args.id, prompt: args.prompt ?? args.spec?.description })
          return [
            `${args.id ? 'updated' : 'created'} ${entry.id}: ${entry.name}`,
            entry.written ? `wrote ${entry.written.module} and ${entry.written.model}` : 'no project open: saved to the user library only',
            `stats: ${entry.stats?.emitters} emitters, ~${entry.stats?.particles} live particles, overdraw ${entry.stats?.overdraw}`,
            warnings.length ? `performance: ${warnings.map((w) => `${w.level} ${w.node ? `${w.node}: ` : ''}${w.message}`).join(' | ')}` : 'performance: ok'
          ].join('\n')
        })
    },
    {
      name: 'vfx_render',
      description:
        'Render an effect from the library (by id) with the WebGL preview (an approximation of Roblox: dark background, R15 dummy, 1-stud grid) and return PNG frames over one play, shown to the user inline. Also returns a critique (rubric scores and suggested parameter changes) from the vision model, or a numbers-only check when none is set up.',
      inputSchema: { id: z.string().min(1), frames: z.number().int().min(1).max(8).optional() },
      handler: (args: { id: string; frames?: number }) =>
        guard(async () => {
          const r = await service.render(args.id, args.frames ?? 4, 'render')
          const markers: string[] = []
          for (const [i, p] of r.abs.entries()) {
            const m = opts.chatImage ? await opts.chatImage(p, `${r.entry.name}-t${r.times[i]}.png`).catch(() => null) : null
            markers.push(m ? `${m} t=${r.times[i]}s` : `${p} (t=${r.times[i]}s)`)
          }
          const fs = await Promise.all(r.files.map((f) => service.file(r.entry.id, f)))
          const pngs = fs.filter((x): x is string => !!x).map((d) => Buffer.from(d.split(',')[1], 'base64'))
          const c = await service.critique(r.entry, r.entry.effect!, pngs, r.times, (r.entry.iterations?.length ?? 0) + 1, null)
          return [
            ...markers,
            `critique ${c.overall}/10 (${Object.entries(c.scores).map(([k, v]) => `${k} ${v}`).join(', ')}): ${c.summary}`,
            c.changes.length ? `suggested changes: ${JSON.stringify(c.changes)}` : 'no changes suggested',
            ...perfWarnings(r.entry.effect!).map((w) => `${w.level}: ${w.node ? `${w.node}: ` : ''}${w.message}`)
          ].join('\n')
        })
    },
    {
      name: 'vfx_refine',
      description:
        'Run the refine loop on an effect: render, critique against the closest library references with the rubric (readability, layering, timing, colour, silhouette, performance), apply the suggested changes, repeat until the score reaches threshold (default 7.5/10) or max_iterations (default 4). Keeps the best iteration, writes it back to the project and shows the iterations in the VFX Lab.',
      inputSchema: { id: z.string().min(1), max_iterations: z.number().int().min(1).max(8).optional(), threshold: z.number().min(1).max(10).optional() },
      handler: (args: { id: string; max_iterations?: number; threshold?: number }) =>
        guard(async () => {
          const r = await service.refine(args.id, { maxIterations: args.max_iterations, threshold: args.threshold })
          return [
            `refined ${r.entry.name} (${r.entry.id}): ${r.iterations.length} iteration(s), stopped: ${r.stop}`,
            ...r.iterations.map((it) => `#${it.n} ${it.critique.overall}/10: ${it.critique.summary}${it.rejected.length ? ` (rejected ${it.rejected.length} change(s): ${it.rejected.map((x) => x.reason).join('; ')})` : ''}`),
            `kept #${r.best.n} (${r.best.critique.overall}/10)${r.entry.written ? `, written to ${r.entry.written.module}` : ''}. The user can rate it on the VFX Lab page.`
          ].join('\n')
        })
    }
  ]
  return { read, write }
}

export function withVfxTools<T extends { read: any[]; write: any[] }>(sets: T, tools: { read: VfxTool[]; write: VfxTool[] } | null): T {
  if (!tools) return sets
  return { ...sets, read: [...sets.read, ...tools.read], write: [...sets.write, ...tools.write] }
}
