// ForgeVFX (attribute-driven effects, docs/vfx-emit.md): the Luau runtime's structure and rules, the
// project files and "Install ForgeVFX", and the Studio "Play selection" job. Without Lune the Luau
// is checked structurally (test/luauCheck.ts); with Lune it is also compiled.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMIT_RUNTIME_HEADER, EMIT_RUNTIME_MODULE, FORGEVFX_MODULE, FORGEVFX_SOURCE, isOwnEmitRuntime, usesEmitAttributes } from '../src/shared/vfx/emitRuntime.ts'
import { FORGEFX_SOURCE } from '../src/shared/vfx/runtime.ts'
import { LIVE_FOLDER } from '../src/shared/vfx/live.ts'
import { normalizeGap, parsePlayError, parsePlayInfo, parsePlayPoll, playAnswer, playModuleSource, playSelectionJob, PLAY_ENTRY, PLAY_ERROR_TAG, PLAY_INFO_TAG, PLAY_POLL_TAG } from '../src/shared/vfx/emitStudio.ts'
import { BRIDGE_VERSION, type BridgeJob } from '../src/shared/studio/protocol.ts'
import { SelectionPlayer, SelectionPlayError } from '../src/main/services/vfx/selectionPlay.ts'
import type { LiveBridge } from '../src/main/services/vfx/live.ts'
import { VfxService } from '../src/main/services/vfx/service.ts'
import { findLune } from '../src/main/services/tests/lune.ts'
import type { VfxEffect, VfxNode } from '../src/shared/vfx/types.ts'
import { luauCheck } from './luauCheck.ts'

// ------------------------------------------------------------------ structural Luau checks

test('luauCheck: passes the shipped Luau, catches the usual slips', () => {
  assert.deepEqual(luauCheck(FORGEFX_SOURCE), [])
  const ok = 'local function f(a: number): number\n\tlocal x = if a > 0 then 1 else 2\n\tif x ~= 1 then\n\t\treturn x\n\telse\n\t\tx += 1\n\tend\n\tfor i = 1, 3 do\n\t\tx += i\n\tend\n\twhile x > 0 do\n\t\tx -= 1\n\tend\n\trepeat\n\t\tx += 1\n\tuntil x > 2\n\treturn x\nend\nreturn f\n'
  assert.deepEqual(luauCheck(ok), [])
  assert.match(luauCheck('local function f()\n\tif true then\n\t\treturn 1\nend\n').join(), /never closed/)
  assert.match(luauCheck('local x = 1\nif x != 2 then\nend\n').join(), /"!" is not Luau/)
  assert.match(luauCheck('local spawnTimes = 1\nreturn spawnTime\n').join(), /"spawnTime" is not declared/)
  assert.match(luauCheck('local a = {}\nlocal b = a\n(b :: any).x = 1\n').join(), /ambiguous call syntax/)
  assert.match(luauCheck('repeat\n\tlocal x = 1\nend\n').join(), /end without a block/)
  assert.match(luauCheck('local s = "unterminated\nreturn s\n').join(), /unterminated string/)
})

