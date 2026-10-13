// Browser-preview mock of the HarnessApi. main.tsx installs it only when the
// preload bridge is missing (plain Vite dev server, screenshots, design work).
import type {
  ChatMessage,
  ChatSession,
  GitStatus,
  HarnessApi,
  HarnessEvents,
  LogLine,
  ProjectInfo,
  ScriptEntry,
  ScriptGroup,
  ServiceId,
  ServiceStatus,
  StudioConflict,
  SyncSettings,
  TestAgent,
  TreeNode
} from '@shared/types'

type Handler = (payload: never) => void
const listeners = new Map<keyof HarnessEvents, Set<Handler>>()

function emit<K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]): void {
  listeners.get(event)?.forEach((h) => (h as (p: HarnessEvents[K]) => void)(payload))
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
let idSeq = 0
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(idSeq++).toString(36)}`
const now = () => Date.now()

// ---------------------------------------------------------------- files

const files: Record<string, string> = {
  'src/shared/Features/Inventory/init.luau': `--!strict
-- Shared Inventory feature: types and pure helpers used by server and client.

export type ItemId = string

export type Item = {
	id: ItemId,
	name: string,
	stack: number,
	maxStack: number,
}

export type Inventory = {
	capacity: number,
	items: { [ItemId]: Item },
}

local Inventory = {}

Inventory.DEFAULT_CAPACITY = 24

function Inventory.new(capacity: number?): Inventory
	return {
		capacity = capacity or Inventory.DEFAULT_CAPACITY,
		items = {},
	}
end

function Inventory.count(inv: Inventory): number
	local n = 0
	for _ in inv.items do
		n += 1
	end
	return n
end

function Inventory.canAdd(inv: Inventory, item: Item): boolean
	local existing = inv.items[item.id]
	if existing then
		return existing.stack + item.stack <= existing.maxStack
	end
	return Inventory.count(inv) < inv.capacity
end

