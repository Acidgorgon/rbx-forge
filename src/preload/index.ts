import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { INVOKE_PREFIX, type HarnessApi, type HarnessEvents } from '@shared/types'

const methods = [
  'openProject', 'getProject', 'getTree', 'getScripts', 'readFile', 'writeFile',
  'getServices', 'startService', 'stopService', 'restartService', 'getLogs',
  'getGitStatus', 'syncNow', 'initGit', 'getSyncSettings', 'setSyncSettings',
  'getStudioConflicts', 'resolveStudioConflict',
  'listChats', 'newChat', 'getChat', 'sendChat', 'stopChat', 'hasApiKey', 'setApiKey',
  'addGuest', 'removeGuest', 'setGuestTools', 'startRoundtable', 'planToChecklist',
  'setChatEffort', 'getDefaultEffort', 'setDefaultEffort', 'addChatImage', 'getChatImage',
  'listProviders', 'setProviderKey', 'setProviderConfig', 'listModels', 'setChatModel',
  'getDefaultModel', 'setDefaultModel', 'getAnthropicUseClaudeLogin', 'setAnthropicUseClaudeLogin',
  'getAgents', 'runAgents', 'cancelAgent',
  'lspStart',
  'getBlink',
  'listPlaces', 'getActivePlace', 'setActivePlace', 'getAppSettings', 'setAppSettings',
  'searchWally', 'wallyPackage', 'listWallyDeps', 'addWallyDep', 'removeWallyDep', 'updateWallyDep',
  'listRokitTools', 'addRokitTool', 'updateRokitTool', 'curatedTools',
  // Collaboration
  'joinProject', 'incomingChanges', 'activityFeed', 'blameFile', 'fileHistory',
  'getForgeConfig', 'setForgeConfig', 'startFeatureBranch', 'openPullRequest', 'listOpenPRs',
  'listClaims', 'claim', 'releaseClaim', 'runLint', 'formatFiles', 'preSyncCheck',
  // Release
  'releasePlan', 'releasePreflight', 'releaseRun', 'releaseMarkStudioPublished', 'releaseHistory',
  'releaseSecretsStatus', 'releaseSetSecret', 'releaseClearSecret', 'releaseGetSettings', 'releaseSetSettings',
  'releaseSetProjectPublish', 'releaseTestNotify', 'releaseChoosePlaceFile',
  // Lune tests
  'testsStatus', 'testsDiscover', 'testsRun', 'testsCancel', 'testsWatch', 'testsCreateSpec', 'testsLast',
  // Analytics
  'analyticsStatus', 'analyticsSetApiKey', 'analyticsClearApiKey', 'analyticsSetExperience', 'analyticsOverview',
  'analyticsSeries', 'analyticsCompare', 'analyticsAcquisition', 'analyticsImportCsv', 'analyticsRemoveImport',
  'analyticsPoller', 'analyticsPollNow', 'analyticsCatalog', 'analyticsSnippet',
  // Usage and budgets
  'getUsage', 'getUsageHistory', 'getBudget', 'setBudget',
  // Orchestrator
  'startOrchestration', 'getOrchestrations', 'getOrchestration', 'getTaskTranscript',
  'cancelOrchestration', 'cancelOrchestrationTask', 'getOrchestrateMode', 'setOrchestrateMode',
  // Feature folders
  'renameFeature',
  // Integrated terminal
  'terminalShells', 'terminalSetDefaultShell', 'terminalList', 'terminalCreate', 'terminalWrite', 'terminalResize',
  'terminalKill', 'terminalRename', 'terminalBuffer', 'terminalTasks', 'terminalRunTask', 'terminalPendingRuns',
  'terminalConfirmRun',
  // Toolchain setup and New project
  'toolchainStatus', 'toolchainSetup', 'toolchainCancel', 'toolchainSkip',
  'newProjectDefaults', 'chooseFolder', 'createProject',
  // Memory and skills
  'memoryList', 'memorySearch', 'memorySave', 'memoryDelete', 'memoryPin', 'memoryPromote', 'memoryFeed',
  'memoryGetSettings', 'memorySetSettings', 'memoryProposals', 'memoryAcceptProposal', 'memoryDismissProposal', 'memoryAnalyzeStyle',
  // Memory export/import (.forgepack) and device sync
  'packCandidates', 'packExport', 'packOpen', 'packImport',
  'brainSyncStatus', 'brainSyncGetSettings', 'brainSyncSetSettings', 'brainSyncNow', 'brainSyncChooseFolder',
  // Art concepts (OpenAI images, Roblox import)
  'artStatus', 'artSetSettings', 'artSetRobloxKey', 'artClearRobloxKey', 'artList', 'artEstimate', 'artGenerate',
  'artThumbnail', 'artDelete', 'artUndoDelete', 'artImportToRoblox', 'artSaveToProject', 'artRegistry', 'artChooseReferences',
  // UI Preview (UI Labs stories)
  'uiPreviewStories', 'uiPreviewOpen', 'uiPreviewClose', 'uiPreviewInput', 'uiPreviewState', 'uiPreviewImages', 'uiPreviewSaveExport',
  // VFX Lab (library, recipes, render / critique / refine)
  'vfxStatus', 'vfxList', 'vfxGet', 'vfxSearch', 'vfxImport', 'vfxChooseImport', 'vfxUpdate', 'vfxDelete', 'vfxRate',
  'vfxLearn', 'vfxRecipes', 'vfxMake', 'vfxRefine', 'vfxCancel', 'vfxCreate', 'vfxFile', 'vfxSaveThumb', 'vfxResolveTexture', 'vfxTestInStudio',
  'vfxRunScript', 'vfxCompose', 'vfxExamples', 'vfxAddExample',
  'vfxTexStatus', 'vfxTexList', 'vfxTexGenerate', 'vfxTexPreview', 'vfxTexUpdate', 'vfxTexRate', 'vfxTexDelete', 'vfxTexUpload', 'vfxTexCheck', 'vfxTexFile',
  // Animation Lab (services/anim) + Labs model tiers
  'animStatus', 'animList', 'animGet', 'animImport', 'animPreviewImport', 'animChooseImport', 'animUpdate', 'animDelete', 'animRate',
  'animLearn', 'animStyle', 'animCoverage', 'animCompose', 'animRunScript', 'animGetRig', 'animSetRig', 'animConvert', 'animRefine', 'animCancel', 'animChecks', 'animExamples',
  'animAddExample', 'animFile', 'animSaveThumb', 'animExport', 'animUpload', 'listAnimClips', 'getAnimPose', 'getLabModels', 'setLabModels',
  // Ability Composer (moves: animation + VFX + shake / screen / hit-stop / movement)
  'abilityStatus', 'abilityList', 'abilityGet', 'abilitySave', 'abilityDelete', 'abilityRate', 'abilityCompose', 'abilityCritique',
  'abilityExport', 'abilityExamples', 'abilityAddExample', 'abilityFile', 'abilitySaveThumb', 'abilityChooseSounds', 'abilitySoundUrl',
  // Studio check (Forge Bridge plugin: play in Roblox Studio, capture the key beats)
  'studioStatus', 'studioInstallPlugin', 'studioOpenPluginsFolder', 'studioSetPrefer', 'studioCheck', 'studioLastCheck', 'studioFile',
  // Video references (VFX Lab + Animation Lab: "make it like this")
  'refSave', 'refList', 'refGet', 'refDescribe', 'refFile', 'refDecodeSource',
  // Principle priorities (learned from Labs ratings)
  'principlesView', 'principlesReset',
  // Forge Sync (Studio -> disk, gates rojo serve)
  'syncStatus', 'syncResolve', 'syncResolveAll', 'syncServeAnyway', 'syncCommitStudioEdits', 'syncDisableLegacyPlugin',
  'forgeSyncSettings', 'setForgeSyncSettings',
  // Self-update (electron-updater)
  'updateGetState', 'updateCheck', 'updateSetSettings', 'updateInstall', 'updateOpenRelease'
] as const satisfies readonly Exclude<keyof HarnessApi, 'on' | 'lspSend'>[]

