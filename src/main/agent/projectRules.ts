// Per-project instructions appended to every agent's system prompt: the team's .forge/project.json
// "aiRules" (and "conventions"), plus the project's AGENTS.md when present at the root.
//
// Prompt caching: the block only changes when those files change, so it is appended AFTER the
// constant base prompt (the base stays a cacheable prefix) and is byte-identical between turns.
// It is capped (default 2000 chars) so a long AGENTS.md cannot blow up every request; a cut is
// marked so the model knows to read the file itself.

import type { HarnessContext } from '../context.ts'

export const RULES_CAP = 2000
export const PROJECT_CONFIG_FILE = '.forge/project.json'
export const AGENTS_FILE = 'AGENTS.md'

export interface RulesSources {
  aiRules?: string
  conventions?: string
  agentsMd?: string
}

function clean(text: string | undefined): string {
  return (text ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// Builds the appended block, or '' when there is nothing. Order of priority when cutting:
// aiRules (explicit rules for the AI) first, then conventions, then AGENTS.md.
export function buildRulesBlock(src: RulesSources, cap = RULES_CAP): string {
  const parts: { title: string; body: string; file: string }[] = []
  const rules = clean(src.aiRules)
  const conventions = clean(src.conventions)
  const agents = clean(src.agentsMd)
  if (rules) parts.push({ title: 'Team rules (.forge/project.json aiRules)', body: rules, file: PROJECT_CONFIG_FILE })
  if (conventions) parts.push({ title: 'Team conventions (.forge/project.json)', body: conventions, file: PROJECT_CONFIG_FILE })
  if (agents) parts.push({ title: 'AGENTS.md (project root)', body: agents, file: AGENTS_FILE })
  if (!parts.length) return ''

  const header = '\n\n# Project instructions\nFollow these rules for this game; they override the general working rules above when they conflict.'
  let budget = Math.max(200, cap)
  const out: string[] = [header]
  budget -= header.length
  for (const p of parts) {
    const title = `\n\n## ${p.title}\n`
    if (budget <= title.length + 40) {
      out.push(`\n\n[${p.title} omitted: instructions too long; read ${p.file} with read_script.]`)
      continue
    }
    budget -= title.length
    let body = p.body
    if (body.length > budget) {
      const note = `\n[…truncated; read ${p.file} for the rest]`
      body = body.slice(0, Math.max(0, budget - note.length)).trimEnd() + note
    }
    budget -= body.length
    out.push(title + body)
  }
  return out.join('')
}

// Reads the sources through the HarnessContext (repo-relative, project-bounded). Missing or
// invalid files are simply skipped.
export async function readRulesSources(ctx: Pick<HarnessContext, 'readFile' | 'project'>): Promise<RulesSources> {
  if (!ctx.project()) return {}
  const out: RulesSources = {}
  try {
    const json = JSON.parse(await ctx.readFile(PROJECT_CONFIG_FILE)) as Record<string, unknown>
    if (typeof json.aiRules === 'string') out.aiRules = json.aiRules
    if (typeof json.conventions === 'string') out.conventions = json.conventions
  } catch {
    // no config, or not JSON
  }
  try {
    out.agentsMd = await ctx.readFile(AGENTS_FILE)
  } catch {
    // no AGENTS.md
  }
  return out
}

// The block for the open project. Cached for a few seconds so a burst of agent starts (test
// agents, orchestrator tasks) reads the files once.
export function projectRulesLoader(ctx: Pick<HarnessContext, 'readFile' | 'project'>, ttlMs = 5000): () => Promise<string> {
  let cache: { at: number; root: string; text: string } | null = null
  return async () => {
    const root = ctx.project()?.root ?? ''
    if (!root) return ''
    if (cache && cache.root === root && Date.now() - cache.at < ttlMs) return cache.text
    const text = buildRulesBlock(await readRulesSources(ctx))
    cache = { at: Date.now(), root, text }
    return text
  }
}

// Appends the rules block to a system prompt (no-op when empty).
export function withRules(system: string, rules: string): string {
  return rules ? system + rules : system
}
