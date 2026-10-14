// Prompt assembly for "Restate first": the cheap-tier prompt that writes the restatement, parsing
// its answer, the confirmed block that goes into the chat turn / Labs compose / critic prompts, and
// the edit check that decides when a correction is worth a memory note.

import { normalizeRestatement, type RestateKind, type Restatement } from './types.ts'

const WHAT: Record<RestateKind, string> = {
  chat: 'a request to the coding assistant of a Roblox game project (Luau, Rojo)',
  vfx: 'a brief for a Roblox visual effect in the VFX Lab (particles, beams, trails, lights, multi-stage sequences)',
  anim: 'a brief for a Roblox character animation in the Animation Lab (R15 / R6 keyframes, timing, poses)',
  ability: 'a brief for a game "move" in the Ability Composer (an animation, VFX, camera shake, hit-stop and movement on one timeline)',
  thumbs: 'a brief for a Roblox experience thumbnail in the Thumbnail Lab (generated variations built from screenshots of the real game, in a learned style)'
}

// A correction the person made to an earlier restatement (newest last), so the next one reads
// their phrasing better.
export interface RestateCorrection {
  kind: RestateKind
  request: string
  draft: Restatement
  confirmed: Restatement
  at: number
}

export function restateSystem(kind: RestateKind, corrections: RestateCorrection[] = []): string {
  const past = corrections.slice(-4)
  const lines = [
    `You restate ${WHAT[kind]} in your own words before any work starts, so the person can confirm you understood them.`,
    'Write what they want to end up with (goal), the problem they are trying to solve (the why behind it, not a rephrase of the goal), and up to 3 assumptions you are making where the request is open (scope, files, style, numbers). Each of goal and problem is one or two short lines. Plain words, no preamble, no promises, no plan.',
    'Answer with JSON only: {"goal": "...", "problem": "...", "assumptions": ["...", "..."]}'
  ]
  if (past.length) {
    lines.push(
      'Earlier this person corrected restatements like this; read their phrasing the same way:\n' +
        past.map((c) => `- Request: "${c.request.slice(0, 160)}"\n  You wrote goal: ${c.draft.goal}\n  They meant: ${c.confirmed.goal}${c.confirmed.problem && c.confirmed.problem !== c.draft.problem ? ` (problem: ${c.confirmed.problem})` : ''}`).join('\n')
    )
  }
  return lines.join('\n\n')
}

export function restatePrompt(request: string): string {
  return `Request:\n"""\n${String(request ?? '').trim().slice(0, 6000)}\n"""`
}

