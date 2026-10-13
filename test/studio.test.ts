// Studio check: the Forge Bridge job protocol (a real HTTP server on 127.0.0.1 and a fake plugin),
// timing sync between the plugin's clock and Forge's, capture scheduling (nearest frames, stepped
// grabs) with a fake window recorder, the viewport crop, plugin install paths per OS and the plugin
// file, job payloads from the labs' data, and the plugin Luau (compiled with Lune when installed).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { parseEvent, type BridgeJob } from '../src/shared/studio/protocol.ts'
import { beatTargets, FrameRing, firstAtOrAfter, NearestFramePicker, stageDrift, startEpoch } from '../src/shared/studio/timing.ts'
import { findKeyRect, insetRect, KEY_COLOR, scaleRect } from '../src/shared/studio/crop.ts'
import { PLUGIN_FILE, PLUGIN_VERSION, pluginRbxmx, pluginSource, pluginsDir, pluginVersionOf } from '../src/shared/studio/plugin.ts'
import { abilityJob, animJob, CAMERAS, JOB_ROOT, placeholderClip, rbxmxToInstances, sequenceJson, vfxBeats, vfxJob } from '../src/shared/studio/payload.ts'
import { markStudioFrames, studioFramesNote, studioFramesOf } from '../src/shared/studio/frames.ts'
import { STUDIO_PREFER_SETTING } from '../src/shared/studio/types.ts'
import { StudioBridge, BridgeError } from '../src/main/services/studio/bridge.ts'
import { CHECK_FILE, StudioService, StudioCheckError, type CapturedFrame, type StudioCaptureSession, type StudioLab } from '../src/main/services/studio/service.ts'
import { readPluginTemplate } from '../src/main/services/studio/wire.ts'
import { compileTimeline } from '../src/shared/vfx/compile.ts'
import { findExample } from '../src/shared/vfx/examples.ts'
import { RECORDED } from '../src/shared/vfx/examples.recorded.ts'
import { compileAnim } from '../src/shared/anim/compile.ts'
import { ANIM_RECORDED } from '../src/shared/anim/examples.recorded.ts'
import { animExample } from '../src/shared/anim/examples.ts'
import { findAbilityExample } from '../src/shared/ability/examples.ts'
import { keyBeats } from '../src/shared/ability/critique.ts'
import { findLune } from '../src/main/services/tests/lune.ts'

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`)

function purple() {
  const ex = findExample('hollow-purple')!
  return compileTimeline({ name: ex.name, roots: [], cues: [], duration: 2 }, RECORDED[ex.key] ?? [], ex.script).effect
}

function dashPunch() {
  const ex = animExample('dash-punch')!
  return compileAnim(ANIM_RECORDED[ex.key] ?? [], ex.script, { name: ex.name, learned: [], rig: 'R15' }).clip
}

// ------------------------------------------------------------------ protocol

test('protocol: events are validated', () => {
  assert.deepEqual(parseEvent({ type: 'accepted' }), { type: 'accepted' })
  assert.deepEqual(parseEvent({ type: 'start', elapsed: 0.004, rtt: 3.2 }), { type: 'start', elapsed: 0.004, rtt: 3.2 })
  assert.deepEqual(parseEvent({ type: 'start', elapsed: 0.01, rtt: -5 }), { type: 'start', elapsed: 0.01, rtt: 0 })
  assert.equal(parseEvent({ type: 'start', elapsed: 99 }), null)
  assert.deepEqual(parseEvent({ type: 'beat', index: 2, t: 0.4 }), { type: 'beat', index: 2, t: 0.4 })
  assert.equal(parseEvent({ type: 'beat', index: 1.5, t: 0.4 }), null)
  assert.deepEqual(parseEvent({ type: 'done', marks: [{ label: 'charge', t: 0.1 }, { label: 3 }, null] }), { type: 'done', marks: [{ label: 'charge', t: 0.1 }] })
  assert.equal(parseEvent({ type: 'shutdown' }), null)
  assert.equal(parseEvent('done'), null)
  assert.equal((parseEvent({ type: 'error', message: 'x'.repeat(5000) }) as { message: string }).message.length, 2000)
})

// ------------------------------------------------------------------ timing

test('timing: plugin clock -> Forge clock, beat targets with display lag', () => {
  // The plugin started the play 6 ms before sending; the ping took 4 ms; Forge got it at 10_000.
  const s = startEpoch({ receivedAt: 10_000, elapsed: 0.006, rtt: 4 })
  assert.equal(s, 10_000 - 2 - 6)
  assert.deepEqual(beatTargets(s, [0, 0.5, 1.25], 50), [10_042, 10_542, 11_292])
  assert.equal(startEpoch({ receivedAt: 500, elapsed: -1, rtt: -1 }), 500)
})

test('timing: nearest frame per target, settled once later frames arrive', () => {
  const p = new NearestFramePicker<string>([1000, 1100, 1500])
  const frames = Array.from({ length: 30 }, (_, i) => 900 + i * 33)
  const won: number[][] = []
  for (const ts of frames) won.push(p.offer(ts, `f${ts}`))
  const picks = p.picks()
  assert.equal(picks[0]!.ts, 999)
  assert.equal(picks[0]!.offsetMs, -1)
  assert.equal(picks[1]!.ts, 1098)
  assert.equal(picks[2]!.ts, 1494)
  assert.ok(p.settled(100))
  assert.ok(won[0].length === 3, 'the first frame is the best so far for every target')
  const early = new NearestFramePicker<string>([2000])
  early.offer(1990, 'a')
  assert.equal(early.settled(120), false, 'not settled until a frame well past the target came in')
  early.offer(2130, 'b')
  assert.equal(early.settled(120), true)
  assert.equal(early.picks()[0]!.frame, 'a')
})

test('timing: frame ring keeps a window and hands dropped frames back', () => {
  const dropped: number[] = []
  const ring = new FrameRing<number>(100, (f) => dropped.push(f))
  for (let ts = 0; ts <= 300; ts += 50) ring.push(ts, ts)
  assert.deepEqual(ring.all().map((f) => f.ts), [200, 250, 300])
  assert.deepEqual(dropped, [0, 50, 100, 150])
  assert.equal(firstAtOrAfter(ring.all(), 210)!.ts, 250)
  assert.equal(firstAtOrAfter(ring.all(), 301), null)
  assert.equal(ring.drain().length, 3)
  assert.equal(ring.size, 0)
})

test('timing: stage drift pairs planned and played stages by label', () => {
  const d = stageDrift(
    [
      { label: 'charge', at: 0 },
      { label: 'release', at: 1.2 },
      { label: 'impact', at: 1.5 }
    ],
    [
      { label: 'charge', t: 0.0021 },
      { label: 'release', t: 1.2163 }
    ]
  )
  assert.deepEqual(d, [
    { label: 'charge', planned: 0, actual: 0.002 },
    { label: 'release', planned: 1.2, actual: 1.216 }
  ])
})

// ------------------------------------------------------------------ crop

function windowWithViewport(w: number, h: number, vp: { x: number; y: number; width: number; height: number }, order: 'rgba' | 'bgra' = 'rgba'): Uint8Array {
  const px = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const inside = x >= vp.x && x < vp.x + vp.width && y >= vp.y && y < vp.y + vp.height
      const [r, g, b] = inside ? KEY_COLOR : [40 + (x % 7), 44, 50 + (y % 5)]
      px[o] = order === 'rgba' ? r : b
      px[o + 1] = g
      px[o + 2] = order === 'rgba' ? b : r
      px[o + 3] = 255
    }
  return px
}

test('crop: finds the key-coloured viewport in a window capture', () => {
  const vp = { x: 40, y: 22, width: 150, height: 90 }
  assert.deepEqual(findKeyRect(windowWithViewport(240, 140, vp), 240, 140), vp)
  // A magenta toolbar icon elsewhere does not move the rect.
  const px = windowWithViewport(240, 140, vp)
  for (let x = 2; x < 8; x++) for (let y = 2; y < 8; y++) px.set([255, 0, 255, 255], (y * 240 + x) * 4)
  assert.deepEqual(findKeyRect(px, 240, 140), vp)
  assert.deepEqual(findKeyRect(windowWithViewport(240, 140, vp, 'bgra'), 240, 140, { order: 'bgra', key: [250, 10, 240] }), vp)
  assert.equal(findKeyRect(windowWithViewport(240, 140, { x: 0, y: 0, width: 3, height: 3 }), 240, 140), null, 'too small to be the viewport')
  assert.deepEqual(scaleRect({ x: 10, y: 5, width: 100, height: 50 }, 4, 4, { width: 420, height: 400 }), { x: 40, y: 20, width: 380, height: 200 })
  assert.deepEqual(insetRect({ x: 10, y: 10, width: 100, height: 50 }, 2), { x: 12, y: 12, width: 96, height: 46 })
})

// ------------------------------------------------------------------ plugin install

test('plugin: Studio plugins folder per OS', () => {
  assert.equal(pluginsDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\acid\\AppData\\Local' }, home: 'C:\\Users\\acid' }), 'C:\\Users\\acid\\AppData\\Local\\Roblox\\Plugins')
  assert.equal(pluginsDir({ platform: 'win32', env: {}, home: 'C:\\Users\\acid\\' }), 'C:\\Users\\acid\\AppData\\Local\\Roblox\\Plugins')
  assert.equal(pluginsDir({ platform: 'darwin', env: {}, home: '/Users/acid' }), '/Users/acid/Documents/Roblox/Plugins')
  assert.equal(pluginsDir({ platform: 'linux', env: {}, home: '/home/acid' }), null)
})

test('plugin: the .rbxmx holds the stamped source', async () => {
  const template = await readPluginTemplate([resolve(import.meta.dirname, '..', 'resources', 'studio')])
  assert.ok(template, 'resources/studio/ForgeBridge.luau exists')
  const src = pluginSource(template!, { port: 41234 })
  assert.ok(src.includes('http://127.0.0.1:41234/forge-bridge'))
  assert.ok(!src.includes('__FORGE_'))
  assert.equal(pluginVersionOf(src), PLUGIN_VERSION)
  const xml = pluginRbxmx(src + '\nlocal s = "]]>"\n')
  const [script] = rbxmxToInstances(xml)
  assert.equal(script.className, 'Script')
  assert.equal(script.name, 'ForgeBridge')
  const source = script.props.Source
  assert.equal(source.t, 'string')
  assert.ok((source.v as string).endsWith('local s = "]]>"\n'), 'CDATA terminator survives')
  assert.equal(pluginVersionOf(source.v as string), PLUGIN_VERSION)
})

// ------------------------------------------------------------------ payloads

test('payload: VFX job carries the module, timeline and runtime; beats inside each stage', () => {
  const fx = purple()
  const job = vfxJob(fx, { id: 'job-1' })
  assert.equal(job.kind, 'vfx')
  assert.equal(job.mode, 'realtime')
  assert.equal(job.entry, 'Effect')
  assert.deepEqual(job.camera, CAMERAS.vfx)
  assert.deepEqual(job.modules.map((m) => m.name), ['ForgeFX', 'Effect'])
  assert.deepEqual(job.modules[1].children?.map((c) => c.name), ['Timeline'])
  assert.match(job.modules[1].source!, /require\(script\.Parent:WaitForChild\("ForgeFX"\)\)/)
  assert.ok(job.beats.length >= 4)
  for (const b of job.beats) assert.ok(fx.stages!.some((s) => s.label === b.label), `beat ${b.label} is a stage`)
  assert.deepEqual(vfxBeats(fx).map((b) => b.t), job.beats.map((b) => b.t))
  const timed = vfxJob(fx, { id: 'job-2', times: [0.1, 2.5] })
  assert.deepEqual(timed.beats.map((b) => b.t), [0.1, 2.5])
  assert.ok(JSON.stringify(job).length < 400_000)
})

test('payload: anim job is stepped and carries the KeyframeSequence as instance data', () => {
  const clip = dashPunch()
  const seq = sequenceJson(clip)
  assert.equal(seq.className, 'KeyframeSequence')
  assert.equal(seq.name, clip.name)
  assert.deepEqual(seq.props.Loop, { t: 'bool', v: false })
  const kfs = seq.children.filter((c) => c.className === 'Keyframe')
  assert.ok(kfs.length > 3)
  const root = kfs[1].children.find((c) => c.className === 'Pose')!
  assert.equal(root.name, 'HumanoidRootPart')
  assert.equal(root.props.CFrame.t, 'cframe')
  assert.equal((root.props.CFrame.v as number[]).length, 12)
  assert.ok(seq.children.some((k) => k.children.some((c) => c.className === 'KeyframeMarker' && c.name === 'hit')))
  const job = animJob(clip, { id: 'a', times: [0.3, 0.54] })
  assert.equal(job.mode, 'stepped')
  assert.equal(job.rig, 'R15')
  assert.deepEqual(job.beats, [
    { t: 0.3, label: 'dash' },
    { t: 0.54, label: 'hit' }
  ])
})

test('payload: ability job has the VFX folder, runner pointed at the job root and the clip', () => {
  const fx = purple()
  const ability = findAbilityExample('hollow-purple')!.build({ 'purple-vfx': { id: 'fx-1', duration: fx.duration } })
  const placeholder = placeholderClip(ability.animation!.clip)
  assert.ok(placeholder && Object.keys(placeholder.tracks).length > 4)
  const job = abilityJob(ability, { 'fx-1': fx }, null, { id: 'b', times: keyBeats(ability) })
  assert.equal(job.mode, 'realtime')
  assert.equal(job.entry, ability.name)
  const vfx = job.modules.find((m) => m.name === 'VFX')!
  assert.equal(vfx.className, 'Folder')
  assert.deepEqual(vfx.children!.map((c) => c.name), ['ForgeFX', 'HollowPurple'])
  const runner = job.modules.find((m) => m.name === 'AbilityRunner')!
  assert.ok(runner.source!.includes(JOB_ROOT.map((p) => `"${p}"`).join(', ')))
  assert.equal(job.sequence?.className, 'KeyframeSequence', 'the placeholder pose track is sampled into a clip')
  assert.deepEqual(job.beats.map((b) => b.label), ['wind-up', 'anticipation', 'release', 'impact', 'follow-through'])
})

test('frames: Studio frames are marked for the critic', () => {
  const frames = markStudioFrames([Buffer.from('a'), Buffer.from('b'), Buffer.from('c')], { studio: 2, preview: 1 })
  assert.deepEqual(studioFramesOf(frames), { studio: 2, preview: 1 })
  assert.equal(JSON.stringify(Object.keys(frames)), '["0","1","2"]', 'the marker is not enumerable')
  assert.match(studioFramesNote(frames), /first 2 images are real Roblox Studio captures/)
  assert.match(studioFramesNote(frames), /next 1 image\(s\) are Forge's preview/)
  assert.equal(studioFramesNote([Buffer.from('a')]), '')
})

// ------------------------------------------------------------------ bridge (real HTTP)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function bridge(holdMs = 200): Promise<StudioBridge> {
  const b = new StudioBridge({ port: 0, holdMs })
  await b.start()
  assert.ok(b.listening)
  return b
}

function plugin(b: StudioBridge) {
  const base = `http://127.0.0.1:${b.port}/forge-bridge`
  return {
    poll: async (): Promise<{ job?: BridgeJob; idle?: boolean }> => (await fetch(`${base}/poll?v=1&place=MyGame&placeId=42`)).json(),
    post: async (job: BridgeJob, ev: unknown): Promise<Record<string, unknown>> => (await fetch(`${base}/event/${job.id}`, { method: 'POST', body: JSON.stringify(ev), headers: { 'Content-Type': 'application/json' } })).json()
  }
}

