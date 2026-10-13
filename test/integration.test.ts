// Integration wiring: the agent tool registry (every service tool reachable, unique names, JSON
// Schema), project rules injection into system prompts, orchestrator classification, feature
// rename, release fields in .forge/project.json, Lune active place, Blink generation, meter.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeContext } from './agentFake.ts'
import { gentreeTools, SPEC_TOOLS, toFunctionSpecs, WRITE_TOOLS } from '../src/main/agent/tools.ts'
import { createIntegrations } from '../src/main/integrations.ts'
import { buildRulesBlock, projectRulesLoader, RULES_CAP } from '../src/main/agent/projectRules.ts'
import { ChatManager } from '../src/main/agent/chat.ts'
import { TestAgentRunner } from '../src/main/agent/testAgents.ts'
import { Credentials } from '../src/main/agent/credentials.ts'
import type { QueryFn } from '../src/main/agent/sdk.ts'
import { classifyForgeTool, forgeWriteTargets } from '../src/main/agent/index.ts'
import { toolsForRole } from '../src/main/agent/orchestrator/roles.ts'
import { loopFor, openAiRunAgent } from '../src/main/agent/orchestrator/adapters.ts'
import { runOpenAiLoop } from '../src/main/agent/openaiLoop.ts'
import { runResponsesLoop } from '../src/main/agent/responsesLoop.ts'
import { renameFeature, rewriteReferences } from '../src/main/services/featureOps.ts'
import { readProjectConfig, writeProjectConfig, findSecretInConfig } from '../src/main/services/collab/config.ts'
import { buildSourcemap, discoverSpecs } from '../src/main/services/tests/rojoTree.ts'
import { BlinkWatcher } from '../src/main/services/blink.ts'
import { Meter } from '../src/main/agent/meter.ts'
import type { HarnessContext } from '../src/main/context.ts'

const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from('enc:' + s),
  decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
}

function withIntegrations(ctx: HarnessContext) {
  const store = new Map<string, unknown>()
  const integrations = createIntegrations({
    ctx,
    settings: { get: <T,>(k: string, f: T) => (store.has(k) ? (store.get(k) as T) : f), set: (k, v) => void store.set(k, v) },
    safeStorage: fakeSafe,
    userDataDir: join(tmpdir(), 'forge-int-test'),
    emit: ctx.emit,
    log: () => {},
    root: () => ctx.project()?.root ?? null,
    projectFile: () => null,
    projectName: () => 'Fake',
    packages: { search: async () => [], metadata: async () => ({ scope: 'a', name: 'b', latest: '1.0.0', versions: ['1.0.0'] }), addDep: async () => [] },
    git: () => null,
    studioConflicts: async () => [],
    pauseProjectWatch: () => {},
    resumeProjectWatch: () => {},
    services: () => [],
    startService: async () => {},
    stopService: async () => {},
    openExternal: () => {},
    choosePlaceFile: async () => null
  })
  ctx.serviceTools = () => integrations.serviceTools()
  return { integrations, store }
}

// ---------------------------------------------------------------- tool registry

test('every agent tool is reachable, uniquely named and converts to JSON Schema', () => {
  const fake = fakeContext()
  withIntegrations(fake.ctx)
  const all = gentreeTools(fake.ctx, { fs: fake.fs })
  const names = all.map((t) => t.name)
  assert.equal(new Set(names).size, names.length, `duplicate tool names: ${names.filter((n, i) => names.indexOf(n) !== i)}`)
  for (const expected of [
    'project_map', 'search_code', 'find_symbol',
    'blink_events', 'blink_check', 'add_blink_event',
    'wally_search', 'wally_info', 'add_wally_package',
    'run_tests', 'create_spec',
    'analytics_overview', 'analytics_series', 'analytics_compare', 'acquisition_report', 'analytics_instrument', 'analytics_status',
    'rename_feature'
  ]) assert.ok(names.includes(expected), `missing ${expected}`)
  for (const spec of toFunctionSpecs(all)) {
    assert.match(spec.function.name, /^[A-Za-z0-9_-]{1,64}$/)
    assert.equal(spec.function.parameters.type, 'object')
    assert.ok(spec.function.description.length > 10, spec.function.name)
    JSON.stringify(spec)
  }
})

