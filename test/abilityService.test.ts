// Ability Composer service: compose fallbacks (library, vfx_compose / anim_compose tools, examples,
// placeholder), model timings with validation, critique with a fake vision critic and capture, ratings
// into memory, the choreography skill, and the game export into FSF-like and GenTree-style projects.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AnimClipRef } from '../src/shared/anim/types.ts'
import type { VfxEntry } from '../src/shared/vfx/types.ts'
import { compileTimeline } from '../src/shared/vfx/compile.ts'
import { findExample } from '../src/shared/vfx/examples.ts'
import { RECORDED } from '../src/shared/vfx/examples.recorded.ts'
import { markerTime, resolveAbility } from '../src/shared/ability/timing.ts'
import { isOwnRunner } from '../src/shared/ability/luau.ts'
import { timingChecks, vfxReleaseStage } from '../src/shared/ability/critique.ts'
import { AbilityService, idFromToolText, type LabTier, type MemoryLike, type ModelFn, type RegistryTool, type VfxLabLike } from '../src/main/services/ability/service.ts'
import { abilityTools } from '../src/main/services/ability/tools.ts'
import { makeProject } from './fixture.ts'

function vfxEntry(key: string, extra: Partial<VfxEntry> = {}): VfxEntry {
  const ex = findExample(key)!
  const effect = compileTimeline({ name: ex.name, roots: [], cues: [], duration: 2 }, RECORDED[ex.key], ex.script).effect
  return { id: `${key}-ex`, scope: 'project', kind: 'generated', name: ex.name, description: ex.description, tags: [...ex.tags], createdAt: 1, updatedAt: 1, origin: `example:${key}`, effect, thumbs: [], ...extra } as VfxEntry
}

function fakeVfx(initial: VfxEntry[] = []): VfxLabLike & { entries: VfxEntry[]; written: string[] } {
  const entries = [...initial]
  const written: string[] = []
  return {
    entries,
    written,
    async get(id) {
      const e = entries.find((x) => x.id === id)
      if (!e) throw new Error(`no ${id}`)
      return e
    },
    async list() {
      return entries
    },
    async search(q) {
      const w = q.toLowerCase().split(/\W+/).filter((x) => x.length > 3)
      return entries.filter((e) => w.some((x) => `${e.name} ${e.tags.join(' ')}`.toLowerCase().includes(x)))
    },
    async addExample(key) {
      const prev = entries.find((e) => e.origin === `example:${key}`)
      if (prev) return prev
      const e = vfxEntry(key)
      entries.push(e)
      return e
    },
    async writeProjectFiles(entry) {
      written.push(entry.id)
      const e = { ...entry, written: { module: `src/shared/VFX/${entry.effect!.name}/init.luau`, model: `src/shared/VFX/${entry.effect!.name}/Effect.rbxmx` } }
      entries.splice(entries.indexOf(entry), 1, e)
      return e
    }
  }
}

function fakeMemory(): MemoryLike & { saved: { name: string; kind?: string; type?: string; body: string }[] } {
  const saved: { name: string; kind?: string; type?: string; body: string }[] = []
  return {
    saved,
    async remember(input) {
      saved.push(input)
      return { entry: { name: input.name } }
    }
  }
}

function service(opts: { root?: string | null; vfx?: VfxLabLike; anim?: () => Promise<AnimClipRef[]>; tools?: RegistryTool[]; model?: (tier: LabTier) => ModelFn | null; memory?: MemoryLike; capture?: AbilityService['deps']['capture'] } = {}): AbilityService {
  let t = 1_000
  return new AbilityService({
    userDir: mkdtempSync(join(tmpdir(), 'ability-user-')),
    projectRoot: () => (opts.root === undefined ? null : opts.root),
    vfx: opts.vfx,
    anim: opts.anim,
    tools: opts.tools ? () => opts.tools! : undefined,
    model: opts.model,
    memory: opts.memory,
    capture: opts.capture,
    now: () => (t += 1000)
  })
}

const tool = (name: string, text: string, seen: unknown[] = []): RegistryTool => ({
  name,
  handler: async (args) => {
    seen.push(args)
    return { content: [{ type: 'text', text }] }
  }
})

test('idFromToolText reads the entry id from the first line of a compose tool result', () => {
  assert.equal(idFromToolText('purple-orb-1a: PurpleOrb (scripted, 3 stages)\nmore'), 'purple-orb-1a')
  assert.equal(idFromToolText('{"id": "clip-7", "name": "Smash"}'), 'clip-7')
  assert.equal(idFromToolText('Nothing made.'), null)
})