const tinyJob = (over: Partial<BridgeJob> = {}): BridgeJob => ({ ...animJob(dashPunch(), { id: `job-${Math.random().toString(36).slice(2)}`, times: [0.3, 0.54] }), ...over })

test('bridge: poll is held, then gets the job; events are answered by the handler (held)', async () => {
  const b = await bridge()
  const p = plugin(b)
  try {
    assert.deepEqual(await p.poll(), { idle: true })
    assert.ok(b.connected())
    assert.equal(b.studio()?.place, 'MyGame')
    assert.equal(b.studio()?.placeId, 42)
    const job = tinyJob()
    const seen: string[] = []
    const polling = p.poll()
    await sleep(20)
    const done = b.run(job, async (ev) => {
      seen.push(ev.type)
      if (ev.type === 'beat') {
        await sleep(60)
        return { grabbed: ev.index }
      }
      return {}
    })
    const got = await polling
    assert.equal(got.job?.id, job.id)
    assert.deepEqual(await p.post(job, { type: 'accepted' }), { ok: true })
    const t0 = Date.now()
    assert.deepEqual(await p.post(job, { type: 'beat', index: 0, t: 0.3 }), { ok: true, grabbed: 0 })
    assert.ok(Date.now() - t0 >= 50, 'the answer waited for the grab')
    assert.equal((await fetch(`http://127.0.0.1:${b.port}/forge-bridge/event/${job.id}`, { method: 'POST', body: '{"type":"nope"}' })).status, 400)
    await p.post(job, { type: 'done', marks: [] })
    await done
    assert.deepEqual(seen, ['accepted', 'beat', 'done'])
    assert.equal(b.busy(), null)
    assert.deepEqual(await p.post(job, { type: 'beat', index: 1, t: 0.5 }), { abort: true, reason: 'no such job (Forge gave up on it)' })
  } finally {
    await b.stop()
  }
})