function Inventory.describe(item: Item): string
	return \`{item.name} x{item.stack}\`
end

return Inventory
`,
  'src/server/Features/Inventory/InventoryService.luau': `--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Inventory = require(ReplicatedStorage.Shared.Features.Inventory)
local PlayerData = require(script.Parent.Parent.Parent.Data.PlayerData)
local Events = require(ReplicatedStorage.Shared.events.server)

local InventoryService = {}
InventoryService.Inventories = {} :: { [Player]: Inventory.Inventory }

function InventoryService:Init(janitor)
	janitor:Add(Players.PlayerRemoving:Connect(function(player)
		self.Inventories[player] = nil
	end))
end

function InventoryService:Start()
	Players.PlayerAdded:Connect(function(player)
		local data = PlayerData.get(player)
		self.Inventories[player] = data.inventory or Inventory.new()
		Events.InventoryChanged.Fire(player, self.Inventories[player])
	end)
end

function InventoryService:Give(player: Player, item: Inventory.Item): boolean
	local inv = self.Inventories[player]
	if not inv or not Inventory.canAdd(inv, item) then
		return false
	end
	local existing = inv.items[item.id]
	if existing then
		existing.stack += item.stack
	else
		inv.items[item.id] = table.clone(item)
	end
	Events.InventoryChanged.Fire(player, inv)
	return true
end

return InventoryService
`,
  'src/server/Features/Inventory/init.server.luau': `local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ModuleLoader = require(ReplicatedStorage.Shared.Modules.ModuleLoader)

-- Boots every server Feature module under this folder.
ModuleLoader.InitFolder(script.Parent)
`,
  'src/client/Client/Controllers/InventoryController/init.luau': `--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Inventory = require(ReplicatedStorage.Shared.Features.Inventory)
local Events = require(ReplicatedStorage.Shared.events.client)

local InventoryController = {}
InventoryController.Current = nil :: Inventory.Inventory?

function InventoryController:Init(janitor)
	janitor:Add(Events.InventoryChanged.On(function(inv)
		self.Current = inv
	end))
end

function InventoryController:Start()
	print("[InventoryController] ready")
end

return InventoryController
`,
  'src/shared/Modules/ModuleLoader.luau': `--!nocheck

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Janitor = require(ReplicatedStorage.Packages.Janitor)

local ModuleLoader = {}
ModuleLoader.Janitors = {}
ModuleLoader.Modules = {}

ModuleLoader.ClientLoaded = false

function ModuleLoader.InitFolder(Folder: Folder)
	if ModuleLoader.ClientLoaded then
		return
	end
	ModuleLoader.ClientLoaded = true

	for _, v in Folder:GetDescendants() do
		if v:IsA("ModuleScript") then
			local module = require(v)
			ModuleLoader.Modules[v.Name] = module
		end
	end

	--[[
		Init runs synchronously in require order, then Start runs
		in its own thread for every module that defines it.
	]]
	for _, module in ModuleLoader.Modules do
		if type(module) == "table" and module.Init then
			local janitor = Janitor.new()
			ModuleLoader.Janitors[module] = janitor
			module:Init(janitor)
		end
	end

	for _, module in ModuleLoader.Modules do
		if type(module) == "table" and module.Start then
			task.spawn(function()
				module:Start()
			end)
		end
	end
end

return ModuleLoader
`,
  'src/shared/events/client.luau': `--!strict
--!native
--!optimize 2
-- File generated by Blink v0.18.1 (https://github.com/1Axen/Blink)
-- This file is not meant to be edited

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local BASE_EVENT_NAME = "BLINK"
local Invocations = 0

type Entry = {
    value: any,
    next: Entry?
}

return {}
`,
  'src/shared/events/server.luau': `--!strict
--!native
--!optimize 2
-- File generated by Blink v0.18.1 (https://github.com/1Axen/Blink)
-- This file is not meant to be edited

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")

return {}
`,
  'src/shared/Interface/MountUI.luau': `local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Vide = require(ReplicatedStorage.Packages.Vide)
local app = require(ReplicatedStorage.Shared.Interface.App.app)

return function()
	local player = Players.LocalPlayer
	local playerGui = player:WaitForChild("PlayerGui")

	return Vide.mount(app, playerGui)
end
`,
  'src/shared/Interface/App/app.luau': `local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Vide = require(ReplicatedStorage.Packages.Vide)

local create = Vide.create

local function app()
	return create("ScreenGui")({
		Name = "HUD",
		ResetOnSpawn = false,
		IgnoreGuiInset = true,
	})
end

return app
`,
  'src/client/Client/init.client.luau': `local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ModuleLoader = require(ReplicatedStorage.Shared.Modules.ModuleLoader)
local MountUI = require(ReplicatedStorage.Shared.Interface.MountUI)

ModuleLoader.InitFolder(script.Controllers)
MountUI()
`,
  'src/server/Data/PlayerData.luau': `--!strict
-- Session data per player. Swap the store for ProfileStore when the game ships.
local DataStoreService = game:GetService("DataStoreService")

export type Data = {
	coins: number,
	inventory: any?,
}

local store = DataStoreService:GetDataStore("PlayerData_v1")
local cache: { [Player]: Data } = {}

local PlayerData = {}

local DEFAULT: Data = {
	coins = 0,
	inventory = nil,
}

function PlayerData.get(player: Player): Data
	local data = cache[player]
	if data then
		return data
	end
	local ok, saved = pcall(store.GetAsync, store, \`player_{player.UserId}\`)
	data = if ok and saved then saved else table.clone(DEFAULT)
	cache[player] = data
	return data
end

return PlayerData
`
}

// ---------------------------------------------------------------- project

const project: ProjectInfo = { root: '/Users/dev/Games/GenTree', name: 'GenTree', placeIds: [123456789] }

function script(path: string, instancePath: string[], kind: ScriptEntry['kind'], category: ScriptEntry['category'], realm: ScriptEntry['realm'], feature?: string): ScriptEntry {
  return { path, instancePath, name: instancePath[instancePath.length - 1], kind, category, realm, feature }
}