test('compose without labs or a model drafts a move on a placeholder clip and records the choreography skill', async () => {
  const memory = fakeMemory()
  const s = service({ memory })
  const r = await s.compose('a quick dash punch')
  assert.equal(r.timing, 'draft')
  assert.equal(r.vfx, null)
  assert.equal(r.animation?.source, 'placeholder')
  assert.ok(r.notes.some((n) => /placeholder/.test(n)))
  const a = r.entry.ability
  assert.ok(a.animation?.clip.startsWith('placeholder:'))
  const rel = markerTime(a, 'release')!
  const resolved = resolveAbility(a)
  for (const kind of ['shake', 'hitstop'] as const) {
    const ev = resolved.events.find((e) => e.kind === kind)!
    assert.ok(Math.abs(ev.start - rel) < 0.04, `${kind} on the release`)
  }
  assert.ok(memory.saved.some((m) => m.name === 'ability-choreography' && m.kind === 'skill'))
  assert.equal((await s.list()).length, 1)
  assert.equal(r.entry.scope, 'user')
})

test('compose uses a matching VFX library entry and an Animation Lab clip, putting the release stage on the release marker', async () => {
  const vfx = fakeVfx([vfxEntry('charge-slash')])
  const clip: AnimClipRef = { id: 'clip-slash', name: 'Charged slash', duration: 1.2, looped: false, markers: [{ name: 'anticipation', t: 0.2 }, { name: 'release', t: 0.7 }], scope: 'user' }
  const s = service({ vfx, anim: async () => [clip] })
  const r = await s.compose('a charged slash with blue sparks')
  assert.equal(r.vfx?.source, 'library')
  assert.equal(r.animation?.source, 'library')
  assert.equal(r.entry.ability.animation?.clip, 'clip-slash')
  const fx = r.entry.ability.events.find((e) => e.kind === 'vfx')!
  assert.equal(fx.kind === 'vfx' && fx.effect, 'charge-slash-ex')
  // The effect's release stage lands on the clip's release marker; its build-up is longer than the
  // clip's lead-in, so the clip starts later instead of the effect starting before the move.
  const stage = vfxReleaseStage(vfx.entries[0].effect!.stages)!
  const start = resolveAbility(r.entry.ability).events.find((e) => e.id === fx.id)!.start
  assert.ok(Math.abs(start + stage.at - markerTime(r.entry.ability, 'release')!) < 0.02, `vfx start ${start}, stage ${stage.label}`)
  assert.ok(r.entry.ability.animation!.start > 0)
  assert.ok(timingChecks(r.entry.ability, { vfx: () => 3, stages: () => vfx.entries[0].effect!.stages }).find((c) => c.rule === 'vfx-release-sync')?.ok)
})

test('compose falls back to vfx_compose and anim_compose tools when the libraries have nothing', async () => {
  const vfx = fakeVfx()
  const seenVfx: unknown[] = []
  const seenAnim: unknown[] = []
  const clips: AnimClipRef[] = []
  const tools = [
    {
      name: 'vfx_compose',
      handler: async (args: unknown) => {
        seenVfx.push(args)
        vfx.entries.push(vfxEntry('ground-slam', { id: 'slam-made-1', name: 'MadeSlam' }))
        return { content: [{ type: 'text' as const, text: 'slam-made-1: MadeSlam (scripted, 4 stages)' }] }
      }
    },
    {
      name: 'anim_compose',
      handler: async (args: unknown) => {
        seenAnim.push(args)
        clips.push({ id: 'anim-made-1', name: 'Overhead smash', duration: 1.4, looped: false, markers: [{ name: 'release', t: 0.66 }], scope: 'project' })
        return { content: [{ type: 'text' as const, text: 'anim-made-1: Overhead smash (1.4 s)' }] }
      }
    }
  ]
  const s = service({ vfx, tools, anim: async () => clips })
  const r = await s.compose('overhead smash into the floor')
  assert.equal(seenVfx.length, 1)
  assert.equal(seenAnim.length, 1)
  assert.equal(r.vfx?.source, 'vfx_compose')
  assert.equal(r.animation?.source, 'anim_compose')
  assert.equal(r.entry.ability.animation?.clip, 'anim-made-1')
})