test('bridge: refuses browser requests, one job at a time, timeouts and plugin errors', async () => {
  const b = await bridge(100)
  const p = plugin(b)
  try {
    assert.equal((await fetch(`http://127.0.0.1:${b.port}/forge-bridge/poll`, { headers: { Origin: 'https://evil.example' } })).status, 403)
    // Nobody picks the job up.
    await assert.rejects(b.run(tinyJob(), () => ({}), { acceptTimeoutMs: 80 }), (e: unknown) => e instanceof BridgeError && e.code === 'not-accepted')
    // Picked up, then the plugin reports an error.
    const job = tinyJob()
    const run = b.run(job, () => ({}))
    run.catch(() => undefined)
    await assert.rejects(b.run(tinyJob(), () => ({})), /already running/)
    const got = await p.poll()
    assert.equal(got.job?.id, job.id)
    await p.post(job, { type: 'accepted' })
    await p.post(job, { type: 'error', message: 'could not create the R15 dummy' })
    await assert.rejects(run, /Studio: could not create the R15 dummy/)
    // Whole-job timeout: later events are told to abort.
    const slow = tinyJob()
    const slowRun = b.run(slow, () => ({}), { timeoutMs: 120 })
    slowRun.catch(() => undefined)
    await p.poll()
    await p.post(slow, { type: 'accepted' })
    await assert.rejects(slowRun, (e: unknown) => e instanceof BridgeError && e.code === 'timeout')
    assert.equal((await p.post(slow, { type: 'beat', index: 0, t: 0 })).abort, true)
  } finally {
    await b.stop()
  }
})

