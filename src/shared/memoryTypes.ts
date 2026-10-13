// IPC types for the adaptive memory + skills layer (main/agent/memory). Type-only re-exports of the
// service's own plain-data types; HarnessApi / HarnessEvents extend the interfaces below.

export type {
  MemoryScope,
  MemoryType,
  MemoryKind,
  MemoryEntry,
  MemoryInput,
  SaveResult as MemorySaveResult,
  ReflectionMode,
  MemorySettings,
  MemoryProposal,
  MemoryFeedItem,
  MemoryListing,
  StyleProfile
} from '../main/agent/memory/types.ts'
import type { MemoryEntry, MemoryFeedItem, MemoryInput, MemoryKind, MemoryListing, MemoryProposal, MemoryScope, MemorySettings, SaveResult, StyleProfile } from '../main/agent/memory/types.ts'

export interface MemoryApi {
  memoryList(): Promise<MemoryListing>
  // BM25-ranked over name, description and body; empty query = everything.
  memorySearch(query: string): Promise<MemoryEntry[]>
  // Create or edit (rename / move scope by passing previous).
  memorySave(input: MemoryInput, previous?: { scope: MemoryScope; kind: MemoryKind; name: string }): Promise<SaveResult>
  memoryDelete(scope: MemoryScope, kind: MemoryKind, name: string): Promise<boolean>
  memoryPin(scope: MemoryScope, kind: MemoryKind, name: string, pinned: boolean): Promise<void>
  // user -> project (shared with the team).
  memoryPromote(kind: MemoryKind, name: string): Promise<SaveResult>
  memoryFeed(): Promise<MemoryFeedItem[]>
  memoryGetSettings(): Promise<MemorySettings>
  memorySetSettings(patch: Partial<MemorySettings>): Promise<MemorySettings>
  memoryProposals(sessionId?: string): Promise<MemoryProposal[]>
  memoryAcceptProposal(id: string, edited?: MemoryInput): Promise<SaveResult>
  memoryDismissProposal(id: string): Promise<void>
  memoryAnalyzeStyle(): Promise<{ profile: StyleProfile; result: SaveResult | null }>
}

export interface MemoryEvents {
  // A memory or skill was saved, edited, removed, pinned or promoted.
  'memory:changed': { at: number }
  // Reflection proposals for a chat changed (new ones, or one accepted/dismissed).
  'memory:proposals': { sessionId: string; proposals: MemoryProposal[] }
}
