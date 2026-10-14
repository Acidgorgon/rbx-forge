// "Restate first": the heuristic (when to restate), prompt assembly (the restate prompt, parsing,
// the confirmed blocks for chat / compose / critic, substantial edits, the memory note), the Restater
// (settings, Labs briefs, corrections into memory), the chat flow (card, confirm, persistence) and
// Labs persistence (restatement saved on the entry, in the compose prompt and the critic prompt).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { CHAT_THRESHOLD, decideRestate, parseRestateCommand } from '../src/shared/restate/heuristic.ts'
import {
  correctionNote,
  criticBrief,
  formatRestatement,
  isSubstantialEdit,
  parseRestatement,
  restatementBlock,
  restatePrompt,
  restateSystem,
  similarity,
  withRestatement,
  type RestateCorrection
} from '../src/shared/restate/prompt.ts'
import { normalizeRestatement, normalizeRestateSettings, type Restatement } from '../src/shared/restate/types.ts'
import { CORRECTIONS_SETTING, Restater } from '../src/main/agent/restate.ts'
import { ChatManager } from '../src/main/agent/chat.ts'
import { Credentials } from '../src/main/agent/credentials.ts'
import type { QueryFn } from '../src/main/agent/sdk.ts'
import { AbilityService, type LabTier, type ModelFn } from '../src/main/services/ability/service.ts'
import { VfxService } from '../src/main/services/vfx/service.ts'
import { compileTimeline } from '../src/shared/vfx/compile.ts'
import { findExample } from '../src/shared/vfx/examples.ts'
import { RECORDED } from '../src/shared/vfx/examples.recorded.ts'
import { fakeContext } from './agentFake.ts'

const R: Restatement = {
  goal: 'Players get a daily login reward that grows with their streak.',
  problem: 'Day-2 retention is low; nothing brings players back tomorrow.',
  assumptions: ['Coins only for now', 'Streak resets after 48 h', 'Reuse DataService']
}

// ---------------------------------------------------------------- heuristic

test('heuristic: trivial asks and questions skip, big multi-file multi-step requests restate', () => {
  const big = decideRestate(
    'Add a daily reward system: create `src/server/Features/Rewards/RewardService.luau`, update DataService.luau to save the streak, then wire a popup in RewardController and also add tests.',
    { mode: 'big' }
  )
  assert.equal(big.restate, true, big.reason)
  assert.ok(big.score >= CHAT_THRESHOLD)
  assert.match(big.reason, /files/)
  assert.match(big.reason, /actions/)

  for (const small of ['fix the typo in ShopService', 'what does ModuleLoader do?', 'rename Foo to Bar', 'ok thanks']) {
    assert.equal(decideRestate(small, { mode: 'big' }).restate, false, small)
  }
  // A listed plan counts.
  assert.equal(decideRestate('Please:\n- add a shop\n- add coins\n- add a leaderboard', { mode: 'big' }).restate, true)
  // Open-ended scope words on a medium request.
  assert.equal(decideRestate('rework the combat system so it feels better and fix the hit detection', { mode: 'big' }).restate, true)
})

test('heuristic: effort shifts the score, the setting and /restate win', () => {
  const borderline = 'refactor the inventory module and update the save format'
  const base = decideRestate(borderline, { mode: 'big' })
  const low = decideRestate(borderline, { mode: 'big', effort: 'low' })
  const high = decideRestate(borderline, { mode: 'big', effort: 'high' })
  assert.equal(low.score, base.score - 2)
  assert.equal(high.score, base.score + 1)
  assert.match(high.reason, /effort high/)

  assert.equal(decideRestate('fix the typo in ShopService', { mode: 'always' }).restate, true)
  assert.equal(decideRestate('ok', { mode: 'always' }).restate, false)
  assert.equal(decideRestate('go on', { mode: 'always' }).restate, false)
  const huge = 'Add a shop, a currency, a leaderboard, saving and tests across every service. '.repeat(10)
  assert.equal(decideRestate(huge, { mode: 'never' }).restate, false)
  assert.equal(decideRestate('fix the typo', { mode: 'never', force: true }).restate, true)
  assert.equal(decideRestate('', { mode: 'always', force: true }).restate, false)

  assert.deepEqual(parseRestateCommand('/restate fix the shop'), { forced: true, text: 'fix the shop' })
  assert.deepEqual(parseRestateCommand('  /RESTATE   x'), { forced: true, text: 'x' })
  assert.deepEqual(parseRestateCommand('/restated it'), { forced: false, text: '/restated it' })
  assert.equal(parseRestateCommand('please /restate').forced, false)
})