// ------------------------------------------------------------------ service (fake recorder + fake plugin)

class FakeSession implements StudioCaptureSession {
  window = 'MyGame - Roblox Studio'
  grabs: number[] = []
  picks: number[][] = []
  closed = false
  async grabAfter(at: number): Promise<CapturedFrame> {
    this.grabs.push(at)
    return { ts: at + 5, png: Buffer.from(`grab@${this.grabs.length}`) }
  }
  async pick(targets: number[]): Promise<((CapturedFrame & { offsetMs: number }) | null)[]> {
    this.picks.push(targets)
    // A 30 fps stream: the nearest frame is within half a frame of each target.
    return targets.map((t, i) => ({ ts: t + (i % 2 ? 12 : -9), png: Buffer.from(`pick${i}`), offsetMs: i % 2 ? 12 : -9 }))
  }
  async close(): Promise<void> {
    this.closed = true
  }
}

function settingsStore(init: Record<string, unknown> = {}) {
  const m = new Map(Object.entries(init))
  return { get: <T>(k: string, f: T) => (m.has(k) ? (m.get(k) as T) : f), set: (k: string, v: unknown) => void m.set(k, v) }
}

function memLab(job: (jobId: string) => BridgeJob, extra: Partial<StudioLab> = {}) {
  const files = new Map<string, Buffer>()
  const lab: StudioLab = {
    prepare: async (_id, jobId) => ({ name: 'Purple', job: job(jobId), stages: purple().stages }),
    writeFile: async (id, file, bytes) => {
      files.set(`${id}/${file}`, bytes)
      return `/lib/${id}/${file}`
    },
    readFile: async (id, file) => files.get(`${id}/${file}`) ?? null,
    preview: async (_id, times) => times.map((t) => Buffer.from(`preview@${t}`)),
    ...extra
  }
  return { lab, files }
}

