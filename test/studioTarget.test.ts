// Studio target (several Roblox Studio places open) and the Script Injection error: which place a
// Forge Bridge job goes to (a real HTTP bridge and fake plugins for two places: a targeted job only
// reaches its place, untargeted jobs keep going to whoever polls, a target that is not connected
// falls back to any window, a live job moves when the target changes), the picker's state per
// project (defaults: linked place, then the newest), deletes going to the linked place, and Studio's
// "Unable to assign property Source" recognised from any job: its own error code, the live loop
// stopping instead of retrying, one toast with the steps instead of one per failure.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BridgeJob } from '../src/shared/studio/protocol.ts'
import { PLUGIN_VERSION } from '../src/shared/studio/plugin.ts'
import { cleanTarget, matchesTarget, placeLabel, resolveTarget, sameTarget, STUDIO_TARGETS_SETTING, targetKey, type StudioPlace, type StudioTarget } from '../src/shared/studio/target.ts'
import { isScriptInjectionError, scriptInjectionToasts, SCRIPT_INJECTION_CODE, SCRIPT_INJECTION_MESSAGE, SCRIPT_INJECTION_STEPS, SCRIPT_INJECTION_TITLE } from '../src/shared/studio/errors.ts'
import { BridgeError, RETARGETED, StudioBridge } from '../src/main/services/studio/bridge.ts'
import { studioTargets } from '../src/main/services/studio/wire.ts'
import { deleteInStudio, deleteJob, DELETE_PLUGIN_VERSION } from '../src/main/services/studio/deleteInstance.ts'
import { LiveStudio, type LiveStatus } from '../src/main/services/vfx/live.ts'
import { effectFromSpec } from '../src/shared/vfx/spec.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const job = (): BridgeJob => deleteJob(['Workspace', 'Thing'], 'Part', `job-${Math.random().toString(36).slice(2)}`)

const place = (key: string, over: Partial<StudioPlace> = {}): StudioPlace => {
  const [id, name] = key.split('|')
  return { key, ...(Number(id) ? { placeId: Number(id) } : {}), ...(name ? { place: name } : {}), lastSeen: 100, since: 0, ...over }
}

// ------------------------------------------------------------------ pure parts

test('target: matching, keys, cleaning, labels', () => {
  // Published places by PlaceId, unpublished ones (PlaceId 0) by name.
  assert.ok(matchesTarget({ placeId: 42, place: 'Old name' }, { placeId: 42, place: 'Arena' }))
  assert.ok(!matchesTarget({ placeId: 42 }, { placeId: 43, place: 'Arena' }))
  assert.ok(matchesTarget({ place: 'Place1' }, { place: 'Place1' }))
  assert.ok(!matchesTarget({ place: 'Arena' }, { placeId: 42, place: 'Arena' }), 'a name does not match a published place')
  assert.ok(!matchesTarget({}, { place: 'Place1' }))
  assert.equal(targetKey({ placeId: 42, place: 'Arena' }), '42|Arena')
  assert.equal(targetKey({ place: 'Place1' }), '0|Place1')
  assert.ok(sameTarget(null, undefined))
  assert.ok(!sameTarget({ place: 'A' }, null))
  assert.deepEqual(cleanTarget({ placeId: 42, place: 'Arena', extra: 1 }), { placeId: 42, place: 'Arena' })
  assert.deepEqual(cleanTarget({ placeId: -3, place: 'Place1' }), { place: 'Place1' })
  assert.equal(cleanTarget({ placeId: 0, place: '  ' }), null)
  assert.equal(cleanTarget('Arena'), null)
  assert.equal(placeLabel({ placeId: 42, place: 'Arena' }), 'Arena (42)')
  assert.equal(placeLabel({}), 'Untitled place')
})

test('target: resolve picks the chosen place, else the linked one, else the newest; a lost choice is untargeted', () => {
  const a = place('111|Arena', { since: 10 })
  const b = place('0|Place1', { since: 20 })
  const c = place('222|Lobby', { since: 5 })
  assert.deepEqual(resolveTarget([], null), { target: null, why: 'none' })
  assert.deepEqual(resolveTarget([a], null), { target: null, why: 'single' })
  assert.deepEqual(resolveTarget([a, b], null), { target: b, why: 'newest' })
  assert.deepEqual(resolveTarget([a, b, c], null, [222]), { target: c, why: 'linked' })
  assert.deepEqual(resolveTarget([a, b], { placeId: 111 }), { target: a, why: 'chosen' })
  // The chosen place is gone: any window (not another place picked silently).
  assert.deepEqual(resolveTarget([b, c], { placeId: 111 }, [222]), { target: null, why: 'lost' })
  // One window that is the chosen one: still targeted.
  assert.deepEqual(resolveTarget([b], { place: 'Place1' }), { target: b, why: 'chosen' })
})

