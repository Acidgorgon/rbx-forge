// Orchestrator tests: plan validation, DAG scheduling, locks, summaries-only feedback, budgets,
// cancellation/timeouts and the auto-mode heuristic. Agents are scripted fakes of runAgent: each
// script calls the tools it was given (as a model would) and yields AgentEvents.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  Orchestrator,
  LockManager,
  validatePlan,
  findCycle,
  topoOrder,
  capsBudget,
  shouldOrchestrate,
  toolsForRole,
  classifyTool,
  clipToTokens,
  ROLE_DEFAULTS,
  type AgentEvent,
  type AgentSpec,
  type OrchestratorEvent,
  type OrchTool,
  type RunAgent,
  type ToolResult
} from '../src/main/agent/orchestrator/index.ts'

// ---- helpers ----

const HOT = ['events.blink', 'wally.toml', 'default.project.json']
const V = (tasks: unknown[], extra: Partial<Parameters<typeof validatePlan>[1]> = {}) => validatePlan({ tasks }, { maxTasks: 12, hotFiles: HOT, ...extra })

const text = (r: ToolResult) => r.content.map((c) => c.text).join('')

function baseTools(files: Map<string, string>): OrchTool<any>[] {
  const t = (name: string, shape: z.ZodRawShape, handler: (a: any) => Promise<ToolResult>): OrchTool<any> => ({ name, description: name, inputSchema: shape, handler: (a) => handler(a) })
  const okr = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }] })
  return [
    t('read_script', { path: z.string() }, async (a) => okr(files.get(a.path) ?? 'missing')),
    t('search_code', { query: z.string() }, async () => okr('no hits')),
    t('write_script', { path: z.string(), contents: z.string() }, async (a) => (files.set(a.path, a.contents), okr(`wrote ${a.path}`))),
    t('edit_script', { path: z.string(), old_string: z.string(), new_string: z.string() }, async (a) => (files.set(a.path, (files.get(a.path) ?? '').replace(a.old_string, a.new_string)), okr('edited'))),
    t('create_spec', { path: z.string(), contents: z.string() }, async (a) => (files.set(a.path, a.contents), okr('spec written'))),
    t('run_tests', { filter: z.string().optional() }, async () => okr('3 passed')),
    t('restart_service', { service: z.string() }, async () => okr('restarted'))
  ]
}

type Helper = {
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>
  has(name: string): boolean
}
type Script = (spec: AgentSpec, h: Helper) => AsyncGenerator<AgentEvent, void, unknown>

function helper(spec: AgentSpec): Helper {
  return {
    has: (name) => spec.tools.some((t) => t.name === name),
    async call(name, args = {}) {
      const t = spec.tools.find((x) => x.name === name)
      if (!t) throw new Error(`${spec.taskId} has no tool ${name} (has ${spec.tools.map((x) => x.name).join(', ')})`)
      return t.handler(args as any, {})
    }
  }
}

// runAgent backed by scripts keyed by task id (or role as fallback).
function fakeRunner(scripts: Record<string, Script>): { runAgent: RunAgent; specs: AgentSpec[] } {
  const specs: AgentSpec[] = []
  const runAgent: RunAgent = (spec) => {
    specs.push(spec)
    const script = scripts[spec.taskId] ?? scripts[spec.role]
    if (!script) throw new Error(`no script for ${spec.taskId}`)
    return script(spec, helper(spec))
  }
  return { runAgent, specs }
}

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

