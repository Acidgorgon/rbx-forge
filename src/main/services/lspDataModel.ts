// Live Studio DataModel for luau-lsp.
//
// luau-lsp's VS Code extension runs an HTTP server for the luau-lsp Studio companion plugin
// and forwards what the plugin posts to the server as custom notifications (verified against
// luau-lsp 1.70.1, editors/code/src/roblox.ts startPluginServer and
// src/platform/roblox/RobloxStudioPlugin.cpp):
//
//   POST /full  { tree }  ->  client.sendNotification("$/plugin/full", req.body.tree)
//   POST /clear           ->  client.sendNotification("$/plugin/clear")
//
// The tree is the plugin's EncodedInstance (plugin/src/types.luau), rooted at `game`:
//   { Name: string, ClassName: string, FilePaths: string[], Children: EncodedInstance[] }
// The server parses it with PluginNode::fromJson (Name and ClassName required, FilePaths and
// Children optional) and merges it into the sourcemap by name: existing sourcemap nodes are
// kept, unknown children are added as "plugin managed" nodes (and pruned again when a later
// $/plugin/full no longer has them, or on $/plugin/clear). The sourcemap root must be a
// DataModel; without a sourcemap the server creates one. Nothing is written to disk while
// luau-lsp.sourcemap.autogenerate is false, which is what the renderer client sends.
//
// RBX Forge already has the live Studio snapshot (.studio-sync/tree.json, written by
// tools/studio-sync.py) merged with the Rojo tree (project.ts mergeStudioTree). This module
// turns that merged tree into the plugin payload, so Studio-only instances
// (game.Workspace.Map.Spawn, ReplicatedStorage.Assets...) autocomplete and type check.
// FilePaths are left out on purpose: sourcemap.json (rojo sourcemap --watch) owns the
// script <-> file mapping, and a plugin node with FilePaths would overwrite the sourcemap's.
//
// The real companion plugin can post too (lspCompanion.ts serves its HTTP endpoints). Its tree
// comes straight from Studio and wins while it is connected: setPluginTree() replaces Forge's
// own payload, clearPluginTree() sends $/plugin/clear and goes back to Forge's snapshot. Its
// FilePaths are passed through unchanged, as the VS Code extension does.

import type { TreeNode } from '@shared/types'

export interface PluginNode {
  Name: string
  ClassName: string
  Children: PluginNode[]
}

// Upper bound on nodes sent; the VS Code extension caps the request body at 3mb by default
// (luau-lsp.studioPlugin.maximumRequestBodySize). ~60 bytes a node keeps us well under that.
export const MAX_DATAMODEL_NODES = 40_000

// Wally/pesde package internals (Packages/_Index, ServerPackages/_Index, ...). The folder itself
// is sent, its contents are not: plugin nodes have no FilePaths, so luau-lsp can neither type
// them nor match them against completion.imports.ignoreGlobs, and every one became an
// auto-import suggestion (`011_preregistering_component (…Packages._Index["…"])`) while making
// each completion request walk thousands of extra nodes. File-backed copies from sourcemap.json
// are unaffected (the server keeps sourcemap nodes), and code requires the top-level
// Packages.X re-exports anyway.
export const PRUNED_CHILDREN = new Set(['_Index'])

// Merged tree nodes may carry origin/props/filePath; only name and class matter here.
type Node = Pick<TreeNode, 'name' | 'className'> & { origin?: TreeNode['origin']; children?: Node[] }

// Forge tree (top level = services) -> plugin payload rooted at game. Breadth-first so that a
// tree over the cap keeps every service and the shallow levels rather than one deep branch.
export function toPluginDataModel(tree: Node[] | null | undefined, maxNodes = MAX_DATAMODEL_NODES): { root: PluginNode; count: number; truncated: boolean } {
  const root: PluginNode = { Name: 'game', ClassName: 'DataModel', Children: [] }
  let count = 0
  let truncated = false
  const queue: [Node[], PluginNode][] = [[tree ?? [], root]]
  for (let i = 0; i < queue.length; i++) {
    const [nodes, parent] = queue[i]
    for (const node of nodes) {
      if (!node || typeof node.name !== 'string' || typeof node.className !== 'string' || !node.className) continue
      if (count >= maxNodes) {
        truncated = true
        break
      }
      const out: PluginNode = { Name: node.name, ClassName: node.className, Children: [] }
      parent.Children.push(out)
      count++
      if (Array.isArray(node.children) && node.children.length && !PRUNED_CHILDREN.has(node.name)) queue.push([node.children, out])
    }
  }
  return { root, count, truncated }
}

// True when the tree has anything from the live Studio snapshot.
export function hasStudioNodes(tree: Node[] | null | undefined): boolean {
  const stack = [...(tree ?? [])]
  while (stack.length) {
    const node = stack.pop()!
    if (node.origin === 'studio' || node.origin === 'both') return true
    if (node.children) stack.push(...node.children)
  }
  return false
}

