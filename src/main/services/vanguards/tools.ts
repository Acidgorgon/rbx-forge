// Agent tools for Vanguards CLIs (ror, rur, ree) and FM build pipeline scripts.
// Outputs PNG/JPG renders inline via defaultChatImage so multimodal agents see them automatically.

import { basename } from 'node:path'
import { z } from 'zod'
import type { ServiceTool } from '../../context.ts'
import { defaultChatImage } from '../../agent/chatImages.ts'
import type { VanguardsRunResult } from '../../../shared/vanguardsTypes.ts'
import type { VanguardsService } from './service.ts'

export const VANGUARDS_WRITE_TOOLS = ['fm_envbuild', 'fm_insert_rbxm'] as const

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

export interface VanguardsToolDeps {
  attachImage?: (absPath: string, name: string) => Promise<string | null>
}

async function formatRunResult(
  label: string,
  res: VanguardsRunResult,
  attachImage: (absPath: string, name: string) => Promise<string | null>
): Promise<ToolResult> {
  const parts: string[] = [
    `${label}: ${res.ok ? 'ok' : `failed (exit ${res.code})`} in ${res.durationMs}ms`
  ]
  if (res.error) parts.push(`error: ${res.error}`)
  if (res.outputPath) parts.push(`output: ${res.outputPath}`)
  const out = res.stdout.trim()
  const err = res.stderr.trim()
  if (out) parts.push(`stdout:\n${out.slice(0, 6000)}`)
  if (err && !res.error) parts.push(`stderr:\n${err.slice(0, 3000)}`)

  if (res.images?.length) {
    const markers: string[] = []
    for (const imgPath of res.images.slice(0, 8)) {
      const marker = await attachImage(imgPath, basename(imgPath)).catch(() => null)
      if (marker) markers.push(marker)
      else parts.push(`image: ${imgPath}`)
    }
    if (markers.length) parts.push(markers.join('\n'))
  }

  return { content: [{ type: 'text', text: parts.join('\n') }], ...(res.ok ? {} : { isError: true }) }
}