function waitAbort(signal: AbortSignal): Promise<void> {
  return new Promise((r) => (signal.aborted ? r() : signal.addEventListener('abort', () => r(), { once: true })))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Lead that submits `plan` and, at integration, answers `answer`.
function lead(plan: unknown[] | null, answer = 'All done.', onIntegrate?: (spec: AgentSpec, h: Helper) => Promise<void>): Record<string, Script> {
  return {
    'lead-plan': async function* (_spec, h) {
      if (plan) {
        const r = await h.call('submit_plan', { tasks: plan })
        assert.ok(!r.isError, text(r))
        yield { type: 'text', text: 'planned' }
      } else yield { type: 'text', text: answer }
    },
    'lead-int-1': async function* (spec, h) {
      await onIntegrate?.(spec, h)
      yield { type: 'text', text: answer }
    }
  }
}

function specialist(summary: string, opts: { files?: [string, string][]; status?: 'done' | 'partial' | 'failed' } = {}): Script {
  return async function* (_spec, h) {
    for (const [path, contents] of opts.files ?? []) {
      const r = await h.call('write_script', { path, contents })
      assert.ok(!r.isError, text(r))
    }
    await h.call('submit_result', { status: opts.status ?? 'done', summary })
    yield { type: 'text', text: 'ok' }
  }
}

function setup(scripts: Record<string, Script>, settings: Record<string, unknown> = {}, extra: Partial<ConstructorParameters<typeof Orchestrator>[0]> = {}) {
  const files = new Map<string, string>()
  const events: OrchestratorEvent[] = []
  const { runAgent, specs } = fakeRunner(scripts)
  const orch = new Orchestrator({ runAgent, tools: () => baseTools(files), emit: (e) => events.push(e), settings, ...extra })
  return { orch, files, events, specs }
}

// ---- plan validation ----

test('validatePlan accepts a good plan and orders it topologically', () => {
  const v = V([
    { id: 'b', role: 'builder', goal: 'build', files: ['src/server/A.luau'], dependsOn: ['s'] },
    { id: 's', role: 'scout', goal: 'look' },
    { id: 'r', role: 'reviewer', goal: 'review', dependsOn: ['b'] }
  ])
  assert.ok(v.ok)
  assert.deepEqual(v.order, ['s', 'b', 'r'])
  assert.deepEqual(v.plan.tasks.find((t) => t.id === 's')!.files, [])
})

test('validatePlan rejects two concurrent builders on the same file (incl. folder claims and testers)', () => {
  let v = V([
    { id: 'a', role: 'builder', goal: 'x', files: ['src/server/A.luau'] },
    { id: 'b', role: 'builder', goal: 'y', files: ['./src/server/A.luau'] }
  ])
  assert.ok(!v.ok)
  assert.match(v.errors.join('\n'), /a and b .*both edit src\/server\/A\.luau/)

  v = V([
    { id: 'a', role: 'builder', goal: 'x', files: ['src/server/Features/Shop/'] },
    { id: 'b', role: 'tester', goal: 'y', files: ['src/server/Features/Shop/Shop.spec.luau'] }
  ])
  assert.ok(!v.ok, 'folder claim overlaps a file inside it')

  // Same file but ordered by a dependency: claims never coexist, so it is allowed.
  v = V([
    { id: 'a', role: 'builder', goal: 'x', files: ['src/server/A.luau'] },
    { id: 'm', role: 'scout', goal: 'between', dependsOn: ['a'] },
    { id: 'b', role: 'builder', goal: 'y', files: ['src/server/A.luau'], dependsOn: ['m'] }
  ])
  assert.ok(v.ok, 'transitively ordered builders may share a file')

  // Read-only roles may mention the same files freely.
  v = V([
    { id: 'a', role: 'builder', goal: 'x', files: ['src/server/A.luau'] },
    { id: 's', role: 'scout', goal: 'y', files: ['src/server/A.luau'] }
  ])
  assert.ok(v.ok)
})

test('validatePlan rejects cycles, unknown/self deps, duplicates, hot files, bad paths, empty builders', () => {
  let v = V([
    { id: 'a', role: 'scout', goal: 'x', dependsOn: ['c'] },
    { id: 'b', role: 'scout', goal: 'y', dependsOn: ['a'] },
    { id: 'c', role: 'scout', goal: 'z', dependsOn: ['b'] }
  ])
  assert.ok(!v.ok)
  assert.match(v.errors[0], /dependency cycle: a -> c -> b -> a/)

  v = V([
    { id: 'a', role: 'scout', goal: 'x', dependsOn: ['a', 'nope'] },
    { id: 'a', role: 'lead', goal: '' },
    { id: 'w', role: 'builder', goal: 'events', files: ['events.blink', 'src/x.luau'] },
    { id: 'e', role: 'builder', goal: 'nothing' },
    { id: 'p', role: 'builder', goal: 'escape', files: ['../outside.luau'] }
  ])
  assert.ok(!v.ok)
  const all = v.errors.join('\n')
  assert.match(all, /duplicate id/)
  assert.match(all, /role must be one of/)
  assert.match(all, /goal is empty/)
  assert.match(all, /events\.blink is a shared file only the lead edits/)
  assert.match(all, /a builder needs the files/)
  assert.match(all, /not a path inside the project/)
  assert.match(all, /depends on itself/)
  assert.match(all, /unknown task nope/)

  assert.ok(!V([]).ok)
  assert.ok(!V(Array.from({ length: 13 }, (_, i) => ({ id: `t${i}`, role: 'scout', goal: 'g' }))).ok)
  // Later rounds: ids of earlier rounds cannot be reused but are valid (finished) dependencies.
  assert.ok(!V([{ id: 'old', role: 'scout', goal: 'g' }], { takenIds: ['old'] }).ok)
  assert.ok(V([{ id: 'new', role: 'scout', goal: 'g', dependsOn: ['old'] }], { takenIds: ['old'] }).ok)
})

test('findCycle / topoOrder helpers', () => {
  assert.equal(findCycle([{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }]), null)
  assert.deepEqual(findCycle([{ id: 'x', dependsOn: ['x'] }]), ['x', 'x'])
  assert.deepEqual(topoOrder([{ id: 'c', dependsOn: ['a', 'b'] }, { id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['ext'] }]), ['a', 'b', 'c'])
})

// ---- locks ----

test('LockManager: all-or-nothing claims, folders, hot files, lead rights', () => {
  const l = new LockManager(HOT)
  assert.ok(l.claim('t1', ['src/a.luau', 'src/Feat/']).ok)
  const r = l.claim('t2', ['src/b.luau', 'src/Feat/x.luau'])
  assert.ok(!r.ok && r.conflicts[0].owner === 't1')
  assert.equal(l.ownerOf('src/b.luau'), undefined, 'failed claim takes nothing')
  assert.ok(!l.claim('t2', ['wally.toml']).ok)
  assert.ok(l.canWrite('t1', 'src/Feat/deep/y.luau').ok)
  assert.match((l.canWrite('t2', 'src/a.luau') as { reason: string }).reason, /claimed by task t1/)
  assert.match((l.canWrite('t2', 'src/c.luau') as { reason: string }).reason, /not claimed by this task/)
  assert.match((l.canWrite('t1', 'events.blink') as { reason: string }).reason, /only the lead/)
  assert.ok(l.canWrite('lead', 'events.blink').ok)
  assert.ok(!l.canWrite('lead', 'src/a.luau').ok, 'lead cannot write a file a running task owns')
  l.release('t1')
  assert.ok(l.canWrite('lead', 'src/a.luau').ok)
  assert.ok(l.claim('t2', ['src/a.luau']).ok)
})

test('builder write tools refuse unclaimed and hot files; request_change reaches the lead', async () => {
  let builderLog: string[] = []
  let leadPrompt = ''
  const { orch, files, events } = setup({
    ...lead(
      [
        { id: 'b1', role: 'builder', goal: 'shop service', files: ['src/server/Features/Shop/init.luau'] },
        { id: 'b2', role: 'builder', goal: 'shop ui', files: ['src/client/ShopController.luau'] }
      ],
      'Shop added.',
      async (spec, h) => {
        leadPrompt = spec.prompt
        const r = await h.call('edit_script', { path: 'events.blink', old_string: '', new_string: 'event BuyItem {}\n' })
        assert.ok(!r.isError, text(r))
      }
    ),
    b1: async function* (_s, h) {
      builderLog.push(text(await h.call('write_script', { path: 'src/server/Features/Shop/init.luau', contents: 'return {}' })))
      builderLog.push(text(await h.call('write_script', { path: 'src/client/ShopController.luau', contents: 'x' })))
      builderLog.push(text(await h.call('write_script', { path: 'events.blink', contents: 'x' })))
      builderLog.push(text(await h.call('claim_files', { files: ['src/server/Features/Shop/Util.luau'] })))
      builderLog.push(text(await h.call('write_script', { path: 'src/server/Features/Shop/Util.luau', contents: 'u' })))
      builderLog.push(text(await h.call('claim_files', { files: ['wally.toml'] })))
      builderLog.push(text(await h.call('request_change', { file: 'events.blink', change: 'add event BuyItem' })))
      await h.call('submit_result', { status: 'done', summary: 'ShopService added' })
      yield { type: 'text', text: 'done' }
    },
    b2: specialist('controller added', { files: [['src/client/ShopController.luau', 'ctrl']] })
  })
  files.set('events.blink', '')
  const res = await orch.start({ request: 'add a shop', model: 'm' }).done
  assert.equal(res.state, 'done')
  assert.match(builderLog[0], /wrote/)
  assert.match(builderLog[1], /refused: .*(claimed by task b2|not claimed by this task)/)
  assert.match(builderLog[2], /refused: events\.blink is a shared file/)
  assert.match(builderLog[3], /claimed src\/server\/Features\/Shop\/Util\.luau/)
  assert.match(builderLog[4], /wrote/)
  assert.match(builderLog[5], /refused: wally\.toml is a shared file/)
  assert.match(builderLog[6], /queued cr1/)
  assert.equal(files.get('src/client/ShopController.luau'), 'ctrl', 'b1 never overwrote b2s file')
  assert.equal(files.get('events.blink'), 'event BuyItem {}\n', 'lead applied the hot-file change')
  assert.match(leadPrompt, /cr1 from b1: events\.blink: add event BuyItem/)
  const b1 = res.board.tasks.find((t) => t.id === 'b1')!
  assert.deepEqual(b1.filesChanged.sort(), ['src/server/Features/Shop/Util.luau', 'src/server/Features/Shop/init.luau'])
  assert.ok(events.some((e) => e.type === 'change_request'))
  assert.equal(res.answer, 'Shop added.')
})

test('roles get the right tools: scouts read-only, admin tools never, tester only create_spec', async () => {
  const seen: Record<string, string[]> = {}
  const record: Script = async function* (spec, h) {
    seen[spec.taskId] = spec.tools.map((t) => t.name)
    await h.call('submit_result', { status: 'done', summary: 's' })
    yield { type: 'done' }
  }
  const { orch } = setup({
    ...lead([
      { id: 'sc', role: 'scout', goal: 'g' },
      { id: 'bu', role: 'builder', goal: 'g', files: ['src/a.luau'] },
      { id: 'te', role: 'tester', goal: 'g', files: ['tests/a.spec.luau'] },
      { id: 'rv', role: 'reviewer', goal: 'g' }
    ]),
    sc: record,
    bu: record,
    te: record,
    rv: record
  })
  await orch.start({ request: 'r', model: 'm' }).done
  assert.deepEqual(seen.sc, ['read_script', 'search_code', 'submit_result'])
  assert.deepEqual(seen.bu, ['read_script', 'search_code', 'create_spec', 'edit_script', 'write_script', 'claim_files', 'request_change', 'submit_result'])
  assert.deepEqual(seen.te, ['read_script', 'run_tests', 'search_code', 'create_spec', 'claim_files', 'request_change', 'submit_result'])
  assert.deepEqual(seen.rv, ['read_script', 'search_code', 'run_diff', 'submit_result'])
  for (const names of Object.values(seen)) assert.ok(!names.includes('restart_service'))
  assert.equal(classifyTool('mcp__gentree__write_script'), 'write')
  assert.equal(toolsForRole('scout', baseTools(new Map())).some((t) => classifyTool(t.name) !== 'read'), false)
})

// ---- DAG ordering and parallelism ----

test('DAG runs in dependency order with at most maxParallel tasks at once', async () => {
  let running = 0
  let peak = 0
  const order: string[] = []
  const finished: string[] = []
  const work =
    (ms: number): Script =>
    async function* (spec, h) {
      running++
      peak = Math.max(peak, running)
      order.push(spec.taskId)
      await sleep(ms)
      running--
      finished.push(spec.taskId)
      await h.call('submit_result', { status: 'done', summary: `${spec.taskId} ok` })
      yield { type: 'text', text: 'ok' }
    }
  const { orch, specs, events } = setup(
    {
      ...lead([
        { id: 'a', role: 'scout', goal: 'a' },
        { id: 'b', role: 'scout', goal: 'b' },
        { id: 'c', role: 'scout', goal: 'c' },
        { id: 'd', role: 'builder', goal: 'd', files: ['src/d.luau'], dependsOn: ['a', 'b'] },
        { id: 'e', role: 'reviewer', goal: 'e', dependsOn: ['d'] }
      ]),
      a: work(30),
      b: work(10),
      c: work(20),
      d: work(5),
      e: work(5)
    },
    { maxParallel: 2 }
  )
  const res = await orch.start({ request: 'r', model: 'm' }).done
  assert.equal(res.state, 'done')
  assert.equal(peak, 2)
  assert.deepEqual(order.slice(0, 2), ['a', 'b'])
  assert.ok(order.indexOf('d') > order.indexOf('c'), 'c starts when b frees a slot, before d is ready')
  assert.ok(finished.indexOf('a') < order.indexOf('d') && finished.indexOf('b') < order.indexOf('d'))
  assert.equal(order.at(-1), 'e')
  // d's prompt carries a and b summaries (its dependencies) but not c's.
  const dSpec = specs.find((s) => s.taskId === 'd')!
  assert.match(dSpec.prompt, /a \[scout\] done: a ok/)
  assert.doesNotMatch(dSpec.prompt, /c ok/)
  // Board events showed d blocked before it ran.
  assert.ok(events.some((e) => e.type === 'task' && e.task.id === 'd' && e.task.state === 'blocked' && /waiting on a, b/.test(e.task.detail ?? '')))
  assert.deepEqual(
    res.board.tasks.map((t) => [t.id, t.state]),
    [
      ['lead-plan', 'done'],
      ['a', 'done'],
      ['b', 'done'],
      ['c', 'done'],
      ['d', 'done'],
      ['e', 'done'],
      ['lead-int-1', 'done']
    ]
  )
  // Models by role tier.
  const { orch: o2, specs: s2 } = setup({ ...lead([{ id: 's', role: 'scout', goal: 'g' }]), s: specialist('x') })
  await o2.start({ request: 'r', model: 'chosen', tiers: { big: 'BIG', cheap: 'CHEAP' } }).done
  assert.deepEqual(s2.map((s) => [s.taskId, s.model]), [['lead-plan', 'BIG'], ['s', 'CHEAP'], ['lead-int-1', 'BIG']])
})

test('a failed task cancels its dependents but not independent tasks', async () => {
  const { orch } = setup({
    ...lead([
      { id: 'a', role: 'builder', goal: 'a', files: ['src/a.luau'] },
      { id: 'b', role: 'reviewer', goal: 'b', dependsOn: ['a'] },
      { id: 'c', role: 'scout', goal: 'c' }
    ]),
    a: specialist('could not', { status: 'failed' }),
    b: specialist('never'),
    c: specialist('fine')
  })
  const res = await orch.start({ request: 'r', model: 'm' }).done
  const st = Object.fromEntries(res.board.tasks.map((t) => [t.id, [t.state, t.detail]]))
  assert.equal(st.a[0], 'failed')
  assert.deepEqual(st.b, ['cancelled', 'dependency a failed'])
  assert.equal(st.c[0], 'done')
  assert.equal(res.state, 'done')
})

test('invalid plans are returned to the lead to fix; too many invalid plans fail the run', async () => {
  const replies: string[] = []
  const { orch } = setup({
    'lead-plan': async function* (_s, h) {
      replies.push(text(await h.call('submit_plan', { tasks: [{ id: 'a', role: 'builder', goal: 'x', files: ['src/a.luau'] }, { id: 'b', role: 'builder', goal: 'y', files: ['src/a.luau'] }] })))
      replies.push(text(await h.call('submit_plan', { tasks: [{ id: 'a', role: 'builder', goal: 'x', files: ['src/a.luau'] }] })))
      yield { type: 'text', text: 'planned' }
    },
    'lead-int-1': async function* () {
      yield { type: 'text', text: 'fin' }
    },
    a: specialist('ok')
  })
  const res = await orch.start({ request: 'r', model: 'm' }).done
  assert.match(replies[0], /Plan rejected/)
  assert.match(replies[1], /Plan accepted/)
  assert.equal(res.state, 'done')

  const { orch: o2 } = setup(
    {
      'lead-plan': async function* (_s, h) {
        for (let i = 0; i < 3; i++) await h.call('submit_plan', { tasks: [{ id: 'x', role: 'scout', goal: 'g', dependsOn: ['x'] }] })
        yield { type: 'text', text: 'gave up' }
      }
    },
    { maxPlanAttempts: 2 }
  )
  const r2 = await o2.start({ request: 'r', model: 'm' }).done
  assert.equal(r2.state, 'failed')
  assert.match(r2.detail ?? '', /could not produce a valid plan/)
})

test('a lead that does not plan answers directly', async () => {
  const { orch, specs } = setup(lead(null, 'Just an answer.'))
  const res = await orch.start({ request: 'what is a Service?', model: 'm' }).done
  assert.equal(res.state, 'done')
  assert.equal(res.answer, 'Just an answer.')
  assert.equal(specs.length, 1)
})

test('the lead may re-plan for a second round with new ids depending on earlier tasks', async () => {
  const { orch } = setup({
    ...lead([{ id: 'a', role: 'scout', goal: 'a' }]),
    'lead-int-1': async function* (_s, h) {
      const r = await h.call('submit_plan', { tasks: [{ id: 'a2', role: 'builder', goal: 'use findings', files: ['src/x.luau'], dependsOn: ['a'] }] })
      assert.ok(!r.isError, text(r))
      yield { type: 'text', text: 'one more round' }
    },
    'lead-int-2': async function* (spec, h) {
      assert.ok(!h.has('submit_plan'), 'no third round with maxRounds 2')
      assert.match(spec.prompt, /a2 \[builder\] done: built/)
      yield { type: 'text', text: 'final' }
    },
    a: specialist('found'),
    a2: specialist('built', { files: [['src/x.luau', 'x']] })
  })
  const res = await orch.start({ request: 'r', model: 'm' }).done
  assert.equal(res.state, 'done')
  assert.equal(res.answer, 'final')
  assert.equal(res.board.tasks.find((t) => t.id === 'a2')!.round, 2)
})

// ---- summaries only ----

test('the lead sees only compact submit_result summaries, never transcripts', async () => {
  let integratePrompt = ''
  const long = 'word '.repeat(2000)
  const { orch } = setup(
    {
      ...lead([{ id: 's1', role: 'scout', goal: 'look' }, { id: 's2', role: 'scout', goal: 'look more' }, { id: 's3', role: 'scout', goal: 'quiet' }], 'ok', async (spec) => {
        integratePrompt = spec.prompt
      }),
      s1: async function* (_s, h) {
        yield { type: 'text', text: 'SECRET-TRANSCRIPT reasoning about lots of files' }
        yield { type: 'tool_call', name: 'read_script', input: { path: 'src/a.luau' } }
        await h.call('submit_result', { status: 'done', summary: 'Found ShopService in src/server/Shop.luau', followups: ['check pricing'] })
        yield { type: 'text', text: 'SECRET-AFTER' }
      },
      s2: async function* (_s, h) {
        await h.call('submit_result', { status: 'partial', summary: long })
        yield { type: 'done' }
      },
      // Ends without submit_result: its last text becomes a clipped "partial" summary.
      s3: async function* () {
        yield { type: 'text', text: 'I looked and found nothing' }
      }
    },
    { maxSummaryTokens: 50 }
  )
  const runId = 'r-sum'
  const res = await orch.start({ request: 'r', model: 'm', runId }).done
  assert.match(integratePrompt, /s1 \[scout\] done: Found ShopService in src\/server\/Shop\.luau/)
  assert.match(integratePrompt, /followups: check pricing/)
  assert.doesNotMatch(integratePrompt, /SECRET/)
  assert.match(integratePrompt, /s3 \[scout\] partial: I looked and found nothing/)
  const s2 = res.board.tasks.find((t) => t.id === 's2')!
  assert.ok(s2.summary!.length <= 50 * 4, `clipped summary (${s2.summary!.length} chars)`)
  assert.ok(integratePrompt.length < 2000, 'integration prompt stays small')
  // The transcript is still available on demand for the UI.
  const tr = orch.transcript(runId, 's1')!
  assert.ok(tr.some((m) => m.text.includes('SECRET-TRANSCRIPT')))
  assert.ok(tr.some((m) => m.role === 'tool' && m.tool?.name === 'read_script'))
  assert.equal(tr[0].agentId, `orch:${runId}:s1`)
  assert.equal(orch.transcript(runId, 'nope'), null)
  assert.equal(clipToTokens('abc', 10), 'abc')
})

// ---- budgets ----

test('task budget stop fails that task; run budget stop ends the run', async () => {
  const burn = (tokens: number): Script =>
    async function* (spec, h) {
      for (let i = 0; i < 10; i++) {
        if (spec.signal.aborted) return
        yield { type: 'usage', usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 } }
        await sleep(1)
      }
      await h.call('submit_result', { status: 'done', summary: 'finished' })
    }
  const { orch, events } = setup(
    { ...lead([{ id: 'hog', role: 'scout', goal: 'g' }, { id: 'ok', role: 'scout', goal: 'g' }]), hog: burn(500), ok: burn(10) },
    {},
    { budget: capsBudget({ taskMaxTokens: 1000, runMaxTokens: 100_000, warnAt: 0.5 }) }
  )
  const res = await orch.start({ request: 'r', model: 'm' }).done
  const hog = res.board.tasks.find((t) => t.id === 'hog')!
  assert.equal(hog.state, 'failed')
  assert.match(hog.detail ?? '', /^budget: task hog used 1000 of 1000 tokens/)
  assert.equal(hog.tokens, 1000, 'stopped at the first event over the cap')
  assert.equal(res.board.tasks.find((t) => t.id === 'ok')!.state, 'done')
  assert.equal(res.state, 'done')
  assert.ok(events.some((e) => e.type === 'budget' && e.level === 'warn' && e.taskId === 'hog'))
  assert.ok(events.some((e) => e.type === 'budget' && e.level === 'stop' && e.taskId === 'hog'))

  const { orch: o2 } = setup(
    {
      ...lead([{ id: 'x', role: 'scout', goal: 'g' }, { id: 'y', role: 'scout', goal: 'g' }, { id: 'z', role: 'scout', goal: 'g', dependsOn: ['x'] }]),
      x: burn(300),
      y: burn(300)
    },
    {},
    { budget: capsBudget({ taskMaxTokens: 0, runMaxTokens: 1000 }) }
  )
  const r2 = await o2.start({ request: 'r', model: 'm' }).done
  assert.equal(r2.state, 'failed')
  assert.match(r2.detail ?? '', /budget: run used/)
  const st = Object.fromEntries(r2.board.tasks.map((t) => [t.id, t.state]))
  assert.equal(st.z, 'cancelled')
  assert.equal(st.x, 'failed')
  assert.ok(r2.board.tokens >= 1000)
  assert.ok(!r2.board.tasks.some((t) => t.id === 'lead-int-1'), 'no integration after a run budget stop')
})

