// Packages: wally.toml / rokit.toml line edits, alias rules, registry response parsing, and the
// Packages service against a temp project (fake fetch, fake tools; no network, no Electron).
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { PackagesChanged } from '../src/shared/types.ts'
import {
  compareVersions,
  defaultAlias,
  latestVersion,
  listWallyDependencies,
  PackageError,
  Packages,
  parseMetadataResponse,
  parseRokitManifest,
  parseSearchResponse,
  parseWallyLock,
  parseWallyManifest,
  replaceRequirement,
  rokitInstalled,
  rokitSet,
  tagToVersion,
  tomlRemove,
  tomlSet,
  wallyAdd,
  wallyRemove
} from '../src/main/services/packages.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'packages')
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')
const WALLY = fixture('wally.toml')
const ROKIT = fixture('rokit.toml')

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-packages-'))
  dirs.push(dir)
  for (const name of ['wally.toml', 'rokit.toml', 'wally.lock']) cpSync(join(FIXTURES, name), join(dir, name))
  return dir
}

test('parses the template wally.toml', () => {
  const deps = parseWallyManifest(WALLY)
  assert.equal(deps.length, 15)
  assert.deepEqual(
    { ...deps.find((d) => d.alias === 'Janitor'), line: undefined },
    { alias: 'Janitor', scope: 'howmanysmall', name: 'janitor', version: '1.18.3', realm: 'shared', line: undefined }
  )
  assert.ok(deps.every((d) => d.realm === 'shared'))
  // [package] name/version are not dependencies.
  assert.ok(!deps.some((d) => d.alias === 'name'))
})

test('add + remove round-trips the template wally.toml byte for byte', () => {
  const added = wallyAdd(WALLY, { scope: 'sleitnick', name: 'trove', version: '1.8.0', realm: 'shared' })
  assert.equal(added.alias, 'Trove')
  // Inserted after the last [dependencies] line; everything else untouched.
  const before = WALLY.split('\n')
  const lines = added.text.split('\n')
  assert.equal(lines.length, before.length + 1)
  assert.equal(lines[lines.length - 1], 'Trove = "sleitnick/trove@1.8.0"')
  assert.deepEqual(lines.slice(0, -1), before)
  assert.equal(wallyRemove(added.text, 'Trove', 'shared'), WALLY)
})

test('server and dev deps go into their own sections, created at the end', () => {
  let text = wallyAdd(WALLY, { scope: 'leifstout', name: 'profilestore', version: '1.0.3', realm: 'server' }).text
  text = wallyAdd(text, { scope: 'jsdotlua', name: 'jest', version: '3.10.0', realm: 'dev' }).text
  text = wallyAdd(text, { scope: 'sleitnick', name: 'comm', version: '1.0.1', realm: 'server' }).text
  assert.ok(text.startsWith(WALLY + '\n\n[server-dependencies]\nProfilestore = "leifstout/profilestore@1.0.3"\nComm = "sleitnick/comm@1.0.1"\n\n[dev-dependencies]\nJest = "jsdotlua/jest@3.10.0"'))
  const deps = parseWallyManifest(text)
  assert.equal(deps.find((d) => d.alias === 'Comm')?.realm, 'server')
  assert.equal(deps.find((d) => d.alias === 'Jest')?.realm, 'dev')
  // Removing everything added returns the original text apart from the empty headers.
  let back = wallyRemove(text, 'Profilestore', 'server')
  back = wallyRemove(back, 'Comm', 'server')
  back = wallyRemove(back, 'Jest', 'dev')
  assert.equal(back, WALLY + '\n\n[server-dependencies]\n\n[dev-dependencies]')
})

test('keeps comments, CRLF line endings, indentation and inline comments', () => {
  const text = '# my game\r\n[package]\r\nname = "me/game"\r\n\r\n[dependencies]\r\n  # utilities\r\n  Janitor = "howmanysmall/janitor@1.18.3" # cleanup\r\n\r\n[server-dependencies]\r\n'
  const added = wallyAdd(text, { scope: 'sleitnick', name: 'signal', version: '2.0.3', realm: 'shared' }).text
  assert.equal(added, text.replace('# cleanup\r\n', '# cleanup\r\n  Signal = "sleitnick/signal@2.0.3"\r\n'))
  const bumped = wallyAdd(added, { scope: 'howmanysmall', name: 'janitor', version: '1.18.4', realm: 'shared' }).text
  assert.ok(bumped.includes('  Janitor = "howmanysmall/janitor@1.18.4" # cleanup\r\n'))
  const server = wallyAdd(text, { scope: 'leifstout', name: 'profilestore', version: '1.0.3', realm: 'server' }).text
  assert.ok(server.endsWith('[server-dependencies]\r\nProfilestore = "leifstout/profilestore@1.0.3"\r\n'))
})

