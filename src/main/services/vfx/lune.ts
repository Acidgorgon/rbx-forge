// Reading .rbxm / .rbxmx through Lune (resources/lune/vfx_extract.luau, @lune/roblox
// deserializeModel). .rbxmx also has a no-Lune fallback (shared/vfx/rbxmx.ts).

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCHEMA } from '../../../shared/vfx/schema.ts'
import type { ColorKey, NumKey, PropValue, VfxNode } from '../../../shared/vfx/types.ts'
import { parseLuauError, type RecordResult } from '../../../shared/vfx/compile.ts'
import { planSpawn, run, toolEnv } from '../tools.ts'

export const EXTRACT_SCRIPT = 'vfx_extract.luau'
export const TIMELINE_SCRIPT = 'vfx_timeline.luau'
// A timeline script records instantly; anything longer is a runaway loop.
export const TIMELINE_TIMEOUT_MS = 8000
const BATCH = 8

export type LuneRun = (lune: string, args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>

// Property list per class for the script (the Lab's schema).
export function wantedProps(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [cls, props] of Object.entries(SCHEMA)) out[cls] = Object.keys(props)
  return out
}

const r6 = (x: unknown) => {
  const v = Number(x)
  return Number.isFinite(v) ? Math.round(v * 1e5) / 1e5 : 0
}

// Lune JSON -> VfxNode (empty tables arrive as {}, floats as float32 noise, envelopes as e:0).
export function normalizeLuneNode(raw: any): VfxNode {
  const props: Record<string, PropValue> = {}
  const schema = SCHEMA[raw?.className] ?? {}
  for (const [k, v] of Object.entries((raw?.props ?? {}) as Record<string, unknown>)) {
    const kind = schema[k]?.kind
    if (!kind) continue
    if (kind === 'nseq' && Array.isArray(v)) props[k] = (v as any[]).map((key): NumKey => (Number(key.e) ? { t: r6(key.t), v: r6(key.v), e: r6(key.e) } : { t: r6(key.t), v: r6(key.v) }))
    else if (kind === 'cseq' && Array.isArray(v)) props[k] = (v as any[]).map((key): ColorKey => ({ t: r6(key.t), c: [r6(key.c?.[0]), r6(key.c?.[1]), r6(key.c?.[2])] }))
    else if (Array.isArray(v)) props[k] = (v as unknown[]).map(r6)
    else if (typeof v === 'number') props[k] = kind === 'int' ? Math.round(v) : r6(v)
    else if (typeof v === 'boolean' || typeof v === 'string') props[k] = v
  }
  const node: VfxNode = {
    id: String(raw?.id ?? ''),
    className: String(raw?.className ?? 'Folder'),
    name: String(raw?.name ?? ''),
    props,
    children: Array.isArray(raw?.children) ? raw.children.map(normalizeLuneNode) : []
  }
  if (typeof raw?.source === 'string') node.source = raw.source
  if (raw?.attrs && typeof raw.attrs === 'object' && !Array.isArray(raw.attrs)) {
    const attrs: Record<string, number | boolean | string> = {}
    for (const [k, v] of Object.entries(raw.attrs as Record<string, unknown>)) if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') attrs[k] = v
    if (Object.keys(attrs).length) node.attrs = attrs
  }
  return node
}

export interface ExtractResult {
  file: string
  roots?: VfxNode[]
  error?: string
  // A place file: roots are its VFX packs (paths in `packs`).
  place?: boolean
  packs?: string[]
}

