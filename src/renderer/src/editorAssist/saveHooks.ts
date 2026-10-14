// Format on save without the store knowing Monaco: the editor registers a hook that may rewrite the
// buffer (StyLua) right before store.saveFile writes it.
import type { SaveReason } from '@shared/editorAssist/policy'

export type BeforeSave = (path: string, contents: string, reason: SaveReason) => Promise<string | null>

let hook: BeforeSave | null = null

export function setBeforeSave(fn: BeforeSave | null): void {
  hook = fn
}

// The text to save: the hook's result, or `contents` when there is no hook or it declines / fails.
export async function runBeforeSave(path: string, contents: string, reason: SaveReason): Promise<string> {
  if (!hook) return contents
  try {
    return (await hook(path, contents, reason)) ?? contents
  } catch {
    return contents
  }
}
