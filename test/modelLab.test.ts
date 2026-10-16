// Model Lab: the kit API read from BlockyKit.luau, the prompts and answer parsing, the Lune sandbox
// output parser and build checks, the preview framing, the Studio job (200k Source limit), the
// plugin's model job, the library store, the wiring vs the preload list, and ModelService end to end
// with a fake model, a fake Lune run, a fake capture and a fake Forge Bridge.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { kitApi, kitApiText, systemPrompt, composePrompt, criticPrompt, extractScript, parseCritic, modelName, NO_CHANGES, PART_BUDGET, MAX_SCRIPT_CHARS, STYLE_RULES } from '../src/shared/model/prompt.ts'
import { parseBuildOutput, parseBuildError, buildWarnings } from '../src/shared/model/checks.ts'
import { partBounds, displayOffset, viewCamera, visibleParts, CRITIC_VIEWS } from '../src/shared/model/frame.ts'
import { modelJob, assertModuleSizes, guardPath, parseBuiltLog, ModuleTooLargeError, SOURCE_LIMIT, sourceLength, KIT_MODULE, BUILD_MODULE, MODEL_PLUGIN_VERSION } from '../src/shared/model/job.ts'
import type { ModelPart, ModelStats } from '../src/shared/model/types.ts'
import { PLUGIN_VERSION } from '../src/shared/studio/plugin.ts'
import { BridgeError } from '../src/main/services/studio/bridge.ts'
import { ModelStore, modelId } from '../src/main/services/model/store.ts'
import { findModelAssets, modelAssetCandidates } from '../src/main/services/model/lune.ts'
import { ModelService, decodeDataUrl, type ModelBridge, type ModelCaptureRequest, type ModelFn } from '../src/main/services/model/service.ts'
import { createModelWiring } from '../src/main/services/model/wire.ts'
import type { BridgeEvent, BridgeJob } from '../src/shared/studio/protocol.ts'

const ROOT = resolve(import.meta.dirname, '..')
const KIT = readFileSync(join(ROOT, 'resources/lune/BlockyKit.luau'), 'utf8')
const TEMPLATE = (id: string) => readFileSync(join(ROOT, 'resources/lune/model_templates', `${id}.luau`), 'utf8')
const PNG = 'data:image/png;base64,' + Buffer.from('\x89PNG\r\n\x1a\nfake').toString('base64')

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1]
const part = (x: number, y: number, z: number, s: [number, number, number] = [1, 1, 1], extra: Partial<ModelPart> = {}): ModelPart => ({ n: 'P', k: 'P', s, cf: [x, y, z, ...I], c: [0.5, 0.5, 0.5], ...extra })
const STATS: ModelStats = { motors: 2, welds: 0, weldConstraints: 10, attachments: 0, animators: 1, animationControllers: 1, humanoids: 0, anchored: 1, instances: 20, assemblies: 1, loose: 0, primaryPart: 'Root' }

// ------------------------------------------------------------ prompt