test('read-only agents never get write tools; test agents also get create_spec', () => {
  const fake = fakeContext()
  withIntegrations(fake.ctx)
  const ro = gentreeTools(fake.ctx, { readOnly: true, fs: fake.fs }).map((t) => t.name)
  const tester = gentreeTools(fake.ctx, { readOnly: true, specs: true, fs: fake.fs }).map((t) => t.name)
  for (const w of [...WRITE_TOOLS, 'rename_feature']) {
    assert.ok(!ro.includes(w), `${w} leaked to read-only`)
    assert.ok(!tester.includes(w), `${w} leaked to test agents`)
  }
  assert.ok(ro.includes('run_tests') && !ro.includes('create_spec'))
  assert.ok(tester.includes('run_tests') && tester.includes(SPEC_TOOLS[0]))
  // The order is stable between calls (prompt-cache prefix).
  assert.deepEqual(gentreeTools(fake.ctx, { readOnly: true, fs: fake.fs }).map((t) => t.name), ro)
})

test('orchestrator: service write tools are admin, create_spec claims the spec file', () => {
  const fake = fakeContext()
  withIntegrations(fake.ctx)
  const all = gentreeTools(fake.ctx, { fs: fake.fs })
  for (const n of ['add_blink_event', 'add_wally_package', 'rename_feature']) assert.equal(classifyForgeTool(n), 'admin')
  assert.equal(classifyForgeTool('mcp__gentree__create_spec'), 'write')
  const scout = toolsForRole('scout', all, classifyForgeTool).map((t) => t.name)
  assert.ok(scout.includes('project_map') && scout.includes('analytics_overview'))
  assert.ok(!scout.some((n) => ['write_script', 'create_spec', 'add_blink_event', 'run_tests'].includes(n)))
  const tester = toolsForRole('tester', all, classifyForgeTool).map((t) => t.name)
  assert.ok(tester.includes('run_tests') && tester.includes('create_spec') && !tester.includes('write_script'))
  const builder = toolsForRole('builder', all, classifyForgeTool).map((t) => t.name)
  assert.ok(builder.includes('edit_script') && !builder.includes('add_wally_package') && !builder.includes('sync_collaborators'))
  assert.deepEqual(forgeWriteTargets('create_spec', { path: 'src/shared/Modules/Inventory.luau' }), ['src/shared/Modules/Inventory.spec.luau'])
  assert.deepEqual(forgeWriteTargets('create_spec', { path: 'src/server/Features/Shop/init.luau' }), ['src/server/Features/Shop/Shop.spec.luau'])
  assert.deepEqual(forgeWriteTargets('write_script', { path: 'src/a.luau' }), ['src/a.luau'])
})

test('orchestrator OpenAI adapter picks the Responses loop and normalizes raw usage', async () => {
  assert.equal(loopFor({ provider: 'openai', model: 'gpt-6.1-sol' }), runResponsesLoop as unknown)
  assert.equal(loopFor({ provider: 'openai', model: 'gpt-6-luna' }), runOpenAiLoop as unknown)
  assert.equal(loopFor({ provider: 'gemini', model: 'gemini-3.8-flash' }), runOpenAiLoop as unknown)
  const events: any[] = []
  const run = openAiRunAgent({
    endpoint: async () => ({ baseUrl: 'http://x' }),
    loop: async (o) => {
      o.onUsage?.({ prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } })
      return { outcome: 'done' }
    }
  })
  for await (const e of run({ runId: 'r', taskId: 't', role: 'scout', model: 'm', system: 's', prompt: 'p', tools: [], maxTurns: 1, signal: new AbortController().signal })) events.push(e)
  assert.deepEqual(events[0], { type: 'usage', usage: { input: 20, output: 30, cacheRead: 100, cacheWrite: 0 } })
})

// ---------------------------------------------------------------- project rules

test('rules block: aiRules first, capped with a truncation note', () => {
  assert.equal(buildRulesBlock({}), '')
  const block = buildRulesBlock({ aiRules: 'Never change prices.', agentsMd: 'x'.repeat(5000) })
  assert.ok(block.length <= RULES_CAP)
  assert.match(block, /Team rules \(\.forge\/project\.json aiRules\)\nNever change prices\./)
  assert.match(block, /truncated; read AGENTS\.md/)
  assert.ok(block.indexOf('Never change prices') < block.indexOf('AGENTS.md'))
})

