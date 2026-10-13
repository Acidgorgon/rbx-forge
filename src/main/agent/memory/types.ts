// Plain-data types of the memory + skills layer. Re-exported to the renderer through
// src/shared/memoryTypes.ts (type-only), so IPC results are returned as is.

// Where a memory lives: 'user' follows the person across projects (userData/memory), 'project' is
// committed with the game (.forge/memory) so teammates share it.
export type MemoryScope = 'user' | 'project'
// What a memory is about (same taxonomy as Claude Code's auto memory):
//   user       the person: coding style, naming, preferred models, how they like answers
//   project    the game: conventions, decisions, architecture facts
//   feedback   a correction the person gave ("don't X, do Y")
//   reference  a pointer: where something is documented, an asset id, a URL
export type MemoryType = 'user' | 'project' | 'feedback' | 'reference'
export type MemoryKind = 'memory' | 'skill'

export interface MemoryEntry {
  // `${scope}:${kind}:${name}`
  id: string
  scope: MemoryScope
  kind: MemoryKind
  // kebab-case slug, unique per scope + kind; also the file name.
  name: string
  // One line: what it is (memories) or when to use it (skills). This is all a prompt sees.
  description: string
  // Memories only (skills are procedures).
  type?: MemoryType
  body: string
  created: number
  // Last content change (frontmatter `updated`; falls back to created for older files).
  updated?: number
  lastUsed: number
  uses: number
  pinned?: boolean
  // Repo-relative (project) or userData-relative (user) path of the file.
  file: string
}

export interface MemoryInput {
  scope: MemoryScope
  kind?: MemoryKind
  type?: MemoryType
  name: string
  description: string
  body: string
}

export interface SaveResult {
  entry: MemoryEntry
  // created: new file; updated: same name; merged: a near-duplicate was updated instead.
  action: 'created' | 'updated' | 'merged'
  // The near-duplicate that was merged into (when action is 'merged').
  mergedFrom?: string
}

export type ReflectionMode = 'ask' | 'auto' | 'off'

export interface MemorySettings {
  // Background reflection after a chat: ask = proposals card, auto = save, off = never.
  reflection: ReflectionMode
  // Analyze the project's Luau style when a project opens (only when no profile exists yet).
  styleOnOpen: boolean
}

// A reflection proposal: a memory or skill the cheap model suggests saving.
export interface MemoryProposal {
  id: string
  sessionId: string
  createdAt: number
  input: MemoryInput
  // Why the model proposes it (one line).
  reason?: string
}

export interface MemoryFeedItem {
  at: number
  action: 'saved' | 'updated' | 'merged' | 'forgot' | 'skill' | 'style' | 'promoted' | 'proposed' | 'dismissed'
  scope: MemoryScope
  kind: MemoryKind
  name: string
  description?: string
  // Who learned it: an agent tool call, reflection, the style analyzer or the person (UI).
  source: 'agent' | 'reflection' | 'style' | 'user'
}

export interface MemoryListing {
  user: MemoryEntry[]
  project: MemoryEntry[]
  // null when no project is open.
  projectRoot: string | null
}

export interface StyleProfile {
  files: number
  lines: number
  indent: { style: 'tabs' | 'spaces' | 'mixed' | 'unknown'; width?: number }
  strictMode: number // share of files starting with --!strict (0..1)
  naming: { locals: string; functions: string; constants: string; modules: string }
  modules: string[]
  comments: string[]
  vide: string[]
  // Markdown body saved as the project memory.
  body: string
}