export async function luneExtract(files: string[], opts: { lune: string; runtimeDir: string; run?: LuneRun }): Promise<ExtractResult[]> {
  const tmp = await mkdtemp(join(tmpdir(), 'forge-vfx-'))
  const propsFile = join(tmp, 'props.json')
  await writeFile(propsFile, JSON.stringify(wantedProps()), 'utf8')
  const exec = opts.run ?? ((lune, args, cwd) => run(lune, args, cwd))
  const out: ExtractResult[] = []
  try {
    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH)
      const res = await exec(opts.lune, ['run', join(opts.runtimeDir, EXTRACT_SCRIPT), propsFile, ...batch], opts.runtimeDir)
      const seen = new Set<string>()
      for (const line of res.stdout.split('\n')) {
        const t = line.trim()
        if (!t.startsWith('{')) continue
        try {
          const j = JSON.parse(t) as { file?: string; roots?: unknown[]; error?: string; place?: boolean; packs?: unknown }
          if (!j.file) continue
          seen.add(j.file)
          if (j.error) out.push({ file: j.file, error: j.error.split('\n')[0].slice(0, 300) })
          else if (j.place) out.push({ file: j.file, roots: (Array.isArray(j.roots) ? j.roots : []).map(normalizeLuneNode), place: true, packs: Array.isArray(j.packs) ? j.packs.map(String) : [] })
          else out.push({ file: j.file, roots: (j.roots ?? []).map(normalizeLuneNode) })
        } catch {
          // a partial line; the file is reported as missing below
        }
      }
      for (const f of batch) if (!seen.has(f)) out.push({ file: f, error: (res.stderr || `lune exited with code ${res.code}`).trim().split('\n')[0].slice(0, 300) })
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
  return out
}

// run() with a time limit (the process is killed when it runs out).
export function runWithTimeout(file: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  const plan = planSpawn(file, args)
  return new Promise((resolve) => {
    execFile(plan.file, plan.args, { cwd, env: toolEnv(), maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL', windowsVerbatimArguments: plan.windowsVerbatimArguments }, (error, stdout, stderr) => {
      const timedOut = !!error && ((error as NodeJS.ErrnoException & { killed?: boolean }).killed === true || /ETIMEDOUT/.test(String(error.message)))
      let code = 0
      if (error) code = typeof error.code === 'number' ? error.code : 1
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && !timedOut ? error.message : '')), timedOut })
    })
  })
}

// Runs a timeline script in the recorder sandbox (resources/lune/vfx_timeline.luau).
export async function luneTimeline(script: string, opts: { lune: string; runtimeDir: string; run?: LuneRun; timeoutMs?: number }): Promise<RecordResult> {
  const tmp = await mkdtemp(join(tmpdir(), 'forge-fx-'))
  const file = join(tmp, 'timeline.luau')
  try {
    await writeFile(file, String(script ?? ''), 'utf8')
    const args = ['run', join(opts.runtimeDir, TIMELINE_SCRIPT), file]
    const res = opts.run
      ? { ...(await opts.run(opts.lune, args, opts.runtimeDir)), timedOut: false }
      : await runWithTimeout(opts.lune, args, opts.runtimeDir, opts.timeoutMs ?? TIMELINE_TIMEOUT_MS)
    if (res.timedOut) return { ok: false, ops: [], prints: [], error: { message: `the script ran for more than ${Math.round((opts.timeoutMs ?? TIMELINE_TIMEOUT_MS) / 1000)} s (an endless loop?). Timelines run instantly: use fx:wait, not busy loops.` } }
    const line = res.stdout.split('\n').map((l) => l.trim()).reverse().find((l) => l.startsWith('{'))
    if (!line) return { ok: false, ops: [], prints: [], error: parseLuauError(res.stderr || `lune exited with code ${res.code}`) }
    const j = JSON.parse(line) as { ok?: boolean; ops?: unknown; prints?: unknown; error?: { message?: string } }
    const ops = Array.isArray(j.ops) ? (j.ops as RecordResult['ops']) : []
    const prints = Array.isArray(j.prints) ? j.prints.map(String) : []
    if (!j.ok || j.error) return { ok: false, ops, prints, error: parseLuauError(String(j.error?.message ?? 'the script failed')) }
    return { ok: true, ops, prints }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}
