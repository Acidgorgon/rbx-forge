// Browser-preview seed: a busy agent turn like a real one (reads, a task list, accepted actions,
// file edits, a pending approval), so the chat's activity grouping and cards can be looked at.
import type { ChatMessage, ChatSession } from '@shared/types'
import { diffCard, type DiffCardData } from '@shared/chatModes'

export function seedFishingChat(chats: ChatSession[], messages: Record<string, ChatMessage[]>): void {
  const t0 = Date.now() - 600_000
  let n = 0
  const at = () => t0 + n * 4000
  const id = 'chat-fish'
  const m = (p: Omit<ChatMessage, 'id' | 'at' | 'agentId' | 'sessionId'>): ChatMessage => ({ id: `fish-${n++}`, at: at(), agentId: 'main', sessionId: id, ...p })
  const tool = (name: string, input: string) => m({ role: 'tool', text: '', tool: { name, input } })
  const action = (tool: string, text: string): ChatMessage => {
    const card: DiffCardData = { path: '', tool, action: text, hunks: [], added: 0, removed: 0, state: 'accepted' }
    return m({ role: 'assistant', text: `${tool} ${text}`, diff: card, mode: 'edit' })
  }
  const edit = (path: string, before: string | null, after: string, state: DiffCardData['state'] = 'accepted'): ChatMessage => {
    const card = { ...diffCard(path, 'write_script', before, after), state }
    return m({ role: 'assistant', text: `write_script ${path} (+${card.added} −${card.removed})`, diff: card, mode: 'edit' })
  }
  const service = 'local FishingService = {}\n\nfunction FishingService:Init(janitor)\n\tself.janitor = janitor\nend\n\nreturn FishingService\n'
  const serviceAfter =
    'local Events = require(ReplicatedStorage.Shared.Events)\n\nlocal FishingService = {}\n\nlocal FISH = { "Carp", "Trout", "Salmon", "Golden Koi" }\n\nfunction FishingService:Init(janitor)\n\tself.janitor = janitor\nend\n\nfunction FishingService:Start()\n\tEvents.FishingAction.On(function(player, action)\n\t\tif action ~= "cast" then return end\n\t\ttask.wait(math.random(2, 5))\n\t\tEvents.FishingResult.Fire(player, { state = "caught", fish = FISH[math.random(#FISH)] })\n\tend)\nend\n\nreturn FishingService\n'
  const list: ChatMessage[] = [
    m({ role: 'user', text: 'make a quick fishing system.', mode: 'edit' }),
    m({ role: 'assistant', text: "I'll scaffold a **Fishing** feature, add two Blink events and wire the server loop." }),
    tool('read_script', 'path=events.blink'),
    tool('update_todos', 'todos=[{"text":"Create the Fishing feature","state":"in_progress"},...'),
    tool('new_feature', 'name=Fishing'),
    action('new_feature', 'name=Fishing'),
    tool('add_blink_event', 'name=FishingAction kind=event from=Client type=Reliable call=SingleSync'),
    tool('add_blink_event', 'name=FishingResult kind=event from=Server type=Reliable call=SingleSync'),
    action('add_blink_event', 'name=FishingAction kind=event from=Client type=Reliable call=SingleSync data=(action: string) scope=Fishing'),
    action('add_blink_event', 'name=FishingResult kind=event from=Server type=Reliable call=SingleSync data=(state: string, fish: string) scope=Fishing'),
    tool('read_script', 'path=src/server/Features/Fishing/FishingService.luau'),
    tool('write_script', 'path=src/server/Features/Fishing/FishingService.luau'),
    edit('src/server/Features/Fishing/FishingService.luau', service, serviceAfter),
    tool('update_todos', 'todos=[{"text":"Create the Fishing feature","state":"done"},...'),
    tool('run_tests', 'filter=Fishing'),
    m({
      role: 'assistant',
      text:
        "Done. The fishing loop works end to end:\n\n## What changed\n\n1. **Fishing feature** scaffolded by `./dev` (service, controller, shared module).\n2. Two Blink events in the `Fishing` scope:\n   - `FishingAction` (client → server): `cast` or `reel`\n   - `FishingResult` (server → client): the state and the fish\n3. `FishingService:Start()` waits 2 to 5 seconds after a cast and rolls a fish.\n\n```luau\nEvents.FishingAction.On(function(player, action)\n\tif action ~= \"cast\" then return end\n\ttask.wait(math.random(2, 5))\nend)\n```\n\nNext: a rod in `StarterPack` and a small catch popup. Want me to add those?"
    }),
    m({ role: 'user', text: 'yes, add the catch popup', mode: 'edit' }),
    tool('read_script', 'path=src/client/Client/Controllers/FishingController/init.luau'),
    tool('search_code', 'query=FishingResult'),
    edit('src/client/Client/Controllers/FishingController/init.luau', 'local FishingController = {}\n\nreturn FishingController\n', 'local Events = require(ReplicatedStorage.Shared.Events)\nlocal FishingController = {}\n\nfunction FishingController:Start()\n\tEvents.FishingResult.On(function(result)\n\t\tshowPopup(`You caught a {result.fish}!`)\n\tend)\nend\n\nreturn FishingController\n', 'pending')
  ]
  chats.unshift({
    id,
    title: 'Quick fishing system',
    createdAt: t0,
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    todos: [
      { text: 'Create the Fishing feature', state: 'done' },
      { text: 'Add FishingAction and FishingResult events', state: 'done' },
      { text: 'Server loop: cast, wait, roll a fish', state: 'done' },
      { text: 'Client catch popup', state: 'in_progress' },
      { text: 'Rod in StarterPack', state: 'pending' }
    ]
  })
  messages[id] = list
}
