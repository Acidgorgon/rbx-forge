import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  GUIDE_END,
  GUIDE_START,
  HARNESS_GUIDE_CONFIG,
  buildFrameworkMarkdown,
  buildHarnessGuideMarkdown,
  inspectHarnessGuide,
  syncHarnessGuide,
  upsertManagedBlock
} from '../src/main/agent/harnessGuide.ts'
import { FRAMEWORK_PLAYBOOK, REFACTOR_SKILL } from '../src/main/agent/framework/content.ts'

const dirs: string[] = []

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function tempProject(prefix = 'forge-hg-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

test('upsertManagedBlock preserves surrounding notes, updates in place, and respects CRLF', () => {
  const fresh = upsertManagedBlock(null, `${GUIDE_START}\nhello\n${GUIDE_END}`)
  assert.equal(fresh, `${GUIDE_START}\nhello\n${GUIDE_END}\n`)

  const withUserNotes = upsertManagedBlock('# Team Notes\nKeep these.', `${GUIDE_START}\nv1\n${GUIDE_END}`)
  assert.equal(withUserNotes, `# Team Notes\nKeep these.\n\n${GUIDE_START}\nv1\n${GUIDE_END}\n`)

  const middle = `# Top\n\n${GUIDE_START}\nv1\n${GUIDE_END}\n\n# Footer\n`
  const updated = upsertManagedBlock(middle, `${GUIDE_START}\nv2\n${GUIDE_END}`)
  assert.equal(updated, `# Top\n\n${GUIDE_START}\nv2\n${GUIDE_END}\n\n# Footer\n`)
  assert.equal(upsertManagedBlock(updated, `${GUIDE_START}\nv2\n${GUIDE_END}`), updated)

  const crlfExisting = `# Notes\r\n\r\n${GUIDE_START}\r\nold\r\n${GUIDE_END}\r\n\r\nEnd\r\n`
  const crlfUpdated = upsertManagedBlock(crlfExisting, `${GUIDE_START}\nnew\n${GUIDE_END}`)
  assert.equal(crlfUpdated, `# Notes\r\n\r\n${GUIDE_START}\r\nnew\r\n${GUIDE_END}\r\n\r\nEnd\r\n`)
})

test('syncHarnessGuide writes all targets, keeps Antigravity YAML frontmatter once, and persists config', () => {
  const root = tempProject()
  writeFileSync(join(root, 'AGENTS.md'), '# Project Overview\n\nCustom project notes.\n', 'utf8')

  const first = syncHarnessGuide(root)
  assert.deepEqual(first.written.sort(), [
    '.agents/rules/rbx-forge.md',
    '.agents/skills/forge-refactor/SKILL.md',
    '.claude/skills/forge-refactor/SKILL.md',
    '.forge/FRAMEWORK.md',
    'AGENTS.md',
    'CLAUDE.md'
  ])
  assert.equal(existsSync(join(root, HARNESS_GUIDE_CONFIG)), true)

  const agentsText = readFileSync(join(root, 'AGENTS.md'), 'utf8')
  assert.match(agentsText, /^# Project Overview\n\nCustom project notes\./)
  assert.match(agentsText, /RBX Forge Direct Sync/)
  assert.match(agentsText, /125988560196910/)
  assert.match(agentsText, /Harbor Stack/)
  assert.match(agentsText, /No Comments/)

  const claudeText = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
  assert.match(claudeText, /Read and follow `AGENTS\.md` first/)
  assert.match(claudeText, /No Comments/)

  const agText = readFileSync(join(root, '.agents', 'rules', 'rbx-forge.md'), 'utf8')
  assert.equal(agText.startsWith('---\ntrigger: always_on\n---\n\n'), true)
  assert.equal(agText.match(/^---$/gm)?.length, 2)

  const second = syncHarnessGuide(root)
  assert.deepEqual(second.written, [])
  const agSecond = readFileSync(join(root, '.agents', 'rules', 'rbx-forge.md'), 'utf8')
  assert.equal(agSecond, agText)
  assert.equal(agSecond.match(/^---$/gm)?.length, 2)
})

test('syncHarnessGuide respects option toggles, customRules, and target selection', () => {
  const root = tempProject()
  const res = syncHarnessGuide(root, {
    targets: ['agents', 'claude'],
    noComments: false,
    enforceHarborAndPackages: false,
    enforceOfflineVanguards: false,
    frameworkPlaybook: false,
    customRules: 'Always validate remotes on server.'
  })

  assert.deepEqual(res.written.sort(), ['AGENTS.md', 'CLAUDE.md'])
  assert.equal(existsSync(join(root, '.forge', 'FRAMEWORK.md')), false)
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8').includes('FRAMEWORK.md'), false)
  assert.equal(existsSync(join(root, '.agents', 'rules', 'rbx-forge.md')), false)

  const agentsText = readFileSync(join(root, 'AGENTS.md'), 'utf8')
  assert.equal(agentsText.includes('No Comments'), false)
  assert.equal(agentsText.includes('Harbor Stack'), false)
  assert.equal(agentsText.includes('Offline UI & 3D Previews'), false)
  assert.equal(agentsText.includes('RBX Forge Direct Sync'), true)
  assert.equal(agentsText.includes('Always validate remotes on server.'), true)

  const claudeText = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
  assert.equal(claudeText.includes('No Comments'), false)
  assert.equal(claudeText.includes('Always validate remotes on server.'), true)

  const loaded = inspectHarnessGuide(root)
  assert.equal(loaded.options.noComments, false)
  assert.deepEqual(loaded.options.targets, ['agents', 'claude'])
  assert.equal(loaded.options.customRules, 'Always validate remotes on server.')
})

test('inspectHarnessGuide tracks missing, upToDate, and drifted states', () => {
  const none = inspectHarnessGuide(null)
  assert.equal(none.projectRoot, null)
  assert.equal(none.files.every((f) => !f.exists && !f.upToDate), true)

  const root = tempProject()
  const before = inspectHarnessGuide(root)
  assert.equal(before.files.every((f) => !f.exists && !f.hasManagedBlock && !f.upToDate), true)

  syncHarnessGuide(root)
  const synced = inspectHarnessGuide(root)
  assert.equal(synced.files.every((f) => f.exists && f.hasManagedBlock && f.upToDate), true)
  assert.deepEqual(synced.extraFiles.map((f) => [f.id, f.exists, f.upToDate]), [
    ['framework', true, true],
    ['claudeSkill', true, true],
    ['agentsSkill', true, true]
  ])
  assert.equal(synced.preview, buildHarnessGuideMarkdown(synced.options, 'agents'))

  const optionDrift = inspectHarnessGuide(root, { noComments: false })
  assert.equal(optionDrift.files.every((f) => !f.upToDate), true)

  writeFileSync(join(root, 'CLAUDE.md'), `${GUIDE_START}\nstale\n${GUIDE_END}\n`, 'utf8')
  const fileDrift = inspectHarnessGuide(root)
  const claudeFile = fileDrift.files.find((f) => f.id === 'claude')
  const agentsFile = fileDrift.files.find((f) => f.id === 'agents')
  assert.equal(claudeFile?.exists, true)
  assert.equal(claudeFile?.hasManagedBlock, true)
  assert.equal(claudeFile?.upToDate, false)
  assert.equal(agentsFile?.upToDate, true)
})

test('frameworkPlaybook: playbook keeps notes around its block, skills are rewritten whole, entry files point at it', () => {
  const root = tempProject()
  mkdirSync(join(root, '.forge'), { recursive: true })
  writeFileSync(join(root, '.forge', 'FRAMEWORK.md'), '# Our extra rules\n\nBalls use our own netcode.\n', 'utf8')
  syncHarnessGuide(root)

  const playbook = readFileSync(join(root, '.forge', 'FRAMEWORK.md'), 'utf8')
  assert.match(playbook, /^# Our extra rules\n\nBalls use our own netcode\./)
  assert.equal(playbook.includes(buildFrameworkMarkdown()), true)
  assert.match(playbook, /## 4\. Migration order/)

  const claudeSkill = readFileSync(join(root, '.claude', 'skills', 'forge-refactor', 'SKILL.md'), 'utf8')
  assert.equal(claudeSkill.startsWith('---\nname: forge-refactor\ndescription: '), true)
  assert.equal(readFileSync(join(root, '.agents', 'skills', 'forge-refactor', 'SKILL.md'), 'utf8'), claudeSkill)

  assert.match(readFileSync(join(root, 'AGENTS.md'), 'utf8'), /read `\.forge\/FRAMEWORK\.md`/)
  assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /read `\.forge\/FRAMEWORK\.md` first/)

  writeFileSync(join(root, '.claude', 'skills', 'forge-refactor', 'SKILL.md'), 'edited\n', 'utf8')
  const drift = inspectHarnessGuide(root)
  assert.equal(drift.extraFiles.find((f) => f.id === 'claudeSkill')?.upToDate, false)
  assert.deepEqual(syncHarnessGuide(root).written, ['.claude/skills/forge-refactor/SKILL.md'])
  assert.equal(readFileSync(join(root, '.claude', 'skills', 'forge-refactor', 'SKILL.md'), 'utf8'), claudeSkill)
})

test('frameworkPlaybook: each skill is written only for the harnesses that are targets', () => {
  const root = tempProject()
  const res = syncHarnessGuide(root, { targets: ['claude'] })
  assert.deepEqual(res.written.sort(), ['.claude/skills/forge-refactor/SKILL.md', '.forge/FRAMEWORK.md', 'CLAUDE.md'])
  assert.equal(existsSync(join(root, '.agents', 'skills')), false)
})

test('framework content.ts matches FRAMEWORK.md and SKILL.md (run npm run gen:framework after editing them)', () => {
  const dir = join(import.meta.dirname, '..', 'src', 'main', 'agent', 'framework')
  const read = (name: string) => readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n').trim()
  assert.equal(FRAMEWORK_PLAYBOOK, read('FRAMEWORK.md'))
  assert.equal(REFACTOR_SKILL, read('SKILL.md'))
})