const scriptGroups: ScriptGroup[] = [
  { category: 'Configs', scripts: [] },
  {
    category: 'Data',
    scripts: [script('src/server/Data/PlayerData.luau', ['ServerScriptService', 'Server', 'Data', 'PlayerData'], 'ModuleScript', 'Data', 'server')]
  },
  {
    category: 'Services',
    scripts: [
      script('src/server/Features/Inventory/InventoryService.luau', ['ServerScriptService', 'Server', 'Features', 'Inventory', 'InventoryService'], 'ModuleScript', 'Services', 'server', 'Inventory')
    ]
  },
  {
    category: 'Controllers',
    scripts: [
      script('src/client/Client/Controllers/InventoryController/init.luau', ['StarterPlayer', 'StarterPlayerScripts', 'Client', 'Controllers', 'InventoryController'], 'ModuleScript', 'Controllers', 'client', 'Inventory')
    ]
  },
  {
    category: 'Modules',
    scripts: [
      script('src/shared/Features/Inventory/init.luau', ['ReplicatedStorage', 'Shared', 'Features', 'Inventory'], 'ModuleScript', 'Modules', 'shared', 'Inventory'),
      script('src/shared/Modules/ModuleLoader.luau', ['ReplicatedStorage', 'Shared', 'Modules', 'ModuleLoader'], 'ModuleScript', 'Modules', 'shared')
    ]
  },
  {
    category: 'Events',
    scripts: [
      script('src/shared/events/client.luau', ['ReplicatedStorage', 'Shared', 'events', 'client'], 'ModuleScript', 'Events', 'shared'),
      script('src/shared/events/server.luau', ['ReplicatedStorage', 'Shared', 'events', 'server'], 'ModuleScript', 'Events', 'shared')
    ]
  },
  {
    category: 'UI',
    scripts: [
      script('src/shared/Interface/MountUI.luau', ['ReplicatedStorage', 'Shared', 'Interface', 'MountUI'], 'ModuleScript', 'UI', 'shared'),
      script('src/shared/Interface/App/app.luau', ['ReplicatedStorage', 'Shared', 'Interface', 'App', 'app'], 'ModuleScript', 'UI', 'shared')
    ]
  },
  {
    category: 'Entry points',
    scripts: [
      script('src/client/Client/init.client.luau', ['StarterPlayer', 'StarterPlayerScripts', 'Client'], 'LocalScript', 'Entry points', 'client'),
      script('src/server/Features/Inventory/init.server.luau', ['ServerScriptService', 'Server', 'Features', 'Inventory'], 'Script', 'Entry points', 'server', 'Inventory')
    ]
  },
  { category: 'Other', scripts: [] }
]

type Origin = NonNullable<TreeNode['origin']>
const n = (name: string, className: string, children: TreeNode[] = [], filePath?: string, origin: Origin = 'both'): TreeNode => ({ name, className, children, filePath, origin })
// Studio-only instance (from the live Studio snapshot, no file in the repo).
const st = (name: string, className: string, children: TreeNode[] = []): TreeNode => n(name, className, children, undefined, 'studio')