test('alias collisions are refused; same package re-added updates the version', () => {
  assert.throws(
    () => wallyAdd(WALLY, { scope: 'someone', name: 'janitor', version: '0.1.0', realm: 'shared' }),
    (e: Error) => e instanceof PackageError && /alias Janitor is already used by howmanysmall\/janitor/.test(e.message)
  )
  // Case-insensitive: "janitor" clashes with "Janitor".
  assert.throws(() => wallyAdd(WALLY, { scope: 'x', name: 'y', version: '1.0.0', realm: 'shared', alias: 'janitor' }), PackageError)
  // Custom alias avoids the clash.
  const ok = wallyAdd(WALLY, { scope: 'someone', name: 'janitor', version: '0.1.0', realm: 'shared', alias: 'Janitor2' })
  assert.equal(ok.alias, 'Janitor2')
  // Same package under another alias in the same realm.
  assert.throws(() => wallyAdd(WALLY, { scope: 'howmanysmall', name: 'janitor', version: '1.18.3', realm: 'shared', alias: 'Jan' }), /already added as Janitor/)
  // Same package, other realm.
  assert.throws(() => wallyAdd(WALLY, { scope: 'howmanysmall', name: 'janitor', version: '1.18.3', realm: 'server' }), /Remove it there first/)
  const updated = wallyAdd(WALLY, { scope: 'howmanysmall', name: 'janitor', version: '1.19.0', realm: 'shared' })
  assert.equal(updated.text, WALLY.replace('howmanysmall/janitor@1.18.3', 'howmanysmall/janitor@1.19.0'))
  assert.throws(() => wallyAdd(WALLY, { scope: 'a', name: 'b', version: '1.0.0', realm: 'shared', alias: '9lives' }), /not a valid alias/)
  assert.throws(() => wallyRemove(WALLY, 'Nope', 'shared'), PackageError)
})

test('default alias follows the file style', () => {
  const template = parseWallyManifest(WALLY)
  // Template aliases multi-word packages as "Videcharm", "Conchui", "Uilabs".
  assert.equal(defaultAlias('janitor', template), 'Janitor')
  assert.equal(defaultAlias('profile-store', template), 'Profilestore')
  // A file that uses PascalCase gets PascalCase.
  const pascal = parseWallyManifest('[dependencies]\nVideCharm = "littensy/vide-charm@0.3.0"\n')
  assert.equal(defaultAlias('profile-store', pascal), 'ProfileStore')
  assert.equal(defaultAlias('profile-store', []), 'ProfileStore')
})

test('wally.lock gives installed versions of the root package deps', () => {
  const lock = parseWallyLock(fixture('wally.lock'), 'acidg/gentree')
  assert.equal(lock.get('Conch'), 'alicesaidhi/conch@0.3.1')
  assert.equal(lock.get('Uilabs'), 'pepeeltoro41/ui-labs@2.4.2')
  assert.equal(lock.size, 15)
})

test('listWallyDependencies reads install state from Packages/ and wally.lock', () => {
  const root = tempProject()
  mkdirSync(join(root, 'Packages'))
  writeFileSync(join(root, 'Packages', 'Conch.lua'), 'return nil')
  const deps = listWallyDependencies(root)
  const conch = deps.find((d) => d.alias === 'Conch')!
  assert.equal(conch.installed, true)
  assert.equal(conch.installedVersion, '0.3.1')
  const vide = deps.find((d) => d.alias === 'Vide')!
  assert.equal(vide.installed, false)
  assert.equal(vide.installedVersion, undefined)
})

test('rokit.toml: parse, add and bump keep the comment and order', () => {
  const tools = parseRokitManifest(ROKIT)
  assert.deepEqual(
    tools.map((t) => [t.name, t.repo, t.version]),
    [
      ['rojo', 'rojo-rbx/rojo', '7.7.0'],
      ['wally', 'UpliftGames/wally', '0.3.2'],
      ['blink', '1Axen/blink', '0.18.1']
    ]
  )
  const added = rokitSet(ROKIT, 'luau-lsp', 'JohnnyMorganz/luau-lsp', '1.70.1')
  assert.equal(added, ROKIT.replace('blink = "1Axen/blink@0.18.1"', 'blink = "1Axen/blink@0.18.1"\nluau-lsp = "JohnnyMorganz/luau-lsp@1.70.1"'))
  const bumped = rokitSet(added, 'blink', '1Axen/blink', '0.18.9')
  assert.ok(bumped.startsWith('# Tools for this repo. After clone: rokit install\n[tools]\nrojo'))
  assert.ok(bumped.includes('blink = "1Axen/blink@0.18.9"\nluau-lsp'))
  assert.equal(tomlRemove(added, 'tools', 'luau-lsp'), ROKIT)
  assert.equal(rokitSet('', 'stylua', 'JohnnyMorganz/StyLua', '2.6.0'), '[tools]\nstylua = "JohnnyMorganz/StyLua@2.6.0"\n')
})

