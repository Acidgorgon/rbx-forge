import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ServiceStatus } from '../src/shared/types.ts'
import { isTemplateOrigin, Supervisor } from '../src/main/services/supervisor.ts'
import { makeProject, write } from './fixture.ts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

test('recognises the template origin the way dev.sh does', () => {
  assert.ok(isTemplateOrigin('https://github.com/Acidgorgon/mytemplate-legacy'))
  assert.ok(isTemplateOrigin('git@github.com:Acidgorgon/MyTemplate-Legacy.git'))
  assert.ok(!isTemplateOrigin('https://github.com/someone/MyGame.git'))
})

test('does not start dev on the template repo without .keep-git', async () => {
  const root = makeProject()
  roots.push(root)
  write(root, 'dev', '#!/usr/bin/env bash\necho should-not-run\n')
  execFileSync('git', ['init', '-q', root])
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/Acidgorgon/mytemplate-legacy'])
  let last: ServiceStatus[] = []
  const supervisor = new Supervisor({
    log: () => undefined,
    onStatus: (statuses) => (last = statuses),
    getSetting: <T>(_key: string, fallback: T) => fallback
  })
  await supervisor.setRoot(root)
  await supervisor.start('dev')
  const dev = last.find((s) => s.id === 'dev')!
  assert.equal(dev.state, 'stopped')
  assert.match(dev.detail ?? '', /would delete its \.git/)
  assert.ok(existsSync(join(root, '.git')))
  await supervisor.stopAll()
})
