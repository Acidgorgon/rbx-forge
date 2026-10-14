// Agent tools for VFX textures (ServiceTool shape: zod raw shape + handler).
//
//   vfx_texture_list      read   library textures (liked first) + the procedural types and refs
//   vfx_texture_generate  write  procedural (free) or AI texture -> library item + forgetex:// ref

import { z } from 'zod'
import { PROCEDURAL_GUIDE, TEXTURE_KINDS, textureLine, texRef } from '../../../../shared/vfx/tex/textures.ts'
import { PROCEDURAL_PARAMS, PROCEDURAL_TYPES } from '../../../../shared/vfx/tex/procedural.ts'
import type { TextureService } from './service.ts'
import { generationAllowed, libraryPromptLines } from '../../../../shared/vfx/tex/reuse.ts'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

export interface TextureTool {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  handler: (args: any, extra: unknown) => Promise<ToolResult>
}

export const TEXTURE_READ_TOOLS = ['vfx_texture_list'] as const
export const TEXTURE_WRITE_TOOLS = ['vfx_texture_generate'] as const

async function guard(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: await fn() }] }
  } catch (e) {
    return { content: [{ type: 'text', text: (e as Error).message }], isError: true }
  }
}

const PARAM_DOC = PROCEDURAL_TYPES.map((t) => `${t}(${Object.entries(PROCEDURAL_PARAMS[t]).map(([k, s]) => `${k} ${s.min}-${s.max}`).join(', ')})`).join('; ')

export function textureTools(service: TextureService, opts: { chatImage?: (absPath: string, name: string) => Promise<string | null> } = {}): { read: TextureTool[]; write: TextureTool[] } {
  const read: TextureTool[] = [
    {
      name: 'vfx_texture_list',
      description: `List the custom VFX textures in the user's library (user + project; liked first, disliked marked) with their forgetex:// references, kind, tint, flipbook layout and upload state. ${PROCEDURAL_GUIDE}`,
      inputSchema: { query: z.string().max(200).optional(), limit: z.number().int().min(1).max(40).optional() },
      handler: (args: { query?: string; limit?: number }) =>
        guard(async () => {
          const hits = args.query ? await service.search(args.query, args.limit ?? 20) : (await service.list()).slice(0, args.limit ?? 20)
          const policy = libraryPromptLines([], service.policy())[0]
          return [policy, '', hits.length ? hits.map(textureLine).join('\n') : '(no textures yet; the user can import a folder of textures in VFX Lab > Textures, or vfx_texture_generate makes one)', '', PROCEDURAL_GUIDE].join('\n')
        })
    }
  ]
  const write: TextureTool[] = [
    {
      name: 'vfx_texture_generate',
      description: `Make a NEW custom particle / beam texture and add it to the texture library. Reuse first: call vfx_texture_list and use a library texture when one fits; the VFX Lab texture setting (library only / library first / generate freely) decides whether new ones may be made, and this tool answers with the fitting library textures instead unless user_asked is true (only when the user explicitly asked for a new texture). procedural=true (default when the type has a generator: ${PROCEDURAL_TYPES.join(', ')}) is free and exact; procedural=false uses the OpenAI image model (costs money, counts against the Art page's daily budget) for shapes code cannot draw (energy wisps, stylised flames, debris). Textures are white on transparent so ParticleEmitter.Color tints them (tint "grey" keeps shading for smoke). frames 4/16/64 makes a flipbook sheet (Grid2x2/4x4/8x8; set FlipbookLayout to match and FlipbookMode OneShot or Loop). Returns the forgetex://<id> reference to put in Texture (or the kit's texture option); it previews immediately and becomes rbxassetid:// when the user uploads it. Procedural params: ${PARAM_DOC}.`,
      inputSchema: {
        type: z.enum(TEXTURE_KINDS),
        description: z.string().max(800).optional(),
        procedural: z.boolean().optional(),
        params: z.record(z.string(), z.number()).optional(),
        seed: z.number().int().min(0).max(100000).optional(),
        frames: z.union([z.literal(1), z.literal(4), z.literal(16), z.literal(64)]).optional(),
        tint: z.enum(['white', 'grey', 'color']).optional(),
        variants: z.number().int().min(1).max(4).optional(),
        user_asked: z.boolean().optional()
      },
      handler: (args: { type: (typeof TEXTURE_KINDS)[number]; description?: string; procedural?: boolean; params?: Record<string, number>; seed?: number; frames?: number; tint?: 'white' | 'grey' | 'color'; variants?: number; user_asked?: boolean }) =>
        guard(async () => {
          const gate = generationAllowed(await service.list(), service.policy(), args.type, !!args.user_asked)
          if (!gate.ok) return [gate.reason, ...(gate.alternatives.length ? ['', ...gate.alternatives.map(textureLine)] : ['(no fitting library texture: keep a built-in rbxasset texture for this layer)'])].join('\n')
          const procType = (PROCEDURAL_TYPES as readonly string[]).includes(args.type) ? args.type : args.type === 'shockwave' ? 'ring' : args.type === 'flare' ? 'star' : null
          const ai = args.procedural === false || (args.procedural !== true && !procType)
          const items = await service.generate({
            kind: args.type,
            description: args.description,
            ai,
            ...(!ai && procType ? { procedural: { type: procType as (typeof PROCEDURAL_TYPES)[number], params: args.params, seed: args.seed } } : {}),
            frames: args.frames,
            tint: args.tint,
            n: args.variants,
            source: 'agent'
          })
          const lines: string[] = []
          for (const t of items) {
            const hit = await service.find(t.id)
            const abs = hit ? hit.store.filePath(t.id, t.preview) : null
            const marker = abs && opts.chatImage ? await opts.chatImage(abs, `${t.name}.png`).catch(() => null) : null
            lines.push(`${texRef(t.id)}  ${t.name} (${t.source}${t.flipbook ? `, ${t.flipbook.layout} flipbook: set FlipbookLayout "${t.flipbook.layout}"` : ''}${t.costUsd ? `, ~$${t.costUsd.toFixed(3)}` : ''})${marker ? `\n${marker}` : ''}`)
          }
          lines.push('Use the reference as Texture. It is local until uploaded (VFX Lab > textures > Upload); until then exported project files use a built-in fallback.')
          return lines.join('\n')
        })
    }
  ]
  return { read, write }
}
