// Unlimited-size Markdown / rules / pipeline document importer for Memory & Skills.
// Preserves full body content (allowLarge: true) and optionally splits on level-2 headings (## ),
// ignoring headings inside fenced code blocks. Zero brand-specific text in outputs or UI labels.

import { basename } from 'node:path'
import { parseFrontmatter } from './frontmatter.ts'
import { LIMITS, slugify } from './store.ts'
import type { MemoryService } from './service.ts'
import type { MemoryKind, MemoryScope, MemoryType } from './types.ts'

export interface MarkdownImportRequest {
  content: string
  fileName?: string
  splitByHeadings?: boolean
  defaultKind?: MemoryKind
  defaultType?: MemoryType
}

export interface MarkdownImportItem {
  kind: MemoryKind
  type?: MemoryType
  name: string
  description: string
  body: string
  chars: number
}

export interface MarkdownImportResult {
  imported: string[]
  updated: string[]
  skipped: string[]
}

function summarizeDescription(text: string, fallback: string): string {
  const lines = text.split('\n')
  let inFence = false
  for (const raw of lines) {
    const t = raw.trim()
    if (/^(```|~~~)/.test(t)) {
      inFence = !inFence
      continue
    }
    if (inFence || !t) continue
    const clean = t
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+\.\s+/, '')
      .replace(/[`*_]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (clean) return clean.slice(0, LIMITS.description)
  }
  return fallback.replace(/\s+/g, ' ').trim().slice(0, LIMITS.description) || 'Imported markdown memory'
}

function uniqueSlug(base: string, seen: Set<string>): string {
  let clean = slugify(base) || 'imported-note'
  if (!seen.has(clean)) {
    seen.add(clean)
    return clean
  }
  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`
    const candidate = `${clean.slice(0, LIMITS.name - suffix.length).replace(/-+$/, '')}${suffix}`
    if (!seen.has(candidate)) {
      seen.add(candidate)
      return candidate
    }
  }
  const fallback = `${clean.slice(0, 48)}-${seen.size + 1}`
  seen.add(fallback)
  return fallback
}

function deriveBaseTitle(fileName?: string, h1?: string, frontmatterName?: string): string {
  if (frontmatterName?.trim()) return frontmatterName.trim()
  if (h1?.trim()) return h1.trim()
  if (fileName?.trim()) {
    const stem = basename(fileName.trim()).replace(/\.[^.]+$/, '')
    if (/^claude$/i.test(stem)) return 'project-rules'
    if (stem) return stem
  }
  return 'imported-rules'
}

function splitSectionsByH2(body: string): { title: string | null; text: string }[] {
  const lines = body.split('\n')
  const sections: { title: string | null; lines: string[] }[] = [{ title: null, lines: [] }]
  let inFence = false
  let fenceChar = ''

  for (const line of lines) {
    const trimmed = line.trim()
    const fenceMatch = /^(```+|~~~+)/.exec(trimmed)
    if (fenceMatch) {
      const ch = fenceMatch[1][0]
      if (!inFence) {
        inFence = true
        fenceChar = ch
      } else if (fenceChar === ch) {
        inFence = false
        fenceChar = ''
      }
      sections[sections.length - 1].lines.push(line)
      continue
    }

    if (!inFence) {
      const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line)
      if (h2) {
        sections.push({ title: h2[1].trim(), lines: [] })
        continue
      }
    }
    sections[sections.length - 1].lines.push(line)
  }

  return sections
    .map((s) => ({ title: s.title, text: s.lines.join('\n').trim() }))
    .filter((s) => s.text.length > 0)
}

export function previewMarkdownImport(req: MarkdownImportRequest): MarkdownImportItem[] {
  const raw = String(req.content ?? '').replace(/\r\n/g, '\n')
  if (!raw.trim()) return []

  const parsed = parseFrontmatter(raw)
  const fm = parsed.data
  const body = parsed.body.trim()
  if (!body) return []

  const kind: MemoryKind = req.defaultKind ?? (fm.kind === 'skill' ? 'skill' : 'memory')
  const fmType = fm.type === 'user' || fm.type === 'project' || fm.type === 'feedback' || fm.type === 'reference' ? fm.type : undefined
  const defaultType = kind === 'memory' ? (req.defaultType ?? fmType ?? 'project') : undefined

  const h1Match = /^#\s+(.+)$/m.exec(body)
  const baseTitle = deriveBaseTitle(req.fileName, h1Match?.[1], typeof fm.name === 'string' ? fm.name : undefined)
  const seen = new Set<string>()

  if (!req.splitByHeadings) {
    const desc =
      typeof fm.description === 'string' && fm.description.trim()
        ? fm.description.trim().slice(0, LIMITS.description)
        : summarizeDescription(body, baseTitle)
    return [
      {
        kind,
        ...(defaultType ? { type: defaultType } : {}),
        name: uniqueSlug(baseTitle, seen),
        description: desc,
        body,
        chars: body.length
      }
    ]
  }

  const sections = splitSectionsByH2(body)
  if (!sections.length) return []

  const items: MarkdownImportItem[] = []
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i]
    // Ignore intro block if it contains only the top # heading and nothing else
    if (sec.title === null && /^#\s+[^\n]+$/.test(sec.text)) continue
    const title = sec.title ?? `${baseTitle}-overview`
    const fullSectionBody = sec.title ? `## ${sec.title}\n\n${sec.text}` : sec.text
    items.push({
      kind,
      ...(defaultType ? { type: defaultType } : {}),
      name: uniqueSlug(title, seen),
      description: summarizeDescription(sec.text, title),
      body: fullSectionBody,
      chars: fullSectionBody.length
    })
  }
  return items
}

export async function commitMarkdownImport(
  service: MemoryService,
  scope: MemoryScope,
  items: MarkdownImportItem[]
): Promise<MarkdownImportResult> {
  const imported: string[] = []
  const updated: string[] = []
  const skipped: string[] = []

  for (const item of items) {
    const name = slugify(item.name)
    const body = item.body.trim()
    const description = item.description.replace(/\s+/g, ' ').trim()
    if (!name || !body || !description) {
      skipped.push(item.name || '(empty)')
      continue
    }
    const res = await service.importEntry(
      {
        scope,
        kind: item.kind,
        ...(item.kind === 'memory' && item.type ? { type: item.type } : {}),
        name,
        description,
        body
      },
      { dedupe: false, allowLarge: true }
    )
    if (res.action === 'updated') updated.push(res.entry.name)
    else imported.push(res.entry.name)
  }

  return { imported, updated, skipped }
}