test('script injection: Studio\'s texts are recognised; toasts collapse to one with the steps', () => {
  assert.ok(isScriptInjectionError('Unable to assign property Source. Script write access is restricted'))
  assert.ok(isScriptInjectionError('Studio: ForgeBridge:108: Script write access is restricted'))
  assert.ok(isScriptInjectionError(SCRIPT_INJECTION_MESSAGE))
  assert.ok(!isScriptInjectionError('could not create the R15 dummy'))
  assert.ok(!isScriptInjectionError(undefined))
  assert.ok(SCRIPT_INJECTION_MESSAGE.includes('Plugins tab > Manage Plugins > Forge Bridge > edit (pencil) > turn on Script Injection'))
  let now = 0
  const gate = scriptInjectionToasts(30_000, () => now)
  const shown: ({ text: string; detail?: string; kind?: string } | null)[] = []
  // The live loop's retries, a Studio check, an import: the same refusal several times.
  for (let i = 0; i < 4; i++) {
    shown.push(gate({ text: 'Live in Studio', detail: 'Studio: Unable to assign property Source. Script write access is restricted', kind: 'err' }))
    now += 2000
  }
  shown.push(gate({ text: 'Studio check failed', detail: SCRIPT_INJECTION_MESSAGE, kind: 'err' }))
  const kept = shown.filter(Boolean)
  assert.equal(kept.length, 1)
  assert.deepEqual({ text: kept[0]!.text, detail: kept[0]!.detail, kind: kept[0]!.kind }, { text: SCRIPT_INJECTION_TITLE, detail: SCRIPT_INJECTION_STEPS, kind: 'err' })
  // Other toasts are untouched; after the gap the next refusal is shown again.
  const other = { text: 'Import failed', detail: 'bad file', kind: 'err' }
  assert.equal(gate(other), other)
  now += 30_000
  assert.equal(gate({ text: 'Live in Studio', detail: 'Unable to assign property Source' })?.text, SCRIPT_INJECTION_TITLE)
})

// ------------------------------------------------------------------ bridge (real HTTP, two places)

async function bridge(target?: () => StudioTarget | null): Promise<StudioBridge> {
  const b = new StudioBridge({ port: 0, holdMs: 300, ...(target ? { target } : {}) })
  await b.start()
  return b
}

function plugin(b: StudioBridge, name: string, placeId: number) {
  const base = `http://127.0.0.1:${b.port}/forge-bridge`
  return {
    poll: async (): Promise<{ job?: BridgeJob; idle?: boolean }> => (await fetch(`${base}/poll?v=${PLUGIN_VERSION}&place=${encodeURIComponent(name)}&placeId=${placeId}`)).json(),
    post: async (j: BridgeJob, ev: unknown): Promise<Record<string, unknown>> => (await fetch(`${base}/event/${j.id}`, { method: 'POST', body: JSON.stringify(ev) })).json()
  }
}

test('bridge: a targeted job only reaches its place; untargeted jobs go to whoever polls', async () => {
  const b = await bridge()
  const arena = plugin(b, 'Arena', 111)
  const local = plugin(b, 'Place1', 0)
  try {
    await Promise.all([arena.poll(), local.poll()])
    assert.deepEqual(b.studios().map((s) => targetKey(s)).sort(), ['0|Place1', '111|Arena'])
    // Both windows hold a poll; the job is for Place1 (unpublished: by name).
    const holdA = arena.poll()
    const holdL = local.poll()
    await sleep(30)
    const j = job()
    const run = b.run(j, () => ({}), { target: { place: 'Place1' } })
    const [gotA, gotL] = await Promise.all([holdA, holdL])
    assert.deepEqual(gotA, { idle: true }, 'Arena must not get a job for Place1')
    assert.equal(gotL.job?.id, j.id)
    await local.post(j, { type: 'accepted' })
    await local.post(j, { type: 'done', marks: [] })
    await run
    // Queued before anyone polls: Arena polls first and still does not get it; Place1 does.
    const j2 = job()
    const run2 = b.run(j2, () => ({}), { target: { placeId: 111 } })
    run2.catch(() => undefined)
    assert.deepEqual(await local.poll(), { idle: true })
    assert.equal((await arena.poll()).job?.id, j2.id)
    await arena.post(j2, { type: 'error', message: 'could not create the R15 dummy' })
    await assert.rejects(run2, (e: unknown) => e instanceof BridgeError && e.code === 'plugin-error')
    // Untargeted (today's behaviour): the first poll takes it.
    const j3 = job()
    const run3 = b.run(j3, () => ({}), { target: null })
    assert.equal((await local.poll()).job?.id, j3.id)
    await local.post(j3, { type: 'done', marks: [] })
    await run3
  } finally {
    await b.stop()
  }
})

