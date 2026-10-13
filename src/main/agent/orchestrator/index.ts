// Multi-agent orchestration for the Forge AI layer. See CONTRACT.md.
export * from './types.ts'
export { Orchestrator, clipToTokens, type OrchestratorDeps, type RunHandle, type StartOptions } from './engine.ts'
export { validatePlan, findCycle, topoOrder, ancestors, planErrorText, planSummary } from './plan.ts'
export { LockManager, LEAD_OWNER, normalizePath, overlaps, covers } from './locks.ts'
export { capsBudget, countTokens, addUsage, emptyUsage, DEFAULT_CAPS, type OrchestratorCaps } from './budget.ts'
export { shouldOrchestrate, TEAM_THRESHOLD, type OrchestrateMode, type OrchestrateDecision, type ProjectHint } from './heuristic.ts'
export {
  ROLE_DEFAULTS,
  DEFAULT_SETTINGS,
  DEFAULT_HOT_FILES,
  LEAD_PROMPT,
  SCOUT_PROMPT,
  BUILDER_PROMPT,
  TESTER_PROMPT,
  REVIEWER_PROMPT,
  classifyTool,
  toolsForRole,
  roleModel,
  mergeSettings,
  type TierModels,
  type Tier
} from './roles.ts'
export { guardWriteTool, defaultWriteTargets, type WriteTargets } from './agentTools.ts'
export { sdkRunAgent, sdkToEvents, sdkOptionsFor, SdkUsageDelta, openAiRunAgent, channel, ORCH_SERVER, SDK_DISALLOWED } from './adapters.ts'
