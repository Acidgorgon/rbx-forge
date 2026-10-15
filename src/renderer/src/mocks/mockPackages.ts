// Browser-preview mock of the Packages part of HarnessApi (wally.toml deps, Wally search, Rokit
// tools). mock.ts spreads it into its api object. Data mirrors the GenTree template's wally.toml
// and rokit.toml; registry versions are sample values.
import type { HarnessApi, HarnessEvents, RokitTool, WallyAddSpec, WallyDependency, WallyPackage, WallyRealm } from '@shared/types'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

const catalog: WallyPackage[] = [
  pkg('sleitnick', 'signal', 'Signal class', ['2.0.3', '2.0.2', '2.0.1', '2.0.0', '1.5.0', '1.4.2']),
  pkg('sleitnick', 'trove', 'Trove class for tracking and cleaning up objects', ['1.8.0', '1.7.0', '1.6.0', '1.5.1']),
  pkg('sleitnick', 'comm', 'Comm library for remote communication', ['1.0.1', '1.0.0', '0.3.2']),
  pkg('sleitnick', 'promise', 'Promise implementation for Roblox', ['4.0.0', '3.2.1']),
  pkg('stravant', 'goodsignal', "A fast Signal class implementation that has full feature parity with Roblox' RBXScriptSignal.", ['0.3.1', '0.2.1']),
  pkg('sunspringdev', 'signal', 'Signal class', ['2.0.3']),
  pkg('ptekspy', 'signal', 'Signal', ['1.1.1']),
  pkg('asetasar', 'signalplus', undefined, ['3.7.1', '3.7.0']),
  pkg('centau', 'vide', 'A reactive Luau library for creating UI.', ['0.4.2', '0.4.1', '0.4.0', '0.3.1', '0.3.0']),
  pkg('littensy', 'charm', 'An atomic state management library for Roblox', ['0.11.0', '0.10.0', '0.9.2', '0.9.1']),
  pkg('littensy', 'vide-charm', 'Vide bindings for Charm', ['0.3.0', '0.2.0']),
  pkg('littensy', 'charm-sync', 'Sync Charm atoms between the server and clients', ['0.3.0', '0.2.1']),
  pkg('howmanysmall', 'janitor', 'Janitor library.', ['1.18.3', '1.18.2', '1.17.0', '1.16.0']),
  pkg('ukendio', 'jecs', 'A fast, portable Entity Component System for Luau', ['0.11.0', '0.10.3', '0.9.0']),
  pkg('csqrl', 'sift', 'Immutable data library for Luau', ['0.0.11', '0.0.10']),
  pkg('solarhorizon', 'immut', 'Draft-based immutable data updates', ['0.4.4', '0.4.3']),
  pkg('1foreverhd', 'topbarplus', 'Construct dynamic and intuitive topbar icons.', ['3.4.0', '3.3.0']),
  pkg('pepeeltoro41', 'ui-labs', 'Storybook plugin utilities for UI Labs', ['2.4.2', '2.4.1', '2.4.0']),
  pkg('alicesaidhi', 'conch', 'An in-game console for Roblox', ['0.3.1', '0.3.0']),
  pkg('alicesaidhi', 'conch-ui', 'Default UI for Conch', ['0.3.1', '0.3.0']),
  pkg('arxkdev', 'beziertween', 'Tween along bezier curves', ['0.0.3']),
  pkg('leifstout', 'dataservice', 'Player data service built on ProfileStore', ['1.0.0'], 'server'),
  pkg('leifstout', 'profilestore', 'Session-locked player data stores', ['1.0.3', '1.0.2'], 'server'),
  pkg('evaera', 'promise', 'Promise implementation for Roblox', ['4.0.0', '3.2.1']),
  pkg('red-blox', 'zap', 'Zap networking runtime', ['0.6.29']),
  pkg('jsdotlua', 'jest', 'Delightful Luau testing', ['3.10.0', '3.9.1'])
]

function pkg(scope: string, name: string, description: string | undefined, versions: string[], realm: 'shared' | 'server' = 'shared'): WallyPackage {
  const p: WallyPackage = { scope, name, latest: versions[0], versions, realm }
  if (description) p.description = description
  return p
}

const sections: Record<WallyRealm, string> = { shared: 'dependencies', server: 'server-dependencies', dev: 'dev-dependencies' }