// Compile-time check: every HarnessApi method is exposed (tsc names any that is missing).
type MissingMethods = Exclude<keyof HarnessApi, (typeof methods)[number] | 'on' | 'lspSend'>
const everyMethodExposed: [MissingMethods] extends [never] ? true : MissingMethods = true
void everyMethodExposed

const api: Record<string, unknown> = {}
for (const name of methods) {
  api[name] = (...args: unknown[]) => ipcRenderer.invoke(INVOKE_PREFIX + name, ...args)
}
// Fire-and-forget: LSP traffic is high-volume and needs no reply from main.
api.lspSend = (message: unknown) => ipcRenderer.send(INVOKE_PREFIX + 'lspSend', message)
api.on = <K extends keyof HarnessEvents>(event: K, handler: (payload: HarnessEvents[K]) => void) => {
  const listener = (_: unknown, payload: HarnessEvents[K]) => handler(payload)
  ipcRenderer.on(event, listener)
  return () => ipcRenderer.removeListener(event, listener)
}

contextBridge.exposeInMainWorld('harness', api as unknown as HarnessApi)

// Absolute path of a file dropped on the window (CSV import drop zone). File.path is gone in
// current Electron; webUtils is the supported way and only works in the preload.
contextBridge.exposeInMainWorld('forgeFiles', {
  pathFor: (file: File) => webUtils.getPathForFile(file),
  // Recolours the Windows/Linux caption buttons when the renderer switches theme.
  setTitlebarTheme: (theme: 'dark' | 'light') => ipcRenderer.send('forge:titlebarTheme', theme)
})
