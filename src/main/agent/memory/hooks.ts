// What the agent layer (agent/index.ts) needs from the memory service, kept narrow so the agent
// layer and its tests do not depend on the whole service.

import type { TranscriptMessage } from './reflection.ts'
import type { OneShot } from './service.ts'

export interface MemoryHooks {
  // Appended after the project rules block (after the stable, cacheable prefix).
  promptBlock(): Promise<string>
  onChatIdle(sessionId: string, messages: () => TranscriptMessage[] | null): void
  onChatBusy(sessionId: string): void
  setModel(oneShot: OneShot | null): void
}

// Composes the project-rules loader with the memory block: base prompt + rules + memory.
export function withMemoryLoader(rules: () => Promise<string>, memory?: Pick<MemoryHooks, 'promptBlock'>): () => Promise<string> {
  if (!memory) return rules
  return async () => {
    const [r, m] = await Promise.all([rules().catch(() => ''), memory.promptBlock().catch(() => '')])
    return r + m
  }
}