export interface DataModelSyncOptions {
  // Sends one JSON-RPC notification to the server.
  notify: (method: string, params?: unknown) => void
  log?: (text: string) => void
  debounceMs?: number
  maxNodes?: number
  // Re-send when the server says it dropped the notification (no workspace set up yet).
  retryMs?: number
  maxRetries?: number
}

// Decides when to send $/plugin/full and $/plugin/clear to one server process.
//
// luau-lsp only handles $/plugin/* once a workspace platform exists, which is set up lazily
// after the client answered workspace/configuration and a document was opened (Workspace.cpp
// lazyInitialize/setupWithConfiguration; the notification is not postponed like
// textDocument/* ones). Until then the server logs "unknown notification method: $/plugin/full"
// and drops it. So the sync waits for `ready()` (bridge: initialized + configuration answered +
// first didOpen), and also re-sends when it sees that log line.
export class DataModelSync {
  private options: DataModelSyncOptions
  private tree: Node[] | null = null
  private isReady = false
  private lastSent: string | null = null // JSON of the last payload, or 'clear'
  // The companion plugin's last /full tree (JSON), forwarded as is; null when none.
  private pluginTree: string | null = null
  // Logged the first plugin tree sent to this process (later updates come every few seconds).
  private pluginLogged = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private retries = 0

  constructor(options: DataModelSyncOptions) {
    this.options = options
  }

  // New merged tree from the project (null: no project / snapshot).
  setTree(tree: Node[] | null): void {
    this.tree = tree
    this.schedule()
  }

  // The Studio companion plugin posted its tree (/full). Sent at once when the server is ready
  // (the plugin debounces its own updates), else as soon as it is; kept for restarted servers.
  setPluginTree(tree: unknown): void {
    this.pluginTree = JSON.stringify(tree)
    if (!this.isReady) return
    this.cancel()
    this.flush()
  }

  // The plugin posted /clear: $/plugin/clear now (as the VS Code extension does), then Forge's
  // own snapshot again if it has one.
  clearPluginTree(): void {
    const had = this.pluginTree !== null
    this.pluginTree = null
    this.pluginLogged = false
    if (!this.isReady) return
    this.cancel()
    this.lastSent = 'clear'
    this.options.notify('$/plugin/clear')
    if (had) this.options.log?.('luau-lsp: the Studio plugin cleared its DataModel')
    this.flush()
  }

  get hasPluginTree(): boolean {
    return this.pluginTree !== null
  }

  // The server can take $/plugin/* now.
  ready(): void {
    if (this.isReady) return
    this.isReady = true
    this.schedule(0)
  }

  // A new server process: nothing was sent to it yet.
  reset(): void {
    this.isReady = false
    this.lastSent = null
    this.retries = 0
    this.pluginLogged = false
    this.cancel()
  }

  // Looks at server -> client traffic for the server's own acknowledgement or refusal.
  observe(message: unknown): void {
    const m = message as { method?: string; params?: { message?: unknown } }
    if (m?.method !== 'window/logMessage' || typeof m.params?.message !== 'string') return
    const text = m.params.message
    if (text.includes('unknown notification method: $/plugin/')) {
      // Dropped: try again shortly.
      if (this.lastSent === null || this.retries >= (this.options.maxRetries ?? 8)) return
      this.retries++
      this.lastSent = null
      this.schedule(this.options.retryMs ?? 1500)
    } else if (text.includes('received full change from studio plugin')) {
      this.retries = 0
    }
  }

  dispose(): void {
    this.cancel()
    this.tree = null
    this.pluginTree = null
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(delay = this.options.debounceMs ?? 500): void {
    if (!this.isReady) return
    this.cancel()
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, delay)
    this.timer.unref?.()
  }

  // Sends now if anything changed since the last send to this process.
  flush(): void {
    if (!this.isReady) return
    if (this.pluginTree !== null) {
      if (this.pluginTree === this.lastSent) return
      this.lastSent = this.pluginTree
      this.options.notify('$/plugin/full', JSON.parse(this.pluginTree))
      if (!this.pluginLogged) this.options.log?.(`luau-lsp: sent the Studio plugin's DataModel (${Math.max(1, Math.round(this.pluginTree.length / 1024))} KB); updates follow as Studio changes`)
      this.pluginLogged = true
      return
    }
    if (!hasStudioNodes(this.tree)) {
      // No Studio snapshot (any more): drop plugin-managed nodes if we added some.
      if (this.lastSent !== null && this.lastSent !== 'clear') {
        this.lastSent = 'clear'
        this.options.notify('$/plugin/clear')
        this.options.log?.('luau-lsp: cleared the Studio DataModel')
      }
      return
    }
    const { root, count, truncated } = toPluginDataModel(this.tree, this.options.maxNodes)
    const json = JSON.stringify(root)
    if (json === this.lastSent) return
    this.lastSent = json
    this.options.notify('$/plugin/full', root)
    this.options.log?.(`luau-lsp: sent the Studio DataModel (${count} instances${truncated ? ', truncated' : ''})`)
  }
}
