// Learning a style from the library (pure code, no model): per move type (tag) the timing of the
// references (anticipation, action, recovery, holds, overshoot), how they ease, how wide their key
// poses open, and a pose vocabulary (k-means over the key poses of every clip with that tag). Liked
// clips count double; disliked ones never feed the numbers and become "avoid" notes instead. The
// profile goes into the compose prompt, the critic, the timing check and a memory skill per tag.

import type { AnimClip, AnimEntry, AnimStyle, AnimStyleProfile, LearnedPose, Pct, R15Joint, RigType } from './model.ts'
import { R15_JOINTS } from './model.ts'
import { eulerDegOf, qangle, qnorm, round, type Quat } from './math.ts'
import { measureClip, speedCurve } from './measure.ts'
import { clipRig, samplePose } from './sample.ts'
import { r15View } from './convert.ts'

// Move types the Lab knows (tags), with the words that suggest them.
export const MOVE_TAGS: Record<string, RegExp> = {
  attack: /\b(attack|punch|jab|cross|hook|uppercut|slash|strike|swing|combo|hit\s?combo|smash|stab|thrust|m1|melee|cleave|lunge)\b/i,
  kick: /\b(kick|roundhouse|sweep|axe\s?kick|stomp)\b/i,
  cast: /\b(cast|spell|beam|blast|charge|channel|summon|projectile|fireball|magic|ability|technique|push|palm|purple|red|blue|domain)\b/i,
  sign: /\b(sign|seal|mudra|hand\s?sign|gojo|finger|jutsu|domain\s?expansion|pose)\b/i,
  dash: /\b(dash|dodge|roll|blink|step|evade|sidestep|teleport|lunge)\b/i,
  idle: /\b(idle|breath|breathing|stance|ready|wait|loop)\b/i,
  hit: /\b(hit|hurt|damage|stagger|knockback|flinch|react(?:ion)?|recoil|stun|getting\s?hit|knocked)\b/i,
  block: /\b(block|parry|guard|defend|shield)\b/i,
  jump: /\b(jump|leap|hop|double\s?jump|air)\b/i,
  land: /\b(land|landing|impact)\b/i,
  walk: /\b(walk|stroll)\b/i,
  run: /\b(run|sprint|jog)\b/i,
  emote: /\b(emote|dance|wave|taunt|cheer|bow|celebrat\w*|point)\b/i
}

export const CORE_TAGS = ['attack', 'cast', 'dash', 'idle', 'hit', 'sign'] as const

