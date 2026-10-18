// Browser-preview mock for the Source control panel: a fake index and HEAD over the mock files, so
// editing a file in the preview shows up under Changes. Starts with one staged and two unstaged
// changes; ?scm=clean starts with none, ?scm=held makes Stage all warn about a held delete.
import type { GitStatus, HarnessEvents, ScmApi, ScmDiff, ScmFile, ScmHeld, ScmResult, ScmStatus } from '@shared/types'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

export interface ScmMockDeps {
  files: Record<string, string>
  git: () => GitStatus
  setGit: (git: GitStatus) => void
  log: (text: string) => void
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function scmMock(_emit: Emit, deps: ScmMockDeps): ScmApi {
  const q = new URLSearchParams(location.search)
  const { files } = deps
  // HEAD as committed, and staged overrides of it (null: a staged delete).
  const head: Record<string, string> = { ...files }
  const index: Record<string, string | null> = {}
  let draft = false
  const HELD = 'src/server/Data/PlayerData.luau'
  if (q.get('scm') !== 'clean') {
    files['src/shared/Features/Shop/init.luau'] = '--!strict\n-- Shop feature: prices and stock.\n\nreturn {}\n'
    index['src/shared/Features/Shop/init.luau'] = files['src/shared/Features/Shop/init.luau']
    files['src/server/Features/Inventory/InventoryService.luau'] = (files['src/server/Features/Inventory/InventoryService.luau'] ?? '').replace('--!strict', '--!strict\n-- Max stack raised to 99.')
    files['notes/todo list.md'] = '- shop prices\n- daily reward\n'
  }
  if (q.get('scm') === 'held') delete files[HELD]

  const staged = (path: string): string | null | undefined => (path in index ? index[path] : head[path])
  const letter = (from: string | null | undefined, to: string | null | undefined, untracked = false): ScmFile['letter'] | null => {
    if (from === to) return null
    if (from === undefined || from === null) return untracked ? 'U' : 'A'
    return to === undefined || to === null ? 'D' : 'M'
  }
  const LABEL = { M: 'Modified', A: 'Added', D: 'Deleted', U: 'Untracked', R: 'Renamed', C: 'Copied', T: 'Type changed', '!': 'Conflict' }
  const status = (): ScmStatus => {
    const all = [...new Set([...Object.keys(head), ...Object.keys(index), ...Object.keys(files)])].sort()
    const st: ScmFile[] = []
    const ch: ScmFile[] = []
    for (const path of all) {
      const s = letter(head[path], staged(path))
      if (s) st.push({ path, letter: s, label: LABEL[s] })
      const c = letter(staged(path), files[path], !(path in head) && !(path in index))
      if (c) ch.push({ path, letter: c, label: LABEL[c] })
    }
    const g = deps.git()
    return {
      isRepo: g.isRepo,
      hasRemote: g.hasRemote,
      branch: g.branch,
      head: 'a41c9e2',
      upstream: g.hasRemote ? `origin/${g.branch ?? 'main'}` : undefined,
      ahead: g.ahead,
      behind: g.behind,
      staged: st,
      changes: ch,
      conflicts: [],
      ...(st.length || draft ? { autoSync: st.length ? 'Sync skips its "harness: sync" commit and waits to pull while files are staged.' : 'Sync skips its "harness: sync" commit while a message is typed here.' } : {})
    }
  }
  const result = (extra: Partial<ScmResult> = {}): ScmResult => {
    const s = status()
    deps.setGit({ ...deps.git(), dirty: new Set([...s.staged, ...s.changes].map((f) => f.path)).size })
    return { ...extra, status: s }
  }
  const stagePaths = (paths: string[]) => {
    for (const p of paths) index[p] = files[p] ?? null
  }
  const held = (paths: string[]): ScmHeld[] => (q.get('scm') === 'held' && paths.includes(HELD) && files[HELD] === undefined && staged(HELD) !== null ? [{ path: HELD, why: '412 lines' }] : [])

  return {
    async scmStatus() {
      return status()
    },
    async scmStage(paths, confirmHeld) {
      await delay(60)
      const list = paths === 'all' ? status().changes.map((f) => f.path) : paths
      const hold = confirmHeld ? [] : held(list)
      stagePaths(list.filter((p) => !hold.some((h) => h.path === p)))
      if (hold.length) deps.log(`git: not staging the delete of ${HELD} (412 lines): it left the disk outside Forge (no copy in .forge/sync/trash).`)
      return result(hold.length ? { held: hold } : {})
    },
    async scmUnstage(paths) {
      await delay(60)
      for (const p of paths === 'all' ? Object.keys(index) : paths) delete index[p]
      return result()
    },
    async scmDiscard(paths) {
      await delay(80)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backups: string[] = []
      for (const p of paths) {
        if (files[p] !== undefined) backups.push(`.forge/sync/trash/${stamp}/${p}`)
        const back = staged(p)
        if (back === undefined || back === null) delete files[p]
        else files[p] = back
      }
      deps.log(`git: discarded ${paths.length} change(s); copies in .forge/sync/trash/${stamp}/`)
      return result({ backups })
    },
    async scmCommit(message, options = {}) {
      await delay(200)
      if (!message.trim()) return result({ error: 'Type a commit message first.' })
      if (!status().staged.length) {
        if (!options.all) return result({ error: 'Nothing is staged.' })
        const list = status().changes.map((f) => f.path)
        const hold = options.confirmHeld ? [] : held(list)
        if (hold.length) return result({ held: hold })
        stagePaths(list)
      }
      for (const [p, text] of Object.entries(index)) {
        if (text === null) delete head[p]
        else head[p] = text
        delete index[p]
      }
      deps.log(`git commit -m ${JSON.stringify(message.trim().split('\n')[0])}`)
      const g = deps.git()
      deps.setGit({ ...g, ahead: options.push ? 0 : g.ahead + 1 })
      if (options.push) deps.log('git push')
      return result({ commit: Math.random().toString(16).slice(2, 9) })
    },
    async scmPull() {
      await delay(500)
      if (q.get('scm') === 'reject') return result({ error: 'fatal: Not possible to fast-forward, aborting.' })
      deps.setGit({ ...deps.git(), behind: 0, lastSync: Date.now() })
      deps.log('git pull --rebase --autostash')
      return result()
    },
    async scmPush() {
      await delay(400)
      const g = deps.git()
      if (g.behind > 0) return result({ error: 'Pull first: the remote has commits you do not have (error: failed to push some refs to origin)' })
      deps.setGit({ ...g, ahead: 0 })
      deps.log('git push')
      return result()
    },
    async scmFetch() {
      await delay(300)
      deps.log('git fetch')
      return result()
    },
    async scmDiff(path, isStaged): Promise<ScmDiff> {
      await delay(40)
      const [a, b] = isStaged ? [head[path], staged(path)] : [staged(path), files[path]]
      return { path, original: a ?? '', modified: b ?? '', originalLabel: isStaged ? 'HEAD' : path in index ? 'Staged' : 'HEAD', modifiedLabel: isStaged ? 'Staged' : 'Working tree' }
    },
    async scmSetDraft(on) {
      draft = on
    }
  }
}