test('aiRules and AGENTS.md reach the chat and test-agent system prompts', async () => {
  const fake = fakeContext({ files: { '.forge/project.json': JSON.stringify({ aiRules: 'RULE-42: keep remotes in events.blink' }), 'AGENTS.md': '# Agents\nUse tabs.' } })
  const rules = projectRulesLoader(fake.ctx)
  assert.match(await rules(), /RULE-42/)
  const seen: any[] = []
  const queryFn: QueryFn = (params) => {
    seen.push(params.options)
    return (async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's' } as any
    })()
  }
  const credentials = new Credentials(fake.ctx, async () => null, { ANTHROPIC_API_KEY: 'sk-env' })
  const chats = new ChatManager(fake.ctx, { queryFn, credentials, rules, makeServer: () => ({ type: 'stdio', command: 'none' }) })
  const chat = chats.create()
  await chats.send(chat.id, 'hi')
  while (chats.busy(chat.id)) await new Promise((r) => setTimeout(r, 5))
  assert.match(seen[0].systemPrompt, /GenTree dev harness[\s\S]*RULE-42[\s\S]*Use tabs\./)

  const agents = new TestAgentRunner(fake.ctx, { queryFn, credentials, rules, makeServer: () => ({ type: 'stdio', command: 'none' }) })
  agents.run(['buy a sword'], { provider: 'anthropic', model: 'claude-haiku-5-5' })
  await agents.idle()
  assert.match(seen[1].systemPrompt, /run_tests[\s\S]*RULE-42/)
})

// ---------------------------------------------------------------- feature rename

async function featureProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forge-feature-'))
  const put = async (rel: string, text: string) => {
    await mkdir(join(root, rel, '..'), { recursive: true })
    await writeFile(join(root, rel), text)
  }
  await put('src/shared/Features/Shop/Config.luau', 'return { MaxTier = 3 }\n')
  await put('src/server/Features/Shop/init.luau', 'local Config = require(game.ReplicatedStorage.Shared.Features.Shop.Config)\nreturn {}\n')
  await put('src/client/Client/Controllers/ShopController.luau', 'local ShopController = {}\nreturn ShopController\n')
  await put('src/client/UI/ShopFrame.luau', 'local c = require(script.Parent.Parent.Client.Controllers.ShopController)\nlocal f = Features:WaitForChild("Shop")\n')
  await put('src/shared/Features/Shopping/Config.luau', 'return {}\n')
  return root
}

