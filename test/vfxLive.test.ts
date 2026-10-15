// "Live in Studio" and Loop on Test in Studio: the schedule (debounced updates, versions, pinned
// loops, poll answers), the controller with a fake bridge and fake timers (one preemptible job,
// paused for other Studio jobs and resumed with the user's camera, refine iterations replacing the
// loop with their label, stop / dispose cleaning up), the bridge's preemption over real HTTP, and
// the live / Studio import Luau compiled with Lune.
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { BridgeJob } from '../src/shared/studio/protocol.ts'
import { effectFromSpec, type VfxSpec } from '../src/shared/vfx/spec.ts'
import { LIVE_DEBOUNCE_MS, LIVE_ENTRY, LIVE_FOLDER, LiveSchedule, liveJob, liveModuleSource, livePayload, normalizeLiveSettings, parseLiveError, parseLivePoll } from '../src/shared/vfx/live.ts'
import { studioImportModuleSource } from '../src/shared/vfx/studioImport.ts'
import type { VfxEffect } from '../src/shared/vfx/types.ts'
import { LiveStudio, type LiveStatus } from '../src/main/services/vfx/live.ts'
import { BridgeError, PREEMPTED, StudioBridge } from '../src/main/services/studio/bridge.ts'

const spec = (name: string, rate: number): VfxSpec => ({ name, duration: 1, layers: [{ name: 'Sparks', class: 'ParticleEmitter', props: { Rate: rate, Color: ['#ff8000'] }, emit: [{ at: 0, count: 10 }] }] })
const fx = (name: string, rate = 10): VfxEffect => effectFromSpec(spec(name, rate))
const CAM = '1,2,3,1,0,0,0,1,0,0,0,1'

// ------------------------------------------------------------------ pure parts

test('live: settings, poll / error messages, payload, job', () => {
  assert.deepEqual(normalizeLiveSettings(null), { gap: 0.75, mode: 'dummy' })
  assert.deepEqual(normalizeLiveSettings({ gap: 99, mode: 'origin' }), { gap: 10, mode: 'origin' })
  assert.deepEqual(normalizeLiveSettings({ gap: -1, mode: 'x' as never }), { gap: 0, mode: 'dummy' })
  assert.deepEqual(parseLivePoll('forge-live-poll -1 0 '), null)
  assert.deepEqual(parseLivePoll('forge-live-poll -1 0'), { version: -1, plays: 0, camera: null })
  assert.deepEqual(parseLivePoll(`forge-live-poll 3 12 ${CAM}`), { version: 3, plays: 12, camera: [1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1] })
  assert.deepEqual(parseLivePoll('forge-live-poll 3 12 1,2'), { version: 3, plays: 12, camera: null })
  assert.equal(parseLivePoll('forge-vfx-data 1/1 {}'), null)
  assert.deepEqual(parseLiveError('forge-live-error 4 Requested module experienced an error'), { version: 4, error: 'Requested module experienced an error' })
  const p = livePayload(fx('Burst'))
  assert.equal(p.name, 'Burst')
  assert.match(p.source, /function Effect\.play/)
  assert.equal(p.timeline, undefined)
  assert.equal(p.duration, 1)
  const job = liveJob({ id: 'job-live-1', port: 34877, mode: 'origin', frame: false, camera: [1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1] })
  assert.equal(job.kind, 'vfx')
  assert.equal(job.entry, LIVE_ENTRY)
  assert.deepEqual(job.modules.map((m) => m.name), ['ForgeFX', LIVE_ENTRY])
  assert.ok(job.timeout >= 3600)
  const src = job.modules[1].source ?? ''
  assert.match(src, /local MODE = "origin"/)
  assert.match(src, /local FRAME = false/)
  assert.match(src, /local RESTORE_CAMERA = CFrame\.new\(1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1\)/)
  assert.ok(src.includes(`folder.Name = "${LIVE_FOLDER}"`) && src.includes('folder.Archivable = false'))
  assert.ok(src.includes('folder:Destroy()'), 'the folder goes when the loop ends')
  assert.match(liveModuleSource({ port: 1, jobId: 'j', mode: 'dummy', frame: true, camera: [1, 2, 3] }), /local RESTORE_CAMERA = nil/)
  assert.throws(() => liveModuleSource({ port: 1, jobId: 'x y', mode: 'dummy', frame: true }))
})

