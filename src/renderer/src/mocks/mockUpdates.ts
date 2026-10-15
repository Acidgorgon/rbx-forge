// Browser-preview mock of self-update (UpdateApi). mock.ts spreads it into its api object.
// ?update=ready | downloading | available (macOS manual mode) | private | disabled | quick (a quick
// update is ready) | quick-running (this launch runs one) | quick-full (needs a full update) picks the
// starting state; the default is "up to date" so other previews show no update pill.
import type { HarnessApi, HarnessEvents, UpdateState } from '@shared/types'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

const NOTES = `What's new
- Auto-update: Forge checks GitHub Releases every 4 hours and installs on restart
- Settings > Updates with a beta channel
- Terminal: split panes keep their working folder

Fixes
- Luau LSP restarts after the project folder moves`

const OFFER = { version: '0.2.1', releaseName: 'v0.2.1', notes: NOTES, releaseDate: '2026-10-12T18:00:00.000Z', url: 'https://github.com/Acidgorgon/rbx-forge/releases/tag/v0.2.1' }

export function updatesMock(emit: Emit, log: (text: string) => void): Pick<HarnessApi, 'updateGetState' | 'updateCheck' | 'updateSetSettings' | 'updateInstall' | 'updateOpenRelease' | 'updateQuickRestart'> {
  const query = new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get('update')
  const base: UpdateState = {
    phase: 'none',
    mode: query === 'available' ? 'manual' : 'install',
    currentVersion: '0.2.0',
    channel: 'stable',
    autoCheck: true,
    feed: 'Acidgorgon/rbx-forge',
    lastCheck: Date.now() - 42 * 60 * 1000,
    quick: {
      phase: 'none',
      enabled: true,
      running: query === 'quick-running' ? { source: 'quick', version: '0.2.0-quick.14', appVersion: '0.2.0' } : { source: 'bundled', version: '0.2.0', appVersion: '0.2.0' },
      lastCheck: Date.now() - 42 * 60 * 1000
    }
  }
  let state: UpdateState = { ...base }
  if (query === 'available') state = { ...state, phase: 'available', offer: OFFER, note: 'macOS only installs updates into apps signed with an Apple Developer ID, and this build is ad-hoc signed. Forge tells you about new versions and opens the download page.' }
  if (query === 'ready') state = { ...state, phase: 'ready', offer: OFFER, percent: 100 }
  if (query === 'downloading') state = { ...state, phase: 'downloading', offer: OFFER, percent: 38 }
  if (query === 'disabled') state = { ...state, phase: 'disabled', note: 'Development build. Updates are checked in the installed app.' }
  const privateError: UpdateState['error'] = {
    kind: 'private',
    message: `Can't read the releases of Acidgorgon/rbx-forge. The repository is private, renamed or deleted, and Forge never ships a GitHub token. Publish releases to a public repository (see README "Updates").`,
    detail: 'HttpError: 404 Not Found'
  }
  if (query === 'private') state = { ...state, phase: 'error', error: privateError }
  if (query === 'quick') state = { ...state, quick: { ...state.quick!, phase: 'ready', version: '0.2.0-quick.15', commit: '4aa6a4f', createdAt: '2026-10-14T09:30:00.000Z' } }
  if (query === 'quick-full') {
    const message = 'Quick update 0.2.0-quick.16 needs a newer installed app (Electron 44.7.0 -> 44.8.0). Install the next full update.'
    state = { ...state, quick: { ...state.quick!, phase: 'needsFull', version: '0.2.0-quick.16', message } }
  }

  const set = (patch: Partial<UpdateState>) => {
    state = { ...state, ...patch }
    for (const k of Object.keys(patch) as (keyof UpdateState)[]) if (patch[k] === undefined) delete state[k]
    emit('update:state', { ...state })
  }

  return {
    async updateGetState() {
      return { ...state }
    },
    async updateCheck() {
      if (state.phase === 'disabled' || state.phase === 'downloading') return { ...state }
      set({ phase: 'checking', error: undefined })
      await delay(700)
      if (query === 'private') {
        set({ phase: 'error', error: privateError, lastCheck: Date.now() })
        return { ...state }
      }
      if (state.mode === 'manual' || query === 'available') {
        set({ phase: 'available', offer: OFFER, lastCheck: Date.now() })
        return { ...state }
      }
      set({ phase: 'downloading', offer: OFFER, percent: 0, lastCheck: Date.now() })
      void (async () => {
        for (let p = 12; p <= 100; p += 22) {
          await delay(260)
          set({ percent: Math.min(100, p) })
        }
        set({ phase: 'ready', percent: 100 })
        log('update 0.2.1 downloaded; installs on restart')
      })()
      return { ...state }
    },
    async updateSetSettings(patch) {
      const quick = typeof patch.quick === 'boolean' && state.quick ? { quick: { ...state.quick, enabled: patch.quick, phase: patch.quick ? ('none' as const) : ('off' as const) } } : {}
      set({ ...(typeof patch.autoCheck === 'boolean' ? { autoCheck: patch.autoCheck } : {}), ...(patch.channel ? { channel: patch.channel } : {}), ...quick })
      return { ...state }
    },
    async updateQuickRestart() {
      log(`restart into quick update ${state.quick?.version ?? ''} (preview: nothing happens)`)
    },
    async updateInstall() {
      log('restart into 0.2.1 (preview: nothing happens)')
    },
    async updateOpenRelease() {
      window.open(state.offer?.url ?? 'https://github.com/Acidgorgon/rbx-forge/releases/latest', '_blank')
    }
  }
}
