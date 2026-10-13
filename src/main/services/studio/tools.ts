// Agent tools for the Studio check (ServiceTool shape: zod raw shape + handler).
//
//   studio_status  read   is Roblox Studio connected through the Forge Bridge plugin, and why not
//   studio_check   write  NEEDS ROBLOX STUDIO: play a lab item in Studio, capture the key beats

import { z } from 'zod'
import type { StudioService } from './service.ts'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

export interface StudioTool {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  handler: (args: any, extra: unknown) => Promise<ToolResult>
}

export const STUDIO_READ_TOOLS = ['studio_status'] as const
export const STUDIO_WRITE_TOOLS = ['studio_check'] as const

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

export function studioTools(service: StudioService, opts: { chatImage?: (absPath: string, name: string) => Promise<string | null> } = {}): { read: StudioTool[]; write: StudioTool[] } {
  const read: StudioTool[] = [
    {
      name: 'studio_status',
      description: "Whether the user's Roblox Studio is connected to Forge through the Forge Bridge plugin (needed by studio_check), and what to do if not: install the plugin, open Studio, allow screen recording.",
      inputSchema: {},
      handler: async () => {
        const s = await service.status()
        return ok(`${s.state}: ${s.message}${s.prefer ? '\n"Critique in Studio when connected" is on: refine loops use Studio frames while Studio is connected.' : ''}`)
      }
    }
  ]
  const write: StudioTool[] = [
    {
      name: 'studio_check',
      description:
        "NEEDS ROBLOX STUDIO (open, visible, with the Forge Bridge plugin; check studio_status first). Plays a VFX Lab effect (kind vfx), Animation Lab clip (anim) or Ability Composer move (ability) in the user's real Roblox Studio on a neutral stage, captures the frames at the key beats (stages / markers), stores them with the library entry next to preview frames, and with critique=true runs the lab's critic on the Studio frames. Use it to confirm how something really looks in Roblox before calling it done. Returns the frames (entry files) and a status; fails with the reason when Studio is not connected.",
      inputSchema: { kind: z.enum(['vfx', 'anim', 'ability']), id: z.string().min(1).max(200), critique: z.boolean().optional() },
      handler: async (args: { kind: 'vfx' | 'anim' | 'ability'; id: string; critique?: boolean }) => {
        try {
          const r = await service.check(args.kind, args.id, { critique: args.critique !== false })
          const images: string[] = []
          for (const [i, p] of (r.abs ?? []).entries()) {
            const m = opts.chatImage ? await opts.chatImage(p, `${r.name}-studio-${i + 1}.png`).catch(() => null) : null
            if (m) images.push(`${m} ${r.frames[i]?.label ?? ''} (Studio)`)
          }
          const lines = [
            `Studio check of ${args.kind} "${r.name}" (${r.mode}, ${r.frames.length} frame(s) from "${r.window ?? 'Studio'}"${r.place ? `, place ${r.place}` : ''}, ${Math.round(r.ms / 100) / 10} s):`,
            ...r.frames.map((f) => `- ${f.label} @ ${f.t.toFixed(2)} s: ${f.file}${f.preview ? ` (preview: ${f.preview})` : ''}${f.offsetMs !== undefined ? ` · capture offset ${f.offsetMs} ms` : ''}`),
            r.marks.length ? `marks reported by Studio: ${r.marks.map((m) => `${m.label} @ ${m.t.toFixed(2)} s`).join(', ')}` : '',
            r.drift?.length ? `stage timing (planned -> Studio): ${r.drift.map((d) => `${d.label} ${d.planned.toFixed(2)} -> ${d.actual.toFixed(2)} s`).join(', ')}` : '',
            r.critique ? `critique on the Studio frames ${r.critique.overall}/10: ${r.critique.summary}` : '',
            r.crop ? '' : 'note: the Studio viewport was not found in the capture; frames are the whole Studio window.',
            ...images
          ]
          return ok(lines.filter(Boolean).join('\n'))
        } catch (e) {
          const s = await service.status().catch(() => null)
          return fail(`Studio check failed: ${(e as Error).message}${s && s.state !== 'ready' ? `\nStudio status: ${s.state}: ${s.message}` : ''}\nThe preview-based tools (vfx_render, vfx_refine, anim_critique, ability_critique) still work without Studio.`)
        }
      }
    }
  ]
  return { read, write }
}

export function withStudioTools<T extends { read: any[]; write: any[] }>(sets: T, tools: { read: StudioTool[]; write: StudioTool[] } | null): T {
  if (!tools) return sets
  return { ...sets, read: [...sets.read, ...tools.read], write: [...sets.write, ...tools.write] }
}