test('live schedule: debounced updates, versions, identical effects, pinned loops, poll answers', () => {
  const s = new LiveSchedule()
  assert.equal(s.set({ key: 'a', effect: fx('A'), label: 'A' }, 0), 'ignored', 'off')
  s.start({ settings: { gap: 1.5 } })
  assert.equal(s.settings.gap, 1.5)
  // Nothing yet: polls get no effect.
  assert.deepEqual(s.answer({ version: -1, plays: 0, camera: null }, 0), { version: 0, gap: 1.5, label: '' })
  assert.equal(s.set({ key: 'a', effect: fx('A', 10), label: 'A' }, 1000), 'queued')
  assert.equal(s.flush(1000 + LIVE_DEBOUNCE_MS - 1), false, 'debounced')
  // The last value within the debounce wins.
  s.set({ key: 'a', effect: fx('A', 20), label: 'A edited' }, 1100)
  assert.equal(s.flush(1100 + LIVE_DEBOUNCE_MS), true)
  assert.equal(s.version, 1)
  assert.equal(s.current?.label, 'A edited')
  const ans = s.answer({ version: -1, plays: 0, camera: null }, 1500)
  assert.equal(ans.version, 1)
  assert.match(ans.effect!.source, /"Rate",20[,}]/)
  // Same version: no effect resent; plays and camera recorded.
  assert.deepEqual(s.answer({ version: 1, plays: 3, camera: [1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1] }, 1600), { version: 1, gap: 1.5, label: 'A edited' })
  assert.equal(s.plays, 3)
  assert.deepEqual(s.camera?.slice(0, 3), [1, 2, 3])
  // An identical effect only relabels.
  s.set({ key: 'a', effect: fx('A', 20), label: 'A again' }, 2000)
  assert.equal(s.flush(2000, true), false)
  assert.equal(s.version, 1)
  assert.equal(s.current?.label, 'A again')
  // A poll flushes a pending update once it is old enough.
  s.set({ key: 'b', effect: fx('B', 30), label: 'B' }, 3000)
  assert.equal(s.answer({ version: 1, plays: 4, camera: null }, 3100).effect, undefined)
  assert.equal(s.answer({ version: 1, plays: 4, camera: null }, 3000 + LIVE_DEBOUNCE_MS).version, 2)
  assert.ok(s.relabel('b', 'B · 9.0/10'))
  assert.ok(!s.relabel('nope', 'x'))
  // Pinned (Loop on one entry): its drafts are fine, another entry stops it.
  s.start({ pin: 'b' })
  assert.equal(s.set({ key: 'draft:b', effect: fx('B', 31), label: 'B · iteration 2' }, 4000), 'queued')
  assert.equal(s.set({ key: 'c', effect: fx('C'), label: 'C' }, 4100), 'stopped')
  assert.equal(s.enabled, false)
  assert.equal(s.hasPending(), false)
  assert.equal(s.answer({ version: 2, plays: 9, camera: null }, 5000).stop, true)
})

// ------------------------------------------------------------------ controller (fake bridge + timers)

function fakeClock() {
  let now = 0
  let ids = 0
  const timers: { at: number; id: number; fn: () => void }[] = []
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const t = { at: now + ms, id: ++ids, fn }
      timers.push(t)
      return t
    },
    clearTimer: (t: unknown) => {
      const i = timers.indexOf(t as (typeof timers)[number])
      if (i >= 0) timers.splice(i, 1)
    },
    pending: () => timers.length,
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id)
        const t = timers[0]
        if (!t || t.at > end) break
        timers.shift()
        now = t.at
        t.fn()
        await flush()
      }
      now = end
      await flush()
    }
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

