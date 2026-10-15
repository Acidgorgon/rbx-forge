// Browser-preview mock of the memory + skills layer (MemoryApi). In-memory stores seeded with a few
// memories and skills, a feed, and one reflection proposal on chat-3. mock.ts spreads it into its
// api object. window.__forgeMemoryPropose("chat-id") fakes a new reflection card for design work.
import type { HarnessEvents, MemoryApi, MemoryEntry, MemoryFeedItem, MemoryInput, MemoryKind, MemoryProposal, MemoryScope, MemorySettings } from '@shared/types'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

const H = 3600_000
const now = () => Date.now()
const slug = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

function entry(scope: MemoryScope, kind: MemoryKind, name: string, description: string, body: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const file = kind === 'skill' ? `skills/${name}/SKILL.md` : `${name}.md`
  return { id: `${scope}:${kind}:${name}`, scope, kind, name, description, body, created: now() - 72 * H, lastUsed: now() - 2 * H, uses: 3, file, ...(kind === 'memory' ? { type: scope === 'user' ? 'user' : 'project' } : {}), ...extra }
}

export function memoryMock(emit: Emit): MemoryApi {
  let entries: MemoryEntry[] = [
    entry('user', 'memory', 'answer-style', 'Prefers terse answers: the diff first, then one line of why', 'Lead with the change (diff or code), then at most one sentence of reasoning. No recap of what was asked.\n\n**Why:** said "skip the essay, just show me the code" twice.', { type: 'feedback', uses: 14, pinned: true }),
    entry('user', 'memory', 'naming-signals', 'Names Vide sources with a trailing noun, never a "get" prefix', 'Vide sources: `open`, `coins`, `selectedItem` — not `getOpen` / `isOpenSignal`. Derived values use the same style.', { type: 'user', uses: 6 }),
    entry('user', 'memory', 'preferred-models', 'Opus for refactors and new features, Sonnet for quick questions', 'Use the big tier for multi-file refactors and new Features; the cheap tier is fine for explanations and one-line fixes.', { type: 'user', uses: 2, lastUsed: now() - 30 * H }),
    entry('project', 'memory', 'luau-style-profile', 'Luau code style of this project (indentation, naming, modules, comments, Vide UI): follow it when writing code', 'Observed in 42 Luau files (3,118 lines) of this project.\n\n## Formatting\n- Indentation: tabs.\n- `--!strict`: 81% of files (add it to new files).\n\n## Naming\n- Locals: camelCase. Functions/methods: PascalCase. Constants: UPPER_SNAKE. Modules/services: PascalCase.\n\n## Modules\n- Table modules: `local X = {}` … `return X` (31 files).\n- GenTree lifecycle: Services/Controllers define `:Init(janitor)` and `:Start()` (12 files).\n\n## Vide UI\n- `local create = Vide.create` is hoisted at the top of UI files.\n- Instances are built as `create("Frame")({ ... })` (parenthesised calls).', { uses: 22, created: now() - 120 * H }),
    entry('project', 'memory', 'currency-is-server-authoritative', 'Coins only change on the server via EconomyService; clients request through Blink', 'Never adjust coins on the client. Clients fire `Economy.RequestPurchase`; EconomyService validates price and stock and replies with `Economy.PurchaseResult`.\n\n**Why:** exploit in v0.3 where a LocalScript set coins directly.', { uses: 9 }),
    entry('project', 'memory', 'data-store-keys', 'PlayerData uses ProfileStore with key "Player_<UserId>" in store "PlayerData_v2"', 'Store name `PlayerData_v2` (v1 is frozen). Keys `Player_<UserId>`. Bump the store name only with a migration in PlayerData.luau.', { type: 'reference', uses: 4 }),
    entry('project', 'skill', 'add-gentree-feature-with-blink', 'Adding a new GenTree feature that needs client/server networking', '1. new_feature {name} (PascalCase) and wait for ./dev to scaffold the Service and Controller.\n2. add_blink_event for each message (scope = feature name); Reliable unless it is per-frame.\n3. Server: connect in Service:Start(), never Init.\n4. Client: fire from the Controller; keep UI state in Vide sources.\n5. run_tests, then blink_check.', { uses: 5 }),
    entry('project', 'skill', 'vide-component-in-house-style', "Making a Vide UI component in this project's style", '1. File in src/shared/Interface/Components/<Name>.luau, `--!strict` header.\n2. `local create = Vide.create`; component is `local function Name(props)` returning `create("Frame")({ ... })`.\n3. State as sources passed in props; derive, do not copy.\n4. Mount from App, never from a Controller.', { uses: 2 }),
    entry('user', 'skill', 'profile-a-slow-server', 'A server frame-time regression needs tracking down', '1. Reproduce in a Studio play test with the MicroProfiler on.\n2. Tag suspect loops with debug.profilebegin/end.\n3. Compare against the last release tag.', { uses: 1 })
  ]
  let feed: MemoryFeedItem[] = [
    { at: now() - 0.3 * H, action: 'saved', scope: 'project', kind: 'memory', name: 'data-store-keys', description: 'PlayerData uses ProfileStore with key "Player_<UserId>"', source: 'agent' },
    { at: now() - 2 * H, action: 'proposed', scope: 'user', kind: 'memory', name: 'test-before-commit', description: 'Runs run_tests before every commit', source: 'reflection' },
    { at: now() - 5 * H, action: 'skill', scope: 'project', kind: 'skill', name: 'add-gentree-feature-with-blink', description: 'Adding a new GenTree feature that needs networking', source: 'agent' },
    { at: now() - 26 * H, action: 'merged', scope: 'user', kind: 'memory', name: 'answer-style', description: 'Prefers terse answers', source: 'reflection' },
    { at: now() - 50 * H, action: 'style', scope: 'project', kind: 'memory', name: 'luau-style-profile', description: '42 files analyzed', source: 'style' },
    { at: now() - 70 * H, action: 'promoted', scope: 'project', kind: 'memory', name: 'currency-is-server-authoritative', description: 'Coins only change on the server', source: 'user' }
  ]
  let settings: MemorySettings = { reflection: 'ask', styleOnOpen: false }
  let proposals: MemoryProposal[] = [
    {
      id: 'p-1',
      sessionId: 'chat-3',
      createdAt: now() - 2 * H,
      input: { scope: 'user', kind: 'memory', type: 'feedback', name: 'test-before-commit', description: 'Wants run_tests to pass before any commit or sync', body: 'Always run_tests (Lune) and fix failures before committing or syncing.\n\n**Why:** "don\'t push red tests again".' },
      reason: 'The person corrected the agent after a failing sync.'
    }
  ]

  const changed = () => emit('memory:changed', { at: now() })
  const log = (item: Omit<MemoryFeedItem, 'at'>) => {
    feed = [{ at: now(), ...item }, ...feed].slice(0, 60)
  }
  const listing = () => ({ user: entries.filter((e) => e.scope === 'user'), project: entries.filter((e) => e.scope === 'project'), projectRoot: '/Users/dev/Projects/gentree-game' })
  const save = (input: MemoryInput, previous?: { scope: MemoryScope; kind: MemoryKind; name: string }) => {
    const kind = input.kind ?? 'memory'
    const name = slug(input.name)
    if (!name || !input.description.trim() || !input.body.trim()) throw new Error('name, description and body are required')
    if (/sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY/.test(input.body)) throw new Error('looks like it contains an API key; memories never hold secrets')
    if (previous) entries = entries.filter((e) => !(e.scope === previous.scope && e.kind === previous.kind && e.name === previous.name))
    const old = entries.find((e) => e.scope === input.scope && e.kind === kind && e.name === name)
    const next = entry(input.scope, kind, name, input.description.trim(), input.body.trim(), { created: old?.created ?? now(), uses: old?.uses ?? 0, lastUsed: now(), pinned: old?.pinned, ...(kind === 'memory' ? { type: input.type ?? (input.scope === 'user' ? 'user' : 'project') } : {}) })
    entries = [...entries.filter((e) => e !== old), next]
    return { entry: next, action: old ? ('updated' as const) : ('created' as const) }
  }

  ;(window as unknown as { __forgeMemoryPropose?: (sessionId: string) => void }).__forgeMemoryPropose = (sessionId: string) => {
    proposals = [
      {
        id: `p-${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        createdAt: now(),
        input: { scope: 'project', kind: 'skill', name: 'add-shop-item', description: 'Adding a purchasable item to the shop', body: '1. Add the item to src/shared/Features/Shop/Items.luau.\n2. Price in Robux AND coins.\n3. run_tests ShopService.spec.' },
        reason: 'The same three steps were done twice in this chat.'
      },
      ...proposals
    ]
    emit('memory:proposals', { sessionId, proposals: proposals.filter((p) => p.sessionId === sessionId) })
  }

  return {
    async memoryList() {
      return listing()
    },
    async memorySearch(q) {
      const terms = q.toLowerCase().split(/\W+/).filter(Boolean)
      if (!terms.length) return entries.slice()
      return entries
        .map((e) => ({ e, s: terms.filter((t) => `${e.name} ${e.description} ${e.body}`.toLowerCase().includes(t)).length }))
        .filter((x) => x.s)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.e)
    },
    async memorySave(input, previous) {
      const r = save(input, previous)
      log({ action: 'updated', scope: input.scope, kind: input.kind ?? 'memory', name: r.entry.name, description: r.entry.description, source: 'user' })
      changed()
      return r
    },
    async memoryDelete(scope, kind, name) {
      const before = entries.length
      entries = entries.filter((e) => !(e.scope === scope && e.kind === kind && e.name === name))
      log({ action: 'forgot', scope, kind, name, source: 'user' })
      changed()
      return entries.length < before
    },
    async memoryPin(scope, kind, name, pinned) {
      entries = entries.map((e) => (e.scope === scope && e.kind === kind && e.name === name ? { ...e, pinned: pinned || undefined } : e))
      changed()
    },
    async memoryPromote(kind, name) {
      const e = entries.find((x) => x.scope === 'user' && x.kind === kind && x.name === name)
      if (!e) throw new Error('not found')
      const r = save({ scope: 'project', kind, name, description: e.description, body: e.body, type: e.type === 'user' ? 'project' : e.type }, { scope: 'user', kind, name })
      log({ action: 'promoted', scope: 'project', kind, name, description: e.description, source: 'user' })
      changed()
      return r
    },
    async memoryFeed() {
      return feed.slice()
    },
    async memoryGetSettings() {
      return { ...settings }
    },
    async memorySetSettings(patch) {
      settings = { ...settings, ...patch }
      return { ...settings }
    },
    async memoryProposals(sessionId) {
      return proposals.filter((p) => !sessionId || p.sessionId === sessionId)
    },
    async memoryAcceptProposal(id, edited) {
      const p = proposals.find((x) => x.id === id)
      if (!p) throw new Error('that proposal is gone')
      const r = save({ ...p.input, ...edited })
      proposals = proposals.filter((x) => x !== p)
      log({ action: r.entry.kind === 'skill' ? 'skill' : 'saved', scope: r.entry.scope, kind: r.entry.kind, name: r.entry.name, description: r.entry.description, source: 'reflection' })
      emit('memory:proposals', { sessionId: p.sessionId, proposals: proposals.filter((x) => x.sessionId === p.sessionId) })
      changed()
      return r
    },
    async memoryDismissProposal(id) {
      const p = proposals.find((x) => x.id === id)
      proposals = proposals.filter((x) => x.id !== id)
      if (p) {
        log({ action: 'dismissed', scope: p.input.scope, kind: p.input.kind ?? 'memory', name: p.input.name, source: 'user' })
        emit('memory:proposals', { sessionId: p.sessionId, proposals: proposals.filter((x) => x.sessionId === p.sessionId) })
      }
    },
    async memoryAnalyzeStyle() {
      await new Promise((r) => setTimeout(r, 700))
      const e = entries.find((x) => x.name === 'luau-style-profile')!
      const updated = { ...e, lastUsed: now() }
      entries = entries.map((x) => (x === e ? updated : x))
      log({ action: 'style', scope: 'project', kind: 'memory', name: e.name, description: '42 files analyzed', source: 'style' })
      changed()
      return {
        profile: { files: 42, lines: 3118, indent: { style: 'tabs' }, strictMode: 0.81, naming: { locals: 'camelCase', functions: 'PascalCase', constants: 'UPPER_SNAKE', modules: 'PascalCase' }, modules: [], comments: [], vide: [], body: e.body },
        result: { entry: updated, action: 'updated' }
      }
    }
  }
}
