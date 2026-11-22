// Agent tools for Harbor Family Stack: Current, Ripple, Anchor, Tide, Lighthouse.

import { z } from 'zod'
import { HARBOR_LIB_IDS, type HarborLibId } from '../../../shared/harborTypes.ts'
import type { ServiceTool } from '../../context.ts'
import type { HarborService } from './service.ts'

export const HARBOR_WRITE_TOOLS = ['harbor_toggle_lib', 'harbor_generate'] as const

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })

export function harborTools(service: HarborService): { read: ServiceTool[]; write: ServiceTool[] } {
  const read: ServiceTool[] = [
    {
      name: 'harbor_status',
      description:
        'Inspect Harbor Family Stack detection (Current, Ripple, Anchor, Tide, Lighthouse), LibsConfig.luau boolean toggles, schema files (current-schema.luau, *.ripple, *.blink), and CLIs.',
      inputSchema: {},
      handler: async () => {
        const s = service.status()
        if (!s.projectRoot) return ok('No project open')
        const lines = [
          `project: ${s.projectRoot}`,
          `libsConfig: ${s.libsConfigPath ?? '(not found)'}`,
          `watcher: ${s.watcherActive ? 'active' : 'off'}`,
          'libraries:'
        ]
        for (const id of HARBOR_LIB_IDS) {
          const lib = s.libs[id]
          const flags = [
            lib.detected ? 'detected' : 'not-detected',
            ...(lib.enabled !== undefined ? [`enabled=${lib.enabled}`] : []),
            ...(lib.version ? [`v${lib.version}`] : []),
            ...(lib.cliPath ? [`cli=${lib.cliPath}`] : [])
          ]
          lines.push(`  ${lib.name}: ${flags.join(', ')}`)
          if (lib.sourcePaths.length) lines.push(`    sources: ${lib.sourcePaths.join(', ')}`)
          if (lib.schemaFiles.length) lines.push(`    schemas: ${lib.schemaFiles.join(', ')}`)
        }
        if (s.toggles.length) {
          lines.push(`toggles: ${s.toggles.map((t) => `${t.key}=${t.value}`).join(', ')}`)
        }
        return ok(lines.join('\n'))
      }
    }
  ]

  const write: ServiceTool[] = [
    {
      name: 'harbor_toggle_lib',
      description: 'Losslessly toggle a boolean key in LibsConfig.luau while preserving comments and formatting.',
      inputSchema: {
        key: z.string().min(1),
        enabled: z.boolean()
      },
      handler: async (args: { key: string; enabled: boolean }) => {
        try {
          const s = await service.toggleLib(args.key, args.enabled)
          return ok(`Updated ${s.libsConfigPath ?? 'LibsConfig.luau'}: ${args.key} = ${args.enabled}`)
        } catch (e) {
          return fail((e as Error).message)
        }
      }
    },
    {
      name: 'harbor_generate',
      description: 'Run codegen/verification for a Harbor library (current, ripple, anchor, tide, lighthouse).',
      inputSchema: {
        lib: z.enum(['current', 'ripple', 'anchor', 'tide', 'lighthouse'])
      },
      handler: async (args: { lib: HarborLibId }) => {
        const res = await service.generate(args.lib)
        return res.ok ? ok(res.output) : fail(res.output)
      }
    }
  ]

  return { read, write }
}

export function withHarborTools<T extends { read: ServiceTool[]; write: ServiceTool[] }>(
  sets: T,
  tools: { read: ServiceTool[]; write: ServiceTool[] } | null
): T {
  if (!tools) return sets
  return { ...sets, read: [...sets.read, ...tools.read], write: [...sets.write, ...tools.write] }
}
