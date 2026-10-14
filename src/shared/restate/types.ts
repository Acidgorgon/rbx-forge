// "Restate first": before a big chat task or a Labs compose, Forge restates the request in its own
// words (goal, problem being solved, assumptions) and waits for a yes or an edit.

export type RestateMode = 'always' | 'big' | 'never'
export const RESTATE_MODES: readonly RestateMode[] = ['always', 'big', 'never']

// Where the setting applies: the chat agent, or the Labs (VFX Lab, Animation Lab, Ability Composer).
export type RestateScope = 'chat' | 'labs'
export type RestateLab = 'vfx' | 'anim' | 'ability'
export type RestateKind = 'chat' | RestateLab

export interface Restatement {
  // 1-2 lines each.
  goal: string
  problem: string
  // Up to 3.
  assumptions: string[]
}

export interface RestateSettings {
  chat: RestateMode
  labs: RestateMode
}

export const RESTATE_SETTING = 'restate'
export const DEFAULT_RESTATE_SETTINGS: RestateSettings = { chat: 'big', labs: 'big' }

// The restatement card on a chat message (ChatMessage.restate).
export interface RestateCard {
  // The request as Forge understood it (a "/restate" prefix removed).
  request: string
  // Forge's reading.
  draft: Restatement
  // What the person confirmed (the draft, or their edit).
  confirmed?: Restatement
  state: 'pending' | 'confirmed' | 'dismissed'
  // Confirmed after an edit; substantial: different enough to note the correction in memory.
  edited?: boolean
  substantial?: boolean
  // Why the card was shown ("/restate", "big task: 3 files, 4 actions", "always").
  reason: string
  // The user message the request came from (its images go along on confirm).
  userMessageId?: string
}

export function isRestateMode(v: unknown): v is RestateMode {
  return v === 'always' || v === 'big' || v === 'never'
}

export function normalizeRestateSettings(raw: unknown): RestateSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    chat: isRestateMode(r.chat) ? r.chat : DEFAULT_RESTATE_SETTINGS.chat,
    labs: isRestateMode(r.labs) ? r.labs : DEFAULT_RESTATE_SETTINGS.labs
  }
}

const clip = (s: unknown, n: number): string =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n)

// Trims and caps a restatement (model output, UI edits). null when the goal is empty.
export function normalizeRestatement(raw: unknown): Restatement | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const goal = clip(r.goal, 320)
  if (!goal) return null
  const list = Array.isArray(r.assumptions) ? r.assumptions : typeof r.assumptions === 'string' ? r.assumptions.split('\n') : []
  return {
    goal,
    problem: clip(r.problem, 320),
    assumptions: list
      .map((a) => clip(String(a).replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ''), 200))
      .filter(Boolean)
      .slice(0, 3)
  }
}
