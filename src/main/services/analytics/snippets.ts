// Luau snippets that add AnalyticsService instrumentation the GenTree way: a server feature
// (src/server/Features/<Name>/<Name>Service.luau with :Init/:Start, started from init.server.luau) plus a
// shared config module (src/shared/Features/<Name>/init.luau) that lists every event name, so the
// 100-custom-event cap and funnel names stay reviewable in one place.
//
// API facts used (create.roblox.com/docs/reference/engine/classes/AnalyticsService and
// /docs/production/analytics/{custom-events,funnel-events,economy-events,custom-fields}):
//  - Server only, published games only (nothing is recorded from the client or Studio).
//  - LogCustomEvent(player, eventName, value = 1, customFields?)            up to 100 custom event names
//  - LogOnboardingFunnelStepEvent(player, step, stepName, customFields?)     one-time funnel
//  - LogFunnelStepEvent(player, funnelName, funnelSessionId, step, stepName, customFields?)  recurring
//      (use HttpService:GenerateGUID() per shop visit; only the 10 most recent session ids per user count)
//  - LogEconomyEvent(player, flowType, currencyType, amount, endingBalance, transactionType, itemSku?, customFields?)
//      Enum.AnalyticsEconomyFlowType.Source | Sink; transaction types IAP, TimedReward, Onboarding, Shop,
//      Gameplay, ContextualPurchase (pass Enum.AnalyticsEconomyTransactionType.X.Name) or your own.
//  - LogProgressionStartEvent / LogProgressionCompleteEvent / LogProgressionFailEvent(player, path, level, levelName, customFields?)
//  - customFields keys: Enum.AnalyticsCustomFieldKeys.CustomField01/02/03 .Name, string values,
//      at most 8,000 unique combinations across the three.
//  - Charts aggregate daily (up to 24 h to appear). The Analytics Query API then exposes them as
//      CustomEvent*, Funnel*, Economy* metrics (dimension CustomEventName / FunnelName / CurrencyType).

export type SnippetKind = 'setup' | 'custom' | 'onboarding' | 'funnel' | 'economy' | 'progression'

export interface SnippetOptions {
  feature?: string // GenTree feature name for the wrapper (default "Telemetry")
  eventName?: string
  value?: number | string // Luau expression for custom event value
  funnelName?: string
  steps?: string[]
  currency?: string
  flow?: 'Source' | 'Sink'
  transactionType?: string
  itemSku?: string
  progressionPath?: string
  // Where the call goes (purely descriptive in the notes), e.g. "ShopService.Purchase".
  callSite?: string
}

export interface Snippet {
  kind: SnippetKind
  // Files to create (setup) or the file/area the call belongs in.
  files: { path: string; code: string }[]
  // Lines to paste at the call site.
  call?: string
  notes: string[]
}

const IDENT = /^[A-Za-z][A-Za-z0-9_]{0,49}$/

function ident(name: string | undefined, fallback: string): string {
  const n = (name ?? '').trim()
  return IDENT.test(n) ? n : fallback
}

function luaString(s: string): string {
  return JSON.stringify(s)
}

