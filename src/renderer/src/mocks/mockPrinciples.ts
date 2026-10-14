// Browser-preview mock of PrincipleApi: an in-memory rating log seeded with a few Labs ratings, the
// weights learned from it with the real shared code (shared/principles/learn.ts), and a hook the lab
// mocks call when something is rated so the "Your priorities" view moves.
import type { HarnessEvents, PrincipleApi, PrincipleFeedback, PrincipleLab, PrincipleView } from '@shared/types'
import { ALL_PRINCIPLES } from '@shared/principles/catalog'
import { emptyProfile, learnProfile } from '@shared/principles/learn'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

const t0 = Date.UTC(2026, 9, 10, 12, 0)
let emitRef: Emit | null = null

// Seed: the user disliked results with weak arcs / dissipation and liked ones with strong
// anticipation, and wrote notes about floaty hits and effects popping off.
const feedback: PrincipleFeedback[] = [
  { at: t0, lab: 'anim', entryId: 'seed-a', name: 'HeavyPunch', rating: 'down', scores: { arcs: 3.8, anticipation: 7.5, timing: 6.5, 'follow-through': 5, readability: 7, 'weight-impact': 4.2 }, notes: 'feels floaty, the hit has no weight' },
  { at: t0 + 3_600_000, lab: 'vfx', entryId: 'seed-b', name: 'FireSlash', rating: 'down', scores: { 'fx-dissipation': 3, 'fx-contrast': 7, 'fx-layers': 7.5, 'fx-timing': 6.5, 'fx-shape': 6 }, notes: 'the sparks pop off at the end' },
  { at: t0 + 7_200_000, lab: 'anim', entryId: 'seed-c', name: 'SpinKick', rating: 'up', scores: { arcs: 8.5, anticipation: 8, timing: 7.5, 'follow-through': 8, readability: 6, 'weight-impact': 7 } },
  { at: t0 + 10_800_000, lab: 'vfx', entryId: 'seed-d', name: 'LightningImpact', rating: 'up', scores: { 'fx-dissipation': 8, 'fx-contrast': 8.5, 'fx-layers': 6, 'fx-timing': 7, 'fx-breakup': 4.5, 'fx-budget': 9 } },
  { at: t0 + 14_400_000, lab: 'ability', entryId: 'seed-e', name: 'DashPunch', rating: 'down', scores: { anticipation: 4, 'weight-impact': 3.5, 'fx-cohesion': 6, responsiveness: 9, 'follow-through': 6.5 } },
  { at: t0 + 18_000_000, lab: 'anim', entryId: 'seed-f', name: 'OverheadSlam', rating: 'down', scores: { arcs: 4.5, anticipation: 8, timing: 7, 'squash-stretch': 6.5, readability: 8, 'weight-impact': 5 } }
]

function view(): PrincipleView {
  return {
    profile: feedback.length ? learnProfile(feedback, Date.now()) : emptyProfile(Date.now()),
    catalogue: ALL_PRINCIPLES.map((p) => ({ id: p.id, domain: p.domain, name: p.name, rule: p.rule, measured: !!p.measure })),
    recent: feedback.slice(-8).reverse()
  }
}

export function mockPrincipleWeights(): Record<string, number> {
  return feedback.length ? learnProfile(feedback, Date.now()).weights : {}
}

// Called by the lab mocks when something is rated (null clears that entry's line).
export function recordPrincipleRating(lab: PrincipleLab, entryId: string, name: string, rating: 'up' | 'down' | null, scores: { id: string; score: number }[] | undefined, notes?: string): void {
  const i = feedback.findIndex((f) => f.lab === lab && f.entryId === entryId)
  if (i >= 0) feedback.splice(i, 1)
  if (rating && scores?.length) feedback.push({ at: Date.now(), lab, entryId, name, rating, scores: Object.fromEntries(scores.map((s) => [s.id, s.score])), ...(notes ? { notes } : {}) })
  emitRef?.('principles:changed', { at: Date.now() })
}

export function principlesMock(emit: Emit): PrincipleApi {
  emitRef = emit
  return {
    async principlesView() {
      return view()
    },
    async principlesReset() {
      feedback.splice(0, feedback.length)
      emit('principles:changed', { at: Date.now() })
      return view()
    }
  }
}
