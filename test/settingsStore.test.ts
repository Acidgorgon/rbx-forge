import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CoalescedJsonWriter } from '../src/main/services/jsonWriter.ts'
import { Settings } from '../src/main/services/settings.ts'

const tempDir = () => mkdtempSync(join(tmpdir(), 'forge-settings-'))
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('settings: set is visible at once and a burst becomes one coalesced write', async () => {
  const dir = tempDir()
  try {
    let writes = 0
    const writer = new CoalescedJsonWriter(join(dir, 'x.json'), () => {
      writes++
      return '{}'
    }, { delayMs: 30 })
    for (let i = 0; i < 50; i++) writer.schedule()
    assert.equal(writes, 0)
    await sleep(100)
    assert.equal(writes, 1)

    const s = new Settings(dir, { saveDelayMs: 30 })
    for (let i = 0; i < 20; i++) s.set('n', i)
    assert.equal(s.get('n', -1), 19)
    assert.equal(existsSync(join(dir, 'settings.json')), false)
    await sleep(120)
    assert.equal(readJson(join(dir, 'settings.json')).n, 19)
    s.set('n', undefined)
    assert.equal(s.get('n', -1), -1)
    await s.flush()
    assert.equal('n' in readJson(join(dir, 'settings.json')), false)
    // No temp files left behind.
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings: flushSync writes pending changes before the delay (quit)', async () => {
  const dir = tempDir()
  try {
    const s = new Settings(dir, { saveDelayMs: 10_000 })
    s.set('theme', 'dark')
    s.set('chats', { sessions: [{ id: 'a', messages: [] }] })
    s.flushSync()
    assert.equal(readJson(join(dir, 'settings.json')).theme, 'dark')
    assert.deepEqual(readJson(join(dir, 'chats.json')), { sessions: [{ id: 'a', messages: [] }] })
    // A second process sees what was flushed.
    const again = new Settings(dir)
    assert.equal(again.get('theme', ''), 'dark')
    assert.deepEqual(again.get('chats', null), { sessions: [{ id: 'a', messages: [] }] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings: flushSync during an async write keeps the newest data', async () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'state.json')
    let value = 1
    let serialized = 0
    const writer = new CoalescedJsonWriter(file, () => {
      serialized++
      return JSON.stringify({ v: value })
    })
    writer.schedule()
    const pending = writer.flush()
    // Let the async write start: it has serialized v=1 and is on its way to disk.
    while (serialized === 0) await Promise.resolve()
    value = 2
    writer.schedule()
    writer.flushSync()
    assert.equal(readJson(file).v, 2)
    await pending
    await sleep(20)
    // The older async snapshot did not land over the synchronous one.
    assert.equal(readJson(file).v, 2)
    assert.equal(writer.pending(), false)
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings: chats live in chats.json, not settings.json, without indentation', async () => {
  const dir = tempDir()
  try {
    const s = new Settings(dir, { saveDelayMs: 10 })
    s.set('chats', { sessions: [{ id: 'c1', messages: [{ role: 'user', text: 'hi' }] }] })
    s.set('other', true)
    await s.flush()
    assert.equal('chats' in readJson(join(dir, 'settings.json')), false)
    const raw = readFileSync(join(dir, 'chats.json'), 'utf8')
    assert.equal(raw.includes('\n'), false)
    assert.equal(JSON.parse(raw).sessions[0].id, 'c1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings: migrates the chats key from settings.json into chats.json', () => {
  const dir = tempDir()
  try {
    const chats = { sessions: [{ id: 'old', messages: [{ role: 'user', text: 'kept' }] }] }
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'light', chats }, null, 2))
    const s = new Settings(dir)
    assert.deepEqual(s.get('chats', null), chats)
    assert.equal(s.get('theme', ''), 'light')
    assert.deepEqual(readJson(join(dir, 'chats.json')), chats)
    const settingsFile = readJson(join(dir, 'settings.json'))
    assert.equal('chats' in settingsFile, false)
    assert.equal(settingsFile.theme, 'light')
    // Runs once: the next start reads chats.json.
    const again = new Settings(dir)
    assert.deepEqual(again.get('chats', null), chats)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings: chats.json wins over a leftover settings key, which is kept aside', () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'chats.json'), JSON.stringify({ sessions: [{ id: 'new', messages: [] }] }))
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ chats: { sessions: [{ id: 'stale', messages: [] }] } }))
    const s = new Settings(dir)
    assert.equal(s.get<{ sessions: { id: string }[] } | null>('chats', null)?.sessions[0].id, 'new')
    assert.equal('chats' in readJson(join(dir, 'settings.json')), false)
    const legacy = readdirSync(dir).find((f) => f.startsWith('chats.legacy-'))
    assert.ok(legacy)
    assert.equal(readJson(join(dir, legacy)).sessions[0].id, 'stale')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings: no chats anywhere reads the fallback', () => {
  const dir = tempDir()
  try {
    const s = new Settings(dir)
    assert.equal(s.get('chats', null), null)
    assert.equal(existsSync(join(dir, 'chats.json')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
