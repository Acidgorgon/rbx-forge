// Agent tools for the Ability Composer (ServiceTool shape: zod raw shape + handler).
//
//   ability_list      read   the move library, one line each
//   ability_get       read   one move: JSON, resolved timeline, timing checks
//   ability_compose   write  request -> whole move (VFX via vfx_compose / library, clip via anim_compose /
//                            library / placeholder, timings by the default model or the draft rules)
//   ability_set       write  create or edit a move: top-level fields, event upserts by id, removals
//   ability_critique  write  timing rules + vision critic on frames at the key beats; apply: fix timings
//   ability_export    write  client Luau module + AbilityRunner into the game project

import { z } from 'zod'
import { timingChecks } from '../../../shared/ability/critique.ts'
import { AbilityError, applyPatch, normalizeAbility } from '../../../shared/ability/model.ts'
import { timelineText } from '../../../shared/ability/timing.ts'
import type { AbilityEntry } from '../../../shared/ability/types.ts'
import type { AbilityService } from './service.ts'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

export interface AbilityTool {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  handler: (args: any, extra: unknown) => Promise<ToolResult>
}

export const ABILITY_READ_TOOLS = ['ability_list', 'ability_get'] as const
export const ABILITY_WRITE_TOOLS = ['ability_compose', 'ability_set', 'ability_critique', 'ability_export'] as const

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

async function guard(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return ok(await fn())
  } catch (e) {
    return fail(e instanceof AbilityError ? `ability error: ${e.message}` : (e as Error).message)
  }
}

const EVENT_DOC = `Event kinds (every event: id, kind, at = {"at":seconds} or {"marker":"release","at":offset}):
vfx {effect: VFX Lab entry id, effectName, part: R15 part | attachment: RightGripAttachment / LeftGripAttachment / RootAttachment / BodyFrontAttachment..., offset [x,y,z] studs (-Z forward), rotation [x,y,z] degrees}
sound {source: {"kind":"asset","id":"rbxassetid://..."}, volume, pitch, part?}
shake {duration, amplitude studs, frequency Hz, falloff none|linear|exponential}
screen {effect flash|colorCorrection|bloom|blur, attack, hold, release, style (EasingStyle), values {color [r,g,b], opacity | brightness, contrast, saturation, tint | intensity, size, threshold | size}}
hitstop {duration real seconds, timeScale 0..1}
move {duration, velocity [x,y,z] studs/s in root space, easing constant|decay}
animation (top level) {clip, name, duration, markers [{name,t}], speed, start, fadeIn, assetId?}`

export async function abilityReport(service: AbilityService, entry: AbilityEntry): Promise<string> {
  const { ctx } = await service.context(entry.ability)
  const checks = timingChecks(entry.ability, ctx)
  return [
    `${entry.id} [${entry.scope}${entry.rating ? ` ${entry.rating === 'up' ? 'liked' : 'disliked'}` : ''}] ${entry.name}: ${entry.description || entry.origin}`,
    timelineText(entry.ability, ctx),
    `timing checks:\n${checks.map((c) => `- ${c.ok ? 'ok' : c.level}: ${c.message}`).join('\n')}`
  ].join('\n')
}