test('compose asks the default tier, applies the JSON timing patch, and keeps the draft when the answer is unusable', async () => {
  const tiers: LabTier[] = []
  const good: ModelFn = async () => JSON.stringify({ events: [{ id: 'impact-shake', amplitude: 0.9 }], duration: 1.6 })
  const s = service({ model: (tier) => (tiers.push(tier), good) })
  const r = await s.compose('a heavy punch')
  assert.deepEqual(tiers, ['default'])
  assert.equal(r.timing, 'model')
  const shake = r.entry.ability.events.find((e) => e.id === 'impact-shake')
  assert.ok(shake && shake.kind === 'shake' && shake.amplitude === 0.9)
  assert.equal(r.entry.ability.duration, 1.6)

  const bad = service({ model: () => async () => 'I would make the shake bigger.' })
  const r2 = await bad.compose('a heavy punch')
  assert.equal(r2.timing, 'draft')
  assert.ok(r2.notes.some((n) => /model timing unusable/.test(n)))

  const invalid = service({ model: () => async () => JSON.stringify({ events: [{ id: 'x', kind: 'shake', at: { marker: 'nope', at: 0 } }] }) })
  const r3 = await invalid.compose('a heavy punch')
  assert.equal(r3.timing, 'draft')
})

test('critique runs the timing rules, the critic tier on captured frames at the key beats, and applies fixes', async () => {
  const tiers: LabTier[] = []
  const captured: number[][] = []
  const critic: ModelFn = async (_s, _p, images) => {
    assert.equal(images.length, 5)
    return JSON.stringify({ scores: { anticipation: 7, impact: 6, sync: 8, readability: 7, followThrough: 6 }, overall: 6.8, summary: 'Hit lands; flash too long.', changes: [{ event: 'impact-flash', field: 'release', value: 0.12, why: 'snappier' }] })
  }
  const s = service({ model: (tier) => (tiers.push(tier), tier === 'critic' ? critic : null), capture: async (req) => (captured.push(req.times), req.times.map(() => Buffer.from('png'))) })
  const made = await s.compose('a quick punch')
  // Knock the shake off the release so there is a fix to apply.
  const off = await s.save({ ...made.entry.ability, events: made.entry.ability.events.map((e) => (e.kind === 'shake' ? { ...e, at: { marker: 'release', at: 0.2 } } : e)) }, { id: made.entry.id })
  const r = await s.critique(off.id, { apply: true })
  assert.ok(tiers.includes('critic'))
  assert.equal(captured[0].length, 5)
  assert.equal(r.critique.frames.length, 5)
  assert.ok(existsSync(join((s as unknown as { deps: { userDir: string } }).deps.userDir, 'library', off.id, 'frames', 'critique-1.png')))
  assert.equal(r.critique.vision?.overall, 6.8)
  assert.ok(r.critique.checks.some((c) => c.rule === 'shake-on-release' && !c.ok))
  assert.ok(r.applied.some((a) => /shake-on-release/.test(a)))
  const shake = r.entry.ability.events.find((e) => e.kind === 'shake')!
  assert.deepEqual(shake.at, { marker: 'release', at: 0 })
  const flash = r.entry.ability.events.find((e) => e.id === 'impact-flash')
  assert.ok(flash && flash.kind === 'screen' && flash.release === 0.12)

  // Without a vision model: timing rules only.
  const plain = service()
  const m2 = await plain.compose('a quick punch')
  const r2 = await plain.critique(m2.entry.id)
  assert.equal(r2.critique.vision, undefined)
  assert.equal(r2.critique.overall, r2.critique.timingScore)
})

