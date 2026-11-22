// IPC handlers for the Memory page and the chat proposals card (MemoryApi in shared/memoryTypes.ts).
// main/index.ts registers them with INVOKE_PREFIX like the other handler maps.

import { inspectHarnessGuide, syncHarnessGuide, type HarnessGuideOptions } from '../harnessGuide.ts'
import { commitMarkdownImport, previewMarkdownImport, type MarkdownImportItem, type MarkdownImportRequest } from './claudeImport.ts'
import type { MemoryService } from './service.ts'
import type { MemoryInput, MemoryKind, MemoryScope, MemorySettings } from './types.ts'

const scope = (s: unknown): MemoryScope => (s === 'project' ? 'project' : 'user')
const kind = (k: unknown): MemoryKind => (k === 'skill' ? 'skill' : 'memory')

function input(v: unknown): MemoryInput {
  if (!v || typeof v !== 'object') throw new Error('invalid memory')
  const r = v as Record<string, unknown>
  return {
    scope: scope(r.scope),
    kind: kind(r.kind),
    ...(typeof r.type === 'string' ? { type: r.type as MemoryInput['type'] } : {}),
    name: String(r.name ?? ''),
    description: String(r.description ?? ''),
    body: String(r.body ?? '')
  }
}

export function memoryHandlers(memory: MemoryService): Record<string, (...args: any[]) => unknown> {
  return {
    memoryList: () => memory.list(),
    memorySearch: (q: unknown) => memory.search(String(q ?? '')),
    memorySave: (v: unknown, prev?: { scope?: unknown; kind?: unknown; name?: unknown }) =>
      memory.update(input(v), prev && typeof prev.name === 'string' ? { scope: scope(prev.scope), kind: kind(prev.kind), name: prev.name } : undefined),
    memoryDelete: (s: unknown, k: unknown, name: unknown) => memory.remove(scope(s), kind(k), String(name ?? '')),
    memoryPin: (s: unknown, k: unknown, name: unknown, pinned: unknown) => memory.pin(scope(s), kind(k), String(name ?? ''), pinned === true),
    memoryPromote: (k: unknown, name: unknown) => memory.promote(kind(k), String(name ?? '')),
    memoryFeed: () => memory.recentFeed(),
    memoryGetSettings: () => memory.settings(),
    memorySetSettings: (patch: unknown) => memory.setSettings(patch && typeof patch === 'object' ? (patch as Partial<MemorySettings>) : {}),
    memoryProposals: (sessionId?: unknown) => memory.pending(typeof sessionId === 'string' ? sessionId : undefined),
    memoryAcceptProposal: (id: unknown, edited?: unknown) => memory.accept(String(id ?? ''), edited ? input(edited) : undefined),
    memoryDismissProposal: (id: unknown) => memory.dismiss(String(id ?? '')),
    memoryAnalyzeStyle: () => memory.analyzeStyle(),
    memoryPreviewMarkdownImport: (req: unknown) => previewMarkdownImport((req && typeof req === 'object' ? req : { content: '' }) as MarkdownImportRequest),
    memoryCommitMarkdownImport: (s: unknown, items: unknown) => commitMarkdownImport(memory, scope(s), Array.isArray(items) ? (items as MarkdownImportItem[]) : []),
    memoryHarnessGuideStatus: () => inspectHarnessGuide(memory.projectRoot()),
    memorySyncHarnessGuide: (opts?: unknown) => {
      const root = memory.projectRoot()
      if (!root) throw new Error('Open a project first to write workspace instructions.')
      return syncHarnessGuide(root, opts && typeof opts === 'object' ? (opts as Partial<HarnessGuideOptions>) : undefined)
    }
  }
}

export const MEMORY_METHODS = [
  'memoryList', 'memorySearch', 'memorySave', 'memoryDelete', 'memoryPin', 'memoryPromote', 'memoryFeed',
  'memoryGetSettings', 'memorySetSettings', 'memoryProposals', 'memoryAcceptProposal', 'memoryDismissProposal', 'memoryAnalyzeStyle',
  'memoryPreviewMarkdownImport', 'memoryCommitMarkdownImport', 'memoryHarnessGuideStatus', 'memorySyncHarnessGuide'
] as const
