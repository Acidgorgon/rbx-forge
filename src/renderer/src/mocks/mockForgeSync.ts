// Browser-preview mock of SyncApi (Forge Sync): an FSF-like project with two places (match =
// default.project.json, menu = menu.project.json) that cross-mount src/skills, teammate edits pulled
// from Studio, a held conflict and a first-run place.
// ?forgesync=blocked (default) | firstrun | studioonly | clear | checking | project | off
import type { ForgeSyncSettings, HarnessEvents, StudioConflict, StudioOnlyScript, SyncApi, SyncConflictInfo, SyncEntry, SyncStatus, PlaceSyncStatus } from '@shared/types'
import { collapseInstancePaths } from '@shared/explorerSelection'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

const UPPERCUT_BASE = `local Uppercut = {}

Uppercut.Name = "Uppercut"
Uppercut.Cooldown = 4
Uppercut.Damage = 12
Uppercut.Knockback = Vector3.new(0, 40, 0)

function Uppercut.Start(ctx)
\tctx:PlayAnimation("Uppercut")
\tctx:Hitbox({ Size = Vector3.new(5, 6, 5), Duration = 0.2 })
end

return Uppercut
`
const UPPERCUT_DISK = UPPERCUT_BASE.replace('Uppercut.Damage = 12', 'Uppercut.Damage = 14 -- acid: buffed after playtest')
const UPPERCUT_STUDIO = UPPERCUT_BASE.replace('Uppercut.Damage = 12', 'Uppercut.Damage = 10 -- nyx: too strong in 2v2').replace(
  '\tctx:Hitbox({ Size = Vector3.new(5, 6, 5), Duration = 0.2 })',
  '\tctx:Hitbox({ Size = Vector3.new(5, 6, 5), Duration = 0.2 })\n\tctx:Shake(0.3)'
)
const SHOP_DISK = `local ShopController = {}\n\nfunction ShopController.Open(player)\n\treturn true\nend\n\nreturn ShopController\n`
const SHOP_STUDIO = SHOP_DISK.replace('\treturn true', '\tif not player:GetAttribute("Loaded") then\n\t\treturn false\n\tend\n\treturn true')
const DASH_DISK = `return {\n\tName = "Dash",\n\tCooldown = 2,\n\tDistance = 18,\n}\n`
const DASH_STUDIO = DASH_DISK.replace('Distance = 18', 'Distance = 22')

const MOCK_REFS = [
  { path: ['ServerScriptService', 'Server', 'Features', 'Skills', 'Moves', 'Dash', 'Target'], property: 'Value' },
  { path: ['ReplicatedStorage', 'Shared', 'Assets', 'Sword', 'Handle', 'GripWeld'], property: 'Part0' },
  { path: ['ReplicatedStorage', 'Shared', 'Assets', 'Sword', 'Handle', 'GripWeld'], property: 'Part1' },
  { path: ['ReplicatedStorage', 'Shared', 'Assets', 'Sword'], property: 'PrimaryPart' },
  { path: ['ReplicatedStorage', 'Shared', 'Assets', 'Sword', 'Blade', 'Trail'], property: 'Attachment0' }
]

