// Delete guard shared by Forge Sync (engine.ts) and the git auto-sync (gitSync.ts): a script this
// large, or one another script requires, is never removed or committed as deleted on its own.
// No electron imports.

import { parseFileName } from './mapping.ts'
import { normalise } from './merge.ts'

// More lines than this: a script Forge never removes without asking.
export const GUARD_LINES = 300

export function lineCount(text: string): number {
  const body = normalise(text)
  return body === '' ? 0 : body.split('\n').length
}

// The name other scripts require a script by: its file stem, or its folder's name for an init script.
export function moduleName(rel: string): string | null {
  const parts = rel.split('/')
  const info = parseFileName(parts[parts.length - 1])
  if (!info || info.kind !== 'script') return null
  return info.stem ?? (parts.length > 1 ? parts[parts.length - 2] : null)
}

// Names on the require lines of a script ("require(script.Parent.CharacterService)" -> script,
// Parent, CharacterService ...).
export function requiredNames(text: string): Set<string> {
  const out = new Set<string>()
  if (!text.includes('require')) return out
  for (const line of text.split('\n')) {
    if (!/\brequire\s*\(/.test(line)) continue
    for (const m of line.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) out.add(m[0])
  }
  return out
}

export interface GuardInput {
  file: string
  text: string
  // Other scripts that stay, by path; read lazily (only for a small script).
  others: string[]
  read: (rel: string) => Promise<string | null>
}

// Why removing `file` needs the user's word ("1587 lines", "required by src/x.luau"), or null. A
// require is only trusted when no other staying script has the same name (a moved copy, Legacy twins).
export async function guardReason(input: GuardInput): Promise<string | null> {
  const lines = lineCount(input.text)
  if (lines > GUARD_LINES) return `${lines} lines`
  const name = moduleName(input.file)
  if (!name) return null
  const others = input.others.filter((f) => f !== input.file)
  if (others.some((f) => moduleName(f) === name)) return null
  for (const f of others) {
    if (!moduleName(f)) continue
    const text = await input.read(f)
    if (text && requiredNames(text).has(name)) return `required by ${f}`
  }
  return null
}