test('tomlSet quotes keys that need it', () => {
  assert.equal(tomlSet('[tools]\n', 'tools', 'my.tool', 'a/b@1.0.0'), '[tools]\n"my.tool" = "a/b@1.0.0"\n')
})

test('parses and ranks a saved package-search response', () => {
  const results = parseSearchResponse(JSON.parse(fixture('search-signal.json')), 'signal')
  // Entries without versions are dropped.
  assert.equal(results.length, 11)
  assert.equal(`${results[0].scope}/${results[0].name}`, 'sleitnick/signal')
  assert.deepEqual(results[0], { scope: 'sleitnick', name: 'signal', latest: '2.0.3', versions: ['2.0.3'], description: 'Signal class' })
  // Exact names before partial ones.
  const firstPartial = results.findIndex((r) => r.name !== 'signal')
  assert.ok(results.slice(firstPartial).every((r) => r.name !== 'signal'))
  assert.equal(results.find((r) => r.name === 'signalplus')?.description, undefined)
  assert.deepEqual(parseSearchResponse({ error: 'nope' }, 'x'), [])
  // scope/name queries rank that scope first.
  assert.equal(parseSearchResponse(JSON.parse(fixture('search-signal.json')), 'stravant/goodsignal')[0].scope, 'stravant')
})

test('parses a saved package-metadata response', () => {
  const pkg = parseMetadataResponse(JSON.parse(fixture('metadata-sleitnick-signal.json')), 'sleitnick', 'signal')
  assert.equal(pkg.latest, '2.0.3')
  assert.equal(pkg.realm, 'shared')
  assert.equal(pkg.versions.length, 14)
  assert.equal(pkg.versions[13], '1.0.0')
  assert.deepEqual(pkg.authors, ['Stephen Leitnick'])
  assert.equal(pkg.license, 'MIT')
  assert.throws(() => parseMetadataResponse({ versions: [] }, 'a', 'b'), PackageError)
})

test('versions: compare, latest, requirement rewrite, release tags', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0)
  assert.ok(compareVersions('2.0.0-rc.1', '2.0.0') < 0)
  assert.equal(compareVersions('v0.18.9', '0.18.9'), 0)
  assert.equal(latestVersion(['0.3.0', '0.4.0-beta', '0.3.5']), '0.3.5')
  assert.equal(latestVersion(['0.1.0-alpha']), '0.1.0-alpha')
  assert.equal(replaceRequirement('^1.2.0', '2.0.0'), '^2.0.0')
  assert.equal(replaceRequirement('=0.4.1', '0.4.2'), '=0.4.2')
  assert.equal(replaceRequirement('0.3.0', '0.4.0'), '0.4.0')
  assert.equal(tagToVersion('v0.18.9'), '0.18.9')
  assert.equal(tagToVersion('0.32.0'), '0.32.0')
  assert.equal(tagToVersion('v0.7.4+registry.0.2.3'), '0.7.4+registry.0.2.3')
})

test('rokitInstalled looks in tool-storage (lowercased owner/repo)', () => {
  const home = mkdtempSync(join(tmpdir(), 'rokit-home-'))
  dirs.push(home)
  const exe = process.platform === 'win32' ? '.exe' : ''
  mkdirSync(join(home, 'tool-storage', 'johnnymorganz', 'stylua', '2.6.0'), { recursive: true })
  writeFileSync(join(home, 'tool-storage', 'johnnymorganz', 'stylua', '2.6.0', 'stylua' + exe), '')
  assert.equal(rokitInstalled('JohnnyMorganz/StyLua', '2.6.0', home), true)
  assert.equal(rokitInstalled('JohnnyMorganz/StyLua', '2.5.0', home), false)
})

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