test('bridge: the default target applies to every job; one that is not connected falls back to any window', async () => {
  let want: StudioTarget | null = { placeId: 111 }
  const b = await bridge(() => want)
  const arena = plugin(b, 'Arena', 111)
  const local = plugin(b, 'Place1', 0)
  try {
    await Promise.all([arena.poll(), local.poll()])
    assert.equal(b.targetStudio()?.place, 'Arena')
    const j = job()
    const run = b.run(j, () => ({}))
    assert.deepEqual(await local.poll(), { idle: true })
    assert.equal((await arena.poll()).job?.id, j.id)
    await arena.post(j, { type: 'done', marks: [] })
    await run
    // The chosen place closed (never polled): the job goes to whichever window polls.
    want = { placeId: 999, place: 'Gone' }
    assert.equal(b.targetStudio(), null)
    const j2 = job()
    const run2 = b.run(j2, () => ({}))
    assert.equal((await local.poll()).job?.id, j2.id)
    await local.post(j2, { type: 'done', marks: [] })
    await run2
    // A targeted job nobody of that place picks up says which place.
    want = { placeId: 111 }
    const j3 = job()
    const run3 = b.run(j3, () => ({}), { acceptTimeoutMs: 150 })
    run3.catch(() => undefined)
    assert.deepEqual(await local.poll(), { idle: true })
    await assert.rejects(run3, (e: unknown) => e instanceof BridgeError && e.code === 'not-accepted' && /Arena \(111\) did not pick up/.test(e.message))
  } finally {
    await b.stop()
  }
})

test('bridge: a live (preemptible) job in another place stops when the Studio target changes', async () => {
  let want: StudioTarget | null = null
  const b = await bridge(() => want)
  const arena = plugin(b, 'Arena', 111)
  const local = plugin(b, 'Place1', 0)
  try {
    await Promise.all([arena.poll(), local.poll()])
    const j = job()
    const run = b.run(j, () => ({}), { preemptible: true })
    run.catch(() => undefined)
    assert.equal((await arena.poll()).job?.id, j.id)
    await arena.post(j, { type: 'accepted' })
    // Same place: nothing happens.
    want = { placeId: 111 }
    b.retarget()
    assert.equal(b.current()?.id, j.id)
    // Another place: the job is cancelled (it restarts there); the module is told to stop.
    want = { place: 'Place1' }
    b.retarget()
    await assert.rejects(run, (e: unknown) => e instanceof BridgeError && e.code === 'cancelled' && e.message === RETARGETED)
    assert.equal((await arena.post(j, { type: 'log', message: 'forge-live-poll 1 1' })).abort, true)
    assert.equal(b.current(), null)
  } finally {
    await b.stop()
  }
})

test('bridge: Studio refusing script writes is its own error code with the steps', async () => {
  const b = await bridge()
  const arena = plugin(b, 'Arena', 111)
  try {
    const j = job()
    const run = b.run(j, () => ({}))
    run.catch(() => undefined)
    assert.equal((await arena.poll()).job?.id, j.id)
    await arena.post(j, { type: 'error', message: 'Unable to assign property Source. Script write access is restricted' })
    await assert.rejects(run, (e: unknown) => e instanceof BridgeError && e.code === SCRIPT_INJECTION_CODE && e.message === SCRIPT_INJECTION_MESSAGE)
  } finally {
    await b.stop()
  }
})

// ------------------------------------------------------------------ picker state, per project