// Plays the plugin's side of a job against the bridge.
async function fakeStudio(b: StudioBridge, script: (job: BridgeJob, post: (ev: unknown) => Promise<Record<string, unknown>>) => Promise<void>): Promise<void> {
  const p = plugin(b)
  for (let i = 0; i < 50; i++) {
    const r = await p.poll()
    if (r.job) return script(r.job, (ev) => p.post(r.job!, ev))
  }
  throw new Error('no job')
}

function service(b: StudioBridge, session: FakeSession, labs: Record<string, StudioLab>, opts: { dir?: string | null; prefer?: boolean } = {}) {
  const events: { event: string; payload: any }[] = []
  const written = new Map<string, string>()
  const svc = new StudioService({
    bridge: b,
    capturer: { find: async () => ({ window: session.window }), open: async () => session },
    image: { keyRect: (png) => (String(png).startsWith('grab@1') ? { x: 100, y: 50, width: 800, height: 450 } : null), crop: (png, rect, w) => Buffer.from(`${png}|${rect ? `${rect.x},${rect.y},${rect.width}x${rect.height}` : 'full'}|${w}`) },
    labs,
    settings: settingsStore(opts.prefer ? { [STUDIO_PREFER_SETTING]: true } : {}),
    plugin: {
      dir: () => (opts.dir === undefined ? '/Users/acid/Documents/Roblox/Plugins' : opts.dir),
      template: async () => '-- forge-bridge-version: __FORGE_BRIDGE_VERSION__\nlocal URL = "http://127.0.0.1:__FORGE_PORT__/forge-bridge"\n',
      read: async (p) => written.get(p) ?? null,
      write: async (p, text) => void written.set(p, text)
    },
    emit: (event, payload) => events.push({ event, payload }),
    lagMs: 50,
    settleMs: 80
  })
  return { svc, events, written }
}