const tree: TreeNode[] = [
  n('Workspace', 'Workspace', [
    st('Camera', 'Camera'),
    st('Baseplate', 'Part'),
    st('Map', 'Model', [
      st('Spawn', 'SpawnLocation'),
      st('ShopStall', 'Model', [st('Counter', 'MeshPart'), st('Sign', 'Part', [st('Logo', 'Decal')]), st('ShopPrompt', 'ProximityPrompt')]),
      st('Trees', 'Folder', [st('Oak', 'Model'), st('Pine', 'Model'), st('Birch', 'Model')]),
      st('Ambience', 'Sound')
    ])
  ]),
  n('Lighting', 'Lighting', [st('Atmosphere', 'Atmosphere'), st('Sky', 'Sky')], undefined, 'studio'),
  n('ReplicatedStorage', 'ReplicatedStorage', [
    st('Assets', 'Folder', [
      st('Starter Sword', 'Tool', [st('Handle', 'MeshPart'), st('SwingAnim', 'Animation')]),
      st('Coin', 'Model', [st('Mesh', 'MeshPart'), st('Shine', 'Texture')]),
      st('Sounds', 'Folder', [st('Purchase', 'Sound'), st('CoinPickup', 'Sound'), st('Error', 'Sound')])
    ]),
    n('Shared', 'Folder', [
      n('Features', 'Folder', [n('Inventory', 'ModuleScript', [], 'src/shared/Features/Inventory/init.luau')]),
      n('Interface', 'Folder', [
        n('App', 'Folder', [n('app', 'ModuleScript', [], 'src/shared/Interface/App/app.luau')]),
        n('MountUI', 'ModuleScript', [], 'src/shared/Interface/MountUI.luau')
      ]),
      n('Modules', 'Folder', [n('ModuleLoader', 'ModuleScript', [], 'src/shared/Modules/ModuleLoader.luau'), n('Utils', 'Folder', [], undefined, 'repo')]),
      n('events', 'Folder', [
        n('client', 'ModuleScript', [], 'src/shared/events/client.luau'),
        n('server', 'ModuleScript', [], 'src/shared/events/server.luau')
      ])
    ]),
    n('Packages', 'Folder', [n('Janitor', 'ModuleScript'), n('Vide', 'ModuleScript')])
  ]),
  n('ServerScriptService', 'ServerScriptService', [
    n('Server', 'Folder', [
      n('Data', 'Folder', [n('PlayerData', 'ModuleScript', [], 'src/server/Data/PlayerData.luau')]),
      n('Features', 'Folder', [
        n('Inventory', 'Script', [n('InventoryService', 'ModuleScript', [], 'src/server/Features/Inventory/InventoryService.luau')], 'src/server/Features/Inventory/init.server.luau')
      ]),
      n('Handlers', 'Folder', [], undefined, 'repo')
    ])
  ]),
  n('ServerStorage', 'ServerStorage', [st('BossModels', 'Folder', [st('Golem', 'Model')])]),
  n('StarterGui', 'StarterGui', [
    st('ShopGui', 'ScreenGui', [st('Frame', 'Frame', [st('Title', 'TextLabel'), st('Icon', 'ImageLabel'), st('BuyButton', 'TextButton')])])
  ], undefined, 'studio'),
  n('StarterPlayer', 'StarterPlayer', [
    n('StarterPlayerScripts', 'StarterPlayerScripts', [
      n('Client', 'LocalScript', [
        n('Controllers', 'Folder', [n('InventoryController', 'ModuleScript', [], 'src/client/Client/Controllers/InventoryController/init.luau')])
      ], 'src/client/Client/init.client.luau')
    ])
  ]),
  n('SoundService', 'SoundService', [st('Music', 'SoundGroup', [st('Theme', 'Sound')])], undefined, 'studio')
]

// ---------------------------------------------------------------- services & logs

const services: ServiceStatus[] = [
  { id: 'dev', label: 'Dev watcher', state: 'running', pid: 48211, restarts: 0, detail: 'watching src/shared/Features · blink · sourcemap' },
  { id: 'rojo', label: 'Rojo', state: 'crashed', restarts: 2, detail: 'exited with code 1: port 34872 already in use' },
  { id: 'lsp', label: 'Luau LSP', state: 'running', pid: 48230, restarts: 0, detail: 'luau-lsp 1.38 · 14 files indexed' },
  { id: 'studioSync', label: 'Studio Sync', state: 'running', pid: 48244, restarts: 0, detail: 'Studio connected · place 123456789' }
]

const logs: LogLine[] = []
function log(service: LogLine['service'], text: string, stream: LogLine['stream'] = 'stdout'): void {
  const line: LogLine = { service, stream, text, at: now() }
  logs.push(line)
  if (logs.length > 3000) logs.shift()
  emit('log:line', line)
}

