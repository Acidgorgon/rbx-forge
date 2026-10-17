// Codex images in chats: what image_gen saves under $CODEX_HOME/generated_images/<thread> during a
// `codex exec` run shows inline in the chat (host chat and group-chat guest), is copied into the
// chat image store and art/concepts, and is not shown again on the next run of the same thread.
// Attached images go to Codex with --image and as paths. Also: config-warning lines never reach a
// transcript, group-chat usage keeps cache reads apart for the budget, and the soft-cap note shows
// once per cap.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeContext } from './agentFake.ts'
import { ChatManager, budgetKey } from '../src/main/agent/chat.ts'
import { Credentials } from '../src/main/agent/credentials.ts'
import { Providers } from '../src/main/agent/providers.ts'
import { Meter } from '../src/main/agent/meter.ts'
import { CodexService, type CliRunner } from '../src/main/agent/codex/service.ts'
import { CodexEventMapper, imageFailureText, isCodexWarningNotice } from '../src/main/agent/codex/events.ts'
import { GeneratedImageWatch, complete } from '../src/main/agent/codex/generated.ts'
import { codexGroupPrompt, codexPrompt } from '../src/main/agent/codex/chat.ts'
import { importGeneratedImages, setCodexConceptSaver } from '../src/main/agent/codex/imageSink.ts'
import { ChatImageStore, chatImageStore, setChatImageStore } from '../src/main/agent/chatImages.ts'
import { ArtService } from '../src/main/services/art/service.ts'
import { projectScope } from '../src/main/services/release/secrets.ts'
import type { QueryFn } from '../src/main/agent/sdk.ts'

// A tiny but complete PNG (signature, IHDR 2x3, IEND).
function png(w = 2, h = 3): Buffer {
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'latin1')
  ihdr.writeUInt32BE(w, 8)
  ihdr.writeUInt32BE(h, 12)
  ihdr[16] = 8
  ihdr[17] = 6
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, iend])
}

async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

interface Exec {
  args: string[]
  stdin: string
}

// A fake signed-in `codex`. Each exec: thread.started, then for every image in `images(n)` the
// image_gen save (a file in $CODEX_HOME/generated_images/<thread>/), then the reply text.
function fakeCodex(home: string, plan: (n: number) => { images?: number; text?: string; usage?: { input: number; cached: number; output: number } }) {
  const execs: Exec[] = []
  const run: CliRunner = async (o) => {
    if (o.args[0] === 'login') return { code: 0, stderr: 'Logged in using ChatGPT\n', aborted: false, timedOut: false }
    if (o.args[0] === '--version') {
      o.onStdoutLine?.('codex-cli 0.162.1')
      return { code: 0, stderr: '', aborted: false, timedOut: false }
    }
    if (o.args[0] !== 'exec') return { code: 1, stderr: '', aborted: false, timedOut: false }
    execs.push({ args: o.args, stdin: o.stdin ?? '' })
    const n = execs.length
    const p = plan(n)
    const at = o.args.indexOf('resume')
    const thread = at >= 0 ? o.args[at + 1] : `th-${n}`
    const out = (e: unknown) => o.onStdoutLine?.(JSON.stringify(e))
    out({ type: 'thread.started', thread_id: thread })
    for (let k = 0; k < (p.images ?? 0); k++) {
      const dir = join(home, 'generated_images', thread)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `ig_${n}_${k}.png`), png(2 + k, 3))
      // The CLI emits nothing for the image call itself (exec drops ImageGeneration items).
    }
    out({ type: 'item.completed', item: { id: 'item_9', type: 'agent_message', text: p.text ?? 'Made the concepts above.' } })
    const u = p.usage ?? { input: 100, cached: 0, output: 10 }
    out({ type: 'turn.completed', usage: { input_tokens: u.input, cached_input_tokens: u.cached, output_tokens: u.output, reasoning_output_tokens: 0 } })
    return { code: 0, stderr: '', aborted: false, timedOut: false }
  }
  return { svc: new CodexService({ findBin: () => '/bin/codex', run, env: () => ({ CODEX_HOME: home }) }), execs }
}

