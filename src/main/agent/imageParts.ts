// Image content per provider API (pure; the bytes come from chatImages.ts).
//
//   Anthropic (Agent SDK)   SDKUserMessage { message: { role: 'user', content: [ {type:'image',
//                           source:{type:'base64', media_type, data}}, ..., {type:'text', text} ] } }
//                           via the SDK's streaming input (prompt: AsyncIterable<SDKUserMessage>).
//   Chat Completions        content: [{type:'text', text}, {type:'image_url', image_url:{url:'data:...'}}]
//                           (OpenAI, OpenRouter, Gemini's OpenAI compatibility, Ollama: base64 only).
//   Responses               content: [{type:'input_text', text}, {type:'input_image', image_url:'data:...'}]
//
// Stored OpenAI-format history keeps images as image_url parts whose url is forge-image://<id>, so
// saved chats never carry base64; resolveHistoryImages swaps in data URLs right before a request.

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { MARKER_SCHEME } from './chatImages.ts'

export interface ImagePayload {
  mime: string
  base64: string
}

export type OaiTextPart = { type: 'text'; text: string }
export type OaiImagePart = { type: 'image_url'; image_url: { url: string; detail?: string } }
export type OaiUserPart = OaiTextPart | OaiImagePart

export type ImageResolver = (id: string) => Promise<ImagePayload | null>

export function dataUrl(p: ImagePayload): string {
  return `data:${p.mime};base64,${p.base64}`
}

// No empty text part when an image is sent on its own.
function textPart(text: string): OaiTextPart[] {
  return text.trim() ? [{ type: 'text', text }] : []
}

// User content for Chat Completions with image references (ids) kept for storage.
export function userContentWithRefs(text: string, ids: string[]): string | OaiUserPart[] {
  if (!ids.length) return text
  return [...textPart(text), ...ids.map((id): OaiImagePart => ({ type: 'image_url', image_url: { url: `${MARKER_SCHEME}${id}` } }))]
}

// Chat Completions user content with inline images.
export function chatCompletionsContent(text: string, images: ImagePayload[]): string | OaiUserPart[] {
  if (!images.length) return text
  return [...textPart(text), ...images.map((i): OaiImagePart => ({ type: 'image_url', image_url: { url: dataUrl(i) } }))]
}

// Responses API user content from Chat Completions content.
export function responsesContent(content: string | OaiUserPart[]): string | Record<string, unknown>[] {
  if (typeof content === 'string') return content
  return content.map((p) => (p.type === 'text' ? { type: 'input_text', text: p.text } : { type: 'input_image', image_url: p.image_url.url, detail: p.image_url.detail ?? 'auto' }))
}

// Anthropic Messages content blocks: images first, then the text (Anthropic's vision guide puts
// images before the question).
export function anthropicContent(text: string, images: ImagePayload[]): Record<string, unknown>[] {
  return [
    ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.base64 } })),
    // Empty text blocks are rejected by the Messages API.
    ...(text.trim() ? [{ type: 'text', text }] : [])
  ]
}

// The SDK's streaming-input prompt: one user message, then the iterable ends.
export function anthropicPrompt(text: string, images: ImagePayload[]): AsyncIterable<SDKUserMessage> {
  const message = { type: 'user', message: { role: 'user', content: anthropicContent(text, images) }, parent_tool_use_id: null } as unknown as SDKUserMessage
  return (async function* () {
    yield message
  })()
}

// Caches a resolver for one agent run (each turn re-sends the history).
export function memoResolver(resolve?: ImageResolver): ImageResolver | undefined {
  if (!resolve) return undefined
  const cache = new Map<string, Promise<ImagePayload | null>>()
  return (id) => {
    let p = cache.get(id)
    if (!p) cache.set(id, (p = resolve(id).catch(() => null)))
    return p
  }
}

// Replaces forge-image:// urls in history with data URLs. Images that are gone become a short text
// part, so the request stays valid.
export async function resolveHistoryImages<T extends { role: string; content?: unknown }>(history: T[], resolve?: ImageResolver): Promise<T[]> {
  if (!history.some((m) => m.role === 'user' && Array.isArray(m.content))) return history
  const out: T[] = []
  for (const m of history) {
    if (m.role !== 'user' || !Array.isArray(m.content)) {
      out.push(m)
      continue
    }
    const parts: OaiUserPart[] = []
    for (const p of m.content as OaiUserPart[]) {
      if (p.type === 'image_url' && p.image_url.url.startsWith(MARKER_SCHEME)) {
        const img = resolve ? await resolve(p.image_url.url.slice(MARKER_SCHEME.length)) : null
        parts.push(img ? { type: 'image_url', image_url: { ...p.image_url, url: dataUrl(img) } } : { type: 'text', text: '[image no longer available]' })
      } else parts.push(p)
    }
    out.push({ ...m, content: parts })
  }
  return out
}

// Plain text of a user content (for transcripts and summaries).
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const imgs = content.filter((p: any) => p?.type === 'image_url' || p?.type === 'input_image').length
  const text = content
    .filter((p: any) => p?.type === 'text' || p?.type === 'input_text')
    .map((p: any) => p.text)
    .join('\n')
  return imgs ? `${text}${text ? '\n' : ''}[${imgs} image${imgs > 1 ? 's' : ''}]` : text
}