const seedLogs: [LogLine['service'], string, LogLine['stream']?][] = [
  ['harness', 'Opened project /Users/dev/Games/GenTree', 'info'],
  ['dev', '[watch] watching src/shared/Features'],
  ['dev', '[blink] compiled events.blink -> src/shared/events (2 files)'],
  ['dev', '[sourcemap] wrote sourcemap.json (31 instances)'],
  ['dev', '[wally] packages up to date'],
  ['rojo', 'Rojo server listening:'],
  ['rojo', 'error: Address already in use (os error 98) on 127.0.0.1:34872', 'stderr'],
  ['rojo', 'process exited with code 1', 'stderr'],
  ['lsp', 'luau-lsp: loaded definitions for Roblox (v712)'],
  ['lsp', 'luau-lsp: indexed 14 files'],
  ['studioSync', 'listening on 127.0.0.1:34873'],
  ['studioSync', 'Studio connected (place 123456789)'],
  ['studioSync', 'conflict: src/server/Features/Inventory/InventoryService.luau changed in both places; held in .studio-sync/conflicts', 'stderr'],
  ['git', 'fetch origin: 2 new commits on main']
]
for (const [s, t, st] of seedLogs) logs.push({ service: s, text: t, stream: st ?? 'stdout', at: now() - 60000 + logs.length * 1000 })

// ---------------------------------------------------------------- git & studio

let git: GitStatus = { isRepo: true, hasRemote: true, branch: 'main', ahead: 0, behind: 2, dirty: 1, lastSync: now() - 7 * 60000, conflicts: [] }
let settings: SyncSettings = { autoSyncMinutes: 5, autoCommit: true }

let studioConflicts: StudioConflict[] = [
  {
    path: 'src/server/Features/Inventory/InventoryService.luau',
    repoSource: files['src/server/Features/Inventory/InventoryService.luau'],
    studioSource: files['src/server/Features/Inventory/InventoryService.luau']
      .replace('InventoryService.Inventories = {} :: { [Player]: Inventory.Inventory }', 'InventoryService.Inventories = {} :: { [Player]: Inventory.Inventory }\nInventoryService.MAX_GIFT = 10 -- added in Studio by alex')
      .replace(
        'function InventoryService:Give(player: Player, item: Inventory.Item): boolean\n\tlocal inv = self.Inventories[player]',
        'function InventoryService:Give(player: Player, item: Inventory.Item): boolean\n\tif item.stack > self.MAX_GIFT then\n\t\twarn("gift too large", item.id)\n\t\treturn false\n\tend\n\tlocal inv = self.Inventories[player]'
      )
  }
]

// ---------------------------------------------------------------- chat

const chats: ChatSession[] = [
  { id: 'chat-3', title: 'Shop purchase flow bug', createdAt: now() - 3600_000 * 5 },
  { id: 'chat-2', title: 'Set up PlayerData saving', createdAt: now() - 3600_000 * 26 },
  { id: 'chat-1', title: 'Explain ModuleLoader', createdAt: now() - 3600_000 * 72 }
]
const chatMessages: Record<string, ChatMessage[]> = {
  'chat-1': [
    { id: 'm1', role: 'user', text: 'How does ModuleLoader decide what to start?', at: now() - 3600_000 * 72, agentId: 'main' },
    { id: 'm2', role: 'tool', text: '', tool: { name: 'read_script', input: 'src/shared/Modules/ModuleLoader.luau' }, at: now() - 3600_000 * 72, agentId: 'main' },
    { id: 'm3', role: 'assistant', text: 'It requires every `ModuleScript` under the folder you pass, then calls `Init(janitor)` on each in order, and finally `Start()` on each in its own thread.', at: now() - 3600_000 * 72, agentId: 'main' }
  ],
  'chat-2': [],
  'chat-3': []
}
const running = new Set<string>()

