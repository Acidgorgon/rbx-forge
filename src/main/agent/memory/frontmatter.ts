// Minimal frontmatter for memory and SKILL.md files: a leading `---` block of `key: value` lines
// (strings, numbers, booleans). Values that need it are JSON-quoted, so a description with a colon
// or a leading quote round-trips exactly. No YAML dependency: the files are ours.

export type FrontValue = string | number | boolean

export function parseFrontmatter(text: string): { data: Record<string, FrontValue>; body: string } {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src)
  if (!m) return { data: {}, body: src.trim() }
  const data: Record<string, FrontValue> = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    data[kv[1]] = parseValue(kv[2].trim())
  }
  return { data, body: src.slice(m[0].length).trim() }
}

function parseValue(raw: string): FrontValue {
  if (raw.startsWith('"')) {
    try {
      return String(JSON.parse(raw))
    } catch {
      return raw.slice(1, raw.endsWith('"') ? -1 : undefined)
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) return raw.slice(1, -1).replace(/''/g, "'")
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  return raw
}

function formatValue(v: FrontValue): string {
  if (typeof v !== 'string') return String(v)
  // Plain when unambiguous; JSON-quoted otherwise (colons, quotes, leading/trailing space, '#').
  if (/^[\w./@()\- ,]+$/.test(v) && v === v.trim() && !/^(true|false|-?\d+(\.\d+)?)$/.test(v) && !v.startsWith('-')) return v
  return JSON.stringify(v)
}

export function formatFrontmatter(data: Record<string, FrontValue | undefined>, body: string): string {
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${formatValue(v as FrontValue)}`)
  return `---\n${lines.join('\n')}\n---\n\n${body.trim()}\n`
}
