// Chat thread display (renderer/assistant/chatItems.ts) and the markdown block parser
// (renderer/components/markdownParse.ts): tool activity folding, card pairing, summaries, the task
// list placement, nested lists and tables.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityRows, activitySummary, buildItems, callCount, elapsed, runningLabel } from '../src/renderer/src/assistant/chatItems.ts'
import { parseMarkdown } from '../src/renderer/src/components/markdownParse.ts'
import type { ChatMessage } from '../src/shared/types.ts'
import type { DiffCardData } from '../src/shared/chatModes.ts'

let n = 0
const tool = (name: string, input = ''): ChatMessage => ({ id: `t${n++}`, role: 'tool', text: '', tool: { name, input }, at: n, agentId: 'main' })
const say = (text: string, role: ChatMessage['role'] = 'assistant'): ChatMessage => ({ id: `m${n++}`, role, text, at: n, agentId: 'main' })
const card = (toolName: string, state: DiffCardData['state'], path = ''): ChatMessage => ({
  id: `d${n++}`,
  role: 'assistant',
  text: toolName,
  at: n,
  agentId: 'main',
  diff: { path, tool: toolName, hunks: [], added: 2, removed: 1, state, ...(path ? {} : { action: 'name=X' }) }
})

test('consecutive tool calls and decided cards fold into one activity item', () => {
  const items = buildItems([say('go', 'user'), tool('read_script', 'path=a.luau'), tool('add_blink_event', 'name=A'), card('add_blink_event', 'accepted'), tool('add_blink_event', 'name=B'), card('add_blink_event', 'accepted'), say('done')])
  assert.deepEqual(items.map((i) => i.kind), ['msg', 'activity', 'msg'])
  const act = items[1]
  assert.equal(act.kind === 'activity' && act.entries.length, 5)
  if (act.kind !== 'activity') return
  // Each card pairs with its call: three rows, not five.
  assert.equal(callCount(act.entries), 3)
  assert.equal(activityRows(act.entries).filter((r) => r.diff).length, 2)
  assert.equal(activitySummary(act.entries), 'Added 2 Blink events, read 1 file')
})

test('a card waiting for a decision stays its own item between activity groups', () => {
  const items = buildItems([tool('read_script'), tool('edit_script', 'path=x.luau'), card('edit_script', 'pending', 'x.luau'), tool('read_script')])
  assert.deepEqual(items.map((i) => i.kind), ['activity', 'msg', 'activity'])
})

test('edits count distinct files; rejected and failed calls are called out', () => {
  const failed = tool('run_tests')
  failed.text = 'Error: 2 tests failed'
  const entries = [tool('write_script', 'path=a.luau'), card('write_script', 'accepted', 'a.luau'), tool('edit_script', 'path=a.luau'), card('edit_script', 'accepted', 'a.luau'), tool('Edit', 'file_path=b.luau'), card('Edit', 'rejected', 'b.luau'), failed]
  assert.equal(activitySummary(entries), 'Edited 1 file, ran a check, 1 rejected, 1 failed')
})

test('the task list shows once, at its latest update, only when the chat has one', () => {
  const msgs = [tool('update_todos', 'todos=[...]'), tool('read_script'), tool('update_todos', 'todos=[...]'), tool('read_script'), say('ok')]
  assert.deepEqual(buildItems(msgs, true).map((i) => i.kind), ['activity', 'todos', 'activity', 'msg'])
  assert.deepEqual(buildItems(msgs, false).map((i) => i.kind), ['activity', 'msg'])
})

test('different agents or guest models do not share a group; empty tool-step text is dropped', () => {
  const guest = { ...tool('read_script'), speaker: { provider: 'openai' as const, model: 'sol', label: 'Sol' } }
  const agent = { ...tool('studio_run'), agentId: 'agent-1' }
  assert.deepEqual(buildItems([tool('read_script'), say(''), tool('read_script'), guest, agent]).map((i) => i.kind), ['activity', 'activity', 'activity'])
})

test('live label and elapsed time', () => {
  assert.equal(runningLabel(tool('Bash', 'command=ls')), 'Running a command')
  assert.equal(runningLabel(tool('read_script', 'path=src/a/B.luau')), 'Reading B.luau')
  assert.equal(runningLabel(tool('mcp__studio__run_code')), 'Running a command')
  assert.equal(runningLabel(say('hi', 'user')), 'Thinking')
  assert.equal(elapsed(12_400), '12s')
  assert.equal(elapsed(121_000), '2m 1s')
})

test('markdown: nested lists, rules, tables and paragraphs that end at a list', () => {
  const md = parseMarkdown('Intro line\n1. **One**\n2. Two:\n   - a\n   - b\n3. Three\n\n---\n\n| A | B |\n|---|:-:|\n| 1 | 2 |\n\n# Title #')
  assert.deepEqual(md.map((b) => b.kind), ['p', 'ol', 'hr', 'table', 'h'])
  const ol = md[1]
  assert.ok(ol.kind === 'ol')
  if (ol.kind !== 'ol') return
  assert.equal(ol.items.length, 3)
  assert.equal(ol.items[1].children[0].kind, 'ul')
  const table = md[3]
  assert.ok(table.kind === 'table' && table.head[1] === 'B' && table.align[1] === 'center' && table.rows[0][0] === '1')
  assert.ok(md[4].kind === 'h' && md[4].text === 'Title')
})

test('markdown: loose lists continue across blank lines; an unterminated fence keeps its code', () => {
  const md = parseMarkdown('- a\n\n- b\n\ntext\n```luau\nlocal x = 1')
  assert.deepEqual(md.map((b) => b.kind), ['ul', 'p', 'code'])
  assert.ok(md[0].kind === 'ul' && md[0].items.length === 2)
  assert.ok(md[2].kind === 'code' && md[2].text === 'local x = 1' && md[2].lang === 'luau')
})