test('ForgeVFX source: header, ownership, structure, no template-literal leftovers', () => {
  assert.equal(EMIT_RUNTIME_MODULE, 'ForgeVFX')
  assert.equal(FORGEVFX_MODULE, 'ForgeVFX')
  const lines = FORGEVFX_SOURCE.split('\n')
  assert.equal(lines[0], '--!nonstrict')
  assert.ok(lines[1].startsWith(EMIT_RUNTIME_HEADER))
  assert.equal(isOwnEmitRuntime(FORGEVFX_SOURCE), true)
  assert.equal(isOwnEmitRuntime('-- my own ForgeVFX\nreturn {}\n'), false)
  assert.equal(isOwnEmitRuntime(FORGEFX_SOURCE), false, 'ForgeFX is another module')
  assert.deepEqual(luauCheck(FORGEVFX_SOURCE), [])
  assert.doesNotMatch(FORGEVFX_SOURCE, /\$\{|undefined|\[object |NaN/)
  assert.ok(!FORGEVFX_SOURCE.includes('\\'), 'no backslashes (template literal)')
  assert.ok(FORGEVFX_SOURCE.length < 100_000)
  assert.match(FORGEVFX_SOURCE, /\nreturn ForgeVFX\n$/)
})

test('ForgeVFX source: the Roblox API it relies on', () => {
  const need = [
    // cloning, placing, following, cleanup
    'template:Clone()', ':PivotTo(', ':GetPivot()', 'Instance.new("WeldConstraint")', 'w.Part0 = target', 'w.Part1 = p', 'p.Anchored = false', 'p.Anchored = true', 'p.CanCollide = false', 'p.CanQuery = false', 'p.CanTouch = false', '.WorldCFrame',
    'd:IsA("LuaSourceContainer")', 'run.root:Destroy()', 'RunService.Heartbeat:Connect(step)', 'stepConn:Disconnect()',
    // layers
    'pe:Emit(n)', 'pe.Lifetime.Max', 'pe.Rate', 'a.Enabled = true', 'a.Enabled = false', 'a.Lifetime',
    'NumberSequence.new(keys)', 'NumberSequenceKeypoint.new(kp.Time', 'seq.Keypoints', 'kp.Envelope',
    // attributes
    'inst:GetAttribute(name)', 'typeof(v) == "NumberRange"', 'v.Min, v.Max', 'typeof(spread) == "Vector2"', 'typeof(v) == "Vector3"', 'typeof(v) == "NumberSequence"', 'GetAttribute("SyncPosition") == true',
    // easing and randomness
    'TweenService:GetValue(math.clamp(a, 0, 1), style, direction)', 'Enum.EasingStyle:GetEnumItems()', 'Enum.EasingDirection:GetEnumItems()', 'Random.new()', 'rng:NextNumber()',
    // mesh effects
    'FindFirstChildOfClass("SpecialMesh")', 'copy.mesh.Scale', 'copy.mesh.Offset', 'copy.mesh.VertexColor', 'd:IsA("Decal")', 'd.Color3', 'CFrame.fromAxisAngle(axis, angle * k)', ':ToAxisAngle()', 'a:Lerp(b, k)',
    // threads
    'task.spawn(', 'coroutine.yield()',
    // API
    'function ForgeVFX.emit(template: Instance, at: any?, options: any?)', 'function ForgeVFX.stopAll(', 'function ForgeVFX.init()', 'shared.ForgeVFX = ForgeVFX', 'function Emission:Stop(', 'Finished = run.signal', 'Duration = run.duration'
  ]
  for (const s of need) assert.ok(FORGEVFX_SOURCE.includes(s), s)
  // Old / wrong API names.
  for (const bad of ['wait(', 'spawn(f', 'delay(', 'SetPrimaryPartCFrame', ':Lerp(b, kc)', 'math.random(', 'Instance.new("Weld")', ':GetValue(a,']) assert.ok(!FORGEVFX_SOURCE.replace(/task\.(wait|spawn|delay)\(/g, '').includes(bad), bad)
})

test('ForgeVFX source: timing rules match cuesFromAttributes and the preview plan', () => {
  const src = FORGEVFX_SOURCE
  // EmitDelay adds up down the tree (clamped 0..30); the rest inherit the nearest value.
  assert.match(src, /local d = num\(inst, "EmitDelay"\)\n\tif d ~= nil then\n\t\tctx\.delay \+= d/)
  assert.match(src, /local c = num\(inst, "EmitCount"\)\n\tif c ~= nil then\n\t\tctx\.count = c/)
  assert.match(src, /return math\.clamp\(d, 0, MAX_DELAY\)/)
  assert.match(src, /local MAX_DELAY = 30/)
  // ParticleEmitter: spread (at most 60 steps), burst, window, default burst.
  assert.match(src, /if dur and rate <= 0 and count and count > 0 then/)
  assert.match(src, /math\.max\(1, math\.min\(60, count, jsRound\(dur \* 30\)\)\)/)
  assert.match(src, /local want = jsRound\(\(i \+ 1\) \* count \/ steps\)/)
  assert.match(src, /local t = delay \+ i \* dur \/ steps/)
  assert.match(src, /elseif count == nil then\n[^\n]*\n\t\t\temitAt\(scope, pe, delay, math\.max\(8, jsRound\(rate \* 0\.25\)\)\)/)
  // JS Math.round for positive numbers.
  assert.match(src, /return math\.floor\(x \+ 0\.5\)/)
  // Beams / trails / lights: a start-on layer goes off first; open windows last >= 1 s.
  assert.match(src, /if a\.Enabled and \(delay > 0 or dur\) then\n\t\ta\.Enabled = false/)
  assert.match(src, /local OPEN_MIN = 1/)
  assert.match(src, /TOGGLES = \{ Beam = true, Trail = true, PointLight = true, SpotLight = true, SurfaceLight = true, Highlight = true \}/)
  // FadeOut: linear, T' = 1 - (1 - T) * (1 - k).
  assert.match(src, /1 - \(1 - kp\.Value\) \* \(1 - k\)/)
  assert.match(src, /base\.brightness \* \(1 - k\)/)
  // Mesh copies: spawn times, cap, random draw order, pivot at Start.
  assert.match(src, /local MAX_COPIES = 200/)
  assert.match(src, /while k \/ r < D and #times < MAX_COPIES do/)
  assert.match(src, /table\.insert\(times, d \+ i \* D \/ c\)/)
  const draws = ['local life = ', 'local sx = ', 'local sy = ', 'local rx = ', 'local ry = ', 'local rz = '].map((s) => src.indexOf(s))
  assert.ok(draws.every((x, i) => x > 0 && (i === 0 || x > draws[i - 1])), 'lifetime, spreadX, spreadY, rotX, rotY, rotZ')
  assert.match(src, /pivot = CFrame\.new\(s\.Position\)/)
  assert.match(src, /spec\.pivot\n\t\t\t\* CFrame\.Angles\(math\.rad\(sx\), math\.rad\(sy\), 0\)\n\t\t\t\* CFrame\.Angles\(math\.rad\(rx\), math\.rad\(ry\), math\.rad\(rz\)\)\n\t\t\t\* spec\.pivot:Inverse\(\)/)
  assert.match(src, /local DEFAULT_LIFETIME = 0\.5/)
  // Riding children: inheritance restarts at Start.
  assert.match(src, /walk\(scope, inst, ROOT_CTX\)\n\tlocal linger = finishScope\(scope, copy\.life\)/)
  // Ease strings: case-insensitive, Enum prefix, unknown -> Quad.Out.
  assert.match(src, /\^enum%\.easingstyle%\./)
  assert.match(src, /style = Enum\.EasingStyle\.Quad\n\t\tdirection = Enum\.EasingDirection\.Out/)
})

// ------------------------------------------------------------------ project files

const node = (className: string, name: string, children: VfxNode[] = [], attrs?: VfxNode['attrs']): VfxNode => ({ id: name, className, name, props: {}, children, ...(attrs ? { attrs } : {}) }) as VfxNode

test('usesEmitAttributes: emit attributes or a Start/End mesh effect', () => {
  assert.equal(usesEmitAttributes([node('Model', 'Fx', [node('Part', 'Core', [node('ParticleEmitter', 'Sparks')])])]), false)
  assert.equal(usesEmitAttributes([node('Model', 'Fx', [node('Part', 'Core', [node('ParticleEmitter', 'Sparks', [], { EmitCount: 20 })])])]), true)
  assert.equal(usesEmitAttributes([node('Model', 'Fx', [node('Folder', 'Ring', [node('MeshPart', 'Start'), node('MeshPart', 'End')])])]), true)
  assert.equal(usesEmitAttributes([node('Model', 'Fx', [node('Folder', 'Ring', [node('MeshPart', 'Start')])])]), false)
})

test('Install ForgeVFX: written once, unchanged after, a file that is not ours is kept', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfx-emit-'))
  const root = join(dir, 'project')
  await mkdir(root, { recursive: true })
  const svc = new VfxService({ userDir: join(dir, 'user'), projectRoot: () => root, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null } as never)
  assert.deepEqual(await svc.installEmitRuntime(), { path: 'src/shared/VFX/ForgeVFX.luau', status: 'written' })
  const file = join(root, 'src', 'shared', 'VFX', 'ForgeVFX.luau')
  assert.equal(await readFile(file, 'utf8'), FORGEVFX_SOURCE)
  assert.equal((await svc.installEmitRuntime()).status, 'unchanged')
  // An older version of ours is updated.
  await writeFile(file, `--!nonstrict\n${EMIT_RUNTIME_HEADER} (v0).\nreturn {}\n`)
  assert.equal((await svc.installEmitRuntime()).status, 'written')
  assert.equal(await readFile(file, 'utf8'), FORGEVFX_SOURCE)
  // Someone's own module of that name stays.
  await writeFile(file, '-- my ForgeVFX\nreturn {}\n')
  assert.equal((await svc.installEmitRuntime()).status, 'kept')
  assert.equal(await readFile(file, 'utf8'), '-- my ForgeVFX\nreturn {}\n')
  // No project: a clear error.
  const none = new VfxService({ userDir: join(dir, 'user2'), projectRoot: () => null, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null } as never)
  await assert.rejects(() => none.installEmitRuntime(), /Open a game project first/)
})

test('exportFiles: ForgeVFX.luau ships next to attribute-driven effects (ownership rule), not with plain ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfx-emit-export-'))
  const svc = new VfxService({ userDir: join(dir, 'user'), projectRoot: () => null, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null } as never)
  const effect = (attrs?: VfxNode['attrs']): VfxEffect =>
    ({ name: 'Burst', duration: 1, roots: [node('Part', 'Core', [node('Attachment', 'At', [{ ...node('ParticleEmitter', 'Sparks', [], attrs), props: { Rate: 0, Lifetime: [0.5, 1] } }])])], cues: [] }) as unknown as VfxEffect
  const entry = (e: VfxEffect) => ({ id: 'x', scope: 'user', kind: 'model', name: 'Burst', description: '', tags: [], createdAt: 0, updatedAt: 0, origin: 'Burst.rbxm', effect: e, thumbs: [] }) as never
  const timed = await svc.exportFiles(entry(effect({ EmitDelay: 0.2, EmitCount: 12 })), 'src/shared/VFX/Burst')
  const f = timed.find((x) => x.path === 'src/shared/VFX/ForgeVFX.luau')
  assert.ok(f, 'ForgeVFX next to the effect folders')
  assert.equal(f!.content, FORGEVFX_SOURCE)
  assert.equal(f!.owned?.(FORGEVFX_SOURCE), true)
  assert.equal(f!.owned?.('-- mine\n'), false)
  const plain = await svc.exportFiles(entry(effect()), 'src/shared/VFX/Burst')
  assert.equal(plain.some((x) => x.path.endsWith('ForgeVFX.luau')), false)
})

