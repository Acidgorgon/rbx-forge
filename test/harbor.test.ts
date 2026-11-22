import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { parseLibsConfig, setLibsConfigToggle, writeLibsConfigToggle } from '../src/main/services/harbor/libsConfig.ts'
import { detectHarborProject } from '../src/main/services/harbor/detect.ts'
import { HarborService } from '../src/main/services/harbor/service.ts'
import { harborTools } from '../src/main/services/harbor/tools.ts'
import { defaultContext } from '../src/main/services/tools.ts'

const dirs: string[] = []
const services: HarborService[] = []

after(() => {
  for (const s of services) s.dispose()
  services.length = 0
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function temp(prefix = 'forge-harbor-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

function makeFakeCurrentCli(dir: string, outFile: string): void {
  const js = join(dir, 'current.mjs')
  writeFileSync(
    js,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(outFile)}, process.argv.slice(2).join(' '), 'utf8');\nconsole.log('compiled current schema');\n`,
    'utf8'
  )
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'current.cmd'), `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`, 'utf8')
  } else {
    const sh = join(dir, 'current')
    writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, 'utf8')
    chmodSync(sh, 0o755)
  }
}

test('detectHarborProject detects all 5 Harbor libraries, schemas, manifests, and LibsConfig toggles', () => {
  const root = temp()
  mkdirSync(join(root, 'src', 'shared', 'Modules'), { recursive: true })
  mkdirSync(join(root, 'src', 'shared', 'Ripple'), { recursive: true })
  mkdirSync(join(root, 'src', 'shared', 'Anchor'), { recursive: true })
  mkdirSync(join(root, 'src', 'shared', 'Tide'), { recursive: true })
  mkdirSync(join(root, 'src', 'shared', 'Lighthouse'), { recursive: true })
  mkdirSync(join(root, 'tools'), { recursive: true })

  writeFileSync(
    join(root, 'rokit.toml'),
    '[tools]\ncurrent = "Acidgorgon/Current@0.1.2"\nlune = "lune-org/lune@0.11.0"\n',
    'utf8'
  )
  writeFileSync(
    join(root, 'wally.toml'),
    '[package]\nname = "acid/game"\nversion = "0.1.0"\nrealm = "shared"\n[dependencies]\nAnchor = "acid/anchor@1.0.0"\n',
    'utf8'
  )
  writeFileSync(join(root, 'tools', 'current-schema.luau'), '-- current schema\n', 'utf8')
  writeFileSync(join(root, 'src', 'shared', 'Ripple', 'clubsync.ripple'), '-- ripple schema\n', 'utf8')
  writeFileSync(join(root, 'src', 'shared', 'Anchor', 'init.luau'), 'return {}\n', 'utf8')
  writeFileSync(join(root, 'src', 'shared', 'Tide', 'init.luau'), 'return {}\n', 'utf8')
  writeFileSync(join(root, 'src', 'shared', 'Lighthouse', 'init.luau'), 'return {}\n', 'utf8')
  writeFileSync(
    join(root, 'src', 'shared', 'Modules', 'LibsConfig.luau'),
    `-- Header comment\nreturn {\n\tUseCurrent = true,\n\tUseRipple = true,\n\tUseAnchor = false,\n\tUseTide = true,\n\tUseLighthouse = false,\n}\n`,
    'utf8'
  )

  const st = detectHarborProject(root)
  assert.equal(st.libsConfigPath, 'src/shared/Modules/LibsConfig.luau')
  assert.equal(st.libs.current.detected, true)
  assert.equal(st.libs.current.version, '0.1.2')
  assert.equal(st.libs.current.enabled, true)
  assert.deepEqual(st.libs.current.schemaFiles, ['tools/current-schema.luau'])

  assert.equal(st.libs.ripple.detected, true)
  assert.equal(st.libs.ripple.enabled, true)
  assert.deepEqual(st.libs.ripple.schemaFiles, ['src/shared/Ripple/clubsync.ripple'])

  assert.equal(st.libs.anchor.detected, true)
  assert.equal(st.libs.anchor.enabled, false)

  assert.equal(st.libs.tide.detected, true)
  assert.equal(st.libs.tide.enabled, true)

  assert.equal(st.libs.lighthouse.detected, true)
  assert.equal(st.libs.lighthouse.enabled, false)
})

test('LibsConfig lossless editor preserves comments, CRLF, whitespace, and unrelated values byte-for-byte', async () => {
  const dir = temp()
  const file = join(dir, 'LibsConfig.luau')
  const original = [
    '-- Do not remove header comment',
    '--[[',
    '  UseAnchor = true, -- block comment ignored',
    ']]',
    'return {',
    '  -- UseAnchor = false,',
    '  UseCurrent = true, -- networking',
    '  ["UseAnchor"] = false;',
    '  DebugLevel = 3,',
    '  UseTide = true,',
    '}',
    ''
  ].join('\r\n')

  writeFileSync(file, original, 'utf8')
  const entries = parseLibsConfig(original)
  assert.deepEqual(
    entries.map((e) => [e.key, e.value, e.libId]),
    [
      ['UseCurrent', true, 'current'],
      ['UseAnchor', false, 'anchor'],
      ['UseTide', true, 'tide']
    ]
  )

  const flipped = setLibsConfigToggle(original, 'UseAnchor', true)
  assert.equal(
    flipped,
    original.replace('  ["UseAnchor"] = false;', '  ["UseAnchor"] = true;')
  )

  await writeLibsConfigToggle(file, 'UseAnchor', true)
  await writeLibsConfigToggle(file, 'UseAnchor', false)
  assert.equal(readFileSync(file, 'utf8'), original)
})

test('HarborService watches schema edits with debounce and cleanly disposes', async () => {
  const root = temp()
  mkdirSync(join(root, 'tools'), { recursive: true })
  writeFileSync(join(root, 'tools', 'current-schema.luau'), '-- v1\n', 'utf8')

  const seenBatches: string[][] = []
  let resolver: (() => void) | null = null
  const triggered = new Promise<void>((r) => {
    resolver = r
  })

  const svc = new HarborService({
    debounceMs: 30,
    onWatchChange: (files) => {
      seenBatches.push(files)
      resolver?.()
    }
  })
  services.push(svc)

  const initial = svc.setProject(root)
  assert.equal(initial.watcherActive, true)

  // Give fs.watch a brief moment to settle, then edit schema.
  await new Promise((r) => setTimeout(r, 40))
  writeFileSync(join(root, 'tools', 'current-schema.luau'), '-- v2\n', 'utf8')

  await Promise.race([
    triggered,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('watcher debounce timed out')), 4000))
  ])
  assert.ok(seenBatches.flat().some((f) => f.includes('current-schema.luau')))

  svc.dispose()
  assert.equal(svc.status().watcherActive, false)
})

test('harborTools inspect status, toggle LibsConfig losslessly, and invoke current codegen CLI', async () => {
  const root = temp()
  const binDir = temp()
  const emptyHome = temp('harbor-home-')
  const invokedLog = join(root, 'current-invoked.txt')
  makeFakeCurrentCli(binDir, invokedLog)

  mkdirSync(join(root, 'src', 'shared', 'Modules'), { recursive: true })
  mkdirSync(join(root, 'tools'), { recursive: true })
  writeFileSync(join(root, 'tools', 'current-schema.luau'), '-- schema\n', 'utf8')
  writeFileSync(join(root, 'src', 'shared', 'Modules', 'LibsConfig.luau'), 'return {\n\tUseCurrent = false,\n}\n', 'utf8')

  const baseCtx = defaultContext()
  const cleanEnv: NodeJS.ProcessEnv = { ...baseCtx.env }
  for (const k of Object.keys(cleanEnv)) {
    if (k.toUpperCase() === 'PATH') delete cleanEnv[k]
  }
  cleanEnv.USERPROFILE = emptyHome
  cleanEnv.HOME = emptyHome
  cleanEnv.ROKIT_ROOT = emptyHome
  cleanEnv[process.platform === 'win32' ? 'Path' : 'PATH'] = binDir

  const toolCtx = {
    ...baseCtx,
    home: emptyHome,
    env: cleanEnv
  }

  const svc = new HarborService({ toolCtx, watch: false })
  services.push(svc)
  svc.setProject(root)

  const tools = harborTools(svc)
  const stTool = tools.read.find((t) => t.name === 'harbor_status')!
  const toggleTool = tools.write.find((t) => t.name === 'harbor_toggle_lib')!
  const genTool = tools.write.find((t) => t.name === 'harbor_generate')!

  const s1 = await stTool.handler({}, {})
  assert.match(s1.content[0].text, /Current: detected, enabled=false/)

  const t1 = await toggleTool.handler({ key: 'UseCurrent', enabled: true }, {})
  assert.equal(t1.isError, undefined)
  assert.match(readFileSync(join(root, 'src', 'shared', 'Modules', 'LibsConfig.luau'), 'utf8'), /UseCurrent = true/)

  const g1 = await genTool.handler({ lib: 'current' }, {})
  assert.equal(g1.isError, undefined, g1.content[0].text)
  assert.match(g1.content[0].text, /compiled current schema/)
  assert.match(readFileSync(invokedLog, 'utf8'), /current-schema\.luau --yes/)
})