// ---- cancellation and timeouts ----

test('cancel() stops running tasks, cancels queued ones, and ends the run', async () => {
  const started = deferred()
  const hang: Script = async function* (spec) {
    started.resolve()
    await waitAbort(spec.signal)
    yield { type: 'text', text: 'late' }
  }
  const { orch } = setup({ ...lead([{ id: 'a', role: 'scout', goal: 'g' }, { id: 'b', role: 'scout', goal: 'g', dependsOn: ['a'] }]), a: hang })
  const h = orch.start({ request: 'r', model: 'm' })
  await started.promise
  assert.equal(orch.board(h.runId)!.tasks.find((t) => t.id === 'a')!.state, 'running')
  orch.cancel(h.runId)
  const res = await h.done
  assert.equal(res.state, 'cancelled')
  assert.deepEqual(res.board.tasks.map((t) => [t.id, t.state]), [['lead-plan', 'done'], ['a', 'cancelled'], ['b', 'cancelled']])
})

test('cancelTask() cancels one task (and its dependents); others finish', async () => {
  const started = deferred()
  const { orch } = setup({
    ...lead([{ id: 'a', role: 'scout', goal: 'g' }, { id: 'b', role: 'scout', goal: 'g', dependsOn: ['a'] }, { id: 'c', role: 'scout', goal: 'g' }]),
    a: async function* (spec) {
      started.resolve()
      await waitAbort(spec.signal)
    },
    c: async function* (_s, h) {
      await started.promise
      await sleep(10)
      await h.call('submit_result', { status: 'done', summary: 'c done' })
    }
  })
  const h = orch.start({ request: 'r', model: 'm' })
  await started.promise
  orch.cancelTask(h.runId, 'a')
  const res = await h.done
  const st = Object.fromEntries(res.board.tasks.map((t) => [t.id, [t.state, t.detail]]))
  assert.deepEqual(st.a, ['cancelled', 'cancelled by user'])
  assert.deepEqual(st.b, ['cancelled', 'dependency a cancelled'])
  assert.equal(st.c[0], 'done')
  assert.equal(res.state, 'done')
})

