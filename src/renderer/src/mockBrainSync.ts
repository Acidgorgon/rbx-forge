// Browser-preview mock of .forgepack export/import and device sync (BrainSyncApi). mock.ts spreads
// it into its api object. ?brainsync=git | folder | auth | syncing picks the starting sync state
// (default: off).
import type { BrainSyncApi, BrainSyncSettings, BrainSyncStatus, ExportCandidate, HarnessEvents, ImportPreview, ImportPreviewItem } from '@shared/types'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

const H = 3600_000
const now = () => Date.now()
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const item = (section: string, kind: 'memory' | 'skill' | 'extra', name: string, description: string, ago: number, files = 1, bytes = 900): ExportCandidate => ({
  key: `${section}/${kind}/${name}`, section, kind, name, description, updated: now() - ago * H, files, bytes
})

export function brainSyncMock(emit: Emit): BrainSyncApi {
  const q = new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get('brainsync')
  const device = 'studio-mac'
  let settings: BrainSyncSettings = {
    mode: q === 'git' || q === 'auth' || q === 'syncing' ? 'git' : q === 'folder' ? 'folder' : 'off',
    repoUrl: q === 'folder' ? '' : 'https://github.com/dev/forge-brain.git',
    folder: q === 'folder' ? '/Users/dev/Library/CloudStorage/Dropbox' : '',
    intervalMinutes: 10
  }
  const target = () => (settings.mode === 'git' ? settings.repoUrl : settings.mode === 'folder' ? settings.folder : undefined)
  let status: BrainSyncStatus = {
    mode: settings.mode,
    state: settings.mode === 'off' ? 'off' : q === 'auth' ? 'error' : q === 'syncing' ? 'syncing' : 'idle',
    device,
    ...(target() ? { target: target() } : {}),
    ...(settings.mode !== 'off' ? { lastSync: now() - 0.2 * H, last: { pulled: 3, pushed: 1, conflicts: q === 'folder' ? 1 : 0 } } : {})
  }
  if (q === 'auth') {
    status.authProblem = true
    status.lastError = `Git could not sign in to github.com. Forge uses your own git credentials and never stores a token. Sign in once by running "git clone ${settings.repoUrl}" in a terminal (Git Credential Manager on Windows, the Keychain on macOS, or an SSH key), make sure the repo exists and your account can push to it, then press Sync now.`
  }
  const set = (p: Partial<BrainSyncStatus>) => {
    status = { ...status, ...p }
    for (const k of Object.keys(status) as (keyof BrainSyncStatus)[]) if (status[k] === undefined) delete status[k]
    emit('brainsync:status', { ...status })
  }

  const candidates: ExportCandidate[] = [
    item('user', 'memory', 'answer-style', 'Prefers terse answers: the diff first, then one line of why', 2),
    item('user', 'memory', 'naming-signals', 'Names Vide sources with a trailing noun, never a "get" prefix', 30),
    item('user', 'memory', 'preferred-models', 'Opus for refactors and new features, Sonnet for quick questions', 50),
    { ...item('user', 'memory', 'open-cloud-notes', 'Where the Open Cloud key for the test place lives', 80), blocked: 'open-cloud-notes.md: looks like it contains a credential assignment; memories never hold secrets (use the safeStorage secret settings instead)' },
    item('user', 'skill', 'profile-a-slow-server', 'A server frame-time regression needs tracking down', 72, 1, 1400),
    item('project', 'memory', 'luau-style-profile', 'Luau code style of this project: follow it when writing code', 120, 1, 2100),
    item('project', 'memory', 'currency-is-server-authoritative', 'Coins only change on the server via EconomyService', 70),
    item('project', 'skill', 'add-gentree-feature-with-blink', 'Adding a new GenTree feature that needs client/server networking', 5, 2, 2600),
    item('vfx', 'extra', 'ember-burst', 'Ember burst — warm sparks for hits and pickups', 12, 3, 48_000),
    item('vfx', 'extra', 'shield-ripple', 'Shield ripple — hex shield with a fresnel rim', 40, 2, 31_000)
  ]

  const preview = (): ImportPreview => {
    const incoming: ImportPreviewItem[] = [
      { ...item('user', 'memory', 'answer-style', 'Prefers terse answers: code first, one line of why, no recap', 1), status: 'conflict', local: { name: 'answer-style', updated: now() - 2 * H, description: 'Prefers terse answers: the diff first, then one line of why' }, renameTo: 'answer-style-2' },
      { ...item('user', 'memory', 'naming-signals', 'Names Vide sources with a trailing noun, never a "get" prefix', 30), status: 'same', local: { name: 'naming-signals', updated: now() - 30 * H } },
      { ...item('user', 'memory', 'tween-easing', 'Prefers Quint Out easing for UI tweens, 0.25 s', 20), status: 'new' },
      { ...item('user', 'memory', 'model-preferences', 'Opus for refactors, Sonnet for quick questions and docs', 9), status: 'similar', local: { name: 'preferred-models', updated: now() - 50 * H, description: 'Opus for refactors and new features, Sonnet for quick questions' } },
      { ...item('user', 'skill', 'ship-a-hotfix', 'A live bug needs a hotfix published without a full release', 4, 1, 1700), status: 'new' },
      { ...item('vfx', 'extra', 'ember-burst', 'Ember burst — warm sparks for hits and pickups', 3, 3, 52_000), status: 'conflict', local: { name: 'ember-burst', updated: now() - 12 * H }, renameTo: 'ember-burst-2' },
      { ...item('vfx', 'extra', 'portal-swirl', 'Portal swirl — looping vortex with beams', 6, 2, 40_000), status: 'new' },
      { ...item('user', 'memory', 'webhook-url', 'Discord webhook for playtest alerts', 60), status: 'blocked', reason: 'looks like it contains a Discord webhook URL; memories never hold secrets' }
    ]
    return {
      token: 'mock-pack',
      file: 'forge-workstation-pc-2026-10-12.forgepack',
      manifest: {
        format: 'forgepack', version: 1, created: now() - 20 * H, device: 'workstation-pc', app: 'RBX Forge 0.2.0',
        counts: { userMemories: 5, userSkills: 1, projectMemories: 0, projectSkills: 0, extra: { vfx: 2 } },
        items: incoming
      },
      items: incoming,
      sections: [{ id: 'user', label: 'User memory' }, { id: 'vfx', label: 'VFX library' }]
    }
  }

  return {
    async packCandidates() {
      await delay(120)
      return {
        items: candidates,
        sections: [{ id: 'user', label: 'User memory' }, { id: 'project', label: 'Project memory' }, { id: 'vfx', label: 'VFX library' }],
        projectOpen: true,
        device
      }
    },
    async packExport(keys, includeProject) {
      await delay(300)
      const chosen = candidates.filter((c) => (keys === 'all' ? c.section !== 'project' || includeProject : keys.includes(c.key)))
      const bad = chosen.filter((c) => c.blocked)
      if (bad.length) throw new Error(`export refused: ${bad.map((b) => `${b.key} (${b.blocked})`).join('; ')}`)
      const count = (s: string, k: string) => chosen.filter((c) => c.section === s && c.kind === k).length
      return {
        path: `/Users/dev/Desktop/forge-${device}-2026-10-13.forgepack`,
        manifest: {
          format: 'forgepack', version: 1, created: now(), device,
          counts: { userMemories: count('user', 'memory'), userSkills: count('user', 'skill'), projectMemories: count('project', 'memory'), projectSkills: count('project', 'skill'), extra: { vfx: count('vfx', 'extra') } },
          items: chosen
        }
      }
    },
    async packOpen() {
      await delay(200)
      return preview()
    },
    async packImport(_token, choices) {
      await delay(300)
      const p = preview()
      const r = { added: 0, replaced: 0, renamed: 0, merged: 0, skipped: 0, errors: [] as { key: string; error: string }[] }
      for (const i of p.items) {
        const c = choices[i.key] ?? (i.status === 'new' || i.status === 'similar' ? 'theirs' : i.status === 'conflict' ? 'mine' : 'skip')
        if (i.status === 'blocked' || i.status === 'same' || c === 'mine' || c === 'skip') r.skipped++
        else if (i.status === 'similar' && c === 'theirs') r.merged++
        else if (i.status === 'conflict' && c === 'both') r.renamed++
        else if (i.status === 'conflict') r.replaced++
        else r.added++
      }
      emit('memory:changed', { at: now() })
      return r
    },
    async brainSyncStatus() {
      return { ...status }
    },
    async brainSyncGetSettings() {
      return { ...settings }
    },
    async brainSyncSetSettings(patch) {
      settings = { ...settings, ...patch }
      set({ mode: settings.mode, state: settings.mode === 'off' ? 'off' : 'idle', target: target(), lastError: undefined, authProblem: undefined })
      return { ...settings }
    },
    async brainSyncNow() {
      if (settings.mode === 'off') return { ...status }
      set({ state: 'syncing', pending: undefined })
      await delay(900)
      set({ state: 'idle', lastSync: now(), last: { pulled: 0, pushed: 1, conflicts: 0 }, lastError: undefined, authProblem: undefined })
      return { ...status }
    },
    async brainSyncChooseFolder() {
      await delay(100)
      return '/Users/dev/Library/CloudStorage/Dropbox'
    }
  }
}
