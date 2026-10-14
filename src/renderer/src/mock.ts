// Browser-preview mock of the HarnessApi. main.tsx installs it only when the
// preload bridge is missing (plain Vite dev server, screenshots, design work).
import type {
  AppSettings,
  ChatMessage,
  ChatSession,
  GitStatus,
  HarnessApi,
  HarnessEvents,
  LogLine,
  PlaceInfo,
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
import { packagesMock } from './mockPackages'
import { integrationsMock } from './mockIntegrations'
import { terminalMock } from './mockTerminal'
import { setupMock } from './mockSetup'
import { memoryMock } from './mockMemory'
import { artMock } from './mockArt'
import { updatesMock } from './mockUpdates'
import { brainSyncMock } from './mockBrainSync'
import { uiPreviewMock, uiPreviewMockSources } from './mockUiPreview'
import { vfxMock } from './mockVfx'
import { vfxTexturesMock } from './mockVfxTextures'
import { animMock } from './mockAnim'
import { refMock } from './mockRef'
import { abilityMock } from './mockAbility'
import { uiMotionMock } from './mockUiMotion'
import { studioMock } from './mockStudio'
import { forgeSyncMock } from './mockForgeSync'
import { principlesMock } from './mockPrinciples'
import { gatingMock } from './mockGating'
import { thumbsMock } from './mockThumbs'
import { addToGameMock, doctorMock, spendMock } from './mockQolc'
import { editorAssistMock } from './mockEditorAssist'
import { providersMock } from './mockProviders'
import { groupMock, seedGroupChat } from './mockGroup'
import { chatExtrasMock } from './mockChatExtras'
import { restateMock } from './mockRestate'
import { qolMock } from './mockQol'
import { chatModesMock } from './mockChatModes'
import { seedFishingChat } from './mockFishing'
import { entryTarget, isUnder, parentDir, protectedReason, renamedPath, renameProblem, siblingsOf, type PathChange } from '@shared/fileOps'
import { BLINK_OUTPUTS, eventsBlink, generatedClient, generatedServer, mockBlinkModel } from './mockBlink'

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
local ServerScriptService = game:GetService("ServerScriptService")

local Inventory = require(ReplicatedStorage.Shared.Features.Inventory)
local PlayerData = require(script.Parent.Parent.Parent.Data.PlayerData)
local Events = require(ServerScriptService.Server.events.server)

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

// ---------------------------------------------------------------- blink (Events tab)

// ?blink=error opens the preview with a typo in events.blink (screenshots of the error state).
const blinkError = typeof location !== 'undefined' && new URLSearchParams(location.search).get('blink') === 'error'
files['events.blink'] = blinkError ? eventsBlink.replace('Type: Reliable,\n    Call: SingleAsync,\n    Data: u32', 'Type: Reliabel,\n    Call: SingleAsync,\n    Data: u32') : eventsBlink
files[BLINK_OUTPUTS.client] = generatedClient
files[BLINK_OUTPUTS.server] = generatedServer
let blinkModel = mockBlinkModel(files['events.blink'])

async function recheckBlink(): Promise<void> {
  blinkModel = { ...mockBlinkModel(files['events.blink']), diagnostics: blinkModel.diagnostics, checking: true }
  emit('blink:changed', blinkModel)
  await delay(500)
  blinkModel = mockBlinkModel(files['events.blink'])
  emit('blink:changed', blinkModel)
  const d = blinkModel.diagnostics[0]
  log('dev', d ? `[blink] ${d.file}:${d.line}:${d.column}: ${d.code} ${d.message} (${d.detail})` : `[blink] events.blink OK (${blinkModel.events.length} events/functions)`, d ? 'stderr' : 'info')
}

// ---------------------------------------------------------------- project

const project: ProjectInfo = { root: '/Users/dev/Games/GenTree', name: 'GenTree', placeIds: [123456789], mounts: ['src/shared', 'Packages', 'src/server', 'src/client'] }

// Places: a match place and a menu place (multi-place projects).
const mockPlaces: PlaceInfo[] = [
  { file: 'default.project.json', name: 'GenTree', isDefault: true, servePort: 34872, servePlaceIds: [123456789], sourcemap: 'sourcemap.json' },
  { file: 'menu.project.json', name: 'menu', isDefault: false, servePort: 34875, servePlaceIds: [987654321], sourcemap: '.studio-sync/sourcemap.menu.json' }
]
let mockActivePlace = 'default.project.json'

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
      script('src/server/events/server.luau', ['ServerScriptService', 'Server', 'events', 'server'], 'ModuleScript', 'Events', 'server')
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
  {
    category: 'Handlers',
    scripts: [script('src/server/Handlers/DamageHandler.luau', ['ServerScriptService', 'Server', 'Handlers', 'DamageHandler'], 'ModuleScript', 'Handlers', 'server')]
  },
  {
    category: 'Skills',
    scripts: [script('src/shared/Skills/Dash.luau', ['ReplicatedStorage', 'Shared', 'Skills', 'Dash'], 'ModuleScript', 'Skills', 'shared')]
  },
  {
    category: 'Protocols',
    scripts: [script('src/shared/Protocols/TradeProtocol.luau', ['ReplicatedStorage', 'Shared', 'Protocols', 'TradeProtocol'], 'ModuleScript', 'Protocols', 'shared')]
  },
  {
    category: 'Stories',
    scripts: [script('src/shared/Interface/App/app.story.luau', ['ReplicatedStorage', 'Shared', 'Interface', 'App', 'app.story'], 'ModuleScript', 'Stories', 'shared')]
  },
  {
    category: 'Tests',
    scripts: [script('src/shared/Features/Inventory/Inventory.spec.luau', ['ReplicatedStorage', 'Shared', 'Features', 'Inventory', 'Inventory.spec'], 'ModuleScript', 'Tests', 'shared', 'Inventory')]
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
      n('Features', 'Folder', [n('Inventory', 'ModuleScript', [n('Inventory.spec', 'ModuleScript', [], 'src/shared/Features/Inventory/Inventory.spec.luau')], 'src/shared/Features/Inventory/init.luau')]),
      n('Skills', 'Folder', [n('Dash', 'ModuleScript', [], 'src/shared/Skills/Dash.luau')]),
      n('Protocols', 'Folder', [n('TradeProtocol', 'ModuleScript', [], 'src/shared/Protocols/TradeProtocol.luau')]),
      n('Interface', 'Folder', [
        n('App', 'Folder', [n('app', 'ModuleScript', [], 'src/shared/Interface/App/app.luau'), n('app.story', 'ModuleScript', [], 'src/shared/Interface/App/app.story.luau')]),
        n('MountUI', 'ModuleScript', [], 'src/shared/Interface/MountUI.luau')
      ]),
      n('Modules', 'Folder', [n('ModuleLoader', 'ModuleScript', [], 'src/shared/Modules/ModuleLoader.luau'), n('Utils', 'Folder', [], undefined, 'repo')]),
      n('events', 'Folder', [
        n('client', 'ModuleScript', [], 'src/shared/events/client.luau')
      ])
    ]),
    n('Packages', 'Folder', [n('Janitor', 'ModuleScript'), n('Vide', 'ModuleScript')])
  ]),
  n('ServerScriptService', 'ServerScriptService', [
    n('Server', 'Folder', [
      n('Data', 'Folder', [n('PlayerData', 'ModuleScript', [], 'src/server/Data/PlayerData.luau')]),
      n('events', 'Folder', [n('server', 'ModuleScript', [], 'src/server/events/server.luau')]),
      n('Features', 'Folder', [
        n('Inventory', 'Script', [n('InventoryService', 'ModuleScript', [], 'src/server/Features/Inventory/InventoryService.luau')], 'src/server/Features/Inventory/init.server.luau')
      ]),
      n('Handlers', 'Folder', [n('DamageHandler', 'ModuleScript', [], 'src/server/Handlers/DamageHandler.luau')], undefined, 'repo')
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
  blinkModel.diagnostics[0]
    ? ['dev', `[blink] events.blink:${blinkModel.diagnostics[0].line}:${blinkModel.diagnostics[0].column}: E2003 ${blinkModel.diagnostics[0].message}`, 'stderr']
    : ['dev', `[blink] events.blink OK (${blinkModel.events.length} events/functions)`, 'info'],
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

// UI Preview fixture stories (mockUiPreview.ts).
Object.assign(files, uiPreviewMockSources)
const providers = providersMock(emit)

const chats: ChatSession[] = [
  { id: 'chat-3', title: 'Shop purchase flow bug', createdAt: now() - 3600_000 * 5, provider: 'anthropic', model: 'claude-opus-5-5' },
  { id: 'chat-2', title: 'Set up PlayerData saving', createdAt: now() - 3600_000 * 26, provider: 'openrouter', model: 'openai/gpt-6-astra' },
  { id: 'chat-1', title: 'Explain ModuleLoader', createdAt: now() - 3600_000 * 72, provider: 'anthropic', model: 'claude-sonnet-5-5' }
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

// Group chat (mockGroup.ts): a seeded Claude + Sol + Gemini chat, and canned guest replies.
const groupDeps = {
  emit,
  chats,
  messages: chatMessages,
  models: async () => (await providers.api.listProviders()).flatMap((p) => p.models.map((model) => ({ provider: p.id, model }))),
  readyModels: async () => (await providers.api.listProviders()).filter((p) => p.ready).flatMap((p) => p.models.map((model) => ({ provider: p.id, model })))
}
seedGroupChat(groupDeps)
seedFishingChat(chats, chatMessages)
const group = groupMock(groupDeps)
const extras = chatExtrasMock({ emit, chats, messages: chatMessages, addGuest: (id, c) => group.api.addGuest(id, c) })
// Restate first (mockRestate.ts): big requests get a restatement card before the reply.
const restate = restateMock({ emit, messages: chatMessages, reply: (id, text) => streamReply(id, text), log: (text) => log('agent', text, 'info') })
// Chat modes + slash commands (mockChatModes.ts): plan cards, diff cards, command output.
const chatModes = chatModesMock({ emit, chats, messages: chatMessages, files, reply: (id, text) => streamReply(id, text), log: (text) => log('agent', text, 'info') })

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
  const chat = chats.find((c) => c.id === sessionId)
  if (chat && !providers.ready(chat.provider)) {
    const msg: ChatMessage = { id: uid('s'), role: 'system', text: 'Add an API key for this provider in Settings.', at: now(), agentId: 'main', sessionId }
    chatMessages[sessionId].push(msg)
    emit('chat:message', msg)
    return
  }
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

// Forge Sync (mockForgeSync.ts): FSF-like match/menu places; ?forgesync=blocked|firstrun|clear|checking|project|off.
const forgeSync = forgeSyncMock(emit, (text) => log('studioSync', text, 'info'))
// With an explicit ?forgesync=, the service rows match it (rojo held by the gate, Forge Sync summary).
{
  const fs = new URLSearchParams(location.search).get('forgesync')
  const sync = services.find((s) => s.id === 'studioSync')!
  const rojo = services.find((s) => s.id === 'rojo')!
  if (fs === 'blocked') {
    Object.assign(sync, { label: 'Studio sync', state: 'running', pid: undefined, detail: 'Forge Sync: 1 conflict held' })
    Object.assign(rojo, { state: 'starting', restarts: 0, detail: '1 conflict: resolve or serve anyway (default.project.json)' })
  } else if (fs === 'checking') {
    Object.assign(sync, { label: 'Studio sync', state: 'starting', pid: undefined, detail: 'Forge Sync: checking default' })
    Object.assign(rojo, { state: 'starting', restarts: 0, detail: 'Waiting for Studio sync check (default.project.json)' })
  } else if (fs === 'clear' || fs === 'firstrun') {
    Object.assign(sync, { label: 'Studio sync', state: 'running', pid: undefined, detail: 'Forge Sync: 2 Studio sessions' })
    Object.assign(rojo, { state: 'running', restarts: 0, pid: 48299, detail: 'rojo serve on :34872 + 1 more place' })
  }
}

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
    await delay(40)
    if (files[path] !== undefined) return files[path]
    // Known scripts without sample contents get a placeholder; anything else does not exist.
    if (scriptGroups.some((g) => g.scripts.some((x) => x.path === path)) || Object.values(BLINK_OUTPUTS).includes(path)) return `-- ${path}\n`
    throw new Error(`ENOENT: no such file or directory, open '${path}'`)
  },
  async writeFile(path, contents) {
    const isNew = files[path] === undefined && !scriptGroups.some((g) => g.scripts.some((x) => x.path === path))
    files[path] = contents
    log('harness', `saved ${path}`, 'info')
    if (path === 'events.blink') void recheckBlink()
    if (isNew) addMockFile(path)
  },
  async renamePath(path, name, isDir) {
    await delay(60)
    return mockPathOp(path, isDir, String(name ?? ''))
  },
  async trashPath(path, isDir) {
    await delay(60)
    return mockPathOp(path, isDir, null)
  },
  async getAppSettings() {
    return appSettings
  },
  async setAppSettings(patch) {
    appSettings = { ...appSettings, ...patch }
    log('harness', `settings: ${JSON.stringify(patch)}`, 'info')
    return appSettings
  },
  async getBlink() {
    return blinkModel
  },
  async listPlaces() {
    return mockPlaces
  },
  async getActivePlace() {
    return mockPlaces.find((p) => p.file === mockActivePlace) ?? null
  },
  async setActivePlace(file) {
    const place = mockPlaces.find((p) => p.file === file)
    if (!place) throw new Error(`No ${file}`)
    mockActivePlace = file
    emit('places:changed', { places: mockPlaces, active: file })
    return place
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
    return forgeSync.studioConflicts() ?? studioConflicts
  },
  async resolveStudioConflict(path, take, placeKey) {
    if (forgeSync.resolve(path, take, placeKey)) return
    const c = studioConflicts.find((x) => x.path === path)
    if (c && take === 'studio') files[path] = c.studioSource
    studioConflicts = studioConflicts.filter((x) => x.path !== path)
    log('studioSync', `resolved ${path}: kept ${take} version`, 'info')
    emit('studio:conflicts', studioConflicts)
  },

  async listChats() {
    return chats
  },
  async newChat(choice, options) {
    const c: ChatSession = { id: uid('chat'), title: 'New chat', createdAt: now(), ...(choice ?? providers.defaultModel()) }
    chats.unshift(c)
    chatMessages[c.id] = []
    await extras.applyOptions(c, options)
    return { ...c }
  },
  async getChat(sessionId) {
    return chatMessages[sessionId] ?? agentTranscripts[sessionId] ?? []
  },
  async sendChat(sessionId, text, images) {
    chatMessages[sessionId] ??= []
    const refs = extras.refs(images)
    chatMessages[sessionId].push({ id: uid('u'), role: 'user', text, at: now(), agentId: 'main', sessionId, ...(refs.length ? { images: refs } : {}) })
    const c = chats.find((x) => x.id === sessionId)
    if (c) extras.route(c, text)
    if (c && c.title === 'New chat') c.title = text.length > 42 ? text.slice(0, 40) + '…' : text
    const readOnly = c?.chatMode === 'ask' || c?.chatMode === 'plan'
    const carded = c?.guests?.length ? Promise.resolve(false) : readOnly ? Promise.resolve(false) : restate.intercept(sessionId, text)
    void carded
      .then((x) => x || (!c?.guests?.length && chatModes.intercept(sessionId, text)))
      .then((x) => (x ? undefined : group.handleSend(sessionId, text).then((handled) => (handled ? undefined : streamReply(sessionId, text)))))
  },
  ...group.api,
  ...extras.api,
  ...restate.api,
  ...chatModes.api,
  async stopChat(sessionId) {
    running.delete(sessionId)
    emit('chat:busy', { sessionId, busy: false })
  },
  ...providers.api,
  async setChatModel(sessionId, provider, model) {
    const c = chats.find((x) => x.id === sessionId)
    if (c) Object.assign(c, { provider, model })
  },

  async getAgents() {
    return agents
  },
  async runAgents(scenarios, choice) {
    const pick = choice ?? providers.defaultModel()
    const created = scenarios.map<TestAgent>((s) => ({ id: uid('agent'), scenario: s, state: 'queued', provider: pick.provider, model: pick.model }))
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

  // Wally deps and Rokit tools (mockPackages.ts).
  ...packagesMock(emit, (text) => log('harness', text, 'info')),

  // Collab, release, Lune tests, analytics, usage, orchestrator, feature rename (mockIntegrations.ts).
  ...integrationsMock(emit, (text) => log('harness', text, 'info')),
  ...terminalMock(emit),
  ...setupMock(emit, (text) => log('harness', text, 'info')),
  ...memoryMock(emit),
  // Art concepts (mockArt.ts): placeholder SVG images.
  ...artMock(emit),
  // Self-update (mockUpdates.ts); ?update=ready|downloading|available|private|disabled.
  ...updatesMock(emit, (text) => log('harness', text, 'info')),
  // Memory export/import and device sync (mockBrainSync.ts); ?brainsync=git|folder|auth|syncing.
  ...brainSyncMock(emit),
  // UI Preview (mockUiPreview.ts): Lune recordings of the fixture stories.
  ...uiPreviewMock(emit, (text) => log('harness', text, 'info')),
  // VFX Lab (mockVfx.ts): a small effect library built with the shared VFX code.
  ...vfxTexturesMock(emit),
  // Animation Lab (mockAnim.ts): built-in examples and imported-looking clips from the shared code.
  // Video references (mockRef.ts) layer over both lab mocks.
  ...refMock(emit, vfxMock(emit), animMock(emit)),
  ...abilityMock(emit),
  ...uiMotionMock(emit),
  // Studio check (mockStudio.ts): fake Forge Bridge + SVG Studio frames; ?studio=ready|offline|noplugin|outdated|nocapture.
  ...studioMock(emit),
  // Principle priorities (mockPrinciples.ts): weights learned from a seeded rating log.
  ...principlesMock(emit),
  ...forgeSync.api,
  // Lab gating (mockGating.ts): seeded decisions, cost table and decision models.
  ...gatingMock(emit),
  // Thumbnail Lab (mockThumbs.ts): canvas-drawn references, bases and variations measured with the shared code.
  ...thumbsMock(emit),
  // Quality of life (mockQol.ts): bug report, settings, session file, away digest; ?digest=none.
  ...qolMock(emit, () => logs.slice(), () => project),
  // Forge Doctor, spending cap, Add to game (mockQolc.ts): ?doctor=ok|issues, ?spend=ok|warn|stop.
  ...doctorMock(emit),
  ...spendMock(emit),
  ...editorAssistMock(emit),
  ...addToGameMock(),

  on(event, handler) {
    let set = listeners.get(event)
    if (!set) listeners.set(event, (set = new Set()))
    set.add(handler as Handler)
    return () => set!.delete(handler as Handler)
  }
}

let appSettings: AppSettings = { serveAllPlaces: false, autoRoute: true, confirmFileDelete: true, confirmStudioDelete: true }

// A new file from the create flow shows up in the tree and the scripts list, like the dev watcher's
// sourcemap refresh would do.
function addMockFile(path: string): void {
  const m = /^src\/(shared|server|client)\/(.*)$/.exec(path)
  if (!m || !/\.luau?$/.test(path)) return
  const realm = m[1] as ScriptEntry['realm']
  const base: Record<string, string[]> = { shared: ['ReplicatedStorage', 'Shared'], server: ['ServerScriptService', 'Server'], client: ['StarterPlayer', 'StarterPlayerScripts'] }
  const rest = m[2].split('/')
  const file = rest.pop()!
  const init = /^init(\.(server|client))?\.luau?$/.test(file)
  const name = init ? rest.pop()! : file.replace(/(\.(server|client))?\.luau?$/, '')
  const kind: ScriptEntry['kind'] = /\.server\.luau?$/.test(file) ? 'Script' : /\.client\.luau?$/.test(file) ? 'LocalScript' : 'ModuleScript'
  const instancePath = [...base[realm], ...rest, name]
  let nodes = tree
  for (const seg of instancePath.slice(0, -1)) {
    let next = nodes.find((x) => x.name === seg)
    if (!next) nodes.push((next = n(seg, 'Folder', [], undefined, 'repo')))
    nodes = next.children
  }
  const existing = nodes.find((x) => x.name === name)
  if (existing) {
    existing.filePath = path
    existing.className = kind
  } else nodes.push(n(name, kind, [], path, 'repo'))
  const category: ScriptEntry['category'] = /Service$/.test(name) ? 'Services' : /Controller$/.test(name) ? 'Controllers' : kind === 'ModuleScript' ? 'Modules' : 'Entry points'
  const feature = /Features\/([^/]+)/.exec(path)?.[1] ?? /Controllers\/([^/]+)Controller/.exec(path)?.[1]
  const group = scriptGroups.find((g) => g.category === category)
  group?.scripts.push(script(path, instancePath, kind, category, realm, feature))
  setTimeout(() => {
    emit('tree:changed', JSON.parse(JSON.stringify(tree)))
    emit('scripts:changed', scriptGroups.map((g) => ({ ...g, scripts: g.scripts.slice() })))
    log('dev', `[sourcemap] add ${path}`)
  }, 250)
}

// Explorer rename / delete against the mock tree: every known path under the entry goes (and, for a
// rename, comes back at its new place through addMockFile).
function mockKnownPaths(): string[] {
  return [...new Set([...Object.keys(files), ...scriptGroups.flatMap((g) => g.scripts.map((x) => x.path))])]
}

function removeMockPaths(entry: string): string[] {
  const gone = mockKnownPaths().filter((p) => isUnder(p, entry))
  for (const g of scriptGroups) g.scripts = g.scripts.filter((x) => !isUnder(x.path, entry))
  const prune = (nodes: TreeNode[]): TreeNode[] =>
    nodes.flatMap((node) => {
      if (node.filePath && isUnder(node.filePath, entry)) return []
      const children = prune(node.children)
      if (!node.filePath && node.children.length && !children.length && node.className === 'Folder') return []
      return [{ ...node, children }]
    })
  tree.splice(0, tree.length, ...prune(tree))
  return gone
}

function mockPathOp(path: string, isDir: boolean | undefined, name: string | null): PathChange {
  const target = entryTarget(path, !!isDir)
  const reason = protectedReason(target.path, project.mounts ?? [])
  if (reason) throw new Error(reason)
  const known = mockKnownPaths()
  if (!known.some((p) => isUnder(p, target.path))) throw new Error(`${target.path} no longer exists.`)
  let to: string | null = null
  if (name !== null) {
    const problem = renameProblem(target, name, siblingsOf(parentDir(target.path), known))
    if (problem) throw new Error(problem)
    to = renamedPath(target, name)
  }
  const contents = new Map(Object.entries(files))
  const gone = removeMockPaths(target.path)
  for (const p of gone) {
    const text = contents.get(p)
    delete files[p]
    if (to === null) continue
    const next = to + p.slice(target.path.length)
    files[next] = text ?? `-- ${next}\n`
    addMockFile(next)
  }
  setTimeout(() => {
    emit('tree:changed', JSON.parse(JSON.stringify(tree)))
    emit('scripts:changed', scriptGroups.map((g) => ({ ...g, scripts: g.scripts.slice() })))
  }, 50)
  log('harness', to ? `renamed ${target.path} -> ${to}` : `moved ${target.path} to the trash`, 'info')
  return { from: target.path, to, isDir: target.isDir }
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
