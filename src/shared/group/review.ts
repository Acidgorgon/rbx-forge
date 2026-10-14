// Cross-check reviews: a guest from a different provider reviews the host's multi-file edit.
// Prompt, reply parsing and reviewer choice. Pure.

import type { ModelChoice, ProviderId } from '../types.ts'
import type { ReviewData, ReviewFinding } from './types.ts'

export const REVIEW_DIFF_CHARS = 16_000

export function reviewPrompt(host: string, request: string, files: string[], diff: string): string {
  const d = diff.length > REVIEW_DIFF_CHARS ? diff.slice(0, REVIEW_DIFF_CHARS) + '\n… (diff clipped)' : diff
  return `${host} (the host) just edited ${files.length} files for the user's request:\n${request}\n\nFiles: ${files.join(', ')}\n\nDiff:\n\`\`\`diff\n${d}\n\`\`\`\n\nReview it as a second opinion. Use the read-only tools if a finding depends on code outside the diff. Report only real problems: bugs, broken references, server/client trust mistakes, missing cleanup, Luau type errors. One finding per line, exactly:\nBLOCKING: path:line: what is wrong and the fix\nNOTE: path:line: a smaller suggestion\nThen one final line: "VERDICT: approve" or "VERDICT: changes". No other text. If nothing is wrong, just write "VERDICT: approve".`
}

const LINE = /^\s*[-*]?\s*\**\s*(BLOCKING|BLOCKER|MUST[- ]FIX|NOTE|NIT|SUGGESTION)\s*\**\s*[:\-–—]\s*(.+)$/i

function finding(severity: ReviewFinding['severity'], rest: string): ReviewFinding {
  // "src/x.luau:12: text" / "src/x.luau: text" / "text"
  const m = /^`?([\w./-]+\.[a-z]{1,5})`?(?::(\d+))?\s*[:\-–—]\s*(.+)$/i.exec(rest.trim())
  if (m) return { severity, file: m[1], ...(m[2] ? { line: Number(m[2]) } : {}), text: m[3].trim() }
  return { severity, text: rest.trim() }
}

export function parseReview(text: string): Pick<ReviewData, 'verdict' | 'findings'> {
  const findings: ReviewFinding[] = []
  let verdict: ReviewData['verdict'] | null = null
  for (const l of String(text ?? '').split('\n')) {
    const v = /^\s*\**\s*VERDICT\s*\**\s*[:\-]\s*\**\s*(approve|approved|lgtm|changes|request changes|changes requested|reject)/i.exec(l)
    if (v) {
      verdict = /^(approve|approved|lgtm)$/i.test(v[1]) ? 'approve' : 'changes'
      continue
    }
    const m = LINE.exec(l)
    if (!m) continue
    const sev = /^(BLOCKING|BLOCKER|MUST[- ]FIX)$/i.test(m[1]) ? 'blocking' : 'note'
    findings.push(finding(sev, m[2]))
  }
  const blocking = findings.some((f) => f.severity === 'blocking')
  return { verdict: blocking ? 'changes' : (verdict ?? 'approve'), findings: findings.slice(0, 20) }
}

export function blockingFindings(r: Pick<ReviewData, 'findings'>): ReviewFinding[] {
  return r.findings.filter((f) => f.severity === 'blocking')
}

export function fixPrompt(reviewer: string, findings: ReviewFinding[]): string {
  return `[Cross-check] ${reviewer} reviewed your edit and found blocking problems. Address each one (fix it, or explain briefly why it is not a problem), then summarise what you changed:\n${findings.map((f, i) => `${i + 1}. ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''}: ` : ''}${f.text}`).join('\n')}`
}

// Reviewer: the configured "provider/model" when it is ready and not the host's provider;
// else the first guest from another provider; else the first ready model from another provider.
export function pickReviewer<T extends ModelChoice>(host: ModelChoice, setting: string, guests: T[], ready: ModelChoice[]): ModelChoice | null {
  const other = (c: ModelChoice) => c.provider !== host.provider
  const want = setting.trim()
  if (want) {
    const i = want.indexOf('/')
    const choice = i > 0 ? { provider: want.slice(0, i) as ProviderId, model: want.slice(i + 1) } : null
    if (choice && other(choice) && ready.some((r) => r.provider === choice.provider && r.model === choice.model)) return choice
  }
  const g = guests.find(other)
  if (g) return { provider: g.provider, model: g.model }
  return ready.find(other) ?? null
}

// Files a turn edited, from its tool messages (gentree write tools and the SDK's Edit/Write).
const EDIT_TOOLS = /^(?:mcp__.+?__)?(write_script|edit_script|new_feature|Edit|Write|MultiEdit)$/
export function editedFiles(tools: { name: string; input: string }[]): string[] {
  const out: string[] = []
  for (const t of tools) {
    if (!EDIT_TOOLS.test(t.name)) continue
    const m = /(?:^|\s)(?:path|file_path|file)=(\S+)/.exec(t.input)
    const p = m?.[1]?.replace(/^["'`]|["'`,]$/g, '')
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}
