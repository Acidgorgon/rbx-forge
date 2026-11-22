import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { FORBIDDEN_FCM_PLACE_ID, VANGUARDS_SETTINGS_KEYS } from '../src/shared/vanguardsTypes.ts'
import { detectVanguards } from '../src/main/services/vanguards/detect.ts'
import { VanguardsService } from '../src/main/services/vanguards/service.ts'
import { vanguardsTools } from '../src/main/services/vanguards/tools.ts'
import { findPythonCommand } from '../src/main/services/tools.ts'

const dirs: string[] = []
const services: VanguardsService[] = []

after(() => {
  for (const s of services) s.dispose()
  services.length = 0
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function temp(prefix = 'forge-vg-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

function makeFakeCli(binDir: string, name: string, nodeBody: string): void {
  const js = join(binDir, `${name}.mjs`)
  writeFileSync(js, nodeBody, 'utf8')
  if (process.platform === 'win32') {
    writeFileSync(join(binDir, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`, 'utf8')
  } else {
    const sh = join(binDir, name)
    writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, 'utf8')
    chmodSync(sh, 0o755)
  }
}

function makeSettings(init: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(init))
  return {
    get<T>(k: string, fb: T): T {
      return map.has(k) ? (map.get(k) as T) : fb
    },
    set(k: string, v: unknown): void {
      if (v === null || v === undefined) map.delete(k)
      else map.set(k, v)
    }
  }
}

test('detectVanguards finds custom binDir, fmDir scripts, and packsDir kits', () => {
  const root = temp()
  const binDir = join(root, 'bin')
  const fmDir = join(root, 'fm')
  const packsDir = join(root, 'packs')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(fmDir, { recursive: true })
  mkdirSync(join(packsDir, 'city-kit'), { recursive: true })

  makeFakeCli(binDir, 'ror', 'console.log("ror ok")')
  makeFakeCli(binDir, 'rur', 'console.log("rur ok")')
  makeFakeCli(binDir, 'ree', 'console.log("ree ok")')
  for (const s of ['envbuild.py', 'modelpreview.py', 'insert_rbxm.py', 'mcp_bridge.py']) {
    writeFileSync(join(fmDir, s), '# stub\n', 'utf8')
  }
  writeFileSync(join(packsDir, 'city-kit', 'road.rbxm'), 'stub', 'utf8')
  writeFileSync(join(packsDir, 'solo.rbxmx'), '<roblox/>', 'utf8')

  const st = detectVanguards({ binDir, fmDir, packsDir })
  assert.equal(st.binDir, binDir)
  assert.equal(st.fmDir, fmDir)
  assert.equal(st.packsDir, packsDir)
  assert.equal(st.tools.ror.found, true)
  assert.equal(st.tools.ror.source, 'configured')
  assert.equal(st.tools.rur.found, true)
  assert.equal(st.tools.ree.found, true)
  assert.equal(st.fmScripts.envbuild.found, true)
  assert.equal(st.fmScripts.modelpreview.found, true)
  assert.equal(st.fmScripts.insert_rbxm.found, true)
  assert.equal(st.fmScripts.mcp_bridge.found, true)
  assert.deepEqual(
    st.packs.map((p) => [p.name, p.files]),
    [
      ['city-kit', 1],
      ['solo.rbxmx', 1]
    ]
  )
})

test('VanguardsService injects ROR_BACKEND=dx12, ROR_MEMORY_FLOOR_GB=2, collects PNGs, and stops cleanly on dispose', async () => {
  const root = temp()
  const binDir = join(root, 'bin')
  const fmDir = join(root, 'fm')
  const outDir = join(root, 'out')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(fmDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })

  makeFakeCli(
    binDir,
    'ror',
    `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const envInfo = {
  backend: process.env.ROR_BACKEND,
  mem: process.env.ROR_MEMORY_FLOOR_GB,
  vg: process.env.VG_HOME,
  mcp: process.env.ROR_STUDIO_MCP || null
};
writeFileSync(${JSON.stringify(join(outDir, 'iso.png'))}, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
console.log(JSON.stringify({ argv: process.argv.slice(2), envInfo }));
`
  )
  makeFakeCli(binDir, 'rur', 'console.log(JSON.stringify({ mcp: process.env.RUR_STUDIO_MCP_PORT || null, argv: process.argv.slice(2) }));')
  makeFakeCli(binDir, 'ree', 'console.log("ree:" + process.argv.slice(2).join(","))')

  const settings = makeSettings({
    [VANGUARDS_SETTINGS_KEYS.binDir]: binDir,
    [VANGUARDS_SETTINGS_KEYS.fmDir]: fmDir,
    [VANGUARDS_SETTINGS_KEYS.packsDir]: join(root, 'packs')
  })

  const svc = new VanguardsService({ root: () => root, settings, defaultMcpPort: 17655 })
  services.push(svc)

  const rorRes = await svc.runRor({ args: ['render', 'scene.rbxl'], outDir })
  assert.equal(rorRes.ok, true, rorRes.stderr || rorRes.error)
  const parsed = JSON.parse(rorRes.stdout.trim())
  assert.equal(parsed.envInfo.backend, 'dx12')
  assert.equal(parsed.envInfo.mem, '2')
  assert.equal(parsed.envInfo.vg, root)
  assert.equal(parsed.envInfo.mcp, null)
  assert.ok(rorRes.images?.some((p) => p.endsWith('iso.png')))

  const reeRes = await svc.runRee({ args: ['test.luau'] })
  assert.equal(reeRes.ok, true)
  assert.match(reeRes.stdout, /ree:test\.luau/)

  // If Python is installed on this host, test mcp_bridge lifecycle + env injection too.
  if (findPythonCommand()) {
    writeFileSync(
      join(fmDir, 'mcp_bridge.py'),
      'import sys, time\nprint("bridge:" + (sys.argv[1] if len(sys.argv) > 1 else ""), flush=True)\ntime.sleep(30)\n',
      'utf8'
    )
    const bridgeSt = await svc.startMcpBridge(17655)
    assert.equal(bridgeSt.mcpBridge.running, true)
    assert.equal(bridgeSt.mcpBridge.port, 17655)

    const rurRes = await svc.runRur({ args: ['stories'] })
    assert.equal(rurRes.ok, true)
    const rurParsed = JSON.parse(rurRes.stdout.trim())
    assert.equal(rurParsed.mcp, '17655')

    const stopped = await svc.stopMcpBridge()
    assert.equal(stopped.mcpBridge.running, false)
  }

  svc.dispose()
})

test('fmInsertRbxm hard-refuses forbidden FCM place id 125988560196910 before spawning', async () => {
  const root = temp()
  const fmDir = join(root, 'fm')
  mkdirSync(fmDir, { recursive: true })
  const markerFile = join(root, 'should-not-exist.txt')
  writeFileSync(
    join(fmDir, 'insert_rbxm.py'),
    `open(${JSON.stringify(markerFile)}, 'w').write('ran')\n`,
    'utf8'
  )

  const svc = new VanguardsService({
    root: () => root,
    settings: makeSettings({ [VANGUARDS_SETTINGS_KEYS.fmDir]: fmDir }),
    resolveStudioPlaceId: async (sid) => (sid === 'fcm-studio' ? FORBIDDEN_FCM_PLACE_ID : 999999)
  })
  services.push(svc)

  const r1 = await svc.fmInsertRbxm({
    studioId: 'any-studio',
    filePath: 'final.rbxm',
    placeId: FORBIDDEN_FCM_PLACE_ID
  })
  assert.equal(r1.ok, false)
  assert.match(r1.error ?? '', /125988560196910/)

  const r2 = await svc.fmInsertRbxm({
    studioId: 'fcm-studio',
    filePath: 'final.rbxm'
  })
  assert.equal(r2.ok, false)
  assert.match(r2.error ?? '', /125988560196910/)
})

test('vanguardsTools expose status, runners with inline image markers, and insert refusal', async () => {
  const root = temp()
  const binDir = join(root, 'bin')
  const outDir = join(root, 'renders')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })

  makeFakeCli(
    binDir,
    'ror',
    `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(${JSON.stringify(join(outDir, 'preview.png'))}, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
console.log('rendered preview');
`
  )
  makeFakeCli(binDir, 'rur', 'console.log("story-list-ok")')

  const svc = new VanguardsService({
    root: () => root,
    settings: makeSettings({ [VANGUARDS_SETTINGS_KEYS.binDir]: binDir })
  })
  services.push(svc)

  const attached: { path: string; name: string }[] = []
  const tools = vanguardsTools(svc, {
    attachImage: async (absPath, name) => {
      attached.push({ path: absPath, name })
      return `[image:${name}]`
    }
  })

  const statusTool = tools.read.find((t) => t.name === 'vanguards_status')!
  const statusOut = await statusTool.handler({}, {})
  assert.match(statusOut.content[0].text, /ror: found/)

  const rorTool = tools.read.find((t) => t.name === 'ror_render')!
  const rorOut = await rorTool.handler({ args: ['render'], outDir }, {})
  assert.equal(rorOut.isError, undefined)
  assert.match(rorOut.content[0].text, /\[image:preview\.png\]/)
  assert.equal(attached.length, 1)

  const insertTool = tools.write.find((t) => t.name === 'fm_insert_rbxm')!
  const insOut = await insertTool.handler(
    { studioId: 'x', filePath: 'a.rbxm', placeId: FORBIDDEN_FCM_PLACE_ID },
    {}
  )
  assert.equal(insOut.isError, true)
  assert.match(insOut.content[0].text, /125988560196910/)
})