// [alias, scope/name, requirement, realm, locked version]
let deps: WallyDependency[] = (
  [
    ['Signal', 'sleitnick/signal', '2.0.3', 'shared', '2.0.3'],
    ['Conchui', 'alicesaidhi/conch-ui', '0.3.0', 'shared', '0.3.1'],
    ['Conch', 'alicesaidhi/conch', '0.3.0', 'shared', '0.3.1'],
    ['Beziertween', 'arxkdev/beziertween', '0.0.3', 'shared', '0.0.3'],
    ['Vide', 'centau/vide', '0.4.1', 'shared', '0.4.1'],
    ['Charm', 'littensy/charm', '0.10.0', 'shared', '0.10.0'],
    ['Videcharm', 'littensy/vide-charm', '0.3.0', 'shared', '0.3.0'],
    ['Charmsync', 'littensy/charm-sync', '0.3.0', 'shared', '0.3.0'],
    ['Uilabs', 'pepeeltoro41/ui-labs', '2.4.1', 'shared', '2.4.2'],
    ['Janitor', 'howmanysmall/janitor', '1.18.3', 'shared', '1.18.3'],
    ['Immut', 'solarhorizon/immut', '0.4.4', 'shared', '0.4.4'],
    ['Sift', 'csqrl/sift', '0.0.11', 'shared', '0.0.11'],
    ['Topbarplus', '1foreverhd/topbarplus', '3.4.0', 'shared', '3.4.0'],
    ['Jecs', 'ukendio/jecs', '0.11.0', 'shared', '0.11.0'],
    ['Dataservice', 'leifstout/dataservice', '1.0.0', 'shared', '1.0.0']
  ] as const
).map(([alias, id, version, realm, locked]) => describeDep(alias, id, version, realm, locked))

function describeDep(alias: string, id: string, version: string, realm: WallyRealm, locked?: string): WallyDependency {
  const [scope, name] = id.split('/')
  const latest = catalog.find((p) => p.scope === scope && p.name === name)?.latest
  const have = locked ?? version.replace(/^[=^~]/, '')
  return {
    alias,
    scope,
    name,
    version,
    realm,
    installed: !!locked,
    installedVersion: locked,
    latest,
    updateAvailable: !!latest && cmp(latest, have) > 0
  }
}

function cmp(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map(Number)
  const pb = b.split(/[.+-]/).map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  return 0
}

const curatedList: { name: string; repo: string; description: string; latest: string }[] = [
  { name: 'luau-lsp', repo: 'JohnnyMorganz/luau-lsp', description: 'Luau language server. Forge’s editor uses it for diagnostics, completion and hover.', latest: '1.70.1' },
  { name: 'rojo', repo: 'rojo-rbx/rojo', description: 'Syncs the repo into Studio and builds places.', latest: '7.7.1' },
  { name: 'wally', repo: 'UpliftGames/wally', description: 'Package manager for Roblox (wally.toml).', latest: '0.3.2' },
  { name: 'stylua', repo: 'JohnnyMorganz/StyLua', description: 'Opinionated Luau code formatter.', latest: '2.6.0' },
  { name: 'selene', repo: 'Kampfkarren/selene', description: 'Fast Luau linter (selene.toml).', latest: '0.32.0' },
  { name: 'blink', repo: '1Axen/blink', description: 'Networking IDL compiler (events.blink).', latest: '0.18.9' },
  { name: 'zap', repo: 'red-blox/zap', description: 'Alternative networking IDL compiler.', latest: '0.6.29' },
  { name: 'lune', repo: 'lune-org/lune', description: 'Standalone Luau runtime for scripts and tooling.', latest: '0.11.0' },
  { name: 'darklua', repo: 'seaofvoices/darklua', description: 'Transforms and bundles Luau code.', latest: '0.19.0' },
  { name: 'pesde', repo: 'pesde-pkg/pesde', description: 'Newer package manager for Luau.', latest: '0.7.4+registry.0.2.3' }
]

// rokit.toml of the template: rojo, wally, blink. luau-lsp is not pinned (works from PATH here).
let tools: RokitTool[] = [
  tool('rojo', 'rojo-rbx/rojo', '7.7.0'),
  tool('wally', 'UpliftGames/wally', '0.3.2'),
  tool('blink', '1Axen/blink', '0.18.1')
]

function tool(name: string, repo: string, version: string): RokitTool {
  const c = curatedList.find((t) => t.repo === repo)
  return {
    name,
    repo,
    version,
    inManifest: true,
    installed: true,
    onPath: true,
    description: c?.description,
    latest: c?.latest,
    updateAvailable: !!c && cmp(c.latest, version) > 0
  }
}