type Handler = (ev: { type: string; message?: string }, at: number) => unknown
function fakeBridge() {
  const runs: { job: BridgeJob; handler: Handler; opts: { preemptible?: boolean; acceptTimeoutMs?: number; timeoutMs?: number } | undefined; resolve: () => void; reject: (e: Error) => void }[] = []
  let active: (typeof runs)[number] | null = null
  const state = { connected: true, other: null as BridgeJob | null, cancels: [] as string[] }
  const bridge = {
    port: 34877,
    listening: true,
    connected: () => state.connected,
    current: () => state.other ?? active?.job ?? null,
    run(job: BridgeJob, handler: Handler, opts?: { preemptible?: boolean }) {
      return new Promise<void>((resolve, reject) => {
        const r = { job, handler, opts, resolve, reject }
        runs.push(r)
        active = r
      })
    },
    cancel(reason = 'cancelled') {
      state.cancels.push(reason)
      const a = active
      active = null
      a?.reject(new BridgeError('cancelled', reason))
    }
  }
  return {
    bridge,
    runs,
    state,
    // The module's poll: what Forge answers.
    poll: (version: number, plays: number, cam = '') => (runs.at(-1)!.handler({ type: 'log', message: `forge-live-poll ${version} ${plays}${cam ? ` ${cam}` : ''}` }, 0) as { live: { version: number; label: string; stop?: boolean; effect?: { source: string; name: string } } }).live,
    // Another Studio job takes the bridge (the real bridge rejects the live job with PREEMPTED).
    preempt(job: BridgeJob) {
      const a = active
      active = null
      state.other = job
      a?.reject(new BridgeError('cancelled', PREEMPTED))
    },
    end() {
      const a = active
      active = null
      a?.resolve()
    },
    fail(message: string) {
      const a = active
      active = null
      a?.reject(new BridgeError('not-accepted', message))
    }
  }
}

function controller(opts: { refining?: Set<string> } = {}) {
  const clock = fakeClock()
  const b = fakeBridge()
  const events: LiveStatus[] = []
  const logs: string[] = []
  const live = new LiveStudio({ bridge: () => b.bridge, emit: (_e, s) => events.push(s), log: (t) => logs.push(t), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, tickMs: 1000, isRefining: (id) => opts.refining?.has(id) ?? false })
  return { clock, b, events, logs, live }
}

