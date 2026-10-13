// History compaction and tool-output truncation (budget/compact.ts).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  compactHistory,
  needsCompaction,
  splitTurns,
  SUMMARY_MARKER,
  transcript,
  truncateToolOutput,
  type CompactMessage
} from '../src/main/agent/budget/compact.ts'
import { estimateMessagesTokens, estimateTokens } from '../src/main/agent/budget/tokens.ts'
import { FIXTURE_ROOT } from './tokensFixture.ts'

const LOADER = readFileSync(join(FIXTURE_ROOT, 'src/shared/Modules/ModuleLoader.luau'), 'utf8')

test('truncateToolOutput: unchanged when it fits', () => {
  assert.equal(truncateToolOutput('short', 100), 'short')
})

test('truncateToolOutput: keeps head and tail lines and counts the gap', () => {
  const out = truncateToolOutput(LOADER, 150)
  assert.ok(estimateTokens(out) <= 150, String(estimateTokens(out)))
  const lines = out.trimEnd().split('\n')
  assert.equal(lines[0], '--!nocheck')
  assert.equal(lines[lines.length - 1], 'return ModuleLoader')
  const m = /… (\d+) lines omitted …/.exec(out)
  assert.ok(m)
  const total = LOADER.trimEnd().split('\n').length
  assert.equal(Number(m[1]) + lines.length - 1, total)
  // Deterministic.
  assert.equal(truncateToolOutput(LOADER, 150), out)
})

test('truncateToolOutput: single huge line is cut by characters', () => {
  const json = JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `Item${i}` })) })
  const out = truncateToolOutput(json, 100)
  assert.match(out, /… \d+ chars omitted …/)
  assert.ok(out.startsWith('{"items":'))
  assert.ok(out.endsWith('}]}'))
  assert.ok(estimateTokens(out) < 140)
})

test('truncateToolOutput: zero budget', () => {
  assert.equal(truncateToolOutput('a\nb\nc', 0), '… 3 lines omitted')
})

function conversation(turns: number, toolText = LOADER): CompactMessage[] {
  const out: CompactMessage[] = [{ role: 'system', content: 'You are the GenTree assistant.' }]
  for (let i = 1; i <= turns; i++) {
    out.push({ role: 'user', content: `Question ${i}: what does ModuleLoader do?` })
    out.push({ role: 'assistant', content: null, tool_calls: [{ id: `call_${i}`, type: 'function', function: { name: 'read_script', arguments: `{"path":"src/shared/Modules/ModuleLoader.luau"}` } }] } as CompactMessage)
    out.push({ role: 'tool', tool_call_id: `call_${i}`, content: toolText } as CompactMessage)
    out.push({ role: 'assistant', content: `Answer ${i}: it requires every module and calls Init then Start.` })
  }
  return out
}

test('splitTurns groups assistant/tool messages under their user message', () => {
  const { system, turns } = splitTurns(conversation(3))
  assert.equal(system.length, 1)
  assert.equal(turns.length, 3)
  assert.deepEqual(turns[0].map((m) => m.role), ['user', 'assistant', 'tool', 'assistant'])
})

test('transcript is terse and names tools', () => {
  const t = transcript(splitTurns(conversation(1)).turns, 40)
  assert.match(t, /^User: Question 1/)
  assert.match(t, /Assistant called read_script\(/)
  assert.match(t, /read_script result: --!nocheck/)
  assert.match(t, /lines omitted/)
})

test('under budget: only tool outputs are truncated, nothing summarized', async () => {
  const msgs = conversation(2)
  let called = 0
  const r = await compactHistory(msgs, { budgetTokens: 100_000, toolMaxTokens: 100, summarize: async () => (called++, 'x') })
  assert.equal(called, 0)
  assert.equal(r.summarizedTurns, 0)
  assert.equal(r.messages.length, msgs.length)
  assert.ok(r.tokensAfter < r.tokensBefore)
  assert.match(r.messages[3].content!, /lines omitted/)
  // Input is not mutated.
  assert.equal(msgs[3].content, LOADER)
})

test('over budget: old turns summarized, last N kept verbatim, structure valid', async () => {
  const msgs = conversation(10)
  let input = ''
  const r = await compactHistory(msgs, {
    budgetTokens: 2500,
    keepTurns: 3,
    toolMaxTokens: 300,
    summarize: async (t) => {
      input = t
      return '- User asked about ModuleLoader 7 times; it loads modules, Init then Start.'
    }
  })
  assert.equal(r.summarizedTurns, 7)
  assert.ok(r.tokensAfter <= 2500, String(r.tokensAfter))
  assert.ok(input.includes('Question 1') && input.includes('Question 7') && !input.includes('Question 8'))
  assert.equal(r.messages[0].role, 'system')
  assert.equal(r.messages[0].content, 'You are the GenTree assistant.')
  const first = r.messages[1]
  assert.equal(first.role, 'user')
  assert.ok(first.content!.startsWith(SUMMARY_MARKER))
  assert.match(first.content!, /\[Current request\]\nQuestion 8:/)
  // Every tool message still follows the assistant message that called it.
  for (let i = 0; i < r.messages.length; i++) {
    const m = r.messages[i] as CompactMessage & { tool_call_id?: string }
    if (m.role !== 'tool') continue
    const prev = r.messages[i - 1] as CompactMessage & { tool_calls?: { id: string }[] }
    assert.ok(prev.tool_calls?.some((c) => c.id === m.tool_call_id))
  }
  assert.ok(r.messages.some((m) => m.content?.startsWith('Answer 10')))
})

test('keepTurns shrinks to fit, never below one turn; huge last turn is squeezed', async () => {
  const msgs = conversation(4, LOADER.repeat(20))
  const r = await compactHistory(msgs, { budgetTokens: 1200, keepTurns: 4, summarize: async () => 'summary' })
  assert.equal(r.summarizedTurns, 3)
  assert.ok(r.tokensAfter <= 1200, String(r.tokensAfter))
})

test('summaryAs system puts the summary after the system prompt', async () => {
  const r = await compactHistory(conversation(6), { budgetTokens: 900, keepTurns: 2, toolMaxTokens: 200, summaryAs: 'system', summarize: async () => 'S' })
  assert.equal(r.messages[1].role, 'system')
  assert.equal(r.messages[1].content, `${SUMMARY_MARKER}\nS`)
  assert.equal(r.messages[2].role, 'user')
})

test('deterministic for the same summarizer; needsCompaction', async () => {
  const opts = { budgetTokens: 2000, keepTurns: 2, summarize: async (t: string) => `len ${t.length}` }
  const a = await compactHistory(conversation(8), opts)
  const b = await compactHistory(conversation(8), opts)
  assert.deepEqual(a, b)
  assert.equal(needsCompaction(conversation(8), 2000), true)
  assert.equal(needsCompaction(a.messages, estimateMessagesTokens(a.messages)), false)
})

test('summary input is capped', async () => {
  let len = 0
  await compactHistory(conversation(30, 'x'.repeat(20) + '\n'), {
    budgetTokens: 300,
    keepTurns: 1,
    summaryInputTokens: 200,
    summarize: async (t) => ((len = estimateTokens(t)), 's')
  })
  assert.ok(len <= 200, String(len))
})