test('per-task timeout fails a stuck task even if the agent ignores the signal; cancelAll stops everything', async () => {
  const { orch } = setup(
    {
      ...lead([{ id: 'stuck', role: 'scout', goal: 'g' }]),
      stuck: async function* () {
        await new Promise(() => {}) // never resolves, never checks the signal
      }
    },
    { taskTimeoutMs: 40 }
  )
  const res = await orch.start({ request: 'r', model: 'm' }).done
  const t = res.board.tasks.find((x) => x.id === 'stuck')!
  assert.equal(t.state, 'failed')
  assert.match(t.detail ?? '', /timeout/)
  assert.equal(res.state, 'done', 'the lead still integrates')

  const gate = deferred()
  const { orch: o2 } = setup({
    'lead-plan': async function* (spec) {
      gate.resolve()
      await waitAbort(spec.signal)
    }
  })
  const h1 = o2.start({ request: 'one', model: 'm' })
  await gate.promise
  o2.cancelAll()
  const r = await h1.done
  assert.equal(r.state, 'cancelled')
  assert.equal(o2.list()[0].state, 'cancelled')
})

test('events stream task states and a final board', async () => {
  const { orch, events } = setup({ ...lead([{ id: 's', role: 'scout', goal: 'g' }]), s: specialist('ok') })
  const res = await orch.start({ request: 'r', model: 'm' }).done
  await sleep(0)
  const states = events.filter((e): e is Extract<OrchestratorEvent, { type: 'task' }> => e.type === 'task' && e.task.id === 's').map((e) => e.task.state)
  assert.deepEqual([...new Set(states)], ['queued', 'running', 'done'])
  const fin = events.find((e) => e.type === 'finished')
  assert.ok(fin && fin.type === 'finished' && fin.board.state === 'done')
  const boards = events.filter((e) => e.type === 'board')
  assert.ok(boards.length >= 1)
  assert.equal(res.board.tasks.find((t) => t.id === 's')!.summary, 'ok')
})