test('thumbs up saves the move as an example skill, thumbs down as avoid feedback', async () => {
  const memory = fakeMemory()
  const s = service({ memory })
  const m = await s.compose('a rising uppercut')
  const up = await s.rate(m.entry.id, 'up')
  assert.equal(up.quality, 'good')
  const skill = memory.saved.find((x) => x.name.startsWith('ability-example-'))!
  assert.equal(skill.kind, 'skill')
  assert.match(skill.body, /```json/)
  assert.match(skill.body, /release/)
  await s.rate(m.entry.id, 'down')
  assert.ok(memory.saved.some((x) => x.name.startsWith('ability-avoid-') && x.type === 'feedback'))
  const cleared = await s.rate(m.entry.id, null)
  assert.equal(cleared.rating, undefined)
  assert.equal(cleared.quality, undefined)
})

test('the Hollow Purple example adds the VFX Lab example and has no hitbox', async () => {
  const vfx = fakeVfx()
  const s = service({ vfx })
  const e = await s.addExample('hollow-purple')
  assert.ok(vfx.entries.some((x) => x.origin === 'example:hollow-purple'))
  const fx = e.ability.events.find((x) => x.kind === 'vfx')!
  assert.equal(fx.kind === 'vfx' && fx.effect, 'hollow-purple-ex')
  assert.ok(e.ability.events.every((x) => ['vfx', 'sound', 'shake', 'screen', 'hitstop', 'move'].includes(x.kind)))
  assert.equal((await s.addExample('hollow-purple')).id, e.id, 'adding twice returns the same entry')
  await assert.rejects(() => s.addExample('nope'), /no built-in ability example/)
})

test('export writes the client module and runner into an FSF-like project (src/skills/Client/Abilities)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ability-fsf-'))
  cpSync(resolve(import.meta.dirname, 'fixtures', 'fsf-like'), root, { recursive: true })
  const vfx = fakeVfx()
  const s = service({ root, vfx })
  const e = await s.addExample('hollow-purple')
  assert.equal(e.scope, 'project')
  assert.ok(existsSync(join(root, '.forge', 'abilities')))
  const r = await s.export(e.id)
  assert.deepEqual(r.files, ['src/skills/Client/Abilities/HollowPurple.luau', 'src/skills/Client/Abilities/AbilityRunner.luau'])
  assert.equal(r.requirePath, 'game.ReplicatedStorage.Shared.Skills.MatchController.Abilities.HollowPurple')
  assert.match(r.command!, /\.play\(game\.Players\.LocalPlayer\.Character\)/)
  assert.deepEqual(vfx.written, ['hollow-purple-ex'], 'the VFX module is written into the project first')
  const mod = readFileSync(join(root, r.files[0]), 'utf8')
  assert.equal(mod, r.source)
  assert.doesNotMatch(mod, /--/)
  assert.doesNotMatch(mod, /RemoteEvent|Blink|Hitbox|Damage/i)
  assert.ok(r.warnings.some((w) => /placeholder/.test(w)))
  // The VFX folder (src/shared/VFX) is not mapped in this fixture: the runner keeps its default and says so.
  assert.ok(r.warnings.some((w) => /VfxPath/.test(w)))
  const runner = readFileSync(join(root, r.files[1]), 'utf8')
  assert.ok(isOwnRunner(runner))
  assert.equal((await s.get(e.id)).written?.module, r.files[0])

  // A hand-edited runner is left alone.
  writeFileSync(join(root, r.files[1]), 'return {}\n')
  const again = await s.export(e.id)
  assert.equal(readFileSync(join(root, r.files[1]), 'utf8'), 'return {}\n')
  assert.ok(again.warnings.some((w) => /replaced by hand/.test(w)))
})

test('export into a GenTree-style project goes to src/shared/Abilities with the VFX path from the tree', async () => {
  const root = makeProject()
  const vfx = fakeVfx()
  const s = service({ root, vfx })
  const e = await s.addExample('hollow-purple')
  const r = await s.export(e.id)
  assert.equal(r.files[0], 'src/shared/Abilities/HollowPurple.luau')
  assert.equal(r.requirePath, 'game.ReplicatedStorage.Shared.Abilities.HollowPurple')
  assert.ok(!r.warnings.some((w) => /VfxPath/.test(w)))
  assert.match(readFileSync(join(root, r.files[1]), 'utf8'), /"ReplicatedStorage", "Shared", "VFX"/)
  await assert.rejects(() => service().export(e.id), /Open the game project/)
})

test('agent tools: ability_set creates and edits by id, ability_get reports checks, ability_critique explains fixes', async () => {
  const s = service()
  const { read, write } = abilityTools(s)
  const set = write.find((t) => t.name === 'ability_set')!
  const created = await set.handler({ ability: { name: 'Jab', duration: 1, animation: { clip: 'placeholder:strike', name: 'Strike', duration: 0.95, markers: [{ name: 'release', t: 0.32 }] }, events: [{ id: 'pop', kind: 'screen', effect: 'flash', at: { marker: 'release', at: 0 } }] } }, {})
  assert.ok(!created.isError, created.content[0].text)
  const id = (await s.list())[0].id
  const edited = await set.handler({ id, events: [{ id: 'kick', kind: 'shake', at: { marker: 'release', at: 0.1 } }] }, {})
  assert.match(edited.content[0].text, /kick/)
  const get = read.find((t) => t.name === 'ability_get')!
  const report = (await get.handler({ id }, {})).content[0].text
  assert.match(report, /timing checks/)
  assert.match(report, /hit-stop/)
  const crit = write.find((t) => t.name === 'ability_critique')!
  const out = (await crit.handler({ id }, {})).content[0].text
  assert.match(out, /shake "kick" starts 100 ms from the release/)
  assert.match(out, /no vision critic/)
  const bad = await set.handler({ id, events: [{ id: 'oops', kind: 'laser' }] }, {})
  assert.ok(bad.isError)
})