async function tempStore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-chatimg-'))
  setChatImageStore(new ChatImageStore(dir))
  return dir
}

test('GeneratedImageWatch: only new, finished image files of the thread; prime skips older ones; symlinks and other files ignored', async () => {
  const home = await mkdtemp(join(tmpdir(), 'forge-codexhome-'))
  const dir = join(home, 'generated_images', 'th-1')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'old.png'), png())
  const w = new GeneratedImageWatch({ home })
  await w.prime('th-1')
  assert.deepEqual(await w.scan('th-1'), [])
  await writeFile(join(dir, 'half.png'), png().subarray(0, 30))
  await writeFile(join(dir, 'notes.txt'), 'x')
  await writeFile(join(home, 'auth.json'), '{}')
  await symlink(join(home, 'auth.json'), join(dir, 'link.png')).catch(() => undefined)
  assert.deepEqual(await w.scan('th-1'), [], 'an unfinished PNG waits, text files and symlinks never count')
  await writeFile(join(dir, 'half.png'), png())
  await writeFile(join(dir, 'new.png'), png())
  assert.deepEqual((await w.scan('th-1')).map((p) => p.slice(dir.length + 1)).sort(), ['half.png', 'new.png'])
  assert.deepEqual(await w.scan('th-1'), [], 'each file once')
  assert.deepEqual(await w.scan('../etc'), [], 'a strange thread id is not a path')
  assert.equal(await complete(join(dir, 'new.png'), png().length), true)
})

test('host chat on Codex: image_gen output shows inline before the reply, lands in the chat store and art/concepts; a resumed run does not repeat it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'forge-codexhome-'))
  const storeDir = await tempStore()
  const saved: { prompt: string; n: number }[] = []
  setCodexConceptSaver(async ({ images, prompt }) => {
    saved.push({ prompt, n: images.length })
    return images.map((_, k) => `art/concepts/2026-10-17/menu-concepts-${k + 1}.png`)
  })
  try {
    const { svc, execs } = fakeCodex(home, (n) => (n === 1 ? { images: 2, text: 'Made two concepts above: A — Touchline, B — Matchday.' } : { text: 'Sure.' }))
    const fake = fakeContext()
    const chats = new ChatManager(fake.ctx, { credentials: new Credentials(fake.ctx, async () => null, {}), toolFs: fake.fs, checkpoints: null, codex: () => svc } as any)
    const c = chats.create({ provider: 'codex', model: 'gpt-6.1-sol' })
    await chats.setMode(c.id, 'ask')
    await chats.send(c.id, 'make UI menu concepts')
    await until(() => !chats.busy(c.id))
    const msgs = chats.messages(c.id)!
    const imgAt = msgs.findIndex((m) => m.role === 'assistant' && m.images?.length)
    const textAt = msgs.findIndex((m) => m.role === 'assistant' && /Made two concepts above/.test(m.text))
    assert.ok(imgAt >= 0, 'the images are in the chat')
    assert.ok(imgAt < textAt, 'shown where Codex made them, before "above"')
    const im = msgs[imgAt]
    assert.equal(im.images!.length, 2)
    assert.match(im.text, /Saved to the Art page: `art\/concepts\/2026-10-17\/menu-concepts-1\.png`, `art\/concepts\/2026-10-17\/menu-concepts-2\.png`/)
    assert.deepEqual(saved, [{ prompt: 'make UI menu concepts', n: 2 }])
    // Copied into Forge's own store: they stay when Codex's folder is cleaned.
    assert.equal((await readdir(storeDir)).length, 2)
    assert.deepEqual((await chatImageStore().read(im.images![0].id))!.data, png(2, 3))
    assert.equal(im.images![0].name, 'menu-concepts-1')
    // Codex is told the images show here by themselves.
    assert.match(execs[0].stdin, /appear in this chat automatically and Forge saves them to art\/concepts/)

    await chats.send(c.id, 'thanks')
    await until(() => !chats.busy(c.id))
    assert.ok(execs[1].args.includes('resume'))
    assert.equal(chats.messages(c.id)!.filter((m) => m.images?.length && m.role === 'assistant').length, 1, 'earlier images of the thread are not posted again')
  } finally {
    setCodexConceptSaver(null)
  }
})

