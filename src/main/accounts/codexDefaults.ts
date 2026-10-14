// After "Sign in with ChatGPT": when no OpenAI API key works (none saved, or it is rejected), the
// ChatGPT plan through Codex becomes the default wherever Forge would otherwise use OpenAI:
//   - the default chat model, when it is an OpenAI model or its provider is not usable at all;
//   - the image backend (Art, Thumbnail Lab, VFX textures), global setting 'art.settings'.backend.
// A working API key changes nothing, and a project's own image backend setting is left alone.

import type { ModelChoice, ProviderId } from '../../shared/types.ts'
import type { ImageBackend } from '../../shared/artTypes.ts'
import { CODEX_DEFAULT_MODEL } from '../agent/codex/args.ts'

export interface CodexDefaultsDeps {
  // true when an OpenAI API key is set and accepted; null when it could not be checked (offline).
  openAiKeyWorks(): Promise<boolean | null>
  defaultModel(): ModelChoice
  providerReady(p: ProviderId): Promise<boolean>
  setDefaultModel(choice: ModelChoice): void
  imageBackend(): ImageBackend | undefined
  setImageBackend(b: ImageBackend): void
}

export interface CodexDefaultsResult {
  chat: boolean
  images: boolean
  // One sentence for the card, or null when nothing changed.
  message: string | null
}

export async function applyCodexDefaults(d: CodexDefaultsDeps): Promise<CodexDefaultsResult> {
  const none = { chat: false, images: false, message: null }
  // Unknown (offline) counts as working: never switch someone's setup on a network hiccup.
  if ((await d.openAiKeyWorks()) !== false) return none
  const cur = d.defaultModel()
  let chat = false
  if (cur.provider !== 'codex' && (cur.provider === 'openai' || !(await d.providerReady(cur.provider)))) {
    d.setDefaultModel({ provider: 'codex', model: CODEX_DEFAULT_MODEL })
    chat = true
  }
  let images = false
  if (d.imageBackend() !== 'codex') {
    d.setImageBackend('codex')
    images = true
  }
  const what = chat && images ? 'chat and images' : chat ? 'chat' : images ? 'images' : ''
  return { chat, images, message: what ? `Codex (your ChatGPT plan) is now the default for ${what}, since no OpenAI API key works.` : null }
}
