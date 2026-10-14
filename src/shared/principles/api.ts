// IPC types for principle priorities (main/services/principles): the learned per-principle weights
// the "Your priorities" view shows. HarnessApi / HarnessEvents extend these.

import type { PrincipleView } from './types.ts'

export type * from './types.ts'

export interface PrincipleApi {
  // Catalogue, learned weights and the latest ratings they came from.
  principlesView(): Promise<PrincipleView>
  // Forget every rating (weights back to neutral).
  principlesReset(): Promise<PrincipleView>
}

export interface PrincipleEvents {
  'principles:changed': { at: number }
}
