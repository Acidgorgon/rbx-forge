// The UI Motion principle catalogue and lookups (catalog.ts).
import type { Principle, PrincipleDomain } from './types.ts'
import { UI_PRINCIPLES } from './uiCatalog.ts'

export { UI_PRINCIPLES }

export const ALL_PRINCIPLES: Principle[] = [...UI_PRINCIPLES]
const BY_ID = new Map(ALL_PRINCIPLES.map((p) => [p.id, p]))

export function principle(id: string): Principle | undefined {
  return BY_ID.get(id)
}

export function principlesFor(domain: PrincipleDomain): Principle[] {
  return domain === 'ui' ? UI_PRINCIPLES : []
}

export function principleName(id: string): string {
  return BY_ID.get(id)?.name ?? id
}

// Short label for scorecards (terminal style).
export function principleLabel(id: string): string {
  return id.replace(/^(?:fx|th|ui)-/, '')
}

// Ids the code checks can measure.
export function measurable(): string[] {
  return ALL_PRINCIPLES.filter((p) => p.measure).map((p) => p.id)
}
