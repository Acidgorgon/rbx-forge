// Lossless parser and atomic boolean toggle editor for LibsConfig.luau.
// Preserves all comments, blank lines, indentation, trailing commas, and unrelated entries byte-for-byte.

import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { HarborLibId, LibsConfigEntry } from '../../../shared/harborTypes.ts'
import { renameRetry } from '../fs/renameRetry.ts'

const COMMON_LIBS_CONFIG_PATHS = [
  'src/shared/Modules/LibsConfig.luau',
  'src/shared/LibsConfig.luau',
  'src/shared/Config/LibsConfig.luau',
  'src/LibsConfig.luau',
  'src/shared/Modules/LibsConfig.lua',
  'src/shared/LibsConfig.lua'
]

export function mapKeyToHarborLib(key: string): HarborLibId | undefined {
  const k = key.trim().toLowerCase()
  const norm = k.replace(/^(use_|use|enable_|enable|is_)/, '').replace(/[^a-z]/g, '')
  if (norm === 'current' || k.includes('current')) return 'current'
  if (norm === 'ripple' || k.includes('ripple')) return 'ripple'
  if (norm === 'anchor' || k.includes('anchor')) return 'anchor'
  if (norm === 'tide' || k.includes('tide')) return 'tide'
  if (norm === 'lighthouse' || k.includes('lighthouse')) return 'lighthouse'
  return undefined
}

export function findLibsConfigFile(root: string): string | null {
  for (const rel of COMMON_LIBS_CONFIG_PATHS) {
    if (existsSync(join(root, ...rel.split('/')))) return rel
  }
  const srcRoot = join(root, 'src')
  if (!existsSync(srcRoot)) return null

  const queue: { abs: string; rel: string; depth: number }[] = [{ abs: srcRoot, rel: 'src', depth: 0 }]
  while (queue.length) {
    const cur = queue.shift()!
    let entries
    try {
      entries = readdirSync(cur.abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === 'Packages' || e.name === '.forge') continue
      const nextRel = `${cur.rel}/${e.name}`
      if (e.isFile() && /^LibsConfig\.luau?$/i.test(e.name)) return nextRel
      if (e.isDirectory() && cur.depth < 4) {
        queue.push({ abs: join(cur.abs, e.name), rel: nextRel, depth: cur.depth + 1 })
      }
    }
  }
  return null
}

// Match an assignment line in Luau table or field syntax:
//   UseCurrent = true, -- optional comment
//   ["Ripple"] = false
const BOOL_ASSIGN_RE = /^([ \t]*(?:\[\s*(?:"([^"]+)"|'([^']+)')\s*\]|([A-Za-z_][A-Za-z0-9_]*))[ \t]*=[ \t]*)(true|false)([ \t]*[,;]?[ \t]*(?:--.*)?)$/

function splitLinesKeepingEndings(text: string): { content: string; eol: string }[] {
  const out: { content: string; eol: string }[] = []
  let i = 0
  while (i < text.length) {
    const lf = text.indexOf('\n', i)
    if (lf === -1) {
      out.push({ content: text.slice(i), eol: '' })
      break
    }
    if (lf > i && text[lf - 1] === '\r') {
      out.push({ content: text.slice(i, lf - 1), eol: '\r\n' })
    } else {
      out.push({ content: text.slice(i, lf), eol: '\n' })
    }
    i = lf + 1
  }
  if (text.length === 0) out.push({ content: '', eol: '' })
  return out
}

export function parseLibsConfig(text: string): LibsConfigEntry[] {
  const entries: LibsConfigEntry[] = []
  const lines = splitLinesKeepingEndings(text)
  let inBlockComment = false

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].content
    const trimmed = line.trim()

    if (inBlockComment) {
      const end = line.indexOf(']]')
      if (end >= 0) inBlockComment = false
      continue
    }
    if (trimmed.startsWith('--[[')) {
      if (!trimmed.includes(']]')) inBlockComment = true
      continue
    }
    if (!trimmed || trimmed.startsWith('--')) continue

    const m = BOOL_ASSIGN_RE.exec(line)
    if (!m) continue
    const key = m[2] ?? m[3] ?? m[4]
    if (!key) continue
    const valStr = m[5]
    entries.push({
      key,
      value: valStr === 'true',
      line: idx + 1,
      ...(mapKeyToHarborLib(key) ? { libId: mapKeyToHarborLib(key) } : {})
    })
  }
  return entries
}

export function setLibsConfigToggle(text: string, key: string, value: boolean): string {
  const lines = splitLinesKeepingEndings(text)
  let inBlockComment = false
  let replaced = false
  const targetLower = key.trim().toLowerCase()

  // Prefer exact case match; fall back to case-insensitive match if no exact match exists.
  let exactIdx = -1
  let ciIdx = -1

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].content
    const trimmed = line.trim()
    if (inBlockComment) {
      if (line.includes(']]')) inBlockComment = false
      continue
    }
    if (trimmed.startsWith('--[[')) {
      if (!trimmed.includes(']]')) inBlockComment = true
      continue
    }
    if (!trimmed || trimmed.startsWith('--')) continue

    const m = BOOL_ASSIGN_RE.exec(line)
    if (!m) continue
    const foundKey = m[2] ?? m[3] ?? m[4]
    if (!foundKey) continue
    if (foundKey === key.trim()) {
      exactIdx = idx
      break
    }
    if (ciIdx === -1 && foundKey.toLowerCase() === targetLower) {
      ciIdx = idx
    }
  }

  const hitIdx = exactIdx !== -1 ? exactIdx : ciIdx
  if (hitIdx === -1) {
    throw new Error(`Key "${key}" boolean toggle not found in LibsConfig`)
  }

  const m = BOOL_ASSIGN_RE.exec(lines[hitIdx].content)!
  lines[hitIdx].content = `${m[1]}${value ? 'true' : 'false'}${m[6]}`
  replaced = true
  if (!replaced) throw new Error(`Failed to update "${key}"`)

  return lines.map((l) => l.content + l.eol).join('')
}

export async function writeLibsConfigToggle(filePath: string, key: string, value: boolean): Promise<string> {
  const raw = await readFile(filePath, 'utf8')
  const updated = setLibsConfigToggle(raw, key, value)
  if (updated === raw) return updated
  const tmp = join(dirname(filePath), `.${basename(filePath)}.forge-tmp-${randomBytes(4).toString('hex')}`)
  await writeFile(tmp, updated, 'utf8')
  await renameRetry(tmp, filePath)
  return updated
}