// The model's answer -> a restatement. JSON first, then "Goal: / Problem: / Assumptions:" lines.
export function parseRestatement(raw: string): Restatement | null {
  const text = String(raw ?? '').replace(/```(?:json)?/g, '')
  const m = /\{[\s\S]*\}/.exec(text)
  if (m) {
    try {
      const r = normalizeRestatement(JSON.parse(m[0]))
      if (r) return r
    } catch {
      // fall through to the labelled form
    }
  }
  const field = (name: string) => new RegExp(`^\\s*(?:\\*\\*)?${name}(?:\\*\\*)?\\s*:(?:\\*\\*)?\\s*(.*)$`, 'im').exec(text)?.[1]?.trim() ?? ''
  const goal = field('goal') || field('what i think you want')
  if (!goal) return null
  const after = /assumptions?\s*:?\s*\n([\s\S]*)$/i.exec(text)?.[1] ?? ''
  const assumptions = after
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(?:[-*•]|\d+[.)])\s+/.test(l))
  return normalizeRestatement({ goal, problem: field('problem(?: being solved)?') || field('the problem'), assumptions })
}

// Labels: the chat says Goal / Problem being solved; the Labs speak to a brief.
export function restateLabels(kind: RestateKind): { goal: string; problem: string; assumptions: string } {
  return kind === 'chat' ? { goal: 'Goal', problem: 'Problem being solved', assumptions: 'Assumptions' } : { goal: 'What I think you want', problem: 'The problem', assumptions: 'Assumptions' }
}

// Markdown for the card message text (what other models and transcripts see).
export function formatRestatement(r: Restatement, kind: RestateKind = 'chat'): string {
  const l = restateLabels(kind)
  const lines = [`**${l.goal}:** ${r.goal}`]
  if (r.problem) lines.push(`**${l.problem}:** ${r.problem}`)
  if (r.assumptions.length) lines.push(`**${l.assumptions}:**\n${r.assumptions.map((a) => `- ${a}`).join('\n')}`)
  return lines.join('\n')
}

function plain(r: Restatement): string {
  return [`Goal: ${r.goal}`, r.problem ? `Problem being solved: ${r.problem}` : '', r.assumptions.length ? `Assumptions:\n${r.assumptions.map((a) => `- ${a}`).join('\n')}` : ''].filter(Boolean).join('\n')
}

// The chat turn's prompt after a yes: the request plus the reading the person approved.
export function withRestatement(request: string, r: Restatement, edited = false): string {
  return `${request.trim()}\n\n[Confirmed restatement: the user ${edited ? 'corrected and then approved' : 'approved'} this reading of the request. Work toward this goal; where it differs from the wording above, it wins.]\n${plain(r)}`
}

// Labs compose prompt block (after "Make: ...").
export function restatementBlock(r: Restatement | null | undefined): string {
  if (!r) return ''
  return `The user confirmed this reading of the brief (it wins over the wording when they differ):\n${plain(r)}`
}

// What the Labs critics judge against: the brief plus the confirmed reading.
export function criticBrief(origin: string, r: Restatement | null | undefined): string {
  if (!r) return origin
  return `${origin}\n(Confirmed goal: ${r.goal}${r.problem ? ` Problem: ${r.problem}` : ''}${r.assumptions.length ? ` Assumptions: ${r.assumptions.join('; ')}` : ''})`
}

// ---------------------------------------------------------------- edits

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  )
}

// Jaccard similarity of the content words (1 = same words).
export function similarity(a: string, b: string): number {
  const x = tokens(a)
  const y = tokens(b)
  if (!x.size && !y.size) return 1
  let both = 0
  for (const w of x) if (y.has(w)) both++
  return both / (x.size + y.size - both)
}

export function sameRestatement(a: Restatement, b: Restatement): boolean {
  return a.goal === b.goal && a.problem === b.problem && a.assumptions.join('\n') === b.assumptions.join('\n')
}

// Substantial: the goal or the problem changed meaning, or the whole thing reads differently.
// Typo fixes and small rewordings are not.
export function isSubstantialEdit(draft: Restatement, edited: Restatement): boolean {
  if (sameRestatement(draft, edited)) return false
  const goal = similarity(draft.goal, edited.goal)
  const problem = similarity(draft.problem, edited.problem)
  const all = similarity(plain(draft), plain(edited))
  return goal < 0.6 || problem < 0.5 || all < 0.7
}

// The memory note for corrections (one per scope, rewritten with the newest few).
export function correctionNote(list: RestateCorrection[], scope: 'chat' | 'labs'): { name: string; description: string; body: string } {
  const recent = list.slice(-6)
  const where = scope === 'chat' ? 'chat requests' : 'Labs briefs (VFX, animation, ability)'
  return {
    name: `restate-corrections-${scope}`,
    description: `How the user phrases goals: corrections they made to Forge's restatements of ${where}`.slice(0, 200),
    body: [
      `When Forge restated ${where}, the user corrected the reading like this (newest last). Read similar requests their way.`,
      '',
      ...recent.map((c) => `- ${c.kind !== 'chat' ? `[${c.kind}] ` : ''}"${c.request.replace(/\s+/g, ' ').slice(0, 140)}"\n  Forge read: ${c.draft.goal}\n  They meant: ${c.confirmed.goal}${c.confirmed.problem && similarity(c.draft.problem, c.confirmed.problem) < 0.5 ? `\n  Problem, in their words: ${c.confirmed.problem}` : ''}`)
    ]
      .join('\n')
      .slice(0, 2900)
  }
}
