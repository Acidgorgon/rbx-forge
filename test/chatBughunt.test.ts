// v0.6 bug hunt (assistant): races when starting turns, diff cards orphaned by an ended turn, the
// busy flag after a renderer reload, spending-cap paths of group chats, and shadow-git checkpoints
// (excluded paths, bounded refs).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeContext } from './agentFake.ts'
import { ChatManager } from '../src/main/agent/chat.ts'
import { Credentials } from '../src/main/agent/credentials.ts'
import { Meter } from '../src/main/agent/meter.ts'
import type { QueryFn } from '../src/main/agent/sdk.ts'
import { Checkpoints } from '../src/main/agent/checkpoints.ts'
import { setSpendCap } from '../src/main/services/spend/gate.ts'

async function until(fn: () => boolean, ms = 10000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

function sdk(script: (o: any, n: number) => Promise<void> = async () => {}) {
  const calls: { prompt: string; options: any }[] = []
  const queryFn: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt: String(prompt), options })
    const n = calls.length - 1
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: `s${n}` } as any
      await script(options, n)
      yield { type: 'assistant', parent_tool_use_id: null, session_id: `s${n}`, message: { content: [{ type: 'text', text: 'Done.' }] } } as any
      yield { type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: `s${n}` } as any
    })()
  }
  return { calls, queryFn }
}

function manager(queryFn: QueryFn, extra: Record<string, unknown> = {}) {
  const fake = fakeContext({ files: { 'src/shared/a.luau': 'one\ntwo\n' } })
  const credentials = new Credentials(fake.ctx, async () => null, { ANTHROPIC_API_KEY: 'sk-test' })
  return { fake, chats: new ChatManager(fake.ctx, { queryFn, credentials, toolFs: fake.fs, checkpoints: null, ...extra } as any) }
}

test('send: two messages sent at once start one turn; the second is refused as busy', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const s = sdk(() => gate)
  const { chats } = manager(s.queryFn)
  const c = chats.create()
  const first = chats.send(c.id, 'one')
  const second = chats.send(c.id, 'two')
  await assert.rejects(second, /busy/)
  await first
  assert.equal(chats.busy(c.id), true)
  assert.equal(chats.list().find((x) => x.id === c.id)!.busy, true, 'listed as busy mid-turn (renderer reload)')
  release()
  await until(() => !chats.busy(c.id))
  assert.equal(s.calls.length, 1)
  assert.equal(chats.list().find((x) => x.id === c.id)!.busy, undefined)
})

test('edit: a diff card still waiting when the turn ends is expired, not left answerable', async () => {
  let result: Promise<any> | null = null
  const s = sdk(async (o) => {
    // The query ends (e.g. the CLI crashed) while the approval still waits; its signal never aborts.
    result = o.canUseTool('mcp__gentree__write_script', { path: 'src/shared/a.luau', contents: 'changed\n' }, { signal: new AbortController().signal, toolUseID: 't' })
    await new Promise((r) => setTimeout(r, 20))
  })
  const { chats, fake } = manager(s.queryFn)
  const c = chats.create()
  await chats.send(c.id, 'change a')
  await until(() => !chats.busy(c.id))
  const card = chats.messages(c.id)!.find((m) => m.diff)!
  assert.equal(card.diff!.state, 'expired')
  assert.equal((await result!).behavior, 'deny')
  await assert.rejects(chats.reviewEdit(c.id, card.id, { accept: true }), /no longer waiting/)
  assert.equal(fake.files.get('src/shared/a.luau'), 'one\ntwo\n')
})