test('Packages service: add via the dev loop, update info, rate-limited GitHub', async () => {
  const root = tempProject()
  const events: PackagesChanged[] = []
  const urls: string[] = []
  let githubCalls = 0
  const fakeFetch = (async (input: string | URL) => {
    const url = String(input)
    urls.push(url)
    if (url.includes('/package-metadata/sleitnick/signal')) return jsonResponse(JSON.parse(fixture('metadata-sleitnick-signal.json')))
    if (url.includes('/package-metadata/howmanysmall/janitor')) {
      return jsonResponse({ versions: ['1.18.3', '1.18.5', '1.17.0'].map((version) => ({ package: { version, realm: 'shared' } })) })
    }
    if (url.includes('/package-metadata/leifstout/serveronly')) return jsonResponse({ versions: [{ package: { version: '1.0.0', realm: 'server' } }] })
    if (url.includes('/package-metadata/')) return jsonResponse({}, 404)
    if (url.includes('/package-search')) return jsonResponse(JSON.parse(fixture('search-signal.json')))
    if (url.includes('api.github.com')) {
      githubCalls++
      if (url.includes('rojo-rbx/rojo')) return jsonResponse({ tag_name: 'v7.7.1' })
      return jsonResponse({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) })
    }
    throw new Error(`unexpected ${url}`)
  }) as typeof fetch

  const packages = new Packages({
    root: () => root,
    devRunning: () => true,
    log: () => undefined,
    emit: (e) => events.push(e),
    fetch: fakeFetch,
    findTool: () => null,
    rokitHome: join(root, 'no-rokit'),
    devInstallWaitMs: 5000
  })

  const search = await packages.search('signal')
  assert.equal(search[0].scope, 'sleitnick')
  assert.equal(search[0].versions.length, 14, 'top hits are enriched with metadata')
  assert.equal(search[0].realm, 'shared')

  // Janitor 1.18.3 in wally.toml, 1.18.5 on the registry.
  const deps = await packages.listDeps()
  const janitor = deps.find((d) => d.alias === 'Janitor')!
  assert.equal(janitor.latest, '1.18.5')
  assert.equal(janitor.updateAvailable, true)
  assert.equal(deps.find((d) => d.alias === 'Signal')?.updateAvailable, false)

  await assert.rejects(packages.addDep({ scope: 'leifstout', name: 'serveronly', version: '1.0.0', realm: 'shared' }), /server package/)

  // The "dev loop" installs it: make Packages/Trove.lua appear shortly after.
  const list = await packages.addDep({ scope: 'sleitnick', name: 'trove', version: '1.8.0', realm: 'shared' })
  assert.equal(list.find((d) => d.alias === 'Trove')?.installed, false)
  assert.equal(events.at(-1)?.installing, 'wally')
  setTimeout(() => {
    mkdirSync(join(root, 'Packages'), { recursive: true })
    writeFileSync(join(root, 'Packages', 'Trove.lua'), '')
  }, 300)
  const deadline = Date.now() + 6000
  while (Date.now() < deadline && events.at(-1)?.installing !== null) await new Promise((r) => setTimeout(r, 100))
  const finished = events.at(-1)!
  assert.equal(finished.installing, null)
  assert.equal(finished.error, undefined)
  assert.equal(finished.wally?.find((d) => d.alias === 'Trove')?.installed, true)

  // Update rewrites the version to latest.
  await packages.updateDep('Janitor', 'shared')
  assert.match(readFileSync(join(root, 'wally.toml'), 'utf8'), /Janitor = "howmanysmall\/janitor@1\.18\.5"/)

  // GitHub: rojo has a newer release; the rate limit stops further calls.
  const tools = await packages.listTools()
  assert.equal(tools.find((t) => t.name === 'rojo')?.latest, '7.7.1')
  assert.equal(tools.find((t) => t.name === 'rojo')?.updateAvailable, true)
  assert.equal(tools.find((t) => t.name === 'rojo')?.installed, false)
  const callsAfterLimit = githubCalls
  const curated = await packages.curated()
  assert.equal(githubCalls, callsAfterLimit, 'no GitHub calls while rate limited')
  const lsp = curated.find((t) => t.name === 'luau-lsp')!
  assert.equal(lsp.inManifest, false)
  assert.equal(lsp.onPath, false)
  assert.equal(curated.find((t) => t.name === 'rojo')?.inManifest, true)
})

test('Packages service: adding a tool without rokit edits rokit.toml and reports the error', async () => {
  const root = tempProject()
  const events: PackagesChanged[] = []
  const packages = new Packages({
    root: () => root,
    devRunning: () => false,
    log: () => undefined,
    emit: (e) => events.push(e),
    fetch: (async () => jsonResponse({ tag_name: '1.70.1' })) as unknown as typeof fetch,
    findTool: () => null
  })
  const tools = await packages.addTool('JohnnyMorganz/luau-lsp')
  assert.ok(tools.some((t) => t.name === 'luau-lsp' && t.version === '1.70.1'))
  assert.match(readFileSync(join(root, 'rokit.toml'), 'utf8'), /luau-lsp = "JohnnyMorganz\/luau-lsp@1\.70\.1"\n?$/)
  assert.match(events.at(-1)?.error ?? '', /rokit is not installed/)
  await assert.rejects(packages.addTool('not a repo'), /owner\/repo/)
})
