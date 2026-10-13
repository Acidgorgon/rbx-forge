// Lune for the Animation Lab: the timeline recorder (resources/lune/anim_timeline.luau) and the
// KeyframeSequence reader for binary .rbxm / .rbxmx (resources/lune/anim_extract.luau, built on
// @lune/roblox deserializeModel). .rbxmx also has a no-Lune parser (shared/anim/rbxmx.ts).

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLuauError } from '../../../shared/vfx/compile.ts'
import type { AnimRecordResult } from '../../../shared/anim/compile.ts'
import type { RawSequence } from '../../../shared/anim/rbxmx.ts'
import { run } from '../tools.ts'
import { runWithTimeout, type LuneRun } from '../vfx/lune.ts'

export const ANIM_TIMELINE_SCRIPT = 'anim_timeline.luau'
export const ANIM_EXTRACT_SCRIPT = 'anim_extract.luau'
export const ANIM_TIMELINE_TIMEOUT_MS = 8000
const BATCH = 8

export async function luneAnimTimeline(script: string, opts: { lune: string; runtimeDir: string; run?: LuneRun; timeoutMs?: number }): Promise<AnimRecordResult> {
  const tmp = await mkdtemp(join(tmpdir(), 'forge-anim-'))
  const file = join(tmp, 'anim.luau')
  const limit = opts.timeoutMs ?? ANIM_TIMELINE_TIMEOUT_MS
  try {
    await writeFile(file, String(script ?? ''), 'utf8')
    const args = ['run', join(opts.runtimeDir, ANIM_TIMELINE_SCRIPT), file]
    const res = opts.run ? { ...(await opts.run(opts.lune, args, opts.runtimeDir)), timedOut: false } : await runWithTimeout(opts.lune, args, opts.runtimeDir, limit)
    if (res.timedOut) return { ok: false, ops: [], prints: [], error: { message: `the script ran for more than ${Math.round(limit / 1000)} s (an endless loop?). Timelines record instantly: use a:wait, not busy loops.` } }
    const line = res.stdout.split('\n').map((l) => l.trim()).reverse().find((l) => l.startsWith('{'))
    if (!line) return { ok: false, ops: [], prints: [], error: parseLuauError(res.stderr || `lune exited with code ${res.code}`) }
    const j = JSON.parse(line) as { ok?: boolean; ops?: unknown; prints?: unknown; error?: { message?: string } }
    const ops = Array.isArray(j.ops) ? (j.ops as AnimRecordResult['ops']) : []
    const prints = Array.isArray(j.prints) ? j.prints.map(String) : []
    if (!j.ok || j.error) return { ok: false, ops, prints, error: parseLuauError(String(j.error?.message ?? 'the script failed')) }
    return { ok: true, ops, prints }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

export interface AnimExtractResult {
  file: string
  sequences?: RawSequence[]
  error?: string
}

export async function luneAnimExtract(files: string[], opts: { lune: string; runtimeDir: string; run?: LuneRun }): Promise<AnimExtractResult[]> {
  const exec = opts.run ?? ((lune, args, cwd) => run(lune, args, cwd))
  const out: AnimExtractResult[] = []
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH)
    const res = await exec(opts.lune, ['run', join(opts.runtimeDir, ANIM_EXTRACT_SCRIPT), ...batch], opts.runtimeDir)
    const seen = new Set<string>()
    for (const line of res.stdout.split('\n')) {
      const t = line.trim()
      if (!t.startsWith('{')) continue
      try {
        const j = JSON.parse(t) as { file?: string; sequences?: RawSequence[]; error?: string }
        if (!j.file) continue
        seen.add(j.file)
        if (j.error) out.push({ file: j.file, error: j.error.split('\n')[0].slice(0, 300) })
        else out.push({ file: j.file, sequences: Array.isArray(j.sequences) ? j.sequences : [] })
      } catch {
        // partial line: reported as missing below
      }
    }
    for (const f of batch) if (!seen.has(f)) out.push({ file: f, error: (res.stderr || `lune exited with code ${res.code}`).trim().split('\n')[0].slice(0, 300) })
  }
  return out
}
