// Model Lab build results: the Lune sandbox's JSON line (resources/lune/model_build.luau) turned into
// a ModelBuild, and the checks shown in the Lab and handed to the critic. No electron imports.

import { PART_BUDGET } from './prompt.ts'
import type { ModelBuild, ModelPart, ModelScriptError, ModelStats } from './types.ts'

// `[string "build"]:12: message` -> { line: 12, message }.
export function parseBuildError(raw: string): ModelScriptError {
  const text = String(raw ?? '')
    .replace(/^.*?LuaError\(\s*/s, '')
    .replace(/\nstack traceback:[\s\S]*$/, '')
    .trim()
  const m = /\[string "build"\]:(\d+):\s*([\s\S]*)/.exec(text)
  if (m) return { line: Number(m[1]), message: m[2].split('\n')[0].replace(/^syntax error:\s*/i, '').trim().slice(0, 400) }
  return { message: text.split('\n')[0].replace(/^syntax error:\s*/i, '').slice(0, 400) || 'the build script failed' }
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const KINDS = new Set(['P', 'W', 'C', 'M', 'T'])

function part(raw: any): ModelPart | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.s) || !Array.isArray(raw.cf) || raw.cf.length !== 12) return null
  const p: ModelPart = {
    n: String(raw.n ?? 'Part').slice(0, 100),
    k: KINDS.has(raw.k) ? raw.k : 'P',
    s: [num(raw.s[0], 1), num(raw.s[1], 1), num(raw.s[2], 1)],
    cf: (raw.cf as unknown[]).map((v, i) => num(v, i === 3 || i === 7 || i === 11 ? 1 : 0)),
    c: Array.isArray(raw.c) ? [num(raw.c[0], 0.64), num(raw.c[1], 0.64), num(raw.c[2], 0.64)] : [0.64, 0.64, 0.65]
  }
  if (num(raw.t) > 0) p.t = num(raw.t)
  if (typeof raw.m === 'string' && raw.m) p.m = raw.m
  if (typeof raw.sh === 'string' && raw.sh) p.sh = raw.sh
  if (raw.a === true) p.a = true
  return p
}

function stats(raw: any): ModelStats | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const s: ModelStats = {
    motors: num(raw.motors),
    welds: num(raw.welds),
    weldConstraints: num(raw.weldConstraints),
    attachments: num(raw.attachments),
    animators: num(raw.animators),
    animationControllers: num(raw.animationControllers),
    humanoids: num(raw.humanoids),
    anchored: num(raw.anchored),
    instances: num(raw.instances),
    assemblies: num(raw.assemblies),
    loose: num(raw.loose)
  }
  if (typeof raw.primaryPart === 'string') s.primaryPart = raw.primaryPart
  if (raw.truncated === true) s.truncated = true
  return s
}

// What the Lab and the critic should know about a build that ran.
export function buildWarnings(parts: ModelPart[], s: ModelStats | undefined): string[] {
  const out: string[] = []
  if (!parts.length) out.push('the script made no parts')
  if (parts.length > PART_BUDGET) out.push(`${parts.length} parts: over the ~${PART_BUDGET} budget (merge runs, fewer plates per ring, fewer rings)`)
  if (s?.truncated) out.push('the preview stopped recording parts at its limit')
  if (s && parts.length) {
    if (!s.primaryPart) out.push('model.PrimaryPart is not set (set it to the anchored root part)')
    if (s.loose > 0) out.push(`${s.loose} part${s.loose === 1 ? ' is' : 's are'} not welded to the rig and would fall apart in game (pass a bone to kit:part)`)
    if (!s.anchored && !s.humanoids) out.push('nothing is anchored: anchor the root part')
    if (s.motors > 0 && !s.animators) out.push('Motor6Ds but no AnimationController / Animator')
  }
  return out
}

// The sandbox's JSON line -> ModelBuild.
export function parseBuildOutput(stdout: string, stderr: string, code: number): ModelBuild {
  const line = String(stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith('{'))
  if (!line) return { ok: false, parts: [], prints: [], warnings: [], error: parseBuildError(stderr || `lune exited with code ${code}`) }
  let j: any
  try {
    j = JSON.parse(line)
  } catch {
    return { ok: false, parts: [], prints: [], warnings: [], error: { message: 'the preview sandbox printed something unreadable' } }
  }
  const parts = (Array.isArray(j.parts) ? j.parts : []).map(part).filter((p: ModelPart | null): p is ModelPart => !!p)
  const st = stats(j.stats)
  const prints = Array.isArray(j.prints) ? j.prints.map(String).slice(0, 200) : []
  if (!j.ok || j.error) return { ok: false, parts, stats: st, prints, warnings: [], error: parseBuildError(String(j.error?.message ?? 'the build script failed')) }
  return { ok: true, ...(typeof j.name === 'string' ? { name: j.name } : {}), parts, stats: st, prints, warnings: buildWarnings(parts, st) }
}