test('live controller: starts one preemptible job, answers polls, edits apply after the debounce, iterations replace at once', async () => {
  const refining = new Set<string>()
  const { clock, b, events, live } = controller({ refining })
  assert.equal(live.status().state, 'off')
  live.start({ current: { key: 'e1', effect: fx('Fireball', 10), label: 'Fireball' } })
  assert.equal(b.runs.length, 1)
  assert.equal(b.runs[0].opts?.preemptible, true)
  assert.match(b.runs[0].job.modules[1].source ?? '', /local FRAME = true/)
  assert.equal(live.status().state, 'starting')
  // First poll: the effect.
  const first = b.poll(-1, 0)
  assert.equal(first.version, 1)
  assert.equal(first.effect?.name, 'Fireball')
  assert.equal(live.status().state, 'looping')
  assert.equal(live.status().name, 'Fireball')
  assert.equal(b.poll(1, 1).effect, undefined)
  assert.equal(live.status().plays, 1)
  // A parameter edit: debounced (~300 ms), then the next poll gets version 2.
  live.setCurrent({ key: 'e1', effect: fx('Fireball', 50), label: 'Fireball' })
  await clock.advance(100)
  assert.equal(b.poll(1, 2).effect, undefined)
  await clock.advance(250)
  const edited = b.poll(1, 2)
  assert.equal(edited.version, 2)
  assert.match(edited.effect!.source, /"Rate",50[,}]/)
  // Refine iterations replace what loops at once, labelled; the score arrives later as a label.
  refining.add('e1')
  live.draft('e1', 2, fx('Fireball', 70))
  const it2 = b.poll(2, 3)
  assert.equal(it2.version, 3)
  assert.equal(it2.label, 'Fireball · iteration 2')
  live.draft('e1', 2, fx('Fireball', 70), 7.4)
  const scored = b.poll(3, 4)
  assert.equal(scored.version, 3, 'a score is a label change only')
  assert.equal(scored.label, 'Fireball · iteration 2 · 7.4/10')
  assert.equal(live.status().label, 'Fireball · iteration 2 · 7.4/10')
  // While refining, the lab's copy of the entry does not replace the iteration.
  live.setCurrent({ key: 'e1', effect: fx('Fireball', 10), label: 'Fireball' })
  await clock.advance(400)
  assert.equal(b.poll(3, 5).version, 3)
  // Another entry is picked: it loops instead (Live follows the selection).
  refining.clear()
  live.setCurrent({ key: 'e2', effect: fx('Frost', 5), label: 'Frost' })
  await clock.advance(400)
  const next = b.poll(3, 6)
  assert.equal(next.version, 4)
  assert.equal(next.effect?.name, 'Frost')
  assert.equal(b.runs.length, 1, 'still the same job')
  // Another place (origin): the module is told to stop, the next job plays there and frames it.
  live.setSettings({ mode: 'origin', gap: 0.25 })
  assert.equal(b.poll(4, 7).stop, true)
  b.end()
  await flush()
  assert.equal(b.runs.length, 2)
  const src2 = b.runs[1].job.modules[1].source ?? ''
  assert.match(src2, /local MODE = "origin"/)
  assert.match(src2, /local FRAME = true/)
  const again = b.poll(-1, 7)
  assert.equal(again.version, 4)
  assert.equal((again as { gap?: number }).gap, 0.25)
  // The module reports a broken version.
  b.runs[1].handler({ type: 'log', message: 'forge-live-error 4 attempt to index nil' }, 0)
  assert.equal(live.status().error, 'attempt to index nil')
  assert.ok(events.length >= 4)
  live.dispose()
})

test('live controller: steps aside for other Studio jobs and resumes with the user\'s camera; waits for Studio', async () => {
  const { clock, b, live } = controller()
  b.state.connected = false
  live.start({ current: { key: 'e1', effect: fx('Aura'), label: 'Aura' } })
  assert.equal(b.runs.length, 0)
  assert.equal(live.status().state, 'waiting')
  assert.match(live.status().message ?? '', /Waiting for Roblox Studio/)
  b.state.connected = true
  await clock.advance(1000)
  assert.equal(b.runs.length, 1)
  b.poll(-1, 0)
  b.poll(1, 3, CAM)
  // A Studio check capture takes the bridge: the live job is preempted, Forge waits.
  b.preempt({ id: 'job-check' } as BridgeJob)
  await flush()
  assert.equal(live.status().state, 'paused')
  await clock.advance(3000)
  assert.equal(b.runs.length, 1, 'no restart while the other job runs')
  // The capture is done: the loop comes back, no reframing, the camera where the user had it.
  b.state.other = null
  await clock.advance(1000)
  assert.equal(b.runs.length, 2)
  const src = b.runs[1].job.modules[1].source ?? ''
  assert.match(src, /local FRAME = false/)
  assert.match(src, /local RESTORE_CAMERA = CFrame\.new\(1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1\)/)
  assert.equal(b.poll(-1, 3).version, 1, 'the module starts over with the current version')
  assert.equal(live.status().state, 'looping')
  // A job that fails (not a preemption) shows the error and is retried with a back-off; a poll
  // clears it; three failed starts in a row give up.
  b.fail('Studio did not pick up the job')
  await flush()
  assert.equal(live.status().error, 'Studio did not pick up the job')
  await clock.advance(1000)
  assert.equal(b.runs.length, 2, 'not at once')
  await clock.advance(1000)
  assert.equal(b.runs.length, 3)
  b.poll(-1, 3)
  assert.equal(live.status().error, undefined)
  assert.equal(live.status().state, 'looping')
  b.fail('one')
  await flush()
  await clock.advance(2000)
  assert.equal(b.runs.length, 4)
  // Ended before it ever polled: a failed start too.
  b.end()
  await flush()
  await clock.advance(4000)
  assert.equal(b.runs.length, 5)
  b.fail('three')
  await flush()
  assert.equal(live.status().state, 'off')
  assert.equal(live.status().error, 'three')
  await clock.advance(10_000)
  assert.equal(b.runs.length, 5, 'given up')
  // Starting again clears it.
  live.start({})
  assert.equal(live.status().error, undefined)
  assert.equal(b.runs.length, 6)
  live.dispose()
})

