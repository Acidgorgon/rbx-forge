// Packages drawer: Wally dependencies (search the registry, add, update, remove) and Rokit tools
// (installed state, curated tools, updates). Backed by main/services/packages.ts.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PackagesChanged, RokitTool, WallyDependency, WallyPackage, WallyRealm } from '@shared/types'
import { useStore } from '../store'
import { IconAlert, IconCheck, IconClose, IconSearch, IconTool } from '../components/Icons'
import { errorText } from '../lib/format'
import './packages.css'

type P = { size?: number; className?: string }

const IconTrash = ({ size = 14 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </svg>
)

const IconUp = ({ size = 12 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
)

const REALM_LABEL: Record<WallyRealm, string> = { shared: 'Shared', server: 'Server', dev: 'Dev' }

// "0.7.4+registry.0.2.3" -> "0.7.4" for display (the full tag is in the title).
function shortVersion(v?: string): string {
  return (v ?? '').replace(/\+.*$/, '')
}

type Tab = 'wally' | 'tools'

export function PackagesPage() {
  const { state } = useStore()
  const h = window.harness
  const [tab, setTab] = useState<Tab>('wally')
  const [deps, setDeps] = useState<WallyDependency[] | null>(null)
  const [tools, setTools] = useState<RokitTool[] | null>(null)
  const [installing, setInstalling] = useState<PackagesChanged['installing']>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadDeps = useCallback(async () => {
    try {
      setDeps(await h.listWallyDeps())
    } catch (e) {
      setLoadError(errorText(e))
      setDeps([])
    }
  }, [h])
  const loadTools = useCallback(async () => {
    try {
      setTools(await h.curatedTools().then(async (curated) => mergeTools(await h.listRokitTools(), curated)))
    } catch (e) {
      setLoadError(errorText(e))
      setTools([])
    }
  }, [h])

  useEffect(() => {
    void loadDeps()
    void loadTools()
    return h.on('packages:changed', (p) => {
      if (p.installing !== undefined) setInstalling(p.installing)
      if (p.error !== undefined || p.installing === null) setError(p.error ?? null)
      if (p.wally) setDeps(p.wally)
      if (p.tools) setTools((prev) => mergeTools(p.tools!, prev ?? []))
      if (p.installing === null && !p.error && p.wally) {
        // Refresh registry info (latest versions) quietly after an install.
        void loadDeps()
      }
    })
  }, [h, loadDeps, loadTools])

  const lsp = tools?.find((t) => t.repo.toLowerCase() === 'johnnymorganz/luau-lsp')
  const lspMissing = !!lsp && !(lsp.inManifest && lsp.installed) && !lsp.onPath
  const updates = (deps ?? []).filter((d) => d.updateAvailable).length
  const toolUpdates = (tools ?? []).filter((t) => t.inManifest && t.updateAvailable).length

  const subtitle = !state.project
    ? 'Open a project to manage packages'
    : installing === 'wally'
      ? 'Installing Wally packages…'
      : installing === 'rokit'
        ? 'Installing tools with Rokit…'
        : 'wally.toml · rokit.toml'

  return (
    <div className="page">
      <div className="page-inner">
      <div className="page-head">
        <div>
          <h1>Packages</h1>
          <div className="sub">{subtitle}</div>
        </div>
      </div>
      <div className="pk-tabs">
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={tab === 'wally'} className={tab === 'wally' ? 'on' : ''} onClick={() => setTab('wally')}>
            Wally packages{deps ? <span className="pk-tab-n">{deps.length}</span> : null}
            {updates > 0 && <span className="pk-tab-dot up" title={`${updates} update${updates > 1 ? 's' : ''}`} />}
          </button>
          <button role="tab" aria-selected={tab === 'tools'} className={tab === 'tools' ? 'on' : ''} onClick={() => setTab('tools')}>
            Tools{tools ? <span className="pk-tab-n">{tools.filter((t) => t.inManifest).length}</span> : null}
            {lspMissing ? <span className="pk-tab-dot bad" title="luau-lsp missing" /> : toolUpdates > 0 && <span className="pk-tab-dot up" />}
          </button>
        </div>
        {installing && (
          <span className="pk-installing">
            <span className="spinner" />
            {installing === 'wally' ? 'wally install' : 'rokit install'}
          </span>
        )}
      </div>

      {(error || loadError) && (
        <div className="pk-banner bad" role="alert">
          <IconAlert size={15} />
          <div className="pk-banner-text">{error || loadError}</div>
          <button className="icon-btn" title="Dismiss" onClick={() => (setError(null), setLoadError(null))}>
            <IconClose size={14} />
          </button>
        </div>
      )}

      {tab === 'wally' ? (
        <WallyTab deps={deps} setDeps={setDeps} installing={installing === 'wally'} onError={setError} />
      ) : (
        <ToolsTab tools={tools} lsp={lsp} lspMissing={lspMissing} installing={installing === 'rokit'} reload={loadTools} onError={setError} />
      )}
      </div>
    </div>
  )
}

// Manifest tools first (in rokit.toml order), then curated tools not added yet.
function mergeTools(manifest: RokitTool[], curated: RokitTool[]): RokitTool[] {
  const key = (t: RokitTool) => t.repo.toLowerCase()
  const inManifest = new Set(manifest.map(key))
  return [...manifest, ...curated.filter((c) => !c.inManifest && !inManifest.has(key(c)))]
}

// ---------------------------------------------------------------- Wally

function WallyTab({
  deps,
  setDeps,
  installing,
  onError
}: {
  deps: WallyDependency[] | null
  setDeps: (d: WallyDependency[]) => void
  installing: boolean
  onError: (e: string | null) => void
}) {
  const h = window.harness
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WallyPackage[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const seq = useRef(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => input.current?.focus(), [])

  // Debounced registry search.
  useEffect(() => {
    const q = query.trim()
    const id = ++seq.current
    if (q.length < 2) {
      setResults(null)
      setSearching(false)
      setSearchError(null)
      return
    }
    setSearching(true)
    const timer = setTimeout(async () => {
      try {
        const found = await h.searchWally(q)
        if (id !== seq.current) return
        setResults(found)
        setSearchError(null)
      } catch (e) {
        if (id !== seq.current) return
        setSearchError(`Could not reach the Wally registry: ${errorText(e)}`)
        setResults([])
      } finally {
        if (id === seq.current) setSearching(false)
      }
    }, 320)
    return () => clearTimeout(timer)
  }, [query, h])

  const byId = useMemo(() => {
    const map = new Map<string, WallyDependency>()
    for (const d of deps ?? []) map.set(`${d.scope}/${d.name}`, d)
    return map
  }, [deps])

  const updates = (deps ?? []).filter((d) => d.updateAvailable)

  return (
    <>
      <section className="pk-search">
        <label className="filter pk-filter">
          <IconSearch size={15} />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the Wally registry, e.g. signal, promise, sleitnick/trove"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation()
                setQuery('')
              }
            }}
          />
          {searching ? (
            <span className="spinner" />
          ) : (
            query && (
              <button className="filter-clear" title="Clear" onClick={() => setQuery('')}>
                <IconClose size={13} />
              </button>
            )
          )}
        </label>
        {searchError && <p className="pk-inline-error">{searchError}</p>}
        {results && (
          <div className="pk-results">
            {results.length === 0 && !searchError && !searching && <p className="muted small pk-empty">No packages match “{query.trim()}”.</p>}
            {results.map((p) => (
              <SearchRow key={`${p.scope}/${p.name}`} pkg={p} existing={byId.get(`${p.scope}/${p.name}`)} onAdded={setDeps} onError={onError} />
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h3>In wally.toml</h3>
          <span className="count">{deps?.length ?? '…'}</span>
          {updates.length > 0 && <span className="pk-badge up">{updates.length} update{updates.length > 1 ? 's' : ''}</span>}
          <span className="pk-head-fill" />
          {installing && <span className="muted small">The dev loop runs wally install…</span>}
        </div>
        {deps === null ? (
          <div className="pk-list">
            {[0, 1, 2].map((i) => (
              <div key={i} className="pk-row pk-skeleton" />
            ))}
          </div>
        ) : deps.length === 0 ? (
          <p className="muted small">No Wally dependencies yet. Search above to add one.</p>
        ) : (
          <div className="pk-list">
            {deps.map((d) => (
              <DepRow key={`${d.realm}:${d.alias}`} dep={d} installing={installing} onChanged={setDeps} onError={onError} />
            ))}
          </div>
        )}
      </section>
    </>
  )
}

function SearchRow({
  pkg,
  existing,
  onAdded,
  onError
}: {
  pkg: WallyPackage
  existing?: WallyDependency
  onAdded: (d: WallyDependency[]) => void
  onError: (e: string | null) => void
}) {
  const { actions } = useStore()
  const h = window.harness
  const [versions, setVersions] = useState(pkg.versions)
  const [version, setVersion] = useState(pkg.latest)
  const [realm, setRealm] = useState<WallyRealm>(pkg.realm === 'server' ? 'server' : 'shared')
  const [packageRealm, setPackageRealm] = useState(pkg.realm)
  const [busy, setBusy] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)
  const id = `${pkg.scope}/${pkg.name}`

  // Search hits carry only the newest version; fetch the full list the first time it is needed.
  const loadVersions = async () => {
    if (versions.length > 1) return
    try {
      const meta = await h.wallyPackage(id)
      setVersions(meta.versions)
      if (meta.realm) {
        setPackageRealm(meta.realm)
        if (meta.realm === 'server') setRealm('server')
      }
    } catch {
      // keep the single version
    }
  }

  const add = async () => {
    setBusy(true)
    setRowError(null)
    try {
      const next = await h.addWallyDep({ scope: pkg.scope, name: pkg.name, version, realm })
      onAdded(next)
      onError(null)
      const added = next.find((d) => d.scope === pkg.scope && d.name === pkg.name)
      actions.toast(`Added ${added?.alias ?? pkg.name} ${version}`)
    } catch (e) {
      setRowError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pk-result">
      <div className="pk-result-main">
        <div className="pk-title-line">
          <span className="pk-name">{pkg.name}</span>
          <span className="pk-scope">{pkg.scope}</span>
          {packageRealm && <span className={`realm realm-${packageRealm} pk-realm`}>{packageRealm}</span>}
          {existing && <span className="pk-version muted">{existing.installedVersion ?? existing.version}</span>}
        </div>
        <div className="pk-desc">{pkg.description || <span className="faint">No description</span>}</div>
        {rowError && <div className="pk-inline-error">{rowError}</div>}
      </div>
      <div className="pk-result-actions">
        {existing ? (
          <span className="pk-badge ok" title={`${existing.alias} = "${id}@${existing.version}"`}>
            <IconCheck size={12} /> Added as {existing.alias}
          </span>
        ) : (
          <>
            <select className="pk-select" value={version} onFocus={() => void loadVersions()} onMouseDown={() => void loadVersions()} onChange={(e) => setVersion(e.target.value)} title="Version">
              {versions.map((v) => (
                <option key={v} value={v}>
                  {v}
                  {v === pkg.latest ? ' (latest)' : ''}
                </option>
              ))}
            </select>
            <select className="pk-select" value={realm} onChange={(e) => setRealm(e.target.value as WallyRealm)} title="wally.toml section">
              <option value="shared" disabled={packageRealm === 'server'}>Shared</option>
              <option value="server">Server</option>
              <option value="dev">Dev</option>
            </select>
            <button className="btn small primary" disabled={busy} onClick={() => void add()}>
              {busy ? <span className="spinner" /> : null}
              Add
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function DepRow({
  dep,
  installing,
  onChanged,
  onError
}: {
  dep: WallyDependency
  installing: boolean
  onChanged: (d: WallyDependency[]) => void
  onError: (e: string | null) => void
}) {
  const { actions } = useStore()
  const h = window.harness
  const [busy, setBusy] = useState<null | 'update' | 'remove'>(null)
  const [confirm, setConfirm] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)

  useEffect(() => {
    if (!confirm) return
    const t = setTimeout(() => setConfirm(false), 3000)
    return () => clearTimeout(t)
  }, [confirm])

  const act = async (kind: 'update' | 'remove') => {
    setBusy(kind)
    setRowError(null)
    try {
      const next = kind === 'update' ? await h.updateWallyDep(dep.alias, dep.realm) : await h.removeWallyDep(dep.alias, dep.realm)
      onChanged(next)
      onError(null)
      actions.toast(kind === 'update' ? `Updated ${dep.alias} to ${dep.latest}` : `Removed ${dep.alias}`)
    } catch (e) {
      setRowError(errorText(e))
    } finally {
      setBusy(null)
      setConfirm(false)
    }
  }

  const shown = dep.installedVersion ?? dep.version
  return (
    <div className={`pk-row${dep.installed ? '' : ' not-installed'}`}>
      <div className="pk-row-main">
        <div className="pk-title-line">
          <span className="pk-alias">{dep.alias}</span>
          <span className="pk-scope mono">
            {dep.scope}/{dep.name}
          </span>
        </div>
        {rowError && <div className="pk-inline-error">{rowError}</div>}
      </div>
      <span className={`realm realm-${dep.realm === 'dev' ? 'client' : dep.realm} pk-realm`} title={`[${dep.realm === 'shared' ? 'dependencies' : dep.realm + '-dependencies'}]`}>
        {REALM_LABEL[dep.realm]}
      </span>
      <span className="pk-version" title={dep.installedVersion && dep.installedVersion !== dep.version ? `wally.toml asks for ${dep.version}; wally.lock resolved ${dep.installedVersion}` : undefined}>
        {shown}
      </span>
      <span className="pk-state">
        {dep.installed ? (
          <span className="pk-ok" title="In Packages/">
            <IconCheck size={13} />
          </span>
        ) : installing ? (
          <span className="pk-pending" title="Installing">
            <span className="spinner" />
          </span>
        ) : (
          <span className="pk-badge warn" title="Not in Packages/ yet. Start the dev loop or run wally install.">Not installed</span>
        )}
      </span>
      <span className="pk-row-actions">
        {dep.updateAvailable && dep.latest && (
          <button className="pk-update" disabled={!!busy} onClick={() => void act('update')} title={`Update to ${dep.latest}`}>
            {busy === 'update' ? <span className="spinner" /> : <IconUp />}
            {dep.latest}
          </button>
        )}
        <button
          className={`icon-btn pk-remove${confirm ? ' confirm' : ''}`}
          disabled={!!busy}
          title={confirm ? 'Click again to remove' : `Remove ${dep.alias}`}
          onClick={() => (confirm ? void act('remove') : setConfirm(true))}
        >
          {busy === 'remove' ? <span className="spinner" /> : confirm ? <span className="pk-confirm">Remove?</span> : <IconTrash />}
        </button>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------- Tools

function ToolsTab({
  tools,
  lsp,
  lspMissing,
  installing,
  reload,
  onError
}: {
  tools: RokitTool[] | null
  lsp?: RokitTool
  lspMissing: boolean
  installing: boolean
  reload: () => Promise<void>
  onError: (e: string | null) => void
}) {
  const { actions } = useStore()
  const h = window.harness
  const [busy, setBusy] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [custom, setCustom] = useState('')

  const run = async (key: string, fn: () => Promise<unknown>, done: string): Promise<boolean> => {
    setBusy(key)
    setRowErrors((r) => ({ ...r, [key]: '' }))
    try {
      await fn()
      onError(null)
      actions.toast(done)
      await reload()
      return true
    } catch (e) {
      setRowErrors((r) => ({ ...r, [key]: errorText(e) }))
      await reload()
      return false
    } finally {
      setBusy(null)
    }
  }

  if (!tools) {
    return (
      <div className="pk-list">
        {[0, 1, 2].map((i) => (
          <div key={i} className="pk-row pk-skeleton" />
        ))}
      </div>
    )
  }
  const pinned = tools.filter((t) => t.inManifest)
  const available = tools.filter((t) => !t.inManifest)
  const retryAt = tools.find((t) => t.latestRetryAt)?.latestRetryAt
  const lspUnpinned = !!lsp && !lsp.inManifest && lsp.onPath

  let lspBanner: ReactNode = null
  if (lsp && lspMissing) {
    lspBanner = (
      <div className="pk-callout bad">
        <div className="pk-callout-icon"><IconAlert size={18} /></div>
        <div className="pk-callout-main">
          <div className="pk-callout-title">luau-lsp is missing</div>
          <div className="pk-callout-sub">
            Forge’s editor needs it for diagnostics, completion, hover and go to definition.
            {lsp.inManifest ? ` rokit.toml pins ${lsp.version}, but it is not installed.` : ' It is not in rokit.toml.'}
          </div>
        </div>
        <button
          className="btn primary"
          disabled={!!busy}
          onClick={() =>
            void run(lsp.name, () => h.addRokitTool(lsp.repo, lsp.inManifest ? lsp.version : undefined), `Installed luau-lsp`)
          }
        >
          {busy === lsp.name ? <span className="spinner" /> : null}
          {lsp.inManifest ? 'Install' : `Add luau-lsp${lsp.latest ? ` ${lsp.latest}` : ''}`}
        </button>
      </div>
    )
  } else if (lspUnpinned && lsp) {
    lspBanner = (
      <div className="pk-callout warn">
        <div className="pk-callout-icon"><IconAlert size={18} /></div>
        <div className="pk-callout-main">
          <div className="pk-callout-title">luau-lsp is not in rokit.toml</div>
          <div className="pk-callout-sub">It works here from your PATH, but collaborators won’t get it from rokit install. Pin it so everyone’s editor matches.</div>
        </div>
        <button className="btn" disabled={!!busy} onClick={() => void run(lsp.name, () => h.addRokitTool(lsp.repo), 'Pinned luau-lsp in rokit.toml')}>
          {busy === lsp.name ? <span className="spinner" /> : null}
          Pin {lsp.latest ?? ''}
        </button>
      </div>
    )
  }

  return (
    <>
      {lspBanner}
      {rowErrors[lsp?.name ?? ''] && <p className="pk-inline-error">{rowErrors[lsp?.name ?? '']}</p>}
      {retryAt && (
        <p className="muted small" role="note">
          GitHub rate limited: latest versions unknown, retry at {new Date(retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
        </p>
      )}

      <section className="section">
        <div className="section-head">
          <h3>In rokit.toml</h3>
          <span className="count">{pinned.length}</span>
          <span className="pk-head-fill" />
          {installing && (
            <span className="muted small pk-installing-inline">
              <span className="spinner" /> rokit install
            </span>
          )}
        </div>
        {pinned.length === 0 ? (
          <p className="muted small">No rokit.toml tools. Add the ones this project needs below.</p>
        ) : (
          <div className="pk-list">
            {pinned.map((t) => (
              <div key={t.name} className={`pk-row${t.installed ? '' : ' not-installed'}`}>
                <div className="pk-row-main">
                  <div className="pk-title-line">
                    <span className="pk-alias">{t.name}</span>
                    <span className="pk-scope mono">{t.repo}</span>
                  </div>
                  {rowErrors[t.name] && <div className="pk-inline-error">{rowErrors[t.name]}</div>}
                </div>
                <span className="pk-version" title={t.version}>{shortVersion(t.version)}</span>
                <span className="pk-state">
                  {t.installed ? (
                    <span className="pk-ok" title="Installed by Rokit">
                      <IconCheck size={13} />
                    </span>
                  ) : (
                    <button
                      className="pk-badge warn as-btn"
                      disabled={!!busy}
                      title="Not in Rokit’s tool storage. Click to run rokit install."
                      onClick={() => void run(t.name, () => h.addRokitTool(t.repo, t.version), `Installed ${t.name}`)}
                    >
                      {busy === t.name ? <span className="spinner" /> : null}
                      Not installed
                    </button>
                  )}
                </span>
                <span className="pk-row-actions">
                  {t.updateAvailable && t.latest && (
                    <button className="pk-update" disabled={!!busy} onClick={() => void run(t.name, () => h.updateRokitTool(t.name), `Updated ${t.name} to ${t.latest}`)} title={`Update to ${t.latest}`}>
                      {busy === t.name ? <span className="spinner" /> : <IconUp />}
                      {shortVersion(t.latest)}
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h3>Add a tool</h3>
          <span className="muted small">Common Roblox tooling, installed with Rokit</span>
        </div>
        <div className="pk-list">
          {available.map((t) => (
            <div key={t.repo} className="pk-row pk-tool-row">
              <span className="pk-tool-icon"><IconTool size={15} /></span>
              <div className="pk-row-main">
                <div className="pk-title-line">
                  <span className="pk-alias">{t.name}</span>
                  <span className="pk-scope mono">{t.repo}</span>
                </div>
                <div className="pk-desc">{t.description}</div>
                {rowErrors[t.name] && <div className="pk-inline-error">{rowErrors[t.name]}</div>}
              </div>
              <span className="pk-version" title={t.latest}>{shortVersion(t.latest)}</span>
              <span className="pk-row-actions">
                <button className="btn small" disabled={!!busy} onClick={() => void run(t.name, () => h.addRokitTool(t.repo), `Added ${t.name}${t.latest ? ` ${t.latest}` : ''}`)}>
                  {busy === t.name ? <span className="spinner" /> : null}
                  Add
                </button>
              </span>
            </div>
          ))}
          {available.length === 0 && <p className="muted small">Every common tool is already in rokit.toml.</p>}
        </div>
        <form
          className="row-form pk-custom"
          onSubmit={(e) => {
            e.preventDefault()
            const repo = custom.trim()
            if (!repo) return
            void run('custom', () => h.addRokitTool(repo), `Added ${repo}`).then((ok) => ok && setCustom(''))
          }}
        >
          <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Any GitHub tool: owner/repo or owner/repo@1.2.3" spellCheck={false} />
          <button className="btn" disabled={!custom.trim() || !!busy}>
            {busy === 'custom' ? <span className="spinner" /> : null}
            Add tool
          </button>
        </form>
        {rowErrors.custom && <p className="pk-inline-error">{rowErrors.custom}</p>}
      </section>
    </>
  )
}
