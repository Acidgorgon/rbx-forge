// Agent tools for video references (ServiceTool shape: zod raw shape + handler).
//
//   ref_list    read   video references of the VFX Lab / Animation Lab (id, beats, palette, summary)
//   ref_get     read   one reference: beats, palette per beat, glow, motion, holds, vision summary
//                      (and the contact sheet shown inline in the chat)
//   ref_import  write  a clip / GIF from a path -> decode offscreen, analyse, vision summary, library

import { z } from 'zod'
import { paletteText } from '../../../shared/videoref/analyze.ts'
import { glowText, motionText, segmentsText, timelineText, visionText } from '../../../shared/videoref/prompt.ts'
import type { RefEntry, RefLab } from '../../../shared/videoref/types.ts'
import type { RefService } from './service.ts'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

export interface RefTool {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  handler: (args: any, extra: unknown) => Promise<ToolResult>
}

export const REF_READ_TOOLS = ['ref_list', 'ref_get'] as const
export const REF_WRITE_TOOLS = ['ref_import'] as const

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

async function guard(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return ok(await fn())
  } catch (e) {
    return fail((e as Error).message)
  }
}

export function refLine(r: RefEntry): string {
  const a = r.video.analysis
  return `${r.id} [${r.lab === 'anim' ? 'Animation Lab' : 'VFX Lab'} ${r.scope}${r.rating ? ` ${r.rating === 'up' ? 'liked' : 'disliked'}` : ''}] ${r.name} (${r.tags.join(', ')}; ${a.duration.toFixed(2)} s): ${a.segments.map((s) => s.label).join(' > ') || 'one beat'}; ${r.video.vision ? r.video.vision.summary.slice(0, 200) : 'no vision summary yet'}`
}

export function refReport(r: RefEntry): string {
  const a = r.video.analysis
  const lines = [
    refLine(r),
    `source: ${r.video.source.name} (${r.video.source.width}x${r.video.source.height}, ${r.video.source.duration.toFixed(2)} s), trim ${r.video.trim.start.toFixed(2)}-${r.video.trim.end.toFixed(2)} s, ${a.frames.length} frames at ${a.fps} fps`,
    `beats: ${segmentsText(a)}`,
    `beat peaks: ${a.peaks.map((p) => `${p.t.toFixed(2)} s (${Math.round(p.strength * 100)}%)`).join(', ') || 'none'}${a.flashes.length ? `; flash frames ${a.flashes.map((t) => t.toFixed(2)).join(', ')} s` : ''}`,
    `palette: ${paletteText(a.palette)}`,
    ...a.segments.filter((s) => s.palette.length).map((s) => `  ${s.label}: ${paletteText(s.palette)}`),
    `glow: ${glowText(a)}`,
    `motion: ${motionText(a)}`,
    r.lab === 'anim' ? `holds / fast motion: ${timelineText(a)}` : '',
    `key frames: ${a.keyFrames.map((k) => `${k.label} @ ${k.t.toFixed(2)} s`).join(', ')}`,
    visionText(r.video.vision, r.lab),
    r.notes ? `notes: ${r.notes}` : '',
    `To make something like it: ${r.lab === 'anim' ? 'anim_compose' : 'vfx_compose'} with reference "${r.id}".`
  ]
  return lines.filter(Boolean).join('\n').slice(0, 12000)
}

export function refTools(service: RefService, opts: { chatImage?: (absPath: string, name: string) => Promise<string | null>; sheetPath?: (r: RefEntry) => Promise<string | null> } = {}): { read: RefTool[]; write: RefTool[] } {
  const inline = async (r: RefEntry): Promise<string> => {
    if (!opts.chatImage || !opts.sheetPath) return ''
    const p = await opts.sheetPath(r).catch(() => null)
    const m = p ? await opts.chatImage(p, `${r.name}-sheet.png`).catch(() => null) : null
    return m ? `\n${m}` : ''
  }
  const read: RefTool[] = [
    {
      name: 'ref_list',
      description: "List the user's video references (clips and GIFs they dropped into the VFX Lab or Animation Lab as \"make it like this\" references): id, lab, tags, beats and the vision summary. Optional lab (vfx | anim) and query (matches name, tags, summary).",
      inputSchema: { lab: z.enum(['vfx', 'anim']).optional(), query: z.string().max(200).optional() },
      handler: (args: { lab?: RefLab; query?: string }) =>
        guard(async () => {
          const words = (args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
          const all = (await service.list(args.lab)).filter((r) => words.every((w) => `${r.name} ${r.tags.join(' ')} ${r.description} ${r.notes}`.toLowerCase().includes(w)))
          return all.length ? all.slice(0, 40).map(refLine).join('\n') : 'No video references yet. Import one with ref_import (a path to an .mp4 / .webm / .mov / .gif) or drop a clip on the VFX Lab or Animation Lab.'
        })
    },
    {
      name: 'ref_get',
      description: 'Read one video reference by id: the measured beats (anticipation / release / impact / dissipate), beat peaks and flash frames, palette per beat, glow, screen-space motion, holds versus fast motion (Animation Lab), key frames and the vision summary (layers, shapes, poses per beat). Shows the contact sheet inline.',
      inputSchema: { id: z.string().min(1).max(120) },
      handler: (args: { id: string }) =>
        guard(async () => {
          const r = await service.get(args.id)
          return refReport(r) + (await inline(r))
        })
    }
  ]
  const write: RefTool[] = [
    {
      name: 'ref_import',
      description:
        'Import a video reference from a file path (.mp4, .webm, .mov where Chromium can decode it, or .gif) into the VFX Lab (lab "vfx", default) or the Animation Lab (lab "anim"): decodes it offscreen (optionally only start..end seconds), measures beats, flashes, palette, glow and motion, makes a contact sheet and key frames, asks the vision model for a structured description, and saves it to the library (scope user or project). Then use vfx_compose / anim_compose with reference = the returned id.',
      inputSchema: {
        path: z.string().min(1).max(1000),
        lab: z.enum(['vfx', 'anim']).optional(),
        name: z.string().max(80).optional(),
        tags: z.array(z.string().max(24)).max(12).optional(),
        notes: z.string().max(1000).optional(),
        start: z.number().min(0).optional(),
        end: z.number().min(0).optional(),
        scope: z.enum(['user', 'project']).optional()
      },
      handler: (args: { path: string; lab?: RefLab; name?: string; tags?: string[]; notes?: string; start?: number; end?: number; scope?: 'user' | 'project' }) =>
        guard(async () => {
          const r = await service.importPath(args.path, { lab: args.lab, name: args.name, tags: args.tags, notes: args.notes, start: args.start, end: args.end, scope: args.scope })
          return `imported ${refReport(r)}${await inline(r)}`
        })
    }
  ]
  return { read, write }
}

export function withRefTools<T extends { read: any[]; write: any[] }>(sets: T, tools: { read: RefTool[]; write: RefTool[] } | null): T {
  if (!tools) return sets
  return { ...sets, read: [...sets.read, ...tools.read], write: [...sets.write, ...tools.write] }
}
