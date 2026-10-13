import { spawnTool } from '../tools.ts'

// Streaming command runner for the toolchain setup and the new-project flow. Injectable, so tests
// drive both flows with a fake runner and never spawn rokit, git or the network.

export interface RunOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  // Each output line (stdout and stderr, \r progress rewrites split), ANSI codes removed.
  onLine?: (line: string) => void
  // Default 10 minutes.
  timeoutMs?: number
  // Aborting kills the child; the result then has code 130.
  signal?: AbortSignal
}

export interface RunOutput {
  code: number
  output: string
}

export type CommandRunner = (file: string, args: string[], options: RunOptions) => Promise<RunOutput>

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

// Last meaningful line of a tool's output: the first "error"/"fatal" line, else the last line.
// Rust backtraces (rokit prints one with RUST_BACKTRACE) are skipped.
export function errorLine(output: string): string {
  const lines = stripAnsi(output)
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\d+: /.test(l) && !/^at /.test(l) && !/^Stack backtrace:?$/i.test(l))
  const error = lines.find((l) => /^(error|fatal)\b/i.test(l))
  return (error || lines[lines.length - 1] || '').replace(/^error:\s*/i, '').replace(/^ERROR\s+/, '')
}

export const spawnRunner: CommandRunner = (file, args, options) =>
  new Promise((resolve) => {
    let output = ''
    let pending = ''
    let settled = false
    const done = (result: RunOutput) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    if (options.signal?.aborted) return resolve({ code: 130, output: 'cancelled' })
    const child = spawnTool(file, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      output += '\nerror: timed out'
      child.kill()
    }, options.timeoutMs ?? 10 * 60 * 1000)
    const onAbort = () => {
      child.kill()
      done({ code: 130, output: output + '\ncancelled' })
    }
    options.signal?.addEventListener('abort', onAbort)
    const feed = (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString('utf8'))
      output += text
      if (output.length > 200_000) output = output.slice(-100_000)
      pending += text
      const parts = pending.split(/\r\n|\r|\n/)
      pending = parts.pop() ?? ''
      for (const part of parts) if (part.trim()) options.onLine?.(part.trim())
    }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    child.on('error', (error) => done({ code: 127, output: output + String(error.message) }))
    child.on('close', (code) => {
      if (pending.trim()) options.onLine?.(pending.trim())
      done({ code: code ?? 1, output })
    })
  })