export function vanguardsTools(
  service: VanguardsService,
  deps: VanguardsToolDeps = {}
): { read: ServiceTool[]; write: ServiceTool[] } {
  const attachImage = deps.attachImage ?? defaultChatImage

  const read: ServiceTool[] = [
    {
      name: 'vanguards_status',
      description:
        'Check detected Vanguards CLIs (ror, rur, ree, python, lune), FM pipeline scripts (envbuild.py, modelpreview.py, insert_rbxm.py, mcp_bridge.py), asset packs, and MCP bridge state.',
      inputSchema: {},
      handler: async () => {
        const s = service.status()
        const lines: string[] = [
          `binDir: ${s.binDir}`,
          `fmDir: ${s.fmDir}`,
          `packsDir: ${s.packsDir}`,
          `mcpBridge: ${s.mcpBridge.running ? `running on 127.0.0.1:${s.mcpBridge.port} (pid ${s.mcpBridge.pid ?? '?'})` : 'stopped'}`,
          'tools:'
        ]
        for (const t of Object.values(s.tools)) {
          lines.push(`  ${t.id}: ${t.found ? `found (${t.path})` : 'missing'}`)
        }
        lines.push('fmScripts:')
        for (const [id, info] of Object.entries(s.fmScripts)) {
          lines.push(`  ${id}: ${info.found ? `found (${info.path})` : 'missing'}`)
        }
        lines.push(`packs (${s.packs.length}): ${s.packs.map((p) => `${p.name}(${p.files ?? 0})`).join(', ') || '(none)'}`)
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
    },
    {
      name: 'ror_render',
      description:
        'Run the external ror CLI (Roblox Object Renderer) offline with ROR_BACKEND=dx12 and ROR_MEMORY_FLOOR_GB=2. Attaches rendered PNG/JPG images inline.',
      inputSchema: {
        args: z.array(z.string()).min(1),
        cwd: z.string().optional(),
        outDir: z.string().optional(),
        timeoutMs: z.number().int().positive().optional()
      },
      handler: async (args: { args: string[]; cwd?: string; outDir?: string; timeoutMs?: number }) => {
        const res = await service.runRor(args)
        return formatRunResult('ror', res, attachImage)
      }
    },
    {
      name: 'rur_render',
      description:
        'Run the external rur CLI (Roblox UI Renderer: render, sequence, sweep, compare, record, doctor, assets, diff, profile). Attaches rendered images inline.',
      inputSchema: {
        args: z.array(z.string()).min(1),
        cwd: z.string().optional(),
        outDir: z.string().optional(),
        timeoutMs: z.number().int().positive().optional()
      },
      handler: async (args: { args: string[]; cwd?: string; outDir?: string; timeoutMs?: number }) => {
        const res = await service.runRur(args)
        return formatRunResult('rur', res, attachImage)
      }
    },
    {
      name: 'rur_stories',
      description: 'List or inspect UI stories offline via `rur stories`.',
      inputSchema: {
        project: z.string().optional(),
        json: z.boolean().optional(),
        extraArgs: z.array(z.string()).optional(),
        cwd: z.string().optional()
      },
      handler: async (args: { project?: string; json?: boolean; extraArgs?: string[]; cwd?: string }) => {
        const cliArgs = ['stories']
        if (args.json) cliArgs.push('--json')
        if (args.project) cliArgs.push('--project', args.project)
        if (args.extraArgs?.length) cliArgs.push(...args.extraArgs)
        const res = await service.runRur({ args: cliArgs, cwd: args.cwd })
        return formatRunResult('rur stories', res, attachImage)
      }
    },
    {
      name: 'ree_run',
      description: 'Run the external ree headless Roblox Engine execution CLI.',
      inputSchema: {
        args: z.array(z.string()).min(1),
        cwd: z.string().optional(),
        timeoutMs: z.number().int().positive().optional()
      },
      handler: async (args: { args: string[]; cwd?: string; timeoutMs?: number }) => {
        const res = await service.runRee(args)
        return formatRunResult('ree', res, attachImage)
      }
    },
    {
      name: 'fm_modelpreview',
      description:
        'Preview a .rbxm/.rbxmx model offline via fm/modelpreview.py + ror (multi-angle PNGs + sheet.jpg, no Studio needed).',
      inputSchema: {
        modelPath: z.string().min(1),
        views: z.string().optional(),
        size: z.string().optional(),
        focus: z.string().optional(),
        background: z.string().optional(),
        ids: z.boolean().optional(),
        outDir: z.string().optional()
      },
      handler: async (args: {
        modelPath: string
        views?: string
        size?: string
        focus?: string
        background?: string
        ids?: boolean
        outDir?: string
      }) => {
        const res = await service.fmModelpreview(args)
        return formatRunResult('fm modelpreview', res, attachImage)
      }
    }
  ]

  const write: ServiceTool[] = [
    {
      name: 'fm_envbuild',
      description:
        'Run fm/envbuild.py offline via ror + ree to build an env-study kit module into final.rbxm + sheet.jpg.',
      inputSchema: {
        module: z.string().min(1),
        fn: z.string().optional(),
        argsJson: z.string().optional(),
        time: z.number().optional(),
        views: z.string().optional(),
        focus: z.string().optional(),
        cameraJson: z.string().optional(),
        size: z.string().optional(),
        outDir: z.string().optional(),
        lightingFrom: z.string().optional()
      },
      handler: async (args: {
        module: string
        fn?: string
        argsJson?: string
        time?: number
        views?: string
        focus?: string
        cameraJson?: string
        size?: string
        outDir?: string
        lightingFrom?: string
      }) => {
        const res = await service.fmEnvbuild(args)
        return formatRunResult('fm envbuild', res, attachImage)
      }
    },
    {
      name: 'fm_insert_rbxm',
      description:
        'Insert a baked .rbxm file into an open Roblox Studio instance via fm/insert_rbxm.py (refuses Forge-Sync linked place 125988560196910).',
      inputSchema: {
        studioId: z.string().min(1),
        filePath: z.string().min(1),
        parent: z.string().optional(),
        at: z.string().optional(),
        replace: z.boolean().optional(),
        select: z.boolean().optional(),
        placeId: z.number().int().optional()
      },
      handler: async (args: {
        studioId: string
        filePath: string
        parent?: string
        at?: string
        replace?: boolean
        select?: boolean
        placeId?: number
      }) => {
        const res = await service.fmInsertRbxm(args)
        return formatRunResult('fm insert_rbxm', res, attachImage)
      }
    }
  ]

  return { read, write }
}

export function withVanguardsTools<T extends { read: ServiceTool[]; write: ServiceTool[] }>(
  sets: T,
  tools: { read: ServiceTool[]; write: ServiceTool[] } | null
): T {
  if (!tools) return sets
  return { ...sets, read: [...sets.read, ...tools.read], write: [...sets.write, ...tools.write] }
}
