// Agent tools for the Studio Bridge (ServiceTool shape: zod raw shape + handler).
//
//   studio_status  read   is Roblox Studio connected through the Forge Bridge plugin, and why not

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
export const STUDIO_WRITE_TOOLS = [] as const

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })

export function studioTools(service: StudioService): { read: StudioTool[]; write: StudioTool[] } {
  const read: StudioTool[] = [
    {
      name: 'studio_status',
      description: "Whether the user's Roblox Studio is connected to Forge through the Forge Bridge plugin, and what to do if not: install the plugin and open Studio.",
      inputSchema: {},
      handler: async () => {
        const s = await service.status()
        return ok(`${s.state}: ${s.message}`)
      }
    }
  ]
  return { read, write: [] }
}

export function withStudioTools<T extends { read: any[]; write: any[] }>(sets: T, tools: { read: StudioTool[]; write: StudioTool[] } | null): T {
  if (!tools) return sets
  return { ...sets, read: [...sets.read, ...tools.read], write: [...sets.write, ...tools.write] }
}
