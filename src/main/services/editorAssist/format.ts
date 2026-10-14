// StyLua over stdin for one editor buffer. Never touches the file on disk: the renderer applies the
// result to the Monaco model as one undoable edit. No electron imports.

import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { FormatResult } from '../../../shared/editorAssist/types.ts'
import { isUnknownFlag, styluaArgs, styluaError } from '../../../shared/editorAssist/stylua.ts'
import { findTool, spawnTool, toolEnv } from '../tools.ts'

export const FORMAT_TIMEOUT_MS = 5000
const MAX_OUTPUT = 16 * 1024 * 1024

export interface FormatDeps {
  // Finds stylua (rokit / aftman shims first, then PATH). Default tools.findTool.
  findTool?: (name: string) => string | null
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

export function findStylua(deps: FormatDeps = {}): string | null {
  return (deps.findTool ?? ((n: string) => findTool(n)))('stylua')
}

interface RunOutcome {
  code: number | null
  stdout: string
  stderr: string
  timedOut?: boolean
  spawnError?: string
}

function runWithStdin(file: string, args: string[], cwd: string, input: string, deps: FormatDeps): Promise<RunOutcome> {
  const spawn = deps.spawn ?? spawnTool
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      // Rokit shims pick the version from the project's rokit.toml by the working directory.
      child = spawn(file, args, { cwd, env: deps.env ?? toolEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', spawnError: (e as Error).message })
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    let done = false
    const finish = (r: RunOutcome) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ code: null, stdout: '', stderr: '', timedOut: true })
    }, deps.timeoutMs ?? FORMAT_TIMEOUT_MS)
    child.stdout?.on('data', (d: Buffer) => {
      size += d.length
      if (size > MAX_OUTPUT) {
        child.kill()
        finish({ code: null, stdout: '', stderr: 'output too large' })
        return
      }
      out.push(d)
    })
    child.stderr?.on('data', (d: Buffer) => err.push(d))
    child.on('error', (e) => finish({ code: null, stdout: '', stderr: '', spawnError: e.message }))
    child.on('close', (code) => finish({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }))
    // A tool that exits before reading stdin makes the write fail with EPIPE; 'close' reports it.
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(input, 'utf8')
  })
}

// Formats `text` as the file `path` (repo-relative) of the project at `root`.
export async function formatWithStylua(root: string, path: string, text: string, deps: FormatDeps = {}): Promise<FormatResult> {
  const stylua = findStylua(deps)
  if (!stylua) return { ok: false, missing: true, error: 'StyLua is not installed. Add it with rokit (stylua = "JohnnyMorganz/StyLua@2"), or open Forge Doctor.' }
  let r = await runWithStdin(stylua, styluaArgs(path), root, text, deps)
  if (r.code !== 0 && isUnknownFlag(r.stderr, '--respect-ignores')) r = await runWithStdin(stylua, styluaArgs(path, { respectIgnores: false }), root, text, deps)
  if (r.timedOut) return { ok: false, error: `StyLua took longer than ${Math.round((deps.timeoutMs ?? FORMAT_TIMEOUT_MS) / 1000)} s; the file was left as it was.` }
  if (r.spawnError) return { ok: false, error: `Could not run StyLua: ${r.spawnError}` }
  if (r.code !== 0) return { ok: false, error: styluaError(r.stderr, r.code ?? -1) }
  // An empty answer for a non-empty buffer is never a valid format (a crashed tool, a broken pipe).
  if (!r.stdout && text.trim()) return { ok: false, error: 'StyLua returned nothing; the file was left as it was.' }
  return { ok: true, text: keepLineEndings(text, r.stdout) }
}

// StyLua writes its configured line endings (Unix by default). A CRLF buffer on Windows stays CRLF
// unless the project asked for something else, so formatting never rewrites every line.
export function keepLineEndings(original: string, formatted: string): string {
  const crlf = original.includes('\r\n')
  if (crlf && !formatted.includes('\r\n')) return formatted.replace(/\n/g, '\r\n')
  return formatted
}