function curated(): RokitTool[] {
  return curatedList.map((c) => {
    const t = tools.find((x) => x.repo === c.repo)
    if (t) return t
    return {
      name: c.name,
      repo: c.repo,
      version: '',
      inManifest: false,
      installed: false,
      onPath: c.name === 'luau-lsp',
      description: c.description,
      latest: c.latest,
      updateAvailable: false
    }
  })
}

export function packagesMock(emit: Emit, log: (text: string) => void): Pick<
  HarnessApi,
  | 'searchWally'
  | 'wallyPackage'
  | 'listWallyDeps'
  | 'addWallyDep'
  | 'removeWallyDep'
  | 'updateWallyDep'
  | 'listRokitTools'
  | 'addRokitTool'
  | 'updateRokitTool'
  | 'curatedTools'
> {
  const install = (alias: string) => {
    emit('packages:changed', { installing: 'wally', wally: deps.slice() })
    log('wally.toml changed; the dev loop will run wally install')
    setTimeout(() => {
      log('wally install')
      deps = deps.map((d) => (d.alias === alias ? { ...d, installed: true, installedVersion: d.version.replace(/^[=^~]/, '') } : d))
      emit('packages:changed', { installing: null, wally: deps.slice(), tools: tools.slice() })
    }, 1600)
  }
  return {
    async searchWally(query) {
      await delay(260)
      const q = query.trim().toLowerCase()
      if (!q) return []
      return catalog
        .filter((p) => `${p.scope}/${p.name} ${p.description ?? ''}`.toLowerCase().includes(q))
        .sort((a, b) => Number(b.name === q) - Number(a.name === q))
    },
    async wallyPackage(id) {
      const p = catalog.find((x) => `${x.scope}/${x.name}` === id)
      if (!p) throw new Error(`${id} is not on the Wally registry.`)
      return p
    },
    async listWallyDeps() {
      await delay(120)
      return deps.slice()
    },
    async addWallyDep(spec: WallyAddSpec) {
      await delay(200)
      const alias = spec.alias || spec.name.replace(/[^a-z0-9]/gi, '').replace(/^./, (c) => c.toUpperCase())
      const clash = deps.find((d) => d.alias.toLowerCase() === alias.toLowerCase())
      if (clash && (clash.scope !== spec.scope || clash.name !== spec.name)) {
        throw new Error(`The alias ${clash.alias} is already used by ${clash.scope}/${clash.name} in [${sections[clash.realm]}]. Pick another alias.`)
      }
      if (clash) deps = deps.map((d) => (d === clash ? { ...describeDep(alias, `${spec.scope}/${spec.name}`, spec.version, spec.realm), installed: true } : d))
      else deps = [...deps, describeDep(alias, `${spec.scope}/${spec.name}`, spec.version, spec.realm)]
      install(alias)
      return deps.slice()
    },
    async removeWallyDep(alias, realm) {
      await delay(150)
      deps = deps.filter((d) => !(d.alias === alias && d.realm === realm))
      emit('packages:changed', { installing: 'wally' })
      setTimeout(() => emit('packages:changed', { installing: null, wally: deps.slice() }), 900)
      return deps.slice()
    },
    async updateWallyDep(alias, realm, version) {
      const d = deps.find((x) => x.alias === alias && x.realm === realm)
      if (!d) throw new Error(`${alias} is not in [${sections[realm]}].`)
      return this.addWallyDep({ scope: d.scope, name: d.name, realm, alias, version: version || d.latest || d.version })
    },
    async listRokitTools() {
      await delay(150)
      return tools.slice()
    },
    async addRokitTool(repo, version) {
      await delay(900)
      const c = curatedList.find((t) => t.repo.toLowerCase() === repo.toLowerCase())
      const name = c?.name ?? repo.split('/')[1].toLowerCase()
      tools = [...tools, tool(name, c?.repo ?? repo, version || c?.latest || '1.0.0')]
      log(`rokit add ${repo}@${version || c?.latest}`)
      emit('packages:changed', { installing: null, tools: tools.slice() })
      return tools.slice()
    },
    async updateRokitTool(name) {
      await delay(900)
      tools = tools.map((t) => (t.name === name && t.latest ? tool(t.name, t.repo, t.latest) : t))
      emit('packages:changed', { installing: null, tools: tools.slice() })
      return tools.slice()
    },
    async curatedTools() {
      await delay(200)
      return curated()
    }
  }
}
