// Block parser for the chat markdown renderer (Markdown.tsx): paragraphs, headings, fenced code,
// nested ordered / unordered lists, blockquotes, horizontal rules and GFM tables. Pure, no React.

export type ListItem = { text: string; children: Block[] }

export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'ul' | 'ol'; items: ListItem[]; start: number }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' }
  | { kind: 'table'; head: string[]; align: ('left' | 'center' | 'right' | null)[]; rows: string[][] }

const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const FENCE = /^\s*```\s*([\w+-]*)/
const HEADING = /^(#{1,6})\s+(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

const indentOf = (s: string) => s.replace(/\t/g, '    ').length

function cells(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

function isTableStart(lines: string[], i: number): boolean {
  return lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-') && lines[i + 1].includes('|')
}

function startsBlock(lines: string[], i: number): boolean {
  const l = lines[i]
  return FENCE.test(l) || HEADING.test(l) || ITEM.test(l) || /^>\s?/.test(l) || HR.test(l) || isTableStart(lines, i)
}

function parseList(lines: string[], i: number): { block: Block; next: number } {
  const first = ITEM.exec(lines[i])!
  const base = indentOf(first[1])
  const ordered = /\d/.test(first[2])
  const items: ListItem[] = []
  while (i < lines.length) {
    const l = lines[i]
    const m = ITEM.exec(l)
    if (m) {
      const ind = indentOf(m[1])
      if (ind <= base + 1 && ind >= base - 1) {
        if (/\d/.test(m[2]) !== ordered) break
        items.push({ text: m[3], children: [] })
        i++
        continue
      }
      if (ind > base && items.length) {
        const sub = parseList(lines, i)
        items[items.length - 1].children.push(sub.block)
        i = sub.next
        continue
      }
      break
    }
    if (!l.trim()) {
      // A blank line inside a list: keep going when the list (or a nested one) continues.
      let j = i + 1
      while (j < lines.length && !lines[j].trim()) j++
      const n = j < lines.length ? ITEM.exec(lines[j]) : null
      if (n && indentOf(n[1]) >= base && (indentOf(n[1]) > base + 1 || /\d/.test(n[2]) === ordered)) {
        i = j
        continue
      }
      break
    }
    if (items.length && (indentOf(/^\s*/.exec(l)![0]) > base || !startsBlock(lines, i))) {
      // Continuation of the last item (indented, or a lazy line).
      const last = items[items.length - 1]
      if (last.children.length) break
      last.text += '\n' + l.trim()
      i++
      continue
    }
    break
  }
  return { block: { kind: ordered ? 'ol' : 'ul', items, start: ordered ? parseInt(first[2], 10) || 1 : 1 }, next: i }
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = FENCE.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++])
      i++ // closing fence (or EOF while streaming)
      blocks.push({ kind: 'code', lang: fence[1] || '', text: body.join('\n') })
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const h = HEADING.exec(line)
    if (h) {
      blocks.push({ kind: 'h', level: h[1].length, text: h[2].replace(/\s+#+\s*$/, '') })
      i++
      continue
    }
    if (HR.test(line)) {
      blocks.push({ kind: 'hr' })
      i++
      continue
    }
    if (ITEM.test(line)) {
      const { block, next } = parseList(lines, i)
      blocks.push(block)
      i = next
      continue
    }
    if (isTableStart(lines, i)) {
      const head = cells(line)
      const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : null))
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]))
      blocks.push({ kind: 'table', head, align, rows })
      continue
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''))
      blocks.push({ kind: 'quote', text: body.join(' ') })
      continue
    }
    const body: string[] = []
    while (i < lines.length && lines[i].trim() && (!body.length || !startsBlock(lines, i))) body.push(lines[i++])
    blocks.push({ kind: 'p', text: body.join('\n') })
  }
  return blocks
}