test('host chat on Codex: an attached image goes with --image and as a path image_gen can edit', async () => {
  const home = await mkdtemp(join(tmpdir(), 'forge-codexhome-'))
  await tempStore()
  const { svc, execs } = fakeCodex(home, () => ({ text: 'Edited.' }))
  const fake = fakeContext()
  const chats = new ChatManager(fake.ctx, { credentials: new Credentials(fake.ctx, async () => null, {}), toolFs: fake.fs, checkpoints: null, codex: () => svc } as any)
  const ref = await chatImageStore().add({ dataUrl: `data:image/png;base64,${png().toString('base64')}`, name: 'touchline' })
  const path = (await chatImageStore().pathOf(ref.id))!
  const c = chats.create({ provider: 'codex', model: 'gpt-6.1-sol' })
  await chats.setMode(c.id, 'ask')
  await chats.send(c.id, 'make this more REMATCH style', [ref.id])
  await until(() => !chats.busy(c.id))
  const a = execs[0].args
  assert.equal(a[a.indexOf('--image') + 1], path)
  assert.ok(execs[0].stdin.includes(`referenced_image_paths):\n- ${path}`))
})

test('group chat: a Codex guest\'s generated images show under its name and in art/concepts; the host hears about them', async () => {
  const home = await mkdtemp(join(tmpdir(), 'forge-codexhome-'))
  await tempStore()
  const prompts: string[] = []
  setCodexConceptSaver(async ({ images, prompt }) => {
    prompts.push(prompt)
    return images.map((_, k) => `art/concepts/2026-10-17/touchline-${k + 1}.png`)
  })
  try {
    const { svc, execs } = fakeCodex(home, () => ({ images: 1, text: 'Made one concept above.', usage: { input: 1000, cached: 900, output: 50 } }))
    const fake = fakeContext()
    const creds = new Credentials(fake.ctx, async () => null, {})
    await creds.setKey('anthropic', 'key-anthropic')
    const hostPrompts: string[] = []
    const queryFn: QueryFn = ({ prompt }) => {
      hostPrompts.push(String(prompt))
      return (async function* () {
        yield { type: 'assistant', parent_tool_use_id: null, session_id: 's', message: { content: [{ type: 'text', text: 'ok' }] } } as any
        yield { type: 'result', subtype: 'success', is_error: false, result: '', session_id: 's', usage: { input_tokens: 10, output_tokens: 5 } } as any
      })()
    }
    const fetchFn = (async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const providers = new Providers(fake.ctx, creds, fetchFn, () => svc)
    const store = new Map<string, unknown>()
    const meter = new Meter({ getSetting: (k: string, f: unknown) => (store.has(k) ? (store.get(k) as any) : f), setSetting: (k: string, v: unknown) => void store.set(k, v), emit: () => undefined } as any, { saveDelayMs: 0 })
    const chats = new ChatManager(fake.ctx, { credentials: creds, providers, fetchFn, toolFs: fake.fs, queryFn, checkpoints: null, codex: () => svc, meter })
    const c = chats.create({ provider: 'anthropic', model: 'claude-opus-5-5' })
    chats.addGuest(c.id, { provider: 'codex', model: 'gpt-6.1-sol' })
    await chats.send(c.id, '@sol make UI menu concepts')
    await until(() => !chats.busy(c.id))
    const msgs = chats.messages(c.id)!
    const im = msgs.find((m) => m.role === 'assistant' && m.images?.length)!
    assert.ok(im, 'the guest image is in the chat')
    assert.equal(im.speaker?.provider, 'codex')
    assert.equal(im.speaker?.label, 'GPT-6.1 Sol')
    assert.ok(msgs.indexOf(im) < msgs.findIndex((m) => m.text === 'Made one concept above.'))
    assert.deepEqual(prompts, ['@sol make UI menu concepts'])
    assert.match(execs[0].stdin, /appear in this chat automatically/)
    // Budget: Codex's input_tokens include the cached ones; the ledger keeps them as cache reads.
    const t = meter.ledger.chat(c.id)
    assert.deepEqual({ input: t.input, cacheRead: t.cacheRead, output: t.output }, { input: 100, cacheRead: 900, output: 50 })
    assert.equal(meter.checkChat(c.id).tokens, 100 + 50 + 90, 'cache reads count at 10% (effective tokens)')
    // The host learns where they are on its next turn.
    await chats.send(c.id, 'which one do you like?')
    await until(() => !chats.busy(c.id))
    assert.match(hostPrompts.at(-1)!, /GPT-6\.1 Sol generated an image \(shown in the chat, saved to art\/concepts\/2026-10-17\/touchline-1\.png\)/)
  } finally {
    setCodexConceptSaver(null)
  }
})

test('importGeneratedImages: without a project the image still shows; non-images are skipped', async () => {
  await tempStore()
  const dir = await mkdtemp(join(tmpdir(), 'forge-gen-'))
  await writeFile(join(dir, 'a.png'), png())
  await writeFile(join(dir, 'b.png'), 'not an image')
  const r = await importGeneratedImages([join(dir, 'a.png'), join(dir, 'b.png'), join(dir, 'c.txt')], {
    prompt: 'x',
    save: async () => {
      throw new Error('No project open')
    }
  })
  assert.equal(r.images.length, 1)
  assert.deepEqual(r.concepts, [])
  assert.match(r.problems.join('\n'), /not saved to art\/concepts: No project open/)
})

test('ArtService.saveGenerated: chat images become concepts with the request as prompt, made by an agent, $0', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-art-'))
  const data = new Map<string, unknown>()
  const changed: string[] = []
  const svc = new ArtService({
    root: () => root,
    scope: projectScope,
    settings: { get: (k, f) => (data.has(k) ? (data.get(k) as any) : f), set: (k, v) => void data.set(k, v) },
    openAiKey: async () => null,
    robloxKey: async () => null,
    now: () => new Date(2026, 9, 17, 12, 0, 0).getTime(),
    trashDir: join(root, '.trash'),
    onChanged: (r) => changed.push(r)
  })
  const items = await svc.saveGenerated({ images: [png(), png(4, 4)], prompt: 'Make UI menu concepts for the football game' })
  assert.deepEqual(items.map((i) => i.path), ['art/concepts/2026-10-17/make-ui-menu-concepts-football-game-1.png', 'art/concepts/2026-10-17/make-ui-menu-concepts-football-game-2.png'])
  const side = JSON.parse(await readFile(join(root, 'art/concepts/2026-10-17/make-ui-menu-concepts-football-game-1.json'), 'utf8'))
  assert.equal(side.prompt, 'Make UI menu concepts for the football game')
  assert.equal(side.source, 'agent')
  assert.equal(side.costUsd, 0)
  assert.equal(side.model, items[0].model)
  assert.deepEqual(changed, [root])
  assert.equal((await svc.list()).length, 2, 'the Art page lists them')
})