test('heuristic: lab briefs restate when long, staged or referencing a style; one-word briefs skip', () => {
  assert.equal(decideRestate('fireball', { mode: 'big', kind: 'vfx' }).restate, false)
  assert.equal(decideRestate('purple sword slash', { mode: 'big', kind: 'vfx' }).restate, false)
  const staged = decideRestate('a purple orb that charges, then explodes into a ring and lingers like hollow purple', { mode: 'big', kind: 'vfx' })
  assert.equal(staged.restate, true, staged.reason)
  assert.match(staged.reason, /stages/)
  assert.equal(decideRestate('fireball', { mode: 'always', kind: 'anim' }).restate, false)
  assert.equal(decideRestate('a heavy overhead punch', { mode: 'always', kind: 'anim' }).restate, true)
})

// ---------------------------------------------------------------- prompt assembly

test('prompt: system prompt per kind with past corrections, request fenced, answers parsed', () => {
  const sys = restateSystem('vfx')
  assert.match(sys, /visual effect/)
  assert.match(sys, /JSON only/)
  assert.doesNotMatch(sys, /corrected/)
  const corr: RestateCorrection = { kind: 'vfx', request: 'a cool slash', draft: { goal: 'A sword slash', problem: '', assumptions: [] }, confirmed: { goal: 'A slash that hits twice', problem: 'Combos feel slow', assumptions: [] }, at: 1 }
  const withPast = restateSystem('vfx', [corr])
  assert.match(withPast, /They meant: A slash that hits twice/)
  assert.match(withPast, /problem: Combos feel slow/)
  assert.match(restatePrompt('make it pop'), /"""\nmake it pop\n"""/)

  assert.deepEqual(parseRestatement('```json\n' + JSON.stringify({ ...R, assumptions: [...R.assumptions, 'extra one'] }) + '\n```'), R)
  const labelled = parseRestatement('**Goal:** Ship rewards\nProblem: Retention\nAssumptions:\n- coins\n- 48 h\n')
  assert.deepEqual(labelled, { goal: 'Ship rewards', problem: 'Retention', assumptions: ['coins', '48 h'] })
  assert.equal(parseRestatement('I think you want rewards.'), null)
  assert.equal(normalizeRestatement({ goal: '  ', problem: 'x' }), null)
  assert.deepEqual(normalizeRestatement({ goal: 'g', problem: 'p', assumptions: '- a\n2) b\n\n' })!.assumptions, ['a', 'b'])
})