test('wiring: the Studio target is kept per project; defaults to the linked place; a lost choice falls back', () => {
  const store = new Map<string, unknown>()
  const settings = { get: <T>(k: string, f: T) => (store.has(k) ? (store.get(k) as T) : f), set: (k: string, v: unknown) => void store.set(k, v) }
  let root = '/games/arena'
  let linked: number[] = []
  let studios = [
    { lastSeen: 5, since: 1, place: 'Arena', placeId: 111, pluginVersion: PLUGIN_VERSION },
    { lastSeen: 5, since: 3, place: 'Place1', pluginVersion: PLUGIN_VERSION }
  ]
  const t = studioTargets({ settings, projectRoot: () => root, linkedPlaceIds: () => linked }, () => studios)
  // Nothing chosen: the newest window.
  assert.equal(t.view().target, '0|Place1')
  assert.equal(t.view().why, 'newest')
  assert.deepEqual(t.target(), { place: 'Place1' })
  // The project's active place is linked to Arena.
  linked = [111]
  assert.equal(t.view().target, '111|Arena')
  assert.equal(t.view().places.find((p) => p.key === '111|Arena')?.linked, true)
  // Picked for this project only.
  t.set({ place: 'Place1' })
  assert.equal(t.view().target, '0|Place1')
  assert.deepEqual(store.get(STUDIO_TARGETS_SETTING), { '/games/arena': { place: 'Place1' } })
  root = '/games/lobby'
  assert.equal(t.view().chosen, null)
  assert.equal(t.view().target, '111|Arena')
  root = '/games/arena'
  // Place1 closes: untargeted until it is back, the choice kept.
  studios = studios.slice(0, 1)
  assert.deepEqual({ target: t.view().target, why: t.view().why, chosen: t.view().chosen }, { target: null, why: 'lost', chosen: { place: 'Place1' } })
  assert.equal(t.target(), null)
  // Cleared.
  t.set(null)
  assert.deepEqual(store.get(STUDIO_TARGETS_SETTING), {})
  assert.equal(t.view().why, 'single')
})

test('delete in Studio goes to the place the active place file syncs with', async () => {
  const opts: unknown[] = []
  const bridge = { connected: () => true, studio: () => ({ pluginVersion: DELETE_PLUGIN_VERSION }), busy: () => null, run: async (_j: BridgeJob, _h: unknown, o?: unknown) => void opts.push(o) }
  await deleteInStudio({ bridge, refusal: () => null, place: async () => ({ placeId: 111 }) }, ['Workspace', 'Old'])
  await deleteInStudio({ bridge, refusal: () => null }, ['Workspace', 'Old'])
  assert.deepEqual((opts[0] as { target?: unknown }).target, { placeId: 111 })
  assert.equal((opts[1] as { target?: unknown }).target, undefined, 'no linked place: the default target')
})

// ------------------------------------------------------------------ live loop

test('live: Studio refusing script writes stops the loop at once (no retries, one error status)', async () => {
  const runs: { job: BridgeJob; reject: (e: Error) => void }[] = []
  const timers: (() => void)[] = []
  const bridge = {
    port: 34877,
    listening: true,
    connected: () => true,
    current: () => null,
    run: (j: BridgeJob) => new Promise<void>((_resolve, reject) => void runs.push({ job: j, reject }))
  }
  const events: LiveStatus[] = []
  const live = new LiveStudio({ bridge: () => bridge, emit: (_e, s) => events.push(s), now: () => 0, setTimer: (fn) => (timers.push(fn), fn), clearTimer: () => undefined })
  const fx = effectFromSpec({ name: 'Fireball', duration: 1, layers: [{ name: 'Sparks', class: 'ParticleEmitter', props: { Rate: 10 }, emit: [{ at: 0, count: 5 }] }] })
  live.start({ current: { key: 'e1', effect: fx, label: 'Fireball' } })
  assert.equal(runs.length, 1)
  runs[0].reject(new BridgeError('script-injection', SCRIPT_INJECTION_MESSAGE))
  await sleep(0)
  // Every pending timer (ticks, retry back-off) runs: nothing starts again.
  for (let i = 0; i < 10 && timers.length; i++) timers.shift()!()
  await sleep(0)
  assert.equal(runs.length, 1, 'retried a job Studio cannot run')
  const st = live.status()
  assert.equal(st.state, 'off')
  assert.equal(st.errorCode, 'script-injection')
  assert.equal(st.error, SCRIPT_INJECTION_MESSAGE)
  // The lab toasts once per distinct error: only one status carried it.
  assert.equal(new Set(events.filter((e) => e.error).map((e) => e.error)).size, 1)
  assert.equal(events.filter((e) => e.error && e.state !== 'looping').length, 1)
  // A raw Studio message (an older code path) is recognised too.
  live.start({ current: { key: 'e1', effect: fx, label: 'Fireball' } })
  assert.equal(live.status().errorCode, undefined, 'a new start clears the error')
  runs[1].reject(new BridgeError('plugin-error', 'Studio: Unable to assign property Source. Script write access is restricted'))
  await sleep(0)
  for (let i = 0; i < 10 && timers.length; i++) timers.shift()!()
  await sleep(0)
  assert.equal(runs.length, 2)
  assert.equal(live.status().errorCode, 'script-injection')
  live.dispose()
})