// ------------------------------------------------------------------ Studio "Play selection" job

test('Play selection job: modules, entry, folder, loop flag and message format', () => {
  const job = playSelectionJob({ id: 'job-vfxplay-abc', port: 34877, loop: true, gap: 1.5 })
  assert.equal(job.version, BRIDGE_VERSION)
  assert.equal(job.kind, 'vfx')
  assert.equal(job.mode, 'realtime')
  assert.equal(job.entry, PLAY_ENTRY)
  assert.equal(job.calibrate, false)
  assert.equal(job.duration, 0)
  assert.ok(job.timeout >= 3600, 'a loop runs until Forge says stop')
  assert.deepEqual(job.modules.map((m) => m.name), ['ForgeVFX', PLAY_ENTRY])
  assert.equal(job.modules[0].source, FORGEVFX_SOURCE)
  const src = job.modules[1].source!
  assert.deepEqual(luauCheck(src), [])
  assert.ok(!src.includes('\\'))
  assert.match(src, /local URL = "http:\/\/127\.0\.0\.1:34877\/forge-bridge\/event\/job-vfxplay-abc"/)
  assert.match(src, /local LOOP = true/)
  assert.match(src, /local GAP = 1\.5/)
  assert.match(src, new RegExp(`local FOLDER = "${LIVE_FOLDER}"`))
  assert.match(src, /folder\.Archivable = false/)
  assert.match(src, /runtime\.Archivable = false/)
  assert.match(src, /Selection:Get\(\)/)
  assert.match(src, /pcall\(ForgeVFX\.emit, inst, nil, \{ parent = folder \}\)/)
  assert.match(src, /e:Stop\(true\)/)
  assert.match(src, /folder:Destroy\(\)/)
  assert.match(src, /function M\.play\(_origin, _stage, _opts\)/)
  for (const tag of [PLAY_POLL_TAG, PLAY_INFO_TAG, PLAY_ERROR_TAG]) assert.ok(src.includes(`"${tag} "`), tag)
  const once = playSelectionJob({ id: 'job-vfxplay-1', port: 1, loop: false, gap: 99 })
  assert.match(once.modules[1].source!, /local LOOP = false/)
  assert.match(once.modules[1].source!, /local GAP = 10\n/, 'gap clamped')
  assert.ok(once.timeout < 600)
  assert.throws(() => playModuleSource({ port: 1, jobId: 'bad id"; os.exit()', loop: false, gap: 0 }), /bad job id/)
  // Messages.
  assert.deepEqual(parsePlayPoll(`${PLAY_POLL_TAG} 3`), { plays: 3 })
  assert.equal(parsePlayPoll(`${PLAY_POLL_TAG} x`), null)
  assert.deepEqual(parsePlayInfo(`${PLAY_INFO_TAG} 2 Fireball, Ring`), { count: 2, names: ['Fireball', 'Ring'] })
  assert.deepEqual(parsePlayInfo(`${PLAY_INFO_TAG} 0`), { count: 0, names: [] })
  assert.equal(parsePlayError(`${PLAY_ERROR_TAG} Fireball: boom`), 'Fireball: boom')
  assert.equal(parsePlayError('forge-live-error 1 x'), null)
  assert.deepEqual(playAnswer({ gap: 2 }), { play: { gap: 2 } })
  assert.deepEqual(playAnswer({ stop: true, gap: -1 }), { play: { stop: true, gap: 0 } })
  assert.equal(normalizeGap('x'), 0.75)
})

