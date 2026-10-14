// Spawning the Codex CLI. No electron imports.

import { spawn, type ChildProcess } from 'node:child_process'
import { killTree } from '../../services/supervisor.ts'
import { planSpawn } from '../../services/tools.ts'
import { LineSplitter } from './events.ts'

export interface SpawnedRun {
  code: number | null
  stderr: string
  aborted: boolean
  timedOut: boolean
}

export interface RunOptions {
  bin: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  // Written to stdin, then stdin is closed (codex exec reads the prompt from `-`).
  stdin?: string
  signal?: AbortSignal
  timeoutMs?: number
  onStdoutLine?: (line: string) => void
  onStderr?: (text: string) => void
}

const STDERR_KEEP = 8000

// Runs the CLI to completion. Never rejects for a non-zero exit; a spawn failure (ENOENT) rejects.
// Cancel (signal) and the timeout stop the whole process tree (cmd.exe shim + node + codex).
export function runCli(o: RunOptions): Promise<SpawnedRun> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return resolve({ code: null, stderr: '', aborted: true, timedOut: false })
    const plan = planSpawn(o.bin, o.args, process.platform, o.env)
    let child: ChildProcess
    try {
      child = spawn(plan.file, plan.args, {
        cwd: o.cwd,
        env: o.env,
        windowsHide: true,
        // Own process group on mac/linux, so killTree reaches codex's children.
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
      })
    } catch (e) {
      return reject(e)
    }
    let stderr = ''
    let aborted = false
    let timedOut = false
    let settled = false
    const lines = new LineSplitter()
    const stop = () => {
      void killTree(child)
    }
    const onAbort = () => {
      aborted = true
      stop()
    }
    o.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = o.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          stop()
        }, o.timeoutMs)
      : null
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      for (const l of lines.push(chunk)) o.onStdoutLine?.(l)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_KEEP)
      o.onStderr?.(chunk)
    })
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      for (const l of lines.end()) o.onStdoutLine?.(l)
      resolve({ code, stderr, aborted, timedOut })
    }
    child.on('error', (e) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code) => finish(code))
    // A closed stdin (EPIPE when codex exits early) is not an error worth surfacing.
    child.stdin?.on('error', () => undefined)
    if (o.stdin !== undefined) child.stdin?.end(o.stdin)
    else child.stdin?.end()
  })
}

// Last meaningful stderr line (codex prints errors there), without ANSI codes.
export function lastErrorLine(stderr: string): string {
  const lines = stderr
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^Reading (prompt|additional input) from stdin/i.test(l))
  return lines.slice(-3).join(' ').slice(0, 400)
}
