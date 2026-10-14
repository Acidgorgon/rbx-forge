// Browser-preview mock of chat modes and slash commands (main/agent/modes.ts, agent/commands):
// Plan mode answers with a plan card, Edit mode posts a diff card that waits for Accept / Reject,
// commands answer with canned output. ?chatmode=plan|ask|edit|auto sets the seeded chats' mode.
import type { ChatMessage, ChatSession, HarnessApi, HarnessEvents } from '@shared/types'
import { BUILTIN_COMMANDS, parseCustomCommand, commandInfo, expandCommand, type ChatCommandResult } from '@shared/chatCommands'
import { diffCard, isChatMode, isReadOnlyMode, modeLabel, planCard, planRunPrompt, type ChatMode, type CheckpointInfo } from '@shared/chatModes'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

interface Deps {
  emit: Emit
  chats: ChatSession[]
  messages: Record<string, ChatMessage[]>
  files: Record<string, string>
  reply: (sessionId: string, text: string) => Promise<void>
  log: (text: string) => void
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
let seq = 0
const uid = (p: string) => `${p}-cm-${Date.now().toString(36)}-${seq++}`

const CUSTOM = parseCustomCommand(
  'balance.md',
  '---\ndescription: Check a feature for economy balance issues\nargument-hint: <feature>\nmode: ask\n---\nReview the economy numbers of the $ARGUMENTS feature: prices, rewards, drop rates. Flag anything that breaks progression.',
  'project',
  '.forge/commands/balance.md'
)!

const PLAN = `## Summary
Add a daily login reward with a streak, saved in PlayerData and claimed from a popup.

## Steps
1. Add \`DailyReward\` config (rewards per streak day) in \`src/shared/Features/DailyReward/Config.luau\`.
2. Create \`DailyRewardService\`: check last claim time on join, compute the streak, grant coins.
3. Add a \`ClaimDailyReward\` event to \`events.blink\` (Client -> Server, Reliable).
4. Add \`DailyRewardController\` that shows the popup when a reward is ready.
5. Write a Lune spec for the streak maths (reset after 48 h).

## Files
- \`src/shared/Features/DailyReward/Config.luau\` - new
- \`src/server/Features/DailyReward/DailyRewardService.luau\` - new
- \`events.blink\` - one event
- \`src/server/Features/Data/DataService.luau\` - two new fields

## Risks
- Old saves have no \`lastClaim\` field: default it to 0 so nobody gets a streak from nothing.
- Clock skew: use \`os.time()\` on the server only, never the client's time.`

export function chatModesMock(d: Deps) {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('chatmode') : null
  if (isChatMode(q)) for (const c of d.chats) c.chatMode = q
  const checkpoints: Record<string, CheckpointInfo[]> = {}
  const pendingRun = new Map<string, { sessionId: string; after: string; path: string }>()

  const push = (sessionId: string, m: ChatMessage) => {
    const list = (d.messages[sessionId] ??= [])
    const i = list.findIndex((x) => x.id === m.id)
    if (i >= 0) list[i] = m
    else list.push(m)
    d.emit('chat:message', { ...m, sessionId })
  }
  const busy = (sessionId: string, on: boolean) => d.emit('chat:busy', { sessionId, busy: on })
  const modeOf = (id: string): ChatMode => d.chats.find((c) => c.id === id)?.chatMode ?? 'edit'
  const tool = (sessionId: string, name: string, input: string, mode: ChatMode) => push(sessionId, { id: uid('t'), role: 'tool', text: '', tool: { name, input }, at: Date.now(), agentId: 'main', mode })
  const say = (sessionId: string, command: string, text: string) => push(sessionId, { id: uid('c'), role: 'system', text, at: Date.now(), agentId: 'main', command })

  const planTurn = async (sessionId: string) => {
    busy(sessionId, true)
    for (const [n, i] of [['project_map', 'maxTokens=1500'], ['find_symbol', 'name=DataService'], ['read_script', 'path=src/server/Features/Data/DataService.luau from=1 to=80'], ['blink_events', '']]) {
      await delay(350)
      tool(sessionId, n, i, 'plan')
    }
    await delay(400)
    for (const m of d.messages[sessionId] ?? []) if (m.planMode?.state === 'pending') push(sessionId, { ...m, planMode: { ...m.planMode, state: 'superseded' } })
    const card = planCard(PLAN)
    push(sessionId, { id: uid('p'), role: 'assistant', text: card.text, at: Date.now(), agentId: 'main', planMode: card, mode: 'plan' })
    busy(sessionId, false)
  }

  const editTurn = async (sessionId: string, mode: ChatMode) => {
    busy(sessionId, true)
    const path = 'src/server/Features/Data/DataService.luau'
    const before = [
      'local Players = game:GetService("Players")',
      'local DataStoreService = game:GetService("DataStoreService")',
      '',
      'local DataService = {}',
      'local store = DataStoreService:GetDataStore("PlayerData")',
      '',
      'local DEFAULTS = {',
      '\tcoins = 0,',
      '\tlevel = 1,',
      '}',
      '',
      'local function copy(t)',
      '\tlocal out = {}',
      '\tfor k, v in t do',
      '\t\tout[k] = v',
      '\tend',
      '\treturn out',
      'end',
      '',
      'function DataService:Load(player)',
      '\tlocal ok, data = pcall(store.GetAsync, store, player.UserId)',
      '\treturn ok and data or copy(DEFAULTS)',
      'end',
      '',
      'function DataService:Init()',
      'end',
      '',
      'return DataService'
    ].join('\n')
    const after = before.replace('\tlevel = 1,\n', '\tlevel = 1,\n\tstreak = 0,\n\tlastClaim = 0,\n').replace('function DataService:Init()\nend', 'function DataService:Init()\n\tself.profiles = {}\nend')
    tool(sessionId, 'read_script', `path=${path}`, mode)
    await delay(400)
    if (!checkpoints[sessionId]?.length) {
      const user = [...(d.messages[sessionId] ?? [])].reverse().find((m) => m.role === 'user')
      if (user) (checkpoints[sessionId] ??= []).push({ id: uid('cp'), at: Date.now(), messageId: user.id, label: user.text.slice(0, 80), commit: 'mock' })
    }
    if (mode === 'auto') {
      tool(sessionId, 'edit_script', `path=${path}`, mode)
      d.files[path] = after
      await delay(300)
      push(sessionId, { id: uid('a'), role: 'assistant', text: 'Added `streak` and `lastClaim` to the PlayerData defaults (auto-accepted).', at: Date.now(), agentId: 'main', mode })
      busy(sessionId, false)
      return
    }
    const id = uid('d')
    const card = diffCard(path, 'edit_script', before, after)
    pendingRun.set(id, { sessionId, after, path })
    push(sessionId, { id, role: 'assistant', text: `edit_script ${path} (+${card.added} −${card.removed})`, at: Date.now(), agentId: 'main', diff: card, mode })
  }

  const turn = async (sessionId: string, text: string, mode: ChatMode) => {
    if (mode === 'plan') return planTurn(sessionId)
    if (mode === 'ask' || !/\b(add|fix|change|edit|implement|make|update|run it|plan)\b/i.test(text)) return d.reply(sessionId, text)
    return editTurn(sessionId, mode)
  }

  // sendChat: true when the mode handled the message.
  const intercept = async (sessionId: string, text: string, mode = modeOf(sessionId)): Promise<boolean> => {
    const user = [...(d.messages[sessionId] ?? [])].reverse().find((m) => m.role === 'user')
    if (user && !user.mode) push(sessionId, { ...user, mode })
    if (mode === 'edit' && !/\b(add|fix|change|edit|implement|make|update)\b/i.test(text)) return false
    if (mode === 'auto' && !/\b(add|fix|change|edit|implement|make|update)\b/i.test(text)) return false
    void turn(sessionId, text, mode)
    return true
  }

  const command = async (sessionId: string, name: string, args: string): Promise<ChatCommandResult> => {
    const out = (text: string, extra: Omit<ChatCommandResult, 'text'> = {}) => (say(sessionId, `/${name}${args ? ` ${args}` : ''}`, text), { text, ...extra })
    const chat = d.chats.find((c) => c.id === sessionId)
    switch (name) {
      case 'help':
        return out(`**Commands**\n${BUILTIN_COMMANDS.map((c) => `- \`/${c.name}${c.args ? ` ${c.args}` : ''}\` ${c.description}`).join('\n')}\n\n**Custom commands**\n- \`/balance <feature>\` ${CUSTOM.description} _(project)_`)
      case 'clear':
        d.messages[sessionId] = []
        say(sessionId, '/clear', 'Conversation cleared. The next message starts fresh (files are unchanged; /rewind still has the checkpoints).')
        return { action: { kind: 'selectChat', id: sessionId } }
      case 'compact':
        return out('Compacted: ~18.4k → ~0.9k tokens (saved ~17.5k). The next message continues from this summary:\n\n- Goal: daily login reward with a streak\n- Plan approved; DataService defaults updated\n- Open: DailyRewardService, popup controller, spec')
      case 'cost':
        return out('**This chat**\n- 14 requests · input 182k · output 9.4k · cache read 151k · cache write 21k\n- cost $0.4120\n\n**Today** $1.86\n\n**Labs (gating: cost per kept result)**\n- vfx: 12 runs, 5 kept, $0.94 · $0.19 per kept · gates saved ~41k tokens\n- anim: 4 runs, 2 kept, $0.31 · $0.16 per kept')
      case 'context':
        return out(`**Context** · ${chat?.provider}/${chat?.model} · ${modeLabel(modeOf(sessionId))} mode · ~14.2k tokens (estimate)\n\n- System prompt: ~1.1k (8%)\n- Project rules + memory: ~1.6k (11%)\n- Tools (31): ~5.9k (42%)\n- Conversation: ~5.6k (39%)`)
      case 'model':
        return args ? out(`Model: ${args} for this chat.`) : { action: { kind: 'pickModel' } }
      case 'effort':
        return out(args ? `Effort set to ${args} for this chat.` : 'Effort: auto. Use /effort auto|low|medium|high|xhigh|max.')
      case 'memory':
        return args ? out(`Saved to project memory: “${args}”`) : { action: { kind: 'openPage', page: 'memory' } }
      case 'todos':
        return out('- [x] Add DailyReward config\n- [~] DailyRewardService streak logic\n- [ ] ClaimDailyReward event\n- [ ] Popup controller\n- [ ] Lune spec')
      case 'permissions': {
        const m = modeOf(sessionId)
        return out(
          isReadOnlyMode(m)
            ? `**${modeLabel(m)}** mode\n\n**Runs without asking:** Read, Glob, Grep, \`project_map\`, \`read_script\`, \`search_code\`, \`find_symbol\`, \`blink_events\`, \`run_tests\`, …\n\n**Blocked:** Edit, Write, \`write_script\`, \`edit_script\`, \`new_feature\`, \`add_blink_event\`, \`add_wally_package\`, \`rename_feature\`, \`run_in_terminal\`, Studio tools, Bash (off in Settings)`
            : `**${modeLabel(m)}** mode\n\n**Runs without asking:** Read, Glob, Grep, \`project_map\`, \`read_script\`, \`search_code\`, \`run_tests\`, \`run_in_terminal\` (asks in the terminal), …\n\n**Asks you first:** ${m === 'auto' ? 'nothing (auto-accept)' : 'Edit, Write, \`write_script\`, \`edit_script\`, \`new_feature\`, \`add_blink_event\`, \`add_wally_package\`, \`rename_feature\`, Studio tools'}\n\n**Blocked:** Bash (off in Settings)`
        )
      }
      case 'export':
        return out(`Saved \`.forge/exports/${(chat?.title ?? 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${new Date().toISOString().slice(0, 10)}.md\` (48 lines).`)
      case 'init':
        say(sessionId, '/init', 'Investigating the project (read-only), then writing .forge/AGENTS.md. An existing file is merged, never overwritten; the root AGENTS.md is not touched.')
        busy(sessionId, true)
        await delay(900)
        say(sessionId, '/init', 'Merged 7 new lines into .forge/AGENTS.md (existing notes kept as they were).')
        busy(sessionId, false)
        return { started: true }
      case 'review':
        push(sessionId, { id: uid('u'), role: 'user', text: '/review', at: Date.now(), agentId: 'main', mode: 'ask' })
        void d.reply(sessionId, 'review the diff')
        return { started: true }
      case 'resume':
        return { action: { kind: 'pickChat', chats: d.chats.filter((c) => c.id !== sessionId).map((c) => ({ id: c.id, title: c.title, model: c.model, lastAt: c.lastAt ?? c.createdAt })) } }
      case 'rewind': {
        const list = checkpoints[sessionId] ?? []
        if (!list.length) return out('No checkpoints in this chat yet. One is taken before each turn that can edit files (Edit and Auto-accept modes).')
        return { action: { kind: 'pickCheckpoint', checkpoints: list.slice().reverse().map((c) => ({ id: c.id, label: c.label, at: c.at })) } }
      }
      case 'ask':
      case 'plan':
        if (!args) return out(`Add the message after /${name}.`)
        push(sessionId, { id: uid('u'), role: 'user', text: args, at: Date.now(), agentId: 'main', mode: name })
        void turn(sessionId, args, name)
        return { started: true }
      case 'balance':
        push(sessionId, { id: uid('u'), role: 'user', text: `/balance ${args}`, at: Date.now(), agentId: 'main', mode: 'ask' })
        void d.reply(sessionId, expandCommand(CUSTOM.body, args))
        return { started: true }
    }
    return out(`Unknown command /${name}. Type /help for the list.`)
  }

  const api: Pick<HarnessApi, 'setChatMode' | 'sendChatMode' | 'reviewChatEdit' | 'planCardAction' | 'listChatCommands' | 'runChatCommand' | 'rewindChat'> = {
    async setChatMode(sessionId, mode) {
      const c = d.chats.find((x) => x.id === sessionId)
      if (!c) throw new Error('unknown chat')
      c.chatMode = mode
      d.emit('chat:updated', { ...c })
      return { ...c }
    },
    async sendChatMode(sessionId, text, mode) {
      push(sessionId, { id: uid('u'), role: 'user', text, at: Date.now(), agentId: 'main', mode })
      await turn(sessionId, text, mode)
    },
    async reviewChatEdit(sessionId, messageId, decision) {
      const m = d.messages[sessionId]?.find((x) => x.id === messageId)
      const run = pendingRun.get(messageId)
      if (!m?.diff || !run) throw new Error('that change is no longer waiting')
      pendingRun.delete(messageId)
      const ids = m.diff.hunks.map((h) => h.id)
      const accepted = decision.accept ? decision.hunks ?? ids : []
      const state = !accepted.length ? 'rejected' : accepted.length === ids.length ? 'accepted' : 'partial'
      push(sessionId, { ...m, diff: { ...m.diff, state, ...(state === 'partial' ? { accepted } : {}) } })
      if (state !== 'rejected') d.files[run.path] = run.after
      await delay(400)
      push(sessionId, { id: uid('a'), role: 'assistant', text: state === 'rejected' ? 'Understood, I left `DataService.luau` as it was. Want me to keep the streak somewhere else?' : state === 'partial' ? `Applied the hunk${accepted.length === 1 ? '' : 's'} you accepted; the rest stays as it was.` : 'Added `streak` and `lastClaim` to the PlayerData defaults. Next: `DailyRewardService`.', at: Date.now(), agentId: 'main', mode: modeOf(sessionId) })
      busy(sessionId, false)
    },
    async planCardAction(sessionId, messageId, action, opts) {
      const m = d.messages[sessionId]?.find((x) => x.id === messageId)
      if (!m?.planMode) throw new Error('no plan card')
      const text = opts?.text?.trim()
      const plan = text && text !== m.planMode.text ? { ...planCard(text), edited: true } : m.planMode
      if (action === 'edit') return push(sessionId, { ...m, text: plan.text, planMode: { ...plan, state: m.planMode.state } })
      if (action === 'keep') return push(sessionId, { ...m, planMode: { ...plan, state: 'kept' } })
      const runMode = opts?.runMode === 'auto' ? 'auto' : 'edit'
      push(sessionId, { ...m, text: plan.text, planMode: { ...plan, state: 'approved', runMode } })
      await api.setChatMode(sessionId, runMode)
      push(sessionId, { id: uid('u'), role: 'user', text: `Approved the plan: run it (${modeLabel(runMode)}).`, at: Date.now(), agentId: 'main', mode: runMode })
      d.log(`plan approved: ${planRunPrompt(plan).slice(0, 60)}…`)
      void editTurn(sessionId, runMode)
    },
    async listChatCommands() {
      return [...BUILTIN_COMMANDS.map((c) => ({ ...c, source: 'builtin' as const })), commandInfo(CUSTOM)]
    },
    runChatCommand: (sessionId, name, args) => command(sessionId, name.replace(/^\//, '').toLowerCase(), args ?? ''),
    async rewindChat(sessionId, checkpointId, what) {
      const cp = checkpoints[sessionId]?.find((c) => c.id === checkpointId)
      if (!cp) throw new Error('checkpoint not found')
      const list = d.messages[sessionId] ?? []
      const at = list.findIndex((m) => m.id === cp.messageId)
      const removed = what !== 'files' && at >= 0 ? list.length - at : 0
      if (removed) list.splice(at)
      checkpoints[sessionId] = checkpoints[sessionId].filter((c) => c.at < cp.at)
      const files = what !== 'chat' ? ['src/server/Features/Data/DataService.luau'] : []
      say(sessionId, '/rewind', `Rewound to before “${cp.label}”: ${[files.length ? `${files.length} file restored` : '', removed ? `conversation rewound (${removed} messages removed)` : ''].filter(Boolean).join(', ')}.`)
      return { files, removed }
    }
  }
  return { api, intercept }
}