// Tags for a request or a file name.
export function promptTags(text: string): string[] {
  const out: string[] = []
  const words = String(text ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
  for (const [tag, re] of Object.entries(MOVE_TAGS)) if (re.test(words)) out.push(tag)
  return out
}

// Suggested tags for an imported clip: words in its name plus what the motion looks like.
export function autoTags(clip: AnimClip, fileName = ''): string[] {
  const tags = new Set(promptTags(`${clip.name} ${fileName}`))
  const s = measureClip(clip)
  const root = r15View(clip).tracks.Root ?? []
  let travel = 0
  if (root.length > 1) {
    const a = root[0].cf
    const b = root[root.length - 1].cf
    travel = Math.hypot(b[0] - a[0], b[2] - a[2])
  }
  if (clip.looped && s.spread < 1.3 && s.duration >= 1.2) tags.add('idle')
  if (clip.looped && travel < 0.2 && s.keyRate > 3 && !tags.size) tags.add('walk')
  if (travel > 1.5) tags.add('dash')
  if (!clip.looped && s.duration <= 1.6 && s.spread > 1.5 && s.anticipation > 0.05 && !tags.has('hit') && !tags.has('dash')) tags.add('attack')
  if (!tags.has('hit') && clip.markers.some((m) => /hit|impact|damage/i.test(m.name))) tags.add('attack')
  if (clip.markers.some((m) => /release|cast|fire|charge/i.test(m.name))) tags.add('cast')
  return [...tags].slice(0, 6)
}

// ------------------------------------------------------------------ percentiles

export function pct(values: number[]): Pct {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return { p10: 0, median: 0, p90: 0 }
  const at = (q: number) => {
    const i = (v.length - 1) * q
    const lo = Math.floor(i)
    const hi = Math.ceil(i)
    return round(v[lo] + (v[hi] - v[lo]) * (i - lo), 3)
  }
  return { p10: at(0.1), median: at(0.5), p90: at(0.9) }
}

// ------------------------------------------------------------------ pose vocabulary

interface PoseSample {
  q: Partial<Record<R15Joint, Quat>>
  phase: number
}

const POSE_JOINTS: R15Joint[] = R15_JOINTS.filter((j) => j !== 'LeftWrist' && j !== 'RightWrist' && j !== 'LeftAnkle' && j !== 'RightAnkle')

// Key poses of a clip: the quiet moments (speed minima: where a pose is "hit") and the start/end.
export function keyPoses(clip: AnimClip): PoseSample[] {
  const { t, v } = speedCurve(clip, 30)
  const peak = Math.max(...v, 1)
  const picks = new Set<number>([0, t.length - 1])
  for (let i = 1; i < v.length - 1; i++) if (v[i] <= v[i - 1] && v[i] <= v[i + 1] && v[i] < peak * 0.45) picks.add(i)
  const out: PoseSample[] = []
  for (const i of [...picks].sort((a, b) => a - b)) {
    const pose = samplePose({ ...clip, looped: false }, t[i])
    const q: PoseSample['q'] = {}
    for (const j of POSE_JOINTS) q[j] = pose[j]?.q ?? [0, 0, 0, 1]
    out.push({ q, phase: clip.duration > 0 ? t[i] / clip.duration : 0 })
  }
  // Collapse neighbours that are the same pose (a hold reads as one key pose).
  return out.filter((p, i) => i === 0 || poseDistance(p, out[i - 1]) > 0.12)
}

export function poseDistance(a: PoseSample, b: PoseSample): number {
  let d = 0
  for (const j of POSE_JOINTS) d += qangle(a.q[j] ?? [0, 0, 0, 1], b.q[j] ?? [0, 0, 0, 1])
  return d / POSE_JOINTS.length
}

function meanPose(ps: PoseSample[]): PoseSample {
  const q: PoseSample['q'] = {}
  for (const j of POSE_JOINTS) {
    const ref = ps[0].q[j] ?? [0, 0, 0, 1]
    const acc: Quat = [0, 0, 0, 0]
    for (const p of ps) {
      let x = p.q[j] ?? [0, 0, 0, 1]
      if (x[0] * ref[0] + x[1] * ref[1] + x[2] * ref[2] + x[3] * ref[3] < 0) x = [-x[0], -x[1], -x[2], -x[3]]
      for (let k = 0; k < 4; k++) acc[k] += x[k]
    }
    q[j] = qnorm(acc)
  }
  return { q, phase: ps.reduce((s, p) => s + p.phase, 0) / ps.length }
}

// k-means over key poses (farthest-point init, a few rounds); centroids sorted by phase.
export function clusterPoses(samples: PoseSample[], k: number, tag: string): LearnedPose[] {
  if (!samples.length) return []
  const kk = Math.max(1, Math.min(k, samples.length))
  const centers: PoseSample[] = [samples[0]]
  while (centers.length < kk) {
    let best = samples[0]
    let bd = -1
    for (const s of samples) {
      const d = Math.min(...centers.map((c) => poseDistance(s, c)))
      if (d > bd) {
        bd = d
        best = s
      }
    }
    if (bd <= 0.02) break
    centers.push(best)
  }
  let groups: PoseSample[][] = []
  for (let round = 0; round < 8; round++) {
    groups = centers.map(() => [])
    for (const s of samples) {
      let bi = 0
      let bd = Infinity
      centers.forEach((c, i) => {
        const d = poseDistance(s, c)
        if (d < bd) {
          bd = d
          bi = i
        }
      })
      groups[bi].push(s)
    }
    for (let i = 0; i < centers.length; i++) if (groups[i].length) centers[i] = meanPose(groups[i])
  }
  return centers
    .map((c, i) => ({ c, n: groups[i]?.length ?? 0 }))
    .filter((x) => x.n > 0)
    .sort((a, b) => a.c.phase - b.c.phase)
    .map(({ c, n }, i) => {
      const joints: LearnedPose['joints'] = {}
      for (const j of POSE_JOINTS) {
        if (j === 'Root') continue
        const e = eulerDegOf(c.q[j] ?? [0, 0, 0, 1])
        if (Math.abs(e[0]) + Math.abs(e[1]) + Math.abs(e[2]) > 1.5) joints[j] = [round(e[0], 1), round(e[1], 1), round(e[2], 1)]
      }
      const r = eulerDegOf(c.q.Root ?? [0, 0, 0, 1])
      return { id: `${tag}:${i + 1}`, tag, count: n, phase: round(c.phase, 2), joints, ...(Math.abs(r[0]) + Math.abs(r[1]) + Math.abs(r[2]) > 1.5 ? { root: [round(r[0], 1), round(r[1], 1), round(r[2], 1)] as [number, number, number] } : {}) }
    })
}

// ------------------------------------------------------------------ profiles

const usable = (e: AnimEntry) => e.quality !== 'avoid' && e.rating !== 'down'

export function buildProfile(tag: string, entries: AnimEntry[]): AnimStyleProfile | null {
  const pos = entries.filter((e) => (tag === '*' || e.tags.includes(tag)) && usable(e))
  const bad = entries.filter((e) => (tag === '*' || e.tags.includes(tag)) && !usable(e))
  if (!pos.length && !bad.length) return null
  const weighted: { e: AnimEntry; s: ReturnType<typeof measureClip> }[] = []
  for (const e of pos) {
    const s = e.stats ?? measureClip(e.clip)
    weighted.push({ e, s })
    if (e.rating === 'up' || e.quality === 'good') weighted.push({ e, s })
  }
  const col = (f: (s: ReturnType<typeof measureClip>) => number) => pct(weighted.map((w) => f(w.s)))
  const easing = new Map<string, number>()
  let easeTotal = 0
  for (const w of weighted) for (const [k, n] of Object.entries(w.s.easing)) {
    easing.set(k, (easing.get(k) ?? 0) + n)
    easeTotal += n
  }
  const samples = pos.flatMap((e) => keyPoses(e.clip))
  const poses = clusterPoses(samples, Math.min(6, Math.max(1, Math.ceil(samples.length / 3))), tag === '*' ? 'any' : tag)
  const timing = { duration: col((s) => s.duration), anticipation: col((s) => s.anticipation), action: col((s) => s.action), recovery: col((s) => s.recovery), holds: col((s) => s.holds) }
  const overshootP = col((s) => s.overshoot)
  const spreadP = col((s) => s.spread)
  const notes: string[] = []
  if (weighted.length) {
    notes.push(`Anticipation about ${Math.round(timing.anticipation.median * 30)} frames, action ${Math.round(timing.action.median * 30)} frames, recovery ${Math.round(timing.recovery.median * 30)} frames at 30 fps.`)
    if (timing.holds.median > 0.05) notes.push(`Holds key poses for about ${timing.holds.median.toFixed(2)} s in total.`)
    if (overshootP.median > 0.08) notes.push(`Limbs overshoot by about ${Math.round(overshootP.median * 100)}% before settling.`)
    if (spreadP.median > 1.6) notes.push(`Strong silhouettes: key poses open to ${spreadP.median.toFixed(2)}x the standing spread.`)
    const top = [...easing.entries()].sort((a, b) => b[1] - a[1])[0]
    if (top && easeTotal) notes.push(`Most keys ease ${top[0]} (${Math.round((top[1] / easeTotal) * 100)}%).`)
  }
  const avoid = bad.slice(0, 8).map((e) => `${e.name}${e.notes ? `: ${e.notes.slice(0, 140)}` : e.description ? `: ${e.description.slice(0, 120)}` : ''}`)
  return {
    tag,
    samples: pos.length,
    liked: pos.filter((e) => e.rating === 'up' || e.quality === 'good').length,
    timing,
    overshoot: overshootP,
    keyRate: col((s) => s.keyRate),
    spread: spreadP,
    easing: [...easing.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([style, n]) => ({ style, share: round(n / Math.max(1, easeTotal), 3) })),
    poses,
    notes,
    avoid
  }
}

function buildRigProfiles(entries: AnimEntry[], rig: RigType): { profiles: AnimStyleProfile[]; overall: AnimStyleProfile | null } {
  const mine = entries.filter((e) => clipRig(e.clip) === rig)
  const tags = new Set<string>()
  for (const e of mine) for (const t of e.tags) if (MOVE_TAGS[t]) tags.add(t)
  const tagRig = (p: AnimStyleProfile | null) => (p && rig === 'R6' ? { ...p, rig, poses: p.poses.map((x) => ({ ...x, id: `r6-${x.id}` })) } : p)
  const profiles = [...tags].sort().map((t) => tagRig(buildProfile(t, mine))).filter((p): p is AnimStyleProfile => !!p)
  return { profiles, overall: tagRig(buildProfile('*', mine)) }
}

// Profiles are kept per rig: R15 clips feed profiles / overall, R6 clips feed r6. Timing transfers
// between rigs, poses do not (an R6 pose has no elbows or knees), so each rig learns from its own clips.
export function buildStyle(entries: AnimEntry[], now = Date.now()): AnimStyle {
  const r15 = buildRigProfiles(entries, 'R15')
  const r6 = buildRigProfiles(entries, 'R6')
  return { updatedAt: now, profiles: r15.profiles, overall: r15.overall, ...(r6.profiles.length || r6.overall ? { r6 } : {}) }
}

// The profile for a move type on a rig. An R6 request uses the R6 profiles first and falls back to
// the R15 ones (their timing still applies; their poses are collapsed when used on R6).
export function profileFor(style: AnimStyle | null, tags: string[], rig: RigType = 'R15'): AnimStyleProfile | null {
  if (!style) return null
  const sets = rig === 'R6' ? [style.r6 ?? { profiles: [], overall: null }, style] : [style]
  for (const set of sets) {
    for (const t of tags) {
      const p = set.profiles.find((x) => x.tag === t && x.samples > 0)
      if (p) return p
    }
  }
  for (const set of sets) if (set.overall && set.overall.samples > 0) return set.overall
  return null
}

// Every profile of a style (both rigs).
export function allProfiles(style: AnimStyle | null): AnimStyleProfile[] {
  if (!style) return []
  return [...style.profiles, ...(style.overall ? [style.overall] : []), ...(style.r6?.profiles ?? []), ...(style.r6?.overall ? [style.r6.overall] : [])]
}

const f2 = (p: Pct) => `${p.p10.toFixed(2)}-${p.p90.toFixed(2)} s (median ${p.median.toFixed(2)})`

// The profile as prompt text (compose, critic, memory skill).
export function profileText(p: AnimStyleProfile): string {
  const lines = [
    `Learned ${p.rig ?? 'R15'} style for "${p.tag === '*' ? 'all moves' : p.tag}" (${p.samples} reference clip${p.samples === 1 ? '' : 's'}${p.liked ? `, ${p.liked} liked` : ''}):`,
    `- timing: anticipation ${f2(p.timing.anticipation)}, action ${f2(p.timing.action)}, recovery ${f2(p.timing.recovery)}, holds ${f2(p.timing.holds)}, whole clip ${f2(p.timing.duration)}`,
    `- overshoot ${Math.round(p.overshoot.median * 100)}% (p90 ${Math.round(p.overshoot.p90 * 100)}%), silhouette spread ${p.spread.median.toFixed(2)}x standing, ${p.keyRate.median.toFixed(1)} key times per second`,
    p.easing.length ? `- easing: ${p.easing.map((e) => `${e.style} ${Math.round(e.share * 100)}%`).join(', ')}` : '',
    ...p.notes.map((n) => `- ${n}`),
    p.poses.length ? `- pose vocabulary (use with a:pose("learned:<id>")): ${p.poses.map((x) => `${x.id} (phase ${x.phase}, ${x.count} keys)`).join(', ')}` : '',
    p.avoid.length ? `- the user disliked (never copy these): ${p.avoid.join(' | ')}` : ''
  ]
  return lines.filter(Boolean).join('\n')
}

export const PROFILE_SKILL_PREFIX = 'anim-style-'

export function profileSkill(p: AnimStyleProfile, examples: string[] = []): { name: string; description: string; body: string } {
  const tag = p.tag === '*' ? 'overall' : p.tag
  const r6 = p.rig === 'R6'
  return {
    name: `${PROFILE_SKILL_PREFIX}${r6 ? 'r6-' : ''}${tag}`,
    description: `Learned ${r6 ? 'R6' : 'R15'} animation style for ${tag} moves (timing, easing, key poses) from the user's Animation Lab library`,
    body: [
      profileText(p),
      examples.length ? `\nReference clips:\n${examples.map((e) => `- ${e}`).join('\n')}` : '',
      '\nTo make a clip in this style: anim_compose with the request (it reads this profile), iterate with anim_set_script, then anim_critique. Learned poses: a:pose("learned:<id>").'
    ].join('\n').slice(0, 7900)
  }
}

// Library coverage: clips per tag, liked vs disliked, and the thin categories to feed next.
export function coverage(entries: AnimEntry[]): { tags: { tag: string; clips: number; liked: number; disliked: number }[]; thin: string[] } {
  const rows = new Map<string, { tag: string; clips: number; liked: number; disliked: number }>()
  for (const t of [...CORE_TAGS, ...Object.keys(MOVE_TAGS)]) rows.set(t, { tag: t, clips: 0, liked: 0, disliked: 0 })
  for (const e of entries) {
    for (const t of e.tags) {
      if (t === 'example') continue
      const r = rows.get(t) ?? { tag: t, clips: 0, liked: 0, disliked: 0 }
      if (usable(e)) r.clips++
      if (e.rating === 'up' || e.quality === 'good') r.liked++
      if (!usable(e)) r.disliked++
      rows.set(t, r)
    }
  }
  const tags = [...rows.values()].filter((r) => r.clips || r.disliked || (CORE_TAGS as readonly string[]).includes(r.tag)).sort((a, b) => b.clips - a.clips || a.tag.localeCompare(b.tag))
  const thin = tags.filter((r) => (CORE_TAGS as readonly string[]).includes(r.tag) && r.clips < 3).map((r) => r.tag)
  return { tags, thin }
}
