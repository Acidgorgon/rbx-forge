// Agent tools for the art workflow. Structurally GentreeTool / ServiceTool (zod raw shape + handler).
// All three are write tools (they spend money, write files or upload): the main chat, a group chat
// host and writer agents get them; read-only guests, test agents and scouts do not.
//
//   generate_image          OpenAI image generation / edit, saved under art/concepts, shown inline
//   import_image_to_roblox  upload to Roblox (Open Cloud Assets) + src/shared/Assets/Images.luau
//   list_art                recent concepts with their paths and Roblox ids

import { z } from 'zod'
import type { ArtItem } from '../../../shared/artTypes.ts'
import { formatUsd } from './pricing.ts'
import type { ArtService } from './service.ts'
import { AGENT_MAX_VARIANTS } from './service.ts'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

export interface ArtTool {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  handler: (args: any, extra: unknown) => Promise<ToolResult>
}

export const ART_TOOL_NAMES = ['generate_image', 'import_image_to_roblox', 'list_art'] as const

export interface ArtToolDeps {
  service: ArtService
  // Copies an image into the chat image store and returns the inline marker the chat renders
  // (agent/chatImages.ts imageMarker). Without it, results carry paths only.
  chatImage?: (absPath: string, name: string) => Promise<string | null>
}

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

function line(i: ArtItem): string {
  const bits = [i.path, i.size, i.quality, i.background === 'transparent' ? 'transparent' : null, i.roblox ? i.roblox.uri : null, i.savedAs ? `saved ${i.savedAs}` : null].filter(Boolean)
  return `${bits.join(' · ')}${i.prompt ? ` - ${i.prompt.replace(/\s+/g, ' ').slice(0, 100)}` : ''}`
}

const GENERATE_DESC = `Make game art and UI concepts with OpenAI's image model (gpt-image-2.5; the user picks the model on the Art page). Each image is saved to art/concepts/<date>/<slug>-<n>.png with a JSON sidecar and shown to the user inline.
Write the prompt as an art director: subject and its silhouette, composition and framing, art style (match the game's existing look), palette, lighting, material/finish, camera angle, background, and what to avoid (no text, no watermark, no other brands). For Roblox UI: bold readable shapes at phone size, thick outlines, one subject centered with padding; buttons/icons/frames should use transparent:true.
style presets: roblox-ui-flat, stylized-icon, cartoon-key-art, thumbnail-16x9, game-icon-512 (sets size/transparency defaults). size: 1024x1024, 1536x1024, 1024x1536, auto, or WIDTHxHEIGHT (multiples of 16). n: variants, 1-${AGENT_MAX_VARIANTS}. reference_paths: project paths (e.g. an art/concepts file) or image files/chat images (forge-image://<id>) to edit or riff on; with references this is an edit. Costs real money (estimate is returned); prefer n<=2 unless asked. Then offer import_image_to_roblox for the ones the user likes.`

export function artTools(deps: ArtToolDeps): ArtTool[] {
  const { service } = deps
  const show = async (items: ArtItem[]): Promise<string[]> => {
    const out: string[] = []
    for (const i of items) {
      const marker = deps.chatImage ? await deps.chatImage(i.absPath, i.path.split('/').pop()!).catch(() => null) : null
      out.push(marker ? `${marker}\n${line(i)}` : line(i))
    }
    return out
  }
  return [
    {
      name: 'generate_image',
      description: GENERATE_DESC,
      inputSchema: {
        prompt: z.string().min(3).max(30_000),
        size: z.string().regex(/^(auto|\d{2,4}x\d{2,4})$/).optional(),
        transparent: z.boolean().optional(),
        n: z.number().int().min(1).max(AGENT_MAX_VARIANTS).optional(),
        reference_paths: z.array(z.string().min(1)).max(8).optional(),
        style: z.enum(['none', 'roblox-ui-flat', 'stylized-icon', 'cartoon-key-art', 'thumbnail-16x9', 'game-icon-512']).optional(),
        quality: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'auto']).optional(),
        name: z.string().max(60).optional()
      },
      handler: async (args: { prompt: string; size?: string; transparent?: boolean; n?: number; reference_paths?: string[]; style?: any; quality?: any; name?: string }) => {
        try {
          const input = { prompt: args.prompt, size: args.size, transparent: args.transparent, n: args.n, referencePaths: args.reference_paths, style: args.style, quality: args.quality, slug: args.name, source: 'agent' as const }
          const est = await service.estimate(input)
          const items = await service.generate(input)
          const head = `generated ${items.length} image${items.length === 1 ? '' : 's'} with ${est.model} (${est.size}, ${est.quality}), about ${formatUsd(est.totalUsd)}; today ${formatUsd(est.spentTodayUsd + est.totalUsd)}${est.dailyCapUsd ? ` of ${formatUsd(est.dailyCapUsd)}` : ''}`
          return ok([head, ...(await show(items))].join('\n'))
        } catch (error) {
          return fail(`generate_image failed: ${(error as Error).message}`)
        }
      }
    },
    {
      name: 'import_image_to_roblox',
      description:
        'Upload an art/ image to Roblox as an Image asset (Open Cloud Assets API), wait for processing, and write Name = "rbxassetid://<id>" into src/shared/Assets/Images.luau (sorted, created if missing). Use it from Luau as require(ReplicatedStorage.Shared.Assets.Images).<Name>. name is a PascalCase key (e.g. ShopButton). Needs the user\'s Open Cloud key (asset:read + asset:write) and creator, set on the Art page.',
      inputSchema: { path: z.string().min(1), name: z.string().regex(/^[A-Za-z][A-Za-z0-9_ -]{0,59}$/), asset_type: z.enum(['Image', 'Decal']).optional() },
      handler: async (args: { path: string; name: string; asset_type?: 'Image' | 'Decal' }) => {
        try {
          const r = await service.importToRoblox({ path: args.path, name: args.name, ...(args.asset_type ? { assetType: args.asset_type } : {}) })
          const reg = r.registry ? `; ${r.registry.path} ${r.registry.changed ? 'updated' : 'already had it'}: ${r.registry.name} = "${r.uri}"` : ''
          const mod = r.item.roblox?.moderation ? ` (moderation: ${r.item.roblox.moderation})` : ''
          return ok(`uploaded ${r.item.path} as ${r.uri}${mod}${reg}`)
        } catch (error) {
          return fail(`import_image_to_roblox failed: ${(error as Error).message}`)
        }
      }
    },
    {
      name: 'list_art',
      description: 'List generated art concepts, newest first: path · size · quality · rbxassetid (when uploaded) - prompt. Optional filter (substring of path or prompt) and limit. Also lists the Images.luau registry.',
      inputSchema: { filter: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
      handler: async (args: { filter?: string; limit?: number }) => {
        try {
          const q = args.filter?.toLowerCase()
          const all = await service.list()
          const hits = q ? all.filter((i) => i.path.toLowerCase().includes(q) || i.prompt.toLowerCase().includes(q)) : all
          const reg = await service.registry()
          const lines = hits.slice(0, args.limit ?? 30).map(line)
          if (hits.length > lines.length) lines.push(`…${hits.length - lines.length} more`)
          if (!lines.length) lines.push(all.length ? '(no matches)' : '(no concepts yet; use generate_image)')
          if (reg.length) lines.push('', `Images.luau: ${reg.map((e) => `${e.name}=${e.uri}`).join(', ')}`)
          return ok(lines.join('\n'))
        } catch (error) {
          return fail(`list_art failed: ${(error as Error).message}`)
        }
      }
    }
  ]
}