test('service: realtime check (VFX) maps the plugin clock, picks beats, crops, stores frames + preview', async () => {
  const b = await bridge(100)
  const session = new FakeSession()
  const fx = purple()
  const { lab, files } = memLab((id) => vfxJob(fx, { id }))
  const { svc, events } = service(b, session, { vfx: lab })
  try {
    await plugin(b).poll()
    let receivedStart = 0
    const studio = fakeStudio(b, async (job, post) => {
      assert.equal(job.kind, 'vfx')
      await post({ type: 'accepted' })
      assert.deepEqual(await post({ type: 'calibrate' }), { ok: true, crop: true })
      assert.deepEqual(await post({ type: 'ready' }), { ok: true, go: true })
      receivedStart = Date.now()
      await post({ type: 'start', elapsed: 0.004, rtt: 6 })
      await post({ type: 'done', marks: [{ label: 'fire', t: fx.stages!.find((s) => s.label === 'fire')!.at + 0.016 }] })
    })
    const record = await svc.check('vfx', 'fx-1', { critique: false })
    await studio
    assert.equal(record.ok, true)
    assert.equal(record.mode, 'realtime')
    assert.equal(session.picks.length, 1)
    const job = vfxJob(fx, { id: 'x' })
    // Targets: start = received - rtt/2 - elapsed; + t + lag.
    const start = session.picks[0][0] - job.beats[0].t * 1000 - 50
    assert.ok(Math.abs(start - (receivedStart - 3 - 4)) < 25, `start ${start} vs ${receivedStart - 7}`)
    for (const [i, b2] of job.beats.entries()) close(session.picks[0][i] - session.picks[0][0], (b2.t - job.beats[0].t) * 1000, 1)
    assert.equal(record.frames.length, job.beats.length)
    assert.equal(record.frames[0].offsetMs, -9)
    assert.deepEqual(record.crop, { x: 102, y: 52, width: 796, height: 446 }, 'calibration rect, inset by 2')
    assert.equal(String(files.get('fx-1/studio/beat-1.png')), 'pick0|102,52,796x446|640')
    assert.equal(String(files.get('fx-1/studio/preview-1.png')), `preview@${job.beats[0].t}`)
    assert.equal(record.frames[0].preview, 'studio/preview-1.png')
    assert.deepEqual(record.drift?.map((d) => d.label), ['fire'])
    assert.ok(record.abs?.[0].endsWith('studio/beat-1.png'))
    assert.ok(session.closed)
    const saved = JSON.parse(String(files.get(`fx-1/${CHECK_FILE}`)))
    assert.equal(saved.frames.length, record.frames.length)
    assert.equal(saved.abs, undefined, 'absolute paths are not stored')
    assert.deepEqual(await svc.lastCheck('vfx', 'fx-1'), saved)
    const phases = events.filter((e) => e.event === 'studio:progress').map((e) => e.payload.phase)
    assert.deepEqual([...new Set(phases)], ['queued', 'waiting', 'staging', 'capturing', 'preview', 'done'])
  } finally {
    await b.stop()
  }
})

