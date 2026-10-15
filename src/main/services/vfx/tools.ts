// Agent tools for the VFX Lab (ServiceTool shape: zod raw shape + handler).
//
//   vfx_search_library  read   closest library effects (compact parameters) + the learned recipe
//   vfx_create          write  spec -> library entry + src/shared/VFX/<Name>/init.luau + Effect.rbxmx
//   vfx_render          write  PNG frames from the offscreen preview (shown inline) + a critique
//   vfx_refine          write  render / critique / adjust loop until the score passes the threshold
//   vfx_kit             read   timeline API, the building-block kit and the choreography guide
//   vfx_compose         write  request -> scripted multi-stage effect (script + rigs) in one step
//   vfx_run_script      write  record a timeline script (Lune) -> errors with lines + cue summary
//   vfx_set_script      write  same, and save it on the entry (project files, preview, Script tab)

import { z } from 'zod'
import { nearestEffects } from '../../../shared/vfx/retrieve.ts'
import { perfWarnings } from '../../../shared/vfx/analyze.ts'
import { compactEffect, SpecError, type VfxSpec } from '../../../shared/vfx/spec.ts'
import type { VfxEntry, VfxScriptResult } from '../../../shared/vfx/types.ts'
import { CHOREOGRAPHY_GUIDE, kitReference } from '../../../shared/vfx/choreo.ts'
import { VFX_EXAMPLES } from '../../../shared/vfx/examples.ts'
import { PROCEDURAL_GUIDE } from '../../../shared/vfx/tex/textures.ts'
import type { VfxService } from './service.ts'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

export interface VfxTool {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  handler: (args: any, extra: unknown) => Promise<ToolResult>
}

