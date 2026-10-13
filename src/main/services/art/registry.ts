// src/shared/Assets/Images.luau: a typed table of uploaded image ids, `Name = "rbxassetid://..."`.
// Rewritten whole on every change with keys sorted, so writes are idempotent and diffs stay small.
// Entries a person added by hand (any `Name = "rbxassetid://123"` line) are kept.

export const REGISTRY_PATH = 'src/shared/Assets/Images.luau'

export interface RegistryEntry {
  name: string
  uri: string
}

const ENTRY = /^\s*\[?"?([A-Za-z_][A-Za-z0-9_]*)"?\]?\s*=\s*"(rbxassetid:\/\/\d+)"\s*,?/

export function parseRegistry(text: string): RegistryEntry[] {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = ENTRY.exec(line)
    if (m) out.set(m[1], m[2])
  }
  return [...out].map(([name, uri]) => ({ name, uri }))
}

// PascalCase Luau identifier from a slug or display name: "gold coin-icon 2" -> GoldCoinIcon2.
export function registryName(raw: string): string {
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  let name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('')
  if (!name) name = 'Image'
  if (/^\d/.test(name)) name = `Image${name}`
  return name.slice(0, 60)
}

// The project's AGENTS.md can ask for no comments in game scripts.
export function forbidsComments(agentsMd: string | null | undefined): boolean {
  if (!agentsMd) return false
  return /\bno\s+comments\b|\bdo(?:n't| not)\s+(?:add|write|use)\s+(?:any\s+)?comments\b|\bwithout\s+comments\b|\bcomments?\s+(?:are\s+)?(?:not\s+allowed|forbidden|banned)\b/i.test(agentsMd)
}

const sortEntries = (entries: RegistryEntry[]) => [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

export function renderRegistry(entries: RegistryEntry[], options: { comments?: boolean; indent?: string } = {}): string {
  const indent = options.indent ?? '\t'
  const sorted = sortEntries(entries)
  const lines: string[] = ['--!strict']
  if (options.comments) lines.push('-- Uploaded image ids, written by RBX Forge (Art page). Keys stay sorted.')
  lines.push('')
  if (sorted.length) {
    lines.push('export type Images = {')
    for (const e of sorted) lines.push(`${indent}${e.name}: string,`)
    lines.push('}')
  } else lines.push('export type Images = { [string]: string }')
  lines.push('')
  lines.push('local Images: Images = {')
  for (const e of sorted) lines.push(`${indent}${e.name} = "${e.uri}",`)
  lines.push('}')
  lines.push('')
  lines.push('return table.freeze(Images)')
  return lines.join('\n') + '\n'
}

// Adds or replaces one entry. Returns the new text and whether anything changed.
export function upsertRegistry(existing: string | null, entry: RegistryEntry, options: { comments?: boolean } = {}): { text: string; changed: boolean } {
  const entries = existing ? parseRegistry(existing) : []
  const i = entries.findIndex((e) => e.name === entry.name)
  if (i >= 0) entries[i] = entry
  else entries.push(entry)
  const indent = existing && /^ {2,}\w/m.test(existing) && !/^\t\w/m.test(existing) ? (/^( +)\w/m.exec(existing)?.[1] ?? '\t') : '\t'
  const text = renderRegistry(entries, { ...options, indent })
  return { text, changed: text !== existing }
}
