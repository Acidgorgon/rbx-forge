// Generation size and ids for the Thumbnail Lab (pure).
//
// OpenAI Images API (developers.openai.com/api/reference/resources/images/methods/generate and
// .../edit, read 2026-10-14; platform.openai.com/docs/api-reference/images redirects there): the
// gpt-image-2 and gpt-image-2.5 families take any "WIDTHxHEIGHT" where "Width and height must both be
// divisible by 16 and the requested aspect ratio must be between 1:3 and 3:1"; "Resolutions above
// 2560x1440 are experimental, and the maximum supported resolution is 3840x2160". Other GPT image
// models only take 1024x1024, 1536x1024 and 1024x1536.
//
// 1920x1080 itself is not allowed (1080 is not a multiple of 16), so the gpt-image-2 families
// generate 1920x1088 (8 rows cropped) and the older models 1536x1024 (cover-cropped to 16:9, then
// resized to 1920x1080 with shared/thumbs/stats.ts toThumbnail).

export function genSizeFor(model: string): string {
  return /^gpt-image-2/.test(model) ? '1920x1088' : '1536x1024'
}

// Thumbnails share their batch id: "<batch>-<k>" (batch = "tb-<base36 time><4 hex>").
export const BATCH_RE = /^tb-[a-z0-9]{4,24}$/
export const THUMB_RE = /^tb-[a-z0-9]{4,24}-\d{1,3}$/

export function batchOf(id: string): string {
  return String(id ?? '').replace(/-\d{1,3}$/, '')
}

export function thumbId(batch: string, k: number): string {
  return `${batch}-${k}`
}
