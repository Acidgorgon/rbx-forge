// Running a provider's command-line tool for sign-in (Claude Code; the Codex service can reuse it):
// a timeout, cancellation through an AbortSignal, the whole process tree stopped, and Windows .cmd
// shims and paths with spaces handled by services/tools.ts (planSpawn).
//
// Output is handed to the caller line by line and kept only in memory for the result; it is never
// logged, since a CLI could print a token.

import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { spawnTool } from '../services/tools.ts'
import { killTree } from '../services/supervisor.ts'

export interface CliRunOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
  timeoutMs: number
  signal?: AbortSignal
  // Each output line (stdout and stderr), as it arrives.
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
  // Receives a writer for the child's stdin (e.g. to paste a login code).
  onStdin?: (write: (text: string) => void) => void
  // Test seam.
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess
}

export interface CliRunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  cancelled: boolean
  // Spawn failure (ENOENT...), when the process never ran.
  error?: string
}

const MAX_OUTPUT = 256 * 1024

export function runCli(file: string, args: string[], opts: CliRunOptions): Promise<CliRunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let cancelled = false
    let settled = false
    let child: ChildProcess
    try {
      child = (opts.spawn ?? spawnTool)(file, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group on mac/linux so killTree can stop what the CLI started (a browser helper).
        detached: process.platform !== 'win32',
        windowsHide: true
      })
    } catch (e) {
      resolve({ code: null, stdout, stderr, timedOut, cancelled, error: (e as Error).message })
      return
    }
    const finish = (r: Partial<CliRunResult>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ code: null, stdout, stderr, timedOut, cancelled, ...r })
    }
    const stop = () => {
      void killTree(child, 2000).catch(() => undefined)
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, opts.timeoutMs)
    const onAbort = () => {
      cancelled = true
      stop()
    }
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })

    const lines = (stream: 'stdout' | 'stderr') => {
      let partial = ''
      return (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        if (stream === 'stdout') stdout = (stdout + text).slice(-MAX_OUTPUT)
        else stderr = (stderr + text).slice(-MAX_OUTPUT)
        if (!opts.onLine) return
        partial += text
        const parts = partial.split(/\r?\n/)
        partial = parts.pop() ?? ''
        for (const line of parts) if (line.trim()) opts.onLine(stripAnsi(line), stream)
        // A prompt without a newline ("Paste code here if prompted > ") still matters.
        if (partial.trim() && /[>:?]\s*$/.test(partial)) {
          opts.onLine(stripAnsi(partial), stream)
          partial = ''
        }
      }
    }
    child.stdout?.on('data', lines('stdout'))
    child.stderr?.on('data', lines('stderr'))
    child.stdin?.on('error', () => undefined)
    opts.onStdin?.((text) => {
      if (child.stdin && !child.stdin.destroyed) child.stdin.write(text)
    })
    child.on('error', (e) => finish({ error: e.message }))
    child.on('close', (code) => finish({ code }))
  })
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

// First https URL in a line, without trailing punctuation.
export function extractUrl(line: string): string | undefined {
  const m = /https:\/\/[^\s"'<>]+/.exec(line)
  return m ? m[0].replace(/[).,;]+$/, '') : undefined
}