test('prompt: confirmed restatement goes into the chat turn, the compose prompt and the critic brief', () => {
  const turn = withRestatement('add daily rewards', R, true)
  assert.match(turn, /^add daily rewards\n\n\[Confirmed restatement: the user corrected and then approved/)
  assert.match(turn, /Goal: Players get a daily login reward/)
  assert.match(turn, /- Reuse DataService/)
  assert.match(withRestatement('x', R), /the user approved this reading/)
  assert.match(restatementBlock(R), /confirmed this reading of the brief/)
  assert.equal(restatementBlock(null), '')
  assert.equal(criticBrief('a slash', undefined), 'a slash')
  assert.match(criticBrief('a slash', R), /^a slash\n\(Confirmed goal: Players get/)
  const md = formatRestatement(R)
  assert.match(md, /\*\*Goal:\*\*/)
  assert.match(md, /\*\*Problem being solved:\*\*/)
  assert.match(formatRestatement(R, 'vfx'), /\*\*What I think you want:\*\*/)
})

test('prompt: typo fixes are not substantial, a different goal is; the memory note keeps the newest corrections', () => {
  assert.equal(similarity('a b c', 'a b c'), 1)
  const typo = { ...R, goal: 'Players get a daily login reward which grows with their streak.' }
  assert.equal(isSubstantialEdit(R, typo), false)
  assert.equal(isSubstantialEdit(R, R), false)
  const other = { ...R, goal: 'Add a weekly quest board with three rotating quests.' }
  assert.equal(isSubstantialEdit(R, other), true)
  const why = { ...R, problem: 'Whales churn after a week because there is no long-term chase.' }
  assert.equal(isSubstantialEdit(R, why), true)

  const list: RestateCorrection[] = Array.from({ length: 8 }, (_, i) => ({ kind: i % 2 ? 'vfx' : 'chat', request: `request ${i}`, draft: R, confirmed: { ...other, goal: `goal ${i}` }, at: i }))
  const note = correctionNote(list, 'labs')
  assert.equal(note.name, 'restate-corrections-labs')
  assert.match(note.description, /How the user phrases goals/)
  assert.doesNotMatch(note.body, /request 1"/)
  assert.match(note.body, /\[vfx\] "request 7"/)
  assert.match(note.body, /They meant: goal 7/)
  assert.ok(note.body.length <= 2900)
})

// ---------------------------------------------------------------- Restater

function restater(answer: string | (() => Promise<string>), remember?: (input: any) => Promise<unknown>) {
  const settings = new Map<string, unknown>()
  const calls: { system: string; prompt: string }[] = []
  const r = new Restater({
    getSetting: (k, f) => (settings.has(k) ? (settings.get(k) as any) : f),
    setSetting: (k, v) => void settings.set(k, v),
    oneShot: async (system, prompt) => (calls.push({ system, prompt }), typeof answer === 'string' ? answer : answer()),
    ...(remember ? { remember } : {})
  })
  return { r, settings, calls }
}

test('restater: settings default to big tasks and normalise; Labs briefs skip or restate', async () => {
  const { r, calls } = restater(JSON.stringify(R))
  assert.deepEqual(r.settings(), { chat: 'big', labs: 'big' })
  assert.deepEqual(r.setSettings({ chat: 'always', labs: 'nope' as any }), { chat: 'always', labs: 'big' })
  assert.deepEqual(normalizeRestateSettings(null), { chat: 'big', labs: 'big' })

  assert.match((await r.brief('vfx', 'fireball')).skipped!, /simple brief/)
  assert.equal(calls.length, 0)
  const b = await r.brief('vfx', 'a purple orb that charges, then explodes into a ring and lingers like hollow purple')
  assert.deepEqual(b.restatement, R)
  assert.match(calls[0].system, /visual effect/)
  assert.deepEqual((await r.brief('anim', 'jab', { force: true })).restatement, R)
  r.setSettings({ labs: 'never' })
  assert.match((await r.brief('ability', 'a long and detailed brief, then more, then a lot more after that')).skipped!, /off/)

  const broken = restater('no idea')
  broken.r.setSettings({ labs: 'always' })
  assert.match((await broken.r.brief('vfx', 'a big slash')).skipped!, /could not restate/)
})

test('restater: a substantial edit is kept as a correction and noted in memory; a yes or a typo fix is not', async () => {
  const saved: any[] = []
  const { r, settings, calls } = restater(JSON.stringify(R), async (input) => (saved.push(input), { entry: { name: input.name } }))
  const yes = await r.confirm({ kind: 'chat', request: 'add rewards', draft: R })
  assert.deepEqual(yes, { confirmed: R, edited: false, substantial: false, noted: false })
  const typo = await r.confirm({ kind: 'chat', request: 'add rewards', draft: R, confirmed: { ...R, assumptions: ['Coins only for now', 'Streak resets after 48 hours', 'Reuse DataService'] } })
  assert.equal(typo.edited, true)
  assert.equal(typo.substantial, false)
  assert.equal(saved.length, 0)

  const fixed = { ...R, goal: 'A weekly quest board with three rotating quests instead of login rewards.' }
  const sub = await r.confirm({ kind: 'chat', request: 'add rewards', draft: R, confirmed: fixed })
  assert.equal(sub.substantial, true)
  assert.equal(sub.noted, true)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].name, 'restate-corrections-chat')
  assert.equal(saved[0].scope, 'user')
  assert.equal(saved[0].type, 'feedback')
  assert.match(saved[0].body, /They meant: A weekly quest board/)
  assert.equal((settings.get(CORRECTIONS_SETTING) as RestateCorrection[]).length, 1)

  // Labs corrections get their own note and feed the next Labs restate prompt.
  await r.confirm({ kind: 'vfx', request: 'slash', draft: R, confirmed: { goal: 'A two-hit slash combo', problem: 'Combos feel slow', assumptions: [] } })
  assert.equal(saved[1].name, 'restate-corrections-labs')
  assert.doesNotMatch(saved[1].body, /weekly quest/)
  await r.generate('anim', 'a punch')
  assert.match(calls.at(-1)!.system, /They meant: A two-hit slash combo/)
  assert.doesNotMatch(calls.at(-1)!.system, /weekly quest/)
})

// ---------------------------------------------------------------- chat flow

async function chatSetup(answer = JSON.stringify(R)) {
  const fake = fakeContext()
  const creds = new Credentials(fake.ctx, async () => null, { ANTHROPIC_API_KEY: 'sk-ant' })
  const sdkCalls: { prompt: unknown; options: Options }[] = []
  const queryFn: QueryFn = ({ prompt, options }) => {
    sdkCalls.push({ prompt, options })
    return (async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's1', usage: { input_tokens: 1, output_tokens: 1 } } as any
    })()
  }
  const remembered: any[] = []
  const rs = new Restater({
    getSetting: (k, f) => fake.ctx.getSetting(k, f),
    setSetting: (k, v) => fake.ctx.setSetting(k, v),
    oneShot: async () => answer,
    remember: async (input) => (remembered.push(input), {})
  })
  const chats = new ChatManager(fake.ctx, { credentials: creds, queryFn, restater: rs, makeServer: () => ({ type: 'sdk', name: 'gentree', instance: {} }) as any })
  return { fake, chats, sdkCalls, remembered }
}