test('spending cap: a roundtable is refused, and group calls stop once the cap is reached', async () => {
  const s = sdk()
  const store = new Map<string, unknown>()
  const meter = new Meter({ getSetting: (k, f) => (store.has(k) ? (store.get(k) as any) : f), setSetting: (k, v) => void store.set(k, v), emit: () => undefined }, { saveDelayMs: 0 })
  const { chats } = manager(s.queryFn, { meter })
  const c = chats.create({ provider: 'anthropic', model: 'claude-opus-5-5' }, { guests: [{ provider: 'anthropic', model: 'claude-haiku-5-5' }] })
  setSpendCap({ blocked: () => 'Spending cap reached: $1.00 of $1.00 today.', assert: () => undefined, record: () => undefined } as any)
  try {
    await assert.rejects(chats.roundtable(c.id, 'save data', 1), /Spending cap reached/)
    assert.equal(s.calls.length, 0)
    // A direct @mention to a guest is stopped by the turn's budget check too.
    await chats.send(c.id, '@haiku what do you think?')
    await until(() => !chats.busy(c.id))
    assert.equal(s.calls.length, 0)
  } finally {
    setSpendCap(null)
  }
})

async function tempRepo(): Promise<{ dir: string; git: (c: string) => string }> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-cp2-'))
  const git = (c: string) => execSync(`git ${c}`, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' } }).toString()
  git('init -q')
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src', 'a.luau'), 'v1')
  git('add -A')
  git('commit -qm init')
  return { dir, git }
}

test('checkpoints: Packages and place files are never snapshotted or removed, even without a .gitignore', async () => {
  const { dir } = await tempRepo()
  try {
    const cp = new Checkpoints(dir)
    const c1 = await cp.create('before')
    // Installed / saved after the checkpoint: a rewind must leave them alone.
    await mkdir(join(dir, 'Packages'), { recursive: true })
    await writeFile(join(dir, 'Packages', 'lib.lua'), 'wally')
    await writeFile(join(dir, 'game.rbxl'), Buffer.alloc(1024, 7))
    await writeFile(join(dir, 'src', 'b.luau'), 'agent file')
    await writeFile(join(dir, 'src', 'é.luau'), 'unicode name')
    const changed = (await cp.changedSince(c1)).sort()
    assert.deepEqual(changed, ['src/b.luau', 'src/é.luau'], 'paths are not git-quoted')
    await cp.restore(c1)
    assert.equal(await readFile(join(dir, 'Packages', 'lib.lua'), 'utf8'), 'wally')
    assert.equal((await readFile(join(dir, 'game.rbxl'))).length, 1024)
    await assert.rejects(readFile(join(dir, 'src', 'b.luau'), 'utf8'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('checkpoints: concurrent snapshots on one project do not collide; drop removes their refs', async () => {
  const { dir } = await tempRepo()
  try {
    const a = new Checkpoints(dir)
    const b = new Checkpoints(dir)
    const [c1, c2] = await Promise.all([a.create('same'), b.create('same')])
    assert.notEqual(c1, c2, 'same tree and label still give two commits')
    const refs = () => execSync("git for-each-ref --format='%(refname)' refs/checkpoints", { cwd: dir, env: { ...process.env, GIT_DIR: a.gitDir } }).toString().trim().split('\n').filter(Boolean)
    assert.equal(refs().length, 2)
    await a.drop([c1])
    assert.deepEqual(refs(), [`refs/checkpoints/${c2}`])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('checkpoints: a chat keeps at most 50 and the dropped ones leave the shadow repo', async () => {
  const { dir } = await tempRepo()
  try {
    const fake = fakeContext()
    fake.ctx.project = () => ({ root: dir, name: 'T', placeIds: [] }) as any
    const s = sdk()
    const credentials = new Credentials(fake.ctx, async () => null, { ANTHROPIC_API_KEY: 'sk' })
    const chats = new ChatManager(fake.ctx, { queryFn: s.queryFn, credentials, toolFs: fake.fs })
    const c = chats.create()
    for (let i = 0; i < 52; i++) {
      await chats.send(c.id, `turn ${i}`)
      await until(() => !chats.busy(c.id))
    }
    const list = chats.checkpointsOf(c.id)
    assert.equal(list.length, 50)
    assert.equal(list[0].label, 'turn 2')
    const gitDir = new Checkpoints(dir).gitDir
    const refs = execSync("git for-each-ref --format='%(refname)' refs/checkpoints", { cwd: dir, env: { ...process.env, GIT_DIR: gitDir } }).toString().trim().split('\n').filter(Boolean)
    assert.equal(refs.length, 50)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