test('renameFeature moves all counterparts, rewrites references and pauses watchers', async () => {
  const root = await featureProject()
  const calls: string[] = []
  try {
    const r = await renameFeature(root, 'Shop', 'Store', {
      devRunning: () => true,
      stopDev: async () => void calls.push('stopDev'),
      startDev: async () => void calls.push('startDev'),
      pauseProjectWatch: () => void calls.push('pause'),
      resumeProjectWatch: () => void calls.push('resume')
    })
    assert.deepEqual(calls, ['pause', 'stopDev', 'resume', 'startDev'])
    assert.deepEqual(r.moved.map((m) => m.to).sort(), ['src/client/Client/Controllers/StoreController.luau', 'src/server/Features/Store', 'src/shared/Features/Store'])
    assert.ok(existsSync(join(root, 'src/shared/Features/Store/Config.luau')))
    assert.ok(existsSync(join(root, 'src/shared/Features/Shopping')), 'a feature with a longer name is untouched')
    assert.ok(!existsSync(join(root, 'src/server/Features/Shop')))
    assert.match(await readFile(join(root, 'src/server/Features/Store/init.luau'), 'utf8'), /Features\.Store\.Config/)
    const ui = await readFile(join(root, 'src/client/UI/ShopFrame.luau'), 'utf8')
    assert.match(ui, /Controllers\.StoreController/)
    assert.match(ui, /WaitForChild\("Store"\)/)
    assert.ok(r.updated.includes('src/client/Client/Controllers/StoreController.luau'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('renameFeature refuses a taken name without moving anything', async () => {
  const root = await featureProject()
  try {
    await mkdir(join(root, 'src/server/Features/Store'), { recursive: true })
    await assert.rejects(renameFeature(root, 'Shop', 'Store'), /already exists/)
    assert.ok(existsSync(join(root, 'src/shared/Features/Shop')))
    await assert.rejects(renameFeature(root, 'Shop', 'store'), /PascalCase/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  assert.equal(rewriteReferences('Features.Shopping', 'Shop', 'Store'), null)
})

// ---------------------------------------------------------------- .forge/project.json

test('.forge/project.json keeps release fields and refuses secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-cfg-'))
  try {
    const written = await writeProjectConfig(root, { aiRules: 'x', version: '1.2.3', publish: { mode: 'studio', placeId: 42 }, extra: { keep: true } })
    assert.equal((written as any).version, '1.2.3')
    const read = await readProjectConfig(root)
    assert.equal((read.config as any).publish.placeId, 42)
    assert.deepEqual((read.config as any).extra, { keep: true })
    await assert.rejects(writeProjectConfig(root, { aiRules: 'post to https://discord.com/api/webhooks/123/abc' }), /Discord webhook/)
    await assert.rejects(writeProjectConfig(root, { publish: { mode: 'studio' }, apiKey: 'x' }), /secret/)
    assert.equal(findSecretInConfig({ aiRules: 'the apiKey: field is documented elsewhere' }), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- Lune: active place

test('Lune sourcemap uses the active place project file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-places-'))
  try {
    await mkdir(join(root, 'src/menu'), { recursive: true })
    await mkdir(join(root, 'src/game'), { recursive: true })
    await writeFile(join(root, 'src/menu/Menu.spec.luau'), 'return nil')
    await writeFile(join(root, 'src/game/Game.spec.luau'), 'return nil')
    const project = (dir: string) => JSON.stringify({ name: dir, tree: { $className: 'DataModel', ReplicatedStorage: { $className: 'ReplicatedStorage', Code: { $path: `src/${dir}` } } } })
    await writeFile(join(root, 'default.project.json'), project('game'))
    await writeFile(join(root, 'menu.project.json'), project('menu'))
    assert.deepEqual(discoverSpecs(await buildSourcemap(root)).map((s) => s.file), ['src/game/Game.spec.luau'])
    assert.deepEqual(discoverSpecs(await buildSourcemap(root, 'menu.project.json')).map((s) => s.file), ['src/menu/Menu.spec.luau'])
    // Anything that is not a root *.project.json falls back to the default place.
    assert.deepEqual(discoverSpecs(await buildSourcemap(root, '../x.project.json')).map((s) => s.file), ['src/game/Game.spec.luau'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- Blink generation

test('BlinkWatcher generates outputs for entries the dev loop does not handle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-blinkgen-'))
  const event = (n: string) => `event ${n} {\n    From: Server,\n    Type: Reliable,\n    Call: ManyAsync\n}\n`
  await writeFile(join(root, 'events.blink'), event('A'))
  await writeFile(join(root, 'menu.blink'), event('B'))
  const generated: string[] = []
  const watcher = new BlinkWatcher({
    root,
    debounceMs: 10,
    log: () => {},
    onChange: () => {},
    check: async () => ({ ok: true, diagnostics: [], version: '0.17.0' }),
    generate: (entry) => entry !== 'events.blink',
    generator: async (_root, entry) => {
      generated.push(entry)
      return { ok: true }
    }
  })
  try {
    await watcher.start()
    assert.deepEqual(generated, ['menu.blink'])
  } finally {
    watcher.close()
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- meter

test('meter records usage per chat, emits snapshots and stores budgets', () => {
  const fake = fakeContext()
  const meter = new Meter(fake.ctx, { saveDelayMs: 0 })
  meter.ledger.recordOpenAi({ prompt_tokens: 1000, completion_tokens: 200 }, { provider: 'openai', model: 'gpt-6-luna', chatId: 'c1' })
  const snap = meter.snapshot('chat', 'c1')
  assert.equal(snap.totals.requests, 1)
  assert.equal(snap.totals.output, 200)
  assert.equal(snap.budget?.level, 'ok')
  assert.ok(fake.events.some((e) => e.event === 'usage:changed' && e.payload.id === 'c1'))
  const limits = meter.setLimits({ chatMaxCostUsd: 0.000001, bogus: 5 } as any)
  assert.equal(limits.chatMaxCostUsd, 0.000001)
  assert.equal((fake.settings.get('budget') as any).bogus, undefined)
  assert.equal(meter.checkChat('c1').level, 'stop')
})