async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const BIG = 'Add a daily reward system: create RewardService and RewardController, update DataService to save the streak, then add a popup and also write tests.'

test('chat: a big request gets a restatement card and waits; "Yes, go" runs it with the confirmed reading', async () => {
  const { fake, chats, sdkCalls } = await chatSetup()
  const c = chats.create()
  await chats.send(c.id, BIG)
  const msgs = chats.messages(c.id)!
  const card = msgs.at(-1)!
  assert.equal(card.card, 'restate')
  assert.equal(card.restate!.state, 'pending')
  assert.deepEqual(card.restate!.draft, R)
  assert.equal(card.restate!.request, BIG)
  assert.equal(card.restate!.userMessageId, msgs[0].id)
  assert.match(card.text, /\*\*Goal:\*\* Players get/)
  assert.equal(sdkCalls.length, 0, 'no turn before the yes')
  assert.equal(chats.busy(c.id), false)

  await chats.confirmRestate(c.id, card.id)
  await until(() => sdkCalls.length === 1 && !chats.busy(c.id))
  const prompt = String(sdkCalls[0].prompt)
  assert.ok(prompt.startsWith(BIG))
  assert.match(prompt, /\[Confirmed restatement: the user approved/)
  assert.match(prompt, /Problem being solved: Day-2 retention/)
  assert.match(String(sdkCalls[0].options.systemPrompt), /Confirmed restatement/)
  const after = chats.messages(c.id)!.find((m) => m.id === card.id)!
  assert.equal(after.restate!.state, 'confirmed')
  assert.deepEqual(after.restate!.confirmed, R)
  await assert.rejects(chats.confirmRestate(c.id, card.id), /already confirmed/)

  // Persisted with the conversation.
  chats.flush()
  const stored = fake.settings.get('chats') as { sessions: { id: string; messages: any[] }[] }
  const saved = stored.sessions.find((s) => s.id === c.id)!.messages.find((m) => m.id === card.id)
  assert.equal(saved.restate.state, 'confirmed')
  assert.deepEqual(saved.restate.confirmed, R)
  const reloaded = new ChatManager(fake.ctx, { credentials: new Credentials(fake.ctx, async () => null, {}) })
  assert.equal(reloaded.messages(c.id)!.find((m) => m.id === card.id)!.restate!.state, 'confirmed')
})

test('chat: an edited restatement is sent back, saved as edited, and a substantial edit becomes a memory note', async () => {
  const { chats, sdkCalls, remembered } = await chatSetup()
  const c = chats.create()
  await chats.send(c.id, BIG)
  const card = chats.messages(c.id)!.at(-1)!
  const edited: Restatement = { goal: 'A weekly quest board with three rotating quests, not login rewards.', problem: R.problem, assumptions: ['Quests reset Monday'] }
  await chats.confirmRestate(c.id, card.id, edited)
  await until(() => sdkCalls.length === 1 && !chats.busy(c.id))
  assert.match(String(sdkCalls[0].prompt), /corrected and then approved/)
  assert.match(String(sdkCalls[0].prompt), /Goal: A weekly quest board/)
  const after = chats.messages(c.id)!.find((m) => m.id === card.id)!
  assert.equal(after.restate!.edited, true)
  assert.equal(after.restate!.substantial, true)
  assert.deepEqual(after.restate!.draft, R, 'the original reading is kept next to the edit')
  assert.match(after.text, /weekly quest board/)
  assert.equal(remembered.length, 1)
  assert.equal(remembered[0].name, 'restate-corrections-chat')
})

test('chat: trivial asks skip the card, /restate forces it, a new message dismisses a waiting card, never turns it off', async () => {
  const { fake, chats, sdkCalls } = await chatSetup()
  const c = chats.create()
  await chats.send(c.id, 'what does ModuleLoader do?')
  await until(() => sdkCalls.length === 1 && !chats.busy(c.id))
  assert.equal(String(sdkCalls[0].prompt), 'what does ModuleLoader do?')
  assert.ok(!chats.messages(c.id)!.some((m) => m.card === 'restate'))

  await chats.send(c.id, '/restate fix the typo in ShopService')
  const card = chats.messages(c.id)!.at(-1)!
  assert.equal(card.card, 'restate')
  assert.equal(card.restate!.request, 'fix the typo in ShopService')
  assert.equal(card.restate!.reason, '/restate')
  assert.equal(sdkCalls.length, 1)

  await chats.send(c.id, 'never mind, just say hi')
  assert.equal(chats.messages(c.id)!.find((m) => m.id === card.id)!.restate!.state, 'dismissed')
  await until(() => sdkCalls.length === 2 && !chats.busy(c.id))
  await assert.rejects(chats.confirmRestate(c.id, card.id), /dismissed/)

  await chats.send(c.id, '/restate')
  assert.match(chats.messages(c.id)!.at(-1)!.text, /Add the request after \/restate/)

  fake.ctx.setSetting('restate', { chat: 'never', labs: 'big' })
  await chats.send(c.id, BIG)
  await until(() => sdkCalls.length === 3 && !chats.busy(c.id))
})

test('chat: when the restatement cannot be written the request runs as usual', async () => {
  const { chats, sdkCalls } = await chatSetup('no json here')
  const c = chats.create()
  await chats.send(c.id, BIG)
  await until(() => sdkCalls.length === 1 && !chats.busy(c.id))
  assert.equal(String(sdkCalls[0].prompt), BIG)
})

// ---------------------------------------------------------------- Labs persistence

test('labs: the Ability Composer puts the confirmed reading in the compose prompt, saves it on the entry, and the critic judges against it', async () => {
  const userDir = mkdtempSync(join(tmpdir(), 'restate-ability-'))
  const prompts: { tier: LabTier; prompt: string }[] = []
  const model = (tier: LabTier): ModelFn => async (_sys, prompt) => {
    prompts.push({ tier, prompt })
    return tier === 'critic' ? JSON.stringify({ scores: { anticipation: 7, impact: 7, sync: 7, readability: 7, followThrough: 7 }, overall: 7, summary: 'ok' }) : '{}'
  }
  const make = () => new AbilityService({ userDir, projectRoot: () => null, model, capture: async (req) => req.times.map(() => Buffer.from('png')) })
  const s = make()
  const r = await s.compose('a charged palm blast', { restatement: { ...R, goal: 'A palm blast that knocks the caster back' } })
  const compose = prompts.find((p) => p.tier === 'default')!.prompt
  assert.match(compose, /^Move: a charged palm blast\n\nThe user confirmed this reading of the brief/)
  assert.match(compose, /Goal: A palm blast that knocks the caster back/)
  assert.equal(r.entry.restatement!.goal, 'A palm blast that knocks the caster back')
  // Saved to disk with the entry.
  assert.equal((await make().get(r.entry.id)).restatement!.goal, 'A palm blast that knocks the caster back')
  await s.critique(r.entry.id)
  const critic = prompts.find((p) => p.tier === 'critic')!.prompt
  assert.match(critic, /Confirmed goal: A palm blast that knocks the caster back/)
  // Without a restatement nothing changes.
  const plain = await s.compose('a quick punch')
  assert.equal(plain.entry.restatement, undefined)
  assert.doesNotMatch(prompts.filter((p) => p.tier === 'default').at(-1)!.prompt, /confirmed this reading/)
})

test('labs: a VFX entry keeps its restatement and the critic prompt carries it', async () => {
  const ex = findExample('charge-slash')!
  const effect = compileTimeline({ name: ex.name, roots: [], cues: [], duration: 2 }, RECORDED[ex.key], ex.script).effect
  const prompts: string[] = []
  const svc = new VfxService({
    userDir: mkdtempSync(join(tmpdir(), 'restate-vfx-')),
    projectRoot: () => null,
    lune: async () => ({ error: 'no lune' }),
    runtimeDir: () => null,
    vision: () => async (_sys, prompt) => (prompts.push(prompt), JSON.stringify({ overall: 7, summary: 'ok', scores: {} }))
  })
  const { entry } = await svc.saveEffect(effect, { prompt: 'a charged slash', restatement: R })
  assert.deepEqual((await svc.get(entry.id)).restatement, R)
  await svc.critique(entry, effect, [Buffer.from('png')], [0.5], 1, null)
  assert.match(prompts[0], /Confirmed goal: Players get a daily login reward/)
})