function chatReply(text: string): { tools: [string, string][]; answer: string } {
  const t = text.toLowerCase()
  if (t.includes('sync')) {
    return {
      tools: [['git_status', ''], ['git_sync', 'pull --rebase origin main']],
      answer:
        "You were **2 commits behind** `origin/main`. I pulled them in and you're now in sync.\n\nOne thing needs your call: a collaborator edited `InventoryService.luau` in Studio while you changed it here. I held the Studio version instead of overwriting yours — open **Sync** in the status bar to compare them side by side.\n\n- `a41c9e2` Add ShopService stub — *maya*\n- `7d03b18` Tune PlayerData defaults — *alex*"
    }
  }
  if (t.includes('feature') || t.includes('inventory')) {
    return {
      tools: [['list_scripts', 'Features'], ['create_folder', 'src/shared/Features/Inventory'], ['read_script', 'src/server/Features/Inventory/InventoryService.luau']],
      answer:
        "Done. I created `src/shared/Features/Inventory`, and the dev watcher generated the matching server feature and client controller:\n\n- `src/server/Features/Inventory/InventoryService.luau`\n- `src/client/Client/Controllers/InventoryController/init.luau`\n\nThe shared module defines the item types:\n\n```luau\nexport type Item = {\n\tid: ItemId,\n\tname: string,\n\tstack: number,\n}\n```\n\nNext I'd wire `InventoryService:Give` to an event so the client can react. Want me to do that?"
    }
  }
  if (t.includes('agent') || t.includes('test')) {
    return {
      tools: [['run_test_agents', '3 scenarios: shop flow']],
      answer: "I started **3 test agents** on the shop flow. They play the game headless and report back — follow them in the **Agents** panel. I'll summarize when they finish."
    }
  }
  return {
    tools: [['read_script', 'src/client/Client/init.client.luau'], ['read_script', 'src/shared/Modules/ModuleLoader.luau']],
    answer:
      'Your services start in two phases, driven by `ModuleLoader.InitFolder`:\n\n1. **Init** — every `ModuleScript` in the folder is required, then `Init(janitor)` runs on each one, synchronously. Use it to connect events and set up state.\n2. **Start** — once all modules are initialised, `Start()` runs on each in its own thread via `task.spawn`, so one slow service never blocks the others.\n\nOn the client, `init.client.luau` calls `InitFolder(script.Controllers)` and then mounts the UI with `MountUI()`. On the server each feature folder has an `init.server.luau` that boots its own modules.'
  }
}

async function streamReply(sessionId: string, text: string): Promise<void> {
  running.add(sessionId)
  emit('chat:busy', { sessionId, busy: true })
  const { tools, answer } = chatReply(text)
  await delay(600)
  for (const [name, input] of tools) {
    if (!running.has(sessionId)) return
    const msg: ChatMessage = { id: uid('t'), role: 'tool', text: '', tool: { name, input }, at: now(), agentId: 'main', sessionId }
    chatMessages[sessionId].push(msg)
    emit('chat:message', msg)
    log('agent', `tool ${name} ${input}`, 'info')
    await delay(450)
  }
  const id = uid('a')
  const words = answer.split(/(?<=\s)/)
  let acc = ''
  for (let i = 0; i < words.length; i++) {
    if (!running.has(sessionId)) break
    acc += words[i]
    if (i % 3 === 0 || i === words.length - 1) {
      const msg: ChatMessage = { id, role: 'assistant', text: acc, at: now(), agentId: 'main', sessionId }
      emit('chat:message', msg)
      await delay(28)
    }
  }
  chatMessages[sessionId].push({ id, role: 'assistant', text: acc, at: now(), agentId: 'main', sessionId })
  if (/agent|test/i.test(text)) {
    agentReportSession = sessionId
    void api.runAgents(['Buy the starter sword with exactly 100 coins', 'Try to buy with 0 coins and confirm the error toast', 'Spam the buy button 20 times quickly'])
  }
  if (/sync/i.test(text)) {
    git = { ...git, behind: 0, dirty: 0, lastSync: now() }
    emit('git:status', git)
  }
  running.delete(sessionId)
  emit('chat:busy', { sessionId, busy: false })
}

// ---------------------------------------------------------------- agents

