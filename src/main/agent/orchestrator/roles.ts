// Role defaults: model tier, tool classes, turn caps and system prompts.
//
// The prompts are constants: byte-identical across runs and requests, so providers can cache the
// system prefix (and the tool list, which the engine also builds in a stable order). Everything
// request-specific (the user request, project info, plan, summaries) goes in the user prompt.

import type { OrchestratorSettings, OrchTool, Role, ToolClass } from './types.ts'

export type Tier = 'big' | 'cheap'

export interface RoleDefaults {
  tier: Tier
  // Base tool classes the role receives.
  classes: ToolClass[]
  // Writer roles claim their planned files and get the write guard.
  writer: boolean
  // Optional allowlist of write-class tool names (tester: only spec creation).
  writeTools?: string[]
  maxTurns: number
  system: string
}

const COMMON = `You are part of a team of agents working on a Roblox game in the GenTree layout (Rojo; Luau).
Layout: src/shared -> ReplicatedStorage.Shared, src/server -> ServerScriptService.Server, src/client -> StarterPlayer client scripts. Features: src/shared/Features/<Name> (config), src/server/Features/<Name> (Service), src/client/Client/Controllers/<Name>Controller. ModuleLoader calls Init(janitor) on all modules, then Start(); cross-module wiring goes in Start. Networking: Blink events in events.blink (generated src/shared/events/*.luau are never edited). Packages/ is Wally-managed: never edit.
Tool names may carry an mcp__<server>__ prefix. Prefer cheap tools: project map and search before reading whole files. Be terse.`

const SPECIALIST_END = `Finish by calling submit_result exactly once: status (done | partial | failed), a summary of at most a few sentences (what you did or found, with file paths; no code dumps), filesChanged, and followups (short items the lead should know). Your transcript is not shown to the lead; only submit_result is.`

export const LEAD_PROMPT = `${COMMON}

You are the LEAD. You plan, delegate and integrate; specialists do the work.
Planning: orient cheaply, then call submit_plan with tasks {id, role, goal, files, dependsOn}. Roles: scout (read-only research), builder (edits only its claimed files), tester (Lune specs and test runs), reviewer (reviews changed files against GenTree conventions). Give each builder a disjoint set of files; builders on the same file must be ordered with dependsOn. events.blink, wally.toml and default.project.json are yours alone: no builder may list them; builders ask you via request_change. Keep tasks few and goals self-contained (the specialist sees only its goal and its dependencies' summaries). If the request is small, do it without a plan once integration starts, or answer directly without calling submit_plan.
Integration: you receive each task's compact result and any change requests. Apply requested hot-file edits, fix small gaps yourself, call submit_plan again only if substantial work remains, and end with a short answer for the user.`

export const SCOUT_PROMPT = `${COMMON}

You are a SCOUT: read-only research. Find the files, symbols and facts the goal asks for. You cannot edit anything.
${SPECIALIST_END}`

export const BUILDER_PROMPT = `${COMMON}

You are a BUILDER. Implement the goal by editing only the files claimed for your task (listed in your prompt). Writes to other files are refused: call claim_files for a NEW file nobody owns, or request_change to ask the lead for edits to shared files (events.blink, wally.toml, default.project.json) or files owned by other tasks. Keep edits minimal and in the existing style.
${SPECIALIST_END}`

export const TESTER_PROMPT = `${COMMON}

You are a TESTER. Write or update Lune specs (create_spec) for the goal and run them (run_tests). You may only write the spec files claimed for your task. Report failures precisely (spec, assertion, likely cause) in your summary.
${SPECIALIST_END}`

export const REVIEWER_PROMPT = `${COMMON}

You are a REVIEWER. Use run_diff to see what this run changed and review it against GenTree conventions: correct realm/folder, Service/Controller Init vs Start wiring, janitor cleanup, Blink events declared in events.blink (generated files untouched), no Packages/ edits, Luau style consistent with neighbours. You cannot edit. Report concrete issues with file:line, most severe first; status failed if any issue must be fixed.
${SPECIALIST_END}`

