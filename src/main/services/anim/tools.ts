// Agent tools for the Animation Lab (ServiceTool shape: zod raw shape + handler).
//
//   anim_kit             read   timeline API, the pose kit, the animation guide, the learned style
//   anim_search_library  read   library clips by tags / words (liked first, "avoid" clips listed apart)
//   anim_compose         write  request -> R15 clip (script by the default model or the draft) + refine
//   anim_run_script      write  record a timeline script (Lune) -> errors with lines + key summary + checks
//   anim_set_script      write  same, and save it on the entry (library, preview, project files)
//   anim_critique        write  automatic checks + render the key beats + critic; refine: loop to the threshold
//   anim_convert_rig     write  convert a clip between R15 and R6 (in place or as a copy; R15 -> R6 loses bends)
//
// Every tool that makes or reads clips takes an optional rig ("R15" | "R6"); without it the project's
// rig (the Animation Lab header toggle) is used, and an existing clip keeps its own rig.

import { z } from 'zod'
import type { AnimEntry, AnimScriptResult, RigType } from '../../../shared/anim/model.ts'
import { ANIM_API, ANIM_API_R6, ANIM_GUIDE, kitReferenceText } from '../../../shared/anim/draft.ts'
import { clipRig } from '../../../shared/anim/sample.ts'
import { ANIM_EXAMPLES } from '../../../shared/anim/examples.ts'
import { profileFor, profileText, promptTags } from '../../../shared/anim/style.ts'
import { runChecks } from '../../../shared/anim/checks.ts'
import { beatFrameTimes } from '../../../shared/anim/critique.ts'
import type { AnimService } from './service.ts'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

export interface AnimTool {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  handler: (args: any, extra: unknown) => Promise<ToolResult>
}

export const ANIM_READ_TOOLS = ['anim_kit', 'anim_search_library'] as const
export const ANIM_WRITE_TOOLS = ['anim_compose', 'anim_run_script', 'anim_set_script', 'anim_critique', 'anim_convert_rig'] as const

const rigArg = z.enum(['R15', 'R6']).optional()

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

async function guard(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return ok(await fn())
  } catch (e) {
    return fail((e as Error).message)
  }
}

function line(e: AnimEntry): string {
  const mark = e.quality === 'avoid' || e.rating === 'down' ? ' AVOID' : e.rating === 'up' ? ' liked' : ''
  return `${e.id} [${e.scope} ${e.kind} ${clipRig(e.clip)}${mark}] ${e.name} (${e.tags.join(', ')}; ${e.clip.duration.toFixed(2)} s${e.clip.looped ? ', looped' : ''}): ${e.description.slice(0, 240)}${e.notes ? ` Notes: ${e.notes.slice(0, 160)}` : ''}`
}

export function animScriptReport(r: AnimScriptResult, script?: string): string {
  const out: string[] = []
  if (!r.ok) {
    const src = r.error?.line && script ? script.split('\n')[r.error.line - 1] : undefined
    out.push(`script error${r.error?.line ? ` at line ${r.error.line}` : ''}: ${r.error?.message ?? 'failed'}${src !== undefined ? `\n  ${r.error!.line} | ${src.trim()}` : ''}`)
  } else {
    if (r.entry) out.push(`${r.entry.id}: ${r.entry.name}${r.entry.written ? ` (wrote ${r.entry.written.module} + Sequence.rbxmx)` : ''}${r.source ? `, script by ${r.source}` : ''}`)
    if (r.clip) out.push(`duration ${r.clip.duration.toFixed(2)} s${r.clip.looped ? ' (looped)' : ''}, priority ${r.clip.priority}, markers ${r.clip.markers.map((m) => `${m.name}@${m.t.toFixed(2)}`).join(', ') || 'none'}`)
    if (r.checks) out.push(`checks ${r.checks.overall}/10 (${Object.entries(r.checks.scores).map(([k, v]) => `${k} ${v}`).join(', ')})${r.checks.issues.length ? `\n${r.checks.issues.slice(0, 8).map((i) => `- ${i.severity}: ${i.message}`).join('\n')}` : ''}`)
    out.push(r.summary)
  }
  if (r.warnings.length) out.push(`warnings:\n${r.warnings.map((w) => `- ${w}`).join('\n')}`)
  if (r.prints.length) out.push(`print output:\n${r.prints.slice(0, 20).join('\n')}`)
  return out.join('\n').slice(0, 12000)
}

