// The memory block appended to agent system prompts.
//
// Token thrift: only the indexes go in (name + one-line description, capped per store); bodies are
// fetched with recall / use_skill. Prompt caching: the block is appended AFTER the constant base
// prompt and the project rules block (see projectRules.ts), and its text only changes when a memory
// is saved, removed or pinned. Index order is deliberately coarse (pinned, then a log2 bucket of the
// use count, then creation time) so ordinary recalls do not reshuffle it between turns.

import type { MemoryEntry } from './types.ts'

export const INDEX_CAP = 1500

export const MEMORY_GUIDANCE = `

# Memory and skills
You have a persistent memory that survives across chats: user memory (the person, across all their projects) and project memory (this game, committed to .forge/memory so the team shares it). Below are only the indexes; call recall {query} to read memory bodies and use_skill {name} to load a skill's steps before doing that kind of task.
Save (remember / save_skill, when you have them) only durable, non-obvious things, and only when:
- the person corrects you or states a preference (type feedback or user, scope user unless it is specific to this game);
- you discover a non-obvious project fact: a convention, a decision and its reason, an architecture fact (scope project);
- a multi-step procedure succeeded and is likely to recur (save_skill with when-to-use + numbered steps).
Never save secrets, credentials, personal data, one-off task state, or things the code or git history already says. Before saving, check the index: update the existing entry (same name) instead of adding a near-copy. If a memory turns out wrong, fix it or forget it. Memory can be stale: verify against the code before relying on a specific file or symbol.`

function bucket(uses: number): number {
  return Math.floor(Math.log2(1 + Math.max(0, uses)))
}

// Stable index order (see header).
export function indexOrder(entries: MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort(
    (a, b) =>
      Number(!!b.pinned) - Number(!!a.pinned) ||
      bucket(b.uses) - bucket(a.uses) ||
      a.created - b.created ||
      a.name.localeCompare(b.name)
  )
}

function line(e: MemoryEntry): string {
  const tag = e.kind === 'skill' ? 'skill' : e.type ?? e.scope
  return `- ${e.name} [${tag}]: ${e.description}`
}

// One store's index lines within `cap` characters; the rest is summarized as "+N more".
export function capIndex(entries: MemoryEntry[], cap = INDEX_CAP): string {
  const ordered = indexOrder(entries)
  const more = (n: number) => `- …+${n} more (recall {query} to search them)`
  const lines: string[] = []
  let used = 0
  for (let i = 0; i < ordered.length; i++) {
    const l = line(ordered[i])
    const rest = ordered.length - i - 1
    // Keep room for the "+N more" line whenever entries remain after this one.
    if (used + l.length + 1 + (rest ? more(rest).length + 1 : 0) > cap) {
      lines.push(more(ordered.length - i))
      break
    }
    lines.push(l)
    used += l.length + 1
  }
  return lines.join('\n')
}

export interface MemoryBlockInput {
  user: MemoryEntry[]
  project: MemoryEntry[]
  cap?: number
}

// The block appended after the rules block, or '' when there is nothing (no memories and no
// project): an empty memory still gets the guidance so agents know to start saving.
export function buildMemoryBlock(input: MemoryBlockInput): string {
  const cap = input.cap ?? INDEX_CAP
  const userMem = input.user.filter((e) => e.kind === 'memory')
  const projMem = input.project.filter((e) => e.kind === 'memory')
  const skills = [...input.project, ...input.user].filter((e) => e.kind === 'skill')
  const parts = [MEMORY_GUIDANCE]
  parts.push(`\n\n## User memory\n${userMem.length ? capIndex(userMem, cap) : '(empty)'}`)
  parts.push(`\n\n## Project memory\n${projMem.length ? capIndex(projMem, cap) : '(empty)'}`)
  if (skills.length) parts.push(`\n\n## Skills (use_skill {name} loads the steps)\n${capIndex(skills, cap)}`)
  return parts.join('')
}
