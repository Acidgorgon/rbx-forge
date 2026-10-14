// Shared types for the principle framework: the catalogues of animation and VFX principles, the
// per-principle scores the critics and the code checks produce, the user's learned weights and the
// feedback they are learned from. Pure types (no electron, no node).

export type PrincipleDomain = 'anim' | 'vfx' | 'thumb'
export type PrincipleLab = 'vfx' | 'anim' | 'ability' | 'thumbs'

// What a request is, for picking the principles that matter (select.ts).
export type AnimKind = 'attack' | 'idle' | 'locomotion' | 'emote' | 'reaction'
export type VfxKind = 'burst' | 'projectile' | 'slash' | 'aura' | 'charge'
export type RequestKind = AnimKind | VfxKind

export interface Principle {
  id: string
  domain: PrincipleDomain
  name: string
  // One-line rule.
  rule: string
  // How it applies to Roblox (rigid parts, emitters, Motor6Ds, the gameplay camera...).
  roblox: string
  good: string
  bad: string
  // What the code checks measure (null: judged by the critic only).
  measure: string | null
  // The compose planning question (short; null: not part of the plan).
  plan: string | null
  // Request kinds where it is core ('all' for every request).
  kinds: RequestKind[] | 'all'
  // Base importance (0.5..1.5); the user's learned weight multiplies it.
  base: number
  // Words in a user's notes that point at this principle (weight learning).
  words: RegExp
}

// One principle's score from the critic, the code checks or both.
export interface PrincipleScore {
  id: string
  // 0..10.
  score: number
  // What was seen or measured, concretely.
  note: string
  // What to change.
  fix?: string
  source: 'critic' | 'code' | 'both'
  // The code check's own score when both contributed.
  measured?: number
}

// A code check's result (checks in animChecks.ts / vfxChecks.ts / abilityChecks.ts).
export interface PrincipleCheck {
  id: string
  score: number
  note: string
  fix?: string
}

// Learned per-user weights: 1 = neutral; above 1 counts more in the overall score and the refine
// targeting, below 1 less. Missing ids are 1.
export type PrincipleWeights = Record<string, number>

export interface PrincipleFeedback {
  at: number
  lab: PrincipleLab
  entryId: string
  name?: string
  rating: 'up' | 'down'
  // Per-principle scores of the rated result (critic + code, or code only).
  scores: Record<string, number>
  // The user's notes on the entry, when any.
  notes?: string
}

export interface PrincipleEvidence {
  // Ratings that had a score for this principle.
  n: number
  up: number
  down: number
  // Times the user's notes mentioned it.
  mentions: number
  // Mean score on liked / disliked results.
  upMean: number | null
  downMean: number | null
}

export interface PrincipleProfile {
  version: 1
  updatedAt: number
  ratings: number
  weights: PrincipleWeights
  evidence: Record<string, PrincipleEvidence>
}

// What the "Your priorities" view shows.
export interface PrincipleView {
  profile: PrincipleProfile
  catalogue: { id: string; domain: PrincipleDomain; name: string; rule: string; measured: boolean }[]
  recent: PrincipleFeedback[]
}

// What the lab services need from the principle store (main/services/principles).
export interface PrincipleHooks {
  weights(): Promise<PrincipleWeights>
  record(feedback: Omit<PrincipleFeedback, 'at'>): Promise<void>
  // A rating was cleared: drop that entry's line.
  forget?(lab: PrincipleLab, entryId: string): Promise<void>
}