export function setupFiles(featureName = 'Telemetry'): { path: string; code: string }[] {
  const f = ident(featureName, 'Telemetry')
  const service = `${f}Service`
  return [
    {
      path: `src/shared/Features/${f}/init.luau`,
      code: `-- Every analytics name in one place (Roblox allows up to 100 custom event names; keep funnel
-- and currency names stable, renaming starts a new chart).
return {
\tEvents = {
\t\t-- RoundStarted = "RoundStarted",
\t},
\tFunnels = {
\t\t-- Shop = "Shop",
\t},
\tCurrencies = {
\t\t-- Coins = "Coins",
\t},
}
`
    },
    {
      path: `src/server/Features/${f}/${service}.luau`,
      code: `local AnalyticsService = game:GetService("AnalyticsService")
local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Config = require(ReplicatedStorage.Shared.Features.${f})

-- Thin wrapper over AnalyticsService: server only, never throws into gameplay code, and skips
-- Studio (Roblox records nothing there anyway).
local ${service} = {}

local Fields = Enum.AnalyticsCustomFieldKeys

local function fields(a: string?, b: string?, c: string?)
\tif not (a or b or c) then
\t\treturn nil
\tend
\treturn {
\t\t[Fields.CustomField01.Name] = a,
\t\t[Fields.CustomField02.Name] = b,
\t\t[Fields.CustomField03.Name] = c,
\t}
end

local function safe(fn, ...)
\tif RunService:IsStudio() then
\t\treturn
\tend
\tlocal ok, err = pcall(fn, AnalyticsService, ...)
\tif not ok then
\t\twarn("[${service}]", err)
\tend
end

function ${service}:Init()
\tself.FunnelSessions = {}
end

function ${service}:Start() end

function ${service}.Event(player: Player, name: string, value: number?, a: string?, b: string?, c: string?)
\tsafe(AnalyticsService.LogCustomEvent, player, name, value or 1, fields(a, b, c))
end

function ${service}.Onboarding(player: Player, step: number, stepName: string)
\tsafe(AnalyticsService.LogOnboardingFunnelStepEvent, player, step, stepName)
end

-- Recurring funnels (shop visits): one GUID per visit, reused for every step of that visit.
function ${service}.BeginFunnel(player: Player, funnel: string): string
\tlocal id = HttpService:GenerateGUID(false)
\t${service}.FunnelSessions[player] = ${service}.FunnelSessions[player] or {}
\t${service}.FunnelSessions[player][funnel] = id
\treturn id
end

function ${service}.FunnelStep(player: Player, funnel: string, step: number, stepName: string)
\tlocal sessions = ${service}.FunnelSessions[player]
\tlocal id = sessions and sessions[funnel] or ${service}.BeginFunnel(player, funnel)
\tsafe(AnalyticsService.LogFunnelStepEvent, player, funnel, id, step, stepName)
end

function ${service}.Earn(player: Player, currency: string, amount: number, balance: number, transactionType: string, sku: string?)
\tsafe(AnalyticsService.LogEconomyEvent, player, Enum.AnalyticsEconomyFlowType.Source, currency, amount, balance, transactionType, sku)
end

function ${service}.Spend(player: Player, currency: string, amount: number, balance: number, transactionType: string, sku: string?)
\tsafe(AnalyticsService.LogEconomyEvent, player, Enum.AnalyticsEconomyFlowType.Sink, currency, amount, balance, transactionType, sku)
end

function ${service}.Clear(player: Player)
\t${service}.FunnelSessions[player] = nil
end

${service}.Config = Config

return ${service}
`
    },
    {
      path: `src/server/Features/${f}/init.server.luau`,
      code: `local Players = game:GetService("Players")
local ${service} = require(script.${service})

${service}:Init()
${service}:Start()
Players.PlayerRemoving:Connect(function(player)
\t${service}.Clear(player)
end)
`
    }
  ]
}