test('service: stepped check (anim) grabs one frame after each posed beat; critique sees Studio + preview', async () => {
  const b = await bridge(100)
  const session = new FakeSession()
  const clip = dashPunch()
  let critiqued: { studio: Buffer[]; preview: Buffer[]; times: number[] } | null = null
  const { lab } = memLab((id) => animJob(clip, { id, times: [0.3, 0.54, 0.8] }), {
    critique: async (_id, studio, times, preview) => {
      critiqued = { studio, preview, times }
      return { overall: 7.2, summary: 'reads well in Studio' }
    }
  })
  const { svc } = service(b, session, { anim: lab })
  try {
    await plugin(b).poll()
    const studio = fakeStudio(b, async (job, post) => {
      await post({ type: 'accepted' })
      await post({ type: 'calibrate' })
      for (const [i, beat] of job.beats.entries()) await post({ type: 'beat', index: i, t: beat.t })
      await post({ type: 'done', marks: [] })
    })
    const t0 = Date.now()
    const record = await svc.check('anim', 'clip-1', { critique: true })
    await studio
    assert.equal(record.mode, 'stepped')
    assert.equal(session.grabs.length, 4, 'calibration + 3 beats')
    for (const at of session.grabs) assert.ok(at >= t0 + 80, 'each grab waits the settle time after the event')
    assert.deepEqual(record.frames.map((f) => f.label), ['dash', 'hit', 'recovery'])
    assert.equal(record.critique?.overall, 7.2)
    assert.equal(critiqued!.studio.length, 3)
    assert.equal(critiqued!.preview.length, 3)
    assert.deepEqual(critiqued!.times, [0.3, 0.54, 0.8])
  } finally {
    await b.stop()
  }
})