test('live controller: a Loop while Live is on returns to following; the header toggle off keeps a Loop', async () => {
  const { clock, b, live } = controller()
  live.start({})
  assert.equal(live.status().following, true)
  assert.equal(live.status().state, 'waiting', 'nothing current yet')
  live.setCurrent({ key: 'e1', effect: fx('One'), label: 'One' })
  await clock.advance(LIVE_DEBOUNCE_MS)
  assert.equal(b.runs.length, 1)
  b.poll(-1, 0)
  // Loop on e2 (Test in Studio > Loop).
  live.start({ pin: 'e2', current: { key: 'e2', effect: fx('Two'), label: 'Two' } })
  assert.equal(live.status().pinned, 'e2')
  assert.equal(live.status().following, true)
  assert.equal(b.poll(1, 1).effect?.name, 'Two')
  // Turning Live on again does not end the Loop.
  live.start({})
  assert.equal(live.status().pinned, 'e2')
  // Another entry: Live follows it (the Loop ends, the job keeps running).
  live.setCurrent({ key: 'e3', effect: fx('Three'), label: 'Three' })
  assert.equal(live.status().pinned, null)
  await clock.advance(LIVE_DEBOUNCE_MS)
  assert.equal(b.poll(2, 2).effect?.name, 'Three')
  // Stop on a Loop while Live is on: back to following, same job.
  live.start({ pin: 'e3' })
  assert.equal(live.stopLoop().pinned, null)
  assert.equal(live.status().state, 'looping')
  // Header toggle off while a Loop runs: the Loop keeps going, then stops for good.
  live.start({ pin: 'e3' })
  assert.equal(live.unfollow().state, 'looping')
  assert.equal(live.status().following, false)
  assert.equal(live.stopLoop().state, 'off')
  // Header toggle off with no Loop: off.
  live.start({})
  assert.equal(live.unfollow().state, 'off')
  assert.equal(b.runs.length, 1)
  live.dispose()
})

test('live controller: Stop answers stop, cancels a job that does not end, and nothing restarts; Loop stops when another entry is picked', async () => {
  const { clock, b, live, logs } = controller()
  live.start({ pin: 'e1', current: { key: 'e1', effect: fx('Slash'), label: 'Slash' }, settings: { gap: 2 } })
  assert.equal(live.status().pinned, 'e1')
  assert.equal(b.poll(-1, 0).version, 1)
  live.stop()
  assert.equal(live.status().state, 'off')
  assert.equal(b.poll(1, 1).stop, true, 'the module stops and removes its folder')
  // It did not end by itself: cancelled after 1.5 s.
  await clock.advance(1600)
  assert.deepEqual(b.state.cancels, ['live preview stopped'])
  await clock.advance(5000)
  assert.equal(b.runs.length, 1, 'no restart after Stop')
  // Loop pinned to e1; the lab selects e2 -> the loop stops.
  live.start({ pin: 'e1', current: { key: 'e1', effect: fx('Slash'), label: 'Slash' } })
  assert.equal(b.runs.length, 2)
  b.poll(-1, 0)
  live.setCurrent({ key: 'e2', effect: fx('Other'), label: 'Other' })
  assert.equal(live.status().state, 'off')
  assert.ok(logs.some((l) => /no longer selected/.test(l)))
  // The module ends on its own (answered stop): no cancel needed.
  b.end()
  await clock.advance(2000)
  assert.equal(b.state.cancels.length, 1)
  // Forge closing: the running job is cancelled at once.
  live.start({ current: { key: 'e3', effect: fx('Third'), label: 'Third' } })
  b.poll(-1, 0)
  live.dispose()
  assert.deepEqual(b.state.cancels.at(-1), 'Forge closed')
  assert.equal(live.status().state, 'off')
  await clock.advance(10_000)
  assert.equal(clock.pending(), 0, 'no timers left')
})