export function analyticsSnippet(kind: SnippetKind, o: SnippetOptions = {}): Snippet {
  const f = ident(o.feature, 'Telemetry')
  const service = `${f}Service`
  const req = `local ${service} = require(ServerScriptService.Server.Features.${f}.${service})`
  const header = `local ServerScriptService = game:GetService("ServerScriptService")\n${req}\n`
  const where = o.callSite ? `Put the call in ${o.callSite}.` : 'Put the call in the server Service where the action is confirmed (not in a client Controller).'
  switch (kind) {
    case 'setup':
      return {
        kind,
        files: setupFiles(f),
        notes: [
          `Creates the ${f} feature. Other server features require ${service} and call its helpers.`,
          'Nothing is recorded from Studio or the client; test in a published place and expect charts within 24 h.'
        ]
      }
    case 'custom': {
      const name = ident(o.eventName, 'CoreLoopAction')
      return {
        kind,
        files: [],
        call: `${header}\n${service}.Event(player, ${luaString(name)}, ${o.value ?? 1}, --[[CustomField01]] nil)`,
        notes: [
          where,
          `Add ${name} to Events in src/shared/Features/${f}/init.luau. Prefer one event + custom fields over many names (cap: 100 names, 8,000 field combinations).`,
          `Read it back with analytics_series metric=CustomEventCount breakdown=CustomEventName (or filter CustomEventName=${name}).`
        ]
      }
    }
    case 'onboarding': {
      const steps = o.steps?.length ? o.steps : ['Spawned', 'Tutorial started', 'First action', 'First reward']
      return {
        kind,
        files: [],
        call: `${header}\n` + steps.map((s, i) => `${service}.Onboarding(player, ${i + 1}, ${luaString(s)})`).join('\n'),
        notes: [
          where,
          'Each line goes where that step actually happens; step numbers must stay stable. A one-time funnel: log each step once per player.',
          'Read it back with analytics_series metric=FunnelStepCompletionRate granularity=total breakdown=FunnelStep. Low D1 retention usually shows up as a big drop between two onboarding steps.'
        ]
      }
    }
    case 'funnel': {
      const funnel = ident(o.funnelName, 'Shop')
      const steps = o.steps?.length ? o.steps : ['Opened shop', 'Viewed item', 'Started purchase', 'Purchased']
      return {
        kind,
        files: [],
        call: `${header}\n${service}.BeginFunnel(player, ${luaString(funnel)}) -- when the shop opens\n` + steps.map((s, i) => `${service}.FunnelStep(player, ${luaString(funnel)}, ${i + 1}, ${luaString(s)})`).join('\n'),
        notes: [
          where,
          'Call BeginFunnel once per visit (a new GUID each time); the final step belongs in ProcessReceipt / PromptGamePassPurchaseFinished after the purchase is granted.',
          `Read it back with analytics_series metric=FunnelStepCompletionRate granularity=total filter FunnelName=${funnel} breakdown=FunnelStep. Pair it with PayingUsersCVR.`
        ]
      }
    }
    case 'economy': {
      const currency = o.currency ?? 'Coins'
      const flow = o.flow ?? 'Source'
      const tt = o.transactionType ?? (flow === 'Source' ? 'Gameplay' : 'Shop')
      const builtIn = ['IAP', 'TimedReward', 'Onboarding', 'Shop', 'Gameplay', 'ContextualPurchase'].includes(tt)
      const ttExpr = builtIn ? `Enum.AnalyticsEconomyTransactionType.${tt}.Name` : luaString(tt)
      const fn = flow === 'Source' ? 'Earn' : 'Spend'
      return {
        kind,
        files: [],
        call: `${header}\n-- after the balance change is saved:\n${service}.${fn}(player, ${luaString(currency)}, amount, newBalance, ${ttExpr}${o.itemSku ? `, ${luaString(o.itemSku)}` : ''})`,
        notes: [
          where,
          'Log after the change is applied, with the ending balance. Up to five currencies show on the Economy dashboard.',
          'Read it back with analytics_series metric=EconomyTransactionAmount breakdown=FlowType (or TransactionType / ItemSku).'
        ]
      }
    }
    case 'progression': {
      const path = o.progressionPath ?? 'Levels'
      return {
        kind,
        files: [],
        call: `local AnalyticsService = game:GetService("AnalyticsService")\nAnalyticsService:LogProgressionStartEvent(player, ${luaString(path)}, level, levelName)\n-- on success / failure:\nAnalyticsService:LogProgressionCompleteEvent(player, ${luaString(path)}, level, levelName)\nAnalyticsService:LogProgressionFailEvent(player, ${luaString(path)}, level, levelName)`,
        notes: [where, 'Wrap in pcall (or add a helper to the Telemetry service) like the other calls.']
      }
    }
  }
}

// Which instrumentation answers which question; used in tool descriptions and reports.
export const INSTRUMENTATION_HINTS: { when: string; kind: SnippetKind; why: string }[] = [
  { when: 'D1 retention low or falling', kind: 'onboarding', why: 'shows the exact first-session step where new players leave' },
  { when: 'payer conversion low / ARPPU flat', kind: 'funnel', why: 'shop funnel shows whether players never open the shop, browse and leave, or fail at purchase' },
  { when: 'sessions short / playtime per DAU falling', kind: 'custom', why: 'core-loop events show which loop players stop repeating' },
  { when: 'currency inflation or nothing worth buying', kind: 'economy', why: 'sources vs sinks per currency show balance drift' },
  { when: 'players stall at a level/area', kind: 'progression', why: 'start/complete/fail per level shows the wall' }
]