test('codex prompts: attached images listed as paths; the image rule rides along in group calls', () => {
  const p = codexPrompt({ text: 'edit it', mode: 'ask', rules: '', fresh: false, transcript: '', basePrompt: 'x', images: ['/u/a.png'] })
  assert.match(p, /Attached image \(also local files; to edit or vary it with image_gen, pass the path in referenced_image_paths\):\n- \/u\/a\.png\n\nedit it$/)
  assert.ok(!/Attached/.test(codexPrompt({ text: 'hi', mode: 'ask', rules: '', fresh: false, transcript: '', basePrompt: 'x' })))
  const g = codexGroupPrompt({ system: 'S', prompt: 'P', fresh: false, projectFiles: true, images: ['/u/a.png', '/u/b.png'] })
  assert.match(g, /Images you make with the built-in image_gen tool appear in this chat automatically/)
  assert.match(g, /Attached images .*\n- \/u\/a\.png\n- \/u\/b\.png\n\nP$/)
})

test('image_generation items (newer CLIs): the real failure text in the tool row', () => {
  const m = new CodexEventMapper('/p')
  const [failed] = m.event({ type: 'item.completed', item: { id: 'ig_1', type: 'image_generation', status: 'failed', failure: { message: 'content policy: the request was rejected' } } }) as any[]
  assert.equal(failed.text, 'Error: content policy: the request was rejected')
  assert.equal(failed.error, true)
  const [limit] = m.event({ type: 'item.completed', item: { id: 'ig_2', type: 'image_generation', status: 'failed', failure: { type: 'usage_limit_exceeded', limit_id: 'image_gen', resets_at: 1_800_000_000 } } }) as any[]
  assert.match(limit.text, /^Error: the ChatGPT plan's image generation limit is reached \(resets /)
  const [bare] = m.event({ type: 'item.completed', item: { id: 'ig_3', type: 'image_generation', status: 'failed' } }) as any[]
  assert.equal(bare.text, 'Error: image generation failed')
  const [ok] = m.event({ type: 'item.completed', item: { id: 'ig_4', type: 'image_generation', status: 'completed', saved_path: '/h/generated_images/t/ig_4.png' } }) as any[]
  assert.equal(ok.text, 'saved /h/generated_images/t/ig_4.png')
  assert.equal(ok.error, undefined)
  assert.equal(imageFailureText('plain'), 'plain')
  assert.equal(imageFailureText(null), '')
})

const WARNING = 'Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings. user (C:\\Users\\you\\.codex\\config.toml): `mcp_servers.Neon.type` is ignored.'

test('config warnings never render in a transcript: old saved lines are dropped on load, new ones are logged', () => {
  assert.equal(isCodexWarningNotice(`Codex: ${WARNING}`), true)
  assert.equal(isCodexWarningNotice(`GPT-6.1 Sol: ${WARNING}`), true)
  assert.equal(isCodexWarningNotice(`Error: ${WARNING}`), true)
  assert.equal(isCodexWarningNotice('Codex: the turn failed: stream disconnected'), false)
  assert.equal(isCodexWarningNotice('Budget: chat is at 312k tokens (soft cap 300k); consider a new chat or /compact.'), false)
  const fake = fakeContext()
  const at = Date.now()
  fake.settings.set('chats', {
    sessions: [
      {
        id: 'c1',
        title: 'Old',
        createdAt: at,
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        messages: [
          { id: 'u', role: 'user', text: 'hi', at, agentId: 'main' },
          { id: 'w1', role: 'system', text: `Codex: ${WARNING}`, at, agentId: 'main' },
          { id: 'w2', role: 'system', text: `Codex: ${WARNING}`, at, agentId: 'main', speaker: { provider: 'codex', model: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' } },
          { id: 'a', role: 'assistant', text: 'hello', at, agentId: 'main' }
        ]
      }
    ]
  })
  const chats = new ChatManager(fake.ctx, { credentials: new Credentials(fake.ctx, async () => null, {}), toolFs: fake.fs, checkpoints: null } as any)
  assert.deepEqual(chats.messages('c1')!.map((m) => m.id), ['u', 'a'])
})

test('budget note: once per cap, not once per token count', () => {
  assert.equal(budgetKey('chat is at 312k tokens (soft cap 300k); consider a new chat or /compact'), budgetKey('chat is at 1797k tokens (soft cap 300k); consider a new chat or /compact'))
  assert.notEqual(budgetKey('chat is at 312k tokens (soft cap 300k)'), budgetKey('chat cost $1.70 (soft cap $2.00)'))
})