export const ROLE_DEFAULTS: Record<Role, RoleDefaults> = {
  lead: { tier: 'big', classes: ['read', 'diff'], writer: false, maxTurns: 40, system: LEAD_PROMPT },
  scout: { tier: 'cheap', classes: ['read'], writer: false, maxTurns: 20, system: SCOUT_PROMPT },
  builder: { tier: 'big', classes: ['read', 'write'], writer: true, maxTurns: 40, system: BUILDER_PROMPT },
  tester: { tier: 'cheap', classes: ['read', 'test', 'write'], writer: true, writeTools: ['create_spec'], maxTurns: 25, system: TESTER_PROMPT },
  reviewer: { tier: 'cheap', classes: ['read', 'diff'], writer: false, maxTurns: 15, system: REVIEWER_PROMPT }
}

export const DEFAULT_HOT_FILES = ['events.blink', 'wally.toml', 'default.project.json']

export const DEFAULT_SETTINGS: OrchestratorSettings = {
  maxParallel: 3,
  maxRounds: 2,
  maxTasks: 12,
  maxPlanAttempts: 3,
  taskTimeoutMs: 10 * 60_000,
  maxSummaryTokens: 300,
  hotFiles: DEFAULT_HOT_FILES,
  roles: {}
}

export function mergeSettings(s?: Partial<OrchestratorSettings>): OrchestratorSettings {
  const out: OrchestratorSettings = { ...DEFAULT_SETTINGS, roles: { ...DEFAULT_SETTINGS.roles } }
  if (!s) return out
  for (const k of ['maxParallel', 'maxRounds', 'maxTasks', 'maxPlanAttempts', 'taskTimeoutMs', 'maxSummaryTokens'] as const) {
    const v = s[k]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = Math.floor(v)
  }
  if (Array.isArray(s.hotFiles)) out.hotFiles = s.hotFiles.filter((f) => typeof f === 'string' && f.trim())
  if (s.roles && typeof s.roles === 'object') out.roles = { ...s.roles }
  return out
}

export interface TierModels {
  big: string
  cheap: string
}

// Model for a role: per-role setting, else the tier model (budget/budget.ts tiersFor() for the
// provider), else the fallback (the chat's chosen model, e.g. for ollama/custom).
export function roleModel(role: Role, settings: OrchestratorSettings, tiers: TierModels | null, fallback: string): string {
  const explicit = settings.roles[role]?.model?.trim()
  if (explicit) return explicit
  return tiers ? tiers[ROLE_DEFAULTS[role].tier] : fallback
}

export function roleMaxTurns(role: Role, settings: OrchestratorSettings): number {
  const n = settings.roles[role]?.maxTurns
  return typeof n === 'number' && n > 0 ? Math.floor(n) : ROLE_DEFAULTS[role].maxTurns
}

// ---------------------------------------------------------------------------------------------
// Tool classification.

const WRITE = new Set(['write_script', 'edit_script', 'new_feature', 'create_spec', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const TEST = new Set(['run_tests', 'run_spec', 'list_specs'])
const DIFF = new Set(['diff', 'git_diff', 'changed_files', 'run_diff'])
const ADMIN = new Set(['sync_collaborators', 'resolve_studio_conflict', 'restart_service', 'Bash'])

// Default classifier by (unprefixed) tool name. Unknown tools are 'read'; integrators adding a new
// mutating tool must classify it (OrchestratorDeps.classify) or it would be handed out as read.
export function classifyTool(name: string): ToolClass {
  const bare = name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '')
  if (WRITE.has(bare)) return 'write'
  if (ADMIN.has(bare)) return 'admin'
  if (TEST.has(bare) || bare.startsWith('lune_')) return 'test'
  if (DIFF.has(bare)) return 'diff'
  return 'read'
}

// Filters base tools for a role, in a stable (name-sorted) order for prompt caching.
export function toolsForRole(role: Role, tools: OrchTool<any>[], classify: (name: string) => ToolClass = classifyTool): OrchTool<any>[] {
  const d = ROLE_DEFAULTS[role]
  return tools
    .filter((t) => {
      const c = classify(t.name)
      if (!d.classes.includes(c)) return false
      if (c === 'write' && d.writeTools && !d.writeTools.includes(t.name)) return false
      return true
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