export const VFX_READ_TOOLS = ['vfx_search_library', 'vfx_kit'] as const
export const VFX_WRITE_TOOLS = ['vfx_create', 'vfx_render', 'vfx_refine', 'vfx_compose', 'vfx_run_script', 'vfx_set_script'] as const

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
Values: ranges [min,max]; NumberSequence [[t,v],[t,v,envelope]]; ColorSequence ["#hex",...] or [[t,"#hex"],...]; vectors [x,y,z]; enums by name ("Top","VelocityParallel","Grid4x4","OneShot"); Texture "rbxassetid://<id>" (reuse ids from library references, never invent ids), "forgetex://<id>" (vfx_texture_list) or "forgetex://gen/<type>" (a free procedural texture).`

// What the assistant reads back after a script run: the error with its line, or stages + cues.
export function scriptReport(r: VfxScriptResult, script?: string): string {
  const out: string[] = []
  if (!r.ok) {
    const src = r.error?.line && script ? script.split('\n')[r.error.line - 1] : undefined
    out.push(`script error${r.error?.line ? ` at line ${r.error.line}` : ''}: ${r.error?.message ?? 'failed'}${src !== undefined ? `\n  ${r.error!.line} | ${src.trim()}` : ''}`)
  } else {
    if (r.entry) out.push(`${r.entry.id}: ${r.entry.name}${r.entry.written ? ` (wrote ${r.entry.written.module} + Timeline.luau)` : ''}${r.source ? `, script by ${r.source}` : ''}`)
    if (r.effect) out.push(`duration ${r.effect.duration.toFixed(2)} s, ${r.effect.cues.length} cues`)
    out.push(r.summary)
  }
  if (r.warnings.length) out.push(`warnings:\n${r.warnings.map((w) => `- ${w}`).join('\n')}`)
  if (r.prints.length) out.push(`print output:\n${r.prints.slice(0, 20).join('\n')}`)
  return out.join('\n').slice(0, 12000)
}

export function vfxTools(service: VfxService, opts: { chatImage?: (absPath: string, name: string) => Promise<string | null> } = {}): { read: VfxTool[]; write: VfxTool[] } {
  const read: VfxTool[] = [
    {
      name: 'vfx_search_library',
      description:
        "Search the user's Roblox VFX reference library (effects imported from .rbxm/.rbxmx, reference images, liked results) by keywords or tags (fire, slash, impact, aura, magic...). Returns the closest effects with their full layer parameters and the learned recipe for the type. Call this before vfx_create and copy what the references do.",
      inputSchema: { query: z.string().min(1).max(200), limit: z.number().int().min(1).max(6).optional() },
      handler: (args: { query: string; limit?: number }) =>
        guard(async () => {
          // Ranked by kind / element / colour / words, ratings and remix feedback; else the word search.
          const near = nearestEffects(args.query, await service.list(), { limit: args.limit ?? 3, feedback: await service.feedback() }).map((m) => m.entry)
          const hits = near.length ? near : await service.search(args.query, { limit: args.limit ?? 3 })
          const tags = args.query.toLowerCase().split(/\W+/).filter(Boolean)
          const recipe = await service.recipeFor(tags)
          const parts: string[] = []
          if (!hits.length) parts.push('(no library entries match; the user can import references on the VFX Lab page)')
          for (const e of hits) parts.push(`## ${line(e)}${e.effect ? `\n${JSON.stringify(compactEffect(e.effect))}` : ''}`)
          if (recipe) parts.push(`## Learned recipe "${recipe.tag}" (${recipe.samples} refs)\n${JSON.stringify({ layers: recipe.layers, ranges: recipe.ranges, notes: recipe.notes, avoid: recipe.avoid })}`)
          return parts.join('\n\n').slice(0, 14000)
        })
    },
    {
      name: 'vfx_kit',
      description:
        'Reference for multi-stage (scripted) VFX: the Luau timeline API (fx:spawn / tween / emit / wait / stage...), every building block in the kit (orb, glow, sparks, smoke, shockwave, flash, beam, trail, debris, aura, charge, impact, slash, dust, light) with its layers and options, the choreography guide (anticipation, charge, release, impact, dissipate; timing and easing rules), and the built-in example scripts. Read it before writing or editing a timeline script.',
      inputSchema: { example: z.string().max(40).optional() },
      handler: (args: { example?: string }) =>
        guard(async () => {
          const ex = args.example ? VFX_EXAMPLES.find((e) => e.key === args.example || e.name.toLowerCase() === args.example!.toLowerCase()) : null
          return [
            kitReference(),
            CHOREOGRAPHY_GUIDE,
            `## Textures\n${PROCEDURAL_GUIDE} vfx_texture_generate makes one (procedural or AI); vfx_texture_list shows the library.`,
            ex ? `## Example: ${ex.name}\n\`\`\`lua\n${ex.script}\`\`\`` : `## Examples (pass example to read one)\n${VFX_EXAMPLES.map((e) => `- ${e.key}: ${e.description}`).join('\n')}`
          ].join('\n\n')
        })
    }
  ]
  const write: VfxTool[] = [
    {
      name: 'vfx_create',
      description: `Create (or with id, replace) a Roblox VFX from a spec. Writes the effect into the project as src/shared/VFX/<Name>/init.luau (a module: require(...).play(target)) plus Effect.rbxmx (the instances; Rojo syncs both), and adds it to the VFX Lab library. Returns the entry id and performance warnings. Then vfx_render to look at it, or vfx_refine to iterate. For an effect with several beats over time (charge then release, projectiles that move, merges), use vfx_compose instead.\n${SPEC_DOC}`,
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
  write.push(
    {
      name: 'vfx_compose',
      description:
        "Make a multi-stage Roblox VFX (any request: a beam merge, a charged slash, a ground slam, a teleport...) in one step: writes a Luau timeline script with the kit (anticipation -> charge -> release -> impact -> dissipate), records it, saves the effect to the VFX library and the project (src/shared/VFX/<Name>/init.luau + Timeline.luau + Effect.rbxmx, and the ForgeFX runtime), then refines it in the background (render + critique at each stage). Pass script to use your own timeline script instead of drafting one. Returns the entry id, the stages and cues. Iterate with vfx_set_script and vfx_refine.",
      inputSchema: {
        request: z.string().min(3).max(500),
        script: z.string().max(60000).optional(),
        refine: z.boolean().optional(),
        reference: z.string().max(120).optional().describe('id of a video reference (ref_list / ref_import): "make it like this"; its beats, palette, glow, vision summary and key frames guide the script and the critic scores the match'),
        variations: z.number().int().min(1).max(3).optional().describe('draft this many scripts (1-3) and keep the one the critic (or the library-fit checks) prefers; default 1'),
        fromScratch: z.boolean().optional().describe("never copy or remix one of the user's library effects (no library copy, no reuse of their scripts); build every layer from kit rigs and use the library only as a style guide (ranges, textures, palettes, richness). Default false: a request naming a library effect (or close to one) builds on it, a scripted one through its script")
      },
      handler: (args: { request: string; script?: string; refine?: boolean; reference?: string; variations?: number; fromScratch?: boolean }) =>
        guard(async () => {
          const r = await service.compose(args.request, { script: args.script, refine: args.refine, reference: args.reference, variations: args.variations, ...(args.fromScratch ? { fromScratch: true } : {}) })
          return scriptReport(r, args.script) + (r.ok && r.refined ? '\nrefining in the background (watch the VFX Lab, or call vfx_refine to wait for it)' : '')
        })
    },
    {
      name: 'vfx_run_script',
      description:
        'Dry-run a Luau timeline script (return function(fx) ... end; see vfx_kit) without saving: records it with Lune and compiles the cues. Returns the error with its line number, or the stages and every cue (time, action, target, goals), plus warnings and print output. With id, runs against that entry (keeps its non-kit layers).',
      inputSchema: { script: z.string().min(1).max(60000), id: z.string().optional() },
      handler: (args: { script: string; id?: string }) => guard(async () => scriptReport(await service.runScript(args.script, { id: args.id }), args.script))
    },
    {
      name: 'vfx_set_script',
      description:
        "Set an effect's timeline script (by id; without id, creates a new scripted effect) and save it: the library entry, the VFX Lab preview and Script tab, and the project files (Timeline.luau next to init.luau; the module plays it with the ForgeFX runtime via TweenService). Parameter edits made by vfx_refine or the editor on kit layers are re-applied. Returns errors with line numbers or the stages and cues.",
      inputSchema: { script: z.string().min(1).max(60000), id: z.string().optional(), prompt: z.string().max(500).optional() },
      handler: (args: { script: string; id?: string; prompt?: string }) => guard(async () => scriptReport(await service.runScript(args.script, { id: args.id, save: true, prompt: args.prompt }), args.script))
    }
  )
  return { read, write }
}

export function withVfxTools<T extends { read: any[]; write: any[] }>(sets: T, tools: { read: VfxTool[]; write: VfxTool[] } | null): T {
  if (!tools) return sets
  return { ...sets, read: [...sets.read, ...tools.read], write: [...sets.write, ...tools.write] }
}