// ------------------------------------------------------------------ bridge preemption (real HTTP)

test('bridge: a preemptible job does not block others and is cancelled when another job runs', async () => {
  const b = new StudioBridge({ port: 0, holdMs: 100 })
  await b.start()
  try {
    const liveJ = liveJob({ id: 'job-live-a', port: b.port, mode: 'dummy', frame: true })
    const running = b.run(liveJ, () => ({}), { preemptible: true })
    running.catch(() => undefined)
    assert.equal(b.busy(), null, 'Studio checks do not see it as busy')
    assert.equal(b.current()?.id, 'job-live-a')
    const other: BridgeJob = { ...liveJob({ id: 'job-check-b', port: b.port, mode: 'dummy', frame: true }), name: 'check' }
    const second = b.run(other, () => ({}), { acceptTimeoutMs: 150 })
    second.catch(() => undefined)
    await assert.rejects(running, (e: unknown) => e instanceof BridgeError && e.code === 'cancelled' && e.message === PREEMPTED)
    assert.equal(b.busy()?.id, 'job-check-b')
    // The live module's next poll is told to stop.
    const res = await (await fetch(`http://127.0.0.1:${b.port}/forge-bridge/event/job-live-a`, { method: 'POST', body: JSON.stringify({ type: 'log', message: 'forge-live-poll 1 1' }) })).json()
    assert.equal(res.abort, true)
    // Non-preemptible jobs still refuse each other.
    await assert.rejects(b.run({ ...other, id: 'job-c' }, () => ({})), /already running/)
    await assert.rejects(second, (e: unknown) => e instanceof BridgeError && e.code === 'not-accepted')
  } finally {
    await b.stop()
  }
})

// ------------------------------------------------------------------ Luau compiles (Lune)

function findLune(): string | null {
  for (const c of [process.env.LUNE_PATH, 'lune']) {
    if (!c) continue
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' })
      return c
    } catch {
      /* next */
    }
  }
  return null
}
const lune = findLune()

test('the live and Studio import modules compile (Lune)', { skip: !lune ? 'Lune not installed (set LUNE_PATH)' : false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfxlive-luau-'))
  const files: Record<string, string> = {
    'live_frame.luau': liveModuleSource({ port: 34877, jobId: 'job-live-1', mode: 'dummy', frame: true }),
    'live_resume.luau': liveModuleSource({ port: 34877, jobId: 'job-live-2', mode: 'origin', frame: false, camera: [1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1] }),
    'select.luau': studioImportModuleSource({ port: 34877, jobId: 'job-sel-1' }),
    'paths.luau': studioImportModuleSource({ port: 34877, jobId: 'job-sel-2', paths: [[{ name: 'Workspace', index: 0 }, { name: 'VFX', index: 2 }]] })
  }
  for (const [f, src] of Object.entries(files)) await writeFile(join(dir, f), src)
  await writeFile(join(dir, 'check.luau'), `local luau = require("@lune/luau")\nlocal fs = require("@lune/fs")\nfor _, f in { ${Object.keys(files).map((f) => `"${f}"`).join(', ')} } do\n  luau.compile(fs.readFile(f))\nend\nprint("ok")\n`)
  const out = await new Promise<string>((res, rej) => execFile(lune!, ['run', 'check.luau'], { cwd: dir }, (err, stdout, stderr) => (err ? rej(new Error(stderr || err.message)) : res(stdout))))
  assert.match(out, /ok/)
})