let agents: TestAgent[] = [
  { id: 'agent-old', scenario: 'Join, open the inventory and close it', state: 'passed', summary: 'Inventory opened in 0.4s and closed cleanly. No errors in output.', startedAt: now() - 3600_000, finishedAt: now() - 3540_000 }
]

function setAgent(id: string, patch: Partial<TestAgent>): void {
  agents = agents.map((a) => (a.id === id ? { ...a, ...patch } : a))
  emit('agents:changed', agents)
}

// Chat that asked for the current agent run; agents post their final report there too.
let agentReportSession: string | null = null
const agentTranscripts: Record<string, ChatMessage[]> = {}

function agentSay(agentId: string, role: ChatMessage['role'], text: string, tool?: ChatMessage['tool']): void {
  const m: ChatMessage = { id: uid('g'), role, text, tool, at: now(), agentId }
  ;(agentTranscripts[agentId] ??= []).push(m)
  emit('chat:message', m)
}

function agentReport(agentId: string, text: string): void {
  agentSay(agentId, 'assistant', text)
  const sid = agentReportSession
  if (!sid) return
  const m: ChatMessage = { id: uid('r'), role: 'assistant', text, at: now(), agentId, sessionId: sid }
  ;(chatMessages[sid] ??= []).push(m)
  emit('chat:message', m)
}

function runAgent(a: TestAgent, index: number): void {
  const fail = /spam/i.test(a.scenario)
  setTimeout(() => {
    if (a.state === 'cancelled') return
    setAgent(a.id, { state: 'running', startedAt: now() })
    agentSay(a.id, 'system', `Starting: ${a.scenario}`)
    log('agent', `[${a.id}] running: ${a.scenario}`, 'info')
  }, 900 + index * 700)
  setTimeout(() => agentSay(a.id, 'tool', '', { name: 'studio_run', input: 'play solo, spawn player' }), 1800 + index * 700)
  setTimeout(() => agentSay(a.id, 'tool', '', { name: 'fire_event', input: 'ShopPurchase { item = "StarterSword" }' }), 2900 + index * 700)
  setTimeout(() => {
    const cur = agents.find((x) => x.id === a.id)
    if (!cur || cur.state !== 'running') return
    if (index === 0 && !fail) return // first one keeps running for the screenshot
    const summary = fail
      ? 'Purchased 3 swords for 100 coins: the buy handler has no debounce, coins went negative (-200).'
      : 'Purchase rejected with "Not enough coins" toast. Coins unchanged.'
    setAgent(a.id, { state: fail ? 'failed' : 'passed', summary, finishedAt: now() })
    agentReport(a.id, summary)
  }, 5200 + index * 1400)
  setTimeout(() => {
    const cur = agents.find((x) => x.id === a.id)
    if (!cur || cur.state !== 'running') return
    setAgent(a.id, { state: 'passed', summary: 'Bought the starter sword; coins 100 → 0 and the item shows in the inventory.', finishedAt: now() })
  }, 14000)
}

// ---------------------------------------------------------------- api

let apiKey = false

