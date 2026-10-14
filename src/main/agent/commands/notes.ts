// /init: project notes in .forge/AGENTS.md (Forge's CLAUDE.md). The project's own AGENTS.md at the
// root is never written. When .forge/AGENTS.md already exists the new notes are merged in: every
// existing line stays as it is, new sections are appended and new bullets are added to sections
// that already exist. Nothing is ever overwritten or removed.

export const NOTES_FILE = '.forge/AGENTS.md'

export const INIT_PROMPT = `Write project notes for this GenTree (Roblox, Rojo, Luau) project, like a CLAUDE.md: what a new coding assistant needs to know to work here.
Investigate with the read-only tools first (project_map, blink_events, search_code, read_script on the key modules).
Cover, as short markdown sections with bullets:
## Overview  (what the game is, the main features)
## Layout  (where things live; features, services, controllers)
## Conventions  (naming, module patterns, networking, data saving)
## Commands  (dev, tests, lint, sync)
## Gotchas  (generated files, things not to edit)
Do not repeat rules that are already in the project's AGENTS.md (they are in your instructions); add what is missing.
Reply with ONLY the notes, starting with "# Project notes".`

interface Section {
  heading: string
  lines: string[]
}

function sections(text: string): { head: string[]; sections: Section[] } {
  const head: string[] = []
  const out: Section[] = []
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) {
      out.push({ heading: h[1], lines: [] })
      continue
    }
    if (out.length) out[out.length - 1].lines.push(line)
    else head.push(line)
  }
  return { head, sections: out }
}

const norm = (s: string) => s.toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim()
const key = (heading: string) => norm(heading).replace(/\(.*?\)/g, '').trim()

// The answer of the init turn: the notes (a fenced block is unwrapped).
export function extractNotes(answer: string): string {
  const t = String(answer ?? '').trim()
  const fence = /```(?:markdown|md)?\n([\s\S]*?)\n```/.exec(t)
  const body = fence ? fence[1] : t
  const start = body.search(/^#\s/m)
  return (start > 0 ? body.slice(start) : body).trim()
}

// Merges generated notes into existing ones without removing or rewriting anything.
export function mergeNotes(existing: string | null, generated: string, stamp = new Date().toISOString().slice(0, 10)): { text: string; added: number } {
  const gen = generated.trim()
  if (!existing?.trim()) return { text: `${gen}\n`, added: gen.split('\n').filter((l) => /^\s*[-*]\s/.test(l)).length || 1 }
  const a = sections(existing)
  const b = sections(gen)
  const lines = existing.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  let added = 0
  const appended: string[] = []
  for (const s of b.sections) {
    const match = a.sections.find((x) => key(x.heading) === key(s.heading))
    const items = s.lines.filter((l) => l.trim())
    if (!match) {
      appended.push('', `## ${s.heading}`, ...s.lines.filter((l, i, arr) => l.trim() || (i > 0 && i < arr.length - 1)))
      added += items.length || 1
      continue
    }
    const have = new Set(match.lines.map(norm))
    const fresh = items.filter((l) => /^\s*[-*]\s/.test(l) && !have.has(norm(l)))
    if (!fresh.length) continue
    // Insert after the last non-empty line of that section in the existing file.
    const startIdx = lines.findIndex((l) => /^##\s+/.test(l) && key(l.replace(/^##\s+/, '')) === key(match.heading))
    let end = startIdx + 1
    while (end < lines.length && !/^##\s+/.test(lines[end])) end++
    let insertAt = end
    while (insertAt > startIdx + 1 && !lines[insertAt - 1].trim()) insertAt--
    lines.splice(insertAt, 0, ...fresh)
    added += fresh.length
  }
  if (appended.length) lines.push('', `<!-- added by /init ${stamp} -->`, ...appended.slice(1))
  return { text: lines.join('\n') + '\n', added }
}