test('service: status explains what is missing; install writes the plugin with the port', async () => {
  const b = await bridge(100)
  const session = new FakeSession()
  try {
    const none = service(b, session, {}, { dir: null })
    assert.equal((await none.svc.status()).state, 'unsupported')
    const { svc, written } = service(b, session, {})
    let s = await svc.status()
    assert.equal(s.state, 'no-plugin')
    assert.equal(s.plugin.installed, false)
    s = await svc.installPlugin()
    const file = `/Users/acid/Documents/Roblox/Plugins/${PLUGIN_FILE}`
    assert.ok(written.get(file)?.includes(`http://127.0.0.1:${b.port}/forge-bridge`))
    assert.equal(s.plugin.installed, true)
    assert.equal(s.plugin.version, PLUGIN_VERSION)
    assert.equal(s.state, 'studio-offline')
    await plugin(b).poll()
    s = await svc.status()
    assert.equal(s.state, 'ready')
    assert.equal(s.studio.place, 'MyGame')
    assert.equal(s.capture.window, 'MyGame - Roblox Studio')
    // A plugin built for another port is outdated.
    written.set(file, written.get(file)!.replace(String(b.port), '1'))
    assert.equal((await svc.status()).state, 'plugin-outdated')
    await svc.setPrefer(true)
    assert.equal((await svc.status()).prefer, true)
  } finally {
    await b.stop()
  }
})

test('service: checks fail clearly without Studio; the labs fall back to the preview', async () => {
  const b = await bridge(100)
  const session = new FakeSession()
  const fx = purple()
  const { lab } = memLab((id) => vfxJob(fx, { id }))
  try {
    const { svc } = service(b, session, { vfx: lab }, { prefer: true })
    await assert.rejects(svc.check('vfx', 'fx-1'), (e: unknown) => e instanceof StudioCheckError && e.state === 'studio-offline')
    let previewed = 0
    const preview = async (req: { times: number[] }) => (previewed++, req.times.map(() => Buffer.from('p')))
    const wrapped = svc.wrapCapture('vfx', preview, (req: { times: number[] }, id) => vfxJob(fx, { id, times: req.times }))!
    // Not connected: straight to the preview.
    assert.deepEqual((await wrapped({ times: [0.1, 0.2] })).map(String), ['p', 'p'])
    assert.equal(previewed, 1)
    // Connected and preferred: Studio frames, marked for the critic.
    await plugin(b).poll()
    const studio = fakeStudio(b, async (job, post) => {
      await post({ type: 'accepted' })
      await post({ type: 'calibrate' })
      await post({ type: 'ready' })
      await post({ type: 'start', elapsed: 0, rtt: 0 })
      await post({ type: 'done', marks: [] })
    })
    const frames = await wrapped({ times: [0.1, 0.2] })
    await studio
    assert.equal(previewed, 1)
    assert.deepEqual(studioFramesOf(frames), { studio: 2 })
    // Studio errors mid-job: the preview takes over.
    const failing = fakeStudio(b, async (_job, post) => {
      await post({ type: 'accepted' })
      await post({ type: 'error', message: 'script injection is not allowed' })
    })
    const again = await wrapped({ times: [0.1, 0.2] })
    await failing
    assert.equal(previewed, 2)
    assert.equal(studioFramesOf(again), null)
  } finally {
    await b.stop()
  }
})

// ------------------------------------------------------------------ plugin Luau

const lune = process.env.LUNE_PATH || findLune()
test('the Forge Bridge plugin compiles with Lune', { skip: lune ? false : 'Lune not installed (set LUNE_PATH)' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-studio-plugin-'))
  const template = await readFile(resolve(import.meta.dirname, '..', 'resources', 'studio', 'ForgeBridge.luau'), 'utf8')
  await writeFile(join(dir, 'ForgeBridge.luau'), pluginSource(template, { port: 34877 }))
  await writeFile(join(dir, 'check.luau'), 'local luau = require("@lune/luau")\nlocal fs = require("@lune/fs")\nluau.compile(fs.readFile("ForgeBridge.luau"))\nprint("ok")\n')
  const out = await new Promise<string>((res, rej) => execFile(lune!, ['run', 'check.luau'], { cwd: dir }, (err, stdout, stderr) => (err ? rej(new Error(stderr || err.message)) : res(stdout))))
  assert.match(out, /ok/)
})
