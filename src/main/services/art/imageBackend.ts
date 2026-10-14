// The image backend choice shared by Art, Thumbnail Lab and VFX textures. No electron imports.
//
// 'api'   OpenAI Images API with the user's OpenAI key (openaiImages.ts): every option, billed per
//         image, the daily image budget and the app spending cap apply.
// 'codex' the ChatGPT plan through the user's Codex CLI (agent/codex/images.ts): plan limits, no
//         spend cap, no cost. Codex chooses the size (auto), makes at most 4 images per run, takes up
//         to 5 reference images and no masks.

import type { CodexImageInfo, ImageBackend } from '../../../shared/artTypes.ts'

export interface CodexImages {
  status(): Promise<CodexImageInfo>
  generate(req: { prompt: string; n: number; size?: string; transparent?: boolean; references?: (string | Uint8Array)[] }): Promise<{ images: Buffer[]; notes: string[] }>
}

export function backendOf(v: unknown): ImageBackend {
  return v === 'codex' ? 'codex' : 'api'
}

// The Codex backend when it is chosen and wired, else null (the API path runs).
export function codexBackend(backend: unknown, codex: CodexImages | undefined): CodexImages | null {
  return backendOf(backend) === 'codex' && codex ? codex : null
}
