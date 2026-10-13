// Agent tools for headless tests, shaped like the gentree tools (src/main/agent/tools.ts GentreeTool)
// so the integrator can pass them as `extraTools` or merge them into gentreeTools().
//   run_tests   all / one file / one test by name -> compact pass/fail, first error lines only
//   create_spec scaffold <Module>.spec.luau next to a ModuleScript

import { z } from 'zod'
import { formatCompact } from './protocol.ts'
import { SpecError } from './scaffold.ts'
import type { TestService } from './service.ts'
import type { RunRequest } from './types.ts'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

export const RUN_TESTS_DESCRIPTION =
  'Run Luau specs (*.spec.luau) headless with Lune - seconds, no Studio. No args = all specs; ' +
  'file = a spec or the module it tests; name = one test ("Suite > test" or a substring). ' +
  'Returns PASS/FAIL counts and, per failure, "x file:line name: message". Run this before using Studio.'

export const CREATE_SPEC_DESCRIPTION =
  'Create <Module>.spec.luau next to a ModuleScript (repo path), requiring it by instance path. ' +
  'Returns the spec path and content; does not overwrite an existing spec.'

export const runTestsShape = {
  file: z.string().optional(),
  name: z.string().optional(),
  // Per-test timeout in ms (default 5000).
  timeoutMs: z.number().int().positive().max(60_000).optional()
}

export const createSpecShape = {
  path: z.string()
}

export function runTestsRequest(args: { file?: string; name?: string; timeoutMs?: number }): RunRequest {
  const scope: RunRequest['scope'] = args.name
    ? { kind: 'name', name: args.name, file: args.file }
    : args.file
      ? { kind: 'file', file: args.file }
      : { kind: 'all' }
  return { scope, testTimeoutMs: args.timeoutMs }
}

export function testTools(service: TestService) {
  return [
    {
      name: 'run_tests',
      description: RUN_TESTS_DESCRIPTION,
      inputSchema: runTestsShape,
      handler: async (args: { file?: string; name?: string; timeoutMs?: number }): Promise<ToolResult> => {
        const summary = await service.run(runTestsRequest(args))
        const text = formatCompact(summary)
        return summary.state === 'passed' || summary.state === 'failed' ? ok(text) : fail(text)
      }
    },
    {
      name: 'create_spec',
      description: CREATE_SPEC_DESCRIPTION,
      inputSchema: createSpecShape,
      handler: async (args: { path: string }): Promise<ToolResult> => {
        try {
          const result = await service.createSpec(args.path)
          const head = result.created ? `created ${result.path}` : `exists ${result.path} (not overwritten)`
          return ok(`${head}\nrequires ${result.requirePath}\n${result.content}`)
        } catch (error) {
          return fail(error instanceof SpecError ? error.message : `create_spec failed: ${(error as Error).message}`)
        }
      }
    }
  ]
}
