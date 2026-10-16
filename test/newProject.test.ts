import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { deflateRawSync } from 'node:zlib'
import {
  createProject,
  githubTemplateFetcher,
  remoteOwner,
  renameGitignore,
  renameProjectJson,
  renameReadme,
  renameWallyToml,
  validateProjectName,
  wallyPart,
  withLunePin,
  LUNE_PIN,
  type NewProjectProgress,
  type TemplateFetcher
} from '../src/main/services/setup/newProject.ts'
import type { CommandRunner } from '../src/main/services/setup/runner.ts'
import { readZip, writeZip } from '../src/main/services/setup/unzip.ts'

// Copies of the GenTree template's default.project.json, wally.toml, rokit.toml, events.blink,
// .gitignore and a README head (github.com/Acidgorgon/MyTemplate-Legacy, master).
const TEMPLATE = resolve(import.meta.dirname, 'fixtures', 'template')

// The injectable fetcher: copies the fixture and adds what a real clone has (.git pointing at the
// template, the template's .keep-git marker is never in clones but is removed anyway).
const localFetcher: TemplateFetcher = async (dest, report) => {
  report('Copying the fixture template', 50)
  cpSync(TEMPLATE, dest, { recursive: true })
  mkdirSync(join(dest, '.git'), { recursive: true })
  writeFileSync(join(dest, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/Acidgorgon/MyTemplate-Legacy.git\n')
  return 'local'
}

function fakeRunner(behaviour: (file: string, args: string[]) => { code: number; output: string } | undefined = () => undefined) {
  const calls: string[] = []
  const runner: CommandRunner = async (file, args, options) => {
    calls.push(`${file} ${args.join(' ')}`)
    options.onLine?.(`ran ${args[0]}`)
    const custom = behaviour(file, args)
    if (custom) return custom
    if (args[0] === 'config') return { code: 0, output: 'me@example.com\n' }
    return { code: 0, output: '' }
  }
  return { calls, runner }
}

const tools = (names: string[]) => (name: string) => (names.includes(name) ? `/bin/${name}` : null)

function parent(): string {
  return mkdtempSync(join(tmpdir(), 'forge-newproject-'))
}

test('project names must be usable folder names', () => {
  assert.equal(validateProjectName('My Game'), null)
  assert.match(validateProjectName('')!, /name/)
  assert.match(validateProjectName('a/b')!, /cannot contain/)
  assert.match(validateProjectName('CON')!, /cannot be used/)
  assert.match(validateProjectName('trailing.')!, /cannot be used/)
})

test('wally names are lower-case scope/name with dashes', () => {
  assert.equal(wallyPart('MyGame'), 'my-game')
  assert.equal(wallyPart('Tower Defense 2!'), 'tower-defense-2')
  assert.equal(wallyPart('___'), 'game')
  assert.equal(wallyPart('x'.repeat(80)).length, 64)
  assert.equal(remoteOwner('https://github.com/Team-One/Game.git'), 'Team-One')
  assert.equal(remoteOwner('git@github.com:solo/game'), 'solo')
  assert.equal(remoteOwner(undefined), null)
  assert.equal(renameWallyToml('[package]\nname = "a/b"\n', 'TeamOne', 'ShopSim'), '[package]\nname = "teamone/shop-sim"\n')
})

test('renames keep formatting and only touch the right lines', () => {
  const project = '{\n  "name": "GenTree",\n  "tree": {\n    "name": "keep"\n  }\n}\n'
  assert.equal(renameProjectJson(project, 'Shop "Sim"'), '{\n  "name": "Shop \\"Sim\\"",\n  "tree": {\n    "name": "keep"\n  }\n}\n')
  const wally = '[package]\nname = "acidg/gentree"\nversion = "0.1.0"\n\n[dependencies]\nname = "x/y@1.0.0"\n'
  assert.equal(renameWallyToml(wally, 'Team', 'Shop Sim'), '[package]\nname = "team/shop-sim"\nversion = "0.1.0"\n\n[dependencies]\nname = "x/y@1.0.0"\n')
  assert.equal(renameReadme('# GenTree\n\nGenTree is a template.\n', 'GenTree', 'Shop'), '# Shop\n\nGenTree is a template.\n')
  assert.equal(renameReadme('# Something else\n', 'GenTree', 'Shop'), '# Something else\n')
  assert.equal(renameGitignore('/GenTree.rbxlx\n/*.rbxlx.lock\n', 'GenTree', 'Shop'), '/Shop.rbxlx\n/*.rbxlx.lock\n')
})

test('GenTree project: strips template git, renames, git init + commit + remote, first setup', async () => {
  const dir = parent()
  const { calls, runner } = fakeRunner()
  const events: NewProjectProgress[] = []
  const result = await createProject(
    { name: 'Shop Sim', parentDir: dir, template: 'gentree', remoteUrl: 'https://github.com/TeamOne/shop-sim.git', initGit: true, firstSetup: true },
    { fetcher: localFetcher, runner, findTool: tools(['git', 'rokit', 'wally', 'blink']), onProgress: (p) => events.push(p) }
  )
  const root = join(dir, 'Shop Sim')
  assert.equal(result.root, root)
  assert.equal(result.via, 'local')
  assert.equal(existsSync(join(root, '.git', 'config')), false, 'template .git removed before git init')
  assert.equal(JSON.parse(readFileSync(join(root, 'default.project.json'), 'utf8')).name, 'Shop Sim')
  assert.match(readFileSync(join(root, 'wally.toml'), 'utf8'), /^name = "teamone\/shop-sim"$/m)
  assert.match(readFileSync(join(root, 'README.md'), 'utf8'), /^# Shop Sim$/m)
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^\/Shop Sim\.rbxlx$/m)
  // The template's tools stay; lune (Forge's tests, stories and lab previews) is pinned next to them.
  const rokit = readFileSync(join(root, 'rokit.toml'), 'utf8')
  assert.match(rokit, /^rojo = "rojo-rbx\/rojo@7\.7\.0"$/m)
  assert.match(rokit, /^blink = "1Axen\/blink@0\.18\.1"$/m)
  assert.match(rokit, /^lune = "lune-org\/lune@0\.11\.0"$/m)
  assert.deepEqual(calls, [
    '/bin/git init -b main',
    '/bin/git config user.email',
    '/bin/git add -A',
    '/bin/git commit -q -m Create Shop Sim from the GenTree template',
    '/bin/git remote add origin https://github.com/TeamOne/shop-sim.git',
    // The template's pins (rojo, wally, blink) are tools Forge knows: no trust prompt.
    '/bin/rokit install --no-trust-check',
    '/bin/wally install',
    '/bin/blink events.blink --yes'
  ])
  assert.deepEqual(result.steps.map((s) => `${s.step}:${s.state}`), ['fetch:done', 'prepare:done', 'rename:done', 'git:done', 'rokit:done', 'wally:done', 'blink:done'])
  // Live progress for each step, with tool output in between.
  for (const step of ['fetch', 'git', 'rokit', 'wally', 'blink']) assert.ok(events.some((e) => e.step === step && e.state === 'running'), step)
  assert.ok(events.some((e) => e.step === 'fetch' && e.percent === 50))
  assert.deepEqual(result.notes, [])
})

test('options off: no git, no first setup', async () => {
  const dir = parent()
  const { calls, runner } = fakeRunner()
  const result = await createProject(
    { name: 'Quiet', parentDir: dir, template: 'gentree', initGit: false, firstSetup: false },
    { fetcher: localFetcher, runner, findTool: tools(['git', 'rokit', 'wally', 'blink']) }
  )
  assert.deepEqual(calls, [])
  assert.deepEqual(result.steps.filter((s) => s.state === 'skipped').map((s) => s.step), ['git', 'rokit', 'wally', 'blink'])
  assert.equal(existsSync(join(result.root, '.git')), false)
})

test('missing tools are skipped with notes; failures do not stop the flow', async () => {
  const dir = parent()
  const { runner } = fakeRunner((file, args) => (args[0] === 'install' && file.endsWith('rokit') ? { code: 1, output: 'error: Failed to fetch release for rojo-rbx/rojo@7.7.0' } : undefined))
  const result = await createProject(
    { name: 'NoTools', parentDir: dir, template: 'gentree', initGit: true, firstSetup: true },
    { fetcher: localFetcher, runner, findTool: tools(['rokit']) }
  )
  const by = Object.fromEntries(result.steps.map((s) => [s.step, s]))
  assert.equal(by.git.state, 'skipped')
  assert.match(by.git.note!, /Git is not installed/)
  assert.equal(by.rokit.state, 'failed')
  assert.equal(by.rokit.note, 'rokit install failed: Failed to fetch release for rojo-rbx/rojo@7.7.0')
  assert.equal(by.wally.state, 'skipped')
  assert.equal(by.blink.state, 'skipped')
  assert.ok(result.notes.length >= 3)
})

test('no git identity: the first commit uses a fallback author and says so', async () => {
  const dir = parent()
  const { calls, runner } = fakeRunner((_f, args) => (args[0] === 'config' ? { code: 1, output: '' } : undefined))
  const result = await createProject(
    { name: 'Anon', parentDir: dir, template: 'empty', initGit: true, firstSetup: false },
    { runner, findTool: tools(['git']), fallbackAuthor: { name: 'Forge User', email: 'forge@localhost' } }
  )
  assert.ok(calls.includes('/bin/git -c user.name=Forge User -c user.email=forge@localhost commit -q -m Create Anon from an empty Rojo project'))
  assert.match(result.notes.join(' '), /user\.name/)
})

test('empty Rojo project is generated without any fetch', async () => {
  const dir = parent()
  const { runner } = fakeRunner()
  let fetched = false
  const result = await createProject(
    { name: 'Blank', parentDir: dir, template: 'empty', initGit: false, firstSetup: true },
    { runner, fetcher: async () => ((fetched = true), 'local'), findTool: tools(['rokit']) }
  )
  assert.equal(fetched, false)
  assert.equal(result.via, 'generated')
  const project = JSON.parse(readFileSync(join(result.root, 'default.project.json'), 'utf8'))
  assert.equal(project.name, 'Blank')
  assert.equal(project.tree.ServerScriptService.Server.$path, 'src/server')
  assert.ok(existsSync(join(result.root, 'src', 'client', 'init.client.luau')))
  assert.match(readFileSync(join(result.root, 'rokit.toml'), 'utf8'), /rojo = "rojo-rbx\/rojo@7\.7\.0"/)
  assert.match(readFileSync(join(result.root, 'rokit.toml'), 'utf8'), /^lune = "lune-org\/lune@0\.11\.0"$/m)
  const by = Object.fromEntries(result.steps.map((s) => [s.step, s.state]))
  assert.deepEqual([by.rokit, by.wally, by.blink], ['done', 'skipped', 'skipped'])
})

test('refuses a non-empty destination and bad input before touching disk', async () => {
  const dir = parent()
  mkdirSync(join(dir, 'Taken'))
  writeFileSync(join(dir, 'Taken', 'x'), '')
  await assert.rejects(createProject({ name: 'Taken', parentDir: dir, template: 'empty', initGit: false, firstSetup: false }), /not empty/)
  await assert.rejects(createProject({ name: 'a:b', parentDir: dir, template: 'empty', initGit: false, firstSetup: false }), /cannot contain/)
  await assert.rejects(createProject({ name: 'Ok', parentDir: dir, template: 'empty', remoteUrl: 'not a url', initGit: true, firstSetup: false }), /git URL/)
})

test('a failed fetch removes the half-made folder and reports why', async () => {
  const dir = parent()
  await assert.rejects(
    createProject(
      { name: 'Offline', parentDir: dir, template: 'gentree', initGit: false, firstSetup: false },
      { fetcher: async () => { throw new Error('Could not download the template: offline') } }
    ),
    /offline/
  )
  assert.equal(existsSync(join(dir, 'Offline')), false)
})

test('GitHub fetcher: git clone --depth 1 of master when git works', async () => {
  const dest = join(parent(), 'g')
  mkdirSync(dest)
  const { calls, runner } = fakeRunner()
  const via = await githubTemplateFetcher({ runner, findTool: tools(['git']), download: async () => { throw new Error('should not download') } })(dest, () => {})
  assert.equal(via, 'git')
  assert.deepEqual(calls, [`/bin/git clone --depth 1 --branch master --single-branch --progress https://github.com/Acidgorgon/MyTemplate-Legacy.git ${dest}`])
})

test('GitHub fetcher: falls back to the codeload zip when git is missing or the clone fails', async () => {
  const zip = writeZip([
    { name: 'MyTemplate-Legacy-master/', data: '' },
    { name: 'MyTemplate-Legacy-master/default.project.json', data: '{"name":"GenTree","tree":{}}' },
    { name: 'MyTemplate-Legacy-master/dev', data: '#!/usr/bin/env bash\n', executable: true },
    { name: 'MyTemplate-Legacy-master/../escape.txt', data: 'no' }
  ])
  const urls: string[] = []
  const download = async (url: string) => (urls.push(url), zip)

  const a = join(parent(), 'a')
  mkdirSync(a)
  assert.equal(await githubTemplateFetcher({ findTool: () => null, download })(a, () => {}), 'zip')
  assert.equal(JSON.parse(readFileSync(join(a, 'default.project.json'), 'utf8')).name, 'GenTree')
  if (process.platform !== 'win32') assert.ok(statSync(join(a, 'dev')).mode & 0o100, 'dev stays executable')
  assert.equal(existsSync(join(a, '..', 'escape.txt')), false)
  assert.deepEqual(urls, ['https://codeload.github.com/Acidgorgon/MyTemplate-Legacy/zip/refs/heads/master'])

  const b = join(parent(), 'b')
  mkdirSync(b)
  const lines: string[] = []
  const failing = fakeRunner(() => ({ code: 128, output: 'fatal: unable to access: Could not resolve host: github.com' }))
  assert.equal(await githubTemplateFetcher({ runner: failing.runner, findTool: tools(['git']), download })(b, (l) => lines.push(l)), 'zip')
  assert.ok(lines.some((l) => /git clone failed/.test(l)))
  assert.ok(existsSync(join(b, 'default.project.json')))

  const c = join(parent(), 'c')
  mkdirSync(c)
  await assert.rejects(githubTemplateFetcher({ findTool: () => null, download: async () => { throw new Error('getaddrinfo ENOTFOUND codeload.github.com') } })(c, () => {}), /Could not download the template: getaddrinfo/)
})

test('zip reader handles deflated entries', () => {
  // A deflate entry built by hand: local header + raw deflate + central directory.
  const data = Buffer.from('hello hello hello hello')
  const packed = deflateRawSync(data)
  const stored = writeZip([{ name: 'x.txt', data: packed }])
  // Patch method (8) and uncompressed size in both headers.
  stored.writeUInt16LE(8, 8)
  stored.writeUInt32LE(data.length, 22)
  const central = stored.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  stored.writeUInt16LE(8, central + 10)
  stored.writeUInt32LE(data.length, central + 24)
  assert.equal(readZip(stored)[0].data.toString(), 'hello hello hello hello')
})

test('with real git (when installed): the new project is its own repository with one commit', async (t) => {
  let git: string
  try {
    execFileSync('git', ['--version'])
    git = 'git'
  } catch {
    t.skip('git not installed')
    return
  }
  const dir = parent()
  const result = await createProject(
    { name: 'Real', parentDir: dir, template: 'gentree', remoteUrl: 'https://github.com/me/real.git', initGit: true, firstSetup: false },
    { fetcher: localFetcher, findTool: (n) => (n === 'git' ? git : null), env: { ...process.env, GIT_CONFIG_GLOBAL: join(dir, 'nogit'), GIT_CONFIG_NOSYSTEM: '1' } }
  )
  const out = (args: string[]) => execFileSync('git', args, { cwd: result.root, encoding: 'utf8' }).trim()
  assert.equal(out(['rev-list', '--count', 'HEAD']), '1')
  assert.equal(out(['remote', 'get-url', 'origin']), 'https://github.com/me/real.git')
  assert.match(out(['log', '-1', '--format=%s']), /Create Real from the GenTree template/)
  assert.equal(out(['status', '--porcelain']), '')
})

test('withLunePin adds lune to [tools] once and keeps an existing pin', () => {
  assert.equal(LUNE_PIN.id, 'lune-org/lune')
  const base = '# Tools\n[tools]\nrojo = "rojo-rbx/rojo@7.7.0"\n'
  const pinned = withLunePin(base)
  assert.match(pinned, /^# Tools\n\[tools\]\nrojo = "rojo-rbx\/rojo@7\.7\.0"\nlune = "lune-org\/lune@0\.11\.0"\n$/)
  assert.equal(withLunePin(pinned), pinned)
  const own = '[tools]\nlune = "lune-org/lune@0.10.4"\n'
  assert.equal(withLunePin(own), own, 'a project that pins its own lune keeps it')
  assert.match(withLunePin(''), /\[tools\]\s*\nlune = "lune-org\/lune@0\.11\.0"/)
})
