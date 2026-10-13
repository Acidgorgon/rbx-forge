// Chat additions: reasoning effort per chat, image attachments, group chats created up front.
// HarnessApi extends ChatExtrasApi (types.ts).

import type { EffortChoice, ImageMime } from './modelCaps.ts'
import type { ChatSession, ModelChoice } from './types.ts'

export type { EffortChoice, EffortLevel, ImageMime, ModelMeta } from './modelCaps.ts'

// An image attached to a chat message. Only this reference is stored in the chat history; the
// bytes live under userData/chat-images/<id>.<ext> (main/agent/chatImages.ts).
export interface ChatImage {
  id: string
  mime: ImageMime
  name?: string
  width?: number
  height?: number
  bytes?: number
}

// Adds an image to the chat image store: a data: URL (paste, drop, the attach button, after
// client-side downscaling) or an absolute file path (generated art, "Send to chat").
export interface ChatImageInput {
  dataUrl?: string
  path?: string
  name?: string
}

export interface NewChatOptions {
  effort?: EffortChoice
  // Group chat created up front: these models join as guests.
  guests?: ModelChoice[]
  title?: string
}

export interface ChatExtrasApi {
  // Per-chat reasoning effort ('auto' lets the router decide).
  setChatEffort(sessionId: string, effort: EffortChoice): Promise<ChatSession>
  // Default effort for new chats (Settings).
  getDefaultEffort(): Promise<EffortChoice>
  setDefaultEffort(effort: EffortChoice): Promise<void>
  addChatImage(input: ChatImageInput): Promise<ChatImage>
  // data: URL of a stored image (thumbnails, the viewer).
  getChatImage(id: string): Promise<string>
}
