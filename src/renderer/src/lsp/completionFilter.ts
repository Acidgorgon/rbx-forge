// Completion relevance for luau-lsp auto-imports. Pure (no Monaco/Electron), so node tests cover it.
//
// luau-lsp (1.70, RobloxPlatform::handleSuggestImports) adds an auto-import item to EVERY
// completion response for each Roblox service in the definitions (~340) and each ModuleScript in
// the sourcemap, leaving the prefix filtering to the client. In a Wally project that means every
// module inside Packages/_Index, and Monaco's fuzzy matcher then surfaces junk such as
// `ProcessInstancePhysicsService` or `011_preregistering_component (…Packages._Index["…"])` for
// `prin`. Two server knobs help but are not enough on their own:
//   - completion.imports.ignoreGlobs only matches modules that have a file path. Instances that
//     reach the server through the live Studio DataModel ($/plugin/full) have none, so Studio
//     copies of Packages/_Index modules slip through (see lspDataModel.ts, which now prunes them).
//   - completion.imports.includedServices limits which services are auto-imported.
// So the client also drops any auto-import whose require path goes through an `_Index` folder.

// Services offered as auto-imports. Everything else is still reachable through
// game:GetService("…") completion, which luau-lsp serves separately and does not limit.
export const COMMON_SERVICES = [
  'Players',
  'ReplicatedStorage',
  'ReplicatedFirst',
  'ServerStorage',
  'ServerScriptService',
  'StarterGui',
  'StarterPack',
  'StarterPlayer',
  'Workspace',
  'Lighting',
  'SoundService',
  'TweenService',
  'RunService',
  'UserInputService',
  'ContextActionService',
  'GuiService',
  'HapticService',
  'VRService',
  'GamepadService',
  'HttpService',
  'DataStoreService',
  'MemoryStoreService',
  'MessagingService',
  'MarketplaceService',
  'TeleportService',
  'CollectionService',
  'PhysicsService',
  'PathfindingService',
  'Debris',
  'TextService',
  'TextChatService',
  'Chat',
  'BadgeService',
  'GroupService',
  'PolicyService',
  'LocalizationService',
  'SocialService',
  'AssetService',
  'InsertService',
  'ContentProvider',
  'ProximityPromptService',
  'AnalyticsService',
  'Teams',
  'LogService',
  'AvatarEditorService',
  'UserService',
  'VoiceChatService',
  'CaptureService',
  'KeyframeSequenceProvider',
  'ScriptContext',
  'TestService',
  // Plugin development (Forge type-checks at PluginSecurity).
  'Selection',
  'ChangeHistoryService',
  'ScriptEditorService',
  'StudioService',
  'CoreGui'
]

// A `_Index` path segment in an instance path (`Packages._Index["a_b@1"].b`), a string require
// (`@Packages/_Index/…`, `./_Index/…`) or a file path (`Packages\_Index\…`).
const INDEX_SEGMENT = /(?:^|[./\\"'[])_Index(?:$|[./\\"'[\]])/

interface LspItemLike {
  label?: unknown
  detail?: unknown
  labelDetails?: { description?: unknown } | null
  additionalTextEdits?: { newText?: unknown }[] | null
}

function mentionsIndex(value: unknown): boolean {
  return typeof value === 'string' && INDEX_SEGMENT.test(value)
}

// True for an auto-import (it inserts a require through additionalTextEdits) of a module that
// lives inside a Wally/pesde `_Index` folder. Member completions on `Packages._Index.` itself
// carry no additionalTextEdits and are kept.
export function isVendoredAutoImport(item: LspItemLike): boolean {
  const edits = item.additionalTextEdits
  if (!Array.isArray(edits) || !edits.length) return false
  if (mentionsIndex(item.labelDetails?.description) || mentionsIndex(item.detail)) return true
  return edits.some((edit) => typeof edit?.newText === 'string' && /\brequire\s*\(/.test(edit.newText) && mentionsIndex(edit.newText))
}

// Drops vendored auto-imports; returns the same array when nothing was dropped.
export function filterCompletionItems<T extends LspItemLike>(items: T[]): T[] {
  let keep: T[] | null = null
  for (let i = 0; i < items.length; i++) {
    const drop = isVendoredAutoImport(items[i])
    if (drop && !keep) keep = items.slice(0, i)
    else if (!drop && keep) keep.push(items[i])
  }
  return keep ?? items
}
