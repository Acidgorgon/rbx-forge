// Telling Studio places with the same name apart (every unpublished place is "Place1"): numbered
// labels for colliding names and a one-line fingerprint of what is in each place (plugin v11).
// Pure, no imports beyond types (tested in test/placeLabels.test.ts).

import type { PlaceFingerprint } from './types.ts'

// One label per item, in order: the name itself when it is unique, else "<name> #<n>" numbered by
// position among the items with that name (callers keep the order stable, e.g. first seen).
export function collisionLabels(names: string[]): string[] {
  const total = new Map<string, number>()
  for (const n of names) total.set(n, (total.get(n) ?? 0) + 1)
  const seen = new Map<string, number>()
  return names.map((n) => {
    if ((total.get(n) ?? 0) < 2) return n
    const i = (seen.get(n) ?? 0) + 1
    seen.set(n, i)
    return `${n} #${i}`
  })
}

// "Workspace: Lobby, Map +3 · 42 scripts", or '' when there is nothing to say.
export function fingerprintText(fp: PlaceFingerprint | undefined, maxNames = 3): string {
  if (!fp) return ''
  const parts: string[] = []
  const names = fp.workspace.slice(0, maxNames)
  const more = Math.max(0, fp.workspaceCount - names.length)
  if (names.length) parts.push(`Workspace: ${names.join(', ')}${more ? ` +${more}` : ''}`)
  else parts.push(fp.workspaceCount ? `Workspace: ${fp.workspaceCount} items` : 'empty Workspace')
  parts.push(`${fp.scripts} script${fp.scripts === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

// The text the plugin shows for Identify: one short line, no control characters.
export function identifyText(label: string): string {
  // eslint-disable-next-line no-control-regex
  return label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80)
}