test('kitApi reads every Kit function with its doc comment from BlockyKit.luau', () => {
  const api = kitApi(KIT)
  const names = api.map((f) => f.name)
  for (const n of ['new', 'part', 'motor', 'spine', 'body', 'horn', 'spike', 'jaw', 'tooth', 'limb', 'bevel', 'voxelEgg', 'wireGuard']) assert.ok(names.includes(n), `kit API lists ${n}`)
  const body = api.find((f) => f.name === 'body')!
  assert.match(body.signature, /^Kit:body\(/)
  assert.ok(body.doc.length > 20, 'body has its doc comment')
  const text = kitApiText(KIT)
  assert.match(text, /- Kit:voxelEgg\(/)
  // A section header ("─── Rings ───") ends a doc block instead of leaking into it.
  assert.ok(!api.some((f) => /─/.test(f.doc)))
})

test('the system prompt carries the contract, the style rules, the kit API and the template', () => {
  const s = systemPrompt({ kitSource: KIT, template: 'guard', templateScript: 'return function(model, ctx) end' })
  assert.match(s, /require\(script\.Parent\.BlockyKit\)/)
  assert.ok(s.includes(STYLE_RULES))
  for (const rule of [/sin\(angle\)/, /groove/i, /never flat/, /45-degree diamonds/, /segmented/i, /bevel/i, /same-colour runs/, /Motor6D/, /AnimationController/, new RegExp(String(PART_BUDGET))]) assert.match(s, rule)
  assert.match(s, /Kit:wireGuard\(/)
  assert.match(s, /A working guard script/)
  assert.match(s, /no game, workspace/)
  const p = composePrompt({ prompt: 'ice wolf', template: 'guard', refs: 2, current: 'local Kit = 1' })
  assert.match(p, /Make: ice wolf/)
  assert.match(p, /2 reference images attached/)
  assert.match(p, /Start from the current script/)
})

test('extractScript takes the last script fence; parseCritic reads notes and NO CHANGES', () => {
  const answer = 'Built a shark.\n```lua\nlocal x = 1\n```\nand\n```lua\nlocal Kit = require(script.Parent.BlockyKit)\nreturn function(model, ctx) end\n```'
  assert.equal(extractScript(answer), 'local Kit = require(script.Parent.BlockyKit)\nreturn function(model, ctx) end\n')
  assert.equal(extractScript('no code here'), null)
  assert.match(extractScript('local Kit = require(script.Parent.BlockyKit)\nreturn function(model) end')!, /^local Kit/)
  const kept = parseCritic(`${NO_CHANGES}\nIt matches the reference.`)
  assert.equal(kept.noChange, true)
  assert.equal(kept.script, null)
  assert.match(kept.summary, /matches/)
  const revised = parseCritic('- bigger spikes\n- darker top\n```lua\nreturn function(model, ctx) end\n```')
  assert.equal(revised.noChange, false)
  assert.equal(revised.summary, 'bigger spikes; darker top')
  assert.ok(revised.script)
  assert.equal(modelName('a spiky shark guard with fins'), 'Spiky Shark Guard Fins')
  assert.equal(modelName('!!'), 'Block Model')
})

test('criticPrompt names the views, the references and the build checks', () => {
  const build = { ok: true, parts: [part(0, 0, 0)], stats: { ...STATS, loose: 3 }, prints: [], warnings: ['3 parts are not welded'] }
  const p = criticPrompt({ prompt: 'shark', template: 'creature', views: ['front', 'side', 'back'], refs: 2, script: 'return function() end', build, round: 1, rounds: 2 })
  assert.match(p, /Critic round 1 of 2/)
  assert.match(p, /first 3 images/)
  assert.match(p, /last 2 are the user's reference images/)
  assert.match(p, /3 loose parts/)
  assert.match(p, new RegExp(NO_CHANGES))
})

// ------------------------------------------------------------ checks

test('parseBuildOutput reads the sandbox JSON line; errors keep their build line', () => {
  const line = JSON.stringify({ ok: true, name: 'Shark', parts: [{ n: 'Root', k: 'P', s: [1, 1, 1], cf: [0, 0, 0, ...I], c: [1, 0, 0], t: 1, a: true }, { n: 'W', k: 'W', s: [1, 2, 3], cf: [1, 2, 3, ...I], c: [0, 1, 0], m: 'Neon' }], stats: STATS, prints: ['hi'] })
  const b = parseBuildOutput(`noise\n${line}\n`, '', 0)
  assert.equal(b.ok, true)
  assert.equal(b.parts.length, 2)
  assert.equal(b.parts[0].a, true)
  assert.equal(b.parts[1].m, 'Neon')
  assert.deepEqual(b.prints, ['hi'])
  assert.deepEqual(b.warnings, [])
  const bad = parseBuildOutput(JSON.stringify({ ok: false, parts: [], prints: [], error: { message: '[string "build"]:12: attempt to index nil' } }), '', 1)
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.error, { line: 12, message: 'attempt to index nil' })
  assert.equal(parseBuildOutput('', 'boom', 1).error?.message, 'boom')
  assert.deepEqual(parseBuildError('[string "build"]:3: syntax error: Expected identifier'), { line: 3, message: 'Expected identifier' })
})

test('buildWarnings flags the budget, loose parts, a missing root and a missing animator', () => {
  const many = Array.from({ length: PART_BUDGET + 1 }, (_, i) => part(i, 0, 0))
  assert.match(buildWarnings(many, STATS).join('|'), /over the ~2500 budget/)
  const w = buildWarnings([part(0, 0, 0)], { ...STATS, primaryPart: undefined, loose: 2, anchored: 0, animators: 0 })
  assert.match(w.join('|'), /PrimaryPart is not set/)
  assert.match(w.join('|'), /2 parts are not welded/)
  assert.match(w.join('|'), /nothing is anchored/)
  assert.match(w.join('|'), /no AnimationController/)
  assert.deepEqual(buildWarnings([], STATS), ['the script made no parts'])
})

// ------------------------------------------------------------ framing

test('partBounds covers rotated boxes; the display offset stands the model on y = 0', () => {
  const s = Math.SQRT1_2
  // A 2 x 2 x 2 box rotated 45 degrees about Y reaches sqrt(2) along X and Z.
  const rotated: ModelPart = { n: 'R', k: 'P', s: [2, 2, 2], cf: [0, 5, 0, s, 0, s, 0, 1, 0, -s, 0, s], c: [1, 1, 1] }
  const b = partBounds([rotated])!
  assert.ok(Math.abs(b.max[0] - Math.SQRT2) < 1e-9)
  assert.equal(b.min[1], 4)
  assert.deepEqual(displayOffset(b).map((v) => Math.round(v * 1e9) / 1e9 + 0), [0, -4, 0])
  assert.equal(partBounds([]), null)
  assert.equal(visibleParts([part(0, 0, 0, [1, 1, 1], { t: 1 }), part(0, 0, 0)]).length, 1)
  assert.deepEqual(CRITIC_VIEWS, ['front', 'side', 'back'])
})

test('viewCamera looks at the model from its front (-Z) and fits it in the frame', () => {
  const b = partBounds([part(0, 2, 0, [4, 4, 12])])!
  const front = viewCamera(b, 'front', 40, 4 / 3)
  assert.ok(front.pos[2] < 0, 'the front view sits on the -Z side')
  const back = viewCamera(b, 'back', 40, 4 / 3)
  assert.ok(back.pos[2] > 0)
  const dist = Math.hypot(front.pos[0] - front.target[0], front.pos[1] - front.target[1], front.pos[2] - front.target[2])
  assert.ok(dist > 6 && dist < 60, `distance ${dist}`)
  assert.equal(front.target[1], 2)
})

// ------------------------------------------------------------ Studio job

test('modelJob ships BlockyKit and the build as two modules and refuses a Source of 200k+', () => {
  const job = modelJob({ id: 'j1', name: 'Ice Wolf! <3', kit: KIT, script: 'return function() end', guard: guardPath('game.Workspace.Guards.Wolf'), areaId: 'Area2' })
  assert.equal(job.kind, 'model')
  assert.equal(job.entry, BUILD_MODULE)
  assert.deepEqual(job.modules.map((m) => m.name), [KIT_MODULE, BUILD_MODULE])
  assert.equal(job.name, 'Ice Wolf 3')
  assert.deepEqual(job.model, { guard: ['Workspace', 'Guards', 'Wolf'], areaId: 'Area2' })
  assert.equal(modelJob({ id: 'j2', name: '', kit: 'k', script: 's' }).model, undefined)
  assert.equal(modelJob({ id: 'j2', name: '', kit: 'k', script: 's' }).name, 'BlockModel')
  assert.ok(sourceLength(KIT) < SOURCE_LIMIT, 'the kit itself fits in one ModuleScript')
  assert.throws(() => modelJob({ id: 'j3', name: 'Big', kit: KIT, script: 'x'.repeat(SOURCE_LIMIT) }), (e: Error) => e instanceof ModuleTooLargeError && /the build script is 200,000 characters/.test(e.message) && /Shorten it/.test(e.message))
  // Bytes, not UTF-16 units: 100k two-byte characters are 200k bytes.
  assert.throws(() => assertModuleSizes([{ name: 'Build', className: 'ModuleScript', source: 'é'.repeat(100_000) }]), ModuleTooLargeError)
  assert.deepEqual(guardPath('  Workspace . A..B '), ['Workspace', 'A', 'B'])
  assert.deepEqual(parseBuiltLog('{"built":"Wolf","parts":512,"path":"Workspace.Wolf"}'), { name: 'Wolf', parts: 512, path: 'Workspace.Wolf' })
  assert.equal(parseBuiltLog('not json'), null)
  assert.equal(parseBuiltLog('{"other":1}'), null)
})

test('the Forge Bridge plugin (v10) runs model jobs into Workspace and selects them', () => {
  const src = readFileSync(join(ROOT, 'resources/studio/ForgeBridge.luau'), 'utf8')
  // Model jobs arrived in v10; later plugins keep them.
  assert.ok(PLUGIN_VERSION >= MODEL_PLUGIN_VERSION, `PLUGIN_VERSION ${PLUGIN_VERSION} < ${MODEL_PLUGIN_VERSION}`)
  assert.match(src, new RegExp(`-- forge-bridge-template: ${PLUGIN_VERSION}\\b`))
  assert.match(src, /local function runModelJob\(job: any\)/)
  assert.match(src, /answer\.job\.kind == "model" then\s+runModelJob\(answer\.job\)/)
  const body = src.slice(src.indexOf('local function runModelJob'))
  assert.match(body, /\.Parent = workspace/)
  assert.match(body, /GetService\("Selection"\):Set\(\{ model \}\)/)
  assert.match(body, /ChangeHistoryService/)
})

// ------------------------------------------------------------ store

test('ModelStore saves, lists, reads files and refuses paths outside an entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-model-store-'))
  try {
    const store = new ModelStore(dir)
    assert.match(modelId('Ice Wolf!'), /^ice-wolf-[0-9a-f]{6}$/)
    assert.notEqual(modelId('Egg'), modelId('Egg'))
    const now = Date.now()
    await store.save({ id: 'wolf', name: 'Wolf', prompt: 'p', template: 'guard', script: 's', parts: 3, refs: [], origin: 'ai', createdAt: now, updatedAt: now })
    await store.save({ id: 'egg', name: 'Egg', prompt: 'p', template: 'egg', script: 's', parts: 3, refs: [], origin: 'ai', createdAt: now, updatedAt: now + 5 })
    assert.deepEqual((await store.list()).map((e) => e.id), ['egg', 'wolf'])
    await store.writeFile('wolf', 'frames/r1-front.png', Buffer.from('x'))
    assert.equal((await store.readFile('wolf', 'frames/r1-front.png')).toString(), 'x')
    await assert.rejects(() => store.readFile('wolf', '../egg/entry.json'))
    assert.equal(await store.remove('wolf'), true)
    assert.equal(await store.read('wolf'), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------ wiring

test('every ModelApi method in the preload has a handler', () => {
  const preload = readFileSync(join(ROOT, 'src/preload/index.ts'), 'utf8')
  const names = [...preload.matchAll(/'(model[A-Z]\w*)'/g)].map((m) => m[1])
  const w = createModelWiring({ userDataDir: tmpdir(), root: () => null, settings: { get: (_k, d) => d, set: () => undefined }, emit: () => undefined })
  assert.deepEqual([...names].sort(), Object.keys(w.handlers).sort())
  assert.equal(names.length, 14)
})

test('the Model Lab files are found next to the bundle or in resources/lune', () => {
  const a = findModelAssets([join(tmpdir(), 'nope'), join(ROOT, 'resources/lune')])!
  assert.equal(a.dir, join(ROOT, 'resources/lune'))
  for (const t of ['creature', 'guard', 'egg']) assert.ok(existsSync(join(a.templates, `${t}.luau`)), t)
  assert.ok(modelAssetCandidates('/x/out/main')[0].endsWith(join('out', 'main', 'model')))
})

// ------------------------------------------------------------ service

interface Fake {
  svc: ModelService
  dir: string
  calls: { system: string; prompt: string; images: number; tier: string }[]
  captures: ModelCaptureRequest[]
  events: { event: string; payload: any }[]
  settings: Map<string, unknown>
  jobs: BridgeJob[]
}

// The fake Lune "builds" a script into parts: `-- parts: N` sets the count, `error("x")` fails at its line.
function fakeLune(lune: string, args: string[]) {
  const script = readFileSync(args[3], 'utf8')
  const bad = /error\("([^"]+)"\)/.exec(script)
  if (bad) {
    const line = script.slice(0, bad.index).split('\n').length
    return Promise.resolve({ code: 1, stdout: JSON.stringify({ ok: false, parts: [], prints: [], error: { message: `[string "build"]:${line}: ${bad[1]}` } }) + '\n', stderr: '' })
  }
  const n = Number(/-- parts: (\d+)/.exec(script)?.[1] ?? 12)
  const parts = [{ n: 'Root', k: 'P', s: [2, 2, 2], cf: [0, 1, 0, ...I], c: [1, 1, 1], t: 1, a: true }, ...Array.from({ length: n - 1 }, (_, i) => ({ n: 'Plate', k: 'P', s: [1, 1, 1], cf: [i, 1, 0, ...I], c: [0.3, 0.4, 0.5] }))]
  assert.equal(lune, '/fake/lune')
  return Promise.resolve({ code: 0, stdout: JSON.stringify({ ok: true, name: args[4], parts, stats: STATS, prints: [] }) + '\n', stderr: '' })
}

const script = (n: number, note = '') => `local Kit = require(script.Parent.BlockyKit)\n-- parts: ${n}${note}\nreturn function(model, ctx)\nend\n`
const fence = (code: string, notes = 'Built it.') => `${notes}\n\`\`\`lua\n${code}\`\`\``

async function fake(opts: { answers?: ((system: string, prompt: string) => string)[]; model?: boolean; capture?: boolean; bridge?: Partial<ModelBridge> & { version?: number } } = {}): Promise<Fake> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-model-svc-'))
  const calls: Fake['calls'] = []
  const captures: ModelCaptureRequest[] = []
  const events: Fake['events'] = []
  const settings = new Map<string, unknown>()
  const jobs: BridgeJob[] = []
  const answers = [...(opts.answers ?? [])]
  let t = 1_000_000
  const model = (tier: string): ModelFn => async (system, prompt, images) => {
    calls.push({ system, prompt, images: images.length, tier })
    const next = answers.shift()
    if (!next) throw new Error('no more answers')
    return next(system, prompt)
  }
  const b = opts.bridge
  const bridge: ModelBridge | null = b
    ? {
        connected: () => true,
        studio: () => ({ place: 'Obby', pluginVersion: b.version ?? 10 }),
        busy: () => null,
        run:
          b.run ??
          (async (job: BridgeJob, handler: (ev: BridgeEvent, at: number) => unknown) => {
            jobs.push(job)
            handler({ type: 'accepted' }, 0)
            handler({ type: 'log', message: JSON.stringify({ built: job.name, parts: 42, path: `Workspace.${job.name}` }) }, 0)
            handler({ type: 'done', marks: [] }, 0)
          }),
        ...b
      }
    : null
  const svc = new ModelService({
    userDir: dir,
    projectRoot: () => null,
    lune: async () => ({ path: '/fake/lune', version: '0.10.4' }),
    assets: () => findModelAssets([join(ROOT, 'resources/lune')]),
    luneRun: fakeLune,
    ...(opts.model === false ? {} : { model: (tier) => model(tier) }),
    modelReady: async () => opts.model !== false,
    ...(opts.capture === false
      ? {}
      : {
          capture: async (req) => {
            captures.push(req)
            return req.views.map((v) => Buffer.from(`png-${v}`))
          }
        }),
    bridge: () => bridge,
    settings: { get: <T>(k: string, d: T) => (settings.has(k) ? (settings.get(k) as T) : d), set: (k, v) => void settings.set(k, v) },
    emit: (event, payload) => void events.push({ event, payload }),
    now: () => (t += 1000)
  })
  return { svc, dir, calls, captures, events, settings, jobs }
}

test('generate: AI script -> preview build -> critic rounds with snapshots and references', async () => {
  const f = await fake({
    answers: [
      () => fence(script(30)),
      () => fence(script(40, ' v2'), '- bigger dorsal spikes\n- darker top plates'),
      () => `${NO_CHANGES}\nIt matches the references now.`
    ]
  })
  try {
    const r = await f.svc.generate('a plated shark', { template: 'creature', refs: [PNG, PNG], run: 'r1' })
    assert.equal(r.source, 'model')
    assert.equal(r.build.ok, true)
    assert.equal(r.build.parts.length, 40, 'the critic revision is the result')
    assert.equal(r.entry.parts, 40)
    assert.match(r.entry.script, /v2/)
    assert.equal(r.entry.refs.length, 2)
    assert.equal(r.entry.origin, 'ai')
    // Writing: the system prompt has the kit and the template; the references go along.
    assert.match(f.calls[0].system, /Kit:voxelEgg\(/)
    assert.match(f.calls[0].system, /A working creature script/)
    assert.equal(f.calls[0].images, 2)
    assert.equal(f.calls[0].tier, 'default')
    // Critic: 3 snapshots + 2 references, on the critic tier; round 2 kept the model and stopped.
    assert.equal(f.calls[1].images, 5)
    assert.equal(f.calls[1].tier, 'critic')
    assert.match(f.calls[1].prompt, /Critic round 1 of 2/)
    assert.equal(f.captures.length, 2)
    assert.deepEqual(f.captures[0].views, ['front', 'side', 'back'])
    assert.equal(f.captures[0].parts.length, 30)
    assert.equal(f.captures[1].parts.length, 40)
    const rounds = r.entry.critic!
    assert.equal(rounds.length, 2)
    assert.equal(rounds[0].changed, true)
    assert.equal(rounds[0].summary, 'bigger dorsal spikes; darker top plates')
    assert.deepEqual(rounds[0].frames, ['frames/r1-front.png', 'frames/r1-side.png', 'frames/r1-back.png'])
    assert.equal(rounds[1].changed, false)
    assert.match(rounds[1].summary, /matches/)
    const stored = await f.svc.library().readFile(r.entry.id, 'frames/r1-side.png')
    assert.equal(stored.toString(), 'png-side')
    // Progress for this run, ending in done; the saved entry lists.
    const phases = f.events.filter((e) => e.event === 'model:progress' && e.payload.run === 'r1').map((e) => e.payload.phase)
    assert.deepEqual([phases[0], phases.at(-1)], ['writing', 'done'])
    assert.ok(phases.includes('critic'))
    assert.deepEqual((await f.svc.list()).map((e) => e.id), [r.entry.id])
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('generate repairs a script that does not build, and respects the critic switch', async () => {
  const f = await fake({ answers: [() => fence('local Kit = require(script.Parent.BlockyKit)\nreturn function(model, ctx)\n\terror("bad plate")\nend\n'), (_s, prompt) => (assert.match(prompt, /failed: bad plate \(line 3: error\("bad plate"\)\)/), fence(script(20)))] })
  try {
    f.svc.setSettings({ critic: false })
    const r = await f.svc.generate('an egg', { template: 'egg' })
    assert.equal(r.build.ok, true)
    assert.equal(r.entry.parts, 20)
    assert.equal(f.calls.length, 2)
    assert.equal(f.captures.length, 0, 'critic off: no snapshots')
    assert.equal(r.entry.critic, undefined)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('generate falls back to the template without a model or when the model fails', async () => {
  const none = await fake({ model: false })
  try {
    const r = await none.svc.generate('pig egg', { template: 'egg' })
    assert.equal(r.source, 'template')
    assert.equal(r.entry.script, TEMPLATE('egg'))
    assert.match(r.notes.join(' '), /No AI model is set up/)
    assert.equal(r.entry.origin, 'template')
  } finally {
    await rm(none.dir, { recursive: true, force: true })
  }
  const broken = await fake({ answers: [() => 'I cannot do that', () => 'still no code', () => 'nope'] })
  try {
    const r = await broken.svc.generate('ice wolf', { template: 'guard' })
    assert.equal(r.source, 'template')
    assert.equal(r.entry.script, TEMPLATE('guard'))
    assert.match(r.entry.modelError ?? '', /did not build \(there was no ```lua script/)
    assert.equal(broken.calls.length, 3, 'one ask and two repairs')
  } finally {
    await rm(broken.dir, { recursive: true, force: true })
  }
})

test('generate refuses images that are not PNG / JPEG / WebP / GIF data URLs', async () => {
  const f = await fake({ answers: [] })
  try {
    await assert.rejects(() => f.svc.generate('shark', { refs: ['data:text/plain;base64,aGk='] }), /PNG, JPEG, WebP or GIF/)
    assert.equal(decodeDataUrl('data:image/jpeg;base64,AAAA')?.ext, 'jpg')
    assert.equal(decodeDataUrl('https://example.com/a.png'), null)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('templates, edits, rename, thumbnails, settings and delete', async () => {
  const f = await fake()
  try {
    const t = await f.svc.fromTemplate('creature', { name: 'Shark' })
    const id = t.entry.id
    assert.match(id, /^shark-/)
    assert.equal(t.entry.origin, 'template')
    assert.equal(t.build.ok, true)
    // load() uses the cached build; an edited script rebuilds.
    const loaded = await f.svc.load(id)
    assert.equal(loaded.build.parts.length, t.build.parts.length)
    const edited = await f.svc.save(id, { script: script(7) })
    assert.equal(edited.entry.origin, 'edit')
    assert.equal(edited.entry.parts, 7)
    const failing = await f.svc.save(id, { script: 'return function()\n error("nope")\nend' })
    assert.equal(failing.build.ok, false)
    assert.equal(failing.entry.error, 'line 2: nope')
    assert.equal(failing.entry.parts, 7, 'the last good part count stays')
    const renamed = await f.svc.rename(id, '  Great Shark ')
    assert.equal(renamed.name, 'Great Shark')
    await assert.rejects(() => f.svc.rename(id, ' '), /give the model a name/)
    const thumbed = await f.svc.saveThumb(id, PNG)
    assert.equal(thumbed.thumb, 'thumb.png')
    assert.equal(thumbed.thumbStamp, renamed.updatedAt)
    assert.equal(thumbed.updatedAt, renamed.updatedAt, 'a thumbnail is not an edit')
    assert.match((await f.svc.file(id, 'thumb.png'))!, /^data:image\/png;base64,/)
    assert.deepEqual(f.svc.setSettings({ critic: false, rounds: 99 }), { critic: false, rounds: 5 })
    assert.deepEqual(f.svc.setSettings({ rounds: -2 }), { critic: false, rounds: 0 })
    const st = await f.svc.status()
    assert.equal(st.lune.available, true)
    assert.equal(st.vision, true)
    assert.equal(st.entries, 1)
    assert.equal(st.studio.canBuild, false)
    assert.equal(await f.svc.remove(id), true)
    assert.deepEqual(await f.svc.list(), [])
    assert.ok(f.events.some((e) => e.event === 'model:changed'))
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('critique runs one round on a saved model', async () => {
  const f = await fake({ answers: [() => fence(script(15, ' tail'), '- longer tail')] })
  try {
    const { entry } = await f.svc.fromTemplate('creature', { name: 'Lizard' })
    const r = await f.svc.critique(entry.id)
    assert.equal(r.entry.critic?.length, 1)
    assert.equal(r.entry.critic![0].round, 1)
    assert.equal(r.entry.parts, 15)
    assert.equal(f.captures.length, 1)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('buildInStudio sends the kit + script job with the guard link and reports the built model', async () => {
  const f = await fake({ bridge: {} })
  try {
    const { entry } = await f.svc.fromTemplate('guard', { name: 'Ice Wolf' })
    const r = await f.svc.buildInStudio(entry.id, { guard: { path: 'Workspace.Guards.OldWolf', areaId: 'Area3' } })
    assert.deepEqual(r, { name: 'Ice Wolf', parts: 42, path: 'Workspace.Ice Wolf', place: 'Obby' })
    const job = f.jobs[0]
    assert.equal(job.kind, 'model')
    assert.equal(job.modules[0].source, KIT)
    assert.equal(job.modules[1].source, TEMPLATE('guard'))
    assert.deepEqual(job.model, { guard: ['Workspace', 'Guards', 'OldWolf'], areaId: 'Area3' })
    // The guard link is saved with the model.
    assert.deepEqual((await f.svc.get(entry.id)).guard, { path: 'Workspace.Guards.OldWolf', areaId: 'Area3' })
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('buildInStudio explains an old plugin, a plugin error and a script over the Source limit', async () => {
  const old = await fake({ bridge: { version: 9 } })
  try {
    const { entry } = await old.svc.fromTemplate('egg', { name: 'Egg' })
    await assert.rejects(() => old.svc.buildInStudio(entry.id), /Forge Bridge v9; restart Studio to load v10/)
  } finally {
    await rm(old.dir, { recursive: true, force: true })
  }
  const failing = await fake({
    bridge: {
      run: async () => {
        throw new BridgeError('plugin-error', 'Studio: Build:4: kaboom')
      }
    }
  })
  try {
    const { entry } = await failing.svc.fromTemplate('egg', { name: 'Egg' })
    await assert.rejects(() => failing.svc.buildInStudio(entry.id), (e: Error) => e.message === 'Build:4: kaboom')
  } finally {
    await rm(failing.dir, { recursive: true, force: true })
  }
  const big = await fake({ bridge: {} })
  try {
    const { entry } = await big.svc.fromTemplate('egg', { name: 'Egg' })
    await big.svc.save(entry.id, { script: `${script(5)}--${'x'.repeat(SOURCE_LIMIT)}` })
    await assert.rejects(() => big.svc.buildInStudio(entry.id), ModuleTooLargeError)
    assert.equal(big.jobs.length, 0)
  } finally {
    await rm(big.dir, { recursive: true, force: true })
  }
})

test('buildInStudio goes to the "Test in" place: its plugin and name are the ones reported', async () => {
  let opts: unknown = 'unset'
  const f = await fake({
    bridge: {
      studio: () => ({ place: 'Lobby', pluginVersion: 10 }),
      targetStudio: () => ({ place: 'Arena', placeId: 77, pluginVersion: 9 }),
      run: async (_job, handler, o) => {
        opts = o
        handler({ type: 'log', message: JSON.stringify({ built: 'Egg', parts: 9, path: 'Workspace.Egg' }) }, 0)
      }
    }
  })
  try {
    const { entry } = await f.svc.fromTemplate('egg', { name: 'Egg' })
    // The targeted place runs an old plugin: no build, whatever the last polling window runs.
    const st = await f.svc.status()
    assert.equal(st.studio.place, 'Arena')
    assert.equal(st.studio.canBuild, false)
    await assert.rejects(() => f.svc.buildInStudio(entry.id), /v9; restart Studio/)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
  const g = await fake({
    bridge: {
      targetStudio: () => ({ place: 'Arena', placeId: 77, pluginVersion: 10 }),
      run: async (_job, handler, o) => {
        opts = o
        handler({ type: 'log', message: JSON.stringify({ built: 'Egg', parts: 9, path: 'Workspace.Egg' }) }, 0)
      }
    }
  })
  try {
    const { entry } = await g.svc.fromTemplate('egg', { name: 'Egg' })
    const r = await g.svc.buildInStudio(entry.id)
    assert.equal(r.place, 'Arena')
    // No own target: the bridge sends it to its default target (the picker's place).
    assert.equal((opts as { target?: unknown }).target, undefined)
  } finally {
    await rm(g.dir, { recursive: true, force: true })
  }
})

test('run refuses empty and oversized scripts before Lune', async () => {
  const f = await fake()
  try {
    assert.match((await f.svc.run('  ')).error!.message, /empty/)
    assert.match((await f.svc.run('x'.repeat(MAX_SCRIPT_CHARS + 1))).error!.message, /keep it under 150,000/)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('the library lives in the project when one is open', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-model-proj-'))
  try {
    const svc = new ModelService({ userDir: join(dir, 'user'), projectRoot: () => dir, lune: async () => ({ error: 'no lune' }), settings: { get: (_k, d) => d, set: () => undefined } })
    assert.equal(svc.library().dir, join(dir, '.forge', 'models', 'library'))
    const st = await svc.status()
    assert.deepEqual(st.lune, { available: false, hint: 'no lune' })
    assert.equal(st.vision, false)
    assert.equal(st.studio.canBuild, false)
    // Without Lune a template is still saved, with the reason.
    const r = await svc.fromTemplate('egg')
    assert.equal(r.build.ok, false)
    assert.match(r.entry.error ?? '', /needs Lune/)
    assert.ok(JSON.parse(await readFile(join(dir, '.forge/models/library', r.entry.id, 'entry.json'), 'utf8')).script)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