export function forgeSyncMock(emit: Emit, log: (text: string) => void) {
  const mode = new URLSearchParams(location.search).get('forgesync') ?? 'blocked'
  let settings: ForgeSyncSettings = { engine: mode === 'project' ? 'project' : mode === 'off' ? 'off' : 'forge', gateRojo: true }
  let legacy = mode !== 'clear'
  const t = Date.now()
  const MATCH = '4815162342'
  const MENU = '4815162399'

  let conflicts: SyncConflictInfo[] = []
  if (mode === 'blocked') {
    conflicts.push({
      placeKey: MATCH,
      file: 'src/skills/Definitions/Uppercut.luau',
      instancePath: ['ReplicatedStorage', 'Skills', 'Definitions', 'Uppercut'],
      base: UPPERCUT_BASE,
      disk: UPPERCUT_DISK,
      studio: UPPERCUT_STUDIO,
      reason: 'both-changed'
    })
  }
  if (mode === 'firstrun') {
    conflicts.push(
      { placeKey: MENU, file: 'src/menu/Shop/ShopController.luau', instancePath: ['StarterPlayer', 'StarterPlayerScripts', 'Menu', 'Shop', 'ShopController'], base: null, disk: SHOP_DISK, studio: SHOP_STUDIO, reason: 'first-run' },
      { placeKey: MENU, file: 'src/skills/Definitions/Dash.luau', instancePath: ['ReplicatedStorage', 'Skills', 'Definitions', 'Dash'], base: null, disk: DASH_DISK, studio: DASH_STUDIO, reason: 'first-run' }
    )
  }

  let recent: SyncEntry[] = [
    { file: 'src/skills/Server/Moves/Uppercut/init.luau', action: 'pulled', instancePath: ['ServerScriptService', 'Skills', 'Moves', 'Uppercut'], at: t - 40_000 },
    { file: 'src/skills/Server/Moves/NewMove', action: 'created', instancePath: ['ServerScriptService', 'Skills', 'Moves', 'NewMove'], at: t - 95_000 },
    { file: 'src/skills/Server/Moves/NewMove/init.luau', action: 'created', instancePath: ['ServerScriptService', 'Skills', 'Moves', 'NewMove'], at: t - 95_000 },
    { file: 'src/shared/Animations/Uppercut.model.json', action: 'created', instancePath: ['ReplicatedStorage', 'Animations', 'Uppercut'], at: t - 130_000 },
    { file: 'src/skills/Definitions/Uppercut.luau', action: mode === 'blocked' ? 'conflict' : 'merged', instancePath: ['ReplicatedStorage', 'Skills', 'Definitions', 'Uppercut'], at: t - 180_000 },
    { file: 'src/skills/Server/Moves/GroundSlam.luau', action: 'renamed', from: 'src/skills/Server/Moves/Slam.luau', instancePath: ['ServerScriptService', 'Skills', 'Moves', 'GroundSlam'], at: t - 600_000 },
    { file: 'src/skills/Server/Moves/OldKick.luau', action: 'trashed', instancePath: ['ServerScriptService', 'Skills', 'Moves', 'OldKick'], at: t - 900_000 }
  ]
  let pending = mode === 'off' || mode === 'project' ? [] : [
    'src/shared/Animations/Uppercut.model.json',
    'src/skills/Server/Moves/GroundSlam.luau',
    'src/skills/Server/Moves/NewMove/init.luau',
    'src/skills/Server/Moves/OldKick.luau',
    'src/skills/Server/Moves/Slam.luau',
    'src/skills/Server/Moves/Uppercut/init.luau'
  ]
  const served = new Set<string>()
  // "Serve without Studio check" for place files no Studio check has cleared.
  const unchecked = new Set<string>()
  // ?forgesync=studioonly: a cutscene module (and its children) only Studio has; rojo is held for it.
  const WAKE = ['StarterPlayer', 'StarterPlayerScripts', 'Client', 'Controllers', 'OnboardingController', 'WakeUpCutscene']
  const WAKE_DIR = 'src/client/Controllers/OnboardingController/WakeUpCutscene'
  let studioOnly: StudioOnlyScript[] = mode !== 'studioonly' ? [] : [
    { instancePath: WAKE, file: `${WAKE_DIR}/init.luau`, reason: 'its file was removed from disk (or "Disk" was chosen for it) while Studio kept it', canPull: true },
    ...['Body', 'Lens', 'Motion'].map((n) => ({ instancePath: [...WAKE, n], file: `${WAKE_DIR}/${n}.luau`, reason: 'its file was removed from disk (or "Disk" was chosen for it) while Studio kept it', canPull: true })),
    { instancePath: [...WAKE.slice(0, -1), 'init'], reason: 'Forge cannot write it: unsafe name: "init" is a Rojo file convention', canPull: false }
  ]

  const places = (): PlaceSyncStatus[] => {
    const held = (key: string) => conflicts.filter((c) => c.placeKey === key).length
    const only = (key: string) => (key === MATCH && studioOnly.length ? { studioOnly: { count: studioOnly.length, pullable: studioOnly.filter((i) => i.canPull).length, holds: true, items: studioOnly } } : {})
    const gate = (key: string, fallback: PlaceSyncStatus['gate']): PlaceSyncStatus['gate'] =>
      mode === 'checking' && key === MATCH ? 'checking' : (held(key) || only(key).studioOnly) && !served.has(key) ? 'blocked' : fallback
    return [
      {
        placeKey: MATCH,
        projectFile: 'default.project.json',
        place: { placeId: Number(MATCH), gameId: 1600001, name: 'FSF Match' },
        gate: gate(MATCH, 'clear'),
        connected: true,
        ...(mode === 'checking' ? {} : { lastSnapshot: t - 42_000 }),
        counts: mode === 'checking' ? {} : { same: 318, pulled: 3, created: 3, renamed: 1, trashed: 1, ...(held(MATCH) ? { conflict: held(MATCH) } : { merged: 1 }) },
        conflicts: held(MATCH),
        ...only(MATCH)
      },
      {
        placeKey: MENU,
        projectFile: 'menu.project.json',
        place: { placeId: Number(MENU), gameId: 1600001, name: 'FSF Menu' },
        ...(mode === 'firstrun' || unchecked.has('menu.project.json')
          ? { gate: gate(MENU, mode === 'firstrun' ? 'clear' : 'idle') }
          : {
              gate: gate(MENU, 'waiting'),
              waitReason: 'unlinked' as const,
              gateDetail: 'Studio has "DoubleFireSlashVFX" open, but it isn\'t linked to this project: link it in Studio sync so Forge checks it first, or serve without a Studio check. Rojo serve waits so Rojo cannot delete scripts that exist only in Studio'
            }),
        connected: mode === 'firstrun',
        ...(mode === 'firstrun' ? { lastSnapshot: t - 8_000, counts: { same: 204, conflict: held(MENU) } } : { counts: {} }),
        conflicts: held(MENU)
      }
    ]
  }

  const status = (): SyncStatus => ({
    engine: settings.engine,
    places: settings.engine === 'forge' ? places() : [],
    recent: settings.engine === 'forge' ? recent : [],
    pendingStudioEdits: settings.engine === 'forge' ? pending : [],
    legacyPluginInstalled: legacy,
    ...(legacy ? { legacyPlugins: ['FSFStudioSync.lua'] } : {}),
    ...(settings.engine === 'forge' && mode !== 'checking' ? { unsyncedRefs: MOCK_REFS, unsyncedRefsTotal: MOCK_REFS.length } : {}),
    ...(settings.engine === 'forge' ? { unlinked: [{ id: 'probe:mock', name: 'DoubleFireSlashVFX', placeId: 0, lastSeen: t, canLink: true, why: 'Unpublished place, not linked to this project' }] } : {})
  })

  const studioConflicts = (): StudioConflict[] | null =>
    settings.engine !== 'forge'
      ? null
      : conflicts.map((c) => ({ path: c.file, repoSource: c.disk, studioSource: c.studio, base: c.base, placeKey: c.placeKey, instancePath: c.instancePath, reason: c.reason }))

  const changed = () => {
    const s = status()
    emit('sync:status', s)
    const list = studioConflicts()
    if (list) emit('studio:conflicts', list)
  }

  const resolveOne = (placeKey: string, file: string, take: 'studio' | 'disk' | 'merged') => {
    conflicts = conflicts.filter((c) => !(c.placeKey === placeKey && c.file === file))
    const entry: SyncEntry = { file, action: take === 'disk' ? 'disk-ahead' : take === 'merged' ? 'merged' : 'pulled', instancePath: file.replace(/^src\//, '').replace(/\.luau$/, '').split('/'), at: Date.now() }
    recent = [entry, ...recent]
    if (take !== 'disk' && !pending.includes(file)) pending = [...pending, file].sort()
    log(`resolved ${file}: took ${take}`)
  }

  const api: SyncApi = {
    async syncStatus() {
      return status()
    },
    async syncSaveTarget(instancePath) {
      return instancePath[0] === 'ServerStorage' && instancePath.length === 2 ? { file: `src/ServerStorage/${instancePath[1]}.model.json` } : { reason: 'Not under a Rojo $path; add a folder mapping in default.project.json first' }
    },
    async syncSaveToRepo(instancePath) {
      await delay(200)
      const file = `src/ServerStorage/${instancePath[instancePath.length - 1]}.model.json`
      const entry: SyncEntry = { file, action: 'created', instancePath, at: Date.now(), note: 'saved to repo from Studio' }
      recent = [entry, ...recent]
      changed()
      return entry
    },
    async syncDeleteCheck(instancePath) {
      return instancePath.length >= 2 ? { ok: true as const } : { reason: 'services cannot be deleted' }
    },
    async syncDeleteInStudio(instancePath) {
      await delay(200)
      log(`deleted ${instancePath.join('.')} in Studio`)
    },
    async syncDeleteManyInStudio(items) {
      const deleted: string[][] = []
      for (const it of collapseInstancePaths(items)) {
        await delay(120)
        log(`deleted ${it.instancePath.join('.')} in Studio`)
        deleted.push(it.instancePath)
      }
      return { deleted, failed: [] }
    },
    async syncResolve(placeKey, file, take) {
      await delay(200)
      resolveOne(placeKey, file, take)
      changed()
      return status()
    },
    async syncResolveAll(placeKey, take, reason) {
      await delay(300)
      for (const c of conflicts.filter((x) => x.placeKey === placeKey && (!reason || x.reason === reason))) resolveOne(placeKey, c.file, take)
      changed()
      return status()
    },
    async syncLinkPlace(id) {
      log(`linked ${id}`)
      changed()
      return status()
    },
    async syncPullStudioOnly(placeKey) {
      await delay(300)
      const pulled = studioOnly.filter((i) => i.canPull)
      studioOnly = studioOnly.filter((i) => !i.canPull)
      recent = [...pulled.map((i): SyncEntry => ({ file: i.file!, action: 'created', instancePath: i.instancePath, at: Date.now(), note: 'pulled to disk (only Studio had it)' })), ...recent]
      pending = [...new Set([...pending, ...pulled.map((i) => i.file!)])].sort()
      log(`pulled ${pulled.length} Studio-only scripts of ${placeKey} to disk`)
      changed()
      return status()
    },
    async syncServeWithoutCheck(projectFile) {
      for (const p of places()) if (!projectFile || p.projectFile === projectFile) unchecked.add(p.projectFile)
      log(`serving ${projectFile ?? 'every place'} without a Studio check`)
      changed()
      return status()
    },
    async syncServeAnyway(placeKey) {
      served.add(placeKey)
      log(`serving ${placeKey} anyway`)
      changed()
      return status()
    },
    async syncCommitStudioEdits(message) {
      await delay(400)
      const committed = pending
      if (!committed.length) return { committed: [], error: 'No uncommitted Studio edits' }
      pending = []
      const text = message || `Studio edits: ${committed.slice(0, 3).map((f) => f.split('/').pop()).join(', ')}${committed.length > 3 ? ` and ${committed.length - 3} more` : ''}`
      log(`git commit -m "${text}"`)
      changed()
      return { committed, message: text }
    },
    async syncDisableLegacyPlugin() {
      await delay(200)
      legacy = false
      log('renamed FSFStudioSync.lua -> FSFStudioSync.lua.disabled')
      changed()
      return status()
    },
    async forgeSyncSettings() {
      return settings
    },
    async setForgeSyncSettings(patch) {
      settings = { ...settings, ...patch }
      changed()
      return settings
    }
  }
  return { api, studioConflicts, resolve: (path: string, take: 'studio' | 'repo', placeKey?: string) => {
    const c = conflicts.find((x) => x.file === path && (!placeKey || x.placeKey === placeKey))
    if (!c) return false
    resolveOne(c.placeKey, c.file, take === 'repo' ? 'disk' : 'studio')
    changed()
    return true
  } }
}