function fakeBridge(opts: { connected?: boolean; busy?: BridgeJob } = {}) {
  const runs: { job: BridgeJob; handler: (ev: { type: string; message?: string }, at: number) => unknown; opts: unknown; resolve: () => void; reject: (e: Error) => void }[] = []
  let current: BridgeJob | null = opts.busy ?? null
  const cancelled: string[] = []
  const b: LiveBridge = {
    port: 34877,
    listening: true,
    connected: () => opts.connected !== false,
    current: () => current,
    run: (job, handler, o) =>
      new Promise<void>((resolve, reject) => {
        current = job
        runs.push({ job, handler, opts: o, resolve: () => ((current = null), resolve()), reject: (e) => ((current = null), reject(e)) })
      }),
    cancel: (reason) => {
      cancelled.push(reason ?? '')
      const r = runs.find((x) => x.job === current)
      r?.reject(new Error(`cancelled: ${reason}`))
    }
  }
  return { b, runs, cancelled }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

test('SelectionPlayer: loop plays, reports names and plays, stops on the next poll', async () => {
  const { b, runs } = fakeBridge()
  const events: string[] = []
  const timers: (() => void)[] = []
  const p = new SelectionPlayer({ bridge: () => b, emit: (_e, st) => events.push(st.state), setTimer: (fn) => timers.push(fn) })
  const st = p.play({ loop: true, gap: 2 })
  assert.equal(st.state, 'starting')
  assert.equal(runs.length, 1)
  assert.deepEqual(runs[0].opts, { acceptTimeoutMs: 15_000, timeoutMs: runs[0].job.timeout * 1000, preemptible: true })
  const h = runs[0].handler
  h({ type: 'accepted' }, 0)
  assert.equal(p.status().state, 'playing')
  h({ type: 'log', message: `${PLAY_INFO_TAG} 2 Fireball, Ring` }, 0)
  assert.deepEqual(p.status().names, ['Fireball', 'Ring'])
  assert.deepEqual(h({ type: 'log', message: `${PLAY_POLL_TAG} 1` }, 0), { play: { gap: 2 } })
  p.setGap(0.5)
  assert.deepEqual(h({ type: 'log', message: `${PLAY_POLL_TAG} 2` }, 0), { play: { gap: 0.5 } })
  assert.equal(p.status().plays, 2)
  p.stop()
  assert.deepEqual(h({ type: 'log', message: `${PLAY_POLL_TAG} 3` }, 0), { play: { stop: true, gap: 0.5 } })
  runs[0].resolve()
  await tick()
  assert.equal(p.status().state, 'off')
  assert.equal(p.status().error, undefined)
  // The safety cancel finds no job left.
  timers.forEach((t) => t())
  assert.ok(events.includes('playing') && events.at(-1) === 'off')
})

test('SelectionPlayer: once, replaced plays, errors and refusals', async () => {
  const { b, runs, cancelled } = fakeBridge()
  const p = new SelectionPlayer({ bridge: () => b })
  p.play()
  assert.equal(runs[0].job.modules[1].source!.includes('local LOOP = false'), true)
  // An error from the module is shown; the job then ends normally.
  runs[0].handler({ type: 'log', message: `${PLAY_ERROR_TAG} nothing to play: select an effect` }, 0)
  assert.match(p.status().error!, /nothing to play/)
  // A new play replaces the running one (the bridge preempts it); the old one's end is ignored.
  p.play({ loop: true })
  assert.equal(p.status().error, undefined)
  runs[0].reject(new Error('cancelled: another Studio job started'))
  await tick()
  assert.equal(p.status().state, 'starting')
  assert.deepEqual(runs[0].handler({ type: 'log', message: `${PLAY_POLL_TAG} 1` }, 0), { play: { stop: true, gap: 0.75 } }, 'an old job is told to stop')
  // Studio refuses the module (Script Injection off).
  runs[1].reject(Object.assign(new Error('Studio: script injection is not allowed'), { code: 'script-injection' }))
  await tick()
  assert.equal(p.status().state, 'off')
  assert.equal(p.status().errorCode, 'script-injection')
  // Stop on a one-shot cancels at once.
  p.play()
  p.stop()
  assert.deepEqual(cancelled, ['selection play stopped'])
  await tick()
  assert.equal(p.status().state, 'off')
  assert.equal(p.status().error, undefined)
  // Not connected / busy with another job.
  assert.throws(() => new SelectionPlayer({ bridge: () => fakeBridge({ connected: false }).b }).play(), SelectionPlayError)
  const busy = fakeBridge({ busy: { id: 'job-capture-1' } as BridgeJob })
  assert.throws(() => new SelectionPlayer({ bridge: () => busy.b }).play(), /busy/)
  // A Live loop is fine: the new job preempts it.
  const live = fakeBridge({ busy: { id: 'job-live-1' } as BridgeJob })
  assert.equal(new SelectionPlayer({ bridge: () => live.b }).play().state, 'starting')
})

// ------------------------------------------------------------------ Lune

const lune = process.env.LUNE_PATH || findLune()
test('ForgeVFX and the Play selection module compile with Luau', { skip: lune ? false : 'Lune not installed (set LUNE_PATH)' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfx-emit-luau-'))
  const files: Record<string, string> = {
    'ForgeVFX.luau': FORGEVFX_SOURCE,
    'PlayLoop.luau': playModuleSource({ port: 34877, jobId: 'job-x', loop: true, gap: 0.75 }),
    'PlayOnce.luau': playModuleSource({ port: 34877, jobId: 'job-y', loop: false, gap: 0 })
  }
  for (const [f, src] of Object.entries(files)) await writeFile(join(dir, f), src)
  const check = `local luau = require("@lune/luau")\nlocal fs = require("@lune/fs")\nfor _, f in { ${Object.keys(files).map((f) => `"${f}"`).join(', ')} } do\n\tluau.compile(fs.readFile(f))\nend\nprint("ok")\n`
  await writeFile(join(dir, 'check.luau'), check)
  const out = await new Promise<string>((res, rej) => execFile(lune!, ['run', 'check.luau'], { cwd: dir }, (err, stdout, stderr) => (err ? rej(new Error(stderr || err.message)) : res(stdout))))
  assert.match(out, /ok/)
})
