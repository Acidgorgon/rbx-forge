import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { LIMITS, MemoryError, MemoryStore } from '../src/main/agent/memory/store.ts'
import { MemoryService } from '../src/main/agent/memory/service.ts'
import { commitMarkdownImport, previewMarkdownImport } from '../src/main/agent/memory/claudeImport.ts'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function temp(prefix = 'forge-md-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

function makeMemoryService(projectRoot: string): MemoryService {
  const userDir = temp('forge-md-user-')
  const settingsMap = new Map<string, unknown>()
  return new MemoryService({
    userDir,
    projectRoot: () => projectRoot,
    getSetting: <T>(k: string, fb: T) => (settingsMap.has(k) ? (settingsMap.get(k) as T) : fb),
    setSetting: (k, v) => settingsMap.set(k, v)
  })
}

test('unlimited markdown import preserves >25KB documents intact while default store save keeps normal limits', async () => {
  const projectRoot = temp('forge-md-proj-')
  const store = new MemoryStore({ scope: 'project', dir: join(projectRoot, '.forge', 'memory') })

  const hugeBody = Array.from({ length: 450 }, (_, i) => `- Pipeline rule #${i + 1}: keep Harbor Current schemas synchronized with Studio.`).join('\n')
  assert.ok(hugeBody.length > 25_000)
  assert.ok(hugeBody.length > LIMITS.memoryBody)

  await assert.rejects(
    store.save({ scope: 'project', kind: 'memory', name: 'too-big', description: 'Too big without allowLarge', body: hugeBody }),
    MemoryError
  )

  const svc = makeMemoryService(projectRoot)
  const doc = `---\ndescription: Complete studio pipeline and asset rules\n---\n# Project Rules\n\n${hugeBody}\n`
  const items = previewMarkdownImport({ content: doc, fileName: 'CLAUDE.md', splitByHeadings: false })
  assert.equal(items.length, 1)
  assert.equal(items[0].description, 'Complete studio pipeline and asset rules')
  assert.ok(items[0].chars > 25_000)

  const res = await commitMarkdownImport(svc, 'project', items)
  assert.equal(res.imported.length, 1)
  const listed = await svc.list()
  assert.equal(listed.project.length, 1)
  assert.equal(listed.project[0].body.length, items[0].body.length)
})

test('previewMarkdownImport splits on ## headings and ignores ## inside fenced code blocks', async () => {
  const projectRoot = temp('forge-md-split-')
  const svc = makeMemoryService(projectRoot)

  const md = [
    '# Harbor & Vanguards Handbook',
    '',
    'Intro overview paragraph before first H2.',
    '',
    '## Networking Conventions',
    'Use `Current` and `tools/current-schema.luau` with `From: Both`.',
    '```luau',
    '-- ## Not a heading inside fenced code block',
    'local x = 1',
    '```',
    '',
    '## Offline Visual Verification',
    'Always run `ror`, `rur`, `ree`, and `lune` before touching live Studio.',
    '',
    '## Offline Visual Verification',
    'Duplicate heading name should receive unique slug.'
  ].join('\n')

  const items = previewMarkdownImport({
    content: md,
    fileName: 'MEMORY.md',
    splitByHeadings: true,
    defaultKind: 'memory',
    defaultType: 'reference'
  })

  assert.equal(items.length, 4)
  assert.equal(items[0].name, 'harbor-vanguards-handbook-overview')
  assert.equal(items[1].name, 'networking-conventions')
  assert.match(items[1].body, /Not a heading inside fenced code block/)
  assert.equal(items[2].name, 'offline-visual-verification')
  assert.equal(items[3].name, 'offline-visual-verification-2')

  const firstCommit = await commitMarkdownImport(svc, 'user', items)
  assert.equal(firstCommit.imported.length, 4)
  assert.equal(firstCommit.updated.length, 0)

  const secondCommit = await commitMarkdownImport(svc, 'user', items)
  assert.equal(secondCommit.updated.length, 4)
  svc.dispose()
})