export function animTools(service: AnimService): { read: AnimTool[]; write: AnimTool[] } {
  const read: AnimTool[] = [
    {
      name: 'anim_kit',
      description:
        'Reference for making Roblox animations (R15 or R6) in the Animation Lab: the Luau timeline API (a:pose / joint / ik / plant / look / root / hold / overlap / marker / beat / mirror / rig), the pose kit (guard, windup, punch_extend, palm_push, two_finger_sign, crouch, land, recoil...) and its R6 versions, the animation guide (anticipation, action, recovery, arcs, overlap), the learned style for a move type on that rig, and the built-in example scripts. rig defaults to the project rig. Read it before writing a timeline script.',
      inputSchema: { tags: z.string().max(120).optional(), example: z.string().max(40).optional(), rig: rigArg },
      handler: (args: { tags?: string; example?: string; rig?: RigType }) =>
        guard(async () => {
          const rig = args.rig ?? (await service.rig())
          const ex = args.example ? ANIM_EXAMPLES.find((e) => e.key === args.example || e.name.toLowerCase() === args.example!.toLowerCase()) : null
          const profile = profileFor(await service.style(), promptTags(args.tags ?? ''), rig)
          return [
            `Rig: ${rig}${rig === 'R6' ? '' : ' (pass rig: "R6" for the R6 notes)'}`,
            ANIM_API,
            ...(rig === 'R6' ? [ANIM_API_R6] : []),
            kitReferenceText(rig),
            ANIM_GUIDE,
            profile ? profileText(profile) : 'No learned style yet (import reference clips on the Animation Lab page).',
            ex ? `## Example: ${ex.name} (${ex.rig ?? 'R15'})\n\`\`\`lua\n${ex.script}\`\`\`` : `## Examples (pass example to read one)\n${ANIM_EXAMPLES.map((e) => `- ${e.key} (${e.rig ?? 'R15'}): ${e.description}`).join('\n')}`
          ].join('\n\n')
        })
    },
    {
      name: 'anim_search_library',
      description:
        "Search the user's animation library (imported KeyframeSequences / BVH and generated clips) by move type tags (attack, kick, cast, sign, dash, idle, hit, block, jump...) or words. Liked clips rank first; clips the user marked AVOID are listed separately as what not to do. Returns ids, timing, markers and notes.",
      inputSchema: { query: z.string().min(1).max(200), limit: z.number().int().min(1).max(10).optional(), rig: rigArg },
      handler: (args: { query: string; limit?: number; rig?: RigType }) =>
        guard(async () => {
          const all = await service.search(args.query, { limit: 20 })
          const hits = (args.rig ? all.filter((e) => clipRig(e.clip) === args.rig) : all).slice(0, args.limit ?? 5)
          const bad = (await service.search(args.query, { limit: 20, includeAvoid: true })).filter((e) => e.quality === 'avoid' || e.rating === 'down').slice(0, 3)
          const parts = hits.length ? hits.map(line) : ['(no library clips match; the user can import references on the Animation Lab page)']
          if (bad.length) parts.push('', 'Marked AVOID by the user (never copy):', ...bad.map(line))
          const profile = profileFor(await service.style(), promptTags(args.query), args.rig ?? (await service.rig()))
          if (profile) parts.push('', profileText(profile))
          return parts.join('\n').slice(0, 12000)
        })
    }
  ]
  const write: AnimTool[] = [
    {
      name: 'anim_compose',
      description:
        'Make an R15 or R6 animation (rig, default: the project rig) from a request (a heavy punch, a hand sign into a palm push, a dodge roll, a hit reaction, an idle...): drafts a Luau timeline script with the pose kit in the learned style of the user\'s library, records it into keyframes, runs the automatic checks (foot sliding, joint limits, interpenetration, readability, timing), saves it to the Animation Lab library and refines it in the background (render the key beats + critique). Pass script to use your own timeline script. Add a:marker(...) at the moments game code or VFX should sync to. Iterate with anim_set_script and anim_critique.',
      inputSchema: { request: z.string().min(3).max(500), script: z.string().max(60000).optional(), refine: z.boolean().optional(), rig: rigArg },
      handler: (args: { request: string; script?: string; refine?: boolean; rig?: RigType }) =>
        guard(async () => {
          const r = await service.compose(args.request, { script: args.script, refine: args.refine, rig: args.rig })
          return animScriptReport(r, args.script) + (r.ok && r.refined ? '\nrefining in the background (watch the Animation Lab, or call anim_critique with refine to wait for it)' : '')
        })
    },
    {
      name: 'anim_run_script',
      description:
        'Dry-run an animation timeline script (return function(a) ... end; see anim_kit) without saving: records it with Lune for the rig (R15 or R6, default the project rig; a:rig in the script wins), compiles the keyframes and runs the automatic checks. Returns the error with its line number, or the keys per time, markers, check scores and issues.',
      inputSchema: { script: z.string().min(1).max(60000), rig: rigArg },
      handler: (args: { script: string; rig?: RigType }) => guard(async () => animScriptReport(await service.runScript(args.script, { rig: args.rig }), args.script))
    },
    {
      name: 'anim_set_script',
      description:
        "Set a clip's timeline script (by id; without id, creates a new clip) and save it: the library entry, the Animation Lab preview and Script tab, and the project files when it was exported. Returns errors with line numbers or the keys, markers and checks.",
      inputSchema: { script: z.string().min(1).max(60000), id: z.string().optional(), prompt: z.string().max(500).optional(), rig: rigArg },
      handler: (args: { script: string; id?: string; prompt?: string; rig?: RigType }) => guard(async () => animScriptReport(await service.runScript(args.script, { id: args.id, save: true, prompt: args.prompt, rig: args.rig }), args.script))
    },
    {
      name: 'anim_critique',
      description:
        'Critique a clip (by id): the automatic checks, plus frames of the R15 dummy at its key beats sent to the critic model with a rubric (silhouette, timing, weight, arcs, appeal, cleanliness) against the learned style and library references. With refine: true, applies the suggested changes and repeats until the score reaches threshold (default 7.5) or max_iterations (default 4), keeping the best iteration.',
      inputSchema: { id: z.string().min(1), refine: z.boolean().optional(), max_iterations: z.number().int().min(1).max(8).optional(), threshold: z.number().min(1).max(10).optional() },
      handler: (args: { id: string; refine?: boolean; max_iterations?: number; threshold?: number }) =>
        guard(async () => {
          if (args.refine) {
            const r = await service.refine(args.id, { maxIterations: args.max_iterations, threshold: args.threshold })
            const its = r.entry.iterations ?? []
            return [
              `refined ${r.entry.name} (${r.entry.id}), stopped: ${r.stop}, best ${r.score}/10`,
              ...its.slice(-6).map((it) => `#${it.n} ${it.critique?.overall ?? '?'}/10: ${it.critique?.summary ?? ''}`),
              'The user can rate it on the Animation Lab page.'
            ].join('\n')
          }
          const entry = await service.get(args.id)
          const checks = runChecks(entry.clip, profileFor(await service.style(), entry.tags, clipRig(entry.clip)))
          const times = beatFrameTimes(entry.clip, 6)
          const frames = service.canRender() ? await service.renderClip(entry.clip, times).catch(() => [] as Buffer[]) : []
          const c = await service.critique(entry, entry.clip, frames, times, (entry.iterations?.length ?? 0) + 1, null)
          return [
            `checks ${checks.overall}/10: ${checks.issues.slice(0, 6).map((i) => i.message).join('; ') || 'no issues'}`,
            `critique ${c.overall}/10 (${Object.entries(c.scores).map(([k, v]) => `${k} ${v}`).join(', ')}): ${c.summary}`,
            c.changes.length ? `suggested changes: ${JSON.stringify(c.changes)}` : 'no changes suggested'
          ].join('\n')
        })
    }
  ]
  write.push({
    name: 'anim_convert_rig',
    description:
      'Convert an Animation Lab clip (by id) to the other rig. R15 -> R6 merges the torso into one part and each arm / leg into one straight part that keeps the overall limb direction: waist, elbow, wrist, knee and ankle bends are lost. R6 -> R15 maps RootJoint / Neck / shoulders / hips onto R15 (lossless; the new joints start at rest). copy: true keeps the original and saves the converted clip as a new entry.',
    inputSchema: { id: z.string().min(1), to: z.enum(['R15', 'R6']), copy: z.boolean().optional() },
    handler: (args: { id: string; to: RigType; copy?: boolean }) =>
      guard(async () => {
        const r = await service.convert(args.id, args.to, { copy: args.copy })
        return `${r.entry.id}: ${r.entry.name} is now ${clipRig(r.entry.clip)}${args.copy ? ' (a copy; the original is unchanged)' : ''}.\nWarning: ${r.warning}`
      })
  })
  return { read, write }
}

export function withAnimTools<T extends { read: any[]; write: any[] }>(sets: T, tools: { read: AnimTool[]; write: AnimTool[] } | null): T {
  if (!tools) return sets
  return { ...sets, read: [...sets.read, ...tools.read], write: [...sets.write, ...tools.write] }
}
