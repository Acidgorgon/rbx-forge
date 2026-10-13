// Chat sessions with the main harness agent.
// Sessions and their messages persist in the 'chats' setting; each chat remembers its SDK session id
// so follow-up messages resume the same conversation.

import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { CanUseTool, McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk'
import type { ChatMessage, ChatSession } from '@shared/types'
import type { HarnessContext } from '../context.ts'
import type { Credentials } from './credentials.ts'
import {
  allowServer,
  model,
  sdkQuery,
  studioMcp,
  STUDIO_SERVER,
  SYSTEM_PROMPT,
  systemMessage,
  toChatMessages,
  userMessage,
  type QueryFn
} from './sdk.ts'
import { createGentreeServer, SERVER_NAME } from './tools.ts'

const SETTING = 'chats'
const MAX_MESSAGES = 500
const MAX_CHATS = 100

interface StoredChat extends ChatSession {
  sdkSessionId?: string
  messages: ChatMessage[]
}

export interface ChatDeps {
  queryFn?: QueryFn
  credentials: Credentials
  // Builds the gentree MCP server for one query (tests can stub it).
  makeServer?: (ctx: HarnessContext) => McpServerConfig
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// Decides tool use for the chat agent: gentree/studio tools are pre-allowed via allowedTools;
// built-in edits only inside the project (never Packages/); Bash only with the allowBash setting.
export function chatPermissions(ctx: HarnessContext): CanUseTool {
  return async (toolName, input) => {
    const root = ctx.project()?.root
    if (!root) return { behavior: 'deny', message: 'no project open' }
    if (toolName === 'Bash') {
      return ctx.getSetting('allowBash', false)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Bash is disabled in the harness settings' }
    }
    const file = (input.file_path ?? input.notebook_path ?? input.path) as string | undefined
    if (EDIT_TOOLS.has(toolName) || ['Read', 'Glob', 'Grep'].includes(toolName)) {
      if (!file) return { behavior: 'allow', updatedInput: input }
      const abs = isAbsolute(file) ? file : resolve(root, file)
      const rel = relative(root, abs)
      if (rel.startsWith('..') || isAbsolute(rel)) return { behavior: 'deny', message: 'outside the project' }
      if (EDIT_TOOLS.has(toolName) && (rel === 'Packages' || rel.startsWith('Packages' + sep))) {
        return { behavior: 'deny', message: 'Packages/ is managed by Wally' }
      }
      return { behavior: 'allow', updatedInput: input }
    }
    return { behavior: 'deny', message: `${toolName} is not available in the harness` }
  }
}

export class ChatManager {
  private ctx: HarnessContext
  private deps: ChatDeps
  private chats: StoredChat[]
  private running = new Map<string, AbortController>()
  private saveTimer: NodeJS.Timeout | null = null

  constructor(ctx: HarnessContext, deps: ChatDeps) {
    this.ctx = ctx
    this.deps = deps
    const stored = ctx.getSetting<{ sessions?: StoredChat[] } | null>(SETTING, null)
    this.chats = Array.isArray(stored?.sessions) ? stored.sessions : []
  }

  list(): ChatSession[] {
    return this.chats.map(({ id, title, createdAt }) => ({ id, title, createdAt }))
  }

  create(): ChatSession {
    const chat: StoredChat = { id: randomUUID(), title: 'New chat', createdAt: Date.now(), messages: [] }
    this.chats.unshift(chat)
    if (this.chats.length > MAX_CHATS) this.chats.length = MAX_CHATS
    this.save()
    return { id: chat.id, title: chat.title, createdAt: chat.createdAt }
  }

  messages(id: string): ChatMessage[] | null {
    return this.find(id)?.messages ?? null
  }

  busy(id: string): boolean {
    return this.running.has(id)
  }

  // Starts a turn and returns once it is underway; progress arrives as chat:message events.
  async send(id: string, text: string): Promise<void> {
    const chat = this.find(id)
    if (!chat) throw new Error(`unknown chat ${id}`)
    if (this.running.has(id)) throw new Error('chat is busy')
    const root = this.ctx.project()?.root
    this.push(chat, userMessage('main', text))
    if (chat.title === 'New chat') chat.title = text.replace(/\s+/g, ' ').trim().slice(0, 48) || 'Chat'
    if (!root) {
      this.push(chat, systemMessage('main', 'Open a project first.'))
      return
    }

    const abort = new AbortController()
    this.running.set(id, abort)
    this.ctx.emit('chat:busy', { sessionId: id, busy: true })
    await this.deps.credentials.apply()
    void this.run(chat, text, root, abort).finally(() => {
      this.running.delete(id)
      this.ctx.emit('chat:busy', { sessionId: id, busy: false })
      this.save()
    })
  }

  stop(id: string): void {
    this.running.get(id)?.abort()
  }

  dispose(): void {
    for (const a of this.running.values()) a.abort()
    this.flush()
  }

  buildOptions(chat: StoredChat, root: string, abort: AbortController): Options {
    const allowBash = this.ctx.getSetting('allowBash', false)
    const mcpServers: Record<string, McpServerConfig> = {
      [SERVER_NAME]: (this.deps.makeServer ?? ((c) => createGentreeServer(c)))(this.ctx)
    }
    const allowedTools = [...allowServer(SERVER_NAME), 'Read', 'Glob', 'Grep']
    const studio = studioMcp(this.ctx)
    if (studio) {
      mcpServers[STUDIO_SERVER] = studio
      allowedTools.push(...allowServer(STUDIO_SERVER))
    }
    return {
      cwd: root,
      model: model(this.ctx),
      systemPrompt: SYSTEM_PROMPT,
      abortController: abort,
      mcpServers,
      // Only our servers, not the user's global MCP config, to keep the tool list (and tokens) small.
      strictMcpConfig: true,
      // Base built-in tool set; anything else is not even shown to the model.
      tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', ...(allowBash ? ['Bash'] : [])],
      allowedTools,
      // 'default' routes anything not pre-allowed to canUseTool, which enforces project bounds.
      permissionMode: 'default',
      canUseTool: chatPermissions(this.ctx),
      // Do not pick up user/project settings files whose permission rules could widen access.
      settingSources: [],
      ...(chat.sdkSessionId ? { resume: chat.sdkSessionId } : {})
    }
  }

  private async run(chat: StoredChat, text: string, root: string, abort: AbortController): Promise<void> {
    const queryFn = this.deps.queryFn ?? sdkQuery
    try {
      for await (const m of queryFn({ prompt: text, options: this.buildOptions(chat, root, abort) })) {
        if ('session_id' in m && m.session_id && chat.sdkSessionId !== m.session_id) chat.sdkSessionId = m.session_id
        for (const cm of toChatMessages(m, 'main')) this.push(chat, cm)
      }
    } catch (e) {
      if (abort.signal.aborted) this.push(chat, systemMessage('main', 'Stopped.'))
      else this.push(chat, systemMessage('main', `Error: ${(e as Error).message}`))
    }
  }

  private find(id: string): StoredChat | undefined {
    return this.chats.find((c) => c.id === id)
  }

  private push(chat: StoredChat, m: ChatMessage): void {
    chat.messages.push(m)
    if (chat.messages.length > MAX_MESSAGES) chat.messages.splice(0, chat.messages.length - MAX_MESSAGES)
    this.ctx.emit('chat:message', { ...m, sessionId: chat.id } as ChatMessage)
    this.save()
  }

  // Debounced persistence: settings writes hit disk.
  private save(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => this.flush(), 500)
    this.saveTimer.unref?.()
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.ctx.setSetting(SETTING, { sessions: this.chats })
  }
}
