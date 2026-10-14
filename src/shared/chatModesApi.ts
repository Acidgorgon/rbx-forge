// IPC types for chat modes and slash commands (main/agent/modes.ts, main/agent/commands).
// HarnessApi extends ChatModesApi.

import type { ChatCommandInfo, ChatCommandResult } from './chatCommands.ts'
import type { ChatMode, RewindWhat, RunMode } from './chatModes.ts'
import type { ChatSession } from './types.ts'

export type * from './chatModes.ts'
export type { ChatCommandInfo, ChatCommandResult, CommandAction } from './chatCommands.ts'

export interface ChatModesApi {
  // The chat's mode (persists per chat); applies from the next message.
  setChatMode(sessionId: string, mode: ChatMode): Promise<ChatSession>
  // sendChat in a given mode for this one message (/ask, /plan), the chat's mode unchanged.
  sendChatMode(sessionId: string, text: string, mode: ChatMode, imageIds?: string[]): Promise<void>
  // Answer to a diff card: accept (all, or the listed hunk ids) or reject.
  reviewChatEdit(sessionId: string, messageId: string, decision: { accept: boolean; hunks?: number[]; note?: string }): Promise<void>
  // Plan card: approve (runs it in runMode, optionally with the edited text), keep planning, or
  // save an edit of the plan.
  planCardAction(sessionId: string, messageId: string, action: 'approve' | 'keep' | 'edit', opts?: { runMode?: RunMode; text?: string }): Promise<void>
  // Slash commands: built-ins + custom (.forge/commands, user commands folder).
  listChatCommands(): Promise<ChatCommandInfo[]>
  runChatCommand(sessionId: string, name: string, args?: string): Promise<ChatCommandResult>
  // /rewind: the chat's checkpoints and restoring one (files, conversation or both).
  rewindChat(sessionId: string, checkpointId: string, what?: RewindWhat): Promise<{ files: string[]; removed: number }>
}
