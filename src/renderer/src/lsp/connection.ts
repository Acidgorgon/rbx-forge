// Minimal JSON-RPC 2.0 endpoint over the harness LSP transport (lspSend / 'lsp:message').
// No Monaco or Electron imports, so it runs under node tests too.

export interface Transport {
  send(message: unknown): void
  // Subscribes to messages from the server; returns an unsubscribe function.
  listen(handler: (message: unknown) => void): () => void
}

export interface CancelToken {
  isCancellationRequested: boolean
  onCancellationRequested(listener: () => void): { dispose(): void }
}

type Id = number | string

interface Message {
  jsonrpc?: string
  id?: Id | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export class ResponseError extends Error {
  code: number
  data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

export const ErrorCodes = {
  MethodNotFound: -32601,
  InternalError: -32603,
  RequestCancelled: -32800,
  // Sent for requests still pending when the connection is reset (server restarted).
  ConnectionClosed: -32099
}

type RequestHandler = (params: any) => unknown | Promise<unknown>
type NotificationHandler = (params: any) => void

export class Connection {
  private transport: Transport
  private nextId = 1
  private pending = new Map<Id, { resolve: (value: any) => void; reject: (error: Error) => void; method: string }>()
  private requestHandlers = new Map<string, RequestHandler>()
  private notificationHandlers = new Map<string, NotificationHandler>()
  private fallbackRequest: ((method: string, params: unknown) => unknown) | null = null
  private unlisten: () => void

  constructor(transport: Transport) {
    this.transport = transport
    this.unlisten = transport.listen((message) => this.receive(message as Message))
  }

  request<T = any>(method: string, params?: unknown, token?: CancelToken): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      if (token?.isCancellationRequested) {
        reject(new ResponseError(ErrorCodes.RequestCancelled, 'cancelled'))
        return
      }
      this.pending.set(id, { resolve, reject, method })
      const sub = token?.onCancellationRequested(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        this.notify('$/cancelRequest', { id })
        reject(new ResponseError(ErrorCodes.RequestCancelled, 'cancelled'))
      })
      if (sub) {
        const done = () => sub.dispose()
        const entry = this.pending.get(id)!
        const { resolve: res, reject: rej } = entry
        entry.resolve = (value) => (done(), res(value))
        entry.reject = (error) => (done(), rej(error))
      }
      this.transport.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.transport.send({ jsonrpc: '2.0', method, params })
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler)
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler)
  }

  // Answers server requests that have no handler (default: MethodNotFound).
  onUnhandledRequest(handler: (method: string, params: unknown) => unknown): void {
    this.fallbackRequest = handler
  }

  // Rejects every pending request, e.g. when the server process went away.
  rejectPending(reason = 'connection reset'): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(new ResponseError(ErrorCodes.ConnectionClosed, reason))
  }

  dispose(): void {
    this.unlisten()
    this.rejectPending('connection disposed')
  }

  private receive(message: Message): void {
    if (!message || typeof message !== 'object') return
    const hasId = message.id !== undefined && message.id !== null
    if (message.method && hasId) {
      void this.answer(message.id as Id, message.method, message.params)
      return
    }
    if (message.method) {
      this.notificationHandlers.get(message.method)?.(message.params)
      return
    }
    if (hasId) {
      const entry = this.pending.get(message.id as Id)
      if (!entry) return
      this.pending.delete(message.id as Id)
      if (message.error) entry.reject(new ResponseError(message.error.code, message.error.message, message.error.data))
      else entry.resolve(message.result ?? null)
    }
  }

  private async answer(id: Id, method: string, params: unknown): Promise<void> {
    const handler = this.requestHandlers.get(method)
    try {
      let result: unknown
      if (handler) result = await handler(params)
      else if (this.fallbackRequest) result = await this.fallbackRequest(method, params)
      else throw new ResponseError(ErrorCodes.MethodNotFound, `Unhandled method ${method}`)
      this.transport.send({ jsonrpc: '2.0', id, result: result ?? null })
    } catch (error) {
      const code = error instanceof ResponseError ? error.code : ErrorCodes.InternalError
      const text = error instanceof Error ? error.message : String(error)
      this.transport.send({ jsonrpc: '2.0', id, error: { code, message: text } })
    }
  }
}