const api: HarnessApi = {
  async openProject() {
    await delay(150)
    emit('project:changed', project)
    return project
  },
  async getProject() {
    return project
  },
  async getTree() {
    return tree
  },
  async getScripts() {
    return scriptGroups
  },
  async readFile(path) {
    await delay(60)
    return files[path] ?? `-- ${path}\n`
  },
  async writeFile(path, contents) {
    files[path] = contents
    log('harness', `saved ${path}`, 'info')
  },

  async getServices() {
    return services
  },
  async startService(id) {
    await transition(id, 'starting', 'running')
  },
  async stopService(id) {
    patchService(id, { state: 'stopped', pid: undefined, detail: 'stopped' })
    log(id, 'stopped', 'info')
  },
  async restartService(id) {
    await transition(id, 'starting', 'running')
  },
  async getLogs(service) {
    return service ? logs.filter((l) => l.service === service) : logs.slice()
  },

  async getGitStatus() {
    return git
  },
  async syncNow() {
    log('git', 'git pull --rebase origin main', 'info')
    await delay(900)
    git = { ...git, behind: 0, ahead: 0, dirty: 0, lastSync: now() }
    log('git', 'Fast-forwarded main to a41c9e2')
    emit('git:status', git)
    return git
  },
  async initGit(remoteUrl) {
    git = { isRepo: true, hasRemote: !!remoteUrl, branch: 'main', ahead: 0, behind: 0, dirty: 0, conflicts: [] }
    emit('git:status', git)
    return git
  },
  async getSyncSettings() {
    return settings
  },
  async setSyncSettings(s) {
    settings = s
  },
  async getStudioConflicts() {
    return studioConflicts
  },
  async resolveStudioConflict(path, take) {
    const c = studioConflicts.find((x) => x.path === path)
    if (c && take === 'studio') files[path] = c.studioSource
    studioConflicts = studioConflicts.filter((x) => x.path !== path)
    log('studioSync', `resolved ${path}: kept ${take} version`, 'info')
    emit('studio:conflicts', studioConflicts)
  },

  async listChats() {
    return chats
  },
  async newChat() {
    const c: ChatSession = { id: uid('chat'), title: 'New chat', createdAt: now() }
    chats.unshift(c)
    chatMessages[c.id] = []
    return c
  },
  async getChat(sessionId) {
    return chatMessages[sessionId] ?? agentTranscripts[sessionId] ?? []
  },
  async sendChat(sessionId, text) {
    chatMessages[sessionId] ??= []
    chatMessages[sessionId].push({ id: uid('u'), role: 'user', text, at: now(), agentId: 'main', sessionId })
    const c = chats.find((x) => x.id === sessionId)
    if (c && c.title === 'New chat') c.title = text.length > 42 ? text.slice(0, 40) + '…' : text
    void streamReply(sessionId, text)
  },
  async stopChat(sessionId) {
    running.delete(sessionId)
    emit('chat:busy', { sessionId, busy: false })
  },
  async hasApiKey() {
    return apiKey
  },
  async setApiKey(key) {
    apiKey = key.trim().length > 0
  },

  async getAgents() {
    return agents
  },
  async runAgents(scenarios) {
    const created = scenarios.map<TestAgent>((s) => ({ id: uid('agent'), scenario: s, state: 'queued' }))
    agents = [...created, ...agents]
    emit('agents:changed', agents)
    created.forEach(runAgent)
    return created
  },
  async cancelAgent(id) {
    setAgent(id, { state: 'cancelled', finishedAt: now(), summary: 'Cancelled by you.' })
  },

  // No luau-lsp in the browser preview; the LSP client stays idle.
  lspStart: async () => false,
  lspSend: () => {},

  on(event, handler) {
    let set = listeners.get(event)
    if (!set) listeners.set(event, (set = new Set()))
    set.add(handler as Handler)
    return () => set!.delete(handler as Handler)
  }
}

function patchService(id: ServiceId, patch: Partial<ServiceStatus>): void {
  const i = services.findIndex((s) => s.id === id)
  services[i] = { ...services[i], ...patch }
  emit('services:status', services.slice())
}

async function transition(id: ServiceId, mid: 'starting', end: 'running'): Promise<void> {
  patchService(id, { state: mid, detail: 'starting…' })
  log(id, 'starting…', 'info')
  await delay(1200)
  const detail = id === 'rojo' ? 'rojo serve on :34873' : services.find((s) => s.id === id)?.detail
  patchService(id, { state: end, pid: 40000 + Math.floor(Math.random() * 9999), detail: detail === 'starting…' ? 'running' : detail })
  log(id, id === 'rojo' ? 'Rojo server listening: Address: localhost Port: 34873' : 'running', 'stdout')
}

// Background chatter so the logs drawer feels alive.
setInterval(() => {
  const lines = ['[sourcemap] wrote sourcemap.json (31 instances)', '[watch] no changes', '[blink] up to date']
  log('dev', lines[Math.floor(Math.random() * lines.length)])
}, 9000)

window.harness = api