export function abilityTools(service: AbilityService): { read: AbilityTool[]; write: AbilityTool[] } {
  const read: AbilityTool[] = [
    {
      name: 'ability_list',
      description: "List the moves in the Ability Composer library (user + project): id, name, rating, origin. Use ability_get for one move's timeline.",
      inputSchema: {},
      handler: () =>
        guard(async () => {
          const all = await service.list()
          if (!all.length) return '(no moves yet: ability_compose makes one)'
          return all.map((e) => `${e.id} [${e.scope}${e.rating ? ` ${e.rating}` : ''}] ${e.name} (${e.ability.events.length} events, ${e.ability.duration}s): ${(e.description || e.origin).slice(0, 120)}`).join('\n')
        })
    },
    {
      name: 'ability_get',
      description: 'Read one move (by id): its resolved timeline (absolute times plus marker-relative refs), the timing checks, and the full JSON to edit with ability_set.',
      inputSchema: { id: z.string().min(1), json: z.boolean().optional() },
      handler: (args: { id: string; json?: boolean }) =>
        guard(async () => {
          const e = await service.get(args.id)
          return [await abilityReport(service, e), args.json === false ? '' : `json:\n${JSON.stringify(e.ability)}`].filter(Boolean).join('\n\n').slice(0, 16000)
        })
    }
  ]
  const write: AbilityTool[] = [
    {
      name: 'ability_compose',
      description:
        'Draft a whole Roblox move ("a charged palm blast", "Hollow Purple", "dash punch") in one step: picks a VFX Lab effect (or makes one with vfx_compose when the library has none) and an Animation Lab clip (or anim_compose, else a placeholder pose track), attaches the effect to the right R15 part, puts its release stage on the clip release marker, adds the impact flash, camera shake and hit-stop on the marker, build-ups and root movement, then lets the model refine the timings. Saves it to the Ability Composer and returns the timeline and checks.',
      inputSchema: { request: z.string().min(3).max(500) },
      handler: (args: { request: string }) =>
        guard(async () => {
          const r = await service.compose(args.request)
          return [
            `vfx: ${r.vfx ? `${r.vfx.name} (${r.vfx.id}, ${r.vfx.source})` : 'none'}; animation: ${r.animation ? `${r.animation.name} (${r.animation.id}, ${r.animation.source})` : 'none'}; timing by ${r.timing}`,
            ...r.notes.map((n) => `note: ${n}`),
            await abilityReport(service, r.entry)
          ].join('\n')
        })
    },
    {
      name: 'ability_set',
      description: `Create (no id; pass ability) or edit a move. ability: top-level fields to replace (name, description, tags, duration, animation, or a whole events list); events: upserts by id (only the fields you pass change; new ids are added); remove: event ids to delete. Prefer marker-relative times. Returns the timeline and timing checks.\n${EVENT_DOC}`,
      inputSchema: { id: z.string().optional(), ability: z.record(z.string(), z.any()).optional(), events: z.array(z.record(z.string(), z.any())).max(64).optional(), remove: z.array(z.string()).max(64).optional() },
      handler: (args: { id?: string; ability?: Record<string, unknown>; events?: Record<string, unknown>[]; remove?: string[] }) =>
        guard(async () => {
          if (!args.id) {
            if (!args.ability) throw new AbilityError('pass ability to create a move (or id to edit one)')
            const base = normalizeAbility(args.ability)
            const next = applyPatch(base, { events: args.events, remove: args.remove })
            return `created\n${await abilityReport(service, await service.save(next, { origin: 'assistant' }))}`
          }
          const cur = await service.get(args.id)
          const next = applyPatch(cur.ability, { ability: args.ability, events: args.events, remove: args.remove })
          return `updated\n${await abilityReport(service, await service.save(next, { id: cur.id }))}`
        })
    },
    {
      name: 'ability_critique',
      description:
        'Critique a move: timing rules (impact flash, camera shake, hit-stop and the effect release stage on the release marker within two frames; anticipation length; hit-stop 30-150 ms; follow-through) with concrete retimes, plus a vision critic on preview frames at the key beats (wind-up, anticipation, release, impact, follow-through) when a vision model and the renderer are available. apply: true applies the fixes and the critic edits.',
      inputSchema: { id: z.string().min(1), apply: z.boolean().optional(), vision: z.boolean().optional() },
      handler: (args: { id: string; apply?: boolean; vision?: boolean }) =>
        guard(async () => {
          const r = await service.critique(args.id, { apply: args.apply, vision: args.vision })
          const c = r.critique
          return [
            `overall ${c.overall}/10 (timing ${c.timingScore}/10${c.vision ? `, vision ${c.vision.overall}/10: ${Object.entries(c.vision.scores).map(([k, v]) => `${k} ${v}`).join(', ')}` : ', no vision critic'})`,
            c.summary,
            ...c.checks.filter((x) => !x.ok).map((x) => `- ${x.level}: ${x.message}${x.fix ? ` (fix: ${x.fix.event} -> ${JSON.stringify(x.fix.at ?? {})}${x.fix.duration ? ` duration ${x.fix.duration}` : ''})` : ''}`),
            ...(c.vision?.changes ?? []).map((ch) => `- critic: ${ch.event}.${ch.field} = ${JSON.stringify(ch.value)}${ch.why ? ` (${ch.why})` : ''}`),
            r.applied.length ? `applied: ${r.applied.join(', ')}` : args.apply ? 'nothing to apply' : 'pass apply: true to apply the fixes'
          ].join('\n')
        })
    },
    {
      name: 'ability_export',
      description:
        'Export a move to the game: writes <Name>.luau (data + play()) and the shared AbilityRunner.luau (client: animation, VFX Lab modules on body parts, sounds, camera shake, screen effects, hit-stop, root velocity; options.onMarker for gameplay hooks) into src/skills/Client/Abilities (FSF-style projects) or src/shared/Abilities. No server code. Returns the files, the require path and warnings (missing asset ids...).',
      inputSchema: { id: z.string().min(1) },
      handler: (args: { id: string }) =>
        guard(async () => {
          const r = await service.export(args.id)
          return [`wrote ${r.files.join(', ')}`, r.command ? `play it (client): ${r.command}` : '', ...r.warnings.map((w) => `warning: ${w}`)].filter(Boolean).join('\n')
        })
    }
  ]
  return { read, write }
}

export function withAbilityTools<T extends { read: any[]; write: any[] }>(sets: T, tools: { read: AbilityTool[]; write: AbilityTool[] } | null): T {
  if (!tools) return sets
  return { ...sets, read: [...sets.read, ...tools.read], write: [...sets.write, ...tools.write] }
}