// ---- auto mode ----

test('shouldOrchestrate: overrides, explicit wording, multi-feature requests vs simple ones', () => {
  assert.equal(shouldOrchestrate('fix typo', null, 'team').orchestrate, true)
  assert.equal(shouldOrchestrate('build 5 features across every service', null, 'single').orchestrate, false)
  assert.equal(shouldOrchestrate('Orchestrate this: add a shop').orchestrate, true)
  assert.equal(shouldOrchestrate('use a team to add a daily reward').orchestrate, true)
  assert.equal(shouldOrchestrate('Add a shop, inventory and trading system, but do it single-agent please').orchestrate, false)

  assert.equal(shouldOrchestrate('What does ModuleLoader do?').orchestrate, false)
  assert.equal(shouldOrchestrate('rename the Coins field in DataService').orchestrate, false)
  assert.equal(shouldOrchestrate('fix the nil error in src/server/Features/Shop/init.luau').orchestrate, false)

  const multi = `Please do the following:
1. Add a Shop feature with a ShopService and ShopController
2. Create a daily reward system that grants coins
3. Wire both into the DataService and write Lune specs for them
4. Review everything against the conventions`
  const d = shouldOrchestrate(multi)
  assert.equal(d.orchestrate, true, d.reason)
  assert.match(d.reason, /listed items/)

  const prose = 'Implement a trading feature end-to-end: add the TradeService, create the TradeController, update InventoryService and DataService to support escrow, and then write tests and also review the networking.'
  assert.equal(shouldOrchestrate(prose).orchestrate, true, shouldOrchestrate(prose).reason)
  // Small projects lean single for borderline requests.
  const borderline = 'Add a ShopService and a ShopController and update DataService'
  assert.ok(shouldOrchestrate(borderline, { scriptCount: 4 }).score < shouldOrchestrate(borderline, { scriptCount: 80 }).score)
})

test('role prompts are constant strings (byte-stable for prompt caching)', async () => {
  const { orch, specs } = setup({ ...lead([{ id: 's', role: 'scout', goal: 'g' }]), s: specialist('x') })
  await orch.start({ request: 'first', model: 'm' }).done
  const { orch: o2, specs: s2 } = setup({ ...lead([{ id: 's', role: 'scout', goal: 'other goal' }]), s: specialist('y') })
  await o2.start({ request: 'second, different request', model: 'm' }).done
  for (let i = 0; i < specs.length; i++) {
    assert.equal(specs[i].system, s2[i].system)
    assert.deepEqual(specs[i].tools.map((t) => t.name), s2[i].tools.map((t) => t.name))
  }
  assert.equal(specs[1].system, ROLE_DEFAULTS.scout.system)
  assert.doesNotMatch(ROLE_DEFAULTS.lead.system, /\$\{|Date|\d{4}-\d{2}-\d{2}/)
})
